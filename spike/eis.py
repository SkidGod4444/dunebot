"""A throwaway libei client (ctypes), the compositor side of what Dune Bot would do on Wayland.
drive(fd, steps): steps are ("click", x, y) | ("type", text) | ("wait", s)."""
import ctypes as C, mmap, os, select, time

ei = C.CDLL("libei.so.1")
xkb = C.CDLL("libxkbcommon.so.0")
P = C.c_void_p

def f(lib, name, res, *args):
    fn = getattr(lib, name)
    fn.restype = res
    fn.argtypes = list(args)
    return fn

new_sender = f(ei, "ei_new_sender", P, P)
configure_name = f(ei, "ei_configure_name", None, P, C.c_char_p)
setup_fd = f(ei, "ei_setup_backend_fd", C.c_int, P, C.c_int)
get_fd = f(ei, "ei_get_fd", C.c_int, P)
dispatch = f(ei, "ei_dispatch", None, P)
get_event = f(ei, "ei_get_event", P, P)
ev_type = f(ei, "ei_event_get_type", C.c_int, P)
ev_name = f(ei, "ei_event_type_to_string", C.c_char_p, C.c_int)
ev_seat = f(ei, "ei_event_get_seat", P, P)
ev_device = f(ei, "ei_event_get_device", P, P)
ev_unref = f(ei, "ei_event_unref", P, P)
seat_ref = f(ei, "ei_seat_ref", P, P)
dev_ref = f(ei, "ei_device_ref", P, P)
bind = ei.ei_seat_bind_capabilities
bind.restype = None
has_cap = f(ei, "ei_device_has_capability", C.c_bool, P, C.c_int)
dev_name = f(ei, "ei_device_get_name", C.c_char_p, P)
start = f(ei, "ei_device_start_emulating", None, P, C.c_uint32)
stop = f(ei, "ei_device_stop_emulating", None, P)
abs_move = f(ei, "ei_device_pointer_motion_absolute", None, P, C.c_double, C.c_double)
button = f(ei, "ei_device_button_button", None, P, C.c_uint32, C.c_bool)
key = f(ei, "ei_device_keyboard_key", None, P, C.c_uint32, C.c_bool)
frame = f(ei, "ei_device_frame", None, P, C.c_uint64)
now = f(ei, "ei_now", C.c_uint64, P)
region = f(ei, "ei_device_get_region", P, P, C.c_size_t)
rx, ry, rw, rh = (f(ei, f"ei_region_get_{n}", C.c_uint32, P) for n in ("x", "y", "width", "height"))
rscale = f(ei, "ei_region_get_physical_scale", C.c_double, P)
get_keymap = f(ei, "ei_device_keyboard_get_keymap", P, P)
km_fd = f(ei, "ei_keymap_get_fd", C.c_int, P)
km_size = f(ei, "ei_keymap_get_size", C.c_size_t, P)

xkb_ctx = f(xkb, "xkb_context_new", P, C.c_int)
xkb_km = f(xkb, "xkb_keymap_new_from_string", P, P, C.c_char_p, C.c_int, C.c_int)
xkb_min = f(xkb, "xkb_keymap_min_keycode", C.c_uint32, P)
xkb_max = f(xkb, "xkb_keymap_max_keycode", C.c_uint32, P)
xkb_levels = f(xkb, "xkb_keymap_num_levels_for_key", C.c_uint32, P, C.c_uint32, C.c_uint32)
xkb_syms = f(xkb, "xkb_keymap_key_get_syms_by_level", C.c_int, P, C.c_uint32, C.c_uint32, C.c_uint32, C.POINTER(C.POINTER(C.c_uint32)))
xkb_u2k = f(xkb, "xkb_utf32_to_keysym", C.c_uint32, C.c_uint32)

CAPS = {"pointer": 1, "absolute": 2, "keyboard": 4, "touch": 8, "scroll": 16, "button": 32}
BTN_LEFT, KEY_LEFTSHIFT = 0x110, 42

def say(*a):
    print(time.strftime("%H:%M:%S"), "eis:", *a, flush=True)

