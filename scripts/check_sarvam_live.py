"""Sarvam through the core, the way the app uses it: the key goes in over stdin (voice.key), never
in an environment variable or on a command line, and never comes back out.
Usage: python3 -I scripts/check_sarvam_live.py <core> <key-file> <out-dir>
<key-file>: a .env with SARVAM_API_KEY=… (read here, never printed). Uses made-up sentences only: the
speech it listens to is made by Sarvam first (16 kHz WAV), straight from this script."""
import base64, json, os, queue, subprocess, sys, threading, time, wave, struct, urllib.request

core, key_file, out = sys.argv[1], sys.argv[2], sys.argv[3]
KEY = next(l.split("=", 1)[1].strip().strip("'\"") for l in open(key_file, encoding="utf-8") if l.strip().startswith("SARVAM_API_KEY="))
data = os.path.join(out, "data"); os.makedirs(data, exist_ok=True)
err_log = os.path.join(out, "core-stderr.log")
p = subprocess.Popen([core], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(err_log, "w"),
                     env=dict(os.environ, DUNEBOT_DATA_DIR=data), text=True, bufsize=1)
q = queue.Queue(); seen = []
threading.Thread(target=lambda: [q.put(json.loads(l)) for l in p.stdout], daemon=True).start()
n = 0
def call(method, **params):
    global n; n += 1; i = n
    p.stdin.write(json.dumps({"id": i, "method": method, "params": params}) + "\n"); p.stdin.flush()
    end = time.time() + 60
    while time.time() < end:
        try: m = q.get(timeout=0.5)
        except queue.Empty: continue
        seen.append(json.dumps(m))
        if m.get("id") == i: return m
    raise SystemExit(f"{method}: no reply")
def events(pred, timeout):
    """Events matching `pred` (already seen ones too) within `timeout` seconds."""
    end = time.time() + timeout
    while True:
        found = [m for m in map(json.loads, seen) if m.get("event") and pred(m)]
        if found or time.time() >= end: return found
        try: seen.append(json.dumps(q.get(timeout=0.05)))
        except queue.Empty: pass
results = []
def check(name, ok, detail=""):
    results.append(ok); print(f"{'PASS' if ok else 'FAIL'} {name}{' — ' + detail if detail else ''}")

