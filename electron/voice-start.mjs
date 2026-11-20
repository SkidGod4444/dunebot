// Starting and stopping the microphone (main.mjs): the mic first, then the voice keys. Unlocking a key
// can make macOS ask about the keychain (a new build asks again), and that holds the app until it's
// answered: done the other way round, a first dictation recorded nothing until Right ⌥ was let go
// (9 s lost, 2026-11-21). The keys are in before a start resolves, and every stop waits for them
// (the held keys' stops wait for the start; the mic button's stop waits here), so what you said is
// turned into text with them. Waiting for them never fails: a key that won't unlock is done without.
// Checked by scripts/check_voice_start.mjs.

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
      const started = await h.call("voice.start", { source });
      await h.keysReady();
      return started;
    },
    /** The mic button's stop. */
    stop() {
      return h.keysReady().then(() => h.call("voice.stop", {}));
    },
  };
}
