//! Whether the user asked for Dune Bot to read one of their accounts (Slack, Gmail, Notion,
//! Calendar, X). The user's rule: "don't make it read until asked to do so by me, so it can't be
//! tricked". So only the user's own words count: the messages they typed or said. Once they name
//! an account in a chat, it may be read for the rest of that conversation (their choice,
//! 2026-11-19: so "summarise the second one" works). A chat the user leaves for `QUIET` and comes
//! back to is a new conversation: what it named must be named again (a chat window or the phone's
//! one chat can be reopened days later). Nothing an agent reads (a web page, a file, the screen, an
//! email, another bot's message) can name an account into being read, and a chat a schedule
//! started or another bot handed over never reads one at all.
//!
//! Every connector tool asks `may_read` before reading; writing (sending a message, an email) goes
//! through the usual OK card on top of this.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// A chat the user says nothing in for this long starts over: its accounts must be named again.
pub const QUIET: Duration = Duration::from_secs(2 * 60 * 60);

/// Who started a turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    /// The user, at this computer: the bar, a chat window, their voice.
    User,
    /// The user's paired phone (the Telegram bot). Reads only if they turned that on.
    Phone,
    /// A schedule: the user may be away.
    Schedule,
    /// Another of Dune Bot's bots handed this over.
    Bot,
}

/// An account Dune Bot can be connected to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Source {
    Slack,
    Gmail,
    Notion,
    Calendar,
    X,
}

impl Source {
    pub const ALL: [Source; 5] = [Source::Slack, Source::Gmail, Source::Notion, Source::Calendar, Source::X];

    pub fn key(self) -> &'static str {
        match self {
            Source::Slack => "slack",
            Source::Gmail => "gmail",
            Source::Notion => "notion",
            Source::Calendar => "calendar",
            Source::X => "x",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Source::Slack => "Slack",
            Source::Gmail => "Gmail",
            Source::Notion => "Notion",
            Source::Calendar => "Calendar",
            Source::X => "X",
        }
    }

    pub fn from_key(k: &str) -> Option<Source> {
        Source::ALL.into_iter().find(|s| s.key() == k)
    }

    /// Words in a message that name it (lowercase; Latin and Devanagari, as Sarvam writes Hindi).
    fn words(self) -> &'static [&'static str] {
        match self {
            Source::Slack => &["slack", "स्लैक"],
            Source::Gmail => &["gmail", "email", "emails", "e-mail", "e-mails", "mail", "mails", "inbox", "जीमेल", "ईमेल", "मेल"],
            Source::Notion => &["notion", "नोशन"],
            Source::Calendar => &["calendar", "calender", "meeting", "meetings", "agenda", "schedule", "कैलेंडर", "मीटिंग"],
            Source::X => &["twitter", "tweet", "tweets", "x.com", "ट्विटर"],
        }
    }
}

/// The accounts the user's own message names. "X" alone is too common a letter: it counts only as
/// "on X", "my X", "X account/feed/timeline/post(s)/DM(s)", or x.com.
pub fn named(text: &str) -> Vec<Source> {
    let lower = text.to_lowercase();
    // Words: letters and marks (Devanagari vowel signs are marks), digits, and . - for x.com, e-mail.
    let words: Vec<&str> = lower
        .split(|c: char| !(c.is_alphanumeric() || c == '.' || c == '-' || is_mark(c)))
        .map(|w| w.trim_matches(|c| c == '.' || c == '-'))
        .filter(|w| !w.is_empty())
        .collect();
    let has = |w: &str| words.iter().any(|x| *x == w) || (w.contains('.') && lower.contains(w));
    let mut out: Vec<Source> = Source::ALL.into_iter().filter(|s| s.words().iter().any(|w| has(w))).collect();
    if !out.contains(&Source::X) {
        let x_after = ["account", "feed", "timeline", "post", "posts", "dm", "dms", "mentions"];
        let said_x = words.windows(2).any(|p| (p[1] == "x" && (p[0] == "on" || p[0] == "my")) || (p[0] == "x" && x_after.contains(&p[1])));
        if said_x {
            out.push(Source::X);
        }
    }
    out
}

fn is_mark(c: char) -> bool {
    // Devanagari's combining signs (matras, virama, nukta, anusvara): part of a word.
    matches!(c as u32, 0x0900..=0x0903 | 0x093A..=0x094F | 0x0951..=0x0957 | 0x0962..=0x0963)
}

