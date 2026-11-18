// Electron under Wayland: where it thinks the pointer is (window open), then its screen capture twice.
const { app, BrowserWindow, desktopCapturer, screen } = require("electron");
const fs = require("fs");
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 500, height: 360, title: "probe", show: true });
  await w.loadURL("data:text/html,<title>probe</title><body style='background:%23ffd' onmousemove='document.title=\"probe\"'>probe</body>");
  w.setTitle("probe");
  log("WINDOW bounds", JSON.stringify(w.getBounds()));
  for (let i = 0; i < 2; i++) {
    log("cursor", JSON.stringify(screen.getCursorScreenPoint()));
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const n of [1, 2]) {
    const t0 = Date.now();
    log(`CAPTURE${n}`);
    try {
      const s = await Promise.race([
        desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 640, height: 400 } }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("no answer in 30 s")), 30000)),
      ]);
      log(`capture ${n}: ${Date.now() - t0} ms`, JSON.stringify(s.map((x) => ({ id: x.id, name: x.name, size: x.thumbnail.getSize(), empty: x.thumbnail.isEmpty() }))));
      if (s[0] && !s[0].thumbnail.isEmpty()) fs.writeFileSync(`out/electron-capture-${n}.png`, s[0].thumbnail.toPNG());
    } catch (e) {
      log(`capture ${n}: ${e.message} after ${Date.now() - t0} ms`);
    }
  }
  app.quit();
});
