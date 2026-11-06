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
import { allocateId, appendHop, appendReportBody, bodyStartLine, discardUnwrittenId, isValidReportId, listReports, listReportIds, readDigestOf, readHops, readReport, reportExists, reportPath, routePath, writeReport } from './ledger.ts'
import {
  addWorktree, classifyGitRefusal, compareKey, headOf, ignoredPathCount, isWorktreeClean, removeWorktree, resolveRepo, samePath,
  unmergedCommitCount,
} from './worktree.ts'
import type { RepoLocation } from './worktree.ts'
import type { DeliveryMode, Report, ReportFrontMatter, ReportStatus, ReportWorktree, RouteHop } from './types.ts'
import { HOP_ACTIONS, type HopAction } from './types.ts'

/** Body size above which `report_read` returns a head-and-tail excerpt instead of everything. */
const BODY_INLINE_LIMIT = 8000

/** Characters of a truncated body shown from its start. */
const BODY_HEAD_LIMIT = 1200

/**
 * Characters of a truncated body shown from its end.
 *
 * Larger than the head on purpose: a running collaboration appends its newest —
 * and therefore most relevant — sections at the end, and a head-only excerpt used
 * to hide exactly those. The tail is what a returning reader came for.
 */
const BODY_TAIL_LIMIT = 2000

/** Body lines one windowed read returns when the caller does not name a limit. */
const BODY_WINDOW_DEFAULT_LINES = 120

/** Hard cap on the lines one window may return, whatever the caller asks. */
const BODY_WINDOW_MAX_LINES = 400

/**
 * Hard cap on the characters one window may return.
 *
 * A limit counted in lines is only a budget if lines have a bounded size, and a
 * body may legitimately contain one enormous line (a minified payload, a pasted
 * blob). Without this the "default 120 lines" could still be megabytes.
 */
const BODY_WINDOW_MAX_CHARS = 20000

/** How many headings the derived outline lists before it stops. */
const OUTLINE_MAX_ENTRIES = 30

/** Longest heading text one outline row keeps. */
const OUTLINE_MAX_CHARS = 120

/** Most rows one thread listing returns before it stops. */
const THREAD_MAX_ROWS = 400

/** Deepest nesting a thread listing follows before it stops. */
const THREAD_MAX_DEPTH = 64

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

/**
 * One windowed read of a body.
 *
 * Offsets count **body lines** — the unit the derived outline prints — so a
 * caller can go from an outline row straight to a window without translating
 * document lines. A read without either field returns the default view (the whole
 * body when it is small, a head-and-tail excerpt with an outline when it is not).
 */
