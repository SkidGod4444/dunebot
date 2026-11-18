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
//!   Accessibility list; Windows always; Linux on X11 with XTest).
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
/// The mouse and keyboard for the core's click, scroll, drag, type_text and press_keys. The pace (a
/// hand's glide, a finger's press, the wheel's notches) is the same everywhere; `os` posts the events:
/// Quartz on macOS, SendInput on Windows, XTest on Linux (X11, loaded at run time, so a desktop
/// without it only loses this). Points are the system's own: points on macOS, physical pixels on
/// Windows and Linux (the app converts).
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
mod input {
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct Point {
        pub x: f64,
        pub y: f64,
    }

    pub const DONE: i32 = 0;
    pub const FAILED: i32 = 1;
    /// The user moved the mouse while Dune Bot moved it: stopped, nothing clicked.
    pub const TAKEN: i32 = 2;

    fn pause(ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }

    fn seed() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(7)
    }

    /// Whether the pointer is now more than a hand's twitch from `at` (the user took the mouse).
    fn moved_from(at: Point) -> bool {
        use crate::glide::{dist, Pt};
        os::location().is_some_and(|now| dist(Pt { x: now.x, y: now.y }, Pt { x: at.x, y: at.y }) > 24.0)
    }

    /// Glides the pointer to `to` as a hand would (with the left button held: a drag). Stops if the
    /// user moves the mouse on the way.
    pub fn glide(to: Point, held: bool) -> i32 {
        use crate::glide::{dist, path, Pt, Rng, STEP_MS};
        let Some(from) = os::location() else { return FAILED };
        let mut r = Rng(seed());
        // The last places Dune Bot put the pointer: anywhere far from all of them is the user's hand
        // (the system reports a posted move a step or two late).
        let mut ours: Vec<Pt> = vec![Pt { x: from.x, y: from.y }];
        let taken = |ours: &[Pt]| os::location().is_some_and(|now| ours.iter().all(|q| dist(Pt { x: now.x, y: now.y }, *q) > 24.0));
        for p in path(Pt { x: from.x, y: from.y }, Pt { x: to.x, y: to.y }, r.next()) {
            if taken(&ours) {
                return TAKEN;
            }
            if !os::move_to(Point { x: p.x, y: p.y }, held) {
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
    pub fn press(at: Point, right: bool, count: i64) -> i32 {
        let mut r = crate::glide::Rng(seed());
        pause(r.range(150.0, 260.0) as u64);
        if moved_from(at) {
            return TAKEN;
        }
        for n in 1..=count {
            if !os::button(at, right, true, n) {
                return FAILED;
            }
            pause(r.range(60.0, 110.0) as u64);
            if !os::button(at, right, false, n) {
                return FAILED;
            }
            if n < count {
                pause(r.range(80.0, 130.0) as u64);
            }
        }
        DONE
    }

    /// The left button down or up where the pointer is (a drag's two ends).
    pub fn button(at: Point, down: bool) -> bool {
        os::button(at, false, down, 1)
    }

    /// Turns the wheel under the pointer at `at`, `notches` times (`dx`/`dy` -1, 0 or 1: +1 is up or
    /// left). Stops if the user moves the mouse.
    pub fn scroll(at: Point, dx: i32, dy: i32, notches: u32) -> i32 {
        let mut r = crate::glide::Rng(seed());
        for _ in 0..notches {
            if moved_from(at) {
                return TAKEN;
            }
            if !os::wheel_notch(dx, dy, &mut r) {
                return FAILED;
            }
            pause(r.range(40.0, 90.0) as u64);
        }
        DONE
    }

    pub use os::{access, activate, frontmost_pid, key_code, key_text};

    #[cfg(target_os = "macos")]
    pub mod os {
        use super::Point;
        use std::ffi::c_void;

        #[link(name = "CoreGraphics", kind = "framework")]
        unsafe extern "C" {
            pub fn CGPreflightPostEventAccess() -> bool;
            pub fn CGRequestPostEventAccess() -> bool;
            fn CGEventCreate(source: *const c_void) -> *mut c_void;
            fn CGEventGetLocation(event: *const c_void) -> Point;
            fn CGEventCreateMouseEvent(source: *const c_void, kind: u32, at: Point, button: u32) -> *mut c_void;
            fn CGEventSetIntegerValueField(event: *mut c_void, field: u32, value: i64);
            fn CGEventPost(tap: u32, event: *mut c_void);
            fn CGEventCreateKeyboardEvent(source: *const c_void, key: u16, down: bool) -> *mut c_void;
            fn CGEventKeyboardSetUnicodeString(event: *mut c_void, length: usize, chars: *const u16);
            fn CGEventSetFlags(event: *mut c_void, flags: u64);
            fn CGEventCreateScrollWheelEvent2(source: *const c_void, units: u32, count: u32, wheel1: i32, wheel2: i32, wheel3: i32) -> *mut c_void;
        }
        #[link(name = "CoreFoundation", kind = "framework")]
        unsafe extern "C" {
            fn CFRelease(cf: *const c_void);
        }

        const MOUSE_MOVED: u32 = 5;
        const LEFT_DRAGGED: u32 = 6;
        const CLICK_STATE: u32 = 1; // kCGMouseEventClickState
        const HID_TAP: u32 = 0; // kCGHIDEventTap

        /// Posts an event made by `make` (null: it couldn't be made).
        fn post(e: *mut c_void) -> bool {
            if e.is_null() {
                return false;
            }
            unsafe {
                CGEventPost(HID_TAP, e);
                CFRelease(e);
            }
            true
        }

        pub fn access(ask: bool) -> bool {
            unsafe { if ask { CGRequestPostEventAccess() } else { CGPreflightPostEventAccess() } }
        }

        pub fn location() -> Option<Point> {
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

        pub fn move_to(p: Point, held: bool) -> bool {
            post(unsafe { CGEventCreateMouseEvent(std::ptr::null(), if held { LEFT_DRAGGED } else { MOUSE_MOVED }, p, 0) })
        }

        pub fn button(at: Point, right: bool, down: bool, clicks: i64) -> bool {
            let kind = match (right, down) {
                (false, true) => 1,
                (false, false) => 2,
                (true, true) => 3,
                (true, false) => 4,
            };
            unsafe {
                let e = CGEventCreateMouseEvent(std::ptr::null(), kind, at, if right { 1 } else { 0 });
                if !e.is_null() {
                    CGEventSetIntegerValueField(e, CLICK_STATE, clicks);
                }
                post(e)
            }
        }

        /// A notch as a trackpad gives it: about 50 points in four smooth pieces.
        pub fn wheel_notch(dx: i32, dy: i32, r: &mut crate::glide::Rng) -> bool {
            for _ in 0..4 {
                let step = r.range(11.0, 14.0) as i32;
                if !post(unsafe { CGEventCreateScrollWheelEvent2(std::ptr::null(), 0, 2, dy * step, dx * step, 0) }) {
                    return false;
                }
                super::pause(r.range(10.0, 15.0) as u64);
            }
            true
        }

        /// One key event typing `text` (a character or two), with no modifier keys.
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
                post(e)
            }
        }

        /// One key (a virtual key code) with modifier flags on that event only: no modifier key is
        /// pressed on its own.
        pub fn key_code(code: u32, flags: u64, down: bool) -> bool {
            if code >= 128 {
                return false;
            }
            unsafe {
                let e = CGEventCreateKeyboardEvent(std::ptr::null(), code as u16, down);
                if !e.is_null() {
                    CGEventSetFlags(e, flags & 0x1E_0000);
                }
                post(e)
            }
        }

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

        /// Brings the app with this process id to the front (the keyboard goes back to the app the
        /// user was in before they typed in the bar).
        pub fn activate(pid: i32) -> bool {
            use objc2::msg_send;
            use objc2::runtime::{AnyClass, AnyObject};
            unsafe {
                let Some(cls) = AnyClass::get(c"NSRunningApplication") else { return false };
                let app: *mut AnyObject = msg_send![cls, runningApplicationWithProcessIdentifier: pid];
                if app.is_null() {
                    return false;
                }
                msg_send![app, activateWithOptions: 0usize]
            }
        }
    }

    #[cfg(target_os = "windows")]
    pub mod os {
        use super::Point;
        use std::ffi::c_void;

        #[repr(C)]
        #[derive(Clone, Copy)]
        pub struct POINT {
            pub x: i32,
            pub y: i32,
        }
        #[repr(C)]
        #[derive(Clone, Copy)]
        struct MOUSEINPUT {
            dx: i32,
            dy: i32,
            mouse_data: i32,
            flags: u32,
            time: u32,
            extra: usize,
        }
        #[repr(C)]
        #[derive(Clone, Copy)]
        struct KEYBDINPUT {
            vk: u16,
            scan: u16,
            flags: u32,
            time: u32,
            extra: usize,
        }
        #[repr(C)]
        #[derive(Clone, Copy)]
        union INPUT_U {
            mi: MOUSEINPUT,
            ki: KEYBDINPUT,
        }
        #[repr(C)]
        #[derive(Clone, Copy)]
        struct INPUT {
            kind: u32,
            u: INPUT_U,
        }

        #[link(name = "user32")]
        unsafe extern "system" {
            fn SendInput(count: u32, inputs: *const INPUT, size: i32) -> u32;
            fn GetCursorPos(p: *mut POINT) -> i32;
            fn GetSystemMetrics(index: i32) -> i32;
            pub fn WindowFromPoint(p: POINT) -> *mut c_void;
            pub fn GetAncestor(w: *mut c_void, flags: u32) -> *mut c_void;
            pub fn GetWindowThreadProcessId(w: *mut c_void, pid: *mut u32) -> u32;
            fn GetForegroundWindow() -> *mut c_void;
        }

        const INPUT_MOUSE: u32 = 0;
        const INPUT_KEYBOARD: u32 = 1;
        const MOVE: u32 = 0x0001;
        const LEFT_DOWN: u32 = 0x0002;
        const LEFT_UP: u32 = 0x0004;
        const RIGHT_DOWN: u32 = 0x0008;
        const RIGHT_UP: u32 = 0x0010;
        const WHEEL: u32 = 0x0800;
        const HWHEEL: u32 = 0x1000;
        const VIRTUAL_DESK: u32 = 0x4000;
        const ABSOLUTE: u32 = 0x8000;
        const KEY_EXTENDED: u32 = 0x0001;
        const KEY_UP: u32 = 0x0002;
        const KEY_UNICODE: u32 = 0x0004;

        fn send(inputs: &[INPUT]) -> bool {
            unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) == inputs.len() as u32 }
        }
        fn mouse(dx: i32, dy: i32, data: i32, flags: u32) -> INPUT {
            INPUT { kind: INPUT_MOUSE, u: INPUT_U { mi: MOUSEINPUT { dx, dy, mouse_data: data, flags, time: 0, extra: 0 } } }
        }
        fn key(vk: u16, scan: u16, flags: u32) -> INPUT {
            INPUT { kind: INPUT_KEYBOARD, u: INPUT_U { ki: KEYBDINPUT { vk, scan, flags, time: 0, extra: 0 } } }
        }

        /// Windows asks nothing (it only keeps apps from typing into ones run as administrator).
        pub fn access(_ask: bool) -> bool {
            true
        }

        pub fn location() -> Option<Point> {
            let mut p = POINT { x: 0, y: 0 };
            (unsafe { GetCursorPos(&mut p) } != 0).then_some(Point { x: p.x as f64, y: p.y as f64 })
        }

        /// A move to a point of the whole desktop (all screens), in physical pixels.
        pub fn move_to(p: Point, _held: bool) -> bool {
            let (vx, vy, vw, vh) = unsafe { (GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79)) };
            if vw < 2 || vh < 2 {
                return false;
            }
            let nx = ((p.x - vx as f64) * 65535.0 / (vw - 1) as f64).round().clamp(0.0, 65535.0) as i32;
            let ny = ((p.y - vy as f64) * 65535.0 / (vh - 1) as f64).round().clamp(0.0, 65535.0) as i32;
            send(&[mouse(nx, ny, 0, MOVE | ABSOLUTE | VIRTUAL_DESK)])
        }

        /// A button where the pointer is (the glide put it there).
        pub fn button(_at: Point, right: bool, down: bool, _clicks: i64) -> bool {
            let flags = match (right, down) {
                (false, true) => LEFT_DOWN,
                (false, false) => LEFT_UP,
                (true, true) => RIGHT_DOWN,
                (true, false) => RIGHT_UP,
            };
            send(&[mouse(0, 0, 0, flags)])
        }

        /// A notch is one event of 120 units, as a mouse wheel sends it (some apps ignore anything
        /// smaller). + is up; sideways + is right.
        pub fn wheel_notch(dx: i32, dy: i32, _r: &mut crate::glide::Rng) -> bool {
            if dy != 0 { send(&[mouse(0, 0, dy * 120, WHEEL)]) } else { send(&[mouse(0, 0, -dx * 120, HWHEEL)]) }
        }

        pub fn key_text(text: &str, down: bool) -> bool {
            let units: Vec<u16> = text.encode_utf16().collect();
            if units.is_empty() || units.len() > 20 {
                return false;
            }
            let flags = KEY_UNICODE | if down { 0 } else { KEY_UP };
            let inputs: Vec<INPUT> = units.iter().map(|u| key(0, *u, flags)).collect();
            send(&inputs)
        }

        /// One key (a virtual key code; `flags` 1: an extended key, like the arrows). Modifiers are
        /// pressed as keys of their own by the app.
        pub fn key_code(code: u32, flags: u64, down: bool) -> bool {
            if code == 0 || code > 0xFE {
                return false;
            }
            let f = if flags & 1 != 0 { KEY_EXTENDED } else { 0 } | if down { 0 } else { KEY_UP };
            send(&[key(code as u16, 0, f)])
        }

        fn pid_of(w: *mut c_void) -> i64 {
            if w.is_null() {
                return -1;
            }
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(w, &mut pid) };
            if pid == 0 { -1 } else { pid as i64 }
        }

        pub fn frontmost_pid() -> i64 {
            pid_of(unsafe { GetForegroundWindow() })
        }

        /// Which process owns the top window at a point of the desktop (physical pixels). Windows
        /// that let clicks through (the answer card while it does) aren't found.
        pub fn owner_at(x: f64, y: f64) -> i64 {
            unsafe {
                let w = WindowFromPoint(POINT { x: x.round() as i32, y: y.round() as i32 });
                pid_of(if w.is_null() { w } else { GetAncestor(w, 2) })
            }
        }

        pub fn activate(_pid: i32) -> bool {
            false
        }
    }

    #[cfg(target_os = "linux")]
    pub mod os {
        //! X11 through XTest, loaded when first needed (libX11.so.6 and libXtst.so.6). Wayland
        //! desktops don't let apps move the pointer or type into other apps: the app says so.
        use super::Point;
        use std::ffi::{c_char, c_int, c_uint, c_ulong, c_void};
        use std::sync::{Mutex, OnceLock};

        type Display = c_void;
        struct X {
            _x11: libloading::Library,
            _xtst: libloading::Library,
            open: unsafe extern "C" fn(*const c_char) -> *mut Display,
            root: unsafe extern "C" fn(*mut Display) -> c_ulong,
            query_pointer: unsafe extern "C" fn(*mut Display, c_ulong, *mut c_ulong, *mut c_ulong, *mut c_int, *mut c_int, *mut c_int, *mut c_int, *mut c_uint) -> c_int,
            flush: unsafe extern "C" fn(*mut Display) -> c_int,
            sync: unsafe extern "C" fn(*mut Display, c_int) -> c_int,
            keysym_to_keycode: unsafe extern "C" fn(*mut Display, c_ulong) -> u8,
            display_keycodes: unsafe extern "C" fn(*mut Display, *mut c_int, *mut c_int) -> c_int,
            get_keyboard_mapping: unsafe extern "C" fn(*mut Display, u8, c_int, *mut c_int) -> *mut c_ulong,
            change_keyboard_mapping: unsafe extern "C" fn(*mut Display, c_int, c_int, *const c_ulong, c_int) -> c_int,
            free: unsafe extern "C" fn(*mut c_void) -> c_int,
            intern_atom: unsafe extern "C" fn(*mut Display, *const c_char, c_int) -> c_ulong,
            get_window_property: unsafe extern "C" fn(*mut Display, c_ulong, c_ulong, i64, i64, c_int, c_ulong, *mut c_ulong, *mut c_int, *mut c_ulong, *mut c_ulong, *mut *mut u8) -> c_int,
            fake_motion: unsafe extern "C" fn(*mut Display, c_int, c_int, c_int, c_ulong) -> c_int,
            fake_button: unsafe extern "C" fn(*mut Display, c_uint, c_int, c_ulong) -> c_int,
            fake_key: unsafe extern "C" fn(*mut Display, c_uint, c_int, c_ulong) -> c_int,
        }
        unsafe impl Send for X {}
        unsafe impl Sync for X {}

        fn load() -> Option<X> {
            unsafe {
                let x11 = libloading::Library::new("libX11.so.6").ok()?;
                let xtst = libloading::Library::new("libXtst.so.6").ok()?;
                macro_rules! f {
                    ($lib:expr, $name:literal) => {
                        *$lib.get($name).ok()?
                    };
                }
                Some(X {
                    open: f!(x11, b"XOpenDisplay\0"),
                    root: f!(x11, b"XDefaultRootWindow\0"),
                    query_pointer: f!(x11, b"XQueryPointer\0"),
                    flush: f!(x11, b"XFlush\0"),
                    sync: f!(x11, b"XSync\0"),
                    keysym_to_keycode: f!(x11, b"XKeysymToKeycode\0"),
                    display_keycodes: f!(x11, b"XDisplayKeycodes\0"),
                    get_keyboard_mapping: f!(x11, b"XGetKeyboardMapping\0"),
                    change_keyboard_mapping: f!(x11, b"XChangeKeyboardMapping\0"),
                    free: f!(x11, b"XFree\0"),
                    intern_atom: f!(x11, b"XInternAtom\0"),
                    get_window_property: f!(x11, b"XGetWindowProperty\0"),
                    fake_motion: f!(xtst, b"XTestFakeMotionEvent\0"),
                    fake_button: f!(xtst, b"XTestFakeButtonEvent\0"),
                    fake_key: f!(xtst, b"XTestFakeKeyEvent\0"),
                    _x11: x11,
                    _xtst: xtst,
                })
            }
        }

        /// The libraries and one connection to the X server, used by one caller at a time.
        struct Conn {
            x: &'static X,
            dpy: *mut Display,
            spare: Option<(u8, u8)>, // two key codes with nothing on them: one borrowed to type any character, one to nudge apps
            held: Option<(u8, bool)>, // the key key_text pressed, and whether Shift went down with it
        }
        unsafe impl Send for Conn {}

        fn with<T>(f: impl FnOnce(&mut Conn) -> Option<T>) -> Option<T> {
            static LIBS: OnceLock<Option<X>> = OnceLock::new();
            static CONN: Mutex<Option<Conn>> = Mutex::new(None);
            let x = LIBS.get_or_init(load).as_ref()?;
            let mut guard = CONN.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_none() {
                let dpy = unsafe { (x.open)(std::ptr::null()) };
                if dpy.is_null() {
                    return None;
                }
                *guard = Some(Conn { x, dpy, spare: None, held: None });
            }
            f(guard.as_mut()?)
        }

        pub fn access(_ask: bool) -> bool {
            with(|_| Some(())).is_some()
        }

        pub fn location() -> Option<Point> {
            with(|c| unsafe {
                let (mut r, mut ch, mut rx, mut ry, mut wx, mut wy, mut m) = (0, 0, 0, 0, 0, 0, 0);
                let ok = (c.x.query_pointer)(c.dpy, (c.x.root)(c.dpy), &mut r, &mut ch, &mut rx, &mut ry, &mut wx, &mut wy, &mut m);
                (ok != 0).then_some(Point { x: rx as f64, y: ry as f64 })
            })
        }

        pub fn move_to(p: Point, _held: bool) -> bool {
            with(|c| unsafe {
                (c.x.fake_motion)(c.dpy, -1, p.x.round() as c_int, p.y.round() as c_int, 0);
                (c.x.flush)(c.dpy);
                Some(())
            })
            .is_some()
        }

        pub fn button(_at: Point, right: bool, down: bool, _clicks: i64) -> bool {
            with(|c| unsafe {
                (c.x.fake_button)(c.dpy, if right { 3 } else { 1 }, down as c_int, 0);
                (c.x.flush)(c.dpy);
                Some(())
            })
            .is_some()
        }

        /// X has no smooth wheel for other apps: a notch is one click of buttons 4-7.
        pub fn wheel_notch(dx: i32, dy: i32, _r: &mut crate::glide::Rng) -> bool {
            let b = match (dx, dy) {
                (_, 1) => 4,
                (_, -1) => 5,
                (1, _) => 6,
                (-1, _) => 7,
                _ => return true,
            };
            with(|c| unsafe {
                (c.x.fake_button)(c.dpy, b, 1, 0);
                (c.x.fake_button)(c.dpy, b, 0, 0);
                (c.x.flush)(c.dpy);
                Some(())
            })
            .is_some()
        }

        /// Two key codes with no symbols on them: one to put any character on, one left empty (a press
        /// of it types nothing, and makes an app read the changed map before the real press).
        fn spare(c: &mut Conn) -> Option<(u8, u8)> {
            if let Some(k) = c.spare {
                return Some(k);
            }
            unsafe {
                let (mut lo, mut hi, mut per) = (0, 0, 0);
                (c.x.display_keycodes)(c.dpy, &mut lo, &mut hi);
                let n = hi - lo + 1;
                let map = (c.x.get_keyboard_mapping)(c.dpy, lo as u8, n, &mut per);
                if map.is_null() || per < 1 {
                    return None;
                }
                let syms = std::slice::from_raw_parts(map, (n * per) as usize);
                let mut empty = (0..n).rev().filter(|i| syms[(*i * per) as usize..((*i + 1) * per) as usize].iter().all(|s| *s == 0));
                let found = empty.next().zip(empty.next());
                (c.x.free)(map as *mut c_void);
                c.spare = found.map(|(a, b)| ((lo + a) as u8, (lo + b) as u8));
                c.spare
            }
        }

        /// Where a symbol already is on the keyboard: its key, and whether Shift is needed for it.
        fn place_of(c: &Conn, sym: c_ulong) -> Option<(u8, bool)> {
            unsafe {
                let k = (c.x.keysym_to_keycode)(c.dpy, sym);
                if k == 0 {
                    return None;
                }
                let mut per = 0;
                let map = (c.x.get_keyboard_mapping)(c.dpy, k, 1, &mut per);
                if map.is_null() {
                    return None;
                }
                let syms = std::slice::from_raw_parts(map, per.max(0) as usize);
                let place = match syms.iter().position(|s| *s == sym) {
                    Some(0) => Some((k, false)),
                    Some(1) => Some((k, true)),
                    _ => None, // another group or level (AltGr): the spare key types it instead
                };
                (c.x.free)(map as *mut c_void);
                place
            }
        }

        /// One character, pressed or let go. One the keyboard has goes on its own key (with Shift
        /// when it's the shifted one), so nothing changes. Any other is put on the spare key, both
        /// levels (no Shift). Apps reload the keyboard's map only when the next key event comes (a
        /// press right after the change reads the old symbol), so the empty key is tapped first.
        pub fn key_text(text: &str, down: bool) -> bool {
            let mut chars = text.chars();
            let (Some(ch), None) = (chars.next(), chars.next()) else { return false };
            let cp = ch as u32;
            let sym: c_ulong = if (0x20..0x7f).contains(&cp) || (0xa0..0x100).contains(&cp) { cp as c_ulong } else { 0x0100_0000 | cp as c_ulong };
            with(|c| unsafe {
                if !down {
                    if let Some((k, shift)) = c.held.take() {
                        (c.x.fake_key)(c.dpy, k as c_uint, 0, 0);
                        if shift {
                            let s = (c.x.keysym_to_keycode)(c.dpy, 0xffe1);
                            (c.x.fake_key)(c.dpy, s as c_uint, 0, 0);
                        }
                        (c.x.flush)(c.dpy);
                    }
                    return Some(());
                }
                let (k, shift) = match place_of(c, sym) {
                    Some(place) => place,
                    None => {
                        let (k, nudge) = spare(c)?;
                        let syms = [sym, sym];
                        (c.x.change_keyboard_mapping)(c.dpy, k as c_int, 2, syms.as_ptr(), 1);
                        (c.x.sync)(c.dpy, 0);
                        super::pause(30);
                        (c.x.fake_key)(c.dpy, nudge as c_uint, 1, 0);
                        (c.x.fake_key)(c.dpy, nudge as c_uint, 0, 0);
                        (c.x.sync)(c.dpy, 0);
                        super::pause(30);
                        (k, false)
                    }
                };
                if shift {
                    let s = (c.x.keysym_to_keycode)(c.dpy, 0xffe1);
                    if s == 0 {
                        return None;
                    }
                    (c.x.fake_key)(c.dpy, s as c_uint, 1, 0);
                }
                (c.x.fake_key)(c.dpy, k as c_uint, 1, 0);
                (c.x.flush)(c.dpy);
                c.held = Some((k, shift));
                Some(())
            })
            .is_some()
        }

        /// One key by its X key symbol (the app presses modifiers as keys of their own).
        pub fn key_code(code: u32, _flags: u64, down: bool) -> bool {
            with(|c| unsafe {
                let k = (c.x.keysym_to_keycode)(c.dpy, code as c_ulong);
                if k == 0 {
                    return None;
                }
                (c.x.fake_key)(c.dpy, k as c_uint, down as c_int, 0);
                (c.x.flush)(c.dpy);
                Some(())
            })
            .is_some()
        }

        /// One number from a window's property (format 32: a C long each), or None.
        unsafe fn prop(c: &Conn, w: c_ulong, name: &[u8], kind: c_ulong) -> Option<c_ulong> {
            unsafe {
                let atom = (c.x.intern_atom)(c.dpy, name.as_ptr() as *const c_char, 1);
                if atom == 0 {
                    return None;
                }
                let (mut t, mut fmt, mut n, mut after, mut data) = (0, 0, 0, 0, std::ptr::null_mut());
                let ok = (c.x.get_window_property)(c.dpy, w, atom, 0, 1, 0, kind, &mut t, &mut fmt, &mut n, &mut after, &mut data);
                if ok != 0 || data.is_null() {
                    return None;
                }
                let v = (n >= 1 && fmt == 32).then(|| *(data as *const c_ulong));
                (c.x.free)(data as *mut c_void);
                v
            }
        }

        /// The process of the active window (the window manager's _NET_ACTIVE_WINDOW), or -1.
        pub fn frontmost_pid() -> i64 {
            with(|c| unsafe {
                let w = prop(c, (c.x.root)(c.dpy), b"_NET_ACTIVE_WINDOW\0", 33)?;
                if w == 0 {
                    return None;
                }
                prop(c, w, b"_NET_WM_PID\0", 6).map(|p| p as i64)
            })
            .unwrap_or(-1)
        }

        pub fn activate(_pid: i32) -> bool {
            false
        }
    }
}

