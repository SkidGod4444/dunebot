import { useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { agentName, call, loadAgents, toast, useStore } from "./store";
import { MAY, useBots, type Bot } from "./bots";
import { AgentAvatar } from "./parts";

type Draft = { id?: string; name: string; role: string; engine: string; may: string[] };

const ALL = MAY.map(([k]) => k);
const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

function mayText(may: string[]) {
  if (ALL.every((k) => may.includes(k))) return "May do what Permissions allows";
  if (!may.length) return "Only answers and hands over";
  return `May: ${MAY.filter(([k]) => may.includes(k)).map(([, label]) => label.toLowerCase()).join(", ")}`;
}

/** Settings › Bots: the user's own bots, each with a role and the engine it runs on (core/src/team.rs). */
export function BotsSettings() {
  const bots = useBots();
  const agents = useStore((s) => s.agents);
  const prefAgent = useStore((s) => s.prefs.agent);
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (!agents) loadAgents().catch(() => {});
  }, []);
  const engines = (agents ?? []).filter((a) => a.installed);
  const firstEngine = () =>
    (engines.find((a) => a.id === prefAgent) ?? engines.find((a) => a.id !== "echo") ?? engines[0])?.id ?? "";

  async function remove(b: Bot) {
    try {
      // If it was the picked bot, the core moves the pick to its engine and every window re-reads it (store.ts).
      await call("bots.delete", { id: b.id });
      if (draft?.id === b.id) setDraft(null);
    } catch (e) {
      toast(clean(e));
    }
  }

  return (
    <div data-bots>
      <p className="mb-3 text-[13.5px] text-muted">
        Your own bots, each with a role. Pick one in the bar to ask it. A bot can hand part of a task to a teammate, and says so
        when it does; the teammate works in a chat of its own and asks before risky steps like any chat.
      </p>
      <div className="divide-y divide-line rounded-2xl border border-line">
        {!bots.length && !draft && <p className="px-4 py-6 text-center text-[14px] text-muted">No bots yet.</p>}
        {bots.map((b) =>
          draft?.id === b.id ? (
            <Editor key={b.id} draft={draft} engines={engines} onChange={setDraft} onDone={() => setDraft(null)} />
          ) : (
            <div key={b.id} className="flex items-start gap-3 px-4 py-3">
              <AgentAvatar id={b.id} size={34} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14.5px] font-medium text-ink">{b.name}</p>
                <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-ink/70 select-text">{b.role}</p>
                <p className="mt-1 truncate text-[12px] text-muted">
                  Runs on {agentName(b.engine)} · {mayText(b.may)}
                </p>
              </div>
              <button
                title="Edit this bot"
                onClick={() => setDraft({ id: b.id, name: b.name, role: b.role, engine: b.engine, may: b.may })}
                className="grid size-7 shrink-0 place-items-center rounded-lg text-muted hover:bg-black/5 hover:text-ink"
              >
                <Pencil size={14} />
              </button>
              <button title="Delete this bot" onClick={() => remove(b)} className="grid size-7 shrink-0 place-items-center rounded-lg text-muted hover:bg-black/5 hover:text-ink">
                <Trash2 size={15} />
              </button>
            </div>
          ),
        )}
        {draft && !draft.id && <Editor draft={draft} engines={engines} onChange={setDraft} onDone={() => setDraft(null)} />}
      </div>
      {!draft && (
        <button
          onClick={() => setDraft({ name: "", role: "", engine: firstEngine(), may: ALL })}
          className="mt-3 flex h-9 items-center gap-1.5 rounded-full border border-line px-4 text-[13.5px] font-medium text-ink hover:border-muted/50"
        >
          <Plus size={15} /> New bot
        </button>
      )}
    </div>
  );
}

function Editor({
  draft,
  engines,
  onChange,
  onDone,
}: {
  draft: Draft;
  engines: { id: string; name: string }[];
  onChange: (d: Draft) => void;
  onDone: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const field = "rounded-full border border-line bg-white px-3.5 text-[14px] outline-none hover:border-muted/50 focus:border-muted/60";
  // The bot's engine stays listed while it's edited, even if it isn't found on this computer now.
  const options = draft.engine && !engines.some((a) => a.id === draft.engine) ? [{ id: draft.engine, name: agentName(draft.engine) }, ...engines] : engines;
  const ready = draft.name.trim() && draft.role.trim() && draft.engine && !saving;
  const toggle = (k: string) => onChange({ ...draft, may: draft.may.includes(k) ? draft.may.filter((x) => x !== k) : [...draft.may, k] });
  async function save() {
    if (!ready) return;
    setSaving(true);
    try {
      await call("bots.save", { ...(draft.id ? { id: draft.id } : {}), name: draft.name, role: draft.role, engine: draft.engine, may: draft.may });
      onDone();
    } catch (e) {
      toast(clean(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div data-bot-editor className="px-4 py-3.5">
      <div className="flex flex-wrap gap-2">
        <input
          autoFocus
          aria-label="Name"
          value={draft.name}
          maxLength={40}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          placeholder="Name, e.g. Writer"
          className={`${field} h-9 min-w-0 flex-1 select-text`}
        />
        <select aria-label="Engine" value={draft.engine} onChange={(e) => onChange({ ...draft, engine: e.target.value })} className={`${field} h-9 w-60`}>
          {!options.length && <option value="">No agents found</option>}
          {options.map((a) => (
            <option key={a.id} value={a.id}>
              Runs on {a.name}
            </option>
          ))}
        </select>
      </div>
      <textarea
        aria-label="Role"
        rows={2}
        value={draft.role}
        maxLength={600}
        onChange={(e) => onChange({ ...draft, role: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          if (e.key === "Escape") onDone();
        }}
        placeholder="Its role: what it does, e.g. Turns my notes into a short post"
        className="mt-2 block w-full resize-none rounded-xl border border-line bg-white px-3.5 py-2 text-[14px] leading-snug outline-none placeholder:text-muted hover:border-muted/50 focus:border-muted/60 select-text"
      />
      <p className="mt-3 mb-1.5 text-[12px] font-medium text-muted">What it may do</p>
      <div className="flex flex-wrap gap-1.5">
        {MAY.map(([k, label]) => {
          const on = draft.may.includes(k);
          return (
            <button
              key={k}
              aria-pressed={on}
              onClick={() => toggle(k)}
              className={`h-7 rounded-full border px-3 text-[12.5px] font-medium ${on ? "border-ink bg-ink text-white" : "border-line text-muted hover:border-muted/50 hover:text-ink"}`}
            >
              {label}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[12px] text-muted">This only narrows Permissions: a bot still asks wherever any chat would.</p>
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onDone} className="h-8 rounded-full px-3 text-[13px] text-muted hover:text-ink">
          Cancel
        </button>
        <button disabled={!ready} onClick={save} className="h-8 rounded-full bg-ink px-4 text-[13px] font-medium text-white hover:bg-black disabled:opacity-40">
          {draft.id ? "Save" : "Add bot"}
        </button>
      </div>
    </div>
  );
}
