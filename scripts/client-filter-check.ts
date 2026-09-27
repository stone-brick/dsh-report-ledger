// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts and `filter` silently resolves to the DOM's window.filter.
// Emitted as nothing; it exists so `tsc` treats the file as its own module.
export {}
/**
 * Deterministic checks for the timeline's data model.
 *
 * The model is a plain module precisely so this is possible: which rows appear,
 * what a search matches, and how the status chips count are decisions a user
 * feels directly, and they are pinned here rather than inferred from watching a
 * browser. The view is only rendering.
 *
 * Run: node scripts/client-filter-check.ts
 */

const { buildRows, filterRows, isFiltering, statusCounts, visibleReports, rowMatches, emptyState, shortId, sessionTitles, withSynthesizedRow } =
  await import('../src/client/timeline-model.ts')

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

const at = (n: number): number => 1_700_000_000_000 + n * 1000

const report = (id: string, over: Record<string, unknown> = {}): never => ({
  report: id,
  subject: `subject ${id}`,
  status: 'open',
  from: 'session-root',
  to: [],
  cc: [],
  authors: ['session-root'],
  created: at(10),
  updated: at(10),
  children: [],
  artifacts: [],
  hops: 1,
  ...over,
}) as never

const payload = {
  root: 'session-root',
  generatedAt: at(99),
  sessions: [
    { id: 'session-root', depth: 0, delegated: false, live: true, title: 'root session', createdAt: at(1) },
    { id: 'session-child', depth: 1, delegated: true, live: true, parentId: 'session-root', title: 'child session', createdAt: at(2) },
    { id: 'session-grand', depth: 2, delegated: true, live: false, parentId: 'session-child', title: 'grand session', createdAt: at(3) },
  ],
  reports: [
    report('R-0001', { from: 'session-child', subject: 'payments rework', status: 'open', created: at(4), updated: at(20) }),
    report('R-0002', { from: 'session-root', subject: 'review done', status: 'acked', created: at(5), updated: at(15) }),
    report('R-0003', { from: 'session-grand', subject: 'old matter', status: 'closed', created: at(6), updated: at(12) }),
    report('R-0004', {
      from: 'session-outsider',
      subject: 'copied in',
      status: 'open',
      created: at(7),
      updated: at(7),
      cc: ['session-child'],
      authors: ['session-outsider', 'session-child'],
      task: 'audit',
      artifacts: ['src/pay.ts'],
      fromName: 'the auditor',
    }),
  ],
} as unknown as Parameters<typeof buildRows>[0]

// ---------------------------------------------------------------------------
// Row assembly
// ---------------------------------------------------------------------------
const rows = buildRows(payload)
check('every session becomes a row', rows.filter((r) => r.kind === 'session').length === 3)
check('every report becomes a row', rows.filter((r) => r.kind === 'report').length === 4)
check('rows are ordered by time', rows.map((r) => r.at).every((value, index, all) => index === 0 || all[index - 1] <= value))
check('a session is placed at its creation time', rows[0]?.kind === 'session' && rows[0]?.id === 'session-root')
check('a report is placed at its creation by default', rows.find((r) => r.kind === 'report' && r.front.report === 'R-0001')?.at === at(4))

const byUpdated = buildRows(payload, 'updated')
check('the time basis can follow last activity instead',
  byUpdated.find((r) => r.kind === 'report' && r.front.report === 'R-0001')?.at === at(20))

const reportDepth = new Map(rows.filter((r) => r.kind === 'report').map((r) => [r.front.report, r.depth]))
check('a report inherits its author\'s depth', reportDepth.get('R-0001') === 1)
check('a grandchild report indents deeper', reportDepth.get('R-0003') === 2)
check('a report from outside the subtree sits at the root depth', reportDepth.get('R-0004') === 0)

// ---------------------------------------------------------------------------
// Status filter: reports only
// ---------------------------------------------------------------------------
const open = filterRows(rows, { status: 'open', text: '' })
check('the open filter keeps only open reports',
  open.filter((r) => r.kind === 'report').every((r) => r.front.status === 'open'))
check('the open filter keeps both open reports', open.filter((r) => r.kind === 'report').length === 2)
check('a status filter leaves session rows alone', open.filter((r) => r.kind === 'session').length === 3)
check('the closed filter finds the one closed report',
  filterRows(rows, { status: 'closed', text: '' }).filter((r) => r.kind === 'report').length === 1)
check('the all filter keeps every report', filterRows(rows, { status: 'all', text: '' }).length === rows.length)

// ---------------------------------------------------------------------------
// Text search: every row
// ---------------------------------------------------------------------------
const search = (text: string): ReturnType<typeof filterRows> => filterRows(rows, { status: 'all', text })