export interface ReadOptions {
  /** 1-based body line to start at. */
  readonly offset?: number
  /** How many body lines to return. */
  readonly limit?: number
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
  /** Originator plus every co-author, in contribution order. */
  readonly authors: readonly string[]
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

/** One digest in a thread listing, with where it sits in the tree. */
export interface ThreadRow {
  /** 0 for the root, one more for every level down. */
  readonly depth: number
  /** The digest, projected exactly like a flat listing row. */
  readonly row: DigestRow
  /** Whether this is the report the caller asked about. */
  readonly anchor: boolean
}

/**
 * One line of reports around a single report: its root, and every descendant.
 *
 * Built from digests alone, so a listing costs one scan and records no hop: a
 * thread is a map, and looking at a map is not reading any report on it.
 */
export interface ThreadListing {
  /** The root the walk started from — not necessarily the report that was asked for. */
  readonly root: string
  /** Pre-order rows: each report immediately before its children. */
  readonly rows: readonly ThreadRow[]
  /** Why the listing is incomplete, when it had to be cut short. */
  readonly note?: string
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

/**
 * Cut text to a character budget without splitting a surrogate pair.
 *
 * The budget is expressed in characters because that is what a model reads, but
 * `slice` counts UTF-16 code units: a cut inside an astral character (an emoji, a
 * rare CJK ideograph) leaves a lone surrogate that renders as a replacement
 * glyph and can even corrupt the surrounding text. Backing up one unit when the
 * cut lands on a high surrogate keeps the excerpt a valid string.
 * @param text - the text to clip.
 * @param budget - maximum characters to keep.
 * @returns the clipped prefix.
 */
function clipHead(text: string, budget: number): string {
  if (text.length <= budget) return text
  let end = budget
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return text.slice(0, end)
}

/**
 * Cut text to its last `budget` characters without splitting a surrogate pair.
 * The mirror of {@link clipHead}, for the end of a body.
 * @param text - the text to clip.
 * @param budget - maximum characters to keep.
 * @returns the clipped suffix.
 */
function clipTail(text: string, budget: number): string {
  if (text.length <= budget) return text
  let start = text.length - budget
  const first = text.charCodeAt(start)
  if (first >= 0xdc00 && first <= 0xdfff) start++
  return text.slice(start)
}

/** One heading of a body, with the 1-based body line it sits on. */
interface OutlineEntry {
  /** 1-based line inside the body, the same unit `report_read` offsets use. */
  readonly line: number
  /** The heading line, clipped to an affordable width. */
  readonly heading: string
}

/**
 * Derive a table of contents from a body's ATX headings.
 *
 * Derived on every read rather than stored. A persisted heading index would be a
 * second authority over the body: a hand edit would desync it in a way
 * `report_check` — which only compares the digest with the hop stream — could
 * never see. Fenced code is skipped, because a `#` inside a fence is a comment,
 * not a chapter.
 * @param lines - the body's lines.
 * @returns the headings, in document order.
 */
function outlineOf(lines: readonly string[]): OutlineEntry[] {
  const entries: OutlineEntry[] = []
  let fenced = false
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    if (!/^#{1,6}\s+\S/.test(line)) continue
    entries.push({ line: index + 1, heading: clipHead(line.trim(), OUTLINE_MAX_CHARS) })
  }
  return entries
}

/**
 * Render the outline rows, numbering them by body line.
 *
 * The line number is the point: it is what makes the outline an index into the
 * windowed read rather than a mere summary of what a full read would show.
 * @param entries - the derived headings.
 * @returns the section lines.
 */
function renderOutline(entries: readonly OutlineEntry[]): string[] {
  const shown = entries.slice(0, OUTLINE_MAX_ENTRIES)
  const width = String(shown[shown.length - 1]?.line ?? 1).length
  const rows = shown.map((entry) => `  ${String(entry.line).padStart(width)}  ${entry.heading}`)
  const hidden = entries.length - shown.length
  if (hidden > 0) rows.push(`  … ${hidden} more heading(s); window the body to see them`)
  return ['## outline', ...rows]
}

/** A head-and-tail excerpt of a body, plus what it left out. */
interface BodyExcerpt {
  /** Characters shown from the start. */
  readonly head: string
  /** Characters shown from the end. */
  readonly tail: string
  /** 1-based body line the head reaches (partially, when clipped). */
  readonly headEndLine: number
  /** 1-based body line the tail begins at (partially, when clipped). */
  readonly tailStartLine: number
  /** Whether the head stops inside its last line. */
  readonly headClipped: boolean
  /** Whether the tail starts inside its first line. */
  readonly tailClipped: boolean
  /** Characters omitted between the two. */
  readonly omitted: number
  /** Body line count. */
  readonly totalLines: number
}

/**
 * Take a head and a tail from a body, cutting on line boundaries where possible.
 *
 * The line numbers are what the caller reports back, so they have to be true: a
 * cut backs up to the previous newline, and only a single line larger than the
 * whole budget is clipped inside itself (there is no boundary to back up to).
 * @param lines - the body's lines.
 * @param totalChars - the body's character length.
 * @returns the excerpt and the ranges it covers.
 */
function excerptBody(lines: readonly string[], totalChars: number): BodyExcerpt {
  const totalLines = lines.length

  let headEnd = 0
  let headChars = 0
  let headClipped = false
  for (const line of lines) {
    if (headEnd > 0 && headChars + 1 + line.length > BODY_HEAD_LIMIT) break
    if (headEnd === 0 && line.length > BODY_HEAD_LIMIT) {
      headClipped = true
      headEnd = 1
      break
    }
    headChars += headEnd === 0 ? line.length : 1 + line.length
    headEnd += 1
    if (headChars >= BODY_HEAD_LIMIT) break
  }

  let tailStart = totalLines
  let tailChars = 0
  let tailClipped = false
  for (let index = totalLines - 1; index >= 0; index--) {
    const line = lines[index] ?? ''
    if (index < totalLines - 1 && tailChars + 1 + line.length > BODY_TAIL_LIMIT) break
    if (index === totalLines - 1 && line.length > BODY_TAIL_LIMIT) {
      tailClipped = true
      tailStart = index + 1
      break
    }
    tailChars += index === totalLines - 1 ? line.length : 1 + line.length
    tailStart = index + 1
    if (tailChars >= BODY_TAIL_LIMIT) break
  }

  const head = headClipped ? clipHead(lines[0] ?? '', BODY_HEAD_LIMIT) : lines.slice(0, headEnd).join('\n')
  const tail = tailClipped
    ? clipTail(lines[totalLines - 1] ?? '', BODY_TAIL_LIMIT)
    : lines.slice(tailStart - 1).join('\n')
  return {
    head,
    tail,
    headEndLine: headEnd,
    tailStartLine: tailStart,
    headClipped,
    tailClipped,
    // Never negative: the excerpt budgets are smaller than the inline limit, so
    // the two pieces cannot overlap for a body that reaches this path.
    omitted: Math.max(0, totalChars - head.length - tail.length),
    totalLines,
  }
}

/**
 * Name what an excerpt left out, in the units the outline and offsets use.
 * @param excerpt - the excerpt.
 * @returns the one-line marker that sits between head and tail.
 */
function elisionMarker(excerpt: BodyExcerpt): string {
  if (excerpt.headEndLine >= excerpt.tailStartLine) {
    return `… ${excerpt.omitted} characters elided inside body line ${excerpt.headEndLine} …`
  }
  if (excerpt.headClipped || excerpt.tailClipped) {
    return `… ${excerpt.omitted} characters elided (from body line ${excerpt.headEndLine}`
      + ` to body line ${excerpt.tailStartLine}) …`
  }
  return `… ${excerpt.omitted} characters elided`
    + ` (body lines ${excerpt.headEndLine + 1}-${excerpt.tailStartLine - 1}) …`
}

/** Pad a non-negative integer to two digits. */
function two(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Render an instant as ISO 8601 with the machine's UTC offset.
 *
 * `toISOString()` writes `…Z`, which is unambiguous but forces every reader in
 * UTC+8 to add eight hours in their head — and the ledger's readers are the
 * agents and the humans on this machine, not a fleet spread across zones. An
 * explicit offset (`+08:00`) parses exactly as well and is readable as written;
 * because the offset travels with each stamp, a ledger written on two machines
 * in different zones still says what each clock meant.
 * @param ms - instant in epoch milliseconds.
 * @returns the stamp, e.g. `2026-11-06T09:29:31.908+08:00`.
 */
function formatTime(ms: number): string {
  const date = new Date(ms)
  const offset = -date.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  const absolute = Math.abs(offset)
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
    + `T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
    + `.${String(date.getMilliseconds()).padStart(3, '0')}`
    + `${sign}${two(Math.floor(absolute / 60))}:${two(absolute % 60)}`
}

/**
 * Serialize one report for model-facing output.
 * @param front - the digest.
 * @param created - the instant the report was opened, when the path records it.
 * @returns the one-line digest.
 */
function renderFrontLine(front: ReportFrontMatter, created?: number): string {
  const parts = [
    `${front.report} [${front.status}] ${front.subject}`,
    `from=${front.from}`,
    `to=${front.to.length === 0 ? '-' : front.to.join(',')}`,
    `cc=${front.cc.length === 0 ? '-' : front.cc.join(',')}`,
    `authors=${front.authors.join(',')}`,
    `hops=${front.hops}`,
    `reads=${front.reads}`,
    `updated=${formatTime(front.updated)}`,
    // The digest has no creation field, so the first `authored` hop is the
    // record of it. Rendering it beside `updated` is what lets a reader judge
    // how old the original body is without decoding the path by eye.
    ...(created === undefined ? [] : [`created=${formatTime(created)}`]),
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
  /** The derived projection the document carried. */
  readonly stored: string
  /** The projection its hop stream derives. */
  readonly derived: string
  /** Why it was left unwritten, when it was. */
  readonly skipped?: string
}

/**
 * One digest's derived projection, rendered for comparison and for a dry run.
 *
 * Every field `projectRoute` produces is part of the comparison, not just the
 * counters: a definition change can move `to`, `cc` or `authors` while leaving
 * `hops`/`reads`/`last` untouched, and a counters-only equality check would
 * report such a report as in agreement and never repair it. `last.at` is
 * included for the same reason — it is derived too, so a hand-edited timestamp
 * is drift rather than history.
 * @param front - a digest, or the projection computed from a hop stream.
 * @returns one line naming every derived field, so a dry run reads like the
 * real thing.
 */
function digestProjection(front: Pick<ReportFrontMatter, 'to' | 'cc' | 'authors' | 'hops' | 'reads'> & { readonly last?: ReportFrontMatter['last'] }): string {
  const ids = (list: readonly string[]): string => (list.length === 0 ? '-' : list.join(','))
  const last = front.last === undefined ? '-' : `${front.last.action}@${front.last.actor}@${front.last.at}`
  return `to=${ids(front.to)} cc=${ids(front.cc)} authors=${ids(front.authors)} hops=${front.hops} reads=${front.reads} last=${last}`
}

/** Why a digest cannot be rebuilt, when its transfer path is gone. */
const MISSING_PATH = 'its transfer path is missing, so the digest cannot be rebuilt from it'

/**
 * Why a digest cannot be rebuilt, when the path file exists but holds no hop.
 *
 * A crash between opening the sidecar and writing the first hop leaves a zero-byte
 * file; a truncated or unreadable file looks the same to `readHops`. That is not a
 * new report with an empty history — the digest still says how many hops it had —
 * and projecting an empty path over it would erase the recipients and co-authors
 * that are the only remaining record of where the report went.
 */
const EMPTY_PATH = 'its transfer path is empty or unreadable, so the digest cannot be rebuilt from it'

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
    // A report whose digest says it has hops but whose sidecar is gone or holds
    // no parseable hop is a damaged record, not a new one. Appending would start
    // a fresh path and the next #sync would project that empty history over the
    // digest — erasing the recipients and co-authors. Refuse and leave the damage
    // visible instead. The second shape matters most: a plain `report_read`
    // records a hop, so without this guard a read of a crash-truncated sidecar
    // would destroy the digest it was only asked to display.
    const current = await readReport(report)
    const damage = current === undefined ? undefined : await this.#routeDamage(report, current.front)
    if (damage !== undefined) {
      throw new Error(
        `report-ledger: ${report} — ${damage}. Refusing to rewrite the report from an empty history.`
        + ' Restore or repair the .route.jsonl file first.',
      )
    }
    await appendHop(report, hop)
    return await this.#sync(report, options)
  }

  /**
   * Decide whether a report's transfer path can be trusted for a rewrite.
   * @param report - report identifier.
   * @param front - its digest, which records how many hops should exist.
   * @returns why the path is damaged, or `undefined` when it is usable.
   */
  async #routeDamage(report: string, front: ReportFrontMatter): Promise<string | undefined> {
    if (front.hops === 0) return undefined
    if (!existsSync(routePath(report))) return MISSING_PATH
    return (await readHops(report)).length === 0 ? EMPTY_PATH : undefined
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
    const header = `\n\n---\n\n### contribution by ${name ?? actor} at ${formatTime(Date.now())}\n\n`
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
   *
   * The body has three possible shapes: whole (a small body), a head-and-tail
   * excerpt with a derived outline (a body over the inline limit), or an explicit
   * line window when `offset`/`limit` is given. See {@link #renderBody}.
   * @param report - report identifier.
   * @param actor - reading session id.
   * @param options - optional body window; omitted means the default view.
   * @returns the model-facing rendering.
   */
  async read(report: string, actor: string, options: ReadOptions = {}): Promise<string> {
    const { offset, limit } = options
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 1)) {
      throw new Error('report-ledger: report_read offset must be a positive integer (a body line)')
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new Error('report-ledger: report_read limit must be a positive integer (body lines)')
    }
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
      // The `authored` hop is this report's creation record; it is deliberately
      // read from the path BEFORE the read hop is appended, so a report that was
      // hand-written without a path cannot pass the reader's own look off as the
      // moment it was created.
      const created = hops.find((hop) => hop.action === 'authored')?.at
      const tally = tallyHops(pathHops)
      const path = reportPath(report)
      const view = await this.#renderBody(report, found.body.trim(), offset, limit)
      const route = pathHops.length === 0
        ? '  (no hops recorded)'
        : pathHops.map((hop) => {
          const targets = hop.to.length === 0 ? '' : ` -> ${hop.to.join(',')}`
          const note = hop.note === undefined ? '' : `  # ${hop.note}`
          return `  ${formatTime(hop.at)}  ${hop.action.padEnd(11)} by ${hop.actor}${targets}${note}`
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
        renderFrontLine(recorded, created),
        ...lease,
        `body=${path}`,
        '',
        '## transfer path',
        tally,
        route,
        ...(pending.length === 0 ? [] : ['', `## still pending delivery to: ${pending.join(', ')}`]),
        '',
        ...view,
      ].join('\n')
    })
  }

