// A question held while the answer is coming must wait until the card has finished reading that answer
// (the stand-in stream from caption-stream.js, volume 0): the log's "speech:" line (reading over)
// comes before "card done with the answer".
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
    say: async (id, words) => {
      setTimeout(() => listeners.forEach((f) => (f({ stream: id, rate, audio: chunk() }), f({ stream: id, rate, audio: chunk() }))), 60);
      return true;
    },
    close: () => {},
    listen: (f) => (listeners.add(f), () => listeners.delete(f)),
  };
  await call("settings.set", { action: "run-command", mode: "always" });
  const t = await call("threads.create", { agent: "echo", cwd: "~" });
  dm.caption({ threadId: t.id, side: "below", align: "left", speak: true });
  await dm.send(t.id, "What does this say? Read it to me.", true);
  let end = Date.now() + 4000;
  while (Date.now() < end && !dm.get().busy[t.id]) await sleep(20);
  dm.next("and how big is it?");
  end = Date.now() + 12000;
  while (Date.now() < end && dm.get().busy[t.id]) await sleep(100);
  await sleep(5000);
  return { busy: !!dm.get().busy[t.id] };
})();
