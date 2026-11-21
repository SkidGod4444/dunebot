// The answer beside the pointer asking about a long command: the command box stays short (it
// scrolls), so what's asked and its buttons are in view together.
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
  const yes = [...card.querySelectorAll("button")][0];
  return { found: true, pre: Math.round(pre.getBoundingClientRect().height), scrolls: pre.scrollHeight > pre.clientHeight, title: inView(title), buttons: inView(yes) };
})();
