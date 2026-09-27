/**
 * Painting the card canvas.
 *
 * The layout decides *what* is where; this module decides what a card, a frame
 * and a wire look like, and pushes them at a 2D context. Two choices carry the
 * design:
 *
 *  1. **The painter talks to a structural context, not to a canvas.** Everything
 *     it needs is the small `PaintContext` surface below — fills, paths, text,
 *     one transform — so the same painter drives a canvas, a recorder in a test,
 *     or an SVG surface, and nothing here can reach for the DOM. This is the part
 *     of draw.io's architecture worth copying: its shapes only ever talk to an
 *     `AbstractCanvas2D`, so `SvgCanvas2D` and `XmlCanvas2D` are drop-in. Ours
 *     keeps the same door open for a fraction of the code.
 *
 *  2. **Text is measured here and nowhere else.** `foldText` wraps and elides
 *     against a `measure` function, whose only production implementation reads the
 *     context's own metrics — cached per (font, text), because every measure on a
 *     canvas context is a synchronous text-layout call. The geometry never sees
 *     any of it: the layout's card sizes are constants, so however long a subject
 *     is, the card it sits in does not move.
 *
 * @module dsh-report-ledger/client/cardgraph-painter
 */

import type {
  CardgraphCard, CardgraphEdge, CardgraphEdgeKind, CardgraphFrame, CardgraphLayout, CardgraphViewport, Rect,
} from './cardgraph-model.ts'
import { intersects, worldViewport } from './cardgraph-model.ts'

/**
 * The 2D surface the painter draws through.
 *
 * A hand-picked subset of `CanvasRenderingContext2D`, which a real canvas context
 * satisfies as-is and a test can implement in twenty lines. Keeping it this small
 * is deliberate: every method here is one a hypothetical SVG painter must also
 * provide, and anything outside it would be a canvas-only shortcut.
 */
export interface PaintContext {
  save(): void
  restore(): void
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  clearRect(x: number, y: number, width: number, height: number): void
  fillRect(x: number, y: number, width: number, height: number): void
  beginPath(): void
  closePath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void
  clip(): void
  fill(): void
  stroke(): void
  fillText(text: string, x: number, y: number): void
  measureText(text: string): { readonly width: number }
  setLineDash(segments: readonly number[]): void
  translate(x: number, y: number): void
  scale(x: number, y: number): void
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  lineDashOffset: number
  globalAlpha: number
  font: string
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
}

/** One font token, resolved to what a context needs. */
export interface PaintFont {
  readonly size: number
  readonly weight: number
  readonly lineHeight: number
  readonly family: string
}

/**
 * The colours and fonts the painter draws with.
 *
 * Read once from the shell's `--dsw-*` tokens (`readTheme`), so the drawing
 * follows the light/dark theme without knowing it exists. Every field is a string
 * a context accepts verbatim.
 */
export interface PaintTheme {
  /** Page background behind the drawing. */
  readonly canvas: string
  /** Frame body. */
  readonly frame: string
  /** Frame title bar. */
  readonly frameBar: string
  /** Card body. */
  readonly surface: string
  /** Hairlines: frame borders, card borders. */
  readonly border: string
  readonly frameBorder: string
  /** Text, from loudest to quietest. */
  readonly text: string
  readonly secondary: string
  readonly caption: string
  readonly tertiary: string
  /** Accent for the focused or open card. */
  readonly accent: string
  /** Lifecycle tones, matching the tab's `Tag` tones. */
  readonly warning: string
  readonly success: string
  readonly error: string
  /** The colour threads are drawn in. */
  readonly business: string
  readonly fonts: {
    /** Frame titles. */
    readonly title: PaintFont
    /** Report ids, which want weight rather than size. */
    readonly id: PaintFont
    /** Card subjects. */
    readonly body: PaintFont
    /** Status and task, the quietest line. */
    readonly meta: PaintFont
  }
}

