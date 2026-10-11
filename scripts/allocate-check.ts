// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts and `filter` silently resolves to the DOM's window.filter.
// Emitted as nothing; it exists so `tsc` treats the file as its own module.
export {}
/**
 * Deterministic checks for working-tree allocation.
 *
 * Allocation is where the ledger starts moving real files, so the checks are
 * about what it refuses as much as what it does: a full budget that cannot be
 * bought off with a reclamation, a candidate that is skipped for being dirty, a
 * rollback that will not force. The naming checks are a property test rather
 * than a handful of examples, because the point of the slug is that *no* input
 * can produce a ref git rejects.
 *
 * Run: node scripts/allocate-check.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorktreeSettings } from '../src/report/allocate.ts'

const scratch = await mkdtemp(join(tmpdir(), 'report-ledger-allocate-'))
process.env.DSH_REPORT_LEDGER_ROOT = join(scratch, 'ledger')

const w = await import('../src/report/worktree.ts')
const a = await import('../src/report/allocate.ts')
const { ReportService } = await import('../src/report/service.ts')
const { leaseState } = await import('../src/report/lease.ts')
const ledger = await import('../src/report/ledger.ts')

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

/** The resolved settings, wide open unless a test narrows them. */
const generous: WorktreeSettings = { maxActive: 99, maxRetained: 99, reclaim: 'never', relativePaths: false }

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await w.runGit(cwd, args)
  if (!result.ok) {
    throw new Error(`fixture git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim() || `exit ${result.code}`}`)
  }
  return result.stdout
}

// ---- 1. naming: no input can produce a ref git rejects ---------------------
// git forbids spaces, `~^:?*[`, `..`, `@{`, control characters, and a leading or
// trailing `.` or `/`. The slug's alphabet excludes all of them by construction,
// which is the claim these cases test rather than assume.
const nasty = [
  'plain subject', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a..b', 'a@{b}',
  '.hidden', 'trailing.', '/leading', 'trailing/', 'UPPER Case', 'a---b', '---', '...',
  '把 worktree 接进账本', 'emoji 🚀 here', '', '   ', 'a'.repeat(200), 'tab\there', 'new\nline',
]
let slugViolations = 0
for (const subject of nasty) {
  const slug = a.slugify(subject)
  const safe = /^[a-z0-9-]*$/.test(slug)
    && !slug.startsWith('-')
    && !slug.endsWith('-')
    && !slug.includes('..')
    && slug.length <= 40
  if (!safe) {
    slugViolations++
    check(`slug is ref-safe for ${JSON.stringify(subject.slice(0, 20))}`, false, JSON.stringify(slug))
  }
}
check(`every slug is ref-safe (${nasty.length} inputs)`, slugViolations === 0, `${slugViolations} violations`)
check('a slug lower-cases and collapses runs', a.slugify('UPPER  Case') === 'upper-case', a.slugify('UPPER  Case'))
check('a slug trims separators', a.slugify('---a b---') === 'a-b', a.slugify('---a b---'))
check('a slug is capped and does not end on a separator', a.slugify('a'.repeat(200)) === 'a'.repeat(40))
check('a non-Latin subject reduces to nothing', a.slugify('把 worktree 接进账本') === 'worktree',
  a.slugify('把 worktree 接进账本'))
check('a purely non-Latin subject reduces to empty', a.slugify('完全中文') === '', a.slugify('完全中文'))

check('a name carries the report id', a.worktreeName('R-0007', 'Fix the bug') === 'R-0007-fix-the-bug',
  a.worktreeName('R-0007', 'Fix the bug'))
check('a name falls back to the bare id when there is no slug',
  a.worktreeName('R-0007', '完全中文') === 'R-0007', a.worktreeName('R-0007', '完全中文'))
check('a branch is namespaced under the prefix', a.worktreeBranch('R-0007', 'Fix') === 'dsh/R-0007-fix',
  a.worktreeBranch('R-0007', 'Fix'))

// ---- fixtures --------------------------------------------------------------
const repo = join(scratch, 'repo')
await mkdir(repo, { recursive: true })
await git(repo, 'init', '-q', '--initial-branch=main')
await git(repo, 'config', 'core.autocrlf', 'false')
await git(repo, 'config', 'user.name', 'allocate-check')
await git(repo, 'config', 'user.email', 'allocate-check@example.invalid')
await writeFile(join(repo, 'f.txt'), 'l1\n')
await git(repo, 'add', '-A')
await git(repo, 'commit', '-q', '-m', 'base')

