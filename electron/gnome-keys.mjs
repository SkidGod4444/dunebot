// GNOME's own keyboard shortcuts for Dune Bot on Wayland. Apps' global keys never fire on GNOME 46
// and older (no shortcut portal), and on Wayland moving the mouse can't stop Dune Bot. So, once the
// user says yes in setup, Dune Bot adds two shortcuts to GNOME's Keyboard settings, as entries of
// its own beside the user's: one asks Dune Bot, one stops every agent. Each runs Dune Bot again with
// --bar or --stop, and the running Dune Bot gets that (app "second-instance").
//
// Nothing here runs a shell: gsettings gets its arguments as a list. The user can change or remove
// the shortcuts in GNOME's Settings › Keyboard; a removed one is never put back.
import { execFile } from "node:child_process";

const LIST = "org.gnome.settings-daemon.plugins.media-keys";
const ONE = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding";
const BASE = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/";
const KEYS = [
  { id: "bar", path: `${BASE}dunebot-bar/`, name: "Dune Bot: ask", arg: "--bar", choices: ["<Control><Alt>space", "<Super><Alt>space", "<Control><Shift>space"] },
  { id: "stop", path: `${BASE}dunebot-stop/`, name: "Dune Bot: stop every agent", arg: "--stop", choices: ["<Control><Alt>period", "<Super><Alt>period", "<Control><Shift>period"] },
];

const gsettings = (...args) =>
  new Promise((resolve, reject) =>
    execFile("gsettings", args, { timeout: 5000 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out).trim()))),
  );
/** The single-quoted strings in a GVariant's text (a list of paths, a key's binding). */
const quoted = (text) => [...String(text).matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
const list = (items) => `[${items.map((p) => `'${p}'`).join(", ")}]`;
/** A string as GVariant text (gsettings refuses a bare value that starts with a quote). */
const gv = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** The string in gsettings' printout of one ('…' or "…", with backslash escapes). */
function gstr(text) {
  const t = String(text).trim();
  const q = t[0];
  if (q !== "'" && q !== '"') return "";
  let out = "";
  for (let i = 1; i < t.length; i++) {
    if (t[i] === "\\") out += t[++i] ?? "";
    else if (t[i] === q) break;
    else out += t[i];
  }
  return out;
}
/** One way of writing an accelerator, so <Primary><Alt>Space and <Control><Alt>space compare equal. */
const same = (a) => String(a).toLowerCase().replace(/<(primary|ctrl)>/g, "<control>").split(/(?=<)|>/).filter(Boolean).sort().join("+");
/** GNOME's "<Control><Alt>space" as Electron and people write it: "Control+Alt+Space". */
export const shown = (accel) =>
  accel
    ? accel
        .replace(/<([^>]+)>/g, "$1+")
        .replace(/\+([a-z])/g, (_, c) => `+${c.toUpperCase()}`)
        .replace(/period$/i, ".")
    : null;
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Whether this is GNOME with its media-keys settings (where custom shortcuts live). */
export async function onGnome() {
  if (!/gnome/i.test(process.env.XDG_CURRENT_DESKTOP ?? "")) return false;
  return gsettings("get", LIST, "custom-keybindings").then(
    () => true,
    () => false,
  );
}

/**
 * @param {object} o
 * @param {string[]} o.command how to start Dune Bot (its executable, and the app folder when not packaged)
 * @param {(...a: any[]) => void} o.log
 */
export function gnomeKeys({ command, log }) {
  let state = { added: false, bar: null, stop: null };
  const commandFor = (k) => [...command, k.arg].map(shq).join(" ");

  /** Every key combination GNOME already uses, but Dune Bot's own. */
  async function taken() {
    const all = await gsettings("list-recursively").catch(() => "");
    const used = new Set(quoted(all).filter((v) => v.includes("<")).map(same));
    for (const p of quoted(await gsettings("get", LIST, "custom-keybindings").catch(() => ""))) {
      if (KEYS.some((k) => k.path === p)) continue;
      const b = gstr(await gsettings("get", `${ONE}:${p}`, "binding").catch(() => ""));
      if (b) used.add(same(b));
    }
    return used;
  }

  /** What GNOME has now: Dune Bot's shortcuts in its list, and their keys. */
  async function refresh() {
    const paths = quoted(await gsettings("get", LIST, "custom-keybindings").catch(() => ""));
    const next = { added: false, bar: null, stop: null };
    for (const k of KEYS) {
      if (!paths.includes(k.path)) continue;
      next[k.id] = gstr(await gsettings("get", `${ONE}:${k.path}`, "binding").catch(() => "")) || null;
    }
    next.added = !!(next.bar || next.stop);
    state = next;
    return state;
  }

  return {
    refresh,
    /** For the setup page: added or not, and the keys as people write them. */
    status: () => ({ added: state.added, bar: shown(state.bar), stop: shown(state.stop) }),
    /** The bar's key, as Electron writes accelerators (the tray shows it). */
    barKey: () => shown(state.bar),
    /** The user said yes: both shortcuts, each on the first key combination GNOME doesn't use yet. */
    async add() {
      const used = await taken();
      const paths = quoted(await gsettings("get", LIST, "custom-keybindings"));
      for (const k of KEYS) {
        const accel = k.choices.find((c) => !used.has(same(c)));
        if (!accel) throw new Error(`Every key combination Dune Bot would use for "${k.name}" is taken in GNOME. Add one yourself in Settings › Keyboard › Custom Shortcuts: the command is ${commandFor(k)}`);
        used.add(same(accel));
        // The entry first, then the list: GNOME never sees half of one.
        await gsettings("set", `${ONE}:${k.path}`, "name", gv(k.name));
        await gsettings("set", `${ONE}:${k.path}`, "command", gv(commandFor(k)));
        await gsettings("set", `${ONE}:${k.path}`, "binding", gv(accel));
        if (!paths.includes(k.path)) paths.push(k.path);
      }
      await gsettings("set", LIST, "custom-keybindings", list(paths));
      await refresh();
      log(`keys: added to GNOME (${shown(state.bar)} asks, ${shown(state.stop)} stops)`);
      return this.status();
    },
    /** At each start: Dune Bot may have moved, so its shortcuts are pointed at where it is now.
     * One the user removed stays removed. */
    async follow() {
      const paths = quoted(await gsettings("get", LIST, "custom-keybindings").catch(() => ""));
      for (const k of KEYS) {
        if (!paths.includes(k.path)) continue;
        const now = gstr(await gsettings("get", `${ONE}:${k.path}`, "command").catch(() => ""));
        if (now !== commandFor(k)) await gsettings("set", `${ONE}:${k.path}`, "command", gv(commandFor(k))).catch((e) => log(`keys: couldn't update GNOME's shortcut (${e.message})`));
      }
      return refresh();
    },
  };
}
