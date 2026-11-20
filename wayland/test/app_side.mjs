// The app's side of Wayland against GNOME 46's own shell, portal, PipeWire and media-keys service,
// in the headless session run.sh starts: electron/wayland.mjs (GNOME's box, the saved OK, pictures,
// stop, idle, GNOME's top bar), electron/input.mjs driving it (clicks, typing, the layout check), and
// electron/gnome-keys.mjs (the bar and stop shortcuts, pressed for real). No Electron: these modules
// need only Node. A Clutter virtual pointer and keyboard made through Shell.Eval are the test's own
// hands: they answer GNOME's box and press the shortcuts the way a person would. Test-only.
//
// usage: node app_side.mjs <helper binary> <out dir>     (DUNEBOT_TEST_ELECTRON: a Linux Electron to
// run electron_guard.mjs with: the own-window guard, a picture through nativeImage, a second launch)
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWayland, ASKING } from "../../electron/wayland.mjs";
import { createInput } from "../../electron/input.mjs";
import { gnomeKeys } from "../../electron/gnome-keys.mjs";

const [HELPER, OUT] = process.argv.slice(2);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== "" ? `  (${detail})` : ""}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

const gdbus = (...args) => {
  try {
    return execFileSync("gdbus", ["call", "--session", ...args], { encoding: "utf8", timeout: 10_000 }).trim();
  } catch (e) {
    return String(e.stderr ?? e.message).trim();
  }
};
const ev = (js) => gdbus("--dest", "org.gnome.Shell", "--object-path", "/org/gnome/Shell", "--method", "org.gnome.Shell.Eval", js);
const J = "const C = imports.gi.Clutter; const G = imports.gi.GLib;";
async function handKeys(names) {
  ev(`${J} const k = global._apK; let t = G.get_monotonic_time(); const ks = '${names}'.split(' ').map(n => C['KEY_' + n]); for (const v of ks) k.notify_keyval(t += 20000, v, C.KeyState.PRESSED); for (const v of ks.reverse()) k.notify_keyval(t += 20000, v, C.KeyState.RELEASED); 'keys'`);
  await sleep(1500);
}
function portalWindows() {
  const out = ev("String(global.get_window_actors().filter(a => (a.meta_window.get_wm_class() || '').includes('portal')).length)");
  const d = (out.split(",").pop() ?? "").replace(/\D/g, "");
  return d ? Number(d) : -1;
}
const gs = (...args) => execFileSync("gsettings", args, { encoding: "utf8" }).trim();
/** screens.py: the monitors, a window's place, and GNOME's box answered like a person would. */
const screens = (...args) => JSON.parse(execFileSync("python3", ["-I", path.join(HERE, "screens.py"), ...args], { encoding: "utf8", timeout: 30_000 }));
const box = async (which) => {
  screens("box", which);
  await sleep(300);
};

/** target.py on a monitor: its lines, and `desk` from its own points to the desktop's. */
async function startTarget(monitor, secs = 600) {
  const title = monitor === 0 ? "target" : `target-${monitor}`;
  const t = lines("python3", [path.join(HERE, "target.py"), String(secs), String(monitor), title], path.join(OUT, `app-${title}.err`));
  if (!(await t.wait((l) => l === "READY", 0, 30_000))) return null;
  const at = (name) => t.all.find((l) => l.startsWith(`${name} `)).split(" ").slice(1).map(Number);
  const rect = screens("window", title);
  const k = rect.w / at("size")[0];
  return { ...t, title, rect, k, entry: at("entry"), area: at("area"), marker: at("marker"), desk: (x, y) => ({ x: rect.x + x * k, y: rect.y + y * k }) };
}

/** The marker's middle in a picture (magenta: BGRA ff 00 ff), in the picture's pixels. */
function findMarker(f) {
  let n = 0, sx = 0, sy = 0;
  for (let y = 0; y < f.height; y += 2)
    for (let x = 0; x < f.width; x += 2) {
      const i = (y * f.width + x) * 4;
      if (f.data[i] > 240 && f.data[i + 1] < 16 && f.data[i + 2] > 240) (n++, (sx += x), (sy += y));
    }
  return n ? { x: sx / n, y: sy / n, n } : null;
}

