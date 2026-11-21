import { useEffect, useState } from "react";
import { call, errorText, openThread, toast, useStore, type Fix } from "./store";
import { DeleteButton, LoadProblem } from "./parts";
import { when } from "./format";
import { isSendKey, PageShell, Switch } from "./ui";

/** Every failure with the user's fix for it. Switched-on fixes are notes agents read. */
export function Fixes() {
  const [rows, setRows] = useState<Fix[] | null>(null);
  const [text, setText] = useState("");
  const threads = useStore((s) => s.threads);
  const [failed, setFailed] = useState("");
  const [adding, setAdding] = useState(false);
  const load = () =>
    call<Fix[]>("fixes.list").then(
      (r) => (setRows(r), setFailed("")),
      (e) => setFailed(errorText(e)),
    );
  useEffect(() => {
    load();
  }, []);
  // True when it worked; a refusal is a toast and leaves what you typed.
  const act = (p: Promise<unknown>) =>
    p.then(
      () => (load(), true),
      (e) => (toast(errorText(e)), false),
    );
  async function add() {
    if (!text.trim() || adding) return;
    setAdding(true);
    if (await act(call("fixes.add", { fix: text }))) setText("");
    setAdding(false);
  }
  return (
    <PageShell
      title="Fixes"
      wide
      intro={
        <>
          When an agent gets something wrong, press "Teach a fix" under it. Agents read the fixes that are on: every new chat
          gets all of them. Fixes never change what agents may do; that's Permissions.
        </>
      }
    >
      <div className="mt-6 flex items-end gap-2 rounded-2xl border border-line p-2 pl-4">
        <textarea
          rows={1}
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (isSendKey(e)) {
              e.preventDefault();
              add();
            }
          }}
          aria-label="Add a fix of your own"
          placeholder="Add a fix of your own, e.g. Use bun, never npm"
          className="min-h-9 flex-1 resize-none bg-transparent py-2 text-[14px] outline-none placeholder:text-muted select-text"
        />
        <button disabled={!text.trim() || adding} onClick={add} className="h-9 rounded-full bg-ink px-4 text-[13.5px] font-medium text-white hover:bg-black disabled:opacity-40">
          Add
        </button>
      </div>
      <div className="mt-4 divide-y divide-line rounded-2xl border border-line">
        {!rows && failed && <LoadProblem what="your fixes" why={failed} retry={load} />}
        {rows?.length === 0 && <p className="px-4 py-6 text-center text-[14px] text-muted">No fixes yet.</p>}
        {rows?.map((f) => {
          const chat = f.threadId ? threads.find((t) => t.id === f.threadId) : undefined;
          return (
            <div key={f.id} data-fix={f.enabled ? "on" : "off"} className="flex items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className={`text-[14.5px] font-medium select-text ${f.enabled ? "text-ink" : "text-muted"}`}>{f.fix}</p>
                <p className="mt-0.5 truncate text-[12.5px] text-muted select-text" title={[f.failure, f.detail].filter(Boolean).join("\n")}>
                  {f.failure}
                  {f.detail && <span className="font-mono text-[11.5px]"> · {f.detail}</span>}
                </p>
                <p className="mt-1 text-[12px] tabular-nums text-muted">
                  {when(f.createdAt)}
                  {chat && (
                    <>
                      {" · "}
                      <button onClick={() => openThread(chat.id)} className="underline-offset-2 hover:text-ink hover:underline">
                        {chat.title}
                      </button>
                    </>
                  )}
                </p>
              </div>
              <Switch
                on={f.enabled}
                label="Agents read this fix"
                title={f.enabled ? "On: agents read it" : "Off: agents don't see it"}
                onClick={() => act(call("fixes.set", { id: f.id, enabled: !f.enabled }))}
              />
              <DeleteButton
                what="fix"
                body="Agents stop reading it. To keep it without agents seeing it, switch it off instead."
                onDelete={() => act(call("fixes.delete", { id: f.id }))}
              />
            </div>
          );
        })}
      </div>
    </PageShell>
  );
}
