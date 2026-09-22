/**
 * The report service: the business operations behind the model-facing tools.
 *
 * Two invariants shape this module.
 *
 * **The transfer path is authoritative.** `to`, `cc`, `authors`, `hops`, and
 * `last` in the front matter are a *derived cache* of the append-only hop
 * stream, recomputed after every recorded hop. Nothing can report a recipient
 * the history does not contain, and a hand-edited digest is corrected on the
 * next hop rather than trusted.
 *
 * **One report, one writer.** Every mutation of a given report runs under a
 * per-report mutex, so a body rewrite (front-matter refresh) can never clobber a
 * concurrent contribution. This is correct for a single host process, which is
 * the residency the harness itself assumes; sharing one ledger across processes
 * would need the lease protocol the subagent seam also defers.
 *
 * @module dsh-report-ledger/report/service
 */

import { appendFile } from 'node:fs/promises'
import type { AgentLike } from './deliver.ts'
import { deliver, pendingTargets, type DeliveryOutcome } from './deliver.ts'
import { allocateId, appendHop, listReports, readHops, readReport, reportPath, writeReport } from './ledger.ts'
import type { DeliveryMode, Report, ReportFrontMatter, RouteHop } from './types.ts'

/** Body size above which `report_read` returns a paged pointer instead of everything. */
const BODY_INLINE_LIMIT = 8000

/** How many characters of a body are shown when it exceeds the inline limit. */
const BODY_HEAD_LIMIT = 1200

/** Host capabilities the service consumes. */
export interface ReportServiceHost {
  /**
   * Resolve one live agent.
   * @param sessionId - target session id.
   * @returns the live agent, or `undefined` when it is not resident.
   */
  getAgent(sessionId: string): AgentLike | undefined
  /**
   * Resolve a display name for one session, when the harness can supply one.
   * @param sessionId - session id.
   * @returns the display name, or `undefined`.
   */
  describe(sessionId: string): Promise<string | undefined>
}

/** Options accepted by {@link ReportService.author}. */
export interface AuthorInput {
  /** One-line subject. */
  readonly subject: string
  /** Report body. */
  readonly body: string
  /** Session id authoring the report. */
  readonly actor: string
  /** Addressed recipients. */
  readonly to?: readonly string[]
  /** Carbon-copy recipients. */
  readonly cc?: readonly string[]
  /** Free-form collaboration label. */
  readonly task?: string
  /** Referenced artifacts. */
  readonly artifacts?: readonly string[]
  /** Upstream report this one answers. */
  readonly parent?: string
}

/** Result of a mutation that may have delivered. */
export interface MutationResult {
  /** The refreshed digest. */
  readonly front: ReportFrontMatter
  /** Delivery outcomes for this mutation. */
  readonly outcomes: readonly DeliveryOutcome[]
}

/**
 * One correction applied to a report.
 *
 * Only the digest fields an owner may legitimately correct appear here. Recipients
 * and co-authorship are absent on purpose: they are derived from the hop stream, so
 * the single way to change them is to append another hop.
 */
export interface AmendInput {
  /** Replacement subject. An empty value is refused rather than blanking the title. */
  readonly subject?: string
  /** Replacement collaboration label; an empty value clears it. */
  readonly task?: string
  /** Replacement artifact list (whole-list, not additive). */
  readonly artifacts?: readonly string[]
  /** New body text: appended as an amendment, or used to replace the body. */
  readonly body?: string
  /**
   * Replace the body outright instead of appending an amendment. Requires
   * `body`, and is recorded on the hop so a later reader knows the text was
   * rewritten rather than only added to.
   */
  readonly replaceBody?: boolean
  /** Extra note appended to the recorded change summary. */
  readonly note?: string
}

