//! Running a turn. Real agents (Claude Code, Codex, …) run through `codemax serve` in its
//! `mcp-only` policy: their own file and shell tools are refused, so the only way they can act
//! is Dune Bot's MCP tools, and every one of those passes the gate in app.rs.
//! The built-in "echo" agent costs nothing and drives the same tools, for testing the UI.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use anyhow::{anyhow, bail};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{mpsc, oneshot},
};

use crate::{app::App, mcp, store::Thread};

pub const ECHO: &str = "echo";

/// Where codemax lives: DUNEBOT_CODEMAX, next to this binary, then the usual install places.
/// A DUNEBOT_CODEMAX that names no file means "not installed" (snapshots use this).
pub fn codemax_bin() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("DUNEBOT_CODEMAX") {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    let exe = if cfg!(windows) { "codemax.exe" } else { "codemax" };
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(me) = std::env::current_exe() {
        if let Some(d) = me.parent() {
            dirs.push(d.to_path_buf());
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    if let Some(h) = dirs::home_dir() {
        for d in [".local/bin", ".bun/bin", ".npm-global/bin", "AppData/Roaming/npm"] {
            dirs.push(h.join(d));
        }
    }
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
    let names: &[&str] = if cfg!(windows) { &[exe, "codemax.cmd"] } else { &[exe] };
    dirs.iter().flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| p.is_file())
}

// ---------- codemax serve client ----------

struct Shared {
    ready: Mutex<Option<oneshot::Sender<()>>>,
    waiting: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    events: Mutex<Option<mpsc::UnboundedSender<Value>>>,
    alive: AtomicBool,
}

pub struct Codemax {
    shared: Arc<Shared>,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    next: AtomicU64,
    child: tokio::sync::Mutex<Option<Child>>,
}

impl Codemax {
    async fn spawn(bin: &Path) -> anyhow::Result<Self> {
        let mut cmd = if bin.extension().is_some_and(|e| e == "cmd") {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(bin);
            c
        } else {
            Command::new(bin)
        };
        cmd
            .arg("serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        // Its own process group, so closing it also ends the agent it started.
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd
            .spawn()
            .map_err(|e| anyhow!("couldn't start codemax ({}): {e}", bin.display()))?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
        let (ready_tx, ready_rx) = oneshot::channel();
        let shared = Arc::new(Shared {
            ready: Mutex::new(Some(ready_tx)),
            waiting: Mutex::new(HashMap::new()),
            events: Mutex::new(None),
            alive: AtomicBool::new(true),
        });
        let s = shared.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if v.get("event").and_then(Value::as_str) == Some("ready") {
                    if let Some(tx) = s.ready.lock().unwrap().take() {
                        let _ = tx.send(());
                    }
                } else if v.get("event").is_some() {
                    if let Some(tx) = s.events.lock().unwrap().as_ref() {
                        let _ = tx.send(v);
                    }
                } else if let Some(id) = v.get("id").and_then(Value::as_u64) {
                    if let Some(tx) = s.waiting.lock().unwrap().remove(&id) {
                        let r = match v.get("error") {
                            Some(e) => Err(e.as_str().map(String::from).unwrap_or_else(|| e.to_string())),
                            None => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = tx.send(r);
                    }
                }
            }
            s.alive.store(false, Ordering::SeqCst);
            s.ready.lock().unwrap().take();
            for (_, tx) in s.waiting.lock().unwrap().drain() {
                let _ = tx.send(Err("codemax stopped".into()));
            }
            if let Some(tx) = s.events.lock().unwrap().as_ref() {
                let _ = tx.send(json!({ "event": "exit" }));
            }
        });
        match tokio::time::timeout(Duration::from_secs(30), ready_rx).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => bail!(
                "{} has no `codemax serve` (it's too old). Run `codemax update`, or point DUNEBOT_CODEMAX at a newer build.",
                bin.display()
            ),
            Err(_) => bail!("codemax didn't start within 30 s"),
        }
        Ok(Self {
            shared,
            stdin: tokio::sync::Mutex::new(Some(stdin)),
            next: AtomicU64::new(1),
            child: tokio::sync::Mutex::new(Some(child)),
        })
    }

    fn alive(&self) -> bool {
        self.shared.alive.load(Ordering::SeqCst)
    }

    async fn write(&self, v: Value) -> Result<(), String> {
        let mut line = v.to_string();
        line.push('\n');
        let mut guard = self.stdin.lock().await;
        let w = guard.as_mut().ok_or_else(|| "codemax closed".to_string())?;
        w.write_all(line.as_bytes()).await.map_err(|e| format!("codemax closed: {e}"))?;
        w.flush().await.map_err(|e| format!("codemax closed: {e}"))
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.shared.waiting.lock().unwrap().insert(id, tx);
        self.write(json!({ "id": id, "method": method, "params": params })).await?;
        rx.await.map_err(|_| "codemax stopped".to_string())?
    }

    async fn notify(&self, method: &str) {
        let _ = self.write(json!({ "method": method })).await;
    }

    fn set_events(&self, tx: Option<mpsc::UnboundedSender<Value>>) {
        *self.shared.events.lock().unwrap() = tx;
    }

    /// Ends codemax and the agent it started: closes its input (it exits on EOF), waits a moment,
    /// then kills its whole process group.
    pub async fn close(&self) {
        self.stdin.lock().await.take();
        let Some(mut child) = self.child.lock().await.take() else { return };
        let pid = child.id();
        let exited = tokio::time::timeout(Duration::from_secs(3), child.wait()).await.is_ok();
        #[cfg(unix)]
        if let Some(pid) = pid {
            // Agents it started may outlive it; the group goes either way.
            unsafe {
                libc::killpg(pid as i32, libc::SIGKILL);
            }
        }
        if !exited {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        #[cfg(not(unix))]
        let _ = pid;
    }
}

