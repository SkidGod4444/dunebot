//! A team of bots. The user makes their own bots: a name, a role in their words ("Writer: turns
//! notes into a short post"), the engine it runs on (any agent `agents.list` offers) and what it may
//! do. A chat with a bot runs on the bot's engine with its role in its instructions. A bot can hand
//! part of its work to a teammate with `ask_bot`: the task runs as a turn in a new chat of that
//! teammate's own, and its answer comes back to the bot that asked.
//!
//! The rules, all decided here:
//! - A handed-over turn starts as `Origin::Bot` (asked.rs), so it never reads the user's accounts;
//!   a handoff from a chat a schedule started is no different.
//! - Its approvals are its own chat's: the card shows there like any other, and since every
//!   handoff gets a new chat, nothing approved "for this chat" anywhere carries over. A teammate
//!   working for a scheduled run asks wherever that run would (its chat is marked as the run's).
//! - What a bot may do only narrows Permissions: a tool it may not use is refused before the gate.
//! - At most two handoffs deep; never to a bot already on the way (itself included); within a time
//!   limit. Stop on the asking chat, and "stop every agent", stop the teammate too.

use std::{
    future::Future,
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{anyhow, bail};
use serde::Serialize;
use serde_json::{json, Value};

use crate::{
    agent,
    app::{new_id, App},
    asked::Origin,
    policy::Action,
    store::{now_ms, Thread},
};

/// A handoff may lead to another, and that one no further: the user's chat, then two teammates.
pub const MAX_DEPTH: usize = 2;
const MAX_NAME: usize = 40;
const MAX_ROLE: usize = 600;
const MAX_TASK: usize = 8000;
const MAX_ANSWER: usize = 12_000;
const MAX_BOTS: usize = 30;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bot {
    pub id: String,
    pub name: String,
    pub role: String,
    /// The agent it runs on ("claude", "codex", "echo", …).
    pub engine: String,
    /// The actions it may use (`policy::Action` keys); the rest are refused for it.
    pub may: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Bot {
    pub fn may(&self, a: Action) -> bool {
        self.may.iter().any(|k| k == a.key())
    }
}

/// A chat's agent id that names one of the user's bots.
pub fn is_bot(id: &str) -> bool {
    id.starts_with("bot-")
}

pub fn all(app: &App) -> Vec<Bot> {
    app.db(|d| d.bots()).unwrap_or_default()
}

fn get(app: &App, id: &str) -> Option<Bot> {
    if !is_bot(id) {
        return None;
    }
    all(app).into_iter().find(|b| b.id == id)
}

pub fn list(app: &App) -> Value {
    json!({ "bots": all(app) })
}

fn changed(app: &App) {
    app.out.event("bots.changed", list(app));
}

fn one_line(s: &str, max: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        format!("{}…", flat.chars().take(max).collect::<String>().trim_end())
    }
}

/// What a bot does when it uses an action, for sentences ("Writer may not run commands").
fn doing(a: Action) -> &'static str {
    match a {
        Action::RunCommand => "run commands",
        Action::WriteFile => "create or change files",
        Action::ReadFile => "read files",
        Action::ListFolder => "look inside folders",
        Action::SearchChats => "search past chats",
        Action::LookScreen => "look at the screen",
        Action::FindLocation => "find where the computer is",
        Action::Click => "click, scroll or drag on the screen",
        Action::Type => "type or press keys",
        Action::Point => "point at things on the screen",
        Action::SlackWrite => "send or change things in Slack",
        Action::GmailWrite => "draft or change email in Gmail",
        Action::NotionWrite => "create or change Notion pages",
        Action::CalendarWrite => "add or change calendar events",
        Action::XPost => "post on X",
    }
}

/// The action a tool uses (tools.rs), if any.
fn action_of(tool: &str) -> Option<Action> {
    Some(match tool {
        "run_command" => Action::RunCommand,
        "read_file" => Action::ReadFile,
        "write_file" => Action::WriteFile,
        "list_folder" => Action::ListFolder,
        "search_chats" => Action::SearchChats,
        "look_at_screen" => Action::LookScreen,
        "find_location" => Action::FindLocation,
        "click" | "scroll" | "drag" => Action::Click,
        "type_text" | "press_keys" => Action::Type,
        // Taking the ring away (clear_pointer) is always allowed.
        "point_at" => Action::Point,
        _ => return None,
    })
}

/// "a; b; or c" (the items may have commas of their own).
fn words_list(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{}; or {last}", rest.join("; ")),
    }
}

/// Adds a bot (no `id`) or changes one: `name`, `role`, `engine`, and `may` (action keys; all of
/// them when left out).
pub fn save(app: &App, p: &Value) -> anyhow::Result<Bot> {
    let text = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("");
    let name = one_line(&text("name").chars().filter(|c| !c.is_control()).collect::<String>(), usize::MAX);
    if name.is_empty() {
        bail!("Give the bot a name.");
    }
    if name.chars().count() > MAX_NAME {
        bail!("Keep the name under {MAX_NAME} characters.");
    }
    let role: String = text("role").chars().filter(|c| *c == '\n' || !c.is_control()).collect::<String>().trim().to_string();
    if role.is_empty() {
        bail!("Write the bot's role: what it does, in a sentence.");
    }
    if role.chars().count() > MAX_ROLE {
        bail!("Keep the role under {MAX_ROLE} characters.");
    }
    let engine = text("engine").trim();
    if engine.is_empty() || engine.len() > 40 || !engine.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        bail!("Pick the engine it runs on.");
    }
    if is_bot(engine) {
        bail!("A bot runs on an engine (an agent), not on another bot.");
    }
    let id = p.get("id").and_then(Value::as_str).filter(|s| !s.is_empty());
    let may: Vec<String> = match p.get("may") {
        // No list: an edit keeps what the bot had; a new bot may do everything on this computer
        // that Permissions allows, but changes nothing in your accounts (sending, posting) until
        // you give it that. The careful default (2026-11-21), put to the user to confirm.
        None | Some(Value::Null) => match id.and_then(|id| get(app, id)) {
            Some(b) => b.may,
            None => Action::ALL.iter().filter(|a| !a.is_account_change()).map(|a| a.key().to_string()).collect(),
        },
        Some(Value::Array(keys)) => {
            let mut chosen = Vec::new();
            for k in keys {
                let k = k.as_str().unwrap_or("");
                let a = Action::from_key(k).ok_or_else(|| anyhow!("unknown action \"{k}\""))?;
                chosen.push(a);
            }
            Action::ALL.iter().filter(|a| chosen.contains(a)).map(|a| a.key().to_string()).collect()
        }
        Some(_) => bail!("\"may\" must be a list of actions"),
    };
    let bots = all(app);
    if bots.iter().any(|b| Some(b.id.as_str()) != id && b.name.to_lowercase() == name.to_lowercase()) {
        bail!("You already have a bot called {name}.");
    }
    let now = now_ms();
    let (bot, added) = match id {
        Some(id) => {
            let old = bots.iter().find(|b| b.id == id).ok_or_else(|| anyhow!("That bot no longer exists."))?;
            (Bot { id: old.id.clone(), name, role, engine: engine.into(), may, created_at: old.created_at, updated_at: now }, false)
        }
        None => {
            if bots.len() >= MAX_BOTS {
                bail!("That's {MAX_BOTS} bots already. Delete one first.");
            }
            (Bot { id: format!("bot-{}", new_id()), name, role, engine: engine.into(), may, created_at: now, updated_at: now }, true)
        }
    };
    app.db(|d| d.bot_put(&bot))?;
    let _ = app.db(|d| d.ledger_add(None, "bot", &bot.name, if added { "added" } else { "changed" }, &one_line(&bot.role, 200)));
    changed(app);
    Ok(bot)
}

