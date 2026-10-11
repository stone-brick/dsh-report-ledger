/**
 * Working-tree allocation: naming, the two budgets, and housekeeping.
 *
 * Allocating is three decisions that look like one. What the checkout is
 * *called*, whether there is *room* for it, and whether an old one should make
 * room are separate questions, and conflating them is how a convenient feature
 * becomes a destructive one.
 *
 * **Two limits, not one.** `maxActive` bounds how many checkouts may be *held at
 * once* — a coordination limit, and the one a caller waits on. `maxRetained`
 * bounds how many may sit on disk after their claim *ended* — a disk limit. They
 * are deliberately separate numbers because they fail differently: a full active
 * budget means someone is working and you must wait, while a full retained
 * budget means nobody is working and there is litter to clear.
 *
 * **Reclaiming can never free an active slot.** A reclaimable checkout is by
 * definition one whose claim already ended, so clearing it cannot release a live
 * holder's claim. Coupling the two would amount to offering "take a checkout
 * away from an agent at work" as a configuration option; a full active budget is
 * a refusal with no override, and it names who to wait for.
 *
 * @module dsh-report-ledger/report/allocate
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { leaseState } from './lease.ts'
import { hasSubmodules, isWorktreeClean } from './worktree.ts'
import type { RepoLocation } from './worktree.ts'
import type { ReportFrontMatter, ReportWorktree, RouteHop } from './types.ts'

/** The branch prefix every ledger-allocated checkout uses. */
export const BRANCH_PREFIX = 'dsh'

/** Longest slug kept in a branch and directory name. */
const SLUG_LIMIT = 40

/**
 * Reduce a subject to a ref-safe slug.
 *
 * The output alphabet is `[a-z0-9-]`, a subset of what git accepts in a ref
 * name, so nothing needs escaping afterwards. That narrowness is the point: git
 * forbids `~^:?*[`, `..`, `@{`, spaces, control characters, and a leading or
 * trailing `.`, and a slug that can only hold lower-case letters, digits and
 * interior hyphens cannot spell any of them. A subject in a non-Latin script
 * reduces to nothing, which is why a name without a slug exists too.
 * @param subject - the report subject.
 * @returns the slug, possibly empty.
 */
export function slugify(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_LIMIT)
    .replace(/-+$/g, '')
}

/**
 * The name a report's checkout goes by, in both its branch and its directory.
 *
 * A report id is always part of it, so a checkout traces back to its report from
 * `git branch` alone, and the report id is recoverable from a directory listing
 * without consulting the ledger.
 * @param report - report identifier.
 * @param subject - the report subject, for the readable suffix.
 * @returns the name.
 */
export function worktreeName(report: string, subject: string): string {
  const slug = slugify(subject)
  return slug === '' ? report : `${report}-${slug}`
}

/**
 * The branch a report's checkout is on.
 * @param report - report identifier.
 * @param subject - the report subject.
 * @returns the branch name.
 */
export function worktreeBranch(report: string, subject: string): string {
  return `${BRANCH_PREFIX}/${worktreeName(report, subject)}`
}

/**
 * Where a report's checkout is created.
 *
 * The repository name is always a path component, so two repositories sharing a
 * parent — the ordinary case for anyone with several projects — cannot allocate
 * into each other's directory.
 * @param repo - the repository.
 * @param report - report identifier.
 * @param subject - the report subject.
 * @param base - base directory override, when configured.
 * @returns the absolute path.
 */
export function worktreePath(repo: RepoLocation, report: string, subject: string, base?: string): string {
  const name = worktreeName(report, subject)
  return base === undefined
    ? join(repo.worktreeRoot, name)
    : join(base, repo.repoName, name)
}

/** The resolved settings allocation obeys. */
export interface WorktreeSettings {
  /** Cap on checkouts held at once. */
  readonly maxActive: number
  /** Cap on checkouts kept on disk after their claim ended. */
  readonly maxRetained: number
  /** Whether an over-full retained set is cleared automatically. */
  readonly reclaim: 'never' | 'oldest-closed'
  /** Base directory for allocated checkouts; the default is beside the repository. */
  readonly base?: string
  /** Write linking files as relative paths. Raises the repository format version. */
  readonly relativePaths: boolean
}

/**
 * Plugin configuration for working-tree support.
 *
 * Every field is optional and the feature is off unless `enabled` is set, so a
 * deployment that does not want it pays nothing — no git invocation, no
 * directory, and not even a parameter in the tools the model sees.
 */
