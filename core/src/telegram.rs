//! Dune Bot from the user's phone, through their own Telegram bot (made with @BotFather).
//!
//! The core long-polls Telegram's `getUpdates` (no webhook, no public server) and answers with
//! `sendMessage`, as plain text. One chat is paired: the user sends `/pair <code>` (the code shown in
//! Settings › Phone) from their own Telegram. Messages from that chat are turns in a chat called
//! "Phone", started with `Origin::Phone`, and the answer goes back. Every other chat gets at most
//! "This bot is private." (once an hour), and nothing of it is kept.
//!
//! A phone is a remote way into an agent whose clicks and typing run without asking at the
//! computer. So a phone turn never looks at the screen, clicks, types, runs a command or changes a
//! file unless the user turns on "Let my phone run actions" (the rule is in `App::gate`); when on,
//! each of those asks, every time, and the card can be answered with Yes/No buttons on the phone as
//! well as at the computer. Reading files, looking inside folders, searching past chats and finding
//! where the computer is have their own switch, "Read my files from my phone" (off by default; on,
//! each asks the same way); which switch covers which action is `switch_for`. Account reads stay
//! off unless `phone.reads` is on (asked.rs).
//!
//! The token is handed over by the app on stdin (never an environment variable or a command line)
//! and kept in memory only. Telegram's URLs carry it, so every error and log line goes through
//! `redact`.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};

use anyhow::bail;
use serde_json::{json, Value};
use tokio::runtime::Handle;

use crate::{agent, app::App, asked::Origin, store::Thread};

#[cfg(not(test))]
const API: &str = "https://api.telegram.org";
/// How long one `getUpdates` waits for a message (Telegram holds the request open).
const POLL_SECS: u64 = if cfg!(test) { 1 } else { 25 };
/// Telegram takes up to 4096 characters a message; parts stay a little under.
const MAX_UNITS: usize = 4000;
/// A message older than this (sent while Dune Bot was off) isn't run.
const STALE_SECS: i64 = 10 * 60;
/// Wrong pairing codes before the code is replaced.
const WRONG_MAX: u32 = 5;

// Settings (the database's settings table).
const CHAT: &str = "phone.chat";
const NAME: &str = "phone.chatName";
const THREAD: &str = "phone.thread";
const OFFSET: &str = "phone.offset";
const BOT_ID: &str = "phone.bot";
/// "on": phone turns may read the accounts their message names (asked.rs reads it).
pub const READS: &str = "phone.reads";
/// "on": phone turns may look at the screen, click, type, run commands, change files and send or
/// change things in accounts, each asking.
pub const ACTIONS: &str = "phone.actions";
/// "on": phone turns may read files, look inside folders, search past chats and find where the
/// computer is, each asking.
pub const FILES: &str = "phone.files";

/// What the agent is told when a phone turn tries one of those with the switch off.
pub const REFUSED: &str = "From the user's phone, Dune Bot doesn't look at the screen, click, type, run commands, change files or send or change anything in their accounts; they can allow it (with an OK each time) in Dune Bot's settings on their computer, under Phone.";
/// The same for a read (the "Read my files from my phone" switch off).
pub const REFUSED_READS: &str = "From the user's phone, Dune Bot doesn't read files, look inside folders, search past chats or find where the computer is; they can allow it (with an OK each time) in Dune Bot's settings on their computer, under Phone.";

const PRIVATE: &str = "This bot is private.";
const PAIRED: &str = "Paired with Dune Bot. Send a message here to ask it something; /stop stops it, /new starts a new chat.";
const HELP: &str = "Send a message to ask Dune Bot something on your computer. /stop stops what it's doing; /new starts a new chat.";
const ONLY_TEXT: &str = "Only text messages work for now.";
const STALE: &str = "This arrived while Dune Bot was off, so it wasn't run. Send it again if you still want it.";
const BUSY: &str = "Still working on your last message. Send /stop to stop it.";

/// The phone's state. In memory only, except what's in the settings table (the paired chat, the
/// switches, the Phone chat, the update offset). No `Debug`: it holds the token.
pub struct Phone {
    token: Mutex<Option<String>>,
    wake: Condvar,
    /// Changes with every token handed over or taken back: an answer for an older one is dropped.
    era: AtomicU64,
    stopped: AtomicBool,
    code: Mutex<Option<String>>,
    wrong: AtomicU32,
    /// Chats told "This bot is private." lately, so each is told at most once an hour.
    told: Mutex<HashMap<i64, Instant>>,
    bot: Mutex<Option<String>>,
    problem: Mutex<Option<String>>,
    /// OK cards sent to the phone (approval id → the phone message), the only ones it may answer.
    cards: Mutex<HashMap<String, i64>>,
    outbox: Mutex<Option<mpsc::Sender<Op>>>,
    #[cfg(test)]
    base: Mutex<String>,
}

impl Default for Phone {
    fn default() -> Self {
        Self {
            token: Mutex::new(None),
            wake: Condvar::new(),
            era: AtomicU64::new(0),
            stopped: AtomicBool::new(false),
            code: Mutex::new(None),
            wrong: AtomicU32::new(0),
            told: Mutex::new(HashMap::new()),
            bot: Mutex::new(None),
            problem: Mutex::new(None),
            cards: Mutex::new(HashMap::new()),
            outbox: Mutex::new(None),
            // Tests point this at their mock; nothing in a test ever reaches Telegram.
            #[cfg(test)]
            base: Mutex::new("http://127.0.0.1:9".into()),
        }
    }
}

/// What goes to Telegram, in order, from one thread.
enum Op {
    Say { chat: i64, text: String },
    Private { chat: i64 },
    /// `buttons`: Yes/No the phone may answer (only when the user let their phone run actions).
    Card { chat: i64, approval: String, text: String, buttons: bool },
    Close { chat: i64, approval: String, text: String },
    Answer { query: String, text: String },
}

struct Fail {
    msg: String,
    code: u16,
    retry_after: Option<u64>,
}

/// Takes the token (and anything shaped like a bot token) out of `s`.
pub fn redact(s: &str, token: &str) -> String {
    let mut out = s.to_string();
    if token.len() >= 8 {
        out = out.replace(token, "…");
    }
    if let Some((_, secret)) = token.split_once(':') {
        if secret.len() >= 8 {
            out = out.replace(secret, "…");
        }
    }
    redact_shaped(&out)
}

