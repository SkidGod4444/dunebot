// Draws Dunebot's bar, the answer beside the pointer, setup and history windows hidden (never a screen capture) in light and dark,
// on whatever system runs it, and saves each as <os>-<view>-<theme>.png plus a .json of where its
// parts are and how they're drawn. It also checks the bar opens bottom centre and grows upward.
//
//   node scripts/snapshots.mjs <out folder> [darwin|win32|linux]
//
// The optional system draws that system's version of the pages (for checking them on a Mac).
// On Linux, run it under a display: xvfb-run -a node scripts/snapshots.mjs out
// Compare two systems' results with: python3 scripts/compare_snapshots.py <a> <a-os> <b> <b-os>
// A packaged build instead of the source: DUNEBOT_SNAPSHOT_APP=<its executable> (it uses its own core).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.resolve(process.argv[2] ?? "snapshots");
const as = process.argv[3] ?? "";
const tag = as || process.platform;
const packaged = process.env.DUNEBOT_SNAPSHOT_APP;
const core = path.join(root, "core", "target", "debug", process.platform === "win32" ? "dunebot-core.exe" : "dunebot-core");
const electron = path.join(root, "node_modules", "electron", "cli.js");
if (!packaged && !fs.existsSync(core)) throw new Error(`build the core first (bun run core): ${core}`);
fs.mkdirSync(out, { recursive: true });

const SHOTS = [
  ["bar", "bar", { DUNEBOT_SNAPSHOT_PLACE: "1" }],
  ["caption", "caption", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "caption.js") }],
  ["caption-markdown", "caption", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "caption-markdown.js") }],
  ["caption-approval", "caption", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "caption-approval.js") }],
  // The answer card following a scripted pointer, then holding still while a card waits for an OK.
  ["caption-follow", "caption", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "caption-follow.js"), DUNEBOT_SNAPSHOT_FOLLOW: "1" }],
  ["caption-grab", "caption", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "caption-grab.js"), DUNEBOT_SNAPSHOT_FOLLOW: "grab" }],
  // Sarvam's MP3s play on the built page (blob: audio allowed by its CSP).
  ["caption-sarvam", "caption", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "caption-sarvam.js") }],
  // Sarvam's streamed audio plays through the page's AudioContext as it arrives.
  ["caption-stream", "caption", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "caption-stream.js") }],
  ["caption-next", "caption", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "caption-next.js") }],
  ["caption-approval-next", "caption", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "caption-approval-next.js") }],
  ["caption-first-line", "caption", { DUNEBOT_SNAPSHOT_WAIT: "100", DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "caption-first-line.js") }],
  ["caption-held-read", "caption", { DUNEBOT_SNAPSHOT_WAIT: "100", DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "caption-held-read.js") }],
  // The first question of a new chat, spoken from the bar, is read aloud.
  ["caption-voice-ask", "caption", { DUNEBOT_SNAPSHOT_WAIT: "100", DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "caption-voice-ask.js") }],
  // The test agent clicks a point in a picture of the screen; the app logs it (stand-ins, no real click).
  ["caption-click", "caption", {
    DUNEBOT_SCREEN_STUB: path.join(root, "electron", "assets", "icon.png"),
    DUNEBOT_CLICK_STUB: "1",
    DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "caption-click.js"),
  }],
  ["bar-held", "bar", { DUNEBOT_SNAPSHOT_HELD: "1", DUNEBOT_SNAPSHOT_WAIT: "100", DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "bar-held.js") }],
  ["setup", "setup", {}],
  ["main", "main", {}],
  ["chat", "main", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "chat.js") }],
  ["chat-fix", "main", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "fixes-chat.js") }],
  ["chat-markdown", "main", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "markdown.js") }],
  ["fixes", "main", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "fixes-page.js") }],
  ["schedules", "main", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "schedules.js") }],
  ["permissions", "main", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "permissions.js") }],
  ["permissions-voice", "main", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "permissions-voice.js") }],
];
const problems = [];
// DUNEBOT_SNAPSHOT_ONLY=caption,caption-stream: just those views.
const only = process.env.DUNEBOT_SNAPSHOT_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);

