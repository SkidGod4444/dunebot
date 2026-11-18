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
  const started = Date.now();
  // What happened, for when a step goes missing: which step, how long in, and how the core answered
  // the send (refused because the last turn never ended, or never answered at all).
  const res = { steps: [], stuck: null };
  // The next question goes once the core has finished the last turn (it refuses one while busy). A
  // slow machine gets 30 s; a turn that never ends still fails, saying so.
  const ask = async (text) => {
    const end = Date.now() + 30000;
    let refused = 0;
    for (;;) {
      const sent = Date.now();
      const answer = window.dunebot.call("threads.send", { id: t.id, text, spoken: true }).then(
        () => "sent",
        (e) => `refused: ${e?.message ?? e}`,
      );
      const said = await Promise.race([answer, new Promise((r) => setTimeout(() => r("never answered"), 10000))]);
      if (said === "sent") return res.steps.push({ text, at: sent - started, refusedFirst: refused });
      if (said === "never answered" || Date.now() > end) {
        res.stuck = { text, at: sent - started, said, refusedFor: refused };
        throw new Error(said);
      }
      refused++;
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const steps = ["look", "click 10 20 the Career tab", "look", "scroll 10 20 down", "look", "drag 5 5 30 40", "type hello\\nworld", "keys ctrl+t 2"];
  try {
    for (const [i, s] of steps.entries()) {
      await ask(s);
      await after(i + 1);
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 1200)); // the reply finishes appearing (smooth.ts)
  return res;
})();