/// Whether this app may use the mouse and keyboard for the user. macOS: it's on in System Settings ›
/// Privacy & Security › Accessibility (with `ask`, macOS shows its box the first time and lists the
/// app there). Windows: always. Linux: an X11 desktop with XTest (never on Wayland). Elsewhere: false.
#[napi]
pub fn post_event_access(ask: bool) -> bool {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        input::access(ask)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
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
    // Windows: the top window there in physical pixels (windows that let clicks through aren't found,
    // so nothing needs skipping).
    #[cfg(target_os = "windows")]
    {
        let _ = skip;
        Ok(input::os::owner_at(x, y))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        {
            let at = |x: f64, y: f64| (x.is_finite() && y.is_finite()).then_some(input::Point { x, y });
            Ok(match self.0 {
                Pointer::Glide { x, y, held } => at(x, y).map_or(input::FAILED, |p| input::glide(p, held)),
                Pointer::Press { x, y, right, count } => at(x, y).map_or(input::FAILED, |p| input::press(p, right, count.clamp(1, 2) as i64)),
                Pointer::Scroll { x, y, dx, dy, notches } => {
                    at(x, y).map_or(input::FAILED, |p| input::scroll(p, dx.signum(), dy.signum(), notches.clamp(1, 30)))
                }
            })
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            Ok(1)
        }
    }

    fn resolve(&mut self, _env: napi::Env, output: i32) -> napi::Result<i32> {
        Ok(output)
    }
}

