// Dictation through the real app, hidden, with a stand-in keyboard and no microphone: the card listens
// (the voice states set as the core would), then words as if just said go to the core
// (DUNEBOT_DICTATION_TEST), which asks main.mjs to type them through electron/input.mjs. With
// DUNEBOT_SNAPSHOT_KEYBOARD=ours, Dune Bot's own window has the keyboard: nothing is typed and the card
// says why in one sentence (the picture). Returns what the card was told and showed.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const states = [];
  const off = window.dunebot.onEvent((m) => {
    if (m.event === "dictation.state") states.push({ state: m.state, chars: m.chars ?? null, message: m.message ?? null });
  });
  dm.caption({ threadId: null, side: "below", align: "left", speak: false });
  dm.set({ voice: { state: "listening", level: 0.4, source: "dictation" } });
  await sleep(400);
  const listening = document.body.textContent.includes("Listening…");
  // Let go: written down, then the core's "typing" before the voice goes idle.
  dm.set({ voice: { state: "transcribing", level: 0 } });
  await sleep(200);
  window.dunebot.testDictate?.("Hello from Dune Bot");
  let typingShown = false;
  const end = Date.now() + 10000;
  while (Date.now() < end && !states.some((s) => s.state !== "typing")) {
    if (states.length && dm.get().voice.state !== "idle") dm.set({ voice: { state: "idle", level: 0 } });
    typingShown ||= document.body.textContent.includes("Typing…");
    await sleep(10);
  }
  if (dm.get().voice.state !== "idle") dm.set({ voice: { state: "idle", level: 0 } });
  off();
  await sleep(300);
  const note = [...document.querySelectorAll(".dm-caption p")].map((p) => p.textContent).join(" ");
  return { listening, typingShown, states, note };
})();
