/**
 * The peer roster: who exists, how they relate to the caller, and who may be
 * addressed.
 *
 * The harness records lineage durably (`SessionHeader.parentSession`) but nothing
 * else about relationships, and it has no notion of an agent that started an
 * independent peer rather than a subordinate. A peer session is deliberately a
 * *root* session — not a child — so that it survives the delegating agent, owns
 * its own preset and lifecycle, and is not counted against a delegation budget.
 * That choice means lineage cannot express the relationship, so this module keeps
 * the one record that can: an append-only peer log beside the ledger.
 *
 * The log is also the authority record. DSH's delegation seam refuses
 * non-adjacent messaging with the note that "other agents, ancestors, teams,
 * workflows, and hosts remain rejected until an explicit authority protocol has
 * a production consumer" — this plugin is that consumer, and the rule it
 * implements is deliberately narrow: **lineage grants a channel, a prior
 * recorded exchange grants a channel, and starting a session grants a channel
 * over what you started.**
 *
 * @module dsh-report-ledger/report/roster
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ledgerRoot } from './ledger.ts'
import type { SessionRecordLike } from './timeline.ts'
import type { ReportFrontMatter } from './types.ts'

/** Append-only peer log file name. */
const PEER_LOG = 'peers.jsonl'

/**
 * Absolute path of the peer log.
 * @returns the path.
 */
export function peerLogPath(): string {
  return join(ledgerRoot(), PEER_LOG)
}

/** One record of an agent started by another agent. */
export interface PeerRecord {
  /** The peer's session id. */
  readonly sessionId: string
  /** The session that started it — the authority it holds over the peer. */
  readonly startedBy: string
  /** Creation time, Unix epoch milliseconds. */
  readonly startedAt: number
  /** Optional display name supplied by the starter. */
  readonly name?: string
  /** Working directory the peer was given. */
  readonly cwd?: string
}

/** Read one string field, tolerating absent values. */
function str(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Append one peer record.
 * @param record - the record to persist.
 */
export async function appendPeer(record: PeerRecord): Promise<void> {
  await mkdir(ledgerRoot(), { recursive: true })
  await appendFile(peerLogPath(), `${JSON.stringify(record)}\n`, 'utf8')
}

/**
 * Read the whole peer log.
 *
 * A malformed line is skipped rather than allowed to poison the roster: the file
 * is append-only and human-editable, so robustness beats strictness here.
 * @returns every readable record, oldest first.
 */
export async function readPeers(): Promise<PeerRecord[]> {
  let raw: string
  try {
    raw = await readFile(peerLogPath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const records: PeerRecord[] = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      continue
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    const sessionId = str(entry, 'sessionId')
    const startedBy = str(entry, 'startedBy')
    if (sessionId === undefined || startedBy === undefined) continue
    const name = str(entry, 'name')
    const cwd = str(entry, 'cwd')
    records.push({
      sessionId,
      startedBy,
      startedAt: typeof entry.startedAt === 'number' ? entry.startedAt : 0,
      ...(name === undefined ? {} : { name }),
      ...(cwd === undefined ? {} : { cwd }),
    })
  }
  return records
}

/** How a session stands in relation to the caller. */
export type PeerRelation = 'ancestor' | 'descendant' | 'sibling' | 'started' | 'contact' | 'co-present'

/** One roster row. */
export interface PeerRow {
  /** Session id. */
  readonly sessionId: string
  /** How the caller is related to it. */
  readonly relation: PeerRelation
  /** Display title, when one could be resolved. */
  readonly title?: string
  /** Name supplied when the caller started it. */
  readonly name?: string
  /** Whether it is resident right now, so a delivery would land immediately. */
  readonly live: boolean
  /** Delegation depth, when recorded. */
  readonly depth?: number
  /** Reports in the ledger that touch both sessions. */
  readonly reports: number
  /** Most recent activity seen for it, Unix epoch milliseconds. */
  readonly lastActivity?: number
}

/** Inputs for {@link buildRoster}, injected so the classification stays pure. */
export interface RosterInput {
  /** The caller's session id. */
  readonly self: string
  /** Every known session record. */
  readonly records: readonly SessionRecordLike[]
  /** Session ids that are resident right now. */
  readonly liveIds: ReadonlySet<string>
  /** Peer records from the log. */
  readonly peers: readonly PeerRecord[]
  /** Every report digest in the ledger. */
  readonly reports: readonly ReportFrontMatter[]
  /** Resolved display titles. */
  readonly titles: ReadonlyMap<string, string>
  /** Requested scope. */
  readonly scope: 'related' | 'live' | 'all'
  /** Maximum rows to return. */
  readonly limit: number
}

/** Walk the ancestor chain of one session. */
function ancestorsOf(byId: Map<string, SessionRecordLike>, id: string): Set<string> {
  const ancestors = new Set<string>()
  let cursor = byId.get(id)?.header.parentSession
  // Bounded by the corpus size, so a corrupt parent chain cannot spin forever.
  for (let step = 0; typeof cursor === 'string' && cursor !== '' && step <= byId.size; step++) {
    if (ancestors.has(cursor)) break
    ancestors.add(cursor)
    cursor = byId.get(cursor)?.header.parentSession
  }
  return ancestors
}

/** Collect every descendant of one session. */
function descendantsOf(children: Map<string, string[]>, id: string): Set<string> {
  const found = new Set<string>()
  const queue = [id]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const child of children.get(current) ?? []) {
      if (found.has(child)) continue
      found.add(child)
      queue.push(child)
    }
  }
  return found
}

