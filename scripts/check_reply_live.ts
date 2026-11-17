// The reply attacks (scripts/reply_samples.ts) sent through the real app in hidden windows (the
// chats window and the answer beside the pointer), with the test agent echoing them back as its reply. Passes when:
//  - the window tries no request for anything in the reply (pictures, frames, styles, forms…);
//  - nothing in a reply ran (window.__pwned stays unset);
//  - the page made no core call beyond the ones this check makes itself (no card answered, no
//    setting changed, nothing added);
//  - the reply holds no element that runs or loads, no handler, no javascript: link.
// Usage: bun scripts/check_reply_live.ts      (Linux: under xvfb-run)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ATTACKS, H } from "./reply_samples";

const root = path.resolve(import.meta.dir, "..");
const electron = path.join(root, "node_modules", "electron", "cli.js");
const exe = process.platform === "win32" ? ".exe" : "";
const core = path.join(root, "core", "target", "debug", `dunebot-core${exe}`);

// Built pages carry a content security policy (vite.config.ts) that refuses anything from outside,
// and every refusal is reported to the page. The page's own outside picture must be refused (the
// policy is on and the listener hears it); nothing in the reply may cause a refusal (it tried to load
// nothing). Dunebot Dev runs without the policy, so the reply's elements are checked too.
const text = ATTACKS;
const CONTROL = `${H}/control`;

const PAGE = `(async () => {
  const dm = window.__dm;
  const refused = [];
  document.addEventListener("securitypolicyviolation", (e) => refused.push(e.blockedURI));
  const t = await window.dunebot.call("threads.create", { agent: "echo", cwd: "~" });
  if (location.hash === "#caption") dm.caption({ threadId: t.id, side: "below", align: "left", speak: false });
  await dm.openThread(t.id);
  dm.set({ activeId: t.id });
  await dm.send(t.id, ${JSON.stringify(text)});
  const end = Date.now() + 20000;
  const done = () => (dm.get().messages[t.id] ?? []).some((m) => m.role === "assistant" && m.meta.status === "done");
  while (Date.now() < end && !done()) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 2500)); // the reply finishes appearing; anything it loads has time to
  // Control: the page itself loads one picture from the server, so a silent server can't pass.
  await new Promise((r) => { const img = new Image(); img.onload = img.onerror = r; img.src = ${JSON.stringify(CONTROL)}; });
  await new Promise((r) => setTimeout(r, 200));
  const md = [...document.querySelectorAll(".md")];
  const inside = (sel) => md.flatMap((b) => [...b.querySelectorAll(sel)]);
  return {
    done: done(),
    refused,
    pwned: window.__pwned ?? null,
    elements: inside("img,iframe,script,style,link,video,audio,source,object,embed,form,meta,base,math,frame,picture,svg:not(.lucide),input:not([type=checkbox])").map((e) => e.tagName),
    handlers: inside("*").filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).length,
    jsLinks: inside("a").filter((a) => /^\\s*javascript:/i.test(a.getAttribute("href") ?? "")).length,
    arrived: md.some((b) => b.textContent.includes("a list item")),
  };
})();`;

const MINE = new Set(["threads.create", "threads.get", "threads.send", "threads.list", "threads.changes", "settings.get", "agents.list"]);
let failed = 0;
const fail = (what: string) => {
  failed++;
  console.error("FAIL", what);
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dunebot-reply-live-"));
const script = path.join(dir, "page.js");
fs.writeFileSync(script, PAGE);

for (const view of ["main", "caption"]) {
  const shot = path.join(dir, `${view}.png`);
  const args = [electron, "."];
  if (process.platform === "linux") args.push("--no-sandbox");
  const child = spawn("node", args, {
    cwd: root,
    env: {
      ...process.env,
      DUNEBOT_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "dunebot-snap-")),
      DUNEBOT_APPROVAL_MIN_MS: "0",
      DUNEBOT_CORE: core,
      DUNEBOT_SNAPSHOT: shot,
      DUNEBOT_SNAPSHOT_VIEW: view,
      DUNEBOT_SNAPSHOT_THEME: "light",
      DUNEBOT_SNAPSHOT_MATERIAL: "none",
      DUNEBOT_SNAPSHOT_SCRIPT: script,
      DUNEBOT_SNAPSHOT_CALLS: "1",
      DUNEBOT_SNAPSHOT_WAIT: "300",
      DUNEBOT_CODEMAX: path.join(root, "no-codemax-for-snapshots"),
    },
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  let killed = false;
  const timer = setTimeout(() => ((killed = true), child.kill()), 90_000);
  await new Promise((r) => child.on("exit", r));
  clearTimeout(timer);
  const failedBefore = failed;
  // Linux CI twice hung here until the kill with the reply missing: show the app's own words then.
  const showLog = () => failed > failedBefore && console.error(`--- ${view}: the app's log${killed ? " (stopped after 90 s: it never quit)" : ""} ---\n${log.slice(-3000)}\n---`);
  const resultFile = shot.replace(/\.png$/, ".script.json");
  if (!fs.existsSync(resultFile)) {
    fail(`${view}: no result\n${log.slice(-1500)}`);
    continue;
  }
  const r = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  const calls = [...new Set([...log.matchAll(/page call: ([\w.]+)/g)].map((m) => m[1]))];
  const others = calls.filter((c) => !MINE.has(c));
  if (!r.done) fail(`${view}: the reply never finished`);
  if (r.pwned !== null) fail(`${view}: something in the reply ran (__pwned = ${r.pwned})`);
  if (r.elements.length) fail(`${view}: reply holds ${r.elements.join(", ")}`);
  if (r.handlers) fail(`${view}: ${r.handlers} element(s) with handlers`);
  if (r.jsLinks) fail(`${view}: ${r.jsLinks} javascript: link(s)`);
  if (!r.arrived) fail(`${view}: the reply's text isn't on the page (did it arrive?)`);
  if (!calls.includes("threads.send")) fail(`${view}: call log missing (DUNEBOT_SNAPSHOT_CALLS)`);
  if (others.length) fail(`${view}: the page made calls of its own: ${others.join(", ")}`);
  const refused: string[] = r.refused;
  if (!refused.includes(CONTROL)) fail(`${view}: control: the page's own outside picture wasn't refused, so this check proves nothing (refused: ${refused.join(", ") || "none"})`);
  const fromReply = refused.filter((u) => u !== CONTROL);
  if (fromReply.length) fail(`${view}: the reply tried to load ${[...new Set(fromReply)].join(", ")}`);
  showLog();
  console.log(`${failed ? "FAIL" : "ok  "} ${view}: the reply loaded nothing (only the control was refused), ${calls.length} kinds of call (${calls.join(", ")}), nothing ran`);
}
console.log(failed ? `${failed} problem(s)` : "ALL PASS");
process.exit(failed ? 1 : 0);