  /**
   * Render the `## body` section of one read.
   *
   * Three shapes, each answering a different question:
   *
   *  - **whole**: a small body is simply shown. An outline on top of it would be
   *    context spent on a table of contents the reader can see in place.
   *  - **head and tail**: a body over the inline limit is shown from both ends,
   *    with a derived outline and an elision marker naming the line range left
   *    out. The tail is the half that matters — a running collaboration appends
   *    its newest sections at the end, and a head-only excerpt hid exactly those.
   *  - **window**: `offset`/`limit` return a slice by body line. Slicing costs
   *    nothing extra because the body is already in memory.
   *
   * The raw-file line of body line N is `bodyStartLine + N - 1` (the body is the
   * document minus its front matter, and trimming only removes blank lines at the
   * two ends), so a reader that prefers the plain `read` tool is given an exact
   * line rather than an estimate. That lookup opens the file, so it is only paid
   * for when the view is partial and the pointer is actually emitted.
   * @param report - the report id, for the raw-file pointer.
   * @param body - the trimmed body.
   * @param offset - 1-based body line to start at, when a window was asked for.
   * @param limit - body lines to return, when a window was asked for.
   * @returns the section lines.
   */
  async #renderBody(report: string, body: string, offset?: number, limit?: number): Promise<string[]> {
    const lines = body === '' ? [] : body.split('\n')
    const total = lines.length

