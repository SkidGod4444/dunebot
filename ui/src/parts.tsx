import { useEffect, useRef, useState, type ReactNode } from "react";
import { Reply, Typing, TypingLine } from "./reply";
import { useSmoothText, type StreamStats } from "./smooth";
import { Check, ShieldAlert, ShieldCheck, ShieldX, Trash2, Wrench } from "lucide-react";
import { AGENT_LOOK, agentName, answer, call, errorText, toast, type Message } from "./store";
import mascot from "./mascot.svg";
import { botLook } from "./bots";

/** A short question under the button that opened it (Undo, Delete…). Escape or a click outside
 * closes it. Cancel takes the keyboard: Enter that opened it (or a second press) never confirms;
 * Tab reaches the confirming button. */
export function Confirm({ title, confirm, onConfirm, onClose, children }: { title: string; confirm: string; onConfirm: () => void; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const no = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    no.current?.focus({ preventScroll: true });
    // A row near the bottom of the window: the question opens below it, so bring it into view.
    box.current?.scrollIntoView({ block: "nearest" });
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // Outside the button and its question (a press on the button itself toggles it, as before).
    const down = (e: PointerEvent) => !box.current?.parentElement?.contains(e.target as Node) && onClose();
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", down, true);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("pointerdown", down, true);
    };
  }, []);
  return (
    <div
      ref={box}
      role="dialog"
      aria-label={title}
      className="no-drag absolute right-0 top-10 z-20 w-72 rounded-2xl border border-line bg-white p-3.5 text-[13px] shadow-[0_14px_40px_rgba(0,0,0,.16)]"
    >
      <p className="font-medium text-ink">{title}</p>
      <p className="mt-1 text-muted">{children}</p>
      <div className="mt-3 flex justify-end gap-2">
        <button ref={no} onClick={onClose} className="h-8 rounded-full px-3 text-muted hover:text-ink">
          Cancel
        </button>
        <button data-confirm onClick={onConfirm} className="h-8 rounded-full bg-ink px-3.5 font-medium text-white hover:bg-black">
          {confirm}
        </button>
      </div>
    </div>
  );
}

/** A trash button that asks first (a schedule, a fix, a bot): nothing is deleted on one click. */
export function DeleteButton({ what, body, onDelete, size = 15 }: { what: string; body: string; onDelete: () => void; size?: number }) {
  const [asking, setAsking] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        title={`Delete this ${what}`}
        aria-label={`Delete this ${what}`}
        aria-expanded={asking}
        onClick={() => setAsking((a) => !a)}
        className="grid size-7 place-items-center rounded-lg text-muted hover:bg-black/5 hover:text-ink"
      >
        <Trash2 size={size} />
      </button>
      {asking && (
        <Confirm
          title={`Delete this ${what}?`}
          confirm="Delete"
          onConfirm={() => {
            setAsking(false);
            onDelete();
          }}
          onClose={() => setAsking(false)}
        >
          {body}
        </Confirm>
      )}
    </div>
  );
}

/** A list that couldn't be read: why, and a way to try again (never an empty list that isn't). */
export function LoadProblem({ what, why, retry }: { what: string; why: string; retry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-4 px-4 py-3.5">
      <span className="min-w-0 flex-1 text-[13.5px] text-ink">
        Couldn't load {what}: {why}
      </span>
      <button onClick={retry} className="h-8 shrink-0 rounded-full px-3 text-[13px] font-semibold text-ink hover:bg-black/[.05]">
        Try again
      </button>
    </div>
  );
}

/** "Teach a fix": the user writes what the agent should do instead. Kept with this failure; agents
 * read it as a note from then on (it never changes what they may do). */
export function TeachFix({ failure, detail, threadId }: { failure: string; detail?: string; threadId: string }) {
  const [state, setState] = useState<"closed" | "open" | "saved">("closed");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const pad = "px-1";
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
    // Once: a second Enter or click while it saves would keep the same fix twice.
    if (saving || !text.trim()) return;
    setSaving(true);
    try {
      await call("fixes.add", { threadId, failure, detail, fix: text });
      setState("saved");
    } catch (e) {
      toast(errorText(e));
    } finally {
      setSaving(false);
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
          // isComposing: Enter that picks a word in an input method (Japanese, Chinese…) isn't "save".
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") setState("closed");
        }}
        aria-label="What to do instead next time"
        placeholder="Next time, do this instead…"
        className="w-full resize-none rounded-xl border border-line bg-white px-3 py-2 text-[13.5px] outline-none placeholder:text-muted focus:border-muted/60 select-text"
      />
      <div className="mt-1.5 flex items-center gap-2">
        <span className="mr-auto text-[12px] text-muted">A note for agents. It doesn't change what they may do.</span>
        <button onClick={() => setState("closed")} className="h-7 rounded-full px-2.5 text-[12.5px] text-muted hover:text-ink">
          Cancel
        </button>
        <button disabled={!text.trim() || saving} onClick={save} className="h-7 rounded-full bg-ink px-3 text-[12.5px] font-medium text-white hover:bg-black disabled:opacity-40">
          {saving ? "Saving…" : "Save fix"}
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

