import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AudioLines, Bell, Check, FolderOpen, Loader2, Mic, Monitor, TriangleAlert } from "lucide-react";
import { Mascot } from "./parts";

export type SetupStatus = {
  platform: string;
  mic: "granted" | "denied" | "restricted" | "not-determined" | "unknown";
  notifications: "granted" | "denied" | "not-determined" | "unknown";
  folders: Record<string, "granted" | "denied" | "missing" | "not-asked">;
  screen: "granted" | "denied" | "restricted" | "not-determined" | "unknown";
  /** Which of these this system asks the user for at all (others need nothing). */
  asks: { mic: boolean; notifications: boolean; folders: boolean; screen: boolean };
  hotkey: string | null;
  /** The keys that tap and hold on macOS (⌥⌘ unless picked otherwise). */
  keys?: string;
  voice: { available?: boolean; ready?: boolean; downloading?: boolean; progress?: number };
  done: boolean;
};

type Tone = "ok" | "todo" | "off" | "busy" | "warn";

const mac = window.dunebot.platform === "darwin";
const win = window.dunebot.platform === "win32";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function Row(props: {
  icon: React.ReactNode;
  title: string;
  why: string;
  tone: Tone;
  label: string;
  action?: { text: string; run: () => void };
  focus?: boolean;
}) {
  const { icon, title, why, tone, label, action, focus } = props;
  return (
    <div className={`flex items-center gap-3.5 rounded-2xl bg-white px-4 py-3.5 ${focus ? "ring-2 ring-coral/70" : ""}`}>
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-bubble text-ink">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[14.5px] font-semibold leading-tight">{title}</div>
        <div className="mt-0.5 text-[12.5px] leading-snug text-muted">{why}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span
          className={`flex items-center gap-1 text-[12.5px] font-medium ${
            tone === "ok" ? "text-[#2f9e62]" : tone === "off" || tone === "warn" ? "text-[#c98a2b]" : "text-muted"
          }`}
        >
          {tone === "ok" && <Check size={14} />}
          {tone === "busy" && <Loader2 size={14} className="animate-spin" />}
          {(tone === "off" || tone === "warn") && <TriangleAlert size={13} />}
          {label}
        </span>
        {action && (
          <button onClick={action.run} className="no-drag h-8 rounded-full bg-ink px-3.5 text-[13px] font-semibold text-white hover:bg-black">
            {action.text}
          </button>
        )}
      </div>
    </div>
  );
}

