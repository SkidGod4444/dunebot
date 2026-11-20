// The voice keys come back from the system's keychain the way the app reads them now: locked with
// safeStorage.encryptString (as a saved key is), opened with decryptStringAsync (electron/main.mjs,
// lockedKey.ready). The app's self-check never touches the keychain, so without this, Windows and
// Linux would first run the async unlock on a person's computer (2026-11-21).
// Usage: node scripts/check_keychain.mjs
//   Linux: inside a D-Bus session with an unlocked secret store (gnome-keyring), as a desktop has;
//   XDG_CURRENT_DESKTOP=GNOME picks it, as on a GNOME desktop.
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!process.versions.electron) {
  const { spawnSync } = await import("node:child_process");
  const args = [path.join(root, "node_modules", "electron", "cli.js"), fileURLToPath(import.meta.url)];
  if (process.platform === "linux") args.push("--no-sandbox");
  const r = spawnSync(process.execPath, args, { stdio: "inherit", timeout: 60_000 });
  process.exit(r.status ?? 1);
}

const { app, safeStorage } = await import("electron");
let failed = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)})`}`);
  if (!ok) failed++;
};

app.setName("dunebot-keychain-check");
app.whenReady().then(async () => {
  try {
    if (process.platform === "linux") {
      const backend = safeStorage.getSelectedStorageBackend();
      check("Linux: the desktop's secret store locks the keys, not the fixed-password fallback", backend !== "basic_text" && backend !== "unknown", backend);
    }
    check("the keychain can lock a key", safeStorage.isEncryptionAvailable(), false);
    const key = "sk_test_Abc-123_xyz";
    const locked = safeStorage.encryptString(key);
    check("a locked key isn't the key", !locked.toString("latin1").includes(key), "plain text inside");
    const t0 = Date.now();
    const opened = await safeStorage.decryptStringAsync(locked);
    const ms = Date.now() - t0;
    check(`the async unlock gives the same key back (${ms} ms)`, opened?.result === key, opened);
    // Twice, as a new core gets the key again after a restart.
    const again = await safeStorage.decryptStringAsync(locked);
    check("and again", again?.result === key, again);
    check("the app's own unlock code reads .result", typeof opened?.result === "string", typeof opened?.result);
  } catch (e) {
    check("no error", false, e.message);
  }
  console.log(failed ? `${failed} FAIL` : "ALL PASS");
  app.exit(failed ? 1 : 0);
});
