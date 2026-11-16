/**
 * What you said while the bar's chat was still answering: held, and asked by itself once that answer
 * has ended and the card has finished reading it aloud (nothing running is stopped). Said twice, the
 * two go as one question. A stopped answer, or a bar that has moved on to another chat, puts it in
 * the bar's box instead, so nothing is sent you didn't expect and nothing is lost.
 */
export type Held = { chat: string; text: string; ended?: boolean; read?: boolean } | null;
export type Step = { held: Held; send?: string; box?: string };

/** After the answer ends, the card has this long to finish reading it before the question goes. */
export const READ_WAIT_MS = 30_000;

export function hold(held: Held, chat: string, said: string): Held {
  return held && held.chat === chat ? { ...held, text: `${held.text} ${said}` } : { chat, text: said };
}

/** Asked now, unless the bar has moved to another chat (then it goes in the box). */
function release(held: NonNullable<Held>, activeId: string | null): Step {
  return activeId === held.chat ? { held: null, send: held.text } : { held: null, box: held.text };
}

/** A turn ended in `threadId` with `status`; the bar is on chat `activeId`. */
export function afterTurn(held: Held, threadId: string, status: string, activeId: string | null): Step {
  if (!held || held.chat !== threadId) return { held };
  if (status === "cancelled") return { held: null, box: held.text };
  return held.read ? release(held, activeId) : { held: { ...held, ended: true } };
}

/** The card has nothing left to read of that answer (or reads nothing). */
export function cardDone(held: Held, activeId: string | null): Step {
  if (!held) return { held };
  return held.ended ? release(held, activeId) : { held: { ...held, read: true } };
}

/** READ_WAIT_MS after the answer ended, whatever the card is doing (closed, stuck). */
export function readWaitOver(held: Held, activeId: string | null): Step {
  return held?.ended ? release(held, activeId) : { held };
}
