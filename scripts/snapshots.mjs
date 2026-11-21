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
import { pointerRun } from "./check_pointer.mjs";

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
  // The test agent clicks, scrolls, drags, types and presses keys; the app logs it (stand-ins, no real input).
  ["caption-click", "caption", {
    DUNEBOT_SCREEN_STUB: path.join(root, "electron", "assets", "icon.png"),
    DUNEBOT_INPUT_STUB: "1",
    DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "caption-click.js"),
  }],
  // Teaching: the test agent points at a tab in a stand-in picture, looks again, then clicks under the
  // highlight (stand-ins); the click must not be refused as Dune Bot's own window (check_pointer.mjs).
  ["pointer", "pointer", {
    DUNEBOT_SCREEN_STUB: path.join(root, "electron", "assets", "icon.png"),
    DUNEBOT_INPUT_STUB: "1",
    DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "pointer.js"),
  }],
  // Dictation: words as if just said (no microphone) typed through the app's stand-in keyboard; then
  // with Dune Bot's own window holding the keyboard, nothing typed and the card says why.
  ["caption-dictation", "caption", { DUNEBOT_INPUT_STUB: "1", DUNEBOT_DICTATION_TEST: "1", DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "caption-dictation.js") }],
  ["caption-dictation-refused", "caption", {
    DUNEBOT_INPUT_STUB: "1",
    DUNEBOT_DICTATION_TEST: "1",
    DUNEBOT_SNAPSHOT_KEYBOARD: "ours",
    DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "caption-dictation.js"),
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
  // Settings (bottom of the sidebar, or ⌘,): the look, keys and voice; Permissions keeps every safety control.
  ["settings", "main", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "settings.js") }],
  ["permissions-voice", "main", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "permissions-voice.js") }],
  // Settings › Look: the other theme picked; the window's colours follow (drawn in the one picked).
  ["permissions-theme", "main", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "permissions-theme.js") }],
  // Settings › Keys: the dictation key picker, "Ctrl twice" picked (for keyboards with no right-hand key).
  ["settings-dictation-key", "main", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "settings-dictation-key.js"), DUNEBOT_SNAPSHOT_APPLE_DICTATION: "1" }],
  // Permissions › Bots (three bots, one open in the editor), and the bar's picker with them in it.
  ["bots", "main", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "bots.js") }],
  ["bar-bots", "bar", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "bar-bots.js") }],
  // Permissions › Phone (the Telegram bot): no token; then drawn with a pairing code, and paired.
  ["permissions-phone", "main", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "permissions-phone.js") }],
  ["permissions-phone-code", "main", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "permissions-phone-code.js") }],
  ["permissions-phone-paired", "main", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "permissions-phone-paired.js") }],
  ["permissions-connectors", "main", { DUNEBOT_SNAPSHOT_SCRIPT: path.join(root, "scripts", "snap", "permissions-connectors.js") }],
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
    const problemsBefore = problems.length;
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
      const want = [
        /input: stand-in click ×1 at -?\d+,-?\d+/,
        /input: stand-in scroll 0,-1 ×6 at -?\d+,-?\d+/,
        /input: stand-in drag -?\d+,-?\d+ → -?\d+,-?\d+/,
        /input: stand-in typing, 11 characters/,
        /input: stand-in keys ctrl\+t ×2/,
      ];
      const missing = want.filter((re) => !re.test(log));
      let res = null;
      try {
        res = JSON.parse(fs.readFileSync(file.replace(/\.png$/, "") + ".script.json", "utf8"));
      } catch {}
      if (missing.length) problems.push(`${name} ${theme}: the app didn't take ${missing.map(String).join(", ")}; steps ${JSON.stringify(res)}\n${log.split("\n").filter((l) => /input|screen|turn/.test(l)).slice(-10).join("\n")}`);
      else note += " clicked, scrolled, dragged, typed and pressed keys (stand-ins)";
    }
    if (name === "pointer") {
      const run = pointerRun(log);
      for (const p of run.problems) problems.push(`${name} ${theme}: ${p}\n${log.split("\n").filter((l) => /pointer|input|screen|turn/.test(l)).slice(-10).join("\n")}`);
      note += run.note;
    }
    if (name.startsWith("caption-dictation")) {
      let res = null;
      try {
        res = JSON.parse(fs.readFileSync(file.replace(/\.png$/, "") + ".script.json", "utf8"));
      } catch {}
      const states = (res?.states ?? []).map((s) => s.state).join(",");
      const typed = /input: stand-in typing, 19 characters/.test(log);
      const why = [];
      if (!res?.listening) why.push("the card never said Listening…");
      if (name === "caption-dictation") {
        if (!typed) why.push("the app never typed (stand-in) the 19 characters");
        if (states !== "typing,typed") why.push(`the card was told ${states || "nothing"}`);
        if (!/dictation typed, 19 characters/.test(log)) why.push("no \"dictation typed\" line in the log");
      } else {
        if (typed) why.push("it typed, though Dune Bot's own window had the keyboard");
        if (!/input: type: Dune Bot's own window has the keyboard/.test(log)) why.push("typeText's refusal isn't in the log");
        if (states !== "typing,refused") why.push(`the card was told ${states || "nothing"}`);
        if (!/own windows/.test(res?.note ?? "")) why.push(`the card showed "${res?.note ?? ""}"`);
      }
      if (/Hello from Dune Bot/.test(log)) why.push("the words are in the log");
      if (why.length) problems.push(`${name} ${theme}: ${why.join("; ")} (${JSON.stringify(res)})\n${log.split("\n").filter((l) => /dictation|input/.test(l)).slice(-8).join("\n")}`);
      else note += name === "caption-dictation" ? ` typed (stand-in)${res.typingShown ? ", \"Typing…\" shown" : ""}` : " refused, the card said why";
    }
    if (name === "bots" || name === "bar-bots") {
      let res = null;
      try {
        res = JSON.parse(fs.readFileSync(file.replace(/\.png$/, "") + ".script.json", "utf8"));
      } catch {}
      const good =
        name === "bots"
          ? res?.rows?.join() === "Researcher,Writer" && res.editor && res.editing === "Ops" && res.pressed?.join() === "Run commands,Read files" && res.handCursor
          : res?.groups?.join() === "Bots" && res.options?.join() === "Researcher,Writer,Ops" && res.picked && /Wr\s*Writer/.test(res.label ?? "") && res.handCursor;
      if (!good) problems.push(`${name} ${theme}: ${JSON.stringify(res)}`);
      else note += name === "bots" ? " three bots, Ops in the editor, hand cursor on every button" : " bots in the picker, Writer picked";
    }
    if (name === "caption-held-read") {
      // The held question goes only after the answer has been read: "speech:" (reading over) first.
      const read = log.search(/speech: .*streamed [1-9]/);
      const done = log.indexOf("card done with the answer");
      if (read < 0 || done < 0 || done < read) problems.push(`${name} ${theme}: reading over at ${read}, card done at ${done} (done must come after)\n${log.split("\n").filter((l) => /speech|card |turn/.test(l)).slice(-8).join("\n")}`);
      else note += " waited for the reading to end";
    }
    if (name === "settings") {
      // ⌘, opens Settings (look, keys, voice); every safety control stays on Permissions.
      let res = null;
      try {
        res = JSON.parse(fs.readFileSync(file.replace(/\.png$/, "") + ".script.json", "utf8"));
      } catch {}
      const want = "Look,Keys,Voice";
      const ok =
        res?.byKey === "Settings" &&
        res.permissions.title === "Permissions" &&
        res.permissions.sections.join() === "Connectors,Phone,Bots,Always off limits" &&
        !res.permissions.theme &&
        res.settings.title === "Settings" &&
        res.settings.sections.join() === want &&
        res.settings.active;
      if (!ok) problems.push(`${name} ${theme}: pages ${JSON.stringify(res)}`);
      else note += ` ⌘, opens it; Settings: ${want}; Permissions: actions, Connectors, Phone, Bots, off limits`;
    }
    if (name === "settings-dictation-key") {
      // Picking the second key saves it, and the row says what to do with it now. macOS (drawn with
      // Apple's Dictation on): the clash warning shows after ⌃ twice is picked, not before.
      let res = null;
      try {
        res = JSON.parse(fs.readFileSync(file.replace(/\.png$/, "") + ".script.json", "utf8"));
      } catch {}
      const mac = res?.platform === "darwin"; // the page drawn (snapshots may draw another system's)
      const want = mac ? ["Right ⌥,⌃ twice", "Hold Right ⌥ to type what you say", "⌃ twice", "Tap ⌃, then hold it to type what you say"] : ["Right Ctrl,Ctrl twice", "Hold Right Ctrl to type what you say", "Ctrl twice", "Tap Ctrl, then hold it to type what you say"];
      const ok =
        res?.found &&
        res.buttons?.join() === want[0] &&
        res.before === want[1] &&
        res.picked === want[2] &&
        res.after === want[3] &&
        res.pref === "ctrl-twice" &&
        res.warnedBefore === false &&
        (mac ? /Apple's Dictation is also turned on/.test(res.warning ?? "") : res.warning === null);
      if (!ok) problems.push(`${name} ${theme}: the dictation key picker didn't pick Ctrl twice (${JSON.stringify(res)})`);
      else note += ` dictation key: ${res.buttons.join(" / ")}; picked ${res.picked}${mac ? "; Apple Dictation warning shown" : ""}`;
    }
    if (name === "permissions-theme") {
      // Picking Light in a dark window (Dark in a light one) turns the whole window over, and it stays picked.
      let res = null;
      try {
        res = JSON.parse(fs.readFileSync(file.replace(/\.png$/, "") + ".script.json", "utf8"));
      } catch {}
      const want = theme === "dark" ? ["Light", "light"] : ["Dark", "dark"];
      const ok =
        res?.found &&
        res.buttons?.join() === "Dark,Light,Match the system" &&
        res.before.dark === (theme === "dark") &&
        res.after.dark === (theme !== "dark") &&
        res.before.body !== res.after.body &&
        res.picked === want[0] &&
        res.pref === want[1];
      if (!ok) problems.push(`${name} ${theme}: Theme ${JSON.stringify(res)}`);
      else note += ` ${want[0]} picked: ${res.before.body} → ${res.after.body}`;
    }
    if (name.startsWith("permissions-phone")) {
      // { found, code, paired, switches }: the section is there with its three switches, and the state asked for.
      let res = null;
      try {
        res = JSON.parse(fs.readFileSync(file.replace(/\.png$/, "") + ".script.json", "utf8"));
      } catch {}
      const want = { "permissions-phone": [false, false], "permissions-phone-code": [true, false], "permissions-phone-paired": [false, true] }[name];
      if (!res?.found || res.switches !== 3 || res.code !== want[0] || res.paired !== want[1]) problems.push(`${name} ${theme}: Phone section ${JSON.stringify(res)}`);
      else note += res.code ? " pairing code shown" : res.paired ? " paired, Unpair shown" : " token box and three switches";
    }
    if (name === "caption-first-line") {
      // "On it." read while the command still ran, then "Done." after it.
      let res = null;
      try {
        res = JSON.parse(fs.readFileSync(file.replace(/\.png$/, "") + ".script.json", "utf8"));
      } catch {}
      if (!res?.ok) problems.push(`${name} ${theme}: first line ${JSON.stringify(res)}\n${log.split("\n").filter((l) => /speech|card |turn/.test(l)).slice(-8).join("\n")}`);
      else note += " first line read while working (the card said what it was doing), then the answer";
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
    // A check failed: the core's own complaints (a crash prints "panicked"), and the end of the log
    // as it was, whatever the check looked for.
    if (problems.length > problemsBefore) {
      // The whole log beside the picture (CI keeps both), for what the last lines don't show.
      fs.writeFileSync(file.replace(/\.png$/, ".log"), log);
      const lines = log.split("\n");
      const said = lines.filter((l) => /panicked|dunebot-core:/.test(l)).slice(-8);
      if (said.length) problems[problems.length - 1] += `\n  core said:\n  ${said.join("\n  ")}`;
      problems[problems.length - 1] += `\n  log's last lines:\n  ${lines.filter((l) => l.trim()).slice(-20).join("\n  ")}`;
    }
    console.log(`ok  ${path.basename(file)}${note}`);
  }

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nall pictures in ${out}`);
