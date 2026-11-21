// Dictation: hold Right ⌥ (macOS) or Right Ctrl (Windows, Linux on X11) on its own and talk; let go,
// and the core types what you said into the app in front. A keyboard without that key picks "Ctrl
// twice" instead (tap Ctrl, then hold it), in the menu bar's Keys or Settings › Keys. Wayland lets apps see no held keys: there a
// shortcut of the desktop's (GNOME's, gnome-keys.mjs) is pressed once to start and again to type. core/src/dictation.rs decides everything (the keys, what's typed, the sentence when
// it can't); here the microphone opens as for a hold to talk, with the "Listening…" card, and the menu
// bar has its switch. What was said never passes through here, and the log keeps only its length.

/**
 * @param {object} h
 * @param {(method: string, params?: object) => Promise<any>} h.call
 * @param {(...a: any[]) => void} h.log
 * @param {(m: object) => void} h.emit an event as if from the core (windows and the tray see it)
 * @param {() => boolean} h.micBlocked the system says no to the microphone
 * @param {(step?: string) => void} h.openSetup
 * @param {(source: string) => Promise<any>} h.startVoice
 * @param {() => void} h.showListening "Listening…" beside the pointer (a card waiting there stays)
 * @param {() => void} h.hideListening hides the card if it shows only listening
 * @param {(key: string, value: string) => Promise<void>} h.savePref saves, then tells the windows
 * @param {() => void} h.refreshTray
 * @param {() => Promise<any>} [h.readyToType] Wayland: opens the typing session (the desktop may ask)
 * @param {{ ipcMain: Electron.IpcMain, from: (sender: Electron.WebContents) => boolean }} [h.test]
 *   hidden-window checks only: a page may hand over words as if just said (no microphone)
 */
