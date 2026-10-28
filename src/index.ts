/**
 * Host half of dsh-report-ledger — runs in the DSH host process.
 *
 * Loaded from the profile composition through the `report-ledger` row in
 * cordis.patch.yml. It wires four things into the running harness:
 *
 *  1. the report service, which owns the durable ledger under
 *     `$DSH_HOME/report-ledger`;
 *  2. the model-facing tools: thirteen `report_*` rows (fourteen once the
 *     worktree feature is enabled) plus `peer_list` / `peer_start` / `peer_wake`;
 *  3. the delivery pump — when a session becomes resident again, every hand-off
 *     the ledger is still holding for it is delivered, and one deferred sweep
 *     does the same for sessions that were already resident when this row
 *     loaded. That is the durable mailbox the delegation seam documents as
 *     missing;
 *  4. three read-only HTTP endpoints the browser tab reads — the session
 *     timeline, one report's detail, and the working-tree maintenance view —
 *     registered on the harness web server when one is mounted (the headless
 *     profile has none, and the plugin stays fully functional without them).
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
import { DEFAULT_MAX_PEERS, PeerService, type PeerHost, type PeerPermission, type PeerReceipt, type WorkspaceRegistration } from './report/peer.ts'
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
  /**
   * Fold titles for a set of sessions.
   *
   * The cost is NOT uniform across ids and the difference is the whole reason the
   * title path below has the shape it has: a resident session folds in memory,
   * while a session this process is not holding is resolved by reading its
   * COMPLETE stored log — tens of thousands of Zstandard frames for a long
   * session — because the harness's projection cache does not serve this call. On
   * the largest collaboration on this machine that is 389 ms per session and 5 s
   * for one tree, measured; through the request path it is 18 s.
   * @param ids - sessions to fold titles for.
   * @param signal - cancellation, and the only way to put a ceiling on the cost.
   * @returns one settled result per requested id.
   */
  readTitleSnapshots?(ids: readonly string[], signal?: AbortSignal): Promise<readonly unknown[]>
}

/** One projection block, as far as a title read cares about it. */
interface ProjectionBlockLike {
  /** Projection values by key; `title` is the plain string this plugin reads. */
  readonly values?: Record<string, unknown>
}

/**
 * Structural face of the persisted projection cache (`ctx.sessionProjectionCache`).
 *
 * Optional, and worth reaching for because of one property the docs state and the
 * measurements confirm: a read is served from the domain's in-memory tables, so it
 * costs no I/O and no log decoding. Its rows are a checkpoint of each session's
 * projections — possibly stale by a checkpoint, never wrong, and identified by the
 * session's lifecycle — which is exactly the trade a display title wants.
 */
interface SessionProjectionCacheLike {
  /**
   * Whole values viewed straight from the stored rows.
   * @param meta - the listed session's header (identity witness, no log read).
   * @param keys - projection keys the caller needs.
   * @returns the block, or `undefined` when no usable row exists.
   */
  cachedSnapshot?(meta: never, keys?: readonly string[]): ProjectionBlockLike | undefined
  /**
   * A predecessor checkpoint's title, for rows that lag their log.
   * @param meta - the authoritative listed header.
   * @returns a title-only block, or `undefined`.
   */
  cachedPredecessorTitle?(meta: never): ProjectionBlockLike | undefined
}

