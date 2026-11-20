//! Shared state and the one gate every agent action passes through.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use anyhow::{anyhow, bail};
use serde_json::{json, Value};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::{
    agent::Codemax,
    policy::{self, Action, Mode},
    protocol::Out,
    store::{now_ms, Message, Store, Thread},
};

/// How long an approval card waits before the action is dropped.
const APPROVAL_WAIT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Once,
    Chat,
    Deny,
}

struct Pending {
    tx: oneshot::Sender<Decision>,
    thread_id: String,
    shown: std::time::Instant,
}

/// An "allow" that arrives sooner than this after the card appeared is refused (the card stays
/// open): a keystroke or click meant for another app must not approve a command nobody read.
fn min_read_time() -> Duration {
    let ms = std::env::var("DUNEBOT_APPROVAL_MIN_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(500);
    Duration::from_millis(ms)
}

/// `setup.done`: the first-run setup (permissions, speech model) was finished.
/// `setup.folders`: what macOS answered for Desktop/Documents/Downloads ("Desktop:granted,…").
/// `bar.place`: where the bar opens when you ask for it ("bottom", "top", "pointer").
/// `voice.speak`: "0" stops answers from being read aloud (the answer card's speaker button).
/// `voice.engine`: "local" listens and reads aloud on this computer even when a Sarvam key is saved.
/// `keys.chord`: the keys that tap/hold on macOS ("opt-cmd" ⌥⌘ by default, "ctrl-opt", "ctrl-cmd", "right-cmd").
/// `dictation`: "off" stops Right ⌥ held alone from typing what you say (macOS; unset is on).
pub const PREFS: [&str; 9] = ["agent", "bar.thread", "setup.done", "setup.folders", "bar.place", "voice.speak", "voice.engine", "keys.chord", crate::dictation::PREF];

pub struct App {
    pub out: Out,
    store: Mutex<Store>,
    pub data_dir: PathBuf,
    mcp_port: OnceLock<u16>,
    tokens: Mutex<HashMap<String, String>>,
    pending: Mutex<HashMap<String, Pending>>,
    grants: Mutex<HashSet<(String, Action)>>,
    last_msg: Mutex<HashMap<String, String>>,
    stops: Mutex<HashMap<String, Arc<tokio::sync::Notify>>>,
    pub last_used: Mutex<HashMap<String, std::time::Instant>>,
    pub busy: Mutex<HashSet<String>>,
    pub voice: crate::voice::Voice,
    /// The Sarvam key, in memory only (sarvam.rs).
    pub sarvam: crate::sarvam::Sarvam,
    pub deepgram: crate::deepgram::Deepgram,
    /// The user's phone, through their Telegram bot (telegram.rs).
    pub phone: crate::telegram::Phone,
    pub cancelled: Mutex<HashSet<String>>,
    pub sessions: tokio::sync::Mutex<HashMap<String, Arc<Codemax>>>,
    /// The newest fix each chat's agent has been given, so a fix made mid-chat reaches it once.
    pub fixes_sent: Mutex<HashMap<String, i64>>,
    /// Pictures of the screen asked of the app (Electron takes them), by request id.
    captures: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    locations: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    /// Clicks asked of the app (it holds macOS's Accessibility permission), by request id.
    inputs: Mutex<HashMap<String, oneshot::Sender<Result<String, String>>>>,
    /// Each chat's latest picture of the screen: where it lies on the screen, so a click can be given
    /// as a point in it.
    pub shots: Mutex<HashMap<String, crate::tools::Shot>>,
    /// The user's connected accounts (connectors/).
    pub connectors: crate::connectors::Connectors,
}

pub fn new_id() -> String {
    Uuid::new_v4().simple().to_string()
}

fn new_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

/// Constant-time comparison for bearer tokens.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl App {
    pub fn new(out: Out, store: Store, data_dir: PathBuf) -> Self {
        Self {
            out,
            store: Mutex::new(store),
            data_dir,
            mcp_port: OnceLock::new(),
            tokens: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            grants: Mutex::new(HashSet::new()),
            last_msg: Mutex::new(HashMap::new()),
            stops: Mutex::new(HashMap::new()),
            last_used: Mutex::new(HashMap::new()),
            voice: Default::default(),
            sarvam: Default::default(),
            deepgram: Default::default(),
            phone: Default::default(),
            busy: Mutex::new(HashSet::new()),
            cancelled: Mutex::new(HashSet::new()),
            sessions: tokio::sync::Mutex::new(HashMap::new()),
            fixes_sent: Mutex::new(HashMap::new()),
            captures: Mutex::new(HashMap::new()),
            locations: Mutex::new(HashMap::new()),
            inputs: Mutex::new(HashMap::new()),
            shots: Mutex::new(HashMap::new()),
            connectors: Default::default(),
        }
    }

    /// Asks the app for a picture of the screen under the pointer. The core can't take one itself:
    /// the app holds the Screen Recording permission. The picture is never stored or logged.
    pub async fn capture_screen(&self) -> Result<Value, String> {
        let id = new_id();
        let (tx, rx) = oneshot::channel();
        self.captures.lock().unwrap().insert(id.clone(), tx);
        self.out.event("screen.capture", json!({ "requestId": id }));
        let answer = tokio::time::timeout(std::time::Duration::from_secs(15), rx).await;
        self.captures.lock().unwrap().remove(&id);
        match answer {
            Ok(Ok(r)) => r,
            _ => Err("Dune Bot couldn't take a picture of the screen: the app didn't answer.".into()),
        }
    }

    /// Asks the app where the computer is (the app holds the system's location permission). Nothing
    /// here logs the place. The app waits for macOS's own "allow?" box itself (up to 30 s), so this
    /// waits longer.
    pub async fn find_location(&self) -> Option<Value> {
        let id = new_id();
        let (tx, rx) = oneshot::channel();
        self.locations.lock().unwrap().insert(id.clone(), tx);
        self.out.event("location.request", json!({ "requestId": id }));
        let answer = tokio::time::timeout(std::time::Duration::from_secs(60), rx).await;
        self.locations.lock().unwrap().remove(&id);
        answer.ok().and_then(Result::ok)
    }

    /// The app's answer to `location.request`. Single use; an unknown id is refused.
    pub fn location_result(&self, p: &Value) -> anyhow::Result<Value> {
        let id = p.get("requestId").and_then(Value::as_str).unwrap_or("");
        let tx = self.locations.lock().unwrap().remove(id).ok_or_else(|| anyhow!("no such location request"))?;
        let _ = tx.send(p.clone());
        Ok(json!({ "ok": true }))
    }

    /// Asks the app to use the mouse or keyboard for an agent (`req` has `kind`: click, scroll,
    /// drag, type or keys; points are in the app's screen points). Waits up to `secs`.
    /// Asks the app to use the mouse or keyboard; answers its note (what a click landed on), or "".
    pub async fn input(&self, mut req: Value, secs: u64) -> Result<String, String> {
        /// However the wait ends (answered, timed out, or the turn stopped and dropped it), the chord
        /// comes back; unless answered, the app is told to stop (it checks before every key).
        struct Pending<'a> {
            app: &'a App,
            id: String,
            answered: bool,
        }
        impl Drop for Pending<'_> {
            fn drop(&mut self) {
                crate::keys::input_ended();
                self.app.inputs.lock().unwrap().remove(&self.id);
                if !self.answered {
                    self.app.out.event("input.cancel", json!({ "requestId": self.id }));
                }
            }
        }
        let id = new_id();
        let (tx, rx) = oneshot::channel();
        self.inputs.lock().unwrap().insert(id.clone(), tx);
        req["requestId"] = json!(id);
        crate::keys::input_started();
        let mut pending = Pending { app: self, id, answered: false };
        self.out.event("input.do", req);
        let answer = tokio::time::timeout(std::time::Duration::from_secs(secs), rx).await;
        match answer {
            Ok(Ok(r)) => {
                pending.answered = true;
                r
            }
            _ => Err("Dune Bot couldn't do it: the app didn't answer, so it was told to stop.".into()),
        }
    }

    /// The app's answer to `input.do`. Single use; an unknown id is refused.
    pub fn input_result(&self, p: &Value) -> anyhow::Result<Value> {
        let id = p.get("requestId").and_then(Value::as_str).unwrap_or("");
        let tx = self.inputs.lock().unwrap().remove(id).ok_or_else(|| anyhow!("no such input request"))?;
        let r = match p.get("error").and_then(Value::as_str) {
            Some(e) => Err(e.chars().take(300).collect()),
            // What the click landed on, as the screen labels it: one line, short.
            None => Ok(p.get("note").and_then(Value::as_str).unwrap_or("").chars().filter(|c| !c.is_control()).take(160).collect::<String>().trim().to_string()),
        };
        let _ = tx.send(r);
        Ok(json!({ "ok": true }))
    }

    /// The app's answer to `screen.capture`. Single use; an unknown id is refused.
    pub fn capture_result(&self, p: &Value) -> anyhow::Result<Value> {
        let id = p.get("requestId").and_then(Value::as_str).unwrap_or("");
        let tx = self.captures.lock().unwrap().remove(id).ok_or_else(|| anyhow!("no such screen request"))?;
        let r = match p.get("error").and_then(Value::as_str) {
            Some(e) => Err(e.chars().take(300).collect()),
            None => Ok(p.clone()),
        };
        let _ = tx.send(r);
        Ok(json!({ "ok": true }))
    }

    pub fn db<T>(&self, f: impl FnOnce(&Store) -> rusqlite::Result<T>) -> anyhow::Result<T> {
        let s = self.store.lock().map_err(|_| anyhow!("store lock poisoned"))?;
        f(&s).map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => anyhow!("not found"),
            e => anyhow!(e),
        })
    }

    pub fn set_mcp_port(&self, port: u16) {
        let _ = self.mcp_port.set(port);
    }

    pub fn mcp_url(&self, thread_id: &str) -> String {
        format!("http://127.0.0.1:{}/t/{}/mcp", self.mcp_port.get().copied().unwrap_or(0), thread_id)
    }

    /// The bearer token for one chat's tool endpoint. New tokens each time the core starts.
    pub fn token(&self, thread_id: &str) -> String {
        self.tokens
            .lock()
            .unwrap()
            .entry(thread_id.to_string())
            .or_insert_with(new_token)
            .clone()
    }

    pub fn check_token(&self, thread_id: &str, header: &str) -> bool {
        match self.tokens.lock().unwrap().get(thread_id) {
            Some(t) => ct_eq(header.as_bytes(), format!("Bearer {t}").as_bytes()),
            None => false,
        }
    }

    pub fn create_thread(&self, agent: &str, title: &str, cwd: Option<&str>) -> anyhow::Result<Thread> {
        if agent.is_empty() || !agent.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            bail!("bad agent id");
        }
        let id = new_id();
        let cwd = match cwd {
            Some(raw) => {
                let p = policy::resolve(raw, &self.data_dir);
                if let Some(why) = policy::denied(&p, &self.data_dir) {
                    bail!("that folder is {why}");
                }
                if !p.is_dir() {
                    bail!("{} is not a folder", p.display());
                }
                p
            }
            None => {
                let p = self.data_dir.join("workspaces").join(&id);
                std::fs::create_dir_all(&p)?;
                p
            }
        };
        let now = now_ms();
        let t = Thread {
            id,
            title: title.to_string(),
            agent: agent.to_string(),
            cwd: cwd.to_string_lossy().into_owned(),
            created_at: now,
            updated_at: now,
            preview: String::new(),
        };
        self.db(|d| d.create_thread(&t))?;
        self.out.event("thread.updated", json!({ "thread": t }));
        Ok(t)
    }

    pub async fn delete_thread(self: &Arc<Self>, id: &str) -> anyhow::Result<()> {
        crate::agent::close_session(self, id).await;
        self.tokens.lock().unwrap().remove(id);
        self.grants.lock().unwrap().retain(|(t, _)| t != id);
        // The accounts this chat named (asked.rs) go with it.
        crate::asked::forget(id);
        self.db(|d| d.delete_thread(id))?;
        crate::history::remove(self, id);
        self.out.event("thread.deleted", json!({ "id": id }));
        Ok(())
    }

    pub fn thread_changed(&self, id: &str) {
        if let Ok(t) = self.db(|d| d.get_thread(id)) {
            self.out.event("thread.updated", json!({ "thread": t }));
        }
    }

    pub fn add_message(&self, thread_id: &str, role: &str, text: &str, meta: Value) -> anyhow::Result<Message> {
        let m = Message {
            id: new_id(),
            thread_id: thread_id.to_string(),
            role: role.to_string(),
            text: text.to_string(),
            meta,
            created_at: now_ms(),
        };
        self.db(|d| d.add_message(&m))?;
        self.last_msg.lock().unwrap().insert(thread_id.to_string(), m.id.clone());
        self.out.event("message.created", json!({ "message": m }));
        Ok(m)
    }

    /// The newest message in a chat this session (used to start a new bubble after a card).
    pub fn last_message(&self, thread_id: &str) -> Option<String> {
        self.last_msg.lock().unwrap().get(thread_id).cloned()
    }

    pub fn update_message(&self, id: &str, text: &str, meta: Value) {
        if self.db(|d| d.set_message(id, text, &meta)).is_ok() {
            if let Ok(m) = self.db(|d| d.get_message(id)) {
                self.out.event("message.updated", json!({ "message": m }));
            }
        }
    }

    pub fn mode(&self, a: Action) -> Mode {
        self.db(|d| d.get_setting(&format!("mode.{}", a.key())))
            .ok()
            .flatten()
            .and_then(|v| Mode::from_key(&v))
            .unwrap_or_else(|| a.default_mode())
    }

    pub fn set_mode(&self, action: &str, mode: &str) -> anyhow::Result<()> {
        let a = Action::from_key(action).ok_or_else(|| anyhow!("unknown action \"{action}\""))?;
        let m = Mode::from_key(mode).ok_or_else(|| anyhow!("unknown mode \"{mode}\""))?;
        if m == Mode::Auto && a != Action::RunCommand {
            bail!("Auto is only for commands");
        }
        self.db(|d| d.set_setting(&format!("mode.{}", a.key()), m.key()))?;
        self.db(|d| d.ledger_add(None, "settings", a.key(), m.key(), "changed in Settings"))?;
        Ok(())
    }

    pub fn settings_json(&self) -> Value {
        let modes: Vec<Value> = Action::ALL
            .iter()
            .map(|a| {
                let choices: &[&str] = if *a == Action::RunCommand { &["auto", "ask", "always", "never"] } else { &["ask", "always", "never"] };
                json!({ "action": a.key(), "label": a.label(), "mode": self.mode(*a).key(), "choices": choices })
            })
            .collect();
        let mut prefs = serde_json::Map::new();
        for k in PREFS {
            let v = self.db(|d| d.get_setting(&format!("pref.{k}"))).ok().flatten();
            prefs.insert(k.to_string(), v.map(Value::String).unwrap_or(Value::Null));
        }
        json!({ "modes": modes, "prefs": prefs })
    }

    /// Whether voice goes through Sarvam: a key was handed over and Settings doesn't say "local".
    pub fn sarvam_on(&self) -> bool {
        self.sarvam.has_key() && !self.voice_local()
    }

    /// Sarvam will listen: its key is in, or the app is still unlocking it (sarvam.rs), and the user
    /// didn't pick this computer's voice.
    pub fn sarvam_may_listen(&self) -> bool {
        (self.sarvam.has_key() || self.sarvam.keys_pending()) && !self.voice_local()
    }

    /// Deepgram's American voice reads English answers (deepgram.rs).
    pub fn deepgram_on(&self) -> bool {
        self.deepgram.has_key() && !self.voice_local()
    }

    /// Settings › Voice on "This computer": nothing goes to Sarvam or Deepgram.
    fn voice_local(&self) -> bool {
        self.db(|d| d.get_setting("pref.voice.engine")).ok().flatten().as_deref() == Some("local")
    }

    pub fn set_pref(&self, key: &str, value: &str) -> anyhow::Result<()> {
        if !PREFS.contains(&key) {
            bail!("unknown preference \"{key}\"");
        }
        if value.len() > 200 {
            bail!("value too long");
        }
        if key == "keys.chord" && !crate::keys::CHORDS.iter().any(|(n, _, _)| *n == value) {
            bail!("unknown keys \"{value}\"");
        }
        if key == crate::dictation::PREF {
            crate::dictation::check(value)?;
        }
        self.db(|d| d.set_setting(&format!("pref.{key}"), value))?;
        if key == "keys.chord" {
            let label = crate::keys::choose(Some(value));
            self.out.event("chord.keys", json!({ "name": value, "keys": label }));
        }
        if key == crate::dictation::PREF {
            crate::dictation::set(self, value);
        }
        Ok(())
    }

    fn ledger(&self, thread_id: &str, action: Action, target: &str, decision: &str, detail: &str) {
        let _ = self.db(|d| d.ledger_add(Some(thread_id), action.key(), target, decision, detail));
    }

    /// Every agent action goes through here. `Err` carries the sentence the agent sees.
    pub async fn gate(&self, thread_id: &str, action: Action, target: &str, detail: &str) -> Result<(), String> {
        self.gate_with(thread_id, action, target, detail, None).await
    }

    /// `look`: for a command, whether it's free of anything risky (decides Auto).
    pub async fn gate_with(
        &self,
        thread_id: &str,
        action: Action,
        target: &str,
        detail: &str,
        look: Option<Result<(), crate::lookonly::Asked>>,
    ) -> Result<(), String> {
        let mut why: Option<String> = None;
        // A turn from the user's paired phone (telegram.rs), or a teammate's working for one (team.rs),
        // is a remote way in. Reading files, looking inside folders, searching past chats and finding
        // the computer need "Read my files from my phone"; looking at the screen, clicking, typing,
        // running commands, changing files and sending or changing anything in an account need "Let my
        // phone run actions" (telegram::switch_for). With the switch off it's refused; on, each one
        // asks, every time ("for this chat" from an earlier card doesn't count), whatever Permissions
        // says ("Never" still means never).
        let phone_switch = crate::telegram::switch_for(action)
            .filter(|_| crate::team::works_for(self, thread_id) == crate::asked::Origin::Phone);
        let from_phone = phone_switch.is_some();
        if let Some(key) = phone_switch {
            if self.mode(action) != Mode::Never && !crate::telegram::switch_on(self, key) {
                self.ledger(thread_id, action, target, "blocked (from your phone)", detail);
                return Err(crate::telegram::refused(key).into());
            }
        }
        let mode = match self.mode(action) {
            Mode::Always | Mode::Auto | Mode::Ask if from_phone => {
                why = Some("it came from your phone".into());
                Mode::Ask
            }
            // A chat a schedule started runs while you may be away: it always asks before commands,
            // file changes and looks at the screen, whatever Permissions says ("Never" still means never).
            Mode::Always | Mode::Auto
                if matches!(action, Action::RunCommand | Action::WriteFile | Action::LookScreen | Action::Click | Action::Type)
                    && self.db(|d| d.is_scheduled(thread_id)).unwrap_or(true) =>
            {
                Mode::Ask
            }
            Mode::Auto => match look {
                Some(Ok(())) => {
                    eprintln!("dunebot-core: auto: ran a command with nothing risky in it");
                    self.ledger(thread_id, action, target, "allowed (auto: nothing risky)", detail);
                    return Ok(());
                }
                Some(Err(a)) => {
                    eprintln!("dunebot-core: auto: asked ({})", a.category);
                    why = Some(a.reason);
                    Mode::Ask
                }
                None => Mode::Ask,
            },
            m => m,
        };
        let detail_logged = match &why {
            Some(w) => format!("{detail}; asked because {w}"),
            None => detail.to_string(),
        };
        let detail = detail_logged.as_str();
        let decision = match mode {
            Mode::Never => {
                self.ledger(thread_id, action, target, "blocked by settings", detail);
                return Err(format!("\"{}\" is turned off in Dune Bot's settings, so this was not done.", action.label()));
            }
            Mode::Always => "allowed (always)",
            // (Auto has been decided above: it never gets here as Auto.)
            Mode::Ask | Mode::Auto => {
                if !from_phone && self.grants.lock().unwrap().contains(&(thread_id.to_string(), action)) {
                    "allowed (this chat)"
                } else {
                    match self.ask(thread_id, action, target, detail, why.as_deref()).await {
                        Some(Decision::Once) => "approved once",
                        Some(Decision::Chat) if from_phone => "approved once",
                        Some(Decision::Chat) => {
                            self.grants.lock().unwrap().insert((thread_id.to_string(), action));
                            "approved for this chat"
                        }
                        Some(Decision::Deny) => {
                            self.ledger(thread_id, action, target, "declined", detail);
                            return Err("The user declined this action. Don't retry it; say what you'd need instead.".into());
                        }
                        None => {
                            self.ledger(thread_id, action, target, "no answer", detail);
                            return Err("The user didn't answer, so this was not done.".into());
                        }
                    }
                }
            }
        };
        self.ledger(thread_id, action, target, decision, detail);
        Ok(())
    }

    async fn ask(&self, thread_id: &str, action: Action, target: &str, detail: &str, why: Option<&str>) -> Option<Decision> {
        let id = new_id();
        let (tx, rx) = oneshot::channel();
        // The card shows where it runs; `why` (Auto) says why this one asks.
        let shown = detail.split("; asked because ").next().unwrap_or(detail);
        let meta = json!({
            "approvalId": id, "action": action.key(), "label": action.label(),
            "target": target, "detail": shown, "why": why, "status": "pending",
        });
        let msg = self.add_message(thread_id, "approval", action.label(), meta.clone()).ok()?;
        self.pending.lock().unwrap().insert(id.clone(), Pending { tx, thread_id: thread_id.to_string(), shown: std::time::Instant::now() });
        self.out.event(
            "approval.request",
            json!({ "approvalId": id, "threadId": thread_id, "label": action.label(), "target": target }),
        );
        let answer = tokio::time::timeout(APPROVAL_WAIT, rx).await.ok().and_then(Result::ok);
        self.pending.lock().unwrap().remove(&id);
        let status = match answer {
            Some(Decision::Once) => "approved-once",
            Some(Decision::Chat) => "approved-chat",
            Some(Decision::Deny) => "denied",
            None => "expired",
        };
        let mut meta = meta;
        meta["status"] = json!(status);
        self.update_message(&msg.id, &msg.text, meta);
        answer
    }

    /// The renderer's answer to an approval card. Single use: a second answer is refused.
    pub fn respond(&self, id: &str, decision: &str) -> anyhow::Result<Value> {
        let d = match decision {
            "once" => Decision::Once,
            "chat" => Decision::Chat,
            "deny" => Decision::Deny,
            _ => bail!("decision must be once, chat or deny"),
        };
        let p = {
            let mut pending = self.pending.lock().unwrap();
            let early = pending.get(id).is_some_and(|p| d != Decision::Deny && p.shown.elapsed() < min_read_time());
            if early {
                bail!("too soon: read the card first");
            }
            pending.remove(id).ok_or_else(|| anyhow!("that approval was already answered or has expired"))?
        };
        let thread_id = p.thread_id.clone();
        p.tx.send(d).map_err(|_| anyhow!("the action is no longer waiting"))?;
        Ok(json!({ "ok": true, "threadId": thread_id }))
    }

    /// Fires when the user presses Stop in a chat; running commands listen for it.
    pub fn stop_signal(&self, thread_id: &str) -> Arc<tokio::sync::Notify> {
        self.stops.lock().unwrap().entry(thread_id.to_string()).or_default().clone()
    }

    /// Cancelling a chat's turn drops its pending approvals as declined.
    pub fn deny_pending(&self, thread_id: &str) {
        let ids: Vec<String> = self
            .pending
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, p)| p.thread_id == thread_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            let _ = self.respond(&id, "deny");
        }
    }
}
