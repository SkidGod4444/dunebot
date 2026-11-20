/**
 * Shows a window once its page has painted ("ready-to-show"), or after `ms` if that never comes.
 * On Wayland a hidden window's first frame can wait on the compositor, which doesn't ask a window
 * it hasn't mapped for frames: the event can stall and the window would never appear (seen in the
 * GNOME CI job, 2026-11-19). `late` is called when the timer showed it.
 */
export function showWhenReady(win, show, { ms = 3000, late } = {}) {
  let done = false;
  const go = (timedOut) => {
    clearTimeout(timer);
    if (done || win.isDestroyed()) return;
    done = true;
    if (timedOut) late?.();
    show();
  };
  const timer = setTimeout(() => go(true), ms);
  win.once("ready-to-show", () => go(false));
  win.once("closed", () => clearTimeout(timer));
}