/** A child's stdout lines, with "the next line like X since mark". */
function lines(cmd, args, log, stdin = "ignore") {
  const p = spawn(cmd, args, { stdio: [stdin, "pipe", fs.openSync(log, "w")] });
  const all = [];
  let buf = "";
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      all.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  return {
    p,
    all,
    mark: () => all.length,
    async wait(pred, since = 0, ms = 10_000) {
      let hit = null;
      await until(() => (hit = all.slice(since).find(pred) ?? null) !== null, ms);
      return hit;
    },
  };
}

async function main() {
  ev(`${J} const s = C.get_default_backend().get_default_seat(); global._apK = s.create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE); 'hands'`);
  await sleep(1000);
  ev("Main.overview.hide(); 'ok'");
  const mons = screens("monitors");
  const target = await startTarget(0);
  if (!check("app: target window up", target)) return;
  const D = target.desk;
  const span = (a, b) => ({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  const [ex, ey, ew, eh] = target.entry;
  const [ax, ay, aw, ah] = target.area;

  // The saved OK, in memory here (the app locks it with the system's secret store).
  const store = { t: null, saves: 0, forgets: 0, load() { return this.t; }, save(t) { this.t = t; this.saves++; }, forget() { this.t = null; this.forgets++; } };
  const logs = [];
  let stopped = 0;
  const make = (o = {}) =>
    createWayland({ binary: HELPER, log: (...a) => (logs.push(a.join(" ")), console.log("  log:", ...a)), token: store, onStopped: () => stopped++, ...o });

  // 1. First use: no OK yet. The agent hears at once that GNOME is asking; the box stays up.
  let wl = make();
  let t = Date.now();
  let err = await wl.frame().then(() => "", (e) => e.message);
  check("first use: the agent is told GNOME is asking, at once", err === ASKING && Date.now() - t < 3000, `${Date.now() - t} ms: ${err.slice(0, 60)}`);
  await sleep(2500);
  check("first use: GNOME's box is up", portalWindows() >= 1, portalWindows());
  await box("switch");
  await box("share");
  check("after Share: the session opens by itself (no step waiting)", await until(() => wl.open, 30_000));
  check("GNOME's OK is saved once", store.saves === 1 && !!store.t, store.saves);

  // 2. A picture of the screen.
  t = Date.now();
  const f = await wl.frame().catch((e) => ({ error: e.message }));
  const m0 = mons[0];
  check(
    "picture: the main screen, every pixel, with its place in the desktop's points",
    f.data?.length >= f.width * f.height * 4 && f.width >= m0.w && f.width * m0.h === f.height * m0.w &&
      f.display?.x === m0.x && f.display?.y === m0.y && f.display?.width === m0.w && f.display?.height === m0.h,
    f.error ?? `${f.width}x${f.height} ${JSON.stringify(f.display)} for ${JSON.stringify(m0)} in ${Date.now() - t} ms`,
  );
  const colours = new Set();
  for (let i = 0; f.data && i < f.data.length; i += 4 * 997) colours.add(f.data.readUInt32LE(i));
  check("picture: has content (not one colour)", colours.size > 3, `${colours.size} colours sampled`);

  // 3. input.mjs on the helper: a click, typing, a shortcut, a character the layout lacks.
  const gaveUp = new Set();
  const input = createInput({
    addon: () => wl.addon,
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ scaleFactor: 1 }) },
    platform: "wayland",
    refuseOwn: () => {},
    refuseKeyboard: () => {},
    needAccess: () => {},
    cancelled: (id) => gaveUp.has(id),
    stub: () => false,
  });
  let m = target.mark();
  err = await input.clickAt({ ...D(ax + 200, ay + 150), requestId: "a" }).then(() => "", (e) => e.message);
  let line = await target.wait((l) => l.startsWith("press 1 "), m, 5000);
  const got = line?.split(" ").slice(2, 4).map(Number);
  check("click through input.mjs lands where asked (gliding there)", got && Math.abs(got[0] - (ax + 200)) <= 1 && Math.abs(got[1] - (ay + 150)) <= 1, err || line);

  // 3a. The whole way round, on every monitor: a picture, the marker found in it, its place turned
  // into the desktop's points as the core does (tools.rs Shot::point: the picture's place plus its
  // pixels times points per pixel), clicked through input.mjs; the window says the marker was hit.
  for (const [i, mon] of mons.entries()) {
    const t = i === 0 ? target : await startTarget(i);
    if (!check(`monitor ${i}: a window there`, t && t.rect.monitor === i, t ? JSON.stringify(t.rect) : "no window")) continue;
    // The picture is of the screen Dune Bot last pointed at: point at this one first.
    if (i > 0) await input.clickAt({ ...t.desk(t.area[0] + 40, t.area[1] + 40), requestId: `on${i}` });
    const pic = await wl.frame().catch((e) => ({ error: e.message }));
    check(
      `monitor ${i}: the picture is of this monitor`,
      pic.display?.x === mon.x && pic.display?.y === mon.y && pic.display?.width === mon.w && pic.display?.height === mon.h,
      pic.error ?? `${JSON.stringify(pic.display)} for ${JSON.stringify(mon)}`,
    );
    const mk = pic.error ? null : findMarker(pic);
    if (!check(`monitor ${i}: the marker is in the picture`, mk, pic.error ?? `${pic.width}x${pic.height}`)) continue;
    const per = pic.display.width / pic.width;
    const pt = { x: pic.display.x + mk.x * per, y: pic.display.y + mk.y * per };
    const mm = t.mark();
    err = await input.clickAt({ ...pt, requestId: `mk${i}` }).then(() => "", (e) => e.message);
    const hit = await t.wait((l) => l.startsWith("press 1 "), mm, 5000);
    const [hx, hy] = hit?.split(" ").slice(2, 4).map(Number) ?? [];
    const [mx, my, mw, mh] = t.marker;
    check(
      `monitor ${i} (scale ${mon.scale}): a point found in the picture, clicked, lands on it`,
      hit && hx >= mx - 1 && hx <= mx + mw + 1 && hy >= my - 1 && hy <= my + mh + 1,
      err || `${hit} for marker ${t.marker}; picture ${pic.width}x${pic.height} at ${JSON.stringify(pic.display)}; sent ${JSON.stringify(pt)}`,
    );
    if (i > 0) t.p.kill();
  }
  await input.clickAt({ ...D(ex + ew / 2, ey + eh / 2), requestId: "b" });
  await sleep(300);
  const text = "Hi there, World! (a+b) ~ 42";
  m = target.mark();
  err = await input.typeText({ text, requestId: "c" }).then(() => "", (e) => e.message);
  check("typing through input.mjs arrives exactly", await target.wait((l) => l === `text '${text}'`, m, 10_000), err);
  m = target.mark();
  await input.pressKeys({ key: "a", mods: ["ctrl"], times: 1, requestId: "d" });
  await input.pressKeys({ key: "backspace", mods: [], times: 1, requestId: "e" });
  check("Ctrl+A then Backspace through input.mjs clear the box", await target.wait((l) => l === "text ''", m, 5000));
  m = target.mark();
  err = await input.typeText({ text: "ok ж", requestId: "f" }).then(() => "", (e) => e.message);
  await sleep(800);
  check(
    "a character the layout lacks: nothing typed, the layout named",
    /^Nothing was typed/.test(err) && /English \(US\)/.test(err) && !target.all.slice(m).some((l) => l.startsWith("text 'o")),
    err,
  );

  // 4. The stop key (or the tray): a step under way ends; the next request opens again with the
  // saved OK, no box.
  wl.stop();
  await sleep(600);
  check("stop: the session closes", !wl.open);
  m = target.mark();
  err = await input.clickAt({ ...D(ax + 100, ay + 100), requestId: "g" }).then(() => "", (e) => e.message);
  await sleep(500);
  check("stop: a step that was under way doesn't click (or reopen)", /^Stopped/.test(err) && !wl.open && !target.all.slice(m).some((l) => l.startsWith("press")), err);
  wl.begin();
  t = Date.now();
  err = await wl.frame().then(() => "", (e) => e.message);
  check("the next request opens again with the saved OK, no box", !err && wl.open && portalWindows() === 0, err || `${Date.now() - t} ms`);
  // A cancel from the core reaches a glide on its way.
  gaveUp.add("h");
  m = target.mark();
  err = await input.clickAt({ ...D(ax + 400, ay + 300), requestId: "h" }).then(() => "", (e) => e.message);
  await sleep(500);
  check("a step the chat gave up on doesn't click", /^Stopped/.test(err) && !target.all.slice(m).some((l) => l.startsWith("press")), err);
  // Scrolling: dy -1 is down and +1 up, as on every other system (scripts/check_input_live.mjs).
  const down = (l) => l === "scroll down" || (/^scroll smooth /.test(l) && Number(l.split(" ")[3]) > 0);
  const up = (l) => l === "scroll up" || (/^scroll smooth /.test(l) && Number(l.split(" ")[3]) < 0);
  m = target.mark();
  err = await input.scrollAt({ ...D(ax + 300, ay + 200), dx: 0, dy: -1, notches: 2, requestId: "s1" }).then(() => "", (e) => e.message);
  check("scroll through input.mjs: dy -1 scrolls down", await target.wait(down, m, 5000), err || target.all.slice(m).join(" | "));
  m = target.mark();
  await input.scrollAt({ ...D(ax + 300, ay + 200), dx: 0, dy: 1, notches: 2, requestId: "s2" });
  check("scroll through input.mjs: dy +1 scrolls up", await target.wait(up, m, 5000), target.all.slice(m).join(" | "));
  // A drag: down, moves, up where asked.
  m = target.mark();
  err = await input.dragFrom({ ...span(D(ax + 100, ay + 100), D(ax + 500, ay + 260)), requestId: "d1" }).then(() => "", (e) => e.message);
  line = await target.wait((l) => l.startsWith("release 1 "), m, 5000);
  const rel = line?.split(" ").slice(2, 4).map(Number);
  check(
    "drag through input.mjs: pressed, moved, let go where asked",
    target.all.slice(m).some((l) => l.startsWith("press 1 ")) && target.all.slice(m).some((l) => l.startsWith("drag-motion")) && rel && Math.abs(rel[0] - (ax + 500)) <= 1 && Math.abs(rel[1] - (ay + 260)) <= 1,
    err || line,
  );
  // Stopped mid-drag: the button is let go (the helper lets go of everything as its session closes).
  m = target.mark();
  const dragging = input.dragFrom({ ...span(D(ax + 120, ay + 120), D(ax + 900, ay + 400)), requestId: "d2" }).then(() => "", (e) => e.message);
  await target.wait((l) => l.startsWith("drag-motion"), m, 5000);
  wl.stop();
  err = await dragging;
  check("a stop mid-drag: the drag ends and the button is let go", /^Stopped/.test(err) && (await target.wait((l) => l.startsWith("release 1 "), m, 5000)), err);
  wl.quit();

  await sleep(1000);

  // 5. Unused, the session closes by itself (GNOME's dot goes).
  wl = make({ idleMs: 1500 });
  wl.begin();
  await wl.frame();
  check("idle: open after a picture", wl.open);
  await sleep(2600);
  check("idle: closes by itself", !wl.open && logs.some((l) => /closing the session \(idle\)/.test(l)));

  // 6. GNOME's top bar: the agents stop and the OK is taken back (GNOME asks again next time).
  wl.begin();
  await wl.frame();
  ev("Main.panel.statusArea.screenSharing._stopSharing(); 'ok'");
  check("top bar stop: the agents are stopped", await until(() => stopped === 1, 5000), stopped);
  check("top bar stop: the saved OK is forgotten", store.t === null && store.forgets === 1, store.forgets);
  wl.begin();
  err = await wl.frame().then(() => "", (e) => e.message);
  check("top bar stop: the agent is told the user stopped it", /GNOME's top bar/.test(err), err.slice(0, 80));
  await sleep(5200);
  wl.begin();
  err = await wl.frame().then(() => "", (e) => e.message);
  await sleep(2500);
  check("after a top bar stop, GNOME asks again (its box)", err === ASKING && portalWindows() >= 1, `${portalWindows()} boxes`);

  // 7. The stop key while GNOME's box is up: the box goes.
  wl.stop();
  await sleep(2500);
  check("stop while GNOME's box is up: the box goes", portalWindows() === 0, portalWindows());

  // 8. Setup's Allow waits for the answer. "Allow Remote Interaction" left off: told what to do,
  // nothing saved. Then turned on: open.
  wl.begin();
  let p = wl.ensure({ wait: true }).then(() => "open", (e) => e.message);
  await sleep(3500);
  await box("share");
  err = await p;
  check("setup: screen only (switch off) is refused, saying which switch", /Allow Remote Interaction/.test(err) && store.t === null, err.slice(0, 90));
  await sleep(1500);
  p = wl.ensure({ wait: true }).then(() => "open", (e) => e.message);
  await sleep(3500);
  await box("switch");
  await box("share");
  err = await p;
  check("setup: with the switch on, Allow opens and saves the OK", err === "open" && !!store.t, err);
  wl.quit();
  await sleep(1000);

  // 9. GNOME's shortcuts, beside one of the user's own that already uses Ctrl+Alt+Space.
  const LIST = "org.gnome.settings-daemon.plugins.media-keys";
  const ONE = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding";
  const USER = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/";
  gs("set", `${ONE}:${USER}`, "name", "the user's own");
  gs("set", `${ONE}:${USER}`, "command", "true");
  gs("set", `${ONE}:${USER}`, "binding", "<Primary><Alt>space");
  gs("set", LIST, "custom-keybindings", `['${USER}']`);
  const fired = path.join(OUT, "it's fired.txt"); // a quote and a space: the command's quoting, end to end
  fs.rmSync(fired, { force: true });
  const keys = gnomeKeys({ command: ["/bin/sh", "-c", 'echo "$1" >> "$0"', fired], log: (...a) => console.log("  log:", ...a) });
  await keys.refresh();
  check("shortcuts: none before the user says yes", !keys.status().added);
  const st = await keys.add().catch((e) => ({ error: e.message }));
  check("shortcuts: the user's Ctrl+Alt+Space is left alone; the bar gets the next free one", st.bar === "Super+Alt+Space" && st.stop === "Control+Alt+.", JSON.stringify(st));
  const list = gs("get", LIST, "custom-keybindings");
  check("shortcuts: the user's own entry stays first in GNOME's list", list.startsWith(`['${USER}'`) && /dunebot-bar/.test(list) && /dunebot-stop/.test(list), list);
  await sleep(2000);
  await handKeys("Super_L Alt_L space");
  await handKeys("Control_L Alt_L period");
  const said = fs.existsSync(fired) ? fs.readFileSync(fired, "utf8").trim().split("\n") : [];
  check("shortcuts: pressing them runs Dune Bot with --bar, then --stop", said.join(",") === "--bar,--stop", said.join(",") || "nothing ran");
  // Dune Bot moved: its shortcuts follow it. One the user removed stays removed.
  gs("set", LIST, "custom-keybindings", list.replace(/, '[^']*dunebot-stop\/'/, ""));
  const moved = gnomeKeys({ command: ["/bin/sh", "-c", 'echo "moved $1" >> "$0"', fired], log: () => {} });
  await moved.follow();
  const now = gs("get", LIST, "custom-keybindings");
  check("shortcuts: one the user removed isn't put back", /dunebot-bar/.test(now) && !/dunebot-stop/.test(now), now);
  await sleep(1500);
  await handKeys("Super_L Alt_L space");
  const said2 = fs.existsSync(fired) ? fs.readFileSync(fired, "utf8").trim().split("\n") : [];
  check("shortcuts: after a move, the bar's key runs the new place", said2.at(-1) === "moved --bar", said2.at(-1));

  // 10. Real Electron: the own-window guard, a picture through nativeImage, a second launch.
  const ELECTRON = process.env.DUNEBOT_TEST_ELECTRON;
  if (check("electron: a Linux Electron to run (DUNEBOT_TEST_ELECTRON)", ELECTRON && fs.existsSync(ELECTRON), ELECTRON ?? "not set")) {
    const flags = ["--ozone-platform=wayland", "--no-sandbox", "--disable-gpu"];
    const el = lines(ELECTRON, [...flags, path.join(HERE, "electron_guard.mjs"), `--helper=${HELPER}`], path.join(OUT, "electron.err"), "pipe");
    const send = (o) => el.p.stdin.write(`${JSON.stringify(o)}\n`);
    const next = async (key, since, ms = 15_000) => {
      const l = await el.wait((x) => x.startsWith("{") && key in JSON.parse(x), since, ms);
      return l ? JSON.parse(l) : null;
    };
    const up = await next("ready", 0, 30_000);
    if (up?.late?.length) console.log(`note: shown before they painted (ready-to-show never came): ${up.late.join(", ")}`);
    if (check("electron: windows up", up)) {
      // Where GNOME put them can't be read from Electron on Wayland: the shell places them.
      ev(`global.get_window_actors().map(a => a.meta_window).forEach(w => { if (w.get_title() === 'dunebot-guard') w.move_frame(true, ${100 * target.k}, ${120 * target.k}); if (w.get_title() === 'dunebot-card') w.move_frame(true, ${760 * target.k}, ${120 * target.k}); }); 'ok'`);
      await sleep(1000);
      // "title x y" per window, joined by ";" (nothing in it that GVariant's printout escapes).
      const out = ev(`global.get_window_actors().map(a => a.meta_window).filter(w => (w.get_title() || '').startsWith('dunebot-')).map(w => { const r = w.get_frame_rect(); return [w.get_title(), Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)].join(' '); }).join(';')`);
      const rows = (out.match(/'([^']*)'/)?.[1] ?? "").replace(/^"|"$/g, "");
      const mid = Object.fromEntries(rows.split(";").filter(Boolean).map((r) => r.split(" ")).map(([t, x, y]) => [t, [Number(x), Number(y)]]));
      if (check("electron: both windows found on screen", mid["dunebot-guard"] && mid["dunebot-card"], `${JSON.stringify(mid)} from ${String(out).slice(0, 200)}`)) {
        let k = el.mark();
        send({ token: store.t });
        check("electron: opened with the saved OK", await next("open", k), el.all.slice(k).join(" | ").slice(0, 300));
        // Clicking the target raises it over Dune Bot's windows (GNOME ignores always-on-top on
        // Wayland): put them back on top, without the keyboard, as they'd be over the app in use.
        const ontop = async () => {
          ev(`global.get_window_actors().map(a => a.meta_window).filter(w => (w.get_title() || '').startsWith('dunebot-')).forEach(w => w.raise()); 'ok'`);
          await sleep(400);
        };
        const click = async (title, guard, settle = 0, at = mid[title]) => {
          await sleep(settle);
          if (at === mid[title]) await ontop(); // a click that went through raised the target
          const t0 = target.mark();
          const e0 = el.mark();
          send({ click: at, guard });
          const r = await next("clicked", e0);
          return { r, page: el.all.slice(e0).some((x) => x.includes(`"page_click":"${title}"`)), under: target.all.slice(t0).some((x) => x.startsWith("press 1 ")) };
        };
        const ask = async (o, key) => {
          const e0 = el.mark();
          send(o);
          return { ...(await next(key, e0)), lines: el.all.slice(e0) };
        };
        // A spot on the target, clear of both windows.
        const free = Object.values(D(ax + 40, ay + ah - 40));
        const K = target.k;
        const clear = (p) => Object.entries(mid).every(([t, [x, y]]) => Math.abs(p[0] - x) > (t === "dunebot-guard" ? 250 : 160) * K || Math.abs(p[1] - y) > (t === "dunebot-guard" ? 170 : 110) * K);
        check("electron: a spot on the target clear of Dune Bot's windows", clear(free), JSON.stringify({ free, mid }));
        const seen = {};
        for (const title of ["dunebot-guard", "dunebot-card"]) {
          // (a) The pointer coming from the target: the click goes through, or is swallowed and reported.
          await ask({ park: free }, "parked");
          let c = await click(title, false, 0, free);
          await ontop();
          const before = await ask({ focus: true }, "focused");
          check(`electron ${title}: the target has the keyboard to start with`, c.under && before.focused === null, JSON.stringify({ c, before }));
          await ask({ park: free }, "parked");
          c = await click(title, true);
          seen[`${title} from outside`] = c.under ? "went through" : c.r?.hit ? "swallowed, reported" : "neither";
          check(`electron ${title} (pointer from outside): nothing in the window is pressed`, !c.page, JSON.stringify(c));
          check(`electron ${title} (pointer from outside): went through or was reported`, c.under || c.r?.hit === title, JSON.stringify(c));
          // The keyboard after it: Dune Bot refuses keys while one of its windows has the keyboard; if
          // none says it has it, a key must not reach the page.
          const k1 = await ask({ key: "space" }, "keyed");
          const keyed = k1.lines.some((x) => x.includes(`"page_key":"${title}"`));
          seen[`${title} keyboard after`] = `${k1.focused ?? "none of Dune Bot's"} has it${keyed ? ", the page got the key" : ""}`;
          check(`electron ${title}: after it, a key is refused (Dune Bot's window has the keyboard) or never reaches the page`, k1.focused !== null || !keyed, JSON.stringify({ focused: k1.focused, keyed }));
          // (b) A plain click: the window takes it (and the keyboard); then the pointer is on it.
          c = await click(title, false, 300);
          const f = await ask({ focus: true }, "focused");
          check(`electron ${title}: without the guard, a click lands on the window (the check sees it)`, c.page && !c.under, JSON.stringify({ c, focused: f.focused }));
          seen[`${title} focus after a plain click`] = f.focused ?? "none of Dune Bot's";
          // (c) The pointer already on the window (electron#51808): at 100% GNOME keeps sending it there,
          // so it's swallowed and must be reported; at 200% it goes through to the app. Either way,
          // never a press in Dune Bot's window and never lost. The app in use has the keyboard first.
          await click(title, false, 0, free);
          await ask({ park: mid[title] }, "parked");
          c = await click(title, true, 1500);
          seen[`${title} from inside`] = c.under ? "went through" : c.r?.hit ? "swallowed, reported" : "neither";
          check(`electron ${title} (pointer already on it): nothing in it pressed; went through or was reported`, !c.page && (c.under || c.r?.hit === title), JSON.stringify(c));
          // A swallowed click may still hand Dune Bot's window the keyboard (GNOME focuses on click).
          const k2 = await ask({ key: "space" }, "keyed");
          const keyed2 = k2.lines.some((x) => x.includes(`"page_key":"${title}"`));
          seen[`${title} keyboard after a swallowed click`] = `${k2.focused ?? "none of Dune Bot's"} has it${keyed2 ? ", the page got the key" : ""}`;
          check(`electron ${title}: after a swallowed click, a key is refused or never reaches the page`, k2.focused !== null || !keyed2, JSON.stringify({ focused: k2.focused, keyed: keyed2 }));
          c = await click(title, false, 500);
          check(`electron ${title}: after the step, the window takes clicks again`, c.page && !c.under, JSON.stringify(c));
          if (!(c.page && !c.under)) {
            // Which parts of it take clicks now: a smaller area (input region in the wrong units), or none.
            const [w0, h0] = (title === "dunebot-guard" ? [480, 320] : [300, 200]).map((v) => v * K);
            const [cx, cy] = mid[title];
            const where = [];
            for (const f of [0.1, 0.3, 0.45, 0.6, 0.9]) {
              const at = [Math.round(cx - w0 / 2 + w0 * f), Math.round(cy - h0 / 2 + h0 * f)];
              const p = await click(title, false, 300, at);
              where.push(`${f}:${p.page ? "window" : p.under ? "through" : "lost"}`);
            }
            console.log(`note: ${title} after the step, across its diagonal: ${where.join(" ")}`);
          }
        }
        // Scrolling: with the pointer already on the window (the wheel shield runs), then from outside.
        for (const [label, from] of [["already on it", mid["dunebot-guard"]], ["from outside", free]]) {
          await ask({ park: from }, "parked");
          await ontop();
          const t0 = target.mark();
          const sc = await ask({ scroll: mid["dunebot-guard"] }, "scrolled");
          const wheeled = sc.lines.some((x) => x.includes('"page_wheel"'));
          const through = target.all.slice(t0).some((x) => x.startsWith("scroll"));
          seen[`scroll ${label}`] = through ? "went through" : sc.hit ? "swallowed, reported" : "neither";
          check(
            `electron: a guarded scroll over the window (pointer ${label}): the page gets no wheel; went through or was reported`,
            !wheeled && (through || sc.hit === "dunebot-guard"),
            JSON.stringify({ hit: sc.hit, wheeled, through }),
          );
        }
        console.log(`note: what GNOME did: ${JSON.stringify(seen)}`);
        await ontop();
        k = el.mark();
        send({ pixel: mid["dunebot-guard"] });
        const px = await next("pixel", k);
        check(
          "electron: a picture through createFromBitmap keeps its colours (red stays red)",
          px && px.pixel[0] < 16 && px.pixel[1] < 16 && px.pixel[2] > 239 && px.size.width === f.width && px.jpeg > 1000,
          JSON.stringify(px),
        );
        k = el.mark();
        const second = spawn(ELECTRON, [...flags, path.join(HERE, "electron_guard.mjs"), "--stop"], { stdio: "ignore" });
        const ended = await new Promise((r) => {
          const t = setTimeout(() => r("still running"), 15_000);
          second.on("exit", (code) => (clearTimeout(t), r(code)));
        });
        const got = await next("second_instance", k, 5000);
        check("electron: a second launch with --stop reaches the running app, and ends", got?.second_instance?.includes("--stop") && ended === 0, `${JSON.stringify(got)}, second launch exit ${ended}`);
      }
      send({ quit: true });
      await sleep(1500);
    }
    el.p.kill();
  }

  // Note only: does locking the screen end the session (so "closed" would wrongly blame the user)?
  const lockStore = { ...store, forget() {} };
  wl = createWayland({ binary: HELPER, log: () => {}, token: lockStore, onStopped: () => stopped++ });
  wl.begin();
  await wl.frame().catch(() => {});
  const before = stopped;
  ev("Main.screenShield.lock(false); 'locked'");
  await sleep(4000);
  console.log(`note: locking the screen ${stopped > before ? "ENDED" : "did not end"} the session (open: ${wl.open})`);
  wl.quit();
  target.p.kill();

}

await main().catch((e) => check("app side ran to the end", false, e.stack));
fs.writeFileSync(path.join(OUT, "app-results.json"), JSON.stringify(results, null, 1));
const bad = results.filter((r) => !r.ok);
console.log(`app side: ${results.length - bad.length}/${results.length} passed${bad.length ? `; failed: ${JSON.stringify(bad.map((r) => r.name))}` : ""}`);
process.exit(bad.length || !results.length ? 1 : 0);