/// Drops a chat's agent process (used on delete and when idle).
pub async fn close_session(app: &Arc<App>, thread_id: &str) {
    let s = app.sessions.lock().await.remove(thread_id);
    app.last_used.lock().unwrap().remove(thread_id);
    if let Some(s) = s {
        s.close().await;
    }
}

fn instructions(app: &App, thread: &Thread) -> String {
    format!(
        "You are Dune Bot, an assistant that works on the user's own computer ({os}). \
         The \"dunebot\" tools act directly on this computer: run_command, read_file, write_file and list_folder. \
         Use them to do what the user asks. To look at files and folders (what's in a folder, how many files, how big, \
         the largest ones) use list_folder (deep: true counts the subfolders too) and read_file: they never ask the user. \
         Use run_command only when those can't do it. search_chats finds the user's earlier Dune Bot chats: use it when they \
         refer to something that isn't in this chat.{click} Some actions ask the user first; if one is declined, don't retry it, \
         say what you'd need instead. When a request needs these tools, first write one short line saying what you're \
         doing, ending with a full stop (\"Sure, checking the weather where you are.\"): it's shown and read aloud at once, \
         so the user isn't left waiting while you work. Then do the work and answer, without repeating that line. When you \
         can answer straight away, just answer. This chat's working folder is {cwd}. Keep replies short and plain.{team}",
        os = std::env::consts::OS,
        // A bot's role, what it may not do, and its teammates (team.rs).
        team = crate::team::instructions(app, thread),
        cwd = thread.cwd,
        click = if cfg!(any(target_os = "macos", target_os = "windows", target_os = "linux")) {
            " To use the screen for the user, take a picture with look_at_screen, then click, scroll or drag at points in \
             it (each picture is good for one of those: look again before the next), and type with type_text or press keys \
             and shortcuts with press_keys. The app the user is in already has the keyboard: when they say to type \"here\" \
             or in what they're looking at, type straight away; click first only to put the text somewhere else. None of \
             them ask the user. When the user says to click something, click it: never a shortcut in its place. Aim \
             at the middle of the target, clear of icons or buttons in or beside it. A click's answer says what was \
             under the pointer: if that isn't what you meant, it missed, so look again and click again. Never \
             do these through run_command (osascript, cliclick, xdotool, PowerShell): that asks the user every time. \
             When the user wants to learn how to do something (\"show me how to…\", \"how do I … here?\", \"teach me\", \
             \"where's the …\"), guide them instead of doing it: look_at_screen, then point_at the one control they \
             should use next (its middle and size in that picture's pixels, and a label of a few words), and say that \
             one step in one short sentence (\"Click Share, at the top right.\"). Then stop and let them do it. When \
             they say done or next, or ask again, look again and point at the next step; if the screen isn't what you \
             expected, point again and say what to look for. While teaching, never click, type or press keys for \
             them unless they ask you to. Call clear_pointer when the lesson is over or they move on to something \
             else. If point_at isn't available, say where the control is in words."
        } else {
            ""
        }
    )
}

