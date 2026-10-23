// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts and `filter` silently resolves to the DOM's window.filter.
// Emitted as nothing; it exists so `tsc` treats the file as its own module.
export {}
/**
 * Deterministic checks for the peer roster and peer creation.
 *
 * Classification, ordering, the authority predicate, and the creation budget are
 * all pure or file-backed decisions, so they are pinned here rather than probed
 * through a live agent: the roster is what tells an agent *who it may address*,
 * and getting that wrong either strands it (no addresses) or over-grants it
 * (addresses it should not hold).
 *
 * Run: node scripts/roster-check.ts
 */

import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'report-ledger-roster-'))
process.env.DSH_REPORT_LEDGER_ROOT = root

const { buildRoster, holdsChannelTo, appendPeer, readPeers, peerLogPath } = await import('../src/report/roster.ts')
const { PeerService } = await import('../src/report/peer.ts')
const { registerReportTools } = await import('../src/report/tools.ts')
const { resolveWorktree } = await import('../src/report/allocate.ts')

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

const at = (n: number): number => 1_700_000_000_000 + n * 1000

const SELF = 'session-self'
const records = [
  { header: { id: 'session-parent', createdAt: at(1) }, live: true },
  { header: { id: SELF, parentSession: 'session-parent', createdAt: at(2) }, live: true },
  { header: { id: 'session-sib', parentSession: 'session-parent', createdAt: at(3) }, live: false },
  { header: { id: 'session-child', parentSession: SELF, origin: 'subagent', delegationDepth: 1, createdAt: at(4) }, live: true },
  { header: { id: 'session-grand', parentSession: 'session-child', delegationDepth: 2, createdAt: at(5) }, live: false },
  { header: { id: 'session-stranger', createdAt: at(6) }, live: true },
  { header: { id: 'session-contact', createdAt: at(7) }, live: false },
  { header: { id: 'session-peer', createdAt: at(8) }, live: true },
]

const reports = [{
  report: 'R-0001',
  subject: 'exchange',
  status: 'open',
  from: 'session-contact',
  to: [SELF],
  cc: [],
  authors: [],
  created: at(9),
  updated: at(10),
  children: [],
  artifacts: [],
  hops: 2,
}] as never[]

const peers = [{ sessionId: 'session-peer', startedBy: SELF, startedAt: at(8), name: 'partner' }]

const base = {
  self: SELF,
  records: records as never,
  liveIds: new Set(['session-parent', SELF, 'session-child', 'session-stranger', 'session-peer']),
  peers,
  reports,
  titles: new Map([['session-parent', 'parent title']]),
}

const related = buildRoster({ ...base, scope: 'related', limit: 40 })
const byRelation = new Map(related.map((row) => [row.sessionId, row]))

check('the caller never appears in its own roster', !byRelation.has(SELF))
check('an ancestor is classified as ancestor', byRelation.get('session-parent')?.relation === 'ancestor')
check('a direct child is classified as descendant', byRelation.get('session-child')?.relation === 'descendant')
check('a grandchild is classified transitively', byRelation.get('session-grand')?.relation === 'descendant')
check('a shared-parent session is a sibling', byRelation.get('session-sib')?.relation === 'sibling')
check('a started peer is classified as started', byRelation.get('session-peer')?.relation === 'started')
check('a ledger partner is classified as contact', byRelation.get('session-contact')?.relation === 'contact')
check('an unrelated root is excluded from related', !byRelation.has('session-stranger'))
check('liveness is carried per row', byRelation.get('session-child')?.live === true && byRelation.get('session-sib')?.live === false)
check('a peer keeps the name its starter gave it', byRelation.get('session-peer')?.name === 'partner')
check('titles are attached where resolved', byRelation.get('session-parent')?.title === 'parent title')
check('ledger exchange counts are carried', byRelation.get('session-contact')?.reports === 1)
check('the caller\'s own reports do not count as a relation source for strangers',
  (byRelation.get('session-contact')?.reports ?? 0) === 1)

check('ordering is ancestor, descendants, sibling, started, contact',
  related.map((row) => row.sessionId).join() === 'session-parent,session-child,session-grand,session-sib,session-peer,session-contact',
  related.map((row) => row.sessionId).join())

const all = buildRoster({ ...base, scope: 'all', limit: 40 })
check('scope all includes unrelated co-present sessions', all.some((row) => row.sessionId === 'session-stranger' && row.relation === 'co-present'))