/** "<agent> wants to …", for every action the core can ask about (core/src/policy.rs Action). One
 * it doesn't know yet says the core's own label (meta.label), never a bare "do this". */
const ASK: Record<string, string> = {
  "run-command": "run this command",
  "write-file": "create or change this file",
  "read-file": "read this file",
  "list-folder": "look inside this folder",
  "search-chats": "search your past chats",
  "look-screen": "look at your screen",
  "find-location": "find where you are",
  click: "use the mouse on your screen",
  type: "type or press keys",
  point: "point at something on your screen",
  "slack-write": "send or change this in Slack",
  "gmail-write": "draft or change this in Gmail",
  "notion-write": "create or change this in Notion",
  "calendar-write": "add or change this calendar event",
  "x-post": "post this on X",
};

const ALL_IN_CHAT: Record<string, string> = {
  "run-command": "Allow all commands in this chat",
  "write-file": "Allow all file changes in this chat",
  "read-file": "Allow all reads in this chat",
  "list-folder": "Allow all folder views in this chat",
  "search-chats": "Allow chat searches in this chat",
  "look-screen": "Allow screen looks in this chat",
  "find-location": "Allow your location in this chat",
  click: "Allow the mouse in this chat",
  type: "Allow typing in this chat",
  point: "Allow pointing in this chat",
  "slack-write": "Allow Slack changes in this chat",
  "gmail-write": "Allow Gmail changes in this chat",
  "notion-write": "Allow Notion changes in this chat",
  "calendar-write": "Allow calendar changes in this chat",
  "x-post": "Allow posts on X in this chat",
};

/** What the card asks, in words: the table above, else the core's label ("Post on X" → "post on X"). */
function askText(action: string, label?: string) {
  if (ASK[action]) return ASK[action];
  if (label) return label[0].toLowerCase() + label.slice(1);
  return "do this";
}

function tidyDetail(d: string) {
  if (/^in .*[\\/]workspaces[\\/][0-9a-f]{32}$/.test(d)) return "in this chat's own folder";
  return d.replace(/^in (\/Users\/[^/]+|\/home\/[^/]+|[A-Z]:\\Users\\[^\\]+)/, "in ~");
}

/** `bar`: the floating card's version: no per-chat grant (its window never takes the keyboard, so
 * there are no keys to answer with). The core refuses an "allow" in the first half-second. */
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

export function ApprovalCard({ m, agent, bar }: { m: Message; agent: string; bar?: boolean }) {
  const { approvalId, action, target, detail, status, why, label: coreLabel } = m.meta;
  const readLongEnough = useOnScreenSince();
  const allow = (decision: "once" | "chat") => {
    if (!readLongEnough()) return toast("Take a second to read the card first.");
    answer(approvalId, decision);
  };
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
        <code title={target} className="min-w-0 truncate font-mono text-[11.5px]">
          {target}
        </code>
      </div>
    );
  }
  return (
    <div
      role="group"
      aria-label={`${agentName(agent)} wants to ${askText(action, coreLabel)}`}
      data-approval-card
      className={`w-full self-start rounded-[20px] border border-ask-line bg-ask-card p-4 ${bar ? "" : "max-w-[85%]"}`}
    >
      <div className="flex items-center gap-2 text-[15px] font-semibold">
        <ShieldAlert size={17} className="shrink-0 text-ink" />
        {agentName(agent)} wants to {askText(action, coreLabel)}
      </div>
      {/* In the small card, a long command stays short enough that what's asked stays in view. */}
      <pre className={`mt-3 ${bar ? "max-h-32" : "max-h-60"} overflow-auto whitespace-pre-wrap break-all rounded-xl border border-line bg-white px-3 py-2.5 font-mono text-[12.5px] leading-[1.5] select-text`}>
        {target}
      </pre>
      {detail && <p className="mt-2 truncate text-[13px] text-muted" title={detail}>{tidyDetail(detail)}</p>}
      {why && <p className="mt-1 text-[13px] text-ink">Asking because {why}.</p>}
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <button onClick={() => allow("once")} className="h-9 rounded-full bg-ink px-4 text-[14px] font-semibold text-white hover:bg-black">
          Allow once
        </button>
        {!bar && (
          <button onClick={() => allow("chat")} className="h-9 rounded-full border border-line bg-white px-4 text-[14px] font-medium hover:border-muted/50">
            {ALL_IN_CHAT[action] ?? "Allow for this chat"}
          </button>
        )}
        <button onClick={() => answer(approvalId, "deny")} className="h-9 rounded-full px-3 text-[14px] font-medium text-muted hover:text-ink">
          Don't allow
        </button>
      </div>
    </div>
  );
}
