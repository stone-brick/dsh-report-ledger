/**
 * Timeline assembly: the recursive session subtree plus the reports that touch it,
 * and the same assembly over the whole ledger when the reader asks for it.
 *
 * Kept free of any harness object so the whole thing is unit-testable: the
 * caller adapts `ctx.sessionQuery` and the ledger into the small structural
 * shapes below, and this module turns them into the JSON the tab renders.
 *
 * Ordering is DFS pre-order with siblings sorted by creation time, which is both
 * hierarchical and chronological — a child is always created after its parent,
 * so "top to bottom" reads as the collaboration actually unfolded.
 *
 * @module dsh-report-ledger/report/timeline
 */

import { leaseState, type LeaseState } from './lease.ts'
import type { ReportFrontMatter, RouteHop } from './types.ts'

/**
 * Which slice of the ledger a payload describes.
 *
 * `tree` is the session subtree a tab was opened in — the default, and the only
 * scope that can draw a collaboration as a tree. `all` is the whole ledger: every
 * report, whatever session wrote it and whatever project it came from.
 */
export type TimelineScope = 'tree' | 'all'

/**
 * The `root` a global payload carries.
 *
 * A global payload has no tree root, and `root` is a required field of the wire
 * contract. A sentinel is better than an empty string: the client compares ids
 * against it (the canvas refuses to "enter" the current root), and `''` would
 * compare equal to a view that has no session bound yet.
 */
export const ALL_SCOPE_ROOT = '*'

/** The session-header fields the timeline reads. */
export interface SessionHeaderLike {
  /** Session id. */
  readonly id: string
  /** Session this one was forked from or spawned by. */
  readonly parentSession?: string
  /** Absolute working directory the session was created in, when the harness recorded one. */
  readonly cwd?: string
  /** Creation time, Unix epoch milliseconds. */
  readonly createdAt?: number
  /** Delegation depth; absent (zero) for a top-level session. */
  readonly delegationDepth?: number
  /** Coarse product classification; `subagent` marks a delegated child. */
  readonly origin?: string
  /** Agent preset the session runs under. */
  readonly agentPreset?: string
}

/** One session record as the timeline consumes it. */
export interface SessionRecordLike {
  /** The durable header. */
  readonly header: SessionHeaderLike
  /** Whether the session is resident in this process. */
  readonly live?: boolean
}

/** One node of the rendered subtree. */
export interface SessionNode {
  /** Session id. */
  readonly id: string
  /** Parent session id, absent for the root and absent throughout a global payload. */
  readonly parentId?: string
  /** Depth relative to the requested root (the root is 0). */
  readonly depth: number
  /** Absolute working directory the session was created in; the global view's project column. */
  readonly cwd?: string
  /** Resolved display title, when the title service supplied one. */
  readonly title?: string
  /** Whether the session is a delegated child. */
  readonly delegated: boolean
  /** Whether the session is currently resident. */
  readonly live: boolean
  /** Agent preset, when recorded. */
  readonly agentPreset?: string
  /** Creation time, Unix epoch milliseconds. */
  readonly createdAt?: number
}

/**
 * One bound checkout, as the views render it.
 *
 * The lease state travels with the lane rather than being recomputed in the
 * browser. The two halves of this plugin share no code by design, so a state
 * machine copied into the client would be a *second* implementation — and the
 * thing it decides is whether a checkout may be claimed, which is not a decision
 * two implementations should be able to disagree about.
 */
export interface WorktreeLane {
  /** The report holding the binding. */
  readonly report: string
  /** Absolute path of the checkout. */
  readonly path: string
  /** Short branch name; absent for a detached checkout. */
  readonly branch?: string
  /** Whether the ledger created this checkout, rather than adopting one. */
  readonly allocated: boolean
  /** Whether the claim is live, ended, or the checkout has since been cleared. */
  readonly state: LeaseState
}

