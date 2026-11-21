// The long command's card after "Show all": the whole command shows (nothing left to scroll) and the
// Show all line is gone. (Nothing is allowed here: the card is only drawn.)
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
  const card = document.querySelector(".dm-caption [data-approval-card]");
  const show = card?.querySelector("[data-show-all]");
  if (!show) return { found: false };
  show.click();
  await sleep(400);
  const pre = card.querySelector("pre");
  return { found: true, whole: pre.scrollHeight <= pre.clientHeight + 1, lastFile: pre.textContent.includes("draft-2040-final-final.txt"), showGone: !card.querySelector("[data-show-all]"), stillWaiting: dm.get().waiting[t.id] > 0 };
})();
