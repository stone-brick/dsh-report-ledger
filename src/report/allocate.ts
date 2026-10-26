/**
 * Working-tree allocation: naming, the two budgets, and housekeeping.
 *
 * Allocating is three decisions that look like one. What the checkout is
 * *called*, whether there is *room* for it, and whether an old one should make
 * room are separate questions, and conflating them is how a convenient feature
 * becomes a destructive one.
 *
 * **One enforced limit, one warning.** `maxActive` bounds how many checkouts may
 * be *held at once* — a coordination limit, and the one a caller waits on.
 * `maxRetained` no longer deletes anything: it is a warning threshold the
 * maintenance view reports against. A checkout is only removed by an explicit
 * close (`remove-if-clean`), never as a side effect of allocating another one.
 *
 * **Allocation never frees disk.** It creates a checkout or refuses; it does not
 * take an old one away. The active budget is a refusal with no override, and it
 * names who to wait for.
 *
 * @module dsh-report-ledger/report/allocate
 */

import { isAbsolute, join } from 'node:path'
import { leaseState } from './lease.ts'
import {
  gitVersion, hasSubmodules, inspectCheckout, relativePathsRefusal, samePath,
} from './worktree.ts'
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
  /** Warning threshold for checkouts kept on disk after their claim ended, per repository. */
  readonly maxRetained: number
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
   * A coordination limit, and the one a caller waits on. No allocation can
   * raise it, because what it would have to clear is a checkout someone is
   * working in.
   * @default 4
   */
  maxActive?: number
  /**
   * Warning threshold for checkouts kept on disk after their claim ended,
   * counted per repository. Exceeding it never deletes anything; the maintenance
   * view reports the count and points at explicit cleanup.
   * @default 4
   */
  maxRetained?: number
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

/** One configured count, or its default when it is not a usable number. */
function countSetting(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined) return fallback
  return Number.isInteger(value) && value >= minimum ? value : fallback
}

/**
 * Fill in the defaults for working-tree support.
 *
 * A count is validated rather than trusted: `maxActive: 0` would otherwise turn
 * every allocation into a permanent refusal that names no holder, and a
 * fractional or negative cap would be obeyed in ways nobody meant. A value that
 * cannot be honoured falls back to its documented default, which keeps the
 * feature working and confinable instead of silently dead.
 * @param config - the plugin configuration, when one was supplied.
 * @returns the resolved runtime.
 */
export function resolveWorktree(config?: WorktreeConfig): WorktreeRuntime {
  return {
    enabled: config?.enabled === true,
    settings: {
      maxActive: countSetting(config?.maxActive, 4, 1),
      maxRetained: countSetting(config?.maxRetained, 4, 0),
      relativePaths: config?.relativePaths === true,
      // A relative root would make binding.path relative, breaking the digest's
      // absolute-path contract and every later lease/maintenance check.
      ...(config?.root === undefined || !isAbsolute(config.root) ? {} : { base: config.root }),
    },
    onClose: config?.onClose === 'remove-if-clean' ? 'remove-if-clean' : 'keep',
  }
}

/** A binding whose checkout is no longer a usable working tree. */
export interface StaleBinding {
  /** The report that owns the vanished checkout. */
  readonly report: string
  /** Where the checkout used to be. */
  readonly path: string
  /**
   * What was found there instead, when something was.
   *
   * Absent when the directory is simply gone; present when a directory exists
   * but is no longer a working tree of its repository, because that is a
   * different fact and reading it as "vanished" would be a quiet lie in the
   * audit trail.
   */
  readonly detail?: string
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
  /** How many ended claims in this repository still have a checkout on disk. */
  readonly retained: number
  /**
   * Bindings whose checkout has already vanished.
   *
   * Not candidates for anything: a checkout that is gone frees no disk. But the
   * ledger still believes it owns one there, and leaving that belief in place
   * would have every later allocation re-examine it. The caller records the fact
   * once, which is both true and what stops the repetition.
   */
  readonly stale: readonly StaleBinding[]
}