    if (offset !== undefined || limit !== undefined) {
      if (total === 0) return ['## body (empty)']
      const from = offset ?? 1
      if (from > total) {
        return [
          `## body (no body line ${from}; the body has ${total} line(s))`,
          `The last body line is ${total}; omit offset for the default view, or ask for report_read offset=${total}.`,
        ]
      }
      const wanted = Math.min(limit ?? BODY_WINDOW_DEFAULT_LINES, BODY_WINDOW_MAX_LINES)
      const lastWanted = Math.min(from + wanted - 1, total)
      // Whole lines up to the character ceiling. A single line bigger than the
      // ceiling is the one case with no boundary to stop on: it is clipped inside
      // itself and reported, because silently returning megabytes is worse than
      // returning a partial line and saying so.
      let end = from - 1
      let chars = 0
      while (end < lastWanted) {
        const line = lines[end] ?? ''
        const added = end === from - 1 ? line.length : line.length + 1
        if (end > from - 1 && chars + added > BODY_WINDOW_MAX_CHARS) break
        chars += added
        end += 1
        if (chars >= BODY_WINDOW_MAX_CHARS) break
      }
      let text = lines.slice(from - 1, end).join('\n')
      let clipped = false
      if (text.length > BODY_WINDOW_MAX_CHARS) {
        text = clipHead(text, BODY_WINDOW_MAX_CHARS)
        clipped = true
      }
      const section = [`## body (body lines ${from}-${end} of ${total})`, text]
      if (clipped) {
        section.push(
          '',
          `Body line ${from} alone is longer than one window (${(lines[from - 1] ?? '').length} characters); `
          + `only its first ${BODY_WINDOW_MAX_CHARS} are shown. Open the raw file ${reportPath(report)} for the rest.`,
        )
      } else if (end < total) {
        const next = end + 1
        const bodyStart = await bodyStartLine(report)
        const raw = bodyStart === undefined ? '' : ` (raw file line ${bodyStart + next - 1})`
        section.push('', `… ${total - end} body line(s) follow; continue with report_read offset=${next}${raw} …`)
      }
      return section
    }

