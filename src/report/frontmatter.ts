/**
 * The report file codec: YAML front matter plus a Markdown body.
 *
 * The format deliberately mirrors what this harness already uses for its own
 * documents (skills, package READMEs): an opening `---` line, a flat YAML
 * mapping, a closing `---` line, then free text. The parser below is a
 * reimplementation of the shipped skills parser
 * (`@deepseek-ai/dsh-skill-filesystem`, whose `parseFrontmatter` is module
 * private and not re-exported), tuned for the report schema: it tolerates a
 * hand-edited ledger by normalizing whatever it finds instead of throwing, so a
 * human can correct a report file without breaking the ledger.
 *
 * @module dsh-report-ledger/report/frontmatter
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { HOP_ACTIONS, REPORT_STATUSES } from './types.ts'
import type { Report, ReportFrontMatter, ReportWorktree } from './types.ts'

/** The front-matter fence. */
const FENCE = '---'

/** A parsed document. */
export interface ParsedDocument {
  /** The normalized front matter. */
  readonly front: ReportFrontMatter
  /** Everything after the closing fence. */
  readonly body: string
  /** 1-based line in the document where the body begins. */
  readonly bodyLine: number
}

/**
 * Normalize a document's BOM and line endings before any line-oriented parse.
 *
 * A Windows editor saves CRLF by default, and the YAML parser refuses a document
 * whose last front-matter line is terminated by a lone `\r` — which is exactly
 * what the block looks like once it has been joined back together. Getting this
 * wrong made a hand-edited report invisible rather than merely misformatted.
 * @param raw - the file text.
 * @returns the same text with a leading BOM removed and every CRLF/CR read as a newline.
 */
function normalizeDocument(raw: string): string {
  return (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n?/g, '\n')
}

/**
 * Offset just past a document's closing fence line.
 *
 * The opening fence must be the very first line, so an indented `---` inside a
 * body can never be mistaken for metadata.
 *
 * `atEnd` says whether `text` is the whole document or only a prefix of it, and
 * it decides exactly one case: a fence on the final line with no terminating
 * newline. In a whole document that is a complete (if unusual) block a hand edit
 * may well produce. In a prefix it is indistinguishable from a cut in the middle
 * of a longer line, so a prefix reader must call it unterminated rather than
 * truncate a document at a guess — the caller then falls back to a full read.
 * @param text - a normalized document or prefix of one.
 * @param atEnd - whether `text` is known to be the whole document.
 * @returns the offset, or `undefined` when no complete block is present.
 */
function frontMatterEnd(text: string, atEnd: boolean): number | undefined {
  if (!text.startsWith(`${FENCE}\n`)) return undefined
  let from = FENCE.length + 1
  for (;;) {
    const next = text.indexOf('\n', from)
    if (next < 0) return atEnd && text.slice(from) === FENCE ? text.length : undefined
    if (text.slice(from, next) === FENCE) return next + 1
    from = next + 1
  }
}

/**
 * Whether a document — or a bounded prefix of one — carries a front-matter block.
 *
 * This is what lets the listing read a digest without reading the body: the
 * caller reads a head of the file, asks this question, and parses only when the
 * answer is yes. A prefix whose block is not yet complete is not damage, it is a
 * budget that was too small, and the caller's fallback is a full read.
 * @param raw - the whole document, or a prefix containing at least its front matter.
 * @param complete - whether `raw` is the whole document rather than a prefix.
 * @returns true when a complete front-matter block is present.
 */
export function hasFrontMatter(raw: string, complete: boolean): boolean {
  return frontMatterEnd(normalizeDocument(raw), complete) !== undefined
}

/**
 * Split a document into its YAML front matter and body.
 *
 * A BOM and CRLF line endings are tolerated (see {@link normalizeDocument}).
 * @param raw - the file text.
 * @returns the parsed mapping, the body, and the body's first line, or `undefined` when there is no front matter.
 */
