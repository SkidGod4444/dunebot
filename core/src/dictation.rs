//! Dictation (macOS): hold Right ⌥ on its own and talk; let go, and what you said is typed into the
//! app in front, at its text cursor. It's never sent to an agent and nothing is read aloud.
//!
//! The keys are read like the chord's (keys.rs): by polling the modifier state and "time since the
//! last key/mouse press", so it needs no Input Monitoring permission and never sees what's typed. Right
//! ⌥ held alone past `keys::HOLD_MS` starts listening; another key or a click while it's held means it
//! was an ⌥ shortcut or a special character (⌥E, ⌥-click): cancelled, nothing typed. A quick tap does
//! nothing, and Left ⌥ never counts.
//!
//! The words are typed by the app (`App::input`, kind "type"), the same way and with the same refusals
//! as an agent's type_text: never into Dune Bot's own windows, and macOS's Accessibility asked for the
//! same way. What was said is never logged, only how long it was.
//!
//! Windows and Linux: off. Right Alt typed alone opens the menu bar in many apps when it's let go (a
//! poller can't swallow that, so the words would land in the menu), and it is AltGr on many layouts.
//! Wayland doesn't let apps see which keys are held at all.

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering::SeqCst},
};

use anyhow::bail;
use serde_json::{Value, json};

use crate::app::App;
use crate::keys::{self, Chord, Fire, OPT, Sample, State};

/// What a dictation's recording is started as (voice.rs): its words are typed, not sent.
pub const SOURCE: &str = "dictation";
/// Which ⌥ is down (IOLLEvent.h: NX_DEVICELALTKEYMASK, NX_DEVICERALTKEYMASK). If the system ever left
/// these out of the modifier state, dictation would simply never start, rather than start for either ⌥.
pub const LEFT_OPT: u64 = 0x20;
pub const RIGHT_OPT: u64 = 0x40;
/// Right ⌥ and nothing else.
pub const KEYS: Chord = Chord { mods: OPT, need: RIGHT_OPT, forbid: LEFT_OPT };
pub const LABEL: &str = "Right ⌥";
/// Settings › Keys and the menu bar's Keys: "on" (unset is on) or "off".
pub const PREF: &str = "dictation";
/// What a recording from `source` becomes (voice.rs): a dictation types English whatever you speak
/// (Hindi said, English typed: the user's choice, 2026-11-21); talking to Dune Bot keeps your words
/// as said. A dictation taken over by a hold to talk (`takes_over`) is talk's from then on.
pub fn words_for(source: &str) -> crate::sarvam::Words {
    if source == SOURCE { crate::sarvam::Words::English } else { crate::sarvam::Words::AsSaid }
}

/// Longer than a minute of speech ever is (a recording stops itself at 60 s).
const MAX_CHARS: usize = 4000;

static ON: AtomicBool = AtomicBool::new(true);
static WATCHING: AtomicBool = AtomicBool::new(false);

pub fn on() -> bool {
    ON.load(SeqCst)
}

/// Checks a pref value: "on" or "off".
pub fn check(value: &str) -> anyhow::Result<bool> {
    match value {
        "on" => Ok(true),
        "off" => Ok(false),
        _ => bail!("dictation is \"on\" or \"off\""),
    }
}

/// The pref was changed (Settings or the menu bar): takes effect at once, and the app is told.
pub fn set(app: &App, value: &str) {
    ON.store(value != "off", SeqCst);
    ready(app);
}

fn ready(app: &App) {
    app.out.event("dictation.ready", json!({ "available": WATCHING.load(SeqCst), "on": on(), "keys": LABEL }));
}

/// Starts watching Right ⌥ (the desktop app on macOS; never in tests) and tells the app.
pub fn start(app: &Arc<App>) {
    let saved = app.db(|d| d.get_setting(&format!("pref.{PREF}"))).ok().flatten();
    ON.store(saved.as_deref() != Some("off"), SeqCst);
    let out = app.out.clone();
    let watching = watch(move |fire| {
        if let Some(kind) = kind(fire) {
            out.event("dictation", json!({ "kind": kind }));
        }
    });
    WATCHING.store(watching, SeqCst);
    ready(app);
}

/// The event's `kind` for each firing; a tap is nothing.
pub fn kind(fire: Fire) -> Option<&'static str> {
    match fire {
        Fire::Tap => None,
        Fire::HoldStart => Some("hold-start"),
        Fire::HoldEnd => Some("hold-end"),
        Fire::HoldCancel => Some("hold-cancel"),
    }
}

