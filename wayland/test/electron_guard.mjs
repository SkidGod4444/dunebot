// Real Electron on GNOME's Wayland session, run by app_side.mjs. Checks what only Electron can show:
// Dune Bot's own-window guard (electron/pass-clicks.mjs with the real preload.cjs: a click never
// presses anything in Dune Bot's windows, a plain one and a card like the answer card), a picture through nativeImage.createFromBitmap (the
// helper's BGRA order), and a second launch's arguments (`--stop`) reaching the running app.
// Commands come as JSON lines on stdin (the saved OK first, never in argv or env); events go out
// on stdout. Test-only.
//
// usage: electron --ozone-platform=wayland electron_guard.mjs --helper=<dunebot-wayland>
import { app, BrowserWindow, ipcMain, nativeImage } from "electron";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWayland } from "../../electron/wayland.mjs";
import { createInput } from "../../electron/input.mjs";
import { createGuard } from "../../electron/pass-clicks.mjs";
import { showWhenReady } from "../../electron/show-when-ready.mjs";
import { passClicks, watchScales } from "../../electron/click-through.mjs";

const PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../electron/preload.cjs");

const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
// A second launch hands its arguments to this one and ends, as Dune Bot's does.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on("second-instance", (_e, argv) => say({ second_instance: argv.filter((a) => a === "--stop" || a === "--bar") }));

const helper = process.argv.find((a) => a.startsWith("--helper="))?.slice(9);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wl = null;
let input = null;

function page(title, colour) {
  const html = `<!doctype html><title>${title}</title><body style="margin:0;height:100vh;background:${colour}" onmousedown="console.log('page-click')" onclick="console.log('page-click')" onwheel="console.log('page-wheel')" onkeydown="console.log('page-key')"></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
function makeWindow(title, colour, o) {
  const w = new BrowserWindow({ title, frame: false, backgroundColor: colour, show: false, webPreferences: { sandbox: true, contextIsolation: true, preload: PRELOAD }, ...o });
  w.on("page-title-updated", (e) => e.preventDefault());
  w.webContents.on("console-message", (e, _level, message) => {
    const text = e?.message ?? message;
    if (text === "page-click") say({ page_click: title });
    if (text === "page-wheel") say({ page_wheel: title });
    if (text === "page-key") say({ page_key: title });
  });
  w.loadURL(page(title, colour));
  return w;
}

// As main.mjs makes it, before any window (each page asks it as it loads). The card has its own
// click-through rule, set around the step below.
let win = null;
let card = null;
watchScales(ipcMain); // as main.mjs, before any window
const guard = createGuard({ ipcMain, windows: () => [win, card].filter(Boolean), ownRule: (w) => w === card, name: (w) => w.getTitle() });

app.whenReady().then(async () => {
  // A plain window (the bar, the chats window) and one like the answer card (never focused).
  win = makeWindow("dunebot-guard", "#ff0000", { width: 480, height: 320 });
  card = makeWindow("dunebot-card", "#00ff00", { width: 300, height: 200, focusable: false, alwaysOnTop: true });
  // Shown as main.mjs shows its windows: once painted, or after 3 s if GNOME never lets them paint.
  const late = [];
  await Promise.all(
    [
      [win, () => win.show()],
      [card, () => card.showInactive()],
    ].map(([w, show]) => new Promise((r) => showWhenReady(w, () => (show(), r()), { late: () => late.push(w.getTitle()) }))),
  );
  await sleep(800);
  say({ ready: true, late });

  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    try {
      if (m.token) {
        let t = m.token;
        wl = createWayland({ binary: helper, log: (...a) => say({ log: a.join(" ") }), token: { load: () => t, save: (n) => (t = n), forget: () => (t = null) }, onStopped: () => say({ stopped: true }) });
        input = createInput({
          addon: () => wl.addon,
          screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ scaleFactor: 1 }) },
          platform: "wayland",
          refuseOwn: () => {},
          refuseKeyboard: () => {},
          needAccess: () => {},
          cancelled: () => false,
          stub: () => false,
        });
        await wl.ensure({ wait: true });
        say({ open: true });
      } else if (m.click) {
        // As main.mjs's inputForCore does around a pointer step: the card's own rule, then the guard.
        let deaf = [];
        if (m.guard) {
          passClicks(card, true, { forward: true }, { wayland: true });
          deaf = await guard.raise();
        }
        const since = Date.now();
        let error = null;
        try {
          await input.clickAt({ x: m.click[0], y: m.click[1], requestId: String(Date.now()) });
        } catch (e) {
          error = e.message;
        }
        let hit = null;
        if (m.guard) {
          passClicks(card, false, undefined, { wayland: true });
          guard.lower();
          hit = await guard.hitSince(since);
        }
        await sleep(700);
        say({ clicked: m.click, error, hit, deaf });
      } else if (m.park) {
        // The pointer moved there and left (no click), as a user's or an earlier step's would be.
        await wl.addon.pointerGlide(m.park[0], m.park[1], false, () => false);
        await sleep(500);
        say({ parked: m.park });
      } else if (m.focus) {
        say({ focused: BrowserWindow.getFocusedWindow()?.getTitle() ?? null });
      } else if (m.key) {
        // A key step as an agent's would go, but not refused here: what the keyboard reaches.
        const focused = BrowserWindow.getFocusedWindow()?.getTitle() ?? null;
        let error = null;
        try {
          await input.pressKeys({ key: m.key, mods: [], times: 1, requestId: String(Date.now()) });
        } catch (e) {
          error = e.message;
        }
        await sleep(600);
        say({ keyed: m.key, focused, error });
      } else if (m.scroll) {
        // A scroll over Dune Bot's window while guarded: swallowed (wheel listened for only now).
        await guard.raise();
        const since = Date.now();
        let error = null;
        try {
          await input.scrollAt({ x: m.scroll[0], y: m.scroll[1], dx: 0, dy: -1, notches: 2, requestId: String(Date.now()) });
        } catch (e) {
          error = e.message;
        }
        guard.lower();
        const hit = await guard.hitSince(since);
        await sleep(700);
        say({ scrolled: m.scroll, error, hit });
      } else if (m.pixel) {
        // As main.mjs's takeScreenshot: the helper's BGRA into a nativeImage, then JPEG.
        const f = await wl.frame();
        const img = nativeImage.createFromBitmap(f.data.subarray(0, f.width * f.height * 4), { width: f.width, height: f.height });
        // The point is in the desktop's coordinates; the picture's pixels may be more (200%).
        const k = f.width / f.display.width;
        const at = { x: Math.round((m.pixel[0] - f.display.x) * k), y: Math.round((m.pixel[1] - f.display.y) * k) };
        const px = [...img.crop({ ...at, width: 1, height: 1 }).toBitmap()];
        say({ pixel: px, size: img.getSize(), jpeg: img.toJPEG(75).length });
      } else if (m.quit) {
        wl?.quit();
        await sleep(300);
        app.exit(0);
      }
    } catch (e) {
      say({ error: e.message });
    }
  }
});
