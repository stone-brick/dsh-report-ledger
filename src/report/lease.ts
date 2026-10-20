/**
 * The working-tree lease referee.
 *
 * A lease answers one question: may *this* report work in *that* checkout? The
 * answer needs two authorities, and this module consults both.
 *
 *  - **The ledger knows intent.** It can say which report claims a branch, and
 *    therefore name the agent to talk to. Git cannot: it reports a path, and a
 *    path is not a colleague.
 *  - **Git knows reality.** It can say which working tree actually has a branch
 *    checked out. The ledger cannot: a checkout a human made by hand never
 *    appears in it.
 *
 * Neither is sufficient, and when they disagree the disagreement is reported
 * rather than resolved — a ledger that silently overrode git would be lying
 * about the filesystem, and one that silently deferred to git would lose the
 * only party who can be asked to let go.
 *
 * **Lease liveness is derived from the hop stream, never stored as a flag.** The
 * digest is a cache of current state, and `leased`/`released` hops are the
 * authority for whether a claim is still held — the same shape as
 * `pendingTargets`, which derives the durable mailbox from hops rather than
 * recording it. The binding itself *does* persist in the digest after release,
 * because a working tree kept on disk must still be traceable back to the report
 * that made it.
 *
 * @module dsh-report-ledger/report/lease
 */

import { isAbsolute } from 'node:path'
import { listWorktrees, branchHolders, samePath } from './worktree.ts'
import type { RepoLocation } from './worktree.ts'
import type { ReportFrontMatter, ReportWorktree, RouteHop } from './types.ts'

/**
 * Whether a report currently holds its working tree.
 *
 * The last `leased`, `released` or `reclaimed` hop wins, so a claim released and
 * taken again reads as held.
 *
 * `'reclaimed'` is deliberately distinct from `'released'`. Both mean the claim
 * ended, but only one means the ledger has since *cleared the checkout away* —
 * and the difference decides whether there is anything left to clear. Collapsing
 * them would leave a checkout the ledger already removed sitting in the candidate
 * set forever, re-examined on every allocation and, once the ledger notices its
 * absence, re-recorded on every allocation too.
 *
 * `'none'` means the report was never leased at all, which is different again.
 */
export type LeaseState = 'none' | 'held' | 'released' | 'reclaimed'

/**
 * Derive lease liveness from the authoritative hop stream.
 * @param hops - a report's hops, oldest first.
 * @returns the current lease state.
 */
export function leaseState(hops: readonly RouteHop[]): LeaseState {
  let state: LeaseState = 'none'
  for (const hop of hops) {
    if (hop.action === 'leased') state = 'held'
    else if (hop.action === 'released') state = 'released'
    else if (hop.action === 'reclaimed') state = 'reclaimed'
  }
  return state
}

/**
 * Whether two bindings name the same claim.
 *
 * Two rules, in order, because a checkout has two identities and they differ in
 * scope:
 *
 *  - **The path is the checkout's identity.** Two reports cannot work in one
 *    directory, whatever branch each of them believes it is on — and a binding
 *    whose branch is stale (the holder checked something else out) must not open
 *    a second report's road into that directory. Nothing is more local than a
 *    directory, so this rule needs no further context.
 *  - **A branch is the claim's identity only inside one repository.** Branch
 *    names are repository-local, so `main` in this repository and `main` in
 *    another are two different branches that happen to share a spelling.
 *    Comparing only the name would refuse a legitimate claim and name a
 *    colleague in another project as the holder.
 *
 * With no branch on one side, and no shared repository to compare, there is no
 * claim identity left to assert: two detached trees at different paths are not
 * the same claim.
 * @param left - one binding.
 * @param right - another binding.
 * @returns true when they are the same claim.
 */
export function sameClaim(left: ReportWorktree, right: ReportWorktree): boolean {
  if (samePath(left.path, right.path)) return true
  if (left.repo !== undefined && right.repo !== undefined && !samePath(left.repo, right.repo)) return false
  if (left.branch !== undefined && right.branch !== undefined) return left.branch === right.branch
  return false
}

