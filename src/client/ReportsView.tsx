/**
 * The report timeline view — the `conversation.view` tab this plugin registers.
 *
 * It renders one top-to-bottom timeline of the collaboration: the session
 * subtree as it branched, interleaved with the reports those sessions produced
 * or were copied on. Rows carry only the digest, so a long-running tree stays
 * scannable; clicking a report opens its transfer path and body on demand.
 *
 * Data comes from this plugin's own read-only endpoint rather than a generated
 * remote: the host assembles the subtree and filters the ledger to the sessions
 * in it, which the browser cannot do on its own because a report's transfer path
 * is a host-side file, not session state.
 *
 * A blank session never reaches this component — the conversation slot is
 * omitted entirely in that state.
 *
 * @module dsh-report-ledger/client/ReportsView
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import {
  Button,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconRefreshOutlineRegular,
  Input,
  Pill,
  StateDot,
  Tag,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReportDetail, TimelinePayload, WorktreeLane } from '../shared/wire.ts'
import {
  buildRows,
  emptyState,
  filterRows,
  isFiltering,
  laneIndex,
  LEASE_TONE,
  reportIds,
  sessionDepths,
  sessionTitles,
  shortId,
  statusCounts,
  visibleReports,
  withSynthesizedRow,
  worktreeLabel,
  type ReportTimeBasis,
  type Row,
  type StatusFilter,
} from './timeline-model.ts'
import { ReportDetailView } from './ReportDetailView.tsx'
import type { PathOpener } from './path-opener.ts'
import { selection } from './selection-bridge.ts'
import { getJson, POLL_INTERVAL_MS, TIMELINE_URL, useReportDetail } from './timeline-source.ts'
import { fill, stamp } from './format.ts'
import { HOP_LABEL, LEASE_HINT, STATUS_LABEL, STATUS_TONE, type ReportLedgerKey } from './locales.ts'
import { SEARCH_CLASS } from './styles.ts'

/** Translate one key, substituting `{name}` placeholders. */
export type Translate = (key: ReportLedgerKey, params?: Record<string, string | number>) => string

/** Props the registration passes through, plus the locale seat. */
export interface ReportsViewProps {
  /** The session the view is bound to. */
  sessionId?: string
  /** Injected by the registration closure from the plugin's locale namespace. */
  t: Translate
  /**
   * The host desktop's file verbs, resolved lazily by the plugin body.
   *
   * Passed in rather than imported here: it comes from the client context, which
   * this view does not hold. Absent in a deployment without the Remote, and the
   * ledger path row then shows only its copy control.
   */
  opener?: () => PathOpener | undefined
}

/** Storage key for the remembered status filter. */
const FILTER_KEY = 'dsh.reportLedger.filter.v1'

/** Read the remembered status filter, tolerating absent or damaged storage. */
function rememberedStatus(): StatusFilter {
  try {
    const raw = globalThis.localStorage?.getItem(FILTER_KEY)
    if (typeof raw === 'string') {
      const parsed = JSON.parse(raw) as { status?: unknown }
      if (parsed.status === 'open' || parsed.status === 'acked' || parsed.status === 'closed') return parsed.status
    }
  } catch {
    // A restricted or full storage just means the filter is not remembered.
  }
  return 'all'
}

/**
 * Render the report timeline.
 * @param props - the session binding and the locale seat.
 * @returns the tab content.
 */