const live = buildRoster({ ...base, scope: 'live', limit: 40 })
check('scope live keeps only resident sessions', live.every((row) => row.live))
check('scope live still classifies relations', live.find((row) => row.sessionId === 'session-child')?.relation === 'descendant')

const capped = buildRoster({ ...base, scope: 'all', limit: 2 })
check('the limit caps the rows', capped.length === 2, String(capped.length))

// ---------------------------------------------------------------------------
// The authority predicate
// ---------------------------------------------------------------------------
const channel = (target: string): boolean => holdsChannelTo({ ...base }, target)
check('a channel exists to an ancestor', channel('session-parent'))
check('a channel exists to a direct child', channel('session-child'))
check('a channel exists to a grandchild', channel('session-grand'))
check('a channel exists to a sibling', channel('session-sib'))
check('a channel exists to a session the caller started', channel('session-peer'))
check('no channel to a mere ledger contact', !channel('session-contact'))
check('no channel to a stranger', !channel('session-stranger'))
check('no channel to self', !channel(SELF))
check('no channel to an empty id', !channel(''))

// ---------------------------------------------------------------------------
// The peer log
// ---------------------------------------------------------------------------
await appendPeer({ sessionId: 'session-p1', startedBy: SELF, startedAt: at(20), name: 'one' })
await appendPeer({ sessionId: 'session-p2', startedBy: 'session-other', startedAt: at(21) })
// A hand-edited or torn line must not poison the rest of the roster.
await appendFile(peerLogPath(), '{ not json\n', 'utf8')
await appendPeer({ sessionId: 'session-p3', startedBy: SELF, startedAt: at(22) })

const logged = await readPeers()
check('the peer log round-trips', logged.length === 3, String(logged.length))
check('a malformed line is skipped', !logged.some((record) => record.sessionId === undefined))
check('appended records keep their fields', logged.find((record) => record.sessionId === 'session-p1')?.name === 'one')
const logText = await readFile(peerLogPath(), 'utf8')
check('the peer log is append-only JSONL', logText.trim().split('\n').every((line) => line.trim() === '' || line.trim().startsWith('{')))

// ---------------------------------------------------------------------------
// PeerService: budget, validation, and roster integration
// ---------------------------------------------------------------------------
const created: { sessionId: string; startedBy?: string; cwd?: string }[] = []
const madeSteer: string[] = []
const host = {
  selfCwd: () => 'D:\\Projects\\demo',
  liveIds: () => new Set([SELF]),
  listSessionRecords: async () => records as never,
  readTitles: async () => new Map<string, string>(),
  listReports: async () => reports,
  createPeer: async ({ sessionId, startedBy, cwd }: { sessionId: string; startedBy?: string; cwd?: string }) => {
    created.push({ sessionId, ...(startedBy === undefined ? {} : { startedBy }), ...(cwd === undefined ? {} : { cwd }) })
    return { id: sessionId, steer: (message: { content: readonly { text: string }[] }) => { madeSteer.push(message.content[0]?.text ?? '') } }
  },
  // The receipt is an observation, so the fake host answers with one directly:
  // what matters here is that the service passes the peer id and the window
  // through unchanged and hands the observation back verbatim.
  confirmPeer: async (sessionId: string, timeoutMs: number) => ({
    kind: 'failed' as const,
    reason: 'error',
    error: `observed ${sessionId} for ${timeoutMs} ms`,
  }),
}

const loose = new PeerService(host as never, 100)
const startedOne = await loose.start(SELF, { task: 'long-horizon partner for the payments rework', name: 'payments' })
check('a peer session id follows the deployment convention', /^session-[0-9a-f-]{36}$/.test(startedOne.sessionId), startedOne.sessionId)
check('the peer inherits the caller\'s working directory', created[0]?.cwd === 'D:\\Projects\\demo', String(created[0]?.cwd))
check('creation names the starter the peer is composed from', created[0]?.startedBy === SELF, String(created[0]?.startedBy))
check('the peer is attributed in the log', (await readPeers()).some((record) => record.sessionId === startedOne.sessionId && record.startedBy === SELF))
check('the peer count is reported', startedOne.started >= 1)
check('the caller now holds a channel to what it started', await loose.holdsChannel(SELF, startedOne.sessionId))
check('the new peer appears as started in the roster',
  (await loose.roster(SELF, { scope: 'related' })).some((row) => row.sessionId === startedOne.sessionId && row.relation === 'started'))

