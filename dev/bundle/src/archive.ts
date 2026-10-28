/**
 * The developer-mode archive: what survives a checkout.
 *
 * A fork inherits the roster and the prompts, but not the ledger — that lives on
 * the machine that ran the development. So the part of the history worth carrying
 * has to be exported into the repository, and the shape of that export is decided
 * by one question: what does a developer who was not there need?
 *
 * Not the process. A raw report is a transcript of a conversation whose other
 * participants are gone: replaying it costs context and answers nothing. What
 * survives here is the **conclusions** — the sections that state a finding, a
 * decision, a risk, or a rejected idea — plus the outline of everything else, so a
 * reader knows what was dropped and can go looking for it in the ledger if that
 * ledger is still reachable.
 *
 * Two rules keep this from becoming a second, worse ledger:
 *
 *  - **It is generated, never edited.** The index is rebuilt from the archive
 *    files, and a test pins the two together. A hand-maintained index would drift
 *    from the files it claims to describe, which is the one failure an index
 *    cannot have.
 *  - **It has a budget.** Every archive file and the injected index block are
 *    capped, and the caps are asserted. Nothing loads this content except the
 *    developer-mode prompt section, so an unbounded archive would quietly tax
 *    every development turn.
 *
 * @module dsh-report-ledger/report/dev/archive
 */

import { parse as parseYaml } from 'yaml'
import type { ReportFrontMatter } from '../../../src/report/types.ts'

/** One report as the archive reads it. */
export interface ArchiveSource {
  /** The report digest. */
  readonly front: ReportFrontMatter
  /** The full body, as stored in the ledger. */
  readonly body: string
}

/** One archived topic, as both the index and the prompt block describe it. */
export interface ArchiveTopic {
  /** Stable slug; also the file's base name. */
  readonly topic: string
  /** The file inside `dev/archive/`. */
  readonly file: string
  /** One line a reader can decide on without opening the file. */
  readonly summary: string
  /** The reports this topic distilled, in the order they were archived. */
  readonly reports: readonly string[]
  /** Latest source timestamp, epoch ms. */
  readonly updated: number
}

/** Index document as written to `dev/archive/index.yml`. */
export interface ArchiveIndex {
  /** When the index was last rebuilt, ISO 8601. */
  readonly generated?: string
  /** Topics, sorted by slug. */
  readonly topics: readonly ArchiveTopic[]
}

/** Hard ceiling for one archive file's text. */
export const MAX_ARCHIVE_BYTES = 16 * 1024

/** Hard ceiling for the index block injected into a development prompt. */
export const MAX_INDEX_LINES = 40

/**
 * Headings whose sections are kept in full.
 *
 * Deliberately a vocabulary rather than a position rule ("keep the last
 * section"): the same thread puts its conclusions in different places across
 * rounds, and a positional rule would keep the wrong half of a long report.
 */
const CONCLUSION_HEADING = /(结论|决定|建议|风险|未决|未修|驳回|后续|待办|问题|缺口|发现|摘要|conclusion|decision|finding|risk|summary|open question)/i

/** One heading-delimited section of a report body. */
interface Section {
  /** The heading line, or `undefined` for text before the first heading. */
  readonly heading?: string
  /** The section's text, heading included. */
  readonly text: string
}

/**
 * Turn one body into heading-delimited sections.
 *
 * `### contribution by …` markers are part of the body's own structure, so they
 * become sections like any heading — which is what keeps several rounds of one
 * thread readable in the archive rather than merged into one wall.
 * @param body - the report body.
 * @returns the sections, in document order.
 */
