/**
 * Host half of dsh-report-ledger — runs in the DSH host process.
 *
 * Loaded from the profile composition through the `report-ledger` row in
 * cordis.patch.yml. It wires four things into the running harness:
 *
 *  1. the report service, which owns the durable ledger under
 *     `$DSH_HOME/report-ledger`;
 *  2. the eight model-facing report tools;
 *  3. the delivery pump — when a session becomes resident again, every hand-off
 *     the ledger is still holding for it is delivered. That is the durable
 *     mailbox the delegation seam documents as missing;
 *  4. two read-only HTTP endpoints the browser tab reads, registered on the
 *     harness web server when one is mounted (the headless profile has none, and
 *     the plugin stays fully functional without them).
 *
 * It also registers each peer it starts with the workspace registry, when the
 * deployment composes one. That is bookkeeping rather than a fifth feature, and
 * it is described where it lives: {@link PeerHost.attachToWorkspace}.
 *
 * Every adapter from an untyped harness service into this plugin's own shapes
 * lives here, so the rest of the plugin never touches a live harness object.
 *
 * @module dsh-report-ledger
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only imports: they pull each host service's Context augmentation into
// scope so `ctx.tools` / `ctx.systemPrompt` / `ctx.agents` are typed. They are
// erased at build time and never become a runtime dependency.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session'
// The one host value this plugin imports instead of reaching through a service,
// and the exception is narrow enough to state: a pure path canonicalizer with no
// registry, no lifecycle and no state to duplicate. The value is what makes the
// workspace lookup correct — the registry validates a session's directory by
// canonical real path, so matching one by string equality against the workspace
// list would silently attribute a peer to the wrong group (or refuse a
// registration the registry would accept) wherever a path differs by case,
// separators, a symlink or an 8.3 short name.
import { realpathNormalize } from '@deepseek-ai/dsh-workspace'
import type { AgentLike } from './report/deliver.ts'
import { pendingTargets } from './report/deliver.ts'
import { PARTNERSHIP_SECTION_ORDER, PROTOCOL, SECTION_ORDER, partnershipText } from './report/guidance.ts'
import { listReports, readHops, readReport, reportPath } from './report/ledger.ts'
import { resolveWorktree, type WorktreeConfig, type WorktreeRuntime } from './report/allocate.ts'
import { buildWorktreeReport } from './report/maintenance.ts'
import { DEFAULT_MAX_PEERS, PeerService, type PeerHost, type PeerReceipt, type WorkspaceRegistration } from './report/peer.ts'
import { REPORT_PATH, TIMELINE_PATH, WORKTREES_PATH, createReportHandler, createTimelineHandler, createWorktreesHandler, type ReportDetail } from './report/route.ts'
import { ReportService, type ReportServiceHost } from './report/service.ts'
import { buildTimeline, type SessionRecordLike } from './report/timeline.ts'
import { registerReportTools } from './report/tools.ts'

/** Plugin config, supplied by the composition row. */
export interface Config {
  /**
   * When true (default), the prompt sections announce the ledger to every agent.
   * Set false to keep prompts untouched.
   */
  announceToAgent?: boolean
  /**
   * Cap on independent peer sessions one session may start. Peer creation is the
   * one capability here that adds live agents rather than records, so it is
   * budgeted; reaching the cap is a tool error naming the limit, not a silent
   * refusal.
   * @default 8
   */
  maxPeersPerAgent?: number
  /**
   * Optional git worktree support: each report may hold its own checkout.
   *
   * Off unless `enabled` is set. What a working tree isolates is narrow and
   * worth stating plainly, because the opposite is easy to assume: each checkout
   * has its own working directory and index, while `config`, `hooks`, the object
   * store and everything outside the checkouts on the machine stay shared. A
   * hook installed or a setting changed in one checkout therefore affects every
   * other one.
   */
  worktree?: WorktreeConfig
}

/** The three host services this half cannot work without. */
export const inject = ['tools', 'systemPrompt', 'agents']

/** Structural face of the optional session-query service. */
interface SessionQueryLike {
  listSessions?(): Promise<readonly unknown[]>
  readTitleSnapshots?(ids: readonly string[]): Promise<readonly unknown[]>
}

