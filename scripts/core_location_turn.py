"""Turns that need the user's location. This script plays the app: when the core asks where the
computer is (`location.request`), it answers with a stand-in place, never the real one.
 - The test agent (`where`): each answer the app can give becomes the right sentence; nothing asks;
   the activity log gets a row with no place in it; the core's log holds no place.
 - A real agent (optional, [agent]): "what's the weather where I am?" must say what it's doing first
   (a short line before its first step), use find_location, then
   fetch the weather for those coordinates without a card, and never guess from the internet address.
Usage: python3 -I core_location_turn.py <core> <data-dir> [agent]   (DUNEBOT_CODEMAX: a codemax with `serve`)"""
import json, os, queue, sqlite3, subprocess, sys, tempfile, threading, time
sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows: "→" in the sentences
core, data = sys.argv[1], sys.argv[2]
agent = sys.argv[3] if len(sys.argv) > 3 else None
results = []
# A stand-in place: a public square, not the user's.
PLACE = {"status": "located", "latitude": 28.63151, "longitude": 77.21672, "accuracy": 35.0, "area": "Connaught Place, New Delhi, 110001, India"}

class Core:
    def __init__(self):
        self.p = subprocess.Popen([core], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(os.path.join(data, "core-stderr.log"), "a"),
                                  env=dict(os.environ, DUNEBOT_DATA_DIR=data, DUNEBOT_APPROVAL_MIN_MS="0"), text=True, encoding="utf-8", bufsize=1)
        self.q = queue.Queue(); self.n = 0; self.asked = []; self.requests = 0; self.answer = PLACE
        threading.Thread(target=lambda: [self.q.put(json.loads(l)) for l in self.p.stdout], daemon=True).start()
        self.wait(lambda m: m.get("event") == "ready", 10)
    def wait(self, pred, timeout):
        end = time.time() + timeout
        while time.time() < end:
            try: m = self.q.get(timeout=0.5)
            except queue.Empty: continue
            if m.get("event") == "approval.request":
                self.asked.append(m.get("label"))
                self.call("approvals.respond", _wait=False, id=m["approvalId"], decision="deny")
            if m.get("event") == "location.request":
                self.requests += 1
                self.call("location.result", _wait=False, requestId=m["requestId"], **self.answer)
            if pred(m): return m
        return None
    def call(self, method, _wait=True, **params):
        self.n += 1; i = self.n
        self.p.stdin.write(json.dumps({"id": i, "method": method, "params": params}) + "\n"); self.p.stdin.flush()
        if not _wait: return None
        m = self.wait(lambda m: m.get("id") == i, 60)
        return m and (m.get("result") if "result" in m else {"error": m.get("error")})
    def turn(self, who, text):
        tid = self.call("threads.create", agent=who, cwd=tempfile.gettempdir())["id"]
        self.asked = []; self.requests = 0
        t0 = time.time()
        self.call("threads.send", id=tid, text=text)
        self.wait(lambda m: m.get("event") == "turn.ended" and m.get("threadId") == tid, 240)
        msgs = self.call("threads.get", id=tid)["messages"]
        return msgs, time.time() - t0
    def close(self):
        self.p.stdin.close(); self.p.wait(timeout=15)

def check(name, cond, extra=""):
    results.append(cond); print(f"{'PASS' if cond else 'FAIL'} {name} {extra}", flush=True)

c = Core()
cases = [
    (PLACE, "done", ["latitude 28.63151, longitude 77.21672", "about 35 m", "Connaught Place", "wttr.in/28.6315,77.2167"]),
    (dict(PLACE, accuracy=9000.0, area=""), "done", ["9.0 km", "Wi-Fi"]),
    ({"status": "asking"}, "failed", ["Allow"]),
    ({"status": "denied"}, "failed", ["Privacy & Security", "Ask the user where they are"]),
    ({"status": "off"}, "failed", ["Location Services are turned off"]),
    ({"status": "nofix"}, "failed", ["Wi-Fi"]),
    ({"status": "unsupported"}, "failed", ["isn't available"]),
    ({"status": "located", "latitude": 123.0, "longitude": 5.0, "accuracy": 3.0}, "failed", ["couldn't find"]),
]
for answer, status, needles in cases:
    c.answer = answer
    msgs, dt = c.turn("echo", "where")
    card = next((m for m in msgs if m["role"] == "tool"), None)
    out = card and card["meta"].get("output") or ""
    ok = card and card["meta"].get("tool") == "find_location" and card["meta"].get("status") == status and all(n in out for n in needles) and not c.asked and c.requests == 1
    check(f"echo, app answers {answer.get('status')}{' (rough)' if answer.get('accuracy', 0) > 1000 else ''}", bool(ok), f"status={card and card['meta'].get('status')} asked={c.asked} requests={c.requests} out={out[:150]!r}")

if agent:
    c.answer = PLACE
    msgs, dt = c.turn(agent, "What's the weather where I am right now? One sentence.")
    tools = [(m["meta"].get("tool"), json.dumps(m["meta"].get("args"))) for m in msgs if m["role"] == "tool"]
    reply = " ".join(m["text"] for m in msgs if m["role"] == "assistant").replace("\n", " ")
    names = [t for t, _ in tools]
    used_coords = any("28.63" in a and "77.21" in a for t, a in tools if t == "run_command")
    ip_guess = any(t == "run_command" and ("ipinfo" in a or "ip-api" in a or "wttr.in/?" in a or "wttr.in?" in a) for t, a in tools)
    check(f"{agent}: weather where I am", "find_location" in names and not c.asked and not ip_guess and (used_coords or "Connaught" in reply or "Delhi" in reply),
          f"{dt:.0f}s tools={tools} asked={c.asked} reply={reply[:200]!r}")
    # It says what it's doing before its first step: that line is read aloud while the work goes on.
    roles = [m["role"] for m in msgs if m["role"] in ("assistant", "tool")]
    first = next((m["text"].strip() for m in msgs if m["role"] == "assistant"), "")
    check(f"{agent}: a short first line before the first step", bool(roles) and roles[0] == "assistant" and "tool" in roles and 0 < len(first) <= 120,
          f"order={roles} first={first[:120]!r}")
c.close()

db = os.path.join(data, "dunebot.db")
rows = sqlite3.connect(db).execute("select target, decision, detail from ledger where action = 'find-location'").fetchall()
check("each look-up in the activity log, no place in it", len(rows) >= len(cases) and not any("28.63" in "".join(map(str, r)) or "Connaught" in "".join(map(str, r)) for r in rows), f"rows={rows[:2]}")
log = open(os.path.join(data, "core-stderr.log"), encoding="utf-8", errors="replace").read()
check("no place in the core's log", "28.63" not in log and "Connaught" not in log)
print("ALL PASS" if all(results) else f"{results.count(False)} FAILED")
sys.exit(0 if all(results) else 1)
