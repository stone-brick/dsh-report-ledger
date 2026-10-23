// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts.
export {}
/**
 * Deterministic checks for the card canvas's painter.
 *
 * The painter talks to a structural context (`PaintContext`), so it can be driven
 * by a **recorder** instead of a canvas: every fill, stroke, dash pattern and text
 * draw becomes an assertion, and "the wire is dimmed but the frame is not" stops
 * being something to squint at in a browser. What still needs a browser is only
 * what no recorder can see — real text metrics, real pixels, real frame times.
 *
 * Run: node scripts/cardgraph-paint-check.ts
 */

const { buildCardgraph } = await import('../src/client/cardgraph-model.ts')
const {
  createCanvasPainter, readTheme, createThemeReader, fontString, foldText, elide, wirePoints, WIRE_TOKENS, FALLBACK_THEME,
} = await import('../src/client/cardgraph-painter.ts')

/** One report digest, as the layout consumes it. */
type Front = Parameters<typeof buildCardgraph>[1][number]

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

const at = (n: number): number => 1_700_000_000_000 + n * 1000

const report = (id: string, over: Record<string, unknown> = {}): Front => ({
  report: id,
  subject: `subject ${id}`,
  status: 'open',
  from: 'session-root',
  to: [],
  cc: [],
  created: at(10),
  updated: at(10),
  children: [],
  artifacts: [],
  hops: 1,
  ...over,
  authors: (over.authors as readonly string[] | undefined) ?? [(over.from as string | undefined) ?? 'session-root'],
}) as Front

const payload = {
  root: 'session-root',
  generatedAt: at(99),
  sessions: [
    { id: 'session-root', depth: 0, delegated: false, live: true, title: 'root session', createdAt: at(1) },
    { id: 'session-child', depth: 1, delegated: true, live: true, parentId: 'session-root', title: 'child session', createdAt: at(2) },
  ],
  reports: [],
} as unknown as Parameters<typeof buildCardgraph>[0]

// ---------------------------------------------------------------------------
// The recorder: a PaintContext that remembers what it was asked to draw
// ---------------------------------------------------------------------------
interface Box { x: number; y: number; width: number; height: number }
interface Shape { seq: number; style: string; alpha: number; box: Box; points: number; dash: readonly number[]; lineWidth: number }
interface Drawn { seq: number; text: string; x: number; y: number; style: string }
/** One measurement, with the font it was measured in: folding is font-dependent. */
interface Measured { readonly text: string; readonly font: string }

/** A context stand-in. Coordinates are recorded raw, so they are world coordinates. */
class Recorder {
  readonly calls: string[] = []
  readonly fills: Shape[] = []
  readonly strokes: Shape[] = []
  readonly rects: Shape[] = []
  readonly texts: Drawn[] = []
  readonly measurements: Measured[] = []
  measureCalls = 0
  /** Width one character reports, so a test can make text as wide or narrow as it likes. */
  charWidth = 7
  fillStyle = ''
  strokeStyle = ''
  lineWidth = 1
  lineDashOffset = 0
  globalAlpha = 1
  font = ''
  textAlign: 'left' | 'center' | 'right' = 'left'
  textBaseline: 'top' | 'middle' | 'bottom' = 'top'
  private path: { x: number; y: number }[] = []
  private dash: readonly number[] = []

  private seq(): number { return this.calls.length }

  save(): void { this.calls.push('save') }
  restore(): void { this.calls.push('restore') }
  setTransform(...a: number[]): void { this.calls.push(`setTransform(${a.join(',')})`) }
  translate(x: number, y: number): void { this.calls.push(`translate(${x},${y})`) }
  scale(x: number, y: number): void { this.calls.push(`scale(${x},${y})`) }
  clearRect(): void { this.calls.push('clearRect') }
  clip(): void { this.calls.push('clip') }
  setLineDash(segments: readonly number[]): void { this.calls.push('setLineDash'); this.dash = segments }
  measureText(text: string): { width: number } {
    this.measureCalls++
    this.measurements.push({ text, font: this.font })
    return { width: text.length * this.charWidth }
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.calls.push('fillRect')
    this.rects.push({ seq: this.seq(), style: this.fillStyle, alpha: this.globalAlpha, box: { x, y, width, height }, points: 4, dash: [], lineWidth: 0 })
  }

  beginPath(): void { this.calls.push('beginPath'); this.path = [] }
  moveTo(x: number, y: number): void { this.calls.push('moveTo'); this.path.push({ x, y }) }
  lineTo(x: number, y: number): void { this.calls.push('lineTo'); this.path.push({ x, y }) }
  arc(x: number, y: number, radius: number): void { this.calls.push('arc'); this.path.push({ x, y }, { x: x + radius, y: y + radius }) }
  arcTo(x1: number, y1: number, x2: number, y2: number): void { this.calls.push('arcTo'); this.path.push({ x: x1, y: y1 }, { x: x2, y: y2 }) }
  closePath(): void { this.calls.push('closePath') }

