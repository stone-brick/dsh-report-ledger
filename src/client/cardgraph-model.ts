/**
 * The card canvas's layout: sessions as **frames**, reports as **cards**, and the
 * transfer path as **wires** between them.
 *
 * This replaced the swimlane's own model, retired together with its view. The
 * swimlane proved that the shape of a collaboration can be drawn, but its nodes
 * are chips: a report is an `R-0001` and nothing more. Here a report is a
 * rectangle with room for its subject, so the drawing carries content instead of
 * only structure — and a session becomes a **frame that contains** its reports,
 * so belonging is drawn by containment rather than inferred from a column.
 *
 * Three rules keep this module the same kind of thing as the swimlane's — pure,
 * DOM-free, byte-deterministic for one input, and pinned by assertions:
 *
 *  1. **Column = depth, vertical order = the ledger's own order.** The payload's
 *     session list is already a DFS pre-order, so a frame's column is its depth
 *     and its y comes from that order. No graph algorithm is involved, for the
 *     same reason as before: there are no ranks to compute.
 *  2. **Card size is a level-of-detail constant, never a text measurement.** Text
 *     is wrapped and elided by the painter, against whatever room the card has.
 *     Measuring here would make the layout depend on a canvas context, and the
 *     only claim this design has to defend — "how many objects are on screen at
 *     this zoom" — would stop being testable. The caller picks the tier from the
 *     zoom (`lodFor`) and passes it in; geometry therefore changes per tier and
 *     not per zoom pixel, which is also what keeps it from jittering mid-gesture.
 *  3. **Every endpoint is known before anything is drawn.** Ends are either a
 *     card edge or a **port** on a frame edge, and ports are spread by an
 *     order-preserving rule (below) so two wires never land on the same pixel.
 *
 * @module dsh-report-ledger/client/cardgraph-model
 */

import type { ReportFrontMatter, TimelinePayload } from '../shared/wire.ts'
import { shortId } from './timeline-model.ts'

/** How much of a card there is room to draw, as a function of zoom. */
export type CardgraphLod = 'card' | 'compact' | 'chip'

/** A card's rectangle at one level of detail. */
export interface CardSize {
  readonly width: number
  readonly height: number
}

/** An axis-aligned rectangle, the one shape culling and hit-testing work on. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Which way an end faces. */
export type CardgraphSide = 'left' | 'right' | 'top' | 'bottom'

/** Geometry knobs. Numbers, not styles: the painter decides how to paint them. */
export interface CardgraphOptions {
  /** Level of detail to lay out at. Pick it with {@link lodFor}. */
  readonly lod: CardgraphLod
  /**
   * Edge kinds the reader has muted.
   *
   * A view filter, not a layout one: the cards and frames are unchanged, only
   * those wires (and the ports they would have taken) disappear — which is what
   * lets the legend toggle without moving anything or re-fitting the view.
   */
  readonly hiddenKinds?: readonly CardgraphEdgeKind[]
  /** Zoom at or above which reports are drawn as full cards. */
  readonly cardMinZoom: number
  /** Zoom at or above which reports are drawn as compact cards. */
  readonly compactMinZoom: number
  /**
   * Card size per tier.
   *
   * A whole record rather than a partial one, so "which sizes are in play" is one
   * value that can be replaced wholesale by a test.
   */
  readonly sizes: Readonly<Record<CardgraphLod, CardSize>>
  /** Height of a frame's title bar. */
  readonly frameHeaderHeight: number
  /** Inset from a frame's side to its cards. */
  readonly framePaddingX: number
  /** Inset from the title bar down to the first card. */
  readonly framePaddingTop: number
  /** Inset below the last card. */
  readonly framePaddingBottom: number
  /** A frame is never narrower than this, even with no cards. */
  readonly minFrameWidth: number
  /** A frame is never shorter than this, so an empty session still reads as a box. */
  readonly minFrameHeight: number
  /** Vertical gap between two stacked cards. */
  readonly cardGap: number
  /** Horizontal gap between two columns. */
  readonly columnGap: number
  /** Vertical gap between two frames in one column. */
  readonly frameGap: number
  /** Margin around the whole drawing. */
  readonly margin: number
}

/**
 * Defaults.
 *
 * A full card is 240x110 — enough for a title, a status line and two lines of
 * subject at a readable size. The chip tier is deliberately tiny: below 0.4 zoom
 * a card is a colour, and drawing readable text there would be a lie about how
 * much of the drawing the reader can actually take in.
 */
export const DEFAULT_CARDGRAPH_OPTIONS: CardgraphOptions = {
  lod: 'card',
  cardMinZoom: 0.8,
  compactMinZoom: 0.4,
  sizes: {
    card: { width: 240, height: 110 },
    compact: { width: 160, height: 36 },
    chip: { width: 60, height: 14 },
  },
  frameHeaderHeight: 26,
  framePaddingX: 12,
  framePaddingTop: 10,
  framePaddingBottom: 12,
  minFrameWidth: 180,
  minFrameHeight: 96,
  cardGap: 8,
  columnGap: 48,
  frameGap: 24,
  margin: 24,
}

/** How far out the drawing may be zoomed, in screen pixels per drawing unit. */
export const MIN_ZOOM = 0.25
/** How far in the drawing may be zoomed. */
export const MAX_ZOOM = 2.5
/** One step of the zoom controls, in screen pixels per drawing unit. */
export const ZOOM_STEP = 1.25
/**
 * The most a fit may magnify.
 *
 * Filling the width on a drawing that holds one card would otherwise ask for
 * several times the design's size: one card stretched across the whole box,
 * larger than any reading needs and carrying no more in it, because a tier is
 * drawn at a fixed size and zooming past 100% only magnifies. One control step
 * is the ceiling, so the fit may lean in but never stretch.
 */