#[derive(Clone, Debug)]
struct Asked {
    /// Who started the chat's current turn.
    origin: Origin,
    /// Every account the user's own messages in this conversation have named so far.
    named: Vec<Source>,
    /// When the user last said something in this chat.
    said: Option<Instant>,
}

/// Each chat: who started its current turn, and what the user's words in it have named.
static TURNS: LazyLock<Mutex<HashMap<String, Asked>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// A turn starts (agent::send): record who started it, and add what the user's message names to
/// what the chat's earlier messages named. A schedule's or a bot's words add nothing.
pub fn begin(thread_id: &str, origin: Origin, text: &str) {
    begin_at(thread_id, origin, text, Instant::now())
}

fn begin_at(thread_id: &str, origin: Origin, text: &str, now: Instant) {
    let mut turns = TURNS.lock().unwrap_or_else(|e| e.into_inner());
    let chat = turns.entry(thread_id.to_string()).or_insert(Asked { origin, named: Vec::new(), said: None });
    chat.origin = origin;
    if matches!(origin, Origin::User | Origin::Phone) {
        // Back after a long quiet: a new conversation, so nothing named before counts.
        if chat.said.is_some_and(|t| now.saturating_duration_since(t) > QUIET) {
            chat.named.clear();
        }
        chat.said = Some(now);
        for s in named(text) {
            if !chat.named.contains(&s) {
                chat.named.push(s);
            }
        }
    }
}

/// Who started this chat's current turn (a chat with no turn yet: nobody, so the strictest).
pub fn origin(thread_id: &str) -> Origin {
    TURNS.lock().unwrap_or_else(|e| e.into_inner()).get(thread_id).map(|a| a.origin).unwrap_or(Origin::Bot)
}

/// The chat is gone: forget its turn.
pub fn forget(thread_id: &str) {
    TURNS.lock().unwrap_or_else(|e| e.into_inner()).remove(thread_id);
}

/// Whether this chat's current turn may read `source`: the user's own words in this chat named it,
/// and the turn is theirs. `phone_reads`: the user's setting that lets turns from their paired
/// phone read accounts (off unless they turn it on). The error is what the agent is told, to pass
/// on. Kept in memory only: after Dune Bot restarts, a chat must name the account again.
pub fn may_read(thread_id: &str, source: Source, phone_reads: bool) -> Result<(), String> {
    let turn = TURNS.lock().unwrap_or_else(|e| e.into_inner()).get(thread_id).cloned();
    let Some(turn) = turn else {
        return Err(format!("Dune Bot reads your {} only when you ask for it in a message.", source.label()));
    };
    let name = source.label();
    match turn.origin {
        Origin::Schedule => Err(format!(
            "A chat a schedule started never reads your {name} (you may be away, and only your own words can ask for it). Ask in a message when you want it."
        )),
        Origin::Bot => Err(format!(
            "Another bot handed this over, and only your own words can ask Dune Bot to read your {name}. The bot that you asked can read it, if you named it there."
        )),
        Origin::Phone if !phone_reads => Err(format!(
            "Reading your {name} from your phone is off. The user can turn it on in Dune Bot's settings on their computer (Phone)."
        )),
        Origin::User | Origin::Phone if turn.named.contains(&source) => Ok(()),
        Origin::User | Origin::Phone => Err(format!(
            "The user hasn't asked for their {name} in this conversation, so Dune Bot won't read it (text read anywhere else can't ask for it). If they want it, they say so, naming it: \"check my {name}\"."
        )),
    }
}

