// Dune Bot's eyes and hand on a Wayland desktop (GNOME): the dunebot-wayland helper (wayland/), which
// asks GNOME for the screen plus the keyboard and pointer in one box, remembered with a token. The
// helper runs only while an agent uses the screen or the mouse and keyboard; the session closes again
// when that has been idle a while (GNOME shows an orange dot while it's open).
//
// The token is the user's "yes" to that box: it's locked by the system keyring (Electron's
// safeStorage) and handed to the helper over its stdin only. Where there's no keyring it lives in
// memory only, and GNOME asks again after each restart.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** What Dune Bot says, for the desktop it runs on (GNOME names its box's switch; others differ). */
function words(desktop) {
  const gnome = desktop === "GNOME";
  const allow = gnome ? `turn on "Allow Remote Interaction" in it, then press Share` : "allow control of the keyboard and pointer in it, then share the screen";
  return {
    ASKING: `${desktop} is asking the user to let Dune Bot see the screen and use the keyboard and pointer (a box on their screen). Tell them to ${allow}, and that you'll go on once they have. Then try again.`,
    SCREEN_ONLY: `${desktop} gave Dune Bot the screen but not the keyboard and pointer. Tell the user ${desktop} will ask again: ${allow.replace(" in it", " in its box")}. Then try again.`,
    STOPPED: `The user stopped Dune Bot's screen sharing from ${gnome ? "GNOME's top bar" : "the desktop"}, so Dune Bot stopped. Don't use the screen, mouse or keyboard again unless they ask (${desktop} will ask them again first).`,
    CANCELLED: `The user closed ${desktop}'s box without sharing, so Dune Bot can't see the screen or use the mouse and keyboard. Tell them ${desktop} asks again next time: ${allow.replace(" in it", " in its box")}.`,
    CANCELLED_HERE: `${desktop}'s box was closed without sharing. Press Allow to see it again: ${allow.replace(" in it", " in its box")}.`,
    NO_PORTAL: `This desktop doesn't let apps see the screen and use the keyboard and pointer together (it has no remote desktop portal), so Dune Bot can't do that here. Tell the user what to do instead.`,
  };
}
/** The default words, for callers that check what the agent is told (GNOME's). */
export const ASKING = words("GNOME").ASKING;

/**
 * @param {object} o
 * @param {string} o.binary the helper
 * @param {(...a: any[]) => void} o.log
 * @param {{ load: () => string | null, save: (t: string) => void, forget: () => void }} o.token
 * @param {() => void} o.onStopped GNOME's top bar ended the session: stop the agents
 * @param {number} [o.idleMs] close the session after this long unused
 * @param {string} [o.desktop] its name, for what the user is told ("GNOME", "KDE")
 */
