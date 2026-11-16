// Checks where the answer card goes as it follows the pointer (electron/caption-place.mjs): never on
// the pointer, always on the screen, and no flapping from side to side along an edge. And that moving
// toward the card holds it still (so it can be reached), while moving along it or away doesn't.
// Usage: node scripts/check_follow.mjs
import { place, covers, inside, heading } from "../electron/caption-place.mjs";

const screens = [
  { name: "MacBook 1440x900 (menu bar)", wa: { x: 0, y: 25, width: 1440, height: 875 } },
  { name: "second display to the right", wa: { x: 1440, y: -200, width: 1920, height: 1080 } },
  { name: "display to the left", wa: { x: -1280, y: 0, width: 1280, height: 1024 } },
  { name: "small 1024x768", wa: { x: 0, y: 0, width: 1024, height: 740 } },
];
let fails = 0;
const check = (cond, what) => {
  if (!cond) {
    fails++;
    if (fails < 20) console.log("FAIL", what);
  }
};

for (const { name, wa } of screens) {
  // Every pointer position (every 7 px), arriving fresh and arriving from each side.
  let n = 0;
  for (let x = wa.x; x < wa.x + wa.width; x += 7)
    for (let y = wa.y; y < wa.y + wa.height; y += 7)
      for (const prev of [null, { side: "below", align: "left" }, { side: "above", align: "right" }, { side: "below", align: "right" }, { side: "above", align: "left" }]) {
        const r = place({ x, y }, wa, prev);
        n++;
        check(!covers(r.card, { x, y }), `${name}: card on the pointer at ${x},${y} from ${JSON.stringify(prev)}`);
        check(inside(r.card, wa), `${name}: card off the screen at ${x},${y}`);
      }
  // Along each edge, jiggling ±20 px: at most one change of side per pass.
  const cx = wa.x + wa.width / 2;
  const cy = wa.y + wa.height / 2;
  const walks = [
    (t) => ({ x: wa.x + wa.width - 380 + 20 * Math.sin(t), y: cy }), // near the right edge
    (t) => ({ x: wa.x + 380 + 20 * Math.sin(t), y: cy }), // near the left edge
    (t) => ({ x: cx, y: wa.y + wa.height - 340 + 20 * Math.sin(t) }), // near the bottom
    (t) => ({ x: cx, y: wa.y + 340 + 20 * Math.sin(t) }), // near the top
  ];
  for (const [i, walk] of walks.entries()) {
    let prev = null;
    let changes = 0;
    for (let t = 0; t < 60; t += 0.2) {
      const r = place(walk(t), wa, prev);
      if (prev && (prev.side !== r.side || prev.align !== r.align)) changes++;
      prev = r;
    }
    check(changes <= 1, `${name}: walk ${i} changed side ${changes} times`);
  }
  console.log(`${fails ? "…" : "ok  "} ${name}: ${n} positions`);

  // Moving toward the card holds it (so it can be reached); along its side, away or a jiggle doesn't.
  let reach = 0;
  for (let x = wa.x + 40; x < wa.x + wa.width - 40; x += 53)
    for (let y = wa.y + 40; y < wa.y + wa.height - 40; y += 53) {
      const p = { x, y };
      const { card } = place(p, wa, null);
      const c = { x: card.x + card.w / 2, y: card.y + card.h / 2 };
      const d = Math.hypot(c.x - x, c.y - y);
      const step = (k) => ({ x: x + ((c.x - x) / d) * k, y: y + ((c.y - y) / d) * k });
      const away = { x: x - ((c.x - x) / d) * 30, y: y - ((c.y - y) / d) * 30 };
      // Along the side nearest the pointer: sideways if the card is above or below, else up or down.
      const below = card.y >= y;
      const above = card.y + card.h <= y;
      const along = below || above ? { x: x + 40, y } : { x, y: y + 40 };
      check(heading(p, step(14), card), `${name}: a move at ${x},${y} toward the card didn't hold it`);
      check(!heading(p, step(4), card), `${name}: a 4 px jiggle at ${x},${y} held the card`);
      check(!heading(p, away, card), `${name}: a move at ${x},${y} away from the card held it`);
      check(!heading(p, along, card), `${name}: a move at ${x},${y} along the card's side held it`);
      reach++;
    }
  console.log(`${fails ? "…" : "ok  "} ${name}: ${reach} moves toward, along and away from the card`);
}
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
