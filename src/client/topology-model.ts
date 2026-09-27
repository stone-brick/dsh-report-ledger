/**
 * The topology's layout: a **vertical swimlane** — one column per session, time
 * running downward, and a report's transfer path drawn as edges between columns.
 *
 * Why vertical, and why not a graph library:
 *
 *  - The tab already scrolls vertically, and the list below reads top-to-bottom,
 *    so a downward time axis needs no mental rotation when switching between the
 *    two. Columns are the sessions; the vertical order is the ledger's own order.
 *  - The layout needs **no graph algorithm**. A session's column comes from the
 *    subtree walk (already DFS pre-order) and a report's row from the time axis
 *    (already sorted), so ranks and lanes are both given. The general engines —
 *    `elkjs` (EPL-2.0/GPL, 8 MB unpacked), `d3-dag` (MIT but drags an LP solver
 *    for crossing minimisation), `@xyflow/react` (1.2 MB + its own stylesheet) —
 *    would be solving a problem this data does not have, inside a bundle that
 *    ships self-contained.
 *
 * Determinism is the point: the same payload and the same filtered reports give
 * byte-identical geometry, so "which node sits where" is pinned by assertions in
 * `scripts/topology-check.ts` rather than eyeballed in a browser. The view only
 * draws what this module returns.
 *
 * @module dsh-report-ledger/client/topology-model
 */

import type { ReportFrontMatter, TimelinePayload } from '../shared/wire.ts'
import { shortId } from './timeline-model.ts'

/** Geometry knobs. Numbers, not styles: the view decides how to paint them. */
export interface TopologyOptions {
  /** Height of one report row. */
  readonly rowHeight: number
  /** Width of one session column. */
  readonly laneWidth: number
  /** Width of the left gutter that carries the timestamps. */
  readonly gutterWidth: number
  /** Height of the sticky lane-header strip. */
  readonly headerHeight: number
}

/**
 * Defaults.
 *
 * Sized so a plausible collaboration fits the pane without horizontal travel:
 * eight columns plus the gutter is 1044px, just inside the ~1110px a tab gets at
 * a typical window width. Wider trees scroll — the drawing never shrinks below
 * what a chip and a lane label need.
 */
export const DEFAULT_TOPOLOGY_OPTIONS: TopologyOptions = {
  rowHeight: 30,
  laneWidth: 120,
  gutterWidth: 84,
  headerHeight: 44,
}

/** One session column. */
export interface TopologyLane {
  /** Session id, or `undefined` for the shared lane of out-of-tree sessions. */
  readonly id: string | undefined
  /** Column position, left to right. */
  readonly index: number
  /** Horizontal centre of the column. */
  readonly x: number
  /** Shortened session id, for the column header. */
  readonly shortId: string
  /** Resolved title, when the payload carried one. */
  readonly title?: string
  /** Depth in the subtree, which the header indents by. */
  readonly depth: number
  /** Whether the session is currently resident. */
  readonly live: boolean
  /** Whether this is the shared lane for sessions outside the subtree. */
  readonly external: boolean
}

/** How an edge reads. */
export type TopologyEdgeKind = 'to' | 'cc' | 'author' | 'thread'

/** One drawn relation, with both endpoints already resolved to pixels. */
export interface TopologyEdge {
  /** The report the edge belongs to. */
  readonly report: string
  /** What the edge means. */
  readonly kind: TopologyEdgeKind
  /** The session column the edge starts in. */
  readonly fromLane: number
  /** The session column the edge lands in. */
  readonly toLane: number
  /** Start point. */
  readonly fromX: number
  readonly fromY: number
  /** End point, which is where the arrowhead goes. */
  readonly toX: number
  readonly toY: number
  /** Whether either endpoint is an out-of-tree session. */
  readonly external: boolean
}

/** One report node. */
export interface TopologyNode {
  /** Report id. */
  readonly report: string
  /** Column it sits on. */
  readonly laneId: string | undefined
  readonly laneIndex: number
  /** Row index, counting only the reports being shown. */
  readonly row: number
  /** Node centre. */
  readonly x: number
  readonly y: number
  /** Subtree depth of its authoring session, for the row's indent guide. */
  readonly depth: number
  /** Lifecycle state, so the view can colour the node. */
  readonly status: ReportFrontMatter['status']
  /** Task label, when the report carries one. */
  readonly task?: string
}

/** The whole drawing, as numbers. */
export interface TopologyLayout {
  readonly lanes: readonly TopologyLane[]
  /** Row count: one per visible report. */
  readonly rows: number
  readonly nodes: readonly TopologyNode[]
  readonly edges: readonly TopologyEdge[]
  /** Width of one column, so the view can size its own header cells. */
  readonly laneWidth: number
  /** Width of the left gutter, so the view can align its timestamp column. */
  readonly gutterWidth: number
  /** Bounding size of the drawing, headers included. */
  readonly width: number
  readonly height: number
  /**
   * Height the view should reserve for its own lane-header strip.
   *
   * Deliberately NOT part of the coordinates: the node geometry is body-local
   * (`y` counts from the first row) so the view can pin the header as a sticky
   * element above the scrolling body instead of drawing it into the same
   * coordinate space and losing it on scroll.
   */
  readonly headerHeight: number
}

/**
 * Build the swimlane layout.
 *
 * Lanes come from the payload's sessions in the order the host returned them,
 * which is the subtree walk's DFS pre-order — the same order the list indents
 * by, so a session keeps its relative position when the reader switches between
 * the two views.
 *
 * Only the reports handed in are drawn. The view passes the rows that survived
 * the filter, so the graph is a filtered view rather than a second source of
 * truth, and an empty filter simply plots nothing.
 * @param payload - the endpoint payload, for the session columns.
 * @param reports - the reports to plot, in the order they should be stacked.
 * @param options - geometry overrides.
 * @returns the layout; empty (and sized to just the headers) when nothing is plotted.
 */
