# Dunebot demo

An animated mock of Dunebot for a launch page or the README. It is not part of the app: nothing here is built, packaged or tested with Dunebot, and the app does not import it.

What it shows, in about 18 seconds. It plays once and holds on the result, because the files it deletes could only come back with no cause:

1. ⌥⌘ is tapped and the bar rises.
2. A question is typed and sent.
3. The answer card opens beside the pointer, looks in the folder without asking, and follows the pointer while it works.
4. Deleting asks first, on the amber card, which holds still while it waits; the pointer clicks **Allow once**.
5. The command runs, the two installers leave the folder, and the answer changes in place. The pointer moves off and the card stays, so the result can be read.

The strings on the bar and the card are the app's own (`ui/src/Bar.tsx`, `Caption.tsx`, `parts.tsx`), and so are the colors, the Geist type and the card's place beside the pointer (`electron/caption-place.mjs`). The question, the file names and the sizes are made up.

## Run it

```sh
cd demo
bun install
bun run dev        # http://127.0.0.1:5198/
```

Below 600 px wide it switches to a phone layout: no folder window, the card centered. The deleted rows show only in the wide layout.

## Film it

`scripts/film.mjs` drives the installed Google Chrome headless and writes PNGs (stills and contact sheets, no video):

```sh
node scripts/film.mjs "http://127.0.0.1:5198/?capture=dunebot" --gate                # the rehearsal gate, wide
node scripts/film.mjs "http://127.0.0.1:5198/?capture=dunebot" --gate --width 390    # phone width
node scripts/film.mjs "http://127.0.0.1:5198/?capture=dunebot" --at approval --delay 1200 --still --out poster.png
```

`poster.png` is that still: the ask, for a README or a page that can't run the scene.

## Files

- `examples/dunebot/` — the scene (`index.tsx`) and its look (`dunebot.css`).
- `kit/`, `scripts/`, `playground/` — the Stageshow kit and its filming tools, copied unchanged except a smaller playground (MIT, see `LICENSE` and `NOTICE.md`).
- `REHEARSAL.md` — what was filmed and checked, and what was not.
