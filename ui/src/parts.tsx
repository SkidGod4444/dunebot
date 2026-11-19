import { useEffect, useRef, useState } from "react";
import { Reply, Typing, TypingLine } from "./reply";
import { useSmoothText, type StreamStats } from "./smooth";
import { Check, ShieldAlert, ShieldCheck, ShieldX, Wrench } from "lucide-react";
import { AGENT_LOOK, agentName, answer, call, toast, type Message } from "./store";
import mascot from "./mascot.svg";
import { botLook } from "./bots";

/** "Teach a fix": the user writes what the agent should do instead. Kept with this failure; agents
 * read it as a note from then on (it never changes what they may do). */
export function TeachFix({ failure, detail, threadId, inset }: { failure: string; detail?: string; threadId: string; inset?: boolean }) {
  const [state, setState] = useState<"closed" | "open" | "saved">("closed");
  const [text, setText] = useState("");
  const pad = inset ? "px-3.5" : "px-1";
  if (state === "saved")
    return (
      <p className={`flex items-center gap-1.5 py-2 text-[12.5px] text-ink ${pad}`}>
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

/** Dune Bot's own mark: the app's icon (the white kitten on its black tile), drawn by scripts/icon.mjs. */
export function Mascot({ size = 40 }: { size?: number }) {
  return <img src={mascot} width={size} height={size} alt="" draggable={false} className="shrink-0 select-none" />;
}

export function AgentAvatar({ id, size = 36, dot }: { id: string; size?: number; dot?: "busy" | "waiting" }) {
  const look = AGENT_LOOK[id] ?? botLook(id) ?? { short: id.slice(0, 2) };
  return (
    <span className="relative inline-grid shrink-0 place-items-center bg-[#3a3a3c] text-[#fff]" style={{ width: size, height: size, borderRadius: size * 0.3 }}>
      <span className="font-pixel leading-none" style={{ fontSize: size * 0.46 }}>{look.short}</span>
      {dot && (
        <span
          className={`absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-side ${dot === "waiting" ? "bg-ink" : "bg-ink/60 animate-pulse"}`}
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
      className={`md max-w-[85%] self-start rounded-[22px] px-4 py-2.5 text-[15px] leading-[1.5] select-text ${failed ? "border border-ink/25 text-ink" : "bg-bubble"}`}
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

/** How a failed step reads in a fix ("Command didn't run: npm install"). */
const FAILED: Record<string, string> = {
  run_command: "Command didn't run",
  read_file: "Couldn't read a file",
  write_file: "Didn't write the file",
  list_folder: "Couldn't open a folder",
  search_chats: "Couldn't search past chats",
  look_at_screen: "Couldn't see the screen",
  find_location: "Couldn't find where you are",
  click: "Couldn't click",
  scroll: "Couldn't scroll",
  drag: "Couldn't drag",
  type_text: "Couldn't type",
  press_keys: "Couldn't press keys",
};

/** What a failed step was, for "Teach a fix" (kept with the fix; the chat doesn't show steps). */
export function failureOf(m: Message) {
  const failed = FAILED[m.meta.tool] ?? m.text;
  const args = m.meta.args ?? {};
  const target: string = args.command ?? args.path ?? args.query ?? args.what ?? args.keys ?? (args.chat ? `chat ${args.chat}` : "");
  return { failure: target ? `${failed}: ${target}` : failed, detail: firstLine(m.meta.output) };
}

const ASK: Record<string, string> = {
  "run-command": "run this command",
  "write-file": "create or change this file",
  "read-file": "read this file",
  "list-folder": "look inside this folder",
  "search-chats": "search your past chats",
  click: "use the mouse on your screen",
  type: "type or press keys",
};

const ALL_IN_CHAT: Record<string, string> = {
  "run-command": "Allow all commands in this chat",
  "write-file": "Allow all file changes in this chat",
  "read-file": "Allow all reads in this chat",
  "list-folder": "Allow all folder views in this chat",
  "search-chats": "Allow all chat searches in this chat",
  click: "Allow the mouse in this chat",
  type: "Allow typing in this chat",
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
      "approved-once": [ShieldCheck, "Allowed once", "text-ink"],
      "approved-chat": [ShieldCheck, "Allowed for the rest of this chat", "text-ink"],
      denied: [ShieldX, "Not allowed", "text-ink"],
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
    <div className={`w-full self-start rounded-[20px] border border-ask-line bg-ask-card p-4 ${bar ? "" : "max-w-[85%]"}`}>
      <div className="flex items-center gap-2 text-[15px] font-semibold">
        <ShieldAlert size={17} className="text-ink" />
        {agentName(agent)} wants to {ASK[action] ?? "do this"}
      </div>
      <pre className="mt-3 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-line bg-white px-3 py-2.5 font-mono text-[12.5px] leading-[1.5] select-text">
        {target}
      </pre>
      {detail && <p className="mt-2 truncate text-[13px] text-muted" title={detail}>{tidyDetail(detail)}</p>}
      {why && <p className="mt-1 text-[13px] text-ink">Asking because {why}.</p>}
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
