"""How well a real agent aims a click. This script plays the app: the core's pictures come from a
made-up screen with small targets at known pixels (rendered by headless Chrome, never the real
screen), and its clicks are recorded, never done. For each target it prints where the first click
landed in the picture and whether it hit. With a picture size, the same screen is sent at that
size instead (to see whether the model gets the picture shrunk). "dense" is the hard one: a busy
browser and editor laid out at a MacBook's 1512x982 points with 16 px icons, drawn at Retina 2x and
shrunk to the 1568x1018 picture the app sends, as on the real Mac.
Usage: python3 -I core_click_aim.py <core> <data-dir> [agent] [WxH|dense]   (DUNEBOT_CODEMAX: a codemax with `serve`)"""
import base64, json, os, queue, subprocess, sys, tempfile, threading, time
core, data = sys.argv[1], sys.argv[2]
agent = sys.argv[3] if len(sys.argv) > 3 else "claude"
MODE = sys.argv[4] if len(sys.argv) > 4 else "1568x1018"
DENSE = MODE == "dense"
W, H = (1568, 1018) if DENSE else (int(v) for v in MODE.split("x"))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DISPLAY = {"x": 0, "y": 0, "width": 1512, "height": 982}  # a MacBook's display, in points

# Targets in the page's own pixels (1568x1018): name, the ask, the box that counts as a hit.
BASE_W, BASE_H = 1568, 1018
TARGETS = [
    ("address bar", "click in the browser's address bar", (470, 44, 1150, 76)),
    ("Send", "click the Send button", (1352, 902, 1412, 932)),
    ("checkbox", "tick the Remember me checkbox", (300, 520, 318, 538)),
    ("file", "click Q3-report.pdf in the file list", (1100, 760, 1300, 782)),
]

