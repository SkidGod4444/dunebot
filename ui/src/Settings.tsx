import { useEffect, useState } from "react";
import { KEYS, errorText, keysLabel, savePref, useStore } from "./store";
import { lockedBy, lockNoun, Segmented } from "./ui";
import { DictationSetting } from "./dictation";

const THEMES = [
  ["dark", "Dark"],
  ["light", "Light"],
  ["system", "Match the system"],
] as const;

/** Dune Bot's colours in every window: dark unless you pick Light or Match the system. */
function ThemeSettings() {
  const saved = useStore((s) => s.prefs["look.theme"]);
  const now = THEMES.some(([k]) => k === saved) ? saved : "dark";
  const pick = (value: string) => savePref("look.theme", value);
  return (
    <div className="rounded-2xl border border-line px-4 py-3.5">
      <div className="flex items-center gap-4">
        <span className="flex-1 text-[15px] font-medium">Theme</span>
        <Segmented label="Theme" value={now} options={THEMES} onChange={pick} />
      </div>
      <p className="mt-1.5 text-[13px] text-muted">
        The bar, the answer card, setup and this window. Match the system switches with your computer's light and dark. Also in the {window.dunebot.platform === "darwin" ? "menu bar" : "tray menu"}: Theme.
      </p>
    </div>
  );
}

/** Settings: Dune Bot's own choices (the look, keys, voice). Everything about what may be done (agents,
 *  connected accounts, the phone, bots) stays on Permissions, in one place. */
export function SettingsPage() {
  return (
    <>
      <div className="drag h-[56px] shrink-0" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[640px] px-6 pb-12">
          <h1 className="font-pixel text-[32px] leading-tight">Settings</h1>
          <p className="mt-1 text-[15px] text-muted">How Dune Bot looks, its keys, and how it listens and talks. What agents, bots, your accounts and your phone may do is in Permissions.</p>
          <h2 className="mt-6 mb-2.5 text-[12px] font-semibold tracking-[.08em] text-muted uppercase">Look</h2>
          <ThemeSettings />
          <h2 className="mt-8 mb-2.5 text-[12px] font-semibold tracking-[.08em] text-muted uppercase">Keys</h2>
          {window.dunebot.platform === "darwin" && <KeySettings />}
          <DictationSetting />
          <h2 className="mt-8 mb-2.5 text-[12px] font-semibold tracking-[.08em] text-muted uppercase">Voice</h2>
          <VoiceSettings />
        </div>
      </div>
    </>
  );
}

/** The keys that tap (open the bar) and hold (talk) on macOS. */
function KeySettings() {
  const prefs = useStore((s) => s.prefs);
  const now = keysLabel(prefs);
  const pick = (value: string) => savePref("keys.chord", value);
  return (
    <div className="rounded-2xl border border-line px-4 py-3.5">
      <div className="flex items-center gap-4">
        <span className="flex-1 text-[15px] font-medium">Tap to ask, hold to talk</span>
        <Segmented label="Keys to ask and talk" value={KEYS.find(([, l]) => l === now)?.[0]} options={KEYS} onChange={pick} />
      </div>
      <p className="mt-1.5 text-[13px] text-muted">
        If another app uses the same keys, pick others here (also in the menu bar: Keys). Pressing any other key while you hold them lets the shortcut through.
      </p>
    </div>
  );
}

type KeyApi = { status: () => Promise<SarvamStatus>; save: (key: string) => Promise<SarvamStatus>; remove: () => Promise<SarvamStatus> };

