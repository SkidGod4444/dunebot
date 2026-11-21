import { useRef, type KeyboardEvent, type ReactNode } from "react";

/**
 * The pill of choices (Theme, Keys, each permission, an account's changes, a phone switch): one is
 * picked. To a screen reader it's a radio group with a name, and each choice says whether it's
 * picked. Tab reaches the picked one; the arrow keys move between choices and Space or Enter picks
 * (arrows alone never save: on Permissions, going from Always to Ask me never passes through a
 * choice on the way). `value` null (still loading): nothing is picked.
 */
export function Segmented<T extends string | boolean>({
  label,
  value,
  options,
  onChange,
  small,
  disabled,
  className = "",
}: {
  label: string;
  value: T | null | undefined;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  small?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  const at = options.findIndex(([v]) => v === value);
  function move(e: KeyboardEvent) {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step || disabled) return;
    e.preventDefault();
    const radios = [...(group.current?.querySelectorAll<HTMLButtonElement>("[role=radio]") ?? [])];
    const from = radios.indexOf(document.activeElement as HTMLButtonElement);
    radios[((from < 0 ? Math.max(at, 0) : from) + step + radios.length) % radios.length]?.focus();
  }
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={move}
      data-segmented
      className={`flex rounded-full bg-black/[.05] p-0.5 ${className}`}
    >
      {options.map(([v, text], i) => {
        const on = v === value;
        return (
          <button
            key={String(v)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (at < 0 && i === 0) ? 0 : -1}
            disabled={disabled}
            // A press on the picked one saves it too (as before): what's shown picked may be only the
            // default (Theme with nothing saved), and saving it makes it so.
            onClick={() => onChange(v)}
            className={`${small ? "h-7 px-3 text-[12.5px]" : "h-8 px-3.5 text-[13px]"} rounded-full font-semibold ${on ? "bg-white text-ink shadow-[0_1px_2px_rgba(0,0,0,.1)]" : "text-muted hover:text-ink"}`}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}

/** What locks a saved key on this system (Electron safeStorage): the Mac's keychain, the Windows
 * account (DPAPI), the Linux desktop's keyring. "locked by …" / "no … to lock a key with". */
export const lockedBy = () =>
  window.dunebot.platform === "darwin" ? "your keychain" : window.dunebot.platform === "win32" ? "your Windows account" : "your keyring";
export const lockNoun = () => (window.dunebot.platform === "darwin" ? "keychain" : "keyring");

/** A page of the chats window (Permissions, Settings, Schedules, Fixes, Activity): the strip you drag
 * the window by, then the page scrolling under it, its title in the pixel font and one line on what
 * it's for. `wide`: 760 for lists, else 640. */
export function PageShell({ title, intro, wide, children }: { title: string; intro: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <>
      <div className="drag h-[56px] shrink-0" />
      <div className="flex-1 overflow-y-auto">
        <div className={`mx-auto ${wide ? "max-w-[760px]" : "max-w-[640px]"} px-6 pb-12`}>
          <h1 className="font-pixel text-[32px] leading-tight">{title}</h1>
          <p className="mt-1 text-[15px] text-muted">{intro}</p>
          {children}
        </div>
      </div>
    </>
  );
}

/** An on/off switch (a schedule, a fix). `label` says what it switches; `title` what on and off mean. */
export function Switch({ on, label, title, onClick }: { on: boolean; label: string; title: string; onClick: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={title}
      onClick={onClick}
      className={`mt-0.5 flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors ${on ? "bg-ink" : "bg-black/15"}`}
    >
      <span className={`size-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : ""}`} />
    </button>
  );
}

/** Live microphone level as five bars (the bar and the answer beside the pointer). */
export function Level({ level }: { level: number }) {
  return (
    <span className="inline-flex h-5 items-center gap-[3px]" aria-hidden>
      {[0.55, 0.85, 1, 0.8, 0.5].map((w, i) => (
        <span key={i} className="w-[3px] rounded-full bg-brand transition-[height] duration-75" style={{ height: `${Math.max(4, Math.round(20 * Math.min(1, level * 1.6) * w))}px` }} />
      ))}
    </span>
  );
}

/** Enter (without Shift) sends or saves a box. Not while an input method is composing: there Enter
 * picks a word (Japanese, Chinese…). The bar has its own, stricter rule (⌘/Ctrl+Enter too). */
export const isSendKey = (e: KeyboardEvent) => e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing;
