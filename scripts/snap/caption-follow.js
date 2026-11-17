// The card following a scripted pointer (DUNEBOT_SNAPSHOT_FOLLOW): while a command runs and the
// answer is read (volume 0), then held still while a card waits for an OK. The log gets the numbers.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  dm.speechVolume(0);
  const t = await window.dunebot.call("threads.create", { agent: "echo", cwd: "~" });
  window.dunebot.caption.testShow(t.id);
  await sleep(200);
  // On Windows every command asks under Auto, and a card waiting for an OK holds the card still:
  // this step is about following, so commands run without asking for it (back to Auto after).
  await window.dunebot.call("settings.set", { action: "run-command", mode: "always" });
  await dm.send(t.id, "run sleep 2", true);
  let end = Date.now() + 3000;
  while (Date.now() < end && !dm.get().busy[t.id]) await sleep(20);
  end = Date.now() + 8000;
  while (Date.now() < end && dm.get().busy[t.id]) await sleep(100);
  await window.dunebot.call("settings.set", { action: "run-command", mode: "auto" });
  await sleep(500);
  await dm.send(t.id, "run rm old-notes.txt", true);
  end = Date.now() + 8000;
  while (Date.now() < end && !(dm.get().waiting[t.id] > 0)) await sleep(50);
  await sleep(1500);
  return { waited: dm.get().waiting[t.id] ?? 0 };
})();
