// The mouse and keyboard for agents (the core's click, scroll, drag, type_text and press_keys), at a
// person's pace, on every system: the addon posts the events (Quartz, SendInput, XTest). What may be
// touched is decided by the hooks: main.mjs passes its checks (never Dune Bot's own windows or
// keyboard); scripts/check_input_live.mjs drives a test window of its own on CI.

/**
 * @param {object} h
 * @param {() => any} h.addon the native addon (pointerGlide, pointerPress, pointerButton, scrollAt, keyText, keyCode)
 * @param {Electron.Screen} h.screen
 * @param {string} [h.platform]
 * @param {(x: number, y: number, verb: string) => void} h.refuseOwn throws when a point is Dune Bot's own
 * @param {() => void} h.refuseKeyboard throws when Dune Bot has the keyboard
 * @param {() => void} h.needAccess throws when the system won't let it
 * @param {(requestId: string) => boolean} h.cancelled
 * @param {() => any} h.stub a stand-in run: log, don't touch anything
 */
export function createInput(h) {
  const platform = h.platform ?? process.platform;
  const mac = platform === "darwin";

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const between = (lo, hi) => lo + Math.random() * (hi - lo);
  /** A point as the system's input calls count it: Electron's screen points on macOS, the desktop's
   * physical pixels on Windows and Linux. */
  function nativePoint(x, y) {
    if (platform === "win32") return h.screen.dipToScreenPoint({ x, y });
    if (platform === "linux") {
      const s = h.screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).scaleFactor || 1;
      return { x: Math.round(x * s), y: Math.round(y * s) };
    }
    return { x, y };
  }

  /** What's at the point, as the system's accessibility labels it (macOS; "" elsewhere, or when it
   * doesn't answer quickly). It never holds the click up for long and never stops it. */
  async function elementAt(at) {
    const f = h.addon()?.elementAt;
    if (typeof f !== "function") return "";
    try {
      return String((await Promise.race([f(at.x, at.y), wait(600).then(() => "")])) ?? "").slice(0, 160);
    } catch {
      return "";
    }
  }

  // Windows drops input sent to an app run as administrator and still reports success, so those
  // are refused up front rather than claimed done. "Can't tell" goes ahead.
  const ADMIN =
    "That window belongs to an app running as administrator, and Windows doesn't let other apps click or type into it. Ask the user to do this step themselves.";
  function refuse(x, y, verb) {
    h.refuseOwn(x, y, verb);
    const f = platform === "win32" ? h.addon()?.adminAt : null;
    if (typeof f !== "function") return;
    const at = nativePoint(x, y);
    if (f(at.x, at.y) === 1) throw new Error(ADMIN);
  }
  function refuseKeys() {
    h.refuseKeyboard();
    const f = platform === "win32" ? h.addon()?.adminFront : null;
    if (typeof f === "function" && f() === 1)
      throw new Error("The app in front runs as administrator, and Windows doesn't let other apps type into it. Ask the user to type this themselves.");
  }

  const TAKEN =
    "The user moved the mouse while Dune Bot was using it, so Dune Bot stopped. Don't do it again unless they ask.";
  function check(r, what) {
    if (r === 2) throw new Error(TAKEN);
    if (r !== 0) throw new Error(`Dune Bot couldn't ${what}.`);
  }

  /** The pointer glides to the point as a hand would; then, Dune Bot's windows checked again (one may
   * have come up meanwhile), the step itself. */
  async function glideTo(x, y, verb) {
    const at = nativePoint(x, y);
    check(await h.addon().pointerGlide(at.x, at.y, false), "move the pointer there");
    refuse(x, y, verb);
  }

  async function clickAt({ x, y, button, count }) {
    const right = button === "right";
    const twice = count === 2 ? 2 : 1;
    refuse(x, y, "clicks");
    // Checks: a stand-in that only logs the point. A test run never touches the real screen.
    if (h.stub()) return `stand-in ${right ? "right " : ""}click ×${twice} at ${Math.round(x)},${Math.round(y)}`;
    h.needAccess();
    await glideTo(x, y, "clicks");
    const at = nativePoint(x, y);
    const under = await elementAt(at);
    check(await h.addon().pointerPress(at.x, at.y, right, twice), "click there");
    // The log keeps where (numbers only); the agent also gets what was there.
    return { log: `${right ? "right " : ""}click ×${twice} at ${Math.round(x)},${Math.round(y)}`, note: under };
  }

  async function scrollAt({ x, y, dx, dy, notches }) {
    refuse(x, y, "scrolls");
    const n = Math.max(1, Math.min(30, Math.round(notches) || 6));
    if (h.stub()) return `stand-in scroll ${dx},${dy} ×${n} at ${Math.round(x)},${Math.round(y)}`;
    h.needAccess();
    await glideTo(x, y, "scrolls");
    const at = nativePoint(x, y);
    check(await h.addon().scrollAt(at.x, at.y, Math.sign(dx) | 0, Math.sign(dy) | 0, n), "scroll there");
    return `scroll ${dx},${dy} ×${n}`;
  }

  async function dragFrom({ x1, y1, x2, y2 }) {
    refuse(x1, y1, "drags");
    refuse(x2, y2, "drops onto");
    if (h.stub()) return `stand-in drag ${Math.round(x1)},${Math.round(y1)} → ${Math.round(x2)},${Math.round(y2)}`;
    h.needAccess();
    await glideTo(x1, y1, "drags");
    const from = nativePoint(x1, y1);
    if (!h.addon().pointerButton(from.x, from.y, true)) throw new Error("Dune Bot couldn't press the mouse button.");
    // From here on the button is let go whatever happens: never left held down.
    try {
      await wait(between(120, 200));
      const to = nativePoint(x2, y2);
      check(await h.addon().pointerGlide(to.x, to.y, true), "drag there");
      refuse(x2, y2, "drops onto");
      await wait(between(100, 180));
    } finally {
      const now = h.screen.getCursorScreenPoint();
      const at = nativePoint(now.x, now.y);
      h.addon().pointerButton(at.x, at.y, false);
    }
    return "drag";
  }

  // The keys press_keys knows, per system (a US layout's places). macOS: virtual key codes, the
  // modifiers as flags on the key's own events. Windows: virtual key codes (+0x100: an extended key,
  // like the arrows). Linux: X key symbols. On Windows and Linux the modifiers are pressed as keys.
  const MAC_KEYS = {
    a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
    1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, "=": 24, 9: 25, 7: 26, "-": 27, 8: 28, 0: 29, "]": 30, o: 31, u: 32,
    "[": 33, i: 34, p: 35, enter: 36, l: 37, j: 38, "'": 39, k: 40, ";": 41, "\\": 42, ",": 43, "/": 44, n: 45, m: 46,
    ".": 47, tab: 48, space: 49, "`": 50, backspace: 51, escape: 53, f5: 96, f6: 97, f7: 98, f3: 99, f8: 100, f9: 101,
    f11: 103, f10: 109, f12: 111, home: 115, pageup: 116, forwarddelete: 117, f4: 118, end: 119, f2: 120, pagedown: 121,
    f1: 122, left: 123, right: 124, down: 125, up: 126,
  };
  const MAC_MODS = { shift: 0x20000, ctrl: 0x40000, option: 0x80000, cmd: 0x100000 };
  const EXT = 0x100;
  const WIN_KEYS = {
    enter: 0x0d, tab: 0x09, escape: 0x1b, space: 0x20, backspace: 0x08, forwarddelete: 0x2e | EXT,
    up: 0x26 | EXT, down: 0x28 | EXT, left: 0x25 | EXT, right: 0x27 | EXT, home: 0x24 | EXT, end: 0x23 | EXT,
    pageup: 0x21 | EXT, pagedown: 0x22 | EXT,
    "-": 0xbd, "=": 0xbb, "[": 0xdb, "]": 0xdd, "\\": 0xdc, ";": 0xba, "'": 0xde, ",": 0xbc, ".": 0xbe, "/": 0xbf, "`": 0xc0,
  };
  const WIN_MODS = { ctrl: 0x11, option: 0x12, shift: 0x10, win: 0x5b | EXT };
  const X_KEYS = {
    enter: 0xff0d, tab: 0xff09, escape: 0xff1b, space: 0x20, backspace: 0xff08, forwarddelete: 0xffff,
    up: 0xff52, down: 0xff54, left: 0xff51, right: 0xff53, home: 0xff50, end: 0xff57, pageup: 0xff55, pagedown: 0xff56,
    "-": 0x2d, "=": 0x3d, "[": 0x5b, "]": 0x5d, "\\": 0x5c, ";": 0x3b, "'": 0x27, ",": 0x2c, ".": 0x2e, "/": 0x2f, "`": 0x60,
  };
  const X_MODS = { ctrl: 0xffe3, option: 0xffe9, shift: 0xffe1, win: 0xffeb };

  /** The system's code for a key press_keys knows, or undefined. */
  function keyCodeOf(key) {
    if (mac) return MAC_KEYS[key];
    const k = String(key);
    const fn = /^f([1-9]|1[0-2])$/.exec(k);
    if (platform === "win32") {
      if (/^[a-z0-9]$/.test(k)) return k.toUpperCase().charCodeAt(0);
      if (fn) return 0x6f + Number(fn[1]);
      return WIN_KEYS[k];
    }
    if (/^[a-z0-9]$/.test(k)) return k.charCodeAt(0);
    if (fn) return 0xffbd + Number(fn[1]);
    return X_KEYS[k];
  }

  /** One key down or up (Windows: an extended key carries flag 1). */
  function keyEvent(code, flags, down) {
    if (platform === "win32") return h.addon().keyCode(code & 0xff, code & EXT ? 1 : 0, down);
    return h.addon().keyCode(code, flags, down);
  }

  /** One key down and up with its modifiers: on macOS as flags on its own events (no modifier key goes
   * down alone); on Windows and Linux the modifier keys go down first and up last, as a hand does. */
  async function tapKey(code, mods = []) {
    const held = mac ? [] : mods.map((m) => (platform === "win32" ? WIN_MODS : X_MODS)[m]).filter((c) => c !== undefined);
    const flags = mac ? mods.reduce((f, m) => f | (MAC_MODS[m] ?? 0), 0) : 0;
    const pressed = [];
    try {
      for (const m of held) {
        if (!keyEvent(m, 0, true)) throw new Error("Dune Bot couldn't press that key.");
        pressed.push(m);
        await wait(between(20, 40));
      }
      if (!keyEvent(code, flags, true)) throw new Error("Dune Bot couldn't press that key.");
      await wait(between(40, 80));
      keyEvent(code, flags, false);
    } finally {
      for (const m of pressed.reverse()) {
        await wait(between(15, 30));
        keyEvent(m, 0, false);
      }
    }
  }

  /** Before each key: not stopped, still not Dune Bot's keyboard, and the user hasn't taken the mouse. */
  function stillOurs(start, requestId) {
    if (h.cancelled(requestId)) throw new Error("Stopped: the chat stopped waiting for it.");
    refuseKeys();
    const now = h.screen.getCursorScreenPoint();
    if (Math.hypot(now.x - start.x, now.y - start.y) > 24) throw new Error(TAKEN);
  }

  async function typeText({ text, requestId }) {
    const chars = [...String(text ?? "")];
    if (!chars.length) throw new Error("Nothing to type.");
    refuseKeys();
    if (h.stub()) return `stand-in typing, ${chars.length} characters`;
    h.needAccess();
    const start = h.screen.getCursorScreenPoint();
    // A person's pace: quicker inside words, a beat after a space or a stop; long text goes faster.
    const pace = chars.length > 200 ? 0.4 : 1;
    for (const ch of chars) {
      stillOurs(start, requestId);
      if (ch === "\n") await tapKey(keyCodeOf("enter"));
      else if (ch === "\t") await tapKey(keyCodeOf("tab"));
      else {
        if (!h.addon().keyText(ch, true)) throw new Error("Dune Bot couldn't type that.");
        await wait(between(8, 20));
        h.addon().keyText(ch, false);
      }
      const after = /[.!?,;:\n]/.test(ch) ? between(120, 260) : ch === " " ? between(60, 160) : between(35, 95);
      await wait(after * pace);
    }
    return `typing, ${chars.length} characters`;
  }

  async function pressKeys({ key, mods, times, requestId }) {
    const code = keyCodeOf(key);
    if (code === undefined) throw new Error(`Dune Bot doesn't know the key "${key}".`);
    const held = (Array.isArray(mods) ? mods : []).filter((m) => ["ctrl", "option", "shift", "cmd", "win"].includes(m));
    const n = Math.max(1, Math.min(20, Math.round(times) || 1));
    const shown = `${(mods ?? []).join("+")}${mods?.length ? "+" : ""}${key}${n > 1 ? ` ×${n}` : ""}`;
    refuseKeys();
    if (h.stub()) return `stand-in keys ${shown}`;
    h.needAccess();
    const start = h.screen.getCursorScreenPoint();
    for (let i = 0; i < n; i++) {
      stillOurs(start, requestId);
      await tapKey(code, held);
      if (i < n - 1) await wait(between(80, 160));
    }
    return `keys ${shown}`;
  }

  return { nativePoint, clickAt, scrollAt, dragFrom, typeText, pressKeys, keyCodeOf };
}
