// Settings, at the bottom of the sidebar: ⌘, (Ctrl+, off the Mac) opens it; the sidebar's Permissions
// and Settings buttons each open their own page. Settings has the look, keys and voice; Permissions
// keeps every safety control (actions, accounts, the phone, bots). Drawn on Settings, from the top.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const end = Date.now() + 5000;
  while (Date.now() < end && !dm.get().modes.length) await sleep(100);
  const title = () => document.querySelector("main h1")?.textContent ?? null;
  const sections = () => [...document.querySelectorAll("main h2")].map((h) => h.textContent);
  const side = (label) => [...document.querySelectorAll("button")].find((b) => b.textContent === label);
  const mac = window.dunebot.platform === "darwin";
  window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: mac, ctrlKey: !mac, bubbles: true }));
  await sleep(300);
  const byKey = title();
  side("Permissions")?.click();
  await sleep(300);
  const permissions = { title: title(), sections: sections(), theme: [...document.querySelectorAll("main span")].some((s) => s.textContent === "Theme") };
  side("Settings")?.click();
  await sleep(500);
  const settings = { title: title(), sections: sections(), active: side("Settings")?.className.includes("bg-white") ?? false };
  document.querySelector("main .overflow-y-auto")?.scrollTo(0, 0);
  return { byKey, permissions, settings };
})();
