//! The chord on macOS (⌥⌘ unless Settings picks other keys): tap it to open the bar, hold it to talk.
//!
//! It polls the modifier state and "time since the last key/mouse press" instead of watching
//! keystrokes, so it needs no Input Monitoring permission and never sees what you type.

pub const CMD: u64 = 0x10_0000;
pub const OPT: u64 = 0x08_0000;
pub const CTRL: u64 = 0x04_0000;
pub const SHIFT: u64 = 0x02_0000;
const MODS: u64 = CMD | OPT | CTRL | SHIFT;
/// Which ⌘ is down (the system adds these to the modifier state; if it ever didn't, "Right ⌘"
/// would simply never fire, rather than fire for either ⌘).
pub const LEFT_CMD: u64 = 0x08;
pub const RIGHT_CMD: u64 = 0x10;

/// The keys that tap or hold: these modifiers and no others, plus device bits that must (`need`) or
/// mustn't (`forbid`) be there.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Chord {
    pub mods: u64,
    pub need: u64,
    pub forbid: u64,
}

/// The choices (Settings › Keys, the tray): pref value, label, keys.
pub const CHORDS: [(&str, &str, Chord); 4] = [
    ("opt-cmd", "⌥⌘", Chord { mods: OPT | CMD, need: 0, forbid: 0 }),
    ("ctrl-opt", "⌃⌥", Chord { mods: CTRL | OPT, need: 0, forbid: 0 }),
    ("ctrl-cmd", "⌃⌘", Chord { mods: CTRL | CMD, need: 0, forbid: 0 }),
    ("right-cmd", "Right ⌘", Chord { mods: CMD, need: RIGHT_CMD, forbid: LEFT_CMD }),
];
#[cfg(test)]
const CHORD: u64 = OPT | CMD;

static CHOSEN: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Picks the keys by pref value ("opt-cmd" …); unknown or empty means ⌥⌘. Returns the label.
pub fn choose(name: Option<&str>) -> &'static str {
    let i = CHORDS.iter().position(|(n, _, _)| Some(*n) == name).unwrap_or(0);
    CHOSEN.store(i, std::sync::atomic::Ordering::SeqCst);
    CHORDS[i].1
}

pub fn chosen() -> (&'static str, &'static str, Chord) {
    CHORDS[CHOSEN.load(std::sync::atomic::Ordering::SeqCst).min(CHORDS.len() - 1)]
}

impl Chord {
    /// Exactly these keys are down.
    fn full(&self, flags: u64) -> bool {
        flags & MODS == self.mods && flags & self.need == self.need && flags & self.forbid == 0
    }
    /// Something else is down too: part of another shortcut.
    fn other(&self, flags: u64) -> bool {
        flags & MODS & !self.mods != 0 || flags & self.forbid != 0
    }
}