/// Glides the pointer to a point on the screen (macOS: points from the top left of the main display;
/// Windows and Linux: physical pixels of the desktop) as a person would, with the left button held
/// when `held` (a drag). Resolves 0 when there, 2 when the user moved the mouse on the way (it
/// stopped), 1 when the events couldn't be made.
#[napi]
pub fn pointer_glide(x: f64, y: f64, held: bool) -> napi::bindgen_prelude::AsyncTask<PointerTask> {
    napi::bindgen_prelude::AsyncTask::new(PointerTask(Pointer::Glide { x, y, held }))
}

/// Rests on the point a moment, then clicks there (a double click with `count` 2, the right button
/// with `right`). Resolves 0 when clicked, 2 when the user moved the mouse meanwhile (nothing
/// clicked), 1 when the events couldn't be made.
#[napi]
pub fn pointer_press(x: f64, y: f64, right: bool, count: u32) -> napi::bindgen_prelude::AsyncTask<PointerTask> {
    napi::bindgen_prelude::AsyncTask::new(PointerTask(Pointer::Press { x, y, right, count }))
}

/// The left button down or up at the point, nothing more (a drag's two ends). False when the event
/// couldn't be made.
#[napi]
pub fn pointer_button(x: f64, y: f64, down: bool) -> bool {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        x.is_finite() && y.is_finite() && input::button(input::Point { x, y }, down)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (x, y, down);
        false
    }
}

