//! Loaded by Electron's main process (macOS only). The glass itself comes from the
//! `electron-liquid-glass` package; this adds what it doesn't have:
//! - `notificationStatus` / `requestNotifications`: the system's notification permission for this app.
//! - `windowAppearance`: the light/dark appearance a window is drawn in (for the log).
//! - `setGlassRadius`: sets the glass view's own corner radius (the package only clips its layer, so
//!   the glass's edge light would keep its default corners), in place, without rebuilding it.
//! - `setGlassTint`: tints the glass toward the window colour (Apple's public `tintColor`), which
//!   makes it less see-through while keeping its edge light; 0 removes the tint.
//! - `setWindowAppearance`: draws one window light or dark whatever the system is set to (Electron
//!   can only set this for the whole app). Not used now: the whole app is dark.
//! - `requestScreenAccess`: asks macOS for Screen Recording, which also puts this app in the list
//!   in System Settings (Electron's capture calls don't, until a real picture is taken).
//! - `glassInfo`: reads back the glass view under a window (does Apple's style switch exist on this
//!   macOS, and what is it set to), so the log shows a style setting that was silently skipped.
//! - `locationStart` / `locationPoll` / `locationName` / `locationStop`: where this Mac is, from
//!   Location Services, and the area's name (the core's `find_location`; see `mod location`).
//! - `postEventAccess`: whether this app may use the mouse and keyboard for the user (macOS's
//!   Accessibility list).
//! - `pointerGlide` / `pointerPress` / `pointerButton` / `scrollAt`: the core's click, drag and
//!   scroll, the pointer gliding as a hand would (`clickPath` shows that path without moving anything).
//!   Each is one step, so the app checks what's under the pointer between them.
//! - `keyText` / `keyCode` / `frontmostPid`: the core's typing and shortcuts, one key event at a
//!   time (the app paces them and checks which app has the keyboard before each).
//! - `frontWindowOwner`: which process owns the frontmost window at a point (so a click never lands
//!   on Dune Bot itself, while one of its windows behind another app's doesn't count).

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

#[cfg(target_os = "macos")]
mod mac {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::NSString;
    use std::sync::{Mutex, mpsc};

    /// What the last "allow notifications?" request answered (the block runs on another thread).
    pub static REQUEST_RESULT: Mutex<Option<String>> = Mutex::new(None);
    use std::time::Duration;

    unsafe fn string(s: *mut NSString) -> String {
        if s.is_null() { "?".into() } else { unsafe { (*s).to_string() } }
    }

    unsafe fn appearance(obj: *mut AnyObject) -> String {
        unsafe {
            let a: *mut AnyObject = msg_send![obj, effectiveAppearance];
            if a.is_null() {
                return "?".into();
            }
            string(msg_send![a, name]).trim_start_matches("NSAppearanceName").to_string()
        }
    }

    unsafe fn find_glass(view: *mut AnyObject) -> *mut AnyObject {
        unsafe {
            let subviews: *mut AnyObject = msg_send![view, subviews];
            let count: usize = msg_send![subviews, count];
            for i in 0..count {
                let v: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
                let name = string(msg_send![v, className]);
                if name == "NSGlassEffectView" {
                    return v;
                }
            }
            std::ptr::null_mut()
        }
    }

    pub unsafe fn set_glass_radius(view: *mut AnyObject, radius: f64) -> bool {
        unsafe {
            let glass = find_glass(view);
            if glass.is_null() {
                return false;
            }
            let _: () = msg_send![glass, setCornerRadius: radius];
            let layer: *mut AnyObject = msg_send![glass, layer];
            if !layer.is_null() {
                let _: () = msg_send![layer, setCornerRadius: radius];
            }
            true
        }
    }

    pub unsafe fn set_glass_tint(view: *mut AnyObject, alpha: f64, dark: bool) -> bool {
        unsafe {
            let glass = find_glass(view);
            if glass.is_null() {
                return false;
            }
            let sel = objc2::runtime::Sel::register(c"setTintColor:");
            let ok: bool = msg_send![glass, respondsToSelector: sel];
            if !ok {
                return false;
            }
            let tint: *mut AnyObject = if alpha <= 0.0 {
                std::ptr::null_mut()
            } else {
                let Some(cls) = AnyClass::get(c"NSColor") else { return false };
                // Dark: the page's dark paper, #1c1c1e. Light: white (frosted white glass).
                let (r, g, b) = if dark { (28.0, 28.0, 30.0) } else { (255.0, 255.0, 255.0) };
                msg_send![cls, colorWithSRGBRed: r / 255.0, green: g / 255.0, blue: b / 255.0, alpha: alpha.min(1.0)]
            };
            let _: () = msg_send![glass, setTintColor: tint];
            true
        }
    }

    pub unsafe fn glass_info(view: *mut AnyObject) -> String {
        unsafe {
            let glass = find_glass(view);
            if glass.is_null() {
                return "no glass view under this window".into();
            }
            let responds = |name: &std::ffi::CStr| -> bool {
                let sel = objc2::runtime::Sel::register(name);
                msg_send![glass, respondsToSelector: sel]
            };
            let variant = if responds(c"_variant") {
                let v: isize = msg_send![glass, _variant];
                v.to_string()
            } else {
                "unreadable".into()
            };
            let radius: f64 = msg_send![glass, cornerRadius];
            let tint = if responds(c"tintColor") {
                let t: *mut AnyObject = msg_send![glass, tintColor];
                if t.is_null() {
                    "none".to_string()
                } else {
                    let a: f64 = msg_send![t, alphaComponent];
                    format!("{a:.2}")
                }
            } else {
                "unreadable".into()
            };
            format!(
                "style switch {}, style {variant}, radius {radius:.0}, tint {tint}, appearance {}",
                if responds(c"set_variant:") { "present" } else { "MISSING (styles do nothing)" },
                appearance(glass)
            )
        }
    }

