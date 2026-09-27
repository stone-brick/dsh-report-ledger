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

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
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
import { HOP_LABEL, STATUS_LABEL, type ReportLedgerKey } from './locales.ts'

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

/** Colour a status chip from the theme's state tokens. */
function statusStyle(status: string): Record<string, string> {
  if (status === 'acked') {
    return {
      color: 'var(--dsw-alias-state-success-label, #1a7f37)',
      background: 'var(--dsw-alias-state-success-bg, rgba(26,127,55,0.10))',
    }
  }
  if (status === 'closed') {
    return {
      color: 'var(--dsw-alias-label-tertiary, #888)',
      background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.04))',
    }
  }
  return {
    color: 'var(--dsw-alias-state-warn-label, #9a6700)',
    background: 'var(--dsw-alias-state-warn-bg, rgba(154,103,0,0.10))',
  }
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
   * One session id the way a dense row shows it: shortened, with the full value
   * and the session title on hover. The hover is not decoration — it is where
   * the human name lives, because titles are unbounded and a row is not.
   */
  const idRef = (id: string): ReactElement => <span title={idHint(id)}>{shortId(id)}</span>

  const refresh = useCallback(() => {
    setTimelineNonce((value) => value + 1)
    setDetailNonce((value) => value + 1)
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
  const button: Record<string, string | number> = {
    font: 'inherit',
    color: 'var(--dsw-alias-label-secondary, inherit)',
    background: 'var(--dsw-alias-bg-layer-2, transparent)',
    border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))',
    borderRadius: '6px',
    padding: '3px 10px',
    cursor: 'pointer',
  }
  const chip = (extra: Record<string, string>): Record<string, string | number> => ({
    display: 'inline-block',
    padding: '0 6px',
    borderRadius: '999px',
    fontSize: 'var(--dsw-font-xxxs-11, 11)',
    lineHeight: '17px',
    marginRight: '6px',
    ...extra,
  })
  const tools: Record<string, string | number> = {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '6px',
    marginBottom: '10px',
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
  /** The disclosure triangle: a real button that has to look like a glyph. */
  const arrow: Record<string, string | number> = {
    font: 'inherit',
    color: 'var(--dsw-alias-label-tertiary, #999)',
    background: 'none',
    border: 0,
    padding: 0,
    margin: 0,
    lineHeight: 'inherit',
    cursor: 'pointer',
  }

  if (error !== undefined) {
    return (
      <div style={shell}>
        <div style={{ color: 'var(--dsw-alias-state-error-label, #b00)' }}>{t('view.error', { code: error })}</div>
        <div style={{ marginTop: '8px' }}>
          <button type="button" style={button} onClick={refresh}>{t('view.retry')}</button>
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
  const searchInput: Record<string, string | number> = {
    flex: '1 1 200px',
    minWidth: '140px',
    padding: '3px 8px',
    font: 'inherit',
    color: 'var(--dsw-alias-label-primary, inherit)',
    background: 'var(--dsw-alias-bg-base, rgba(0,0,0,0.02))',
    border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))',
    borderRadius: '6px',
  }

  return (
    <div style={shell}>
      <div style={head}>
        <strong>{t('view.tab')}</strong>
        <span style={summary}>
          {filtering
            ? t('filter.showing', { visible: visibleReportCount, total: counts.all })
            : t('view.summary', { sessions: payload.sessions.length, reports: payload.reports.length })}
        </span>
        <button type="button" style={button} onClick={refresh}>{t('view.refresh')}</button>
      </div>

      <div style={tools} title={t('filter.hint')}>
        {chips.map((candidate) => {
          const active = status === candidate
          return (
            <button
              key={candidate}
              type="button"
              aria-pressed={active}
              onClick={() => { setStatus(candidate) }}
              style={{
                ...button,
                ...(active
                  ? {
                    color: 'var(--dsw-alias-label-primary, inherit)',
                    background: 'var(--dsw-alias-interactive-bg-active, rgba(0,0,0,0.08))',
                    borderColor: 'var(--dsw-alias-border-l3, rgba(0,0,0,0.20))',
                  }
                  : {}),
              }}
            >
              {`${t(statusLabel[candidate])} ${statusCount[candidate]}`}
            </button>
          )
        })}
        <input
          type="search"
          value={text}
          placeholder={t('filter.search')}
          aria-label={t('filter.search')}
          onChange={(event) => { setText(event.target.value) }}
          style={searchInput}
        />
        {filtering ? (
          <button
            type="button"
            style={button}
            onClick={() => { setStatus('all'); setText('') }}
          >
            {t('filter.clear')}
          </button>
        ) : null}
        <button
          type="button"
          style={button}
          title={t('basis.hint')}
          onClick={() => { setBasis(basis === 'created' ? 'updated' : 'created') }}
        >
          {t(basis === 'created' ? 'basis.created' : 'basis.updated')}
        </button>
      </div>

      {empty === 'no-reports' ? <div style={muted}>{t('view.empty')}</div> : null}
      {empty === 'filtered-out' ? <div style={muted}>{t('filter.none')}</div> : null}

      {visible.map((row, index) => {
        const pad = 8 + row.depth * 18
        if (row.kind === 'session') {
          return (
            <div key={`s-${row.id}-${index}`} style={{ display: 'flex', gap: '8px', padding: `4px 0 4px ${pad}px`, alignItems: 'baseline' }}>
              <span style={{ color: 'var(--dsw-alias-label-tertiary, #999)' }}>●</span>
              <span style={{ flex: '1 1 auto', minWidth: 0 }} title={row.id}>
                {row.delegated ? <span style={chip({ color: 'var(--dsw-alias-state-business-label, #0969da)', background: 'var(--dsw-alias-state-business-bg, rgba(9,105,218,0.10))' })}>{t('view.delegated')}</span> : null}
                {row.live ? <span style={chip({ color: 'var(--dsw-alias-state-success-label, #1a7f37)', background: 'var(--dsw-alias-state-success-bg, rgba(26,127,55,0.10))' })}>{t('view.live')}</span> : null}
                {row.title ?? shortId(row.id)}
              </span>
              {/* The session's own short id, so a digest row's `from=`/`to=` can be
                  read back to the tree it belongs to. Titles stay the prominent
                  label — this is the cross-reference, not the identity. */}
              {row.title === undefined ? null : <span style={time} title={row.id}>{shortId(row.id)}</span>}
              <span style={time}>{stamp(row.at)}</span>
            </div>
          )
        }
        const front = row.front
        const expanded = openReport === front.report
        const panelId = `report-ledger-panel-${front.report}`
        const toggleLabel = fill(expanded ? t('row.collapse') : t('row.expand'), { report: front.report })
        return (
          <div key={`r-${front.report}`} style={{ paddingLeft: `${pad}px` }}>
            {/* The row is a plain container, not a `role="button"`.
                It used to be one, and it contained a real <button> (the task
                chip) — nested interactive content. Worse, a role="button" takes
                its accessible name from its whole subtree, so a screen reader
                read out a line of session uuids and then the task label twice,
                once inside the row's own name.
                The disclosure now lives on the arrow: a real button whose name
                says what it does and whose `aria-controls` points at the panel it
                opens. Clicking anywhere on the row stays as the pointer
                convenience, which is why the container keeps a click handler
                with no role: the keyboard path is the button, and the pointer
                path is the row. */}
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
              <button
                type="button"
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
                style={arrow}
              >
                {expanded ? '▾' : '▸'}
              </button>
              <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                <span style={chip(statusStyle(front.status))}>{t(STATUS_LABEL[front.status])}</span>
                <strong>{front.report}</strong> {front.subject}
                {/* The task chip is a filter shortcut, not decoration: clicking it
                    reuses the search box, so grouping by collaboration needs no
                    state of its own. It stops the click from also toggling the
                    detail panel, and it CLEARS the status filter — its own label
                    promises "show only this task", which stops being true the
                    moment a status chip is also narrowing the list. */}
                {front.task === undefined ? null : (
                  <button
                    type="button"
                    title={fill(t('row.filterByTask'), { task: front.task })}
                    onClick={(event) => {
                      event.stopPropagation()
                      setStatus('all')
                      setText(front.task as string)
                    }}
                    style={{
                      ...chip({
                        color: 'var(--dsw-alias-state-business-label, #0969da)',
                        background: 'var(--dsw-alias-state-business-bg, rgba(9,105,218,0.10))',
                      }),
                      border: 0,
                      cursor: 'pointer',
                      font: 'inherit',
                    }}
                  >
                    {front.task}
                  </button>
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
                            <span style={wrap} title={idHint(hop.actor)}>{hop.actor}</span>
                            <span style={wrap}>{hop.to.length === 0 ? (hop.note ?? '') : `→ ${hop.to.join(', ')}${hop.note === undefined ? '' : ` (${hop.note})`}`}</span>
                          </Fragment>
                        ))}
                      </div>
                    )}
                    {detail.pending.length === 0 ? null : (
                      <div style={{ ...wrap, color: 'var(--dsw-alias-state-warn-label, #9a6700)' }}>
                        {fill(t('view.detail.pending'), { targets: detail.pending.join(', ') })}
                      </div>
                    )}

                    {(() => {
                      const parent = detail.front.parent
                      const children = detail.front.children
                      if (parent === undefined && children.length === 0) return null
                      const link = (target: string): ReactElement => (
                        <button
                          key={target}
                          type="button"
                          title={fill(t('detail.openLinked'), { report: target })}
                          onClick={() => { setOpenReport(target) }}
                          style={{ ...button, marginRight: '6px', font: 'var(--dsw-font-xxxs-11, 11px/1.4 ui-monospace, monospace)' }}
                        >
                          {target}
                        </button>
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
                        <button type="button" style={button} onClick={() => { setOpenReport(undefined) }}>
                          {t('detail.backToList')}
                        </button>
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
                        mid-segment on purpose. */}
                    <div style={{ ...wrap, marginTop: '6px', wordBreak: 'break-all' }}>{t('view.detail.path')}: {detail.path}</div>
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