async fn session(app: &Arc<App>, thread: &Thread) -> anyhow::Result<Arc<Codemax>> {
    let mut sessions = app.sessions.lock().await;
    if let Some(s) = sessions.get(&thread.id) {
        if s.alive() {
            return Ok(s.clone());
        }
    }
    let bin = codemax_bin().ok_or_else(|| match std::env::var_os("DUNEBOT_CODEMAX") {
        Some(p) => anyhow!("DUNEBOT_CODEMAX points at {}, which isn't a file.", PathBuf::from(p).display()),
        None => anyhow!("codemax isn't installed. Install it with `bun add -g codemax-cli`, or set DUNEBOT_CODEMAX."),
    })?;
    let cm = Codemax::spawn(&bin).await?;
    let resume = app.db(|d| d.get_setting(&format!("session.{}", thread.id)))?.filter(|s| !s.is_empty());
    // A bot runs on its engine (team.rs).
    let engine = crate::team::engine(app, &thread.agent).map_err(|e| anyhow!(e))?;
    let params = json!({
        "agent": engine,
        "cwd": thread.cwd,
        "mcp": [{
            "name": "dunebot",
            "transport": {
                "type": "http",
                "url": app.mcp_url(&thread.id),
                "headers": { "Authorization": format!("Bearer {}", app.token(&thread.id)) }
            }
        }],
        "policy": "mcp-only",
        "handoff": false,
        "instructions": instructions(app, thread),
        "resume": resume,
    });
    let mut params = params;
    let mut r = tokio::time::timeout(Duration::from_secs(120), cm.request("configure", params.clone()))
        .await
        .map_err(|_| anyhow!("the agent took too long to start"))?;
    if r.is_err() && !params["resume"].is_null() {
        // The saved session may be gone; start a fresh one rather than leave the chat stuck.
        let _ = app.db(|d| d.set_setting(&format!("session.{}", thread.id), ""));
        params["resume"] = Value::Null;
        r = tokio::time::timeout(Duration::from_secs(120), cm.request("configure", params))
            .await
            .map_err(|_| anyhow!("the agent took too long to start"))?;
    }
    let started = r.map_err(|e| anyhow!("{e}"))?;
    // codemax names the session while configuring, before a turn listens for events.
    if let Some(id) = started.get("session").and_then(Value::as_str) {
        let _ = app.db(|d| d.set_setting(&format!("session.{}", thread.id), id));
    }
    let cm = Arc::new(cm);
    sessions.insert(thread.id.clone(), cm.clone());
    Ok(cm)
}

/// Each chat keeps its agent process for quick follow-ups; ones idle this long are closed
/// (the next message resumes the saved session).
fn idle_close() -> Duration {
    let secs = std::env::var("DUNEBOT_IDLE_CLOSE_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(10 * 60);
    Duration::from_secs(secs)
}

pub fn spawn_reaper(app: Arc<App>) {
    let idle_for = idle_close();
    let tick = idle_for.min(Duration::from_secs(60)).max(Duration::from_secs(1));
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tick).await;
            let idle: Vec<String> = {
                let busy = app.busy.lock().unwrap();
                let used = app.last_used.lock().unwrap();
                used.iter()
                    .filter(|(id, t)| !busy.contains(*id) && t.elapsed() > idle_for)
                    .map(|(id, _)| id.clone())
                    .collect()
            };
            for id in idle {
                close_session(&app, &id).await;
            }
        }
    });
}

