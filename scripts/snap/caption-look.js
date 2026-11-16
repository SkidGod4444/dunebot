// The answer beside the pointer after the test agent looks at the screen (`look`). The picture is a
// stand-in from DUNEBOT_SCREEN_STUB; without one, a test run must refuse to take a real picture.
(async () => {
  const dm = window.__dm;
  const t = await window.dunebot.call("threads.create", { agent: "echo", cwd: "~" });
  dm.caption({ threadId: t.id, side: "below", align: "left", speak: false });
  await dm.send(t.id, "look", true);
  const done = () => (dm.get().messages[t.id] ?? []).some((m) => m.role === "assistant" && m.meta.status === "done");
  const end = Date.now() + 20000;
  while (Date.now() < end && !done()) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 1200)); // the reply finishes appearing (smooth.ts)
})();
