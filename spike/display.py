"""Mutter's display config (harness only): print the monitor's scales; `display.py <scale>` applies one."""
import sys
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
D, P, I = "org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig", "org.gnome.Mutter.DisplayConfig"
serial, monitors, logical, props = bus.call_sync(D, P, I, "GetCurrentState", None, None, 0, 5000, None).unpack()
for (conn, *_), modes, mprops in monitors:
    for m in modes:
        if m[6].get("is-current"):
            print("monitor", conn, "mode", m[0], f"{m[1]}x{m[2]}", "scales", [round(x, 3) for x in m[5]], flush=True)
            cur = (conn, m[0], m[5])
print("logical now", [(l[0], l[1], l[2]) for l in logical], "layout-mode", props.get("layout-mode"), flush=True)
if len(sys.argv) > 1:
    want = float(sys.argv[1])
    scale = min(cur[2], key=lambda x: abs(x - want))
    lm = [(0, 0, scale, 0, True, [(cur[0], cur[1], {})])]
    try:
        bus.call_sync(D, P, I, "ApplyMonitorsConfig", GLib.Variant("(uua(iiduba(ssa{sv}))a{sv})", (serial, 1, lm, {})), None, 0, 5000, None)
        print("applied scale", scale, flush=True)
    except Exception as e:
        print("apply failed:", e, flush=True)
