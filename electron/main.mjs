// Thin shell: starts the Rust core, passes calls and events between it and the windows, and
// owns nothing else. Every decision (what an agent may do, approvals, storage) is in the core.
//
// Dune Bot has no main window. It lives in the menu bar (tray); a hotkey opens a small floating
// bar next to the pointer. The full chat history opens from the tray menu when wanted. On first
// launch (and whenever macOS has forgotten a permission) a setup window asks for everything at once.
import {
  app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, screen, shell, systemPreferences, Tray,
} from "electron";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { place as placeCaption, corner as captionCorner, covers, inside, heading, WIN_W as CAPTION_W, WIN_H as CAPTION_H } from "./caption-place.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
// What the pages are told (snapshots can render another system's version of them).
const pagePlatform = (process.env.DUNEBOT_SNAPSHOT && process.env.DUNEBOT_SNAPSHOT_PLATFORM) || process.platform;
// Which permissions each system asks the user for. Others have nothing to allow.
const ASKS = {
  darwin: { mic: true, notifications: true, folders: true, screen: true },
  win32: { mic: true, notifications: false, folders: false, screen: false },
  linux: { mic: false, notifications: false, folders: false, screen: false },
};
const asks = () => ASKS[pagePlatform] ?? ASKS.linux;
const exe = isWin ? ".exe" : "";
const devUrl = process.env.DUNEBOT_DEV_URL;
const snapshot = process.env.DUNEBOT_SNAPSHOT;
const snapView = process.env.DUNEBOT_SNAPSHOT_VIEW ?? "main";
const pageFile = path.join(root, "dist", "ui", "index.html");
const pageUrl = (hash) => (devUrl ?? pathToFileURL(pageFile).href) + "#" + hash;

const stamp = () => {
  const d = new Date();
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};
const log = (...a) => console.log(stamp(), "dunebot:", ...a);

// Linux on Wayland: apps only get global keys through the desktop's shortcut portal (the desktop
// asks the user once). On X11 this changes nothing.
const wayland = process.platform === "linux" && (process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY);
if (wayland) app.commandLine.appendSwitch("enable-features", "GlobalShortcutsPortal");

// `DUNEBOT_SELFCHECK=1`: checks a build has what it needs (pages, core, addon, glass package,
// codemax), prints one "selfcheck {...}" line and quits. No windows, tray, keys or permission asks.
const selfcheck = process.env.DUNEBOT_SELFCHECK === "1";
// Snapshots and self-checks never touch your data: the core and Electron each get a temp folder.
if (snapshot || selfcheck) {
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "dunebot-electron-")));
  if (selfcheck && !process.env.DUNEBOT_DATA_DIR) process.env.DUNEBOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dunebot-check-"));
}

// One Dune Bot per user: a second launch just opens the bar. (Where global keys are blocked, a
// keyboard shortcut in the system's settings that starts Dune Bot does the same.)
if (!snapshot && !selfcheck && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

function newest(files) {
  return files.filter((f) => fs.existsSync(f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function coreBinary() {
  if (process.env.DUNEBOT_CORE) return process.env.DUNEBOT_CORE;
  if (app.isPackaged) return path.join(process.resourcesPath, "core", `dunebot-core${exe}`);
  return newest(["release", "debug"].map((p) => path.join(root, "core", "target", p, `dunebot-core${exe}`)));
}

function codemaxBinary() {
  if (process.env.DUNEBOT_CODEMAX) return process.env.DUNEBOT_CODEMAX;
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, "codemax", `codemax${exe}`)
    : path.join(root, "..", "codemax-cli", "dist", `codemax${exe}`);
  return fs.existsSync(bundled) ? bundled : undefined;
}

// ---------- core process ----------
let core = null;
let nextId = 1;
const pending = new Map();

function broadcast(msg) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("core:event", msg);
}

/** An event made here (not by the core) that windows and the tray should see like a core event. */
function emit(m) {
  broadcast(m);
  onCoreEvent(m);
}

function startCore() {
  const bin = coreBinary();
  if (!bin || !fs.existsSync(bin)) {
    if (selfcheck) {
      console.log(`selfcheck ${JSON.stringify({ ok: false, core: `missing: ${bin}` })}`);
      return app.exit(1);
    }
    dialog.showErrorBox("Dune Bot", "The Dune Bot core is missing. Run `bun run core` first.");
    app.exit(1);
    return;
  }
  const env = { ...process.env };
  delete env.DUNEBOT_SARVAM_ENV; // a developer's one-time import (below); agents inherit the core's env
  // macOS: the core listens for the ⌥⌘ chord (tap opens the bar, hold talks).
  if (isMac && !snapshot && !selfcheck) env.DUNEBOT_CHORD = "1";
  const cm = codemaxBinary();
  if (cm) env.DUNEBOT_CODEMAX = cm;
  core = spawn(bin, [], { env, stdio: ["pipe", "pipe", "inherit"] });
  createInterface({ input: core.stdout }).on("line", (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && ("result" in m || "error" in m)) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if ("error" in m) p.reject(new Error(String(m.error)));
      else p.resolve(m.result);
    } else if (m.event === "voice.audio" || m.event === "voice.stream") {
      // Streamed speech: for the card only (it's the one reading aloud), never logged.
      if (caption && !caption.isDestroyed()) caption.webContents.send("core:event", m);
      if (m.event === "voice.stream" && m.state === "error") log("voice stream stopped with an error");
    } else if (m.event) {
      broadcast(m);
      onCoreEvent(m);
    }
  });
  core.on("exit", (code) => {
    for (const p of pending.values()) p.reject(new Error("the core stopped"));
    pending.clear();
    core = null;
    broadcast({ event: "core.exit", code });
  });
}

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!core) return reject(new Error("the core is not running"));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    core.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

// The windows may only use these. They send ids and choices; the core checks everything.
const ALLOWED = new Set([
  "hello", "threads.list", "threads.create", "threads.get", "threads.delete", "threads.send",
  "threads.cancel", "threads.changes", "threads.undo", "agents.stopAll", "fixes.list", "fixes.add", "fixes.set", "fixes.delete",
  "schedules.list", "schedules.add", "schedules.set", "schedules.delete", "schedules.run", "approvals.respond", "settings.get", "settings.set", "prefs.set", "agents.list", "ledger.list",
  "voice.status", "voice.start", "voice.stop", "voice.cancel", "voice.say",
  "voice.streamOpen", "voice.streamSay", "voice.streamClose",
]);

function fromOurPage(e) {
  const url = e.senderFrame?.url ?? "";
  return devUrl ? url.startsWith(devUrl) : url.startsWith(pathToFileURL(path.join(root, "dist", "ui")).href);
}

ipcMain.handle("core:call", (e, method, params) => {
  if (!fromOurPage(e)) throw new Error("refused");
  // Snapshots only: every call a page makes, by name (scripts/check_reply_live.mjs reads them).
  if (snapshot && process.env.DUNEBOT_SNAPSHOT_CALLS === "1") console.log(`page call: ${String(method)}`);
  if (!ALLOWED.has(method)) throw new Error(`"${method}" isn't available to the window`);
  if (method === "voice.start") return startVoice("button");
  if (method === "voice.say") return sayWithSarvam(params?.text);
  if (method === "voice.streamOpen") return sarvamReady().then(() => call("voice.streamOpen", {}));
  if (method === "voice.streamSay") return sayStreamed(params?.stream, params?.text);
  return call(method, params ?? {});
});

