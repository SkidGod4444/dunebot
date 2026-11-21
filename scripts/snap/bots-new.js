// Permissions › Bots › New bot: every one of the core's 15 actions can be given, in two groups, and a
// new bot starts with everything on this computer and nothing in your accounts. The core's own
// default (a bot saved without a list) is the same.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const made = await window.dunebot.call("bots.save", { name: "Helper", role: "Helps with small things", engine: "echo" });
  let end = Date.now() + 5000;
  while (Date.now() < end && !dm.get().modes.length) await sleep(100);
  dm.set({ view: "permissions" });
  end = Date.now() + 5000;
  let add;
  while (Date.now() < end && !(add = [...document.querySelectorAll("[data-bots] button")].find((b) => b.textContent.trim() === "New bot"))) await sleep(100);
  add?.click();
  await sleep(300);
  const editor = document.querySelector("[data-bot-editor]");
  editor?.scrollIntoView({ block: "center" });
  await sleep(300);
  const groups = [...(editor?.querySelectorAll("[role=group]") ?? [])];
  return {
    coreDefault: made.may,
    groups: groups.map((g) => g.getAttribute("aria-label")),
    pills: groups.map((g) => g.querySelectorAll("[aria-pressed]").length),
    on: groups.map((g) => [...g.querySelectorAll("[aria-pressed=true]")].map((b) => b.textContent)),
    summary: [...document.querySelectorAll("[data-bots] p[title^='Runs on']")].map((p) => p.textContent),
  };
})();
