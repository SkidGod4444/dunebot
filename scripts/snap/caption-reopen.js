// A card that finishes closing just as a new card opens must not take the new one with it (CI caught
// it once: a spoken question's card closed by the "Listening…" card fading out, its answer never read).
// Forced every time here, in both places it can happen:
// 1. Main: a close for an older card (sent before the page heard of the newer one) is ignored.
// 2. The page: the old card's close timer runs after the new card opened but before it was drawn.
// The answer must then be read aloud (the stand-in stream from caption-voice-ask.js, volume 0).
(async () => {
  const dm = window.__dm;
  const call = window.dunebot.call;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rate = 22050;
  const chunk = () => {
    const n = Math.round(rate * 0.25);
    const b = new Uint8Array(n * 2);
    const v = new DataView(b.buffer);
    for (let i = 0; i < n; i++) v.setInt16(i * 2, Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), true);
    let s = "";
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s);
  };
  const listeners = new Set();
  dm.speechVolume(0);
  dm.Speaker.sarvam = true;
  dm.Speaker.fetchSarvam = async () => null; // a fetch would mean the stream failed
  dm.Speaker.stream = {
    open: async () => "made-up-stream",
    say: async (id) => {
      setTimeout(() => listeners.forEach((f) => (f({ stream: id, rate, audio: chunk() }), f({ stream: id, rate, audio: chunk() }))), 60);
      return true;
    },
    close: () => {},
    listen: (f) => (listeners.add(f), () => listeners.delete(f)),
  };

  // 1. Main shows two cards; the first one's close arrives after the second was shown.
  const numbers = [];
  window.dunebot.caption.onShow((s) => numbers.push(s.n));
  const a = await call("threads.create", { agent: "echo", cwd: "~" });
  window.dunebot.caption.testShow(a.id);
  await sleep(200);
  window.dunebot.caption.testShow(a.id);
  await sleep(200);
  window.dunebot.caption.hide(numbers[0]);
  await sleep(200);

  // 2. A card with nothing to say fades at once; its close timer (320 ms) is caught as it is set.
  const realTimeout = window.setTimeout;
  let closeOld = null;
  window.setTimeout = (fn, ms, ...rest) => {
    if (ms === 320 && !closeOld) closeOld = fn;
    return realTimeout(fn, ms, ...rest);
  };
  dm.caption({ threadId: null, side: "above", align: "left", speak: true });
  const until = Date.now() + 2000;
  while (!closeOld && Date.now() < until) await sleep(5);
  window.setTimeout = realTimeout;
  dm.Speaker.prewarm();
  let read = null;
  const report = dm.Speaker.onStats;
  dm.Speaker.onStats = (s) => ((read = s), report?.(s));
  const t = await call("threads.create", { agent: "echo", cwd: "~" });
  await call("threads.send", { id: t.id, text: "pause Hey buddy, how are you?", spoken: true });
  // The question's card opens, and the old card's close runs before the page has drawn the new one.
  dm.caption({ threadId: t.id, side: "above", align: "left", speak: true });
  closeOld?.();
  const end = Date.now() + 20000;
  while (!read && Date.now() < end) await sleep(100);
  await sleep(300);
  return {
    numbers,
    caught: !!closeOld,
    open: document.body.innerText.includes("Echo: Hey buddy"), // the new card, with its answer
    read: !!read,
    streamed: read?.streamed ?? 0,
  };
})();