/// `<5+ digits>:<20+ of A-Z a-z 0-9 _ ->`, wherever it is (as in `/bot123456:AA…/getMe`).
fn redact_shaped(s: &str) -> String {
    let b = s.as_bytes();
    let secret_byte = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'-';
    let mut out = String::with_capacity(s.len());
    let (mut copied, mut i) = (0, 0);
    while i < b.len() {
        if b[i] == b':' {
            let mut start = i;
            while start > copied && b[start - 1].is_ascii_digit() {
                start -= 1;
            }
            let mut end = i + 1;
            while end < b.len() && secret_byte(b[end]) {
                end += 1;
            }
            if i - start >= 5 && end - i - 1 >= 20 {
                out.push_str(&s[copied..start]);
                out.push('…');
                copied = end;
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&s[copied..]);
    out
}

fn token_shaped(t: &str) -> bool {
    let Some((id, secret)) = t.split_once(':') else { return false };
    (5..=15).contains(&id.len())
        && id.bytes().all(|c| c.is_ascii_digit())
        && (30..=60).contains(&secret.len())
        && secret.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// Splits an answer into messages of at most `max` UTF-16 units (how Telegram counts), at a
/// paragraph, a line or a space where it can, never inside a character.
pub fn split(text: &str, max: usize) -> Vec<String> {
    let units = |s: &str| s.chars().map(char::len_utf16).sum::<usize>();
    let mut parts = Vec::new();
    let mut rest = text.trim();
    while units(rest) > max {
        let (mut used, mut cut) = (0, 0);
        for (i, c) in rest.char_indices() {
            if used + c.len_utf16() > max {
                break;
            }
            used += c.len_utf16();
            cut = i + c.len_utf8();
        }
        if cut == 0 {
            // max is smaller than one character: take the character anyway.
            cut = rest.chars().next().map(char::len_utf8).unwrap_or(rest.len());
        }
        let head = &rest[..cut];
        let at = ["\n\n", "\n", " "].iter().find_map(|sep| head.rfind(sep).filter(|&i| i >= cut / 2 && i > 0));
        let (a, b) = match at {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (head, &rest[cut..]),
        };
        parts.push(a.trim_end().to_string());
        rest = b.trim_start();
    }
    if !rest.is_empty() {
        parts.push(rest.to_string());
    }
    parts
}

fn clip(s: &str, n: usize) -> String {
    let mut out: String = s.chars().take(n).collect();
    if out.len() < s.len() {
        out.push('…');
    }
    out
}

fn setting(app: &App, key: &str) -> Option<String> {
    app.db(|d| d.get_setting(key)).ok().flatten().filter(|v| !v.is_empty())
}

fn put(app: &App, key: &str, value: &str) {
    let _ = app.db(|d| d.set_setting(key, value));
}

fn paired_chat(app: &App) -> Option<i64> {
    setting(app, CHAT).and_then(|v| v.parse().ok())
}

/// Whether the user let their phone run actions (each one still asks).
pub fn actions_on(app: &App) -> bool {
    switch_on(app, ACTIONS)
}

/// Which Settings › Phone switch lets a phone turn do this; with it off the gate refuses, with it
/// on each one asks, every time, and the phone may answer. Every action is listed (no catch-all),
/// so a new one has to be placed. None: the teaching ring, which reads and changes nothing.
pub fn switch_for(action: crate::policy::Action) -> Option<&'static str> {
    use crate::policy::Action as A;
    match action {
        A::ReadFile | A::ListFolder | A::SearchChats | A::FindLocation => Some(FILES),
        A::RunCommand
        | A::WriteFile
        | A::LookScreen
        | A::Click
        | A::Type
        | A::SlackWrite
        | A::GmailWrite
        | A::NotionWrite
        | A::CalendarWrite
        | A::XPost => Some(ACTIONS),
        A::Point => None,
    }
}

pub fn switch_on(app: &App, key: &str) -> bool {
    setting(app, key).as_deref() == Some("on")
}

/// What the agent is told when a phone turn tries something whose switch is off.
pub fn refused(key: &str) -> &'static str {
    if key == FILES { REFUSED_READS } else { REFUSED }
}

fn new_code() -> String {
    // No 0/O or 1/I. Bytes 6 and 8 of a v4 UUID carry its version and variant, so they're skipped.
    const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let b = uuid::Uuid::new_v4().into_bytes();
    [0, 1, 2, 3, 4, 5, 10, 11].iter().map(|&i| ALPHABET[(b[i] % 32) as usize] as char).collect()
}

/// `/pair <code>` (or `/pair@SomeBot <code>`): the code as typed, in capitals without spaces or dashes.
fn pair_code(text: &str) -> Option<String> {
    let mut words = text.split_whitespace();
    let cmd = words.next()?.split('@').next()?;
    cmd.eq_ignore_ascii_case("/pair")
        .then(|| words.collect::<String>().chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_uppercase()).collect())
}

fn display_name(from: Option<&Value>) -> String {
    let get = |k: &str| from.and_then(|f| f.get(k)).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let mut name = [get("first_name"), get("last_name")].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" ");
    let user = get("username");
    if !user.is_empty() {
        name = if name.is_empty() { format!("@{user}") } else { format!("{name} (@{user})") };
    }
    let name: String = name.chars().filter(|c| !c.is_control()).take(80).collect();
    if name.is_empty() { "your Telegram".into() } else { name }
}

impl Phone {
    fn token(&self) -> Option<String> {
        self.token.lock().unwrap().clone()
    }

    pub fn has_token(&self) -> bool {
        self.token.lock().unwrap().is_some()
    }

    fn generation(&self) -> u64 {
        self.era.load(Ordering::SeqCst)
    }

    fn stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    fn base(&self) -> String {
        #[cfg(test)]
        let b = self.base.lock().unwrap().clone();
        #[cfg(not(test))]
        let b = API.to_string();
        b
    }

    /// A line for the log, with the token taken out whatever it says.
    fn log(&self, msg: &str) {
        let msg = match self.token() {
            Some(t) => redact(msg, &t),
            None => redact_shaped(msg),
        };
        eprintln!("dunebot-core: telegram: {msg}");
    }

    /// One Bot API call. Errors are redacted.
    fn api(&self, method: &str, body: &Value, wait: Duration) -> Result<Value, Fail> {
        let Some(token) = self.token() else {
            return Err(Fail { msg: "no bot token".into(), code: 0, retry_after: None });
        };
        let url = format!("{}/bot{token}/{method}", self.base());
        let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(wait)).http_status_as_error(false).build().into();
        let bytes = serde_json::to_vec(body).unwrap_or_default();
        let mut resp = match agent.post(&url).header("content-type", "application/json").send(&bytes[..]) {
            Ok(r) => r,
            Err(e) => {
                let msg = redact(&format!("Telegram couldn't be reached ({e})"), &token);
                return Err(Fail { msg, code: 0, retry_after: None });
            }
        };
        let status = resp.status().as_u16();
        let text = resp.body_mut().with_config().limit(4 << 20).read_to_string().unwrap_or_default();
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if status == 200 && v.get("ok") == Some(&Value::Bool(true)) {
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
        let said: String = v.get("description").and_then(Value::as_str).unwrap_or("").chars().filter(|c| !c.is_control()).take(200).collect();
        let msg = redact(&format!("Telegram said {status}{}", if said.is_empty() { String::new() } else { format!(": {said}") }), &token);
        Err(Fail { msg, code: status, retry_after: v.pointer("/parameters/retry_after").and_then(Value::as_u64) })
    }

    /// One call, waiting out Telegram's "too many requests" a few times.
    fn deliver(&self, method: &str, body: &Value) -> Option<Value> {
        for attempt in 0..4 {
            match self.api(method, body, Duration::from_secs(20)) {
                Ok(v) => return Some(v),
                Err(f) if f.code == 429 && attempt < 3 => std::thread::sleep(Duration::from_secs(f.retry_after.unwrap_or(1).clamp(1, 30))),
                Err(f) => {
                    self.log(&format!("{method} failed: {}", f.msg));
                    return None;
                }
            }
        }
        None
    }

    fn post(&self, op: Op) {
        if let Some(tx) = self.outbox.lock().unwrap().as_ref() {
            let _ = tx.send(op);
        }
    }

    /// What Settings › Phone shows. Never the token.
    pub fn status(&self, app: &App) -> Value {
        let paired = paired_chat(app).map(|_| json!({ "name": setting(app, NAME).unwrap_or_else(|| "your Telegram".into()) }));
        let code = if paired.is_none() { self.code.lock().unwrap().clone() } else { None };
        json!({
            "token": self.has_token(),
            "bot": self.bot.lock().unwrap().clone(),
            "code": code,
            "paired": paired,
            "reads": setting(app, READS).as_deref() == Some("on"),
            "actions": actions_on(app),
            "files": switch_on(app, FILES),
            "problem": self.problem.lock().unwrap().clone(),
        })
    }

    fn changed(&self, app: &App) {
        app.out.event("phone.updated", self.status(app));
    }

    fn set_problem(&self, app: &App, p: Option<String>) {
        let mut cur = self.problem.lock().unwrap();
        if *cur != p {
            *cur = p;
            drop(cur);
            self.changed(app);
        }
    }

    /// A pairing code while there's a token and no paired chat; none otherwise.
    fn ensure_code(&self, app: &App) {
        let want = self.has_token() && paired_chat(app).is_none();
        let mut code = self.code.lock().unwrap();
        if !want {
            *code = None;
        } else if code.is_none() {
            *code = Some(new_code());
            self.wrong.store(0, Ordering::SeqCst);
        }
    }

    fn forget_pairing(&self, app: &App) {
        put(app, CHAT, "");
        put(app, NAME, "");
        *self.code.lock().unwrap() = None;
        self.cards.lock().unwrap().clear();
    }

    /// The app hands the token over (at start and when it's saved), or takes it back with None.
    /// A different bot, or none, unpairs. The error never repeats what was given.
    pub fn set_token(&self, app: &App, key: Option<String>) -> anyhow::Result<()> {
        let key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
        if key.as_deref().is_some_and(|k| !token_shaped(k)) {
            bail!("that doesn't look like a Telegram bot token");
        }
        let bot_id = key.as_deref().and_then(|k| k.split_once(':')).map(|(id, _)| id.to_string());
        if setting(app, BOT_ID) != bot_id {
            if paired_chat(app).is_some() {
                let _ = app.db(|d| d.ledger_add(None, "phone", "your phone", "unpaired", "the bot's token was removed or changed"));
            }
            self.forget_pairing(app);
            put(app, BOT_ID, bot_id.as_deref().unwrap_or(""));
            put(app, OFFSET, "0");
        }
        *self.bot.lock().unwrap() = None;
        *self.problem.lock().unwrap() = None;
        {
            let mut t = self.token.lock().unwrap();
            *t = key;
            self.era.fetch_add(1, Ordering::SeqCst);
        }
        self.wake.notify_all();
        self.ensure_code(app);
        self.changed(app);
        Ok(())
    }

