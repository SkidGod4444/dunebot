// macOS: builds Dunebot's addon (Rust: notification permission, window appearance, glass read-back)
// to native/dunebot_native.node. Other systems: nothing to do.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "darwin") {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  execFileSync("cargo", ["build", "--release", "--manifest-path", path.join(root, "native", "Cargo.toml")], { stdio: "inherit" });
  const out = path.join(root, "native", "dunebot_native.node");
  // Replace the file, never write over it: macOS remembers the signature of a library a running
  // app has loaded, and kills any process that later loads changed bytes at the same file.
  fs.rmSync(out, { force: true });
  fs.copyFileSync(path.join(root, "native", "target", "release", "libdunebot_native.dylib"), out);
}
