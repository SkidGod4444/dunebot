// Dictation's key for real (Windows, Linux on X11): the core watches Right Ctrl the way the app runs it
// (DUNEBOT_CHORD=1), and this script presses real keys on the runner's own screen through the native
// addon (SendInput / XTest), from outside the core, as a person's keyboard would. Checks that Right
// Ctrl held alone starts and ends a dictation, that a tap, Left Ctrl or a Ctrl shortcut never types, and that
// a shortcut after the start cancels it. Then the other key choice, "Ctrl twice" (for keyboards with no
// Right Ctrl): Ctrl tapped then held starts one; Ctrl held without the tap, a slow second press or a
// shortcut never does; and switching back brings Right Ctrl back.
//   node scripts/native.mjs && node scripts/check_dictation_keys_live.mjs [core binary]
//   (Linux: under xvfb-run)
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const win = process.platform === "win32";
if (!win && process.platform !== "linux") {
  console.log("Windows and Linux only (macOS reads Right ⌥, and pressing it needs Accessibility).");
  process.exit(0);
}
const bin = process.argv[2] ?? path.join(root, "core", "target", "debug", win ? "dunebot-core.exe" : "dunebot-core");
if (!fs.existsSync(bin)) throw new Error(`build the core first (bun run core): ${bin}`);
const addon = createRequire(import.meta.url)(path.join(root, "native", "dunebot_native.node"));

let failed = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The keys, as the addon's keyCode takes them: Windows virtual keys (Right Ctrl is an extended key),
// X keysyms on Linux. `other` is the key pressed with Ctrl: C on Linux (xvfb, nothing in front); on
// Windows F15, which nothing acts on, since the window in front there is the runner's own console
// and Ctrl+C would interrupt the runner (it lost the job once, 2026-11-21).
const K = win
  ? { rctrl: [0xa3, 1], lctrl: [0xa2, 0], other: [0x7e, 0] }
  : { rctrl: [0xffe4, 0], lctrl: [0xffe3, 0], other: [0x63, 0] };
const OTHER = win ? "F15" : "C";
const down = new Set();
const press = (k, on) => {
  const [code, flags] = K[k];
  const r = addon.keyCode(code, flags, on);
  if (on) down.add(k);
  else down.delete(k);
  return r;
};
const releaseAll = () => [...down].forEach((k) => press(k, false));
process.on("exit", releaseAll);