ipcMain.handle("pick-folder", async (e) => {
  if (!fromOurPage(e)) throw new Error("refused");
  const w = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(w, { properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.on("open-main", (e, view) => {
  if (fromOurPage(e)) openMain(typeof view === "string" && /^(chat|new|settings|activity|thread:[0-9a-f]{32})$/.test(view) ? view : "chat");
});

// ---------- shared window setup ----------
const webPreferences = {
  preload: path.join(here, "preload.cjs"),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: true,
};

// A link in a reply that the system may open: a web page (the browser) or an email address (a new
// mail, never sent by itself). Anything else does nothing.
const OPENABLE = /^(https?:\/\/|mailto:)/i;

function harden(win) {
  // Model output is untrusted: links never navigate a window; web and mail links go to the system.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (OPENABLE.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.split("#")[0] !== win.webContents.getURL().split("#")[0]) {
      e.preventDefault();
      if (OPENABLE.test(url)) shell.openExternal(url);
    }
  });
}

// ---------- the look: Liquid Glass on macOS 26+ ----------
// The glass is Apple's own NSGlassEffectView, added under each window's page by the
// `electron-liquid-glass` package, in one of Apple's glass styles (you pick it in the menu bar).
// It follows the system's light/dark setting like any native view. Older macOS: the system blur.
// Other systems, and snapshots: the page draws plain cards.
const nodeRequire = createRequire(import.meta.url);
const addon = (() => {
  if (!isMac || snapshot) return null;
  try {
    return nodeRequire(path.join(root, "native", "dunebot_native.node")); // notification permission, appearance
  } catch (e) {
    log("native addon not loaded:", e.message);
    return null;
  }
})();
const liquidGlass = (() => {
  if (!isMac || snapshot) return null;
  try {
    const m = nodeRequire("electron-liquid-glass");
    return m.default ?? m;
  } catch (e) {
    log("glass package not loaded:", e.message);
    return null;
  }
})();
// Darwin 25 is macOS 26, the first with Liquid Glass (older systems get the package's blur instead).
const glassOS = isMac && Number(os.release().split(".")[0]) >= 25;
// The bar and setup: Apple's Control Center glass, dark (Dune Bot is always dark) and tinted 85%
// toward the page's dark colour. The page paints its own solid fill over it (styles.css, `--dm-fill`),
// so nothing behind shows through; the glass only adds its lit edge.
const GLASS_STYLE = "controlCenter";
const GLASS_TINT = 0.85;
function tintGlass(win, spec) {
  if (!spec.tint || !addon) return;
  addon.setGlassTint(win.getNativeWindowHandle(), GLASS_TINT, nativeTheme.shouldUseDarkColors);
}
const glassOf = new WeakMap(); // window → how its glass was made (to redo it with a new radius or style)

/** Puts glass under `win`'s page (again, if it had some). Returns "glass", or "" if there's none. */
function applyGlass(win, spec) {
  if (!liquidGlass || !glassOS) return "";
  const style = typeof spec.style === "function" ? spec.style() : spec.style;
  try {
    const id = liquidGlass.addView(win.getNativeWindowHandle(), { cornerRadius: spec.radius, opaque: !!spec.opaque });
    if (id < 0) return "";
    liquidGlass.unstable_setVariant(id, liquidGlass.GlassMaterialVariant[style] ?? 0);
    addon?.setGlassRadius(win.getNativeWindowHandle(), spec.radius);
    tintGlass(win, spec);
    const before = glassOf.get(win);
    if (!before || before.loggedStyle !== style) {
      // Read back what macOS made of it: the styles are Apple-internal and can vanish in an update.
      const got = addon ? addon.glassInfo(win.getNativeWindowHandle()) : "no read-back";
      log(`${spec.name}: liquid glass, asked for ${style} style; ${got}`);
    }
    glassOf.set(win, { ...spec, loggedStyle: style });
    if (isMac) win.invalidateShadow();
    return "glass";
  } catch (e) {
    log(`${spec.name}: no glass (${e.message})`);
    return "";
  }
}

// The page sets the glass's corner radius (a capsule when the bar is just its input row).
ipcMain.on("glass:radius", (e, radius) => {
  if (!fromOurPage(e)) return;
  const win = BrowserWindow.fromWebContents(e.sender);
  const spec = win && glassOf.get(win);
  // 24 with replies, up to 30 as a capsule.
  const r = Math.max(0, Math.min(30, Math.round(Number(radius) || 0)));
  if (!spec || spec.radius === r) return;
  // In place when we can; the package itself can only make a new glass view.
  if (addon?.setGlassRadius(win.getNativeWindowHandle(), r)) {
    glassOf.set(win, { ...spec, radius: r });
    win.invalidateShadow();
  } else applyGlass(win, { ...spec, radius: r });
});

/** Gives `win` its look once its page has loaded (the glass package wants the page there first),
 * tells the page, then reads back what the page did so the log shows a page that didn't follow. */
function setLook(win, spec, fallbackVibrancy, onMaterial) {
  win.webContents.on("did-finish-load", async () => {
    let material = snapshot ? process.env.DUNEBOT_SNAPSHOT_MATERIAL ?? "none" : "none";
    if (isMac && !snapshot) {
      material = applyGlass(win, spec);
      if (!material && fallbackVibrancy) {
        win.setVibrancy(fallbackVibrancy);
        material = "vibrancy";
      }
    }
    onMaterial?.(material);
    win.webContents.send("look", { material, standin: !!snapshot && material !== "none" });
    if (snapshot) return;
    await new Promise((r) => setTimeout(r, 400));
    try {
      const page = await win.webContents.executeJavaScript(
        `({ material: document.documentElement.dataset.material, dark: matchMedia("(prefers-color-scheme: dark)").matches,
            body: getComputedStyle(document.body).backgroundColor,
            fill: getComputedStyle(document.querySelector(".dm-card, .dm-sidebar") ?? document.getElementById("root")).backgroundColor })`,
      );
      const native = addon ? addon.windowAppearance(win.getNativeWindowHandle()) : "?";
      log(`${spec.name}: page material=${page.material} dark=${page.dark} body=${page.body} fill=${page.fill}; window ${native}; dark=${nativeTheme.shouldUseDarkColors}`);
    } catch {}
  });
}

/** Reapplies the tint after a light/dark switch (macOS can reset it when the system mode changes). */
function refreshGlass() {
  for (const w of [bar, setupWin]) {
    const spec = w && !w.isDestroyed() && glassOf.get(w);
    if (spec) tintGlass(w, spec);
  }
}

const PAPER = () => (nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#ffffff");
// The bar and setup's colour drawn solid where there's no glass (the same dark as everything else).
const GLASS_PAPER = PAPER;
// Windows/Linux: no system title bar on the history window (like macOS); its buttons sit top right.
const titleBarOverlay = () => ({ color: PAPER(), symbolColor: nativeTheme.shouldUseDarkColors ? "#f2f2f2" : "#121212", height: 55 });

// ---------- the bar ----------
// On glass the window is exactly the bar; without, the page draws a card with room for its shadow.
let barMaterial = snapshot ? process.env.DUNEBOT_SNAPSHOT_MATERIAL ?? "none" : isMac ? "glass" : "none";
const barWidth = () => (barMaterial === "none" ? 620 : 596);
const barPad = () => (barMaterial === "none" ? 12 : 0); // the page's padding around its card
let bar = null;
let barOpenedByUser = false; // vs. popped up by itself (approval, voice)
let barForVoice = false;
let barShownAt = 0;
// Where the bar opens when you ask for it (tap ⌥⌘, hold to talk, the menu). Set in the menu bar.
const BAR_PLACES = [
  ["bottom", "Bottom center"],
  ["top", "Top center"],
  ["pointer", "Next to the pointer"],
];
const barPlace = () => (BAR_PLACES.some(([k]) => k === prefs["bar.place"]) ? prefs["bar.place"] : "bottom");
// The keys that tap (open the bar) and hold (talk) on macOS; the core watches them (core/src/keys.rs).
// Other apps may claim ⌥⌘ too (HeyClicky, Grok Bot), so it's a choice.
const KEYS = [
  ["opt-cmd", "⌥⌘"],
  ["ctrl-opt", "⌃⌥"],
  ["ctrl-cmd", "⌃⌘"],
  ["right-cmd", "Right ⌘"],
];
const keysName = () => (KEYS.some(([k]) => k === prefs["keys.chord"]) ? prefs["keys.chord"] : "opt-cmd");
const keysLabel = () => KEYS.find(([k]) => k === keysName())[1];
function setKeys(name) {
  savePref("keys.chord", name).then(() => {
    broadcast({ event: "prefs.updated", prefs });
    log(`keys: ${keysLabel()}`);
    refreshTray();
  });
}
let barAnchor = "top"; // the edge that stays put when the bar grows: "bottom" grows it upward
function setBarPlace(where) {
  savePref("bar.place", where).then(() => {
    if (bar && !bar.isDestroyed() && bar.isVisible() && barOpenedByUser) placeBar(where);
    refreshTray();
  });
}

function createBar() {
  bar = new BrowserWindow({
    width: barWidth(),
    height: 76,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: isMac && !snapshot, // macOS draws it from the glass's shape (the window is see-through)
    alwaysOnTop: true,
    // macOS: a non-activating panel, so opening it doesn't switch Spaces or leave a full-screen app.
    ...(isMac ? { type: "panel" } : {}),
    webPreferences: { ...webPreferences, backgroundThrottling: false },
  });
  if (isMac) {
    bar.setAlwaysOnTop(true, "floating");
    bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }
  harden(bar);
  setLook(bar, { name: "bar", radius: 30, style: GLASS_STYLE, tint: true }, "popover", (m) => {
    barMaterial = m;
    bar.setSize(barWidth(), bar.getSize()[1]);
  });
  bar.on("blur", () => {
    if (snapshot) return;
    // A panel can lose focus as it opens; only a later blur means "clicked elsewhere".
    if (Date.now() - barShownAt > 400) bar.hide();
    else if (barOpenedByUser) bar.focus();
  });
  bar.on("focus", () => {
    barOpenedByUser = true;
    barForVoice = false;
  });
  bar.on("hide", () => {
    barOpenedByUser = false;
    barForVoice = false;
  });
  bar.loadURL(pageUrl("bar"));
  return bar;
}

// A page's own short note for the log (numbers about what it drew; never message text).
ipcMain.on("page:note", (e, text) => {
  if (!fromOurPage(e)) return;
  const from = bar && e.sender === bar.webContents ? "bar" : mainWin && e.sender === mainWin.webContents ? "chats" : caption && e.sender === caption.webContents ? "caption" : "page";
  log(`${from}: ${String(text).replace(/[^\w ,.:()-]/g, "").slice(0, 200)}`);
});

ipcMain.on("bar:resize", (e, height) => {
  if (!bar || e.sender !== bar.webContents) return;
  const h = Math.max(56, Math.min(700, Math.round(Number(height) || 0)));
  const [x, y] = bar.getPosition();
  const [, oldH] = bar.getSize();
  const wa = screen.getDisplayMatching(bar.getBounds()).workArea;
  if (h === oldH) return;
  const want = barAnchor === "bottom" ? y + oldH - h : y; // at the bottom it grows upward
  bar.setBounds({ x, y: Math.max(wa.y + 8, Math.min(want, wa.y + wa.height - h - 8)), width: barWidth(), height: h });
  if (isMac) bar.invalidateShadow();
});

// The bar shows the agents found at start (asking the core again would start codemax each time).
let agentsLoaded;
ipcMain.handle("bar:agents", async (e) => {
  if (!bar || e.sender !== bar.webContents) throw new Error("refused");
  await agentsLoaded;
  return agents;
});

ipcMain.on("bar:hide", (e) => {
  if (!bar || e.sender !== bar.webContents) return;
  bar.hide();
  hushCaption(); // Esc: quiet too
});

// A question was sent from the bar: the bar closes and the answer shows beside the pointer.
ipcMain.on("bar:sent", (e, threadId) => {
  if (!bar || e.sender !== bar.webContents || !/^[0-9a-f]{32}$/.test(String(threadId))) return;
  bar.hide();
  lastAsked = String(threadId);
  log("bar sent the question");
  showCaption(lastAsked);
  refreshTray();
});

/** The last answer asked from the bar, back beside the pointer: held still, not read aloud again. */
function showLastAnswer() {
  if (!lastAsked) return false;
  showCaption(lastAsked, { speak: false, held: true });
  return true;
}
// ↑ in the empty bar.
ipcMain.on("bar:last", (e) => {
  if (!bar || e.sender !== bar.webContents) return;
  if (showLastAnswer()) bar.hide();
});

// What you said while the answer was still coming: the card shows it as next; the bar asks it once
// that answer ends (ui/src/held.ts).
ipcMain.on("bar:held", (e, h) => {
  if (!bar || e.sender !== bar.webContents) return;
  const chat = h && /^[0-9a-f]{32}$/.test(String(h.chat)) ? String(h.chat) : null;
  const next = chat && typeof h.text === "string" && h.text.trim() ? h.text.slice(0, 300) : null;
  if (next) {
    log("bar holds a question until the answer ends");
    // Talking put the card on "Listening…": back to that chat, the question under its answer (a card
    // waiting for your OK in another chat stays).
    const okWaits = captionThread && captionThread !== chat && (waiting.get(captionThread) ?? 0) > 0;
    if (!okWaits && !captionShows(chat)) showCaption(chat);
  }
  if (!caption || caption.isDestroyed()) return;
  const tell = () => caption.webContents.send("caption:next", next);
  if (caption.webContents.isLoading()) caption.webContents.once("did-finish-load", tell);
  else tell();
});
ipcMain.on("caption:next-done", (e) => {
  if (!caption || e.sender !== caption.webContents) return;
  log("card done with the answer; the held question can go");
  if (bar && !bar.isDestroyed()) bar.webContents.send("bar:card-done");
});

// What you said couldn't be sent: the bar opens with it in the box.
ipcMain.on("bar:open", (e) => {
  if (bar && e.sender === bar.webContents) showBar({ focus: true });
});

// ---------- the answer beside the pointer (ui/src/Caption.tsx) ----------
// A see-through, click-through window of a fixed size: the card sits in its corner nearest the
// pointer and grows away from it, so nothing moves while a reply arrives. It never takes focus (a
// keystroke meant for another app can't reach it); its card takes the mouse while the pointer is on it.
// The card follows the pointer while Dune Bot listens, works or reads the answer aloud. It stays
// still while a card waits for your OK (so you can click it), when it popped up in the corner, once
// the answer has been read (until it fades), and from the moment you move toward it, so you can
// reach it to scroll or click. "Show last answer" (menu, or ↑ in the empty bar) brings it back.
let caption = null;
let captionThread = null; // the chat it shows (null: only listening)
let captionOpen = false;
let captionCornered = false;
let captionSettled = false; // the page says: nothing left to do or say
let captionHeld = false; // you moved toward it (or reopened it): it stays where it is
let lastAsked = null; // the chat last asked from the bar, for "Show last answer"
let trail = []; // the pointer's last moves with where the card was: { at, p, card }
let captionPlace = null; // { side, align } last sent to the page
let captionMoving = false;
let followTimer = null;
let lastPointer = null;
// Wayland doesn't tell apps where the pointer is: the card stays where it opened.
const canFollow = !wayland;
// Hidden-window check of the follow loop: a scripted pointer, numbers in the log (DUNEBOT_SNAPSHOT_FOLLOW).
// "grab": the pointer jiggles beside the card, then heads for it (the card must stop there).
const followTest = snapshot && process.env.DUNEBOT_SNAPSHOT_FOLLOW
  ? { tick: 0, moves: 0, sides: 0, under: 0, outside: 0, heldTicks: 0, movedWhileHeld: 0, grab: process.env.DUNEBOT_SNAPSHOT_FOLLOW === "grab", grabbedAt: 0, movedAfterGrab: 0 }
  : null;

function pointer() {
  if (!followTest) return screen.getCursorScreenPoint();
  // A path that crosses the screen, runs along its right and bottom edges and jiggles there.
  const wa = screen.getPrimaryDisplay().workArea;
  const t = followTest.tick;
  const cx = wa.x + wa.width / 2;
  const cy = wa.y + wa.height / 2;
  if (followTest.grab) {
    // Sideways beside the card for ~1 s (it keeps following), then down and right into it.
    if (t < 60) return { x: Math.round(cx + 60 * Math.sin(t / 5)), y: Math.round(cy) };
    const k = Math.min(t - 60, 60) * 4;
    return { x: Math.round(cx + k), y: Math.round(cy + k) };
  }
  const k = (t % 240) / 60;
  if (k < 1) return { x: Math.round(cx + (wa.width / 2 - 20) * k), y: Math.round(cy) };
  if (k < 2) return { x: Math.round(wa.x + wa.width - 20 - 25 * (1 + Math.sin(t))), y: Math.round(cy) };
  if (k < 3) return { x: Math.round(cx), y: Math.round(cy + (wa.height / 2 - 20) * (k - 2)) };
  return { x: Math.round(cx + 30 * Math.sin(t / 3)), y: Math.round(wa.y + wa.height - 20 - 25 * (1 + Math.sin(t))) };
}

const captionWaits = () => !!captionThread && (waiting.get(captionThread) ?? 0) > 0;

/** Starts or stops following, and tells the page (it ignores the pointer while the card moves). */
function updateFollow() {
  const moving = canFollow && captionOpen && !captionCornered && !captionSettled && !captionHeld && !captionWaits();
  if (moving !== captionMoving) {
    captionMoving = moving;
    if (caption && !caption.isDestroyed()) {
      caption.webContents.send("caption:moving", moving);
      if (moving) caption.setIgnoreMouseEvents(true, { forward: true });
    }
  }
  const tick = captionOpen && (moving || followTest);
  if (tick && !followTimer) followTimer = setInterval(followStep, 16);
  if (!tick && followTimer) {
    clearInterval(followTimer);
    followTimer = null;
  }
}

function followStep() {
  // Quitting destroys the card before this timer stops: touching it then throws, and Electron shows
  // a modal error box that holds the app open.
  if (!caption || caption.isDestroyed()) {
    clearInterval(followTimer);
    followTimer = null;
    return;
  }
  if (followTest) followTest.tick++;
  if (!captionMoving) {
    if (followTest?.grabbedAt) {
      const [x, y] = caption.getPosition();
      followTest.grabPos ??= { x, y };
      if (x !== followTest.grabPos.x || y !== followTest.grabPos.y) followTest.movedAfterGrab++;
    }
    if (followTest && captionWaits()) {
      const [x, y] = caption.getPosition();
      followTest.held ??= { x, y };
      followTest.heldTicks++;
      if (x !== followTest.held.x || y !== followTest.held.y) followTest.movedWhileHeld++;
    }
    return;
  }
  const p = pointer();
  if (lastPointer && p.x === lastPointer.x && p.y === lastPointer.y) return;
  lastPointer = p;
  // Heading for the card over the last ~0.1 s: it stops where it is, so the pointer reaches it.
  // (Not in the scripted check of following, whose path crosses the card on purpose.)
  // The scripted pointer moves per tick, so its check keeps time in ticks: a hidden app's timers can be
  // bunched by the system (macOS CI), which would leave no sample 60–200 ms old.
  const now = followTest ? followTest.tick * 16 : Date.now();
  trail = trail.filter((s) => now - s.at < 200);
  const from = trail.find((s) => now - s.at >= 60);
  if ((!followTest || followTest.grab) && from && heading(from.p, p, from.card)) {
    captionHeld = true;
    if (followTest) followTest.grabbedAt = followTest.tick;
    trail = [];
    log("caption: held still, the pointer is heading for it");
    updateFollow();
    return;
  }
  const wa = screen.getDisplayNearestPoint(p).workArea;
  const r = placeCaption(p, wa, captionPlace);
  trail.push({ at: now, p, card: r.card });
  if (followTest) {
    followTest.moves++;
    if (covers(r.card, p)) followTest.under++;
    if (!inside(r.card, wa)) followTest.outside++;
  }
  // setBounds with the fixed size: repeated setPosition can creep the size on scaled Windows displays.
  caption.setBounds({ x: r.x, y: r.y, width: CAPTION_W, height: CAPTION_H });
  if (!captionPlace || r.side !== captionPlace.side || r.align !== captionPlace.align) {
    if (captionPlace && followTest) followTest.sides++;
    captionPlace = { side: r.side, align: r.align };
    caption.webContents.send("caption:place", captionPlace);
  }
}

function createCaption() {
  caption = new BrowserWindow({
    width: CAPTION_W,
    height: CAPTION_H,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false, // the card draws its own
    alwaysOnTop: true,
    focusable: false,
    acceptFirstMouse: true, // a click on its card works without first activating Dune Bot
    ...(isMac ? { type: "panel" } : {}),
    // It reads answers aloud without ever being clicked (Chromium otherwise wants a click first).
    webPreferences: { ...webPreferences, backgroundThrottling: false, autoplayPolicy: "no-user-gesture-required" },
  });
  if (isMac) {
    caption.setAlwaysOnTop(true, "floating");
    caption.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }
  caption.setIgnoreMouseEvents(true, { forward: true });
  harden(caption);
  caption.loadURL(pageUrl("caption"));
  return caption;
}

/** Shows a chat beside the pointer (`corner`: the screen's top right, for a card waiting in a chat
 * you didn't ask from the bar). `threadId` null: just "Listening…" while you hold ⌥⌘. */
function showCaption(threadId, { speak = true, corner = false, held = false } = {}) {
  if (!caption || caption.isDestroyed()) createCaption();
  const p = pointer();
  const wa = screen.getDisplayNearestPoint(p).workArea;
  const { x, y, side, align } = corner ? captionCorner(wa) : placeCaption(p, wa, null);
  captionThread = threadId;
  captionOpen = true;
  captionCornered = corner;
  captionSettled = false;
  captionHeld = held;
  trail = [];
  captionPlace = { side, align };
  lastPointer = p;
  const msg = { threadId, side, align, speak };
  const tell = () => caption.webContents.send("caption:show", msg);
  if (caption.webContents.isLoading()) caption.webContents.once("did-finish-load", tell);
  else tell();
  caption.setBounds({ x: Math.round(x), y: Math.round(y), width: CAPTION_W, height: CAPTION_H });
  caption.setIgnoreMouseEvents(true, { forward: true });
  if (!snapshot) caption.showInactive();
  captionMoving = null; // tell the page again
  updateFollow();
  log(`caption shown ${corner ? "in the corner" : `${side} the pointer, ${align}${canFollow && !held ? ", following it" : ""}`}${threadId ? "" : " (listening)"}`);
}

const captionShows = (threadId) => !!caption && !caption.isDestroyed() && caption.isVisible() && captionThread === threadId;
function hushCaption() {
  if (caption && !caption.isDestroyed()) caption.webContents.send("caption:hush");
}
function hideCaption() {
  if (caption && !caption.isDestroyed()) caption.hide();
  captionOpen = false;
  updateFollow();
}

ipcMain.on("caption:hide", (e) => {
  if (caption && e.sender === caption.webContents) hideCaption();
});
ipcMain.on("caption:mouse", (e, on) => {
  // While it moves, the card never takes the mouse (it can't be where the pointer is anyway).
  if (caption && e.sender === caption.webContents && !(on && captionMoving)) caption.setIgnoreMouseEvents(!on, { forward: true });
});
ipcMain.on("caption:settled", (e, on) => {
  if (!caption || e.sender !== caption.webContents) return;
  captionSettled = !!on;
  updateFollow();
});
// Hidden-window check only (the bar-held view): words as if you had just said them, so the bar's
// held question runs for real without a microphone.
ipcMain.on("test:transcript", (e, text) => {
  if (snapshot && process.env.DUNEBOT_SNAPSHOT_HELD && bar && e.sender === bar.webContents) emit({ event: "voice.transcript", text: String(text).slice(0, 200) });
});
// Hidden-window check only: show the card for a chat the page made, as the bar would.
ipcMain.on("caption:test-show", (e, threadId) => {
  if (followTest && caption && e.sender === caption.webContents && /^[0-9a-f]{32}$/.test(String(threadId))) showCaption(String(threadId));
});

function placeBar(where) {
  const cur = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(cur).workArea;
  const [w, h] = bar.getSize();
  const pad = barPad(); // the card sits this far inside the window: keep the visible gap the same
  let x, y;
  if (where === "bottom" || where === "top") {
    x = wa.x + (wa.width - w) / 2;
    y = where === "bottom" ? wa.y + wa.height - h - 24 + pad : wa.y + wa.height * 0.18 - pad;
  } else if (where === "pointer") {
    x = cur.x - 48;
    y = cur.y + 20;
    if (y + h > wa.y + wa.height - 8) y = cur.y - h - 12;
  } else {
    x = wa.x + wa.width - w - 8; // the top corner, for approvals that pop up by themselves
    y = wa.y + 8;
  }
  barAnchor = where === "bottom" ? "bottom" : "top";
  x = Math.max(wa.x + 8 - pad, Math.min(x, wa.x + wa.width - w - 8 + pad));
  y = Math.max(wa.y + 8 - pad, Math.min(y, wa.y + wa.height - h - 8 + pad));
  bar.setPosition(Math.round(x), Math.round(y));
}

/** Where the bar's card is on screen, for the log: its gap to the bottom and the sides. */
function barReport(what) {
  const b = bar.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const pad = barPad();
  const card = { x: b.x + pad, y: b.y + pad, w: b.width - 2 * pad, h: b.height - 2 * pad };
  log(`bar ${what}: card ${card.w}x${card.h} at ${card.x},${card.y}; gap below ${wa.y + wa.height - card.y - card.h}, left ${card.x - wa.x}, right ${wa.x + wa.width - card.x - card.w}`);
}

/** Opens the bar. `focus`: where you chose in the menu bar, ready to type, as just the input (unless
 * `threadId` asks for a chat, or the last one is still working or waiting for you). Otherwise it
 * appears without taking focus, so a keystroke meant for another app can't answer it: `voice` where
 * you chose, an approval in the top corner. */
function showBar({ focus, voice, threadId } = { focus: true }) {
  if (!bar || bar.isDestroyed()) createBar();
  if (threadId) bar.webContents.send("bar:thread", threadId);
  if (snapshot) return;
  if (focus) {
    hushCaption(); // you're about to ask something else
    if (!bar.isVisible() || !barOpenedByUser) placeBar(barPlace());
    barShownAt = Date.now();
    barOpenedByUser = true;
    barForVoice = false;
    if (isMac) app.focus({ steal: true });
    bar.show();
    bar.focus();
    bar.webContents.send("bar:focus", { fresh: !threadId });
    setTimeout(() => log(`bar shown; visible=${bar.isVisible()} focused=${bar.isFocused()}`), 300);
  } else if (!bar.isVisible()) {
    placeBar(voice ? barPlace() : "corner");
    barShownAt = Date.now();
    barForVoice = !!voice;
    bar.showInactive();
  }
}

// Tap ⌥⌘ (or the hotkey): closes a bar you opened, otherwise opens/focuses it.
function toggleBar() {
  if (bar && bar.isVisible() && barOpenedByUser) bar.hide();
  else showBar({ focus: true });
}

// A bar that came up for voice goes away once the work is done, unless you clicked into it.
let voiceHideTimer;
function hideVoiceBarSoon(ms) {
  clearTimeout(voiceHideTimer);
  voiceHideTimer = setTimeout(() => {
    const need = [...waiting.values()].reduce((a, b) => a + b, 0);
    if (bar && barForVoice && !bar.isFocused() && !need && !busy.size) bar.hide();
  }, ms);
}

// ---------- voice: the mic opens only once it's allowed ----------
// Opening it before would put the system's permission box up mid-sentence and lose what you said.
function micStatus() {
  if (!isMac && !isWin) return "granted";
  try {
    return systemPreferences.getMediaAccessStatus("microphone");
  } catch {
    return "granted";
  }
}

async function startVoice(source) {
  hushCaption(); // the mic mustn't hear Dune Bot
  if (isMac ? micStatus() !== "granted" : isWin && micStatus() === "denied") {
    openSetup("mic");
    throw new Error("Allow the microphone first. Dune Bot's setup is open.");
  }
  await sarvamReady();
  return call("voice.start", { source });
}

// ---------- voice keys: Sarvam and Deepgram ----------
// The user's own keys (Settings › Voice): Sarvam AI listens and reads Hindi and other Indian languages;
// Deepgram reads English answers in an American voice. Each is locked with Electron's safeStorage: the
// lock is kept by the system (macOS Keychain, Windows DPAPI, the Linux secret store), the locked key in
// Dune Bot's folder. It's unlocked only when voice first needs it and handed to the core over its
// stdin, never in an environment variable (agents inherit those), a command line, a page or the log.
function keyCanLock() {
  // Snapshots and self-checks run other copies of Electron: if one of them touched the keychain, macOS
  // would later ask whether Dune Bot may use its own lock. They never do.
  if (snapshot || selfcheck) return true;
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    // Linux without a secret store "locks" with a fixed password: not worth keeping a key that way.
    return !(process.platform === "linux" && safeStorage.getSelectedStorageBackend?.() === "basic_text");
  } catch {
    return false;
  }
}

function lockedKey({ id, name, file, pattern, method }) {
  const where = () => path.join(app.getPath("userData"), file);
  let given = null; // the core process the key was handed to (or tried)
  let handing = null; // that handover while it's under way: every caller waits for it
  const status = () => ({ saved: fs.existsSync(where()), canSave: keyCanLock() });
  return {
    status,
    saved: () => fs.existsSync(where()),
    async save(raw) {
      const key = String(raw ?? "").trim();
      if (!pattern.test(key)) throw new Error(`That doesn't look like a ${name} key.`);
      if (snapshot || selfcheck) throw new Error("Not saved: this is a test run.");
      if (!keyCanLock()) throw new Error("This computer has no keychain to lock the key with, so Dune Bot won't keep it.");
      const f = where();
      fs.writeFileSync(`${f}.part`, safeStorage.encryptString(key), { mode: 0o600 });
      fs.renameSync(`${f}.part`, f);
      log(`${id}: key saved, locked by the system keychain`);
      if (core) {
        given = core;
        handing = call(method, { key }).then(() => {});
        await handing;
      }
      return status();
    },
    async remove() {
      fs.rmSync(where(), { force: true });
      given = null;
      handing = null;
      if (core) await call(method, { key: null }).catch(() => {});
      log(`${id}: key removed`);
      return status();
    },
    /** Hands the key to the core the first time voice needs it (once per core start, even if it
     * fails, so a keychain that says no isn't asked again and again; voice then does without it). */
    ready() {
      if (!core || !fs.existsSync(where())) return Promise.resolve();
      if (given === core) return handing;
      given = core;
      handing = (async () => {
        let key;
        try {
          key = safeStorage.decryptString(fs.readFileSync(where()));
        } catch (e) {
          return log(`${id}: couldn't unlock the key (${e.message}); voice does without it`);
        }
        await call(method, { key }).then(
          () => log(`${id}: key handed to the core`),
          (e) => log(`${id}: the core refused the key (${e.message})`),
        );
      })();
      return handing;
    },
  };
}
const sarvamKey = lockedKey({ id: "sarvam", name: "Sarvam", file: "sarvam-key.bin", pattern: /^[A-Za-z0-9_-]{10,200}$/, method: "voice.key" });
const deepgramKey = lockedKey({ id: "deepgram", name: "Deepgram", file: "deepgram-key.bin", pattern: /^[A-Za-z0-9_-]{20,200}$/, method: "voice.deepgramKey" });
/** Both keys with the core before anything is heard or read aloud. */
const sarvamReady = () => Promise.all([sarvamKey.ready(), deepgramKey.ready()]);

// Reading aloud: at most 500 characters a time and 40 times a minute, whatever a page asks.
let sayTimes = [];
function sayCap() {
  const now = Date.now();
  sayTimes = sayTimes.filter((t) => now - t < 60_000);
  if (sayTimes.length >= 40) throw new Error("reading aloud too often");
  sayTimes.push(now);
}
async function sayWithSarvam(text) {
  sayCap();
  await sarvamReady();
  return call("voice.say", { text: String(text ?? "").slice(0, 500) });
}
/** A sentence for a streaming voice the card opened: the same limits as voice.say. */
async function sayStreamed(stream, text) {
  sayCap();
  await sarvamReady();
  return call("voice.streamSay", { stream: String(stream ?? ""), text: String(text ?? "").slice(0, 500) });
}

/** Developer's one-time import: DUNEBOT_SARVAM_ENV names a .env file with SARVAM_API_KEY=… (and/or
 * DEEPGRAM_API_KEY=…) in it. */
async function sarvamImport() {
  const from = process.env.DUNEBOT_SARVAM_ENV;
  if (!from || snapshot || selfcheck) return;
  for (const [name, store] of [["SARVAM_API_KEY", sarvamKey], ["DEEPGRAM_API_KEY", deepgramKey]]) {
    if (store.saved()) continue;
    try {
      const line = fs.readFileSync(from, "utf8").split(/\r?\n/).find((l) => new RegExp(`^\\s*${name}\\s*=`).test(l));
      const key = line?.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!key) continue;
      await store.save(key);
      log(`${name.split("_")[0].toLowerCase()}: key imported from the file DUNEBOT_SARVAM_ENV names`);
    } catch (e) {
      log(`voice keys: import failed (${e.message})`);
    }
  }
}

