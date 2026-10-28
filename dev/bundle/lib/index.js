import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { mountHost, mountWhenFree } from "../../../lib/index.js";
import { mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { parse } from "yaml";
//#region src/report/types.ts
/**
* The report model.
*
* A report is the plugin's first-class interaction primitive between agents. It
* is deliberately two-layered:
*
*  - the FRONT MATTER is the digest — a bounded flat mapping that can enter a
*    model context, an index, or a timeline card without dragging the body in;
*  - the BODY is the detail, stored out of context and read on demand.
*
* The transfer path is a third, append-only stream (see {@link RouteHop}): every
* hop — authoring, contribution, send, delivery, CC, forwarding, copying, read,
* acknowledgement — is recorded with its actor and time, so the complete route
* including every copy survives independently of the report text.
*
* @module dsh-report-ledger/report/types
*/
/**
* Every report status, as both the runtime list and the source of
* {@link ReportStatus}.
*
* A union type and a validator array are two spellings of one fact, and two
* spellings drift. The parser falls back to `open` for anything it does not
* recognize, so a status that existed in the type but not in the array would
* quietly rewrite itself on the next read.
*/
const REPORT_STATUSES = [
	"open",
	"acked",
	"closed"
];
/**
* One recorded hop in a report's transfer path.
*
* `authored` and `contributed` establish co-authorship; `sent`/`delivered` are
* the addressed hand-off and its arrival; `cc` is a quiet copy; `forwarded` and
* `copied` are onward transfer and duplication; `read`/`acked` close the loop for
* one reader; `leased`/`released` bracket a claim on a working tree, and
* `reclaimed` records that the ledger cleared a checkout away because the owner
* asked for it at closing time;
* `amended` records a correction to the digest or the body; `closed` concludes
* the matter, and `reopened` records that fresh activity brought it back to life;
* `transferred` moves one unpaid hand-off from the session that owed it to
* another, without ever claiming it was delivered.
*
* Declared as a value and derived into a type on purpose. The parser validates
* each record against this list and **drops** one it does not recognize, so a
* union that named an action this array omitted would lose those hops from the
* audit trail without a word — the single failure a ledger must not have.
* Deriving the type from the value makes that drift impossible rather than
* merely unlikely; it happened once already, when `leased` and `released`
* reached the union before the array.
*/
const HOP_ACTIONS = [
	"authored",
	"contributed",
	"sent",
	"delivered",
	"cc",
	"forwarded",
	"copied",
	"read",
	"acked",
	"leased",
	"released",
	"reclaimed",
	"amended",
	"closed",
	"reopened",
	"transferred"
];
//#endregion
//#region src/report/frontmatter.ts
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
/** The front-matter fence. */
const FENCE = "---";
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
function normalizeDocument(raw) {
	return (raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw).replace(/\r\n?/g, "\n");
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
function frontMatterEnd(text, atEnd) {
	if (!text.startsWith(`${FENCE}\n`)) return void 0;
	let from = 4;
	for (;;) {
		const next = text.indexOf("\n", from);
		if (next < 0) return atEnd && text.slice(from) === FENCE ? text.length : void 0;
		if (text.slice(from, next) === FENCE) return next + 1;
		from = next + 1;
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
function hasFrontMatter(raw, complete) {
	return frontMatterEnd(normalizeDocument(raw), complete) !== void 0;
}
/**
* Split a document into its YAML front matter and body.
*
* A BOM and CRLF line endings are tolerated (see {@link normalizeDocument}).
* @param raw - the file text.
* @returns the parsed mapping, the body, and the body's first line, or `undefined` when there is no front matter.
*/
function splitFrontMatter(raw) {
	const text = normalizeDocument(raw);
	const end = frontMatterEnd(text, true);
	if (end === void 0) return void 0;
	const lines = text.slice(0, end).split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	const close = lines.length - 1;
	const yamlText = lines.slice(1, close).join("\n");
	let parsed;
	try {
		parsed = parse(yamlText, { uniqueKeys: false });
	} catch {
		return;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return void 0;
	const rest = text.slice(end);
	const bodyLines = rest === "" ? [] : rest.split("\n");
	let lead = 0;
	while (lead < bodyLines.length && (bodyLines[lead] ?? "").trim() === "") lead++;
	return {
		data: parsed,
		body: bodyLines.join("\n").replace(/^\n/, ""),
		bodyLine: close + 2 + lead
	};
}
/** Read a string field, tolerating numbers and quoteless scalars. */
function str(value) {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed === "" ? void 0 : trimmed;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
}
/** Read a plain list of strings from a scalar or sequence. */
function strList(value) {
	if (value === void 0 || value === null) return [];
	const source = Array.isArray(value) ? value : [value];
	const out = [];
	for (const item of source) {
		const text = str(item);
		if (text !== void 0 && !out.includes(text)) out.push(text);
	}
	return out;
}
/** Read a finite number, or `undefined`. */
function num(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
}
/** Read a timestamp, defaulting when absent or invalid. */
function time(value, fallback) {
	const parsed = num(value);
	return parsed === void 0 || parsed < 0 ? fallback : parsed;
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
function toWorktree(value) {
	if (value === void 0 || value === null) return void 0;
	const record = typeof value === "object" && !Array.isArray(value) ? value : { path: value };
	const path = str(record.path);
	if (path === void 0) return void 0;
	const branch = str(record.branch);
	const head = str(record.head);
	const repo = str(record.repo);
	return {
		path,
		...branch === void 0 ? {} : { branch },
		...head === void 0 ? {} : { head },
		...repo === void 0 ? {} : { repo },
		...typeof record.allocated === "boolean" ? { allocated: record.allocated } : {}
	};
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
function toFrontMatter(data) {
	const report = str(data.report) ?? str(data.id);
	if (report === void 0) return void 0;
	const statusText = str(data.status);
	const status = REPORT_STATUSES.find((candidate) => candidate === statusText) ?? "open";
	const created = time(data.created, 0);
	const updated = time(data.updated, created);
	const worktree = toWorktree(data.worktree);
	const lastRaw = data.last;
	let last;
	if (lastRaw !== null && typeof lastRaw === "object" && !Array.isArray(lastRaw)) {
		const record = lastRaw;
		const actionText = str(record.action);
		const action = HOP_ACTIONS.find((candidate) => candidate === actionText);
		const actor = str(record.actor);
		if (action !== void 0 && actor !== void 0) last = {
			at: time(record.at, updated),
			action,
			actor
		};
	}
	return {
		report,
		subject: str(data.subject) ?? "(no subject)",
		status,
		from: str(data.from) ?? "unknown",
		...str(data.fromName) === void 0 ? {} : { fromName: str(data.fromName) },
		to: strList(data.to),
		cc: strList(data.cc),
		authors: strList(data.authors),
		created,
		updated,
		...str(data.parent) === void 0 ? {} : { parent: str(data.parent) },
		children: strList(data.children),
		...str(data.task) === void 0 ? {} : { task: str(data.task) },
		...worktree === void 0 ? {} : { worktree },
		artifacts: strList(data.artifacts),
		hops: num(data.hops) ?? 0,
		reads: num(data.reads) ?? 0,
		...last === void 0 ? {} : { last },
		...str(data.spill) === void 0 ? {} : { spill: str(data.spill) }
	};
}
/**
* Parse one report document.
* @param raw - the file text.
* @returns the report, or `undefined` when the document has no usable front matter.
*/
function parseReport(raw) {
	const split = splitFrontMatter(raw);
	if (split === void 0) return void 0;
	const front = toFrontMatter(split.data);
	if (front === void 0) return void 0;
	return {
		front,
		body: split.body,
		bodyLine: split.bodyLine
	};
}
//#endregion
//#region src/report/ledger.ts
/** Directory name under the DSH home that holds the whole ledger. */
const LEDGER_DIR = "report-ledger";
/**
* Explicit override of the ledger root.
*
* Two legitimate uses: relocating the ledger on a deployment that keeps state
* somewhere other than the DSH home, and pointing a test or a second profile at
* a throwaway root so a test run cannot touch the real ledger.
*/
const ROOT_OVERRIDE = "DSH_REPORT_LEDGER_ROOT";
/** Report id shape: `R-` and at least four digits. */
const REPORT_ID = /^R-(\d{4,})$/;
/** Report file name shape. */
const REPORT_FILE = /^R-(\d{4,})\.md$/;
/**
* How much of a document is opened to build its digest.
*
* A front matter is a flat mapping of short scalars — recipients are the only
* field that grows without bound, at roughly 60 bytes per entry — so 16 KiB is
* around 250 addressees, and anything beyond that is a hand-built outlier. A head
* that does not contain the closing fence is not damage: the reader falls back to
* a full read, which costs what it always did and leaves the fast path honest.
*/
const DIGEST_HEAD_BYTES = 16 * 1024;
/**
* How many files may be open at once during one listing.
*
* The per-file cost of a read is dominated by the operating system and by any
* on-access scanner, not by the bytes: measured on Windows, 200 sequential reads
* of the same files took ~200 ms while the same reads in flight took ~68 ms. A
* bound keeps a large ledger from opening thousands of handles at once without
* giving up that gain.
*/
const READ_CONCURRENCY = 32;
/** How many digests are held in memory before the oldest is dropped. */
const DIGEST_CACHE_ENTRIES = 8192;
/** Digests read in this process, keyed by report id. */
const digestCache = /* @__PURE__ */ new Map();
/** Transfer paths read in this process, keyed by report id. */
const hopCache = /* @__PURE__ */ new Map();
/** Running sum of {@link hopCache} sizes. */
let hopCacheBytes = 0;
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
function signature(info) {
	return `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
}
/**
* Store one digest, dropping the oldest entries when the budget is exceeded.
*
* Insertion order is the eviction order, and a hit re-inserts so a hot report
* survives a sweep that touches everything else once.
* @param id - report id.
* @param entry - the digest and its signature.
*/
function rememberDigest(id, entry) {
	digestCache.delete(id);
	digestCache.set(id, entry);
	for (const key of digestCache.keys()) {
		if (digestCache.size <= DIGEST_CACHE_ENTRIES) break;
		digestCache.delete(key);
	}
}
/**
* Forget everything cached for one report.
* @param id - report id.
*/
function forget(id) {
	digestCache.delete(id);
	const hops = hopCache.get(id);
	if (hops !== void 0) {
		hopCache.delete(id);
		hopCacheBytes -= hops.bytes;
	}
}
/**
* Resolve the DSH home directory.
*
* Read from the environment rather than imported from a harness package: this
* module must stay usable from any host context, and `DSH_HOME` is the same
* value the harness itself uses to place its own state.
* @returns the absolute DSH home path.
*/
function dshHome() {
	const fromEnv = process.env.DSH_HOME;
	if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
	return join(homedir(), ".dsh");
}
/** Absolute path of the ledger root. */
function ledgerRoot() {
	const override = process.env[ROOT_OVERRIDE];
	if (typeof override === "string" && override.trim() !== "") return override;
	return join(dshHome(), LEDGER_DIR);
}
/** Absolute path of the directory holding report documents. */
function reportsDir() {
	return join(ledgerRoot(), "reports");
}
/**
* Absolute path of one report document.
* @param id - report identifier.
* @returns the path.
*/
function reportPath(id) {
	return join(reportsDir(), `${id}.md`);
}
/**
* Whether a string is a well-formed report identifier.
* @param id - candidate identifier.
* @returns true when it matches the ledger's id shape.
*/
function isValidReportId(id) {
	return REPORT_ID.test(id);
}
/** Create the ledger directories if they do not exist yet. */
async function ensureDirs() {
	await mkdir(reportsDir(), { recursive: true });
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
async function readHead(path, limit) {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(Math.max(limit, 1));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return {
			text: buffer.subarray(0, bytesRead).toString("utf8"),
			complete: bytesRead < buffer.length
		};
	} finally {
		await handle.close();
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
async function mapPool(items, limit, work) {
	const results = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await work(items[index]);
		}
	});
	const failed = (await Promise.allSettled(workers)).find((entry) => entry.status === "rejected");
	if (failed !== void 0) throw failed.reason;
	return results;
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
async function readDigestAt(path, size) {
	const head = await readHead(path, Math.min(size, DIGEST_HEAD_BYTES));
	if (head.complete || hasFrontMatter(head.text, false)) return parseReport(head.text)?.front;
	return parseReport(await readFile(path, "utf8"))?.front;
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
async function readDigest(id) {
	const path = reportPath(id);
	let info;
	try {
		info = await stat(path);
	} catch (error) {
		if (error.code === "ENOENT") forget(id);
		throw error;
	}
	const sig = signature(info);
	const cached = digestCache.get(id);
	if (cached !== void 0 && cached.sig === sig) {
		rememberDigest(id, cached);
		return cached.front;
	}
	const front = await readDigestAt(path, Number(info.size));
	if (front === void 0) {
		digestCache.delete(id);
		return;
	}
	rememberDigest(id, {
		sig,
		front
	});
	return front;
}
/**
* Read one report.
* @param id - report identifier.
* @returns the report, or `undefined` when it does not exist or is unreadable.
*/
async function readReport(id) {
	if (!isValidReportId(id)) return void 0;
	try {
		const parsed = parseReport(await readFile(reportPath(id), "utf8"));
		if (parsed === void 0) return void 0;
		return {
			front: parsed.front.report === id ? parsed.front : {
				...parsed.front,
				report: id
			},
			body: parsed.body
		};
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw error;
	}
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
async function listReports() {
	await ensureDirs();
	let names;
	try {
		names = await readdir(reportsDir());
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	const ids = [];
	for (const name of names) {
		const match = REPORT_FILE.exec(name);
		if (match !== null) ids.push(`R-${match[1]}`);
	}
	const digests = (await mapPool(ids, READ_CONCURRENCY, async (id) => {
		try {
			const digest = await readDigest(id);
			return digest === void 0 ? void 0 : {
				...digest,
				report: id
			};
		} catch {
			return;
		}
	})).filter((digest) => digest !== void 0);
	digests.sort((left, right) => right.updated - left.updated || right.report.localeCompare(left.report));
	return digests;
}
//#endregion
//#region dev/bundle/src/archive.ts
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
/** Hard ceiling for one archive file's text. */
const MAX_ARCHIVE_BYTES = 16 * 1024;
/**
* Headings whose sections are kept in full.
*
* Deliberately a vocabulary rather than a position rule ("keep the last
* section"): the same thread puts its conclusions in different places across
* rounds, and a positional rule would keep the wrong half of a long report.
*/
const CONCLUSION_HEADING = /(结论|决定|建议|风险|未决|未修|驳回|后续|待办|问题|缺口|发现|摘要|conclusion|decision|finding|risk|summary|open question)/i;
/**
* Turn one body into heading-delimited sections.
*
* `### contribution by …` markers are part of the body's own structure, so they
* become sections like any heading — which is what keeps several rounds of one
* thread readable in the archive rather than merged into one wall.
* @param body - the report body.
* @returns the sections, in document order.
*/
function sectionsOf(body) {
	const sections = [];
	let heading;
	let buffer = [];
	const flush = () => {
		const text = buffer.join("\n").trim();
		if (text !== "" || heading !== void 0) sections.push({
			...heading === void 0 ? {} : { heading },
			text
		});
		buffer = [];
	};
	for (const line of body.split("\n")) {
		if (/^#{1,3} /.test(line)) {
			flush();
			heading = line.replace(/^#+\s+/, "").trim();
			buffer.push(line);
			continue;
		}
		buffer.push(line);
	}
	flush();
	return sections;
}
/** Whether a section is one of the ones kept in full. */
function isConclusion(section) {
	return section.heading !== void 0 && CONCLUSION_HEADING.test(section.heading);
}
/** Format an epoch millisecond value as a UTC date-time, for a stable archive. */
function iso(ms) {
	return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
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
function topicSlug(input) {
	const slug = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
	return slug === "" ? "archive" : slug.slice(0, 60);
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
function renderArchive(topic, sources) {
	const parts = [
		`# ${topic.topic}`,
		"",
		`<!-- generated by dev_archive — do not hand-edit; rebuild it from the ledger -->`,
		"",
		`- topic: ${topic.topic}`,
		`- summary: ${topic.summary}`,
		`- reports: ${topic.reports.length === 0 ? "(none)" : topic.reports.join(", ")}`,
		`- source updated: ${iso(topic.updated)}`,
		"- note: this is a distillation. It keeps the conclusion sections and lists every",
		"  heading, so a reader can see what was left out; the ledger holds the rest if it",
		"  is still reachable.",
		"",
		"## outline",
		""
	];
	for (const source of sources) {
		const sections = sectionsOf(source.body);
		parts.push(`### ${source.front.report} — ${source.front.subject}`);
		for (const section of sections) {
			if (section.heading === void 0) continue;
			parts.push(`- ${section.heading}`);
		}
		parts.push("");
	}
	for (const source of sources) {
		const sections = sectionsOf(source.body);
		const kept = sections.filter(isConclusion);
		const omitted = sections.filter((section) => section.heading !== void 0 && !isConclusion(section));
		parts.push(`## ${source.front.report} — ${source.front.subject}`, "", `- status: ${source.front.status} · task: ${source.front.task ?? "(none)"} · hops: ${source.front.hops} · updated: ${iso(source.front.updated)}`, "");
		if (kept.length === 0) parts.push("(no conclusion section was recognised; read the outline above)", "");
		for (const section of kept) parts.push(section.text, "");
		if (omitted.length > 0) parts.push(`omitted sections (${omitted.length}):`, ...omitted.map((section) => `- ${section.heading}`), "");
	}
	const text = parts.join("\n");
	if (Buffer.byteLength(text, "utf8") <= 16384) return text;
	const marker = `\n\n… truncated at the ${MAX_ARCHIVE_BYTES}-byte budget; the rest is in the ledger, if it still exists\n`;
	const limit = MAX_ARCHIVE_BYTES - Buffer.byteLength(marker, "utf8");
	const cut = Buffer.from(text, "utf8").subarray(0, limit).toString("utf8");
	return `${cut.slice(0, cut.lastIndexOf("\n") > 0 ? cut.lastIndexOf("\n") : cut.length)}${marker}`;
}
/** Render the index document. */
function renderIndex(topics, generatedAt) {
	const lines = [
		"# generated by dev_archive — do not hand-edit; rebuild it from the archive files",
		`generated: ${new Date(generatedAt).toISOString()}`,
		"topics:"
	];
	if (topics.length === 0) lines.push("  []");
	for (const topic of topics) {
		lines.push(`  - topic: ${JSON.stringify(topic.topic)}`);
		lines.push(`    file: ${JSON.stringify(topic.file)}`);
		lines.push(`    summary: ${JSON.stringify(topic.summary)}`);
		lines.push(`    reports: [${topic.reports.map((report) => JSON.stringify(report)).join(", ")}]`);
		lines.push(`    updated: ${new Date(topic.updated).toISOString()}`);
	}
	return lines.join("\n");
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
function parseIndex(text) {
	let document;
	try {
		document = parse(text);
	} catch {
		return { topics: [] };
	}
	if (document === null || typeof document !== "object" || Array.isArray(document)) return { topics: [] };
	const record = document;
	const generated = typeof record.generated === "string" ? record.generated : void 0;
	const rows = Array.isArray(record.topics) ? record.topics : [];
	const topics = [];
	for (const row of rows) {
		if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
		const entry = row;
		if (typeof entry.topic !== "string" || typeof entry.file !== "string") continue;
		const summary = typeof entry.summary === "string" ? entry.summary : "";
		const reports = Array.isArray(entry.reports) ? entry.reports.filter((report) => typeof report === "string") : [];
		const updated = typeof entry.updated === "string" ? Date.parse(entry.updated) : NaN;
		topics.push({
			topic: entry.topic,
			file: entry.file,
			summary,
			reports,
			updated: Number.isFinite(updated) ? updated : 0
		});
	}
	return {
		...generated === void 0 ? {} : { generated },
		topics
	};
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
function renderIndexBlock(topics, maxLines = 40) {
	if (topics.length === 0) return "";
	const ordered = [...topics].sort((left, right) => left.topic.localeCompare(right.topic));
	const shown = ordered.slice(0, maxLines);
	const lines = [
		"## 历史结论（插件自身开发期）",
		"",
		"这些是开发期留下的结论，只在这里注入。细节按需读文件——不要凭记忆猜，也不要把整份归档塞进上下文。",
		"",
		...shown.map((topic) => `- ${topic.topic} — ${topic.summary} — dev/archive/${topic.file}`)
	];
	if (ordered.length > shown.length) lines.push(`- …另有 ${ordered.length - shown.length} 条未展开，见 dev/archive/index.yml`);
	return lines.join("\n");
}
//#endregion
//#region dev/bundle/src/roster.ts
/**
* The developer-mode roster: which agents exist only while this plugin is being
* developed.
*
* This module is deliberately pure. Reading the file, registering presets and
* rendering prompt sections all live next door in `dev/index.ts`; here there is
* only "text in, entries out", so the parsing rules that decide whether a
* developer's edited roster takes effect can be pinned by deterministic checks
* without a harness, a filesystem, or a live registry.
*
* Two rules shape every decision below, and both come from the way this roster
* is used rather than from taste:
*
*  - **One bad row must not disable the rest.** The list is edited by hand while
*    the plugin is being developed, so a typo is routine. A row that cannot be
*    used is reported and skipped; the other agents still exist, and the reload
*    surface shows exactly which row was dropped and why.
*  - **The roster is data, not configuration.** It sits inside the checkout, so a
*    branch or a working tree can carry its own set of developer agents, which is
*    the whole point: the candidate implementation and the roster that measures
*    it travel together.
*
* @module dsh-report-ledger/report/dev/roster
*/
/**
* Shape a preset id must have.
*
* The id is not decoration: it is the preset identity saved into a session
* header, the string a roster entry is looked up by, and the value the preset
* registry refuses as a duplicate. Keeping it to an unambiguous character set
* means a typo produces a reported row instead of an id the registry rejects
* after the file was already read.
*/
const PRESET_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
/** Spacing used to derive `order` for rows that omit it. */
const ORDER_STEP = 10;
/**
* The prompt one preset id receives.
* @param agents - the roster currently in effect.
* @param presetId - the preset the assembling agent runs, when it has one.
* @returns the entry's prompt — plus the wind-down instruction when it is retired
*   — or `''` for every other agent.
*/
function promptFor(agents, presetId) {
	if (presetId === void 0 || presetId === "") return "";
	for (const agent of agents) {
		if (agent.id !== presetId) continue;
		return agent.retired ? `${agent.prompt}\n${WIND_DOWN}` : agent.prompt;
	}
	return "";
}
/**
* Parse the plugin's own record of which sessions are developer agents.
*
* The file is the whole mechanism: a developer agent is a session this plugin
* started, and the only thing that makes it one is an entry here. Keeping it out
* of the session header is deliberate — that shape belongs to the harness, and a
* development artifact must not require the harness to grow a field.
*
* Tolerant on purpose: a corrupt file costs the role prompt, never an activation.
* @param text - the bindings file contents.
* @returns session id → roster entry id.
*/
function parseBindings(text) {
	const bindings = /* @__PURE__ */ new Map();
	let document;
	try {
		document = JSON.parse(text);
	} catch {
		return bindings;
	}
	if (document === null || typeof document !== "object" || Array.isArray(document)) return bindings;
	for (const [session, entry] of Object.entries(document)) {
		if (session === "" || typeof entry !== "string" || entry === "") continue;
		bindings.set(session, entry);
	}
	return bindings;
}
/**
* Serialize the binding map.
*
* Session ids are sorted so re-writing the file after one start produces a diff of
* one line rather than a reshuffle — this file is committed nowhere, but it is read
* by humans debugging a role that failed to appear.
* @param bindings - session id → roster entry id.
* @returns the file text.
*/
function serializeBindings(bindings) {
	const document = {};
	for (const [session, entry] of [...bindings.entries()].sort(([left], [right]) => left.localeCompare(right))) document[session] = entry;
	return `${JSON.stringify(document, null, 2)}\n`;
}
/**
* What a retired entry's agent is told instead of new work.
*
* It replaces the silent version of retirement: removing an entry from the roster
* used to leave a live session running with an empty prompt — present, but with
* no idea why. A retired entry keeps its own instructions and gains this.
*/
const WIND_DOWN = [
	"",
	"## 你已被声明退役",
	"",
	"这是名单里的 `retired: true`，不是别人的口信。你的会话仍然存在，但不再接新工作，只做收尾：",
	"",
	"1. 用 `report_handover` 把手上的一切交出去：它先列出你仍开着的汇报、仍占着的检出、仍欠你的待送达；",
	"2. 你判断已经完成的汇报，在同一次调用的 `close` 里点名结案，其余留给继任者；",
	"3. 交接本身会落成一份 `task: handover` 汇报——那就是你留下的清单，后人不必猜。",
	"",
	"退役期间不要开新的汇报线，也不要再开同伴。账本里已经属于你的东西不会因为你退役而消失，",
	"它们只是换了一个人负责。"
].join("\n");
/** A roster document as the plain-object tree a YAML parser produced. */
function asRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
/** A trimmed non-empty string, or undefined. */
function nonEmptyString(value) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed;
}
/** Render a thrown value for a problem report. */
function message(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Parse one roster document.
*
* Rows are validated in a fixed order — identity, then prompt source — so a row
* with two faults reports the first one an editor would want to fix, and a
* duplicate is rejected before its prompt file is read.
* @param text - the roster document.
* @param readPromptFile - resolves a `promptFile` relative to the roster's
*   directory; returns undefined when the file is missing or unreadable.
* @returns the usable entries and every problem found.
*/
function parseRoster(text, readPromptFile) {
	let document;
	try {
		document = parse(text);
	} catch (error) {
		return {
			agents: [],
			problems: [{
				row: 0,
				reason: `the roster is not valid YAML: ${message(error)}`
			}]
		};
	}
	const rows = asRecord(document)?.agents;
	if (!Array.isArray(rows)) return {
		agents: [],
		problems: [{
			row: 0,
			reason: "the roster must be a mapping whose `agents` key is a sequence"
		}]
	};
	const agents = [];
	const problems = [];
	const seen = /* @__PURE__ */ new Set();
	rows.forEach((raw, index) => {
		const row = index + 1;
		const record = asRecord(raw);
		if (record === void 0) {
			problems.push({
				row,
				reason: "a roster row must be a mapping"
			});
			return;
		}
		const id = nonEmptyString(record.id);
		if (id === void 0) {
			problems.push({
				row,
				reason: "a roster row needs a non-empty `id`"
			});
			return;
		}
		if (!PRESET_ID.test(id)) {
			problems.push({
				row,
				id,
				reason: `\`${id}\` is not a usable preset id (letters, digits, and . _ : / - only)`
			});
			return;
		}
		if (seen.has(id)) {
			problems.push({
				row,
				id,
				reason: `duplicate id \`${id}\`; the first row wins`
			});
			return;
		}
		const inline = nonEmptyString(record.prompt);
		const file = nonEmptyString(record.promptFile);
		if (inline !== void 0 && file !== void 0) {
			problems.push({
				row,
				id,
				reason: "a row carries `prompt` and `promptFile`; keep exactly one"
			});
			return;
		}
		let prompt = inline;
		if (prompt === void 0 && file !== void 0) {
			prompt = nonEmptyString(readPromptFile(file));
			if (prompt === void 0) {
				problems.push({
					row,
					id,
					reason: `\`promptFile\` ${file} could not be read, or is empty`
				});
				return;
			}
		}
		if (prompt === void 0) {
			problems.push({
				row,
				id,
				reason: "a row needs `prompt` or `promptFile`"
			});
			return;
		}
		if (record.retired !== void 0 && typeof record.retired !== "boolean") {
			problems.push({
				row,
				id,
				reason: "`retired` must be a boolean (true or false)"
			});
			return;
		}
		const order = typeof record.order === "number" && Number.isFinite(record.order) ? record.order : (index + 1) * ORDER_STEP;
		seen.add(id);
		agents.push({
			id,
			name: nonEmptyString(record.name) ?? id,
			description: nonEmptyString(record.description) ?? "",
			order,
			prompt,
			retired: record.retired === true
		});
	});
	return {
		agents,
		problems
	};
}
//#endregion
//#region dev/bundle/src/index.ts
/**
* Developer mode — the add-on bundle's half, existing only in the checkout.
*
* This module is not imported by the release entry. It is built separately into
* `dev/bundle/lib/`, which `files` excludes, so a published artifact carries no
* developer-mode code at all — the release `lib/index.js` mounts the host half and
* nothing else. An installed package therefore cannot enable any of this, whatever
* its config says: `installDevMode` returns an empty disposer when
* `dev/agents.yml` is absent, and the roster is only in the repository.
* **Cloning the repository is the gate.**
*
* An earlier version published these agents as harness presets. That was wrong in
* a way worth recording: a preset is a deployment-level fact. It appears in the
* preset picker next to the shipped modes, it is selectable by anyone on the
* machine, and it outlives the checkout that declared it — a development artifact
* leaking into the product's own settings. So the agents below are **the plugin's
* own state**:
*
*  - they are sessions the plugin starts itself (`dev_agent_start`), through the
*    same peer machinery `peer_start` uses;
*  - which roster entry a session belongs to lives in the plugin's own file
*    (`$DSH_HOME/report-ledger/dev-agents.json`), not in a preset, not in a
*    session header;
*  - the prompt section routes by that binding, so a developer agent is identified
*    by the plugin alone.
*
* @module dsh-report-ledger-dev
*/
/** Name of the prompt section a developer agent receives. */
const DEV_SECTION = "plugin:report-ledger:dev";
/** Where the roster lives: `dev/agents.yml` beside this add-on's package root. */
const ROSTER_FILE = join("..", "agents.yml");
/** Where the archive index lives, likewise relative to the add-on package root. */
const ARCHIVE_DIR = join("..", "archive");
/**
* The plugin's own record of which sessions are developer agents.
*
* Deliberately not a session-header field: the header's `meta` is a closed shape
* the harness owns, and a development artifact must not need the harness to grow a
* field for it. This file is plugin state, lives beside the ledger, and is the
* only thing that decides who gets which role prompt.
*/
const BINDINGS_FILE = "dev-agents.json";
/** The one canonical output shape every report tool uses. */
const stringOutput = {
	schema: { type: "string" },
	render: (_args, value) => [{
		type: "text",
		text: String(value)
	}]
};
/**
* The package directory the running module belongs to.
*
* Walked rather than assumed: the same source is loaded as `lib/index.js` from a
* profile install, as `src/index.ts` from a checkout under a type-stripping
* runtime, and as a bundled artifact in tests. Every one of them sits under a
* directory holding this package's `package.json`.
* @returns the nearest ancestor directory that holds a `package.json`.
*/
function packageRoot() {
	let directory = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 8; depth += 1) {
		if (existsSync(join(directory, "package.json"))) return directory;
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return directory;
}
/** Render one problem as one log/grep-friendly line. */
function renderProblem(problem) {
	return `${problem.row === 0 ? "document" : `row ${problem.row}`}${problem.id === void 0 ? "" : ` (${problem.id})`}: ${problem.reason}`;
}
/**
* Install developer mode.
*
* Nothing is registered unless `config.devMode` is the literal boolean `true` —
* the caller checks that through {@link devModeEnabled} — and nothing is published
* to the harness at all: the section is a plugin-internal contribution, the tool
* starts sessions this plugin owns, and the roster and bindings are files only
* this plugin reads.
* @param ctx - the plugin context (`systemPrompt` and `tools`).
* @param peers - the peer service, which is how a developer session is created.
* @param service - the report service, used to hand the new session its task.
* @returns a disposer that removes every registration.
*/
function installDevMode(ctx, peers, service) {
	const root = packageRoot();
	const rosterPath = join(root, ROSTER_FILE);
	const bindingsPath = join(ledgerRoot(), BINDINGS_FILE);
	if (!existsSync(rosterPath)) return () => {};
	const readBindings = () => {
		try {
			return parseBindings(readFileSync(bindingsPath, "utf8"));
		} catch {
			return /* @__PURE__ */ new Map();
		}
	};
	const state = {
		current: {
			agents: [],
			problems: [],
			archive: ""
		},
		bindings: readBindings()
	};
	const readRoster = () => {
		let text;
		try {
			text = readFileSync(rosterPath, "utf8");
		} catch {
			return {
				agents: [],
				problems: [{
					row: 0,
					reason: `no roster at ${rosterPath} — developer mode only works from a source checkout`
				}],
				archive: readArchiveBlock()
			};
		}
		const rosterDirectory = dirname(rosterPath);
		const parsed = parseRoster(text, (relativePath) => {
			try {
				const resolved = resolve(rosterDirectory, relativePath);
				const inside = relative(rosterDirectory, resolved);
				if (inside.startsWith("..") || isAbsolute(inside)) return void 0;
				return readFileSync(resolved, "utf8");
			} catch {
				return;
			}
		});
		return {
			agents: parsed.agents,
			problems: parsed.problems,
			archive: readArchiveBlock()
		};
	};
	/**
	* Render the injected history block from `dev/archive/index.yml`.
	*
	* Read here rather than fetched from the ledger: a fork has the repository and no
	* ledger, and the block a development agent sees must be exactly what the
	* committed index says. A missing or unreadable index is an empty history, never
	* a failed assembly.
	* @returns the block, or `''` when nothing is archived.
	*/
	function readArchiveBlock() {
		try {
			return renderIndexBlock(parseIndex(readFileSync(join(root, ARCHIVE_DIR, "index.yml"), "utf8")).topics);
		} catch {
			return "";
		}
	}
	const reload = () => {
		state.current = readRoster();
		return state.current;
	};
	state.current = readRoster();
	const renderState = (dev) => {
		const active = dev.agents.filter((agent) => !agent.retired);
		const retired = dev.agents.filter((agent) => agent.retired);
		const bound = [...state.bindings.entries()];
		const byEntry = /* @__PURE__ */ new Map();
		for (const [, entryId] of bound) byEntry.set(entryId, (byEntry.get(entryId) ?? 0) + 1);
		const orphaned = bound.filter(([, entryId]) => !dev.agents.some((agent) => agent.id === entryId));
		const lines = [`developer roster: ${rosterPath}`];
		lines.push(active.length === 0 ? "enabled: none" : `enabled: ${active.length} — ${active.map((agent) => agent.id).join(", ")}`);
		if (retired.length > 0) lines.push(`retired: ${retired.length} — ${retired.map((agent) => agent.id).join(", ")} (their bound sessions get the wind-down)`);
		lines.push(dev.archive === "" ? "archive: none" : `archive: ${dev.archive.split("\n").length} prompt line(s)`);
		lines.push(bound.length === 0 ? "bound sessions: none" : `bound sessions: ${bound.length}${[...byEntry.entries()].map(([entryId, count]) => `${count}×${entryId}`).join(" ")}`);
		if (orphaned.length > 0) lines.push(`bound to an entry that is gone: ${orphaned.map(([session]) => session).join(", ")} — they lose the role prompt`);
		lines.push(dev.problems.length === 0 ? "problems: none" : `problems: ${dev.problems.length}\n${dev.problems.map((problem) => `  ${renderProblem(problem)}`).join("\n")}`);
		return lines.join("\n");
	};
	const disposers = [];
	disposers.push(ctx.systemPrompt.section({
		name: DEV_SECTION,
		order: 202,
		interpolate: false,
		text: (context) => {
			try {
				const agent = context.agent;
				if (agent === void 0) return "";
				const base = promptFor(state.current.agents, state.bindings.get(String(agent.id)));
				if (base === "") return "";
				return state.current.archive === "" ? base : `${base}\n\n${state.current.archive}`;
			} catch {
				return "";
			}
		}
	}));
	disposers.push(ctx.tools.register(defineTool({
		name: "dev_agents_reload",
		description: "Developer mode only: re-read the developer roster (dev/agents.yml) and the history archive (dev/archive/index.yml) from the checkout. Nothing is published to the harness — these agents are this plugin's own sessions — so this only refreshes what the plugin knows: which entries are enabled, which are retired, how many sessions are bound to each, and every roster row that could not be used. Editing YAML does not trigger the build watcher, so call this after an edit. A bad row is skipped and reported; the rest of the roster still applies.",
		parameters: {},
		output: stringOutput,
		execute: async () => renderState(reload())
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "dev_agent_start",
		description: "Developer mode only: start one agent from the developer roster (dev/agents.yml in this checkout) as a peer session, bound to this plugin. The role prompt and the archived conclusions are injected by the plugin itself, keyed by the binding it records — no harness preset is created, so nothing appears in the preset picker and the harness never learns the agent exists. The session is a normal peer: it outlives this turn, it receives its task as a report, and it counts against the peer budget. Retired entries cannot be started; they only wind down sessions already bound to them.",
		parameters: {
			entry: {
				type: "string",
				required: true,
				description: "Roster entry id to start, e.g. report-ledger:dev/probe."
			},
			task: {
				type: "string",
				required: true,
				description: "What this developer agent should do first. It becomes the opening report body."
			},
			name: {
				type: "string",
				description: "Optional display name; defaults to the roster entry name."
			}
		},
		output: stringOutput,
		execute: async (args, exec) => {
			const input = args;
			const agent = exec.agent;
			const actor = typeof agent?.id === "string" && agent.id !== "" ? agent.id : "";
			if (actor === "") throw new Error("report-ledger: dev_agent_start needs an owning agent session");
			const entry = state.current.agents.find((candidate) => candidate.id === input.entry.trim());
			if (entry === void 0) {
				const available = state.current.agents.filter((candidate) => !candidate.retired).map((candidate) => candidate.id);
				throw new Error(`report-ledger: no developer agent ${JSON.stringify(input.entry)} in dev/agents.yml; startable: ${available.length === 0 ? "(none)" : available.join(", ")}`);
			}
			if (entry.retired) throw new Error(`report-ledger: ${entry.id} is retired — it cannot be started; it only winds down the sessions still bound to it`);
			const delegated = await peers.start(actor, {
				task: input.task,
				name: input.name?.trim() === void 0 || input.name.trim() === "" ? entry.name : input.name.trim()
			});
			state.bindings.set(delegated.sessionId, entry.id);
			writeFileSync(bindingsPath, serializeBindings(state.bindings), "utf8");
			const authored = await service.author({
				subject: `dev: ${entry.name}`,
				body: [
					`你是 ${entry.id}（${entry.name}），一个只在插件开发期存在的代理。`,
					"你的职责与历史结论由插件自己的提示词段注入，不来自任何 harness 预设——因此它不出现在预设选择器里。",
					"",
					"## 任务",
					input.task
				].join("\n"),
				actor,
				to: [delegated.sessionId],
				task: `dev-${entry.id}`
			});
			return [
				`started ${entry.id} -> ${delegated.sessionId}`,
				`task report: ${authored.front.report} (task "dev-${entry.id}")`,
				`binding: ${delegated.sessionId} -> ${entry.id} (recorded in ${bindingsPath})`,
				"nothing was added to the harness: no preset, no picker entry"
			].join("\n");
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "dev_archive",
		description: "Developer mode only, and it WRITES INTO THE CHECKOUT: distill reports from the ledger into dev/archive/<topic>.md and rebuild dev/archive/index.yml, so the conclusions survive a fork that does not inherit this machine's ledger. It keeps the conclusion-shaped sections (结论/决定/建议/风险/发现/未决/…), lists every heading so the omissions are visible, and caps the file at a size budget; it never copies whole bodies. Select reports with `task` (partial, case-insensitive) or an explicit `reports` list — never \"everything\", because the ledger is machine-global and holds unrelated work. Re-running a topic replaces its file and its index entry; the index is generated, so do not hand-edit it. Returns the file, its byte size against the budget, and how many index lines the development prompt now carries.",
		parameters: {
			task: {
				type: "string",
				description: "Archive every report carrying this task label (partial match, case-insensitive)."
			},
			reports: {
				type: "array",
				items: { type: "string" },
				description: "Explicit report ids to archive instead of a task filter."
			},
			topic: {
				type: "string",
				description: "Topic slug for the file name; defaults to the task label, slugged (a label that slugs to nothing becomes \"archive\")."
			},
			summary: {
				type: "string",
				description: "One line that lets a reader decide whether to open the file. Defaults to a derived line."
			}
		},
		output: stringOutput,
		execute: async (args) => {
			const input = args;
			const task = input.task?.trim() ?? "";
			const explicit = (input.reports ?? []).map((report) => report.trim()).filter((report) => report !== "");
			if (explicit.length === 0 && task === "") throw new Error("report-ledger: dev_archive needs `task` or `reports` — it will not archive the whole ledger, which is machine-global and holds unrelated work");
			const selected = explicit.length > 0 ? explicit : (await listReports()).filter((front) => typeof front.task === "string" && front.task.toLowerCase().includes(task.toLowerCase())).map((front) => front.report);
			if (selected.length === 0) throw new Error(`report-ledger: no report matched ${explicit.length > 0 ? "that report list" : `task ${JSON.stringify(task)}`}`);
			const sources = [];
			const missing = [];
			for (const id of selected) {
				const found = await readReport(id);
				if (found === void 0) {
					missing.push(id);
					continue;
				}
				sources.push({
					front: found.front,
					body: found.body
				});
			}
			if (missing.length > 0) throw new Error(`report-ledger: no such report(s) in the ledger: ${missing.join(", ")}`);
			const topic = topicSlug(input.topic?.trim() ?? (task === "" ? sources[0].front.task ?? "" : task));
			const updated = Math.max(...sources.map((source) => source.front.updated));
			const summary = input.summary?.trim() ?? `${sources[0].front.subject.slice(0, 60)}${sources.length > 1 ? ` 等 ${sources.length} 份` : ""}`;
			const entry = {
				topic,
				file: `${topic}.md`,
				summary,
				reports: sources.map((source) => source.front.report),
				updated
			};
			const directory = join(root, ARCHIVE_DIR);
			mkdirSync(directory, { recursive: true });
			const fileText = renderArchive(entry, sources);
			writeFileSync(join(directory, entry.file), fileText, "utf8");
			const topics = /* @__PURE__ */ new Map();
			for (const known of readIndexFile(directory)) topics.set(known.topic, known);
			topics.set(entry.topic, entry);
			const ordered = [...topics.values()].sort((left, right) => left.topic.localeCompare(right.topic));
			writeFileSync(join(directory, "index.yml"), renderIndex(ordered, Date.now()), "utf8");
			state.current = {
				...state.current,
				archive: renderIndexBlock(ordered)
			};
			const block = renderIndexBlock(ordered);
			const bytes = Buffer.byteLength(fileText, "utf8");
			return [
				`archived ${entry.reports.join(", ")} -> dev/archive/${entry.file}`,
				`topic: ${entry.topic} · summary: ${entry.summary}`,
				`file: ${bytes} bytes (budget ${MAX_ARCHIVE_BYTES})${bytes >= 16384 ? " — TRUNCATED, see the marker at the end" : ""}`,
				`index: dev/archive/index.yml (${ordered.length} topic(s))`,
				`prompt block: ${block === "" ? 0 : block.split("\n").length} line(s) (budget 40 list lines)`,
				"bound development sessions see it on their next turn; no reload needed"
			].join("\n");
		}
	})));
	queueMicrotask(() => {
		for (const problem of state.current.problems) ctx.logger?.warn?.(`report-ledger: developer roster ${renderProblem(problem)}`);
	});
	return () => {
		for (const dispose of disposers.reverse()) dispose();
	};
	/** Read the archive index from disk, tolerating a missing or broken file. */
	function readIndexFile(directory) {
		try {
			return parseIndex(readFileSync(join(directory, "index.yml"), "utf8")).topics;
		} catch {
			return [];
		}
	}
}
/** The host services this add-on needs from the harness, like the release entry. */
const inject = [
	"tools",
	"systemPrompt",
	"agents"
];
/** How often the add-on re-reads the profile manifest, in milliseconds. */
const MANIFEST_POLL_MS = 500;
/** The release bundle's name in `dsh.profile.bundles`. */
const RELEASE_BUNDLE = "dsh-report-ledger";
/**
* Whether this profile still selects the release bundle.
*
* Developer mode is an overlay on the released plugin, not a standalone deployment:
* the add-on only runs while that bundle is still selected. A profile row's
* `baseUrl` points at the profile directory as a file URL, which is where the
* manifest lives.
* @param ctx - the plugin context.
* @returns true/false, or undefined when the manifest cannot be read — a checkout
*   always can, so undefined is treated as "proceed" rather than blocking a
*   contributor whose profile is laid out unexpectedly.
*/
function releaseBundleSelected(ctx) {
	if (ctx.baseUrl === void 0) return void 0;
	try {
		const directory = fileURLToPath(new URL(".", ctx.baseUrl));
		const bundles = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).dsh?.profile?.bundles;
		return Array.isArray(bundles) && bundles.includes(RELEASE_BUNDLE);
	} catch {
		return;
	}
}
/**
* Developer-mode plugin entry.
*
* The add-on mounts the release package's host half through the shared
* single-instance queue and installs this checkout's developer tools on the live
* services. It is an *overlay*: while the profile stops selecting the release
* bundle, the mounted half is torn down and the add-on waits, re-checking the
* manifest, so developer mode can never become the deployment on its own.
*
* The teardown goes through a child plugin fiber: everything `mountHost` registers
* belongs to that fiber, so disposing it unmounts exactly the host half — including
* the single-instance slot and any pending wait — without unloading this row.
* @param ctx - the plugin context (`tools`, `systemPrompt`, `agents` injected).
* @param config - the add-on row's config (announce, peer budget, worktree).
*/
function apply(ctx, config) {
	let fiber;
	let settling = false;
	function hostHalf(sub) {
		mountWhenFree(sub, () => {
			const host = mountHost(sub, config);
			sub.effect(() => installDevMode(sub, host.peers, host.service), "report-ledger-dev: developer mode");
		});
	}
	const stop = () => {
		if (fiber === void 0) return;
		settling = true;
		const stopping = fiber.dispose();
		fiber = void 0;
		stopping.finally(() => {
			settling = false;
		});
	};
	const start = () => {
		if (fiber !== void 0 || settling) return;
		fiber = ctx.plugin(hostHalf);
	};
	const tick = () => {
		if (releaseBundleSelected(ctx) === false) {
			if (fiber !== void 0) ctx.logger?.warn?.("report-ledger-dev: the dsh-report-ledger bundle is not selected; developer mode waits until it is enabled again.");
			stop();
			return;
		}
		start();
	};
	tick();
	const timer = setInterval(tick, MANIFEST_POLL_MS);
	ctx.effect(() => () => {
		clearInterval(timer);
		if (fiber !== void 0) {
			fiber.dispose();
			fiber = void 0;
		}
	}, "report-ledger-dev: manifest watch");
}
//#endregion
export { apply, inject, installDevMode };