    /// "light" | "dark" | anything else = follow the system.
    pub unsafe fn set_window_appearance(view: *mut AnyObject, which: &str) -> bool {
        unsafe {
            let window: *mut AnyObject = msg_send![view, window];
            let Some(cls) = AnyClass::get(c"NSAppearance") else { return false };
            if window.is_null() {
                return false;
            }
            let look: *mut AnyObject = match which {
                "light" => msg_send![cls, appearanceNamed: &*NSString::from_str("NSAppearanceNameAqua")],
                "dark" => msg_send![cls, appearanceNamed: &*NSString::from_str("NSAppearanceNameDarkAqua")],
                _ => std::ptr::null_mut(),
            };
            let _: () = msg_send![window, setAppearance: look];
            true
        }
    }

    /// Light/dark the window is drawn in right now (follows the system unless an app forces it).
    pub unsafe fn window_appearance(view: *mut AnyObject) -> String {
        unsafe {
            let window: *mut AnyObject = msg_send![view, window];
            if window.is_null() { "?".into() } else { appearance(window) }
        }
    }

    unsafe fn center() -> Result<*mut AnyObject, String> {
        let Some(cls) = AnyClass::get(c"UNUserNotificationCenter") else {
            return Err("notifications aren't available".into());
        };
        let c: *mut AnyObject = unsafe { msg_send![cls, currentNotificationCenter] };
        if c.is_null() { Err("no notification center".into()) } else { Ok(c) }
    }

    pub unsafe fn notification_status() -> Result<String, String> {
        let c = unsafe { center()? };
        let (tx, rx) = mpsc::channel::<isize>();
        let block = RcBlock::new(move |settings: *mut AnyObject| {
            let status: isize = if settings.is_null() { -1 } else { unsafe { msg_send![settings, authorizationStatus] } };
            let _ = tx.send(status);
        });
        unsafe {
            let _: () = msg_send![c, getNotificationSettingsWithCompletionHandler: &*block];
        }
        let status = rx.recv_timeout(Duration::from_millis(1500)).map_err(|_| "no answer from the notification center".to_string())?;
        Ok(match status {
            0 => "not-determined",
            1 => "denied",
            2 | 3 | 4 => "granted", // authorized, provisional, ephemeral
            _ => "unknown",
        }
        .into())
    }

    /// Shows the system's "allow notifications?" box (only the first time). Doesn't wait for the answer.
    pub unsafe fn request_notifications() -> Result<(), String> {
        let c = unsafe { center()? };
        let block = RcBlock::new(|granted: Bool, error: *mut AnyObject| {
            let what = if !error.is_null() {
                let d: *mut NSString = unsafe { msg_send![error, localizedDescription] };
                format!("error: {}", unsafe { string(d) })
            } else if granted.as_bool() {
                "granted".into()
            } else {
                "declined".into()
            };
            *REQUEST_RESULT.lock().unwrap() = Some(what);
        });
        const BADGE: usize = 1;
        const SOUND: usize = 2;
        const ALERT: usize = 4;
        unsafe {
            let _: () = msg_send![c, requestAuthorizationWithOptions: BADGE | SOUND | ALERT, completionHandler: &*block];
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn view_of(handle: &Buffer) -> napi::Result<*mut objc2::runtime::AnyObject> {
    if handle.len() < std::mem::size_of::<usize>() {
        return Err(napi::Error::from_reason("bad window handle"));
    }
    Ok(unsafe { *(handle.as_ptr() as *const *mut objc2::runtime::AnyObject) })
}

/// "DarkAqua", "Aqua", … for the window `handle` belongs to.
#[napi]
pub fn window_appearance(handle: Buffer) -> napi::Result<String> {
    #[cfg(target_os = "macos")]
    {
        let view = view_of(&handle)?;
        Ok(unsafe { mac::window_appearance(view) })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = handle;
        Ok("?".into())
    }
}

/// Draws the window `handle` belongs to "light" or "dark" whatever the system says ("" follows it).
#[napi]
pub fn set_window_appearance(handle: Buffer, which: String) -> napi::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        let view = view_of(&handle)?;
        Ok(unsafe { mac::set_window_appearance(view, &which) })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (handle, which);
        Ok(false)
    }
}

/// Apple's glass view under the window `handle` belongs to, read back for the log.
#[napi]
pub fn glass_info(handle: Buffer) -> napi::Result<String> {
    #[cfg(target_os = "macos")]
    {
        let view = view_of(&handle)?;
        Ok(unsafe { mac::glass_info(view) })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = handle;
        Ok("no glass".into())
    }
}

/// Sets the corner radius of the glass under the window `handle` belongs to. False: no glass there.
#[napi]
pub fn set_glass_radius(handle: Buffer, radius: f64) -> napi::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        let view = view_of(&handle)?;
        Ok(unsafe { mac::set_glass_radius(view, radius) })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (handle, radius);
        Ok(false)
    }
}