// The permission state is what a peer inherits that cannot be seen from any other
// field, and the host is the only side that can capture it. It has to survive the
// round trip through the service unchanged, or `peer_start` cannot report it and
// the failure it guards against (a peer pinned to the deployment default) stays
// invisible to the agent that opened it.
const permissionHost = {
  ...host,
  createPeer: async ({ sessionId }: { sessionId: string }) => ({
    id: sessionId,
    steer: () => {},
    permission: { sandbox: 'danger-full-access', approval: 'never', preset: 'danger-full-access' },
  }),
}
const inheriting = await new PeerService(permissionHost as never, 100).start(SELF, { task: 'inherit the permissions' })
check('the host\'s captured permission state reaches the caller',
  inheriting.permission?.sandbox === 'danger-full-access'
  && inheriting.permission.approval === 'never'
  && inheriting.permission.preset === 'danger-full-access',
  JSON.stringify(inheriting.permission))
check('a host that captures no permission state reports none rather than guessing',
  startedOne.permission === undefined, JSON.stringify(startedOne.permission))

const before = await loose.startedCount(SELF)
const budgeted = new PeerService(host as never, before)
let budgetError = ''
try {
  await budgeted.start(SELF, { task: 'one too many' })
} catch (error) {
  budgetError = error instanceof Error ? error.message : String(error)
}
check('the budget refuses creation past the cap', budgetError.includes('limit'), budgetError)
check('the budget error is actionable', budgetError.includes('reuse an existing peer'))

let emptyError = ''
try {
  await loose.start(SELF, { task: '   ' })
} catch (error) {
  emptyError = error instanceof Error ? error.message : String(error)
}
check('an empty task is refused', emptyError.includes('non-empty task'), emptyError)

let nameError = ''
try {
  await loose.start(SELF, { task: 'ok', name: 'x'.repeat(61) })
} catch (error) {
  nameError = error instanceof Error ? error.message : String(error)
}
check('an over-long name is refused', nameError.includes('60 characters'), nameError)

let failedCreate = ''
const brokenHost = { ...host, createPeer: async () => { throw new Error('factory unavailable') } }
try {
  await new PeerService(brokenHost as never, 100).start(SELF, { task: 'x' })
} catch (error) {
  failedCreate = error instanceof Error ? error.message : String(error)
}
check('a creation failure propagates', failedCreate.includes('factory unavailable'), failedCreate)

// The receipt is what separates "the digest reached a live agent" from "someone
// is working": the service must pass the peer id and the window through and
// return the observation unchanged.
const receipt = await loose.receipt(startedOne.sessionId, 1500)
check('the receipt reaches the host with the peer id and the window', receipt?.error === `observed ${startedOne.sessionId} for 1500 ms`, String(receipt?.error))
check('a failed first turn is reported as failed, not as delivered', receipt?.kind === 'failed', String(receipt?.kind))
const noHost = { ...host, confirmPeer: async () => undefined }
const absent = await new PeerService(noHost as never, 100).receipt('session-not-here', 10)
check('a non-resident peer yields no observation rather than a false one', absent === undefined)

// ---------------------------------------------------------------------------
// Workspace registration
//
// A peer is a root session created with a `cwd` and no workspace identity, and
// the registry's one-time history bootstrap runs long before the peer exists —
// so a peer whose directory matches a registered workspace is still absent from
// that workspace's accounting and the browser lists it as ungrouped. The host
// hook is the fix; what is pinned here is that the service reaches it with the
// created session, survives its failure, and says nothing when the deployment
// composes no workspace registry at all.
// ---------------------------------------------------------------------------
const attached: { sessionId: string; cwd?: string }[] = []
const withRegistry = {
  ...host,
  attachToWorkspace: async (input: { sessionId: string; cwd?: string }) => {
    attached.push(input)
    return { outcome: 'registered' as const, workspace: 'dsh-report-ledger' }
  },
}
const registered = await new PeerService(withRegistry as never, 100).start(SELF, { task: 'a peer in a known directory', name: 'grouped' })
check('the created peer is offered to the workspace host', attached.length === 1 && attached[0]?.sessionId === registered.sessionId, JSON.stringify(attached))
check('the peer is offered with the directory it was created in', attached[0]?.cwd === 'D:\\Projects\\demo', String(attached[0]?.cwd))
check('the registration outcome reaches the caller', registered.workspace?.outcome === 'registered', String(registered.workspace?.outcome))
check('a registered peer names the workspace it joined', registered.workspace?.workspace === 'dsh-report-ledger', String(registered.workspace?.workspace))