/** Structural face of the live title service (`ctx.sessionTitle`). */
interface SessionTitleFaceLike {
  /**
   * The current title of a resident session.
   * @param session - the live session.
   * @returns the snapshot, or `undefined` before a title exists.
   */
  get(session: never): { readonly title?: unknown } | undefined
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

/**
 * Structural face of the per-session sandbox-mode owner.
 *
 * Optional like the other service faces: a deployment may compose no sandbox
 * policy at all, and there the peer simply keeps whatever mode its own creation
 * pinned. What is read here is the starter's *effective* mode — its own logged
 * override when it has one, the deployment default otherwise — because that is
 * the mode the starter was actually running under when it opened the peer.
 */
interface SandboxPolicyLike {
  /**
   * Resolve one session's effective mode.
   * @param request - the session whose mode to resolve.
   * @returns the resolved policy; only `mode` is read.
   */
  resolve(request: { session: unknown }): { mode?: unknown } | undefined
}

/**
 * Structural face of the per-session approval-policy owner.
 *
 * Read for the same reason as the sandbox mode: an escalation prompt is a
 * per-session fact, so a peer that does not inherit the policy its starter ran
 * under runs under a different authority than the session that opened it.
 */
interface ApprovalLike {
  /**
   * One session's effective policy.
   * @param session - the session whose policy to read.
   * @returns `'ask'`, `'never'`, or `undefined` on a harness that answers neither.
   */
  effectivePolicy(session: unknown): unknown
}

/** Structural face of the permission-preset owner (the durable identity of the two knobs above). */
interface PermissionPresetsLike {
  /**
   * The preset one session currently matches.
   * @param session - the session to resolve.
   * @returns a configured preset name, `'auto'`, or `'custom'`.
   */
  current(session: unknown): string | undefined
}

/** The value `permissionPresets.current()` returns when the effective knobs match no configured preset. */
const CUSTOM_PRESET = 'custom'

/**
 * One session's permission state, captured at peer creation.
 *
 * The shape is owned by {@link PeerPermission} in the peer module, because it is
 * also what `peer_start` reports back: one type on both halves of the seam, so a
 * field cannot be captured here and silently dropped there.
 */
export type InheritedPermission = PeerPermission

/**
 * The unpublished session a peer is composed on, as much of it as this plugin
 * touches. The harness hands it to `setup()` as the second argument, exactly as
 * its own delegation seam does; `append` is the only method read.
 */
interface PeerAppendTarget {
  /** The session whose log is still unpublished at this point. */
  readonly session?: {
    /**
     * Append one event to the unfinished log.
     * @param type - the event type.
     * @param data - the event payload.
     */
    append(type: string, data: Record<string, unknown>): void
  }
}

/**
 * Capture the permission state a peer should inherit from its starter.
 *
 * Called synchronously before creation, for the same reason the harness captures
 * delegated policy before the child's first await: a switch the starter makes
 * afterwards belongs to the starter's future, not to this peer. Nothing here
 * consults the harness's event vocabulary directly — the three optional services
 * already fold each session's log, and asking them is what keeps the answer
 * identical to the one the starter's own tools resolve at execution time.
 * @param ctx - the host capabilities, for the optional policy services.
 * @param session - the starter's live session.
 * @returns the fields worth inheriting; empty when no service is composed.
 */
export function captureInheritedPermission(ctx: PeerHostContext, session: PeerCallerAgent['session']): InheritedPermission {
  const presets = ctx.get('permissionPresets') as PermissionPresetsLike | undefined
  const sandboxPolicy = ctx.get('sandboxPolicy') as SandboxPolicyLike | undefined
  const approval = ctx.get('approval') as ApprovalLike | undefined
  const preset = presets?.current(session)
  const sandbox = sandboxPolicy?.resolve({ session })?.mode
  const policy = approval?.effectivePolicy(session)
  return {
    // `custom` is the derived "matches no preset" state, reserved and not a valid
    // identity: copying it would name a preset nothing can resolve. The knobs
    // below still travel, so the peer lands in the same custom state honestly.
    ...(typeof preset === 'string' && preset !== '' && preset !== CUSTOM_PRESET ? { preset } : {}),
    ...(typeof sandbox === 'string' && sandbox !== '' ? { sandbox } : {}),
    ...(typeof policy === 'string' && policy !== '' ? { approval: policy } : {}),
  }
}

/**
 * Record an inherited permission state on the peer's unpublished log.
 *
 * `source: 'delegation'` is the harness's own marker for exactly this fact — a
 * policy the session did not choose for itself — so a cold read of the peer's log
 * can tell an inherited mode from one the user later picked in that session, and
 * a later switch in the peer still wins because it is simply a later event.
 *
 * The preset identity is written LAST and separately: the permission service's
 * own pinning pass runs after this window, fills any knob this run could not
 * capture, and derives the identity itself when none was inherited. Writing ours
 * first means that pass has something to reconcile against rather than a blank.
 * @param created - the unpublished agent, when the harness handed one over.
 * @param inherited - the captured state.
 * @returns true when there was something to write and a log to write it to.
 */
export function appendInheritedPermission(created: PeerAppendTarget | undefined, inherited: InheritedPermission): boolean {
  const log = created?.session
  if (log === undefined || typeof log.append !== 'function') return false
  const write = (type: string, data: Record<string, unknown>): void => { log.append(type, data) }
  if (inherited.sandbox !== undefined) write('sandbox/mode', { mode: inherited.sandbox, source: 'delegation' })
  if (inherited.approval !== undefined) write('approval/policy', { policy: inherited.approval, source: 'delegation' })
  if (inherited.preset !== undefined) write('permission/preset', { preset: inherited.preset })
  return true
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
    /**
     * Resume one persisted session.
     *
     * Optional in this shape for the same reason the workspace hook is: a harness
     * build without the entry, or a deployment that composes no persistence, has
     * to surface as a named refusal at the tool instead of as a crash inside the
     * adapter. The peer bundle treats an absent entry as exactly that refusal.
     * @param options - the persisted identity, the route, and the composition.
     * @returns the handle for the resumed agent.
     */
    resume?(options: PeerResumeOptions): Promise<{ readonly agent: PeerCallerAgent }>
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
   * Compose the peer: join its starter's composition, then inherit the
   * starter's permission state.
   *
   * Runs while the session is still unpublished — the harness's `setup()` window,
   * shared with its own delegation seam — which is what makes the appended
   * permission events part of the peer's first stored snapshot instead of a
   * mutation that could lose a race with its first turn.
   * @param agentCtx - the new agent's scope context.
   * @param created - the unpublished agent, whose session log may be appended to.
   */
  setup(agentCtx: Context, created?: PeerAppendTarget): void
}

/** The harness request one peer resume makes. */
export interface PeerResumeOptions {
  /** The persisted session id to load. */
  readonly resumeSessionId: never
  /**
   * The route the resumed agent runs on.
   *
   * A resumed root agent is as composition-less as a fresh one: without a route
   * the prompt's `{{model}}` cannot resolve and its first turn dies at step 1.
   */
  readonly agentOptions: never
  /**
   * Compose the resumed agent: join its starter's live composition.
   *
   * Permission inheritance is deliberately absent. The state was written onto the
   * peer's own log when it was created and a warm resume restores it from there;
   * re-capturing the starter's current state on every wake would overwrite a
   * later switch made in that session, which is the difference this plugin draws
   * between inheriting and pinning.
   * @param agentCtx - the resumed agent's scope context.
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
  /**
   * Drop the cached session-corpus listing.
   *
   * Called when a session becomes resident: `agent/created` is exactly the event
   * that can introduce an id the previous listing did not contain, and a
   * brand-new session must not be missing from its own timeline merely because a
   * poll a second earlier populated the cache.
   */
  invalidateSessionListing?(): void
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
 *
 * Reasoning effort follows the harness rule exactly rather than the looser
 * `??` chain the other fields use: a request header that is present but names no
 * effort means the effort is ABSENT (the model resolves its own default), not
 * "reuse whatever the creation options remember". That difference is not
 * cosmetic — after the starter switches to a model whose route carries no
 * effort, a peer handed the stale one starts on a route it cannot use, and it
 * dies at its first request while the ledger still reports a successful
 * hand-off. See `parentAgentOptionsForDelegation` in `@deepseek-ai/dsh-subagent`.
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
  // The header owns the effort whenever it exists; only a starter that has never
  // issued a request inherits the creation-time effort, then the deployment
  // default the same way provider/model do.
  const reasoningEffort = fromHeader === undefined
    ? (created?.reasoningEffort ?? selection?.reasoningEffort)
    : fromHeader.reasoningEffort
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
 * How long one session-corpus listing is reused before it is read again.
 *
 * Long enough to cover the browser's poll interval (ten seconds, see
 * `POLL_INTERVAL_MS` in the client half), because a window shorter than the
 * cadence it is meant to serve can never hit: every poll would pay a full
 * directory walk plus a frame read per session log, which is what the tab was
 * doing. Freshness does not come from this number — `agent/created` invalidates
 * outright, and everything that changes independently of the corpus (the report
 * digests, the transfer paths, the lanes) is still read fresh on every request.
 * A session created by ANOTHER process is the only thing that can be this late.
 */
const SESSION_LISTING_TTL_MS = 15_000

/**
 * How long a title answered by the expensive path is reused, found or not.
 *
 * The cheap faces answer most reads, so this only bounds the deployments and the
 * sessions the projection cache cannot serve — and there the difference between
 * remembering and not remembering is a full log decode per poll. Negative answers
 * are cached for the same reason: a session with no title is otherwise the worst
 * case, not the best one.
 */
const TITLE_FALLBACK_TTL_MS = 60_000

/**
 * Wall-clock budget one request may spend decoding logs to find titles.
 *
 * The titles are decoration; the tree, the digests and the lanes are the view. A
 * request that spends whole seconds on decoration is a view that never arrives,
 * so the expensive path is bounded rather than trusted to be fast.
 */
const TITLE_FALLBACK_DEADLINE_MS = 2_000

/**
 * How many sessions one request may send down the expensive title path.
 *
 * A count cap on top of the deadline because the deadline is enforced per call:
 * without this, a tree of fifty titles the projection cache cannot serve would
 * still issue one batch of fifty.
 */
const TITLE_FALLBACK_MAX_IDS = 8

/** How many fallback title answers are remembered before the oldest is dropped. */
const TITLE_FALLBACK_ENTRIES = 2048

/** One remembered expensive title answer; `title` is absent when there was none. */
interface TitleMemo {
  /** When the answer was recorded, for the reuse window. */
  readonly at: number
  /** The title, when the answer was one. */
  readonly title?: string
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
  // Both zero-I/O title faces are optional services, and neither is on the
  // plugin's `inject` list: a deployment that composes neither still gets titles,
  // they just come from the bounded expensive path below.
  const titleFace = (): SessionTitleFaceLike | undefined => ctx.get('sessionTitle') as SessionTitleFaceLike | undefined
  const projectionCache = (): SessionProjectionCacheLike | undefined =>
    ctx.get('sessionProjectionCache') as SessionProjectionCacheLike | undefined

