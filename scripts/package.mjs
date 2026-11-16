// Builds Dunebot into an app folder for this system and processor: out/Dunebot-<os>-<arch>/.
// No installer, nothing installed, nothing published.
//
//   bun run package            (DUNEBOT_PACKAGE_CODEMAX=0 leaves codemax out)
//
// 1. Builds the release core, the macOS addon and the pages.
// 2. Stages a folder with only what the app loads: electron/, dist/ui/, the addon, and the glass
//    package with the one module it needs (the pages' libraries are already bundled into dist/ui).
// 3. Packs it with @electron/packager: .node files stay outside the app archive; the core goes to
//    Resources/core and codemax (when there's a build for this system) to Resources/codemax.
// 4. macOS: signs it ad hoc (no Apple Developer ID, not notarized) and checks the signature.
//
// Check the result without opening it: DUNEBOT_SELFCHECK=1 <app executable>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, "node_modules", "electron", "package.json"), "utf8")).version;
const platform = process.platform;
const arch = process.arch;
const isMac = platform === "darwin";
const exe = platform === "win32" ? ".exe" : "";
const out = path.join(root, "out");
const stage = path.join(out, "stage");
const res = path.join(out, "resources");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

// 1. Build.
run("cargo", ["build", "--release", "--manifest-path", "core/Cargo.toml"]);
run("node", ["scripts/native.mjs"]);
run(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build"]);

// 2. Stage.
fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(res, { recursive: true, force: true });
const copy = (from, to = from) => fs.cpSync(path.join(root, from), path.join(stage, to), { recursive: true, dereference: true });
copy("electron");
copy("dist/ui");
if (isMac) {
  copy("native/dunebot_native.node");
  for (const m of ["electron-liquid-glass/package.json", "electron-liquid-glass/dist", "electron-liquid-glass/prebuilds", "node-gyp-build"])
    copy(`node_modules/${m}`);
}
fs.writeFileSync(
  path.join(stage, "package.json"),
  JSON.stringify(
    { name: pkg.name, productName: "Dunebot", version: pkg.version, type: "module", main: pkg.main, description: "Dunebot: your coding agents, on your computer." },
    null,
    2,
  ),
);
fs.mkdirSync(path.join(res, "core"), { recursive: true });
fs.copyFileSync(path.join(root, "core", "target", "release", `dunebot-core${exe}`), path.join(res, "core", `dunebot-core${exe}`));
const extraResource = [path.join(res, "core")];
const codemax = path.join(root, "..", "codemax-cli", "dist", `codemax${exe}`);
const codemaxFits = () => {
  if (!fs.existsSync(codemax)) return false;
  if (platform === "win32") return true;
  const kind = execFileSync("file", ["-b", codemax], { encoding: "utf8" });
  return (isMac ? kind.includes("Mach-O") : kind.includes("ELF")) && kind.includes(arch === "arm64" ? "arm64" : "x86_64");
};
if (process.env.DUNEBOT_PACKAGE_CODEMAX !== "0" && codemaxFits()) {
  fs.mkdirSync(path.join(res, "codemax"), { recursive: true });
  fs.copyFileSync(codemax, path.join(res, "codemax", `codemax${exe}`));
  extraResource.push(path.join(res, "codemax"));
} else console.log(`package: no codemax build for ${platform}-${arch} bundled; agents are looked for on PATH`);

// 3. Pack.
const [appDir] = await packager({
  dir: stage,
  out,
  overwrite: true,
  platform,
  arch,
  electronVersion,
  name: "Dunebot",
  executableName: platform === "linux" ? "dunebot" : "Dunebot",
  appVersion: pkg.version,
  appBundleId: "com.openhorizon.dunebot",
  appCategoryType: "public.app-category.productivity",
  asar: { unpack: "**/*.node" },
  prune: false,
  extraResource,
  extendInfo: {
    LSUIElement: true,
    NSMicrophoneUsageDescription: "Dunebot listens only while you hold ⌥⌘ or its mic button.",
  },
});

// 4. macOS: an ad-hoc signature, inside out (Apple Silicon runs nothing unsigned).
if (isMac) {
  const bundle = path.join(appDir, "Dunebot.app");
  const inner = [path.join(bundle, "Contents", "Resources", "core", "dunebot-core"), path.join(bundle, "Contents", "Resources", "codemax", "codemax")];
  const unpacked = path.join(bundle, "Contents", "Resources", "app.asar.unpacked");
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
  for (const f of [...inner.filter((f) => fs.existsSync(f)), ...walk(unpacked).filter((f) => f.endsWith(".node"))])
    execFileSync("codesign", ["--force", "--sign", "-", f], { stdio: "inherit" });
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", bundle], { stdio: "inherit" });
  console.log(`package: ${bundle} (${arch}, ad-hoc signed, not notarized)`);
} else console.log(`package: ${appDir} (${arch}, unsigned)`);
