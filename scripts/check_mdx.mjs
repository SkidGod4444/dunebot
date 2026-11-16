// Compiles every chat history file (.mdx) in a folder with the real MDX compiler, so a message the
// escaping got wrong shows up as a failure. Usage: node scripts/check_mdx.mjs <folder>
import { compile } from "@mdx-js/mdx";
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".mdx"));
let bad = 0;
for (const f of files) {
  try {
    await compile(fs.readFileSync(path.join(dir, f), "utf8"));
  } catch (e) {
    bad++;
    console.error(`${f}: ${e.message}`);
  }
}
console.log(`${files.length - bad} of ${files.length} history files compile`);
process.exit(bad ? 1 : 0);