const data = fs.mkdtempSync(path.join(os.tmpdir(), "dunebot-dictation-keys-"));
const core = spawn(bin, [], { env: { ...process.env, DUNEBOT_DATA_DIR: data, DUNEBOT_CHORD: "1" }, stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
core.stderr.on("data", (d) => (stderr += d));
const events = [];
createInterface({ input: core.stdout }).on("line", (line) => {
  try {
    const m = JSON.parse(line);
    if (m.event) events.push(m);
  } catch {}
});
const waitFor = async (pred, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = events.find(pred);
    if (m) return m;
    await sleep(25);
  }
  throw new Error(`timed out; events: ${JSON.stringify(events.slice(-5))}\n${stderr.slice(-800)}`);
};
/** What dictation fired between `from` and now. */
const fired = (from) => events.slice(from).filter((m) => m.event === "dictation").map((m) => m.kind);
let nextId = 1;
/** Sets a pref as Settings does, and waits for the core's new dictation.ready. */
const setKey = async (value) => {
  const from = events.length;
  core.stdin.write(JSON.stringify({ id: nextId++, method: "prefs.set", params: { key: "dictation.key", value } }) + "\n");
  const m = await waitFor((e, i) => e.event === "dictation.ready" && e.key === value && events.indexOf(e) >= from);
  await sleep(300); // the poller looks at the choice on its next look
  return m;
};
/** Ctrl (`k`) tapped, `gap` ms, then held `hold` ms; what fired while held, and after. */
async function twice(k = "lctrl", { gap = 120, hold = 700, then = null } = {}) {
  const from = events.length;
  press(k, true);
  await sleep(90);
  press(k, false);
  await sleep(gap);
  press(k, true);
  if (then) {
    await sleep(60);
    press(then, true);
    await sleep(50);
    press(then, false);
  }
  await sleep(hold);
  const mid = fired(from);
  press(k, false);
  await sleep(300);
  return { mid, all: fired(from) };
}

try {
  const ready = await waitFor((m) => m.event === "dictation.ready");
  ok(ready.available === true && ready.on === true, `the core watches the key (${JSON.stringify(ready)})`);
  ok(ready.keys === "Right Ctrl", `the key is Right Ctrl (${ready.keys})`);
  await sleep(300);

  // 1. Held alone: starts after the hold, ends when let go.
  {
    const from = events.length;
    press("rctrl", true);
    await sleep(700);
    const mid = fired(from);
    press("rctrl", false);
    await sleep(300);
    ok(JSON.stringify(mid) === '["hold-start"]', `held 0.7 s: listening starts while it's held (${mid})`);
    ok(JSON.stringify(fired(from)) === '["hold-start","hold-end"]', `let go: it ends, so what was said is typed (${fired(from)})`);
  }

  // 2. A tap: nothing.
  {
    const from = events.length;
    press("rctrl", true);
    await sleep(120);
    press("rctrl", false);
    await sleep(400);
    ok(fired(from).length === 0, `a quick tap does nothing (${fired(from)})`);
  }

  // 3. Left Ctrl held: never.
  {
    const from = events.length;
    press("lctrl", true);
    await sleep(700);
    press("lctrl", false);
    await sleep(300);
    ok(fired(from).length === 0, `Left Ctrl held does nothing (${fired(from)})`);
  }

  // 4. Right Ctrl + another key quickly (a shortcut, as Ctrl+C is): nothing.
  {
    const from = events.length;
    press("rctrl", true);
    await sleep(60);
    press("other", true);
    await sleep(50);
    press("other", false);
    await sleep(600);
    press("rctrl", false);
    await sleep(300);
    ok(fired(from).length === 0, `Right Ctrl+${OTHER} (a shortcut) starts nothing, though Ctrl stays held (${fired(from)})`);
  }

  // 5. Held, then another key: the start is cancelled, nothing typed.
  {
    const from = events.length;
    press("rctrl", true);
    await sleep(600);
    press("other", true);
    await sleep(50);
    press("other", false);
    await sleep(100);
    press("rctrl", false);
    await sleep(300);
    ok(JSON.stringify(fired(from)) === '["hold-start","hold-cancel"]', `a key after the start cancels it: nothing typed (${fired(from)})`);
  }

  // 6. Again after all that: still works.
  {
    const from = events.length;
    press("rctrl", true);
    await sleep(600);
    press("rctrl", false);
    await sleep(300);
    ok(JSON.stringify(fired(from)) === '["hold-start","hold-end"]', `and again (${fired(from)})`);
  }

  // 7. The other choice, for a keyboard with no Right Ctrl: Ctrl twice.
  {
    const r = await setKey("ctrl-twice");
    ok(r.available === true && r.keys === "Ctrl twice" && r.how === "tap Ctrl, then hold it", `picked Ctrl twice (${JSON.stringify({ keys: r.keys, how: r.how, available: r.available })})`);
    ok(Array.isArray(r.choices) && r.choices.map((c) => c.name).join() === "right-ctrl,ctrl-twice", `both keys can be picked (${r.choices?.map((c) => c.name)})`);
  }
  {
    const { mid, all } = await twice("lctrl");
    ok(JSON.stringify(mid) === '["hold-start"]', `Left Ctrl tapped, then held: listening starts while it's held (${mid})`);
    ok(JSON.stringify(all) === '["hold-start","hold-end"]', `let go: it ends, so what was said is typed (${all})`);
  }
  {
    const { all } = await twice("rctrl");
    ok(JSON.stringify(all) === '["hold-start","hold-end"]', `Right Ctrl tapped, then held: the same (${all})`);
  }
  for (const k of ["lctrl", "rctrl"]) {
    const from = events.length;
    press(k, true);
    await sleep(900);
    press(k, false);
    await sleep(300);
    ok(fired(from).length === 0, `${k === "lctrl" ? "Left" : "Right"} Ctrl held without the tap does nothing (${fired(from)})`);
  }
  {
    const { all } = await twice("lctrl", { gap: 800 });
    ok(all.length === 0, `a slow second press (0.8 s after the tap) does nothing (${all})`);
  }
  {
    const { all } = await twice("lctrl", { then: "other" });
    ok(all.length === 0, `tap, then Ctrl+${OTHER} (a shortcut): nothing (${all})`);
  }
  {
    const from = events.length;
    press("lctrl", true);
    await sleep(90);
    press("lctrl", false);
    await sleep(120);
    press("lctrl", true);
    await sleep(600);
    press("other", true);
    await sleep(50);
    press("other", false);
    await sleep(100);
    press("lctrl", false);
    await sleep(300);
    ok(JSON.stringify(fired(from)) === '["hold-start","hold-cancel"]', `a key after the start cancels it: nothing typed (${fired(from)})`);
  }
  {
    const { all } = await twice("lctrl");
    ok(JSON.stringify(all) === '["hold-start","hold-end"]', `and again (${all})`);
  }

  // 8. Back to Right Ctrl: held alone works again, and a tap then hold is just a tap, then a hold.
  {
    const r = await setKey("right-ctrl");
    ok(r.keys === "Right Ctrl", `back to Right Ctrl (${r.keys})`);
    const from = events.length;
    press("rctrl", true);
    await sleep(600);
    press("rctrl", false);
    await sleep(300);
    ok(JSON.stringify(fired(from)) === '["hold-start","hold-end"]', `Right Ctrl held alone works again (${fired(from)})`);
    const l = await twice("lctrl");
    ok(l.all.length === 0, `Left Ctrl tapped then held does nothing with Right Ctrl picked (${l.all})`);
  }
} catch (e) {
  ok(false, e.message);
} finally {
  releaseAll();
  core.stdin.end();
}
await sleep(300);
console.log(failed ? `${failed} FAIL` : "ALL PASS");
process.exit(failed ? 1 : 0);