    /// Settings › Phone's three switches: "reads" (accounts), "files" and "actions".
    pub fn set_switch(&self, app: &App, key: &str, on: bool) -> anyhow::Result<()> {
        let (setting_key, what) = match key {
            "reads" => (READS, "phone: read accounts"),
            "actions" => (ACTIONS, "phone: run actions"),
            "files" => (FILES, "phone: read files"),
            _ => bail!("unknown phone setting \"{key}\""),
        };
        let value = if on { "on" } else { "off" };
        app.db(|d| d.set_setting(setting_key, value))?;
        app.db(|d| d.ledger_add(None, "settings", what, value, "changed in Settings"))?;
        self.changed(app);
        Ok(())
    }

    pub fn unpair(&self, app: &App) {
        if paired_chat(app).is_some() {
            let _ = app.db(|d| d.ledger_add(None, "phone", "your phone", "unpaired", "in Settings"));
            self.log("the phone was unpaired");
        }
        self.forget_pairing(app);
        self.ensure_code(app);
        self.changed(app);
    }

    fn code_matches(&self, given: &str) -> bool {
        self.code.lock().unwrap().as_deref().is_some_and(|c| crate::app::ct_eq(c.as_bytes(), given.as_bytes()))
    }

    fn wrong_guess(&self, app: &App) {
        if self.wrong.fetch_add(1, Ordering::SeqCst) + 1 >= WRONG_MAX && paired_chat(app).is_none() && self.has_token() {
            *self.code.lock().unwrap() = Some(new_code());
            self.wrong.store(0, Ordering::SeqCst);
            self.log("the pairing code was replaced after wrong tries");
            self.changed(app);
        }
    }

    /// "This bot is private.", at most once an hour per chat (and not at all in a flood).
    fn tell_private(&self, chat: i64) {
        let hour = Duration::from_secs(3600);
        let mut told = self.told.lock().unwrap();
        if told.get(&chat).is_some_and(|t| t.elapsed() < hour) {
            return;
        }
        if told.len() >= 1000 {
            told.retain(|_, t| t.elapsed() < hour);
            if told.len() >= 1000 {
                return;
            }
        }
        told.insert(chat, Instant::now());
        drop(told);
        self.post(Op::Private { chat });
    }

    /// Waits (a few seconds at most) for a token; its generation, if there is one.
    fn wait_for_token(&self) -> Option<u64> {
        let t = self.token.lock().unwrap();
        let (t, _) = self.wake.wait_timeout_while(t, Duration::from_secs(5), |t| t.is_none() && !self.stopped()).unwrap();
        t.as_ref().map(|_| self.generation())
    }

    /// Sleeps unless the token changes (or the poller is stopped) first.
    fn rest(&self, era: u64, d: Duration) {
        let t = self.token.lock().unwrap();
        let _ = self.wake.wait_timeout_while(t, d, |_| self.generation() == era && !self.stopped());
    }

    #[cfg(test)]
    fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.outbox.lock().unwrap().take();
        self.wake.notify_all();
    }
}

/// Starts the two threads: one long-polls Telegram, one sends to it in order. Plain threads, not
/// the runtime's: a poll held open by Telegram must not hold up the core's exit.
pub fn spawn(app: Arc<App>) {
    let rt = Handle::current();
    let (tx, rx) = mpsc::channel();
    *app.phone.outbox.lock().unwrap() = Some(tx);
    let sender = app.clone();
    let _ = std::thread::Builder::new().name("telegram-send".into()).spawn(move || send_loop(&sender, rx));
    let _ = std::thread::Builder::new().name("telegram-poll".into()).spawn(move || poll_loop(&app, &rt));
}

fn send_loop(app: &Arc<App>, rx: mpsc::Receiver<Op>) {
    let phone = &app.phone;
    let preview_off = json!({ "is_disabled": true });
    while let Ok(op) = rx.recv() {
        if phone.stopped() {
            return;
        }
        let paired = paired_chat(app);
        match op {
            Op::Say { chat, text } => {
                if paired != Some(chat) {
                    continue;
                }
                for part in split(&text, MAX_UNITS) {
                    let body = json!({ "chat_id": chat, "text": part, "link_preview_options": preview_off });
                    if phone.deliver("sendMessage", &body).is_none() {
                        break;
                    }
                }
            }
            Op::Private { chat } => {
                phone.deliver("sendMessage", &json!({ "chat_id": chat, "text": PRIVATE }));
            }
            Op::Card { chat, approval: _, text, buttons: false } => {
                if paired == Some(chat) {
                    let body = json!({ "chat_id": chat, "text": clip(&text, 3500), "link_preview_options": preview_off });
                    phone.deliver("sendMessage", &body);
                }
            }
            Op::Card { chat, approval, text, buttons: true } => {
                if paired != Some(chat) {
                    continue;
                }
                let keys = json!({ "inline_keyboard": [[
                    { "text": "Yes", "callback_data": format!("y:{approval}") },
                    { "text": "No", "callback_data": format!("n:{approval}") },
                ]] });
                let body = json!({ "chat_id": chat, "text": clip(&text, 3500), "reply_markup": keys, "link_preview_options": preview_off });
                if let Some(id) = phone.deliver("sendMessage", &body).and_then(|m| m.get("message_id").and_then(Value::as_i64)) {
                    phone.cards.lock().unwrap().insert(approval, id);
                }
            }
            Op::Close { chat, approval, text } => {
                let Some(id) = phone.cards.lock().unwrap().remove(&approval) else { continue };
                if paired != Some(chat) {
                    continue;
                }
                // No reply_markup: the buttons go.
                let body = json!({ "chat_id": chat, "message_id": id, "text": clip(&text, 3500), "link_preview_options": preview_off });
                phone.deliver("editMessageText", &body);
            }
            Op::Answer { query, text } => {
                phone.deliver("answerCallbackQuery", &json!({ "callback_query_id": query, "text": text }));
            }
        }
    }
}

/// What the user sees when it goes wrong.
fn trouble(f: &Fail) -> String {
    match f.code {
        401 | 404 => "Telegram didn't accept this token. Check it with @BotFather and paste it again.".into(),
        409 => "Another program is reading this bot's messages (a webhook, or Dune Bot on another computer). Stop it and Dune Bot picks up again.".into(),
        0 => "Can't reach Telegram right now. Dune Bot keeps trying.".into(),
        _ => f.msg.clone(),
    }
}

fn poll_loop(app: &Arc<App>, rt: &Handle) {
    let phone = &app.phone;
    let mut asked_about: Option<u64> = None;
    let mut asked_at = Instant::now();
    let mut fails = 0u32;
    loop {
        if phone.stopped() {
            return;
        }
        let Some(era) = phone.wait_for_token() else { continue };
        // The bot's name: for each token, and again now and then until Telegram has told it.
        let unnamed = phone.bot.lock().unwrap().is_none() && asked_at.elapsed() > Duration::from_secs(30);
        if asked_about != Some(era) || unnamed {
            if asked_about != Some(era) {
                fails = 0;
            }
            asked_about = Some(era);
            asked_at = Instant::now();
            match phone.api("getMe", &json!({}), Duration::from_secs(20)) {
                Ok(me) => {
                    *phone.bot.lock().unwrap() = me.get("username").and_then(Value::as_str).map(|u| format!("@{u}"));
                    phone.set_problem(app, None);
                    phone.changed(app);
                }
                Err(f) => {
                    phone.log(&format!("getMe: {}", f.msg));
                    phone.set_problem(app, Some(trouble(&f)));
                }
            }
        }
        let offset = setting(app, OFFSET).and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
        let body = json!({ "offset": offset, "timeout": POLL_SECS, "allowed_updates": ["message", "callback_query"] });
        match phone.api("getUpdates", &body, Duration::from_secs(POLL_SECS + 15)) {
            Ok(list) => {
                fails = 0;
                phone.set_problem(app, None);
                for u in list.as_array().map(Vec::as_slice).unwrap_or_default() {
                    if phone.generation() != era || phone.stopped() {
                        break;
                    }
                    let Some(id) = u.get("update_id").and_then(Value::as_i64) else { continue };
                    put(app, OFFSET, &(id + 1).to_string());
                    // One bad update must not stop the bot.
                    let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| on_update(app, rt, u)));
                    if handled.is_err() {
                        phone.log("an update couldn't be handled; skipped it");
                    }
                }
            }
            Err(f) => {
                fails += 1;
                phone.log(&format!("getUpdates: {}", f.msg));
                phone.set_problem(app, Some(trouble(&f)));
                let secs = if matches!(f.code, 401 | 404) { 60 } else { 2u64.pow(fails.min(6)).min(60) };
                phone.rest(era, Duration::from_secs(secs));
            }
        }
    }
}