export interface WorktreeConfig {
  /** Turn the feature on. */
  enabled?: boolean
  /** Base directory for allocated checkouts; the default is beside the repository. */
  root?: string
  /**
   * What closing a report does with a bound checkout.
   * @default 'keep'
   */
  onClose?: 'keep' | 'remove-if-clean'
  /**
   * Cap on checkouts held at once.
   *
   * A coordination limit, and the one a caller waits on. Reclaiming can never
   * raise it, because what it would have to clear is a checkout someone is
   * working in.
   * @default 4
   */
  maxActive?: number
  /**
   * Cap on checkouts kept on disk after their claim ended.
   *
   * A disk limit. Failing it is never a reason to block work, so it only
   * triggers housekeeping — and only when {@link reclaim} permits it.
   * @default 4
   */
  maxRetained?: number
  /**
   * Whether an over-full retained set is cleared automatically.
   *
   * Off by default. When on, the oldest checkouts whose claim ended *and* which
   * are clean are removed; an unclean one is always skipped and reported.
   * @default 'never'
   */
  reclaim?: 'never' | 'oldest-closed'
  /**
   * Write linking files as relative paths, so a repository and its checkouts can
   * be moved together.
   *
   * Off by default because it is not cosmetic: it implies the
   * `extensions.relativeWorktrees` repository format extension, which raises
   * `core.repositoryformatversion` to 1, and older git then refuses to touch the
   * repository at all.
   */
  relativePaths?: boolean
}

/** The resolved feature state the model-facing tools consult. */
export interface WorktreeRuntime {
  /** Whether the feature is on. */
  readonly enabled: boolean
  /** The limits and paths allocation obeys. */
  readonly settings: WorktreeSettings
  /** What closing a report does with a bound checkout. */
  readonly onClose: 'keep' | 'remove-if-clean'
}

/**
 * Fill in the defaults for working-tree support.
 * @param config - the plugin configuration, when one was supplied.
 * @returns the resolved runtime.
 */
export function resolveWorktree(config?: WorktreeConfig): WorktreeRuntime {
  return {
    enabled: config?.enabled === true,
    settings: {
      maxActive: config?.maxActive ?? 4,
      maxRetained: config?.maxRetained ?? 4,
      reclaim: config?.reclaim ?? 'never',
      relativePaths: config?.relativePaths === true,
      ...(config?.root === undefined ? {} : { base: config.root }),
    },
    onClose: config?.onClose ?? 'keep',
  }
}

/** A checkout the ledger created and may clear away. */
interface Reclaimable {
  /** The report that owns it. */
  readonly report: string
  /** Absolute path of the checkout. */
  readonly path: string
  /** Its branch, when it has one. */
  readonly branch?: string
  /** When its claim ended. */
  readonly releasedAt: number
}

/** A claim taken back to make room on disk. */
export interface ReclaimedLease {
  /** The report the checkout belonged to. */
  readonly report: string
  /** The path to clear. */
  readonly path: string
  /** Its branch, when it had one. */
  readonly branch?: string
}

/** A binding whose checkout is no longer on disk. */
export interface StaleBinding {
  /** The report that owns the vanished checkout. */
  readonly report: string
  /** Where the checkout used to be. */
  readonly path: string
}

/** What allocation decided to do. */
export interface AllocationPlan {
  /**
   * The binding to record for the new checkout.
   *
   * Narrower than {@link ReportWorktree}: an allocated checkout always has a
   * branch, a repository and the `allocated` mark, and saying so here keeps the
   * caller from re-checking what it just created.
   */
  readonly binding: ReportWorktree & { readonly branch: string; readonly repo: string; readonly allocated: true }
  /** How many ended claims still have a checkout on disk. */
  readonly retained: number
  /** The checkout to reclaim first, when one may be cleared. */
  readonly reclaimed?: ReclaimedLease
  /** Candidates for reclamation that were refused, and why. */
  readonly reclaimSkipped: readonly string[]
  /**
   * Bindings whose checkout has already vanished.
   *
   * Not candidates: a checkout that is gone frees no disk, so it must not count
   * against the retained budget. But the ledger still believes it owns one
   * there, and leaving that belief in place would have every later allocation
   * re-examine it. The caller records the fact once, which is both true and what
   * stops the repetition.
   */
  readonly stale: readonly StaleBinding[]
}

/** Why an allocation was refused. */
export type AllocationRefusalKind = 'submodules' | 'budget'

/** An allocation that will not happen, and why. */
export interface AllocationRefusal {
  /** Which gate closed. */
  readonly kind: AllocationRefusalKind
  /** One sentence naming the problem and the remedy. */
  readonly message: string
}

/** Everything {@link planAllocation} needs. */
export interface AllocationQuery {
  /** The report the checkout is for. */
  readonly report: string
  /** The report subject, for naming. */
  readonly subject: string
  /** The repository to allocate in. */
  readonly repo: RepoLocation
  /** Every report in the ledger, as digests. */
  readonly digests: readonly ReportFrontMatter[]
  /** Read one report's hops, for the derived lease state. */
  readonly hopsOf: (report: string) => Promise<readonly RouteHop[]>
  /** Whether a session is currently resident. */
  readonly isLive: (sessionId: string) => boolean
}

