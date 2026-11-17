# Dune Bot

A desktop app where coding agents (Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity) do
things on your own computer, not in a cloud box. Every action goes through one gate in Rust that
asks you first when it should.

Dune Bot has no main window. It sits in the menu bar (tray on Windows/Linux).

- **macOS:** tap **⌥⌘** (both together, then let go) to open a small bar; type and press Enter.
  **Hold ⌥⌘** to talk: "Listening…" appears beside the pointer, and what you said is sent when you
  let go. Holding the bar's mic button does the same. The chord is read from the modifier-key state
  only, so it needs no Input Monitoring permission and never sees what you type; ⌥⌘ followed by
  another key or a click (⌥⌘Esc, ⌥⌘D, …) is ignored. If another app wants the same keys, pick others:
  ⌥⌘, ⌃⌥, ⌃⌘ or Right ⌘ alone (Permissions › Keys, or Keys in the menu bar). HeyClicky talks on ⌃⌥. Right ⌘ uses the left/right bits macOS adds to the modifier state; left ⌘ never fires it.
- **Windows/Linux:** Ctrl+Alt+Space (the tray menu shows the fallback if taken); hold the mic button to talk.
- **No chat on screen.** Once you ask, the bar closes and the answer appears in a small card beside
  the pointer and is read aloud with the system's voice (`ui/src/Caption.tsx`, `ui/src/speak.ts`).
  The card shows what's happening (working, a step running, an error) and any card waiting for your
  OK; it fades a few seconds after the answer has been read. Point at it to keep it, close it, or open
  the chat. It **follows the pointer** while it listens, works and reads the answer, never under the
  pointer and always on the screen (`electron/caption-place.mjs`). It holds still while a card waits
  for your OK, when it popped up in the corner, once the answer has been read, and as soon as you move
  the pointer toward it, so you can reach it to scroll or click. **Show last answer** (menu bar, or ↑
  in the empty bar) brings the last one back, held still and not read again. Questions asked from the bar carry a note asking the agent for one or two short sentences
  (`SPOKEN_NOTE` in `core/src/agent.rs`). Questions asked from the bar go on in one chat; the card
  shows only its latest answer. After a minute with no question or answer, "+" in the bar, or picking
  another agent, the next question starts a new one. Said while an answer is still coming, a question
  waits on the card as "Next: …" and is asked by itself once that answer has ended and been read
  aloud (nothing running is stopped; 30 s at most after it ends). If that answer is stopped, it goes
  in the bar's box instead (`ui/src/held.ts`). Talking never answers an OK card: the question waits
  under it ("Next, once you answer this:").
- When an agent needs your OK in a chat you didn't ask from the bar, the card appears in the screen's
  top corner without taking focus, and a notification says so. **Chats & activity…** in the tray menu
  opens the full history window.

