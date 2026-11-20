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
/// Which Ctrl is down (IOLLEvent.h: NX_DEVICELCTLKEYMASK, NX_DEVICERCTLKEYMASK). Windows and Linux put
/// what they read in macOS's bits (`Held`), so one set of rules (`step`) serves every system.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub const LEFT_CTRL: u64 = 0x01;
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub const RIGHT_CTRL: u64 = 0x2000;

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

/// What one poll on Windows or Linux (X11) saw held: the modifiers, Ctrl by side, and whether any
/// other key or a mouse button is down, never which. The other keys are only looked at while a
/// modifier is held (a key or a click with it means a shortcut, so nothing starts).
#[cfg_attr(target_os = "macos", allow(dead_code))]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Held {
    pub shift: bool,
    pub left_ctrl: bool,
    pub right_ctrl: bool,
    pub alt: bool,
    /// The Windows key, Super.
    pub logo: bool,
    pub other_key: bool,
    pub button: bool,
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
impl Held {
    pub fn any_modifier(&self) -> bool {
        self.shift || self.left_ctrl || self.right_ctrl || self.alt || self.logo
    }

    /// In macOS's bits: Ctrl by side, Alt as ⌥, the Windows key / Super as ⌘.
    pub fn flags(&self) -> u64 {
        let mut f = 0;
        if self.shift {
            f |= SHIFT;
        }
        if self.left_ctrl {
            f |= CTRL | LEFT_CTRL;
        }
        if self.right_ctrl {
            f |= CTRL | RIGHT_CTRL;
        }
        if self.alt {
            f |= OPT;
        }
        if self.logo {
            f |= CMD;
        }
        f
    }
}

/// Turns what's held into `Sample`s: "since the last key / click" is how long ago another key or a
/// button was last seen down (macOS tells it directly; Windows and Linux only say what's down now).
#[cfg_attr(target_os = "macos", allow(dead_code))]
#[derive(Default)]
pub struct Polls {
    last_key: u64,
    last_button: u64,
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
impl Polls {
    pub fn sample(&mut self, now: u64, held: Held) -> Sample {
        if held.other_key {
            self.last_key = now;
        }
        if held.button {
            self.last_button = now;
        }
        let since = |t: u64| if t == 0 { u64::MAX } else { now.saturating_sub(t) };
        Sample { now, flags: held.flags(), since_key: since(self.last_key), since_mouse: since(self.last_button) }
    }
}

/// Windows: the keys' state as GetAsyncKeyState gives it (no keyboard hook, nothing typed is seen).
#[cfg(target_os = "windows")]
pub(crate) mod win {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetAsyncKeyState(vk: i32) -> i16;
    }

    fn down(vk: i32) -> bool {
        unsafe { (GetAsyncKeyState(vk) as u16) & 0x8000 != 0 }
    }

    /// Mouse buttons (left, right, middle, the two side buttons).
    const BUTTONS: [i32; 5] = [0x01, 0x02, 0x04, 0x05, 0x06];

    /// Not "another key": buttons, modifiers (both the either-side and the sided codes), and
    /// VK_PACKET (characters typed by an app, Dune Bot's own included).
    fn counted(vk: i32) -> bool {
        !matches!(vk, 0x01..=0x07 | 0x10..=0x12 | 0xA0..=0xA5 | 0x5B | 0x5C | 0xE7 | 0xFF)
    }

    pub fn held() -> super::Held {
        let mut h = super::Held {
            shift: down(0xA0) || down(0xA1),
            left_ctrl: down(0xA2),
            right_ctrl: down(0xA3),
            alt: down(0xA4) || down(0xA5),
            logo: down(0x5B) || down(0x5C),
            ..Default::default()
        };
        if h.any_modifier() {
            h.button = BUTTONS.iter().any(|vk| down(*vk));
            h.other_key = (0x08..=0xFE).filter(|vk| counted(*vk)).any(down);
        }
        h
    }
}

/// Linux on X11: the keyboard's state as the X server gives it (XQueryKeymap, no grab, nothing typed
/// is seen), with each key's role read from the keyboard map (refreshed now and then: layouts change).
/// Never inside a Wayland session: there the X server only sees keys meant for X apps.
#[cfg(target_os = "linux")]
pub(crate) mod x11 {
    use std::ffi::{c_char, c_int, c_uint, c_ulong, c_void};

    type Display = c_void;
    struct X {
        _lib: libloading::Library,
        root: unsafe extern "C" fn(*mut Display) -> c_ulong,
        query_keymap: unsafe extern "C" fn(*mut Display, *mut c_char) -> c_int,
        query_pointer: unsafe extern "C" fn(*mut Display, c_ulong, *mut c_ulong, *mut c_ulong, *mut c_int, *mut c_int, *mut c_int, *mut c_int, *mut c_uint) -> c_int,
        display_keycodes: unsafe extern "C" fn(*mut Display, *mut c_int, *mut c_int) -> c_int,
        get_keyboard_mapping: unsafe extern "C" fn(*mut Display, u8, c_int, *mut c_int) -> *mut c_ulong,
        free: unsafe extern "C" fn(*mut c_void) -> c_int,
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Role {
        Other,
        Shift,
        LeftCtrl,
        RightCtrl,
        Alt,
        Logo,
    }

