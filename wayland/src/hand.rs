//! Clicks and keys through libei (the desktop's emulated-input connection, from the portal). The
//! pointer is absolute, in the desktop's logical coordinates. Keys go by the keyboard layout the
//! desktop hands over and its live state (which layout is active, Caps Lock): each character is
//! worked out by playing the press through that layout first, so what arrives is the character
//! asked for, and one the layout can't make is refused, never claimed typed.

use enumflags2::BitFlags;
use futures_util::StreamExt;
use reis::{
    ei,
    event::{Connection, Device, DeviceCapability, EiEvent},
};
use std::{
    cell::RefCell,
    os::{fd::OwnedFd, unix::net::UnixStream},
    rc::Rc,
    time::Duration,
};
use tokio::sync::mpsc;
use xkbcommon::xkb;

const BTN_LEFT: u32 = 0x110;
const BTN_RIGHT: u32 = 0x111;
const BTN_MIDDLE: u32 = 0x112;
const SHIFT_L: u32 = 0xffe1;
const LEVEL3: u32 = 0xfe03; // ISO_Level3_Shift (AltGr)

/// The desktop's layout, and the keys that shift it.
struct Keys {
    keymap: xkb::Keymap,
    shift: Option<u32>,
    level3: Option<u32>,
    /// Each layout's name, by group ("English (US)", "German").
    names: Vec<String>,
    lock: u32,
}

/// How to make one keysym: a key (xkb keycode), with Shift and/or AltGr held around it.
#[derive(Clone, Copy)]
struct Press {
    code: u32,
    shift: bool,
    level3: bool,
}

impl Keys {
    fn from(km: &reis::event::Keymap) -> Result<Keys, String> {
        let ctx = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
        let fd = km.fd.try_clone().map_err(|e| e.to_string())?;
        let keymap = unsafe { xkb::Keymap::new_from_fd(&ctx, fd, km.size as usize, xkb::KEYMAP_FORMAT_TEXT_V1, xkb::KEYMAP_COMPILE_NO_FLAGS) }
            .map_err(|e| e.to_string())?
            .ok_or("the desktop's keyboard layout couldn't be read")?;
        let names = (0..keymap.num_layouts()).map(|g| keymap.layout_get_name(g).to_string()).collect();
        let lock = match keymap.mod_get_index("Lock") {
            i if i < 32 => 1 << i,
            _ => 0,
        };
        let mut keys = Keys { keymap, shift: None, level3: None, names, lock };
        // The modifier keys, found on the first layout with nothing held.
        keys.shift = keys.find(SHIFT_L, 0, 0, 0, false, false);
        keys.level3 = keys.find(LEVEL3, 0, 0, 0, false, false);
        Ok(keys)
    }

    fn codes(&self) -> std::ops::RangeInclusive<u32> {
        self.keymap.min_keycode().raw().max(8)..=self.keymap.max_keycode().raw()
    }

    /// The first key that gives `sym` with the desktop in this state and these keys held.
    fn find(&self, sym: u32, latched: u32, locked: u32, group: u32, shift: bool, level3: bool) -> Option<u32> {
        let mut st = xkb::State::new(&self.keymap);
        st.update_mask(0, latched, locked, 0, 0, group);
        for (held, on) in [(self.shift, shift), (self.level3, level3)] {
            if on {
                st.update_key(xkb::Keycode::new(held?), xkb::KeyDirection::Down);
            }
        }
        self.codes().find(|&kc| st.key_get_one_sym(xkb::Keycode::new(kc)).raw() == sym)
    }

    /// A character to type: exactly that character, in the layout and state the desktop has now.
    fn for_text(&self, sym: u32, m: Mods) -> Option<Press> {
        for (shift, level3) in [(false, false), (true, false), (false, true), (true, true)] {
            if let Some(code) = self.find(sym, m.latched, m.locked, m.group, shift, level3) {
                return Some(Press { code, shift, level3 });
            }
        }
        None
    }

    /// A key for a shortcut: the key that carries `sym` with nothing locked (Ctrl+A stays Ctrl+A
    /// under Caps Lock), on the active layout, else on another one (Ctrl+A on a Russian layout is
    /// the same key a person presses).
    fn for_key(&self, sym: u32, m: Mods) -> Option<Press> {
        let n = self.keymap.num_layouts().max(1);
        let groups = std::iter::once(m.group).chain((0..n).filter(|g| *g != m.group));
        for group in groups {
            for shift in [false, true] {
                if let Some(code) = self.find(sym, 0, 0, group, shift, false) {
                    return Some(Press { code, shift, level3: false });
                }
            }
        }
        None
    }
}

