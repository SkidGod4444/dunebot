#!/usr/bin/env python3
"""The test desktop's screens and GNOME's box, for drive.py and app_side.mjs (both call it as a
command, so a GNOME version's or a scale's difference is handled in one place). Test-only.

usage: screens.py apply <scale per monitor, comma-separated, e.g. "2" or "1,2">
       screens.py monitors                 JSON [{x, y, w, h, scale}] in the desktop's coordinates
       screens.py window <title>           JSON {x, y, w, h, monitor} of the first window so titled
       screens.py box <switch|share>       answers GNOME's screen-sharing box (share picks every screen
                                           first when there's more than one)"""
import json
import subprocess
import sys
import time

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

J = "const C = imports.gi.Clutter; const G = imports.gi.GLib;"


def ev(js):
    """Shell.Eval's answer, as the JSON the script returned (it must return JSON.stringify(...))."""
    bus = Gio.bus_get_sync(Gio.BusType.SESSION)
    ok, out = bus.call_sync(
        "org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell", "Eval", GLib.Variant("(s)", (js,)), None, 0, 10000, None
    ).unpack()
    if not ok:
        raise RuntimeError(f"Shell.Eval failed: {out}")
    return json.loads(json.loads(out)) if out.startswith('"') else json.loads(out)


def monitors():
    return ev(
        "JSON.stringify([...Array(global.display.get_n_monitors()).keys()].map(i => {"
        " const r = global.display.get_monitor_geometry(i);"
        " return {x: r.x, y: r.y, w: r.width, h: r.height, scale: global.display.get_monitor_scale(i)}; }))"
    )


def window(title):
    """By exact title first, else by window class (GNOME's box has no fixed title)."""
    t = json.dumps(title)
    return ev(
        "const ws = global.get_window_actors().map(a => a.meta_window);"
        f" const w = ws.find(w => w.get_title() === {t}) ?? ws.find(w => (w.get_wm_class() || '').includes({t}));"
        " JSON.stringify(w ? (r => ({x: r.x, y: r.y, w: r.width, h: r.height, monitor: w.get_monitor()}))(w.get_frame_rect()) : null)"
    )


def apply(scales):
    """Each monitor's scale, laid out left to right, the first one primary."""
    want = [float(s) for s in scales.split(",") if s.strip()]
    bus = Gio.bus_get_sync(Gio.BusType.SESSION)
    call = lambda m, args: bus.call_sync(
        "org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig", "org.gnome.Mutter.DisplayConfig", m, args, None, 0, 10000, None
    )
    serial, mons, _logical, props = call("GetCurrentState", None).unpack()
    physical = props.get("layout-mode", 1) == 2  # 2: positions in pixels; 1: in logical points
    logical, x = [], 0
    for i, (spec, modes, _mp) in enumerate(mons):
        mode = next(m for m in modes if m[6].get("is-current"))
        scale = want[i] if i < len(want) else 1.0
        if not any(abs(s - scale) < 0.01 for s in mode[5]):
            raise SystemExit(f"{spec[0]} {mode[1]}x{mode[2]} doesn't offer scale {scale} (offers {mode[5]})")
        scale = next(s for s in mode[5] if abs(s - scale) < 0.01)
        logical.append((x, 0, scale, 0, i == 0, [(spec[0], mode[0], {})]))
        x += mode[1] if physical else round(mode[1] / scale)
    call("ApplyMonitorsConfig", GLib.Variant("(uua(iiduba(ssa{sv}))a{sv})", (serial, 1, logical, {})))
    time.sleep(2)
    print(json.dumps({"layout": "physical" if physical else "logical", "monitors": monitors()}))


# GNOME's box (xdg-desktop-portal-gnome's Remote Desktop window), answered through its accessibility
# tree: each control found by its name and pressed with its own action, as a screen reader user
# would. (GTK 4 reports wrong places for some of them, so a pointer can't be aimed from there; and
# names hold across GNOME versions where the layout doesn't.)
def _atspi():
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi

    return Atspi


def _box_tree(timeout=15):
    Atspi = _atspi()
    end = time.time() + timeout
    while time.time() < end:
        d = Atspi.get_desktop(0)
        for i in range(d.get_child_count()):
            app = d.get_child_at_index(i)
            if app is not None and app.get_name() == "xdg-desktop-portal-gnome" and app.get_child_count() > 0:
                return app
        time.sleep(0.5)
    raise SystemExit("no box on screen (xdg-desktop-portal-gnome isn't in the accessibility tree)")


def _all(o, out=None):
    out = [] if out is None else out
    for i in range(o.get_child_count()):
        c = o.get_child_at_index(i)
        if c is not None:
            out.append(c)
            _all(c, out)
    return out


def _state(o, name):
    return o.get_state_set().contains(getattr(_atspi().StateType, name))


def _press(o):
    if o.get_n_actions() < 1:
        raise SystemExit(f"{o.get_role_name()} {o.get_name()!r} has no action")
    o.do_action(0)
    time.sleep(0.6)


def box(which):
    app = _box_tree()
    nodes = _all(app)
    # The control itself, not the row around it (GNOME 49's row has the same name and no action).
    def find(roles, name):
        hits = [n for n in nodes if n.get_role_name() in roles and n.get_name() == name]
        return next((n for n in reversed(hits) if n.get_n_actions() > 0), hits[-1] if hits else None)

    if which == "switch":
        sw = find(("check box", "switch", "toggle button"), "Allow Remote Interaction")
        if not sw:
            raise SystemExit(f"no Allow Remote Interaction switch in the box: {[(n.get_role_name(), n.get_name()) for n in nodes if n.get_name()]}")
        if not _state(sw, "CHECKED"):
            _press(sw)
        print(json.dumps({"switch": _state(sw, "CHECKED")}))
        return
    share = find(("push button", "button"), "Share")  # "button" from GTK 4.20 (GNOME 49)
    if not share:
        raise SystemExit(f"no Share button in the box: {[(n.get_role_name(), n.get_name()) for n in nodes if n.get_name()]}")
    picked = []
    tiles = [n for n in nodes if n.get_role_name() == "toggle button"]
    chosen = lambda t: _state(t, "PRESSED") or _state(t, "CHECKED")  # GTK 4 toggle buttons say "pressed"
    if len(tiles) > 1 and not any(chosen(t) for t in tiles):
        # More than one screen and none chosen yet (one screen is chosen for the user). Pick every
        # screen, so Dune Bot can see and click on all of them. (GTK says Share can be pressed
        # before then, once the switch is on, but nothing is shared.)
        for t in tiles:
            _press(t)
            picked.append(t.get_name())
        if not all(chosen(t) for t in tiles):
            raise SystemExit(f"picked {picked} but not every screen shows as chosen")
    if not _state(share, "SENSITIVE"):
        raise SystemExit("Share is grey")
    _press(share)
    print(json.dumps({"shared": True, "picked": picked}))


if __name__ == "__main__":
    op = sys.argv[1]
    if op == "apply":
        apply(sys.argv[2])
    elif op == "monitors":
        print(json.dumps(monitors()))
    elif op == "window":
        print(json.dumps(window(sys.argv[2])))
    elif op == "box":
        box(sys.argv[2])
    else:
        raise SystemExit(__doc__)
