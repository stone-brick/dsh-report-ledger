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
 * A frame gets one too, over its title bar: that is the keyboard's way in.
 *
 * Navigation is layered, in the sense a subgraph editor means it: a session frame
 * can be **entered**, which swaps what the drawing is a drawing of — frames
 * outside the scope stop existing rather than being zoomed out of sight — and the
 * breadcrumb above the box walks back out. The scope itself is the model's
 * (`scopeInput`); this file only keeps the drill state and remembers where the
 * reader was in each scope, so leaving and coming back lands where they left it.
 *
 * @module dsh-report-ledger/client/CardgraphView
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReportFrontMatter, TimelinePayload } from '../shared/wire.ts'
import {
  buildCardgraph, cullByBounds, fitTransform, hitTest, lodFor, MAX_ZOOM, MIN_ZOOM, scopeInput, ZOOM_STEP,
} from './cardgraph-model.ts'
import type { CardgraphViewport, Rect } from './cardgraph-model.ts'
import {
  FALLBACK_THEME, WIRE_TOKENS, createCanvasPainter, createThemeReader,
} from './cardgraph-painter.ts'
import type { CardgraphPainter, PaintScene, ThemeReader } from './cardgraph-painter.ts'
import { EDGE_LABEL, STATUS_LABEL } from './locales.ts'
import type { Translate } from './ReportsView.tsx'
import { selection } from './selection-bridge.ts'
import { shortId } from './timeline-model.ts'

/**
 * Wheel-zoom exponent per pixel of delta, so that one 100px notch — a mouse
 * wheel's usual magnitude — is exactly the {@link ZOOM_STEP} the buttons take.
 * A trackpad pinch arrives as the same event with much smaller deltas, which is
 * why the zoom is exponential in the delta rather than one step per event.
 */
const WHEEL_ZOOM_RATE = Math.log(ZOOM_STEP) / 100
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

/** What the pointer is on, or nothing. Kept apart from the base layer's scene on purpose. */
interface HoverTarget {
  readonly report?: string
  readonly frame?: number
}

/**
 * Whether the pointer is on the same thing.
 *
 * A pointermove over one card is not a new hover: without this the state object is
 * replaced on every move, which re-renders the drawing and repaints the overlay for
 * no change at all.
 */
