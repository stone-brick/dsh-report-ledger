// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts and `filter` silently resolves to the DOM's window.filter.
// Emitted as nothing; it exists so `tsc` treats the file as its own module.
export {}
/**
 * Deterministic checks for the working-tree maintenance view.
 *
 * The view exists to answer a question the ledger cannot answer from an index —
 * "what checkouts are out there, and is any of it broken?" — so the checks are
 * about coverage rather than arithmetic: every state a checkout can be in, and
 * the two things git knows that the ledger structurally cannot (a checkout
 * nobody bound, and an entry whose directory is gone).
 *
 * Run: node scripts/maintenance-check.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorktreeSettings } from '../src/report/allocate.ts'

const scratch = await mkdtemp(join(tmpdir(), 'report-ledger-maint-'))
process.env.DSH_REPORT_LEDGER_ROOT = join(scratch, 'ledger')

const w = await import('../src/report/worktree.ts')
const { ReportService } = await import('../src/report/service.ts')
const { buildWorktreeReport } = await import('../src/report/maintenance.ts')
const route = await import('../src/report/route.ts')
const ledger = await import('../src/report/ledger.ts')

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

const settings: WorktreeSettings = { maxActive: 8, maxRetained: 8, relativePaths: false }

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await w.runGit(cwd, args)
  if (!result.ok) {
    throw new Error(`fixture git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim() || `exit ${result.code}`}`)
  }
  return result.stdout
}

// ---- fixture ---------------------------------------------------------------
const repo = join(scratch, 'repo')
await mkdir(repo, { recursive: true })
await git(repo, 'init', '-q', '--initial-branch=main')
await git(repo, 'config', 'core.autocrlf', 'false')
await git(repo, 'config', 'user.name', 'maintenance-check')
await git(repo, 'config', 'user.email', 'maintenance-check@example.invalid')
await writeFile(join(repo, 'f.txt'), 'l1\n')
await git(repo, 'add', '-A')
await git(repo, 'commit', '-q', '-m', 'base')

const located = await w.resolveRepo(repo)
if (located === undefined) throw new Error('fixture repository did not resolve')

const ME = 'session-me'
const service = new ReportService({
  getAgent: (sessionId: string) => sessionId === ME
    ? { id: ME, steer: () => {}, inject: () => {} }
    : undefined,
  describe: async () => 'maintenance-check',
  selfCwd: () => repo,
})

const view = async (over: WorktreeSettings = settings) => await buildWorktreeReport({
  listReports: () => ledger.listReports(),
  readHops: (report: string) => ledger.readHops(report),
}, over, true)

/** Provision a checkout for a fresh report and author it, as a caller would. */
const leaseInto = async (subject: string) => {
  const report = await ledger.allocateId()
  const prepared = await service.prepareWorktree({
    report, subject, actor: ME, repo: located, base: 'main', settings,
  })
  await service.author({ reportId: report, subject, body: 'body', actor: ME, worktree: prepared.binding })
  return { report, prepared }
}

// ---- 1. nothing bound ------------------------------------------------------
const empty = await view()
check('an empty ledger has no records', empty.records.length === 0, String(empty.records.length))
check('an empty ledger has nothing active or retained', empty.active === 0 && empty.retained === 0)
check('an empty ledger says nothing', empty.warnings.length === 0, empty.warnings.join(' | '))
check('the main worktree is not reported as unmanaged', empty.unmanaged.length === 0, empty.unmanaged.join())
check('the view carries the feature state and limits',
  empty.enabled === true && empty.limits.maxActive === 8 && empty.limits.maxRetained === 8)

// ---- 2. a live claim -------------------------------------------------------
const held = await leaseInto('held checkout')
const withHeld = await view()
const heldRecord = withHeld.records.find((record) => record.report === held.report)
check('a bound checkout is reported', heldRecord !== undefined)
check('a live claim reads as held', heldRecord?.state === 'held', String(heldRecord?.state))
check('a live claim counts as active', withHeld.active === 1, String(withHeld.active))
check('a live claim is not retained', withHeld.retained === 0, String(withHeld.retained))
check('an existing checkout is reported as on disk', heldRecord?.onDisk === true)
check('an existing checkout is asked whether it is clean', heldRecord?.clean === true)
check('a fresh checkout is not prunable', heldRecord?.prunable === false)
check('the record carries the binding', heldRecord?.branch?.startsWith('dsh/R-') === true && heldRecord.subject !== '')