/** A guaranteed-visible theme, for a context with no tokens at all. */
export const FALLBACK_THEME: PaintTheme = {
  canvas: '#ffffff',
  frame: '#f6f7f9',
  frameBar: '#eef0f3',
  surface: '#ffffff',
  border: '#d8dbe0',
  frameBorder: '#c3c7ce',
  text: '#1a1c1f',
  secondary: '#4a4f57',
  caption: '#70757d',
  tertiary: '#9aa0a8',
  accent: '#2f6fed',
  warning: '#c77700',
  success: '#1f9254',
  error: '#d33a2c',
  business: '#2f6fed',
  fonts: {
    title: { size: 13, weight: 500, lineHeight: 18, family: 'system-ui, sans-serif' },
    id: { size: 12, weight: 600, lineHeight: 16, family: 'system-ui, sans-serif' },
    body: { size: 11, weight: 400, lineHeight: 15, family: 'system-ui, sans-serif' },
    meta: { size: 11, weight: 500, lineHeight: 15, family: 'system-ui, sans-serif' },
  },
}

/** Token name → the field it fills. Keeping it as data means one reader, not twenty. */
const TOKENS: readonly (readonly [keyof Omit<PaintTheme, 'fonts'>, string, string])[] = [
  ['canvas', '--dsw-alias-bg-base', FALLBACK_THEME.canvas],
  ['frame', '--dsw-alias-bg-layer-1', FALLBACK_THEME.frame],
  ['frameBar', '--dsw-alias-bg-layer-2', FALLBACK_THEME.frameBar],
  ['surface', '--dsw-alias-bg-layer-3', FALLBACK_THEME.surface],
  ['border', '--dsw-alias-border-l1', FALLBACK_THEME.border],
  ['frameBorder', '--dsw-alias-border-l2', FALLBACK_THEME.frameBorder],
  ['text', '--dsw-alias-label-primary', FALLBACK_THEME.text],
  ['secondary', '--dsw-alias-label-secondary', FALLBACK_THEME.secondary],
  ['caption', '--dsw-alias-label-caption', FALLBACK_THEME.caption],
  ['tertiary', '--dsw-alias-label-tertiary', FALLBACK_THEME.tertiary],
  ['accent', '--dsw-alias-brand-primary', FALLBACK_THEME.accent],
  ['warning', '--dsw-alias-state-warn-primary', FALLBACK_THEME.warning],
  ['success', '--dsw-alias-state-success-primary', FALLBACK_THEME.success],
  ['error', '--dsw-alias-state-error-primary', FALLBACK_THEME.error],
  ['business', '--dsw-alias-state-business-primary', FALLBACK_THEME.business],
]

/** Font token → the field it fills. Each token carries its own size, weight and family. */
const FONT_TOKENS: readonly (readonly [keyof PaintTheme['fonts'], string, PaintFont])[] = [
  ['title', '--dsw-font-xs-13', FALLBACK_THEME.fonts.title],
  ['id', '--dsw-font-xxs-strong-12', FALLBACK_THEME.fonts.id],
  ['body', '--dsw-font-xxxs-11', FALLBACK_THEME.fonts.body],
  ['meta', '--dsw-font-xxxs-strong-11', FALLBACK_THEME.fonts.meta],
]

/** The one token a theme change always moves, so a repaint can detect it cheaply. */
const CANARY = '--dsw-alias-bg-base'

/** A `var()`-style read of one token, with a fallback for a shell that has none. */
type ReadToken = (name: string) => string

/** Assemble a canvas font string. */
export function fontString(font: PaintFont): string {
  return `${font.weight} ${font.size}px ${font.family}`
}

/** Read one font token, taking its size/weight/line-height/family parts. */
function readFont(read: ReadToken, token: string, fallback: PaintFont): PaintFont {
  const size = Number.parseFloat(read(`${token}-font-size`))
  const weight = Number.parseFloat(read(`${token}-font-weight`))
  const lineHeight = Number.parseFloat(read(`${token}-line-height`))
  const family = read(`${token}-font-family`)
  return {
    size: Number.isFinite(size) && size > 0 ? size : fallback.size,
    weight: Number.isFinite(weight) && weight > 0 ? weight : fallback.weight,
    lineHeight: Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : fallback.lineHeight,
    family: family === '' ? fallback.family : family,
  }
}

/**
 * Read the drawing's colours and fonts out of the live theme.
 * @param read - a token reader, normally `getComputedStyle(root).getPropertyValue`.
 * @returns the theme; every field falls back so a missing token cannot blank the drawing.
 */
export function readTheme(read: ReadToken): PaintTheme {
  const pick = (token: string, fallback: string): string => {
    const value = read(token).trim()
    return value === '' ? fallback : value
  }
  const colours: Partial<Record<keyof Omit<PaintTheme, 'fonts'>, string>> = {}
  for (const [field, token, fallback] of TOKENS) colours[field] = pick(token, fallback)
  const fonts: Partial<Record<keyof PaintTheme['fonts'], PaintFont>> = {}
  for (const [field, token, fallback] of FONT_TOKENS) fonts[field] = readFont(read, token, fallback)
  return { ...FALLBACK_THEME, ...colours, fonts: { ...FALLBACK_THEME.fonts, ...fonts } }
}

