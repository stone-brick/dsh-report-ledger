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
  /**
   * The pointer's colour: what a hovered card, frame and path are drawn in.
   *
   * Deliberately not {@link accent}: the accent follows the shell's brand ink,
   * which is near-black in the light theme and therefore reads as "selected"
   * rather than "the pointer is here". A hover is a transient, lightweight
   * question — "which one is this?" — so it gets the light blue the GUI already
   * uses for interactive emphasis, and the open report keeps the ink accent.
   */
  readonly hover: string
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
  hover: '#7aaaff',
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
  ['hover', '--dsw-alias-button-info-hover', FALLBACK_THEME.hover],
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

/** Whether the reader was handed a list of candidates rather than one element. */
const isElementList = (value: Element | readonly Element[]): value is readonly Element[] =>
  Array.isArray(value)

/**
 * Watch the theme through one token.
 *
 * `getComputedStyle(...).getPropertyValue` forces a style read, so doing twenty of
 * them per repaint would be paying for the theme on every hover. The canary is the
 * page background: if it did not move, nothing else did, and the cached theme is
 * returned.
 *
 * **The palette lives on `body`, so the candidates are a chain.** DSH declares
 * every `--dsw-alias-*` colour and every `--dsw-font-<tier>-*` part on `body` —
 * `:root` carries only the family and the radii — and custom properties inherit
 * downwards, so a reader pointed at `document.documentElement` reads the empty
 * string for all of them and the whole drawing collapses onto the fallback theme
 * (a white canvas in a dark shell). Handing over both elements, `body` first,
 * keeps the drawing on the palette the shell actually painted it with, and still
 * works if a host ever moves the tokens up to `:root`. The first candidate whose
 * canary is non-empty is the source; the probe runs per read, not once, because a
 * host may mount `body` after this reader exists.
 * @param root - one element, or the candidates in order of preference.
 * @param win - the window to read styles from.
 * @returns the reader.
 */
