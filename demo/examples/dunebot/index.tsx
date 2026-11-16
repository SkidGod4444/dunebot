import { ArrowUp, File, Folder, Loader2, Maximize2, Mic, ShieldAlert, Volume2 } from 'lucide-react'
import { Bar, Collapse, Stage, States, Stream, Window, type Act, type Layout, type Point } from '../../kit'
import './dunebot.css'

// Dunebot, as it is used: tap ⌥⌘, the bar rises, a question is typed and
// sent. The bar goes and the answer card opens beside the pointer. It looks in
// the folder without asking and follows the pointer while it works. To delete
// anything it asks, on an amber card, and holds still while it waits, so the
// pointer can reach "Allow once". The command runs, the two installers leave
// the folder and the answer changes in place. Plays once and holds there: the
// files are gone, and a loop would have to bring them back with no cause.
//
// Copied from the app (ui/src/Bar.tsx, Caption.tsx, parts.tsx): the bar's
// placeholder, the agent chip, "Looking in a folder", "Speaking · stop",
// "<agent> wants to run this command", "Asking because rm isn't one of the
// commands that only look.", "Allow once" / "Don't allow", "Running a
// command". The question, the file names and the sizes are made up.
//
// The card sits where the app puts it: 16 px right of the pointer and 24 px
// below it (electron/caption-place.mjs), 360 px wide.

const Q = 'Clear old installers from Downloads'
const A1 = 'Found 2 old installers in Downloads, 1.4 GB in all. Deleting them needs your OK.'
// As long as A1, so the card keeps its height when one replaces the other; no word of A1 in it, so nothing seems to slide
const A2 = 'Done. Both are deleted now, and that space is free for you again. Nothing else changed.'
const CMD = 'rm Setup-2.3.dmg Setup-2.4.dmg'
const FILES = [
  { name: 'Setup-2.3.dmg', size: '712 MB' },
  { name: 'Setup-2.4.dmg', size: '688 MB' },
]
const W1 = A1.split(' ').length
const W2 = A2.split(' ').length

type Phase = 'dots' | 'look' | 'answer' | 'ask' | 'run' | 'done'
type S = {
  bar: boolean
  q: string
  card: boolean
  /** The pointer the card hangs from; null: where `spot` says. */
  p: Point | null
  /** Where the card hangs when no pointer is given: the resting point, or where the pointer stops. */
  spot: 'rest' | 'to'
  phase: Phase
  /** Which step the step line names; it changes only while the line is closed. */
  step: 'look' | 'run'
  w1: number
  w2: number
  speaking: boolean
  /** The installers have been deleted. */
  gone: boolean
}

const initial: S = { bar: false, q: '', card: false, p: null, spot: 'rest', phase: 'dots', step: 'look', w1: 0, w2: 0, speaking: false, gone: false }
// Reduced motion: the moment that sells it, the ask
const poster: S = { ...initial, card: true, spot: 'to', phase: 'ask', w1: W1 }

type Geo = {
  rest: Point
  /** Where the pointer moves to while the card follows it. */
  to: Point
  /** Where the pointer goes once the answer is in, clear of the card and the folder's rows. */
  off: Point
  card: number
  bar: { x: number; y: number; w: number }
  /** The folder window. The phone layout leaves it out: a tall stage either squashes it or sets a gutter the card can't keep. */
  win: { x: number; y: number; w: number; h: number } | null
  /** Placeholder rows above the two installers, and after them. */
  before: number
  after: number
}

const GEO: Record<Layout, Geo> = {
  // Wide: a 40 px gutter; the card keeps well clear of the frame's edges, as a satellite of the window
  wide: { rest: { x: 70, y: 100 }, to: { x: 314, y: 98 }, off: { x: 250, y: 420 }, card: 360, bar: { x: 110, y: 444, w: 540 }, win: { x: 40, y: 40, w: 760, h: 540 }, before: 6, after: 10 },
  // Compact: no window; the card stays centered (40 px each side) and follows the pointer down
  compact: { rest: { x: 24, y: 58 }, to: { x: 24, y: 120 }, off: { x: 250, y: 470 }, card: 300, bar: { x: 20, y: 500, w: 340 }, win: null, before: 0, after: 0 },
}

// From the pointer to the card's top left, as the app places it.
const RIGHT_GAP = 16
const BELOW_GAP = 24