const located = await w.resolveRepo(repo)
if (located === undefined) throw new Error('fixture repository did not resolve')

check('the default path sits under the repository worktree root',
  w.samePath(a.worktreePath(located, 'R-0007', 'Fix'), join(located.worktreeRoot, 'R-0007-fix')),
  a.worktreePath(located, 'R-0007', 'Fix'))
check('a configured base keeps the repository name as a component',
  w.samePath(a.worktreePath(located, 'R-0007', 'Fix', join(scratch, 'elsewhere')),
    join(scratch, 'elsewhere', located.repoName, 'R-0007-fix')),
  a.worktreePath(located, 'R-0007', 'Fix', join(scratch, 'elsewhere')))

const live = new Set<string>(['owner-a', 'owner-b', 'owner-c'])
const service = new ReportService({
  getAgent(sessionId) {
    if (!live.has(sessionId)) return undefined
    return { id: sessionId, steer: () => {}, inject: () => {} }
  },
  describe: async (sessionId) => `name-of-${sessionId}`,
})

/** Provision a checkout for a fresh report and author it, as a caller would. */
const leaseInto = async (subject: string, actor: string, settings: WorktreeSettings = generous) => {
  const report = await ledger.allocateId()
  const prepared = await service.prepareWorktree({
    report, subject, actor, repo: located, base: 'main', settings,
  })
  await service.author({ reportId: report, subject, body: 'body', actor, worktree: prepared.binding })
  return { report, prepared }
}

const digestOf = async (report: string) => (await ledger.readReport(report))?.front

// ---- 2. provisioning really creates the checkout ---------------------------
const first = await leaseInto('first checkout', 'owner-a')
check('a prepared binding is marked as allocated by the ledger',
  first.prepared.binding.allocated === true && first.prepared.binding.repo !== undefined)
check('the branch is the derived name',
  first.prepared.binding.branch === 'dsh/R-0001-first-checkout', first.prepared.binding.branch)
const listedAfterFirst = await w.listWorktrees(located)
check('git lists the new checkout',
  listedAfterFirst.some((entry) => w.samePath(entry.path, first.prepared.binding.path)))
check('the branch is held by the new checkout',
  w.samePath(w.branchHolders(listedAfterFirst).get(first.prepared.binding.branch)?.path ?? '',
    first.prepared.binding.path))
check('the checkout starts at the requested base',
  first.prepared.binding.head === (await w.headOf(repo)), String(first.prepared.binding.head))
check('the report records the binding and the claim together',
  (await digestOf(first.report))?.worktree?.branch === first.prepared.binding.branch)
const firstHops = await ledger.readHops(first.report)
check('authoring with a binding records both hops',
  firstHops.some((h) => h.action === 'authored') && firstHops.some((h) => h.action === 'leased'))

// ---- 3. the budget refuses, and reclamation cannot buy it off --------------
// The held checkout belongs to a live report, so a full active budget must be a
// refusal naming the holder — never an invitation to clear someone else's work.
let budgetRefusal = ''
try {
  await leaseInto('over budget', 'owner-b', { ...generous, maxActive: 1, maxRetained: 0, reclaim: 'oldest-closed' })
} catch (error) {
  budgetRefusal = error instanceof Error ? error.message : String(error)
}
check('a full active budget refuses the allocation', budgetRefusal !== '', 'the allocation was allowed')
check('the refusal names the holder', budgetRefusal.includes(first.report), budgetRefusal)
check('the refusal says whether the holder is around', budgetRefusal.includes('(live)'), budgetRefusal)
check('the refusal offers the ways out', budgetRefusal.includes('report_release'), budgetRefusal)
check('a full budget is refused even with reclamation enabled',
  budgetRefusal.includes('budget is full'), budgetRefusal)
check('the refused allocation left no checkout behind',
  (await w.listWorktrees(located)).length === 2, String((await w.listWorktrees(located)).length))

// ---- 4. the submodule gate -------------------------------------------------
await writeFile(join(repo, '.gitmodules'), '[submodule "x"]\n\tpath = x\n\turl = ./x\n')
let submoduleRefusal = ''
try {
  await leaseInto('in a superproject', 'owner-b')
} catch (error) {
  submoduleRefusal = error instanceof Error ? error.message : String(error)
}
check('a repository using submodules refuses allocation', submoduleRefusal.includes('submodules'), submoduleRefusal)
check('the refusal explains why', submoduleRefusal.includes('cannot be moved'), submoduleRefusal)
await rm(join(repo, '.gitmodules'))

