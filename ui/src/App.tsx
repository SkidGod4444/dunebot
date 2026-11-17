import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, CalendarClock, FolderOpen, FolderPlus, History, Monitor, Play, Search, ShieldCheck, Square, SquarePen, Trash2, Undo2, Wrench } from "lucide-react";
import {
  KEYS, agentName, call, get, keysLabel, loadAgents, openThread, send, set, setMode, startChat, toast, useStore,
  type Fix, type LedgerRow, type Message, type Schedule, type Thread,
} from "./store";
import { AgentAvatar, ApprovalCard, AssistantBubble, failureOf, Mascot, TeachFix, ThinkingBubble, UserBubble } from "./parts";
import { useStickToBottom } from "./stick";
import { plainPreview } from "./reply";

export function App() {
  const view = useStore((s) => s.view);
  const coreDown = useStore((s) => s.coreDown);
  const toastText = useStore((s) => s.toast);
  return (
    <div className="flex h-full overflow-hidden font-sans text-ink select-none">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col bg-white">
        {coreDown && (
          <div className="bg-[#c4553f]/12 px-4 py-2 text-center text-[13px] text-[#d0604a]">Dune Bot's core stopped. Restart the app to continue.</div>
        )}
        {view === "chat" && <ThreadView />}
        {view === "new" && <NewChat />}
        {view === "settings" && <Permissions />}
        {view === "activity" && <Activity />}
        {view === "fixes" && <Fixes />}
        {view === "schedules" && <Schedules />}
        {toastText && (
          <div className="pointer-events-none absolute bottom-28 left-1/2 -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-[13px] text-white shadow-lg">{toastText}</div>
        )}
      </main>
    </div>
  );
}

