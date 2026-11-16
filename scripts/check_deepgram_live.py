"""Deepgram's American voice through the core, the way the app uses it: the key goes in over stdin
(voice.deepgramKey), never in an environment variable or on a command line, and never comes back out.
Usage: python3 -I scripts/check_deepgram_live.py <core> <key-file> [<key-file> …] <out-dir>
<key-file>: .env files holding DEEPGRAM_API_KEY=… (and, to check Hindi goes to Sarvam, SARVAM_API_KEY=…);
read here, never printed. Made-up sentences only."""
import base64, json, os, queue, re, subprocess, sys, threading, time, urllib.request, wave

core, key_files, out = sys.argv[1], sys.argv[2:-1], sys.argv[-1]
def key_named(name):
    for f in key_files:
        for l in open(f, encoding="utf-8"):
            if l.strip().startswith(f"{name}="):
                return l.split("=", 1)[1].strip().strip("'\"")
    return None
DG, SARVAM = key_named("DEEPGRAM_API_KEY"), key_named("SARVAM_API_KEY")
if not DG:
    raise SystemExit("no DEEPGRAM_API_KEY in those files")
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
def drain(seconds):
    end = time.time() + seconds
    while time.time() < end:
        try: seen.append(json.dumps(q.get(timeout=0.05)))
        except queue.Empty: pass
def evs(pred):
    return [m for m in map(json.loads, seen) if m.get("event") and pred(m)]
results = []
def check(name, ok, detail=""):
    results.append(ok); print(f"{'PASS' if ok else 'FAIL'} {name}{' — ' + detail if detail else ''}")
