import { useRef, type KeyboardEvent } from "react";

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
            className={`${small ? "h-7 px-3 text-[12.5px]" : "h-8 px-3.5 text-[13px]"} rounded-full font-semibold ${on ? "bg-white text-ink shadow-[0_1px_2px_rgba(0,0,0,.1)]" : "text-[#777] hover:text-ink"}`}
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