for (const [id, store] of [["sarvam", sarvamKey], ["deepgram", deepgramKey]]) {
  for (const what of ["status", "save", "remove"]) {
    ipcMain.handle(`${id}:${what}`, (e, arg) => {
      if (!fromOurPage(e)) throw new Error("refused");
      return store[what](arg);
    });
  }
}

let hold = null; // the ⌥⌘ hold in progress: its start, so release/cancel wait for the mic to open
function onChord(kind) {
  log(`chord ${kind}`);
  if (kind === "tap") return toggleBar();
  if (kind === "hold-start") {
    if (micStatus() !== "granted") {
      hold = null;
      return openSetup("mic");
    }
    hushCaption(); // the mic mustn't hear Dune Bot
    // "Listening…" beside the pointer (a card still waiting for you there stays, under it).
    if (!(captionThread && (waiting.get(captionThread) ?? 0) > 0)) showCaption(null);
    const started = startVoice("chord").catch((e) => {
      emit({ event: "voice.state", state: "error", message: e.message });
      throw e;
    });
    hold = { started };
    started.catch(() => {});
    return;
  }
  const h = hold;
  hold = null;
  if (!h) return;
  if (kind === "hold-end") h.started.then(() => call("voice.stop")).catch(() => {});
  if (kind === "hold-cancel") {
    h.started.then(() => call("voice.cancel")).catch(() => {});
    hideVoiceBarSoon(300); // ⌥⌘ was part of another shortcut
    if (captionThread === null) hideCaption();
  }
}

