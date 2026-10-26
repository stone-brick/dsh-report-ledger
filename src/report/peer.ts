/**
 * Starting and discovering peer agents.
 *
 * A peer is deliberately created as an **independent root session**, not a
 * delegated child. That is what makes it a partner rather than a subordinate: it
 * owns its own lifecycle, it is not charged against the delegation depth budget,
 * it is visible in the workspace session list, and above all it outlives the turn
 * that started it. The harness's delegation seam cannot express that
 * relationship, so the roster log records it, and the roster log is what makes
 * the peer addressable later by the agent that started it.
 *
 * "Visible in the workspace session list" is the part that does not happen by
 * itself. A workspace group is populated from two sources only: the one-time
 * history bootstrap, which runs when the registry is first initialized and never
 * again, and an explicit attach at session creation. A GUI-created session takes
 * the second route because it names its workspace in the create request; a peer
 * does not, because a fresh agent's creation metadata carries a `cwd` and
 * nothing else. A peer whose directory matches a registered workspace is
 * therefore NOT in that workspace's accounting, and the browser renders it under
 * the ungrouped bucket — permanently, since nothing revisits the question later.
 * {@link PeerHost.attachToWorkspace} is how this module closes that gap: the peer
 * is created first (its header is what the registry validates), then registered.
 * Registration is best-effort and reported, never fatal: a peer that exists but
 * is ungrouped is still a working partner, and refusing to create one over a
 * cosmetic bookkeeping miss would be the worse failure.
 *
 * Being a root session says nothing about the CAPABILITIES it runs with, and a
 * root session is born with none: an agent published without joining a
 * composition sees the empty global layer — no preset tools and none of the
 * preset prompt sections — and an agent created without a model route cannot
 * resolve `{{model}}` during prompt assembly, so its very first turn dies at
 * step 1. Both halves are the host adapter's job, which is why
 * {@link PeerHost.createPeer} receives the starter's session id: the peer is
 * composed from the live starter (its model route, its composition, and its
 * permission state) instead of being left to resolve against nothing. Both
 * failures are also completely silent unless someone looks, which is why
 * {@link PeerHost.confirmPeer} exists: `delivered` certifies that a digest
 * reached a live agent, and must never be reported as "someone is working".
 *
 * The permission half deserves its own sentence because it is the one a reader
 * is most likely to assume: a peer pinned to the deployment default instead of
 * its starter's state looks perfectly healthy in every other field, and shows up
 * only as an approval prompt in a session nobody is watching. Inheriting it is
 * not the same as widening it — the state is written onto the peer's own log, so
 * the peer keeps its own authority, the user can read where it came from, and a
 * later switch in that session still wins.
 *
 * Creation and conversation are kept separate on purpose: this module only
 * creates, records, and (optionally) observes the peer's first turn. Handing the
 * peer its first task is the caller's job, and the caller does it with a report —
 * so the assignment lands in the ledger, the peer is woken by the delivery, and
 * the peer's later contributions turn that one report into the conversation
 * thread.
 *
 * The budget is a lifetime quota, not a concurrency limit: {@link
 * DEFAULT_MAX_PEERS} bounds how many peers one session may ever start, and the
 * roster log is the count. A peer that is no longer resident — or that died on
 * its first turn — still holds its slot exactly as its log line says, and there
 * is no retire tool. Recovering a slot is therefore a deliberate human act: back
 * up `$DSH_HOME/report-ledger/peers.jsonl`, delete the lines of peers that are
 * truly finished, and the budget is available again.
 *
 * @module dsh-report-ledger/report/peer
 */

import { randomUUID } from 'node:crypto'
import type { OutboundMessage } from './deliver.ts'
import { appendPeer, buildRoster, holdsChannelTo, readPeers, type PeerRow, type RosterInput } from './roster.ts'
import type { SessionRecordLike } from './timeline.ts'
import type { ReportFrontMatter } from './types.ts'

/** Default cap on peers one session may start. */
export const DEFAULT_MAX_PEERS = 8

