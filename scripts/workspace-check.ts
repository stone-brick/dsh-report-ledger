// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts and `filter` silently resolves to the DOM's window.filter.
// Emitted as nothing; it exists so `tsc` treats the file as its own module.
export {}
/**
 * Deterministic checks for the HOST wiring: the peer workspace registration, the
 * model route a peer is created with, and the plugin's `apply` seams.
 *
 * `roster-check.ts` pins the service side of the same feature — that a created
 * peer is offered to the hook, and that a failure is reported rather than thrown.
 * What is pinned here is the half that talks to the registry, and it is the half
 * where a mistake is invisible: registering the peer under a path the registry
 * does not recognize does not throw, it just means the (id → workspace)
 * accounting the sidebar reads stays empty and the peer sits in the ungrouped
 * bucket. That is precisely the bug this feature exists to fix, reproduced by a
 * string comparison in place of the registry's own canonical-path rule.
 *
 * So the assertions are behavioural rather than structural: the path the hook
 * *offers* the registry must be the one the registry itself would accept
 * (canonical real path, not the caller's spelling of it), the attach must carry
 * the peer's own id, and each degraded outcome must stay distinguishable from the
 * others.
 *
 * The same narrow-stub technique then covers two more host seams that otherwise
 * only a live deployment would exercise: the route a peer is created with (a
 * stub registry captures what `ctx.agents.create()` would receive), and `apply`
 * itself (a fake context runs every effect immediately, so registration,
 * disposal, the pump listener, the catch-up sweep and the corpus cache can be
 * asserted instead of trusted). No harness is involved anywhere.
 *
 * Run: node scripts/workspace-check.ts
 */

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostBundle, PeerHostContext } from '../src/index.ts'
import { pendingTargets } from '../src/report/deliver.ts'
import { appendHop, readHops, writeReport } from '../src/report/ledger.ts'
import { REPORT_PATH, TIMELINE_PATH, WORKTREES_PATH } from '../src/report/route.ts'

const scratch = await mkdtemp(join(tmpdir(), 'report-ledger-workspace-'))
// The peer roster log lives under the ledger root, so the run must not touch a
// real one even though nothing here starts a peer.
process.env.DSH_REPORT_LEDGER_ROOT = join(scratch, 'ledger')

const { apply, buildPeerHost } = await import('../src/index.ts')

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

/**
 * Poll for a condition instead of sleeping a fixed time.
 *
 * The host defers the catch-up sweep and the delivery path does real filesystem
 * I/O, so a fixed sleep would either be flaky on a busy machine or slow on a
 * quiet one. What the checks pin is that the effect happens, not how long the
 * filesystem needs on this machine.
 * @param predicate - the condition to reach.
 * @param timeoutMs - how long to keep trying.
 * @returns whether the condition held before the deadline.
 */
const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return await predicate()
}

/** Stand in for the session-reading bundle the peer host is built with. */
const host = (): HostBundle => ({
  getAgent: () => undefined,
  describe: async () => undefined,
  readTitles: async () => new Map<string, string>(),
  listSessionRecords: async () => [],
})

/** One workspace record as the registry hands it over. */
interface FakeWorkspace {
  readonly title: string
  attachSession(sessionId: never): Promise<void>
}

/** What the registry stub was asked, in call order. */
interface Asked {
  readonly canonical: string
}

/**
 * A context whose only interesting service is the workspace registry.
 * @param answer - `undefined` composes no registry, `'none'` a registry owning nothing, else the workspace to resolve to.
 * @param asked - receives the path each lookup was made with.
 * @param workspace - the workspace the registry answers with, when it answers.
 * @param warnings - receives logger warnings.
 * @returns the context stub.
 */
const contextWith = (
  answer: FakeWorkspace | 'none' | undefined,
  asked: Asked[],
  workspace: FakeWorkspace,
  warnings: string[] = [],
): PeerHostContext => {
  const ctx = {
    agents: {
      get: () => undefined,
      list: () => [],
      create: async () => { throw new Error('fixture: no peer is created by this check') },
    },
    get: (name: string) => {
      if (name !== 'workspaceRegistry' || answer === undefined) return undefined
      return {
        resolveByPath: async (canonical: string) => {
          asked.push({ canonical })
          return answer === 'none' ? undefined : workspace
        },
      }
    },
    logger: { warn: (message: string) => { warnings.push(message) } },
  }
  return ctx as unknown as PeerHostContext
}

// ---- 1. a peer in a registered directory is attached, canonically ----------
// The directory exists, and the caller's spelling of it deliberately does not
// match what the filesystem reports: mixed case on Windows, a trailing separator
// everywhere. A hook that passed the caller's string straight through would hand
// the registry a path it cannot validate, and the registration would be reported
// as a failure — or, worse, silently land nowhere — while the peer stayed
// ungrouped.
const project = join(scratch, 'Project')
await mkdir(project, { recursive: true })
const canonicalProject = await realpath(project)
const misspelled = `${canonicalProject.toUpperCase()}${process.platform === 'win32' ? '\\' : '/'}.`