export const MAX_FIT_ZOOM = ZOOM_STEP

/** Inset from a card's corner to the band its own ports may occupy. */
const CARD_PORT_INSET = 10

/** One session's frame. */
export interface CardgraphFrame {
  /** Session id, absent for the shared frame of out-of-tree sessions. */
  readonly id?: string
  /** Position in {@link CardgraphLayout.frames}; also how wires name a frame. */
  readonly index: number
  /** Shortened session id for the title bar. */
  readonly shortId: string
  /** Resolved title, when the payload carried one. */
  readonly title?: string
  /** Depth in the subtree, which is also the column. */
  readonly depth: number
  /** Column this frame sits in. */
  readonly column: number
  /** Whether the session is currently resident. */
  readonly live: boolean
  /** Whether this is the shared frame for sessions outside the subtree. */
  readonly external: boolean
  /** How many cards it holds. */
  readonly cards: number
  readonly bounds: Rect
}

/** One column of the drawing: all frames of one subtree depth. */
export interface CardgraphColumn {
  /** The depth this column holds. */
  readonly depth: number
  readonly index: number
  readonly bounds: Rect
}

/** One report, as a rectangle. */
export interface CardgraphCard {
  readonly report: string
  readonly subject: string
  readonly status: ReportFrontMatter['status']
  readonly task?: string
  /** Index of the frame that contains it. */
  readonly frame: number
  /** Column it sits in, i.e. the depth of its author's session. */
  readonly column: number
  /** Stacking index inside its frame, counting from the top. */
  readonly slot: number
  /** The tier this card was laid out at, so the painter knows what fits. */
  readonly lod: CardgraphLod
  readonly bounds: Rect
}

/** What a wire means. */
export type CardgraphEdgeKind = 'to' | 'cc' | 'author' | 'thread'

/**
 * One end of a wire.
 *
 * Both kinds are **ports**: a card's edge and a frame's edge are each shared by
 * every wire that touches them, so the coordinate along the edge is assigned by
 * the spreading pass rather than by any single wire.
 */
export interface CardgraphEnd {
  readonly kind: 'card' | 'frame'
  /** Report id for a card end, session id for a frame end (absent = out of tree). */
  readonly id?: string
  /** Index into `cards` for a card end, into `frames` for a frame end. */
  readonly index: number
  readonly side: CardgraphSide
  readonly x: number
  readonly y: number
}

/** One drawn relation. */
export interface CardgraphEdge {
  /** The report the wire belongs to. */
  readonly report: string
  readonly kind: CardgraphEdgeKind
  /** Where the wire leaves; carries the arrowhead's opposite end. */
  readonly from: CardgraphEnd
  /** Where the wire lands; the arrowhead goes here. */
  readonly to: CardgraphEnd
  /** Whether either end is the out-of-tree frame. */
  readonly external: boolean
  /**
   * The x a thread runs down between columns.
   *
   * Only thread wires have one. A thread spans frames, and drawing it straight
   * would cross whatever sits in between; routing it down a **column gutter**
   * keeps it in the margin band, where only other wires are.
   */
  readonly viaX?: number
  /**
   * The orthogonal route, when the wire has one.
   *
   * Left/right wires are routed through the layout's own empty channels (column
   * gutters and the gaps between frames) instead of cutting across frames and
   * their titles. Top/bottom wires (threads) keep the single-gutter `viaX` shape.
   * The first and last points are the ports themselves.
   */
  readonly points?: readonly { readonly x: number; readonly y: number }[]
  /**
   * The wire's bounding box: both ends, plus the gutter a thread bends through.
   *
   * Culling works on this, which is why a wire whose ends are both off-screen but
   * whose middle crosses the viewport is still drawn.
   */
  readonly bounds: Rect
}

/** The whole drawing, as numbers. */
export interface CardgraphLayout {
  /** The tier this drawing was laid out at. */
  readonly lod: CardgraphLod
  readonly columns: readonly CardgraphColumn[]
  readonly frames: readonly CardgraphFrame[]
  /** In frame order, then top to bottom, so the order is fully determined. */
  readonly cards: readonly CardgraphCard[]
  readonly edges: readonly CardgraphEdge[]
  /** Every frame is this wide, so the columns line up. */
  readonly frameWidth: number
  /**
   * Height of a frame's title bar.
   *
   * Carried in the layout rather than re-declared by the painter: the bar is
   * geometry (cards start below it, ports stay out of it), so a painter that
   * hardcoded the number would put the title band and the cards in the same
   * place the moment the option moved.
   */
  readonly frameHeaderHeight: number
  readonly cardWidth: number
  readonly cardHeight: number
  readonly width: number
  readonly height: number
}

/**
 * Which tier a zoom level calls for.
 *
 * Thresholds are inclusive on the low end, so 0.8 is a full card and 0.4 is a
 * compact one: a zoom that lands exactly on a step reads as the richer of the
 * two. A zoom that is not a usable number degrades to the cheapest tier instead
 * of producing an infinite or negative box.
 * @param zoom - the current scale.
 * @param options - threshold overrides.
 * @returns the tier to lay out at.
 */
export function lodFor(zoom: number, options: Partial<CardgraphOptions> = {}): CardgraphLod {
  const opts: CardgraphOptions = { ...DEFAULT_CARDGRAPH_OPTIONS, ...options }
  if (!Number.isFinite(zoom)) return 'chip'
  if (zoom >= opts.cardMinZoom) return 'card'
  if (zoom >= opts.compactMinZoom) return 'compact'
  return 'chip'
}

