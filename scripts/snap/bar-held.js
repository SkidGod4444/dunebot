// The bar's held question, end to end in hidden windows: said while the test agent's command runs,
// it waits ("Next" on the card), then goes by itself once that answer has ended. Speech is off.
(async () => {
  const dm = window.__dm;
  const call = window.dunebot.call;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await call("settings.set", { action: "run-command", mode: "always" });
  await call("prefs.set", { key: "agent", value: "echo" });
  const r = await call("prefs.set", { key: "voice.speak", value: "0" });
  dm.set({ prefs: r.prefs });
  const id = await dm.sendFromBar("run sleep 2");
  if (!id) return { ok: false, why: "the first question wasn't sent" };
  const users = async () => ((await call("threads.get", { id })).messages ?? []).filter((m) => m.role === "user").map((m) => m.text);
  let end = Date.now() + 5000;
  while (Date.now() < end && !dm.get().busy[id]) await sleep(50);
  if (!dm.get().busy[id]) return { ok: false, why: "the first answer never started" };
  window.dunebot.testTranscript("and how big is it?");
  await sleep(400);
  const early = (await users()).length;
  end = Date.now() + 20000;
  while (Date.now() < end && (await users()).length < 2) await sleep(150);
  await sleep(300);
  const all = await users();
  const box = document.querySelector("textarea")?.value ?? null;
  return { ok: early === 1 && all.length === 2 && all[1] === "and how big is it?" && !box, early, users: all, box };
})();
