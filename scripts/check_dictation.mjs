// Dictation end to end with nothing real touched: the core (core/src/dictation.rs) is fed words as if
// just said (DUNEBOT_DICTATION_TEST, no microphone), asks the app to type them, and electron/input.mjs
// types them into a fake addon, as main.mjs's inputForCore does. Checks the words arrive exactly, that a
// refusal (Dune Bot's own window has the keyboard, Accessibility off) types nothing and gives the card
// one sentence, that nothing heard types nothing, that dictation's stop/cancel leave other listening
// alone, the setting, and that the words reach no log and no other event.
//   node scripts/check_dictation.mjs [core binary]
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInput } from "../electron/input.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin = process.argv[2] ?? path.join(root, "core", "target", "debug", process.platform === "win32" ? "dunebot-core.exe" : "dunebot-core");
if (!fs.existsSync(bin)) throw new Error(`build the core first (bun run core): ${bin}`);

let failed = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failed++;
};

/** A core over stdio: calls, and every event kept in order. */
function startCore(env) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "dunebot-dictation-"));
  const p = spawn(bin, [], { env: { ...process.env, DUNEBOT_DATA_DIR: data, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  p.stderr.on("data", (d) => (stderr += d));
  const events = [];
  const waiters = new Set();
  const pending = new Map();
  let n = 0;
  createInterface({ input: p.stdout }).on("line", (line) => {
    const m = JSON.parse(line);
    if (m.id !== undefined && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
      return;
    }
    if (!m.event) return;
    events.push(m);
    for (const w of [...waiters]) if (w.pred(m)) (waiters.delete(w), w.resolve(m));
    core.onEvent?.(m);
  });
  const core = {
    events,
    stderr: () => stderr,
    call: (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++n;
        pending.set(id, resolve);
        p.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      }),
    wait: (pred, ms = 15000) =>
      new Promise((resolve, reject) => {
        const seen = events.find(pred);
        if (seen) return resolve(seen);
        const w = { pred, resolve };
        waiters.add(w);
        setTimeout(() => (waiters.delete(w), reject(new Error(`timed out; last events: ${JSON.stringify(events.slice(-4))}`))), ms);
      }),
    stop: () => p.stdin.end(),
    onEvent: null,
  };
  return core;
}

// The app's side: electron/input.mjs with a fake addon (it records keys, posts nothing) and the
// refusals main.mjs passes it, switched on and off by the test.
const keys = [];
let ours = false;
let accessOff = false;
const input = createInput({
  addon: () => ({
    postEventAccess: () => true,
    keyText: (t, down) => (keys.push([t, down]), true),
    keyCode: (code, flags, down) => (keys.push([`#${code}`, down]), true),
  }),
  screen: { getCursorScreenPoint: () => ({ x: 10, y: 10 }) },
  platform: "darwin",
  refuseOwn: () => {},
  // As main.mjs words them.
  refuseKeyboard: () => {
    if (ours)
      throw new Error(
        "Dune Bot's own window has the keyboard, and Dune Bot never types into itself. Click the place the text or keys should go first (look_at_screen, then click), then try again.",
      );
  },
  needAccess: () => {
    if (accessOff)
      throw new Error(
        "Dune Bot can't use the mouse or keyboard yet: macOS needs Dune Bot turned on in System Settings → Privacy & Security → Accessibility (open on the user's screen now). Ask the user to turn it on, then try again.",
      );
  },
  cancelled: () => false,
  stub: () => false,
});
const INPUTS = { type: input.typeText, keys: input.pressKeys };

const core = startCore({ DUNEBOT_DICTATION_TEST: "1" });
const asked = [];
core.onEvent = async (m) => {
  if (m.event !== "input.do") return;
  asked.push(m);
  try {
    const done = await INPUTS[m.kind](m);
    const note = typeof done === "object" ? done.note : "";
    await core.call("input.result", { requestId: m.requestId, ...(note ? { note } : {}) });
  } catch (e) {
    await core.call("input.result", { requestId: m.requestId, error: e.message });
  }
};
await core.wait((m) => m.event === "ready");

const outcome = (from) => core.wait((m) => m.event === "dictation.state" && m.state !== "typing" && core.events.indexOf(m) >= from);

// 1. Words as if just said: typed exactly, in order, through typeText; the card hears "typing", then "typed".
{
  const words = "Hello from Dune Bot, é ok.";
  const from = core.events.length;
  keys.length = 0;
  ok((await core.call("dictation.feed", { text: words })).result?.ok, "the core takes words to type (test hook on)");
  const end = await outcome(from);
  const states = core.events.slice(from).filter((m) => m.event === "dictation.state").map((m) => m.state);
  const typed = keys.filter(([, down]) => down).map(([t]) => t).join("");
  ok(asked.length === 1 && asked[0].kind === "type" && asked[0].text === words, `the app is asked to type them (${asked.length} asks)`);
  ok(typed === words, `typeText typed exactly what was said (${JSON.stringify(typed)})`);
  ok(JSON.stringify(states) === '["typing","typed"]' && end.chars === [...words].length, `the card: typing, then typed ${end.chars} characters (${states})`);
  ok(!core.events.some((m) => m.event === "voice.transcript"), "nothing goes to the bar (no voice.transcript)");
  ok(core.events.every((m) => m.event === "input.do" || !JSON.stringify(m).includes("Hello from")), "the words are in no event but the request to type them");
}

// 2. Dune Bot's own window has the keyboard: nothing typed, one sentence for the card.
{
  ours = true;
  keys.length = 0;
  const from = core.events.length;
  await core.call("dictation.feed", { text: "secret words" });
  const end = await outcome(from);
  ok(end.state === "refused" && keys.length === 0, `Dune Bot's window in front: refused, ${keys.length} keys sent`);
  ok(/own windows/.test(end.message) && !/look_at_screen/.test(end.message), `the card says one sentence: "${end.message}"`);
  ours = false;
}

// 3. Accessibility off: the same ask as the agents' typing (main.mjs opens it), nothing typed.
{
  accessOff = true;
  keys.length = 0;
  const from = core.events.length;
  await core.call("dictation.feed", { text: "more words" });
  const end = await outcome(from);
  ok(end.state === "refused" && keys.length === 0 && /Accessibility/.test(end.message), `Accessibility off: "${end.message}"`);
  accessOff = false;
}

// 4. Nothing heard: nothing typed, the card says so.
{
  const before = asked.length;
  const from = core.events.length;
  await core.call("dictation.feed", { text: "   " });
  const end = await outcome(from);
  ok(end.state === "nothing" && asked.length === before && /Right ⌥/.test(end.message), `nothing heard: nothing asked, "${end.message}"`);
}

// 5. Dictation's stop and cancel touch only a dictation's recording: with none, nothing changes (a
// hold to talk that took over would carry on; the unscoped cancel always says idle).
{
  const from = core.events.length;
  ok("result" in (await core.call("dictation.stop")) && "result" in (await core.call("dictation.cancel")), "dictation's stop and cancel answer with nothing recording");
  await core.call("voice.cancel");
  await core.wait((m) => m.event === "voice.state" && core.events.indexOf(m) >= from);
  const said = core.events.slice(from).filter((m) => m.event === "voice.state");
  ok(said.length === 1, `only the unscoped cancel said idle (${said.length} voice.state events)`);
}

// 6. The setting: on unless "off", checked, and the app is told at once.
{
  const s = await core.call("settings.get");
  ok("dictation" in s.result.prefs && s.result.prefs.dictation === null, "unset at first (on)");
  ok("error" in (await core.call("prefs.set", { key: "dictation", value: "maybe" })), "only on or off");
  const from = core.events.length;
  const r = await core.call("prefs.set", { key: "dictation", value: "off" });
  const ready = await core.wait((m) => m.event === "dictation.ready" && core.events.indexOf(m) >= from);
  ok(r.result?.prefs?.dictation === "off" && ready.on === false && ready.keys === "Right ⌥", `turned off: saved, and the app told (${JSON.stringify(ready)})`);
  ok(ready.available === false, "no key watching in this run (DUNEBOT_CHORD unset)");
}

// 7. Pages can't make these calls (main.mjs's allow list), and the core keeps the words out of its log.
{
  const main = fs.readFileSync(path.join(root, "electron", "main.mjs"), "utf8");
  const allowed = main.slice(main.indexOf("const ALLOWED"), main.indexOf("]);", main.indexOf("const ALLOWED")));
  ok(!/dictation/.test(allowed), "no dictation call is open to the windows");
  core.stop();
  await new Promise((r) => setTimeout(r, 300));
  ok(!/Hello from|secret words|more words/.test(core.stderr()), "the core's log has none of the words");
}

// 8. Without the test switch, the core refuses to be fed words.
{
  const plain = startCore({});
  await plain.wait((m) => m.event === "ready");
  const r = await plain.call("dictation.feed", { text: "should not type" });
  ok(/tests only/.test(r.error ?? ""), `feeding words is refused outside tests (${r.error})`);
  ok(!plain.events.some((m) => m.event === "input.do" || m.event === "dictation.state"), "nothing was asked or said");
  plain.stop();
}

console.log(failed ? `\n${failed} failed` : "\nall dictation checks passed");
process.exit(failed ? 1 : 0);
