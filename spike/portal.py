"""Portal calls as an app makes them, one per process:
  portal.py rd <token-file>   RemoteDesktop (keyboard+pointer, persistent); uses and rewrites the token file
  portal.py shot              Screenshot, no picker
Prints BOX once the call that may show a box is sent."""
import os, sys, time
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
me = bus.get_unique_name()[1:].replace(".", "_")
D, P = "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop"
RD = "org.freedesktop.portal.RemoteDesktop"
n = [0]

def say(*a):
    print(f"{time.strftime('%H:%M:%S')}", *a, flush=True)

def request(iface, method, args_fn, wait=60, marker=False):
    n[0] += 1
    token = f"t{os.getpid()}x{n[0]}"
    path = f"/org/freedesktop/portal/desktop/request/{me}/{token}"
    out = {}
    loop = GLib.MainLoop()
    def on(conn, s, o, i, sig, params):
        code, res = params.unpack()
        out["code"], out["results"] = code, res
        loop.quit()
    sub = bus.signal_subscribe(D, "org.freedesktop.portal.Request", "Response", path, None, 0, on)
    t0 = time.time()
    bus.call_sync(D, P, iface, method, args_fn(token), None, 0, 120000, None)
    if marker:
        say("BOX")
    GLib.timeout_add_seconds(wait, lambda: (out.setdefault("code", "no answer"), loop.quit()))
    loop.run()
    bus.signal_unsubscribe(sub)
    shown = {k: (v if k != "restore_token" else f"<{len(v)} chars>") for k, v in (out.get("results") or {}).items()}
    say(f"{method} -> code {out.get('code')} {shown} in {time.time() - t0:.1f} s")
    return out

if sys.argv[1] == "rd":
    tf = sys.argv[2]
    old = open(tf).read().strip() if os.path.exists(tf) else None
    say("saved token:", "yes" if old else "none")
    r = request(RD, "CreateSession", lambda t: GLib.Variant("(a{sv})", ({"handle_token": GLib.Variant("s", t), "session_handle_token": GLib.Variant("s", "s" + t)},)))
    s = r["results"]["session_handle"]
    def sel(t):
        o = {"handle_token": GLib.Variant("s", t), "types": GLib.Variant("u", 3), "persist_mode": GLib.Variant("u", 2)}
        if old:
            o["restore_token"] = GLib.Variant("s", old)
        return GLib.Variant("(oa{sv})", (s, o))
    request(RD, "SelectDevices", sel)
    r = request(RD, "Start", lambda t: GLib.Variant("(osa{sv})", (s, "", {"handle_token": GLib.Variant("s", t)})), wait=45, marker=True)
    res = r.get("results") or {}
    new = res.get("restore_token")
    say("devices granted:", res.get("devices"), "new token:", "none" if not new else ("same as saved" if new == old else "different"))
    if new:
        open(tf, "w").write(new)
    if r.get("code") == 0:
        try:
            v, fds = bus.call_with_unix_fd_list_sync(D, P, RD, "ConnectToEIS", GLib.Variant("(oa{sv})", (s, {})), GLib.VariantType("(h)"), 0, 5000, None, None)
            say("ConnectToEIS -> fd handle", v.unpack(), "fds", fds.get_length() if fds else 0)
            if len(sys.argv) > 3:
                sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
                import eis
                steps = [l.split() for l in open(sys.argv[3]).read().splitlines() if l.strip()]
                steps = [(s[0], *(int(x) for x in s[1:])) if s[0] == "click" else (s[0], " ".join(s[1:])) if s[0] == "type" else (s[0], float(s[1])) for s in steps]
                eis.drive(fds.get(0), steps)
        except Exception as e:
            say("ConnectToEIS failed:", e)
    bus.call_sync(D, s, "org.freedesktop.portal.Session", "Close", None, None, 0, 5000, None)
elif sys.argv[1] == "versions":
    for i in (RD, "org.freedesktop.portal.ScreenCast", "org.freedesktop.portal.Screenshot", "org.freedesktop.portal.GlobalShortcuts", "org.freedesktop.portal.InputCapture"):
        try:
            v = bus.call_sync(D, P, "org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", (i, "version")), None, 0, 5000, None).unpack()[0]
        except Exception as e:
            v = "absent (" + str(e).split(":")[-1].strip()[:60] + ")"
        say(i.split(".")[-1], "version", v)
elif sys.argv[1] == "shot":
    r = request("org.freedesktop.portal.Screenshot", "Screenshot",
                lambda t: GLib.Variant("(sa{sv})", ("", {"handle_token": GLib.Variant("s", t), "interactive": GLib.Variant("b", False)})), wait=40, marker=True)
    uri = (r.get("results") or {}).get("uri")
    if uri:
        f = uri.replace("file://", "")
        say("file:", f, "exists" if os.path.exists(f) else "missing", os.path.getsize(f) if os.path.exists(f) else "")