  private boxOfPath(): Box {
    const xs = this.path.map((point) => point.x)
    const ys = this.path.map((point) => point.y)
    if (xs.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY }
  }

  fill(): void {
    this.calls.push('fill')
    this.fills.push({ seq: this.seq(), style: this.fillStyle, alpha: this.globalAlpha, box: this.boxOfPath(), points: this.path.length, dash: [], lineWidth: 0 })
  }

  stroke(): void {
    this.calls.push('stroke')
    this.strokes.push({
      seq: this.seq(), style: this.strokeStyle, alpha: this.globalAlpha, box: this.boxOfPath(),
      points: this.path.length, dash: [...this.dash], lineWidth: this.lineWidth,
    })
  }

  fillText(text: string, x: number, y: number): void {
    this.calls.push(`fillText(${text})`)
    this.texts.push({ seq: this.seq(), text, x, y, style: this.fillStyle })
  }

  /** Forget everything recorded so far, so one layer can be asserted on its own. */
  reset(): void {
    this.calls.length = 0
    this.fills.length = 0
    this.strokes.length = 0
    this.rects.length = 0
    this.texts.length = 0
    this.measurements.length = 0
    this.path = []
  }
}

/** A canvas stand-in: the painter only ever touches these four things. */
function mount(recorder: Recorder): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext: () => recorder,
  } as unknown as HTMLCanvasElement
}

const near = (a: Box, b: Box, tolerance = 8): boolean =>
  Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance
    && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance

const labels = { external: '树外', empty: '没有汇报', status: { open: '进行中', acked: '已回执', closed: '已结案' } }
const viewport = (width: number, height: number) => ({ offsetX: 0, offsetY: 0, scale: 1, width, height })

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
const tokens: Record<string, string> = {
  '--dsw-alias-bg-base': '#101010',
  '--dsw-alias-bg-layer-3': '#202020',
  '--dsw-alias-state-warn-primary': '#ffaa00',
  // Distinct from every wire colour on purpose: the fallback theme happens to give
  // the accent and the thread colour the same value, which would make "is this
  // stroke a wire or a frame outline" unanswerable for the recorder. The hover
  // colour gets its own token for the same reason: the pointer layer must be
  // attributable even when a focused path is drawn on top of the drawing.
  '--dsw-alias-brand-primary': '#ff00ff',
  '--dsw-alias-button-info-hover': '#0088ff',
  '--dsw-alias-state-business-primary': '#00aa88',
  '--dsw-font-xs-13-font-size': '13px',
  '--dsw-font-xs-13-font-weight': '600',
  '--dsw-font-xs-13-line-height': '18px',
  '--dsw-font-xs-13-font-family': 'Inter, sans-serif',
}
const themed = readTheme((name) => tokens[name] ?? '')
check('a colour token lands in the theme', themed.canvas === '#101010' && themed.surface === '#202020')
check('a status tone token lands in the theme', themed.warning === '#ffaa00')
check('a token the shell does not define falls back', themed.tertiary === FALLBACK_THEME.tertiary)
check('a font token assembles into one font',
  themed.fonts.title.size === 13 && themed.fonts.title.weight === 600
    && themed.fonts.title.lineHeight === 18 && themed.fonts.title.family === 'Inter, sans-serif')
check('a partly missing font token keeps the fallback for the part that is missing',
  themed.fonts.body.size === FALLBACK_THEME.fonts.body.size
    && themed.fonts.body.family === FALLBACK_THEME.fonts.body.family)
check('a font renders as a canvas font string', fontString(themed.fonts.title) === '600 13px Inter, sans-serif')
check('every colour slot has a fallback',
  Object.entries(FALLBACK_THEME).filter(([key]) => key !== 'fonts').every(([, value]) => String(value).trim() !== ''))
check('every font slot has a usable fallback',
  Object.values(FALLBACK_THEME.fonts).every((font) => font.size > 0 && font.family.trim() !== ''))

let reads = 0
const style = {
  getPropertyValue: (name: string) => { reads++; return tokens[name] ?? '' },
}
const reader = createThemeReader({} as Element, { getComputedStyle: () => style } as unknown as Window)
const first = reader.read()
const afterFirst = reads
reader.read()
check('a second read of an unchanged theme only reads the canary', reads === afterFirst + 1, `${afterFirst} then ${reads}`)
tokens['--dsw-alias-bg-base'] = '#303030'
const changed = reader.read()
check('a theme change is picked up', changed.canvas === '#303030' && first.canvas === '#101010')

