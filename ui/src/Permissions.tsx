import { ShieldCheck } from "lucide-react";
import { setMode, useStore } from "./store";
import { Segmented, PageShell } from "./ui";
import { Connectors, isConnectorAction } from "./Connectors";
import { BotsSettings } from "./BotsSettings";
import { PhoneSettings } from "./Phone";

const MODES = [
  ["auto", "Auto"],
  ["always", "Always"],
  ["ask", "Ask me"],
  ["never", "Never"],
] as const;

const PROTECTED = [
  "SSH and GPG keys",
  "Cloud, git and package-manager logins",
  "Keychains and password stores",
  "Browser profiles and cookies",
  "Messages and Mail data",
  ".env secret files",
  "Dune Bot's own settings and approvals",
];

export function Permissions() {
  const modes = useStore((s) => s.modes);
  return (
    <PageShell title="Permissions" intro="What agents may do on this computer, with your accounts and from your phone. These apply to every chat. The look, keys and voice are in Settings.">
      <div className="mt-6 divide-y divide-line rounded-2xl border border-line">
        {modes.filter((r) => !isConnectorAction(r.action)).map((r) => (
          <div key={r.action} className="px-4 py-3.5">
          <div className="flex items-center gap-4">
            <span className="flex-1 text-[15px] font-medium">{r.label}</span>
            <Segmented
              label={r.label}
              value={r.mode}
              options={MODES.filter(([k]) => (r.choices ?? ["always", "ask", "never"]).includes(k))}
              onChange={(k) => setMode(r.action, k)}
            />
          </div>
          {r.mode === "auto" && (
            <p className="mt-1.5 text-[13px] text-muted">
              Commands run without asking unless they're risky: deleting or saving files, running code, admin, other apps or the screen, sending data online, changing git, installing. Those ask, and the card says why. Scheduled chats always ask. Always: no cards at all.
            </p>
          )}
          {r.mode === "always" && (r.action === "run-command" || r.action === "write-file") && (
            <p data-always-warning className="mt-1.5 text-[13px] text-ink">
              {r.action === "run-command"
                ? "Always: every command runs without a card, risky ones too (deleting, installing, sending data online)."
                : "Always: files are created and changed without a card (never the off-limits ones below)."}{" "}
              Scheduled chats still ask.
            </p>
          )}
          {r.action === "click" && r.mode !== "never" && (
            <p className="mt-1.5 text-[13px] text-muted">
              A click, scroll or drag where an agent saw something on your screen (a tab, a button, a list): the pointer glides there like a hand. Move the mouse to stop it. Never on Dune Bot itself. {window.dunebot.platform === "darwin" ? "macOS asks once to let Dune Bot control the computer. " : window.dunebot.platform === "linux" ? "Linux: X11 desktops only (Wayland doesn't allow it). " : ""}Scheduled chats always ask.
            </p>
          )}
          {r.action === "type" && r.mode !== "never" && (
            <p className="mt-1.5 text-[13px] text-muted">
              Typing and shortcuts in the app you're in, at a person's pace. This can do whatever you could at the keyboard, including Return in Terminal. Move the mouse to stop it. Never into Dune Bot itself. The activity log keeps how many characters, never the text. Scheduled chats always ask.
            </p>
          )}
          {r.action === "look-screen" && r.mode !== "never" && (
            <p className="mt-1.5 text-[13px] text-muted">
              A picture of the screen under your pointer, when an agent needs to see it. It goes only to that agent; Dune Bot keeps none. Scheduled chats always ask.
            </p>
          )}
          </div>
        ))}
      </div>
      <h2 className="mt-8 mb-2.5 text-[12px] font-semibold tracking-[.08em] text-muted uppercase">Connectors</h2>
      <Connectors />
      <h2 className="mt-8 mb-2.5 text-[12px] font-semibold tracking-[.08em] text-muted uppercase">Phone</h2>
      <PhoneSettings />
      <h2 className="mt-8 mb-2.5 text-[12px] font-semibold tracking-[.08em] text-muted uppercase">Bots</h2>
      <BotsSettings />
      <h2 className="mt-8 mb-2.5 text-[12px] font-semibold tracking-[.08em] text-muted uppercase">Off limits to file tools</h2>
      <div className="rounded-2xl bg-side px-4 py-3.5">
        <p className="text-[14px] text-ink/70">Dune Bot's file tools never read or change these, whatever the settings above say:</p>
        <ul className="mt-2 grid gap-1 text-[14px] sm:grid-cols-2">
          {PROTECTED.map((p) => (
            <li key={p} className="flex items-center gap-2">
              <ShieldCheck size={14} className="shrink-0 text-ink" />
              {p}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[13px] text-ink">A command you allow runs with your full access and can reach these. Read command cards before you allow them.</p>
      </div>
    </PageShell>
  );
}
