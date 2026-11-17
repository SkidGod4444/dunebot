// The first line ("On it.") is read aloud at once, while the step still runs, and the answer after
// it, in order by one voice (the stand-in stream from caption-stream.js, volume 0).
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
  const said = [];
  let tid = null;
  dm.speechVolume(0);
  dm.Speaker.sarvam = true;
  dm.Speaker.fetchSarvam = async () => null; // a fetch would mean the stream failed
  dm.Speaker.stream = {
    open: async () => "made-up-stream",
    say: async (id, words) => {
      // Still working: the command's step is running.
      const working = (dm.get().messages[tid] ?? []).some((m) => m.role === "tool" && m.meta.status === "running");
      said.push({ words, working });
      setTimeout(() => listeners.forEach((f) => (f({ stream: id, rate, audio: chunk() }), f({ stream: id, rate, audio: chunk() }))), 60);
      return true;
    },
    close: () => {},
    listen: (f) => (listeners.add(f), () => listeners.delete(f)),
  };
  await call("settings.set", { action: "run-command", mode: "always" });
  const t = await call("threads.create", { agent: "echo", cwd: "~" });
  tid = t.id;
  dm.caption({ threadId: t.id, side: "below", align: "left", speak: true });
  await dm.send(t.id, "run sleep 2", true);
  let end = Date.now() + 4000;
  while (Date.now() < end && !dm.get().busy[t.id]) await sleep(20);
  end = Date.now() + 15000;
  while (Date.now() < end && dm.get().busy[t.id]) await sleep(100);
  await sleep(2000); // the answer's reading ends
  const ok = said.length === 2 && said[0].words === "On it." && said[0].working && said[1].words === "Done." && !said[1].working;
  return { ok, said };
})();