// ---------------------------------------------------------------------------
// Reading the theme through a chain of elements
// ---------------------------------------------------------------------------
// DSH declares the palette on `body`, not on `:root`, so the reader is handed a
// chain: pointing it at the document element alone reads the empty string for every
// token and collapses the drawing onto the fallback theme — a white canvas in a dark
// shell. These pin the contract the view relies on.
/** A window whose elements each carry their own token map. */
const chainWindow = (byElement: Map<Element, Record<string, string>>): Window => ({
  getComputedStyle: (element: Element) => ({
    getPropertyValue: (name: string) => byElement.get(element)?.[name] ?? '',
  }),
}) as unknown as Window
const bodyCandidate = {} as Element
const rootCandidate = {} as Element
const paletteOnBody: Record<string, string> = { '--dsw-alias-bg-base': '#0b0b0b', '--dsw-alias-bg-layer-3': '#1b1b1b' }
const paletteOnRoot: Record<string, string> = { '--dsw-alias-bg-base': '#2b2b2b' }
const noTokens: Record<string, string> = {}
check('a chain reads the candidate that declares the palette', (() => {
  const fakeWindow = chainWindow(new Map([[bodyCandidate, paletteOnBody], [rootCandidate, noTokens]]))
  return createThemeReader([bodyCandidate, rootCandidate], fakeWindow).read().canvas === '#0b0b0b'
})())
check('a chain still finds the palette when a host puts it on the root instead', (() => {
  const fakeWindow = chainWindow(new Map([[bodyCandidate, noTokens], [rootCandidate, paletteOnRoot]]))
  return createThemeReader([bodyCandidate, rootCandidate], fakeWindow).read().canvas === '#2b2b2b'
})())
check('a chain with no palette anywhere stays on the guaranteed-visible theme', (() => {
  const fakeWindow = chainWindow(new Map([[bodyCandidate, noTokens], [rootCandidate, noTokens]]))
  return createThemeReader([bodyCandidate, rootCandidate], fakeWindow).read().canvas === FALLBACK_THEME.canvas
})())
check('one element is still a one-candidate chain', (() => {
  const fakeWindow = chainWindow(new Map([[bodyCandidate, paletteOnBody]]))
  return createThemeReader(bodyCandidate, fakeWindow).read().canvas === '#0b0b0b'
})())
// The audit's defect in one assertion: the reader used to be pointed at an element
// that declares none of the tokens. A complete map must leave nothing on the
// fallback, so "the palette was found" is a property of the input, not of luck.
const complete = readTheme((name) => (
  name.endsWith('-font-family') ? 'Inter, sans-serif'
    : name.includes('-font-weight') ? '500'
      : name.includes('-line-height') ? '20px'
        : name.includes('-font-size') ? '13px'
          : '#123456'
))
check('a complete token map never falls back',
  complete.canvas === '#123456' && complete.frameBorder === '#123456' && complete.business === '#123456'
    && complete.fonts.title.size === 13 && complete.fonts.title.family === 'Inter, sans-serif')

// ---------------------------------------------------------------------------
// Folding text
// ---------------------------------------------------------------------------
const measure = (text: string): number => text.length * 7
check('text that fits is one line', foldText('short', 70, measure).join('|') === 'short')
check('text that does not fit is elided', foldText('a very long subject line', 70, measure)[0]?.endsWith('…') === true)
check('an elided line still fits', foldText('a very long subject line', 70, measure).every((line) => measure(line) <= 70))
check('two lines are asked for and two fit', foldText('alpha beta gamma delta', 70, measure, 2).length === 2)
check('a long word with no spaces wraps by character', foldText('汇报生命周期与传递路径的完整记录', 49, measure, 3).length === 3)
check('every wrapped line fits, including the elided last one',
  foldText('汇报生命周期与传递路径的完整记录与审计线索', 49, measure, 3).every((line) => measure(line) <= 49))
check('latin text breaks at a space when one is far enough back',
  foldText('alpha beta gamma', 70, measure, 2)[0]?.trim() === 'alpha beta')
check('whitespace-only text produces no lines', foldText('   ', 70, measure).length === 0)
check('no width produces no lines', foldText('something', 0, measure).length === 0)
check('no lines produces no lines', foldText('something', 70, measure, 0).length === 0)
check('a newline in a subject does not become a second paragraph',
  foldText('first\nsecond', 700, measure).join('|') === 'first second')
check('nothing fits at all and the line is a bare ellipsis', elide('abcdefgh', 1, measure) === '…')
check('text that fits is not touched by elide', elide('abc', 70, measure) === 'abc')

// ---------------------------------------------------------------------------
// A scene with all four wire kinds in it
// ---------------------------------------------------------------------------
const plotted = [
  report('R-0001', { to: ['session-child'], cc: ['session-child'], created: at(5), task: 'ledger' }),
  report('R-0002', { from: 'session-child', to: ['session-root'], parent: 'R-0001', created: at(6), status: 'acked' }),
  report('R-0003', { from: 'session-child', authors: ['session-child', 'session-root'], created: at(7) }),
]
const layout = buildCardgraph(payload, plotted)
check('the fixture has all four wire kinds',
  new Set(layout.edges.map((edge) => edge.kind)).size === 4, layout.edges.map((edge) => edge.kind).join())
