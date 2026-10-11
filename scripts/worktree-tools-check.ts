// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts and `filter` silently resolves to the DOM's window.filter.
// Emitted as nothing; it exists so `tsc` treats the file as its own module.
export {}
/**
 * Deterministic checks for the worktree feature's model-facing surface.
 *
 * The service layer is covered elsewhere; what is covered here is the layer that
 * only exists once tools are wired — the order a checkout, a peer and a report
 * have to be created in, and what happens to a checkout that was made for work
 * which then failed to start. That rollback is the part with no equivalent
 * anywhere else in the plugin: it is the only place the ledger destroys
 * something it created.
 *
 * The tool definitions are driven directly through a capturing registry, with a
 * real {@link PeerService} over a fake host, so the peer's own `cwd` handling is
 * exercised rather than mocked away.
 *
 * Run: node scripts/worktree-tools-check.ts
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PeerHost, PeerReceipt } from '../src/report/peer.ts'
import type { PeerService } from '../src/report/peer.ts'
import type { ReportService } from '../src/report/service.ts'
import type { WorktreeRuntime } from '../src/report/allocate.ts'

const scratch = await mkdtemp(join(tmpdir(), 'report-ledger-wt-tools-'))
// The peer roster log lives under the ledger root too, so this isolates the
// roster as well and the run cannot touch a real one.
process.env.DSH_REPORT_LEDGER_ROOT = join(scratch, 'ledger')

const w = await import('../src/report/worktree.ts')
const { ReportService: Service } = await import('../src/report/service.ts')
const { PeerService: Peers } = await import('../src/report/peer.ts')
const { registerReportTools } = await import('../src/report/tools.ts')
const { resolveWorktree } = await import('../src/report/allocate.ts')
const { leaseState } = await import('../src/report/lease.ts')
const ledger = await import('../src/report/ledger.ts')

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

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
await git(repo, 'config', 'user.name', 'worktree-tools-check')
await git(repo, 'config', 'user.email', 'worktree-tools-check@example.invalid')
await writeFile(join(repo, 'f.txt'), 'l1\n')
await git(repo, 'add', '-A')
await git(repo, 'commit', '-q', '-m', 'base')

const located = await w.resolveRepo(repo)
if (located === undefined) throw new Error('fixture repository did not resolve')

const ME = 'session-me'

/** A tool definition as the registry receives it, after `defineTool` compiles it. */
interface Captured {
  readonly name: string
  /** The shorthand parameter map arrives compiled into a JSON Schema. */
  readonly parameters: { readonly properties?: Record<string, unknown> }
  execute(args: unknown, exec: unknown): Promise<string>
}

/** The advertised parameters of one captured tool. */
const propertiesOf = (map: Map<string, Captured>, name: string): Record<string, unknown> =>
  map.get(name)?.parameters.properties ?? {}

/** Register the tools into a map instead of a live registry. */
const registry = (rt: WorktreeRuntime): Map<string, Captured> => {
  const captured = new Map<string, Captured>()
  const ctx = {
    tools: {
      register(definition: unknown): () => void {
        const entry = definition as Captured
        captured.set(entry.name, entry)
        return () => {}
      },
    },
  }
  registerReportTools(ctx, service as ReportService, peers as PeerService, rt)
  return captured
}

// ---- peers over a fake host ------------------------------------------------
const created: { sessionId: string; startedBy: string; cwd?: string }[] = []
let failCreation = false
const peerHost: PeerHost = {
  // The directory is a property of the process, not of who is asking — and an
  // absent session still has one, which is what lets the fixture allocate a
  // checkout for a report whose owner is gone.
  selfCwd: () => repo,
  liveIds: () => new Set([ME]),
  listSessionRecords: async () => [],
  readTitles: async () => new Map<string, string>(),
  listReports: async () => await ledger.listReports(),
  async createPeer(input: { sessionId: string; startedBy: string; cwd?: string }) {
    if (failCreation) throw new Error('fixture: the peer could not be created')
    created.push(input)
    return { id: input.sessionId, steer: () => {} }
  },
  async confirmPeer(): Promise<PeerReceipt | undefined> {
    return undefined
  },
}

const peers = new Peers(peerHost, 8)
const service = new Service({
  getAgent: (sessionId: string) => sessionId === ME
    ? { id: ME, steer: () => {}, inject: () => {} }
    : undefined,
  describe: async () => undefined,
  selfCwd: (sessionId: string) => peerHost.selfCwd(sessionId),
})