/// One poll of the Right ⌥ detector: the chord's rules (keys::step) with Right ⌥ alone as the keys,
/// and a tap doing nothing.
pub fn step(state: State, s: Sample) -> (State, Option<Fire>) {
    let (next, fire) = keys::step(state, s, KEYS);
    (next, fire.filter(|f| *f != Fire::Tap))
}

/// Polls on its own thread (macOS only). `on_fire` runs on that thread.
#[cfg(target_os = "macos")]
fn watch(on_fire: impl Fn(Fire) + Send + 'static) -> bool {
    use std::time::Duration;
    std::thread::Builder::new()
        .name("dunebot-dictation".into())
        .spawn(move || {
            let start = std::time::Instant::now();
            let mut state = State::default();
            loop {
                let holding = matches!(state, State::Down { holding: true, .. });
                // Off: a hold under way ends without typing. While Dune Bot types or clicks (for an
                // agent, or what you just said), nothing new starts: what's held is part of its keys.
                if !on() || (keys::input_busy() && !holding) {
                    if holding && !on() {
                        on_fire(Fire::HoldCancel);
                    }
                    state = State::Spoiled;
                    std::thread::sleep(Duration::from_millis(if on() { 30 } else { 200 }));
                    continue;
                }
                let now = start.elapsed().as_millis() as u64;
                let (next, fire) = step(state, keys::mac::sample(now));
                state = next;
                if let Some(f) = fire {
                    on_fire(f);
                }
                // Quick while a modifier is down, relaxed otherwise.
                let ms = if matches!(state, State::Idle { .. }) { 30 } else { 12 };
                std::thread::sleep(Duration::from_millis(ms));
            }
        })
        .is_ok()
}

#[cfg(not(target_os = "macos"))]
fn watch(_on_fire: impl Fn(Fire) + Send + 'static) -> bool {
    false
}

/// Whether `voice::start`, asked for `asked` while the microphone already records for `current`, hands
/// the recording over. Talking takes over a dictation: its keys were the start of the chord (Right ⌥
/// held, then ⌘), so its late cancel must not stop the hold to talk, and what's said goes to the bar,
/// not typed. Dictation never takes over another recording: it carries on, and dictation's own stop
/// and cancel leave it alone (nothing is typed).
pub fn takes_over(current: &str, asked: &str) -> bool {
    current == SOURCE && asked != SOURCE
}

/// What was said, from voice.rs once the recording is text: typed where the text cursor is. Says
/// "typing" before it returns, so the card stays up until it's done.
pub fn heard(app: &Arc<App>, text: String, note: Option<&str>) {
    let text: String = text.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string();
    if text.is_empty() {
        app.out.event("dictation.state", json!({ "state": "nothing", "message": nothing_note(note) }));
        return;
    }
    let n = text.chars().count();
    if n > MAX_CHARS {
        app.out.event("dictation.state", json!({ "state": "refused", "message": "Nothing typed: that was too long to type at once." }));
        return;
    }
    app.out.event("dictation.state", json!({ "state": "typing", "chars": n }));
    let app = app.clone();
    tokio::spawn(async move {
        // The app answers when it's done, or with why it couldn't (said in an agent's words: the card
        // gets one sentence for a person instead).
        let state = match app.input(json!({ "kind": "type", "text": text, "at_once": true }), 20 + n as u64 / 4).await {
            Ok(_) => json!({ "state": "typed", "chars": n }),
            Err(e) => json!({ "state": "refused", "chars": n, "message": refusal(&e) }),
        };
        app.out.event("dictation.state", state);
    });
}

/// Nothing to type: the transcriber's note, in dictation's words.
fn nothing_note(note: Option<&str>) -> String {
    match note {
        Some("Hold the keys while you talk.") => format!("Hold {LABEL} while you talk."),
        None | Some("Didn't catch that.") => format!("Didn't catch that. Hold {LABEL} and try again."),
        Some(other) => other.to_string(),
    }
}

