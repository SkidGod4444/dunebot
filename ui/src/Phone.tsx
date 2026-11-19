import { useEffect, useState } from "react";
import { call } from "./store";

/** What the core says about the phone (core/src/telegram.rs). Never the token. */
export type PhoneStatus = {
  token: boolean;
  bot: string | null;
  code: string | null;
  paired: { name: string } | null;
  reads: boolean;
  actions: boolean;
  problem: string | null;
};

const SWITCH = [
  [false, "Off"],
  [true, "On"],
] as const;

/** Settings › Phone: the user's Telegram bot, the pairing code or the paired chat, and two switches. */
export function PhoneSettings() {
  const [ph, setPh] = useState<PhoneStatus | null>(null);
  const [key, setKey] = useState<SarvamStatus | null>(null);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    call<PhoneStatus>("phone.status").then(setPh, () => {});
    window.dunebot.telegram.status().then(setKey, () => {});
    const off = window.dunebot.onEvent((m) => {
      if (m.event === "phone.updated") setPh(m as PhoneStatus);
    });
    // For snapshot scripts (window.__dm.phone): draw a given state. It changes only what's drawn.
    const dm = (window as any).__dm;
    if (dm) dm.phone = (s: { phone?: PhoneStatus; key?: SarvamStatus }) => (s.phone && setPh(s.phone), s.key && setKey(s.key));
    return off;
  }, []);
  const run = async <T,>(f: () => Promise<T>, then: (v: T) => void) => {
    setProblem("");
    try {
      then(await f());
    } catch (e) {
      setProblem((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };
  const flip = (k: "reads" | "actions", on: boolean) => run(() => call<PhoneStatus>("phone.set", { key: k, on }), setPh);
  return (
    <div className="divide-y divide-line rounded-2xl border border-line">
      <TokenRow st={key} phone={ph} onKey={setKey} />
      {key?.saved && ph?.token && (
        <div className="px-4 py-3.5">
          {ph.paired ? (
            <>
              <div className="flex items-center gap-4">
                <span className="min-w-0 flex-1 truncate text-[15px] font-medium">Paired with {ph.paired.name}</span>
                <button onClick={() => run(() => call<PhoneStatus>("phone.unpair"), setPh)} className="h-8 rounded-full px-3 text-[13px] font-semibold text-ink hover:bg-black/[.05]">
                  Unpair
                </button>
              </div>
              <p className="mt-1.5 text-[13px] text-muted">
                What you send {ph.bot ?? "your bot"} goes to a chat called Phone here, and the answer goes back. Every other Telegram chat is ignored.
              </p>
            </>
          ) : ph.code ? (
            <>
              <span className="text-[15px] font-medium">Pair your phone</span>
              <p className="mt-1.5 text-[13px] text-muted">From your own Telegram, send this to {ph.bot ?? "your bot"}. Only the chat that sends it is paired.</p>
              <p className="mt-2.5 inline-block rounded-xl bg-side px-3.5 py-2 font-mono text-[17px] tracking-[.06em] text-ink select-text">/pair {ph.code}</p>
            </>
          ) : null}
        </div>
      )}
      <SwitchRow
        title="Read my accounts from my phone"
        on={!!ph?.reads}
        onPick={(v) => flip("reads", v)}
        hint="Slack, Gmail, Notion, Calendar and X, once you've named one in the Phone chat (named once, it counts for the rest of that chat). Off: messages from your phone never read them."
      />
      <SwitchRow
        title="Let my phone run actions"
        on={!!ph?.actions}
        onPick={(v) => flip("actions", v)}
        hint={
          ph?.actions
            ? "From your phone, Dune Bot may look at the screen, click, type, run commands and change files, and each one asks first, every time. Answer Yes or No on your phone or here."
            : "Off: from your phone, Dune Bot never looks at the screen, clicks, types, runs commands or changes files. It can still answer, read files and look inside folders, as Permissions allow."
        }
      />
      {problem && <p className="px-4 py-2.5 text-[13px] font-medium text-ink">{problem}</p>}
    </div>
  );
}

/** The bot's token: saved (locked by the keychain) with Remove, or a box to paste it into. */
function TokenRow({ st, phone, onKey }: { st: SarvamStatus | null; phone: PhoneStatus | null; onKey: (s: SarvamStatus) => void }) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  const api = window.dunebot.telegram;
  const run = async (f: () => Promise<SarvamStatus>) => {
    setSaving(true);
    setProblem("");
    try {
      onKey(await f());
      setToken("");
    } catch (e) {
      setProblem((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    } finally {
      setSaving(false);
    }
  };
  const line = !st?.saved
    ? ""
    : !phone?.token
      ? "Saved, but not unlocked yet. If this stays, remove it and paste it again."
      : (phone.problem ?? (phone.bot ? `Your bot: ${phone.bot}` : "Connecting to Telegram…"));
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center gap-4">
        <span className="min-w-0 flex-1 text-[15px] font-medium">
          Telegram bot
          <span className="ml-2 text-[13px] font-normal text-muted">Dune Bot from your phone</span>
        </span>
        {st?.saved && (
          <>
            <span className="text-[13px] text-ink">Saved, locked by your keychain</span>
            <button onClick={() => run(api.remove)} disabled={saving} className="h-8 rounded-full px-3 text-[13px] font-semibold text-ink hover:bg-black/[.05]">
              Remove
            </button>
          </>
        )}
      </div>
      {line && <p className="mt-1.5 text-[13px] text-muted">{line}</p>}
      {st && !st.saved && st.canSave && (
        <>
          <p className="mt-1.5 text-[13px] text-muted">
            In Telegram, ask @BotFather for a new bot (/newbot) and paste the token it gives you. Dune Bot then shows a code to pair your own chat with it. Removing the token unpairs it.
          </p>
          <form
            className="mt-2.5 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (token.trim()) run(() => api.save(token));
            }}
          >
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the token from @BotFather"
              className="h-9 min-w-0 flex-1 rounded-full border border-line bg-transparent px-3.5 text-[14px] outline-none placeholder:text-muted"
            />
            <button disabled={!token.trim() || saving} className="h-9 rounded-full bg-ink px-4 text-[13.5px] font-semibold text-white hover:bg-black disabled:bg-muted/40">
              Save
            </button>
          </form>
        </>
      )}
      {st && !st.saved && !st.canSave && <p className="mt-1.5 text-[13px] text-ink">This computer has no keychain to lock a token with, so Dune Bot won't keep one.</p>}
      {problem && <p className="mt-1.5 text-[13px] font-medium text-ink">{problem}</p>}
    </div>
  );
}

function SwitchRow({ title, on, onPick, hint }: { title: string; on: boolean; onPick: (on: boolean) => void; hint: string }) {
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center gap-4">
        <span className="flex-1 text-[15px] font-medium">{title}</span>
        <div className="flex rounded-full bg-black/[.05] p-0.5">
          {SWITCH.map(([v, label]) => (
            <button
              key={label}
              onClick={() => onPick(v)}
              className={`h-8 rounded-full px-3.5 text-[13px] font-semibold ${on === v ? "bg-white text-ink shadow-[0_1px_2px_rgba(0,0,0,.1)]" : "text-[#777] hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1.5 text-[13px] text-muted">{hint}</p>
    </div>
  );
}
