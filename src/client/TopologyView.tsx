/**
 * The topology overview — a vertical swimlane of one collaboration.
 *
 * One column per session, time running downward, and every report's transfer
 * path drawn as edges between columns. It is an **overview**, not a second
 * reading surface: the geometry comes from `topology-model`, and clicking a node
 * opens that report's card in the list below, which is where the transfer path
 * and the body live. That split is deliberate — a graph is no place to read a
 * 4000-character body, and it is not a keyboard-accessible substitute for the
 * list either, so the list stays and this sits above it.
 *
 * The drawing is SVG for the relations (rails, rows, edges — things that must
 * scale and that nothing can focus) and ordinary DOM for the nodes (so a node is
 * a real button with a real tooltip, and the shell's `Pill` gives it the app's
 * own chip styling).
 *
 * @module dsh-report-ledger/client/TopologyView
 *
 * ⚠️ **Superseded by `CardgraphView.tsx`** (the card canvas) and no longer imported
 * by the tab, so it costs the bundle nothing. Kept deliberately: its model is still
 * asserted by `scripts/topology-check.ts`, and it is the fallback if a canvas proves
 * worse than DOM out on a real ledger.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Pill, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReportFrontMatter } from '../shared/wire.ts'
import { edgeRowSpan, visibleRows } from './topology-model.ts'
import type { TopologyEdge, TopologyEdgeKind, TopologyLayout, TopologyNode } from './topology-model.ts'
import { STATUS_DOT, EDGE_LABEL } from './locales.ts'
import { DIM_CLASS, arrowClass, edgeClass } from './styles.ts'
import type { Translate } from './ReportsView.tsx'

/** How much of an edge to hide behind its endpoints, so lines stop at the chips. */
/**
 * Clearance around a node chip.
 *
 * The model's coordinates are the centres of the things being connected; these
 * are what the drawing subtracts so a line starts past its source chip and stops
 * at its target's edge instead of disappearing underneath either.
 */
const CHIP_HALF_X = 36
const CHIP_HALF_Y = 12

/** Corner radius of an orthogonal run, so a handoff does not look like plumbing. */
const CORNER = 6

/**
 * How tall the drawing's scroll box is.
 *
 * A viewport, not the whole drawing: the topology is an overview above the list,
 * so it gets a fraction of the pane and scrolls inside itself.
 */
const VIEWPORT_MAX_HEIGHT = '46vh'

/** Assumed viewport height for the first paint, before the box has been measured. */
const ASSUMED_VIEWPORT_PX = 600

/** Props for one topology drawing. */
export interface TopologyViewProps {
  /** Geometry from the pure model. */
  readonly layout: TopologyLayout
  /** The digests being plotted, in row order — for labels and tooltips. */
  readonly reports: readonly ReportFrontMatter[]
  readonly t: Translate
  /** Full id plus session title, for hover labels. */
  readonly idHint: (id: string) => string
  /** The report whose card is open, if any. */
  readonly openReport?: string
  /** Open a report's card in the list below. */
  readonly onOpen: (report: string) => void
}