async function script(a: Act<S>) {
  const g = GEO[a.layout]
  await a.wait(700)

  // 1. Tap ⌥⌘: the bar rises at the bottom of the screen
  a.mark('open')
  await a.key('alt+cmd')
  await a.set({ bar: true })
  await a.wait(500)

  // 2. The question is typed and sent
  a.mark('ask')
  await a.type('q', Q, { interval: 36 })
  await a.wait(350)
  await a.key('enter')

  // 3. The bar goes; the card opens beside the pointer and looks in the folder without asking
  a.mark('card')
  await a.set({ bar: false, card: true, phase: 'dots' })
  await a.wait(650)
  await a.set({ phase: 'look', step: 'look' })
  await a.wait(250)

  // 4. While it works the card follows the pointer
  a.mark('follow')
  const straight = (t: number, from: Point, to: Point) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
  await a.move(g.to, { duration: 1150, path: a.layout === 'compact' ? straight : undefined, onMove: (at) => a.put({ p: at }) })
  await a.wait(150)
  a.put({ phase: 'answer', speaking: true })
  for (let i = 1; i <= W1; i++) {
    a.put({ w1: i })
    await a.wait(45)
  }
  await a.wait(700)

  // 5. Deleting asks first; the card holds still while it waits
  a.mark('approval')
  await a.set({ phase: 'ask', speaking: false })
  await a.wait(1800)
  await a.click({ at: 'allow', x: 0.84, y: 0.6 })
  await a.wait(160)

  // 6. Allowed once: the command runs, the installers leave the folder, the answer changes in place
  a.mark('allowed')
  await a.set({ phase: 'run', step: 'run' })
  await a.wait(500)
  await a.set({ gone: true })
  await a.wait(350)
  a.put({ phase: 'done', speaking: true, w2: 0 })
  await a.wait(140)
  for (let i = 1; i <= W2; i++) {
    a.put({ w2: i })
    await a.wait(45)
  }
  await a.wait(1400)
  a.put({ speaking: false })
  await a.wait(500)

  // 7. The pointer moves off so the answer and the folder read; it holds there
  a.mark('away')
  await a.move(g.off, { duration: 900 })
  await a.wait(2400)
}

export default function DunebotDemo() {
  return (
    <Stage<S>
      width={760}
      height={540}
      compact={{ below: 600, width: 380, height: 580 }}
      initial={initial}
      poster={poster}
      script={script}
      play="once"
      theme="dark"
      keys="bottom"
      cursor={{ at: { wide: GEO.wide.rest, compact: GEO.compact.rest }, idle: false }}
      className="dm"
    >
      {(s, _rect, layout) => {
        const g = GEO[layout]
        const p = s.p ?? (s.spot === 'to' ? g.to : g.rest)
        return (
          <div className="dm-desktop" data-layout={layout}>
            <div className="dm-wallpaper" />
            <div className="dm-menubar">
              <span className="dm-menubar__side">
                <Bar w={30} h={7} tone={5} />
                <Bar w={22} h={6} tone={4} />
                <Bar w={26} h={6} tone={4} />
                {layout === 'wide' && <Bar w={30} h={6} tone={4} />}
              </span>
              <span className="dm-menubar__side">
                <Bar w={14} h={10} r={3} tone={4} />
                <Bar w={14} h={10} r={3} tone={4} />
                <Bar w={52} h={6} tone={5} />
              </span>
            </div>

            {g.win && <Downloads g={g} win={g.win} gone={s.gone} />}

            <AskBar s={s} g={g} compact={layout === 'compact'} />

            <div
              className="dm-card"
              data-show={s.card || undefined}
              style={{ width: g.card, transform: `translate(${p.x + RIGHT_GAP}px, ${p.y + BELOW_GAP}px)` }}
            >
              <Card s={s} />
            </div>
          </div>
        )
      }}
    </Stage>
  )
}

const FILLER = [
  [96, 'f', 64], [128, 'd', 70], [74, 'f', 64], [112, 'd', 58], [88, 'd', 68], [140, 'd', 62], [70, 'f', 64], [104, 'd', 60],
  [92, 'd', 66], [122, 'd', 58], [80, 'f', 64], [116, 'd', 70], [98, 'd', 60], [86, 'd', 66], [130, 'd', 62], [76, 'd', 58],
] as const

/** A Finder-like list of the folder the question is about. Only the two installers have real names. */
function Downloads({ g, win, gone }: { g: Geo; win: NonNullable<Geo['win']>; gone: boolean }) {
  const filler = (from: number, n: number) =>
    FILLER.slice(from, from + n).map(([w, kind, d], i) => (
      <div key={from + i} className="dm-file">
        {kind === 'f' ? <Folder size={14} className="dm-file__folder" /> : <File size={14} className="dm-file__doc" />}
        <Bar w={w} h={6} tone={3} />
        <span className="dm-spacer" />
        <Bar w={d} h={6} tone={2} />
        <Bar w={40} h={6} tone={2} className="dm-file__size" />
      </div>
    ))
  return (
    <Window
      className="dm-window"
      style={{ left: win.x, top: win.y, width: win.w, height: win.h }}
      title="Downloads"
      body={{ className: 'dm-window__body', 'data-crop': true }}
    >
      <div className="dm-files">
        {filler(0, g.before)}
        {FILES.map((f) => (
          <Collapse key={f.name} open={!gone}>
            <div className="dm-file" data-named>
              <File size={14} className="dm-file__doc" />
              <span className="dm-file__name">{f.name}</span>
              <span className="dm-spacer" />
              <span className="dm-file__meta">{f.size}</span>
            </div>
          </Collapse>
        ))}
        {filler(g.before, g.after)}
      </div>
    </Window>
  )
}

