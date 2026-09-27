/**
 * The card canvas's layout: sessions as **frames**, reports as **cards**, and the
 * transfer path as **wires** between them.
 *
 * This is the successor to `topology-model.ts`. The swimlane proved that the
 * shape of a collaboration can be drawn, but its nodes are chips: a report is an
 * `R-0001` and nothing more. Here a report is a rectangle with room for its
 * subject, so the drawing carries content instead of only structure — and a
 * session becomes a **frame that contains** its reports, so belonging is drawn by
 * containment rather than inferred from a column.
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
 * `card` ends are anchored to a card's edge, at the middle of that edge. `frame`
 * ends are **ports**: a frame edge is shared by every wire that touches it, so
 * the y is assigned by the spreading pass rather than by any single wire.
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
    for (const id of new Set(front.authors)) {
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
    if (parentIndex !== undefined && parentCard !== undefined) {
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
  // Ports: spread every wire that shares a frame edge, in the order of the far end
  // -------------------------------------------------------------------------
  const groups = new Map<string, { end: PendingEnd; order: number; tie: string }[]>()
  for (const edge of pending) {
    for (const end of [edge.from, edge.to]) {
      if (end.kind !== 'frame') continue
      const other = end === edge.from ? edge.to : edge.from
      const key = `${end.index}|${end.side}`
      const list = groups.get(key) ?? []
      list.push({ end, order: other.y, tie: `${edge.report}|${edge.kind}` })
      groups.set(key, list)
    }
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.order - b.order || (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0))
    const box = fixed[list[0]?.end.index ?? 0] ?? { x: 0, y: 0, width: 0, height: 0 }
    const top = box.y + opts.frameHeaderHeight + opts.framePaddingTop
    const bottom = box.y + box.height - opts.framePaddingBottom
    const span = bottom - top
    list.forEach((entry, index) => {
      // Evenly inside the card band, which keeps every port off both the title bar
      // and the frame's own edge. A frame too short for a band puts them on its
      // middle line rather than stacking them on one another.
      entry.end.y = span > 0 ? top + ((index + 1) * span) / (list.length + 1) : box.y + box.height / 2
    })
  }

  const edges: CardgraphEdge[] = pending.map((edge) => {
    const xs = [edge.from.x, edge.to.x, ...(edge.viaX === undefined ? [] : [edge.viaX])]
    const ys = [edge.from.y, edge.to.y]
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    return {
      report: edge.report,
      kind: edge.kind,
      from: { ...edge.from },
      to: { ...edge.to },
      external: edge.external,
      ...(edge.viaX === undefined ? {} : { viaX: edge.viaX }),
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
    cardWidth: size.width,
    cardHeight: size.height,
    width: columnCount === 0 ? 0 : contentWidth,
    height: columnCount === 0 ? 0 : opts.margin * 2 + widest,
  }
}
