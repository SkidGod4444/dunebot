// Dictation pressed, not held (Wayland: GNOME's shortcut runs Dune Bot with --dictate, electron/main.mjs
// "second-instance"): electron/dictation.mjs with stand-ins for the app around it. Once starts
// listening, again types (a moment later, once the shortcut's keys are up); a double tap, a press while
// typing, or with dictation off does nothing; the stop key calls it off; a typing session the desktop
// must ask for first calls it off; a recording that stopped itself leaves it ready for the next press.
// Holding the key (macOS, Windows, X11) works as before.
//   node scripts/check_dictation_press.mjs
import { createDictation } from "../electron/dictation.mjs";

let failed = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness({ ready = async () => {}, voice = async () => ({ ok: true }), micBlocked = () => false } = {}) {
  const t = { calls: [], voices: 0, shown: 0, hidden: 0, emitted: [], setup: [] };
  const d = createDictation({
    call: async (method, params) => {
      t.calls.push({ method, params, at: Date.now() });
      return { ok: true };
    },
    log: () => {},
    emit: (m) => t.emitted.push(m),
    micBlocked,
    openSetup: (step) => t.setup.push(step),
    startVoice: async (source) => {
      t.voices++;
      t.source = source;
      return voice();
    },
    showListening: () => t.shown++,
    hideListening: () => t.hidden++,
    savePref: async () => {},
    refreshTray: () => {},
    readyToType: ready,
  });
  t.d = d;
  t.named = (m) => t.calls.filter((c) => c.method === m);
  return t;
}
// What the core says at start on Wayland: it can't watch a key; dictation is on.
const WAYLAND_READY = { event: "dictation.ready", available: false, on: true, keys: "Right Ctrl" };

// 1. No shortcut yet: nothing in the menu bar. With one: its name, and the core told (for its notes).
{
  const t = harness();
  t.d.onEvent(WAYLAND_READY);
  ok(t.d.menu().length === 0 && t.d.hint().length === 0, "no shortcut, no key watched: no dictation in the menu bar");
  t.d.setPressKey("Super+Alt+D");
  await sleep(10);
  const label = t.d.menu().find((i) => i.type === "checkbox")?.label;
  ok(label === "Press Super+Alt+D to type what you say", `the menu bar says to press it (${label})`);
  ok(t.d.hint()[0]?.label.endsWith("press Super+Alt+D"), `Talk's hint says press (${t.d.hint()[0]?.label})`);
  ok(t.named("dictation.pressed")[0]?.params.keys === "Super+Alt+D", "the core is told the shortcut (its notes say press, not hold)");
}

// 2. Press: listening. Again too soon: the same press. Again later: typed, a moment after the press.
{
  const t = harness();
  t.d.onEvent(WAYLAND_READY);
  t.d.setPressKey("Super+Alt+D");
  t.d.press();
  await sleep(20);
  ok(t.voices === 1 && t.source === "dictation" && t.shown === 1, `pressed once: the mic opens for dictation, "Listening…" shows (${t.voices} starts)`);
  t.d.press();
  await sleep(450);
  ok(t.named("dictation.stop").length === 0 && t.voices === 1, "pressed again within half a second (a double tap): ignored");
  await sleep(100);
  const at = Date.now();
  t.d.press();
  await sleep(200);
  ok(t.named("dictation.stop").length === 0, "pressed again: not ended at once (the shortcut's keys may still be down)");
  await sleep(300);
  const stop = t.named("dictation.stop")[0];
  ok(stop && stop.at - at >= 330, `then ended, ${stop ? stop.at - at : "never"} ms after the press: what was said is typed`);
  t.d.onEvent({ event: "dictation.state", state: "typing", chars: 12 });
  await sleep(550);
  t.d.press();
  await sleep(20);
  ok(t.voices === 1, "a press while the words are being typed: ignored");
  t.d.onEvent({ event: "dictation.state", state: "typed", chars: 12 });
  await sleep(550);
  t.d.press();
  await sleep(20);
  ok(t.voices === 2, "typed: the next press dictates again");
}