/** Why an allocation was refused. */
export type AllocationRefusalKind = 'submodules' | 'budget' | 'git-version'

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
  /**
   * The host's `git --version` line, when the caller already knows it.
   *
   * Exists so a check can exercise the `relativePaths` version gate without
   * depending on the git installed on the runner; omitted means ask git.
   */
  readonly version?: string
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
 * and which ended claims left one behind. Only the held set can refuse the
 * allocation (the active budget); the ended set is examined only to correct
 * stale beliefs and to count what remains on disk. **Nothing is deleted here.**
 *
 * A checkout a live report *adopted* is still named by the closed report that
 * made it. Its ended binding must not be mistaken for a vanished checkout just
 * because someone else is working in it, so a live holder skips the stale check.
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

  // The flag is not merely cosmetic, and older git does not recognize it at all:
  // asking first turns "every allocation dies on unknown option" into a sentence
  // naming the version and the two ways out.
  if (settings.relativePaths) {
    const version = query.version ?? (await gitVersion(query.repo.commonDir))
    const refusal = relativePathsRefusal(version)
    if (refusal !== undefined) {
      return {
        kind: 'git-version',
        message: `${refusal}. Allocate without relative paths (set worktree.relativePaths: false), or upgrade git.`,
      }
    }
  }

  const held: { report: string; actor: string; live: boolean }[] = []
  const liveClaims: { report: string; worktree: ReportWorktree }[] = []
  const ended: { report: string; binding: ReportWorktree }[] = []
  for (const front of query.digests) {
    if (front.report === query.report) continue
    const binding = front.worktree
    if (binding === undefined) continue
    const hops = await query.hopsOf(front.report)
    const state = leaseState(hops)
    if (state === 'held') {
      held.push({ report: front.report, actor: front.from, live: query.isLive(front.from) })
      // A concluded report cannot legitimately still hold a claim (closing
      // releases it), but if one does the directory is not free either.
      if (front.status !== 'closed') liveClaims.push({ report: front.report, worktree: binding })
      continue
    }
    // Only a checkout the ledger created, for a report that concluded, whose
    // claim ended *without having been cleared* is examined at all. A checkout
    // merely adopted belongs to whoever made it, whatever the report says.
    if (state !== 'released' || front.status !== 'closed' || binding.allocated !== true) continue
    ended.push({ report: front.report, binding })
  }

  if (held.length >= settings.maxActive) {
    return { kind: 'budget', message: budgetMessage(held, settings.maxActive) }
  }

  const stale: StaleBinding[] = []
  let retained = 0
  for (const candidate of ended) {
    // Only this repository's checkouts are inspected: a checkout elsewhere is
    // not this allocation's retained count, and recording its stale state from
    // here would blame the wrong repository.
    if (candidate.binding.repo === undefined || !samePath(candidate.binding.repo, query.repo.commonDir)) continue
    // The same path is the same checkout. A live report may have adopted this
    // one; its ended binding is not a vanished checkout while someone works in it.
    const holder = liveClaims.find((live) => samePath(live.worktree.path, candidate.binding.path))
    if (holder !== undefined) continue
    // Existing is not the same as being a checkout: a directory that stopped
    // being one would make `git status` fail there, and reading that failure as
    // dirty is a wrong diagnosis.
    const reality = await inspectCheckout(candidate.binding.path)
    if (reality.presence === 'missing') {
      stale.push({ report: candidate.report, path: candidate.binding.path })
      continue
    }
    if (reality.presence === 'not-a-worktree') {
      stale.push({
        report: candidate.report,
        path: candidate.binding.path,
        detail: 'exists but is no longer a working tree of the repository',
      })
      continue
    }
    retained++
  }

  return {
    binding: {
      path: worktreePath(query.repo, query.report, query.subject, settings.base),
      branch: worktreeBranch(query.report, query.subject),
      repo: query.repo.commonDir,
      allocated: true,
    },
    retained,
    stale,
  }
}