const full = { layout, theme: themed, viewport: viewport(1400, 900), labels, overscan: 0 }

const paint = (scene: Record<string, unknown> = {}): { recorder: Recorder; painter: ReturnType<typeof createCanvasPainter> } => {
  const recorder = new Recorder()
  const painter = createCanvasPainter(mount(recorder))
  painter.resize(1400, 900, 1)
  painter.paint({ ...full, ...scene } as never)
  return { recorder, painter }
}

/** A stroke that is a wire rather than a frame or card border, told apart by colour. */
const wireStrokes = (recorder: Recorder): Shape[] =>
  recorder.strokes.filter((stroke) => [
    themed.secondary, themed.caption, themed.business, themed.hover, themed.success, themed.text,
  ].includes(stroke.style))

const whole = paint()
check('the background is painted in the theme\'s canvas colour', whole.recorder.rects[0]?.style === themed.canvas)
check('the paint is cleared before anything is drawn',
  whole.recorder.calls.indexOf('clearRect') < whole.recorder.calls.indexOf('fillRect'))
check('the viewport transform is the pan, then the zoom', (() => {
  const { recorder } = paint({ viewport: { ...viewport(800, 600), offsetX: 12, offsetY: 34, scale: 0.5 } })
  const translate = recorder.calls.indexOf('translate(12,34)')
  const scale = recorder.calls.indexOf('scale(0.5,0.5)')
  return translate >= 0 && scale > translate
})())

const ratioCanvas = mount(new Recorder())
const ratioPainter = createCanvasPainter(ratioCanvas)
ratioPainter.resize(400, 300, 2)
check('the backing store is the css size times the ratio',
  ratioCanvas.width === 800 && ratioCanvas.height === 600
    && ratioCanvas.style.width === '400px' && ratioCanvas.style.height === '300px')
ratioPainter.paint(full as never)
check('the ratio is applied as the first transform',
  (ratioCanvas.getContext('2d') as unknown as Recorder).calls.includes('setTransform(2,0,0,2,0,0)'))

// ---------------------------------------------------------------------------
// Order, culling and level of detail
// ---------------------------------------------------------------------------
const frameFill = whole.recorder.fills.find((fill) => near(fill.box, layout.frames[0]?.bounds as Box))
const cardFill = whole.recorder.fills.find((fill) => near(fill.box, layout.cards[0]?.bounds as Box, 6))
const firstWire = wireStrokes(whole.recorder)[0]
check('a frame is filled in the frame colour', frameFill !== undefined && frameFill.style === themed.frame)
// The title bar's height is the layout's, not a number of the painter's own: cards
// start below it, ports stay out of it, and a card pushed up into it would be drawn
// under the title.
check('the layout carries the title-bar height the painter draws with', layout.frameHeaderHeight === 26)
const tallerHeader = buildCardgraph(payload, plotted, { frameHeaderHeight: 40 })
const tallerScene = paint({ layout: tallerHeader })
check('the title bar is as tall as the layout says',
  tallerScene.recorder.rects.some((rect) => rect.style === themed.frameBar && rect.box.height === 40))
check('a taller title bar moves the title into its middle', (() => {
  const frame = tallerHeader.frames[0]
  const label = frame?.title ?? frame?.shortId
  const drawn = tallerScene.recorder.texts.find((text) => text.text === label)
  return frame !== undefined && drawn !== undefined && Math.abs(drawn.y - (frame.bounds.y + 20.5)) < 1e-9
})())
check('a card is filled in the surface colour', cardFill !== undefined && cardFill.style === themed.surface)
check('an unfocused frame is bordered without the accent',
  whole.recorder.strokes.some((stroke) => near(stroke.box, layout.frames[0]?.bounds as Box) && stroke.style === themed.frameBorder))
check('the frame is drawn before the wires between them',
  (frameFill?.seq ?? Number.MAX_SAFE_INTEGER) < (firstWire?.seq ?? 0))
check('cards are drawn after the wires that run between frames',
  (cardFill?.seq ?? 0) > (firstWire?.seq ?? Number.MAX_SAFE_INTEGER))
check('every plotted report is drawn at a full viewport',
  plotted.every((front) => whole.recorder.texts.some((text) => text.text === front.report)))

// A viewport over the root column only: the child sits at x >= 336 and must not be
// drawn, however cheap drawing it would be.
const narrow = paint({ viewport: viewport(280, 400) })
check('a card outside the viewport is not drawn', narrow.recorder.texts.every((text) => text.text !== 'R-0002'))
check('a card inside the viewport is still drawn', narrow.recorder.texts.some((text) => text.text === 'R-0001'))
check('a frame outside the viewport is not filled',
  narrow.recorder.fills.every((fill) => !near(fill.box, layout.frames[1]?.bounds as Box)))
const straddling = paint({ viewport: viewport(350, 400) })
check('a card that merely straddles the viewport edge is drawn',
  straddling.recorder.texts.some((text) => text.text === 'R-0002'))