**Voice** goes through [Sarvam AI](https://www.sarvam.ai) when you save your own Sarvam key
(Permissions › Voice): what you say becomes text with `saaras:v4` (English, Hindi and other Indian
languages, mixed too; recordings over 29 s go in parts cut at a quiet moment), and answers are read
aloud with `bulbul:v4-flash`: Hindi, Bengali, Tamil, Telugu, Gujarati, Kannada, Malayalam, Marathi,
Punjabi and Odia, each picked from the answer's script (Marathi when that's what you last spoke) and
read by a voice for that language (`speaker_for` in `core/src/sarvam.rs`); Hindi written in Latin
letters ("Rainbow tab banta hai…") is read as Hindi too. With your own [Deepgram](https://deepgram.com)
key saved too, **English answers are read in an American voice** (Aura-2 `aura-2-thalia-en`), and
answers in Hindi and other Indian languages stay with Sarvam; the answer's first sentence decides,
and a Hindi sentence later in an English answer is read whole by Sarvam after the English
(`core/src/deepgram.rs`, `core/src/speak_stream.rs`). **Ask in Hindi or Hinglish** (Devanagari, Latin
letters or the two mixed) and the answer is written in English, then read aloud in Hinglish: each
English sentence goes through Sarvam's translator (`mayura:v1`, code-mixed, ~1.5 s, so the first sound
comes ~2.2 s after the first sentence instead of ~0.4 s) and Sarvam's Hindi voice reads it; if
translating fails, the English is read as it is. Other Indian languages are answered and read as
before. Both are cloud voices, so they sound the same on every system. Reading aloud streams: the card opens one WebSocket (through the core, to the voice
you're likelier to need, from the language you last spoke) while you're still being written down,
sends each sentence the moment it's complete (Hindi ends at "।" too), and plays the audio as it
arrives through an AudioContext, so the first sound comes ~0.3–0.4 s after a sentence instead of
1–3 s. If the stream can't, sentences are fetched whole (the next while one plays), then the system
voice. **That sends your recording to Sarvam, and the words of each answer read aloud to Sarvam or
Deepgram.** Silence
and a blocked mic are turned back before anything is sent; Dune Bot saves no audio. Each key is locked
with Electron's `safeStorage` (the lock in the macOS Keychain, Windows DPAPI or the Linux secret
store; Linux without one won't keep it), unlocked only when voice first needs it, and handed to the
core over its stdin: never an environment variable, command line, page or log line. Without a key,
with Permissions › Voice on "This computer", or when Sarvam doesn't answer, voice runs on this
computer: whisper.cpp (English `small.en`, 190 MB, downloaded once from Hugging Face and checked
against its SHA-256) and the system voice. A recording stops itself after 60 s. The microphone is a
cargo feature (`voice`, on by default); cross-builds use `--no-default-features` (reading aloud by
Sarvam still works there).

**Look:** always dark, whatever the system is set to. On macOS 26+ the bar, setup and the history
sidebar sit on Apple's Liquid Glass (`NSGlassEffectView`), added by the
[`electron-liquid-glass`](https://github.com/Meridius-Labs/electron-liquid-glass) package (MIT,
pinned to 1.1.1; we also pin `node-gyp-build`, which it loads but doesn't list). The glass is Apple's Control Center
style, dark and tinted toward the page colour; the page paints its own solid dark fill over it
(`--dm-fill` in `ui/src/styles.css`), so nothing behind shows through; the glass adds its lit edge. Older macOS gets the system blur. Fonts: Geist, Geist Mono and Geist Pixel (Vercel,
SIL OFL), from the `geist` package. Our own addon in `native/` reads the notification
permission and a window's light/dark appearance, sets the glass's own corner radius in place (the
package only clips it, which leaves the edge light on square-ish corners), and logs what macOS
made of the glass (style, radius, light/dark) so a style that silently stopped working shows up in
the log. It links with `-fixup_chains` (Xcode 27's linker otherwise can write a library dyld
refuses: "mis-aligned LINKEDIT string pool"), and `bun run native` replaces the file rather than
writing over it (macOS kills a process that loads changed bytes at a path a running app has loaded).

**Where the bar opens:** tap ⌥⌘ and the bar opens as just the input, at the bottom center of the
screen. Menu bar → **Open the bar** picks bottom center, top center or next to the pointer. The
answer card sits below and to the right of the pointer where you asked (above or to the left near a
screen edge) and grows away from it; its window is a fixed size and see-through, so it never moves
while a reply arrives.

**Chat history:** every chat is saved as one MDX file in the data folder's `history/`
(macOS: `~/Library/Application Support/Dunebot/history/2026-11-15-<title>-<id>.mdx`): an
`export const meta` line, what you said, the replies, and `<Tool>` / `<Approval>` lines for what
the agent did. Rewritten when you send and when a turn ends, removed with the chat, backfilled at
start. A new chat's first message goes to the agent with a short record of your last few chats
from the past day (what you said and short replies, no tool output, at most ~4,000 characters), so
a follow-up in a fresh chat still knows what you meant; the chat shows only what you typed. The
files are an export: memory comes from the database, agents can't open Dune Bot's folder, and
editing a file changes nothing the agent sees. `node scripts/check_mdx.mjs <folder>` compiles
them; the smoke test does it with a deliberately awkward message.

**Long-term memory:** agents get a read-only `search_chats` tool over the database (never the MDX
files): with `query`, messages containing every word; without, the chats of the last `days` days;
with `chat`, one whole chat. It returns what you said and the replies, never tool output, and never
the chat that's asking. It's listed under "What agents may do" ("Search your past chats").

**First launch (and whenever macOS forgets a permission):** a setup window asks for everything
Dune Bot uses in one go: microphone (then checks sound really reaches the core), notifications,
Desktop/Documents/Downloads, and the speech model download. It never asks for Full Disk Access,
Accessibility, Screen Recording or Input Monitoring. Holding ⌥⌘ before the mic is allowed opens
setup instead of starting a recording (the system's permission box would otherwise eat what you
said). Reopen it from the menu bar: **Set up Dune Bot…**. macOS keys each answer to the app's
signature, so a shipped build needs a stable Developer ID signature or every update asks again.

## Run it

```sh
bun install
bun run build     # Rust core + window
bun run start     # opens Dune Bot
bun run dev       # same, with hot reload for the window
```

On macOS, `dev` and `start` run Dune Bot as its own small app, `.dev/Dunebot Dev.app` (a copy of
Electron with its own bundle id), started by macOS. So the microphone prompt names Dune Bot and the
permission goes to Dune Bot only, not to your terminal. Its output is in `$TMPDIR/dunebot-dev/app.log`. If the repo is under ~/Desktop or ~/Documents,
macOS asks once whether Dunebot Dev may read that folder (it loads its own code from there).

Agents run through `codemax serve`. In dev, Dune Bot uses `../codemax-cli/dist/codemax` if it
exists; otherwise set `DUNEBOT_CODEMAX=/path/to/codemax`. The Homebrew `codemax` must be new
enough to have `serve`.

## How it fits together

| Part | Language | Job |
|---|---|---|
| `core/` | Rust | Owns everything: chats, approvals, permissions, the activity log, the tool endpoint, starting agents |
| `electron/` | JS | Starts the core, passes calls and events to the window. No logic. |
| `ui/` | React + Tailwind | Draws what the core says. Sends only ids and choices. |

Agents run in codemax's `mcp-only` policy: their own file and shell tools are refused, so their only
way to act is Dune Bot's tools (`run_command`, `read_file`, `write_file`, `list_folder`,
`search_chats`, `look_at_screen`, `find_location`), served on a
loopback port with a separate token per chat.

## Safety

- **Auto / Ask / Always / Never** per action, set in Permissions. Defaults: commands are on Auto,
  file changes ask, reading and listing don't. **Auto** (commands only) runs a command without asking
  unless something in it is risky (`core/src/lookonly.rs`, parsed, never a guess): deleting, moving or
  saving files, admin, shells and interpreters, other apps, the screen, speakers, mic or clipboard,
  network beyond a plain fetch shown on screen (curl/wget uploads, data, other methods, saving),
  changing git, installs and builds, other agents, system settings. Those ask, and the card says why
  ("Asking because rm changes, moves, saves or deletes files"). Home-wide walks, `~/Library`, other disks, variables, private
  files, `/proc`, jq reading `env`, and Dune Bot's own data always ask. What runs unasked gets a clean
  environment (PATH, HOME, locale). Pattern matching can miss a disguised command, and a plain fetch
  can carry text in its address. On Windows Auto always asks. Scheduled chats always ask.
- `find_location` asks the system where the computer is (macOS Location Services; a Mac has no
  GPS, so the place comes from the Wi-Fi networks nearby: usually tens of metres with Wi-Fi on,
  rough or none without). Agents are told to use it for weather, "near me" and the like, never to
  guess from the internet address, and to pass the coordinates on (`wttr.in/LAT,LON`, which runs
  under Auto). It doesn't ask in Dune Bot (Permissions: "Find where you are", Always); macOS asks
  once. The place goes to the agent and the chat's tool card; the activity log and the logs get
  none. Windows and Linux: not yet (the agent asks you instead). Check: `scripts/core_location_turn.py`
  (a stand-in place, never the real one).
- `list_folder` counts a whole folder tree (`deep: true`: files, folders, sizes, the largest files)
  without asking, and agents are told to use it instead of a command.
- Approval cards are single use. "Allow all … in this chat" covers that one action type, in that chat only
  (history window only; the card beside the pointer offers just "Allow once" and "Don't allow", by
  mouse: it never takes keyboard focus). The core refuses any
  "allow" that arrives within half a second of the card appearing (`DUNEBOT_APPROVAL_MIN_MS`
  changes this for tests), so a stray click or keystroke can't approve a command nobody read.
- The file tools never touch, whatever the settings: SSH/GPG keys, cloud and package logins,
  keychains, browser profiles, Messages and Mail data, `.env` files, Dune Bot's own data.
  A command you allow runs with your full access and can reach these; the card shows it first.
- Stop ends the running command, not just the agent's turn. Cards left open when Dune Bot quits
  come back as expired.
- A replaced file is backed up first (`<data>/journal/<chat>/`).
- Every attempt is in the Activity log.
- The window has a strict CSP: model output can't load remote images or scripts.
- Replies are plain Markdown (below). Nothing in a reply is ever run or loaded.

## Replies

Agent replies are plain Markdown, drawn by AI Elements' `MessageResponse` (Streamdown with its
code highlighting; `ui/src/reply.tsx`). Dune Bot adds no tags of its own and tells agents nothing
about formatting, except that answers asked from the bar should be one or two plain sentences.