/// Tints the glass under the window `handle` belongs to (0 = no tint). False: no glass there.
#[napi]
pub fn set_glass_tint(handle: Buffer, alpha: f64, dark: bool) -> napi::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        let view = view_of(&handle)?;
        Ok(unsafe { mac::set_glass_tint(view, alpha, dark) })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (handle, alpha, dark);
        Ok(false)
    }
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// macOS: shows the system's Screen Recording box (the first time only) and adds this app to the
/// list in System Settings. True when it is already allowed. Other systems: true.
#[napi]
pub fn request_screen_access() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { CGRequestScreenCaptureAccess() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// The way a person moves a mouse to a point: a gentle curve to one side, slow to start and to stop
/// (minimum-jerk easing), longer for longer moves, with a little tremor on the way. Pure: the same
/// seed gives the same path.
pub mod glide {
    /// One step of the path every this many milliseconds (about 120 a second).
    pub const STEP_MS: u64 = 8;

    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct Pt {
        pub x: f64,
        pub y: f64,
    }

    /// Xorshift: enough to vary each move a little.
    pub struct Rng(pub u64);
    impl Rng {
        pub fn next(&mut self) -> u64 {
            let mut x = self.0.max(1);
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
        pub fn range(&mut self, a: f64, b: f64) -> f64 {
            a + (b - a) * ((self.next() >> 11) as f64 / (1u64 << 53) as f64)
        }
    }

    pub fn dist(a: Pt, b: Pt) -> f64 {
        ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt()
    }

    /// The points after `from`, one per step, ending exactly on `to`.
    pub fn path(from: Pt, to: Pt, seed: u64) -> Vec<Pt> {
        let mut r = Rng(seed);
        let (dx, dy) = (to.x - from.x, to.y - from.y);
        let d = (dx * dx + dy * dy).sqrt();
        if !d.is_finite() || d < 2.0 {
            return vec![to];
        }
        // Unhurried: about 0.55 s for a short move, up to 1.4 s across a big screen.
        let ms = (450.0 + 0.55 * d).clamp(550.0, 1400.0) * r.range(0.92, 1.08);
        let steps = ((ms / STEP_MS as f64).round() as usize).max(2);
        // The bow: the curve's middle sits a little off the straight line, to a random side.
        let side = if r.next() & 1 == 0 { 1.0 } else { -1.0 };
        let bow = (d * r.range(0.06, 0.16)).min(90.0) * side;
        let c = Pt { x: from.x + dx * 0.5 - dy / d * bow, y: from.y + dy * 0.5 + dx / d * bow };
        let mut out = Vec::with_capacity(steps);
        for i in 1..=steps {
            let t = i as f64 / steps as f64;
            let e = t * t * t * (10.0 - 15.0 * t + 6.0 * t * t);
            let u = 1.0 - e;
            let mut p = Pt { x: u * u * from.x + 2.0 * u * e * c.x + e * e * to.x, y: u * u * from.y + 2.0 * u * e * c.y + e * e * to.y };
            if i < steps {
                p.x += r.range(-0.35, 0.35);
                p.y += r.range(-0.35, 0.35);
            } else {
                p = to;
            }
            out.push(p);
        }
        out
    }
}

/// The path a click would take, as [x0, y0, x1, y1, …] one step apart (for checks: nothing moves).
#[napi]
pub fn click_path(from_x: f64, from_y: f64, to_x: f64, to_y: f64, seed: f64) -> Vec<f64> {
    glide::path(glide::Pt { x: from_x, y: from_y }, glide::Pt { x: to_x, y: to_y }, seed as u64)
        .into_iter()
        .flat_map(|p| [p.x, p.y])
        .collect()
}

/// Clicking for the user (the core's `click` tool): Quartz events, the same a mouse sends.
#[cfg(target_os = "macos")]
mod input {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGPoint {
        pub x: f64,
        pub y: f64,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        pub fn CGPreflightPostEventAccess() -> bool;
        pub fn CGRequestPostEventAccess() -> bool;
        pub fn CGEventCreate(source: *const c_void) -> *mut c_void;
        pub fn CGEventGetLocation(event: *const c_void) -> CGPoint;
        pub fn CGEventCreateMouseEvent(source: *const c_void, kind: u32, at: CGPoint, button: u32) -> *mut c_void;
        pub fn CGEventSetIntegerValueField(event: *mut c_void, field: u32, value: i64);
        pub fn CGEventPost(tap: u32, event: *mut c_void);
        pub fn CGEventCreateKeyboardEvent(source: *const c_void, key: u16, down: bool) -> *mut c_void;
        pub fn CGEventKeyboardSetUnicodeString(event: *mut c_void, length: usize, chars: *const u16);
        pub fn CGEventSetFlags(event: *mut c_void, flags: u64);
        pub fn CGEventCreateScrollWheelEvent2(source: *const c_void, units: u32, count: u32, wheel1: i32, wheel2: i32, wheel3: i32) -> *mut c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        pub fn CFRelease(cf: *const c_void);
    }

    const MOUSE_MOVED: u32 = 5;
    const LEFT_DRAGGED: u32 = 6;
    const CLICK_STATE: u32 = 1; // kCGMouseEventClickState
    const HID_TAP: u32 = 0; // kCGHIDEventTap

    /// One mouse event at `at`, posted as the mouse would. False when it couldn't be made.
    fn post(kind: u32, at: CGPoint, button: u32, clicks: i64) -> bool {
        unsafe {
            let e = CGEventCreateMouseEvent(std::ptr::null(), kind, at, button);
            if e.is_null() {
                return false;
            }
            if clicks > 0 {
                CGEventSetIntegerValueField(e, CLICK_STATE, clicks);
            }
            CGEventPost(HID_TAP, e);
            CFRelease(e);
        }
        true
    }

    fn pause(ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }

    /// Where the pointer is now.
    fn location() -> Option<CGPoint> {
        unsafe {
            let e = CGEventCreate(std::ptr::null());
            if e.is_null() {
                return None;
            }
            let p = CGEventGetLocation(e);
            CFRelease(e);
            Some(p)
        }
    }

    pub const DONE: i32 = 0;
    pub const FAILED: i32 = 1;
    /// The user moved the mouse while Dune Bot moved it: stopped, nothing clicked.
    pub const TAKEN: i32 = 2;

    fn seed() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(7)
    }

    /// Whether the pointer is now more than a hand's twitch from `at` (the user took the mouse).
    fn moved_from(at: CGPoint) -> bool {
        use crate::glide::{dist, Pt};
        location().is_some_and(|now| dist(Pt { x: now.x, y: now.y }, Pt { x: at.x, y: at.y }) > 24.0)
    }

    /// Glides the pointer to `to` as a hand would (with the left button held: a drag). Stops if the
    /// user moves the mouse on the way.
    pub fn glide(to: CGPoint, held: bool) -> i32 {
        use crate::glide::{dist, path, Pt, Rng, STEP_MS};
        let Some(from) = location() else { return FAILED };
        let mut r = Rng(seed());
        let kind = if held { LEFT_DRAGGED } else { MOUSE_MOVED };
        // The last places Dune Bot put the pointer: anywhere far from all of them is the user's hand
        // (the system reports a posted move a step or two late).
        let mut ours: Vec<Pt> = vec![Pt { x: from.x, y: from.y }];
        let taken = |ours: &[Pt]| location().is_some_and(|now| ours.iter().all(|q| dist(Pt { x: now.x, y: now.y }, *q) > 24.0));
        for p in path(Pt { x: from.x, y: from.y }, Pt { x: to.x, y: to.y }, r.next()) {
            if taken(&ours) {
                return TAKEN;
            }
            if !post(kind, CGPoint { x: p.x, y: p.y }, 0, 0) {
                return FAILED;
            }
            ours.push(p);
            if ours.len() > 8 {
                ours.remove(0);
            }
            pause(STEP_MS);
        }
        DONE
    }

    /// Rests on `at` a moment, as a person checks what's under the pointer, then clicks `count`
    /// times (2: a double click) at a finger's pace. Nothing if the user moved the mouse meanwhile.
    pub fn press(at: CGPoint, right: bool, count: i64) -> i32 {
        let mut r = crate::glide::Rng(seed());
        let (button, down, up) = if right { (1, 3, 4) } else { (0, 1, 2) };
        pause(r.range(150.0, 260.0) as u64);
        if moved_from(at) {
            return TAKEN;
        }
        for n in 1..=count {
            if !post(down, at, button, n) {
                return FAILED;
            }
            pause(r.range(60.0, 110.0) as u64);
            if !post(up, at, button, n) {
                return FAILED;
            }
            if n < count {
                pause(r.range(80.0, 130.0) as u64);
            }
        }
        DONE
    }

    /// The left button down or up at `at`, nothing else (a drag's two ends).
    pub fn button(at: CGPoint, down: bool) -> bool {
        post(if down { 1 } else { 2 }, at, 0, 1)
    }

    /// Turns the wheel under the pointer at `at`, `notches` times, each about 50 points
    /// (`dx`/`dy` -1, 0 or 1: +1 is up or left), in small smooth pieces as a trackpad does. Stops if
    /// the user moves the mouse.
    pub fn scroll(at: CGPoint, dx: i32, dy: i32, notches: u32) -> i32 {
        let mut r = crate::glide::Rng(seed());
        for _ in 0..notches {
            if moved_from(at) {
                return TAKEN;
            }
            for _ in 0..4 {
                let step = r.range(11.0, 14.0) as i32;
                let e = unsafe { CGEventCreateScrollWheelEvent2(std::ptr::null(), 0, 2, dy * step, dx * step, 0) };
                if e.is_null() {
                    return FAILED;
                }
                unsafe {
                    CGEventPost(HID_TAP, e);
                    CFRelease(e);
                }
                pause(r.range(10.0, 15.0) as u64);
            }
            pause(r.range(40.0, 90.0) as u64);
        }
        DONE
    }

    /// One key event that types `text` (a character or two, whatever the keyboard layout), with no
    /// modifier keys.
    pub fn key_text(text: &str, down: bool) -> bool {
        let units: Vec<u16> = text.encode_utf16().collect();
        if units.is_empty() || units.len() > 20 {
            return false;
        }
        unsafe {
            let e = CGEventCreateKeyboardEvent(std::ptr::null(), 0, down);
            if e.is_null() {
                return false;
            }
            CGEventSetFlags(e, 0);
            CGEventKeyboardSetUnicodeString(e, units.len(), units.as_ptr());
            CGEventPost(HID_TAP, e);
            CFRelease(e);
        }
        true
    }

    /// One key (a macOS virtual key code) down or up, with these modifier flags held. Only the
    /// key's own event carries them: no modifier key is pressed on its own.
    pub fn key_code(code: u16, flags: u64, down: bool) -> bool {
        unsafe {
            let e = CGEventCreateKeyboardEvent(std::ptr::null(), code, down);
            if e.is_null() {
                return false;
            }
            CGEventSetFlags(e, flags);
            CGEventPost(HID_TAP, e);
            CFRelease(e);
        }
        true
    }

    /// Brings the app with this process id to the front (Dune Bot gives the keyboard back to the app
    /// the user was in before they typed in the bar). False when there's no such app.
    pub fn activate(pid: i32) -> bool {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};
        unsafe {
            let Some(cls) = AnyClass::get(c"NSRunningApplication") else { return false };
            let app: *mut AnyObject = msg_send![cls, runningApplicationWithProcessIdentifier: pid];
            if app.is_null() {
                return false;
            }
            let ok: bool = msg_send![app, activateWithOptions: 0usize];
            ok
        }
    }

    /// The process of the app in front (the one that gets the keyboard), or -1.
    pub fn frontmost_pid() -> i64 {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};
        unsafe {
            let Some(cls) = AnyClass::get(c"NSWorkspace") else { return -1 };
            let ws: *mut AnyObject = msg_send![cls, sharedWorkspace];
            if ws.is_null() {
                return -1;
            }
            let app: *mut AnyObject = msg_send![ws, frontmostApplication];
            if app.is_null() {
                return -1;
            }
            let pid: i32 = msg_send![app, processIdentifier];
            pid as i64
        }
    }
}