export function createWayland({ binary, log, token, onStopped, idleMs = 45_000, desktop = "GNOME" }) {
  const { ASKING, SCREEN_ONLY, STOPPED, CANCELLED, CANCELLED_HERE, NO_PORTAL } = words(desktop);
  let child = null;
  let buf = "";
  let nextId = 1;
  const waiting = new Map();
  let session = null; // the open answer: devices, streams, regions, hand, eyes
  let opening = null; // the open under way (GNOME's box may be up)
  let idle = null;
  let lastPoint = null; // where Dune Bot last put the pointer (the helper can't read it back)
  let blockedUntil = 0;
  let halted = false; // stopped: steps under way end at their next move, until the next request begins
  let frameDir = null;

  function start() {
    if (child) return child;
    if (!binary || !fs.existsSync(binary)) throw new Error("This build of Dune Bot has no Wayland helper, so it can't see the screen or use the mouse and keyboard here.");
    const env = { ...process.env };
    delete env.DUNEBOT_WL_DEBUG; // its debug lines are for the helper's own test
    child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], env });
    const me = child;
    // It couldn't start at all (a broken build): every request waiting fails with the reason.
    me.on("error", (e) => {
      log(`wayland helper couldn't start: ${e.message}`);
      gone(me, `Dune Bot's Wayland helper couldn't start (${e.code ?? e.message}).`);
    });
    me.stdout.setEncoding("utf8");
    me.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.event) onEvent(m);
        else if (waiting.has(m.id)) {
          const w = waiting.get(m.id);
          waiting.delete(m.id);
          clearTimeout(w.timer);
          if (m.error) w.reject(new Error(m.error));
          else w.resolve(m);
        }
      }
    });
    me.stderr.on("data", (d) => log(`wayland helper: ${String(d).trim().slice(0, 300)}`));
    me.on("exit", (code) => {
      if (code) log(`wayland helper exited (${code})`);
      gone(me, "Dune Bot's Wayland helper stopped.");
    });
    me.stdin.on("error", () => {});
    return me;
  }

  function gone(me, why) {
    if (child !== me) return;
    child = null;
    buf = "";
    session = null;
    for (const w of waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new Error(why));
    }
    waiting.clear();
  }

  function request(op, args = {}, ms = 15_000) {
    const c = start();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = ms ? setTimeout(() => (waiting.delete(id), reject(new Error(`Dune Bot's Wayland helper didn't answer (${op}).`))), ms) : null;
      waiting.set(id, { resolve, reject, timer });
      c.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
    });
  }

  function onEvent(m) {
    if (m.event === "closed") {
      // Stopping from GNOME's top bar takes the OK back: GNOME asks the user again before the next use.
      log("wayland: the session was ended from GNOME's top bar; stopping the agents");
      session = null;
      halted = true;
      blockedUntil = Date.now() + 5000;
      token.forget();
      onStopped();
    }
  }

  function touch() {
    clearTimeout(idle);
    idle = setTimeout(() => close("idle"), idleMs);
  }

  async function close(why) {
    clearTimeout(idle);
    if (!child) return;
    if (session) log(`wayland: closing the session (${why})`);
    session = null;
    await request("close", {}, 5000).catch(() => {});
  }

  /** The answer from GNOME, made into a session Dune Bot can use (or a reason it can't). */
  function accept(r) {
    if (r.devices !== 3) {
      // A "screen only" answer is remembered with its token: drop it, so GNOME asks again.
      token.forget();
      request("close", {}, 5000).catch(() => {});
      throw new Error(SCREEN_ONLY);
    }
    if (r.token) token.save(r.token);
    const { token: _t, ...rest } = r;
    session = rest;
    touch(); // opened while no step waited (GNOME's box answered later): it closes when unused too
    log(`wayland: session open (${r.streams?.length ?? 0} screen${r.streams?.length === 1 ? "" : "s"}${r.hand ? "" : `, no hand: ${r.hand_error ?? "?"}`}${r.eyes ? "" : `, no eyes: ${r.eyes_error ?? "?"}`})`);
    return session;
  }

  /** The open, started once; GNOME's box may wait on the user for as long as they like. */
  function beginOpen(saved) {
    if (opening) return opening;
    opening = request("open", saved ? { token: saved } : {}, 0)
      .catch((e) => {
        if (e.message === "cancelled") throw new Error(CANCELLED);
        // No RemoteDesktop portal on this desktop (wlroots compositors, for one): one plain sentence.
        // (Only the app-facing interface: a backend restarting says "impl.portal..." for a moment.)
        if (/ServiceUnknown|no remote-control service|No such interface\W+org\.freedesktop\.portal\.RemoteDesktop/i.test(e.message)) {
          log(`wayland: no remote desktop portal (${e.message.slice(0, 200)})`);
          throw new Error(NO_PORTAL);
        }
        throw e;
      })
      .then(accept)
      .finally(() => (opening = null));
    opening.catch((e) => log(`wayland: open: ${e.message}`));
    return opening;
  }

  /**
   * The session, opened if need be. With GNOME's "yes" saved, that takes a moment. Without it (or
   * when GNOME asks again), the box can wait on the user far longer than an agent's step: the step
   * gets ASKING at once and the box stays up, so the next try finds the session ready.
   * `wait`: the setup page's own Allow button, which waits for the answer.
   */
  async function ensure({ wait = false } = {}) {
    if (Date.now() < blockedUntil) throw new Error(STOPPED);
    if (session && child) {
      touch();
      return session;
    }
    let saved = null;
    try {
      saved = token.load();
    } catch (e) {
      log(`wayland: couldn't unlock the saved answer (${e.message})`);
    }
    const p = beginOpen(saved);
    if (wait) {
      try {
        return await p;
      } catch (e) {
        throw new Error(e.message === CANCELLED ? CANCELLED_HERE : e.message);
      }
    }
    const quick = await Promise.race([p.then(() => "open", () => "failed"), new Promise((r) => setTimeout(() => r("slow"), saved ? 4000 : 1500))]);
    if (quick === "open") {
      touch();
      return session;
    }
    if (quick === "failed") await p; // its reason
    throw new Error(ASKING);
  }

  /** A picture of one screen: BGRA pixels, the screen's place in the desktop's logical points. */
  async function frame() {
    if (halted) throw new Error("Stopped.");
    const s = await ensure();
    if (!s.eyes) throw new Error(`Dune Bot couldn't see the screen through GNOME (${s.eyes_error ?? "no picture stream"}).`);
    const streams = s.streams ?? [];
    const on = (p, st) => p && p.x >= st.x && p.y >= st.y && p.x < st.x + st.w && p.y < st.y + st.h;
    const st = streams.find((x) => on(lastPoint, x)) ?? streams.find((x) => x.x === 0 && x.y === 0) ?? streams[0];
    if (!st) throw new Error("GNOME shared no screen with Dune Bot.");
    if (!frameDir) frameDir = fs.mkdtempSync(path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), "dunebot-screen-"));
    const file = path.join(frameDir, "frame.bgra");
    try {
      const r = await request("frame", { node: st.node, path: file }, 10_000);
      const data = fs.readFileSync(file);
      if (data.length < r.w * r.h * 4) throw new Error("Dune Bot got an incomplete picture of the screen.");
      return { data, width: r.w, height: r.h, display: { x: st.x, y: st.y, width: st.w, height: st.h } };
    } finally {
      fs.rmSync(file, { force: true });
      touch();
    }
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const between = (lo, hi) => lo + Math.random() * (hi - lo);
  async function hand() {
    if (halted) throw new Error("Stopped.");
    const s = await ensure();
    if (!s.hand) throw new Error(`Dune Bot couldn't get GNOME's keyboard and pointer (${s.hand_error ?? "not given"}).`);
    if (halted) throw new Error("Stopped.");
    return s;
  }
  async function move(x, y) {
    await request("move", { x, y });
    lastPoint = { x, y };
  }

  // The same calls as the native addon (input.mjs drives both), in the desktop's logical points.
  // Answers: 0 done, 1 failed, 3 stopped. The user moving the mouse can't be seen on Wayland: the
  // stop key (or GNOME's top bar) stops Dune Bot instead.
  const addon = {
    async pointerGlide(x, y, _dragging, cancelled) {
      await hand();
      const from = lastPoint;
      const d = from ? Math.hypot(x - from.x, y - from.y) : 0;
      const steps = from ? Math.max(1, Math.min(40, Math.round(d / 30))) : 1;
      for (let i = 1; i <= steps; i++) {
        if (halted || cancelled?.()) return 3;
        const t = i / steps;
        const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // ease in and out
        await move(i === steps ? x : from.x + (x - from.x) * e, i === steps ? y : from.y + (y - from.y) * e);
        if (i < steps) await wait(between(10, 16));
      }
      return 0;
    },
    async pointerPress(x, y, right, count) {
      await hand();
      await move(x, y);
      const button = right ? "right" : "left";
      for (let i = 0; i < count; i++) {
        await request("button", { button, down: true });
        await wait(between(40, 80));
        await request("button", { button, down: false });
        if (i < count - 1) await wait(between(60, 100));
      }
      return 0;
    },
    async pointerButton(_x, _y, down) {
      await hand();
      await request("button", { button: "left", down });
      return true;
    },
    async scrollAt(x, y, dx, dy, n) {
      await hand();
      await move(x, y);
      await request("scroll", { dx, dy, n });
      return 0;
    },
    /** One character: the helper presses and lets go together (with Shift or AltGr as the layout
     * needs), so "up" has nothing left to do. Refusals carry their reason. */
    async keyText(ch, down) {
      if (!down) return true;
      await hand();
      await request("text", { ch });
      return true;
    },
    async keyCode(keysym, _flags, down) {
      await hand();
      await request("key", { keysym, down });
      return true;
    },
    /** What the active layout can't make, before anything is typed. */
    async missingChars(text) {
      await hand();
      return request("can_type", { text });
    },
  };

  return {
    ensure,
    frame,
    addon,
    /** A new request from an agent (a step, a picture): a stop before it no longer applies. */
    begin() {
      halted = false;
    },
    /** The stop key: steps under way end, the session closes. */
    stop() {
      halted = true;
      close("stopped");
    },
    quit() {
      clearTimeout(idle);
      if (child) child.stdin.end();
      if (frameDir) fs.rmSync(frameDir, { recursive: true, force: true });
    },
    get open() {
      return !!session;
    },
  };
}
