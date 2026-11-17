// The card following a scripted pointer that heads for it (DUNEBOT_SNAPSHOT_FOLLOW=grab): it follows
// while the pointer moves beside it, and stops for good once the pointer heads into it. Numbers in the log.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  dm.speechVolume(0);
  const t = await window.dunebot.call("threads.create", { agent: "echo", cwd: "~" });
  window.dunebot.caption.testShow(t.id);
  await sleep(100);
  // On Windows every command asks under Auto, and a card waiting for an OK holds the card still:
  // this step is about following, so commands run without asking for it (back to Auto after).
  await window.dunebot.call("settings.set", { action: "run-command", mode: "always" });
  await dm.send(t.id, "run sleep 3", true);
  let end = Date.now() + 3000;
  while (Date.now() < end && !dm.get().busy[t.id]) await sleep(20);
  end = Date.now() + 8000;
  while (Date.now() < end && dm.get().busy[t.id]) await sleep(100);
  await window.dunebot.call("settings.set", { action: "run-command", mode: "auto" });
  // Until the card has finished reading "Done." (volume 0): the picture is compared between builds,
  // and one taken mid-reading has an extra "Stop reading" button. A fixed 2.5 s was too short on a
  // slow macOS runner; this waits for the button to be gone for 300 ms (at most 12 s).
  const reading = () => !!document.querySelector('button[title="Stop reading this answer"]');
  await sleep(500);
  end = Date.now() + 12000;
  let quietSince = reading() ? 0 : Date.now();
  while (Date.now() < end && !(quietSince && Date.now() - quietSince >= 300)) {
    await sleep(100);
    if (reading()) quietSince = 0;
    else quietSince ||= Date.now();
  }
  return { done: !dm.get().busy[t.id] };
})();