/** A theme reader that only re-reads the tokens when the theme actually changed. */
export interface ThemeReader {
  /** @returns the current theme, cached until the canary token moves. */
  read(): PaintTheme
}

/**
 * Watch the theme through one token.
 *
 * `getComputedStyle(...).getPropertyValue` forces a style read, so doing twenty of
 * them per repaint would be paying for the theme on every hover. The canary is the
 * page background: if it did not move, nothing else did, and the cached theme is
 * returned.
 * @param root - the element carrying the tokens, normally `document.documentElement`.
 * @param win - the window to read styles from.
 * @returns the reader.
 */
export function createThemeReader(root: Element, win: Window): ThemeReader {
  const style = win.getComputedStyle(root)
  const read: ReadToken = (name) => style.getPropertyValue(name)
  let canary: string | undefined
  let cached: PaintTheme | undefined
  return {
    read(): PaintTheme {
      const current = read(CANARY)
      if (cached === undefined || current !== canary) {
        canary = current
        cached = readTheme(read)
      }
      return cached
    },
  }
}

/**
 * Shorten text until it fits, ending it with an ellipsis.
 * @param text - the text to fit.
 * @param maxWidth - the room available.
 * @param measure - width of a candidate string.
 * @returns text that fits, or `'…'` when not even one character does.
 */
export function elide(text: string, maxWidth: number, measure: (text: string) => number): string {
  if (measure(text) <= maxWidth) return text
  for (let take = text.length - 1; take > 0; take--) {
    const candidate = `${text.slice(0, take).trimEnd()}…`
    if (measure(candidate) <= maxWidth) return candidate
  }
  return '…'
}

/**
 * Wrap text to a width, eliding whatever does not fit in the last line.
 *
 * Character-by-character, with one concession to Latin text: when a line has to
 * break and there is a space far enough back, break at the space instead of mid
 * word. Chinese has no spaces, so a word-based rule would leave a long subject on
 * one line and elide most of it; this rule wraps it, and still avoids breaking
 * "report-ledger" in half when it can.
 * @param text - the text to lay out.
 * @param maxWidth - the room available.
 * @param measure - width of a candidate string.
 * @param maxLines - how many lines to produce.
 * @returns the lines, possibly empty.
 */
export function foldText(
  text: string,
  maxWidth: number,
  measure: (text: string) => number,
  maxLines = 1,
): readonly string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean === '' || maxWidth <= 0 || maxLines < 1) return []
  const lines: string[] = []
  let rest = clean
  while (rest !== '' && lines.length < maxLines) {
    if (lines.length === maxLines - 1) {
      lines.push(elide(rest, maxWidth, measure))
      break
    }
    if (measure(rest) <= maxWidth) {
      lines.push(rest)
      break
    }
    let cut = 0
    for (let take = 1; take <= rest.length; take++) {
      if (measure(rest.slice(0, take)) > maxWidth) break
      cut = take
    }
    if (cut === 0) {
      lines.push(elide(rest, maxWidth, measure))
      break
    }
    // Only back off to a space if it is at least a third of the way out: on a
    // narrow card backing off further would leave the line nearly empty.
    const space = rest.lastIndexOf(' ', cut)
    if (space > cut / 3) cut = space
    lines.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  return lines
}

/** What the pointer is on, or what the reader opened. */
export interface PaintFocus {
  /** Report under the pointer. */
  readonly report?: string
  /** Frame under the pointer. */
  readonly frame?: number
  /** Report whose detail panel is open. */
  readonly selected?: string
}

/** One frame's worth of drawing instructions. */
export interface PaintScene {
  readonly layout: CardgraphLayout
  readonly theme: PaintTheme
  readonly viewport: CardgraphViewport
  readonly focus?: PaintFocus
  /** Localised words the drawing needs, supplied by the view. */
  readonly labels: {
    /** The shared frame's title, e.g. "树外". */
    readonly external: string
    /** What an empty frame says. */
    readonly empty: string
    /** Lifecycle status → its label, so a card speaks the tab's language. */
    readonly status: Readonly<Record<string, string>>
  }
  /** Extra drawing units to keep beyond the viewport, so a pan is never blank. */
  readonly overscan?: number
}

