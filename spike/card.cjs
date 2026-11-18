// A normal window ("target") and a Dune Bot-style card on top ("card": always on top, not focusable,
// click-through until /tmp/card-solid exists). Each reports clicks and focus.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const page = (name, color) => `data:text/html,${encodeURIComponent(`<body style="margin:0;background:${color};font:30px sans-serif">${name}<input id=i style="width:90%;font-size:30px">
<script>addEventListener("mousedown", (e) => document.title = "click " + e.clientX + "," + e.clientY); i.addEventListener("input", () => document.title = "value " + JSON.stringify(i.value));</script>`)}`;
app.whenReady().then(async () => {
  const t = new BrowserWindow({ width: 800, height: 600, title: "target", autoHideMenuBar: true });
  t.on("page-title-updated", (e, s) => { e.preventDefault(); log("target page:", s); });
  await t.loadURL(page("target", "#ffd"));
  t.setTitle("target");
  const c = new BrowserWindow({ width: 700, height: 500, title: "card", alwaysOnTop: true, focusable: false, frame: false, autoHideMenuBar: true });
  c.setAlwaysOnTop(true, "floating");
  c.on("page-title-updated", (e, s) => { e.preventDefault(); log("card page:", s); });
  await c.loadURL(page("card", "#dfd"));
  c.setTitle("card");
  let solid = null;
  const check = () => {
    const now = fs.existsSync("/tmp/card-solid");
    if (now !== solid) { solid = now; c.setIgnoreMouseEvents(!now, { forward: true }); log("card", now ? "takes clicks" : "click-through"); }
  };
  check();
  setInterval(check, 200);
  for (const [n, w] of [["target", t], ["card", c]]) { w.on("focus", () => log(n, "focus")); w.on("blur", () => log(n, "blur")); }
  setInterval(() => log("focused:", "target", t.isFocused(), "card", c.isFocused(), "app", BrowserWindow.getFocusedWindow()?.getTitle() ?? "none"), 2000);
  log("READY");
  setTimeout(() => app.quit(), Number(process.env.STAY || 60) * 1000);
});