/** The complete payload the tab renders. */
export interface TimelinePayload {
  /** Which slice of the ledger this payload describes. */
  readonly scope: TimelineScope
  /** The session the timeline was requested for; {@link ALL_SCOPE_ROOT} for a global payload. */
  readonly root: string
  /** When this payload was assembled, Unix epoch milliseconds. */
  readonly generatedAt: number
  /**
   * The subtree, root first, DFS pre-order.
   *
   * In a global payload there is no subtree: these are the sessions that appear
   * somewhere in the ledger (as author, addressee, copy, or co-author), each at
   * depth 0 and without a parent link, so a session is framed exactly when it has
   * a report to show. A session that never touched a report is not part of the
   * ledger and has no business in this list.
   */
  readonly sessions: readonly SessionNode[]
  /** The reports in scope, newest activity first. */
  readonly reports: readonly ReportFrontMatter[]
  /** The checkouts those reports are bound to, ordered by branch then report. */
  readonly worktrees: readonly WorktreeLane[]
}

/**
 * Collect the checkouts a set of reports is bound to.
 *
 * Only a report that carries a binding costs a hop read, so a ledger with no
 * working trees in play pays one pass over the digests and nothing more.
 * @param reports - the report digests in play.
 * @param readHops - read one report's hops.
 * @returns one lane per bound report.
 */
export async function worktreeLanes(
  reports: readonly ReportFrontMatter[],
  readHops: (report: string) => Promise<readonly RouteHop[]>,
): Promise<WorktreeLane[]> {
  const lanes: WorktreeLane[] = []
  for (const front of reports) {
    const binding = front.worktree
    if (binding === undefined) continue
    lanes.push({
      report: front.report,
      path: binding.path,
      ...(binding.branch === undefined ? {} : { branch: binding.branch }),
      allocated: binding.allocated === true,
      state: leaseState(await readHops(front.report)),
    })
  }
  return lanes.sort((left, right) => (left.branch ?? left.path).localeCompare(right.branch ?? right.path)
    || left.report.localeCompare(right.report))
}

/**
 * Build the subtree rooted at one session.
 *
 * A record is included only when its parent chain reaches the root, so a session
 * from an unrelated tree can never leak into the view. Cycles and orphaned
 * records are dropped rather than followed.
 * @param records - every known session record.
 * @param root - the requested root session id.
 * @param titles - resolved display titles, keyed by session id.
 * @returns the subtree in DFS pre-order.
 */
export function buildSubtree(
  records: readonly SessionRecordLike[],
  root: string,
  titles: ReadonlyMap<string, string> = new Map(),
): SessionNode[] {
  const byId = new Map<string, SessionRecordLike>()
  const children = new Map<string, SessionRecordLike[]>()
  for (const record of records) {
    const id = record.header?.id
    if (typeof id !== 'string' || id === '') continue
    byId.set(id, record)
    const parent = record.header.parentSession
    if (typeof parent === 'string' && parent !== '') {
      const bucket = children.get(parent)
      if (bucket === undefined) children.set(parent, [record])
      else bucket.push(record)
    }
  }
  if (!byId.has(root)) return []

  for (const bucket of children.values()) {
    bucket.sort((left, right) => {
      const a = left.header.createdAt ?? 0
      const b = right.header.createdAt ?? 0
      return a - b || left.header.id.localeCompare(right.header.id)
    })
  }

  const nodes: SessionNode[] = []
  const visited = new Set<string>()
  const walk = (id: string, depth: number): void => {
    if (visited.has(id)) return
    visited.add(id)
    const record = byId.get(id)
    if (record === undefined) return
    nodes.push(sessionNode(record, depth, titles.get(id), true))
    for (const child of children.get(id) ?? []) walk(child.header.id, depth + 1)
  }
  walk(root, 0)
  return nodes
}

/**
 * Turn one record into a renderable node.
 *
 * The single place the node's field set is decided, so the subtree and the global
 * listing cannot drift: a field added for one and forgotten for the other would
 * be a silently missing column rather than an error.
 * @param record - the session record.
 * @param depth - depth to render at.
 * @param title - resolved display title, if any.
 * @param withParent - whether the node keeps its parent link. A global payload
 *   drops it: the parent is another frame at depth 0, so a link would describe a
 *   hierarchy the payload deliberately does not have.
 * @returns the node.
 */