const failing = {
  ...host,
  attachToWorkspace: async () => { throw new Error('fixture: registry refused the attach') },
}
const survived = await new PeerService(failing as never, 100).start(SELF, { task: 'a peer whose registration fails' })
check('a failing registration does not fail peer creation', /^session-[0-9a-f-]{36}$/.test(survived.sessionId), survived.sessionId)
check('a failing registration is reported as a failure', survived.workspace?.outcome === 'failed', String(survived.workspace?.outcome))
check('the failure carries its reason', survived.workspace?.warning?.includes('registry refused the attach') === true, String(survived.workspace?.warning))

const composed = await new PeerService(host as never, 100).start(SELF, { task: 'a peer where no registry is composed' })
check('a host without the hook reports no workspace at all', composed.workspace === undefined, JSON.stringify(composed.workspace))
check('a host without the hook still creates the peer', /^session-[0-9a-f-]{36}$/.test(composed.sessionId), composed.sessionId)

// ---------------------------------------------------------------------------
// peer_start at the tool layer: the failures after the point of no return.
//
// The peer is created and charged before the assignment report is written, so
// the two steps need different answers: a checkout is rolled back only while no
// peer exists, and a later failure is reported with the created session id
// instead of being compensated. The observation of the first turn is a courtesy
// and must never turn a completed hand-off into an error.
// ---------------------------------------------------------------------------
interface ToolLike {
  readonly name: string
  execute(args: unknown, exec: unknown): Promise<string>
}

/** Register the tools into a map instead of a live registry, over a fake service. */
const toolSurface = (service: unknown, peerService: unknown, worktreeConfig: unknown): Map<string, ToolLike> => {
  const tools = new Map<string, ToolLike>()
  registerReportTools({
    tools: {
      register(definition: unknown): () => void {
        const tool = definition as ToolLike
        tools.set(tool.name, tool)
        return () => {}
      },
    },
  } as never, service as never, peerService as never, resolveWorktree(worktreeConfig as never))
  return tools
}

// A checkout exists before the peer does. When the peer cannot be created, the
// checkout is rolled back; when the peer exists but its assignment cannot be
// written, the checkout must be kept because it is the peer's working directory.
const rollbacks: string[] = []
const keptPath = 'D:\\fixtures\\R-0042'
const authoringDown = {
  provision: async () => ({
    report: 'R-0042',
    prepared: { binding: { path: keptPath, branch: 'dsh/R-0042', allocated: true }, retained: [], reclaimSkipped: [], stale: [] },
  }),
  author: async () => { throw new Error('fixture: the ledger is unwritable') },
  rollbackProvision: async (input: { report: string }) => {
    rollbacks.push(input.report)
    return { worktree: true, id: true }
  },
}
const authoringTools = toolSurface(authoringDown, new PeerService(host as never, 100), { enabled: true })
let assignmentError = ''
try {
  await authoringTools.get('peer_start')?.execute(
    { task: 'a peer whose assignment cannot be written', worktree: true },
    { agent: { id: 'session-partial' } },
  )
} catch (error) {
  assignmentError = error instanceof Error ? error.message : String(error)
}
const partialPeers = (await readPeers()).filter((record) => record.startedBy === 'session-partial')
check('the peer exists once its assignment fails', partialPeers.length === 1, `records=${partialPeers.length}`)
check('the assignment failure names the created peer so its caller can address it',
  partialPeers.length === 1 && assignmentError.includes(partialPeers[0]?.sessionId ?? ''),
  assignmentError)
check('the assignment failure says the assignment was not delivered', assignmentError.includes('NOT delivered'), assignmentError)
check('the assignment failure says how to finish the hand-off',
  assignmentError.includes('report_author') && assignmentError.includes('report_send'), assignmentError)
check('the checkout handed to a live peer is not rolled back', rollbacks.length === 0, String(rollbacks.length))
check('the kept checkout is named so a report can adopt it', assignmentError.includes(keptPath), assignmentError)
check('the failed assignment still counts against the lifetime peer budget',
  (await new PeerService(host as never, 100).startedCount('session-partial')) === 1)