// 3. The stop key while listening: called off, nothing typed.
{
  const t = harness();
  t.d.onEvent(WAYLAND_READY);
  t.d.setPressKey("Super+Alt+D");
  t.d.press();
  await sleep(20);
  t.d.stop();
  await sleep(20);
  ok(t.named("dictation.cancel").length === 1 && t.named("dictation.stop").length === 0 && t.hidden === 1, "the stop key: the dictation is called off, the card goes");
  await sleep(550);
  t.d.press();
  await sleep(20);
  ok(t.voices === 2 && t.named("dictation.stop").length === 0, "the next press starts a new one (not an end)");
  t.d.stop();
}

// 4. Dictation turned off: a press does nothing.
{
  const t = harness();
  t.d.onEvent({ ...WAYLAND_READY, on: false });
  t.d.setPressKey("Super+Alt+D");
  t.d.press();
  await sleep(20);
  ok(t.voices === 0, "dictation off: a press does nothing");
}

// 5. The desktop has to ask before Dune Bot may type: this dictation is called off, the user told.
{
  const t = harness({ ready: () => sleep(50).then(() => Promise.reject(new Error("GNOME is asking the user"))) });
  t.d.onEvent(WAYLAND_READY);
  t.d.setPressKey("Super+Alt+D");
  t.d.press();
  await sleep(120);
  const note = t.emitted.find((m) => m.event === "dictation.state");
  ok(t.named("dictation.cancel").length === 1, "no typing session yet: the dictation is called off (nothing typed later into a box)");
  ok(/answer the desktop's box first, then press Super\+Alt\+D again/.test(note?.message ?? ""), `and the user told what to do: "${note?.message}"`);
  const t2 = harness({ ready: () => Promise.reject(new Error("Nothing typed: this desktop doesn't let apps type for you.")) });
  t2.d.onEvent(WAYLAND_READY);
  t2.d.setPressKey("Super+Alt+D");
  t2.d.press();
  await sleep(50);
  ok(t2.emitted.find((m) => m.event === "dictation.state")?.message === "Nothing typed: this desktop doesn't let apps type for you.", "a reason of the app's own is said as it is");
}

// 6. The mic didn't open: the next press starts again (not an end of nothing).
{
  let fail = true;
  const t = harness({ voice: async () => (fail ? Promise.reject(new Error("no microphone")) : { ok: true }) });
  t.d.onEvent(WAYLAND_READY);
  t.d.setPressKey("Super+Alt+D");
  t.d.press();
  await sleep(30);
  fail = false;
  await sleep(500);
  t.d.press();
  await sleep(20);
  ok(t.voices === 2 && t.named("dictation.stop").length === 0, "the mic failed: the next press starts listening again");
  t.d.stop();
}

// 7. The recording stopped itself (60 s, or nothing heard): the next press starts a new one.
{
  const t = harness();
  t.d.onEvent(WAYLAND_READY);
  t.d.setPressKey("Super+Alt+D");
  t.d.press();
  await sleep(20);
  t.d.onEvent({ event: "dictation.state", state: "nothing", message: "Didn't catch that." });
  await sleep(500);
  t.d.press();
  await sleep(20);
  ok(t.voices === 2 && t.named("dictation.stop").length === 0, "after a recording that ended itself, a press starts again");
  t.d.stop();
}

// 8. The microphone not allowed: setup opens at its step, nothing recorded.
{
  const t = harness({ micBlocked: () => true });
  t.d.onEvent(WAYLAND_READY);
  t.d.setPressKey("Super+Alt+D");
  t.d.press();
  await sleep(20);
  ok(t.voices === 0 && t.setup[0] === "mic", "microphone not allowed: setup opens at it, nothing recorded");
}

// 9. Holding the key (macOS, Windows, X11): as before, ended the moment it's let go.
{
  const t = harness();
  t.d.onEvent({ event: "dictation.ready", available: true, on: true, keys: "Right Ctrl" });
  ok(t.d.menu().find((i) => i.type === "checkbox")?.label === "Hold Right Ctrl to type what you say", "a held key: the menu bar says hold");
  t.d.onEvent({ event: "dictation", kind: "hold-start" });
  await sleep(20);
  const at = Date.now();
  t.d.onEvent({ event: "dictation", kind: "hold-end" });
  await sleep(40);
  const stop = t.named("dictation.stop")[0];
  ok(t.voices === 1 && stop && stop.at - at < 30, `held then let go: ended at once (${stop ? stop.at - at : "never"} ms)`);
}

console.log(failed ? `${failed} FAIL` : "ALL PASS");
process.exit(failed ? 1 : 0);