/** Why a lease was refused. */
export type LeaseRefusalKind =
  | 'invalid-binding'
  | 'no-repository'
  | 'not-a-worktree'
  | 'branch-mismatch'
  | 'checked-out'
  | 'held-by-report'

/**
 * A refusal, with enough structure for a caller to act and enough prose for a
 * model to understand without a second lookup.
 */
export interface LeaseRefusal {
  /** Which check failed. */
  readonly kind: LeaseRefusalKind
  /** One sentence naming the problem and the remedy. */
  readonly message: string
  /** Report holding the claim, for `held-by-report`. */
  readonly heldBy?: string
  /** Session that opened the holding report. */
  readonly heldByActor?: string
  /** Working tree holding the branch, for `checked-out`. */
  readonly heldAt?: string
}

/**
 * The referee's verdict on one claim.
 *
 * A granted verdict carries the binding **as git describes it**, not as the
 * caller asserted it. That is the referee's to fill in because it is the side
 * that looked: a caller can name a path and a branch it believes, but only git
 * can say which commit the tree is actually on, and a digest that records an
 * asserted head instead of the real one is a lie the ledger would then carry
 * forever.
 */
export type LeaseVerdict =
  | { readonly kind: 'granted'; readonly binding: ReportWorktree }
  | { readonly kind: 'refused'; readonly refusal: LeaseRefusal }

/** Everything {@link evaluateLease} needs to reach a verdict. */
export interface LeaseQuery {
  /** The binding the caller wants to hold. */
  readonly binding: ReportWorktree
  /**
   * The repository the binding was resolved against, or `undefined` when it is
   * not in one.
   *
   * Resolved by the caller rather than here so that one resolution can both
   * answer this question and key the mutex that serializes competing claims —
   * and so the mutex is keyed by the repository, which is the unit a branch is
   * held in, rather than by a checkout.
   */
  readonly repo: RepoLocation | undefined
  /** The claiming report; its own prior claim is never a conflict. */
  readonly report: string
  /** Every report in the ledger, as digests. */
  readonly digests: readonly ReportFrontMatter[]
  /** Read one report's hops, for the derived lease state. */
  readonly hopsOf: (report: string) => Promise<readonly RouteHop[]>
}

/** The claimed name in prose: the branch when there is one, else the path. */
function claimName(binding: ReportWorktree): string {
  return binding.branch ?? `${binding.path} (detached)`
}

/**
 * Decide whether a claim may be taken.
 *
 * Git is consulted before the ledger on purpose. Accusing a colleague of holding
 * something that turns out not to exist is a worse answer than "there is no such
 * checkout", and the ledger layer is only meaningful once the thing being
 * claimed is real.
 * @param query - the claim and the authorities to check it against.
 * @returns the refusal, or `undefined` when the claim may be taken.
 * @throws when git cannot be asked at all.
 */