/**
 * The three tiers in the order a zoom sweep visits them, richest first.
 *
 * Exported so a painter can pre-build its text caches per tier without hardcoding
 * the list in a second place.
 */
export const CARDGRAPH_LODS: readonly CardgraphLod[] = ['card', 'compact', 'chip']

/** @returns the card size of one tier. */
export function cardSize(lod: CardgraphLod, options: Partial<CardgraphOptions> = {}): CardSize {
  const opts: CardgraphOptions = { ...DEFAULT_CARDGRAPH_OPTIONS, ...options }
  return opts.sizes[lod]
}

/** Whether two rectangles overlap. Touching edges do not count as overlapping. */
export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** Whether a point is inside a rectangle. The top-left edges are inside, the bottom-right ones are not. */
export function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
}

/** Grow a rectangle by `by` on every side. */
export function grow(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 }
}

/**
 * Keep the items whose box meets the viewport.
 *
 * This is the card canvas's replacement for the swimlane's row window: with a
 * free 2D canvas there are no rows to count, so "what is on screen" is decided by
 * rectangle overlap. `bounds` is the only field it looks at, which is why cards,
 * frames and wires all expose one.
 * @param items - anything with a bounding box.
 * @param viewport - the visible rect, **in drawing coordinates**.
 * @returns the items to draw, in the order they were given.
 */
export function cullByBounds<T extends { readonly bounds: Rect }>(
  items: readonly T[],
  viewport: Rect,
): readonly T[] {
  return items.filter((item) => intersects(item.bounds, viewport))
}

/**
 * The topmost item under a point.
 *
 * Free of the DOM on purpose: the canvas has no elements to hit, so picking is a
 * function from a point and an ordered list to an item — and that function is
 * testable here rather than only by clicking in a browser. The caller passes the
 * list **topmost first**, which is what makes "a card wins over the frame holding
 * it" a property of the order rather than of the arithmetic.
 * @param items - candidates, topmost first.
 * @param x - point, in drawing coordinates.
 * @param y - point, in drawing coordinates.
 * @returns the first hit, or `undefined`.
 */
export function hitTest<T extends { readonly bounds: Rect }>(
  items: readonly T[],
  x: number,
  y: number,
): T | undefined {
  return items.find((item) => contains(item.bounds, x, y))
}

/** A pan/zoom transform plus the size of the box it paints into. */
export interface CardgraphViewport {
  /** Pan, in screen pixels. */
  readonly offsetX: number
  readonly offsetY: number
  /** Scale, screen pixels per drawing unit. */
  readonly scale: number
  /** Width of the paint box, in screen pixels. */
  readonly width: number
  /** Height of the paint box, in screen pixels. */
  readonly height: number
}

/**
 * The part of the drawing a viewport can see, in drawing coordinates.
 *
 * The inverse of the transform the painter applies, and the input to culling. A
 * broken transform is treated as identity rather than propagated: a scale of zero
 * or a NaN would otherwise turn the visible rect into an infinite or reversed box
 * and either cull everything or draw everything.
 * @param view - the transform and the size of the paint box.
 * @param overscan - drawing units to keep on each side, so a pan does not reveal a
 *   blank band before the next frame is painted.
 * @returns the visible rect.
 */
export function worldViewport(view: CardgraphViewport, overscan = 0): Rect {
  const scale = Number.isFinite(view.scale) && view.scale > 0 ? view.scale : 1
  const width = Number.isFinite(view.width) ? Math.max(0, view.width) : 0
  const height = Number.isFinite(view.height) ? Math.max(0, view.height) : 0
  const offsetX = Number.isFinite(view.offsetX) ? view.offsetX : 0
  const offsetY = Number.isFinite(view.offsetY) ? view.offsetY : 0
  const rect: Rect = {
    x: -offsetX / scale,
    y: -offsetY / scale,
    width: width / scale,
    height: height / scale,
  }
  return overscan === 0 ? rect : grow(rect, overscan)
}

/** A mutable end, while ports are still being spread. */
interface PendingEnd {
  kind: 'card' | 'frame'
  id?: string
  index: number
  side: CardgraphSide
  x: number
  y: number
}

/** A wire before its ports have y coordinates. */
interface PendingEdge {
  report: string
  kind: CardgraphEdgeKind
  from: PendingEnd
  to: PendingEnd
  external: boolean
  viaX?: number
  points?: { x: number; y: number }[]
}

/**
 * Build the card graph.
 *
 * Frames come from the payload's sessions: column by subtree depth, vertical
 * order by the payload's own order (the DFS pre-order the list indents by), so a
 * session keeps its relative position across the two views. Cards are stacked
 * inside their author's frame **by time**, because a frame is one session's own
 * timeline; the reader who wants one timeline across all sessions has the list
 * below. Only the reports handed in are drawn, so this is a filtered view rather
 * than a second source of truth.
 * @param payload - the endpoint payload, for the session frames.
 * @param reports - the reports to plot; any order, since each frame sorts its own.
 * @param options - geometry and tier overrides.
 * @returns the layout; empty (and zero-sized) when there is nothing to draw.
 */
