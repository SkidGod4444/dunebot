"""A Hindi or Hinglish question gets an English answer read aloud in Hinglish (the user's choice, 2026-11-17),
through the core: made-up questions and sentences, the echo agent. Each reading is listened to again with
Sarvam (it must come back as Hindi), English questions stay English, and the time to first sound is printed.
The whole-sentence check converts MP3 with macOS's afconvert.
Usage: python3 -I scripts/check_hinglish_live.py <core> <.env with SARVAM_API_KEY> <out-dir>
The key is read here and handed over on stdin; never printed."""
import base64, json, os, queue, re, subprocess, sys, threading, time, wave
core, key_file, out = sys.argv[1:4]
KEY = next(l.split("=", 1)[1].strip().strip("'\"") for l in open(key_file) if l.startswith("SARVAM_API_KEY="))
data = os.path.join(out, "data"); os.makedirs(data, exist_ok=True)
err_log = os.path.join(out, "core-stderr.log")
p = subprocess.Popen([core], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(err_log, "w"),
                     env=dict(os.environ, DUNEBOT_DATA_DIR=data), text=True, bufsize=1)
q = queue.Queue(); seen = []
threading.Thread(target=lambda: [q.put(dict(json.loads(l), _t=time.time())) for l in p.stdout], daemon=True).start()
n = 0
def call(method, **params):
    global n; n += 1; i = n
    p.stdin.write(json.dumps({"id": i, "method": method, "params": params}) + "\n"); p.stdin.flush()
    end = time.time() + 60
    while time.time() < end:
        try: m = q.get(timeout=0.5)
        except queue.Empty: continue
        seen.append(m)
        if m.get("id") == i: return m
    raise SystemExit(f"{method}: no reply")
def drain(s):
    end = time.time() + s
    while time.time() < end:
        try: seen.append(q.get(timeout=0.05))
        except queue.Empty: pass
def stderr(): return open(err_log, encoding="utf-8", errors="replace").read()
results = []
def check(name, ok, detail=""):
    results.append(ok); print(f"{'PASS' if ok else 'FAIL'} {name}{' — ' + detail if detail else ''}")
while not any(m.get("event") == "ready" for m in seen): drain(0.2)
call("voice.key", key=KEY)
tid = call("threads.create", agent="echo")["result"]["id"]
def ask(text):
    i = len(seen); call("threads.send", id=tid, text=text)
    while not any(m.get("event") == "turn.ended" for m in seen[i:]): drain(0.1)
SENTS = ["Ghaziabad is 25 degrees right now, and it feels like 23 because of the smoky haze.",
         "Carry a mask if you go out this evening."]
def read(tag):
    sid = call("voice.streamOpen")["result"]["stream"]; drain(1.5)
    t = time.time(); replies = []
    for s in SENTS:
        r = call("voice.streamSay", stream=sid, text=s); replies.append((round(time.time() - t, 2), "error" not in r))
    drain(7)
    ts = [m["_t"] for m in seen if m.get("event") == "voice.audio" and m.get("stream") == sid]
    first = round(min(ts) - t, 2) if ts else None
    call("voice.streamClose", stream=sid)
    chunks = [m for m in seen if m.get("event") == "voice.audio" and m.get("stream") == sid]
    pcm = b"".join(base64.b64decode(c["audio"]) for c in chunks); rate = chunks[0]["rate"] if chunks else 22050
    f = os.path.join(out, f"{tag}.wav")
    with wave.open(f, "wb") as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(pcm[: len(pcm)//2*2])
    before = len(re.findall(r"of (\S+) speech in", stderr()))
    heard = call("voice.transcribeFile", path=f).get("result", {}).get("text", ""); time.sleep(0.1)
    langs = re.findall(r"of (\S+) speech in", stderr())
    return dict(first=first, replies=replies, secs=round(len(pcm)/2/rate, 1), lang=langs[-1] if len(langs) > before else "?", heard=heard)

# 1. English question first (the old path, for the time to first sound).
ask("What's the weather like in Ghaziabad today?")
en = read("english")
print("english:", en)
check("English question: read in English, not translated", en["lang"].startswith("en") and "said in Hinglish" not in stderr(), en["lang"])
# 2. Sarvam's own mixed script (as the user's question came in).
ask("Hey, यार आज का मौसम कैसा है बताना?")
hi = read("hinglish-mixed")
print("hinglish (mixed-script question):", hi)
deva = sum('ऀ' <= c <= 'ॿ' for c in hi["heard"])
check("Hindi question: English sentences are read in Hinglish", hi["lang"] == "hi-IN" and deva > 10, f"{hi['lang']}, {deva} Devanagari letters heard back")
check("both sentences accepted in order", all(ok for _, ok in hi["replies"]), str(hi["replies"]))
check("translated twice", stderr().count("said in Hinglish") >= 2)
# 3. Latin Hinglish question.
ask("yaar aaj mausam kaisa hai batao")
lat = read("hinglish-latin")
check("Hinglish in Latin letters: read in Hinglish", lat["lang"] == "hi-IN", lat["lang"])
# 4. Whole-sentence path with a Hinglish answer.
r = call("voice.say", text=SENTS[1])
mp3 = os.path.join(out, "say.mp3"); open(mp3, "wb").write(base64.b64decode(r["result"]["audio"]))
wav = os.path.join(out, "say.wav"); subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", mp3, wav], check=True)
before = len(re.findall(r"of (\S+) speech in", stderr()))
said = call("voice.transcribeFile", path=wav).get("result", {}).get("text", ""); time.sleep(0.1)
langs = re.findall(r"of (\S+) speech in", stderr())
check("whole sentence (fallback) also in Hinglish", langs[-1] == "hi-IN" if len(langs) > before else False, said[:60])
# 5. A typed English question after the Hindi one: English again.
ask("And tomorrow?")
en2 = read("english-again")
check("English question after a Hindi one: English again", en2["lang"].startswith("en"), en2["lang"])
check("the key appears in no reply, event or log", not any(KEY in json.dumps({k: v for k, v in m.items() if k != "_t"}) for m in seen) and KEY not in stderr())
print("first sound: English", en["first"], "s; Hinglish", hi["first"], "s / latin", lat["first"], "s")
p.stdin.close(); p.wait(timeout=10)
print("ALL PASS" if all(results) else f"{results.count(False)} FAILED")
