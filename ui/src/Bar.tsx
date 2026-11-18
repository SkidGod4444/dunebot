import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Maximize2, Mic, Plus, Square } from "lucide-react";
import { AGENT_LOOK, agentName, barChatLive, call, get, keysLabel, openThread, sendFromBar, set, toast as showToast, useStore, type Agent } from "./store";
import { Mascot, Typing } from "./parts";
import { afterTurn, cardDone, hold, READ_WAIT_MS, readWaitOver, type Held, type Step } from "./held";

const mac = window.dunebot.platform === "darwin";

/** Dune Bot's spark, small, for the bar. */
/** Dune Bot's own logo at the bar's start; it pulses while the chat works. */
function Logo({ busy }: { busy?: boolean }) {
  return (
    <span className={`block overflow-hidden rounded-[6px] ${busy ? "animate-pulse" : ""}`}>
      <Mascot size={22} />
    </span>
  );
}

/** Live microphone level as five bars. */
function Level({ level }: { level: number }) {
  return (
    <span className="inline-flex h-5 items-center gap-[3px]" aria-hidden>
      {[0.55, 0.85, 1, 0.8, 0.5].map((w, i) => (
        <span
          key={i}
          className="w-[3px] rounded-full bg-brand transition-[height] duration-75"
          style={{ height: `${Math.max(4, Math.round(20 * Math.min(1, level * 1.6) * w))}px` }}
        />
      ))}
    </span>
  );
}


/** Sent: the bar closes and the answer shows beside the pointer (Caption.tsx). Refused: the bar
 * stays open with the reason under it, and what you asked goes back in the box. */
async function ask(text: string, putBack: (t: string) => void) {
  const id = await sendFromBar(text);
  if (id) window.dunebot.bar.sent(id);
  else {
    putBack(text);
    window.dunebot.bar.open();
  }
}

/**
 * The bar is only where you ask: type (tap ⌥⌘) or talk (hold ⌥⌘, or the mic button). There's no
 * conversation in it; the answer appears beside the pointer and is read aloud, and the whole chat
 * is in Chats.
 */
