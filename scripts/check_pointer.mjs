// Checks the highlight an agent points with when it teaches (electron/pointer.mjs) with fake windows,
// nothing on the real screen: where its window goes, what happens on Wayland (no window, a sentence
// for the agent), the window it makes (click-through, never focusable, kept out of pictures), and
// when it goes.   node scripts/check_pointer.mjs
//
// The hidden-window run (the real page, the core and the test agent, a stand-in click under the
// highlight) is in the snapshot suite: DUNEBOT_SNAPSHOT_ONLY=pointer node scripts/snapshots.mjs <folder>,
// which reads its log with `pointerRun` below.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPointer, layout } from "../electron/pointer.mjs";

/** What the snapshot suite's "pointer" run must show in its log: the highlight up, hidden while the
 * second picture was taken, and the stand-in click at a point inside the highlight's window, never
 * refused as Dune Bot's own. */
export function pointerRun(log) {
  const problems = [];
  const shown = log.match(/pointer: shown, ring (-?\d+),(-?\d+) (\d+)x(\d+) in window (-?\d+),(-?\d+) (\d+)x(\d+)/);
  const click = log.match(/input: stand-in click ×1 at (-?\d+),(-?\d+)/);
  if (!shown) problems.push("the highlight was never shown (no \"pointer: shown\" line)");
  if (!/pointer: hidden while a picture of the screen is taken/.test(log)) problems.push("the highlight wasn't hidden while the second picture was taken");
  if (/Dune Bot's own/.test(log)) problems.push(`a click under the highlight was refused as Dune Bot's own: ${log.match(/.*Dune Bot's own.*/)?.[0]}`);
  if (!click) problems.push("the stand-in click never happened");
  let note = "";
  if (shown && click) {
    const [wx, wy, ww, wh] = shown.slice(5, 9).map(Number);
    const [cx, cy] = click.slice(1, 3).map(Number);
    if (!(cx >= wx && cx < wx + ww && cy >= wy && cy < wy + wh)) problems.push(`the click (${cx},${cy}) wasn't under the highlight's window (${wx},${wy} ${ww}x${wh}), so the check proves nothing`);
    else note = ` pointed, kept out of the picture, clicked under it at ${cx},${cy} (window ${wx},${wy} ${ww}x${wh}), not refused`;
  }
  return { problems, note };
}

async function main() {
  let failed = 0;
  const ok = (cond, what) => {
    console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
    if (!cond) failed++;
  };
  const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

  // ---------- where the window goes ----------
  const main = { x: 0, y: 0, width: 1512, height: 982 };
  const inside = (w, b) => w.x >= b.x && w.y >= b.y && w.x + w.width <= b.x + b.width && w.y + w.height <= b.y + b.height;
  {
    const box = { x: 600, y: 300, width: 120, height: 32 };
    const l = layout(box, main);
    ok(l.side === "below" && inside(l.win, main) && l.win.width >= 300, `a box mid-screen: label below, window on the display (${JSON.stringify(l.win)})`);
    ok(l.ring.x + l.win.x === box.x && l.ring.y + l.win.y === box.y && l.ring.width === 120, `the ring sits where the box is (${JSON.stringify(l.ring)})`);
    ok(l.ring.y >= 20 && l.win.height - (l.ring.y + l.ring.height) >= 20 + 36, `room for the pulse round it and the label under it (${JSON.stringify(l)})`);
  }
  {
    const l = layout({ x: 700, y: 950, width: 60, height: 28 }, main);
    ok(l.side === "above" && inside(l.win, main), `a box at the bottom: label above, window still on the display (${JSON.stringify(l.win)})`);
  }
  {
    const l = layout({ x: 0, y: 0, width: 40, height: 22 }, main);
    ok(inside(l.win, main) && l.ring.x === 0 && l.ring.y === 0, `a box in the top left corner (the menu bar): the window stays on the display (${JSON.stringify(l)})`);
  }
  {
    const right = { x: 1512, y: -200, width: 1920, height: 1080 };
    const l = layout({ x: 3300, y: 500, width: 100, height: 30 }, right);
    ok(inside(l.win, right), `a box on a second display stays on that display (${JSON.stringify(l.win)})`);
  }
  {
    const l = layout({ x: 0, y: 0, width: 1512, height: 982 }, main);
    ok(l.win.width === 1512 && l.win.height === 982 && inside(l.win, main), `a box the size of the display: the window is the display, no bigger (${JSON.stringify(l.win)})`);
  }

  // ---------- the window, with fakes ----------
  function rig({ platform = "darwin", wayland = false, snapshot = false, ack = true } = {}) {
    const made = [];
    const handlers = {};
    const calls = [];
    const logs = [];
    class FakeWindow {
      constructor(opts) {
        this.opts = opts;
        this.visible = false;
        this.ignore = null;
        this.protectedOn = false;
        this.sent = [];
        const self = this;
        this.webContents = {
          isLoading: () => false,
          once: () => {},
          send: (ch, msg) => {
            self.sent.push([ch, msg]);
            if (ch === "pointer:show" && ack) setImmediate(() => handlers["pointer:drawn"]({ sender: self.webContents }, msg.gen));
          },
        };
        made.push(this);
      }
      setAlwaysOnTop(on, level) {
        this.level = level;
      }
      setVisibleOnAllWorkspaces(on, o) {
        this.everySpace = { on, ...o };
      }
      setIgnoreMouseEvents(...a) {
        this.ignore = a;
      }
      setContentProtection(on) {
        this.protectedOn = on;
      }
      loadURL(u) {
        this.url = u;
      }
      isDestroyed() {
        return false;
      }
      isVisible() {
        return this.visible;
      }
      showInactive() {
        this.visible = true;
      }
      hide() {
        this.visible = false;
      }
      setBounds(b) {
        this.bounds = b;
      }
    }
    const screen = { getDisplayNearestPoint: () => ({ bounds: main }) };
    const ipcMain = { on: (ch, fn) => (handlers[ch] = fn) };
    const p = createPointer({
      BrowserWindow: FakeWindow, screen, ipcMain, pageUrl: (h) => `page#${h}`, webPreferences: { sandbox: true }, harden: () => {},
      platform, wayland, snapshot, log: (...a) => logs.push(a.join(" ")), call: async (method, params) => void calls.push([method, params]), hideMs: 1, drawnMs: 60,
    });
    let n = 0;
    /** The core asks (`input.do`) and waits for the answer (`input.result`). */
    const ask = async (m) => {
      const requestId = `r${++n}`;
      const took = p.onCoreEvent({ event: "input.do", requestId, ...m });
      for (let i = 0; i < 100 && !calls.some(([, q]) => q.requestId === requestId); i++) await tick(5);
      return { took, answer: calls.find(([, q]) => q.requestId === requestId)?.[1] };
    };
    const point = (o = {}) => ask({ kind: "point", x: 600, y: 300, width: 120, height: 32, label: "the Career tab", threadId: "chatA", gen: 1, ...o });
    return { p, made, calls, logs, ask, point };
  }

  {
    const { made, point } = rig({ platform: "linux", wayland: true });
    const { took, answer } = await point();
    ok(took && made.length === 0, "Wayland: no window is ever made (the click guard would wait for it)");
    ok(/isn't available on this desktop/.test(answer?.error ?? "") && /in words/.test(answer.error), `Wayland: the agent hears it can't point there, and what to do (${answer?.error})`);
  }
  {
    const { p, made, point, ask, logs } = rig({ platform: "darwin" });
    const { took, answer } = await point();
    const w = made[0];
    ok(took && answer && !answer.error && made.length === 1, `macOS: point draws, then answers (${JSON.stringify(answer)})`);
    ok(w.opts.transparent && w.opts.frame === false && w.opts.focusable === false && w.opts.show === false && w.opts.skipTaskbar && w.opts.type === "panel", "a see-through, frameless, never-focusable panel");
    ok(w.ignore?.length === 1 && w.ignore[0] === true, `always click-through, nothing forwarded (setIgnoreMouseEvents(${w.ignore}))`);
    ok(w.protectedOn && w.level === "pop-up-menu" && w.everySpace?.visibleOnFullScreen, `content protection on, above the menu bar and Dock, on every Space (${w.level})`);
    ok(w.url === "page#pointer" && w.opts.webPreferences.sandbox && w.opts.webPreferences.backgroundThrottling === false, "the pointer page, sandboxed like the rest, drawing while hidden");
    const want = layout({ x: 600, y: 300, width: 120, height: 32 }, main);
    ok(JSON.stringify(w.bounds) === JSON.stringify(want.win) && w.visible, `placed by layout() and shown once drawn (${JSON.stringify(w.bounds)})`);
    const show = w.sent.find(([ch]) => ch === "pointer:show")[1];
    ok(show.label === "the Career tab" && JSON.stringify(show.ring) === JSON.stringify(want.ring) && show.size.width === want.win.width, `the page gets the ring in window points (${JSON.stringify(show)})`);
    ok(p.is(w) && p.up(w) && !p.is({}), "main.mjs can tell it's the highlight (its own-window check lets clicks through it)");
    ok(!logs.join("\n").includes("Career"), "the log has numbers, never the label");

    let during = null;
    const got = await p.whileHidden(async () => ((during = w.visible), "picture"));
    ok(got === "picture" && during === false && w.visible, "hidden while a picture is taken, back after");

    p.onCoreEvent({ event: "turn.started", threadId: "chatA" });
    ok(w.visible && p.up(w), "a new turn in its own chat keeps it (the user said done: the agent looks and points again)");
    p.onCoreEvent({ event: "turn.started", threadId: "chatB" });
    ok(!w.visible && !p.up(w), "a turn in another chat takes it away");

    await point({ gen: 2 });
    ok(p.onCoreEvent({ event: "pointer.clear", gen: 1 }) && w.visible, "the core's timer for an older highlight leaves the newer one");
    p.onCoreEvent({ event: "pointer.clear", gen: 2 });
    ok(!w.visible, "the core's timer for this one takes it away");

    await point({ gen: 3 });
    p.onCoreEvent({ event: "turn.ended", threadId: "chatA", status: "done" });
    ok(w.visible, "the turn ending keeps it: the user does the step now");
    p.onCoreEvent({ event: "turn.ended", threadId: "chatA", status: "cancelled" });
    ok(!w.visible, "Stop in its chat takes it away");

    await point({ gen: 4 });
    p.onCoreEvent({ event: "thread.deleted", id: "chatA" });
    ok(!w.visible, "deleting its chat takes it away");

    await point({ gen: 5 });
    p.clear("every agent was stopped");
    ok(!w.visible, "stopping every agent takes it away");

    await point({ gen: 6 });
    const un = await ask({ kind: "unpoint", gen: 7 });
    ok(un.took && !un.answer.error && !w.visible && !p.up(w), "clear_pointer takes it away and answers");
    ok(made.length === 1, "one window, made once and reused");

    const bad = await point({ width: 0, gen: 8 });
    ok(/no place was given/.test(bad.answer.error ?? ""), `a box with no size is refused (${bad.answer.error})`);
    ok(p.onCoreEvent({ event: "input.do", kind: "click", requestId: "c" }) === false, "clicks and keys stay with input.mjs");
    ok(p.onCoreEvent({ event: "message.updated" }) === false, "other events pass on");
  }
  {
    const { made, point } = rig({ platform: "win32" });
    await point();
    ok(made[0].protectedOn && made[0].opts.type === undefined, "Windows: kept out of captures by the system too");
  }
  {
    const { made, point } = rig({ platform: "linux" });
    await point();
    ok(!made[0].protectedOn && made[0].visible, "Linux (X11): no content protection to ask for; hidden for pictures instead");
  }
  {
    const { p, made, point } = rig({ snapshot: true });
    await point();
    ok(!made[0].visible && p.up(made[0]), "a hidden-window run never shows it, but it counts as up (so the own-window check is tested)");
  }
  {
    const { p, made, point } = rig({ ack: false });
    const { answer } = await point();
    ok(/couldn't draw the highlight/.test(answer.error ?? "") && !made[0].visible && !p.up(made[0]), `a page that never draws: never shown, and the agent is told (${answer.error})`);
  }

  // ---------- the log check itself ----------
  const good = "pointer: shown, ring 700,400 265x53 in window 680,376 314x137\npointer: hidden while a picture of the screen is taken\ninput: stand-in click ×1 at 832,426";
  ok(pointerRun(good).problems.length === 0, "the log check passes a good run");
  ok(pointerRun(good.replace("832,426", "100,100")).problems.some((s) => /proves nothing/.test(s)), "the log check fails a click that wasn't under the highlight");
  ok(pointerRun(good + "\ninput: click: That point is on Dune Bot's own window").problems.some((s) => /refused/.test(s)), "the log check fails a refused click");

  console.log(failed ? `${failed} FAILED` : "ALL PASS");
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
