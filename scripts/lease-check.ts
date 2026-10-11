// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts and `filter` silently resolves to the DOM's window.filter.
// Emitted as nothing; it exists so `tsc` treats the file as its own module.
export {}
/**
 * Deterministic checks for the working-tree lease.
 *
 * The referee is the one place where the ledger and git must agree, and the two
 * failures it exists to prevent are both silent by nature: a claim taken while
 * another report still holds it, and a hop that never reaches the audit trail.
 * Both are pinned here against a real repository, because a fixture can be made
 * to say anything while git cannot.
 *
 * Run: node scripts/lease-check.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReportWorktree, RouteHop } from '../src/report/types.ts'
import type { RepoLocation } from '../src/report/worktree.ts'

const scratch = await mkdtemp(join(tmpdir(), 'report-ledger-lease-'))
// Set before anything reads the ledger root, so this run cannot touch a real one.
process.env.DSH_REPORT_LEDGER_ROOT = join(scratch, 'ledger')

const w = await import('../src/report/worktree.ts')
const { leaseState, sameClaim, evaluateLease } = await import('../src/report/lease.ts')
const { ReportService } = await import('../src/report/service.ts')
const { HOP_ACTIONS } = await import('../src/report/types.ts')
const { parseHop } = await import('../src/report/frontmatter.ts')
const { readHops, readReport, listReports } = await import('../src/report/ledger.ts')

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

/** Run a fixture git command, failing loudly: a broken fixture is not a finding. */
const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await w.runGit(cwd, args)
  if (!result.ok) {
    throw new Error(`fixture git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim() || `exit ${result.code}`}`)
  }
  return result.stdout
}

// ---- 1. lease liveness is derived from the hop stream ----------------------
const hop = (action: RouteHop['action']): RouteHop => ({ at: 0, actor: 's', action, to: [] })
check('no lease hop reads as never claimed', leaseState([]) === 'none')
check('activity alone is not a claim', leaseState([hop('authored'), hop('read')]) === 'none')
check('a claim reads as held', leaseState([hop('authored'), hop('leased')]) === 'held')
check('a released claim reads as released',
  leaseState([hop('leased'), hop('released')]) === 'released')
check('the last claim wins, so a re-claim reads as held',
  leaseState([hop('leased'), hop('released'), hop('leased')]) === 'held')
check('closing after a release keeps it released',
  leaseState([hop('leased'), hop('released'), hop('closed')]) === 'released')
// A cleared checkout is not merely released: the difference decides whether
// there is anything left to clear, and collapsing the two is what leaves a
// checkout the ledger already removed sitting in the candidate set forever.
check('a cleared checkout reads as reclaimed, not as released',
  leaseState([hop('leased'), hop('released'), hop('reclaimed')]) === 'reclaimed',
  leaseState([hop('leased'), hop('released'), hop('reclaimed')]))
check('a re-lease after a reclamation reads as held again',
  leaseState([hop('leased'), hop('released'), hop('reclaimed'), hop('leased')]) === 'held')

// ---- 2. the drift guard: no hop action may vanish in the codec ------------
// The parser validates each record against HOP_ACTIONS and DROPS one it does not
// recognize. A union that named an action the list omitted would therefore lose
// those hops from the audit trail without a word — the one failure a ledger must
// not have. This is the regression test for that, and it is deliberately written
// against the list rather than a hand-picked action.
for (const action of HOP_ACTIONS) {
  const parsed = parseHop(JSON.stringify({ at: 1, actor: 's', action, to: [] }))
  check(`the codec preserves a "${action}" hop`, parsed?.action === action, String(parsed?.action))
}
check('the declared actions are free of duplicates',
  new Set(HOP_ACTIONS).size === HOP_ACTIONS.length,
  HOP_ACTIONS.join(','))
for (const action of ['leased', 'released', 'reclaimed'] as const) {
  check(`the working-tree vocabulary includes "${action}"`, HOP_ACTIONS.includes(action))
}

// ---- 3. claim identity -----------------------------------------------------
check('one branch is one claim however the path is spelled',
  sameClaim({ path: 'C:/a', branch: 'b' }, { path: 'C:/b', branch: 'b' }))
check('different branches are different claims',
  !sameClaim({ path: 'C:/a', branch: 'b' }, { path: 'C:/a', branch: 'c' }))
check('a detached tree is identified by its path',
  sameClaim({ path: 'C:/a' }, { path: 'C:\\a' }))