pub async fn list_agents() -> Value {
    let echo = json!({ "id": ECHO, "name": "Echo (test, no AI)", "installed": true });
    let Some(bin) = codemax_bin() else {
        return json!({ "agents": [echo], "problem": "codemax isn't installed" });
    };
    let r = async {
        let cm = Codemax::spawn(&bin).await.map_err(|e| e.to_string())?;
        tokio::time::timeout(Duration::from_secs(30), cm.request("agents", json!({})))
            .await
            .map_err(|_| "codemax took too long".to_string())?
    }
    .await;
    match r {
        Ok(Value::Array(mut list)) => {
            list.push(echo);
            json!({ "agents": list })
        }
        Ok(other) => json!({ "agents": [echo], "problem": format!("unexpected answer: {other}") }),
        Err(e) => json!({ "agents": [echo], "problem": e }),
    }
}

// ---------- a turn ----------

/// Streams the reply into assistant messages. Text after a tool card starts a new bubble, so
/// the chat reads in the order things happened.
struct Turn {
    app: Arc<App>,
    thread_id: String,
    current: Option<String>,
    text: String,
    all: String,
}

impl Turn {
    fn delta(&mut self, s: &str) {
        if s.is_empty() {
            return;
        }
        let last = self.app.last_message(&self.thread_id);
        if self.current.is_none() || self.current != last {
            self.close();
            if !self.all.is_empty() {
                self.all.push_str("\n\n");
            }
            if let Ok(m) = self.app.add_message(&self.thread_id, "assistant", "", json!({ "status": "streaming" })) {
                self.current = Some(m.id);
            }
        }
        self.text.push_str(s);
        self.all.push_str(s);
        if let Some(id) = &self.current {
            // Saved as it streams, so a reopened or restarted chat shows what arrived.
            let _ = self.app.db(|d| d.set_message(id, &self.text, &json!({ "status": "streaming" })));
            self.app.out.event("message.delta", json!({ "threadId": self.thread_id, "messageId": id, "delta": s }));
        }
    }

    fn close(&mut self) {
        if let Some(id) = self.current.take() {
            self.app.update_message(id.as_str(), &self.text, json!({ "status": "done" }));
        }
        self.text.clear();
    }

    fn finish(mut self, status: &str, error: Option<String>) {
        if let Some(e) = &error {
            if self.all.trim().is_empty() {
                self.delta(e);
            }
        }
        let id = self.current.take();
        if let Some(id) = id {
            self.app.update_message(id.as_str(), &self.text, json!({ "status": status, "error": error }));
        }
        let last = if self.text.trim().is_empty() { self.all.as_str() } else { self.text.as_str() };
        let preview: String = last.replace('`', "").split_whitespace().collect::<Vec<_>>().join(" ").chars().take(90).collect();
        if !preview.is_empty() {
            let _ = self.app.db(|d| d.update_thread(&self.thread_id, None, Some(&preview)));
        }
        self.app.thread_changed(&self.thread_id);
    }
}

