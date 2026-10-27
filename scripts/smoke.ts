// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts and `filter` silently resolves to the DOM's window.filter.
// Emitted as nothing; it exists so `tsc` treats the file as its own module.
export {}
/**
 * Ledger kernel smoke test — runs the report service against a throwaway ledger
 * root with plain Node, no harness involved.
 *
 * This exercises exactly the logic that is expensive to debug through a live
 * agent: front-matter round-tripping, hop projection, co-authorship, the
 * pending-delivery derivation that IS the durable mailbox, and the audit trail.
 *
 * Run: node scripts/smoke.ts
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'report-ledger-smoke-'))
process.env.DSH_HOME = root

const { ReportService, renderRow } = await import('../src/report/service.ts')
const { ledgerRoot, reportPath, routePath } = await import('../src/report/ledger.ts')
const { pendingMode, pendingTargets, renderDigest } = await import('../src/report/deliver.ts')
const { readHops, readReport } = await import('../src/report/ledger.ts')

/** Agents that are "resident" for this run. */
const live = new Set<string>(['session-a', 'session-b'])
/** Messages that reached a resident agent, in order. */
const inbox: { target: string; text: string }[] = []

const service = new ReportService({
  getAgent(sessionId) {
    if (!live.has(sessionId)) return undefined
    return {
      id: sessionId,
      steer: (message) => { inbox.push({ target: sessionId, text: message.content[0]?.text ?? '' }) },
      inject: (message) => { inbox.push({ target: sessionId, text: message.content[0]?.text ?? '' }) },
    }
  },
  describe: async (sessionId) => `name-of-${sessionId}`,
})

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

// ---- 1. author with an addressed recipient and a carbon copy ----------------
const authored = await service.author({
  subject: '支付模块重构完成',
  body: '第一段正文。',
  actor: 'session-a',
  to: ['session-b'],
  cc: ['session-c'],
  task: 'payment-refactor',
  artifacts: ['src/pay.ts'],
})

check('ledger root is the configured DSH_HOME', ledgerRoot() === join(root, 'report-ledger'), ledgerRoot())
check('report id is allocated', /^R-\d{4}$/.test(authored.front.report), authored.front.report)
check('to is projected from hops', authored.front.to.join() === 'session-b', authored.front.to.join())
check('cc is projected from hops', authored.front.cc.join() === 'session-c', authored.front.cc.join())
check('b is a resident recipient (delivered)', authored.outcomes.find((o) => o.targetId === 'session-b')?.status === 'delivered')
check('c is absent (queued, not refused)', authored.outcomes.find((o) => o.targetId === 'session-c')?.status === 'queued')
check('the addressed recipient got a digest message', inbox.some((m) => m.target === 'session-b' && m.text.includes(authored.front.report)))
check('the absent recipient got nothing yet', !inbox.some((m) => m.target === 'session-c'))

// The message source is durable session-format data, and format v4 refuses the
// retired catch-all kind `plugin` at admission. A digest written with it reaches
// no model at all: the recipient's first turn dies at step 1, which is exactly
// the silent-hand-off failure this pins against.
const digest = renderDigest(authored.front, reportPath(authored.front.report), 'wakeup')
check('a delivered digest carries a producer-owned source kind', digest.source.kind === 'plugin:report-ledger', digest.source.kind)

// ---- 2. the pending derivation IS the mailbox ------------------------------
const hopsAfterAuthor = await readHops(authored.front.report)
check('pending contains exactly the absent recipient', pendingTargets(hopsAfterAuthor).join() === 'session-c', pendingTargets(hopsAfterAuthor).join())

// ---- 3. co-authorship: several agents write one report ---------------------
const contributed = await service.contribute(authored.front.report, 'session-b', '第二段：我复核了边界条件。', 'reviewed')
check('second author is credited', contributed.front.authors.join() === 'session-a,session-b', contributed.front.authors.join())
const afterContribute = await readReport(authored.front.report)
check('first section survives', afterContribute?.body.includes('第一段正文。') === true)
check('second section appended', afterContribute?.body.includes('我复核了边界条件') === true)

// ---- 4. a copy is a recorded hop ------------------------------------------
await service.forward(authored.front.report, 'session-b', ['session-d'], 'copy', 'evidence for another thread')
const afterCopy = await readHops(authored.front.report)
check('copy hop recorded', afterCopy.some((h) => h.action === 'copied' && h.to.includes('session-d')))
check('copy target joins cc', (await service.list())[0]?.cc.includes('session-d') === true)