export function ReportsView(props: ReportsViewProps): ReactElement {
  const { sessionId, t, opener } = props
  const [payload, setPayload] = useState<TimelinePayload | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [timelineNonce, setTimelineNonce] = useState(0)
  // Refreshing the timeline and re-reading the open detail are two different
  // things: the background poll must move the first without touching the second,
  // or the panel would blink back to "reading the transfer path" every interval
  // while somebody is reading it. Only the explicit refresh button advances both.
  const [detailNonce, setDetailNonce] = useState(0)
  const [openReport, setOpenReport] = useState<string | undefined>(undefined)
  // A thread link points at a row that may be filtered out or outside this tree,
  // so the row it wants may not exist yet. The request is remembered until that
  // row mounts; see the scroll effect below.
  const [scrollTarget, setScrollTarget] = useState<string | undefined>(undefined)
  /** Row containers, so a thread jump can bring its target on screen. */
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  /**
   * What the other surface (the right column's canvas) is pointing at, and the
   * report it asked to open.
   *
   * The two surfaces are separate React trees in one bundle, so the bridge is the
   * only channel between them; this side owns the open report — the canvas only
   * requests it — and follows the hover in both directions.
   */
  const bridged = useSyncExternalStore(selection.subscribe, selection.get)
  const [status, setStatus] = useState<StatusFilter>(rememberedStatus)
  const [text, setText] = useState('')
  const [basis, setBasis] = useState<ReportTimeBasis>('created')
  // The open report's detail, read through the same hook the right column's canvas
  // tab uses — one read path, so the two surfaces cannot disagree about a report.
  const { detail, error: detailError } = useReportDetail(openReport, detailNonce)
  // Belt and braces on top of the hook's own report keying: everything below that
  // renders the panel, or synthesizes a row for it, uses only a detail that was
  // read for the report currently open.
  const shown = detail !== undefined && detail.front.report === openReport ? detail : undefined

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(FILTER_KEY, JSON.stringify({ status }))
    } catch {
      // Remembering the filter is a convenience, never a requirement.
    }
  }, [status])

  // A different session is a different tree, and everything above was read for
  // the old one: the payload, the failure, the open report and the pending jump.
  // Resetting them together is what keeps a switched-to session from rendering
  // the previous session's collaboration (or leaving its report open in it).
  useEffect(() => {
    setPayload(undefined)
    setError(undefined)
    setOpenReport(undefined)
    setScrollTarget(undefined)
  }, [sessionId])

  // The canvas's click arrives here: open the row it named, and let the scroll
  // effect below bring it on screen once it has a row. The value carries the
  // session it was published for, so a selection left behind by another session
  // is inert rather than opening a stranger's report in this tree.
  useEffect(() => {
    if (sessionId === undefined || sessionId === '') return
    if (bridged.session !== sessionId) return
    if (bridged.report === openReport) return
    setOpenReport(bridged.report)
    if (bridged.report !== undefined) setScrollTarget(bridged.report)
  }, [bridged.report, bridged.session, openReport, sessionId])

  useEffect(() => {
    if (sessionId === undefined || sessionId === '') {
      setError('no-session')
      return undefined
    }
    let cancelled = false
    const controller = new AbortController()
    getJson<TimelinePayload>(`${TIMELINE_URL}?root=${encodeURIComponent(sessionId)}`, controller.signal)
      .then((value) => { if (!cancelled) { setPayload(value); setError(undefined) } })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
    // Note the asymmetry: a new read does NOT clear the previous failure. The
    // banner below stays until a read actually succeeds, so a failing host is a
    // steady, readable statement instead of a strobe of "failed / stale / failed".
    return () => { cancelled = true; controller.abort() }
  }, [sessionId, timelineNonce])

  // Keep an open tab honest. Polling stops while the page is hidden, and a
  // returning page catches up immediately, so a background tab costs nothing and
  // a foreground one is never behind.
  useEffect(() => {
    if (sessionId === undefined || sessionId === '') return undefined
    const tick = (): void => {
      if (globalThis.document?.visibilityState === 'hidden') return
      setTimelineNonce((value) => value + 1)
    }
    const timer = globalThis.setInterval(tick, POLL_INTERVAL_MS)
    const onVisibility = (): void => { if (globalThis.document?.visibilityState !== 'hidden') tick() }
    globalThis.document?.addEventListener('visibilitychange', onVisibility)
    return () => {
      globalThis.clearInterval(timer)
      globalThis.document?.removeEventListener('visibilitychange', onVisibility)
    }
  }, [sessionId])

  const rows = useMemo<Row[]>(() => (payload === undefined ? [] : buildRows(payload, basis)), [payload, basis])
  const counts = useMemo(() => statusCounts(payload?.reports ?? []), [payload])
  const inList = useMemo(() => (payload === undefined ? new Set<string>() : reportIds(payload)), [payload])
  // The lease state is not on the digest: liveness comes from the hop stream, and
  // the host derives it once so the browser never needs a second copy of the rule.
  const lanes = useMemo(() => (payload === undefined ? new Map<string, WorktreeLane>() : laneIndex(payload)), [payload])
  // The author's depth, for the row a synthesized report needs. Taken from the
  // model so the payload's depth rule has one implementation.
  const depths = useMemo(() => (payload === undefined ? new Map<string, number>() : sessionDepths(payload)), [payload])
  const filter = useMemo(() => ({ status, text }), [status, text])
  const visible = useMemo<Row[]>(() => {
    const kept = filterRows(rows, filter)
    if (openReport === undefined || shown === undefined) return kept
    // The panel is anchored to a report row, so the open report must have one —
    // see `withSynthesizedRow` for the two user paths that would otherwise leave
    // the panel with nowhere to render, and why the row is inserted in time
    // order instead of appended. The depth is the author's, so a filtered-out
    // report does not jump to the root of the tree it is rendered under.
    return withSynthesizedRow(kept, shown.front, basis, depths.get(shown.front.from) ?? 0)
  }, [rows, filter, openReport, shown, basis, depths])
  // A thread link can point at a row that does not exist yet: a report outside
  // this tree, or one the current filter hides, only gets its row once its detail
  // read arrives. So the request is not a one-shot — it waits for the row to
  // mount, and is abandoned the moment the open report moves away from it.
  useEffect(() => {
    if (scrollTarget === undefined) return
    if (openReport !== scrollTarget) {
      setScrollTarget(undefined)
      return
    }
    const element = rowRefs.current.get(scrollTarget)
    if (element === undefined) return
    setScrollTarget(undefined)
    // `scrollIntoView` is the one call here that a non-browser DOM may not have;
    // skipping it only costs the jump, never the expansion that already happened.
    if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'nearest' })
  }, [scrollTarget, openReport, visible])
  // Reports surviving the FILTER, as opposed to `visible`, which also carries a
  // synthesized row for the open report. Keeping the two apart is what lets the
  // panel say which of the two reasons applies: outside this tree, or hidden by
  // the current filter. Claiming "another line" for a filtered report would be
  // simply wrong.
  const filteredReportIds = useMemo(() => {
    const ids = new Set<string>()
    for (const row of filterRows(rows, filter)) if (row.kind === 'report') ids.add(row.front.report)
    return ids
  }, [rows, filter])
  const filtering = isFiltering(filter)
  // Counted from the unfiltered row set so a synthesized out-of-tree row cannot
  // inflate the summary.
  const visibleReportCount = useMemo(() => visibleReports(rows, filter), [rows, filter])
  // Which of the two "nothing to show" sentences applies. Decided in the pure
  // model rather than inline here, so `emptyState`'s tests pin it.
  const empty = useMemo(
    () => (payload === undefined ? 'none' : emptyState(payload, rows, filter)),
    [payload, rows, filter],
  )
  // Session titles, for the hover hint on a shortened id. Deliberately NOT the
  // row label: a title is the session's first prompt, so it is unbounded, while
  // a row has to stay one scannable line.
  const titles = useMemo(
    () => (payload === undefined ? new Map<string, string>() : sessionTitles(payload)),
    [payload],
  )
  const idHint = useCallback((id: string): string => {
    const title = titles.get(id)
    return title === undefined ? id : `${title} · ${id}`
  }, [titles])

  /**
   * One session id the way a dense row shows it: shortened, with the full value
   * and the session title on hover. The hover is not decoration — it is where
   * the human name lives, because titles are unbounded and a row is not.
   */
  const idRef = (id: string): ReactElement => (
    <Tooltip label={idHint(id)} side="bottom" delayMs={400}>
      <span>{shortId(id)}</span>
    </Tooltip>
  )

  const refresh = useCallback(() => {
    setTimelineNonce((value) => value + 1)
    setDetailNonce((value) => value + 1)
  }, [])

  /**
   * Open a report that was reached through a link rather than its own row.
   *
   * A row click expands in place — the row is already under the pointer and needs
   * no help. A thread link is different: its target can be off screen, or have no
   * row at all yet (outside this tree, or hidden by the filter), so the request to
   * bring it on screen is recorded here and satisfied by the effect above when
   * the row finally mounts.
   */
  const openLinked = useCallback((report: string | undefined) => {
    setOpenReport(report)
    setScrollTarget(report)
    selection.open(report, sessionId)
  }, [sessionId])

  /**
   * Open or close one row, publishing the choice so the canvas can follow it.
   *
   * The row click and the disclosure button are the same act, so both go through
   * here: one owner of "what is open", one write to the bridge, no chance of the
   * two surfaces disagreeing about it.
   */
  const toggleReport = useCallback((report: string) => {
    const next = openReport === report ? undefined : report
    setOpenReport(next)
    selection.open(next, sessionId)
  }, [openReport, sessionId])

  const shell: Record<string, string | number> = {
    padding: '16px 20px',
    overflowY: 'auto',
    height: '100%',
    font: 'var(--dsw-font-xs-13, 13px/1.6 system-ui, sans-serif)',
    color: 'var(--dsw-alias-label-primary, inherit)',
  }
  const head: Record<string, string | number> = {
    display: 'flex',
    alignItems: 'baseline',
    gap: '12px',
    marginBottom: '12px',
  }
  const summary: Record<string, string | number> = {
    color: 'var(--dsw-alias-label-tertiary, #888)',
    fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)',
    flex: '1 1 auto',
  }
  /**
   * The toolbar's search seat.
   *
   * `Input` renders its own wrapper around the field, so the flex sizing lives
   * on this outer box rather than on the control itself.
   */
  const searchBox: Record<string, string | number> = {
    flex: '1 1 200px',
    minWidth: '140px',
    display: 'flex',
  }
  const tools: Record<string, string | number> = {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '6px',
    marginBottom: '10px',
  }
  /** Chips sit next to a label; the shell's tags carry no spacing of their own. */
  const tagRow: Record<string, string | number> = {
    display: 'inline-flex',
    gap: '4px',
    marginRight: '6px',
    verticalAlign: 'baseline',
  }
  /** Keeps the state dot on the row's text baseline. */
  const dotCell: Record<string, string | number> = {
    display: 'inline-flex',
    alignItems: 'center',
  }
  /** The caption look for a timestamp; the digest's meta line reuses its colour. */
  const time: Record<string, string | number> = {
    color: 'var(--dsw-alias-label-caption, #999)',
    fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)',
    whiteSpace: 'nowrap',
  }
  /** The muted caption colour, for the empty-state sentences. */
  const muted: Record<string, string | number> = {
    color: 'var(--dsw-alias-label-tertiary, #888)',
  }
  /**
   * The strip that reports a failed re-read WITHOUT replacing the list.
   *
   * A warning, not an error: the ledger on screen is still the last thing that was
   * successfully read, and the poll keeps trying. Colouring it like a page failure
   * would teach the reader to stop believing the colour. The token is the shell's
   * warn label rather than a mixed colour, so it follows the theme.
   */
  const notice: Record<string, string | number> = {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginBottom: '10px',
    color: 'var(--dsw-alias-state-warn-label, #a60)',
  }

  // The full-page failure is only for "there is nothing to show yet". Once a
  // payload has arrived, a failed re-read is a fact ABOUT the list on screen — not
  // a reason to replace it, drop the open report and lose the reader's position.
  if (payload === undefined && error !== undefined) {
    return (
      <div style={shell}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <StateDot state="error" size={8} />
          <span>{t('view.error', { code: error })}</span>
        </div>
        <div style={{ marginTop: '8px' }}>
          <Button variant="outline" onClick={refresh}>{t('view.retry')}</Button>
        </div>
      </div>
    )
  }

  if (payload === undefined) {
    return <div style={shell}>{t('view.loading')}</div>
  }

  const statusLabel: Record<StatusFilter, ReportLedgerKey> = {
    all: 'filter.all',
    open: 'filter.open',
    acked: 'filter.acked',
    closed: 'filter.closed',
  }
  const statusCount: Record<StatusFilter, number> = {
    all: counts.all,
    open: counts.open,
    acked: counts.acked,
    closed: counts.closed,
  }
  const chips: StatusFilter[] = ['all', 'open', 'acked', 'closed']

  return (
    <div style={shell}>
      {/* Kept above the toolbar on purpose: the header still shows when the last
          read failed, so the failure has to be readable next to it rather than
          instead of the whole tab. */}
      {error === undefined ? null : (
        <div style={notice}>
          <StateDot state="warning" size={8} />
          <span style={{ flex: '1 1 auto' }}>{t('view.error', { code: error })}</span>
          <Button variant="outline" onClick={refresh}>{t('view.retry')}</Button>
        </div>
      )}
      <div style={head}>
        <strong>{t('view.tab')}</strong>
        <span style={summary}>
          {filtering
            ? t('filter.showing', { visible: visibleReportCount, total: counts.all })
            : t('view.summary', { sessions: payload.sessions.length, reports: payload.reports.length })}
        </span>
        <Button variant="outline" icon={<IconRefreshOutlineRegular size={16} />} onClick={refresh}>{t('view.refresh')}</Button>
      </div>

      <div style={tools} title={t('filter.hint')}>
        {chips.map((candidate) => (
          <Pill
            key={candidate}
            active={status === candidate}
            aria-pressed={status === candidate}
            onClick={() => { setStatus(candidate) }}
          >
            {`${t(statusLabel[candidate])} ${statusCount[candidate]}`}
          </Pill>
        ))}
        <div style={searchBox}>
          <Input
            type="search"
            className={SEARCH_CLASS}
            value={text}
            placeholder={t('filter.search')}
            aria-label={t('filter.search')}
            onChange={(event) => { setText(event.target.value) }}
          />
        </div>
        {filtering ? (
          <Button variant="outline" onClick={() => { setStatus('all'); setText('') }}>{t('filter.clear')}</Button>
        ) : null}
        <Tooltip label={t('basis.hint')} side="bottom" delayMs={400}>
          <Button variant="outline" onClick={() => { setBasis(basis === 'created' ? 'updated' : 'created') }}>
            {t(basis === 'created' ? 'basis.created' : 'basis.updated')}
          </Button>
        </Tooltip>
      </div>

      {empty === 'no-reports' ? <div style={muted}>{t('view.empty')}</div> : null}
      {empty === 'filtered-out' ? <div style={muted}>{t('filter.none')}</div> : null}

      {visible.map((row) => {
        const pad = 8 + row.depth * 18
        if (row.kind === 'session') {
          return (
            <div key={`s-${row.id}`} style={{ display: 'flex', gap: '8px', padding: `4px 0 4px ${pad}px`, alignItems: 'baseline' }}>
              {/* The shell's state dot, not a text bullet: `ongoing` is the
                  animated one, so a resident session reads as alive at a glance. */}
              <Tooltip label={idHint(row.id)} side="bottom" delayMs={400}>
                <span style={dotCell}><StateDot state={row.live ? 'ongoing' : 'idle'} size={8} /></span>
              </Tooltip>
              <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                {row.delegated || row.live ? (
                  <span style={tagRow}>
                    {row.delegated ? <Tag tone="info">{t('view.delegated')}</Tag> : null}
                    {row.live ? <Tag tone="success">{t('view.live')}</Tag> : null}
                  </span>
                ) : null}
                {row.title ?? shortId(row.id)}
              </span>
              {/* The session's own short id, so a digest row's `from=`/`to=` can be
                  read back to the tree it belongs to. Titles stay the prominent
                  label — this is the cross-reference, not the identity. */}
              {row.title === undefined ? null : (
                <Tooltip label={row.id} side="right" delayMs={400}>
                  <span style={time}>{shortId(row.id)}</span>
                </Tooltip>
              )}
              <span style={time}>{stamp(row.at)}</span>
            </div>
          )
        }
        const front = row.front
        const expanded = openReport === front.report
        const panelId = `report-ledger-panel-${front.report}`
        // The label comes off the binding, so a report opened by id and rendered
        // before it is in the payload still names its checkout; only the lease
        // state needs the lane, and a missing lane degrades to `none`.
        const wtLabel = worktreeLabel(front.worktree)
        const wtLane = lanes.get(front.report)
        const toggleLabel = fill(expanded ? t('row.collapse') : t('row.expand'), { report: front.report })
        return (
          <div
            key={`r-${front.report}`}
            // The row container (row + its panel) is what a thread jump scrolls to:
            // bringing the row on screen is what makes the expansion visible.
            ref={(element) => {
              if (element === null) rowRefs.current.delete(front.report)
              else rowRefs.current.set(front.report, element)
            }}
            style={{ paddingLeft: `${pad}px` }}
          >
            {/* The row is a plain container, not a `role="button"`.
                It used to be one, and it contained a real <button> (the task
                chip) — nested interactive content. Worse, a role="button" takes
                its accessible name from its whole subtree, so a screen reader
                read out a line of session uuids and then the task label twice,
                once inside the row's own name.
                The disclosure now lives on the leading control: the shell's own
                Button, whose name says what it does and which points at the panel
                it opens for as long as that panel exists. Clicking anywhere on the
                row stays as the pointer convenience, which is why the container
                keeps a click handler with no role: the keyboard path is the
                button, and the pointer path is the row. */}
            <div
              onClick={() => { toggleReport(front.report) }}
              onPointerEnter={() => { selection.hover(front.report, 'list') }}
              onPointerLeave={() => { selection.clearHover('list') }}
              style={{
                display: 'flex',
                gap: '8px',
                alignItems: 'baseline',
                padding: '5px 8px',
                margin: '2px 0',
                borderRadius: '6px',
                cursor: 'pointer',
                background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.02))',
                border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))',
                // The canvas's hover lands here: same pointer, other surface. Both
                // sides use the same light blue — the row a tint plus a blue edge,
                // the canvas a blue ring and path — so one hover reads as one state.
                // The transition matches the canvas's reveal so the two surfaces
                // light up together instead of one snapping ahead of the other.
                transition: 'background 160ms ease-out, box-shadow 160ms ease-out',
                ...(bridged.hover === front.report
                  ? {
                      background: 'var(--dsw-alias-state-business-tertiary, #e4edfd)',
                      boxShadow: 'inset 0 0 0 1px var(--dsw-alias-button-info-hover, #7aaaff)',
                    }
                  : {}),
              }}
            >
              <Button
                variant="ghost"
                size="sm"
                icon={expanded ? <IconChevronDownOutlineRegular size={14} /> : <IconChevronRightOutlineRegular size={14} />}
                aria-expanded={expanded}
                // Only a mounted panel has an id to point at; a collapsed
                // disclosure claiming `aria-controls` names an absent element and
                // gives assistive tech a relationship that does not exist.
                {...(expanded ? { 'aria-controls': panelId } : {})}
                aria-label={toggleLabel}
                title={toggleLabel}
                onClick={(event) => {
                  // The row's own click handler is the same action; without this
                  // the one click would toggle twice and appear to do nothing.
                  event.stopPropagation()
                  toggleReport(front.report)
                }}
              />
              <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                <span style={tagRow}><Tag tone={STATUS_TONE[front.status]}>{t(STATUS_LABEL[front.status])}</Tag></span>
                <strong>{front.report}</strong> {front.subject}
                {/* The task chip is a filter shortcut, not decoration: clicking it
                    reuses the search box, so grouping by collaboration needs no
                    state of its own. It stops the click from also toggling the
                    detail panel, and it CLEARS the status filter — its own label
                    promises "show only this task", which stops being true the
                    moment a status chip is also narrowing the list. */}
                {front.task === undefined ? null : (
                  <Pill
                    title={fill(t('row.filterByTask'), { task: front.task })}
                    onClick={(event) => {
                      event.stopPropagation()
                      setStatus('all')
                      setText(front.task as string)
                    }}
                  >
                    {front.task}
                  </Pill>
                )}
                {/* The checkout chip follows the task chip exactly, for the same
                    reason: it reuses the search box instead of inventing a second
                    filter, and it clears the status filter because its own label
                    promises "show only this checkout". Its tone is the lease
                    state, which is the one thing the digest cannot carry — a
                    checkout nobody holds and one being worked in look identical
                    from the binding alone. */}
                {/* The chip's handler stays on the inner span: the shell's `Tag`
                    takes tone, className and children only and renders a span, so
                    there is no `onClick` to hoist onto it. Promoting the chip to a
                    `Pill` would be the other way — and it would turn a read-only
                    status label into a second button in the row, which is a product
                    change rather than a fix. The cost is the tag's own padding not
                    being part of the click target. */}
                {wtLabel === undefined ? null : (
                  <Tag tone={LEASE_TONE[wtLane?.state ?? 'none']}>
                    <span
                      title={`${fill(t('row.filterByWorktree'), { worktree: wtLabel })} — ${t(LEASE_HINT[wtLane?.state ?? 'none'])}`}
                      style={{ cursor: 'pointer' }}
                      onClick={(event) => {
                        event.stopPropagation()
                        setStatus('all')
                        setText(wtLabel)
                      }}
                    >
                      {wtLabel}
                    </span>
                  </Tag>
                )}
                {/* One line per report is the point of the digest, so the meta
                    line is clipped rather than wrapped: a single over-connected
                    report must not turn every row into a paragraph. `min-width: 0`
                    on the parent is what lets the ellipsis happen at all — without
                    it the flex item cannot shrink below its content, and the row
                    pushes the whole tab sideways instead. */}
                <div style={{ ...time, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {`from=`}{idRef(front.from)}
                  {front.to.length > 0 ? (
                    <>
                      {' → '}
                      {front.to.map((id, index) => (
                        <Fragment key={id}>{index > 0 ? ', ' : ''}{idRef(id)}</Fragment>
                      ))}
                    </>
                  ) : null}
                  {front.cc.length > 0 ? (
                    <>
                      {' cc '}
                      {front.cc.map((id, index) => (
                        <Fragment key={id}>{index > 0 ? ', ' : ''}{idRef(id)}</Fragment>
                      ))}
                    </>
                  ) : null}
                  {` · ${fill(t('row.hops'), { count: front.hops })}`}
                  {front.authors.length > 1 ? ` · ${fill(t('row.authors'), { count: front.authors.length })}` : ''}
                  {/* The last hop's action is ledger vocabulary, so it is named
                      with the same word the transfer path uses below. */}
                  {front.last === undefined ? '' : ` · ${t('row.last')} ${t(HOP_LABEL[front.last.action])}`}
                </div>
              </span>
              {/* The row prints the value it was SORTED by, not a fixed field: a
                  list ordered by creation must not read as ordered by last
                  activity, and the basis toggle moves both at once. */}
              <span style={time}>{stamp(row.at)}</span>
            </div>

            {expanded ? (
              <ReportDetailView
                report={front.report}
                detail={shown}
                error={detailError}
                t={t}
                idHint={idHint}
                id={panelId}
                variant="row"
                onOpenReport={openLinked}
                inList={inList.has(front.report)}
                visibleInFilter={filteredReportIds.has(front.report)}
                {...(opener === undefined ? {} : { opener })}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
