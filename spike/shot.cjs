// Electron's own screenshot under Wayland, twice: does a picker come up each time, what comes back.
const { app, desktopCapturer, screen } = require("electron");
const fs = require("fs");
app.whenReady().then(async () => {
  console.log("session", process.env.XDG_SESSION_TYPE, "wayland display", process.env.WAYLAND_DISPLAY);
  console.log("displays", JSON.stringify(screen.getAllDisplays().map((d) => ({ b: d.bounds, s: d.scaleFactor, id: d.id }))));
  console.log("cursor", JSON.stringify(screen.getCursorScreenPoint()));
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    try {
      const s = await Promise.race([
        desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1280, height: 800 } }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("no answer in 25 s")), 25000)),
      ]);
      console.log(`capture ${i}: ${Date.now() - t0} ms, ${s.length} sources`, JSON.stringify(s.map((x) => ({ id: x.id, name: x.name, display: x.display_id, size: x.thumbnail.getSize(), empty: x.thumbnail.isEmpty() }))));
      if (s[0] && !s[0].thumbnail.isEmpty()) fs.writeFileSync(`out/electron-capture-${i}.png`, s[0].thumbnail.toPNG());
    } catch (e) {
      console.log(`capture ${i}: ${e.message} after ${Date.now() - t0} ms`);
    }
  }
  app.quit();
});