/// Turns the wheel at the point (the pointer must be there), `notches` times; `dy` 1 scrolls up, -1
/// down; `dx` 1 left, -1 right. Resolves 0 when done, 2 when the user moved the mouse (it stopped), 1
/// when the events couldn't be made.
#[napi]
pub fn scroll_at(x: f64, y: f64, dx: i32, dy: i32, notches: u32) -> napi::bindgen_prelude::AsyncTask<PointerTask> {
    napi::bindgen_prelude::AsyncTask::new(PointerTask(Pointer::Scroll { x, y, dx, dy, notches }))
}

/// One key event typing `text` (one character), down or up, into whatever has the keyboard. False
/// when it couldn't be made.
#[napi]
pub fn key_text(text: String, down: bool) -> bool {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        input::key_text(&text, down)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (text, down);
        false
    }
}

/// One key down or up. macOS: a virtual key code, with modifier flags (shift 0x20000, control
/// 0x40000, option 0x80000, command 0x100000) on that event only. Windows: a virtual key code
/// (`flags` 1: an extended key). Linux: an X key symbol. On Windows and Linux the app presses
/// modifiers as keys of their own. False when it couldn't be made.
#[napi]
pub fn key_code(code: u32, flags: f64, down: bool) -> bool {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        flags.is_finite() && flags >= 0.0 && input::key_code(code, flags as u64, down)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (code, flags, down);
        false
    }
}

/// macOS: brings the app with this process id to the front. False when there's no such app, and on
/// other systems.
#[napi]
pub fn activate_app(pid: i32) -> bool {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        pid > 0 && pid as u32 != std::process::id() && input::activate(pid)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = pid;
        false
    }
}

/// The process id of the app in front (the one the keyboard types into), -1 when none or unknown
/// (Linux: from the window manager). Other systems: -2.
#[napi]
pub fn frontmost_pid() -> i64 {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        input::frontmost_pid()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
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
