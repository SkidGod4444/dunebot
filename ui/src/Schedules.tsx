import { useEffect, useState } from "react";
import { FolderOpen, Play } from "lucide-react";
import { agentName, call, errorText, loadAgents, openThread, toast, useStore, type Schedule } from "./store";
import { DeleteButton, LoadProblem } from "./parts";
import { when } from "./format";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const clock = (at: number) => new Date(2000, 0, 1, Math.floor(at / 60), at % 60).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function repeatText(s: Pick<Schedule, "every" | "at" | "weekday">) {
  if (s.every === "hourly") return `Every hour at :${String(s.at % 60).padStart(2, "0")}`;
  if (s.every === "weekly") return `Every ${DAYS[s.weekday]} at ${clock(s.at)}`;
  return `${s.every === "weekdays" ? "Weekdays" : "Every day"} at ${clock(s.at)}`;
}
const folderName = (p?: string) => (p ? p.split(/[\\/]/).filter(Boolean).pop() : "its own folder");

/** Prompts that start a new chat at set times. Runs ask like any chat; nothing is approved for them. */
export function Schedules() {
  const [rows, setRows] = useState<Schedule[] | null>(null);
  const agents = useStore((s) => s.agents);
  const prefAgent = useStore((s) => s.prefs.agent);
  const chats = useStore((s) => s.threads.length); // a run makes a chat: reload then
  const installed = (agents ?? []).filter((a) => a.installed);
  const [prompt, setPrompt] = useState("");
  const [agent, setAgent] = useState("");
  const [every, setEvery] = useState<Schedule["every"]>("weekdays");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState(1);
  const [cwd, setCwd] = useState<string | undefined>();
  const [failed, setFailed] = useState("");
  const [adding, setAdding] = useState(false);
  const load = () =>
    call<Schedule[]>("schedules.list").then(
      (r) => (setRows(r), setFailed("")),
      (e) => setFailed(errorText(e)),
    );
  useEffect(() => {
    if (!agents) loadAgents();
  }, []);
  useEffect(() => {
    load();
  }, [chats]);
  const chosen = agent || (installed.find((a) => a.id === prefAgent) ?? installed[0])?.id || "";
  const [h, m] = time.split(":").map(Number);
  const at = every === "hourly" ? m || 0 : (h || 0) * 60 + (m || 0);
  // True when it worked; a refusal is a toast and leaves what you typed.
  const act = (p: Promise<unknown>) =>
    p.then(
      () => (load(), true),
      (e) => (toast(errorText(e)), false),
    );
  async function add() {
    if (!prompt.trim() || !chosen || adding) return;
    setAdding(true);
    if (await act(call("schedules.add", { prompt, agent: chosen, every, at, weekday, cwd }))) setPrompt("");
    setAdding(false);
  }
  // No outline-none: the keyboard's outline (styles.css :focus-visible) shows on these pickers.
  const field = "h-9 rounded-full border border-line bg-white px-3 text-[13.5px] hover:border-muted/50";
  return (
    <>
      <div className="drag h-[56px] shrink-0" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-6 pb-12">
          <h1 className="font-pixel text-[32px] leading-tight">Schedules</h1>
          <p className="mt-1 text-[15px] text-muted">
            Each run starts a new chat with your words. It asks before every command and file change, even where Permissions
            says Always. If a card is still waiting when the next time comes, that run is skipped. Dune Bot must be open.
          </p>
          <div className="mt-6 rounded-2xl border border-line p-3">
            <textarea
              rows={2}
              value={prompt}
              maxLength={4000}
              onChange={(e) => setPrompt(e.target.value)}
              aria-label="What should the agent do?"
              placeholder="What should the agent do? e.g. List what changed in ~/notes since yesterday"
              className="w-full resize-none bg-transparent px-1 py-1 text-[14.5px] outline-none placeholder:text-muted select-text"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select aria-label="How often" value={every} onChange={(e) => setEvery(e.target.value as Schedule["every"])} className={`${field} w-34`}>
                <option value="daily">Every day</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Every week</option>
                <option value="hourly">Every hour</option>
              </select>
              {every === "weekly" && (
                <select aria-label="Day" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} className={`${field} w-34`}>
                  {DAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              )}
              {every === "hourly" ? (
                <select aria-label="Minute past the hour" value={String(m || 0)} onChange={(e) => setTime(`00:${e.target.value.padStart(2, "0")}`)} className={`${field} w-32`}>
                  {[0, 15, 30, 45].map((x) => (
                    <option key={x} value={x}>
                      at :{String(x).padStart(2, "0")}
                    </option>
                  ))}
                </select>
              ) : (
                <input aria-label="Time" type="time" value={time} onChange={(e) => setTime(e.target.value || "09:00")} className={`${field} w-32`} />
              )}
              <select aria-label="Agent" value={chosen} onChange={(e) => setAgent(e.target.value)} className={`${field} w-44`}>
                {!installed.length && <option value="">No agents found</option>}
                {installed.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <button
                title={cwd ?? "Runs in a new folder of its own each time"}
                onClick={async () => setCwd((await window.dunebot.pickFolder()) ?? undefined)}
                className={`${field} flex w-40 items-center gap-1.5`}
              >
                <FolderOpen size={14} className="shrink-0 text-muted" />
                <span className="truncate">{cwd ? folderName(cwd) : "Its own folder"}</span>
              </button>
              <button disabled={!prompt.trim() || !chosen || adding} onClick={add} className="ml-auto h-9 rounded-full bg-ink px-4 text-[13.5px] font-medium text-white hover:bg-black disabled:opacity-40">
                Add schedule
              </button>
            </div>
          </div>
          <div className="mt-4 divide-y divide-line rounded-2xl border border-line">
            {!rows && failed && <LoadProblem what="your schedules" why={failed} retry={load} />}
            {rows?.length === 0 && <p className="px-4 py-6 text-center text-[14px] text-muted">No schedules yet.</p>}
            {rows?.map((s) => (
              <div key={s.id} data-schedule={s.enabled ? "on" : "off"} className="flex items-start gap-3 px-4 py-3">
                {/* Off: its title turns grey (readable, not faded); its buttons stay as they are. */}
                <div className="min-w-0 flex-1">
                  <p className={`truncate text-[14.5px] font-medium select-text ${s.enabled ? "text-ink" : "text-muted"}`} title={s.prompt}>
                    {s.title}
                  </p>
                  <p className="mt-0.5 truncate text-[12.5px] text-muted" title={s.cwd}>
                    {repeatText(s)} · {agentName(s.agent)} · {folderName(s.cwd)}
                  </p>
                  <p className="mt-1 text-[12px] tabular-nums text-muted">
                    {s.enabled ? `Next: ${new Date(s.nextRun).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "Off"}
                    {s.lastRun && s.lastThread && (
                      <>
                        {" · "}
                        <button onClick={() => openThread(s.lastThread!)} className="underline-offset-2 hover:text-ink hover:underline">
                          last run {when(s.lastRun)}
                        </button>
                      </>
                    )}
                  </p>
                </div>
                <button
                  title="Run it now"
                  onClick={() => act(call<{ threadId: string }>("schedules.run", { id: s.id }).then((r) => openThread(r.threadId)))}
                  className="flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium text-muted hover:bg-black/5 hover:text-ink"
                >
                  <Play size={12} fill="currentColor" /> Run now
                </button>
                <button
                  role="switch"
                  aria-checked={s.enabled}
                  aria-label={`Run “${s.title}” on its schedule`}
                  title={s.enabled ? "On" : "Off"}
                  onClick={() => act(call("schedules.set", { id: s.id, enabled: !s.enabled }))}
                  className={`mt-0.5 flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors ${s.enabled ? "bg-ink" : "bg-black/15"}`}
                >
                  <span className={`size-5 rounded-full bg-white shadow transition-transform ${s.enabled ? "translate-x-4" : ""}`} />
                </button>
                <DeleteButton
                  what="schedule"
                  body={`“${s.title}” won't run again. Chats from its past runs stay.`}
                  onDelete={() => act(call("schedules.delete", { id: s.id }))}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