/** A surface that can draw a scene. Canvas today; an SVG implementation is a swap. */
export interface CardgraphPainter {
  /** Size the paint box, in CSS pixels, and the device pixel ratio to paint at. */
  resize(width: number, height: number, dpr: number): void
  /** Draw the whole drawing, at full strength and with nothing focused. */
  paint(scene: PaintScene): void
  /**
   * Draw one report's path over a scrim of everything else — the interaction
   * layer.
   *
   * This is why the drawing is split across two surfaces: a hover changes the
   * scrim and a handful of wires, never the hundreds of shapes underneath, so the
   * cost of a hover is the same on a 10-report drawing and a 3000-report one.
   * Passing no focus wipes the layer.
   * @param scene - the same scene the base layer was drawn from.
   */
  paintPath(scene: PaintScene): void
  /** Forget the text-measurement cache, e.g. when the font tokens changed. */
  reset(): void
}

/** Corner radius of a card. */
const CARD_RADIUS = 5
/** Corner radius of a frame. */
const FRAME_RADIUS = 7
/** Inset from a card's edge to its text. */
const CARD_PADDING = 9
/** Width of the status stripe down a card's left edge. */
const STRIPE = 3
/** Arrowhead length and half-width. */
const ARROW_LENGTH = 7
const ARROW_HALF = 3.5
/**
 * How far the scrim pushes everything but the focused path back.
 *
 * **Measured, then corrected.** The first version reused the swimlane's dim value
 * (0.18 left showing) and a screenshot of the real tab showed why that was wrong
 * there and wrong here: at 0.18 the frames, their titles and every other card
 * become unreadable, so tracing one path costs the reader the context the drawing
 * exists to provide. The swimlane had already learned the same thing from the other
 * side — *the relations recede, the participants stay* — and a canvas scrim is
 * blunter than a per-shape dim, so it has to be gentler: 0.45 showing keeps every
 * frame and card legible while the focused path, drawn back on top at full
 * strength, still reads as the thing being pointed at.
 */
const SCRIM_ALPHA = 0.55
/** Subject lines a full card has room for. */
const SUBJECT_LINES = 2

/** The colour a status is drawn in, matching the tab's tones. */
function statusColour(status: string, theme: PaintTheme): string {
  if (status === 'open') return theme.warning
  if (status === 'acked') return theme.success
  return theme.tertiary
}

/**
 * How each kind of wire is drawn: the token its colour comes from, its dash
 * pattern, and its weight.
 *
 * Exported because the wires are canvas and the legend is DOM — the only way the
 * two cannot drift is for the legend to read this table instead of restating it in
 * CSS. The colour is a **token name**, not a value, so it resolves through the
 * theme like everything else.
 */
export const WIRE_TOKENS: Readonly<Record<CardgraphEdgeKind, {
  readonly colour: string
  readonly dash: readonly number[]
  readonly width: number
}>> = {
  to: { colour: '--dsw-alias-label-secondary', dash: [], width: 1.4 },
  cc: { colour: '--dsw-alias-label-caption', dash: [2, 3], width: 1 },
  author: { colour: '--dsw-alias-label-caption', dash: [1, 3], width: 1 },
  thread: { colour: '--dsw-alias-state-business-primary', dash: [], width: 1.4 },
}

/** Reverse lookup: which theme field a token fills. */
const FIELD_OF_TOKEN = new Map<string, keyof Omit<PaintTheme, 'fonts'>>(
  TOKENS.map(([field, token]) => [token, field]),
)

/** How one kind of wire is drawn, resolved against a theme. */
function wireStyle(kind: CardgraphEdgeKind, theme: PaintTheme): { stroke: string; dash: readonly number[]; width: number } {
  const spec = WIRE_TOKENS[kind]
  const field = FIELD_OF_TOKEN.get(spec.colour)
  return { stroke: field === undefined ? theme.secondary : theme[field], dash: spec.dash, width: spec.width }
}

/**
 * The polyline a wire is drawn as.
 *
 * A wire with a gutter bends through it in three segments — out, along, in — which
 * is what keeps a same-column wire from crossing the frame it lands on and a
 * thread from crossing the cards between its ends.
 * @param edge - the wire.
 * @returns between two and four points, first to last.
 */
