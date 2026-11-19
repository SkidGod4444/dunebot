import { useEffect, useState } from "react";
import { call, set, useStore } from "./store";

/**
 * Dictation (core/src/dictation.rs): hold Right ⌥ on its own and talk; let go, and what you said is
 * typed where your text cursor is, in any app. Never sent to an agent, never read aloud. macOS only for
 * now: on Windows and Linux the row says why.
 */

/** For the card beside the pointer: whether what you said is being typed now. `onNote` gets the one
 * sentence the core sends when nothing was typed (nothing heard, or the typing was refused). */
export function useDictation(onNote: (sentence: string) => void): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(
    () =>
      window.dunebot.onEvent((m) => {
        if (m.event === "dictation.state") {
          setTyping(m.state === "typing");
          if (m.message) onNote(String(m.message));
        } else if ((m.event === "voice.state" && m.state === "listening") || m.event === "core.exit") setTyping(false);
      }),
    [],
  );
  return typing;
}

/** Settings › Keys: the switch (on unless turned off), or why there's none on this system. */
export function DictationSetting() {
  const on = useStore((s) => s.prefs.dictation) !== "off";
  const platform = window.dunebot.platform;
  const mac = platform === "darwin";
  const pick = async (value: "on" | "off") => {
    const r = await call<{ prefs: Record<string, string | null> }>("prefs.set", { key: "dictation", value });
    set({ prefs: r.prefs });
  };
  return (
    <div className={`rounded-2xl border border-line px-4 py-3.5 ${mac ? "mt-2.5" : ""}`}>
      <div className="flex items-center gap-4">
        <span className="flex-1 text-[15px] font-medium">{mac ? "Hold Right ⌥ to type what you say" : "Hold Right Alt to type what you say"}</span>
        {mac && (
          <div className="flex rounded-full bg-black/[.05] p-0.5">
            {(["on", "off"] as const).map((k) => (
              <button
                key={k}
                onClick={() => pick(k)}
                className={`h-8 rounded-full px-3.5 text-[13px] font-semibold ${(k === "on") === on ? "bg-white text-ink shadow-[0_1px_2px_rgba(0,0,0,.1)]" : "text-[#777] hover:text-ink"}`}
              >
                {k === "on" ? "On" : "Off"}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="mt-1.5 text-[13px] text-muted">
        {mac
          ? "Hold Right ⌥ on its own and talk; let go, and what you said is typed where your text cursor is, in any app. It isn't sent to an agent or read aloud. Another key or a click while you hold it cancels, so ⌥ shortcuts and special characters still work. Typing asks for Accessibility the first time."
          : platform === "win32"
            ? "Not on Windows yet: letting go of Alt opens the menu bar in many apps, and Right Alt types characters on many layouts."
            : "Not on Linux yet. On Wayland it can't work: Wayland doesn't let apps see which keys are held."}
      </p>
    </div>
  );
}
