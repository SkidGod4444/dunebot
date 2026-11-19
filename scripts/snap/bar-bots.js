// The bar's agent picker with the user's bots in it, Writer picked: its badge and name show in the
// bar. Hands back the picker's choices for snapshots.mjs.
(async () => {
  const dm = window.__dm;
  const call = window.dunebot.call;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await call("bots.save", { name: "Researcher", role: "Finds sources and quotes them", engine: "echo" });
  const writer = await call("bots.save", { name: "Writer", role: "Turns my notes into a short post", engine: "echo" });
  await call("bots.save", { name: "Ops", role: "Runs commands on my machine carefully", engine: "echo" });
  const r = await call("prefs.set", { key: "agent", value: writer.id });
  dm.set({ prefs: r.prefs });
  const end = Date.now() + 5000;
  const picker = () => document.querySelector("select[aria-label=Agent]");
  while (Date.now() < end && (picker()?.querySelectorAll("option").length ?? 0) < 3) await sleep(100);
  await sleep(200);
  const label = picker()?.closest("label");
  return {
    groups: [...(picker()?.querySelectorAll("optgroup") ?? [])].map((g) => g.label),
    options: [...(picker()?.querySelectorAll("option") ?? [])].map((o) => o.textContent),
    picked: picker()?.value === writer.id,
    label: label?.textContent ?? null,
    handCursor: !!picker() && getComputedStyle(picker()).cursor === "pointer",
  };
})();
