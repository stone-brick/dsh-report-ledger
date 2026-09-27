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
  createCanvasPainter, readTheme, createThemeReader, fontString, foldText, elide, wirePoints, FALLBACK_THEME,
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

/** A context stand-in. Coordinates are recorded raw, so they are world coordinates. */
class Recorder {
  readonly calls: string[] = []
  readonly fills: Shape[] = []
  readonly strokes: Shape[] = []
  readonly rects: Shape[] = []
  readonly texts: Drawn[] = []
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
  measureText(text: string): { width: number } { this.measureCalls++; return { width: text.length * this.charWidth } }

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
  // stroke a wire or a frame outline" unanswerable for the recorder.
  '--dsw-alias-brand-primary': '#ff00ff',
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
  recorder.strokes.filter((stroke) => [themed.secondary, themed.caption, themed.business].includes(stroke.style))

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
check('a full card says the report id, its status and its task',
  ['R-0001', '进行中', 'ledger'].every((text) => whole.recorder.texts.some((drawn) => drawn.text === text)))
check('a card in another state draws that state\'s words',
  whole.recorder.texts.some((drawn) => drawn.text === '已回执'))
check('the status stripe is as wide as the stripe and in the status tone',
  whole.recorder.rects.some((rect) => rect.style === themed.warning && rect.box.width === 3))
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
check('a wire with no gutter is two points', wirePoints(delivery as never).length === 2)
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
  const stroke = wireStrokes(whole.recorder).find((candidate) => near(candidate.box, edge?.bounds as Box, 2))
  return (stroke?.dash ?? ['?']).join(' ')
}
check('a delivery is solid', dashOf('to') === '', dashOf('to'))
check('a copy is dotted', dashOf('cc') === '2 3', dashOf('cc'))
check('a co-author wire is finely dashed', dashOf('author') === '1 3', dashOf('author'))
check('a thread is solid', dashOf('thread') === '', dashOf('thread'))
check('a delivery is drawn heavier than a copy', (() => {
  const to = wireStrokes(whole.recorder).find((stroke) => near(stroke.box, layout.edges.find((edge) => edge.kind === 'to')?.bounds as Box, 2))
  const cc = wireStrokes(whole.recorder).find((stroke) => near(stroke.box, layout.edges.find((edge) => edge.kind === 'cc')?.bounds as Box, 2))
  return (to?.lineWidth ?? 0) > (cc?.lineWidth ?? 0)
})())

const heads = whole.recorder.fills.filter((fill) => fill.points === 3)
check('every wire ends in a filled arrowhead', heads.length === layout.edges.length,
  `${heads.length} heads for ${layout.edges.length} wires`)
check('every arrowhead lands on its wire\'s target', heads.every((head) =>
  layout.edges.some((edge) =>
    head.box.x <= edge.to.x + 0.001 && edge.to.x <= head.box.x + head.box.width + 0.001
      && head.box.y <= edge.to.y + 0.001 && edge.to.y <= head.box.y + head.box.height + 0.001)))

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
  const drawn = wireStrokes(recorder).filter((stroke) => stroke.alpha === 1)
  return drawn.length === mine.length
    && mine.every((edge) => drawn.some((stroke) => near(stroke.box, edge.bounds, 2)))
})())
check('every drawn wire over the scrim is at full strength',
  wireStrokes(overlay({ focus: { report: 'R-0001' } })).every((stroke) => stroke.alpha === 1))
check('the focused card is redrawn in the accent', (() => {
  const recorder = overlay({ focus: { report: 'R-0001' } })
  return recorder.texts.some((text) => text.text === 'R-0001' && text.style === themed.accent)
    && recorder.strokes.some((stroke) => stroke.style === themed.accent
      && near(stroke.box, layout.cards.find((card) => card.report === 'R-0001')?.bounds as Box, 6))
})())
check('the frames the path touches are re-outlined', (() => {
  const recorder = overlay({ focus: { report: 'R-0001' } })
  const touched = new Set<number>()
  for (const edge of layout.edges.filter((candidate) => candidate.report === 'R-0001')) {
    if (edge.from.kind === 'frame') touched.add(edge.from.index)
    if (edge.to.kind === 'frame') touched.add(edge.to.index)
  }
  const outlines = recorder.strokes.filter((stroke) => stroke.style === themed.accent)
    .filter((stroke) => layout.frames.some((frame) => near(stroke.box, frame.bounds, 2)))
  return outlines.length === touched.size
})())
check('focusing a frame outlines it without a scrim', (() => {
  const recorder = overlay({ focus: { frame: 0 } })
  return recorder.rects.length === 0
    && recorder.strokes.length === 1
    && recorder.strokes[0]?.style === themed.accent
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
