// What main tells the card as soon as its page has loaded (the chat to show, the question held for
// next) reaches it though the page starts listening a moment later, as React does in an effect: a
// real window with the real preload (electron/preload.cjs). Before, Electron dropped both, so the card
// never said it was done and a held question waited (bar-held, CI 2026-11-20).
// Usage: node scripts/check_early_messages.mjs (Linux: under xvfb-run).
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!process.versions.electron) {
  const { spawnSync } = await import("node:child_process");
  const args = [path.join(root, "node_modules", "electron", "cli.js"), fileURLToPath(import.meta.url)];
  if (process.platform === "linux") args.push("--no-sandbox");
  const r = spawnSync(process.execPath, args, { stdio: "inherit", timeout: 60_000 });
  process.exit(r.status ?? 1);
}

const { app, BrowserWindow } = await import("electron");
let failed = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)})`}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Listens 300 ms after it has loaded; everything it hears goes in window.heard, in order.
const page = `<!doctype html><title>early</title><script>
window.heard = [];
setTimeout(() => {
  const d = window.dunebot.caption;
  d.onShow((v) => heard.push(["show", v]));
  d.onNext((v) => heard.push(["next", v]));
  d.onHush(() => heard.push(["hush"]));
  window.listening = true;
}, 300);
</script>`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(root, "electron", "preload.cjs") } });
  w.webContents.once("did-finish-load", () => {
    // As main.mjs does for a card made a moment ago: the chat, then the question held for next.
    w.webContents.send("caption:show", { threadId: "a", side: "below", align: "left", speak: false });
    w.webContents.send("caption:show", { threadId: "b", side: "below", align: "left", speak: false });
    w.webContents.send("caption:next", "and how big is it?");
    w.webContents.send("caption:hush");
  });
  await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  const end = Date.now() + 5000;
  while (Date.now() < end && !(await w.webContents.executeJavaScript("!!window.listening"))) await sleep(50);
  await sleep(200);
  let heard = await w.webContents.executeJavaScript("window.heard");
  check("sent before the page listened: the last chat, then the held question, reach it", JSON.stringify(heard) === JSON.stringify([["show", { threadId: "b", side: "below", align: "left", speak: false }], ["next", "and how big is it?"]]), heard);
  check("a hush from before isn't replayed (it was for then)", !heard.some((h) => h[0] === "hush"), heard);

  // Once listening, each goes straight through, once.
  const n = heard.length;
  w.webContents.send("caption:next", null);
  w.webContents.send("caption:show", { threadId: "c", side: "above", align: "right", speak: true });
  await sleep(300);
  heard = await w.webContents.executeJavaScript(`window.heard.slice(${n})`);
  check("while listening: each as it comes, once", JSON.stringify(heard) === JSON.stringify([["next", null], ["show", { threadId: "c", side: "above", align: "right", speak: true }]]), heard);

  w.destroy();
  console.log(failed ? `${failed} FAIL` : "ALL PASS");
  app.exit(failed ? 1 : 0);
});