/** How long a caller waits for evidence about a peer's first turn, by default. */
export const DEFAULT_RECEIPT_MS = 1500

/**
 * What actually happened to the peer's first turn.
 *
 * This exists because the delivery vocabulary cannot answer the question a
 * starter is really asking. `delivered` means the digest reached a live agent;
 * it is silent about whether a turn opened, and a turn that opens and dies at
 * step 1 (an unresolvable prompt variable, an unregistered route) produces
 * exactly the same `delivered` and exactly the same `live` roster row as a peer
 * that is happily working. Every kind below is an OBSERVATION with a bound on it,
 * not a promise.
 */
export interface PeerReceipt {
  /**
   * - `running` — a turn was open and still open when the observation window closed.
   * - `settled` — a turn ran and finished inside the window.
   * - `failed` — a turn ran and ended in error inside the window ({@link PeerReceipt.error}).
   * - `unstarted` — nothing was ever appended after the delivery: no turn opened.
   */
  readonly kind: 'running' | 'settled' | 'failed' | 'unstarted'
  /** The last turn's stop reason, when one settled (`completed`, `aborted`, `blocked`, …). */
  readonly reason?: string
  /** The failing turn's message, when it ended in error. */
  readonly error?: string
}

/**
 * The permission state a host captured for a peer at creation.
 *
 * Every field is optional because each knob is owned by a separate optional
 * service: a deployment can compose the sandbox policy and not the presets, and
 * the host reports exactly what it could read rather than guessing. The state is
 * a copy, not a live view — a peer's own later switch is its business, and the
 * starter's later switches are the starter's.
 */
export interface PeerPermission {
  /** The inherited preset identity, when it names a configured preset (or live Auto). */
  readonly preset?: string
  /** The inherited sandbox mode. */
  readonly sandbox?: string
  /** The inherited approval policy. */
  readonly approval?: string
}

/** A freshly created peer. */
export interface StartedPeer {
  /** Its session id — the address to report to. */
  readonly sessionId: string
  /** The display name supplied by the starter, when any. */
  readonly name?: string
  /** The working directory it inherited. */
  readonly cwd?: string
  /** How many peers the starter now owns, including this one. */
  readonly started: number
  /**
   * The permission state the peer inherited, when the host captured one.
   *
   * Reported rather than assumed because the failure it guards against is silent:
   * a peer pinned to the deployment default looks healthy everywhere else and
   * surfaces only later, as an approval prompt in a session nobody is watching.
   * Absent means the host answers no question about permissions at all.
   */
  readonly permission?: PeerPermission
  /**
   * What became of the attempt to put the peer in a workspace group.
   *
   * Absent means this host implements no registration at all, so there are no
   * groups to be in and nothing to report. `no-workspace` means a host does
   * implement it and answered that nothing owns the peer's directory, which is
   * the legitimate case for a peer started in a checkout nobody registered.
   */
  readonly workspace?: WorkspaceRegistration
}

/**
 * The outcome of registering one peer session with the workspace registry.
 *
 * `outcome` is deliberately three-valued rather than a boolean: "this
 * deployment has no workspace feature", "this directory is not a workspace" and
 * "the registration was attempted and failed" are different facts, and only the
 * last one is a defect. Collapsing them would turn a healthy ungrouped peer into
 * a false alarm on every deployment without the feature.
 */
export interface WorkspaceRegistration {
  /** What happened. Only `failed` is a defect; see {@link WorkspaceRegistration.warning}. */
  readonly outcome: 'registered' | 'no-workspace' | 'failed'
  /** The workspace title or path, when one was matched. */
  readonly workspace?: string
  /** The failure's text, when `outcome` is `failed`. */
  readonly warning?: string
}

