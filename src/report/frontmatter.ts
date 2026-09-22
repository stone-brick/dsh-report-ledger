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
import type { HopAction, Report, ReportFrontMatter, ReportStatus } from './types.ts'

/** The front-matter fence. */
const FENCE = '---'

const STATUSES: readonly ReportStatus[] = ['open', 'acked', 'closed']

const ACTIONS: readonly HopAction[] = [
  'authored',
  'contributed',
  'sent',
  'delivered',
  'cc',
  'forwarded',
  'copied',
  'read',
  'acked',
  'closed',
  'reopened',
]

/** A parsed document. */
export interface ParsedDocument {
  /** The normalized front matter. */
  readonly front: ReportFrontMatter
  /** Everything after the closing fence. */
  readonly body: string
}

/**
 * Split a document into its YAML front matter and body.
 *
 * The opening fence must be the very first line (a BOM and a trailing `\r` are
 * tolerated). Importing the fence from an indented position is not accepted, so
 * a body that happens to start with a horizontal rule is never mistaken for
 * metadata.
 * @param raw - the file text.
 * @returns the parsed mapping and body, or `undefined` when there is no front matter.
 */
export function splitFrontMatter(raw: string): { data: Record<string, unknown>; body: string } | undefined {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const lines = text.split('\n')
  const first = lines[0]?.replace(/\r$/, '')
  if (first !== FENCE) return undefined
  let close = -1
  for (let index = 1; index < lines.length; index++) {
    if (lines[index]?.replace(/\r$/, '') === FENCE) {
      close = index
      break
    }
  }
  if (close < 0) return undefined
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
  return { data: parsed as Record<string, unknown>, body: lines.slice(close + 1).join('\n').replace(/^\n/, '') }
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
  const status = STATUSES.find((candidate) => candidate === statusText) ?? 'open'

  const created = time(data.created, 0)
  const updated = time(data.updated, created)

  const lastRaw = data.last
  let last: ReportFrontMatter['last']
  if (lastRaw !== null && typeof lastRaw === 'object' && !Array.isArray(lastRaw)) {
    const record = lastRaw as Record<string, unknown>
    const actionText = str(record.action)
    const action = ACTIONS.find((candidate) => candidate === actionText)
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
  return { front, body: split.body }
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
  const action = ACTIONS.find((candidate) => candidate === actionText)
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
