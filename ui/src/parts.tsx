import { useEffect, useRef, useState } from "react";
import { Reply, Typing, TypingLine } from "./reply";
import { useSmoothText, type StreamStats } from "./smooth";
import { Check, ChevronDown, FilePen, FileText, FolderOpen, History, Loader2, MapPin, Monitor, ShieldAlert, ShieldCheck, ShieldX, TerminalSquare, Wrench, X } from "lucide-react";
import { AGENT_LOOK, agentName, answer, call, toast, type Message } from "./store";

/** "Teach a fix": the user writes what the agent should do instead. Kept with this failure; agents
 * read it as a note from then on (it never changes what they may do). */
export function TeachFix({ failure, detail, threadId, inset }: { failure: string; detail?: string; threadId: string; inset?: boolean }) {
  const [state, setState] = useState<"closed" | "open" | "saved">("closed");
  const [text, setText] = useState("");
  const pad = inset ? "px-3.5" : "px-1";
  if (state === "saved")
    return (
      <p className={`flex items-center gap-1.5 py-2 text-[12.5px] text-[#2f9e62] ${pad}`}>
        <Check size={13} /> Fix saved. Agents read it from now on.
      </p>
    );
  if (state === "closed")
    return (
      <button onClick={() => setState("open")} className={`flex items-center gap-1.5 py-2 text-[12.5px] font-medium text-muted hover:text-ink ${pad}`}>
        <Wrench size={13} /> Teach a fix
      </button>
    );
  async function save() {
    try {
      await call("fixes.add", { threadId, failure, detail, fix: text });
      setState("saved");
    } catch (e) {
      toast(String((e as Error).message ?? e));
    }
  }
  return (
    <div className={`py-2.5 ${pad}`}>
      <textarea
        autoFocus
        rows={2}
        value={text}
        maxLength={500}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (text.trim()) save();
          } else if (e.key === "Escape") setState("closed");
        }}
        placeholder="Next time, do this instead…"
        className="w-full resize-none rounded-xl border border-line bg-white px-3 py-2 text-[13.5px] outline-none placeholder:text-muted focus:border-muted/60 select-text"
      />
      <div className="mt-1.5 flex items-center gap-2">
        <span className="mr-auto text-[12px] text-muted">A note for agents. It doesn't change what they may do.</span>
        <button onClick={() => setState("closed")} className="h-7 rounded-full px-2.5 text-[12.5px] text-muted hover:text-ink">
          Cancel
        </button>
        <button disabled={!text.trim()} onClick={save} className="h-7 rounded-full bg-ink px-3 text-[12.5px] font-medium text-white hover:bg-black disabled:opacity-40">
          Save fix
        </button>
      </div>
    </div>
  );
}