work = tempfile.mkdtemp(prefix="dunebot-aim-")
page = os.path.join(work, "screen.html")
open(page, "w").write("""<!doctype html><meta charset=utf-8><style>
body{margin:0;width:1568px;height:1018px;background:#e9eaee;font:14px -apple-system,Helvetica,sans-serif;position:relative;overflow:hidden}
.abs{position:absolute} .tool{left:0;top:30px;width:1568px;height:60px;background:#f6f6f8;border-bottom:1px solid #d0d0d6}
.addr{left:430px;top:44px;width:720px;height:32px;background:#fff;border:1px solid #c8c8d0;border-radius:8px}
.icon{left:438px;top:52px;width:16px;height:16px;border-radius:4px;background:#8a8a95}
.url{left:470px;top:51px;color:#333} .menu{left:0;top:0;width:1568px;height:30px;background:#ddd}
.btn{height:30px;border-radius:6px;border:1px solid #b8b8c4;background:#fafafa;text-align:center;line-height:30px;font-size:13px}
.box{width:16px;height:16px;border:1px solid #777;border-radius:3px;background:#fff}
.list div{height:22px;line-height:22px;padding-left:6px;color:#222}
</style>
<div class="abs menu"></div><div class="abs tool"></div>
<div class="abs addr"></div><div class="abs icon" title="site info"></div><div class="abs url">www.example.com/inbox</div>
<div class="abs" style="left:260px;top:470px;font-size:18px;font-weight:600">Sign in</div>
<div class="abs box" style="left:300px;top:520px"></div><div class="abs" style="left:326px;top:519px">Remember me</div>
<div class="abs" style="left:1060px;top:690px;width:300px;font-weight:600">Files</div>
<div class="abs list" style="left:1094px;top:716px;width:300px">
<div>Q1-report.pdf</div><div>Q2-report.pdf</div><div style="margin-top:0">Q3-report.pdf</div><div>Q4-report.pdf</div></div>
<div class="abs btn" style="left:1250px;top:902px;width:92px">Save draft</div>
<div class="abs btn" style="left:1352px;top:902px;width:60px">Send</div>
<div class="abs btn" style="left:1420px;top:902px;width:70px">Delete</div>""")
png = os.path.join(work, "screen.png")
DENSE_PAGE = """<!doctype html><meta charset=utf-8><style>
*{box-sizing:border-box} body{margin:0;width:1512px;height:982px;overflow:hidden;font:13px -apple-system,Helvetica,sans-serif;color:#222;background:#fff}
.row{display:flex;align-items:center} .menu{height:24px;background:#ececec;gap:18px;padding-left:14px;font-size:13px}
.tabs{height:38px;background:#dfe1e5;padding:6px 0 0 80px;gap:4px;align-items:flex-end}
.tab{width:200px;height:32px;border-radius:8px 8px 0 0;padding:0 6px 0 10px;gap:8px;font-size:12px;color:#333}
.tab.on{background:#fff} .fav{width:14px;height:14px;border-radius:3px;flex:none} .tt{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.x{width:16px;height:16px;border-radius:8px;font-size:12px;line-height:16px;text-align:center;color:#555;flex:none}
.bar{height:40px;padding:0 10px;gap:4px;border-bottom:1px solid #ddd} .nav{width:28px;height:28px;border-radius:14px;font-size:17px;line-height:28px;text-align:center;color:#444}
.addr{flex:1;height:28px;border-radius:14px;background:#f1f3f4;padding:0 8px;gap:8px;margin:0 8px}
.ic{width:20px;height:20px;border-radius:10px;font-size:12px;line-height:20px;text-align:center;color:#555;flex:none} .url{flex:1;height:28px;line-height:28px;color:#333}
.ext{width:24px;height:24px;border-radius:5px;flex:none}
.side{position:absolute;left:0;top:102px;width:220px;bottom:0;background:#f7f7f8;border-right:1px solid #e3e3e6;padding:10px 0}
.side div{height:26px;line-height:26px;padding-left:18px;font-size:13px;color:#333}
.main{position:absolute;left:240px;top:118px;right:40px}
.tools{gap:2px;padding:4px;border:1px solid #e3e3e6;border-radius:6px;width:max-content}
.tb{width:26px;height:26px;border-radius:4px;text-align:center;line-height:26px;font-size:14px;color:#333}
h1{font-size:22px;margin:22px 0 10px} p{line-height:20px;margin:0 0 10px;max-width:720px} a{color:#1a62d6;text-decoration:underline}
</style>
<div class="row menu"><b>Aside</b><span>File</span><span>Edit</span><span>View</span><span>History</span><span>Bookmarks</span><span>Window</span><span>Help</span></div>
<div class="row tabs">
 <div class="row tab"><span class="fav" style="background:#d93025"></span><span class="tt">Inbox (3) - Mail</span><span class="x">✕</span></div>
 <div class="row tab"><span class="fav" style="background:#24292f"></span><span class="tt">Pull requests · GitHub</span><span class="x" data-target="close tab">✕</span></div>
 <div class="row tab on"><span class="fav" style="background:#555"></span><span class="tt">Release notes - Docs</span><span class="x">✕</span></div>
 <div class="row tab"><span class="fav" style="background:#2f7d32"></span><span class="tt">Pricing - Acme</span><span class="x">✕</span></div>
 <span style="font-size:18px;color:#555;padding:0 0 6px 8px">+</span></div>
<div class="row bar"><span class="nav">←</span><span class="nav">→</span><span class="nav" data-target="reload">↻</span>
 <div class="row addr"><span class="ic">ⓘ</span><span class="url" data-target="address bar">docs.example.com/releases/2026-11</span><span class="ic">☆</span><span class="ic">⇪</span></div>
 <span class="ext" style="background:#e8eaed"></span><span class="ext" style="background:#c6dafc"></span><span class="ext" style="background:#fde293"></span><span class="nav">⋮</span></div>
<div class="side"><div>Getting started</div><div>Install</div><div><b>Release notes</b></div><div>Settings</div><div>Shortcuts</div><div>Troubleshooting</div><div>API</div></div>
<div class="main">
 <div class="row tools"><span class="tb"><b>B</b></span><span class="tb" data-target="Italic"><i style="font-family:Georgia,serif">I</i></span><span class="tb"><u>U</u></span><span class="tb"><s>S</s></span><span class="tb">H1</span><span class="tb">H2</span><span class="tb">•</span><span class="tb">1.</span><span class="tb">❝</span><span class="tb">⌘</span></div>
 <h1>Release notes, November 2026</h1>
 <p>This release adds faster sync, a new sharing dialog and offline search. Workspaces on the Team plan get the new audit log, and admins can now export it as CSV.</p>
 <p>Seat limits changed for older plans. See the <a data-target="pricing link">pricing</a> page for the new limits, or read the <a>migration guide</a> before you upgrade.</p>
 <p>Known issues: the desktop app may ask you to sign in again after the update. Signing in once fixes it.</p>
</div>
<script>document.body.dataset.boxes = JSON.stringify([...document.querySelectorAll("[data-target]")].map(e => { const r = e.getBoundingClientRect(); return [e.dataset.target, [r.left, r.top, r.right, r.bottom].map(Math.round)]; }));</script>"""
DENSE_TARGETS = {"reload": "click the reload button", "close tab": "close the GitHub tab", "Italic": "click the Italic button in the editor toolbar",
                 "pricing link": "click the pricing link in the article", "address bar": "click in the browser's address bar"}
