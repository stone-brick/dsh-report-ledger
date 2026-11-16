/**
 * Delivery: getting a report digest into the right agent's context.
 *
 * The harness's own delegation seam only delivers between exact neighbours — a
 * direct child or a direct parent that is currently resident — and it has no
 * durable mailbox, so a message to an absent parent is refused rather than held.
 * This module provides the missing half:
 *
 *  - **Any live agent is addressable.** It uses the `Agent`'s own
 *    `steer`/`inject` entries, which take a message and no authority, rather than
 *    the adjacency-checked delegation path. That is what makes a carbon copy to a
 *    non-adjacent peer (or a sibling) possible at all.
 *  - **An absent recipient is queued, not refused.** Nothing extra is stored for
 *    that: a recipient is pending exactly when the transfer path records a
 *    hand-off to it but no arrival. The audit trail *is* the mailbox, so it
 *    survives a restart for free and cannot disagree with the history.
 *  - **Wake policy is explicit.** An addressed report steers (an idle target
 *    starts a turn), while a carbon copy injects context without waking anyone.
 *
 * @module dsh-report-ledger/report/deliver
 */

import { randomUUID } from 'node:crypto'
import type { DeliveryMode, ReportFrontMatter, RouteHop } from './types.ts'

/**
 * A message handed to an agent inbox. Structurally a `UserMessage`.
 *
 * `source.kind` is the producer's own name, not a catch-all. DSH's session
 * format v4 retired the shared `kind: 'plugin'` wrapper: native admission
 * refuses it outright (`format v4 message requires a producer-owned source
 * kind`), so a delivery written with it kills the recipient's first turn at
 * step 1 — before any model call, which is why the failure used to look like a
 * silent hand-off. The value below is the same string the v3→v4 migration
 * derives for this plugin (`plugin:<id>`), so messages written before and
 * after this change name one producer.
 */
export interface OutboundMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly source: {
    readonly kind: 'plugin:report-ledger'
    readonly form: 'relay'
  }
}

/** The slice of a live agent this module needs. */
export interface AgentLike {
  /** Session id of the agent. */
  readonly id: string
  /** Queue steered content for the nearest step, waking an idle driver. */
  steer(message: OutboundMessage): void
  /** Queue model-facing context without waking the driver. */
  inject(message: OutboundMessage): void
}

/** What became of one digest after it was addressed to a session. */
export type DeliveryState = 'absent' | 'inbox' | 'taken' | 'stranded' | 'unknown'

/**
 * Every delivery message id starts with this prefix.
 *
 * The id is the ledger's half of at-most-once delivery: it is derived from the
 * hand-off that caused it, so a retry after a crash names the same message the
 * recipient may already hold. The prefix is what lets a later diagnostic pick
 * these messages back out of a session history without re-deriving every id.
 */
export const DELIVERY_ID_PREFIX = 'report-ledger:'

/** Whether a message id names a digest this plugin delivered. */
export function isDeliveryId(id: string): boolean {
  return id.startsWith(DELIVERY_ID_PREFIX)
}

/** The host capability this module consumes. */
export interface DeliveryHost {
  /**
   * Resolve one live agent.
   * @param sessionId - target session id.
   * @returns the live agent, or `undefined` when it is not resident.
   */
  getAgent(sessionId: string): AgentLike | undefined
  /**
   * Whether the target already holds the digest under this id.
   *
   * Optional because it is supplied by the live host only: a harness without
   * session persistence, or a test transport, degrades to plain delivery. When
   * present it is the crash-recovery half of idempotent delivery — a re-send
   * whose id is already in the inbox or history records the arrival the crashed
   * attempt never recorded, instead of delivering the same digest twice.
   * @param targetId - recipient session id.
   * @param messageId - the hand-off's stable message id.
   * @returns true when the recipient already has it.
   */
  holds?(targetId: string, messageId: string): Promise<boolean>
}

/** Where one hand-off went. */
export interface DeliveryOutcome {
  /** Target session id. */
  readonly targetId: string
  /**
   * `delivered` when it reached a live agent; `queued` when it is held.
   *
   * Read narrowly: this certifies ARRIVAL, not work. An agent that is resident
   * accepts the digest and the inbox splice it causes is durable, but whether a
   * turn then opens — and whether that turn survives its first step — is a
   * separate question this outcome deliberately does not answer. Anything that
   * needs the stronger claim must observe it (`PeerService.receipt` is that
   * observation for a peer's first turn).
   */
  readonly status: 'delivered' | 'queued'
  /**
   * True when the recipient already held this hand-off and it was recorded
   * without steering again: the recovery path for a crash between `steer` and
   * the `delivered` hop.
   */
  readonly recovered?: boolean
}