fn on_update(app: &Arc<App>, rt: &Handle, u: &Value) {
    if let Some(m) = u.get("message") {
        on_message(app, rt, m);
    } else if let Some(q) = u.get("callback_query") {
        on_tap(app, q);
    }
}

fn on_message(app: &Arc<App>, rt: &Handle, m: &Value) {
    let phone = &app.phone;
    let Some(chat) = m.pointer("/chat/id").and_then(Value::as_i64) else { return };
    let from = m.pointer("/from/id").and_then(Value::as_i64);
    // Only a person's own one-to-one chat with the bot: never a group, a channel or another bot.
    let own = m.pointer("/chat/type").and_then(Value::as_str) == Some("private")
        && from == Some(chat)
        && m.pointer("/from/is_bot").and_then(Value::as_bool) != Some(true);
    let text = m.get("text").and_then(Value::as_str).map(str::trim);
    match paired_chat(app) {
        Some(p) if own && p == chat => from_phone(app, rt, chat, m, text),
        Some(_) => phone.tell_private(chat),
        None => match text.and_then(pair_code) {
            Some(code) if own && phone.has_token() && phone.code_matches(&code) => pair(app, chat, m),
            Some(_) => {
                phone.wrong_guess(app);
                phone.tell_private(chat);
            }
            None => phone.tell_private(chat),
        },
    }
}

fn pair(app: &Arc<App>, chat: i64, m: &Value) {
    let phone = &app.phone;
    let name = display_name(m.get("from"));
    put(app, CHAT, &chat.to_string());
    put(app, NAME, &name);
    phone.ensure_code(app);
    let _ = app.db(|d| d.ledger_add(None, "phone", &name, "paired", "sent the pairing code from Telegram"));
    phone.log("a chat was paired");
    phone.post(Op::Say { chat, text: PAIRED.into() });
    phone.changed(app);
}

fn from_phone(app: &Arc<App>, rt: &Handle, chat: i64, m: &Value, text: Option<&str>) {
    let phone = &app.phone;
    let say = |text: &str| phone.post(Op::Say { chat, text: text.into() });
    let now = chrono::Utc::now().timestamp();
    if now - m.get("date").and_then(Value::as_i64).unwrap_or(now) > STALE_SECS {
        return say(STALE);
    }
    let Some(text) = text.filter(|t| !t.is_empty()) else { return say(ONLY_TEXT) };
    let cmd = text.split_whitespace().next().unwrap_or("").split('@').next().unwrap_or("").to_lowercase();
    match cmd.as_str() {
        "/start" | "/help" => say(HELP),
        "/pair" => say("This chat is already paired."),
        "/stop" => {
            let running = setting(app, THREAD).filter(|t| app.busy.lock().unwrap().contains(t));
            match running {
                Some(t) => {
                    let _ = rt.block_on(agent::cancel(app, &t));
                    say("Stopped.");
                }
                None => say("Nothing is running."),
            }
        }
        "/new" => {
            put(app, THREAD, "");
            say("New chat: your next message starts it.");
        }
        _ => phone_turn(app, rt, chat, text),
    }
}

/// The Phone chat (a new one if there's none or it was deleted), with the agent chosen in the app.
fn phone_thread(app: &App) -> anyhow::Result<Thread> {
    if let Some(id) = setting(app, THREAD) {
        if let Ok(t) = app.db(|d| d.get_thread(&id)) {
            return Ok(t);
        }
    }
    let agent = setting(app, "pref.agent").unwrap_or_else(|| "claude".into());
    let t = app.create_thread(&agent, "Phone", Some("~"))?;
    put(app, THREAD, &t.id);
    Ok(t)
}

fn phone_turn(app: &Arc<App>, rt: &Handle, chat: i64, text: &str) {
    let say = |text: String| app.phone.post(Op::Say { chat, text });
    let thread = match phone_thread(app) {
        Ok(t) => t,
        Err(e) => return say(format!("Dune Bot couldn't open its Phone chat ({e:#}).")),
    };
    // The user's words as they wrote them: only they may name an account to read (asked.rs).
    match rt.block_on(agent::send(app.clone(), &thread.id, text, false, Origin::Phone)) {
        Ok(v) => {
            let user = v.pointer("/message/id").and_then(Value::as_str).unwrap_or("").to_string();
            rt.spawn(watch(app.clone(), thread.id, user, chat));
        }
        Err(_) if app.busy.lock().unwrap().contains(&thread.id) => say(BUSY.into()),
        Err(e) => say(format!("That didn't start: {e:#}")),
    }
}

