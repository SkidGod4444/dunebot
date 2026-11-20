#!/usr/bin/env python3
"""Drives dunebot-wayland through every request inside a headless GNOME session (run.sh starts
it, with one or more monitors at any scale) and checks each against a real window. screens.py
answers GNOME's box the way a person would (a Clutter pointer made through Shell.Eval) and says
where the screens and windows are. Test-only.

usage: drive.py <helper binary> <out dir>"""
import hashlib
import json
import os
import tempfile
import queue
import struct
import subprocess
import sys
import threading
import time
import zlib

HELPER, OUT = sys.argv[1], sys.argv[2]
HERE = os.path.dirname(os.path.abspath(__file__))
results = []
TARGET_LINES = [[]]


def check(name, ok, detail=""):
    results.append({"name": name, "ok": bool(ok), "detail": str(detail)})
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail != "" else ""), flush=True)
    return ok


def gdbus(*args, timeout=10):
    r = subprocess.run(["gdbus", "call", "--session", *args], capture_output=True, text=True, timeout=timeout)
    return r.stdout.strip() or r.stderr.strip()


def ev(js):
    return gdbus("--dest", "org.gnome.Shell", "--object-path", "/org/gnome/Shell", "--method", "org.gnome.Shell.Eval", js)


J = "const C = imports.gi.Clutter; const G = imports.gi.GLib;"


def screens(*args):
    r = subprocess.run(["python3", "-I", f"{HERE}/screens.py", *args], capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise RuntimeError(f"screens.py {' '.join(args)}: {(r.stderr or r.stdout).strip()[-300:]}")
    return json.loads(r.stdout)


def shot(name):
    gdbus(
        "--dest", "org.gnome.Shell.Screenshot", "--object-path", "/org/gnome/Shell/Screenshot",
        "--method", "org.gnome.Shell.Screenshot.Screenshot", "true", "false", f"{OUT}/{name}.png",
    )


def bgra_to_png(src, w, h, dst):
    raw = open(src, "rb").read()
    rows = b"".join(b"\x00" + bytes(px for i in range(x, x + w * 4, 4) for px in (raw[i + 2], raw[i + 1], raw[i])) for x in range(0, w * h * 4, w * 4))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 6)) + chunk(b"IEND", b"")
    open(dst, "wb").write(png)


class Lines:
    """A child process whose stdout lines are kept, with a cursor for 'the next line like X'."""

    def __init__(self, argv, log):
        self.p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(log, "w"), text=True, bufsize=1)
        self.lines = []
        self.cv = threading.Condition()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.p.stdout:
            with self.cv:
                self.lines.append(line.rstrip("\n"))
                self.cv.notify_all()

    def mark(self):
        with self.cv:
            return len(self.lines)

    def wait(self, pred, since=0, timeout=10):
        end = time.time() + timeout
        with self.cv:
            while True:
                for line in self.lines[since:]:
                    if pred(line):
                        return line
                left = end - time.time()
                if left <= 0:
                    return None
                self.cv.wait(left)


class Target(Lines):
    """target.py fullscreen on one monitor. It reports in its own logical points; `desk` turns
    those into the desktop's (the window's place, and its size against the points it reports:
    twice as many at 200% when GNOME lays the screens out in pixels)."""

    def __init__(self, monitor=0, secs=240):
        self.title = "target" if monitor == 0 else f"target-{monitor}"
        super().__init__(["python3", f"{HERE}/target.py", str(secs), str(monitor), self.title], f"{OUT}/{self.title}.err")

    def ready(self):
        if not self.wait(lambda l: l == "READY", timeout=30):
            return False
        at = {l.split()[0]: list(map(int, l.split()[1:])) for l in self.lines if l.split()[0] in ("entry", "area", "marker", "size")}
        self.entry, self.area, self.marker, self.size = at["entry"], at["area"], at["marker"], at["size"]
        self.rect = screens("window", self.title)
        self.k = self.rect["w"] / self.size[0]
        return True

    def desk(self, x, y):
        d = (self.rect["x"] + x * self.k, self.rect["y"] + y * self.k)
        return tuple(int(v) if float(v).is_integer() else v for v in d)


