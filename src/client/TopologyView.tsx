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
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Pill, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReportFrontMatter } from '../shared/wire.ts'
import type { TopologyEdge, TopologyLayout, TopologyNode } from './topology-model.ts'
import { STATUS_DOT } from './locales.ts'
import { DIM_CLASS } from './styles.ts'
import type { Translate } from './ReportsView.tsx'

/** How much of an edge to hide behind its endpoints, so lines stop at the chips. */
const SOURCE_INSET = 40
const TARGET_INSET = 12

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

/** Where one edge is drawn, and which way its arrowhead points. */
interface EdgeGeometry {
  readonly path: string
  readonly arrow: string
}

/**
 * Turn an edge's canonical endpoints into a drawable path.
 *
 * The model's coordinates are the *centres* of the things being connected, and
 * this is where the drawing gives them room: an edge starts past the source chip
 * and stops short of the target, so a line never disappears under a node. That
 * is presentation, so it lives here rather than in the tested geometry.
 * @param edge - one edge.
 * @returns the path and the arrowhead polygon.
 */
function edgeGeometry(edge: TopologyEdge): EdgeGeometry {
  const dx = edge.toX - edge.fromX
  const dy = edge.toY - edge.fromY
  const length = Math.hypot(dx, dy) || 1
  const ux = dx / length
  const uy = dy / length

  // A thread connector always arrives from above, because the parent is drawn on
  // an earlier row; drawing it as a chord would tilt the arrowhead sideways into
  // the node.
  if (edge.kind === 'thread') {
    const tipX = edge.toX
    const tipY = edge.toY - TARGET_INSET
    const startY = edge.fromY + TARGET_INSET
    const midY = (startY + tipY) / 2
    return {
      path: `M ${edge.fromX} ${startY} C ${edge.fromX} ${midY} ${tipX} ${midY} ${tipX} ${tipY}`,
      arrow: arrowHead(tipX, tipY, 0, 1),
    }
  }

  // A delivery stays on its own row: the digest has no per-hop times (those live
  // in the route sidecar), so the arrow reads "this report was handed to that
  // column", and its row is the report's own time.
  const startX = edge.fromX + ux * SOURCE_INSET
  const tipX = edge.toX - ux * TARGET_INSET
  return {
    path: `M ${startX} ${edge.fromY} L ${tipX} ${edge.toY}`,
    arrow: arrowHead(tipX, edge.toY, ux, uy),
  }
}

/** A small triangle pointing along `(ux, uy)`, with its tip at `(x, y)`. */
function arrowHead(x: number, y: number, ux: number, uy: number, size = 4): string {
  const px = -uy
  const py = ux
  const back = size
  const wide = size * 0.8
  return [
    `${x},${y}`,
    `${x - ux * back + px * wide},${y - uy * back + py * wide}`,
    `${x - ux * back - px * wide},${y - uy * back - py * wide}`,
  ].join(' ')
}

/**
 * Draw the swimlane.
 * @param props - the geometry, the digests and the open callback.
 * @returns the scrollable drawing.
 */
export function TopologyView(props: TopologyViewProps): ReactElement {
  const { layout, reports, t, idHint, openReport, onOpen } = props
  const [hot, setHot] = useState<string | undefined>(undefined)
  const fronts = new Map(reports.map((front) => [front.report, front]))
  /** Everything that is not the hovered report's path fades back. */
  const dim = (report: string): string | undefined => (hot === undefined || hot === report ? undefined : DIM_CLASS)
  const caption: Record<string, string | number> = {
    color: 'var(--dsw-alias-label-caption, #999)',
    fontSize: 'var(--dsw-font-xxxs-11, 11)',
    whiteSpace: 'nowrap',
  }
  const dotCell: Record<string, string | number> = {
    display: 'inline-flex',
    alignItems: 'center',
    marginRight: '4px',
  }

  /** Hover label for one node: what it is, who sent it, where it went. */
  const nodeHint = (node: TopologyNode, front: ReportFrontMatter | undefined): string => {
    if (front === undefined) return node.report
    const parts = [front.subject, `from ${idHint(front.from)}`]
    if (front.to.length > 0) parts.push(`to ${front.to.map(idHint).join(', ')}`)
    if (front.cc.length > 0) parts.push(`cc ${front.cc.map(idHint).join(', ')}`)
    parts.push(t('topology.openHint'))
    return parts.join(' · ')
  }

  const lane = (index: number): number => layout.lanes[index]?.x ?? 0
  /** One row's height, recovered from the drawing box the model gave us. */
  const rowHeight = layout.rows > 0 ? layout.height / layout.rows : 0

  return (
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

      <div style={{ position: 'relative', width: layout.width, height: layout.height }}>
        <svg width={layout.width} height={layout.height} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }} aria-hidden="true">
          {/* Row separators first, so edges sit on top of the rules. */}
          {Array.from({ length: layout.rows }, (_, row) => (
            <line
              key={`row-${row}`}
              className="report-ledger-rowsep"
              x1={0}
              y1={row * rowHeight}
              x2={layout.width}
              y2={row * rowHeight}
            />
          ))}
          {layout.lanes.map((column) => (
            <line key={`rail-${column.id ?? 'external'}`} className="report-ledger-rail" x1={column.x} y1={0} x2={column.x} y2={layout.height} />
          ))}
          {layout.edges.map((edge, index) => {
            const geometry = edgeGeometry(edge)
            return (
              <g key={`edge-${edge.report}-${edge.kind}-${index}`} className={dim(edge.report)}>
                <path className={`report-ledger-edge report-ledger-edge-${edge.kind}`} d={geometry.path} />
                <polygon className={`report-ledger-arrow-${edge.kind}`} points={geometry.arrow} />
              </g>
            )
          })}
        </svg>

        {/* The gutter is the time axis: one timestamp per row. */}
        {layout.nodes.map((node) => {
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
        })}

        {layout.nodes.map((node) => {
          const front = fronts.get(node.report)
          const isOpen = openReport === node.report
          return (
            <div
              key={`node-${node.report}`}
              className={dim(node.report)}
              style={{ position: 'absolute', left: node.x, top: node.y, transform: 'translate(-50%, -50%)' }}
              onMouseEnter={() => { setHot(node.report) }}
              onMouseLeave={() => { setHot(undefined) }}
            >
              <Tooltip label={nodeHint(node, front)} side="bottom" delayMs={300} maxWidth={360}>
                <Pill active={isOpen} onClick={() => { onOpen(node.report) }}>
                  <span style={dotCell}><StateDot state={STATUS_DOT[node.status]} size={6} /></span>
                  {node.report}
                </Pill>
              </Tooltip>
            </div>
          )
        })}
      </div>
    </div>
  )
}
