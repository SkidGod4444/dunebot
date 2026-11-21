// The answer beside the pointer with the pointer over it: its buttons (Open chats, Close) show in the
// row under the words, never over the answer (they sat over its first line before). Measures that.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t = await window.dunebot.call("threads.create", { agent: "echo", cwd: "~" });
  dm.caption({ threadId: t.id, side: "below", align: "left", speak: false });
  await dm.send(t.id, "markdown", true);
  const done = () => (dm.get().messages[t.id] ?? []).some((m) => m.role === "assistant" && m.meta.status === "done");
  const end = Date.now() + 15000;
  while (Date.now() < end && !done()) await sleep(100);
  await sleep(1500);
  const card = document.querySelector(".dm-caption");
  if (!card) return { found: false };
  // What the pointer arriving over the card sends (React's onMouseEnter listens for it).
  card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
  await sleep(400);
  const row = card.querySelector("[data-caption-row]");
  const buttons = row ? [...row.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")) : [];
  const first = card.querySelector(".md p, .md li, .md h1, .md h2, .md h3");
  const over = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const words = first?.getBoundingClientRect();
  const covered = [...card.querySelectorAll("button")].some((b) => words && over(b.getBoundingClientRect(), words));
  const rowBox = row?.getBoundingClientRect();
  const inCard = !!rowBox && rowBox.bottom <= card.getBoundingClientRect().bottom + 0.5;
  return { found: true, row: !!row, buttons, covered, inCard };
})();