class Helper(Lines):
    def __init__(self, log):
        super().__init__([HELPER], log)
        self.n = 0

    def send(self, op, **kw):
        self.n += 1
        self.p.stdin.write(json.dumps({"id": self.n, "op": op, **kw}) + "\n")
        self.p.stdin.flush()
        return self.n

    def answer(self, n, timeout=30):
        line = self.wait(lambda l: l.startswith("{") and json.loads(l).get("id") == n, timeout=timeout)
        return json.loads(line) if line else {"error": "no answer in time"}

    def call(self, op, timeout=30, **kw):
        return self.answer(self.send(op, **kw), timeout)

    def event(self, name, since=0, timeout=10):
        line = self.wait(lambda l: l.startswith("{") and json.loads(l).get("event") == name, since, timeout)
        return json.loads(line) if line else None

    def quit(self):
        try:
            self.p.stdin.close()
        except Exception:
            pass
        try:
            self.p.wait(5)
        except subprocess.TimeoutExpired:
            self.p.kill()


def open_with_box(h, allow_control=True, tag="box"):
    n = h.send("open")
    if not h.event("asking", timeout=20):
        return h.answer(n, 1)
    time.sleep(3)
    shot(f"{tag}-shown")
    if allow_control:
        screens("box", "switch")
    screens("box", "share")
    return h.answer(n, 30)


def click_at(h, x, y, button="left"):
    a = h.call("move", x=x, y=y)
    b = h.call("button", button=button, down=True)
    time.sleep(0.05)
    c = h.call("button", button=button, down=False)
    return next((r["error"] for r in (a, b, c) if "error" in r), None)


def keys(h, *seq):
    for sym, down in seq:
        r = h.call("key", keysym=sym, down=down)
        if "error" in r:
            return r["error"]


def tap(sym):
    return ((sym, True), (sym, False))


CTRL, CAPS, BACKSPACE = 0xFFE3, 0xFFE5, 0xFF08
CLEAR = ((CTRL, True), (0x61, True), (0x61, False), (CTRL, False), (BACKSPACE, True), (BACKSPACE, False))


def type_text(h, s):
    return [r["error"] for r in (h.call("text", ch=c) for c in s) if "error" in r]


def layouts(*names):
    """GNOME's input sources, then the active one (by place in the list)."""
    subprocess.run(["gsettings", "set", "org.gnome.desktop.input-sources", "sources", "[" + ", ".join(f"('xkb', '{n}')" for n in names) + "]"], check=False)
    time.sleep(1.5)


def use_layout(i):
    ev(f"import('resource:///org/gnome/shell/ui/status/keyboard.js').then(m => m.getInputSourceManager().inputSources[{i}].activate(true)); 'ok'")
    time.sleep(1.5)


def frame(h, node, name):
    path = f"{OUT}/{name}.bgra"
    t = time.time()
    r = h.call("frame", node=node, path=path, timeout=15)
    r["secs"] = round(time.time() - t, 3)
    if "error" not in r:
        r["md5"] = hashlib.md5(open(path, "rb").read()).hexdigest()
        r["bytes"] = os.path.getsize(path)
        bgra_to_png(path, r["w"], r["h"], f"{OUT}/{name}.png")
    return r


# Outside OUT: CI uploads OUT, and a light's real name ("input9::capslock") has colons it refuses.
LEDS = tempfile.mkdtemp(prefix="dunebot-leds-")