// ---- 5. the deferred recipient returns -----------------------------------
// Flushing for a session that is still absent must deliver nothing: it reports
// the target as still queued and leaves it pending, rather than dropping the
// hand-off or pretending it landed.
const noop = await service.flushForAgent('session-c')
check('flush for an absent session reports it as still queued', noop.every((o) => o.status === 'queued'), JSON.stringify(noop))
check('flush for an absent session reaches no inbox', !inbox.some((m) => m.target === 'session-c'))
check('the held hand-off is still pending', pendingTargets(await readHops(authored.front.report)).includes('session-c'))

// Now c becomes resident — the event `agent/created` signals in the real host.
live.add('session-c')
const flushed = await service.flushForAgent('session-c')
check('flush delivers the held hand-off', flushed.some((o) => o.targetId === 'session-c' && o.status === 'delivered'))
check('the returned recipient now has the digest', inbox.some((m) => m.target === 'session-c'))
const stillPending = pendingTargets(await readHops(authored.front.report))
check('only the never-returned copy target stays pending', stillPending.join() === 'session-d', stillPending.join())
check('a pending carbon copy stays quiet', pendingMode(hopsAfterAuthor, 'session-c') === 'quiet',
  pendingMode(hopsAfterAuthor, 'session-c'))
check('a later addressed hand-off overrides an earlier copy',
  pendingMode([...hopsAfterAuthor, { at: Date.now(), actor: 'session-a', action: 'sent' as const, to: ['session-c'] }], 'session-c')
    === 'wakeup')

// A recipient that was delivered once and is addressed again while absent has a
// NEW unanswered hand-off. Deriving pending as "addressed minus ever-arrived"
// loses it: the target is never queued again and the second hand-off vanishes.
const repeat = await service.author({
  subject: 're-send after an earlier arrival',
  body: 'second hand-off',
  actor: 'session-a',
  to: ['session-b'],
})
live.delete('session-b')
const requeued = await service.send(repeat.front.report, 'session-a', ['session-b'])
check('a re-send to an absent recipient is queued again',
  requeued.outcomes.find((o) => o.targetId === 'session-b')?.status === 'queued',
  JSON.stringify(requeued.outcomes))
check('a re-send after an earlier arrival is pending again',
  pendingTargets(await readHops(repeat.front.report)).includes('session-b'),
  pendingTargets(await readHops(repeat.front.report)).join())
live.add('session-b')
const reflushed = await service.flushForAgent('session-b')
check('the re-send is delivered when the recipient returns',
  reflushed.some((o) => o.targetId === 'session-b' && o.status === 'delivered'),
  JSON.stringify(reflushed))

// ---- 6. acknowledge closes the loop --------------------------------------
const acked = await service.acknowledge(authored.front.report, 'session-c', 'no action needed')
check('status moves to acked', acked.front.status === 'acked', acked.front.status)

// ---- 7. the on-disk document is what the format promises ------------------
const document = await readFile(reportPath(authored.front.report), 'utf8')
check('document starts with the front-matter fence', document.startsWith('---\n'))
check('subject is preserved verbatim in front matter', document.includes('支付模块重构完成'))

const routeText = await readFile(routePath(authored.front.report), 'utf8')
const routeLines = routeText.trim().split('\n')
check('route sidecar is append-only JSONL', routeLines.every((line) => line.trim().startsWith('{')))
check('route records the copy', routeText.includes('"copied"'))
check('route records the arrival', routeText.includes('"delivered"'))
check('route records the acknowledgement', routeText.includes('"acked"'))

// ---- 8. reading renders the full path ------------------------------------
const rendered = await service.read(authored.front.report, 'session-a')
check('read renders the transfer path', rendered.includes('## transfer path'))
check('read renders the body', rendered.includes('第一段正文。'))

// ---- 9. lifecycle: closing is the owner's act -----------------------------
let refusedToClose = ''
try {
  // session-c is a recipient (it was cc'd and acked), never an author.
  await service.close(authored.front.report, 'session-c', 'trying to close what I only received')
} catch (error) {
  refusedToClose = error instanceof Error ? error.message : String(error)
}
check('a recipient may not close a report', refusedToClose.includes('may not close'), refusedToClose)
check('the refusal names who may close it', refusedToClose.includes('session-a'), refusedToClose)
check('the refusal explains the rule', refusedToClose.includes("owner's act"), refusedToClose)

