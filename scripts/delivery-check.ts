// `export {}` keeps this file a module, like its siblings: without it the
// top-level names would collide across check scripts.
export {}
/**
 * Deterministic-delivery check — the idempotency half of the delivery pump.
 *
 * Runs against a throwaway ledger with no harness. It pins the three facts the
 * idempotency rests on:
 *
 *  - the message id is derived from the hand-off, so a retry reproduces it;
 *  - a recipient that already holds the id is recorded as recovered, not
 *    delivered again;
 *  - the arrival hop is only written after the session-persistence barrier, so a
 *    failed barrier leaves the hand-off pending for the reconciling sweep.
 *
 * It also exercises the read-only delivery diagnostic against a fake session
 * probe, which is the only way to assert `stranded` without a real harness.
 *
 * Run: node scripts/delivery-check.ts
 */

import { readFile, rm } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReportFrontMatter, RouteHop } from '../src/report/types.ts'
import type { DeliveryState } from '../src/report/deliver.ts'

const root = await mkdtemp(join(tmpdir(), 'report-ledger-delivery-'))
process.env.DSH_HOME = root
process.env.DSH_REPORT_LEDGER_ROOT = join(root, 'report-ledger')

const { ReportService } = await import('../src/report/service.ts')
const { deliver, deliveryId, isDeliveryId, pendingTargets } = await import('../src/report/deliver.ts')
const { readHops } = await import('../src/report/ledger.ts')
const { routePath } = await import('../src/report/ledger.ts')

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

// ---- 1. the id is derived from the hand-off --------------------------------
const hops: RouteHop[] = [
  { at: 1, actor: 'session-a', action: 'authored', to: [] },
  { at: 2, actor: 'session-a', action: 'sent', to: ['session-b'] },
]
const first = deliveryId('R-0001', hops, 'session-b')
check('a hand-off id names the report and the hop that caused it', first === 'report-ledger:R-0001:1', first)
check('a retry over the same path reproduces the id', deliveryId('R-0001', hops, 'session-b') === first)
check('the id is recognisable as a digest id', isDeliveryId(first) && !isDeliveryId('session-b'), first)

const resent: RouteHop[] = [...hops, { at: 3, actor: 'session-a', action: 'sent', to: ['session-b'] }]
check('a later send is a new hand-off with a new id', deliveryId('R-0001', resent, 'session-b') === 'report-ledger:R-0001:2')
const moved: RouteHop[] = [...hops, { at: 4, actor: 'session-a', action: 'transferred', from: 'session-b', to: ['session-c'] }]
check('a transfer names the new owner from the transfer hop',
  deliveryId('R-0001', moved, 'session-c') === 'report-ledger:R-0001:2')
check('a delivered hop does not change the hand-off it answered', deliveryId('R-0001', [...hops, {
  at: 5, actor: 'report-ledger', action: 'delivered', to: ['session-b'],
}], 'session-b') === first)

// ---- 2. deliver() recovers instead of duplicating --------------------------
const front: ReportFrontMatter = {
  report: 'R-0001', subject: 's', status: 'open', from: 'session-a', to: ['session-b'], cc: [],
  authors: ['session-a'], created: 1, updated: 1, children: [], artifacts: [], hops: 1, reads: 0,
}
const steered: string[] = []
const agent = {
  id: 'session-b',
  steer: (message: { id: string }) => { steered.push(message.id) },
  inject: (message: { id: string }) => { steered.push(message.id) },
}
const recovered = await deliver({ getAgent: () => agent, holds: async () => true }, front, 'p', ['session-b'], 'wakeup', {
  'session-b': first,
})
check('a recipient that already holds the digest is not steered again', steered.length === 0, steered.join())
check('the recovery is reported as delivered', recovered[0]?.status === 'delivered', JSON.stringify(recovered))
check('the recovery is marked, so the hop can say so', recovered[0]?.recovered === true, JSON.stringify(recovered))

const fresh = await deliver({ getAgent: () => agent, holds: async () => false }, front, 'p', ['session-b'], 'wakeup', {
  'session-b': first,
})
check('a fresh delivery carries the derived id',
  fresh[0]?.status === 'delivered' && steered.join() === first, steered.join())
