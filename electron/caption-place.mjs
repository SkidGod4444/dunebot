// Where the answer card goes beside the pointer, as it follows it. Pure (no Electron), so it can be
// checked on its own: scripts/check_follow.mjs.
//
// The card sits below and to the right of the pointer, and keeps to that side while it fits. Near a
// screen edge it moves to the other side, and comes back only once there is clearly room again (a
// band of BACK px), so it doesn't flap from side to side while the pointer moves along an edge.

export const CARD_W = 360;
export const MAX_H = 320;
export const PAD = 16; // the window is bigger than the card by this much on each side (its shadow)
export const WIN_W = CARD_W + 2 * PAD;
export const WIN_H = MAX_H + 2 * PAD;
// From the pointer to the card's nearest edge: right of it / left of it, below it / above it.
const RIGHT_GAP = 16;
const LEFT_GAP = 12;
const BELOW_GAP = 24;
const ABOVE_GAP = 16;
const EDGE = 8; // the card keeps this far from the screen edge
const BACK = 48;

/**
 * @param {{x:number,y:number}} p pointer
 * @param {{x:number,y:number,width:number,height:number}} wa the work area of the pointer's screen
 * @param {{side:"below"|"above", align:"left"|"right"} | null} prev where it was (null: first time)
 * @returns {{x:number, y:number, side:"below"|"above", align:"left"|"right", card:{x:number,y:number,w:number,h:number}}}
 *   x, y: the window's top left; card: the card's largest possible box on screen.
 */
export function place(p, wa, prev) {
  const right = wa.x + wa.width;
  const bottom = wa.y + wa.height;
  const roomRight = right - (p.x + RIGHT_GAP + CARD_W); // spare room with the card right of the pointer
  const roomLeft = p.x - LEFT_GAP - CARD_W - wa.x;
  const roomBelow = bottom - (p.y + BELOW_GAP + MAX_H);
  const roomAbove = p.y - ABOVE_GAP - MAX_H - wa.y;

  // "left" = the card's left edge is by the pointer (it extends to the right).
  let align;
  if (!prev || prev.align === "left") align = roomRight >= EDGE || roomRight >= roomLeft ? "left" : "right";
  else align = roomRight >= EDGE + BACK || (roomLeft < EDGE && roomRight > roomLeft) ? "left" : "right";
  let side;
  if (!prev || prev.side === "below") side = roomBelow >= EDGE || roomBelow >= roomAbove ? "below" : "above";
  else side = roomBelow >= EDGE + BACK || (roomAbove < EDGE && roomBelow > roomAbove) ? "below" : "above";

  let cx = align === "left" ? p.x + RIGHT_GAP : p.x - LEFT_GAP - CARD_W;
  let cy = side === "below" ? p.y + BELOW_GAP : p.y - ABOVE_GAP - MAX_H;
  // Kept on the screen. Sideways that can't cover the pointer (the card is above or below it).
  cx = Math.max(wa.x + EDGE, Math.min(cx, right - EDGE - CARD_W));
  cy = Math.max(wa.y + EDGE, Math.min(cy, bottom - EDGE - MAX_H));
  return {
    x: Math.round(cx - PAD),
    y: Math.round(cy - PAD),
    side,
    align,
    card: { x: Math.round(cx), y: Math.round(cy), w: CARD_W, h: MAX_H },
  };
}

/** The screen's top right corner (a card waiting in a chat you didn't ask from the bar). */
export function corner(wa) {
  const cx = wa.x + wa.width - 12 - CARD_W;
  const cy = wa.y + 12;
  return { x: cx - PAD, y: cy - PAD, side: "below", align: "right", card: { x: cx, y: cy, w: CARD_W, h: MAX_H } };
}

/** Whether the pointer is on the card's box. */
export const covers = (card, p) => p.x >= card.x && p.x < card.x + card.w && p.y >= card.y && p.y < card.y + card.h;
/** Whether the card's box is inside the work area. */
export const inside = (card, wa) => card.x >= wa.x && card.y >= wa.y && card.x + card.w <= wa.x + wa.width && card.y + card.h <= wa.y + wa.height;

const MIN_MOVE = 10; // px: a smaller move is a jiggle, not a reach
const REACH = 600; // px: a card further along the line than this isn't what you're heading for

/**
 * Whether the pointer, moving from `from` to `to`, is heading into the card: the line it moves along
 * enters the card's box ahead of it. Moving along the card's side or away from it is not.
 * @param {{x:number,y:number}} from
 * @param {{x:number,y:number}} to
 * @param {{x:number,y:number,w:number,h:number}} card where the card was when the move began
 */
export function heading(from, to, card) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < MIN_MOVE) return false;
  // Where the line from `from` crosses the box, in px along it (the slab method).
  let near = 0;
  let far = REACH;
  for (const [o, d, lo, hi] of [
    [from.x, dx / len, card.x, card.x + card.w],
    [from.y, dy / len, card.y, card.y + card.h],
  ]) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return false;
      continue;
    }
    let a = (lo - o) / d;
    let b = (hi - o) / d;
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a);
    far = Math.min(far, b);
    if (near > far) return false;
  }
  return true;
}