/** Structural face of the optional web-server service. */
interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (request: never, response: never) => void | Promise<void>
  }): () => void
}

/**
 * Structural face of the agent-preset roster.
 *
 * Optional on purpose: a deployment may compose no roster at all, and there the
 * model-facing rows sit in the host composition and every agent already sees them
 * through the global layer. When a roster IS composed, an agent that joins no
 * composition sees the empty global layer instead — no preset tools, none of the
 * preset prompt sections — which is why a peer must join one.
 */
interface AgentPresetsLike {
  /**
   * The preset a live agent runs on.
   * @param agentCtx - the agent's scope context.
   * @returns the preset id, or `undefined` when it joined none.
   */
  composedPreset(agentCtx: Context): string | undefined
  /**
   * Join one agent to the same standing composition another already runs on.
   * @param agentCtx - the joining agent's scope context.
   * @param parentCtx - the context of the agent whose composition to join.
   * @returns the preset id joined, or `undefined` when the parent joined none.
   */
  composeFrom(agentCtx: Context, parentCtx: Context): string | undefined
}

/** Structural face of the optional deployment default model service. */
interface AgentDefaultModelLike {
  /**
   * The selection a fresh agent starts on when nothing else names one.
   * @returns the provider, model, and optional reasoning effort.
   */
  currentSelection(): { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
}

/** Structural face of one workspace record. */
interface WorkspaceLike {
  /** Its display title, used when reporting which group the peer joined. */
  readonly title: string
  /**
   * Account one session under this workspace.
   * @param sessionId - the session to account.
   */
  attachSession(sessionId: SessionId): Promise<void>
}

/**
 * Structural face of the optional workspace registry.
 *
 * Optional on purpose, and the reason is visible in the deployment matrix: the
 * headless profile composes no workspace registry because there is no sidebar to
 * group anything in, and a plugin that demanded the service would refuse to load
 * there. Absent means "this deployment has no groups", which
 * {@link buildPeerHost}'s registration hook reports as nothing to attach rather
 * than as a failure.
 */
interface WorkspaceRegistryLike {
  /**
   * Resolve the workspace owning one directory, without creating anything.
   * @param path - an existing directory path.
   * @returns the workspace, or `undefined` when no registration owns it.
   */
  resolveByPath(path: string): Promise<WorkspaceLike | undefined>
}

/**
 * The host capabilities the peer bundle reaches for, named one by one.
 *
 * Narrower than {@link Context} on purpose, and the narrowing earns two things:
 * the peer seam's real dependency surface is readable in one place instead of
 * inferred from the whole plugin context, and the seam can be exercised without
 * a harness — which is what lets the registration path (canonical-path lookup,
 * attach, degraded reporting) be tested deterministically instead of only in a
 * deployment.
 */
export interface PeerHostContext {
  /** The live agents, for residency, cwd inheritance and creation. */
  readonly agents: {
    /**
     * One live agent.
     * @param sessionId - the session to look up.
     * @returns the agent, or `undefined` when it is not resident.
     */
    get(sessionId: never): PeerCallerAgent | undefined
    /**
     * Every live agent.
     * @returns the agents.
     */
    list(): readonly PeerCallerAgent[]
    /**
     * Create one root agent.
     * @param options - the harness creation request.
     * @returns the handle for the created agent.
     */
    create(options: PeerCreateOptions): Promise<{ readonly agent: PeerCallerAgent }>
  }
  /**
   * Read one optional service off the registry.
   * @param name - the service name.
   * @returns the service, or `undefined` when this deployment composes none.
   */
  get(name: string): unknown
  /** The host logger, for failures that must also be visible in the deployment log. */
  readonly logger?: { warn?(message: string): void }
}

/** The slice of a live agent the peer bundle reads. */
export interface PeerCallerAgent {
  /** Its session id. */
  readonly id: unknown
  /** Its creation-time options, the fallback source of the peer's model route. */
  readonly options: PeerRoute
  /** Its scope context, read only to join the peer to the same composition. */
  readonly ctx: Context
  /** Its live session. */
  readonly session: {
    /**
     * The route in force after request-time selection.
     * @returns the request header's config, when a request has been made.
     */
    requestHeader(): { config?: PeerRoute } | undefined
    /**
     * The durable header fields the peer bundle reads.
     * @returns the header.
     */
    readonly header?: unknown
    /**
     * The events appended so far.
     * @returns the event log.
     */
    snapshotEvents(): readonly unknown[]
  }
  /**
   * Wake the agent with a message.
   * @param message - the message to deliver.
   */
  steer(message: never): void
  /**
   * Resolve once the agent is quiescent.
   * @returns a promise settled at quiescence.
   */
  whenIdle(): Promise<void>
}

/** The harness request one peer creation makes. */
export interface PeerCreateOptions {
  /** The pre-allocated session id. */
  readonly sessionId: never
  /** The durable creation metadata: the inherited directory and joined preset. */
  readonly meta?: { readonly cwd?: string; readonly agentPreset?: string }
  /** The inherited model route. */
  readonly agentOptions: never
  /**
   * Join the peer to its starter's composition.
   * @param agentCtx - the new agent's scope context.
   */
  setup(agentCtx: Context): void
}

/** The model route a peer inherits from its starter. */
interface PeerRoute {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
}

/** Everything this plugin reads out of the host, in its own shapes. */
export interface HostBundle extends ReportServiceHost {
  /**
   * Read display titles for a set of sessions.
   * @param ids - session ids.
   * @returns a title per session that has one.
   */
  readTitles(ids: readonly string[]): Promise<Map<string, string>>
  /**
   * Read every known session record, reduced to the fields the timeline needs.
   * @returns the records.
   */
  listSessionRecords(): Promise<SessionRecordLike[]>
}

/**
 * Read one string field off an untyped record.
 * @param source - the record.
 * @param key - field name.
 * @returns the value when it is a non-empty string.
 */
function str(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Extract only the header fields the timeline renders.
 *
 * The session query returns live harness records; copying them wholesale would
 * both break the leaf-field rule and drag unrelated state into the browser.
 * @param entry - one raw session record.
 * @returns the structural record, or `undefined` when it has no usable id.
 */
function toSessionRecord(entry: unknown): SessionRecordLike | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const record = entry as Record<string, unknown>
  const header = record.header
  if (header === null || typeof header !== 'object') return undefined
  const fields = header as Record<string, unknown>
  const id = str(fields, 'id')
  if (id === undefined) return undefined
  const parentSession = str(fields, 'parentSession')
  const origin = str(fields, 'origin')
  const agentPreset = str(fields, 'agentPreset')
  return {
    header: {
      id,
      ...(parentSession === undefined ? {} : { parentSession }),
      ...(origin === undefined ? {} : { origin }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
      ...(typeof fields.createdAt === 'number' ? { createdAt: fields.createdAt } : {}),
      ...(typeof fields.delegationDepth === 'number' ? { delegationDepth: fields.delegationDepth } : {}),
    },
    live: record.live === true,
  }
}

/**
 * Resolve the model route a peer is created with.
 *
 * This is the difference between a peer that works and a peer that dies silently:
 * an agent with no route cannot resolve `{{model}}` while its prompt is
 * assembled, so its first turn ends at step 1 with an `error` reason — before a
 * single tool call, which is why the ledger's `delivered` and the roster's `live`
 * both stay perfectly green while nothing whatsoever happens.
 *
 * The starter's live route is the right source, in the same order the harness's
 * own delegation uses: the session's request header records the route actually in
 * force after request-time selection, creation options are the fallback before
 * the first request, and only a starter carrying neither falls through to the
 * deployment default. When even that is absent the peer is refused rather than
 * created doomed.
 * @param caller - the live starter agent, when it is resident.
 * @param fallback - the deployment default model service, when it is mounted.
 * @returns the route fields to pass as creation options.
 * @throws when no source can name a provider and model.
 */
function peerRoute(caller: { readonly options: PeerRoute; readonly session: { requestHeader(): { config?: PeerRoute } | undefined } } | undefined, fallback: AgentDefaultModelLike | undefined): PeerRoute {
  const fromHeader = caller?.session.requestHeader()?.config
  const created = caller?.options
  const selection = fallback?.currentSelection()
  const provider = fromHeader?.provider ?? created?.provider ?? selection?.provider
  const model = fromHeader?.model ?? created?.model ?? selection?.model
  if (provider === undefined || model === undefined) {
    throw new Error(
      'report-ledger: cannot start a peer — no model route could be resolved for it. '
      + 'The starting session carries no provider/model and this deployment exposes no default model selection, '
      + 'so the peer would be created unable to assemble a prompt (its first turn would fail).',
    )
  }
  const reasoningEffort = fromHeader?.reasoningEffort ?? created?.reasoningEffort ?? selection?.reasoningEffort
  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(created?.maxTokens === undefined ? {} : { maxTokens: created.maxTokens }),
  }
}

/**
 * Whether a session's log already records an opened turn.
 * @param session - the live session.
 * @returns true when at least one `turn/start` was appended.
 */
function hasOpenedTurn(session: { snapshotEvents(): readonly unknown[] }): boolean {
  return session.snapshotEvents().some((event) => event !== null && typeof event === 'object' && (event as Record<string, unknown>).type === 'turn/start')
}

/**
 * Read the last turn's stop reason out of a session log.
 * @param session - the live session.
 * @returns the reason kind and, for an error, its message.
 */
function lastTurnReason(session: { snapshotEvents(): readonly unknown[] }): { kind?: string; message?: string } {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === null || typeof event !== 'object') continue
    const record = event as Record<string, unknown>
    if (record.type !== 'turn/end') continue
    const data = record.data
    if (data === null || typeof data !== 'object') return {}
    const reason = (data as Record<string, unknown>).reason
    if (reason === null || typeof reason !== 'object') return {}
    const fields = reason as Record<string, unknown>
    const error = fields.error
    const message = error === null || typeof error !== 'object' ? undefined : str(error as Record<string, unknown>, 'message')
    return {
      ...(typeof fields.kind === 'string' ? { kind: fields.kind } : {}),
      ...(message === undefined ? {} : { message }),
    }
  }
  return {}
}