/// macOS: whether this app may use the mouse and keyboard for the user (it's on in System Settings ›
/// Privacy & Security › Accessibility). With `ask`, macOS shows its box the first time (and lists the
/// app there). Other systems: false (not there yet).
#[napi]
pub fn post_event_access(ask: bool) -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { if ask { input::CGRequestPostEventAccess() } else { input::CGPreflightPostEventAccess() } }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = ask;
        false
    }
}

#[cfg(target_os = "macos")]
mod front {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_foundation::NSString;
    use std::ffi::c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *const c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(cf: *const c_void);
    }
    const ON_SCREEN_ONLY: u32 = 1;
    const EXCLUDE_DESKTOP: u32 = 16;

    unsafe fn get(dict: *mut AnyObject, key: &str) -> *mut AnyObject {
        unsafe { msg_send![dict, objectForKey: &*NSString::from_str(key)] }
    }
    unsafe fn num(obj: *mut AnyObject) -> Option<f64> {
        if obj.is_null() { None } else { Some(unsafe { msg_send![obj, doubleValue] }) }
    }

    /// The window number of the window a view is in, or -1.
    pub unsafe fn window_number(view: *mut AnyObject) -> i64 {
        unsafe {
            let w: *mut AnyObject = msg_send![view, window];
            if w.is_null() { -1 } else { msg_send![w, windowNumber] }
        }
    }

    /// The owner of the frontmost visible window at (x, y), in the screen's top-left points (what a
    /// click there would reach), passing over the windows in `skip`. -1: none.
    pub unsafe fn owner_at(x: f64, y: f64, skip: &[i64]) -> i64 {
        unsafe {
            let list = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0) as *mut AnyObject;
            if list.is_null() {
                return -1;
            }
            let mut owner = -1;
            let count: usize = msg_send![list, count];
            for i in 0..count {
                let w: *mut AnyObject = msg_send![list, objectAtIndex: i];
                if num(get(w, "kCGWindowAlpha")).unwrap_or(1.0) <= 0.0 {
                    continue;
                }
                if num(get(w, "kCGWindowNumber")).is_some_and(|n| skip.contains(&(n as i64))) {
                    continue;
                }
                let b = get(w, "kCGWindowBounds");
                if b.is_null() {
                    continue;
                }
                let (Some(bx), Some(by), Some(bw), Some(bh)) = (num(get(b, "X")), num(get(b, "Y")), num(get(b, "Width")), num(get(b, "Height"))) else {
                    continue;
                };
                if x >= bx && x < bx + bw && y >= by && y < by + bh {
                    owner = num(get(w, "kCGWindowOwnerPID")).map(|p| p as i64).unwrap_or(-1);
                    break;
                }
            }
            CFRelease(list as *const c_void);
            owner
        }
    }
}