def main():
    os.makedirs(LEDS, exist_ok=True)
    os.environ["DUNEBOT_WL_LEDS"] = LEDS
    ev("Main.overview.hide(); 'ok'")
    mons = screens("monitors")
    print("monitors:", json.dumps(mons), flush=True)
    target = Target(0)
    TARGET_LINES[0] = target.lines
    if not check("target window up", target.ready()):
        return
    print(f"target: {target.rect}, reports {target.size} (x{target.k})", flush=True)
    D = target.desk
    ex, ey, ew, eh = target.entry
    ax, ay, aw, ah = target.area

    # 1. The box, answered with control allowed.
    h = Helper(f"{OUT}/helper1.err")
    t = time.time()
    r = open_with_box(h, True, "box1")
    print("open:", json.dumps({k: v for k, v in r.items() if k != "token"}), flush=True)
    check("open: keyboard and pointer allowed", r.get("devices") == 3, r.get("devices", r.get("error")))
    check("open: libei hand connected", r.get("hand") is True)
    check("open: screen stream opened", r.get("eyes") is True)
    check("open: a restore token", bool(r.get("token")))
    streams = r.get("streams") or []
    place = lambda g: [g["x"], g["y"], g["w"], g["h"]]
    check(
        f"open: one stream per monitor ({len(mons)}), each where its monitor is",
        sorted(map(place, streams)) == sorted(map(place, mons)),
        f"streams {[place(x) for x in streams]}, monitors {[place(m) for m in mons]}",
    )
    regions = r.get("regions", [])
    check("open: the pointer's regions cover every monitor", all(any(g[:4] == place(m) for g in regions) for m in mons), f"regions {regions}")
    token = r.get("token")
    first = next((x for x in streams if (x["x"], x["y"]) == (mons[0]["x"], mons[0]["y"])), streams[0] if streams else None)
    node = first["node"] if first else 0

    # 2. Screen pictures: every pixel of the monitor (as many as or more than its points).
    f1 = frame(h, node, "frame1")
    fw, fh = f1.get("w", 0), f1.get("h", 0)
    check(
        "frame: the whole monitor, every pixel",
        first and f1.get("bytes") == fw * fh * 4 and fw >= first["w"] and fw * first["h"] == fh * first["w"],
        f"{fw}x{fh} for a {first and first['w']}x{first and first['h']} monitor",
    )
    raw = open(f"{OUT}/frame1.bgra", "rb").read() if "error" not in f1 else b""
    colours = len({raw[i : i + 3] for i in range(0, len(raw), 4 * 997)})
    check("frame: has content (not one colour)", colours > 3, f"{colours} colours sampled")
    ev("Main.overview.show(); 'ok'")
    time.sleep(1.5)
    f2 = frame(h, node, "frame2")
    check("frame: a new picture after the screen changed", f2.get("md5") and f2.get("md5") != f1.get("md5"), f"{f2.get('secs')} s")
    ev("Main.overview.hide(); 'ok'")
    time.sleep(1.5)

    # 3. Clicks land where asked.
    for i, (x, y) in enumerate([(ax + 200, ay + 150), (ax + aw - 40, ay + ah - 40), (ax + 7, ay + 9)]):
        m = target.mark()
        err = click_at(h, *D(x, y))
        line = target.wait(lambda l: l.startswith("press 1 "), m, 5)
        got = list(map(int, line.split()[2:4])) if line else None
        check(f"click {i + 1} lands at ({x}, {y})", got and abs(got[0] - x) <= 1 and abs(got[1] - y) <= 1, err or f"{got}, sent {D(x, y)}")
        check(f"click {i + 1} released", target.wait(lambda l: l.startswith("release 1 "), m, 3))
    m = target.mark()
    err = click_at(h, *D(ax + 300, ay + 200), "right")
    check("right click", target.wait(lambda l: l.startswith("press 3 "), m, 5), err or "")

    # 3b. Every other monitor: its picture, and clicks on a window there.
    for i, mon in enumerate(mons[1:], 1):
        st = next((x for x in streams if (x["x"], x["y"]) == (mon["x"], mon["y"])), None)
        fi = frame(h, st["node"], f"frame-monitor{i}") if st else {"error": "no stream"}
        check(f"monitor {i}: its own picture, every pixel", st and fi.get("bytes") == fi.get("w", 0) * fi.get("h", 0) * 4 and fi.get("w", 0) >= st["w"], fi.get("error") or f"{fi['w']}x{fi['h']} for {place(mon)} at scale {mon['scale']}")
        other = Target(i)
        if check(f"monitor {i}: a window there", other.ready() and other.rect["monitor"] == i, getattr(other, "rect", None)):
            oax, oay, oaw, oah = other.area
            for x, y in [(oax + 200, oay + 150), (oax + oaw - 40, oay + oah - 40)]:
                m = other.mark()
                err = click_at(h, *other.desk(x, y))
                line = other.wait(lambda l: l.startswith("press 1 "), m, 5)
                got = list(map(int, line.split()[2:4])) if line else None
                check(f"monitor {i}: a click lands at ({x}, {y})", got and abs(got[0] - x) <= 1 and abs(got[1] - y) <= 1, err or f"{got}, sent {other.desk(x, y)}")
        other.p.terminate()
    m = target.mark()
    err = h.call("move", x=max(m["x"] + m["w"] for m in mons) + 1000, y=10)
    check("a point off every screen is refused", "error" in err, err.get("error"))

    # 4. Typing by the layout.
    click_at(h, *D(ex + ew // 2, ey + eh // 2))
    time.sleep(0.3)
    text = "Hello, World! 123 ~ (a+b)={c}"
    m = target.mark()
    errs = [r["error"] for r in (h.call("text", ch=c) for c in text) if "error" in r]
    want = "text " + repr(text)
    check("typed text arrives exactly", target.wait(lambda l: l == want, m, 5), errs or "")
    m = target.mark()
    for sym, down in ((0xFFE3, True), (0x61, True), (0x61, False), (0xFFE3, False), (0xFF08, True), (0xFF08, False)):
        h.call("key", keysym=sym, down=down)
    check("keys by keysym (Ctrl+A, BackSpace) clear the box", target.wait(lambda l: l == "text ''", m, 5))
    m = target.mark()
    err = keys(h, *tap(0x21))
    check("a key on the Shift level (!) gets Shift held for it", target.wait(lambda l: l == "text '!'", m, 5), err or "")
    keys(h, *tap(BACKSPACE))
    time.sleep(0.3)
    r = h.call("can_type", text="aé€жZ")
    missing = r.get("missing", "")
    check("characters missing from the layout are found", "é" in missing and "ж" in missing and "a" not in missing, r)
    r = h.call("text", ch="ж")
    check("a missing character is refused, not claimed typed", "error" in r, r.get("error"))
    # Whatever the helper says it can type, it really types.
    if "€" not in missing:
        m = target.mark()
        r = h.call("text", ch="€")
        check("a character the layout has (€ here) arrives as itself", target.wait(lambda l: l == "text '€'", m, 5), r)
        for sym, down in ((0xFF08, True), (0xFF08, False)):
            h.call("key", keysym=sym, down=down)
        time.sleep(0.3)

    # 4b. Caps Lock. GNOME 49.5 and later tell libei the keyboard's state (Caps Lock, the layout in
    # use): the helper says it read it from the desktop. Before that the helper reads the keyboard's
    # Caps Lock light (DUNEBOT_WL_LEDS: a folder laid out like /sys/class/leds, which a container
    # lacks; the test sets the light as a keyboard's would be). No light: said so. Either way the
    # text typed with Caps Lock on must arrive as asked.
    keys(h, *tap(CAPS))
    time.sleep(1.2)
    st = h.call("can_type", text="a").get("state", {})
    exact = st.get("from") == "desktop"
    print(f"note: keyboard state from {'the desktop (exact)' if exact else 'settings and the Caps Lock light'}", flush=True)
    if not exact:
        check("Caps Lock with no keyboard light: said it can't be checked", st == {"from": "settings", "caps": None}, st)
    led = os.path.join(LEDS, "input9::capslock")
    os.makedirs(led, exist_ok=True)
    open(os.path.join(led, "brightness"), "w").write("1\n")
    time.sleep(1.2)
    st = h.call("can_type", text="a").get("state", {})
    if exact:
        check("Caps Lock: read from the desktop, no light needed", st == {"from": "desktop"}, st)
    else:
        check("Caps Lock light on: read", st.get("caps") is True, st)
    m = target.mark()
    errs = type_text(h, "aB1")
    check("Caps Lock on: typed text arrives exactly", target.wait(lambda l: l == "text 'aB1'", m, 5), errs or "")
    m = target.mark()
    keys(h, *CLEAR)
    check("Caps Lock on: Ctrl+A, BackSpace still clear the box", target.wait(lambda l: l == "text ''", m, 5))
    keys(h, *tap(CAPS))
    open(os.path.join(led, "brightness"), "w").write("0\n")
    time.sleep(1.2)
    m = target.mark()
    errs = type_text(h, "aB1")
    check("Caps Lock off again: typed text arrives exactly", target.wait(lambda l: l == "text 'aB1'", m, 5), errs or "")
    keys(h, *CLEAR)
    time.sleep(0.3)

    # 4c. Other layouts, switched to while the session runs: German (Shift and AltGr symbols, y/z
    # swapped), Russian (Latin letters refused, Cyrillic typed).
    layouts("us", "de", "ru")
    use_layout(1)
    m = target.mark()
    want = "y@z/{ä}"
    errs = type_text(h, want)
    check("German layout: text arrives exactly (AltGr, Shift, y/z)", target.wait(lambda l: l == "text " + repr(want), m, 5), errs or "")
    m = target.mark()
    keys(h, *CLEAR)
    check("German layout: Ctrl+A, BackSpace clear the box", target.wait(lambda l: l == "text ''", m, 5))
    use_layout(2)
    r = h.call("can_type", text="aж")
    check("Russian layout: Latin missing, Cyrillic there", r.get("missing") == "a", r)
    r = h.call("text", ch="a")
    check("Russian layout: a refused, naming the layout", "Russian" in r.get("error", ""), r.get("error"))
    m = target.mark()
    errs = type_text(h, "жук")
    check("Russian layout: Cyrillic arrives exactly", target.wait(lambda l: l == "text 'жук'", m, 5), errs or "")
    m = target.mark()
    keys(h, *CLEAR)
    clear_ru = target.wait(lambda l: l == "text ''", m, 5)
    print(f"note: Ctrl+A on the Russian layout {'cleared' if clear_ru else 'did not clear'} the box (the app's own matching)", flush=True)
    # A layout per window: GNOME switches on focus without recording which. Read from the settings,
    # the layout in use can't be told, so text is refused; told by the desktop, it can: Russian here.
    subprocess.run(["gsettings", "set", "org.gnome.desktop.input-sources", "per-window", "true"], check=False)
    time.sleep(1.5)
    r = h.call("text", ch="a")
    if exact:
        check("a layout per window: the layout in use is known (Russian), so a is refused naming it", "Russian" in r.get("error", ""), r.get("error"))
        m = target.mark()
        errs = type_text(h, "ж")
        check("a layout per window: Cyrillic still arrives", target.wait(lambda l: l.startswith("text ") and l.endswith("ж'"), m, 5), errs or "")
        keys(h, *CLEAR)
    else:
        check("a layout per window: text refused, saying why", "each window" in r.get("error", ""), r.get("error"))
    subprocess.run(["gsettings", "set", "org.gnome.desktop.input-sources", "per-window", "false"], check=False)
    time.sleep(1.5)
    use_layout(0)
    layouts("us")
    keys(h, *CLEAR)
    time.sleep(0.3)
    m = target.mark()
    errs = type_text(h, "ok")
    check("back on US: typing works", target.wait(lambda l: l == "text 'ok'", m, 5), errs or "")
    keys(h, *CLEAR)
    time.sleep(0.3)

    # 4d. A drag: down at one point, moves, up at another. A double click.
    m = target.mark()
    pts = [(ax + 100, ay + 100), (ax + 200, ay + 140), (ax + 300, ay + 180), (ax + 400, ay + 220)]
    h.call("move", x=D(*pts[0])[0], y=D(*pts[0])[1])
    h.call("button", button="left", down=True)
    for x, y in pts[1:]:
        # Apart by more than a frame: GTK merges moves within one, and at 200% in software a frame
        # took longer than 50 ms (GNOME 49 saw 2 of 3 moves).
        time.sleep(0.12)
        h.call("move", x=D(x, y)[0], y=D(x, y)[1])
    h.call("button", button="left", down=False)
    pressed = target.wait(lambda l: l.startswith("press 1 "), m, 5)
    released = target.wait(lambda l: l.startswith("release 1 "), m, 5)
    moved = [l for l in target.lines[m:] if l.startswith("drag-motion")]
    check(
        "drag: pressed at the start, moved, released at the end",
        pressed and released and pressed.split()[2:4] == [str(pts[0][0]), str(pts[0][1])] and released.split()[2:4] == [str(pts[-1][0]), str(pts[-1][1])] and len(moved) >= 3,
        f"{pressed} / {len(moved)} moves / {released}",
    )
    m = target.mark()
    h.call("move", x=D(ax + 500, ay + 200)[0], y=D(ax + 500, ay + 200)[1])
    for _ in range(2):
        h.call("button", button="left", down=True)
        time.sleep(0.03)
        h.call("button", button="left", down=False)
        time.sleep(0.06)
    dbl = target.wait(lambda l: l.startswith("press 1 ") and ("2button" in l or "double" in l), m, 5)
    check("double click is seen as one", dbl, dbl)

    # 5. Scrolling: +1 is up.
    h.call("move", x=D(ax + 200, ay + 150)[0], y=D(ax + 200, ay + 150)[1])
    m = target.mark()
    r = h.call("scroll", dx=0, dy=1, n=3)
    up = target.wait(lambda l: l.startswith("scroll"), m, 5)
    check("scroll dy=+1 goes up", up and (up == "scroll up" or (up.startswith("scroll smooth") and float(up.split()[3]) < 0)), up or r)
    time.sleep(0.8)  # the rest of those notches arrive first
    m = target.mark()
    h.call("scroll", dx=0, dy=-1, n=2)
    down = target.wait(lambda l: l.startswith("scroll"), m, 5)
    check("scroll dy=-1 goes down", down and (down == "scroll down" or (down.startswith("scroll smooth") and float(down.split()[3]) > 0)), down)

    r = h.call("close")
    check("close", r.get("ok"), r)
    r = h.call("move", x=10, y=10)
    check("after close, input is refused", "error" in r, r.get("error"))
    h.quit()

    # 6. A new run with the saved token: no box, same rights.
    h = Helper(f"{OUT}/helper2.err")
    t = time.time()
    r = h.call("open", token=token, timeout=20)
    secs = round(time.time() - t, 2)
    shot("restore")
    check("restore: no box, answered at once", "error" not in r and secs < 6, f"{secs} s")
    check("restore: keyboard and pointer again", r.get("devices") == 3 and r.get("hand") is True, r.get("devices", r.get("error")))
    check("restore: GNOME kept the token", r.get("token") == token, "same" if r.get("token") == token else "new token")
    token = r.get("token") or token
    m = target.mark()
    click_at(h, *D(ax + 250, ay + 100))
    line = target.wait(lambda l: l.startswith("press 1 "), m, 5)
    check("restore: clicks work", line and line.split()[2:4] == [str(ax + 250), str(ay + 100)], line)

    # 7. Ended from GNOME's side (the top bar's Stop): the helper says so.
    m = h.mark()
    # What the top bar's "Stop Screen Sharing" button does when pressed (GNOME 46 panel.js).
    stopped = ev("(() => { const s = Main.panel.statusArea.screenSharing; if (!s) return 'no indicator'; const n = s._handles.size; s._stopSharing(); return 'stopped ' + n; })()")
    print("gnome stop:", stopped, flush=True)
    check("ended from GNOME: helper reports closed", h.event("closed", m, 8), stopped)
    r = h.call("move", x=10, y=10)
    check("ended from GNOME: input refused after", "error" in r, r.get("error"))
    h.quit()

    # 7b. A box nobody answers: the app cancels it (close), the box goes, the next open still works.
    def portal_windows():
        out = ev("String(global.get_window_actors().filter(a => (a.meta_window.get_wm_class() || '').includes('portal')).length)")
        digits = "".join(c for c in out.split(",")[-1] if c.isdigit())
        return int(digits) if digits else -1

    h = Helper(f"{OUT}/helper-cancel.err")
    n = h.send("open")
    h.event("asking", timeout=20)
    time.sleep(3)
    before = portal_windows()
    t = time.time()
    r = h.call("close", timeout=10)
    a = h.answer(n, 5)
    try:
        h.p.wait(5)
        ended = True
    except subprocess.TimeoutExpired:
        ended = False
    time.sleep(1.5)
    after = portal_windows()
    shot("cancelled")
    check("an unanswered box is cancelled by close (the helper ends)", r.get("ok") and a.get("error") == "cancelled" and ended, f"{round(time.time() - t, 2)} s, open said {a}")
    check("the box goes away", before >= 1 and after == 0, f"portal windows {before} -> {after}")
    h = Helper(f"{OUT}/helper-cancel2.err")
    r = open_with_box(h, True, "box-after-cancel")
    check("after a cancel, a new box works", r.get("devices") == 3 and r.get("hand") is True, r.get("devices", r.get("error")))
    h.quit()
    h = Helper(f"{OUT}/helper-eof.err")
    n = h.send("open")
    h.event("asking", timeout=20)
    time.sleep(3)
    h.quit()  # the app went away mid-box
    time.sleep(1.5)
    check("an unanswered box goes when the app goes away", portal_windows() == 0, portal_windows())

    # 8. Share pressed without the control switch: screen only, no hand.
    h = Helper(f"{OUT}/helper3.err")
    r = open_with_box(h, False, "box3")
    print("open screen-only:", json.dumps({k: v for k, v in r.items() if k != "token"}), flush=True)
    check("screen-only answer: devices 0, no hand", r.get("devices") == 0 and r.get("hand") is False, r.get("devices", r.get("error")))
    r = h.call("move", x=10, y=10)
    check("screen-only: input refused with a reason", "wasn't allowed" in r.get("error", ""), r.get("error"))
    h.quit()
    target.p.terminate()


try:
    main()
except Exception as e:
    # A crash must never read as a pass: the summary below only counts the checks that ran.
    import traceback

    traceback.print_exc()
    check("helper test ran to the end", False, repr(e)[:300])
finally:
    try:
        open(f"{OUT}/target.log", "w").write("\n".join(TARGET_LINES[0]) + "\n")
    except Exception:
        pass
    json.dump(results, open(f"{OUT}/results.json", "w"), indent=1)
    bad = [r["name"] for r in results if not r["ok"]]
    print(f"\n{len(results) - len(bad)}/{len(results)} passed" + (f"; failed: {bad}" if bad else ""), flush=True)
    sys.exit(1 if bad or not results else 0)
