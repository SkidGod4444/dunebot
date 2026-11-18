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
// 4. macOS: signs it ad hoc and checks the signature. A release (DUNEBOT_SIGN_IDENTITY: a "Developer ID
//    Application" certificate in the keychain) is signed for the hardened runtime instead, each part
//    with only the entitlements it needs, then notarized and stapled (DUNEBOT_NOTARY_PROFILE: a
//    notarytool keychain profile, made once with `xcrun notarytool store-credentials <name>`).
// 5. DUNEBOT_ARCHIVE=1: packs the folder into out/Dunebot-<version>-<os>-<arch>.zip (.tar.gz on Linux).
//
// DUNEBOT_CODEMAX_BIN: the codemax to bundle (default ../codemax-cli/dist/codemax).
// Check the result without opening it: DUNEBOT_SELFCHECK=1 <app executable>
import { execFileSync, spawnSync } from "node:child_process";
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
copy("native/dunebot_native.node"); // the mouse and keyboard everywhere; more on macOS
if (isMac) {
  for (const m of ["electron-liquid-glass/package.json", "electron-liquid-glass/dist", "electron-liquid-glass/prebuilds", "node-gyp-build"])
    copy(`node_modules/${m}`);
}
fs.writeFileSync(
  path.join(stage, "package.json"),
  JSON.stringify(
    {
      name: pkg.name,
      productName: "Dunebot",
      version: pkg.version,
      type: "module",
      main: pkg.main,
      description: "Dunebot: your coding agents, on your computer.",
      // Windows writes it into the app's file details (CompanyName); packaging for Windows fails without it.
      author: "OpenHorizon Labs",
      license: pkg.license,
    },
    null,
    2,
  ),
);
fs.mkdirSync(path.join(res, "core"), { recursive: true });
fs.copyFileSync(path.join(root, "core", "target", "release", `dunebot-core${exe}`), path.join(res, "core", `dunebot-core${exe}`));
// Dune Bot's license (AGPL-3.0-only) ships with every download: resources/LICENSE.
const extraResource = [path.join(res, "core"), path.join(root, "LICENSE")];
const codemax = process.env.DUNEBOT_CODEMAX_BIN || path.join(root, "..", "codemax-cli", "dist", `codemax${exe}`);
const codemaxFits = () => {
  if (!fs.existsSync(codemax)) return false;
  if (platform === "win32") return true;
  const kind = execFileSync("file", ["-b", codemax], { encoding: "utf8" });
  // macOS' file says "arm64" / "x86_64", Linux's "ARM aarch64" / "x86-64".
  return (isMac ? kind.includes("Mach-O") : kind.includes("ELF")) && (arch === "arm64" ? /arm64|aarch64/ : /x86[-_]64/).test(kind);
};
if (process.env.DUNEBOT_PACKAGE_CODEMAX !== "0" && codemaxFits()) {
  fs.mkdirSync(path.join(res, "codemax"), { recursive: true });
  fs.copyFileSync(codemax, path.join(res, "codemax", `codemax${exe}`));
  extraResource.push(path.join(res, "codemax"));
} else console.log(`package: no codemax build for ${platform}-${arch} bundled; agents are looked for on PATH`);

// What each part may do under the hardened runtime (a Developer ID release only).
const identity = isMac ? process.env.DUNEBOT_SIGN_IDENTITY : undefined;
const notaryProfile = process.env.DUNEBOT_NOTARY_PROFILE;
if (notaryProfile && !identity) throw new Error("package: DUNEBOT_NOTARY_PROFILE needs DUNEBOT_SIGN_IDENTITY (a Developer ID certificate)");
const allow = (...keys) => keys.map((k) => `com.apple.security.${k}`);
const ENTITLEMENTS = {
  // The app: V8 needs JIT; it asks for the microphone and, for find_location, the location.
  app: allow("cs.allow-jit", "device.audio-input", "personal-information.location"),
  // The core records from the microphone itself.
  core: allow("device.audio-input"),
  // codemax is a Bun build: its runtime needs these to start under the hardened runtime.
  codemax: allow("cs.allow-jit", "cs.allow-unsigned-executable-memory", "cs.disable-executable-page-protection", "cs.allow-dyld-environment-variables", "cs.disable-library-validation"),
};
const partOf = (file) =>
  file.endsWith(path.join("core", "dunebot-core")) ? "core" : file.endsWith(path.join("codemax", "codemax")) ? "codemax" : /\((Renderer|GPU|Plugin)\)\.app/.test(file) ? null : "app";

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
  // .icns on macOS, .ico on Windows (scripts/icon.mjs draws both); Linux windows take electron/assets/icon.png.
  icon: path.join(root, "assets", "icon", "dunebot"),
  asar: { unpack: "**/*.node" },
  prune: false,
  extraResource,
  extendInfo: {
    LSUIElement: true,
    NSMicrophoneUsageDescription: "Dunebot listens only while you hold ⌥⌘ or its mic button.",
    // The reason macOS shows in its "allow?" box for the location (find_location); without it macOS never asks.
    NSLocationWhenInUseUsageDescription: "Dunebot finds where you are only when you ask something that depends on it, like the weather.",
    NSLocationUsageDescription: "Dunebot finds where you are only when you ask something that depends on it, like the weather.",
  },
  ...(identity
    ? {
        osxSign: {
          identity,
          // Electron's helpers keep osx-sign's own entitlements (JIT only); every other part gets its list.
          optionsForFile: (file) => (partOf(file) ? { hardenedRuntime: true, entitlements: ENTITLEMENTS[partOf(file)] } : undefined),
        },
        ...(notaryProfile ? { osxNotarize: { keychainProfile: notaryProfile } } : {}),
      }
    : {}),
});

