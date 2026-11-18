import { useEffect, useRef, useState } from "react";
import { AlertCircle, Maximize2, Volume2, VolumeX, X } from "lucide-react";
import { agentName, call, get, keysLabel, openThread, set, useStore, type Message } from "./store";
import { ApprovalCard } from "./parts";
import { Reply, TypingLine } from "./reply";
import { useSmoothText } from "./smooth";
import { noteStream } from "./parts";
import { useStickToBottom } from "./stick";
import { Speaker } from "./speak";

/**
 * The answer beside the pointer (HeyClicky-style): no chat, just what Dune Bot is doing now and its
 * answer, read aloud. The window is see-through, click-through and a fixed size; the card sits in the
 * corner nearest the pointer and grows away from it, so the window itself never moves while a reply
 * arrives. It carries everything a turn can need from you: listening, working (thinking dots: the
 * agent's steps aren't shown, 2026-11-17), the answer, an error, and approval cards (clickable: the
 * card takes the mouse while the pointer is on it).
 */
export type CaptionShow = { threadId: string | null; side: "below" | "above"; align: "left" | "right"; speak: boolean };

const linux = window.dunebot.platform === "linux";

/** From the last thing you asked onward. */
function exchange(list: Message[]) {
  let i = list.length - 1;
  while (i >= 0 && list[i].role !== "user") i--;
  return list.slice(Math.max(0, i));
}

