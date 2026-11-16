import { useSyncExternalStore } from "react";

export type Thread = {
  id: string;
  title: string;
  agent: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  preview: string;
};

export type Message = {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "tool" | "approval";
  text: string;
  meta: Record<string, any>;
  createdAt: number;
};

export type Agent = { id: string; name: string; installed: boolean; version?: string; problem?: string };
export type ModeRow = { action: string; label: string; mode: "auto" | "always" | "ask" | "never"; choices?: string[] };
export type LedgerRow = { id: number; threadId?: string; action: string; target: string; decision: string; detail: string; at: number };
export type View = "chat" | "new" | "settings" | "activity" | "fixes" | "schedules";
export type Schedule = {
  id: number; title: string; prompt: string; agent: string; cwd?: string; every: "daily" | "weekdays" | "weekly" | "hourly";
  at: number; weekday: number; enabled: boolean; nextRun: number; lastRun?: number; lastThread?: string; createdAt: number;
};
export type Fix = { id: number; threadId?: string; failure: string; detail?: string; fix: string; createdAt: number; enabled: boolean };
export type Voice = {
  state: "idle" | "listening" | "transcribing" | "downloading" | "ready" | "error";
  level: number;
  progress?: number;
  message?: string;
  source?: string;
};

type State = {
  ready: boolean;
  coreDown: boolean;
  platform: string;
  threads: Thread[];
  messages: Record<string, Message[]>;
  busy: Record<string, boolean>;
  waiting: Record<string, number>;
  activeId: string | null;
  view: View;
  agents: Agent[] | null;
  agentsProblem?: string;
  modes: ModeRow[];
  prefs: Record<string, string | null>;
  material: "glass" | "vibrancy" | "none";
  voice: Voice;
  query: string;
  toast?: string;
};

let state: State = {
  ready: false,
  coreDown: false,
  platform: window.dunebot?.platform ?? "darwin",
  threads: [],
  messages: {},
  busy: {},
  waiting: {},
  activeId: null,
  view: "new",
  agents: null,
  modes: [],
  prefs: {},
  material: "none",
  voice: { state: "idle", level: 0 },
  query: "",
};

const subs = new Set<() => void>();
export function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  subs.forEach((f) => f());
}
export const get = () => state;
export function useStore<T>(pick: (s: State) => T): T {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => pick(state),
  );
}

export const call = <T = any>(method: string, params?: Record<string, unknown>): Promise<T> =>
  window.dunebot.call(method, params);

let toastTimer: number | undefined;
export function toast(text: string) {
  set({ toast: text });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => set({ toast: undefined }), 4000);
}

function upsertThread(list: Thread[], t: Thread) {
  return [t, ...list.filter((x) => x.id !== t.id)].sort((a, b) => b.updatedAt - a.updatedAt);
}

