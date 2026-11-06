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
// `ledgerRoot` prefers the documented override over DSH_HOME. Pin it too: a
// developer who has set it (to test the override itself, for example) must not
// have `pnpm test` write these fixtures into that ledger.
process.env.DSH_REPORT_LEDGER_ROOT = join(root, 'report-ledger')

const { ReportService } = await import('../src/report/service.ts')
const { allocateId, appendHop, clearReadCache, listReports, readHops, readReport, reportPath, reportsDir, routePath, writeReport } = await import('../src/report/ledger.ts')
const { pendingTargets } = await import('../src/report/deliver.ts')
const { registerReportTools } = await import('../src/report/tools.ts')

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

// An EMPTY sidecar is the crash shape the missing-file guard did not cover: the
// file exists, so the old check passed, and the read that only wanted to record
// "somebody opened this" projected an empty history over the digest and erased
// its recipients. A read must refuse too — it records a hop.
const emptied = await service.author({
  subject: 'empty sidecar', body: 'b', actor: 'session-a', to: ['session-empty-b'],
})
await writeFile(routePath(emptied.front.report), '')
let emptyRefused = false
try {
  await service.read(emptied.front.report, 'session-empty-b')
} catch {
  emptyRefused = true
}
check('an empty sidecar stops a read before it can erase the digest', emptyRefused)
const emptiedAfter = await readReport(emptied.front.report)
check('a refused read leaves the digest and its recipients intact',
  emptiedAfter?.front.to.includes('session-empty-b') === true && emptiedAfter.front.hops === 2,
  `to=${emptiedAfter?.front.to.join(',')} hops=${emptiedAfter?.front.hops}`)
const emptyDry = (await service.repairDigests({ dryRun: true }))
  .find((repair) => repair.report === emptied.front.report)
check('the dry run reports an empty sidecar as damaged, not repairable',
  emptyDry?.skipped !== undefined, JSON.stringify(emptyDry))

// A record that cannot even be parsed, or a directory where a document belongs,
// must be named by a diagnostic sweep rather than silently omitted.
const unparseable = 'R-7104'
await writeFile(join(reportsDir(), `${unparseable}.md`), 'not a report\n', 'utf8')
const unreadable = 'R-7105'
await mkdir(join(reportsDir(), `${unreadable}.md`), { recursive: true })
const diagnostic = await service.repairDigests({ dryRun: true })
check('an unparseable document is reported by the sweep',
  diagnostic.find((repair) => repair.report === unparseable)?.skipped !== undefined,
  JSON.stringify(diagnostic.find((repair) => repair.report === unparseable)))
check('a directory where a document belongs is reported by the sweep',
  diagnostic.find((repair) => repair.report === unreadable)?.skipped !== undefined,
  JSON.stringify(diagnostic.find((repair) => repair.report === unreadable)))

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

// ---- drift is not only the counters --------------------------------------
// The repair pass compares the whole derived projection. A hand edit that only
// touches `to` leaves hops/reads/last identical, so a counters-only check would
// report "in agreement" and never restore the recipients.
const drifted = await readReport(staleId)
check('the recipient-drift fixture is readable', drifted !== undefined)
if (drifted !== undefined) {
  const to = drifted.front.to
  await writeReport(
    { front: { ...drifted.front, to: [...to, 'session-ghost-drift'] }, body: drifted.body },
    staleId,
  )
  const scoped = await service.repairDigests({ dryRun: true, report: staleId })
  check('a scoped dry run checks only that report', scoped.length === 1, JSON.stringify(scoped.map((row) => row.report)))
  check('a recipient list that disagrees with the path is drift too',
    scoped[0]?.changed === true, JSON.stringify(scoped[0]))
  await service.repairDigests({ report: staleId })
  const restored = await readReport(staleId)
  check('a scoped repair restores the recipients from the path',
    restored?.front.to.join(',') === to.join(','),
    `to=${restored?.front.to.join(',')} expected=${to.join(',')}`)
}

