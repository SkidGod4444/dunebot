// Checks electron/input.mjs for each system with a fake addon (nothing reaches a real mouse or
// keyboard): the points it posts, the key codes it sends, the order modifiers go down and up, and
// that a stopped or taken run stops. `node scripts/check_input.mjs`
import { createInput } from "../electron/input.mjs";

let failed = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failed++;
};

function rig(platform, { cursor = { x: 0, y: 0 }, cancelled = () => false, admin = () => 0, adminFront = () => 0 } = {}) {
  const calls = [];
  const addon = {
    postEventAccess: () => true,
    pointerGlide: async (x, y, held) => (calls.push(["glide", x, y, held]), 0),
    pointerPress: async (x, y, right, count) => (calls.push(["press", x, y, right, count]), 0),
    pointerButton: (x, y, down) => (calls.push(["button", x, y, down]), true),
    scrollAt: async (x, y, dx, dy, n) => (calls.push(["scroll", x, y, dx, dy, n]), 0),
    keyText: (t, down) => (calls.push(["text", t, down]), true),
    keyCode: (code, flags, down) => (calls.push(["key", code, flags, down]), true),
    adminAt: (x, y) => admin(x, y),
    adminFront: () => adminFront(),
  };
  const screen = {
    getCursorScreenPoint: () => cursor,
    dipToScreenPoint: (p) => ({ x: Math.round(p.x * 1.5), y: Math.round(p.y * 1.5) }),
    getDisplayNearestPoint: () => ({ scaleFactor: 2 }),
  };
  const input = createInput({
    addon: () => addon,
    screen,
    platform,
    refuseOwn: () => {},
    refuseKeyboard: () => {},
    needAccess: () => {},
    cancelled,
    stub: () => false,
  });
  return { input, calls };
}
const keys = (calls) => calls.filter((c) => c[0] === "key").map(([, code, flags, down]) => `${down ? "↓" : "↑"}${code.toString(16)}${flags ? `/${flags.toString(16)}` : ""}`).join(" ");

// Points: macOS as given, Windows through the display's scale, Linux × its scale factor.
for (const [platform, want] of [["darwin", [100, 50]], ["win32", [150, 75]], ["linux", [200, 100]]]) {
  const { input, calls } = rig(platform);
  await input.clickAt({ x: 100, y: 50 });
  const g = calls.find((c) => c[0] === "glide");
  const p = calls.find((c) => c[0] === "press");
  ok(g[1] === want[0] && g[2] === want[1] && p[1] === want[0] && p[2] === want[1], `${platform}: a click lands at ${want} (${JSON.stringify(calls)})`);
}

// Windows: an app run as administrator (Windows would drop the input and say nothing) is refused
// before the pointer moves; "can't tell" (-1) goes ahead; other systems never ask.
{
  const { input, calls } = rig("win32", { admin: (x) => (x >= 300 ? 1 : 0) });
  const err = await input.clickAt({ x: 250, y: 50 }).then(() => null, (e) => e.message);
  ok(/administrator/.test(err ?? "") && !calls.length, `win32: a click on an admin window is refused, nothing moved (${err}; ${calls.length} calls)`);
  const drop = await input.dragFrom({ x1: 10, y1: 10, x2: 250, y2: 10 }).then(() => null, (e) => e.message);
  ok(/administrator/.test(drop ?? "") && !calls.length, `win32: a drag onto an admin window is refused (${drop})`);
  await input.clickAt({ x: 100, y: 50 });
  ok(calls.some((c) => c[0] === "press"), "win32: an ordinary window is clicked");
}
{
  const { input, calls } = rig("win32", { admin: () => -1, adminFront: () => -1 });
  await input.clickAt({ x: 100, y: 50 });
  await input.typeText({ text: "ok" });
  ok(calls.some((c) => c[0] === "press") && calls.some((c) => c[0] === "text"), "win32: can't tell goes ahead");
}
{
  const { input, calls } = rig("win32", { adminFront: () => 1 });
  const err = await input.typeText({ text: "secret" }).then(() => null, (e) => e.message);
  const keyErr = await input.pressKeys({ key: "t", mods: ["ctrl"], times: 1 }).then(() => null, (e) => e.message);
  ok(/administrator/.test(err ?? "") && /administrator/.test(keyErr ?? "") && !calls.length, `win32: typing and keys into an admin app are refused (${err})`);
}
{
  const { input, calls } = rig("darwin", { admin: () => 1, adminFront: () => 1 });
  await input.clickAt({ x: 100, y: 50 });
  await input.typeText({ text: "ok" });
  ok(calls.some((c) => c[0] === "press") && calls.some((c) => c[0] === "text"), "darwin: the Windows check never runs");
}

