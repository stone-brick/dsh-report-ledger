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
 *  - **The digest is the index.** Listing reads only a bounded head of each file,
 *    so a digest scan stays cheap no matter how large the reports themselves grow
 *    — see {@link DIGEST_HEAD_BYTES}.
 *
 * Reading is the operation that happens most: every tool call, every browser
 * poll, and every delivery sweep goes through the digest listing, and on Windows
 * one open/read/close costs far more than the bytes it moves. Two rules follow
 * from that, and they are the whole of the read path's design:
 *
 *  - **Never read a body to build a digest.** A listing opens each document, reads
 *    at most {@link DIGEST_HEAD_BYTES}, and stops at the closing fence.
 *  - **Read each file at most once per change.** Digests and transfer paths are
 *    cached in this process, keyed by the file's `mtime`/`ctime`/size signature,
 *    and the cache entry for a file this process wrote is refreshed from the write
 *    itself. A concurrent writer in another process is therefore still seen (its
 *    signature differs), and nothing here is a second source of truth: the cache
 *    is derived state that a stat invalidates.
 *
 * The route sidecar is append-only and separate from the report file: the audit
 * trail must be able to grow without rewriting the document, and a torn write in
 * one must not corrupt the other.
 *
 * @module dsh-report-ledger/report/ledger
 */

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { appendFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hasFrontMatter, parseHop, parseReport, serializeReport, splitFrontMatter } from './frontmatter.ts'
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
const REPORT_ROUTE = /^R-(\d{4,})\.route\.jsonl$/

/**
 * How much of a document is opened to build its digest.
 *
 * A front matter is a flat mapping of short scalars — recipients are the only
 * field that grows without bound, at roughly 60 bytes per entry — so 16 KiB is
 * around 250 addressees, and anything beyond that is a hand-built outlier. A head
 * that does not contain the closing fence is not damage: the reader falls back to
 * a full read, which costs what it always did and leaves the fast path honest.
 */
const DIGEST_HEAD_BYTES = 16 * 1024

/**
 * How many files may be open at once during one listing.
 *
 * The per-file cost of a read is dominated by the operating system and by any
 * on-access scanner, not by the bytes: measured on Windows, 200 sequential reads
 * of the same files took ~200 ms while the same reads in flight took ~68 ms. A
 * bound keeps a large ledger from opening thousands of handles at once without
 * giving up that gain.
 */
const READ_CONCURRENCY = 32

/** How many digests are held in memory before the oldest is dropped. */
const DIGEST_CACHE_ENTRIES = 8192

/**
 * How many bytes of transfer paths are held in memory.
 *
 * Accounted in bytes rather than entries because a path's size is what a report
 * actually accumulates: a long-lived report can carry hundreds of hops, while a
 * fresh one carries two. A single sidecar larger than the whole budget is not
 * cached at all — it would evict everything else to hold one file.
 */
const HOP_CACHE_BYTES = 8 * 1024 * 1024

/** One cached digest, with the file signature it was read at. */
interface DigestEntry {
  /** `mtime`/`ctime`/size at the moment the digest was read. */
  readonly sig: string
  /**
   * The digest as parsed from the file.
   *
   * Shared between readers: callers must treat every returned digest as
   * immutable. Nothing in this plugin mutates one — a mutation is a write through
   * {@link writeReport}, which owns the cache.
   */
  readonly front: ReportFrontMatter
}

/** One cached transfer path, with the file signature it was read at. */
interface HopEntry {
  /** `mtime`/`ctime`/size at the moment the path was read. */
  readonly sig: string
  /** Size of the sidecar, for the byte budget. */
  readonly bytes: number
  /** The hops, oldest first. Shared with readers; see {@link DigestEntry.front}. */
  readonly hops: RouteHop[]
}

/** Digests read in this process, keyed by report id. */
const digestCache = new Map<string, DigestEntry>()

/** Transfer paths read in this process, keyed by report id. */
const hopCache = new Map<string, HopEntry>()

/** Running sum of {@link hopCache} sizes. */
let hopCacheBytes = 0

/**
 * The signature that decides whether a cached read is still true.
 *
 * Modification and change time plus size is the whole check: every write path
 * here either renames a new document into place (new `mtime`, usually new size)
 * or appends to an existing one (always new size), and a hand edit changes at
 * least the `mtime`. A concurrent writer in another process therefore cannot
 * hide behind a stale entry, and there is no TTL to tune: a stale entry is
 * wrong, and a short enough TTL is still wrong for that window.
 * @param info - the file's stat result.
 * @returns the signature.
 */