const secondPass = await service.repairDigests()
check('a second sweep rewrites nothing',
  secondPass.every((repair) => !repair.changed || repair.skipped !== undefined),
  secondPass.filter((repair) => repair.changed && repair.skipped === undefined).map((repair) => repair.report).join(','))
// The fixture above whose sidecar was deleted: rebuilding it from an empty history
// would erase its recipients, so the sweep must report it and leave it alone.
check('a report whose path is gone is reported, not rewritten',
  secondPass.find((repair) => repair.report === guarded.front.report)?.skipped !== undefined,
  JSON.stringify(secondPass.find((repair) => repair.report === guarded.front.report)))

// ---- long bodies: outline, head+tail, and windowed reads ------------------
// The failure these pin: a head-only excerpt of a long body hid the newest
// section, which is exactly what a returning reader opens a running report for.
// The fix is a head AND a tail, a line-numbered outline, and a windowed read so
// a specific section can be fetched by the line the outline printed.
const longLines: string[] = ['# plan', '', '```', '# not a heading', '```', '']
for (let index = 0; index < 400; index++) longLines.push(`step ${index}: ${'x'.repeat(40)}`)
longLines.push('', '## closing note', '', 'the tail marker line')
const longAuthored = await service.author({ subject: 'long body', body: longLines.join('\n'), actor: 'session-a' })
const longId = longAuthored.front.report
await service.contribute(longId, 'session-a', 'newest decision: ship it')

const longBody = (await readReport(longId))?.body.trim() ?? ''
const longBodyLines = longBody.split('\n')
const totalLong = longBodyLines.length
const contributionLine = longBodyLines.findIndex((line) => line.startsWith('### contribution by')) + 1
const newestLine = longBodyLines.findIndex((line) => line === 'newest decision: ship it') + 1
check('the long-body fixture is large enough to be excerpted', longBody.length > 8000, String(longBody.length))
check('the long-body fixture has a contribution at its end', contributionLine > 0 && newestLine === totalLong,
  `contribution=${contributionLine} newest=${newestLine} total=${totalLong}`)

const excerpt = await service.read(longId, 'session-b')
check('a long body comes back as a head-and-tail excerpt', excerpt.includes(`head and tail of ${totalLong} body lines`),
  excerpt.split('\n').slice(-6).join(' | '))
check('the excerpt keeps the oldest section (the head)', excerpt.includes('# plan'))
check('the excerpt keeps the newest section (the tail a head-only cut hid)',
  excerpt.includes('newest decision: ship it'))
check('the excerpt does not carry the whole body', excerpt.length < longBody.length,
  `${excerpt.length} vs ${longBody.length}`)
check('the middle of a long body is left out of the excerpt', !excerpt.includes('step 200:'),
  excerpt.includes('step 200:') ? 'middle present' : '')

// The outline is derived from the body and numbered in body lines; it is what
// makes "fetch that section" answerable without a second guess.
const bodyHeaderAt = excerpt.indexOf('\n## body')
const outlineStart = excerpt.indexOf('## outline')
const outlinePart = outlineStart < 0 || bodyHeaderAt < 0 ? '' : excerpt.slice(outlineStart, bodyHeaderAt)
check('a long body carries an outline', outlinePart.startsWith('## outline'), outlinePart.slice(0, 80))
check('the outline numbers a heading with its body line',
  new RegExp(`\\b1\\s+# plan`).test(outlinePart), outlinePart.slice(0, 120))
check('the outline numbers the newest contribution by its body line',
  new RegExp(`\\b${contributionLine}\\s+### contribution by`).test(outlinePart),
  outlinePart.split('\n').filter((line) => line.includes('contribution')).join(' | '))
check('the outline numbers the closing heading',
  new RegExp(`\\b${longBodyLines.indexOf('## closing note') + 1}\\s+## closing note`).test(outlinePart))
check('the outline skips a heading inside a fenced code block', !outlinePart.includes('not a heading'),
  outlinePart.split('\n').filter((line) => line.includes('heading')).join(' | '))

