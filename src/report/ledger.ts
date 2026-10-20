/**
 * The durable ledger.
 *
 * Layout under the ledger root (`$DSH_HOME/report-ledger`):
 *
 * ```
 * reports/R-0001.md          front matter (the digest) + body
 * reports/R-0001.route.jsonl append-only transfer path, one hop per line
 * ```
 *
 * Two deliberate choices:
 *
 *  - **Files, not a private database.** The ledger is the long-horizon memory of
 *    a collaboration, so it stays inspectable and hand-editable: a human can fix
 *    a subject line or annotate a hop without a migration. Front matter makes the
 *    digest readable without opening a body.
 *  - **The digest is the index.** Listing never parses bodies, so a digest scan
 *    stays cheap no matter how large the reports themselves grow.
 *
 * The route sidecar is append-only and separate from the report file: the audit
 * trail must be able to grow without rewriting the document, and a torn write in
 * one must not corrupt the other.
 *
 * @module dsh-report-ledger/report/ledger
 */

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseHop, parseReport, serializeReport, splitFrontMatter } from './frontmatter.ts'
import type { Report, ReportFrontMatter, RouteHop } from './types.ts'

/** Directory name under the DSH home that holds the whole ledger. */
const LEDGER_DIR = 'report-ledger'

/**
 * Explicit override of the ledger root.
 *
 * Two legitimate uses: relocating the ledger on a deployment that keeps state
 * somewhere other than the DSH home, and pointing a test or a second profile at
 * a throwaway root so a test run cannot touch the real ledger.
 */
const ROOT_OVERRIDE = 'DSH_REPORT_LEDGER_ROOT'

/** Report id shape: `R-` and at least four digits. */
const REPORT_ID = /^R-(\d{4,})$/

/** Report file name shape. */
const REPORT_FILE = /^R-(\d{4,})\.md$/

/**
 * Resolve the DSH home directory.
 *
 * Read from the environment rather than imported from a harness package: this
 * module must stay usable from any host context, and `DSH_HOME` is the same
 * value the harness itself uses to place its own state.
 * @returns the absolute DSH home path.
 */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** Absolute path of the ledger root. */
export function ledgerRoot(): string {
  const override = process.env[ROOT_OVERRIDE]
  if (typeof override === 'string' && override.trim() !== '') return override
  return join(dshHome(), LEDGER_DIR)
}

/** Absolute path of the directory holding report documents. */
export function reportsDir(): string {
  return join(ledgerRoot(), 'reports')
}

/**
 * Absolute path of one report document.
 * @param id - report identifier.
 * @returns the path.
 */
export function reportPath(id: string): string {
  return join(reportsDir(), `${id}.md`)
}

/**
 * Absolute path of one report's transfer-path sidecar.
 * @param id - report identifier.
 * @returns the path.
 */
export function routePath(id: string): string {
  return join(reportsDir(), `${id}.route.jsonl`)
}

/**
 * Whether a string is a well-formed report identifier.
 * @param id - candidate identifier.
 * @returns true when it matches the ledger's id shape.
 */
export function isValidReportId(id: string): boolean {
  return REPORT_ID.test(id)
}

/** Create the ledger directories if they do not exist yet. */
async function ensureDirs(): Promise<void> {
  await mkdir(reportsDir(), { recursive: true })
}

/**
 * Claim the next report identifier.
 *
 * The counter is derived from the directory rather than kept in a separate
 * state file, so the ledger cannot drift out of sync with its own contents. The
 * claim is an exclusive create, which makes a concurrent claim lose cleanly and
 * retry on the next number instead of two reports sharing an id.
 * @returns the claimed identifier.
 */