/// One short sentence for the card from why the app didn't type (electron/input.mjs, main.mjs).
pub fn refusal(err: &str) -> String {
    let has = |s: &str| err.contains(s);
    let said = if has("never types into itself") {
        "Nothing typed: Dune Bot never types into its own windows, so click where the words go first."
    } else if has("Accessibility") {
        "Nothing typed: turn Dune Bot on in System Settings › Accessibility (open now), then try again."
    } else if has("Wayland") {
        "Nothing typed: this Linux desktop (Wayland) doesn't let apps type into other apps."
    } else if has("administrator") {
        "Nothing typed: that app runs as administrator, and Windows doesn't let other apps type into it."
    } else if has("keyboard layout") {
        "Nothing typed: the keyboard layout in use has no key for some of those letters."
    } else if has("moved the mouse") {
        "Typing stopped partway because the mouse moved."
    } else if has("off in this test run") {
        "Nothing typed: the keyboard is off in this test run."
    } else if has("isn't available on this system") || has("couldn't reach this computer's mouse and keyboard") {
        "Nothing typed: typing for you isn't available on this computer."
    } else {
        "Dune Bot couldn't type what you said."
    };
    said.to_string()
}

/// The app's calls (never a window's: main.mjs doesn't let pages make them).
pub async fn handle(app: &Arc<App>, method: &str, p: &Value) -> anyhow::Result<Value> {
    match method {
        // Right ⌥ let go: what was said is typed. Only a dictation's own recording is stopped.
        "dictation.stop" => crate::voice::stop_from(app, SOURCE),
        // Right ⌥ was part of a shortcut: nothing is typed. Only a dictation's own recording.
        "dictation.cancel" => crate::voice::cancel_from(app, SOURCE),
        // Tests only (DUNEBOT_DICTATION_TEST=1): words as if just said, with no microphone.
        "dictation.feed" => {
            if std::env::var("DUNEBOT_DICTATION_TEST").as_deref() != Ok("1") {
                bail!("dictation.feed is for tests only");
            }
            let text = p.get("text").and_then(Value::as_str).unwrap_or("").to_string();
            heard(app, text, None);
        }
        _ => bail!("unknown method \"{method}\""),
    }
    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{CMD, CTRL, SHIFT};

    const LONG: u64 = 1_000_000;
    const RIGHT: u64 = OPT | RIGHT_OPT;
    const LEFT: u64 = OPT | LEFT_OPT;

    #[test]
    fn dictation_types_english_and_talk_keeps_your_words() {
        use crate::sarvam::Words;
        assert_eq!(words_for(SOURCE), Words::English);
        assert_eq!(words_for(SOURCE).mode(), "translate");
        for talk in ["chord", "button", "bar", ""] {
            assert_eq!(words_for(talk), Words::AsSaid, "{talk}");
            assert_eq!(words_for(talk).mode(), "codemix", "{talk}");
        }
    }

    /// Runs samples (time ms, flags, ms since last key, ms since last click) and collects what fired.
    fn run(samples: &[(u64, u64, u64, u64)]) -> Vec<Fire> {
        let mut state = State::default();
        let mut out = vec![];
        for &(now, flags, since_key, since_mouse) in samples {
            let (next, fire) = step(state, Sample { now, flags, since_key, since_mouse });
            state = next;
            out.extend(fire);
        }
        out
    }

    #[test]
    fn right_option_held_alone_starts_and_stops() {
        let fired = run(&[(0, 0, LONG, LONG), (20, RIGHT, LONG, LONG), (200, RIGHT, LONG, LONG), (330, RIGHT, LONG, LONG), (2000, RIGHT, LONG, LONG), (2020, 0, LONG, LONG)]);
        assert_eq!(fired, vec![Fire::HoldStart, Fire::HoldEnd]);
        assert_eq!(fired.iter().map(|f| kind(*f)).collect::<Vec<_>>(), vec![Some("hold-start"), Some("hold-end")]);
    }

    #[test]
    fn nothing_fires_before_the_threshold() {
        assert!(run(&[(0, 0, LONG, LONG), (20, RIGHT, LONG, LONG), (300, RIGHT, LONG, LONG)]).is_empty());
    }

    #[test]
    fn quick_tap_does_nothing() {
        assert!(run(&[(0, 0, LONG, LONG), (20, RIGHT, LONG, LONG), (150, RIGHT, LONG, LONG), (180, 0, LONG, LONG)]).is_empty());
        // Two quick taps in a row: still nothing.
        assert!(run(&[(0, 0, LONG, LONG), (20, RIGHT, LONG, LONG), (80, 0, LONG, LONG), (300, RIGHT, LONG, LONG), (360, 0, LONG, LONG)]).is_empty());
    }

    #[test]
    fn left_option_never_fires() {
        assert!(run(&[(0, 0, LONG, LONG), (20, LEFT, LONG, LONG), (500, LEFT, LONG, LONG), (2000, LEFT, LONG, LONG), (2020, 0, LONG, LONG)]).is_empty());
        // Both ⌥ down, or ⌥ without the device bits (which side is unknown): nothing.
        assert!(run(&[(0, 0, LONG, LONG), (20, RIGHT | LEFT_OPT, LONG, LONG), (800, RIGHT | LEFT_OPT, LONG, LONG), (900, 0, LONG, LONG)]).is_empty());
        assert!(run(&[(0, 0, LONG, LONG), (20, OPT, LONG, LONG), (800, OPT, LONG, LONG), (900, 0, LONG, LONG)]).is_empty());
        // Left ⌥ joins a hold under way: cancelled.
        let fired = run(&[(0, 0, LONG, LONG), (20, RIGHT, LONG, LONG), (400, RIGHT, LONG, LONG), (500, RIGHT | LEFT_OPT, LONG, LONG), (600, 0, LONG, LONG)]);
        assert_eq!(fired, vec![Fire::HoldStart, Fire::HoldCancel]);
    }

    #[test]
    fn option_and_a_key_is_cancelled_and_nothing_typed() {
        // ⌥E (é) before the threshold: nothing ever starts.
        assert!(run(&[(0, 0, LONG, LONG), (20, RIGHT, LONG, LONG), (100, RIGHT, 20, LONG), (140, 0, 60, LONG)]).is_empty());
        // A key after listening started: cancelled (never an end, so nothing is typed).
        let fired = run(&[(0, 0, LONG, LONG), (20, RIGHT, LONG, LONG), (400, RIGHT, LONG, LONG), (500, RIGHT, 10, LONG), (600, 0, 110, LONG)]);
        assert_eq!(fired, vec![Fire::HoldStart, Fire::HoldCancel]);
        // A key pressed just before ⌥ went down (still counted from the last time nothing was held).
        assert!(run(&[(0, 0, LONG, LONG), (40, RIGHT, 5, LONG), (500, RIGHT, 465, LONG), (600, 0, 565, LONG)]).is_empty());
    }

    #[test]
    fn a_click_while_held_cancels() {
        // ⌥-click before the threshold: nothing.
        assert!(run(&[(0, 0, LONG, LONG), (20, RIGHT, LONG, LONG), (100, RIGHT, LONG, 5), (140, 0, LONG, 45)]).is_empty());
        // After listening started: cancelled.
        let fired = run(&[(0, 0, LONG, LONG), (20, RIGHT, LONG, LONG), (400, RIGHT, LONG, LONG), (700, RIGHT, LONG, 8), (900, 0, LONG, 208)]);
        assert_eq!(fired, vec![Fire::HoldStart, Fire::HoldCancel]);
    }

    #[test]
    fn another_modifier_cancels() {
        // ⇧⌥ (a shortcut, or the chord ⌥⌘ pressed with Right ⌥ first): never dictation.
        for other in [SHIFT, CMD, CTRL] {
            assert!(run(&[(0, 0, LONG, LONG), (20, RIGHT, LONG, LONG), (60, RIGHT | other, LONG, LONG), (500, RIGHT | other, LONG, LONG), (600, 0, LONG, LONG)]).is_empty());
            let fired = run(&[(0, 0, LONG, LONG), (20, RIGHT, LONG, LONG), (400, RIGHT, LONG, LONG), (500, RIGHT | other, LONG, LONG), (900, RIGHT, LONG, LONG), (1000, 0, LONG, LONG)]);
            assert_eq!(fired, vec![Fire::HoldStart, Fire::HoldCancel], "with {other:#x}");
        }
        // ⌘ held first, then Right ⌥ (⌥⌘): not dictation.
        assert!(run(&[(0, 0, LONG, LONG), (20, CMD, LONG, LONG), (60, CMD | RIGHT, LONG, LONG), (800, CMD | RIGHT, LONG, LONG), (900, 0, LONG, LONG)]).is_empty());
    }

    #[test]
    fn caps_lock_and_other_flag_bits_are_ignored() {
        let caps = 0x1_0000;
        let noncoalesced = 0x100;
        let f = RIGHT | caps | noncoalesced;
        assert_eq!(run(&[(0, caps, LONG, LONG), (20, f, LONG, LONG), (400, f, LONG, LONG), (700, caps, LONG, LONG)]), vec![Fire::HoldStart, Fire::HoldEnd]);
    }

    #[test]
    fn again_after_a_cancel() {
        let fired = run(&[
            (0, 0, LONG, LONG),
            (20, RIGHT, LONG, LONG),
            (400, RIGHT, LONG, LONG),
            (500, RIGHT, 10, LONG), // a key: cancelled
            (600, RIGHT, 110, LONG), // still held: waits for all keys up
            (700, 0, 210, LONG),
            (800, RIGHT, 310, LONG),
            (1200, RIGHT, 710, LONG),
            (1500, 0, 1010, LONG),
        ]);
        assert_eq!(fired, vec![Fire::HoldStart, Fire::HoldCancel, Fire::HoldStart, Fire::HoldEnd]);
    }

    #[test]
    fn the_chord_ignores_right_option_alone() {
        // The chord's own detector (⌥⌘ by default) sees only part of it: no tap, no hold.
        let mut state = State::default();
        let mut fired = vec![];
        for (now, flags) in [(0, 0), (20, RIGHT), (400, RIGHT), (900, RIGHT), (1000, 0)] {
            let (next, fire) = keys::step(state, Sample { now, flags, since_key: LONG, since_mouse: LONG }, keys::CHORDS[0].2);
            state = next;
            fired.extend(fire);
        }
        assert!(fired.is_empty());
    }

    #[test]
    fn who_gets_the_microphone() {
        assert!(!takes_over("dictation", "dictation"));
        assert!(!takes_over("chord", "dictation"));
        assert!(!takes_over("button", "dictation"));
        assert!(takes_over("dictation", "chord"));
        assert!(takes_over("dictation", "button"));
        assert!(!takes_over("chord", "button"));
    }

    #[test]
    fn prefs() {
        assert!(check("on").unwrap());
        assert!(!check("off").unwrap());
        assert!(check("yes").is_err());
    }

    #[test]
    fn nothing_heard_says_which_keys() {
        assert_eq!(nothing_note(Some("Hold the keys while you talk.")), "Hold Right ⌥ while you talk.");
        assert_eq!(nothing_note(None), "Didn't catch that. Hold Right ⌥ and try again.");
        assert_eq!(nothing_note(Some("Didn't hear anything.")), "Didn't hear anything.");
    }

    /// The app's refusals as electron/main.mjs and electron/input.mjs write them (for agents), each to
    /// one short sentence for a person.
    #[test]
    fn refusals_become_one_sentence() {
        let cases = [
            ("Dune Bot's own window has the keyboard, and Dune Bot never types into itself. Click the place the text or keys should go first (look_at_screen, then click), then try again.", "own windows"),
            ("Dune Bot is the app in front, and Dune Bot never types into itself. Click the place the text or keys should go first (look_at_screen, then click), then try again.", "own windows"),
            ("Dune Bot can't use the mouse or keyboard yet: macOS needs Dune Bot turned on in System Settings → Privacy & Security → Accessibility (open on the user's screen now). Ask the user to turn it on, then try again.", "Accessibility"),
            ("This Linux desktop runs Wayland, which doesn't let apps move the pointer or type into other apps. Tell the user what to do instead.", "Wayland"),
            ("The app in front runs as administrator, and Windows doesn't let other apps type into it. Ask the user to type this themselves.", "administrator"),
            ("Nothing was typed: the keyboard layout in use (de) has no key for \"ß\". Tell the user: switching to a layout that has them, then asking again, fixes this.", "keyboard layout"),
            ("The user moved the mouse while Dune Bot was using it, so Dune Bot stopped. Don't do it again unless they ask.", "mouse moved"),
            ("The mouse and keyboard are off in this test run.", "test run"),
            ("Using the mouse and keyboard for the user isn't available on this system yet. Tell the user what to do instead.", "isn't available"),
            ("Dune Bot couldn't do it: the app didn't answer, so it was told to stop.", "couldn't type what you said"),
            ("Dune Bot couldn't type that.", "couldn't type what you said"),
        ];
        for (err, want) in cases {
            let said = refusal(err);
            assert!(said.contains(want), "{err} → {said}");
            assert!(!said.contains("look_at_screen") && !said.contains("the user") && said.len() < 110, "{said}");
            assert_eq!(said.matches(". ").count(), 0, "one sentence: {said}");
        }
    }
}