// ---- 3. a kept claim, then dirt --------------------------------------------
await service.close(held.report, ME, 'done')
const kept = await view()
const keptRecord = kept.records.find((record) => record.report === held.report)
check('a concluded claim reads as released', keptRecord?.state === 'released', String(keptRecord?.state))
check('a kept checkout counts as retained', kept.retained === 1, String(kept.retained))
check('a concluded claim is no longer active', kept.active === 0, String(kept.active))
check('a clean kept checkout raises nothing', kept.warnings.length === 0, kept.warnings.join(' | '))

await writeFile(join(held.prepared.binding.path, 'left-behind.txt'), 'uncommitted\n')
const dirty = await view()
check('a dirty kept checkout is reported unclean',
  dirty.records.find((record) => record.report === held.report)?.clean === false)
check('a dirty kept checkout is called out',
  dirty.warnings.some((warning) => warning.includes('uncommitted work')), dirty.warnings.join(' | '))
await rm(join(held.prepared.binding.path, 'left-behind.txt'))

// ---- 3b. a directory that is not a checkout --------------------------------
// `existsSync` is not enough: a plain directory at the recorded path used to be
// reported as a dirty checkout, which is the opposite diagnosis. Git is asked,
// and the view gets its own explanation instead of "uncommitted work".
const plainDir = join(scratch, 'plain-directory')
await mkdir(plainDir, { recursive: true })
await writeFile(join(plainDir, 'not-a-checkout.txt'), 'x\n')
const plainReport = await ledger.allocateId()
await service.author({
  reportId: plainReport,
  subject: 'plain directory binding',
  body: 'body',
  actor: ME,
  worktree: { path: plainDir, branch: 'plain', allocated: true },
})
const plainView = await view()
const plainRecord = plainView.records.find((record) => record.report === plainReport)
check('a plain directory is classified as not-a-worktree', plainRecord?.presence === 'not-a-worktree',
  String(plainRecord?.presence))
check('a plain directory is not asked about cleanliness', plainRecord?.clean === undefined,
  String(plainRecord?.clean))
check('a plain directory is not counted as retained',
  plainView.retained === kept.retained, `${plainView.retained} vs ${kept.retained}`)
check('a plain directory gets its own warning, not a dirty warning',
  plainView.warnings.some((warning) => warning.includes('no longer a working tree'))
  && !plainView.warnings.some((warning) => warning.includes('uncommitted work')),
  plainView.warnings.join(' | '))

// The retained threshold is a warning; nothing clears it automatically.
const overBudget = await view({ ...settings, maxRetained: 0 })
check('accumulation past the warning threshold is called out',
  overBudget.warnings.some((warning) => warning.includes('past the warning threshold')), overBudget.warnings.join(' | '))

// ---- 4. a checkout that vanished under a live claim ------------------------
const vanished = await leaseInto('vanishing checkout')
await rm(vanished.prepared.binding.path, { recursive: true, force: true })
const afterVanish = await view()
const vanishedRecord = afterVanish.records.find((record) => record.report === vanished.report)
check('a vanished checkout is reported as off disk', vanishedRecord?.onDisk === false)
check('a vanished checkout is not asked about cleanliness', vanishedRecord?.clean === undefined)
check('a vanished checkout is also reported dangling by git', vanishedRecord?.prunable === true)
check('a live claim on a vanished checkout is called out',
  afterVanish.warnings.some((warning) => warning.includes('no longer on disk')), afterVanish.warnings.join(' | '))
check('git reports the dangling entry', afterVanish.dangling.some((path) => w.samePath(path, vanished.prepared.binding.path)),
  afterVanish.dangling.join())