/// `origin`: who started this turn; only the user's own words may ask for their accounts (asked.rs).
pub async fn send(app: Arc<App>, thread_id: &str, text: &str, spoken: bool, origin: crate::asked::Origin) -> anyhow::Result<Value> {
    let text = text.trim();
    if text.is_empty() {
        bail!("empty message");
    }
    let thread = app.db(|d| d.get_thread(thread_id))?;
    // A bot's chat runs on the bot's engine; a deleted bot's chat takes no more messages.
    let engine = crate::team::engine(&app, &thread.agent).map_err(|e| anyhow!(e))?;
    if !app.busy.lock().unwrap().insert(thread.id.clone()) {
        bail!("this chat is still working on the last message");
    }
    app.cancelled.lock().unwrap().remove(&thread.id);
    crate::asked::begin(&thread.id, origin, text);
    // A Hindi or Hinglish question: its answer is read aloud in Hinglish (speak_stream.rs).
    app.sarvam.set_question(text);
    let msg = app.add_message(&thread.id, "user", text, json!({}))?;
    let title = (thread.title == "New chat").then(|| {
        let t: String = text.lines().next().unwrap_or(text).chars().take(48).collect();
        t
    });
    let _ = app.db(|d| d.update_thread(&thread.id, title.as_deref(), Some(text)));
    app.thread_changed(&thread.id);
    crate::history::save(&app, &thread.id);
    app.out.event("turn.started", json!({ "threadId": thread.id }));

    let text = text.to_string();
    let app2 = app.clone();
    tokio::spawn(async move {
        let mut turn = Turn { app: app2.clone(), thread_id: thread.id.clone(), current: None, text: String::new(), all: String::new() };
        // A crash inside the turn must still end it: otherwise the chat stays "still working" for
        // good and refuses every later message. The crash itself is printed by Rust ("panicked at").
        let ran = std::panic::AssertUnwindSafe(async {
            if engine == ECHO {
                echo_turn(&app2, &thread, &text, &mut turn).await
            } else {
                codemax_turn(&app2, &thread, &text, spoken, &mut turn).await
            }
        });
        let (status, error) = match futures_util::FutureExt::catch_unwind(ran).await {
            Ok(r) => r,
            Err(_) => {
                eprintln!("dunebot-core: a turn crashed; ended it with an error");
                ("error", Some("Dune Bot hit an internal error on this message. Try again.".to_string()))
            }
        };
        // After a crash a lock may be poisoned; the chat must still be freed.
        let cancelled = app2.cancelled.lock().unwrap_or_else(|e| e.into_inner()).remove(&thread.id);
        let status = if cancelled { "cancelled" } else { status };
        turn.finish(status, error.clone());
        crate::history::save(&app2, &thread.id);
        app2.busy.lock().unwrap_or_else(|e| e.into_inner()).remove(&thread.id);
        app2.last_used.lock().unwrap_or_else(|e| e.into_inner()).insert(thread.id.clone(), std::time::Instant::now());
        app2.out.event("turn.ended", json!({ "threadId": thread.id, "status": status, "error": error }));
    });
    Ok(json!({ "message": msg }))
}

pub async fn cancel(app: &Arc<App>, thread_id: &str) -> anyhow::Result<()> {
    if !app.busy.lock().unwrap().contains(thread_id) {
        return Ok(());
    }
    app.cancelled.lock().unwrap().insert(thread_id.to_string());
    app.deny_pending(thread_id);
    app.stop_signal(thread_id).notify_waiters();
    let s = app.sessions.lock().await.get(thread_id).cloned();
    if let Some(s) = s {
        s.notify("cancel").await;
    }
    Ok(())
}