check('a fresh delivery is not marked recovered', fresh[0]?.recovered === undefined, JSON.stringify(fresh))

// ---- 3. the service uses the derived id, and flushes before recording ------
const live = new Set<string>(['session-a', 'session-b', 'session-e'])
const held = new Set<string>()
const taken = new Set<string>()
const steersByTarget = new Map<string, number>()
const attemptsByTarget = new Map<string, number>()
const broken = new Set<string>()
const warnings: string[] = []
let clock = 1_000_000
let flushCalls = 0
let flushError: Error | undefined

const service = new ReportService({
  getAgent(sessionId) {
    if (!live.has(sessionId)) return undefined
    const record = (): void => { steersByTarget.set(sessionId, (steersByTarget.get(sessionId) ?? 0) + 1) }
    const attempt = (): void => { attemptsByTarget.set(sessionId, (attemptsByTarget.get(sessionId) ?? 0) + 1) }
    const accept = (message: { id: string }): void => {
      attempt()
      // The fake inbox keeps what it was handed, which is exactly what `holds`
      // consults — so the recovery path is exercised end to end.
      if (broken.has(sessionId)) throw new Error('agent refused the digest')
      record()
      held.add(message.id)
    }
    return {
      id: sessionId,
      steer: accept,
      inject: accept,
    }
  },
  describe: async (sessionId) => `name-of-${sessionId}`,
  holds: async (_sessionId, messageId) => held.has(messageId) || taken.has(messageId),
  async flushSessionPersistence() {
    flushCalls += 1
    if (flushError !== undefined) throw flushError
  },
  deliveryState: async (sessionId, messageId): Promise<DeliveryState> => {
    if (!live.has(sessionId)) return 'absent'
    if (held.has(messageId)) return 'inbox'
    return taken.has(messageId) ? 'taken' : 'stranded'
  },
  warn(message: string) {
    warnings.push(message)
  },
}, { now: () => clock })

const firstReport = await service.author({ subject: 'first', body: 'b', actor: 'session-a', to: ['session-b'] })
const firstId = deliveryId(firstReport.front.report, await readHops(firstReport.front.report), 'session-b')
check('the service delivers the derived id', held.has(firstId), firstId)
check('the flush barrier runs before the arrival is recorded', flushCalls > 0, String(flushCalls))
const firstRoute = await readFile(routePath(firstReport.front.report), 'utf8')
check('the arrival is recorded as recovered only when it had to be', firstRoute.includes('"delivered"') && !firstRoute.includes('(recovered)'),
  firstRoute)

// ---- 4. a crash between steer and the hop is reconciled, not repeated ------
const absentReport = await service.author({ subject: 'held', body: 'b', actor: 'session-a', to: ['session-c'] })
check('an absent recipient is queued', pendingTargets(await readHops(absentReport.front.report)).includes('session-c'))
live.add('session-c')
const owedId = deliveryId(absentReport.front.report, await readHops(absentReport.front.report), 'session-c')
held.add(owedId) // what a crashed attempt leaves behind: the inbox has it, the ledger does not
const reconciled = await service.flushForAgent('session-c')
check('the reconciling sweep reports the hand-off as recovered',
  reconciled.some((outcome) => outcome.targetId === 'session-c' && outcome.recovered === true), JSON.stringify(reconciled))
check('the recipient was not steered a second time', (steersByTarget.get('session-c') ?? 0) === 0,
  String(steersByTarget.get('session-c') ?? 0))
check('the reconciliation records the arrival',
  pendingTargets(await readHops(absentReport.front.report)).length === 0,
  pendingTargets(await readHops(absentReport.front.report)).join())
check('the recovery is visible in the path',
  (await readFile(routePath(absentReport.front.report), 'utf8')).includes('(recovered)'))

