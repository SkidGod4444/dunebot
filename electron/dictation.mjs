// Dictation (macOS): hold Right ⌥ on its own and talk; let go, and the core types what you said into
// the app in front. core/src/dictation.rs decides everything (the keys, what's typed, the sentence when
// it can't); here the microphone opens as for a hold to talk, with the "Listening…" card, and the menu
// bar has its switch. What was said never passes through here, and the log keeps only its length.

/**
 * @param {object} h
 * @param {(method: string, params?: object) => Promise<any>} h.call
 * @param {(...a: any[]) => void} h.log
 * @param {(m: object) => void} h.emit an event as if from the core (windows and the tray see it)
 * @param {() => string} h.micStatus
 * @param {(step?: string) => void} h.openSetup
 * @param {(source: string) => Promise<any>} h.startVoice
 * @param {() => void} h.showListening "Listening…" beside the pointer (a card waiting there stays)
 * @param {() => void} h.hideListening hides the card if it shows only listening
 * @param {(key: string, value: string) => Promise<void>} h.savePref saves, then tells the windows
 * @param {() => void} h.refreshTray
 * @param {{ ipcMain: Electron.IpcMain, from: (sender: Electron.WebContents) => boolean }} [h.test]
 *   hidden-window checks only: a page may hand over words as if just said (no microphone)
 */
export function createDictation(h) {
  let hold = null; // the hold in progress: its start, so a release or cancel waits for the mic to open
  let typing = false;
  let watching = false; // the core watches Right ⌥ (the macOS app)
  let on = true;
  let keys = "Right ⌥";

  function onKeys(kind) {
    h.log(`dictation ${kind}`);
    if (kind === "hold-start") {
      if (h.micStatus() !== "granted") {
        hold = null;
        return h.openSetup("mic");
      }
      h.showListening();
      const started = h.startVoice("dictation").catch((e) => {
        h.emit({ event: "voice.state", state: "error", message: e.message });
        throw e;
      });
      started.catch(() => {});
      hold = { started };
      return;
    }
    const was = hold;
    hold = null;
    if (!was) return;
    if (kind === "hold-end") was.started.then(() => h.call("dictation.stop")).catch(() => {});
    if (kind === "hold-cancel") {
      // Right ⌥ was part of a shortcut or a special character: nothing is typed. (While the words of a
      // recording that stopped itself at 60 s are being typed, the card stays.)
      was.started.then(() => h.call("dictation.cancel")).catch(() => {});
      if (!typing) h.hideListening();
    }
  }

  function onEvent(m) {
    switch (m.event) {
      case "dictation":
        return onKeys(m.kind);
      case "dictation.ready":
        watching = !!m.available;
        on = !!m.on;
        keys = m.keys || keys;
        h.log(`dictation ${watching ? (on ? `on (hold ${keys} alone)` : "off") : "unavailable"}`);
        return h.refreshTray();
      case "dictation.state":
        typing = m.state === "typing";
        // Lengths and Dune Bot's own sentences only, never the words.
        h.log(`dictation ${m.state}${m.chars ? `, ${m.chars} characters` : ""}${m.message ? `: ${m.message}` : ""}`);
        return;
    }
  }

  /** The menu bar: what holding the key does, under Talk (when it's on). */
  const hint = () => (watching && on ? [{ label: `Dictate                  hold ${keys}`, enabled: false }] : []);
  /** The menu bar's Keys: the switch. */
  const menu = () =>
    watching
      ? [{ type: "separator" }, { label: `Hold ${keys} to type what you say`, type: "checkbox", checked: on, click: () => h.savePref("dictation", on ? "off" : "on") }]
      : [];

  if (h.test)
    h.test.ipcMain.on("test:dictate", (e, text) => {
      if (!h.test.from(e.sender)) return;
      h.call("dictation.feed", { text: String(text).slice(0, 500) }).catch((err) => h.log(`dictation feed: ${err.message}`));
    });

  return { onEvent, hint, menu };
}
