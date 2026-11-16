"""Real agent turns through codemax: a tool call, a follow-up, then a core restart that must resume the session.
Usage: python3 -I core_real_turn.py <core> <data-dir> [agent] [cwd]   (set DUNEBOT_CODEMAX to a codemax with `serve`)
cwd: the chat's folder (e.g. "~", as the bar uses); default is the chat's own folder.
With DUNEBOT_IDLE_CLOSE_SECS set, also checks that an idle chat's agent processes are closed and the chat resumes."""
import json, os, queue, subprocess, sys, threading, time
core, data = sys.argv[1], sys.argv[2]
agent = sys.argv[3] if len(sys.argv) > 3 else "claude"
cwd = sys.argv[4] if len(sys.argv) > 4 else None
idle = int(os.environ.get("DUNEBOT_IDLE_CLOSE_SECS", "0"))
results = []

class Core:
    def __init__(self):
        self.p = subprocess.Popen([core], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(os.path.join(data, "core-stderr.log"), "a"),
                                  env=dict(os.environ, DUNEBOT_DATA_DIR=data, DUNEBOT_APPROVAL_MIN_MS="0"), text=True, bufsize=1)
        self.q = queue.Queue(); self.n = 0
        threading.Thread(target=lambda: [self.q.put(json.loads(l)) for l in self.p.stdout], daemon=True).start()
        self.wait(lambda m: m.get("event") == "ready", 10)
    def wait(self, pred, timeout):
        end = time.time() + timeout
        while time.time() < end:
            try: m = self.q.get(timeout=0.5)
            except queue.Empty: continue
            if m.get("event") == "approval.request":
                self.call("approvals.respond", _wait=False, id=m["approvalId"], decision="once")
            if pred(m): return m
        return None
    def call(self, method, _wait=True, **params):
        self.n += 1; i = self.n
        self.p.stdin.write(json.dumps({"id": i, "method": method, "params": params}) + "\n"); self.p.stdin.flush()
        if not _wait: return None
        m = self.wait(lambda m: m.get("id") == i, 60)
        return m.get("result") if m else None
    def turn(self, tid, text):
        t0 = time.time()
        self.call("threads.send", id=tid, text=text)
        end = self.wait(lambda m: m.get("event") == "turn.ended" and m.get("threadId") == tid, 240)
        msgs = self.call("threads.get", id=tid)["messages"]
        return end, msgs, time.time() - t0
    def close(self):
        self.p.stdin.close(); self.p.wait(timeout=15)

def check(name, cond, extra=""):
    results.append(cond); print(f"{agent:12} {'PASS' if cond else 'FAIL'} {name} {extra}", flush=True)

def last_reply(msgs):
    a = [m for m in msgs if m["role"] == "assistant"]
    return a[-1]["text"].strip().replace("\n", " ")[:160] if a else ""

c = Core()
tid = c.call("threads.create", agent=agent, **({"cwd": cwd} if cwd else {}))["id"]
end, msgs, dt = c.turn(tid, "Use the dunebot run_command tool to run `echo dunebot-ok && uname -s`, then tell me its output in one line.")
tools = [m for m in msgs if m["role"] == "tool"]
check("tool call", bool(tools) and tools[-1]["meta"]["status"] == "done" and "dunebot-ok" in tools[-1]["meta"].get("output", ""),
      f"{dt:.0f}s status={end and end.get('status')} err={end and end.get('error')} reply={last_reply(msgs)!r}")
end, msgs, dt = c.turn(tid, "Without using any tool: what was the first word that command printed? Reply with just that word.")
check("follow-up", "dunebot-ok" in last_reply(msgs).lower(), f"{dt:.0f}s reply={last_reply(msgs)!r}")
c.close()
c = Core()
end, msgs, dt = c.turn(tid, "Without using any tool: what exact command did you run earlier in this chat? One line.")
check("resumed after restart", "echo" in last_reply(msgs).lower(), f"{dt:.0f}s status={end and end.get('status')} reply={last_reply(msgs)!r}")
# Stop during a long command, then the chat must still work
c.call("threads.send", id=tid, text="Use the dunebot run_command tool to run `sleep 58`.")
started = c.wait(lambda m: m.get("event") == "message.created" and m["message"]["role"] == "tool", 120)
time.sleep(1.5)
t0 = time.time()
c.call("threads.cancel", id=tid)
end = c.wait(lambda m: m.get("event") == "turn.ended" and m.get("threadId") == tid, 30)
left = subprocess.run(["pgrep", "-f", "sleep 58"], capture_output=True, text=True).stdout.strip()
check("stop", bool(started) and bool(end) and time.time() - t0 < 20 and not left, f"{time.time()-t0:.1f}s status={end and end.get('status')} leftover={left!r}")
end, msgs, dt = c.turn(tid, "Reply with just the word: ok")
check("works after stop", "ok" in last_reply(msgs).lower(), f"{dt:.0f}s reply={last_reply(msgs)!r}")
if idle:
    kids = lambda: subprocess.run(["pgrep", "-P", str(c.p.pid)], capture_output=True, text=True).stdout.split()
    before = kids()
    time.sleep(idle + min(idle, 60) + 5)
    after = kids()
    group = [x for pid in before for x in subprocess.run(["pgrep", "-g", pid], capture_output=True, text=True).stdout.split()]
    check("idle close", bool(before) and not after and not group, f"agent pids before={before} after={after} group left={group}")
    end, msgs, dt = c.turn(tid, "Without using any tool: what exact command did you run first in this chat? One line.")
    check("resumed after idle close", "echo" in last_reply(msgs).lower(), f"{dt:.0f}s reply={last_reply(msgs)!r}")
c.close()
sys.exit(0 if all(results) else 1)