// A zero-contribution report cannot be concluded silently. The ledger cannot tell
// who was handed the work, so it refuses the one shape that hides the most:
// nothing written into the report AND nothing said at the end. Checked before any
// checkout side effect, so a refusal can never release a lease on its way out.
const silentTarget = await service.author({
  subject: 'nothing written yet', body: 'b', actor: 'session-a', to: ['session-b'],
})
const statusBeforeSilent = (await readReport(silentTarget.front.report))?.front.status
let silentClose = ''
try {
  await service.close(silentTarget.front.report, 'session-a')
} catch (error) {
  silentClose = error instanceof Error ? error.message : String(error)
}
check('a zero-contribution close without a note is refused',
  silentClose.includes('carries no note'), silentClose)
check('the refusal says what the note should contain',
  silentClose.includes('or why nothing was written'), silentClose)
check('the refused close left the report untouched',
  (await readReport(silentTarget.front.report))?.front.status === statusBeforeSilent,
  `${(await readReport(silentTarget.front.report))?.front.status} vs ${statusBeforeSilent}`)

const closed = await service.close(authored.front.report, 'session-a', 'matter concluded')
check('an author may close a report', closed.front.status === 'closed', closed.front.status)
const afterClose = await readHops(authored.front.report)
check('closing is recorded as a hop', afterClose.some((h) => h.action === 'closed'))
check('a closed report is findable by status', (await service.list({ status: 'closed' })).some((r) => r.report === authored.front.report))

// ---- 10. lifecycle: closed is a state, not a lock ------------------------
await service.contribute(authored.front.report, 'session-b', '后续补充：边界条件有新情况。', 'reopened by activity')
const afterReopen = await readReport(authored.front.report)
check('activity on a closed report reopens it', afterReopen?.front.status === 'open', String(afterReopen?.front.status))
const reopenHops = await readHops(authored.front.report)
check('the reopen is recorded as a hop', reopenHops.some((h) => h.action === 'reopened'))
const firstClosedAt = reopenHops.findIndex((h) => h.action === 'closed')
const firstReopenedAt = reopenHops.findIndex((h) => h.action === 'reopened')
check('the reopen follows the close it undoes',
  firstClosedAt >= 0 && firstReopenedAt > firstClosedAt, `${firstClosedAt} -> ${firstReopenedAt}`)
// The earlier contribution predates the close, so the invariant is about the
// FIRST contribution that follows the reopen, not the first one in the file.
const contributedAfterReopen = reopenHops.findIndex((h, index) => index > firstReopenedAt && h.action === 'contributed')
check('the activity that reopened it lands after the reopen',
  contributedAfterReopen > firstReopenedAt, `${firstReopenedAt} -> ${contributedAfterReopen}`)
check('the contribution still landed after reopening', afterReopen?.body.includes('边界条件有新情况') === true)

// ---- 11. lifecycle: a receipt is not a conclusion ------------------------
await service.close(authored.front.report, 'session-b', 'second author concludes')
const ackAfterClose = await service.acknowledge(authored.front.report, 'session-d', 'noted')
check('acking a closed report does not reopen it', ackAfterClose.front.status === 'closed', ackAfterClose.front.status)
check('acking a closed report does not downgrade it to acked', ackAfterClose.front.status !== 'acked')
const finalHops = await readHops(authored.front.report)
check('the acknowledgement is still recorded as a hop', finalHops.filter((h) => h.action === 'acked').length >= 2)
check('sending a closed report reopens it', (await service.send(authored.front.report, 'session-a', ['session-b'])).front.status === 'open')

// The rule is deliberately narrow: a report whose path already records work needs
// no prose at the end, because the ending is not the only place that work appears.
const worked = await service.author({ subject: 'already worked', body: 'b', actor: 'session-a' })
await service.contribute(worked.front.report, 'session-b', 'the work is here')
const workedClose = await service.close(worked.front.report, 'session-a')
check('a contributed report closes without a note', workedClose.front.status === 'closed', workedClose.front.status)

// `acked` says a recipient confirmed receipt; it cannot say nobody wrote anything.
// The co-author count can, so it has to survive into the listing row the model reads.
const workedRow = (await service.list()).find((row) => row.report === worked.front.report)
check('a listing row carries the co-author count', workedRow?.authors.length === 2, String(workedRow?.authors.length))
check('the rendered row shows the count', workedRow !== undefined && renderRow(workedRow).includes('authors=2'),
  workedRow === undefined ? 'no row' : renderRow(workedRow))

