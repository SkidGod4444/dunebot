// Schedules with one switched off, its trash pressed while that row sits at the bottom of the window:
// it asks first, the question brings itself into view (nothing scrolls it here), it isn't dimmed with
// the off row (only the row's words are), and Cancel has the keyboard (Enter never deletes).
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = window.dunebot.call;
  await call("schedules.add", { prompt: "List what changed in my notes folder since yesterday", agent: "echo", every: "weekdays", at: 9 * 60 });
  for (const [prompt, at] of [["Summarise my unread email subjects", 8 * 60], ["Check the disk space left", 12 * 60], ["Back up the notes folder to the archive drive", 20 * 60]])
    await call("schedules.add", { prompt, agent: "echo", every: "daily", at });
  // Made last, so it's the last row: nothing below it to scroll to.
  const off = await call("schedules.add", { prompt: "Tidy the Downloads folder: group files by type", agent: "echo", every: "weekly", at: 18 * 60, weekday: 5 });
  await call("schedules.set", { id: off.id, enabled: false });
  dm.set({ view: "schedules" });
  let end = Date.now() + 5000;
  let row;
  while (Date.now() < end && !(row = document.querySelector("[data-schedule=off]"))) await sleep(100);
  // The row at the very bottom of the window, as a person scrolled there would have it.
  row?.scrollIntoView({ block: "end" });
  await sleep(200);
  row?.querySelector("[aria-label='Delete this schedule']")?.click();
  await sleep(500);
  const dialog = row?.querySelector("[role=dialog]");
  const box = dialog?.getBoundingClientRect();
  const inView = !!box && box.top >= 0 && box.bottom <= window.innerHeight + 1;
  let faded = 0;
  for (let el = dialog; el; el = el.parentElement) if (Number(getComputedStyle(el).opacity) < 1) faded++;
  return {
    dialog: dialog?.getAttribute("aria-label") ?? null,
    text: dialog?.textContent ?? null,
    focused: document.activeElement?.textContent ?? null,
    faded,
    rows: document.querySelectorAll("[data-schedule]").length,
    left: (await call("schedules.list")).length,
    inView,
  };
})();