function onEvent(m: any) {
  switch (m.event) {
    case "thread.updated":
      set((s) => ({ threads: upsertThread(s.threads, m.thread) }));
      break;
    case "thread.deleted":
      set((s) => ({
        threads: s.threads.filter((t) => t.id !== m.id),
        activeId: s.activeId === m.id ? null : s.activeId,
        view: s.activeId === m.id ? "new" : s.view,
      }));
      break;
    case "message.created": {
      const msg: Message = m.message;
      set((s) => (s.messages[msg.threadId] ? { messages: { ...s.messages, [msg.threadId]: [...s.messages[msg.threadId], msg] } } : {}));
      break;
    }
    case "message.updated": {
      const msg: Message = m.message;
      set((s) => {
        const patch: Partial<State> = {};
        const list = s.messages[msg.threadId];
        if (list) patch.messages = { ...s.messages, [msg.threadId]: list.map((x) => (x.id === msg.id ? msg : x)) };
        if (msg.role === "approval" && msg.meta.status !== "pending")
          patch.waiting = { ...s.waiting, [msg.threadId]: Math.max(0, (s.waiting[msg.threadId] ?? 1) - 1) };
        return patch;
      });
      break;
    }
    case "message.delta":
      set((s) => {
        const list = s.messages[m.threadId];
        if (!list) return {};
        return { messages: { ...s.messages, [m.threadId]: list.map((x) => (x.id === m.messageId ? { ...x, text: x.text + m.delta } : x)) } };
      });
      break;
    case "approval.request":
      set((s) => ({ waiting: { ...s.waiting, [m.threadId]: (s.waiting[m.threadId] ?? 0) + 1 } }));
      break;
    case "turn.started":
      // The caption keeps every turn from its start (so a fast reply can't arrive before it looks).
      set((s) => ({ busy: { ...s.busy, [m.threadId]: true }, ...(trackTurns && !s.messages[m.threadId] ? { messages: { ...s.messages, [m.threadId]: [] } } : {}) }));
      break;
    case "turn.ended":
      set((s) => ({ busy: { ...s.busy, [m.threadId]: false } }));
      break;
    case "voice.state":
      set((s) => ({ voice: { ...s.voice, ...m, level: m.state === "listening" ? s.voice.level : 0 } }));
      break;
    case "voice.level":
      set((s) => (s.voice.state === "listening" ? { voice: { ...s.voice, level: m.level } } : {}));
      break;
    case "prefs.updated":
      set({ prefs: m.prefs });
      break;
    case "chord.keys": // other keys picked in Settings
      set((s) => ({ prefs: { ...s.prefs, "keys.chord": m.name } }));
      break;
    case "core.exit":
      set({ coreDown: true });
      break;
  }
}

type Settings = { modes: ModeRow[]; prefs: Record<string, string | null> };