/**
 * Build the message that carries a digest into a recipient's context.
 *
 * The text is intentionally compact: it is a transport notice, not the report.
 * The body stays in the ledger and is opened on demand, which is what keeps a
 * long-horizon collaboration affordable in context.
 * @param front - the report digest.
 * @param path - absolute path of the report document, offered as the on-demand body.
 * @param mode - how this recipient received it.
 * @param id - stable message id for this hand-off; random only when a caller that
 * cannot name one still needs a message.
 * @returns the outbound message.
 */
export function renderDigest(front: ReportFrontMatter, path: string, mode: DeliveryMode, id: string = randomUUID()): OutboundMessage {
  const audience = mode === 'wakeup' ? 'addressed to you' : 'copied to you'
  const lines = [
    `[report ${front.report} — ${audience}] ${front.subject}`,
    `from=${front.from} status=${front.status} hops=${front.hops} reads=${front.reads} authors=${front.authors.length}`,
  ]
  if (front.to.length > 0) lines.push(`to=${front.to.join(',')}`)
  if (front.cc.length > 0) lines.push(`cc=${front.cc.join(',')}`)
  if (front.task !== undefined) lines.push(`task=${front.task}`)
  if (front.artifacts.length > 0) lines.push(`artifacts=${front.artifacts.join(', ')}`)
  lines.push(`body=${path}`)
  lines.push(`Read the body on demand; use report_list to see other reports and report_ack to close your loop.`)
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: lines.join('\n') }],
    source: { kind: 'plugin:report-ledger', form: 'relay' },
  }
}

/**
 * The stable message id of one hand-off to one target.
 *
 * Derived from the transfer path, not from wall-clock randomness: the last hop
 * that addressed the target IS the hand-off, so its index is a name that every
 * retry of the same obligation reproduces. A later send or transfer creates a
 * new hand-off and therefore a new id — which is correct, because it carries new
 * information for the recipient. The index is the hop's position in the path,
 * which is append-only for the life of the report.
 * @param report - report identifier.
 * @param hops - the complete transfer path, oldest first.
 * @param target - the recipient this hand-off is owed to.
 * @returns the message id; ends in `:-1` only if the target was never addressed,
 * which callers derive from {@link pendingTargets} and so never pass.
 */
export function deliveryId(report: string, hops: readonly RouteHop[], target: string): string {
  let handoff = -1
  hops.forEach((hop, index) => {
    if (addressedBy(hop, target)) handoff = index
  })
  return `${DELIVERY_ID_PREFIX}${report}:${handoff}`
}

/** Whether one hop created the hand-off the target currently holds. */
function addressedBy(hop: RouteHop, target: string): boolean {
  if (!hop.to.includes(target)) return false
  return hop.action === 'sent'
    || hop.action === 'cc'
    || hop.action === 'forwarded'
    || hop.action === 'copied'
    || hop.action === 'transferred'
}

/**
 * Deliver one digest to every target.
 *
 * Transport only: this function never touches the ledger. The caller records the
 * arrival hops, which keeps the audit trail's writer in one place and lets the
 * same transport serve a first hand-off and a deferred one.
 *
 * **Idempotent when the host can answer.** Each delivery carries a stable id
 * (see {@link deliveryId}); if the host reports the recipient already holds that
 * id, the arrival is reported without steering again. That is what makes a crash
 * between `steer` and the `delivered` hop harmless: the retry reconciles instead
 * of duplicating.
 * @param host - agent resolution, and the optional holds probe.
 * @param front - the report digest.
 * @param path - absolute path of the report document.
 * @param targets - recipient session ids.
 * @param mode - wake policy for this hand-off.
 * @param ids - the stable message id per target, when the caller has the hop path.
 * @returns one outcome per distinct target.
 */