const asked: Asked[] = []
const attached: string[] = []
const workspace: FakeWorkspace = {
  title: 'fixture-workspace',
  attachSession: async (sessionId: never) => { attached.push(String(sessionId)) },
}
const live = buildPeerHost(contextWith(workspace, asked, workspace), host())
const registered = await live.attachToWorkspace?.({ sessionId: 'session-peer-1', cwd: misspelled })
check('a registered directory reports the workspace it joined',
  registered?.outcome === 'registered' && registered.workspace === 'fixture-workspace',
  JSON.stringify(registered))
check('the registry is asked about the canonical path, not the caller\'s spelling',
  asked[0]?.canonical === canonicalProject,
  `${String(asked[0]?.canonical)} vs ${canonicalProject}`)
check('the peer session is attached by its own id',
  attached.join() === 'session-peer-1', attached.join())

// ---- 2. an unmatched directory is a legitimate absence, not a failure -------
const unmatchedAsked: Asked[] = []
const unknown = buildPeerHost(contextWith('none', unmatchedAsked, workspace), host())
const unowned = await unknown.attachToWorkspace?.({ sessionId: 'session-peer-2', cwd: project })
check('a directory no workspace owns is reported as no-workspace', unowned?.outcome === 'no-workspace', JSON.stringify(unowned))
check('an unmatched registration reports no workspace name', unowned?.workspace === undefined, String(unowned?.workspace))

// ---- 3. a deployment without the registry has nothing to report -------------
const composed = buildPeerHost(contextWith(undefined, [], workspace), host())
check('the hook exists even where no registry is composed', typeof composed.attachToWorkspace === 'function')
const none = await composed.attachToWorkspace?.({ sessionId: 'session-peer-3', cwd: project })
check('no registry yields no-workspace rather than a failure',
  none?.outcome === 'no-workspace' && none.warning === undefined, JSON.stringify(none))
const noCwd = await composed.attachToWorkspace?.({ sessionId: 'session-peer-4' })
check('a peer with no directory is not offered to the registry at all', noCwd?.outcome === 'no-workspace', JSON.stringify(noCwd))

// ---- 4. a registry that refuses the attach is reported, never thrown --------
// The service layer catches as well, so this is the inner boundary: a warning
// must reach the deployment log here too, because the tool result is read once by
// one agent while a silently ungrouped peer is a fact about the installation.
const warnings: string[] = []
const refusing: FakeWorkspace = {
  title: 'fixture-workspace',
  attachSession: async () => { throw new Error('fixture: registry refused the attach') },
}
const broken = buildPeerHost(contextWith(refusing, [], refusing, warnings), host())
let threw = false
let failed: { outcome?: string; warning?: string } | undefined
try {
  failed = await broken.attachToWorkspace?.({ sessionId: 'session-peer-5', cwd: project })
} catch {
  threw = true
}
check('a refused attach does not throw out of the hook', !threw)
check('a refused attach is reported as failed', failed?.outcome === 'failed', JSON.stringify(failed))
check('the failure carries the registry\'s own reason',
  failed?.warning?.includes('registry refused the attach') === true, String(failed?.warning))
check('the failure is also written to the deployment log',
  warnings.some((line) => line.includes('session-peer-5') && line.includes('registry refused')), warnings.join(' | '))

// ---- 5. a directory that cannot be canonicalized is a failure, not a crash --
const vanished = await live.attachToWorkspace?.({ sessionId: 'session-peer-6', cwd: join(scratch, 'never-created') })
check('a vanished directory is reported as failed rather than thrown',
  vanished?.outcome === 'failed', JSON.stringify(vanished))

// ---------------------------------------------------------------------------
// 6. peer creation route: effort follows the live header, not a stale option
// ---------------------------------------------------------------------------
// `peerRoute` is private, but `createPeer` is the seam that publishes its answer
// to `ctx.agents.create()`. A stub registry captures exactly what the harness
// would have received, so the rule can be pinned without widening the export
// surface. The rule matters because a peer created on a route it cannot use
// fails its first request while the ledger still reports a delivered hand-off.
interface CreationCall {
  readonly agentOptions: Record<string, unknown>
  /** What the stub harness handed `setup()`, in append order. */
  readonly appended: readonly AppendedEvent[]
}

/** One event the peer's unpublished log received during its creation window. */
interface AppendedEvent {
  readonly type: string
  readonly data: Record<string, unknown>
}

