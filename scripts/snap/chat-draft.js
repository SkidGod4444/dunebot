// A draft belongs to its chat: typed in one chat, it isn't in the next chat's box, and it's there
// again on coming back. Drawn back in the first chat with its draft.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(100); } return false; };
  await dm.startChat("echo", null, "First chat");
  const a = dm.get().activeId;
  await waitFor(() => !dm.get().busy[a]);
  await dm.startChat("echo", null, "Second chat");
  const b = dm.get().activeId;
  await waitFor(() => !dm.get().busy[b]);
  const box = () => document.querySelector("textarea[aria-label^='Message']");
  await dm.openThread(a);
  await waitFor(() => !!box());
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setValue.call(box(), "Half a thought for the first chat");
  box().dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(150);
  await dm.openThread(b);
  await sleep(300);
  const inOther = box()?.value ?? null;
  await dm.openThread(a);
  await sleep(300);
  return { inOther, back: box()?.value ?? null, chats: a !== b };
})();
