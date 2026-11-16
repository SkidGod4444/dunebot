// Starts the Electron app. On macOS it runs as its own small app, "Dunebot Dev" (a copy of
// Electron with its own bundle id, no Dock icon), started by macOS rather than by the terminal.
// That way microphone and other permission prompts name Dunebot, and the permission goes to
// Dunebot only, not to the terminal (and everything else started from it).
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
export const DEV_APP = path.join(root, ".dev", "Dunebot Dev.app");
const BUNDLE_ID = "com.openhorizon.dunebot.dev";

function ensureDevApp() {
  const version = require("electron/package.json").version;
  const marker = path.join(root, ".dev", "electron-version");
  if (fs.existsSync(DEV_APP) && fs.readFileSync(marker, "utf8") === version) return;
  fs.rmSync(DEV_APP, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(DEV_APP), { recursive: true });
  const src = path.join(path.dirname(require.resolve("electron")), "dist", "Electron.app");
  execFileSync("cp", ["-cR", src, DEV_APP]); // APFS clone: instant, no extra space
  const plist = path.join(DEV_APP, "Contents", "Info.plist");
  const set = (key, type, value) => {
    try {
      execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist], { stdio: "ignore" });
    } catch {
      execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} ${type} ${value}`, plist]);
    }
  };
  set("CFBundleIdentifier", "string", BUNDLE_ID);
  set("CFBundleName", "string", "Dunebot Dev");
  set("CFBundleDisplayName", "string", "Dunebot Dev");
  set("LSUIElement", "bool", "true");
  set("NSMicrophoneUsageDescription", "string", "Dunebot listens only while you hold ⌥⌘ or its mic button.");
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", DEV_APP], { stdio: "ignore" });
  // Register the new bundle id with Launch Services.
  const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  try {
    execFileSync(lsregister, ["-f", DEV_APP], { stdio: "ignore" });
  } catch {}
  fs.writeFileSync(marker, version);
}

/** Starts the app; resolves with its exit code. Output goes to this process's stdout. */
export function launch(extraEnv = {}) {
  const pass = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith("DUNEBOT_") || ["PATH", "SHELL", "LANG", "HOME", "USER"].includes(k)),
  );
  const env = { ...pass, ...extraEnv };
  if (process.platform !== "darwin") {
    const child = spawn(require("electron"), [root], { stdio: "inherit", env: { ...process.env, ...env } });
    return new Promise((r) => child.on("exit", (code) => r(code ?? 0)));
  }
  ensureDevApp();
  // Outside ~/Desktop, ~/Documents etc.: macOS opens this file for the app before it starts.
  fs.mkdirSync(path.join(os.tmpdir(), "dunebot-dev"), { recursive: true });
  const log = path.join(os.tmpdir(), "dunebot-dev", "app.log");
  fs.writeFileSync(log, "");
  const args = ["-n", "-W", "--stdout", log, "--stderr", log];
  for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
  args.push(DEV_APP, "--args", root);
  const child = spawn("open", args, { stdio: "inherit" });
  // Follow the app's log.
  let pos = 0;
  const timer = setInterval(() => {
    const size = fs.statSync(log).size;
    if (size > pos) {
      const fd = fs.openSync(log, "r");
      const buf = Buffer.alloc(size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      process.stdout.write(buf);
      pos = size;
    }
  }, 300);
  const quit = () => {
    try {
      execFileSync("pkill", ["-TERM", "-f", `${DEV_APP}/Contents/MacOS/Electron`]);
    } catch {}
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  return new Promise((r) =>
    child.on("exit", (code) => {
      clearInterval(timer);
      r(code ?? 0);
    }),
  );
}
