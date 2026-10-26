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
import type { ReportFrontMatter, RouteHop } from '../src/report/types.ts'

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
const generous: WorktreeSettings = { maxActive: 99, maxRetained: 99, relativePaths: false }

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
  await leaseInto('over budget', 'owner-b', { ...generous, maxActive: 1, maxRetained: 0 })
} catch (error) {
  budgetRefusal = error instanceof Error ? error.message : String(error)
}
check('a full active budget refuses the allocation', budgetRefusal !== '', 'the allocation was allowed')
check('the refusal names the holder', budgetRefusal.includes(first.report), budgetRefusal)
check('the refusal says whether the holder is around', budgetRefusal.includes('(live)'), budgetRefusal)
check('the refusal offers the ways out', budgetRefusal.includes('report_release'), budgetRefusal)
check('a full budget is still refused',
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

// ---- 5. allocation never deletes an old checkout ----------------------------
// The retained threshold is a warning only. A closed, kept checkout stays on
// disk no matter how far over maxRetained the next allocation is.
const second = await leaseInto('second checkout', 'owner-a')
await service.close(second.report, 'owner-a', 'done')
const secondDigest = await digestOf(second.report)
check('a released binding survives on the digest', secondDigest?.worktree !== undefined)
const overThresholdSettings: WorktreeSettings = { ...generous, maxRetained: 0 }
const overThreshold = await a.planAllocation({
  report: 'R-9999', subject: 'probe', repo: located,
  digests: await ledger.listReports(),
  hopsOf: async (id) => await ledger.readHops(id),
  isLive: () => false,
}, overThresholdSettings)
check('the plan has no reclaim slot at all',
  !('kind' in overThreshold) && !('reclaimed' in (overThreshold as unknown as Record<string, unknown>)))
check('the old checkout still counts as retained',
  !('kind' in overThreshold) && overThreshold.retained >= 1,
  JSON.stringify(!('kind' in overThreshold) ? overThreshold.retained : overThreshold))
const afterThreshold = await service.prepareWorktree({
  report: 'R-9999', subject: 'probe', actor: 'owner-c', repo: located, base: 'main',
  settings: overThresholdSettings,
})
check('provisioning over the threshold does not remove the old checkout',
  (await w.listWorktrees(located)).some((entry) => w.samePath(entry.path, second.prepared.binding.path)))
check('provisioning over the threshold records no reclaimed hop',
  !(await ledger.readHops(second.report)).some((h) => h.action === 'reclaimed'))
await service.discardWorktree(afterThreshold.binding)
await service.discardWorktree(second.prepared.binding)

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
}, { ...generous, maxRetained: 0 })
check('a checkout removed by hand is reported as stale',
  !('kind' in stalePlan) && stalePlan.stale.some((entry) => entry.report === vanished.report),
  JSON.stringify(!('kind' in stalePlan) ? stalePlan.stale : stalePlan))
check('a vanished checkout is not counted as retained',
  !('kind' in stalePlan) && stalePlan.retained === 0, JSON.stringify(!('kind' in stalePlan) ? stalePlan.retained : stalePlan))


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
}, { ...generous, maxRetained: 0 })
check('the next plan no longer mentions it at all',
  !('kind' in afterClear) && !afterClear.stale.some((entry) => entry.report === vanished.report),
  JSON.stringify(!('kind' in afterClear) ? afterClear.stale : afterClear))
await service.discardWorktree(cleared.binding)

// ---- 9. close decides the checkout's fate, and says which ------------------
const kept = await leaseInto('kept on close', 'owner-a')
await writeFile(join(kept.prepared.binding.path, 'unmerged.txt'), 'x\n')
await git(kept.prepared.binding.path, 'add', '-A')
await git(kept.prepared.binding.path, 'commit', '-q', '-m', 'unmerged work')
const keptResult = await service.close(kept.report, 'owner-a', 'done')
check('closing keeps the checkout by default', keptResult.worktree?.action === 'kept',
  JSON.stringify(keptResult.worktree))
check('closing warns about an unmerged branch',
  (keptResult.worktree?.warning ?? '').includes('not merged'), keptResult.worktree?.warning ?? '')
check('the kept checkout is still on disk', await w.isWorktreeClean(kept.prepared.binding.path))
check('the closed hop records the disposition',
  (await ledger.readHops(kept.report)).some((h) => h.action === 'closed' && (h.note ?? '').includes('working tree kept')))
