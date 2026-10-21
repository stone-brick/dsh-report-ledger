import { realpathNormalize } from "@deepseek-ai/dsh-workspace";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/report/deliver.ts
/**
* Delivery: getting a report digest into the right agent's context.
*
* The harness's own delegation seam only delivers between exact neighbours — a
* direct child or a direct parent that is currently resident — and it has no
* durable mailbox, so a message to an absent parent is refused rather than held.
* This module provides the missing half:
*
*  - **Any live agent is addressable.** It uses the `Agent`'s own
*    `steer`/`inject` entries, which take a message and no authority, rather than
*    the adjacency-checked delegation path. That is what makes a carbon copy to a
*    non-adjacent peer (or a sibling) possible at all.
*  - **An absent recipient is queued, not refused.** Nothing extra is stored for
*    that: a recipient is pending exactly when the transfer path records a
*    hand-off to it but no arrival. The audit trail *is* the mailbox, so it
*    survives a restart for free and cannot disagree with the history.
*  - **Wake policy is explicit.** An addressed report steers (an idle target
*    starts a turn), while a carbon copy injects context without waking anyone.
*
* @module dsh-report-ledger/report/deliver
*/
/**
* Build the message that carries a digest into a recipient's context.
*
* The text is intentionally compact: it is a transport notice, not the report.
* The body stays in the ledger and is opened on demand, which is what keeps a
* long-horizon collaboration affordable in context.
* @param front - the report digest.
* @param path - absolute path of the report document, offered as the on-demand body.
* @param mode - how this recipient received it.
* @returns the outbound message.
*/
function renderDigest(front, path, mode) {
	const audience = mode === "wakeup" ? "addressed to you" : "copied to you";
	const lines = [`[report ${front.report} — ${audience}] ${front.subject}`, `from=${front.from} status=${front.status} hops=${front.hops} authors=${front.authors.length}`];
	if (front.to.length > 0) lines.push(`to=${front.to.join(",")}`);
	if (front.cc.length > 0) lines.push(`cc=${front.cc.join(",")}`);
	if (front.task !== void 0) lines.push(`task=${front.task}`);
	if (front.artifacts.length > 0) lines.push(`artifacts=${front.artifacts.join(", ")}`);
	lines.push(`body=${path}`);
	lines.push(`Read the body on demand; use report_list to see other reports and report_ack to close your loop.`);
	return {
		id: randomUUID(),
		role: "user",
		content: [{
			type: "text",
			text: lines.join("\n")
		}],
		source: {
			kind: "plugin:report-ledger",
			form: "relay"
		}
	};
}
/**
* Deliver one digest to every target.
*
* Transport only: this function never touches the ledger. The caller records the
* arrival hops, which keeps the audit trail's writer in one place and lets the
* same transport serve a first hand-off and a deferred one.
* @param host - agent resolution.
* @param front - the report digest.
* @param path - absolute path of the report document.
* @param targets - recipient session ids.
* @param mode - wake policy for this hand-off.
* @returns one outcome per distinct target.
*/
async function deliver(host, front, path, targets, mode) {
	const outcomes = [];
	const seen = /* @__PURE__ */ new Set();
	for (const targetId of targets) {
		if (targetId === "" || seen.has(targetId)) continue;
		seen.add(targetId);
		const agent = host.getAgent(targetId);
		if (agent === void 0) {
			outcomes.push({
				targetId,
				status: "queued"
			});
			continue;
		}
		const message = renderDigest(front, path, mode);
		if (mode === "wakeup") agent.steer(message);
		else agent.inject(message);
		outcomes.push({
			targetId,
			status: "delivered"
		});
	}
	return outcomes;
}
/**
* Derive the set of recipients still owed a delivery.
*
* Pending is computed from the audit trail instead of a separate queue: every
* hop that addressed a target counts as a hand-off, every `delivered` hop counts
* as an arrival, and the difference is what remains. Deriving it this way means
* the mailbox is exactly as durable as the history, and a hand-edited ledger
* stays self-consistent.
* @param hops - the complete transfer path of one report.
* @returns session ids that were addressed but have no recorded arrival.
*/
function pendingTargets(hops) {
	const owed = /* @__PURE__ */ new Set();
	for (const hop of hops) {
		if (hop.action === "sent" || hop.action === "cc" || hop.action === "forwarded" || hop.action === "copied") for (const target of hop.to) owed.add(target);
		if (hop.action === "transferred") {
			if (hop.from !== void 0) owed.delete(hop.from);
			for (const target of hop.to) owed.add(target);
		}
		if (hop.action === "delivered") for (const target of hop.to) owed.delete(target);
	}
	return [...owed];
}
/**
* The wake policy of the hand-off a target is still owed.
*
* Decided per window, not by the last hop: if the target is owed even one
* **addressed** hand-off (`sent`/`forwarded`) that has not been answered by an
* arrival, the delivery must wake it. A later carbon copy must not downgrade
* that — the recipient would receive the digest but never run, which is
* indistinguishable from a dropped hand-off. Read the other way ("the latest
* addressing hop wins") a `sent` followed by a `cc` while the target is absent
* silently loses the wake, which is the same failure the mailbox exists to
* prevent. Arrivals close the window, so a `cc` after an answered send is quiet.
* @param hops - the report's complete transfer path, oldest first.
* @param target - the recipient that is pending.
* @returns `wakeup` when an unanswered addressed hand-off exists, else `quiet`.
*/
function pendingMode(hops, target) {
	let addressed = false;
	for (const hop of hops) {
		if (hop.action === "transferred") {
			if (hop.from === target) addressed = false;
			if (hop.to.includes(target)) addressed = true;
			continue;
		}
		if (!hop.to.includes(target)) continue;
		if (hop.action === "delivered") addressed = false;
		else if (hop.action === "sent" || hop.action === "forwarded") addressed = true;
	}
	return addressed ? "wakeup" : "quiet";
}
//#endregion
//#region src/report/guidance.ts
/** Heading that opens the delegated-agent branch; also the marker tests assert on. */
const DELEGATED_HEADING = "## 你当前是被委派的代理";
/**
* The capability statement: what the ledger is, which tools exist, and the two
* rules that change behaviour. Identical for every agent.
*/
const PROTOCOL = [
	"本机已安装 dsh-report-ledger 插件（汇报账本）：在代理之间传递工作、结论与决策的持久、可追溯通道。",
	"",
	"结构：front matter 是缩略（主题、收发、抄送、共写者、跳数），进入上下文很便宜；正文留在账本里按需读取。",
	"账本落盘在 $DSH_HOME/report-ledger/，跨会话与项目长期可追溯。",
	"",
	"工具：",
	"- report_author —— 开一份汇报（to 主送、cc 抄送），用 parent 关联你在答复的上一份汇报。",
	"- report_contribute —— 以共同作者身份为别人开的汇报追加自己的一节，互不覆盖。",
	"- report_send —— 主送给更多代理（唤醒对方）：向上回报、向下派发都用它。",
	"- report_cc —— 抄送给更多代理（不唤醒）：让需要知情者持有副本。",
	"- report_forward —— 把汇报转呈下去；mode:\"copy\" 作为参考副本分发。两者都记录跳。",
	"- report_read —— 读缩略、完整传递路径（每一跳的人与时间）与正文。",
	"- report_list —— 只列缩略；用 session 过滤看某位同伴相关的全部汇报，用 task 把同一次协作跨会话拉到一起（部分匹配、不区分大小写）。",
	"- report_ack —— 回执：确认已收到并处理，让发送方看到闭环（事情仍在进行时用它）。",
	"- report_amend —— 修正：改错的主题／任务标签／产物，或更正正文。**只有发起者或共写者**能改；正文默认是**追加**一段更正，明确要求（replace_body）才会整段替换，两种都会在传递路径里留下记录。",
	"- report_close —— 结案：事情做完了才用它，且**只有发起者或共写者**能关；之后任何贡献／主送／抄送／转呈都会自动重开并记录。结案同时**释放**它持有的工作区（见下）。",
	"- report_release —— 交还工作区：工作做完了但对话没结束、想让出检出时用它。检出原样留在磁盘上，结束的只是\"占用\"。",
	"- report_lease —— 认领一个**已存在**的检出（人手建的、上一份汇报留下的、或你要接手的）：与 report_release 互为反向。分支从检出本身读出，所以只有想强制校验时才传 branch。",
	"- report_transfer —— 把一笔**尚未送达**的投递从欠它的会话转给另一个会话：义务仍然存在，只是换了人欠；它**不是**送达，也不撤销历史。",
	"- report_handover —— 退役/接管一个会话的下属资产：先枚举未结汇报、检出占用与待送达，再能搬的搬、能关的关，并落一份 `task: handover` 记录。",
	"- peer_list —— 列出你能对话的代理（上级、下属、兄弟、你开启的同伴、账本里有往来的联系人），并标注谁此刻在线。",
	"- peer_start —— 开启一个**独立同伴会话**（不是下属）：它有自己的生命周期、比你活得更久；任务会作为一份汇报交给它。",
	"",
	"工作区（若本部署启用）：peer_start / report_author 加 worktree:true，会为该汇报分配一个**独立的 git 检出**，分支名形如 dsh/R-0007-<主题>。",
	"独立的只有**工作目录与索引**；config、hooks、对象库、以及机器上一切检出之外的东西都是**共享**的——装一个 hook 或改一项配置，会影响所有检出里每一次提交。",
	"一个分支同一时刻只能被一个检出占用，所以它同时也是一把锁：认领已有检出用 report_lease，交还用 report_release，结案会自动交还。被占用时会明确告诉你占用者是谁。",
	"",
	"六条行为约定：",
	"1. 收件方不在线不是错误。投递由账本持有，等该会话重新驻留时自动送达；不要因为对方此刻不在就放弃交接、或改为自己扛下。",
	"2. 传递路径（含每一份抄送与副本）由账本自动记录，不需要你手工维护——但每一步都必须经工具完成，绕过工具的口信不会进入路径。",
	"3. **一份汇报不断累积 contribution 就是你们之间的对话线程。** 多轮交流不必另开通道：把每一轮追加进同一份汇报，共写者与传递路径都会自动记录，日后可完整回放。",
	"4. 回执（report_ack）与结案（report_close）是两件事：回执表示\"我收到了\"，结案表示\"这件事结束了\"。别用回执代替结案，也别把还在推进的汇报关掉——真关了也安全，后续活动会自动重开。",
	"5. **写错了就用 report_amend 修正，不要重开一份新汇报**——重开会丢掉原有的传递路径与收件人。改错别怕留痕：修正会被记成一跳，附上改前改后的值，这正是账本该有的样子。",
	"6. **会话或网络中断后，先对账再继续，不要从头重做。** 用 report_list / peer_list 找到最后落下的跳、谁已交付、谁还在线；把汇报正文、任务标签与传递路径当作检查点。断点若在写操作中间，先读回半完成状态再决定重试或回滚；重试投递或创建前，先确认它是否已经落地。"
].join("\n");
/**
* Describe one assembly's reader.
*
* @param context - the assembly context; `agent` is absent on diagnostics.
* @returns `'delegated'` for a subagent child, `'root'` otherwise.
*/
function roleOf(context) {
	const agent = context.agent;
	if (agent === void 0) return "root";
	const header = agent.session?.header;
	if (header === void 0) return "root";
	if (header.origin === "subagent") return "delegated";
	return (header.delegationDepth ?? 0) > 0 ? "delegated" : "root";
}
/**
* The session this agent reports to, when it is a delegated child.
* @param context - the assembly context.
* @returns the parent session id, or `undefined`.
*/
function parentOf(context) {
	if (roleOf(context) !== "delegated") return void 0;
	const parent = context.agent?.session?.header?.parentSession;
	return typeof parent === "string" && parent !== "" ? parent : void 0;
}
/** The part of the contract that does not depend on the reader's role. */
const PARTNERSHIP_COMMON = [
	"## 你与其他代理的关系",
	"",
	"其他代理不是「做完一项任务就可以终止的工具」，而是长期相处的同伴：他们各有持久会话，会记住你交给他们的事，也值得你把上下文交接清楚。",
	"",
	"- 交接用汇报，不要只用一句口信。口信读完即忘；汇报留在账本里，日后可追溯、可抄送、可转呈。",
	"- 派出任务后默认对方会继续存在。一次任务的结束（settlement）是这段关系的逗号而不是句号——你随时可以再派活、追问，或把新结论同步给它。",
	"- 收到汇报就回执（report_ack）。发送方无法从「对方在忙」推断出「对方已知情」，回执是唯一确定的闭环信号。",
	"- 需要让人知情但不必打扰时用 report_cc：它进入对方上下文但不唤醒对方。同伴之间不必只有上下级通信，兄弟代理之间也可以互相抄送。",
	"- 向上说明、向下派发、或把一份汇报转给另一条线时，用 report_send / report_forward，不要重写一份新汇报而丢掉原有的传递路径。",
	"- 工作区那两个工具是**部署相关**的：本部署若没有启用 git 检出支持，`report_lease` 根本不存在，`report_release` 也没有对象可交还——不要把它当成坏掉的工具去反复重试。",
	"- 不必猜谁在场：peer_list 会告诉你有哪些代理、各自与你的关系、以及谁此刻在线。要找一个能长期共事的伙伴（而不是一次性的下属），用 peer_start 开启一个独立会话——它有自己的生命周期，会比你活得更久。"
].join("\n");
/** The branch only a delegated agent needs to read. */
function delegatedBranch(parent) {
	const parentLine = parent === void 0 ? "- 你可以把汇报主送（report_send）给你的父代理；父会话 id 见你的运行上下文。" : `- 你的父会话 id 是 ${parent}，可以直接 report_send 到它。`;
	return [
		DELEGATED_HEADING,
		"",
		"- 你的会话是持久的，不是一次性的函数调用。完成任务后你仍会存在并接受后续消息，所以要把状态与结论留在汇报里，而不是留在即将消失的上下文里。",
		"- 主动汇报，不要默默结束。出现以下任一情况就向上汇报：任务有结论；遇到阻塞或权限不足；发现范围外但你判断重要的风险；需要多份工作汇合。",
		parentLine,
		"  若父代理此刻不在线，投递会被账本持有，等它回来自动送达——不必因此放弃汇报，也不必反复重试。",
		"- 你的权限范围在启动时已固定，无法在会话内自行放宽。需要越界时不要反复重试同一操作，把限制写进汇报交给上级处理。"
	].join("\n");
}
/**
* Build the partnership section text for one assembly.
* @param context - the assembly context.
* @returns the section text: the shared contract, plus the delegated-agent branch when it applies.
*/
function partnershipText(context) {
	if (roleOf(context) === "root") return PARTNERSHIP_COMMON;
	return `${PARTNERSHIP_COMMON}\n\n${delegatedBranch(parentOf(context))}`;
}
//#endregion
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
* `reclaimed` records that the ledger cleared a checkout away — whether to stay
* within its retained budget or because the owner asked for it at closing time;
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
* Split a document into its YAML front matter and body.
*
* The opening fence must be the very first line. A BOM and CRLF line endings are
* tolerated: both are normalized away before parsing, because a Windows editor
* saves CRLF by default and the YAML parser refuses a document whose last line
* is terminated by a lone `\r` — which is exactly what a CRLF file's final
* front-matter line looks like once the block has been joined. Getting this
* wrong made a hand-edited report invisible rather than merely misformatted.
* Importing the fence from an indented position is not accepted, so a body that
* happens to start with a horizontal rule is never mistaken for metadata.
* @param raw - the file text.
* @returns the parsed mapping, the body, and the body's first line, or `undefined` when there is no front matter.
*/
function splitFrontMatter(raw) {
	const lines = (raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw).replace(/\r\n?/g, "\n").split("\n");
	if (lines[0] !== FENCE) return void 0;
	let close = -1;
	for (let index = 1; index < lines.length; index++) if (lines[index] === FENCE) {
		close = index;
		break;
	}
	if (close < 0) return void 0;
	const yamlText = lines.slice(1, close).join("\n");
	let parsed;
	try {
		parsed = parse(yamlText, { uniqueKeys: false });
	} catch {
		return;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return void 0;
	const bodyLines = lines.slice(close + 1);
	let lead = 0;
	while (lead < bodyLines.length && bodyLines[lead] === "") lead++;
	return {
		data: parsed,
		body: bodyLines.join("\n").replace(/^\n/, ""),
		bodyLine: close + 2 + lead
	};
}
/** Read a string field, tolerating numbers and quoteless scalars. */
function str$2(value) {
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
		const text = str$2(item);
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
	const path = str$2(record.path);
	if (path === void 0) return void 0;
	const branch = str$2(record.branch);
	const head = str$2(record.head);
	const repo = str$2(record.repo);
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
	const report = str$2(data.report) ?? str$2(data.id);
	if (report === void 0) return void 0;
	const statusText = str$2(data.status);
	const status = REPORT_STATUSES.find((candidate) => candidate === statusText) ?? "open";
	const created = time(data.created, 0);
	const updated = time(data.updated, created);
	const worktree = toWorktree(data.worktree);
	const lastRaw = data.last;
	let last;
	if (lastRaw !== null && typeof lastRaw === "object" && !Array.isArray(lastRaw)) {
		const record = lastRaw;
		const actionText = str$2(record.action);
		const action = HOP_ACTIONS.find((candidate) => candidate === actionText);
		const actor = str$2(record.actor);
		if (action !== void 0 && actor !== void 0) last = {
			at: time(record.at, updated),
			action,
			actor
		};
	}
	return {
		report,
		subject: str$2(data.subject) ?? "(no subject)",
		status,
		from: str$2(data.from) ?? "unknown",
		...str$2(data.fromName) === void 0 ? {} : { fromName: str$2(data.fromName) },
		to: strList(data.to),
		cc: strList(data.cc),
		authors: strList(data.authors),
		created,
		updated,
		...str$2(data.parent) === void 0 ? {} : { parent: str$2(data.parent) },
		children: strList(data.children),
		...str$2(data.task) === void 0 ? {} : { task: str$2(data.task) },
		...worktree === void 0 ? {} : { worktree },
		artifacts: strList(data.artifacts),
		hops: num(data.hops) ?? 0,
		...last === void 0 ? {} : { last },
		...str$2(data.spill) === void 0 ? {} : { spill: str$2(data.spill) }
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
/**
* Render the digest as a YAML mapping in a fixed key order.
*
* Absent optional fields are omitted rather than written as nulls, so a report
* file stays readable and cheap to diff.
* @param front - the normalized front matter.
* @returns the YAML text (without fences).
*/
function frontMatterYaml(front) {
	const ordered = {
		report: front.report,
		subject: front.subject,
		status: front.status,
		from: front.from
	};
	if (front.fromName !== void 0) ordered.fromName = front.fromName;
	ordered.to = [...front.to];
	ordered.cc = [...front.cc];
	ordered.authors = [...front.authors];
	ordered.created = front.created;
	ordered.updated = front.updated;
	if (front.parent !== void 0) ordered.parent = front.parent;
	ordered.children = [...front.children];
	if (front.task !== void 0) ordered.task = front.task;
	if (front.worktree !== void 0) ordered.worktree = {
		path: front.worktree.path,
		...front.worktree.branch === void 0 ? {} : { branch: front.worktree.branch },
		...front.worktree.head === void 0 ? {} : { head: front.worktree.head },
		...front.worktree.repo === void 0 ? {} : { repo: front.worktree.repo },
		...front.worktree.allocated === void 0 ? {} : { allocated: front.worktree.allocated }
	};
	ordered.artifacts = [...front.artifacts];
	ordered.hops = front.hops;
	if (front.last !== void 0) ordered.last = {
		at: front.last.at,
		action: front.last.action,
		actor: front.last.actor
	};
	if (front.spill !== void 0) ordered.spill = front.spill;
	return stringify(ordered, {
		lineWidth: 0,
		defaultStringType: "QUOTE_DOUBLE",
		defaultKeyType: "PLAIN"
	});
}
/**
* Serialize one report to its on-disk document form.
* @param report - the report.
* @returns the complete file text.
*/
function serializeReport(report) {
	const body = report.body.endsWith("\n") || report.body === "" ? report.body : `${report.body}\n`;
	return `${FENCE}\n${frontMatterYaml(report.front)}${FENCE}\n\n${body}`;
}
/**
* Parse one hop from its JSONL record.
*
* Hops are the audit trail, so a malformed line is skipped rather than allowed
* to poison the rest of the path.
* @param raw - one line of the route sidecar.
* @returns the hop, or `undefined` when the record is unusable.
*/
function parseHop(raw) {
	const text = raw.trim();
	if (text === "") return void 0;
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
	const record = value;
	const actionText = str$2(record.action);
	const action = HOP_ACTIONS.find((candidate) => candidate === actionText);
	const actor = str$2(record.actor);
	if (action === void 0 || actor === void 0) return void 0;
	const from = str$2(record.from);
	const note = str$2(record.note);
	const actorName = str$2(record.actorName);
	return {
		at: time(record.at, 0),
		actor,
		action,
		to: strList(record.to),
		...actorName === void 0 ? {} : { actorName },
		...from === void 0 ? {} : { from },
		...note === void 0 ? {} : { note }
	};
}
//#endregion
//#region src/report/ledger.ts
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
const REPORT_ID$1 = /^R-(\d{4,})$/;
/** Report file name shape. */
const REPORT_FILE = /^R-(\d{4,})\.md$/;
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
* Absolute path of one report's transfer-path sidecar.
* @param id - report identifier.
* @returns the path.
*/
function routePath(id) {
	return join(reportsDir(), `${id}.route.jsonl`);
}
/**
* Whether a string is a well-formed report identifier.
* @param id - candidate identifier.
* @returns true when it matches the ledger's id shape.
*/
function isValidReportId(id) {
	return REPORT_ID$1.test(id);
}
/** Create the ledger directories if they do not exist yet. */
async function ensureDirs() {
	await mkdir(reportsDir(), { recursive: true });
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
async function allocateId() {
	await ensureDirs();
	let highest = 0;
	for (const name of await readdir(reportsDir())) {
		const match = REPORT_FILE.exec(name);
		if (match === null) continue;
		const value = Number(match[1]);
		if (Number.isFinite(value) && value > highest) highest = value;
	}
	for (let attempt = 0; attempt < 64; attempt++) {
		const candidate = `R-${String(highest + 1 + attempt).padStart(4, "0")}`;
		const path = reportPath(candidate);
		try {
			await writeFile(path, "", { flag: "wx" });
			return candidate;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
	}
	throw new Error("report-ledger: could not allocate a report id after 64 attempts");
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
const TRANSIENT_RENAME_CODES = /* @__PURE__ */ new Set([
	"EPERM",
	"EBUSY",
	"EACCES"
]);
/**
* Rename, retrying briefly on a transient Windows sharing violation.
* @param from - the temp file.
* @param to - the report document.
*/
async function renameWithRetry(from, to) {
	for (let attempt = 0;; attempt++) try {
		await rename(from, to);
		return;
	} catch (error) {
		const code = error.code;
		if (attempt >= 2 || code === void 0 || !TRANSIENT_RENAME_CODES.has(code)) throw error;
		await new Promise((resolve) => setTimeout(resolve, 10 + attempt * 10));
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
async function writeReport(report, id = report.front.report) {
	if (!isValidReportId(id)) throw new Error(`report-ledger: ${JSON.stringify(id)} is not a usable report id`);
	await ensureDirs();
	const target = reportPath(id);
	const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
	const front = report.front.report === id ? report.front : {
		...report.front,
		report: id
	};
	try {
		await writeFile(temp, serializeReport({
			front,
			body: report.body
		}), "utf8");
		await renameWithRetry(temp, target);
	} finally {
		await unlink(temp).catch(() => void 0);
	}
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
			front: parsed.front,
			body: parsed.body
		};
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw error;
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
async function bodyStartLine(id) {
	if (!isValidReportId(id)) return void 0;
	let raw;
	try {
		raw = await readFile(reportPath(id), "utf8");
	} catch {
		return;
	}
	return splitFrontMatter(raw)?.bodyLine;
}
/**
* Append one hop to a report's transfer path.
*
* Append-only by construction: the audit trail is never rewritten, so a
* concurrent reader sees a prefix of hops rather than a torn file.
* @param id - report identifier.
* @param hop - the hop to record.
*/
async function appendHop(id, hop) {
	if (!isValidReportId(id)) throw new Error(`report-ledger: invalid report id ${JSON.stringify(id)}`);
	await ensureDirs();
	await appendFile(routePath(id), `${JSON.stringify(hop)}\n`, "utf8");
}
/**
* Read the complete transfer path of a report.
* @param id - report identifier.
* @returns every readable hop, oldest first.
*/
async function readHops(id) {
	if (!isValidReportId(id)) return [];
	let raw;
	try {
		raw = await readFile(routePath(id), "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	const hops = [];
	for (const line of raw.split("\n")) {
		const hop = parseHop(line);
		if (hop !== void 0) hops.push(hop);
	}
	return hops;
}
/** Read only the digest of one report document. */
async function readDigest(id) {
	return (await readReport(id))?.front;
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
async function listReports() {
	await ensureDirs();
	const digests = [];
	for (const name of await readdir(reportsDir())) {
		const match = REPORT_FILE.exec(name);
		if (match === null) continue;
		const id = `R-${match[1]}`;
		try {
			const digest = await readDigest(id);
			if (digest !== void 0) digests.push({
				...digest,
				report: id
			});
		} catch {}
	}
	digests.sort((left, right) => right.updated - left.updated || right.report.localeCompare(left.report));
	return digests;
}
/**
* Whether a report document exists on disk.
* @param id - report identifier.
* @returns true when the document exists.
*/
function reportExists(id) {
	return isValidReportId(id) && existsSync(reportPath(id));
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
async function discardUnwrittenId(id) {
	if (!isValidReportId(id)) return false;
	const path = reportPath(id);
	try {
		if (await readFile(path, "utf8") !== "") return false;
	} catch {
		return false;
	}
	try {
		await unlink(path);
		return true;
	} catch {
		return false;
	}
}
//#endregion
//#region src/report/worktree.ts
/**
* Git worktree adapter.
*
* The ledger records *intent*; git records *reality*. This module is the whole
* of the second half: it shells out to `git`, reads `git worktree list`, and
* decides nothing. Every policy question — which report may hold a branch, when
* a lease may be reclaimed, what to do when the two layers disagree — belongs to
* the service layer, because answering it needs the ledger. This module must
* stay usable and testable without one.
*
* Four deliberate choices:
*
*  - **Shell out, never reimplement.** Git's occupancy check, its refusal to
*    remove an unclean tree, and its `repair` are the authority. A weaker
*    reimplementation in TypeScript would be a second source of truth about the
*    same bytes, which is the exact failure this plugin exists to avoid.
*  - **No `--force`, anywhere.** Neither {@link addWorktree} nor
*    {@link removeWorktree} exposes a force flag, so no caller can acquire the
*    ability to discard uncommitted work or to claim a branch git says is taken.
*    A safeguard can only be overridden by a human running git, deliberately.
*  - **`--porcelain -z` for parsing.** The non-`-z` form escapes unusual
*    characters and quotes paths containing them, so a parser for it must
*    reimplement git's C-style quoting. The `-z` form emits raw NUL-separated
*    fields, which makes parsing a split rather than an unescape.
*  - **Paths stay native, comparison normalizes.** Git prints forward slashes
*    even on Windows while the harness hands us backslashes. Rather than pick a
*    dialect everywhere, stored paths keep the form the OS uses and
*    {@link compareKey} is the single place that decides when two spellings name
*    one file.
*
* @module dsh-report-ledger/report/worktree
*/
/** Directory name, under a repository's parent, that holds ledger-allocated worktrees. */
const WORKTREE_DIR = ".dsh-worktrees";
/** Default timeout for one git invocation. */
const GIT_TIMEOUT_MS = 3e4;
/** Exit status used for a failure that never reached git (a missing binary). */
const NOT_EXECUTED = -1;
/**
* Recognized refusals, most specific first.
*
* Every pattern is copied from a message observed from git 2.49 on Windows.
* Matching on prose is brittle by nature, so the classifier exists only to let
* the caller choose a *remedy*; the raw stderr is always passed through
* unchanged, and `unknown` is a correct answer rather than a failure.
*
* Order carries meaning. `a branch named 'x' already exists` and `'<path>'
* already exists` are different problems with different remedies — reuse or
* rename the branch, versus choose another directory — and git words both with
* "already exists", so the branch form has to be recognized before the generic
* one or every name collision looks like a full directory.
*/
const REFUSALS = [
	["branch-in-use", /is already used by worktree at/i],
	["branch-exists", /a branch named .* already exists/i],
	["missing-but-registered", /is a missing but already registered worktree/i],
	["main-working-tree", /is a main working tree|cannot be locked or unlocked/i],
	["locked", /cannot remove a locked working tree/i],
	["unclean", /contains modified or untracked files/i],
	["path-exists", /already exists/i]
];
/**
* Run one git command and capture its result without throwing.
*
* The ledger treats a git refusal as information, not as an exception: "this
* branch is taken" is a normal answer that has to reach a model as a sentence.
* So this returns the exit status instead of rejecting, and a binary that cannot
* be run at all is reported the same way rather than as a crash.
* @param cwd - directory to run in.
* @param args - arguments after the program name.
* @returns the exit status and both streams.
*/
async function runGit(cwd, args) {
	return await new Promise((settle) => {
		execFile("git", [...args], {
			cwd,
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: 8 * 1024 * 1024,
			windowsHide: true
		}, (error, stdout, stderr) => {
			const raw = error?.code;
			const out = typeof stdout === "string" ? stdout : "";
			const err = typeof stderr === "string" ? stderr : "";
			settle({
				ok: error === null,
				code: error === null ? 0 : typeof raw === "number" ? raw : NOT_EXECUTED,
				stdout: out,
				stderr: err === "" ? error?.message ?? "" : err
			});
		});
	});
}
/**
* Read the installed git version.
* @param cwd - directory to run in; defaults to the current directory.
* @returns the version line, or `undefined` when git is unavailable.
*/
async function gitVersion(cwd) {
	const result = await runGit(cwd ?? process.cwd(), ["--version"]);
	return result.ok ? result.stdout.trim() : void 0;
}
/**
* Whether a git version supports `git worktree add --relative-paths`.
*
* Worth asking before using the flag, because it is not merely cosmetic: it
* implies the `extensions.relativeWorktrees` repository format extension, so
* turning it on raises `core.repositoryformatversion` to 1 and older git
* installations refuse to touch the repository at all.
* @param version - a `git --version` line.
* @returns true when the version is 2.48 or newer.
*/
function supportsRelativePaths(version) {
	const match = /(\d+)\.(\d+)/.exec(version);
	if (match === null) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 2 || major === 2 && minor >= 48;
}
/**
* Why the `relativePaths` option cannot be honoured on this host, if it cannot.
*
* Exists because the gate has to be *asked*: the flag only exists from git
* 2.48, and passing it to an older git fails every single allocation with
* `unknown option 'relative-paths'` — a refusal that is correct but arrives
* after the work has started, and says nothing about the one-line fix. Asking
* first turns that into a sentence naming the version and the remedy.
* @param version - a `git --version` line, or `undefined` when git could not be
* asked at all.
* @returns `undefined` when the option is supported, otherwise the reason.
*/
function relativePathsRefusal(version) {
	if (version === void 0) return "the relativePaths option needs git 2.48 or newer, and git could not be asked for its version";
	if (supportsRelativePaths(version)) return void 0;
	return `the relativePaths option needs git 2.48 or newer, and this host reports "${version.trim()}"`;
}
/**
* Locate the repository a directory belongs to.
*
* Answers `undefined` rather than throwing when the directory is not in a
* repository, because "not a repository" is the ordinary answer for the many
* sessions that never touch one, and the caller must be able to ask cheaply.
* @param cwd - a directory inside the repository (or the repository itself).
* @returns the location, or `undefined` when this is not a git repository.
*/
async function resolveRepo(cwd) {
	if (cwd.trim() === "") return void 0;
	const common = await runGit(cwd, ["rev-parse", "--git-common-dir"]);
	if (!common.ok) return void 0;
	const reported = common.stdout.trim();
	if (reported === "") return void 0;
	const commonDir = normalize(resolve(cwd, reported));
	const bare = (await runGit(cwd, ["rev-parse", "--is-bare-repository"])).stdout.trim() === "true";
	const repoRoot = bare ? commonDir : dirname(commonDir);
	const repoParent = dirname(repoRoot);
	const repoName = basename(repoRoot).replace(/\.git$/i, "") || "repo";
	return {
		commonDir,
		repoRoot,
		repoParent,
		repoName,
		bare,
		worktreeRoot: join(repoParent, WORKTREE_DIR, repoName)
	};
}
/** Strip `refs/heads/` so a branch is named the way every other layer names it. */
function shortBranch(ref) {
	return ref.startsWith("refs/heads/") ? ref.slice(11) : ref;
}
/**
* Parse `git worktree list --porcelain -z` output.
*
* In the `-z` form every field is NUL-terminated and a record ends at an empty
* field, so a record boundary is a split on `\0` that yields `''`. Fields are
* `key value`, or a bare `key` for a boolean one (`detached`, `bare`) and for a
* flag whose reason is optional (`locked`, `prunable`).
* @param raw - the command's standard output.
* @returns one entry per record that carried a path.
*/
function parseWorktreeList(raw) {
	const entries = [];
	let fields = /* @__PURE__ */ new Map();
	const flush = () => {
		const path = fields.get("worktree");
		if (path !== void 0 && path !== "") {
			const head = fields.get("HEAD");
			const branchRef = fields.get("branch");
			const lockReason = fields.get("locked");
			const prunableReason = fields.get("prunable");
			entries.push({
				path: normalize(path),
				detached: fields.has("detached"),
				bare: fields.has("bare"),
				locked: fields.has("locked"),
				prunable: fields.has("prunable"),
				...head === void 0 || head === "" ? {} : { head },
				...branchRef === void 0 || branchRef === "" ? {} : { branch: shortBranch(branchRef) },
				...lockReason === void 0 || lockReason === "" ? {} : { lockReason },
				...prunableReason === void 0 || prunableReason === "" ? {} : { prunableReason }
			});
		}
		fields = /* @__PURE__ */ new Map();
	};
	for (const field of raw.split("\0")) {
		if (field === "") {
			flush();
			continue;
		}
		const space = field.indexOf(" ");
		if (space < 0) fields.set(field, "");
		else fields.set(field.slice(0, space), field.slice(space + 1));
	}
	flush();
	return entries;
}
/**
* List every working tree of a repository.
* @param repo - the repository.
* @returns one entry per working tree, main worktree first.
* @throws when git itself cannot be asked.
*/
async function listWorktrees(repo) {
	const result = await runGit(repo.commonDir, [
		"worktree",
		"list",
		"--porcelain",
		"-z"
	]);
	if (!result.ok) throw new Error(`report-ledger: git worktree list failed: ${result.stderr.trim() || `exit ${result.code}`}`);
	return parseWorktreeList(result.stdout);
}
/**
* Map each branch to the entry currently holding it.
*
* Prunable entries are skipped deliberately. Their working tree is gone, so they
* do not actually hold anything — which is precisely why a stale entry must not
* be allowed to block reuse forever, and why the same list yields two different
* answers depending on the question being asked.
* @param entries - entries from {@link listWorktrees}.
* @returns branch name to holding entry.
*/
function branchHolders(entries) {
	const holders = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		if (entry.branch === void 0 || entry.prunable) continue;
		if (!holders.has(entry.branch)) holders.set(entry.branch, entry);
	}
	return holders;
}
/**
* Whether a working tree has no modification, no staged change and no untracked
* file.
*
* Untracked files count as dirty on purpose: they are exactly what `git worktree
* remove` refuses to delete, so a check that ignored them would authorize a
* removal git then rejects.
* @param worktreePath - the working tree to inspect.
* @returns true only when git confirms a clean tree; a failure to ask answers
* false, because an unreadable tree must never be treated as safe to delete.
*/
async function isWorktreeClean(worktreePath) {
	const result = await runGit(worktreePath, ["status", "--porcelain"]);
	if (!result.ok) return false;
	return result.stdout.trim() === "";
}
/**
* Read the commit a working tree is on.
* @param worktreePath - the working tree to inspect.
* @returns the object id, or `undefined` for an unborn branch or a failure.
*/
async function headOf(worktreePath) {
	const result = await runGit(worktreePath, ["rev-parse", "HEAD"]);
	if (!result.ok) return void 0;
	const sha = result.stdout.trim();
	return /^[0-9a-f]{40,64}$/.test(sha) ? sha : void 0;
}
/**
* Ask git what is at a recorded path.
*
* The single place that answers "is this still a checkout", so reclamation and
* the maintenance view cannot disagree about it. A failure to *ask* is answered
* as `worktree`: calling a checkout stale on a broken subprocess would hand the
* caller a licence to delete something no one managed to look at.
* @param worktreePath - the recorded path.
* @returns the reality, classified.
*/
async function inspectCheckout(worktreePath) {
	if (!existsSync(worktreePath)) return { presence: "missing" };
	const repo = await resolveRepo(worktreePath);
	if (repo === void 0) return { presence: "not-a-worktree" };
	let entries;
	try {
		entries = await listWorktrees(repo);
	} catch {
		return {
			presence: "worktree",
			repo
		};
	}
	const entry = entries.find((candidate) => samePath(candidate.path, worktreePath));
	if (entry === void 0 || entry.prunable) return {
		presence: "not-a-worktree",
		repo
	};
	return {
		presence: "worktree",
		...entry.branch === void 0 ? {} : { branch: entry.branch },
		repo
	};
}
/**
* Whether a repository uses submodules.
*
* Git's own manual is explicit that multiple checkouts are experimental and that
* support for submodules is incomplete — a linked worktree containing submodules
* cannot even be moved. So this is a gate the caller is expected to consult
* before allocating, not a warning to print afterwards.
*
* A bare repository answers false: the answer is derived from the working tree's
* `.gitmodules`, which a bare repository does not have.
* @param repo - the repository.
* @returns true when `.gitmodules` exists in the main working tree.
*/
function hasSubmodules(repo) {
	if (repo.bare) return false;
	return existsSync(join(repo.repoRoot, ".gitmodules"));
}
/**
* Attach a linked working tree.
*
* There is no force flag: git's occupancy check and its refusal of an unclean
* path are returned to the caller as results, never overridden. A refusal is
* data the ledger turns into a sentence naming a remedy.
* @param input - what to create or check out.
* @returns the git result; the caller decides whether a refusal is fatal.
*/
async function addWorktree(input) {
	const args = ["worktree", "add"];
	if (input.relativePaths === true) args.push("--relative-paths");
	if (input.checkoutExisting === true) args.push(input.path, input.branch);
	else args.push("-b", input.branch, input.path, input.base);
	return await runGit(input.repo.commonDir, args);
}
/**
* Remove a linked working tree.
*
* Deliberately without a force option. Git refuses when the tree is unclean or
* locked, and that refusal is the last line of defence for work no one has
* committed; exposing `--force` here would turn a policy mistake in the ledger
* into silent data loss. A human who truly wants the tree gone can run the
* command themselves, which is the correct amount of friction.
* @param repo - the repository the tree belongs to.
* @param worktreePath - the working tree to remove.
* @returns the git result; a refusal is data, not an exception.
*/
async function removeWorktree(repo, worktreePath) {
	return await runGit(repo.commonDir, [
		"worktree",
		"remove",
		worktreePath
	]);
}
/**
* Classify a git refusal so the caller can name a remedy.
* @param stderr - the command's standard error.
* @returns the recognized kind, or `'unknown'`.
*/
function classifyGitRefusal(stderr) {
	for (const [kind, pattern] of REFUSALS) if (pattern.test(stderr)) return kind;
	return "unknown";
}
/** Strip a trailing separator without ever eating a root. */
function stripTrailingSeparators(path) {
	if (/^[a-zA-Z]:[\\/]$/.test(path)) return path;
	if (/^[\\/]{1,2}$/.test(path)) return path;
	return path.replace(/[\\/]+$/, "");
}
/**
* Reduce a path to the string two spellings are compared by.
*
* The single place that decides when two paths name one file. Windows compares
* case-insensitively and treats either separator as a separator; a POSIX host
* does neither, so the rule is the host's rather than a lowest common
* denominator — comparing case-insensitively on Linux would merge two directories
* git considers distinct.
* @param path - a path, absolute or relative to the current directory.
* @returns the comparison key.
*/
function compareKey(path) {
	const absolute = stripTrailingSeparators(normalize(resolve(path)));
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
/**
* Whether two paths name the same file.
* @param left - one path.
* @param right - another path.
* @returns true when they share a comparison key.
*/
function samePath(left, right) {
	return compareKey(left) === compareKey(right);
}
//#endregion
//#region src/report/lease.ts
/**
* The working-tree lease referee.
*
* A lease answers one question: may *this* report work in *that* checkout? The
* answer needs two authorities, and this module consults both.
*
*  - **The ledger knows intent.** It can say which report claims a branch, and
*    therefore name the agent to talk to. Git cannot: it reports a path, and a
*    path is not a colleague.
*  - **Git knows reality.** It can say which working tree actually has a branch
*    checked out. The ledger cannot: a checkout a human made by hand never
*    appears in it.
*
* Neither is sufficient, and when they disagree the disagreement is reported
* rather than resolved — a ledger that silently overrode git would be lying
* about the filesystem, and one that silently deferred to git would lose the
* only party who can be asked to let go.
*
* **Lease liveness is derived from the hop stream, never stored as a flag.** The
* digest is a cache of current state, and `leased`/`released` hops are the
* authority for whether a claim is still held — the same shape as
* `pendingTargets`, which derives the durable mailbox from hops rather than
* recording it. The binding itself *does* persist in the digest after release,
* because a working tree kept on disk must still be traceable back to the report
* that made it.
*
* @module dsh-report-ledger/report/lease
*/
/**
* Derive lease liveness from the authoritative hop stream.
* @param hops - a report's hops, oldest first.
* @returns the current lease state.
*/
function leaseState(hops) {
	let state = "none";
	for (const hop of hops) if (hop.action === "leased") state = "held";
	else if (hop.action === "released") state = "released";
	else if (hop.action === "reclaimed") state = "reclaimed";
	return state;
}
/**
* Whether two bindings name the same claim.
*
* Two rules, in order, because a checkout has two identities and they differ in
* scope:
*
*  - **The path is the checkout's identity.** Two reports cannot work in one
*    directory, whatever branch each of them believes it is on — and a binding
*    whose branch is stale (the holder checked something else out) must not open
*    a second report's road into that directory. Nothing is more local than a
*    directory, so this rule needs no further context.
*  - **A branch is the claim's identity only inside one repository.** Branch
*    names are repository-local, so `main` in this repository and `main` in
*    another are two different branches that happen to share a spelling.
*    Comparing only the name would refuse a legitimate claim and name a
*    colleague in another project as the holder.
*
* With no branch on one side, and no shared repository to compare, there is no
* claim identity left to assert: two detached trees at different paths are not
* the same claim.
* @param left - one binding.
* @param right - another binding.
* @returns true when they are the same claim.
*/
function sameClaim(left, right) {
	if (samePath(left.path, right.path)) return true;
	if (left.repo !== void 0 && right.repo !== void 0 && !samePath(left.repo, right.repo)) return false;
	if (left.branch !== void 0 && right.branch !== void 0) return left.branch === right.branch;
	return false;
}
/** The claimed name in prose: the branch when there is one, else the path. */
function claimName(binding) {
	return binding.branch ?? `${binding.path} (detached)`;
}
/**
* Decide whether a claim may be taken.
*
* Git is consulted before the ledger on purpose. Accusing a colleague of holding
* something that turns out not to exist is a worse answer than "there is no such
* checkout", and the ledger layer is only meaningful once the thing being
* claimed is real.
* @param query - the claim and the authorities to check it against.
* @returns the refusal, or `undefined` when the claim may be taken.
* @throws when git cannot be asked at all.
*/
async function evaluateLease(query) {
	const { binding, repo } = query;
	const refuse = (refusal) => ({
		kind: "refused",
		refusal
	});
	if (!isAbsolute(binding.path)) return refuse({
		kind: "invalid-binding",
		message: `${binding.path} is not an absolute path, so it does not name a working tree. Pass the checkout's absolute path, as git worktree list reports it.`
	});
	if (repo === void 0) return refuse({
		kind: "no-repository",
		message: `${binding.path} is not inside a git repository, so there is no working tree to claim. Bind a checkout that exists, or let the ledger allocate one.`
	});
	const entries = await listWorktrees(repo);
	const entry = entries.find((candidate) => samePath(candidate.path, binding.path));
	if (entry === void 0) return refuse({
		kind: "not-a-worktree",
		message: `${binding.path} is not a working tree of ${repo.commonDir}. An existing checkout can be listed with git worktree list.`
	});
	if (entry.prunable) return refuse({
		kind: "not-a-worktree",
		message: `${binding.path} is registered but its working tree is gone, so git reports it prunable${entry.prunableReason === void 0 ? "" : ` (${entry.prunableReason})`}. If it was moved by hand, run git worktree repair from the new location; otherwise remove the stale entry first.`
	});
	if (binding.branch !== void 0) {
		const actual = entry.branch;
		if (actual !== binding.branch) return refuse({
			kind: "branch-mismatch",
			message: `${binding.path} is on ${actual === void 0 ? "a detached HEAD" : `'${actual}'`}, not '${binding.branch}', so the binding no longer describes the checkout.`
		});
		const holder = branchHolders(entries).get(binding.branch);
		if (holder !== void 0 && !samePath(holder.path, binding.path)) return refuse({
			kind: "checked-out",
			heldAt: holder.path,
			message: `'${binding.branch}' is checked out at ${holder.path}, and a branch is held by exactly one working tree. Claim ${holder.path} instead, or use a different branch.`
		});
	}
	const claim = {
		...binding,
		repo: repo.commonDir
	};
	for (const front of query.digests) {
		if (front.report === query.report) continue;
		if (front.worktree === void 0) continue;
		if (!sameClaim(front.worktree, claim)) continue;
		if (front.status === "closed") continue;
		if (leaseState(await query.hopsOf(front.report)) !== "held") continue;
		const holders = [.../* @__PURE__ */ new Set([front.from, ...front.authors])];
		return refuse({
			kind: "held-by-report",
			heldBy: front.report,
			heldByActor: front.from,
			message: `${front.report} (opened by ${front.from}) already holds ${claimName(binding)}. A claim is held by one report at a time. Ask it to release with report_release, or to close — closing releases the claim. Its authors are ${holders.join(", ")}.`
		});
	}
	return {
		kind: "granted",
		binding: {
			path: entry.path,
			...entry.branch === void 0 ? {} : { branch: entry.branch },
			...entry.head === void 0 ? {} : { head: entry.head },
			repo: repo.commonDir,
			...binding.allocated === void 0 ? {} : { allocated: binding.allocated }
		}
	};
}
/** Longest slug kept in a branch and directory name. */
const SLUG_LIMIT = 40;
/**
* Reduce a subject to a ref-safe slug.
*
* The output alphabet is `[a-z0-9-]`, a subset of what git accepts in a ref
* name, so nothing needs escaping afterwards. That narrowness is the point: git
* forbids `~^:?*[`, `..`, `@{`, spaces, control characters, and a leading or
* trailing `.`, and a slug that can only hold lower-case letters, digits and
* interior hyphens cannot spell any of them. A subject in a non-Latin script
* reduces to nothing, which is why a name without a slug exists too.
* @param subject - the report subject.
* @returns the slug, possibly empty.
*/
function slugify(subject) {
	return subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, SLUG_LIMIT).replace(/-+$/g, "");
}
/**
* The name a report's checkout goes by, in both its branch and its directory.
*
* A report id is always part of it, so a checkout traces back to its report from
* `git branch` alone, and the report id is recoverable from a directory listing
* without consulting the ledger.
* @param report - report identifier.
* @param subject - the report subject, for the readable suffix.
* @returns the name.
*/
function worktreeName(report, subject) {
	const slug = slugify(subject);
	return slug === "" ? report : `${report}-${slug}`;
}
/**
* The branch a report's checkout is on.
* @param report - report identifier.
* @param subject - the report subject.
* @returns the branch name.
*/
function worktreeBranch(report, subject) {
	return `dsh/${worktreeName(report, subject)}`;
}
/**
* Where a report's checkout is created.
*
* The repository name is always a path component, so two repositories sharing a
* parent — the ordinary case for anyone with several projects — cannot allocate
* into each other's directory.
* @param repo - the repository.
* @param report - report identifier.
* @param subject - the report subject.
* @param base - base directory override, when configured.
* @returns the absolute path.
*/
function worktreePath(repo, report, subject, base) {
	const name = worktreeName(report, subject);
	return base === void 0 ? join(repo.worktreeRoot, name) : join(base, repo.repoName, name);
}
/** One configured count, or its default when it is not a usable number. */
function countSetting(value, fallback, minimum) {
	if (value === void 0) return fallback;
	return Number.isInteger(value) && value >= minimum ? value : fallback;
}
/**
* Fill in the defaults for working-tree support.
*
* A count is validated rather than trusted: `maxActive: 0` would otherwise turn
* every allocation into a permanent refusal that names no holder, and a
* fractional or negative cap would be obeyed in ways nobody meant. A value that
* cannot be honoured falls back to its documented default, which keeps the
* feature working and confinable instead of silently dead.
* @param config - the plugin configuration, when one was supplied.
* @returns the resolved runtime.
*/
function resolveWorktree(config) {
	return {
		enabled: config?.enabled === true,
		settings: {
			maxActive: countSetting(config?.maxActive, 4, 1),
			maxRetained: countSetting(config?.maxRetained, 4, 0),
			reclaim: config?.reclaim ?? "never",
			relativePaths: config?.relativePaths === true,
			...config?.root === void 0 ? {} : { base: config.root }
		},
		onClose: config?.onClose ?? "keep"
	};
}
/** When a claim ended, from the hop that ended it. */
function lastReleaseAt(hops) {
	let at = 0;
	for (const hop of hops) if (hop.action === "released") at = hop.at;
	return at;
}
/**
* The message shown when the active budget is full.
*
* "Wait" is useless advice unless it says for whom, and the ledger already knows
* both the holders and whether each is around — so the refusal names them, and
* names the two ways out that do not involve waiting.
* @param held - the reports currently holding a checkout.
* @param limit - the configured cap.
* @returns the refusal message.
*/
function budgetMessage(held, limit) {
	const holders = held.map((holder) => `${holder.report} -> ${holder.actor} (${holder.live ? "live" : "absent"})`).join(", ");
	return `the working-tree budget is full (${held.length} of ${limit} held). Held by: ${holders}. Wait for one of these to finish, hand one back with report_release, or close its report — closing releases the claim.`;
}
/**
* Why a candidate the plan chose must not actually be removed, if anything has
* changed since the plan was made.
*
* The plan is a decision about the filesystem taken from the filesystem, and the
* window between making it and acting on it is real. So the same checks are
* asked again immediately before the delete, from the helper both sides share,
* and a disagreement aborts the allocation instead of stepping over it: taking
* something away is never the safe default.
* @param target - the checkout the plan selected.
* @param reality - what git reports there now.
* @returns the reason to refuse, or `undefined` when it is safe to remove.
*/
function reclaimRefusal(target, reality) {
	if (reality.presence === "missing") return `${target.path} is no longer on disk`;
	if (reality.presence === "not-a-worktree") return `${target.path} is not a working tree of its repository any more`;
	if (target.branch !== void 0 && reality.branch !== target.branch) {
		const actual = reality.branch === void 0 ? "a detached HEAD" : `'${reality.branch}'`;
		return `${target.path} is on ${actual}, not '${target.branch}'`;
	}
}
/**
* Decide what to allocate, or refuse.
*
* One pass over the ledger yields both answers: which checkouts are held now,
* and which ended claims left one behind. The budget is then checked against the
* held set alone and refuses without an override; reclamation runs afterwards,
* for the disk limit, and can only reach checkouts whose claim already ended.
*
* Two innocents have to be protected from that reclamation. A checkout a live
* report *adopted* is still named by the closed report that made it — the path
* is the same, so the closed report's binding looks like litter while someone is
* working in it. And a path that exists but is no longer a working tree is not a
* checkout to clear at all; it is a belief to correct, once.
* @param query - the allocation and the ledger it must fit into.
* @param settings - the resolved settings.
* @returns the plan, or the refusal.
*/
async function planAllocation(query, settings) {
	if (hasSubmodules(query.repo)) return {
		kind: "submodules",
		message: `${query.repo.repoRoot} uses submodules (it has a .gitmodules file). Git does not recommend multiple checkouts of a superproject, and a linked worktree containing submodules cannot be moved, so the ledger will not allocate one here.`
	};
	if (settings.relativePaths) {
		const refusal = relativePathsRefusal(query.version ?? await gitVersion(query.repo.commonDir));
		if (refusal !== void 0) return {
			kind: "git-version",
			message: `${refusal}. Allocate without relative paths (set worktree.relativePaths: false), or upgrade git.`
		};
	}
	const held = [];
	const liveClaims = [];
	const ended = [];
	for (const front of query.digests) {
		if (front.report === query.report) continue;
		const binding = front.worktree;
		if (binding === void 0) continue;
		const hops = await query.hopsOf(front.report);
		const state = leaseState(hops);
		if (state === "held") {
			held.push({
				report: front.report,
				actor: front.from,
				live: query.isLive(front.from)
			});
			if (front.status !== "closed") liveClaims.push({
				report: front.report,
				worktree: binding
			});
			continue;
		}
		if (state !== "released" || front.status !== "closed" || binding.allocated !== true) continue;
		ended.push({
			report: front.report,
			binding,
			releasedAt: lastReleaseAt(hops)
		});
	}
	if (held.length >= settings.maxActive) return {
		kind: "budget",
		message: budgetMessage(held, settings.maxActive)
	};
	const reclaimable = [];
	const reclaimSkipped = [];
	const stale = [];
	for (const candidate of ended) {
		const holder = liveClaims.find((live) => samePath(live.worktree.path, candidate.binding.path));
		if (holder !== void 0) {
			reclaimSkipped.push(`${candidate.report} (its checkout at ${candidate.binding.path} is held by ${holder.report})`);
			continue;
		}
		const reality = await inspectCheckout(candidate.binding.path);
		if (reality.presence === "missing") {
			stale.push({
				report: candidate.report,
				path: candidate.binding.path
			});
			continue;
		}
		if (reality.presence === "not-a-worktree") {
			stale.push({
				report: candidate.report,
				path: candidate.binding.path,
				detail: "exists but is no longer a working tree of the repository"
			});
			continue;
		}
		reclaimable.push({
			report: candidate.report,
			path: candidate.binding.path,
			...candidate.binding.branch === void 0 ? {} : { branch: candidate.binding.branch },
			releasedAt: candidate.releasedAt
		});
	}
	reclaimable.sort((left, right) => left.releasedAt - right.releasedAt || left.report.localeCompare(right.report));
	let reclaimed;
	if (settings.reclaim === "oldest-closed" && reclaimable.length > settings.maxRetained) for (const candidate of reclaimable) {
		if (!await isWorktreeClean(candidate.path)) {
			reclaimSkipped.push(`${candidate.report} (uncommitted changes at ${candidate.path})`);
			continue;
		}
		reclaimed = {
			report: candidate.report,
			path: candidate.path,
			...candidate.branch === void 0 ? {} : { branch: candidate.branch }
		};
		break;
	}
	return {
		binding: {
			path: worktreePath(query.repo, query.report, query.subject, settings.base),
			branch: worktreeBranch(query.report, query.subject),
			repo: query.repo.commonDir,
			allocated: true
		},
		retained: reclaimable.length - (reclaimed === void 0 ? 0 : 1),
		...reclaimed === void 0 ? {} : { reclaimed },
		reclaimSkipped,
		stale
	};
}
//#endregion
//#region src/report/dev/roster.ts
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
* Whether the composition asked for developer mode.
*
* Strict on purpose: only the literal boolean `true` enables it. A string
* `"false"` from a hand-edited YAML scalar must not read as truthy, and a
* published deployment that never sets the field must keep today's behaviour
* byte for byte.
* @param config - resolved plugin config, if the composition row passed one.
* @returns true only for the literal boolean `true`.
*/
function devModeEnabled(config) {
	return config?.devMode === true;
}
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
/**
* The part of an entry a preset registration depends on.
*
* The prompt is absent on purpose: prompt text is rendered by a section provider
* that reads the roster live, so editing it needs no re-registration. An id whose
* name, description or order changed does need one, and this is what detects it.
* @param agent - the roster entry.
* @returns a comparable signature.
*/
function signatureOf(agent) {
	return [
		agent.name,
		agent.description,
		String(agent.order),
		String(agent.retired)
	].join("\0");
}
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
function message$1(error) {
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
				reason: `the roster is not valid YAML: ${message$1(error)}`
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
//#region src/report/dev/index.ts
/**
* Developer mode — the switch-gated half that exists only while this plugin is
* being developed.
*
* A published deployment must be byte-identical to what shipped, so everything
* here is behind one boolean and nothing is registered when it is off: no prompt
* section, no tool, no preset. That is what makes "hidden" cheap and honest — not
* a filter over a visible list, but an absent registration.
*
* When it is on, the composition does two things that cannot be expressed as
* configuration:
*
*  1. **It publishes agents into the preset roster.** Those agents appear in the
*     picker beside the shipped presets, which is the point: a human developing
*     this plugin needs to be able to start one. They are registered through the
*     same `agentPresets.register` the `@deepseek-ai/dsh-agent-preset` row itself
*     calls, so a runtime registration is exactly as real as a YAML declaration.
*  2. **It routes one prompt section to them and nobody else.** The section is a
*     per-assembly provider: it reads the assembling agent's preset id and returns
*     that roster entry's text, or `''` for every other agent. An empty section is
*     dropped during rendering, so a normal agent's prompt does not change by a
*     single byte.
*
* The roster is data in the checkout (`dev/agents.yml`), not configuration, so a
* branch or working tree carries its own set of developer agents — which is the
* reason this exists at all: the candidate implementation and the roster that
* measures it travel together.
*
* `dev_agents_reload` reads the roster again and diffs it against what is mounted.
* It is the only path from an edited file to a live picker: editing YAML does not
* trigger HMR, which watches `lib/`, and pretending otherwise would leave the
* prompt and the picker disagreeing.
*
* @module dsh-report-ledger/report/dev
*/
/** Name of the prompt section a developer agent receives. */
const DEV_SECTION = "plugin:report-ledger:dev";
/** Where the roster lives inside the checkout. */
const ROSTER_FILE = join("dev", "agents.yml");
/** The one canonical output shape every report tool uses. */
const stringOutput$1 = {
	schema: { type: "string" },
	render: (_args, value) => [{
		type: "text",
		text: String(value)
	}]
};
/** Render a thrown value for a report. */
function message(error) {
	return error instanceof Error ? error.message : String(error);
}
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
/** How long a duplicate-id registration waits for the previous owner to let go. */
const RELEASE_WAIT_MS = 40;
/** Attempts before a duplicate id is reported instead of waited for. */
const RELEASE_ATTEMPTS = 10;
/** Wait one beat without keeping the process alive for it. */
function waitBriefly(milliseconds) {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds).unref?.();
	});
}
/** Empty a preset mount without letting its failure escape the caller. */
async function disposeQuietly(dispose) {
	try {
		await dispose();
	} catch {}
}
/** Render one problem as a single log/grep-friendly line. */
function renderProblem(problem) {
	return `${problem.row === 0 ? "document" : `row ${problem.row}`}${problem.id === void 0 ? "" : ` (${problem.id})`}: ${problem.reason}`;
}
/** Render one sync as the reload tool's answer. */
function renderSync(report, enabled, broken) {
	const active = enabled.filter((agent) => !agent.retired);
	const retired = enabled.filter((agent) => agent.retired);
	const problems = [...report.problems, ...broken];
	const lines = [`developer roster: ${report.path}`];
	lines.push(active.length === 0 ? "enabled: none" : `enabled: ${active.length} — ${active.map((agent) => agent.id).join(", ")}`);
	if (retired.length > 0) lines.push(`retired: ${retired.length} — ${retired.map((agent) => agent.id).join(", ")} (still routed: their live sessions get the wind-down)`);
	if (report.added.length > 0) lines.push(`added: ${report.added.join(", ")}`);
	if (report.removed.length > 0) lines.push(`removed: ${report.removed.join(", ")}`);
	lines.push(problems.length === 0 ? "problems: none" : `problems: ${problems.length}\n${problems.map((problem) => `  ${renderProblem(problem)}`).join("\n")}`);
	return lines.join("\n");
}
/**
* Rows this roster registered that the registry reports as unusable.
*
* A definition enters the roster before its composition is activated, and a
* failed mount leaves it there marked `broken`, filtered out of the picker. Without
* this, "registered" and "selectable" would look identical to the agent that just
* edited the file — the failure would be silent exactly where it matters.
*
* Deliberately never called during activation: the registry's diagnostic awaits
* the Host Loader tree settling, which would wait on the activation it was called
* from.
* @param registry - the preset registry.
* @param agents - the entries this roster just mounted.
* @returns one problem per unusable definition of ours.
*/
async function brokenOf(registry, agents) {
	if (registry.list === void 0) return [];
	try {
		const rows = await registry.list();
		const ours = new Set(agents.map((agent) => agent.id));
		const broken = [];
		for (const row of rows) {
			if (!ours.has(row.id)) continue;
			if (typeof row.broken !== "string" || row.broken === "") continue;
			broken.push({
				row: 0,
				id: row.id,
				reason: row.broken
			});
		}
		return broken;
	} catch (error) {
		return [{
			row: 0,
			reason: `could not read the preset roster back: ${message(error)}`
		}];
	}
}
/**
* Install developer mode on a host context that has a preset roster.
*
* Nothing is registered unless `config.devMode` is the literal boolean `true` —
* see {@link devModeEnabled} — and nothing at all is installed on a deployment
* that composes no agent-preset roster, since there would be no picker for the
* agents to appear in and no way to select them.
* @param ctx - the plugin context (`systemPrompt`, `tools`, and the optional
*   `agentPresets` service).
* @returns a disposer that removes every registration, including the presets.
*/
function installDevMode(ctx) {
	const registry = ctx.get("agentPresets");
	if (registry === void 0) {
		ctx.logger?.warn?.("report-ledger: devMode is on, but this deployment composes no agent-preset roster — no developer agent can be enabled");
		return () => {};
	}
	const rosterPath = join(packageRoot(), ROSTER_FILE);
	const state = { agents: [] };
	const mounted = /* @__PURE__ */ new Map();
	/** Serializes syncs so two reload calls cannot double-register one entry. */
	let chain = Promise.resolve();
	const readRoster = () => {
		let text;
		try {
			text = readFileSync(rosterPath, "utf8");
		} catch {
			return {
				agents: [],
				problems: [{
					row: 0,
					reason: `no roster at ${rosterPath}`
				}]
			};
		}
		const rosterDirectory = dirname(rosterPath);
		return parseRoster(text, (relativePath) => {
			try {
				return readFileSync(resolve(rosterDirectory, relativePath), "utf8");
			} catch {
				return;
			}
		});
	};
	const syncOnce = async () => {
		const parsed = readRoster();
		const desired = new Map(parsed.agents.filter((agent) => !agent.retired).map((agent) => [agent.id, agent]));
		const removed = [];
		for (const [id, entry] of [...mounted]) {
			const next = desired.get(id);
			if (next !== void 0 && signatureOf(next) === entry.signature) continue;
			mounted.delete(id);
			if (next === void 0) removed.push(id);
			await disposeQuietly(entry.dispose);
		}
		const added = [];
		const failures = [];
		for (const agent of parsed.agents) {
			if (agent.retired) continue;
			if (mounted.has(agent.id)) continue;
			const definition = {
				id: agent.id,
				name: agent.name,
				description: agent.description,
				order: agent.order,
				plugins: []
			};
			for (let attempt = 1;; attempt += 1) try {
				const dispose = await registry.register(definition);
				mounted.set(agent.id, {
					dispose,
					signature: signatureOf(agent)
				});
				added.push(agent.id);
				break;
			} catch (error) {
				if (/Duplicate agent preset/.test(message(error)) && attempt < RELEASE_ATTEMPTS) {
					await waitBriefly(RELEASE_WAIT_MS);
					continue;
				}
				failures.push({
					row: 0,
					id: agent.id,
					reason: message(error)
				});
				break;
			}
		}
		state.agents = parsed.agents;
		return {
			path: rosterPath,
			added,
			removed,
			problems: [...parsed.problems, ...failures]
		};
	};
	const sync = () => {
		const run = () => syncOnce();
		const next = chain.then(run, run);
		chain = next.catch(() => void 0);
		return next;
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
				return promptFor(state.agents, registry.composedPreset(agent.ctx));
			} catch {
				return "";
			}
		}
	}));
	disposers.push(ctx.tools.register(defineTool({
		name: "dev_agents_reload",
		description: "Developer mode only: read the developer-agent roster (dev/agents.yml in the plugin checkout) again and apply the difference to the preset picker — presets that disappeared are removed, new ones are registered, renamed ones are re-registered. Use it after editing the roster, because editing YAML does not trigger the build watcher. Returns what was added, removed, enabled now, and every row that could not be used. A bad row is skipped and reported; the rest of the roster still applies.",
		parameters: {},
		output: stringOutput$1,
		execute: async () => {
			return renderSync(await sync(), state.agents, await brokenOf(registry, state.agents));
		}
	})));
	sync().then((report) => {
		for (const problem of report.problems) ctx.logger?.warn?.(`report-ledger: developer roster ${renderProblem(problem)}`);
	}, (error) => {
		ctx.logger?.warn?.(`report-ledger: developer roster could not be loaded: ${message(error)}`);
	});
	return () => {
		for (const dispose of disposers.reverse()) dispose();
		for (const entry of mounted.values()) disposeQuietly(entry.dispose);
		mounted.clear();
		state.agents = [];
	};
}
//#endregion
//#region src/report/maintenance.ts
/**
* The maintenance view: what the ledger thinks it owns, and what is true of it.
*
* This exists because of an asymmetry the design accepts deliberately. A working
* tree is not a first-class object in the ledger — it is a field on a report plus
* a directory on disk — so there is no index to consult when an operator asks
* "what checkouts are out there, and is any of it broken?". The answer has to be
* assembled from the reports and from git, every time, and that is what this
* module does.
*
* It **reports and never repairs**. Nothing here removes, prunes or reclaims: a
* checkout moved by hand still works from its own side while git calls it
* dangling, so an automatic prune destroys live work, and the whole point of a
* maintenance view is to let a human decide with the facts in front of them.
*
* @module dsh-report-ledger/report/maintenance
*/
/**
* Assemble the maintenance view.
*
* Two passes, because they cost different things: the first asks the ledger what
* it believes (cheap), the second asks git what is true (one `worktree list` per
* repository, plus one `status` per checkout that is actually on disk).
* @param deps - the ledger readers.
* @param settings - the configured limits.
* @param enabled - whether allocation is on in this deployment.
* @returns the view.
*/
async function buildWorktreeReport(deps, settings, enabled) {
	const digests = await deps.listReports();
	const records = [];
	for (const front of digests) {
		const binding = front.worktree;
		if (binding === void 0) continue;
		const onDisk = existsSync(binding.path);
		records.push({
			report: front.report,
			subject: front.subject,
			status: front.status,
			path: binding.path,
			...binding.branch === void 0 ? {} : { branch: binding.branch },
			...binding.head === void 0 ? {} : { head: binding.head },
			...binding.repo === void 0 ? {} : { repo: binding.repo },
			allocated: binding.allocated === true,
			state: leaseState(await deps.readHops(front.report)),
			onDisk,
			...onDisk ? { clean: await isWorktreeClean(binding.path) } : {},
			prunable: false
		});
	}
	const byRepo = /* @__PURE__ */ new Map();
	for (const record of records) {
		const key = record.repo ?? record.path;
		const bucket = byRepo.get(key);
		if (bucket === void 0) byRepo.set(key, [record]);
		else bucket.push(record);
	}
	const warnings = [];
	const unmanaged = [];
	const dangling = [];
	const prunable = /* @__PURE__ */ new Set();
	for (const bucket of byRepo.values()) {
		const first = bucket[0];
		if (first === void 0) continue;
		const repo = await resolveRepo(first.path) ?? (first.repo === void 0 ? void 0 : await resolveRepo(first.repo));
		if (repo === void 0) {
			warnings.push(`the repository holding ${bucket.map((record) => record.report).join(", ")} could not be resolved, so those checkouts were not inspected`);
			continue;
		}
		let entries;
		try {
			entries = await listWorktrees(repo);
		} catch (error) {
			warnings.push(`git could not list the working trees of ${repo.commonDir}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		for (const entry of entries) if (entry.prunable) {
			prunable.add(entry.path);
			dangling.push(entry.path);
		}
		for (const entry of entries) {
			if (entry.bare || entry.prunable || samePath(entry.path, repo.repoRoot)) continue;
			if (records.some((record) => samePath(record.path, entry.path))) continue;
			unmanaged.push(entry.path);
		}
	}
	const resolved = records.map((record) => prunable.has(record.path) ? {
		...record,
		prunable: true
	} : record);
	const active = resolved.filter((record) => record.state === "held").length;
	const retained = resolved.filter((record) => record.state === "released" && record.onDisk).length;
	for (const record of resolved) {
		if (record.state === "held" && !record.onDisk) warnings.push(`${record.report} holds a claim on ${record.path}, and that checkout is no longer on disk. Release the claim, or close the report — closing releases it.`);
		if (record.state === "released" && !record.onDisk) warnings.push(`${record.report}'s bound checkout at ${record.path} is gone, and the ledger still records the claim as released rather than reclaimed. The next allocation will note that it is gone.`);
		if (record.clean === false && record.state !== "held") warnings.push(`the kept checkout at ${record.path} (${record.report}) has uncommitted work, so it will never be reclaimed automatically.`);
	}
	if (retained > settings.maxRetained && settings.reclaim === "never") warnings.push(`${retained} checkouts are kept on disk past the retained limit of ${settings.maxRetained}, and automatic reclamation is off, so they will accumulate. Close reports with worktree:"remove-if-clean", or set worktree.reclaim to "oldest-closed".`);
	const uniqueDangling = [...new Set(dangling)].sort();
	for (const path of uniqueDangling) warnings.push(`git reports the worktree entry at ${path} as dangling. If it was moved by hand, run git worktree repair from the new location; otherwise prune the stale entry.`);
	for (const path of unmanaged) warnings.push(`git has a working tree no report is bound to: ${path}. A report can adopt it with report_lease.`);
	resolved.sort((left, right) => left.report.localeCompare(right.report));
	return {
		generatedAt: Date.now(),
		enabled,
		limits: {
			maxActive: settings.maxActive,
			maxRetained: settings.maxRetained,
			reclaim: settings.reclaim
		},
		active,
		retained,
		records: resolved,
		unmanaged: [...new Set(unmanaged)].sort(),
		dangling: uniqueDangling,
		warnings
	};
}
//#endregion
//#region src/report/roster.ts
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
* The log is the relationship record, not an authority gate. DSH's delegation
* seam refuses non-adjacent messaging with the note that "other agents,
* ancestors, teams, workflows, and hosts remain rejected until an explicit
* authority protocol has a production consumer". This plugin does not claim to
* be that consumer for its own tools: report_send and report_cc are open to any
* session id by design, because reaching out through the ledger is how contact
* is established in the first place. What {@link holdsChannelTo} and {@link
* buildRoster} provide is **classification for display and discovery** — lineage
* in either direction, a sibling under the same parent, a prior recorded
* exchange, and a session the caller started — so an agent can see who it is
* related to instead of guessing. Nothing in the delivery path consults it, and
* the docs must not imply otherwise.
*
* @module dsh-report-ledger/report/roster
*/
/** Append-only peer log file name. */
const PEER_LOG = "peers.jsonl";
/**
* Absolute path of the peer log.
* @returns the path.
*/
function peerLogPath() {
	return join(ledgerRoot(), PEER_LOG);
}
/** Read one string field, tolerating absent values. */
function str$1(source, key) {
	const value = source[key];
	return typeof value === "string" && value !== "" ? value : void 0;
}
/**
* Append one peer record.
* @param record - the record to persist.
*/
async function appendPeer(record) {
	await mkdir(ledgerRoot(), { recursive: true });
	await appendFile(peerLogPath(), `${JSON.stringify(record)}\n`, "utf8");
}
/**
* Read the whole peer log.
*
* A malformed line is skipped rather than allowed to poison the roster: the file
* is append-only and human-editable, so robustness beats strictness here.
* @returns every readable record, oldest first.
*/
async function readPeers() {
	let raw;
	try {
		raw = await readFile(peerLogPath(), "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	const records = [];
	for (const line of raw.split("\n")) {
		const text = line.trim();
		if (text === "") continue;
		let value;
		try {
			value = JSON.parse(text);
		} catch {
			continue;
		}
		if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
		const entry = value;
		const sessionId = str$1(entry, "sessionId");
		const startedBy = str$1(entry, "startedBy");
		if (sessionId === void 0 || startedBy === void 0) continue;
		const name = str$1(entry, "name");
		const cwd = str$1(entry, "cwd");
		records.push({
			sessionId,
			startedBy,
			startedAt: typeof entry.startedAt === "number" ? entry.startedAt : 0,
			...name === void 0 ? {} : { name },
			...cwd === void 0 ? {} : { cwd }
		});
	}
	return records;
}
/** Walk the ancestor chain of one session. */
function ancestorsOf(byId, id) {
	const ancestors = /* @__PURE__ */ new Set();
	let cursor = byId.get(id)?.header.parentSession;
	for (let step = 0; typeof cursor === "string" && cursor !== "" && step <= byId.size; step++) {
		if (ancestors.has(cursor)) break;
		ancestors.add(cursor);
		cursor = byId.get(cursor)?.header.parentSession;
	}
	return ancestors;
}
/** Collect every descendant of one session. */
function descendantsOf(children, id) {
	const found = /* @__PURE__ */ new Set();
	const queue = [id];
	while (queue.length > 0) {
		const current = queue.shift();
		for (const child of children.get(current) ?? []) {
			if (found.has(child)) continue;
			found.add(child);
			queue.push(child);
		}
	}
	return found;
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
function buildRoster(input) {
	const byId = /* @__PURE__ */ new Map();
	const children = /* @__PURE__ */ new Map();
	for (const record of input.records) {
		const id = record.header?.id;
		if (typeof id !== "string" || id === "") continue;
		byId.set(id, record);
		const parent = record.header.parentSession;
		if (typeof parent === "string" && parent !== "") {
			const bucket = children.get(parent);
			if (bucket === void 0) children.set(parent, [id]);
			else bucket.push(id);
		}
	}
	const ancestors = ancestorsOf(byId, input.self);
	const descendants = descendantsOf(children, input.self);
	const selfParent = byId.get(input.self)?.header.parentSession;
	const siblings = /* @__PURE__ */ new Set();
	if (typeof selfParent === "string" && selfParent !== "") {
		for (const sibling of children.get(selfParent) ?? []) if (sibling !== input.self) siblings.add(sibling);
	}
	const started = /* @__PURE__ */ new Set();
	const names = /* @__PURE__ */ new Map();
	for (const peer of input.peers) {
		if (peer.startedBy !== input.self) continue;
		started.add(peer.sessionId);
		if (peer.name !== void 0) names.set(peer.sessionId, peer.name);
	}
	const contacts = /* @__PURE__ */ new Map();
	for (const front of input.reports) {
		const others = /* @__PURE__ */ new Set([
			front.from,
			...front.to,
			...front.cc,
			...front.authors
		]);
		if (!others.has(input.self)) continue;
		for (const other of others) {
			if (other === input.self || other === "") continue;
			const existing = contacts.get(other);
			if (existing === void 0) contacts.set(other, {
				reports: 1,
				lastActivity: front.updated
			});
			else {
				existing.reports += 1;
				if (front.updated > existing.lastActivity) existing.lastActivity = front.updated;
			}
		}
	}
	const rows = [];
	const candidates = new Set(byId.keys());
	for (const id of started) candidates.add(id);
	for (const id of contacts.keys()) candidates.add(id);
	for (const id of candidates) {
		if (id === input.self) continue;
		const record = byId.get(id);
		const live = input.liveIds.has(id);
		if (input.scope === "live" && !live) continue;
		let relation;
		if (ancestors.has(id)) relation = "ancestor";
		else if (descendants.has(id)) relation = "descendant";
		else if (siblings.has(id)) relation = "sibling";
		else if (started.has(id)) relation = "started";
		else if (contacts.has(id)) relation = "contact";
		else if (input.scope === "live" || input.scope === "all") relation = "co-present";
		if (relation === void 0) continue;
		const contact = contacts.get(id);
		const title = input.titles.get(id);
		const name = names.get(id);
		const depth = record?.header.delegationDepth;
		rows.push({
			sessionId: id,
			relation,
			live,
			reports: contact?.reports ?? 0,
			...title === void 0 ? {} : { title },
			...name === void 0 ? {} : { name },
			...depth === void 0 ? {} : { depth },
			...contact === void 0 ? {} : { lastActivity: contact.lastActivity }
		});
	}
	const rank = {
		ancestor: 0,
		descendant: 1,
		sibling: 2,
		started: 3,
		contact: 4,
		"co-present": 5
	};
	rows.sort((left, right) => rank[left.relation] - rank[right.relation] || Number(right.live) - Number(left.live) || (right.lastActivity ?? 0) - (left.lastActivity ?? 0) || left.sessionId.localeCompare(right.sessionId));
	return rows.slice(0, Math.max(0, input.limit));
}
/**
* The relationship predicate behind the roster's classification.
*
* Lineage in either direction, a sibling under the same parent, or a session
* the caller started. It is deliberately **not** consulted before delivery:
* report_send / report_cc accept any session id by design, so this answers a
* display-and-discovery question, not an authorization one.
*
* A ledger contact is deliberately **not** sufficient on its own for a fresh
* channel — reaching out through the ledger is how contact is established, and
* the recorded exchange is what makes the relationship real.
* @param input - the roster inputs (scope and limit are ignored).
* @param target - the session id being addressed.
* @returns true when the relationship classifier places the two in contact.
*/
function holdsChannelTo(input, target) {
	if (target === input.self || target === "") return false;
	const byId = /* @__PURE__ */ new Map();
	const children = /* @__PURE__ */ new Map();
	for (const record of input.records) {
		const id = record.header?.id;
		if (typeof id !== "string" || id === "") continue;
		byId.set(id, record);
		const parent = record.header.parentSession;
		if (typeof parent === "string" && parent !== "") {
			const bucket = children.get(parent);
			if (bucket === void 0) children.set(parent, [id]);
			else bucket.push(id);
		}
	}
	if (ancestorsOf(byId, input.self).has(target)) return true;
	if (descendantsOf(children, input.self).has(target)) return true;
	const selfParent = byId.get(input.self)?.header.parentSession;
	if (typeof selfParent === "string" && selfParent !== "" && (children.get(selfParent) ?? []).includes(target)) return true;
	if (byId.get(target)?.header.parentSession === input.self) return true;
	return input.peers.some((peer) => peer.startedBy === input.self && peer.sessionId === target);
}
/** How long a caller waits for evidence about a peer's first turn, by default. */
const DEFAULT_RECEIPT_MS = 1500;
/** The peer service. */
var PeerService = class {
	#host;
	#maxPeers;
	/**
	* @param host - harness capabilities.
	* @param maxPeers - cap on peers one session may start.
	*/
	constructor(host, maxPeers = 8) {
		this.#host = host;
		this.#maxPeers = maxPeers > 0 ? maxPeers : 8;
	}
	/** Assemble the shared roster inputs for one caller. */
	async #inputs(self) {
		const [records, reports, peers] = await Promise.all([
			this.#host.listSessionRecords(),
			this.#host.listReports(),
			readPeers()
		]);
		return {
			self,
			records,
			liveIds: this.#host.liveIds(),
			peers,
			reports,
			titles: /* @__PURE__ */ new Map()
		};
	}
	/**
	* List the sessions this caller can see.
	* @param self - the caller's session id.
	* @param options - scope and row cap.
	* @returns the roster rows.
	*/
	async roster(self, options = {}) {
		const scope = options.scope ?? "related";
		const limit = options.limit === void 0 || options.limit <= 0 ? 40 : Math.min(options.limit, 200);
		const rows = buildRoster({
			...await this.#inputs(self),
			scope,
			limit
		});
		if (rows.length === 0) return rows;
		const titles = await this.#host.readTitles(rows.map((row) => row.sessionId));
		return rows.map((row) => {
			const title = titles.get(row.sessionId);
			return title === void 0 ? row : {
				...row,
				title
			};
		});
	}
	/**
	* How many peers one session has already started.
	* @param self - the caller's session id.
	* @returns the count.
	*/
	async startedCount(self) {
		const peers = await readPeers();
		let count = 0;
		for (const peer of peers) if (peer.startedBy === self) count++;
		return count;
	}
	/**
	* Classify the relationship for display and discovery.
	*
	* This is **not** an authorization check before delivery: report_send and
	* report_cc accept any session id by design, because reaching out through the
	* ledger is how contact is established. Nothing in the delivery path consults
	* this predicate; it answers the narrower question the roster shows.
	* @param self - the caller's session id.
	* @param target - the session being addressed.
	* @returns true when the relationship classifier places them in contact.
	*/
	async holdsChannel(self, target) {
		return holdsChannelTo(await this.#inputs(self), target);
	}
	/**
	* Observe what became of a peer's first turn.
	*
	* Not a status check: it is the honest answer to "did the thing I just handed
	* this peer actually start working?" — the question a bare `delivered` cannot
	* answer. Call it after the assignment report has been delivered.
	* @param sessionId - the peer session to observe.
	* @param timeoutMs - how long a still-running turn is awaited before being reported as running.
	* @returns the observation, or `undefined` when the peer is not resident.
	*/
	async receipt(sessionId, timeoutMs = DEFAULT_RECEIPT_MS) {
		return await this.#host.confirmPeer(sessionId, timeoutMs);
	}
	/**
	* Register one freshly created peer with the workspace registry, if the
	* deployment has one, and never let the attempt be fatal.
	*
	* Three outcomes are possible and only one is a defect: no hook means there are
	* no groups to join, an unmatched directory is a legitimate ungrouped peer, and
	* anything that throws or answers with an unusable shape is reported back as a
	* failure for the caller to see.
	* @param sessionId - the peer session that now exists.
	* @param cwd - the directory it was created in, when one was inherited or supplied.
	* @returns the outcome, or `undefined` when this host implements no registration.
	*/
	async #register(sessionId, cwd) {
		if (this.#host.attachToWorkspace === void 0) return void 0;
		try {
			const result = await this.#host.attachToWorkspace({
				sessionId,
				...cwd === void 0 ? {} : { cwd }
			});
			if (result === null || typeof result !== "object" || typeof result.outcome !== "string") return {
				outcome: "failed",
				warning: `the workspace host answered with ${JSON.stringify(result)}`
			};
			return result;
		} catch (error) {
			return {
				outcome: "failed",
				warning: error instanceof Error ? error.message : String(error)
			};
		}
	}
	/**
	* Open one independent peer session.
	*
	* The peer is recorded before it is returned, so the relationship survives even
	* if the caller's next step fails. Nothing here disposes the handle: the
	* handle's `dispose()` removes the session from the store, which is exactly
	* wrong for a partner that must outlive this turn.
	* @param self - the caller's session id.
	* @param input - the task and optional name.
	* @returns the created peer.
	* @throws when the task is empty, the name is unusable, or the cap is reached.
	*/
	async start(self, input) {
		if (input.task.trim() === "") throw new Error("report-ledger: peer_start requires a non-empty task");
		const name = input.name?.trim() || void 0;
		if (name !== void 0 && name.length > 60) throw new Error("report-ledger: peer_start name must be 60 characters or fewer");
		const already = await this.startedCount(self);
		if (already >= this.#maxPeers) throw new Error(`report-ledger: this session has already started ${already} peers (lifetime limit ${this.#maxPeers}, counting peers that are no longer resident or that died on their first turn); reuse an existing peer by sending it a report instead of opening another, or recover a slot as a human act: back up \$DSH_HOME/report-ledger/peers.jsonl, then delete the lines of peers that are finished`);
		const cwd = input.cwd ?? this.#host.selfCwd(self);
		const sessionId = `session-${randomUUID()}`;
		const created = await this.#host.createPeer({
			sessionId,
			startedBy: self,
			...cwd === void 0 ? {} : { cwd }
		});
		const workspace = await this.#register(created.id, cwd);
		await appendPeer({
			sessionId: created.id,
			startedBy: self,
			startedAt: Date.now(),
			...name === void 0 ? {} : { name },
			...cwd === void 0 ? {} : { cwd }
		});
		return {
			sessionId: created.id,
			started: already + 1,
			...name === void 0 ? {} : { name },
			...cwd === void 0 ? {} : { cwd },
			...workspace === void 0 ? {} : { workspace }
		};
	}
};
//#endregion
//#region src/report/route.ts
/** Path of the subtree + digest listing. */
const TIMELINE_PATH = "/api/report-ledger/timeline";
/** Path of one report's detail. */
const REPORT_PATH = "/api/report-ledger/report";
/**
* Path of the working-tree maintenance view.
*
* Registered whatever the feature's state, so an operator asking "is anything
* out there?" gets an answer even when the answer is "nothing, and allocation is
* off". A 404 would be indistinguishable from a typo.
*/
const WORKTREES_PATH = "/api/report-ledger/worktrees";
/** Longest accepted root session id. */
const MAX_ID_LENGTH = 200;
/** Conservative session-id shape: no separators that could escape a query. */
const SESSION_ID = /^[A-Za-z0-9._:-]+$/;
/** Report id shape. */
const REPORT_ID = /^R-\d{4,}$/;
/**
* Whether a TCP peer address is loopback.
* @param address - `socket.remoteAddress`.
* @returns true for IPv4 loopback, IPv6 loopback, and IPv4-mapped loopback.
*/
function isLoopbackAddress(address) {
	if (typeof address !== "string" || address === "") return false;
	if (address === "::1") return true;
	const mapped = address.startsWith("::ffff:") ? address.slice(7) : address;
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(mapped);
}
/**
* Whether a parsed hostname is loopback.
* @param hostname - `URL.hostname` of the request authority.
* @returns true for the loopback names only.
*/
function isLoopbackHostname(hostname) {
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}
/** Parse a `Host` header into a canonical authority plus its URL. */
function parseAuthority(host) {
	if (!/^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(host) && !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return void 0;
	let url;
	try {
		url = new URL(`http://${host}`);
	} catch {
		return;
	}
	if (url.username !== "" || url.password !== "" || url.pathname !== "/") return void 0;
	return {
		canonical: url.host,
		url
	};
}
/** Whether the browser's own same-origin markers agree with this authority. */
function isSameOriginRequest(request, hostUrl) {
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
/**
* Decide whether one request may read this plugin's data.
* @param request - the incoming request.
* @returns true only for a canonical loopback, same-origin read.
*/
function isTrustedRequest(request) {
	if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	const parsed = parseAuthority(host);
	if (parsed === void 0 || parsed.canonical !== host.toLowerCase()) return false;
	if (!isLoopbackHostname(parsed.url.hostname)) return false;
	return isSameOriginRequest(request, parsed.url);
}
/**
* Write one JSON response with the headers this surface always wants.
*
* Every JSON answer, including a refusal or a method rejection, goes through
* this one function: a response that skipped it would be the only one on the
* surface not marked uncacheable and not marked as opaque JSON.
* @param response - the response to fill.
* @param status - HTTP status.
* @param body - the JSON envelope.
* @param extra - route-specific headers (e.g. `allow` on a 405).
*/
function writeJson(response, status, body, extra = {}) {
	const payload = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
		...extra
	});
	response.end(payload);
}
/** Answer a refusal without revealing whether the resource exists. */
function refuse(response, status, code) {
	writeJson(response, status, {
		ok: false,
		code
	});
}
/**
* Wrap one read-only handler with the shared guard, method check, and error
* containment: a failing data source must surface as a JSON error, never as an
* unhandled rejection inside the web server.
* @param log - where a contained failure's detail goes instead of the response.
* @param work - the handler body, receiving the request URL.
* @returns a route handler.
*/
function guarded(log, work) {
	return async (request, response) => {
		try {
			if (!isTrustedRequest(request)) {
				refuse(response, 403, "untrusted-request");
				return;
			}
			if (request.method !== "GET" && request.method !== "HEAD") {
				writeJson(response, 405, {
					ok: false,
					code: "method-not-allowed"
				}, { allow: "GET, HEAD" });
				return;
			}
			await work(new URL(request.url ?? "/", "http://localhost"), response);
		} catch (error) {
			log?.(`report-ledger: read request failed: ${error instanceof Error ? error.message : String(error)}`);
			refuse(response, 500, "internal-error");
		}
	};
}
/**
* Build the timeline handler.
* @param deps - data sources.
* @returns the route handler.
*/
function createTimelineHandler(deps) {
	return guarded(deps.log, async (url, response) => {
		const root = url.searchParams.get("root") ?? "";
		if (root === "" || root.length > MAX_ID_LENGTH || !SESSION_ID.test(root)) {
			refuse(response, 400, "invalid-root");
			return;
		}
		writeJson(response, 200, {
			ok: true,
			value: await deps.timeline(root)
		});
	});
}
/**
* Build the working-tree maintenance handler.
*
* Read-only and unparameterised: it answers one question — what checkouts does
* the ledger know about, and what is true of them — with no way to change any of
* it. Repair stays a human decision made from these facts.
* @param deps - data sources.
* @returns the route handler.
*/
function createWorktreesHandler(deps) {
	return guarded(deps.log, async (_url, response) => {
		writeJson(response, 200, {
			ok: true,
			value: await deps.worktrees()
		});
	});
}
/**
* Build the single-report handler.
* @param deps - data sources.
* @returns the route handler.
*/
function createReportHandler(deps) {
	return guarded(deps.log, async (url, response) => {
		const id = url.searchParams.get("id") ?? "";
		if (!REPORT_ID.test(id)) {
			refuse(response, 400, "invalid-report-id");
			return;
		}
		const detail = await deps.report(id);
		if (detail === void 0) {
			refuse(response, 404, "unknown-report");
			return;
		}
		writeJson(response, 200, {
			ok: true,
			value: detail
		});
	});
}
//#endregion
//#region src/report/service.ts
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
/** Body size above which `report_read` returns a paged pointer instead of everything. */
const BODY_INLINE_LIMIT = 8e3;
/** How many characters of a body are shown when it exceeds the inline limit. */
const BODY_HEAD_LIMIT = 1200;
/**
* One token naming a bound working tree.
*
* The branch is the lease's identity, so it is what a listing shows; a detached
* tree has none, and there the directory name is the only stable handle. The
* full path stays in the digest for anyone who needs to act on it.
* @param worktree - the binding.
* @returns the label.
*/
function worktreeLabel(worktree) {
	if (worktree.branch !== void 0) return worktree.branch;
	return basename(worktree.path) || worktree.path;
}
/**
* Cut a body head to a character budget without splitting a surrogate pair.
*
* The budget is expressed in characters because that is what a model reads, but
* `slice` counts UTF-16 code units: a cut inside an astral character (an emoji, a
* rare CJK ideograph) leaves a lone surrogate that renders as a replacement
* glyph and can even corrupt the surrounding text. Backing up one unit when the
* cut lands on a high surrogate keeps the excerpt a valid string.
* @param body - the rendered body.
* @param budget - maximum characters to keep.
* @returns the head text and its line count.
*/
function bodyHead(body, budget) {
	if (body.length <= budget) return {
		text: body,
		lines: body.split("\n").length
	};
	let end = budget;
	const last = body.charCodeAt(end - 1);
	if (last >= 55296 && last <= 56319) end--;
	const text = body.slice(0, end);
	return {
		text,
		lines: text.split("\n").length
	};
}
/** Serialize one report for model-facing output. */
function renderFrontLine(front) {
	const parts = [
		`${front.report} [${front.status}] ${front.subject}`,
		`from=${front.from}`,
		`to=${front.to.length === 0 ? "-" : front.to.join(",")}`,
		`cc=${front.cc.length === 0 ? "-" : front.cc.join(",")}`,
		`authors=${front.authors.join(",")}`,
		`hops=${front.hops}`,
		`updated=${new Date(front.updated).toISOString()}`
	];
	if (front.task !== void 0) parts.push(`task=${front.task}`);
	if (front.worktree !== void 0) parts.push(`worktree=${worktreeLabel(front.worktree)}@${front.worktree.path}`);
	if (front.parent !== void 0) parts.push(`parent=${front.parent}`);
	if (front.children.length > 0) parts.push(`children=${front.children.join(",")}`);
	if (front.last !== void 0) parts.push(`last=${front.last.action}@${front.last.actor}`);
	return parts.join(" | ");
}
/** Derive the route projection from the authoritative hop stream. */
function projectRoute(hops) {
	const authors = [];
	const to = [];
	const cc = [];
	for (const hop of hops) {
		if (hop.action === "authored" || hop.action === "contributed") {
			if (!authors.includes(hop.actor)) authors.push(hop.actor);
		}
		if (hop.action === "sent" || hop.action === "forwarded") {
			for (const target of hop.to) if (!to.includes(target)) to.push(target);
		}
		if (hop.action === "cc" || hop.action === "copied") {
			for (const target of hop.to) if (!cc.includes(target)) cc.push(target);
		}
		if (hop.action === "transferred") {
			for (const target of hop.to) if (!to.includes(target)) to.push(target);
		}
	}
	const tail = hops.length === 0 ? void 0 : hops[hops.length - 1];
	return {
		to,
		cc,
		authors,
		hops: hops.length,
		...tail === void 0 ? {} : { last: {
			at: tail.at,
			action: tail.action,
			actor: tail.actor
		} }
	};
}
/** The report service. */
var ReportService = class ReportService {
	#host;
	#locks = /* @__PURE__ */ new Map();
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
	#repoLocks = /* @__PURE__ */ new Map();
	/**
	* @param host - host capabilities (agent lookup, display names).
	*/
	constructor(host) {
		this.#host = host;
	}
	/** Run one task under a key's mutex. */
	async #serialize(map, key, work) {
		const next = (map.get(key) ?? Promise.resolve()).then(work, work);
		map.set(key, next.then(() => void 0, () => void 0));
		return next;
	}
	/** Run one mutation under the report's mutex. */
	async #withLock(report, work) {
		return await this.#serialize(this.#locks, report, work);
	}
	/** Run one decision under the repository's mutex. */
	async #withRepoLock(key, work) {
		return await this.#serialize(this.#repoLocks, key, work);
	}
	/** Append one hop, then refresh the derived digest fields. */
	async #record(report, hop, options = {}) {
		await appendHop(report, hop);
		return await this.#sync(report, options);
	}
	/**
	* Recompute the derived front-matter fields from the hop stream.
	* @param report - report identifier.
	* @param options - `touch: false` keeps the digest's `updated` stamp, for an
	* administrative hop that must not make a concluded report look active again.
	*/
	async #sync(report, options = {}) {
		const current = await readReport(report);
		if (current === void 0) throw new Error(`report-ledger: report ${report} does not exist`);
		const projected = projectRoute(await readHops(report));
		const front = {
			...current.front,
			...projected,
			updated: options.touch === false ? current.front.updated : Date.now()
		};
		await writeReport({
			front,
			body: current.body
		}, report);
		return front;
	}
	/** Read one report or throw a model-legible error. */
	async #load(report) {
		const found = await readReport(report);
		if (found === void 0) throw new Error(`report-ledger: no report ${JSON.stringify(report)} in the ledger`);
		return found;
	}
	/** Deliver a digest and record one arrival hop per recipient that received it. */
	async #deliver(front, targets, mode, actor) {
		const outcomes = await deliver(this.#host, front, reportPath(front.report), targets, mode);
		const arrivals = outcomes.filter((outcome) => outcome.status === "delivered");
		if (arrivals.length === 0) return outcomes;
		const at = Date.now();
		for (const arrival of arrivals) await appendHop(front.report, {
			at,
			actor,
			action: "delivered",
			to: [arrival.targetId],
			note: mode
		});
		await this.#sync(front.report);
		return outcomes;
	}
	/**
	* Create a report and optionally hand it to its first recipients.
	* @param input - authoring input.
	* @returns the created digest and any immediate delivery outcomes.
	*/
	async author(input) {
		const subject = input.subject.trim();
		if (subject === "") throw new Error("report-ledger: report_author requires a non-empty subject");
		const allocated = input.reportId === void 0;
		const report = input.reportId ?? await allocateId();
		const now = Date.now();
		try {
			if (!isValidReportId(report)) throw new Error(`report-ledger: ${JSON.stringify(report)} is not a usable report id (expected the form R-0001)`);
			const fromName = await this.#host.describe(input.actor);
			await writeReport({
				front: {
					report,
					subject,
					status: "open",
					from: input.actor,
					...fromName === void 0 ? {} : { fromName },
					to: [],
					cc: [],
					authors: [],
					created: now,
					updated: now,
					children: [],
					artifacts: [...input.artifacts ?? []],
					hops: 0,
					...input.parent === void 0 ? {} : { parent: input.parent },
					...input.task === void 0 ? {} : { task: input.task },
					...input.worktree === void 0 ? {} : { worktree: input.worktree }
				},
				body: input.body
			}, report);
		} catch (error) {
			if (allocated) await discardUnwrittenId(report);
			throw error;
		}
		await this.#record(report, {
			at: now,
			actor: input.actor,
			action: "authored",
			to: []
		});
		if (input.worktree !== void 0) await this.#record(report, {
			at: Date.now(),
			actor: input.actor,
			action: "leased",
			to: [],
			note: `${input.worktree.branch ?? "(detached HEAD)"} @ ${input.worktree.path}`
		});
		if (input.parent !== void 0) {
			if (await readReport(input.parent) !== void 0) await this.#withLock(input.parent, async () => {
				const latest = await this.#load(input.parent);
				const children = latest.front.children.includes(report) ? latest.front.children : [...latest.front.children, report];
				await writeReport({
					front: {
						...latest.front,
						children,
						updated: Date.now()
					},
					body: latest.body
				}, input.parent);
			});
		}
		let outcomes = [];
		if ((input.to?.length ?? 0) > 0) {
			const sent = await this.#record(report, {
				at: Date.now(),
				actor: input.actor,
				action: "sent",
				to: [...input.to ?? []]
			});
			outcomes = await this.#deliver(sent, input.to ?? [], "wakeup", input.actor);
		}
		const addressed = input.to ?? [];
		const copies = [...new Set((input.cc ?? []).filter((target) => !addressed.includes(target)))];
		if (copies.length > 0) {
			const copied = await this.#record(report, {
				at: Date.now(),
				actor: input.actor,
				action: "cc",
				to: copies
			});
			outcomes = [...outcomes, ...await this.#deliver(copied, copies, "quiet", input.actor)];
		}
		return {
			front: (await this.#load(report)).front,
			outcomes
		};
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
	static owns(front, actor) {
		return actor === front.from || front.authors.includes(actor);
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
	#assertOwner(front, actor, verb, gerund) {
		if (ReportService.owns(front, actor)) return;
		const owners = [.../* @__PURE__ */ new Set([front.from, ...front.authors])];
		throw new Error(`report-ledger: ${actor} may not ${verb} ${front.report} — ${gerund} is the owner's act, not a reader's. Ask one of its authors to do it: ${owners.join(", ")}`);
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
	#assertRecipient(front, actor) {
		const recipients = [.../* @__PURE__ */ new Set([
			front.from,
			...front.authors,
			...front.to,
			...front.cc
		])];
		if (recipients.includes(actor)) return;
		throw new Error(`report-ledger: ${actor} may not acknowledge ${front.report} — a receipt is a recipient's confirmation, not a bystander's. ` + (recipients.length === 0 ? "It has not been addressed to anyone yet." : `It was addressed to: ${recipients.join(", ")}`));
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
	async #reopenIfClosed(report, actor) {
		if ((await this.#load(report)).front.status !== "closed") return;
		await this.#record(report, {
			at: Date.now(),
			actor,
			action: "reopened",
			to: []
		});
		const fresh = await this.#load(report);
		await writeReport({
			front: {
				...fresh.front,
				status: "open",
				updated: Date.now()
			},
			body: fresh.body
		}, report);
	}
	/**
	* Append a co-author's contribution to an existing report.
	* @param report - report identifier.
	* @param actor - contributing session id.
	* @param body - the contribution text.
	* @param note - optional hop note.
	* @returns the refreshed digest.
	*/
	async contribute(report, actor, body, note) {
		const text = body.trim();
		if (text === "") throw new Error("report-ledger: report_contribute requires non-empty content");
		const header = `\n\n---\n\n### contribution by ${await this.#host.describe(actor) ?? actor} at ${(/* @__PURE__ */ new Date()).toISOString()}\n\n`;
		return this.#withLock(report, async () => {
			await this.#load(report);
			await this.#reopenIfClosed(report, actor);
			await appendFile(reportPath(report), `${header}${text}\n`, "utf8");
			return {
				front: await this.#record(report, {
					at: Date.now(),
					actor,
					action: "contributed",
					to: [],
					...note === void 0 ? {} : { note }
				}),
				outcomes: []
			};
		});
	}
	/**
	* Address a report to recipients and wake them.
	* @param report - report identifier.
	* @param actor - sending session id.
	* @param targets - recipient session ids.
	* @param note - optional hop note.
	* @returns the refreshed digest and delivery outcomes.
	*/
	async send(report, actor, targets, note) {
		if (targets.length === 0) throw new Error("report-ledger: report_send requires at least one recipient");
		return this.#withLock(report, async () => {
			await this.#load(report);
			await this.#reopenIfClosed(report, actor);
			const front = await this.#record(report, {
				at: Date.now(),
				actor,
				action: "sent",
				to: [...targets],
				...note === void 0 ? {} : { note }
			});
			const outcomes = await this.#deliver(front, targets, "wakeup", actor);
			return {
				front: (await this.#load(report)).front,
				outcomes
			};
		});
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
	async transfer(report, actor, from, to, note) {
		if (from.trim() === "" || to.trim() === "") throw new Error("report-ledger: a transfer needs both sessions");
		if (from === to) throw new Error("report-ledger: a transfer to the same session would not move anything");
		return this.#withLock(report, async () => {
			const current = await this.#load(report);
			const hops = await readHops(report);
			const owed = pendingTargets(hops);
			if (!owed.includes(from)) throw new Error(`report-ledger: ${report} owes nothing to ${from}; a transfer moves an outstanding hand-off, and the sessions still owed it are: ${owed.length === 0 ? "(none)" : owed.join(", ")}`);
			if (!ReportService.owns(current.front, actor) && actor !== from) throw new Error(`report-ledger: ${actor} may not transfer ${report}'s hand-off from ${from} — moving it is either the owner's act or the act of the session that owes it`);
			const mode = pendingMode(hops, from);
			await this.#reopenIfClosed(report, actor);
			const front = await this.#record(report, {
				at: Date.now(),
				actor,
				action: "transferred",
				from,
				to: [to],
				...note === void 0 ? {} : { note }
			});
			const outcomes = await this.#deliver(front, [to], mode, actor);
			return {
				front: (await this.#load(report)).front,
				outcomes
			};
		});
	}
	/**
	* Copy a report to recipients without waking them.
	* @param report - report identifier.
	* @param actor - copying session id.
	* @param targets - carbon-copy recipient session ids.
	* @param note - optional hop note.
	* @returns the refreshed digest and delivery outcomes.
	*/
	async carbonCopy(report, actor, targets, note) {
		if (targets.length === 0) throw new Error("report-ledger: report_cc requires at least one recipient");
		return this.#withLock(report, async () => {
			await this.#load(report);
			await this.#reopenIfClosed(report, actor);
			const front = await this.#record(report, {
				at: Date.now(),
				actor,
				action: "cc",
				to: [...targets],
				...note === void 0 ? {} : { note }
			});
			const outcomes = await this.#deliver(front, targets, "quiet", actor);
			return {
				front: (await this.#load(report)).front,
				outcomes
			};
		});
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
	async forward(report, actor, targets, mode, note) {
		if (targets.length === 0) throw new Error("report-ledger: report_forward requires at least one target");
		return this.#withLock(report, async () => {
			await this.#load(report);
			await this.#reopenIfClosed(report, actor);
			const front = await this.#record(report, {
				at: Date.now(),
				actor,
				action: mode === "copy" ? "copied" : "forwarded",
				to: [...targets],
				...note === void 0 ? {} : { note }
			});
			const outcomes = await this.#deliver(front, targets, mode === "copy" ? "quiet" : "wakeup", actor);
			return {
				front: (await this.#load(report)).front,
				outcomes
			};
		});
	}
	/**
	* Read a report's digest, body, and complete transfer path.
	* @param report - report identifier.
	* @param actor - reading session id.
	* @returns the model-facing rendering.
	*/
	async read(report, actor) {
		return await this.#withLock(report, async () => {
			const found = await this.#load(report);
			const hops = await readHops(report);
			await this.#record(report, {
				at: Date.now(),
				actor,
				action: "read",
				to: []
			}, { touch: false });
			const path = reportPath(report);
			const body = found.body.trim();
			let rendered = body;
			if (body.length > BODY_INLINE_LIMIT) {
				const head = bodyHead(body, BODY_HEAD_LIMIT);
				const resume = (await bodyStartLine(report) ?? 1) + head.lines - 1;
				rendered = `${head.text}\n\n… body truncated (${body.length} chars total). The next unread line is ${resume}; read the rest with the read tool at ${path} using offset=${resume}.`;
			}
			const route = hops.length === 0 ? "  (no hops recorded)" : hops.map((hop) => {
				const targets = hop.to.length === 0 ? "" : ` -> ${hop.to.join(",")}`;
				const note = hop.note === void 0 ? "" : `  # ${hop.note}`;
				return `  ${new Date(hop.at).toISOString()}  ${hop.action.padEnd(11)} by ${hop.actor}${targets}${note}`;
			}).join("\n");
			const pending = pendingTargets(hops);
			const worktree = found.front.worktree;
			const lease = worktree === void 0 ? [] : [`lease=${leaseState(hops)} ${worktree.branch ?? "(detached HEAD)"} @ ${worktree.path} (${worktree.allocated === true ? "allocated by the ledger" : "adopted"})`];
			return [
				renderFrontLine(found.front),
				...lease,
				`body=${path}`,
				"",
				"## transfer path",
				route,
				...pending.length === 0 ? [] : ["", `## still pending delivery to: ${pending.join(", ")}`],
				"",
				"## body",
				rendered
			].join("\n");
		});
	}
	/**
	* List report digests, optionally filtered to ones touching one session.
	* @param filter - listing filter.
	* @returns one row per matching report, newest first.
	*/
	async list(filter = {}) {
		const all = await listReports();
		const session = filter.session;
		const task = filter.task?.trim().toLowerCase();
		const worktree = filter.worktree?.trim().toLowerCase();
		const matching = all.filter((front) => {
			if (filter.status !== void 0 && front.status !== filter.status) return false;
			if (task !== void 0 && task !== "" && !(front.task ?? "").toLowerCase().includes(task)) return false;
			if (worktree !== void 0 && worktree !== "") {
				if (front.worktree === void 0) return false;
				if (!`${front.worktree.branch ?? ""} ${front.worktree.path}`.toLowerCase().includes(worktree)) return false;
			}
			if (session === void 0) return true;
			return front.from === session || front.to.includes(session) || front.cc.includes(session) || front.authors.includes(session);
		});
		const limit = filter.limit === void 0 || filter.limit <= 0 ? 50 : Math.min(filter.limit, 200);
		return matching.slice(0, limit).map((front) => ({
			report: front.report,
			status: front.status,
			subject: front.subject,
			from: front.from,
			to: front.to,
			cc: front.cc,
			hops: front.hops,
			...front.task === void 0 ? {} : { task: front.task },
			...front.worktree === void 0 ? {} : { worktree: worktreeLabel(front.worktree) },
			...front.last === void 0 ? {} : { last: `${front.last.action}@${front.last.actor}` },
			updated: front.updated
		}));
	}
	/**
	* Mark a report acknowledged by one recipient.
	* @param report - report identifier.
	* @param actor - acknowledging session id.
	* @param note - optional note.
	* @returns the refreshed digest.
	*/
	async acknowledge(report, actor, note) {
		return this.#withLock(report, async () => {
			const current = await this.#load(report);
			this.#assertRecipient(current.front, actor);
			const front = await this.#record(report, {
				at: Date.now(),
				actor,
				action: "acked",
				to: [],
				...note === void 0 ? {} : { note }
			});
			if (current.front.status === "open") await writeReport({
				front: {
					...front,
					status: "acked",
					updated: Date.now()
				},
				body: current.body
			}, report);
			return {
				front: (await this.#load(report)).front,
				outcomes: []
			};
		});
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
	async close(report, actor, note, options = {}) {
		return this.#withLock(report, async () => {
			const current = await this.#load(report);
			this.#assertOwner(current.front, actor, "close", "closing");
			const binding = current.front.worktree;
			if (binding !== void 0 && leaseState(await readHops(report)) === "held") await this.#record(report, {
				at: Date.now(),
				actor,
				action: "released",
				to: [],
				note: "released by closing the report"
			});
			let outcome;
			if (binding !== void 0) if (options.worktree !== "remove-if-clean") outcome = { action: "kept" };
			else {
				const repo = await resolveRepo(binding.path);
				if (repo === void 0) outcome = {
					action: "refused",
					detail: `${binding.path} is no longer inside a git repository`
				};
				else {
					const removed = await removeWorktree(repo, binding.path);
					outcome = removed.ok ? { action: "removed" } : {
						action: "refused",
						detail: removed.stderr.trim()
					};
				}
			}
			const disposition = outcome === void 0 ? void 0 : outcome.action === "removed" ? "working tree removed" : outcome.action === "kept" ? "working tree kept" : `working tree kept: ${outcome.detail ?? "removal refused"}`;
			if (outcome?.action === "removed") await this.#record(report, {
				at: Date.now(),
				actor,
				action: "reclaimed",
				to: [],
				note: `checkout ${binding?.path ?? ""} removed at the owner's request`
			});
			const closedNote = [note, disposition].filter((part) => part !== void 0 && part !== "").join("; ");
			await this.#record(report, {
				at: Date.now(),
				actor,
				action: "closed",
				to: [],
				...closedNote === "" ? {} : { note: closedNote }
			});
			const fresh = await this.#load(report);
			await writeReport({
				front: {
					...fresh.front,
					status: "closed",
					updated: Date.now()
				},
				body: fresh.body
			}, report);
			return {
				front: (await this.#load(report)).front,
				outcomes: [],
				...outcome === void 0 ? {} : { worktree: outcome }
			};
		});
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
	async lease(report, actor, binding) {
		const repo = await resolveRepo(binding.path) ?? (binding.repo === void 0 ? void 0 : await resolveRepo(binding.repo));
		const key = compareKey(repo?.commonDir ?? binding.path);
		return await this.#withRepoLock(key, async () => await this.#withLock(report, async () => {
			const current = await this.#load(report);
			this.#assertOwner(current.front, actor, "lease", "leasing");
			const verdict = await evaluateLease({
				binding,
				repo,
				report,
				digests: await listReports(),
				hopsOf: async (id) => await readHops(id)
			});
			if (verdict.kind === "refused") throw new Error(`report-ledger: ${verdict.refusal.message}`);
			const claim = verdict.binding;
			await writeReport({
				front: {
					...current.front,
					worktree: claim,
					updated: Date.now()
				},
				body: current.body
			}, report);
			return {
				front: await this.#record(report, {
					at: Date.now(),
					actor,
					action: "leased",
					to: [],
					note: `${claim.branch ?? "(detached HEAD)"} @ ${claim.path}`
				}),
				outcomes: []
			};
		}));
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
	async release(report, actor, note) {
		return await this.#withLock(report, async () => {
			const current = await this.#load(report);
			this.#assertOwner(current.front, actor, "release", "releasing");
			if (current.front.worktree === void 0) throw new Error(`report-ledger: ${report} is not bound to a working tree, so there is nothing to release`);
			if (leaseState(await readHops(report)) !== "held") throw new Error(`report-ledger: ${report} does not currently hold its working tree, so there is nothing to release (a claim is released once; closing a report releases it too)`);
			return {
				front: await this.#record(report, {
					at: Date.now(),
					actor,
					action: "released",
					to: [],
					...note === void 0 ? {} : { note }
				}),
				outcomes: []
			};
		});
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
	async prepareWorktree(input) {
		return await this.#withRepoLock(compareKey(input.repo.commonDir), async () => {
			const plan = await planAllocation({
				report: input.report,
				subject: input.subject,
				repo: input.repo,
				digests: await listReports(),
				hopsOf: async (id) => await readHops(id),
				isLive: (sessionId) => this.#host.getAgent(sessionId) !== void 0
			}, input.settings);
			if ("kind" in plan) throw new Error(`report-ledger: ${plan.message}`);
			for (const gone of plan.stale) await this.#recordVanished(input.actor, gone);
			if (plan.reclaimed !== void 0) await this.#reclaim(input.actor, plan.reclaimed);
			const created = await this.#createWorktree(input.repo, plan.binding, input.base, input.settings.relativePaths);
			if (!created.ok) throw new Error(`report-ledger: ${created.reason}`);
			const head = await headOf(plan.binding.path);
			return {
				binding: {
					...plan.binding,
					...head === void 0 ? {} : { head }
				},
				retained: plan.retained,
				reclaimSkipped: plan.reclaimSkipped,
				stale: plan.stale,
				...plan.reclaimed === void 0 ? {} : { reclaimed: plan.reclaimed }
			};
		});
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
	async #createWorktree(repo, binding, base, relativePaths) {
		const first = await addWorktree({
			repo,
			path: binding.path,
			branch: binding.branch,
			base,
			relativePaths
		});
		if (first.ok) return { ok: true };
		if (classifyGitRefusal(first.stderr) !== "branch-exists") return {
			ok: false,
			reason: `could not create a working tree at ${binding.path}: ${first.stderr.trim()}`
		};
		const retry = await addWorktree({
			repo,
			path: binding.path,
			branch: binding.branch,
			checkoutExisting: true,
			relativePaths
		});
		if (retry.ok) return { ok: true };
		return {
			ok: false,
			reason: `the branch ${binding.branch} already existed and could not be checked out at ${binding.path}: ${retry.stderr.trim()}`
		};
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
	async #recordVanished(actor, gone) {
		await this.#withLock(gone.report, async () => {
			if (!reportExists(gone.report)) return;
			await this.#record(gone.report, {
				at: Date.now(),
				actor,
				action: "reclaimed",
				to: [],
				note: gone.detail === void 0 ? `checkout ${gone.path} was already gone; nothing to remove` : `checkout ${gone.path} ${gone.detail}; nothing to remove`
			}, { touch: false });
		});
	}
	/**
	* Clear a checkout whose claim already ended, and record that it happened.
	*
	* Removal goes through git without a force flag, so an unclean tree refuses
	* here exactly as it would for a human — and that refusal aborts the
	* allocation rather than being stepped over, because taking something away is
	* never the safe default.
	*
	* The hop is recorded with `touch: false`: clearing litter must not make a
	* concluded report look like it just became active and float it to the top of
	* every listing. It is still recorded, because taking something away from
	* another report is precisely the act an audit exists for.
	*/
	async #reclaim(actor, target) {
		const reality = await inspectCheckout(target.path);
		const changed = reclaimRefusal(target, reality);
		if (reality.repo === void 0 || changed !== void 0) throw new Error(`report-ledger: refusing to reclaim ${target.path} from ${target.report} — ${changed ?? "its repository could not be resolved"}; nothing was removed`);
		if (!await isWorktreeClean(target.path)) throw new Error(`report-ledger: refusing to reclaim ${target.path} from ${target.report} — it has uncommitted work; nothing was removed`);
		const removed = await removeWorktree(reality.repo, target.path);
		if (!removed.ok) throw new Error(`report-ledger: refusing to reclaim ${target.path} from ${target.report} — ${removed.stderr.trim()}`);
		await this.#withLock(target.report, async () => {
			if (!reportExists(target.report)) return;
			await this.#record(target.report, {
				at: Date.now(),
				actor,
				action: "reclaimed",
				to: [],
				note: `checkout ${target.path} cleared to stay within the retained budget`
			}, { touch: false });
		});
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
	async discardWorktree(binding) {
		const repo = await resolveRepo(binding.path);
		if (repo === void 0) return false;
		return (await removeWorktree(repo, binding.path)).ok;
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
	async provision(input) {
		const cwd = this.#host.selfCwd?.(input.actor);
		if (cwd === void 0) throw new Error(`report-ledger: cannot allocate a working tree for ${input.actor} — the session has no working directory, so there is no repository to allocate one in`);
		const repo = await resolveRepo(cwd);
		if (repo === void 0) throw new Error(`report-ledger: ${cwd} is not inside a git repository, so there is no repository to allocate a working tree in`);
		const base = await headOf(cwd);
		if (base === void 0) throw new Error(`report-ledger: ${cwd} has no commit yet, so there is nothing to branch a working tree from`);
		const report = await allocateId();
		try {
			return {
				report,
				prepared: await this.prepareWorktree({
					report,
					subject: input.subject,
					actor: input.actor,
					repo,
					base,
					settings: input.settings
				})
			};
		} catch (error) {
			await discardUnwrittenId(report);
			throw error;
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
	async rollbackProvision(provisioned) {
		return {
			worktree: await this.discardWorktree(provisioned.prepared.binding),
			id: await discardUnwrittenId(provisioned.report)
		};
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
	async amend(report, actor, patch) {
		return this.#withLock(report, async () => {
			const current = await this.#load(report);
			if (!ReportService.owns(current.front, actor)) {
				const owners = [.../* @__PURE__ */ new Set([current.front.from, ...current.front.authors])];
				throw new Error(`report-ledger: ${actor} may not amend ${report} — correcting a report is its owner's act. Ask one of its authors to amend it: ${owners.join(", ")}`);
			}
			const changes = [];
			const next = {};
			if (patch.subject !== void 0) {
				const subject = patch.subject.trim();
				if (subject === "") throw new Error("report-ledger: an amendment cannot blank the subject");
				if (subject !== current.front.subject) {
					next.subject = subject;
					changes.push(`subject ${JSON.stringify(current.front.subject)} -> ${JSON.stringify(subject)}`);
				}
			}
			if (patch.task !== void 0) {
				const task = patch.task.trim();
				const before = current.front.task;
				if (task !== (before ?? "")) {
					next.task = task;
					changes.push(`task ${JSON.stringify(before ?? "")} -> ${JSON.stringify(task)}`);
				}
			}
			if (patch.artifacts !== void 0) {
				const before = current.front.artifacts;
				const after = patch.artifacts.map((entry) => entry.trim()).filter((entry) => entry !== "");
				if (before.join("\n") !== after.join("\n")) {
					next.artifacts = after;
					changes.push(`artifacts ${before.length} -> ${after.length}`);
				}
			}
			const replacingBody = patch.replaceBody === true;
			if (patch.body !== void 0) {
				if (patch.body.trim() === "") throw new Error("report-ledger: an amendment cannot send an empty body");
				changes.push(replacingBody ? "body replaced" : "body amended (appended)");
			} else if (replacingBody) throw new Error("report-ledger: replaceBody was set without a body");
			if (changes.length === 0) throw new Error(`report-ledger: nothing to amend on ${report} — the provided values already match`);
			await this.#reopenIfClosed(report, actor);
			if (patch.body !== void 0) if (replacingBody) await writeReport({
				front: (await this.#load(report)).front,
				body: patch.body
			}, report);
			else {
				const header = `\n\n---\n\n### amendment by ${await this.#host.describe(actor) ?? actor} at ${(/* @__PURE__ */ new Date()).toISOString()}\n\n`;
				await appendFile(reportPath(report), `${header}${patch.body.trim()}\n`, "utf8");
			}
			if (next.subject !== void 0 || next.task !== void 0 || next.artifacts !== void 0) {
				const base = await this.#load(report);
				const { task: previousTask, ...rest } = base.front;
				const task = next.task === void 0 ? previousTask : next.task === "" ? void 0 : next.task;
				await writeReport({
					front: {
						...rest,
						...next.subject === void 0 ? {} : { subject: next.subject },
						...next.artifacts === void 0 ? {} : { artifacts: next.artifacts },
						updated: Date.now(),
						...task === void 0 ? {} : { task }
					},
					body: base.body
				}, report);
			}
			const summary = [...changes, ...patch.note === void 0 ? [] : [patch.note]].join("; ");
			return {
				front: await this.#record(report, {
					at: Date.now(),
					actor,
					action: "amended",
					to: [],
					note: summary
				}),
				outcomes: []
			};
		});
	}
	/**
	* Deliver every held hand-off owed to one session that just became resident.
	* @param sessionId - the session that became resident.
	* @returns the deliveries that succeeded.
	*/
	async flushForAgent(sessionId) {
		const outcomes = [];
		const errors = [];
		for (const digest of await listReports()) {
			const report = digest.report;
			try {
				await this.#withLock(report, async () => {
					const current = await readReport(report);
					if (current === void 0) return;
					const hops = await readHops(report);
					if (!pendingTargets(hops).includes(sessionId)) return;
					outcomes.push(...await this.#deliver(current.front, [sessionId], pendingMode(hops, sessionId), "report-ledger"));
				});
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length > 0) throw new AggregateError(errors, `report-ledger: deferred delivery to ${sessionId} failed for ${errors.length} report(s)`);
		return outcomes;
	}
};
/** Render one digest row for model-facing listing output. */
function renderRow(row) {
	const last = row.last === void 0 ? "-" : row.last;
	const task = row.task === void 0 ? "" : ` task=${row.task}`;
	const worktree = row.worktree === void 0 ? "" : ` wt=${row.worktree}`;
	return `${row.report} [${row.status}] ${row.subject}${task}${worktree} | from=${row.from} to=${row.to.length === 0 ? "-" : row.to.join(",")} cc=${row.cc.length === 0 ? "-" : row.cc.join(",")} hops=${row.hops} last=${last}`;
}
//#endregion
//#region src/report/timeline.ts
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
/**
* Collect the checkouts a set of reports is bound to.
*
* Only a report that carries a binding costs a hop read, so a ledger with no
* working trees in play pays one pass over the digests and nothing more.
* @param reports - the report digests in play.
* @param readHops - read one report's hops.
* @returns one lane per bound report.
*/
async function worktreeLanes(reports, readHops) {
	const lanes = [];
	for (const front of reports) {
		const binding = front.worktree;
		if (binding === void 0) continue;
		lanes.push({
			report: front.report,
			path: binding.path,
			...binding.branch === void 0 ? {} : { branch: binding.branch },
			allocated: binding.allocated === true,
			state: leaseState(await readHops(front.report))
		});
	}
	return lanes.sort((left, right) => (left.branch ?? left.path).localeCompare(right.branch ?? right.path) || left.report.localeCompare(right.report));
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
function buildSubtree(records, root, titles = /* @__PURE__ */ new Map()) {
	const byId = /* @__PURE__ */ new Map();
	const children = /* @__PURE__ */ new Map();
	for (const record of records) {
		const id = record.header?.id;
		if (typeof id !== "string" || id === "") continue;
		byId.set(id, record);
		const parent = record.header.parentSession;
		if (typeof parent === "string" && parent !== "") {
			const bucket = children.get(parent);
			if (bucket === void 0) children.set(parent, [record]);
			else bucket.push(record);
		}
	}
	if (!byId.has(root)) return [];
	for (const bucket of children.values()) bucket.sort((left, right) => {
		return (left.header.createdAt ?? 0) - (right.header.createdAt ?? 0) || left.header.id.localeCompare(right.header.id);
	});
	const nodes = [];
	const visited = /* @__PURE__ */ new Set();
	const walk = (id, depth) => {
		if (visited.has(id)) return;
		visited.add(id);
		const record = byId.get(id);
		if (record === void 0) return;
		const header = record.header;
		const title = titles.get(id);
		nodes.push({
			id,
			depth,
			delegated: header.origin === "subagent" || (header.delegationDepth ?? 0) > 0,
			live: record.live === true,
			...typeof header.parentSession === "string" && header.parentSession !== "" ? { parentId: header.parentSession } : {},
			...title === void 0 ? {} : { title },
			...typeof header.agentPreset === "string" ? { agentPreset: header.agentPreset } : {},
			...typeof header.createdAt === "number" ? { createdAt: header.createdAt } : {}
		});
		for (const child of children.get(id) ?? []) walk(child.header.id, depth + 1);
	};
	walk(root, 0);
	return nodes;
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
function reportsForSubtree(reports, subtree) {
	const members = new Set(subtree.map((node) => node.id));
	return reports.filter((front) => front.from !== void 0 && (members.has(front.from) || front.to.some((id) => members.has(id)) || front.cc.some((id) => members.has(id)) || front.authors.some((id) => members.has(id)))).slice().sort((left, right) => right.updated - left.updated || right.report.localeCompare(left.report));
}
/**
* Attach resolved titles to subtree nodes.
* @param nodes - nodes built without titles.
* @param titles - resolved display titles, keyed by session id.
* @returns the nodes with titles where one was found.
*/
function withTitles(nodes, titles) {
	return nodes.map((node) => {
		const title = titles.get(node.id);
		return title === void 0 ? node : {
			...node,
			title
		};
	});
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
async function buildTimeline(deps, root) {
	const bare = buildSubtree(await deps.listSessionRecords(), root);
	const sessions = withTitles(bare, bare.length === 0 ? /* @__PURE__ */ new Map() : await deps.readTitles(bare.map((node) => node.id)));
	const reports = reportsForSubtree(await deps.listReports(), sessions);
	const worktrees = await worktreeLanes(reports, deps.readHops);
	return {
		root,
		generatedAt: Date.now(),
		sessions,
		reports,
		worktrees
	};
}
//#endregion
//#region src/report/assets.ts
/**
* What one session still owns in the ledger.
*
* A handover needs an answer no single file holds: the reports this session is
* responsible for, the checkouts its ownership is holding, and the hand-offs it
* has been addressed but never received. All three are derived from the same two
* streams the rest of the plugin reads — the digests for identity, the hop stream
* for state — so a handover can never describe an obligation the ledger does not
* contain, and a hand-edited digest cannot invent one.
*
* Pure on purpose: enumeration is the part that decides what a retirement will
* touch, so it is checked deterministically rather than inferred from a live run.
*
* @module dsh-report-ledger/report/assets
*/
/**
* Whether a session owns a digest.
*
* Kept identical to the service's ownership rule — originator or co-author — so a
* handover never lists something the service would refuse to let the session act
* on, and never omits something it would allow.
* @param front - the report digest.
* @param session - session id.
* @returns true when the session may act as an owner.
*/
function owns(front, session) {
	return front.from === session || front.authors.includes(session);
}
/**
* Whether a report could possibly concern a session.
*
* A cheap prefilter, not an authority check: a session can only own what names it
* as originator or co-author, and can only be owed what addressed it. Requiring
* the hop stream for every report in the ledger would make a handover read the
* whole ledger; this narrows it to the handful that can matter.
* @param front - the report digest.
* @param session - session id.
* @returns true when the digest names the session.
*/
function mentions(front, session) {
	return owns(front, session) || front.to.includes(session) || front.cc.includes(session);
}
/**
* Enumerate what one session still holds.
* @param pieces - the reports to scan, already narrowed by {@link mentions}.
* @param session - the session whose assets are wanted.
* @returns its owned open reports, the checkouts among them, and what it is owed.
*/
function assetsOf(pieces, session) {
	const owned = [];
	const checkouts = [];
	const owed = [];
	for (const piece of pieces) {
		if (owns(piece.front, session) && piece.front.status !== "closed") {
			owned.push(piece.front.report);
			if (leaseState(piece.hops) === "held") checkouts.push(piece.front.report);
		}
		if (pendingTargets(piece.hops).includes(session)) owed.push({
			report: piece.front.report,
			status: piece.front.status
		});
	}
	return {
		session,
		owned,
		checkouts,
		owed
	};
}
//#endregion
//#region src/report/tools.ts
/**
* The model-facing tools of the report ledger.
*
* Fifteen tools are registered by default and sixteen when the worktree
* feature is on: author, co-author, address, copy, forward, read, list,
* acknowledge, amend, close and release, plus discovery (peer_list) and creation
* (peer_start) — and report_lease, which exists only with the feature.
* `report_transfer` and `report_handover` are the retirement half: a hand-off that
* would otherwise stay owed forever, and the act of moving a departing session's
* assets to a successor. The
* report_* tools each record a hop, so the transfer path is a by-product of
* normal use rather than a separate discipline the model has to remember; the
* two peer_* tools read and create sessions and leave the ledger alone.
*
* @module dsh-report-ledger/report/tools
*/
/**
* The `worktree` parameter a tool advertises, or nothing at all.
*
* With the feature off the parameter does not exist, so a model cannot ask for
* something the deployment will not do. That is a better answer than a parameter
* that is always refused, and it keeps the promise that a deployment which does
* not want working trees pays nothing for them.
* @param runtime - the resolved feature state.
* @param description - what the parameter does, for this tool.
* @returns the parameter map to spread into a tool's parameters.
*/
function worktreeParam(runtime, description) {
	return runtime.enabled ? { worktree: {
		type: "boolean",
		description
	} } : {};
}
/** Provision a checkout, or explain that this deployment does not offer one. */
async function requireWorktree(runtime, service, input) {
	if (!runtime.enabled) throw new Error("report-ledger: this deployment has not enabled git worktree support, so no checkout can be allocated (the composition row sets worktree.enabled)");
	return await service.provision({
		subject: input.subject,
		actor: input.actor,
		settings: runtime.settings
	});
}
/**
* The lines describing a checkout that was just provisioned.
*
* The sharing sentence is not boilerplate. "Its own checkout" reads naturally as
* "its own environment", and the difference becomes real the moment an agent
* installs a hook or changes a setting — both of which reach every other
* checkout, because only the working directory and index are private.
* @param prepared - what provisioning produced.
* @returns the lines to append to the tool output.
*/
function renderProvision(prepared) {
	const lines = [`worktree=${prepared.binding.path} branch=${prepared.binding.branch}`];
	if (prepared.reclaimed !== void 0) lines.push(`reclaimed ${prepared.reclaimed.report}'s checkout at ${prepared.reclaimed.path} to stay within the retained budget; that report remains closed`);
	for (const skipped of prepared.reclaimSkipped) lines.push(`kept a checkout the budget would otherwise have cleared: ${skipped}`);
	for (const gone of prepared.stale) lines.push(`recorded that ${gone.report}'s checkout at ${gone.path} was already gone — nothing to remove`);
	lines.push("private: working directory and index. shared: config, hooks, the object store, and everything outside the checkouts.");
	return lines;
}
/** The line describing what a mutation did with a checkout on disk. */
function renderWorktreeOutcome(outcome, canRemove) {
	if (outcome === void 0) return void 0;
	if (outcome.action === "removed") return "working tree removed";
	if (outcome.action === "kept") return canRemove ? "working tree kept (close with worktree:\"remove-if-clean\" to remove it)" : "working tree kept";
	return `working tree NOT removed — git refused: ${outcome.detail ?? "unknown reason"}`;
}
/**
* Read every report that could concern one session, with its route.
*
* The digest decides which reports can matter ({@link mentions}); the hop stream
* decides what of it is still owed or held. Reading hops for the whole ledger
* would make a handover proportional to the ledger's history rather than to the
* assets being handed over.
* @param session - the session whose assets are wanted.
* @returns its owned open reports, the checkouts among them, and what it is owed.
*/
async function assetsFor(session) {
	const pieces = [];
	for (const front of await listReports()) {
		if (!mentions(front, session)) continue;
		pieces.push({
			front,
			hops: await readHops(front.report)
		});
	}
	return assetsOf(pieces, session);
}
/** The message of a thrown value, for a report line. */
function reasonOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* One line per asset a handover left untouched, so the caller is never told a
* partial success was complete.
* @param problems - collected failure lines.
* @returns the rendering, or undefined when there were none.
*/
function renderProblems(problems) {
	if (problems.length === 0) return void 0;
	return `problems (${problems.length}):\n${problems.map((line) => `  ${line}`).join("\n")}`;
}
/** Every tool's output is one compact text rendering of its canonical string value. */
const stringOutput = {
	schema: { type: "string" },
	render: (_args, value) => [{
		type: "text",
		text: String(value)
	}]
};
/**
* Read the acting session from a tool execution.
*
* A report is always authored by a session, so a call without an owning agent
* is rejected rather than attributed to nobody.
* @param exec - the tool run context.
* @returns the acting session id.
*/
function actorOf(exec) {
	const agent = exec.agent;
	if (agent === void 0 || typeof agent.id !== "string" || agent.id === "") throw new Error("report-ledger: this tool needs an owning agent session");
	return agent.id;
}
/** Render a mutation result as a compact model-facing report. */
function renderMutation(front, outcomes, prepared) {
	const lines = [`${front.report} [${front.status}] ${front.subject}`, `authors=${front.authors.join(",")} to=${front.to.length === 0 ? "-" : front.to.join(",")} cc=${front.cc.length === 0 ? "-" : front.cc.join(",")} hops=${front.hops}`];
	if (outcomes.length > 0) {
		const delivered = outcomes.filter((outcome) => outcome.status === "delivered").map((outcome) => outcome.targetId);
		const queued = outcomes.filter((outcome) => outcome.status === "queued").map((outcome) => outcome.targetId);
		if (delivered.length > 0) lines.push(`delivered to: ${delivered.join(", ")}`);
		if (queued.length > 0) lines.push(`held for absent recipient (delivered automatically when it becomes resident): ${queued.join(", ")}`);
	}
	if (prepared !== void 0) lines.push(...renderProvision(prepared));
	return lines.join("\n");
}
/** Derive a concise report subject from a task description. */
function subjectFrom(task, name) {
	const firstLine = task.split("\n").find((line) => line.trim() !== "")?.trim() ?? task.trim();
	const trimmed = firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine;
	return name === void 0 ? trimmed : `${name}: ${trimmed}`;
}
/**
* Render what was observed about a peer's first turn.
*
* A delivery certifies one thing only: the digest reached a live agent. It says
* nothing about whether a turn opened, and a turn that dies at step 1 — an
* unresolvable prompt variable, no model route, no composition — leaves exactly
* the same `delivered` hop and the same `live` roster row as a peer that is hard
* at work. This line is the difference between those two, and it exists because
* the difference cost a real caller a long, silent wait.
* @param receipt - the observation, or `undefined` when the host could not make one.
* @param windowMs - the observation window the receipt was bounded by.
* @returns one line for the tool output, or `undefined` when there is nothing to say.
*/
function describeReceipt(receipt, windowMs) {
	if (receipt === void 0) return void 0;
	if (receipt.kind === "running") return `the peer's first turn is running (observed for ${windowMs} ms after the assignment landed)`;
	if (receipt.kind === "failed") return `⚠ the peer's first turn FAILED before doing any work: ${receipt.error ?? receipt.reason ?? "unknown error"}`;
	if (receipt.kind === "unstarted") return "⚠ the assignment is in the peer's inbox but no turn opened — nothing is working on it";
	if (receipt.reason === "completed") return `the peer's first turn completed within ${windowMs} ms — read the report for its answer`;
	return `the peer's first turn ended within ${windowMs} ms (${receipt.reason ?? "settled"}) — nothing is working on it now`;
}
/**
* Render where the new peer landed in the workspace browser.
*
* This is the group the caller will find the peer under, so it is worth one
* line: a peer with no group is not broken, but an agent that goes looking for
* it in the wrong place — or a human who never sees it appear at all — is
* looking at a bookkeeping fact this line states in advance. `no-workspace`
* covers both "this deployment has no groups" and "this directory is not a
* registered workspace", which is why it is phrased as an absence rather than a
* problem; only a failed registration is flagged, and it names the reason.
* @param registration - what the host reported, or `undefined` when the host
* implements no registration at all.
* @returns one line for the tool output, or `undefined` when there is nothing to say.
*/
function renderWorkspace(registration) {
	if (registration === void 0) return void 0;
	if (registration.outcome === "registered") return `workspace group: ${registration.workspace ?? "registered"}`;
	if (registration.outcome === "failed") return `⚠ the peer was created but could not be listed under its workspace: ${registration.warning ?? "unknown error"}`;
}
/**
* Register the report and peer tools on the tools registry.
* @param ctx - the plugin context (`tools` injected).
* @param service - the report service backing the tools.
* @param peers - the peer service backing discovery and creation.
* @returns a disposer removing every registration.
*/
function registerReportTools(ctx, service, peers, worktree) {
	const disposers = [];
	disposers.push(ctx.tools.register(defineTool({
		name: "report_author",
		description: "Open a new report in the shared ledger — the primary way to hand work, findings, or a decision to another agent. A report carries a front-matter digest (subject, recipients, authors, hop count) that travels cheaply, while its body stays in the ledger and is opened on demand. Use this instead of a bare message whenever the content should still be findable later: a long task, a hand-off to a teammate, a status the requester will want to trace. `to` addresses recipients (they are woken); `cc` copies them quietly. Set `parent` to the report you are answering so the two are linked.",
		parameters: {
			subject: {
				type: "string",
				required: true,
				description: "One line naming what this report is about."
			},
			body: {
				type: "string",
				required: true,
				description: "The report content — findings, decisions, evidence, and what you need next."
			},
			to: {
				type: "array",
				items: { type: "string" },
				description: "Session ids to address. They are woken if resident, otherwise the hand-off is held and delivered when they return."
			},
			cc: {
				type: "array",
				items: { type: "string" },
				description: "Session ids to copy quietly: they receive the digest as context without being woken."
			},
			task: {
				type: "string",
				description: "Label grouping the reports of one collaboration."
			},
			artifacts: {
				type: "array",
				items: { type: "string" },
				description: "Paths, commits, or report ids this report refers to."
			},
			parent: {
				type: "string",
				description: "Report id this one answers, linking it into the thread."
			},
			...worktreeParam(worktree, "Allocate this report its own git checkout, on a branch named after the report. Only the working directory and index are private; config, hooks and the object store are shared with every other checkout.")
		},
		output: stringOutput,
		execute: async (args, exec) => {
			const input = args;
			const actor = actorOf(exec);
			const provisioned = input.worktree === true ? await requireWorktree(worktree, service, {
				subject: input.subject,
				actor
			}) : void 0;
			try {
				const result = await service.author({
					subject: input.subject,
					body: input.body,
					actor,
					...input.to === void 0 ? {} : { to: input.to },
					...input.cc === void 0 ? {} : { cc: input.cc },
					...input.task === void 0 ? {} : { task: input.task },
					...input.artifacts === void 0 ? {} : { artifacts: input.artifacts },
					...input.parent === void 0 ? {} : { parent: input.parent },
					...provisioned === void 0 ? {} : {
						reportId: provisioned.report,
						worktree: provisioned.prepared.binding
					}
				});
				return renderMutation(result.front, result.outcomes, provisioned?.prepared);
			} catch (error) {
				if (provisioned !== void 0) await service.rollbackProvision(provisioned);
				throw error;
			}
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "report_contribute",
		description: "Add your own section to a report another agent opened, as a credited co-author. Use it when a task needs several agents to write one report: each contributor appends without overwriting the others, and the contribution is recorded as a hop so the path shows who wrote what and when.",
		parameters: {
			report: {
				type: "string",
				required: true,
				description: "Report id to contribute to, e.g. R-0007."
			},
			body: {
				type: "string",
				required: true,
				description: "Your section of the report."
			},
			note: {
				type: "string",
				description: "Short note recorded on the hop."
			}
		},
		output: stringOutput,
		execute: async (args, exec) => {
			const input = args;
			const result = await service.contribute(input.report, actorOf(exec), input.body, input.note);
			return renderMutation(result.front, result.outcomes);
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "report_send",
		description: "Address an existing report to more recipients and wake them. Use it to pass a report upward to the agent that asked for it, or downward to an agent that must act on it. A recipient that is not currently resident is not an error: the hand-off is held in the ledger and delivered automatically when that session becomes resident again.",
		parameters: {
			report: {
				type: "string",
				required: true,
				description: "Report id to send."
			},
			to: {
				type: "array",
				required: true,
				items: { type: "string" },
				description: "Session ids to address."
			},
			note: {
				type: "string",
				description: "Short note recorded on the hop, e.g. why it is being sent now."
			}
		},
		output: stringOutput,
		execute: async (args, exec) => {
			const input = args;
			const result = await service.send(input.report, actorOf(exec), input.to, input.note);
			return renderMutation(result.front, result.outcomes);
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "report_cc",
		description: "Copy a report to further recipients without waking them. Use it to keep a peer, a sibling agent, or an upstream owner informed about work they are not being asked to act on. The copy is recorded on the transfer path, so the ledger always shows who holds a copy of what.",
		parameters: {
			report: {
				type: "string",
				required: true,
				description: "Report id to copy."
			},
			cc: {
				type: "array",
				required: true,
				items: { type: "string" },
				description: "Session ids to copy."
			},
			note: {
				type: "string",
				description: "Short note recorded on the hop."
			}
		},
		output: stringOutput,
		execute: async (args, exec) => {
			const input = args;
			const result = await service.carbonCopy(input.report, actorOf(exec), input.cc, input.note);
			return renderMutation(result.front, result.outcomes);
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "report_forward",
		description: "Pass an existing report onward to another agent, or duplicate it into another thread. `mode: \"forward\"` addresses the new recipients and wakes them, keeping the original author and history intact; `mode: \"copy\"` records a duplication to recipients who should hold it as reference without being woken. Both record the onward hop, so the full route including copies stays auditable.",
		parameters: {
			report: {
				type: "string",
				required: true,
				description: "Report id to pass on."
			},
			to: {
				type: "array",
				required: true,
				items: { type: "string" },
				description: "Session ids to forward or copy to."
			},
			mode: {
				type: "string",
				required: true,
				enum: ["forward", "copy"],
				description: "forward = addressed onward transfer (wakes); copy = duplication as reference (quiet)."
			},
			note: {
				type: "string",
				description: "Short note recorded on the hop."
			}
		},
		output: stringOutput,
		execute: async (args, exec) => {
			const input = args;
			const result = await service.forward(input.report, actorOf(exec), input.to, input.mode, input.note);
			return renderMutation(result.front, result.outcomes);
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "report_read",
		description: "Read one report: its digest, its COMPLETE transfer path (every hop with actor and time, and any recipient the report is still owed to), and its body. Use it when a digest told you a report exists and you need the substance, or when you need to know exactly how a report travelled and who holds copies. Reading is itself recorded as a hop.",
		parameters: { report: {
			type: "string",
			required: true,
			description: "Report id to read, e.g. R-0007."
		} },
		output: stringOutput,
		execute: async (args, exec) => {
			const input = args;
			return service.read(input.report, actorOf(exec));
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "report_list",
		description: "List report digests from the ledger — no bodies, so this is the cheap way to survey a long-running collaboration. Filter by `session` to see every report that touches one agent (authored, addressed, copied, or contributed to), by `status`, or by `task` to pull up one collaboration across every session it touched. The task label is matched case-insensitively and partially, so \"payments\" finds \"payments-rework\". `worktree` matches a working tree the report is or was bound to, by branch or path — a binding outlives a release, so this includes former leases. Use it to find the report id you need before reading it, or to check what a teammate is still waiting on.",
		parameters: {
			session: {
				type: "string",
				description: "Only reports touching this session id."
			},
			status: {
				type: "string",
				enum: [
					"open",
					"acked",
					"closed"
				],
				description: "Only reports in this state."
			},
			task: {
				type: "string",
				description: "Only reports carrying this collaboration label (partial match, case-insensitive)."
			},
			worktree: {
				type: "string",
				description: "Only reports bound to a working tree whose branch or path contains this text (partial match, case-insensitive)."
			},
			limit: {
				type: "integer",
				description: "Maximum rows (default 50, capped at 200)."
			}
		},
		output: stringOutput,
		execute: async (args) => {
			const input = args;
			const rows = await service.list({
				...input.session === void 0 ? {} : { session: input.session },
				...input.status === void 0 ? {} : { status: input.status },
				...input.task === void 0 ? {} : { task: input.task },
				...input.worktree === void 0 ? {} : { worktree: input.worktree },
				...input.limit === void 0 ? {} : { limit: input.limit }
			});
			if (rows.length === 0) {
				if (input.worktree !== void 0 && input.worktree.trim() !== "") return `no reports are bound to a working tree matching ${JSON.stringify(input.worktree)}`;
				return input.task === void 0 ? "no reports match" : `no reports carry a task matching ${JSON.stringify(input.task)}`;
			}
			const lines = [`${rows.length} report(s):`, ...rows.map(renderRow)];
			const taskFilter = input.task?.trim();
			if (taskFilter !== void 0 && taskFilter !== "") {
				let open = 0;
				let acked = 0;
				let closed = 0;
				for (const row of rows) if (row.status === "open") open += 1;
				else if (row.status === "acked") acked += 1;
				else if (row.status === "closed") closed += 1;
				lines.push(`task ${JSON.stringify(taskFilter)}: ${open} open, ${acked} acked, ${closed} closed`);
			}
			return lines.join("\n");
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "report_ack",
		description: "Acknowledge a report you received: record that you have taken it in, with an optional note. The hop is added to the transfer path and the report moves to `acked`, so the sender can see the loop is closed rather than guessing whether the hand-off landed.",
		parameters: {
			report: {
				type: "string",
				required: true,
				description: "Report id to acknowledge."
			},
			note: {
				type: "string",
				description: "What you are doing about it, or why no action is needed."
			}
		},
		output: stringOutput,
		execute: async (args, exec) => {
			const input = args;
			const result = await service.acknowledge(input.report, actorOf(exec), input.note);
			return renderMutation(result.front, result.outcomes);
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "report_close",
		description: "Conclude a report — record that the matter is finished so the ledger stops treating it as live work. Closing is the OWNER's act, not a reader's: only the agent that opened the report or one of its co-authors may close it, and a refusal names who to ask. This is different from acknowledging: report_ack says \"I have taken this in\" while the matter is still running. Closing is not a lock — if anyone later contributes to, sends, copies, forwards, or amends a closed report it reopens automatically and records that, so a prematurely closed report can never silently swallow new work.",
		parameters: {
			report: {
				type: "string",
				required: true,
				description: "Report id to close."
			},
			note: {
				type: "string",
				description: "Why it is finished, or what concluded it. Recorded on the hop."
			},
			...worktree.enabled ? { worktree: {
				type: "string",
				enum: ["keep", "remove-if-clean"],
				description: "What to do with a bound git checkout. keep (the default) leaves it exactly as it is; remove-if-clean deletes it only if it has no uncommitted work, and reports git's refusal otherwise."
			} } : {}
		},
		output: stringOutput,
		execute: async (args, exec) => {
			const input = args;
			const result = await service.close(input.report, actorOf(exec), input.note, { worktree: input.worktree ?? worktree.onClose });
			return [
				renderMutation(result.front, result.outcomes),
				renderWorktreeOutcome(result.worktree, worktree.enabled),
				"closed — a later contribution, send, copy, forward or amendment reopens it automatically; a receipt does not"
			].filter((line) => line !== void 0).join("\n");
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "report_release",
		description: "Hand back a report's claim on its git checkout without concluding the report. Use it when the work in that checkout is done but the conversation is not: the checkout stays on disk exactly as you left it, and the claim — which is what stops another agent from taking the same branch — ends. A claim is released once; closing a report releases it too, so this is only needed while the report stays open.",
		parameters: {
			report: {
				type: "string",
				required: true,
				description: "Report id whose checkout claim should end."
			},
			note: {
				type: "string",
				description: "Why the claim is being handed back. Recorded on the hop."
			}
		},
		output: stringOutput,
		execute: async (args, exec) => {
			const input = args;
			let result;
			try {
				result = await service.release(input.report, actorOf(exec), input.note);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const aboutBinding = message.includes("not bound to a working tree") || message.includes("does not currently hold");
				if (!worktree.enabled && aboutBinding) throw new Error(`${message} — note: this deployment has not enabled git worktree support (the composition row sets worktree.enabled), so no report here can hold a checkout and there is nothing to release`);
				throw error;
			}
			const binding = result.front.worktree;
			return [renderMutation(result.front, result.outcomes), binding === void 0 ? "claim released" : `claim released; the checkout at ${binding.path} is untouched and stays traceable to ${result.front.report}`].join("\n");
		}
	})));
	if (worktree.enabled) disposers.push(ctx.tools.register(defineTool({
		name: "report_lease",
		description: "Claim an EXISTING git checkout for a report — the counterpart to report_release. Use it to pick up a checkout that already exists: one a human made, one a previous report left behind, or one a report released earlier. A branch is held by exactly one live report at a time, so a competing claim is refused and the refusal names the holder and its authors. The branch is read from the checkout itself, so pass one only to require it.",
		parameters: {
			report: {
				type: "string",
				required: true,
				description: "Report id that will hold the checkout. Only its owners may claim on its behalf."
			},
			path: {
				type: "string",
				required: true,
				description: "Absolute path of the checkout to claim."
			},
			branch: {
				type: "string",
				description: "The branch the checkout must be on. Omit to take whichever branch it is really on."
			}
		},
		output: stringOutput,
		execute: async (args, exec) => {
			const input = args;
			const result = await service.lease(input.report, actorOf(exec), {
				path: input.path,
				...input.branch === void 0 ? {} : { branch: input.branch }
			});
			const binding = result.front.worktree;
			return [renderMutation(result.front, result.outcomes), binding === void 0 ? "claimed" : `claimed ${binding.branch ?? "(detached HEAD)"} at ${binding.path}${binding.head === void 0 ? "" : ` @ ${binding.head.slice(0, 12)}`}`].join("\n");
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "report_transfer",
		description: "Move one hand-off the ledger is still holding from the session that owes it to another session. Use it when a recipient will never come back and the obligation must not sit unpaid forever: the delivery is still owed afterwards, just by someone else, and the transfer is recorded as a hop so the path shows both the session that handed it on and the one that took it. It is NOT an arrival — nobody has received anything yet — and it does not invent an obligation that the path does not already hold. Authority: the report's owners, or the session that is currently owed the hand-off (nobody else can pre-empt a delivery that already arrived).",
		parameters: {
			report: {
				type: "string",
				required: true,
				description: "Report id whose outstanding hand-off should move."
			},
			from: {
				type: "string",
				required: true,
				description: "The session that currently owes the hand-off — the one listed as still owed."
			},
			to: {
				type: "string",
				required: true,
				description: "The session that takes the obligation over."
			},
			note: {
				type: "string",
				description: "Short note recorded on the hop, e.g. why it is being moved."
			}
		},
		output: stringOutput,
		execute: async (args, exec) => {
			const input = args;
			const result = await service.transfer(input.report, actorOf(exec), input.from, input.to, input.note);
			return [renderMutation(result.front, result.outcomes), `moved ${input.report}'s hand-off: ${input.from} no longer owes it, ${input.to} does — nobody has received it yet`].join("\n");
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "report_handover",
		description: "Hand a session's ledger assets to a successor, as one recorded act, when that session is retiring or has already gone. It first enumerates what the session holds — open reports it owns, checkouts its ownership is keeping alive, and hand-offs it was addressed with but never received — then moves what it can and reports exactly what it left. Two modes, chosen by who calls it: when SOURCE is the caller, the departing session performs the handover (it may close the reports it lists in `close`, transfer every unpaid hand-off, and release its checkout claims; the successor then claims or continues). When SOURCE is another session, the caller is the successor taking over: it becomes a co-author of each of that session's open reports — co-authorship is the only way authority is acquired here, and it is always a recorded hop — and then moves the unpaid hand-offs it can. Either way it records one `task: handover` report listing what was found and what was done, so a retirement is a fact in the ledger rather than an absence. Checkouts are never deleted: a released claim leaves the directory on disk exactly as it was.",
		parameters: {
			successor: {
				type: "string",
				required: true,
				description: "Session id that takes the assets over."
			},
			source: {
				type: "string",
				description: "Session being retired; defaults to the caller. Pass it to take over a session that is already gone."
			},
			close: {
				type: "array",
				items: { type: "string" },
				description: "Report ids the departing session concludes as finished (retire mode only). Anything not listed stays open for the successor."
			},
			checkouts: {
				type: "string",
				enum: ["release", "keep"],
				description: "What a retiring session does with the checkouts it still holds. release (the default) frees the branch so the successor can claim it; keep leaves the claim in place. The directory is never removed either way."
			}
		},
		output: stringOutput,
		execute: async (args, exec) => {
			const input = args;
			const actor = actorOf(exec);
			const successor = input.successor.trim();
			if (successor === "") throw new Error("report-ledger: report_handover needs a successor session id");
			const source = input.source?.trim() ?? actor;
			if (source === "") throw new Error("report-ledger: report_handover needs a source session id");
			if (successor === source) throw new Error("report-ledger: a handover needs two sessions — the one handing over and the one taking over");
			const retiring = source === actor;
			const assets = await assetsFor(source);
			const done = [];
			const problems = [];
			const closedNow = /* @__PURE__ */ new Set();
			if (retiring) {
				for (const id of input.close ?? []) try {
					await service.close(id, actor, `closed during a handover to ${successor}`);
					closedNow.add(id);
					done.push(`closed ${id}`);
				} catch (error) {
					problems.push(`could not close ${id}: ${reasonOf(error)}`);
				}
				for (const owed of assets.owed) {
					if (owed.status === "closed") {
						problems.push(`${owed.report} is closed but still owes a delivery to ${source}; moving it would reopen the report — decide that by hand with report_transfer if it is really unfinished`);
						continue;
					}
					try {
						await service.transfer(owed.report, actor, source, successor, `handover: ${source} -> ${successor}`);
						done.push(`moved ${owed.report}'s unpaid hand-off to ${successor}`);
					} catch (error) {
						problems.push(`could not move ${owed.report}'s hand-off: ${reasonOf(error)}`);
					}
				}
				if ((input.checkouts ?? "release") === "release") for (const id of assets.checkouts) try {
					await service.release(id, actor, "claim released during a handover");
					done.push(`released ${id}'s claim (the checkout stays on disk for ${successor} to claim)`);
				} catch (error) {
					problems.push(`could not release ${id}'s claim: ${reasonOf(error)}`);
				}
			} else {
				for (const id of assets.owned) try {
					await service.contribute(id, actor, `### handover\n\n${source} is being retired. ${actor} takes this report over.`, `handover: ${source} -> ${actor}`);
					done.push(`became a co-author of ${id}`);
				} catch (error) {
					problems.push(`could not take over ${id}: ${reasonOf(error)}`);
				}
				for (const owed of assets.owed) {
					if (owed.status === "closed") continue;
					try {
						await service.transfer(owed.report, actor, source, actor, `handover: ${source} -> ${actor}`);
						done.push(`moved ${owed.report}'s unpaid hand-off to ${actor}`);
					} catch (error) {
						problems.push(`could not move ${owed.report}'s hand-off: ${reasonOf(error)}`);
					}
				}
			}
			const after = await assetsFor(source);
			const left = [];
			for (const id of after.owned) {
				if (closedNow.has(id)) continue;
				left.push(retiring ? `${id} stays open; ${successor} must contribute to it before it can close or amend it` : `${id} is co-owned by ${actor} now; close it when the work is finished`);
			}
			if (after.checkouts.length > 0) left.push(`still holding a claim: ${after.checkouts.join(", ")} — ${retiring ? "left in place on purpose (checkouts:\"keep\")" : "release it with report_release, or report_lease it to keep working in that checkout"}`);
			if (after.owed.length > 0) left.push(`still owed to ${source}: ${after.owed.map((owed) => owed.report).join(", ")}`);
			const subject = `handover ${source} -> ${successor}`;
			const body = [
				"## handover",
				"",
				`- from: ${source}`,
				`- to: ${successor}`,
				`- mode: ${retiring ? "retire — the departing session performed the handover" : "takeover — the successor performed it"}`,
				`- run by: ${actor}`,
				"",
				"### assets found",
				`- open reports it owned: ${assets.owned.length === 0 ? "(none)" : assets.owned.join(", ")}`,
				`- checkouts it was holding: ${assets.checkouts.length === 0 ? "(none)" : assets.checkouts.join(", ")}`,
				`- hand-offs it never received: ${assets.owed.length === 0 ? "(none)" : assets.owed.map((owed) => `${owed.report} (${owed.status})`).join(", ")}`,
				"",
				"### performed",
				...done.length === 0 ? ["- nothing needed moving"] : done.map((line) => `- ${line}`),
				"",
				"### left for the successor",
				...left.length === 0 ? ["- nothing"] : left.map((line) => `- ${line}`),
				...problems.length === 0 ? [] : [
					"",
					"### problems",
					...problems.map((line) => `- ${line}`)
				]
			].join("\n");
			let recorded;
			try {
				recorded = (await service.author({
					subject,
					body,
					actor,
					...retiring ? { to: [successor] } : {},
					task: "handover",
					artifacts: [.../* @__PURE__ */ new Set([
						...assets.owned,
						...assets.owed.map((owed) => owed.report),
						...assets.checkouts
					])]
				})).front.report;
			} catch (error) {
				problems.push(`the handover itself could not be recorded: ${reasonOf(error)}`);
			}
			return [
				`handover ${source} -> ${successor} (${retiring ? "retire" : "takeover"})`,
				`assets: ${assets.owned.length} open report(s), ${assets.checkouts.length} checkout claim(s), ${assets.owed.length} unpaid hand-off(s)`,
				done.length === 0 ? "moved: nothing" : `moved (${done.length}):\n${done.map((line) => `  ${line}`).join("\n")}`,
				left.length === 0 ? "left: nothing" : `left (${left.length}):\n${left.map((line) => `  ${line}`).join("\n")}`,
				renderProblems(problems),
				recorded === void 0 ? "NOT recorded: no handover report was written" : `recorded: ${recorded} (task "handover")`
			].filter((line) => line !== void 0).join("\n");
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "report_amend",
		description: "Correct a report you own — fix a wrong subject, retag the collaboration, or amend the body — instead of opening a replacement report and losing the original transfer path. Correcting is the OWNER's act: only the originator or a co-author may amend, and a refusal names who to ask. What can change is deliberately narrow. The digest fields (subject, task, artifacts) are current state and are replaced, with the hop recording the old and new values verbatim. The body is a record of what agents actually said, so by default your text is APPENDED as an amendment section rather than rewriting anyone's words; set replace_body: true to rewrite it outright, and the hop records that you did. Recipients, co-authorship, and thread links can never be edited here — they come from the transfer path itself, so the only way to change them is another send/cc/contribute. Amending a closed report reopens it. Amending with values that already match is refused rather than reported as a successful no-op, so the record never gains an empty correction.",
		parameters: {
			report: {
				type: "string",
				required: true,
				description: "Report id to correct."
			},
			subject: {
				type: "string",
				description: "Replacement subject. An empty value is refused, since a report must keep a title."
			},
			task: {
				type: "string",
				description: "Replacement collaboration label; an empty value clears the label."
			},
			artifacts: {
				type: "array",
				items: { type: "string" },
				description: "Replacement artifact list — the WHOLE list, not additions to it."
			},
			body: {
				type: "string",
				description: "New body text: appended as an amendment section, or used to replace the body when replace_body is true."
			},
			replace_body: {
				type: "boolean",
				description: "Rewrite the body instead of appending. Requires body, and is recorded on the hop so later readers know the text was rewritten."
			},
			note: {
				type: "string",
				description: "Extra note appended to the recorded change summary."
			}
		},
		output: stringOutput,
		execute: async (args, exec) => {
			const input = args;
			const result = await service.amend(input.report, actorOf(exec), {
				...input.subject === void 0 ? {} : { subject: input.subject },
				...input.task === void 0 ? {} : { task: input.task },
				...input.artifacts === void 0 ? {} : { artifacts: input.artifacts },
				...input.body === void 0 ? {} : { body: input.body },
				...input.replace_body === void 0 ? {} : { replaceBody: input.replace_body },
				...input.note === void 0 ? {} : { note: input.note }
			});
			return `${renderMutation(result.front, result.outcomes)}\nthe correction is recorded as a hop; changed digest fields carry their before and after values verbatim`;
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "peer_list",
		description: "List the agents you can work with, and how each one relates to you: your parent and ancestors, the agents you delegated to, your siblings, the peers you started, and the agents the ledger shows you have exchanged reports with. Each row tells you whether that agent is resident right now — a resident one receives a report immediately, an absent one has the hand-off held for it. Use this to find the session id you need before addressing a report, instead of guessing or giving up because you do not know who is around.",
		parameters: {
			scope: {
				type: "string",
				enum: [
					"related",
					"live",
					"all"
				],
				description: "related (default) = lineage, peers you started, and ledger contacts; live = every agent resident right now, whatever the relation; all = every known session."
			},
			limit: {
				type: "integer",
				description: "Maximum rows (default 40, capped at 200)."
			}
		},
		output: stringOutput,
		execute: async (args, exec) => {
			const input = args;
			const rows = await peers.roster(actorOf(exec), {
				...input.scope === void 0 ? {} : { scope: input.scope },
				...input.limit === void 0 ? {} : { limit: input.limit }
			});
			if (rows.length === 0) return "no agents match; nothing to address yet";
			return [`${rows.length} agent(s):`, ...rows.map((row) => {
				const parts = [
					`${row.relation.padEnd(10)}`,
					row.live ? "live   " : "absent ",
					row.sessionId,
					`reports=${row.reports}`
				];
				if (row.name !== void 0) parts.push(`name=${row.name}`);
				if (row.title !== void 0) parts.push(`title=${row.title}`);
				if (row.depth !== void 0) parts.push(`depth=${row.depth}`);
				return parts.join(" ");
			})].join("\n");
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "peer_start",
		description: "Open a new independent agent session — a peer, not a subordinate. A peer is a root session with its own lifecycle that outlives this turn, so it is the right move when the work is long-running, when you want a partner that keeps its own context across days, or when a task should not be nested under you. This creates the session, records that you started it (which is what later lets you address it directly), and hands it the task as a REPORT — so the assignment is durable and traceable, and the peer can answer by contributing to that same report. The output also reports what became of the peer's first turn (running, already ended, or failed): a delivered digest proves only that the peer is resident, never that work started. Do not use this as a cheaper subagent: for a bounded subtask, delegation is the right tool.",
		parameters: {
			task: {
				type: "string",
				required: true,
				description: "What this peer is for and what it should do first. It becomes the opening report body."
			},
			name: {
				type: "string",
				description: "Optional short display name for the peer (60 characters or fewer)."
			},
			...worktreeParam(worktree, "Give the peer its own git checkout, on a branch named after the assignment report, and start it there instead of in your directory. Only the working directory and index are private; config, hooks and the object store are shared with every other checkout.")
		},
		output: stringOutput,
		execute: async (args, exec) => {
			const input = args;
			const actor = actorOf(exec);
			const name = input.name?.trim() || void 0;
			const subject = subjectFrom(input.task, name);
			const provisioned = input.worktree === true ? await requireWorktree(worktree, service, {
				subject,
				actor
			}) : void 0;
			let started;
			try {
				started = await peers.start(actor, {
					task: input.task,
					...name === void 0 ? {} : { name },
					...provisioned === void 0 ? {} : { cwd: provisioned.prepared.binding.path }
				});
			} catch (error) {
				if (provisioned !== void 0) await service.rollbackProvision(provisioned);
				throw error;
			}
			let result;
			try {
				result = await service.author({
					subject,
					body: [
						`本会话由 ${actor} 开启，你是它的**同伴**而非下属：你有自己的生命周期，会比这一轮活得更久。`,
						...provisioned === void 0 ? [] : [
							"",
							`你的工作目录是一个**独立的 git 检出**：${provisioned.prepared.binding.path}（分支 ${provisioned.prepared.binding.branch}）。`,
							"独立的是工作目录与索引；config、hooks、对象库与其它检出共享，所以装 hook 或改配置会影响所有检出。"
						],
						"",
						`要回复或继续这个话题，用 report_contribute 追加到本汇报——它会成为我们之间的线程；需要直接交代新事情时用 report_author 并 to=[${actor}]。`,
						"",
						"## 任务",
						input.task
					].join("\n"),
					actor,
					to: [started.sessionId],
					task: started.name,
					...provisioned === void 0 ? {} : {
						reportId: provisioned.report,
						worktree: provisioned.prepared.binding
					}
				});
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				throw new Error(`report-ledger: peer ${started.sessionId} exists, but its assignment report could not be written (${reason}). The assignment was NOT delivered. The peer is alive and counted against this session's lifetime peer budget; assign it later by authoring a report with report_author and sending it with report_send (to=${started.sessionId}).` + (provisioned === void 0 ? "" : ` Its checkout at ${provisioned.prepared.binding.path} was kept rather than rolled back: a report can adopt it later with report_lease.`));
			}
			let receipt;
			try {
				receipt = describeReceipt(await peers.receipt(started.sessionId, DEFAULT_RECEIPT_MS), DEFAULT_RECEIPT_MS);
			} catch (error) {
				receipt = `⚠ could not observe the peer's first turn: ${error instanceof Error ? error.message : String(error)}`;
			}
			return [
				`opened peer ${started.sessionId}${started.name === void 0 ? "" : ` (name=${started.name})`}`,
				started.cwd === void 0 ? "" : `cwd=${started.cwd}`,
				`peers you have started: ${started.started}`,
				`assignment report: ${result.front.report}`,
				...provisioned === void 0 ? [] : renderProvision(provisioned.prepared),
				renderMutation(result.front, result.outcomes),
				receipt === void 0 ? "" : receipt,
				renderWorkspace(started.workspace),
				`Address this peer later with report_send / report_cc to=${started.sessionId}, or see everyone with peer_list.`
			].filter((line) => line !== "").join("\n");
		}
	})));
	return () => {
		for (const dispose of disposers.splice(0)) dispose();
	};
}
//#endregion
//#region src/index.ts
/** The three host services this half cannot work without. */
const inject = [
	"tools",
	"systemPrompt",
	"agents"
];
/**
* Read one string field off an untyped record.
* @param source - the record.
* @param key - field name.
* @returns the value when it is a non-empty string.
*/
function str(source, key) {
	const value = source[key];
	return typeof value === "string" && value !== "" ? value : void 0;
}
/**
* Extract only the header fields the timeline renders.
*
* The session query returns live harness records; copying them wholesale would
* both break the leaf-field rule and drag unrelated state into the browser.
* @param entry - one raw session record.
* @returns the structural record, or `undefined` when it has no usable id.
*/
function toSessionRecord(entry) {
	if (entry === null || typeof entry !== "object") return void 0;
	const record = entry;
	const header = record.header;
	if (header === null || typeof header !== "object") return void 0;
	const fields = header;
	const id = str(fields, "id");
	if (id === void 0) return void 0;
	const parentSession = str(fields, "parentSession");
	const origin = str(fields, "origin");
	const agentPreset = str(fields, "agentPreset");
	return {
		header: {
			id,
			...parentSession === void 0 ? {} : { parentSession },
			...origin === void 0 ? {} : { origin },
			...agentPreset === void 0 ? {} : { agentPreset },
			...typeof fields.createdAt === "number" ? { createdAt: fields.createdAt } : {},
			...typeof fields.delegationDepth === "number" ? { delegationDepth: fields.delegationDepth } : {}
		},
		live: record.live === true
	};
}
/**
* Resolve the model route a peer is created with.
*
* This is the difference between a peer that works and a peer that dies silently:
* an agent with no route cannot resolve `{{model}}` while its prompt is
* assembled, so its first turn ends at step 1 with an `error` reason — before a
* single tool call, which is why the ledger's `delivered` and the roster's `live`
* both stay perfectly green while nothing whatsoever happens.
*
* The starter's live route is the right source, in the same order the harness's
* own delegation uses: the session's request header records the route actually in
* force after request-time selection, creation options are the fallback before
* the first request, and only a starter carrying neither falls through to the
* deployment default. When even that is absent the peer is refused rather than
* created doomed.
*
* Reasoning effort follows the harness rule exactly rather than the looser
* `??` chain the other fields use: a request header that is present but names no
* effort means the effort is ABSENT (the model resolves its own default), not
* "reuse whatever the creation options remember". That difference is not
* cosmetic — after the starter switches to a model whose route carries no
* effort, a peer handed the stale one starts on a route it cannot use, and it
* dies at its first request while the ledger still reports a successful
* hand-off. See `parentAgentOptionsForDelegation` in `@deepseek-ai/dsh-subagent`.
* @param caller - the live starter agent, when it is resident.
* @param fallback - the deployment default model service, when it is mounted.
* @returns the route fields to pass as creation options.
* @throws when no source can name a provider and model.
*/
function peerRoute(caller, fallback) {
	const fromHeader = caller?.session.requestHeader()?.config;
	const created = caller?.options;
	const selection = fallback?.currentSelection();
	const provider = fromHeader?.provider ?? created?.provider ?? selection?.provider;
	const model = fromHeader?.model ?? created?.model ?? selection?.model;
	if (provider === void 0 || model === void 0) throw new Error("report-ledger: cannot start a peer — no model route could be resolved for it. The starting session carries no provider/model and this deployment exposes no default model selection, so the peer would be created unable to assemble a prompt (its first turn would fail).");
	const reasoningEffort = fromHeader === void 0 ? created?.reasoningEffort ?? selection?.reasoningEffort : fromHeader.reasoningEffort;
	return {
		provider,
		model,
		...reasoningEffort === void 0 ? {} : { reasoningEffort },
		...created?.maxTokens === void 0 ? {} : { maxTokens: created.maxTokens }
	};
}
/**
* Whether a session's log already records an opened turn.
* @param session - the live session.
* @returns true when at least one `turn/start` was appended.
*/
function hasOpenedTurn(session) {
	return session.snapshotEvents().some((event) => event !== null && typeof event === "object" && event.type === "turn/start");
}
/**
* Read the last turn's stop reason out of a session log.
* @param session - the live session.
* @returns the reason kind and, for an error, its message.
*/
function lastTurnReason(session) {
	const events = session.snapshotEvents();
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event === null || typeof event !== "object") continue;
		const record = event;
		if (record.type !== "turn/end") continue;
		const data = record.data;
		if (data === null || typeof data !== "object") return {};
		const reason = data.reason;
		if (reason === null || typeof reason !== "object") return {};
		const fields = reason;
		const error = fields.error;
		const message = error === null || typeof error !== "object" ? void 0 : str(error, "message");
		return {
			...typeof fields.kind === "string" ? { kind: fields.kind } : {},
			...message === void 0 ? {} : { message }
		};
	}
	return {};
}
/**
* Wait for one agent to reach quiescence, bounded.
*
* The bound is what makes the answer usable: a peer that opened a turn and is
* still working after it elapses is reported as running, while a turn that dies
* (the silent failure mode this exists to expose) settles in milliseconds. The
* timer is an observation window only — it is unref'd, so it can never be a
* reason for the host to stay alive.
* @param agent - the agent to observe.
* @param timeoutMs - the window length.
* @returns true when quiescence came first, false when the window closed first.
*/
function settledWithin(agent, timeoutMs) {
	return new Promise((resolve) => {
		let finished = false;
		const finish = (settled) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			resolve(settled);
		};
		const timer = setTimeout(() => {
			finish(false);
		}, Math.max(timeoutMs, 0));
		timer.unref?.();
		agent.whenIdle().then(() => {
			finish(true);
		}, () => {
			finish(true);
		});
	});
}
/**
* How long one session-corpus listing is reused before it is read again.
*
* Short enough that a tree a human is watching does not look stale, long enough
* that a burst of polls (the tab refreshes every ten seconds, and a slow answer
* overlaps the next) costs a single walk. Invalidation on `agent/created` is
* what covers the one case where freshness is not negotiable.
*/
const SESSION_LISTING_TTL_MS = 5e3;
/**
* Build every host capability this plugin consumes.
*
* Agent lookup goes through `ctx.agents`, and delivery uses the `Agent`'s own
* `steer`/`inject` entries. Those entries take a message and no authority, which
* is what lets a report reach a carbon-copy peer that the adjacency-checked
* delegation path would refuse.
* @param ctx - the plugin context.
* @returns the host capability bundle.
*/
function buildHost(ctx) {
	const sessionQuery = () => ctx.get("sessionQuery");
	let listingCache;
	let listingPending;
	let listingGeneration = 0;
	const readListing = async () => {
		const query = sessionQuery();
		if (query === void 0 || query.listSessions === void 0) return [];
		const list = query.listSessions.bind(query);
		const cached = listingCache;
		if (cached !== void 0 && Date.now() - cached.at < SESSION_LISTING_TTL_MS) return [...cached.records];
		const pending = listingPending;
		if (pending !== void 0) return [...await pending];
		const generation = listingGeneration;
		const started = (async () => {
			try {
				const raw = await list();
				const records = [];
				for (const entry of raw) {
					const record = toSessionRecord(entry);
					if (record !== void 0) records.push(record);
				}
				if (generation === listingGeneration) listingCache = {
					at: Date.now(),
					records
				};
				return records;
			} finally {
				if (generation === listingGeneration) listingPending = void 0;
			}
		})();
		listingPending = started;
		return [...await started];
	};
	const readTitles = async (ids) => {
		const titles = /* @__PURE__ */ new Map();
		const query = sessionQuery();
		if (query?.readTitleSnapshots === void 0 || ids.length === 0) return titles;
		try {
			const results = await query.readTitleSnapshots(ids);
			for (const result of results) {
				if (result === null || typeof result !== "object") continue;
				const entry = result;
				if (entry.status !== "fulfilled" || typeof entry.sessionId !== "string") continue;
				const snapshot = entry.value?.title;
				const title = snapshot === void 0 ? void 0 : str(snapshot, "title");
				if (title !== void 0) titles.set(entry.sessionId, title);
			}
		} catch {}
		return titles;
	};
	return {
		getAgent(sessionId) {
			const agent = ctx.agents.get(sessionId);
			if (agent === void 0) return void 0;
			return {
				id: String(agent.id),
				steer: (message) => {
					agent.steer(message);
				},
				inject: (message) => {
					agent.inject(message);
				}
			};
		},
		async describe(sessionId) {
			return (await readTitles([sessionId])).get(sessionId);
		},
		selfCwd(sessionId) {
			const cwd = (ctx.agents.get(sessionId)?.session?.header)?.cwd;
			return typeof cwd === "string" && cwd !== "" ? cwd : void 0;
		},
		readTitles,
		listSessionRecords: readListing,
		invalidateSessionListing() {
			listingGeneration += 1;
			listingCache = void 0;
			listingPending = void 0;
		}
	};
}
/** Read one report's full detail for the tab's expanded panel. */
async function readDetail(id) {
	const found = await readReport(id);
	if (found === void 0) return void 0;
	const hops = await readHops(id);
	return {
		front: found.front,
		hops,
		pending: pendingTargets(hops),
		body: found.body,
		path: reportPath(id)
	};
}
/**
* Build the peer-management capabilities from the running context.
*
* Peer creation is the only place this plugin adds a live agent, so it is the
* only place that needs an authority story: the tool's visibility is the outer
* gate, {@link Config.maxPeersPerAgent} bounds the blast radius, the peer
* inherits the caller's own working directory (so it cannot be pointed at an
* unrelated tree), and every creation is attributed in the roster log.
*
* It is also the only place that must supply what a fresh agent cannot supply
* itself. A root session is born with no composition and no model route:
*
*  - **Composition.** The peer joins the starter's standing preset
*    (`composeFrom`), which is a bind to the SAME generation the starter runs —
*    not a re-resolution of the preset by id, so a preset edited or deleted since
*    cannot hand the peer a different world than its starter's. A deployment with
*    no roster yields no join and no error, exactly like a delegated child.
*  - **Route.** The peer inherits the starter's provider/model/reasoning effort.
*    Without it, prompt assembly cannot resolve `{{model}}` and every turn of the
*    peer dies at step 1 before its first tool call.
*  - **Preset identity.** The joined preset is recorded in the durable session
*    header, so a cold read of the peer's log rebuilds the composition it
*    actually ran under instead of the deployment default.
*
* It is also, on a deployment that composes a workspace registry, the only place
* that can put the new peer into a workspace group — see
* {@link PeerHost.attachToWorkspace} for why no other layer can: the registry's
* history bootstrap runs once, long before this peer exists, and creation
* metadata has no workspace field to name it with.
*
* `confirmPeer` closes the other half of the same problem: a peer that turns out
* to be unable to run must be visible to the agent that just started it, rather
* than reported as a successful hand-off.
* @param ctx - the host capabilities this bundle reaches for.
* @param host - the session-reading bundle.
* @returns the peer host capability.
*/
function buildPeerHost(ctx, host) {
	const presets = () => ctx.get("agentPresets");
	const defaultModel = () => ctx.get("agentDefaultModel");
	return {
		selfCwd(sessionId) {
			const cwd = ((ctx.agents.get(sessionId)?.session)?.header)?.cwd;
			return typeof cwd === "string" && cwd !== "" ? cwd : void 0;
		},
		liveIds() {
			const ids = /* @__PURE__ */ new Set();
			for (const agent of ctx.agents.list()) ids.add(String(agent.id));
			return ids;
		},
		listSessionRecords: () => host.listSessionRecords(),
		readTitles: (ids) => host.readTitles(ids),
		listReports: () => listReports(),
		async createPeer(input) {
			const caller = ctx.agents.get(input.startedBy);
			if (caller === void 0) throw new Error(`report-ledger: cannot start a peer from ${input.startedBy} — the starting session is not resident, so the peer has no composition and no model route to inherit`);
			const agentOptions = peerRoute(caller, defaultModel());
			const agentPreset = presets()?.composedPreset(caller.ctx);
			const meta = {
				...input.cwd === void 0 ? {} : { cwd: input.cwd },
				...agentPreset === void 0 ? {} : { agentPreset }
			};
			const handle = await ctx.agents.create({
				sessionId: input.sessionId,
				...Object.keys(meta).length === 0 ? {} : { meta },
				agentOptions,
				setup: (agentCtx) => {
					presets()?.composeFrom(agentCtx, caller.ctx);
				}
			});
			return {
				id: String(handle.agent.id),
				steer: (message) => {
					handle.agent.steer(message);
				}
			};
		},
		/**
		* Put the new peer into the workspace group that owns its directory.
		*
		* This exists because nothing else does it. A session enters a workspace's
		* accounting at exactly one of two moments: the one-time history bootstrap,
		* which the registry runs only while its own `initialized` marker is false and
		* which therefore never sees a session created afterwards, or an attach
		* performed at creation by a caller that named a workspace. A GUI-created
		* session takes the second route. A peer cannot: `ctx.agents.create()` takes
		* creation metadata — `cwd`, `agentPreset` — and no workspace identity, so the
		* peer's directory matches a registered workspace while its id is absent from
		* that workspace's `sessionIds`. The browser groups by that accounting, not by
		* the directory, so such a peer sits under the ungrouped bucket for the rest
		* of its life.
		*
		* Registration is best-effort in three distinct senses, and each maps to one
		* outcome: no registry means no groups exist to join (`no-workspace`); no
		* registration owns the directory — a peer started in a fresh checkout or a
		* temporary directory — is legitimate and also `no-workspace`; an attempt that
		* throws is `failed` and carried back as a warning. Only the last is a defect,
		* and none of the three is allowed to break peer creation: a partner that
		* exists but is listed in the wrong bucket is still a working partner, while a
		* refused peer is no partner at all.
		* @param input - the peer session, and the directory it was created with.
		* @returns the outcome, as the report rather than as a throw.
		*/
		async attachToWorkspace(input) {
			const registry = ctx.get("workspaceRegistry");
			if (registry === void 0) return { outcome: "no-workspace" };
			if (input.cwd === void 0) return { outcome: "no-workspace" };
			try {
				const workspace = await registry.resolveByPath(await realpathNormalize(input.cwd));
				if (workspace === void 0) return { outcome: "no-workspace" };
				await workspace.attachSession(input.sessionId);
				return {
					outcome: "registered",
					workspace: workspace.title
				};
			} catch (error) {
				const warning = error instanceof Error ? error.message : String(error);
				ctx.logger?.warn?.(`report-ledger: peer ${input.sessionId} could not be registered with its workspace: ${warning}`);
				return {
					outcome: "failed",
					warning
				};
			}
		},
		async confirmPeer(sessionId, timeoutMs) {
			const agent = ctx.agents.get(sessionId);
			if (agent === void 0) return void 0;
			if (!hasOpenedTurn(agent.session)) return { kind: "unstarted" };
			if (!await settledWithin(agent, timeoutMs)) return { kind: "running" };
			const reason = lastTurnReason(agent.session);
			if (reason.kind === "error") return {
				kind: "failed",
				reason: "error",
				...reason.message === void 0 ? {} : { error: reason.message }
			};
			return {
				kind: "settled",
				...reason.kind === void 0 ? {} : { reason: reason.kind }
			};
		}
	};
}
/**
* Apply the host half.
* @param ctx - the plugin context (`tools`, `systemPrompt`, `agents` injected).
* @param config - resolved plugin config from the composition row.
*/
function apply(ctx, config) {
	const host = buildHost(ctx);
	const service = new ReportService(host);
	const peers = new PeerService(buildPeerHost(ctx, host), config?.maxPeersPerAgent ?? 8);
	const worktree = resolveWorktree(config?.worktree);
	ctx.effect(() => registerReportTools(ctx, service, peers, worktree), "report-ledger: model tools");
	ctx.on("agent/created", (payload) => {
		const sessionId = String(payload?.agent?.id ?? "");
		if (sessionId === "") return void 0;
		host.invalidateSessionListing?.();
		service.flushForAgent(sessionId).catch((error) => {
			ctx.logger?.warn?.(`report-ledger: deferred delivery to ${sessionId} failed: ${String(error)}`);
		});
	});
	ctx.inject(["webServer"], (scoped) => {
		const webServer = scoped.get("webServer");
		if (webServer === void 0) return;
		const deps = {
			timeline: async (root) => buildTimeline({
				listSessionRecords: () => host.listSessionRecords(),
				readTitles: (ids) => host.readTitles(ids),
				listReports: () => listReports(),
				readHops: (report) => readHops(report)
			}, root),
			report: readDetail,
			worktrees: async () => buildWorktreeReport({
				listReports: () => listReports(),
				readHops: (report) => readHops(report)
			}, worktree.settings, worktree.enabled),
			log: (message) => {
				ctx.logger?.warn?.(message);
			}
		};
		scoped.effect(() => {
			const registered = [];
			try {
				registered.push(webServer.register({
					kind: "exact",
					path: REPORT_PATH,
					handler: createReportHandler(deps)
				}));
				registered.push(webServer.register({
					kind: "exact",
					path: TIMELINE_PATH,
					handler: createTimelineHandler(deps)
				}));
				registered.push(webServer.register({
					kind: "exact",
					path: WORKTREES_PATH,
					handler: createWorktreesHandler(deps)
				}));
			} catch (error) {
				for (const dispose of registered.reverse()) dispose();
				throw error;
			}
			return () => {
				for (const dispose of registered.reverse()) dispose();
			};
		}, "report-ledger: read endpoints");
	});
	queueMicrotask(() => {
		let live;
		try {
			live = ctx.agents.list();
		} catch (error) {
			ctx.logger?.warn?.(`report-ledger: catch-up sweep could not list live sessions: ${String(error)}`);
			return;
		}
		for (const agent of live) {
			const sessionId = String(agent.id ?? "");
			if (sessionId === "") continue;
			service.flushForAgent(sessionId).catch((error) => {
				ctx.logger?.warn?.(`report-ledger: catch-up delivery to ${sessionId} failed: ${String(error)}`);
			});
		}
	});
	if (devModeEnabled(config)) ctx.effect(() => installDevMode(ctx), "report-ledger: developer mode");
	if ((config?.announceToAgent ?? true) === false) return;
	ctx.effect(() => ctx.systemPrompt.section({
		name: "plugin:report-ledger",
		order: 200,
		text: PROTOCOL
	}), "report-ledger: protocol section");
	ctx.effect(() => ctx.systemPrompt.section({
		name: "plugin:report-ledger:partnership",
		order: 201,
		text: partnershipText
	}), "report-ledger: partnership section");
}
//#endregion
export { apply, buildPeerHost, inject };