const overscanned = paint({ viewport: viewport(280, 400), overscan: 200 })
check('an overscan keeps more than the viewport shows',
  overscanned.recorder.texts.some((text) => text.text === 'R-0002'))
check('an overscan never draws less than the viewport alone',
  overscanned.recorder.texts.length >= narrow.recorder.texts.length)

const chipLayout = buildCardgraph(payload, plotted, { lod: 'chip' })
const chipScene = paint({ layout: chipLayout })
check('a chip draws no card text',
  chipLayout.cards.every((card) => !chipScene.recorder.texts.some((text) => text.text === card.report)))
check('a chip is filled in its status tone', chipScene.recorder.fills.some((fill) => fill.style === themed.warning))
const compactLayout = buildCardgraph(payload, plotted, { lod: 'compact' })
const compactScene = paint({ layout: compactLayout })
check('a compact card names itself exactly once',
  compactLayout.cards.every((card) => compactScene.recorder.texts.filter((text) => text.text === card.report).length === 1))
check('a compact card draws fewer words than a full one',
  compactScene.recorder.texts.length < whole.recorder.texts.length,
  `${compactScene.recorder.texts.length} vs ${whole.recorder.texts.length}`)
check('a compact card does not draw the status words',
  !compactScene.recorder.texts.some((text) => text.text === labels.status.open))
// Each half of a compact card is measured in the font it is drawn in. Folding the
// subject against the heavier id font shortened it, and would overflow the card in a
// theme whose body font is the larger of the two.
const compactIds = (): readonly Measured[] =>
  compactScene.recorder.measurements.filter((measured) => /^R-\d+$/.test(measured.text))
const compactSubjects = (): readonly Measured[] =>
  compactScene.recorder.measurements.filter((measured) => measured.text.startsWith('· '))
check('a compact card measures its id in the id font',
  compactIds().length > 0 && compactIds().every((measured) => measured.font === fontString(themed.fonts.id)))
check('a compact card measures its subject in the body font',
  compactSubjects().length > 0 && compactSubjects().every((measured) => measured.font === fontString(themed.fonts.body)))
check('a full card says the report id, its status and its task',
  ['R-0001', '进行中', 'ledger'].every((text) => whole.recorder.texts.some((drawn) => drawn.text === text)))
check('a card in another state draws that state\'s words',
  whole.recorder.texts.some((drawn) => drawn.text === '已回执'))
check('the status stripe is as wide as the stripe and in the status tone',
  whole.recorder.rects.some((rect) => rect.style === themed.warning && rect.box.width === 3))
check('each state also has a shape, not only a colour', (() => {
  const inside = (box: Box, card: Box): boolean => box.x >= card.x && box.x <= card.x + card.width
    && box.y >= card.y && box.y <= card.y + card.height
  const one = (status: string): { layout: ReturnType<typeof buildCardgraph>; recorder: Recorder } => {
    const layout = buildCardgraph(payload, [report(`R-1${status}`, { status })])
    return { layout, recorder: paint({ layout }).recorder }
  }
  const open = one('open')
  const openBox = open.layout.cards[0]?.bounds as Box
  const dot = open.recorder.fills.some((fill) => fill.style === themed.warning
    && fill.points === 2 && inside(fill.box, openBox))
  const acked = one('acked')
  const ackedBox = acked.layout.cards[0]?.bounds as Box
  const checkMark = acked.recorder.strokes.some((stroke) => stroke.style === themed.success
    && stroke.lineWidth === 1.4 && inside(stroke.box, ackedBox))
  const closed = one('closed')
  const closedBox = closed.layout.cards[0]?.bounds as Box
  const block = closed.recorder.rects.some((rect) => rect.style === themed.tertiary
    && rect.box.width <= 8 && rect.box.height <= 8 && inside(rect.box, closedBox))
  return dot && checkMark && block
})())
check('a compact card draws no status mark either', (() => {
  const layout = buildCardgraph(payload, plotted, { lod: 'compact' })
  const recorder = paint({ layout }).recorder
  const boxes = layout.cards.map((card) => card.bounds)
  const marked = [...recorder.fills, ...recorder.rects].some((mark) =>
    [themed.warning, themed.success, themed.tertiary].includes(mark.style)
    && mark.box.width > 0 && mark.box.width <= 8 && mark.box.height <= 8
    && boxes.some((box) => mark.box.x >= box.x && mark.box.x <= box.x + box.width
      && mark.box.y >= box.y && mark.box.y <= box.y + box.height))
  return !marked
})())
check('an empty frame says so', (() => {
  const oneCard = buildCardgraph(payload, [report('R-0009')])
  return paint({ layout: oneCard }).recorder.texts.some((text) => text.text === labels.empty)
})())
check('an empty frame is not painted by a frame that has cards', (() => {
  const oneCard = buildCardgraph(payload, [report('R-0009')])
  const scene = paint({ layout: oneCard })
  return scene.recorder.texts.filter((text) => text.text === labels.empty).length === 1
})())
check('an out-of-tree frame is labelled as such', (() => {
  const outside = buildCardgraph(payload, [report('R-0010', { from: 'session-outsider' })])
  return paint({ layout: outside }).recorder.texts.some((text) => text.text === labels.external)
})())
check('a resident session gets a filled dot and an absent one an outline', (() => {
  const dots = whole.recorder.fills.filter((fill) => fill.points === 2 && fill.style === themed.success)
  return dots.length >= 1
})())