/**
 * Wait for one agent to reach quiescence, bounded.
 *
 * The bound is what makes the answer usable: a peer that opened a turn and is
 * still working after it elapses is reported as running, while a turn that dies
 * (the silent failure mode this exists to expose) settles in milliseconds. The
 * timer is an observation window only — it is unref'd, so it can never be a
 * reason for the host to stay alive.
 * @param agent - the agent to observe.
 * @param timeoutMs - the window length.
 * @returns true when quiescence came first, false when the window closed first.
 */
function settledWithin(agent: { whenIdle(): Promise<void> }, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let finished = false
    const finish = (settled: boolean): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve(settled)
    }
    const timer = setTimeout(() => { finish(false) }, Math.max(timeoutMs, 0))
    timer.unref?.()
    void agent.whenIdle().then(() => { finish(true) }, () => { finish(true) })
  })
}

/**
 * Build every host capability this plugin consumes.
 *
 * Agent lookup goes through `ctx.agents`, and delivery uses the `Agent`'s own
 * `steer`/`inject` entries. Those entries take a message and no authority, which
 * is what lets a report reach a carbon-copy peer that the adjacency-checked
 * delegation path would refuse.
 * @param ctx - the plugin context.
 * @returns the host capability bundle.
 */
function buildHost(ctx: Context): HostBundle {
  const sessionQuery = (): SessionQueryLike | undefined => ctx.get('sessionQuery') as SessionQueryLike | undefined

  const readTitles = async (ids: readonly string[]): Promise<Map<string, string>> => {
    const titles = new Map<string, string>()
    const query = sessionQuery()
    if (query?.readTitleSnapshots === undefined || ids.length === 0) return titles
    try {
      const results = await query.readTitleSnapshots(ids)
      for (const result of results) {
        if (result === null || typeof result !== 'object') continue
        const entry = result as Record<string, unknown>
        if (entry.status !== 'fulfilled' || typeof entry.sessionId !== 'string') continue
        const value = entry.value as Record<string, unknown> | undefined
        const snapshot = value?.title as Record<string, unknown> | undefined
        const title = snapshot === undefined ? undefined : str(snapshot, 'title')
        if (title !== undefined) titles.set(entry.sessionId, title)
      }
    } catch {
      // Titles are cosmetic: a failing title service must not break the view.
    }
    return titles
  }

  return {
    getAgent(sessionId: string): AgentLike | undefined {
      const agent = ctx.agents.get(sessionId as never)
      if (agent === undefined) return undefined
      return {
        id: String(agent.id),
        steer: (message) => { agent.steer(message as never) },
        inject: (message) => { agent.inject(message as never) },
      }
    },
    async describe(sessionId: string): Promise<string | undefined> {
      return (await readTitles([sessionId])).get(sessionId)
    },
    selfCwd(sessionId: string): string | undefined {
      const cwd = (ctx.agents.get(sessionId as never)?.session?.header as { cwd?: unknown } | undefined)?.cwd
      return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
    },
    readTitles,
    async listSessionRecords(): Promise<SessionRecordLike[]> {
      const query = sessionQuery()
      if (query?.listSessions === undefined) return []
      const raw = await query.listSessions()
      const records: SessionRecordLike[] = []
      for (const entry of raw) {
        const record = toSessionRecord(entry)
        if (record !== undefined) records.push(record)
      }
      return records
    },
  }
}

