// The test agent looks at the screen, then clicks, scrolls and drags at points in those pictures,
// types and presses a shortcut. All stand-ins: the picture comes from DUNEBOT_SCREEN_STUB, and
// DUNEBOT_INPUT_STUB makes the app log what it would do instead of doing it ("input: stand-in …").
(async () => {
  const dm = window.__dm;
  const t = await window.dunebot.call("threads.create", { agent: "echo", cwd: "~" });
  dm.caption({ threadId: t.id, side: "below", align: "left", speak: false });
  const answers = () => (dm.get().messages[t.id] ?? []).filter((m) => m.role === "assistant" && m.meta.status === "done").length;
  const after = async (n) => {
    const end = Date.now() + 20000;
    while (Date.now() < end && answers() < n) await new Promise((r) => setTimeout(r, 100));
  };
  // The next question goes once the core has finished the last turn (it refuses one while busy).
  const ask = async (text) => {
    const end = Date.now() + 10000;
    for (;;) {
      try {
        return await window.dunebot.call("threads.send", { id: t.id, text, spoken: true });
      } catch (e) {
        if (Date.now() > end) throw e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  };
  const steps = ["look", "click 10 20 the Career tab", "look", "scroll 10 20 down", "look", "drag 5 5 30 40", "type hello\\nworld", "keys cmd+t 2"];
  for (const [i, s] of steps.entries()) {
    await ask(s);
    await after(i + 1);
  }
  await new Promise((r) => setTimeout(r, 1200)); // the reply finishes appearing (smooth.ts)
})();