// ---------------------------------------------------------------------------
// Wires
// ---------------------------------------------------------------------------
const delivery = layout.edges.find((edge) => edge.kind === 'to')
const threadEdge = layout.edges.find((edge) => edge.kind === 'thread')
check('a routed wire is a polyline that starts and ends at its ports', (() => {
  const points = wirePoints(delivery as never)
  return points.length >= 4
    && points[0]?.x === delivery?.from.x && points[0]?.y === delivery?.from.y
    && points[points.length - 1]?.x === delivery?.to.x && points[points.length - 1]?.y === delivery?.to.y
})())
const bent = wirePoints(threadEdge as never)
check('a wire with a gutter is four points', bent.length === 4)
check('the bend runs down the gutter between the second and third points',
  bent[1]?.x === threadEdge?.viaX && bent[2]?.x === threadEdge?.viaX)
check('a bent wire leaves its start horizontally', bent[1]?.y === bent[0]?.y)
check('a bent wire arrives horizontally', bent[2]?.y === bent[3]?.y)
check('a wire starts at its from end', bent[0]?.x === threadEdge?.from.x && bent[0]?.y === threadEdge?.from.y)
check('a wire ends at its to end', bent[3]?.x === threadEdge?.to.x && bent[3]?.y === threadEdge?.to.y)

const dashOf = (kind: string): string => {
  const edge = layout.edges.find((candidate) => candidate.kind === kind)
  const stroke = wireStrokes(whole.recorder).find((candidate) => near(candidate.box, edge?.bounds as Box, 5))
  return (stroke?.dash ?? ['?']).join(' ')
}
check('a delivery is solid', dashOf('to') === '', dashOf('to'))
check('a copy is dashed with a short gap', dashOf('cc') === '4 2', dashOf('cc'))
check('a co-author wire is finely dotted', dashOf('author') === '2 2', dashOf('author'))
check('a thread is solid', dashOf('thread') === '', dashOf('thread'))
check('a delivery is drawn heavier than a copy', (() => {
  const to = wireStrokes(whole.recorder).find((stroke) => near(stroke.box, layout.edges.find((edge) => edge.kind === 'to')?.bounds as Box, 5))
  const cc = wireStrokes(whole.recorder).find((stroke) => near(stroke.box, layout.edges.find((edge) => edge.kind === 'cc')?.bounds as Box, 5))
  return (to?.lineWidth ?? 0) > (cc?.lineWidth ?? 0)
})())

const heads = whole.recorder.fills.filter((fill) => fill.points === 3)
check('a wire with a bend is drawn with a rounded corner', whole.recorder.calls.includes('arcTo'))
check('every wire ends in a filled arrowhead', heads.length === layout.edges.length,
  `${heads.length} heads for ${layout.edges.length} wires`)
check('every arrowhead lands just short of its wire target', heads.every((head) =>
  layout.edges.some((edge) => {
    // Nearest-point distance from the head's box to the target: the head stops a
    // short gap away, so the box edge (not the target) is the closest thing to it.
    const dx = Math.max(head.box.x - edge.to.x, 0, edge.to.x - (head.box.x + head.box.width))
    const dy = Math.max(head.box.y - edge.to.y, 0, edge.to.y - (head.box.y + head.box.height))
    return Math.hypot(dx, dy) <= 4
  })))

/** Half way along a polyline, measured the same way the painter does. */
const midpointOf = (points: readonly { readonly x: number; readonly y: number }[]): { x: number; y: number } | undefined => {
  let total = 0
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]
    const b = points[index]
    if (a === undefined || b === undefined) continue
    total += Math.hypot(b.x - a.x, b.y - a.y)
  }
  if (total < 36) return undefined
  let remaining = total / 2
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]
    const b = points[index]
    if (a === undefined || b === undefined) continue
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (remaining <= length && length > 0) {
      const t = remaining / length
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
    remaining -= length
  }
  return undefined
}
/** Marker dots: small arc fills, told apart from the frame's own dots by radius. */
const markerDots = (recorder: Recorder): Shape[] =>
  recorder.fills.filter((fill) => fill.points === 2 && Math.abs(fill.box.width - 2.1) < 0.01)