export function buildTopology(
  payload: TimelinePayload,
  reports: readonly ReportFrontMatter[],
  options: Partial<TopologyOptions> = {},
): TopologyLayout {
  const opts: TopologyOptions = { ...DEFAULT_TOPOLOGY_OPTIONS, ...options }
  const known = new Map<string, number>()
  const lanes: TopologyLane[] = payload.sessions.map((node, index) => {
    known.set(node.id, index)
    return {
      id: node.id,
      index,
      x: opts.gutterWidth + opts.laneWidth * (index + 0.5),
      shortId: shortId(node.id),
      ...(node.title === undefined ? {} : { title: node.title }),
      depth: node.depth,
      live: node.live,
      external: false,
    }
  })

  // Every id a plotted report mentions, so one shared column can hold the
  // sessions this subtree does not contain. Without it a report copied in from
  // another line would have nowhere to land.
  const mentions = (front: ReportFrontMatter): readonly string[] =>
    [front.from, ...front.to, ...front.cc, ...front.authors]
  const needsExternal = reports.some((front) => mentions(front).some((id) => id !== undefined && !known.has(id)))
  if (needsExternal) {
    const index = lanes.length
    lanes.push({
      id: undefined,
      index,
      x: opts.gutterWidth + opts.laneWidth * (index + 0.5),
      shortId: '',
      depth: 0,
      live: false,
      external: true,
    })
  }
  const externalIndex = lanes.length - 1
  const laneOf = (id: string | undefined): number =>
    id !== undefined && known.has(id) ? (known.get(id) as number) : externalIndex

  const nodes: TopologyNode[] = []
  /** Row geometry per report, so a thread edge can find its parent's node. */
  const placed = new Map<string, TopologyNode>()
  reports.forEach((front, row) => {
    const laneIndex = laneOf(front.from)
    const lane = lanes[laneIndex]
    const node: TopologyNode = {
      report: front.report,
      laneId: lane?.id,
      laneIndex,
      row,
      x: lane?.x ?? opts.gutterWidth,
      y: opts.rowHeight * row + opts.rowHeight / 2,
      depth: lane?.depth ?? 0,
      status: front.status,
      ...(front.task === undefined ? {} : { task: front.task }),
    }
    nodes.push(node)
    placed.set(front.report, node)
  })

  const edges: TopologyEdge[] = []
  for (const front of reports) {
    const node = placed.get(front.report)
    if (node === undefined) continue

    // Deliveries leave the node and land on the recipient's column, on the same
    // row: the digest does not carry per-hop times (those live in the route
    // sidecar), so the row is the report's own time and the arrow reads as "this
    // report was handed to that column".
    for (const [kind, ids] of [['to', front.to], ['cc', front.cc]] as const) {
      for (const id of new Set(ids)) {
        const target = laneOf(id)
        // A report addressed to its own author has no distance to draw.
        if (target === node.laneIndex) continue
        edges.push({
          report: front.report,
          kind,
          fromLane: node.laneIndex,
          toLane: target,
          fromX: node.x,
          fromY: node.y,
          toX: lanes[target]?.x ?? node.x,
          toY: node.y,
          external: target === externalIndex || node.laneIndex === externalIndex,
        })
      }
    }

    // Co-authorship reads the other way round: the co-author reaches the report.
    for (const id of new Set(front.authors)) {
      if (id === front.from) continue
      const source = laneOf(id)
      if (source === node.laneIndex) continue
      edges.push({
        report: front.report,
        kind: 'author',
        fromLane: source,
        toLane: node.laneIndex,
        fromX: lanes[source]?.x ?? node.x,
        fromY: node.y,
        toX: node.x,
        toY: node.y,
        external: source === externalIndex || node.laneIndex === externalIndex,
      })
    }

    // The thread connector only exists when both ends are plotted; a parent that
    // is filtered out or lives in another tree is the detail panel's business.
    const parent = front.parent === undefined ? undefined : placed.get(front.parent)
    if (parent !== undefined) {
      edges.push({
        report: front.report,
        kind: 'thread',
        fromLane: parent.laneIndex,
        toLane: node.laneIndex,
        fromX: parent.x,
        fromY: parent.y,
        toX: node.x,
        toY: node.y,
        external: parent.laneIndex === externalIndex || node.laneIndex === externalIndex,
      })
    }
  }

  return {
    lanes,
    rows: reports.length,
    nodes,
    edges,
    laneWidth: opts.laneWidth,
    gutterWidth: opts.gutterWidth,
    width: opts.gutterWidth + opts.laneWidth * lanes.length,
    height: opts.rowHeight * reports.length,
    headerHeight: opts.headerHeight,
  }
}

/**
 * Row centre for one row index, for the gutter's timestamp column.
 *
 * Body-local, exactly like the node geometry: row 0 sits at half a row height
 * from the top of the scrolling body, not from the top of the header.
 * @param row - zero-based row.
 * @param options - the same geometry the layout used.
 * @returns the y coordinate of the row's centre.
 */
export function rowCenter(row: number, options: Partial<TopologyOptions> = {}): number {
  const opts: TopologyOptions = { ...DEFAULT_TOPOLOGY_OPTIONS, ...options }
  return opts.rowHeight * row + opts.rowHeight / 2
}
