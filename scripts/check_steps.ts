// The answer card's step line (ui/src/steps.ts): the words for each step, shortcuts as the keyboard
// shows them, and never the typed text. `bun scripts/check_steps.ts`
import { keysShown, stepLine } from "../ui/src/steps";

let failed = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
};
const tool = (name: string, status: string, args: Record<string, unknown> = {}) =>
  ({ id: "1", threadId: "t", role: "tool", text: "", meta: { tool: name, status, args }, createdAt: 0 }) as any;

eq("click running", stepLine(tool("click", "running", { what: "the address bar" }), "darwin"), "Clicking the address bar");
eq("click done", stepLine(tool("click", "done", { what: "the address bar" }), "darwin"), "Clicked the address bar");
eq("right click", stepLine(tool("click", "running", { what: "the file", button: "right" }), "win32"), "Right-clicking the file");
eq("double click", stepLine(tool("click", "done", { what: "the file", count: 2 }), "linux"), "Double-clicked the file");
eq("click failed", stepLine(tool("click", "failed", { what: "the address bar" }), "darwin"), "Couldn't click");
eq("look", stepLine(tool("look_at_screen", "running"), "darwin"), "Looking at your screen");
eq("drag", stepLine(tool("drag", "running", { what: "the PDF to the Desktop" }), "darwin"), "Dragging the PDF to the Desktop");
eq("typing never shows the text", stepLine(tool("type_text", "running", { text: "hunter2", what: "the password field" }), "darwin"), "Typing into the password field");
eq("typing with no place", stepLine(tool("type_text", "done", { text: "11 characters" }), "darwin"), "Typed");
eq("keys on macOS", stepLine(tool("press_keys", "running", { keys: "cmd+shift+t", what: "reopen a tab" }), "darwin"), "Pressing ⇧⌘T");
eq("keys on Windows", stepLine(tool("press_keys", "done", { keys: "cmd+shift+t" }), "win32"), "Pressed Ctrl+Shift+T");
eq("keys on Linux", keysShown("super+enter", "linux"), "Win+Return");
eq("a single key", keysShown("escape", "darwin"), "Escape");
eq("command", stepLine(tool("run_command", "running", { command: "rm -rf ~" }), "darwin"), "Running a command");
eq("an unknown step running", stepLine(tool("something_new", "running"), "darwin"), "Working");
eq("an unknown step done", stepLine(tool("something_new", "done"), "darwin"), null);
eq("not a step", stepLine({ ...tool("click", "running"), role: "assistant" }, "darwin"), null);

console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