/** Wall-clock time, short enough for the gutter. */
function clock(at: number | undefined): string {
  if (at === undefined || at <= 0) return ''
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** The full timestamp, for the gutter's hover label. */
function stamp(at: number | undefined): string {
  if (at === undefined || at <= 0) return ''
  return new Date(at).toLocaleString()
}

/** Where one edge is drawn, and where its word goes. */
interface EdgeGeometry {
  readonly path: string
  /** Anchor for the hover label, at the middle of the longest segment. */
  readonly labelX: number
  readonly labelY: number
}

/** The kinds in the order the legend and the merged paths list them. */
const EDGE_KINDS: readonly TopologyEdgeKind[] = ['to', 'cc', 'author', 'thread']

/** Marker id for one edge kind, so the path and its arrowhead cannot disagree. */
function markerId(kind: TopologyEdgeKind): string {
  return `report-ledger-arrow-${kind}`
}

/** Muted caption text, at module scope so it does not invalidate memos. */
const caption: Record<string, string | number> = {
  color: 'var(--dsw-alias-label-caption, #999)',
  fontSize: 'var(--dsw-font-xxxs-11, 11)',
  whiteSpace: 'nowrap',
}

/** Keeps a chip's status dot on its text baseline. */
const dotCell: Record<string, string | number> = {
  display: 'inline-flex',
  alignItems: 'center',
  marginRight: '4px',
}

/**
 * An orthogonal run with rounded corners.
 *
 * Thread connectors are routed as axis-aligned segments, so they need corners
 * that do not look like a mistake. Each interior corner is cut with a quadratic
 * whose radius shrinks to fit the shorter of its two segments — a corner cannot
 * be rounded further than the segment it sits on.
 * @param points - the polyline, in order.
 * @param radius - the preferred corner radius.
 * @returns the SVG path.
 */
function orthogonal(points: readonly { x: number; y: number }[], radius: number): string {
  const [first, ...rest] = points
  if (first === undefined) return ''
  let path = `M ${first.x} ${first.y}`
  for (let index = 0; index < rest.length; index++) {
    const point = rest[index]
    if (point === undefined) continue
    if (index === rest.length - 1) {
      path += ` L ${point.x} ${point.y}`
      continue
    }
    const before = points[index] as { x: number; y: number }
    const after = rest[index + 1] as { x: number; y: number }
    const inLength = Math.hypot(point.x - before.x, point.y - before.y)
    const outLength = Math.hypot(after.x - point.x, after.y - point.y)
    const r = Math.min(radius, inLength / 2, outLength / 2)
    const fromX = point.x + (before.x - point.x) / (inLength || 1) * r
    const fromY = point.y + (before.y - point.y) / (inLength || 1) * r
    const toX = point.x + (after.x - point.x) / (outLength || 1) * r
    const toY = point.y + (after.y - point.y) / (outLength || 1) * r
    path += ` L ${fromX} ${fromY} Q ${point.x} ${point.y} ${toX} ${toY}`
  }
  return path
}

/**
 * Turn an edge's canonical endpoints into a drawable path.
 *
 * Two shapes, because the two relations are not the same kind of thing:
 *
 *  - a **delivery** stays on its own row — the digest has no per-hop times (those
 *    live in the route sidecar), so the arrow reads "this report was handed to
 *    that column" at the report's own time;
 *  - a **thread** spans rows, so it is routed down a lane boundary and only then
 *    turned into the child. Drawing it as a direct curve made it cross whatever
 *    sat between parent and child; the boundary is half a column from any node,
 *    so the connector keeps off the nodes entirely.
 * @param edge - one edge.
 * @returns the path and a label anchor.
 */
function edgeGeometry(edge: TopologyEdge): EdgeGeometry {
  if (edge.kind === 'thread' && edge.viaX !== undefined) {
    const viaX = edge.viaX
    // Leave the parent downward, turn into the boundary, run down it, then turn
    // into the child's side.
    const startX = edge.fromX + (viaX > edge.fromX ? CHIP_HALF_X : -CHIP_HALF_X)
    const startY = edge.fromY + CHIP_HALF_Y
    const side = viaX > edge.toX ? 1 : -1
    const endX = edge.toX + side * CHIP_HALF_X
    const endY = edge.toY
    return {
      path: orthogonal([
        { x: startX, y: startY },
        { x: viaX, y: startY },
        { x: viaX, y: endY },
        { x: endX, y: endY },
      ], CORNER),
      labelX: viaX,
      labelY: (startY + endY) / 2,
    }
  }

  const dx = edge.toX - edge.fromX
  const startX = edge.fromX + Math.sign(dx) * CHIP_HALF_X
  const tipX = edge.toX - Math.sign(dx) * CHIP_HALF_X
  return {
    path: `M ${startX} ${edge.fromY} L ${tipX} ${edge.toY}`,
    labelX: (startX + tipX) / 2,
    labelY: edge.toY - 9,
  }
}

/**
 * The key to the drawing's line styles.
 *
 * Built from the same classes the drawing uses, so a change to how 抄送 looks
 * cannot leave the legend claiming something else. Without it a reader has to
 * guess what four line styles mean, and guessing is exactly what an audit view
 * should not ask for.
 * @param props - the locale seat.
 * @returns the legend strip.
 */
export function TopologyLegend(props: { readonly t: Translate }): ReactElement {
  const { t } = props
  const kinds = EDGE_KINDS
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
      {kinds.map((kind) => (
        <span
          key={kind}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: 'var(--dsw-font-xxxs-11, 11px)',
            color: 'var(--dsw-alias-label-caption, #999)',
          }}
        >
          <svg width="22" height="8" aria-hidden="true">
            {/* A thread is drawn orthogonally, so its sample bends too. */}
            <path className={edgeClass(kind)} d={kind === 'thread' ? 'M 1 1 L 9 1 L 9 7 L 21 7' : 'M 1 4 L 21 4'} />
          </svg>
          {t(EDGE_LABEL[kind])}
        </span>
      ))}
    </span>
  )
}