/**
 * The optional permission services a peer creation reads.
 *
 * Each is independently optional because each is separately composed in the real
 * deployment, and the capture has to keep working when one of them is missing.
 */
interface PermissionServices {
  readonly permissionPresets?: { current(session: unknown): string | undefined }
  readonly sandboxPolicy?: { resolve(request: { session: unknown }): { mode?: unknown } | undefined }
  readonly approval?: { effectivePolicy(session: unknown): unknown }
}

const captureCreation = (
  caller: { options: Record<string, unknown>; session: { requestHeader(): { config?: Record<string, unknown> } | undefined } },
  services: PermissionServices = {},
  warnings: string[] = [],
  beforeSetup?: () => void,
): { peerHost: ReturnType<typeof buildPeerHost>; calls: CreationCall[] } => {
  const calls: CreationCall[] = []
  const creationCtx = {
    agents: {
      get: () => caller,
      list: () => [],
      create: async (options: {
        agentOptions: Record<string, unknown>
        setup(agentCtx: unknown, created?: { session: { append(type: string, data: Record<string, unknown>): void } }): void
      }) => {
        const appended: AppendedEvent[] = []
        // The harness runs setup with the session still unpublished and hands over
        // the agent precisely so the log can be seeded — the seam the peer's
        // permission inheritance depends on, so the stub exposes it the same way.
        beforeSetup?.()
        options.setup(undefined, {
          session: { append: (type: string, data: Record<string, unknown>) => { appended.push({ type, data }) } },
        })
        calls.push({ agentOptions: options.agentOptions, appended })
        return { agent: { id: 'session-peer-created' } }
      },
    },
    get: (name: string) => (services as Record<string, unknown>)[name],
    logger: { warn: (message: string) => { warnings.push(message) } },
  }
  return { peerHost: buildPeerHost(creationCtx as unknown as PeerHostContext, host()), calls }
}

