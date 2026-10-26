// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts and `filter` silently resolves to the DOM's window.filter.
// Emitted as nothing; it exists so `tsc` treats the file as its own module.
export {}
/**
 * Handover checks — the retirement half of the ledger, run against a throwaway
 * ledger with plain Node.
 *
 * Three things are worth pinning without a harness:
 *
 *  - **An unpaid hand-off can change hands without ever looking delivered.** The
 *    pending derivation is the mailbox, so a `transferred` hop has to move the
 *    obligation rather than close it — otherwise the ledger would claim a delivery
 *    that never happened.
 *  - **Who may move it.** The owner may redirect its own dispatch; the session
 *    that owes the hand-off may hand it on; nobody else may pre-empt it.
 *  - **What a session still holds** is enumerated from digests plus routes, so a
 *    retirement report can never list an asset the ledger does not contain.
 *
 * Run: node scripts/handover-check.ts
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'report-ledger-handover-'))
process.env.DSH_HOME = root

const { ReportService } = await import('../src/report/service.ts')
const { readHops } = await import('../src/report/ledger.ts')
const { pendingMode, pendingTargets } = await import('../src/report/deliver.ts')
const { assetsOf, mentions, owns } = await import('../src/report/assets.ts')

/** Agents resident for this run. */
const live = new Set<string>(['session-a'])
/** Digests that reached a resident agent, and whether they woke it. */
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

// ---- 1. an owed hand-off moves to another session ------------------------
const first = await service.author({ subject: 'payments', body: 'body', actor: 'session-a', to: ['session-b'] })
const id = first.front.report
check('b is absent, so it is owed the hand-off', pendingTargets(await readHops(id)).join() === 'session-b',
  pendingTargets(await readHops(id)).join())

const moved = await service.transfer(id, 'session-a', 'session-b', 'session-c', 'b left the project')
check('the transfer is recorded against the session that owed it', moved.front.to.includes('session-c'),
  moved.front.to.join())
check('the session that handed it on keeps its place in the digest', moved.front.to.includes('session-b'),
  moved.front.to.join())
check('b no longer owes it', !pendingTargets(await readHops(id)).includes('session-b'),
  pendingTargets(await readHops(id)).join())
check('c owes it now', pendingTargets(await readHops(id)).join() === 'session-c',
  pendingTargets(await readHops(id)).join())
const moveHop = (await readHops(id)).find((hop) => hop.action === 'transferred')
check('the hop names both sides', moveHop?.from === 'session-b' && moveHop?.to.join() === 'session-c',
  JSON.stringify(moveHop))
check('a transfer is never recorded as an arrival', !(await readHops(id)).some((hop) => hop.action === 'delivered' && hop.to.includes('session-c')))
check('the wake policy travels with the obligation', pendingMode(await readHops(id), 'session-c') === 'wakeup')

// ---- 2. who may move it --------------------------------------------------
let refused = false
try {
  await service.transfer(id, 'session-z', 'session-c', 'session-e')
} catch { refused = true }
check('a stranger may not move someone else\'s obligation', refused)

refused = false
try {
  await service.transfer(id, 'session-a', 'session-b', 'session-e')
} catch { refused = true }
check('a transfer of a hand-off nobody is owed is refused', refused)

refused = false
try {
  await service.transfer(id, 'session-a', 'session-c', 'session-c')
} catch { refused = true }
check('a transfer to the same session is refused', refused)

// The session that owes it may hand it on itself — it is the party that cannot
// discharge it, and refusing would leave the obligation stuck forever.
const selfMoved = await service.transfer(id, 'session-c', 'session-c', 'session-d', 'handing my own obligation on')
check('the session that owes it may hand it on itself',
  pendingTargets(await readHops(id)).join() === 'session-d', pendingTargets(await readHops(id)).join())
check('the self-hand-off is a recorded hop', selfMoved.front.to.includes('session-d'))

// ---- 3. the obligation is still real: delivery closes it ------------------
live.add('session-d')
await service.flushForAgent('session-d')
check('the deferred delivery reaches the new holder', inbox.some((entry) => entry.target === 'session-d' && entry.text.includes(id)))
check('a delivered hand-off stops being owed', pendingTargets(await readHops(id)).length === 0,
  pendingTargets(await readHops(id)).join())