def is_mp3(b):
    return len(b) > 2000 and (b[:3] == b"ID3" or b[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"))
def stderr():
    return open(err_log, encoding="utf-8", errors="replace").read()

def opened(sid, wait=10):
    """Seconds until the stream is connected (the app opens it while you're still talking)."""
    t = time.time()
    while time.time() - t < wait:
        drain(0.03)
        if evs(lambda m: m["event"] == "voice.stream" and m.get("stream") == sid and m.get("state") in ("open", "error")):
            return time.time() - t
    return None

def stream_first_sound(sid, text, wait=6):
    """Says `text`; returns (seconds to first audio, the audio events) once it has gone quiet."""
    before = len(evs(lambda m: m["event"] == "voice.audio" and m.get("stream") == sid))
    t = time.time(); r = call("voice.streamSay", stream=sid, text=text)
    if "error" in r: return None, [], r["error"]
    first = None
    while time.time() - t < wait and first is None:
        drain(0.03)
        if len(evs(lambda m: m["event"] == "voice.audio" and m.get("stream") == sid)) > before: first = time.time() - t
    drain(2.0)
    return first, evs(lambda m: m["event"] == "voice.audio" and m.get("stream") == sid)[before:], ""

while not any(json.loads(s).get("event") == "ready" for s in seen): drain(0.2)

r = call("voice.deepgramKey", key="not a key")
check("a key that isn't one is refused", "error" in r, r.get("error", ""))
r = call("voice.deepgramKey", key=DG)
check("key handed over", "result" in r, r.get("error", ""))

# Deepgram only: English is read in the American voice, Hindi isn't (that's Sarvam's).
t = time.time(); r = call("voice.say", text="Your downloads folder has twelve files, and the biggest one is a video."); dt = time.time() - t
audio = base64.b64decode(r.get("result", {}).get("audio", "")) if "result" in r else b""
check("English, whole sentence: MP3 from Deepgram", is_mp3(audio), f"{len(audio)} bytes in {dt:.1f} s" if audio else r.get("error", ""))
if audio: open(os.path.join(out, "say-en.mp3"), "wb").write(audio)
r = call("voice.say", text="आज मौसम बहुत अच्छा है।")
check("Hindi without a Sarvam key: not read by Deepgram", "error" in r, r.get("error", ""))

sid = call("voice.streamOpen").get("result", {}).get("stream")
took = sid and opened(sid)
check("stream opens", bool(took), f"connected in {took:.2f} s" if took else "")
first, chunks, err = stream_first_sound(sid, "I'm Dune Bot, and I can look through your files.")
rates = {c.get("rate") for c in chunks}
secs = sum(len(base64.b64decode(c["audio"])) for c in chunks) / 2 / 24000
check("stream: English sound within a second", first is not None and first < 1.0, f"first sound {first and round(first, 2)} s, {len(chunks)} chunks, {secs:.1f} s of audio, rate {rates}" if first else err)
check("stream: 16-bit audio at 24 kHz", rates == {24000} and secs > 0.8)
check("stream: Deepgram read it (core log)", "voice: Deepgram reads this answer" in stderr())
call("voice.streamClose", stream=sid)

sid = call("voice.streamOpen")["result"]["stream"]
drain(12)
first, _, err = stream_first_sound(sid, "Still here after a pause.")
check("stream: still works 12 s after opening", first is not None and first < 1.0, f"first sound {first and round(first, 2)} s" if first else err)
call("voice.streamClose", stream=sid)

# An answer with tool use can take well over 12 s to start: the stream must still be there.
sid = call("voice.streamOpen")["result"]["stream"]
drain(40)
first, _, err = stream_first_sound(sid, "Done looking, here is what I found.")
dropped = evs(lambda m: m["event"] == "voice.stream" and m.get("stream") == sid and m.get("state") in ("closed", "error"))
check("stream: still works 40 s after opening", first is not None and first < 1.0 and not dropped,
      f"first sound {first and round(first, 2)} s" if first else (dropped[0].get("state", "") + " " + str(dropped[0].get("message") or "") if dropped else err))
call("voice.streamClose", stream=sid)

if SARVAM:
    call("voice.key", key=SARVAM)
    sid = call("voice.streamOpen")["result"]["stream"]
    opened(sid)
    first, _, err = stream_first_sound(sid, "आज मौसम बहुत अच्छा है, चलो पार्क में घूमने चलते हैं।")
    check("stream: a Hindi answer goes to Sarvam (switching costs a reconnect)", first is not None and "voice: Sarvam reads this answer" in stderr(), f"first sound {first and round(first, 2)} s" if first else err)
    call("voice.streamClose", stream=sid)

    def heard_back(name, chunks):
        """What Sarvam hears in the streamed sound: (language, text)."""
        pcm = b"".join(base64.b64decode(c["audio"]) for c in chunks)
        f = os.path.join(out, f"{name}.wav")
        with wave.open(f, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(chunks[0]["rate"] if chunks else 22050); w.writeframes(pcm[: len(pcm) // 2 * 2])
        before = stderr().count("speech in")
        text = call("voice.transcribeFile", path=f).get("result", {}).get("text", "")
        time.sleep(0.1)
        langs = re.findall(r"of (\S+) speech in", stderr())
        return (langs[-1] if len(langs) > before else "?"), text

    # Opened for the American voice (nothing heard yet), then the answer turns out Tamil or Hinglish:
    # Sarvam reads it, in that language.
    for name, text, want in [("tamil", "இன்று வானிலை மிகவும் நன்றாக உள்ளது.", "ta-IN"),
                             ("hinglish", "Rainbow tab banta hai jab sunlight hawa mein maujood paani ki boondon se guzarti hai.", "hi-IN")]:
        sid = call("voice.streamOpen")["result"]["stream"]
        opened(sid)
        first, chunks, err = stream_first_sound(sid, text)
        call("voice.streamClose", stream=sid)
        lang, said = heard_back(name, chunks) if chunks else ("?", "")
        check(f"stream: a {name} answer is read by Sarvam in {want}", first is not None and lang == want,
              f"first sound {first and round(first, 2)} s, heard {lang}: {said[:50]}" if first else err)
    sid = call("voice.streamOpen")["result"]["stream"]
    opened(sid)
    stream_first_sound(sid, "Sure, here is how it works.")
    r = call("voice.streamSay", stream=sid, text="Rainbow tab banta hai jab sunlight paani ki boondon se guzarti hai.")
    check("stream: Hinglish inside an English answer is refused (Sarvam reads it whole)", "error" in r, r.get("error", ""))
    call("voice.streamClose", stream=sid)
    # You speak Hindi (made-up speech, Sarvam's own voice): a stream opened while you talked moves to
    # Sarvam as soon as you're heard, so the Hindi answer doesn't wait for a reconnect.
    def question(name, text, lang):
        """Made-up speech in Sarvam's voice, as a 16 kHz WAV."""
        body = json.dumps({"text": text, "target_language_code": lang, "speaker": "simran_enhi_companion",
                           "model": "bulbul:v4-flash", "speech_sample_rate": 16000, "output_audio_codec": "wav"}).encode()
        req = urllib.request.Request("https://api.sarvam.ai/text-to-speech", data=body, method="POST",
                                     headers={"api-subscription-key": SARVAM, "content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            open(os.path.join(out, f"{name}.wav"), "wb").write(base64.b64decode(json.loads(resp.read())["audios"][0]))
        return os.path.join(out, f"{name}.wav")
    # You last spoke English, so a new stream connects to the American voice; then you speak Hindi.
    call("voice.transcribeFile", path=question("en-question", "What is the weather like today?", "en-IN"))
    sid = call("voice.streamOpen")["result"]["stream"]
    opened(sid)
    heard = call("voice.transcribeFile", path=question("hi-question", "आज मौसम कैसा है?", "hi-IN")).get("result", {}).get("text", "")
    drain(2.5)
    first, _, err = stream_first_sound(sid, "आज मौसम बहुत अच्छा है।")
    check("stream: after you speak Hindi it's ready with Sarvam, no reconnect", first is not None and first < 1.0 and "ready with Sarvam" in stderr(),
          f"heard {len(heard)} chars, first sound {first and round(first, 2)} s" if first else err)
    call("voice.streamClose", stream=sid)
    sid = call("voice.streamOpen")["result"]["stream"]
    stream_first_sound(sid, "Sure.")
    r = call("voice.streamSay", stream=sid, text="आज मौसम बहुत अच्छा है।")
    check("stream: Hindi in an English answer is refused at once (the card reads it whole)", "error" in r, r.get("error", ""))
    first, _, err = stream_first_sound(sid, "And English goes on after that.")
    check("stream: the American voice goes on after the refusal", first is not None, f"first sound {first and round(first, 2)} s" if first else err)
    call("voice.streamClose", stream=sid)
    r = call("voice.say", text="आज मौसम बहुत अच्छा है।")
    check("Hindi, whole sentence: Sarvam reads it", "result" in r, r.get("error", ""))
else:
    print("(no SARVAM_API_KEY in those files: Hindi routing not checked)")

# A wrong key: the stream ends with an error, the whole-sentence path falls back to Sarvam if there is one.
call("voice.deepgramKey", key="0" * 40)
sid = call("voice.streamOpen")["result"]["stream"]
call("voice.streamSay", stream=sid, text="Hello there."); drain(4)
ended = evs(lambda m: m["event"] == "voice.stream" and m.get("stream") == sid and m.get("state") == "error")
check("wrong key: the stream ends with an error", bool(ended), ended[0].get("message", "") if ended else "")
r = call("voice.say", text="Hello there.")
if SARVAM:
    check("wrong key: Sarvam reads the sentence instead", "result" in r, r.get("error", ""))
else:
    check("wrong key: the sentence fails (the card uses this computer's voice)", "error" in r, r.get("error", ""))

leak = any(k and k in blob for k in (DG, SARVAM) for blob in seen + [stderr()])
check("the keys appear in no reply, event or log", not leak)
p.stdin.close(); p.wait(timeout=10)
print("ALL PASS" if all(results) else f"{results.count(False)} FAILED")
sys.exit(0 if all(results) else 1)