A reply is untrusted text, so three things differ from Streamdown as it ships:

- HTML is shown as written, never drawn, so `Array<string>` or `<div>` in prose keeps every word;
- pictures are never loaded (they show as "Image blocked");
- links may only be web pages (open in your browser) or email addresses (open a new mail).

Streamed text is shown at a steady pace (`ui/src/smooth.ts`). The card beside the pointer uses the
same renderer; only the words are read aloud (no code, paths, links or tags; up to three
sentences). Try it with the test agent: `stream` and `markdown`.

## Package it

```sh
bun run package    # out/Dunebot-<os>-<arch>/ : an app folder, no installer
DUNEBOT_SELFCHECK=1 out/Dunebot-darwin-arm64/Dunebot.app/Contents/MacOS/Dunebot   # checks it, opens nothing
DUNEBOT_SNAPSHOT_APP=<that executable> node scripts/snapshots.mjs out/packaged-shots     # draws it hidden
```

It packs only what the app loads (`electron/`, `dist/ui/`, the macOS addon and the glass package),
with the release core in `Resources/core` and, when `../codemax-cli/dist` has a build for this
system, codemax in `Resources/codemax` (`DUNEBOT_PACKAGE_CODEMAX=0` leaves it out; without it,
agents are looked for on PATH). macOS builds are signed ad hoc: no Apple Developer ID, not notarized,
so another Mac will refuse it until it's signed properly. The self-check uses temp folders and never
touches your chats.