  // The corpus listing, reused briefly and never run twice at once.
  //
  // Every timeline request used to re-enumerate the whole durable session
  // corpus, and the browser tab polls it. The listing is a directory walk plus a
  // read of each log's first frame, so on a long-lived deployment it is the most
  // expensive thing this surface does, and overlapping requests paid it
  // repeatedly. Two rules fix that without inventing a second source of truth:
  //
  //  - **in-flight dedupe** — concurrent readers join the one running listing;
  //  - **reuse window longer than the poll cadence** — a listing is reused for
  //    SESSION_LISTING_TTL_MS so a poll burst costs one walk. The report digests
  //    and the lanes are still read fresh on every request, and `agent/created`
  //    drops the cache outright, so a session that just appeared can never be
  //    missing from its own timeline.
  //
  // The raw headers ride along because they are already in hand here and they are
  // the identity witness the projection cache wants for a zero-I/O title read:
  // that cache matches a row by lifecycle (format version, creation time, working
  // directory, seeded flag), so a reduced record cannot be used in its place.
  let listingCache: { readonly at: number; readonly records: readonly SessionRecordLike[] } | undefined
  let listingPending: Promise<readonly SessionRecordLike[]> | undefined
  let listingGeneration = 0
  let headerById = new Map<string, unknown>()

