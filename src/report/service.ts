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

import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { mentions } from './assets.ts'
import { planAllocation, type StaleBinding, type WorktreeSettings } from './allocate.ts'
import type { AgentLike } from './deliver.ts'
import { deliver, pendingMode, pendingTargets, type DeliveryOutcome } from './deliver.ts'
import { evaluateLease, leaseState } from './lease.ts'
import { allocateId, appendHop, appendReportBody, bodyStartLine, discardUnwrittenId, isValidReportId, listReports, readHops, readReport, reportExists, reportPath, routePath, writeReport } from './ledger.ts'
import {
  addWorktree, classifyGitRefusal, compareKey, headOf, isWorktreeClean, removeWorktree, resolveRepo, samePath,
  unmergedCommitCount,
} from './worktree.ts'
import type { RepoLocation } from './worktree.ts'
import type { DeliveryMode, Report, ReportFrontMatter, ReportStatus, ReportWorktree, RouteHop } from './types.ts'
import { HOP_ACTIONS, type HopAction } from './types.ts'

/** Body size above which `report_read` returns a paged pointer instead of everything. */
const BODY_INLINE_LIMIT = 8000

/** How many characters of a body are shown when it exceeds the inline limit. */
const BODY_HEAD_LIMIT = 1200

/** A subject is one line; a newline would forge a second row in report_list. */
function oneLineSubject(subject: string): string {
  return subject.trim().replace(/\s*\r?\n\s*/g, ' ')
}

/**
 * Trim recipient ids and drop blanks.
 *
 * A whitespace-only id used to be appended to a hop but discarded by the read
 * path, so the sender believed it had addressed someone the ledger never showed.
 * If the caller supplied recipients but none survive, that is an error, not a
 * silent no-op.
 */
function cleanTargets(targets: readonly string[], verb: string): string[] {
  const cleaned = targets.map((target) => target.trim()).filter((target) => target !== '')
  if (targets.length > 0 && cleaned.length === 0) {
    throw new Error(`report-ledger: ${verb} recipients must be non-empty session ids`)
  }
  return cleaned
}

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
  /**
   * A risk the mutation recorded but did not act on.
   *
   * Release uses it for a kept checkout whose work is uncommitted or on an
   * unmerged branch; the warning is also written into the hop's note.
   */
  readonly warning?: string
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
  /** How many ended claims in this repository still have a checkout on disk. */
  readonly retained: number
  /** Bindings whose checkout had already vanished, now recorded as such. */
  readonly stale: readonly StaleBinding[]
}

/** What a mutation did, or tried to do, about a working tree on disk. */
export interface WorktreeOutcome {
  /** `kept` when the tree was deliberately left alone, `removed` on success, `refused` on failure. */
  readonly action: 'kept' | 'removed' | 'refused'
  /** Why a removal was refused, in git's own words. */
  readonly detail?: string
  /**
   * What is worth knowing about a kept checkout.
   *
   * Present when closing keeps a checkout that has uncommitted work, or a branch
   * with commits the repository's current branch does not contain: exactly the
   * shapes that become orphaned once the report stops being live work.
   */
  readonly warning?: string
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
  /** How many of those hops were reads. */
  readonly reads: number
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

/** A truncated head of a body, with the number of document lines it spans. */
interface BodyHead {
  /** The head text itself. */
  readonly text: string
  /** How many lines the head occupies. */
  readonly lines: number
}

/**
 * Cut a body head to a character budget without splitting a surrogate pair.
 *
 * The budget is expressed in characters because that is what a model reads, but
 * `slice` counts UTF-16 code units: a cut inside an astral character (an emoji, a
 * rare CJK ideograph) leaves a lone surrogate that renders as a replacement
 * glyph and can even corrupt the surrounding text. Backing up one unit when the
 * cut lands on a high surrogate keeps the excerpt a valid string.
 * @param body - the rendered body.
 * @param budget - maximum characters to keep.
 * @returns the head text and its line count.
 */
function bodyHead(body: string, budget: number): BodyHead {
  if (body.length <= budget) return { text: body, lines: body.split('\n').length }
  let end = budget
  const last = body.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  const text = body.slice(0, end)
  return { text, lines: text.split('\n').length }
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
    `reads=${front.reads}`,
    `updated=${new Date(front.updated).toISOString()}`,
  ]
  if (front.task !== undefined) parts.push(`task=${front.task}`)
  if (front.worktree !== undefined) parts.push(`worktree=${worktreeLabel(front.worktree)}@${front.worktree.path}`)
  if (front.parent !== undefined) parts.push(`parent=${front.parent}`)
  if (front.children.length > 0) parts.push(`children=${front.children.join(',')}`)
  if (front.last !== undefined) parts.push(`last=${front.last.action}@${front.last.actor}`)
  return parts.join(' | ')
}

