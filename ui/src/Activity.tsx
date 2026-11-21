import { useEffect, useState } from "react";
import { call, errorText, type LedgerRow } from "./store";
import { LoadProblem } from "./parts";
import { when } from "./format";
import { PageShell } from "./ui";

/** Activity's words for the core's action keys and decisions (core/src/app.rs ledger): short enough
 * for their column, the core's full words in the tooltip. */
const DONE_WHAT: Record<string, string> = {
  "run-command": "Command",
  "write-file": "File change",
  "read-file": "Read file",
  "list-folder": "Folder",
  "search-chats": "Chat search",
  "look-screen": "Screen look",
  "find-location": "Location",
  click: "Click",
  type: "Typing",
  point: "Point",
  "slack-write": "Slack",
  "gmail-write": "Gmail",
  "notion-write": "Notion",
  "calendar-write": "Calendar",
  "x-post": "Post on X",
  bot: "Bot",
  phone: "Phone",
  schedule: "Schedule",
  settings: "Setting",
};
const DECIDED: Record<string, string> = {
  "allowed (auto: nothing risky)": "Allowed: not risky",
  "allowed (always)": "Allowed: Always",
  "allowed (this chat)": "Allowed: this chat",
  "approved once": "You allowed it",
  "approved for this chat": "You allowed the chat",
  declined: "You said no",
  "no answer": "No answer",
  "blocked by settings": "Blocked: Never",
  "blocked (from your phone)": "Blocked: phone",
};
const decided = (d: string) => DECIDED[d] ?? (d ? d[0].toUpperCase() + d.slice(1) : "");

export function Activity() {
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [failed, setFailed] = useState("");
  const load = () =>
    call<LedgerRow[]>("ledger.list").then(
      (r) => (setRows(r), setFailed("")),
      (e) => setFailed(errorText(e)),
    );
  useEffect(() => {
    load();
  }, []);
  const tone = (d: string) =>
    d.startsWith("declined") || d.startsWith("blocked") || d === "no answer" ? "bg-ink text-white" : d.startsWith("approved") || d.startsWith("allowed") ? "bg-ink/10 text-ink" : "bg-black/[.05] text-ink/70";
  return (
    <PageShell title="Activity" wide intro="Everything agents did or tried to do, newest first.">
      <div className="mt-6 divide-y divide-line rounded-2xl border border-line">
        {!rows && failed && <LoadProblem what="the activity" why={failed} retry={load} />}
        {rows?.length === 0 && <p className="px-4 py-6 text-center text-[14px] text-muted">Nothing yet.</p>}
        {rows?.map((r) => (
          <div key={r.id} className="flex items-center gap-3 px-4 py-2.5">
            <span className="w-16 shrink-0 text-[12px] text-muted">{when(r.at)}</span>
            <span className="w-24 shrink-0 truncate text-[13px] font-medium" title={r.action}>
              {DONE_WHAT[r.action] ?? r.action}
            </span>
            <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink/70 select-text" title={r.target}>
              {r.target}
            </code>
            <span title={r.decision} className={`shrink-0 rounded-full px-2.5 py-0.5 text-[12px] font-medium ${tone(r.decision)}`}>
              {decided(r.decision)}
            </span>
          </div>
        ))}
      </div>
    </PageShell>
  );
}