// ---- 5. a failed durability barrier leaves the hand-off pending -----------
const flushFailureReport = await service.author({ subject: 'flush fails', body: 'b', actor: 'session-a' })
flushError = new Error('the store is unwritable')
let sendFailure = ''
try {
  await service.send(flushFailureReport.front.report, 'session-a', ['session-e'])
} catch (error) {
  sendFailure = error instanceof Error ? error.message : String(error)
}
check('a failed flush is reported', sendFailure.includes('session persistence'), sendFailure)
const failedId = deliveryId(flushFailureReport.front.report, await readHops(flushFailureReport.front.report), 'session-e')
check('the failed attempt is not recorded as an arrival',
  !(await readFile(routePath(flushFailureReport.front.report), 'utf8')).includes('"delivered"'))
check('the hand-off stays pending', pendingTargets(await readHops(flushFailureReport.front.report)).includes('session-e'))
check('the inbox did receive it', held.has(failedId))
const flushFailureRow = (await service.deliveryDiagnostics({ report: flushFailureReport.front.report })).rows
  .find((row) => row.target === 'session-e')
check('a failed durability barrier enters the backoff table', flushFailureRow?.failing?.attempts === 1,
  JSON.stringify(flushFailureRow))
check('the barrier failure schedules a retry', flushFailureRow?.failing?.nextAttemptAt === clock + 2_000,
  String(flushFailureRow?.failing?.nextAttemptAt))
check('the barrier failure counts as delivery trouble', service.hasDeliveryTrouble() === true)

// The automatic retry respects the backoff: before the window it attempts
// nothing, so the message is neither steered again nor recorded as an arrival.
flushError = undefined
await service.retryFailedDeliveries()
check('the retry sweep skips a barrier failure before its window',
  pendingTargets(await readHops(flushFailureReport.front.report)).includes('session-e'))
check('the skipped sweep makes no second attempt', (steersByTarget.get('session-e') ?? 0) === 1,
  String(steersByTarget.get('session-e') ?? 0))

clock += 2_000
await service.retryFailedDeliveries()
check('the due sweep reconciles instead of delivering twice',
  (await readFile(routePath(flushFailureReport.front.report), 'utf8')).includes('wakeup (recovered)'))
check('the recipient was steered exactly once', (steersByTarget.get('session-e') ?? 0) === 1,
  String(steersByTarget.get('session-e') ?? 0))
check('the retry records the arrival', pendingTargets(await readHops(flushFailureReport.front.report)).length === 0)
check('the recovered barrier failure clears the trouble', service.hasDeliveryTrouble() === false)

// ---- 6. the diagnostic distinguishes the four delivery states -------------
// R-0001's digest is in the recipient's history now: taken.
taken.add(firstId)
held.delete(firstId)
// A second report is recorded as delivered, then its digest is gone from both
// the inbox and the history: the stranded state.
const strandedReport = await service.author({ subject: 'stranded', body: 'b', actor: 'session-a', to: ['session-b'] })
const strandedId = deliveryId(strandedReport.front.report, await readHops(strandedReport.front.report), 'session-b')
held.delete(strandedId)
taken.delete(strandedId)
// A third is owed to a session that is not resident at all.
const absentAgain = await service.author({ subject: 'absent', body: 'b', actor: 'session-a', to: ['session-ghost'] })

const diagnostics = await service.deliveryDiagnostics()
check('the diagnostic can verify consumption', diagnostics.persistence === true)
const rowOf = (report: string, target: string): { state: DeliveryState; pending: boolean } | undefined =>
  diagnostics.rows.find((row) => row.report === report && row.target === target)
check('a consumed digest is taken', rowOf(firstReport.front.report, 'session-b')?.state === 'taken',
  JSON.stringify(rowOf(firstReport.front.report, 'session-b')))
check('an arrival the session lost is stranded', rowOf(strandedReport.front.report, 'session-b')?.state === 'stranded',
  JSON.stringify(rowOf(strandedReport.front.report, 'session-b')))
check('an absent recipient is absent and still owed',
  rowOf(absentAgain.front.report, 'session-ghost')?.state === 'absent'
  && rowOf(absentAgain.front.report, 'session-ghost')?.pending === true,
  JSON.stringify(rowOf(absentAgain.front.report, 'session-ghost')))
check('a scan can be limited to one report',
  (await service.deliveryDiagnostics({ report: strandedReport.front.report })).rows.every((row) => row.report === strandedReport.front.report))