export function createDictation(h) {
  let hold = null; // the hold in progress: its start, so a release or cancel waits for the mic to open
  let typing = false;
  let watching = false; // the core reads the keyboard (the desktop app; not on Wayland)
  let usable = false; // and the chosen key is on it (Linux: a keyboard may have no Right Ctrl)
  let on = true;
  let keys = "Right ⌥";
  let holdHow = null; // what's done with the key: "hold Right ⌥", "tap ⌃, then hold it"
  let chosen = null; // the key picked (pref dictation.key), and what can be picked
  let choices = [];
  let pressKey = null; // Wayland: the shortcut pressed to start and again to type
  let lastPress = 0;

  /** `after`: ms to wait before the recording ends (a pressed shortcut's keys being let go). */
  function onKeys(kind, { after = 0 } = {}) {
    h.log(`dictation ${kind}`);
    if (kind === "hold-start") {
      if (h.micBlocked()) {
        hold = null;
        return h.openSetup("mic");
      }
      h.showListening();
      const started = h.startVoice("dictation").catch((e) => {
        h.emit({ event: "voice.state", state: "error", message: e.message });
        throw e;
      });
      started.catch(() => {
        if (hold?.started === started) hold = null; // the microphone didn't open: nothing to end
      });
      hold = { started };
      return;
    }
    const was = hold;
    hold = null;
    if (!was) return;
    if (kind === "hold-end")
      was.started
        .then(() => new Promise((r) => setTimeout(r, after)))
        .then(() => h.call("dictation.stop"))
        .catch(() => {});
    if (kind === "hold-cancel") {
      // The key was part of a shortcut or a special character: nothing is typed. (While the words of a
      // recording that stopped itself at 60 s are being typed, the card stays.)
      was.started.then(() => h.call("dictation.cancel")).catch(() => {});
      if (!typing) h.hideListening();
    }
  }

  /**
   * Wayland: the shortcut was pressed (GNOME runs Dune Bot with --dictate). Once starts listening;
   * again types what was said. A press within half a second of the last is the same one (a double
   * tap); one while the words are being typed is ignored.
   */
  function press() {
    const now = Date.now();
    if (now - lastPress < 500) return void h.log("dictation: pressed again too soon, ignored");
    lastPress = now;
    if (!on) return void h.log("dictation is off: press ignored");
    if (typing) return void h.log("dictation: still typing, press ignored");
    if (!hold) {
      onKeys("hold-start");
      // The typing session is opened now, while the user talks, not after: if the desktop has to ask
      // (its box takes the keyboard), this dictation is called off and the box comes first.
      const started = hold?.started;
      if (started && h.readyToType)
        h.readyToType().catch((e) => {
          if (hold?.started !== started) return;
          h.log(`dictation: can't type yet (${e.message.slice(0, 160)})`);
          onKeys("hold-cancel");
          // The app's own sentence when it has one; otherwise the desktop is asking first (its box).
          const message = /^Nothing typed/.test(e.message) ? e.message : `Nothing typed: answer the desktop's box first, then press ${pressKey} again.`;
          h.emit({ event: "dictation.state", state: "nothing", message });
        });
      return;
    }
    // Again: what was said is typed once the shortcut's keys are let go (a character typed while
    // Super or Alt is down would be a shortcut). The recording runs on a moment meanwhile.
    onKeys("hold-end", { after: 350 });
  }

  /** The stop key: a dictation listening for a second press is called off (nothing typed). */
  function stop() {
    if (hold) onKeys("hold-cancel");
  }

  /** Wayland: the shortcut that dictates (null: none, or not Wayland). The core says it in its notes. */
  function setPressKey(k) {
    pressKey = k || null;
    h.call("dictation.pressed", { keys: pressKey }).catch(() => {});
    h.log(`dictation: ${pressKey ? `press ${pressKey} to start, again to type` : "no shortcut"}`);
    h.refreshTray();
  }

  /** What the user does, for the menu bar. */
  const how = () => (pressKey && !watching ? `press ${pressKey}` : holdHow || `hold ${keys}`);
  const available = () => usable || !!pressKey;

  function onEvent(m) {
    switch (m.event) {
      case "dictation":
        return onKeys(m.kind);
      case "dictation.ready":
        usable = !!m.available;
        watching = m.watching ?? usable;
        on = !!m.on;
        keys = m.keys || keys;
        holdHow = m.how || null;
        chosen = m.key || null;
        choices = Array.isArray(m.choices) ? m.choices : [];
        h.log(`dictation ${available() ? (on ? `on (${how()})` : "off") : watching ? `unavailable: no ${keys} on this keyboard` : "unavailable"}`);
        return h.refreshTray();
      case "dictation.state":
        hold = null; // the recording is over (its words, or why none), even one that stopped itself at 60 s
        typing = m.state === "typing";
        // Lengths and Dune Bot's own sentences only, never the words.
        h.log(`dictation ${m.state}${m.chars ? `, ${m.chars} characters` : ""}${m.message ? `: ${m.message}` : ""}`);
        return;
    }
  }

  /** The menu bar: what the key does, under Talk (when it's on). */
  const hint = () => (available() && on ? [{ label: `Dictate                  ${how()}`, enabled: false }] : []);
  /** The menu bar's Keys: the switch, and which key (when the keyboard is read: not on Wayland). */
  const menu = () => {
    if (!available() && !watching) return [];
    const items = [{ type: "separator" }];
    if (available()) items.push({ label: `${how()[0].toUpperCase()}${how().slice(1)} to type what you say`, type: "checkbox", checked: on, click: () => h.savePref("dictation", on ? "off" : "on") });
    else items.push({ label: `Dictation: this keyboard has no ${keys}`, enabled: false });
    if (watching && choices.length > 1)
      items.push({
        label: "Dictation key",
        submenu: choices.map((c) => ({ label: c.label, type: "radio", checked: c.name === chosen, click: () => h.savePref("dictation.key", c.name) })),
      });
    return items;
  };

  if (h.test)
    h.test.ipcMain.on("test:dictate", (e, text) => {
      if (!h.test.from(e.sender)) return;
      h.call("dictation.feed", { text: String(text).slice(0, 500) }).catch((err) => h.log(`dictation feed: ${err.message}`));
    });

  return { onEvent, hint, menu, press, stop, setPressKey };
}
