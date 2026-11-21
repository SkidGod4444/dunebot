import { useSyncExternalStore } from "react";

/** One of the user's own bots, as the core lists it (core/src/team.rs). */
export type Bot = { id: string; name: string; role: string; engine: string; may: string[]; createdAt: number; updatedAt: number };

let bots: Bot[] = [];
const subs = new Set<() => void>();
function setBots(list: Bot[]) {
  bots = list;
  subs.forEach((f) => f());
}

/** Asks the core for the bots (cheap: no agent starts). Every window loads them as it boots. */
export async function loadBots() {
  try {
    const r = await window.dunebot.call("bots.list");
    setBots(r?.bots ?? []);
  } catch {}
}

// The core says when bots are added, changed or deleted (from any window).
window.dunebot?.onEvent((m) => {
  if (m?.event === "bots.changed") setBots(m.bots ?? []);
});

export function useBots(): Bot[] {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => bots,
  );
}

export const botOf = (id: string) => (id.startsWith("bot-") ? bots.find((b) => b.id === id) : undefined);

/** A bot's two letters on its grey badge: "Writer" Wr, "Deep Research" DR. */
export function botShort(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0] ?? "?";
  return w.slice(0, 1).toUpperCase() + w.slice(1, 2).toLowerCase();
}

/** The badge for a chat's agent id, when it's a bot. */
export function botLook(id: string) {
  const b = botOf(id);
  return b ? { short: botShort(b.name) } : undefined;
}

/** What each action lets a bot do, in a few words: every action of the core's (core/src/policy.rs
 * Action::ALL, in its order), so a bot can be given any of them. The account changes are their own
 * group: their reads follow the chat as for any chat (only when you ask). */
export const MAY: [string, string][] = [
  ["run-command", "Run commands"],
  ["write-file", "Change files"],
  ["read-file", "Read files"],
  ["list-folder", "Look in folders"],
  ["search-chats", "Search chats"],
  ["look-screen", "See the screen"],
  ["point", "Point on screen"],
  ["click", "Click"],
  ["type", "Type"],
  ["find-location", "Location"],
];
export const MAY_ACCOUNTS: [string, string][] = [
  ["slack-write", "Slack"],
  ["gmail-write", "Gmail"],
  ["notion-write", "Notion"],
  ["calendar-write", "Calendar"],
  ["x-post", "Post on X"],
];
/** What a new bot starts with: everything on this computer, no changes in your accounts (sending,
 * posting, editing), so a bot never sends or posts until you switch that on for it. */
export const MAY_NEW = MAY.map(([k]) => k);
/** Every action a bot may be given (the core checks the same list: team.rs, policy.rs). */
export const MAY_ALL: [string, string][] = [...MAY, ...MAY_ACCOUNTS];

/** One line for a bot's row: everything, nothing, or whichever list is shorter (what it may, or may not, do). */
export function mayText(may: string[]) {
  const label = (k: string) => {
    const [key, l] = MAY_ALL.find(([x]) => x === k) ?? [k, k];
    return MAY_ACCOUNTS.some(([x]) => x === key) && key !== "x-post" ? `change ${l}` : l[0].toLowerCase() + l.slice(1);
  };
  const yes = MAY_ALL.filter(([k]) => may.includes(k)).map(([k]) => k);
  const no = MAY_ALL.filter(([k]) => !may.includes(k)).map(([k]) => k);
  if (!no.length) return "May do what Permissions allows";
  if (no.length === MAY_ACCOUNTS.length && MAY_ACCOUNTS.every(([k]) => no.includes(k))) return "May do what Permissions allows on this computer; no account changes";
  if (!yes.length) return "Only answers and hands over";
  return no.length < yes.length ? `May do all but: ${no.map(label).join(", ")}` : `May: ${yes.map(label).join(", ")}`;
}