  const readListing = async (): Promise<SessionRecordLike[]> => {
    const query = sessionQuery()
    if (query === undefined || query.listSessions === undefined) return []
    const list = query.listSessions.bind(query)
    const cached = listingCache
    if (cached !== undefined && Date.now() - cached.at < SESSION_LISTING_TTL_MS) return [...cached.records]
    const pending = listingPending
    if (pending !== undefined) return [...await pending]
    const generation = listingGeneration
    const started = (async (): Promise<readonly SessionRecordLike[]> => {
      try {
        const raw = await list()
        const records: SessionRecordLike[] = []
        const headers = new Map<string, unknown>()
        for (const entry of raw) {
          const record = toSessionRecord(entry)
          if (record === undefined) continue
          records.push(record)
          const header = (entry as { readonly header?: unknown } | null | undefined)?.header
          if (header !== undefined && header !== null) headers.set(record.header.id, header)
        }
        // A listing that started before an invalidation must not repopulate the
        // cache: its snapshot can predate the session that invalidated it.
        if (generation === listingGeneration) {
          listingCache = { at: Date.now(), records }
          headerById = headers
        }
        return records
      } finally {
        if (generation === listingGeneration) listingPending = undefined
      }
    })()
    listingPending = started
    return [...await started]
  }

  /**
   * Ask the projection cache for one session's title.
   *
   * `undefined` means the cache could not answer — no row for this lifecycle, no
   * cache at all — and the caller has to fall back. An empty object means it did
   * answer, and the answer is "this session has no title yet": that is a real
   * fact worth having, because the alternative is decoding a log to learn it.
   * @param cache - the projection cache service.
   * @param header - the listed session's raw header.
   * @returns the answer, when there was one.
   */
  const cachedTitle = (cache: SessionProjectionCacheLike, header: unknown): { readonly title?: string } | undefined => {
    let block: ProjectionBlockLike | undefined
    try {
      block = cache.cachedSnapshot?.(header as never, ['title'])
    } catch {
      block = undefined
    }
    if (block?.values === undefined) {
      try {
        block = cache.cachedPredecessorTitle?.(header as never)
      } catch {
        block = undefined
      }
    }
    if (block?.values === undefined) return undefined
    const value = block.values['title']
    return typeof value === 'string' && value !== '' ? { title: value } : {}
  }

  /** Titles answered by {@link readTitleSnapshots}, both found and not. */
  const titleMemo = new Map<string, TitleMemo>()

