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
 * The timeline's ordering: by time, and at the same instant a session before a
 * report.
 *
 * Extracted so that INSERTING a row uses the same rule as SORTING rows — two
 * copies would drift, and the synthesized row would land somewhere the sort
 * disagrees with.
 * @param left - one row.
 * @param right - the other row.
 * @returns the comparison result.
 */
function byTime(left: Row, right: Row): number {
  return left.at - right.at
    || (left.kind === right.kind ? 0 : left.kind === 'session' ? -1 : 1)
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
  rows.sort(byTime)
  return rows
}

/** How many characters of a session id a dense row shows. */
export const SHORT_ID_LENGTH = 8

/**
 * Shorten a session id so a digest row can be read.
 *
 * A session id is 36 characters and a report's recipients are a list of them, so
 * an unabbreviated meta line is mostly uuid and carries almost no information a
 * human can use. Eight characters of the leading segment stay unique within one
 * collaboration and, unlike a session title, are bounded: titles are the first
 * prompt of a session ("You are doing READ-ONLY research"), so swapping ids for
 * titles trades one unreadable line for another.
 *
 * This is a DENSE-ROW display only. The detail panel keeps full ids, because
 * that is the view somebody copies an id out of, and the tooltip on every
 * shortened id carries the full value.
 * @param id - the session id.
 * @param length - how many characters to keep.
 * @returns the shortened id.
 */
export function shortId(id: string, length: number = SHORT_ID_LENGTH): string {
  const bare = id.startsWith('session-') ? id.slice('session-'.length) : id
  return bare.length <= length ? bare : bare.slice(0, length)
}

/**
 * Display titles for the sessions in one payload, keyed by session id.
 *
 * Titles are resolved only for the subtree, so an id from another tree simply
 * has none — which is why every caller must fall back to the shortened id
 * rather than assuming a name exists.
 * @param payload - the endpoint payload.
 * @returns the titles that were resolved.
 */
export function sessionTitles(payload: TimelinePayload): Map<string, string> {
  const titles = new Map<string, string>()
  for (const node of payload.sessions) {
    if (typeof node.title === 'string' && node.title !== '') titles.set(node.id, node.title)
  }
  return titles
}

/**
 * Make sure the open report has a row, and put it where it belongs.
 *
 * The detail panel is anchored to a report row, so the open report must HAVE
 * one. Two real user paths would otherwise leave the panel with nowhere to
 * render: a thread link pointing at a report outside this tree's payload, and
 * any filter applied while a report is open. In the first case the panel is also
 * the only place the "not in this tree" notice can appear, so the panel is not
 * hoisted out of the list — a row is synthesized instead.
 *
 * The synthesized row is INSERTED at its own place on the time axis rather than
 * appended. Appending made a report created at 11:12 appear below one created at
 * 14:30, which reads as a broken sort at exactly the moment the user is trying
 * to understand why something is missing.
 * @param kept - the rows that survived the filter.
 * @param front - the digest of the open report.
 * @param basis - the active time basis, so the row moves with the rest.
 * @returns the rows, with the open report present exactly once.
 */
export function withSynthesizedRow(
  kept: readonly Row[],
  front: ReportFrontMatter,
  basis: ReportTimeBasis = 'created',
): Row[] {
  if (kept.some((row) => row.kind === 'report' && row.front.report === front.report)) return [...kept]
  const row: Row = { kind: 'report', at: basis === 'created' ? front.created : front.updated, depth: 0, front }
  const index = kept.findIndex((candidate) => byTime(row, candidate) < 0)
  if (index < 0) return [...kept, row]
  return [...kept.slice(0, index), row, ...kept.slice(index)]
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

/** Which "there is nothing here to show" message a payload and filter call for. */
export type EmptyState = 'none' | 'no-reports' | 'filtered-out'

/**
 * Decide which empty-state message applies.
 *
 * An empty ledger and a filter that matched nothing look identical on screen but
 * mean opposite things: one says "nothing has happened in this tree yet", the
 * other says "you are looking at a subset of what happened". Saying the wrong
 * one makes a working ledger look broken, so the choice is made here — where it
 * is pinned by tests — rather than inline in the view.
 *
 * Counted on REPORT rows only. Session rows always survive a status chip, so
 * counting them would let a tree full of sessions report itself as "you have
 * filtered everything out" while the actual reason is that no report exists.
 *
 * The `no-reports` case deliberately wins over the filter: when the ledger holds
 * nothing, a filter cannot be the reason nothing is on screen, and blaming it
 * would send the reader looking for a filter to clear that they never set.
 * @param payload - the endpoint payload.
 * @param rows - every assembled row.
 * @param filter - the active filter.
 * @returns which message the view should show, if any.
 */
export function emptyState(payload: TimelinePayload, rows: readonly Row[], filter: RowFilter): EmptyState {
  if (payload.reports.length === 0) return 'no-reports'
  if (!isFiltering(filter)) return 'none'
  return visibleReports(rows, filter) === 0 ? 'filtered-out' : 'none'
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

/**
 * Close a code fence left hanging by truncation.
 *
 * Cutting Markdown at a character count is not the same operation as cutting
 * plain text: the result can be a document that does not parse as written. The
 * one construct that changes the meaning of everything after it is a code fence,
 * so a body cut inside a fenced block hands the renderer an unterminated one and
 * leaves it to decide where the block ends.
 *
 * The renderer here does cope (measured: a body cut mid-fence renders as one
 * closed code block with no trailing artifact), which is exactly why this is
 * cheap insurance rather than a fix for something visibly broken: the renderer is
 * a shell platform module this plugin does not own, and its leniency is not a
 * contract. Balancing the document costs one line and makes the plugin's output
 * valid Markdown no matter who renders it.
 *
 * Balanced text is returned untouched, so this only ever adds the fence the cut
 * removed. Only backtick fences are counted; `~~~` fences are rare enough in
 * report bodies that guessing which convention the author used would be worse
 * than leaving them alone.
 * @param text - the already-truncated head.
 * @returns the head, with an unclosed fence closed.
 */
export function closeOpenFence(text: string): string {
  let open = false
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) open = !open
  }
  return open ? `${text}\n\`\`\`` : text
}
