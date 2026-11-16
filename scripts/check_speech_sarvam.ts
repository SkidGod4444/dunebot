// Reading aloud with Sarvam (ui/src/speak.ts), with a stand-in Sarvam and audio (nothing is sent or
// heard): sentences are fetched as soon as they're complete and played in order; a stop while one is
// being fetched stays quiet; when Sarvam can't, the system voice reads the rest of that reply.
// Usage: bun scripts/check_speech_sarvam.ts
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const g = globalThis as any;
g.window = { setTimeout, clearTimeout, setInterval, clearInterval, dunebot: { call: async () => ({}) } };
const blobs = new Map<string, Blob>();
let n = 0;
URL.createObjectURL = (b: Blob) => (blobs.set(`blob:${++n}`, b), `blob:${n}`);
URL.revokeObjectURL = (u: string) => void blobs.delete(u);
let played: string[] = [];
let playedAt: number[] = [];
let spoken: string[] = [];
let log: string[] = [];
g.SpeechSynthesisUtterance = class { onstart?: () => void; onend?: () => void; onerror?: () => void; rate = 1; volume = 1; constructor(public text: string) {} };
g.speechSynthesis = {
  speaking: false, pending: false, getVoices: () => [1, 2],
  speak(u: any) { spoken.push(u.text); log.push(`system:${u.text}`); setTimeout(() => { u.onstart?.(); setTimeout(() => u.onend?.(), 15); }, 2); },
  cancel() {},
};
const { Speaker } = await import("../ui/src/speak");

class FakeAudio {
  volume = 1; onended: (() => void) | null = null; onerror: (() => void) | null = null; paused = false;
  constructor(private url: string) {}
  async play() {
    const words = await blobs.get(this.url)!.text();
    played.push(words); log.push(`play:${words}`); playedAt.push(performance.now());
    setTimeout(() => !this.paused && (log.push(`end:${words}`), this.onended?.()), 40);
  }
  pause() { this.paused = true; log.push("pause"); }
}
Speaker.makeAudio = (u: string) => new FakeAudio(u) as any;
Speaker.stream = null; // 1–6: sentences fetched whole (7–12 stream)
let fetched: { words: string; at: number }[] = [];
const fetchDelay = (w: string) => (w.startsWith("Slow") ? 120 : 30);
let fail = (w: string) => false;
Speaker.fetchSarvam = async (w: string) => {
  fetched.push({ words: w, at: performance.now() }); log.push(`fetch:${w}`);
  await sleep(fetchDelay(w));
  return fail(w) ? null : btoa(String.fromCharCode(...new TextEncoder().encode(w))); // UTF-8, as the core's audio would carry Hindi
};
let stats: any = null;
Speaker.onStats = (s) => (stats = s);

let failed = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${ok ? "" : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`}`);
};
const reset = () => { played = []; playedAt = []; spoken = []; log = []; fetched = []; stats = null; fail = () => false; };
async function until(f: () => boolean, ms = 3000) { const end = Date.now() + ms; while (!f() && Date.now() < end) await sleep(5); }

// 1. In order, and the next is already fetched while one plays.
reset(); Speaker.sarvam = true;
let s = new Speaker();
s.feed("Slow first one. Second one", false);
s.feed("Slow first one. Second one. Third one.", true);
await until(() => stats !== null);
eq("three sentences played in order", played, ["Slow first one.", "Second one.", "Third one."]);
eq("all fetched before the first finished playing", log.indexOf("fetch:Third one.") < log.indexOf("end:Slow first one."), true);
eq("nothing went to the system voice", spoken, []);
eq("counts", [stats.queued, stats.started, stats.ended, stats.sarvam, stats.fallbacks], [3, 3, 3, 3, 0]);

// 2. Stopped while the first is being fetched: nothing is ever heard.
reset();
s = new Speaker();
s.feed("Slow answer here. And more.", true);
await sleep(20);
s.stop();
await sleep(250);
eq("stopped mid-fetch stays quiet", [played, spoken], [[], []]);

// 3. Stopped mid-sentence: that one pauses, the next never plays.
reset();
s = new Speaker();
s.feed("One here. Two here.", true);
await until(() => played.length === 1);
s.stop();
await sleep(200);
eq("stopped while playing: paused, nothing after", [played, log.includes("pause")], [["One here."], true]);

