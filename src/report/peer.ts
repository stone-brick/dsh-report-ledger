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
 * Being a root session says nothing about the CAPABILITIES it runs with, and a
 * root session is born with none: an agent published without joining a
 * composition sees the empty global layer — no preset tools and none of the
 * preset prompt sections — and an agent created without a model route cannot
 * resolve `{{model}}` during prompt assembly, so its very first turn dies at
 * step 1. Both halves are the host adapter's job, which is why
 * {@link PeerHost.createPeer} receives the starter's session id: the peer is
 * composed from the live starter (its model route, its composition) instead of
 * being left to resolve against nothing. Both failures are also completely
 * silent unless someone looks, which is why {@link PeerHost.confirmPeer} exists:
 * `delivered` certifies that a digest reached a live agent, and must never be
 * reported as "someone is working".
 *
 * Creation and conversation are kept separate on purpose: this module only
 * creates, records, and (optionally) observes the peer's first turn. Handing the
 * peer its first task is the caller's job, and the caller does it with a report —
 * so the assignment lands in the ledger, the peer is woken by the delivery, and
 * the peer's later contributions turn that one report into the conversation
 * thread.
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
   * @param input - the session id, the starter it is composed from, and the inherited directory.
   * @returns the new session id and its wake channel.
   */
  createPeer(input: { sessionId: string; startedBy: string; cwd?: string }): Promise<{ id: string; steer(message: OutboundMessage): void }>
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
    this.#maxPeers = maxPeers > 0 ? maxPeers : DEFAULT_MAX_PEERS
  }

  /** Assemble the shared roster inputs for one caller. */
  async #inputs(self: string): Promise<Omit<RosterInput, 'scope' | 'limit'>> {
    const [records, reports, peers] = await Promise.all([
      this.#host.listSessionRecords(),
      this.#host.listReports(),
      readPeers(),
    ])
    return {
      self,
      records,
      liveIds: this.#host.liveIds(),
      peers,
      reports,
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
    let count = 0
    for (const peer of peers) if (peer.startedBy === self) count++
    return count
  }

  /**
   * Whether the caller holds a channel to a session.
   * @param self - the caller's session id.
   * @param target - the session being addressed.
   * @returns true when the relationship grants a direct channel.
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
    const name = input.name?.trim()
    if (name !== undefined && name.length > 60) throw new Error('report-ledger: peer_start name must be 60 characters or fewer')

    const already = await this.startedCount(self)
    if (already >= this.#maxPeers) {
      throw new Error(
        `report-ledger: this session already started ${already} peers (limit ${this.#maxPeers}); `
        + 'reuse an existing peer, or report to one you already hold a channel to instead of opening another',
      )
    }

    const cwd = this.#host.selfCwd(self)
    const sessionId = `session-${randomUUID()}`
    // The starter is named, not just recorded: the adapter composes the peer from
    // that live session, because a root agent has no composition or route of its own.
    const created = await this.#host.createPeer({ sessionId, startedBy: self, ...(cwd === undefined ? {} : { cwd }) })

    await appendPeer({
      sessionId: created.id,
      startedBy: self,
      startedAt: Date.now(),
      ...(name === undefined ? {} : { name }),
      ...(cwd === undefined ? {} : { cwd }),
    })

    return {
      sessionId: created.id,
      started: already + 1,
      ...(name === undefined ? {} : { name }),
      ...(cwd === undefined ? {} : { cwd }),
    }
  }
}