/**
 * Build the roster the caller sees.
 *
 * Classification is ordered by how strong the relationship is, and the first
 * match wins: an ancestor that is also a ledger contact is reported as an
 * ancestor, because that is the channel the caller should reason about.
 * @param input - the roster inputs.
 * @returns the rows, strongest relation first, capped at the limit.
 */
export function buildRoster(input: RosterInput): PeerRow[] {
  const byId = new Map<string, SessionRecordLike>()
  const children = new Map<string, string[]>()
  for (const record of input.records) {
    const id = record.header?.id
    if (typeof id !== 'string' || id === '') continue
    byId.set(id, record)
    const parent = record.header.parentSession
    if (typeof parent === 'string' && parent !== '') {
      const bucket = children.get(parent)
      if (bucket === undefined) children.set(parent, [id])
      else bucket.push(id)
    }
  }

  const ancestors = ancestorsOf(byId, input.self)
  const descendants = descendantsOf(children, input.self)
  const selfParent = byId.get(input.self)?.header.parentSession
  const siblings = new Set<string>()
  if (typeof selfParent === 'string' && selfParent !== '') {
    for (const sibling of children.get(selfParent) ?? []) if (sibling !== input.self) siblings.add(sibling)
  }

  const started = new Set<string>()
  const names = new Map<string, string>()
  for (const peer of input.peers) {
    if (peer.startedBy !== input.self) continue
    started.add(peer.sessionId)
    if (peer.name !== undefined) names.set(peer.sessionId, peer.name)
  }

  // A "contact" is anyone the ledger shows an exchange with, in either direction.
  const contacts = new Map<string, { reports: number; lastActivity: number }>()
  for (const front of input.reports) {
    const others = new Set<string>([front.from, ...front.to, ...front.cc, ...front.authors])
    if (!others.has(input.self)) continue
    for (const other of others) {
      if (other === input.self || other === '') continue
      const existing = contacts.get(other)
      if (existing === undefined) contacts.set(other, { reports: 1, lastActivity: front.updated })
      else {
        existing.reports += 1
        if (front.updated > existing.lastActivity) existing.lastActivity = front.updated
      }
    }
  }

  const rows: PeerRow[] = []
  // Candidates are the union of the session corpus and the ids this caller has a
  // recorded relationship with. The union matters: a peer that was just started,
  // or whose session record has aged out of the corpus, must still be listed —
  // the caller holds a channel to it, and an address it legitimately owns must
  // never disappear from the roster.
  const candidates = new Set<string>(byId.keys())
  for (const id of started) candidates.add(id)
  for (const id of contacts.keys()) candidates.add(id)

  for (const id of candidates) {
    if (id === input.self) continue
    const record = byId.get(id)
    const live = input.liveIds.has(id)
    if (input.scope === 'live' && !live) continue

    let relation: PeerRelation | undefined
    if (ancestors.has(id)) relation = 'ancestor'
    else if (descendants.has(id)) relation = 'descendant'
    else if (siblings.has(id)) relation = 'sibling'
    else if (started.has(id)) relation = 'started'
    else if (contacts.has(id)) relation = 'contact'
    else if (input.scope === 'live' || input.scope === 'all') relation = 'co-present'
    if (relation === undefined) continue

    const contact = contacts.get(id)
    const title = input.titles.get(id)
    const name = names.get(id)
    const depth = record?.header.delegationDepth
    rows.push({
      sessionId: id,
      relation,
      live,
      reports: contact?.reports ?? 0,
      ...(title === undefined ? {} : { title }),
      ...(name === undefined ? {} : { name }),
      ...(depth === undefined ? {} : { depth }),
      ...(contact === undefined ? {} : { lastActivity: contact.lastActivity }),
    })
  }

  const rank: Record<PeerRelation, number> = {
    ancestor: 0,
    descendant: 1,
    sibling: 2,
    started: 3,
    contact: 4,
    'co-present': 5,
  }
  rows.sort((left, right) =>
    rank[left.relation] - rank[right.relation]
    || Number(right.live) - Number(left.live)
    || (right.lastActivity ?? 0) - (left.lastActivity ?? 0)
    || left.sessionId.localeCompare(right.sessionId))

  return rows.slice(0, Math.max(0, input.limit))
}

/**
 * Whether a session already holds a channel to another.
 *
 * This is the authority predicate the roster documents: lineage in either
 * direction, a sibling under the same parent, or a session the caller started.
 * A ledger contact is deliberately **not** sufficient on its own for a fresh
 * channel — reaching out through the ledger is how contact is established, and
 * the recorded exchange is what makes the relationship real.
 * @param input - the roster inputs (scope and limit are ignored).
 * @param target - the session id being addressed.
 * @returns true when the caller may address it.
 */
export function holdsChannelTo(input: Omit<RosterInput, 'scope' | 'limit'>, target: string): boolean {
  if (target === input.self || target === '') return false
  const byId = new Map<string, SessionRecordLike>()
  const children = new Map<string, string[]>()
  for (const record of input.records) {
    const id = record.header?.id
    if (typeof id !== 'string' || id === '') continue
    byId.set(id, record)
    const parent = record.header.parentSession
    if (typeof parent === 'string' && parent !== '') {
      const bucket = children.get(parent)
      if (bucket === undefined) children.set(parent, [id])
      else bucket.push(id)
    }
  }
  if (ancestorsOf(byId, input.self).has(target)) return true
  if (descendantsOf(children, input.self).has(target)) return true
  const selfParent = byId.get(input.self)?.header.parentSession
  if (typeof selfParent === 'string' && selfParent !== '' && (children.get(selfParent) ?? []).includes(target)) return true
  if (byId.get(target)?.header.parentSession === input.self) return true
  return input.peers.some((peer) => peer.startedBy === input.self && peer.sessionId === target)
}
