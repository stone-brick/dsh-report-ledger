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
import type { ReportDetail, TimelinePayload } from '../shared/wire.ts'
import {
  buildRows,
  displayBody,
  filterRows,
  isFiltering,
  reportIds,
  statusCounts,
  visibleReports,
  type ReportTimeBasis,
  type Row,
  type StatusFilter,
} from './timeline-model.ts'
import type { ReportLedgerKey } from './locales.ts'

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
  const [nonce, setNonce] = useState(0)
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
  }, [sessionId, nonce])

  useEffect(() => {
    if (openReport === undefined) return
    let cancelled = false
    setDetail(undefined)
    setDetailError(undefined)
    getJson<ReportDetail>(`${REPORT_URL}?id=${encodeURIComponent(openReport)}`)
      .then((value) => { if (!cancelled) setDetail(value) })
      .catch((cause: unknown) => { if (!cancelled) setDetailError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { cancelled = true }
  }, [openReport, nonce])

  const rows = useMemo<Row[]>(() => (payload === undefined ? [] : buildRows(payload, basis)), [payload, basis])
  const counts = useMemo(() => statusCounts(payload?.reports ?? []), [payload])
  const inList = useMemo(() => (payload === undefined ? new Set<string>() : reportIds(payload)), [payload])
  const shownBody = useMemo(() => displayBody(detail?.body ?? ''), [detail])
  const filter = useMemo(() => ({ status, text }), [status, text])
  const visible = useMemo<Row[]>(() => {
    const kept = filterRows(rows, filter)
    // The detail panel is anchored to a report row, so the open report must HAVE a
    // row. Two cases would otherwise leave the panel with nowhere to render: a
    // thread link pointing at a report outside this tree's payload, and any filter
    // applied while a report is open. Both are real user paths, and in the first
    // the panel is the only place the "not in this tree" notice can appear — so the
    // row is synthesized from the fetched detail instead of the panel being hoisted
    // out of the list.
    if (openReport === undefined || detail === undefined) return kept
    if (kept.some((row) => row.kind === 'report' && row.front.report === openReport)) return kept
    return [...kept, { kind: 'report', at: detail.front.created, depth: 0, front: detail.front }]
  }, [rows, filter, openReport, detail])
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

  const refresh = useCallback(() => { setNonce((value) => value + 1) }, [])

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

      {rows.length === 0 ? <div style={{ color: 'var(--dsw-alias-label-tertiary, #888)' }}>{t('view.empty')}</div> : null}
      {rows.length > 0 && visible.length === 0 ? (
        <div style={{ color: 'var(--dsw-alias-label-tertiary, #888)' }}>{t('filter.none')}</div>
      ) : null}

      {visible.map((row, index) => {
        const pad = 8 + row.depth * 18
        if (row.kind === 'session') {
          return (
            <div key={`s-${row.id}-${index}`} style={{ display: 'flex', gap: '8px', padding: `4px 0 4px ${pad}px`, alignItems: 'baseline' }}>
              <span style={{ color: 'var(--dsw-alias-label-tertiary, #999)' }}>●</span>
              <span style={{ flex: '1 1 auto' }}>
                {row.delegated ? <span style={chip({ color: 'var(--dsw-alias-state-business-label, #0969da)', background: 'var(--dsw-alias-state-business-bg, rgba(9,105,218,0.10))' })}>{t('view.delegated')}</span> : null}
                {row.live ? <span style={chip({ color: 'var(--dsw-alias-state-success-label, #1a7f37)', background: 'var(--dsw-alias-state-success-bg, rgba(26,127,55,0.10))' })}>{t('view.live')}</span> : null}
                {row.title ?? row.id}
              </span>
              <span style={time}>{stamp(row.at)}</span>
            </div>
          )
        }
        const front = row.front
        const expanded = openReport === front.report
        return (
          <div key={`r-${front.report}`} style={{ paddingLeft: `${pad}px` }}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => { setOpenReport(expanded ? undefined : front.report) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setOpenReport(expanded ? undefined : front.report)
                }
              }}
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
              <span style={{ color: 'var(--dsw-alias-label-tertiary, #999)' }}>{expanded ? '▾' : '▸'}</span>
              <span style={{ flex: '1 1 auto' }}>
                <span style={chip(statusStyle(front.status))}>{front.status}</span>
                <strong>{front.report}</strong> {front.subject}
                {/* The task chip is a filter shortcut, not decoration: clicking it
                    reuses the search box, so grouping by collaboration needs no
                    state of its own. It stops the click from also toggling the
                    detail panel. */}
                {front.task === undefined ? null : (
                  <button
                    type="button"
                    title={fill(t('row.filterByTask'), { task: front.task })}
                    onClick={(event) => { event.stopPropagation(); setText(front.task as string) }}
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
                <div style={{ ...time, marginTop: '2px' }}>
                  {`from=${front.from}`}
                  {front.to.length > 0 ? ` → ${front.to.join(', ')}` : ''}
                  {front.cc.length > 0 ? ` cc ${front.cc.join(', ')}` : ''}
                  {` · ${fill(t('row.hops'), { count: front.hops })}`}
                  {front.authors.length > 1 ? ` · ${fill(t('row.authors'), { count: front.authors.length })}` : ''}
                  {front.last === undefined ? '' : ` · last=${front.last.action}`}
                </div>
              </span>
              <span style={time}>{stamp(front.updated)}</span>
            </div>

            {expanded ? (
              <div style={{
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
                            <span><strong>{hop.action}</strong></span>
                            <span style={time}>{hop.actor}</span>
                            <span style={time}>{hop.to.length === 0 ? (hop.note ?? '') : `→ ${hop.to.join(', ')}${hop.note === undefined ? '' : ` (${hop.note})`}`}</span>
                          </Fragment>
                        ))}
                      </div>
                    )}
                    {detail.pending.length === 0 ? null : (
                      <div style={{ ...time, color: 'var(--dsw-alias-state-warn-label, #9a6700)' }}>
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
                      <div style={{ ...time, marginBottom: '8px' }}>
                        {fill(t('detail.outside'), { report: detail.front.report })}
                        {' '}
                        <button type="button" style={button} onClick={() => { setOpenReport(undefined) }}>
                          {t('detail.backToList')}
                        </button>
                      </div>
                    )}
                    {inList.has(detail.front.report) && !filteredReportIds.has(detail.front.report) ? (
                      <div style={{ ...time, marginBottom: '8px' }}>
                        {fill(t('detail.filteredOut'), { report: detail.front.report })}
                      </div>
                    ) : null}

                    <div style={{ margin: '8px 0 4px' }}><strong>{t('view.detail.body')}</strong></div>
                    <pre style={{
                      margin: 0,
                      padding: '8px 10px',
                      maxHeight: '320px',
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      background: 'var(--dsw-alias-bg-base, rgba(0,0,0,0.02))',
                      border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))',
                      borderRadius: '4px',
                      font: 'var(--dsw-font-xs-13, 13px/1.5 ui-monospace, monospace)',
                    }}>{shownBody.text.trim()}</pre>
                    {shownBody.truncated ? (
                      <div style={{ ...time, marginTop: '4px' }}>
                        {fill(t('detail.bodyTruncated'), { chars: shownBody.text.trim().length })}
                      </div>
                    ) : null}
                    <div style={{ ...time, marginTop: '6px', wordBreak: 'break-all' }}>{t('view.detail.path')}: {detail.path}</div>
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