/// The desktop's keyboard state as libei last told it.
#[derive(Default, Clone, Copy)]
struct Mods {
    latched: u32,
    locked: u32,
    group: u32,
}

#[derive(Default)]
struct Devices {
    pointer: Option<Device>,
    keyboard: Option<Device>,
    resumed: Vec<Device>,
    keys: Option<Keys>,
    keys_error: Option<String>,
    mods: Mods,
    /// Whether the desktop tells libei its keyboard state (GNOME 49.5+). Before that, it's read
    /// from GNOME's settings and the keyboard's Caps Lock light instead.
    mods_known: bool,
    fallback: Option<(std::time::Instant, Result<Mods, String>)>,
    regions: Vec<[f64; 5]>,
}

pub struct Hand {
    conn: Connection,
    state: Rc<RefCell<Devices>>,
    seq: u32,
    pump: tokio::task::JoinHandle<()>,
    buttons_down: Vec<u32>,
    /// Evdev codes held down, in order.
    keys_down: Vec<u32>,
    /// Keys pressed by `key` with Shift/AltGr held for them: released together.
    held_for: Vec<(u32, Press)>,
}

fn now_us() -> u64 {
    let mut t = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut t) }; // libei's clock
    t.tv_sec as u64 * 1_000_000 + t.tv_nsec as u64 / 1000
}