// A window is an exact slice by body line — the same unit the outline prints —
// and it is not accompanied by the outline, because the caller already has one.
const windowed = await service.read(longId, 'session-b', { offset: contributionLine, limit: 3 })
const windowedBody = windowed.split('\n## body')[1] ?? ''
check('a window is labelled with its body line range',
  windowedBody.startsWith(` (body lines ${contributionLine}-${contributionLine + 2} of ${totalLong})`),
  windowedBody.slice(0, 120))
check('a window returns exactly the requested lines',
  windowedBody.includes(longBodyLines.slice(contributionLine - 1, contributionLine + 2).join('\n')))
const earlyWindow = await service.read(longId, 'session-b', { offset: 10, limit: 3 })
check('a window short of the end names the next line to continue from',
  (earlyWindow.split('\n## body')[1] ?? '').includes('continue with report_read offset=13'),
  (earlyWindow.split('\n## body')[1] ?? '').slice(-160))
check('a window does not repeat the outline', !windowed.includes('## outline'))

const lastWindow = await service.read(longId, 'session-b', { offset: totalLong - 1, limit: 5 })
const lastWindowBody = lastWindow.split('\n## body')[1] ?? ''
check('a window past the end is clamped to the last line',
  lastWindowBody.startsWith(` (body lines ${totalLong - 1}-${totalLong} of ${totalLong})`), lastWindowBody.slice(0, 120))
check('a window that reaches the end has no continuation', !lastWindowBody.includes('continue with report_read'))

const beyond = await service.read(longId, 'session-b', { offset: totalLong + 5 })
check('an offset past the end says so instead of failing', beyond.includes(`no body line ${totalLong + 5}`),
  beyond.split('\n').find((line) => line.includes('no body line')) ?? beyond.slice(0, 120))

let badOffsetRefused = false
try {
  await service.read(longId, 'session-b', { offset: 0 })
} catch {
  badOffsetRefused = true
}
check('a zero offset is refused', badOffsetRefused)
let badLimitRefused = false
try {
  await service.read(longId, 'session-b', { limit: 0 })
} catch {
  badLimitRefused = true
}
check('a zero limit is refused', badLimitRefused)

const beforeWindowReads = await listed(longId)
await service.read(longId, 'session-b', { offset: 1, limit: 2 })
const afterWindowReads = await listed(longId)
check('a windowed read is still recorded as a read',
  (afterWindowReads?.reads ?? 0) === (beforeWindowReads?.reads ?? 0) + 1,
  `reads=${beforeWindowReads?.reads}->${afterWindowReads?.reads}`)

// A body that fits the inline limit is shown whole and gets no outline: the
// outline exists to navigate a body the reader cannot see in one piece.
const shortRead = await service.read(readme.front.report, 'session-b')
check('a short body is shown whole with no outline',
  shortRead.includes('\n## body\n') && !shortRead.includes('## outline'))
check('a short body is not labelled with a line range', !shortRead.includes('head and tail of'))

// ---- one thread, listed from digests alone --------------------------------
// The tree is written from both ends (`parent` on the child, `children` on the
// parent), so the listing has to merge them; and it must cost nothing beyond the
// digest scan — opening a body for a map would make a glance an audit event.
const threadRoot = await service.author({ subject: 'thread root', body: 'root body', actor: 'session-a', task: 'line-x' })
const lineA = await service.author({ subject: 'line A', body: 'a', actor: 'session-a', parent: threadRoot.front.report })
const lineB = await service.author({ subject: 'line B', body: 'b', actor: 'session-a', parent: threadRoot.front.report })
const lineADetail = await service.author({ subject: 'line A detail', body: 'g', actor: 'session-a', parent: lineA.front.report })

const hopsBeforeThread = (await readHops(threadRoot.front.report)).length
const thread = await service.thread(threadRoot.front.report)
check('a thread lists the root and every descendant', thread?.rows.length === 4, String(thread?.rows.length))
const shape = thread?.rows.map((entry) => `${entry.row.report}@${entry.depth}`).join(',')
check('thread rows are in pre-order and carry their depth',
  shape === `${threadRoot.front.report}@0,${lineA.front.report}@1,${lineADetail.front.report}@2,${lineB.front.report}@1`,
  String(shape))