export function splitFrontMatter(raw: string): { data: Record<string, unknown>; body: string; bodyLine: number } | undefined {
  const text = normalizeDocument(raw)
  const end = frontMatterEnd(text, true)
  if (end === undefined) return undefined
  // Drop the empty tail a terminating newline leaves behind, so the closing fence
  // is the last entry whether or not the document ends with a newline.
  const lines = text.slice(0, end).split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const close = lines.length - 1
  const yamlText = lines.slice(1, close).join('\n')
  let parsed: unknown
  try {
    // `uniqueKeys: false` (last value wins) is deliberate. A duplicate key is a
    // plausible outcome of a hand edit — appending a field that already exists —
    // and the strict default would make the whole document unparseable, which
    // here means the report silently disappears from the ledger. Losing a
    // record to a clumsy edit is far worse than resolving an ambiguous key
    // predictably, so the read path is forgiving and the reason is documented.
    parsed = parseYaml(yamlText, { uniqueKeys: false })
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  // Everything past the closing fence. `rest === ''` is a document that ends at
  // the fence itself; splitting it would manufacture a single empty line and count
  // it as a blank lead, which would report a body one line below where it starts.
  const rest = text.slice(end)
  const bodyLines = rest === '' ? [] : rest.split('\n')
  // 1-based line of the first non-blank body line, so an oversized body can be
  // resumed by line. The blank separator that `serializeReport` writes is not
  // part of the body a reader sees, hence the skip.
  let lead = 0
  while (lead < bodyLines.length && (bodyLines[lead] ?? '').trim() === '') lead++
  return {
    data: parsed as Record<string, unknown>,
    body: bodyLines.join('\n').replace(/^\n/, ''),
    bodyLine: close + 2 + lead,
  }
}

/** Read a string field, tolerating numbers and quoteless scalars. */
function str(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/** Read a plain list of strings from a scalar or sequence. */
function strList(value: unknown): string[] {
  if (value === undefined || value === null) return []
  const source = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const item of source) {
    const text = str(item)
    if (text !== undefined && !out.includes(text)) out.push(text)
  }
  return out
}

/** Read a finite number, or `undefined`. */
function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Read a timestamp, defaulting when absent or invalid. */
function time(value: unknown, fallback: number): number {
  const parsed = num(value)
  return parsed === undefined || parsed < 0 ? fallback : parsed
}

/**
 * Read a working-tree binding, tolerating the hand-edited short form.
 *
 * A human who wants to point a report at a checkout should be able to write
 * `worktree: /path/to/tree` and have it mean what it looks like, so a bare
 * scalar is normalized to a path-only binding. A mapping with no usable path is
 * dropped whole rather than half-read: a binding with a branch but no path would
 * claim a branch the ledger cannot locate, which is worse than no binding.
 * @param value - the raw front-matter value.
 * @returns the binding, or `undefined` when there is no usable path.
 */
function toWorktree(value: unknown): ReportWorktree | undefined {
  if (value === undefined || value === null) return undefined
  const record = typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { path: value }
  const path = str(record.path)
  if (path === undefined) return undefined
  const branch = str(record.branch)
  const head = str(record.head)
  const repo = str(record.repo)
  return {
    path,
    ...(branch === undefined ? {} : { branch }),
    ...(head === undefined ? {} : { head }),
    ...(repo === undefined ? {} : { repo }),
    ...(typeof record.allocated === 'boolean' ? { allocated: record.allocated } : {}),
  }
}

/**
 * Normalize a raw front-matter mapping into the report schema.
 *
 * Every field is optional on the way in: a missing recipient list becomes empty,
 * an unknown status becomes `open`, and an unknown hop action in `last` is
 * dropped. Only `report` is required, because it is the file's identity.
 * @param data - the parsed YAML mapping.
 * @returns the normalized front matter, or `undefined` when the identity is missing.
 */
export function toFrontMatter(data: Record<string, unknown>): ReportFrontMatter | undefined {
  const report = str(data.report) ?? str(data.id)
  if (report === undefined) return undefined

  const statusText = str(data.status)
  const status = REPORT_STATUSES.find((candidate) => candidate === statusText) ?? 'open'

  const created = time(data.created, 0)
  const updated = time(data.updated, created)
  const worktree = toWorktree(data.worktree)

  const lastRaw = data.last
  let last: ReportFrontMatter['last']
  if (lastRaw !== null && typeof lastRaw === 'object' && !Array.isArray(lastRaw)) {
    const record = lastRaw as Record<string, unknown>
    const actionText = str(record.action)
    const action = HOP_ACTIONS.find((candidate) => candidate === actionText)
    const actor = str(record.actor)
    if (action !== undefined && actor !== undefined) {
      last = { at: time(record.at, updated), action, actor }
    }
  }

  return {
    report,
    subject: str(data.subject) ?? '(no subject)',
    status,
    from: str(data.from) ?? 'unknown',
    ...(str(data.fromName) === undefined ? {} : { fromName: str(data.fromName) as string }),
    to: strList(data.to),
    cc: strList(data.cc),
    authors: strList(data.authors),
    created,
    updated,
    ...(str(data.parent) === undefined ? {} : { parent: str(data.parent) as string }),
    children: strList(data.children),
    ...(str(data.task) === undefined ? {} : { task: str(data.task) as string }),
    ...(worktree === undefined ? {} : { worktree }),
    artifacts: strList(data.artifacts),
    hops: num(data.hops) ?? 0,
    ...(last === undefined ? {} : { last }),
    ...(str(data.spill) === undefined ? {} : { spill: str(data.spill) as string }),
  }
}

/**
 * Parse one report document.
 * @param raw - the file text.
 * @returns the report, or `undefined` when the document has no usable front matter.
 */
export function parseReport(raw: string): ParsedDocument | undefined {
  const split = splitFrontMatter(raw)
  if (split === undefined) return undefined
  const front = toFrontMatter(split.data)
  if (front === undefined) return undefined
  return { front, body: split.body, bodyLine: split.bodyLine }
}

/**
 * Render the digest as a YAML mapping in a fixed key order.
 *
 * Absent optional fields are omitted rather than written as nulls, so a report
 * file stays readable and cheap to diff.
 * @param front - the normalized front matter.
 * @returns the YAML text (without fences).
 */
export function frontMatterYaml(front: ReportFrontMatter): string {
  const ordered: Record<string, unknown> = {
    report: front.report,
    subject: front.subject,
    status: front.status,
    from: front.from,
  }
  if (front.fromName !== undefined) ordered.fromName = front.fromName
  ordered.to = [...front.to]
  ordered.cc = [...front.cc]
  ordered.authors = [...front.authors]
  ordered.created = front.created
  ordered.updated = front.updated
  if (front.parent !== undefined) ordered.parent = front.parent
  ordered.children = [...front.children]
  if (front.task !== undefined) ordered.task = front.task
  if (front.worktree !== undefined) {
    // Key order mirrors the interface, and absent optionals stay absent, so a
    // binding with only a path stays a one-line mapping a human can read.
    ordered.worktree = {
      path: front.worktree.path,
      ...(front.worktree.branch === undefined ? {} : { branch: front.worktree.branch }),
      ...(front.worktree.head === undefined ? {} : { head: front.worktree.head }),
      ...(front.worktree.repo === undefined ? {} : { repo: front.worktree.repo }),
      ...(front.worktree.allocated === undefined ? {} : { allocated: front.worktree.allocated }),
    }
  }
  ordered.artifacts = [...front.artifacts]
  ordered.hops = front.hops
  if (front.last !== undefined) {
    ordered.last = { at: front.last.at, action: front.last.action, actor: front.last.actor }
  }
  if (front.spill !== undefined) ordered.spill = front.spill
  return stringifyYaml(ordered, { lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' })
}

/**
 * Serialize one report to its on-disk document form.
 * @param report - the report.
 * @returns the complete file text.
 */
export function serializeReport(report: Report): string {
  const body = report.body.endsWith('\n') || report.body === '' ? report.body : `${report.body}\n`
  return `${FENCE}\n${frontMatterYaml(report.front)}${FENCE}\n\n${body}`
}

/**
 * Parse one hop from its JSONL record.
 *
 * Hops are the audit trail, so a malformed line is skipped rather than allowed
 * to poison the rest of the path.
 * @param raw - one line of the route sidecar.
 * @returns the hop, or `undefined` when the record is unusable.
 */
export function parseHop(raw: string): (import('./types.ts').RouteHop) | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const actionText = str(record.action)
  const action = HOP_ACTIONS.find((candidate) => candidate === actionText)
  const actor = str(record.actor)
  if (action === undefined || actor === undefined) return undefined
  const from = str(record.from)
  const note = str(record.note)
  const actorName = str(record.actorName)
  return {
    at: time(record.at, 0),
    actor,
    action,
    to: strList(record.to),
    ...(actorName === undefined ? {} : { actorName }),
    ...(from === undefined ? {} : { from }),
    ...(note === undefined ? {} : { note }),
  }
}