const firstLine = (s?: string) => (s ?? "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? "";

/** Dune Bot's own mark: a coral tile with a spark. */
export function Mascot({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden>
      <rect width="40" height="40" rx="12" fill="var(--color-coral)" />
      <path d="M20 7.5c1.3 6.8 5.7 11.2 12.5 12.5-6.8 1.3-11.2 5.7-12.5 12.5C18.7 25.7 14.3 21.3 7.5 20 14.3 18.7 18.7 14.3 20 7.5z" fill="#fff" />
      <circle cx="30.5" cy="9.5" r="2.2" fill="#fff" opacity=".85" />
    </svg>
  );
}

export function AgentAvatar({ id, size = 36, dot }: { id: string; size?: number; dot?: "busy" | "waiting" }) {
  const look = AGENT_LOOK[id] ?? { color: "#9a9a9a", short: id.slice(0, 2) };
  return (
    <span className="relative inline-grid shrink-0 place-items-center text-[#fff]" style={{ width: size, height: size, borderRadius: size * 0.3, background: look.color }}>
      <span className="font-pixel leading-none" style={{ fontSize: size * 0.46 }}>{look.short}</span>
      {dot && (
        <span
          className={`absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-side ${dot === "waiting" ? "bg-[#f0a33a]" : "bg-[#3bb273] animate-pulse"}`}
        />
      )}
    </span>
  );
}

export function UserBubble({ m }: { m: Message }) {
  return (
    <div className="max-w-[78%] self-end whitespace-pre-wrap break-words rounded-[22px] bg-ink px-4 py-2.5 text-[15px] leading-[1.45] text-white select-text">
      {m.text}
    </div>
  );
}

export function AssistantBubble({ m }: { m: Message }) {
  const streaming = m.meta.status === "streaming";
  const failed = m.meta.status === "error";
  const text = useSmoothText(m.text, streaming, noteStream);
  const live = streaming || text.length < m.text.length;
  if (!m.text && !streaming) return null;
  return (
    <div
      data-live={live ? "" : undefined}
      className={`md max-w-[85%] self-start rounded-[22px] px-4 py-2.5 text-[15px] leading-[1.5] select-text ${failed ? "bg-[#c4553f]/12 text-[#d0604a]" : "bg-bubble"}`}
    >
      {text ? <Reply text={text} streaming={live} /> : <TypingLine />}
    </div>
  );
}

/** One line per streamed reply in the app's log (numbers only, never the text). */
export function noteStream(s: StreamStats) {
  window.dunebot.note?.(`reply shown: ${s.chars} characters, ${s.updates} updates, ${s.frames} frames, longest pause ${s.longestGapMs} ms`);
}

export { Typing };

/** "Working…" under the newest message: the same size as a one-line reply, which takes its place. */
export function ThinkingBubble() {
  return (
    <div className="self-start rounded-[22px] bg-bubble px-4 py-2.5 text-[15px] leading-[1.5]">
      <TypingLine />
    </div>
  );
}

export const TOOL: Record<string, { icon: typeof FileText; doing: string; done: string; failed: string }> = {
  run_command: { icon: TerminalSquare, doing: "Running a command", done: "Ran a command", failed: "Command didn't run" },
  read_file: { icon: FileText, doing: "Reading a file", done: "Read a file", failed: "Couldn't read a file" },
  write_file: { icon: FilePen, doing: "Writing a file", done: "Wrote a file", failed: "Didn't write the file" },
  list_folder: { icon: FolderOpen, doing: "Looking in a folder", done: "Looked in a folder", failed: "Couldn't open a folder" },
  search_chats: { icon: History, doing: "Searching past chats", done: "Searched past chats", failed: "Couldn't search past chats" },
  look_at_screen: { icon: Monitor, doing: "Looking at your screen", done: "Looked at your screen", failed: "Couldn't see the screen" },
  find_location: { icon: MapPin, doing: "Finding where you are", done: "Found where you are", failed: "Couldn't find where you are" },
};

/** `teach`: offer "Teach a fix" when the step failed (the history window; the bar leaves it out). */
export function ToolCard({ m, waiting, teach = true }: { m: Message; waiting: boolean; teach?: boolean }) {
  const [open, setOpen] = useState(false);
  const t = TOOL[m.meta.tool] ?? { icon: TerminalSquare, doing: m.text, done: m.text, failed: m.text };
  const status: string = m.meta.status;
  const args = m.meta.args ?? {};
  const target: string = args.command ?? args.path ?? args.query ?? (args.chat ? `chat ${args.chat}` : "");
  const Icon = t.icon;
  return (
    <div className="w-full max-w-[85%] self-start overflow-hidden rounded-2xl border border-line bg-white">
      <button onClick={() => setOpen(!open)} disabled={!m.meta.output} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left disabled:cursor-default">
        <Icon size={16} className="shrink-0 text-muted" />
        <span className="shrink-0 text-[13.5px] font-semibold">{status === "running" ? t.doing : status === "failed" ? t.failed : t.done}</span>
        <code className="min-w-0 truncate font-mono text-[12px] text-muted">{target}</code>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[12px] text-muted">
          {status === "running" && (waiting ? <span className="font-medium text-[#b9761a]">Waiting for you</span> : <Loader2 size={14} className="animate-spin" />)}
          {status === "done" && <Check size={15} className="text-[#2f9e62]" />}
          {status === "failed" && <X size={15} className="text-[#c4553f]" />}
          {m.meta.output && <ChevronDown size={15} className={`transition-transform ${open ? "rotate-180" : ""}`} />}
        </span>
      </button>
      {open && (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-line bg-side px-3.5 py-3 font-mono text-[12px] leading-[1.5] select-text">
          {m.meta.output}
        </pre>
      )}
      {status === "failed" && teach && (
        <div className="border-t border-line">
          <TeachFix inset threadId={m.threadId} failure={`${t.failed}: ${target}`} detail={firstLine(m.meta.output)} />
        </div>
      )}
    </div>
  );
}

const ASK: Record<string, string> = {
  "run-command": "run this command",
  "write-file": "create or change this file",
  "read-file": "read this file",
  "list-folder": "look inside this folder",
  "search-chats": "search your past chats",
};

const ALL_IN_CHAT: Record<string, string> = {
  "run-command": "Allow all commands in this chat",
  "write-file": "Allow all file changes in this chat",
  "read-file": "Allow all reads in this chat",
  "list-folder": "Allow all folder views in this chat",
  "search-chats": "Allow all chat searches in this chat",
};

function tidyDetail(d: string) {
  if (/^in .*[\\/]workspaces[\\/][0-9a-f]{32}$/.test(d)) return "in this chat's own folder";
  return d.replace(/^in (\/Users\/[^/]+|\/home\/[^/]+|[A-Z]:\\Users\\[^\\]+)/, "in ~");
}

const mod = window.dunebot?.platform === "darwin" ? "⌘" : "Ctrl+";

/** `bar`: the floating bar's version: no per-chat grant, and keys: ⌘↩ allows once, Esc says no.
 * Bare Enter never allows, and the core refuses an "allow" in the first half-second. */
const READ_MS = 500;

/** When the card has been on screen since (null while its window is hidden). An "allow" sooner
 * than READ_MS after that is ignored, on top of the core's own check from when the card was made. */
function useOnScreenSince() {
  const since = useRef<number | null>(document.visibilityState === "visible" ? Date.now() : null);
  useEffect(() => {
    const onVis = () => (since.current = document.visibilityState === "visible" ? Date.now() : null);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  return () => since.current !== null && Date.now() - since.current >= READ_MS;
}

export function ApprovalCard({ m, agent, bar, keys }: { m: Message; agent: string; bar?: boolean; keys?: boolean }) {
  const { approvalId, action, target, detail, status, why } = m.meta;
  const readLongEnough = useOnScreenSince();
  const allow = (decision: "once" | "chat") => {
    if (!readLongEnough()) return toast("Take a second to read the card first.");
    answer(approvalId, decision);
  };
  useEffect(() => {
    if (!keys || status !== "pending") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        allow("once");
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        answer(approvalId, "deny");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [keys, status, approvalId]);
  if (status !== "pending") {
    const done: Record<string, [typeof Check, string, string]> = {
      "approved-once": [ShieldCheck, "Allowed once", "text-[#2f9e62]"],
      "approved-chat": [ShieldCheck, "Allowed for the rest of this chat", "text-[#2f9e62]"],
      denied: [ShieldX, "Not allowed", "text-[#c4553f]"],
      expired: [ShieldX, "No answer, so it wasn't done", "text-muted"],
    };
    const [Icon, label, tone] = done[status] ?? done.expired;
    // A declined action's tool card (just above) carries "Teach a fix".
    return (
      <div className="flex max-w-[85%] items-center gap-2 self-start px-1 text-[12.5px] text-muted">
        <Icon size={14} className={`shrink-0 ${tone}`} />
        <span className={`shrink-0 font-medium ${tone}`}>{label}</span>
        <code className="min-w-0 truncate font-mono text-[11.5px]">{target}</code>
      </div>
    );
  }
  return (
    <div className={`w-full self-start rounded-[20px] border border-amber-line bg-amber-card p-4 ${bar ? "" : "max-w-[85%]"}`}>
      <div className="flex items-center gap-2 text-[15px] font-semibold">
        <ShieldAlert size={17} className="text-[#d08a1f]" />
        {agentName(agent)} wants to {ASK[action] ?? "do this"}
      </div>
      <pre className="mt-3 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-line bg-white px-3 py-2.5 font-mono text-[12.5px] leading-[1.5] select-text">
        {target}
      </pre>
      {detail && <p className="mt-2 truncate text-[13px] text-muted" title={detail}>{tidyDetail(detail)}</p>}
      {why && <p className="mt-1 text-[13px] text-[#b9761a]">Asking because {why}.</p>}
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <button onClick={() => allow("once")} className="h-9 rounded-full bg-ink px-4 text-[14px] font-semibold text-white hover:bg-black">
          Allow once{keys && <kbd className="ml-2 font-sans text-[12px] font-normal text-white/60">{mod}↩</kbd>}
        </button>
        {!bar && (
          <button onClick={() => allow("chat")} className="h-9 rounded-full border border-line bg-white px-4 text-[14px] font-medium hover:border-muted/50">
            {ALL_IN_CHAT[action] ?? "Allow for this chat"}
          </button>
        )}
        <button onClick={() => answer(approvalId, "deny")} className="h-9 rounded-full px-3 text-[14px] font-medium text-muted hover:text-ink">
          Don't allow{keys && <kbd className="ml-1.5 font-sans text-[12px] font-normal opacity-70">esc</kbd>}
        </button>
      </div>
    </div>
  );
}