/** Read one report's full detail for the tab's expanded panel. */
async function readDetail(id: string): Promise<ReportDetail | undefined> {
  const found = await readReport(id)
  if (found === undefined) return undefined
  const hops = await readHops(id)
  return { front: found.front, hops, pending: pendingTargets(hops), body: found.body, path: reportPath(id) }
}

/**
 * Build the peer-management capabilities from the running context.
 *
 * Peer creation is the only place this plugin adds a live agent, so it is the
 * only place that needs an authority story: the tool's visibility is the outer
 * gate, {@link Config.maxPeersPerAgent} bounds the blast radius, the peer
 * inherits the caller's own working directory (so it cannot be pointed at an
 * unrelated tree), and every creation is attributed in the roster log.
 *
 * It is also the only place that must supply what a fresh agent cannot supply
 * itself. A root session is born with no composition and no model route:
 *
 *  - **Composition.** The peer joins the starter's standing preset
 *    (`composeFrom`), which is a bind to the SAME generation the starter runs —
 *    not a re-resolution of the preset by id, so a preset edited or deleted since
 *    cannot hand the peer a different world than its starter's. A deployment with
 *    no roster yields no join and no error, exactly like a delegated child.
 *  - **Route.** The peer inherits the starter's provider/model/reasoning effort.
 *    Without it, prompt assembly cannot resolve `{{model}}` and every turn of the
 *    peer dies at step 1 before its first tool call.
 *  - **Preset identity.** The joined preset is recorded in the durable session
 *    header, so a cold read of the peer's log rebuilds the composition it
 *    actually ran under instead of the deployment default.
 *
 * It is also, on a deployment that composes a workspace registry, the only place
 * that can put the new peer into a workspace group — see
 * {@link PeerHost.attachToWorkspace} for why no other layer can: the registry's
 * history bootstrap runs once, long before this peer exists, and creation
 * metadata has no workspace field to name it with.
 *
 * `confirmPeer` closes the other half of the same problem: a peer that turns out
 * to be unable to run must be visible to the agent that just started it, rather
 * than reported as a successful hand-off.
 * @param ctx - the host capabilities this bundle reaches for.
 * @param host - the session-reading bundle.
 * @returns the peer host capability.
 */
