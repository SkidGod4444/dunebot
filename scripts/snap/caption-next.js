// An answer beside the pointer with a question said meanwhile, waiting to be asked once it ends.
(async () => {
  const dm = window.__dm;
  const t = await window.dunebot.call("threads.create", { agent: "echo", cwd: "~" });
  dm.caption({ threadId: t.id, side: "below", align: "left", speak: false });
  await dm.send(t.id, "Which files in Downloads are biggest?", true);
  const done = () => (dm.get().messages[t.id] ?? []).some((m) => m.role === "assistant" && m.meta.status === "done");
  const end = Date.now() + 15000;
  while (Date.now() < end && !done()) await new Promise((r) => setTimeout(r, 100));
  dm.next("and how much space do they take altogether, in megabytes?");
  await new Promise((r) => setTimeout(r, 800));
  return { next: !!document.body.textContent.includes("Next:") };
})();