// Shortcuts.
{
  const { input, calls } = rig("darwin");
  await input.pressKeys({ key: "t", mods: ["shift", "cmd"], times: 1 });
  ok(keys(calls) === "↓11/120000 ↑11/120000", `darwin: ⇧⌘T is one key with flags (${keys(calls)})`);
}
{
  const { input, calls } = rig("win32");
  await input.pressKeys({ key: "t", mods: ["ctrl", "shift"], times: 1 });
  ok(keys(calls) === "↓11 ↓10 ↓54 ↑54 ↑10 ↑11", `win32: Ctrl+Shift+T presses the modifiers around the key (${keys(calls)})`);
}
{
  const { input, calls } = rig("win32");
  await input.pressKeys({ key: "down", mods: [], times: 2 });
  ok(keys(calls) === "↓28/1 ↑28/1 ↓28/1 ↑28/1", `win32: the arrow is an extended key, twice (${keys(calls)})`);
}
{
  const { input, calls } = rig("win32");
  await input.pressKeys({ key: "r", mods: ["win"], times: 1 });
  ok(keys(calls) === "↓5b/1 ↓52 ↑52 ↑5b/1", `win32: Win+R (${keys(calls)})`);
}
{
  const { input, calls } = rig("linux");
  await input.pressKeys({ key: "f5", mods: ["ctrl", "option"], times: 1 });
  ok(keys(calls) === "↓ffe3 ↓ffe9 ↓ffc2 ↑ffc2 ↑ffe9 ↑ffe3", `linux: Ctrl+Alt+F5 as key symbols (${keys(calls)})`);
}
{
  const { input, calls } = rig("linux");
  await input.pressKeys({ key: "enter", mods: [], times: 1 });
  ok(keys(calls) === "↓ff0d ↑ff0d", `linux: Return (${keys(calls)})`);
}

// Typing: characters as text, a new line as Return.
for (const [platform, enter] of [["darwin", "24"], ["win32", "d"], ["linux", "ff0d"]]) {
  const { input, calls } = rig(platform);
  await input.typeText({ text: "hé\nx", requestId: "r" });
  const text = calls.filter((c) => c[0] === "text" && c[2]).map((c) => c[1]).join("");
  ok(text === "héx" && keys(calls) === `↓${enter} ↑${enter}`, `${platform}: typing sends "héx" and Return between (${text}; ${keys(calls)})`);
}

// A modifier that went down always comes up, even when the key itself fails.
{
  const calls = [];
  const broken = createInput({
    addon: () => ({ keyCode: (code, flags, down) => (calls.push(["key", code, flags, down]), code !== 0x54) }),
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    platform: "win32",
    refuseOwn: () => {},
    refuseKeyboard: () => {},
    needAccess: () => {},
    cancelled: () => false,
    stub: () => false,
  });
  let threw = false;
  try {
    await broken.pressKeys({ key: "t", mods: ["ctrl"], times: 1 });
  } catch {
    threw = true;
  }
  ok(threw && keys(calls) === "↓11 ↓54 ↑11", `win32: a failed key still lets Ctrl go (${keys(calls)})`);
}

// Stopped and taken.
{
  const { input, calls } = rig("linux", { cancelled: () => true });
  let msg = "";
  try {
    await input.typeText({ text: "abc", requestId: "r" });
  } catch (e) {
    msg = e.message;
  }
  ok(/Stopped/.test(msg) && calls.length === 0, `a cancelled request types nothing (${msg})`);
}
{
  let cursor = { x: 0, y: 0 };
  const r = rig("win32");
  const moving = createInput({
    addon: () => ({ keyText: (t, d) => (r.calls.push(["text", t, d]), (cursor = { x: 100, y: 0 }), true) }),
    screen: { getCursorScreenPoint: () => cursor },
    platform: "win32",
    refuseOwn: () => {},
    refuseKeyboard: () => {},
    needAccess: () => {},
    cancelled: () => false,
    stub: () => false,
  });
  let msg = "";
  try {
    await moving.typeText({ text: "abc", requestId: "r" });
  } catch (e) {
    msg = e.message;
  }
  ok(/moved the mouse/.test(msg) && r.calls.filter((c) => c[2]).length === 1, `typing stops when the user moves the mouse (${msg})`);
}

console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