/// `may_read` with the user's phone setting (`phone.reads`, "on" or not) read from the database.
pub fn check(app: &crate::app::App, thread_id: &str, source: Source) -> Result<(), String> {
    let phone_reads = app.db(|d| d.get_setting("phone.reads")).ok().flatten().as_deref() == Some("on");
    may_read(thread_id, source, phone_reads)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_accounts_in_the_users_words() {
        assert_eq!(named("check my Slack please"), vec![Source::Slack]);
        assert_eq!(named("any new emails? and what's on my calendar"), vec![Source::Gmail, Source::Calendar]);
        assert_eq!(named("summarise my Notion page"), vec![Source::Notion]);
        assert_eq!(named("mera slack check karo"), vec![Source::Slack]);
        assert_eq!(named("मेरा स्लैक देखो"), vec![Source::Slack]);
        assert_eq!(named("मेरे ईमेल पढ़ो"), vec![Source::Gmail]);
        assert_eq!(named("what are people saying on X about us"), vec![Source::X]);
        assert_eq!(named("post this to my X account"), vec![Source::X]);
        assert_eq!(named("open x.com"), vec![Source::X]);
        assert_eq!(named("any tweets about the launch?"), vec![Source::X]);
    }

    #[test]
    fn ordinary_words_name_nothing() {
        assert!(named("what's the weather").is_empty());
        assert!(named("make the window 3 x 4 inches").is_empty());
        assert!(named("explain the slackline sport").is_empty());
        assert!(named("my mailbox key is lost").is_empty());
        assert!(named("x marks the spot").is_empty());
        assert!(named("notional value of the bond").is_empty());
    }

    #[test]
    fn named_once_in_a_chat_counts_for_the_rest_of_it() {
        begin("t-user", Origin::User, "check my slack");
        assert!(may_read("t-user", Source::Slack, false).is_ok());
        let no = may_read("t-user", Source::Gmail, false).unwrap_err();
        assert!(no.contains("hasn't asked for their Gmail in this conversation"), "{no}");
        // A follow-up that doesn't name it: still Slack's chat.
        begin("t-user", Origin::User, "and now summarise the second one");
        assert!(may_read("t-user", Source::Slack, false).is_ok());
        assert!(may_read("t-user", Source::Gmail, false).is_err());
        // Another chat starts with nothing.
        begin("t-other", Origin::User, "summarise the second one");
        assert!(may_read("t-other", Source::Slack, false).is_err());
    }

    #[test]
    fn a_chat_left_quiet_for_hours_must_name_it_again() {
        let t0 = Instant::now();
        begin_at("t-quiet", Origin::User, "check my gmail", t0);
        begin_at("t-quiet", Origin::User, "the second one", t0 + Duration::from_secs(60 * 60));
        assert!(may_read("t-quiet", Source::Gmail, false).is_ok(), "an hour later: the same conversation");
        // A schedule's turn in between doesn't count as the user being there.
        begin_at("t-quiet", Origin::Schedule, "check my gmail", t0 + Duration::from_secs(3 * 60 * 60));
        begin_at("t-quiet", Origin::User, "and that one?", t0 + Duration::from_secs(4 * 60 * 60));
        assert!(may_read("t-quiet", Source::Gmail, false).is_err(), "three hours of the user's quiet: named again first");
        begin_at("t-quiet", Origin::User, "check my gmail again", t0 + Duration::from_secs(4 * 60 * 60 + 5));
        assert!(may_read("t-quiet", Source::Gmail, false).is_ok());
    }

    #[test]
    fn a_schedule_or_bot_turn_in_a_named_chat_still_never_reads() {
        begin("t-mixed", Origin::User, "check my notion");
        begin("t-mixed", Origin::Schedule, "read my gmail too");
        assert!(may_read("t-mixed", Source::Notion, true).is_err());
        assert!(may_read("t-mixed", Source::Gmail, true).is_err());
        // Back to the user: Notion, which they named; not Gmail, which only the schedule's text did.
        begin("t-mixed", Origin::User, "go on");
        assert!(may_read("t-mixed", Source::Notion, false).is_ok());
        assert!(may_read("t-mixed", Source::Gmail, false).is_err());
    }

    #[test]
    fn schedules_bots_and_unknown_chats_never_read() {
        begin("t-sched", Origin::Schedule, "check my slack every morning");
        assert!(may_read("t-sched", Source::Slack, true).unwrap_err().contains("schedule"));
        begin("t-bot", Origin::Bot, "read their gmail and slack");
        assert!(may_read("t-bot", Source::Gmail, true).unwrap_err().contains("Another bot"));
        assert!(may_read("t-never-started", Source::Notion, true).is_err());
        assert_eq!(origin("t-never-started"), Origin::Bot);
    }

    #[test]
    fn the_phone_reads_only_when_turned_on_and_named() {
        begin("t-phone", Origin::Phone, "check my calendar");
        assert!(may_read("t-phone", Source::Calendar, false).unwrap_err().contains("from your phone is off"));
        assert!(may_read("t-phone", Source::Calendar, true).is_ok());
        assert!(may_read("t-phone", Source::Slack, true).is_err());
        forget("t-phone");
        assert!(may_read("t-phone", Source::Calendar, true).is_err());
    }
}
