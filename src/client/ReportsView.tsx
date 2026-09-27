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

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Button,
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCopyOutline16,
  IconRefreshOutline16,
  Input,
  MarkdownText,
  Pill,
  StateDot,
  Tag,
  Tooltip,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReportDetail, TimelinePayload } from '../shared/wire.ts'
import {
  buildRows,
  closeOpenFence,
  displayBody,
  emptyState,
  filterRows,
  isFiltering,
  reportIds,
  sessionTitles,
  shortId,
  statusCounts,
  visibleReports,
  withSynthesizedRow,
  type ReportTimeBasis,
  type Row,
  type StatusFilter,
} from './timeline-model.ts'
import { buildTopology } from './topology-model.ts'
import { TopologyView, TopologyLegend } from './TopologyView.tsx'
import { HOP_LABEL, STATUS_DOT, STATUS_LABEL, STATUS_TONE, type ReportLedgerKey } from './locales.ts'
import { SEARCH_CLASS } from './styles.ts'

/** Translate one key, substituting `{name}` placeholders. */
export type Translate = (key: ReportLedgerKey, params?: Record<string, string | number>) => string

/** Props the registration passes through, plus the locale seat. */
export interface ReportsViewProps {
  /** The session the view is bound to. */
  sessionId?: string
  /** Injected by the registration closure from the plugin's locale namespace. */
  t: Translate
}

const TIMELINE_URL = '/api/report-ledger/timeline'
const REPORT_URL = '/api/report-ledger/report'

/**
 * How often the tab re-reads the timeline while it is on screen.
 *
 * The ledger is written by other agents in the background, so a view that loads
 * once goes stale precisely when it matters — the human is watching for a report
 * that has not been written yet. Ten seconds is quiet enough not to matter on a
 * large ledger and still fast enough to watch a collaboration happen.
 */
const POLL_INTERVAL_MS = 10_000

/** Read one endpoint and unwrap its result envelope. */
async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`HTTP ${response.status}`)
  }
  const envelope = body as { ok?: boolean; code?: string; value?: T }
  if (envelope.ok !== true) throw new Error(envelope.code ?? `HTTP ${response.status}`)
  return envelope.value as T
}

/** Substitute `{name}` placeholders. */
function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole)
}

/** Format one timestamp for a timeline row. */
function stamp(at: number | undefined): string {
  if (at === undefined || at <= 0) return ''
  return new Date(at).toLocaleString()
}

/** Dom id of one report's card, so the topology can scroll to it. */
function rowDomId(report: string): string {
  return `report-ledger-row-${report}`
}

/**
 * How long the copy control keeps its "copied" label.
 *
 * The chat view uses the same one-second acknowledgement through the same
 * `writeClipboard`, so a copy here feels like a copy there.
 */