/** The ⌥⌘ bar: Dunebot's spark, the question, the mic (a send arrow once typed) and the agent chip. */
function AskBar({ s, g, compact }: { s: S; g: Geo; compact: boolean }) {
  return (
    <div className="dm-bar" data-show={s.bar || undefined} style={{ left: g.bar.x, top: g.bar.y, width: g.bar.w }}>
      <Spark />
      <span className="dm-bar__input" data-typing>
        {s.q && <span className="dm-bar__text">{s.q}</span>}
        <span key={s.q} className="dm-bar__caret" />
        <span className="dm-bar__placeholder" data-hidden={!!s.q || undefined}>
          What should I do on your computer?
        </span>
      </span>
      <States
        className="dm-bar__button"
        value={s.q ? 'send' : 'mic'}
        states={{
          mic: (
            <span className="dm-bar__mic">
              <Mic size={18} />
            </span>
          ),
          send: (
            <span className="dm-bar__send">
              <ArrowUp size={18} />
            </span>
          ),
        }}
      />
      {!compact && (
        <>
          <span className="dm-chip">
            <span className="dm-chip__tile">Cl</span>
            <span>Claude Code</span>
          </span>
          <Maximize2 size={16} className="dm-bar__open" />
        </>
      )}
    </div>
  )
}

/** The answer card (ui/src/Caption.tsx): the answer, the step running, the ask, and the speaking line. */
function Card({ s }: { s: S }) {
  const answered = s.phase !== 'dots' && s.phase !== 'look'
  return (
    <>
      <div className="dm-card__body">
        <Collapse open={s.phase === 'dots'}>
          <span className="dm-dots" aria-label="Working">
            <i />
            <i />
            <i />
          </span>
        </Collapse>
        <Collapse open={answered}>
          {/* The answer is replaced in place: both are laid out in one cell, so the card keeps its height */}
          <div className="dm-answers">
            <p className="dm-answer" data-on={s.phase !== 'done' || undefined}>
              <Stream text={A1} count={s.w1} />
            </p>
            <p className="dm-answer" data-on={s.phase === 'done' || undefined}>
              <Stream text={A2} count={s.w2} />
            </p>
          </div>
        </Collapse>
        <Collapse open={s.phase === 'look' || s.phase === 'run'}>
          {/* Under the answer when it runs a command; alone on the card while it looks */}
          <div className="dm-step" data-after={s.step === 'run' || undefined}>
            <Loader2 size={13} className="dm-spin" />
            <span className="dm-step__label">{s.step === 'run' ? 'Running a command' : 'Looking in a folder'}</span>
            <code className="dm-step__target">{s.step === 'run' ? CMD : '~/Downloads'}</code>
          </div>
        </Collapse>
        <Collapse open={s.phase === 'ask'} className="dm-ask-slot">
          <div className="dm-ask">
            <div className="dm-ask__title">
              <ShieldAlert size={17} className="dm-ask__icon" />
              Claude Code wants to run this command
            </div>
            <pre className="dm-ask__cmd">{CMD}</pre>
            <p className="dm-ask__detail">in ~/Downloads</p>
            <p className="dm-ask__why">Asking because rm isn't one of the commands that only look.</p>
            <div className="dm-ask__buttons">
              <span className="dm-allow" data-target="allow">
                Allow once
              </span>
              <span className="dm-deny">Don't allow</span>
            </div>
          </div>
        </Collapse>
      </div>
      <Collapse open={s.speaking}>
        <div className="dm-card__foot">
          <span className="dm-card__speaking">
            <Volume2 size={12} className="dm-coral" /> Speaking · stop
          </span>
          <span>Claude Code</span>
        </div>
      </Collapse>
    </>
  )
}

/** Dunebot's own mark, as the bar draws it (ui/src/Bar.tsx). */
function Spark() {
  return (
    <svg className="dm-spark" width="22" height="22" viewBox="0 0 40 40" aria-hidden>
      <path d="M20 3c1.6 8.4 7.6 14.4 17 17-9.4 2.6-15.4 8.6-17 17-1.6-8.4-7.6-14.4-17-17C12.4 17.4 18.4 11.4 20 3z" fill="#ff6b4a" />
    </svg>
  )
}