function sessionNode(record: SessionRecordLike, depth: number, title: string | undefined, withParent: boolean): SessionNode {
  const header = record.header
  return {
    id: header.id,
    depth,
    delegated: header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0,
    live: record.live === true,
    ...(withParent && typeof header.parentSession === 'string' && header.parentSession !== ''
      ? { parentId: header.parentSession }
      : {}),
    ...(title === undefined ? {} : { title }),
    ...(typeof header.agentPreset === 'string' ? { agentPreset: header.agentPreset } : {}),
    ...(typeof header.cwd === 'string' && header.cwd !== '' ? { cwd: header.cwd } : {}),
    ...(typeof header.createdAt === 'number' ? { createdAt: header.createdAt } : {}),
  }
}

/**
 * Keep the reports that touch any session in the subtree.
 *
 * A report is relevant when the subtree participates anywhere in its transfer
 * path — as origin, addressee, copy, or co-author. Reports from unrelated trees
 * are excluded, which is what makes the view a collaboration ledger rather than
 * a global dump.
 * @param reports - every report digest in the ledger.
 * @param subtree - the subtree nodes.
 * @returns the relevant digests, most recently updated first.
 */
export function reportsForSubtree(
  reports: readonly ReportFrontMatter[],
  subtree: readonly SessionNode[],
): ReportFrontMatter[] {
  const members = new Set(subtree.map((node) => node.id))
  return newestFirst(reports.filter((front) => front.from !== undefined && (
    members.has(front.from)
    || front.to.some((id) => members.has(id))
    || front.cc.some((id) => members.has(id))
    || front.authors.some((id) => members.has(id))
  )))
}

/**
 * The ledger's listing order: newest activity first, report id as the tie-break.
 *
 * Shared by the tree and the global listing so the two cannot sort the same
 * ledger differently — a reader switching scope should see the same order.
 * @param reports - the digests to order.
 * @returns a new, ordered array.
 */
function newestFirst(reports: readonly ReportFrontMatter[]): ReportFrontMatter[] {
  return [...reports].sort((left, right) => right.updated - left.updated || right.report.localeCompare(left.report))
}

/** Inputs the timeline needs, injected so the assembly stays harness-free. */
export interface TimelineDeps {
  /**
   * Every known session record.
   * @returns the records.
   */
  listSessionRecords(): Promise<readonly SessionRecordLike[]>
  /**
   * Resolve display titles.
   * @param ids - session ids to resolve.
   * @returns a title per session that has one.
   */
  readTitles(ids: readonly string[]): Promise<ReadonlyMap<string, string>>
  /**
   * Every report digest in the ledger.
   * @returns the digests.
   */
  listReports(): Promise<readonly ReportFrontMatter[]>
  /**
   * Read one report's hops.
   *
   * Needed only for reports that carry a working-tree binding, because lease
   * liveness is derived from the hop stream and nowhere else.
   * @param report - report id.
   * @returns the hops, oldest first.
   */
  readHops(report: string): Promise<readonly RouteHop[]>
}

/**
 * Attach resolved titles to subtree nodes.
 * @param nodes - nodes built without titles.
 * @param titles - resolved display titles, keyed by session id.
 * @returns the nodes with titles where one was found.
 */
export function withTitles(nodes: readonly SessionNode[], titles: ReadonlyMap<string, string>): SessionNode[] {
  return nodes.map((node) => {
    const title = titles.get(node.id)
    return title === undefined ? node : { ...node, title }
  })
}

/**
 * Assemble the payload for one root session, or for the whole ledger.
 *
 * Titles are resolved only for the sessions that survive the subtree walk: on a
 * long-lived deployment the session corpus is far larger than one collaboration,
 * and a title is cosmetic while the tree is not.
 * @param deps - data sources.
 * @param root - the requested root session id; ignored when `scope` is `all`.
 * @param scope - which slice of the ledger to assemble; `tree` by default.
 * @returns the payload; `sessions` is empty when the root is unknown.
 */
