// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts and `filter` silently resolves to the DOM's window.filter.
// Emitted as nothing; it exists so `tsc` treats the file as its own module.
export {}
/**
 * Read-path checks — the ledger's listing and delivery sweep, against a throwaway
 * ledger with plain Node.
 *
 * The read path is the part of this plugin that runs most often and is easiest to
 * break silently, so four properties are pinned here:
 *
 *  - **A digest never needs the body.** Listing reads a bounded head of each
 *    document. The head budget is a budget and not an assumption: a front matter
 *    larger than it, or a document that ends at its closing fence with no
 *    terminating newline, must fall back to a full read rather than vanish.
 *  - **The cache is derived, never authoritative.** Every shape of change —
 *    through the service, or a hand edit straight to the file — is visible on the
 *    next listing. A stat is what decides, so a stale answer cannot outlive its
 *    file, and `clearReadCache` changes no result.
 *  - **One delivery pass serves every waiting session.** Two sessions owed by two
 *    reports are served by one call; a wake and a quiet copy owed by the SAME
 *    report keep their different modes; a session that is absent stays owed; a
 *    second pass delivers nothing.
 *
 * Run: node scripts/read-path-check.ts
 */

import { appendFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReportFrontMatter } from '../src/report/types.ts'

const root = await mkdtemp(join(tmpdir(), 'report-ledger-read-path-'))
process.env.DSH_HOME = root

const { ReportService } = await import('../src/report/service.ts')
const { allocateId, appendHop, clearReadCache, listReports, readHops, readReport, reportPath, reportsDir, routePath } = await import('../src/report/ledger.ts')
const { pendingTargets } = await import('../src/report/deliver.ts')

/** Agents resident for this run, and how a digest reached each one. */
const live = new Set<string>()
const inbox: { target: string; kind: 'steer' | 'inject'; text: string }[] = []

const service = new ReportService({
  getAgent(sessionId) {
    if (!live.has(sessionId)) return undefined
    return {
      id: sessionId,
      steer: (message) => { inbox.push({ target: sessionId, kind: 'steer', text: message.content[0]?.text ?? '' }) },
      inject: (message) => { inbox.push({ target: sessionId, kind: 'inject', text: message.content[0]?.text ?? '' }) },
    }
  },
  describe: async (sessionId) => `name-of-${sessionId}`,
})

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

/** The digest of one id in the current listing, or `undefined`. */
const listed = async (id: string): Promise<ReportFrontMatter | undefined> => {
  const digests = await listReports()
  return digests.find((front) => front.report === id)
}

/** Write one hand-made document into the ledger. */
const writeDocument = async (id: string, text: string): Promise<void> => {
  await mkdir(reportsDir(), { recursive: true })
  await writeFile(reportPath(id), text, 'utf8')
}

// ---- 1. a digest is listed without its body ------------------------------
// The body is larger than the head budget by two orders of magnitude; a listing
// that read it would still be correct, only slow, so what is asserted here is
// that the RESULT is unaffected — the digest of a report is the same whether it
// came from a head or from the whole document.
const bigBodyId = 'R-7000'
await writeDocument(bigBodyId, `---\nreport: "${bigBodyId}"\nsubject: "big body"\nfrom: "s"\n---\n\n${'body line\n'.repeat(12_000)}`)
const bigListed = await listed(bigBodyId)
check('a report with a huge body is listed', bigListed?.subject === 'big body', String(bigListed?.subject))
check('its digest is what a full read reports',
  (await readReport(bigBodyId))?.front.subject === bigListed?.subject)
check('a full read still returns the whole body',
  ((await readReport(bigBodyId))?.body.length ?? 0) > 100_000, String((await readReport(bigBodyId))?.body.length))

// ---- 2. the head budget is a budget, not an assumption --------------------
// A front matter larger than the head must fall back to a full read. This one is
// built out of recipients, which is the only field that grows without bound.
const wideId = 'R-7001'
const recipients = Array.from({ length: 1400 }, (_, index) => `  - "S-${String(index).padStart(5, '0')}"`).join('\n')
await writeDocument(wideId, `---\nreport: "${wideId}"\nsubject: "wide front matter"\nfrom: "s"\ncc:\n${recipients}\n---\n\nbody\n`)
const wideListed = await listed(wideId)
check('a front matter larger than the read head is still listed', wideListed?.subject === 'wide front matter',
  String(wideListed?.subject))