export function buildPeerHost(ctx: PeerHostContext, host: HostBundle): PeerHost {
  const presets = (): AgentPresetsLike | undefined => ctx.get('agentPresets') as AgentPresetsLike | undefined
  const defaultModel = (): AgentDefaultModelLike | undefined => ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined
  return {
    selfCwd(sessionId: string): string | undefined {
      const session = ctx.agents.get(sessionId as never)?.session
      const cwd = (session?.header as { cwd?: unknown } | undefined)?.cwd
      return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
    },
    liveIds(): ReadonlySet<string> {
      const ids = new Set<string>()
      for (const agent of ctx.agents.list()) ids.add(String(agent.id))
      return ids
    },
    listSessionRecords: () => host.listSessionRecords(),
    readTitles: (ids: readonly string[]) => host.readTitles(ids),
    listReports: () => listReports(),
    async createPeer(input: { sessionId: string; startedBy: string; cwd?: string }) {
      const caller = ctx.agents.get(input.startedBy as never)
      if (caller === undefined) {
        throw new Error(
          `report-ledger: cannot start a peer from ${input.startedBy} — the starting session is not resident, `
          + 'so the peer has no composition and no model route to inherit',
        )
      }
      // Refuse before creating anything: a peer published without a route is a
      // session whose every turn fails at step 1, which is far worse than an error.
      const agentOptions = peerRoute(caller, defaultModel())
      const agentPreset = presets()?.composedPreset(caller.ctx)
      const meta = {
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(agentPreset === undefined ? {} : { agentPreset }),
      }
      const handle = await ctx.agents.create({
        sessionId: input.sessionId as never,
        ...(Object.keys(meta).length === 0 ? {} : { meta }),
        agentOptions: agentOptions as never,
        // Synchronous and roster-free, which is what lets it run inside the
        // creation window; a rosterless deployment joins nothing here.
        setup: (agentCtx: Context) => {
          presets()?.composeFrom(agentCtx, caller.ctx)
        },
      })
      // The handle is intentionally NOT retained. Its `dispose()` removes the
      // session from the store, which is exactly wrong for a peer that must
      // outlive this turn; the peer stays addressable through `ctx.agents`.
      return {
        id: String(handle.agent.id),
        steer: (message) => { handle.agent.steer(message as never) },
      }
    },
    /**
     * Put the new peer into the workspace group that owns its directory.
     *
     * This exists because nothing else does it. A session enters a workspace's
     * accounting at exactly one of two moments: the one-time history bootstrap,
     * which the registry runs only while its own `initialized` marker is false and
     * which therefore never sees a session created afterwards, or an attach
     * performed at creation by a caller that named a workspace. A GUI-created
     * session takes the second route. A peer cannot: `ctx.agents.create()` takes
     * creation metadata — `cwd`, `agentPreset` — and no workspace identity, so the
     * peer's directory matches a registered workspace while its id is absent from
     * that workspace's `sessionIds`. The browser groups by that accounting, not by
     * the directory, so such a peer sits under the ungrouped bucket for the rest
     * of its life.
     *
     * Registration is best-effort in three distinct senses, and each maps to one
     * outcome: no registry means no groups exist to join (`no-workspace`); no
     * registration owns the directory — a peer started in a fresh checkout or a
     * temporary directory — is legitimate and also `no-workspace`; an attempt that
     * throws is `failed` and carried back as a warning. Only the last is a defect,
     * and none of the three is allowed to break peer creation: a partner that
     * exists but is listed in the wrong bucket is still a working partner, while a
     * refused peer is no partner at all.
     * @param input - the peer session, and the directory it was created with.
     * @returns the outcome, as the report rather than as a throw.
     */
    async attachToWorkspace(input: { sessionId: string; cwd?: string }): Promise<WorkspaceRegistration> {
      const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
      if (registry === undefined) return { outcome: 'no-workspace' }
      if (input.cwd === undefined) return { outcome: 'no-workspace' }
      try {
        const workspace = await registry.resolveByPath(await realpathNormalize(input.cwd))
        if (workspace === undefined) return { outcome: 'no-workspace' }
        await workspace.attachSession(input.sessionId as SessionId)
        return { outcome: 'registered', workspace: workspace.title }
      } catch (error) {
        const warning = error instanceof Error ? error.message : String(error)
        // Logged as well as reported: the tool result is read once by the agent
        // that started the peer, and a silently ungrouped peer is exactly the
        // symptom this hook exists to make visible in the deployment log too.
        ctx.logger?.warn?.(`report-ledger: peer ${input.sessionId} could not be registered with its workspace: ${warning}`)
        return { outcome: 'failed', warning }
      }
    },
    async confirmPeer(sessionId: string, timeoutMs: number): Promise<PeerReceipt | undefined> {
      const agent = ctx.agents.get(sessionId as never)
      if (agent === undefined) return undefined
      // No turn was ever opened: the digest is sitting in a durable inbox that
      // nothing woke. That is a real, reportable state and it is NOT "running".
      if (!hasOpenedTurn(agent.session)) return { kind: 'unstarted' }
      if (!await settledWithin(agent, timeoutMs)) return { kind: 'running' }
      const reason = lastTurnReason(agent.session)
      if (reason.kind === 'error') {
        return { kind: 'failed', reason: 'error', ...(reason.message === undefined ? {} : { error: reason.message }) }
      }
      return { kind: 'settled', ...(reason.kind === undefined ? {} : { reason: reason.kind }) }
    },
  }
}