// The observation of the first turn is a courtesy: a host that throws while
// observing must not turn a completed hand-off into a failure the caller retries.
const receiptHost = { ...host, confirmPeer: async () => { throw new Error('fixture: session snapshot unavailable') } }
const authored = {
  front: { report: 'R-0043', status: 'open', subject: 'receipt failure', from: 'session-receipt', to: [], cc: [], authors: [], created: at(40), updated: at(41), children: [], artifacts: [], hops: 1 },
  outcomes: [],
}
const receiptTools = toolSurface({ author: async () => authored }, new PeerService(receiptHost as never, 100), undefined)
let receiptOutput = ''
let receiptFailed = ''
try {
  receiptOutput = await receiptTools.get('peer_start')?.execute(
    { task: 'a peer whose observation fails' },
    { agent: { id: 'session-receipt' } },
  ) ?? ''
} catch (error) {
  receiptFailed = error instanceof Error ? error.message : String(error)
}
check('a receipt failure does not fail the hand-off', receiptFailed === '', receiptFailed)
check('a receipt failure is reported as an unobserved first turn',
  receiptOutput.includes('could not observe the peer\'s first turn'), receiptOutput)
check('the completed hand-off is still reported', receiptOutput.includes('assignment report: R-0043'), receiptOutput)

// A whitespace-only name is not a name: it must not become a bare ": " subject
// prefix, and it must not print an empty name= field.
let namedSubject = ''
const named = {
  front: { report: 'R-0044', status: 'open', subject: 'named', from: 'session-nameless', to: [], cc: [], authors: [], created: at(42), updated: at(43), children: [], artifacts: [], hops: 1 },
  outcomes: [],
}
const namedTools = toolSurface(
  { author: async (input: { subject: string }) => { namedSubject = input.subject; return named } },
  new PeerService(host as never, 100),
  undefined,
)
const namedOutput = await namedTools.get('peer_start')?.execute(
  { task: 'do the work', name: '   ' }, { agent: { id: 'session-nameless' } },
) ?? ''
check('a whitespace-only name does not become a subject prefix', namedSubject === 'do the work', JSON.stringify(namedSubject))
check('a whitespace-only name is dropped rather than printed empty', !namedOutput.includes('name='), namedOutput)

// The inherited permission state is reported in the tool output, because that is
// the transcript the caller and the human actually read. Leaving it implicit is
// how a peer that runs under a different authority than its starter goes unnoticed.
const permissionOutput = await toolSurface(
  {
    author: async () => ({
      front: { report: 'R-0045', status: 'open', subject: 'permissions', from: 'session-perm', to: [], cc: [], authors: [], created: at(44), updated: at(45), children: [], artifacts: [], hops: 1 },
      outcomes: [],
    }),
  },
  new PeerService(permissionHost as never, 100),
  undefined,
).get('peer_start')?.execute({ task: 'work under my own permissions' }, { agent: { id: SELF } }) ?? ''
check('the tool output names the inherited permission state',
  permissionOutput.includes('permissions inherited from this session: sandbox=danger-full-access, approval=never, preset=danger-full-access'),
  permissionOutput)

// report_release exists on a deployment without the worktree feature, so its
// refusals must name the deployment fact that explains them instead of leaving
// a bare "not bound" for the caller to chase. A refusal about ownership is not
// decorated, because the feature has nothing to do with it.
const releaseTools = toolSurface(
  {
    release: async () => {
      throw new Error('report-ledger: R-0001 is not bound to a working tree, so there is nothing to release')
    },
  },
  new PeerService(host as never, 100),
  undefined,
)
let releaseError = ''
try {
  await releaseTools.get('report_release')?.execute({ report: 'R-0001' }, { agent: { id: 'session-release' } })
} catch (error) {
  releaseError = error instanceof Error ? error.message : String(error)
}
check('a release refusal on a worktree-off deployment names the missing feature',
  releaseError.includes('not bound to a working tree') && releaseError.includes('has not enabled git worktree support'),
  releaseError)

const ownerRefusal = toolSurface(
  {
    release: async () => {
      throw new Error('report-ledger: session-x may not release R-0001 — releasing is the owner\'s act')
    },
  },
  new PeerService(host as never, 100),
  undefined,
)
let ownerError = ''
try {
  await ownerRefusal.get('report_release')?.execute({ report: 'R-0001' }, { agent: { id: 'session-release' } })
} catch (error) {
  ownerError = error instanceof Error ? error.message : String(error)
}
check('a release refusal about ownership is not decorated with the feature note',
  ownerError.includes('may not release') && !ownerError.includes('has not enabled git worktree support'), ownerError)

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)

await rm(root, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