/// macOS: the process id that owns the frontmost visible window at (x, y) (top-left screen points),
/// passing over the windows of `skip` (Electron window handles); -1 when there is none. Other
/// systems: -2 (not known).
#[napi]
pub fn front_window_owner(x: f64, y: f64, skip: Vec<Buffer>) -> napi::Result<i64> {
    #[cfg(target_os = "macos")]
    {
        let mut numbers = Vec::with_capacity(skip.len());
        for h in &skip {
            numbers.push(unsafe { front::window_number(view_of(h)?) });
        }
        Ok(unsafe { front::owner_at(x, y, &numbers) })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (x, y, skip);
        Ok(-2)
    }
}

/// One step of the mouse, off Electron's main thread (it waits between the mouse's events).
pub enum Pointer {
    Glide { x: f64, y: f64, held: bool },
    Press { x: f64, y: f64, right: bool, count: u32 },
    Scroll { x: f64, y: f64, dx: i32, dy: i32, notches: u32 },
}

pub struct PointerTask(Pointer);

impl napi::Task for PointerTask {
    type Output = i32;
    type JsValue = i32;

    fn compute(&mut self) -> napi::Result<i32> {
        #[cfg(target_os = "macos")]
        {
            let at = |x: f64, y: f64| (x.is_finite() && y.is_finite()).then_some(input::CGPoint { x, y });
            Ok(match self.0 {
                Pointer::Glide { x, y, held } => at(x, y).map_or(input::FAILED, |p| input::glide(p, held)),
                Pointer::Press { x, y, right, count } => at(x, y).map_or(input::FAILED, |p| input::press(p, right, count.clamp(1, 2) as i64)),
                Pointer::Scroll { x, y, dx, dy, notches } => {
                    at(x, y).map_or(input::FAILED, |p| input::scroll(p, dx.signum(), dy.signum(), notches.clamp(1, 30)))
                }
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            Ok(1)
        }
    }

    fn resolve(&mut self, _env: napi::Env, output: i32) -> napi::Result<i32> {
        Ok(output)
    }
}

/// macOS: glides the pointer to a point on the screen (points from the top left of the main display)
/// as a person would, with the left button held when `held` (a drag). Resolves 0 when there, 2 when
/// the user moved the mouse on the way (it stopped), 1 when the events couldn't be made. Other
/// systems: 1.
#[napi]
pub fn pointer_glide(x: f64, y: f64, held: bool) -> napi::bindgen_prelude::AsyncTask<PointerTask> {
    napi::bindgen_prelude::AsyncTask::new(PointerTask(Pointer::Glide { x, y, held }))
}

/// macOS: rests on the point a moment, then clicks there (a double click with `count` 2, the right
/// button with `right`). Resolves 0 when clicked, 2 when the user moved the mouse meanwhile (nothing
/// clicked), 1 when the events couldn't be made. Other systems: 1.
#[napi]
pub fn pointer_press(x: f64, y: f64, right: bool, count: u32) -> napi::bindgen_prelude::AsyncTask<PointerTask> {
    napi::bindgen_prelude::AsyncTask::new(PointerTask(Pointer::Press { x, y, right, count }))
}

/// macOS: the left button down or up at the point, nothing more (a drag's two ends). False when the
/// event couldn't be made, and on other systems.
#[napi]
pub fn pointer_button(x: f64, y: f64, down: bool) -> bool {
    #[cfg(target_os = "macos")]
    {
        x.is_finite() && y.is_finite() && input::button(input::CGPoint { x, y }, down)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (x, y, down);
        false
    }
}

/// macOS: turns the wheel at the point (the pointer must be there), `notches` times of about 50
/// points; `dy` 1 scrolls up, -1 down; `dx` 1 left, -1 right. Resolves 0 when done, 2 when the user
/// moved the mouse (it stopped), 1 when the events couldn't be made. Other systems: 1.
#[napi]
pub fn scroll_at(x: f64, y: f64, dx: i32, dy: i32, notches: u32) -> napi::bindgen_prelude::AsyncTask<PointerTask> {
    napi::bindgen_prelude::AsyncTask::new(PointerTask(Pointer::Scroll { x, y, dx, dy, notches }))
}

/// macOS: one key event typing `text` (one character), down or up, into whatever has the keyboard.
/// False when it couldn't be made, and on other systems.
#[napi]
pub fn key_text(text: String, down: bool) -> bool {
    #[cfg(target_os = "macos")]
    {
        input::key_text(&text, down)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (text, down);
        false
    }
}

/// macOS: one key (its virtual key code) down or up, with modifier flags (shift 0x20000, control
/// 0x40000, option 0x80000, command 0x100000) on that event only. False when it couldn't be made,
/// and on other systems.
#[napi]
pub fn key_code(code: u32, flags: f64, down: bool) -> bool {
    #[cfg(target_os = "macos")]
    {
        code < 128 && flags.is_finite() && flags >= 0.0 && input::key_code(code as u16, flags as u64 & 0x1E_0000, down)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (code, flags, down);
        false
    }
}

/// macOS: brings the app with this process id to the front. False when there's no such app, and on
/// other systems.
#[napi]
pub fn activate_app(pid: i32) -> bool {
    #[cfg(target_os = "macos")]
    {
        pid > 0 && pid as u32 != std::process::id() && input::activate(pid)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pid;
        false
    }
}

/// macOS: the process id of the app in front (the one the keyboard types into), -1 when none.
/// Other systems: -2.
#[napi]
pub fn frontmost_pid() -> i64 {
    #[cfg(target_os = "macos")]
    {
        input::frontmost_pid()
    }
    #[cfg(not(target_os = "macos"))]
    {
        -2
    }
}

/// What the last notification request answered ("granted", "declined", "error: …"), once.
#[napi]
pub fn notification_request_result() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        mac::REQUEST_RESULT.lock().unwrap().take()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// "not-determined" | "denied" | "granted" | "unknown".
#[napi]
pub fn notification_status() -> napi::Result<String> {
    #[cfg(target_os = "macos")]
    {
        unsafe { mac::notification_status() }.map_err(napi::Error::from_reason)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok("granted".into())
    }
}

#[napi]
pub fn request_notifications() -> napi::Result<()> {
    #[cfg(target_os = "macos")]
    {
        unsafe { mac::request_notifications() }.map_err(napi::Error::from_reason)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

/// Where this Mac is, from macOS Location Services. A Mac has no GPS: macOS works it out from the
/// Wi-Fi networks nearby (with Wi-Fi off, the answer is rough or there is none). Asked "while using"
/// the app; macOS shows its own box the first time. `locationStart` begins, `locationPoll` says how
/// far it got (JSON), `locationName` asks Apple's geocoder for the area of the best position so far,
/// and `locationStop` ends the updates. Only the latest answer is kept, in memory.
#[cfg(target_os = "macos")]
mod location {
    use block2::RcBlock;
    use objc2::encode::{Encode, Encoding};
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject, Bool, NSObject};
    use objc2::{ClassType, define_class, msg_send};
    use objc2_foundation::NSString;
    use std::cell::RefCell;
    use std::sync::{Mutex, MutexGuard};

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Coordinate {
        latitude: f64,
        longitude: f64,
    }
    unsafe impl Encode for Coordinate {
        const ENCODING: Encoding = Encoding::Struct("CLLocationCoordinate2D", &[f64::ENCODING, f64::ENCODING]);
    }

    #[link(name = "CoreLocation", kind = "framework")]
    unsafe extern "C" {
        static kCLLocationAccuracyBest: f64;
    }

    /// A position older than this is macOS's memory of an earlier one, not where the Mac is now.
    const STALE_SECS: f64 = 120.0;

    #[derive(Default, Clone)]
    pub struct State {
        /// "waiting" (no answer yet), "asking" (macOS's box is up), "located", "denied", "off",
        /// "nokey" (this app's Info.plist gives macOS no reason to show, so it can't ask), "error"
        pub status: String,
        /// latitude, longitude, accuracy in metres, seconds old when it came
        pub fix: Option<(f64, f64, f64, f64)>,
        pub fixes: u32,
        /// The area's name for `named` (the fix it was asked for), "" when the geocoder had none.
        pub area: Option<String>,
        pub named: Option<(f64, f64)>,
        pub naming: bool,
        pub message: Option<String>,
    }
    pub static STATE: Mutex<Option<State>> = Mutex::new(None);

    fn lock() -> MutexGuard<'static, Option<State>> {
        STATE.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn update(f: impl FnOnce(&mut State)) {
        f(lock().get_or_insert_with(State::default));
    }

    unsafe fn text(s: *mut NSString) -> Option<String> {
        if s.is_null() { None } else { Some(unsafe { (*s).to_string() }).filter(|t| !t.trim().is_empty()) }
    }

    /// CLAuthorizationStatus: 0 not asked, 1 restricted, 2 denied, 3 always, 4 while using.
    unsafe fn authorization(manager: &AnyObject) -> i32 {
        unsafe { msg_send![manager, authorizationStatus] }
    }

    unsafe fn on_location(location: *mut AnyObject) {
        if location.is_null() {
            return;
        }
        let c: Coordinate = unsafe { msg_send![location, coordinate] };
        let accuracy: f64 = unsafe { msg_send![location, horizontalAccuracy] };
        let when: *mut AnyObject = unsafe { msg_send![location, timestamp] };
        let age = if when.is_null() {
            0.0
        } else {
            let since: f64 = unsafe { msg_send![when, timeIntervalSinceNow] };
            -since
        };
        if accuracy < 0.0 || !c.latitude.is_finite() || !c.longitude.is_finite() || age > STALE_SECS {
            return;
        }
        update(|s| {
            s.fixes += 1;
            s.status = "located".into();
            if s.fix.is_none_or(|(_, _, a, _)| accuracy <= a) {
                s.fix = Some((c.latitude, c.longitude, accuracy, age.max(0.0)));
            }
        });
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "DunebotLocationDelegate"]
        struct Delegate;

        impl Delegate {
            #[unsafe(method(locationManager:didUpdateLocations:))]
            fn did_update(&self, _manager: *mut AnyObject, locations: *mut AnyObject) {
                if locations.is_null() {
                    return;
                }
                let count: usize = unsafe { msg_send![locations, count] };
                for i in 0..count {
                    let l: *mut AnyObject = unsafe { msg_send![locations, objectAtIndex: i] };
                    unsafe { on_location(l) };
                }
            }

            #[unsafe(method(locationManager:didFailWithError:))]
            fn did_fail(&self, _manager: *mut AnyObject, error: *mut AnyObject) {
                if error.is_null() {
                    return;
                }
                // kCLErrorLocationUnknown (0): no position yet, it keeps trying. kCLErrorDenied (1): not allowed.
                let code: isize = unsafe { msg_send![error, code] };
                let message = unsafe { text(msg_send![error, localizedDescription]) };
                update(|s| match code {
                    0 => s.message = Some("macOS has no position yet".into()),
                    1 => s.status = "denied".into(),
                    _ => {
                        if s.fix.is_none() {
                            s.status = "error".into();
                        }
                        s.message = message;
                    }
                });
            }

            #[unsafe(method(locationManagerDidChangeAuthorization:))]
            fn did_change(&self, manager: *mut AnyObject) {
                let Some(manager) = (unsafe { manager.as_ref() }) else { return };
                match unsafe { authorization(manager) } {
                    3 | 4 => {
                        update(|s| {
                            if s.status == "asking" {
                                s.status = "waiting".into();
                            }
                        });
                        unsafe {
                            let _: () = msg_send![manager, startUpdatingLocation];
                        }
                    }
                    1 | 2 => update(|s| s.status = "denied".into()),
                    _ => {}
                }
            }
        }
    );

    thread_local! {
        /// The manager and its delegate, made on the main thread (their answers come there too).
        static MANAGER: RefCell<Option<(Retained<AnyObject>, Retained<Delegate>)>> = const { RefCell::new(None) };
        /// The geocoder at work: it must live until it answers.
        static GEOCODER: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    }

    fn manager() -> Result<Retained<AnyObject>, String> {
        MANAGER.with(|m| {
            if let Some((manager, _)) = m.borrow().as_ref() {
                return Ok(manager.clone());
            }
            let cls = AnyClass::get(c"CLLocationManager").ok_or("CoreLocation isn't here")?;
            let manager: Retained<AnyObject> = unsafe { msg_send![cls, new] };
            let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::class(), new] };
            unsafe {
                let _: () = msg_send![&*manager, setDesiredAccuracy: kCLLocationAccuracyBest];
            }
            *m.borrow_mut() = Some((manager.clone(), delegate));
            Ok(manager)
        })
    }