export function buildCardgraph(
  payload: TimelinePayload,
  reports: readonly ReportFrontMatter[],
  options: Partial<CardgraphOptions> = {},
): CardgraphLayout {
  const opts: CardgraphOptions = { ...DEFAULT_CARDGRAPH_OPTIONS, ...options }
  const size = opts.sizes[opts.lod]
  const frameWidth = Math.max(opts.minFrameWidth, size.width + opts.framePaddingX * 2)
  /** Kinds the reader muted in the legend; they take no ports either. */
  const hidden = new Set(opts.hiddenKinds ?? [])

  // -------------------------------------------------------------------------
  // Frames
  // -------------------------------------------------------------------------
  const sessions = payload.sessions
  const depths = [...new Set(sessions.map((node) => node.depth))].sort((a, b) => a - b)
  const columnOfDepth = new Map<number, number>()
  for (const [index, depth] of depths.entries()) columnOfDepth.set(depth, index)

  const frameOf = new Map<string, number>()
  const frames: {
    id?: string
    shortId: string
    title?: string
    depth: number
    column: number
    live: boolean
    external: boolean
    cards: number
  }[] = sessions.map((node, index) => {
    frameOf.set(node.id, index)
    return {
      ...(node.title === undefined ? {} : { title: node.title }),
      id: node.id,
      shortId: shortId(node.id),
      depth: node.depth,
      column: columnOfDepth.get(node.depth) ?? 0,
      live: node.live,
      external: false,
      cards: 0,
    }
  })

  // One shared frame for every session this subtree does not contain, so a report
  // copied in from another line still has somewhere to land. Created on demand:
  // a payload whose reports never leave the tree gets no such frame.
  const mentions = (front: ReportFrontMatter): readonly (string | undefined)[] =>
    [front.from, ...front.to, ...front.cc, ...front.authors]
  const needsExternal = reports.some((front) => mentions(front).some((id) => id !== undefined && !frameOf.has(id)))
  const externalDepth = sessions.reduce((max, node) => Math.max(max, node.depth), -1) + 1
  if (needsExternal) {
    frames.push({
      shortId: '',
      depth: externalDepth,
      column: depths.length,
      live: false,
      external: true,
      cards: 0,
    })
  }
  const externalIndex = needsExternal ? frames.length - 1 : -1
  const frameIndexById = (id: string | undefined): number =>
    id !== undefined && frameOf.has(id) ? (frameOf.get(id) as number) : externalIndex

  // -------------------------------------------------------------------------
  // Cards, stacked by time inside their frame
  // -------------------------------------------------------------------------
  const buckets: ReportFrontMatter[][] = frames.map(() => [])
  for (const front of reports) {
    const target = frameIndexById(front.from)
    if (target >= 0) buckets[target]?.push(front)
  }
  // Time order, with the report id as the tie-break so two reports created in the
  // same millisecond do not swap places between builds.
  for (const bucket of buckets) {
    bucket.sort((a, b) => a.created - b.created || (a.report < b.report ? -1 : a.report > b.report ? 1 : 0))
  }

  // -------------------------------------------------------------------------
  // Frame geometry
  // -------------------------------------------------------------------------
  const columnX = (column: number): number => opts.margin + column * (frameWidth + opts.columnGap)
  const frameHeight = (count: number): number => Math.max(
    opts.minFrameHeight,
    opts.frameHeaderHeight + opts.framePaddingTop + opts.framePaddingBottom
      + count * size.height + Math.max(0, count - 1) * opts.cardGap,
  )

  // The counts have to land before the boxes do: a frame's height is a function of
  // how many cards it holds, and a height that disagreed with the stacking would
  // put a card outside its own frame.
  frames.forEach((frame, index) => { frame.cards = buckets[index]?.length ?? 0 })

  const cursor = new Map<number, number>()
  const fixed: Rect[] = frames.map((frame) => {
    const height = frameHeight(frame.cards)
    const y = cursor.get(frame.column) ?? opts.margin
    cursor.set(frame.column, y + height + opts.frameGap)
    return { x: columnX(frame.column), y, width: frameWidth, height }
  })

  const columnCount = depths.length + (needsExternal ? 1 : 0)
  const heights = Array.from({ length: columnCount }, (_unused, column) => {
    const stacked = fixed.filter((_box, index) => frames[index]?.column === column)
    return stacked.length === 0
      ? 0
      : stacked.reduce((sum, box) => sum + box.height, 0) + (stacked.length - 1) * opts.frameGap
  })

  const layoutFrames: CardgraphFrame[] = frames.map((frame, index) => ({
    ...(frame.id === undefined ? {} : { id: frame.id }),
    ...(frame.title === undefined ? {} : { title: frame.title }),
    index,
    shortId: frame.shortId,
    depth: frame.depth,
    column: frame.column,
    live: frame.live,
    external: frame.external,
    cards: frame.cards,
    bounds: fixed[index] as Rect,
  }))

  const columns: CardgraphColumn[] = Array.from({ length: columnCount }, (_unused, column) => ({
    depth: depths[column] ?? externalDepth,
    index: column,
    bounds: {
      x: columnX(column),
      y: opts.margin,
      width: frameWidth,
      height: Math.max(0, heights[column] ?? 0),
    },
  }))

  // -------------------------------------------------------------------------
  // Card geometry
  // -------------------------------------------------------------------------
  const cards: CardgraphCard[] = []
  const cardIndexOf = new Map<string, number>()
  layoutFrames.forEach((frame) => {
    const bucket = buckets[frame.index] ?? []
    bucket.forEach((front, slot) => {
      cardIndexOf.set(front.report, cards.length)
      cards.push({
        report: front.report,
        subject: front.subject,
        status: front.status,
        ...(front.task === undefined ? {} : { task: front.task }),
        frame: frame.index,
        column: frame.column,
        slot,
        lod: opts.lod,
        bounds: {
          x: frame.bounds.x + opts.framePaddingX,
          y: frame.bounds.y + opts.frameHeaderHeight + opts.framePaddingTop + slot * (size.height + opts.cardGap),
          width: size.width,
          height: size.height,
        },
      })
    })
  })

  // -------------------------------------------------------------------------
  // Wires
  // -------------------------------------------------------------------------
  const cardEnd = (index: number, side: CardgraphSide): PendingEnd => {
    const box = cards[index]?.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
    return {
      kind: 'card',
      id: cards[index]?.report,
      index,
      side,
      x: side === 'right' ? box.x + box.width : side === 'left' ? box.x : box.x + box.width / 2,
      y: side === 'bottom' ? box.y + box.height : side === 'top' ? box.y : box.y + box.height / 2,
    }
  }
  const frameEnd = (index: number, side: CardgraphSide): PendingEnd => {
    const box = fixed[index] ?? { x: 0, y: 0, width: 0, height: 0 }
    return {
      kind: 'frame',
      ...(frames[index]?.id === undefined ? {} : { id: frames[index]?.id }),
      index,
      side,
      x: side === 'right' ? box.x + box.width : box.x,
      y: box.y + box.height / 2,
    }
  }
  const externalBetween = (a: number, b: number): boolean =>
    (externalIndex >= 0 && (a === externalIndex || b === externalIndex)) || false

  const pending: PendingEdge[] = []

  /**
   * The side a wire should bend through to reach another frame without crossing
   * one.
   *
   * Two sessions in the **same column** — siblings, or any two frames at one
   * depth — cannot be reached left-to-right: a straight line from the sender's
   * card to the recipient's facing edge runs back across the recipient's own box,
   * which reads as "this wire belongs to that frame". Such a wire bends down the
   * gutter beside the column instead: out of the card, along the gutter, into the
   * frame's edge on that same side. The gutter is on the right except in the last
   * column, where that would run along the outside of the drawing.
   */
  const gutterSide = (column: number): CardgraphSide => (column < columns.length - 1 ? 'right' : 'left')
  const gutterX = (column: number, side: CardgraphSide): number => {
    const box = columns[column]?.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
    return side === 'right' ? box.x + box.width + opts.columnGap / 2 : box.x - opts.columnGap / 2
  }

  // Wires are walked in **card order**, not in the order the caller passed the
  // reports: the drawing is then a function of the set of reports rather than of
  // the order they arrived in, which is what makes "same ledger, same picture"
  // testable with a shuffled input.
  const frontByReport = new Map(reports.map((front) => [front.report, front]))
  for (const [cardIndex, card] of cards.entries()) {
    const front = frontByReport.get(card.report)
    if (front === undefined) continue
    const ownFrame = card.frame
    const ownColumn = card.column

    // Deliveries leave the card and land on the recipient's frame, on the side
    // facing the sender. The digest carries no per-hop times (those live in the
    // route sidecar), so the landing y is the port's business, not the wire's.
    for (const [kind, ids] of [['to', front.to], ['cc', front.cc]] as const) {
      if (hidden.has(kind)) continue
      for (const id of new Set(ids)) {
        const target = frameIndexById(id)
        // Nothing to draw for a report delivered to its own session, and nothing
        // to draw to a session this drawing does not have a frame for.
        if (target < 0 || target === ownFrame) continue
        const targetColumn = frames[target]?.column ?? 0
        const sameColumn = targetColumn === ownColumn
        const side = sameColumn
          ? gutterSide(ownColumn)
          : targetColumn > ownColumn ? 'right' : 'left'
        pending.push({
          report: front.report,
          kind,
          from: cardEnd(cardIndex, side),
          to: frameEnd(target, sameColumn ? side : side === 'right' ? 'left' : 'right'),
          external: externalBetween(ownFrame, target),
          ...(sameColumn ? { viaX: gutterX(ownColumn, side) } : {}),
        })
      }
    }

    // Co-authorship reads the other way round: the co-author's frame reaches the
    // card, and the card is the end with the arrowhead.
    for (const id of hidden.has('author') ? [] : new Set(front.authors)) {
      if (id === front.from) continue
      const source = frameIndexById(id)
      if (source < 0 || source === ownFrame) continue
      const sourceColumn = frames[source]?.column ?? 0
      const sameColumn = sourceColumn === ownColumn
      const side = sameColumn
        ? gutterSide(ownColumn)
        : sourceColumn < ownColumn ? 'right' : 'left'
      pending.push({
        report: front.report,
        kind: 'author',
        from: frameEnd(source, side),
        to: cardEnd(cardIndex, sameColumn ? side : side === 'right' ? 'left' : 'right'),
        external: externalBetween(source, ownFrame),
        ...(sameColumn ? { viaX: gutterX(ownColumn, side) } : {}),
      })
    }

    // Only when both ends are plotted: a parent that was filtered out or lives in
    // another tree is the detail panel's business, not the drawing's.
    const parentIndex = front.parent === undefined || front.parent === front.report
      ? undefined
      : cardIndexOf.get(front.parent)
    const parentCard = parentIndex === undefined ? undefined : cards[parentIndex]
    if (parentIndex !== undefined && parentCard !== undefined && !hidden.has('thread')) {
      const from = cardEnd(parentIndex, 'bottom')
      const to = cardEnd(cardIndex, 'top')
      const column = parentCard.column
      const target = card.column
      // Route down the gutter on the side the child is on; a thread inside one
      // column takes the same detour as a same-column delivery, for the same
      // reason.
      const side = target > column ? 'right' : target < column ? 'left' : gutterSide(column)
      pending.push({
        report: front.report,
        kind: 'thread',
        from,
        to,
        external: externalBetween(parentCard.frame, ownFrame),
        viaX: gutterX(column, side),
      })
    }
  }

  // -------------------------------------------------------------------------
  // Ports: spread every wire that shares an edge, in the order of the far end
  //
  // Frames and cards alike: a card's side is as shared as a frame's, and without
  // this pass every delivery leaving one card's right side started at the same
  // point — which is what made a busy drawing look like every arrow pointed at one
  // spot. Cards spread inside their own edge (inset so a port never sits on a
  // rounded corner); frames spread inside the card band, below the title bar.
  // -------------------------------------------------------------------------
  const groups = new Map<string, { end: PendingEnd; order: number; tie: string }[]>()
  for (const edge of pending) {
    for (const end of [edge.from, edge.to]) {
      const other = end === edge.from ? edge.to : edge.from
      const key = `${end.kind}|${end.index}|${end.side}`
      const list = groups.get(key) ?? []
      list.push({ end, order: end.kind === 'card' && (end.side === 'top' || end.side === 'bottom') ? other.x : other.y, tie: `${edge.report}|${edge.kind}` })
      groups.set(key, list)
    }
  }
  for (const list of groups.values()) {
    const first = list[0]
    if (first === undefined) continue
    list.sort((a, b) => a.order - b.order || (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0))
    const end = first.end
    const box = end.kind === 'frame'
      ? fixed[end.index] ?? { x: 0, y: 0, width: 0, height: 0 }
      : cards[end.index]?.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
    /** The band a port may occupy, along the side it is on. */
    const along: 'x' | 'y' = end.side === 'left' || end.side === 'right' ? 'y' : 'x'
    const inset = end.kind === 'frame' ? 0 : CARD_PORT_INSET
    const low = along === 'y'
      ? box.y + (end.kind === 'frame' ? opts.frameHeaderHeight + opts.framePaddingTop : inset)
      : box.x + inset
    const high = along === 'y'
      ? box.y + box.height - (end.kind === 'frame' ? opts.framePaddingBottom : inset)
      : box.x + box.width - inset
    const span = high - low
    list.forEach((entry, index) => {
      // Evenly spaced inside the band; a band too small for spacing falls back to
      // its middle line rather than stacking every wire on one another.
      const at = span > 0 ? low + ((index + 1) * span) / (list.length + 1) : low + (span / 2)
      if (along === 'y') entry.end.y = at
      else entry.end.x = at
    })
  }

  // -------------------------------------------------------------------------
  // Channels: route left/right wires through the drawing's own empty space
  //
  // The layout already reserves the room. A column gutter is empty by construction
  // (frames never overlap it), and so is the gap between two frames in one column.
  // So a wire exits toward its column's gutter, travels vertically there, crosses to
  // the target's gutter along a **road** — a y no frame occupies between the two
  // gutters — and enters the target from its own gutter. Nothing crosses a frame
  // body or a title bar except the two endpoint frames the wire must enter and
  // leave. Top/bottom ends (threads) keep the single-gutter `viaX` shape: their
  // geometry is vertical, and a road would only make them wander.
  // -------------------------------------------------------------------------
  const STUB = 6
  const CLEAR = 4
  const tallest = heights.reduce((max, height) => Math.max(max, height), 0)
  const obstacles = fixed.map((box) => grow(box, CLEAR))
  const roadCandidates = (() => {
    // Above everything and below everything are always free; between two frames in
    // a column lies a `frameGap`, and its middle is the natural place to cross.
    const ys = [opts.margin / 2, opts.margin + tallest + opts.margin / 2]
    for (const column of columns) {
      const boxes = fixed
        .filter((_, index) => frames[index]?.column === column.index)
        .sort((a, b) => a.y - b.y)
      for (let index = 1; index < boxes.length; index++) {
        const above = boxes[index - 1]
        const below = boxes[index]
        if (above !== undefined && below !== undefined) ys.push((above.y + above.height + below.y) / 2)
      }
    }
    return [...new Set(ys)]
  })()
  const freeRoad = (left: number, right: number, y: number): boolean => {
    const lo = Math.min(left, right)
    const hi = Math.max(left, right)
    return !obstacles.some((box) => box.y < y && y < box.y + box.height && box.x < hi && lo < box.x + box.width)
  }
  const gutterAt = (column: number, side: CardgraphSide): number => {
    const box = columns[column]?.bounds
    if (box === undefined) return 0
    return side === 'right' ? box.x + box.width + opts.columnGap / 2 : box.x - opts.columnGap / 2
  }
  const columnOf = (end: PendingEnd): number =>
    end.kind === 'card' ? (cards[end.index]?.column ?? 0) : (frames[end.index]?.column ?? 0)
  /** Drop repeated points and merge collinear ones, so a route has no stutter. */
  const tidy = (input: { x: number; y: number }[]): { x: number; y: number }[] => {
    const out: { x: number; y: number }[] = []
    for (const point of input) {
      const last = out[out.length - 1]
      if (last !== undefined && last.x === point.x && last.y === point.y) continue
      const before = out[out.length - 2]
      if (before !== undefined && last !== undefined
        && ((before.x === last.x && last.x === point.x) || (before.y === last.y && last.y === point.y))) {
        out[out.length - 1] = point
        continue
      }
      out.push(point)
    }
    return out
  }
  const route = (edge: PendingEdge): { x: number; y: number }[] | undefined => {
    const { from, to } = edge
    if (from.side === 'top' || from.side === 'bottom' || to.side === 'top' || to.side === 'bottom') return undefined
    const outward = (side: CardgraphSide): number => (side === 'right' ? 1 : -1)
    const start = { x: from.x + outward(from.side) * STUB, y: from.y }
    const end = { x: to.x + outward(to.side) * STUB, y: to.y }
    const fromGutter = gutterAt(columnOf(from), from.side)
    const toGutter = gutterAt(columnOf(to), to.side)
    if (Math.abs(fromGutter - toGutter) < 0.5) {
      return tidy([from, start, { x: fromGutter, y: start.y }, { x: fromGutter, y: end.y }, end, to])
    }
    const middle = (start.y + end.y) / 2
    const road = roadCandidates
      .filter((y) => freeRoad(fromGutter, toGutter, y))
      .sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle) || a - b)[0]
    if (road === undefined) return undefined
    return tidy([
      from, start,
      { x: fromGutter, y: start.y },
      { x: fromGutter, y: road },
      { x: toGutter, y: road },
      { x: toGutter, y: end.y },
      end, to,
    ])
  }
  for (const edge of pending) {
    const points = route(edge)
    if (points !== undefined) edge.points = points
  }

  const edges: CardgraphEdge[] = pending.map((edge) => {
    const points = edge.points
    const xs = points === undefined
      ? [edge.from.x, edge.to.x, ...(edge.viaX === undefined ? [] : [edge.viaX])]
      : points.map((point) => point.x)
    const ys = points === undefined
      ? [edge.from.y, edge.to.y]
      : points.map((point) => point.y)
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    return {
      report: edge.report,
      kind: edge.kind,
      from: { ...edge.from },
      to: { ...edge.to },
      external: edge.external,
      ...(edge.viaX === undefined ? {} : { viaX: edge.viaX }),
      ...(points === undefined ? {} : { points }),
      bounds: {
        x: minX,
        y: minY,
        width: Math.max(...xs) - minX,
        height: Math.max(...ys) - minY,
      },
    }
  })

  const contentWidth = columnCount === 0
    ? 0
    : opts.margin * 2 + columnCount * frameWidth + (columnCount - 1) * opts.columnGap
  const widest = heights.reduce((max, height) => Math.max(max, height), 0)

  return {
    lod: opts.lod,
    columns,
    frames: layoutFrames,
    cards,
    edges,
    frameWidth,
    frameHeaderHeight: opts.frameHeaderHeight,
    cardWidth: size.width,
    cardHeight: size.height,
    width: columnCount === 0 ? 0 : contentWidth,
    height: columnCount === 0 ? 0 : opts.margin * 2 + widest,
  }
}