## Tests

```sh
bun run test:core                     # unit tests (incl. the ⌥⌘ chord) + stdio checks with the test agent
core/target/debug/dunebot-core --transcribe some.wav   # voice path on a file (downloads the model once)
python3 -I scripts/core_real_turn.py core/target/debug/dunebot-core "$(mktemp -d)" claude
```

Replies (no window, then in hidden windows with the test agent echoing attacks back):

```sh
bun scripts/check_reply.tsx        # every partial state renders; Markdown; nothing runs or loads
bun scripts/check_reply_live.ts    # the same attacks in the real chats window and the answer card
bun scripts/check_speech.ts        # what is read aloud: words only, a sentence at a time
bun scripts/check_speech_sarvam.ts # streamed and fetched whole, in order, stop stays quiet, falls back; Hindi refused mid-answer waits
bun scripts/check_bar_chat.ts      # the bar's one chat, a new one after a quiet minute, questions said mid-answer
python3 -I scripts/check_sarvam_live.py core/target/debug/dunebot-core <.env with SARVAM_API_KEY> <out dir>
                                   # real Sarvam through the core's stdin (streaming too); the key in no reply or log
python3 -I scripts/check_languages_live.py core/target/debug/dunebot-core <.env with SARVAM_API_KEY> <out dir>
                                   # every Indian language: streamed in its voice, heard back word for word
python3 -I scripts/check_deepgram_live.py core/target/debug/dunebot-core <.env file(s) with DEEPGRAM_API_KEY, SARVAM_API_KEY> <out dir>
                                   # real Deepgram the same way: American English streamed and whole, Hindi to Sarvam, a wrong key
node scripts/check_follow.mjs      # where the card goes as it follows the pointer (never on it, on screen, no flapping); moving toward it holds it
```

