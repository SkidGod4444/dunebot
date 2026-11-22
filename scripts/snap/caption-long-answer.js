// A long answer beside the pointer, on its newest lines: the lines above fade under the card's top
// edge (there is more above), never cut flat. A short answer, or one scrolled back to its start, has
// no fade. The picture is the long answer scrolled down.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t = await window.dunebot.call("threads.create", { agent: "echo", cwd: "~" });
  dm.caption({ threadId: t.id, side: "below", align: "left", speak: false });
  const box = () => document.querySelector(".dm-caption-scroll");
  const state = () => {
    const el = box();
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { top: Math.round(el.scrollTop), fades: el.hasAttribute("data-scrolled"), mask: cs.maskImage || cs.webkitMaskImage || "none" };
  };
  // An answer has finished appearing once it is done and its words stop growing (smooth.ts).
  const answered = async (n) => {
    const done = () => (dm.get().messages[t.id] ?? []).filter((m) => m.role === "assistant" && m.meta.status === "done").length >= n;
    let end = Date.now() + 15000;
    while (Date.now() < end && !done()) await sleep(100);
    let last = -1;
    end = Date.now() + 10000;
    while (Date.now() < end) {
      const len = box()?.textContent.length ?? 0;
      if (len === last) break;
      last = len;
      await sleep(500);
    }
    await sleep(300);
  };
  await dm.send(t.id, "hello there", true);
  await answered(1);
  const short = state();
  const long = [
    "Snake plants are one of the easiest houseplants to keep alive. They grow upright, stiff leaves striped in dark and light green, and they put up with low light, dry air and a missed watering or three.",
    "Water one only when its soil has dried all the way down, which indoors is about every two to four weeks. More plants are lost to too much water than too little: the roots rot in wet soil, and the leaves go soft and fall over.",
    "Bright, indirect light makes them grow faster, but a dim corner is fine too. Keep them out of cold drafts in winter, and wipe the dust off the leaves now and then so they can take in the light.",
    "A pot with a hole in the bottom and a sandy, fast-draining mix keeps the roots healthy. Repot every few years, in spring, when the roots crowd the pot or the plant starts to tip it over.",
  ].join("\n\n");
  await dm.send(t.id, long, true);
  await answered(2);
  const down = state();
  box().scrollTop = 0;
  await sleep(300);
  const atStart = state();
  box().scrollTop = box().scrollHeight;
  await sleep(400);
  return { short, down, atStart, end: state() };
})();
