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

/** Lifecycle of a report. */
export type ReportStatus = 'open' | 'acked' | 'closed'

/**
 * One recorded hop in a report's transfer path.
 *
 * `authored` and `contributed` establish co-authorship; `sent`/`delivered` are
 * the addressed hand-off and its arrival; `cc` is a quiet copy; `forwarded` and
 * `copied` are onward transfer and duplication; `read`/`acked` close the loop for
 * one reader; `amended` records a correction to the digest or the body; `closed`
 * concludes the matter, and `reopened` records that fresh activity brought it back
 * to life.
 */
export type HopAction =
  | 'authored'
  | 'contributed'
  | 'sent'
  | 'delivered'
  | 'cc'
  | 'forwarded'
  | 'copied'
  | 'read'
  | 'acked'
  | 'amended'
  | 'closed'
  | 'reopened'

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
  /** Session id the report travelled from, when the hop is a transfer. */
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