/** Where a fit puts the drawing, and the tier it read to get there. */
export interface CardgraphFit {
  /**
   * The tier the fitted scale lands in.
   *
   * Returned rather than left for the caller to re-derive: the layout the view
   * draws must be the layout the scale was measured against, and the view only
   * knows the tier through `lodFor(zoom)`.
   */
  readonly lod: CardgraphLod
  /** Screen pixels per drawing unit. */
  readonly scale: number
  /** Pan, in screen pixels. */
  readonly offsetX: number
  readonly offsetY: number
}

/** How far a fitted drawing is kept from the box's left edge, in screen pixels. */
const FIT_LEFT_MIN = 8
/** Where a fitted drawing starts, in screen pixels from the box's top. */
const FIT_TOP = 12

/**
 * The transform that fills a box's width with the drawing, at the richest tier
 * that can afford it.
 *
 * Width is the target because time runs **down** here: a frame is a column, so
 * the horizontal axis is what has to fit on screen and the vertical axis is what
 * the reader pans along. Magnification stops at {@link MAX_FIT_ZOOM}, so a
 * drawing too narrow to fill the box is left at its own size instead of
 * stretched.
 *
 * The scale and the tier are mutually dependent — the tier is derived from the
 * zoom ({@link lodFor}) and the zoom is computed from a layout — so one pass over
 * the current layout can leave the view drawing one tier while its offset was
 * centred for another. Probing every tier makes the result a function of the box
 * alone: idempotent, and independent of whichever tier the reader arrived in.
 *
 * This lives beside the geometry rather than in the view because it *is*
 * geometry: pure, byte-deterministic for one input, and the only part of the
 * fitting that can be tested without a browser.
 * @param payload - the endpoint payload, for the session frames.
 * @param reports - the reports to plot.
 * @param boxWidth - the paint box's width in screen pixels.
 * @param options - geometry, tier and threshold overrides.
 * @returns the transform, or `undefined` when there is nothing to fit into or
 *   nothing to fit (an empty drawing, or a box with no width yet).
 */
