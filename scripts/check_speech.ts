// What Dunebot reads aloud (ui/src/speak.ts): the words of a reply, never its code, paths, links or
// tags, a sentence at a time while it arrives, never cutting inside a code block.
// Usage: bun scripts/check_speech.ts
import { plainForSpeech, sentenceEnds } from "../ui/src/speak";
import { MARKDOWN } from "./reply_samples";

let failed = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`FAIL ${what}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  }
};
const lacks = (what: string, text: string, bad: RegExp) => {
  if (bad.test(text)) {
    failed++;
    console.error(`FAIL ${what}: ${JSON.stringify(text.match(bad)?.[0])} in ${JSON.stringify(text)}`);
  }
};

eq("plain words stay", plainForSpeech("Hi! What can I help you with?"), "Hi! What can I help you with?");
eq("bold and a heading", plainForSpeech("## Done\n\nIt's **fixed** now."), "Done\nIt's fixed now.");
eq("a link says its words", plainForSpeech("See [the guide](https://example.com/x) or https://example.com."), "See the guide or a link.");
eq("a short code word is said", plainForSpeech("Run `bun install` first."), "Run bun install first.");
eq("a path is left out", plainForSpeech("It's in ~/Downloads/report.pdf now."), "It's in now.");
eq("a long command is left out", plainForSpeech("Run `du -sh ~/Downloads/* | sort -rh`."), "Run.");
eq("a code block is left out", plainForSpeech("Use this:\n\n```sh\necho hi\n```\n\nThen reload."), "Use this:\nThen reload.");
eq("a code block still arriving", plainForSpeech("Use this:\n\n```ts\nconst a = 1;"), "Use this:");
eq("list markers", plainForSpeech("- one\n- two\n1. three"), "one\ntwo\nthree");
eq("a tag keeps its words", plainForSpeech("<b>This</b> **deletes** it."), "This deletes it.");
eq("keys", plainForSpeech("Press <kbd>⌘</kbd> <kbd>R</kbd>."), "Press ⌘ R.");
for (const [name, text] of [["markdown", MARKDOWN]] as const) {
  const said = plainForSpeech(text);
  lacks(`${name}: no tags`, said, /<\/?[A-Za-z]/);
  lacks(`${name}: no Markdown marks`, said, /\*\*|`|^#|\]\(/m);
  lacks(`${name}: no paths`, said, /(^|\s)~?\/\w/);
}

// Sentences: each finished one, the last only once it can't grow, none inside a code block.
const reply = "First one. Second one!\n\n```sh\necho a. b.\n```\n\nVersion 3.5 is out";
/** What would be said, in order: the words of each finished piece. */
const said = (t: string, final: boolean) => {
  let at = 0;
  const out: string[] = [];
  for (const end of sentenceEnds(t, 0, final)) {
    const w = plainForSpeech(t.slice(at, end));
    at = end;
    if (w) out.push(w);
  }
  return out;
};
eq("sentences while arriving (none inside code)", said(reply, false), ["First one.", "Second one!"]);
eq("all of it once it's here", said(reply, true), ["First one.", "Second one!", "Version 3.5 is out"]);
eq("3.5 isn't a sentence end", sentenceEnds("Version 3.5 is out", 0, false), []);
eq("the rest once it's all here", sentenceEnds("Version 3.5 is out", 0, true), [18]);
eq("nothing twice", sentenceEnds("One. Two.", 5, true), [9]);
eq("Hindi sentences end at ।", said("आपके फ़ोल्डर में 12 फ़ाइलें हैं। सबसे बड़ी वीडियो है। और", false), ["आपके फ़ोल्डर में 12 फ़ाइलें हैं।", "सबसे बड़ी वीडियो है।"]);
eq("Hinglish too", said("Downloads में 960 files हैं। Total 4 GB.", true), ["Downloads में 960 files हैं।", "Total 4 GB."]);
eq("the name is said as two words", said("I'm Dunebot, and DUNEBOT runs here.", true), ["I'm Dune Bot, and Dune Bot runs here."]);

console.log(failed ? `${failed} problem(s)` : "ALL PASS");
process.exit(failed ? 1 : 0);