export async function buildTimeline(
  deps: TimelineDeps,
  root: string,
  scope: TimelineScope = 'tree',
): Promise<TimelinePayload> {
  const allReports = await deps.listReports()
  if (scope === 'all') return await buildGlobalTimeline(deps, allReports)
  const records = await deps.listSessionRecords()
  // The caller usually names the session it is looking at, not the tree it belongs
  // to. Resolve upward first: a delegated worker's reports point at its parent and
  // siblings, and building only the worker's own subtree would leave every wire
  // landing on the out-of-tree frame.
  const byId = new Map(records.map((record) => [record.header.id, record]))
  let treeRoot = root
  const seen = new Set<string>()
  while (byId.has(treeRoot) && !seen.has(treeRoot)) {
    seen.add(treeRoot)
    const parent = byId.get(treeRoot)?.header.parentSession
    if (parent === undefined || parent === treeRoot || !byId.has(parent)) break
    treeRoot = parent
  }
  const base = buildSubtree(records, treeRoot)
  // One hop out: a report in this tree often addresses sessions in *another* tree of
  // the same workspace (a peer the user started separately). They are real sessions,
  // so give them frames instead of piling every wire onto the out-of-tree frame; the
  // reports that touch them come along, which is what makes the drawing coherent.
  const known = new Set(base.map((node) => node.id))
  const mentioned = new Set<string>()
  for (const front of reportsForSubtree(allReports, base)) {
    for (const id of [front.from, ...front.to, ...front.cc, ...front.authors]) {
      if (id !== undefined && !known.has(id) && byId.has(id)) mentioned.add(id)
    }
  }
  const baseDepth = base.reduce((max, node) => Math.max(max, node.depth), 0)
  const extra: SessionNode[] = [...mentioned].sort().flatMap((id) => {
    const record = byId.get(id)
    if (record === undefined) return []
    return [sessionNode(record, baseDepth + 1, undefined, true)]
  })
  const bare = [...base, ...extra]
  const titles = bare.length === 0 ? new Map<string, string>() : await deps.readTitles(bare.map((node) => node.id))
  const sessions = withTitles(bare, titles)
  const reports = reportsForSubtree(allReports, sessions)
  const worktrees = await worktreeLanes(reports, deps.readHops)
  return { scope: 'tree', root: treeRoot, generatedAt: Date.now(), sessions, reports, worktrees }
}

/**
 * Assemble the whole-ledger payload.
 *
 * The tree view answers "what happened in this collaboration"; this one answers
 * "what is in the ledger", with no session subtree to anchor it. Two consequences
 * follow, and both are deliberate:
 *
 *  - **Every report is listed.** A report it cannot resolve a session for is not
 *    dropped: the ledger holds it, so the reader gets it. That is also what keeps
 *    a report whose session was deleted from disappearing with its session.
 *  - **Sessions are framed only when the ledger mentions them.** Listing every
 *    session the harness knows would bury 68 reports under 264 empty frames; a
 *    session earns a frame by participating in some report.
 *
 * The root is {@link ALL_SCOPE_ROOT}: there is no real root, and the canvas
 * compares ids against it (so it must not accidentally equal a session id).
 * @param deps - data sources.
 * @param allReports - every digest, already read.
 * @returns the global payload.
 */
async function buildGlobalTimeline(
  deps: TimelineDeps,
  allReports: readonly ReportFrontMatter[],
): Promise<TimelinePayload> {
  const records = await deps.listSessionRecords()
  const byId = new Map(records.map((record) => [record.header.id, record]))
  const reports = newestFirst(allReports)
  const members = new Set<string>()
  for (const front of reports) {
    for (const id of [front.from, ...front.to, ...front.cc, ...front.authors]) {
      if (id !== undefined && byId.has(id)) members.add(id)
    }
  }
  const participants = [...members]
    .flatMap((id) => {
      const record = byId.get(id)
      return record === undefined ? [] : [record]
    })
    .sort((left, right) => (left.header.createdAt ?? 0) - (right.header.createdAt ?? 0)
      || left.header.id.localeCompare(right.header.id))
  const nodes = participants.map((record) => sessionNode(record, 0, undefined, false))
  const titles = nodes.length === 0 ? new Map<string, string>() : await deps.readTitles(nodes.map((node) => node.id))
  const sessions = withTitles(nodes, titles)
  const worktrees = await worktreeLanes(reports, deps.readHops)
  return { scope: 'all', root: ALL_SCOPE_ROOT, generatedAt: Date.now(), sessions, reports, worktrees }
}
