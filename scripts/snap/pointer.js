// The highlight an agent points with when it teaches (electron/pointer.mjs, ui/src/Pointer.tsx), in
// its own hidden window. The test agent looks at a stand-in picture (DUNEBOT_SCREEN_STUB), points at
// a tab in it, looks again (the highlight must stay out of the picture), then clicks the middle of
// that tab, under the highlight: a stand-in click (DUNEBOT_INPUT_STUB) that must not be refused as
// Dune Bot's own window (scripts/check_pointer.mjs reads the log). Light and dark patches go behind
// the ring so its white stroke and dark outline can be judged in the picture.
(async () => {
  const call = window.dunebot.call;
  const t = await call("threads.create", { agent: "echo", cwd: "~" });
  const res = { steps: [] };
  const ended = () =>
    new Promise((resolve) => {
      const timer = setTimeout(() => (off(), resolve("timeout")), 20000);
      const off = window.dunebot.onEvent((m) => {
        if (m.event === "turn.ended" && m.threadId === t.id) {
          clearTimeout(timer);
          off();
          resolve(m.status);
        }
      });
    });
  for (const text of ["look", "point 256 160 90 18 the Career tab", "look", "click 256 160 the Career tab"]) {
    const done = ended();
    await call("threads.send", { id: t.id, text });
    const status = await done;
    const tool = (await call("threads.get", { id: t.id })).messages.filter((m) => m.role === "tool").at(-1);
    res.steps.push({ text, status, tool: tool?.meta?.tool, result: tool?.meta?.status, output: String(tool?.meta?.output ?? "").slice(0, 300) });
  }
  document.body.style.background = "linear-gradient(90deg, #f4f4f5 0 50%, #18181b 50% 100%)";
  return res;
})();