// ---------- the history window ----------
let mainWin = null;

function openMain(view = "chat") {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send("nav", view);
    mainWin.show();
    mainWin.focus();
    if (isMac) app.focus({ steal: true });
    return mainWin;
  }
  const [w, h] = (process.env.DUNEBOT_SNAPSHOT_SIZE ?? "1180x780").split("x").map(Number);
  mainWin = new BrowserWindow({
    width: w,
    height: h,
    minWidth: 760,
    minHeight: 520,
    show: false,
    // macOS: a see-through page over glass (sidebar style), which sits on the system's window colour.
    backgroundColor: isMac && !snapshot ? "#00000000" : PAPER(),
    title: "Dune Bot",
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    ...(isMac ? { trafficLightPosition: { x: 22, y: 22 } } : { titleBarOverlay: titleBarOverlay() }),
    autoHideMenuBar: !isMac,
    webPreferences,
  });
  harden(mainWin);
  setLook(mainWin, { name: "history", radius: 16, opaque: true, style: "sidebar" }, "sidebar");
  if (!snapshot)
    mainWin.once("ready-to-show", () => {
      mainWin.show();
      if (isMac) app.focus({ steal: true });
    });
  mainWin.on("closed", () => (mainWin = null));
  mainWin.loadURL(pageUrl(`main:${view}`));
  return mainWin;
}