for (const theme of ["light", "dark"])
  for (const [name, view, extra] of SHOTS) {
    if (only?.length && !only.includes(name)) continue;
    const file = path.join(out, `${tag}-${name}-${theme}.png`);
    fs.rmSync(file, { force: true });
    const env = {
      ...process.env,
      DUNEBOT_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "dunebot-snap-")),
      DUNEBOT_APPROVAL_MIN_MS: "0",
      ...(packaged ? {} : { DUNEBOT_CORE: core }),
      DUNEBOT_SNAPSHOT: file,
      DUNEBOT_SNAPSHOT_STILL: "1",
      DUNEBOT_SNAPSHOT_VIEW: view,
      DUNEBOT_SNAPSHOT_THEME: theme,
      // Times on the pages read the same on every system (the digits are tabular).
      TZ: "UTC",
      // Glass can't be captured; every system is drawn on the plain card so they can be compared.
      DUNEBOT_SNAPSHOT_MATERIAL: "none",
      // The same agents everywhere (the test agent only), found at once.
      DUNEBOT_CODEMAX: path.join(root, "no-codemax-for-snapshots"),
      ...(as ? { DUNEBOT_SNAPSHOT_PLATFORM: as } : {}),
      ...extra,
    };
    const args = packaged ? [] : [electron, "."];
    if (process.platform === "linux") args.push("--no-sandbox"); // containers and CI have no setuid sandbox
    const r = spawnSync(packaged ?? process.execPath, args, { cwd: root, env, encoding: "utf8", timeout: 90_000 });
    const log = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    if (!fs.existsSync(file)) {
      problems.push(`${name} ${theme}: no picture (exit ${r.status ?? r.signal})\n${log.slice(-1500)}`);
      continue;
    }
    let note = "";
    if (log.includes("never held still")) note += " (never held still: taken after 15 s anyway)";
    if (extra.DUNEBOT_SNAPSHOT_PLACE) {
      // "bar placed: card 596x60 at 378,794; gap below 24, left 378, right 378"
      const seen = [...log.matchAll(/bar (placed|resized): card (\d+)x(\d+) at -?\d+,-?\d+; gap below (-?\d+), left (-?\d+), right (-?\d+)/g)];
      for (const what of ["placed", "resized"]) {
        const m = seen.find((s) => s[1] === what);
        if (!m) {
          problems.push(`${name} ${theme}: no "bar ${what}" line in the log`);
          continue;
        }
        const [, , w, h, below, left, right] = m.map(Number);
        if (below !== 24) problems.push(`${name} ${theme}: bar ${what} ${below}px above the bottom, want 24`);
        if (Math.abs(left - right) > 1) problems.push(`${name} ${theme}: bar ${what} off centre (left ${left}, right ${right})`);
        note += ` ${what} ${w}x${h}`;
      }
    }
    if (name === "caption-sarvam") {
      // "speech: 2 queued, 2 started, 2 ended, …; sarvam read 2, 0 to the system voice"
      const m = log.match(/speech: .*sarvam read (\d+), (\d+) to the system voice/);
      if (!m) problems.push(`${name} ${theme}: no "speech:" line in the log`);
      else if (m[1] !== "2" || m[2] !== "0") problems.push(`${name} ${theme}: Sarvam read ${m[1]}, ${m[2]} went to the system voice (blob audio blocked?)`);
      else note += " sarvam played 2 of 2";
    }
    if (name === "caption-voice-ask") {
      // A new chat's first answer: read aloud (a "speech:" line with sentences streamed).
      let res = null;
      try {
        res = JSON.parse(fs.readFileSync(file.replace(/\.png$/, "") + ".script.json", "utf8"));
      } catch {}
      if (!/speech: .*streamed [1-9]/.test(log)) problems.push(`${name} ${theme}: a new chat's first answer wasn't read aloud (${JSON.stringify(res)})\n${log.split("\n").filter((l) => /speech|caption|turn/.test(l)).slice(-6).join("\n")}`);
      else note += " read aloud";
    }
    if (name === "caption-click") {
      // The picture is 512 px of the display under the pointer: (10, 20) in it is a point on that display.
      if (!/click: stand-in click ×1 at -?\d+,-?\d+/.test(log)) problems.push(`${name} ${theme}: the app didn't take the click\n${log.split("\n").filter((l) => /click|screen|turn/.test(l)).slice(-6).join("\n")}`);
      else note += " clicked (stand-in)";
    }
    if (name === "caption-held-read") {
      // The held question goes only after the answer has been read: "speech:" (reading over) first.
      const read = log.search(/speech: .*streamed [1-9]/);
      const done = log.indexOf("card done with the answer");
      if (read < 0 || done < 0 || done < read) problems.push(`${name} ${theme}: reading over at ${read}, card done at ${done} (done must come after)\n${log.split("\n").filter((l) => /speech|card |turn/.test(l)).slice(-8).join("\n")}`);
      else note += " waited for the reading to end";
    }
    if (name === "caption-first-line") {
      // "On it." read while the command still ran, then "Done." after it.
      let res = null;
      try {
        res = JSON.parse(fs.readFileSync(file.replace(/\.png$/, "") + ".script.json", "utf8"));
      } catch {}
      if (!res?.ok) problems.push(`${name} ${theme}: first line ${JSON.stringify(res)}\n${log.split("\n").filter((l) => /speech|card |turn/.test(l)).slice(-8).join("\n")}`);
      else note += " first line read while working, then the answer";
    }
    if (name === "bar-held") {
      // Said mid-answer: held, the card done with that answer, then asked by itself.
      let res = null;
      try {
        res = JSON.parse(fs.readFileSync(file.replace(/\.png$/, "") + ".script.json", "utf8"));
      } catch {}
      const marks = ["bar holds a question until the answer ends", "card done with the answer"].filter((l) => !log.includes(l));
      if (!res?.ok || marks.length) problems.push(`${name} ${theme}: held question ${JSON.stringify(res)}; missing in the log: ${marks.join(", ") || "none"}\n${log.split("\n").filter((l) => /bar |card |turn|caption/.test(l)).slice(-12).join("\n")}`);
      else note += " held, then asked by itself";
    }
    if (name === "caption-stream") {
      // "…; sarvam read 2, 0 to the system voice; streamed 2, first sound 63 ms"
      const m = log.match(/speech: .*sarvam read (\d+), (\d+) to the system voice;? streamed (\d+), first sound (\d+) ms/);
      if (!m) problems.push(`${name} ${theme}: no streamed "speech:" line in the log\n${log.split("\n").filter((l) => /speech|stream|audio|error/i.test(l)).slice(-6).join("\n")}`);
      else if (m[1] !== "2" || m[2] !== "0" || m[3] !== "2") problems.push(`${name} ${theme}: streamed ${m[3]}, sarvam read ${m[1]}, ${m[2]} to the system voice`);
      else note += ` streamed 2 of 2, first sound ${m[4]} ms`;
    }
    if (extra.DUNEBOT_SNAPSHOT_FOLLOW === "grab") {
      // "grab: held at tick 64 after 60 moves, 0 moves after"
      const m = log.match(/grab: held at tick (\d+) after (\d+) moves, (\d+) moves after/);
      if (!m) problems.push(`${name} ${theme}: no "grab:" line in the log (the card never held still)`);
      else {
        const [, at, moves, after] = m.map(Number);
        if (at === 0) problems.push(`${name} ${theme}: never held still, though the pointer headed for it`);
        else if (at < 60) problems.push(`${name} ${theme}: held at tick ${at}, while the pointer only moved beside it`);
        if (moves < 30) problems.push(`${name} ${theme}: followed only ${moves} moves before holding`);
        if (after) problems.push(`${name} ${theme}: moved ${after} times after holding still`);
        note += ` followed ${moves} moves, held at tick ${at}`;
      }
    } else if (extra.DUNEBOT_SNAPSHOT_FOLLOW) {
      // "follow: 148 moves, 3 side changes, 0 on the pointer, 0 off the screen, held for a card 140 ticks with 0 moves"
      const m = log.match(/follow: (\d+) moves, (\d+) side changes, (\d+) on the pointer, (\d+) off the screen, held for a card (\d+) ticks with (\d+) moves/);
      if (!m) problems.push(`${name} ${theme}: no "follow:" line in the log`);
      else {
        const [, moves, , under, outside, held, movedHeld] = m.map(Number);
        if (moves < 50) problems.push(`${name} ${theme}: the card moved only ${moves} times`);
        if (under) problems.push(`${name} ${theme}: the card was on the pointer ${under} times`);
        if (outside) problems.push(`${name} ${theme}: the card was off the screen ${outside} times`);
        if (held < 20) problems.push(`${name} ${theme}: never held still for the waiting card (${held} ticks)`);
        if (movedHeld) problems.push(`${name} ${theme}: moved ${movedHeld} times while a card waited`);
        note += ` ${moves} moves, held ${held} ticks`;
      }
    }
    if (name.startsWith("chat") && !as && process.platform !== "darwin") {
      // Windows/Linux: the system's window buttons are drawn over the chat's top right. They must be
      // there, and no header button may sit under them.
      const m = JSON.parse(fs.readFileSync(file.replace(/\.png$/, ".json"), "utf8"));
      if (!m.controls?.visible) problems.push(`chat ${theme}: the window buttons overlay isn't on (${JSON.stringify(m.controls)})`);
      else {
        const [fx, fw] = m.controls.free;
        for (const b of m.parts.filter((p) => p.sel === "button" && p.y < 56 && p.x + p.w > fx + fw))
          problems.push(`chat ${theme}: "${b.text}" sits under the window buttons (ends at ${b.x + b.w}, free up to ${fx + fw})`);
        note += ` window buttons from x ${fx + fw}`;
      }
    }
    console.log(`ok  ${path.basename(file)}${note}`);
  }

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nall pictures in ${out}`);
