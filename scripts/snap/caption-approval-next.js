// A question said while a command waits for your OK: it waits under the card (talking never answers one).
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t = await window.dunebot.call("threads.create", { agent: "echo", cwd: "~" });
  dm.caption({ threadId: t.id, side: "below", align: "left", speak: false });
  await dm.send(t.id, "run rm old-notes.txt", true); // Auto asks: rm isn't a command that only looks
  const end = Date.now() + 10000;
  while (Date.now() < end && !(dm.get().waiting[t.id] > 0)) await sleep(100);
  dm.next("and how big is it?");
  await sleep(600);
  return { label: document.body.textContent.includes("Next, once you answer this:") };
})();
