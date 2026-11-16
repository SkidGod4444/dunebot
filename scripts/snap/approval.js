(async () => {
  await window.dunebot.call("settings.set", { action: "run-command", mode: "ask" }); // these commands only look
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(100); } return false; };
  await dm.startChat("echo", null, "Hi! What can you do?");
  await waitFor(() => !dm.get().busy[dm.get().activeId]);
  await dm.startChat("echo", null, "run echo hello from dunebot && date");
  await waitFor(() => Object.values(dm.get().waiting).some((n) => n > 0));
  const id = dm.get().activeId;
  const card = dm.get().messages[id].find((m) => m.role === "approval" && m.meta.status === "pending");
  await window.dunebot.call("approvals.respond", { id: card.meta.approvalId, decision: "once" });
  await waitFor(() => !dm.get().busy[id]);
  await dm.startChat("echo", null, "run du -sh ~/Downloads/* | sort -rh | head -5");
  await waitFor(() => Object.values(dm.get().waiting).some((n) => n > 0));
  await sleep(400);
})();