check('the closed hop also records the warning',
  (await ledger.readHops(kept.report)).some((h) => h.action === 'closed' && (h.note ?? '').includes('not merged')))

const dirtyKept = await leaseInto('dirty kept on close', 'owner-a')
await writeFile(join(dirtyKept.prepared.binding.path, 'uncommitted.txt'), 'x\n')
const dirtyKeptResult = await service.close(dirtyKept.report, 'owner-a', 'done')
check('closing warns about uncommitted work',
  (dirtyKeptResult.worktree?.warning ?? '').includes('uncommitted'), dirtyKeptResult.worktree?.warning ?? '')
check('a dirty checkout still closes', dirtyKeptResult.front.status === 'closed')

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

// ---- 11. configuration is validated, not trusted ---------------------------
// A count that cannot be honoured falls back to its default: `maxActive: 0`
// would otherwise refuse every allocation forever, naming no holder at all.
const sane = a.resolveWorktree({ enabled: true })
check('the documented defaults are four and four',
  sane.settings.maxActive === 4 && sane.settings.maxRetained === 4,
  JSON.stringify(sane.settings))
check('a zero or negative maxActive falls back to the default',
  a.resolveWorktree({ maxActive: 0 }).settings.maxActive === 4
  && a.resolveWorktree({ maxActive: -2 }).settings.maxActive === 4)
check('a negative maxRetained falls back to the default',
  a.resolveWorktree({ maxRetained: -3 }).settings.maxRetained === 4)
check('a fractional count is not obeyed', a.resolveWorktree({ maxActive: 1.5 }).settings.maxActive === 4)
check('a usable count is kept verbatim',
  a.resolveWorktree({ maxActive: 2, maxRetained: 0 }).settings.maxActive === 2
  && a.resolveWorktree({ maxActive: 2, maxRetained: 0 }).settings.maxRetained === 0)
const badEnums = a.resolveWorktree({ onClose: 'remove' as never, root: 'relative/base' })
check('an unknown onClose value falls back to keep', badEnums.onClose === 'keep', badEnums.onClose)
check('a relative root is ignored instead of producing relative bindings',
  badEnums.settings.base === undefined, String(badEnums.settings.base))
const sanePlan = await a.planAllocation({
  report: 'R-9999', subject: 'probe', repo: located, digests: [], hopsOf: async () => [], isLive: () => false,
}, a.resolveWorktree({ maxActive: 0 }).settings)
check('a zero maxActive no longer refuses a plan with nobody holding anything', !('kind' in sanePlan),
  JSON.stringify(sanePlan))

// ---- 12. the relativePaths gate asks git before using the flag ------------
// The flag only exists from git 2.48, and passing it to an older git fails every
// allocation with `unknown option` after the work started. The version is
// injected here so the check does not depend on the git installed on the runner.
const oldGitPlan = await a.planAllocation({
  report: 'R-9999', subject: 'probe', repo: located, digests: [], hopsOf: async () => [], isLive: () => false,
  version: 'git version 2.47.1',
}, { ...generous, relativePaths: true })
check('relativePaths on an old git is refused before anything is created',
  'kind' in oldGitPlan && oldGitPlan.kind === 'git-version', JSON.stringify(oldGitPlan))
check('the refusal names the required version and the way out',
  'kind' in oldGitPlan && oldGitPlan.message.includes('2.48')
  && oldGitPlan.message.includes('relativePaths: false'), JSON.stringify(oldGitPlan))
const modernPlan = await a.planAllocation({
  report: 'R-9999', subject: 'probe', repo: located, digests: [], hopsOf: async () => [], isLive: () => false,
  version: 'git version 2.49.0.windows.1',
}, { ...generous, relativePaths: true })
check('a git that supports the flag passes the gate', !('kind' in modernPlan), JSON.stringify(modernPlan))

// ---- 14. a path that exists but is no longer a checkout is stale, not dirty -
const deadPath = join(scratch, 'dead-checkout')
await mkdir(deadPath, { recursive: true })
await writeFile(join(deadPath, 'leftover.txt'), 'x\n')
const deadId = await ledger.allocateId()
await service.author({
  reportId: deadId, subject: 'binding to a plain directory', body: 'b', actor: 'owner-a',
  worktree: { path: deadPath, branch: 'dsh/R-0000-gone', repo: located.commonDir, allocated: true },
})
await service.close(deadId, 'owner-a', 'done')
const deadPlan = await a.planAllocation({
  report: 'R-9999', subject: 'probe', repo: located,
  digests: await ledger.listReports(),
  hopsOf: async (id) => await ledger.readHops(id),
  isLive: () => false,
}, { ...generous, maxRetained: 0 })
const deadStale = !('kind' in deadPlan) ? deadPlan.stale.find((entry) => entry.report === deadId) : undefined
check('a directory that is not a checkout is reported stale', deadStale !== undefined,
  JSON.stringify(!('kind' in deadPlan) ? deadPlan.stale : deadPlan))
