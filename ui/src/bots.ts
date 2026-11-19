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

/** What each action lets a bot do, in a few words (the keys are the core's, core/src/policy.rs). */
export const MAY: [string, string][] = [
  ["run-command", "Run commands"],
  ["write-file", "Change files"],
  ["read-file", "Read files"],
  ["list-folder", "Look in folders"],
  ["search-chats", "Search chats"],
  ["look-screen", "See the screen"],
  ["click", "Click"],
  ["type", "Type"],
  ["find-location", "Location"],
];