// ---- 12. a hand-edited ledger must not lose records ----------------------
const { parseReport } = await import('../src/report/frontmatter.ts')
const duplicated = '---\nreport: "R-0099"\nsubject: "first"\nsubject: "second"\nfrom: "s"\n---\nbody\n'
const parsedDuplicate = parseReport(duplicated)
check('a duplicated key does not make the document unreadable', parsedDuplicate !== undefined)
check('a duplicated key resolves to the last value predictably',
  parsedDuplicate?.front.subject === 'second', String(parsedDuplicate?.front.subject))
check('a document with no front matter is still refused',
  parseReport('just text\n') === undefined)
check('an unterminated front matter block is refused',
  parseReport('---\nreport: "R-0001"\nbody without a closing fence\n') === undefined)


// ---- 13. task labels group a collaboration across trees -------------------
const other = await service.author({
  subject: 'unrelated thread',
  body: 'other body',
  actor: 'session-a',
  task: 'billing-cleanup',
})
check('a task label is stored on the digest', other.front.task === 'billing-cleanup', String(other.front.task))

const byTaskPartial = await service.list({ task: 'payment' })
check('a partial task label finds the collaboration', byTaskPartial.some((r) => r.report === authored.front.report))
check('a task filter excludes other collaborations', !byTaskPartial.some((r) => r.report === other.front.report))
check('a task filter is case-insensitive', (await service.list({ task: 'PAYMENT' })).some((r) => r.report === authored.front.report))
check('a task label reaches the listing row',
  byTaskPartial.find((r) => r.report === authored.front.report)?.task === 'payment-refactor')
const sampled = byTaskPartial.find((r) => r.report === authored.front.report)
check('the listing row renders the task inline',
  sampled !== undefined && renderRow(sampled).includes('task=payment-refactor'))
check('an unmatched task label finds nothing', (await service.list({ task: 'no-such-task' })).length === 0)
check('a report with a different task is not matched',
  !(await service.list({ task: 'billing' })).some((r) => r.report === authored.front.report))

// ---- 14. amendment: corrections are recorded, never silent -----------------
const target = await service.author({
  subject: 'amendemnt target',           // deliberate typo
  body: 'original body text',
  actor: 'session-a',
  to: ['session-b'],
  cc: ['session-c'],
  task: 'old-task',
  artifacts: ['a.ts'],
})

let refusedAmend = ''
try {
  await service.amend(target.front.report, 'session-b', { subject: 'not mine to fix' })
} catch (error) {
  refusedAmend = error instanceof Error ? error.message : String(error)
}
check('a recipient may not amend a report', refusedAmend.includes('may not amend'), refusedAmend)
check('the refusal names who may amend it', refusedAmend.includes('session-a'), refusedAmend)

const fixedSubject = await service.amend(target.front.report, 'session-a', { subject: 'amendment target' })
check('an owner may fix the subject', fixedSubject.front.subject === 'amendment target', fixedSubject.front.subject)
const amendHops = await readHops(target.front.report)
const amendHop = amendHops.find((hop) => hop.action === 'amended')
check('the correction is recorded as a hop', amendHop !== undefined)
check('the hop records the old and new value verbatim',
  amendHop?.note?.includes('"amendemnt target"') === true && amendHop?.note?.includes('"amendment target"') === true,
  String(amendHop?.note))
check('co-authorship is not a thing amendment can rewrite',
  (await readReport(target.front.report))?.front.authors.join() === 'session-a')

let noopAmend = ''
try {
  await service.amend(target.front.report, 'session-a', { subject: 'amendment target' })
} catch (error) {
  noopAmend = error instanceof Error ? error.message : String(error)
}
check('an amendment that changes nothing is refused', noopAmend.includes('nothing to amend'), noopAmend)

let blankAmend = ''
try {
  await service.amend(target.front.report, 'session-a', { subject: '   ' })
} catch (error) {
  blankAmend = error instanceof Error ? error.message : String(error)
}
check('an amendment cannot blank the subject', blankAmend.includes('cannot blank'), blankAmend)