/**
 * One line counting hops by action, in the canonical action order.
 *
 * This is the statistics exit the digest split made necessary: "how much of this
 * path is reads" used to be answerable only by reading the JSONL by hand — and
 * because reading through the tool records a read, doing that measurement changed
 * the thing measured. A tally rendered from the same hop stream costs nothing and
 * leaves the ledger alone.
 * @param hops - the report's complete transfer path.
 * @returns the counting line.
 */
function tallyHops(hops: readonly RouteHop[]): string {
  const counts = new Map<HopAction, number>()
  for (const hop of hops) counts.set(hop.action, (counts.get(hop.action) ?? 0) + 1)
  const parts = HOP_ACTIONS
    .filter((action) => counts.has(action))
    .map((action) => `${action} ${counts.get(action) ?? 0}`)
  return `${hops.length} hop(s): ${parts.join(', ')}`
}

/**
 * Derive the route projection from the authoritative hop stream.
 *
 * Two of these fields exist to answer questions the hop stream alone answers too
 * expensively, and both are deliberately narrower than "the last thing recorded":
 *
 *  - `hops` counts every recorded event, because its job is to certify that the
 *    full path exists and how long it is;
 *  - `reads` counts the subset that were reads, because a read is an audit fact
 *    rather than a causal act, and folding it into the work signal left readers
 *    subtracting by hand (the exact cost this field removes);
 *  - `last` is the most recent **causal** hop. It answers "where is this now", and
 *    somebody looking at a report does not move it — with reads included, 12 of 67
 *    reports on this machine showed `last=read@…`, i.e. a glance masqueraded as
 *    activity.
 */
function projectRoute(hops: readonly RouteHop[]): Pick<ReportFrontMatter, 'to' | 'cc' | 'authors' | 'hops' | 'reads' | 'last'> {
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
    // A transfer addresses the report to the session that took the obligation
    // over. The session that handed it on keeps its place in `to`: it WAS
    // addressed, and who has held this report is not something a later hop may
    // erase from the digest.
    if (hop.action === 'transferred') {
      for (const target of hop.to) if (!to.includes(target)) to.push(target)
    }
  }
  let reads = 0
  let tail: RouteHop | undefined
  for (const hop of hops) {
    if (hop.action === 'read') {
      reads += 1
      continue
    }
    tail = hop
  }
  return {
    to,
    cc,
    authors,
    hops: hops.length,
    reads,
    ...(tail === undefined ? {} : { last: { at: tail.at, action: tail.action, actor: tail.actor } }),
  }
}

/**
 * One hand-off the ledger still owes a session.
 *
 * The mode is carried because the two answers are not interchangeable: an
 * addressed hand-off will open a turn when it lands, while a carbon copy will
 * not. A caller that is about to resume a session (and spend its context) needs
 * to know which one it is holding before it decides the wake is worth anything.
 */
export interface PendingHandoff {
  /** The report the obligation belongs to. */
  readonly report: string
  /** That report's current status, because a concluded report changes what is left to do. */
  readonly status: ReportStatus
  /** Whether delivering it requests a turn or only adds context. */
  readonly mode: DeliveryMode
}

/** One digest brought back in line with its hop stream. */
export interface DigestRepair {
  /** The report it concerns. */
  readonly report: string
  /** Whether the stored digest disagreed with the hop stream. */
  readonly changed: boolean
  /** The counters the document carried. */
  readonly stored: string
  /** The counters its hop stream derives. */
  readonly derived: string
  /** Why it was left unwritten, when it was. */
  readonly skipped?: string
}