/** One row of a digest listing. */
export interface DigestRow {
  /** Report identifier. */
  readonly report: string
  /** Lifecycle status. */
  readonly status: string
  /** Subject. */
  readonly subject: string
  /** Originator. */
  readonly from: string
  /** Addressed recipients. */
  readonly to: readonly string[]
  /** Carbon-copy recipients. */
  readonly cc: readonly string[]
  /** Recorded hop count. */
  readonly hops: number
  /** Collaboration label, when the report carries one. */
  readonly task?: string
  /** Last recorded hop, when any. */
  readonly last?: string
  /** Last update time. */
  readonly updated: number
}

/** Serialize one report for model-facing output. */
function renderFrontLine(front: ReportFrontMatter): string {
  const parts = [
    `${front.report} [${front.status}] ${front.subject}`,
    `from=${front.from}`,
    `to=${front.to.length === 0 ? '-' : front.to.join(',')}`,
    `cc=${front.cc.length === 0 ? '-' : front.cc.join(',')}`,
    `authors=${front.authors.join(',')}`,
    `hops=${front.hops}`,
    `updated=${new Date(front.updated).toISOString()}`,
  ]
  if (front.task !== undefined) parts.push(`task=${front.task}`)
  if (front.parent !== undefined) parts.push(`parent=${front.parent}`)
  if (front.children.length > 0) parts.push(`children=${front.children.join(',')}`)
  if (front.last !== undefined) parts.push(`last=${front.last.action}@${front.last.actor}`)
  return parts.join(' | ')
}

/** Derive the route projection from the authoritative hop stream. */
function projectRoute(hops: readonly RouteHop[]): Pick<ReportFrontMatter, 'to' | 'cc' | 'authors' | 'hops' | 'last'> {
  const authors: string[] = []
  const to: string[] = []
  const cc: string[] = []
  for (const hop of hops) {
    if (hop.action === 'authored' || hop.action === 'contributed') {
      if (!authors.includes(hop.actor)) authors.push(hop.actor)
    }
    if (hop.action === 'sent' || hop.action === 'forwarded') {
      for (const target of hop.to) if (!to.includes(target)) to.push(target)
    }
    if (hop.action === 'cc' || hop.action === 'copied') {
      for (const target of hop.to) if (!cc.includes(target)) cc.push(target)
    }
  }
  const tail = hops.length === 0 ? undefined : hops[hops.length - 1]
  return {
    to,
    cc,
    authors,
    hops: hops.length,
    ...(tail === undefined ? {} : { last: { at: tail.at, action: tail.action, actor: tail.actor } }),
  }
}

/** The report service. */
export class ReportService {
  readonly #host: ReportServiceHost
  readonly #locks = new Map<string, Promise<unknown>>()

  /**
   * @param host - host capabilities (agent lookup, display names).
   */
  constructor(host: ReportServiceHost) {
    this.#host = host
  }