function when(ms: number) {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

function shortPath(p: string) {
  const m = p.match(/(?:^|[\\/])workspaces[\\/][0-9a-f]{32}$/);
  if (m) return "its own folder";
  return p.replace(/^\/Users\/[^/]+|^\/home\/[^/]+|^[A-Z]:\\Users\\[^\\]+/, "~");
}

function Sidebar() {
  const threads = useStore((s) => s.threads);
  const activeId = useStore((s) => s.activeId);
  const view = useStore((s) => s.view);
  const busy = useStore((s) => s.busy);
  const waiting = useStore((s) => s.waiting);
  const query = useStore((s) => s.query);
  const mac = useStore((s) => s.platform) === "darwin";
  const q = query.trim().toLowerCase();
  const shown = q ? threads.filter((t) => (t.title + " " + t.preview).toLowerCase().includes(q)) : threads;
  return (
    <aside className="dm-sidebar flex w-[268px] shrink-0 flex-col border-r border-line bg-side">
      <div className={`drag flex h-[56px] shrink-0 items-center pr-3 ${mac ? "pl-[86px]" : "pl-4"}`}>
        <span className="font-pixel text-[21px] leading-none text-ink">dune bot</span>
        <button
          onClick={() => set({ view: "new", activeId: null })}
          title="New chat"
          className="ml-auto grid size-8 place-items-center rounded-lg text-ink/70 hover:bg-black/5 hover:text-ink"
        >
          <SquarePen size={18} />
        </button>
      </div>
      <div className="px-3 pb-2">
        <label className="flex h-9 items-center gap-2 rounded-xl bg-black/[.045] px-3 text-muted focus-within:bg-white focus-within:ring-1 focus-within:ring-line">
          <Search size={15} />
          <input value={query} onChange={(e) => set({ query: e.target.value })} placeholder="Search chats" className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none" />
        </label>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {shown.map((t) => (
          <ChatRow key={t.id} t={t} active={view === "chat" && t.id === activeId} busy={!!busy[t.id]} waiting={(waiting[t.id] ?? 0) > 0} />
        ))}
        {!threads.length && <p className="px-3 pt-6 text-center text-[13px] text-muted">No chats yet.</p>}
      </nav>
      <StopAll count={Object.values(busy).filter(Boolean).length} />
      <div className="border-t border-line p-2">
        <SideButton icon={<History size={17} />} label="Activity" active={view === "activity"} onClick={() => set({ view: "activity" })} />
        <SideButton icon={<Wrench size={17} />} label="Fixes" active={view === "fixes"} onClick={() => set({ view: "fixes" })} />
        <SideButton icon={<CalendarClock size={17} />} label="Schedules" active={view === "schedules"} onClick={() => set({ view: "schedules" })} />
        <SideButton icon={<ShieldCheck size={17} />} label="Permissions" active={view === "settings"} onClick={() => set({ view: "settings" })} />
      </div>
    </aside>
  );
}

/** While any chat is working: how many, and one button that stops them all. */
function StopAll({ count }: { count: number }) {
  if (!count) return null;
  return (
    <div className="mx-2 mb-2 flex items-center gap-2 rounded-xl bg-black/[.045] px-3 py-2 text-[13px]">
      <span className="size-2 animate-pulse rounded-full bg-coral" />
      <span className="text-ink">{count === 1 ? "1 chat working" : `${count} chats working`}</span>
      <button
        onClick={() => call("agents.stopAll").catch((e) => toast(String(e.message ?? e)))}
        className="ml-auto flex h-7 items-center gap-1 rounded-full px-2.5 font-medium text-ink hover:bg-black/5"
      >
        <Square size={11} fill="currentColor" />
        {count === 1 ? "Stop" : "Stop all"}
      </button>
    </div>
  );
}

function SideButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[14px] font-medium ${active ? "bg-white text-ink shadow-[0_1px_2px_rgba(0,0,0,.06)]" : "text-ink/70 hover:bg-black/[.04]"}`}>
      {icon}
      {label}
    </button>
  );
}

function ChatRow({ t, active, busy, waiting }: { t: Thread; active: boolean; busy: boolean; waiting: boolean }) {
  return (
    <button
      onClick={() => openThread(t.id)}
      className={`mb-0.5 flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left ${active ? "bg-white shadow-[0_1px_2px_rgba(0,0,0,.06)]" : "hover:bg-black/[.04]"}`}
    >
      <AgentAvatar id={t.agent} size={38} dot={waiting ? "waiting" : busy ? "busy" : undefined} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-[14.5px] font-semibold">{t.title}</span>
          <span className="ml-auto shrink-0 text-[12px] text-muted">{when(t.updatedAt)}</span>
        </span>
        <span className={`block truncate text-[13px] ${waiting ? "font-medium text-[#b9761a]" : "text-muted"}`}>
          {waiting ? "Needs your OK" : busy ? "Working…" : plainPreview(t.preview) || agentName(t.agent)}
        </span>
      </span>
    </button>
  );
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
        r.removed && `moved ${r.removed} new file${r.removed > 1 ? "s" : ""} to the journal`,
      ].filter(Boolean);
      const left = r.skipped.map((s) => `${s.path.split(/[\\/]/).pop()}: ${s.why}`);
      toast(
        (done.length ? `Undone: ${done.join(", ")}.` : "Nothing to undo.") +
          (left.length ? ` Left alone: ${left.slice(0, 2).join("; ")}${left.length > 2 ? ` and ${left.length - 2} more` : ""}.` : ""),
      );
    } catch (e) {
      toast(String((e as Error).message ?? e));
    }
    refresh();
  }
  return (
    <div className="relative">
      <button
        title={`Undo this chat's ${files}`}
        disabled={busy}
        onClick={() => setAsking((a) => !a)}
        className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] text-muted hover:bg-black/5 hover:text-ink disabled:opacity-40"
      >
        <Undo2 size={16} />
        {count}
      </button>
      {asking && (
        <div className="no-drag absolute right-0 top-10 z-20 w-72 rounded-2xl border border-line bg-white p-3.5 text-[13px] shadow-[0_14px_40px_rgba(0,0,0,.16)]">
          <p className="font-medium text-ink">Undo this chat's {files}?</p>
          <p className="mt-1 text-muted">
            Each file goes back to how it was; files the agent created move to the journal. A file you changed since is left
            alone. Commands it ran aren't undone.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => setAsking(false)} className="h-8 rounded-full px-3 text-muted hover:text-ink">
              Cancel
            </button>
            <button onClick={undo} className="h-8 rounded-full bg-ink px-3.5 font-medium text-white hover:bg-black">
              Undo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ThreadView() {
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
          <span title={`Works in ${thread.cwd}`} className="grid size-8 place-items-center rounded-lg text-[#666]">
            <Monitor size={18} />
          </span>
          <button
            title="Delete chat"
            onClick={() => call("threads.delete", { id })}
            className="grid size-8 place-items-center rounded-lg text-muted hover:bg-black/5 hover:text-[#c4553f]"
          >
            <Trash2 size={17} />
          </button>
        </div>
      </header>
      <div
        ref={scroller}
        className="flex-1 overflow-y-auto"
      >
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
      <Composer threadId={id} agent={thread.agent} busy={busy} />
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

function Composer({ threadId, agent, busy }: { threadId: string; agent: string; busy: boolean }) {
  const [text, setText] = useState("");
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
            placeholder={`Message ${agentName(agent)}`}
            className="max-h-[200px] min-h-10 flex-1 resize-none bg-transparent px-3 py-2 text-[15px] leading-[1.45] outline-none select-text"
          />
          {busy ? (
            <button onClick={() => call("threads.cancel", { id: threadId })} title="Stop" className="grid size-10 shrink-0 place-items-center rounded-full bg-ink text-white hover:bg-black">
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button onClick={go} disabled={!text.trim()} title="Send" className="grid size-10 shrink-0 place-items-center rounded-full bg-ink text-white hover:bg-black disabled:bg-muted/40">
              <ArrowUp size={19} strokeWidth={2.4} />
            </button>
          )}
        </div>
        <p className="mt-2 text-center text-[11.5px] text-muted">Dune Bot works on this computer. It asks before anything risky.</p>
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

function NewChat() {
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
      set({ toast: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") });
      setTimeout(() => set({ toast: undefined }), 4000);
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
          <p className="mt-1.5 text-[15px] text-muted">Pick who does the work and where. Dune Bot asks before anything risky.</p>

          <h2 className="mt-8 mb-2.5 text-[12px] font-semibold tracking-[.08em] text-muted uppercase">Agent</h2>
          {!agents ? (
            <p className="text-[14px] text-muted">Looking for agents on this computer…</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {agents.map((a) => (
                <button
                  key={a.id}
                  disabled={!a.installed}
                  onClick={() => setAgent(a.id)}
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
            <p className="mt-2 text-[12.5px] text-[#b9761a]">
              {problem}{" "}
              <button className="underline" onClick={loadAgents}>
                Check again
              </button>
            </p>
          )}

          <h2 className="mt-7 mb-2.5 text-[12px] font-semibold tracking-[.08em] text-muted uppercase">Works in</h2>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setFolder(null)} className={`flex h-10 items-center gap-2 rounded-full border px-4 text-[14px] font-medium ${!folder ? "border-ink ring-1 ring-ink" : "border-line hover:border-muted/50"}`}>
              <FolderPlus size={16} /> A new folder for this chat
            </button>
            <button
              onClick={async () => {
                const f = await window.dunebot.pickFolder();
                if (f) setFolder(f);
              }}
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
              <button key={s} onClick={() => setText(s)} className="rounded-2xl border border-line bg-white px-4 py-3 text-left text-[14px] leading-snug text-ink/85 hover:border-muted/50 hover:bg-side">
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

const MODES = [
  ["auto", "Auto"],
  ["always", "Always"],
  ["ask", "Ask me"],
  ["never", "Never"],
] as const;

const PROTECTED = [
  "SSH and GPG keys",
  "Cloud, git and package-manager logins",
  "Keychains and password stores",
  "Browser profiles and cookies",
  "Messages and Mail data",
  ".env secret files",
  "Dune Bot's own settings and approvals",
];

function Permissions() {
  const modes = useStore((s) => s.modes);
  return (
    <>
      <div className="drag h-[56px] shrink-0" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[640px] px-6 pb-12">
          <h1 className="font-pixel text-[32px] leading-tight">Permissions</h1>
          <p className="mt-1 text-[15px] text-muted">What agents may do on this computer. These apply to every chat.</p>
          <div className="mt-6 divide-y divide-line rounded-2xl border border-line">
            {modes.map((r) => (
              <div key={r.action} className="px-4 py-3.5">
              <div className="flex items-center gap-4">
                <span className="flex-1 text-[15px] font-medium">{r.label}</span>
                <div className="flex rounded-full bg-black/[.05] p-0.5">
                  {MODES.filter(([k]) => (r.choices ?? ["always", "ask", "never"]).includes(k)).map(([k, label]) => (
                    <button
                      key={k}
                      onClick={() => setMode(r.action, k)}
                      className={`h-8 rounded-full px-3.5 text-[13px] font-semibold ${r.mode === k ? "bg-white text-ink shadow-[0_1px_2px_rgba(0,0,0,.1)]" : "text-[#777] hover:text-ink"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {r.mode === "auto" && (
                <p className="mt-1.5 text-[13px] text-muted">
                  Commands run without asking unless they're risky: deleting or saving files, running code, admin, other apps or the screen, sending data online, changing git, installing. Those ask, and the card says why. Scheduled chats always ask. Always: no cards at all.
                </p>
              )}
              {r.action === "look-screen" && r.mode !== "never" && (
                <p className="mt-1.5 text-[13px] text-muted">
                  A picture of the screen under your pointer, when an agent needs to see it. It goes only to that agent; Dune Bot keeps none. Scheduled chats always ask.
                </p>
              )}
              </div>
            ))}
          </div>
          {window.dunebot.platform === "darwin" && (
            <>
              <h2 className="mt-8 mb-2.5 text-[12px] font-semibold tracking-[.08em] text-muted uppercase">Keys</h2>
              <KeySettings />
            </>
          )}
          <h2 className="mt-8 mb-2.5 text-[12px] font-semibold tracking-[.08em] text-muted uppercase">Voice</h2>
          <VoiceSettings />
          <h2 className="mt-8 mb-2.5 text-[12px] font-semibold tracking-[.08em] text-muted uppercase">Always off limits</h2>
          <div className="rounded-2xl bg-side px-4 py-3.5">
            <p className="text-[14px] text-ink/70">Dune Bot's file tools never read or change these, whatever the settings above say:</p>
            <ul className="mt-2 grid gap-1 text-[14px] sm:grid-cols-2">
              {PROTECTED.map((p) => (
                <li key={p} className="flex items-center gap-2">
                  <ShieldCheck size={14} className="shrink-0 text-[#2f9e62]" />
                  {p}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[13px] text-[#b9761a]">A command you allow runs with your full access and can reach these. Read command cards before you allow them.</p>
          </div>
        </div>
      </div>
    </>
  );
}

/** The keys that tap (open the bar) and hold (talk) on macOS. */
function KeySettings() {
  const prefs = useStore((s) => s.prefs);
  const now = keysLabel(prefs);
  const pick = async (value: string) => {
    const r = await call<{ prefs: Record<string, string | null> }>("prefs.set", { key: "keys.chord", value });
    set({ prefs: r.prefs });
  };
  return (
    <div className="rounded-2xl border border-line px-4 py-3.5">
      <div className="flex items-center gap-4">
        <span className="flex-1 text-[15px] font-medium">Tap to ask, hold to talk</span>
        <div className="flex rounded-full bg-black/[.05] p-0.5">
          {KEYS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => pick(k)}
              className={`h-8 rounded-full px-3.5 text-[13px] font-semibold ${now === label ? "bg-white text-ink shadow-[0_1px_2px_rgba(0,0,0,.1)]" : "text-[#777] hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
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
  const pick = async (value: "sarvam" | "local") => {
    const r = await call<{ prefs: Record<string, string | null> }>("prefs.set", { key: "voice.engine", value });
    set({ prefs: r.prefs });
  };
  const sarvam = engine === "sarvam" && !!st?.saved;
  const american = engine === "sarvam" && !!dg?.saved;
  return (
    <div className="divide-y divide-line rounded-2xl border border-line">
      <div className="px-4 py-3.5">
        <div className="flex items-center gap-4">
          <span className="flex-1 text-[15px] font-medium">Listening and reading aloud</span>
          <div className="flex rounded-full bg-black/[.05] p-0.5">
            {([["sarvam", "Sarvam AI"], ["local", "This computer"]] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => pick(k)}
                className={`h-8 rounded-full px-3.5 text-[13px] font-semibold ${engine === k ? "bg-white text-ink shadow-[0_1px_2px_rgba(0,0,0,.1)]" : "text-[#777] hover:text-ink"}`}
              >
                {label}
              </button>
            ))}
          </div>
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
  useEffect(() => {
    api.status().then(show, () => {});
  }, []);
  const run = async (f: () => Promise<SarvamStatus>) => {
    setSaving(true);
    setProblem("");
    try {
      show(await f());
      setKey("");
    } catch (e) {
      setProblem((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
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
            <span className="text-[13px] text-[#2f9e62]">Saved, locked by your keychain</span>
            <button onClick={() => run(api.remove)} disabled={saving} className="h-8 rounded-full px-3 text-[13px] font-semibold text-[#c4453c] hover:bg-black/[.05]">
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
            placeholder={placeholder}
            className="h-9 min-w-0 flex-1 rounded-full border border-line bg-transparent px-3.5 text-[14px] outline-none placeholder:text-muted"
          />
          <button disabled={!key.trim() || saving} className="h-9 rounded-full bg-ink px-4 text-[13.5px] font-semibold text-white hover:bg-black disabled:bg-muted/40">
            Save
          </button>
        </form>
      )}
      {st && !st.saved && !st.canSave && (
        <p className="mt-1.5 text-[13px] text-[#b9761a]">This computer has no keychain to lock a key with, so Dune Bot won't keep one.</p>
      )}
      {problem && <p className="mt-1.5 text-[13px] text-[#c4453c]">{problem}</p>}
    </div>
  );
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const clock = (at: number) => new Date(2000, 0, 1, Math.floor(at / 60), at % 60).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function repeatText(s: Pick<Schedule, "every" | "at" | "weekday">) {
  if (s.every === "hourly") return `Every hour at :${String(s.at % 60).padStart(2, "0")}`;
  if (s.every === "weekly") return `Every ${DAYS[s.weekday]} at ${clock(s.at)}`;
  return `${s.every === "weekdays" ? "Weekdays" : "Every day"} at ${clock(s.at)}`;
}
const folderName = (p?: string) => (p ? p.split(/[\\/]/).filter(Boolean).pop() : "its own folder");

/** Prompts that start a new chat at set times. Runs ask like any chat; nothing is approved for them. */
function Schedules() {
  const [rows, setRows] = useState<Schedule[] | null>(null);
  const agents = useStore((s) => s.agents);
  const prefAgent = useStore((s) => s.prefs.agent);
  const chats = useStore((s) => s.threads.length); // a run makes a chat: reload then
  const installed = (agents ?? []).filter((a) => a.installed);
  const [prompt, setPrompt] = useState("");
  const [agent, setAgent] = useState("");
  const [every, setEvery] = useState<Schedule["every"]>("weekdays");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState(1);
  const [cwd, setCwd] = useState<string | undefined>();
  const load = () => call<Schedule[]>("schedules.list").then(setRows).catch(() => setRows([]));
  useEffect(() => {
    if (!agents) loadAgents();
  }, []);
  useEffect(() => {
    load();
  }, [chats]);
  const chosen = agent || (installed.find((a) => a.id === prefAgent) ?? installed[0])?.id || "";
  const [h, m] = time.split(":").map(Number);
  const at = every === "hourly" ? m || 0 : (h || 0) * 60 + (m || 0);
  const act = (p: Promise<unknown>) => p.then(load).catch((e) => toast(String(e.message ?? e)));
  async function add() {
    if (!prompt.trim() || !chosen) return;
    await act(call("schedules.add", { prompt, agent: chosen, every, at, weekday, cwd }));
    setPrompt("");
  }
  const field = "h-9 rounded-full border border-line bg-white px-3 text-[13.5px] outline-none hover:border-muted/50";
  return (
    <>
      <div className="drag h-[56px] shrink-0" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-6 pb-12">
          <h1 className="font-pixel text-[32px] leading-tight">Schedules</h1>
          <p className="mt-1 text-[15px] text-muted">
            Each run starts a new chat with your words. It asks before every command and file change, even where Permissions
            says Always. If a card is still waiting when the next time comes, that run is skipped. Dune Bot must be open.
          </p>
          <div className="mt-6 rounded-2xl border border-line p-3">
            <textarea
              rows={2}
              value={prompt}
              maxLength={4000}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should the agent do? e.g. List what changed in ~/notes since yesterday"
              className="w-full resize-none bg-transparent px-1 py-1 text-[14.5px] outline-none placeholder:text-muted select-text"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select value={every} onChange={(e) => setEvery(e.target.value as Schedule["every"])} className={`${field} w-34`}>
                <option value="daily">Every day</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Every week</option>
                <option value="hourly">Every hour</option>
              </select>
              {every === "weekly" && (
                <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} className={`${field} w-34`}>
                  {DAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              )}
              {every === "hourly" ? (
                <select value={String(m || 0)} onChange={(e) => setTime(`00:${e.target.value.padStart(2, "0")}`)} className={`${field} w-32`}>
                  {[0, 15, 30, 45].map((x) => (
                    <option key={x} value={x}>
                      at :{String(x).padStart(2, "0")}
                    </option>
                  ))}
                </select>
              ) : (
                <input type="time" value={time} onChange={(e) => setTime(e.target.value || "09:00")} className={`${field} w-32`} />
              )}
              <select value={chosen} onChange={(e) => setAgent(e.target.value)} className={`${field} w-44`}>
                {!installed.length && <option value="">No agents found</option>}
                {installed.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <button
                title={cwd ?? "Runs in a new folder of its own each time"}
                onClick={async () => setCwd((await window.dunebot.pickFolder()) ?? undefined)}
                className={`${field} flex w-40 items-center gap-1.5`}
              >
                <FolderOpen size={14} className="shrink-0 text-muted" />
                <span className="truncate">{cwd ? folderName(cwd) : "Its own folder"}</span>
              </button>
              <button disabled={!prompt.trim() || !chosen} onClick={add} className="ml-auto h-9 rounded-full bg-ink px-4 text-[13.5px] font-medium text-white hover:bg-black disabled:opacity-40">
                Add schedule
              </button>
            </div>
          </div>
          <div className="mt-4 divide-y divide-line rounded-2xl border border-line">
            {rows?.length === 0 && <p className="px-4 py-6 text-center text-[14px] text-muted">No schedules yet.</p>}
            {rows?.map((s) => (
              <div key={s.id} className={`flex items-start gap-3 px-4 py-3 ${s.enabled ? "" : "opacity-55"}`}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14.5px] font-medium text-ink select-text" title={s.prompt}>
                    {s.title}
                  </p>
                  <p className="mt-0.5 truncate text-[12.5px] text-muted" title={s.cwd}>
                    {repeatText(s)} · {agentName(s.agent)} · {folderName(s.cwd)}
                  </p>
                  <p className="mt-1 text-[12px] tabular-nums text-muted">
                    {s.enabled ? `Next: ${new Date(s.nextRun).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "Off"}
                    {s.lastRun && s.lastThread && (
                      <>
                        {" · "}
                        <button onClick={() => openThread(s.lastThread!)} className="underline-offset-2 hover:text-ink hover:underline">
                          last run {when(s.lastRun)}
                        </button>
                      </>
                    )}
                  </p>
                </div>
                <button
                  title="Run it now"
                  onClick={() => act(call<{ threadId: string }>("schedules.run", { id: s.id }).then((r) => openThread(r.threadId)))}
                  className="flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium text-muted hover:bg-black/5 hover:text-ink"
                >
                  <Play size={12} fill="currentColor" /> Run now
                </button>
                <button
                  role="switch"
                  aria-checked={s.enabled}
                  title={s.enabled ? "On" : "Off"}
                  onClick={() => act(call("schedules.set", { id: s.id, enabled: !s.enabled }))}
                  className={`mt-0.5 flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors ${s.enabled ? "bg-[#2f9e62]" : "bg-black/15"}`}
                >
                  <span className={`size-5 rounded-full bg-white shadow transition-transform ${s.enabled ? "translate-x-4" : ""}`} />
                </button>
                <button
                  title="Delete this schedule"
                  onClick={() => act(call("schedules.delete", { id: s.id }))}
                  className="grid size-7 shrink-0 place-items-center rounded-lg text-muted hover:bg-black/5 hover:text-ink"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

/** Every failure with the user's fix for it. Switched-on fixes are notes agents read. */
function Fixes() {
  const [rows, setRows] = useState<Fix[] | null>(null);
  const [text, setText] = useState("");
  const threads = useStore((s) => s.threads);
  const load = () => call<Fix[]>("fixes.list").then(setRows).catch(() => setRows([]));
  useEffect(() => {
    load();
  }, []);
  const act = (p: Promise<unknown>) => p.then(load).catch((e) => toast(String(e.message ?? e)));
  async function add() {
    if (!text.trim()) return;
    await act(call("fixes.add", { fix: text }));
    setText("");
  }
  return (
    <>
      <div className="drag h-[56px] shrink-0" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-6 pb-12">
          <h1 className="font-pixel text-[32px] leading-tight">Fixes</h1>
          <p className="mt-1 text-[15px] text-muted">
            When an agent gets something wrong, press "Teach a fix" under it. Agents read the fixes that are on: every new chat
            gets all of them. Fixes never change what agents may do; that's Permissions.
          </p>
          <div className="mt-6 flex items-end gap-2 rounded-2xl border border-line p-2 pl-4">
            <textarea
              rows={1}
              value={text}
              maxLength={500}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder="Add a fix of your own, e.g. Use bun, never npm"
              className="min-h-9 flex-1 resize-none bg-transparent py-2 text-[14px] outline-none placeholder:text-muted select-text"
            />
            <button disabled={!text.trim()} onClick={add} className="h-9 rounded-full bg-ink px-4 text-[13.5px] font-medium text-white hover:bg-black disabled:opacity-40">
              Add
            </button>
          </div>
          <div className="mt-4 divide-y divide-line rounded-2xl border border-line">
            {rows?.length === 0 && <p className="px-4 py-6 text-center text-[14px] text-muted">No fixes yet.</p>}
            {rows?.map((f) => {
              const chat = f.threadId ? threads.find((t) => t.id === f.threadId) : undefined;
              return (
                <div key={f.id} className={`flex items-start gap-3 px-4 py-3 ${f.enabled ? "" : "opacity-55"}`}>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14.5px] font-medium text-ink select-text">{f.fix}</p>
                    <p className="mt-0.5 truncate text-[12.5px] text-muted select-text" title={[f.failure, f.detail].filter(Boolean).join("\n")}>
                      {f.failure}
                      {f.detail && <span className="font-mono text-[11.5px]"> · {f.detail}</span>}
                    </p>
                    <p className="mt-1 text-[12px] tabular-nums text-muted">
                      {when(f.createdAt)}
                      {chat && (
                        <>
                          {" · "}
                          <button onClick={() => openThread(chat.id)} className="underline-offset-2 hover:text-ink hover:underline">
                            {chat.title}
                          </button>
                        </>
                      )}
                    </p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={f.enabled}
                    title={f.enabled ? "On: agents read it" : "Off: agents don't see it"}
                    onClick={() => act(call("fixes.set", { id: f.id, enabled: !f.enabled }))}
                    className={`mt-0.5 flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors ${f.enabled ? "bg-[#2f9e62]" : "bg-black/15"}`}
                  >
                    <span className={`size-5 rounded-full bg-white shadow transition-transform ${f.enabled ? "translate-x-4" : ""}`} />
                  </button>
                  <button
                    title="Delete this fix"
                    onClick={() => act(call("fixes.delete", { id: f.id }))}
                    className="grid size-7 shrink-0 place-items-center rounded-lg text-muted hover:bg-black/5 hover:text-ink"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

function Activity() {
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  useEffect(() => {
    call<LedgerRow[]>("ledger.list").then(setRows);
  }, []);
  const tone = (d: string) =>
    d.startsWith("declined") || d.startsWith("blocked") || d === "no answer" ? "bg-[#c4553f]/12 text-[#d0604a]" : d.startsWith("approved") || d.startsWith("allowed") ? "bg-[#2f9e62]/12 text-[#2f9e62]" : "bg-black/[.05] text-ink/70";
  return (
    <>
      <div className="drag h-[56px] shrink-0" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-6 pb-12">
          <h1 className="font-pixel text-[32px] leading-tight">Activity</h1>
          <p className="mt-1 text-[15px] text-muted">Everything agents did or tried to do, newest first.</p>
          <div className="mt-6 divide-y divide-line rounded-2xl border border-line">
            {rows?.length === 0 && <p className="px-4 py-6 text-center text-[14px] text-muted">Nothing yet.</p>}
            {rows?.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="w-16 shrink-0 text-[12px] text-muted">{when(r.at)}</span>
                <span className="w-24 shrink-0 text-[13px] font-medium">{r.action}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink/70 select-text" title={r.target}>
                  {r.target}
                </code>
                <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[12px] font-medium ${tone(r.decision)}`}>{r.decision}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