async fn codemax_turn(app: &Arc<App>, thread: &Thread, text: &str, spoken: bool, turn: &mut Turn) -> (&'static str, Option<String>) {
    let cm = match session(app, thread).await {
        Ok(cm) => cm,
        Err(e) => return ("error", Some(format!("{e:#}"))),
    };
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    cm.set_events(Some(tx));
    let mut error: Option<String> = None;
    let handle = |ev: Value, turn: &mut Turn, error: &mut Option<String>| {
        match ev.get("event").and_then(Value::as_str).unwrap_or("") {
            "text_delta" => turn.delta(ev.get("text").and_then(Value::as_str).unwrap_or("")),
            "error" => *error = ev.get("message").and_then(Value::as_str).map(String::from),
            "session" => {
                if let Some(id) = ev.pointer("/ref/id").and_then(Value::as_str) {
                    let _ = app.db(|d| d.set_setting(&format!("session.{}", thread.id), id));
                }
            }
            "exit" => *error = Some("the agent stopped unexpectedly".into()),
            "permission_auto" if ev.get("decision").and_then(Value::as_str) == Some("reject") => {
                eprintln!("dunebot-core: codemax refused {} ({})", ev["title"], ev["kind"]);
            }
            _ => {}
        }
    };
    // A new chat's first message carries a short record of recent chats, so the agent remembers
    // what you asked a moment ago in another chat. The chat itself shows only what you typed.
    let first = app.db(|d| d.messages(&thread.id)).is_ok_and(|m| m.iter().filter(|m| m.role == "user").count() == 1);
    let mut prompt = match first.then(|| crate::history::memory(app, thread)).flatten() {
        Some(mem) => {
            eprintln!("dunebot-core: new chat starts with {} characters of recent chats", mem.len());
            format!("{mem}{text}")
        }
        None => text.to_string(),
    };
    // Asked from the bar: the answer is read aloud and shown beside the pointer (not stored in the chat).
    if spoken {
        prompt = format!("{SPOKEN_NOTE}{prompt}");
    }
    // Asked in Hindi or Hinglish: the answer is written in English (Dune Bot speaks it in Hinglish).
    if app.sarvam.language_for(text) == "hi-IN" {
        prompt = format!("{ENGLISH_NOTE}{prompt}");
    }
    // The user's fixes for earlier mistakes, each given to a chat once (notes only; see fixes.rs).
    if let Some(fixes) = crate::fixes::for_turn(app, &thread.id) {
        prompt = format!("{fixes}{prompt}");
    }
    let req = cm.request("prompt", json!({ "text": prompt }));
    tokio::pin!(req);
    let result = loop {
        tokio::select! {
            Some(ev) = rx.recv() => handle(ev, turn, &mut error),
            r = &mut req => break r,
        }
    };
    while let Ok(ev) = rx.try_recv() {
        handle(ev, turn, &mut error);
    }
    cm.set_events(None);
    match result {
        Err(e) => ("error", Some(e)),
        Ok(r) => {
            if let Some(e) = r.get("error").and_then(Value::as_str) {
                error = Some(e.to_string());
            }
            match r.get("stopReason").and_then(Value::as_str) {
                Some("cancelled") => ("cancelled", None),
                Some("end_turn") | Some("max_tokens") | Some("max_turn_requests") if error.is_none() || !turn.all.is_empty() => ("done", None),
                _ if error.is_some() => ("error", error),
                _ => ("done", None),
            }
        }
    }
}

async fn say(turn: &mut Turn, text: &str) {
    for (i, word) in text.split_inclusive(' ').enumerate() {
        turn.delta(word);
        if i % 3 == 2 {
            tokio::time::sleep(Duration::from_millis(18)).await;
        }
    }
}

/// What `stream` sends: the parts a reply usually has.
const STREAM_SAMPLE: &str = "## Tides, briefly\n\nTides are the slow rise and fall of the sea, pulled mostly by the **Moon** and a little by the Sun.\n\n- Two high tides a day, about 12 hours 25 minutes apart\n- Spring tides at full and new moon, when the pulls line up\n- Neap tides in between, when they pull at right angles\n\nTo see the times for a harbour, run:\n\n```sh\ncurl -s https://example.com/tides?harbour=dover\n```\n\nThe range also depends on the coast: a narrow bay can funnel the water, so the same Moon gives a 1 m tide in one place and 15 m in another. That is why charts list each port separately, and why sailors check the `local` table rather than a global one.\n\nOne last thing: the Moon is slowly moving away, about 3.8 cm a year, so tides are very gradually getting weaker.";