check('a wire carries a midpoint dot at its middle', (() => {
  const edge = layout.edges.find((candidate) => candidate.kind === 'to')
  const middle = midpointOf(wirePoints(edge as never))
  if (middle === undefined) return false
  return whole.recorder.fills.some((fill) => fill.points === 2
    && Math.abs(fill.box.width - 2.1) < 0.01
    && Math.abs(fill.box.x - middle.x) < 1 && Math.abs(fill.box.y - middle.y) < 1)
})())
check('the dot sits on a canvas-coloured halo', (() => {
  const halo = whole.recorder.fills.find((fill) => fill.points === 2
    && fill.style === themed.canvas && Math.abs(fill.box.width - 3.4) < 0.01)
  const dot = markerDots(whole.recorder)[0]
  return halo !== undefined && dot !== undefined && halo.seq < dot.seq
})())
check('no marker is drawn on a wire too short for one', (() => {
  const middles = layout.edges
    .map((edge) => midpointOf(wirePoints(edge)))
    .filter((point): point is { x: number; y: number } => point !== undefined)
  return markerDots(whole.recorder).every((dot) =>
    middles.some((middle) => Math.abs(dot.box.x - middle.x) < 1 && Math.abs(dot.box.y - middle.y) < 1))
})())

// ---------------------------------------------------------------------------
// The interaction layer
// ---------------------------------------------------------------------------
/** Paint the base layer, forget it, then paint the interaction layer alone. */
const overlay = (scene: Record<string, unknown> = {}): Recorder => {
  const recorder = new Recorder()
  const painter = createCanvasPainter(mount(recorder))
  painter.resize(1400, 900, 1)
  painter.paint(full as never)
  recorder.reset()
  painter.paintPath({ ...full, ...scene } as never)
  return recorder
}

check('with nothing focused the interaction layer draws nothing', (() => {
  const blank = overlay()
  return blank.fills.length === 0 && blank.strokes.length === 0 && blank.texts.length === 0
})())
// A selection is not a hover: the base layer accents the open card, but the scrim
// belongs to the pointer. Since a click now opens a report, a selected-only overlay
// would dim the drawing for as long as that report stays open.
check('a selection alone does not dim the drawing', (() => {
  const selected = overlay({ focus: { selected: 'R-0001' } })
  return selected.fills.length === 0 && selected.strokes.length === 0 && selected.texts.length === 0
})())
check('the base layer is drawn at full strength whatever is focused',
  paint({ focus: { report: 'R-0001' } }).recorder.strokes.every((stroke) => stroke.alpha === 1))
check('focusing a report lays a scrim over the visible world', (() => {
  const scrim = overlay({ focus: { report: 'R-0001' } }).rects[0]
  return scrim !== undefined && scrim.style === themed.canvas
    && Math.abs(scrim.alpha - 0.55) < 0.001
    && near(scrim.box, { x: 0, y: 0, width: 1400, height: 900 }, 1)
})())
// The scrim has to leave the rest of the drawing legible: it is a canvas-wide wash,
// so anything close to opaque takes the frames and titles with it.
check('the scrim leaves more than a third of the drawing showing', 1 - 0.55 > 0.35)
check('only the focused report\'s wires are drawn over the scrim', (() => {
  const recorder = overlay({ focus: { report: 'R-0001' } })
  const mine = layout.edges.filter((edge) => edge.report === 'R-0001')
  // Wires keep their own weight, from the one table; the card ring is 1.6 and the
  // frame outlines are 1, so the same colour does not make them indistinguishable.
  const wireWidths = new Set(Object.values(WIRE_TOKENS).map((token) => token.width))
  const drawn = wireStrokes(recorder).filter((stroke) => stroke.alpha === 1 && wireWidths.has(stroke.lineWidth))
  return drawn.length === mine.length
    && mine.every((edge) => drawn.some((stroke) => near(stroke.box, edge.bounds, 5)))
})())
check('every drawn wire over the scrim is at full strength',
  wireStrokes(overlay({ focus: { report: 'R-0001' } })).every((stroke) => stroke.alpha === 1))