check('a detached tree at another path is another claim',
  !sameClaim({ path: 'C:/a' }, { path: 'C:/b' }))

// ---- fixtures --------------------------------------------------------------
const repo = join(scratch, 'repo')
await mkdir(repo, { recursive: true })
await git(repo, 'init', '-q', '--initial-branch=main')
await git(repo, 'config', 'core.autocrlf', 'false')
await git(repo, 'config', 'user.name', 'lease-check')
await git(repo, 'config', 'user.email', 'lease-check@example.invalid')
await writeFile(join(repo, 'f.txt'), 'l1\n')
await git(repo, 'add', '-A')
await git(repo, 'commit', '-q', '-m', 'base')

const located = await w.resolveRepo(repo)
if (located === undefined) throw new Error('fixture repository did not resolve')
const linkedPath = join(located.worktreeRoot, 'wt-a')
await mkdir(located.worktreeRoot, { recursive: true })
const addedLinked = await w.addWorktree({ repo: located, path: linkedPath, branch: 'b-lease', base: 'main' })
if (!addedLinked.ok) throw new Error(`fixture worktree failed: ${addedLinked.stderr.trim()}`)
const linkedRepo = await w.resolveRepo(linkedPath)
if (linkedRepo === undefined) throw new Error('fixture linked worktree did not resolve')

/** The binding a report claims: the linked checkout, on its branch. */
const binding: ReportWorktree = {
  path: linkedPath,
  branch: 'b-lease',
  repo: located.commonDir,
  head: (await w.headOf(linkedPath)) ?? undefined,
  allocated: true,
}

/** Ask the referee, with everything but the binding defaulted to "nothing". */
const judge = async (
  candidate: ReportWorktree,
  where: RepoLocation | undefined,
  extra: Partial<Parameters<typeof evaluateLease>[0]> = {},
): Promise<Awaited<ReturnType<typeof evaluateLease>>> => await evaluateLease({
  binding: candidate,
  repo: where,
  report: 'R-9999',
  digests: [],
  hopsOf: async () => [],
  ...extra,
})

/** The refusal a verdict carries, so the assertions read as one line each. */
const refusalOf = (verdict: Awaited<ReturnType<typeof evaluateLease>>) =>
  verdict.kind === 'refused' ? verdict.refusal : undefined

/** The binding a granted verdict describes, when it granted the claim. */
const grantOf = (verdict: Awaited<ReturnType<typeof evaluateLease>>) =>
  verdict.kind === 'granted' ? verdict.binding : undefined

// ---- 4. the git layer ------------------------------------------------------
const tempInRepo = (await w.resolveRepo(tmpdir())) !== undefined
check('a path outside any repository is refused',
  tempInRepo || refusalOf(await judge({ path: scratch }, await w.resolveRepo(scratch)))?.kind === 'no-repository')

const strayDir = join(repo, 'stray')
await mkdir(strayDir, { recursive: true })
const strayly = refusalOf(await judge({ path: strayDir }, located))
check('a path that is not a working tree is refused', strayly?.kind === 'not-a-worktree', String(strayly?.kind))
check('the refusal is addressed to the reader', (strayly?.message ?? '').includes('git worktree list'))

const wrongBranch = refusalOf(await judge({ path: linkedPath, branch: 'main' }, linkedRepo))
check('a binding whose branch does not match the checkout is refused',
  wrongBranch?.kind === 'branch-mismatch', String(wrongBranch?.kind))
check('the mismatch names both branches',
  (wrongBranch?.message ?? '').includes('main') && (wrongBranch?.message ?? '').includes('b-lease'),
  wrongBranch?.message ?? '')

// A binding that names no branch is not asserted to be detached: the referee
// reads the real branch, so a checkout sitting on one is described accurately.
const bare = grantOf(await judge({ path: linkedPath }, linkedRepo))
check('a binding that names no branch is accepted', bare !== undefined)
check('the granted binding carries the branch git reports', bare?.branch === 'b-lease', String(bare?.branch))

check('a detached binding matching the checkout is accepted',
  (await judge({ path: linkedPath }, linkedRepo)).kind === 'granted')

