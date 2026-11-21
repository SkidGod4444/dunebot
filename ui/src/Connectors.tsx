import { useEffect, useState } from "react";
import { call, setMode, useStore } from "./store";

/** One account as the core describes it. Pages never see a token, a key or a client secret. */
type Account = {
  source: string;
  label: string;
  state: "off" | "connecting" | "connected" | "reconnect";
  account?: string | null;
  tools: number;
  error?: string | null;
  help: string;
  /** What connecting takes: nothing (the browser), the user's own app's client ID, or a key. */
  needs: "nothing" | "client" | "key";
  secret: "none" | "required" | "optional";
  /** Slack: the Redirect URL the user's Slack app must list. */
  redirect?: string | null;
};

/** Each account's permission for changes (sending, drafting, creating, posting). */
export const CONNECTOR_ACTIONS: Record<string, string> = {
  slack: "slack-write",
  gmail: "gmail-write",
  notion: "notion-write",
  calendar: "calendar-write",
  x: "x-post",
};
const CHANGE_ACTIONS = new Set(Object.values(CONNECTOR_ACTIONS));
export const isConnectorAction = (action: string) => CHANGE_ACTIONS.has(action);

const CHOICES = [
  ["ask", "Ask me"],
  ["always", "Always"],
  ["never", "Never"],
] as const;

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** Permissions › Connectors: the user's Slack, Gmail, Notion, Google Calendar and X. */
export function Connectors() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const load = () =>
    call<{ accounts: Account[] }>("connectors.list").then(
      (r) => setAccounts(r.accounts),
      () => {},
    );
  useEffect(() => {
    load();
    return window.dunebot.onEvent((m) => {
      if (m?.event === "connectors.changed") load();
    });
  }, []);
  return (
    <div className="rounded-2xl border border-line">
      <p className="px-4 pt-3.5 pb-1 text-[13px] text-muted">
        Dune Bot reads an account only when you ask for it in a chat ("check my Slack"), never because an email, a message or a page says to. It asks before
        it sends, drafts, posts or changes anything. Sign-ins stay on this computer, locked by your keychain.
      </p>
      <div className="divide-y divide-line">
        {accounts?.map((a) => <AccountRow key={a.source} a={a} onChange={(list) => setAccounts(list)} />)}
      </div>
    </div>
  );
}

function AccountRow({ a, onChange }: { a: Account; onChange: (list: Account[]) => void }) {
  const modes = useStore((s) => s.modes);
  const change = modes.find((m) => m.action === CONNECTOR_ACTIONS[a.source]);
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  // X's key and a first sign-in with the user's own app are typed in first; Reconnect reuses the app.
  const asksFirst = a.needs === "key" || (a.needs === "client" && (a.state === "off" || !!a.error));
  const run = async (method: string, params: Record<string, unknown> = {}) => {
    setBusy(true);
    setProblem("");
    try {
      const r = await call<{ accounts: Account[] }>(method, { source: a.source, ...params });
      onChange(r.accounts);
      setOpen(false);
      setClientId("");
      setClientSecret("");
      setKey("");
    } catch (e) {
      setProblem(clean(e));
    } finally {
      setBusy(false);
    }
  };
  const start = () => (asksFirst ? setOpen(true) : run("connectors.connect"));
  const status =
    a.state === "connected"
      ? a.account
        ? `Connected to ${a.account}`
        : "Connected"
      : a.state === "connecting"
        ? "Waiting for your browser…"
        : a.state === "reconnect"
          ? "Sign-in stopped working"
          : "Not connected";
  const canSend =
    a.needs === "key" ? key.trim().length > 0 : a.needs === "client" ? clientId.trim().length > 0 && (a.secret !== "required" || clientSecret.trim().length > 0) : true;
  const error = problem || a.error || "";
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center gap-4">
        <span className="min-w-0 flex-1 text-[15px] font-medium">{a.label}</span>
        <span className={`text-[13px] ${a.state === "off" ? "text-muted" : "text-ink"}`}>{status}</span>
        {a.state === "connecting" && (
          <button onClick={() => run("connectors.cancel")} disabled={busy} className="h-8 rounded-full px-3 text-[13px] font-semibold text-ink hover:bg-black/[.05]">
            Cancel
          </button>
        )}
        {(a.state === "off" || a.state === "reconnect") && !open && (
          <button onClick={start} disabled={busy} className="h-8 rounded-full px-3 text-[13px] font-semibold text-ink hover:bg-black/[.05]">
            {a.state === "reconnect" ? "Reconnect" : "Connect"}
          </button>
        )}
        {(a.state === "connected" || a.state === "reconnect") && (
          <button onClick={() => run("connectors.disconnect")} disabled={busy} className="h-8 rounded-full px-3 text-[13px] font-semibold text-ink hover:bg-black/[.05]">
            Disconnect
          </button>
        )}
      </div>
      {a.state === "connected" && change && (
        <div className="mt-2.5 flex items-center gap-4">
          <span className="flex-1 text-[13px] text-muted">{change.label}</span>
          <div className="flex rounded-full bg-black/[.05] p-0.5">
            {CHOICES.map(([k, label]) => (
              <button
                key={k}
                onClick={() => setMode(change.action, k)}
                className={`h-7 rounded-full px-3 text-[12.5px] font-semibold ${change.mode === k ? "bg-white text-ink shadow-[0_1px_2px_rgba(0,0,0,.1)]" : "text-[#777] hover:text-ink"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {open && (a.state === "off" || a.state === "reconnect") && (
        <form
          className="mt-2.5 grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSend) return;
            if (a.needs === "key") run("connectors.connect", { key });
            else if (a.needs === "client") run("connectors.connect", { clientId, ...(clientSecret.trim() ? { clientSecret } : {}) });
            else run("connectors.connect");
          }}
        >
          <p className="text-[13px] text-muted">{a.help}</p>
          {a.redirect && (
            <p className="text-[13px] text-muted">
              Redirect URL: <code className="font-mono text-[12px] text-ink select-text">{a.redirect}</code>
            </p>
          )}
          {a.needs === "key" && (
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste a bearer token from console.x.com"
              className="h-9 min-w-0 rounded-full border border-line bg-transparent px-3.5 text-[14px] outline-none placeholder:text-muted"
            />
          )}
          {a.needs === "client" && (
            <>
              <input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="Client ID"
                className="h-9 min-w-0 rounded-full border border-line bg-transparent px-3.5 text-[14px] outline-none placeholder:text-muted"
              />
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder={a.secret === "required" ? "Client secret" : "Client secret (only if PKCE is off)"}
                className="h-9 min-w-0 rounded-full border border-line bg-transparent px-3.5 text-[14px] outline-none placeholder:text-muted"
              />
            </>
          )}
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="h-9 rounded-full px-3 text-[13px] font-semibold text-ink hover:bg-black/[.05]">
              Not now
            </button>
            <button disabled={!canSend || busy} className="h-9 rounded-full bg-ink px-4 text-[13.5px] font-semibold text-white hover:bg-black disabled:bg-muted/40">
              {a.needs === "key" ? "Save" : "Open sign-in"}
            </button>
          </div>
        </form>
      )}
      {!open && a.state === "off" && a.needs === "nothing" && <p className="mt-1.5 text-[13px] text-muted">{a.help}</p>}
      {error && <p className="mt-1.5 text-[13px] font-medium text-ink">{error}</p>}
    </div>
  );
}