export async function boot() {
  window.dunebot.onEvent(onEvent);
  window.dunebot.onNav((view) => {
    if (view.startsWith("thread:")) openThread(view.slice(7));
    else set({ view: view as View });
  });
  const [threads, settings] = await Promise.all([call<Thread[]>("threads.list"), call<Settings>("settings.get")]);
  set({ ready: true, threads, modes: settings.modes, prefs: settings.prefs });
  const asked = location.hash.match(/^#main:(.+)$/)?.[1];
  if (asked?.startsWith("thread:")) await openThread(asked.slice(7));
  else if (asked && asked !== "chat") set({ view: asked as View });
  else if (threads[0]) await openThread(threads[0].id);
  loadAgents();
}

/** The bar: no agent scan (that starts codemax); it goes on with its one chat (Bar.tsx). */
export async function bootBar() {
  window.dunebot.onEvent(onEvent);
  const [threads, settings] = await Promise.all([call<Thread[]>("threads.list"), call<Settings>("settings.get")]);
  set({ ready: true, threads, modes: settings.modes, prefs: settings.prefs, view: "chat", activeId: null });
  const last = settings.prefs["bar.thread"];
  if (last && barChatLive({ threads, messages: {}, busy: {}, waiting: {}, prefs: settings.prefs }, last)) await openThread(last);
}

/** The answer beside the pointer: the chats it's asked to show, and your settings (to speak or not). */
let trackTurns = false;
export async function bootCaption() {
  trackTurns = true;
  window.dunebot.onEvent(onEvent);
  const [threads, settings] = await Promise.all([call<Thread[]>("threads.list"), call<Settings>("settings.get")]);
  set({ ready: true, threads, modes: settings.modes, prefs: settings.prefs, view: "chat", activeId: null });
}

/** The keys that tap (open the bar) and hold (talk) on macOS: pref `keys.chord` (⌥⌘ by default). */
export const KEYS = [
  ["opt-cmd", "⌥⌘"],
  ["ctrl-opt", "⌃⌥"],
  ["ctrl-cmd", "⌃⌘"],
  ["right-cmd", "Right ⌘"],
] as const;
export function keysLabel(prefs: Record<string, string | null>) {
  return (KEYS.find(([k]) => k === prefs["keys.chord"]) ?? KEYS[0])[1];
}

/** A bar chat with no question or answer for this long is left; the next question starts a new one. */
export const BAR_IDLE_MS = 60_000;

/** Whether the bar should go on in chat `id`: same agent, and still in use (working, waiting for an
 * OK, or a question or answer in the last minute). */
export function barChatLive(s: Pick<State, "threads" | "messages" | "busy" | "waiting" | "prefs">, id: string | null, now = Date.now()) {
  if (!id) return false;
  const t = s.threads.find((x) => x.id === id);
  if (!t || t.agent !== (s.prefs.agent ?? "claude")) return false;
  if (s.busy[id] || (s.waiting[id] ?? 0) > 0) return true;
  const last = Math.max(t.updatedAt, s.messages[id]?.at(-1)?.createdAt ?? 0);
  return now - last <= BAR_IDLE_MS;
}

export async function sendFromBar(text: string) {
  const s = get();
  let id = barChatLive(s, s.activeId) ? s.activeId : null;
  if (!id) {
    const agent = s.prefs.agent ?? "claude";
    const t = await call<Thread>("threads.create", { agent, cwd: "~" });
    set((st) => ({ threads: upsertThread(st.threads, t), messages: { ...st.messages, [t.id]: [] }, activeId: t.id }));
    const r = await call<{ prefs: Record<string, string | null> }>("prefs.set", { key: "bar.thread", value: t.id });
    set({ prefs: r.prefs });
    id = t.id;
  }
  // Its answer is read aloud and shown beside the pointer: the agent is asked to keep it short.
  return (await send(id, text, true)) ? id : null;
}

export async function loadAgents() {
  const r = await call<{ agents: Agent[]; problem?: string }>("agents.list");
  set({ agents: r.agents, agentsProblem: r.problem });
}

export async function openThread(id: string) {
  set({ activeId: id, view: "chat" });
  const r = await call<{ thread: Thread; messages: Message[] }>("threads.get", { id });
  const waiting = r.messages.filter((x) => x.role === "approval" && x.meta.status === "pending").length;
  set((s) => ({ messages: { ...s.messages, [id]: r.messages }, waiting: { ...s.waiting, [id]: waiting } }));
}

export async function startChat(agent: string, cwd: string | null, firstMessage: string) {
  const t = await call<Thread>("threads.create", { agent, ...(cwd ? { cwd } : {}) });
  set((s) => ({ threads: upsertThread(s.threads, t), messages: { ...s.messages, [t.id]: [] }, activeId: t.id, view: "chat" }));
  if (firstMessage.trim()) await send(t.id, firstMessage);
}

/** False when the core refused it (the toast says why). */
export async function send(threadId: string, text: string, spoken = false) {
  try {
    await call("threads.send", { id: threadId, text, ...(spoken ? { spoken } : {}) });
    return true;
  } catch (e) {
    toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    return false;
  }
}

/** Returns why the answer was refused, or null. */
export async function answer(approvalId: string, decision: "once" | "chat" | "deny"): Promise<string | null> {
  try {
    await call("approvals.respond", { id: approvalId, decision });
    return null;
  } catch (e) {
    const why = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    const text = why.startsWith("too soon") ? "Take a second to read the card first." : "That card was already answered or has expired.";
    toast(text);
    return text;
  }
}

export async function setMode(action: string, mode: string) {
  const r = await call<{ modes: ModeRow[] }>("settings.set", { action, mode });
  set({ modes: r.modes });
}

export const AGENT_LOOK: Record<string, { color: string; short: string }> = {
  claude: { color: "#d9774f", short: "Cl" },
  codex: { color: "#3f8f6b", short: "Cx" },
  cursor: { color: "#4b5563", short: "Cu" },
  opencode: { color: "#6d5ae6", short: "Oc" },
  grok: { color: "#2f6fde", short: "Gk" },
  antigravity: { color: "#c2577f", short: "Ag" },
  copilot: { color: "#7a8696", short: "Co" },
  echo: { color: "#b5a27c", short: "Ec" },
};

export function agentName(id: string) {
  const a = get().agents?.find((x) => x.id === id);
  if (a) return a.name.replace(/\s*\(test, no AI\)/, "");
  return { claude: "Claude Code", codex: "Codex", echo: "Echo" }[id] ?? id;
}
