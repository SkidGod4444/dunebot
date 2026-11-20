/**
 * A window letting clicks through to what's under it, or taking them again (setIgnoreMouseEvents).
 *
 * On Wayland at a scale other than 100% (GNOME 49, Mutter's logical layout), the input region
 * Electron makes when a window takes clicks again never reaches GNOME: the window stayed
 * click-through for good, the answer card's buttons included (seen 2026-11-20). A new size makes
 * Electron send it, so the window is made 1 px wider and back. Each page says its scale
 * (preload.cjs, "page:scale"): Wayland doesn't tell the app which screen a window is on.
 *
 * wayland/test/app_side.mjs checks it in real Electron on GNOME 46 and 49, at 100% and 200%.
 */
const scales = new WeakMap();
const through = new WeakMap();
let watching = false;

/** Hears each page's scale. Once, before any window. */
export function watchScales(ipcMain) {
  if (watching) return;
  watching = true;
  ipcMain.on("page:scale", (e, s) => {
    if (typeof s === "number" && s > 0) scales.set(e.sender, s);
  });
}

/** `on`: clicks go through the window. `wayland`: this is a Wayland session. */
export function passClicks(w, on, opts, { wayland = false } = {}) {
  if (!w || w.isDestroyed()) return;
  w.setIgnoreMouseEvents(on, opts);
  const was = through.get(w);
  through.set(w, on);
  if (on || !wayland || was !== true || (scales.get(w.webContents) ?? 1) === 1) return;
  const [width, height] = w.getSize();
  w.setSize(width + 1, height);
  setTimeout(() => {
    if (w.isDestroyed()) return;
    const [now, h] = w.getSize();
    if (now === width + 1) w.setSize(width, h); // only our own pixel back, if nothing else resized it
  }, 60);
}