// A branch checked out twice is a state git would not have chosen — only
// `--force` produces it — and the ledger must notice rather than assume git
// prevented it. The fixture forces it exactly as a human would have to.
const forcedPath = join(located.worktreeRoot, 'wt-forced')
const forced = await w.runGit(located.commonDir, ['worktree', 'add', '--force', forcedPath, 'b-lease'])
if (!forced.ok) throw new Error(`fixture forced worktree failed: ${forced.stderr.trim()}`)
const doubled = refusalOf(await judge({ path: forcedPath, branch: 'b-lease' }, await w.resolveRepo(forcedPath)))
check('a branch held by another checkout is refused', doubled?.kind === 'checked-out', String(doubled?.kind))
check('the refusal names the other checkout', (doubled?.message ?? '').includes(linkedPath), doubled?.message ?? '')
const forcedRemoval = await w.removeWorktree(located, forcedPath)
check('the forced fixture is cleaned up', forcedRemoval.ok, forcedRemoval.stderr.trim())

// The granted binding is git's description rather than the caller's: this is
// what stops a digest carrying an asserted commit that was never there.
const resolved = grantOf(await judge({ path: linkedPath, branch: 'b-lease', head: 'f'.repeat(40) }, linkedRepo))
check('the granted binding replaces an asserted head with the real one',
  resolved?.head !== undefined && resolved.head !== 'f'.repeat(40), String(resolved?.head))
check('the granted binding records the repository it was resolved against',
  resolved?.repo === located.commonDir, String(resolved?.repo))
check('the granted binding keeps the allocation mark it was given',
  grantOf(await judge({ ...binding, branch: undefined }, linkedRepo))?.allocated === true)
check('the happy path is granted', (await judge(binding, linkedRepo)).kind === 'granted')

// ---- 5. the ledger layer ---------------------------------------------------
const live = new Set<string>(['session-owner', 'session-rival', 'session-third'])
const service = new ReportService({
  getAgent(sessionId) {
    if (!live.has(sessionId)) return undefined
    return {
      id: sessionId,
      steer: () => {},
      inject: () => {},
    }
  },
  describe: async (sessionId) => `name-of-${sessionId}`,
})

const holder = await service.author({ subject: 'holds the checkout', body: 'b', actor: 'session-owner' })
const claimant = await service.author({ subject: 'wants the checkout', body: 'b', actor: 'session-rival' })

const held = await service.lease(holder.front.report, 'session-owner', binding)
check('a lease is recorded on the digest', held.front.worktree?.branch === 'b-lease', String(held.front.worktree?.branch))
check('a lease records a hop', (await readHops(holder.front.report)).some((h) => h.action === 'leased'))
check('the lease note names the branch and path',
  (await readHops(holder.front.report)).some((h) => h.action === 'leased' && (h.note ?? '').includes('b-lease')))

const rendered = await service.read(holder.front.report, 'session-owner')
check('read renders the lease as held', rendered.includes('lease=held'), rendered.split('\n')[0] ?? '')
check('read says the ledger allocated it', rendered.includes('allocated by the ledger'))

let rivalRefusal = ''
try {
  await service.lease(claimant.front.report, 'session-rival', binding)
} catch (error) {
  rivalRefusal = error instanceof Error ? error.message : String(error)
}
check('a second report may not claim the same checkout', rivalRefusal !== '', 'the claim was allowed')
check('the refusal names the holding report', rivalRefusal.includes(holder.front.report), rivalRefusal)
check('the refusal names who to ask', rivalRefusal.includes('session-owner'), rivalRefusal)

// Re-claiming refreshes a binding and must not require a release first; the
// report itself is never its own conflict. What it cannot do is *assert* a head:
// the referee reads the real one, so passing a fabricated commit changes nothing.
const reclaimed = await service.lease(holder.front.report, 'session-owner', {
  ...binding, head: 'b'.repeat(40),
})
const realHead = await w.headOf(linkedPath)
check('the owner may re-claim its own checkout', reclaimed.front.worktree?.branch === 'b-lease')
check('a re-claim records the commit git reports, not the one asserted',
  reclaimed.front.worktree?.head === realHead && realHead !== 'b'.repeat(40),
  `${reclaimed.front.worktree?.head} vs ${realHead}`)
check('a re-claim is recorded too',
  (await readHops(holder.front.report)).filter((h) => h.action === 'leased').length === 2)

// ---- 6. a live claim blocks a second one, whatever state its holder is in ---
// There is deliberately no take-over policy: a claim is held by one report at a
// time, full stop, and the refusal names who to ask. An absent holder therefore
// keeps its claim until it releases or its report is closed — a checkout is not
// taken from an agent who might simply be slow.
const stillHeld = refusalOf(await judge(binding, linkedRepo, {
  digests: await listReports(),
  hopsOf: async (id) => await readHops(id),
}))
check('a live claim is refused even when the holder is absent and the tree is clean',
  stillHeld?.kind === 'held-by-report', String(stillHeld?.kind))
