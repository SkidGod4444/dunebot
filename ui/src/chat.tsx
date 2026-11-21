import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, FolderOpen, FolderPlus, Monitor, Square, Trash2, Undo2 } from "lucide-react";
import { agentName, call, errorText, loadAgents, send, startChat, toast, useStore, type Message } from "./store";
import { AgentAvatar, ApprovalCard, AssistantBubble, Confirm, Mascot, TeachFix, ThinkingBubble, UserBubble, failureOf } from "./parts";
import { useStickToBottom } from "./stick";

function shortPath(p: string) {
  const m = p.match(/(?:^|[\\/])workspaces[\\/][0-9a-f]{32}$/);
  if (m) return "its own folder";
  return p.replace(/^\/Users\/[^/]+|^\/home\/[^/]+|^[A-Z]:\\Users\\[^\\]+/, "~");
}

type UndoResult = { restored: number; removed: number; skipped: { path: string; why: string }[] };

/** Puts back every file this chat's agent wrote (asks first; commands it ran aren't undone). */
function UndoChanges({ id, busy }: { id: string; busy: boolean }) {
  const [count, setCount] = useState(0);
  const [asking, setAsking] = useState(false);
  const refresh = () => call<unknown[]>("threads.changes", { id }).then((c) => setCount(c.length)).catch(() => setCount(0));
  useEffect(() => {
    setAsking(false);
    refresh();
  }, [id, busy]);
  if (!count) return null;
  const files = count === 1 ? "1 file change" : `${count} file changes`;
  async function undo() {
    setAsking(false);
    try {
      const r = await call<UndoResult>("threads.undo", { id });
      const done = [
        r.restored && `put back ${r.restored} file${r.restored > 1 ? "s" : ""}`,
        r.removed && `moved ${r.removed} new file${r.removed > 1 ? "s" : ""} to Dune Bot's undo folder`,
      ].filter(Boolean);
      const left = r.skipped.map((s) => `${s.path.split(/[\\/]/).pop()}: ${s.why}`);
      toast(
        (done.length ? `Undone: ${done.join(", ")}.` : "Nothing to undo.") +
          (left.length ? ` Left alone: ${left.slice(0, 2).join("; ")}${left.length > 2 ? ` and ${left.length - 2} more` : ""}.` : ""),
      );
    } catch (e) {
      toast(errorText(e));
    }
    refresh();
  }
  return (
    <div className="relative">
      <button
        title={`Undo this chat's ${files}`}
        aria-label={`Undo this chat's ${files}`}
        aria-expanded={asking}
        disabled={busy}
        onClick={() => setAsking((a) => !a)}
        className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] text-muted hover:bg-black/5 hover:text-ink disabled:opacity-40"
      >
        <Undo2 size={16} />
        {count}
      </button>
      {asking && (
        <Confirm title={`Undo this chat's ${files}?`} confirm="Undo" onConfirm={undo} onClose={() => setAsking(false)}>
          Each file goes back to how it was; files the agent created move to Dune Bot's undo folder, so nothing is lost. A
          file you changed since is left alone. Commands it ran aren't undone.
        </Confirm>
      )}
    </div>
  );
}

/** Deletes the chat, after asking: there's no undo for it. */
function DeleteChat({ id, title }: { id: string; title: string }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => setAsking(false), [id]);
  async function remove() {
    setAsking(false);
    try {
      await call("threads.delete", { id });
    } catch (e) {
      toast(errorText(e));
    }
  }
  return (
    <div className="relative">
      <button
        title="Delete chat"
        aria-label="Delete chat"
        aria-expanded={asking}
        onClick={() => setAsking((a) => !a)}
        className="grid size-8 place-items-center rounded-lg text-muted hover:bg-black/5 hover:text-ink"
      >
        <Trash2 size={17} />
      </button>
      {asking && (
        <Confirm title="Delete this chat?" confirm="Delete" onConfirm={remove} onClose={() => setAsking(false)}>
          “{title}” and its messages are removed from Dune Bot. Files it changed stay as they are.
        </Confirm>
      )}
    </div>
  );
}