    if (body.length <= BODY_INLINE_LIMIT) return ['## body', body]

    const excerpt = excerptBody(lines, body.length)
    const section: string[] = []
    const outline = outlineOf(lines)
    if (outline.length > 0) section.push(...renderOutline(outline), '')
    section.push(
      `## body (head and tail of ${total} body lines)`,
      excerpt.head,
      '',
      elisionMarker(excerpt),
      '',
      excerpt.tail,
    )
    const bodyStart = await bodyStartLine(report)
    // A concrete first line is more useful than a placeholder: the reader of an
    // excerpt usually wants the omitted middle next, and that is the line where
    // the head stopped (inside it, when the head was clipped mid-line).
    const middleStart = excerpt.headClipped ? excerpt.headEndLine : excerpt.headEndLine + 1
    section.push(
      '',
      `Window the body with report_read offset=${middleStart} (limit in lines, default ${BODY_WINDOW_DEFAULT_LINES});`
      + ' the omitted middle starts there, and the outline above numbers every section.'
      + (bodyStart === undefined ? '' : ` In the raw file, body line 1 is document line ${bodyStart}.`),
    )
    return section
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
    return matching.slice(0, limit).map(toDigestRow)
  }

  /**
   * List one thread: the root of the line a report belongs to, plus every
   * descendant, as digests.
   *
   * The ledger's tree is written from both ends — a report records `parent`, its
   * parent records `children` — so the index is built from both directions. A
   * hand edit that leaves the two sides disagreeing then still yields a complete
   * tree instead of half of one, and a cycle makes the walk stop rather than
   * hang. The walk goes up to the root first: a caller usually reaches a thread
   * from one of its middle reports (an id in context, a task label), and a
   * listing that started there would show a fragment.
   * @param report - a report anywhere in the line.
   * @returns the tree, or `undefined` when the report is not in the ledger.
   */
  async thread(report: string): Promise<ThreadListing | undefined> {
    const all = await listReports()
    const byId = new Map(all.map((front) => [front.report, front]))
    if (!byId.has(report)) return undefined

    const childrenOf = new Map<string, string[]>()
    const addChild = (parent: string, child: string): void => {
      const children = childrenOf.get(parent) ?? []
      if (!children.includes(child)) children.push(child)
      childrenOf.set(parent, children)
    }
    // The `children` array keeps the author's order; a child that only names its
    // own parent is appended where that parent is, rather than dropped.
    for (const front of all) for (const child of front.children) addChild(front.report, child)
    for (const front of all) {
      if (front.parent !== undefined && byId.has(front.parent)) addChild(front.parent, front.report)
    }

    let root = report
    const seen = new Set<string>([root])
    let note: string | undefined
    for (;;) {
      const parent = byId.get(root)?.parent
      if (parent === undefined) break
      // A parent that is gone is a hole in the line, not a reason to pretend the
      // requested report is a root: say so instead of silently shortening it.
      if (!byId.has(parent)) {
        note ??= `parent ${parent} is not in the ledger`
        break
      }
      if (seen.has(parent)) break
      seen.add(parent)
      root = parent
    }

    const rows: ThreadRow[] = []
    const visited = new Set<string>()
    const stack: { id: string; depth: number }[] = [{ id: root, depth: 0 }]
    while (stack.length > 0 && rows.length < THREAD_MAX_ROWS) {
      const { id, depth } = stack.pop() as { id: string; depth: number }
      if (visited.has(id)) {
        note ??= `a parent/children cycle was cut at ${id}`
        continue
      }
      const front = byId.get(id)
      if (front === undefined) {
        // Symmetric with a missing parent: a `children` entry whose document was
        // deleted by hand still names work that is not in the ledger.
        note ??= `listed child ${id} is missing from the ledger`
        continue
      }
      visited.add(id)
      rows.push({ depth, row: toDigestRow(front), anchor: id === report })
      if (depth >= THREAD_MAX_DEPTH) {
        note ??= `nesting deeper than ${THREAD_MAX_DEPTH} was not followed`
        continue
      }
      const children = childrenOf.get(id) ?? []
      // Pushed in reverse so the stack pops them in the order the author sees.
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ id: children[index] as string, depth: depth + 1 })
      }
    }
    if (rows.length >= THREAD_MAX_ROWS && stack.length > 0) {
      note = `listing stopped after ${THREAD_MAX_ROWS} reports`
    }
    return { root, rows, ...(note === undefined ? {} : { note }) }
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
      const hops = await readHops(report)
      // A conclusion has to say what it concludes. The ledger cannot tell who was
      // handed the work, so it cannot demand an account from every close — but it
      // can refuse the one shape that hides the most: nothing was ever written into
      // the report, and the close says nothing either. That pair is exactly the
      // "clean close with zero contributions" that a reader of the path later
      // finds unauditable, and one sentence is a low price for a readable ending.
      // Deliberately checked before any checkout side effect, so a refusal never
      // leaves a lease released or a working tree removed.
      if (!hops.some((hop) => hop.action === 'contributed') && (note ?? '').trim() === '') {
        throw new Error(
          `report-ledger: ${report} has no contribution and this close carries no note, so the ending would record `
          + 'nothing. Say what was done and how it was verified, or why nothing was written '
          + '(e.g. "nothing was done: superseded by R-0007").',
        )
      }
      const binding = current.front.worktree
      // The lease is released AFTER the directory decision, never before it.
      // Releasing first opened a window in which a concurrent `report_lease`
      // could claim the checkout — the report was still open and its last lease
      // hop said `released`, so the referee granted — and the removal below then
      // deleted the checkout the other report had just adopted. While this report
      // is still `held`, the referee refuses that claim; once the directory is
      // gone, a claimant gets `not-a-worktree`. The release hop is recorded
      // below, after the removal, and `reclaimed` stays the final lease state.
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
              // `git status` calls a tree with only ignored files clean, and git
              // then deletes those files on removal. Count them first so the
              // close can say what it removed; the removal itself is unchanged.
              const ignored = await ignoredPathCount(binding.path) ?? 0
              const removed = await removeWorktree(repo, binding.path)
              outcome = removed.ok
                ? {
                    action: 'removed',
                    ...(ignored === 0 ? {} : {
                      warning: `removed ${ignored} ignored path(s); git status does not count ignored files as uncommitted, but the removal deletes them`,
                    }),
                  }
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
      // End the claim only now that the directory decision above is final. If the
      // removal succeeded, the report was still `held` throughout it, so a
      // concurrent lease could not adopt the checkout and then lose it. The
      // `reclaimed` hop is recorded first and `leaseState` treats it as terminal,
      // so this release cannot hide the fact that the checkout was removed.
      if (binding !== undefined && leaseState(hops) === 'held') {
        await this.#record(report, {
          at: Date.now(),
          actor,
          action: 'released',
          to: [],
          note: 'released by closing the report',
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
          const header = `\n\n---\n\n### amendment by ${name ?? actor} at ${formatTime(Date.now())}\n\n`
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
   * Rebuild digests' derived fields from their hop streams.
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
   * reason: rebuilding from an empty history would erase its recipients. A dry
   * run reports the same skip, so a read-only check can tell "stale but
   * repairable" from "damaged".
   * @param options - `dryRun` reports what would change without writing;
   * `report` limits the pass to one report (an unknown id answers nothing).
   * @returns one record per report in scope.
   */
  async repairDigests(options: { dryRun?: boolean; report?: string } = {}): Promise<DigestRepair[]> {
    const repairs: DigestRepair[] = []
    const targets: ReportFrontMatter[] = []
    if (options.report === undefined) {
      // Enumerated from the directory rather than from listReports: the listing is
      // deliberately silent about a record it cannot parse, and a diagnostic whose
      // whole job is naming damage must not inherit that silence.
      for (const id of await listReportIds()) {
        let digest: ReportFrontMatter | undefined
        try {
          digest = await readDigestOf(id)
        } catch (error) {
          repairs.push({
            report: id, changed: false, stored: '', derived: '',
            skipped: `the document could not be read: ${error instanceof Error ? error.message : String(error)}`,
          })
          continue
        }
        if (digest === undefined) {
          repairs.push({
            report: id, changed: false, stored: '', derived: '',
            skipped: 'the document exists but its digest could not be parsed',
          })
          continue
        }
        targets.push({ ...digest, report: id })
      }
    } else {
      // The id is the file name, exactly as in listReports: a hand-edited
      // identity field must not redirect the repair at another report.
      let digest: ReportFrontMatter | undefined
      try {
        digest = await readDigestOf(options.report)
      } catch (error) {
        return [{
          report: options.report, changed: false, stored: '', derived: '',
          skipped: `the document could not be read: ${error instanceof Error ? error.message : String(error)}`,
        }]
      }
      if (digest === undefined) {
        if (existsSync(reportPath(options.report))) {
          return [{
            report: options.report, changed: false, stored: '', derived: '',
            skipped: 'the document exists but its digest could not be parsed',
          }]
        }
        return repairs
      }
      targets.push({ ...digest, report: options.report })
    }
    for (const digest of targets) {
      const report = digest.report
      const stored = digestProjection(digest)
      let hops: RouteHop[]
      try {
        hops = await readHops(report)
      } catch (error) {
        repairs.push({
          report, changed: false, stored, derived: '',
          skipped: `its transfer path could not be read: ${error instanceof Error ? error.message : String(error)}`,
        })
        continue
      }
      const derived = digestProjection(projectRoute(hops))
      if (stored === derived) {
        repairs.push({ report, changed: false, stored, derived })
        continue
      }
      // Checked for the dry run too: "stale but repairable" and "damaged" are
      // different answers, and a read-only check that hid the difference would
      // send a reader to a repair that must refuse.
      const unrepairable = digest.hops > 0
        ? (!existsSync(routePath(report)) ? MISSING_PATH : hops.length === 0 ? EMPTY_PATH : undefined)
        : undefined
      if (options.dryRun === true) {
        repairs.push({ report, changed: true, stored, derived, ...(unrepairable === undefined ? {} : { skipped: unrepairable }) })
        continue
      }
      const skipped = await this.#withLock(report, async () => {
        const current = await readReport(report)
        if (current === undefined) return 'it disappeared while the sweep was running'
        const damage = await this.#routeDamage(report, current.front)
        if (damage !== undefined) return damage
        const fresh = projectRoute(await readHops(report))
        // Re-checked inside the lock: a mutation that ran during the scan has
        // already corrected this digest, and rewriting would be a no-op that the
        // report would count as changed.
        if (digestProjection(fresh) === digestProjection(current.front)) return undefined
        await writeReport({ front: { ...current.front, ...fresh }, body: current.body }, report)
        return undefined
      })
      repairs.push({ report, changed: true, stored, derived, ...(skipped === undefined ? {} : { skipped }) })
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

/**
 * Project one digest to a listing row.
 *
 * Shared by the flat listing and the thread listing so the two can never drift:
 * a field added to one and forgotten in the other would make the same report
 * read differently depending on how it was looked at.
 * @param front - the digest.
 * @returns the row.
 */
function toDigestRow(front: ReportFrontMatter): DigestRow {
  return {
    report: front.report,
    status: front.status,
    subject: front.subject,
    from: front.from,
    to: front.to,
    cc: front.cc,
    authors: front.authors,
    hops: front.hops,
    reads: front.reads,
    ...(front.task === undefined ? {} : { task: front.task }),
    ...(front.worktree === undefined ? {} : { worktree: worktreeLabel(front.worktree) }),
    ...(front.last === undefined ? {} : { last: `${front.last.action}@${front.last.actor}` }),
    updated: front.updated,
  }
}

/** Render one digest row for model-facing listing output. */
export function renderRow(row: DigestRow): string {
  const last = row.last === undefined ? '-' : row.last
  // The task label is rendered inline rather than omitted: it is the grouping a
  // reader scans for, and a listing that hides it forces a second call per report.
  const task = row.task === undefined ? '' : ` task=${row.task}`
  const worktree = row.worktree === undefined ? '' : ` wt=${row.worktree}`
  // The co-author count is rendered for the same reason the transfer path shows
  // who wrote what: `acked` says a recipient confirmed receipt, and a row that
  // shows one author next to three recipients says nobody actually wrote anything —
  // the difference a receipt cannot express and a reader has to be able to see
  // without opening the body.
  return `${row.report} [${row.status}] ${row.subject}${task}${worktree} | from=${row.from} to=${row.to.length === 0 ? '-' : row.to.join(',')} cc=${row.cc.length === 0 ? '-' : row.cc.join(',')} authors=${row.authors.length} hops=${row.hops} reads=${row.reads} last=${last}`
}

/**
 * Render one thread row: a digest indented by its depth, plus whether it is the
 * report the caller asked about.
 *
 * Deliberately shorter than {@link renderRow}: a thread answers "is this line
 * finished, who holds which part, what happened last", and every field outside
 * that is paid once per row. The flat listing stays the place for the full row.
 * @param entry - the thread row.
 * @returns the rendered line.
 */
export function renderThreadRow(entry: ThreadRow): string {
  const last = entry.row.last === undefined ? '-' : entry.row.last
  const task = entry.row.task === undefined ? '' : ` task=${entry.row.task}`
  const anchor = entry.anchor ? '  <- requested' : ''
  return `${'  '.repeat(entry.depth)}${entry.row.report} [${entry.row.status}] ${entry.row.subject}${task}`
    + ` | from=${entry.row.from} hops=${entry.row.hops} last=${last}${anchor}`
}