if DENSE:
    open(page, "w").write(DENSE_PAGE)
    dom = subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--window-size=1512,982", "--dump-dom", "file://" + page],
                         check=True, capture_output=True, text=True, timeout=60).stdout
    boxes = dict(json.loads(dom.split('data-boxes="', 1)[1].split('"', 1)[0].replace("&quot;", '"')))
    TARGETS = [(name, ask, tuple(boxes[name])) for name, ask in DENSE_TARGETS.items()]
    big = os.path.join(work, "screen-2x.png")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--screenshot={big}", "--window-size=1512,982",
                    "--force-device-scale-factor=2", "file://" + page], check=True, capture_output=True, timeout=60)
    subprocess.run(["sips", "-z", str(H), str(W), big, "--out", png], check=True, capture_output=True)
else:
  subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--screenshot={png}", f"--window-size={BASE_W},{BASE_H}",
                "--force-device-scale-factor=1", "file://" + page], check=True, capture_output=True, timeout=60)
if not DENSE and (W, H) != (BASE_W, BASE_H):
    small = os.path.join(work, "screen-small.png")
    subprocess.run(["sips", "-z", str(H), str(W), png, "--out", small], check=True, capture_output=True)
    png = small
picture = base64.b64encode(open(png, "rb").read()).decode()
scale = DISPLAY["width"] / W  # points per picture pixel, as the core works it out

class Core:
    def __init__(self):
        self.p = subprocess.Popen([core], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(os.path.join(data, "core-stderr.log"), "a"),
                                  env=dict(os.environ, DUNEBOT_DATA_DIR=data, DUNEBOT_APPROVAL_MIN_MS="0"), text=True, encoding="utf-8", bufsize=1)
        self.q = queue.Queue(); self.n = 0; self.clicks = []
        threading.Thread(target=lambda: [self.q.put(json.loads(l)) for l in self.p.stdout], daemon=True).start()
        self.wait(lambda m: m.get("event") == "ready", 10)
    def wait(self, pred, timeout):
        end = time.time() + timeout
        while time.time() < end:
            try: m = self.q.get(timeout=0.5)
            except queue.Empty: continue
            if m.get("event") == "approval.request":
                self.call("approvals.respond", _wait=False, id=m["approvalId"], decision="deny")
            if m.get("event") == "screen.capture":
                self.call("screen.result", _wait=False, requestId=m["requestId"], data=picture, mime="image/png", width=W, height=H,
                          display=DISPLAY, pointer={"x": 700, "y": 400})
            if m.get("event") == "input.do":
                self.clicks.append(m)
                self.call("input.result", _wait=False, requestId=m["requestId"])
            if pred(m): return m
        return None
    def call(self, method, _wait=True, **params):
        self.n += 1; i = self.n
        self.p.stdin.write(json.dumps({"id": i, "method": method, "params": params}) + "\n"); self.p.stdin.flush()
        if not _wait: return None
        m = self.wait(lambda m: m.get("id") == i, 60)
        return m.get("result") if m else None
    def turn(self, text):
        tid = self.call("threads.create", agent=agent, cwd=work)["id"]
        self.clicks = []
        t0 = time.time()
        self.call("threads.send", id=tid, text=text, spoken=True)
        self.wait(lambda m: m.get("event") == "turn.ended" and m.get("threadId") == tid, 180)
        return list(self.clicks), time.time() - t0
    def close(self):
        self.p.stdin.close(); self.p.wait(timeout=15)

c = Core()
hits = 0
print(f"picture {W}x{H} of a {DISPLAY['width']}x{DISPLAY['height']} display; boxes in " + ("screen points (drawn at 2x, shrunk)" if DENSE else f"{BASE_W}x{BASE_H} page pixels"), flush=True)
for name, ask, (x1, y1, x2, y2) in TARGETS:
    clicks, dt = c.turn(ask)
    first = next((m for m in clicks if m.get("kind") == "click"), None)
    if not first:
        print(f"MISS {name:12} no click ({dt:.0f}s, {[m.get('kind') for m in clicks]})", flush=True)
        continue
    # Back to the page's pixels: screen points → this picture's pixels → the page's.
    px, py = (first["x"], first["y"]) if DENSE else (first["x"] / scale * BASE_W / W, first["y"] / scale * BASE_H / H)
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    hit = x1 <= px <= x2 and y1 <= py <= y2
    hits += hit
    print(f"{'HIT ' if hit else 'MISS'} {name:12} at ({px:.0f}, {py:.0f}), centre ({cx:.0f}, {cy:.0f}), off by ({px - cx:+.0f}, {py - cy:+.0f}), ratio ({px / cx:.3f}, {py / cy:.3f}) {dt:.0f}s", flush=True)
c.close()
print(f"{hits}/{len(TARGETS)} hit")
sys.exit(0 if hits == len(TARGETS) else 1)