check('every recipient beyond the head budget survives', wideListed?.cc.length === 1400, String(wideListed?.cc.length))

// A document that ends at its closing fence with no trailing newline: in a prefix
// that is indistinguishable from a cut in the middle of a longer line, so the
// listing must fall back to a full read instead of dropping the report.
const noNewlineId = 'R-7002'
await writeDocument(noNewlineId, `---\nreport: "${noNewlineId}"\nsubject: "ends at the fence"\nfrom: "s"\ncc:\n${recipients}\n---`)
check('a document ending at its fence with no newline is listed', (await listed(noNewlineId))?.subject === 'ends at the fence',
  String((await listed(noNewlineId))?.subject))

// CRLF and a BOM are what a hand edit on Windows actually produces.
const crlfId = 'R-7003'
await writeDocument(crlfId, `\uFEFF---\r\nreport: "${crlfId}"\r\nsubject: "crlf"\r\nfrom: "s"\r\n---\r\n\r\nbody line\r\n`)
check('a BOM+CRLF document is listed', (await listed(crlfId))?.subject === 'crlf', String((await listed(crlfId))?.subject))

// An unterminated block is not a report, and it must not take the listing down.
const brokenId = 'R-7004'
await writeDocument(brokenId, `---\nreport: "${brokenId}"\nsubject: "never closed"\nfrom: "s"\n${'more: text\n'.repeat(2000)}`)
check('an unterminated front matter is not listed', (await listed(brokenId)) === undefined)
check('it does not hide the healthy reports', (await listed(bigBodyId)) !== undefined)

// ---- 3. the cache is derived, not authoritative --------------------------
live.add('session-a')
const authored = await service.author({ subject: 'cache subject', body: 'first body', actor: 'session-a' })
const id = authored.front.report
check('a write is visible to the very next listing', (await listed(id))?.subject === 'cache subject',
  String((await listed(id))?.subject))

// A hand edit straight to the file, changing only the content — every cached
// answer for this report must be rebuilt from the disk.
await new Promise((resolve) => setTimeout(resolve, 10))
await writeFile(reportPath(id), (await readFile(reportPath(id), 'utf8')).replace('cache subject', 'hand edited'), 'utf8')
check('a hand edit is visible to the next listing', (await listed(id))?.subject === 'hand edited',
  String((await listed(id))?.subject))

// Same byte length, different bytes: a size check alone would call this unchanged.
await new Promise((resolve) => setTimeout(resolve, 10))
await writeFile(reportPath(id), (await readFile(reportPath(id), 'utf8')).replace('hand edited', 'edited by hand'), 'utf8')
check('a same-size hand edit is visible too', (await listed(id))?.subject === 'edited by hand',
  String((await listed(id))?.subject))

// An in-place append (a contribution) leaves the digest fields alone but must not
// hide the new text from a reader.
await service.contribute(id, 'session-a', 'second section')
check('a contribution is visible after a cached listing',
  (await readReport(id))?.body.includes('second section') === true)
check('a contribution is recorded as a hop',
  (await readHops(id)).some((hop) => hop.action === 'contributed'))

// A hop appended through the service must not be masked by a cached path.
await service.send(id, 'session-a', ['session-b'])
check('a new hop is visible to the next path read',
  (await readHops(id)).some((hop) => hop.action === 'sent' && hop.to.includes('session-b')))

// Deleting a report must remove it from both caches.
const doomed = await service.author({ subject: 'short-lived', body: 'x', actor: 'session-a' })
await unlink(reportPath(doomed.front.report))
await unlink(join(reportsDir(), `${doomed.front.report}.route.jsonl`))
check('a deleted report leaves the listing', (await listed(doomed.front.report)) === undefined)
check('a deleted report has no transfer path', (await readHops(doomed.front.report)).length === 0)

