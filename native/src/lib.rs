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
