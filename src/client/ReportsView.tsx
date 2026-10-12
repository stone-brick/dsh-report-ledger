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
import { getJson, POLL_INTERVAL_MS, TIMELINE_URL, useReportDetail } from './timeline-source.ts'
import { fill, stamp } from './format.ts'
import { HOP_LABEL, LEASE_HINT, STATUS_DOT, STATUS_LABEL, STATUS_TONE, type ReportLedgerKey } from './locales.ts'
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
  const [status, setStatus] = useState<StatusFilter>(rememberedStatus)
  const [text, setText] = useState('')
  const [basis, setBasis] = useState<ReportTimeBasis>('created')
  // The open report's detail, read through the same hook the right column's canvas
  // tab uses — one read path, so the two surfaces cannot disagree about a report.
  const { detail, error: detailError } = useReportDetail(openReport, detailNonce)

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

  const rows = useMemo<Row[]>(() => (payload === undefined ? [] : buildRows(payload, basis)), [payload, basis])
  const counts = useMemo(() => statusCounts(payload?.reports ?? []), [payload])
  const inList = useMemo(() => (payload === undefined ? new Set<string>() : reportIds(payload)), [payload])
  // The lease state is not on the digest: liveness comes from the hop stream, and
  // the host derives it once so the browser never needs a second copy of the rule.
  const lanes = useMemo(() => (payload === undefined ? new Map<string, WorktreeLane>() : laneIndex(payload)), [payload])
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
  const idRef = (id: string): ReactElement => (
    <Tooltip label={idHint(id)} side="bottom" delayMs={400}>
      <span>{shortId(id)}</span>
    </Tooltip>
  )

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
          <div key={`r-${front.report}`} style={{ paddingLeft: `${pad}px` }}>
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
                icon={expanded ? <IconChevronDownOutlineRegular size={14} /> : <IconChevronRightOutlineRegular size={14} />}
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
                {/* The checkout chip follows the task chip exactly, for the same
                    reason: it reuses the search box instead of inventing a second
                    filter, and it clears the status filter because its own label
                    promises "show only this checkout". Its tone is the lease
                    state, which is the one thing the digest cannot carry — a
                    checkout nobody holds and one being worked in look identical
                    from the binding alone. */}
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
              <span style={time}>{stamp(front.updated)}</span>
            </div>

            {expanded ? (
              <ReportDetailView
                report={front.report}
                detail={detail}
                error={detailError}
                t={t}
                idHint={idHint}
                id={panelId}
                variant="row"
                onOpenReport={setOpenReport}
                inList={inList.has(front.report)}
                visibleInFilter={filteredReportIds.has(front.report)}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