const beforeClear = (await listReports()).map((front) => `${front.report}:${front.subject}:${front.updated}`).join('\n')
clearReadCache()
const afterClear = (await listReports()).map((front) => `${front.report}:${front.subject}:${front.updated}`).join('\n')
check('clearing the cache changes no answer', beforeClear === afterClear)

// The listing is unsorted data until it is sorted: most recent activity first.
const older = await service.author({ subject: 'older', body: 'x', actor: 'session-a' })
await new Promise((resolve) => setTimeout(resolve, 5))
const newer = await service.author({ subject: 'newer', body: 'x', actor: 'session-a' })
const order = await listReports()
check('the listing is newest activity first',
  order.findIndex((front) => front.report === newer.front.report) < order.findIndex((front) => front.report === older.front.report),
  order.map((front) => front.report).join())

// ---- 4. one delivery pass serves every waiting session -------------------
live.clear()
inbox.length = 0
// Two sessions, two reports, one owed hand-off each.
const toOne = await service.author({ subject: 'owed to one', body: 'x', actor: 'session-a', to: ['session-one'] })
const toTwo = await service.author({ subject: 'owed to two', body: 'x', actor: 'session-a', to: ['session-two'] })
check('both hand-offs are held while the recipients are absent',
  pendingTargets(await readHops(toOne.front.report)).includes('session-one')
  && pendingTargets(await readHops(toTwo.front.report)).includes('session-two'))

live.add('session-one')
live.add('session-two')
const swept = await service.flushSessions(['session-one', 'session-two'])
check('one pass delivers to both waiting sessions',
  swept.filter((outcome) => outcome.status === 'delivered').length === 2, JSON.stringify(swept))
check('each session received its own report',
  inbox.some((entry) => entry.target === 'session-one' && entry.text.includes(toOne.front.report))
  && inbox.some((entry) => entry.target === 'session-two' && entry.text.includes(toTwo.front.report)))
check('nothing is left pending after the pass',
  pendingTargets(await readHops(toOne.front.report)).length === 0
  && pendingTargets(await readHops(toTwo.front.report)).length === 0)
check('a second pass delivers nothing', (await service.flushSessions(['session-one', 'session-two'])).length === 0)
check('a pass with no sessions touches nothing', (await service.flushSessions([])).length === 0)

// A wake and a quiet copy owed by the SAME report must not collapse into one mode:
// the addressed recipient has to run, the carbon copy must not be disturbed.
inbox.length = 0
const mixed = await service.author({
  subject: 'wake one, copy another',
  body: 'x',
  actor: 'session-a',
  to: ['session-three'],
  cc: ['session-four'],
})
live.add('session-three')
live.add('session-four')
await service.flushSessions(['session-three', 'session-four'])
check('the addressed recipient is woken',
  inbox.some((entry) => entry.target === 'session-three' && entry.kind === 'steer'),
  JSON.stringify(inbox.map((entry) => `${entry.target}:${entry.kind}`)))
check('the carbon copy is delivered quietly',
  inbox.some((entry) => entry.target === 'session-four' && entry.kind === 'inject'),
  JSON.stringify(inbox.map((entry) => `${entry.target}:${entry.kind}`)))
check('both owed hand-offs are discharged',
  pendingTargets(await readHops(mixed.front.report)).length === 0,
  pendingTargets(await readHops(mixed.front.report)).join())

// A session that is still absent stays owed, and one malformed neighbour does not
// stop the sweep for the others.
const absent = await service.author({ subject: 'owed to an absent session', body: 'x', actor: 'session-a', to: ['session-gone'] })
await writeDocument('R-7999', 'not a report at all\n')
live.add('session-five')
const present = await service.author({ subject: 'owed to a present session', body: 'x', actor: 'session-a', to: ['session-five'] })
await service.flushSessions(['session-gone', 'session-five'])
check('a broken neighbour does not stop the sweep', pendingTargets(await readHops(present.front.report)).length === 0,
  pendingTargets(await readHops(present.front.report)).join())
check('the present recipient received its hand-off',
  inbox.some((entry) => entry.target === 'session-five' && entry.text.includes(present.front.report)))
