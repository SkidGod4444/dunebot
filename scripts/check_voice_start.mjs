// Starting the mic never waits for the voice keys (electron/voice-start.mjs): with a keychain that takes
// its time (macOS asking about a new build), the recording starts at once and the start resolves at
// once (so a stop stops the mic when you let go), and the keys are asked for before the mic, so the core
// knows to hold the text back until they're in (voice.keysComing; the waiting itself is the core's
// test text_waits_for_keys_being_unlocked). Before: a first dictation recorded nothing until Right ⌥
// was let go, then 16 s for a 1.5 s hold (2026-11-21).
//   node scripts/check_voice_start.mjs
import { createVoiceStart } from "../electron/voice-start.mjs";

let failed = 0;
const ok = (cond, what, got) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}${cond ? "" : ` (got ${JSON.stringify(got)})`}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rig({ blocked = false } = {}) {
  const seen = [];
  let unlock;
  const keys = new Promise((r) => (unlock = r));
  const v = createVoiceStart({
    hush: () => seen.push("hush"),
    micBlocked: () => blocked,
    openSetup: () => seen.push("setup"),
    call: async (method, params) => {
      seen.push(params?.source ? `${method} ${params.source}` : method);
      return { state: "listening" };
    },
    keysReady: () => {
      seen.push("keys asked");
      return keys.then(() => seen.push("keys in"));
    },
  });
  return { v, seen, unlock };
}

// 1. A keychain that hasn't answered: the mic starts and the start is over, without the keys.
{
  const { v, seen, unlock } = rig();
  let done = false;
  const started = v.start("dictation").then((r) => ((done = true), r));
  await sleep(50);
  ok(seen.includes("voice.start dictation"), "the mic starts while the keychain is still asking", seen);
  ok(done, "the start is over without the keys, so letting go stops the mic at once", seen);
  ok(seen.indexOf("keys asked") >= 0 && seen.indexOf("keys asked") < seen.indexOf("voice.start dictation"), "the keys are asked for first (the core then holds the text for them)", seen);
  ok((await started)?.state === "listening", "it answers with the core's answer", seen);
  unlock();
  await sleep(10);
  ok(seen.at(-1) === "keys in", "the keys still come in afterwards", seen);
}

// 2. No microphone allowed: setup opens, nothing records, no key is unlocked.
{
  const { v, seen } = rig({ blocked: true });
  const e = await v.start("chord").catch((err) => err);
  ok(e instanceof Error && /Allow the microphone/.test(e.message), "a blocked mic refuses with a sentence", e?.message);
  ok(seen.join() === "hush,setup", "it opens setup and starts nothing", seen);
}

console.log(failed ? `${failed} FAIL` : "ALL PASS");
process.exit(failed ? 1 : 0);
