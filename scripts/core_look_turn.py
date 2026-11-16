"""Real agent turns asking about a folder, the way the bar asks (spoken): the agent must answer with
Dunebot's folder tool, which never asks, not with a command (which asks). Any card that would ask
the user is declined and counts as a failure. Uses a made-up folder, never the user's own files.
Usage: python3 -I core_look_turn.py <core> <data-dir> [agent] [runs]   (DUNEBOT_CODEMAX: a codemax with `serve`)"""
import json, os, queue, shutil, subprocess, sys, tempfile, threading, time
core, data = sys.argv[1], sys.argv[2]
agent = sys.argv[3] if len(sys.argv) > 3 else "claude"
runs = int(sys.argv[4]) if len(sys.argv) > 4 else 3
results = []

# 37 files at the top, 83 more in three subfolders (120 in all), plus a hidden folder it must not count.
home = tempfile.mkdtemp(prefix="dunebot-look-")
inbox = os.path.join(home, "Inbox")
for sub, n in [("", 37), ("scans", 20), ("photos", 30), ("photos/2025", 33)]:
    os.makedirs(os.path.join(inbox, sub), exist_ok=True)
    for i in range(n):
        open(os.path.join(inbox, sub, f"file{i:02}.txt"), "w").write("x" * (i + 1))
os.makedirs(os.path.join(inbox, ".cache"))
open(os.path.join(inbox, ".cache", "skip.txt"), "w").write("x")

class Core:
    def __init__(self):
        self.p = subprocess.Popen([core], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(os.path.join(data, "core-stderr.log"), "a"),
                                  env=dict(os.environ, DUNEBOT_DATA_DIR=data, DUNEBOT_APPROVAL_MIN_MS="0"), text=True, bufsize=1)
        self.q = queue.Queue(); self.n = 0; self.asked = []
        threading.Thread(target=lambda: [self.q.put(json.loads(l)) for l in self.p.stdout], daemon=True).start()
        self.wait(lambda m: m.get("event") == "ready", 10)
    def wait(self, pred, timeout):
        end = time.time() + timeout
        while time.time() < end:
            try: m = self.q.get(timeout=0.5)
            except queue.Empty: continue
            if m.get("event") == "approval.request":
                self.asked.append(m.get("label") or m.get("action"))
                self.call("approvals.respond", _wait=False, id=m["approvalId"], decision="deny")
            if pred(m): return m
        return None
    def call(self, method, _wait=True, **params):
        self.n += 1; i = self.n
        self.p.stdin.write(json.dumps({"id": i, "method": method, "params": params}) + "\n"); self.p.stdin.flush()
        if not _wait: return None
        m = self.wait(lambda m: m.get("id") == i, 60)
        return m.get("result") if m else None
    def turn(self, text):
        tid = self.call("threads.create", agent=agent, cwd=home)["id"]
        self.asked = []
        t0 = time.time()
        self.call("threads.send", id=tid, text=text, spoken=True)
        end = self.wait(lambda m: m.get("event") == "turn.ended" and m.get("threadId") == tid, 240)
        msgs = self.call("threads.get", id=tid)["messages"]
        return end, msgs, time.time() - t0
    def close(self):
        self.p.stdin.close(); self.p.wait(timeout=15)

def check(name, cond, extra=""):
    results.append(cond); print(f"{agent:8} {'PASS' if cond else 'FAIL'} {name} {extra}", flush=True)

c = Core()
for run in range(1, runs + 1):
    for q, want in [("How many files are in the Inbox folder?", ["37", "120"]),
                    ("How many files are in the Inbox folder, including its subfolders?", ["120"])]:
        end, msgs, dt = c.turn(q)
        tools = [m["meta"].get("tool") or m["text"] for m in msgs if m["role"] == "tool"]
        deep = [bool((m["meta"].get("args") or {}).get("deep")) for m in msgs if m["role"] == "tool"]
        reply = " ".join(m["text"] for m in msgs if m["role"] == "assistant").replace("\n", " ")
        ok = bool(tools) and set(tools) == {"list_folder"} and not c.asked and any(w in reply.replace(",", "") for w in want)
        check(f"run {run}: {q!r}", ok, f"{dt:.0f}s tools={tools} deep={deep} asked={c.asked} status={end and end.get('status')} reply={reply[:150]!r}")
c.close()
shutil.rmtree(home, ignore_errors=True)
print("ALL PASS" if all(results) else f"{results.count(False)} FAILED")
sys.exit(0 if all(results) else 1)
