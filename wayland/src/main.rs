//! dunebot-wayland: Dune Bot's hand and eyes on a Wayland desktop. One JSON request per line on
//! stdin, one JSON answer per line on stdout ({"id", "ok": true, ...} or {"id", "error"}). The app
//! (electron/wayland.mjs) starts it only on a Wayland desktop and only while an agent works.
//!
//! Requests ({"id": n, "op": ...}):
//!   open   {token?}         The session: the screen plus keyboard and pointer, remembered by the
//!                           desktop (persist mode 2). May show GNOME's box. Answers `devices`
//!                           (1 keyboard, 2 pointer), `streams` [{node, x, y, w, h}] and `token`.
//!                           The token arrives here on stdin only: never argv or env.
//!   frame  {node, path}     The newest picture of a stream, as BGRA rows written to `path` (a file
//!                           the app made, only it can read). Answers `w`, `h`.
//!   move   {x, y}           The pointer to a point, in the desktop's logical coordinates.
//!   button {button, down}   "left" | "right" | "middle".
//!   scroll {dx, dy, n}      n notches; dx, dy are -1, 0 or 1.
//!   key    {keysym, down}   A key by its X keysym (modifiers too).
//!   text   {ch}             One character down and up, with Shift when the layout puts it there.
//!                           An error when the layout has no key for it: never claimed typed.
//!   close
//!   can_type {text}         Answers `missing`: the characters the active layout can't make.
//!   quit
//! `open` waits while GNOME's box is up; meanwhile `close`, `quit` or stdin closing cancel it and
//! anything else is refused. A cancelled box ends the helper (the box goes with its D-Bus
//! connection; closing the session alone leaves it up on GNOME 46): start a new one after. Its answer also says `hand`/`eyes` (connected or not),
//! with `hand_error`/`eyes_error` saying why not, and the pointer's `regions`.
//! Events: {"event": "asking"} as the session starts (GNOME may show its box now); {"event":
//! "closed"} when the session ends outside Dune Bot (the user stopped it from GNOME's top bar).

#[cfg(target_os = "linux")]
mod eyes;
#[cfg(target_os = "linux")]
mod hand;
#[cfg(target_os = "linux")]
mod session;

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("dunebot-wayland runs on Linux only");
    std::process::exit(2);
}

#[cfg(target_os = "linux")]
fn main() {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
    // libei's event stream isn't thread-safe: everything runs on this one thread.
    tokio::task::LocalSet::new().block_on(&rt, session::serve());
}
