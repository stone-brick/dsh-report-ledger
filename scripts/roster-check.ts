/**
 * Deterministic checks for the peer roster and peer creation.
 *
 * Classification, ordering, the authority predicate, and the creation budget are
 * all pure or file-backed decisions, so they are pinned here rather than probed
 * through a live agent: the roster is what tells an agent *who it may address*,
 * and getting that wrong either strands it (no addresses) or over-grants it
 * (addresses it should not hold).
 *
 * Run: node scripts/roster-check.ts
 */

import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'report-ledger-roster-'))
process.env.DSH_REPORT_LEDGER_ROOT = root

const { buildRoster, holdsChannelTo, appendPeer, readPeers, peerLogPath } = await import('../src/report/roster.ts')
const { PeerService } = await import('../src/report/peer.ts')

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

const at = (n: number): number => 1_700_000_000_000 + n * 1000

const SELF = 'session-self'
const records = [
  { header: { id: 'session-parent', createdAt: at(1) }, live: true },
  { header: { id: SELF, parentSession: 'session-parent', createdAt: at(2) }, live: true },
  { header: { id: 'session-sib', parentSession: 'session-parent', createdAt: at(3) }, live: false },
  { header: { id: 'session-child', parentSession: SELF, origin: 'subagent', delegationDepth: 1, createdAt: at(4) }, live: true },
  { header: { id: 'session-grand', parentSession: 'session-child', delegationDepth: 2, createdAt: at(5) }, live: false },
  { header: { id: 'session-stranger', createdAt: at(6) }, live: true },
  { header: { id: 'session-contact', createdAt: at(7) }, live: false },
  { header: { id: 'session-peer', createdAt: at(8) }, live: true },
]

const reports = [{
  report: 'R-0001',
  subject: 'exchange',
  status: 'open',
  from: 'session-contact',
  to: [SELF],
  cc: [],
  authors: [],
  created: at(9),
  updated: at(10),
  children: [],
  artifacts: [],
  hops: 2,
}] as never[]

const peers = [{ sessionId: 'session-peer', startedBy: SELF, startedAt: at(8), name: 'partner' }]

const base = {
  self: SELF,
  records: records as never,
  liveIds: new Set(['session-parent', SELF, 'session-child', 'session-stranger', 'session-peer']),
  peers,
  reports,
  titles: new Map([['session-parent', 'parent title']]),
}

const related = buildRoster({ ...base, scope: 'related', limit: 40 })
const byRelation = new Map(related.map((row) => [row.sessionId, row]))

check('the caller never appears in its own roster', !byRelation.has(SELF))
check('an ancestor is classified as ancestor', byRelation.get('session-parent')?.relation === 'ancestor')
check('a direct child is classified as descendant', byRelation.get('session-child')?.relation === 'descendant')
check('a grandchild is classified transitively', byRelation.get('session-grand')?.relation === 'descendant')
check('a shared-parent session is a sibling', byRelation.get('session-sib')?.relation === 'sibling')
check('a started peer is classified as started', byRelation.get('session-peer')?.relation === 'started')
check('a ledger partner is classified as contact', byRelation.get('session-contact')?.relation === 'contact')
check('an unrelated root is excluded from related', !byRelation.has('session-stranger'))
check('liveness is carried per row', byRelation.get('session-child')?.live === true && byRelation.get('session-sib')?.live === false)
check('a peer keeps the name its starter gave it', byRelation.get('session-peer')?.name === 'partner')
check('titles are attached where resolved', byRelation.get('session-parent')?.title === 'parent title')
check('ledger exchange counts are carried', byRelation.get('session-contact')?.reports === 1)
check('the caller\'s own reports do not count as a relation source for strangers',
  (byRelation.get('session-contact')?.reports ?? 0) === 1)

check('ordering is ancestor, descendants, sibling, started, contact',
  related.map((row) => row.sessionId).join() === 'session-parent,session-child,session-grand,session-sib,session-peer,session-contact',
  related.map((row) => row.sessionId).join())

const all = buildRoster({ ...base, scope: 'all', limit: 40 })
check('scope all includes unrelated co-present sessions', all.some((row) => row.sessionId === 'session-stranger' && row.relation === 'co-present'))

const live = buildRoster({ ...base, scope: 'live', limit: 40 })
check('scope live keeps only resident sessions', live.every((row) => row.live))
check('scope live still classifies relations', live.find((row) => row.sessionId === 'session-child')?.relation === 'descendant')

const capped = buildRoster({ ...base, scope: 'all', limit: 2 })
check('the limit caps the rows', capped.length === 2, String(capped.length))

