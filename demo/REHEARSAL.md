# Rehearsal

Filmed with headless Chrome through `scripts/film.mjs` (PNGs in `shots/`). Every gate below printed "rehearsal passed".

## Covered

- **Widths:** 760 wide (`gate-wide.png`, `states-wide.png`) and 390 phone (`gate-390.png`, `states-390.png`).
- **Reduced motion:** `reduced.png`, `reduced-390.png`. It shows the poster state, the ask.
- **Beats:** open, ask, card, follow, approval, allowed, away. Each one is on the states sheets.
- **Framing:** gutters, satellite gaps, window shape and bleed.
- **Motion:** hard edges, handoff snaps and typing jumps. Coverage is "inconclusive" only because of sampling gaps over 27 ms.

## Fresh-eye review (11 findings)

Fixed:
- Bigger product: a 760 stage with a 360 card, and shorter pointer travel.
- The payoff shows: both installers are named, and they leave the list when the command runs.
- Keycaps sit just above where the bar rises.
- Thinking card is one line tall.
- Pointer rests on the list, not on the zoom light.
- Click lands on the button, and the press shows for 160 ms.
- The amber box unfolds from the first frame; its words wait until the edge lands.
- The answer swap no longer overlaps. The old answer goes, then the new one streams in.
- The command wraps at the space.

Not fixed:
- **Phone layout is mostly empty.** A folder list in the lower half fails the gutter gate: its 300 px top gap becomes the frame's gutter, and the card can't keep it.

## Not checked

- Real-time feel. The frames were sampled every 500 ms, and nobody watched it at speed.
- Windows or Linux fonts. Geist is bundled, so they should match.
- Video export. There is none; only PNGs.
