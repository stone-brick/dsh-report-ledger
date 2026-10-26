/**
 * The maintenance view: what the ledger thinks it owns, and what is true of it.
 *
 * This exists because of an asymmetry the design accepts deliberately. A working
 * tree is not a first-class object in the ledger — it is a field on a report plus
 * a directory on disk — so there is no index to consult when an operator asks
 * "what checkouts are out there, and is any of it broken?". The answer has to be
 * assembled from the reports and from git, every time, and that is what this
 * module does.
 *
 * It **reports and never repairs**. Nothing here removes, prunes or reclaims: a
 * checkout moved by hand still works from its own side while git calls it
 * dangling, so an automatic prune destroys live work, and the whole point of a
 * maintenance view is to let a human decide with the facts in front of them.
 *
 * @module dsh-report-ledger/report/maintenance
 */

import { leaseState, type LeaseState } from './lease.ts'
import {
  inspectCheckout, isWorktreeClean, listWorktrees, resolveRepo, samePath, type CheckoutPresence,
} from './worktree.ts'
import type { WorktreeSettings } from './allocate.ts'
import type { ReportFrontMatter, ReportStatus, RouteHop } from './types.ts'

/** One checkout the ledger knows about, and what is true of it on disk. */
export interface WorktreeRecord {
  /** The report whose binding names it. */
  readonly report: string
  /** That report's subject, so an operator sees what the checkout is for. */
  readonly subject: string
  /** That report's lifecycle state. */
  readonly status: ReportStatus
  /** Absolute path of the checkout. */
  readonly path: string
  /** Short branch name; absent for a detached checkout. */
  readonly branch?: string
  /** The commit recorded on the binding. */
  readonly head?: string
  /** The shared git directory recorded on the binding. */
  readonly repo?: string
  /** Whether the ledger created it. Only these are ever reclaimed. */
  readonly allocated: boolean
  /** Whether the claim is live, ended, or the checkout has been cleared. */
  readonly state: LeaseState
  /** Whether the directory is still there. */
  readonly onDisk: boolean
  /** What git found at the path: a linked tree, nothing, or a plain directory. */
  readonly presence: CheckoutPresence
  /** Whether it has uncommitted work; absent unless it is a live working tree. */
  readonly clean?: boolean
  /** Whether git considers the administrative entry dangling. */
  readonly prunable: boolean
}

/** The whole maintenance view. */
export interface WorktreeReport {
  /** When this was assembled, Unix epoch milliseconds. */
  readonly generatedAt: number
  /** Whether allocation is enabled in this deployment. */
  readonly enabled: boolean
  /** The limits the counts are measured against. */
  readonly limits: {
    readonly maxActive: number
    readonly maxRetained: number
    readonly reclaim: 'never' | 'oldest-closed'
  }
  /** Claims held right now. */
  readonly active: number
  /** Ended claims whose checkout is still on disk. */
  readonly retained: number
  /** Every checkout the ledger knows about, by report id. */
  readonly records: readonly WorktreeRecord[]
  /** Checkouts git knows about that no report is bound to. */
  readonly unmanaged: readonly string[]
  /** Administrative entries git reports as dangling. */
  readonly dangling: readonly string[]
  /** Things worth a human's attention, one sentence each. */
  readonly warnings: readonly string[]
}

/** Inputs the view needs, injected so the assembly stays harness-free. */
export interface MaintenanceDeps {
  /**
   * Every report digest in the ledger.
   * @returns the digests.
   */
  listReports(): Promise<readonly ReportFrontMatter[]>
  /**
   * Read one report's hops, for the derived claim state.
   * @param report - report id.
   * @returns the hops, oldest first.
   */
  readHops(report: string): Promise<readonly RouteHop[]>
}

/**
 * Assemble the maintenance view.
 *
 * Two passes, because they cost different things: the first asks the ledger what
 * it believes (cheap), the second asks git what is true (one `worktree list` per
 * repository, plus one `status` per checkout that is actually on disk).
 * @param deps - the ledger readers.
 * @param settings - the configured limits.
 * @param enabled - whether allocation is on in this deployment.
 * @returns the view.
 */