const runtime: WorktreeRuntime = resolveWorktree({ enabled: true, maxActive: 8, maxRetained: 8 })
const tools = registry(runtime)

// ---- 1. the feature is invisible when it is off ----------------------------
const offTools = registry(resolveWorktree(undefined))
check('the plugin registers its tools', tools.size >= 12, String(tools.size))
check('with the feature off, report_author advertises no worktree parameter',
  !('worktree' in propertiesOf(offTools, 'report_author')), Object.keys(propertiesOf(offTools, 'report_author')).join())
check('with the feature off, peer_start advertises no worktree parameter',
  !('worktree' in propertiesOf(offTools, 'peer_start')), Object.keys(propertiesOf(offTools, 'peer_start')).join())
check('with the feature on, report_author advertises it',
  'worktree' in propertiesOf(tools, 'report_author'), Object.keys(propertiesOf(tools, 'report_author')).join())
check('with the feature on, peer_start advertises it',
  'worktree' in propertiesOf(tools, 'peer_start'), Object.keys(propertiesOf(tools, 'peer_start')).join())
check('report_close offers the on-disk choice as an enum',
  (propertiesOf(tools, 'report_close').worktree as { enum?: string[] } | undefined)?.enum?.length === 2,
  JSON.stringify(propertiesOf(tools, 'report_close').worktree))
check('report_release always exists, because releasing needs no git',
  tools.has('report_release'))
// Claiming needs git and a real checkout, so it is advertised exactly when the
// feature is — the release half is not, because giving a claim up never needs one.
check('report_lease is advertised only when the feature is on',
  !offTools.has('report_lease') && tools.has('report_lease'),
  `off=${offTools.has('report_lease')} on=${tools.has('report_lease')}`)

const call = async (name: string, args: unknown): Promise<string> => {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return await tool.execute(args, { agent: { id: ME } })
}

// ---- 2. authoring with a checkout ------------------------------------------
const authored = await call('report_author', { subject: 'tool allocated checkout', body: 'b', worktree: true })
check('report_author reports the checkout it made', authored.includes('branch=dsh/R-'), authored)
check('report_author says what is shared, not just what is private',
  authored.includes('shared: config, hooks'), authored)
const authoredDigest = (await ledger.listReports()).find((front) => front.subject === 'tool allocated checkout')
check('the authored report carries the binding', authoredDigest?.worktree?.allocated === true)
check('the binding is a real checkout on disk',
  authoredDigest?.worktree !== undefined && await w.isWorktreeClean(authoredDigest.worktree.path))
check('the binding is claimed, not merely recorded',
  authoredDigest !== undefined
  && (await ledger.readHops(authoredDigest.report)).some((hop) => hop.action === 'leased'))

// ---- 3. a peer started in its own checkout ---------------------------------
const beforePeers = created.length
const peerOut = await call('peer_start', { task: 'summarize the ledger', worktree: true })
check('peer_start created a peer', created.length === beforePeers + 1)
const started = created[created.length - 1]
check('the peer starts outside the caller directory',
  started?.cwd !== undefined && !w.samePath(started.cwd, repo), String(started?.cwd))
check('the peer directory is a working tree of the same repository',
  started?.cwd !== undefined && w.samePath((await w.resolveRepo(started.cwd))?.commonDir ?? '', located.commonDir))
check('peer_start reports the checkout it made',
  peerOut.includes('private: working directory and index'), peerOut)
const peerDigest = (await ledger.listReports()).find((front) => front.subject === 'summarize the ledger')
// The orientation the peer itself reads lives in the assignment report body, not
// in the caller's tool output: the peer is a separate session that opens the
// report, so that is the only text guaranteed to reach it.
const peerBody = peerDigest === undefined ? '' : (await ledger.readReport(peerDigest.report))?.body ?? ''
check('the peer is told it has its own checkout', peerBody.includes('独立的 git 检出'), peerBody.slice(0, 160))
check('the peer is warned that hooks and config are shared',
  peerBody.includes('对象库与其它检出共享'), peerBody.slice(0, 160))
check('the assignment report is bound to the peer checkout',
  peerDigest?.worktree !== undefined && started?.cwd !== undefined && w.samePath(peerDigest.worktree.path, started.cwd))