    /// Whether this app's Info.plist has the reason macOS shows in its "allow?" box (without one,
    /// macOS never shows the box and never answers).
    fn has_reason() -> bool {
        let Some(cls) = AnyClass::get(c"NSBundle") else { return false };
        let main: *mut AnyObject = unsafe { msg_send![cls, mainBundle] };
        if main.is_null() {
            return false;
        }
        ["NSLocationWhenInUseUsageDescription", "NSLocationUsageDescription"].iter().any(|k| {
            let key = NSString::from_str(k);
            let v: *mut AnyObject = unsafe { msg_send![main, objectForInfoDictionaryKey: &*key] };
            !v.is_null()
        })
    }

    pub fn start() -> Result<(), String> {
        let cls = AnyClass::get(c"CLLocationManager").ok_or("CoreLocation isn't here")?;
        *lock() = Some(State { status: "waiting".into(), ..Default::default() });
        if !has_reason() {
            update(|s| s.status = "nokey".into());
            return Ok(());
        }
        let enabled: Bool = unsafe { msg_send![cls, locationServicesEnabled] };
        if !enabled.as_bool() {
            update(|s| s.status = "off".into());
            return Ok(());
        }
        let manager = manager()?;
        // The delegate is set here, outside any borrow: setting it makes macOS report the permission at once.
        MANAGER.with(|m| {
            if let Some((_, delegate)) = m.borrow().as_ref() {
                let d: &AnyObject = delegate;
                unsafe {
                    let _: () = msg_send![&*manager, setDelegate: d];
                }
            }
        });
        match unsafe { authorization(&manager) } {
            0 => {
                update(|s| s.status = "asking".into());
                unsafe {
                    let _: () = msg_send![&*manager, requestWhenInUseAuthorization];
                }
            }
            1 | 2 => update(|s| s.status = "denied".into()),
            _ => unsafe {
                let _: () = msg_send![&*manager, startUpdatingLocation];
            },
        }
        Ok(())
    }

