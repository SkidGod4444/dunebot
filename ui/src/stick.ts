import { useEffect, useRef, type RefObject } from "react";

/**
 * Keeps a scroll area on its newest line while you are there, also when a reply grows a little
 * every frame (smooth.ts) without anything else changing. Scroll up and it stays where you are.
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, deps: unknown[]) {
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const toEnd = () => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    };
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    const mo = new MutationObserver(toEnd);
    mo.observe(el, { subtree: true, childList: true, characterData: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    toEnd();
    return () => {
      mo.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, deps);
  return stick;
}