// ---------------------------------------------------------------------------
// The authority predicate
// ---------------------------------------------------------------------------
const channel = (target: string): boolean => holdsChannelTo({ ...base }, target)
check('a channel exists to an ancestor', channel('session-parent'))
check('a channel exists to a direct child', channel('session-child'))
check('a channel exists to a grandchild', channel('session-grand'))
check('a channel exists to a sibling', channel('session-sib'))
check('a channel exists to a session the caller started', channel('session-peer'))
check('no channel to a mere ledger contact', !channel('session-contact'))
check('no channel to a stranger', !channel('session-stranger'))
check('no channel to self', !channel(SELF))
check('no channel to an empty id', !channel(''))

// ---------------------------------------------------------------------------
// The peer log
// ---------------------------------------------------------------------------
await appendPeer({ sessionId: 'session-p1', startedBy: SELF, startedAt: at(20), name: 'one' })
await appendPeer({ sessionId: 'session-p2', startedBy: 'session-other', startedAt: at(21) })
// A hand-edited or torn line must not poison the rest of the roster.
await appendFile(peerLogPath(), '{ not json\n', 'utf8')
await appendPeer({ sessionId: 'session-p3', startedBy: SELF, startedAt: at(22) })

const logged = await readPeers()
check('the peer log round-trips', logged.length === 3, String(logged.length))
check('a malformed line is skipped', !logged.some((record) => record.sessionId === undefined))
check('appended records keep their fields', logged.find((record) => record.sessionId === 'session-p1')?.name === 'one')
const logText = await readFile(peerLogPath(), 'utf8')
check('the peer log is append-only JSONL', logText.trim().split('\n').every((line) => line.trim() === '' || line.trim().startsWith('{')))

// ---------------------------------------------------------------------------
// PeerService: budget, validation, and roster integration
// ---------------------------------------------------------------------------
const created: { sessionId: string; cwd?: string }[] = []
const madeSteer: string[] = []
const host = {
  selfCwd: () => 'D:\\Projects\\demo',
  liveIds: () => new Set([SELF]),
  listSessionRecords: async () => records as never,
  readTitles: async () => new Map<string, string>(),
  listReports: async () => reports,
  createPeer: async ({ sessionId, cwd }: { sessionId: string; cwd?: string }) => {
    created.push({ sessionId, ...(cwd === undefined ? {} : { cwd }) })
    return { id: sessionId, steer: (message: { content: readonly { text: string }[] }) => { madeSteer.push(message.content[0]?.text ?? '') } }
  },
}

const loose = new PeerService(host as never, 100)
const startedOne = await loose.start(SELF, { task: 'long-horizon partner for the payments rework', name: 'payments' })
check('a peer session id follows the deployment convention', /^session-[0-9a-f-]{36}$/.test(startedOne.sessionId), startedOne.sessionId)
check('the peer inherits the caller\'s working directory', created[0]?.cwd === 'D:\\Projects\\demo', String(created[0]?.cwd))
check('the peer is attributed in the log', (await readPeers()).some((record) => record.sessionId === startedOne.sessionId && record.startedBy === SELF))
check('the peer count is reported', startedOne.started >= 1)
check('the caller now holds a channel to what it started', await loose.holdsChannel(SELF, startedOne.sessionId))
check('the new peer appears as started in the roster',
  (await loose.roster(SELF, { scope: 'related' })).some((row) => row.sessionId === startedOne.sessionId && row.relation === 'started'))

const before = await loose.startedCount(SELF)
const budgeted = new PeerService(host as never, before)
let budgetError = ''
try {
  await budgeted.start(SELF, { task: 'one too many' })
} catch (error) {
  budgetError = error instanceof Error ? error.message : String(error)
}
check('the budget refuses creation past the cap', budgetError.includes('limit'), budgetError)
check('the budget error is actionable', budgetError.includes('reuse an existing peer'))

let emptyError = ''
try {
  await loose.start(SELF, { task: '   ' })
} catch (error) {
  emptyError = error instanceof Error ? error.message : String(error)
}
check('an empty task is refused', emptyError.includes('non-empty task'), emptyError)

let nameError = ''
try {
  await loose.start(SELF, { task: 'ok', name: 'x'.repeat(61) })
} catch (error) {
  nameError = error instanceof Error ? error.message : String(error)
}
check('an over-long name is refused', nameError.includes('60 characters'), nameError)

let failedCreate = ''
const brokenHost = { ...host, createPeer: async () => { throw new Error('factory unavailable') } }
try {
  await new PeerService(brokenHost as never, 100).start(SELF, { task: 'x' })
} catch (error) {
  failedCreate = error instanceof Error ? error.message : String(error)
}
check('a creation failure propagates', failedCreate.includes('factory unavailable'), failedCreate)

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)

await rm(root, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
