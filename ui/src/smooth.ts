import { useEffect, useRef, useState } from "react";

/**
 * Shows a streaming reply at a steady pace. Agents send text in bursts (Claude Code: about a
 * hundred characters every half second), which reads as jumps. This shows the text at the rate it
 * has been arriving, faster when it falls behind, so a burst flows out over the time until the next
 * one. It is never much more than half a second behind, and a finished reply catches up within a
 * quarter second. A reply that was already there when the bubble appeared shows at once.
 *
 * `onDone` gets numbers only (never text): how many updates arrived, how many frames changed what
 * you see, and the longest pause between those frames while it streamed.
 */
export function useSmoothText(text: string, streaming: boolean, onDone?: (stats: StreamStats) => void): string {
  const [shown, setShown] = useState(text.length);
  const s = useRef({
    shown: text.length,
    text,
    streaming,
    first: 0, // when the first new text arrived
    firstLen: text.length,
    frame: 0,
    last: 0,
    stats: { updates: 0, frames: 0, longestGapMs: 0, chars: 0 },
    lastChange: 0,
    reported: !streaming,
  });
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const st = s.current;
    if (text.length > st.text.length) {
      st.stats.updates++;
      if (!st.first) {
        st.first = performance.now();
        st.firstLen = st.text.length;
      }
    }
    if (!text.startsWith(st.text.slice(0, st.shown))) st.shown = text.length; // replaced, not added to: show it as it is
    st.text = text;
    st.streaming = streaming;
    if (streaming) st.reported = false;
    if (st.shown >= text.length) {
      if (st.shown !== shown) setShown(st.shown);
      report(st);
      return;
    }
    if (st.frame) return;
    st.last = performance.now();
    const step = (now: number) => {
      // Real time, so slow frames (or a hidden window's paused ones) catch up instead of lagging.
      const dt = Math.min(0.5, (now - st.last) / 1000);
      st.last = now;
      const backlog = st.text.length - st.shown;
      const elapsed = st.first ? Math.max(0.25, (now - st.first) / 1000) : 1;
      const arriving = (st.text.length - st.firstLen) / elapsed; // characters a second so far
      // A little under the arrival rate, so a burst lasts until the next one instead of pausing.
      const speed = Math.max(40, 0.85 * arriving, backlog / (st.streaming ? 0.6 : 0.25));
      let next = Math.min(st.text.length, st.shown + Math.max(1, Math.round(speed * dt)));
      const c = st.text.charCodeAt(next - 1);
      if (c >= 0xd800 && c <= 0xdbff && next < st.text.length) next++; // keep emoji whole
      if (next !== st.shown) {
        if (st.lastChange && st.streaming) st.stats.longestGapMs = Math.max(st.stats.longestGapMs, Math.round(now - st.lastChange));
        st.lastChange = now;
        st.stats.frames++;
        st.shown = next;
        setShown(next);
      }
      if (st.shown < st.text.length) st.frame = requestAnimationFrame(step);
      else {
        st.frame = 0;
        report(st);
      }
    };
    st.frame = requestAnimationFrame(step);
  }, [text, streaming]);

  function report(st: typeof s.current) {
    if (st.streaming || st.reported || st.shown < st.text.length) return;
    st.reported = true;
    st.stats.chars = st.text.length;
    if (st.stats.updates > 0) done.current?.({ ...st.stats });
  }

  useEffect(
    () => () => {
      cancelAnimationFrame(s.current.frame);
      s.current.frame = 0;
    },
    [],
  );

  return text.slice(0, Math.min(shown, text.length));
}

export type StreamStats = { updates: number; frames: number; longestGapMs: number; chars: number };
