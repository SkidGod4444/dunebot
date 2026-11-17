// The answer beside the pointer while a command waits for your OK (the card is clickable there).
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t = await window.dunebot.call("threads.create", { agent: "echo", cwd: "~" });
  dm.caption({ threadId: t.id, side: "below", align: "left", speak: false });
  await dm.send(t.id, "run rm old-notes.txt", true); // Auto asks: rm is risky
  const end = Date.now() + 10000;
  while (Date.now() < end && !(dm.get().waiting[t.id] > 0)) await sleep(100);
  await sleep(600);
})();
