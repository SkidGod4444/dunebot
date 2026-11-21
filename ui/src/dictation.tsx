import { useEffect, useState } from "react";
import { call, set, useStore } from "./store";

/**
 * Dictation (core/src/dictation.rs): hold Right ⌥ (macOS) or Right Ctrl (Windows, Linux on X11) on its
 * own and talk; let go, and what you said is typed where your text cursor is, in any app. Never sent
 * to an agent, never read aloud. A keyboard without that key picks "Ctrl twice": tap Ctrl, then hold
 * it (pref dictation.key). Wayland shows no held keys to apps: there it's a GNOME shortcut, pressed
 * to start and again to type (added in setup).
 */

/** The keys to pick (core/src/dictation.rs CHOICES; the first is the default). */
export function dictationKeys(mac: boolean) {
  return mac
    ? [
        { name: "right-opt", label: "Right ⌥", how: "Hold Right ⌥" },
        { name: "ctrl-twice", label: "⌃ twice", how: "Tap ⌃, then hold it" },
      ]
    : [
        { name: "right-ctrl", label: "Right Ctrl", how: "Hold Right Ctrl" },
        { name: "ctrl-twice", label: "Ctrl twice", how: "Tap Ctrl, then hold it" },
      ];
}

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
  const picked = useStore((s) => s.prefs["dictation.key"]);
  const platform = window.dunebot.platform;
  const mac = platform === "darwin";
  const wayland = platform === "linux" && !!window.dunebot.wayland;
  const choices = dictationKeys(mac);
  const chosen = choices.find((c) => c.name === picked) ?? choices[0];
  const twice = chosen.name === "ctrl-twice";
  const ctrl = mac ? "⌃" : "Ctrl";
  // macOS: Apple's own Dictation on, whose shortcut may be Control twice too (looked at again on each pick).
  const [apple, setApple] = useState(false);
  useEffect(() => {
    if (!mac || !twice) return setApple(false);
    let live = true;
    window.dunebot.appleDictation?.().then((yes) => live && setApple(yes)).catch(() => {});
    return () => {
      live = false;
    };
  }, [mac, twice]);
  const save = async (key: string, value: string) => {
    const r = await call<{ prefs: Record<string, string | null> }>("prefs.set", { key, value });
    set({ prefs: r.prefs });
  };
  const pick = (value: "on" | "off") => save("dictation", value);
  return (
    <div className={`rounded-2xl border border-line px-4 py-3.5 ${mac ? "mt-2.5" : ""}`}>
      <div className="flex items-center gap-4">
        <span className="flex-1 text-[15px] font-medium">{wayland ? "Press a key to type what you say" : `${chosen.how} to type what you say`}</span>
        {
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
        }
      </div>
      <p className="mt-1.5 text-[13px] text-muted">
        {wayland
          ? "Wayland doesn't let apps see which keys are held, so dictation uses a shortcut of GNOME's: press it and talk, press it again, and what you said is typed where your text cursor is, in English. Add it in Set up Dune Bot › Dictation key (GNOME; not yet on other Wayland desktops)."
          : `${twice ? `Tap ${ctrl} once, then press it again and hold it` : `Hold ${chosen.label} on its own`} and talk; let go, and what you said is typed where your text cursor is, in any app, in English (speak Hindi and it types the English). It isn't sent to an agent or read aloud. Another key or a click while you hold it cancels, so ${twice ? `${ctrl} shortcuts` : mac ? "⌥ shortcuts and special characters" : "Ctrl shortcuts"} still work.${mac ? " Typing asks for Accessibility the first time." : platform === "win32" ? " It never types into an app run as administrator." : ""}`}
      </p>
      {!wayland && (
        <div className="mt-3 flex items-center gap-4 border-t border-line pt-3">
          <span className="flex-1 text-[14px] font-medium">
            Dictation key
            <span className="block text-[13px] font-normal text-muted">
              {`No ${choices[0].label} on your keyboard? Pick ${choices[1].label}: tap ${ctrl}, then hold it. Every keyboard has a ${ctrl}, and a ${ctrl} held without the tap does nothing.`}
            </span>
          </span>
          <div className="flex shrink-0 rounded-full bg-black/[.05] p-0.5">
            {choices.map((c) => (
              <button
                key={c.name}
                onClick={() => save("dictation.key", c.name)}
                className={`h-8 rounded-full px-3.5 text-[13px] font-semibold ${c.name === chosen.name ? "bg-white text-ink shadow-[0_1px_2px_rgba(0,0,0,.1)]" : "text-[#777] hover:text-ink"}`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {apple && (
        <p data-apple-dictation className="mt-3 rounded-xl border border-line px-3 py-2.5 text-[13px]">
          Apple's Dictation is also turned on. If its shortcut is Control twice (System Settings › Keyboard › Dictation › Shortcut), ⌃ twice
          starts both: pick another shortcut there, or Right ⌥ here.
        </p>
      )}
    </div>
  );
}
