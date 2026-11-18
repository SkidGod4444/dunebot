// The mouse and keyboard for real, on CI's Windows and Linux machines only (a Mac runner can't be
// given Accessibility, and nobody's own screen is ever used). A window of its own holds a button, a
// text box, a scrolling list and a box to drag; electron/input.mjs drives them through the built
// addon (native/dunebot_native.node), and the page says what happened.
// Usage, on CI: node scripts/native.mjs && node scripts/check_input_live.mjs (Linux: under xvfb-run).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

if (!process.versions.electron) {
  if (!process.env.CI || process.platform === "darwin") {
    console.log("check_input_live: runs on CI's Windows and Linux machines only (it moves the real pointer and types)");
    process.exit(0);
  }
  const { spawnSync } = await import("node:child_process");
  const args = [path.join(root, "node_modules", "electron", "cli.js"), fileURLToPath(import.meta.url)];
  if (process.platform === "linux") args.push("--no-sandbox");
  const r = spawnSync(process.execPath, args, { stdio: "inherit", timeout: 180_000 });
  process.exit(r.status ?? 1);
}

const { app, BrowserWindow, screen } = await import("electron");
const { createInput } = await import(pathToFileURL(path.join(root, "electron", "input.mjs")).href);
const addon = createRequire(import.meta.url)(path.join(root, "native", "dunebot_native.node"));

