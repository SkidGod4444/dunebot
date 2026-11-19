import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./pointer.css";

/**
 * The highlight an agent points with when it teaches (the core's point_at; electron/pointer.mjs sizes
 * and places the window around the control): a white ring with a dark outline round the control to
 * use next, a slow pulse around it, and a small label pill below it (above it at the bottom of the
 * screen). Black and white only, the same over any app, light or dark. The window lets every click
 * through, so nothing here takes the mouse (and nothing is clickable).
 */
type Box = { x: number; y: number; width: number; height: number };
type Show = { gen: number; ring: Box; size: { width: number; height: number }; side: "below" | "above"; round: boolean; label: string };
type Bridge = { onShow: (fn: (s: Show) => void) => () => void; onHide: (fn: () => void) => () => void; drawn: (gen: number) => void };

const bridge = (window.dunebot as unknown as { pointer?: Bridge }).pointer;
/** The ring sits this far outside the control, and the label this far from the ring (pointer.mjs leaves the room). */
const OUT = 5;
const GAP = 8;
const EDGE = 4;

// See-through from the first frame: the page sits over other apps.
if (location.hash === "#pointer") document.documentElement.classList.add("pointer");

export function Pointer() {
  const [show, setShow] = useState<Show | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const pill = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!bridge) return;
    const offs = [
      bridge.onShow((s) => {
        setLeft(null);
        setShow(s);
      }),
      bridge.onHide(() => setShow(null)),
    ];
    return () => offs.forEach((off) => off());
  }, []);
  // The label centred on the ring, kept inside the window (measured before it's painted).
  useLayoutEffect(() => {
    if (!show) return;
    const w = pill.current?.offsetWidth ?? 0;
    const mid = show.ring.x + show.ring.width / 2;
    setLeft(Math.max(EDGE, Math.min(mid - w / 2, show.size.width - w - EDGE)));
  }, [show]);
  // Drawn: the app shows the window only now.
  useEffect(() => {
    if (show && left !== null) bridge?.drawn(show.gen);
  }, [show, left]);
  if (!show) return null;
  const { ring } = show;
  const box = { left: ring.x - OUT, top: ring.y - OUT, width: ring.width + 2 * OUT, height: ring.height + 2 * OUT };
  const top = show.side === "below" ? box.top + box.height + GAP : box.top - GAP;
  return (
    <div className="dm-pointer" key={show.gen} data-round={show.round ? "" : undefined}>
      <div className="dm-ring-pulse" style={box} />
      <div className="dm-ring" style={box} />
      {show.label && (
        <div ref={pill} className="dm-ring-label" data-side={show.side} style={{ left: left ?? 0, top, maxWidth: show.size.width - 2 * EDGE, visibility: left === null ? "hidden" : undefined }}>
          {show.label}
        </div>
      )}
    </div>
  );
}