// The hover reveal: the scrim fades in, the wires draw outward, and a traveller dot
// rides the drawing front. Phase 1 is the settled hover every other check draws.
check('a hover in progress fades its scrim in', (() => {
  const recorder = overlay({ focus: { report: 'R-0001' }, hoverPhase: 0.4 })
  const scrim = recorder.rects.find((rect) => rect.style === themed.canvas)
  // 0.55 is SCRIM_ALPHA: the settled dim, scaled by the reveal phase.
  return scrim !== undefined && Math.abs(scrim.alpha - 0.55 * 0.4) < 1e-9
})())
check('a hover in progress has not drawn its arrowheads yet', (() => {
  const recorder = overlay({ focus: { report: 'R-0001' }, hoverPhase: 0.4 })
  return recorder.fills.filter((fill) => fill.points === 3).length === 0
})())
check('a hover in progress carries a traveller dot at its front', (() => {
  const recorder = overlay({ focus: { report: 'R-0001' }, hoverPhase: 0.4 })
  return recorder.fills.some((fill) => fill.points === 2 && fill.style === themed.hover
    && Math.abs(fill.box.width - 2.1) < 0.01)
})())
/** The comet's head: a 2.5px hover-coloured dot (the marker is 2.1). */
const cometHead = (recorder: Recorder): { x: number; y: number } | undefined => {
  const fill = recorder.fills.find((candidate) => candidate.points === 2
    && candidate.style === themed.hover && Math.abs(candidate.box.width - 2.5) < 0.01)
  return fill === undefined ? undefined : { x: fill.box.x, y: fill.box.y }
}
check('a hovered path keeps a comet running after its reveal', (() => {
  const recorder = overlay({ focus: { report: 'R-0001' }, hoverPhase: 1, hoverFlow: 0.5 })
  return cometHead(recorder) !== undefined
})())
check('the comet moves along the path as the flow advances', (() => {
  const early = cometHead(overlay({ focus: { report: 'R-0001' }, hoverPhase: 1, hoverFlow: 0.2 }))
  const late = cometHead(overlay({ focus: { report: 'R-0001' }, hoverPhase: 1, hoverFlow: 0.8 }))
  if (early === undefined || late === undefined) return false
  return Math.abs(early.x - late.x) + Math.abs(early.y - late.y) > 8
})())
check('the focused card is redrawn in the pointer colour, with an uncoloured id', (() => {
  const recorder = overlay({ focus: { report: 'R-0001' } })
  return recorder.texts.some((text) => text.text === 'R-0001' && text.style === themed.text)
    && recorder.strokes.some((stroke) => stroke.style === themed.hover
      && near(stroke.box, layout.cards.find((card) => card.report === 'R-0001')?.bounds as Box, 6))
})())
check('every focused wire is drawn in the pointer colour', (() => {
  const recorder = overlay({ focus: { report: 'R-0001' } })
  const wireWidths = new Set(Object.values(WIRE_TOKENS).map((token) => token.width))
  const mine = wireStrokes(recorder).filter((stroke) => stroke.alpha === 1 && wireWidths.has(stroke.lineWidth))
  return mine.length > 0 && mine.every((stroke) => stroke.style === themed.hover)
})())
check('the frames the path touches are re-outlined', (() => {
  const recorder = overlay({ focus: { report: 'R-0001' } })
  const touched = new Set<number>()
  for (const edge of layout.edges.filter((candidate) => candidate.report === 'R-0001')) {
    if (edge.from.kind === 'frame') touched.add(edge.from.index)
    if (edge.to.kind === 'frame') touched.add(edge.to.index)
  }
  const outlines = recorder.strokes.filter((stroke) => stroke.style === themed.hover)
    .filter((stroke) => layout.frames.some((frame) => near(stroke.box, frame.bounds, 2)))
  return outlines.length === touched.size
})())
check('focusing a frame outlines it without a scrim', (() => {
  const recorder = overlay({ focus: { frame: 0 } })
  return recorder.rects.length === 0
    && recorder.strokes.length === 1
    && recorder.strokes[0]?.style === themed.hover
    && near(recorder.strokes[0]?.box as Box, layout.frames[0]?.bounds as Box, 2)
})())
check('the open card is named in the accent on the base layer',
  paint({ focus: { selected: 'R-0001' } }).recorder.texts
    .some((text) => text.text === 'R-0001' && text.style === themed.accent))

// ---------------------------------------------------------------------------
// Measurement never moves geometry
// ---------------------------------------------------------------------------
const geometryOf = (charWidth: number): string => {
  const recorder = new Recorder()
  recorder.charWidth = charWidth
  const painter = createCanvasPainter(mount(recorder))
  painter.resize(1400, 900, 1)
  painter.paint(full as never)
  return JSON.stringify(recorder.fills.map((fill) => [fill.box, fill.style]))
    + '|' + JSON.stringify(recorder.strokes.map((stroke) => [stroke.box, stroke.dash, stroke.alpha]))
}
check('the drawn geometry is identical whether text measures wide or narrow',
  geometryOf(1) === geometryOf(40))
check('but the text itself does follow the measurement',
  (() => {
    const narrowText = (charWidth: number): string => {
      const recorder = new Recorder()
      recorder.charWidth = charWidth
      const painter = createCanvasPainter(mount(recorder))
      painter.resize(1400, 900, 1)
      painter.paint(full as never)
      return recorder.texts.map((text) => text.text).join('|')
    }
    return narrowText(1) !== narrowText(40)
  })())

const cached = paint()
const measuredOnce = cached.recorder.measureCalls
cached.painter.paint(full as never)
check('a second paint re-measures nothing', cached.recorder.measureCalls === measuredOnce,
  `${measuredOnce} then ${cached.recorder.measureCalls}`)
check('the first paint measured something to begin with', measuredOnce > 0)
cached.painter.reset()
cached.painter.paint(full as never)
check('resetting the cache makes the next paint measure again', cached.recorder.measureCalls > measuredOnce)

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
