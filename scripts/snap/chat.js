// One short chat with the test agent (no AI, fixed text) that writes one file, so the chat's header
// is drawn with its undo button.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(100); } return false; };
  await dm.startChat("echo", null, "Hi! What can you do?");
  const id = dm.get().activeId;
  const replied = () => (dm.get().messages[id] ?? []).some((m) => m.role === "assistant" && m.meta.status === "done");
  await waitFor(() => replied() && !dm.get().busy[id]);
  await sleep(300);
  await dm.send(id, "write notes.md\nhello from the snapshot");
  await waitFor(() => (dm.get().waiting[id] ?? 0) > 0);
  const card = dm.get().messages[id].find((m) => m.role === "approval" && m.meta.status === "pending");
  if (card) await window.dunebot.call("approvals.respond", { id: card.meta.approvalId, decision: "once" });
  await waitFor(() => !dm.get().busy[id]);
  await sleep(500);
})();