const COPIED_HOLD_MS = 1000

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
  const { sessionId, t } = props
  const [payload, setPayload] = useState<TimelinePayload | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [timelineNonce, setTimelineNonce] = useState(0)
  // Refreshing the timeline and re-reading the open detail are two different
  // things: the background poll must move the first without touching the second,
  // or the panel would blink back to "reading the transfer path" every interval
  // while somebody is reading it. Only the explicit refresh button advances both.
  const [detailNonce, setDetailNonce] = useState(0)
  const [openReport, setOpenReport] = useState<string | undefined>(undefined)
  const [detail, setDetail] = useState<ReportDetail | undefined>(undefined)
  const [detailError, setDetailError] = useState<string | undefined>(undefined)
  const [status, setStatus] = useState<StatusFilter>(rememberedStatus)
  const [text, setText] = useState('')
  const [basis, setBasis] = useState<ReportTimeBasis>('created')
  const [copiedPath, setCopiedPath] = useState(false)
  const copyTimer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined)
  // The topology is an overview over the same data, so it is expanded by default
  // and collapses rather than being a separate mode: the list stays the place
  // where a report is read, and the graph stays above it.
  const [showTopology, setShowTopology] = useState(true)
  /** Set when the topology asks for a card, so the list can scroll to it once. */
  const scrollTo = useRef<string | undefined>(undefined)

  useEffect(() => () => {
    if (copyTimer.current !== undefined) globalThis.clearTimeout(copyTimer.current)
  }, [])

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(FILTER_KEY, JSON.stringify({ status }))
    } catch {
      // Remembering the filter is a convenience, never a requirement.
    }
  }, [status])

  useEffect(() => {
    if (sessionId === undefined || sessionId === '') {
      setError('no-session')
      return
    }
    let cancelled = false
    setError(undefined)
    getJson<TimelinePayload>(`${TIMELINE_URL}?root=${encodeURIComponent(sessionId)}`)
      .then((value) => { if (!cancelled) setPayload(value) })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { cancelled = true }
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

  useEffect(() => {
    if (openReport === undefined) return
    let cancelled = false
    setDetail(undefined)
    setDetailError(undefined)
    getJson<ReportDetail>(`${REPORT_URL}?id=${encodeURIComponent(openReport)}`)
      .then((value) => { if (!cancelled) setDetail(value) })
      .catch((cause: unknown) => { if (!cancelled) setDetailError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { cancelled = true }
  }, [openReport, detailNonce])

  const rows = useMemo<Row[]>(() => (payload === undefined ? [] : buildRows(payload, basis)), [payload, basis])
  const counts = useMemo(() => statusCounts(payload?.reports ?? []), [payload])
  const inList = useMemo(() => (payload === undefined ? new Set<string>() : reportIds(payload)), [payload])
  const shownBody = useMemo(() => displayBody(detail?.body ?? ''), [detail])
  // The text the renderer gets. A cut body can end mid-fence, and an unterminated
  // fence would turn the rest of the report into a code block — see
  // `closeOpenFence`. Only applied when the body was actually cut, so a whole
  // body always renders exactly as written.
  const bodyText = useMemo(() => {
    const text = shownBody.text.trim()
    return shownBody.truncated ? closeOpenFence(text) : text
  }, [shownBody])
  /** Strings for the prose renderer's own controls, from this plugin's dictionary. */
  const markdownLabels = useMemo(
    () => ({ code: { copyLabel: t('body.copy'), copiedLabel: t('body.copied') }, footnotes: t('body.footnotes') }),
    [t],
  )
  const filter = useMemo(() => ({ status, text }), [status, text])
  const visible = useMemo<Row[]>(() => {
    const kept = filterRows(rows, filter)
    if (openReport === undefined || detail === undefined) return kept
    // The panel is anchored to a report row, so the open report must have one —
    // see `withSynthesizedRow` for the two user paths that would otherwise leave
    // the panel with nowhere to render, and why the row is inserted in time
    // order instead of appended.
    return withSynthesizedRow(kept, detail.front, basis)
  }, [rows, filter, openReport, detail, basis])
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
   * The reports the topology plots.
   *
   * Taken from the same filtered row set the list renders, so the graph is a view
   * of the current filter rather than a second source of truth — narrowing the
   * toolbar narrows both.
   */
  const plotted = useMemo(
    () => filterRows(rows, filter).flatMap((row) => (row.kind === 'report' ? [row.front] : [])),
    [rows, filter],
  )
  const topology = useMemo(
    () => (payload === undefined ? undefined : buildTopology(payload, plotted)),
    [payload, plotted],
  )
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
   * Open a report from the topology.
   *
   * The graph does not get its own detail surface: it opens the card in the list
   * and brings it into view, which keeps one reading surface for the body and the
   * transfer path — and inherits the card's guarantees for free (a filtered-out
   * report still gets a row to render into).
   */
  const openFromTopology = useCallback((report: string) => {
    scrollTo.current = report
    setOpenReport(report)
  }, [])

  // Scroll after the row exists, not before: the card may only be synthesized by
  // the render this state change is about to cause.
  useEffect(() => {
    const target = scrollTo.current
    if (target === undefined || openReport !== target) return
    scrollTo.current = undefined
    globalThis.document?.getElementById(rowDomId(target))?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [openReport])

  /**
   * Copy the ledger path, acknowledging through the control's own label.
   *
   * Uses the shell's `writeClipboard` rather than `navigator.clipboard`, so the
   * plugin inherits whatever fallback chain the rest of the GUI relies on.
   */
  const copyPath = useCallback((path: string) => {
    void writeClipboard(path).then((ok) => {
      if (!ok) return
      setCopiedPath(true)
      if (copyTimer.current !== undefined) globalThis.clearTimeout(copyTimer.current)
      copyTimer.current = globalThis.setTimeout(() => { setCopiedPath(false) }, COPIED_HOLD_MS)
    })
  }, [])

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
    fontSize: 'var(--dsw-font-xxs-12, 12)',
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
  const time: Record<string, string | number> = {
    color: 'var(--dsw-alias-label-caption, #999)',
    fontSize: 'var(--dsw-font-xxxs-11, 11)',
    whiteSpace: 'nowrap',
  }
  /**
   * The same caption look, for content that must be allowed to WRAP.
   *
   * `time` sets `white-space: nowrap`, which is right for a timestamp and wrong
   * for anything whose length the ledger decides. A nowrap element has a
   * min-content width equal to its whole unbreakable line, so inside a `1fr`
   * grid track — or a flex item without `min-width: 0` — it grows the track past
   * its container. Recipient lists and hop notes are exactly that: unbounded
   * text, which is how the transfer path used to push the whole tab into a
   * horizontal scrollbar and cut the notes off screen.
   */
  const wrap: Record<string, string | number> = {
    ...time,
    whiteSpace: 'normal',
    minWidth: 0,
    overflowWrap: 'anywhere',
  }
  /** The muted caption colour, for the empty-state sentences. */
  const muted: Record<string, string | number> = {
    color: 'var(--dsw-alias-label-tertiary, #888)',
  }
  /** The frame the rendered body sits in — a block, not a scroll box. */
  const bodyFrame: Record<string, string | number> = {
    padding: '8px 10px',
    background: 'var(--dsw-alias-bg-base, rgba(0,0,0,0.02))',
    border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))',
    borderRadius: '4px',
  }
  /** The transcript's footer line: ledger path plus its copy control. */
  const pathRow: Record<string, string | number> = {
    ...wrap,
    marginTop: '6px',
    display: 'flex',
    alignItems: 'baseline',
    gap: '6px',
  }
  /** The topology's frame: an overview that sits above the list, not instead of it. */
  const topoSection: Record<string, string | number> = {
    marginBottom: '12px',
    border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))',
    borderRadius: '6px',
    background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.02))',
    overflow: 'hidden',
  }
  const topoHead: Record<string, string | number> = {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '6px 10px',
    borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))',
  }

  if (error !== undefined) {
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
      <div style={head}>
        <strong>{t('view.tab')}</strong>
        <span style={summary}>
          {filtering
            ? t('filter.showing', { visible: visibleReportCount, total: counts.all })
            : t('view.summary', { sessions: payload.sessions.length, reports: payload.reports.length })}
        </span>
        <Button variant="outline" icon={<IconRefreshOutline16 />} onClick={refresh}>{t('view.refresh')}</Button>
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

      {topology !== undefined && topology.rows > 0 ? (
        <section style={topoSection}>
          <div style={topoHead}>
            <strong>{t('topology.title')}</strong>
            <TopologyLegend t={t} />
            <span style={summary}>
              {t('topology.summary', { lanes: topology.lanes.length, reports: topology.rows })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              icon={showTopology ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
              onClick={() => { setShowTopology((value) => !value) }}
            >
              {showTopology ? t('topology.hide') : t('topology.show')}
            </Button>
          </div>
          {showTopology ? (
            <TopologyView
              layout={topology}
              reports={plotted}
              t={t}
              idHint={idHint}
              openReport={openReport}
              onOpen={openFromTopology}
            />
          ) : null}
        </section>
      ) : null}

      {visible.map((row, index) => {
        const pad = 8 + row.depth * 18
        if (row.kind === 'session') {
          return (
            <div key={`s-${row.id}-${index}`} style={{ display: 'flex', gap: '8px', padding: `4px 0 4px ${pad}px`, alignItems: 'baseline' }}>
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
                <Tooltip label={row.id} side="left" delayMs={400}>
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
        const toggleLabel = fill(expanded ? t('row.collapse') : t('row.expand'), { report: front.report })
        return (
          <div key={`r-${front.report}`} id={rowDomId(front.report)} style={{ paddingLeft: `${pad}px` }}>
            {/* The row is a plain container, not a `role="button"`.
                It used to be one, and it contained a real <button> (the task
                chip) — nested interactive content. Worse, a role="button" takes
                its accessible name from its whole subtree, so a screen reader
                read out a line of session uuids and then the task label twice,
                once inside the row's own name.
                The disclosure now lives on the leading control: the shell's own
                Button, whose name says what it does and whose `aria-controls`
                points at the panel it opens. Clicking anywhere on the row stays
                as the pointer convenience, which is why the container keeps a
                click handler with no role: the keyboard path is the button, and
                the pointer path is the row. */}
            <div
              onClick={() => { setOpenReport(expanded ? undefined : front.report) }}
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
              }}
            >
              <Button
                variant="ghost"
                size="sm"
                icon={expanded ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
                aria-expanded={expanded}
                aria-controls={panelId}
                aria-label={toggleLabel}
                title={toggleLabel}
                onClick={(event) => {
                  // The row's own click handler is the same action; without this
                  // the one click would toggle twice and appear to do nothing.
                  event.stopPropagation()
                  setOpenReport(expanded ? undefined : front.report)
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
              <span style={time}>{stamp(front.updated)}</span>
            </div>

            {expanded ? (
              <div id={panelId} style={{
                margin: '4px 0 10px 24px',
                padding: '10px 12px',
                borderRadius: '6px',
                background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.03))',
                border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))',
              }}>
                {detailError !== undefined ? <div style={{ color: 'var(--dsw-alias-state-error-label, #b00)' }}>{t('view.error', { code: detailError })}</div> : null}
                {detail === undefined && detailError === undefined ? <div style={time}>{t('view.detail.loading')}</div> : null}
                {detail === undefined ? null : (
                  <>
                    <div style={{ marginBottom: '6px' }}><strong>{t('view.detail.route')}</strong></div>
                    {detail.hops.length === 0 ? <div style={time}>{t('view.detail.routeEmpty')}</div> : (
                      <div style={{ display: 'grid', gridTemplateColumns: 'auto auto auto 1fr', gap: '2px 10px', marginBottom: '8px' }}>
                        {detail.hops.map((hop, hopIndex) => (
                          <Fragment key={`h-${hopIndex}`}>
                            <span style={time}>{stamp(hop.at)}</span>
                            <span><strong>{t(HOP_LABEL[hop.action])}</strong></span>
                            <span style={wrap}><Tooltip label={idHint(hop.actor)} side="bottom" delayMs={400}><span>{hop.actor}</span></Tooltip></span>
                            <span style={wrap}>{hop.to.length === 0 ? (hop.note ?? '') : `→ ${hop.to.join(', ')}${hop.note === undefined ? '' : ` (${hop.note})`}`}</span>
                          </Fragment>
                        ))}
                      </div>
                    )}
                    {/* "Still owed" is a state, so it gets the shell's state dot
                        instead of a colour mixed by hand. */}
                    {detail.pending.length === 0 ? null : (
                      <div style={{ ...wrap, display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                        <StateDot state="warning" size={8} />
                        <span>{fill(t('view.detail.pending'), { targets: detail.pending.join(', ') })}</span>
                      </div>
                    )}

                    {(() => {
                      const parent = detail.front.parent
                      const children = detail.front.children
                      if (parent === undefined && children.length === 0) return null
                      const link = (target: string): ReactElement => (
                        <span key={target} style={{ marginRight: '6px' }}>
                          <Tooltip label={fill(t('detail.openLinked'), { report: target })} side="bottom" delayMs={400}>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => { setOpenReport(target) }}
                            >
                              {target}
                            </Button>
                          </Tooltip>
                        </span>
                      )
                      return (
                        <div style={{ marginBottom: '8px' }}>
                          <strong>{t('detail.thread')}</strong>
                          {parent === undefined ? null : (
                            <div style={{ marginTop: '2px' }}>
                              <span style={time}>{`${t('detail.parent')}: `}</span>{link(parent)}
                            </div>
                          )}
                          {children.length === 0 ? null : (
                            <div style={{ marginTop: '2px' }}>
                              <span style={time}>{`${t('detail.children')}: `}</span>{children.map(link)}
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* Kept OUT of the thread block above: that block returns early
                        when a report has no thread links, which is the common case
                        for exactly the reports this notice is about. */}
                    {inList.has(detail.front.report) ? null : (
                      <div style={{ ...wrap, marginBottom: '8px' }}>
                        {fill(t('detail.outside'), { report: detail.front.report })}
                        {' '}
                        <Button variant="outline" onClick={() => { setOpenReport(undefined) }}>
                          {t('detail.backToList')}
                        </Button>
                      </div>
                    )}
                    {inList.has(detail.front.report) && !filteredReportIds.has(detail.front.report) ? (
                      <div style={{ ...wrap, marginBottom: '8px' }}>
                        {fill(t('detail.filteredOut'), { report: detail.front.report })}
                      </div>
                    ) : null}

                    <div style={{ margin: '8px 0 4px' }}><strong>{t('view.detail.body')}</strong></div>
                    {/* Rendered with the shell's own prose renderer — the same one
                        the Chat and Trajectory views use — so a report body reads
                        like everything else in the GUI instead of like a raw file.

                        No inner scroll box on purpose. The text is already bounded
                        by the same limit `report_read` gives the model, so the panel
                        grows by at most a few dozen lines; a nested scroller inside
                        the timeline's scroller would only steal the wheel. */}
                    <div style={bodyFrame}>
                      <MarkdownText text={bodyText} labels={markdownLabels} />
                    </div>
                    {shownBody.truncated ? (
                      <div style={{ ...wrap, marginTop: '4px' }}>
                        {fill(t('detail.bodyTruncated'), { chars: shownBody.text.trim().length })}
                      </div>
                    ) : null}
                    {/* The ledger path is the longest string on the panel and the
                        only one that carries no spaces to break at, so it wraps
                        mid-segment on purpose — and it now has a copy control,
                        because "see the file" is only useful if you can get there.
                        The copy goes through the shell's own `writeClipboard`. */}
                    <div style={pathRow}>
                      <StateDot state="idle" size={6} />
                      <span style={{ wordBreak: 'break-all' }}>{t('view.detail.path')}: {detail.path}</span>
                      <Tooltip label={copiedPath ? t('body.copied') : t('view.copyPath')} side="bottom" delayMs={300}>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={copiedPath ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
                          aria-label={copiedPath ? t('body.copied') : t('view.copyPath')}
                          onClick={() => { copyPath(detail.path) }}
                        />
                      </Tooltip>
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
