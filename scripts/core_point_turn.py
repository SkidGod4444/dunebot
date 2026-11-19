"""Teaching through the core, over stdio, with the echo test agent and this script as the app: point_at
and clear_pointer (core/src/tools/teach.rs). The app is asked to draw at screen points worked out from
the chat's latest picture, the same way a click is; pointing never asks, never uses up the picture,
and goes by itself after its time (DUNEBOT_POINTER_MS shortens it here).

Usage: python3 -I scripts/core_point_turn.py core/target/debug/dunebot-core "$(mktemp -d)"
"""
import json, os, queue, subprocess, sys, threading, time

core, data = sys.argv[1], sys.argv[2]
env = dict(os.environ, DUNEBOT_DATA_DIR=data, DUNEBOT_POINTER_MS="2500")
p = subprocess.Popen([core], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env, text=True, encoding="utf-8", bufsize=1)
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
        try: m = q.get(timeout=0.1)
        except queue.Empty: continue
        seen.append(m)
        if pred(m): return m
    return None

def ok(cond, what):
    print(("PASS " if cond else "FAIL ") + what)
    if not cond:
        p.kill()
        sys.exit(1)

ok(wait(lambda m: m.get("event") == "ready") is not None, "core ready")
tid = send("threads.create", agent="echo")["result"]["id"]

def last_tool():
    return [m for m in send("threads.get", id=tid)["result"]["messages"] if m["role"] == "tool"][-1]

def ended():
    return wait(lambda m: m.get("event") == "turn.ended" and m["threadId"] == tid)

def plain(text):
    """A turn the app isn't asked anything in."""
    send("threads.send", id=tid, text=text)
    ok(ended() is not None, f"'{text}' ends")
    return last_tool()

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
def look():
    # An 800x500 picture of a 1600x1000 display at (1512, 0): one pixel is 2 points.
    send("threads.send", id=tid, text="look")
    cap = wait(lambda m: m.get("event") == "screen.capture")
    send("screen.result", requestId=cap["requestId"], data=PNG, mime="image/png", width=800, height=500,
         display={"x": 1512, "y": 0, "width": 1600, "height": 1000}, pointer={"x": 1600, "y": 100})
    ended()

def asked(text, error=None):
    """A turn that asks the app something: answers it (or refuses with `error`)."""
    send("threads.send", id=tid, text=text)
    req = wait(lambda m: m.get("event") in ("input.do", "approval.request"))
    if req and req.get("event") == "input.do":
        send("input.result", requestId=req["requestId"], **({"error": error} if error else {}))
    ended()
    return req, last_tool()

# Before any picture: look first.
blind = plain("point 100 50 60 20 the Share button")
ok(blind["meta"]["status"] == "failed" and "Look at the screen first" in blind["meta"]["output"], "point_at needs a picture of the screen first")

look()
req, done = asked("point 100 50 60 20 the Share button")
ok(req and req.get("event") == "input.do" and req["kind"] == "point", f"point_at asks the app to draw, without a card ({req and req.get('event')})")
box = (req["x"], req["y"], req["width"], req["height"])
ok(box == (1652, 80, 120, 40) and req["round"] is False, f"the ring is at screen points worked out like a click's: middle (1712, 100), 120x40 ({box})")
ok(req["label"] == "the Share button" and req["threadId"] == tid and req["gen"] >= 1, f"the app gets the label, the chat and which highlight it is ({req['label']}, {req['gen']})")
out = done["meta"]["output"]
ok(done["meta"]["status"] == "done" and "sees a ring" in out and "one step" in out and "don't click it for them" in out, f"the agent is told to say one step and let the user do it ({out[:120]})")
row = next(r for r in send("ledger.list")["result"] if r["action"] == "point")
ok(row["decision"] == "allowed (always)" and row["target"] == "the Share button", f"pointing is in the activity log, never asked ({row['decision']})")

# The picture isn't used up: a click (asked for by the user) still lands by it.
req, clicked = asked("click 100 50 the Share button")
ok(req and req.get("kind") == "click" and (req["x"], req["y"]) == (1712, 100) and clicked["meta"]["status"] == "done", f"a click after pointing still goes by the same picture ({req and (req.get('x'), req.get('y'))})")

# No size: a ring round the point.
look()
req, _ = asked("point 100 50 here")
ok(req["round"] is True and (req["width"], req["height"]) == (44, 44) and (req["x"], req["y"]) == (1690, 78), f"no size: a 44-point ring round the point ({req})")

# The app can't draw (Wayland): the agent hears why.
sentence = "Pointing at things on the screen isn't available on this desktop: Wayland doesn't let apps put a window where they choose."
req, refused = asked("point 100 50 the Share button", error=sentence)
ok(refused["meta"]["status"] == "failed" and "isn't available on this desktop" in refused["meta"]["output"], "the app's refusal (Wayland) reaches the agent")

# Wrong arguments never reach the app.
for text, needle in [("point 900 50 off the picture", "isn't in the picture"), ("point 100 50", "\"label\" is required")]:
    t = plain(text)
    ok(t["meta"]["status"] == "failed" and needle in t["meta"]["output"], f"{text!r} is refused before the app hears of it ({t['meta']['output'][:80]})")

# clear_pointer.
req, cleared = asked("unpoint")
ok(req and req.get("kind") == "unpoint" and cleared["meta"]["status"] == "done" and "Took the highlight" in cleared["meta"]["output"], "clear_pointer asks the app to take it away")

# It goes by itself after its time; an older highlight's timer never takes a newer one away.
seen.clear()
req1, _ = asked("point 100 50 60 20 one")
req2, _ = asked("point 100 50 60 20 two")  # well within the first one's time
clear = wait(lambda m: m.get("event") == "pointer.clear", timeout=6)
time.sleep(0.8)
wait(lambda m: False, timeout=0.3)
clears = [m["gen"] for m in seen if m.get("event") == "pointer.clear"]
ok(clear is not None and clears == [req2["gen"]], f"after its time the app is told to take the newest one away, once; the older one's timer says nothing (gens {req1['gen']}, {req2['gen']}; clears {clears})")

# Settings: its own row, Always by default; Never refuses it.
modes = {r["action"]: r for r in send("settings.get")["result"]["modes"]}
ok(modes.get("point", {}).get("mode") == "always" and modes["point"]["label"] == "Point at things on your screen", f"Permissions has a row for it, Always by default ({modes.get('point')})")
send("settings.set", action="point", mode="never")
off = plain("point 100 50 60 20 the Share button")
ok(off["meta"]["status"] == "failed" and "turned off" in off["meta"]["output"], "set to Never, pointing is refused")
send("settings.set", action="point", mode="always")

p.stdin.close(); p.wait(timeout=5)
print("ALL PASS")
