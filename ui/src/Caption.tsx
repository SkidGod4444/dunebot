import { useEffect, useRef, useState } from "react";
import { AlertCircle, Maximize2, Volume2, VolumeX, X } from "lucide-react";
import { agentName, get, keysLabel, openThread, savePref, set, useStore, type Message } from "./store";
import { ApprovalCard, noteStream } from "./parts";
import { Reply, Typing, TypingLine } from "./reply";
import { stepLine } from "./steps";
import { useSmoothText } from "./smooth";
import { useStickToBottom } from "./stick";
import { Speaker } from "./speak";
import { useDictation } from "./dictation";
import { Level } from "./ui";

/**
 * The answer beside the pointer (HeyClicky-style): no chat, just what Dune Bot is doing now and its
 * answer, read aloud. The window is see-through, click-through and a fixed size; the card sits in the
 * corner nearest the pointer and grows away from it, so the window itself never moves while a reply
 * arrives. It carries everything a turn can need from you: listening, working (thinking dots, and
 * beside them one plain line for the step the agent is on, so a quiet voice doesn't look stopped:
 * 2026-11-18; never a card per step), the answer, an error, and approval cards (clickable: the card
 * takes the mouse while the pointer is on it).
 */
// n: main's number for this card (closing it says which card closed); none when a test opens it.
export type CaptionShow = { threadId: string | null; side: "below" | "above"; align: "left" | "right"; speak: boolean; n?: number };

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
  const typing = useDictation(setNote); // Right ⌥ let go: what you said is being typed (dictation.tsx)
  // What you said has been written down and is on its way to the agent: thinking, not an empty card.
  const [asked, setAsked] = useState(false);
  const [next, setNext] = useState<string | null>(null); // said while this answer was coming: asked after it
  const voice = useStore((s) => s.voice);
  const speakPref = useStore((s) => s.prefs["voice.speak"]) !== "0";
  const toastText = useStore((s) => s.toast);
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
  // The step since the agent's last words (running, or just done): the line beside the dots.
  let step: Message | undefined;
  for (let i = shown.length - 1; i >= 0 && shown[i].role !== "assistant"; i--)
    if (shown[i].role === "tool") {
      step = shown[i];
      break;
    }
  const listening = voice.state === "listening";
  const transcribing = voice.state === "transcribing";
  const speaker = useRef<Speaker | null>(null);
  const spokenFor = useRef<string | null>(null); // the last answer there when the card opened (not read again)
  const turnFor = useRef<string | null>(null); // the question whose turn is being read
  const scroller = useRef<HTMLDivElement>(null);
  const moving = useRef(false); // following the pointer: it can't be pointed at, so hovering is ignored
  // Counts the cards opened. A fade or close timer from a card before this one does nothing: it can
  // fire after a new card opened but before the page drew it, and would close the new card unheard.
  const opened = useRef(0);
  const cardN = useRef<number | undefined>(undefined); // main's number for the card open now

  useEffect(() => {
    const open = (s: CaptionShow) => {
      opened.current++;
      cardN.current = s.n;
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
      if (m.event === "voice.transcript" && !String(m.text ?? "").trim()) setNote(heardNothing(m.note));
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
  const settled = !(busy || asked || !!next || !!approval || listening || transcribing || typing || speaking);
  useEffect(() => {
    if (show) window.dunebot.caption.settled(settled);
  }, [show, settled]);

  // Fades once there is nothing left to do or hear, after time to read what it says.
  const active = busy || asked || !!next || !!approval || listening || transcribing || typing || speaking || hover;
  const empty = !id && !note && !listening && !transcribing && !typing && !asked; // a hold that ended without anything to say
  useEffect(() => {
    if (!show) return;
    setFading(false);
    if (active) return;
    const read = empty ? 0 : Math.min(14000, Math.max(4000, 2500 + (reply?.text.length ?? note?.length ?? 0) * 35));
    const card = opened.current;
    const t = window.setTimeout(() => opened.current === card && setFading(true), read);
    return () => window.clearTimeout(t);
  }, [show, active, empty, reply?.text.length]);
  useEffect(() => {
    if (!fading) return;
    const card = opened.current;
    const t = window.setTimeout(() => {
      if (opened.current !== card) return; // a newer card opened while this one faded
      speaker.current?.stop();
      setHover(false);
      setShow(null);
      window.dunebot.caption.hide(cardN.current);
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
    window.dunebot.caption.hide(cardN.current);
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
            typing ? (
              <div className="flex h-[22.5px] items-center text-[15px]">
                <span className="text-muted">Typing…</span>
              </div>
            ) : note ? (
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
                <Working step={busy ? step : undefined} />
              ) : null}
              {/* A line like "On it." with work after it: the dots again, and the step beside them. */}
              {reply && !asked && reply.text && busy && !approval && !replyIsLast && <Working step={step} />}
              {approval && <ApprovalCard key={approval.id} m={approval} agent={thread?.agent ?? "claude"} bar />}
              {/* What a button here answered with ("Take a second to read the card first."). */}
              {toastText && (
                <p role="status" className="text-[12.5px] leading-[1.45] font-medium text-ink">
                  {toastText}
                </p>
              )}
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
        {/* The card's buttons live in this row, under the words, so they never cover the answer
            (they sat over its first line). It shows on hover, and while an answer is read aloud. */}
        {(speaking || (hover && !listening && !transcribing)) && (
          <div data-caption-row className="flex items-center gap-2 border-t border-line py-1 pr-1.5 pl-4 text-[11.5px] text-muted">
            {speaking ? (
              <button title="Stop reading this answer" aria-label="Stop reading this answer" onClick={() => (speaker.current?.stop(), setSpeaking(false))} className="flex items-center gap-1.5 hover:text-ink">
                <Volume2 size={12} className="shrink-0 text-brand" /> Speaking · stop
              </button>
            ) : thread ? (
              <button
                title={speakPref ? "Stop reading answers aloud" : "Read answers aloud"}
                aria-label="Read answers aloud"
                aria-pressed={speakPref}
                onClick={() => savePref("voice.speak", speakPref ? "0" : "1")}
                className="flex items-center gap-1.5 hover:text-ink"
              >
                {speakPref ? <Volume2 size={12} className="shrink-0" /> : <VolumeX size={12} className="shrink-0" />}
                {speakPref ? "Read aloud" : "Not read aloud"}
              </button>
            ) : null}
            <span className="ml-auto min-w-0 truncate">{thread ? agentName(thread.agent) : ""}</span>
            {id && (
              <button title="Open chats" aria-label="Open chats" onClick={() => window.dunebot.openMain(`thread:${id}`)} className="grid size-6 shrink-0 place-items-center rounded-full text-muted hover:bg-bubble hover:text-ink">
                <Maximize2 size={12} />
              </button>
            )}
            <button title="Close" aria-label="Close" onClick={close} className="grid size-6 shrink-0 place-items-center rounded-full text-muted hover:bg-bubble hover:text-ink">
              <X size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** What to say when a hold heard nothing. Off the Mac the bar talks only through its mic button
 * (there are no keys to hold), so the core's "Hold the keys…" is said as the button. */
function heardNothing(note?: string) {
  const mac = window.dunebot.platform === "darwin";
  if (!mac && (!note || note === "Hold the keys while you talk.")) return note ? "Hold the mic button while you talk." : "I didn't catch that. Hold the mic button and try again.";
  return note || `I didn't catch that. Hold ${keysLabel(get().prefs)} and try again.`;
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

/** The working dots, with the step the agent is on beside them when there is one. */
function Working({ step }: { step?: Message }) {
  const line = stepLine(step, window.dunebot.platform);
  return (
    <div className="flex h-[1.5em] min-w-0 items-center gap-2 text-[15px] leading-[1.5]">
      <Typing />
      {line && (
        <span data-step className="min-w-0 truncate text-[13.5px] text-muted">
          {line}
        </span>
      )}
    </div>
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
