// A question held-and-spoken into a NEW chat, in the app's order: the card opens on "Listening…", the
// voice warms up, the bar makes the chat and sends the question (the core announces the question just
// before the turn starts), then the card is shown for that chat. Its answer must be read aloud (the
// stand-in stream from caption-stream.js, volume 0): the log's "speech:" line says it was streamed.
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
  dm.caption({ threadId: null, side: "above", align: "left", speak: true });
  await sleep(300);
  dm.Speaker.prewarm(); // the voice warms up while what you said is written down
  // The bar's side (its own page): a new chat, the question sent, then the card shown for it. The
  // test agent's `pause` waits a second before its first words, as a real agent thinks first.
  // The reading is over when the speaker reports (its "speech:" line): wait for that, not a fixed
  // time (CI's Windows machines run the packaged app's first view slowly).
  let read = null;
  const report = dm.Speaker.onStats;
  dm.Speaker.onStats = (s) => ((read = s), report?.(s));
  const t = await call("threads.create", { agent: "echo", cwd: "~" });
  const sent = Date.now();
  await call("threads.send", { id: t.id, text: "pause Hey buddy, how are you?", spoken: true });
  const sendMs = Date.now() - sent;
  dm.caption({ threadId: t.id, side: "above", align: "left", speak: true });
  const end = Date.now() + 20000;
  while (!read && Date.now() < end) await sleep(100);
  await sleep(300);
  // What the card held, for when it isn't read: the roles, and whether the answer came before the card.
  return { roles: (dm.get().messages[t.id] ?? []).map((m) => m.role), sendMs, read: !!read, readMs: Date.now() - sent };
})();
