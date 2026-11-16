// The bar's one chat: it goes on while in use and is left after a minute with no question or answer.
// `bun scripts/check_bar_chat.ts`
(globalThis as any).window = { dunebot: { platform: "darwin", onEvent() {}, call: async () => ({}) } };
const { barChatLive, BAR_IDLE_MS } = await import("../ui/src/store");

const now = 1_000_000_000;
const thread = (updatedAt: number, agent = "claude") => ({ id: "t", title: "", agent, cwd: "~", createdAt: 0, updatedAt, preview: "" });
const msg = (createdAt: number) => ({ id: "m", threadId: "t", role: "assistant" as const, text: "", meta: {}, createdAt });
const base = { messages: {}, busy: {}, waiting: {}, prefs: { agent: "claude" } };
let failed = 0;
const check = (name: string, got: boolean, want: boolean) => {
  console.log(`${got === want ? "PASS" : "FAIL"} ${name}`);
  if (got !== want) failed++;
};
check("asked 10 s ago: same chat", barChatLive({ ...base, threads: [thread(now - 10_000)] }, "t", now), true);
check("exactly a minute: same chat", barChatLive({ ...base, threads: [thread(now - BAR_IDLE_MS)] }, "t", now), true);
check("61 s quiet: new chat", barChatLive({ ...base, threads: [thread(now - 61_000)] }, "t", now), false);
check("an hour quiet: new chat", barChatLive({ ...base, threads: [thread(now - 3_600_000)] }, "t", now), false);
check("answer arrived 5 s ago (chat list older): same chat", barChatLive({ ...base, threads: [thread(now - 120_000)], messages: { t: [msg(now - 5_000)] } }, "t", now), true);
check("still working after 5 min: same chat", barChatLive({ ...base, threads: [thread(now - 300_000)], busy: { t: true } }, "t", now), true);
check("waiting for an OK after 5 min: same chat", barChatLive({ ...base, threads: [thread(now - 300_000)], waiting: { t: 1 } }, "t", now), true);
check("another agent picked: new chat", barChatLive({ ...base, threads: [thread(now, "codex")] }, "t", now), false);
check("chat deleted: new chat", barChatLive({ ...base, threads: [] }, "t", now), false);
check("no chat yet: new chat", barChatLive({ ...base, threads: [] }, null, now), false);

// Said while the answer was still coming: asked once it has ended and been read (ui/src/held.ts).
const { hold, afterTurn, cardDone, readWaitOver } = await import("../ui/src/held");
let h = hold(null, "t", "and the size?");
h = hold(h, "t", "in megabytes");
const q = "and the size? in megabytes";
check("said twice mid-answer: one question", h?.text === q, true);
check("another chat's answer ends: still held", afterTurn(h, "other", "done", "t").held === h, true);
let r = afterTurn(h, "t", "done", "t");
check("the answer ends while being read: waits", !r.send && !r.box && !!r.held?.ended, true);
r = cardDone(r.held, "t");
check("then the card is done reading: asked", r.send === q && r.held === null, true);
r = cardDone(h, "t");
check("card done first (nothing to read): waits for the end", !r.send && !!r.held?.read, true);
r = afterTurn(r.held, "t", "done", "t");
check("then the answer ends: asked at once", r.send === q, true);
r = afterTurn(cardDone(h, "t").held, "t", "error", "t");
check("the answer failed: still asked", r.send === q, true);
r = afterTurn(h, "t", "cancelled", "t");
check("the answer was stopped: in the box, not sent", r.box === q && !r.send, true);
r = cardDone(afterTurn(h, "t", "done", "t").held, "new");
check("the bar moved to another chat: in the box, not sent", r.box === q && !r.send, true);
check("the card never says done: asked after the wait", readWaitOver(afterTurn(h, "t", "done", "t").held, "t").send === q, true);
check("the wait ends before the answer: still held", readWaitOver(h, "t").held === h, true);
check("nothing held: nothing to do", JSON.stringify(afterTurn(null, "t", "done", "t")) + JSON.stringify(cardDone(null, "t")) === JSON.stringify({ held: null }).repeat(2), true);
check("said in a new chat after one held: replaces it", hold(h, "u", "hi")?.text === "hi", true);
check("said again after the card was done: still done", !!hold(cardDone(h, "t").held, "t", "too")?.read, true);
console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
