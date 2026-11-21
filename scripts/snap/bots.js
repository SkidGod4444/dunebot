// Permissions › Bots with three bots (one may only run commands and read files), drawn with the test
// agent as their engine, and one bot open in the editor. Hands back what it drew for snapshots.mjs.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = window.dunebot.call;
  await call("bots.save", { name: "Researcher", role: "Finds sources and quotes them, with a link for every claim", engine: "echo" });
  await call("bots.save", { name: "Writer", role: "Turns my notes into a short post, plain words, no hype", engine: "echo" });
  await call("bots.save", { name: "Ops", role: "Runs commands on my machine carefully, one at a time", engine: "echo", may: ["run-command", "read-file"] });
  let end = Date.now() + 5000;
  while (Date.now() < end && !dm.get().modes.length) await sleep(100);
  dm.set({ view: "permissions" });
  end = Date.now() + 5000;
  while (Date.now() < end && document.querySelectorAll("[data-bots] [title='Edit this bot']").length < 3) await sleep(100);
  const edit = [...document.querySelectorAll("[data-bots] [title='Edit this bot']")];
  edit[2]?.click(); // Ops
  await sleep(300);
  const section = document.querySelector("[data-bots]");
  section?.previousElementSibling?.scrollIntoView({ block: "start" });
  await sleep(300);
  const clickable = [...section.querySelectorAll("button, select")];
  return {
    rows: [...section.querySelectorAll(".divide-y > div:not([data-bot-editor]) p.truncate.font-medium")].map((p) => p.textContent),
    editor: !!section.querySelector("[data-bot-editor]"),
    editing: section.querySelector("[data-bot-editor] input")?.value ?? null,
    pressed: [...section.querySelectorAll("[data-bot-editor] [aria-pressed=true]")].map((b) => b.textContent),
    handCursor: clickable.filter((el) => !el.disabled).every((el) => getComputedStyle(el).cursor === "pointer"),
    clickable: clickable.length,
  };
})();