// ---------- setup: every permission up front ----------
// Asked on first launch and whenever macOS has forgotten one (a rebuilt or re-signed app is a new
// app to macOS). Only what Dune Bot uses: Screen Recording (agents look at the screen under the
// pointer, 2026-11-16), but no Full Disk Access, Accessibility or Input Monitoring (the ⌥⌘ chord
// reads modifier keys only).
const FOLDERS = isMac ? ["Desktop", "Documents", "Downloads"] : [];
let setupWin = null;

function folderAnswers() {
  const out = Object.fromEntries(FOLDERS.map((f) => [f, "not-asked"]));
  // A forgotten mic answer means macOS forgot the folder answers too.
  if (micStatus() === "not-determined") return out;
  for (const part of String(prefs["setup.folders"] ?? "").split(",")) {
    const [k, v] = part.split(":");
    if (k in out && ["granted", "denied", "missing"].includes(v)) out[k] = v;
  }
  return out;
}

function notificationStatus() {
  if (!isMac) return "granted";
  try {
    return addon ? addon.notificationStatus() : "unknown";
  } catch {
    return "unknown";
  }
}

/** macOS: whether this app may take pictures of the screen. Other systems don't ask. */
function screenStatus() {
  if (!isMac) return "granted";
  try {
    return systemPreferences.getMediaAccessStatus("screen");
  } catch {
    return "unknown";
  }
}