check('the refusal says the claim is held by one report at a time',
  (stillHeld?.message ?? '').includes('one report at a time'), stillHeld?.message ?? '')

const abandoned = await service.release(holder.front.report, 'session-owner')
check('a release is recorded', abandoned.front.worktree !== undefined)
check('a release records a hop', leaseState(await readHops(holder.front.report)) === 'released')
check('the binding survives the release, so the checkout stays traceable',
  (await readReport(holder.front.report))?.front.worktree?.branch === 'b-lease')
check('read renders the released state',
  (await service.read(holder.front.report, 'session-owner')).includes('lease=released'))

let doubleRelease = ''
try {
  await service.release(holder.front.report, 'session-owner')
} catch (error) {
  doubleRelease = error instanceof Error ? error.message : String(error)
}
check('releasing twice is refused rather than doubling the trail',
  doubleRelease.includes('nothing to release'), doubleRelease)

const unbound = await service.author({ subject: 'never leased', body: 'b', actor: 'session-third' })
let releaseUnbound = ''
try {
  await service.release(unbound.front.report, 'session-third')
} catch (error) {
  releaseUnbound = error instanceof Error ? error.message : String(error)
}
check('releasing an unbound report is refused', releaseUnbound.includes('not bound'), releaseUnbound)

let strangerLease = ''
try {
  await service.lease(claimant.front.report, 'session-third', binding)
} catch (error) {
  strangerLease = error instanceof Error ? error.message : String(error)
}
check('a stranger may not lease on behalf of a report',
  strangerLease.includes('may not lease'), strangerLease)
check('the refusal names the report author', strangerLease.includes('session-rival'), strangerLease)

// ---- 7. closing releases the claim, without touching the disk --------------
const closedHolder = await service.author({ subject: 'closes while holding', body: 'b', actor: 'session-owner' })
await service.lease(closedHolder.front.report, 'session-owner', binding)
const closed = await service.close(closedHolder.front.report, 'session-owner', 'done')
check('closing a leased report concludes it', closed.front.status === 'closed')
check('closing releases the lease', leaseState(await readHops(closedHolder.front.report)) === 'released')
check('closing does not remove the working tree', await w.isWorktreeClean(linkedPath))
check('the release is attributed to the closing',
  (await readHops(closedHolder.front.report)).some((h) => h.action === 'released' && (h.note ?? '').includes('closing')))
check('a concluded report no longer blocks a claim',
  (await judge(binding, linkedRepo, {
    digests: await listReports(),
    hopsOf: async (id) => await readHops(id),
  })).kind === 'granted')

// ---- 8. the repository mutex: two claimants, one winner -------------------
// Without the repository-scoped lock both claims read the digest before either
// writes it, both find the field clear, and both succeed — a silent double
// claim. The lock is what makes this test pass, so it is the test of the lock.
const racePath = join(located.worktreeRoot, 'wt-race')
const raceAdd = await w.addWorktree({ repo: located, path: racePath, branch: 'b-race', base: 'main' })
if (!raceAdd.ok) throw new Error(`fixture race worktree failed: ${raceAdd.stderr.trim()}`)
const raceBinding: ReportWorktree = { path: racePath, branch: 'b-race', repo: located.commonDir, allocated: true }
const first = await service.author({ subject: 'races for the checkout', body: 'b', actor: 'session-owner' })
const second = await service.author({ subject: 'also races for it', body: 'b', actor: 'session-rival' })
const outcomes = await Promise.allSettled([
  service.lease(first.front.report, 'session-owner', raceBinding),
  service.lease(second.front.report, 'session-rival', raceBinding),
])
const won = outcomes.filter((outcome) => outcome.status === 'fulfilled')
const lost = outcomes.filter((outcome) => outcome.status === 'rejected')
check('exactly one of two concurrent claims wins', won.length === 1 && lost.length === 1,
  `won=${won.length} lost=${lost.length}`)
check('the loser is refused by name, not by a race',
  lost.length === 1 && String(lost[0]?.reason).includes('already holds'),
  lost.length === 1 ? String(lost[0]?.reason) : '')

// ---- report -----------------------------------------------------------------
try {
  await rm(scratch, { recursive: true, force: true })
} catch {
  // A leftover fixture is not a finding.
}

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
