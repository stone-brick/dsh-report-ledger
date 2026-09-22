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
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseHop, parseReport, serializeReport } from './frontmatter.ts'
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
 * Write one report atomically.
 *
 * The temp-file-plus-rename form keeps a reader from ever observing a half
 * written document, which matters because the ledger is read by other sessions
 * and by the timeline UI while a turn is still running.
 * @param report - the report to persist.
 */
export async function writeReport(report: Report): Promise<void> {
  await ensureDirs()
  const target = reportPath(report.front.report)
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temp, serializeReport(report), 'utf8')
  await rename(temp, target)
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
 * @returns every readable digest.
 */
export async function listReports(): Promise<ReportFrontMatter[]> {
  await ensureDirs()
  const digests: ReportFrontMatter[] = []
  for (const name of await readdir(reportsDir())) {
    const match = REPORT_FILE.exec(name)
    if (match === null) continue
    const digest = await readDigest(`R-${match[1]}`)
    if (digest !== undefined) digests.push(digest)
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