/// Removes a bot. Its chats stay (they can't take new messages); the bar's pick, if it was this bot,
/// goes back to the engine it ran on.
pub fn delete(app: &App, id: &str) -> anyhow::Result<()> {
    let bot = get(app, id).ok_or_else(|| anyhow!("That bot no longer exists."))?;
    app.db(|d| d.bot_delete(id))?;
    if app.db(|d| d.get_setting("pref.agent")).ok().flatten().as_deref() == Some(id) {
        let _ = app.db(|d| d.set_setting("pref.agent", &bot.engine));
    }
    let _ = app.db(|d| d.ledger_add(None, "bot", &bot.name, "deleted", ""));
    changed(app);
    Ok(())
}

/// The engine a chat's agent runs on: a bot's engine, or the agent itself. The error is for the user.
pub fn engine(app: &App, agent: &str) -> Result<String, String> {
    if !is_bot(agent) {
        return Ok(agent.to_string());
    }
    get(app, agent).map(|b| b.engine).ok_or_else(|| "This chat's bot was deleted. Start a new chat with another bot or agent.".into())
}

/// Whether this chat's bot may use `tool` (chats without a bot: always). Only narrows: a tool it may
/// use still goes through the gate as usual. The error is the sentence the agent sees.
pub fn may_use(app: &App, thread: &Thread, tool: &str) -> Result<(), String> {
    if !is_bot(&thread.agent) {
        return Ok(());
    }
    let Some(bot) = get(app, &thread.agent) else {
        return Err("This chat's bot was deleted, so Dune Bot does nothing more for it.".into());
    };
    // An account's change (Slack, Gmail...) is the bot's to make only if it may; its reads follow
    // asked.rs as for any chat.
    let Some(action) = action_of(tool).or_else(|| crate::connectors::change_action(app, tool)) else { return Ok(()) };
    if bot.may(action) {
        return Ok(());
    }
    let _ = app.db(|d| d.ledger_add(Some(&thread.id), action.key(), tool, "blocked (not this bot's)", &format!("{} may not {}", bot.name, doing(action))));
    Err(format!(
        "{} may not {} (the user chose what each bot may do in Permissions › Bots), so this was not done. If a teammate may, hand it over with ask_bot; otherwise say what you'd need.",
        bot.name,
        doing(action)
    ))
}

// ---------- where a chat stands in a handoff ----------

/// Who the work in a chat is for: its own turn's origin, or, for a teammate's chat, the turn that
/// handed the work over (followed up every handoff). The phone's rule (App::gate) follows a handoff
/// this way, so a phone turn can't have a teammate do what the phone itself may not.
pub fn works_for(app: &App, chat: &str) -> Origin {
    let mut id = chat.to_string();
    for _ in 0..8 {
        let o = crate::asked::origin(&id);
        if o != Origin::Bot {
            return o;
        }
        match parent_of(app, &id) {
            Some(up) => id = up,
            None => return Origin::Bot,
        }
    }
    Origin::Bot
}

fn parent_of(app: &App, chat: &str) -> Option<String> {
    app.db(|d| d.get_setting(&format!("team.from.{chat}"))).ok().flatten().filter(|s| !s.is_empty())
}

/// A chat's place in a handoff: how many handoffs led to it, the bots on the way (its own first)
/// and the chat it all started in.
struct Place {
    depth: usize,
    bots: Vec<String>,
    root: String,
}

fn place(app: &App, thread: &Thread) -> Place {
    let mut p = Place { depth: 0, bots: Vec::new(), root: thread.id.clone() };
    let mut at = thread.clone();
    loop {
        if is_bot(&at.agent) && !p.bots.contains(&at.agent) {
            p.bots.push(at.agent.clone());
        }
        let Some(up) = parent_of(app, &at.id) else { break };
        p.depth += 1;
        p.root = up.clone();
        // A gone chat ends the walk; its depth still counts.
        match app.db(|d| d.get_thread(&up)) {
            Ok(t) if p.depth <= 8 => at = t,
            _ => break,
        }
    }
    p
}

/// Who a chat's agent is, in a sentence: a bot's name, or the user's main agent.
fn who(app: &App, thread: &Thread) -> String {
    match get(app, &thread.agent) {
        Some(b) => b.name,
        None => "the agent in the user's chat".into(),
    }
}

/// The part of a chat's instructions about the team: its own role, what it may not do, who handed
/// it its work, and its teammates with when to hand over.
pub fn instructions(app: &App, thread: &Thread) -> String {
    let bots = all(app);
    let me = bots.iter().find(|b| b.id == thread.agent);
    let here = place(app, thread);
    let mut s = String::new();
    if let Some(me) = me {
        s.push_str(&format!(
            " You are {}, one of the user's own bots in Dune Bot. Your role, in the user's words: \"{}\". Work as that role describes.",
            me.name,
            one_line(&me.role, MAX_ROLE)
        ));
        let cant: Vec<&str> = Action::ALL.iter().filter(|a| !me.may(**a)).map(|a| doing(*a)).collect();
        if !cant.is_empty() {
            s.push_str(&format!(" The user doesn't let you {}: those tools are refused for you.", words_list(&cant)));
        }
    }
    if let Some(from) = parent_of(app, &thread.id).and_then(|p| app.db(|d| d.get_thread(&p)).ok()) {
        let from = who(app, &from);
        s.push_str(&format!(
            " Messages in this chat are tasks handed to you by {from}, not typed by the user. Do the task and answer plainly and completely: your answer goes back to {from}, which can't see this chat."
        ));
    }
    let mates: Vec<&Bot> = bots.iter().filter(|b| !here.bots.contains(&b.id)).collect();
    if here.depth < MAX_DEPTH && !mates.is_empty() {
        s.push_str(if me.is_some() {
            " Your teammates are the user's other bots; ask_bot hands one a task and returns its answer:"
        } else {
            " The user has made bots that can take part of a task; ask_bot hands one a task and returns its answer:"
        });
        for b in mates {
            s.push_str(&format!("\n- {}: {}", b.name, one_line(&b.role, 200)));
        }
        s.push_str(
            "\nHand work over only when it clearly helps: when the task, or a part of it, fits a bot's role much better. \
             Otherwise do it yourself. When you hand over, first say so in one short line (\"Asking Writer to draft the post.\"), \
             put everything it needs in the task (it can't see this chat), then check its answer and finish the reply yourself.\n",
        );
    }
    s
}