const sameHover = (a: HoverTarget, b: HoverTarget): boolean => a.report === b.report && a.frame === b.frame

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
  const drag = useRef<{
    x: number
    y: number
    offsetX: number
    offsetY: number
    moved: boolean
    pointerId: number
  } | null>(null)

  const [size, setSize] = useState({ width: 0, height: VIEW_HEIGHT })
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [hover, setHover] = useState<HoverTarget>({})
  /**
   * What the other surface (the list) is pointing at, and the report it has open.
   *
   * The canvas is in the right column and the list is in the conversation area:
   * two React trees, no shared props, one module — so the bridge under
   * `selection-bridge.ts` is the whole channel. A pointer on a card wins over a
   * row the list lit, because that pointer is physically here; the row's hover
   * shows whenever this pointer is on empty canvas.
   */
  const bridged = useSyncExternalStore(selection.subscribe, selection.get)
  const pointed = hover.report ?? bridged.hover
  /** The session id the drawing is scoped to; absent means the whole tree. */
  const [drill, setDrill] = useState<string | undefined>(undefined)
  const [ready, setReady] = useState(false)
  /** Bumped when the palette changed, so the theme is read again. */
  const [themeTick, setThemeTick] = useState(0)
  /** Bumped when font metrics may have arrived, so the measured text is dropped. */
  const [fontTick, setFontTick] = useState(0)
  /** Bumped when the device pixel ratio may have changed. */
  const [dprTick, setDprTick] = useState(0)
  /**
   * The scope whose view has already been chosen (fitted, or restored from the
   * reader's own transform). Empty until the box has a width.
   */
  const fittedScope = useRef<string | null>(null)
  /**
   * A transform per scope.
   *
   * Leaving a level and coming back has to land where the reader was, not at the
   * fit — the fit is only the first sight of a scope they have not touched. The
   * `fitted` flag travels with it: a view the fit chose still follows the box, a
   * view the reader took over does not.
   */
  const viewMemory = useRef(new Map<string, {
    zoom: number
    offset: { x: number; y: number }
    fitted: boolean
  }>())
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

  /**
   * What this drawing is a drawing **of**.
   *
   * Drilling in swaps the input rather than the transform: the frames outside the
   * scope stop existing, so their wires land on the outside frame instead of
   * crossing the drawing, and no view of the parent level can be mistaken for this
   * one. The trail comes from the model's ancestry walk, not from the drill state,
   * so a scope whose session vanished from a refreshed payload degrades to the
   * whole tree instead of leaving a crumb that leads nowhere.
   */
  const scope = useMemo(() => scopeInput(payload, reports, drill), [payload, reports, drill])
  const scopeKey = scope.trail.join('/')
  const lod = lodFor(zoom)
  const layout = useMemo(() => buildCardgraph(scope.payload, scope.reports, { lod }), [scope, lod])
  /** The drawing as of this render, for that same listener: it needs its extent. */
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  /** Frame titles for the breadcrumb; a crumb that showed an id would be a riddle. */
  const titles = useMemo(
    () => new Map(payload.sessions.map((session) => [session.id, session.title])),
    [payload],
  )

  const labels = useMemo(() => {
    const status: Record<string, string> = {}
    for (const [state, key] of Object.entries(STATUS_LABEL)) status[state] = t(key)
    return {
      // The same frame, two names: from outside a scope its members are "outside
      // the tree", from inside it they are "outside the scope".
      external: t(scope.trail.length === 0 ? 'cardgraph.external' : 'cardgraph.outside'),
      empty: t('cardgraph.empty'),
      status,
    }
  }, [scope.trail.length, t])

  // ---------------------------------------------------------------------------
  // Mounting: painters, theme reader, the observed size, and the two things that
  // invalidate the drawing without changing it (palette, font metrics)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const base = baseRef.current
    const path = pathRef.current
    if (base === null || path === null) return
    painter.current = createCanvasPainter(base)
    pathPainter.current = createCanvasPainter(path)
    // The palette is declared on `body`, not on `:root` — see `createThemeReader`,
    // which is why both elements are offered, `body` first. Reading the document
    // element alone returns the empty string for every token and collapses the whole
    // drawing onto the fallback theme, which is a white canvas in a dark shell.
    const doc = globalThis.document
    reader.current = createThemeReader([doc.body, doc.documentElement], globalThis.window)
    // The drawing has to follow the palette it was painted with. The shell switches
    // it by toggling this attribute on `body`, and nothing else in the drawing would
    // repaint when it does.
    const palette = new MutationObserver(() => { setThemeTick((tick) => tick + 1) })
    palette.observe(doc.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    // Measured text is only as good as the font it was measured against: a family
    // that arrives after the first paint would keep the widths the first paint
    // measured until something else emptied the cache.
    void doc.fonts.ready.then(() => {
      painter.current?.reset()
      pathPainter.current?.reset()
      setFontTick((tick) => tick + 1)
    })
    setReady(true)
    return () => {
      palette.disconnect()
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

  // A window moved between monitors changes the device pixel ratio without changing
  // the box, so the backing store has to be resized for the same reason a resize is.
  useEffect(() => {
    const win = globalThis.window
    const bump = (): void => { setDprTick((tick) => tick + 1) }
    win.addEventListener('resize', bump)
    return () => { win.removeEventListener('resize', bump) }
  }, [])

  const viewport = useMemo<CardgraphViewport>(
    () => ({ offsetX: offset.x, offsetY: offset.y, scale: zoom, width: size.width, height: size.height }),
    [offset, zoom, size],
  )
  /**
   * The theme the drawing is painted in.
   *
   * Read through the reader (which caches until the canary token moves) and keyed by
   * `ready` so the first real read happens once the reader exists, and by
   * `themeTick` so a palette switch repaints without waiting for the next poll.
   */
  const theme = useMemo(
    () => (ready ? reader.current?.read() ?? FALLBACK_THEME : FALLBACK_THEME),
    [ready, themeTick],
  )
  /**
   * The base layer's scene.
   *
   * Carries the open report — the selected card is accented there — but deliberately
   * **not** the hover: the bottom layer is repainted only when the drawing itself
   * changes, and a pointer moving over the canvas is not a change to the drawing.
   * The hover travels in {@link overlayScene}, which is what the second canvas is for.
   */
  const baseScene = useMemo<PaintScene>(() => ({
    layout,
    theme,
    viewport,
    labels,
    overscan: OVERSCAN,
    focus: openReport === undefined ? {} : { selected: openReport },
  }), [layout, theme, viewport, labels, openReport])
  /** The overlay's scene: the base scene plus what the pointer and the panel point at. */
  const overlayScene = useMemo<PaintScene>(() => ({
    ...baseScene,
    focus: {
      ...(openReport === undefined ? {} : { selected: openReport }),
      ...(pointed === undefined ? {} : { report: pointed }),
      ...(hover.frame === undefined ? {} : { frame: hover.frame }),
    },
  }), [baseScene, openReport, pointed, hover.frame])

  // ---------------------------------------------------------------------------
  // Painting
  // ---------------------------------------------------------------------------
  // Sizing the backing store is its own effect: it reallocates the canvas, so it
  // belongs to a box change (or a device pixel ratio change), never to a repaint.
  // It is declared before the two paint effects so that, within one commit, the
  // canvas is the right size before anything is drawn into it.
  useEffect(() => {
    if (!ready) return
    const ratio = globalThis.devicePixelRatio || 1
    painter.current?.resize(size.width, size.height, ratio)
    pathPainter.current?.resize(size.width, size.height, ratio)
  }, [ready, size, dprTick])

  useEffect(() => {
    const target = painter.current
    if (!ready || target === null) return
    target.paint(baseScene)
  }, [ready, baseScene, fontTick])

  useEffect(() => {
    const target = pathPainter.current
    if (!ready || target === null) return
    target.paintPath(overlayScene)
  }, [ready, overlayScene, fontTick])

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
   * Fill the width, in the richest tier that can afford to.
   *
   * The geometry itself lives in the model ({@link fitTransform}): the scale and
   * the tier are mutually dependent, so the probing belongs where it is pure,
   * byte-deterministic, and reachable by the assertions. What stays here is the
   * one thing that needs the DOM — which width to fit into — and the state write.
   */
  const fit = useCallback(() => {
    const box = boxRef.current
    if (box === null) return
    const next = fitTransform(scope.payload, scope.reports, box.clientWidth)
    if (next === undefined) return
    // The transform is the fit's own again, so it follows the box again.
    fittedTransform.current = true
    setZoom(next.scale)
    // Anchored to the top rather than centred vertically: a frame's cards run
    // oldest first, so a drawing taller than its box is read from the top down.
    setOffset({ x: next.offsetX, y: next.offsetY })
  }, [scope])

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

  /** Remember the transform a scope is being left with, so coming back does not fit again. */
  const remember = useCallback((key: string) => {
    viewMemory.current.set(key, {
      zoom: zoomRef.current,
      offset: { ...offsetRef.current },
      fitted: fittedTransform.current,
    })
  }, [])

  /**
   * Enter one session's subtree.
   *
   * The payload's own root is not enterable: its scope *is* the whole tree, so a
   * crumb for it would be indistinguishable from the first crumb.
   * @param index - the frame's index in the current layout.
   */
  const enterFrame = useCallback((index: number) => {
    const id = layoutRef.current.frames[index]?.id
    if (id === undefined || id === payload.root) return
    remember(scopeKey)
    setDrill(id)
  }, [payload.root, remember, scopeKey])

  /**
   * Walk back out to a breadcrumb level.
   * @param level - how many crumbs to keep; 0 is the whole tree.
   */
  const leaveTo = useCallback((level: number) => {
    if (level >= scope.trail.length) return
    remember(scopeKey)
    setDrill(level === 0 ? undefined : scope.trail[level - 1])
  }, [remember, scope.trail, scopeKey])

  /**
   * Choose the view for a scope: the one the reader left it with, or the fit.
   *
   * This replaces the old "first sight is the fit" guard rather than adding to it.
   * A scope is settled once, on arrival — fitted when it is new, restored (zoom,
   * pan and all) when the reader had already adjusted it, and re-fitted when the
   * box moved while they were inside. Keying it on the scope instead of on the
   * layout is what keeps a poll from re-fitting the drawing every ten seconds.
   */
  useEffect(() => {
    if (size.width === 0 || layout.width === 0) return
    if (fittedScope.current === scopeKey) return
    fittedScope.current = scopeKey
    // The hover named a frame index in the previous drawing; keeping it would
    // highlight whatever happens to sit at that index here.
    setHover((current) => (sameHover(current, {}) ? current : {}))
    const remembered = viewMemory.current.get(scopeKey)
    if (remembered !== undefined && !remembered.fitted) {
      fittedTransform.current = false
      setZoom(clamp(remembered.zoom, MIN_ZOOM, MAX_ZOOM))
      setOffset(remembered.offset)
      return
    }
    fit()
  }, [fit, layout, scopeKey, size])

  /**
   * Esc leaves the scope, like the breadcrumb does.
   *
   * Attached only while drilled, so it never competes with the page for the key,
   * and skipped while the reader is typing somewhere.
   */
  useEffect(() => {
    if (scope.trail.length === 0) return
    const win = globalThis.window
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]') !== null) return
      event.preventDefault()
      leaveTo(scope.trail.length - 1)
    }
    win.addEventListener('keydown', onKeyDown)
    return () => { win.removeEventListener('keydown', onKeyDown) }
  }, [leaveTo, scope.trail.length])

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

  /**
   * Drag to pan, click to open. Distinguishing them by distance travelled.
   *
   * The pointer is captured on press, so a drag keeps following it outside the box
   * instead of being abandoned at the edge (a mouse has no implicit capture; touch
   * does). Only the primary pointer is followed, so a second finger cannot reset the
   * drag's origin halfway through a pan.
   */
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      offsetX: offset.x,
      offsetY: offset.y,
      moved: false,
      pointerId: event.pointerId,
    }
  }, [offset])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary) return
    const pressing = drag.current
    if (pressing !== null) {
      const dx = event.clientX - pressing.x
      const dy = event.clientY - pressing.y
      // Squared Euclidean, so the slop means the distance the pointer travelled
      // rather than the sum of the axes (which let a 3px diagonal count as a drag).
      if (dx * dx + dy * dy > DRAG_SLOP * DRAG_SLOP) pressing.moved = true
      if (pressing.moved) {
        // A drag is the reader placing the drawing, not the box choosing it.
        fittedTransform.current = false
        setOffset({ x: pressing.offsetX + dx, y: pressing.offsetY + dy })
        return
      }
    }
    const hit = pick(event.clientX, event.clientY)
    const next: HoverTarget = hit?.kind === 'card' && hit.report !== undefined
      ? { report: hit.report }
      : hit?.kind === 'frame' && hit.frame !== undefined ? { frame: hit.frame } : {}
    // The list is the other half of this hover: tell it what the pointer is on,
    // or that it is on nothing here (its own hover, if any, is not ours to erase).
    if (next.report === undefined) selection.clearHover('canvas')
    else selection.hover(next.report, 'canvas')
    // A move within the same card is not a new hover: returning the current state
    // lets React skip the render (and the overlay repaint that would follow).
    setHover((current) => (sameHover(current, next) ? current : next))
  }, [pick])

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary) return
    const pressing = drag.current
    drag.current = null
    if (pressing === null || pressing.moved) return
    // Every visible card is covered by a real button, and the button's own click is
    // the activation. Opening from this bubbling pointerup as well would reach the
    // toggling `onOpen` twice for one gesture — the double toggle ReportsView guards
    // against with `stopPropagation`. The pointer path stays for a card whose
    // button is not under the pointer (a stale box, a card clipped at the edge).
    const target = event.target
    if (target instanceof Element && target.closest('button') !== null) return
    const hit = pick(event.clientX, event.clientY)
    if (hit?.kind === 'card' && hit.report !== undefined) onOpen(hit.report)
  }, [pick, onOpen])

  const onPointerLeave = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pressing = drag.current
    // A captured drag is still the reader's gesture even when the pointer has left
    // the box: the release is delivered here anyway, so the drag is not abandoned.
    if (pressing !== null && event.currentTarget.hasPointerCapture(pressing.pointerId)) return
    drag.current = null
    selection.clearHover('canvas')
    setHover((current) => (sameHover(current, {}) ? current : {}))
  }, [])

  /** A cancelled pointer will never deliver a release, so the drag ends here. */
  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary) return
    drag.current = null
    selection.clearHover('canvas')
  }, [])

  /**
   * Double-click a frame to enter it.
   *
   * The frame's title bar is also a real button (see the accessible layer), so
   * this is the pointer reader's route and that one is the keyboard's. A press
   * that turned into a pan never produces a double-click, which is why this shares
   * the drag's slop instead of measuring its own.
   */
  const onDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const hit = pick(event.clientX, event.clientY)
    if (hit?.kind !== 'frame' || hit.frame === undefined) return
    enterFrame(hit.frame)
  }, [enterFrame, pick])

  // ---------------------------------------------------------------------------
  // The accessible layer: one real button per visible thing
  //
  // The canvas has no elements to reach, so every card gets a transparent button
  // over it and every enterable frame gets one over its title bar — the same
  // rectangle the mouse double-clicks. Culling uses the model's own rectangle test,
  // so "what is on screen" is one rule for the drawing, the buttons and the wires.
  // ---------------------------------------------------------------------------
  /** What the box can see, in drawing coordinates: the inverse of the painter's transform. */
  const visibleRect = useMemo<Rect>(() => ({
    x: -offset.x / zoom,
    y: -offset.y / zoom,
    width: size.width / zoom,
    height: size.height / zoom,
  }), [offset, zoom, size])
  const visibleCards = useMemo(() => cullByBounds(layout.cards, visibleRect), [layout, visibleRect])
  const visibleFrames = useMemo(() => cullByBounds(layout.frames, visibleRect), [layout, visibleRect])

  const percent = Math.round(zoom * 100)
  /**
   * The frame this scope is already scoped to.
   *
   * Entering it would be a no-op — its subtree *is* this drawing — so it gets no
   * "enter" button. The payload's own root is excluded for the same reason: its
   * scope is the whole tree, which is what the first crumb already is.
   */
  const scopeRoot = scope.trail[scope.trail.length - 1]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', ...(fill ? fillRoot : {}) }}>
      <div style={controls}>
        <nav aria-label={t('cardgraph.breadcrumb')} style={crumbs}>
          {scope.trail.length === 0
            ? <span aria-current="page" style={crumbCurrent}>{t('cardgraph.all')}</span>
            : <button type="button" style={crumbButton} onClick={() => { leaveTo(0) }}>{t('cardgraph.all')}</button>}
          {scope.trail.map((id, index) => {
            const current = index === scope.trail.length - 1
            const label = titles.get(id) ?? shortId(id)
            return (
              <Fragment key={id}>
                <span aria-hidden="true" style={crumbSep}>/</span>
                {current
                  ? <span aria-current="page" style={crumbCurrent} title={idHint(id)}>{label}</span>
                  : <button type="button" style={crumbButton} title={idHint(id)} onClick={() => { leaveTo(index + 1) }}>{label}</button>}
              </Fragment>
            )
          })}
        </nav>
        {scope.trail.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => { leaveTo(scope.trail.length - 1) }}>
            {t('cardgraph.up')}
          </Button>
        )}
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
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
        title={t('cardgraph.gestureHint')}
        style={{
          ...box,
          ...(fill ? fillBox : { height: `${VIEW_HEIGHT}px` }),
          cursor: drag.current?.moved === true ? 'grabbing' : hover.report === undefined ? 'grab' : 'pointer',
        }}
      >
        <canvas ref={baseRef} role="img" aria-label={t('cardgraph.summary', { frames: layout.frames.length, cards: layout.cards.length })} style={layer} />
        <canvas ref={pathRef} aria-hidden="true" style={layer} />
        {visibleFrames.map((frame) => {
          const id = frame.id
          if (id === undefined || id === payload.root || id === scopeRoot) return null
          return (
            <button
              key={`frame-${String(frame.index)}`}
              type="button"
              aria-label={t('cardgraph.enterFrame', { title: titles.get(id) ?? shortId(id) })}
              title={t('cardgraph.enterFrame', { title: idHint(id) })}
              onClick={() => { enterFrame(frame.index) }}
              style={{
                ...hitButton,
                left: `${frame.bounds.x * zoom + offset.x}px`,
                top: `${frame.bounds.y * zoom + offset.y}px`,
                width: `${frame.bounds.width * zoom}px`,
                height: `${layout.frameHeaderHeight * zoom}px`,
              }}
            />
          )
        })}
        {visibleCards.map((card) => (
          <button
            key={card.report}
            type="button"
            aria-label={`${card.report} · ${card.subject}`}
            title={idHint(card.report)}
            onClick={() => { onOpen(card.report) }}
            onFocus={() => { setHover({ report: card.report }); selection.hover(card.report, 'canvas') }}
            onBlur={() => { setHover({}); selection.clearHover('canvas') }}
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

/**
 * The breadcrumb: a real navigation landmark, because the drawing's own scope is
 * not otherwise announced to a screen reader.
 */
const crumbs: Record<string, string> = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  minWidth: '0',
  flexWrap: 'wrap',
}

const crumbButton: Record<string, string> = {
  border: '0',
  padding: '0 2px',
  background: 'transparent',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 'var(--dsw-font-xxxs-11, 11px)',
  color: 'var(--dsw-alias-label-caption)',
  textDecoration: 'underline',
}

const crumbCurrent: Record<string, string> = {
  padding: '0 2px',
  fontSize: 'var(--dsw-font-xxxs-11, 11px)',
  color: 'var(--dsw-alias-label-caption)',
  fontWeight: '600',
  maxWidth: '200px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const crumbSep: Record<string, string> = {
  fontSize: 'var(--dsw-font-xxxs-11, 11px)',
  color: 'var(--dsw-alias-label-caption)',
}

/** The transparent button layer: a frame's title bar, and every card. */
const hitButton: Record<string, string> = {
  position: 'absolute',
  padding: '0',
  border: '0',
  background: 'transparent',
  cursor: 'pointer',
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