function signature(info: Stats): string {
  return `${info.mtimeMs}:${info.ctimeMs}:${info.size}`
}

/**
 * Store one digest, dropping the oldest entries when the budget is exceeded.
 *
 * Insertion order is the eviction order, and a hit re-inserts so a hot report
 * survives a sweep that touches everything else once.
 * @param id - report id.
 * @param entry - the digest and its signature.
 */
function rememberDigest(id: string, entry: DigestEntry): void {
  digestCache.delete(id)
  digestCache.set(id, entry)
  for (const key of digestCache.keys()) {
    if (digestCache.size <= DIGEST_CACHE_ENTRIES) break
    digestCache.delete(key)
  }
}

/**
 * Store one transfer path, dropping oldest entries to stay inside the byte budget.
 * @param id - report id.
 * @param entry - the hops and their signature.
 */
function rememberHops(id: string, entry: HopEntry): void {
  const previous = hopCache.get(id)
  if (previous !== undefined) {
    hopCache.delete(id)
    hopCacheBytes -= previous.bytes
  }
  // An oversized sidecar stays uncached: holding it would evict every other path
  // to buy one read, which is the wrong trade on a ledger anyone is scanning.
  if (entry.bytes > HOP_CACHE_BYTES) return
  hopCache.set(id, entry)
  hopCacheBytes += entry.bytes
  for (const [key, value] of hopCache) {
    if (hopCacheBytes <= HOP_CACHE_BYTES) break
    if (key === id) break
    hopCache.delete(key)
    hopCacheBytes -= value.bytes
  }
}

/**
 * Forget everything cached for one report.
 * @param id - report id.
 */
function forget(id: string): void {
  digestCache.delete(id)
  const hops = hopCache.get(id)
  if (hops !== undefined) {
    hopCache.delete(id)
    hopCacheBytes -= hops.bytes
  }
}

/**
 * Drop the whole read cache.
 *
 * Two callers: a test that wants to prove a listing reads the disk rather than a
 * memo of an earlier disk, and an operator-facing reset if a deployment ever
 * suspects the cache. Ordinary code never needs it — a stat invalidates.
 */
export function clearReadCache(): void {
  digestCache.clear()
  hopCache.clear()
  hopCacheBytes = 0
}

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
    const match = REPORT_FILE.exec(name) ?? REPORT_ROUTE.exec(name)
    if (match === null) continue
    const value = Number(match[1])
    if (Number.isFinite(value) && value > highest) highest = value
  }
  for (let attempt = 0; attempt < 64; attempt++) {
    const candidate = `R-${String(highest + 1 + attempt).padStart(4, '0')}`
    const path = reportPath(candidate)
    // An orphan sidecar is an old audit trail whose document was removed. Reusing
    // the id would make the new report inherit those hops, so skip the number.
    if (existsSync(routePath(candidate))) continue
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
    // The write itself is the freshest statement about this file, so the cache is
    // refreshed from it rather than merely dropped: the very next listing (which
    // a mutation almost always triggers) then costs one stat instead of a read.
    // A failed stat here is bookkeeping, not writing — it drops the entry and the
    // next reader re-reads, which is the safe direction for it to fail in.
    try {
      rememberDigest(id, { sig: signature(await stat(target)), front })
    } catch {
      digestCache.delete(id)
    }
  } finally {
    // Best effort: after a successful rename the temp is already gone, and after
    // a failed write or rename it must not stay behind as an invisible `.tmp`.
    await unlink(temp).catch(() => undefined)
  }
}

/**
 * Read at most `limit` bytes from the head of a file.
 *
 * One `open`/`read`/`close` either way, and the buffer is sized by the budget
 * rather than the file, so a 4 MiB body costs no more than a 4 KiB one.
 * @param path - the file.
 * @param limit - maximum bytes to read.
 * @returns the decoded prefix, and whether it reached the end of the file.
 */
async function readHead(path: string, limit: number): Promise<{ text: string; complete: boolean }> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(Math.max(limit, 1))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), complete: bytesRead < buffer.length }
  } finally {
    await handle.close()
  }
}

/**
 * Map over a list with a fixed number of readers in flight.
 *
 * Order is preserved, and no more than `limit` calls are ever outstanding. The
 * work function is expected to contain its own failures: a throw rejects the
 * whole map, which is deliberate — a caller that wants per-item isolation (the
 * listing does) catches inside it.
 * @param items - the inputs.
 * @param limit - maximum concurrent calls.
 * @param work - the per-item call.
 * @returns one result per input, in input order.
 */