check('search matches a report id', search('r-0002').some((r) => r.kind === 'report' && r.front.report === 'R-0002'))
check('search matches a subject', search('payments').some((r) => r.kind === 'report' && r.front.report === 'R-0001'))
check('search matches the sender id', search('session-outsider').some((r) => r.kind === 'report' && r.front.report === 'R-0004'))
check('search matches the sender display name', search('auditor').some((r) => r.kind === 'report' && r.front.report === 'R-0004'))
check('search matches a carbon copy', search('session-child').some((r) => r.kind === 'report' && r.front.report === 'R-0004'))
check('search matches a co-author', search('R-0004').length === 1)
check('search matches the task label', search('audit').some((r) => r.kind === 'report' && r.front.report === 'R-0004'))
check('search matches an artifact path', search('src/pay.ts').some((r) => r.kind === 'report' && r.front.report === 'R-0004'))
check('search is case-insensitive', search('PAYMENTS').some((r) => r.kind === 'report' && r.front.report === 'R-0001'))
check('search is trimmed', search('   payments   ').some((r) => r.kind === 'report' && r.front.report === 'R-0001'))
check('search matches a session title', search('grand session').some((r) => r.kind === 'session' && r.id === 'session-grand'))
check('search matches a session id', search('session-grand').some((r) => r.kind === 'session' && r.id === 'session-grand'))
check('search narrows sessions too', search('grand session').filter((r) => r.kind === 'session').length === 1)
check('an unmatched search yields nothing', search('no-such-thing-anywhere').length === 0)
check('an empty search keeps everything', search('').length === rows.length)

// ---------------------------------------------------------------------------
// Combined, ordering, and the helpers
// ---------------------------------------------------------------------------
const combined = filterRows(rows, { status: 'open', text: 'payments' })
check('status and text combine', combined.filter((r) => r.kind === 'report').length === 1
  && combined.filter((r) => r.kind === 'report')[0]?.front.report === 'R-0001')

const contradictory = filterRows(rows, { status: 'closed', text: 'payments' })
check('a contradictory combination yields no reports', contradictory.filter((r) => r.kind === 'report').length === 0)

check('filtering preserves order', filterRows(rows, { status: 'all', text: 'session' })
  .every((row, index, all) => index === 0 || all[index - 1].at <= row.at))

const counts = statusCounts(payload.reports)
check('counts total every report', counts.all === 4, String(counts.all))
check('counts split by state', counts.open === 2 && counts.acked === 1 && counts.closed === 1, JSON.stringify(counts))

// `all` is the raw length, so an unrecognized state still shows up in the total
// rather than silently vanishing from the chips.
const oddCounts = statusCounts([report('R-0009', { status: 'mystery' })] as never)
check('an unknown state still counts toward the total', oddCounts.all === 1 && oddCounts.open === 0)

check('isFiltering is false by default', !isFiltering({ status: 'all', text: '' }))
check('isFiltering is false for whitespace', !isFiltering({ status: 'all', text: '   ' }))
check('isFiltering notices a status', isFiltering({ status: 'open', text: '' }))
check('isFiltering notices text', isFiltering({ status: 'all', text: 'x' }))
check('visibleReports counts only report rows', visibleReports(rows, { status: 'open', text: '' }) === 2)
const agreementFilter = { status: 'closed', text: 'old' } as const
check('rowMatches agrees with filterRows',
  rows.every((row) => rowMatches(row, agreementFilter) === (filterRows([row], agreementFilter).length === 1)))

// ---------------------------------------------------------------------------
// The two empty states
// ---------------------------------------------------------------------------
// "Nothing has happened here yet" and "your filter matched nothing" look
// identical on screen and mean opposite things, so which one applies is a
// decision rather than a rendering detail — and getting it wrong makes a
// working ledger look broken. The bug this pins: the ledger-empty sentence was
// keyed off an empty ROW list, which cannot happen (a tree always has at least
// its own session row), so in practice it never appeared and an empty ledger
// rendered as unexplained blank space.
const bare = {
  root: 'session-root',
  generatedAt: at(99),
  sessions: payload.sessions,
  reports: [],
} as unknown as Parameters<typeof buildRows>[0]

check('a tree with no reports asks for the ledger-empty sentence',
  emptyState(bare, buildRows(bare), { status: 'all', text: '' }) === 'no-reports')
check('a tree with no reports does not blame the filter',
  emptyState(bare, buildRows(bare), { status: 'closed', text: 'nothing' }) === 'no-reports')
check('an unfiltered tree with reports asks for no message',
  emptyState(payload, rows, { status: 'all', text: '' }) === 'none')
check('a filter matching some report asks for no message',
  emptyState(payload, rows, { status: 'open', text: '' }) === 'none')
const filteredOut = emptyState(payload, rows, { status: 'closed', text: 'payments' })
check('a filter matching no report asks for the filtered sentence', filteredOut === 'filtered-out', filteredOut)
// Session rows survive a status chip by design, so counting every visible row
// would let a tree full of sessions claim "you filtered everything out" while
// the real reason is that no report matches.
check('session rows alone cannot satisfy the filter',
  emptyState(payload, rows, { status: 'all', text: 'grand session' }) === 'filtered-out')
check('a payload with neither sessions nor reports asks for the ledger-empty sentence',
  emptyState({ root: 'x', generatedAt: 0, sessions: [], reports: [] } as never, [], { status: 'all', text: '' }) === 'no-reports')

