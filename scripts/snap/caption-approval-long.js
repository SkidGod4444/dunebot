// The answer beside the pointer asking about a long command: the command box stays short (it
// scrolls), so what's asked and its buttons are in view together; under the box, "Show all: N more
// lines", and Allow once waits until the rest has been seen (a toast says so; still waiting).
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t = await window.dunebot.call("threads.create", { agent: "echo", cwd: "~" });
  dm.caption({ threadId: t.id, side: "below", align: "left", speak: false });
  const files = Array.from({ length: 40 }, (_, i) => `~/Documents/old-notes/draft-${2001 + i}-final-final.txt`).join(" ");
  await dm.send(t.id, `run rm ${files}`, true); // Auto asks: rm is risky
  const end = Date.now() + 10000;
  while (Date.now() < end && !(dm.get().waiting[t.id] > 0)) await sleep(100);
  await sleep(800);
  const box = document.querySelector(".dm-caption");
  const card = box?.querySelector("[data-approval-card]");
  if (!card) return { found: false };
  const inView = (el) => {
    const a = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    return a.height > 0 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
  };
  const pre = card.querySelector("pre");
  const title = card.firstElementChild;
  const yes = [...card.querySelectorAll("button")].find((b) => b.textContent.trim() === "Allow once");
  const more = card.querySelector("[data-show-all]")?.textContent ?? null;
  const shown = { pre: Math.round(pre.getBoundingClientRect().height), scrolls: pre.scrollHeight > pre.clientHeight, title: inView(title), buttons: inView(yes) };
  yes.click(); // Allow once, before the rest was seen
  await sleep(300);
  const said = document.querySelector("[role=status]")?.textContent ?? "";
  return {
    found: true,
    ...shown,
    more,
    refused: said.includes("goes on below the box"),
    stillWaiting: dm.get().waiting[t.id] > 0,
  };
})();
