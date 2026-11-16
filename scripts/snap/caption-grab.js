// The card following a scripted pointer that heads for it (DUNEBOT_SNAPSHOT_FOLLOW=grab): it follows
// while the pointer moves beside it, and stops for good once the pointer heads into it. Numbers in the log.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  dm.speechVolume(0);
  const t = await window.dunebot.call("threads.create", { agent: "echo", cwd: "~" });
  window.dunebot.caption.testShow(t.id);
  await sleep(100);
  await dm.send(t.id, "run sleep 3", true);
  let end = Date.now() + 3000;
  while (Date.now() < end && !dm.get().busy[t.id]) await sleep(20);
  end = Date.now() + 8000;
  while (Date.now() < end && dm.get().busy[t.id]) await sleep(100);
  await sleep(300);
  return { done: !dm.get().busy[t.id] };
})();
