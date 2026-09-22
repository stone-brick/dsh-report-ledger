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

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'report-ledger-smoke-'))
process.env.DSH_HOME = root

const { ReportService, renderRow } = await import('../src/report/service.ts')
const { ledgerRoot, reportPath, routePath } = await import('../src/report/ledger.ts')
const { pendingTargets } = await import('../src/report/deliver.ts')
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
