import { useEffect } from "react";
import { CalendarClock, History, Search, Settings, ShieldCheck, Square, SquarePen, Wrench } from "lucide-react";
import { agentName, call, errorText, openThread, set, toast, useStore, type Thread } from "./store";
import { AgentAvatar } from "./parts";
import { plainPreview } from "./reply";
import { Activity } from "./Activity";
import { Fixes } from "./Fixes";
import { Permissions } from "./Permissions";
import { Schedules } from "./Schedules";
import { SettingsPage } from "./Settings";
import { NewChat, ThreadView } from "./chat";
import { when } from "./format";

export function App() {
  const view = useStore((s) => s.view);
  const coreDown = useStore((s) => s.coreDown);
  const toastText = useStore((s) => s.toast);
  // ⌘, (Ctrl+, off the Mac) opens Settings, as in other apps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "," && (window.dunebot.platform === "darwin" ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        set({ view: "settings" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="flex h-full overflow-hidden font-sans text-ink select-none">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col bg-white">
        {coreDown && (
          <div role="alert" className="bg-ink/10 px-4 py-2 text-center text-[13px] font-medium text-ink">
            Dune Bot's core stopped. Restart the app to continue.
          </div>
        )}
        {view === "chat" && <ThreadView />}
        {view === "new" && <NewChat />}
        {view === "permissions" && <Permissions />}
        {view === "settings" && <SettingsPage />}
        {view === "activity" && <Activity />}
        {view === "fixes" && <Fixes />}
        {view === "schedules" && <Schedules />}
        {/* Always there, so a screen reader hears each toast as it comes. */}
        <div role="status" aria-live="polite">
          {toastText && (
            // A long message wraps in a box (a pill grew into a tall oval).
            <div className="pointer-events-none absolute bottom-28 left-1/2 w-max max-w-[min(520px,calc(100%-48px))] -translate-x-1/2 rounded-2xl bg-ink px-4 py-2 text-center text-[13px] leading-snug text-white shadow-lg">
              {toastText}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function Sidebar() {
  const threads = useStore((s) => s.threads);
  const activeId = useStore((s) => s.activeId);
  const view = useStore((s) => s.view);
  const busy = useStore((s) => s.busy);
  const waiting = useStore((s) => s.waiting);
  const query = useStore((s) => s.query);
  const mac = useStore((s) => s.platform) === "darwin";
  const ready = useStore((s) => s.ready);
  const q = query.trim().toLowerCase();
  const shown = q ? threads.filter((t) => (t.title + " " + t.preview).toLowerCase().includes(q)) : threads;
  return (
    <aside className="dm-sidebar flex w-[268px] shrink-0 flex-col border-r border-line bg-side">
      <div className={`drag flex h-[56px] shrink-0 items-center pr-3 ${mac ? "pl-[86px]" : "pl-4"}`}>
        <span className="font-pixel text-[21px] leading-none text-ink">dune bot</span>
        <button
          onClick={() => set({ view: "new", activeId: null })}
          title="New chat"
          aria-label="New chat"
          className="ml-auto grid size-8 place-items-center rounded-lg text-ink/70 hover:bg-black/5 hover:text-ink"
        >
          <SquarePen size={18} />
        </button>
      </div>
      <div className="px-3 pb-2">
        <label className="flex h-9 items-center gap-2 rounded-xl bg-black/[.045] px-3 text-muted focus-within:bg-white focus-within:ring-1 focus-within:ring-line">
          <Search size={15} />
          <input
            value={query}
            onChange={(e) => set({ query: e.target.value })}
            onKeyDown={(e) => e.key === "Escape" && query && set({ query: "" })}
            aria-label="Search chats"
            placeholder="Search chats"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none"
          />
        </label>
      </div>
      <nav aria-label="Chats" className="flex-1 overflow-y-auto px-2 pb-2">
        {shown.map((t) => (
          <ChatRow key={t.id} t={t} active={view === "chat" && t.id === activeId} busy={!!busy[t.id]} waiting={(waiting[t.id] ?? 0) > 0} />
        ))}
        {/* Not before the chats are read: no "No chats yet." flash on start. */}
        {ready && !threads.length && <p className="px-3 pt-6 text-center text-[13px] text-muted">No chats yet.</p>}
        {!!q && !!threads.length && !shown.length && (
          <p role="status" className="px-3 pt-6 text-center text-[13px] text-muted">
            No chats match “{query.trim()}”.
          </p>
        )}
      </nav>
      <StopAll count={Object.values(busy).filter(Boolean).length} />
      <div className="border-t border-line p-2">
        <SideButton icon={<History size={17} />} label="Activity" active={view === "activity"} onClick={() => set({ view: "activity" })} />
        <SideButton icon={<Wrench size={17} />} label="Fixes" active={view === "fixes"} onClick={() => set({ view: "fixes" })} />
        <SideButton icon={<CalendarClock size={17} />} label="Schedules" active={view === "schedules"} onClick={() => set({ view: "schedules" })} />
        <SideButton icon={<ShieldCheck size={17} />} label="Permissions" active={view === "permissions"} onClick={() => set({ view: "permissions" })} />
        <SideButton icon={<Settings size={17} />} label="Settings" active={view === "settings"} onClick={() => set({ view: "settings" })} />
      </div>
    </aside>
  );
}

/** While any chat is working: how many, and one button that stops them all. */
function StopAll({ count }: { count: number }) {
  if (!count) return null;
  return (
    <div className="mx-2 mb-2 flex items-center gap-2 rounded-xl bg-black/[.045] px-3 py-2 text-[13px]">
      <span className="size-2 animate-pulse rounded-full bg-brand" />
      <span className="text-ink">{count === 1 ? "1 chat working" : `${count} chats working`}</span>
      <button
        onClick={() => call("agents.stopAll").catch((e) => toast(errorText(e)))}
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
    <button onClick={onClick} aria-current={active ? "page" : undefined} className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[14px] font-medium ${active ? "bg-white text-ink shadow-[0_1px_2px_rgba(0,0,0,.06)]" : "text-ink/70 hover:bg-black/[.04]"}`}>
      {icon}
      {label}
    </button>
  );
}

function ChatRow({ t, active, busy, waiting }: { t: Thread; active: boolean; busy: boolean; waiting: boolean }) {
  return (
    <button
      onClick={() => openThread(t.id).catch((e) => toast(errorText(e)))}
      aria-current={active ? "page" : undefined}
      className={`mb-0.5 flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left ${active ? "bg-white shadow-[0_1px_2px_rgba(0,0,0,.06)]" : "hover:bg-black/[.04]"}`}
    >
      <AgentAvatar id={t.agent} size={38} dot={waiting ? "waiting" : busy ? "busy" : undefined} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-[14.5px] font-semibold">{t.title}</span>
          <span className="ml-auto shrink-0 text-[12px] text-muted">{when(t.updatedAt)}</span>
        </span>
        <span className={`block truncate text-[13px] ${waiting ? "font-medium text-ink" : "text-muted"}`}>
          {waiting ? "Needs your OK" : busy ? "Working…" : plainPreview(t.preview) || agentName(t.agent)}
        </span>
      </span>
    </button>
  );
}