export function Bar() {
  const ready = useStore((s) => s.ready);
  const coreDown = useStore((s) => s.coreDown);
  const material = useStore((s) => s.material);
  const voice = useStore((s) => s.voice);
  const activeId = useStore((s) => s.activeId);
  const thread = useStore((s) => s.threads.find((t) => t.id === s.activeId));
  const busy = useStore((s) => (s.activeId ? s.busy[s.activeId] : false));
  const prefAgent = useStore((s) => s.prefs.agent) ?? "claude";
  const toast = useStore((s) => s.toast);
  const [text, setText] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const input = useRef<HTMLTextAreaElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const outer = useRef<HTMLDivElement>(null);
  const holding = useRef(false);
  const held = useRef<Held>(null);
  const readWait = useRef(0);
  // Words for the box (added to whatever is typed there), with the bar open on them.
  const putInBox = (said: string) => {
    setText((t) => (t.trim() ? `${t.trim()} ${said}` : said));
    window.dunebot.bar.open();
    input.current?.focus();
  };

  const glassy = material !== "none";
  const agent = thread?.agent ?? prefAgent;
  const listening = voice.state === "listening";
  const transcribing = voice.state === "transcribing";

  // Just the input row: a capsule, like Spotlight. With a note under it: a card.
  const showFooter = !!toast || voice.state === "downloading" || (voice.state === "error" && !!voice.message);
  const [cardHeight, setCardHeight] = useState(60);
  // Capped at 30: a taller input stays a rounded rectangle instead of a growing pill.
  const radius = showFooter ? 24 : Math.min(30, Math.round(cardHeight / 2));

  // The window follows the content's height; the native glass follows the card's shape.
  useLayoutEffect(() => {
    const el = outer.current;
    const c = card.current;
    if (!el || !c) return;
    const ro = new ResizeObserver(() => {
      window.dunebot.bar.resize(el.getBoundingClientRect().height);
      setCardHeight(c.getBoundingClientRect().height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const sentRadius = useRef(0);
  useEffect(() => {
    if (material === "glass" && sentRadius.current !== radius) {
      sentRadius.current = radius;
      window.dunebot.glassRadius(radius);
    }
  }, [radius, material]);

  useEffect(() => {
    const focus = () => {
      input.current?.focus();
      input.current?.select();
    };
    focus();
    // What you ask from the bar goes on in one chat (the card shows only its latest answer). A new chat
    // after a minute with no question or answer, with "+", another agent, or when that chat was deleted.
    const freshen = () => {
      const s = get();
      if (s.activeId && !barChatLive(s, s.activeId)) set({ activeId: null });
    };
    const offFocus = window.dunebot.bar.onFocus((opts) => {
      if (opts?.fresh !== false) freshen();
      focus();
    });
    const offThread = window.dunebot.bar.onThread((id) => {
      if (get().activeId !== id) openThread(id);
    });
    // What you said: sent as a message, never as an answer to a card, and never into a busy turn:
    // said while the answer is still coming, it's asked once that answer has ended and been read
    // aloud (held.ts).
    const apply = (r: Step) => {
      if (r.held === held.current) return;
      held.current = r.held;
      if (r.held?.ended && !readWait.current) {
        readWait.current = window.setTimeout(() => {
          readWait.current = 0;
          apply(readWaitOver(held.current, get().activeId));
        }, READ_WAIT_MS);
      }
      if (r.held) return;
      window.clearTimeout(readWait.current);
      readWait.current = 0;
      window.dunebot.bar.held(null);
      if (r.send) ask(r.send, putInBox);
      else if (r.box) {
        putInBox(r.box);
        showToast("That answer stopped. What you said is in the box; press ↩ to send it.");
      }
    };
    const offCardDone = window.dunebot.bar.onCardDone(() => apply(cardDone(held.current, get().activeId)));
    const offEvent = window.dunebot.onEvent((m) => {
      if (m.event === "voice.state" && m.state === "listening") freshen();
      if (m.event === "turn.ended") return apply(afterTurn(held.current, String(m.threadId), String(m.status), get().activeId));
      if (m.event === "core.exit" && held.current) {
        const said = held.current.text;
        apply({ held: null, box: said });
        return;
      }
      if (m.event !== "voice.transcript") return;
      const said = String(m.text ?? "").trim();
      if (!said) {
        if (m.note) showToast(m.note);
        return;
      }
      const s = get();
      const id = s.activeId;
      const occupied = id && (s.busy[id] || (s.waiting[id] ?? 0) > 0);
      if (occupied) {
        held.current = hold(held.current, id, said);
        window.dunebot.bar.held(held.current);
        return;
      }
      if (input.current?.value.trim()) {
        putInBox(said);
        showToast("Added to what you typed.");
      } else {
        ask(said, setText);
      }
    });
    window.dunebot.bar.agents().then(setAgents).catch(() => {});
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (["listening", "transcribing"].includes(get().voice.state)) call("voice.cancel");
      else window.dunebot.bar.hide();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      offFocus();
      offThread();
      offEvent();
      offCardDone();
      window.clearTimeout(readWait.current);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  async function submit() {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    await ask(t, setText);
  }

  async function pickAgent(id: string) {
    const r = await call<{ prefs: Record<string, string | null> }>("prefs.set", { key: "agent", value: id });
    set({ prefs: r.prefs });
    if (thread && thread.agent !== id) set({ activeId: null });
    input.current?.focus();
  }

  // Hold-to-talk button (every system; on macOS holding ⌥⌘ does the same).
  async function talkStart(e: React.PointerEvent) {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    holding.current = true;
    try {
      await call("voice.start", { source: "button" });
      if (!holding.current) call("voice.stop"); // released before the mic opened
    } catch (err) {
      holding.current = false;
      showToast((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  }
  function talkEnd() {
    if (!holding.current) return;
    holding.current = false;
    call("voice.stop");
  }

  const installed = agents.filter((a) => a.installed);
  const keys = useStore((s) => keysLabel(s.prefs));
  const look = AGENT_LOOK[agent] ?? { short: agent.slice(0, 2) };
  const hint = listening
      ? "release to send · esc cancel"
      : mac
        ? `↩ send · hold ${keys} to talk`
        : "↩ send · hold the mic button to talk";

  return (
    <div ref={outer} className={glassy ? "" : "p-3"}>
      <div
        ref={card}
        style={{ borderRadius: radius }}
        className={`dm-card overflow-hidden ${glassy ? "bg-transparent" : "bg-white shadow-[0_14px_40px_rgba(0,0,0,.20),0_0_0_1px_rgba(0,0,0,.07)]"}`}
      >
        <div className="drag flex items-end gap-2.5 px-3.5 py-3">
          <span className="mb-[7px] shrink-0">
            <Logo busy={busy} />
          </span>
          <div className="min-w-0 flex-1">
            {listening || transcribing ? (
              <div className="flex h-9 items-center gap-3 text-[16px]">
                {listening ? <Level level={voice.level} /> : <Typing />}
                {listening && <span className="text-muted">Listening…</span>}
              </div>
            ) : (
              <textarea
                ref={input}
                rows={1}
                value={text}
                disabled={!ready || coreDown}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submit();
                  }
                  // ↑ with nothing typed: the last answer comes back beside the pointer.
                  if (e.key === "ArrowUp" && !text && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    window.dunebot.bar.last();
                  }
                }}
                placeholder={coreDown ? "Dune Bot's core stopped. Quit and reopen it." : thread ? "Ask a follow-up…" : "What should I do on your computer?"}
                className="no-drag field-sizing-content block max-h-40 min-h-9 w-full resize-none bg-transparent py-[7px] text-[16px] leading-[1.4] outline-none"
              />
            )}
          </div>
          <div className="mb-0.5 flex shrink-0 items-center gap-1.5">
            {busy ? (
              <button title="Stop" onClick={() => activeId && call("threads.cancel", { id: activeId })} className="grid size-8 place-items-center rounded-full bg-ink text-white hover:bg-black">
                <Square size={12} fill="currentColor" />
              </button>
            ) : text.trim() && !listening ? (
              <button title="Send" onClick={submit} className="grid size-8 place-items-center rounded-full bg-ink text-white hover:bg-black">
                <ArrowUp size={17} />
              </button>
            ) : (
              <button
                title={mac ? `Hold to talk (or hold ${keys})` : "Hold to talk"}
                onPointerDown={talkStart}
                onPointerUp={talkEnd}
                onPointerCancel={talkEnd}
                className={`grid size-8 place-items-center rounded-full transition-colors ${
                  listening ? "bg-ink text-white" : "text-muted hover:bg-bubble hover:text-ink"
                }`}
              >
                <Mic size={17} />
              </button>
            )}
            <label title="Agent for new chats" className="relative flex h-8 items-center gap-1.5 rounded-full border border-line pr-2.5 pl-1 text-[12.5px] font-medium hover:border-muted/50">
              <span className="grid size-6 place-items-center rounded-full bg-[#3a3a3c] font-pixel text-[11px] text-[#fff]">
                {look.short}
              </span>
              {agentName(agent)}
              {installed.length > 1 && (
                <select value={agent} onChange={(e) => pickAgent(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" aria-label="Agent">
                  {installed.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              )}
            </label>
            {thread && (
              <button title="New chat" onClick={() => (set({ activeId: null }), input.current?.focus())} className="grid size-8 place-items-center rounded-full text-muted hover:bg-bubble hover:text-ink">
                <Plus size={17} />
              </button>
            )}
            <button title="Open chats" onClick={() => window.dunebot.openMain(activeId ? `thread:${activeId}` : "chat")} className="grid size-8 place-items-center rounded-full text-muted hover:bg-bubble hover:text-ink">
              <Maximize2 size={15} />
            </button>
          </div>
        </div>

        {showFooter && (
        <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11.5px] text-muted">
          {toast ? (
            <span className="font-medium text-ink">{toast}</span>
          ) : voice.state === "downloading" ? (
            <span className="truncate">Getting voice ready (one-time 190 MB download)… {voice.progress ?? 0}%</span>
          ) : voice.state === "error" && voice.message ? (
            <span className="truncate font-medium text-ink">{voice.message}</span>
          ) : null}
          <span className="ml-auto shrink-0">{hint}</span>
        </div>
        )}
      </div>
    </div>
  );
}