    pub fn stop() {
        let manager = MANAGER.with(|m| m.borrow().as_ref().map(|(m, _)| m.clone()));
        if let Some(manager) = manager {
            unsafe {
                let _: () = msg_send![&*manager, stopUpdatingLocation];
            }
        }
    }

    /// Asks Apple's geocoder (online) for the area around the best position so far.
    pub fn name() -> bool {
        let Some((lat, lon, _, _)) = lock().as_ref().and_then(|s| s.fix) else { return false };
        let (Some(loc_cls), Some(geo_cls)) = (AnyClass::get(c"CLLocation"), AnyClass::get(c"CLGeocoder")) else { return false };
        update(|s| {
            s.naming = true;
            s.area = None;
            s.named = Some((lat, lon));
        });
        let location: Retained<AnyObject> = unsafe {
            let l: Allocated<AnyObject> = msg_send![loc_cls, alloc];
            msg_send![l, initWithLatitude: lat, longitude: lon]
        };
        let geocoder: Retained<AnyObject> = unsafe { msg_send![geo_cls, new] };
        let block = RcBlock::new(move |placemarks: *mut AnyObject, _error: *mut AnyObject| {
            let mut parts: Vec<String> = Vec::new();
            if !placemarks.is_null() {
                let count: usize = unsafe { msg_send![placemarks, count] };
                if count > 0 {
                    let p: *mut AnyObject = unsafe { msg_send![placemarks, objectAtIndex: 0usize] };
                    if !p.is_null() {
                        let fields: [*mut NSString; 6] = unsafe {
                            [
                                msg_send![p, name],
                                msg_send![p, subLocality],
                                msg_send![p, locality],
                                msg_send![p, administrativeArea],
                                msg_send![p, postalCode],
                                msg_send![p, country],
                            ]
                        };
                        for f in fields {
                            if let Some(v) = unsafe { text(f) } {
                                if !parts.contains(&v) {
                                    parts.push(v);
                                }
                            }
                        }
                    }
                }
            }
            update(|s| {
                if s.named == Some((lat, lon)) {
                    s.naming = false;
                    s.area = Some(parts.join(", "));
                }
            });
        });
        unsafe {
            let _: () = msg_send![&*geocoder, reverseGeocodeLocation: &*location, completionHandler: &*block];
        }
        GEOCODER.with(|g| *g.borrow_mut() = Some(geocoder));
        true
    }