/** Who listens and reads aloud: Sarvam AI and Deepgram (the user's own keys) or this computer. */
function VoiceSettings() {
  const engine = useStore((s) => s.prefs["voice.engine"]) === "local" ? "local" : "sarvam";
  const [st, setSt] = useState<SarvamStatus | null>(null);
  const [dg, setDg] = useState<SarvamStatus | null>(null);
  const pick = (value: "sarvam" | "local") => savePref("voice.engine", value);
  const sarvam = engine === "sarvam" && !!st?.saved;
  const american = engine === "sarvam" && !!dg?.saved;
  return (
    <div className="divide-y divide-line rounded-2xl border border-line">
      <div className="px-4 py-3.5">
        <div className="flex items-center gap-4">
          <span className="flex-1 text-[15px] font-medium">Listening and reading aloud</span>
          <Segmented
            label="Listening and reading aloud"
            value={engine}
            options={[
              ["sarvam", "Sarvam AI"],
              ["local", "This computer"],
            ] as const}
            onChange={pick}
          />
        </div>
        <p className="mt-1.5 text-[13px] text-muted">
          {sarvam
            ? `What you say goes to Sarvam AI to become text (English, Hindi and other Indian languages, mixed too). ${
                american
                  ? "English answers go to Deepgram to be read aloud in an American voice; answers in Hindi and other Indian languages go to Sarvam."
                  : "Answers go to Sarvam to be read aloud (English with an Indian accent; save a Deepgram key below for an American voice)."
              } Silence never goes, and Dune Bot keeps no recording. If none of them answers, this computer listens and reads instead.`
            : engine === "sarvam"
              ? `Save a Sarvam key below to use it. Until then, this computer listens (English)${american ? ", and English answers are read by Deepgram." : " and reads aloud."}`
              : "Listening (English) and reading aloud stay on this computer. Nothing is sent."}
        </p>
      </div>
      <KeyRow title="Sarvam key" api={window.dunebot.sarvam} placeholder="Paste your key from dashboard.sarvam.ai" onStatus={setSt} />
      <KeyRow title="Deepgram key" hint="American voice for English" api={window.dunebot.deepgram} placeholder="Paste your key from console.deepgram.com" onStatus={setDg} />
    </div>
  );
}

/** One service's key: saved (locked by the keychain) with Remove, or a box to paste it into. */
function KeyRow({ title, hint, api, placeholder, onStatus }: { title: string; hint?: string; api: KeyApi; placeholder: string; onStatus: (s: SarvamStatus) => void }) {
  const [st, setSt] = useState<SarvamStatus | null>(null);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  const show = (s: SarvamStatus) => {
    setSt(s);
    onStatus(s);
  };
  const check = () => api.status().then(show, (e) => setProblem(`Couldn't check this key: ${errorText(e)}`));
  useEffect(() => {
    check();
  }, []);
  const run = async (f: () => Promise<SarvamStatus>) => {
    setSaving(true);
    setProblem("");
    try {
      show(await f());
      setKey("");
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center gap-4">
        <span className="min-w-0 flex-1 text-[15px] font-medium">
          {title}
          {hint && <span className="ml-2 text-[13px] font-normal text-muted">{hint}</span>}
        </span>
        {st?.saved && (
          <>
            <span className="text-[13px] text-ink">Saved, locked by {lockedBy()}</span>
            <button onClick={() => run(api.remove)} disabled={saving} className="h-8 rounded-full px-3 text-[13px] font-semibold text-ink hover:bg-black/[.05]">
              Remove
            </button>
          </>
        )}
      </div>
      {st && !st.saved && st.canSave && (
        <form
          className="mt-2.5 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) run(() => api.save(key));
          }}
        >
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label={title}
            placeholder={placeholder}
            className="h-9 min-w-0 flex-1 rounded-full border border-line bg-transparent px-3.5 text-[14px] outline-none placeholder:text-muted"
          />
          <button disabled={!key.trim() || saving} className="h-9 rounded-full bg-ink px-4 text-[13.5px] font-semibold text-white hover:bg-black disabled:bg-muted/40">
            Save
          </button>
        </form>
      )}
      {st && !st.saved && !st.canSave && (
        <p className="mt-1.5 text-[13px] text-ink">This computer has no {lockNoun()} to lock a key with, so Dune Bot won't keep one.</p>
      )}
      {problem && (
        <p role="alert" className="mt-1.5 text-[13px] font-medium text-ink">
          {problem}
          {!st && (
            <button onClick={check} className="ml-2 font-semibold underline underline-offset-2">
              Try again
            </button>
          )}
        </p>
      )}
    </div>
  );
}