// ---- 5. a checkout the ledger never heard of -------------------------------
const strayPath = join(located.worktreeRoot, 'stray-by-hand')
const stray = await w.addWorktree({ repo: located, path: strayPath, branch: 'by-hand', base: 'main' })
check('the fixture worktree was created by raw git', stray.ok, stray.stderr.trim())
const withStray = await view()
check('an unbound checkout is reported as unmanaged',
  withStray.unmanaged.some((path) => w.samePath(path, strayPath)), withStray.unmanaged.join())
check('an unbound checkout is called out',
  withStray.warnings.some((warning) => warning.includes('no report is bound to')), withStray.warnings.join(' | '))
check('an unbound checkout is not counted as a record',
  !withStray.records.some((record) => w.samePath(record.path, strayPath)))

// An entry whose directory is gone is dangling, and is *not* offered for
// adoption — a prunable checkout is the one thing report_lease refuses.
await rm(strayPath, { recursive: true, force: true })
const afterStrayGone = await view()
check('a vanished unbound checkout is reported as dangling',
  afterStrayGone.dangling.some((path) => w.samePath(path, strayPath)), afterStrayGone.dangling.join())
check('a dangling entry is not also offered for adoption',
  !afterStrayGone.unmanaged.some((path) => w.samePath(path, strayPath)), afterStrayGone.unmanaged.join())

// ---- 6. allocation never reclaims an old checkout --------------------------
const terminal = await leaseInto('terminal checkout')
await service.close(terminal.report, ME, 'done')
const beforeAllocation = await view()
check('both concluded checkouts are retained before allocation',
  beforeAllocation.records.filter((record) => record.state === 'released' && record.onDisk).length === 2,
  String(beforeAllocation.records.filter((record) => record.state === 'released' && record.onDisk).length))
await service.prepareWorktree({
  report: 'R-9999', subject: 'probe', actor: ME, repo: located, base: 'main',
  settings: { ...settings, maxRetained: 0 },
})
const afterAllocation = await view()
const oldest = afterAllocation.records.find((record) => record.report === held.report)
const newer = afterAllocation.records.find((record) => record.report === terminal.report)
check('allocation does not clear the oldest concluded checkout',
  oldest?.state === 'released' && oldest.onDisk === true, `${oldest?.state} onDisk=${oldest?.onDisk}`)
check('allocation leaves the other concluded checkout alone',
  newer?.state === 'released' && newer.onDisk === true, `${newer?.state} onDisk=${newer?.onDisk}`)
check('both concluded checkouts are still counted as retained',
  afterAllocation.retained === 2, String(afterAllocation.retained))

// A kept checkout whose branch has unmerged commits is the orphaned experiment:
// the view has to name it even when the closing happened long ago.
const orphan = await leaseInto('orphan checkout')
await writeFile(join(orphan.prepared.binding.path, 'orphan.txt'), 'x\n')
await git(orphan.prepared.binding.path, 'add', '-A')
await git(orphan.prepared.binding.path, 'commit', '-q', '-m', 'unmerged orphan')
await service.close(orphan.report, ME, 'done')
const orphanView = await view()
check('a kept unmerged branch is called out',
  orphanView.warnings.some((warning) => warning.includes(orphan.report) && warning.includes('not merged')),
  orphanView.warnings.filter((warning) => warning.includes(orphan.report)).join(' | '))

// ---- 7. a removal the ledger performed is not an anomaly -------------------
// Closing with remove-if-clean takes the checkout away *and* records that the
// ledger did it. Without the record the binding would sit at `released` with
// nothing on disk — indistinguishable from a checkout that vanished behind the
// ledger's back — so the view would report the recommended workflow as something
// to look at, every single time. An alarm that fires on the happy path is one
// readers learn to ignore.
const swept = await leaseInto('removed by closing')
await service.close(swept.report, ME, 'done', { worktree: 'remove-if-clean' })
const afterSweep = await view()
const sweptRecord = afterSweep.records.find((record) => record.report === swept.report)
check('a checkout removed at closing reads as reclaimed', sweptRecord?.state === 'reclaimed',
  String(sweptRecord?.state))
