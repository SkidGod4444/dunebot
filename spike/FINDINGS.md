# Wayland spike (GNOME 46, Ubuntu 24.04, headless gnome-shell on CI) — 2026-11-18

Versions: gnome-shell 46.0, mutter 46.2, xdg-desktop-portal 1.18.4, xdg-desktop-portal-gnome 46.2.
Portals: RemoteDesktop v2, ScreenCast v5, Screenshot v2, InputCapture v1, **GlobalShortcuts absent**.

## What works (rounds 4-6)
- **One box for screen + control** (RemoteDesktop + ScreenCast in one session, persist_mode 2):
  "Remember This Selection" ticked by default, the one monitor preselected, "Allow Remote
  Interaction" OFF by default (the user must switch it on; Start then says devices 3, else 0).
  Accepted once; a fresh process with the saved restore token gets no box (Start in 0.0 s,
  same token returned). The permission store keeps it (remote-desktop table).
- **Screen frames** from the session's PipeWire stream: 1280x800, 0.04 s per frame after the first
  (0.16 s). GNOME shows the orange "screen shared" dot while the session is open.
- **libei (ConnectToEIS)**: devices "shared virtual absolute pointer" [absolute, scroll, button]
  with region (0,0,1280,800, scale 1.0), "virtual pointer", "virtual keyboard" with an xkb keymap.
  Absolute clicks land exactly (two clicks 200,100 apart arrive 200,100 apart). Typing "aA b"
  arrives; "ö" is not on the layout and is detected before sending.
- **GNOME custom shortcut** (gsettings media-keys custom-keybinding running a command) fires.

## What doesn't
- Electron hotkey (globalShortcut) on Wayland: "registered" but never fires (no GlobalShortcuts
  portal on GNOME 46). The X11 build under Xwayland fires only while its own X window is focused.
  => Dune Bot's bar hotkey on main does not work on Ubuntu 24.04 Wayland today.
- Electron's own pointer position: always (0,0). Window bounds: wrong (Electron can't know them).
- Electron desktopCapturer: a "Share Screen" picker each call (never answered here).
- Screenshot portal: one "Allow Applications to Take Screenshots?" box, stored as {'': ['yes']}
  — for EVERY unsandboxed app. Unanswered within 25 s = failure (code 2) and the stale box blocks
  the next call. Each call leaves Screenshot-N.png in $HOME. => not used.

## Not tested
Real Rust code (helper with libei + PipeWire), HiDPI/fractional scale, two monitors, a real (not
headless) session, GNOME 47-49 (Ubuntu 25.10, Fedora 43), KDE, setIgnoreMouseEvents on Wayland.

## Round 7
- **Share with the control switch off**: devices 0, screen granted, and that answer is remembered
  (restore: devices 0, no box). Asking again = start without the token: the box comes back; with
  the switch on, devices 3. => detect devices != 3, forget the token, ask again with a line
  saying to turn on "Allow Remote Interaction".
- **GNOME custom shortcut added live** (service already running), two combos, then one changed
  live: all fired. => the stop key and the bar key on GNOME Wayland go through GNOME's own
  keyboard shortcuts running `dunebot --stop` / `--bar`.
- **Card** (alwaysOnTop, not focusable, frameless): GNOME ignores always-on-top. A libei click on
  the app under it raised the app ABOVE the card. Click-through (setIgnoreMouseEvents) works: the
  click went to the window below at the right spot. Electron reports its own focus correctly.
  => the card's Stop button is not a stop on GNOME Wayland (it can be covered); the key is.
- **Frames are fresh**: the overview opened between two frames, md5 changed.
- **Scale**: this virtual monitor offers only scale 1.0. HiDPI goes in the build's CI (a
  2560x1600 virtual monitor).
