<img src="assets/icon/dunebot.svg" width="128" height="128" alt="Dune Bot's icon: a white kitten on a black tile">

# Dune Bot

An assistant for your own computer. Ask it something from a small bar, or hold a key and talk. A
coding agent you already use (Claude Code, Codex, Cursor, OpenCode, Grok or Antigravity) does the
work on your computer, not in a cloud box, and the answer appears in a small card by your pointer
and is read aloud. Every action goes through one gate that asks you first when it's risky.

**[Download the latest release](https://github.com/SkidGod4444/dunebot/releases/latest)** for macOS
(Apple Silicon), Windows or Linux.

## Install

| System | Download | Install |
|---|---|---|
| macOS, Apple Silicon | `Dunebot-<version>-mac-arm64.zip` | Unzip, move `Dunebot.app` to Applications, open it. Signed and notarized by Apple. |
| Windows, x64 | `Dunebot-<version>-windows-x64.zip` | Unzip anywhere, run `Dunebot.exe`. It isn't code-signed yet: if SmartScreen warns, click **More info**, then **Run anyway**. |
| Linux, x64 | `Dunebot-<version>-linux-x64.tar.gz` | `tar -xzf` it, then run `Dunebot-linux-x64/dunebot`. |

Each download has a `.sha256` checksum next to it. There are no automatic updates yet: get new
versions from the [releases page](https://github.com/SkidGod4444/dunebot/releases).

**You need** one coding agent installed and signed in: Claude Code, Codex, Cursor, OpenCode, Grok or
Antigravity. codemax, which runs them, is included in every download.

**First launch:** Dune Bot has no main window. It sits in the menu bar (the tray on Windows and
Linux), and a setup window asks once for what it uses: the microphone (then checks that sound
really arrives), notifications, your Desktop, Documents and Downloads folders, the speech model
download and, last, Screen Recording (macOS answers that one in System Settings, then asks to
reopen Dune Bot). It never asks for Full Disk Access or Input Monitoring; Accessibility only the
first time an agent uses the mouse or keyboard for you, or you dictate. Reopen setup from the menu bar: **Set up Dune Bot…**.

## Use it

- **Ask.** macOS: tap **⌥⌘** (both together, then let go) to open the bar; type and press Enter.
  Windows and Linux: **Ctrl+Alt+Space** (the tray menu shows the fallback if it's taken:
  Alt+Shift+Space or Ctrl+Shift+Space).
- **Talk.** macOS: **hold ⌥⌘**. "Listening…" appears beside the pointer, and what you said is sent
  when you let go. Everywhere: hold the bar's mic button. On macOS the keys are read from the
  modifier-key state only, so Dune Bot needs no Input Monitoring permission and never sees what you
  type; ⌥⌘ followed by another key or a click (⌥⌘Esc, ⌥⌘D, …) is ignored. If another app wants the
  same keys, pick ⌃⌥, ⌃⌘ or Right ⌘ alone instead (Permissions › Keys, or Keys in the menu bar).
- **Dictate.** macOS: **hold Right ⌥** on its own and talk; let go, and what you said is typed where
  your text cursor is, in any app, like the system's dictation, in English whatever you speak (Hindi
  said, English typed; with Sarvam). It isn't sent to an agent and nothing
  is read aloud. Read the same way as ⌥⌘ (no Input Monitoring); another key or a click while you hold
  it cancels, so ⌥ shortcuts and special characters still work. Typing goes through the same checks as
  an agent's (never into Dune Bot itself; Accessibility asked the first time). Turn it off in
  Permissions › Keys or Keys in the menu bar. Windows and Linux: not yet.
- **Answers at once, works after.** When a request needs work, the agent first says what it's doing
  ("Sure, checking the weather where you are."). The card shows that line and reads it aloud right
  away while the work goes on, then reads the answer after it.
- **Talks like a person, not a log.** The card and the chats show what you said, the answers, and
  cards that need your OK, never the agent's steps. **Activity** lists every step. When a step
  failed, **Teach a fix** under that answer saves what the agent should do next time.
- **The answer card** sits beside the pointer and follows it while Dune Bot listens, works and reads
  the answer, never under the pointer and always on the screen. It holds still while a card waits
  for your OK and as soon as you move toward it, so you can scroll or click it. Point at it to keep
  it, close it or open the chat. **Show last answer** (menu bar, or ↑ in the empty bar) brings the
  last one back.
- **Ask again mid-answer.** Said while an answer is still coming, a question waits on the card as
  "Next: …" and is asked by itself once that answer has been read. Questions from the bar continue
  one chat; after a quiet minute, "+" in the bar, or picking another agent, the next one starts a
  new chat.
- **Where the bar opens:** bottom centre by default; menu bar › **Open the bar** picks top centre or
  next to the pointer.
- **Chats & activity…** in the menu bar opens the full history window. When an agent needs your OK
  in a chat you didn't ask from the bar, the card appears in the screen's top corner and a
  notification says so.

### What agents may do

Agents act only through Dune Bot's tools. Each has a setting in **Permissions**: Auto (commands
only), Ask, Always or Never.