// Body: appended by default, so nobody's words are rewritten.
await service.amend(target.front.report, 'session-a', { body: 'corrected: the figure is 42.' })
const appended = await readReport(target.front.report)
check('an appended amendment keeps the original text', appended?.body.includes('original body text') === true)
check('an appended amendment adds its own section', appended?.body.includes('### amendment by') === true)
check('an appended amendment carries the new text', appended?.body.includes('the figure is 42') === true)
check('the hop says the body was appended, not replaced',
  (await readHops(target.front.report)).filter((h) => h.action === 'amended').some((h) => h.note?.includes('appended')))

// Body: a true rewrite is possible but must be asked for, and is recorded.
await service.amend(target.front.report, 'session-a', { body: 'rewritten body only', replaceBody: true })
const replaced = await readReport(target.front.report)
check('replace_body rewrites the body outright', replaced?.body.includes('original body text') === false)
check('replace_body keeps the new text', replaced?.body.includes('rewritten body only') === true)
check('the hop records that the body was replaced, not appended',
  (await readHops(target.front.report)).filter((h) => h.action === 'amended').some((h) => h.note?.includes('body replaced')))

let orphanReplace = ''
try {
  await service.amend(target.front.report, 'session-a', { replaceBody: true })
} catch (error) {
  orphanReplace = error instanceof Error ? error.message : String(error)
}
check('replace_body without a body is refused', orphanReplace.includes('without a body'), orphanReplace)

// Digest fields: task and artifacts.
await service.amend(target.front.report, 'session-a', { artifacts: ['b.ts', 'c.ts'] })
check('artifacts are replaced as a whole list',
  (await readReport(target.front.report))?.front.artifacts.join() === 'b.ts,c.ts')
await service.amend(target.front.report, 'session-a', { task: '' })
check('an empty task clears the label', (await readReport(target.front.report))?.front.task === undefined)
check('a cleared label no longer matches a task filter',
  !(await service.list({ task: 'old-task' })).some((r) => r.report === target.front.report))

// A correction is activity, so it brings a concluded report back to life.
await service.close(target.front.report, 'session-a', 'concluded for the amendment test')
check('the report closes before the reopen test', (await readReport(target.front.report))?.front.status === 'closed')
const amendedAfterClose = await service.amend(target.front.report, 'session-a', { subject: 'amended after closing' })
check('amending a closed report reopens it', amendedAfterClose.front.status === 'open', amendedAfterClose.front.status)
const reopenAfterAmend = await readHops(target.front.report)
const reopenedAt = reopenAfterAmend.findIndex((h) => h.action === 'reopened')
// Earlier amendments predate the close, so the invariant is about the FIRST
// amendment that follows the reopen — not the first one in the file.
const amendedAfterReopenAt = reopenAfterAmend.findIndex((h, index) => index > reopenedAt && h.action === 'amended')
check('the reopen precedes the amendment that caused it', reopenedAt >= 0 && amendedAfterReopenAt > reopenedAt,
  `reopen@${reopenedAt} -> amended@${amendedAfterReopenAt}`)

// ---- 15. the working-tree binding is authored state, not a projection ------
// The digest is a cache of to/cc/authors/hops/last and of nothing else, so a
// binding has to survive every refresh of those. It is also the one digest field
// git — not the ledger — is the authority for, which is exactly why the ledger
// must still remember it: git can say a branch is taken, but never by which
// report.
const boundPath = 'C:\\repo-parent\\.dsh-worktrees\\repo\\R-0015-slug'
const boundBranch = 'dsh/R-0015-worktree-binding-round-trip'
const bound = await service.author({
  subject: 'worktree binding round trip',
  body: 'bound to a checkout',
  actor: 'session-a',
  worktree: {
    path: boundPath,
    branch: boundBranch,
    head: 'a'.repeat(40),
    repo: 'C:\\repo-parent\\repo\\.git',
    allocated: true,
  },
})
check('a binding is recorded on the digest', bound.front.worktree?.branch === boundBranch,
  String(bound.front.worktree?.branch))
check('the binding records that the ledger allocated it', bound.front.worktree?.allocated === true)

const boundOnDisk = await readFile(reportPath(bound.front.report), 'utf8')
check('the binding reaches the document', boundOnDisk.includes(boundBranch))
const boundReread = await readReport(bound.front.report)
check('a Windows path survives YAML quoting and parsing',
  boundReread?.front.worktree?.path === boundPath, boundReread?.front.worktree?.path ?? '')
check('the binding keeps its head and repository',
  boundReread?.front.worktree?.head === 'a'.repeat(40)
  && boundReread?.front.worktree?.repo === 'C:\\repo-parent\\repo\\.git')