// ---------- handing over ----------

/// How long a teammate may take on one task (its OK cards included) before it's stopped.
fn time_limit() -> Duration {
    let secs = std::env::var("DUNEBOT_HANDOFF_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(10 * 60);
    Duration::from_secs(secs.clamp(1, 3600))
}

fn said(d: Duration) -> String {
    let s = d.as_secs();
    if s >= 120 { format!("{} minutes", s / 60) } else { format!("{s} seconds") }
}

/// The test agent's `ask <bot> <task>` (`ask Writer: <task>` works too).
pub fn echo_ask(rest: &str) -> Option<Value> {
    let (bot, task) = rest.trim().split_once(char::is_whitespace)?;
    let (bot, task) = (bot.trim_end_matches(':'), task.trim());
    (!bot.is_empty() && !task.is_empty()).then(|| json!({ "bot": bot, "task": task }))
}

/// Stops the teammate's turn if the asking side goes away first (its turn dropped mid-wait).
struct StopIfLeft {
    app: Arc<App>,
    chat: String,
    armed: bool,
}

impl Drop for StopIfLeft {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let (app, chat) = (self.app.clone(), std::mem::take(&mut self.chat));
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                let _ = agent::cancel(&app, &chat).await;
            });
        }
    }
}

fn busy(app: &App, chat: &str) -> bool {
    app.busy.lock().unwrap_or_else(|e| e.into_inner()).contains(chat)
}