| Action | Default |
|---|---|
| Run a command | **Auto**: runs without asking unless something in it is risky |
| Create or change a file | **Ask** |
| Read a file, look inside a folder, search your past chats | **Always** |
| Look at your screen | **Always** (macOS asks once for Screen Recording) |
| Find where you are | **Always** (macOS asks once for Location Services) |
| Click, scroll and drag on your screen | **Always** (macOS asks once for Accessibility; Linux: X11 only) |
| Type and press keys | **Always** (the same Accessibility switch on macOS; Linux: X11 only) |

What Auto counts as risky, and the limits nothing can lift, are under [Safety](#safety).

## Voice

Out of the box, voice runs on your computer: speech becomes text with whisper.cpp (English
`small.en`, 190 MB, downloaded once during setup and checked against its SHA-256), and answers are
read with your system's voice. A recording stops itself after 60 s.

**With your own [Sarvam AI](https://www.sarvam.ai) key** (Permissions › Voice), what you say becomes
text with `saaras:v4`: English, Hindi and other Indian languages, mixed too. Recordings over 29 s go
in parts cut at a quiet moment. Answers are read aloud with `bulbul:v4-flash` in Hindi, Bengali,
Tamil, Telugu, Gujarati, Kannada, Malayalam, Marathi, Punjabi and Odia. Each language is picked from
the answer's script (Marathi when that's what you last spoke). Hindi written in Latin letters is read
as Hindi too.

**Add a [Deepgram](https://deepgram.com) key too**, and English answers are read in an American voice
(Aura-2 `aura-2-thalia-en`). Answers in Indian languages stay with Sarvam.

**Ask in Hindi or Hinglish** and the answer is written in English, then read aloud in Hinglish:
each sentence goes through Sarvam's translator (`mayura:v1`) and Sarvam's Hindi voice reads it.

**Reading aloud streams:** each sentence is sent the moment it's complete, so the first sound comes
about 0.3–0.4 s after a sentence, or about 2.2 s for Hinglish. If streaming fails, sentences are
fetched whole; if Sarvam doesn't answer, the system voice reads instead.

**What leaves your computer:** with a Sarvam key, your recording goes to Sarvam. With a Sarvam or
Deepgram key, the words of each answer read aloud go to that service. Silence and a blocked mic are
caught before anything is sent, and Dune Bot saves no audio. Each key is locked with Electron's
`safeStorage` (the macOS Keychain, Windows DPAPI or the Linux secret store; Linux without one won't
keep it). It's unlocked only when voice needs it and handed to the core over its stdin: never an
environment variable, command line, page or log line. **Permissions › Voice › This computer** keeps
voice local even with keys saved.

## Your data

- **Where:** macOS `~/Library/Application Support/Dunebot`, Windows `%APPDATA%\Dunebot`, Linux
  `~/.local/share/Dunebot` (settings in `~/.config/Dunebot`). Nothing is stored in the cloud by Dune
  Bot itself.
- **What goes out:** what you ask, and what the agent reads, sees or finds for you, go to the agent
  you picked and from there to its provider (Claude Code to Anthropic, Codex to OpenAI, and so on).
  Voice services are covered under [Voice](#voice).
- **Chats** are kept in a database and exported as one MDX file per chat in `history/`. A new chat's
  first message goes to the agent with a short record of your chats from the past day (no tool
  output, at most about 4,000 characters), so a follow-up in a fresh chat still knows what you meant.
  Agents can also search past chats (`search_chats`, read-only, never tool output).
- **Uninstall:** quit Dune Bot from the menu bar, delete the app, then delete the data folder above.

## Safety

- **Auto / Ask / Always / Never** per action, set in Permissions. **Auto** (commands only) runs a
  command without asking unless something in it is risky (`core/src/lookonly.rs`, parsed, never a
  guess): deleting, moving or saving files, admin, shells and interpreters, other apps, the screen,
  speakers, mic or clipboard, network beyond a plain fetch shown on screen (curl/wget uploads, data,
  other methods, saving), changing git, installs and builds, other agents, system settings. Those
  ask, and the card says why ("Asking because rm changes, moves, saves or deletes files"). Home-wide
  walks, `~/Library`, other disks, variables, private files, `/proc`, jq reading `env`, and Dune Bot's
  own data always ask. What runs unasked gets a clean environment (PATH, HOME, locale). Pattern
  matching can miss a disguised command, and a plain fetch can carry text in its address. On Windows
  Auto always asks. Scheduled chats always ask.
- **The file tools never touch,** whatever the settings: SSH/GPG keys, cloud and package logins,
  keychains, browser profiles, Messages and Mail data, `.env` files, Dune Bot's own data. A command
  you allow runs with your full access and can reach these; the card shows it first.
- **Approval cards are single use.** "Allow all … in this chat" covers that one action type, in that
  chat only (history window only; the card beside the pointer offers just "Allow once" and "Don't
  allow", by mouse: it never takes keyboard focus). The core refuses any "allow" that arrives within
  half a second of the card appearing (`DUNEBOT_APPROVAL_MIN_MS` changes this for tests), so a stray
  click or keystroke can't approve a command nobody read.
- **Finding where you are** (`find_location`) asks the system: macOS Location Services. A Mac has no
  GPS, so the place comes from the Wi-Fi networks nearby: usually tens of metres with Wi-Fi on, rough
  or none without. Agents are told to use it for weather, "near me" and the like, never to guess
  from the internet address, and to pass the coordinates on (`wttr.in/LAT,LON`, which runs under
  Auto). The place goes to the agent and is kept with the chat's hidden step record; the activity log
  and the logs get none. Windows and Linux: not yet (the agent asks you instead).
- **Clicking for you** (`click`, macOS) is one click, double click or right click at a point in the
  chat's latest picture of the screen (`look_at_screen`, at most 3 minutes old); the app turns it
  into a point on the screen and moves the pointer there as a hand would (a gentle curve, slow to
  start and stop, 0.5 to 1.4 s), rests a moment, then presses and lets go at a finger's pace; the
  pointer stays there. Moving the mouse on the way stops it without a click. It never clicks
  Dune Bot itself: the app asks macOS which window is frontmost at that point and refuses its own bar,
  windows and menu bar icon; the answer card lets Dune Bot's own clicks through to what's under it
  (it never takes them), so an agent can't answer its own approval cards. The first click
  asks macOS for Accessibility (System Settings opens on it). Agents are told to click with it, not
  with osascript, which can drive any app and so still asks under Auto.
- **Scroll and drag** (`scroll`, `drag`) work the same way: a point (or two) in the latest
  picture, the pointer gliding there first; a drag holds the left button and always lets go, even
  when stopped. Each picture is good for one mouse action: the next one looks again.
- **Typing and keys** (`type_text`, `press_keys`) go to the app that has the keyboard, at a
  person's pace (quicker inside words, a beat after a space or a stop). Shortcuts carry their
  modifiers on the key's own events; no modifier key goes down alone, and the ⌥⌘ chord rests while
  Dune Bot types. Before every key the app checks that neither Dune Bot nor one of its windows has
  the keyboard (so an agent can't press ⌘↩ on its own card) and that the mouse hasn't moved; either
  stops it. The chat and the activity log keep how many characters were typed, never the text. When
  you close the bar after typing a question, the app you were in gets the keyboard back (as Spotlight
  does), so an agent can type where you were.
- **On Windows and Linux** the same tools post the system's own input (SendInput; XTest on X11).
  Shortcuts there use Ctrl, Alt, Shift and Win (an agent's "cmd" means Ctrl), pressed around the key
  as a hand does and always let go. Windows asks nothing, but it silently drops clicks and keys sent
  to an app run as administrator (Task Manager, installers, an admin terminal), so Dune Bot checks
  first and says it can't rather than claiming it did. Linux needs an X11 desktop: Wayland (the default on recent Ubuntu and Fedora) doesn't
  let apps move the pointer or type into other apps, so there Dune Bot says it can't and tells you
  what to do instead (on Ubuntu, "Ubuntu on Xorg" at the login screen turns X11 on).
- `list_folder` counts a whole folder tree (`deep: true`: files, folders, sizes, the largest files)
  without asking, and agents are told to use it instead of a command.
- Stop ends the running command, not just the agent's turn. Cards left open when Dune Bot quits come
  back as expired.
- A replaced file is backed up first (`<data>/journal/<chat>/`).
- Every attempt is in the Activity log.
- The windows have a strict CSP: model output can't load remote images or scripts. Replies are plain
  Markdown, and nothing in a reply is ever run or loaded ([Replies](#replies)).

## Develop

### Run it

```sh
bun install
bun run build     # Rust core + window
bun run start     # opens Dune Bot
bun run dev       # same, with hot reload for the window
```

On macOS, `dev` and `start` run Dune Bot as its own small app, `.dev/Dunebot Dev.app` (a copy of
Electron with its own bundle id), started by macOS. So the microphone prompt names Dune Bot and the
permission goes to Dune Bot only, not to your terminal. Its output is in
`$TMPDIR/dunebot-dev/app.log`. If the repo is under ~/Desktop or ~/Documents, macOS asks once
whether Dunebot Dev may read that folder (it loads its own code from there).

Agents run through `codemax serve`. In dev, Dune Bot uses `../codemax-cli/dist/codemax` if it
exists; otherwise set `DUNEBOT_CODEMAX=/path/to/codemax`. The Homebrew `codemax` must be new enough
to have `serve`.

### How it fits together

| Part | Language | Job |
|---|---|---|
| `core/` | Rust | Owns everything: chats, approvals, permissions, the activity log, the tool endpoint, starting agents |
| `electron/` | JS | Starts the core, passes calls and events to the window. No logic. |
| `ui/` | React + Tailwind | Draws what the core says. Sends only ids and choices. |
| `native/` | Rust (napi) | The mouse and keyboard (Quartz on macOS, SendInput on Windows, XTest on Linux). macOS also: notification permission, window appearance, the glass's corners, Location Services, Screen Recording access |

Agents run in codemax's `mcp-only` policy: their own file and shell tools are refused, so their only
way to act is Dune Bot's tools (`run_command`, `read_file`, `write_file`, `list_folder`,
`search_chats`, `look_at_screen`, `find_location`, `click`, `scroll`, `drag`, `type_text` and
`press_keys`), served on a loopback port with a separate token
per chat. Agents are told to write one short line saying what they're doing before they use a tool
(`instructions` in `core/src/agent.rs`), and questions asked from the bar carry a note asking for one
or two short sentences (`SPOKEN_NOTE`).

The answer card is `ui/src/Caption.tsx`: it reads the whole turn aloud in order with one voice
(`ui/src/speak.ts`), and follows the pointer by `electron/caption-place.mjs`. A question said
mid-answer is held by `ui/src/held.ts`. Voice: `core/src/sarvam.rs` (`speaker_for` picks the voice),
`core/src/deepgram.rs` and `core/src/speak_stream.rs`. The microphone is a cargo feature (`voice`, on
by default); cross-builds use `--no-default-features` (reading aloud by Sarvam still works there).

Chat history files are MDX: an `export const meta` line, what you said, the replies, and `<Tool>` /
`<Approval>` lines for what the agent did. Rewritten when you send and when a turn ends, removed with
the chat, backfilled at start. They're an export: memory comes from the database, agents can't open
Dune Bot's folder, and editing a file changes nothing the agent sees. `node scripts/check_mdx.mjs
<folder>` compiles them; the smoke test does it with a deliberately awkward message.

**Look:** always dark, whatever the system is set to. On macOS 26+ the bar, setup and the history
sidebar sit on Apple's Liquid Glass (`NSGlassEffectView`), added by the
[`electron-liquid-glass`](https://github.com/Meridius-Labs/electron-liquid-glass) package (pinned to
1.1.1; we also pin `node-gyp-build`, which it loads but doesn't list). The glass is Apple's Control
Center style, dark and tinted toward the page colour; the page paints its own solid dark fill over it
(`--dm-fill` in `ui/src/styles.css`), so nothing behind shows through and the glass adds its lit
edge. Older macOS gets the system blur. Fonts: Geist, Geist Mono and Geist Pixel, from the `geist`
package. The addon in `native/` sets the glass's own corner radius in place (the package only clips
it, which leaves the edge light on square-ish corners) and logs what macOS made of the glass, so a
style that silently stopped working shows up in the log. It links with `-fixup_chains`, and
`bun run native` checks the result: Xcode 27's linker can write a library dyld refuses
("mis-aligned LINKEDIT string pool") when the import count is odd, so it rebuilds with
`--cfg dunebot_pad`, which adds one. It also replaces the file rather than writing over it (macOS
kills a process that loads changed bytes at a path a running app has loaded).

### Replies

Agent replies are plain Markdown, drawn by AI Elements' `MessageResponse` (Streamdown with its code
highlighting; `ui/src/reply.tsx`). A reply is untrusted text, so three things differ from Streamdown
as it ships:

- HTML is shown as written, never drawn, so `Array<string>` or `<div>` in prose keeps every word;
- pictures are never loaded (they show as "Image blocked");
- links may only be web pages (open in your browser) or email addresses (open a new mail).

Streamed text is shown at a steady pace (`ui/src/smooth.ts`). The answer card uses the same renderer;
only the words are read aloud (no code, paths, links or tags; up to three sentences for each part of
the turn). Try it with the test agent: `stream` and `markdown`.

### Package it

```sh
bun run package    # out/Dunebot-<os>-<arch>/ : an app folder, no installer
DUNEBOT_SELFCHECK=1 out/Dunebot-darwin-arm64/Dunebot.app/Contents/MacOS/Dunebot   # checks it, opens nothing
DUNEBOT_SNAPSHOT_APP=<that executable> node scripts/snapshots.mjs out/packaged-shots     # draws it hidden
```

It packs only what the app loads (`electron/`, `dist/ui/`, the macOS addon and the glass package),
with the release core in `Resources/core` and, when `../codemax-cli/dist` has a build for this
system, codemax in `Resources/codemax` (`DUNEBOT_PACKAGE_CODEMAX=0` leaves it out, and agents are
then looked for on PATH; `DUNEBOT_CODEMAX_BIN` bundles another build). macOS builds are signed ad hoc
unless `DUNEBOT_SIGN_IDENTITY` names a Developer ID certificate: then every part is signed for the
hardened runtime with only the entitlements it needs, and with `DUNEBOT_NOTARY_PROFILE` (a
`xcrun notarytool store-credentials` profile) notarized, stapled and checked with Gatekeeper.
`DUNEBOT_ARCHIVE=1` also writes `out/Dunebot-<version>-<os>-<arch>.zip` (`.tar.gz` on Linux). The
self-check uses temp folders and never touches your chats.

The icon is drawn once from `assets/icon/dunebot.svg`: `bun run icon` makes the macOS `.icns`, the
Windows `.ico`, the window icon Linux uses (`electron/assets/icon.png`) and the mark the app's pages
show (`ui/src/mascot.svg`), and all four are kept in the repo.

### Release

1. Set the version in `package.json` and write `docs/releases/v<version>.md`.
2. Push the tag `v<version>`. `.github/workflows/release.yml` makes a draft release with those notes
   and attaches the Windows and Linux downloads (codemax bundled, each self-checked).
3. On a Mac, build the Mac download and attach it:
   `DUNEBOT_SIGN_IDENTITY=… DUNEBOT_NOTARY_PROFILE=… DUNEBOT_CODEMAX_BIN=… DUNEBOT_ARCHIVE=1 bun run package`.
4. Publish the draft once every download is there.

### Tests

```sh
bun run test:core                     # unit tests (incl. the ⌥⌘ chord) + stdio checks with the test agent
core/target/debug/dunebot-core --transcribe some.wav   # voice path on a file (downloads the model once)
python3 -I scripts/core_real_turn.py core/target/debug/dunebot-core "$(mktemp -d)" claude
python3 -I scripts/core_location_turn.py core/target/debug/dunebot-core "$(mktemp -d)" [claude]
                                      # location answers with a stand-in place, never the real one
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
node scripts/check_dictation.mjs   # dictation: words fed to the core (no mic) typed exactly through input.mjs (fake addon); refusals type nothing
```

`node scripts/snapshots.mjs` also runs the card on a scripted pointer (`caption-follow`): it must
move, never sit under the pointer or off the screen, and hold still while a card waits. And
(`caption-grab`): it must keep following while the pointer moves beside it, and stop for good once
the pointer heads for it. `caption-first-line` checks that the agent's first line is read while its
step still runs. `caption-dictation` feeds words as if dictated and checks the app types them (stand-in
keyboard); `caption-dictation-refused` gives Dune Bot's own window the keyboard: nothing typed, and the
card says why in one sentence.

UI snapshots without showing a window (no tray, hotkey or notifications in this mode):

```sh
DUNEBOT_DATA_DIR=$(mktemp -d) DUNEBOT_APPROVAL_MIN_MS=0 DUNEBOT_SNAPSHOT=out.png \
  DUNEBOT_SNAPSHOT_SCRIPT=scripts/snap/approval.js bunx electron .
# the answer card: add DUNEBOT_SNAPSHOT_VIEW=caption and use scripts/snap/caption.js or caption-approval.js
# following a scripted pointer: also DUNEBOT_SNAPSHOT_FOLLOW=1 with scripts/snap/caption-follow.js (numbers in the log)
```

`.github/workflows/ci.yml` runs all of this on macOS, Windows and Linux on every push to main, and
fails if Windows or Linux draw differently from macOS. On the Windows and Linux machines it also
uses the real mouse and keyboard on a test window of its own (`scripts/check_input_live.mjs`:
clicks, a double and a right click, typing, Ctrl+A, Backspace, scrolling, a drag); the Mac runner
can't, since macOS needs a person to switch on Accessibility. The agent's file gate is tested for other
letter cases of Dune Bot's folder (macOS and Windows disks ignore case) and, on Windows, for
`\`-style paths.

### Same on every system

The bar, the answer card, setup and the history window use the same layout, sizes, fonts and colours
on macOS, Windows and Linux. What each system forces:

| | macOS | Windows | Linux |
|---|---|---|---|
| Bar and setup surface | Apple's Liquid Glass edge (macOS 26+) around a solid dark fill, always dark | the same dark, solid | the same dark, solid |
| Open the bar | tap ⌥⌘ (opens at the chosen place) | Ctrl+Alt+Space (or the next free of Alt+Shift+Space, Ctrl+Shift+Space) | same as Windows; on Wayland through the desktop's shortcut portal (it asks once) |
| Talk | hold ⌥⌘ or the mic button | hold the mic button | hold the mic button |
| Dictate (typed where you are) | hold Right ⌥ alone | not yet (letting go of Alt opens apps' menus; AltGr) | not yet; Wayland can't (no key state for apps) |
| Answer card | solid dark card that follows the pointer, read aloud | the same; Windows voices | the same on X11 (following not yet run on a real Linux display); the system voice needs speech-dispatcher; on Wayland it stays where it opened (Wayland doesn't tell apps where the pointer is) |
| Clicking the answer card | while the pointer is on it | while the pointer is on it | only while a card waits for your OK (the window can't tell where the pointer is) |
| Setup asks for | mic, notifications, Desktop/Documents/Downloads, speech model, Screen Recording | speech model (shows the mic if Windows has it off) | speech model |
| Finding where you are | Location Services | not yet | not yet |
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
keyboard shortcut in the system's settings that starts Dune Bot always works. Wayland also doesn't
let apps place their windows, so the bar opens where the desktop puts it, not bottom centre. CI
draws on X11 (Xvfb), so it can't check any of this: try it on a real Ubuntu or Fedora desktop.

**Linux on ARM with GCC 12** (e.g. Debian 12 in Docker on a Mac): whisper.cpp's "native" CPU setting
fails to compile. Build with `GGML_NATIVE=OFF GGML_CPU_ARM_ARCH=armv8.2-a+fp16+dotprod`.

## License

© 2026 OpenHorizon Labs. Dune Bot is free software under the
[GNU Affero General Public License v3.0 only](LICENSE) (AGPL-3.0-only), the same as codemax. You may
use, study, change and share it. If you share a changed copy, or let people use a changed copy over a
network, you must offer them its source under the same license. It comes with no warranty.

The downloads also include:

- [codemax](https://github.com/SkidGod4444/codemax-cli), which runs the agents: AGPL-3.0-only, a
  separate program Dune Bot starts; its source is at that link.
- [electron-liquid-glass](https://github.com/Meridius-Labs/electron-liquid-glass): MIT.
- The [Geist](https://vercel.com/font) fonts: SIL Open Font License 1.1.
- [Electron](https://www.electronjs.org): MIT.

The speech model (whisper `small.en`, MIT) is downloaded from Hugging Face on first use, not shipped.
