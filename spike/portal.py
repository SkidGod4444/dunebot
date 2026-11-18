"""The RemoteDesktop portal as an app would use it, twice (the second with the remembered answer),
then the Screenshot portal without a picker. Markers (BOX1, BOX2, SHOT) tell the runner when to look."""
import sys, time
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
me = bus.get_unique_name()[1:].replace(".", "_")
D, P = "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop"
RD = "org.freedesktop.portal.RemoteDesktop"
n = [0]

def request(iface, method, args_fn, wait=60, marker=None):
    n[0] += 1
    token = f"t{n[0]}"
    path = f"/org/freedesktop/portal/desktop/request/{me}/{token}"
    out = {}
    loop = GLib.MainLoop()
    def on(conn, s, o, i, sig, params):
        code, res = params.unpack()
        out["code"], out["results"] = code, res
        loop.quit()
    sub = bus.signal_subscribe(D, "org.freedesktop.portal.Request", "Response", path, None, 0, on)
    t0 = time.time()
    bus.call_sync(D, P, iface, method, args_fn(token), None, 0, -1, None)
    if marker:
        print(marker, flush=True)
    GLib.timeout_add_seconds(wait, lambda: (out.setdefault("code", "no answer"), loop.quit()))
    loop.run()
    bus.signal_unsubscribe(sub)
    print(f"{method} -> {out} in {time.time() - t0:.1f} s", flush=True)
    return out

def session(restore=None, marker=None):
    r = request(RD, "CreateSession", lambda t: GLib.Variant("(a{sv})", ({"handle_token": GLib.Variant("s", t), "session_handle_token": GLib.Variant("s", "s" + t)},)))
    s = r.get("results", {}).get("session_handle")
    opts = lambda t: {"handle_token": GLib.Variant("s", t), "types": GLib.Variant("u", 3), "persist_mode": GLib.Variant("u", 2)}
    def sel(t):
        o = opts(t)
        if restore:
            o["restore_token"] = GLib.Variant("s", restore)
        return GLib.Variant("(oa{sv})", (s, o))
    request(RD, "SelectDevices", sel)
    r = request(RD, "Start", lambda t: GLib.Variant("(osa{sv})", (s, "", {"handle_token": GLib.Variant("s", t)})), wait=40, marker=marker)
    if r.get("code") == 0:
        try:
            v, fds = bus.call_with_unix_fd_list_sync(D, P, RD, "ConnectToEIS", GLib.Variant("(oa{sv})", (s, {})), GLib.VariantType("(h)"), 0, 5000, None, None)
            print("ConnectToEIS ->", v.unpack(), "fds", fds.get_length() if fds else 0, flush=True)
        except Exception as e:
            print("ConnectToEIS failed:", e, flush=True)
    return s, r

s1, r1 = session(marker="BOX1")
token = (r1.get("results") or {}).get("restore_token")
print("restore token:", "yes" if token else "none", flush=True)
bus.call_sync(D, s1, "org.freedesktop.portal.Session", "Close", None, None, 0, 5000, None)
time.sleep(1)
if token:
    s2, r2 = session(restore=token, marker="BOX2")
    print("second session:", "started" if r2.get("code") == 0 else r2.get("code"), flush=True)

r = request("org.freedesktop.portal.Screenshot", "Screenshot",
            lambda t: GLib.Variant("(sa{sv})", ("", {"handle_token": GLib.Variant("s", t), "interactive": GLib.Variant("b", False)})), wait=30, marker="SHOT")
print("screenshot uri:", (r.get("results") or {}).get("uri"), flush=True)