  /** Remember one expensive answer, keeping the map inside its budget. */
  const rememberTitle = (id: string, title?: string): void => {
    titleMemo.delete(id)
    titleMemo.set(id, title === undefined ? { at: Date.now() } : { at: Date.now(), title })
    for (const key of titleMemo.keys()) {
      if (titleMemo.size <= TITLE_FALLBACK_ENTRIES) break
      titleMemo.delete(key)
    }
  }

  /**
   * Read display titles for a set of sessions.
   *
   * The order of the four attempts below is the whole of this function, and it is
   * a cost order, not a preference order:
   *
   *  1. **A resident session** answers from `sessionTitle` — a synchronous fold of
   *     the live projection state. Never worth decoding a log for.
   *  2. **`sessionProjectionCache`** answers from its in-memory tables using the
   *     header the listing just returned. Zero I/O, and the row is a checkpoint of
   *     this very session's `title` projection, so it is possibly stale by a
   *     checkpoint and never wrong — the same answer the product's own session
   *     list shows for that row.
   *  3. **A remembered answer** from the last time the expensive path ran, inside
   *     {@link TITLE_FALLBACK_TTL_MS}. Negative answers count: without them the
   *     sessions the cache cannot serve are re-decoded on every poll.
   *  4. **`readTitleSnapshots`** for what is left, capped in count, bounded in
   *     wall-clock, and remembered whatever it returns.
   *
   * Measured on this machine, step 4 is the difference between a timeline request
   * that answers in a fraction of a second and one that answers in eighteen: the
   * harness resolves a non-resident session for that call by decoding its complete
   * stored log, which is 389 ms to 1.3 s per session and was 5.1 s for one
   * thirteen-session tree offline. It is what the previous version of this
   * function did for every session on every poll, which is why the tab took longer
   * to load than the browser's own timeout patience.
   * @param ids - session ids to resolve.
   * @returns a title per session that has one.
   */
  const readTitles = async (ids: readonly string[]): Promise<Map<string, string>> => {
    const titles = new Map<string, string>()
    const wanted = [...new Set(ids)]
    if (wanted.length === 0) return titles
    const live = titleFace()
    const cache = projectionCache()
    const pending: string[] = []
    const needHeader: string[] = []
    for (const id of wanted) {
      const session = ctx.agents.get(id as never)?.session
      if (session !== undefined && live !== undefined) {
        // A resident session that has no title YET is not a miss to chase: the next
        // poll re-reads this in microseconds, and the title appears on its own.
        try {
          const snapshot = live.get(session as never)
          const title = snapshot === undefined ? undefined : snapshot.title
          if (typeof title === 'string' && title !== '') titles.set(id, title)
        } catch {
          // A cosmetic read must never be the reason a view fails.
        }
        continue
      }
      needHeader.push(id)
    }
    if (needHeader.length > 0 && cache !== undefined) {
      // The listing is shared with the timeline that is asking, so this is free on
      // the request path; on the tool path it is one walk per reuse window, which
      // is still an order of magnitude cheaper than one log decode. It is only
      // reached when a title is actually wanted for a session that is NOT resident,
      // so the hot "describe the agent that is calling me" path never pays it.
      try {
        await readListing()
      } catch {
        // The header map is a cache of a listing the timeline already needed; a
        // failing walk costs the titles, and must not cost the view.
      }
      for (const id of needHeader) {
        const header = headerById.get(id)
        const answered = header === undefined ? undefined : cachedTitle(cache, header)
        if (answered === undefined) {
          pending.push(id)
          continue
        }
        if (answered.title !== undefined) titles.set(id, answered.title)
      }
    } else {
      pending.push(...needHeader)
    }

    const now = Date.now()
    const expired: string[] = []
    for (const id of pending) {
      const memo = titleMemo.get(id)
      if (memo !== undefined && now - memo.at < TITLE_FALLBACK_TTL_MS) {
        if (memo.title !== undefined) titles.set(id, memo.title)
        continue
      }
      expired.push(id)
    }
    const query = sessionQuery()
    if (expired.length === 0 || query?.readTitleSnapshots === undefined) return titles
    const batch = expired.slice(0, TITLE_FALLBACK_MAX_IDS)
    try {
      // `AbortSignal.timeout` is what makes the ceiling real: the harness checks
      // the signal between frames, so an expired one ends the decode instead of
      // returning it late to nobody.
      const signal = typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(TITLE_FALLBACK_DEADLINE_MS)
        : undefined
      const results = await query.readTitleSnapshots(batch, signal)
      const answered = new Set<string>()
      for (const result of results) {
        if (result === null || typeof result !== 'object') continue
        const entry = result as Record<string, unknown>
        if (entry.status !== 'fulfilled' || typeof entry.sessionId !== 'string') continue
        const value = entry.value as Record<string, unknown> | undefined
        const snapshot = value?.title as Record<string, unknown> | undefined
        const title = snapshot === undefined ? undefined : str(snapshot, 'title')
        answered.add(entry.sessionId)
        if (title !== undefined) titles.set(entry.sessionId, title)
        rememberTitle(entry.sessionId, title)
      }
      // A session the harness never answered is remembered as titleless: the next
      // poll must not spend its budget on the same ids, or a tree the projection
      // cache cannot serve would never get past its first few titles.
      for (const id of batch) if (!answered.has(id)) rememberTitle(id)
    } catch {
      // A deadline, a failing title service, a store the harness cannot decode:
      // none of them are reasons to break the view, and all of them are worth
      // remembering so the next poll does not pay for them again.
      for (const id of batch) rememberTitle(id)
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
    listSessionRecords: readListing,
    invalidateSessionListing(): void {
      listingGeneration += 1
      listingCache = undefined
      listingPending = undefined
      // The headers belong to that listing, so they go with it: a recreated session
      // id must never be paired with a header from its previous lifecycle.
      headerById = new Map()
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
 *  - **Permissions.** The peer inherits the starter's effective sandbox mode,
 *    approval policy, and permission-preset identity, written onto its own log
 *    with the harness's `source: 'delegation'` marker. This is the part that does
 *    NOT happen by itself and is easy to miss, because its absence is silent:
 *    without it a peer is pinned to the deployment's default preset, so a peer
 *    started by a fully-permissive session still asks the user to approve what
 *    that session could already do — and a peer started by a read-only session is
 *    more powerful than its starter. Inheriting is also what keeps the peer a
 *    peer rather than a subordinate: the state lands in the peer's own log, so
 *    the user can inspect it and switch it in that session afterwards.
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
      // Captured synchronously, before the first await: a preset switch the starter
      // makes while this peer is being created belongs to its future, not to the
      // peer. The same rule (and the same reason) as the harness's delegation seam.
      const inherited = captureInheritedPermission(ctx, caller.session)
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
        setup: (agentCtx: Context, created?: PeerAppendTarget) => {
          presets()?.composeFrom(agentCtx, caller.ctx)
          // A peer that kept the deployment default while its starter ran on full
          // access is the defect this call closes: it asks the user to approve what
          // the session that opened it was already allowed to do. The state is
          // written onto the peer's own log, so the peer stays a root session with
          // its own authority — inheritable, inspectable, and switchable later.
          if (!appendInheritedPermission(created, inherited) && Object.keys(inherited).length > 0) {
            ctx.logger?.warn?.(
              `report-ledger: peer ${input.sessionId} could not inherit ${JSON.stringify(inherited)} from ${input.startedBy} — `
              + 'the harness handed no unpublished session to setup(); the peer runs on its own creation-time preset instead',
            )
          }
        },
      })
      // The handle is intentionally NOT retained. Its `dispose()` removes the
      // session from the store, which is exactly wrong for a peer that must
      // outlive this turn; the peer stays addressable through `ctx.agents`.
      return {
        id: String(handle.agent.id),
        steer: (message) => { handle.agent.steer(message as never) },
        // Reported back so the caller (and the user reading its transcript) can see
        // what authority the peer actually got instead of inferring it from silence.
        ...(Object.keys(inherited).length === 0 ? {} : { permission: inherited }),
      }
    },
    /**
     * Load a peer back into this process.
     *
     * The mirror of `createPeer`, and it exists because nothing else in the plugin
     * can do this: a hand-off is delivered by `steer` to a live agent, so an absent
     * peer is unreachable until something loads its session. `ctx.agents.resume`
     * is that something, and it carries the same composition obligation — the
     * resumed agent is a fresh root agent, so without the starter's live preset and
     * route its very first turn dies at step 1, silently.
     *
     * Deliberately missing from the setup callback: permission inheritance. The
     * state was captured onto the peer's own log at creation and a warm resume
     * restores it from there. Re-capturing the starter's current state on every
     * wake would overwrite whatever the peer switched to since — which is exactly
     * the difference this plugin draws between inheriting and pinning.
     *
     * Each precondition is stated rather than left to fail deeper: an unresolvable
     * `ctx.agents.resume`, a deployment with no persistence, and a starter that is
     * no longer resident all produce the same outer symptom (a peer that never
     * comes back), and naming which one it was is the difference between a fixable
     * report and a retry loop.
     * @param input - the persisted session, and the live starter to compose it from.
     * @returns the resumed session id.
     */
    async resumePeer(input: { sessionId: string; startedBy: string }): Promise<{ id: string }> {
      const starter = ctx.agents.get(input.startedBy as never)
      if (starter === undefined) {
        throw new Error(
          `the session that started it (${input.startedBy}) is no longer resident, so the peer has no composition `
          + 'and no model route to be resumed under',
        )
      }
      const resume = ctx.agents.resume
      if (typeof resume !== 'function') {
        throw new Error(
          'this harness build exposes no agent-resume entry (ctx.agents.resume), so a non-resident session cannot be loaded',
        )
      }
      if (ctx.get('sessionPersistence') === undefined) {
        throw new Error(
          'this deployment composes no session persistence, so a non-resident session cannot be loaded from disk',
        )
      }
      const handle = await resume.call(ctx.agents, {
        resumeSessionId: input.sessionId as never,
        agentOptions: peerRoute(starter, defaultModel()) as never,
        setup: (agentCtx: Context) => {
          presets()?.composeFrom(agentCtx, starter.ctx)
        },
      })
      return { id: String(handle.agent.id) }
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
 * One mounted-instance slot per composition root; see {@link claimInstanceSlot}.
 *
 * The WeakMap key is the Cordis root context (`ctx.root`), not the process: two rows
 * of this package in one composition share that root and must not both mount, while
 * two independent roots in one process (tests, an embedded harness) are unrelated
 * compositions and may each mount their own instance.
 */
const LIVE_INSTANCES = Symbol.for('dsh-report-ledger.liveInstances')

/** How often a row waiting for the single-instance slot retries, in milliseconds. */
const INSTANCE_WAIT_MS = 250

/**
 * Claim the one mounted-instance slot for this composition, registering its release
 * on unload.
 *
 * A profile can compose two rows of this package — the release row and the
 * developer-mode row (see `cordis.patch.yml`) — and the Plugins page can switch
 * them independently. Two instances would each own a mutex table for the same
 * ledger files, which the single-writer invariant does not cover: the README's
 * single-process assumption stops at *two processes*, and in-process duplicates
 * are worse than the last-writer-wins case those two would get.
 *
 * The slot lives on `globalThis` rather than in module scope so it survives a
 * module eviction: HMR disposes the old fiber and imports the module again, and a
 * module-local counter would be reset to zero by the import while the disposer
 * that decrements it still refers to the old copy. It also keeps the add-on
 * bundle's separately inlined copy of this function and the release copy looking at
 * the same table — hence a `Symbol.for` key.
 *
 * A test fixture passes a plain object instead of a Cordis context; with no `root`
 * to share, the context object itself is the key, so each fixture is its own
 * composition.
 * @param ctx - the plugin context, used to release the slot on unload.
 * @returns whether the slot was free and is now held by this fiber.
 */
function claimInstanceSlot(ctx: Context): boolean {
  const scope = globalThis as unknown as { [LIVE_INSTANCES]?: WeakMap<object, number> }
  const slots = scope[LIVE_INSTANCES] ?? (scope[LIVE_INSTANCES] = new WeakMap<object, number>())
  const key = (ctx.root as object | undefined) ?? (ctx as unknown as object)
  if ((slots.get(key) ?? 0) > 0) return false
  slots.set(key, 1)
  ctx.effect(() => () => {
    slots.set(key, Math.max(0, (slots.get(key) ?? 1) - 1))
  }, 'report-ledger: single instance')
  return true
}

/** The live services a mounted host half owns. */
export interface HostHalf {
  readonly service: ReportService
  readonly peers: PeerService
}

/**
 * Run `mount` once this composition has no other mounted host half, queueing otherwise.
 *
 * Both the release row and the developer-mode row go through this, so exactly one
 * instance owns the ledger's mutex table per composition. A second row waits instead
 * of throwing: a rejected activation is not retried by a recomposition that does not
 * touch its own row, which would leave two rows enabled and neither mounted. Waiting
 * makes the switch self-healing in either click order.
 * @param ctx - the plugin context, used to release the slot and to cancel a wait.
 * @param mount - the half to mount once the slot is free.
 */
export function mountWhenFree(ctx: Context, mount: () => void): void {
  if (claimInstanceSlot(ctx)) {
    mount()
    return
  }
  ctx.logger?.warn?.('report-ledger: another row of report-ledger is already mounted; '
    + 'this row waits until it is disabled (keep exactly one of the release and developer-mode rows on).')
  const timer = setInterval(() => {
    if (!claimInstanceSlot(ctx)) return
    clearInterval(timer)
    mount()
  }, INSTANCE_WAIT_MS)
  ctx.effect(() => () => clearInterval(timer), 'report-ledger: wait for the single-instance slot')
}

/**
 * Apply the host half: the release plugin's entry point.
 * @param ctx - the plugin context (`tools`, `systemPrompt`, `agents` injected).
 * @param config - resolved plugin config from the composition row.
 */
export function apply(ctx: Context, config?: Config): void {
  mountWhenFree(ctx, () => { mountHost(ctx, config) })
}

/**
 * Mount the host half — services, model tools, the delivery pump, the read endpoints
 * and the prompt sections — and hand the live services back.
 *
 * Developer mode is deliberately NOT part of this function: it lives in the add-on
 * bundle under `dev/bundle/`, which calls this function and installs its own tools on
 * the returned services. A release artifact therefore carries no developer-mode code
 * at all, and an installed package has no roster to enable it with.
 * @param ctx - the plugin context (`tools`, `systemPrompt`, `agents` injected).
 * @param config - resolved plugin config from the composition row.
 * @returns the live services, for a caller that mounts an extension on top.
 */
export function mountHost(ctx: Context, config?: Config): HostHalf {
  const host = buildHost(ctx)
  const service = new ReportService(host)
  const peers = new PeerService(buildPeerHost(ctx, host), config?.maxPeersPerAgent ?? DEFAULT_MAX_PEERS)
  // Automatic reclamation was removed. An old composition may still carry the
  // field; ignoring it silently would leave the operator believing cleanup is on.
  const legacyReclaim = (config?.worktree as Record<string, unknown> | undefined)?.reclaim
  if (legacyReclaim !== undefined) {
    ctx.logger?.warn?.('report-ledger: worktree.reclaim is no longer supported and is ignored; '
      + 'checkouts are only removed by an explicit close with remove-if-clean.')
  }
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
    // A resident id is exactly what the corpus cache cannot have seen yet, so
    // drop it before the tab can ask for that session's timeline.
    host.invalidateSessionListing?.()
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
      // A contained failure's detail goes here, never into the response.
      log: (message: string) => { ctx.logger?.warn?.(message) },
    }
    scoped.effect(() => {
      // `register` refuses a duplicate (kind, path) by throwing, and a half
      // registered route set is worse than none: the tab would answer for two
      // endpoints and 404 the third until the process restarts. Unwind whatever
      // did register, in reverse, before letting the fiber report the failure.
      const registered: (() => void)[] = []
      try {
        registered.push(webServer.register({ kind: 'exact', path: REPORT_PATH, handler: createReportHandler(deps) as never }))
        registered.push(webServer.register({ kind: 'exact', path: TIMELINE_PATH, handler: createTimelineHandler(deps) as never }))
        registered.push(webServer.register({ kind: 'exact', path: WORKTREES_PATH, handler: createWorktreesHandler(deps) as never }))
      } catch (error) {
        for (const dispose of registered.reverse()) dispose()
        throw error
      }
      return () => {
        for (const dispose of registered.reverse()) dispose()
      }
    }, 'report-ledger: read endpoints')
  })

