// Starting the microphone (main.mjs): at once, never after the voice keys. Unlocking a key can make
// macOS ask about the keychain (a new build asks again), as long as the person takes: waiting for it
// first lost a first dictation (nothing recorded until Right ⌥ was let go), and waiting for it before
// stopping recorded 16 s for a 1.5 s hold (2026-11-21). So the keys are unlocked in the background,
// the mic starts and stops when asked, and the core holds back turning the recording into text until
// the keys are in (voice.keysComing, main.mjs). Checked by scripts/check_voice_start.mjs.

/**
 * @param {{
 *   hush: () => void,
 *   micBlocked: () => boolean,
 *   openSetup: () => void,
 *   call: (method: string, params?: any) => Promise<any>,
 *   keysReady: () => Promise<any>,
 * }} h
 */
export function createVoiceStart(h) {
  return {
    /** Starts recording for `source` ("dictation", "chord", "button"). */
    async start(source) {
      h.hush(); // the mic mustn't hear Dune Bot
      if (h.micBlocked()) {
        h.openSetup();
        throw new Error("Allow the microphone first. Dune Bot's setup is open.");
      }
      h.keysReady(); // in the background (it never fails); asked first, so the core knows they're coming
      return h.call("voice.start", { source });
    },
  };
}