// ---- 5. retained counting and what may be reclaimed ------------------------
const second = await leaseInto('second checkout', 'owner-a')

// A claim that ended but whose report is still open is not a candidate: the
// conversation continues, and the checkout may be claimed again tomorrow.
await service.release(second.report, 'owner-a')
const secondDigest = await digestOf(second.report)
check('a released binding survives on the digest', secondDigest?.worktree !== undefined)
const openRetained = await a.planAllocation({
  report: 'R-9999', subject: 'probe', repo: located,
  digests: await ledger.listReports(),
  hopsOf: async (id) => await ledger.readHops(id),
  isLive: () => false,
}, { ...generous, maxRetained: 0, reclaim: 'oldest-closed' })
check('a released claim on an open report is not reclaimed',
  !('kind' in openRetained) && openRetained.reclaimed === undefined,
  JSON.stringify('kind' in openRetained ? openRetained : openRetained.reclaimed))

// An adopted checkout belongs to whoever made it, whatever the report says.
const adoptedId = await ledger.allocateId()
const adoptedPath = join(located.worktreeRoot, 'adopted')
await w.addWorktree({ repo: located, path: adoptedPath, branch: 'adopted-branch', base: 'main' })
await service.author({
  reportId: adoptedId, subject: 'adopted checkout', body: 'b', actor: 'owner-a',
  worktree: { path: adoptedPath, branch: 'adopted-branch', repo: located.commonDir },
})
await service.close(adoptedId, 'owner-a', 'done')
const adoptedPlan = await a.planAllocation({
  report: 'R-9999', subject: 'probe', repo: located,
  digests: await ledger.listReports(),
  hopsOf: async (id) => await ledger.readHops(id),
  isLive: () => false,
}, { ...generous, maxRetained: 0, reclaim: 'oldest-closed' })
check('an adopted checkout is never reclaimed',
  !('kind' in adoptedPlan) && adoptedPlan.reclaimed?.report !== adoptedId,
  JSON.stringify(!('kind' in adoptedPlan) ? adoptedPlan.reclaimed : adoptedPlan))

// ---- 6. reclamation picks the oldest clean candidate ----------------------
// Distinct release times, so "oldest" is decided by the clock rather than by the
// tie-break on report id.
const oldCandidate = await leaseInto('oldest candidate', 'owner-a')
await service.close(oldCandidate.report, 'owner-a', 'done')
await new Promise((resolve) => { setTimeout(resolve, 8) })
const newCandidate = await leaseInto('newer candidate', 'owner-b')
await service.close(newCandidate.report, 'owner-b', 'done')

const digestBeforeReclaim = await digestOf(oldCandidate.report)
const reclaimSettings: WorktreeSettings = { ...generous, maxActive: 99, maxRetained: 1, reclaim: 'oldest-closed' }
const planned = await a.planAllocation({
  report: 'R-9999', subject: 'probe', repo: located,
  digests: await ledger.listReports(),
  hopsOf: async (id) => await ledger.readHops(id),
  isLive: () => false,
}, reclaimSettings)
check('reclamation chooses a candidate', !('kind' in planned) && planned.reclaimed !== undefined)
check('reclamation chooses the oldest by release time',
  !('kind' in planned) && planned.reclaimed?.report === oldCandidate.report,
  JSON.stringify(!('kind' in planned) ? planned.reclaimed : planned))
check('an unclean oldest candidate is skipped, not forced',
  !('kind' in planned) && planned.reclaimSkipped.length === 0)

// Dirt on the oldest must move the choice to the next clean one and be reported.
await writeFile(join(oldCandidate.prepared.binding.path, 'uncommitted.txt'), 'x\n')
const withDirty = await a.planAllocation({
  report: 'R-9999', subject: 'probe', repo: located,
  digests: await ledger.listReports(),
  hopsOf: async (id) => await ledger.readHops(id),
  isLive: () => false,
}, reclaimSettings)
check('a dirty candidate is skipped in favour of the next clean one',
  !('kind' in withDirty) && withDirty.reclaimed?.report === newCandidate.report,
  JSON.stringify(!('kind' in withDirty) ? withDirty.reclaimed : withDirty))
