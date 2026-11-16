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
  row?.scrollIntoView({ block: "center" });
  await sleep(300);
})();
