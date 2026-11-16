// The answer beside the pointer: a short reply to a question asked from the bar, fully shown.
(async () => {
  const dm = window.__dm;
  const t = await window.dunebot.call("threads.create", { agent: "echo", cwd: "~" });
  dm.caption({ threadId: t.id, side: "below", align: "left", speak: false });
  await dm.send(t.id, "hello there", true);
  const done = () => (dm.get().messages[t.id] ?? []).some((m) => m.role === "assistant" && m.meta.status === "done");
  const end = Date.now() + 15000;
  while (Date.now() < end && !done()) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 1200)); // the reply finishes appearing (smooth.ts)
})();
