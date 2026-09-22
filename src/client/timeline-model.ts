/**
 * The timeline's data model: turning a payload into rows, and filtering them.
 *
 * Deliberately a plain module with no React and no DOM so the decisions a user
 * actually feels — which rows appear, what a search matches, how the status
 * chips count — are pinned by deterministic tests instead of being inferred from
 * a browser. The view imports this; it does not re-implement it.
 *
 * @module dsh-report-ledger/client/timeline-model
 */

import type { ReportFrontMatter, ReportStatus, TimelinePayload } from '../shared/wire.ts'

/** One rendered timeline row: a session branching, or a report appearing. */
export type Row =
  | {
    readonly kind: 'session'
    readonly at: number
    readonly id: string
    readonly depth: number
    readonly title?: string
    readonly delegated: boolean
    readonly live: boolean
  }
  | {
    readonly kind: 'report'
    readonly at: number
    readonly depth: number
    readonly front: ReportFrontMatter
  }

/** Which lifecycle states the status chips currently admit. */
export type StatusFilter = 'all' | ReportStatus

/** How a report is placed on the time axis. */
export type ReportTimeBasis = 'created' | 'updated'

/** Filters the view applies to the assembled rows. */
export interface RowFilter {
  /** Lifecycle filter; applies to report rows only. */
  readonly status: StatusFilter
  /** Free text; applies to every row. */
  readonly text: string
}

/**
 * Build the merged, time-ordered row list.
 *
 * Sessions are placed at their creation time and reports at theirs, so the list
 * reads as the collaboration actually unfolded: a session appears where it was
 * branched, a report where it was opened. Report depth comes from the session
 * that authored it, which is what keeps the indentation meaningful even when the
 * session row itself is filtered out.
 * @param payload - the endpoint payload.
 * @param basis - whether to place a report at its creation or its last activity.
 * @returns the rows, oldest first.
 */
export function buildRows(payload: TimelinePayload, basis: ReportTimeBasis = 'created'): Row[] {
  const depth = new Map<string, number>()
  const rows: Row[] = []
  for (const node of payload.sessions) {
    depth.set(node.id, node.depth)
    rows.push({
      kind: 'session',
      at: node.createdAt ?? 0,
      id: node.id,
      depth: node.depth,
      delegated: node.delegated,
      live: node.live,
      ...(node.title === undefined ? {} : { title: node.title }),
    })
  }
  for (const front of payload.reports) {
    rows.push({
      kind: 'report',
      at: basis === 'created' ? front.created : front.updated,
      depth: depth.get(front.from) ?? 0,
      front,
    })
  }
  rows.sort((left, right) => left.at - right.at
    || (left.kind === right.kind ? 0 : left.kind === 'session' ? -1 : 1))
  return rows
}

/** Every string a report row can be found by. */
function reportHaystack(front: ReportFrontMatter): string {
  return [
    front.report,
    front.subject,
    front.from,
    front.fromName ?? '',
    ...front.to,
    ...front.cc,
    ...front.authors,
    front.task ?? '',
    ...front.artifacts,
  ].join('\n').toLowerCase()
}

/** Every string a session row can be found by. */
function sessionHaystack(row: Extract<Row, { kind: 'session' }>): string {
  return `${row.title ?? ''}\n${row.id}`.toLowerCase()
}

/**
 * Whether one row survives the current filter.
 * @param row - the candidate row.
 * @param filter - the active filter.
 * @returns true when the row should be rendered.
 */
export function rowMatches(row: Row, filter: RowFilter): boolean {
  const needle = filter.text.trim().toLowerCase()
  if (row.kind === 'session') {
    return needle === '' || sessionHaystack(row).includes(needle)
  }
  if (filter.status !== 'all' && row.front.status !== filter.status) return false
  return needle === '' || reportHaystack(row.front).includes(needle)
}

/**
 * Apply a filter to the row list.
 * @param rows - the assembled rows.
 * @param filter - the active filter.
 * @returns the surviving rows, in their original order.
 */
export function filterRows(rows: readonly Row[], filter: RowFilter): Row[] {
  return rows.filter((row) => rowMatches(row, filter))
}

/** Counts per lifecycle state, plus the total. */
export interface StatusCounts {
  /** Every report. */
  readonly all: number
  /** Reports awaiting action or awareness. */
  readonly open: number
  /** Reports whose recipients have acknowledged. */
  readonly acked: number
  /** Reports the owners have concluded. */
  readonly closed: number
}

/**
 * Count reports by lifecycle state.
 *
 * Counted from the whole subtree payload rather than the filtered rows, so the
 * chips keep showing the full picture while one of them is applied — a filter
 * whose own label changed when you used it would make it impossible to see how
 * much you had excluded.
 * @param reports - every report in the payload.
 * @returns the counts.
 */
export function statusCounts(reports: readonly ReportFrontMatter[]): StatusCounts {
  const counts = { all: reports.length, open: 0, acked: 0, closed: 0 }
  for (const front of reports) {
    if (front.status === 'open') counts.open += 1
    else if (front.status === 'acked') counts.acked += 1
    else if (front.status === 'closed') counts.closed += 1
  }
  return counts
}

/**
 * Whether a filter would hide anything.
 * @param filter - the active filter.
 * @returns true when a status or text constraint is in force.
 */
export function isFiltering(filter: RowFilter): boolean {
  return filter.status !== 'all' || filter.text.trim() !== ''
}

/**
 * Count how many report rows are visible under a filter.
 * @param rows - every assembled row.
 * @param filter - the active filter.
 * @returns the number of visible report rows.
 */
export function visibleReports(rows: readonly Row[], filter: RowFilter): number {
  let count = 0
  for (const row of filterRows(rows, filter)) if (row.kind === 'report') count += 1
  return count
}

/**
 * The report ids present in one payload.
 *
 * A thread link can point outside the subtree — a report answering one opened by
 * an unrelated session, for instance — and the detail endpoint is ledger-scoped,
 * so such a report still opens. Knowing which ids are in the list is what lets
 * the view say so instead of silently showing a card that is not in the timeline.
 * @param payload - the endpoint payload.
 * @returns the ids of every report in the payload.
 */
export function reportIds(payload: TimelinePayload): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const front of payload.reports) ids.add(front.report)
  return ids
}

/** Body length above which the detail panel shows only a head. */
export const BODY_DISPLAY_LIMIT = 4000

/** How much of an over-long body is shown. */
export const BODY_HEAD_LIMIT = 1200

/**
 * Trim a body for the detail panel.
 *
 * Mirrors what `report_read` already does for the model: the full text stays in
 * the ledger file, and both readers get a bounded view plus a pointer rather than
 * an unbounded paste. Keeping the human view and the model view bounded the same
 * way means neither can be surprised by what the other sees.
 * @param body - the raw body.
 * @param limit - length above which truncation applies.
 * @param head - how many characters to keep when truncating.
 * @returns the display text and whether it was cut.
 */
export function displayBody(
  body: string,
  limit: number = BODY_DISPLAY_LIMIT,
  head: number = BODY_HEAD_LIMIT,
): { readonly text: string; readonly truncated: boolean } {
  if (body.length <= limit) return { text: body, truncated: false }
  return { text: body.slice(0, head), truncated: true }
}