export function fitTransform(
  payload: TimelinePayload,
  reports: readonly ReportFrontMatter[],
  boxWidth: number,
  options: Partial<CardgraphOptions> = {},
): CardgraphFit | undefined {
  const opts: CardgraphOptions = { ...DEFAULT_CARDGRAPH_OPTIONS, ...options }
  if (!Number.isFinite(boxWidth) || boxWidth <= 0) return undefined
  // The drawing already carries a margin on both sides, so the fit leaves one of
  // them as breathing room on the right instead of filling edge to edge.
  const available = Math.max(0, boxWidth - opts.margin)
  const bands: Readonly<Record<CardgraphLod, { readonly min: number; readonly max: number }>> = {
    card: { min: opts.cardMinZoom, max: MAX_FIT_ZOOM },
    compact: { min: opts.compactMinZoom, max: opts.cardMinZoom },
    chip: { min: MIN_ZOOM, max: opts.compactMinZoom },
  }
  const probes = CARDGRAPH_LODS
    .map((tier) => ({ tier, drawing: buildCardgraph(payload, reports, { ...options, lod: tier }) }))
    .filter((probe) => probe.drawing.width > 0)
  if (probes.length === 0) return undefined
  // The richest tier the box can pay for: the scale that fills the width at that
  // tier still reaches the tier's own floor, so the zoom the reader lands on is
  // the tier that was measured. Demanding an exact `lodFor(scale) === tier` match
  // instead leaves box widths where no tier can have both — a two-column drawing
  // between 396 and 523 px, say — and a fit that finds nothing writes nothing:
  // the drawing keeps whatever transform it already had, which is exactly the
  // state dependence the tier probing exists to remove.
  const affordable = probes.find((probe) => available / probe.drawing.width >= bands[probe.tier].min)
  // Nothing can pay for its own floor only when the box is narrower than the
  // cheapest tier's minimum zoom allows: show that tier at the floor rather than
  // leaving the reader with a control that does nothing.
  const chosen = affordable ?? probes[probes.length - 1]
  const band = bands[chosen.tier]
  let scale = Math.min(Math.max(available / chosen.drawing.width, band.min), band.max)
  // A band's top edge belongs to the richer tier (the thresholds are inclusive on
  // the low end), so a scale clamped exactly onto it would be laid out one tier up
  // from the one that was measured. Step it down by a millionth: invisible to the
  // reader, and enough for `lodFor` to agree.
  if (lodFor(scale, opts) !== chosen.tier) scale *= 1 - 1e-9
  return {
    lod: chosen.tier,
    scale,
    offsetX: Math.max(FIT_LEFT_MIN, (boxWidth - chosen.drawing.width * scale) / 2),
    offsetY: FIT_TOP,
  }
}