export async function evaluateLease(query: LeaseQuery): Promise<LeaseVerdict> {
  const { binding, repo } = query
  const refuse = (refusal: LeaseRefusal): LeaseVerdict => ({ kind: 'refused', refusal })

  // A relative path is not a claim, it is a question about whoever happens to be
  // asking: the same string names different directories in different processes,
  // and the digest that records it would keep meaning something new every time it
  // is read. Git reports absolute paths, so a caller that did not pass one did
  // not name a working tree at all.
  if (!isAbsolute(binding.path)) {
    return refuse({
      kind: 'invalid-binding',
      message: `${binding.path} is not an absolute path, so it does not name a working tree. `
        + 'Pass the checkout\'s absolute path, as git worktree list reports it.',
    })
  }

  // ---- git: is the thing being claimed real, and is it what we think? -------
  if (repo === undefined) {
    return refuse({
      kind: 'no-repository',
      message: `${binding.path} is not inside a git repository, so there is no working tree to claim. `
        + 'Bind a checkout that exists, or let the ledger allocate one.',
    })
  }

  const entries = await listWorktrees(repo)
  const entry = entries.find((candidate) => samePath(candidate.path, binding.path))
  if (entry === undefined) {
    return refuse({
      kind: 'not-a-worktree',
      message: `${binding.path} is not a working tree of ${repo.commonDir}. `
        + 'An existing checkout can be listed with git worktree list.',
    })
  }
  if (entry.prunable) {
    // The tree can still work from its own side while git considers the entry
    // dangling — and one prune destroys the administrative directory under it.
    // Claiming it would launder a broken checkout into a healthy-looking lease.
    return refuse({
      kind: 'not-a-worktree',
      message: `${binding.path} is registered but its working tree is gone, so git reports it prunable`
        + `${entry.prunableReason === undefined ? '' : ` (${entry.prunableReason})`}. `
        + 'If it was moved by hand, run git worktree repair from the new location; otherwise remove the stale entry first.',
    })
  }
  if (binding.branch !== undefined) {
    const actual = entry.branch
    if (actual !== binding.branch) {
      return refuse({
        kind: 'branch-mismatch',
        message: `${binding.path} is on ${actual === undefined ? 'a detached HEAD' : `'${actual}'`}, `
          + `not '${binding.branch}', so the binding no longer describes the checkout.`,
      })
    }
    const holder = branchHolders(entries).get(binding.branch)
    if (holder !== undefined && !samePath(holder.path, binding.path)) {
      return refuse({
        kind: 'checked-out',
        heldAt: holder.path,
        message: `'${binding.branch}' is checked out at ${holder.path}, and a branch is held by exactly one working tree. `
          + `Claim ${holder.path} instead, or use a different branch.`,
      })
    }
  }

  // ---- the ledger: does another live report claim the same thing? -----------
  // Compared against the claim *including its repository*, because the caller's
  // binding may name only a path and a branch — and a branch alone is not an
  // identity: `main` exists in every repository. The referee has resolved the
  // repository above, so it is the side that can put the two together.
  const claim: ReportWorktree = { ...binding, repo: repo.commonDir }
  for (const front of query.digests) {
    if (front.report === query.report) continue
    if (front.worktree === undefined) continue
    // Compared before reading hops, so a ledger with many bindings still costs
    // one hop read per actual candidate rather than one per report.
    if (!sameClaim(front.worktree, claim)) continue
    if (front.status === 'closed') continue
    if (leaseState(await query.hopsOf(front.report)) !== 'held') continue
    const holders = [...new Set([front.from, ...front.authors])]
    return refuse({
      kind: 'held-by-report',
      heldBy: front.report,
      heldByActor: front.from,
      message: `${front.report} (opened by ${front.from}) already holds ${claimName(binding)}. `
        + `A claim is held by one report at a time. Ask it to release with report_release, or to close — `
        + `closing releases the claim. Its authors are ${holders.join(', ')}.`,
    })
  }

  // Granted. The binding is described from what git reported rather than from
  // what the caller believed: `path` is git's own spelling (a caller may have
  // reached the same tree through a differently-cased or relative spelling, and
  // the digest is the durable record — it has to name the tree the way every
  // later reader will find it), `branch` is whatever this checkout is really on
  // (the mismatch check above already refused any contradiction), `head` is the
  // commit actually there, and `repo` is the shared directory this was resolved
  // against. A caller that named no branch gets the real one, which is what stops
  // a checkout sitting on a branch from being recorded as detached.
  return {
    kind: 'granted',
    binding: {
      path: entry.path,
      ...(entry.branch === undefined ? {} : { branch: entry.branch }),
      ...(entry.head === undefined ? {} : { head: entry.head }),
      repo: repo.commonDir,
      ...(binding.allocated === undefined ? {} : { allocated: binding.allocated }),
    },
  }
}
