// Draws every icon file the app uses from assets/icon/dunebot.svg (and dunebot-small.svg, for 32 px and
// below), in a hidden Electron window.
//
//   bun run icon
//
// - assets/icon/dunebot.icns: macOS, on Apple's grid as drawn (macOS only: it needs iconutil).
// - assets/icon/dunebot.ico: Windows, 16 to 256 px, cropped to the rounded square without the shadow.
// - electron/assets/icon.png: the window icon on Windows and Linux (512 px), cropped the same way.
// - ui/src/mascot.svg: the mark the app's own pages show (setup, a new chat), cropped the same way.
// - electron/assets/tray*.png: the menu bar (tray) icons, idle and busy (see trayHead below).
// scripts/package.mjs gives the .icns or .ico to the packaged app; electron/main.mjs uses the .png.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "assets", "icon");
const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");
const full = read("dunebot.svg");
const small = read("dunebot-small.svg");
// The drawing for an image this many pixels wide: the simpler one at 32 px and below.
const mac = (px) => (px <= 32 ? small : full);
// Windows and Linux icons fill their square: no shadow, the view cut to the rounded square and its rim.
const crop = (svg) => {
  const cut = svg.replace(/<g id="shadow"[^>]*>.*?<\/g>/s, "").replace('viewBox="0 0 1024 1024"', 'viewBox="96 96 832 832"');
  if (cut === svg || !cut.includes('viewBox="96 96 832 832"')) throw new Error("icon: no shadow group or 1024 view to crop");
  return cut;
};
const square = (px) => crop(mac(px));

// The menu bar icons. macOS: template images (black and clear; macOS colours them to suit its bar),
// the kitten's head (the icon's own shape: a wide round head, ears set apart) with its eyes and nose
// cut out. Busy adds a dot at the top right, cut clear of the head. 36 units, drawn at 18 and 36 px.
const trayHead = (busy) => {
  const ear = (f) =>
    `M${f(4.6)} 21.5 C${f(4.2)} 16 ${f(5.2)} 11 ${f(7.3)} 7.4 C${f(7.8)} 6.5 ${f(8.8)} 6.3 ${f(9.6)} 6.8 C${f(11.9)} 8.4 ${f(14)} 10.8 ${f(15.4)} 14 Z`;
  const head =
    "M2.6 29.2 C2 23.2 4.6 18 9.6 15.4 C12 14.1 14.9 13.5 18 13.5 C21.1 13.5 24 14.1 26.4 15.4 " +
    "C31.4 18 34 23.2 33.4 29.2 C33.2 31.6 31.4 33 29 33 L7 33 C4.6 33 2.8 31.6 2.6 29.2 Z";
  const holes =
    '<ellipse cx="12.4" cy="24.2" rx="2.6" ry="3.05"/><ellipse cx="23.6" cy="24.2" rx="2.6" ry="3.05"/>' +
    '<path d="M16.7 27.9 L19.3 27.9 L18 29.4 Z" stroke="#000" stroke-width=".9" stroke-linejoin="round"/>' +
    (busy ? '<circle cx="31" cy="5.4" r="6.2"/>' : "");
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">' +
    `<defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="36" height="36"><rect width="36" height="36" fill="#fff"/><g fill="#000">${holes}</g></mask></defs>` +
    `<g mask="url(#m)"><path d="${head}"/><path d="${ear((x) => x)}"/><path d="${ear((x) => 36 - x)}"/></g>` +
    (busy ? '<circle cx="31" cy="5.4" r="4.2"/>' : "") +
    "</svg>"
  );
};
// Windows and Linux trays have no template images: they show the app's icon itself (its small
// drawing, which reads on light and dark taskbars). Busy adds the accent's pink dot at the top right.
const trayTile = (busy) => {
  const tile = square(32).replace(/^<!--.*?-->\s*/s, "");
  if (!busy) return tile;
  const inner = tile.replace('width="1024" height="1024"', 'x="0" y="0" width="32" height="32"');
  if (inner === tile) throw new Error("icon: the small drawing has no 1024 size to place");
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
    inner +
    '<circle cx="26.2" cy="5.8" r="5.4" fill="#ff8fa3" stroke="#060607" stroke-width="1.8"/></svg>'
  );
};

// Not a top-level await on whenReady: in an ES module main, ready only comes once the module has run.
app.dock?.hide();
app.whenReady().then(main).catch((e) => {
  console.error(e);
  app.exit(1);
});

async function main() {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL("about:blank");

  // The SVG drawn straight at each size (not scaled down from a big one), so small sizes stay sharp.
  const draw = async (source, size) => {
    const url = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image();
      img.src = "data:image/svg+xml;charset=utf-8," + ${JSON.stringify(encodeURIComponent(source))};
      await img.decode();
      const c = document.createElement("canvas");
      c.width = c.height = ${size};
      c.getContext("2d").drawImage(img, 0, 0, ${size}, ${size});
      return c.toDataURL("image/png");
    })()`);
    return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  };

  // The mark on the app's pages: the drawing itself (sharp at any size), cropped, without the header.
  const page = crop(full).replace(/^<!--.*?-->\s*/s, "");
  fs.writeFileSync(path.join(root, "ui", "src", "mascot.svg"), `<!-- Dune Bot's mark on its pages: drawn by scripts/icon.mjs from assets/icon/dunebot.svg. -->\n${page}`);

  // The window icon.
  fs.writeFileSync(path.join(root, "electron", "assets", "icon.png"), await draw(square(512), 512));

  // The menu bar (tray) icons.
  const assets = path.join(root, "electron", "assets");
  for (const [name, busy] of [["tray", false], ["tray-busy", true]]) {
    fs.writeFileSync(path.join(assets, `${name}Template.png`), await draw(trayHead(busy), 18));
    fs.writeFileSync(path.join(assets, `${name}Template@2x.png`), await draw(trayHead(busy), 36));
  }
  fs.writeFileSync(path.join(assets, "tray-color.png"), await draw(trayTile(false), 32));
  fs.writeFileSync(path.join(assets, "tray-color-busy.png"), await draw(trayTile(true), 32));

  // Windows: an .ico of PNG images (Windows Vista and later read these).
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = [];
  for (const s of sizes) images.push(await draw(square(s), s));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let at = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(s >= 256 ? 0 : s, e);
    head.writeUInt8(s >= 256 ? 0 : s, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(images[i].length, e + 8);
    head.writeUInt32LE(at, e + 12);
    at += images[i].length;
  });
  fs.writeFileSync(path.join(dir, "dunebot.ico"), Buffer.concat([head, ...images]));

  // macOS: an .icns through an iconset folder.
  if (process.platform === "darwin") {
    const set = fs.mkdtempSync(path.join(os.tmpdir(), "dunebot-icon-")) + "/dunebot.iconset";
    fs.mkdirSync(set);
    for (const s of [16, 32, 128, 256, 512]) {
      fs.writeFileSync(path.join(set, `icon_${s}x${s}.png`), await draw(mac(s), s));
      fs.writeFileSync(path.join(set, `icon_${s}x${s}@2x.png`), await draw(mac(s * 2), s * 2));
    }
    execFileSync("iconutil", ["-c", "icns", set, "-o", path.join(dir, "dunebot.icns")]);
    fs.rmSync(path.dirname(set), { recursive: true, force: true });
  } else console.log("icon: .icns left as it is (it needs macOS)");

  console.log("icon: assets/icon/dunebot.ico, assets/icon/dunebot.icns, electron/assets/icon.png, ui/src/mascot.svg, electron/assets/tray*.png");
  app.quit();
}