// ---- 4. a checkout made for work that never started is rolled back ---------
const worktreesBefore = (await w.listWorktrees(located)).length
const documentsBefore = (await readdir(ledger.reportsDir())).filter((name) => name.endsWith('.md')).length
failCreation = true
let rollbackError = ''
try {
  await call('peer_start', { task: 'a peer that cannot start', worktree: true })
} catch (error) {
  rollbackError = error instanceof Error ? error.message : String(error)
}
failCreation = false
check('a peer that cannot be created fails the call', rollbackError.includes('could not be created'), rollbackError)
check('the checkout made for it is gone',
  (await w.listWorktrees(located)).length === worktreesBefore,
  `${(await w.listWorktrees(located)).length} vs ${worktreesBefore}`)
// The claimed id was an empty placeholder; leaving it would burn the number and
// appear in no listing, which is exactly the kind of leak nobody notices.
check('the claimed report id was given back',
  (await readdir(ledger.reportsDir())).filter((name) => name.endsWith('.md')).length === documentsBefore,
  `${(await readdir(ledger.reportsDir())).length} vs ${documentsBefore}`)
check('no report was left describing the failed peer',
  !(await ledger.listReports()).some((front) => front.subject === 'a peer that cannot start'))

// ---- 5. releasing through the tool ----------------------------------------
const released = await call('report_release', {
  report: authoredDigest?.report ?? '', note: 'handing the checkout back',
})
check('report_release confirms the claim ended', released.includes('claim released'), released)
check('report_release says the checkout itself is untouched',
  released.includes('untouched') && released.includes('stays traceable'), released)
let doubleRelease = ''
try {
  await call('report_release', { report: authoredDigest?.report ?? '' })
} catch (error) {
  doubleRelease = error instanceof Error ? error.message : String(error)
}
check('releasing twice is refused', doubleRelease.includes('nothing to release'), doubleRelease)

// ---- 6. closing decides the checkout's fate, through the tool --------------
const disposed = await call('report_close', {
  report: peerDigest?.report ?? '', note: 'done', worktree: 'remove-if-clean',
})
check('report_close reports the removal', disposed.includes('working tree removed'), disposed)
check('the checkout is gone',
  peerDigest?.worktree === undefined
  || !(await w.listWorktrees(located)).some((entry) => w.samePath(entry.path, peerDigest.worktree?.path ?? '')))
check('report_close still says the report can reopen', disposed.includes('reopens it automatically'))

const kept = await call('report_author', { subject: 'kept checkout', body: 'b', worktree: true })
const keptDigest = (await ledger.listReports()).find((front) => front.subject === 'kept checkout')
const keptClose = await call('report_close', { report: keptDigest?.report ?? '', note: 'done' })
check('closing keeps the checkout by default', keptClose.includes('working tree kept'), keptClose)
check('the kept checkout survives', keptDigest?.worktree !== undefined
  && await w.isWorktreeClean(keptDigest.worktree.path))
check('closing the report released the claim',
  keptDigest !== undefined && leaseState(await ledger.readHops(keptDigest.report)) === 'released',
  keptDigest === undefined ? 'no digest' : leaseState(await ledger.readHops(keptDigest.report)))

// ---- 7. adopting a checkout a previous report let go ----------------------
// The release half is only half a lifecycle without this: a checkout someone
// released has to be claimable again, and the branch is read from git rather
// than demanded from the caller.
const adopter = await call('report_author', { subject: 'adopts a released checkout', body: 'b' })
check('a report can be authored without a checkout', adopter.includes('hops='), adopter)
const adopterDigest = (await ledger.listReports()).find((front) => front.subject === 'adopts a released checkout')
const claimed = await call('report_lease', {
  report: adopterDigest?.report ?? '',
  path: keptDigest?.worktree?.path ?? '',
})
check('report_lease claims an existing checkout', claimed.includes('claimed dsh/R-'), claimed)
const claimedDigest = adopterDigest === undefined
  ? undefined
  : (await ledger.listReports()).find((front) => front.report === adopterDigest.report)
check('the claimed binding carries the branch git reports',
  claimedDigest?.worktree?.branch === keptDigest?.worktree?.branch,
  `${claimedDigest?.worktree?.branch} vs ${keptDigest?.worktree?.branch}`)
