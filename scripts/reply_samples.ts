// Reply samples shared by scripts/check_reply.tsx and scripts/check_reply_live.ts.
export const MARKDOWN = `## Plan

This **deletes** \`~/old-builds\`, so back it up first.

1. Install: run \`bun install\` in \`apps/web\`.
2. Check: press ⌘R to reload. Types like Array<string> and <Provider store={s}> stay as written.

\`\`\`sh
bun install && bun test
\`\`\`

| Tests | Result |
|---|---|
| unit | passing |

> A quote, and [a link](https://example.com).`;

export const H = "http://127.0.0.1:9";
export const ATTACKS = `<script>window.__pwned=1</script>
<img src="${H}/i.png" onerror="window.__pwned=2">
![pic](${H}/m.png)
<iframe src="${H}/f"></iframe>
<Callout type="warning" title="t" onclick="window.__pwned=3" style="background:url(${H}/s)" class="x" href="${H}/h">body</Callout>
{window.__pwned=4}
import x from "${H}/x.js"
export const y = fetch("${H}/e")
<a href="javascript:window.__pwned=5">link</a>
<svg onload="window.__pwned=6"><circle/></svg>
<details open ontoggle="window.__pwned=7"><summary>s</summary>d</details>
<style>body{background:url(${H}/css)}</style>
<link rel="stylesheet" href="${H}/l.css">
<video src="${H}/v.mp4" autoplay></video>
<object data="${H}/o"></object>
<form action="${H}/f"><input name=a></form>
<meta http-equiv="refresh" content="0;url=${H}/r">
<base href="${H}/">
<File path="x" onmouseover="window.__pwned=8" />
<Badge tone="good" style="color:red">ok</Badge>
<math><mi xlink:href="javascript:alert(1)">x</mi></math>
<IMG SRC=${H}/u.png>
<Step title="s" data-x="1" id="evil" tabindex="1">step</Step>
> \`\`\`js
> a quote whose code never closes
<img src="${H}/after-quote.png" onerror="window.__pwned=11">
- a list item
  continued <link rel="stylesheet" href="${H}/list.css"> here

  <style>.md{display:none}</style>
1. A list item

    with indented text <img src="${H}/indented.png" onerror="window.__pwned=10"> in it
<img src=x onerror=window.__pwned=9 `;