/** The harness capabilities peer management consumes. */
export interface PeerHost {
  /**
   * The caller's working directory, used as the peer's.
   * @param sessionId - caller session id.
   * @returns the directory, when the session header records one.
   */
  selfCwd(sessionId: string): string | undefined
  /**
   * Session ids resident right now.
   * @returns the live set.
   */
  liveIds(): ReadonlySet<string>
  /**
   * Every known session record.
   * @returns the records.
   */
  listSessionRecords(): Promise<readonly SessionRecordLike[]>
  /**
   * Resolve display titles.
   * @param ids - session ids.
   * @returns a title per session that has one.
   */
  readTitles(ids: readonly string[]): Promise<ReadonlyMap<string, string>>
  /**
   * Every report digest.
   * @returns the digests.
   */
  listReports(): Promise<readonly ReportFrontMatter[]>
  /**
   * Create one independent agent on a caller-supplied session id.
   *
   * `startedBy` is not decoration: a fresh root agent has no composition and no
   * model route of its own, so the adapter resolves both from the live starter
   * session named here. An adapter that ignores it produces a peer whose first
   * turn fails immediately.
   *
   * The same argument covers the peer's permission state, and the failure there is
   * quieter: composition and route mistakes kill the first turn, while a peer that
   * keeps the deployment's default preset merely runs under a different authority
   * than the session that opened it — inviting the user to approve, in a session
   * they are not looking at, work the starter could already do. {@link
   * PeerService.start} therefore hands the starter's id to every implementation on
   * the assumption that it is used for all of these, not just for the route.
   * @param input - the session id, the starter it is composed from, and the inherited directory.
   * @returns the new session id, its wake channel, and the permission state it inherited.
   */
  createPeer(input: { sessionId: string; startedBy: string; cwd?: string }): Promise<{ id: string; steer(message: OutboundMessage): void; permission?: PeerPermission }>
  /**
   * Put a freshly created peer session into the workspace group that owns its
   * directory, so the GUI lists it under that workspace instead of leaving it
   * ungrouped forever.
   *
   * Optional, and that is the honest shape of the dependency: a deployment may
   * compose no workspace registry at all (the headless profile does not), and
   * there the groups do not exist and this hook is simply absent. Implementations
   * must resolve the peer's directory the same way the registry does — by
   * canonical real path, not by string equality — or a registration attributed to
   * the wrong workspace is refused. They must also never throw: the outcome is
   * the report.
   *
   * Called after {@link PeerHost.createPeer}, because the registry validates a
   * session against the `cwd` recorded in its durable header and that header does
   * not exist until the agent does.
   * @param input - the peer session, and the directory it was created with.
   * @returns the registration outcome.
   */
  attachToWorkspace?(input: { sessionId: string; cwd?: string }): Promise<WorkspaceRegistration>
  /**
   * Observe what became of a peer's first turn, within a bound.
   *
   * Called after the assignment has been delivered, so it answers the question
   * `delivered` cannot: did a turn actually open, is it still running, or did it
   * die — and if it died, why.
   * @param sessionId - the peer session to observe.
   * @param timeoutMs - how long a still-running turn is awaited before it is reported as running.
   * @returns the observation, or `undefined` when the peer is not resident at all.
   */
  confirmPeer(sessionId: string, timeoutMs: number): Promise<PeerReceipt | undefined>
}

/** Options for {@link PeerService.start}. */
export interface StartPeerInput {
  /** The task or purpose the peer is being opened for. */
  readonly task: string
  /** Optional display name. */
  readonly name?: string
  /**
   * Directory to start the peer in, when it should not inherit the starter's.
   *
   * A caller that allocated a working tree passes its path here, which is what
   * turns the peer's isolation from a claim into a fact: the peer's `cwd` is its
   * own checkout from its very first turn.
   */
  readonly cwd?: string
}

/** The peer service. */
export class PeerService {
  readonly #host: PeerHost
  readonly #maxPeers: number

  /**
   * @param host - harness capabilities.
   * @param maxPeers - cap on peers one session may start.
   */
  constructor(host: PeerHost, maxPeers: number = DEFAULT_MAX_PEERS) {
    this.#host = host
    this.#maxPeers = typeof maxPeers === 'number' && Number.isInteger(maxPeers) && maxPeers > 0
      ? maxPeers
      : DEFAULT_MAX_PEERS
  }

