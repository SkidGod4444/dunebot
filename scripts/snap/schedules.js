// The Schedules page with two schedules (one switched off), drawn with the test agent only.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = window.dunebot.call;
  await call("schedules.add", { prompt: "List what changed in my notes folder since yesterday", agent: "echo", every: "weekdays", at: 9 * 60 });
  const off = await call("schedules.add", { prompt: "Tidy the Downloads folder: group files by type", agent: "echo", every: "weekly", at: 18 * 60, weekday: 5 });
  await call("schedules.set", { id: off.id, enabled: false });
  dm.set({ view: "schedules" });
  await sleep(800);
})();