/// What `markdown` sends: the Markdown replies use (headings, a list, code, a table, a quote, a
/// link) and a picture, which is never loaded (ui/src/reply.tsx).
const MARKDOWN_SAMPLE: &str = "## Plan\n\nThis **deletes** `~/old-builds`, so back it up first.\n\n1. Install: run `bun install` in `apps/web`.\n2. Check: press ⌘R to reload.\n\n```sh\nbun install && bun test\n```\n\n| Tests | Result |\n|---|---|\n| unit | passing |\n| e2e | 2 warnings |\n\n> A quote, and [a link](https://example.com).\n\nNot a picture: ![chart](http://127.0.0.1:9/chart.png)";

/// Every message asked from the bar: its answer is read aloud and shown as a small caption beside the
/// pointer (ui/src/Caption.tsx), so it should be short and plain.
pub const SPOKEN_NOTE: &str = "<dunebot-voice>Asked from Dune Bot's bar: your answer is read aloud and shown as a small caption beside the user's pointer. Answer in one or two short, plain sentences unless they ask for more (a short first line saying what you're doing, before you use tools, doesn't count). No headings, tables or code blocks unless they ask; when more is needed, make the first sentence a complete answer on its own.</dunebot-voice>\n\n";

/// A question in Hindi or Hinglish (the user's choice, 2026-11-17): the answer is written in English;
/// when it's read aloud, Dune Bot says it in Hinglish itself.
pub const ENGLISH_NOTE: &str = "<dunebot-language>The user asked in Hindi or Hinglish. Write your whole answer in English (their choice): Dune Bot shows your English answer and, when it reads it aloud, says it in Hinglish itself. Don't write Hindi or Hinglish yourself.</dunebot-language>\n\n";