export function Caption() {
  const [show, setShow] = useState<CaptionShow | null>(null);
  const [hover, setHover] = useState(false);
  const [speaking, setSpeakingState] = useState(false);
  // Also as a ref: the reading effect hands a sentence over and the "done" check after it, in the
  // same render, must already see it.
  const speakingNow = useRef(false);
  const setSpeaking = (on: boolean) => {
    speakingNow.current = on;
    setSpeakingState(on);
  };
  const [fading, setFading] = useState(false);
  const [note, setNote] = useState<string | null>(null); // "Didn't catch that", a mic problem
  // What you said has been written down and is on its way to the agent: thinking, not an empty card.
  const [asked, setAsked] = useState(false);
  const [next, setNext] = useState<string | null>(null); // said while this answer was coming: asked after it
  const voice = useStore((s) => s.voice);
  const speakPref = useStore((s) => s.prefs["voice.speak"]) !== "0";
  // Sarvam reads aloud unless Settings › Voice says this computer (with no key saved, the first try
  // fails at once and the system voice reads that answer).
  const engine = useStore((s) => s.prefs["voice.engine"]);
  useEffect(() => {
    Speaker.sarvam = engine !== "local";
  }, [engine]);
  const id = show?.threadId ?? null;
  const thread = useStore((s) => s.threads.find((t) => t.id === id));
  const list = useStore((s) => (id ? s.messages[id] : undefined)) ?? [];
  const busy = useStore((s) => (id ? !!s.busy[id] : false));
  const shown = exchange(list);
  const approval = shown.find((m) => m.role === "approval" && m.meta.status === "pending");
  const reply = [...shown].reverse().find((m) => m.role === "assistant");
  const listening = voice.state === "listening";
  const transcribing = voice.state === "transcribing";
  const speaker = useRef<Speaker | null>(null);
  const spokenFor = useRef<string | null>(null); // the last answer there when the card opened (not read again)
  const turnFor = useRef<string | null>(null); // the question whose turn is being read
  const scroller = useRef<HTMLDivElement>(null);
  const moving = useRef(false); // following the pointer: it can't be pointed at, so hovering is ignored

  useEffect(() => {
    const open = (s: CaptionShow) => {
      speaker.current?.stop();
      speaker.current = null;
      turnFor.current = null;
      setSpeaking(false);
      // The answer already there (to the last question) isn't read again; only what comes next.
      const before = s.threadId ? get().messages[s.threadId] ?? [] : [];
      spokenFor.current = [...before].reverse().find((m) => m.role === "assistant")?.id ?? null;
      setFading(false);
      setNote(null);
      if (!s.threadId) setAsked(false); // a new "Listening…"; the chat it was sent to keeps thinking
      setHover(false); // a card closed under the pointer never heard it leave
      setShow(s);
      if (s.threadId && s.speak) warmVoice();
      // A chat followed since its turn started is already here; another is fetched.
      if (s.threadId && get().messages[s.threadId]) set({ activeId: s.threadId });
      else if (s.threadId) openThread(s.threadId).catch(() => {});
    };
    showCaption.current = open;
    const offShow = window.dunebot.caption.onShow(open);
    const offHush = window.dunebot.caption.onHush(() => {
      speaker.current?.stop();
      setSpeaking(false);
    });
    const held = (t: string | null) => {
      setNext(typeof t === "string" && t ? t : null);
      if (t) setAsked(false); // the question waits; the answer still coming stays in view
    };
    const offNext = window.dunebot.caption.onNext(held);
    showNext.current = held;
    const offPlace = window.dunebot.caption.onPlace((p) => setShow((s) => (s ? { ...s, side: p.side, align: p.align } : s)));
    const offMoving = window.dunebot.caption.onMoving((on) => {
      moving.current = on;
      if (on) setHover(false);
    });
    const offEvent = window.dunebot.onEvent((m) => {
      if (m.event === "voice.transcript" && !String(m.text ?? "").trim()) setNote(m.note || `I didn't catch that. Hold ${keysLabel(get().prefs)} and try again.`);
      else if (m.event === "voice.transcript") {
        // The bar holds what you said while its chat is still working (asked after it): no dots then.
        const s = get();
        const chat = s.prefs["bar.thread"];
        if (!(chat && (s.busy[chat] || (s.waiting[chat] ?? 0) > 0))) setAsked(true);
      }
      if (m.event === "voice.state" && m.state === "transcribing") warmVoice();
      if (m.event === "voice.state" && m.state === "listening") setAsked(false);
      if (m.event === "voice.state" && m.state === "error" && m.message) setNote(m.message);
      if (m.event === "core.exit") setNext(null);
    });
    return () => {
      offShow();
      offHush();
      offNext();
      offPlace();
      offMoving();
      offEvent();
    };
  }, []);

  // Reads the turn aloud as it arrives (only answers to what you asked from the bar), all of it in
  // order with one voice: a first line like "Sure, checking the weather now" the moment it's
  // written, while the work goes on, then the answer after it (never cutting the first line off).
  // What was already there when the card opened isn't read again.
  const replyIsLast = !!reply && shown[shown.length - 1]?.id === reply.id;
  const question = shown[0]?.role === "user" ? shown[0].id : null;
  let said = shown.filter((m) => m.role === "assistant" && m.meta.status !== "error");
  const seen = said.findIndex((m) => m.id === spokenFor.current);
  if (seen >= 0) said = said.slice(seen + 1);
  let turnText = "";
  const starts: number[] = [];
  for (const m of said) {
    starts.push(turnText.length);
    turnText += m.text;
    // The one still arriving is the last so far. A line a step follows has ended, though the core
    // only marks it done when the next words come: read it now, while the step runs.
    if (m.meta.status === "streaming" && shown[shown.length - 1]?.id === m.id) break;
    turnText += "\n\n"; // a finished part ends its last sentence
  }
  const turnOver = !busy && !said.some((m) => m.meta.status === "streaming");
  useEffect(() => {
    if (!show?.speak || !speakPref || !question || !turnText.trim()) return;
    if (turnFor.current !== question) {
      speaker.current?.stop();
      speaker.current = new Speaker();
      speaker.current.onChange = setSpeaking;
      turnFor.current = question;
    }
    speaker.current?.feed(turnText, turnOver, starts);
  }, [show, speakPref, question, turnText, turnOver]);

  // A question waits for this answer: once it has ended and nothing more of it is being read, the
  // bar asks it (held.ts). Once per question.
  const doneFor = useRef<string | null>(null);
  useEffect(() => {
    if (!next) {
      doneFor.current = null;
      return;
    }
    if (!id || busy || speakingNow.current || reply?.meta.status === "streaming" || doneFor.current === next) return;
    doneFor.current = next;
    window.dunebot.caption.nextDone();
  }, [next, id, busy, speaking, reply?.meta.status]);

  // Thinking until the agent's turn starts (then `busy` says so); a send that never happened lets go.
  useEffect(() => {
    if (busy) setAsked(false);
  }, [busy]);
  useEffect(() => {
    if (!asked) return;
    const t = window.setTimeout(() => setAsked(false), 15000);
    return () => window.clearTimeout(t);
  }, [asked]);

  // Turned off on the card: quiet at once.
  useEffect(() => {
    if (!speakPref) speaker.current?.stop();
  }, [speakPref]);

  // It follows the pointer until there's nothing left to do or say (main also stops it for a card).
  const settled = !(busy || asked || !!next || !!approval || listening || transcribing || speaking);
  useEffect(() => {
    if (show) window.dunebot.caption.settled(settled);
  }, [show, settled]);

  // Fades once there is nothing left to do or hear, after time to read what it says.
  const active = busy || asked || !!next || !!approval || listening || transcribing || speaking || hover;
  const empty = !id && !note && !listening && !transcribing && !asked; // a hold that ended without anything to say
  useEffect(() => {
    if (!show) return;
    setFading(false);
    if (active) return;
    const read = empty ? 0 : Math.min(14000, Math.max(4000, 2500 + (reply?.text.length ?? note?.length ?? 0) * 35));
    const t = window.setTimeout(() => setFading(true), read);
    return () => window.clearTimeout(t);
  }, [show, active, empty, reply?.text.length]);
  useEffect(() => {
    if (!fading) return;
    const t = window.setTimeout(() => {
      speaker.current?.stop();
      setHover(false);
      setShow(null);
      window.dunebot.caption.hide();
    }, 320);
    return () => window.clearTimeout(t);
  }, [fading]);

  // The card takes the mouse only while the pointer is on it (Linux can't tell: while a card waits for you).
  const interactive = hover || (linux && !!approval);
  useEffect(() => window.dunebot.caption.mouse(interactive), [interactive]);

  useStickToBottom(scroller, [reply?.id, id]);

  if (!show) return null;
  const close = () => {
    speaker.current?.stop();
    setHover(false);
    setShow(null);
    window.dunebot.caption.hide();
  };
  // Short states (listening, working, a step) hug their words; an answer or a card takes the full
  // width at once, so its lines don't reflow as it grows.
  const wide = !!approval || !!note || !!(reply && reply.text);

  return (
    <div className={`flex h-full p-4 ${show.side === "above" ? "items-end" : "items-start"} ${show.align === "right" ? "justify-end" : "justify-start"}`}>
      <div
        className={`dm-caption group relative flex max-h-full flex-col overflow-hidden ${wide ? "w-[360px]" : "w-fit max-w-[360px]"} ${fading ? "opacity-0" : "opacity-100"}`}
        onMouseEnter={() => !moving.current && setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {hover && (
          <div className="absolute top-1.5 right-1.5 z-10 flex gap-0.5 rounded-full bg-[var(--dm-glass)]">
            {id && (
              <button title="Open in Chats" onClick={() => window.dunebot.openMain(`thread:${id}`)} className="grid size-7 place-items-center rounded-full text-muted hover:bg-bubble hover:text-ink">
                <Maximize2 size={13} />
              </button>
            )}
            <button title="Close" onClick={close} className="grid size-7 place-items-center rounded-full text-muted hover:bg-bubble hover:text-ink">
              <X size={14} />
            </button>
          </div>
        )}
        <div ref={scroller} className="dm-caption-scroll flex min-h-0 flex-col gap-2.5 overflow-y-auto px-4 py-3">
          {listening ? (
            <div className="flex h-[22.5px] items-center gap-2.5 text-[15px]">
              <Level level={voice.level} />
              <span className="text-muted">Listening…</span>
            </div>
          ) : transcribing ? (
            // Let go: straight to the thinking dots (no note while what you said is written down).
            <div className="text-[15px] leading-[1.5]">
              <TypingLine />
            </div>
          ) : !id ? (
            note ? (
              <p className="text-[14px] leading-[1.45] text-muted">{note}</p>
            ) : (
              asked && (
                <div className="text-[15px] leading-[1.5]">
                  <TypingLine />
                </div>
              )
            )
          ) : (
            <>
              {reply && !asked && (reply.text || reply.meta.status === "streaming") ? (
                <Answer m={reply} />
              ) : (busy || asked) && !approval ? (
                <div className="text-[15px] leading-[1.5]">
                  <TypingLine />
                </div>
              ) : null}
              {/* A line like "On it." with work after it: the dots again, not the step itself. */}
              {reply && !asked && reply.text && busy && !approval && !replyIsLast && (
                <div className="text-[15px] leading-[1.5]">
                  <TypingLine />
                </div>
              )}
              {approval && <ApprovalCard m={approval} agent={thread?.agent ?? "claude"} bar />}
              {next && (
                <p className="flex min-w-0 items-baseline gap-1.5 text-[12.5px] leading-[1.45] text-muted">
                  {/* Talking never answers a card: the question waits until you click it. */}
                  <span className="shrink-0 font-medium">{approval ? "Next, once you answer this:" : "Next:"}</span>
                  <span className="min-w-0 truncate">{next}</span>
                </p>
              )}
            </>
          )}
        </div>
        {(speaking || (thread && !listening && !transcribing && hover)) && (
          <div className="flex items-center gap-2 border-t border-line px-4 py-1.5 text-[11.5px] text-muted">
            {speaking ? (
              <button title="Stop reading this answer" onClick={() => (speaker.current?.stop(), setSpeaking(false))} className="flex items-center gap-1.5 hover:text-ink">
                <Volume2 size={12} className="shrink-0 text-brand" /> Speaking · stop
              </button>
            ) : (
              <button
                title={speakPref ? "Stop reading answers aloud" : "Read answers aloud"}
                onClick={async () => set({ prefs: (await call("prefs.set", { key: "voice.speak", value: speakPref ? "0" : "1" })).prefs })}
                className="flex items-center gap-1.5 hover:text-ink"
              >
                {speakPref ? <Volume2 size={12} className="shrink-0" /> : <VolumeX size={12} className="shrink-0" />}
                {speakPref ? "Read aloud" : "Not read aloud"}
              </button>
            )}
            {thread && <span className="ml-auto truncate">{agentName(thread.agent)}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/** The reply as it arrives (the same safe renderer as the chats window), or its error. */
function Answer({ m }: { m: Message }) {
  const streaming = m.meta.status === "streaming";
  const text = useSmoothText(m.text, streaming, noteStream);
  const live = streaming || text.length < m.text.length;
  if (m.meta.status === "error")
    return (
      <div className="flex gap-2 text-[14px] leading-[1.45] text-ink">
        <AlertCircle size={16} className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-words">{m.text || "Something went wrong."}</span>
      </div>
    );
  return <div className="md text-[15px] leading-[1.5] select-text">{text ? <Reply text={text} streaming={live} /> : <TypingLine />}</div>;
}

/** Live microphone level as five bars. */
function Level({ level }: { level: number }) {
  return (
    <span className="inline-flex h-5 items-center gap-[3px]" aria-hidden>
      {[0.55, 0.85, 1, 0.8, 0.5].map((w, i) => (
        <span key={i} className="w-[3px] rounded-full bg-brand transition-[height] duration-75" style={{ height: `${Math.max(4, Math.round(20 * Math.min(1, level * 1.6) * w))}px` }} />
      ))}
    </span>
  );
}

/** For snapshot scripts (window.__dm.caption): show a chat as if it had just been asked from the bar. */
export const showCaption: { current: ((s: CaptionShow) => void) | null } = { current: null };
/** For snapshot scripts (window.__dm.next): what the bar holds to ask next. */
export const showNext: { current: ((t: string | null) => void) | null } = { current: null };

// One line per spoken answer in the app's log (numbers only): whether the voice really started.
/** The voice that will read the answer opens while you're still being written down (or as the card
 * opens for a typed question), so its first sentence doesn't wait for a connection. Once per question. */
function warmVoice() {
  if (Speaker.sarvam && get().prefs["voice.speak"] !== "0") Speaker.prewarm();
}

Speaker.onStats = (s) =>
  window.dunebot.note?.(
    `speech: ${s.queued} queued, ${s.started} started, ${s.ended} ended, ${s.timedOut} timed out, errors ${s.errors.join(" ") || "none"}, ${s.voices} voices; sarvam read ${s.sarvam}, ${s.fallbacks} to the system voice; streamed ${s.streamed}, first sound ${s.firstSoundMs < 0 ? "-" : `${s.firstSoundMs} ms`}, ran dry ${s.dry}`,
  );