// 4. Sarvam can't read the second: the system voice reads it and the rest.
reset();
fail = (w) => w.startsWith("Two");
s = new Speaker();
s.feed("One here. Two here. Three here.", true);
await until(() => stats !== null);
eq("Sarvam read the first", played, ["One here."]);
eq("the system voice read the rest, in order", spoken, ["Two here.", "Three here."]);
eq("counts after falling back", [stats.queued, stats.ended, stats.sarvam, stats.fallbacks], [3, 3, 1, 2]);

// 5. A later reply tries Sarvam again; with Settings on this computer, Sarvam isn't asked.
reset();
s = new Speaker();
s.feed("Back again.", true);
await until(() => stats !== null);
eq("the next reply is Sarvam's again", played, ["Back again."]);
reset(); Speaker.sarvam = false;
s = new Speaker();
s.feed("Local only.", true);
await until(() => stats !== null);
eq("this computer's voice: Sarvam not asked", [fetched.length, spoken], [0, ["Local only."]]);

// 6. Only a few sentences of a long reply are read (the card shows the rest).
reset(); Speaker.sarvam = true;
s = new Speaker();
s.feed("A one. B two. C three. D four. E five.", true);
await until(() => stats !== null);
eq("three sentences at most", played.length, 3);

// ---- Streaming (a stand-in stream and audio context: nothing is sent or heard) ----
let streamLog: string[] = [];
let opens = 0;
let listeners = new Set<(e: any) => void>();
let openFails = false, silent = false, errorAfter = -1, chunkBytes = 4411; // odd: a sample split across chunks
const emit = (e: any) => [...listeners].forEach((f) => f(e));
let said = 0;
const dead = new Set<string>();
Speaker.stream = {
  async open() { opens++; streamLog.push("open"); await sleep(20); return openFails ? null : `s${opens}`; },
  async say(id, words) {
    streamLog.push(`say:${id}:${words}`);
    if (dead.has(id)) return false;
    if (/[\u0900-\u097F]/.test(words) && refuseHindi) return false; // the American voice reads English only
    const k = ++said;
    if (!silent) setTimeout(() => {
      if (dead.has(id)) return;
      if (k === errorAfter) return dead.add(id), emit({ stream: id, state: "error" });
      for (let i = 0; i < 2; i++) emit({ stream: id, rate: 22050, audio: btoa(String.fromCharCode(...new Uint8Array(chunkBytes))) });
    }, words.startsWith("Late") ? 150 : 30);
    return true;
  },
  close(id) { streamLog.push(`close:${id}`); },
  listen(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};
let samples = 0, sounds = 0, stoppedSources = 0, soundEnds = 0, refuseHindi = false;
const t0 = performance.now();
Speaker.makeContext = () => ({
  get currentTime() { return (performance.now() - t0) / 1000; },
  destination: {},
  createGain: () => ({ gain: { value: 1 }, connect() {} }),
  createBuffer: (_c: number, n: number, rate: number) => (samples += n, { duration: n / rate, getChannelData: () => new Float32Array(n) }),
  createBufferSource: () => ({ buffer: null as any, connect() {}, start(at: number) { sounds++; soundEnds = Math.max(soundEnds, t0 + (at + this.buffer.duration) * 1000); }, stop() { stoppedSources++; }, onended: null }),
  resume: async () => {},
  close: async () => {},
}) as any;
const resetStream = () => { reset(); streamLog = []; samples = 0; sounds = 0; stoppedSources = 0; soundEnds = 0; openFails = false; silent = false; errorAfter = -1; said = 0; refuseHindi = false; };

// 7. Streamed: sentences go to one stream in order as they complete; its sound plays as it arrives.
resetStream(); Speaker.sarvam = true;
s = new Speaker();
s.feed("First one. Second", false);
s.feed("First one. Second one. Third one.", true);
await until(() => stats !== null, 6000);
eq("one stream, sentences in order, then closed", streamLog, ["open", "say:s1:First one.", "say:s1:Second one.", "say:s1:Third one.", "close:s1"]);
eq("its sound played; nothing fetched whole or spoken by the system", [sounds, fetched.length, spoken.length], [6, 0, 0]);
eq("a sample split across two chunks isn't lost", samples, Math.floor((chunkBytes * 6) / 2));
eq("streamed counts", [stats.queued, stats.sarvam, stats.streamed, stats.fallbacks, stats.firstSoundMs >= 0], [3, 3, 3, 0, true]);

// 8. Opened ahead: the reply uses that stream (no second open, no wait for it).
resetStream();
Speaker.prewarm();
Speaker.prewarm(); // the transcript and the card opening both ask: still one stream
await sleep(40);
s = new Speaker();
s.feed("Warm start.", true);
await until(() => stats !== null, 6000);
eq("the stream opened ahead is used", streamLog.slice(0, 2), ["open", "say:s2:Warm start."]);
eq("opened once", streamLog.filter((x) => x === "open").length, 1);

// 9. The stream can't open: each sentence is fetched whole.
resetStream(); openFails = true;
s = new Speaker();
s.feed("One here. Two here.", true);
await until(() => stats !== null, 6000);
eq("no stream: fetched whole and played", played, ["One here.", "Two here."]);
eq("counts", [stats.sarvam, stats.streamed, stats.fallbacks], [2, 0, 0]);

// 10. Silent stream: after 3 s with no sound, the sentences are fetched whole.
resetStream(); silent = true;
s = new Speaker();
s.feed("Quiet one.", true);
await until(() => stats !== null, 8000);
eq("no sound: fetched whole", [played, streamLog.some((x) => x.startsWith("close:"))], [["Quiet one."], true]);

// 11. Stopped mid-stream: what arrives afterwards is never played, the stream closes.
resetStream();
s = new Speaker();
s.feed("Stop me here. More after.", true);
await until(() => sounds > 0);
s.stop();
const after = sounds;
await sleep(300);
eq("nothing plays after a stop", sounds, after);
eq("the stream was closed and its sound stopped", [streamLog.some((x) => x.startsWith("close:")), stoppedSources > 0], [true, true]);
// Another stream's sound is never this reply's.
resetStream();
s = new Speaker();
s.feed("Mine.", true);
emit({ stream: "someone-else", rate: 22050, audio: btoa("abcd") });
await until(() => stats !== null, 6000);
eq("another stream's chunks are ignored", sounds, 2);

// 12. The stream fails after the first sentence was heard: the rest is fetched whole.
resetStream(); errorAfter = 2;
s = new Speaker();
s.feed("Heard one. Lo", false);
await until(() => sounds > 0);
s.feed("Heard one. Lost two. Then three.", true);
await until(() => stats !== null, 8000);
eq("after an error, what wasn't heard is fetched whole", played, ["Lost two.", "Then three."]);
eq("counts after the stream broke", [stats.queued, stats.streamed, stats.sarvam], [3, 1, 3]);
// (It may start up to 20 ms before the last sound ends: an <audio> takes about that long to start.)
eq("what's fetched whole plays after the stream's sound, not over it", playedAt[0] >= soundEnds - 25, true);

// 13. An English answer read by Deepgram turns Hindi: that sentence is refused and read whole (Sarvam);
// the stream's sound for the sentence before it (arriving late) still plays, and the Hindi waits for it.
resetStream(); refuseHindi = true;
s = new Speaker();
s.feed("First heard. Late two. ", false);
await until(() => sounds > 0);
s.feed("First heard. Late two. आज मौसम अच्छा है।", true); // (three sentences: the most a card reads)
await until(() => stats !== null, 8000);
eq("the Hindi sentence was refused by the stream", streamLog.filter((x) => x.startsWith("say:")).map((x) => x.split(":").slice(2).join(":")), ["First heard.", "Late two.", "आज मौसम अच्छा है।"]);
eq("the late English sound still played", sounds, 4);
eq("the Hindi is read whole", played, ["आज मौसम अच्छा है।"]);
eq("the Hindi starts after the English sound ends", playedAt[0] >= soundEnds - 25, true);
eq("counts with a refused sentence", [stats.queued, stats.streamed, stats.sarvam, stats.fallbacks], [3, 2, 3, 0]);
console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