def drive(fd, steps):
    ctx = new_sender(None)
    configure_name(ctx, b"dunebot-spike")
    rc = setup_fd(ctx, fd)
    say("setup", rc)
    efd = get_fd(ctx)
    devices, resumed = {}, set()

    def pump(t=0.3):
        select.select([efd], [], [], t)
        dispatch(ctx)
        while True:
            e = get_event(ctx)
            if not e:
                break
            name = ev_name(ev_type(e)).decode()
            if name.endswith("SEAT_ADDED"):
                seat = seat_ref(ev_seat(e))
                bind(seat, *[C.c_int(v) for v in CAPS.values()], C.c_int(0))
                say("seat added; bound", list(CAPS))
            elif name.endswith("DEVICE_ADDED"):
                d = dev_ref(ev_device(e))
                caps = [k for k, v in CAPS.items() if has_cap(d, v)]
                regions = []
                for i in range(8):
                    r = region(d, i)
                    if not r:
                        break
                    regions.append((rx(r), ry(r), rw(r), rh(r), rscale(r)))
                devices[d] = caps
                say("device", dev_name(d).decode(), caps, "regions", regions)
            elif name.endswith("DEVICE_RESUMED"):
                resumed.add(ev_device(e))
                say("resumed", dev_name(ev_device(e)).decode())
            elif not name.endswith("FRAME"):
                say("event", name)
            ev_unref(e)

    t0 = time.time()
    while time.time() - t0 < 5 and not (resumed and any("keyboard" in c for d, c in devices.items() if d in resumed) and any("absolute" in c for d, c in devices.items() if d in resumed)):
        pump()
    absdev = next((d for d, c in devices.items() if "absolute" in c and d in resumed), None)
    kbd = next((d for d, c in devices.items() if "keyboard" in c and d in resumed), None)
    say("absolute pointer:", bool(absdev), "keyboard:", bool(kbd))

    table = {}
    if kbd:
        km = get_keymap(kbd)
        if km:
            buf = mmap.mmap(km_fd(km), km_size(km), mmap.MAP_PRIVATE, mmap.PROT_READ)
            text = bytes(buf).rstrip(b"\0")
            k = xkb_km(xkb_ctx(0), text, 1, 0)
            for kc in range(xkb_min(k), xkb_max(k) + 1):
                for lvl in range(min(xkb_levels(k, kc, 0), 2)):
                    out = C.POINTER(C.c_uint32)()
                    for i in range(xkb_syms(k, kc, 0, lvl, C.byref(out))):
                        table.setdefault(out[i], (kc - 8, lvl))
            say("keymap", len(text), "bytes;", len(table), "keysyms on levels 1-2")
        else:
            say("keyboard has no keymap")

    seq = [1]
    def emit(dev, fn):
        start(dev, seq[0]); seq[0] += 1
        fn()
        stop(dev)
        pump(0.05)

    for st in steps:
        if st[0] == "click" and absdev:
            x, y = st[1], st[2]
            def c():
                abs_move(absdev, x, y); frame(absdev, now(ctx))
                button(absdev, BTN_LEFT, True); frame(absdev, now(ctx))
                button(absdev, BTN_LEFT, False); frame(absdev, now(ctx))
            emit(absdev, c)
            say("clicked", x, y)
        elif st[0] == "type" and kbd:
            for ch in st[1]:
                hit = table.get(xkb_u2k(ord(ch)))
                if not hit:
                    say(f"can't type {ch!r}: no key for it on this layout")
                    continue
                code, lvl = hit
                def t():
                    if lvl:
                        key(kbd, KEY_LEFTSHIFT, True); frame(kbd, now(ctx))
                    key(kbd, code, True); frame(kbd, now(ctx))
                    key(kbd, code, False); frame(kbd, now(ctx))
                    if lvl:
                        key(kbd, KEY_LEFTSHIFT, False); frame(kbd, now(ctx))
                emit(kbd, t)
                say(f"typed {ch!r} as key {code}{' + shift' if lvl else ''}")
        elif st[0] == "wait":
            t1 = time.time()
            while time.time() - t1 < st[1]:
                pump()
    pump(0.5)
