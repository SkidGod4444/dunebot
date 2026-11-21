// The only bridge into the pages: calls to the core (allow-listed in main), its events, and the
// few window actions the bar, the history window and the setup window need.
const { contextBridge, ipcRenderer } = require("electron");

const listen = (channel) => (fn) => {
  const h = (_e, value) => fn(value);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

// What a page is told about its own state (which chat the card shows, the question held for next):
// main sends it as soon as the page has loaded, but React listens a moment later (in an effect), and
// Electron drops a message nobody listens for. The last one that came with nobody listening is kept
// and handed over when the page starts to. (The card once missed both, so it never said it was done
// and a held question waited: bar-held on CI.)
const latest = (channel) => {
  const fns = new Set();
  let kept = null; // { value } while one waits
  ipcRenderer.on(channel, (_e, value) => {
    if (fns.size) for (const f of fns) f(value);
    else kept = { value };
  });
  return (fn) => {
    fns.add(fn);
    if (kept) {
      const { value } = kept;
      kept = null;
      fn(value);
    }
    return () => fns.delete(fn);
  };
};

contextBridge.exposeInMainWorld("dunebot", {
  // Snapshots may render another system's version of the pages; the app itself always uses the real one.
  platform: (process.env.DUNEBOT_SNAPSHOT && process.env.DUNEBOT_SNAPSHOT_PLATFORM) || process.platform,
  // A Wayland desktop (no held keys for apps: dictation has no key there). Snapshots draw X11's pages.
  wayland: !process.env.DUNEBOT_SNAPSHOT && process.platform === "linux" && (process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY),
  call: (method, params) => ipcRenderer.invoke("core:call", method, params),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  // macOS: Apple's own Dictation is on (its shortcut may be Control twice, as "⌃ twice" is).
  appleDictation: () => ipcRenderer.invoke("dictation:apple"),
  onEvent: listen("core:event"),
  onNav: listen("nav"),
  onLook: listen("look"),
  openMain: (view) => ipcRenderer.send("open-main", view),
  glassRadius: (radius) => ipcRenderer.send("glass:radius", radius),
  note: (text) => ipcRenderer.send("page:note", String(text).slice(0, 200)),
  // Hidden-window checks only (main ignores it otherwise).
  testTranscript: (text) => ipcRenderer.send("test:transcript", String(text)),
  // Hidden-window checks only (main ignores it otherwise): words as if just dictated, no microphone.
  testDictate: (text) => ipcRenderer.send("test:dictate", String(text)),
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
  // The Telegram bot's token (Permissions › Phone): the same, save or remove, never read.
  telegram: {
    status: () => ipcRenderer.invoke("telegram:status"),
    save: (key) => ipcRenderer.invoke("telegram:save", String(key)),
    remove: () => ipcRenderer.invoke("telegram:remove"),
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
    hide: (n) => ipcRenderer.send("caption:hide", typeof n === "number" ? n : null), // the number of the card closing
    mouse: (on) => ipcRenderer.send("caption:mouse", !!on),
    onShow: latest("caption:show"),
    onHush: listen("caption:hush"),
    onNext: latest("caption:next"),
    nextDone: () => ipcRenderer.send("caption:next-done"),
    // It follows the pointer (main moves it): where it sits, whether it's moving, and when it may stop.
    onPlace: latest("caption:place"),
    onMoving: latest("caption:moving"),
    settled: (on) => ipcRenderer.send("caption:settled", !!on),
    testShow: (threadId) => ipcRenderer.send("caption:test-show", String(threadId)),
  },
  // The highlight an agent points with when it teaches (electron/pointer.mjs): what to draw, and
  // "drawn" once it is (the window is shown only then).
  pointer: {
    onShow: listen("pointer:show"),
    onHide: listen("pointer:hide"),
    drawn: (gen) => ipcRenderer.send("pointer:drawn", Number(gen)),
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
// A page that loads while an agent's step is under way starts guarded. Only on Wayland, as main.mjs
// decides it (main answers there before any window exists; a page with no answer would hang).
const onWayland = process.platform === "linux" && (process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY);
if (onWayland) guard(ipcRenderer.sendSync("guard:state") === true);
// Its scale, now and whenever it changes (another screen): main can't tell on Wayland (click-through.mjs).
if (onWayland) {
  const tellScale = () => {
    ipcRenderer.send("page:scale", window.devicePixelRatio);
    window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener("change", tellScale, { once: true });
  };
  tellScale();
}