/** What one drill-in level hands to the layout: the whole tree, limited to a subtree. */
export interface CardgraphScope {
  /** The payload with the subtree's sessions; every other field is the caller's. */
  readonly payload: TimelinePayload
  /**
   * The reports this scope may plot, in the caller's order.
   *
   * Membership is deliberately **one hop wide**: a report whose author is inside
   * the subtree, or whose delivery or co-authorship touches it. The first half
   * keeps the subtree's own work; the second is what lets the boundary frame show
   * what came in from outside — a scope that admitted only authors would draw
   * every outgoing delivery and silently omit every incoming one.
   */
  readonly reports: readonly ReportFrontMatter[]
  /**
   * Session ids from the payload's root (**exclusive**) down to this scope's
   * session (**inclusive**), so an empty trail is the whole tree and scoping to
   * the payload's own root is the same drawing as no scope at all.
   */
  readonly trail: readonly string[]
}

/**
 * Limit the drawing's input to one session's subtree.
 *
 * Drilling in is a **change of scope**, not a zoom: the layout is rebuilt from the
 * subtree alone, so the frames outside it stop existing rather than being panned
 * out of sight, and their wires land on the shared outside frame instead of
 * crossing the drawing. That is the same move a subgraph editor makes when it
 * swaps the visible graph — the frames outside are not a frozen copy of what was
 * on screen.
 *
 * The subtree is found two ways on purpose: as a contiguous DFS pre-order slice
 * (the payload's own order, which is the order the list indents by) and by
 * walking `parentId` down from the root. The two agreeing is an invariant of the
 * payload; when they disagree the ancestry wins, because membership by ancestry
 * cannot be wrong the way a slice can, and a payload built another way still
 * drills correctly.
 *
 * Depth is carried over **unnormalized**: a column is a distinct depth value, so
 * a subtree whose shallowest session sits at depth 2 still lays out from column
 * zero, and `buildCardgraph` needs no second code path for scoped input.
 * @param payload - the endpoint payload.
 * @param reports - the reports the caller would plot unscoped.
 * @param root - the session id to scope to; absent, empty or unknown means the
 *   whole tree (a stale breadcrumb must degrade to "everything", never to an
 *   empty drawing).
 * @returns the scoped input, plus the trail a breadcrumb reads.
 */
