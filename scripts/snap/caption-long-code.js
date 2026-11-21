// The answer beside the pointer with a code line longer than the card: the card can't scroll
// sideways, so the line wraps; no part of it is hidden.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t = await window.dunebot.call("threads.create", { agent: "echo", cwd: "~" });
  dm.caption({ threadId: t.id, side: "below", align: "left", speak: false });
  const line = "find ~/Downloads -type f -name '*.dmg' -mtime +30 -exec mv {} ~/Downloads/old-installers/ \; && echo moved";
  await dm.send(t.id, "this one:\n```sh\n" + line + "\n```", true);
  const done = () => (dm.get().messages[t.id] ?? []).some((m) => m.role === "assistant" && m.meta.status === "done");
  const end = Date.now() + 15000;
  while (Date.now() < end && !done()) await sleep(100);
  await sleep(1200);
  const block = document.querySelector('.dm-caption .md [data-streamdown="code-block"]');
  if (!block) return { found: false };
  // Anything inside the code box wider than what shows of it is cut off.
  const hidden = [block, ...block.querySelectorAll("*")].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible").length;
  const text = block.querySelector("pre")?.textContent ?? "";
  return { found: true, hidden, whole: text.includes("echo moved"), lines: Math.round(block.querySelector("pre").getBoundingClientRect().height / 18.75) };
})();
