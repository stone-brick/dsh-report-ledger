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
import { buildCardgraph, CARDGRAPH_LODS, hitTest, lodFor } from './cardgraph-model.ts'
import type { CardgraphLayout, CardgraphLod, CardgraphViewport, Rect } from './cardgraph-model.ts'
import {
  FALLBACK_THEME, WIRE_TOKENS, createCanvasPainter, createThemeReader,
} from './cardgraph-painter.ts'
import type { CardgraphPainter, ThemeReader } from './cardgraph-painter.ts'
import { EDGE_LABEL, STATUS_LABEL } from './locales.ts'
import type { Translate } from './ReportsView.tsx'

/** How far the reader may zoom out and in. */
const MIN_ZOOM = 0.25
const MAX_ZOOM = 2.5
/** One step of the `+`/`−` controls. */
const ZOOM_STEP = 1.25
/**
 * Wheel-zoom exponent per pixel of delta, so that one 100px notch — a mouse
 * wheel's usual magnitude — is exactly the {@link ZOOM_STEP} the buttons take.
 * A trackpad pinch arrives as the same event with much smaller deltas, which is
 * why the zoom is exponential in the delta rather than one step per event.
 */
const WHEEL_ZOOM_RATE = Math.log(ZOOM_STEP) / 100
/**
 * How far the fit may magnify past the drawing's own size.
 *
 * Filling the width on a tree with one card in it would otherwise ask for several
 * times the design's size — one card stretched across the whole box, larger than
 * any reading needs and carrying no more in it, because a tier is drawn at a fixed
 * size and zooming past 100% only magnifies. One control step is the ceiling: the
 * fit may lean in, not stretch. (The `+` control still reaches every zoom a reader
 * asks for by hand.)
 */