// 4. macOS. A release was signed (and notarized) while packing: check every part of that.
const check = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
if (isMac && identity) {
  const bundle = path.join(appDir, "Dunebot.app");
  const inside = path.join(bundle, "Contents", "Resources");
  execFileSync("codesign", ["--verify", "--deep", "--strict", bundle], { stdio: "inherit" });
  // Hardened runtime, a Developer ID, and the part's entitlements (codesign prints these on stderr).
  const signed = (file, part) => {
    const d = spawnSync("codesign", ["-dvv", "--entitlements", "-", file], { encoding: "utf8" });
    const text = `${d.stdout}${d.stderr}`;
    if (!/flags=0x10000\(runtime\)/.test(text)) throw new Error(`package: ${file} isn't signed for the hardened runtime`);
    if (!text.includes("Authority=Developer ID Application")) throw new Error(`package: ${file} isn't signed with a Developer ID`);
    for (const e of ENTITLEMENTS[part]) if (!text.includes(e)) throw new Error(`package: ${file} lost ${e}`);
  };
  signed(bundle, "app");
  signed(path.join(inside, "core", "dunebot-core"), "core");
  const bundledCodemax = path.join(inside, "codemax", "codemax");
  if (fs.existsSync(bundledCodemax)) {
    signed(bundledCodemax, "codemax");
    // Without its entitlements a Bun build dies at launch under the hardened runtime.
    console.log(`package: bundled codemax starts: ${check(bundledCodemax, ["--version"]).trim()}`);
  }
  if (notaryProfile) {
    execFileSync("xcrun", ["stapler", "validate", bundle], { stdio: "inherit" });
    const gate = spawnSync("spctl", ["--assess", "--type", "execute", "-vv", bundle], { encoding: "utf8" });
    if (gate.status !== 0 || !/source=Notarized Developer ID/.test(gate.stderr)) throw new Error(`package: Gatekeeper refuses it:\n${gate.stderr}`);
    console.log(`package: ${bundle} (${arch}, Developer ID, notarized and stapled)`);
  } else console.log(`package: ${bundle} (${arch}, Developer ID, not notarized)`);
} else if (isMac) {
  // An ad-hoc signature, inside out (Apple Silicon runs nothing unsigned).
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

// 5. One file to download: the folder as it is (ditto keeps the Mac app's signature and ticket).
if (process.env.DUNEBOT_ARCHIVE === "1") {
  const os = { darwin: "mac", win32: "windows", linux: "linux" }[platform] ?? platform;
  const base = `Dunebot-${pkg.version}-${os}-${arch}`;
  const file = path.join(out, platform === "linux" ? `${base}.tar.gz` : `${base}.zip`);
  fs.rmSync(file, { force: true });
  if (isMac) execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", path.join(appDir, "Dunebot.app"), file], { stdio: "inherit" });
  // Windows' own tar (bsdtar) writes a zip; Git's tar earlier on PATH can't.
  else if (platform === "win32") execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-a", "-c", "-f", file, "-C", out, path.basename(appDir)], { stdio: "inherit" });
  else execFileSync("tar", ["-czf", file, "-C", out, path.basename(appDir)], { stdio: "inherit" });
  console.log(`package: ${file} (${(fs.statSync(file).size / 1e6).toFixed(1)} MB)`);
}
