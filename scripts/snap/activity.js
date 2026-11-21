// Activity with a few kinds of rows (a file change you allowed, a schedule and a bot added): plain
// words in the columns ("File change", "You allowed it"), the core's own words in the tooltips.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(100); } return false; };
  const call = window.dunebot.call;
  await call("schedules.add", { prompt: "List what changed in my notes folder since yesterday", agent: "echo", every: "weekdays", at: 9 * 60 });
  await call("bots.save", { name: "Writer", role: "Turns my notes into a short post", engine: "echo" });
  await dm.startChat("echo", null, "write notes.md\nhello from the snapshot");
  const id = dm.get().activeId;
  await waitFor(() => (dm.get().waiting[id] ?? 0) > 0);
  const card = (dm.get().messages[id] ?? []).find((m) => m.role === "approval" && m.meta.status === "pending");
  if (card) await call("approvals.respond", { id: card.meta.approvalId, decision: "once" });
  await waitFor(() => !dm.get().busy[id]);
  dm.set({ view: "activity" });
  await sleep(600);
  const rows = [...document.querySelectorAll("main .divide-y > div")].map((r) => [...r.querySelectorAll("span")].map((s) => s.textContent.trim()));
  return { rows: rows.map((r) => [r[1], r[r.length - 1]]) };
})();