export function wirePoints(edge: CardgraphEdge): readonly { readonly x: number; readonly y: number }[] {
  const from = { x: edge.from.x, y: edge.from.y }
  const to = { x: edge.to.x, y: edge.to.y }
  if (edge.viaX === undefined) return [from, to]
  return [from, { x: edge.viaX, y: from.y }, { x: edge.viaX, y: to.y }, to]
}

/** Trace a rounded rectangle into the current path. */
function pathRoundRect(ctx: PaintContext, rect: Rect, radius: number): void {
  const r = Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2))
  ctx.beginPath()
  ctx.moveTo(rect.x + r, rect.y)
  ctx.lineTo(rect.x + rect.width - r, rect.y)
  ctx.arcTo(rect.x + rect.width, rect.y, rect.x + rect.width, rect.y + r, r)
  ctx.lineTo(rect.x + rect.width, rect.y + rect.height - r)
  ctx.arcTo(rect.x + rect.width, rect.y + rect.height, rect.x + rect.width - r, rect.y + rect.height, r)
  ctx.lineTo(rect.x + r, rect.y + rect.height)
  ctx.arcTo(rect.x, rect.y + rect.height, rect.x, rect.y + rect.height - r, r)
  ctx.lineTo(rect.x, rect.y + r)
  ctx.arcTo(rect.x, rect.y, rect.x + r, rect.y, r)
  ctx.closePath()
}

/**
 * Build a painter that draws into a canvas.
 *
 * One transform carries pan and zoom; everything after that is drawn in the
 * layout's own coordinates. Coordinates are deliberately **not** snapped to
 * pixels: draw.io rounds after its transform because its canvas is 1:1 screen
 * space, while ours is scaled, so snapping would have to happen per point in
 * screen space. Antialiasing is the honest default until a measurement says the
 * blur costs readability.
 * @param canvas - the canvas to draw into.
 * @returns the painter.
 */