// The invariant that matters: a hop refresh rewrites the derived fields from the
// route sidecar, and must not drop a field the stream does not own.
const boundAfterHop = await service.contribute(bound.front.report, 'session-b', 'second author', 'reviewed')
check('the binding survives a hop refresh', boundAfterHop.front.worktree?.branch === boundBranch,
  String(boundAfterHop.front.worktree?.branch))
check('the hop refresh still advanced the digest', boundAfterHop.front.hops > bound.front.hops)

const byBranch = await service.list({ worktree: 'R-0015' })
const boundRow = byBranch.find((row) => row.report === bound.front.report)
check('the listing filters by a branch fragment', boundRow !== undefined)
check('the row carries the branch as its compact label', boundRow?.worktree === boundBranch, boundRow?.worktree ?? '')
check('a worktree filter ignores case',
  (await service.list({ worktree: 'r-0015' })).some((row) => row.report === bound.front.report))
check('a worktree filter also matches the path',
  (await service.list({ worktree: 'dsh-worktrees' })).some((row) => row.report === bound.front.report))
check('a worktree filter that matches nothing excludes the row',
  !(await service.list({ worktree: 'no-such-checkout' })).some((row) => row.report === bound.front.report))
check('read renders the binding', (await service.read(bound.front.report, 'session-a')).includes(boundBranch))

// ---- 16. a hand edit can only ever cost the field it edited ----------------
// A report written before the field existed, and one a human simplified to a
// bare path, must both read correctly. A binding with a branch but no path is
// dropped whole rather than half-read: claiming a branch the ledger cannot
// locate is worse than claiming nothing.
const legacyReport = parseReport('---\nreport: "R-9002"\nsubject: "legacy"\n---\n\nbody\n')
check('a report without a binding still parses', legacyReport !== undefined)
check('an absent binding stays absent', legacyReport?.front.worktree === undefined)

const shortForm = parseReport('---\nreport: "R-9001"\nsubject: "short"\nworktree: /tmp/wt\n---\n\nbody\n')
check('a bare-string binding is normalized to a path', shortForm?.front.worktree?.path === '/tmp/wt',
  shortForm?.front.worktree?.path ?? '')
check('a normalized bare-string binding invents no branch', shortForm?.front.worktree?.branch === undefined)

const halfBinding = parseReport('---\nreport: "R-9003"\nsubject: "half"\nworktree:\n  branch: dsh/x\n---\n\nbody\n')
check('a binding with no path is dropped whole, not half-read',
  halfBinding?.front.worktree === undefined, JSON.stringify(halfBinding?.front.worktree))

// ---- 17. hand-edited files: Windows line endings, identity, stray entries ---
// A Windows editor saves CRLF, and the final front-matter line then ends in a
// lone `\r` once the block is joined. The YAML parser refuses that document, so
// the report vanished from every listing rather than reading as misformatted.
const crlfDocument = '---\r\nreport: "R-9100"\r\nsubject: "crlf"\r\n---\r\n\r\nbody line\r\n'
check('a CRLF document parses', parseReport(crlfDocument) !== undefined)
check('a CRLF document keeps its body', parseReport(crlfDocument)?.body.includes('body line') === true,
  JSON.stringify(parseReport(crlfDocument)?.body))
check('a BOM plus CRLF document parses', parseReport(`\uFEFF${crlfDocument}`)?.front.report === 'R-9100',
  String(parseReport(`\uFEFF${crlfDocument}`)?.front.report))

// The digest's identity field is editable data; the file name is the identity.
// A copied or hand-edited `report:` must not redirect a write into another
// record, and `../` must not let it leave the reports directory.
const identityA = await service.author({ subject: 'identity A', body: 'A BODY', actor: 'session-a' })
const identityB = await service.author({ subject: 'identity B', body: 'B BODY', actor: 'session-a' })
const identityAFile = reportPath(identityA.front.report)
const identityBFile = reportPath(identityB.front.report)
const identityBText = await readFile(identityBFile, 'utf8')
await writeFile(
  identityAFile,
  (await readFile(identityAFile, 'utf8')).replace(`report: "${identityA.front.report}"`, `report: "${identityB.front.report}"`),
  'utf8',
)
const handEditedRow = (await service.list()).find((row) => row.subject === 'identity A')
check('a hand-edited identity is listed under its own file id',
  handEditedRow?.report === identityA.front.report, String(handEditedRow?.report))
