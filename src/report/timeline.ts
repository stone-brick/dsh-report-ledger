/**
 * Timeline assembly: the recursive session subtree plus the reports that touch it.
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

import type { ReportFrontMatter } from './types.ts'

/** The session-header fields the timeline reads. */
export interface SessionHeaderLike {
  /** Session id. */
  readonly id: string
  /** Session this one was forked from or spawned by. */
  readonly parentSession?: string
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
  /** Parent session id, absent for the root. */
  readonly parentId?: string
  /** Depth relative to the requested root (the root is 0). */
  readonly depth: number
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

/** The complete payload the tab renders. */
export interface TimelinePayload {
  /** The session the timeline was requested for. */
  readonly root: string
  /** When this payload was assembled, Unix epoch milliseconds. */
  readonly generatedAt: number
  /** The subtree, root first, DFS pre-order. */
  readonly sessions: readonly SessionNode[]
  /** Every report touching any session in the subtree, newest activity first. */
  readonly reports: readonly ReportFrontMatter[]
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
    const header = record.header
    const title = titles.get(id)
    nodes.push({
      id,
      depth,
      delegated: header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0,
      live: record.live === true,
      ...(typeof header.parentSession === 'string' && header.parentSession !== ''
        ? { parentId: header.parentSession }
        : {}),
      ...(title === undefined ? {} : { title }),
      ...(typeof header.agentPreset === 'string' ? { agentPreset: header.agentPreset } : {}),
      ...(typeof header.createdAt === 'number' ? { createdAt: header.createdAt } : {}),
    })
    for (const child of children.get(id) ?? []) walk(child.header.id, depth + 1)
  }
  walk(root, 0)
  return nodes
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
  return reports
    .filter((front) => front.from !== undefined && (
      members.has(front.from)
      || front.to.some((id) => members.has(id))
      || front.cc.some((id) => members.has(id))
      || front.authors.some((id) => members.has(id))
    ))
    .slice()
    .sort((left, right) => right.updated - left.updated || right.report.localeCompare(left.report))
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
 * Assemble the payload for one root session.
 *
 * Titles are resolved only for the sessions that survive the subtree walk: on a
 * long-lived deployment the session corpus is far larger than one collaboration,
 * and a title is cosmetic while the tree is not.
 * @param deps - data sources.
 * @param root - the requested root session id.
 * @returns the payload; `sessions` is empty when the root is unknown.
 */
export async function buildTimeline(deps: TimelineDeps, root: string): Promise<TimelinePayload> {
  const records = await deps.listSessionRecords()
  const bare = buildSubtree(records, root)
  const titles = bare.length === 0 ? new Map<string, string>() : await deps.readTitles(bare.map((node) => node.id))
  const sessions = withTitles(bare, titles)
  const reports = reportsForSubtree(await deps.listReports(), sessions)
  return { root, generatedAt: Date.now(), sessions, reports }
}