// ---- 7. a host-boundary failure backs off, warns once, and recovers --------
live.add('session-f1')
broken.add('session-f1')
const f1Report = await service.author({ subject: 'f1', body: 'b', actor: 'session-a' })
let f1Failure = ''
try {
  await service.send(f1Report.front.report, 'session-a', ['session-f1'])
} catch (error) {
  f1Failure = error instanceof Error ? error.message : String(error)
}
check('a host-boundary failure is reported', f1Failure.includes('agent refused the digest'), f1Failure)
check('the failed hand-off is not recorded as an arrival',
  !(await readFile(routePath(f1Report.front.report), 'utf8')).includes('"delivered"'))
check('the failed hand-off is still owed',
  pendingTargets(await readHops(f1Report.front.report)).includes('session-f1'))

const f1Row = (await service.deliveryDiagnostics({ report: f1Report.front.report })).rows
  .find((row) => row.target === 'session-f1')
check('the failure is visible with its attempt count', f1Row?.failing?.attempts === 1, JSON.stringify(f1Row))
check('the first retry is scheduled two seconds out', f1Row?.failing?.nextAttemptAt === clock + 2_000,
  String(f1Row?.failing?.nextAttemptAt))

await service.flushSessions(['session-f1'], { respectBackoff: true })
check('a retry before its window is skipped', (attemptsByTarget.get('session-f1') ?? 0) === 1,
  String(attemptsByTarget.get('session-f1') ?? 0))

clock += 2_000
let f1RetryFailed = false
try {
  await service.flushSessions(['session-f1'], { respectBackoff: true })
} catch {
  f1RetryFailed = true
}
check('a due retry tries again', (attemptsByTarget.get('session-f1') ?? 0) === 2 && f1RetryFailed,
  `${attemptsByTarget.get('session-f1') ?? 0} attempts, failed=${f1RetryFailed}`)

// A recipient that leaves is not retried by a sweep that can never reach it;
// the hand-off stays owed for the explicit flush its return triggers.
live.delete('session-f1')
await service.retryFailedDeliveries()
check('a failure for a session that left is forgotten', service.hasDeliveryTrouble() === false)
check('the hand-off survives the forgotten failure',
  pendingTargets(await readHops(f1Report.front.report)).includes('session-f1'))

live.add('session-f2')
broken.add('session-f2')
const f2Report = await service.author({ subject: 'f2', body: 'b', actor: 'session-a' })
try {
  await service.send(f2Report.front.report, 'session-a', ['session-f2'])
} catch {
  // expected: this is the first failure
}
for (const wait of [2_000, 4_000]) {
  clock += wait
  try {
    await service.flushSessions(['session-f2'], { respectBackoff: true })
  } catch {
    // expected until the recipient is repaired
  }
}
check('the failure count reaches three', (attemptsByTarget.get('session-f2') ?? 0) === 3,
  String(attemptsByTarget.get('session-f2') ?? 0))
check('the third consecutive failure is reported once',
  warnings.filter((warning) => warning.includes('session-f2') && warning.includes('failed 3 times in a row')).length === 1,
  warnings.join(' | '))
check('the warning names the next delay',
  warnings.some((warning) => warning.includes('session-f2') && warning.includes('next attempt in 8s')),
  warnings.join(' | '))
const f2Row = (await service.deliveryDiagnostics({ report: f2Report.front.report })).rows
  .find((row) => row.target === 'session-f2')
check('the diagnostic carries the third failure', f2Row?.failing?.attempts === 3, JSON.stringify(f2Row))

broken.delete('session-f2')
clock += 8_000
await service.flushSessions(['session-f2'], { respectBackoff: true })
check('a recovered delivery clears the trouble', service.hasDeliveryTrouble() === false)
check('recovery is reported once',
  warnings.some((warning) => warning.includes('session-f2') && warning.includes('recovered after 3 failed attempt(s)')),
  warnings.join(' | '))
const f2Recovered = (await service.deliveryDiagnostics({ report: f2Report.front.report })).rows
  .find((row) => row.target === 'session-f2')
check('the recovered row no longer reports failing', f2Recovered?.failing === undefined, JSON.stringify(f2Recovered))

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)

await rm(root, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
