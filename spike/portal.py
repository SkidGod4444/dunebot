"""The RemoteDesktop portal, as an app would use it: create, ask for keyboard+pointer (persistent),
start (the user's box), then the EIS connection. Prints what each step answers."""
import sys
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
me = bus.get_unique_name()[1:].replace(".", "_")
D, P = "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop"
RD = "org.freedesktop.portal.RemoteDesktop"

def prop(iface, name):
    try:
        v = bus.call_sync(D, P, "org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", (iface, name)), None, 0, 5000, None)
        return v.unpack()[0]
    except Exception as e:
        return f"error: {e}"

print("RemoteDesktop version", prop(RD, "version"), "devices", prop(RD, "AvailableDeviceTypes"), flush=True)
print("ScreenCast version", prop("org.freedesktop.portal.ScreenCast", "version"), flush=True)
print("Screenshot version", prop("org.freedesktop.portal.Screenshot", "version"), flush=True)

def request(method, args, token, wait=60):
    path = f"/org/freedesktop/portal/desktop/request/{me}/{token}"
    out = {}
    loop = GLib.MainLoop()
    def on(conn, s, o, i, sig, params):
        code, res = params.unpack()
        out["code"], out["results"] = code, res
        loop.quit()
    sub = bus.signal_subscribe(D, "org.freedesktop.portal.Request", "Response", path, None, 0, on)
    bus.call_sync(D, P, RD, method, args, None, 0, -1, None)
    GLib.timeout_add_seconds(wait, lambda: (out.setdefault("code", "no answer"), loop.quit()))
    loop.run()
    bus.signal_unsubscribe(sub)
    print(method, "->", out, flush=True)
    return out

r = request("CreateSession", GLib.Variant("(a{sv})", ({"handle_token": GLib.Variant("s", "t1"), "session_handle_token": GLib.Variant("s", "s1")},)), "t1")
session = r.get("results", {}).get("session_handle")
if not session:
    sys.exit("no session")
request("SelectDevices", GLib.Variant("(oa{sv})", (session, {"handle_token": GLib.Variant("s", "t2"), "types": GLib.Variant("u", 3), "persist_mode": GLib.Variant("u", 2)})), "t2")
r = request("Start", GLib.Variant("(osa{sv})", (session, "", {"handle_token": GLib.Variant("s", "t3")})), "t3", wait=80)
if r.get("code") != 0:
    sys.exit("not started")
try:
    v, fds = bus.call_with_unix_fd_list_sync(D, P, RD, "ConnectToEIS", GLib.Variant("(oa{sv})", (session, {})), GLib.VariantType("(h)"), 0, 5000, None, None)
    print("ConnectToEIS ->", v.unpack(), "fds", fds.get_length() if fds else 0, flush=True)
except Exception as e:
    print("ConnectToEIS failed:", e, flush=True)
