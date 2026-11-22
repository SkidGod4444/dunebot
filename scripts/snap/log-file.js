// Dune Bot keeps its log in a file (here DUNEBOT_LOG_DIR, a test folder): the app's lines and the
// core's. A turn of the test agent that crashes on purpose makes the core say so.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t = await window.dunebot.call("threads.create", { agent: "echo", cwd: "~" });
  dm.caption({ threadId: t.id, side: "below", align: "left", speak: false });
  await dm.send(t.id, "crash now", true);
  let end = Date.now() + 3000;
  while (Date.now() < end && !dm.get().busy[t.id]) await sleep(20);
  end = Date.now() + 15000;
  while (Date.now() < end && dm.get().busy[t.id]) await sleep(100);
  await sleep(500);
  return { ended: !dm.get().busy[t.id] };
})();