/** The counters a repair compares, rendered so a dry run reads like the real thing. */
function digestCounters(front: Pick<ReportFrontMatter, 'hops' | 'reads'> & { readonly last?: ReportFrontMatter['last'] }): string {
  const last = front.last === undefined ? '-' : `${front.last.action}@${front.last.actor}`
  return `hops=${front.hops} reads=${front.reads} last=${last}`
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
    // A report whose digest says it has hops but whose sidecar is gone is a
    // damaged record, not a new one. Appending would start a fresh path and the
    // next #sync would project that empty history over the digest — erasing the
    // recipients and co-authors. Refuse and leave the damage visible instead.
    const current = await readReport(report)
    if (current !== undefined && current.front.hops > 0 && !existsSync(routePath(report))) {
      throw new Error(
        `report-ledger: ${report}'s transfer path is missing while its digest records ${current.front.hops} hops; `
        + 'refusing to rewrite the report from an empty history. Restore the .route.jsonl file first.',
      )
    }
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
    // The destination is the id this operation is about, never the digest's own
    // identity field: a hand-edited identity must not redirect the write.
    await writeReport({ front, body: current.body }, report)
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
    // One target at a time: a failing steer/inject must not discard the arrivals
    // that already happened earlier in the batch. The caller gets an aggregate
    // error naming both sides instead of a blanket "send failed".
    const outcomes: DeliveryOutcome[] = []
    const failures: string[] = []
    for (const target of new Set(targets)) {
      try {
        outcomes.push(...await deliver(this.#host, front, reportPath(front.report), [target], mode))
      } catch (error) {
        failures.push(`${target} (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    const arrivals = outcomes.filter((outcome) => outcome.status === 'delivered')
    if (arrivals.length > 0) {
      const at = Date.now()
      for (const arrival of arrivals) {
        await appendHop(front.report, { at, actor, action: 'delivered', to: [arrival.targetId], note: mode })
      }
      await this.#sync(front.report)
    }
    if (failures.length > 0) {
      const delivered = arrivals.map((arrival) => arrival.targetId).join(', ') || 'nobody'
      throw new Error(
        `report-ledger: delivered to ${delivered}; failed for ${failures.join('; ')}. `
        + 'The failures remain pending and will be retried by the delivery sweep.',
      )
    }
    return outcomes
  }

  /**
   * Create a report and optionally hand it to its first recipients.
   * @param input - authoring input.
   * @returns the created digest and any immediate delivery outcomes.
   */
  async author(input: AuthorInput): Promise<MutationResult> {
    const subject = oneLineSubject(input.subject)
    if (subject === '') throw new Error('report-ledger: report_author requires a non-empty subject')
    const to = cleanTargets(input.to ?? [], 'report_author')
    const cc = cleanTargets(input.cc ?? [], 'report_author')
    // A caller that had to know the id in advance — because it names the working
    // tree it is about to create — claims the id itself and passes it back.
    const allocated = input.reportId === undefined
    const report = input.reportId ?? await allocateId()
    const now = Date.now()
    try {
      if (!isValidReportId(report)) {
        throw new Error(`report-ledger: ${JSON.stringify(report)} is not a usable report id (expected the form R-0001)`)
      }
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
        reads: 0,
        ...(input.parent === undefined ? {} : { parent: input.parent }),
        ...(input.task === undefined ? {} : { task: input.task }),
        ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
      }
      await writeReport({ front, body: input.body }, report)
    } catch (error) {
      // Allocating an id claims it by creating an empty document. Anything that
      // fails before the document exists has to give the name back, or a failed
      // author burns a number and leaves a placeholder no listing will show. An
      // id handed in by the caller is not ours to give back: it belongs to a
      // provisioning that rolls itself back (`rollbackProvision`).
      if (allocated) await discardUnwrittenId(report)
      throw error
    }
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
          await writeReport(
            { front: { ...latest.front, children, updated: Date.now() }, body: latest.body },
            input.parent as string,
          )
        })
      }
    }

    let outcomes: DeliveryOutcome[] = []
    if (to.length > 0) {
      const sent = await this.#record(report, { at: Date.now(), actor: input.actor, action: 'sent', to })
      refreshed = sent
      outcomes = await this.#deliver(sent, to, 'wakeup', input.actor)
    }
    // A session named in both lists was addressed, and addressing wins: copying
    // it as well would deliver the same digest twice and record two arrivals for
    // one intended hand-off. The carbon copy adds nothing the address did not.
    const copies = [...new Set(cc.filter((target) => !to.includes(target)))]
    if (copies.length > 0) {
      const copied = await this.#record(report, { at: Date.now(), actor: input.actor, action: 'cc', to: copies })
      refreshed = copied
      outcomes = [...outcomes, ...await this.#deliver(copied, copies, 'quiet', input.actor)]
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
   * Throw unless the actor holds the report as an originator, author or recipient.
   *
   * A receipt says "the one this was handed to has it", and a sender reads it as
   * the delivery having landed. Listing and reading are open to every session, so
   * without this check any agent that merely saw a row could acknowledge on
   * behalf of a recipient that never received anything — closing the sender's
   * loop on a hand-off that did not land. Carbon copies are recipients too: a
   * quiet copy is still a copy, and it is the one who may confirm it.
   * @param front - the report's digest.
   * @param actor - the session attempting to acknowledge.
   * @throws when the actor is none of the above.
   */
  #assertRecipient(front: ReportFrontMatter, actor: string): void {
    const recipients = [...new Set([front.from, ...front.authors, ...front.to, ...front.cc])]
    if (recipients.includes(actor)) return
    throw new Error(
      `report-ledger: ${actor} may not acknowledge ${front.report} — a receipt is a recipient's confirmation, not a bystander's. `
      + (recipients.length === 0
        ? 'It has not been addressed to anyone yet.'
        : `It was addressed to: ${recipients.join(', ')}`),
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
    await writeReport({ front: { ...fresh.front, status: 'open', updated: Date.now() }, body: fresh.body }, report)
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
      await appendReportBody(report, `${header}${text}\n`)
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
    const cleaned = cleanTargets(targets, 'report_send')
    if (cleaned.length === 0) throw new Error('report-ledger: report_send requires at least one recipient')
    return this.#withLock(report, async () => {
      await this.#load(report)
      await this.#reopenIfClosed(report, actor)
      const front = await this.#record(report, {
        at: Date.now(),
        actor,
        action: 'sent',
        to: cleaned,
        ...(note === undefined ? {} : { note }),
      })
      const outcomes = await this.#deliver(front, cleaned, 'wakeup', actor)
      return { front: (await this.#load(report)).front, outcomes }
    })
  }

  /**
   * Move one unpaid hand-off from the session that owes it to another.
   *
   * This is the one gap a hand-off cannot close by itself. A delivery to a session
   * that will never come back stays owed forever — pending is derived from the
   * audit trail, and nothing in it can be unsaid. A transfer is how the ledger
   * records the truthful alternative: the obligation still exists, it is owed by
   * someone else now. It is deliberately NOT recorded as an arrival, so no reader
   * can mistake it for "delivered".
   *
   * Authority is narrower than sending, and for a reason. An owner may move an
   * outstanding hand-off (it is the report's dispatch to direct), and the session
   * that is currently owed it may hand its own obligation on (it is the party that
   * cannot discharge it). Neither may pre-empt a delivery that already arrived.
   * @param report - report identifier.
   * @param actor - acting session id.
   * @param from - the session that currently owes the hand-off.
   * @param to - the session that takes it over.
   * @param note - optional hop note.
   * @returns the refreshed digest and delivery outcomes.
   */
  async transfer(
    report: string,
    actor: string,
    from: string,
    to: string,
    note?: string,
  ): Promise<MutationResult> {
    if (from.trim() === '' || to.trim() === '') throw new Error('report-ledger: a transfer needs both sessions')
    if (from === to) throw new Error('report-ledger: a transfer to the same session would not move anything')
    return this.#withLock(report, async () => {
      const current = await this.#load(report)
      const hops = await readHops(report)
      const owed = pendingTargets(hops)
      if (!owed.includes(from)) {
        throw new Error(
          `report-ledger: ${report} owes nothing to ${from}; a transfer moves an outstanding hand-off, `
          + `and the sessions still owed it are: ${owed.length === 0 ? '(none)' : owed.join(', ')}`,
        )
      }
      if (!ReportService.owns(current.front, actor) && actor !== from) {
        throw new Error(
          `report-ledger: ${actor} may not transfer ${report}'s hand-off from ${from} — moving it is either the `
          + `owner's act or the act of the session that owes it`,
        )
      }
      // The obligation keeps the wake policy it was created with: a quiet copy
      // stays quiet, an addressed hand-off keeps waking.
      const mode = pendingMode(hops, from)
      await this.#reopenIfClosed(report, actor)
      const front = await this.#record(report, {
        at: Date.now(),
        actor,
        action: 'transferred',
        from,
        to: [to],
        ...(note === undefined ? {} : { note }),
      })
      const outcomes = await this.#deliver(front, [to], mode, actor)
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
    const cleaned = cleanTargets(targets, 'report_cc')
    if (cleaned.length === 0) throw new Error('report-ledger: report_cc requires at least one recipient')
    return this.#withLock(report, async () => {
      await this.#load(report)
      await this.#reopenIfClosed(report, actor)
      const front = await this.#record(report, {
        at: Date.now(),
        actor,
        action: 'cc',
        to: cleaned,
        ...(note === undefined ? {} : { note }),
      })
      const outcomes = await this.#deliver(front, cleaned, 'quiet', actor)
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
    const cleaned = cleanTargets(targets, 'report_forward')
    if (cleaned.length === 0) throw new Error('report-ledger: report_forward requires at least one target')
    return this.#withLock(report, async () => {
      await this.#load(report)
      await this.#reopenIfClosed(report, actor)
      const front = await this.#record(report, {
        at: Date.now(),
        actor,
        action: mode === 'copy' ? 'copied' : 'forwarded',
        to: cleaned,
        ...(note === undefined ? {} : { note }),
      })
      const outcomes = await this.#deliver(front, cleaned, mode === 'copy' ? 'quiet' : 'wakeup', actor)
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
    // A read records a hop, and recording a hop rewrites the document — so a read
    // is a writer and takes the same per-report mutex as every other writer. It
    // used to run unlocked, which let it collide with a mutation's rename (an
    // `EPERM` out of a tool that is nominally read-only) and let its
    // full-document rewrite land over a just-appended section.
    return await this.#withLock(report, async () => {
      const found = await this.#load(report)
      const hops = await readHops(report)
      // `touch: false`: the hop is still recorded, but a read is not activity
      // that should make an old or concluded report look freshly updated in a
      // listing, where `updated` is the sort key.
      //
      // This read is part of its own report: the response is rendered from
      // `recorded` and from the extended path, so the digest, the tally and the
      // route all include it. A view that omitted the reader's own look would
      // answer "how much of this was reading" with an off-by-one that changes
      // between two identical calls.
      const readHop: RouteHop = { at: Date.now(), actor, action: 'read', to: [] }
      const recorded = await this.#record(report, readHop, { touch: false })
      const pathHops = [...hops, readHop]
      const tally = tallyHops(pathHops)
      const path = reportPath(report)
      const body = found.body.trim()
      let rendered = body
      if (body.length > BODY_INLINE_LIMIT) {
        const head = bodyHead(body, BODY_HEAD_LIMIT)
        // The pointer is a line offset, not a character one: give the file line at
        // which the body starts, add the lines the head spans, and the model can
        // resume exactly where the excerpt stopped instead of re-reading the head.
        // `head.lines - 1` names the line the cut lands in; the read tool returns
        // whole lines, so re-reading that one line is the safe resume point
        // whether the cut fell mid-line or exactly on a line break.
        const start = (await bodyStartLine(report)) ?? 1
        const resume = start + head.lines - 1
        rendered = `${head.text}\n\n… body truncated (${body.length} chars total). `
          + `The next unread line is ${resume}; read the rest with the read tool at ${path} using offset=${resume}.`
      }
      const route = pathHops.length === 0
        ? '  (no hops recorded)'
        : pathHops.map((hop) => {
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
        renderFrontLine(recorded),
        ...lease,
        `body=${path}`,
        '',
        '## transfer path',
        tally,
        route,
        ...(pending.length === 0 ? [] : ['', `## still pending delivery to: ${pending.join(', ')}`]),
        '',
        '## body',
        rendered,
      ].join('\n')
    })
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
      reads: front.reads,
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
      this.#assertRecipient(current.front, actor)
      const front = await this.#record(report, {
        at: Date.now(),
        actor,
        action: 'acked',
        to: [],
        ...(note === undefined ? {} : { note }),
      })
      if (current.front.status === 'open') {
        await writeReport({ front: { ...front, status: 'acked', updated: Date.now() }, body: current.body }, report)
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
          const warning = await this.#checkoutWarning(binding)
          outcome = warning === undefined ? { action: 'kept' } : { action: 'kept', warning }
        } else {
          const refusal = await this.#removalRefusal(report, binding)
          if (refusal !== undefined) {
            outcome = { action: 'refused', detail: refusal }
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
      const closedNote = [
        note,
        disposition,
        outcome?.warning === undefined ? undefined : `warning: ${outcome.warning}`,
      ]
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
      await writeReport({ front: { ...fresh.front, status: 'closed', updated: Date.now() }, body: fresh.body }, report)
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
      // A closed report is not live work. Letting it acquire a claim produces a
      // `closed + held` ghost that the referee skips as a holder, so a second
      // report can claim the same directory and both look held. Reopening is an
      // explicit act, not a side effect of leasing.
      if (current.front.status === 'closed') {
        throw new Error(
          `report-ledger: ${report} is closed, so it cannot acquire a working-tree claim. Reopen it with a `
          + 'contribution or report_amend first, or author a new report for the checkout.',
        )
      }
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
      await writeReport(
        {
          front: { ...current.front, worktree: claim, updated: Date.now() },
          body: current.body,
        },
        report,
      )
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
      const warning = await this.#checkoutWarning(current.front.worktree)
      const releaseNote = [note, warning === undefined ? undefined : `warning: ${warning}`]
        .filter((part): part is string => part !== undefined && part !== '')
        .join('; ')
      const front = await this.#record(report, {
        at: Date.now(),
        actor,
        action: 'released',
        to: [],
        ...(releaseNote === '' ? {} : { note: releaseNote }),
      })
      return { front, outcomes: [], ...(warning === undefined ? {} : { warning }) }
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

      const created = await this.#createWorktree(input.repo, plan.binding, input.base, input.settings.relativePaths)
      if (!created.ok) throw new Error(`report-ledger: ${created.reason}`)

      // Read the head off the checkout that now exists rather than predicting it,
      // so the binding records what git actually produced.
      const head = await headOf(plan.binding.path)
      return {
        binding: { ...plan.binding, ...(head === undefined ? {} : { head }) },
        retained: plan.retained,
        stale: plan.stale,
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
  /**
   * Why this report may not delete its checkout, if it may not.
   *
   * `remove-if-clean` is an explicit, destructive request, so the two safety
   * rails the docs promise are checked here rather than in the tool: only a
   * ledger-allocated checkout is removable, and no *other* live report may hold
   * the same directory. Git's cleanliness check is not enough on its own: a
   * checkout with only ignored files is clean, and removing it deletes them.
   */
  async #removalRefusal(report: string, binding: ReportWorktree): Promise<string | undefined> {
    if (binding.allocated !== true) {
      return `${binding.path} was not allocated by the ledger; only ledger-allocated checkouts can be removed`
    }
    for (const front of await listReports()) {
      if (front.report === report || front.status === 'closed') continue
      if (front.worktree === undefined || !samePath(front.worktree.path, binding.path)) continue
      if (leaseState(await readHops(front.report)) === 'held') {
        return `${binding.path} is still held by ${front.report}; release it there before removing this checkout`
      }
    }
    return undefined
  }

  /**
   * What is at risk if a checkout is kept while its report stops being live work.
   *
   * Closing is the point where attention moves away, so this is the last cheap
   * moment to say that the kept directory holds work that exists nowhere else
   * (uncommitted changes) or on a branch the main worktree does not contain.
   * It never refuses the close: refusing would trap a report whose owner cannot
   * clean up, and the warning is recorded in the closed hop so it stays visible.
   */
  async #checkoutWarning(binding: ReportWorktree): Promise<string | undefined> {
    const repo = await resolveRepo(binding.path)
    if (repo === undefined) {
      return `${binding.path} is no longer inside a git repository; its kept checkout cannot be verified`
    }
    if ((await headOf(binding.path)) === undefined) {
      return `${binding.path} is no longer a readable checkout; its kept directory cannot be verified`
    }
    if (!(await isWorktreeClean(binding.path))) {
      return `${binding.path} has uncommitted changes; closing keeps a checkout whose work exists in no commit`
    }
    if (binding.branch === undefined) return undefined
    const unmerged = await unmergedCommitCount(binding.path, binding.branch)
    if (unmerged === undefined || unmerged.count === 0) return undefined
    return `branch '${binding.branch}' has ${unmerged.count} commit(s) not merged into '${unmerged.base}'; `
      + `the kept checkout at ${binding.path} will be orphaned until it is merged or removed`
  }

  async #recordVanished(actor: string, gone: StaleBinding): Promise<void> {
    await this.#withLock(gone.report, async () => {
      if (!reportExists(gone.report)) return
      await this.#record(gone.report, {
        at: Date.now(),
        actor,
        action: 'reclaimed',
        to: [],
        note: gone.detail === undefined
          ? `checkout ${gone.path} was already gone; nothing to remove`
          : `checkout ${gone.path} ${gone.detail}; nothing to remove`,
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
        const subject = oneLineSubject(patch.subject)
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

      // Resolve the display name before reopening: a throwing describe() must not
      // leave the report reopened with the amendment itself unwritten.
      const amendmentName = patch.body !== undefined
        ? await this.#host.describe(actor)
        : undefined
      await this.#reopenIfClosed(report, actor)

      if (patch.body !== undefined) {
        if (replacingBody) {
          // A true rewrite, recorded as such on the hop.
          await writeReport({ front: (await this.#load(report)).front, body: patch.body }, report)
        } else {
          const name = amendmentName
          const header = `\n\n---\n\n### amendment by ${name ?? actor} at ${new Date().toISOString()}\n\n`
          await appendReportBody(report, `${header}${patch.body.trim()}\n`)
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
        await writeReport({ front: amended, body: base.body }, report)
      }

      const summary = [...changes, ...(patch.note === undefined ? [] : [patch.note])].join('; ')
      const front = await this.#record(report, { at: Date.now(), actor, action: 'amended', to: [], note: summary })
      return { front, outcomes: [] }
    })
  }

  /**
   * The hand-offs the ledger still owes one session.
   *
   * Derived from the hop stream, like every other pending answer, so it can
   * neither invent an obligation nor lose one to a half-written digest. The
   * digest prefilter is the same one a handover uses: only a report that names
   * the session can owe it anything, so the scan stays proportional to that
   * session's collaboration instead of to the whole ledger.
   *
   * This is the question a wake has to ask first. Resuming a session with
   * nothing owed loads a partner, spends its context on an empty inbox, and
   * demonstrates nothing — the answer here is what turns that into a refusal the
   * caller can act on instead of a silent no-op.
   * @param session - the session that may be owed a delivery.
   * @returns the outstanding hand-offs, oldest report first, with their wake policy.
   */
  async pendingFor(session: string): Promise<PendingHandoff[]> {
    const target = session.trim()
    if (target === '') return []
    const pending: PendingHandoff[] = []
    for (const front of await listReports()) {
      if (!mentions(front, target)) continue
      const hops = await readHops(front.report)
      if (!pendingTargets(hops).includes(target)) continue
      pending.push({ report: front.report, status: front.status, mode: pendingMode(hops, target) })
    }
    return pending
  }

  /**
   * Rebuild every digest's derived counters from its hop stream.
   *
   * The front matter is a cache of `projectRoute`, so it can only be as current
   * as the report's last mutation. That is harmless while the projection's meaning
   * never changes — and it is exactly why adding a derived field needs a pass: a
   * digest written before `reads` existed would report zero reads until something
   * else touched it, which reads like "nobody ever opened this" rather than "this
   * document predates the field". The same pass is what makes a future change of
   * the projection's *definition* safe to ship: rewrite every digest once, under
   * the new rule, instead of living with two meanings at the same time.
   *
   * Runs under each report's own writer lock and re-derives from a fresh read
   * inside it, so a mutation that landed during the scan is never undone by a
   * stale rewrite. `updated` is deliberately not touched: making a stale digest
   * honest is not activity, and stamping it would reorder every listing. A report
   * whose transfer path has gone missing is skipped rather than rewritten — that
   * is the same damage guard {@link ReportService}#record applies, for the same
   * reason: rebuilding from an empty history would erase its recipients.
   * @param options - `dryRun` reports what would change without writing.
   * @returns one record per report in the ledger.
   */
  async repairDigests(options: { dryRun?: boolean } = {}): Promise<DigestRepair[]> {
    const repairs: DigestRepair[] = []
    for (const digest of await listReports()) {
      const stored = digestCounters(digest)
      const derived = digestCounters(projectRoute(await readHops(digest.report)))
      if (stored === derived) {
        repairs.push({ report: digest.report, changed: false, stored, derived })
        continue
      }
      if (options.dryRun === true) {
        repairs.push({ report: digest.report, changed: true, stored, derived })
        continue
      }
      const skipped = await this.#withLock(digest.report, async () => {
        const current = await readReport(digest.report)
        if (current === undefined) return 'it disappeared while the sweep was running'
        if (current.front.hops > 0 && !existsSync(routePath(digest.report))) {
          return 'its transfer path is missing, so the digest cannot be rebuilt from it'
        }
        const fresh = projectRoute(await readHops(digest.report))
        // Re-checked inside the lock: a mutation that ran during the scan has
        // already corrected this digest, and rewriting would be a no-op that the
        // report would count as changed.
        if (digestCounters(fresh) === digestCounters(current.front)) return undefined
        await writeReport({ front: { ...current.front, ...fresh }, body: current.body }, digest.report)
        return undefined
      })
      repairs.push({ report: digest.report, changed: true, stored, derived, ...(skipped === undefined ? {} : { skipped }) })
    }
    return repairs
  }

  /**
   * Deliver every held hand-off owed to one session that just became resident.
   * @param sessionId - the session that became resident.
   * @returns the deliveries that succeeded.
   */
  async flushForAgent(sessionId: string): Promise<readonly DeliveryOutcome[]> {
    return await this.flushSessions([sessionId])
  }

  /**
   * Deliver every held hand-off owed to any of these sessions, in one ledger pass.
   *
   * The pass is shared on purpose. A delivery sweep used to be per session: the
   * pump ran for each resident session at load and for each session created
   * afterwards, and every run walked the whole ledger reading each document and
   * each transfer path. That is `sessions × reports` file reads — on a twenty
   * session, two hundred report ledger, eight thousand opens for work that is
   * entirely about a handful of owed hand-offs. Reading the ledger once and
   * answering for every waiting session costs one walk no matter how many of them
   * there are.
   *
   * Correctness is unchanged, and deliberately so:
   *
   *  - pending is still derived from the hop stream and nothing else, so a
   *    hand-edited or half-written document cannot invent or lose an obligation;
   *  - each report is still delivered under its own writer lock, and the hop
   *    stream is re-read inside that lock, so a hand-off answered between the scan
   *    and the delivery is not delivered twice;
   *  - each report still fails in isolation, because `agent/created` fires once
   *    and one malformed record must not abandon every later hand-off.
   * @param sessions - the sessions that just became resident.
   * @returns the deliveries that succeeded.
   * @throws an `AggregateError` when any report failed, naming how many.
   */
  async flushSessions(sessions: readonly string[]): Promise<readonly DeliveryOutcome[]> {
    const wanted = new Set(sessions.filter((session) => session !== ''))
    const outcomes: DeliveryOutcome[] = []
    if (wanted.size === 0) return outcomes
    const errors: unknown[] = []
    for (const digest of await listReports()) {
      const report = digest.report
      // The lock closes the only third writer besides the tools. Without it,
      // `#sync` (read the document, then atomically rewrite it) can interleave
      // with `contribute`'s append and overwrite the appended section with the
      // stale body it read — a silent loss that the `contributed` hop would
      // still claim had happened.
      try {
        // Checked before taking the lock: a report with nobody to deliver to is
        // by far the common case, and a mutex per report per sweep would serialize
        // the pump against every concurrent mutation for no reason.
        const waiting = pendingTargets(await readHops(report)).filter((target) => wanted.has(target))
        if (waiting.length === 0) continue
        await this.#withLock(report, async () => {
          const current = await readReport(report)
          if (current === undefined) return
          const hops = await readHops(report)
          const still = pendingTargets(hops).filter((target) => wanted.has(target))
          if (still.length === 0) return
          // A wake policy is decided per window, so the targets of one report can
          // want different modes: an unanswered addressed hand-off wakes, a copy
          // that is owed on its own stays quiet. Delivering both as one mode would
          // either lose a wake or disturb a session for a carbon copy.
          const wake = still.filter((target) => pendingMode(hops, target) === 'wakeup')
          const quiet = still.filter((target) => pendingMode(hops, target) === 'quiet')
          if (wake.length > 0) outcomes.push(...await this.#deliver(current.front, wake, 'wakeup', 'report-ledger'))
          if (quiet.length > 0) outcomes.push(...await this.#deliver(current.front, quiet, 'quiet', 'report-ledger'))
        })
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `report-ledger: deferred delivery for ${wanted.size} session(s) failed for ${errors.length} report(s)`,
      )
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
  return `${row.report} [${row.status}] ${row.subject}${task}${worktree} | from=${row.from} to=${row.to.length === 0 ? '-' : row.to.join(',')} cc=${row.cc.length === 0 ? '-' : row.cc.join(',')} hops=${row.hops} reads=${row.reads} last=${last}`
}