export function scopeInput(
  payload: TimelinePayload,
  reports: readonly ReportFrontMatter[],
  root?: string,
): CardgraphScope {
  if (root === undefined || root === '' || root === payload.root) return { payload, reports, trail: [] }
  const sessions = payload.sessions
  const index = sessions.findIndex((session) => session.id === root)
  if (index < 0) return { payload, reports, trail: [] }
  const depth = sessions[index]?.depth ?? 0

  // Slice by the payload's own order...
  let end = sessions.length
  for (let cursor = index + 1; cursor < sessions.length; cursor++) {
    if ((sessions[cursor]?.depth ?? 0) <= depth) {
      end = cursor
      break
    }
  }
  const slice = sessions.slice(index, end)

  // ...and by ancestry, independently.
  const children = new Map<string, string[]>()
  const parentOf = new Map<string, string | undefined>()
  for (const session of sessions) {
    parentOf.set(session.id, session.parentId)
    if (session.parentId === undefined) continue
    const bucket = children.get(session.parentId) ?? []
    bucket.push(session.id)
    children.set(session.parentId, bucket)
  }
  const inScope = new Set<string>([root])
  const frontier = [root]
  while (frontier.length > 0) {
    const id = frontier.pop()
    if (id === undefined) break
    for (const child of children.get(id) ?? []) {
      if (inScope.has(child)) continue
      inScope.add(child)
      frontier.push(child)
    }
  }
  const sliced = new Set(slice.map((session) => session.id))
  const agrees = sliced.size === inScope.size && [...inScope].every((id) => sliced.has(id))
  // A payload whose order is not the pre-order this module assumes still drills:
  // ancestry is the definition, and the slice is the fast path.
  const kept = agrees ? slice : sessions.filter((session) => inScope.has(session.id))

  // The trail stops before the payload's own root: scoping to it *is* the whole
  // tree, so the breadcrumb starts one level above the root frame.
  const up: string[] = []
  let cursor: string | undefined = root
  while (cursor !== undefined && cursor !== payload.root) {
    up.push(cursor)
    cursor = parentOf.get(cursor)
  }
  const trail = up.reverse()

  const touches = (id: string | undefined): boolean => id !== undefined && inScope.has(id)
  const admitted = reports.filter((front) => touches(front.from)
    || front.to.some(touches) || front.cc.some(touches) || front.authors.some(touches))

  return { payload: { ...payload, sessions: kept }, reports: admitted, trail }
}
