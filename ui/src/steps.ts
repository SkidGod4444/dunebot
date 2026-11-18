// One plain line for the step an agent is on, shown beside the working dots on the answer card while
// the voice is quiet ("Clicking the address bar", then "Clicked the address bar"). Never what was
// typed, never a card per step.
import type { Message } from "./store";

type Words = { now: string; done: string; failed: string };

const WORDS: Record<string, Words> = {
  look_at_screen: { now: "Looking at your screen", done: "Looked at your screen", failed: "Couldn't see the screen" },
  click: { now: "Clicking", done: "Clicked", failed: "Couldn't click" },
  scroll: { now: "Scrolling", done: "Scrolled", failed: "Couldn't scroll" },
  drag: { now: "Dragging", done: "Dragged", failed: "Couldn't drag" },
  type_text: { now: "Typing into", done: "Typed into", failed: "Couldn't type" },
  press_keys: { now: "Pressing", done: "Pressed", failed: "Couldn't press keys" },
  run_command: { now: "Running a command", done: "Ran a command", failed: "Command didn't run" },
  read_file: { now: "Reading a file", done: "Read a file", failed: "Couldn't read a file" },
  write_file: { now: "Writing a file", done: "Wrote a file", failed: "Didn't write the file" },
  list_folder: { now: "Looking through a folder", done: "Looked through a folder", failed: "Couldn't open a folder" },
  search_chats: { now: "Searching your chats", done: "Searched your chats", failed: "Couldn't search past chats" },
  find_location: { now: "Finding where you are", done: "Found where you are", failed: "Couldn't find where you are" },
};

/** A shortcut as the keyboard shows it: ⇧⌘T on macOS, Ctrl+Shift+T elsewhere (where cmd means Ctrl). */
export function keysShown(raw: string, platform: string): string {
  const mac = platform === "darwin";
  const mods = new Set<string>();
  let key = "";
  for (const p of raw.toLowerCase().split("+").map((s) => s.trim())) {
    if (["cmd", "command", "⌘"].includes(p)) mods.add(mac ? "cmd" : "ctrl");
    else if (["meta", "super", "win", "windows"].includes(p)) mods.add(mac ? "cmd" : "win");
    else if (["ctrl", "control", "⌃"].includes(p)) mods.add("ctrl");
    else if (["option", "opt", "alt", "⌥"].includes(p)) mods.add("option");
    else if (["shift", "⇧"].includes(p)) mods.add("shift");
    else if (p) key = p;
  }
  const k = key.length === 1 ? key.toUpperCase() : key === "enter" || key === "return" ? "Return" : key.charAt(0).toUpperCase() + key.slice(1);
  const order = ["ctrl", "option", "shift", "cmd", "win"].filter((m) => mods.has(m));
  if (mac) return order.map((m) => ({ ctrl: "⌃", option: "⌥", shift: "⇧", cmd: "⌘" })[m] ?? "").join("") + k;
  return [...order.map((m) => ({ ctrl: "Ctrl", option: "Alt", shift: "Shift", win: "Win" })[m] ?? m), k].join("+");
}

/** The line for a step (a tool message), or null when there's nothing to say. */
export function stepLine(m: Message | undefined, platform: string): string | null {
  if (!m || m.role !== "tool") return null;
  const tool = String(m.meta.tool ?? "");
  const w = WORDS[tool];
  const status = m.meta.status === "failed" ? "failed" : m.meta.status === "running" ? "now" : "done";
  if (!w) return status === "now" ? "Working" : null;
  if (status === "failed") return w.failed;
  const args = m.meta.args ?? {};
  let verb = w[status];
  if (tool === "click" && args.button === "right") verb = status === "now" ? "Right-clicking" : "Right-clicked";
  else if (tool === "click" && (args.double === true || Number(args.count) === 2)) verb = status === "now" ? "Double-clicking" : "Double-clicked";
  if (tool === "press_keys" && typeof args.keys === "string" && args.keys.trim()) return `${verb} ${keysShown(args.keys, platform)}`;
  const what = typeof args.what === "string" ? args.what.trim().replace(/\s+/g, " ").slice(0, 80) : "";
  if (["click", "scroll", "drag", "type_text"].includes(tool)) return what ? `${verb} ${what}` : tool === "type_text" ? (status === "now" ? "Typing" : "Typed") : verb;
  return verb;
}
