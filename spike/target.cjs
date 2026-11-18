// A window to click and type into; it reports what reached it. It also holds Dune Bot's hotkey.
const { app, BrowserWindow, globalShortcut } = require("electron");
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
if (process.argv.includes("--portal-keys")) app.commandLine.appendSwitch("enable-features", "GlobalShortcutsPortal");
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 600, height: 400, title: "target", autoHideMenuBar: true });
  w.on("page-title-updated", (e, t) => { e.preventDefault(); log("page:", t); });
  await w.loadURL(`data:text/html,${encodeURIComponent(`<body style="margin:0;background:#ffd"><input id=i style="width:100%;height:100%;font-size:40px;border:0;background:#ffd">
<script>
const i = document.getElementById("i");
addEventListener("mousedown", (e) => document.title = "click " + e.clientX + "," + e.clientY);
i.addEventListener("input", () => document.title = "value " + JSON.stringify(i.value));
</script>`)}`);
  w.setTitle("target");
  for (const k of ["Control+Alt+Space", "Alt+Shift+Space"]) {
    let ok = false;
    try { ok = globalShortcut.register(k, () => log("SHORTCUT fired", k)); } catch (e) { log("register threw", e.message); }
    log("hotkey", k, ok ? "registered" : "refused");
  }
  log("READY", process.env.WAYLAND_DISPLAY ? "wayland" : "x11", JSON.stringify(w.getBounds()));
  setTimeout(() => app.quit(), Number(process.env.STAY || 40) * 1000);
});