impl Hand {
    pub async fn connect(fd: OwnedFd, gone: mpsc::UnboundedSender<()>) -> Result<Hand, String> {
        let ctx = ei::Context::new(UnixStream::from(fd)).map_err(|e| e.to_string())?;
        let (conn, mut events) = ctx
            .handshake_tokio("dunebot", ei::handshake::ContextType::Sender)
            .await
            .map_err(|e| format!("handshake: {e}"))?;
        let state = Rc::new(RefCell::new(Devices::default()));
        let st = state.clone();
        let c = conn.clone();
        let pump = tokio::task::spawn_local(async move {
            while let Some(Ok(ev)) = events.next().await {
                let mut s = st.borrow_mut();
                match ev {
                    EiEvent::SeatAdded(e) => {
                        let caps: BitFlags<DeviceCapability> =
                            DeviceCapability::PointerAbsolute | DeviceCapability::Button | DeviceCapability::Scroll | DeviceCapability::Keyboard;
                        e.seat.bind_capabilities(caps);
                        let _ = c.flush();
                    }
                    EiEvent::DeviceAdded(e) => {
                        let d = e.device;
                        if d.has_capability(DeviceCapability::PointerAbsolute) {
                            s.regions = d.regions().iter().map(|r| [r.x as f64, r.y as f64, r.width as f64, r.height as f64, r.scale as f64]).collect();
                            s.pointer = Some(d.clone());
                        }
                        if d.has_capability(DeviceCapability::Keyboard) {
                            match d.keymap().map(Keys::from) {
                                Some(Ok(k)) => {
                                    s.fallback = None;
                                    if debug() {
                                        let n = k.keymap.num_layouts();
                                        let names: Vec<&str> = (0..n).map(|g| k.keymap.layout_get_name(g)).collect();
                                        eprintln!("ei: keyboard added, layouts {names:?}");
                                    }
                                    s.keys = Some(k);
                                    s.keys_error = None;
                                }
                                Some(Err(e)) => s.keys_error = Some(e),
                                None => s.keys_error = Some("the desktop gave no keyboard layout".into()),
                            }
                            s.keyboard = Some(d.clone());
                        }
                    }
                    EiEvent::KeyboardModifiers(e) => {
                        if debug() {
                            eprintln!("ei: modifiers depressed {:#x} latched {:#x} locked {:#x} group {}", e.depressed, e.latched, e.locked, e.group);
                        }
                        s.mods = Mods { latched: e.latched, locked: e.locked, group: e.group };
                        s.mods_known = true;
                    }
                    EiEvent::DeviceResumed(e) => {
                        if !s.resumed.contains(&e.device) {
                            s.resumed.push(e.device);
                        }
                    }
                    EiEvent::DevicePaused(e) => s.resumed.retain(|d| d != &e.device),
                    EiEvent::DeviceRemoved(e) => {
                        if debug() {
                            eprintln!("ei: device removed (keyboard: {})", e.device.has_capability(DeviceCapability::Keyboard));
                        }
                        s.resumed.retain(|d| d != &e.device);
                        if s.pointer.as_ref() == Some(&e.device) {
                            s.pointer = None;
                        }
                        if s.keyboard.as_ref() == Some(&e.device) {
                            s.keyboard = None;
                        }
                    }
                    EiEvent::Disconnected(_) => break,
                    _ => {}
                }
            }
            let _ = gone.send(());
        });
        let hand = Hand { conn, state, seq: 1, pump, buttons_down: vec![], keys_down: vec![], held_for: vec![] };
        // The desktop adds and resumes its devices right after the handshake.
        for _ in 0..60 {
            {
                let s = hand.state.borrow();
                let ready = |d: &Option<Device>| d.as_ref().is_some_and(|d| s.resumed.contains(d));
                if ready(&s.pointer) && ready(&s.keyboard) {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok(hand)
    }

    pub fn regions(&self) -> Vec<[f64; 5]> {
        self.state.borrow().regions.clone()
    }

    fn device(&self, keyboard: bool) -> Result<Device, String> {
        let s = self.state.borrow();
        let d = if keyboard { &s.keyboard } else { &s.pointer };
        let d = d.as_ref().ok_or(if keyboard { "The desktop gave no keyboard." } else { "The desktop gave no pointer." })?;
        if !s.resumed.contains(d) {
            return Err("The desktop paused Dune Bot's keyboard and pointer.".into());
        }
        Ok(d.clone())
    }

    /// One burst of events, framed, as libei wants: start, the events, frame, stop.
    fn emit(&mut self, d: &Device, events: impl FnOnce(&Device)) -> Result<(), String> {
        let serial = self.conn.serial();
        d.device().start_emulating(serial, self.seq);
        self.seq += 1;
        events(d);
        d.device().frame(serial, now_us());
        d.device().stop_emulating(serial);
        self.conn.flush().map_err(|e| format!("the desktop stopped listening ({e})"))
    }

    pub fn move_to(&mut self, x: f64, y: f64) -> Result<(), String> {
        let d = self.device(false)?;
        let inside = self.state.borrow().regions.iter().any(|r| x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3]);
        if !inside {
            return Err(format!("({x:.0}, {y:.0}) isn't on any shared screen."));
        }
        let p = d.interface::<ei::PointerAbsolute>().ok_or("The pointer can't be placed.")?;
        self.emit(&d, |_| p.motion_absolute(x as f32, y as f32))
    }

    pub fn button(&mut self, which: &str, down: bool) -> Result<(), String> {
        let code = match which {
            "right" => BTN_RIGHT,
            "middle" => BTN_MIDDLE,
            _ => BTN_LEFT,
        };
        let d = self.device(false)?;
        let b = d.interface::<ei::Button>().ok_or("The pointer has no buttons.")?;
        let state = if down { ei::button::ButtonState::Press } else { ei::button::ButtonState::Released };
        self.emit(&d, |_| b.button(code, state))?;
        if down {
            self.buttons_down.push(code);
        } else {
            self.buttons_down.retain(|c| *c != code);
        }
        Ok(())
    }

    /// `dx`/`dy` +1 is left or up (as the app's other systems count it); libei's positive is down.
    pub async fn scroll(&mut self, dx: i32, dy: i32, n: u32) -> Result<(), String> {
        let d = self.device(false)?;
        let s = d.interface::<ei::Scroll>().ok_or("The pointer can't scroll.")?;
        for i in 0..n {
            let (sx, sy) = (-dx.signum() * 120, -dy.signum() * 120);
            let s2 = s.clone();
            self.emit(&d, move |_| s2.scroll_discrete(sx, sy))?;
            if i + 1 < n {
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        }
        Ok(())
    }

    /// The keyboard state to type in: the desktop's own word when it gives it, else what GNOME's
    /// settings and the Caps Lock light say (read at most once a second).
    fn mods(&self) -> Result<Mods, String> {
        let mut s = self.state.borrow_mut();
        if s.mods_known {
            return Ok(s.mods);
        }
        if let Some((at, m)) = &s.fallback {
            if at.elapsed() < Duration::from_secs(1) {
                return m.clone();
            }
        }
        let m = match s.keys.as_ref() {
            Some(k) => desktop_state(k),
            None => Ok(Mods::default()),
        };
        s.fallback = Some((std::time::Instant::now(), m.clone()));
        m
    }

    fn lookup(&self, sym: u32, text: bool) -> Result<Option<Press>, String> {
        // Shortcuts don't depend on Caps Lock, and fall back to any layout: a state that can't be
        // read only matters for text.
        let mods = match self.mods() {
            Ok(m) => m,
            Err(e) if text => return Err(e),
            Err(_) => Mods::default(),
        };
        let s = self.state.borrow();
        let keys = s.keys.as_ref().ok_or_else(|| s.keys_error.clone().unwrap_or_else(|| "The desktop gave no keyboard layout.".into()))?;
        Ok(if text { keys.for_text(sym, mods) } else { keys.for_key(sym, mods) })
    }

    /// Where the keyboard state came from: "desktop" (exact), or "settings" with Caps Lock read
    /// from its light (`caps` true/false) or not readable (null: taken as off).
    pub fn state_note(&self) -> serde_json::Value {
        if self.state.borrow().mods_known {
            return serde_json::json!({ "from": "desktop" });
        }
        serde_json::json!({ "from": "settings", "caps": caps_light() })
    }

    fn modifier_codes(&self, p: Press) -> Vec<u32> {
        let s = self.state.borrow();
        let Some(k) = s.keys.as_ref() else { return vec![] };
        [(p.shift, k.shift), (p.level3, k.level3)].into_iter().filter_map(|(on, c)| if on { c } else { None }).collect()
    }

    /// A key down or up by its X keysym, for shortcuts and named keys. A keysym that needs Shift on
    /// this layout gets Shift held around it.
    pub fn key(&mut self, sym: u32, down: bool) -> Result<(), String> {
        if !down {
            if let Some(i) = self.held_for.iter().position(|(s, _)| *s == sym) {
                let (_, p) = self.held_for.remove(i);
                let r = self.key_code(p.code - 8, false);
                for m in self.modifier_codes(p).into_iter().rev() {
                    self.key_code(m - 8, false)?;
                }
                return r;
            }
        }
        let p = self.lookup(sym, false)?.ok_or_else(|| format!("This keyboard layout has no key for keysym 0x{sym:x}."))?;
        if down {
            let mods = self.modifier_codes(p);
            for m in &mods {
                self.key_code(m - 8, true)?;
            }
            if !mods.is_empty() {
                self.held_for.push((sym, p));
            }
        }
        self.key_code(p.code - 8, down)
    }

    fn key_code(&mut self, code: u32, down: bool) -> Result<(), String> {
        let d = self.device(true)?;
        let k = d.interface::<ei::Keyboard>().ok_or("The keyboard can't type.")?;
        let state = if down { ei::keyboard::KeyState::Press } else { ei::keyboard::KeyState::Released };
        self.emit(&d, |_| k.key(code, state))?;
        if down {
            self.keys_down.push(code);
        } else if let Some(i) = self.keys_down.iter().rposition(|c| *c == code) {
            self.keys_down.remove(i);
        }
        Ok(())
    }

    /// The active layout's name, as the desktop calls it ("English (US)").
    pub fn layout_name(&self) -> String {
        let group = self.mods().map(|m| m.group).unwrap_or(0);
        let s = self.state.borrow();
        s.keys.as_ref().and_then(|k| k.names.get(group as usize).cloned()).filter(|n| !n.is_empty()).unwrap_or_else(|| "this one".into())
    }

    pub fn can_type(&self, ch: char) -> Result<bool, String> {
        Ok(self.lookup(keysym_of(ch), true)?.is_some())
    }

    /// One character, down and up, with Shift and/or AltGr around it when the layout puts it there.
    pub async fn text(&mut self, ch: char) -> Result<(), String> {
        let p = self.lookup(keysym_of(ch), true)?.ok_or_else(|| {
            format!("The keyboard layout in use ({}) has no key for \"{ch}\", so Dune Bot can't type it. A layout that has it, switched to first, fixes this.", self.layout_name())
        })?;
        let mods = self.modifier_codes(p);
        let mut pressed = vec![];
        let mut r = Ok(());
        for m in &mods {
            r = self.key_code(m - 8, true);
            if r.is_err() {
                break;
            }
            pressed.push(*m);
        }
        if r.is_ok() {
            r = self.key_code(p.code - 8, true);
            if r.is_ok() {
                tokio::time::sleep(Duration::from_millis(12)).await;
                r = self.key_code(p.code - 8, false);
            }
        }
        for m in pressed.into_iter().rev() {
            let _ = self.key_code(m - 8, false);
        }
        r
    }

    /// Nothing stays held when the session ends.
    pub fn release_all(&mut self) {
        for code in std::mem::take(&mut self.buttons_down) {
            let name = match code {
                BTN_RIGHT => "right",
                BTN_MIDDLE => "middle",
                _ => "left",
            };
            let _ = self.button(name, false);
        }
        self.held_for.clear();
        for code in std::mem::take(&mut self.keys_down).into_iter().rev() {
            let _ = self.key_code(code, false);
        }
    }

    pub fn stop(self) {
        self.pump.abort();
    }
}

/// One of GNOME's input-source settings, as gsettings prints it.
fn setting(key: &str) -> Option<String> {
    let out = std::process::Command::new("gsettings").args(["get", "org.gnome.desktop.input-sources", key]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// GNOME's input sources from its settings: [(type, id)], e.g. [("xkb", "de+nodeadkeys")].
fn sources(key: &str) -> Option<Vec<(String, String)>> {
    let text = setting(key)?;
    let quoted: Vec<&str> = text.split('\'').skip(1).step_by(2).collect();
    Some(quoted.chunks_exact(2).map(|p| (p[0].to_string(), p[1].to_string())).collect())
}

/// The keyboard state from outside libei (GNOME before 49.5): the active input source is the first
/// of GNOME's most-recently-used list, matched to the keymap's layouts by name; Caps Lock from the
/// keyboard's light. When the active layout can't be told, text is refused, not guessed.
fn desktop_state(keys: &Keys) -> Result<Mods, String> {
    let mut distinct = keys.names.clone();
    distinct.sort();
    distinct.dedup();
    let group = if distinct.len() <= 1 {
        0
    } else {
        // "A different source for each window": GNOME then switches layouts on each focus change
        // without recording which (only switches the user makes are), so the active one can't be told.
        if setting("per-window").as_deref() == Some("true") {
            return Err("GNOME keeps a separate keyboard layout for each window here, so Dune Bot can't tell which one is in use and won't type (it could come out wrong). Turning off \"Switch input sources individually for each window\" in Settings › Keyboard fixes this.".into());
        }
        let all = sources("sources").unwrap_or_default();
        let mru = sources("mru-sources").unwrap_or_default();
        if debug() {
            eprintln!("state: sources {all:?} mru {mru:?} keymap {:?}", keys.names);
        }
        // GNOME records the active source first in this list (once IBus, its input-method service,
        // is up, as on every stock GNOME desktop). Nothing recorded: no guess.
        let Some((kind, id)) = mru.into_iter().find(|s| all.contains(s)) else {
            return Err("Dune Bot can't tell which of your keyboard layouts is in use, so it won't type (it could come out wrong). Switching layouts once (Super+Space) lets it tell.".into());
        };
        if kind != "xkb" {
            return Err(format!("An input method ({id}) is in use, so Dune Bot won't type: it could change what arrives. Switching to a plain keyboard layout fixes this."));
        }
        let (layout, variant) = id.split_once('+').unwrap_or((&id, ""));
        let ctx = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
        let name = xkb::Keymap::new_from_names(&ctx, "evdev", "", layout, variant, None, xkb::KEYMAP_COMPILE_NO_FLAGS)
            .map(|k| k.layout_get_name(0).to_string())
            .unwrap_or_default();
        if debug() {
            eprintln!("state: active {id} is named {name:?}");
        }
        match keys.names.iter().position(|n| !name.is_empty() && *n == name) {
            Some(g) => g as u32,
            None => return Err(format!("Dune Bot can't tell which keyboard layout is in use ({id}), so it won't type (it could come out wrong).")),
        }
    };
    let locked = if caps_light() == Some(true) { keys.lock } else { 0 };
    Ok(Mods { latched: 0, locked, group })
}

/// Caps Lock's light on any keyboard (the kernel's LED files, readable by every user): Some(on), or
/// None when no keyboard has one.
fn caps_light() -> Option<bool> {
    // DUNEBOT_WL_LEDS: another folder laid out the same way (the helper's test; a container has none).
    let dir = std::env::var_os("DUNEBOT_WL_LEDS").filter(|v| !v.is_empty()).unwrap_or_else(|| "/sys/class/leds".into());
    let dir = std::fs::read_dir(dir).ok()?;
    let mut seen = None;
    for e in dir.flatten() {
        if e.file_name().to_string_lossy().ends_with("::capslock") {
            let on = std::fs::read_to_string(e.path().join("brightness")).ok()?.trim() != "0";
            seen = Some(seen.unwrap_or(false) || on);
        }
    }
    seen
}

/// `DUNEBOT_WL_DEBUG=1`: what libei says, on stderr (never keys typed, only layouts and state).
pub(crate) fn debug() -> bool {
    std::env::var_os("DUNEBOT_WL_DEBUG").is_some_and(|v| !v.is_empty() && v != "0")
}

fn keysym_of(ch: char) -> u32 {
    match ch {
        '\n' => 0xff0d,
        '\t' => 0xff09,
        _ => xkb::utf32_to_keysym(ch as u32).raw(),
    }
}
