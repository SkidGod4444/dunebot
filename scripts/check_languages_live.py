"""Answers in every Indian language Sarvam reads, through the core the way the card uses it: each made-up
sentence is streamed (the language and voice picked from its script), the sound that comes back is
listened to again with Sarvam, and the words must match. Also: one stream won't switch to another
Indian language mid-answer (the card reads that sentence whole), and the whole-sentence path works.
Usage: python3 -I scripts/check_languages_live.py <core> <.env with SARVAM_API_KEY> <out-dir>
The key is read here and handed over on stdin; never printed."""
import base64, difflib, json, os, queue, re, subprocess, sys, threading, time, urllib.request, wave

core, key_file, out = sys.argv[1], sys.argv[2], sys.argv[3]
KEY = next(l.split("=", 1)[1].strip().strip("'\"") for l in open(key_file, encoding="utf-8") if l.strip().startswith("SARVAM_API_KEY="))
SENTENCES = {
    "hi-IN": "आज मौसम बहुत अच्छा है।",
    "bn-IN": "আজ আবহাওয়া খুব সুন্দর।",
    "ta-IN": "இன்று வானிலை மிகவும் நன்றாக உள்ளது.",
    "te-IN": "ఈ రోజు వాతావరణం చాలా బాగుంది.",
    "gu-IN": "આજે હવામાન ખૂબ સરસ છે.",
    "kn-IN": "ಇಂದು ಹವಾಮಾನ ತುಂಬಾ ಚೆನ್ನಾಗಿದೆ.",
    "ml-IN": "ഇന്ന് കാലാവസ്ഥ വളരെ നല്ലതാണ്.",
    "pa-IN": "ਅੱਜ ਮੌਸਮ ਬਹੁਤ ਵਧੀਆ ਹੈ।",
    "od-IN": "ଆଜି ପାଣିପାଗ ବହୁତ ଭଲ ଅଛି।",
}
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
        seen.append(m)
        if m.get("id") == i: return m
    raise SystemExit(f"{method}: no reply")
def drain(seconds):
    end = time.time() + seconds
    while time.time() < end:
        try: seen.append(q.get(timeout=0.05))
        except queue.Empty: pass
def audio_of(sid):
    return [m for m in seen if m.get("event") == "voice.audio" and m.get("stream") == sid]
results = []
def check(name, ok, detail=""):
    results.append(ok); print(f"{'PASS' if ok else 'FAIL'} {name}{' — ' + detail if detail else ''}")
norm = lambda s: re.sub(r"[\s।.,!?]", "", s)
def stderr():
    return open(err_log, encoding="utf-8", errors="replace").read()

while not any(m.get("event") == "ready" for m in seen): drain(0.2)
call("voice.key", key=KEY)

def read_and_hear(lang, text):
    sid = call("voice.streamOpen")["result"]["stream"]
    drain(1.5)  # connected, as it is in the app by the time an answer's first sentence comes
    t = time.time(); r = call("voice.streamSay", stream=sid, text=text)
    first = None
    while time.time() - t < 8 and first is None:
        drain(0.03)
        if audio_of(sid): first = time.time() - t
    drain(2.5)
    call("voice.streamClose", stream=sid)
    chunks = audio_of(sid)
    pcm = b"".join(base64.b64decode(c["audio"]) for c in chunks)
    rate = chunks[0]["rate"] if chunks else 22050
    f = os.path.join(out, f"{lang}.wav")
    with wave.open(f, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(pcm[: len(pcm) // 2 * 2])
    before = stderr().count("speech in")
    heard_text = call("voice.transcribeFile", path=f).get("result", {}).get("text", "")
    time.sleep(0.1)
    langs = re.findall(r"of (\S+) speech in", stderr())
    heard_lang = langs[-1] if len(langs) > before else "?"
    sim = difflib.SequenceMatcher(None, norm(text), norm(heard_text)).ratio()
    ok = "error" not in r and first is not None and heard_lang == lang and sim >= 0.8
    check(f"{lang}: read and heard back", ok,
          f"first sound {first and round(first, 2)} s, {len(pcm) / 2 / rate:.1f} s, heard {heard_lang}, match {sim:.2f}" if first else r.get("error", "no sound"))

for lang, text in SENTENCES.items():
    read_and_hear(lang, text)

# Marathi is written like Hindi: after you speak Marathi (made-up speech in Sarvam's Marathi voice),
# Devanagari answers are read as Marathi.
body = json.dumps({"text": "आज हवामान कसे आहे?", "target_language_code": "mr-IN", "speaker": "ishita_mr_conversational",
                   "model": "bulbul:v4-flash", "speech_sample_rate": 16000, "output_audio_codec": "wav"}).encode()
req = urllib.request.Request("https://api.sarvam.ai/text-to-speech", data=body, method="POST",
                             headers={"api-subscription-key": KEY, "content-type": "application/json"})
with urllib.request.urlopen(req, timeout=30) as resp:
    open(os.path.join(out, "mr-question.wav"), "wb").write(base64.b64decode(json.loads(resp.read())["audios"][0]))
call("voice.transcribeFile", path=os.path.join(out, "mr-question.wav"))
read_and_hear("mr-IN", "आज हवामान खूप छान आहे, बाहेर फिरायला जाऊया.")

# One stream reads one Indian language: Tamil in a Hindi answer is refused (read whole instead);
# English in a Tamil answer is read by the Tamil answer's voice.
sid = call("voice.streamOpen")["result"]["stream"]; drain(1.5)
call("voice.streamSay", stream=sid, text=SENTENCES["hi-IN"])
r = call("voice.streamSay", stream=sid, text=SENTENCES["ta-IN"])
check("Tamil in a Hindi answer is refused by that stream", "error" in r, r.get("error", ""))
r = call("voice.streamSay", stream=sid, text="And this part is in English.")
check("English in that answer stays with its voice", "result" in r, r.get("error", ""))
call("voice.streamClose", stream=sid)
for lang in ("ta-IN", "bn-IN"):
    r = call("voice.say", text=SENTENCES[lang])
    audio = base64.b64decode(r.get("result", {}).get("audio", "")) if "result" in r else b""
    check(f"{lang}: whole sentence comes back (MP3)", len(audio) > 2000, f"{len(audio)} bytes" if audio else r.get("error", ""))

check("the key appears in no reply, event or log", not any(KEY in json.dumps(m) for m in seen) and KEY not in stderr())
p.stdin.close(); p.wait(timeout=10)
print("ALL PASS" if all(results) else f"{results.count(False)} FAILED")
sys.exit(0 if all(results) else 1)
