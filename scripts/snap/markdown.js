// A Markdown reply (the test agent's `markdown`, ui/src/reply.tsx), fully shown.
(async () => {
  const dm = window.__dm;
  const t = await window.dunebot.call("threads.create", { agent: "echo", cwd: "~" });
  await dm.openThread(t.id);
  dm.set({ activeId: t.id });
  await dm.send(t.id, "markdown");
  const done = () => (dm.get().messages[t.id] ?? []).some((m) => m.role === "assistant" && m.meta.status === "done");
  const end = Date.now() + 15000;
  while (Date.now() < end && !done()) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 1200)); // the reply finishes appearing (smooth.ts)
})();
