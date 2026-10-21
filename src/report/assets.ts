/**
 * What one session still owns in the ledger.
 *
 * A handover needs an answer no single file holds: the reports this session is
 * responsible for, the checkouts its ownership is holding, and the hand-offs it
 * has been addressed but never received. All three are derived from the same two
 * streams the rest of the plugin reads — the digests for identity, the hop stream
 * for state — so a handover can never describe an obligation the ledger does not
 * contain, and a hand-edited digest cannot invent one.
 *
 * Pure on purpose: enumeration is the part that decides what a retirement will
 * touch, so it is checked deterministically rather than inferred from a live run.
 *
 * @module dsh-report-ledger/report/assets
 */

import { leaseState } from './lease.ts'
import { pendingTargets } from './deliver.ts'
import type { ReportFrontMatter, ReportStatus, RouteHop } from './types.ts'

/** One report as the asset scan reads it: digest plus its complete route. */
export interface LedgerPiece {
  /** The report's digest. */
  readonly front: ReportFrontMatter
  /** The report's complete transfer path. */
  readonly hops: readonly RouteHop[]
}

/** One hand-off a session was addressed with and never received. */
export interface OwedHandoff {
  /** The report it belongs to. */
  readonly report: string
  /** Status of that report, because a conclusion changes what is left to do. */
  readonly status: ReportStatus
}

/** Everything one session still holds. */
export interface SessionAssets {
  /** The session these assets belong to. */
  readonly session: string
  /** Reports it owns (originator or co-author) that are not closed. */
  readonly owned: readonly string[]
  /** Of those, the ones currently holding a working tree. */
  readonly checkouts: readonly string[]
  /** Hand-offs addressed to it and never delivered. */
  readonly owed: readonly OwedHandoff[]
}

/**
 * Whether a session owns a digest.
 *
 * Kept identical to the service's ownership rule — originator or co-author — so a
 * handover never lists something the service would refuse to let the session act
 * on, and never omits something it would allow.
 * @param front - the report digest.
 * @param session - session id.
 * @returns true when the session may act as an owner.
 */
export function owns(front: ReportFrontMatter, session: string): boolean {
  return front.from === session || front.authors.includes(session)
}

/**
 * Whether a report could possibly concern a session.
 *
 * A cheap prefilter, not an authority check: a session can only own what names it
 * as originator or co-author, and can only be owed what addressed it. Requiring
 * the hop stream for every report in the ledger would make a handover read the
 * whole ledger; this narrows it to the handful that can matter.
 * @param front - the report digest.
 * @param session - session id.
 * @returns true when the digest names the session.
 */
export function mentions(front: ReportFrontMatter, session: string): boolean {
  return owns(front, session) || front.to.includes(session) || front.cc.includes(session)
}

/**
 * Enumerate what one session still holds.
 * @param pieces - the reports to scan, already narrowed by {@link mentions}.
 * @param session - the session whose assets are wanted.
 * @returns its owned open reports, the checkouts among them, and what it is owed.
 */
export function assetsOf(pieces: readonly LedgerPiece[], session: string): SessionAssets {
  const owned: string[] = []
  const checkouts: string[] = []
  const owed: OwedHandoff[] = []

  for (const piece of pieces) {
    const manages = owns(piece.front, session)
    if (manages && piece.front.status !== 'closed') {
      owned.push(piece.front.report)
      if (leaseState(piece.hops) === 'held') checkouts.push(piece.front.report)
    }
    if (pendingTargets(piece.hops).includes(session)) {
      owed.push({ report: piece.front.report, status: piece.front.status })
    }
  }

  return { session, owned, checkouts, owed }
}