/// Follows one phone turn: its words go to the phone as each part is finished, OK cards go with
/// Yes/No buttons (and lose them once answered, here or at the computer), and the rest at the end.
async fn watch(app: Arc<App>, thread_id: String, user_msg: String, chat: i64) {
    let mut relay = Relay::default();
    loop {
        let busy = app.busy.lock().unwrap().contains(&thread_id);
        // A newer message started another turn (its own watch follows it): this one is over, even
        // if the chat never looked idle in between.
        let over = relay.pass(&app, &thread_id, &user_msg, chat, busy);
        if !busy || over {
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    if !relay.said {
        app.phone.post(Op::Say { chat, text: "No answer.".into() });
    }
}

#[derive(Default)]
struct Relay {
    sent: HashSet<String>,
    /// Cards sent to the phone: false while waiting, true once closed.
    cards: HashMap<String, bool>,
    said: bool,
}

impl Relay {
    /// Sends what's new in this turn: what follows its message, up to the next one the user sent.
    /// True once a next one has started another turn (this one is over then).
    fn pass(&mut self, app: &App, thread_id: &str, user_msg: &str, chat: i64, busy: bool) -> bool {
        let Ok(msgs) = app.db(|d| d.messages(thread_id)) else { return false };
        let Some(start) = msgs.iter().position(|m| m.id == user_msg) else { return false };
        let after = &msgs[start + 1..];
        let end = after.iter().position(|m| m.role == "user").unwrap_or(after.len());
        let over = end < after.len();
        let after = &after[..end];
        let busy = busy && !over;
        for (i, m) in after.iter().enumerate() {
            match m.role.as_str() {
                "assistant" => {
                    if self.sent.contains(&m.id) {
                        continue;
                    }
                    // The newest part of a turn still going may still be growing.
                    if busy && i + 1 == after.len() {
                        break;
                    }
                    self.sent.insert(m.id.clone());
                    if !m.text.trim().is_empty() {
                        app.phone.post(Op::Say { chat, text: m.text.clone() });
                        self.said = true;
                    }
                }
                "approval" => {
                    let Some(id) = m.meta.get("approvalId").and_then(Value::as_str) else { continue };
                    let status = m.meta.get("status").and_then(Value::as_str).unwrap_or("");
                    match self.cards.get(id).copied() {
                        None if status == "pending" => {
                            // The phone answers a card only when the switch for its action is on
                            // (switch_for); any other card needs the computer.
                            let action = m.meta.get("action").and_then(Value::as_str).and_then(crate::policy::Action::from_key);
                            let buttons = action.and_then(switch_for).is_some_and(|k| switch_on(app, k));
                            let text = if buttons { card_text(m) } else { format!("{}\n\nThis needs your OK at the computer.", card_text(m).trim_end_matches("Allow it?").trim_end()) };
                            app.phone.post(Op::Card { chat, approval: id.to_string(), text, buttons });
                            self.cards.insert(id.to_string(), false);
                            self.said = true;
                        }
                        Some(false) if status != "pending" => {
                            let outcome = match status {
                                "approved-once" | "approved-chat" => "Allowed.",
                                "denied" => "Declined.",
                                _ => "No answer in time, so it wasn't done.",
                            };
                            app.phone.post(Op::Close { chat, approval: id.to_string(), text: format!("{}\n\n{outcome}", card_text(m)) });
                            self.cards.insert(id.to_string(), true);
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        over
    }
}

fn card_text(m: &crate::store::Message) -> String {
    let get = |k: &str| m.meta.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let mut lines = vec![format!("Dune Bot asks first: {}", get("label")), clip(&get("target"), 1500)];
    for k in ["detail", "why"] {
        let v = get(k);
        if !v.is_empty() {
            lines.push(if k == "why" { format!("It asks because {v}.") } else { v });
        }
    }
    lines.push("Allow it?".into());
    lines.retain(|l| !l.is_empty());
    lines.join("\n")
}

/// A Yes or No on a card's buttons: only from the paired chat, only for a card sent to it.
fn on_tap(app: &Arc<App>, q: &Value) {
    let Some(paired) = paired_chat(app) else { return };
    let from = q.pointer("/from/id").and_then(Value::as_i64);
    let chat = q.pointer("/message/chat/id").and_then(Value::as_i64);
    if from != Some(paired) || chat != Some(paired) {
        return;
    }
    let query = q.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let data = q.get("data").and_then(Value::as_str).unwrap_or("");
    let (yes, approval) = match data.split_once(':') {
        Some(("y", a)) => (true, a),
        Some(("n", a)) => (false, a),
        _ => return,
    };
    let ours = app.phone.cards.lock().unwrap().contains_key(approval);
    let said = if !ours {
        "That's no longer waiting."
    } else {
        match app.respond(approval, if yes { "once" } else { "deny" }) {
            Ok(_) => {
                let thread = setting(app, THREAD);
                let what = if yes { "Yes from your phone" } else { "No from your phone" };
                let _ = app.db(|d| d.ledger_add(thread.as_deref(), "phone", "an OK card", what, ""));
                if yes { "Allowed." } else { "Declined." }
            }
            Err(e) if e.to_string().contains("too soon") => "Too soon: read it first, then tap again.",
            Err(_) => "That's no longer waiting.",
        }
    };
    app.phone.post(Op::Answer { query, text: said.into() });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asked::Source;
    use axum::{
        extract::{Path, State},
        routing::post,
        Router,
    };
    use std::collections::VecDeque;

    const TOKEN: &str = "123456789:AAFakeTokenForDunebotTests_onlyXYZ0123";
    const ME: i64 = 7001;

    #[test]
    fn splits_long_answers_on_character_boundaries() {
        let units = |s: &str| s.chars().map(char::len_utf16).sum::<usize>();
        let para = "word ".repeat(300);
        let text = format!("{para}\n\n{para}\n\n{para}");
        let parts = split(&text, 1000);
        assert!(parts.len() >= 4 && parts.iter().all(|p| units(p) <= 1000 && !p.is_empty()), "{:?}", parts.iter().map(|p| units(p)).collect::<Vec<_>>());
        assert_eq!(parts.join(" ").split_whitespace().count(), 900);
        // Devanagari and emoji (two UTF-16 units each) with no spaces at all: hard cuts, never inside one.
        let hindi = "नमस्ते🙂".repeat(700);
        let parts = split(&hindi, 4000);
        assert!(parts.iter().all(|p| units(p) <= 4000));
        assert_eq!(parts.concat(), hindi);
        assert_eq!(split("  short  ", 4000), vec!["short"]);
        assert!(split("   ", 4000).is_empty());
    }

    #[test]
    fn takes_the_token_out_of_anything() {
        let url = format!("http://127.0.0.1:9/bot{TOKEN}/getUpdates: connection refused");
        let r = redact(&url, TOKEN);
        assert!(!r.contains(TOKEN) && !r.contains("AAFakeToken"), "{r}");
        // Another bot's token-shaped text, too.
        let other = "error at /bot987654321:ZZanotherSecretThatLeaks_0123456789/sendMessage";
        assert!(!redact(other, TOKEN).contains("ZZanother"), "{}", redact(other, TOKEN));
        assert_eq!(redact("12:30 at 10:45, chat 5:abc", TOKEN), "12:30 at 10:45, chat 5:abc");
        assert!(token_shaped(TOKEN) && !token_shaped("123:abc") && !token_shaped("abc:AAFakeTokenForDunebotTests_onlyXYZ0123"));
    }

    #[test]
    fn reads_pair_commands() {
        assert_eq!(pair_code("/pair k7qp-m2xd"), Some("K7QPM2XD".into()));
        assert_eq!(pair_code("/pair@my_bot K7QP M2XD"), Some("K7QPM2XD".into()));
        assert_eq!(pair_code("/PAIR"), Some(String::new()));
        assert_eq!(pair_code("pair K7QPM2XD"), None);
        assert_eq!(pair_code("/start"), None);
        let c = new_code();
        assert!(c.len() == 8 && c.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()), "{c}");
    }

    // ---------- a mock Bot API ----------

    #[derive(Default)]
    struct Mock {
        pending: Mutex<VecDeque<Value>>,
        calls: Mutex<Vec<(String, Value)>>,
        next_update: Mutex<i64>,
        next_message: Mutex<i64>,
    }

    impl Mock {
        fn push(&self, kind: &str, body: Value) {
            let mut n = self.next_update.lock().unwrap();
            *n += 1;
            self.pending.lock().unwrap().push_back(json!({ "update_id": *n, kind: body }));
        }

        fn message(&self, chat: i64, from: i64, kind: &str, text: Option<&str>) {
            let mut m = json!({
                "message_id": 1, "date": chrono::Utc::now().timestamp(),
                "chat": { "id": chat, "type": kind },
                "from": { "id": from, "is_bot": false, "first_name": "Sai", "username": "sai_test" },
            });
            if let Some(t) = text {
                m["text"] = json!(t);
            } else {
                m["voice"] = json!({ "file_id": "x", "duration": 2 });
            }
            self.push("message", m);
        }

        fn tap(&self, from: i64, chat: i64, data: &str) {
            self.push("callback_query", json!({
                "id": format!("q{}", *self.next_update.lock().unwrap() + 1),
                "from": { "id": from, "is_bot": false, "first_name": "X" },
                "message": { "message_id": 1, "chat": { "id": chat, "type": "private" } },
                "data": data,
            }));
        }

        fn sent(&self) -> Vec<(String, Value)> {
            self.calls.lock().unwrap().iter().filter(|(m, _)| m != "getUpdates" && m != "getMe").cloned().collect()
        }

        fn texts_to(&self, chat: i64) -> Vec<String> {
            self.sent()
                .into_iter()
                .filter(|(m, b)| m == "sendMessage" && b["chat_id"] == json!(chat))
                .map(|(_, b)| b["text"].as_str().unwrap_or("").to_string())
                .collect()
        }
    }

    async fn bot_api(State((mock, token)): State<(Arc<Mock>, String)>, Path((bot, method)): Path<(String, String)>, body: String) -> axum::Json<Value> {
        if bot != format!("bot{token}") {
            // As some servers do: the path (with the token in it) in the error.
            return axum::Json(json!({ "ok": false, "error_code": 401, "description": format!("Unauthorized: /{bot}/{method}") }));
        }
        let body: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        mock.calls.lock().unwrap().push((method.clone(), body.clone()));
        let result = match method.as_str() {
            "getMe" => json!({ "id": 123456789, "is_bot": true, "username": "dunebot_test_bot" }),
            "getUpdates" => {
                let offset = body["offset"].as_i64().unwrap_or(0);
                for _ in 0..10 {
                    mock.pending.lock().unwrap().retain(|u| u["update_id"].as_i64().unwrap_or(0) >= offset);
                    if !mock.pending.lock().unwrap().is_empty() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(30)).await;
                }
                json!(mock.pending.lock().unwrap().iter().cloned().collect::<Vec<_>>())
            }
            "sendMessage" => {
                let mut n = mock.next_message.lock().unwrap();
                *n += 1;
                json!({ "message_id": *n, "chat": { "id": body["chat_id"] }, "text": body["text"] })
            }
            _ => json!(true),
        };
        axum::Json(json!({ "ok": true, "result": result }))
    }

    async fn mock_server(token: &str) -> (Arc<Mock>, String) {
        let mock = Arc::new(Mock::default());
        let router = Router::new().route("/{bot}/{method}", post(bot_api)).with_state((mock.clone(), token.to_string()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (mock, url)
    }

    async fn rig(name: &str) -> (Arc<App>, Arc<Mock>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("dunebot-phone-{name}-{}", crate::app::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = crate::store::Store::open(&dir.join("t.db")).unwrap();
        let app = Arc::new(App::new(crate::protocol::Out::start(), store, dir.clone()));
        app.set_pref("agent", crate::agent::ECHO).unwrap();
        let (mock, url) = mock_server(TOKEN).await;
        *app.phone.base.lock().unwrap() = url;
        spawn(app.clone());
        app.phone.set_token(&app, Some(TOKEN.into())).unwrap();
        (app, mock, dir)
    }

    async fn until(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
        let end = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < end {
            if f() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("timed out waiting for {what}");
    }

    async fn paired(name: &str) -> (Arc<App>, Arc<Mock>, std::path::PathBuf) {
        let (app, mock, dir) = rig(name).await;
        let code = app.phone.status(&app)["code"].as_str().unwrap().to_string();
        mock.message(ME, ME, "private", Some(&format!("/pair {code}")));
        until("pairing", 10, || paired_chat(&app) == Some(ME)).await;
        until("the paired reply", 10, || mock.texts_to(ME).iter().any(|t| t.starts_with("Paired"))).await;
        (app, mock, dir)
    }

    fn done(app: &App, dir: &std::path::Path) {
        app.phone.stop();
        let _ = std::fs::remove_dir_all(dir);
    }

    /// How many messages the user has sent in the current Phone chat.
    fn asked(app: &App) -> usize {
        let Some(t) = setting(app, THREAD) else { return 0 };
        app.db(|d| d.messages(&t)).unwrap_or_default().iter().filter(|m| m.role == "user").count()
    }

    /// A message from the phone, then everything the phone was sent until the turn ended.
    async fn ask(app: &Arc<App>, mock: &Mock, text: &str) -> Vec<String> {
        let (before, n) = (mock.texts_to(ME).len(), asked(app));
        mock.message(ME, ME, "private", Some(text));
        until("the turn to start", 10, || asked(app) > n).await;
        let t = setting(app, THREAD).unwrap();
        until("the turn to end", 20, || !app.busy.lock().unwrap().contains(&t)).await;
        // Every part the turn said (its last once the turn has ended) and every card: all of it, not
        // whatever came within a set time ("On it." alone, on a slow CI machine).
        let msgs = app.db(|d| d.messages(&t)).unwrap();
        let start = msgs.iter().rposition(|m| m.role == "user").unwrap();
        let parts = msgs[start + 1..].iter().filter(|m| (m.role == "assistant" && !m.text.trim().is_empty()) || m.role == "approval").count();
        until("every part of the answer", 10, || mock.texts_to(ME).len() >= before + parts.max(1)).await;
        tokio::time::sleep(Duration::from_millis(400)).await; // and nothing more after it
        mock.texts_to(ME)[before..].to_vec()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn pairs_only_the_chat_that_sends_the_code() {
        let (app, mock, dir) = rig("pair").await;
        until("the bot's name", 10, || app.phone.status(&app)["bot"] == json!("@dunebot_test_bot")).await;
        let code = app.phone.status(&app)["code"].as_str().unwrap().to_string();
        let threads = app.db(|d| d.list_threads()).unwrap().len();

        // A wrong code, the right code from a group, and a stranger saying hello: none pairs.
        mock.message(222, 222, "private", Some("/pair WRONGCODE"));
        mock.message(-500, ME, "group", Some(&format!("/pair {code}")));
        mock.message(333, 333, "private", Some("hello, who are you?"));
        mock.message(333, 333, "private", Some("hello again"));
        until("private replies", 10, || mock.texts_to(222).len() == 1 && mock.texts_to(333).len() == 1 && mock.texts_to(-500).len() == 1).await;
        assert_eq!(mock.texts_to(222), vec![PRIVATE.to_string()]);
        assert_eq!(mock.texts_to(333), vec![PRIVATE.to_string()], "told once, not twice");
        assert_eq!(paired_chat(&app), None);
        // The group saw the code: it was replaced? Not yet (2 wrong of 5), but it still can't pair from there.

        // The right code from the user's own chat pairs it.
        let code = app.phone.status(&app)["code"].as_str().unwrap().to_string();
        mock.message(ME, ME, "private", Some(&format!("/pair@dunebot_test_bot {}", code.to_lowercase())));
        until("pairing", 10, || paired_chat(&app) == Some(ME)).await;
        let st = app.phone.status(&app);
        assert_eq!(st["paired"]["name"], json!("Sai (@sai_test)"));
        assert!(st["code"].is_null(), "no code once paired");

        // A second chat with the old code is ignored; the pairing stays.
        mock.message(444, 444, "private", Some(&format!("/pair {code}")));
        until("the second chat's reply", 10, || mock.texts_to(444).len() == 1).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(mock.texts_to(444), vec![PRIVATE.to_string()]);
        assert_eq!(paired_chat(&app), Some(ME));
        // Strangers started no chat, and nothing they said was kept.
        assert_eq!(app.db(|d| d.list_threads()).unwrap().len(), threads);
        assert!(app.db(|d| d.search_messages(&["hello".into()], 0, "", 10)).unwrap().is_empty());

        // Five wrong codes (after unpairing) replace the code.
        app.phone.unpair(&app);
        let code = app.phone.status(&app)["code"].as_str().unwrap().to_string();
        for i in 0..5 {
            mock.message(600 + i, 600 + i, "private", Some("/pair AAAAAAAA"));
        }
        until("a new code", 10, || app.phone.status(&app)["code"].as_str() != Some(code.as_str())).await;
        mock.message(ME, ME, "private", Some(&format!("/pair {code}")));
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(paired_chat(&app), None, "the replaced code no longer pairs");
        done(&app, &dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_message_is_a_phone_turn_and_the_answer_goes_back() {
        let (app, mock, dir) = paired("turn").await;
        let got = ask(&app, &mock, "hello from my phone").await;
        let id = setting(&app, THREAD).unwrap();
        let thread = app.db(|d| d.get_thread(&id)).unwrap();
        assert_eq!(thread.title, "Phone");
        assert_eq!(crate::asked::origin(&thread.id), Origin::Phone);
        let msgs = app.db(|d| d.messages(&thread.id)).unwrap();
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].text, "hello from my phone", "the user's words as written");
        assert_eq!(got.len(), 1, "{got:?}");
        assert!(got[0].starts_with("Echo: hello from my phone"), "{got:?}");

        // A long answer comes back in parts, each within Telegram's limit, all of it.
        let lines: Vec<String> = (0..110).map(|i| format!("line{i:03}-{}", "x".repeat(72))).collect();
        let got = ask(&app, &mock, &lines.join("\n")).await;
        assert!(got.len() >= 3, "{} parts", got.len());
        assert!(got.iter().all(|p| p.chars().map(char::len_utf16).sum::<usize>() <= 4096));
        let all = got.join("\n");
        assert!(lines.iter().all(|l| all.contains(l.as_str())), "every line arrived");

        // Voice notes: only text works for now. Old messages aren't run.
        mock.message(ME, ME, "private", None);
        until("the text-only reply", 10, || mock.texts_to(ME).last().map(String::as_str) == Some(ONLY_TEXT)).await;
        mock.push("message", json!({
            "message_id": 9, "date": chrono::Utc::now().timestamp() - 3600,
            "chat": { "id": ME, "type": "private" }, "from": { "id": ME, "is_bot": false, "first_name": "Sai" }, "text": "run rm -rf ~",
        }));
        until("the stale reply", 10, || mock.texts_to(ME).last().map(String::as_str) == Some(STALE)).await;
        done(&app, &dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_phone_cant_act_on_the_computer_by_default() {
        let (app, mock, dir) = paired("strict").await;
        // Outside Dune Bot's own folder (its tools never touch that).
        let elsewhere = std::env::temp_dir().join(format!("dunebot-phone-files-{}", crate::app::new_id()));
        std::fs::create_dir_all(&elsewhere).unwrap();
        let file = elsewhere.join("from-phone.txt");
        // Permissions say Always for these at the computer: from the phone they're still refused.
        app.set_mode("run-command", "always").unwrap();
        for text in ["look", "type hello", "keys cmd+t", "run echo phone-should-not-run", &format!("write {}\nnope", file.display())] {
            let got = ask(&app, &mock, text).await;
            assert!(got.iter().any(|t| t.contains("doesn't look at the screen, click, type, run commands, change files or send or change anything in their accounts")), "{text}: {got:?}");
        }
        // A click, with a picture of the screen already taken: refused at the gate too.
        let t = setting(&app, THREAD).unwrap();
        app.shots.lock().unwrap().insert(t.clone(), crate::tools::Shot { x: 0.0, y: 0.0, width: 100.0, height: 100.0, scale: 1.0, at: Instant::now() });
        let got = ask(&app, &mock, "click 10 10 the button").await;
        assert!(got.iter().any(|t| t.contains("doesn't look at the screen")), "{got:?}");
        assert!(!file.exists());
        // Reads too ("Read my files from my phone" is off): a file, a folder, past chats, the place.
        // Permissions say Always for all four at the computer.
        let note = elsewhere.join("note.txt");
        std::fs::write(&note, "secret-from-the-computer").unwrap();
        for text in [format!("read {}", note.display()), format!("ls {}", elsewhere.display()), "search hello".into(), "where".into()] {
            let got = ask(&app, &mock, &text).await;
            assert!(got.iter().any(|t| t.contains("doesn't read files, look inside folders, search past chats or find where the computer is")), "{text}: {got:?}");
            assert!(got.iter().all(|t| !t.contains("secret-from-the-computer")), "{text}: {got:?}");
        }
        let msgs = app.db(|d| d.messages(&t)).unwrap();
        assert!(msgs.iter().all(|m| m.role != "approval"), "nothing even asked");
        let ledger = app.db(|d| d.ledger_list(50)).unwrap();
        let blocked: Vec<&str> = ledger.iter().filter(|r| r.decision == "blocked (from your phone)").map(|r| r.action.as_str()).collect();
        for a in ["look-screen", "type", "run-command", "write-file", "click", "read-file", "list-folder", "search-chats", "find-location"] {
            assert!(blocked.contains(&a), "{a} in {blocked:?}");
        }
        // At the computer, the same chat still runs it (Always).
        let r = agent::send(app.clone(), &t, "run echo at-the-computer", false, Origin::User).await;
        assert!(r.is_ok());
        until("the computer's turn", 10, || !app.busy.lock().unwrap().contains(&t)).await;
        assert!(app.db(|d| d.ledger_list(5)).unwrap().iter().any(|r| r.decision == "allowed (always)"));

        // Something no phone switch covers (the teaching ring) set to Ask still asks, but only the
        // computer can answer it.
        app.set_mode("point", "ask").unwrap();
        app.shots.lock().unwrap().insert(t.clone(), crate::tools::Shot { x: 0.0, y: 0.0, width: 100.0, height: 100.0, scale: 1.0, at: Instant::now() });
        mock.message(ME, ME, "private", Some("point 10 10 20 20 the button"));
        until("the card on the phone", 10, || mock.texts_to(ME).iter().any(|t| t.contains("Point at things"))).await;
        let card = mock.sent().into_iter().rev().find(|(m, b)| m == "sendMessage" && b["text"].as_str().is_some_and(|t| t.contains("Point at things"))).unwrap().1;
        assert!(card.get("reply_markup").is_none() && card["text"].as_str().unwrap().ends_with("This needs your OK at the computer."), "{card}");
        let pending = app.db(|d| d.messages(&t)).unwrap().into_iter().rev().find(|m| m.role == "approval").unwrap();
        let id = pending.meta["approvalId"].as_str().unwrap().to_string();
        tokio::time::sleep(Duration::from_millis(600)).await;
        mock.tap(ME, ME, &format!("y:{id}"));
        until("the tap's answer", 10, || mock.sent().iter().any(|(m, _)| m == "answerCallbackQuery")).await;
        let said = mock.sent().into_iter().find(|(m, _)| m == "answerCallbackQuery").unwrap().1;
        assert_eq!(said["text"], json!("That's no longer waiting."));
        assert!(app.busy.lock().unwrap().contains(&t), "still waiting for the computer");
        app.respond(&id, "deny").unwrap();
        until("the turn to end", 20, || !app.busy.lock().unwrap().contains(&t)).await;
        let _ = std::fs::remove_dir_all(&elsewhere);
        done(&app, &dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_turn_s_relay_stops_where_the_next_turn_starts() {
        // A message sent the moment a turn ends starts the next before that turn's watch sees the
        // chat idle: that watch must not send the next turn's words too (the phone got everything
        // twice, two cards for one OK).
        let (app, mock, dir) = paired("relay").await;
        let t = app.create_thread(crate::agent::ECHO, "Phone", Some("~")).unwrap();
        let first = app.add_message(&t.id, "user", "one", json!({})).unwrap();
        app.add_message(&t.id, "assistant", "answer one", json!({})).unwrap();
        app.add_message(&t.id, "user", "two", json!({})).unwrap();
        app.add_message(&t.id, "assistant", "answer two", json!({})).unwrap();
        let mut relay = Relay::default();
        let over = relay.pass(&app, &t.id, &first.id, ME, true);
        assert!(over, "a newer message means this turn is over");
        until("the first answer", 5, || mock.texts_to(ME).iter().any(|x| x == "answer one")).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!mock.texts_to(ME).iter().any(|x| x == "answer two"), "{:?}", mock.texts_to(ME));
        done(&app, &dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn with_actions_on_each_one_asks_and_the_phone_can_say_yes() {
        let (app, mock, dir) = paired("actions").await;
        app.phone.set_switch(&app, "actions", true).unwrap();
        app.set_mode("run-command", "always").unwrap();
        let before = mock.texts_to(ME).len();
        mock.message(ME, ME, "private", Some("run echo phone-said-yes"));
        until("the card on the phone", 10, || mock.sent().iter().any(|(m, b)| m == "sendMessage" && b["reply_markup"].is_object())).await;
        let card = mock.sent().into_iter().find(|(m, b)| m == "sendMessage" && b["reply_markup"].is_object()).unwrap().1;
        let text = card["text"].as_str().unwrap();
        assert!(text.contains("Run a command") && text.contains("echo phone-said-yes") && text.contains("from your phone"), "{text}");
        let data = card["reply_markup"]["inline_keyboard"][0][0]["callback_data"].as_str().unwrap().to_string();
        assert!(data.starts_with("y:"));
        // "On it." went first, before the card.
        assert!(mock.texts_to(ME)[before..].first().is_some_and(|t| t.starts_with("On it.")));

        // A tap from someone else is ignored; a tap too soon is refused; the user's Yes runs it.
        mock.tap(333, 333, &data);
        mock.tap(ME, ME, &data);
        until("the too-soon answer", 10, || mock.sent().iter().any(|(m, b)| m == "answerCallbackQuery" && b["text"].as_str().is_some_and(|t| t.starts_with("Too soon")))).await;
        tokio::time::sleep(Duration::from_millis(600)).await;
        mock.tap(ME, ME, &data);
        let t = setting(&app, THREAD).unwrap();
        until("the turn to end", 20, || !app.busy.lock().unwrap().contains(&t)).await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        let got = mock.texts_to(ME)[before..].to_vec();
        assert!(got.iter().any(|t| t.contains("phone-said-yes") && t.starts_with("Done.")), "{got:?}");
        assert!(mock.sent().iter().any(|(m, b)| m == "editMessageText" && b["text"].as_str().is_some_and(|t| t.ends_with("Allowed.")) && b.get("reply_markup").is_none()));
        assert_eq!(mock.sent().iter().filter(|(m, _)| m == "answerCallbackQuery").count(), 2, "the stranger's tap got nothing");
        let ledger = app.db(|d| d.ledger_list(20)).unwrap();
        assert!(ledger.iter().any(|r| r.decision == "Yes from your phone"));
        assert!(ledger.iter().any(|r| r.decision == "approved once" && r.detail.contains("asked because it came from your phone")));

        // "For this chat" at the computer doesn't carry over to the next phone turn.
        mock.message(ME, ME, "private", Some("run echo second"));
        let card_count = |m: &Mock| m.sent().iter().filter(|(m, b)| m == "sendMessage" && b["reply_markup"].is_object()).count();
        until("the second card", 10, || card_count(&mock) == 2).await;
        tokio::time::sleep(Duration::from_millis(600)).await;
        let pending = app.db(|d| d.messages(&t)).unwrap().into_iter().rev().find(|m| m.role == "approval").unwrap();
        app.respond(pending.meta["approvalId"].as_str().unwrap(), "chat").unwrap();
        until("the turn to end", 20, || !app.busy.lock().unwrap().contains(&t)).await;
        mock.message(ME, ME, "private", Some("run echo third"));
        until("a third card", 10, || card_count(&mock) == 3).await;
        // And No declines it.
        let third = mock.sent().into_iter().filter(|(m, b)| m == "sendMessage" && b["reply_markup"].is_object()).last().unwrap().1;
        tokio::time::sleep(Duration::from_millis(600)).await;
        mock.tap(ME, ME, third["reply_markup"]["inline_keyboard"][0][1]["callback_data"].as_str().unwrap());
        until("the turn to end", 20, || !app.busy.lock().unwrap().contains(&t)).await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(mock.sent().iter().any(|(m, b)| m == "editMessageText" && b["text"].as_str().is_some_and(|t| t.ends_with("Declined."))));
        done(&app, &dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn reads_need_their_own_switch_then_each_asks_and_the_phone_can_answer() {
        let (app, mock, dir) = paired("files").await;
        let elsewhere = std::env::temp_dir().join(format!("dunebot-phone-reads-{}", crate::app::new_id()));
        std::fs::create_dir_all(&elsewhere).unwrap();
        let note = elsewhere.join("note.txt");
        std::fs::write(&note, "hello-from-the-computer").unwrap();
        let read = format!("read {}", note.display());
        // "Let my phone run actions" doesn't open reads.
        app.phone.set_switch(&app, "actions", true).unwrap();
        let got = ask(&app, &mock, &read).await;
        assert!(got.iter().any(|t| t.contains("doesn't read files")), "{got:?}");
        assert!(got.iter().all(|t| !t.contains("hello-from-the-computer")), "{got:?}");
        let t = setting(&app, THREAD).unwrap();

        // Their own switch does: each read asks (Permissions say Always), with Yes and No on the phone.
        app.phone.set_switch(&app, "files", true).unwrap();
        assert_eq!(app.phone.status(&app)["files"], json!(true));
        assert_eq!(app.phone.status(&app)["actions"], json!(true));
        let cards = |m: &Mock| m.sent().into_iter().filter(|(m, b)| m == "sendMessage" && b["reply_markup"].is_object()).map(|(_, b)| b).collect::<Vec<_>>();
        mock.message(ME, ME, "private", Some(&read));
        until("the card on the phone", 10, || cards(&mock).len() == 1).await;
        let card = cards(&mock).remove(0);
        let text = card["text"].as_str().unwrap();
        assert!(text.contains("Read a file") && text.contains("note.txt") && text.contains("from your phone"), "{text}");
        tokio::time::sleep(Duration::from_millis(600)).await;
        mock.tap(ME, ME, card["reply_markup"]["inline_keyboard"][0][0]["callback_data"].as_str().unwrap());
        until("the turn to end", 20, || !app.busy.lock().unwrap().contains(&t)).await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(mock.texts_to(ME).iter().any(|t| t.contains("hello-from-the-computer")), "the phone's Yes read it");

        // The next read asks again ("for this chat" at the computer doesn't carry over), and No declines.
        mock.message(ME, ME, "private", Some(&format!("ls {}", elsewhere.display())));
        until("the second card", 10, || cards(&mock).len() == 2).await;
        let second = cards(&mock).remove(1);
        assert!(second["text"].as_str().unwrap().contains("from your phone"), "{second}");
        tokio::time::sleep(Duration::from_millis(600)).await;
        mock.tap(ME, ME, second["reply_markup"]["inline_keyboard"][0][1]["callback_data"].as_str().unwrap());
        until("the turn to end", 20, || !app.busy.lock().unwrap().contains(&t)).await;
        let ledger = app.db(|d| d.ledger_list(30)).unwrap();
        assert!(ledger.iter().any(|r| r.action == "read-file" && r.decision == "approved once" && r.detail.contains("asked because it came from your phone")));
        assert!(ledger.iter().any(|r| r.action == "list-folder" && r.decision == "declined"));
        assert!(ledger.iter().any(|r| r.action == "settings" && r.target == "phone: read files" && r.decision == "on"));

        // Off again: refused again.
        app.phone.set_switch(&app, "files", false).unwrap();
        let got = ask(&app, &mock, &read).await;
        assert!(got.iter().any(|t| t.contains("doesn't read files")), "{got:?}");
        let _ = std::fs::remove_dir_all(&elsewhere);
        done(&app, &dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_phone_changes_nothing_in_an_account_unless_actions_are_on() {
        use crate::policy::Action;
        let (app, mock, _dir) = paired("account-changes").await;
        crate::protocol::handle(&app, "phone.set", &json!({ "key": "reads", "on": true })).await.unwrap();
        ask(&app, &mock, "post on slack and on X that we shipped").await;
        let t = setting(&app, THREAD).unwrap();
        for (a, key) in [(Action::SlackWrite, "slack-write"), (Action::XPost, "x-post")] {
            app.set_mode(key, "always").unwrap();
            // Permissions say Always, and the account was named: still refused from the phone.
            let no = app.gate(&t, a, "#general", "we shipped").await.unwrap_err();
            assert_eq!(no, REFUSED, "{key}");
        }
        assert!(app.db(|d| d.ledger_list(20)).unwrap().iter().any(|l| l.action == "slack-write" && l.decision == "blocked (from your phone)"));
        assert!(!app.db(|d| d.ledger_list(20)).unwrap().iter().any(|l| l.action == "slack-write" && l.decision.starts_with("allowed")));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_phone_reads_accounts_only_when_turned_on_and_named() {
        let (app, mock, dir) = paired("reads").await;
        ask(&app, &mock, "what's on my calendar today?").await;
        let t = setting(&app, THREAD).unwrap();
        let no = crate::asked::check(&app, &t, Source::Calendar).unwrap_err();
        assert!(no.contains("from your phone is off"), "{no}");
        // Turned on in Settings › Phone (as the page does it): the named account may be read, no other.
        let switch = |on: bool| {
            let app = app.clone();
            async move { crate::protocol::handle(&app, "phone.set", &json!({ "key": "reads", "on": on })).await }
        };
        assert_eq!(switch(true).await.unwrap()["reads"], json!(true));
        assert!(crate::asked::check(&app, &t, Source::Calendar).is_ok());
        let no = crate::asked::check(&app, &t, Source::Gmail).unwrap_err();
        assert!(no.contains("hasn't asked for their Gmail in this conversation"), "{no}");
        // Named earlier in this Phone chat: a later phone message may read it too.
        ask(&app, &mock, "and now summarise the second one").await;
        assert!(crate::asked::check(&app, &t, Source::Calendar).is_ok());
        // Turned off: the phone never reads, named or not.
        switch(false).await.unwrap();
        assert!(crate::asked::check(&app, &t, Source::Calendar).unwrap_err().contains("from your phone is off"));
        // A new Phone chat (/new) starts with nothing named.
        switch(true).await.unwrap();
        mock.message(ME, ME, "private", Some("/new"));
        until("the new-chat reply", 10, || mock.texts_to(ME).last().is_some_and(|t| t.starts_with("New chat"))).await;
        ask(&app, &mock, "summarise the second one").await;
        let t2 = setting(&app, THREAD).unwrap();
        assert_ne!(t, t2);
        assert!(crate::asked::check(&app, &t2, Source::Calendar).is_err());
        done(&app, &dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_token_is_never_in_an_error_or_the_status() {
        // A server that doesn't know this token answers with the path, token and all.
        let (app, _mock, dir) = rig("token").await;
        let (other, url) = mock_server("999999999:AAAnotherTokenEntirelyDifferent_012345").await;
        *app.phone.base.lock().unwrap() = url;
        app.phone.set_token(&app, Some(TOKEN.into())).unwrap();
        let err = app.phone.api("getMe", &json!({}), Duration::from_secs(5)).err().unwrap();
        assert_eq!(err.code, 200, "the mock answers 200 with ok: false");
        assert!(err.msg.contains("Unauthorized") && !err.msg.contains(TOKEN) && !err.msg.contains("AAFakeToken"), "{}", err.msg);
        // Nothing listening: the transport error is redacted too.
        *app.phone.base.lock().unwrap() = "http://127.0.0.1:9".into();
        let err = app.phone.api("getUpdates", &json!({}), Duration::from_secs(5)).err().unwrap();
        assert!(!err.msg.contains("AAFakeToken"), "{}", err.msg);
        until("a problem shown", 15, || app.phone.status(&app)["problem"].is_string()).await;
        let st = app.phone.status(&app).to_string();
        assert!(!st.contains("AAFakeToken"), "{st}");
        assert!(other.calls.lock().unwrap().is_empty());
        // A bad token is refused without repeating it.
        let e = app.phone.set_token(&app, Some("not-a-token-AAFakeToken".into())).unwrap_err().to_string();
        assert!(!e.contains("AAFakeToken"), "{e}");
        // Taking the token back unpairs and stops the code.
        app.phone.set_token(&app, None).unwrap();
        let st = app.phone.status(&app);
        assert_eq!(st["token"], json!(false));
        assert!(st["code"].is_null());
        done(&app, &dir);
    }
}