const MAX_FIT_ZOOM = ZOOM_STEP
/** How close to the box's edge a wheel-pan stops, in screen pixels. */
const EDGE_MARGIN = 12
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
  /**
   * Fill the host's height instead of the tab's fixed measure.
   *
   * The conversation tab needs a fixed box, because the page below it scrolls and
   * an unbounded drawing would push that page around. A docked panel is the
   * opposite: it owns the height, and a fixed measure there floats the drawing in
   * a half-empty column. The box is measured either way — this only decides who
   * sets the height.
   */
  readonly fill?: boolean
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
export function CardgraphView({ payload, reports, t, openReport, onOpen, idHint, fill = false }: CardgraphViewProps): ReactElement {
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
  /**
   * Whether the transform on screen is still the fit's own.
   *
   * While this holds, the fit follows the box; the moment the reader zooms or pans
   * the view themselves it stops following, because from then on the transform is
   * a decision rather than a consequence — see the resize effect below.
   */
  const fittedTransform = useRef(true)
  /** The last box the resize effect saw, so a re-measure is not a resize. */
  const measured = useRef({ width: 0, height: 0 })
  /** The transform as of this render, for the one listener that is attached once. */
  const zoomRef = useRef(zoom)
  const offsetRef = useRef(offset)
  zoomRef.current = zoom
  offsetRef.current = offset

  const lod = lodFor(zoom)
  const layout = useMemo(() => buildCardgraph(payload, reports, { lod }), [payload, reports, lod])
  /** The drawing as of this render, for that same listener: it needs its extent. */
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const labels = useMemo(() => {
    const status: Record<string, string> = {}
    for (const [state, key] of Object.entries(STATUS_LABEL)) status[state] = t(key)
    return { external: t('cardgraph.external'), empty: t('cardgraph.empty'), status }
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
  /**
   * The drawing at any tier, for the fit's own probing.
   *
   * `layout` above is the tier the current zoom draws. A fit has to look at the
   * other tiers *before* it can know which one it will land in, and building all
   * three on every payload change — every poll — would be paid for nothing.
   */
  const layoutFor = useCallback(
    (tier: CardgraphLod): CardgraphLayout => buildCardgraph(payload, reports, { lod: tier }),
    [payload, reports],
  )

  /**
   * Fill the width, in the richest tier that can afford to.
   *
   * Width is the target because time runs **down** here: a frame is a column, so
   * the horizontal axis is what has to fit on screen and the vertical axis is
   * what the reader pans along. Magnification stops at {@link MAX_FIT_ZOOM}, so a
   * tree too narrow to fill the box is left at its own size instead of stretched.
   *
   * The scale and the tier are mutually dependent — the tier is derived from the
   * zoom (`lodFor`) and the zoom is computed from a layout — so a single pass
   * that reads the *current* `layout` can leave the view drawing one tier while
   * its offset was centred for another: the drawing then floats off-centre, small,
   * in a box it does not fill, and the next click can undo the last one. Probing
   * the tiers makes the result a function of the box alone: idempotent, and
   * independent of whichever tier the reader arrived in.
   */
  const fit = useCallback(() => {
    const box = boxRef.current
    if (box === null) return
    const width = box.clientWidth
    const chosen = CARDGRAPH_LODS
      .map((tier) => ({ tier, drawing: layoutFor(tier) }))
      .filter(({ drawing }) => drawing.width > 0)
      .map(({ tier, drawing }) => ({
        tier,
        drawing,
        scale: clamp((width - 24) / drawing.width, MIN_ZOOM, MAX_FIT_ZOOM),
      }))
      .find(({ tier, scale }) => lodFor(scale) === tier)
    if (chosen === undefined) return
    // The transform is the fit's own again, so it follows the box again.
    fittedTransform.current = true
    setZoom(chosen.scale)
    setOffset({
      x: Math.max(8, (width - chosen.drawing.width * chosen.scale) / 2),
      // Anchored to the top rather than centred: a frame's cards run oldest first,
      // so a drawing taller than its box is read from the top down.
      y: 12,
    })
  }, [layoutFor])

  /**
   * The `+`/`−` controls.
   *
   * An explicit zoom is the reader's decision, so the fit stops following the box
   * from here — the same reason the wheel and the drag clear the flag.
   * @param factor - what to multiply the current zoom by.
   */
  const stepZoom = useCallback((factor: number) => {
    fittedTransform.current = false
    setZoom((z) => clamp(z * factor, MIN_ZOOM, MAX_ZOOM))
  }, [])

  /**
   * The first view is the fit — the same rule the control runs.
   *
   * It used to be a rule of its own (fit the width, never below the card tier,
   * never above 100%) because the fit of the day — the whole drawing inside the
   * box — landed around 57%, the compact tier, and opened the tab as a wall of
   * one-line cards. With the fit now filling the width in the richest tier that
   * can afford it, that special case has nothing left to correct, and one rule is
   * one fewer way for the first sight and the control to disagree.
   */
  useEffect(() => {
    if (fitted.current || size.width === 0 || layout.cards.length === 0) return
    fitted.current = true
    fit()
  }, [fit, layout, size])

  /**
   * Follow the box, but only while the box is what chose the view.
   *
   * A dock, a split and a fullscreen switch all change the box under a transform
   * computed for the old one. A drawing left carrying the old offset is clipped by
   * the new box — it reads as a broken drawing rather than as a preserved view —
   * so a view the fit chose is fitted again. A reader who zoomed in to read one
   * card means it, so a view they took over is left exactly where they put it.
   *
   * The box is compared by value, not by identity: the observer hands over a fresh
   * object on every measure, and a re-measure of the same box is not a resize.
   */
  useEffect(() => {
    const previous = measured.current
    measured.current = size
    if (size.width === 0 || previous.width === 0) return
    if (previous.width === size.width && previous.height === size.height) return
    if (fittedTransform.current) fit()
  }, [fit, size])

  // A real, non-passive wheel listener: React's `onWheel` is passive at the root,
  // where `preventDefault` is a no-op and the page scrolls under the drawing.
  //
  // **The wheel pans; Ctrl/⌘-wheel zooms.** The drawing is read top to bottom — a
  // frame is a column of its session's own timeline, oldest card first — so the
  // wheel is the reader's way down the drawing, which is what every other scroll
  // surface on the page does with it; zoom moves to the modifier, the way editors
  // split the two. Shift is the browser's own "horizontally", and a mouse reports
  // that on the vertical delta.
  //
  // An axis only moves while the drawing overflows it, so a wheel over a drawing
  // that fits cannot nudge it off-centre, and the travel stops one margin short of
  // the edge rather than scrolling the drawing out of the box.
  //
  // The listener is attached once, so it reads the current transform and extent
  // through refs rather than closing over them. The obvious alternative — computing
  // the next zoom inside a `setZoom` updater and calling `setOffset` from in there —
  // is a side effect inside an updater, which React is free to invoke twice; the
  // offset would then be shifted twice per notch and the zoom would drift away from
  // the cursor.
  useEffect(() => {
    const box = boxRef.current
    if (box === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      // Whatever the gesture is, the view is the reader's from here on.
      fittedTransform.current = false
      // `deltaMode` 1 is lines and 2 is pages; a mouse on Windows reports pixels.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.clientHeight : 1
      const dy = event.deltaY * unit
      const dx = event.deltaX * unit
      const previous = offsetRef.current
      if (event.ctrlKey || event.metaKey) {
        const rect = box.getBoundingClientRect()
        const px = event.clientX - rect.left
        const py = event.clientY - rect.top
        const current = zoomRef.current
        const next = clamp(current * Math.exp(-dy * WHEEL_ZOOM_RATE), MIN_ZOOM, MAX_ZOOM)
        const ratio = next / current
        // Keep the point under the cursor fixed: the offset scales about it.
        setOffset({ x: px - (px - previous.x) * ratio, y: py - (py - previous.y) * ratio })
        setZoom(next)
        return
      }
      const drawing = layoutRef.current
      const zoom = zoomRef.current
      const width = drawing.width * zoom
      const height = drawing.height * zoom
      const overflowX = width - box.clientWidth
      const overflowY = height - box.clientHeight
      const panX = event.shiftKey && dx === 0 ? dy : dx
      const panY = event.shiftKey ? 0 : dy
      setOffset({
        x: overflowX > 0 ? clamp(previous.x - panX, box.clientWidth - width - EDGE_MARGIN, EDGE_MARGIN) : previous.x,
        y: overflowY > 0 ? clamp(previous.y - panY, box.clientHeight - height - EDGE_MARGIN, EDGE_MARGIN) : previous.y,
      })
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
        // A drag is the reader placing the drawing, not the box choosing it.
        fittedTransform.current = false
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', ...(fill ? fillRoot : {}) }}>
      <div style={controls}>
        <Button variant="outline" size="sm" aria-label={t('cardgraph.zoomOut')} onClick={() => { stepZoom(1 / ZOOM_STEP) }}>−</Button>
        <span style={percentStyle}>{t('cardgraph.zoom', { percent })}</span>
        <Button variant="outline" size="sm" aria-label={t('cardgraph.zoomIn')} onClick={() => { stepZoom(ZOOM_STEP) }}>+</Button>
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
        title={t('cardgraph.gestureHint')}
        style={{
          ...box,
          ...(fill ? fillBox : { height: `${VIEW_HEIGHT}px` }),
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

/**
 * A filling host owns the height: the root takes the whole body and lets the
 * measured box keep whatever the toolbar left. `minHeight` is what stops a flex
 * child from refusing to shrink, which would push the toolbar off the top of a
 * short panel instead of shrinking the drawing.
 */
const fillRoot: Record<string, string> = { flex: '1 1 auto', height: '100%', minHeight: '0' }
const fillBox: Record<string, string> = { flex: '1 1 auto', minHeight: '0' }

const layer: Record<string, string> = {
  position: 'absolute',
  inset: '0',
  display: 'block',
}