export function createCanvasPainter(canvas: HTMLCanvasElement): CardgraphPainter {
  const ctx = canvas.getContext('2d') as unknown as PaintContext | null
  if (ctx === null) throw new Error('card canvas: no 2d context')
  let width = 0
  let height = 0
  let dpr = 1
  /** Measured text widths, keyed by font and text: measuring is a layout call. */
  const widths = new Map<string, number>()

  const measure = (text: string): number => {
    const key = `${ctx.font}\u0000${text}`
    const hit = widths.get(key)
    if (hit !== undefined) return hit
    const value = ctx.measureText(text).width
    widths.set(key, value)
    return value
  }

  const line = (x1: number, y1: number, x2: number, y2: number, colour: string, dash: readonly number[], alpha: number): void => {
    ctx.globalAlpha = alpha
    ctx.strokeStyle = colour
    ctx.setLineDash(dash)
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
  }

  /** The frame's outline alone, for the interaction layer: the box is already drawn. */
  const drawFrameOutline = (frame: CardgraphFrame, scene: PaintScene): void => {
    ctx.globalAlpha = 1
    pathRoundRect(ctx, frame.bounds, FRAME_RADIUS)
    ctx.strokeStyle = scene.theme.accent
    ctx.lineWidth = 1.6
    ctx.stroke()
  }

  const drawFrame = (frame: CardgraphFrame, scene: PaintScene): void => {
    const { theme } = scene
    ctx.globalAlpha = 1
    pathRoundRect(ctx, frame.bounds, FRAME_RADIUS)
    ctx.fillStyle = theme.frame
    ctx.fill()
    ctx.strokeStyle = theme.frameBorder
    ctx.lineWidth = 1
    ctx.stroke()

    // Title bar: a band across the top, clipped to the frame so its square corners
    // do not cut across the rounded ones.
    const bar: Rect = { x: frame.bounds.x, y: frame.bounds.y, width: frame.bounds.width, height: 26 }
    ctx.save()
    pathRoundRect(ctx, frame.bounds, FRAME_RADIUS)
    ctx.clip()
    ctx.globalAlpha = 1
    ctx.fillStyle = theme.frameBar
    ctx.fillRect(bar.x, bar.y, bar.width, bar.height)
    ctx.restore()
    line(bar.x, bar.y + bar.height, bar.x + bar.width, bar.y + bar.height, theme.frameBorder, [], 1)

    ctx.font = fontString(theme.fonts.title)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = theme.secondary
    const label = frame.external ? scene.labels.external : frame.title ?? frame.shortId
    const dot = 10
    ctx.fillText(elide(label, frame.bounds.width - 24 - dot, measure), bar.x + 10, bar.y + bar.height / 2 + 0.5)

    // One dot for a resident session, an outline for one that is not: the same
    // distinction the list's StateDot makes.
    const cx = bar.x + bar.width - 13
    const cy = bar.y + bar.height / 2
    ctx.beginPath()
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2)
    if (frame.live) {
      ctx.fillStyle = theme.success
      ctx.fill()
    } else {
      ctx.strokeStyle = theme.tertiary
      ctx.lineWidth = 1
      ctx.stroke()
    }

    if (frame.cards === 0) {
      ctx.font = fontString(theme.fonts.body)
      ctx.fillStyle = theme.tertiary
      ctx.fillText(scene.labels.empty, frame.bounds.x + CARD_PADDING, bar.y + bar.height + 18)
    }
  }

  const drawWire = (edge: CardgraphEdge, scene: PaintScene, alpha: number): void => {
    const { theme } = scene
    const style = wireStyle(edge.kind, theme)
    const points = wirePoints(edge)
    ctx.globalAlpha = alpha
    ctx.strokeStyle = style.stroke
    ctx.lineWidth = style.width
    ctx.setLineDash(style.dash)
    ctx.beginPath()
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y)
      else ctx.lineTo(point.x, point.y)
    })
    ctx.stroke()

    // The head turns with the last segment, so a wire that arrives through a
    // gutter points into the frame rather than along the way it came.
    const last = points[points.length - 2]
    const end = points[points.length - 1]
    if (last === undefined || end === undefined) return
    const angle = Math.atan2(end.y - last.y, end.x - last.x)
    const back = { x: end.x - Math.cos(angle) * ARROW_LENGTH, y: end.y - Math.sin(angle) * ARROW_LENGTH }
    const side = { x: -Math.sin(angle) * ARROW_HALF, y: Math.cos(angle) * ARROW_HALF }
    ctx.setLineDash([])
    ctx.fillStyle = style.stroke
    ctx.beginPath()
    ctx.moveTo(end.x, end.y)
    ctx.lineTo(back.x + side.x, back.y + side.y)
    ctx.lineTo(back.x - side.x, back.y - side.y)
    ctx.closePath()
    ctx.fill()
  }

  const drawCard = (card: CardgraphCard, scene: PaintScene, accent: boolean): void => {
    const { theme } = scene
    const box = card.bounds
    ctx.globalAlpha = 1
    pathRoundRect(ctx, box, CARD_RADIUS)
    ctx.fillStyle = card.lod === 'chip' ? statusColour(card.status, theme) : theme.surface
    ctx.fill()
    if (card.lod === 'chip') return

    ctx.strokeStyle = accent ? theme.accent : theme.border
    ctx.lineWidth = accent ? 1.6 : 1
    ctx.stroke()

    // Status stripe, in the tone the tab's Tag uses for the same status.
    ctx.save()
    pathRoundRect(ctx, box, CARD_RADIUS)
    ctx.clip()
    ctx.fillStyle = statusColour(card.status, theme)
    ctx.fillRect(box.x, box.y, STRIPE, box.height)
    ctx.restore()

    const textLeft = box.x + CARD_PADDING + STRIPE
    const textWidth = box.width - CARD_PADDING * 2 - STRIPE
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'

    ctx.font = fontString(theme.fonts.id)
    ctx.fillStyle = accent ? theme.accent : theme.secondary
    if (card.lod === 'compact') {
      // One line: the id, then as much subject as is left of the card.
      const id = card.report
      const idWidth = measure(id)
      const rest = foldText(`· ${card.subject}`, textWidth - idWidth - 4, measure, 1)[0] ?? ''
      ctx.fillText(id, textLeft, box.y + box.height / 2 - theme.fonts.id.size / 2 - 1)
      ctx.font = fontString(theme.fonts.body)
      ctx.fillStyle = theme.caption
      ctx.fillText(rest, textLeft + idWidth + 4, box.y + box.height / 2 - theme.fonts.body.size / 2 - 1)
      return
    }

    ctx.fillText(card.report, textLeft, box.y + 8)
    ctx.font = fontString(theme.fonts.body)
    ctx.fillStyle = theme.text
    const lines = foldText(card.subject, textWidth, measure, SUBJECT_LINES)
    lines.forEach((text, index) => {
      ctx.fillText(text, textLeft, box.y + 28 + index * theme.fonts.body.lineHeight)
    })

    // Footer: the status, and the task chip when there is room for both.
    ctx.font = fontString(theme.fonts.meta)
    const baseline = box.y + box.height - theme.fonts.meta.lineHeight - 6
    ctx.fillStyle = statusColour(card.status, theme)
    const status = scene.labels.status[card.status] ?? card.status
    ctx.fillText(status, textLeft, baseline)
    if (card.task !== undefined) {
      const statusWidth = measure(status)
      const chipLeft = textLeft + statusWidth + 8
      const chipText = foldText(card.task, box.x + box.width - CARD_PADDING - chipLeft - 10, measure, 1)[0] ?? ''
      if (chipText !== '') {
        ctx.fillStyle = theme.frameBar
        const chipWidth = measure(chipText) + 10
        ctx.fillRect(chipLeft, baseline - 2, chipWidth, theme.fonts.meta.lineHeight + 2)
        ctx.fillStyle = theme.caption
        ctx.fillText(chipText, chipLeft + 5, baseline)
      }
    }
  }

  return {
    resize(w: number, h: number, ratio: number): void {
      width = Math.max(0, w)
      height = Math.max(0, h)
      dpr = Number.isFinite(ratio) && ratio > 0 ? ratio : 1
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
    },
    reset(): void {
      widths.clear()
    },
    paint(scene: PaintScene): void {
      const { layout, theme, viewport } = scene
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalAlpha = 1
      ctx.setLineDash([])
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = theme.canvas
      ctx.fillRect(0, 0, width, height)

      const world = worldViewport(viewport, scene.overscan ?? 0)
      const visible = (rect: Rect): boolean => intersects(rect, world)

      ctx.save()
      ctx.translate(viewport.offsetX, viewport.offsetY)
      ctx.scale(viewport.scale, viewport.scale)

      // Frames first, then wires, then cards. A wire therefore always reads on top
      // of the boxes it travels between, while a card's text is never crossed.
      for (const frame of layout.frames) {
        if (visible(frame.bounds)) drawFrame(frame, scene)
      }
      for (const edge of layout.edges) {
        if (visible(edge.bounds)) drawWire(edge, scene, 1)
      }
      for (const card of layout.cards) {
        if (!visible(card.bounds)) continue
        drawCard(card, scene, card.report === scene.focus?.selected)
      }
      ctx.globalAlpha = 1
      ctx.restore()
    },
    paintPath(scene: PaintScene): void {
      const { layout, theme, viewport } = scene
      const report = scene.focus?.report ?? scene.focus?.selected
      const frameIndex = scene.focus?.frame
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalAlpha = 1
      ctx.setLineDash([])
      ctx.clearRect(0, 0, width, height)
      if (report === undefined && frameIndex === undefined) return

      ctx.save()
      ctx.translate(viewport.offsetX, viewport.offsetY)
      ctx.scale(viewport.scale, viewport.scale)

      if (report === undefined) {
        const frame = layout.frames[frameIndex as number]
        if (frame !== undefined) drawFrameOutline(frame, scene)
        ctx.restore()
        return
      }

      // The scrim: one rectangle over the whole visible world. Everything else
      // recedes at once, and — unlike dimming shapes one by one — it costs the same
      // whether the drawing has ten reports or three thousand.
      const world = worldViewport(viewport, 0)
      ctx.globalAlpha = SCRIM_ALPHA
      ctx.fillStyle = theme.canvas
      ctx.fillRect(world.x, world.y, world.width, world.height)
      ctx.globalAlpha = 1

      const edges = layout.edges.filter((edge) => edge.report === report)
      const touched = new Set<number>()
      for (const edge of edges) {
        if (edge.from.kind === 'frame') touched.add(edge.from.index)
        if (edge.to.kind === 'frame') touched.add(edge.to.index)
      }
      // The frames the path touches are re-outlined rather than redrawn: their
      // boxes are already underneath, and only the endpoints need to stay legible.
      for (const frame of layout.frames) {
        if (touched.has(frame.index)) drawFrameOutline(frame, scene)
      }
      for (const edge of edges) {
        if (intersects(edge.bounds, world)) drawWire(edge, scene, 1)
      }
      for (const card of layout.cards) {
        if (card.report === report) drawCard(card, scene, true)
      }
      ctx.restore()
    },
  }
}