check('an absent recipient is still owed', pendingTargets(await readHops(absent.front.report)).join() === 'session-gone',
  pendingTargets(await readHops(absent.front.report)).join())

// A hand-edited `report:` field must not become the identity. Delivery keys the
// body path and the arrival hop by `front.report`; a copied document that keeps
// another report's id would otherwise send and record against that other report.
const identityId = 'R-7101'
await writeDocument(identityId, '---\nreport: "R-7998"\nsubject: "identity"\nfrom: "s"\n---\n\nbody\n')
const identity = await readReport(identityId)
check('readReport takes its identity from the file name', identity?.front.report === identityId,
  String(identity?.front.report))

// Simulate a crash in the middle of an append: the next hop must start on a
// fresh line instead of gluing itself to the torn JSON and disappearing with it.
const tornId = 'R-7102'
await writeDocument(tornId, `---\nreport: "${tornId}"\nsubject: "torn"\nfrom: "s"\n---\n\nbody\n`)
await appendHop(tornId, { at: 1, actor: 's', action: 'authored', to: [] })
await appendFile(routePath(tornId), '{"at":2,"actor":"s","act', 'utf8')
await appendHop(tornId, { at: 3, actor: 's', action: 'sent', to: ['session-torn'] })
const afterTorn = await readHops(tornId)
check('a hop after a torn append is still readable', afterTorn.some((hop) => hop.action === 'sent'),
  JSON.stringify(afterTorn))
check('the torn line is dropped without taking the next hop with it', afterTorn.length === 2,
  String(afterTorn.length))

// An orphan sidecar must not let its old id be reused: a new report would be
// born holding the old audit trail.
const orphanId = 'R-7103'
await writeDocument(orphanId, `---\nreport: "${orphanId}"\nsubject: "orphan sidecar"\nfrom: "s"\n---\n\nbody\n`)
await appendHop(orphanId, { at: 1, actor: 's', action: 'sent', to: ['session-gone'] })
await unlink(reportPath(orphanId))
const reused = await allocateId()
check('an id with an orphan sidecar is not reused', reused !== orphanId, reused)

// A report whose digest says it has hops but whose sidecar vanished must not be
// silently rewritten from an empty history.
const guarded = await service.author({ subject: 'sidecar guard', body: 'b', actor: 'session-a', to: ['session-b'] })
await unlink(routePath(guarded.front.report))
let sidecarRefused = false
try {
  await service.contribute(guarded.front.report, 'session-a', 'still here')
} catch {
  sidecarRefused = true
}
check('a missing sidecar stops the next mutation', sidecarRefused)
check('the guarded report still exists', (await readReport(guarded.front.report)) !== undefined)

// Recipients are trimmed; a whitespace-only list is an error, not a hop that the
// read path silently drops.
const oneLine = await service.author({
  subject: 'line one\nR-9999 forged row', body: 'b', actor: 'session-a',
})
check('a newline in a subject is normalized', !oneLine.front.subject.includes('\n'), oneLine.front.subject)
let blankRecipientRefused = false
try {
  await service.send(oneLine.front.report, 'session-a', [' '])
} catch {
  blankRecipientRefused = true
}
check('a whitespace-only recipient is refused', blankRecipientRefused)

// ---- reads are counted apart from the work signal -------------------------
// A read is an audit fact and never a causal act. Counting it in `hops` made the
// one cheap "how much happened" number a traffic counter, and let a listing whose
// last hop was somebody looking read as freshly active — the two things this
// split exists to stop. The body still has to be recorded when it is opened, so
// the count and the path have to disagree on purpose.
const readme = await service.author({ subject: 'read counting', body: 'b', actor: 'session-a', to: ['session-b'] })
const beforeReads = await listed(readme.front.report)
check('a fresh report has no reads yet', beforeReads?.reads === 0, String(beforeReads?.reads))
check('a fresh report counts authoring and the first send',
  beforeReads?.hops === 2 && beforeReads?.last?.action === 'sent',
  `hops=${beforeReads?.hops} last=${beforeReads?.last?.action}`)