await service.contribute(identityA.front.report, 'session-b', 'identity edit', 'after a hand edit')
check('a write stays in the report it was asked to write',
  (await readFile(identityAFile, 'utf8')).includes('identity edit'))
check('a hand-edited identity does not write into another report',
  (await readFile(identityBFile, 'utf8')) === identityBText)
check('the digest identity is normalized from the file it lives in',
  (await readReport(identityA.front.report))?.front.report === identityA.front.report)

const escaped = await service.author({ subject: 'traversal', body: 'VICTIM', actor: 'session-a' })
const escapedFile = reportPath(escaped.front.report)
await writeFile(
  escapedFile,
  (await readFile(escapedFile, 'utf8')).replace(`report: "${escaped.front.report}"`, 'report: "../outside"'),
  'utf8',
)
await service.contribute(escaped.front.report, 'session-b', 'traversal payload', 'escaped identity')
check('a traversal identity cannot write outside the reports directory',
  await stat(join(ledgerRoot(), 'outside.md')).then(() => false, () => true))
check('the traversal report itself is still readable',
  (await readReport(escaped.front.report))?.front.report === escaped.front.report)

// One unreadable entry must not take the whole index down: listing is how every
// other report is found, and the deferred-delivery pump lists first.
const beforeUnreadable = (await service.list()).length
const unreadable = join(ledgerRoot(), 'reports', 'R-9800.md')
await mkdir(unreadable, { recursive: true })
const afterUnreadable = await service.list()
check('a directory where a report file is expected does not break the listing',
  afterUnreadable.length === beforeUnreadable, `${beforeUnreadable} -> ${afterUnreadable.length}`)
check('the healthy reports are still listed', afterUnreadable.length > 0)
await rm(unreadable, { recursive: true, force: true })

// ---- 18. receipts, reads, and failed authoring -----------------------------
const receipt = await service.author({ subject: 'receipt authorization', body: 'b', actor: 'session-a', to: ['session-c'] })
let bystanderReceipt = ''
try { await service.acknowledge(receipt.front.report, 'session-a-stranger', 'not mine') } catch (error) {
  bystanderReceipt = error instanceof Error ? error.message : String(error)
}
check('a bystander may not acknowledge a report', bystanderReceipt.includes('may not acknowledge'), bystanderReceipt)
check('the refusal names who may acknowledge', bystanderReceipt.includes('session-c'), bystanderReceipt)
check('a recipient may acknowledge',
  (await service.acknowledge(receipt.front.report, 'session-c', 'got it')).front.status === 'acked')

const copiedReceipt = await service.author({ subject: 'carbon copy receipt', body: 'b', actor: 'session-a', cc: ['session-d'] })
check('a carbon copy may acknowledge',
  (await service.acknowledge(copiedReceipt.front.report, 'session-d', 'copy received')).front.status === 'acked')

// A read is a recorded hop, but it is not activity: it must not reorder the
// listing by advancing `updated`, and it must not resurrect a concluded report.
const readOld = await service.author({ subject: 'read order old', body: 'old', actor: 'session-a' })
await new Promise((resolve) => setTimeout(resolve, 5))
await service.author({ subject: 'read order new', body: 'new', actor: 'session-a' })
const orderBeforeRead = (await service.list()).map((row) => row.report)
const updatedBeforeRead = (await readReport(readOld.front.report))?.front.updated
await service.read(readOld.front.report, 'session-a')
check('reading a report does not reorder the listing',
  (await service.list()).map((row) => row.report).join() === orderBeforeRead.join())
check('reading a report does not advance its updated stamp',
  (await readReport(readOld.front.report))?.front.updated === updatedBeforeRead)

const closedForRead = await service.author({ subject: 'closed then read', body: 'b', actor: 'session-a' })
await service.close(closedForRead.front.report, 'session-a', 'concluded before the read')
const closedUpdated = (await readReport(closedForRead.front.report))?.front.updated
await service.read(closedForRead.front.report, 'session-a')
check('reading a closed report keeps it closed',
  (await readReport(closedForRead.front.report))?.front.status === 'closed')
check('reading a closed report does not refresh its stamp',
  (await readReport(closedForRead.front.report))?.front.updated === closedUpdated)

// A failed authoring must give an allocated id back instead of leaving an empty
// placeholder that burns the number and appears in no listing.
const reportsDir = join(ledgerRoot(), 'reports')
const crashing = new ReportService({
  getAgent: () => undefined,
  describe: async () => { throw new Error('describe exploded') },
})
const placeholders = async (): Promise<number> =>
  (await readdir(reportsDir)).filter((name) => /^R-\d+\.md$/.test(name)).length