/// The test agent: `run <command>`, `ls <folder>`, `read <file>`, `write <file>` + newline + content,
/// `look`, `where`, `click <x> <y> [what]` (a point in the latest picture), `scroll <x> <y> <direction>`,
/// `drag <x1> <y1> <x2> <y2>`, `type <text>`, `keys <shortcut> [times]`, `search [words]`, `pause <words>`,
/// `point <x> <y> [<width> <height>] <label>` and `unpoint` (tools/teach.rs).
/// `ask <bot> <task>` (hands the task to one of the user's bots) and `team` (what a real agent is told
/// about its role and teammates).
async fn echo_turn(app: &Arc<App>, thread: &Thread, text: &str, turn: &mut Turn) -> (&'static str, Option<String>) {
    let (head, rest) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
    let rest = rest.trim();
    let call = match head.to_lowercase().as_str() {
        "run" if !rest.is_empty() => Some(("run_command", json!({ "command": rest }))),
        "ls" | "list" => Some(("list_folder", json!({ "path": if rest.is_empty() { "." } else { rest } }))),
        "read" if !rest.is_empty() => Some(("read_file", json!({ "path": rest }))),
        "look" => Some(("look_at_screen", json!({}))),
        "where" => Some(("find_location", json!({}))),
        "click" => {
            let mut w = rest.splitn(3, char::is_whitespace);
            let n = |v: Option<&str>| v.and_then(|v| v.parse::<f64>().ok());
            match (n(w.next()), n(w.next())) {
                (Some(x), Some(y)) => Some(("click", json!({ "x": x, "y": y, "what": w.next().unwrap_or("a point").trim() }))),
                _ => None,
            }
        }
        "scroll" => {
            let w: Vec<&str> = rest.split_whitespace().collect();
            let n = |i: usize| w.get(i).and_then(|v| v.parse::<f64>().ok());
            match (n(0), n(1), w.get(2)) {
                (Some(x), Some(y), Some(d)) => Some(("scroll", json!({ "x": x, "y": y, "direction": d, "what": "the page" }))),
                _ => None,
            }
        }
        "drag" => {
            let n: Vec<f64> = rest.split_whitespace().filter_map(|v| v.parse().ok()).collect();
            (n.len() == 4).then(|| ("drag", json!({ "from_x": n[0], "from_y": n[1], "to_x": n[2], "to_y": n[3], "what": "a test drag" })))
        }
        "type" if !rest.is_empty() => Some(("type_text", json!({ "text": rest.replace("\\n", "\n"), "what": "the field" }))),
        "keys" if !rest.is_empty() => {
            let mut w = rest.split_whitespace();
            let keys = w.next().unwrap_or("");
            let times = w.next().and_then(|t| t.parse::<u64>().ok()).unwrap_or(1);
            Some(("press_keys", json!({ "keys": keys, "times": times, "what": "a test" })))
        }
        "search" => Some(("search_chats", if rest.is_empty() { json!({}) } else { json!({ "query": rest }) })),
        "point" => {
            let w: Vec<&str> = rest.split_whitespace().collect();
            let n: Vec<f64> = w.iter().take(4).map_while(|v| v.parse().ok()).collect();
            let label = |from: usize| w.get(from..).unwrap_or_default().join(" ");
            match n.len() {
                4 => Some(("point_at", json!({ "x": n[0], "y": n[1], "width": n[2], "height": n[3], "label": label(4) }))),
                2 | 3 => Some(("point_at", json!({ "x": n[0], "y": n[1], "label": label(2) }))),
                _ => None,
            }
        }
        "unpoint" => Some(("clear_pointer", json!({}))),
        "ask" => crate::team::echo_ask(rest).map(|args| ("ask_bot", args)),
        "team" => {
            say(turn, &format!("```\n{}\n```", crate::team::instructions(app, thread).trim())).await;
            return ("done", None);
        }
        "stream" | "markdown" => {
            // A long reply in the rhythm a real agent streams (measured from Claude Code through
            // codemax): a burst of pieces at once, a few 50 ms apart, then a short pause.
            let sample = if head.eq_ignore_ascii_case("markdown") { MARKDOWN_SAMPLE } else { STREAM_SAMPLE };
            let pieces: Vec<String> = sample.chars().collect::<Vec<_>>().chunks(16).map(|c| c.iter().collect()).collect();
            for (i, p) in pieces.iter().enumerate() {
                turn.delta(p);
                match i % 12 {
                    0..=5 => {}
                    11 => tokio::time::sleep(Duration::from_millis(160)).await,
                    _ => tokio::time::sleep(Duration::from_millis(50)).await,
                }
            }
            return ("done", None);
        }
        "pause" => {
            // A real agent thinks a moment before its first words: the card beside the pointer opens
            // before them (scripts/snap/caption-voice-ask.js).
            tokio::time::sleep(Duration::from_millis(1000)).await;
            say(turn, &format!("Echo: {rest}")).await;
            return ("done", None);
        }
        "crash" => {
            // A turn that crashes part way (scripts/core_smoke.py: it must still end, and the chat work after).
            say(turn, "About to crash.").await;
            panic!("the test agent crashed on purpose");
        }
        "fixes" => {
            // What a real agent would be given with this message.
            let notes = crate::fixes::for_turn(app, &thread.id).unwrap_or_else(|| "No new fixes.".into());
            say(turn, &format!("```\n{}\n```", notes.trim())).await;
            return ("done", None);
        }
        "write" if !rest.is_empty() => {
            let (path, content) = rest.split_once('\n').unwrap_or((rest, ""));
            Some(("write_file", json!({ "path": path.trim(), "content": content })))
        }
        _ => None,
    };
    let Some((tool, args)) = call else {
        say(turn, &format!(
            "Echo: {text}\n\nI'm the test agent, no AI. Try `run echo hi`, `ls ~`, `read <file>`, `search <words>`, `look`, or `write <file>` then a new line and the content."
        ))
        .await;
        return ("done", None);
    };
    say(turn, "On it.").await;
    let (out, is_error, _) = mcp::run_tool(app, thread, tool, &args).await;
    if app.cancelled.lock().unwrap().contains(&thread.id) {
        return ("cancelled", None);
    }
    let shown: String = out.chars().take(1500).collect();
    if is_error {
        say(turn, &format!("That didn't work: {shown}")).await;
    } else {
        say(turn, &format!("Done.\n\n```\n{shown}\n```")).await;
    }
    ("done", None)
}
