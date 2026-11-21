import { memo, type ComponentProps } from "react";
import { Streamdown, defaultRehypePlugins } from "streamdown";
import { code } from "@streamdown/code";
import { harden } from "rehype-harden";

/**
 * Agent replies: plain Markdown, drawn by AI Elements' `MessageResponse` (Streamdown with its code
 * highlighting; github.com/vercel/ai-elements, Apache-2.0). Dune Bot adds no tags of its own.
 *
 * Kept from AI Elements: Streamdown's defaults (GitHub Markdown, finishing half-arrived Markdown
 * while a reply streams) and its code plugin.
 * Left out: its math, diagram (mermaid) and CJK plugins, which replies here don't need.
 * Changed, because a reply is untrusted text and often about code:
 *  - HTML in a reply is shown as written, never parsed (no `rehype-raw`). Parsed, sanitising
 *    silently dropped words: "Array<string>" showed as "Array", "<File … />" vanished.
 *  - Pictures are never loaded (Streamdown loads any by default; that would send a request out
 *    without asking, and could carry what an agent saw on the screen).
 *  - Links may only be http(s) or mailto. Opening one goes through the window guard in
 *    electron/main.mjs, which hands only those to the system.
 */
const REHYPE = [
  defaultRehypePlugins.sanitize,
  [
    harden,
    {
      allowedImagePrefixes: [],
      allowDataImages: false,
      allowedLinkPrefixes: ["*"],
      allowedProtocols: ["http", "https", "mailto"],
      blockedImageClass: "dm-blocked",
      blockedLinkClass: "dm-blocked",
    },
  ],
] as ComponentProps<typeof Streamdown>["rehypePlugins"];

const PLUGINS = { code };
const THEMES: ["github-dark", "github-dark"] = ["github-dark", "github-dark"];

// The code colours load on first use, which paused a streaming reply once (~60 ms, measured) at
// its first code block. Load them while the window is idle instead, for the commonest languages.
if (typeof window !== "undefined") {
  const idle = window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 500));
  idle(() => {
    for (const language of ["ts", "tsx", "js", "sh", "bash", "json", "python", "rust"] as const)
      code.highlight({ code: "x", language, themes: THEMES }, () => {});
  });
}

/** AI Elements' MessageResponse, without its shadcn helpers (`cn`), with Dune Bot's settings. */
export const MessageResponse = memo(
  ({ className, ...props }: ComponentProps<typeof Streamdown>) => (
    <Streamdown
      className={`size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 ${className ?? ""}`}
      plugins={PLUGINS}
      rehypePlugins={REHYPE}
      shikiTheme={THEMES}
      controls={false}
      lineNumbers={false}
      linkSafety={{ enabled: false }}
      {...props}
    />
  ),
  (prev, next) => prev.children === next.children && prev.isAnimating === next.isAnimating,
);
MessageResponse.displayName = "MessageResponse";

/** The dots on a line of reply text's height, so a one-line reply replaces them without a jump. */
export function TypingLine() {
  return (
    <div className="flex h-[1.5em] items-center">
      <Typing />
    </div>
  );
}

export function Typing() {
  return (
    <span role="status" className="inline-flex h-5 items-center gap-1 px-0.5" aria-label="Working">
      {[0, 1, 2].map((i) => (
        <span key={i} className="dm-dot size-1.5 rounded-full bg-muted" style={{ animationDelay: `${i * 0.15}s` }} />
      ))}
    </span>
  );
}

export function Reply({ text, streaming }: { text: string; streaming: boolean }) {
  if (streaming && !text.trim()) return <TypingLine />;
  return (
    <MessageResponse mode={streaming ? "streaming" : "static"} isAnimating={streaming}>
      {text}
    </MessageResponse>
  );
}

/** A reply's first words for the chat list, without Markdown's marks. */
export function plainPreview(text: string) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>\n]*>/g, " ")
    .replace(/(^|\n)\s{0,3}(#{1,6}|>|[-*+]|\d{1,3}[.)])\s+/g, "$1")
    .replace(/\*+|__|~~|`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