// ---------- pictures of the screen, for the core's look_at_screen ----------
// Taken here, not in the core, so the permission belongs to Dune Bot (the same app as the mic).
// One picture of the display under the pointer, its long edge at most what Claude reads unshrunk.
// It goes to the core over its stdin, never through a window, and nothing keeps it.
const SHOT_EDGE = 1568;

async function takeScreenshot() {
  const pointer = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(pointer);
  // Checks: a stand-in picture from a file. A test run never takes a real one.
  const stub = process.env.DUNEBOT_SCREEN_STUB;
  if (stub) {
    const img = nativeImage.createFromPath(stub);
    if (img.isEmpty()) throw new Error("Dune Bot couldn't take a picture of the screen.");
    const size = img.getSize();
    return { data: img.toPNG().toString("base64"), mime: "image/png", ...size, display: d.bounds, pointer };
  }
  if (snapshot || selfcheck) throw new Error("Pictures of the screen are off in this test run.");
  if (screenStatus() !== "granted") {
    openSetup("screen");
    throw new Error(
      "Dune Bot can't see the screen yet: macOS needs Screen Recording turned on for Dune Bot. The setup window is open on it; ask again once it's on.",
    );
  }
  const px = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  const k = Math.min(1, SHOT_EDGE / Math.max(px.width, px.height));
  const want = { width: Math.round(px.width * k), height: Math.round(px.height * k) };
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: want });
  const src = sources.find((s) => s.display_id === String(d.id)) ?? (sources.length === 1 ? sources[0] : null);
  if (!src || src.thumbnail.isEmpty()) throw new Error("Dune Bot couldn't take a picture of the screen.");
  const size = src.thumbnail.getSize();
  return { data: src.thumbnail.toJPEG(75).toString("base64"), mime: "image/jpeg", ...size, display: d.bounds, pointer };
}

// Asking macOS directly is what puts Dune Bot in System Settings' Screen Recording list; the
// capture calls alone don't, until a picture is actually taken.
let screenAsked = false;
function askScreen() {
  screenAsked = true;
  try {
    if (addon?.requestScreenAccess) addon.requestScreenAccess();
    else log("screen: this build's addon can't ask macOS (rebuild it: bun run native)");
  } catch (err) {
    log(`screen: asking failed: ${err.message}`);
  }
}

async function captureForCore(requestId) {
  try {
    const shot = await takeScreenshot();
    log(`screen: picture ${shot.width}x${shot.height}, ${Math.round((shot.data.length * 0.75) / 1024)} KB`);
    await call("screen.result", { requestId, ...shot });
  } catch (err) {
    log(`screen: ${err.message}`);
    call("screen.result", { requestId, error: err.message }).catch(() => {});
  }
}

async function setupStatus() {
  const voice = await call("voice.status").catch(() => ({}));
  return {
    platform: pagePlatform,
    asks: asks(),
    hotkey,
    keys: keysLabel(),
    mic: micStatus(),
    notifications: notificationStatus(),
    folders: folderAnswers(),
    screen: screenStatus(),
    voice,
    done: prefs["setup.done"] === "1",
  };
}

function needsSetup() {
  return prefs["setup.done"] !== "1" || micStatus() === "not-determined" || notificationStatus() === "not-determined";
}

async function savePref(key, value) {
  const r = await call("prefs.set", { key, value }).catch(() => null);
  if (r) prefs = r.prefs;
}

function openSetup(step = "") {
  if (setupWin && !setupWin.isDestroyed()) {
    if (step) setupWin.webContents.send("nav", step);
    setupWin.show();
    setupWin.focus();
    if (isMac) app.focus({ steal: true });
    return setupWin;
  }
  setupWin = new BrowserWindow({
    width: 560,
    height: 640,
    show: false,
    frame: false,
    transparent: isMac,
    backgroundColor: isMac ? "#00000000" : GLASS_PAPER(),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: true,
    title: "Set up Dune Bot",
    webPreferences,
  });
  harden(setupWin);
  setLook(setupWin, { name: "setup", radius: 26, style: GLASS_STYLE, tint: true }, "under-window");
  if (!snapshot)
    setupWin.once("ready-to-show", () => {
      setupWin.center();
      setupWin.show();
      setupWin.focus();
      if (isMac) app.focus({ steal: true });
    });
  setupWin.on("closed", () => (setupWin = null));
  setupWin.loadURL(pageUrl(`setup${step ? ":" + step : ""}`));
  return setupWin;
}

function fromSetup(e) {
  return fromOurPage(e) && setupWin && !setupWin.isDestroyed() && e.sender === setupWin.webContents;
}

ipcMain.handle("setup:status", (e) => {
  if (!fromSetup(e)) throw new Error("refused");
  return setupStatus();
});

ipcMain.handle("setup:ask", async (e, what) => {
  if (!fromSetup(e)) throw new Error("refused");
  log(`setup: asking for ${what}`);
  switch (what) {
    case "mic":
      if (isMac) await systemPreferences.askForMediaAccess("microphone");
      break;
    case "mic-test":
      // The core records, not this app: check that sound actually reaches it.
      return call("voice.test");
    case "notifications":
      if (isMac && addon) {
        addon.requestNotifications();
        // Log macOS's answer (or its error), so "off" can be told apart from "this build can't ask".
        (async () => {
          for (let i = 0; i < 120; i++) {
            await new Promise((r) => setTimeout(r, 500));
            const r = addon.notificationRequestResult();
            if (r) return log(`notifications: asked, macOS answered ${r}`);
          }
          log("notifications: asked, no answer within a minute");
        })();
      }
      break;
    case "folders": {
      // Looking inside each folder makes macOS ask, one folder at a time.
      const got = {};
      for (const f of FOLDERS) {
        try {
          await fs.promises.readdir(path.join(os.homedir(), f));
          got[f] = "granted";
        } catch (err) {
          got[f] = err.code === "ENOENT" ? "missing" : "denied";
        }
      }
      await savePref("setup.folders", Object.entries(got).map(([k, v]) => `${k}:${v}`).join(","));
      break;
    }
    case "voice":
      await call("voice.prepare");
      break;
    case "screen":
      // The first time, macOS's own box (it has an "Open System Settings" button); after that only
      // System Settings changes it, and macOS then offers Quit & Reopen.
      if (isMac && screenStatus() !== "granted") {
        const first = !screenAsked;
        askScreen();
        if (!first) shell.openExternal(SETTINGS_PANES.screen);
      }
      break;
    default:
      throw new Error("unknown step");
  }
  return setupStatus();
});

const SETTINGS_PANES = isMac
  ? {
      mic: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
      notifications: "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
      folders: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders",
      screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    }
  : isWin
    ? { mic: "ms-settings:privacy-microphone", notifications: "ms-settings:notifications" }
    : {};

ipcMain.on("setup:settings", (e, what) => {
  if (!fromSetup(e) || !SETTINGS_PANES[what]) return;
  if (what === "screen") askScreen(); // so Dune Bot is in the list there
  shell.openExternal(SETTINGS_PANES[what]);
});

ipcMain.on("setup:fit", (e, height) => {
  if (!fromSetup(e)) return;
  const h = Math.max(320, Math.min(860, Math.round(Number(height) || 0)));
  setupWin.setContentSize(560, h);
});

ipcMain.handle("setup:finish", async (e, done) => {
  if (!fromSetup(e)) throw new Error("refused");
  if (done) await savePref("setup.done", "1");
  setupWin.close();
  if (done) showBar({ focus: true });
});

// ---------- menu bar / tray ----------
let tray = null;
let hotkey = null;
let chord = false; // macOS ⌥⌘ chord heard by the core
let voiceNote = "";
let agents = [];
let prefs = {};
const busy = new Set();
const waiting = new Map();
const titles = new Map();

const ICONS = isMac
  ? { idle: "trayTemplate.png", busy: "tray-busyTemplate.png" }
  : { idle: "tray-color.png", busy: "tray-color-busy.png" };

