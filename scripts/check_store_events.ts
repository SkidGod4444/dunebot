// The card's chat when it opens on a question just asked: the core answers "threads.get" in its own
// task, so that answer can be read before the question was saved and still arrive after the
// question's event. The question must stay (without it the card has nothing it was asked, so it
// never reads the answer and lets a held question go at once: CI, 2026-11-20).
// `bun scripts/check_store_events.ts`
let emit: (m: any) => void = () => {};
const fetches = new Map<string, (r: any) => void>();
(globalThis as any).window = {
  dunebot: {
    platform: "darwin",
    onEvent: (f: (m: any) => void) => (emit = f),
    onNav() {},
    call: (method: string, params?: any) => {
      if (method === "threads.get") return new Promise((r) => fetches.set(params.id, r));
      if (method === "settings.get") return Promise.resolve({ modes: [], prefs: {} });
      return Promise.resolve([]);
    },
  },
};
const { bootCaption, openThread, get } = await import("../ui/src/store");
await bootCaption();

let failed = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)})`}`);
  if (!ok) failed++;
};
const msg = (id: string, threadId: string, role: "user" | "assistant", text = "", status?: string) => ({ id, threadId, role, text, meta: status ? { status } : {}, createdAt: 0 });
const thread = (id: string) => ({ id, title: "", agent: "echo", cwd: "~", createdAt: 0, updatedAt: 0, preview: "" });
const ids = (t: string) => (get().messages[t] ?? []).map((m) => `${m.id}:${m.text}`);
const tick = () => new Promise((r) => setTimeout(r, 0));

// 1. Read before the question was saved, answered after the turn's events.
let opened = openThread("a");
emit({ event: "message.created", message: msg("q1", "a", "user", "What does this say?") });
emit({ event: "turn.started", threadId: "a" });
emit({ event: "message.created", message: msg("r1", "a", "assistant", "", "streaming") });
emit({ event: "message.delta", threadId: "a", messageId: "r1", delta: "It says hello." });
fetches.get("a")!({ thread: thread("a"), messages: [] });
await opened;
check("a late, empty fetch keeps the question and the answer so far", ids("a").join() === "q1:What does this say?,r1:It says hello.", ids("a"));
emit({ event: "message.delta", threadId: "a", messageId: "r1", delta: " Bye." });
check("the answer goes on growing after it", ids("a").join() === "q1:What does this say?,r1:It says hello. Bye.", ids("a"));

// 1b. As CI saw it: the empty fetch lands between the question and the answer. Before, the answer
// showed but the question was gone, so nothing was read and the held question went at once.
opened = openThread("c");
emit({ event: "message.created", message: msg("q3", "c", "user", "Read it to me.") });
fetches.get("c")!({ thread: thread("c"), messages: [] });
await opened;
emit({ event: "message.created", message: msg("r3", "c", "assistant", "", "streaming") });
emit({ event: "message.delta", threadId: "c", messageId: "r3", delta: "First words." });
check("the question is still above the answer", ids("c").join() === "q3:Read it to me.,r3:First words.", ids("c"));

// 2. Read after the question was saved, answered before its event: the event doesn't add it twice.
opened = openThread("b");
fetches.get("b")!({ thread: thread("b"), messages: [msg("q2", "b", "user", "How big?")] });
await opened;
emit({ event: "message.created", message: msg("q2", "b", "user", "How big?") });
emit({ event: "message.created", message: msg("r2", "b", "assistant", "", "streaming") });
emit({ event: "message.delta", threadId: "b", messageId: "r2", delta: "Ten." });
check("a question already fetched isn't added again by its event", ids("b").join() === "q2:How big?,r2:Ten.", ids("b"));

// 3. A chat already here: the fetch still refreshes what it had (an older answer's final words).
opened = openThread("b");
fetches.get("b")!({ thread: thread("b"), messages: [msg("q2", "b", "user", "How big?"), msg("r2", "b", "assistant", "Ten megabytes.", "done")] });
await opened;
await tick();
check("a chat already here is refreshed from the fetch", ids("b").join() === "q2:How big?,r2:Ten megabytes.", ids("b"));

if (failed) {
  console.log(`${failed} FAIL`);
  process.exit(1);
}
console.log("ALL PASS");
