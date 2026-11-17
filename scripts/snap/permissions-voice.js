// Permissions › Voice: the Sarvam key and the Deepgram key (American voice for English), neither saved.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const end = Date.now() + 5000;
  while (Date.now() < end && !dm.get().modes.length) await sleep(100);
  dm.set({ view: "settings" });
  const until = Date.now() + 3000;
  let row;
  while (Date.now() < until && !(row = [...document.querySelectorAll("span")].find((s) => s.textContent?.startsWith("Deepgram key")))) await sleep(100);
  // Centred again until it stays put for 500 ms: a part above it can draw late (CI's packaged app
  // drew it after the first scroll and the row ended up 46 px off).
  const settle = Date.now() + 4000;
  let last = NaN, since = Date.now();
  while (row && Date.now() < settle) {
    row.scrollIntoView({ block: "center" });
    const top = Math.round(row.getBoundingClientRect().top);
    if (top !== last) (last = top), (since = Date.now());
    else if (Date.now() - since >= 500) break;
    await sleep(100);
  }
  await sleep(300);
})();
