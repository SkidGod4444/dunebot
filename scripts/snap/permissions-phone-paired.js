// Permissions › Phone, paired, with all three switches on.
window.__phoneState = {
  key: { saved: true, canSave: true },
  phone: { token: true, bot: "@my_dunebot", code: null, paired: { name: "Sai (@sai)" }, reads: true, files: true, actions: true, problem: null },
};

(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const end = Date.now() + 5000;
  while (Date.now() < end && !dm.get().modes.length) await sleep(100);
  dm.set({ view: "settings" });
  const until = Date.now() + 12000;
  let row;
  while (Date.now() < until && !(row = [...document.querySelectorAll("span")].find((s) => s.textContent?.startsWith("Telegram bot")))) await sleep(100);
  const state = window.__phoneState;
  if (state) {
    while (Date.now() < until && !dm.phone) await sleep(50);
    await sleep(300); // after the page's own first answer
    dm.phone(state);
  }
  // Scrolled again until it stays put for 500 ms (a part above it can draw late).
  const settle = Date.now() + 4000;
  let last = NaN, since = Date.now();
  while (row && Date.now() < settle) {
    // The section's heading at the top.
    (row.closest(".rounded-2xl")?.previousElementSibling ?? row).scrollIntoView({ block: "start" });
    const top = Math.round(row.getBoundingClientRect().top);
    if (top !== last) (last = top), (since = Date.now());
    else if (Date.now() - since >= 500) break;
    await sleep(100);
  }
  await sleep(300);
  const text = row?.closest(".rounded-2xl")?.textContent ?? "";
  return { found: !!row, code: /\/pair [A-Z0-9]{8}/.test(text), paired: text.includes("Paired with"), switches: (text.match(/OffOn/g) ?? []).length };
})();