// ---- 4. transferring on a closed report reopens it -----------------------
const second = await service.author({ subject: 'audit', body: 'body', actor: 'session-a', to: ['session-b'] })
const secondId = second.front.report
await service.close(secondId, 'session-a', 'done')
const reopened = await service.transfer(secondId, 'session-a', 'session-b', 'session-c', 'b left, still owed')
check('a transfer on a closed report reopens it', reopened.front.status === 'open', reopened.front.status)
const secondHops = await readHops(secondId)
check('the reopen is recorded before the transfer',
  secondHops.filter((hop) => hop.action === 'reopened' || hop.action === 'transferred').map((hop) => hop.action).join()
  === 'reopened,transferred',
  secondHops.map((hop) => hop.action).join())

// ---- 5. what a session still holds --------------------------------------
/** One scanned report, as the asset scan sees it. */
type Piece = Parameters<typeof assetsOf>[0][number]

const pieces = [
  {
    front: { report: 'R-0001', status: 'open', from: 'a', authors: ['a'], to: ['a', 'b'], cc: [], worktree: undefined },
    hops: [
      { at: 1, actor: 'a', action: 'authored', to: [] },
      { at: 2, actor: 'a', action: 'sent', to: ['b'] },
      { at: 3, actor: 'a', action: 'leased', to: [] },
    ],
  },
  {
    front: { report: 'R-0002', status: 'closed', from: 'b', authors: ['b'], to: [], cc: [], worktree: undefined },
    hops: [{ at: 1, actor: 'b', action: 'authored', to: [] }],
  },
] as unknown as Piece[]

const held = assetsOf(pieces, 'a')
check('an owned open report is listed', held.owned.join() === 'R-0001', held.owned.join())
check('a held claim is listed', held.checkouts.join() === 'R-0001', held.checkouts.join())
check('a closed report owned by someone else is not listed', !held.owned.includes('R-0002'))
check('a session with no obligations owns nothing here', assetsOf(pieces, 'c').owned.length === 0)

const owed = assetsOf(pieces, 'b')
check('what a session is owed is listed', owed.owed.map((entry) => entry.report).join() === 'R-0001',
  JSON.stringify(owed.owed))
check('ownership does not require a mention check to pass', owns(pieces[0].front, 'a'))
check('a digest naming a recipient is a candidate', mentions(pieces[0].front, 'b'))
check('an unrelated session is not a candidate', !mentions(pieces[0].front, 'z'))

// ---- 6. a quiet obligation stays quiet when it changes hands --------------
// A carbon copy is a quiet delivery; a transfer moves the obligation, not the
// wake policy. If the new holder is absent and later returns, it must be injected,
// not woken — otherwise a session unrelated to the task runs a turn.
const quiet = await service.author({
  subject: 'quiet transfer', body: 'body', actor: 'session-a', cc: ['session-quiet-1'],
})
const quietId = quiet.front.report
await service.transfer(quietId, 'session-a', 'session-quiet-1', 'session-quiet-2', 'handing the quiet copy on')
check('a quiet obligation transferred to an absent session stays owed',
  pendingTargets(await readHops(quietId)).join() === 'session-quiet-2',
  pendingTargets(await readHops(quietId)).join())
check('the transferred quiet obligation does not become a wakeup',
  pendingMode(await readHops(quietId), 'session-quiet-2') === 'quiet',
  pendingMode(await readHops(quietId), 'session-quiet-2'))
live.add('session-quiet-2')
await service.flushSessions(['session-quiet-2'])
const quietDelivery = (await readHops(quietId)).find(
  (hop) => hop.action === 'delivered' && hop.to.includes('session-quiet-2'),
)
check('the quiet delivery is recorded as quiet', quietDelivery?.note === 'quiet', String(quietDelivery?.note))
check('the returned recipient was injected, not steered',
  inbox.some((entry) => entry.target === 'session-quiet-2' && entry.kind === 'inject')
  && !inbox.some((entry) => entry.target === 'session-quiet-2' && entry.kind === 'steer'))

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)

await rm(root, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