/**
 * Apply the host half.
 * @param ctx - the plugin context (`tools`, `systemPrompt`, `agents` injected).
 * @param config - resolved plugin config from the composition row.
 */
export function apply(ctx: Context, config?: Config): void {
  const host = buildHost(ctx)
  const service = new ReportService(host)
  const peers = new PeerService(buildPeerHost(ctx, host), config?.maxPeersPerAgent ?? DEFAULT_MAX_PEERS)
  const worktree = resolveWorktree(config?.worktree)

  ctx.effect(() => registerReportTools(ctx, service, peers, worktree), 'report-ledger: model tools')

  // The delivery pump. A hand-off recorded while its recipient was absent stays
  // pending in the transfer path; this is where it finally lands. Failures are
  // logged, never thrown: a ledger problem must not break agent creation.
  //
  // The explicit `undefined` return is what DSH 0.2.0 requires. There the listener
  // signature is `undefined | Promise<undefined>` — the payload also grew
  // `source` and `signal` in the same change — so a handler whose inferred return
  // type is `void` no longer satisfies it. The flush deliberately stays
  // un-awaited: delivery must never be a reason for agent creation to wait.
  ctx.on('agent/created', (payload: { agent: { id: unknown } }): undefined => {
    const sessionId = String(payload?.agent?.id ?? '')
    if (sessionId === '') return undefined
    void service.flushForAgent(sessionId).catch((error: unknown) => {
      ctx.logger?.warn?.(`report-ledger: deferred delivery to ${sessionId} failed: ${String(error)}`)
    })
    return undefined
  })

  // The browser tab's read surface.
  //
  // Registered through a service-injection callback rather than a plain
  // `ctx.get`, because the two are NOT equivalent for a service that may arrive
  // late: `ctx.get` reads the registry at this instant and returns undefined if
  // the provider has not activated yet, while the callback runs when the service
  // actually appears. The `webserver` row injects `webStartup`, so in a web
  // profile it can activate after this row — with `ctx.get` the routes were
  // silently never registered and every request fell through to the `/api` auth
  // fence, which answers 401 before our handler is ever reached.
  //
  // It is still optional, which is why this is not on the plugin's own `inject`
  // list: the headless profile mounts no web server at all, and there the
  // callback simply never runs while the ledger and every tool keep working.
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer') as WebServerLike | undefined
    if (webServer === undefined) return
    const deps = {
      timeline: async (root: string) => buildTimeline({
        listSessionRecords: () => host.listSessionRecords(),
        readTitles: (ids: readonly string[]) => host.readTitles(ids),
        listReports: () => listReports(),
        readHops: (report: string) => readHops(report),
      }, root),
      report: readDetail,
      worktrees: async () => buildWorktreeReport({
        listReports: () => listReports(),
        readHops: (report: string) => readHops(report),
      }, worktree.settings, worktree.enabled),
    }
    scoped.effect(() => {
      const disposeReport = webServer.register({ kind: 'exact', path: REPORT_PATH, handler: createReportHandler(deps) as never })
      const disposeTimeline = webServer.register({ kind: 'exact', path: TIMELINE_PATH, handler: createTimelineHandler(deps) as never })
      const disposeWorktrees = webServer.register({ kind: 'exact', path: WORKTREES_PATH, handler: createWorktreesHandler(deps) as never })
      return () => {
        disposeWorktrees()
        disposeTimeline()
        disposeReport()
      }
    }, 'report-ledger: read endpoints')
  })

  if ((config?.announceToAgent ?? true) === false) return

  // The protocol is a plain string, byte-identical for every agent, so the
  // shared part of the prompt stays a stable prefix in every scope.
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'plugin:report-ledger',
      order: SECTION_ORDER,
      text: PROTOCOL,
    }),
    'report-ledger: protocol section',
  )

  // The partnership contract is evaluated per assembly: a delegated agent must
  // learn that it is a long-lived collaborator rather than a one-shot function,
  // and must receive its parent's session id or it cannot report upward at all.
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'plugin:report-ledger:partnership',
      order: PARTNERSHIP_SECTION_ORDER,
      text: partnershipText,
    }),
    'report-ledger: partnership section',
  )
}