  /** Assemble the shared roster inputs for one caller. */
  async #inputs(self: string): Promise<Omit<RosterInput, 'scope' | 'limit'>> {
    // One unreadable source must not take the whole roster down: a broken session
    // listing still leaves "the peers I started" worth showing, and vice versa.
    const [records, reports, peers] = await Promise.allSettled([
      this.#host.listSessionRecords(),
      this.#host.listReports(),
      readPeers(),
    ])
    return {
      self,
      records: records.status === 'fulfilled' ? records.value : [],
      liveIds: this.#host.liveIds(),
      peers: peers.status === 'fulfilled' ? peers.value : [],
      reports: reports.status === 'fulfilled' ? reports.value : [],
      titles: new Map(),
    }
  }

  /**
   * List the sessions this caller can see.
   * @param self - the caller's session id.
   * @param options - scope and row cap.
   * @returns the roster rows.
   */
  async roster(self: string, options: { scope?: 'related' | 'live' | 'all'; limit?: number } = {}): Promise<PeerRow[]> {
    const scope = options.scope ?? 'related'
    const limit = options.limit === undefined || options.limit <= 0 ? 40 : Math.min(options.limit, 200)
    const inputs = await this.#inputs(self)
    const rows = buildRoster({ ...inputs, scope, limit })
    // Titles are resolved only for the rows that survive the cut.
    if (rows.length === 0) return rows
    const titles = await this.#host.readTitles(rows.map((row) => row.sessionId))
    return rows.map((row) => {
      const title = titles.get(row.sessionId)
      return title === undefined ? row : { ...row, title }
    })
  }

  /**
   * How many peers one session has already started.
   * @param self - the caller's session id.
   * @returns the count.
   */
  async startedCount(self: string): Promise<number> {
    const peers = await readPeers()
    // Count distinct sessions, not log lines: a duplicated line (the documented
    // manual-recovery path edits this file) must not silently consume a slot.
    return new Set(peers.filter((peer) => peer.startedBy === self).map((peer) => peer.sessionId)).size
  }

  /**
   * Classify the relationship for display and discovery.
   *
   * This is **not** an authorization check before delivery: report_send and
   * report_cc accept any session id by design, because reaching out through the
   * ledger is how contact is established. Nothing in the delivery path consults
   * this predicate; it answers the narrower question the roster shows.
   * @param self - the caller's session id.
   * @param target - the session being addressed.
   * @returns true when the relationship classifier places them in contact.
   */
  async holdsChannel(self: string, target: string): Promise<boolean> {
    return holdsChannelTo(await this.#inputs(self), target)
  }

  /**
   * Observe what became of a peer's first turn.
   *
   * Not a status check: it is the honest answer to "did the thing I just handed
   * this peer actually start working?" — the question a bare `delivered` cannot
   * answer. Call it after the assignment report has been delivered.
   * @param sessionId - the peer session to observe.
   * @param timeoutMs - how long a still-running turn is awaited before being reported as running.
   * @returns the observation, or `undefined` when the peer is not resident.
   */
  async receipt(sessionId: string, timeoutMs: number = DEFAULT_RECEIPT_MS): Promise<PeerReceipt | undefined> {
    return await this.#host.confirmPeer(sessionId, timeoutMs)
  }

  /**
   * Register one freshly created peer with the workspace registry, if the
   * deployment has one, and never let the attempt be fatal.
   *
   * Three outcomes are possible and only one is a defect: no hook means there are
   * no groups to join, an unmatched directory is a legitimate ungrouped peer, and
   * anything that throws or answers with an unusable shape is reported back as a
   * failure for the caller to see.
   * @param sessionId - the peer session that now exists.
   * @param cwd - the directory it was created in, when one was inherited or supplied.
   * @returns the outcome, or `undefined` when this host implements no registration.
   */
  async #register(sessionId: string, cwd: string | undefined): Promise<WorkspaceRegistration | undefined> {
    if (this.#host.attachToWorkspace === undefined) return undefined
    try {
      const result = await this.#host.attachToWorkspace({ sessionId, ...(cwd === undefined ? {} : { cwd }) })
      if (result === null || typeof result !== 'object' || typeof result.outcome !== 'string') {
        return { outcome: 'failed', warning: `the workspace host answered with ${JSON.stringify(result)}` }
      }
      return result
    } catch (error) {
      return { outcome: 'failed', warning: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Open one independent peer session.
   *
   * The peer is recorded before it is returned, so the relationship survives even
   * if the caller's next step fails. Nothing here disposes the handle: the
   * handle's `dispose()` removes the session from the store, which is exactly
   * wrong for a partner that must outlive this turn.
   * @param self - the caller's session id.
   * @param input - the task and optional name.
   * @returns the created peer.
   * @throws when the task is empty, the name is unusable, or the cap is reached.
   */
  async start(self: string, input: StartPeerInput): Promise<StartedPeer> {
    const task = input.task.trim()
    if (task === '') throw new Error('report-ledger: peer_start requires a non-empty task')
    const name = input.name?.trim() || undefined
    if (name !== undefined && [...name].length > 60) throw new Error('report-ledger: peer_start name must be 60 characters or fewer')

    const already = await this.startedCount(self)
    if (already >= this.#maxPeers) {
      throw new Error(
        `report-ledger: this session has already started ${already} peers (lifetime limit ${this.#maxPeers}, `
        + 'counting peers that are no longer resident or that died on their first turn); reuse an existing peer by '
        + 'sending it a report instead of opening another, or recover a slot as a human act: back up '
        + '$DSH_HOME/report-ledger/peers.jsonl, then delete the lines of peers that are finished',
      )
    }

    // The starter's own directory unless the caller supplies one — a caller that
    // allocated a working tree points the peer at it, so the peer works in its
    // own checkout rather than in the starter's.
    const cwd = input.cwd ?? this.#host.selfCwd(self)
    const sessionId = `session-${randomUUID()}`
    // The starter is named, not just recorded: the adapter composes the peer from
    // that live session, because a root agent has no composition, route, or standing
    // permission state of its own.
    const created = await this.#host.createPeer({ sessionId, startedBy: self, ...(cwd === undefined ? {} : { cwd }) })

    // Registration follows creation, never precedes it: the registry validates
    // the session against the `cwd` in its durable header, which the agent does
    // not have until it exists. A failure here is reported and survived — the
    // peer is real, it is attributed, and the caller can still address it.
    //
    // The catch is not redundant with the host contract. The contract says an
    // implementation reports failures as outcomes rather than throwing, and this
    // module is the only place that promise can be enforced: a registry that
    // throws for an unrelated reason (a failing storage write, a path that
    // vanished between create and attach) would otherwise abort a peer creation
    // that has already succeeded and already been charged against the cap.
    const workspace = await this.#register(created.id, cwd)

    try {
      await appendPeer({
        sessionId: created.id,
        startedBy: self,
        startedAt: Date.now(),
        ...(name === undefined ? {} : { name }),
        ...(cwd === undefined ? {} : { cwd }),
      })
    } catch (error) {
      // The peer is already live: the adapter created it before this record was
      // attempted. A caller must be able to address what it has already paid for,
      // and a worktree caller must not roll the checkout back out from under it.
      // Tag the failure so tools.ts can tell this apart from "no peer exists".
      const reason = error instanceof Error ? error.message : String(error)
      const failure = new Error(
        `report-ledger: peer ${created.id} was created, but its roster record could not be written (${reason}). `
        + 'The peer is alive and is NOT counted against the lifetime budget; address it later with report_send '
        + `(to=${created.id}) and keep any checkout it was given.`,
      ) as Error & { peerCreated?: boolean; sessionId?: string }
      failure.peerCreated = true
      failure.sessionId = created.id
      throw failure
    }

    return {
      sessionId: created.id,
      started: already + 1,
      ...(name === undefined ? {} : { name }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(created.permission === undefined ? {} : { permission: created.permission }),
      ...(workspace === undefined ? {} : { workspace }),
    }
  }
}