    /// A keysym's role (X11/keysymdef.h). Lock keys count as other keys.
    fn role(sym: c_ulong) -> Option<Role> {
        Some(match sym {
            0xffe1 | 0xffe2 => Role::Shift,
            0xffe3 => Role::LeftCtrl,
            0xffe4 => Role::RightCtrl,
            // Alt, Meta, AltGr (ISO_Level3_Shift, Mode_switch, ISO_Level5_Shift)
            0xffe9 | 0xffea | 0xffe7 | 0xffe8 | 0xfe03 | 0xff7e | 0xfe11 => Role::Alt,
            // Super, Hyper
            0xffeb | 0xffec | 0xffed | 0xffee => Role::Logo,
            _ => return None,
        })
    }

    pub struct Keyboard {
        x: X,
        dpy: *mut Display,
        roles: [Role; 256],
        mapped: std::time::Instant,
    }

    pub fn in_wayland() -> bool {
        std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty()) || std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland")
    }

    impl Keyboard {
        /// The X display (DISPLAY), when there is one and this isn't a Wayland session.
        pub fn open() -> Option<Self> {
            if in_wayland() {
                return None;
            }
            unsafe {
                let lib = libloading::Library::new("libX11.so.6").ok()?;
                macro_rules! f {
                    ($name:literal) => {
                        *lib.get($name).ok()?
                    };
                }
                let open: unsafe extern "C" fn(*const c_char) -> *mut Display = f!(b"XOpenDisplay\0");
                let x = X {
                    root: f!(b"XDefaultRootWindow\0"),
                    query_keymap: f!(b"XQueryKeymap\0"),
                    query_pointer: f!(b"XQueryPointer\0"),
                    display_keycodes: f!(b"XDisplayKeycodes\0"),
                    get_keyboard_mapping: f!(b"XGetKeyboardMapping\0"),
                    free: f!(b"XFree\0"),
                    _lib: lib,
                };
                let dpy = open(std::ptr::null());
                if dpy.is_null() {
                    return None;
                }
                let mut k = Keyboard { x, dpy, roles: [Role::Other; 256], mapped: std::time::Instant::now() };
                k.map();
                Some(k)
            }
        }

        /// Reads which key is which modifier from the keyboard map.
        fn map(&mut self) {
            unsafe {
                let (mut lo, mut hi) = (0, 0);
                (self.x.display_keycodes)(self.dpy, &mut lo, &mut hi);
                if lo < 8 || hi > 255 || hi < lo {
                    return;
                }
                let count = hi - lo + 1;
                let mut per = 0;
                let syms = (self.x.get_keyboard_mapping)(self.dpy, lo as u8, count, &mut per);
                if syms.is_null() || per <= 0 {
                    return;
                }
                let mut roles = [Role::Other; 256];
                for i in 0..count as usize {
                    // The first group's two levels name the key (a later group may be another layout).
                    for l in 0..(per as usize).min(2) {
                        if let Some(r) = role(*syms.add(i * per as usize + l)) {
                            roles[lo as usize + i] = r;
                            break;
                        }
                    }
                }
                (self.x.free)(syms as *mut c_void);
                self.roles = roles;
                self.mapped = std::time::Instant::now();
            }
        }

        /// Whether the map names a Right Ctrl key at all (a layout may turn it into Compose).
        pub fn has_right_ctrl(&self) -> bool {
            self.roles.contains(&Role::RightCtrl)
        }

        pub fn held(&mut self) -> super::Held {
            if self.mapped.elapsed().as_secs() >= 5 {
                self.map();
            }
            let mut keys = [0 as c_char; 32];
            unsafe { (self.x.query_keymap)(self.dpy, keys.as_mut_ptr()) };
            let mut h = super::Held::default();
            for code in 8..256usize {
                if (keys[code / 8] as u8) & (1 << (code % 8)) == 0 {
                    continue;
                }
                match self.roles[code] {
                    Role::Shift => h.shift = true,
                    Role::LeftCtrl => h.left_ctrl = true,
                    Role::RightCtrl => h.right_ctrl = true,
                    Role::Alt => h.alt = true,
                    Role::Logo => h.logo = true,
                    Role::Other => h.other_key = true,
                }
            }
            if !h.any_modifier() {
                h.other_key = false; // looked at only while a modifier is held
            } else {
                let (mut r, mut c, mut rx, mut ry, mut wx, mut wy, mut mask) = (0, 0, 0, 0, 0, 0, 0u32);
                unsafe { (self.x.query_pointer)(self.dpy, (self.x.root)(self.dpy), &mut r, &mut c, &mut rx, &mut ry, &mut wx, &mut wy, &mut mask) };
                // Button1Mask..Button3Mask (4 and 5 are the wheel)
                h.button = mask & (0b111 << 8) != 0;
            }
            h
        }
    }
}

/// Also read by dictation.rs (Right ⌥ held alone), which polls the same state on its own thread.
#[cfg(target_os = "macos")]
pub(crate) mod mac {
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
