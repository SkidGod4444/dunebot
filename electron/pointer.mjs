// The highlight an agent points with when it teaches (the core's point_at and clear_pointer, sent as
// `input.do` kinds "point" and "unpoint"): a white ring with a short label around the control the
// user should use next, in a window of its own (ui/src/Pointer.tsx draws it). The window is
// see-through, always on top, never focusable and always click-through (setIgnoreMouseEvents without
// forwarding), so the user's clicks, and Dune Bot's own, go straight through it to the app under it.
// main.mjs keeps it out of pictures of the screen (whileHidden) and out of its own-window check (is).
//
// Wayland doesn't let an app put a window where it wants, so pointing isn't available there and no
// window is ever made (the click guard in pass-clicks.mjs waits to hear from every window).
//
// It goes when the agent points again or clears it, when another chat starts a turn, when its chat
// is stopped or deleted, when every agent is stopped, or when the core says its time is up.

/** Room the page needs around the box: the ring sits 5 px outside it and its pulse grows 14 px more. */
const PAD = 24;
/** The label pill below (or above) the ring: the gap, the pill's height, and the narrowest window. */
const LABEL_GAP = 8;
const LABEL_H = 28;
const LABEL_W = 300;

const WAYLAND =
  "Pointing at things on the screen isn't available on this desktop: Wayland doesn't let apps put a window where they choose. Tell the user where it is in words instead (\"the gear icon at the top right\").";

/**
 * Where the highlight's window goes for a box on the screen (both in screen points) on a display
 * whose bounds are `bounds`: around the box with room for the pulse and the label (below the box, or
 * above it at the bottom of the display), kept on that display. `ring` is the box inside the window.
 */
export function layout(box, bounds) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const side = box.y + box.height + PAD + LABEL_GAP + LABEL_H <= bounds.y + bounds.height ? "below" : "above";
  const width = Math.min(Math.max(Math.ceil(box.width) + 2 * PAD, LABEL_W), bounds.width);
  const height = Math.min(Math.ceil(box.height) + 2 * PAD + LABEL_GAP + LABEL_H, bounds.height);
  const x = Math.round(clamp(box.x + box.width / 2 - width / 2, bounds.x, bounds.x + bounds.width - width));
  const top = side === "below" ? box.y - PAD : box.y - PAD - LABEL_GAP - LABEL_H;
  const y = Math.round(clamp(top, bounds.y, bounds.y + bounds.height - height));
  return { win: { x, y, width, height }, ring: { x: box.x - x, y: box.y - y, width: box.width, height: box.height }, side };
}

/**
 * @param {object} o
 * @param {typeof import("electron").BrowserWindow} o.BrowserWindow
 * @param {Electron.Screen} o.screen
 * @param {Electron.IpcMain} o.ipcMain
 * @param {(hash: string) => string} o.pageUrl
 * @param {object} o.webPreferences
 * @param {(w: Electron.BrowserWindow) => void} o.harden
 * @param {string} o.platform
 * @param {boolean} o.wayland
 * @param {boolean} o.snapshot a hidden-window run: the window is never shown
 * @param {(...a: any[]) => void} o.log
 * @param {(method: string, params: object) => Promise<any>} o.call the core
 * @param {number} [o.hideMs] after hiding for a picture, a moment for the screen to lose it
 * @param {number} [o.drawnMs] how long the page may take to draw the ring
 */