`node scripts/snapshots.mjs` also runs the card on a scripted pointer (`caption-follow`): it must
move, never sit under the pointer or off the screen, and hold still while a card waits. And
(`caption-grab`): it must keep following while the pointer moves beside it, and stop for good once
the pointer heads for it.

UI snapshots without showing a window (no tray, hotkey or notifications in this mode):

```sh
DUNEBOT_DATA_DIR=$(mktemp -d) DUNEBOT_APPROVAL_MIN_MS=0 DUNEBOT_SNAPSHOT=out.png \
  DUNEBOT_SNAPSHOT_SCRIPT=scripts/snap/approval.js bunx electron .
# the answer card: add DUNEBOT_SNAPSHOT_VIEW=caption and use scripts/snap/caption.js or caption-approval.js
# following a scripted pointer: also DUNEBOT_SNAPSHOT_FOLLOW=1 with scripts/snap/caption-follow.js (numbers in the log)
```

## Same on every system

The bar, the answer card, setup and history window use the same layout, sizes, fonts and colours on macOS, Windows
and Linux. What each system forces:

| | macOS | Windows | Linux |
|---|---|---|---|
| Bar and setup surface | Apple's Liquid Glass edge (macOS 26+) around a solid dark fill, always dark | the same dark, solid | the same dark, solid |
| Open the bar | tap ⌥⌘ (opens at the chosen place) | Ctrl+Alt+Space (or the next free of Alt+Shift+Space, Ctrl+Shift+Space) | same as Windows; on Wayland through the desktop's shortcut portal (it asks once) |
| Talk | hold ⌥⌘ or the mic button | hold the mic button | hold the mic button |
| Answer card | solid dark card that follows the pointer, read aloud with the system voice | the same; Windows voices | the same on X11 (following not yet run on a real Linux display); spoken only with speech-dispatcher installed; on Wayland it stays where it opened (Wayland doesn't tell apps where the pointer is) |
| Clicking the answer card | while the pointer is on it | while the pointer is on it | only while a card waits for your OK (the window can't tell where the pointer is) |
| Setup asks for | mic, notifications, Desktop/Documents/Downloads, speech model | speech model (shows the mic if Windows has it off) | speech model |
| History window buttons | traffic lights, top left | system buttons over the top right | same as Windows |

Check it (drawn hidden, never a screen capture; every system on the plain card so they compare):

```sh
node scripts/snapshots.mjs out                  # this system; Linux: xvfb-run -a node scripts/snapshots.mjs out
node scripts/snapshots.mjs out win32            # on a Mac: draw the Windows version of the pages
python3 scripts/compare_snapshots.py out darwin out win32   # same parts, places and colours?
```

**Linux, Wayland.** Wayland only gives an app global keys through the desktop's shortcut portal,
which Dune Bot turns on (`GlobalShortcutsPortal`); not every desktop has one, and GNOME hides tray
icons without the AppIndicator extension. Starting Dune Bot while it runs opens the bar, so a
keyboard shortcut in the system's settings that starts Dune Bot always works. Wayland also doesn't let
apps place their windows, so the bar opens where the desktop puts it, not bottom centre. The container and CI
draw on X11 (Xvfb), so they can't check any of this: try it on a real Ubuntu or Fedora desktop.

**Linux on ARM with GCC 12** (e.g. Debian 12 in Docker on a Mac): whisper.cpp's "native" CPU setting
fails to compile. Build with `GGML_NATIVE=OFF GGML_CPU_ARM_ARCH=armv8.2-a+fp16+dotprod`.

`.github/workflows/ci.yml` (written, not yet run: the repo has no GitHub remote) runs the tests and
snapshots on all three systems and fails if Windows or Linux differ from macOS. The agent's file gate is tested for other letter cases of Dune Bot's folder
(macOS and Windows disks ignore case) and, on Windows, for `\`-style paths.