function refreshTray() {
  if (!tray) return;
  const need = [...waiting.values()].reduce((a, b) => a + b, 0);
  tray.setImage(nativeImage.createFromPath(path.join(here, "assets", busy.size || need ? ICONS.busy : ICONS.idle)));
  if (isMac) tray.setTitle(need ? " Needs OK" : "");
  tray.setToolTip(need ? "Dune Bot: waiting for your OK" : busy.size ? "Dune Bot: working…" : "Dune Bot");
  const agentItems = agents
    .filter((a) => a.installed)
    .map((a) => ({
      label: a.name,
      type: "radio",
      checked: (prefs.agent ?? "claude") === a.id,
      click: async () => {
        await savePref("agent", a.id);
        broadcast({ event: "prefs.updated", prefs });
        refreshTray();
      },
    }));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      isMac
        ? { label: chord ? `Ask Dune Bot        tap ${keysLabel()}` : "Ask Dune Bot", click: () => showBar({ focus: true }) }
        : hotkey
          ? { label: "Ask Dune Bot", accelerator: hotkey, registerAccelerator: false, click: () => showBar({ focus: true }) }
          : { label: "Ask Dune Bot (no hotkey: all choices taken)", click: () => showBar({ focus: true }) },
      { label: isMac && chord ? `Talk                       hold ${keysLabel()}` : "Talk: hold the mic button in the bar", enabled: false },
      ...(voiceNote ? [{ label: voiceNote, enabled: false }] : []),
      ...(need ? [{ label: `${need} waiting for your OK`, click: () => showWaiting() }] : []),
      { label: "Show last answer       ↑ in the bar", enabled: !!lastAsked, click: () => showLastAnswer() },
      ...(busy.size
        ? [{ label: busy.size > 1 ? `Stop all ${busy.size} agents` : "Stop the agent", click: () => (hushCaption(), call("agents.stopAll").catch(() => {})) }]
        : []),
      { type: "separator" },
      { label: "Chats & activity…", click: () => openMain("chat") },
      { label: "What agents may do…", click: () => openMain("settings") },
      { label: "Set up Dune Bot…", click: () => openSetup() },
      {
        label: "Open the bar",
        submenu: BAR_PLACES.map(([k, label]) => ({ label, type: "radio", checked: barPlace() === k, click: () => setBarPlace(k) })),
      },
      ...(isMac && chord
        ? [{ label: "Keys", submenu: KEYS.map(([k, label]) => ({ label, type: "radio", checked: keysName() === k, click: () => setKeys(k) })) }]
        : []),
      { label: "Agent", submenu: agentItems.length ? agentItems : [{ label: "Looking for agents…", enabled: false }] },
      { type: "separator" },
      { label: "Quit Dune Bot", accelerator: isMac ? "Command+Q" : undefined, click: () => app.quit() },
    ]),
  );
}

/** The menu's "waiting for your OK": the first chat with a card, beside the pointer. */
function showWaiting() {
  const id = [...waiting.entries()].find(([, n]) => n > 0)?.[0];
  if (id) showCaption(id, { speak: false });
}

const live = new Set(); // keeps notifications (and their click handlers) alive until closed
function notify(title, body, onClick) {
  if (snapshot || !Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  live.add(n);
  n.on("close", () => live.delete(n));
  n.on("click", () => {
    live.delete(n);
    onClick?.();
  });
  n.show();
}

function someWindowFocused() {
  return (bar && bar.isFocused()) || (mainWin && !mainWin.isDestroyed() && mainWin.isFocused());
}

const firstWords = new Set(); // chats whose answer hasn't started yet (for the log's timings)
function onCoreEvent(m) {
  switch (m.event) {
    case "thread.updated":
      titles.set(m.thread.id, m.thread.title);
      break;
    case "thread.deleted":
      if (lastAsked === m.id) (lastAsked = null), refreshTray();
      break;
    case "turn.started":
      busy.add(m.threadId);
      firstWords.add(m.threadId);
      log("turn started");
      break;
    case "message.delta":
      if (firstWords.delete(m.threadId)) log("answer: first words");
      break;
    case "turn.ended":
      busy.delete(m.threadId);
      firstWords.delete(m.threadId);
      log(`turn ended (${m.status ?? "done"})`);
      hideVoiceBarSoon(8000);
      if (m.status === "cancelled" && captionThread === m.threadId) hushCaption();
      if (!someWindowFocused() && m.status !== "cancelled" && !captionShows(m.threadId))
        notify(m.status === "error" ? "Dune Bot hit a problem" : "Dune Bot finished", titles.get(m.threadId) ?? "", () =>
          openMain(`thread:${m.threadId}`),
        );
      break;
    case "chord":
      onChord(m.kind);
      return;
    case "screen.capture":
      captureForCore(m.requestId);
      return;
    case "chord.ready":
      chord = !!m.available;
      log(`chord ${chord ? `listening (tap ${m.keys ?? "⌥⌘"} opens, hold talks)` : "unavailable"}`);
      break;
    case "chord.keys": // picked in Settings (the tray picks through setKeys)
      if (prefs["keys.chord"] !== m.name) {
        prefs = { ...prefs, "keys.chord": m.name };
        log(`keys: ${m.keys}`);
        refreshTray();
      }
      break;
    case "voice.state":
      if (m.state !== "downloading") log(`voice ${m.state}${m.message ? `: ${m.message}` : ""}`);
      if (m.state === "downloading") {
        const next = `Voice: getting ready… ${m.progress}%`;
        if (next === voiceNote) return;
        voiceNote = next;
      } else if (m.state === "ready") {
        voiceNote = "";
        if (!setupWin) notify("Voice is ready", isMac ? `Hold ${keysLabel()} and talk.` : "Hold the mic button in the bar and talk.");
      } else if (m.state === "error") {
        voiceNote = "";
        if (!bar?.isVisible() && !setupWin) notify("Dune Bot voice", m.message ?? "Something went wrong.");
        hideVoiceBarSoon(5000);
      } else return;
      break;
    case "voice.transcript":
      log(`voice heard ${m.text ? `${String(m.text).length} characters` : `nothing (${m.note ?? "no note"})`}`);
      if (!m.text) hideVoiceBarSoon(2500);
      return;
    case "schedule.ran":
      log(`schedule started: ${String(m.title).length} characters of title`);
      if (!someWindowFocused()) notify("Dune Bot started a scheduled task", String(m.title).slice(0, 120), () => openMain(`thread:${m.threadId}`));
      return;
    case "approval.request":
      waiting.set(m.threadId, (waiting.get(m.threadId) ?? 0) + 1);
      updateFollow(); // a card waiting in the answer stops it, before the page draws the card
      // The card shows in the answer beside the pointer; a chat you didn't ask from the bar puts it in
      // the screen's top corner (unless you're looking at that chat in Chats).
      if (captionShows(m.threadId)) break;
      if (!(mainWin && !mainWin.isDestroyed() && mainWin.isFocused())) {
        showCaption(m.threadId, { speak: false, corner: true });
        notify("Dune Bot needs your OK", `${m.label}: ${String(m.target).slice(0, 120)}`, () => openMain(`thread:${m.threadId}`));
      }
      break;
    case "message.updated":
      if (m.message.role === "approval" && m.message.meta.status !== "pending" && waiting.get(m.message.threadId)) {
        waiting.set(m.message.threadId, waiting.get(m.message.threadId) - 1);
        updateFollow();
        const left = [...waiting.values()].reduce((a, b) => a + b, 0);
        // A bar that popped up for the card goes away once it's answered (unless you're typing in it).
        if (!left && bar && bar.isVisible() && !barOpenedByUser && !barForVoice && !bar.isFocused()) bar.hide();
      }
      break;
    default:
      return;
  }
  refreshTray();
}

// Windows/Linux only; macOS uses the ⌥⌘ chord (no key combo that other apps already use).
function registerHotkey() {
  if (isMac) return;
  const choices = ["Control+Alt+Space", "Alt+Shift+Space", "Control+Shift+Space"];
  for (const k of choices) {
    try {
      if (globalShortcut.register(k, toggleBar)) {
        hotkey = k;
        return;
      }
    } catch {}
  }
  hotkey = null;
}

// ---------- snapshots (hidden windows, for checking the UI without touching the screen) ----------
const MEASURE = `(() => {
  const pick = ["#root > div", ".dm-card", ".dm-caption", ".dm-sidebar", "main", "header", "h1", "textarea", "button", "[class*=rounded-2xl]", "code", "p"];
  const out = [];
  for (const sel of pick)
    document.querySelectorAll(sel).forEach((el, i) => {
      if (i > 11) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const c = getComputedStyle(el);
      out.push({ sel, i, text: (el.getAttribute("title") || el.textContent || "").trim().slice(0, 40),
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        bg: c.backgroundColor, color: c.color, font: c.fontFamily.split(",")[0], size: c.fontSize, radius: c.borderRadius });
    });
  const wco = navigator.windowControlsOverlay;
  const area = wco && wco.getTitlebarAreaRect();
  return { os: document.documentElement.dataset.os, material: document.documentElement.dataset.material,
    controls: wco ? { visible: wco.visible, free: [Math.round(area.x), Math.round(area.width), Math.round(area.height)] } : null,
    dark: matchMedia("(prefers-color-scheme: dark)").matches, body: getComputedStyle(document.body).backgroundColor, parts: out };
})()`;
const SETTLE = `(async () => {
  const end = Date.now() + 10000;
  let last = "", since = Date.now();
  while (Date.now() < end) {
    const now = [...document.querySelectorAll(".md")].map((b) => b.textContent.length).join(",");
    if (now !== last) (last = now), (since = Date.now());
    else if (Date.now() - since > 600) return;
    await new Promise((r) => setTimeout(r, 100));
  }
})()`;
async function takeSnapshot(win) {
  await new Promise((r) => win.webContents.once("did-finish-load", r));
  await new Promise((r) => setTimeout(r, 900));
  const placing = win === bar && process.env.DUNEBOT_SNAPSHOT_PLACE;
  if (placing) {
    placeBar("bottom");
    barReport("placed");
  }
  const script = process.env.DUNEBOT_SNAPSHOT_SCRIPT;
  if (script) {
    try {
      // A script may hand back measurements; they're saved beside the picture.
      const result = await win.webContents.executeJavaScript(fs.readFileSync(script, "utf8"));
      if (result !== undefined) fs.writeFileSync(snapshot.replace(/\.png$/, "") + ".script.json", JSON.stringify(result, null, 1));
    } catch (err) {
      console.error("snapshot script failed:", err);
    }
    // Replies appear at a steady pace (smooth.ts): wait until no reply has changed for 600 ms.
    await win.webContents.executeJavaScript(SETTLE).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, Number(process.env.DUNEBOT_SNAPSHOT_WAIT ?? 700)));
  if (placing) barReport("resized");
  const img = await win.webContents.capturePage();
  fs.writeFileSync(snapshot, img.toPNG());
  // Beside the picture: where the main parts are and how they're drawn, to compare systems by script
  // (fonts rasterise differently on each, so pixels can't be compared).
  try {
    const parts = await win.webContents.executeJavaScript(MEASURE);
    fs.writeFileSync(snapshot.replace(/\.png$/, "") + ".json", JSON.stringify(parts, null, 1));
  } catch (err) {
    console.error("snapshot measure failed:", err);
  }
  if (followTest) {
    const f = followTest;
    log(`follow: ${f.moves} moves, ${f.sides} side changes, ${f.under} on the pointer, ${f.outside} off the screen, held for a card ${f.heldTicks} ticks with ${f.movedWhileHeld} moves`);
    if (f.grab) log(`grab: held at tick ${f.grabbedAt} after ${f.moves} moves, ${f.movedAfterGrab} moves after`);
  }
  console.log("snapshot:", snapshot);
  app.quit();
  // A window that won't close must not hold up the next picture.
  setTimeout(() => app.exit(0), 3000).unref?.();
}

