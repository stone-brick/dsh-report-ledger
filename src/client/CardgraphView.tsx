/**
 * The card canvas's view: two canvases, a pan/zoom transform, picking, and an
 * invisible button layer.
 *
 * The drawing is split across two surfaces, and that split is the whole
 * performance story:
 *
 *  - the **base** canvas holds frames, wires and cards, and is repainted only when
 *    the drawing itself changes (layout, transform, size, theme);
 *  - the **interaction** canvas holds one report's path over a scrim, and is
 *    repainted on every hover. Its cost does not grow with the ledger, because it
 *    never touches the shapes underneath.
 *
 * Picking is arithmetic rather than elements: the canvas has nothing to hit, so
 * `hitTest` from the model is given the cards (topmost first) and then the frames.
 * What the canvas also cannot offer is accessibility — so every card that is on
 * screen gets a real, transparent `<button>` on top of it, which is what a keyboard
 * or a screen reader reaches, and the list below stays the full accessible path.
 *
 * @module dsh-report-ledger/client/CardgraphView
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReportFrontMatter, TimelinePayload } from '../shared/wire.ts'
import { buildCardgraph, hitTest, lodFor } from './cardgraph-model.ts'
import type { CardgraphLayout, CardgraphViewport, Rect } from './cardgraph-model.ts'
import {
  FALLBACK_THEME, WIRE_TOKENS, createCanvasPainter, createThemeReader,
} from './cardgraph-painter.ts'
import type { CardgraphPainter, ThemeReader } from './cardgraph-painter.ts'
import { EDGE_LABEL, STATUS_LABEL } from './locales.ts'
import type { Translate } from './ReportsView.tsx'

/** How far the reader may zoom out and in. */
const MIN_ZOOM = 0.25
const MAX_ZOOM = 2.5
/** One wheel notch. */
const ZOOM_STEP = 1.25
/** Drawing units to keep beyond the viewport, so a pan does not reveal a blank band. */
const OVERSCAN = 160
/** How tall the canvas box is, inside the tab. */
const VIEW_HEIGHT = 420
/** How far the pointer may travel before a press becomes a drag instead of a click. */
const DRAG_SLOP = 4
/** The four kinds, in the order the legend lists them. */
const KINDS = ['to', 'cc', 'author', 'thread'] as const

/** One pickable thing, shaped for the model's `hitTest`. */
interface PickTarget {
  readonly kind: 'card' | 'frame'
  readonly report?: string
  readonly frame?: number
  readonly bounds: Rect
}

/** Props for the card canvas. */
export interface CardgraphViewProps {
  /** The endpoint payload, for the session frames. */
  readonly payload: TimelinePayload
  /** The digests being plotted — the same filtered set the list renders. */
  readonly reports: readonly ReportFrontMatter[]
  readonly t: Translate
  /** The report whose card is open, if any. */
  readonly openReport?: string
  /** Open a report's card in the list below. */
  readonly onOpen: (report: string) => void
  /** Full id plus session title, for the frame's hover label. */
  readonly idHint: (id: string) => string
}

/**
 * The legend.
 *
 * Built from the painter's own wire table (`WIRE_TOKENS`) rather than from CSS, so
 * a legend that disagreed with the lines beside it would take a change to that one
 * table — the drift the swimlane's legend avoided a different way (by sharing a
 * class name with its paths).
 * @param props - the translator.
 * @returns the legend row.
 */
export function CardgraphLegend({ t }: { readonly t: Translate }): ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
      {KINDS.map((kind) => (
        <span
          key={kind}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: 'var(--dsw-font-xxxs-11, 11px)', color: 'var(--dsw-alias-label-caption)' }}
        >
          <svg width="26" height="8" aria-hidden="true" focusable="false">
            <line
              x1="0"
              y1="4"
              x2="26"
              y2="4"
              stroke={`var(${WIRE_TOKENS[kind].colour})`}
              strokeWidth={WIRE_TOKENS[kind].width}
              {...(WIRE_TOKENS[kind].dash.length === 0 ? {} : { strokeDasharray: WIRE_TOKENS[kind].dash.join(' ') })}
            />
          </svg>
          {t(EDGE_LABEL[kind])}
        </span>
      ))}
    </div>
  )
}

