// A chat that is working (a 4-second command, run without a card), to draw the "Stop all" row.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await window.dunebot.call("settings.set", { action: "run-command", mode: "always" });
  await dm.startChat("echo", null, "run sleep 4");
  const end = Date.now() + 5000;
  while (Date.now() < end && !dm.get().busy[dm.get().activeId]) await sleep(100);
  await sleep(400);
})();