export function ThreadView() {
  const id = useStore((s) => s.activeId);
  const thread = useStore((s) => s.threads.find((t) => t.id === s.activeId));
  const msgs = useStore((s) => (s.activeId ? s.messages[s.activeId] : undefined));
  const busy = useStore((s) => (s.activeId ? !!s.busy[s.activeId] : false));
  const waiting = useStore((s) => (s.activeId ? (s.waiting[s.activeId] ?? 0) > 0 : false));
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useStickToBottom(scroller, [id, !!thread]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs, busy]);
  useEffect(() => {
    stick.current = true;
  }, [id]);

  if (!thread || !id) return <NewChat />;
  const last = msgs?.[msgs.length - 1];
  const showTyping = busy && !waiting && !(last?.role === "assistant" && last.meta.status === "streaming");
  return (
    <>
      <header className="dm-top drag flex h-[56px] shrink-0 items-center gap-3 border-b border-line px-5">
        <AgentAvatar id={thread.agent} size={30} />
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold leading-tight">{thread.title}</div>
          <div className="truncate text-[12px] text-muted">
            {agentName(thread.agent)} · {shortPath(thread.cwd)}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <UndoChanges id={id} busy={busy} />
          <span title={`Works in ${thread.cwd}`} className="grid size-8 place-items-center rounded-lg text-muted">
            <Monitor size={18} />
          </span>
          <DeleteChat id={id} title={thread.title} />
        </div>
      </header>
      {/* aria-busy while an answer streams: a screen reader reads it once it's whole, not each piece. */}
      <div ref={scroller} role="log" aria-label="Messages" aria-busy={busy} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[780px] flex-col gap-3 px-6 py-6">
          {chatItems(msgs ?? [], busy).map((it) =>
            it.teach ? (
              <TeachFix key={`fix-${it.m.id}`} threadId={id} {...failureOf(it.m)} />
            ) : it.m.role === "user" ? (
              <UserBubble key={it.m.id} m={it.m} />
            ) : it.m.role === "assistant" ? (
              <AssistantBubble key={it.m.id} m={it.m} />
            ) : (
              <ApprovalCard key={it.m.id} m={it.m} agent={thread.agent} />
            ),
          )}
          {showTyping && (
            <ThinkingBubble />
          )}
        </div>
      </div>
      {/* key: a draft belongs to its chat; it doesn't follow you into another one. */}
      <Composer key={id} threadId={id} agent={thread.agent} busy={busy} />
    </>
  );
}

/** The chat as a person sees it (2026-11-17, "our user dont need to care what the agent is
 * calling"): what you said, the answers and the cards that need you. The agent's steps (tool calls)
 * aren't shown; Activity lists every one. A turn where a step failed still offers "Teach a fix",
 * after its answer, once the turn is over. */
function chatItems(msgs: Message[], busy: boolean): { m: Message; teach?: true }[] {
  const out: { m: Message; teach?: true }[] = [];
  let failed: Message | null = null;
  for (const m of msgs) {
    if (m.role === "tool") {
      if (m.meta.status === "failed") failed ??= m;
      continue;
    }
    if (m.role === "user" && failed) {
      out.push({ m: failed, teach: true });
      failed = null;
    }
    out.push({ m });
  }
  if (failed && !busy) out.push({ m: failed, teach: true });
  return out;
}

function useAutosize(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [value]);
  return ref;
}

/** What's typed and not sent yet, per chat: it stays with its chat when you open another one and is
 * there again when you come back (until the app quits). */
const drafts = new Map<string, string>();

function Composer({ threadId, agent, busy }: { threadId: string; agent: string; busy: boolean }) {
  const [text, setTextState] = useState(() => drafts.get(threadId) ?? "");
  const setText = (t: string) => {
    setTextState(t);
    if (t) drafts.set(threadId, t);
    else drafts.delete(threadId);
  };
  const ref = useAutosize(text);
  useEffect(() => ref.current?.focus(), [threadId]);
  const go = () => {
    if (!text.trim() || busy) return;
    send(threadId, text);
    setText("");
  };
  return (
    <div className="shrink-0 px-6 pt-1 pb-4">
      <div className="mx-auto max-w-[780px]">
        <div className="flex items-end gap-2 rounded-[26px] border border-line bg-white p-2 shadow-[0_1px_4px_rgba(0,0,0,.05)] focus-within:border-muted/50">
          <textarea
            ref={ref}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                go();
              }
            }}
            aria-label={`Message ${agentName(agent)}`}
            placeholder={`Message ${agentName(agent)}`}
            className="max-h-[200px] min-h-10 flex-1 resize-none bg-transparent px-3 py-2 text-[15px] leading-[1.45] outline-none select-text"
          />
          {busy ? (
            <button onClick={() => call("threads.cancel", { id: threadId }).catch((e) => toast(errorText(e)))} title="Stop" aria-label="Stop" className="grid size-10 shrink-0 place-items-center rounded-full bg-ink text-white hover:bg-black">
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button onClick={go} disabled={!text.trim()} title="Send" aria-label="Send" className="grid size-10 shrink-0 place-items-center rounded-full bg-ink text-white hover:bg-black disabled:bg-muted/40">
              <ArrowUp size={19} strokeWidth={2.4} />
            </button>
          )}
        </div>
        <p className="mt-2 text-center text-[11.5px] text-muted">Dune Bot works on this computer. What it asks about first is set in Permissions.</p>
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  "What's taking the most space in my Downloads folder?",
  "List the apps I installed this month",
  "Make a notes.md here with today's date as the title",
  "Which programs are using the most memory right now?",
];