  /** Run one mutation under the report's mutex. */
  async #withLock<T>(report: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(report) ?? Promise.resolve()
    const next = previous.then(work, work)
    // Keep the settled chain as the next caller's predecessor; a rejected link
    // must not poison the chain, so the stored promise never rejects.
    this.#locks.set(report, next.then(() => undefined, () => undefined))
    return next
  }

  /** Append one hop, then refresh the derived digest fields. */
  async #record(report: string, hop: RouteHop): Promise<ReportFrontMatter> {
    await appendHop(report, hop)
    return this.#sync(report)
  }

  /** Recompute the derived front-matter fields from the hop stream. */
  async #sync(report: string): Promise<ReportFrontMatter> {
    const current = await readReport(report)
    if (current === undefined) throw new Error(`report-ledger: report ${report} does not exist`)
    const hops = await readHops(report)
    const projected = projectRoute(hops)
    const front: ReportFrontMatter = {
      ...current.front,
      ...projected,
      updated: Date.now(),
    }
    await writeReport({ front, body: current.body })
    return front
  }

  /** Read one report or throw a model-legible error. */
  async #require(report: string): Promise<Report> {
    const found = await readReport(report)
    if (found === undefined) throw new Error(`report-ledger: no report ${JSON.stringify(report)} in the ledger`)
    return found
  }

  /** Deliver a digest and record one arrival hop per recipient that received it. */
  async #deliver(front: ReportFrontMatter, targets: readonly string[], mode: DeliveryMode, actor: string): Promise<DeliveryOutcome[]> {
    const outcomes = await deliver(this.#host, front, reportPath(front.report), targets, mode)
    const arrivals = outcomes.filter((outcome) => outcome.status === 'delivered')
    if (arrivals.length === 0) return outcomes
    const at = Date.now()
    for (const arrival of arrivals) {
      await appendHop(front.report, { at, actor, action: 'delivered', to: [arrival.targetId], note: mode })
    }
    await this.#sync(front.report)
    return outcomes
  }

  /**
   * Create a report and optionally hand it to its first recipients.
   * @param input - authoring input.
   * @returns the created digest and any immediate delivery outcomes.
   */
  async author(input: AuthorInput): Promise<MutationResult> {
    const subject = input.subject.trim()
    if (subject === '') throw new Error('report-ledger: report_author requires a non-empty subject')
    const report = await allocateId()
    const now = Date.now()
    const fromName = await this.#host.describe(input.actor)
    const front: ReportFrontMatter = {
      report,
      subject,
      status: 'open',
      from: input.actor,
      ...(fromName === undefined ? {} : { fromName }),
      to: [],
      cc: [],
      authors: [],
      created: now,
      updated: now,
      children: [],
      artifacts: [...(input.artifacts ?? [])],
      hops: 0,
      ...(input.parent === undefined ? {} : { parent: input.parent }),
      ...(input.task === undefined ? {} : { task: input.task }),
    }
    await writeReport({ front, body: input.body })
    let refreshed = await this.#record(report, { at: now, actor: input.actor, action: 'authored', to: [] })

    if (input.parent !== undefined) {
      const parent = await readReport(input.parent)
      if (parent !== undefined) {
        await this.#withLock(input.parent, async () => {
          const latest = await this.#require(input.parent as string)
          const children = latest.front.children.includes(report)
            ? latest.front.children
            : [...latest.front.children, report]
          await writeReport({ front: { ...latest.front, children, updated: Date.now() }, body: latest.body })
        })
      }
    }

    let outcomes: DeliveryOutcome[] = []
    if ((input.to?.length ?? 0) > 0) {
      const sent = await this.#record(report, { at: Date.now(), actor: input.actor, action: 'sent', to: [...(input.to ?? [])] })
      refreshed = sent
      outcomes = await this.#deliver(sent, input.to ?? [], 'wakeup', input.actor)
    }
    if ((input.cc?.length ?? 0) > 0) {
      const copied = await this.#record(report, { at: Date.now(), actor: input.actor, action: 'cc', to: [...(input.cc ?? [])] })
      refreshed = copied
      outcomes = [...outcomes, ...await this.#deliver(copied, input.cc ?? [], 'quiet', input.actor)]
    }
    const final = await this.#require(report)
    return { front: final.front, outcomes }
  }

  /**
   * Decide whether one session owns a report.
   *
   * Owning is what lets an agent conclude the matter *or* correct what it says —
   * a recipient may do neither. `from` is accepted alongside `authors` because a
   * hand-edited ledger could in principle carry the originator without the
   * matching hop, and refusing the obvious owner would strand the report.
   * @param front - the report digest.
   * @param actor - the session asserting ownership.
   * @returns true when the actor owns the report.
   */
  static owns(front: ReportFrontMatter, actor: string): boolean {
    return actor === front.from || front.authors.includes(actor)
  }

  /**
   * Return a closed report to life because fresh activity arrived.
   *
   * `closed` is a state, not a lock. If someone contributes to, sends, copies, or
   * forwards a closed report, the matter is demonstrably live again — so the
   * transition is recorded and the status goes back to `open`. Without this a
   * prematurely closed report would silently swallow later work, which is the
   * worst possible failure for a ledger whose whole point is traceability.
   * @param report - report identifier.
   * @param actor - the session whose activity reopened it.
   */
  async #reopenIfClosed(report: string, actor: string): Promise<void> {
    const current = await this.#require(report)
    if (current.front.status !== 'closed') return
    await this.#record(report, { at: Date.now(), actor, action: 'reopened', to: [] })
    const fresh = await this.#require(report)
    await writeReport({ front: { ...fresh.front, status: 'open', updated: Date.now() }, body: fresh.body })
  }

  /**
   * Append a co-author's contribution to an existing report.
   * @param report - report identifier.
   * @param actor - contributing session id.
   * @param body - the contribution text.
   * @param note - optional hop note.
   * @returns the refreshed digest.
   */
  async contribute(report: string, actor: string, body: string, note?: string): Promise<MutationResult> {
    const text = body.trim()
    if (text === '') throw new Error('report-ledger: report_contribute requires non-empty content')
    const name = await this.#host.describe(actor)
    const header = `\n\n---\n\n### contribution by ${name ?? actor} at ${new Date().toISOString()}\n\n`
    return this.#withLock(report, async () => {
      await this.#require(report)
      await this.#reopenIfClosed(report, actor)
      // Append to the body rather than rewriting it: contributions from several
      // agents must not overwrite one another.
      await appendFile(reportPath(report), `${header}${text}\n`, 'utf8')
      const front = await this.#record(report, {
        at: Date.now(),
        actor,
        action: 'contributed',
        to: [],
        ...(note === undefined ? {} : { note }),
      })
      return { front, outcomes: [] }
    })
  }

  /**
   * Address a report to recipients and wake them.
   * @param report - report identifier.
   * @param actor - sending session id.
   * @param targets - recipient session ids.
   * @param note - optional hop note.
   * @returns the refreshed digest and delivery outcomes.
   */
  async send(report: string, actor: string, targets: readonly string[], note?: string): Promise<MutationResult> {
    if (targets.length === 0) throw new Error('report-ledger: report_send requires at least one recipient')
    return this.#withLock(report, async () => {
      await this.#require(report)
      await this.#reopenIfClosed(report, actor)
      const front = await this.#record(report, {
        at: Date.now(),
        actor,
        action: 'sent',
        to: [...targets],
        ...(note === undefined ? {} : { note }),
      })
      const outcomes = await this.#deliver(front, targets, 'wakeup', actor)
      return { front: (await this.#require(report)).front, outcomes }
    })
  }

  /**
   * Copy a report to recipients without waking them.
   * @param report - report identifier.
   * @param actor - copying session id.
   * @param targets - carbon-copy recipient session ids.
   * @param note - optional hop note.
   * @returns the refreshed digest and delivery outcomes.
   */
  async carbonCopy(report: string, actor: string, targets: readonly string[], note?: string): Promise<MutationResult> {
    if (targets.length === 0) throw new Error('report-ledger: report_cc requires at least one recipient')
    return this.#withLock(report, async () => {
      await this.#require(report)
      await this.#reopenIfClosed(report, actor)
      const front = await this.#record(report, {
        at: Date.now(),
        actor,
        action: 'cc',
        to: [...targets],
        ...(note === undefined ? {} : { note }),
      })
      const outcomes = await this.#deliver(front, targets, 'quiet', actor)
      return { front: (await this.#require(report)).front, outcomes }
    })
  }

  /**
   * Pass a report onward, or duplicate it as evidence for another report.
   *
   * A forward keeps the original authorship and appends the new hand-off; a copy
   * records the duplication so the audit trail shows where copies of a report
   * live.
   * @param report - report identifier.
   * @param actor - acting session id.
   * @param targets - recipient session ids.
   * @param mode - `forward` (addressed onward transfer) or `copy` (duplication).
   * @param note - optional hop note.
   * @returns the refreshed digest and delivery outcomes.
   */
  async forward(
    report: string,
    actor: string,
    targets: readonly string[],
    mode: 'forward' | 'copy',
    note?: string,
  ): Promise<MutationResult> {
    if (targets.length === 0) throw new Error('report-ledger: report_forward requires at least one target')
    return this.#withLock(report, async () => {
      await this.#require(report)
      await this.#reopenIfClosed(report, actor)
      const front = await this.#record(report, {
        at: Date.now(),
        actor,
        action: mode === 'copy' ? 'copied' : 'forwarded',
        to: [...targets],
        ...(note === undefined ? {} : { note }),
      })
      const outcomes = await this.#deliver(front, targets, mode === 'copy' ? 'quiet' : 'wakeup', actor)
      return { front: (await this.#require(report)).front, outcomes }
    })
  }

  /**
   * Read a report's digest, body, and complete transfer path.
   * @param report - report identifier.
   * @param actor - reading session id.
   * @returns the model-facing rendering.
   */
  async read(report: string, actor: string): Promise<string> {
    const found = await this.#require(report)
    const hops = await readHops(report)
    await this.#record(report, { at: Date.now(), actor, action: 'read', to: [] })
    const path = reportPath(report)
    const body = found.body.trim()
    const rendered = body.length > BODY_INLINE_LIMIT
      ? `${body.slice(0, BODY_HEAD_LIMIT)}\n\n… body truncated (${body.length} chars total). Read the rest with the read tool at ${path} using offset/limit.`
      : body
    const route = hops.length === 0
      ? '  (no hops recorded)'
      : hops.map((hop) => {
        const targets = hop.to.length === 0 ? '' : ` -> ${hop.to.join(',')}`
        const note = hop.note === undefined ? '' : `  # ${hop.note}`
        return `  ${new Date(hop.at).toISOString()}  ${hop.action.padEnd(11)} by ${hop.actor}${targets}${note}`
      }).join('\n')
    const pending = pendingTargets(hops)
    return [
      renderFrontLine(found.front),
      `body=${path}`,
      '',
      '## transfer path',
      route,
      ...(pending.length === 0 ? [] : ['', `## still pending delivery to: ${pending.join(', ')}`]),
      '',
      '## body',
      rendered,
    ].join('\n')
  }

  /**
   * List report digests, optionally filtered to ones touching one session.
   * @param filter - listing filter.
   * @returns one row per matching report, newest first.
   */
  async list(filter: { session?: string; status?: string; task?: string; limit?: number } = {}): Promise<DigestRow[]> {
    const all = await listReports()
    const session = filter.session
    const task = filter.task?.trim().toLowerCase()
    const matching = all.filter((front) => {
      if (filter.status !== undefined && front.status !== filter.status) return false
      // A task label is a grouping key, matched case-insensitively as a substring
      // so a partial label is enough to pull up a whole collaboration — the point
      // of the filter is discovery across trees, where an exact-match typo would
      // silently return nothing.
      if (task !== undefined && task !== '' && !(front.task ?? '').toLowerCase().includes(task)) return false
      if (session === undefined) return true
      return front.from === session
        || front.to.includes(session)
        || front.cc.includes(session)
        || front.authors.includes(session)
    })
    const limit = filter.limit === undefined || filter.limit <= 0 ? 50 : Math.min(filter.limit, 200)
    return matching.slice(0, limit).map((front) => ({
      report: front.report,
      status: front.status,
      subject: front.subject,
      from: front.from,
      to: front.to,
      cc: front.cc,
      hops: front.hops,
      ...(front.task === undefined ? {} : { task: front.task }),
      ...(front.last === undefined ? {} : { last: `${front.last.action}@${front.last.actor}` }),
      updated: front.updated,
    }))
  }

  /**
   * Mark a report acknowledged by one recipient.
   * @param report - report identifier.
   * @param actor - acknowledging session id.
   * @param note - optional note.
   * @returns the refreshed digest.
   */
  async acknowledge(report: string, actor: string, note?: string): Promise<MutationResult> {
    return this.#withLock(report, async () => {
      const current = await this.#require(report)
      const front = await this.#record(report, {
        at: Date.now(),
        actor,
        action: 'acked',
        to: [],
        ...(note === undefined ? {} : { note }),
      })
      if (current.front.status === 'open') {
        await writeReport({ front: { ...front, status: 'acked', updated: Date.now() }, body: current.body })
      }
      return { front: (await this.#require(report)).front, outcomes: [] }
    })
  }

  /**
   * Conclude a report: the owner's act, recorded as a hop.
   *
   * Deliberately idempotent — a second close records another hop rather than
   * failing, because "someone tried to close this again" is itself useful history.
   * Reopening is not a separate tool: any later contribution, send, copy, or
   * forward brings a closed report back to `open` on its own.
   * @param report - report identifier.
   * @param actor - the session concluding it.
   * @param note - optional note.
   * @returns the refreshed digest.
   * @throws when the actor is neither the originator nor a co-author.
   */
  async close(report: string, actor: string, note?: string): Promise<MutationResult> {
    return this.#withLock(report, async () => {
      const current = await this.#require(report)
      if (!ReportService.owns(current.front, actor)) {
        const owners = [...new Set([current.front.from, ...current.front.authors])]
        throw new Error(
          `report-ledger: ${actor} may not close ${report} — closing is the owner's act, not a reader's. `
          + `Ask one of its authors to close it: ${owners.join(', ')}`,
        )
      }
      const front = await this.#record(report, {
        at: Date.now(),
        actor,
        action: 'closed',
        to: [],
        ...(note === undefined ? {} : { note }),
      })
      const fresh = await this.#require(report)
      await writeReport({ front: { ...fresh.front, status: 'closed', updated: Date.now() }, body: fresh.body })
      return { front: (await this.#require(report)).front, outcomes: [] }
    })
  }

  /**
   * Correct a report: the digest fields and/or the body, as the owner's act.
   *
   * The tension this resolves is real. A ledger's value comes from history being
   * append-only, so an agent that could silently rewrite the record would destroy
   * the thing the ledger is for. But an agent that cannot correct a wrong subject
   * has only bad options: author a new report and lose the transfer path, or leave
   * the error standing. So corrections are **recorded, never silent**:
   *
   *  - digest fields (`subject`, `task`, `artifacts`) are current state and are
   *    replaced, with the hop carrying the old and new values verbatim;
   *  - the body is a record of what people *said*, so by default an amendment
   *    **appends** a new section instead of rewriting anyone's words;
   *  - replacing the body outright is possible but must be asked for explicitly
   *    (`replaceBody`), and the hop records that it happened — a later reader is
   *    told the text was rewritten and by whom, rather than being misled.
   *
   * Recipients and co-authorship can never be edited here: they are derived from
   * the hop stream, so the only way to change them is to append another hop.
   * @param report - report identifier.
   * @param actor - the correcting session.
   * @param patch - the fields to change.
   * @returns the refreshed digest.
   * @throws when the actor does not own the report, or the patch changes nothing.
   */
  async amend(report: string, actor: string, patch: AmendInput): Promise<MutationResult> {
    return this.#withLock(report, async () => {
      const current = await this.#require(report)
      if (!ReportService.owns(current.front, actor)) {
        const owners = [...new Set([current.front.from, ...current.front.authors])]
        throw new Error(
          `report-ledger: ${actor} may not amend ${report} — correcting a report is its owner's act. `
          + `Ask one of its authors to amend it: ${owners.join(', ')}`,
        )
      }

      const changes: string[] = []
      const next: { subject?: string; task?: string; artifacts?: readonly string[] } = {}

      if (patch.subject !== undefined) {
        const subject = patch.subject.trim()
        if (subject === '') throw new Error('report-ledger: an amendment cannot blank the subject')
        if (subject !== current.front.subject) {
          next.subject = subject
          changes.push(`subject ${JSON.stringify(current.front.subject)} -> ${JSON.stringify(subject)}`)
        }
      }
      if (patch.task !== undefined) {
        const task = patch.task.trim()
        const before = current.front.task
        if (task !== (before ?? '')) {
          next.task = task
          changes.push(`task ${JSON.stringify(before ?? '')} -> ${JSON.stringify(task)}`)
        }
      }
      if (patch.artifacts !== undefined) {
        const before = current.front.artifacts
        const after = patch.artifacts.map((entry) => entry.trim()).filter((entry) => entry !== '')
        if (before.join('\n') !== after.join('\n')) {
          next.artifacts = after
          changes.push(`artifacts ${before.length} -> ${after.length}`)
        }
      }

      const replacingBody = patch.replaceBody === true
      if (patch.body !== undefined) {
        if (patch.body.trim() === '') throw new Error('report-ledger: an amendment cannot send an empty body')
        changes.push(replacingBody ? 'body replaced' : 'body amended (appended)')
      } else if (replacingBody) {
        throw new Error('report-ledger: replaceBody was set without a body')
      }

      if (changes.length === 0) {
        throw new Error(`report-ledger: nothing to amend on ${report} — the provided values already match`)
      }

      await this.#reopenIfClosed(report, actor)

      if (patch.body !== undefined) {
        if (replacingBody) {
          // A true rewrite, recorded as such on the hop.
          await writeReport({ front: (await this.#require(report)).front, body: patch.body })
        } else {
          const name = await this.#host.describe(actor)
          const header = `\n\n---\n\n### amendment by ${name ?? actor} at ${new Date().toISOString()}\n\n`
          await appendFile(reportPath(report), `${header}${patch.body.trim()}\n`, 'utf8')
        }
      }

      if (next.subject !== undefined || next.task !== undefined || next.artifacts !== undefined) {
        const base = await this.#require(report)
        // `task` is destructured out and re-added only when it survives, so an empty
        // value clears the label instead of storing an empty string — that keeps
        // `task === undefined` the single meaning of "no label".
        const { task: previousTask, ...rest } = base.front
        const task = next.task === undefined ? previousTask : (next.task === '' ? undefined : next.task)
        const amended: ReportFrontMatter = {
          ...rest,
          ...(next.subject === undefined ? {} : { subject: next.subject }),
          ...(next.artifacts === undefined ? {} : { artifacts: next.artifacts }),
          updated: Date.now(),
          ...(task === undefined ? {} : { task }),
        }
        await writeReport({ front: amended, body: base.body })
      }

      const summary = [...changes, ...(patch.note === undefined ? [] : [patch.note])].join('; ')
      const front = await this.#record(report, { at: Date.now(), actor, action: 'amended', to: [], note: summary })
      return { front, outcomes: [] }
    })
  }

  /**
   * Deliver every held hand-off owed to one session that just became resident.
   * @param sessionId - the session that became resident.
   * @returns the deliveries that succeeded.
   */
  async flushForAgent(sessionId: string): Promise<readonly DeliveryOutcome[]> {
    const digests = new Map<string, ReportFrontMatter>()
    for (const front of await listReports()) digests.set(front.report, front)
    const outcomes: DeliveryOutcome[] = []
    for (const [report, front] of digests) {
      const hops = await readHops(report)
      if (!pendingTargets(hops).includes(sessionId)) continue
      const quiet = hops.some((hop) => hop.action === 'cc' && hop.to.includes(sessionId))
      const delivered = await this.#deliver(front, [sessionId], quiet ? 'quiet' : 'wakeup', 'report-ledger')
      outcomes.push(...delivered)
    }
    return outcomes
  }
}

/** Render one digest row for model-facing listing output. */
export function renderRow(row: DigestRow): string {
  const last = row.last === undefined ? '-' : row.last
  // The task label is rendered inline rather than omitted: it is the grouping a
  // reader scans for, and a listing that hides it forces a second call per report.
  const task = row.task === undefined ? '' : ` task=${row.task}`
  return `${row.report} [${row.status}] ${row.subject}${task} | from=${row.from} to=${row.to.length === 0 ? '-' : row.to.join(',')} cc=${row.cc.length === 0 ? '-' : row.cc.join(',')} hops=${row.hops} last=${last}`
}
