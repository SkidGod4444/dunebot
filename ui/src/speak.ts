/**
 * Reading answers aloud: with Sarvam AI's voice when a key is saved (Settings › Voice), else the
 * system's own voice (the browser's speechSynthesis: macOS and Windows voices, speech-dispatcher on
 * Linux when it's installed). Only the words are spoken: no Markdown, reply tags, code, links or
 * paths. A reply is spoken a sentence at a time while it arrives, up to a few sentences; the caption
 * shows the rest.
 *
 * With Sarvam, a reply streams: one voice is opened (via the core) while the answer is on its way,
 * each sentence goes to it the moment it's complete, and its audio plays as it arrives (~0.4 s after
 * a sentence, instead of 1–3 s for the whole sentence). If the stream can't, each sentence is fetched
 * whole (the next one is ready while this one plays); if Sarvam can't at all, the system voice reads
 * the rest of that reply.
 */

/** What a reply sounds like: its words without Markdown, tags, code or paths. */
export function plainForSpeech(md: string): string {
  let s = md;
  s = s.replace(/(```|~~~)[\s\S]*?(\1|$)/g, " "); // code blocks (also one still arriving)
  s = s.replace(/<\/?[A-Za-z][^>\n]*>/g, " "); // other tags: what's inside them stays
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1"); // links and pictures: their words
  s = s.replace(/<?https?:\/\/[^\s>]*[^\s>.,;:!?)]>?/g, " a link ");
  // Inline code: a short word is said; a command, path or anything longer is left out.
  s = s.replace(/`([^`\n]*)`/g, (_, c: string) => (/^[\w .,'+-]{1,24}$/.test(c) ? c : " "));
  s = s.replace(/(^|[\s(])(~|\.{1,2})?\/[^\s,;:)]+/g, "$1"); // paths
  s = s.replace(/(^|[\s(])[A-Za-z]:\\[^\s,;:)]+/g, "$1");
  s = s.replace(/^[ \t]*(#{1,6}|>+|[-*+]|\d{1,3}[.)])[ \t]+/gm, ""); // headings, quotes, list markers
  s = s.replace(/^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|?[ \t]*$/gm, ""); // table rules
  s = s.replace(/\|/g, ", ");
  s = s.replace(/\bDunebot\b/gi, "Dune Bot"); // the name is two words (older chats wrote it as one)
  s = s.replace(/(\*\*|__|\*|_|~~)(?=\S)([^\n]*?\S)\1/g, "$2"); // bold, italic, struck
  s = s.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n");
  return s.replace(/ ([,.!?;:])/g, "$1").trim();
}

/** Where finished sentences end in `text` from `from` on, never inside a code block. */
export function sentenceEnds(text: string, from: number, final: boolean): number[] {
  const out: number[] = [];
  const re = /[.!?।॥](?=\s|$)|\n\s*\n/g; // "।" ends a Hindi sentence
  re.lastIndex = from;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].length;
    if (end >= text.length && !final) break; // the last one may still be growing ("3.5")
    const fences = (text.slice(0, end).match(/^ {0,3}(```|~~~)/gm) ?? []).length;
    if (fences % 2 === 0) out.push(end);
  }
  if (final && (out.at(-1) ?? from) < text.length) out.push(text.length);
  return out;
}

let lastCancel = -1e9;
const MAX_SENTENCES = 3;
const MAX_CHARS = 360;

/** For the log: numbers only, never words. */
export type SpeechStats = {
  queued: number; started: number; ended: number; timedOut: number; errors: string[]; voices: number;
  /** How many sentences Sarvam read, and how many it couldn't (the system voice read those). */
  sarvam: number; fallbacks: number;
  /** Sentences read by the streaming voice; ms from the first sentence to its first sound (-1: none). */
  streamed: number; firstSoundMs: number;
};

/** A streaming voice (Sarvam or Deepgram over a WebSocket, through the core). Tests replace it. */
export type VoiceStream = {
  open(): Promise<string | null>;
  say(stream: string, words: string): Promise<boolean>;
  close(stream: string): void;
  /** Its audio (base64 16-bit mono PCM at `rate`) and its end ("closed"/"error"), for every stream. */
  listen(fn: (e: { stream: string; audio?: string; rate?: number; state?: string }) => void): () => void;
};
const coreStream: VoiceStream = {
  open: () =>
    Promise.race([
      window.dunebot.call("voice.streamOpen").then((r) => (typeof r?.stream === "string" ? r.stream : null)),
      new Promise<null>((done) => setTimeout(() => done(null), 4000)),
    ]).catch(() => null),
  say: (stream, words) => window.dunebot.call("voice.streamSay", { stream, text: words }).then(() => true, () => false),
  close: (stream) => void window.dunebot.call("voice.streamClose", { stream }).catch(() => {}),
  listen: (fn) =>
    window.dunebot.onEvent((m) => {
      if (m.event === "voice.audio") fn({ stream: m.stream, audio: m.audio, rate: m.rate });
      else if (m.event === "voice.stream" && m.state !== "open") fn({ stream: m.stream, state: m.state });
    }),
};
/** A stream opened ahead (while the answer is on its way), for the next reply to use. */
let warm: { at: number; id: Promise<string | null> } | null = null;
const WARM_MS = 25_000;
/** No sound this long after the first sentence: the stream isn't working, fetch sentences whole. */
const NO_SOUND_MS = 3000;
/** Quiet this long after the last sound, with everything sent and played: the reply has been read. */
const QUIET_MS = 1200;

/** Sarvam's reading of a sentence (base64 MP3), or null when it can't. Tests replace it. */
export type SarvamFetch = (words: string) => Promise<string | null>;
const fetchSarvam: SarvamFetch = (words) =>
  Promise.race([
    window.dunebot.call("voice.say", { text: words }).then((r) => (typeof r?.audio === "string" ? r.audio : null)),
    new Promise<null>((done) => setTimeout(() => done(null), 8000)),
  ]).catch(() => null);

export class Speaker {
  /** Tests set 0 (the speech path runs, nothing is heard). */
  static volume = 1;
  /** Tests set an array: every speak, cancel, start and end with its time (no words). */
  static trace: string[] | null = null;
  /** Called once per reply when it has been spoken (or stopped). */
  static onStats?: (s: SpeechStats) => void;
  /** Whether to try Sarvam first (off when Settings › Voice says "this computer"). */
  static sarvam = true;
  static fetchSarvam: SarvamFetch = fetchSarvam;
  /** The streaming voice (null: sentences are fetched whole). */
  static stream: VoiceStream | null = coreStream;
  /** Tests replace it: where streamed audio plays. */
  static makeContext = () => new AudioContext();
  /** Opens a streaming voice now, so the next reply's first sentence doesn't wait for the connection. */
  static prewarm() {
    if (!Speaker.sarvam || !Speaker.stream) return;
    if (warm && performance.now() - warm.at < WARM_MS) return;
    const old = warm;
    warm = { at: performance.now(), id: Speaker.stream.open() };
    if (old) void old.id.then((id) => id && Speaker.stream?.close(id));
  }
  private static take(): Promise<string | null> {
    const w = warm;
    warm = null;
    if (w && performance.now() - w.at < WARM_MS) return w.id;
    if (w) void w.id.then((id) => id && Speaker.stream?.close(id));
    return Speaker.stream ? Speaker.stream.open() : Promise.resolve(null);
  }
  /** Tests replace it: plays an MP3 (a blob URL) and settles when it has finished. */
  static makeAudio = (url: string) => new Audio(url);
  private stats: SpeechStats = { queued: 0, started: 0, ended: 0, timedOut: 0, errors: [], voices: 0, sarvam: 0, fallbacks: 0, streamed: 0, firstSoundMs: -1 };
  private useSarvam = Speaker.sarvam;
  // The streaming voice for this reply (see the top of this file).
  private streaming = Speaker.sarvam && !!Speaker.stream;
  private sid: string | null = null;
  private sidReady: Promise<string | null> | null = null;
  private sendChain: Promise<unknown> = Promise.resolve();
  private streamWords: string[] = [];
  private streamSent: { words: string; at: number }[] = []; // when each went to the stream
  private sending = 0;
  private heard = false;
  private streamOver = false; // closed, failed or refused a sentence after some of it was heard: no more sentences go to it
  private streamAlive = false; // the stream may still send sound (for sentences it was given)
  private firstSentAt = 0;
  /** When the voice took the first sentence (a Hinglish answer's is translated first, ~1.5 s). */
  private firstTakenAt = 0;
  private lastSentAt = 0;
  private lastSoundAt = 0;
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private nextAt = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private carry: number | null = null; // an odd byte left from the last chunk
  private unlisten: (() => void) | null = null;
  private watch = 0;
  private queue: { words: string; audio: Promise<string | null> }[] = [];
  private playing = false;
  private stopped = false;
  private current: { audio: HTMLAudioElement; url: string } | null = null;
  /** Held until each is done: Chromium can drop the events of an utterance nothing else refers to. */
  private live = new Set<SpeechSynthesisUtterance>();
  private waiting = 0; // characters queued that haven't started yet
  private reported = false;
  private at = 0; // how far into the reply has been handed to the voice
  private sentences = 0;
  private chars = 0;
  private part = 0; // which of the turn's parts (a first "On it." line, then the answer) is being read
  private pending = 0;
  private finished = false;
  private timers = new Set<number>();
  /** Whether it's speaking now (or has more to say). */
  onChange?: (speaking: boolean) => void;

  /** Whether any of this reply has been handed to the voice yet. */
  get begun() {
    return this.stats.queued > 0;
  }

  static available() {
    return typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined";
  }

  /** The reply so far; `final` once it has all arrived. `parts`: where each of the turn's messages
   * starts in `text` (a first line like "Sure, checking that now", then the answer): each part gets
   * its own few sentences, so a first line never uses up the answer's. */
  feed(text: string, final: boolean, parts: number[] = [0]) {
    if (!this.useSarvam && !Speaker.available()) return this.done(final);
    for (const end of sentenceEnds(text, this.at, final)) {
      const part = parts.filter((p) => p <= this.at).length - 1;
      if (part > this.part) {
        this.part = part;
        this.sentences = 0;
        this.chars = 0;
      }
      const words = plainForSpeech(text.slice(this.at, end));
      this.at = end;
      if (!words || this.sentences >= MAX_SENTENCES || this.chars >= MAX_CHARS) continue;
      this.sentences++;
      this.chars += words.length;
      if (this.streaming && !this.streamOver) this.streamSay(words);
      else if (this.useSarvam) this.fetch(words);
      else this.say(words);
    }
    this.done(final);
  }

  /** The streaming voice: this sentence goes to it as soon as the ones before it have. */
  private streamSay(words: string) {
    if (!this.sidReady) {
      this.pending++; // the whole stream counts as one: it ends when it has been heard (or given up)
      this.firstSentAt = performance.now();
      this.unlisten = Speaker.stream!.listen((e) => this.onStream(e));
      this.sidReady = Speaker.take();
      this.watch = window.setInterval(() => this.checkStream(), 150);
      this.streamAlive = true;
    }
    this.stats.queued++;
    this.streamWords.push(words);
    this.onChange?.(true);
    this.sending++;
    Speaker.trace?.push(`${Math.round(performance.now())} stream-say ${words.length}`);
    this.sendChain = this.sendChain.then(async () => {
      const sid = await this.sidReady;
      if (this.stopped) return;
      this.sid = sid;
      const ok = !!sid && !this.streamOver && (await Speaker.stream!.say(sid, words));
      this.lastSentAt = performance.now();
      if (ok && !this.firstTakenAt) this.firstTakenAt = this.lastSentAt;
      if (ok) this.streamSent.push({ words, at: this.lastSentAt });
      this.sending--;
      if (!ok && !this.stopped) this.streamFailed(words);
    });
  }

  private onStream(e: { stream: string; audio?: string; rate?: number; state?: string }) {
    // Another reply's stream (or this one after a stop) is never heard.
    if (this.stopped || !this.sid || e.stream !== this.sid) return;
    if (e.state) {
      this.streamAlive = false;
      // Closed or broken: what wasn't heard is fetched whole (unless that's under way already).
      if (!this.streamOver) this.streamFailed(null);
      return;
    }
    // After a refused sentence (Hindi in an English answer) it goes on reading what it was given.
    if (e.audio) this.play(e.audio, e.rate || 22050);
  }

  private play(b64: string, rate: number) {
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    } catch {
      return;
    }
    if (!this.ctx) {
      try {
        this.ctx = Speaker.makeContext();
        this.gain = this.ctx.createGain();
        this.gain.gain.value = Speaker.volume;
        this.gain.connect(this.ctx.destination);
        void this.ctx.resume?.();
      } catch {
        return this.streamFailed(null);
      }
    }
    // 16-bit little-endian samples; a chunk can end mid-sample.
    const all = this.carry === null ? bytes : Uint8Array.of(this.carry, ...bytes);
    const n = all.length >> 1;
    this.carry = all.length & 1 ? all[all.length - 1] : null;
    if (!n) return;
    const view = new DataView(all.buffer, all.byteOffset, n * 2);
    const buf = this.ctx.createBuffer(1, n, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain!);
    const at = Math.max(this.ctx.currentTime + 0.03, this.nextAt);
    src.start(at);
    this.nextAt = at + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
    this.lastSoundAt = performance.now();
    // A context that never starts (no audio device) isn't heard: after NO_SOUND_MS, fetched whole.
    if (!this.heard && (this.ctx.state ?? "running") === "running") {
      this.heard = true;
      this.stats.firstSoundMs = Math.round(performance.now() - this.firstSentAt);
      Speaker.trace?.push(`${Math.round(performance.now())} stream-sound`);
    }
  }

  /** Every 150 ms while streaming: no sound yet (give up on the stream), or all of it heard. */
  private checkStream() {
    if (this.stopped) return;
    const now = performance.now();
    if (!this.heard) {
      // Counted from when the voice took the first sentence (a refused or failed one ends it at once).
      const taken = this.firstTakenAt;
      // (Or the voice never answered at all: well past a translation's 5 s limit.)
      if (taken ? now - taken > NO_SOUND_MS : this.streamWords.length && now - this.firstSentAt > NO_SOUND_MS + 8000) this.streamFailed(null);
      return;
    }
    if (!this.finished && !this.streamOver) return;
    if (this.sending > 0) return;
    const playedOut = !this.ctx || this.ctx.currentTime >= this.nextAt - 0.02;
    const quiet = now - Math.max(this.lastSoundAt, this.lastSentAt) > QUIET_MS;
    // However it goes, the card settles: well past the reading time of everything sent.
    const chars = this.streamWords.reduce((a, w) => a + w.length, 0);
    const tooLong = now - this.lastSentAt > 6000 + chars * 150;
    if (!(quiet && playedOut) && !tooLong) return;
    if (tooLong && !(quiet && playedOut)) this.stats.timedOut++;
    this.stats.started += this.streamWords.length;
    this.stats.ended += this.streamWords.length;
    this.stats.sarvam += this.streamWords.length;
    this.stats.streamed += this.streamWords.length;
    this.endStream();
    this.pending = Math.max(0, this.pending - 1);
    if (!this.pending && this.finished) this.over();
  }

  /** The stream couldn't (no sound, an error, a refused sentence): what it was given, and what comes
   * next, is fetched whole instead. `words`: one sentence that was refused after others were heard. */
  private streamFailed(words: string | null) {
    if (this.stopped) return;
    if (this.heard) {
      // Some of it was heard. Fetched whole: a sentence it refused, or (when it stopped) every one sent
      // after its last sound; later sentences too.
      this.streamOver = true;
      this.streaming = false;
      const redo = words ? [words] : this.streamSent.filter((x) => x.at >= this.lastSoundAt).map((x) => x.words);
      this.streamSent = this.streamSent.filter((x) => !redo.includes(x.words));
      for (const w of redo) {
        const i = this.streamWords.indexOf(w);
        if (i >= 0) this.streamWords.splice(i, 1);
        this.stats.queued--;
        this.fetch(w);
      }
      return;
    }
    if (!this.streaming) return; // already handed over (a later sentence's refusal)
    const redo = this.streamWords;
    this.streamWords = [];
    this.streaming = false;
    this.stats.queued -= redo.length;
    this.stats.errors.push("stream");
    this.endStream();
    this.silence();
    this.pending = Math.max(0, this.pending - 1);
    Speaker.trace?.push(`${Math.round(performance.now())} stream-failed ${redo.length}`);
    for (const w of redo) this.fetch(w);
    if (!redo.length && !this.pending && this.finished) this.over();
  }

  /** Whatever the stream scheduled never plays. */
  private silence() {
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {}
    }
    this.sources.clear();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  private endStream() {
    this.streamAlive = false;
    window.clearInterval(this.watch);
    this.unlisten?.();
    this.unlisten = null;
    const sid = this.sid;
    if (sid) Speaker.stream?.close(sid);
    else void this.sidReady?.then((id) => id && Speaker.stream?.close(id));
    this.sidReady = this.sidReady ? Promise.resolve(null) : null;
    this.sid = null;
  }

  /** Sarvam: asks for this sentence now, plays it after the ones before it. */
  private fetch(words: string) {
    this.pending++;
    this.stats.queued++;
    this.onChange?.(true);
    Speaker.trace?.push(`${Math.round(performance.now())} sarvam-fetch ${words.length}`);
    this.queue.push({ words, audio: Speaker.fetchSarvam(words) });
    void this.playNext();
  }

  private async playNext() {
    if (this.playing || this.stopped) return;
    const item = this.queue.shift();
    if (!item) return;
    this.playing = true;
    const b64 = await item.audio;
    await this.streamQuiet();
    if (this.stopped) return; // stopped while it was being fetched: stays quiet
    if (!b64) return this.fallBack(item);
    let url = "";
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
    } catch {
      return this.fallBack(item);
    }
    const audio = Speaker.makeAudio(url);
    audio.volume = Speaker.volume;
    this.current = { audio, url };
    let over = false;
    const tr = (what: string) => Speaker.trace?.push(`${Math.round(performance.now())} ${what} ${item.words.length}`);
    // An MP3 that never ends (a stuck device) gives up after well over its reading time.
    const timer = window.setTimeout(() => finish("timeout"), 6000 + item.words.length * 150);
    this.timers.add(timer); // a stop clears it
    const finish = (how: "ended" | "error" | "timeout") => {
      if (over) return;
      over = true;
      window.clearTimeout(timer);
      this.timers.delete(timer);
      URL.revokeObjectURL(url);
      if (this.current?.audio === audio) this.current = null;
      tr(`sarvam-${how}`);
      if (this.stopped) return;
      if (how === "ended") this.stats.ended++;
      if (how === "timeout") this.stats.timedOut++;
      if (how === "error" && !began) return this.fallBack(item);
      this.playing = false;
      this.pending = Math.max(0, this.pending - 1);
      if (!this.pending && this.finished) this.over();
      else void this.playNext();
    };
    let began = false;
    audio.onended = () => finish("ended");
    audio.onerror = () => {
      this.stats.errors.push("audio");
      finish("error");
    };
    try {
      await audio.play();
      began = true;
      this.stats.started++;
      this.stats.sarvam++;
      tr("sarvam-play");
    } catch (e) {
      this.stats.errors.push(String((e as Error)?.name ?? "play"));
      finish("error");
    }
  }

  /** A sentence read whole waits for the stream's sound before it: what the stream still has to
   * send, then what's scheduled, so two voices never talk at once. */
  private async streamQuiet() {
    while (!this.stopped && (this.streamAlive || (this.ctx && this.ctx.currentTime < this.nextAt - 0.02))) {
      await new Promise((r) => window.setTimeout(r, 30));
    }
  }

  /** Sarvam couldn't read `item`: the system voice reads it and the rest of this reply. */
  private fallBack(item: { words: string }) {
    const rest = [item, ...this.queue];
    this.queue = [];
    this.playing = false;
    this.useSarvam = false;
    this.stats.fallbacks += rest.length;
    // Their places move to the system voice's own count.
    this.pending -= rest.length;
    this.stats.queued -= rest.length;
    if (!Speaker.available()) {
      if (!this.pending && this.finished) this.over();
      return;
    }
    for (const r of rest) this.say(r.words);
  }

  private say(words: string) {
    const u = new SpeechSynthesisUtterance(words);
    u.rate = 1.05;
    u.volume = Speaker.volume;
    this.live.add(u);
    this.pending++;
    this.stats.queued++;
    this.onChange?.(true);
    // Some systems have no voice and never end an utterance: give up after its reading time. Until it
    // starts, that includes the time to read every sentence waiting before it.
    let over = false;
    let began = false;
    let timer = 0;
    let extended = 0;
    const arm = (ms: number) => {
      window.clearTimeout(timer);
      this.timers.delete(timer);
      timer = window.setTimeout(() => {
        // After a cancel, Chromium on macOS can play an utterance without sending its events: while
        // the voice says it's still speaking, wait a little longer before giving up on it.
        if (speechSynthesis.speaking && extended < 2) {
          extended++;
          return arm(ms);
        }
        this.stats.timedOut++;
        end();
      }, ms);
      this.timers.add(timer);
    };
    const end = () => {
      if (over) return;
      over = true;
      window.clearTimeout(timer);
      this.timers.delete(timer);
      this.live.delete(u);
      if (!began) this.waiting -= words.length;
      this.pending = Math.max(0, this.pending - 1);
      if (!this.pending && this.finished) this.over();
    };
    this.waiting += words.length;
    arm(3000 + this.waiting * 90);
    const tr = (what: string) => Speaker.trace?.push(`${Math.round(performance.now())} ${what} ${words.length}`);
    tr("queue");
    u.onstart = () => {
      tr("start");
      if (over || began) return;
      began = true;
      this.waiting -= words.length;
      this.stats.started++;
      arm(2500 + words.length * 90);
    };
    u.onend = () => {
      tr("end");
      if (!over) this.stats.ended++;
      end();
    };
    u.onerror = (e) => {
      tr(`error:${e.error}`);
      if (!over) this.stats.errors.push(e.error);
      end();
    };
    // Chromium drops an utterance queued in the same moment as a cancel (a new answer right after
    // the last was stopped), so a fresh one waits a moment after a cancel.
    const wait = Math.max(0, lastCancel + 120 - performance.now());
    if (!wait) {
      tr("speak");
      return speechSynthesis.speak(u);
    }
    const later = window.setTimeout(() => {
      this.timers.delete(later);
      tr("speak-later");
      speechSynthesis.speak(u);
    }, wait);
    this.timers.add(later); // a stop before then cancels it too
  }

  private over() {
    this.onChange?.(false);
    if (this.reported || !this.stats.queued) return;
    this.reported = true;
    this.stats.voices = Speaker.available() ? speechSynthesis.getVoices().length : 0;
    Speaker.onStats?.(this.stats);
  }

  private done(final: boolean) {
    if (!final || this.finished) return;
    this.finished = true;
    if (!this.pending) this.over();
  }

  /** Stops at once and forgets this reply. */
  stop() {
    this.stopped = true;
    this.queue = [];
    if (this.sidReady) this.endStream();
    this.silence();
    if (this.current) {
      this.current.audio.pause();
      URL.revokeObjectURL(this.current.url);
      this.current = null;
    }
    if (Speaker.available() && this.pending && !this.useSarvam) {
      Speaker.trace?.push(`${Math.round(performance.now())} cancel (speaking=${speechSynthesis.speaking} pending=${speechSynthesis.pending})`);
      speechSynthesis.cancel();
      lastCancel = performance.now();
    }
    for (const t of this.timers) window.clearTimeout(t);
    this.timers.clear();
    this.live.clear();
    this.waiting = 0;
    const was = this.pending > 0;
    this.pending = 0;
    this.finished = true;
    if (was) this.over();
  }
}