/// Stops a chat's turn and waits (a few seconds at most) for it to end.
async fn stop_and_wait(app: &Arc<App>, chat: &str) {
    let _ = agent::cancel(app, chat).await;
    let end = Instant::now() + Duration::from_secs(5);
    while busy(app, chat) && Instant::now() < end {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// What the teammate said after the task (its words only), and how its turn ended.
fn answer_after(app: &App, chat: &str, asked: &str) -> (String, String) {
    let msgs = app.db(|d| d.messages(chat)).unwrap_or_default();
    let from = msgs.iter().position(|m| m.id == asked).map_or(msgs.len(), |i| i + 1);
    let said: Vec<&crate::store::Message> = msgs[from..].iter().filter(|m| m.role == "assistant").collect();
    let status = said.last().and_then(|m| m.meta.get("status")).and_then(Value::as_str).unwrap_or("done").to_string();
    let text = said.iter().map(|m| m.text.trim()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n\n");
    let mut text: String = text.chars().take(MAX_ANSWER).collect();
    if text.chars().count() == MAX_ANSWER {
        text.push_str("\n… (the rest is in its chat)");
    }
    (text, status)
}

enum Ended {
    Done,
    Stopped,
    TooLong,
}

/// `ask_bot {bot, task}`: runs the task as a turn in a new chat of the teammate's own and returns
/// its answer. The error is the sentence the asking agent sees.
///
/// Boxed with its `Send` spelled out: a turn can hand over, which starts a turn, and the compiler
/// can't see through that loop on its own.
pub fn ask_bot<'a>(app: &'a Arc<App>, thread: &'a Thread, args: &'a Value) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>> {
    Box::pin(ask_bot_within(app, thread, args, time_limit()))
}

async fn ask_bot_within(app: &Arc<App>, thread: &Thread, args: &Value, limit: Duration) -> Result<String, String> {
    let want = args.get("bot").and_then(Value::as_str).map(str::trim).unwrap_or("");
    let task = args.get("task").and_then(Value::as_str).map(str::trim).unwrap_or("");
    let bots = all(app);
    if bots.is_empty() {
        return Err("The user hasn't made any bots, so there's no teammate to ask. Do it yourself.".into());
    }
    let names = bots.iter().map(|b| b.name.as_str()).collect::<Vec<_>>().join(", ");
    if want.is_empty() {
        return Err(format!("\"bot\" is required: one of {names}."));
    }
    let Some(bot) = bots.iter().find(|b| b.name.eq_ignore_ascii_case(want) || b.name.to_lowercase() == want.to_lowercase() || b.id == want) else {
        return Err(format!("No bot is called \"{}\". The user's bots: {names}.", one_line(want, 60)));
    };
    if task.is_empty() {
        return Err("\"task\" is required: what the teammate should do, with everything it needs (it can't see this chat).".into());
    }
    if task.chars().count() > MAX_TASK {
        return Err(format!("That task is {} characters; keep it under {MAX_TASK}.", task.chars().count()));
    }
    let here = place(app, thread);
    if thread.agent == bot.id {
        return Err(format!("You are {}: a bot can't hand work to itself. Do it yourself.", bot.name));
    }
    if here.bots.contains(&bot.id) {
        return Err(format!("{} is already part of this handoff (the work came from it), so it can't be asked again. Do it yourself and answer.", bot.name));
    }
    if here.depth >= MAX_DEPTH {
        return Err(format!("This work has already been handed over {} times, the most Dune Bot allows. Do it yourself and answer.", here.depth));
    }
    if app.cancelled.lock().unwrap_or_else(|e| e.into_inner()).contains(&thread.id) {
        return Err("The user stopped this chat.".into());
    }

    // A new chat of the teammate's own, in this chat's folder: nothing approved anywhere carries over.
    let from = who(app, thread);
    let title: String = match get(app, &thread.agent) {
        Some(_) => format!("{} · asked by {from}", bot.name),
        None => format!("{} · for “{}”", bot.name, one_line(&thread.title, 40)),
    }
    .chars()
    .take(80)
    .collect();
    let child = app
        .create_thread(&bot.id, &title, Some(&thread.cwd))
        .or_else(|_| app.create_thread(&bot.id, &title, None))
        .map_err(|e| format!("Dune Bot couldn't start {}'s chat: {e}", bot.name))?;
    app.db(|d| d.set_setting(&format!("team.from.{}", child.id), &thread.id)).map_err(|e| format!("Dune Bot couldn't start {}'s chat: {e}", bot.name))?;
    // A teammate working for a scheduled run asks wherever that run would (App::gate).
    if app.db(|d| d.is_scheduled(&thread.id)).unwrap_or(true) {
        app.db(|d| d.scheduled_add(&child.id, 0)).map_err(|e| format!("Dune Bot couldn't start {}'s chat: {e}", bot.name))?;
    }
    let _ = app.db(|d| d.ledger_add(Some(&thread.id), "ask-bot", &bot.name, "handed over", &one_line(task, 200)));

    // Stop on this chat reaches the teammate: listen before it starts.
    let stop = app.stop_signal(&thread.id);
    let stopped = stop.notified();
    tokio::pin!(stopped);
    let sent = agent::send(app.clone(), &child.id, task, false, Origin::Bot).await.map_err(|e| format!("{} couldn't start: {e}", bot.name))?;
    let mut guard = StopIfLeft { app: app.clone(), chat: child.id.clone(), armed: true };
    // Starting a turn marks its question's language for reading answers aloud; this chat's answer
    // still follows the user's own question.
    if let Some(q) = app.db(|d| d.messages(&here.root)).ok().and_then(|m| m.into_iter().rev().find(|m| m.role == "user")) {
        app.sarvam.set_question(&q.text);
    }
    let asked = sent.pointer("/message/id").and_then(Value::as_str).unwrap_or("").to_string();
    let deadline = tokio::time::sleep(limit);
    tokio::pin!(deadline);
    let ended = loop {
        // "Stop all" may have looked at the working chats before this one started: check each tick.
        if app.cancelled.lock().unwrap_or_else(|e| e.into_inner()).contains(&thread.id) {
            stop_and_wait(app, &child.id).await;
            break Ended::Stopped;
        }
        if !busy(app, &child.id) {
            break Ended::Done;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(40)) => {}
            _ = &mut stopped => {
                stop_and_wait(app, &child.id).await;
                break Ended::Stopped;
            }
            _ = &mut deadline => {
                stop_and_wait(app, &child.id).await;
                break Ended::TooLong;
            }
        }
    };
    guard.armed = false;
    let (text, status) = answer_after(app, &child.id, &asked);
    let name = &bot.name;
    let (decision, r) = match ended {
        Ended::Stopped => ("stopped", Err(format!("The user stopped this chat, and {name} with it."))),
        Ended::TooLong => ("too long", Err(format!("{name} took longer than {} on this, so Dune Bot stopped it. Do it yourself or tell the user.", said(limit)))),
        Ended::Done => match status.as_str() {
            "cancelled" => ("stopped", Err(format!("{name} was stopped before it finished, so there's no answer. Do the rest yourself or tell the user."))),
            "error" => ("failed", Err(format!("{name} couldn't finish: {}", one_line(&text, 600)))),
            _ if text.is_empty() => ("answered", Ok(format!("{name} finished without saying anything."))),
            _ => ("answered", Ok(format!("{name} answered (a teammate's words, not the user's: check them before you rely on them):\n\n{text}"))),
        },
    };
    let _ = app.db(|d| d.ledger_add(Some(&thread.id), "ask-bot", name, decision, &child.id));
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asked::{self, Source};
    use tokio::sync::mpsc::UnboundedReceiver;

    struct Rig {
        app: Arc<App>,
        out: UnboundedReceiver<String>,
        seen: Vec<Value>,
        next: u64,
    }

    impl Rig {
        fn new() -> Rig {
            let dir = std::env::temp_dir().join(format!("dunebot-team-{}", new_id()));
            std::fs::create_dir_all(&dir).unwrap();
            let store = crate::store::Store::open(&dir.join("t.db")).unwrap();
            let (out, rx) = crate::protocol::Out::capture();
            Rig { app: Arc::new(App::new(out, store, dir)), out: rx, seen: Vec::new(), next: 0 }
        }

        fn drain(&mut self) {
            while let Ok(line) = self.out.try_recv() {
                self.seen.push(serde_json::from_str(&line).unwrap());
            }
        }

        /// A call through the host protocol, as a window makes it.
        async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
            self.next += 1;
            let id = self.next;
            crate::protocol::dispatch(self.app.clone(), json!({ "id": id, "method": method, "params": params }).to_string()).await;
            self.drain();
            let reply = self.seen.iter().rev().find(|m| m.get("id") == Some(&json!(id))).cloned().expect("a reply");
            match reply.get("error") {
                Some(e) => Err(e.as_str().unwrap_or("").to_string()),
                None => Ok(reply["result"].clone()),
            }
        }

        async fn bot(&mut self, name: &str, role: &str) -> Bot {
            let b = self.call("bots.save", json!({ "name": name, "role": role, "engine": agent::ECHO })).await.unwrap();
            serde_json::from_value::<Value>(b.clone()).map(|v| Bot {
                id: v["id"].as_str().unwrap().into(),
                name: v["name"].as_str().unwrap().into(),
                role: v["role"].as_str().unwrap().into(),
                engine: v["engine"].as_str().unwrap().into(),
                may: v["may"].as_array().unwrap().iter().map(|k| k.as_str().unwrap().to_string()).collect(),
                created_at: v["createdAt"].as_i64().unwrap(),
                updated_at: v["updatedAt"].as_i64().unwrap(),
            }).unwrap()
        }

        fn chat(&self, agent: &str) -> Thread {
            self.app.create_thread(agent, "Plan the launch post", None).unwrap()
        }

        /// The user sends `text` in `chat` (as the bar or a chat window does).
        async fn say(&mut self, chat: &Thread, text: &str) {
            self.call("threads.send", json!({ "id": chat.id, "text": text })).await.unwrap();
        }

        fn chats_of(&self, bot: &Bot) -> Vec<Thread> {
            self.app.db(|d| d.list_threads()).unwrap().into_iter().filter(|t| t.agent == bot.id).collect()
        }

        fn tool_out(&self, chat: &Thread) -> (String, String) {
            let m = self.app.db(|d| d.messages(&chat.id)).unwrap().into_iter().rev().find(|m| m.role == "tool").expect("a tool card");
            (m.meta["status"].as_str().unwrap_or("").to_string(), m.meta["output"].as_str().unwrap_or("").to_string())
        }

        fn last_said(&self, chat: &Thread) -> (String, String) {
            let m = self.app.db(|d| d.messages(&chat.id)).unwrap().into_iter().rev().find(|m| m.role == "assistant").expect("an answer");
            (m.text, m.meta["status"].as_str().unwrap_or("").to_string())
        }
    }

    async fn until(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
        let end = Instant::now() + Duration::from_secs(secs);
        while !f() {
            assert!(Instant::now() < end, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn ended(app: &App, chat: &str) {
        until("the turn to end", 20, || !busy(app, chat)).await;
    }

    #[tokio::test]
    async fn bots_are_made_changed_listed_and_deleted() {
        let mut r = Rig::new();
        assert_eq!(r.call("bots.list", json!({})).await.unwrap(), json!({ "bots": [] }));
        let w = r.call("bots.save", json!({ "name": "  Writer ", "role": "Turns notes into a short post", "engine": "claude" })).await.unwrap();
        let id = w["id"].as_str().unwrap().to_string();
        assert!(is_bot(&id) && w["name"] == "Writer" && w["engine"] == "claude");
        // A new bot may do everything on this computer, and nothing in your accounts until given it.
        let may: Vec<&str> = w["may"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
        assert_eq!(may.len(), Action::ALL.len() - 5, "a new bot may do everything but change your accounts: {may:?}");
        assert!(Action::ALL.iter().all(|a| may.contains(&a.key()) != a.is_account_change()), "{may:?}");
        r.drain();
        assert!(r.seen.iter().any(|m| m["event"] == "bots.changed" && m["bots"][0]["name"] == "Writer"), "windows hear of it");

        for (bad, why) in [
            (json!({ "name": "", "role": "x", "engine": "echo" }), "name"),
            (json!({ "name": "A", "role": "  ", "engine": "echo" }), "role"),
            (json!({ "name": "writer", "role": "x", "engine": "echo" }), "already have"),
            (json!({ "name": "B", "role": "x", "engine": id }), "not on another bot"),
            (json!({ "name": "B", "role": "x", "engine": "rm -rf" }), "engine"),
            (json!({ "name": "B", "role": "x", "engine": "echo", "may": ["sudo"] }), "unknown action"),
            (json!({ "name": "B".repeat(41), "role": "x", "engine": "echo" }), "under 40"),
        ] {
            let e = r.call("bots.save", bad.clone()).await.unwrap_err();
            assert!(e.contains(why), "{bad}: {e}");
        }

        let changed = r
            .call("bots.save", json!({ "id": id, "name": "Editor", "role": "Tightens drafts", "engine": "echo", "may": ["read-file", "write-file", "read-file"] }))
            .await
            .unwrap();
        assert_eq!((changed["id"].as_str().unwrap(), changed["name"].as_str().unwrap()), (id.as_str(), "Editor"));
        assert_eq!(changed["may"], json!(["write-file", "read-file"]), "kept in Permissions' order, once each");
        // An edit that doesn't send the list keeps it (it never widens back to the default).
        let renamed = r.call("bots.save", json!({ "id": id, "name": "Editor 2", "role": "Tightens drafts", "engine": "echo" })).await.unwrap();
        assert_eq!(renamed["may"], json!(["write-file", "read-file"]), "an edit without a list keeps the bot's actions");
        assert_eq!(changed["createdAt"], w["createdAt"]);
        let listed = r.call("bots.list", json!({})).await.unwrap();
        assert_eq!(listed["bots"].as_array().unwrap().len(), 1);
        assert_eq!(listed["bots"][0]["role"], "Tightens drafts");
        assert!(r.call("bots.save", json!({ "id": "bot-nope", "name": "X", "role": "x", "engine": "echo" })).await.unwrap_err().contains("no longer exists"));

        // Picked in the bar, then deleted: the bar goes back to the engine it ran on.
        r.call("prefs.set", json!({ "key": "agent", "value": id })).await.unwrap();
        r.call("bots.delete", json!({ "id": id })).await.unwrap();
        assert_eq!(r.call("bots.list", json!({})).await.unwrap(), json!({ "bots": [] }));
        assert_eq!(r.app.db(|d| d.get_setting("pref.agent")).unwrap().as_deref(), Some("echo"));
        assert!(r.call("bots.delete", json!({ "id": id })).await.is_err());
        let ledger = r.app.db(|d| d.ledger_list(50)).unwrap();
        assert!(["added", "changed", "deleted"].iter().all(|d| ledger.iter().any(|l| l.action == "bot" && l.decision == *d)));
    }

    #[tokio::test]
    async fn a_chat_with_a_bot_runs_on_its_engine_and_stops_when_it_is_deleted() {
        let mut r = Rig::new();
        let w = r.bot("Writer", "Turns notes into a short post").await;
        // As the bar does it: a new chat with the picked bot, in the home folder, then the message.
        let made = r.call("threads.create", json!({ "agent": w.id, "cwd": "~" })).await.unwrap();
        assert_eq!(made["agent"], w.id.as_str());
        let chat: Thread = r.app.db(|d| d.get_thread(made["id"].as_str().unwrap())).unwrap();
        r.say(&chat, "hello writer").await;
        ended(&r.app, &chat.id).await;
        assert!(r.last_said(&chat).0.contains("Echo: hello writer"), "the test engine answered for the bot");
        assert!(r.app.db(|d| d.messages(&chat.id)).unwrap().iter().any(|m| m.role == "user" && m.text == "hello writer"));
        r.call("bots.delete", json!({ "id": w.id })).await.unwrap();
        let e = r.call("threads.send", json!({ "id": chat.id, "text": "again" })).await.unwrap_err();
        assert!(e.contains("bot was deleted"), "{e}");
    }

    #[tokio::test]
    async fn a_handoff_returns_the_teammates_answer() {
        let mut r = Rig::new();
        r.app.set_mode("run-command", "always").unwrap();
        let researcher = r.bot("Researcher", "Finds sources and quotes them").await;
        let writer = r.bot("Writer", "Turns notes into a short post").await;
        let chat = r.chat(&researcher.id);
        r.say(&chat, "ask Writer run echo from-the-writer").await;
        ended(&r.app, &chat.id).await;
        let (status, out) = r.tool_out(&chat);
        assert_eq!(status, "done", "{out}");
        assert!(out.starts_with("Writer answered") && out.contains("from-the-writer") && out.contains("not the user's"), "{out}");
        assert!(r.last_said(&chat).0.contains("from-the-writer"), "the asking bot gets it back");

        let mine = r.chats_of(&writer);
        assert_eq!(mine.len(), 1, "the task ran in a chat of the Writer's own");
        let w = &mine[0];
        let real = |p: &str| std::fs::canonicalize(p).unwrap();
        assert_eq!((real(&w.cwd), w.title.as_str()), (real(&chat.cwd), "Writer · asked by Researcher"), "in the asking chat's folder");
        let msgs = r.app.db(|d| d.messages(&w.id)).unwrap();
        assert_eq!(msgs.iter().find(|m| m.role == "user").unwrap().text, "run echo from-the-writer");
        assert!(msgs.iter().any(|m| m.role == "tool" && m.meta["tool"] == "run_command"));
        let ledger = r.app.db(|d| d.ledger_list(50)).unwrap();
        assert!(ledger.iter().any(|l| l.action == "ask-bot" && l.decision == "handed over" && l.target == "Writer"));
        assert!(ledger.iter().any(|l| l.action == "ask-bot" && l.decision == "answered" && l.detail == w.id));

        // Every handoff gets a new chat (approvals never carry over); unknown bots are named back.
        r.say(&chat, "ask Writer run echo again").await;
        ended(&r.app, &chat.id).await;
        assert_eq!(r.chats_of(&writer).len(), 2);
        r.say(&chat, "ask Painter draw it").await;
        ended(&r.app, &chat.id).await;
        let (status, out) = r.tool_out(&chat);
        assert!(status == "failed" && out.contains("No bot is called \"Painter\"") && out.contains("Researcher, Writer"), "{out}");
    }

    #[tokio::test]
    async fn the_handed_over_turn_is_a_bots_and_never_reads_an_account() {
        let mut r = Rig::new();
        let lead = r.bot("Lead", "Plans the work").await;
        let writer = r.bot("Writer", "Turns notes into a short post").await;
        let chat = r.chat(&lead.id);
        // The user names Slack in their own words; the teammate still may not read it.
        r.say(&chat, "ask Writer pause check my slack and gmail").await;
        until("the Writer's chat", 10, || !r.chats_of(&writer).is_empty()).await;
        let w = r.chats_of(&writer).remove(0);
        until("the Writer's turn", 10, || busy(&r.app, &w.id)).await;
        assert_eq!(asked::origin(&w.id), Origin::Bot);
        let no = asked::check(&r.app, &w.id, Source::Slack).unwrap_err();
        assert!(no.contains("Another bot handed this over"), "{no}");
        assert!(asked::check(&r.app, &w.id, Source::Gmail).is_err());
        assert_eq!(asked::origin(&chat.id), Origin::User);
        ended(&r.app, &chat.id).await;
        assert!(r.tool_out(&chat).1.contains("Echo: check my slack and gmail"));

        // From a chat a schedule started: still Bot, and the teammate's chat is the run's (it asks).
        let run = r.chat(&lead.id);
        r.app.db(|d| d.scheduled_add(&run.id, 7)).unwrap();
        crate::agent::send(r.app.clone(), &run.id, "ask Writer pause from a schedule", false, Origin::Schedule).await.unwrap();
        until("the second Writer chat", 10, || r.chats_of(&writer).len() == 2).await;
        let w2 = r.chats_of(&writer).into_iter().find(|t| t.id != w.id).unwrap();
        until("its turn", 10, || busy(&r.app, &w2.id)).await;
        assert_eq!(asked::origin(&w2.id), Origin::Bot);
        assert!(asked::check(&r.app, &w2.id, Source::Calendar).unwrap_err().contains("Another bot"));
        assert!(r.app.db(|d| d.is_scheduled(&w2.id)).unwrap(), "a teammate working for a scheduled run asks as the run would");
        ended(&r.app, &run.id).await;
    }

    #[tokio::test]
    async fn handoffs_go_two_deep_at_most_and_never_in_a_circle() {
        let mut r = Rig::new();
        r.app.set_mode("run-command", "always").unwrap();
        let [a, b, c, d] = [
            r.bot("Ann", "Leads").await,
            r.bot("Ben", "Researches").await,
            r.bot("Cal", "Writes").await,
            r.bot("Dee", "Checks").await,
        ];
        // Two deep is fine: Ann → Ben → Cal.
        let chat = r.chat(&a.id);
        r.say(&chat, "ask Ben ask Cal run echo two-deep").await;
        ended(&r.app, &chat.id).await;
        let (status, out) = r.tool_out(&chat);
        assert!(status == "done" && out.contains("two-deep"), "{out}");

        // A third handoff is refused where it would happen (Cal's chat), and Dee never starts.
        let chat = r.chat(&a.id);
        r.say(&chat, "ask Ben ask Cal ask Dee run echo three-deep").await;
        ended(&r.app, &chat.id).await;
        assert!(r.chats_of(&d).is_empty(), "Dee never got the work");
        let cal = r.chats_of(&c).into_iter().find(|t| r.app.db(|x| x.messages(&t.id)).unwrap().iter().any(|m| m.text.contains("three-deep"))).unwrap();
        let (status, out) = r.tool_out(&cal);
        assert!(status == "failed" && out.contains("handed over 2 times"), "{out}");
        assert!(r.tool_out(&chat).1.contains("handed over 2 times"), "the refusal comes back up the chain");
        assert!(!instructions(&r.app, &cal).contains("ask_bot hands one"), "at the bottom, no teammates are offered");

        // Back to a bot already on the way: refused.
        let chat = r.chat(&a.id);
        r.say(&chat, "ask Ben ask Ann run echo circle").await;
        ended(&r.app, &chat.id).await;
        assert!(r.tool_out(&chat).1.contains("Ann is already part of this handoff"));
        assert_eq!(r.chats_of(&a).len(), 3, "no chat was made for Ann");
        let _ = b;
    }

    #[tokio::test]
    async fn a_bot_cannot_ask_itself() {
        let mut r = Rig::new();
        let w = r.bot("Writer", "Turns notes into a short post").await;
        let chat = r.chat(&w.id);
        r.say(&chat, "ask writer run echo me-again").await;
        ended(&r.app, &chat.id).await;
        let (status, out) = r.tool_out(&chat);
        assert!(status == "failed" && out.contains("can't hand work to itself"), "{out}");
        assert_eq!(r.chats_of(&w).len(), 1, "no new chat");
    }

    #[tokio::test]
    async fn stop_all_stops_a_teammate_mid_turn() {
        let mut r = Rig::new();
        r.app.set_mode("run-command", "always").unwrap();
        let lead = r.bot("Lead", "Plans").await;
        let ops = r.bot("Ops", "Runs commands carefully").await;
        let chat = r.chat(&lead.id);
        r.say(&chat, "ask Ops run sleep 31").await;
        until("Ops's command", 10, || {
            r.chats_of(&ops).first().is_some_and(|t| r.app.db(|d| d.messages(&t.id)).unwrap().iter().any(|m| m.role == "tool" && m.meta["status"] == "running"))
        })
        .await;
        let o = r.chats_of(&ops).remove(0);
        let t0 = Instant::now();
        let stopped = r.call("agents.stopAll", json!({})).await.unwrap();
        assert_eq!(stopped["stopped"], 2, "both chats were working");
        ended(&r.app, &o.id).await;
        ended(&r.app, &chat.id).await;
        assert!(t0.elapsed() < Duration::from_secs(5), "stopped in {:?}", t0.elapsed());
        assert_eq!(r.last_said(&o).1, "cancelled");
        assert_eq!(r.tool_out(&o).1, "The user stopped this command.");
        assert_eq!(r.last_said(&chat).1, "cancelled");
        let ledger = r.app.db(|d| d.ledger_list(50)).unwrap();
        assert!(ledger.iter().any(|l| l.action == "ask-bot" && l.decision == "stopped"));
    }

    #[tokio::test]
    async fn stop_on_the_asking_chat_stops_the_teammate() {
        let mut r = Rig::new();
        r.app.set_mode("run-command", "always").unwrap();
        let ops = r.bot("Ops", "Runs commands carefully").await;
        let chat = r.chat(agent::ECHO); // any chat may hand work to a bot
        r.say(&chat, "ask Ops run sleep 32").await;
        until("Ops's chat to work", 10, || r.chats_of(&ops).first().is_some_and(|t| busy(&r.app, &t.id))).await;
        let o = r.chats_of(&ops).remove(0);
        assert_eq!(o.title, "Ops · for “Plan the launch post”");
        r.call("threads.cancel", json!({ "id": chat.id })).await.unwrap();
        ended(&r.app, &o.id).await;
        ended(&r.app, &chat.id).await;
        assert_eq!(r.last_said(&o).1, "cancelled");
    }

    #[tokio::test]
    async fn a_handoff_has_a_time_limit() {
        let r = Rig::new();
        r.app.set_mode("run-command", "always").unwrap();
        let ops = save(&r.app, &json!({ "name": "Ops", "role": "Runs commands", "engine": "echo" })).unwrap();
        let chat = r.chat(agent::ECHO);
        let t0 = Instant::now();
        let e = ask_bot_within(&r.app, &chat, &json!({ "bot": "Ops", "task": "run sleep 33" }), Duration::from_millis(600)).await.unwrap_err();
        assert!(e.contains("Ops took longer than 0 seconds") && t0.elapsed() < Duration::from_secs(5), "{e} after {:?}", t0.elapsed());
        let o = &r.chats_of(&ops)[0];
        assert!(!busy(&r.app, &o.id));
        assert_eq!(r.last_said(o).1, "cancelled");
    }

    #[tokio::test]
    async fn the_teammates_approval_still_needs_its_card() {
        let mut r = Rig::new();
        r.app.set_mode("run-command", "ask").unwrap();
        let lead = r.bot("Lead", "Plans").await;
        let ops = r.bot("Ops", "Runs commands carefully").await;
        let chat = r.chat(&lead.id);
        // Commands are allowed for the asking chat ("for this chat")...
        r.say(&chat, "run echo mine").await;
        until("the lead's card", 10, || { r.drain(); r.seen.iter().any(|m| m["event"] == "approval.request" && m["threadId"] == chat.id.as_str()) }).await;
        let card = r.seen.iter().find(|m| m["event"] == "approval.request").unwrap()["approvalId"].as_str().unwrap().to_string();
        tokio::time::sleep(Duration::from_millis(600)).await;
        r.call("approvals.respond", json!({ "id": card, "decision": "chat" })).await.unwrap();
        ended(&r.app, &chat.id).await;
        // ...but the teammate's command still waits for a card of its own, in its own chat.
        r.say(&chat, "ask Ops run echo theirs").await;
        until("Ops's card", 10, || { r.drain(); r.seen.iter().any(|m| m["event"] == "approval.request" && m["threadId"] != chat.id.as_str()) }).await;
        let o = r.chats_of(&ops).remove(0);
        let req = r.seen.iter().rev().find(|m| m["event"] == "approval.request").unwrap().clone();
        assert_eq!(req["threadId"], o.id.as_str(), "the card belongs to the teammate's chat");
        let pending = r.app.db(|d| d.messages(&o.id)).unwrap().into_iter().find(|m| m.role == "approval").unwrap();
        assert_eq!((pending.meta["status"].as_str(), pending.meta["target"].as_str()), (Some("pending"), Some("echo theirs")));
        assert!(r.app.db(|d| d.messages(&chat.id)).unwrap().iter().filter(|m| m.role == "approval").count() == 1, "nothing new in the lead's chat");
        tokio::time::sleep(Duration::from_millis(600)).await;
        r.call("approvals.respond", json!({ "id": req["approvalId"], "decision": "once" })).await.unwrap();
        ended(&r.app, &chat.id).await;
        assert!(r.tool_out(&chat).1.contains("theirs"), "after the OK it ran and answered");

        // Declined: the teammate says so, and the asking bot hears it.
        r.say(&chat, "ask Ops run echo nope").await;
        let n = r.seen.len();
        until("the next card", 10, || { r.drain(); r.seen[n..].iter().any(|m| m["event"] == "approval.request") }).await;
        let req = r.seen[n..].iter().find(|m| m["event"] == "approval.request").unwrap().clone();
        r.call("approvals.respond", json!({ "id": req["approvalId"], "decision": "deny" })).await.unwrap();
        ended(&r.app, &chat.id).await;
        assert!(r.tool_out(&chat).1.contains("declined"), "{}", r.tool_out(&chat).1);

        // Set to Always: a teammate working for a scheduled run still asks.
        r.app.set_mode("run-command", "always").unwrap();
        let run = r.chat(&lead.id);
        r.app.db(|d| d.scheduled_add(&run.id, 9)).unwrap();
        let n = r.seen.len();
        crate::agent::send(r.app.clone(), &run.id, "ask Ops run echo scheduled", false, Origin::Schedule).await.unwrap();
        until("the scheduled teammate's card", 10, || { r.drain(); r.seen[n..].iter().any(|m| m["event"] == "approval.request") }).await;
        let req = r.seen[n..].iter().find(|m| m["event"] == "approval.request").unwrap().clone();
        assert_ne!(req["threadId"], run.id.as_str());
        r.call("approvals.respond", json!({ "id": req["approvalId"], "decision": "deny" })).await.unwrap();
        ended(&r.app, &run.id).await;
    }

    #[tokio::test]
    async fn a_teammate_working_for_the_phone_keeps_the_phones_rule() {
        let mut r = Rig::new();
        r.app.set_mode("run-command", "always").unwrap();
        let lead = r.bot("Lead", "Plans").await;
        let ops = r.bot("Ops", "Runs commands carefully").await;
        let chat = r.chat(&lead.id);
        let n = r.seen.len();
        crate::agent::send(r.app.clone(), &chat.id, "ask Ops run echo from-the-phone", false, Origin::Phone).await.unwrap();
        ended(&r.app, &chat.id).await;
        let o = r.chats_of(&ops).remove(0);
        assert_eq!(asked::origin(&o.id), Origin::Bot);
        assert_eq!(works_for(&r.app, &o.id), Origin::Phone, "the teammate works for the phone");
        r.drain();
        assert!(!r.seen[n..].iter().any(|m| m["event"] == "approval.request"), "refused, not asked");
        let ledger = r.app.db(|d| d.ledger_list(20)).unwrap();
        assert!(ledger.iter().any(|l| l.decision == "blocked (from your phone)" && l.action == "run-command"), "the teammate's command was blocked as the phone's");
        assert!(!ledger.iter().any(|l| l.action == "run-command" && l.decision.starts_with("allowed")));
        // The same handoff from the computer runs (Always).
        crate::agent::send(r.app.clone(), &chat.id, "ask Ops run echo from-the-computer", false, Origin::User).await.unwrap();
        ended(&r.app, &chat.id).await;
        assert!(r.app.db(|d| d.ledger_list(20)).unwrap().iter().any(|l| l.action == "run-command" && l.decision == "allowed (always)"));
    }

    #[tokio::test]
    async fn a_real_agent_is_offered_every_new_tool() {
        // What tools/list (mcp.rs) gives a real agent: the echo agent calls tools directly, so this
        // checks the merged list itself.
        let r = Rig::new();
        let list = crate::tools::list_for(&r.app);
        let names: Vec<&str> = list.as_array().unwrap().iter().filter_map(|t| t["name"].as_str()).collect();
        for want in ["point_at", "clear_pointer", "ask_bot", "connected_accounts", "look_at_screen", "click", "type_text"] {
            assert!(names.contains(&want), "{want} missing from {names:?}");
        }
        let mut sorted = names.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), names.len(), "no tool twice: {names:?}");
    }

    #[tokio::test]
    async fn a_bot_changes_an_account_only_if_it_may() {
        let mut r = Rig::new();
        let w = r.call("bots.save", json!({ "name": "Writer", "role": "Writes", "engine": "echo", "may": ["read-file"] })).await.unwrap();
        let chat = r.chat(w["id"].as_str().unwrap());
        let no = may_use(&r.app, &chat, "x_post").unwrap_err();
        assert!(no.starts_with("Writer may not post on X"), "{no}");
        assert!(may_use(&r.app, &chat, "x_search").is_ok(), "a read follows asked.rs, not the bot's list");
        let p = r.call("bots.save", json!({ "name": "Poster", "role": "Posts", "engine": "echo", "may": ["x-post"] })).await.unwrap();
        assert!(may_use(&r.app, &r.chat(p["id"].as_str().unwrap()), "x_post").is_ok());
    }

    #[tokio::test]
    async fn a_bot_does_only_what_it_may() {
        let mut r = Rig::new();
        r.app.set_mode("run-command", "always").unwrap();
        let w = r.call("bots.save", json!({ "name": "Writer", "role": "Writes", "engine": "echo", "may": ["read-file", "list-folder"] })).await.unwrap();
        let chat = r.chat(w["id"].as_str().unwrap());
        r.say(&chat, "run echo not-mine").await;
        ended(&r.app, &chat.id).await;
        let (status, out) = r.tool_out(&chat);
        assert!(status == "failed" && out.starts_with("Writer may not run commands"), "{out}");
        r.drain();
        assert!(!r.seen.iter().any(|m| m["event"] == "approval.request"), "refused before any card");
        assert!(r.app.db(|d| d.ledger_list(20)).unwrap().iter().any(|l| l.decision == "blocked (not this bot's)" && l.action == "run-command"));
        r.say(&chat, "ls .").await;
        ended(&r.app, &chat.id).await;
        assert_eq!(r.tool_out(&chat).0, "done", "what it may do still works");
    }

    #[tokio::test]
    async fn the_role_and_the_teammates_are_in_the_instructions() {
        let mut r = Rig::new();
        let researcher = r.bot("Researcher", "Finds sources\nand quotes them").await;
        r.bot("Writer", "Turns notes into a short post").await;
        r.call("bots.save", json!({ "name": "Ops", "role": "Runs commands carefully", "engine": "echo", "may": ["run-command", "read-file"] })).await.unwrap();
        let mine = instructions(&r.app, &r.chat(&researcher.id));
        assert!(mine.contains("You are Researcher") && mine.contains("\"Finds sources and quotes them\""), "{mine}");
        assert!(mine.contains("\n- Writer: Turns notes into a short post") && mine.contains("\n- Ops: Runs commands carefully"), "{mine}");
        assert!(!mine.contains("- Researcher:"), "not its own teammate: {mine}");
        assert!(mine.contains("only when it clearly helps") && mine.contains("say so in one short line"), "{mine}");
        let ops = all(&r.app).into_iter().find(|b| b.name == "Ops").unwrap();
        let theirs = instructions(&r.app, &r.chat(&ops.id));
        assert!(theirs.contains("doesn't let you create or change files; look inside folders;") && theirs.contains("; find where the computer is;") && theirs.contains("; or post on X:"), "{theirs}");
        let plain = instructions(&r.app, &r.chat("claude"));
        assert!(plain.contains("The user has made bots") && plain.contains("- Researcher:") && !plain.contains("You are"), "{plain}");

        // The test agent shows what a real one would be told; a handed-over chat knows who asked.
        r.app.set_mode("run-command", "always").unwrap();
        let chat = r.chat(&researcher.id);
        r.say(&chat, "ask Writer team").await;
        ended(&r.app, &chat.id).await;
        let out = r.tool_out(&chat).1;
        assert!(out.contains("You are Writer") && out.contains("handed to you by Researcher") && out.contains("- Ops:") && !out.contains("- Researcher:"), "{out}");
        assert_eq!(instructions(&Rig::new().app, &r.chat("claude")), "", "no bots: nothing added");
    }

    #[test]
    fn the_test_agents_ask() {
        assert_eq!(echo_ask("Writer run echo hi"), Some(json!({ "bot": "Writer", "task": "run echo hi" })));
        assert_eq!(echo_ask("Writer: draft it"), Some(json!({ "bot": "Writer", "task": "draft it" })));
        assert_eq!(echo_ask("Writer"), None);
        assert_eq!(words_list(&["a", "b", "c"]), "a; b; or c");
    }
}