export function NewChat() {
  const agents = useStore((s) => s.agents);
  const problem = useStore((s) => s.agentsProblem);
  const [agent, setAgent] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [starting, setStarting] = useState(false);
  const ref = useAutosize(text);
  const ready = (agents ?? []).filter((a) => a.installed);
  const picked = agent ?? ready.find((a) => a.id !== "echo")?.id ?? ready[0]?.id ?? null;

  const start = async () => {
    if (!picked || starting) return;
    setStarting(true);
    try {
      await startChat(picked, folder, text);
    } catch (e) {
      toast(errorText(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      <div className="drag h-[56px] shrink-0" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[680px] px-6 pt-4 pb-12">
          <Mascot size={52} />
          <h1 className="mt-5 font-pixel text-[34px] leading-[1.1]">What should we get done on your computer?</h1>
          <p className="mt-1.5 text-[15px] text-muted">Pick who does the work and where. What it asks about first is set in Permissions.</p>

          <h2 className="mt-8 mb-2.5 text-[12px] font-semibold tracking-[.08em] text-muted uppercase">Agent</h2>
          {!agents ? (
            <p data-loading className="text-[14px] text-muted">Looking for agents on this computer…</p>
          ) : (
            // As many columns as fit this window (the screen's width gave 3 cut-off names at 760).
            <div role="group" aria-label="Agent" className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2">
              {agents.map((a) => (
                <button
                  key={a.id}
                  disabled={!a.installed}
                  onClick={() => setAgent(a.id)}
                  aria-pressed={picked === a.id}
                  title={a.problem}
                  className={`flex items-center gap-2.5 rounded-2xl border bg-white px-3 py-2.5 text-left transition ${
                    picked === a.id ? "border-ink ring-1 ring-ink" : "border-line hover:border-muted/50"
                  } disabled:opacity-45`}
                >
                  <AgentAvatar id={a.id} size={30} />
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-semibold">{a.name.replace(/\s*\(test, no AI\)/, "")}</span>
                    <span className="block truncate text-[12px] text-muted">{a.id === "echo" ? "Test, no AI" : a.installed ? "Ready" : "Not installed"}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {problem && (
            <p className="mt-2 text-[12.5px] text-ink">
              {/[.!?]$/.test(problem.trim()) ? problem.trim() : `${problem.trim()}.`}{" "}
              <button className="underline" onClick={loadAgents}>
                Check again
              </button>
            </p>
          )}

          <h2 className="mt-7 mb-2.5 text-[12px] font-semibold tracking-[.08em] text-muted uppercase">Works in</h2>
          <div role="group" aria-label="Works in" className="flex flex-wrap gap-2">
            <button onClick={() => setFolder(null)} aria-pressed={!folder} className={`flex h-10 items-center gap-2 rounded-full border px-4 text-[14px] font-medium ${!folder ? "border-ink ring-1 ring-ink" : "border-line hover:border-muted/50"}`}>
              <FolderPlus size={16} /> A new folder for this chat
            </button>
            <button
              onClick={async () => {
                const f = await window.dunebot.pickFolder();
                if (f) setFolder(f);
              }}
              aria-pressed={!!folder}
              title={folder ?? undefined}
              className={`flex h-10 max-w-full items-center gap-2 rounded-full border px-4 text-[14px] font-medium ${folder ? "border-ink ring-1 ring-ink" : "border-line hover:border-muted/50"}`}
            >
              <FolderOpen size={16} className="shrink-0" />
              <span className="truncate">{folder ? shortPath(folder) : "Choose a folder…"}</span>
            </button>
          </div>

          <div className="mt-7 rounded-[24px] border border-line bg-white p-2 shadow-[0_1px_4px_rgba(0,0,0,.05)] focus-within:border-muted/50">
            <textarea
              ref={ref}
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  start();
                }
              }}
              aria-label="Tell it what to do"
              placeholder="Tell it what to do…"
              className="block max-h-[200px] w-full resize-none bg-transparent px-3 py-2 text-[15px] leading-[1.45] outline-none select-text"
            />
            <div className="flex justify-end px-1 pb-0.5">
              <button onClick={start} disabled={!picked || starting} className="h-10 rounded-full bg-ink px-5 text-[14.5px] font-semibold text-white hover:bg-black disabled:bg-muted/40">
                {starting ? "Starting…" : "Start chat"}
              </button>
            </div>
          </div>

          <h2 className="mt-8 mb-2.5 text-[12px] font-semibold tracking-[.08em] text-muted uppercase">Try</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => (setText(s), ref.current?.focus())} className="rounded-2xl border border-line bg-white px-4 py-3 text-left text-[14px] leading-snug text-ink/85 hover:border-muted/50 hover:bg-side">
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