/** Resolve one creation options bundle from a starter carrying this header/options pair. */
const resolveRoute = async (
  options: Record<string, unknown>,
  header: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | undefined> => {
  const caller = { options, session: { requestHeader: () => (header === undefined ? undefined : { config: header }) } }
  const { peerHost, calls } = captureCreation(caller)
  await peerHost.createPeer({ sessionId: 'session-peer-created', startedBy: 'session-starter' })
  return calls[0]?.agentOptions
}

const staleEffort = await resolveRoute(
  { provider: 'p', model: 'm', reasoningEffort: 'high', maxTokens: 4096 },
  { provider: 'p', model: 'm' },
)
check('a live header without an effort does not inherit the stale creation-time effort',
  staleEffort?.reasoningEffort === undefined, JSON.stringify(staleEffort))
check('the creation-time maxTokens survives alongside the header route',
  staleEffort?.maxTokens === 4096, JSON.stringify(staleEffort))
check('the header names provider and model', staleEffort?.provider === 'p' && staleEffort?.model === 'm', JSON.stringify(staleEffort))

const headerEffort = await resolveRoute(
  { provider: 'p', model: 'm', reasoningEffort: 'high' },
  { provider: 'p2', model: 'm2', reasoningEffort: 'medium' },
)
check('a live header owns the effort it does name',
  headerEffort?.reasoningEffort === 'medium' && headerEffort?.provider === 'p2' && headerEffort?.model === 'm2',
  JSON.stringify(headerEffort))

const noHeader = await resolveRoute({ provider: 'p', model: 'm', reasoningEffort: 'low' }, undefined)
check('a starter with no request header inherits its creation-time effort',
  noHeader?.reasoningEffort === 'low', JSON.stringify(noHeader))
check('provider and model still fall back to creation options',
  noHeader?.provider === 'p' && noHeader?.model === 'm', JSON.stringify(noHeader))

// ---------------------------------------------------------------------------
// 6b. peer creation inherits the starter's permission state
// ---------------------------------------------------------------------------
// This is the failure a deployment reports as "the peer still asks me to approve
// what this session was already allowed to do": the peer is pinned to the
// deployment's default preset instead of the state of the session that opened it.
// Nothing about a peer's own fields shows it, so the seam is pinned here.
const starterCaller = {
  options: { provider: 'p', model: 'm' },
  session: { requestHeader: () => undefined },
}

const fullAccess = {
  permissionPresets: { current: () => 'danger-full-access' },
  sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
  approval: { effectivePolicy: () => 'never' },
}
const inheritedWarnings: string[] = []
const inheritedPeer = captureCreation(starterCaller, fullAccess, inheritedWarnings)
await inheritedPeer.peerHost.createPeer({ sessionId: 'session-peer-created', startedBy: 'session-starter' })
const inheritedEvents = [...(inheritedPeer.calls[0]?.appended ?? [])]
check('the peer inherits its starter\'s sandbox mode and approval policy',
  inheritedEvents[0]?.type === 'sandbox/mode' && inheritedEvents[0]?.data.mode === 'danger-full-access'
  && inheritedEvents[1]?.type === 'approval/policy' && inheritedEvents[1]?.data.policy === 'never',
  JSON.stringify(inheritedEvents))
check('inherited knobs are marked as delegation, not as the peer\'s own choice',
  inheritedEvents[0]?.data.source === 'delegation' && inheritedEvents[1]?.data.source === 'delegation',
  JSON.stringify(inheritedEvents.map((event) => event.data.source)))
check('the peer also inherits the preset identity, written last',
  inheritedEvents[2]?.type === 'permission/preset' && inheritedEvents[2]?.data.preset === 'danger-full-access',
  JSON.stringify(inheritedEvents))
check('a working inheritance path raises no warning',
  inheritedWarnings.length === 0, inheritedWarnings.join(' | '))

const bare = captureCreation(starterCaller)
await bare.peerHost.createPeer({ sessionId: 'session-peer-bare', startedBy: 'session-starter' })
check('a starter with no permission services yields no inherited events',
  bare.calls[0]?.appended.length === 0, JSON.stringify(bare.calls[0]?.appended))

// `custom` is the derived "matches no preset" state and is not a valid identity to
// copy; the knobs still travel, so the peer lands in the same custom state honestly.
const customPeer = captureCreation(starterCaller, {
  permissionPresets: { current: () => 'custom' },
  sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
  approval: { effectivePolicy: () => 'ask' },
})
await customPeer.peerHost.createPeer({ sessionId: 'session-peer-custom', startedBy: 'session-starter' })
const customEvents = [...(customPeer.calls[0]?.appended ?? [])]
check('a custom preset is not copied as an identity',
  customEvents.every((event) => event.type !== 'permission/preset'), JSON.stringify(customEvents))
check('a custom preset still carries its two knobs',
  customEvents[0]?.data.mode === 'read-only' && customEvents[1]?.data.policy === 'ask', JSON.stringify(customEvents))

// The capture is synchronous and happens before the first await: a switch the
// starter makes while the peer is being created belongs to the starter's future.
// Without this rule the peer would silently pick up a mode the user changed after
// asking for it, and the log would attribute it to a delegation that never happened.
const moving = { mode: 'workspace-write' }
const racingPeer = captureCreation(
  starterCaller,
  {
    permissionPresets: { current: () => 'workspace-write' },
    sandboxPolicy: { resolve: () => ({ mode: moving.mode }) },
    approval: { effectivePolicy: () => 'ask' },
  },
  [],
  () => { moving.mode = 'danger-full-access' },
)
await racingPeer.peerHost.createPeer({ sessionId: 'session-peer-racing', startedBy: 'session-starter' })
check('a starter switching preset mid-creation does not leak into the peer',
  racingPeer.calls[0]?.appended[0]?.data.mode === 'workspace-write',
  JSON.stringify(racingPeer.calls[0]?.appended))

// A harness that does not hand the unpublished session to setup() degrades to the
// peer's own creation-time preset — and says so, because the silent version of
// this is exactly the bug this section pins.
const appendlessWarnings: string[] = []
const appendless = {
  agents: {
    get: () => starterCaller,
    list: () => [],
    create: async (options: { setup(): void }) => {
      options.setup()
      return { agent: { id: 'session-peer-created' } }
    },
  },
  get: (name: string) => (fullAccess as Record<string, unknown>)[name],
  logger: { warn: (message: string) => { appendlessWarnings.push(message) } },
}
const appendlessHost = buildPeerHost(appendless as unknown as PeerHostContext, host())
await appendlessHost.createPeer({ sessionId: 'session-peer-appendless', startedBy: 'session-starter' })
check('a creation window without the unpublished session is reported, not silent',
  appendlessWarnings.some((line) => line.includes('session-peer-appendless') && line.includes('inherit')),
  appendlessWarnings.join(' | '))

// ---------------------------------------------------------------------------
// 7. apply(): route registration is failure-atomic
// ---------------------------------------------------------------------------
// The host wiring itself is what a deployment depends on and what nothing else
// pins: three endpoints under a service-injection callback, the pump listener,
// the prompt sections, and the catch-up sweep. The fake context below executes
// every effect immediately (Cordis tracks it in the real host) so the assertions
// can be about the wiring rather than about Cordis.
type RouteHandler = (request: never, response: never) => Promise<void> | void

interface WiringOptions {
  readonly liveAgents?: readonly { id: string; session?: unknown; steer(message: unknown): void; inject(message: unknown): void }[]
  readonly listSessions?: () => Promise<readonly unknown[]>
  readonly readTitleSnapshots?: (ids: readonly string[], signal?: AbortSignal) => Promise<readonly unknown[]>
  /**
   * The persisted projection cache, in the two faces this plugin reads.
   *
   * A fixture rather than the real service because what is being pinned is the
   * ROUTE a title takes, not the cache: the assertion is that the timeline asks
   * this face at all, which is the difference between an in-memory answer and
   * decoding every session log on every poll.
   */
  readonly projectionCache?: {
    snapshot?: (header: unknown, keys?: readonly string[]) => { readonly values?: Record<string, unknown> } | undefined
    predecessor?: (header: unknown) => { readonly values?: Record<string, unknown> } | undefined
  }
  /** The live title service, so the resident-session route can be isolated too. */
  readonly titleService?: { get(session: unknown): { readonly title?: unknown } | undefined }
  readonly failRoute?: string
}

const wiring = (options: WiringOptions = {}) => {
  const tools: string[] = []
  const sections: string[] = []
  const listeners = new Map<string, (payload: { agent: { id: unknown } }) => unknown>()
  const routes = new Map<string, RouteHandler>()
  const registered: string[] = []
  const disposed: string[] = []
  const warnings: string[] = []
  const effects: (() => void)[] = []
  const injections: ((scoped: unknown) => void)[] = []
  const webServer = {
    register(route: { kind: string; path: string; handler: RouteHandler }): () => void {
      if (route.path === options.failRoute) throw new Error(`fixture: duplicate route ${route.path}`)
      registered.push(route.path)
      routes.set(route.path, route.handler)
      return () => {
        disposed.push(route.path)
        routes.delete(route.path)
      }
    },
  }
  const sessionQuery = {
    listSessions: options.listSessions ?? (async () => []),
    readTitleSnapshots: options.readTitleSnapshots ?? (async () => []),
  }
  const projectionCache = options.projectionCache === undefined
    ? undefined
    : {
        cachedSnapshot: options.projectionCache.snapshot,
        cachedPredecessorTitle: options.projectionCache.predecessor,
      }
  const titleService = options.titleService
  const effect = (fn: () => (() => void)): (() => void) => {
    const undo = fn()
    effects.push(undo)
    return undo
  }
  const scoped = {
    get: (name: string) => (name === 'webServer' ? webServer : undefined),
    effect,
  }
  const liveAgents = options.liveAgents ?? []
  const ctx = {
    agents: {
      get: (id: string) => liveAgents.find((agent) => agent.id === id),
      list: () => liveAgents,
      create: async () => { throw new Error('fixture: no agent is created here') },
    },
    get: (name: string) => {
      if (name === 'sessionQuery') return sessionQuery
      if (name === 'sessionProjectionCache') return projectionCache
      if (name === 'sessionTitle') return titleService
      return undefined
    },
    logger: { warn: (message: string) => { warnings.push(message) } },
    tools: { register: (definition: { name: string }) => { tools.push(definition.name); return () => {} } },
    systemPrompt: { section: (section: { name: string }) => { sections.push(section.name); return () => {} } },
    on: (name: string, listener: (payload: { agent: { id: unknown } }) => unknown) => {
      listeners.set(name, listener)
      return () => {}
    },
    effect,
    inject: (_deps: string[], callback: (scoped: unknown) => void) => { injections.push(callback); return {} },
  }
  return {
    ctx, tools, sections, listeners, routes, registered, disposed, warnings, effects,
    mount: (): void => { for (const injection of injections) injection(scoped) },
  }
}

const wired = wiring()
apply(wired.ctx as never, {})
wired.mount()
check('apply registers the three read-only endpoints',
  wired.registered.join() === [REPORT_PATH, TIMELINE_PATH, WORKTREES_PATH].join(), wired.registered.join())
check('each registered endpoint carries its handler', wired.routes.size === 3, String(wired.routes.size))
check('the model tools include the peer surface',
  wired.tools.includes('report_author') && wired.tools.includes('peer_list') && wired.tools.includes('peer_start')
    && wired.tools.includes('peer_wake'),
  wired.tools.join(','))
check('the lease tool stays hidden while the worktree feature is off',
  !wired.tools.includes('report_lease'), wired.tools.join(','))
check('both prompt sections are registered by default',
  wired.sections.join() === 'plugin:report-ledger,plugin:report-ledger:partnership', wired.sections.join())
wired.effects[wired.effects.length - 1]?.()
check('disposing the registration effect removes every route in reverse',
  wired.disposed.join() === [WORKTREES_PATH, TIMELINE_PATH, REPORT_PATH].join() && wired.routes.size === 0,
  wired.disposed.join())

const failing = wiring({ failRoute: TIMELINE_PATH })
apply(failing.ctx as never, {})
let mountThrew = false
try {
  failing.mount()
} catch {
  mountThrew = true
}
check('a refused second registration fails the fiber instead of half-registering', mountThrew)
check('the route that did register is unwound when the next one fails',
  failing.registered.join() === REPORT_PATH && failing.disposed.join() === REPORT_PATH && failing.routes.size === 0,
  `${failing.registered.join()} | ${failing.disposed.join()}`)

const quiet = wiring()
apply(quiet.ctx as never, { announceToAgent: false })
quiet.mount()
check('announceToAgent:false suppresses the prompt sections', quiet.sections.length === 0, quiet.sections.join())
check('announceToAgent:false still registers the endpoints and the tools',
  quiet.routes.size === 3 && quiet.tools.includes('report_read'), `${quiet.routes.size} ${quiet.tools.join(',')}`)

// ---------------------------------------------------------------------------
// 8. the catch-up sweep delivers what `agent/created` can never report
// ---------------------------------------------------------------------------
// The event fires while a session is created or resumed. A hand-off queued before
// the plugin loaded has no such event left to wait for, so one deferred sweep in
// `apply` must deliver it — otherwise the one failure this ledger exists to
// prevent (a silent hand-off to a resident agent) survives a plugin reload.
const queuedFront = {
  report: 'R-0001',
  subject: 'queued before the plugin mounted',
  status: 'open' as const,
  from: 'session-sender',
  to: ['session-live-1'],
  cc: [],
  authors: [],
  created: Date.now(),
  updated: Date.now(),
  children: [],
  artifacts: [],
  hops: 1,
  reads: 0,
}
await writeReport({ front: queuedFront, body: 'the queued body' })
await appendHop('R-0001', { at: Date.now(), actor: 'session-sender', action: 'sent', to: ['session-live-1'] })

const catchUpInbox: string[] = []
const resident = {
  id: 'session-live-1',
  steer: (message: unknown) => {
    const digest = message as { content?: readonly { text?: string }[] }
    catchUpInbox.push(digest.content?.[0]?.text ?? '')
  },
  inject: () => {},
}
const catchUp = wiring({ liveAgents: [resident] })
apply(catchUp.ctx as never, {})
// The sweep is deferred by design (plugin load must not wait on ledger I/O), so
// the assertion polls instead of sleeping a fixed time: what is pinned is that it
// happens, not how many milliseconds the filesystem needs on this machine.
const deliveredBySweep = await waitFor(async () => (await readHops('R-0001')).some((hop) => hop.action === 'delivered'))
check('apply sweeps the sessions that were already resident',
  deliveredBySweep && catchUpInbox.length === 1 && catchUpInbox[0].includes('R-0001'),
  `${catchUpInbox.length} delivered=${deliveredBySweep}`)
const hopsAfterSweep = await readHops('R-0001')
check('the sweep records the arrival instead of leaving the hand-off pending',
  hopsAfterSweep.some((hop) => hop.action === 'delivered') && !pendingTargets(hopsAfterSweep).includes('session-live-1'),
  pendingTargets(hopsAfterSweep).join())

// ---------------------------------------------------------------------------
// 9. the corpus listing is shared by concurrent readers and dropped on creation
// ---------------------------------------------------------------------------
// Every timeline request used to re-enumerate the whole session corpus, and the
// tab polls it. One in-flight listing serves every concurrent reader, a short
// window serves the next poll, and a newly resident session invalidates the cache
// so it can never be missing from its own timeline.
const listing = { calls: 0 }
const shared = wiring({
  listSessions: async () => {
    listing.calls += 1
    await new Promise((resolve) => setTimeout(resolve, 25))
    return [{ header: { id: 'session-root', createdAt: Date.now() }, live: true }]
  },
})
apply(shared.ctx as never, {})
shared.mount()
const timelineRoute = shared.routes.get(TIMELINE_PATH)
if (timelineRoute === undefined) throw new Error('fixture: the timeline route was not registered')

const browserRequest = (root = 'session-root'): never => ({
  socket: { remoteAddress: '127.0.0.1' },
  headers: { host: '127.0.0.1:3080' },
  method: 'GET',
  url: `/api/report-ledger/timeline?root=${root}`,
} as never)
const browserResponse = (): { captured: { status: number; headers: Record<string, unknown>; body: string }; response: never } => {
  const captured = { status: 0, headers: {} as Record<string, unknown>, body: '' }
  return {
    captured,
    response: {
      writeHead(status: number, headers?: Record<string, unknown>) {
        captured.status = status
        Object.assign(captured.headers, headers ?? {})
      },
      end(chunk?: unknown) { if (typeof chunk === 'string') captured.body = chunk },
    } as never,
  }
}

const firstRead = browserResponse()
const secondRead = browserResponse()
await Promise.all([
  timelineRoute(browserRequest(), firstRead.response),
  timelineRoute(browserRequest(), secondRead.response),
])
check('two concurrent timeline reads both answer 200',
  firstRead.captured.status === 200 && secondRead.captured.status === 200,
  `${firstRead.captured.status}/${secondRead.captured.status}`)
check('two concurrent timeline reads share one corpus listing', listing.calls === 1, String(listing.calls))
check('the shared listing is what the payload was built from',
  firstRead.captured.body.includes('session-root') && secondRead.captured.body.includes('session-root'))

const thirdRead = browserResponse()
await timelineRoute(browserRequest(), thirdRead.response)
check('a follow-up poll inside the reuse window costs no second listing', listing.calls === 1, String(listing.calls))

const pump = shared.listeners.get('agent/created')
check('apply registers the agent/created pump', typeof pump === 'function')
const pumpResult = pump?.({ agent: { id: 'session-live-9' } })
check('the pump listener answers synchronously with undefined', pumpResult === undefined, String(pumpResult))

const fourthRead = browserResponse()
await timelineRoute(browserRequest(), fourthRead.response)
check('a newly resident session drops the cached corpus listing', listing.calls === 2, String(listing.calls))

// ---------------------------------------------------------------------------
// 10. titles: the cheap rung answers, and the expensive rung is bounded
// ---------------------------------------------------------------------------
// This is the half of a timeline read that made the tab unloadable. Folding a
// title for a session this process is not holding costs the harness a decode of
// that session's COMPLETE stored log — measured on a real 195-session corpus at
// 389 ms to 1.3 s per session and 5.1 s for one thirteen-session tree offline,
// 18.3 s through the live endpoint — and the old read path did it for every
// session of every poll. Each check below pins one rung of the ladder that
// replaced it: a resident session answers from the live title service, a stored
// session answers from the projection cache, a session neither can serve is
// remembered, and what is left is capped and time-bounded.
const coldTree = (count: number): readonly unknown[] => Array.from({ length: count }, (_, index) => ({
  header: {
    id: index === 0 ? 'session-cold-root' : `session-cold-${index}`,
    ...(index === 0 ? {} : { parentSession: 'session-cold-root' }),
    createdAt: index,
    cwd: 'D:\\Projects\\example',
    isSeeded: false,
    version: 5,
  },
  live: false,
}))
const titlesOfColdTree = (ids: readonly string[]): readonly unknown[] =>
  ids.map((sessionId) => ({ status: 'fulfilled', sessionId, value: { title: { title: `title of ${sessionId}` } } }))

// (a) a projected session costs no log decode
const projectedCalls = { calls: 0, ids: 0 }
const projected = wiring({
  listSessions: async () => coldTree(3),
  readTitleSnapshots: async (ids) => {
    projectedCalls.calls += 1
    projectedCalls.ids += ids.length
    return titlesOfColdTree(ids)
  },
  projectionCache: {
    snapshot: (header) => ({ values: { title: `projected ${(header as { id?: string }).id ?? ''}` } }),
  },
})
apply(projected.ctx as never, {})
projected.mount()
const projectedRoute = projected.routes.get(TIMELINE_PATH)
if (projectedRoute === undefined) throw new Error('fixture: the timeline route was not registered')
const projectedRead = browserResponse()
await projectedRoute(browserRequest('session-cold-root'), projectedRead.response)
check('the projection cache answers a stored session without decoding its log',
  projectedCalls.calls === 0, `${projectedCalls.calls} calls, ${projectedCalls.ids} ids`)
check('the projected titles are in the payload the tab renders',
  projectedRead.captured.body.includes('projected session-cold-root')
  && projectedRead.captured.body.includes('projected session-cold-1'),
  projectedRead.captured.body.slice(0, 200))

// (b) a resident session costs no log decode either
const liveTitleCalls = { ids: [] as string[] }
const liveTitled = wiring({
  listSessions: async () => coldTree(2),
  readTitleSnapshots: async (ids) => { liveTitleCalls.ids.push(...ids); return titlesOfColdTree(ids) },
  liveAgents: [{
    id: 'session-cold-root',
    session: { header: { id: 'session-cold-root' } },
    steer: () => {},
    inject: () => {},
  }],
  titleService: { get: () => ({ title: 'the live title' }) },
})
apply(liveTitled.ctx as never, {})
liveTitled.mount()
const liveRoute = liveTitled.routes.get(TIMELINE_PATH)
if (liveRoute === undefined) throw new Error('fixture: the timeline route was not registered')
const liveRead = browserResponse()
await liveRoute(browserRequest('session-cold-root'), liveRead.response)
check('a resident session takes its title from the live title service, not the query',
  !liveTitleCalls.ids.includes('session-cold-root') && liveRead.captured.body.includes('the live title'),
  liveTitleCalls.ids.join(','))
check('the non-resident child of that tree still resolves its title through the query',
  liveRead.captured.body.includes('title of session-cold-1'), liveRead.captured.body.slice(0, 200))

// (c) what neither cheap face can serve is remembered, found or not
const unserved = { calls: 0, ids: [] as string[] }
const unservedFixture = wiring({
  listSessions: async () => coldTree(3),
  readTitleSnapshots: async (ids) => {
    unserved.calls += 1
    unserved.ids.push(...ids)
    return titlesOfColdTree(ids)
  },
})
apply(unservedFixture.ctx as never, {})
unservedFixture.mount()
const unservedRoute = unservedFixture.routes.get(TIMELINE_PATH)
if (unservedRoute === undefined) throw new Error('fixture: the timeline route was not registered')
await unservedRoute(browserRequest('session-cold-root'), browserResponse().response)
const afterFirst = { calls: unserved.calls, ids: unserved.ids.length }
await unservedRoute(browserRequest('session-cold-root'), browserResponse().response)
check('the expensive title path runs once, not once per poll',
  afterFirst.calls === 1 && unserved.calls === afterFirst.calls,
  `${afterFirst.calls} then ${unserved.calls}`)

// (d) it is capped per request instead of handed the whole tree
const capped = { batchSizes: [] as number[], ids: [] as string[] }
const cappedFixture = wiring({
  listSessions: async () => coldTree(21),
  readTitleSnapshots: async (ids) => {
    capped.batchSizes.push(ids.length)
    capped.ids.push(...ids)
    return titlesOfColdTree(ids)
  },
})
apply(cappedFixture.ctx as never, {})
cappedFixture.mount()
const cappedRoute = cappedFixture.routes.get(TIMELINE_PATH)
if (cappedRoute === undefined) throw new Error('fixture: the timeline route was not registered')
await cappedRoute(browserRequest('session-cold-root'), browserResponse().response)
await cappedRoute(browserRequest('session-cold-root'), browserResponse().response)
const firstBatch = capped.ids.slice(0, 8)
const secondBatch = capped.ids.slice(8, 16)
check('one request sends at most eight sessions down the expensive title path',
  capped.batchSizes[0] === 8, JSON.stringify(capped.batchSizes))
check('the next request advances instead of retrying the same sessions',
  secondBatch.length > 0 && secondBatch.every((id) => !firstBatch.includes(id)),
  `${firstBatch.join(',')} -> ${secondBatch.join(',')}`)

// (e) a failing title service costs the titles, never the view
const brokenTitles = wiring({
  listSessions: async () => coldTree(2),
  readTitleSnapshots: async () => { throw new Error('fixture: the title store is unreadable') },
})
apply(brokenTitles.ctx as never, {})
brokenTitles.mount()
const brokenRoute = brokenTitles.routes.get(TIMELINE_PATH)
if (brokenRoute === undefined) throw new Error('fixture: the timeline route was not registered')
const brokenRead = browserResponse()
await brokenRoute(browserRequest('session-cold-root'), brokenRead.response)
check('an unreadable title store still answers the timeline',
  brokenRead.captured.status === 200 && brokenRead.captured.body.includes('session-cold-1'),
  `${brokenRead.captured.status} ${brokenRead.captured.body.slice(0, 120)}`)

// (f) the reuse window sits on the right side of the poll cadence
// The bug this pins is subtle and was live for a while: a reuse window SHORTER
// than the browser's poll interval can never hit, so every poll paid a full
// corpus walk — a cache that is always cold is worse than no cache, because it
// looks like one. The clock is shifted rather than waited on, so the assertion is
// about the window's arithmetic, not about this machine's filesystem.
const windowed = { calls: 0 }
const windowedFixture = wiring({
  listSessions: async () => { windowed.calls += 1; return coldTree(1) },
})
apply(windowedFixture.ctx as never, {})
windowedFixture.mount()
const windowedRoute = windowedFixture.routes.get(TIMELINE_PATH)
if (windowedRoute === undefined) throw new Error('fixture: the timeline route was not registered')
await windowedRoute(browserRequest('session-cold-root'), browserResponse().response)
const realNow = Date.now
try {
  const base = realNow()
  Date.now = () => base + 11_000
  await windowedRoute(browserRequest('session-cold-root'), browserResponse().response)
  const afterOneCadence = windowed.calls
  Date.now = () => base + 16_000
  await windowedRoute(browserRequest('session-cold-root'), browserResponse().response)
  check('a poll one browser cadence later still reuses the corpus listing',
    afterOneCadence === 1, `${afterOneCadence} listings`)
  check('a listing past the reuse window is walked again instead of served forever',
    windowed.calls === 2, `${windowed.calls} listings`)
} finally {
  Date.now = realNow
}

let failures = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failures}/${checks.length} checks passed`)

await rm(scratch, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