check('the stale record says what was found there instead',
  (deadStale?.detail ?? '').includes('no longer a working tree'), String(deadStale?.detail))
const deadRun = await service.prepareWorktree({
  report: 'R-9997', subject: 'stale run', actor: 'owner-c', repo: located, base: 'main', settings: generous,
})
check('provisioning records the belief once', deadRun.stale.some((entry) => entry.report === deadId),
  JSON.stringify(deadRun.stale))
check('the record stops it being re-examined',
  leaseState(await ledger.readHops(deadId)) === 'reclaimed',
  leaseState(await ledger.readHops(deadId)))
check('the record says there was nothing to remove',
  (await ledger.readHops(deadId)).some((h) => h.action === 'reclaimed' && (h.note ?? '').includes('nothing to remove')))
const afterDead = await a.planAllocation({
  report: 'R-9999', subject: 'probe', repo: located,
  digests: await ledger.listReports(),
  hopsOf: async (id) => await ledger.readHops(id),
  isLive: () => false,
}, { ...generous, maxRetained: 0 })
check('the next plan no longer mentions it',
  !('kind' in afterDead) && !afterDead.stale.some((entry) => entry.report === deadId),
  JSON.stringify(!('kind' in afterDead) ? afterDead.stale : afterDead))
await service.discardWorktree(deadRun.binding)

// ---- 15. the retained count is scoped to the repository being allocated in --
// A closed, clean, ledger-allocated checkout in repoA is not repoB's retained
// count. Its binding is visible in the global ledger, but planAllocation must
// not inspect or count it when allocating in repoB.
const crossPath = join(scratch, 'repo-a-cross')
const crossMade = await w.addWorktree({ repo: located, path: crossPath, branch: 'cross-a', base: 'main' })
if (!crossMade.ok) throw new Error(`cross-repo fixture failed: ${crossMade.stderr}`)
const repoB = join(scratch, 'repo-b')
await mkdir(repoB, { recursive: true })
await git(repoB, 'init', '-q', '--initial-branch=main')
await git(repoB, 'config', 'core.autocrlf', 'false')
await git(repoB, 'config', 'user.name', 'allocate-check')
await git(repoB, 'config', 'user.email', 'allocate-check@example.invalid')
await writeFile(join(repoB, 'f.txt'), 'l1\n')
await git(repoB, 'add', '-A')
await git(repoB, 'commit', '-q', '-m', 'base')
const locatedB = await w.resolveRepo(repoB)
if (locatedB === undefined) throw new Error('repoB did not resolve')
const crossFront = {
  report: 'R-9001', subject: 'repo A old checkout', status: 'closed', from: 'owner-a',
  to: [], cc: [], authors: ['owner-a'], created: 1, updated: 2, children: [], artifacts: [], hops: 2,
  worktree: { path: crossPath, branch: 'cross-a', repo: located.commonDir, allocated: true },
} as unknown as ReportFrontMatter
const crossHops: RouteHop[] = [
  { at: 1, actor: 'owner-a', action: 'leased', to: [] },
  { at: 2, actor: 'owner-a', action: 'released', to: [] },
]
const crossPlan = await a.planAllocation({
  report: 'R-9999', subject: 'repo B new checkout', repo: locatedB,
  digests: [crossFront],
  hopsOf: async () => crossHops,
  isLive: () => false,
}, { maxActive: 99, maxRetained: 0, relativePaths: false })
check('a cross-repository checkout does not consume this repository\'s retained count',
  !('kind' in crossPlan) && crossPlan.retained === 0,
  'kind' in crossPlan ? crossPlan.kind : String(crossPlan.retained))
check('the cross-repository checkout is still on disk',
  (await w.inspectCheckout(crossPath)).presence === 'worktree')
await service.discardWorktree({ path: crossPath, branch: 'cross-a', repo: located.commonDir, allocated: true })

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
