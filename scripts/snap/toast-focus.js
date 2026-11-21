// Permissions with a long message showing and a choice holding the keyboard: the message wraps in a
// box (it was a pill that grew into a tall oval), and the choice shows an outline in the text colour.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  dm.set({ view: "permissions" });
  const end = Date.now() + 8000;
  let radio;
  while (Date.now() < end && !(radio = document.querySelector("[role=radiogroup] [role=radio][aria-checked=true]"))) await sleep(100);
  if (!radio) return { found: false };
  radio.setAttribute("data-snapshot-focus", ""); // drawn as the keyboard shows it (electron/main.mjs)
  dm.set({ toast: "Couldn't save that: Dune Bot's core stopped answering. Quit Dune Bot from the menu bar, open it again, then pick this choice once more." });
  await sleep(400);
  const box = document.querySelector("[role=status] > div");
  const r = box?.getBoundingClientRect();
  const s = getComputedStyle(radio); // nothing drawn until the keyboard is on it
  return {
    found: true,
    outlineUnfocused: `${s.outlineStyle}`,
    toast: box ? { w: Math.round(r.width), h: Math.round(r.height), radius: getComputedStyle(box).borderTopLeftRadius, inWindow: r.left >= 0 && r.right <= innerWidth } : null,
  };
})();