// ---------- start ----------
// The app was called "Deskmate" until 2026-11-16. The core moves that folder's chats, history and
// settings to Dune Bot's (core/src/main.rs); Electron has made its new folder by now, so its old
// browser cache stays behind.
app.setName("Dunebot");
app.on("second-instance", () => showBar({ focus: true }));
nativeTheme.on("updated", () => {
  log(`system switched to ${nativeTheme.shouldUseDarkColors ? "dark" : "light"}${bar && addon ? `; bar window ${addon.windowAppearance(bar.getNativeWindowHandle())}` : ""}`);
  if (setupWin && !setupWin.isDestroyed() && !isMac) setupWin.setBackgroundColor(GLASS_PAPER());
  if (mainWin && !mainWin.isDestroyed() && !isMac) mainWin.setTitleBarOverlay(titleBarOverlay());
  refreshGlass(); // the tint is a fixed colour: swap it for the other mode's
});
async function runSelfcheck() {
  const timeout = (ms) => new Promise((_, no) => setTimeout(() => no(new Error(`no answer in ${ms} ms`)), ms));
  const r = { packaged: app.isPackaged, platform: process.platform, arch: process.arch, electron: process.versions.electron };
  r.pages = fs.existsSync(pageFile) ? "found" : `missing: ${pageFile}`;
  r.core = coreBinary();
  try {
    const hello = await Promise.race([call("hello"), timeout(15000)]);
    r.coreAnswered = `version ${hello.version} on ${hello.platform}`;
    const list = await Promise.race([call("agents.list"), timeout(20000)]);
    r.agents = (list.agents ?? []).filter((a) => a.installed).map((a) => a.id);
    if (list.problem) r.agentsProblem = list.problem;
  } catch (e) {
    r.coreAnswered = `no: ${e.message}`;
  }
  r.codemax = codemaxBinary() ?? "not bundled (agents are looked for on PATH)";
  r.addon = isMac ? (addon ? "loaded" : "not loaded") : "not used here";
  r.glass = isMac ? (liquidGlass ? "loaded" : "not loaded") : "not used here";
  const icons = Object.values(ICONS).map((f) => path.join(here, "assets", f));
  r.trayIcons = icons.every((f) => fs.existsSync(f) && !nativeImage.createFromPath(f).isEmpty()) ? "found" : `missing: ${icons.join(", ")}`;
  r.userData = app.getPath("userData");
  r.dataDir = process.env.DUNEBOT_DATA_DIR;
  const temp = (p) => !!p && path.resolve(p).startsWith(fs.realpathSync(os.tmpdir())) || !!p && path.resolve(p).startsWith(os.tmpdir());
  r.tempFolders = temp(r.userData) && temp(r.dataDir);
  r.ok = r.pages === "found" && r.coreAnswered.startsWith("version") && r.trayIcons === "found" && r.tempFolders && (!isMac || (!!addon && !!liquidGlass));
  console.log(`selfcheck ${JSON.stringify(r)}`);
  core?.stdin.end();
  app.exit(r.ok ? 0 : 1);
}

// Dune Bot is always dark, whatever the system is set to (snapshot tests can still draw light).
nativeTheme.themeSource = snapshot && process.env.DUNEBOT_SNAPSHOT_THEME ? process.env.DUNEBOT_SNAPSHOT_THEME : "dark";
app.whenReady().then(async () => {
  startCore();
  if (selfcheck) return runSelfcheck();
  if (snapshot) {
    if (process.env.DUNEBOT_SNAPSHOT_THEME) nativeTheme.themeSource = process.env.DUNEBOT_SNAPSHOT_THEME;
    if (snapView === "bar" && process.env.DUNEBOT_SNAPSHOT_HELD) createCaption(); // made at startup, as in the app
    const win =
      snapView === "bar" ? createBar() : snapView === "caption" ? createCaption() : snapView === "setup" ? openSetup() : openMain(process.env.DUNEBOT_SNAPSHOT_MAIN_VIEW ?? "chat");
    takeSnapshot(win);
    return;
  }
  if (isMac) app.dock?.hide();
  tray = new Tray(nativeImage.createFromPath(path.join(here, "assets", ICONS.idle)));
  // Windows/Linux: a left click opens the bar (macOS shows the menu).
  if (!isMac) tray.on("click", () => showBar({ focus: true }));
  registerHotkey();
  createCaption();
  log(`menu bar ready; ${isMac ? `chord ${keysLabel()}` : `hotkey ${hotkey ?? "none (taken, or blocked by the desktop)"}`}${process.platform === "linux" ? `; ${wayland ? "Wayland (keys via the desktop's shortcut portal)" : "X11"}` : ""}`);
  createBar();
  refreshTray();
  sarvamImport();
  prefs = (await call("settings.get").catch(() => ({}))).prefs ?? {};
  refreshTray();
  agentsLoaded = call("agents.list")
    .then((r) => {
      agents = r.agents ?? [];
      refreshTray();
    })
    .catch(() => {});
  log(`permissions: mic ${micStatus()}, notifications ${notificationStatus()}${isMac ? `, screen ${screenStatus()}` : ""}, setup ${prefs["setup.done"] === "1" ? "done" : "not done"}`);
  if (needsSetup()) return openSetup();
  // Say where Dune Bot lives without taking focus (keystrokes meant for another app must not reach an agent).
  setTimeout(
    () =>
      notify(
        "Dune Bot is in the menu bar",
        isMac ? (chord ? `Tap ${keysLabel()} to ask it something. Hold ${keysLabel()} to talk.` : "Click its icon to ask it something.") : hotkey ? `Press ${hotkey} to ask it something.` : "Click its icon to ask it something.",
        () => showBar({ focus: true }),
      ),
    1500,
  );
});
app.on("window-all-closed", () => {
  if (snapshot) app.quit();
  // Otherwise stay in the menu bar.
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("before-quit", () => {
  clearInterval(followTimer);
  followTimer = null;
  core?.stdin.end();
});