async function mapPool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await work(items[index] as T)
    }
  })
  // `work` is allowed to throw, but a bare Promise.all would leave the other
  // workers' rejections unhandled and can take the process down. Wait for all of
  // them, then surface the first failure to the caller.
  const settled = await Promise.allSettled(workers)
  const failed = settled.find((entry) => entry.status === 'rejected')
  if (failed !== undefined) throw failed.reason
  return results
}

/**
 * Read a document's digest without reading its body.
 *
 * Every way this can fail is a reason to fall back to the full read rather than
 * to report damage, because the head budget is our choice and not the file's
 * fault: a front matter that does not fit is read whole, and a document the
 * prefix cannot explain is left to {@link parseReport}.
 * @param path - the document.
 * @param size - the file's size, from the stat that produced the signature.
 * @returns the digest, or `undefined` when the document has no usable front matter.
 * @throws when the file cannot be read at all (the caller skips one entry).
 */
async function readDigestAt(path: string, size: number): Promise<ReportFrontMatter | undefined> {
  const head = await readHead(path, Math.min(size, DIGEST_HEAD_BYTES))
  // A complete head is the whole document, and a prefix that already contains the
  // closing fence parses exactly like one; only a prefix that does not is
  // ambiguous, and that is what the fallback is for.
  if (head.complete || hasFrontMatter(head.text, false)) return parseReport(head.text)?.front
  return parseReport(await readFile(path, 'utf8'))?.front
}

/**
 * Read one report's digest, through the cache.
 *
 * The stat comes first and both branches use it: its signature decides whether
 * the cached digest is still true, and its size bounds the head read. That makes
 * the steady state one metadata call per report instead of one open/read/close.
 * @param id - report identifier.
 * @returns the digest, or `undefined` when the document is missing or malformed.
 */