/** When a claim ended, from the hop that ended it. */
function lastReleaseAt(hops: readonly RouteHop[]): number {
  let at = 0
  for (const hop of hops) {
    if (hop.action === 'released') at = hop.at
  }
  return at
}

/**
 * The message shown when the active budget is full.
 *
 * "Wait" is useless advice unless it says for whom, and the ledger already knows
 * both the holders and whether each is around — so the refusal names them, and
 * names the two ways out that do not involve waiting.
 * @param held - the reports currently holding a checkout.
 * @param limit - the configured cap.
 * @returns the refusal message.
 */
export function budgetMessage(
  held: readonly { report: string; actor: string; live: boolean }[],
  limit: number,
): string {
  const holders = held
    .map((holder) => `${holder.report} -> ${holder.actor} (${holder.live ? 'live' : 'absent'})`)
    .join(', ')
  return `the working-tree budget is full (${held.length} of ${limit} held). Held by: ${holders}. `
    + 'Wait for one of these to finish, hand one back with report_release, or close its report — closing releases the claim.'
}

/**
 * Decide what to allocate, or refuse.
 *
 * One pass over the ledger yields both answers: which checkouts are held now,
 * and which ended claims left one behind. The budget is then checked against the
 * held set alone and refuses without an override; reclamation runs afterwards,
 * for the disk limit, and can only reach checkouts whose claim already ended.
 * @param query - the allocation and the ledger it must fit into.
 * @param settings - the resolved settings.
 * @returns the plan, or the refusal.
 */
export async function planAllocation(
  query: AllocationQuery,
  settings: WorktreeSettings,
): Promise<AllocationPlan | AllocationRefusal> {
  // A linked checkout of a superproject is the one case git's own manual calls
  // out as unsupported rather than merely awkward: support for submodules is
  // incomplete, and such a worktree cannot even be moved.
  if (hasSubmodules(query.repo)) {
    return {
      kind: 'submodules',
      message: `${query.repo.repoRoot} uses submodules (it has a .gitmodules file). Git does not recommend `
        + 'multiple checkouts of a superproject, and a linked worktree containing submodules cannot be moved, '
        + 'so the ledger will not allocate one here.',
    }
  }

  const held: { report: string; actor: string; live: boolean }[] = []
  const reclaimable: Reclaimable[] = []
  const stale: StaleBinding[] = []
  for (const front of query.digests) {
    if (front.report === query.report) continue
    const binding = front.worktree
    if (binding === undefined) continue
    const hops = await query.hopsOf(front.report)
    const state = leaseState(hops)
    if (state === 'held') {
      held.push({ report: front.report, actor: front.from, live: query.isLive(front.from) })
      continue
    }
    // Only a checkout the ledger created, for a report that concluded, whose
    // claim ended *without having been cleared* is ever a candidate. A checkout
    // merely adopted belongs to whoever made it, whatever the report says, and
    // one already recorded as reclaimed has nothing left to free.
    if (state !== 'released' || front.status !== 'closed' || binding.allocated !== true) continue
    if (!existsSync(binding.path)) {
      // Gone already — most often because a human removed it, since the ledger's
      // own removals leave a `reclaimed` hop and never reach here. It frees
      // nothing, so it is not a candidate; it is reported so the belief can be
      // corrected once instead of re-examined forever.
      stale.push({ report: front.report, path: binding.path })
      continue
    }
    reclaimable.push({
      report: front.report,
      path: binding.path,
      ...(binding.branch === undefined ? {} : { branch: binding.branch }),
      releasedAt: lastReleaseAt(hops),
    })
  }

  if (held.length >= settings.maxActive) {
    return { kind: 'budget', message: budgetMessage(held, settings.maxActive) }
  }

  reclaimable.sort((left, right) => left.releasedAt - right.releasedAt || left.report.localeCompare(right.report))
  let reclaimed: ReclaimedLease | undefined
  const reclaimSkipped: string[] = []
  if (settings.reclaim === 'oldest-closed' && reclaimable.length > settings.maxRetained) {
    for (const candidate of reclaimable) {
      // The cleanliness gate holds even though the switch is on. A closed report
      // says the conversation ended, which is not the same claim as "nothing
      // here is worth keeping", and only the second one licenses a delete.
      if (!(await isWorktreeClean(candidate.path))) {
        reclaimSkipped.push(`${candidate.report} (uncommitted changes at ${candidate.path})`)
        continue
      }
      reclaimed = {
        report: candidate.report,
        path: candidate.path,
        ...(candidate.branch === undefined ? {} : { branch: candidate.branch }),
      }
      break
    }
  }

  return {
    binding: {
      path: worktreePath(query.repo, query.report, query.subject, settings.base),
      branch: worktreeBranch(query.report, query.subject),
      repo: query.repo.commonDir,
      allocated: true,
    },
    retained: reclaimable.length - (reclaimed === undefined ? 0 : 1),
    ...(reclaimed === undefined ? {} : { reclaimed }),
    reclaimSkipped,
    stale,
  }
}