check('a checkout removed at closing is off disk', sweptRecord?.onDisk === false)
check("the removal is recorded as the ledger's own act",
  (await ledger.readHops(swept.report)).some((hop) => hop.action === 'reclaimed'
    && (hop.note ?? '').includes("owner's request")))
check('a deliberate removal raises no warning about that report',
  !afterSweep.warnings.some((warning) => warning.includes(swept.report)),
  afterSweep.warnings.filter((warning) => warning.includes(swept.report)).join(' | '))
check('a deliberate removal is not counted as retained',
  afterSweep.records.filter((record) => record.state === 'released' && record.onDisk)
    .every((record) => record.report !== swept.report))

// ---- 8. the route ----------------------------------------------------------
const handler = route.createWorktreesHandler({
  timeline: async () => { throw new Error('unused') },
  report: async () => undefined,
  worktrees: () => view(),
})

interface Captured { status: number; headers: Record<string, unknown>; body: string }
const response = (): { captured: Captured; res: never } => {
  const captured: Captured = { status: 0, headers: {}, body: '' }
  return {
    captured,
    res: {
      writeHead(status: number, headers?: Record<string, unknown>) {
        captured.status = status
        Object.assign(captured.headers, headers ?? {})
      },
      end(chunk?: unknown) { if (typeof chunk === 'string') captured.body = chunk },
    } as never,
  }
}
const request = (over: { url: string; remoteAddress?: string; headers?: Record<string, string> }): never => ({
  url: over.url,
  method: 'GET',
  socket: { remoteAddress: over.remoteAddress ?? '127.0.0.1' },
  headers: over.headers ?? {},
}) as never

const ok = response()
await handler(request({ url: route.WORKTREES_PATH, headers: { host: '127.0.0.1:3080' } }), ok.res)
check('a trusted maintenance read answers 200', ok.captured.status === 200, String(ok.captured.status))
check('the maintenance payload is enveloped',
  ok.captured.body.includes('"ok":true') && ok.captured.body.includes('"warnings"'))
check('the maintenance response is not cacheable', ok.captured.headers['cache-control'] === 'no-store')

const untrusted = response()
await handler(request({ url: route.WORKTREES_PATH, remoteAddress: '8.8.8.8', headers: { host: '127.0.0.1:3080' } }), untrusted.res)
check('an untrusted maintenance read is refused', untrusted.captured.status === 403, String(untrusted.captured.status))

// A contained failure has to reach the browser as JSON, and the *detail* has to
// stay out of it: the route moved the underlying error text (absolute ledger
// paths, ids, OS reasons) to an injected log, so the response says only that the
// read could not be served.
const logged: string[] = []
const failing = route.createWorktreesHandler({
  timeline: async () => { throw new Error('unused') },
  report: async () => undefined,
  worktrees: async () => { throw new Error('ledger offline') },
  log: (message: string) => { logged.push(message) },
})
const broken = response()
await failing(request({ url: route.WORKTREES_PATH, headers: { host: '127.0.0.1:3080' } }), broken.res)
check('a failing maintenance source answers 500 as JSON',
  broken.captured.status === 500 && broken.captured.body.includes('"ok":false')
  && broken.captured.body.includes('internal-error'),
  `${broken.captured.status} ${broken.captured.body}`)
check('the failure detail reaches the log, never the response',
  logged.some((line) => line.includes('ledger offline')) && !broken.captured.body.includes('ledger offline'),
  `${JSON.stringify(logged)} / ${broken.captured.body}`)

// ---- report -----------------------------------------------------------------
try {
  await rm(scratch, { recursive: true, force: true })
} catch {
  // A leftover fixture is not a finding.
}

let failed = 0
for (const [label, ok_, detail] of checks) {
  if (!ok_) failed++
  console.log(`${ok_ ? 'PASS' : 'FAIL'}  ${label}${ok_ || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
