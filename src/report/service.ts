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
import { basename } from 'node:path'
import { planAllocation, type ReclaimedLease, type StaleBinding, type WorktreeSettings } from './allocate.ts'
import type { AgentLike } from './deliver.ts'
import { deliver, pendingTargets, type DeliveryOutcome } from './deliver.ts'
import { evaluateLease, leaseState } from './lease.ts'
import { allocateId, appendHop, discardUnwrittenId, isValidReportId, listReports, readHops, readReport, reportExists, reportPath, writeReport } from './ledger.ts'
import { addWorktree, classifyGitRefusal, compareKey, headOf, removeWorktree, resolveRepo } from './worktree.ts'
import type { RepoLocation } from './worktree.ts'
import type { DeliveryMode, Report, ReportFrontMatter, ReportWorktree, RouteHop } from './types.ts'

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
   * The directory a session runs in.
   *
   * Needed to allocate a working tree, because a checkout belongs to a
   * repository and the session's own directory is the only thing that says
   * which repository that is. Absent when the harness does not record one.
   * @param sessionId - session id.
   * @returns the absolute directory, or `undefined`.
   */
  selfCwd?(sessionId: string): string | undefined
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
  /**
   * Working tree this report is bound to.
   *
   * Supplied rather than discovered: the ledger records the binding, and a
   * binding that names a tree which does not exist is a lie the ledger can carry
   * but never invents. Supplying one here also records the claim, because a
   * caller that created a checkout before the report existed has already
   * claimed it.
   */
  readonly worktree?: ReportWorktree
  /**
   * Report id to use instead of allocating one.
   *
   * The working tree's name is derived from the report id, so a caller that must
   * create the checkout first has to know the id first. Allocating here as well
   * would produce a second, orphaned number — hence this way to hand the claim
   * back.
   */
  readonly reportId?: string
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
  /**
   * What this mutation did about a working tree on disk.
   *
   * Absent when the mutation has nothing to do with one. Present even when the
   * answer is "nothing was touched", because a caller that asked for a cleanup
   * needs to be told it did not happen — a silent refusal would read as success.
   */
  readonly worktree?: WorktreeOutcome
}

/** What a provisioning produced. */
export interface PreparedWorktree {
  /**
   * The binding to record on the report.
   *
   * Narrower than {@link ReportWorktree}, like the plan it came from: a checkout
   * this method created always has a branch, a repository and the `allocated`
   * mark, and saying so keeps callers from re-checking what was just produced.
   */
  readonly binding: ReportWorktree & { readonly branch: string; readonly repo: string; readonly allocated: true }
  /** How many ended claims still have a checkout on disk. */
  readonly retained: number
  /** The checkout cleared to make room, when one was. */
  readonly reclaimed?: ReclaimedLease
  /** Candidates for reclamation that were refused, and why. */
  readonly reclaimSkipped: readonly string[]
  /** Bindings whose checkout had already vanished, now recorded as such. */
  readonly stale: readonly StaleBinding[]
}

/** What a mutation did, or tried to do, about a working tree on disk. */
export interface WorktreeOutcome {
  /** `kept` when the tree was deliberately left alone, `removed` on success, `refused` on failure. */
  readonly action: 'kept' | 'removed' | 'refused'
  /** Why a removal was refused, in git's own words. */
  readonly detail?: string
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
  /** Compact label of the bound working tree, when one is bound. */
  readonly worktree?: string
  /** Last recorded hop, when any. */
  readonly last?: string
  /** Last update time. */
  readonly updated: number
}

/**
 * One token naming a bound working tree.
 *
 * The branch is the lease's identity, so it is what a listing shows; a detached
 * tree has none, and there the directory name is the only stable handle. The
 * full path stays in the digest for anyone who needs to act on it.
 * @param worktree - the binding.
 * @returns the label.
 */
