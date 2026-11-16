(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  dm.set({ view: "new", activeId: null });
  const end = Date.now() + 20000;
  while (!dm.get().agents && Date.now() < end) await sleep(150);
  await sleep(300);
})();