check('the requested report is marked, the others are not',
  thread?.rows[0]?.anchor === true && thread?.rows[1]?.anchor === false)
check('a thread records no read hop', (await readHops(threadRoot.front.report)).length === hopsBeforeThread,
  String((await readHops(threadRoot.front.report)).length))
const fromMiddle = await service.thread(lineADetail.front.report)
check('a thread reached from the middle resolves the same root', fromMiddle?.root === threadRoot.front.report,
  String(fromMiddle?.root))
check('a thread from the middle marks exactly one row', fromMiddle?.rows.filter((entry) => entry.anchor).length === 1)
check('a thread of an unknown report is undefined', (await service.thread('R-9999')) === undefined)

// A hand edit can leave the two ends disagreeing. The child's `parent` alone must
// still be enough to place it, or a tree would depend on which side was written.
await writeDocument('R-7200', '---\nreport: "R-7200"\nsubject: "hand parent"\nfrom: "s"\n---\n\nroot\n')
await writeDocument('R-7201', '---\nreport: "R-7201"\nsubject: "hand child"\nfrom: "s"\nparent: "R-7200"\n---\n\nchild\n')
const merged = await service.thread('R-7201')
check('a child known only by its own parent field still joins the tree',
  merged?.root === 'R-7200' && merged?.rows.length === 2,
  JSON.stringify(merged?.rows.map((entry) => `${entry.row.report}@${entry.depth}`)))

// A cycle is a hand-edit accident, not a reason to hang a session.
await writeDocument('R-7202', '---\nreport: "R-7202"\nsubject: "cycle a"\nfrom: "s"\nparent: "R-7203"\n---\n\na\n')
await writeDocument('R-7203', '---\nreport: "R-7203"\nsubject: "cycle b"\nfrom: "s"\nparent: "R-7202"\n---\n\nb\n')
const cycle = await service.thread('R-7202')
check('a parent/children cycle stops instead of hanging', cycle?.rows.length === 2, String(cycle?.rows.length))
check('a cut cycle is reported rather than silently shortened', (cycle?.note ?? '').includes('cycle'),
  String(cycle?.note))

// A deleted document leaves a hole on one side or the other. Both are reported:
// a line that quietly lost a member is worse than one that says so.
await writeDocument('R-7204', '---\nreport: "R-7204"\nsubject: "orphaned by a deleted parent"\nfrom: "s"\nparent: "R-9998"\n---\n\na\n')
const orphan = await service.thread('R-7204')
check('a parent missing from the ledger is named', (orphan?.note ?? '').includes('parent R-9998'),
  String(orphan?.note))
check('an orphaned report still lists itself', orphan?.root === 'R-7204' && orphan?.rows.length === 1,
  JSON.stringify(orphan?.rows.map((entry) => entry.row.report)))
await writeDocument('R-7205', '---\nreport: "R-7205"\nsubject: "dangling child"\nfrom: "s"\nchildren:\n  - "R-9997"\n---\n\na\n')
const dangling = await service.thread('R-7205')
check('a listed child missing from the ledger is named', (dangling?.note ?? '').includes('R-9997'),
  String(dangling?.note))

// ---- the tool surface for a thread ----------------------------------------
// The service can produce a tree; the tool has to render it, mark the anchor and
// refuse to pretend a filtered tree answers the same question.
const captured = new Map<string, { name: string; execute(args: unknown, exec: unknown): Promise<string> }>()
const fakeCtx = {
  tools: {
    register(definition: unknown): () => void {
      const entry = definition as { name: string; execute(args: unknown, exec: unknown): Promise<string> }
      captured.set(entry.name, entry)
      return () => {}
    },
  },
}
registerReportTools(fakeCtx, service, {} as never, { enabled: false } as never)
const callTool = async (name: string, args: unknown): Promise<string> => {
  const entry = captured.get(name)
  if (entry === undefined) throw new Error(`tool ${name} was not registered`)
  return await entry.execute(args, {} as never)
}
const toolTree = await callTool('report_list', { thread: lineADetail.front.report })
check('report_list renders the line as a tree and marks the requested report',
  toolTree.includes(`thread ${threadRoot.front.report} (4 report(s); requested from ${lineADetail.front.report})`)
  && toolTree.includes('<- requested'), toolTree)