export async function deliver(
  host: DeliveryHost,
  front: ReportFrontMatter,
  path: string,
  targets: readonly string[],
  mode: DeliveryMode,
  ids: Readonly<Record<string, string>> = {},
): Promise<DeliveryOutcome[]> {
  const outcomes: DeliveryOutcome[] = []
  const seen = new Set<string>()
  for (const targetId of targets) {
    if (targetId === '' || seen.has(targetId)) continue
    seen.add(targetId)
    const agent = host.getAgent(targetId)
    if (agent === undefined) {
      outcomes.push({ targetId, status: 'queued' })
      continue
    }
    const id = ids[targetId] ?? randomUUID()
    if (host.holds !== undefined) {
      let held = false
      try {
        held = await host.holds(targetId, id)
      } catch {
        // A probe that cannot answer must not turn delivery into a refusal: the
        // durable pending set is still the authority, and a duplicate digest is
        // cheaper than a lost hand-off.
        held = false
      }
      if (held) {
        outcomes.push({ targetId, status: 'delivered', recovered: true })
        continue
      }
    }
    const message = renderDigest(front, path, mode, id)
    if (mode === 'wakeup') agent.steer(message)
    else agent.inject(message)
    outcomes.push({ targetId, status: 'delivered' })
  }
  return outcomes
}

/**
 * Derive the set of recipients still owed a delivery.
 *
 * Pending is computed from the audit trail instead of a separate queue: every
 * hop that addressed a target counts as a hand-off, every `delivered` hop counts
 * as an arrival, and the difference is what remains. Deriving it this way means
 * the mailbox is exactly as durable as the history, and a hand-edited ledger
 * stays self-consistent.
 * @param hops - the complete transfer path of one report.
 * @returns session ids that were addressed but have no recorded arrival.
 */
export function pendingTargets(hops: readonly RouteHop[]): string[] {
  // Ordered, not set-difference: a hand-off is owed until a LATER arrival for
  // that target. A recipient delivered once and then addressed again while
  // absent has a new, unanswered hand-off, so it must become pending again —
  // computing "addressed minus ever-arrived" would silently drop that re-send,
  // which is the exact durable-mailbox promise this derivation exists to keep.
  const owed = new Set<string>()
  for (const hop of hops) {
    if (hop.action === 'sent' || hop.action === 'cc' || hop.action === 'forwarded' || hop.action === 'copied') {
      for (const target of hop.to) owed.add(target)
    }
    // A transfer discharges the obligation of the session that handed it on and
    // creates one for the session that took it. It is deliberately NOT recorded as
    // an arrival: nobody has received anything, so a delivery is still owed — just
    // by someone else.
    if (hop.action === 'transferred') {
      if (hop.from !== undefined) owed.delete(hop.from)
      for (const target of hop.to) owed.add(target)
    }
    if (hop.action === 'delivered') {
      for (const target of hop.to) owed.delete(target)
    }
  }
  return [...owed]
}

/**
 * The wake policy of the hand-off a target is still owed.
 *
 * Decided per window, not by the last hop: if the target is owed even one
 * **addressed** hand-off (`sent`/`forwarded`) that has not been answered by an
 * arrival, the delivery must wake it. A later carbon copy must not downgrade
 * that — the recipient would receive the digest but never run, which is
 * indistinguishable from a dropped hand-off. Read the other way ("the latest
 * addressing hop wins") a `sent` followed by a `cc` while the target is absent
 * silently loses the wake, which is the same failure the mailbox exists to
 * prevent. Arrivals close the window, so a `cc` after an answered send is quiet.
 * @param hops - the report's complete transfer path, oldest first.
 * @param target - the recipient that is pending.
 * @returns `wakeup` when an unanswered addressed hand-off exists, else `quiet`.
 */
export function pendingMode(hops: readonly RouteHop[], target: string): DeliveryMode {
  let addressed = false
  for (const [index, hop] of hops.entries()) {
    // The transfer carries the wake policy with the obligation: the session that
    // owes it now is owed exactly what the previous one was. Recompute the
    // predecessor's mode from the window before this hop rather than assuming a
    // transfer always wakes: a quiet carbon copy must stay quiet when it moves.
    if (hop.action === 'transferred') {
      if (hop.from === target) addressed = false
      if (hop.to.includes(target)) {
        const inherited = hop.from === undefined
          ? true
          : pendingMode(hops.slice(0, index), hop.from) === 'wakeup'
        // A transfer ADDS an obligation to the target; it must not erase an
        // unanswered addressed hand-off the target already holds. Assigning the
        // inherited mode here let a quiet copy moved onto an already-addressed
        // session downgrade it to `inject`, so the session never ran.
        if (inherited) addressed = true
      }
      continue
    }
    if (!hop.to.includes(target)) continue
    if (hop.action === 'delivered') addressed = false
    else if (hop.action === 'sent' || hop.action === 'forwarded') addressed = true
  }
  return addressed ? 'wakeup' : 'quiet'
}
