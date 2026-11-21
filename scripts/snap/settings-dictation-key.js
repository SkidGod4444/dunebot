// Settings › Keys: the dictation key picker. Picks the second choice (⌃ twice on macOS, Ctrl twice
// elsewhere) as a person would, and reads that the pref is saved and the row's words follow it. On
// macOS it's drawn with Apple's own Dictation on: the warning shows once ⌃ twice is picked, not before.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const end = Date.now() + 5000;
  while (Date.now() < end && !dm.get().modes.length) await sleep(100);
  dm.set({ view: "settings" });
  const until = Date.now() + 12000;
  let row;
  while (Date.now() < until && !(row = [...document.querySelectorAll("span")].find((s) => s.firstChild?.textContent === "Dictation key"))) await sleep(100);
  if (!row) return { found: false };
  const card = row.closest(".rounded-2xl");
  const pickers = [...row.parentElement.querySelectorAll("button")];
  const buttons = pickers.map((b) => b.textContent);
  const title = () => card.querySelector("span.flex-1")?.textContent ?? null;
  const before = title();
  const warnedBefore = !!card.querySelector("[data-apple-dictation]");
  pickers[1].click();
  const by = Date.now() + 5000;
  while (Date.now() < by && dm.get().prefs["dictation.key"] !== "ctrl-twice") await sleep(50);
  await sleep(200);
  card.scrollIntoView({ block: "center" });
  await sleep(200);
  const picked = pickers.find((b) => b.className.includes("bg-white"))?.textContent ?? null;
  // macOS, drawn with Apple's Dictation on (DUNEBOT_SNAPSHOT_APPLE_DICTATION=1): the warning shows.
  const warnBy = Date.now() + 3000;
  while (window.dunebot.platform === "darwin" && Date.now() < warnBy && !card.querySelector("[data-apple-dictation]")) await sleep(50);
  const warning = card.querySelector("[data-apple-dictation]")?.textContent ?? null;
  return { found: true, buttons, before, after: title(), picked, pref: dm.get().prefs["dictation.key"] ?? null, platform: window.dunebot.platform, warnedBefore, warning };
})();