check('the claimed binding carries the real commit', claimedDigest?.worktree?.head !== undefined)
check('the claim is recorded', adopterDigest !== undefined
  && leaseState(await ledger.readHops(adopterDigest.report)) === 'held')

let doubleClaim = ''
try {
  await call('report_lease', {
    report: adopterDigest?.report ?? '',
    path: keptDigest?.worktree?.path ?? '',
  })
} catch (error) {
  doubleClaim = error instanceof Error ? error.message : String(error)
}
check('re-claiming your own checkout is allowed', doubleClaim === '', doubleClaim)

// A checkout a *different* live report holds is refused, and the refusal names
// the holder — that is what makes the claim a lock rather than a hope.
const intruder = await call('report_author', { subject: 'wants a held checkout', body: 'b' })
const intruderDigest = (await ledger.listReports()).find((front) => front.subject === 'wants a held checkout')
let heldRefusal = ''
try {
  await call('report_lease', {
    report: intruderDigest?.report ?? '',
    path: keptDigest?.worktree?.path ?? '',
  })
} catch (error) {
  heldRefusal = error instanceof Error ? error.message : String(error)
}
check('a checkout another live report holds is refused',
  heldRefusal.includes('already holds'), heldRefusal)
check('the refusal names who to ask', heldRefusal.includes('report_release'), heldRefusal)

// Hand the claim back, so the budget test below starts from an empty ledger of
// live claims rather than inheriting this one.
const adopterClose = await call('report_close', { report: adopterDigest?.report ?? '', note: 'adoption verified' })
check('the adopter can conclude and release', adopterClose.includes('closed'), adopterClose)

// ---- 8. the onClose config is what the tool actually defaults to ----------
// A knob nothing reads is a lie, so this pins the behaviour it claims: with
// `remove-if-clean` configured, closing removes without the caller saying so.
const removing = registry(resolveWorktree({ enabled: true, onClose: 'remove-if-clean', maxActive: 8, maxRetained: 8 }))
const doomedOut = await removing.get('report_author')?.execute(
  { subject: 'removed by configuration', body: 'b', worktree: true }, { agent: { id: ME } },
)
const doomed = (await ledger.listReports()).find((front) => front.subject === 'removed by configuration')
check('the configured run allocated a checkout',
  typeof doomedOut === 'string' && doomed?.worktree !== undefined, String(doomedOut))
const doomedClose = await removing.get('report_close')?.execute(
  { report: doomed?.report ?? '', note: 'done' }, { agent: { id: ME } },
)
check('the onClose config reaches the tool without a parameter',
  typeof doomedClose === 'string' && doomedClose.includes('working tree removed'), String(doomedClose))
check('the configured removal happened on disk',
  doomed?.worktree === undefined
  || !(await w.listWorktrees(located)).some((entry) => w.samePath(entry.path, doomed.worktree?.path ?? '')))
// A removal the ledger performed has to be recorded as such, or the binding sits
// at `released` with nothing on disk and every maintenance read reports the
// workflow as an anomaly.
check('the configured removal is recorded as reclaimed',
  doomed !== undefined && leaseState(await ledger.readHops(doomed.report)) === 'reclaimed',
  doomed === undefined ? 'no digest' : leaseState(await ledger.readHops(doomed.report)))

// ---- 9. the budget refusal reaches the model as a sentence -----------------
// A full budget must refuse through the tool with the holder named, because that
// is the only form of the message a caller can act on.
const tight = resolveWorktree({ enabled: true, maxActive: 1, maxRetained: 8 })
const tightTools = registry(tight)
const holderOut = await tightTools.get('report_author')?.execute(
  { subject: 'holds the only slot', body: 'b', worktree: true }, { agent: { id: ME } },
)
check('a single slot can be taken before the budget is tested',
  typeof holderOut === 'string' && holderOut.includes('branch=dsh/R-'), String(holderOut))
let budgetError = ''
try {
  await tightTools.get('report_author')?.execute(
    { subject: 'wants the slot', body: 'b', worktree: true }, { agent: { id: ME } },
  )
} catch (error) {
  budgetError = error instanceof Error ? error.message : String(error)
}
check('a full budget refuses through the tool', budgetError.includes('budget is full'), budgetError)
check('the refusal names the holder', budgetError.includes('holds the only slot')
  || /R-\d{4}/.test(budgetError), budgetError)
check('the refusal offers a way out', budgetError.includes('report_release'), budgetError)

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