    fn quote(t: &str) -> String {
        let mut out = String::from("\"");
        for ch in t.chars() {
            match ch {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out.push('"');
        out
    }

    pub fn poll() -> String {
        let s = lock().clone().unwrap_or_default();
        let mut out = format!("{{\"status\":{},\"fixes\":{},\"naming\":{}", quote(&s.status), s.fixes, s.naming);
        if let Some((lat, lon, acc, age)) = s.fix {
            out.push_str(&format!(",\"latitude\":{lat},\"longitude\":{lon},\"accuracy\":{acc},\"age\":{age:.1}"));
        }
        if let (Some(area), Some((lat, lon))) = (&s.area, s.named) {
            out.push_str(&format!(",\"area\":{},\"areaFor\":[{lat},{lon}]", quote(area)));
        }
        if let Some(m) = &s.message {
            out.push_str(&format!(",\"message\":{}", quote(m)));
        }
        out.push('}');
        out
    }
}

/// Starts finding where this Mac is (see `location`). False on other systems.
#[napi]
pub fn location_start() -> napi::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        location::start().map_err(napi::Error::from_reason)?;
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(false)
    }
}

/// How far finding the location got: {status, fixes, naming, latitude?, longitude?, accuracy?, age?, area?, areaFor?, message?}.
#[napi]
pub fn location_poll() -> String {
    #[cfg(target_os = "macos")]
    {
        location::poll()
    }
    #[cfg(not(target_os = "macos"))]
    {
        "{\"status\":\"unsupported\"}".into()
    }
}

/// Asks for the area's name around the best position so far; false when there is none yet.
#[napi]
pub fn location_name() -> bool {
    #[cfg(target_os = "macos")]
    {
        location::name()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[napi]
pub fn location_stop() {
    #[cfg(target_os = "macos")]
    location::stop()
}

/// One more entry in the import table, built only with `--cfg dunebot_pad` (scripts/native.mjs does
/// that when needed): Xcode 27's linker (ld 27106.1) leaves the symbol-name table 4 bytes off the
/// 8-byte boundary when the table has an odd number of entries, and macOS 27 refuses to load the
/// library ("mis-aligned LINKEDIT string pool").
#[cfg(all(target_os = "macos", dunebot_pad))]
#[unsafe(no_mangle)]
pub extern "C" fn dunebot_native_pad() -> usize {
    unsafe extern "C" {
        fn getppid() -> i32;
    }
    getppid as *const () as usize
}