/// Holding the chord at least this long means "talk"; a shorter press is a tap.
pub const HOLD_MS: u64 = 300;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Fire {
    Tap,
    HoldStart,
    HoldEnd,
    HoldCancel,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum State {
    /// `last_zero`: when no modifier was last held.
    Idle { last_zero: u64 },
    Down { since: u64, holding: bool },
    /// Used for something else (another key, a click, another modifier): wait for all keys up.
    Spoiled,
    /// Fired; wait for all keys up.
    Releasing,
}

impl Default for State {
    fn default() -> Self {
        State::Idle { last_zero: 0 }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Sample {
    pub now: u64,
    pub flags: u64,
    /// Milliseconds since the last key press / mouse button press anywhere.
    pub since_key: u64,
    pub since_mouse: u64,
}

static INPUTS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
static INPUT_ENDED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn clock() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64 + 1
}

/// While Dune Bot clicks, types or presses keys for an agent (and a moment after), the chord
/// doesn't fire: keys it posts never open the bar or start listening.
pub fn input_started() {
    INPUTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

pub fn input_ended() {
    INPUT_ENDED.store(clock(), std::sync::atomic::Ordering::SeqCst);
    INPUTS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
}

pub fn input_busy() -> bool {
    use std::sync::atomic::Ordering::SeqCst;
    let ended = INPUT_ENDED.load(SeqCst);
    INPUTS.load(SeqCst) > 0 || (ended > 0 && clock().saturating_sub(ended) < 400)
}

/// One poll. Fires only on release (tap, end of a hold) or once a hold passes HOLD_MS.
pub fn step(state: State, s: Sample, chord: Chord) -> (State, Option<Fire>) {
    let m = s.flags & MODS;
    let pressed_since = |t: u64| s.since_key < s.now.saturating_sub(t) || s.since_mouse < s.now.saturating_sub(t);
    match state {
        State::Idle { last_zero } => {
            if m == 0 {
                (State::Idle { last_zero: s.now }, None)
            } else if chord.full(s.flags) && !pressed_since(last_zero) {
                (State::Down { since: s.now, holding: false }, None)
            } else if chord.other(s.flags) || pressed_since(last_zero) {
                // Another modifier joined, or a key was pressed while modifiers were held: part of
                // another shortcut.
                (State::Spoiled, None)
            } else {
                (State::Idle { last_zero }, None) // only some of the chord so far
            }
        }
        State::Down { since, holding } => {
            if chord.other(s.flags) || pressed_since(since) {
                (State::Spoiled, holding.then_some(Fire::HoldCancel))
            } else if chord.full(s.flags) {
                if !holding && s.now.saturating_sub(since) >= HOLD_MS {
                    (State::Down { since, holding: true }, Some(Fire::HoldStart))
                } else {
                    (State::Down { since, holding }, None)
                }
            } else {
                let next = if m == 0 { State::Idle { last_zero: s.now } } else { State::Releasing };
                (next, Some(if holding { Fire::HoldEnd } else { Fire::Tap }))
            }
        }
        State::Spoiled | State::Releasing => {
            if m == 0 {
                (State::Idle { last_zero: s.now }, None)
            } else {
                (state, None)
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceFlagsState(state: i32) -> u64;
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    }
    const HID: i32 = 1;
    const KEY_DOWN: u32 = 10;
    const MOUSE_DOWNS: [u32; 3] = [1, 3, 25];

    fn ms(secs: f64) -> u64 {
        if secs.is_finite() && secs >= 0.0 { (secs * 1000.0) as u64 } else { u64::MAX }
    }

    pub fn sample(now: u64) -> super::Sample {
        unsafe {
            let flags = CGEventSourceFlagsState(HID);
            let since_key = ms(CGEventSourceSecondsSinceLastEventType(HID, KEY_DOWN));
            let since_mouse = MOUSE_DOWNS.iter().map(|t| ms(CGEventSourceSecondsSinceLastEventType(HID, *t))).min().unwrap_or(u64::MAX);
            super::Sample { now, flags, since_key, since_mouse }
        }
    }
}

/// Starts the poller (macOS only). `on_fire` runs on the poller thread.
#[cfg(target_os = "macos")]
pub fn watch(on_fire: impl Fn(Fire) + Send + 'static) -> bool {
    std::thread::Builder::new()
        .name("dunebot-chord".into())
        .spawn(move || {
            let start = std::time::Instant::now();
            let mut state = State::default();
            loop {
                let now = start.elapsed().as_millis() as u64;
                // While Dune Bot types, nothing new starts: whatever is held is part of its keys, so it
                // waits for all of it to go. A hold to talk that was already going runs its course
                // (its end or cancel still fires).
                if input_busy() && !matches!(state, State::Down { holding: true, .. }) {
                    state = State::Spoiled;
                    std::thread::sleep(std::time::Duration::from_millis(30));
                    continue;
                }
                let (next, fire) = step(state, mac::sample(now), chosen().2);
                state = next;
                if let Some(f) = fire {
                    on_fire(f);
                }
                // Quick while a modifier is down, relaxed otherwise.
                let ms = if matches!(state, State::Idle { .. }) { 30 } else { 12 };
                std::thread::sleep(std::time::Duration::from_millis(ms));
            }
        })
        .is_ok()
}

#[cfg(not(target_os = "macos"))]
pub fn watch(_on_fire: impl Fn(Fire) + Send + 'static) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs samples (time ms, flags, ms since last key, ms since last click) and collects what fired.
    fn run(samples: &[(u64, u64, u64, u64)]) -> Vec<Fire> {
        let mut state = State::default();
        let mut out = vec![];
        for &(now, flags, since_key, since_mouse) in samples {
            let (next, fire) = step(state, Sample { now, flags, since_key, since_mouse }, CHORDS[0].2);
            state = next;
            out.extend(fire);
        }
        out
    }
    const LONG: u64 = 1_000_000;

    #[test]
    fn tap_opens() {
        assert_eq!(run(&[(0, 0, LONG, LONG), (20, CMD, LONG, LONG), (40, CHORD, LONG, LONG), (150, CHORD, LONG, LONG), (180, 0, LONG, LONG)]), vec![Fire::Tap]);
    }

    #[test]
    fn nothing_fires_on_press() {
        assert!(run(&[(0, 0, LONG, LONG), (20, CHORD, LONG, LONG), (100, CHORD, LONG, LONG)]).is_empty());
    }

    #[test]
    fn hold_talks() {
        let fired = run(&[(0, 0, LONG, LONG), (20, CHORD, LONG, LONG), (200, CHORD, LONG, LONG), (330, CHORD, LONG, LONG), (2000, CHORD, LONG, LONG), (2020, OPT, LONG, LONG), (2040, 0, LONG, LONG)]);
        assert_eq!(fired, vec![Fire::HoldStart, Fire::HoldEnd]);
    }

    #[test]
    fn other_shortcut_cancels() {
        // ⌥⌘D: D pressed at 80 ms (so 20 ms "since key" at 100 ms)
        assert!(run(&[(0, 0, LONG, LONG), (20, CHORD, LONG, LONG), (100, CHORD, 20, LONG), (140, 0, 60, LONG)]).is_empty());
        // ⌥⌘Esc after a hold started: the hold is cancelled, nothing else fires
        let fired = run(&[(0, 0, LONG, LONG), (20, CHORD, LONG, LONG), (400, CHORD, LONG, LONG), (500, CHORD, 10, LONG), (600, 0, 110, LONG)]);
        assert_eq!(fired, vec![Fire::HoldStart, Fire::HoldCancel]);
    }

    #[test]
    fn click_cancels() {
        assert!(run(&[(0, 0, LONG, LONG), (20, CHORD, LONG, LONG), (100, CHORD, LONG, 5), (140, 0, LONG, 45)]).is_empty());
    }

    #[test]
    fn extra_modifier_cancels() {
        assert!(run(&[(0, 0, LONG, LONG), (20, CHORD, LONG, LONG), (60, CHORD | SHIFT, LONG, LONG), (90, CHORD, LONG, LONG), (120, 0, LONG, LONG)]).is_empty());
        // ⌃⌥⌘ then ⌃ released: still not ours
        assert!(run(&[(0, 0, LONG, LONG), (20, CHORD | CTRL, LONG, LONG), (60, CHORD, LONG, LONG), (90, 0, LONG, LONG)]).is_empty());
    }

    #[test]
    fn key_pressed_before_chord_completes_cancels() {
        // ⌘ held, C pressed (⌘C), then ⌥ added and everything released
        assert!(run(&[(0, 0, LONG, LONG), (20, CMD, LONG, LONG), (60, CMD, 5, LONG), (100, CHORD, 45, LONG), (130, 0, 75, LONG)]).is_empty());
    }

    #[test]
    fn caps_lock_and_other_flag_bits_are_ignored() {
        let caps = 0x1_0000;
        let noncoalesced = 0x100;
        let f = CHORD | caps | noncoalesced;
        assert_eq!(run(&[(0, caps, LONG, LONG), (20, f, LONG, LONG), (120, caps, LONG, LONG)]), vec![Fire::Tap]);
    }

    fn run_with(chord: Chord, samples: &[(u64, u64)]) -> Vec<Fire> {
        let mut state = State::default();
        let mut out = vec![];
        for &(now, flags) in samples {
            let (next, fire) = step(state, Sample { now, flags, since_key: LONG, since_mouse: LONG }, chord);
            state = next;
            out.extend(fire);
        }
        out
    }

    #[test]
    fn other_chords() {
        let ctrl_opt = CHORDS[1].2;
        assert_eq!(run_with(ctrl_opt, &[(0, 0), (20, CTRL | OPT), (100, 0)]), vec![Fire::Tap]);
        assert_eq!(run_with(ctrl_opt, &[(0, 0), (20, CTRL | OPT), (400, CTRL | OPT), (900, 0)]), vec![Fire::HoldStart, Fire::HoldEnd]);
        // ⌥⌘ does nothing once ⌃⌥ is picked, and ⌃⌥⌘ is another shortcut.
        assert!(run_with(ctrl_opt, &[(0, 0), (20, OPT | CMD), (500, OPT | CMD), (600, 0)]).is_empty());
        assert!(run_with(ctrl_opt, &[(0, 0), (20, CTRL | OPT | CMD), (500, CTRL | OPT | CMD), (600, 0)]).is_empty());
    }

    #[test]
    fn right_command_alone() {
        let right = CHORDS[3].2;
        assert_eq!(run_with(right, &[(0, 0), (20, CMD | RIGHT_CMD), (100, 0)]), vec![Fire::Tap]);
        assert_eq!(run_with(right, &[(0, 0), (20, CMD | RIGHT_CMD), (400, CMD | RIGHT_CMD), (700, 0)]), vec![Fire::HoldStart, Fire::HoldEnd]);
        // Left ⌘ never fires; both ⌘ is something else; ⌘ without the device bits never fires.
        assert!(run_with(right, &[(0, 0), (20, CMD | LEFT_CMD), (500, CMD | LEFT_CMD), (600, 0)]).is_empty());
        assert!(run_with(right, &[(0, 0), (20, CMD | RIGHT_CMD | LEFT_CMD), (500, CMD | RIGHT_CMD | LEFT_CMD), (600, 0)]).is_empty());
        assert!(run_with(right, &[(0, 0), (20, CMD), (500, CMD), (600, 0)]).is_empty());
        // Right ⌘ + ⇧ (a shortcut) never fires.
        assert!(run_with(right, &[(0, 0), (20, CMD | RIGHT_CMD), (60, CMD | RIGHT_CMD | SHIFT), (600, 0)]).is_empty());
    }

    #[test]
    fn choosing() {
        assert_eq!(choose(Some("ctrl-cmd")), "⌃⌘");
        assert_eq!(chosen().0, "ctrl-cmd");
        assert_eq!(choose(Some("nonsense")), "⌥⌘");
        assert_eq!(choose(None), "⌥⌘");
    }

    #[test]
    fn two_taps_in_a_row() {
        let fired = run(&[(0, 0, LONG, LONG), (20, CHORD, LONG, LONG), (80, 0, LONG, LONG), (300, CHORD, LONG, LONG), (360, 0, LONG, LONG)]);
        assert_eq!(fired, vec![Fire::Tap, Fire::Tap]);
    }
}
