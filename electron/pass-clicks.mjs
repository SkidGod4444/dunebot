// Wayland: Dune Bot's own windows during an agent's pointer step. Wayland never tells a window where
// it is on the screen, so a click can't be checked against Dune Bot's windows before it's made, as it
// is on macOS, Windows and X11. An agent must never press anything in Dune Bot (its own approval
// card least of all), so while a step runs:
//
// 1. Each window lets clicks through to what's under it (setIgnoreMouseEvents, and a frame drawn so
//    the new input region lands). On GNOME 46 that works when the pointer comes to the window from
//    elsewhere, but not when it's already on it: Mutter keeps sending it there (electron/electron#51808).
// 2. So each page also takes no mouse input at all (the shield, in preload.cjs): a press or wheel that
//    still reaches one is swallowed there and reported, and the step says so instead of claiming it.
//    GNOME may still give that window the keyboard (a plain one says so, and typing is then refused;
//    the card, never focusable, gets no keys).
//
// wayland/test/app_side.mjs checks each of these in real Electron on GNOME 46.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {Electron.IpcMain} o.ipcMain
 * @param {() => Electron.BrowserWindow[]} o.windows every Dune Bot window
 * @param {(w: Electron.BrowserWindow) => boolean} [o.ownRule] windows that set click-through themselves (the answer card)
 * @param {(w: Electron.BrowserWindow) => string} [o.name] what to call a window ("bar", "answer card")
 * @param {number} [o.settleMs] after raising, a moment for the input regions to land
 * @param {number} [o.holdMs] after the last step, how long the shield stays (its last release may still be on its way)
 */
export function createGuard({ ipcMain, windows, ownRule = () => false, name = () => "window", settleMs = 120, holdMs = 400 }) {
  let up = false;
  let seq = 0;
  let lowering = null;
  const acks = new Map();
  /** Pages known to be shielded while up: they said so, or loaded while up (and asked). */
  const shielded = new Set();
  /** @type {{ at: number, sender: Electron.WebContents }[]} */
  const hits = [];

  ipcMain.on("guard:ack", (e, n) => {
    if (up) shielded.add(e.sender);
    acks.get(n)?.(e.sender);
  });
  // A page that loads (or reloads) while up asks first, before any script of its own runs.
  ipcMain.on("guard:state", (e) => {
    if (up) shielded.add(e.sender);
    e.returnValue = up;
  });
  // Any of Dune Bot's windows (none loads another site's page); a stray one only fails a step.
  ipcMain.on("guard:hit", (e) => {
    if (!up) return;
    hits.push({ at: Date.now(), sender: e.sender });
    if (hits.length > 20) hits.shift();
  });

  const live = () => windows().filter((w) => !w.isDestroyed());
  const set = (on, n, which = live()) => {
    for (const w of which) {
      w.webContents.send("guard", on, n);
      if (!ownRule(w)) w.setIgnoreMouseEvents(on);
      // A window holding still draws nothing, and its new input region waits for a frame.
      w.webContents.invalidate();
    }
  };

  return {
    /** Before a pointer step: every page shielded (each one says so) and clicks let through. Each
     * step asks again of any page not yet heard from (a window made since). Answers what can be
     * seen and hasn't said it's shielded: the step mustn't go on then. */
    async raise() {
      clearTimeout(lowering);
      lowering = null;
      const fresh = !up;
      up = true;
      const ask = live().filter((w) => !shielded.has(w.webContents));
      if (ask.length) {
        const n = ++seq;
        const pages = new Set(ask.map((w) => w.webContents));
        const acked = new Promise((resolve) => {
          acks.set(n, (sender) => {
            pages.delete(sender);
            if (!pages.size) resolve();
          });
          setTimeout(resolve, 500);
        });
        set(true, n, ask);
        await Promise.all([acked, fresh ? sleep(settleMs) : null]);
        acks.delete(n);
      }
      return live()
        .filter((w) => w.isVisible() && !shielded.has(w.webContents))
        .map(name);
    },
    /** After the last pointer step: back to normal, a moment later. */
    lower() {
      clearTimeout(lowering);
      lowering = setTimeout(() => {
        lowering = null;
        up = false;
        shielded.clear();
        set(false, 0);
      }, holdMs);
    },
    /** The Dune Bot window a press reached since `since` (ms), if one did. Waits a moment first:
     * the page hears of a press a little after the step that made it returns. */
    async hitSince(since) {
      await sleep(250);
      const h = hits.find((x) => x.at >= since);
      if (!h) return null;
      const w = live().find((x) => x.webContents === h.sender);
      return w ? name(w) : "window";
    },
  };
}