def wav16(path, samples):
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes(b"".join(struct.pack("<h", max(-32768, min(32767, int(s * 32767)))) for s in samples))
def read16(path):
    with wave.open(path, "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1
        raw = w.readframes(w.getnframes())
    return [x / 32768 for x in struct.unpack(f"<{len(raw)//2}h", raw)]

st = call("voice.status")["result"]
check("without a key: this computer listens", st.get("engine") == "local")
r = call("voice.say", text="Hello.")
check("without a key: nothing is read by Sarvam", "error" in r and "off" in r["error"], r.get("error", ""))
st = call("voice.key", key=KEY)["result"]
check("key handed over: Sarvam listens", st.get("engine") == "sarvam", st.get("language", ""))

sentences = {"en": "Dunebot found twelve files in the test folder, and the biggest one is a video.",
             "hi": "आज मौसम बहुत अच्छा है, चलो पार्क में घूमने चलते हैं।"}
for name, text in sentences.items():
    t = time.time(); r = call("voice.say", text=text); dt = time.time() - t
    audio = base64.b64decode(r.get("result", {}).get("audio", "")) if "result" in r else b""
    ok = len(audio) > 5000 and audio[:3] in (b"ID3",) or audio[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2")
    check(f"read aloud ({name}): MP3 back", ok, f"{len(audio)} bytes in {dt:.1f} s" if audio else r.get("error", ""))
    if audio: open(os.path.join(out, f"say-{name}.mp3"), "wb").write(audio)
r = call("voice.say", text="x" * 501)
check("more than 500 characters is refused", "error" in r, r.get("error", ""))

# Listening: made-up speech (Sarvam's own voice, 16 kHz WAV), through the same path as push-to-talk.
spike = out
def make_wav(name, text, lang):
    body = json.dumps({"text": text, "target_language_code": lang, "speaker": "simran_enhi_companion", "model": "bulbul:v4-flash",
                       "speech_sample_rate": 16000, "output_audio_codec": "wav"}).encode()
    req = urllib.request.Request("https://api.sarvam.ai/text-to-speech", data=body, method="POST",
                                 headers={"api-subscription-key": KEY, "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        open(os.path.join(out, f"{name}.wav"), "wb").write(base64.b64decode(json.loads(r.read())["audios"][0]))
make_wav("en", sentences["en"], "en-IN")
make_wav("hi", sentences["hi"], "hi-IN")
make_wav("mix", "Mera laptop slow chal raha hai, kya tum Downloads folder check kar sakte ho?", "hi-IN")
for name, want in [("en", "test folder"), ("mix", "folder"), ("hi", "मौसम")]:
    f = os.path.join(spike, f"{name}.wav")
    t = time.time(); r = call("voice.transcribeFile", path=f); dt = time.time() - t
    text = r.get("result", {}).get("text", "")
    check(f"listened ({name})", want in text, f"{dt:.1f} s: {text}" if text else r.get("error", ""))
# 45 s: English, 2 s quiet, mixed, repeated; cut into two parts, both heard.
en, mix = read16(os.path.join(spike, "en.wav")), read16(os.path.join(spike, "mix.wav"))
long = []
while len(long) < 45 * 16000: long += en + [0.0] * 32000 + mix + [0.0] * 32000
wav16(os.path.join(out, "long.wav"), long[:45 * 16000])
t = time.time(); r = call("voice.transcribeFile", path=os.path.join(out, "long.wav")); dt = time.time() - t
text = r.get("result", {}).get("text", "")
check("45 s recording: both parts heard", text.count("folder") >= 3, f"{dt:.1f} s, {len(text)} characters")
# Silence never goes to Sarvam.
wav16(os.path.join(out, "quiet.wav"), [0.0003 * ((i * 7919) % 13 - 6) / 6 for i in range(3 * 16000)])
r = call("voice.transcribeFile", path=os.path.join(out, "quiet.wav"))
check("silence is turned back before any upload", r.get("result", {}).get("note") == "Didn't hear anything.", json.dumps(r.get("result", r.get("error")))[:80])
# Streaming: one voice per answer, sentences in, audio out as it's made.
t0 = time.time(); sid = call("voice.streamOpen")["result"]["stream"]
opened = events(lambda m: m["event"] == "voice.stream" and m.get("stream") == sid and m.get("state") == "open", 8)
check("stream opens", bool(opened), f"{time.time() - t0:.2f} s")
t0 = time.time(); call("voice.streamSay", stream=sid, text="आपके डाउनलोड फ़ोल्डर में बारह फ़ाइलें हैं।")
first = None
while time.time() - t0 < 5 and not first:
    got = events(lambda m: m["event"] == "voice.audio" and m.get("stream") == sid, 0.05)
    if got: first = time.time() - t0
events(lambda m: False, 2.0)  # gathers the rest of its sound
chunks = events(lambda m: m["event"] == "voice.audio" and m.get("stream") == sid, 0.1)
secs = sum(len(base64.b64decode(c["audio"])) for c in chunks) / 2 / 22050
check("stream: Hindi sound starts within a second", first is not None and first < 1.0, f"first sound {first and round(first, 2)} s, {len(chunks)} chunks, {secs:.1f} s of audio at {chunks and chunks[0]['rate']} Hz")
r = call("voice.streamSay", stream=sid, text="a" * 501)
check("stream: more than 500 characters is refused", "error" in r, r.get("error", ""))
call("voice.streamClose", stream=sid)
closed = events(lambda m: m["event"] == "voice.stream" and m.get("stream") == sid and m.get("state") == "closed", 5)
r = call("voice.streamSay", stream=sid, text="After the close.")
check("stream: closed, and nothing more goes to it", bool(closed) and "error" in r, r.get("error", ""))
def stream_sound(sid, text, wait=5):
    """Says `text` on stream `sid`; returns (seconds to first sound, PCM bytes) once it goes quiet."""
    before = len(events(lambda m: m["event"] == "voice.audio" and m.get("stream") == sid, 0))
    t0 = time.time(); call("voice.streamSay", stream=sid, text=text)
    first = None
    while time.time() - t0 < wait and first is None:
        if len(events(lambda m: m["event"] == "voice.audio" and m.get("stream") == sid, 0.05)) > before: first = time.time() - t0
    events(lambda m: False, 2.0)
    pcm = b"".join(base64.b64decode(c["audio"]) for c in events(lambda m: m["event"] == "voice.audio" and m.get("stream") == sid, 0)[before:])
    return first, pcm
# Opened at key release, used seconds later: the stream must still be there.
sid = call("voice.streamOpen")["result"]["stream"]
events(lambda m: False, 12)
first, pcm = stream_sound(sid, "Your downloads folder has twelve files.")
check("stream: still works 12 s after opening", first is not None and first < 1.0, f"first sound {first and round(first, 2)} s")
call("voice.streamClose", stream=sid)
# A reply of two words (shorter than the stream's buffer).
sid = call("voice.streamOpen")["result"]["stream"]
first, pcm = stream_sound(sid, "Hi again!")
check("stream: a two-word reply is read", first is not None and first < 1.0 and len(pcm) > 22050, f"first sound {first and round(first, 2)} s, {len(pcm) / 2 / 22050:.1f} s of audio")
call("voice.streamClose", stream=sid)
# English first, then Hindi, on one stream: the Hindi must still come out as Hindi.
sid = call("voice.streamOpen")["result"]["stream"]
stream_sound(sid, "Sure.")
first, pcm = stream_sound(sid, "आज मौसम बहुत अच्छा है, चलो पार्क में घूमने चलते हैं।")
mixed = os.path.join(out, "streamed-hi-after-en.wav")
with wave.open(mixed, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(22050); w.writeframes(pcm)
heard = call("voice.transcribeFile", path=mixed).get("result", {}).get("text", "")
devanagari = sum(1 for ch in heard if "\u0900" <= ch <= "\u097f")
check("stream: Hindi after English still sounds Hindi", devanagari > 10 and ("मौसम" in heard or "पार्क" in heard or "पार्क" in heard), heard[:60])
call("voice.streamClose", stream=sid)
# "This computer" in Settings, with the key still handed over: nothing goes to Sarvam.
call("prefs.set", key="voice.engine", value="local")
r = call("voice.streamOpen")
check("on this computer: no streaming voice", "error" in r and "off" in r["error"], r.get("error", ""))
before = open(err_log, encoding="utf-8", errors="replace").read().count("sarvam:")
r = call("voice.say", text="Hello.")
check("on this computer: nothing is read by Sarvam", "error" in r and "off" in r["error"], r.get("error", ""))
r = call("voice.transcribeFile", path=os.path.join(spike, "en.wav"))
time.sleep(0.3)
after = open(err_log, encoding="utf-8", errors="replace").read().count("sarvam:")
check("on this computer: listening stays here", "error" in r and "speech model" in r["error"] and before == after, r.get("error", ""))
call("prefs.set", key="voice.engine", value="sarvam")
# A wrong key: a plain error that never echoes it.
bad = "sk_wrong_" + "a" * 24
call("voice.key", key=bad)
r = call("voice.transcribeFile", path=os.path.join(spike, "en.wav"))
check("wrong key: Sarvam's refusal is shown", "error" in r and "Sarvam said" in r["error"], r.get("error", ""))
sid = call("voice.streamOpen")["result"]["stream"]
bad_end = events(lambda m: m["event"] == "voice.stream" and m.get("stream") == sid and m.get("state") == "error", 8)
check("wrong key: the stream ends with an error", bool(bad_end), (bad_end[0].get("message") or "")[:80] if bad_end else "")
call("voice.key", key=None)
check("key taken back: this computer listens again", call("voice.status")["result"].get("engine") == "local")
p.stdin.close(); p.wait(timeout=10)
logs = open(err_log, encoding="utf-8", errors="replace").read() + "\n".join(seen)
check("the key is in no reply and no log", KEY not in logs and bad not in logs)
check("no words in the log", "folder" not in open(err_log, encoding="utf-8", errors="replace").read())
print("ALL PASS" if all(results) else f"{results.count(False)} FAILED")
sys.exit(0 if all(results) else 1)