export async function buildWorktreeReport(
  deps: MaintenanceDeps,
  settings: WorktreeSettings,
  enabled: boolean,
): Promise<WorktreeReport> {
  const digests = await deps.listReports()

  // ---- pass one: what the ledger believes ----------------------------------
  const records: WorktreeRecord[] = []
  for (const front of digests) {
    const binding = front.worktree
    if (binding === undefined) continue
    // Ask git, not just the filesystem: a plain directory at the recorded path is
    // not a checkout, and calling it "dirty" is the opposite of the truth.
    const reality = await inspectCheckout(binding.path)
    const onDisk = reality.presence !== 'missing'
    records.push({
      report: front.report,
      subject: front.subject,
      status: front.status,
      path: binding.path,
      ...(binding.branch === undefined ? {} : { branch: binding.branch }),
      ...(binding.head === undefined ? {} : { head: binding.head }),
      ...(binding.repo === undefined ? {} : { repo: binding.repo }),
      allocated: binding.allocated === true,
      state: leaseState(await deps.readHops(front.report)),
      onDisk,
      presence: reality.presence,
      // `git status` is only meaningful for a checkout git actually recognises.
      ...(reality.presence === 'worktree' ? { clean: await isWorktreeClean(binding.path) } : {}),
      prunable: false,
    })
  }

  // ---- pass two: what git says --------------------------------------------
  // Grouped by repository because several reports can share one, and the listing
  // is the expensive part of this view.
  const byRepo = new Map<string, WorktreeRecord[]>()
  for (const record of records) {
    const key = record.repo ?? record.path
    const bucket = byRepo.get(key)
    if (bucket === undefined) byRepo.set(key, [record])
    else bucket.push(record)
  }

  const warnings: string[] = []
  const unmanaged: string[] = []
  const dangling: string[] = []
  const prunable: string[] = []
  for (const bucket of byRepo.values()) {
    const first = bucket[0]
    if (first === undefined) continue
    const repo = await resolveRepo(first.path)
      ?? (first.repo === undefined ? undefined : await resolveRepo(first.repo))
    if (repo === undefined) {
      warnings.push(`the repository holding ${bucket.map((record) => record.report).join(', ')} could not be resolved, `
        + 'so those checkouts were not inspected')
      continue
    }

    let entries
    try {
      entries = await listWorktrees(repo)
    } catch (error) {
      warnings.push(`git could not list the working trees of ${repo.commonDir}: `
        + `${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    for (const entry of entries) {
      // Recorded for the per-record flag as well as the flat list, so a caller
      // can see at a glance which bound checkout git has lost track of.
      if (entry.prunable) {
        prunable.push(entry.path)
        dangling.push(entry.path)
      }
    }
    // What git has that the ledger has never heard of. This is the one thing the
    // ledger structurally cannot see — a checkout someone made by hand — so it is
    // exactly what a maintenance view has to surface rather than quietly omit.
    // Prunable entries are left out: they are already reported as dangling, and
    // they are the one thing a report cannot adopt.
    for (const entry of entries) {
      if (entry.bare || entry.prunable || samePath(entry.path, repo.repoRoot)) continue
      if (records.some((record) => samePath(record.path, entry.path))) continue
      unmanaged.push(entry.path)
    }
  }

  const resolved = records.map((record) => (
    prunable.some((path) => samePath(path, record.path)) ? { ...record, prunable: true } : record
  ))

  // ---- what is worth saying out loud ---------------------------------------
  const active = resolved.filter((record) => record.state === 'held').length
  const retained = resolved.filter((record) => (
    record.state === 'released' && record.onDisk && record.presence === 'worktree'
  )).length

  for (const record of resolved) {
    if (record.presence === 'not-a-worktree') {
      warnings.push(`the directory at ${record.path} (${record.report}) is no longer a working tree; it is not counted `
        + 'as retained and will not be reclaimed automatically. Move it back, repair it, or remove it by hand.')
      continue
    }
    if (record.state === 'held' && !record.onDisk) {
      warnings.push(`${record.report} holds a claim on ${record.path}, and that checkout is no longer on disk. `
        + 'Release the claim, or close the report — closing releases it.')
    }
    // A released binding whose directory is gone is not yet *recorded* as such;
    // the next allocation notices it, so this is a heads-up rather than a fault.
    if (record.state === 'released' && !record.onDisk) {
      warnings.push(`${record.report}'s bound checkout at ${record.path} is gone, and the ledger still records the claim `
        + 'as released rather than reclaimed. The next allocation will note that it is gone.')
    }
    if (record.clean === false && record.state !== 'held') {
      warnings.push(`the kept checkout at ${record.path} (${record.report}) has uncommitted work, `
        + 'so it will never be reclaimed automatically.')
    }
  }
  if (retained > settings.maxRetained && settings.reclaim === 'never') {
    warnings.push(`${retained} checkouts are kept on disk past the retained limit of ${settings.maxRetained}, `
      + 'and automatic reclamation is off, so they will accumulate. Close reports with worktree:"remove-if-clean", '
      + 'or set worktree.reclaim to "oldest-closed".')
  }
  // Deduplicated because two bindings can name the same repository, and the
  // listing below is per repository rather than per binding.
  const uniqueDangling = [...new Set(dangling)].sort()
  for (const path of uniqueDangling) {
    warnings.push(`git reports the worktree entry at ${path} as dangling. If it was moved by hand, run `
      + 'git worktree repair from the new location; otherwise prune the stale entry.')
  }
  for (const path of unmanaged) {
    warnings.push(`git has a working tree no report is bound to: ${path}. A report can adopt it with report_lease.`)
  }

  resolved.sort((left, right) => left.report.localeCompare(right.report))
  return {
    generatedAt: Date.now(),
    enabled,
    limits: {
      maxActive: settings.maxActive,
      maxRetained: settings.maxRetained,
      reclaim: settings.reclaim,
    },
    active,
    retained,
    records: resolved,
    unmanaged: [...new Set(unmanaged)].sort(),
    dangling: uniqueDangling,
    warnings,
  }
}