export function sectionsOf(body: string): Section[] {
  const sections: Section[] = []
  let heading: string | undefined
  let buffer: string[] = []
  const flush = (): void => {
    const text = buffer.join('\n').trim()
    if (text !== '' || heading !== undefined) sections.push({ ...(heading === undefined ? {} : { heading }), text })
    buffer = []
  }
  for (const line of body.split('\n')) {
    if (/^#{1,3} /.test(line)) {
      flush()
      heading = line.replace(/^#+\s+/, '').trim()
      buffer.push(line)
      continue
    }
    buffer.push(line)
  }
  flush()
  return sections
}

/** Whether a section is one of the ones kept in full. */
function isConclusion(section: Section): boolean {
  return section.heading !== undefined && CONCLUSION_HEADING.test(section.heading)
}

/** Format an epoch millisecond value as a UTC date-time, for a stable archive. */
function iso(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * A file-safe topic slug.
 *
 * Used for the file name, so it must be stable and boring: lowercase ASCII,
 * digits and single dashes. A Chinese topic label collapses to nothing, which is
 * why the caller falls back to `archive` rather than getting an empty name.
 * @param input - the requested topic.
 * @returns a slug, never empty.
 */
export function topicSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
  return slug === '' ? 'archive' : slug.slice(0, 60)
}

/**
 * Render one topic's archive file.
 *
 * The file states what it is, lists the outline of every section, then keeps the
 * conclusion sections in full. Omitted sections are named rather than silently
 * dropped — a distillation that hides its own omissions reads as complete, which
 * is worse than no distillation at all.
 * @param topic - the topic metadata.
 * @param sources - the reports being distilled, in archive order.
 * @returns the file text, capped at {@link MAX_ARCHIVE_BYTES}.
 */
export function renderArchive(topic: ArchiveTopic, sources: readonly ArchiveSource[]): string {
  const parts: string[] = [
    `# ${topic.topic}`,
    '',
    `<!-- generated by dev_archive — do not hand-edit; rebuild it from the ledger -->`,
    '',
    `- topic: ${topic.topic}`,
    `- summary: ${topic.summary}`,
    `- reports: ${topic.reports.length === 0 ? '(none)' : topic.reports.join(', ')}`,
    `- source updated: ${iso(topic.updated)}`,
    '- note: this is a distillation. It keeps the conclusion sections and lists every',
    '  heading, so a reader can see what was left out; the ledger holds the rest if it',
    '  is still reachable.',
    '',
    '## outline',
    '',
  ]

  for (const source of sources) {
    const sections = sectionsOf(source.body)
    parts.push(`### ${source.front.report} — ${source.front.subject}`)
    for (const section of sections) {
      if (section.heading === undefined) continue
      parts.push(`- ${section.heading}`)
    }
    parts.push('')
  }

  for (const source of sources) {
    const sections = sectionsOf(source.body)
    const kept = sections.filter(isConclusion)
    const omitted = sections.filter((section) => section.heading !== undefined && !isConclusion(section))
    parts.push(
      `## ${source.front.report} — ${source.front.subject}`,
      '',
      `- status: ${source.front.status} · task: ${source.front.task ?? '(none)'} · hops: ${source.front.hops} · updated: ${iso(source.front.updated)}`,
      '',
    )
    if (kept.length === 0) {
      parts.push('(no conclusion section was recognised; read the outline above)', '')
    }
    for (const section of kept) {
      parts.push(section.text, '')
    }
    if (omitted.length > 0) {
      // One heading per line. The old single line was the last line of the
      // section and vanished whole when the byte budget cut before it; line-per-
      // heading keeps at least the beginning of the list visible.
      parts.push(
        `omitted sections (${omitted.length}):`,
        ...omitted.map((section) => `- ${section.heading}`),
        '',
      )
    }
  }

  const text = parts.join('\n')
  if (Buffer.byteLength(text, 'utf8') <= MAX_ARCHIVE_BYTES) return text
  // Truncation keeps the head — title, metadata, outline — and cuts the bodies.
  // The marker is the important half: a silently short archive reads as complete.
  const marker = `\n\n… truncated at the ${MAX_ARCHIVE_BYTES}-byte budget; the rest is in the ledger, if it still exists\n`
  const limit = MAX_ARCHIVE_BYTES - Buffer.byteLength(marker, 'utf8')
  const cut = Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8')
  return `${cut.slice(0, cut.lastIndexOf('\n') > 0 ? cut.lastIndexOf('\n') : cut.length)}${marker}`
}

/** Render the index document. */
export function renderIndex(topics: readonly ArchiveTopic[], generatedAt: number): string {
  const lines = [
    '# generated by dev_archive — do not hand-edit; rebuild it from the archive files',
    `generated: ${new Date(generatedAt).toISOString()}`,
    'topics:',
  ]
  if (topics.length === 0) lines.push('  []')
  for (const topic of topics) {
    lines.push(`  - topic: ${JSON.stringify(topic.topic)}`)
    lines.push(`    file: ${JSON.stringify(topic.file)}`)
    lines.push(`    summary: ${JSON.stringify(topic.summary)}`)
    lines.push(`    reports: [${topic.reports.map((report) => JSON.stringify(report)).join(', ')}]`)
    lines.push(`    updated: ${new Date(topic.updated).toISOString()}`)
  }
  return lines.join('\n')
}

/**
 * Read an index document back.
 *
 * Tolerant on purpose: the injected block is a convenience, and a malformed or
 * hand-edited index must cost a development agent an empty history line, never a
 * failed assembly.
 * @param text - the file contents.
 * @returns the parsed index; `topics` is empty when anything is unusable.
 */
export function parseIndex(text: string): ArchiveIndex {
  let document: unknown
  try {
    document = parseYaml(text)
  } catch {
    return { topics: [] }
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return { topics: [] }
  const record = document as Record<string, unknown>
  const generated = typeof record.generated === 'string' ? record.generated : undefined
  const rows = Array.isArray(record.topics) ? record.topics : []
  const topics: ArchiveTopic[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const entry = row as Record<string, unknown>
    if (typeof entry.topic !== 'string' || typeof entry.file !== 'string') continue
    const summary = typeof entry.summary === 'string' ? entry.summary : ''
    const reports = Array.isArray(entry.reports)
      ? entry.reports.filter((report): report is string => typeof report === 'string')
      : []
    const updated = typeof entry.updated === 'string' ? Date.parse(entry.updated) : Number.NaN
    topics.push({
      topic: entry.topic,
      file: entry.file,
      summary,
      reports,
      updated: Number.isFinite(updated) ? updated : 0,
    })
  }
  return { ...(generated === undefined ? {} : { generated }), topics }
}

/**
 * The block a development agent's prompt carries.
 *
 * Only the index, never the files: the point of the split is that a reader decides
 * from one line whether the detail is worth opening. The block is capped, and the
 * overflow is named so a too-large archive shows up as a line rather than as
 * silently missing history.
 * @param topics - the archived topics.
 * @param maxLines - line budget for the list itself.
 * @returns the section text, or `''` when nothing is archived.
 */
export function renderIndexBlock(topics: readonly ArchiveTopic[], maxLines = MAX_INDEX_LINES): string {
  if (topics.length === 0) return ''
  const ordered = [...topics].sort((left, right) => left.topic.localeCompare(right.topic))
  const shown = ordered.slice(0, maxLines)
  const lines = [
    '## 历史结论（插件自身开发期）',
    '',
    '这些是开发期留下的结论，只在这里注入。细节按需读文件——不要凭记忆猜，也不要把整份归档塞进上下文。',
    '',
    ...shown.map((topic) => `- ${topic.topic} — ${topic.summary} — dev/archive/${topic.file}`),
  ]
  if (ordered.length > shown.length) {
    lines.push(`- …另有 ${ordered.length - shown.length} 条未展开，见 dev/archive/index.yml`)
  }
  return lines.join('\n')
}