async function readDigest(id: string): Promise<ReportFrontMatter | undefined> {
  const path = reportPath(id)
  let info: Stats
  try {
    info = await stat(path)
  } catch (error) {
    // A report that is gone must not leave a digest behind: the entry would be
    // invisible to every listing (which reads the directory) but would keep the
    // record alive for anyone who asks for that id.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') forget(id)
    throw error
  }
  const sig = signature(info)
  const cached = digestCache.get(id)
  if (cached !== undefined && cached.sig === sig) {
    // Re-insert: insertion order is the eviction order, so a report that is read
    // often outlives one that was read once.
    rememberDigest(id, cached)
    return cached.front
  }
  const front = await readDigestAt(path, Number(info.size))
  if (front === undefined) {
    digestCache.delete(id)
    return undefined
  }
  rememberDigest(id, { sig, front })
  return front
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
    // The file name is the identity, exactly as in listReports. A hand-edited or
    // copied document can carry another report's `report:` field; letting that
    // value escape would make delivery write the body path and the `delivered`
    // hop against a different report.
    return {
      front: parsed.front.report === id ? parsed.front : { ...parsed.front, report: id },
      body: parsed.body,
    }
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
 * a read or skips body text. The body is by definition large when this is asked,
 * so it is read as a head: the front matter is what the answer comes from.
 * @param id - report identifier.
 * @returns the line, or `undefined` when the document is missing or malformed.
 */
export async function bodyStartLine(id: string): Promise<number | undefined> {
  if (!isValidReportId(id)) return undefined
  const path = reportPath(id)
  let info: Stats
  try {
    info = await stat(path)
  } catch {
    return undefined
  }
  try {
    const head = await readHead(path, Math.min(Number(info.size), DIGEST_HEAD_BYTES))
    if (head.complete || hasFrontMatter(head.text, false)) return splitFrontMatter(head.text)?.bodyLine
    // A front matter larger than the head budget: the answer is in a document the
    // fast path declared ambiguous, so read it whole.
    return splitFrontMatter(await readFile(path, 'utf8'))?.bodyLine
  } catch {
    return undefined
  }
}

/**
 * Append one hop to a report's transfer path.
 *
 * Append-only by construction: the audit trail is never rewritten, so a
 * concurrent reader sees a prefix of hops rather than a torn file.
 *
 * The cached path is dropped rather than extended. Appending to the cached array
 * would be faster but would silently lose a hop another process appended in the
 * meantime; the next read returns exactly what the file says, and a delivery
 * sweep re-reads each path once anyway.
 * @param id - report identifier.
 * @param hop - the hop to record.
 */
export async function appendHop(id: string, hop: RouteHop): Promise<void> {
  if (!isValidReportId(id)) throw new Error(`report-ledger: invalid report id ${JSON.stringify(id)}`)
  await ensureDirs()
  const path = routePath(id)
  // A process killed mid-append can leave a partial last line without its
  // newline. Appending straight onto it would glue the next hop to the torn JSON
  // and lose both; start a fresh line instead.
  let needsNewline = false
  try {
    const info = await stat(path)
    if (info.size > 0) {
      const handle = await open(path, 'r')
      try {
        const last = Buffer.alloc(1)
        await handle.read(last, 0, 1, Number(info.size) - 1)
        needsNewline = last[0] !== 0x0a
      } finally {
        await handle.close()
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await appendFile(path, `${needsNewline ? '\n' : ''}${JSON.stringify(hop)}\n`, 'utf8')
  const cached = hopCache.get(id)
  if (cached !== undefined) {
    hopCache.delete(id)
    hopCacheBytes -= cached.bytes
  }
}

/**
 * Append to a report's body in place.
 *
 * The counterpart of {@link writeReport} for the two mutations that must not
 * rewrite a document — a contribution and an appending amendment — because
 * several agents may be adding their own section. It exists here rather than as a
 * bare `appendFile` at the call site so that every change to a document crosses
 * one place that can drop the cached digest; an in-place append changes the file's
 * signature, but the cache has no reason to learn that through a failed lookup.
 * @param id - report identifier.
 * @param text - the text to append verbatim.
 */
export async function appendReportBody(id: string, text: string): Promise<void> {
  if (!isValidReportId(id)) throw new Error(`report-ledger: invalid report id ${JSON.stringify(id)}`)
  await appendFile(reportPath(id), text, 'utf8')
  digestCache.delete(id)
}

/**
 * Read the complete transfer path of a report.
 *
 * Cached by file signature. The returned array is a copy, so a caller may sort or
 * splice its own list without disturbing the next reader; the hop objects in it
 * are shared and are treated as immutable throughout.
 * @param id - report identifier.
 * @returns every readable hop, oldest first.
 */
export async function readHops(id: string): Promise<RouteHop[]> {
  if (!isValidReportId(id)) return []
  const path = routePath(id)
  let info: Stats
  try {
    info = await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const cached = hopCache.get(id)
      if (cached !== undefined) {
        hopCache.delete(id)
        hopCacheBytes -= cached.bytes
      }
      return []
    }
    throw error
  }
  const sig = signature(info)
  const cached = hopCache.get(id)
  if (cached !== undefined && cached.sig === sig) return [...cached.hops]
  const raw = await readFile(path, 'utf8')
  const hops: RouteHop[] = []
  for (const line of raw.split('\n')) {
    const hop = parseHop(line)
    if (hop !== undefined) hops.push(hop)
  }
  rememberHops(id, { sig, bytes: Number(info.size), hops })
  return [...hops]
}

/**
 * List every report digest, newest first.
 *
 * Only the front matter of each document is read — a bounded head, never the
 * body — and the reads are overlapped, so the cost tracks the number of files
 * rather than the bytes in them. Repeated listings in one process cost one stat
 * per report, because a digest is cached by its file signature (see the module
 * header).
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
  let names: string[]
  try {
    names = await readdir(reportsDir())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const ids: string[] = []
  for (const name of names) {
    const match = REPORT_FILE.exec(name)
    if (match !== null) ids.push(`R-${match[1]}`)
  }
  const read = await mapPool(ids, READ_CONCURRENCY, async (id) => {
    try {
      const digest = await readDigest(id)
      // The file name is the identity; the digest's own `report` field is a
      // normalized cache of it. Reporting the field verbatim would let one file
      // masquerade as another record in a listing, and would misdirect the
      // delivery pump, which keys each holding by `digest.report`.
      return digest === undefined ? undefined : { ...digest, report: id }
    } catch {
      // Deliberately silent: the listing has no diagnostic channel, and throwing
      // here would hide every healthy report behind one broken one.
      return undefined
    }
  })
  const digests = read.filter((digest): digest is ReportFrontMatter => digest !== undefined)
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
    // The claim never had a chance to append a hop; an empty sidecar left beside
    // the placeholder is litter, but a non-empty one is someone's audit trail.
    try {
      if ((await readFile(routePath(id), 'utf8')) === '') await unlink(routePath(id))
    } catch {
      // Missing or unreadable sidecar: leave it alone.
    }
    forget(id)
    return true
  } catch {
    return false
  }
}
