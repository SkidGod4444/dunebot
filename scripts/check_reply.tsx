// Renders replies the way the pages do (ui/src/reply.tsx: AI Elements' MessageResponse on
// Streamdown), without a window:
//  1. every partial state of a streamed reply renders without an error, and Markdown never shows
//     as a blank bubble;
//  2. Markdown renders as Markdown: a heading, a list, code, a table, a quote, a link; words in
//     angle brackets (Array<string>) are shown as written, never dropped;
//  3. nothing in a reply can run or load anything: no scripts, frames, pictures, styles, forms or
//     handlers, no javascript: links. Streamdown alone, as AI Elements ships it, loads pictures:
//     the control proves this check would catch that.
// Usage: bun scripts/check_reply.tsx        (the live check in a window: scripts/check_reply_live.ts)
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Streamdown } from "streamdown";
import { Reply } from "../ui/src/reply";

import { ATTACKS, H, MARKDOWN } from "./reply_samples";

const ORDINARY = [
  "1. ```tsx\n   <Provider store={s}>\n   ```\n\n> ```tsx\n> <Provider store={s}>\n> ```\n\n- ``` not a fence ``` and <b>bold</b>",
  "## Plan\n\n1. Read **the file**\n2. Fix `a < b`\n\n```ts\nconst x: Array<string> = [];\nif (a<b) {}\n```\n\n> quote\n\n| a | b |\n|---|---|\n| 1 | 2 |",
  "Use <b>bold</b>, <details><summary>More</summary>hidden</details>, a <https://example.com> link and [text](https://example.com). Also a < b and x <= y.",
  "Plain text with {braces} and an email hello@example.com.\n\n- [ ] task\n- [x] done",
];

let failed = 0;
const fail = (what: string) => {
  failed++;
  console.error("FAIL", what);
};
const render = (text: string, streaming: boolean) => renderToStaticMarkup(createElement(Reply, { text, streaming }));
const plainText = (html: string) => html.replace(/<[^>]*>/g, "").replace(/\s+/g, "");

// 1. every partial state (an attack line that is only a removed <script> may render as nothing)
for (const [name, sample, blankOk] of [["markdown", MARKDOWN, false], ["attacks", ATTACKS, true], ...ORDINARY.map((o, i) => [`ordinary ${i + 1}`, o, false])] as const) {
  let errors = 0;
  let blank = 0;
  for (let n = 1; n <= sample.length; n++) {
    const part = sample.slice(0, n);
    try {
      const html = render(part, true);
      if (!blankOk && part.trim().length > 12 && !plainText(html) && !html.includes('aria-label="Working"')) blank++;
      if (bad(html)) fail(`${name}: something that runs or loads at ${n} characters: ${bad(html)}`);
    } catch (e) {
      if (errors++ < 3) fail(`${name}: error at ${n} characters: ${(e as Error).message}`);
    }
  }
  if (blank) fail(`${name}: blank bubble at ${blank} partial states`);
  console.log(`${errors || blank ? "FAIL" : "ok  "} ${name}: all ${sample.length} partial states render`);
}

// 2. Markdown
const md = render(MARKDOWN, false);
const b2 = failed;
for (const [what, re] of [
  ["heading", /<h2[^>]*>Plan<\/h2>/],
  ["bold", /data-streamdown="strong"[^>]*>deletes</],
  ["numbered list", /<ol[^>]*>/],
  ["inline code", /<code[^>]*>~\/old-builds<\/code>/],
  ["code block", /data-streamdown="code-block"/],
  ["table", /<table[^>]*>/],
  ["quote", /<blockquote[^>]*>/],
  ["link", /<a[^>]*href="https:\/\/example\.com\/?"/],
  ["words in angle brackets", /Array&lt;string&gt; and &lt;Provider store=\{s\}&gt; stay/],
] as const)
  if (!re.test(md)) fail(`markdown: no ${what}`);
console.log(`${failed > b2 ? "FAIL" : "ok  "} Markdown renders as Markdown`);

// 3. the attacks, finished
const before = failed;
const out = render(ATTACKS, false);
if (bad(out)) fail(`attacks: ${bad(out)}`);
// (A Markdown picture inside the attacks is part of an HTML block, so it shows as text there.)
const pic = render(`Not a picture: ![chart](${H}/chart.png) and <${H}/x.png>`, false);
if (!/Image blocked/i.test(pic) || bad(pic)) fail(`a Markdown picture isn't blocked: ${bad(pic) ?? "no notice"}`);
// HTML is shown as written, so no word of it is lost.
for (const t of ["&lt;script&gt;", "&lt;iframe", "&lt;img", "&lt;IMG", "&lt;style&gt;", "&lt;svg", "&lt;File path=", "&lt;Callout"]) if (!out.includes(t)) fail(`attacks: ${t} not shown as text`);
console.log(`${failed > before ? "FAIL" : "ok  "} nothing in ${ATTACKS.split("\n").length} attack lines runs or loads`);
// Control: the same lines through Streamdown as it ships (what AI Elements uses as is) must be
// caught, or this check proves nothing.
const old = renderToStaticMarkup(createElement(Streamdown, { mode: "static", controls: false, lineNumbers: false, linkSafety: { enabled: false } }, ATTACKS));
const caught = bad(old);
const loads = (old.match(/<img[^>]*\ssrc="http/g) ?? []).length;
if (!caught || !loads) fail("control: the check finds no outside picture in plain Streamdown, so it can't be trusted");
console.log(`${caught && loads ? "ok  " : "FAIL"} control: plain Streamdown loads ${loads} outside picture(s) from the same lines`);

console.log(failed ? `${failed} problem(s)` : "ALL PASS");
process.exit(failed ? 1 : 0);

/** What in rendered markup could run or load something, or null. */
function bad(html: string): string | null {
  // Allowed: disabled checkboxes (Markdown task lists; sanitising turns any <input> into one) and the
  // app's own icons.
  const cleaned = html.replace(/<input (?=[^>]*\bdisabled="")(?=[^>]*\btype="checkbox")[^>]*>/g, "").replace(/<svg [^>]*class="lucide[^"]*"[^]*?<\/svg>/g, "");
  const tag = cleaned.match(/<(script|iframe|img|style|link|video|audio|source|object|embed|form|input|meta|base|svg|math|frame|frameset|picture)\b/i);
  if (tag) return `<${tag[1]}> element`;
  // Inside tags only: a reply's own text may say "onerror=" (its "<" is shown as text, &lt;).
  const on = html.match(/<[a-z][^>]*\s(on[a-z]+)\s*=/i);
  if (on) return `handler ${on[1]}`;
  if (/(href|src|action|data|xlink:href)\s*=\s*"\s*javascript:/i.test(html)) return "javascript: link";
  if (/<[a-z][^>]*\ssrc\s*=/i.test(html)) return "src attribute";
  if (/\sstyle="[^"]*url\(/i.test(html)) return "style that loads";
  if (/class="x"/.test(html)) return "class from the reply";
  return null;
}