export function createThemeReader(root: Element | readonly Element[], win: Window): ThemeReader {
  const roots: readonly Element[] = isElementList(root) ? root : [root]
  const sources = new Map<Element, ReadToken>()
  const readerOf = (element: Element): ReadToken => {
    const known = sources.get(element)
    if (known !== undefined) return known
    const style = win.getComputedStyle(element)
    const read: ReadToken = (name) => style.getPropertyValue(name)
    sources.set(element, read)
    return read
  }
  let canary: string | undefined
  let cached: PaintTheme | undefined
  return {
    read(): PaintTheme {
      let current = ''
      let source: ReadToken | undefined
      for (const element of roots) {
        const read = readerOf(element)
        const value = read(CANARY)
        if (value === '') continue
        current = value
        source = read
        break
      }
      if (cached !== undefined && current === canary) return cached
      canary = current
      // A host that declares no palette at all keeps the guaranteed-visible theme;
      // every field of it is a usable value, so nothing can blank the drawing.
      cached = readTheme(source ?? (() => ''))
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
  /**
   * How far a hovered path has revealed itself, 0 to 1.
   *
   * The view runs this from 0 to 1 when the pointer lands on a card: the scrim
   * fades in and each wire draws outward from its source, with a small traveller
   * dot at the drawing end. That is what makes "these wires belong to this card"
   * read as one gesture instead of a jump cut. Omitted means 1 — a settled hover,
   * which is what every static assertion and every fog-of-war path draws.
   */
  readonly hoverPhase?: number
  /**
   * Where a travelling light sits on the hovered path, 0 to 1, repeating.
   *
   * The reveal is the entrance; this is the **ongoing** animation. While the
   * pointer stays on a card, a short bright comet runs from the card out along
   * each of its wires and loops, so the relation stays visibly live instead of
   * being a one-shot flash. Omitted means "settled": no comet, which is what the
   * static assertions and the reduced-motion path draw.
   */
  readonly hoverFlow?: number
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
const ARROW_LENGTH = 9
const ARROW_HALF = 4.5
/** Distance the arrow tip stops short of the target edge, so it never sits on the border. */
const ARROW_GAP = 4
/** Radius of the fillet drawn at a wire's bends. */
const CORNER_RADIUS = 4
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
 * two cannot drift is for the legend to read this table instead of restating it
 * in CSS. The four kinds keep **different hues and different dashes**: a delivery
 * is the business blue, a copy the quiet caption grey dashed, a co-author the
 * success green dotted, and a thread the primary ink — the spine of the drawing,
 * read as structure rather than as an action. Hue is the second cue, never the
 * only one: the dash pattern alone still separates all four in grayscale.
 *
 * The colour is a **token name**, not a value, so it resolves through the
 * theme like everything else.
 */
export const WIRE_TOKENS: Readonly<Record<CardgraphEdgeKind, {
  readonly colour: string
  readonly dash: readonly number[]
  readonly width: number
}>> = {
  to: { colour: '--dsw-alias-state-business-primary', dash: [], width: 1.8 },
  cc: { colour: '--dsw-alias-label-caption', dash: [4, 2], width: 1.3 },
  author: { colour: '--dsw-alias-state-success-primary', dash: [2, 2], width: 1.3 },
  thread: { colour: '--dsw-alias-label-primary', dash: [], width: 1.5 },
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
  // Every wire the layout produces carries its routed polyline; the straight pair
  // is the fallback for a synthetic edge that has not been routed.
  if (edge.points !== undefined) return edge.points
  return [{ x: edge.from.x, y: edge.from.y }, { x: edge.to.x, y: edge.to.y }]
}

/** Shortest wire that earns a midpoint marker, in drawing units. */
const MARKER_MIN_LENGTH = 36
/** Radii of the marker: the canvas-coloured halo, then the coloured dot. */
const MARKER_HALO = 3.4
const MARKER_DOT = 2.1
/** How many travelling dots ride one hovered wire at once. */
const HOVER_DOT_SPACING = 90
/** The traveller's speed along the wire, in drawing units per millisecond. */
const HOVER_FLOW_SPEED = 0.0675

/** Length of a polyline. */
function wireLength(points: readonly { readonly x: number; readonly y: number }[]): number {
  let total = 0
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]
    const b = points[index]
    if (a === undefined || b === undefined) continue
    total += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return total
}

/**
 * The part of a polyline up to `distance` from its start.
 *
 * Used for the hover reveal: the wire draws outward from the hovered card, so the
 * direction reads before the line has arrived. The returned list ends on the cut,
 * which is where the traveller dot sits.
 * @param points - the wire's points.
 * @param distance - how far along the polyline to draw.
 * @returns the partial points (never empty), and the cut point.
 */
function cutPolyline(
  points: readonly { readonly x: number; readonly y: number }[],
  distance: number,
): { points: { x: number; y: number }[]; cut?: { x: number; y: number } } {
  const out: { x: number; y: number }[] = []
  let remaining = Math.max(0, distance)
  for (let index = 0; index < points.length; index++) {
    const point = points[index]
    if (point === undefined) continue
    out.push({ x: point.x, y: point.y })
    if (index === 0) continue
    const previous = points[index - 1]
    if (previous === undefined) continue
    const length = Math.hypot(point.x - previous.x, point.y - previous.y)
    if (remaining <= length) {
      if (length === 0) continue
      const t = remaining / length
      const cut = { x: previous.x + (point.x - previous.x) * t, y: previous.y + (point.y - previous.y) * t }
      out[out.length - 1] = cut
      return { points: out, cut }
    }
    remaining -= length
  }
  const last = out[out.length - 1]
  return { points: out, cut: last === undefined ? undefined : { x: last.x, y: last.y } }
}

/**
 * The point half way along a wire, measured along the polyline.
 *
 * A wire that runs down a gutter is measured along its bends too, so the marker
 * lands on the long vertical segment rather than in the corner. Short wires get
 * none: at two or three card widths a dot would out-weigh the line it marks.
 * @param points - the wire's points.
 * @returns the midpoint, or `undefined` when the wire is too short to need one.
 */
function wireMidpoint(points: readonly { readonly x: number; readonly y: number }[]): { x: number; y: number } | undefined {
  const total = wireLength(points)
  if (total < MARKER_MIN_LENGTH) return undefined
  let remaining = total / 2
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]
    const b = points[index]
    if (a === undefined || b === undefined) continue
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length === 0) continue
    if (remaining <= length) {
      const t = remaining / length
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
    remaining -= length
  }
  return undefined
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
    ctx.strokeStyle = scene.theme.hover
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
    // do not cut across the rounded ones. Its height is the layout's, not a number
    // of the painter's own: cards start below it and ports stay out of it.
    const bar: Rect = {
      x: frame.bounds.x,
      y: frame.bounds.y,
      width: frame.bounds.width,
      height: scene.layout.frameHeaderHeight,
    }
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

  /**
   * The travelling dot on a hovered wire.
   *
   * Just the dot, in the pointer colour: a tail would draw a second bent line on
   * top of the wire — the same route, twice, and the eye reads the tail as "a short
   * line moving" rather than "a signal travelling". One dot reads as a signal.
   * `flow` is where it sits along the wire — 0 at the source, 1 at the target — so
   * one loop reads as "this report flows to its recipients", and the next loop
   * starts from the card again.
   * @param edge - the focused wire.
   * @param scene - the resolved palette.
   * @param flow - 0..1 along the wire.
   */
  const drawTraveller = (edge: CardgraphEdge, scene: PaintScene, flow: number): void => {
    const { theme } = scene
    const points = wirePoints(edge)
    const total = wireLength(points)
    if (total < 12) return
    // Density is per unit of wire, not per wire: a long route gets more dots than a
    // short one, so the stream looks equally dense wherever the eye lands. The
    // **speed** is per unit of time, not per wire: the head advances
    // HOVER_FLOW_SPEED units per millisecond regardless of how long the route is,
    // so a long wire takes longer to cross instead of moving faster.
    const count = Math.min(8, Math.max(1, Math.round(total / HOVER_DOT_SPACING)))
    const spacing = total / count
    const travelled = Math.max(0, flow) * HOVER_FLOW_SPEED
    for (let index = 0; index < count; index++) {
      const distance = (travelled + index * spacing) % total
      const at = cutPolyline(points, distance).cut
      if (at === undefined) continue
      ctx.globalAlpha = 1
      ctx.setLineDash([])
      ctx.fillStyle = theme.canvas
      ctx.beginPath()
      ctx.arc(at.x, at.y, MARKER_HALO + 0.6, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = theme.hover
      ctx.beginPath()
      ctx.arc(at.x, at.y, MARKER_DOT + 0.4, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  /**
   * Draw one wire.
   * @param edge - the wire.
   * @param scene - theme and layout.
   * @param alpha - overall opacity.
   * @param colour - overrides the wire's own colour (the interaction layer draws
   *   the focused path in the pointer colour while keeping each kind's dash and
   *   weight, so the four kinds stay readable without four hues under a scrim).
   */
  const drawWire = (edge: CardgraphEdge, scene: PaintScene, alpha: number, colour?: string, phase = 1): void => {
    const { theme } = scene
    const style = wireStyle(edge.kind, theme)
    const stroke = colour ?? style.stroke
    const points = wirePoints(edge)
    // The head stops `ARROW_GAP` short of the target, so the triangle reads as an
    // arrow beside the box instead of a blob sitting on its border.
    const last = points[points.length - 2]
    const end = points[points.length - 1]
    const angle = last === undefined || end === undefined ? 0 : Math.atan2(end.y - last.y, end.x - last.x)
    const tip = end === undefined ? undefined : { x: end.x - Math.cos(angle) * ARROW_GAP, y: end.y - Math.sin(angle) * ARROW_GAP }
    const stroked = tip === undefined || points.length === 0 ? points : [...points.slice(0, -1), tip]
    // A hover in progress reveals the wire from its source; a settled hover (phase 1)
    // is the whole wire, arrowhead and midpoint marker included.
    const reveal = Math.min(1, Math.max(0, phase))
    const shown = reveal >= 1 ? { points: stroked, cut: undefined } : cutPolyline(stroked, wireLength(stroked) * reveal)
    ctx.globalAlpha = alpha
    ctx.strokeStyle = stroke
    ctx.lineWidth = style.width
    ctx.setLineDash(style.dash)
    ctx.beginPath()
    // Rounded bends. A routed wire crosses several times (gutter, road, gutter),
    // and right angles at every one of them read as a wireframe; a 4px fillet is
    // enough to say "this is one wire" without changing where it goes. The radius
    // is clamped to half of each adjacent segment so a short stub stays straight.
    const corner = CORNER_RADIUS
    shown.points.forEach((point, index) => {
      if (index === 0) { ctx.moveTo(point.x, point.y); return }
      const previous = shown.points[index - 1]
      const next = shown.points[index + 1]
      if (previous === undefined || next === undefined) { ctx.lineTo(point.x, point.y); return }
      const inLength = Math.hypot(point.x - previous.x, point.y - previous.y)
      const outLength = Math.hypot(next.x - point.x, next.y - point.y)
      const radius = Math.min(corner, inLength / 2, outLength / 2)
      if (radius < 0.5) { ctx.lineTo(point.x, point.y); return }
      const before = {
        x: point.x - ((point.x - previous.x) / (inLength === 0 ? 1 : inLength)) * radius,
        y: point.y - ((point.y - previous.y) / (inLength === 0 ? 1 : inLength)) * radius,
      }
      ctx.lineTo(before.x, before.y)
      ctx.arcTo(point.x, point.y, next.x, next.y, radius)
    })
    ctx.stroke()

    // Before the reveal is complete, a traveller dot stands at the cut: it is the
    // "signal" running out along the wire, and it is what makes the hover read as a
    // direction rather than as a line appearing.
    if (reveal < 1) {
      const at = shown.cut
      if (at !== undefined) {
        ctx.setLineDash([])
        ctx.fillStyle = theme.canvas
        ctx.beginPath()
        ctx.arc(at.x, at.y, MARKER_HALO, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = stroke
        ctx.beginPath()
        ctx.arc(at.x, at.y, MARKER_DOT, 0, Math.PI * 2)
        ctx.fill()
      }
      return
    }

    // The head turns with the last segment, so a wire that arrives through a
    // gutter points into the frame rather than along the way it came.
    if (tip === undefined) return
    const back = { x: tip.x - Math.cos(angle) * ARROW_LENGTH, y: tip.y - Math.sin(angle) * ARROW_LENGTH }
    const side = { x: -Math.sin(angle) * ARROW_HALF, y: Math.cos(angle) * ARROW_HALF }
    ctx.setLineDash([])
    ctx.fillStyle = stroke
    ctx.beginPath()
    ctx.moveTo(tip.x, tip.y)
    ctx.lineTo(back.x + side.x, back.y + side.y)
    ctx.lineTo(back.x - side.x, back.y - side.y)
    ctx.closePath()
    ctx.fill()

    // Midpoint marker: a dot in the wire's colour on a canvas-coloured halo. The
    // halo lifts it off whatever it crosses, so a long line still reads as one
    // line and shows its kind where the eye lands — not only at its ends.
    const midpoint = wireMidpoint(points)
    if (midpoint !== undefined) {
      ctx.globalAlpha = alpha
      ctx.fillStyle = theme.canvas
      ctx.beginPath()
      ctx.arc(midpoint.x, midpoint.y, MARKER_HALO, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = stroke
      ctx.beginPath()
      ctx.arc(midpoint.x, midpoint.y, MARKER_DOT, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  /**
   * Draw the card's status mark and report how much width it took.
   *
   * A **shape per state** — filled dot = open, check = acknowledged, block =
   * closed — so "what state is this" does not depend on telling amber from green
   * from grey. The mark carries the state colour as well, but as a second cue.
   * @param theme - the resolved palette.
   * @param status - the card's status state.
   * @param x - left edge to draw at.
   * @param textTop - top of the footer's text band (the card draws text with a top baseline).
   * @returns the width the mark occupies, gap included.
   */
  const drawStatusMark = (theme: PaintTheme, status: string, x: number, textTop: number): number => {
    const size = 7
    const top = textTop + Math.max(0, (theme.fonts.meta.lineHeight - size) / 2)
    ctx.globalAlpha = 1
    ctx.setLineDash([])
    if (status === 'acked') {
      ctx.beginPath()
      ctx.strokeStyle = theme.success
      ctx.lineWidth = 1.4
      ctx.moveTo(x, top + size * 0.45)
      ctx.lineTo(x + size * 0.38, top + size * 0.9)
      ctx.lineTo(x + size, top + size * 0.05)
      ctx.stroke()
    } else if (status === 'open') {
      ctx.beginPath()
      ctx.fillStyle = theme.warning
      ctx.arc(x + size / 2, top + size / 2, size / 2, 0, Math.PI * 2)
      ctx.fill()
    } else {
      ctx.beginPath()
      ctx.fillStyle = theme.tertiary
      ctx.fillRect(x, top, size, size)
    }
    return size + 5
  }

  /**
   * Draw one card.
   * @param card - the card.
   * @param scene - theme and labels.
   * @param highlight - why this card is loud: `selected` is the open report (the
   *   ink accent, and its id in that ink); `hover` is the pointer (the light blue
   *   ring, with the id at full text weight rather than blue — a blue id on a
   *   white card is the one thing a hover must not do); `none` is ordinary.
   */
  const drawCard = (card: CardgraphCard, scene: PaintScene, highlight: 'none' | 'selected' | 'hover'): void => {
    const { theme } = scene
    const box = card.bounds
    ctx.globalAlpha = 1
    pathRoundRect(ctx, box, CARD_RADIUS)
    ctx.fillStyle = card.lod === 'chip' ? statusColour(card.status, theme) : theme.surface
    ctx.fill()
    if (card.lod === 'chip') return

    const ring = highlight === 'selected' ? theme.accent : highlight === 'hover' ? theme.hover : theme.border
    ctx.strokeStyle = ring
    ctx.lineWidth = highlight === 'none' ? 1 : 1.6
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
    ctx.fillStyle = highlight === 'selected' ? theme.accent : highlight === 'hover' ? theme.text : theme.secondary
    if (card.lod === 'compact') {
      // One line: the id, then as much subject as is left of the card. Each half is
      // measured in the font it is drawn in — folding the subject against the
      // heavier id font shortened it for no reason, and would overflow the card in
      // a theme whose body font is the larger of the two.
      const id = card.report
      const idWidth = measure(id)
      ctx.fillText(id, textLeft, box.y + box.height / 2 - theme.fonts.id.size / 2 - 1)
      ctx.font = fontString(theme.fonts.body)
      ctx.fillStyle = theme.caption
      const rest = foldText(`· ${card.subject}`, textWidth - idWidth - 4, measure, 1)[0] ?? ''
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

    // Footer: the status mark, the status, and the task chip when there is room
    // for both. The mark is a SHAPE on purpose — a filled dot for open, a check
    // for acknowledged, a block for closed — so the state survives being read
    // without its colour (a screenshot in grayscale, a colour-blind reader).
    ctx.font = fontString(theme.fonts.meta)
    const baseline = box.y + box.height - theme.fonts.meta.lineHeight - 6
    const markWidth = drawStatusMark(theme, card.status, textLeft, baseline)
    ctx.font = fontString(theme.fonts.meta)
    ctx.fillStyle = statusColour(card.status, theme)
    const status = scene.labels.status[card.status] ?? card.status
    ctx.fillText(status, textLeft + markWidth, baseline)
    if (card.task !== undefined) {
      const statusWidth = measure(status)
      const chipLeft = textLeft + markWidth + statusWidth + 8
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
        drawCard(card, scene, card.report === scene.focus?.selected ? 'selected' : 'none')
      }
      ctx.globalAlpha = 1
      ctx.restore()
    },
    paintPath(scene: PaintScene): void {
      const { layout, theme, viewport } = scene
      // **Hover only.** The open report is the base layer's accent (its ring and
      // its id ink); letting it fall back into the scrim here would dim the whole
      // drawing for as long as a report stays open — and since a card click now
      // opens the report in the list, that would be permanently.
      const report = scene.focus?.report
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
      // whether the drawing has ten reports or three thousand. It fades in with the
      // reveal, so a hover is one gesture rather than a dim and a redraw.
      const world = worldViewport(viewport, 0)
      const reveal = Math.min(1, Math.max(0, scene.hoverPhase ?? 1))
      ctx.globalAlpha = SCRIM_ALPHA * reveal
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
        if (intersects(edge.bounds, world)) drawWire(edge, scene, 1, theme.hover, reveal)
      }
      // The ongoing part: once the path is fully revealed, a comet keeps running
      // out along each wire for as long as the pointer stays on the card. It is a
      // separate pass so the reveal can finish first and the loop can restart
      // without replaying the scrim fade.
      const flow = scene.hoverFlow
      if (flow !== undefined && reveal >= 1) {
        for (const edge of edges) {
          if (intersects(edge.bounds, world)) drawTraveller(edge, scene, flow)
        }
      }
      for (const card of layout.cards) {
        if (card.report === report) drawCard(card, scene, 'hover')
      }
      ctx.restore()
    },
  }
}
