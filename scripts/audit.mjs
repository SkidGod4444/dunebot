// What every view would trip a person up on, from a snapshot run with the audit on:
//   DUNEBOT_SNAPSHOT_AUDIT=1 node scripts/snapshots.mjs <dir> && node scripts/audit.mjs <dir> [--all] [--max kind=n,...]
// One line per view and theme with the count of each kind (electron/main.mjs AUDIT), then the
// examples of the kinds that aren't zero (--all: every one). --max fails the run when a kind's total
// is above its number, so a fixed kind stays fixed.
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node scripts/audit.mjs <snapshot dir> [--all] [--max kind=n,...]");
const all = process.argv.includes("--all");
const maxArg = process.argv[process.argv.indexOf("--max") + 1];
const max = process.argv.includes("--max") ? Object.fromEntries(maxArg.split(",").map((s) => s.split("=")).map(([k, v]) => [k, Number(v)])) : {};
const KINDS = ["cursor", "name", "keyboard", "focus", "contrast", "clipped", "offWindow"];
const total = Object.fromEntries(KINDS.map((k) => [k, 0]));
const rows = [];
let views = 0;
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".script.json")).sort()) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  if (!j.audit) continue;
  views++;
  const view = f.replace(/\.json$/, "").replace(/^[a-z0-9]+-/, "");
  if (j.audit.error) {
    rows.push(`${view.padEnd(34)} audit failed: ${j.audit.error}`);
    continue;
  }
  for (const k of KINDS) total[k] += j.audit[k].length;
  rows.push(`${view.padEnd(34)} ${String(j.audit.clickables).padStart(3)} clickables  ${KINDS.map((k) => `${k} ${j.audit[k].length}`).join("  ")}`);
  for (const k of KINDS)
    for (const ex of j.audit[k].slice(0, all ? Infinity : 4)) rows.push(`    ${k}: ${ex}`);
}
if (!views) throw new Error(`no audited views in ${dir} (run the snapshots with DUNEBOT_SNAPSHOT_AUDIT=1)`);
console.log(rows.join("\n"));
console.log(`\n${views} views: ${KINDS.map((k) => `${k} ${total[k]}`).join(", ")}`);
const over = Object.entries(max).filter(([k, n]) => total[k] > n);
if (over.length) {
  console.log(`FAIL ${over.map(([k, n]) => `${k} ${total[k]} > ${n}`).join(", ")}`);
  process.exit(1);
}