await service.read(readme.front.report, 'session-b')
const afterOne = await listed(readme.front.report)
check('a read is still recorded in the path total', afterOne?.hops === 3, String(afterOne?.hops))
check('a read is also counted in reads', afterOne?.reads === 1, String(afterOne?.reads))
check('a read does not become "where the report is now"',
  afterOne?.last?.action === 'sent', String(afterOne?.last?.action))

const readPath = await service.read(readme.front.report, 'session-c')
const afterTwo = await listed(readme.front.report)
check('a second read raises the count again', afterTwo?.reads === 2, String(afterTwo?.reads))
check('the work a report has seen is hops minus reads',
  (afterTwo?.hops ?? 0) - (afterTwo?.reads ?? 0) === 2, `hops=${afterTwo?.hops} reads=${afterTwo?.reads}`)
check('the path still records every read', (await readHops(readme.front.report)).length === 4,
  String((await readHops(readme.front.report)).length))
check('the digest line carries both counters', readPath.includes('hops=4 | reads=2'), readPath.split('\n')[0])
check('the path opens with a per-action tally',
  readPath.includes('4 hop(s): authored 1, sent 1, read 2'), readPath.split('\n').slice(0, 8).join('\n'))

// A causal hop still moves `last` once reads have piled up.
await service.contribute(readme.front.report, 'session-b', 'now it moved')
const afterWork = await listed(readme.front.report)
check('a contribution moves last past the reads', afterWork?.last?.action === 'contributed', String(afterWork?.last?.action))
check('a contribution counts as work, not as a read',
  afterWork?.hops === 5 && afterWork?.reads === 2, `hops=${afterWork?.hops} reads=${afterWork?.reads}`)

// ---- repairing a digest written before the split --------------------------
// Front matter is a cache, so a document from before `reads` existed reports zero
// until something rebuilds it. The repair pass is that something; it must be
// idempotent, must not stamp `updated` (a repair is not activity), and must leave
// a report whose path is missing alone.
const staleId = readme.front.report
const staleDocument = await readReport(staleId)
const staleText = (await readFile(reportPath(staleId), 'utf8'))
  .replace(/^hops: \d+$/m, 'hops: 41')
  .replace(/^reads: \d+$/m, 'reads: 0')
await writeFile(reportPath(staleId), staleText, 'utf8')
check('the fixture was made stale', staleText.includes('hops: 41') && staleText.includes('reads: 0'),
  staleText.slice(0, 200))

const dry = await service.repairDigests({ dryRun: true })
const dryFor = dry.find((repair) => repair.report === staleId)
check('a dry run reports what would change', dryFor?.changed === true, JSON.stringify(dryFor))
check('a dry run writes nothing', (await listed(staleId))?.hops === 41, String((await listed(staleId))?.hops))

const pass = await service.repairDigests()
const repaired = pass.find((repair) => repair.report === staleId)
check('the sweep rewrites a stale digest', repaired?.changed === true, JSON.stringify(repaired))
const afterRepair = await listed(staleId)
check('the repaired digest matches its hop stream', afterRepair?.hops === 5 && afterRepair?.reads === 2,
  `hops=${afterRepair?.hops} reads=${afterRepair?.reads}`)
check('a repair does not restamp updated, so a listing keeps its order',
  afterRepair?.updated === staleDocument?.front.updated, `${afterRepair?.updated} vs ${staleDocument?.front.updated}`)
const secondPass = await service.repairDigests()
check('a second sweep rewrites nothing',
  secondPass.every((repair) => !repair.changed || repair.skipped !== undefined),
  secondPass.filter((repair) => repair.changed && repair.skipped === undefined).map((repair) => repair.report).join(','))
// The fixture above whose sidecar was deleted: rebuilding it from an empty history
// would erase its recipients, so the sweep must report it and leave it alone.
check('a report whose path is gone is reported, not rewritten',
  secondPass.find((repair) => repair.report === guarded.front.report)?.skipped !== undefined,
  JSON.stringify(secondPass.find((repair) => repair.report === guarded.front.report)))

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)

await rm(root, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