check('the skipped candidate is reported with its reason',
  !('kind' in withDirty) && withDirty.reclaimSkipped.some((entry) => entry.includes(oldCandidate.report)
    && entry.includes('uncommitted')), JSON.stringify(!('kind' in withDirty) ? withDirty.reclaimSkipped : []))
check('the dirty checkout is still on disk', await w.isWorktreeClean(oldCandidate.prepared.binding.path) === false)
await rm(join(oldCandidate.prepared.binding.path, 'uncommitted.txt'))

check('reclamation is off by default',
  !('kind' in await a.planAllocation({
    report: 'R-9999', subject: 'probe', repo: located,
    digests: await ledger.listReports(),
    hopsOf: async (id) => await ledger.readHops(id),
    isLive: () => false,
  }, { ...reclaimSettings, reclaim: 'never' })))

// ---- 7. reclamation happens, is recorded, and does not revive the report ---
const before = await service.prepareWorktree({
  report: 'R-9999', subject: 'probe', actor: 'owner-c', repo: located, base: 'main',
  settings: reclaimSettings,
})
check('provisioning carries out the reclamation', before.reclaimed?.report === oldCandidate.report,
  JSON.stringify(before.reclaimed))
check('the reclaimed checkout is gone from disk',
  !(await w.listWorktrees(located)).some((entry) => w.samePath(entry.path, oldCandidate.prepared.binding.path)))
check('the reclaimed report is told, in its own trail',
  (await ledger.readHops(oldCandidate.report)).some((h) => h.action === 'reclaimed'))
// The whole reason the administrative hop exists: clearing litter must not make
// a concluded report look active again and float it to the top of every listing.
check('the reclaimed report does not look newly active',
  (await digestOf(oldCandidate.report))?.updated === digestBeforeReclaim?.updated,
  `${(await digestOf(oldCandidate.report))?.updated} vs ${digestBeforeReclaim?.updated}`)
check('the reclaimed report stays concluded', (await digestOf(oldCandidate.report))?.status === 'closed')
await service.discardWorktree(before.binding)

// ---- 8. a checkout that vanished without the ledger's help -----------------
// The ledger's own removals leave a `reclaimed` hop, so a binding that is merely
// `released` with no directory underneath was removed by someone else. It frees
// no disk, so it must not count as retained — and crucially the belief has to be
// corrected *once*: left alone, the binding is re-examined on every allocation,
// and since a missing directory fails the cleanliness check it gets reported as
// having uncommitted changes. That sentence is wrong, and it sends a reader
// looking for work nobody left.
const vanished = await leaseInto('vanished checkout', 'owner-b')
await service.close(vanished.report, 'owner-b', 'done')
const vanishedUpdated = (await digestOf(vanished.report))?.updated
await rm(vanished.prepared.binding.path, { recursive: true, force: true })
await w.pruneWorktrees(located)

const stalePlan = await a.planAllocation({
  report: 'R-9999', subject: 'probe', repo: located,
  digests: await ledger.listReports(),
  hopsOf: async (id) => await ledger.readHops(id),
  isLive: () => false,
}, { ...generous, maxRetained: 0, reclaim: 'oldest-closed' })
check('a checkout removed by hand is reported as stale',
  !('kind' in stalePlan) && stalePlan.stale.some((entry) => entry.report === vanished.report),
  JSON.stringify(!('kind' in stalePlan) ? stalePlan.stale : stalePlan))
check('a vanished checkout is not misreported as dirty',
  !('kind' in stalePlan) && !stalePlan.reclaimSkipped.some((entry) => entry.includes(vanished.report)),
  JSON.stringify(!('kind' in stalePlan) ? stalePlan.reclaimSkipped : []))

// Provisioning records it, which is what makes the state terminal rather than
// repeated — and it must not make a concluded report look active again.
const cleared = await service.prepareWorktree({
  report: 'R-9998', subject: 'probe two', actor: 'owner-c', repo: located, base: 'main',
  settings: { ...generous, maxRetained: 8 },
})
check('provisioning records the vanished checkout',
  cleared.stale.some((entry) => entry.report === vanished.report), JSON.stringify(cleared.stale))
check('the vanished checkout is now terminated, not re-examined',
  leaseState(await ledger.readHops(vanished.report)) === 'reclaimed',
  leaseState(await ledger.readHops(vanished.report)))