/** Keep a number inside a range. */
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

/**
 * The drawing.
 * @param props - payload, the reports to plot, translations, and the open handler.
 * @returns the canvas box with its controls.
 */
export function CardgraphView({ payload, reports, t, openReport, onOpen, idHint }: CardgraphViewProps): ReactElement {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const baseRef = useRef<HTMLCanvasElement | null>(null)
  const pathRef = useRef<HTMLCanvasElement | null>(null)
  const painter = useRef<CardgraphPainter | null>(null)
  const pathPainter = useRef<CardgraphPainter | null>(null)
  const reader = useRef<ThemeReader | null>(null)
  const drag = useRef<{ x: number; y: number; offsetX: number; offsetY: number; moved: boolean } | null>(null)

  const [size, setSize] = useState({ width: 0, height: VIEW_HEIGHT })
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [hover, setHover] = useState<{ report?: string; frame?: number }>({})
  const [ready, setReady] = useState(false)
  const fitted = useRef(false)
  /** The transform as of this render, for the one listener that is attached once. */
  const zoomRef = useRef(zoom)
  const offsetRef = useRef(offset)
  zoomRef.current = zoom
  offsetRef.current = offset

  const lod = lodFor(zoom)
  const layout = useMemo(() => buildCardgraph(payload, reports, { lod }), [payload, reports, lod])

  const labels = useMemo(() => {
    const status: Record<string, string> = {}
    for (const [state, key] of Object.entries(STATUS_LABEL)) status[state] = t(key)
    return { external: t('topology.external'), empty: t('cardgraph.empty'), status }
  }, [t])

  // ---------------------------------------------------------------------------
  // Mounting: painters, theme reader, and the observed size
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const base = baseRef.current
    const path = pathRef.current
    if (base === null || path === null) return
    painter.current = createCanvasPainter(base)
    pathPainter.current = createCanvasPainter(path)
    reader.current = createThemeReader(globalThis.document.documentElement, globalThis.window)
    setReady(true)
    return () => {
      painter.current = null
      pathPainter.current = null
      reader.current = null
      setReady(false)
    }
  }, [])

  useEffect(() => {
    const box = boxRef.current
    if (box === null) return
    const measure = (): void => {
      setSize({ width: box.clientWidth, height: box.clientHeight })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    return () => { observer.disconnect() }
  }, [])

  const viewport = useMemo<CardgraphViewport>(
    () => ({ offsetX: offset.x, offsetY: offset.y, scale: zoom, width: size.width, height: size.height }),
    [offset, zoom, size],
  )
  const focus = useMemo(
    () => ({
      ...(hover.report === undefined ? {} : { report: hover.report }),
      ...(hover.frame === undefined ? {} : { frame: hover.frame }),
      ...(openReport === undefined ? {} : { selected: openReport }),
    }),
    [hover, openReport],
  )
  const scene = useMemo(() => ({
    layout,
    theme: reader.current?.read() ?? FALLBACK_THEME,
    viewport,
    focus,
    labels,
    overscan: OVERSCAN,
  }), [layout, viewport, focus, labels])

  // ---------------------------------------------------------------------------
  // Painting
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const target = painter.current
    if (!ready || target === null) return
    target.resize(size.width, size.height, globalThis.devicePixelRatio || 1)
    // The base layer is drawn with nothing focused: focus lives on the overlay, so
    // a hover never repaints the shapes underneath it.
    target.paint({ ...scene, focus: openReport === undefined ? {} : { selected: openReport } })
  }, [ready, scene, size, openReport])

  useEffect(() => {
    const target = pathPainter.current
    if (!ready || target === null) return
    target.resize(size.width, size.height, globalThis.devicePixelRatio || 1)
    target.paintPath(scene)
  }, [ready, scene, size])

  // ---------------------------------------------------------------------------
  // Picking
  // ---------------------------------------------------------------------------
  /** Everything under the pointer, topmost first: cards, then the frames holding them. */
  const targets = useMemo<readonly PickTarget[]>(() => [
    ...[...layout.cards].reverse().map((card) => ({ kind: 'card' as const, report: card.report, bounds: card.bounds })),
    ...[...layout.frames].reverse().map((frame) => ({ kind: 'frame' as const, frame: frame.index, bounds: frame.bounds })),
  ], [layout])

  const pick = useCallback((clientX: number, clientY: number): PickTarget | undefined => {
    const box = boxRef.current
    if (box === null) return undefined
    const rect = box.getBoundingClientRect()
    const x = (clientX - rect.left - offset.x) / zoom
    const y = (clientY - rect.top - offset.y) / zoom
    return hitTest(targets, x, y)
  }, [targets, offset, zoom])

  // ---------------------------------------------------------------------------
  // Fitting, zooming and panning
  // ---------------------------------------------------------------------------
  const fit = useCallback(() => {
    const box = boxRef.current
    if (box === null || layout.width <= 0 || layout.height <= 0) return
    const width = box.clientWidth
    const height = box.clientHeight
    const next = clamp(Math.min((width - 24) / layout.width, (height - 24) / layout.height), MIN_ZOOM, 1)
    setZoom(next)
    setOffset({
      x: Math.max(8, (width - layout.width * next) / 2),
      y: Math.max(8, (height - layout.height * next) / 2),
    })
  }, [layout])

  /**
   * The first view, which is deliberately **not** the fit.
   *
   * Fitting the whole drawing into a 420px box on a three-column tree lands around
   * 57%, which is the compact tier — so the reader's first sight of a card canvas
   * would be a wall of one-line cards with the subjects this design is about elided.
   * Measured on the real tab, not reasoned about: the first screenshot of the wiring
   * came out at 57% and proved the point.
   *
   * So the first view fits the **width** and never drops below the card tier: frames,
   * columns and readable cards all visible at once, and the reader scrolls down
   * instead of squinting. `适应窗口` still gives the whole picture on demand.
   */
  useEffect(() => {
    if (fitted.current || size.width === 0 || layout.cards.length === 0) return
    fitted.current = true
    const next = clamp((size.width - 24) / Math.max(layout.width, 1), 0.8, 1)
    setZoom(next)
    setOffset({ x: Math.max(8, (size.width - layout.width * next) / 2), y: 12 })
  }, [layout, size])

  // A real, non-passive wheel listener: React's `onWheel` is passive at the root,
  // where `preventDefault` is a no-op and the page scrolls under the zoom.
  //
  // The listener is attached once, so it reads the current transform through refs
  // rather than closing over it. The obvious alternative — computing the next zoom
  // inside a `setZoom` updater and calling `setOffset` from in there — is a side
  // effect inside an updater, which React is free to invoke twice; the offset would
  // then be shifted twice per notch and the zoom would drift away from the cursor.
  useEffect(() => {
    const box = boxRef.current
    if (box === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = box.getBoundingClientRect()
      const px = event.clientX - rect.left
      const py = event.clientY - rect.top
      const current = zoomRef.current
      const next = clamp(current * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), MIN_ZOOM, MAX_ZOOM)
      const ratio = next / current
      const previous = offsetRef.current
      // Keep the point under the cursor fixed: the offset scales about it.
      setOffset({ x: px - (px - previous.x) * ratio, y: py - (py - previous.y) * ratio })
      setZoom(next)
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => { box.removeEventListener('wheel', onWheel) }
  }, [])

  /** Drag to pan, click to open. Distinguishing them by distance travelled. */
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    drag.current = { x: event.clientX, y: event.clientY, offsetX: offset.x, offsetY: offset.y, moved: false }
  }, [offset])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pressing = drag.current
    if (pressing !== null) {
      const dx = event.clientX - pressing.x
      const dy = event.clientY - pressing.y
      if (Math.abs(dx) + Math.abs(dy) > DRAG_SLOP) pressing.moved = true
      if (pressing.moved) {
        setOffset({ x: pressing.offsetX + dx, y: pressing.offsetY + dy })
        return
      }
    }
    const hit = pick(event.clientX, event.clientY)
    setHover(hit?.kind === 'card' && hit.report !== undefined
      ? { report: hit.report }
      : hit?.kind === 'frame' && hit.frame !== undefined ? { frame: hit.frame } : {})
  }, [pick])

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pressing = drag.current
    drag.current = null
    if (pressing === null || pressing.moved) return
    const hit = pick(event.clientX, event.clientY)
    if (hit?.kind === 'card' && hit.report !== undefined) onOpen(hit.report)
  }, [pick, onOpen])

  const onPointerLeave = useCallback(() => {
    drag.current = null
    setHover({})
  }, [])

  // ---------------------------------------------------------------------------
  // The accessible layer: one real button per visible card
  // ---------------------------------------------------------------------------
  const visibleCards = useMemo(() => {
    const left = -offset.x / zoom
    const top = -offset.y / zoom
    const right = (size.width - offset.x) / zoom
    const bottom = (size.height - offset.y) / zoom
    return layout.cards.filter((card) => card.bounds.x < right && left < card.bounds.x + card.bounds.width
      && card.bounds.y < bottom && top < card.bounds.y + card.bounds.height)
  }, [layout, offset, zoom, size])

  const percent = Math.round(zoom * 100)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={controls}>
        <Button variant="outline" size="sm" aria-label={t('cardgraph.zoomOut')} onClick={() => { setZoom((z) => clamp(z / ZOOM_STEP, MIN_ZOOM, MAX_ZOOM)) }}>−</Button>
        <span style={percentStyle}>{t('cardgraph.zoom', { percent })}</span>
        <Button variant="outline" size="sm" aria-label={t('cardgraph.zoomIn')} onClick={() => { setZoom((z) => clamp(z * ZOOM_STEP, MIN_ZOOM, MAX_ZOOM)) }}>+</Button>
        <Button variant="outline" size="sm" onClick={fit}>{t('cardgraph.fit')}</Button>
        <CardgraphLegend t={t} />
        <span style={percentStyle}>{t('cardgraph.summary', { frames: layout.frames.length, cards: layout.cards.length })}</span>
      </div>
      <div
        ref={boxRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        style={{
          ...box,
          height: `${VIEW_HEIGHT}px`,
          cursor: drag.current?.moved === true ? 'grabbing' : hover.report === undefined ? 'grab' : 'pointer',
        }}
      >
        <canvas ref={baseRef} role="img" aria-label={t('cardgraph.summary', { frames: layout.frames.length, cards: layout.cards.length })} style={layer} />
        <canvas ref={pathRef} aria-hidden="true" style={layer} />
        {visibleCards.map((card) => (
          <button
            key={card.report}
            type="button"
            aria-label={`${card.report} · ${card.subject}`}
            title={idHint(card.report)}
            onClick={() => { onOpen(card.report) }}
            onFocus={() => { setHover({ report: card.report }) }}
            onBlur={() => { setHover({}) }}
            style={{
              position: 'absolute',
              left: `${card.bounds.x * zoom + offset.x}px`,
              top: `${card.bounds.y * zoom + offset.y}px`,
              width: `${card.bounds.width * zoom}px`,
              height: `${card.bounds.height * zoom}px`,
              padding: 0,
              border: 0,
              background: 'transparent',
              cursor: 'pointer',
            }}
          />
        ))}
      </div>
    </div>
  )
}

const controls: Record<string, string> = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexWrap: 'wrap',
}

const percentStyle: Record<string, string> = {
  fontSize: 'var(--dsw-font-xxxs-11, 11px)',
  color: 'var(--dsw-alias-label-caption)',
  fontVariantNumeric: 'tabular-nums',
}

const box: Record<string, string> = {
  position: 'relative',
  overflow: 'hidden',
  borderRadius: '6px',
  border: '1px solid var(--dsw-alias-border-l1)',
  touchAction: 'none',
}

const layer: Record<string, string> = {
  position: 'absolute',
  inset: '0',
  display: 'block',
}
