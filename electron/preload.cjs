// The only bridge into the pages: calls to the core (allow-listed in main), its events, and the
// few window actions the bar, the history window and the setup window need.
const { contextBridge, ipcRenderer } = require("electron");

const listen = (channel) => (fn) => {
  const h = (_e, value) => fn(value);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld("dunebot", {
  // Snapshots may render another system's version of the pages; the app itself always uses the real one.
  platform: (process.env.DUNEBOT_SNAPSHOT && process.env.DUNEBOT_SNAPSHOT_PLATFORM) || process.platform,
  call: (method, params) => ipcRenderer.invoke("core:call", method, params),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  onEvent: listen("core:event"),
  onNav: listen("nav"),
  onLook: listen("look"),
  openMain: (view) => ipcRenderer.send("open-main", view),
  glassRadius: (radius) => ipcRenderer.send("glass:radius", radius),
  note: (text) => ipcRenderer.send("page:note", String(text).slice(0, 200)),
  // Hidden-window checks only (main ignores it otherwise).
  testTranscript: (text) => ipcRenderer.send("test:transcript", String(text)),
  // The voice keys (Sarvam; Deepgram for English in an American voice): pages can save or remove
  // them and see whether one is saved, never read them.
  sarvam: {
    status: () => ipcRenderer.invoke("sarvam:status"),
    save: (key) => ipcRenderer.invoke("sarvam:save", String(key)),
    remove: () => ipcRenderer.invoke("sarvam:remove"),
  },
  deepgram: {
    status: () => ipcRenderer.invoke("deepgram:status"),
    save: (key) => ipcRenderer.invoke("deepgram:save", String(key)),
    remove: () => ipcRenderer.invoke("deepgram:remove"),
  },
  setup: {
    status: () => ipcRenderer.invoke("setup:status"),
    ask: (what) => ipcRenderer.invoke("setup:ask", what),
    openSettings: (what) => ipcRenderer.send("setup:settings", what),
    fit: (height) => ipcRenderer.send("setup:fit", height),
    finish: (done) => ipcRenderer.invoke("setup:finish", done),
  },
  bar: {
    resize: (height) => ipcRenderer.send("bar:resize", height),
    hide: () => ipcRenderer.send("bar:hide"),
    // A question was sent: the bar closes and its answer shows beside the pointer.
    sent: (threadId) => ipcRenderer.send("bar:sent", String(threadId)),
    open: () => ipcRenderer.send("bar:open"),
    // What you said while the answer was still coming: shown on the card as "Next" (null: gone).
    held: (h) => ipcRenderer.send("bar:held", h ? { chat: String(h.chat), text: String(h.text).slice(0, 300) } : null),
    // The card has finished reading that answer: the held question can go.
    onCardDone: listen("bar:card-done"),
    // ↑ in the empty bar: the last answer comes back beside the pointer.
    last: () => ipcRenderer.send("bar:last"),
    agents: () => ipcRenderer.invoke("bar:agents"),
    onThread: listen("bar:thread"),
    onFocus: listen("bar:focus"),
  },
  caption: {
    hide: () => ipcRenderer.send("caption:hide"),
    mouse: (on) => ipcRenderer.send("caption:mouse", !!on),
    onShow: listen("caption:show"),
    onHush: listen("caption:hush"),
    onNext: listen("caption:next"),
    nextDone: () => ipcRenderer.send("caption:next-done"),
    // It follows the pointer (main moves it): where it sits, whether it's moving, and when it may stop.
    onPlace: listen("caption:place"),
    onMoving: listen("caption:moving"),
    settled: (on) => ipcRenderer.send("caption:settled", !!on),
    testShow: (threadId) => ipcRenderer.send("caption:test-show", String(threadId)),
  },
});

// Wayland, while an agent uses the pointer: this page takes no mouse input (electron/pass-clicks.mjs).
// Wayland never says where Dune Bot's windows are, so an agent's click can land on one; it's
// swallowed here, before the page's own handlers, and reported, so nothing in Dune Bot is pressed.
let guarded = false;
const swallow = (e) => {
  if (!guarded) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.type === "pointerdown" || e.type === "mousedown" || e.type === "wheel") ipcRenderer.send("guard:hit", e.type);
};
// Clicks: always listened for (first, before any page script), acting only while guarded.
for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu"])
  window.addEventListener(type, swallow, { capture: true });
// Wheel and touch only while guarded: a listener that may cancel them makes every scroll wait for it.
const blocking = ["wheel", "touchstart", "touchend"];
const guard = (on) => {
  if (!!on !== guarded) for (const type of blocking) window[on ? "addEventListener" : "removeEventListener"](type, swallow, { capture: true, passive: false });
  guarded = !!on;
};
ipcRenderer.on("guard", (_e, on, n) => {
  guard(on);
  if (n) ipcRenderer.send("guard:ack", n);
});
// A page that loads while an agent's step is under way starts guarded (main always answers on Linux).
if (process.platform === "linux") guard(ipcRenderer.sendSync("guard:state") === true);