const beforeCrash = await placeholders()
let authorCrash = ''
try { await crashing.author({ subject: 'never written', body: 'b', actor: 'session-a' }) } catch (error) {
  authorCrash = error instanceof Error ? error.message : String(error)
}
check('a failed authoring reports the failure', authorCrash.includes('describe exploded'), authorCrash)
check('a failed authoring gives the allocated id back', (await placeholders()) === beforeCrash,
  `${beforeCrash} -> ${await placeholders()}`)

// A caller-supplied id belongs to a provisioning that rolls itself back; the
// author path must not discard a claim it did not make.
const suppliedId = 'R-0090'
const suppliedFile = join(reportsDir, `${suppliedId}.md`)
await writeFile(suppliedFile, '', 'utf8')
let suppliedCrash = ''
try {
  await crashing.author({ subject: 'supplied id', body: 'b', actor: 'session-a', reportId: suppliedId })
} catch (error) {
  suppliedCrash = error instanceof Error ? error.message : String(error)
}
check('a failed authoring with a supplied id still reports the failure', suppliedCrash.includes('describe exploded'))
check('a caller-supplied id is not discarded by the author path',
  await stat(suppliedFile).then((info) => info.size === 0, () => false))
await rm(suppliedFile, { force: true })

// ---- 19. one hand-off per session, and one wake policy per window ----------
inbox.length = 0
const bothLists = await service.author({
  subject: 'named in to and cc',
  body: 'b',
  actor: 'session-a',
  to: ['session-b'],
  cc: ['session-b'],
})
check('a session named in to and cc receives one digest',
  inbox.filter((message) => message.target === 'session-b').length === 1,
  String(inbox.filter((message) => message.target === 'session-b').length))
check('it is recorded as one arrival',
  (await readHops(bothLists.front.report)).filter((hop) => hop.action === 'delivered').length === 1)
check('the addressed hand-off is not also recorded as a copy', bothLists.front.cc.includes('session-b') === false,
  bothLists.front.cc.join())

const sentThenCopied = [
  { at: 1, actor: 'session-a', action: 'sent' as const, to: ['session-c'] },
  { at: 2, actor: 'session-a', action: 'cc' as const, to: ['session-c'] },
]
check('a later copy does not downgrade an unanswered addressed hand-off',
  pendingMode(sentThenCopied, 'session-c') === 'wakeup', pendingMode(sentThenCopied, 'session-c'))
check('a copy owed on its own stays quiet',
  pendingMode([{ at: 3, actor: 'session-a', action: 'cc' as const, to: ['session-d'] }], 'session-d') === 'quiet')
check('a copy after an answered hand-off stays quiet',
  pendingMode([...sentThenCopied, { at: 4, actor: 'session-a', action: 'delivered' as const, to: ['session-c'] }], 'session-c') === 'quiet')

// ---- 20. an oversized body can be resumed by line --------------------------
const emojiBody = `${'y'.repeat(1199)}\u{1F600}${'z'.repeat(8000)}`
const oversized = await service.author({ subject: 'oversized body', body: emojiBody, actor: 'session-a' })
const oversizedRead = await service.read(oversized.front.report, 'session-a')
const oversizedHead = oversizedRead.split('## body\n')[1].split('\n\n…')[0]
check('a truncated head does not split a surrogate pair',
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(oversizedHead), JSON.stringify(oversizedHead.slice(-4)))
const resumeMatch = oversizedRead.match(/using offset=(\d+)/)
check('the truncation pointer names a document line to resume from', resumeMatch !== null,
  oversizedRead.slice(-160))
if (resumeMatch !== null) {
  const resumeLine = Number(resumeMatch[1])
  const documentLines = (await readFile(reportPath(oversized.front.report), 'utf8')).split('\n')
  check('the resume line exists in the document', resumeLine >= 1 && resumeLine <= documentLines.length,
    `${resumeLine}/${documentLines.length}`)
  check('the resume line is inside the body, not the front matter',
    documentLines[resumeLine - 1]?.startsWith('yyy') === true, String(documentLines[resumeLine - 1]?.slice(0, 12)))
}

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`ledger at ${ledgerRoot()}`)
console.log(`route file:\n${routeText.trim()}`)
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)

await rm(root, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
