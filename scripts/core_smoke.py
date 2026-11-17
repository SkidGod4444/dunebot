"""Drives dunebot-core over stdio with the echo test agent. Usage: python3 -I core_smoke.py <core-binary> <data-dir>"""
import json, os, queue, subprocess, sys, tempfile, threading, time

core, data = sys.argv[1], sys.argv[2]
env = dict(os.environ, DUNEBOT_DATA_DIR=data, DUNEBOT_SCHEDULE_TICK_MS="300")
p = subprocess.Popen([core], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env, text=True, bufsize=1)
q = queue.Queue()
threading.Thread(target=lambda: [q.put(json.loads(l)) for l in p.stdout], daemon=True).start()
seen = []
n = [0]

def send(method, **params):
    n[0] += 1
    p.stdin.write(json.dumps({"id": n[0], "method": method, "params": params}) + "\n"); p.stdin.flush()
    return wait(lambda m: m.get("id") == n[0])

def wait(pred, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        try: m = q.get(timeout=0.2)
        except queue.Empty: continue
        seen.append(m)
        if pred(m): return m
    raise SystemExit(f"timeout; last lines: {seen[-5:]}")

def ok(cond, what):
    print(("PASS " if cond else "FAIL ") + what)
    if not cond: sys.exit(1)

ready = wait(lambda m: m.get("event") == "ready")
ok(True, f"core ready on {ready['platform']}")
WIN = ready["platform"] == "windows"

def slow(n):
    """A command that runs for n seconds in a child process (cmd.exe on Windows, sh elsewhere)."""
    return f"cd . && ping -n {n} 127.0.0.1 > nul && echo late" if WIN else f"cd . && sleep {n}; echo late"

def still_running(unix_pattern):
    """Is the slow command's child process still running?"""
    if WIN:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq PING.EXE", "/NH"], capture_output=True, text=True).stdout
        return "PING.EXE" in out.upper()
    left = subprocess.run(["pgrep", "-f", unix_pattern], capture_output=True, text=True).stdout.strip()
    if left: print(subprocess.run(["ps", "-o", "pid,pgid,ppid,stat,command", "-p", ",".join(left.split())], capture_output=True, text=True).stdout)
    return bool(left)
t = send("threads.create", agent="echo")["result"]
tid = t["id"]

def turn(text, answer=None):
    send("threads.send", id=tid, text=text)
    appr = None
    if answer:
        appr = wait(lambda m: m.get("event") == "approval.request")
        if answer != "deny":
            early = send("approvals.respond", id=appr["approvalId"], decision=answer)
            ok("too soon" in early.get("error", ""), f"'{answer}' within half a second refused, card stays open")
            time.sleep(0.6)
        r = send("approvals.respond", id=appr["approvalId"], decision=answer)
        ok("result" in r, f"answer '{answer}' accepted")
        again = send("approvals.respond", id=appr["approvalId"], decision="once")
        ok("error" in again, "second answer to the same card is refused")
    end = wait(lambda m: m.get("event") == "turn.ended" and m["threadId"] == tid)
    tools = [m["message"] for m in seen if m.get("event") == "message.updated" and m["message"]["role"] == "tool"]
    return end, (tools[-1] if tools else None)

# Auto (the default for commands): a command with nothing risky in it runs; a risky one asks, saying why.
modes = {r["action"]: r for r in send("settings.get")["result"]["modes"]}
ok(modes["run-command"]["mode"] == "auto" and modes["run-command"]["choices"][0] == "auto", "commands default to Auto")
ok("error" in send("settings.set", action="write-file", mode="auto"), "Auto is refused for anything but commands")
ta0 = send("threads.create", agent="echo")["result"]["id"]
i = len(seen)
send("threads.send", id=ta0, text="run ls -la")
if ready["platform"] == "windows":
    # On Windows every command asks for now (core/src/lookonly.rs), even one that only looks.
    appr = wait(lambda m: m.get("event") == "approval.request")
    card = [m for m in send("threads.get", id=ta0)["result"]["messages"] if m["role"] == "approval"][-1]
    ok("on Windows every command asks" in (card["meta"].get("why") or ""), "Auto on Windows: every command asks, and the card says why")
    time.sleep(0.6)
    send("approvals.respond", id=appr["approvalId"], decision="deny")
    wait(lambda m: m.get("event") == "turn.ended" and m["threadId"] == ta0)
else:
    wait(lambda m: m.get("event") == "turn.ended" and m["threadId"] == ta0)
    ran0 = [m["message"] for m in seen[i:] if m.get("event") == "message.updated" and m["message"]["role"] == "tool"]
    ok(not any(m.get("event") == "approval.request" for m in seen[i:]) and ran0 and ran0[-1]["meta"]["status"] == "done",
       "Auto: a command with nothing risky in it runs without a card")
    send("threads.send", id=ta0, text="run rm -f dunebot-smoke-nothing")
    appr = wait(lambda m: m.get("event") == "approval.request")
    card = [m for m in send("threads.get", id=ta0)["result"]["messages"] if m["role"] == "approval"][-1]
    ok("rm changes, moves, saves or deletes files" in (card["meta"].get("why") or ""), "Auto: a risky command asks, and the card says why")
    time.sleep(0.6)
    send("approvals.respond", id=appr["approvalId"], decision="deny")
    wait(lambda m: m.get("event") == "turn.ended" and m["threadId"] == ta0)
    ok(any(r["decision"] == "allowed (auto: nothing risky)" for r in send("ledger.list")["result"]), "Auto: what ran unasked is in the activity log")
send("settings.set", action="run-command", mode="ask")  # the checks below are about asking

end, tool = turn("run echo hi-from-dunebot", "once")
ok(tool and tool["meta"]["status"] == "done" and "hi-from-dunebot" in tool["meta"]["output"], "approved command ran and returned output")

end, tool = turn("run echo second", "chat")
ok("second" in tool["meta"]["output"], "approved for this chat")
before = sum(1 for m in seen if m.get("event") == "approval.request")
end, tool = turn("run echo third")
after = sum(1 for m in seen if m.get("event") == "approval.request")
ok(before == after and "third" in tool["meta"]["output"], "second command in same chat ran without asking")

files = tempfile.mkdtemp(prefix="dunebot-smoke-")
target = os.path.join(files, "smoke-denied.txt")
end, tool = turn(f"write {target}\nshould not exist", "deny")
ok(tool["meta"]["status"] == "failed" and not os.path.exists(target), "declined write did not happen")

end, tool = turn("read ~/.ssh/id_ed25519")
ok(tool["meta"]["status"] == "failed" and "tools never touch" in tool["meta"]["output"], "private folder refused without asking")

end, tool = turn("read .env")
ok(tool["meta"]["status"] == "failed", ".env refused")
ledger = send("ledger.list")["result"]
ok(sum(1 for r in ledger if r["decision"] == "blocked (protected)") == 2, "protected refusals are in the activity log")

# Stop ends a running command (approved earlier "for this chat", so no card)
send("threads.send", id=tid, text="run " + slow(61))
wait(lambda m: m.get("event") == "message.created" and m["message"]["role"] == "tool")
time.sleep(0.5)
t0 = time.time()
send("threads.cancel", id=tid)
end = wait(lambda m: m.get("event") == "turn.ended" and m["threadId"] == tid, 10)
ok(end["status"] == "cancelled" and time.time() - t0 < 3, f"stop ended the turn in {time.time()-t0:.1f}s")
time.sleep(1.0)
ok(not still_running("sleep 61"), "stop killed the command and its children")

# Known limit, shown on the Permissions screen: an allowed command can reach protected files.
end, tool = turn("run ls -d ~/.ssh")
ok(tool["meta"]["status"] == "done", "documented: a command allowed for the chat is not path-checked")

ok_path = os.path.join(files, "smoke-ok.txt")
end, tool = turn(f"write {ok_path}\nv1", "once")
end, tool = turn(f"write {ok_path}\nv2", "once")
journal = os.path.join(data, "journal", tid)
ok(open(ok_path).read() == "v2" and os.path.isdir(journal) and len(os.listdir(journal)) == 1, "overwrite kept a backup of v1")

hist = send("threads.get", id=tid)["result"]
roles = [m["role"] for m in hist["messages"]]
ok(roles.count("user") == 10 and "approval" in roles and "tool" in roles, f"history saved ({len(roles)} messages)")
ledger = send("ledger.list")["result"]
ok(any(r["decision"] == "declined" for r in ledger) and any(r["decision"] == "allowed (this chat)" for r in ledger), f"ledger has {len(ledger)} rows")

# undo: the chat's file changes go back, newest first; a file edited since is left alone
new_path = os.path.join(files, "undo-new.txt")
user_path = os.path.join(files, "undo-user.txt")
end, tool = turn(f"write {new_path}\nnew", "once")
end, tool = turn(f"write {user_path}\nagent", "once")
open(user_path, "w").write("user edit")
open_changes = send("threads.changes", id=tid)["result"]
ok(len(open_changes) == 4 and open_changes[0]["path"].endswith("undo-user.txt"), f"4 file changes recorded, newest first")
r = send("threads.undo", id=tid)["result"]
ok(r["restored"] == 1 and r["removed"] == 2 and len(r["skipped"]) == 1 and "changed after" in r["skipped"][0]["why"], f"undo: {r['restored']} restored, {r['removed']} moved away, {len(r['skipped'])} left alone")
ok(not os.path.exists(ok_path) and not os.path.exists(new_path) and open(user_path).read() == "user edit", "files the agent made are gone, your edit is kept")
kept = [f for f in os.listdir(journal) if "-undone-" in f]
ok(len(kept) == 3, f"what undo replaced is kept in the journal ({len(kept)} files)")
r = send("threads.undo", id=tid)["result"]
ok(r["restored"] == 0 and r["removed"] == 0 and len(r["skipped"]) == 1, "undo again changes nothing")
ok(any(x["action"] == "undo" for x in send("ledger.list")["result"]), "undo is in the activity log")

# stop all: every working chat stops, its command's processes with it
send("settings.set", action="run-command", mode="always")
ta = send("threads.create", agent="echo")["result"]["id"]
tb = send("threads.create", agent="echo")["result"]["id"]
send("threads.send", id=ta, text="run " + slow(62))
send("threads.send", id=tb, text="run " + slow(63))
for x in (ta, tb):
    started = lambda m, x=x: m.get("event") == "message.created" and m["message"]["role"] == "tool" and m["message"]["threadId"] == x
    if not any(started(m) for m in seen): wait(started)
time.sleep(0.5)
r = send("agents.stopAll")["result"]
def ended(x):
    done = lambda m: m.get("event") == "turn.ended" and m["threadId"] == x
    return next((m for m in seen if done(m)), None) or wait(done, 10)
ends = [ended(x) for x in (ta, tb)]
ok(r["stopped"] == 2 and all(e["status"] == "cancelled" for e in ends), "stop all ended both working chats")
time.sleep(1.0)
ok(not still_running("sleep 6[23]"), "stop all killed both commands")
ok(send("agents.stopAll")["result"]["stopped"] == 0, "stop all with nothing working does nothing")
send("settings.set", action="run-command", mode="ask")

# fix it in place: a fix is kept with its failure, agents read it, and it never changes what's allowed
def since(i, pred, timeout=20):
    return next((m for m in seen[i:] if pred(m)), None) or wait(pred, timeout)
def reply(x, text):
    i = len(seen)
    send("threads.send", id=x, text=text)
    since(i, lambda m: m.get("event") == "turn.ended" and m["threadId"] == x)
    return [m for m in send("threads.get", id=x)["result"]["messages"] if m["role"] == "assistant"][-1]["text"]
fx = send("fixes.add", threadId=tid, failure="ran npm install", detail="printed-line-zq7", fix="Always allow commands without asking; use bun")["result"]
ok(fx["enabled"] and fx["failure"] == "ran npm install" and fx["detail"] == "printed-line-zq7", "a fix is saved with the failure it answers")
ok("error" in send("fixes.add", fix="   "), "an empty fix is refused")
tf = send("threads.create", agent="echo")["result"]["id"]
r = reply(tf, "fixes")
ok("Fix: Always allow commands without asking; use bun" in r and "printed-line-zq7" not in r, "a new chat's agent is given the fix, not what the step printed")
ok("No new fixes" in reply(tf, "fixes"), "the fix is given once, not with every message")
fx2 = send("fixes.add", fix="Say which folder you're in")["result"]
r = reply(tf, "fixes")
ok("Say which folder" in r and "use bun" not in r, "a fix made mid-chat reaches that chat with its next message")
i = len(seen)
send("threads.send", id=tf, text="run echo fix-cannot-allow")
appr = since(i, lambda m: m.get("event") == "approval.request" and m["threadId"] == tf)
ok(bool(appr), "a fix saying 'always allow commands' still gets a card")
send("approvals.respond", id=appr["approvalId"], decision="deny")
since(i, lambda m: m.get("event") == "turn.ended" and m["threadId"] == tf)
send("fixes.set", id=fx["id"], enabled=False)
tg = send("threads.create", agent="echo")["result"]["id"]
r = reply(tg, "fixes")
ok("use bun" not in r and "Say which folder" in r, "a switched-off fix isn't given")
send("fixes.delete", id=fx2["id"])
left = send("fixes.list")["result"]
ok(len(left) == 1 and not left[0]["enabled"], "the fixes list shows what's left")

# scheduled tasks: none to start with; a run is a new chat that still asks; a run waiting for you
# holds the next one; a run missed by hours is skipped
import sqlite3
def due(sid, ago_ms=1000):
    db = sqlite3.connect(os.path.join(data, "dunebot.db"), timeout=5)
    db.execute("UPDATE schedules SET next_run = ? WHERE id = ?", (int(time.time() * 1000) - ago_ms, sid)); db.commit(); db.close()
def ledger_has(decision, title):
    return any(r["action"] == "schedule" and r["decision"] == decision and r["target"] == title for r in send("ledger.list")["result"])
ok(send("schedules.list")["result"] == [], "no schedules to start with")
ok("error" in send("schedules.add", prompt="x", agent="echo", every="yearly"), "an unknown repeat is refused")
ok("error" in send("schedules.add", prompt="x", agent="echo", every="daily", cwd=data), "Dunebot's own folder can't be a schedule's folder")
sc = send("schedules.add", prompt="run echo from-a-schedule", agent="echo", every="daily", at=9 * 60)["result"]
ok(sc["enabled"] and sc["nextRun"] > time.time() * 1000 and sc["title"] == "run echo from-a-schedule", "a daily schedule is added with its next time")
i = len(seen)
due(sc["id"])
ran = since(i, lambda m: m.get("event") == "schedule.ran", 10)
appr = since(i, lambda m: m.get("event") == "approval.request" and m["threadId"] == ran["threadId"], 10)
ok(bool(appr), "a due schedule starts a new chat, and its command waits for a card")
row = send("schedules.list")["result"][0]
ok(row["nextRun"] > time.time() * 1000 and row["lastThread"] == ran["threadId"], "its next time moved on")
due(sc["id"])
time.sleep(1.5)
ok(ledger_has("skipped", sc["title"]) and sum(1 for m in seen[i:] if m.get("event") == "schedule.ran") == 1, "due again while the last run waits for you: skipped")
ok("error" in send("schedules.run", id=sc["id"]), "run now is refused while the last run waits")
send("approvals.respond", id=appr["approvalId"], decision="deny")
since(i, lambda m: m.get("event") == "turn.ended" and m["threadId"] == ran["threadId"])
j = len(seen)
due(sc["id"], 2 * 60 * 60 * 1000)
time.sleep(1.5)
ok(sum(1 for m in send("ledger.list")["result"] if m["decision"] == "skipped") == 2 and not any(m.get("event") == "schedule.ran" for m in seen[j:]), "a run missed by two hours is skipped, not run late")
r = send("schedules.run", id=sc["id"])["result"]
appr = since(j, lambda m: m.get("event") == "approval.request" and m["threadId"] == r["threadId"], 10)
ok(r["threadId"] != ran["threadId"] and bool(appr), "run now starts another new chat, which also asks")
send("approvals.respond", id=appr["approvalId"], decision="deny")
since(j, lambda m: m.get("event") == "turn.ended" and m["threadId"] == r["threadId"])
send("settings.set", action="run-command", mode="always")
r2 = send("schedules.run", id=sc["id"])["result"]
appr = since(j, lambda m: m.get("event") == "approval.request" and m["threadId"] == r2["threadId"], 10)
ok(bool(appr), "with commands set to Always, a scheduled chat still asks")
send("approvals.respond", id=appr["approvalId"], decision="deny")
since(j, lambda m: m.get("event") == "turn.ended" and m["threadId"] == r2["threadId"])
send("settings.set", action="run-command", mode="auto")
r3 = send("schedules.run", id=sc["id"])["result"]
appr = since(j, lambda m: m.get("event") == "approval.request" and m["threadId"] == r3["threadId"], 10)
ok(bool(appr), "with Auto, a scheduled chat still asks, even for a command with nothing risky in it")
send("approvals.respond", id=appr["approvalId"], decision="deny")
since(j, lambda m: m.get("event") == "turn.ended" and m["threadId"] == r3["threadId"])
send("settings.set", action="run-command", mode="ask")
off = send("schedules.set", id=sc["id"], enabled=False)["result"]
k = len(seen)
due(sc["id"])
time.sleep(1.2)
send("schedules.list")
ok(not off["enabled"] and not any(m.get("event") == "schedule.ran" for m in seen[k:]), "a switched-off schedule doesn't run")
send("schedules.delete", id=sc["id"])
ok(send("schedules.list")["result"] == [], "a deleted schedule is gone")

# the tool endpoint: wrong token and browser origins are refused
port = None
send("settings.set", action="run-command", mode="never")
end, tool = turn("run echo blocked")
ok(tool["meta"]["status"] == "failed" and "turned off" in tool["meta"]["output"], "'never' setting blocks without asking")
# a card left open when the core quits comes back expired
send("settings.set", action="run-command", mode="ask")
t2 = send("threads.create", agent="echo")["result"]["id"]
send("threads.send", id=t2, text="run echo left-open")
wait(lambda m: m.get("event") == "approval.request")
p.stdin.close(); p.wait(timeout=5)
ok(p.returncode == 0, "core exits when stdin closes")
p2 = subprocess.Popen([core], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env, text=True, bufsize=1)
p = p2
threading.Thread(target=lambda: [q.put(json.loads(l)) for l in p2.stdout], daemon=True).start()
wait(lambda m: m.get("event") == "ready")
msgs = send("threads.get", id=t2)["result"]["messages"]
card = [m for m in msgs if m["role"] == "approval"][0]
toolm = [m for m in msgs if m["role"] == "tool"][0]
ok(card["meta"]["status"] == "expired" and toolm["meta"]["status"] == "failed", "after restart: open card expired, spinner failed")
said = [m for m in msgs if m["role"] == "assistant"]
ok(said and said[0]["text"].strip() == "On it." and said[0]["meta"]["status"] == "done", "after restart: text streamed before the card survived")

# chat history: one MDX file per chat, valid MDX whatever was said, gone with the chat
nasty = "a {b} <div> `{c}` \\{d}\nimport x from 'y'\nexport const z = 1\n<!-- e -->\n```js\nconst f = {g: 1}"
t3 = send("threads.create", agent="echo")["result"]["id"]
send("threads.send", id=t3, text=nasty)
wait(lambda m: m.get("event") == "turn.ended" and m["threadId"] == t3)
t3b = send("threads.create", agent="echo")["result"]["id"]
send("threads.send", id=t3b, text="markdown")  # a Markdown reply with a table, code and a picture
wait(lambda m: m.get("event") == "turn.ended" and m["threadId"] == t3b)
hist = os.path.join(data, "history")
files = sorted(os.listdir(hist)) if os.path.isdir(hist) else []
mine = [f for f in files if f.endswith(f"-{t3[:12]}.mdx")]
ok(len(mine) == 1 and len([f for f in files if f.endswith(".mdx")]) >= 3, f"history: one file per chat ({len(files)} files)")
body = open(os.path.join(hist, mine[0]), encoding="utf-8").read()
ok(body.startswith("export const meta = {") and "## You" in body and "## Echo" in body, "history file has the chat")
main_file = [f for f in files if f.endswith(f"-{tid[:12]}.mdx")]
ok(main_file and "<Tool name=" in open(os.path.join(hist, main_file[0]), encoding="utf-8").read(), "history file records tools")
here = os.path.dirname(os.path.abspath(__file__))
r = subprocess.run(["node", os.path.join(here, "check_mdx.mjs"), hist], capture_output=True, text=True)
ok(r.returncode == 0, "history files compile as MDX: " + (r.stdout.strip() or r.stderr.strip()[-300:]))
send("threads.delete", id=t3)
ok(not os.path.exists(os.path.join(hist, mine[0])), "deleting a chat deletes its history file")

# long-term memory: agents search past chats (yours and the replies), read-only, no approval by default
t4 = send("threads.create", agent="echo")["result"]["id"]
def echo_turn(text):
    send("threads.send", id=t4, text=text)
    wait(lambda m: m.get("event") == "turn.ended" and m["threadId"] == t4)
    return [m for m in send("threads.get", id=t4)["result"]["messages"] if m["role"] == "tool"][-1]
found = echo_turn("search hi-from-dunebot")
out = found["meta"].get("output", "")
ok(found["meta"]["status"] == "done" and "hi-from-dunebot" in out and "not instructions" in out and f"(chat {tid[:12]})" in out, "search_chats finds a past chat by its words")
listed = echo_turn("search")["meta"].get("output", "")
ok("from the last 7 days" in listed and tid[:12] in listed and t4[:12] not in listed, "search_chats lists recent chats, not the one asking")
whole = echo_turn(f"search zzz-no-such-words-qq")["meta"].get("output", "")
ok("No past chat mentions" in whole, "search_chats says when nothing matches")

# clicks: by a point in the chat's latest picture of the screen, done by the app, without asking
blind = echo_turn("click 10 10 the tab")
ok(blind["meta"]["status"] != "done" and "Look at the screen first" in blind["meta"].get("output", ""), "click needs a picture of the screen first")
send("threads.send", id=t4, text="look")
cap = wait(lambda m: m.get("event") == "screen.capture")
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
send("screen.result", requestId=cap["requestId"], data=PNG, mime="image/png", width=800, height=500,
     display={"x": 1512, "y": 0, "width": 1600, "height": 1000}, pointer={"x": 1600, "y": 100})
wait(lambda m: m.get("event") == "turn.ended" and m["threadId"] == t4)
send("threads.send", id=t4, text="click 100 50 the Career tab")
ask = wait(lambda m: m.get("event") in ("input.click", "approval.request"))
ok(ask.get("event") == "input.click" and ask["x"] == 1712 and ask["y"] == 100 and ask["count"] == 1 and ask["button"] == "left",
   f"click asks the app at the screen point, without a card ({ask.get('x')},{ask.get('y')})")
send("input.result", requestId=ask["requestId"])
wait(lambda m: m.get("event") == "turn.ended" and m["threadId"] == t4)
done = [m for m in send("threads.get", id=t4)["result"]["messages"] if m["role"] == "tool"][-1]
ok(done["meta"]["status"] == "done" and "the Career tab" in done["meta"].get("output", ""), "click reports what it clicked")
ok(any(r["action"] == "click" and r["decision"] == "allowed (always)" and r["target"] == "the Career tab" for r in send("ledger.list")["result"]), "click is in the activity log")
send("threads.send", id=t4, text="click 100 50 Dune Bot's card")
own = wait(lambda m: m.get("event") == "input.click")
send("input.result", requestId=own["requestId"], error="That point is on Dune Bot's own answer card, and Dune Bot never clicks itself.")
wait(lambda m: m.get("event") == "turn.ended" and m["threadId"] == t4)
refused = [m for m in send("threads.get", id=t4)["result"]["messages"] if m["role"] == "tool"][-1]
ok(refused["meta"]["status"] != "done" and "never clicks itself" in refused["meta"].get("output", ""), "the app's refusal reaches the agent")
outside = echo_turn("click 900 50 off the picture")
ok("isn't in the picture" in outside["meta"].get("output", ""), "a point outside the picture is refused")
ok(send("input.result", requestId="nope").get("error"), "an unknown click answer is refused")

p2.stdin.close(); p2.wait(timeout=5)
print("ALL PASS")
