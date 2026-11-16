// A chat where one tool fails and one card is declined, so both show "Teach a fix".
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(100); } return false; };
  const idle = (id) => (dm.get().messages[id] ?? []).some((m) => m.role === "assistant" && m.meta.status === "done") && !dm.get().busy[id];
  await dm.startChat("echo", null, "read /dunebot-snapshot/no-such-notes.md"); // the same text on every system
  const id = dm.get().activeId;
  await waitFor(() => idle(id));
  await sleep(300);
  const n = (dm.get().messages[id] ?? []).length;
  await dm.send(id, "run npm install");
  await waitFor(() => (dm.get().waiting[id] ?? 0) > 0);
  const card = dm.get().messages[id].find((m) => m.role === "approval" && m.meta.status === "pending");
  if (card) await window.dunebot.call("approvals.respond", { id: card.meta.approvalId, decision: "deny" });
  await waitFor(() => !dm.get().busy[id] && dm.get().messages[id].length > n + 3);
  await sleep(500);
})();
