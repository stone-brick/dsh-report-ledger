/**
 * The report model.
 *
 * A report is the plugin's first-class interaction primitive between agents. It
 * is deliberately two-layered:
 *
 *  - the FRONT MATTER is the digest — a bounded flat mapping that can enter a
 *    model context, an index, or a timeline card without dragging the body in;
 *  - the BODY is the detail, stored out of context and read on demand.
 *
 * The transfer path is a third, append-only stream (see {@link RouteHop}): every
 * hop — authoring, contribution, send, delivery, CC, forwarding, copying, read,
 * acknowledgement — is recorded with its actor and time, so the complete route
 * including every copy survives independently of the report text.
 *
 * @module dsh-report-ledger/report/types
 */

/**
 * Every report status, as both the runtime list and the source of
 * {@link ReportStatus}.
 *
 * A union type and a validator array are two spellings of one fact, and two
 * spellings drift. The parser falls back to `open` for anything it does not
 * recognize, so a status that existed in the type but not in the array would
 * quietly rewrite itself on the next read.
 */
export const REPORT_STATUSES = ['open', 'acked', 'closed'] as const

/** Lifecycle of a report. */
export type ReportStatus = (typeof REPORT_STATUSES)[number]

/**
 * One recorded hop in a report's transfer path.
 *
 * `authored` and `contributed` establish co-authorship; `sent`/`delivered` are
 * the addressed hand-off and its arrival; `cc` is a quiet copy; `forwarded` and
 * `copied` are onward transfer and duplication; `read`/`acked` close the loop for
 * one reader; `leased`/`released` bracket a claim on a working tree, and
 * `reclaimed` records that the ledger cleared a checkout away because the owner
 * asked for it at closing time;
 * `amended` records a correction to the digest or the body; `closed` concludes
 * the matter, and `reopened` records that fresh activity brought it back to life;
 * `transferred` moves one unpaid hand-off from the session that owed it to
 * another, without ever claiming it was delivered.
 *
 * Declared as a value and derived into a type on purpose. The parser validates
 * each record against this list and **drops** one it does not recognize, so a
 * union that named an action this array omitted would lose those hops from the
 * audit trail without a word — the single failure a ledger must not have.
 * Deriving the type from the value makes that drift impossible rather than
 * merely unlikely; it happened once already, when `leased` and `released`
 * reached the union before the array.
 */
export const HOP_ACTIONS = [
  'authored',
  'contributed',
  'sent',
  'delivered',
  'cc',
  'forwarded',
  'copied',
  'read',
  'acked',
  'leased',
  'released',
  'reclaimed',
  'amended',
  'closed',
  'reopened',
  'transferred',
] as const

/** What happened in one hop. */
export type HopAction = (typeof HOP_ACTIONS)[number]

/** One append-only hop in the transfer path of a report. */
export interface RouteHop {
  /** Unix epoch milliseconds. */
  readonly at: number
  /** Session id of the agent that performed the hop; `user` for a human-driven hop. */
  readonly actor: string
  /** Human-facing label for the actor when one is known. */
  readonly actorName?: string
  /** What happened. */
  readonly action: HopAction
  /**
   * Session id the report travelled from, when the hop is a transfer.
   *
   * For a `transferred` hop it is the session whose obligation ENDS: the one that
   * was owed the hand-off and handed it on. For `sent`/`forwarded`-style hops it is
   * the sender the report travelled from.
   */
  readonly from?: string
  /** Session ids the hop addressed (empty for a self-directed hop such as `authored`). */
  readonly to: readonly string[]
  /** Free-text explanation supplied by the actor. */
  readonly note?: string
}

/** How a report is handed to one recipient. */
export type DeliveryMode = 'wakeup' | 'quiet'

/** One recipient entry carried by the front matter. */
export interface Recipient {
  /** Session id. */
  readonly sessionId: string
  /** Display name when known. */
  readonly name?: string
}

/**
 * A working tree a report is bound to.
 *
 * The binding is the ledger's half of a two-layer answer to "who may write this
 * checkout". The ledger knows which report *intends* to hold a branch; git knows
 * which working tree actually has it checked out. Neither answers alone — git
 * cannot name the responsible report, and the ledger cannot see a checkout a
 * human made — so both are consulted and a disagreement is reported, never
 * silently resolved.
 *
 * This is authored state, not a projection of the hop stream: the digest is only
 * a cache of `to`, `cc`, `authors`, `hops` and `last`, so a binding survives
 * every hop refresh. Absent means no working tree, which is the ordinary case.
 */
export interface ReportWorktree {
  /** Absolute path of the working tree. */
  readonly path: string
  /** Short branch name; absent when the tree is on a detached HEAD. */
  readonly branch?: string
  /** The commit the tree was on when the binding was recorded. */
  readonly head?: string
  /**
   * Shared git directory of the repository.
   *
   * Recorded so a binding can still name its repository after the ledger or the
   * repository has moved, which is the difference between an error a reader can
   * act on and one they cannot.
   */
  readonly repo?: string
  /**
   * Whether the ledger created this working tree.
   *
   * Only an allocated tree may be removed by an explicit close. A tree the
   * ledger merely adopted belongs to whoever made it, and no policy here is
   * entitled to delete it.
   */
  readonly allocated?: boolean
}

/**
 * The digest: everything that can be shown or reasoned about cheaply.
 *
 * Deliberately flat and scalar-only so it can be rendered as YAML front matter,
 * scanned from disk without parsing a body, and injected into a prompt.
 */
export interface ReportFrontMatter {
  /** Ledger-scoped identifier, e.g. `R-0007`. */
  readonly report: string
  /** One-line subject. */
  readonly subject: string
  /** Lifecycle status. */
  readonly status: ReportStatus
  /** Originator session id. */
  readonly from: string
  /** Originator display name when known. */
  readonly fromName?: string
  /** Addressed recipients, in send order. */
  readonly to: readonly string[]
  /** Carbon-copy recipients, in copy order. */
  readonly cc: readonly string[]
  /** Every agent that authored or contributed, in contribution order. */
  readonly authors: readonly string[]
  /** Creation time, Unix epoch milliseconds. */
  readonly created: number
  /** Last modification time, Unix epoch milliseconds. */
  readonly updated: number
  /** Upstream report this one answers, when it is a reply report. */
  readonly parent?: string
  /** Reports this one has spawned downstream. */
  readonly children: readonly string[]
  /** Free-form task/thread label grouping reports of one collaboration. */
  readonly task?: string
  /** Working tree this report is bound to, when one is in use. */
  readonly worktree?: ReportWorktree
  /** Referenced artifacts (paths, commit ids, report ids). */
  readonly artifacts: readonly string[]
  /** Number of recorded hops — the cheap indicator that the full path exists. */
  readonly hops: number
  /** The most recent hop, inlined so a digest can show "where it is now". */
  readonly last?: {
    readonly at: number
    readonly action: HopAction
    readonly actor: string
  }
  /**
   * Spill locator of the body when it was moved out of context. Present only
   * when the body exceeded the inline budget.
   */
  readonly spill?: string
}

/** One report: its digest plus its body. */
export interface Report {
  readonly front: ReportFrontMatter
  readonly body: string
}
