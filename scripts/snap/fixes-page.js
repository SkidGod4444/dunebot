// The Fixes page with two fixes, one from a chat and one switched off.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = window.dunebot.call;
  await dm.startChat("echo", null, "run npm install");
  const id = dm.get().activeId;
  await call("fixes.add", { threadId: id, failure: "Command didn't run: npm install", detail: "The user declined this action.", fix: "Use bun for anything JavaScript, never npm or yarn" });
  const off = await call("fixes.add", { fix: "Ask before touching files outside the chat's folder" });
  await call("fixes.set", { id: off.id, enabled: false });
  await call("threads.cancel", { id }).catch(() => {});
  dm.set({ view: "fixes" });
  await sleep(700);
})();