check('a grandchild is indented by two levels', toolTree.includes(`\n    ${lineADetail.front.report} [`), toolTree)
check('a thread tree shows the subject and status of each row',
  toolTree.includes(`[open] line A`) && toolTree.includes(`[open] thread root`), toolTree)
const combined = await callTool('report_list', { thread: threadRoot.front.report, status: 'closed' })
check('thread= refuses to be combined with a flat filter', combined.includes('selector'), combined)
const missingThread = await callTool('report_list', { thread: 'R-9999' })
check('thread= on a missing report names it', missingThread.includes('no report "R-9999"'), missingThread)
const onRoot = await callTool('report_list', { thread: threadRoot.front.report })
check('a thread requested from its root needs no "requested from" suffix', onRoot.startsWith(`thread ${threadRoot.front.report} (4 report(s))`), onRoot)

// ---- time markers ---------------------------------------------------------
// A reader of a long-lived report has to tell how old the original body is and
// when each appended section was written, without decoding the path by eye. The
// stamps are ISO with an explicit offset: unambiguous to a machine, readable to
// a human in this time zone (a bare `Z` is neither of those when it is UTC+8).
const stamped = await service.author({ subject: 'timestamped', body: 'base body', actor: 'session-a' })
const authoredAt = (await readHops(stamped.front.report)).find((hop) => hop.action === 'authored')?.at
const stampedRead = await service.read(stamped.front.report, 'session-b')
const createdStamp = stampedRead.match(/created=(\S+)/)?.[1]
check('the read front line names when the report was created', createdStamp !== undefined,
  stampedRead.split('\n')[0])
check('created= parses back to the authored hop',
  createdStamp !== undefined && Date.parse(createdStamp) === authoredAt,
  `${createdStamp} vs ${authoredAt}`)
check('created= carries an explicit UTC offset',
  createdStamp !== undefined && /[+-]\d{2}:\d{2}$/.test(createdStamp), String(createdStamp))
check('the updated stamp carries an explicit offset too',
  /updated=\S+[+-]\d{2}:\d{2}/.test(stampedRead.split('\n')[0] ?? ''), stampedRead.split('\n')[0])
check('hop times render with an offset rather than a bare Z',
  /^\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}\s/m.test(stampedRead),
  stampedRead.split('\n').find((line) => line.includes(' by ')) ?? '')

// The appended sections carry their own stamps, written when the tool ran.
await service.contribute(stamped.front.report, 'session-a', 'first add')
await service.amend(stamped.front.report, 'session-a', { body: 'second add' })
const stampedBody = (await readReport(stamped.front.report))?.body ?? ''
const contributionStamp = stampedBody.match(/### contribution by .+ at (\S+)/)?.[1]
const amendmentStamp = stampedBody.match(/### amendment by .+ at (\S+)/)?.[1]
check('a contribution header carries an explicit offset',
  contributionStamp !== undefined && /[+-]\d{2}:\d{2}$/.test(contributionStamp), String(contributionStamp))
check('the contribution header time is the append time',
  contributionStamp !== undefined && Math.abs(Date.parse(contributionStamp) - Date.now()) < 120_000,
  String(contributionStamp))
check('an amendment header carries an explicit offset',
  amendmentStamp !== undefined && /[+-]\d{2}:\d{2}$/.test(amendmentStamp), String(amendmentStamp))

// A hand-written document has no `authored` hop. The reader must not dress its
// own look up as the creation time.
await writeDocument('R-7206', '---\nreport: "R-7206"\nsubject: "no authored hop"\nfrom: "s"\n---\n\nbody only\n')
const noCreated = await service.read('R-7206', 'session-a')
check('a report with no authored hop claims no creation time', !noCreated.includes('created='),
  noCreated.split('\n')[0])

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)

await rm(root, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