// ---------------------------------------------------------------------------
// Dense-row identity: shortened ids
// ---------------------------------------------------------------------------
// A report row is a list of session uuids unless they are cut down, and a
// session TITLE is not a substitute: it is the session's first prompt, so it is
// unbounded and sometimes longer than the id it replaces.
check('a session- prefixed id shortens to its leading segment',
  shortId('session-afcbce3a-93d0-49b6-b465-e3c4b44c7dce') === 'afcbce3a')
check('a bare uuid shortens the same way',
  shortId('01edba72-fe45-4f0d-b5e6-f531fb3d1a1e') === '01edba72')
check('an id shorter than the cut is left whole', shortId('abc') === 'abc')
check('the cut is parameterized', shortId('01edba72-fe45', 4) === '01ed')

const titles = sessionTitles(payload)
check('titles are collected per session', titles.get('session-grand') === 'grand session')
check('an unknown session simply has no title', !titles.has('session-nobody'))
check('an empty payload has no titles',
  sessionTitles({ root: 'x', generatedAt: 0, sessions: [], reports: [] } as never).size === 0)

// ---------------------------------------------------------------------------
// The synthesized row for an open report
// ---------------------------------------------------------------------------
// It exists so the detail panel has an anchor. Appending it instead of inserting
// it made a report created at 11:12 appear below one created at 14:30 — a broken
// sort at exactly the moment the user is asking why something is missing.
const middle = report('R-0042', { created: at(4), updated: at(30) })
const byCreated = withSynthesizedRow(rows, middle, 'created')
const byActivity = withSynthesizedRow(rows, middle, 'updated')

check('a missing report gains a row', byCreated.filter((r) => r.kind === 'report').length === 5)
check('the synthesized row keeps the list sorted',
  byCreated.every((row, index, all) => index === 0 || all[index - 1].at <= row.at))
check('the synthesized row is inserted, not appended', byCreated[byCreated.length - 1]?.at !== at(4))
check('the synthesized row follows the time basis', byActivity[byActivity.length - 1]?.at === at(30))
check('an already-present report is not duplicated',
  withSynthesizedRow(rows, report('R-0001')).length === rows.length, String(withSynthesizedRow(rows, report('R-0001')).length))
check('the synthesized row carries the fetched digest',
  byCreated.some((row) => row.kind === 'report' && row.front.report === 'R-0042'))

// ---------------------------------------------------------------------------
// Thread links and body display
// ---------------------------------------------------------------------------
const { reportIds, displayBody, closeOpenFence } = await import('../src/client/timeline-model.ts')

const ids = reportIds(payload)
check('reportIds lists every report in the payload', ids.size === 4, String(ids.size))
check('reportIds contains a known id', ids.has('R-0002'))
check('reportIds rejects an unknown id', !ids.has('R-0009'))
check('reportIds of an empty payload is empty', reportIds({ root: 'x', generatedAt: 0, sessions: [], reports: [] } as never).size === 0)

const short = displayBody('a short body')
check('a short body is shown whole', short.text === 'a short body' && !short.truncated)

const exact = displayBody('x'.repeat(4000))
check('a body exactly at the limit is not truncated', !exact.truncated && exact.text.length === 4000)

const long = displayBody('y'.repeat(5000))
check('an over-long body is truncated', long.truncated)
check('a truncated body keeps only the head', long.text.length === 1200, String(long.text.length))
check('truncation is reported, not silent', long.truncated === true)

const custom = displayBody('z'.repeat(50), 10, 4)
check('the display limits are parameterized', custom.truncated && custom.text.length === 4, String(custom.text.length))
check('an empty body is not truncated', !displayBody('').truncated)

// Cutting Markdown is not cutting text: an unterminated ``` fence re-means every
// line after it, so a truncated body would render its own tail as code.
check('balanced fences are left alone',
  closeOpenFence('a\n```js\ncode\n```\nb') === 'a\n```js\ncode\n```\nb')
check('text with no fence is left alone', closeOpenFence('just prose') === 'just prose')
check('an open fence is closed', closeOpenFence('intro\n```\nlet x = 1') === 'intro\n```\nlet x = 1\n```')
check('an indented fence still counts', closeOpenFence('  ```\nx') === '  ```\nx\n```')
check('two open fences are treated as one pair', closeOpenFence('```\na\n```\nb') === '```\na\n```\nb')

// ---------------------------------------------------------------------------
// The time basis
// ---------------------------------------------------------------------------
const createdOrder = buildRows(payload, 'created').map((r) => r.at).join()
const updatedOrder = buildRows(payload, 'updated').map((r) => r.at).join()
check('the two time bases produce different orders', createdOrder !== updatedOrder)
check('the created order is sorted', buildRows(payload, 'created').every((r, i, all) => i === 0 || all[i - 1].at <= r.at))
check('the updated order is sorted', buildRows(payload, 'updated').every((r, i, all) => i === 0 || all[i - 1].at <= r.at))
check('sessions keep their creation time under the activity basis',
  buildRows(payload, 'updated').filter((r) => r.kind === 'session').every((r) => r.at < at(10)))

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