check('the record says the checkout was already gone',
  (await ledger.readHops(vanished.report)).some((h) => h.action === 'reclaimed'
    && (h.note ?? '').includes('already gone')))
check('recording it did not make the concluded report look active again',
  (await digestOf(vanished.report))?.updated === vanishedUpdated,
  `${(await digestOf(vanished.report))?.updated} vs ${vanishedUpdated}`)
const afterClear = await a.planAllocation({
  report: 'R-9999', subject: 'probe', repo: located,
  digests: await ledger.listReports(),
  hopsOf: async (id) => await ledger.readHops(id),
  isLive: () => false,
}, { ...generous, maxRetained: 0, reclaim: 'oldest-closed' })
check('the next plan no longer mentions it at all',
  !('kind' in afterClear)
  && !afterClear.stale.some((entry) => entry.report === vanished.report)
  && !afterClear.reclaimSkipped.some((entry) => entry.includes(vanished.report)),
  JSON.stringify(!('kind' in afterClear) ? { stale: afterClear.stale, skipped: afterClear.reclaimSkipped } : afterClear))
await service.discardWorktree(cleared.binding)

// ---- 9. close decides the checkout's fate, and says which ------------------
const kept = await leaseInto('kept on close', 'owner-a')
const keptResult = await service.close(kept.report, 'owner-a', 'done')
check('closing keeps the checkout by default', keptResult.worktree?.action === 'kept',
  JSON.stringify(keptResult.worktree))
check('the kept checkout is still on disk', await w.isWorktreeClean(kept.prepared.binding.path))
check('the closed hop records the disposition',
  (await ledger.readHops(kept.report)).some((h) => h.action === 'closed' && (h.note ?? '').includes('working tree kept')))

const removed = await leaseInto('removed on close', 'owner-b')
const removedResult = await service.close(removed.report, 'owner-b', 'done', { worktree: 'remove-if-clean' })
check('an opt-in removal happens', removedResult.worktree?.action === 'removed', JSON.stringify(removedResult.worktree))
check('the removed checkout is gone',
  !(await w.listWorktrees(located)).some((entry) => w.samePath(entry.path, removed.prepared.binding.path)))
check('the closed hop records the removal',
  (await ledger.readHops(removed.report)).some((h) => h.action === 'closed' && (h.note ?? '').includes('working tree removed')))

const refused = await leaseInto('refused on close', 'owner-c')
await writeFile(join(refused.prepared.binding.path, 'still-working.txt'), 'x\n')
const refusedResult = await service.close(refused.report, 'owner-c', 'done', { worktree: 'remove-if-clean' })
check('removal is refused for an unclean checkout', refusedResult.worktree?.action === 'refused',
  JSON.stringify(refusedResult.worktree))
check('the refusal quotes git rather than paraphrasing',
  (refusedResult.worktree?.detail ?? '').includes('modified or untracked'),
  refusedResult.worktree?.detail ?? '')
check('a refused removal leaves the work in place',
  !(await w.isWorktreeClean(refused.prepared.binding.path)))
check('a refused removal still closes the report', refusedResult.front.status === 'closed')
check('the closed hop records the refusal',
  (await ledger.readHops(refused.report)).some((h) => h.action === 'closed'
    && (h.note ?? '').includes('working tree kept')))

// ---- 10. rollback and id recovery -----------------------------------------
const abandoned = await leaseInto('rollback target', 'owner-a')
check('a clean checkout can be rolled back', await service.discardWorktree(abandoned.prepared.binding))
check('the rollback removed it', !(await w.listWorktrees(located))
  .some((entry) => w.samePath(entry.path, abandoned.prepared.binding.path)))
const dirtyRollback = await leaseInto('dirty rollback', 'owner-b')
await writeFile(join(dirtyRollback.prepared.binding.path, 'work.txt'), 'x\n')
check('a rollback refuses to force a dirty checkout',
  !(await service.discardWorktree(dirtyRollback.prepared.binding)))
check('the dirty checkout survived the rollback',
  !(await w.isWorktreeClean(dirtyRollback.prepared.binding.path)))

const spare = await ledger.allocateId()
check('an unused id can be given back', await ledger.discardUnwrittenId(spare))
check('the given-back id is no longer a document', !ledger.reportExists(spare))
check('an id with content is never discarded', !(await ledger.discardUnwrittenId(abandoned.report)))
check('the written report survived', ledger.reportExists(abandoned.report))

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
