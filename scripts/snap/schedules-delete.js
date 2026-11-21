// Schedules with one switched off, its trash pressed: it asks first, the question isn't dimmed with
// the off row (only the row's words are), and Cancel has the keyboard (Enter never deletes).
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = window.dunebot.call;
  await call("schedules.add", { prompt: "List what changed in my notes folder since yesterday", agent: "echo", every: "weekdays", at: 9 * 60 });
  const off = await call("schedules.add", { prompt: "Tidy the Downloads folder: group files by type", agent: "echo", every: "weekly", at: 18 * 60, weekday: 5 });
  await call("schedules.set", { id: off.id, enabled: false });
  dm.set({ view: "schedules" });
  let end = Date.now() + 5000;
  let row;
  while (Date.now() < end && !(row = document.querySelector("[data-schedule=off]"))) await sleep(100);
  row?.querySelector("[aria-label='Delete this schedule']")?.click();
  await sleep(300);
  const dialog = row?.querySelector("[role=dialog]");
  dialog?.scrollIntoView({ block: "center" });
  await sleep(200);
  let faded = 0;
  for (let el = dialog; el; el = el.parentElement) if (Number(getComputedStyle(el).opacity) < 1) faded++;
  return {
    dialog: dialog?.getAttribute("aria-label") ?? null,
    text: dialog?.textContent ?? null,
    focused: document.activeElement?.textContent ?? null,
    faded,
    rows: document.querySelectorAll("[data-schedule]").length,
    left: (await call("schedules.list")).length,
  };
})();