/**
 * Draw the swimlane.
 * @param props - the geometry, the digests and the open callback.
 * @returns the scrollable drawing.
 */
export function TopologyView(props: TopologyViewProps): ReactElement {
  const { layout, reports, t, idHint, openReport, onOpen } = props
  const [hot, setHot] = useState<string | undefined>(undefined)
  const fronts = useMemo(() => new Map(reports.map((front) => [front.report, front])), [reports])

  /**
   * The rows the scroll box is showing.
   *
   * The drawing is one tall coordinate space inside a short box, so most of it is
   * never looked at: at 300 reports, rendering every row meant ~2700 elements and
   * a repaint per shape on every hover. Only the window is rendered.
   */
  const scroller = useRef<HTMLDivElement | null>(null)
  const [slice, setSlice] = useState(() =>
    visibleRows(0, ASSUMED_VIEWPORT_PX, layout.rows, { rowHeight: layout.rowHeight }))
  const pendingFrame = useRef<number | undefined>(undefined)

  const syncWindow = useCallback(() => {
    const element = scroller.current
    if (element === null) return
    const next = visibleRows(element.scrollTop, element.clientHeight, layout.rows, { rowHeight: layout.rowHeight })
    setSlice((current) => (current.first === next.first && current.last === next.last ? current : next))
  }, [layout])

  // Measure once mounted, whenever the drawing changes, and whenever the box is
  // resized (the pane can be dragged).
  useEffect(() => { syncWindow() }, [syncWindow])
  useEffect(() => {
    const element = scroller.current
    if (element === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => { syncWindow() })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [syncWindow])
  // Scrolling is throttled to a frame: a scroll event can fire far more often
  // than the browser paints, and each one would otherwise re-render the window.
  const onScroll = useCallback(() => {
    if (pendingFrame.current !== undefined) return
    pendingFrame.current = globalThis.requestAnimationFrame(() => {
      pendingFrame.current = undefined
      syncWindow()
    })
  }, [syncWindow])
  useEffect(() => () => {
    if (pendingFrame.current !== undefined) globalThis.cancelAnimationFrame(pendingFrame.current)
  }, [])

  /** Whether a row range intersects the window. */
  const inWindow = useCallback(
    (first: number, last: number): boolean => first <= slice.last && last >= slice.first,
    [slice],
  )

  const shownNodes = useMemo(
    () => layout.nodes.filter((node) => inWindow(node.row, node.row)),
    [layout, inWindow],
  )
  const shownEdges = useMemo(
    () => layout.edges.filter((edge) => {
      const span = edgeRowSpan(edge, { rowHeight: layout.rowHeight })
      return inWindow(span.first, span.last)
    }),
    [layout, inWindow],
  )

  /**
   * All edges of one kind concatenated into a single path.
   *
   * They share a style and none of them is clickable, so a path per edge bought
   * nothing and cost a DOM element plus a repaint each — at 300 reports that was
   * ~840 paths and ~840 arrowheads.
   */
  const mergedEdges = useMemo(
    () => EDGE_KINDS.map((kind) => ({
      kind,
      d: shownEdges.filter((edge) => edge.kind === kind).map((edge) => edgeGeometry(edge).path).join(' '),
    })),
    [shownEdges],
  )

  /** Hover label for one node: what it is, who sent it, where it went. */
  const nodeHint = useCallback((node: TopologyNode, front: ReportFrontMatter | undefined): string => {
    if (front === undefined) return node.report
    const parts = [front.subject, `from ${idHint(front.from)}`]
    if (front.to.length > 0) parts.push(`to ${front.to.map(idHint).join(', ')}`)
    if (front.cc.length > 0) parts.push(`cc ${front.cc.map(idHint).join(', ')}`)
    parts.push(t('topology.openHint'))
    return parts.join(' · ')
  }, [t, idHint])

  /**
   * The gutter's timestamps and the node chips.
   *
   * Both are memoised on everything **except** the hover state: a hover must not
   * rebuild three hundred chips, and none of them depends on which one the
   * pointer is over — the pointer callback re-renders the wrapper element, which
   * React reconciles against the same memoised children.
   */
  const clocks = useMemo(
    () => shownNodes.map((node) => {
      const front = fronts.get(node.report)
      return (
        <div
          key={`clock-${node.report}`}
          style={{ ...caption, position: 'absolute', left: 0, top: node.y - 8, width: layout.gutterWidth - 12, textAlign: 'right' }}
        >
          <Tooltip label={stamp(front?.updated)} side="right" delayMs={400}>
            <span>{clock(front?.updated)}</span>
          </Tooltip>
        </div>
      )
    }),
    [shownNodes, fronts, layout],
  )

  const nodes = useMemo(
    () => shownNodes.map((node) => (
      <div
        key={`node-${node.report}`}
        className="report-ledger-node"
        style={{ position: 'absolute', left: node.x, top: node.y, transform: 'translate(-50%, -50%)' }}
        onMouseEnter={() => { setHot(node.report) }}
        onMouseLeave={() => { setHot(undefined) }}
      >
        <Tooltip label={nodeHint(node, fronts.get(node.report))} side="bottom" delayMs={300} maxWidth={360}>
          <Pill active={openReport === node.report} onClick={() => { onOpen(node.report) }}>
            <span style={dotCell}><StateDot state={STATUS_DOT[node.status]} size={6} /></span>
            {node.report}
          </Pill>
        </Tooltip>
      </div>
    )),
    [shownNodes, fronts, openReport, nodeHint, onOpen],
  )

  /** One row's height, taken from the model rather than re-derived. */
  const rowHeight = layout.rowHeight

  return (
    <div ref={scroller} onScroll={onScroll} style={{ maxHeight: VIEWPORT_MAX_HEIGHT, overflow: 'auto' }}>
      <div style={{ width: layout.width, minWidth: '100%' }}>
      {/* The lane header pins to the top of the scroll box, so the columns stay
          identified while the reader scrolls down the time axis. */}
      <div style={{
        position: 'sticky',
        top: 0,
        zIndex: 2,
        width: layout.width,
        height: layout.headerHeight,
        background: 'var(--dsw-alias-bg-base, #fff)',
        borderBottom: '1px solid var(--dsw-alias-border-l2)',
      }}>
        {layout.lanes.map((column) => (
          <div
            key={column.id ?? 'external'}
            style={{
              position: 'absolute',
              left: column.x - layout.laneWidth / 2,
              top: 0,
              width: layout.laneWidth,
              height: layout.headerHeight,
              boxSizing: 'border-box',
              padding: `4px 6px 0 ${4 + column.depth * 6}px`,
              overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <StateDot state={column.live ? 'ongoing' : 'idle'} size={7} />
              <Tooltip label={column.external ? t('topology.external') : (column.id ?? '')} side="bottom" delayMs={400}>
                <span style={{ ...caption, color: 'var(--dsw-alias-label-secondary, #666)' }}>
                  {column.external ? t('topology.external') : column.shortId}
                </span>
              </Tooltip>
            </div>
            <div style={{ ...caption, overflow: 'hidden', textOverflow: 'ellipsis', marginTop: '1px' }}>
              {column.external ? t('topology.externalHint') : (column.title ?? '')}
            </div>
          </div>
        ))}
      </div>

      <div style={{ position: 'relative', width: layout.width, height: layout.height }} className="report-ledger-canvas">
        <svg width={layout.width} height={layout.height} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }} aria-hidden="true">
          {/* One marker per kind instead of a polygon per edge. An arrowhead is a
              decoration of the path, not a node: as markers they cost nothing in
              the DOM and the browser orients them for us. */}
          <defs>
            {EDGE_KINDS.map((kind) => (
              <marker
                key={kind}
                id={markerId(kind)}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                markerUnits="userSpaceOnUse"
                orient="auto"
              >
                <path className={arrowClass(kind)} d="M 0 1 L 9 5 L 0 9 Z" />
              </marker>
            ))}
          </defs>

          {/* Rules first, so edges sit on top of them — and one path each, because
              three hundred <line>s are three hundred shapes to paint. Only the
              window's rows are drawn: the rest cannot be looked at. */}
          <path
            className="report-ledger-rowsep"
            d={Array.from(
              { length: Math.max(0, slice.last - slice.first + 1) },
              (_, offset) => {
                const row = slice.first + offset
                return `M 0 ${row * rowHeight} H ${layout.width}`
              },
            ).join(' ')}
          />
          <path
            className="report-ledger-rail"
            d={layout.lanes.map((column) => `M ${column.x} 0 V ${layout.height}`).join(' ')}
          />

          {/* Every edge of a kind in a single path: they share one style and none
              of them is interactive, so per-edge elements bought nothing and cost
              a repaint each. The hovered report is drawn again below, on top. */}
          <g className={`report-ledger-edges${hot === undefined ? '' : ` ${DIM_CLASS}`}`}>
            {mergedEdges.map(({ kind, d }) => (
              <path key={kind} className={edgeClass(kind)} d={d} markerEnd={`url(#${markerId(kind)})`} />
            ))}
          </g>

          {/* The hovered report's own path, at full strength, over the dimmed layer. */}
          {hot === undefined ? null : (
            <g>
              {shownEdges.flatMap((edge, index) => {
                if (edge.report !== hot) return []
                const geometry = edgeGeometry(edge)
                return [(
                  <path
                    key={`hot-${edge.report}-${edge.kind}-${index}`}
                    className={edgeClass(edge.kind)}
                    d={geometry.path}
                    markerEnd={`url(#${markerId(edge.kind)})`}
                  />
                )]
              })}
            </g>
          )}
        </svg>

        {/* Words for the hovered report's edges only.
            The line style already says 主送 vs 抄送, so permanent labels would
            repeat it on every row; showing them on hover answers the question at
            the moment somebody is actually tracing one path. */}
        {shownEdges.flatMap((edge, index) => {
          if (hot === undefined || edge.report !== hot) return []
          const geometry = edgeGeometry(edge)
          return [(
            <div
              key={`label-${edge.report}-${edge.kind}-${index}`}
              className="report-ledger-edge-label"
              style={{ position: 'absolute', left: geometry.labelX, top: geometry.labelY, transform: 'translate(-50%, -50%)' }}
            >
              {t(EDGE_LABEL[edge.kind])}
            </div>
          )]
        })}

        {/* The gutter is the time axis: one timestamp per row. */}
        {clocks}

        {/* Nodes, memoised on everything except the hover state: hovering must not
            rebuild three hundred chips, and none of them changes when it does. */}
        {nodes}
      </div>
      </div>
    </div>
  )
}
