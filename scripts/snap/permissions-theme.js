// Settings › Look: picks the other theme (Light when drawn dark, Dark when drawn light) as a person
// would, and measures that the window's colours follow (the saved pref → Electron's themeSource → the
// page's light/dark). The picture is taken in the theme it switched to.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const end = Date.now() + 5000;
  while (Date.now() < end && !dm.get().modes.length) await sleep(100);
  dm.set({ view: "settings" });
  const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;
  const until = Date.now() + 12000;
  let row;
  while (Date.now() < until && !(row = [...document.querySelectorAll("span")].find((s) => s.textContent === "Theme"))) await sleep(100);
  if (!row) return { found: false };
  const card = row.closest(".rounded-2xl");
  const buttons = [...card.querySelectorAll("button")].map((b) => b.textContent);
  const before = { dark: dark(), body: getComputedStyle(document.body).backgroundColor };
  const target = before.dark ? "Light" : "Dark";
  [...card.querySelectorAll("button")].find((b) => b.textContent === target).click();
  const flipBy = Date.now() + 5000;
  while (Date.now() < flipBy && dark() === before.dark) await sleep(50);
  await sleep(300);
  const after = { dark: dark(), body: getComputedStyle(document.body).backgroundColor };
  card.scrollIntoView({ block: "center" });
  await sleep(200);
  const picked = card.querySelector("[role=radio][aria-checked=true]")?.textContent ?? null;
  return { found: true, buttons, before, after, picked, pref: dm.get().prefs["look.theme"] ?? null };
})();
