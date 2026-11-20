// Starting the mic doesn't wait for the voice keys (electron/voice-start.mjs): with a keychain that takes
// its time (macOS asking about a new build), the recording has already started, the start resolves
// only once the keys are in, and the mic button's stop waits for them. Before, a first dictation
// recorded nothing until Right ⌥ was let go (2026-11-21).
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

// 1. A slow keychain: the mic is on before the keys are, and the start waits for them.
{
  const { v, seen, unlock } = rig();
  let done = false;
  const started = v.start("dictation").then((r) => ((done = true), r));
  await sleep(50);
  ok(seen.includes("voice.start dictation"), "the mic starts while the keychain is still asking", seen);
  ok(seen.indexOf("voice.start dictation") < seen.indexOf("keys asked"), "the mic is asked for before the keys", seen);
  ok(!done, "the start isn't over until the keys are in (stops wait for it)", seen);
  unlock();
  const r = await started;
  ok(done && seen.at(-1) === "keys in" && r?.state === "listening", "then it resolves, with the core's answer", { seen, r });
}

// 2. The mic button's stop waits for the keys.
{
  const { v, seen, unlock } = rig();
  const stopped = v.stop();
  await sleep(50);
  ok(!seen.includes("voice.stop"), "the button's stop waits while the keys aren't in", seen);
  unlock();
  await stopped;
  ok(seen.indexOf("keys in") < seen.indexOf("voice.stop"), "and stops once they are", seen);
}

// 3. No microphone allowed: setup opens, nothing records, no key is unlocked.
{
  const { v, seen } = rig({ blocked: true });
  const e = await v.start("chord").catch((err) => err);
  ok(e instanceof Error && /Allow the microphone/.test(e.message), "a blocked mic refuses with a sentence", e?.message);
  ok(seen.join() === "hush,setup", "it opens setup and starts nothing", seen);
}

console.log(failed ? `${failed} FAIL` : "ALL PASS");
process.exit(failed ? 1 : 0);