let failed = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failed++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><meta charset=utf-8><body style="margin:0;font:16px sans-serif;background:#fff">
<button id=b style="position:absolute;left:20px;top:20px;width:160px;height:60px">Click</button>
<textarea id=t style="position:absolute;left:220px;top:20px;width:300px;height:100px"></textarea>
<div id=s style="position:absolute;left:20px;top:160px;width:200px;height:200px;overflow:auto;border:1px solid #888"><div style="height:4000px"></div></div>
<div id=d style="position:absolute;left:300px;top:200px;width:80px;height:80px;background:#333"></div>
<script>
window.st = { clicks: 0, dbl: 0, ctx: 0, downs: [] };
addEventListener("mousedown", (e) => st.downs.push([e.button, e.clientX, e.clientY, e.target.id || e.target.tagName]), true);
b.onclick = () => st.clicks++;
b.ondblclick = () => st.dbl++;
b.oncontextmenu = (e) => { e.preventDefault(); st.ctx++; };
let grab = null;
d.onmousedown = (e) => { grab = { x: e.clientX - d.offsetLeft, y: e.clientY - d.offsetTop }; e.preventDefault(); };
addEventListener("mousemove", (e) => { if (grab) { d.style.left = e.clientX - grab.x + "px"; d.style.top = e.clientY - grab.y + "px"; } });
addEventListener("mouseup", () => (grab = null));
</script>`;

app.whenReady().then(async () => {
  setTimeout(() => {
    console.log("check_input_live: timed out");
    app.exit(1);
  }, 150_000);
  const d = screen.getPrimaryDisplay();
  console.log(`display ${d.bounds.width}x${d.bounds.height} at scale ${d.scaleFactor}; addon access ${addon.postEventAccess(false)}`);
  const win = new BrowserWindow({ x: d.workArea.x + 60, y: d.workArea.y + 60, width: 640, height: 480, alwaysOnTop: true, show: false });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  win.show();
  win.focus();
  await wait(800);

  const page = (js) => win.webContents.executeJavaScript(js);
  const state = () => page("JSON.stringify({ ...st, value: t.value, focus: document.activeElement?.id ?? null, scroll: s.scrollTop, left: d.offsetLeft, top: d.offsetTop })").then(JSON.parse);
  /** An element's centre on the screen, in Electron's points. */
  const centre = async (id) => {
    const r = JSON.parse(await page(`JSON.stringify(document.getElementById(${JSON.stringify(id)}).getBoundingClientRect())`));
    const c = win.getContentBounds();
    return { x: c.x + r.left + r.width / 2, y: c.y + r.top + r.height / 2 };
  };
  const input = createInput({
    addon: () => addon,
    screen,
    refuseOwn: () => {}, // the test drives its own window on purpose
    refuseKeyboard: () => {},
    needAccess: () => {
      if (!addon.postEventAccess(false)) throw new Error("no access to the mouse and keyboard here");
    },
    cancelled: () => false,
    stub: () => false,
  });
  const step = async (what, fn) => {
    try {
      await fn();
    } catch (e) {
      ok(false, `${what}: ${e.message}`);
    }
    await wait(350);
  };

  try {
    const b = await centre("b");
    await step("click", () => input.clickAt({ x: b.x, y: b.y }));
    let s = await state();
    ok(s.clicks === 1, `a click on the button (${JSON.stringify(s)})`);

    await step("double click", () => input.clickAt({ x: b.x, y: b.y, count: 2 }));
    s = await state();
    ok(s.dbl === 1, `a double click (${JSON.stringify(s)})`);

    await step("right click", () => input.clickAt({ x: b.x, y: b.y, button: "right" }));
    s = await state();
    ok(s.ctx === 1, `a right click (${JSON.stringify(s)})`);

    if (process.platform === "win32") {
      const at = input.nativePoint(b.x, b.y);
      ok(addon.frontWindowOwner(at.x, at.y, []) === process.pid, "Windows: the window under the button is this app's");
      ok(addon.frontmostPid() === process.pid, `Windows: this app is in front (${addon.frontmostPid()} vs ${process.pid})`);
    }

    const t = await centre("t");
    await step("click the text box", () => input.clickAt({ x: t.x, y: t.y }));
    s = await state();
    ok(s.focus === "t", `the text box has the keyboard (${s.focus})`);

    const text = "Hello, wörld! 3+4=7\nline 2";
    await step("type", () => input.typeText({ text, requestId: "a" }));
    s = await state();
    ok(s.value === text, `typed ${JSON.stringify(text)} (got ${JSON.stringify(s.value)})`);

    await step("select all", () => input.pressKeys({ key: "a", mods: ["ctrl"], times: 1, requestId: "b" }));
    await step("type over it", () => input.typeText({ text: "xy", requestId: "c" }));
    s = await state();
    ok(s.value === "xy", `Ctrl+A then typing replaces it (got ${JSON.stringify(s.value)})`);

    await step("backspace twice", () => input.pressKeys({ key: "backspace", mods: [], times: 2, requestId: "d" }));
    s = await state();
    ok(s.value === "", `Backspace ×2 empties it (got ${JSON.stringify(s.value)})`);

    const list = await centre("s");
    await step("scroll down", () => input.scrollAt({ x: list.x, y: list.y, dx: 0, dy: -1, notches: 4 }));
    s = await state();
    const down = s.scroll;
    ok(down > 0, `scrolling down moves the list (${down} px)`);
    await step("scroll up", () => input.scrollAt({ x: list.x, y: list.y, dx: 0, dy: 1, notches: 2 }));
    s = await state();
    ok(s.scroll < down, `scrolling up moves it back (${down} → ${s.scroll} px)`);

    const box = await centre("d");
    const before = await state();
    await step("drag", () => input.dragFrom({ x1: box.x, y1: box.y, x2: box.x + 150, y2: box.y + 80 }));
    s = await state();
    const dx = s.left - before.left;
    const dy = s.top - before.top;
    ok(Math.abs(dx - 150) <= 6 && Math.abs(dy - 80) <= 6, `a drag moves the box by 150,80 (moved ${dx},${dy})`);
  } catch (e) {
    ok(false, `the run broke: ${e.stack}`);
  }
  if (failed) {
    // What the window looked like, and every press it saw (button, x, y, what was under it).
    console.log(`presses seen: ${JSON.stringify((await state()).downs)}; window at ${JSON.stringify(win.getContentBounds())}`);
    const dir = path.join(root, "snapshots");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `input-live-${process.platform}.png`), (await win.webContents.capturePage()).toPNG());
  }
  console.log(failed ? `${failed} FAILED` : "ALL PASS");
  app.exit(failed ? 1 : 0);
});