function worktreeLabel(worktree: ReportWorktree): string {
  if (worktree.branch !== undefined) return worktree.branch
  return basename(worktree.path) || worktree.path
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
  if (front.worktree !== undefined) parts.push(`worktree=${worktreeLabel(front.worktree)}@${front.worktree.path}`)
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
   * Mutexes keyed by shared git directory, for decisions that span reports.
   *
   * A per-report mutex cannot serialize two *different* reports racing for one
   * branch, and claiming a working tree is exactly that decision. The key is the
   * repository rather than a checkout, because a branch is held by a repository
   * — keying by path would leave two checkouts of one repository mutually
   * invisible, which is the race the lock exists to stop. Their order is fixed;
   * see {@link ReportService.lease}.
   */
  readonly #repoLocks = new Map<string, Promise<unknown>>()

  /**
   * @param host - host capabilities (agent lookup, display names).
   */
  constructor(host: ReportServiceHost) {
    this.#host = host
  }

  /** Run one task under a key's mutex. */
  async #serialize<T>(map: Map<string, Promise<unknown>>, key: string, work: () => Promise<T>): Promise<T> {
    const previous = map.get(key) ?? Promise.resolve()
    const next = previous.then(work, work)
    // Keep the settled chain as the next caller's predecessor; a rejected link
    // must not poison the chain, so the stored promise never rejects.
    map.set(key, next.then(() => undefined, () => undefined))
    return next
  }

  /** Run one mutation under the report's mutex. */
  async #withLock<T>(report: string, work: () => Promise<T>): Promise<T> {
    return await this.#serialize(this.#locks, report, work)
  }

  /** Run one decision under the repository's mutex. */
  async #withRepoLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    return await this.#serialize(this.#repoLocks, key, work)
  }

  /** Append one hop, then refresh the derived digest fields. */
  async #record(report: string, hop: RouteHop, options: { touch?: boolean } = {}): Promise<ReportFrontMatter> {
    await appendHop(report, hop)
    return await this.#sync(report, options)
  }

  /**
   * Recompute the derived front-matter fields from the hop stream.
   * @param report - report identifier.
   * @param options - `touch: false` keeps the digest's `updated` stamp, for an
   * administrative hop that must not make a concluded report look active again.
   */
  async #sync(report: string, options: { touch?: boolean } = {}): Promise<ReportFrontMatter> {
    const current = await readReport(report)
    if (current === undefined) throw new Error(`report-ledger: report ${report} does not exist`)
    const hops = await readHops(report)
    const projected = projectRoute(hops)
    const front: ReportFrontMatter = {
      ...current.front,
      ...projected,
      updated: options.touch === false ? current.front.updated : Date.now(),
    }
    await writeReport({ front, body: current.body })
    return front
  }

  /** Read one report or throw a model-legible error. */
  async #load(report: string): Promise<Report> {
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
    // A caller that had to know the id in advance — because it names the working
    // tree it is about to create — claims the id itself and passes it back.
    const report = input.reportId ?? await allocateId()
    if (!isValidReportId(report)) {
      throw new Error(`report-ledger: ${JSON.stringify(report)} is not a usable report id (expected the form R-0001)`)
    }
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
      ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
    }
    await writeReport({ front, body: input.body })
    let refreshed = await this.#record(report, { at: now, actor: input.actor, action: 'authored', to: [] })

    // A binding handed in at authoring time is a claim already made: the caller
    // created the checkout before the report existed, so the claim is recorded
    // here rather than left for a second call that might never come.
    if (input.worktree !== undefined) {
      refreshed = await this.#record(report, {
        at: Date.now(),
        actor: input.actor,
        action: 'leased',
        to: [],
        note: `${input.worktree.branch ?? '(detached HEAD)'} @ ${input.worktree.path}`,
      })
    }

    if (input.parent !== undefined) {
      const parent = await readReport(input.parent)
      if (parent !== undefined) {
        await this.#withLock(input.parent, async () => {
          const latest = await this.#load(input.parent as string)
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
    const final = await this.#load(report)
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
   * Throw unless the actor owns the report.
   *
   * Correcting, concluding and claiming a checkout are all the owner's acts, and
   * they are refused the same way — by naming who may do it instead. A refusal
   * that only says "no" makes the model guess; naming the authors turns it into
   * a hand-off.
   *
   * The gerund is passed rather than derived, because the derivation is wrong:
   * `close` + `ing` is not a word, and a refusal that reads like a bug invites a
   * model to route around it.
   * @param front - the report's digest.
   * @param actor - the session attempting the act.
   * @param verb - the act, in the imperative, for the sentence.
   * @param gerund - the same act as a noun phrase.
   */
  #assertOwner(front: ReportFrontMatter, actor: string, verb: string, gerund: string): void {
    if (ReportService.owns(front, actor)) return
    const owners = [...new Set([front.from, ...front.authors])]
    throw new Error(
      `report-ledger: ${actor} may not ${verb} ${front.report} — ${gerund} is the owner's act, not a reader's. `
      + `Ask one of its authors to do it: ${owners.join(', ')}`,
    )
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
    const current = await this.#load(report)
    if (current.front.status !== 'closed') return
    await this.#record(report, { at: Date.now(), actor, action: 'reopened', to: [] })
    const fresh = await this.#load(report)
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
      await this.#load(report)
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
      await this.#load(report)
      await this.#reopenIfClosed(report, actor)
      const front = await this.#record(report, {
        at: Date.now(),
        actor,
        action: 'sent',
        to: [...targets],
        ...(note === undefined ? {} : { note }),
      })
      const outcomes = await this.#deliver(front, targets, 'wakeup', actor)
      return { front: (await this.#load(report)).front, outcomes }
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
      await this.#load(report)
      await this.#reopenIfClosed(report, actor)
      const front = await this.#record(report, {
        at: Date.now(),
        actor,
        action: 'cc',
        to: [...targets],
        ...(note === undefined ? {} : { note }),
      })
      const outcomes = await this.#deliver(front, targets, 'quiet', actor)
      return { front: (await this.#load(report)).front, outcomes }
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
      await this.#load(report)
      await this.#reopenIfClosed(report, actor)
      const front = await this.#record(report, {
        at: Date.now(),
        actor,
        action: mode === 'copy' ? 'copied' : 'forwarded',
        to: [...targets],
        ...(note === undefined ? {} : { note }),
      })
      const outcomes = await this.#deliver(front, targets, mode === 'copy' ? 'quiet' : 'wakeup', actor)
      return { front: (await this.#load(report)).front, outcomes }
    })
  }

  /**
   * Read a report's digest, body, and complete transfer path.
   * @param report - report identifier.
   * @param actor - reading session id.
   * @returns the model-facing rendering.
   */
  async read(report: string, actor: string): Promise<string> {
    const found = await this.#load(report)
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
    // A lease's current state is derived from the hop stream, so it is not in the
    // digest and cannot appear in renderFrontLine. Rendering it here is the
    // difference between a reader seeing who holds a checkout and a reader
    // counting hops by eye.
    const worktree = found.front.worktree
    const lease = worktree === undefined ? [] : [
      `lease=${leaseState(hops)} ${worktree.branch ?? '(detached HEAD)'} @ ${worktree.path}`
      + ` (${worktree.allocated === true ? 'allocated by the ledger' : 'adopted'})`,
    ]
    return [
      renderFrontLine(found.front),
      ...lease,
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
  async list(filter: { session?: string; status?: string; task?: string; worktree?: string; limit?: number } = {}): Promise<DigestRow[]> {
    const all = await listReports()
    const session = filter.session
    const task = filter.task?.trim().toLowerCase()
    const worktree = filter.worktree?.trim().toLowerCase()
    const matching = all.filter((front) => {
      if (filter.status !== undefined && front.status !== filter.status) return false
      // A task label is a grouping key, matched case-insensitively as a substring
      // so a partial label is enough to pull up a whole collaboration — the point
      // of the filter is discovery across trees, where an exact-match typo would
      // silently return nothing.
      if (task !== undefined && task !== '' && !(front.task ?? '').toLowerCase().includes(task)) return false
      // A working-tree filter searches the branch and the path together, because
      // a caller may know either: the branch when tracing a lease, the directory
      // when tracing a checkout they can see on disk.
      if (worktree !== undefined && worktree !== '') {
        if (front.worktree === undefined) return false
        const haystack = `${front.worktree.branch ?? ''} ${front.worktree.path}`.toLowerCase()
        if (!haystack.includes(worktree)) return false
      }
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
      ...(front.worktree === undefined ? {} : { worktree: worktreeLabel(front.worktree) }),
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
      const current = await this.#load(report)
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
      return { front: (await this.#load(report)).front, outcomes: [] }
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
   * @param options - what to do with a bound working tree on disk.
   * @returns the refreshed digest, and what happened to the working tree.
   * @throws when the actor is neither the originator nor a co-author.
   */
  async close(
    report: string,
    actor: string,
    note?: string,
    options: { worktree?: 'keep' | 'remove-if-clean' } = {},
  ): Promise<MutationResult> {
    return this.#withLock(report, async () => {
      const current = await this.#load(report)
      this.#assertOwner(current.front, actor, 'close', 'closing')
      const binding = current.front.worktree
      // A concluded report cannot be holding a checkout against anyone, so
      // closing releases the lease whatever happens to the directory next.
      if (binding !== undefined && leaseState(await readHops(report)) === 'held') {
        await this.#record(report, {
          at: Date.now(),
          actor,
          action: 'released',
          to: [],
          note: 'released by closing the report',
        })
      }
      // The default is to leave a working tree exactly as its owner left it, and
      // the opt-in removal goes through git without a force flag — so an unclean
      // tree refuses here, and the refusal is reported rather than swallowed. A
      // close that quietly deleted work would be the worst kind of success.
      let outcome: WorktreeOutcome | undefined
      if (binding !== undefined) {
        if (options.worktree !== 'remove-if-clean') {
          outcome = { action: 'kept' }
        } else {
          const repo = await resolveRepo(binding.path)
          if (repo === undefined) {
            outcome = { action: 'refused', detail: `${binding.path} is no longer inside a git repository` }
          } else {
            const removed = await removeWorktree(repo, binding.path)
            outcome = removed.ok
              ? { action: 'removed' }
              : { action: 'refused', detail: removed.stderr.trim() }
          }
        }
      }
      const disposition = outcome === undefined
        ? undefined
        : outcome.action === 'removed'
          ? 'working tree removed'
          : outcome.action === 'kept'
            ? 'working tree kept'
            : `working tree kept: ${outcome.detail ?? 'removal refused'}`
      // A removal the ledger performed is recorded as such, whatever asked for
      // it. Without this the binding would stay `released` with nothing on disk,
      // which is indistinguishable from a checkout that vanished behind the
      // ledger's back — so every deliberate removal would be reported as an
      // anomaly, and an alarm that fires on the recommended workflow is one
      // readers learn to ignore.
      if (outcome?.action === 'removed') {
        await this.#record(report, {
          at: Date.now(),
          actor,
          action: 'reclaimed',
          to: [],
          note: `checkout ${binding?.path ?? ''} removed at the owner's request`,
        })
      }
      const closedNote = [note, disposition]
        .filter((part): part is string => part !== undefined && part !== '')
        .join('; ')
      const front = await this.#record(report, {
        at: Date.now(),
        actor,
        action: 'closed',
        to: [],
        ...(closedNote === '' ? {} : { note: closedNote }),
      })
      const fresh = await this.#load(report)
      await writeReport({ front: { ...fresh.front, status: 'closed', updated: Date.now() }, body: fresh.body })
      return {
        front: (await this.#load(report)).front,
        outcomes: [],
        ...(outcome === undefined ? {} : { worktree: outcome }),
      }
    })
  }

  /**
   * Claim a working tree for a report.
   *
   * The decision runs under two mutexes, outer first: the working tree's,
   * because two reports racing for one branch is exactly what a per-report mutex
   * cannot see, and then the report's, because writing the digest still races
   * other mutations of the same report. Only this method nests them —
   * {@link ReportService.release} takes the report lock alone, since giving a
   * claim up needs no atomicity against the filesystem — so the order is fixed
   * and cannot form the cycle that would deadlock.
   *
   * Re-claiming is allowed and is how a binding is refreshed (a new head, a
   * corrected path): the report already holding it is skipped by the referee, so
   * refreshing needs no release first. It is still recorded, because the audit
   * is the product.
   * @param report - report identifier.
   * @param actor - the claiming session; must own the report.
   * @param binding - the working tree to claim.
   * @returns the refreshed digest.
   * @throws when git or the ledger refuses the claim.
   */
  async lease(
    report: string,
    actor: string,
    binding: ReportWorktree,
  ): Promise<MutationResult> {
    // Resolved once, and outside the lock: the repository is both the question
    // the referee asks and the key the mutex is taken under, and a branch is
    // held by a repository rather than by a checkout. It is also I/O, and doing
    // it inside the critical section would hold the lock across a subprocess.
    const repo = await resolveRepo(binding.path)
      ?? (binding.repo === undefined ? undefined : await resolveRepo(binding.repo))
    const key = compareKey(repo?.commonDir ?? binding.path)
    return await this.#withRepoLock(key, async () => await this.#withLock(report, async () => {
      const current = await this.#load(report)
      this.#assertOwner(current.front, actor, 'lease', 'leasing')
      const verdict = await evaluateLease({
        binding,
        repo,
        report,
        digests: await listReports(),
        hopsOf: async (id) => await readHops(id),
      })
      if (verdict.kind === 'refused') throw new Error(`report-ledger: ${verdict.refusal.message}`)
      // The referee's binding, not the caller's: it is the side that read git, so
      // the digest records the branch and commit that are really there.
      const claim = verdict.binding
      await writeReport({
        front: { ...current.front, worktree: claim, updated: Date.now() },
        body: current.body,
      })
      const front = await this.#record(report, {
        at: Date.now(),
        actor,
        action: 'leased',
        to: [],
        note: `${claim.branch ?? '(detached HEAD)'} @ ${claim.path}`,
      })
      return { front, outcomes: [] }
    }))
  }

  /**
   * Give up a report's claim on its working tree, without touching the disk.
   *
   * The binding stays in the digest on purpose. A checkout kept on disk must
   * remain traceable to the report that made it — otherwise the ledger forgets
   * which working trees it is responsible for, and a later cleanup could not
   * tell its own from a stranger's. What ended is the claim, and the hop stream
   * is where that is recorded.
   * @param report - report identifier.
   * @param actor - the releasing session; must own the report.
   * @param note - optional note.
   * @returns the refreshed digest.
   * @throws when the report holds nothing, or the actor is not an owner.
   */
  async release(report: string, actor: string, note?: string): Promise<MutationResult> {
    return await this.#withLock(report, async () => {
      const current = await this.#load(report)
      this.#assertOwner(current.front, actor, 'release', 'releasing')
      if (current.front.worktree === undefined) {
        throw new Error(`report-ledger: ${report} is not bound to a working tree, so there is nothing to release`)
      }
      if (leaseState(await readHops(report)) !== 'held') {
        throw new Error(
          `report-ledger: ${report} does not currently hold its working tree, so there is nothing to release `
          + '(a claim is released once; closing a report releases it too)',
        )
      }
      const front = await this.#record(report, {
        at: Date.now(),
        actor,
        action: 'released',
        to: [],
        ...(note === undefined ? {} : { note }),
      })
      return { front, outcomes: [] }
    })
  }

  /**
   * Create the working tree a report is about to be given, and clear room for it.
   *
   * Separate from {@link ReportService.lease} because it runs *before* the
   * report exists: a working tree's name is derived from the report id, and the
   * caller needs the checkout's path to hand a peer its working directory. So
   * the order is claim the id, provision the checkout, then author — and this is
   * the middle step.
   *
   * Runs under the repository mutex, because the budget it consults and the
   * branch it takes are both repository-wide facts that two concurrent
   * allocations would otherwise read at the same moment.
   * @param input - what to provision, and for whom.
   * @returns the binding to record, plus what housekeeping happened.
   * @throws when a gate refuses the allocation or git cannot create the tree.
   */
  async prepareWorktree(input: {
    readonly report: string
    readonly subject: string
    readonly actor: string
    readonly repo: RepoLocation
    readonly base: string
    readonly settings: WorktreeSettings
  }): Promise<PreparedWorktree> {
    return await this.#withRepoLock(compareKey(input.repo.commonDir), async () => {
      const plan = await planAllocation({
        report: input.report,
        subject: input.subject,
        repo: input.repo,
        digests: await listReports(),
        hopsOf: async (id) => await readHops(id),
        isLive: (sessionId) => this.#host.getAgent(sessionId) !== undefined,
      }, input.settings)
      if ('kind' in plan) throw new Error(`report-ledger: ${plan.message}`)

      for (const gone of plan.stale) await this.#recordVanished(input.actor, gone)
      if (plan.reclaimed !== undefined) await this.#reclaim(input.actor, plan.reclaimed)

      const created = await this.#createWorktree(input.repo, plan.binding, input.base, input.settings.relativePaths)
      if (!created.ok) throw new Error(`report-ledger: ${created.reason}`)

      // Read the head off the checkout that now exists rather than predicting it,
      // so the binding records what git actually produced.
      const head = await headOf(plan.binding.path)
      return {
        binding: { ...plan.binding, ...(head === undefined ? {} : { head }) },
        retained: plan.retained,
        reclaimSkipped: plan.reclaimSkipped,
        stale: plan.stale,
        ...(plan.reclaimed === undefined ? {} : { reclaimed: plan.reclaimed }),
      }
    })
  }

  /**
   * Attach the linked working tree, recovering from a branch left by a crash.
   *
   * A previous attempt can have created the branch and then failed before the
   * checkout existed, which leaves `-b` permanently refused on that name. Falling
   * back to checking the existing branch out is what makes the retry work rather
   * than dead-end, and it cannot take a live claim: git still refuses a branch
   * another working tree holds.
   */
  async #createWorktree(
    repo: RepoLocation,
    binding: ReportWorktree & { readonly branch: string },
    base: string,
    relativePaths: boolean,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const first = await addWorktree({
      repo, path: binding.path, branch: binding.branch, base, relativePaths,
    })
    if (first.ok) return { ok: true }
    if (classifyGitRefusal(first.stderr) !== 'branch-exists') {
      return { ok: false, reason: `could not create a working tree at ${binding.path}: ${first.stderr.trim()}` }
    }
    const retry = await addWorktree({
      repo, path: binding.path, branch: binding.branch, checkoutExisting: true, relativePaths,
    })
    if (retry.ok) return { ok: true }
    return {
      ok: false,
      reason: `the branch ${binding.branch} already existed and could not be checked out at ${binding.path}: ${retry.stderr.trim()}`,
    }
  }

  /**
   * Record that a checkout the ledger believed it owned has already vanished.
   *
   * Nothing is removed — there is nothing left to remove — so this exists purely
   * because leaving the belief in place is not free: the binding would be
   * re-examined as a reclamation candidate on every later allocation, and a
   * candidate whose directory is missing fails the cleanliness check, so it
   * would be reported as having uncommitted changes. That sentence is wrong, and
   * it is the kind of wrong that sends a reader looking for work nobody left.
   *
   * The hop is administrative, recorded with `touch: false` for the same reason
   * a reclamation is: a vanished checkout is not a concluded report becoming
   * active again.
   */
  async #recordVanished(actor: string, gone: StaleBinding): Promise<void> {
    await this.#withLock(gone.report, async () => {
      if (!reportExists(gone.report)) return
      await this.#record(gone.report, {
        at: Date.now(),
        actor,
        action: 'reclaimed',
        to: [],
        note: `checkout ${gone.path} was already gone; nothing to remove`,
      }, { touch: false })
    })
  }

  /**
   * Clear a checkout whose claim already ended, and record that it happened.
   *
   * Removal goes through git without a force flag, so an unclean tree refuses
   * here exactly as it would for a human — and that refusal aborts the
   * allocation rather than being stepped over, because taking something away is
   * never the safe default.
   *
   * The hop is recorded with `touch: false`: clearing litter must not make a
   * concluded report look like it just became active and float it to the top of
   * every listing. It is still recorded, because taking something away from
   * another report is precisely the act an audit exists for.
   */
  async #reclaim(actor: string, target: ReclaimedLease): Promise<void> {
    const repo = await resolveRepo(target.path)
    if (repo !== undefined) {
      const removed = await removeWorktree(repo, target.path)
      if (!removed.ok) {
        throw new Error(
          `report-ledger: refusing to reclaim ${target.path} from ${target.report} — ${removed.stderr.trim()}`,
        )
      }
    }
    await this.#withLock(target.report, async () => {
      if (!reportExists(target.report)) return
      await this.#record(target.report, {
        at: Date.now(),
        actor,
        action: 'reclaimed',
        to: [],
        note: `checkout ${target.path} cleared to stay within the retained budget`,
      }, { touch: false })
    })
  }

  /**
   * Undo a provisioning that a later step could not use.
   *
   * Deliberately without a force flag: a checkout that something has already
   * modified refuses to go, and it should — the failure that triggered the
   * rollback is not a licence to discard work. The caller is told whether the
   * cleanup happened rather than being left to assume it did.
   * @param binding - the binding whose checkout should go.
   * @returns true when the checkout was removed.
   */
  async discardWorktree(binding: ReportWorktree): Promise<boolean> {
    const repo = await resolveRepo(binding.path)
    if (repo === undefined) return false
    const removed = await removeWorktree(repo, binding.path)
    return removed.ok
  }

  /**
   * Claim an id and provision a working tree for a report that does not exist yet.
   *
   * The two halves of a checkout's identity are circular: its branch and
   * directory are named after the report, and the caller needs its path *before*
   * the report is authored — a peer has to be created in it. This breaks the
   * circle by claiming the id first, and gives the claim back if provisioning
   * fails, so a failure does not burn a number.
   * @param input - what to provision, and for whom.
   * @returns the claimed id and the provisioned checkout.
   * @throws when the session has no directory, is not in a repository, is in one
   * with no commit, or a gate refuses the allocation.
   */
  async provision(input: {
    readonly subject: string
    readonly actor: string
    readonly settings: WorktreeSettings
  }): Promise<{ readonly report: string; readonly prepared: PreparedWorktree }> {
    const cwd = this.#host.selfCwd?.(input.actor)
    if (cwd === undefined) {
      throw new Error(
        `report-ledger: cannot allocate a working tree for ${input.actor} — the session has no working directory, `
        + 'so there is no repository to allocate one in',
      )
    }
    const repo = await resolveRepo(cwd)
    if (repo === undefined) {
      throw new Error(
        `report-ledger: ${cwd} is not inside a git repository, so there is no repository to allocate a working tree in`,
      )
    }
    // The caller's own HEAD, read as a commit rather than handed over as "HEAD":
    // a commit-ish is resolved in the repository, so bare `HEAD` would give the
    // *main* worktree's branch, which is not what the caller is standing on.
    const base = await headOf(cwd)
    if (base === undefined) {
      throw new Error(`report-ledger: ${cwd} has no commit yet, so there is nothing to branch a working tree from`)
    }
    const report = await allocateId()
    try {
      const prepared = await this.prepareWorktree({
        report,
        subject: input.subject,
        actor: input.actor,
        repo,
        base,
        settings: input.settings,
      })
      return { report, prepared }
    } catch (error) {
      await discardUnwrittenId(report)
      throw error
    }
  }

  /**
   * Undo a provisioning whose report never got authored.
   *
   * A step after provisioning can fail — a peer that cannot be created, an
   * authoring error — and without this the caller would leave a checkout and a
   * burned number behind. Both halves are best-effort and reported rather than
   * assumed: a checkout refuses to go once anything has touched it, and that
   * refusal is the correct outcome, not an error to swallow.
   * @param provisioned - what {@link ReportService.provision} returned.
   * @returns what was actually undone.
   */
  async rollbackProvision(
    provisioned: { readonly report: string; readonly prepared: PreparedWorktree },
  ): Promise<{ readonly worktree: boolean; readonly id: boolean }> {
    const worktree = await this.discardWorktree(provisioned.prepared.binding)
    const id = await discardUnwrittenId(provisioned.report)
    return { worktree, id }
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
      const current = await this.#load(report)
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
          await writeReport({ front: (await this.#load(report)).front, body: patch.body })
        } else {
          const name = await this.#host.describe(actor)
          const header = `\n\n---\n\n### amendment by ${name ?? actor} at ${new Date().toISOString()}\n\n`
          await appendFile(reportPath(report), `${header}${patch.body.trim()}\n`, 'utf8')
        }
      }

      if (next.subject !== undefined || next.task !== undefined || next.artifacts !== undefined) {
        const base = await this.#load(report)
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
  const worktree = row.worktree === undefined ? '' : ` wt=${row.worktree}`
  return `${row.report} [${row.status}] ${row.subject}${task}${worktree} | from=${row.from} to=${row.to.length === 0 ? '-' : row.to.join(',')} cc=${row.cc.length === 0 ? '-' : row.cc.join(',')} hops=${row.hops} last=${last}`
}
