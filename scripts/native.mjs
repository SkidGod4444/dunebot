// Builds Dunebot's addon (Rust) to native/dunebot_native.node. macOS: notification permission, window
// appearance, glass read-back, location, the mouse and keyboard. Windows and Linux: the mouse and keyboard.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Where the symbol-name table starts in the library (LC_SYMTAB's stroff), from otool.
const nameTableAt = (lib) => Number(/stroff (\d+)/.exec(execFileSync("otool", ["-l", lib], { encoding: "utf8" }))?.[1] ?? NaN);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.platform === "win32" || process.platform === "linux") {
  const manifest = path.join(root, "native", "Cargo.toml");
  execFileSync("cargo", ["build", "--release", "--manifest-path", manifest], { stdio: "inherit" });
  const lib = process.platform === "win32" ? "dunebot_native.dll" : "libdunebot_native.so";
  const out = path.join(root, "native", "dunebot_native.node");
  fs.rmSync(out, { force: true });
  fs.copyFileSync(path.join(root, "native", "target", "release", lib), out);
}

if (process.platform === "darwin") {
  const manifest = path.join(root, "native", "Cargo.toml");
  const built = path.join(root, "native", "target", "release", "libdunebot_native.dylib");
  execFileSync("cargo", ["build", "--release", "--manifest-path", manifest], { stdio: "inherit" });
  // Xcode 27's linker can put that table 4 bytes off the 8-byte boundary macOS 27 requires (it then
  // refuses to load the library). One more import entry moves it back: build that way (native/build.rs).
  if (nameTableAt(built) % 8) {
    console.log("native: the linker misaligned the name table; building again with one more import entry");
    execFileSync("cargo", ["rustc", "--release", "--lib", "--manifest-path", manifest, "--", "--cfg", "dunebot_pad"], { stdio: "inherit" });
  }
  const at = nameTableAt(built);
  if (!(at % 8 === 0)) throw new Error(`native: the name table is still misaligned (at ${at}); macOS won't load this library`);
  const out = path.join(root, "native", "dunebot_native.node");
  // Replace the file, never write over it: macOS remembers the signature of a library a running
  // app has loaded, and kills any process that later loads changed bytes at the same file.
  fs.rmSync(out, { force: true });
  fs.copyFileSync(path.join(root, "native", "target", "release", "libdunebot_native.dylib"), out);
}