  // Catch-up for the sessions `agent/created` can never report.
  //
  // That event fires while a session is created or resumed, so a hand-off the
  // ledger queued before this row mounted has no wake-up waiting for it: the
  // recipient is already resident, is never announced again, and the pending set
  // would sit there until its next resume. One deferred sweep closes the gap. It
  // is deferred to a microtask so plugin load never waits on ledger I/O.
  //
  // The sweep is ONE ledger pass for every live session rather than one pass per
  // session. The reports are the same for all of them; only the set of waiting
  // sessions differs. A per-session sweep on a long-lived deployment therefore
  // cost `sessions × reports` document reads before producing a single delivery,
  // which is the shape that made a large ledger feel stuck. Failures are logged,
  // never thrown, and the pass is idempotent: pending is derived from the transfer
  // path, so a session with nothing queued costs nothing beyond the digest scan.
  queueMicrotask(() => {
    let live: readonly { readonly id: unknown }[]
    try {
      live = ctx.agents.list()
    } catch (error) {
      // The registry read is the only synchronous step here; failing it must not
      // become an uncaught microtask exception during plugin load.
      ctx.logger?.warn?.(`report-ledger: catch-up sweep could not list live sessions: ${String(error)}`)
      return
    }
    const sessions: string[] = []
    for (const agent of live) {
      const sessionId = String(agent.id ?? '')
      if (sessionId !== '') sessions.push(sessionId)
    }
    if (sessions.length === 0) return
    void service.flushSessions(sessions).catch((error: unknown) => {
      ctx.logger?.warn?.(`report-ledger: catch-up delivery failed: ${String(error)}`)
    })
  })

  if ((config?.announceToAgent ?? true) === false) return { service, peers }

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

  return { service, peers }
}