export function createPointer({ BrowserWindow, screen, ipcMain, pageUrl, webPreferences, harden, platform, wayland, snapshot, log, call, hideMs = 90, drawnMs = 2000 }) {
  let win = null;
  // The highlight as the core asked for it: up (asked for), drawn (the page has drawn it), which
  // request it is (the core's count) and the chat that asked.
  let up = false;
  let drawn = false;
  let gen = 0;
  let owner = null;
  let holds = 0; // pictures being taken: the window stays hidden meanwhile
  const acks = new Map();

  ipcMain.on("pointer:drawn", (e, n) => {
    if (win && !win.isDestroyed() && e.sender === win.webContents) acks.get(Number(n))?.();
  });

  function ensure() {
    if (win && !win.isDestroyed()) return win;
    const mac = platform === "darwin";
    win = new BrowserWindow({
      width: LABEL_W,
      height: 2 * PAD + LABEL_GAP + LABEL_H,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false, // the page draws its own
      alwaysOnTop: true,
      focusable: false,
      ...(mac ? { type: "panel" } : {}),
      // It draws while hidden (it's shown once the ring is drawn).
      webPreferences: { ...webPreferences, backgroundThrottling: false },
    });
    if (mac) {
      // Above the menu bar and the Dock too, so a ring can go round their items; on every Space.
      win.setAlwaysOnTop(true, "pop-up-menu");
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    }
    // Always click-through, nothing forwarded: the page never sees the mouse.
    win.setIgnoreMouseEvents(true);
    // Windows leaves it out of every capture. macOS's ScreenCaptureKit ignores this (Electron's docs
    // say so), hence whileHidden as well.
    if (mac || platform === "win32") win.setContentProtection(true);
    harden(win);
    win.loadURL(pageUrl("pointer"));
    return win;
  }

  /** Shown exactly while a ring is asked for, drawn, and no picture is being taken. Never in a test run. */
  function sync() {
    if (!win || win.isDestroyed() || snapshot) return;
    const want = up && drawn && holds === 0;
    if (want && !win.isVisible()) win.showInactive();
    else if (!want && win.isVisible()) win.hide();
  }

  async function point(m) {
    if (wayland) throw new Error(WAYLAND);
    const [x, y, width, height] = ["x", "y", "width", "height"].map((k) => Number(m[k]));
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error("Dune Bot couldn't point there: no place was given.");
    const label = String(m.label ?? "").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    const n = Number(m.gen) || 0;
    const box = { x, y, width, height };
    // The display that holds the middle of the box.
    const d = screen.getDisplayNearestPoint({ x: Math.round(x + width / 2), y: Math.round(y + height / 2) });
    const at = layout(box, d.bounds);
    const w = ensure();
    if (w.webContents.isLoading()) await new Promise((r) => w.webContents.once("did-finish-load", r));
    up = true;
    drawn = false;
    gen = n;
    owner = typeof m.threadId === "string" ? m.threadId : null;
    sync(); // an older ring goes while this one is placed and drawn
    w.setBounds(at.win);
    const ok = await new Promise((resolve) => {
      const t = setTimeout(() => (acks.delete(n), resolve(false)), drawnMs);
      acks.set(n, () => (clearTimeout(t), acks.delete(n), resolve(true)));
      w.webContents.send("pointer:show", { gen: n, ring: at.ring, size: { width: at.win.width, height: at.win.height }, side: at.side, round: !!m.round, label });
    });
    if (!up || gen !== n) return; // cleared or replaced meanwhile
    if (!ok) {
      up = false;
      throw new Error("Dune Bot couldn't draw the highlight. Tell the user where it is in words instead.");
    }
    drawn = true;
    sync();
    // Numbers only: the label is the agent's words about the screen.
    const r = (v) => Math.round(v);
    log(`pointer: shown, ring ${r(x)},${r(y)} ${r(width)}x${r(height)} in window ${at.win.x},${at.win.y} ${at.win.width}x${at.win.height}`);
  }

  function clear(why) {
    if (!up) return;
    up = false;
    drawn = false;
    if (win && !win.isDestroyed()) win.webContents.send("pointer:hide");
    sync();
    log(`pointer: hidden (${why})`);
  }

  /** The core's point and unpoint requests; anything else isn't ours. */
  function forCore(m) {
    if (m.kind !== "point" && m.kind !== "unpoint") return false;
    const answer = (error) => call("input.result", { requestId: m.requestId, ...(error ? { error } : {}) }).catch(() => {});
    const run = m.kind === "point" ? point(m) : Promise.resolve(clear("the agent took it away"));
    run.then(
      () => answer(),
      (e) => {
        log(`pointer: ${e.message}`);
        answer(e.message);
      },
    );
    return true;
  }

  return {
    /** Whether `w` is the highlight's window (it lets every click through). */
    is: (w) => !!win && w === win,
    /** Whether `w` is the highlight's window and a ring is up (shown, or about to be). */
    up: (w) => !!win && w === win && up,
    /** Core events: answers true for the ones that are only the highlight's. */
    onCoreEvent(m) {
      switch (m.event) {
        case "input.do":
          return forCore(m);
        case "pointer.clear":
          if (up && Number(m.gen) === gen) clear("its time was up");
          return true;
        case "turn.started":
          if (up && m.threadId !== owner) clear("another chat started");
          return false;
        case "turn.ended":
          if (up && m.status === "cancelled" && m.threadId === owner) clear("its chat was stopped");
          return false;
        case "thread.deleted":
          if (up && m.id === owner) clear("its chat was deleted");
          return false;
        default:
          return false;
      }
    },
    /** Takes a picture of the screen without the ring in it: hidden meanwhile, back after. */
    async whileHidden(take) {
      if (!up) return take();
      holds++;
      const wasShown = !!win && !win.isDestroyed() && win.isVisible();
      sync();
      if (wasShown) await new Promise((r) => setTimeout(r, hideMs));
      log("pointer: hidden while a picture of the screen is taken");
      try {
        return await take();
      } finally {
        holds--;
        sync();
      }
    },
    clear,
    /** The window (made hidden if there's none yet): the snapshot suite draws it. */
    window: ensure,
  };
}