export function Setup() {
  const [st, setSt] = useState<SetupStatus | null>(null);
  const [step, setStep] = useState(location.hash.split(":")[1] ?? "");
  const [heard, setHeard] = useState<null | "checking" | "yes" | "no">(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [problem, setProblem] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const running = useRef(false);

  const refresh = async () => {
    const s = await window.dunebot.setup.status();
    setSt(s);
    return s;
  };

  useEffect(() => {
    refresh();
    const offNav = window.dunebot.onNav((v) => setStep(v));
    const offEvent = window.dunebot.onEvent((m) => {
      if (m.event !== "voice.state") return;
      if (m.state === "downloading") setProgress(m.progress ?? 0);
      if (m.state === "ready") {
        setProgress(null);
        refresh();
      }
      if (m.state === "error" && m.message) {
        setProgress(null);
        setProblem(m.message);
      }
    });
    // Coming back from System Settings: show what changed there.
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      offNav();
      offEvent();
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => window.dunebot.setup.fit(el.getBoundingClientRect().height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  async function ask(what: Parameters<typeof window.dunebot.setup.ask>[0]) {
    setAsking(what);
    setProblem("");
    try {
      if (what === "mic-test") {
        setHeard("checking");
        const r = await window.dunebot.setup.ask("mic-test");
        setHeard(r?.heard ? "yes" : "no");
        return;
      }
      const s: SetupStatus = await window.dunebot.setup.ask(what);
      setSt(s);
      if (what === "mic" && s.mic === "granted") await ask("mic-test");
      if (what === "notifications") {
        // The system's box is up; wait for the answer (up to a minute).
        for (let i = 0; i < 90; i++) {
          await wait(700);
          const now = await refresh();
          if (now.notifications !== "not-determined") break;
        }
      }
    } catch (e) {
      if (what === "mic-test") setHeard("no");
      setProblem((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    } finally {
      setAsking(null);
    }
  }

  // One button: each system box in turn.
  async function allowAll() {
    if (running.current || !st) return;
    running.current = true;
    try {
      let s = st;
      if (s.asks.mic && s.mic === "not-determined") await ask("mic");
      s = await refresh();
      if (s.asks.notifications && s.notifications === "not-determined") await ask("notifications");
      s = await refresh();
      if (s.asks.folders && Object.values(s.folders).some((v) => v === "not-asked")) await ask("folders");
      s = await refresh();
      if (s.voice.available !== false && !s.voice.ready && !s.voice.downloading) await ask("voice");
      s = await refresh();
      // Last: macOS answers this one in System Settings, which takes the user away.
      if (s.asks.screen && s.screen !== "granted") await ask("screen");
    } finally {
      running.current = false;
    }
  }

  if (!st) return <div ref={box} className="h-80" />;
  const keys = st.keys ?? "⌥⌘";

  const folders = Object.entries(st.folders);
  const foldersAsked = folders.every(([, v]) => v !== "not-asked");
  const foldersOk = folders.every(([, v]) => v === "granted" || v === "missing");
  const voiceOk = !!st.voice.ready;
  const micOk = st.mic === "granted";
  const notesOk = st.notifications === "granted";
  const screenOk = st.screen === "granted";
  const { asks } = st;
  const allOk =
    (!asks.mic || micOk) &&
    (!asks.notifications || notesOk) &&
    (!asks.folders || foldersOk) &&
    (!asks.screen || screenOk) &&
    (voiceOk || st.voice.available === false);
  const anyToAsk =
    (asks.mic && st.mic === "not-determined") ||
    (asks.screen && !screenOk) ||
    (asks.notifications && st.notifications === "not-determined") ||
    (asks.folders && !foldersAsked) ||
    (!voiceOk && !st.voice.downloading && progress === null);
  // Same rows on every system; one that asks nothing says so.
  const nothing = { tone: "ok" as Tone, label: "No permission needed" };
  const hotkey = st.hotkey?.replace("Control", "Ctrl");

  const micRow = (
      <Row
        icon={<Mic size={17} />}
        title="Microphone"
        why={mac ? `Hears you only while you hold ${keys} or the mic button. Nothing is recorded otherwise.` : "Hears you only while you hold the mic button. Nothing is recorded otherwise."}
        focus={step === "mic" && !micOk}
        {...(!asks.mic
          ? nothing
          : asking === "mic"
          ? { tone: "busy" as Tone, label: "Answer the box" }
          : micOk
            ? heard === "checking"
              ? { tone: "busy" as Tone, label: "Checking it hears you" }
              : heard === "no"
                ? { tone: "warn" as Tone, label: "No sound arrived", action: { text: "Try again", run: () => ask("mic-test") } }
                : { tone: "ok" as Tone, label: heard === "yes" ? "Hears you" : "Allowed" }
            : st.mic === "not-determined"
              ? { tone: "todo" as Tone, label: "", action: { text: "Allow", run: () => ask("mic") } }
              : { tone: "off" as Tone, label: "Off", action: { text: "Open Settings", run: () => window.dunebot.setup.openSettings("mic") } })}
      />
  );

  return (
    <div ref={box} className="flex flex-col px-7 pt-7 pb-6 font-sans text-ink select-none">
      <div className="drag flex items-center gap-3.5">
        <Mascot size={44} />
        <div>
          <h1 className="text-[21px] font-semibold tracking-[-0.01em]">Set up Dune Bot</h1>
          <p className="mt-0.5 text-[13.5px] text-muted">
            {mac
              ? `Lives in your menu bar. Tap ${keys} to ask. Hold ${keys} to talk.`
              : `Lives in your tray. ${hotkey ? `${hotkey} to ask.` : "Open Dune Bot again to ask."} Hold the mic button to talk.`}
          </p>
        </div>
      </div>

      {step === "screen" && !screenOk && (
        <p className="mt-4 rounded-xl bg-coral/12 px-3.5 py-2.5 text-[13px] font-medium text-ink">
          Looking at your screen needs Screen Recording. Allow it below; macOS then asks to quit and reopen Dune Bot.
        </p>
      )}

      {step === "mic" && !micOk && (
        <p className="mt-4 rounded-xl bg-coral/12 px-3.5 py-2.5 text-[13px] font-medium text-ink">Talking needs the microphone. Allow it below, then hold {keys} again.</p>
      )}

      <p className="mt-5 text-[13px] text-muted">
        {mac
          ? "macOS asks once for each of these. Answering now means nothing interrupts you later."
          : win
            ? "Windows asks for nothing up front; if something is switched off, it says so here."
            : "Linux asks for nothing up front; get the speech model now so talking works straight away."}
      </p>

      <div className="mt-3 flex flex-col gap-2">
        {micRow}
        <Row
          icon={<AudioLines size={17} />}
          title="Speech to text"
          why="On this computer (English), 190 MB once. With a Sarvam key (Permissions › Voice), it's the fallback."
          {...(st.voice.available === false
            ? { tone: "off" as Tone, label: "Not in this build" }
            : voiceOk
              ? { tone: "ok" as Tone, label: "Ready" }
              : progress !== null || st.voice.downloading
                ? { tone: "busy" as Tone, label: `${progress ?? st.voice.progress ?? 0}%` }
                : { tone: "todo" as Tone, label: "", action: { text: "Download", run: () => ask("voice") } })}
        />
        {(
          <Row
            icon={<Bell size={17} />}
            title="Notifications"
            why="Tells you when an agent needs your OK or has finished."
            {...(!asks.notifications
              ? nothing
              : asking === "notifications"
              ? { tone: "busy" as Tone, label: "Answer the box" }
              : notesOk
                ? { tone: "ok" as Tone, label: "Allowed" }
                : st.notifications === "not-determined" || st.notifications === "unknown"
                  ? { tone: "todo" as Tone, label: "", action: { text: "Allow", run: () => ask("notifications") } }
                  : { tone: "off" as Tone, label: "Off", action: { text: "Open Settings", run: () => window.dunebot.setup.openSettings("notifications") } })}
          />
        )}
        {(
          <Row
            icon={<FolderOpen size={17} />}
            title="Desktop, Documents and Downloads"
            why={
              foldersAsked && !foldersOk
                ? `Not allowed: ${folders.filter(([, v]) => v === "denied").map(([k]) => k).join(", ")}. Agents can't work there.`
                : "So agents can work with files there when you ask. You still OK every command and change."
            }
            {...(!asks.folders
              ? nothing
              : asking === "folders"
              ? { tone: "busy" as Tone, label: "Answer each box" }
              : !foldersAsked
                ? { tone: "todo" as Tone, label: "", action: { text: "Allow", run: () => ask("folders") } }
                : foldersOk
                  ? { tone: "ok" as Tone, label: "Allowed" }
                  : { tone: "off" as Tone, label: "Some off", action: { text: "Open Settings", run: () => window.dunebot.setup.openSettings("folders") } })}
          />
        )}
        <Row
          icon={<Monitor size={17} />}
          title="Screen Recording"
          why="Agents look at the screen under your pointer, without asking, to answer you. Each picture goes only to your agent; Dune Bot keeps none."
          focus={step === "screen" && !screenOk}
          {...(!asks.screen
            ? nothing
            : asking === "screen"
              ? { tone: "busy" as Tone, label: "Answer the box" }
              : screenOk
                ? { tone: "ok" as Tone, label: "Allowed" }
                : st.screen === "not-determined"
                  ? { tone: "todo" as Tone, label: "", action: { text: "Allow", run: () => ask("screen") } }
                  : { tone: "off" as Tone, label: "Off", action: { text: "Open Settings", run: () => window.dunebot.setup.openSettings("screen") } })}
        />
      </div>

      {problem && <p className="mt-3 text-[12.5px] font-medium text-[#c98a2b]">{problem}</p>}

      <p className="mt-4 text-[12px] leading-snug text-muted">
        {mac
          ? `Dune Bot never asks for Full Disk Access, Accessibility or Input Monitoring. ${keys} is read from the modifier keys only, never what you type.`
          : "You can change any of these later from the tray menu: Set up Dune Bot."}
      </p>

      <div className="mt-5 flex items-center gap-2">
        <button onClick={() => window.dunebot.setup.finish(false)} className="no-drag h-10 rounded-full px-4 text-[14px] font-medium text-muted hover:text-ink">
          Later
        </button>
        <div className="ml-auto flex items-center gap-2">
          {anyToAsk && !allOk && (
            <button
              onClick={allowAll}
              disabled={!!asking}
              className="no-drag h-10 rounded-full bg-ink px-5 text-[14px] font-semibold text-white hover:bg-black disabled:opacity-50"
            >
              {asking ? "Waiting for your answer…" : "Allow everything"}
            </button>
          )}
          <button
            onClick={() => window.dunebot.setup.finish(true)}
            className={`no-drag h-10 rounded-full px-5 text-[14px] font-semibold ${
              allOk || !anyToAsk ? "bg-ink text-white hover:bg-black" : "border border-line bg-white hover:border-muted/50"
            }`}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