export async function allocateId(): Promise<string> {
  await ensureDirs()
  let highest = 0
  for (const name of await readdir(reportsDir())) {
    const match = REPORT_FILE.exec(name)
    if (match === null) continue
    const value = Number(match[1])
    if (Number.isFinite(value) && value > highest) highest = value
  }
  for (let attempt = 0; attempt < 64; attempt++) {
    const candidate = `R-${String(highest + 1 + attempt).padStart(4, '0')}`
    const path = reportPath(candidate)
    try {
      // Claim the name without clobbering: a loss here means someone else won.
      await writeFile(path, '', { flag: 'wx' })
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('report-ledger: could not allocate a report id after 64 attempts')
}

/**
 * File-operation codes that mean "someone else has the target open right now".
 *
 * Windows reports a rename over a file another handle holds (an editor, a
 * virus scanner, a concurrent writer) as `EPERM`/`EBUSY`/`EACCES` rather than
 * retrying it itself, and the momentary hold is almost always gone a few
 * milliseconds later. Retrying a couple of times turns a spurious tool failure
 * into a normal write; the final error is still thrown.
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * Rename, retrying briefly on a transient Windows sharing violation.
 * @param from - the temp file.
 * @param to - the report document.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 2 || code === undefined || !TRANSIENT_RENAME_CODES.has(code)) throw error
      await new Promise((resolve) => setTimeout(resolve, 10 + attempt * 10))
    }
  }
}

/**
 * Write one report atomically.
 *
 * The temp-file-plus-rename form keeps a reader from ever observing a half
 * written document, which matters because the ledger is read by other sessions
 * and by the timeline UI while a turn is still running. A failed rename leaves
 * no litter: the temp file is removed in a `finally`.
 *
 * The destination is `id`, not `report.front.report`. The digest's own identity
 * field is data a human can edit, and a write path that trusted it let a copied
 * or hand-edited file redirect the next mutation into another report's document
 * — or, with `../`, outside the ledger entirely. The file name is the identity;
 * the field is normalized from it on every write.
 * @param report - the report to persist.
 * @param id - the report id that owns the destination; defaults to the digest's own.
 * @throws when `id` is not a usable report id.
 */
export async function writeReport(report: Report, id: string = report.front.report): Promise<void> {
  if (!isValidReportId(id)) throw new Error(`report-ledger: ${JSON.stringify(id)} is not a usable report id`)
  await ensureDirs()
  const target = reportPath(id)
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`
  const front: ReportFrontMatter = report.front.report === id ? report.front : { ...report.front, report: id }
  try {
    await writeFile(temp, serializeReport({ front, body: report.body }), 'utf8')
    await renameWithRetry(temp, target)
  } finally {
    // Best effort: after a successful rename the temp is already gone, and after
    // a failed write or rename it must not stay behind as an invisible `.tmp`.
    await unlink(temp).catch(() => undefined)
  }
}

/**
 * Read one report.
 * @param id - report identifier.
 * @returns the report, or `undefined` when it does not exist or is unreadable.
 */
export async function readReport(id: string): Promise<Report | undefined> {
  if (!isValidReportId(id)) return undefined
  try {
    const raw = await readFile(reportPath(id), 'utf8')
    const parsed = parseReport(raw)
    if (parsed === undefined) return undefined
    return { front: parsed.front, body: parsed.body }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * The 1-based document line at which a report's body begins.
 *
 * Read on demand by the one caller that has to point a model at the rest of an
 * oversized body: a character budget cannot be turned into a line offset without
 * knowing how many lines the front matter occupies, and guessing either wastes
 * a read or skips body text.
 * @param id - report identifier.
 * @returns the line, or `undefined` when the document is missing or malformed.
 */
export async function bodyStartLine(id: string): Promise<number | undefined> {
  if (!isValidReportId(id)) return undefined
  let raw: string
  try {
    raw = await readFile(reportPath(id), 'utf8')
  } catch {
    return undefined
  }
  return splitFrontMatter(raw)?.bodyLine
}

/**
 * Append one hop to a report's transfer path.
 *
 * Append-only by construction: the audit trail is never rewritten, so a
 * concurrent reader sees a prefix of hops rather than a torn file.
 * @param id - report identifier.
 * @param hop - the hop to record.
 */
export async function appendHop(id: string, hop: RouteHop): Promise<void> {
  if (!isValidReportId(id)) throw new Error(`report-ledger: invalid report id ${JSON.stringify(id)}`)
  await ensureDirs()
  await appendFile(routePath(id), `${JSON.stringify(hop)}\n`, 'utf8')
}

/**
 * Read the complete transfer path of a report.
 * @param id - report identifier.
 * @returns every readable hop, oldest first.
 */
export async function readHops(id: string): Promise<RouteHop[]> {
  if (!isValidReportId(id)) return []
  let raw: string
  try {
    raw = await readFile(routePath(id), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const hops: RouteHop[] = []
  for (const line of raw.split('\n')) {
    const hop = parseHop(line)
    if (hop !== undefined) hops.push(hop)
  }
  return hops
}

/** Read only the digest of one report document. */
async function readDigest(id: string): Promise<ReportFrontMatter | undefined> {
  const report = await readReport(id)
  return report?.front
}

/**
 * List every report digest, newest first.
 *
 * Only front matter is parsed, so this stays cheap regardless of body sizes —
 * the property that lets a timeline or an index scan the whole ledger.
 *
 * A single unreadable entry is skipped rather than allowed to take the index
 * down: a directory where a file is expected, a sharing violation, a permissions
 * problem — any of them used to make the whole listing (and therefore the tools,
 * the timeline, and the deferred-delivery pump, which all list first) fail. One
 * record the ledger cannot read is a record to look at; it is not a reason to
 * stop showing the others. Parse-level damage is already skipped a layer down.
 * @returns every readable digest.
 */
export async function listReports(): Promise<ReportFrontMatter[]> {
  await ensureDirs()
  const digests: ReportFrontMatter[] = []
  for (const name of await readdir(reportsDir())) {
    const match = REPORT_FILE.exec(name)
    if (match === null) continue
    const id = `R-${match[1]}`
    try {
      const digest = await readDigest(id)
      // The file name is the identity; the digest's own `report` field is a
      // normalized cache of it. Reporting the field verbatim would let one file
      // masquerade as another record in a listing, and would misdirect the
      // delivery pump, which keys each holding by `digest.report`.
      if (digest !== undefined) digests.push({ ...digest, report: id })
    } catch {
      // Deliberately silent: the listing has no diagnostic channel, and throwing
      // here would hide every healthy report behind one broken one.
    }
  }
  digests.sort((left, right) => right.updated - left.updated || right.report.localeCompare(left.report))
  return digests
}

/**
 * Whether a report document exists on disk.
 * @param id - report identifier.
 * @returns true when the document exists.
 */
export function reportExists(id: string): boolean {
  return isValidReportId(id) && existsSync(reportPath(id))
}

/**
 * Give back an id that was claimed but never became a report.
 *
 * {@link allocateId} claims a name by creating an empty document, which is what
 * makes a concurrent claim lose cleanly. When the work that needed the id then
 * fails — a working tree that could not be created, a peer that never started —
 * the claim would otherwise leave an empty file behind forever, burning the
 * number and showing up in no listing.
 *
 * Only an **empty** document is removed. A report with any content is kept, so a
 * misuse of this function can cost at most a placeholder, never a record.
 * @param id - the claimed identifier.
 * @returns true when an empty claim was removed.
 */
export async function discardUnwrittenId(id: string): Promise<boolean> {
  if (!isValidReportId(id)) return false
  const path = reportPath(id)
  try {
    const raw = await readFile(path, 'utf8')
    if (raw !== '') return false
  } catch {
    return false
  }
  try {
    await unlink(path)
    return true
  } catch {
    return false
  }
}
