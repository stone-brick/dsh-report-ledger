window.__ModuleLoader__.load({
	id: "dsh-report-ledger",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/timeline-model.ts
		/**
		* The timeline's ordering: by time, and at the same instant a session before a
		* report.
		*
		* Extracted so that INSERTING a row uses the same rule as SORTING rows — two
		* copies would drift, and the synthesized row would land somewhere the sort
		* disagrees with.
		* @param left - one row.
		* @param right - the other row.
		* @returns the comparison result.
		*/
		function byTime(left, right) {
			return left.at - right.at || (left.kind === right.kind ? 0 : left.kind === "session" ? -1 : 1);
		}
		/**
		* The depth of every session in one payload, keyed by session id.
		*
		* Exported because the views need the same map for a row they synthesize rather
		* than build: the open report keeps the indentation of the session that authored
		* it, and asking the model for the map is what stops a second copy of "depth
		* means the author's depth" from growing in the view.
		* @param payload - the endpoint payload.
		* @returns session id to depth.
		*/
		function sessionDepths(payload) {
			const depth = /* @__PURE__ */ new Map();
			for (const node of payload.sessions) depth.set(node.id, node.depth);
			return depth;
		}
		/**
		* Build the merged, time-ordered row list.
		*
		* Sessions are placed at their creation time and reports at theirs, so the list
		* reads as the collaboration actually unfolded: a session appears where it was
		* branched, a report where it was opened. Report depth comes from the session
		* that authored it, which is what keeps the indentation meaningful even when the
		* session row itself is filtered out.
		*
		* A report row's own `at` is also the timestamp its row prints, so the list can
		* never be ordered by one axis and read as sorted by another.
		* @param payload - the endpoint payload.
		* @param basis - whether to place a report at its creation or its last activity.
		* @returns the rows, oldest first.
		*/
		function buildRows(payload, basis = "created") {
			const depth = sessionDepths(payload);
			const rows = [];
			for (const node of payload.sessions) rows.push({
				kind: "session",
				at: node.createdAt ?? 0,
				id: node.id,
				depth: node.depth,
				delegated: node.delegated,
				live: node.live,
				...node.title === void 0 ? {} : { title: node.title }
			});
			for (const front of payload.reports) rows.push({
				kind: "report",
				at: basis === "created" ? front.created : front.updated,
				depth: depth.get(front.from) ?? 0,
				front
			});
			rows.sort(byTime);
			return rows;
		}
		/**
		* Shorten a session id so a digest row can be read.
		*
		* A session id is 36 characters and a report's recipients are a list of them, so
		* an unabbreviated meta line is mostly uuid and carries almost no information a
		* human can use. Eight characters of the leading segment stay unique within one
		* collaboration and, unlike a session title, are bounded: titles are the first
		* prompt of a session ("You are doing READ-ONLY research"), so swapping ids for
		* titles trades one unreadable line for another.
		*
		* This is a DENSE-ROW display only. The detail panel keeps full ids, because
		* that is the view somebody copies an id out of, and the tooltip on every
		* shortened id carries the full value.
		* @param id - the session id.
		* @param length - how many characters to keep.
		* @returns the shortened id.
		*/
		function shortId(id, length = 8) {
			const bare = id.startsWith("session-") ? id.slice(8) : id;
			return bare.length <= length ? bare : bare.slice(0, length);
		}
		/**
		* Display titles for the sessions in one payload, keyed by session id.
		*
		* Titles are resolved only for the subtree, so an id from another tree simply
		* has none — which is why every caller must fall back to the shortened id
		* rather than assuming a name exists.
		* @param payload - the endpoint payload.
		* @returns the titles that were resolved.
		*/
		function sessionTitles(payload) {
			const titles = /* @__PURE__ */ new Map();
			for (const node of payload.sessions) if (typeof node.title === "string" && node.title !== "") titles.set(node.id, node.title);
			return titles;
		}
		/**
		* Make sure the open report has a row, and put it where it belongs.
		*
		* The detail panel is anchored to a report row, so the open report must HAVE
		* one. Two real user paths would otherwise leave the panel with nowhere to
		* render: a thread link pointing at a report outside this tree's payload, and
		* any filter applied while a report is open. In the first case the panel is also
		* the only place the "not in this tree" notice can appear, so the panel is not
		* hoisted out of the list — a row is synthesized instead.
		*
		* The synthesized row is INSERTED at its own place on the time axis rather than
		* appended. Appending made a report created at 11:12 appear below one created at
		* 14:30, which reads as a broken sort at exactly the moment the user is trying
		* to understand why something is missing.
		*
		* The depth is passed in rather than assumed: the caller has the payload and can
		* ask `sessionDepths` for the author's depth, and a row that loses its
		* indentation when a filter hides it would be a second, quieter broken sort.
		* Reports whose author is outside the subtree are at the root (depth 0).
		* @param kept - the rows that survived the filter.
		* @param front - the digest of the open report.
		* @param basis - the active time basis, so the row moves with the rest.
		* @param depth - the author's depth from the payload, or 0 outside the subtree.
		* @returns the rows, with the open report present exactly once.
		*/
		function withSynthesizedRow(kept, front, basis, depth) {
			if (kept.some((row) => row.kind === "report" && row.front.report === front.report)) return [...kept];
			const row = {
				kind: "report",
				at: basis === "created" ? front.created : front.updated,
				depth,
				front
			};
			const index = kept.findIndex((candidate) => byTime(row, candidate) < 0);
			if (index < 0) return [...kept, row];
			return [
				...kept.slice(0, index),
				row,
				...kept.slice(index)
			];
		}
		/** Every string a report row can be found by. */
		function reportHaystack(front) {
			return [
				front.report,
				front.subject,
				front.from,
				front.fromName ?? "",
				...front.to,
				...front.cc,
				...front.authors,
				front.task ?? "",
				...front.artifacts,
				front.worktree?.branch ?? "",
				front.worktree?.path ?? ""
			].join("\n").toLowerCase();
		}
		/** Every string a session row can be found by. */
		function sessionHaystack(row) {
			return `${row.title ?? ""}\n${row.id}`.toLowerCase();
		}
		/**
		* Whether one row survives the current filter.
		* @param row - the candidate row.
		* @param filter - the active filter.
		* @returns true when the row should be rendered.
		*/
		function rowMatches(row, filter) {
			const needle = filter.text.trim().toLowerCase();
			if (row.kind === "session") return needle === "" || sessionHaystack(row).includes(needle);
			if (filter.status !== "all" && row.front.status !== filter.status) return false;
			return needle === "" || reportHaystack(row.front).includes(needle);
		}
		/**
		* Apply a filter to the row list.
		* @param rows - the assembled rows.
		* @param filter - the active filter.
		* @returns the surviving rows, in their original order.
		*/
		function filterRows(rows, filter) {
			return rows.filter((row) => rowMatches(row, filter));
		}
		/**
		* Count reports by lifecycle state.
		*
		* Counted from the whole subtree payload rather than the filtered rows, so the
		* chips keep showing the full picture while one of them is applied — a filter
		* whose own label changed when you used it would make it impossible to see how
		* much you had excluded.
		* @param reports - every report in the payload.
		* @returns the counts.
		*/
		function statusCounts(reports) {
			const counts = {
				all: reports.length,
				open: 0,
				acked: 0,
				closed: 0
			};
			for (const front of reports) if (front.status === "open") counts.open += 1;
			else if (front.status === "acked") counts.acked += 1;
			else if (front.status === "closed") counts.closed += 1;
			return counts;
		}
		/**
		* Whether a filter would hide anything.
		* @param filter - the active filter.
		* @returns true when a status or text constraint is in force.
		*/
		function isFiltering(filter) {
			return filter.status !== "all" || filter.text.trim() !== "";
		}
		/**
		* Index the payload's working-tree lanes by report id.
		*
		* The lanes carry the lease state, which the digests do not: liveness is derived
		* from the hop stream, and the host derives it once rather than each half of the
		* plugin deriving it separately.
		* @param payload - the endpoint payload.
		* @returns report id to lane.
		*/
		function laneIndex(payload) {
			return new Map(payload.worktrees.map((lane) => [lane.report, lane]));
		}
		/**
		* How a lease state should read at a glance.
		*
		* A live claim is the only state that means someone is working *now*, so it is
		* the only one that earns a positive tone. A cleared checkout is deliberately
		* plain rather than alarming: the ledger tidying up after itself is not a
		* problem to be surfaced, and giving it a warning tone would teach a reader to
		* ignore warnings.
		*/
		const LEASE_TONE = {
			held: "success",
			released: "info",
			reclaimed: "neutral",
			none: "neutral"
		};
		/** The last path segment, for naming a checkout that has no branch. */
		function lastSegment(path) {
			const parts = path.split(/[\\/]/);
			return parts[parts.length - 1] || path;
		}
		/**
		* The short name a checkout is shown under.
		*
		* Taken from the binding rather than from the lane, because a report opened by
		* id can be rendered before it is in the payload's lane list — the binding is
		* always on the row, the lane is not.
		* @param binding - the row's binding, when it has one.
		* @returns the label, or `undefined` when the report is not bound.
		*/
		function worktreeLabel(binding) {
			if (binding === void 0) return void 0;
			return binding.branch ?? lastSegment(binding.path);
		}
		/**
		* Count how many report rows are visible under a filter.
		* @param rows - every assembled row.
		* @param filter - the active filter.
		* @returns the number of visible report rows.
		*/
		function visibleReports(rows, filter) {
			let count = 0;
			for (const row of filterRows(rows, filter)) if (row.kind === "report") count += 1;
			return count;
		}
		/**
		* Decide which empty-state message applies.
		*
		* An empty ledger and a filter that matched nothing look identical on screen but
		* mean opposite things: one says "nothing has happened in this tree yet", the
		* other says "you are looking at a subset of what happened". Saying the wrong
		* one makes a working ledger look broken, so the choice is made here — where it
		* is pinned by tests — rather than inline in the view.
		*
		* Counted on REPORT rows only. Session rows always survive a status chip, so
		* counting them would let a tree full of sessions report itself as "you have
		* filtered everything out" while the actual reason is that no report exists.
		*
		* The `no-reports` case deliberately wins over the filter: when the ledger holds
		* nothing, a filter cannot be the reason nothing is on screen, and blaming it
		* would send the reader looking for a filter to clear that they never set.
		* @param payload - the endpoint payload.
		* @param rows - every assembled row.
		* @param filter - the active filter.
		* @returns which message the view should show, if any.
		*/
		function emptyState(payload, rows, filter) {
			if (payload.reports.length === 0) return "no-reports";
			if (!isFiltering(filter)) return "none";
			return visibleReports(rows, filter) === 0 ? "filtered-out" : "none";
		}
		/**
		* The report ids present in one payload.
		*
		* A thread link can point outside the subtree — a report answering one opened by
		* an unrelated session, for instance — and the detail endpoint is ledger-scoped,
		* so such a report still opens. Knowing which ids are in the list is what lets
		* the view say so instead of silently showing a card that is not in the timeline.
		* @param payload - the endpoint payload.
		* @returns the ids of every report in the payload.
		*/
		function reportIds(payload) {
			const ids = /* @__PURE__ */ new Set();
			for (const front of payload.reports) ids.add(front.report);
			return ids;
		}
		/** Body length above which the detail panel shows only a head. */
		const BODY_DISPLAY_LIMIT = 4e3;
		/** How much of an over-long body is shown. */
		const BODY_HEAD_LIMIT = 1200;
		/**
		* Trim a body for the detail panel.
		*
		* Mirrors what `report_read` already does for the model: the full text stays in
		* the ledger file, and both readers get a bounded view plus a pointer rather than
		* an unbounded paste. Keeping the human view and the model view bounded the same
		* way means neither can be surprised by what the other sees.
		* @param body - the raw body.
		* @param limit - length above which truncation applies.
		* @param head - how many characters to keep when truncating.
		* @returns the display text and whether it was cut.
		*/
		function displayBody(body, limit = BODY_DISPLAY_LIMIT, head = BODY_HEAD_LIMIT) {
			if (body.length <= limit) return {
				text: body,
				truncated: false
			};
			return {
				text: body.slice(0, head),
				truncated: true
			};
		}
		/**
		* Close a code fence left hanging by truncation.
		*
		* Cutting Markdown at a character count is not the same operation as cutting
		* plain text: the result can be a document that does not parse as written. The
		* one construct that changes the meaning of everything after it is a code fence,
		* so a body cut inside a fenced block hands the renderer an unterminated one and
		* leaves it to decide where the block ends.
		*
		* The renderer here does cope (measured: a body cut mid-fence renders as one
		* closed code block with no trailing artifact), which is exactly why this is
		* cheap insurance rather than a fix for something visibly broken: the renderer is
		* a shell platform module this plugin does not own, and its leniency is not a
		* contract. Balancing the document costs one line and makes the plugin's output
		* valid Markdown no matter who renders it.
		*
		* Balanced text is returned untouched, so this only ever adds the fence the cut
		* removed. Only backtick fences are counted; `~~~` fences are rare enough in
		* report bodies that guessing which convention the author used would be worse
		* than leaving them alone.
		*
		* A fence is a RUN, not a token: CommonMark lets an opener use four backticks
		* precisely so the body can contain a literal three-backtick line, and requires
		* the closer to be at least as long as the opener. Counting every line that
		* merely starts with three backticks therefore gets exactly the documents this
		* function exists for backwards — the nested block would look balanced while its
		* real (longer) fence stayed open. So the opener's length is remembered and only
		* a same-character run of at least that length closes it.
		* @param text - the already-truncated head.
		* @returns the head, with an unclosed fence closed.
		*/
		function closeOpenFence(text) {
			let open;
			for (const line of text.split("\n")) {
				const stripped = line.trimStart();
				if (!stripped.startsWith("```")) continue;
				let run = 0;
				while (stripped[run] === "`") run += 1;
				if (open === void 0) open = run;
				else if (run >= open) open = void 0;
			}
			return open === void 0 ? text : `${text}\n${"`".repeat(open)}`;
		}
		//#endregion
		//#region src/client/format.ts
		/**
		* The two text helpers both report surfaces need.
		*
		* Tiny and pure on purpose: `fill` is the `{name}` substitution every dictionary
		* template is written in, and `stamp` is the one timestamp format the ledger
		* uses. They live outside the views because there are now two of them — the
		* conversation tab and the right column's canvas tab — and a second copy of
		* either would be a second answer to the same question.
		*
		* @module dsh-report-ledger/client/format
		*/
		/** Substitute `{name}` placeholders, leaving unknown names alone. */
		function fill(template, params) {
			return template.replace(/\{(\w+)\}/g, (whole, name) => Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole);
		}
		/** Format one timestamp for a timeline row or a hop. */
		function stamp(at) {
			if (at === void 0 || at <= 0) return "";
			return new Date(at).toLocaleString();
		}
		/** How long the path's copy control shows its "copied" state. */
		const COPIED_HOLD_MS = 1200;
		//#endregion
		//#region src/client/locales.ts
		/** Chinese dictionary — the source of truth for the key set. */
		const zh = {
			"view.tab": "汇报",
			"view.loading": "正在读取账本…",
			"view.summary": "{sessions} 个会话 · {reports} 份汇报",
			"view.empty": "这个会话树下还没有汇报。代理用 report_author 开一份汇报后，这里会出现它的缩略卡。",
			"view.refresh": "刷新",
			"view.retry": "重试",
			"view.error": "读取失败：{code}",
			"view.live": "在线",
			"view.delegated": "子代理",
			"view.detail.loading": "正在读取传递路径…",
			"view.detail.route": "传递路径",
			"view.detail.routeEmpty": "（还没有记录跳）",
			"view.detail.pending": "仍在等待送达：{targets}",
			"view.detail.body": "正文",
			"view.detail.path": "账本文件",
			"view.copyPath": "复制账本路径",
			"row.hops": "{count} 跳",
			"row.authors": "{count} 位共写",
			"row.filterByTask": "只看任务「{task}」",
			"row.filterByWorktree": "只看检出「{worktree}」",
			"row.leaseHeld": "工作区：正在被这份汇报占用",
			"row.leaseReleased": "工作区：占用已结束，检出仍留在磁盘上",
			"row.leaseReclaimed": "工作区：已被账本回收清除",
			"row.leaseNone": "工作区：绑定已记录，但从未被占用",
			"row.expand": "展开 {report}",
			"row.collapse": "收起 {report}",
			"row.last": "最后",
			"hop.authored": "发起",
			"hop.contributed": "共写",
			"hop.sent": "主送",
			"hop.delivered": "送达",
			"hop.cc": "抄送",
			"hop.forwarded": "转呈",
			"hop.copied": "副本",
			"hop.read": "阅读",
			"hop.acked": "回执",
			"hop.leased": "认领工作区",
			"hop.released": "释放工作区",
			"hop.reclaimed": "回收工作区",
			"hop.amended": "修正",
			"hop.closed": "结案",
			"hop.reopened": "重开",
			"hop.transferred": "转交",
			"filter.all": "全部",
			"filter.open": "进行中",
			"filter.acked": "已回执",
			"filter.closed": "已结案",
			"filter.search": "搜索主题、编号、会话或收发…",
			"filter.clear": "清除",
			"filter.showing": "显示 {visible}/{total} 份汇报",
			"filter.none": "没有符合当前筛选的汇报。",
			"filter.hint": "状态筛选只作用于汇报；搜索会同时匹配会话标题与编号，以及任务标签和检出名。",
			"basis.created": "按创建",
			"basis.updated": "按最近活动",
			"basis.hint": "汇报按创建时间还是按最后一次活动排入时间线；会话始终按创建时间。",
			"detail.thread": "线程",
			"detail.parent": "上溯",
			"detail.children": "下递",
			"detail.openLinked": "打开 {report}",
			"detail.outside": "{report} 不在当前会话树的列表里（它可能属于另一条线）；正文与路径仍可读取。",
			"detail.filteredOut": "{report} 在当前筛选下被隐藏了（用「清除」恢复）。",
			"detail.backToList": "回到列表",
			"detail.bodyTruncated": "正文过长，此处只显示开头 {chars} 字；完整内容见账本文件。",
			"detail.openFile": "用默认应用打开",
			"detail.openFileMenu": "更多打开方式",
			"detail.openFileLoading": "正在读取应用…",
			"detail.revealFile": "在文件管理器中显示",
			"detail.openFileFailed": "打开失败",
			"detail.expandBody": "展开正文",
			"detail.collapseBody": "收起正文",
			"cardgraph.external": "树外",
			"cardgraph.outside": "范围外",
			"cardgraph.all": "全部",
			"cardgraph.breadcrumb": "当前范围",
			"cardgraph.enterFrame": "进入 {title}",
			"cardgraph.up": "上一级",
			"cardgraph.zoomIn": "放大",
			"cardgraph.zoomOut": "缩小",
			"cardgraph.zoom": "{percent}%",
			"cardgraph.fit": "填满宽度",
			"cardgraph.summary": "{frames} 个框 · {cards} 份汇报",
			"cardgraph.empty": "没有汇报",
			"cardgraph.gestureHint": "滚轮平移 · Ctrl+滚轮缩放 · 双击会话框进入",
			"cardgraph.hideKind": "隐藏{kind}",
			"cardgraph.showKind": "显示{kind}",
			"sidebar.guideTitle": "汇报画布",
			"sidebar.guideDescription": "把拓扑画布停靠进右侧栏",
			"sidebar.chip": "汇报画布",
			"body.copy": "复制",
			"body.copied": "已复制",
			"body.footnotes": "脚注"
		};
		/** English dictionary, checked against the Chinese key set. */
		const en = {
			"view.tab": "Reports",
			"view.loading": "Reading the ledger…",
			"view.summary": "{sessions} sessions · {reports} reports",
			"view.empty": "No reports in this session tree yet. Once an agent opens one with report_author, its digest card appears here.",
			"view.refresh": "Refresh",
			"view.retry": "Retry",
			"view.error": "Read failed: {code}",
			"view.live": "live",
			"view.delegated": "subagent",
			"view.detail.loading": "Reading the transfer path…",
			"view.detail.route": "Transfer path",
			"view.detail.routeEmpty": "(no hops recorded yet)",
			"view.detail.pending": "Still owed to: {targets}",
			"view.detail.body": "Body",
			"view.detail.path": "Ledger file",
			"view.copyPath": "Copy the ledger path",
			"row.hops": "{count} hops",
			"row.authors": "{count} authors",
			"row.filterByTask": "Show only task \"{task}\"",
			"row.filterByWorktree": "Show only checkout \"{worktree}\"",
			"row.leaseHeld": "Checkout: currently claimed by this report",
			"row.leaseReleased": "Checkout: claim ended, the checkout is still on disk",
			"row.leaseReclaimed": "Checkout: cleared away by the ledger",
			"row.leaseNone": "Checkout: bound but never claimed",
			"row.expand": "Expand {report}",
			"row.collapse": "Collapse {report}",
			"row.last": "last",
			"hop.authored": "authored",
			"hop.contributed": "contributed",
			"hop.sent": "sent",
			"hop.delivered": "delivered",
			"hop.cc": "cc",
			"hop.forwarded": "forwarded",
			"hop.copied": "copied",
			"hop.read": "read",
			"hop.acked": "acked",
			"hop.leased": "leased",
			"hop.released": "released",
			"hop.reclaimed": "reclaimed",
			"hop.amended": "amended",
			"hop.closed": "closed",
			"hop.reopened": "reopened",
			"hop.transferred": "transferred",
			"filter.all": "All",
			"filter.open": "Open",
			"filter.acked": "Acked",
			"filter.closed": "Closed",
			"filter.search": "Search subject, id, session, or people…",
			"filter.clear": "Clear",
			"filter.showing": "Showing {visible}/{total} reports",
			"filter.none": "No reports match the current filter.",
			"filter.hint": "The status filter narrows reports only; search matches every row, including session titles and ids, task labels and checkout names.",
			"basis.created": "By creation",
			"basis.updated": "By activity",
			"basis.hint": "Whether reports are placed at creation or at their latest activity; sessions always keep their creation time.",
			"detail.thread": "Thread",
			"detail.parent": "Answers",
			"detail.children": "Answered by",
			"detail.openLinked": "Open {report}",
			"detail.outside": "{report} is not in this session tree's list (it may belong to another line); its body and path are still readable.",
			"detail.filteredOut": "{report} is hidden by the current filter (use Clear to restore it).",
			"detail.backToList": "Back to the list",
			"detail.bodyTruncated": "Body is long, so only the first {chars} characters are shown here; the ledger file has the whole thing.",
			"detail.openFile": "Open in default app",
			"detail.openFileMenu": "Open another way",
			"detail.openFileLoading": "Reading applications…",
			"detail.revealFile": "Show in file manager",
			"detail.openFileFailed": "Could not open",
			"detail.expandBody": "Expand the body",
			"detail.collapseBody": "Collapse the body",
			"cardgraph.external": "outside",
			"cardgraph.outside": "outside the scope",
			"cardgraph.all": "All",
			"cardgraph.breadcrumb": "Current scope",
			"cardgraph.enterFrame": "Enter {title}",
			"cardgraph.up": "Up one level",
			"cardgraph.zoomIn": "Zoom in",
			"cardgraph.zoomOut": "Zoom out",
			"cardgraph.zoom": "{percent}%",
			"cardgraph.fit": "Fill width",
			"cardgraph.summary": "{frames} frames · {cards} reports",
			"cardgraph.empty": "no reports",
			"cardgraph.gestureHint": "Wheel pans · Ctrl+wheel zooms · Double-click a frame to enter",
			"cardgraph.hideKind": "Hide {kind}",
			"cardgraph.showKind": "Show {kind}",
			"sidebar.guideTitle": "Report canvas",
			"sidebar.guideDescription": "Dock the topology canvas into the right sidebar",
			"sidebar.chip": "Report canvas",
			"body.copy": "Copy",
			"body.copied": "Copied",
			"body.footnotes": "Footnotes"
		};
		/**
		* Lifecycle state → dictionary key.
		*
		* Deliberately the SAME keys the toolbar's filter chips use. A card's status
		* chip and the filter that selects it name one state, so giving them two
		* vocabularies (raw `open` on the card, 进行中 in the toolbar) made the reader
		* build the mapping themselves — and the mapping was the bug, not the words.
		*/
		const STATUS_LABEL = {
			open: "filter.open",
			acked: "filter.acked",
			closed: "filter.closed"
		};
		/**
		* Lifecycle state → the shell's chip tone.
		*
		* Colour-coded status is the point of the chip, and the shell's palette already
		* has the three tones this needs — so the states ride `Tag` instead of a
		* hand-mixed background. `open` reads as the one that wants attention. The tone
		* names are the ones the shell's CSS actually defines (`[data-tone=…]`), which
		* is a longer list than the shipped views happen to use.
		*/
		const STATUS_TONE = {
			open: "warning",
			acked: "success",
			closed: "neutral"
		};
		/**
		* Edge kind → the word the drawing calls it.
		*
		* The drawing borrows the transfer path's own vocabulary rather than inventing a
		* second one: an arrow in the canvas and a row in the panel name the same
		* relation, so they say the same thing.
		*/
		const EDGE_LABEL = {
			to: "hop.sent",
			cc: "hop.cc",
			author: "hop.contributed",
			thread: "detail.thread"
		};
		/** Lease-state description, for the checkout chip's tooltip. */
		const LEASE_HINT = {
			held: "row.leaseHeld",
			released: "row.leaseReleased",
			reclaimed: "row.leaseReclaimed",
			none: "row.leaseNone"
		};
		/**
		* Transfer-path hop action → dictionary key.
		*
		* These are ledger vocabulary: the model and the ledger files keep the raw
		* tokens (`authored`, `delivered`, …), and only the human view speaks a
		* language. Keyed by the full action union so a new hop action cannot ship
		* without a word for it.
		*/
		const HOP_LABEL = {
			authored: "hop.authored",
			contributed: "hop.contributed",
			sent: "hop.sent",
			delivered: "hop.delivered",
			cc: "hop.cc",
			forwarded: "hop.forwarded",
			copied: "hop.copied",
			read: "hop.read",
			acked: "hop.acked",
			leased: "hop.leased",
			released: "hop.released",
			reclaimed: "hop.reclaimed",
			amended: "hop.amended",
			closed: "hop.closed",
			reopened: "hop.reopened",
			transferred: "hop.transferred"
		};
		//#endregion
		//#region src/client/ReportDetailView.tsx
		/**
		* One report's detail: its transfer path, its thread links, and its body.
		*
		* Shared by the two surfaces that show a report — the conversation tab, where it
		* opens in place under its row, and the right column's canvas tab, where it opens
		* under the drawing. One implementation on purpose: the two are read side by
		* side, and the same report must not read differently in them.
		*
		* The two variants differ in exactly two ways, both about who owns the space:
		* a row's panel grows with the timeline's own scroll (so it has no inner scroll
		* box — a nested scroller would only steal the wheel), while a docked panel hands
		* over a finite height and the detail takes its share of it and scrolls inside.
		*
		* @module dsh-report-ledger/client/ReportDetailView
		*/
		const time = {
			color: "var(--dsw-alias-label-caption, #999)",
			fontSize: "var(--dsw-font-xxxs-11-font-size, 11px)",
			whiteSpace: "nowrap"
		};
		/**
		* The same caption look, for content that must be allowed to WRAP.
		*
		* `time` sets `white-space: nowrap`, which is right for a timestamp and wrong for
		* anything whose length the ledger decides: a nowrap element's min-content width
		* is its whole unbreakable line, so inside a `1fr` grid track it grows the track
		* past its container. Recipient lists and hop notes are exactly that — which is
		* how the transfer path used to push the whole tab into a horizontal scrollbar.
		*/
		const wrap = {
			...time,
			whiteSpace: "normal",
			minWidth: 0,
			overflowWrap: "anywhere"
		};
		/** The frame the rendered body sits in — a block, not a scroll box. */
		const bodyFrame = {
			padding: "8px 10px",
			background: "var(--dsw-alias-bg-base, rgba(0,0,0,0.02))",
			border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))",
			borderRadius: "4px"
		};
		/** The body's disclosure line, and the digest it shows while closed. */
		const bodyHead = {
			display: "flex",
			alignItems: "baseline",
			gap: "6px",
			margin: "8px 0 4px",
			flexWrap: "wrap"
		};
		const digestLine = {
			display: "inline-flex",
			alignItems: "baseline",
			gap: "6px",
			flexWrap: "wrap",
			color: "var(--dsw-alias-label-caption, #70757d)",
			fontSize: "var(--dsw-font-xxxs-11-font-size, 11px)"
		};
		/** The ledger file as a delivery card: type tile, two lines, one compact control. */
		const fileCard = {
			display: "flex",
			alignItems: "center",
			gap: "10px",
			padding: "8px 10px",
			marginTop: "6px",
			borderRadius: "8px",
			background: "var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.02))",
			border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08))"
		};
		/** The delivery cards' file-type tile: white at 50% in light, 5% in dark (their rule). */
		const fileTile = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: "30px",
			height: "30px",
			borderRadius: "6px",
			background: "var(--dsw-alias-bg-layer-3, rgba(0,0,0,0.05))",
			flex: "0 0 auto"
		};
		const fileName = {
			display: "block",
			fontWeight: 500,
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis"
		};
		const filePath = {
			display: "block",
			color: "var(--dsw-alias-label-caption, #70757d)",
			fontSize: "var(--dsw-font-xxxs-11-font-size, 11px)",
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis"
		};
		/** The native control, one pill: default-app part and the picker part, divided. */
		const split = {
			display: "inline-flex",
			alignItems: "stretch",
			borderRadius: "6px",
			border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.12))",
			overflow: "hidden"
		};
		const splitPart = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: "26px",
			height: "24px",
			padding: 0,
			border: 0,
			background: "transparent",
			color: "inherit",
			cursor: "pointer"
		};
		/** A row's inline panel: indented under its row, growing with the page. */
		const rowBox = {
			margin: "4px 0 10px 24px",
			padding: "10px 12px",
			borderRadius: "6px",
			background: "var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.03))",
			border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))"
		};
		/**
		* How one hop reads in the rail.
		*
		* The four wire kinds on the canvas already own a colour semantics, so the path
		* reuses it rather than inventing a second one: a delivery is the business blue,
		* participation and acknowledgement are the success green, addressing (cc, copy)
		* is the quiet caption grey, and state changes take the warning ink.
		*
		* The dot's fill is the one non-colour cue: a **filled** dot is a hop that moved
		* or changed the report, a **hollow** one is addressing, observation or checkout
		* bookkeeping. Read in grayscale, the timeline still separates "what happened to
		* it" from "who merely saw it".
		*/
		const HOP_TONE = {
			authored: {
				colour: "var(--dsw-alias-state-business-primary, #4176e6)",
				emphasis: "filled"
			},
			contributed: {
				colour: "var(--dsw-alias-state-success-primary, #1f9254)",
				emphasis: "filled"
			},
			sent: {
				colour: "var(--dsw-alias-state-business-primary, #4176e6)",
				emphasis: "filled"
			},
			delivered: {
				colour: "var(--dsw-alias-state-success-primary, #1f9254)",
				emphasis: "hollow"
			},
			cc: {
				colour: "var(--dsw-alias-label-caption, #70757d)",
				emphasis: "hollow"
			},
			forwarded: {
				colour: "var(--dsw-alias-state-business-primary, #4176e6)",
				emphasis: "filled"
			},
			copied: {
				colour: "var(--dsw-alias-label-caption, #70757d)",
				emphasis: "hollow"
			},
			read: {
				colour: "var(--dsw-alias-label-caption, #70757d)",
				emphasis: "hollow"
			},
			acked: {
				colour: "var(--dsw-alias-state-success-primary, #1f9254)",
				emphasis: "filled"
			},
			leased: {
				colour: "var(--dsw-alias-label-tertiary, #9aa0a8)",
				emphasis: "hollow"
			},
			released: {
				colour: "var(--dsw-alias-label-tertiary, #9aa0a8)",
				emphasis: "hollow"
			},
			reclaimed: {
				colour: "var(--dsw-alias-label-tertiary, #9aa0a8)",
				emphasis: "hollow"
			},
			amended: {
				colour: "var(--dsw-alias-state-warn-primary, #c77700)",
				emphasis: "filled"
			},
			closed: {
				colour: "var(--dsw-alias-label-caption, #70757d)",
				emphasis: "filled"
			},
			reopened: {
				colour: "var(--dsw-alias-state-warn-primary, #c77700)",
				emphasis: "filled"
			},
			transferred: {
				colour: "var(--dsw-alias-state-business-primary, #4176e6)",
				emphasis: "filled"
			}
		};
		/** The rail: a list, because the hops are a sequence and a screen reader should hear one. */
		const rail = {
			listStyle: "none",
			margin: "0 0 8px",
			padding: 0
		};
		const railItem = {
			display: "flex",
			gap: "8px",
			alignItems: "stretch"
		};
		/** The dot-and-line column; `stretch` keeps the connector reaching the next row. */
		const railSpine = {
			display: "flex",
			flexDirection: "column",
			alignItems: "center",
			width: "12px",
			flex: "0 0 12px",
			paddingTop: "4px"
		};
		/** A GitHub-style marker: a token-coloured ring; filled when the hop moved something. */
		const railDot = {
			width: "10px",
			height: "10px",
			borderRadius: "50%",
			border: "2px solid currentColor",
			background: "var(--dsw-alias-bg-layer-2, #fff)",
			boxSizing: "border-box",
			flex: "0 0 auto"
		};
		/** The connector is always the neutral border, whatever the hop's colour is. */
		const railSegment = {
			flex: "1 1 auto",
			borderLeft: "2px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))",
			margin: "2px 0 -2px",
			minHeight: "8px"
		};
		const railBody = {
			display: "flex",
			flexDirection: "column",
			gap: "2px",
			flex: "1 1 auto",
			minWidth: 0,
			padding: "0 0 8px"
		};
		const railHead = {
			display: "flex",
			alignItems: "baseline",
			gap: "6px",
			flexWrap: "wrap"
		};
		/** The action label: a tinted chip — the colour lives in the fill, not in a border. */
		const hopAction = {
			borderRadius: "4px",
			padding: "0 6px",
			fontSize: "var(--dsw-font-xxxs-11-font-size, 11px)",
			fontWeight: 500,
			lineHeight: "16px",
			whiteSpace: "nowrap"
		};
		/**
		* One session reference.
		*
		* The actor and every recipient share this exact chip. That is the point: an
		* arrow with plain text on one side and a boxed id on the other reads as if the
		* two ends were different kinds of thing, and they are not — both are sessions.
		*/
		const hopRef = {
			background: "var(--dsw-alias-bg-layer-3, rgba(0,0,0,0.04))",
			borderRadius: "4px",
			padding: "0 5px",
			fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)",
			fontSize: "var(--dsw-font-xxxs-11-font-size, 11px)",
			lineHeight: "16px",
			whiteSpace: "nowrap"
		};
		const hopArrow = {
			color: "var(--dsw-alias-label-tertiary, #aaa)",
			fontSize: "11px",
			margin: "0 -2px"
		};
		const hopNote = {
			...time,
			whiteSpace: "normal",
			overflowWrap: "anywhere"
		};
		/** A docked panel's share: a column that owns its height and scrolls inside it. */
		const pane = {
			display: "flex",
			flexDirection: "column",
			height: "100%",
			minHeight: 0,
			padding: "8px 12px 10px",
			borderTop: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08))",
			background: "var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.02))"
		};
		const paneHead = {
			display: "flex",
			alignItems: "center",
			gap: "8px",
			marginBottom: "6px"
		};
		const paneBody = {
			flex: "1 1 auto",
			minHeight: 0,
			overflow: "auto"
		};
		/**
		* The ledger file, dressed as one of the GUI's delivery cards.
		*
		* The delivery cards in a finished turn are the shape this GUI uses for "here is
		* a file": a type icon in a rounded tile, the filename, one muted line, and a
		* compact native split control on the right. That is what a reader already knows
		* how to use, so the ledger file borrows it instead of inventing a row of outline
		* buttons — and the control inside is the same "open in default app + picker +
		* reveal" the shell's own cards carry (`path-opener.ts` explains why it is
		* re-built on the public Remote verbs rather than imported).
		*
		* Without a Host desktop the card still renders: the icon and the path are the
		* file, and copying the path stays available from the same menu.
		* @param props - the file to show and open, the lazy opener, and the translator.
		* @returns the file card.
		*/
		function OpenFileCard({ path, opener, t }) {
			const [desktop, setDesktop] = (0, react.useState)("unknown");
			const [apps, setApps] = (0, react.useState)(null);
			const [menu, setMenu] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)(false);
			const [failed, setFailed] = (0, react.useState)(false);
			const [copied, setCopied] = (0, react.useState)(false);
			const loading = (0, react.useRef)(null);
			const copiedTimer = (0, react.useRef)(void 0);
			(0, react.useEffect)(() => {
				let cancelled = false;
				const face = opener?.();
				if (face === void 0) {
					setDesktop("no");
					return () => {
						cancelled = true;
					};
				}
				face.available().then((yes) => {
					if (cancelled) return;
					setDesktop(yes ? "yes" : "no");
					if (!yes) return;
					const controller = new AbortController();
					loading.current = controller;
					face.applications(path, controller.signal).then((list) => {
						if (!controller.signal.aborted) setApps(list ?? []);
					}).catch(() => {
						if (!controller.signal.aborted) setApps([]);
					});
				}).catch(() => {
					if (!cancelled) setDesktop("no");
				});
				return () => {
					cancelled = true;
					loading.current?.abort();
					if (copiedTimer.current !== void 0) globalThis.clearTimeout(copiedTimer.current);
				};
			}, [opener, path]);
			(0, react.useEffect)(() => {
				if (!menu || apps !== null) return;
				const face = opener?.();
				if (face === void 0) return;
				loading.current?.abort();
				const controller = new AbortController();
				loading.current = controller;
				face.applications(path, controller.signal).then((list) => {
					if (!controller.signal.aborted) setApps(list ?? []);
				}).catch(() => {
					if (!controller.signal.aborted) setApps([]);
				});
				return () => {
					controller.abort();
				};
			}, [
				apps,
				menu,
				opener,
				path
			]);
			const act = (0, react.useCallback)((action, application) => {
				const face = opener?.();
				if (face === void 0) return;
				setBusy(true);
				setFailed(false);
				setMenu(false);
				face.open(path, action, application).then((ok) => {
					if (!ok) setFailed(true);
				}).catch(() => {
					setFailed(true);
				}).finally(() => {
					setBusy(false);
				});
			}, [opener, path]);
			const copy = (0, react.useCallback)(() => {
				setMenu(false);
				(0, _deepseek_ai_dsh_client_ui_primitives.writeClipboard)(path).then((ok) => {
					if (!ok) return;
					setCopied(true);
					if (copiedTimer.current !== void 0) globalThis.clearTimeout(copiedTimer.current);
					copiedTimer.current = globalThis.setTimeout(() => {
						setCopied(false);
					}, COPIED_HOLD_MS);
				});
			}, [path]);
			const base = path.split(/[\\/]/).pop() ?? path;
			const defaultApp = apps?.find((app) => app.default === true);
			const items = desktop === "yes" ? [
				{
					id: "default",
					label: t("detail.openFile")
				},
				...apps === null ? [{
					type: "label",
					id: "loading",
					text: t("detail.openFileLoading")
				}] : apps.map((app) => ({
					id: `app:${app.id}`,
					label: app.name,
					...app.icon === null ? {} : { icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
						src: app.icon,
						alt: "",
						width: 14,
						height: 14
					}) }
				})),
				{
					type: "separator",
					id: "sep-native"
				},
				{
					id: "reveal",
					label: t("detail.revealFile")
				},
				{
					type: "separator",
					id: "sep-copy"
				},
				{
					id: "copy",
					label: t("view.copyPath"),
					icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCopyOutlineRegular, { size: 14 })
				}
			] : [{
				id: "copy",
				label: t("view.copyPath"),
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCopyOutlineRegular, { size: 14 })
			}];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: fileCard,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: fileTile,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.FileTypeIcon, {
							path,
							size: 18
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: {
							flex: "1 1 auto",
							minWidth: 0
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: fileName,
							children: [
								t("view.detail.path"),
								" · ",
								base
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: filePath,
							title: path,
							children: copied ? t("body.copied") : failed ? t("detail.openFileFailed") : path
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							display: "inline-flex",
							alignItems: "center",
							gap: "6px",
							flex: "0 0 auto"
						},
						children: desktop === "yes" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: split,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
								label: t("detail.openFile"),
								side: "top",
								delayMs: 400,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									"aria-label": t("detail.openFile"),
									disabled: busy,
									onClick: () => {
										act("open");
									},
									style: splitPart,
									children: defaultApp !== void 0 && defaultApp.icon !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
										src: defaultApp.icon,
										alt: "",
										width: 14,
										height: 14
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenOutlineRegular, { size: 14 })
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
								open: menu,
								anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									"aria-label": t("detail.openFileMenu"),
									"aria-expanded": menu,
									disabled: busy,
									onClick: () => {
										setMenu((current) => !current);
									},
									style: {
										...splitPart,
										borderLeft: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.12))"
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { size: 14 })
								}),
								items,
								align: "end",
								portal: true,
								onSelect: (id) => {
									if (id === "default") act("open");
									else if (id === "reveal") act("reveal");
									else if (id === "copy") copy();
									else if (id.startsWith("app:")) act("open", id.slice(4));
								},
								onClose: () => {
									setMenu(false);
								}
							})]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							"aria-label": t("view.copyPath"),
							title: t("view.copyPath"),
							onClick: copy,
							style: splitPart,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCopyOutlineRegular, { size: 14 })
						})
					})
				]
			});
		}
		/**
		* Render one report: route, thread, body and path.
		* @param props - the read result, the copy seat, and how the box is dressed.
		* @returns the detail block.
		*/
		function ReportDetailView(props) {
			const { report, detail, error, t, idHint, id, variant, onOpenReport, inList, visibleInFilter, onClose, opener } = props;
			const [bodyOpen, setBodyOpen] = (0, react.useState)(false);
			/** The panel id `aria-controls` points at; only claimed while the panel exists. */
			const bodyPanelId = `${id ?? "report-ledger-detail"}-body`;
			(0, react.useEffect)(() => {
				setBodyOpen(false);
			}, [report]);
			const shownBody = (0, react.useMemo)(() => displayBody(detail?.body ?? ""), [detail]);
			const bodyText = (0, react.useMemo)(() => {
				const text = shownBody.text.trim();
				return shownBody.truncated ? closeOpenFence(text) : text;
			}, [shownBody]);
			/** Strings for the prose renderer's own controls, from this plugin's dictionary. */
			const markdownLabels = (0, react.useMemo)(() => ({
				code: {
					copyLabel: t("body.copy"),
					copiedLabel: t("body.copied")
				},
				footnotes: t("body.footnotes")
			}), [t]);
			const link = (target) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: { marginRight: "6px" },
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
					label: fill(t("detail.openLinked"), { report: target }),
					side: "bottom",
					delayMs: 400,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "outline",
						size: "sm",
						onClick: () => {
							onOpenReport(target);
						},
						children: target
					})
				})
			}, target);
			/** One session reference, the same reading the list row uses. */
			const idRef = (target) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: idHint(target),
				side: "bottom",
				delayMs: 400,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: shortId(target) })
			});
			/**
			* The collapsed body's stand-in: exactly what the front matter carries.
			*
			* The body is the long part of a report and the least often needed: a reader
			* scanning the ledger wants "who, to whom, how far, what happened last". That
			* is the digest, and it is what the closed body shows instead of a wall of
			* prose — the row above shows the same fields, and the pane variant (where
			* there is no row) relies on this line alone.
			*/
			const digest = (front) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				style: digestLine,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
						tone: STATUS_TONE[front.status],
						children: t(STATUS_LABEL[front.status])
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["from=", idRef(front.from)] }),
					front.to.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [" → ", front.to.map((target, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [index > 0 ? ", " : "", idRef(target)] }, target))] }),
					front.cc.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [" cc ", front.cc.map((target, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [index > 0 ? ", " : "", idRef(target)] }, target))] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: ` · ${fill(t("row.hops"), { count: front.hops })}` }),
					front.last === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: ` · ${t("row.last")} ${t(HOP_LABEL[front.last.action])}` }),
					front.task === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
						tone: "info",
						children: front.task
					})
				]
			});
			const content = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: { color: "var(--dsw-alias-state-error-primary, #b00)" },
					children: t("view.error", { code: error })
				}) : null,
				detail === void 0 && error === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: time,
					children: t("view.detail.loading")
				}) : null,
				detail === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: { marginBottom: "6px" },
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("view.detail.route") })
					}),
					detail.hops.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: time,
						children: t("view.detail.routeEmpty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
						style: rail,
						children: detail.hops.map((hop, hopIndex) => {
							const tone = HOP_TONE[hop.action];
							const last = hopIndex === detail.hops.length - 1;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
								style: railItem,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									"aria-hidden": "true",
									style: {
										...railSpine,
										color: tone.colour
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
										...railDot,
										background: tone.emphasis === "filled" ? tone.colour : "var(--dsw-alias-bg-layer-2, #fff)"
									} }), last ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: railSegment })]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: railBody,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: railHead,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													...hopAction,
													color: tone.colour,
													background: `color-mix(in srgb, ${tone.colour} 13%, transparent)`
												},
												children: t(HOP_LABEL[hop.action])
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
												label: idHint(hop.actor),
												side: "bottom",
												delayMs: 400,
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: hopRef,
													children: shortId(hop.actor)
												})
											}),
											hop.to.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												"aria-hidden": "true",
												style: hopArrow,
												children: "→"
											}), hop.to.map((target) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
												label: idHint(target),
												side: "bottom",
												delayMs: 400,
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: hopRef,
													children: shortId(target)
												})
											}, target))] }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: "1 1 auto" } }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: time,
												children: stamp(hop.at)
											})
										]
									}), hop.note === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: hopNote,
										children: hop.note
									})]
								})]
							}, `h-${hopIndex}`);
						})
					}),
					detail.pending.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...wrap,
							display: "flex",
							alignItems: "baseline",
							gap: "6px"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
							state: "warning",
							size: 8
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: fill(t("view.detail.pending"), { targets: detail.pending.join(", ") }) })]
					}),
					(() => {
						const parent = detail.front.parent;
						const children = detail.front.children;
						if (parent === void 0 && children.length === 0) return null;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: { marginBottom: "8px" },
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("detail.thread") }),
								parent === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: { marginTop: "2px" },
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: time,
										children: `${t("detail.parent")}: `
									}), link(parent)]
								}),
								children.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: { marginTop: "2px" },
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: time,
										children: `${t("detail.children")}: `
									}), children.map(link)]
								})
							]
						});
					})(),
					inList ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...wrap,
							marginBottom: "8px"
						},
						children: [
							fill(t("detail.outside"), { report: detail.front.report }),
							" ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								onClick: () => {
									onOpenReport(void 0);
								},
								children: t("detail.backToList")
							})
						]
					}),
					inList && !visibleInFilter ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							...wrap,
							marginBottom: "8px"
						},
						children: fill(t("detail.filteredOut"), { report: detail.front.report })
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: bodyHead,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "ghost",
								size: "sm",
								icon: bodyOpen ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { size: 14 }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutlineRegular, { size: 14 }),
								"aria-expanded": bodyOpen,
								...bodyOpen ? { "aria-controls": bodyPanelId } : {},
								"aria-label": bodyOpen ? t("detail.collapseBody") : t("detail.expandBody"),
								title: bodyOpen ? t("detail.collapseBody") : t("detail.expandBody"),
								onClick: () => {
									setBodyOpen((open) => !open);
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("view.detail.body") }),
							bodyOpen ? null : digest(detail.front)
						]
					}),
					bodyOpen ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						id: bodyPanelId,
						style: bodyFrame,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, {
							text: bodyText,
							labels: markdownLabels
						})
					}) : null,
					bodyOpen && shownBody.truncated ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							...wrap,
							marginTop: "4px"
						},
						children: fill(t("detail.bodyTruncated"), { chars: shownBody.text.trim().length })
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(OpenFileCard, {
						path: detail.path,
						opener,
						t
					})
				] })
			] });
			if (variant === "pane") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: pane,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: paneHead,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: report }), onClose === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "ghost",
						size: "sm",
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { size: 14 }),
						"aria-label": fill(t("row.collapse"), { report }),
						onClick: onClose
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: paneBody,
					children: content
				})]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				id,
				style: rowBox,
				children: content
			});
		}
		//#endregion
		//#region src/client/selection-bridge.ts
		let state = {};
		const listeners = /* @__PURE__ */ new Set();
		const same = (a, b) => a.session === b.session && a.report === b.report && a.hover === b.hover && a.hoverFrom === b.hoverFrom;
		/**
		* Replace the state and tell the subscribers, but only when it really changed.
		*
		* The short-circuit is not a micro-optimization: a pointer crossing a card fires
		* several moves, and an unchanged snapshot must not re-render the other surface
		* (the list can be hundreds of rows).
		* @param next - the state to publish.
		*/
		const commit = (next) => {
			if (same(state, next)) return;
			state = next;
			for (const listener of listeners) listener();
		};
		/** The shared selection, as the two surfaces use it. */
		const selection = {
			/** @returns the current snapshot; stable by identity until a change. */
			get() {
				return state;
			},
			/**
			* Subscribe to changes.
			* @param listener - called after every change.
			* @returns the unsubscribe function.
			*/
			subscribe(listener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			/**
			* Publish the open report. Only the surface that owns the list should call it
			* with a value; the canvas calls it to *request* the open (see the sidebar tab).
			* @param report - report to open, or `undefined` to close.
			* @param session - session the report belongs to.
			*/
			open(report, session) {
				commit({
					...state,
					report,
					session
				});
			},
			/**
			* Point at one report.
			* @param report - report the pointer entered.
			* @param from - the surface that saw it.
			*/
			hover(report, from) {
				commit({
					...state,
					hover: report,
					hoverFrom: from
				});
			},
			/**
			* Clear the hover — but only the one this surface published.
			*
			* A canvas pointerleaving its box must not erase a hover that a list row just
			* published (they are different pointers on the same mouse, and the second one
			* happened later).
			* @param from - the surface whose hover should end.
			*/
			clearHover(from) {
				if (state.hoverFrom !== from) return;
				commit({
					...state,
					hover: void 0,
					hoverFrom: void 0
				});
			},
			/** Forget everything; used when a session goes away. */
			reset() {
				commit({});
			}
		};
		//#endregion
		//#region src/client/timeline-source.ts
		/**
		* The ledger's browser-side read path: the two endpoints, the poll cadence, and
		* the one way any view reads them.
		*
		* Two surfaces now draw the same ledger for the same session — the conversation
		* tab and the canvas tab in the right column. Keeping the envelope unwrapping
		* and the polling rule here is what stops the second surface from growing a
		* second opinion about either; that kind of drift does not fail loudly, it just
		* leaves one of the two views quietly rendering nothing.
		*
		* @module dsh-report-ledger/client/timeline-source
		*/
		/** The timeline read endpoint, addressed by the tree's root session. */
		const TIMELINE_URL = "/api/report-ledger/timeline";
		/** One report's detail: its transfer path and its body. */
		const REPORT_URL = "/api/report-ledger/report";
		/**
		* How often a mounted view re-reads the timeline.
		*
		* The ledger is written by other agents in the background, so a view that loads
		* once goes stale precisely when it matters — the human is watching for a report
		* that has not been written yet. Ten seconds is quiet enough not to matter on a
		* large ledger and still fast enough to watch a collaboration happen.
		*/
		const POLL_INTERVAL_MS = 1e4;
		/** Read one endpoint and unwrap its result envelope. */
		async function getJson(url) {
			const response = await fetch(url, {
				credentials: "same-origin",
				headers: { accept: "application/json" }
			});
			let body;
			try {
				body = await response.json();
			} catch {
				throw new Error(`HTTP ${response.status}`);
			}
			const envelope = body;
			if (envelope.ok !== true) throw new Error(envelope.code ?? `HTTP ${response.status}`);
			return envelope.value;
		}
		/**
		* Follow one session tree's timeline for as long as the caller is mounted.
		*
		* Reads on mount and on every session change, then on the poll cadence. Polling
		* stops while the page is hidden and a returning page catches up immediately, so
		* a background panel costs nothing and a foreground one is never behind.
		* @param sessionId - the tree's root session; an empty value reads nothing.
		* @returns the latest payload, its error, and a manual refresh.
		*/
		function useTimeline(sessionId) {
			const [payload, setPayload] = (0, react.useState)(void 0);
			const [error, setError] = (0, react.useState)(void 0);
			const [nonce, setNonce] = (0, react.useState)(0);
			(0, react.useEffect)(() => {
				if (sessionId === "") {
					setError("no-session");
					setPayload(void 0);
					return;
				}
				let cancelled = false;
				getJson(`${TIMELINE_URL}?root=${encodeURIComponent(sessionId)}`).then((value) => {
					if (cancelled) return;
					setPayload(value);
					setError(void 0);
				}).catch((cause) => {
					if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
				});
				return () => {
					cancelled = true;
				};
			}, [sessionId, nonce]);
			(0, react.useEffect)(() => {
				if (sessionId === "") return void 0;
				const tick = () => {
					if (globalThis.document?.visibilityState === "hidden") return;
					setNonce((value) => value + 1);
				};
				const timer = globalThis.setInterval(tick, POLL_INTERVAL_MS);
				const onVisibility = () => {
					if (globalThis.document?.visibilityState !== "hidden") tick();
				};
				globalThis.document?.addEventListener("visibilitychange", onVisibility);
				return () => {
					globalThis.clearInterval(timer);
					globalThis.document?.removeEventListener("visibilitychange", onVisibility);
				};
			}, [sessionId]);
			return {
				payload,
				error,
				refresh: (0, react.useCallback)(() => {
					setNonce((value) => value + 1);
				}, [])
			};
		}
		/**
		* Read one report's detail, for whichever surface is showing it.
		*
		* Not polled on its own: the caller owns the cadence, because the two surfaces
		* want different ones — the conversation tab re-reads it when the reader hits
		* refresh, while a docked panel passes its own timeline tick so a report being
		* written under the reader's eyes keeps up.
		*
		* A re-read of the SAME report therefore keeps the previous detail on screen
		* until the new one arrives: clearing it would turn every tick into a flash of
		* "reading the transfer path" over a body the reader is in the middle of. A read
		* for a DIFFERENT report is a different question, so the state is keyed by report
		* id and anything read for another report is never returned — that is what stops
		* one click from rendering the previous report's body under the new one, even for
		* a frame.
		*
		* Errors follow the same rule: a failed re-read keeps the detail and reports the
		* failure beside it, and only a successful read clears it.
		* @param report - the report to read; `undefined` clears the read.
		* @param nonce - bump to re-read the same report.
		* @returns the detail for `report` only, its error, and nothing else.
		*/
		function useReportDetail(report, nonce) {
			const [state, setState] = (0, react.useState)(void 0);
			(0, react.useEffect)(() => {
				if (report === void 0) return void 0;
				let cancelled = false;
				getJson(`${REPORT_URL}?id=${encodeURIComponent(report)}`).then((value) => {
					if (!cancelled) setState({
						report,
						detail: value
					});
				}).catch((cause) => {
					if (cancelled) return;
					const message = cause instanceof Error ? cause.message : String(cause);
					setState((previous) => previous !== void 0 && previous.report === report && previous.detail !== void 0 ? {
						report,
						detail: previous.detail,
						error: message
					} : {
						report,
						error: message
					});
				});
				return () => {
					cancelled = true;
				};
			}, [report, nonce]);
			if (report === void 0 || state === void 0 || state.report !== report) return {
				detail: void 0,
				error: void 0
			};
			return {
				detail: state.detail,
				error: state.error
			};
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* The plugin's own stylesheet.
		*
		* The shell's primitives ship their own CSS with the shell, which is the whole
		* point of using them — a plugin gets the app's real look without carrying a
		* theme. What is left for us is the one thing only a consumer can know:
		*
		*  **Layout that belongs to the consumer.** `Input` sizes itself to its content
		*  (`display: inline-flex`, no width), which is right in a form and wrong in this
		*  tab's toolbar, where the search seat takes the slack. The component puts the
		*  `className` it is given on its own wrapper, so one rule is enough — and
		*  targeting a class of our own keeps us off the hashed class names, which are
		*  free to change between shell releases.
		*
		* Nothing here restyles a shell component; every library element keeps the look
		* the shell gave it. The SVG drawing rules that used to live here went with the
		* lane view they drew (R-0011): the topology is now painted by the card canvas,
		* which carries its own painter, so a stylesheet entry for a rail or an edge had
		* no consumer left.
		*
		* @module dsh-report-ledger/client/styles
		*/
		/** Class the tab puts on the toolbar's search seat. */
		const SEARCH_CLASS = "report-ledger-search";
		/** Element id, so a reload replaces the sheet instead of stacking one per apply. */
		const STYLE_ID = "dsh-report-ledger-styles";
		/** The adapter rules, kept in one place so the id and the text cannot drift. */
		const CSS = `
.${SEARCH_CLASS} { flex: 1 1 auto; min-width: 0; }
`;
		/**
		* Mount the adapter stylesheet.
		* @returns a disposer that removes it, owned by the plugin's effect scope.
		*/
		function installStyles() {
			const doc = globalThis.document;
			if (doc === void 0) return () => {};
			doc.getElementById(STYLE_ID)?.remove();
			const style = doc.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			doc.head.append(style);
			return () => {
				style.remove();
			};
		}
		//#endregion
		//#region src/client/ReportsView.tsx
		/**
		* The report timeline view — the `conversation.view` tab this plugin registers.
		*
		* It renders one top-to-bottom timeline of the collaboration: the session
		* subtree as it branched, interleaved with the reports those sessions produced
		* or were copied on. Rows carry only the digest, so a long-running tree stays
		* scannable; clicking a report opens its transfer path and body on demand.
		*
		* Data comes from this plugin's own read-only endpoint rather than a generated
		* remote: the host assembles the subtree and filters the ledger to the sessions
		* in it, which the browser cannot do on its own because a report's transfer path
		* is a host-side file, not session state.
		*
		* A blank session never reaches this component — the conversation slot is
		* omitted entirely in that state.
		*
		* @module dsh-report-ledger/client/ReportsView
		*/
		/** Storage key for the remembered status filter. */
		const FILTER_KEY = "dsh.reportLedger.filter.v1";
		/** Read the remembered status filter, tolerating absent or damaged storage. */
		function rememberedStatus() {
			try {
				const raw = globalThis.localStorage?.getItem(FILTER_KEY);
				if (typeof raw === "string") {
					const parsed = JSON.parse(raw);
					if (parsed.status === "open" || parsed.status === "acked" || parsed.status === "closed") return parsed.status;
				}
			} catch {}
			return "all";
		}
		/**
		* Render the report timeline.
		* @param props - the session binding and the locale seat.
		* @returns the tab content.
		*/
		function ReportsView(props) {
			const { sessionId, t, opener } = props;
			const [payload, setPayload] = (0, react.useState)(void 0);
			const [error, setError] = (0, react.useState)(void 0);
			const [timelineNonce, setTimelineNonce] = (0, react.useState)(0);
			const [detailNonce, setDetailNonce] = (0, react.useState)(0);
			const [openReport, setOpenReport] = (0, react.useState)(void 0);
			const [scrollTarget, setScrollTarget] = (0, react.useState)(void 0);
			/** Row containers, so a thread jump can bring its target on screen. */
			const rowRefs = (0, react.useRef)(/* @__PURE__ */ new Map());
			/**
			* What the other surface (the right column's canvas) is pointing at, and the
			* report it asked to open.
			*
			* The two surfaces are separate React trees in one bundle, so the bridge is the
			* only channel between them; this side owns the open report — the canvas only
			* requests it — and follows the hover in both directions.
			*/
			const bridged = (0, react.useSyncExternalStore)(selection.subscribe, selection.get);
			const [status, setStatus] = (0, react.useState)(rememberedStatus);
			const [text, setText] = (0, react.useState)("");
			const [basis, setBasis] = (0, react.useState)("created");
			const { detail, error: detailError } = useReportDetail(openReport, detailNonce);
			const shown = detail !== void 0 && detail.front.report === openReport ? detail : void 0;
			(0, react.useEffect)(() => {
				try {
					globalThis.localStorage?.setItem(FILTER_KEY, JSON.stringify({ status }));
				} catch {}
			}, [status]);
			(0, react.useEffect)(() => {
				setPayload(void 0);
				setError(void 0);
				setOpenReport(void 0);
				setScrollTarget(void 0);
			}, [sessionId]);
			(0, react.useEffect)(() => {
				if (sessionId === void 0 || sessionId === "") return;
				if (bridged.session !== sessionId) return;
				if (bridged.report === openReport) return;
				setOpenReport(bridged.report);
				if (bridged.report !== void 0) setScrollTarget(bridged.report);
			}, [
				bridged.report,
				bridged.session,
				openReport,
				sessionId
			]);
			(0, react.useEffect)(() => {
				if (sessionId === void 0 || sessionId === "") {
					setError("no-session");
					return;
				}
				let cancelled = false;
				getJson(`${TIMELINE_URL}?root=${encodeURIComponent(sessionId)}`).then((value) => {
					if (!cancelled) {
						setPayload(value);
						setError(void 0);
					}
				}).catch((cause) => {
					if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
				});
				return () => {
					cancelled = true;
				};
			}, [sessionId, timelineNonce]);
			(0, react.useEffect)(() => {
				if (sessionId === void 0 || sessionId === "") return void 0;
				const tick = () => {
					if (globalThis.document?.visibilityState === "hidden") return;
					setTimelineNonce((value) => value + 1);
				};
				const timer = globalThis.setInterval(tick, POLL_INTERVAL_MS);
				const onVisibility = () => {
					if (globalThis.document?.visibilityState !== "hidden") tick();
				};
				globalThis.document?.addEventListener("visibilitychange", onVisibility);
				return () => {
					globalThis.clearInterval(timer);
					globalThis.document?.removeEventListener("visibilitychange", onVisibility);
				};
			}, [sessionId]);
			const rows = (0, react.useMemo)(() => payload === void 0 ? [] : buildRows(payload, basis), [payload, basis]);
			const counts = (0, react.useMemo)(() => statusCounts(payload?.reports ?? []), [payload]);
			const inList = (0, react.useMemo)(() => payload === void 0 ? /* @__PURE__ */ new Set() : reportIds(payload), [payload]);
			const lanes = (0, react.useMemo)(() => payload === void 0 ? /* @__PURE__ */ new Map() : laneIndex(payload), [payload]);
			const depths = (0, react.useMemo)(() => payload === void 0 ? /* @__PURE__ */ new Map() : sessionDepths(payload), [payload]);
			const filter = (0, react.useMemo)(() => ({
				status,
				text
			}), [status, text]);
			const visible = (0, react.useMemo)(() => {
				const kept = filterRows(rows, filter);
				if (openReport === void 0 || shown === void 0) return kept;
				return withSynthesizedRow(kept, shown.front, basis, depths.get(shown.front.from) ?? 0);
			}, [
				rows,
				filter,
				openReport,
				shown,
				basis,
				depths
			]);
			(0, react.useEffect)(() => {
				if (scrollTarget === void 0) return;
				if (openReport !== scrollTarget) {
					setScrollTarget(void 0);
					return;
				}
				const element = rowRefs.current.get(scrollTarget);
				if (element === void 0) return;
				setScrollTarget(void 0);
				if (typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "nearest" });
			}, [
				scrollTarget,
				openReport,
				visible
			]);
			const filteredReportIds = (0, react.useMemo)(() => {
				const ids = /* @__PURE__ */ new Set();
				for (const row of filterRows(rows, filter)) if (row.kind === "report") ids.add(row.front.report);
				return ids;
			}, [rows, filter]);
			const filtering = isFiltering(filter);
			const visibleReportCount = (0, react.useMemo)(() => visibleReports(rows, filter), [rows, filter]);
			const empty = (0, react.useMemo)(() => payload === void 0 ? "none" : emptyState(payload, rows, filter), [
				payload,
				rows,
				filter
			]);
			const titles = (0, react.useMemo)(() => payload === void 0 ? /* @__PURE__ */ new Map() : sessionTitles(payload), [payload]);
			const idHint = (0, react.useCallback)((id) => {
				const title = titles.get(id);
				return title === void 0 ? id : `${title} · ${id}`;
			}, [titles]);
			/**
			* One session id the way a dense row shows it: shortened, with the full value
			* and the session title on hover. The hover is not decoration — it is where
			* the human name lives, because titles are unbounded and a row is not.
			*/
			const idRef = (id) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: idHint(id),
				side: "bottom",
				delayMs: 400,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: shortId(id) })
			});
			const refresh = (0, react.useCallback)(() => {
				setTimelineNonce((value) => value + 1);
				setDetailNonce((value) => value + 1);
			}, []);
			/**
			* Open a report that was reached through a link rather than its own row.
			*
			* A row click expands in place — the row is already under the pointer and needs
			* no help. A thread link is different: its target can be off screen, or have no
			* row at all yet (outside this tree, or hidden by the filter), so the request to
			* bring it on screen is recorded here and satisfied by the effect above when
			* the row finally mounts.
			*/
			const openLinked = (0, react.useCallback)((report) => {
				setOpenReport(report);
				setScrollTarget(report);
				selection.open(report, sessionId);
			}, [sessionId]);
			/**
			* Open or close one row, publishing the choice so the canvas can follow it.
			*
			* The row click and the disclosure button are the same act, so both go through
			* here: one owner of "what is open", one write to the bridge, no chance of the
			* two surfaces disagreeing about it.
			*/
			const toggleReport = (0, react.useCallback)((report) => {
				const next = openReport === report ? void 0 : report;
				setOpenReport(next);
				selection.open(next, sessionId);
			}, [openReport, sessionId]);
			const shell = {
				padding: "16px 20px",
				overflowY: "auto",
				height: "100%",
				font: "var(--dsw-font-xs-13, 13px/1.6 system-ui, sans-serif)",
				color: "var(--dsw-alias-label-primary, inherit)"
			};
			const head = {
				display: "flex",
				alignItems: "baseline",
				gap: "12px",
				marginBottom: "12px"
			};
			const summary = {
				color: "var(--dsw-alias-label-tertiary, #888)",
				fontSize: "var(--dsw-font-xxs-12-font-size, 12px)",
				flex: "1 1 auto"
			};
			/**
			* The toolbar's search seat.
			*
			* `Input` renders its own wrapper around the field, so the flex sizing lives
			* on this outer box rather than on the control itself.
			*/
			const searchBox = {
				flex: "1 1 200px",
				minWidth: "140px",
				display: "flex"
			};
			const tools = {
				display: "flex",
				alignItems: "center",
				flexWrap: "wrap",
				gap: "6px",
				marginBottom: "10px"
			};
			/** Chips sit next to a label; the shell's tags carry no spacing of their own. */
			const tagRow = {
				display: "inline-flex",
				gap: "4px",
				marginRight: "6px",
				verticalAlign: "baseline"
			};
			/** Keeps the state dot on the row's text baseline. */
			const dotCell = {
				display: "inline-flex",
				alignItems: "center"
			};
			/** The caption look for a timestamp; the digest's meta line reuses its colour. */
			const time = {
				color: "var(--dsw-alias-label-caption, #999)",
				fontSize: "var(--dsw-font-xxxs-11-font-size, 11px)",
				whiteSpace: "nowrap"
			};
			/** The muted caption colour, for the empty-state sentences. */
			const muted = { color: "var(--dsw-alias-label-tertiary, #888)" };
			/**
			* The strip that reports a failed re-read WITHOUT replacing the list.
			*
			* A warning, not an error: the ledger on screen is still the last thing that was
			* successfully read, and the poll keeps trying. Colouring it like a page failure
			* would teach the reader to stop believing the colour. The token is the shell's
			* warn label rather than a mixed colour, so it follows the theme.
			*/
			const notice = {
				display: "flex",
				alignItems: "center",
				gap: "6px",
				marginBottom: "10px",
				color: "var(--dsw-alias-state-warn-label, #a60)"
			};
			if (payload === void 0 && error !== void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: shell,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						alignItems: "center",
						gap: "6px"
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
						state: "error",
						size: 8
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("view.error", { code: error }) })]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: { marginTop: "8px" },
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "outline",
						onClick: refresh,
						children: t("view.retry")
					})
				})]
			});
			if (payload === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: shell,
				children: t("view.loading")
			});
			const statusLabel = {
				all: "filter.all",
				open: "filter.open",
				acked: "filter.acked",
				closed: "filter.closed"
			};
			const statusCount = {
				all: counts.all,
				open: counts.open,
				acked: counts.acked,
				closed: counts.closed
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: shell,
				children: [
					error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: notice,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
								state: "warning",
								size: 8
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { flex: "1 1 auto" },
								children: t("view.error", { code: error })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								onClick: refresh,
								children: t("view.retry")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: head,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("view.tab") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: summary,
								children: filtering ? t("filter.showing", {
									visible: visibleReportCount,
									total: counts.all
								}) : t("view.summary", {
									sessions: payload.sessions.length,
									reports: payload.reports.length
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutlineRegular, { size: 16 }),
								onClick: refresh,
								children: t("view.refresh")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: tools,
						title: t("filter.hint"),
						children: [
							[
								"all",
								"open",
								"acked",
								"closed"
							].map((candidate) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
								active: status === candidate,
								"aria-pressed": status === candidate,
								onClick: () => {
									setStatus(candidate);
								},
								children: `${t(statusLabel[candidate])} ${statusCount[candidate]}`
							}, candidate)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: searchBox,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
									type: "search",
									className: SEARCH_CLASS,
									value: text,
									placeholder: t("filter.search"),
									"aria-label": t("filter.search"),
									onChange: (event) => {
										setText(event.target.value);
									}
								})
							}),
							filtering ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								onClick: () => {
									setStatus("all");
									setText("");
								},
								children: t("filter.clear")
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
								label: t("basis.hint"),
								side: "bottom",
								delayMs: 400,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									onClick: () => {
										setBasis(basis === "created" ? "updated" : "created");
									},
									children: t(basis === "created" ? "basis.created" : "basis.updated")
								})
							})
						]
					}),
					empty === "no-reports" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: muted,
						children: t("view.empty")
					}) : null,
					empty === "filtered-out" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: muted,
						children: t("filter.none")
					}) : null,
					visible.map((row) => {
						const pad = 8 + row.depth * 18;
						if (row.kind === "session") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: "8px",
								padding: `4px 0 4px ${pad}px`,
								alignItems: "baseline"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
									label: idHint(row.id),
									side: "bottom",
									delayMs: 400,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: dotCell,
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
											state: row.live ? "ongoing" : "idle",
											size: 8
										})
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										flex: "1 1 auto",
										minWidth: 0
									},
									children: [row.delegated || row.live ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: tagRow,
										children: [row.delegated ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
											tone: "info",
											children: t("view.delegated")
										}) : null, row.live ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
											tone: "success",
											children: t("view.live")
										}) : null]
									}) : null, row.title ?? shortId(row.id)]
								}),
								row.title === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
									label: row.id,
									side: "right",
									delayMs: 400,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: time,
										children: shortId(row.id)
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: time,
									children: stamp(row.at)
								})
							]
						}, `s-${row.id}`);
						const front = row.front;
						const expanded = openReport === front.report;
						const panelId = `report-ledger-panel-${front.report}`;
						const wtLabel = worktreeLabel(front.worktree);
						const wtLane = lanes.get(front.report);
						const toggleLabel = fill(expanded ? t("row.collapse") : t("row.expand"), { report: front.report });
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							ref: (element) => {
								if (element === null) rowRefs.current.delete(front.report);
								else rowRefs.current.set(front.report, element);
							},
							style: { paddingLeft: `${pad}px` },
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								onClick: () => {
									toggleReport(front.report);
								},
								onPointerEnter: () => {
									selection.hover(front.report, "list");
								},
								onPointerLeave: () => {
									selection.clearHover("list");
								},
								style: {
									display: "flex",
									gap: "8px",
									alignItems: "baseline",
									padding: "5px 8px",
									margin: "2px 0",
									borderRadius: "6px",
									cursor: "pointer",
									background: "var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.02))",
									border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))",
									transition: "background 160ms ease-out, box-shadow 160ms ease-out",
									...bridged.hover === front.report ? {
										background: "var(--dsw-alias-state-business-tertiary, #e4edfd)",
										boxShadow: "inset 0 0 0 1px var(--dsw-alias-button-info-hover, #7aaaff)"
									} : {}
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "ghost",
										size: "sm",
										icon: expanded ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { size: 14 }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutlineRegular, { size: 14 }),
										"aria-expanded": expanded,
										...expanded ? { "aria-controls": panelId } : {},
										"aria-label": toggleLabel,
										title: toggleLabel,
										onClick: (event) => {
											event.stopPropagation();
											toggleReport(front.report);
										}
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: {
											flex: "1 1 auto",
											minWidth: 0
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: tagRow,
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
													tone: STATUS_TONE[front.status],
													children: t(STATUS_LABEL[front.status])
												})
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: front.report }),
											" ",
											front.subject,
											front.task === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
												title: fill(t("row.filterByTask"), { task: front.task }),
												onClick: (event) => {
													event.stopPropagation();
													setStatus("all");
													setText(front.task);
												},
												children: front.task
											}),
											wtLabel === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
												tone: LEASE_TONE[wtLane?.state ?? "none"],
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													title: `${fill(t("row.filterByWorktree"), { worktree: wtLabel })} — ${t(LEASE_HINT[wtLane?.state ?? "none"])}`,
													style: { cursor: "pointer" },
													onClick: (event) => {
														event.stopPropagation();
														setStatus("all");
														setText(wtLabel);
													},
													children: wtLabel
												})
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												style: {
													...time,
													marginTop: "2px",
													overflow: "hidden",
													textOverflow: "ellipsis"
												},
												children: [
													`from=`,
													idRef(front.from),
													front.to.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" → ", front.to.map((id, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [index > 0 ? ", " : "", idRef(id)] }, id))] }) : null,
													front.cc.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" cc ", front.cc.map((id, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [index > 0 ? ", " : "", idRef(id)] }, id))] }) : null,
													` · ${fill(t("row.hops"), { count: front.hops })}`,
													front.authors.length > 1 ? ` · ${fill(t("row.authors"), { count: front.authors.length })}` : "",
													front.last === void 0 ? "" : ` · ${t("row.last")} ${t(HOP_LABEL[front.last.action])}`
												]
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: time,
										children: stamp(row.at)
									})
								]
							}), expanded ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ReportDetailView, {
								report: front.report,
								detail: shown,
								error: detailError,
								t,
								idHint,
								id: panelId,
								variant: "row",
								onOpenReport: openLinked,
								inList: inList.has(front.report),
								visibleInFilter: filteredReportIds.has(front.report),
								...opener === void 0 ? {} : { opener }
							}) : null]
						}, `r-${front.report}`);
					})
				]
			});
		}
		//#endregion
		//#region src/client/cardgraph-model.ts
		/**
		* Defaults.
		*
		* A full card is 240x110 — enough for a title, a status line and two lines of
		* subject at a readable size. The chip tier is deliberately tiny: below 0.4 zoom
		* a card is a colour, and drawing readable text there would be a lie about how
		* much of the drawing the reader can actually take in.
		*/
		const DEFAULT_CARDGRAPH_OPTIONS = {
			lod: "card",
			cardMinZoom: .8,
			compactMinZoom: .4,
			sizes: {
				card: {
					width: 240,
					height: 110
				},
				compact: {
					width: 160,
					height: 36
				},
				chip: {
					width: 60,
					height: 14
				}
			},
			frameHeaderHeight: 26,
			framePaddingX: 12,
			framePaddingTop: 10,
			framePaddingBottom: 12,
			minFrameWidth: 180,
			minFrameHeight: 96,
			cardGap: 8,
			cardColumnGap: 20,
			columnGap: 48,
			frameGap: 24,
			margin: 24
		};
		/** How far out the drawing may be zoomed, in screen pixels per drawing unit. */
		const MIN_ZOOM = .25;
		/** How far in the drawing may be zoomed. */
		const MAX_ZOOM = 2.5;
		/** One step of the zoom controls, in screen pixels per drawing unit. */
		const ZOOM_STEP = 1.25;
		/**
		* The most a fit may magnify.
		*
		* Filling the width on a drawing that holds one card would otherwise ask for
		* several times the design's size: one card stretched across the whole box,
		* larger than any reading needs and carrying no more in it, because a tier is
		* drawn at a fixed size and zooming past 100% only magnifies. One control step
		* is the ceiling, so the fit may lean in but never stretch.
		*/
		const MAX_FIT_ZOOM = ZOOM_STEP;
		/** Inset from a card's corner to the band its own ports may occupy. */
		const CARD_PORT_INSET = 10;
		/** Horizontal gap between two card columns inside one frame. */
		const CARD_COLUMN_GAP = 20;
		/** Spacing between two cross-column lanes inside one inter-column gap. */
		const GAP_LANE_STEP = 6;
		/**
		* Which tier a zoom level calls for.
		*
		* Thresholds are inclusive on the low end, so 0.8 is a full card and 0.4 is a
		* compact one: a zoom that lands exactly on a step reads as the richer of the
		* two. A zoom that is not a usable number degrades to the cheapest tier instead
		* of producing an infinite or negative box.
		* @param zoom - the current scale.
		* @param options - threshold overrides.
		* @returns the tier to lay out at.
		*/
		function lodFor(zoom, options = {}) {
			const opts = {
				...DEFAULT_CARDGRAPH_OPTIONS,
				...options
			};
			if (!Number.isFinite(zoom)) return "chip";
			if (zoom >= opts.cardMinZoom) return "card";
			if (zoom >= opts.compactMinZoom) return "compact";
			return "chip";
		}
		/**
		* The three tiers in the order a zoom sweep visits them, richest first.
		*
		* Exported so a painter can pre-build its text caches per tier without hardcoding
		* the list in a second place.
		*/
		const CARDGRAPH_LODS = [
			"card",
			"compact",
			"chip"
		];
		/** Whether two rectangles overlap. Touching edges do not count as overlapping. */
		function intersects(a, b) {
			return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
		}
		/** Whether a point is inside a rectangle. The top-left edges are inside, the bottom-right ones are not. */
		function contains(rect, x, y) {
			return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
		}
		/** Grow a rectangle by `by` on every side. */
		function grow(rect, by) {
			return {
				x: rect.x - by,
				y: rect.y - by,
				width: rect.width + by * 2,
				height: rect.height + by * 2
			};
		}
		/**
		* Keep the items whose box meets the viewport.
		*
		* This is the card canvas's replacement for the swimlane's row window: with a
		* free 2D canvas there are no rows to count, so "what is on screen" is decided by
		* rectangle overlap. `bounds` is the only field it looks at, which is why cards,
		* frames and wires all expose one.
		* @param items - anything with a bounding box.
		* @param viewport - the visible rect, **in drawing coordinates**.
		* @returns the items to draw, in the order they were given.
		*/
		function cullByBounds(items, viewport) {
			return items.filter((item) => intersects(item.bounds, viewport));
		}
		/**
		* The topmost item under a point.
		*
		* Free of the DOM on purpose: the canvas has no elements to hit, so picking is a
		* function from a point and an ordered list to an item — and that function is
		* testable here rather than only by clicking in a browser. The caller passes the
		* list **topmost first**, which is what makes "a card wins over the frame holding
		* it" a property of the order rather than of the arithmetic.
		* @param items - candidates, topmost first.
		* @param x - point, in drawing coordinates.
		* @param y - point, in drawing coordinates.
		* @returns the first hit, or `undefined`.
		*/
		function hitTest(items, x, y) {
			return items.find((item) => contains(item.bounds, x, y));
		}
		/**
		* The part of the drawing a viewport can see, in drawing coordinates.
		*
		* The inverse of the transform the painter applies, and the input to culling. A
		* broken transform is treated as identity rather than propagated: a scale of zero
		* or a NaN would otherwise turn the visible rect into an infinite or reversed box
		* and either cull everything or draw everything.
		* @param view - the transform and the size of the paint box.
		* @param overscan - drawing units to keep on each side, so a pan does not reveal a
		*   blank band before the next frame is painted.
		* @returns the visible rect.
		*/
		function worldViewport(view, overscan = 0) {
			const scale = Number.isFinite(view.scale) && view.scale > 0 ? view.scale : 1;
			const width = Number.isFinite(view.width) ? Math.max(0, view.width) : 0;
			const height = Number.isFinite(view.height) ? Math.max(0, view.height) : 0;
			const offsetX = Number.isFinite(view.offsetX) ? view.offsetX : 0;
			const offsetY = Number.isFinite(view.offsetY) ? view.offsetY : 0;
			const rect = {
				x: -offsetX / scale,
				y: -offsetY / scale,
				width: width / scale,
				height: height / scale
			};
			return overscan === 0 ? rect : grow(rect, overscan);
		}
		/** Lane geometry: how far a lane keeps from the edge of its channel, and how far apart lanes are. */
		const LANE_CLEAR = 10;
		const LANE_STEP = 9;
		/** Stub each wire leaves its port with, clearance from a frame, and thread row spacing. */
		const STUB = 6;
		const CLEAR = 4;
		/** Vertical spacing between two thread runs leaving the same card. */
		const THREAD_ROW_STEP = 5;
		/** The spacing a frame's edge gives each port, enough for an arrowhead. */
		const PORT_SPACING = 14;
		/** The gap a card needs below it before its first thread run. */
		const THREAD_ROW_CLEAR = 6;
		/** Vertical room a downward arrow needs above the card it lands on. */
		const THREAD_ARROW_CLEAR = 15;
		/**
		* Build the card graph.
		*
		* Frames come from the payload's sessions: column by subtree depth, vertical
		* order by the payload's own order (the DFS pre-order the list indents by), so a
		* session keeps its relative position across the two views. Cards are stacked
		* inside their author's frame **by time**, because a frame is one session's own
		* timeline; the reader who wants one timeline across all sessions has the list
		* below. Only the reports handed in are drawn, so this is a filtered view rather
		* than a second source of truth.
		*
		* With `fitChannels`, the drawing is built **twice**: the first pass measures how
		* many lanes its wires actually need in each gutter and each crossing gap, the
		* second pass grows those gaps to fit them. A busy drawing therefore gets wide
		* gaps instead of squeezing every wire into the 24px the default gap happens to
		* leave — the layout reserves the room the wires need, rather than the wires
		* fitting whatever room the layout left behind.
		* @param payload - the endpoint payload, for the session frames.
		* @param reports - the reports to plot; any order, since each frame sorts its own.
		* @param options - geometry and tier overrides.
		* @returns the layout; empty (and zero-sized) when there is nothing to draw.
		*/
		function buildCardgraph(payload, reports, options = {}) {
			const demand = {
				gutters: /* @__PURE__ */ new Map(),
				roads: /* @__PURE__ */ new Map(),
				threadRows: 0,
				threadArrows: false,
				cardSideArrows: false,
				sameFrameLanes: 0,
				gapLanes: 0,
				framePorts: /* @__PURE__ */ new Map()
			};
			const first = buildOne(payload, reports, options.fitChannels === true ? {
				...options,
				hiddenKinds: []
			} : options, demand);
			if (options.fitChannels !== true) return first;
			const opts = {
				...DEFAULT_CARDGRAPH_OPTIONS,
				...options
			};
			const gutterLanes = Math.max(0, ...demand.gutters.values());
			const roadLanes = Math.max(0, ...demand.roads.values());
			const columnGap = Math.max(opts.columnGap, gutterLanes * LANE_STEP + 2 * LANE_CLEAR + 4);
			const frameGap = Math.max(opts.frameGap, roadLanes * LANE_STEP + 2 * CLEAR + 4);
			const cardGap = Math.max(opts.cardGap, demand.threadRows * THREAD_ROW_STEP + THREAD_ROW_CLEAR, demand.threadArrows ? 19 : 0);
			const framePaddingTop = Math.max(opts.framePaddingTop, demand.threadArrows ? 19 : 0);
			const laneBand = demand.sameFrameLanes > 0 ? 6 + demand.sameFrameLanes * 5 + 6 : 0;
			const cardColumnGap = Math.max(opts.cardColumnGap ?? CARD_COLUMN_GAP, demand.gapLanes * GAP_LANE_STEP + 12, laneBand);
			const framePaddingX = Math.max(opts.framePaddingX, demand.cardSideArrows ? 17 : 0, demand.sameFrameLanes > 0 ? LANE_CLEAR + demand.sameFrameLanes * LANE_STEP : 0);
			const frameExtra = /* @__PURE__ */ new Map();
			for (const [key, count] of demand.framePorts) {
				const frameIndex = Number(key.split(":")[0]);
				const frame = first.frames[frameIndex];
				if (frame === void 0) continue;
				const needed = opts.frameHeaderHeight + opts.framePaddingTop + (count + 1) * PORT_SPACING + opts.framePaddingBottom;
				const extra = Math.max(0, needed - frame.bounds.height);
				if (extra > 0) frameExtra.set(frameIndex, extra);
			}
			if (columnGap === opts.columnGap && frameGap === opts.frameGap && cardGap === opts.cardGap && framePaddingTop === opts.framePaddingTop && framePaddingX === opts.framePaddingX && cardColumnGap === opts.cardColumnGap && frameExtra.size === 0) return first;
			return buildOne(payload, reports, {
				...options,
				columnGap,
				frameGap,
				cardGap,
				framePaddingTop,
				framePaddingX,
				cardColumnGap
			}, {
				gutters: /* @__PURE__ */ new Map(),
				roads: /* @__PURE__ */ new Map(),
				threadRows: 0,
				threadArrows: false,
				cardSideArrows: false,
				sameFrameLanes: 0,
				gapLanes: 0,
				framePorts: /* @__PURE__ */ new Map()
			}, frameExtra);
		}
		/**
		* One build. The wrapper above calls this twice when channels need measuring.
		* @param payload - the endpoint payload, for the session frames.
		* @param reports - the reports to plot.
		* @param options - geometry and tier overrides.
		* @param demand - receives how many lanes each channel used, for the growth pass.
		* @param frameExtra - extra height per frame index, for frames whose edge must hold
		*   more ports than their cards give it room for.
		* @returns the layout as measured against the options given.
		*/
		function buildOne(payload, reports, options, demand, frameExtra = /* @__PURE__ */ new Map()) {
			const opts = {
				...DEFAULT_CARDGRAPH_OPTIONS,
				...options
			};
			const size = opts.sizes[opts.lod];
			/** Kinds the reader muted in the legend; they take no ports either. */
			const hidden = new Set(opts.hiddenKinds ?? []);
			const sessions = payload.sessions;
			const depths = [...new Set(sessions.map((node) => node.depth))].sort((a, b) => a - b);
			const columnOfDepth = /* @__PURE__ */ new Map();
			for (const [index, depth] of depths.entries()) columnOfDepth.set(depth, index);
			const frameOf = /* @__PURE__ */ new Map();
			const frames = sessions.map((node, index) => {
				frameOf.set(node.id, index);
				return {
					...node.title === void 0 ? {} : { title: node.title },
					id: node.id,
					shortId: shortId(node.id),
					depth: node.depth,
					column: columnOfDepth.get(node.depth) ?? 0,
					live: node.live,
					external: false,
					cards: 0
				};
			});
			const mentions = (front) => [
				front.from,
				...front.to,
				...front.cc,
				...front.authors
			];
			const needsExternal = reports.some((front) => mentions(front).some((id) => id !== void 0 && !frameOf.has(id)));
			const externalDepth = sessions.reduce((max, node) => Math.max(max, node.depth), -1) + 1;
			if (needsExternal) frames.push({
				shortId: "",
				depth: externalDepth,
				column: depths.length,
				live: false,
				external: true,
				cards: 0
			});
			const externalIndex = needsExternal ? frames.length - 1 : -1;
			const frameIndexById = (id) => id !== void 0 && frameOf.has(id) ? frameOf.get(id) : externalIndex;
			const buckets = frames.map(() => []);
			for (const front of reports) {
				const target = frameIndexById(front.from);
				if (target >= 0) buckets[target]?.push(front);
			}
			for (const bucket of buckets) bucket.sort((a, b) => a.created - b.created || (a.report < b.report ? -1 : a.report > b.report ? 1 : 0));
			const cardPlace = /* @__PURE__ */ new Map();
			const frameCardColumns = [];
			const frameRowCount = [];
			let maxCardColumns = 1;
			for (const bucket of buckets) {
				const columnOfReport = /* @__PURE__ */ new Map();
				const childrenSeen = /* @__PURE__ */ new Map();
				const rows = [];
				for (const front of bucket) {
					const parent = front.parent !== void 0 && front.parent !== front.report && bucket.some((candidate) => candidate.report === front.parent) ? front.parent : void 0;
					let column = 0;
					if (parent !== void 0) {
						const parentColumn = columnOfReport.get(parent) ?? 0;
						const seen = childrenSeen.get(parent) ?? 0;
						childrenSeen.set(parent, seen + 1);
						column = seen === 0 ? parentColumn : parentColumn + 1;
					}
					columnOfReport.set(front.report, column);
					const row = rows[column] ?? 0;
					rows[column] = row + 1;
					cardPlace.set(front.report, {
						column,
						row
					});
					maxCardColumns = Math.max(maxCardColumns, column + 1);
				}
				frameRowCount.push(rows.reduce((max, count) => Math.max(max, count), 0));
				frameCardColumns.push(rows.length);
			}
			const frameWidth = Math.max(opts.minFrameWidth, maxCardColumns * size.width + (maxCardColumns - 1) * (opts.cardColumnGap ?? CARD_COLUMN_GAP) + opts.framePaddingX * 2);
			const columnX = (column) => opts.margin + column * (frameWidth + opts.columnGap);
			const frameHeight = (count, extra = 0) => Math.max(opts.minFrameHeight, opts.frameHeaderHeight + opts.framePaddingTop + opts.framePaddingBottom + count * size.height + Math.max(0, count - 1) * opts.cardGap) + extra;
			frames.forEach((frame, index) => {
				frame.cards = buckets[index]?.length ?? 0;
			});
			const cursor = /* @__PURE__ */ new Map();
			/** A frame's own width: only as many card columns as it actually uses. */
			const ownWidth = (index) => Math.max(opts.minFrameWidth, (frameCardColumns[index] ?? 1) * size.width + Math.max(0, (frameCardColumns[index] ?? 1) - 1) * (opts.cardColumnGap ?? CARD_COLUMN_GAP) + opts.framePaddingX * 2);
			const fixed = frames.map((frame, index) => {
				const height = frameHeight(frameRowCount[index] ?? 0, frameExtra.get(index) ?? 0);
				const y = cursor.get(frame.column) ?? opts.margin;
				cursor.set(frame.column, y + height + opts.frameGap);
				return {
					x: columnX(frame.column),
					y,
					width: ownWidth(index),
					height
				};
			});
			const columnCount = depths.length + (needsExternal ? 1 : 0);
			const heights = Array.from({ length: columnCount }, (_unused, column) => {
				const stacked = fixed.filter((_box, index) => frames[index]?.column === column);
				return stacked.length === 0 ? 0 : stacked.reduce((sum, box) => sum + box.height, 0) + (stacked.length - 1) * opts.frameGap;
			});
			const layoutFrames = frames.map((frame, index) => ({
				...frame.id === void 0 ? {} : { id: frame.id },
				...frame.title === void 0 ? {} : { title: frame.title },
				index,
				shortId: frame.shortId,
				depth: frame.depth,
				column: frame.column,
				live: frame.live,
				external: frame.external,
				cards: frame.cards,
				bounds: fixed[index]
			}));
			const columns = Array.from({ length: columnCount }, (_unused, column) => ({
				depth: depths[column] ?? externalDepth,
				index: column,
				bounds: {
					x: columnX(column),
					y: opts.margin,
					width: frameWidth,
					height: Math.max(0, heights[column] ?? 0)
				}
			}));
			const cards = [];
			const cardIndexOf = /* @__PURE__ */ new Map();
			layoutFrames.forEach((frame) => {
				(buckets[frame.index] ?? []).forEach((front) => {
					const place = cardPlace.get(front.report) ?? {
						column: 0,
						row: 0
					};
					cardIndexOf.set(front.report, cards.length);
					cards.push({
						report: front.report,
						subject: front.subject,
						status: front.status,
						...front.task === void 0 ? {} : { task: front.task },
						frame: frame.index,
						column: frame.column,
						slot: place.row,
						lod: opts.lod,
						bounds: {
							x: frame.bounds.x + opts.framePaddingX + place.column * (size.width + (opts.cardColumnGap ?? CARD_COLUMN_GAP)),
							y: frame.bounds.y + opts.frameHeaderHeight + opts.framePaddingTop + place.row * (size.height + opts.cardGap),
							width: size.width,
							height: size.height
						}
					});
				});
			});
			const cardEnd = (index, side) => {
				const box = cards[index]?.bounds ?? {
					x: 0,
					y: 0,
					width: 0,
					height: 0
				};
				return {
					kind: "card",
					id: cards[index]?.report,
					index,
					side,
					x: side === "right" ? box.x + box.width : side === "left" ? box.x : box.x + box.width / 2,
					y: side === "bottom" ? box.y + box.height : side === "top" ? box.y : box.y + box.height / 2
				};
			};
			const frameEnd = (index, side) => {
				const box = fixed[index] ?? {
					x: 0,
					y: 0,
					width: 0,
					height: 0
				};
				return {
					kind: "frame",
					...frames[index]?.id === void 0 ? {} : { id: frames[index]?.id },
					index,
					side,
					x: side === "right" ? box.x + box.width : box.x,
					y: box.y + box.height / 2
				};
			};
			const externalBetween = (a, b) => externalIndex >= 0 && (a === externalIndex || b === externalIndex) || false;
			const pending = [];
			/**
			* The side a wire should bend through to reach another frame without crossing
			* one.
			*
			* Two sessions in the **same column** — siblings, or any two frames at one
			* depth — cannot be reached left-to-right: a straight line from the sender's
			* card to the recipient's facing edge runs back across the recipient's own box,
			* which reads as "this wire belongs to that frame". Such a wire bends down the
			* gutter beside the column instead: out of the card, along the gutter, into the
			* frame's edge on that same side. The gutter is on the right except in the last
			* column, where that would run along the outside of the drawing.
			*/
			const gutterSide = (column) => column < columns.length - 1 ? "right" : "left";
			const frontByReport = new Map(reports.map((front) => [front.report, front]));
			for (const [cardIndex, card] of cards.entries()) {
				const front = frontByReport.get(card.report);
				if (front === void 0) continue;
				const ownFrame = card.frame;
				const ownColumn = card.column;
				for (const [kind, ids] of [["to", front.to], ["cc", front.cc]]) {
					if (hidden.has(kind)) continue;
					for (const id of new Set(ids)) {
						const target = frameIndexById(id);
						if (target < 0 || target === ownFrame) continue;
						const targetColumn = frames[target]?.column ?? 0;
						const sameColumn = targetColumn === ownColumn;
						const side = sameColumn ? gutterSide(ownColumn) : targetColumn > ownColumn ? "right" : "left";
						pending.push({
							report: front.report,
							kind,
							from: cardEnd(cardIndex, side),
							to: frameEnd(target, sameColumn ? side : side === "right" ? "left" : "right"),
							external: externalBetween(ownFrame, target)
						});
					}
				}
				for (const id of hidden.has("author") ? [] : new Set(front.authors)) {
					if (id === front.from) continue;
					const source = frameIndexById(id);
					if (source < 0 || source === ownFrame) continue;
					const sourceColumn = frames[source]?.column ?? 0;
					const sameColumn = sourceColumn === ownColumn;
					const side = sameColumn ? gutterSide(ownColumn) : sourceColumn < ownColumn ? "right" : "left";
					pending.push({
						report: front.report,
						kind: "author",
						from: frameEnd(source, side),
						to: cardEnd(cardIndex, sameColumn ? side : side === "right" ? "left" : "right"),
						external: externalBetween(source, ownFrame)
					});
				}
				const parentIndex = front.parent === void 0 || front.parent === front.report ? void 0 : cardIndexOf.get(front.parent);
				const parentCard = parentIndex === void 0 ? void 0 : cards[parentIndex];
				if (parentIndex !== void 0 && parentCard !== void 0 && !hidden.has("thread")) {
					const from = cardEnd(parentIndex, "bottom");
					const to = cardEnd(cardIndex, "top");
					const column = parentCard.column;
					const target = card.column;
					target > column || target < column || gutterSide(column);
					pending.push({
						report: front.report,
						kind: "thread",
						from,
						to,
						external: externalBetween(parentCard.frame, ownFrame)
					});
				}
			}
			for (const edge of pending) for (const end of [edge.from, edge.to]) {
				if (end.kind !== "frame") continue;
				const key = `${end.index}:${end.side}`;
				demand.framePorts.set(key, (demand.framePorts.get(key) ?? 0) + 1);
			}
			const groups = /* @__PURE__ */ new Map();
			for (const edge of pending) for (const end of [edge.from, edge.to]) {
				const other = end === edge.from ? edge.to : edge.from;
				const key = `${end.kind}|${end.index}|${end.side}`;
				const list = groups.get(key) ?? [];
				list.push({
					end,
					order: end.kind === "card" && (end.side === "top" || end.side === "bottom") ? other.x : other.y,
					tie: `${edge.report}|${edge.kind}`
				});
				groups.set(key, list);
			}
			for (const list of groups.values()) {
				const first = list[0];
				if (first === void 0) continue;
				list.sort((a, b) => a.order - b.order || (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0));
				const end = first.end;
				const box = end.kind === "frame" ? fixed[end.index] ?? {
					x: 0,
					y: 0,
					width: 0,
					height: 0
				} : cards[end.index]?.bounds ?? {
					x: 0,
					y: 0,
					width: 0,
					height: 0
				};
				/** The band a port may occupy, along the side it is on. */
				const along = end.side === "left" || end.side === "right" ? "y" : "x";
				const inset = end.kind === "frame" ? 0 : CARD_PORT_INSET;
				const low = along === "y" ? box.y + (end.kind === "frame" ? opts.frameHeaderHeight + opts.framePaddingTop : inset) : box.x + inset;
				const span = (along === "y" ? box.y + box.height - (end.kind === "frame" ? opts.framePaddingBottom : inset) : box.x + box.width - inset) - low;
				list.forEach((entry, index) => {
					const at = span > 0 ? low + (index + 1) * span / (list.length + 1) : low + span / 2;
					if (along === "y") entry.end.y = at;
					else entry.end.x = at;
				});
			}
			const tallest = heights.reduce((max, height) => Math.max(max, height), 0);
			const obstacles = fixed.map((box) => grow(box, CLEAR));
			const roadCandidates = (() => {
				const roads = [{
					key: "top",
					y: opts.margin / 2,
					low: 4,
					high: Math.max(4, opts.margin - CLEAR)
				}, {
					key: "bottom",
					y: opts.margin + tallest + opts.margin / 2,
					low: opts.margin + tallest + CLEAR,
					high: opts.margin + tallest + opts.margin - 4
				}];
				for (const column of columns) {
					const boxes = fixed.filter((_, index) => frames[index]?.column === column.index).sort((a, b) => a.y - b.y);
					for (let index = 1; index < boxes.length; index++) {
						const above = boxes[index - 1];
						const below = boxes[index];
						if (above === void 0 || below === void 0) continue;
						const low = above.y + above.height + CLEAR;
						const high = below.y - CLEAR;
						if (high <= low) continue;
						roads.push({
							key: `gap:${column.index}:${index}`,
							y: (low + high) / 2,
							low,
							high
						});
					}
				}
				return roads;
			})();
			const freeRoad = (left, right, y) => {
				const lo = Math.min(left, right);
				const hi = Math.max(left, right);
				return !obstacles.some((box) => box.y < y && y < box.y + box.height && box.x < hi && lo < box.x + box.width);
			};
			const gutterAt = (column, side) => {
				const box = columns[column]?.bounds;
				if (box === void 0) return 0;
				return side === "right" ? box.x + box.width + opts.columnGap / 2 : box.x - opts.columnGap / 2;
			};
			const columnOf = (end) => end.kind === "card" ? cards[end.index]?.column ?? 0 : frames[end.index]?.column ?? 0;
			const clampTo = (value, low, high) => Math.min(high, Math.max(low, value));
			/**
			* Lane allocation, ordered by the port each wire comes from.
			*
			* Two wires in the same gutter or the same road would otherwise run *on* each
			* other (same x, same y), and allocating in card order also makes them cross at
			* the gutter when their ports arrive in a different order. The lanes are therefore
			* handed out by **port y**: the wire whose port is higher takes the higher lane, so
			* the short horizontal runs from the ports to the gutters do not cross. Full
			* channels wrap — the only place overlap can still happen, and only past ~5 wires
			* through one gutter.
			*/
			const laneCounters = /* @__PURE__ */ new Map();
			const nextLane = (key, capacity) => {
				const used = laneCounters.get(key) ?? 0;
				laneCounters.set(key, used + 1);
				return (used % capacity - (capacity - 1) / 2) * LANE_STEP;
			};
			/** One gutter's usable band, and the x a lane's offset starts from. */
			const gutterBand = (column, side) => {
				const box = columns[column]?.bounds ?? {
					x: 0,
					y: 0,
					width: 0,
					height: 0
				};
				return {
					low: side === "right" ? box.x + box.width + LANE_CLEAR : box.x - opts.columnGap + LANE_CLEAR,
					high: side === "right" ? box.x + box.width + opts.columnGap - LANE_CLEAR : box.x - LANE_CLEAR,
					base: gutterAt(column, side)
				};
			};
			/**
			* Which gutter a wire uses, and at which port y.
			*
			* Left/right ends use their own side; a top/bottom end (a thread) leaves through
			* the column's gutter, because that is where it can travel without crossing cards.
			*/
			const gutterUse = (edge) => {
				const fromColumn = columnOf(edge.from);
				const toColumn = columnOf(edge.to);
				const horizontal = (side) => side === "left" || side === "right";
				const from = {
					column: fromColumn,
					side: horizontal(edge.from.side) ? edge.from.side : gutterSide(fromColumn),
					portY: edge.from.y
				};
				const to = {
					column: toColumn,
					side: horizontal(edge.to.side) ? edge.to.side : gutterSide(toColumn),
					portY: edge.to.y
				};
				if (Math.abs(gutterAt(from.column, from.side) - gutterAt(to.column, to.side)) < .5) return { from };
				return {
					from,
					to
				};
			};
			/** A channel's identity: which physical gutter it is, by its centre line. */
			const gutterKeyOf = (column, side) => `gutter:${Math.round(gutterAt(column, side))}`;
			/** The drawing's width, needed to keep lanes inside the canvas while the plan is built. */
			const drawingWidth = columns.length === 0 ? 0 : opts.margin * 2 + columns.length * frameWidth + (columns.length - 1) * opts.columnGap;
			/** The lane x each wire takes at each end, decided before any route is built. */
			const lanePlan = /* @__PURE__ */ new Map();
			{
				const uses = /* @__PURE__ */ new Map();
				for (const edge of pending) {
					const use = gutterUse(edge);
					for (const end of ["from", "to"]) {
						const part = end === "from" ? use.from : use.to;
						if (part === void 0) continue;
						const key = gutterKeyOf(part.column, part.side);
						const list = uses.get(key) ?? [];
						list.push({
							edge,
							end,
							portY: part.portY,
							column: part.column,
							side: part.side
						});
						uses.set(key, list);
					}
				}
				for (const [key, list] of uses) {
					const first = list[0];
					if (first === void 0) continue;
					const band = gutterBand(first.column, first.side);
					const capacity = Math.max(1, Math.floor((band.high - band.low) / LANE_STEP) + 1);
					list.sort((a, b) => a.portY - b.portY || (a.edge.report < b.edge.report ? -1 : a.edge.report > b.edge.report ? 1 : 0));
					list.forEach((use, index) => {
						const offset = (index % capacity - (capacity - 1) / 2) * LANE_STEP;
						const x = clampTo(band.base + offset, Math.max(4, band.low), Math.min(drawingWidth - 4, band.high));
						const plan = lanePlan.get(use.edge) ?? {};
						if (use.end === "from") plan.fromX = x;
						else plan.toX = x;
						lanePlan.set(use.edge, plan);
					});
					demand.gutters.set(key, list.length);
				}
			}
			/**
			* Thread run rows.
			*
			* Threads leaving one card all start on its bottom edge and run to the same
			* gutter, so without distinct rows they draw on top of each other inside the
			* frame. Every channel-routed thread of a card gets a row, spaced
			* `THREAD_ROW_STEP` down (and up on the target side); the wrapper grows the
			* frame's `cardGap` to hold the rows it measured.
			*/
			const threadRow = /* @__PURE__ */ new Map();
			{
				const byParent = /* @__PURE__ */ new Map();
				for (const edge of pending) {
					if (edge.kind !== "thread") continue;
					const fromCard = edge.from.kind === "card" ? cards[edge.from.index] : void 0;
					const toCard = edge.to.kind === "card" ? cards[edge.to.index] : void 0;
					if (fromCard !== void 0 && toCard !== void 0 && fromCard.frame === toCard.frame && Math.abs(toCard.slot - fromCard.slot) === 1) continue;
					const list = byParent.get(edge.from.index) ?? [];
					list.push(edge);
					byParent.set(edge.from.index, list);
				}
				for (const list of byParent.values()) {
					list.sort((a, b) => a.to.y - b.to.y || (a.report < b.report ? -1 : 1));
					list.forEach((edge, index) => threadRow.set(edge, index));
					demand.threadRows = Math.max(demand.threadRows, list.length);
				}
			}
			/**
			* Same-frame thread lanes.
			*
			* A thread whose two ends are cards of the **same frame** never leaves that frame:
			* it drops from the parent's bottom, runs down the frame's inner padding — the strip
			* between the cards' right edge and the frame border, which no card occupies — and
			* comes back into the child's top. The strip holds one lane per such thread, and the
			* wrapper widens `framePaddingX` to fit them.
			*/
			/** Lane index of each cross-column thread inside its inter-column gap. */
			const crossGapLane = /* @__PURE__ */ new Map();
			{
				const byGap = /* @__PURE__ */ new Map();
				for (const edge of pending) {
					if (edge.kind !== "thread") continue;
					const fromCard = edge.from.kind === "card" ? cards[edge.from.index] : void 0;
					const toCard = edge.to.kind === "card" ? cards[edge.to.index] : void 0;
					if (fromCard === void 0 || toCard === void 0 || fromCard.frame !== toCard.frame) continue;
					const a = cardPlace.get(fromCard.report)?.column ?? 0;
					const b = cardPlace.get(toCard.report)?.column ?? 0;
					if (a === b) continue;
					const key = "gap:" + fromCard.frame + ":" + Math.min(a, b);
					const list = byGap.get(key) ?? [];
					list.push(edge);
					byGap.set(key, list);
				}
				for (const list of byGap.values()) {
					list.sort((a, b) => a.from.y - b.from.y || (a.report < b.report ? -1 : 1));
					list.forEach((edge, index) => crossGapLane.set(edge, index));
					demand.gapLanes = Math.max(demand.gapLanes, list.length);
				}
			}
			const sameFrameLane = /* @__PURE__ */ new Map();
			{
				const byFrame = /* @__PURE__ */ new Map();
				for (const edge of pending) {
					if (edge.kind !== "thread") continue;
					const fromCard = edge.from.kind === "card" ? cards[edge.from.index] : void 0;
					const toCard = edge.to.kind === "card" ? cards[edge.to.index] : void 0;
					if (fromCard === void 0 || toCard === void 0) continue;
					if (fromCard.frame !== toCard.frame) continue;
					if (Math.abs(toCard.slot - fromCard.slot) === 1) continue;
					if ((cardPlace.get(fromCard.report)?.column ?? 0) !== (cardPlace.get(toCard.report)?.column ?? 0)) continue;
					const list = byFrame.get(fromCard.frame) ?? [];
					list.push(edge);
					byFrame.set(fromCard.frame, list);
				}
				for (const list of byFrame.values()) {
					list.sort((a, b) => a.from.y - b.from.y || (a.report < b.report ? -1 : 1));
					list.forEach((edge, index) => sameFrameLane.set(edge, index));
					demand.sameFrameLanes = Math.max(demand.sameFrameLanes, list.length);
				}
			}
			/** Drop repeated points and merge collinear ones, so a route has no stutter. */ const tidy = (input) => {
				const out = [];
				for (const point of input) {
					const last = out[out.length - 1];
					if (last !== void 0 && last.x === point.x && last.y === point.y) continue;
					const before = out[out.length - 2];
					if (before !== void 0 && last !== void 0 && (before.x === last.x && last.x === point.x || before.y === last.y && last.y === point.y)) {
						out[out.length - 1] = point;
						continue;
					}
					out.push(point);
				}
				return out;
			};
			/**
			* Route one wire through the layout's channels.
			*
			* All four sides come through here now. Left/right wires leave their port
			* horizontally; top/bottom wires (threads) leave vertically into the gap above or
			* below their card — which is empty by construction: cards are stacked with a
			* `cardGap`, and the first/last card has the frame's padding above/below it. From
			* there every wire takes the same shape: a stub, a horizontal run to the
			* column's gutter, a vertical run to a road, a horizontal crossing to the target
			* gutter, a vertical run to the target's y, and a stub into the target.
			* @param edge - the wire, with its ports already spread.
			* @returns the orthogonal route, ports included.
			*/
			const route = (edge) => {
				if (edge.from.kind === "card" && (edge.from.side === "right" || edge.from.side === "left")) {
					const card = cards[edge.from.index];
					const place = card === void 0 ? void 0 : cardPlace.get(card.report);
					const columns = card === void 0 ? 1 : frameCardColumns[card.frame] ?? 1;
					const frameBox = card === void 0 ? void 0 : fixed[card.frame];
					const towardsRight = edge.from.side === "right";
					const hasColumns = towardsRight ? place !== void 0 && place.column + 1 < columns : place !== void 0 && place.column - 1 >= 0;
					if (card !== void 0 && place !== void 0 && frameBox !== void 0 && hasColumns) {
						const gap = opts.cardColumnGap ?? CARD_COLUMN_GAP;
						const cardX = (column) => frameBox.x + opts.framePaddingX + column * (size.width + gap);
						const gapYFor = (column, wanted) => {
							const members = cards.filter((candidate) => candidate.frame === card.frame && (cardPlace.get(candidate.report)?.column ?? 0) === column).sort((left, right) => left.bounds.y - right.bounds.y);
							const gaps = members.map((candidate) => candidate.bounds.y - opts.cardGap / 2);
							const last = members[members.length - 1];
							if (last !== void 0) gaps.push(last.bounds.y + last.bounds.height + opts.cardGap / 2);
							if (gaps.length === 0) gaps.push(frameBox.y + opts.frameHeaderHeight + 8);
							return gaps.sort((left, right) => Math.abs(left - wanted) - Math.abs(right - wanted))[0] ?? wanted;
						};
						const stubX = towardsRight ? card.bounds.x + card.bounds.width + STUB : card.bounds.x - STUB;
						const points = [edge.from, {
							x: stubX,
							y: edge.from.y
						}];
						let x = stubX;
						let y = edge.from.y;
						if (towardsRight) for (let column = place.column + 1; column < columns; column++) {
							const gapY = gapYFor(column, y);
							points.push({
								x,
								y: gapY
							});
							const after = cardX(column) + size.width + gap / 2;
							points.push({
								x: after,
								y: gapY
							});
							x = after;
							y = gapY;
						}
						else for (let column = place.column - 1; column >= 0; column--) {
							const gapY = gapYFor(column, y);
							points.push({
								x,
								y: gapY
							});
							const after = cardX(column) - gap / 2;
							points.push({
								x: after,
								y: gapY
							});
							x = after;
							y = gapY;
						}
						const virtual = {
							...edge,
							from: {
								kind: "frame",
								index: card.frame,
								side: towardsRight ? "right" : "left",
								x: towardsRight ? frameBox.x + frameBox.width : frameBox.x,
								y
							}
						};
						lanePlan.set(virtual, lanePlan.get(edge) ?? {});
						return tidy([...points, ...route(virtual)]);
					}
				}
				const { from, to } = edge;
				const horizontal = (side) => side === "left" || side === "right";
				const outward = (side) => side === "right" || side === "bottom" ? 1 : -1;
				if (!horizontal(from.side) && !horizontal(to.side) && from.kind === "card" && to.kind === "card") {
					const fromCard = cards[from.index];
					const toCard = cards[to.index];
					if (fromCard !== void 0 && toCard !== void 0 && fromCard.frame === toCard.frame && Math.abs(toCard.slot - fromCard.slot) === 1) {
						const middle = (from.y + to.y) / 2;
						return tidy([
							from,
							{
								x: from.x,
								y: middle
							},
							{
								x: to.x,
								y: middle
							},
							to
						]);
					}
				}
				const start = horizontal(from.side) ? {
					x: from.x + outward(from.side) * STUB,
					y: from.y
				} : {
					x: from.x,
					y: from.y + outward(from.side) * STUB
				};
				const end = horizontal(to.side) ? {
					x: to.x + outward(to.side) * STUB,
					y: to.y
				} : {
					x: to.x,
					y: to.y + outward(to.side) * STUB
				};
				const row = threadRow.get(edge);
				if (row !== void 0) {
					const sourceOffset = THREAD_ROW_CLEAR + row * THREAD_ROW_STEP;
					const targetOffset = THREAD_ARROW_CLEAR + row * THREAD_ROW_STEP;
					start.y = from.y + outward(from.side) * sourceOffset;
					end.y = to.y + outward(to.side) * targetOffset;
				}
				if (row !== void 0 && to.side === "top") {
					const targetCard = to.kind === "card" ? cards[to.index] : void 0;
					const frameBox = targetCard === void 0 ? void 0 : fixed[targetCard.frame];
					if (frameBox !== void 0) end.y = Math.max(end.y, frameBox.y + opts.frameHeaderHeight + 2);
				}
				if (edge.kind === "thread") demand.threadArrows = true;
				if (edge.kind === "author" && to.kind === "card") demand.cardSideArrows = true;
				if (from.kind === "card" && to.kind === "card") {
					const fromCard = cards[from.index];
					const toCard = cards[to.index];
					const source = fromCard === void 0 ? void 0 : cardPlace.get(fromCard.report);
					const target = toCard === void 0 ? void 0 : cardPlace.get(toCard.report);
					if (fromCard !== void 0 && toCard !== void 0 && fromCard.frame === toCard.frame && source !== void 0 && target !== void 0 && source.column !== target.column) {
						const lane = crossGapLane.get(edge) ?? 0;
						const inset = Math.min((opts.cardColumnGap ?? CARD_COLUMN_GAP) - 4, 6 + lane * GAP_LANE_STEP);
						const gapX = target.column > source.column ? fromCard.bounds.x + fromCard.bounds.width + inset : fromCard.bounds.x - inset;
						return tidy([
							from,
							start,
							{
								x: gapX,
								y: start.y
							},
							{
								x: gapX,
								y: end.y
							},
							end,
							to
						]);
					}
				}
				const lane = sameFrameLane.get(edge);
				if (lane !== void 0) {
					const card = cards[from.index];
					const frameBox = card === void 0 ? void 0 : fixed[card.frame];
					if (frameBox !== void 0) {
						const sourceColumn = cardPlace.get(card.report)?.column ?? 0;
						const columnsInFrame = frameCardColumns[card.frame] ?? 1;
						const laneX = sourceColumn + 1 < columnsInFrame ? card.bounds.x + card.bounds.width + 6 + Math.min(lane, 2) * 5 : frameBox.x + frameBox.width - LANE_CLEAR - lane * LANE_STEP;
						return tidy([
							from,
							start,
							{
								x: laneX,
								y: start.y
							},
							{
								x: laneX,
								y: end.y
							},
							end,
							to
						]);
					}
				}
				const fromColumn = columnOf(from);
				const toColumn = columnOf(to);
				const fromSide = horizontal(from.side) ? from.side : gutterSide(fromColumn);
				const toSide = horizontal(to.side) ? to.side : gutterSide(toColumn);
				const plan = lanePlan.get(edge);
				const fromX = plan?.fromX ?? gutterAt(fromColumn, fromSide);
				if (Math.abs(gutterAt(fromColumn, fromSide) - gutterAt(toColumn, toSide)) < .5) return tidy([
					from,
					start,
					{
						x: fromX,
						y: start.y
					},
					{
						x: fromX,
						y: end.y
					},
					end,
					to
				]);
				const toX = plan?.toX ?? gutterAt(toColumn, toSide);
				const middle = (start.y + end.y) / 2;
				const road = roadCandidates.filter((candidate) => freeRoad(fromX, toX, candidate.y)).sort((a, b) => Math.abs(a.y - middle) - Math.abs(b.y - middle) || a.y - b.y)[0];
				if (road === void 0) return tidy([
					from,
					start,
					end,
					to
				]);
				const capacity = Math.max(1, Math.floor((road.high - road.low) / LANE_STEP) + 1);
				const roadKey = `road:${road.key}`;
				demand.roads.set(roadKey, (demand.roads.get(roadKey) ?? 0) + 1);
				const roadY = clampTo(road.y + nextLane(roadKey, capacity), road.low, road.high);
				return tidy([
					from,
					start,
					{
						x: fromX,
						y: start.y
					},
					{
						x: fromX,
						y: roadY
					},
					{
						x: toX,
						y: roadY
					},
					{
						x: toX,
						y: end.y
					},
					end,
					to
				]);
			};
			for (const edge of pending) edge.points = route(edge);
			const edges = pending.map((edge) => {
				const points = edge.points;
				const xs = points === void 0 ? [edge.from.x, edge.to.x] : points.map((point) => point.x);
				const ys = points === void 0 ? [edge.from.y, edge.to.y] : points.map((point) => point.y);
				const minX = Math.min(...xs);
				const minY = Math.min(...ys);
				return {
					report: edge.report,
					kind: edge.kind,
					from: { ...edge.from },
					to: { ...edge.to },
					external: edge.external,
					...points === void 0 ? {} : { points },
					bounds: {
						x: minX,
						y: minY,
						width: Math.max(...xs) - minX,
						height: Math.max(...ys) - minY
					}
				};
			});
			const contentWidth = columnCount === 0 ? 0 : opts.margin * 2 + columnCount * frameWidth + (columnCount - 1) * opts.columnGap;
			const widest = heights.reduce((max, height) => Math.max(max, height), 0);
			return {
				lod: opts.lod,
				columns,
				frames: layoutFrames,
				cards,
				edges,
				frameWidth,
				frameHeaderHeight: opts.frameHeaderHeight,
				cardWidth: size.width,
				cardHeight: size.height,
				width: columnCount === 0 ? 0 : contentWidth,
				height: columnCount === 0 ? 0 : opts.margin * 2 + widest
			};
		}
		/** How far a fitted drawing is kept from the box's left edge, in screen pixels. */
		const FIT_LEFT_MIN = 8;
		/** Where a fitted drawing starts, in screen pixels from the box's top. */
		const FIT_TOP = 12;
		/**
		* The transform that fills a box's width with the drawing, at the richest tier
		* that can afford it.
		*
		* Width is the target because time runs **down** here: a frame is a column, so
		* the horizontal axis is what has to fit on screen and the vertical axis is what
		* the reader pans along. Magnification stops at {@link MAX_FIT_ZOOM}, so a
		* drawing too narrow to fill the box is left at its own size instead of
		* stretched.
		*
		* The scale and the tier are mutually dependent — the tier is derived from the
		* zoom ({@link lodFor}) and the zoom is computed from a layout — so one pass over
		* the current layout can leave the view drawing one tier while its offset was
		* centred for another. Probing every tier makes the result a function of the box
		* alone: idempotent, and independent of whichever tier the reader arrived in.
		*
		* This lives beside the geometry rather than in the view because it *is*
		* geometry: pure, byte-deterministic for one input, and the only part of the
		* fitting that can be tested without a browser.
		* @param payload - the endpoint payload, for the session frames.
		* @param reports - the reports to plot.
		* @param boxWidth - the paint box's width in screen pixels.
		* @param options - geometry, tier and threshold overrides.
		* @returns the transform, or `undefined` when there is nothing to fit into or
		*   nothing to fit (an empty drawing, or a box with no width yet).
		*/
		function fitTransform(payload, reports, boxWidth, options = {}) {
			const opts = {
				...DEFAULT_CARDGRAPH_OPTIONS,
				...options
			};
			if (!Number.isFinite(boxWidth) || boxWidth <= 0) return void 0;
			const available = Math.max(0, boxWidth - opts.margin);
			if (options.lod !== void 0) {
				const drawing = buildCardgraph(payload, reports, options);
				if (drawing.width <= 0) return void 0;
				const scale = Math.min(Math.max(available / drawing.width, MIN_ZOOM), MAX_FIT_ZOOM);
				return {
					lod: options.lod,
					scale,
					offsetX: Math.max(FIT_LEFT_MIN, (boxWidth - drawing.width * scale) / 2),
					offsetY: FIT_TOP
				};
			}
			const bands = {
				card: {
					min: opts.cardMinZoom,
					max: MAX_FIT_ZOOM
				},
				compact: {
					min: opts.compactMinZoom,
					max: opts.cardMinZoom
				},
				chip: {
					min: MIN_ZOOM,
					max: opts.compactMinZoom
				}
			};
			const probes = CARDGRAPH_LODS.map((tier) => ({
				tier,
				drawing: buildCardgraph(payload, reports, {
					...options,
					lod: tier
				})
			})).filter((probe) => probe.drawing.width > 0);
			if (probes.length === 0) return void 0;
			const chosen = probes.find((probe) => available / probe.drawing.width >= bands[probe.tier].min) ?? probes[probes.length - 1];
			const band = bands[chosen.tier];
			let scale = Math.min(Math.max(available / chosen.drawing.width, band.min), band.max);
			if (lodFor(scale, opts) !== chosen.tier) scale *= .999999999;
			return {
				lod: chosen.tier,
				scale,
				offsetX: Math.max(FIT_LEFT_MIN, (boxWidth - chosen.drawing.width * scale) / 2),
				offsetY: FIT_TOP
			};
		}
		/**
		* Limit the drawing's input to one session's subtree.
		*
		* Drilling in is a **change of scope**, not a zoom: the layout is rebuilt from the
		* subtree alone, so the frames outside it stop existing rather than being panned
		* out of sight, and their wires land on the shared outside frame instead of
		* crossing the drawing. That is the same move a subgraph editor makes when it
		* swaps the visible graph — the frames outside are not a frozen copy of what was
		* on screen.
		*
		* The subtree is found two ways on purpose: as a contiguous DFS pre-order slice
		* (the payload's own order, which is the order the list indents by) and by
		* walking `parentId` down from the root. The two agreeing is an invariant of the
		* payload; when they disagree the ancestry wins, because membership by ancestry
		* cannot be wrong the way a slice can, and a payload built another way still
		* drills correctly.
		*
		* Depth is carried over **unnormalized**: a column is a distinct depth value, so
		* a subtree whose shallowest session sits at depth 2 still lays out from column
		* zero, and `buildCardgraph` needs no second code path for scoped input.
		* @param payload - the endpoint payload.
		* @param reports - the reports the caller would plot unscoped.
		* @param root - the session id to scope to; absent, empty or unknown means the
		*   whole tree (a stale breadcrumb must degrade to "everything", never to an
		*   empty drawing).
		* @returns the scoped input, plus the trail a breadcrumb reads.
		*/
		function scopeInput(payload, reports, root) {
			if (root === void 0 || root === "" || root === payload.root) return {
				payload,
				reports,
				trail: []
			};
			const sessions = payload.sessions;
			const index = sessions.findIndex((session) => session.id === root);
			if (index < 0) return {
				payload,
				reports,
				trail: []
			};
			const depth = sessions[index]?.depth ?? 0;
			let end = sessions.length;
			for (let cursor = index + 1; cursor < sessions.length; cursor++) if ((sessions[cursor]?.depth ?? 0) <= depth) {
				end = cursor;
				break;
			}
			const slice = sessions.slice(index, end);
			const children = /* @__PURE__ */ new Map();
			const parentOf = /* @__PURE__ */ new Map();
			for (const session of sessions) {
				parentOf.set(session.id, session.parentId);
				if (session.parentId === void 0) continue;
				const bucket = children.get(session.parentId) ?? [];
				bucket.push(session.id);
				children.set(session.parentId, bucket);
			}
			const inScope = /* @__PURE__ */ new Set([root]);
			const frontier = [root];
			while (frontier.length > 0) {
				const id = frontier.pop();
				if (id === void 0) break;
				for (const child of children.get(id) ?? []) {
					if (inScope.has(child)) continue;
					inScope.add(child);
					frontier.push(child);
				}
			}
			const sliced = new Set(slice.map((session) => session.id));
			const kept = sliced.size === inScope.size && [...inScope].every((id) => sliced.has(id)) ? slice : sessions.filter((session) => inScope.has(session.id));
			const up = [];
			let cursor = root;
			while (cursor !== void 0 && cursor !== payload.root) {
				up.push(cursor);
				cursor = parentOf.get(cursor);
			}
			const trail = up.reverse();
			const touches = (id) => id !== void 0 && inScope.has(id);
			const admitted = reports.filter((front) => touches(front.from) || front.to.some(touches) || front.cc.some(touches) || front.authors.some(touches));
			return {
				payload: {
					...payload,
					sessions: kept
				},
				reports: admitted,
				trail
			};
		}
		//#endregion
		//#region src/client/cardgraph-painter.ts
		/** A guaranteed-visible theme, for a context with no tokens at all. */
		const FALLBACK_THEME = {
			canvas: "#ffffff",
			frame: "#f6f7f9",
			frameBar: "#eef0f3",
			surface: "#ffffff",
			border: "#d8dbe0",
			frameBorder: "#c3c7ce",
			text: "#1a1c1f",
			secondary: "#4a4f57",
			caption: "#70757d",
			tertiary: "#9aa0a8",
			accent: "#2f6fed",
			hover: "#7aaaff",
			warning: "#c77700",
			success: "#1f9254",
			error: "#d33a2c",
			business: "#2f6fed",
			fonts: {
				title: {
					size: 13,
					weight: 500,
					lineHeight: 18,
					family: "system-ui, sans-serif"
				},
				id: {
					size: 12,
					weight: 600,
					lineHeight: 16,
					family: "system-ui, sans-serif"
				},
				body: {
					size: 11,
					weight: 400,
					lineHeight: 15,
					family: "system-ui, sans-serif"
				},
				meta: {
					size: 11,
					weight: 500,
					lineHeight: 15,
					family: "system-ui, sans-serif"
				}
			}
		};
		/** Token name → the field it fills. Keeping it as data means one reader, not twenty. */
		const TOKENS = [
			[
				"canvas",
				"--dsw-alias-bg-base",
				FALLBACK_THEME.canvas
			],
			[
				"frame",
				"--dsw-alias-bg-layer-1",
				FALLBACK_THEME.frame
			],
			[
				"frameBar",
				"--dsw-alias-bg-layer-2",
				FALLBACK_THEME.frameBar
			],
			[
				"surface",
				"--dsw-alias-bg-layer-3",
				FALLBACK_THEME.surface
			],
			[
				"border",
				"--dsw-alias-border-l1",
				FALLBACK_THEME.border
			],
			[
				"frameBorder",
				"--dsw-alias-border-l2",
				FALLBACK_THEME.frameBorder
			],
			[
				"text",
				"--dsw-alias-label-primary",
				FALLBACK_THEME.text
			],
			[
				"secondary",
				"--dsw-alias-label-secondary",
				FALLBACK_THEME.secondary
			],
			[
				"caption",
				"--dsw-alias-label-caption",
				FALLBACK_THEME.caption
			],
			[
				"tertiary",
				"--dsw-alias-label-tertiary",
				FALLBACK_THEME.tertiary
			],
			[
				"accent",
				"--dsw-alias-brand-primary",
				FALLBACK_THEME.accent
			],
			[
				"hover",
				"--dsw-alias-button-info-hover",
				FALLBACK_THEME.hover
			],
			[
				"warning",
				"--dsw-alias-state-warn-primary",
				FALLBACK_THEME.warning
			],
			[
				"success",
				"--dsw-alias-state-success-primary",
				FALLBACK_THEME.success
			],
			[
				"error",
				"--dsw-alias-state-error-primary",
				FALLBACK_THEME.error
			],
			[
				"business",
				"--dsw-alias-state-business-primary",
				FALLBACK_THEME.business
			]
		];
		/** Font token → the field it fills. Each token carries its own size, weight and family. */
		const FONT_TOKENS = [
			[
				"title",
				"--dsw-font-xs-13",
				FALLBACK_THEME.fonts.title
			],
			[
				"id",
				"--dsw-font-xxs-strong-12",
				FALLBACK_THEME.fonts.id
			],
			[
				"body",
				"--dsw-font-xxxs-11",
				FALLBACK_THEME.fonts.body
			],
			[
				"meta",
				"--dsw-font-xxxs-strong-11",
				FALLBACK_THEME.fonts.meta
			]
		];
		/** The one token a theme change always moves, so a repaint can detect it cheaply. */
		const CANARY = "--dsw-alias-bg-base";
		/** Assemble a canvas font string. */
		function fontString(font) {
			return `${font.weight} ${font.size}px ${font.family}`;
		}
		/** Read one font token, taking its size/weight/line-height/family parts. */
		function readFont(read, token, fallback) {
			const size = Number.parseFloat(read(`${token}-font-size`));
			const weight = Number.parseFloat(read(`${token}-font-weight`));
			const lineHeight = Number.parseFloat(read(`${token}-line-height`));
			const family = read(`${token}-font-family`);
			return {
				size: Number.isFinite(size) && size > 0 ? size : fallback.size,
				weight: Number.isFinite(weight) && weight > 0 ? weight : fallback.weight,
				lineHeight: Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : fallback.lineHeight,
				family: family === "" ? fallback.family : family
			};
		}
		/**
		* Read the drawing's colours and fonts out of the live theme.
		* @param read - a token reader, normally `getComputedStyle(root).getPropertyValue`.
		* @returns the theme; every field falls back so a missing token cannot blank the drawing.
		*/
		function readTheme(read) {
			const pick = (token, fallback) => {
				const value = read(token).trim();
				return value === "" ? fallback : value;
			};
			const colours = {};
			for (const [field, token, fallback] of TOKENS) colours[field] = pick(token, fallback);
			const fonts = {};
			for (const [field, token, fallback] of FONT_TOKENS) fonts[field] = readFont(read, token, fallback);
			return {
				...FALLBACK_THEME,
				...colours,
				fonts: {
					...FALLBACK_THEME.fonts,
					...fonts
				}
			};
		}
		/** Whether the reader was handed a list of candidates rather than one element. */
		const isElementList = (value) => Array.isArray(value);
		/**
		* Watch the theme through one token.
		*
		* `getComputedStyle(...).getPropertyValue` forces a style read, so doing twenty of
		* them per repaint would be paying for the theme on every hover. The canary is the
		* page background: if it did not move, nothing else did, and the cached theme is
		* returned.
		*
		* **The palette lives on `body`, so the candidates are a chain.** DSH declares
		* every `--dsw-alias-*` colour and every `--dsw-font-<tier>-*` part on `body` —
		* `:root` carries only the family and the radii — and custom properties inherit
		* downwards, so a reader pointed at `document.documentElement` reads the empty
		* string for all of them and the whole drawing collapses onto the fallback theme
		* (a white canvas in a dark shell). Handing over both elements, `body` first,
		* keeps the drawing on the palette the shell actually painted it with, and still
		* works if a host ever moves the tokens up to `:root`. The first candidate whose
		* canary is non-empty is the source; the probe runs per read, not once, because a
		* host may mount `body` after this reader exists.
		* @param root - one element, or the candidates in order of preference.
		* @param win - the window to read styles from.
		* @returns the reader.
		*/
		function createThemeReader(root, win) {
			const roots = isElementList(root) ? root : [root];
			const sources = /* @__PURE__ */ new Map();
			const readerOf = (element) => {
				const known = sources.get(element);
				if (known !== void 0) return known;
				const style = win.getComputedStyle(element);
				const read = (name) => style.getPropertyValue(name);
				sources.set(element, read);
				return read;
			};
			let canary;
			let cached;
			return { read() {
				let current = "";
				let source;
				for (const element of roots) {
					const read = readerOf(element);
					const value = read(CANARY);
					if (value === "") continue;
					current = value;
					source = read;
					break;
				}
				if (cached !== void 0 && current === canary) return cached;
				canary = current;
				cached = readTheme(source ?? (() => ""));
				return cached;
			} };
		}
		/**
		* Shorten text until it fits, ending it with an ellipsis.
		* @param text - the text to fit.
		* @param maxWidth - the room available.
		* @param measure - width of a candidate string.
		* @returns text that fits, or `'…'` when not even one character does.
		*/
		function elide(text, maxWidth, measure) {
			if (measure(text) <= maxWidth) return text;
			for (let take = text.length - 1; take > 0; take--) {
				const candidate = `${text.slice(0, take).trimEnd()}…`;
				if (measure(candidate) <= maxWidth) return candidate;
			}
			return "…";
		}
		/**
		* Wrap text to a width, eliding whatever does not fit in the last line.
		*
		* Character-by-character, with one concession to Latin text: when a line has to
		* break and there is a space far enough back, break at the space instead of mid
		* word. Chinese has no spaces, so a word-based rule would leave a long subject on
		* one line and elide most of it; this rule wraps it, and still avoids breaking
		* "report-ledger" in half when it can.
		* @param text - the text to lay out.
		* @param maxWidth - the room available.
		* @param measure - width of a candidate string.
		* @param maxLines - how many lines to produce.
		* @returns the lines, possibly empty.
		*/
		function foldText(text, maxWidth, measure, maxLines = 1) {
			const clean = text.replace(/\s+/g, " ").trim();
			if (clean === "" || maxWidth <= 0 || maxLines < 1) return [];
			const lines = [];
			let rest = clean;
			while (rest !== "" && lines.length < maxLines) {
				if (lines.length === maxLines - 1) {
					lines.push(elide(rest, maxWidth, measure));
					break;
				}
				if (measure(rest) <= maxWidth) {
					lines.push(rest);
					break;
				}
				let cut = 0;
				for (let take = 1; take <= rest.length; take++) {
					if (measure(rest.slice(0, take)) > maxWidth) break;
					cut = take;
				}
				if (cut === 0) {
					lines.push(elide(rest, maxWidth, measure));
					break;
				}
				const space = rest.lastIndexOf(" ", cut);
				if (space > cut / 3) cut = space;
				lines.push(rest.slice(0, cut).trimEnd());
				rest = rest.slice(cut).trimStart();
			}
			return lines;
		}
		/** Corner radius of a card. */
		const CARD_RADIUS = 5;
		/** Corner radius of a frame. */
		const FRAME_RADIUS = 7;
		/** Inset from a card's edge to its text. */
		const CARD_PADDING = 9;
		/** Width of the status stripe down a card's left edge. */
		const STRIPE = 3;
		/** Arrowhead length and half-width. */
		const ARROW_LENGTH = 9;
		const ARROW_HALF = 4.5;
		/** Distance the arrow tip stops short of the target edge, so it never sits on the border. */
		const ARROW_GAP = 4;
		/** Radius of the fillet drawn at a wire's bends. */
		const CORNER_RADIUS = 4;
		/**
		* How far the scrim pushes everything but the focused path back.
		*
		* **Measured, then corrected.** The first version reused the swimlane's dim value
		* (0.18 left showing) and a screenshot of the real tab showed why that was wrong
		* there and wrong here: at 0.18 the frames, their titles and every other card
		* become unreadable, so tracing one path costs the reader the context the drawing
		* exists to provide. The swimlane had already learned the same thing from the other
		* side — *the relations recede, the participants stay* — and a canvas scrim is
		* blunter than a per-shape dim, so it has to be gentler: 0.45 showing keeps every
		* frame and card legible while the focused path, drawn back on top at full
		* strength, still reads as the thing being pointed at.
		*/
		const SCRIM_ALPHA = .55;
		/** Subject lines a full card has room for. */
		const SUBJECT_LINES = 2;
		/** The colour a status is drawn in, matching the tab's tones. */
		function statusColour(status, theme) {
			if (status === "open") return theme.warning;
			if (status === "acked") return theme.success;
			return theme.tertiary;
		}
		/**
		* How each kind of wire is drawn: the token its colour comes from, its dash
		* pattern, and its weight.
		*
		* Exported because the wires are canvas and the legend is DOM — the only way the
		* two cannot drift is for the legend to read this table instead of restating it
		* in CSS. The four kinds keep **different hues and different dashes**: a delivery
		* is the business blue, a copy the quiet caption grey dashed, a co-author the
		* success green dotted, and a thread the primary ink — the spine of the drawing,
		* read as structure rather than as an action. Hue is the second cue, never the
		* only one: the dash pattern alone still separates all four in grayscale.
		*
		* The colour is a **token name**, not a value, so it resolves through the
		* theme like everything else.
		*/
		const WIRE_TOKENS = {
			to: {
				colour: "--dsw-alias-state-business-primary",
				dash: [],
				width: 1.8
			},
			cc: {
				colour: "--dsw-alias-label-caption",
				dash: [4, 2],
				width: 1.3
			},
			author: {
				colour: "--dsw-alias-state-success-primary",
				dash: [2, 2],
				width: 1.3
			},
			thread: {
				colour: "--dsw-alias-label-primary",
				dash: [],
				width: 1.5
			}
		};
		/** Reverse lookup: which theme field a token fills. */
		const FIELD_OF_TOKEN = new Map(TOKENS.map(([field, token]) => [token, field]));
		/** How one kind of wire is drawn, resolved against a theme. */
		function wireStyle(kind, theme) {
			const spec = WIRE_TOKENS[kind];
			const field = FIELD_OF_TOKEN.get(spec.colour);
			return {
				stroke: field === void 0 ? theme.secondary : theme[field],
				dash: spec.dash,
				width: spec.width
			};
		}
		/**
		* The polyline a wire is drawn as.
		*
		* A wire with a gutter bends through it in three segments — out, along, in — which
		* is what keeps a same-column wire from crossing the frame it lands on and a
		* thread from crossing the cards between its ends.
		* @param edge - the wire.
		* @returns between two and four points, first to last.
		*/
		function wirePoints(edge) {
			if (edge.points !== void 0) return edge.points;
			return [{
				x: edge.from.x,
				y: edge.from.y
			}, {
				x: edge.to.x,
				y: edge.to.y
			}];
		}
		/** Shortest wire that earns a midpoint marker, in drawing units. */
		const MARKER_MIN_LENGTH = 36;
		/** Radii of the marker: the canvas-coloured halo, then the coloured dot. */
		const MARKER_HALO = 3.4;
		const MARKER_DOT = 2.1;
		/** How many travelling dots ride one hovered wire at once. */
		const HOVER_DOT_SPACING = 90;
		/** The traveller's speed along the wire, in drawing units per millisecond. */
		const HOVER_FLOW_SPEED = .0675;
		/** Length of a polyline. */
		function wireLength(points) {
			let total = 0;
			for (let index = 1; index < points.length; index++) {
				const a = points[index - 1];
				const b = points[index];
				if (a === void 0 || b === void 0) continue;
				total += Math.hypot(b.x - a.x, b.y - a.y);
			}
			return total;
		}
		/**
		* The part of a polyline up to `distance` from its start.
		*
		* Used for the hover reveal: the wire draws outward from the hovered card, so the
		* direction reads before the line has arrived. The returned list ends on the cut,
		* which is where the traveller dot sits.
		* @param points - the wire's points.
		* @param distance - how far along the polyline to draw.
		* @returns the partial points (never empty), and the cut point.
		*/
		function cutPolyline(points, distance) {
			const out = [];
			let remaining = Math.max(0, distance);
			for (let index = 0; index < points.length; index++) {
				const point = points[index];
				if (point === void 0) continue;
				out.push({
					x: point.x,
					y: point.y
				});
				if (index === 0) continue;
				const previous = points[index - 1];
				if (previous === void 0) continue;
				const length = Math.hypot(point.x - previous.x, point.y - previous.y);
				if (remaining <= length) {
					if (length === 0) continue;
					const t = remaining / length;
					const cut = {
						x: previous.x + (point.x - previous.x) * t,
						y: previous.y + (point.y - previous.y) * t
					};
					out[out.length - 1] = cut;
					return {
						points: out,
						cut
					};
				}
				remaining -= length;
			}
			const last = out[out.length - 1];
			return {
				points: out,
				cut: last === void 0 ? void 0 : {
					x: last.x,
					y: last.y
				}
			};
		}
		/**
		* The point half way along a wire, measured along the polyline.
		*
		* A wire that runs down a gutter is measured along its bends too, so the marker
		* lands on the long vertical segment rather than in the corner. Short wires get
		* none: at two or three card widths a dot would out-weigh the line it marks.
		* @param points - the wire's points.
		* @returns the midpoint, or `undefined` when the wire is too short to need one.
		*/
		function wireMidpoint(points) {
			const total = wireLength(points);
			if (total < MARKER_MIN_LENGTH) return void 0;
			let remaining = total / 2;
			for (let index = 1; index < points.length; index++) {
				const a = points[index - 1];
				const b = points[index];
				if (a === void 0 || b === void 0) continue;
				const length = Math.hypot(b.x - a.x, b.y - a.y);
				if (length === 0) continue;
				if (remaining <= length) {
					const t = remaining / length;
					return {
						x: a.x + (b.x - a.x) * t,
						y: a.y + (b.y - a.y) * t
					};
				}
				remaining -= length;
			}
		}
		/** Trace a rounded rectangle into the current path. */
		function pathRoundRect(ctx, rect, radius) {
			const r = Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2));
			ctx.beginPath();
			ctx.moveTo(rect.x + r, rect.y);
			ctx.lineTo(rect.x + rect.width - r, rect.y);
			ctx.arcTo(rect.x + rect.width, rect.y, rect.x + rect.width, rect.y + r, r);
			ctx.lineTo(rect.x + rect.width, rect.y + rect.height - r);
			ctx.arcTo(rect.x + rect.width, rect.y + rect.height, rect.x + rect.width - r, rect.y + rect.height, r);
			ctx.lineTo(rect.x + r, rect.y + rect.height);
			ctx.arcTo(rect.x, rect.y + rect.height, rect.x, rect.y + rect.height - r, r);
			ctx.lineTo(rect.x, rect.y + r);
			ctx.arcTo(rect.x, rect.y, rect.x + r, rect.y, r);
			ctx.closePath();
		}
		/**
		* Build a painter that draws into a canvas.
		*
		* One transform carries pan and zoom; everything after that is drawn in the
		* layout's own coordinates. Coordinates are deliberately **not** snapped to
		* pixels: draw.io rounds after its transform because its canvas is 1:1 screen
		* space, while ours is scaled, so snapping would have to happen per point in
		* screen space. Antialiasing is the honest default until a measurement says the
		* blur costs readability.
		* @param canvas - the canvas to draw into.
		* @returns the painter.
		*/
		function createCanvasPainter(canvas) {
			const ctx = canvas.getContext("2d");
			if (ctx === null) throw new Error("card canvas: no 2d context");
			let width = 0;
			let height = 0;
			let dpr = 1;
			/** Measured text widths, keyed by font and text: measuring is a layout call. */
			const widths = /* @__PURE__ */ new Map();
			const measure = (text) => {
				const key = `${ctx.font}\u0000${text}`;
				const hit = widths.get(key);
				if (hit !== void 0) return hit;
				const value = ctx.measureText(text).width;
				widths.set(key, value);
				return value;
			};
			const line = (x1, y1, x2, y2, colour, dash, alpha) => {
				ctx.globalAlpha = alpha;
				ctx.strokeStyle = colour;
				ctx.setLineDash(dash);
				ctx.beginPath();
				ctx.moveTo(x1, y1);
				ctx.lineTo(x2, y2);
				ctx.stroke();
			};
			/** The frame's outline alone, for the interaction layer: the box is already drawn. */
			const drawFrameOutline = (frame, scene) => {
				ctx.globalAlpha = 1;
				pathRoundRect(ctx, frame.bounds, FRAME_RADIUS);
				ctx.strokeStyle = scene.theme.hover;
				ctx.lineWidth = 1.6;
				ctx.stroke();
			};
			const drawFrame = (frame, scene) => {
				const { theme } = scene;
				ctx.globalAlpha = 1;
				pathRoundRect(ctx, frame.bounds, FRAME_RADIUS);
				ctx.fillStyle = theme.frame;
				ctx.fill();
				ctx.strokeStyle = theme.frameBorder;
				ctx.lineWidth = 1;
				ctx.stroke();
				const bar = {
					x: frame.bounds.x,
					y: frame.bounds.y,
					width: frame.bounds.width,
					height: scene.layout.frameHeaderHeight
				};
				ctx.save();
				pathRoundRect(ctx, frame.bounds, FRAME_RADIUS);
				ctx.clip();
				ctx.globalAlpha = 1;
				ctx.fillStyle = theme.frameBar;
				ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
				ctx.restore();
				line(bar.x, bar.y + bar.height, bar.x + bar.width, bar.y + bar.height, theme.frameBorder, [], 1);
				ctx.font = fontString(theme.fonts.title);
				ctx.textAlign = "left";
				ctx.textBaseline = "middle";
				ctx.fillStyle = theme.secondary;
				const label = frame.external ? scene.labels.external : frame.title ?? frame.shortId;
				ctx.fillText(elide(label, frame.bounds.width - 24 - 10, measure), bar.x + 10, bar.y + bar.height / 2 + .5);
				const cx = bar.x + bar.width - 13;
				const cy = bar.y + bar.height / 2;
				ctx.beginPath();
				ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
				if (frame.live) {
					ctx.fillStyle = theme.success;
					ctx.fill();
				} else {
					ctx.strokeStyle = theme.tertiary;
					ctx.lineWidth = 1;
					ctx.stroke();
				}
				if (frame.cards === 0) {
					ctx.font = fontString(theme.fonts.body);
					ctx.fillStyle = theme.tertiary;
					ctx.fillText(scene.labels.empty, frame.bounds.x + CARD_PADDING, bar.y + bar.height + 18);
				}
			};
			/**
			* The travelling dot on a hovered wire.
			*
			* Just the dot, in the pointer colour: a tail would draw a second bent line on
			* top of the wire — the same route, twice, and the eye reads the tail as "a short
			* line moving" rather than "a signal travelling". One dot reads as a signal.
			* `flow` is where it sits along the wire — 0 at the source, 1 at the target — so
			* one loop reads as "this report flows to its recipients", and the next loop
			* starts from the card again.
			* @param edge - the focused wire.
			* @param scene - the resolved palette.
			* @param flow - 0..1 along the wire.
			*/
			const drawTraveller = (edge, scene, flow) => {
				const { theme } = scene;
				const points = wirePoints(edge);
				const total = wireLength(points);
				if (total < 12) return;
				const count = Math.min(8, Math.max(1, Math.round(total / HOVER_DOT_SPACING)));
				const spacing = total / count;
				const travelled = Math.max(0, flow) * HOVER_FLOW_SPEED;
				for (let index = 0; index < count; index++) {
					const at = cutPolyline(points, (travelled + index * spacing) % total).cut;
					if (at === void 0) continue;
					ctx.globalAlpha = 1;
					ctx.setLineDash([]);
					ctx.fillStyle = theme.canvas;
					ctx.beginPath();
					ctx.arc(at.x, at.y, 4, 0, Math.PI * 2);
					ctx.fill();
					ctx.fillStyle = theme.hover;
					ctx.beginPath();
					ctx.arc(at.x, at.y, 2.5, 0, Math.PI * 2);
					ctx.fill();
				}
			};
			/**
			* Draw one wire.
			* @param edge - the wire.
			* @param scene - theme and layout.
			* @param alpha - overall opacity.
			* @param colour - overrides the wire's own colour (the interaction layer draws
			*   the focused path in the pointer colour while keeping each kind's dash and
			*   weight, so the four kinds stay readable without four hues under a scrim).
			*/
			const drawWire = (edge, scene, alpha, colour, phase = 1) => {
				const { theme } = scene;
				const style = wireStyle(edge.kind, theme);
				const stroke = colour ?? style.stroke;
				const points = wirePoints(edge);
				const last = points[points.length - 2];
				const end = points[points.length - 1];
				const angle = last === void 0 || end === void 0 ? 0 : Math.atan2(end.y - last.y, end.x - last.x);
				const tip = end === void 0 ? void 0 : {
					x: end.x - Math.cos(angle) * ARROW_GAP,
					y: end.y - Math.sin(angle) * ARROW_GAP
				};
				const stroked = tip === void 0 || points.length === 0 ? points : [...points.slice(0, -1), tip];
				const reveal = Math.min(1, Math.max(0, phase));
				const shown = reveal >= 1 ? {
					points: stroked,
					cut: void 0
				} : cutPolyline(stroked, wireLength(stroked) * reveal);
				ctx.globalAlpha = alpha;
				ctx.strokeStyle = stroke;
				ctx.lineWidth = style.width;
				ctx.setLineDash(style.dash);
				ctx.beginPath();
				const corner = CORNER_RADIUS;
				shown.points.forEach((point, index) => {
					if (index === 0) {
						ctx.moveTo(point.x, point.y);
						return;
					}
					const previous = shown.points[index - 1];
					const next = shown.points[index + 1];
					if (previous === void 0 || next === void 0) {
						ctx.lineTo(point.x, point.y);
						return;
					}
					const inLength = Math.hypot(point.x - previous.x, point.y - previous.y);
					const outLength = Math.hypot(next.x - point.x, next.y - point.y);
					const radius = Math.min(corner, inLength / 2, outLength / 2);
					if (radius < .5) {
						ctx.lineTo(point.x, point.y);
						return;
					}
					const before = {
						x: point.x - (point.x - previous.x) / (inLength === 0 ? 1 : inLength) * radius,
						y: point.y - (point.y - previous.y) / (inLength === 0 ? 1 : inLength) * radius
					};
					ctx.lineTo(before.x, before.y);
					ctx.arcTo(point.x, point.y, next.x, next.y, radius);
				});
				ctx.stroke();
				if (reveal < 1) {
					const at = shown.cut;
					if (at !== void 0) {
						ctx.setLineDash([]);
						ctx.fillStyle = theme.canvas;
						ctx.beginPath();
						ctx.arc(at.x, at.y, MARKER_HALO, 0, Math.PI * 2);
						ctx.fill();
						ctx.fillStyle = stroke;
						ctx.beginPath();
						ctx.arc(at.x, at.y, MARKER_DOT, 0, Math.PI * 2);
						ctx.fill();
					}
					return;
				}
				if (tip === void 0) return;
				const back = {
					x: tip.x - Math.cos(angle) * ARROW_LENGTH,
					y: tip.y - Math.sin(angle) * ARROW_LENGTH
				};
				const side = {
					x: -Math.sin(angle) * ARROW_HALF,
					y: Math.cos(angle) * ARROW_HALF
				};
				ctx.setLineDash([]);
				ctx.fillStyle = stroke;
				ctx.beginPath();
				ctx.moveTo(tip.x, tip.y);
				ctx.lineTo(back.x + side.x, back.y + side.y);
				ctx.lineTo(back.x - side.x, back.y - side.y);
				ctx.closePath();
				ctx.fill();
				const midpoint = wireMidpoint(points);
				if (midpoint !== void 0) {
					ctx.globalAlpha = alpha;
					ctx.fillStyle = theme.canvas;
					ctx.beginPath();
					ctx.arc(midpoint.x, midpoint.y, MARKER_HALO, 0, Math.PI * 2);
					ctx.fill();
					ctx.fillStyle = stroke;
					ctx.beginPath();
					ctx.arc(midpoint.x, midpoint.y, MARKER_DOT, 0, Math.PI * 2);
					ctx.fill();
				}
			};
			/**
			* Draw the card's status mark and report how much width it took.
			*
			* A **shape per state** — filled dot = open, check = acknowledged, block =
			* closed — so "what state is this" does not depend on telling amber from green
			* from grey. The mark carries the state colour as well, but as a second cue.
			* @param theme - the resolved palette.
			* @param status - the card's status state.
			* @param x - left edge to draw at.
			* @param textTop - top of the footer's text band (the card draws text with a top baseline).
			* @returns the width the mark occupies, gap included.
			*/
			const drawStatusMark = (theme, status, x, textTop) => {
				const size = 7;
				const top = textTop + Math.max(0, (theme.fonts.meta.lineHeight - size) / 2);
				ctx.globalAlpha = 1;
				ctx.setLineDash([]);
				if (status === "acked") {
					ctx.beginPath();
					ctx.strokeStyle = theme.success;
					ctx.lineWidth = 1.4;
					ctx.moveTo(x, top + size * .45);
					ctx.lineTo(x + size * .38, top + size * .9);
					ctx.lineTo(x + size, top + size * .05);
					ctx.stroke();
				} else if (status === "open") {
					ctx.beginPath();
					ctx.fillStyle = theme.warning;
					ctx.arc(x + size / 2, top + size / 2, size / 2, 0, Math.PI * 2);
					ctx.fill();
				} else {
					ctx.beginPath();
					ctx.fillStyle = theme.tertiary;
					ctx.fillRect(x, top, size, size);
				}
				return 12;
			};
			/**
			* Draw one card.
			* @param card - the card.
			* @param scene - theme and labels.
			* @param highlight - why this card is loud: `selected` is the open report (the
			*   ink accent, and its id in that ink); `hover` is the pointer (the light blue
			*   ring, with the id at full text weight rather than blue — a blue id on a
			*   white card is the one thing a hover must not do); `none` is ordinary.
			*/
			const drawCard = (card, scene, highlight) => {
				const { theme } = scene;
				const box = card.bounds;
				ctx.globalAlpha = 1;
				pathRoundRect(ctx, box, CARD_RADIUS);
				ctx.fillStyle = card.lod === "chip" ? statusColour(card.status, theme) : theme.surface;
				ctx.fill();
				if (card.lod === "chip") return;
				const ring = highlight === "selected" ? theme.accent : highlight === "hover" ? theme.hover : theme.border;
				ctx.strokeStyle = ring;
				ctx.lineWidth = highlight === "none" ? 1 : 1.6;
				ctx.stroke();
				ctx.save();
				pathRoundRect(ctx, box, CARD_RADIUS);
				ctx.clip();
				ctx.fillStyle = statusColour(card.status, theme);
				ctx.fillRect(box.x, box.y, STRIPE, box.height);
				ctx.restore();
				const textLeft = box.x + CARD_PADDING + STRIPE;
				const textWidth = box.width - CARD_PADDING * 2 - STRIPE;
				ctx.textAlign = "left";
				ctx.textBaseline = "top";
				ctx.font = fontString(theme.fonts.id);
				ctx.fillStyle = highlight === "selected" ? theme.accent : highlight === "hover" ? theme.text : theme.secondary;
				if (card.lod === "compact") {
					const id = card.report;
					const idWidth = measure(id);
					ctx.fillText(id, textLeft, box.y + box.height / 2 - theme.fonts.id.size / 2 - 1);
					ctx.font = fontString(theme.fonts.body);
					ctx.fillStyle = theme.caption;
					const rest = foldText(`· ${card.subject}`, textWidth - idWidth - 4, measure, 1)[0] ?? "";
					ctx.fillText(rest, textLeft + idWidth + 4, box.y + box.height / 2 - theme.fonts.body.size / 2 - 1);
					return;
				}
				ctx.fillText(card.report, textLeft, box.y + 8);
				ctx.font = fontString(theme.fonts.body);
				ctx.fillStyle = theme.text;
				foldText(card.subject, textWidth, measure, SUBJECT_LINES).forEach((text, index) => {
					ctx.fillText(text, textLeft, box.y + 28 + index * theme.fonts.body.lineHeight);
				});
				ctx.font = fontString(theme.fonts.meta);
				const baseline = box.y + box.height - theme.fonts.meta.lineHeight - 6;
				const markWidth = drawStatusMark(theme, card.status, textLeft, baseline);
				ctx.font = fontString(theme.fonts.meta);
				ctx.fillStyle = statusColour(card.status, theme);
				const status = scene.labels.status[card.status] ?? card.status;
				ctx.fillText(status, textLeft + markWidth, baseline);
				if (card.task !== void 0) {
					const statusWidth = measure(status);
					const chipLeft = textLeft + markWidth + statusWidth + 8;
					const chipText = foldText(card.task, box.x + box.width - CARD_PADDING - chipLeft - 10, measure, 1)[0] ?? "";
					if (chipText !== "") {
						ctx.fillStyle = theme.frameBar;
						const chipWidth = measure(chipText) + 10;
						ctx.fillRect(chipLeft, baseline - 2, chipWidth, theme.fonts.meta.lineHeight + 2);
						ctx.fillStyle = theme.caption;
						ctx.fillText(chipText, chipLeft + 5, baseline);
					}
				}
			};
			return {
				resize(w, h, ratio) {
					width = Math.max(0, w);
					height = Math.max(0, h);
					dpr = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
					canvas.width = Math.max(1, Math.round(width * dpr));
					canvas.height = Math.max(1, Math.round(height * dpr));
					canvas.style.width = `${width}px`;
					canvas.style.height = `${height}px`;
				},
				reset() {
					widths.clear();
				},
				paint(scene) {
					const { layout, theme, viewport } = scene;
					ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
					ctx.globalAlpha = 1;
					ctx.setLineDash([]);
					ctx.clearRect(0, 0, width, height);
					ctx.fillStyle = theme.canvas;
					ctx.fillRect(0, 0, width, height);
					const world = worldViewport(viewport, scene.overscan ?? 0);
					const visible = (rect) => intersects(rect, world);
					ctx.save();
					ctx.translate(viewport.offsetX, viewport.offsetY);
					ctx.scale(viewport.scale, viewport.scale);
					for (const frame of layout.frames) if (visible(frame.bounds)) drawFrame(frame, scene);
					for (const edge of layout.edges) if (visible(edge.bounds)) drawWire(edge, scene, 1);
					for (const card of layout.cards) {
						if (!visible(card.bounds)) continue;
						drawCard(card, scene, card.report === scene.focus?.selected ? "selected" : "none");
					}
					ctx.globalAlpha = 1;
					ctx.restore();
				},
				paintPath(scene) {
					const { layout, theme, viewport } = scene;
					const report = scene.focus?.report;
					const frameIndex = scene.focus?.frame;
					ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
					ctx.globalAlpha = 1;
					ctx.setLineDash([]);
					ctx.clearRect(0, 0, width, height);
					if (report === void 0 && frameIndex === void 0) return;
					ctx.save();
					ctx.translate(viewport.offsetX, viewport.offsetY);
					ctx.scale(viewport.scale, viewport.scale);
					if (report === void 0) {
						const frame = layout.frames[frameIndex];
						if (frame !== void 0) drawFrameOutline(frame, scene);
						ctx.restore();
						return;
					}
					const world = worldViewport(viewport, 0);
					const reveal = Math.min(1, Math.max(0, scene.hoverPhase ?? 1));
					ctx.globalAlpha = SCRIM_ALPHA * reveal;
					ctx.fillStyle = theme.canvas;
					ctx.fillRect(world.x, world.y, world.width, world.height);
					ctx.globalAlpha = 1;
					const edges = layout.edges.filter((edge) => edge.report === report);
					const touched = /* @__PURE__ */ new Set();
					for (const edge of edges) {
						if (edge.from.kind === "frame") touched.add(edge.from.index);
						if (edge.to.kind === "frame") touched.add(edge.to.index);
					}
					for (const frame of layout.frames) if (touched.has(frame.index)) drawFrameOutline(frame, scene);
					for (const edge of edges) if (intersects(edge.bounds, world)) drawWire(edge, scene, 1, theme.hover, reveal);
					const flow = scene.hoverFlow;
					if (flow !== void 0 && reveal >= 1) {
						for (const edge of edges) if (intersects(edge.bounds, world)) drawTraveller(edge, scene, flow);
					}
					for (const card of layout.cards) if (card.report === report) drawCard(card, scene, "hover");
					ctx.restore();
				}
			};
		}
		//#endregion
		//#region src/client/CardgraphView.tsx
		/**
		* The card canvas's view: two canvases, a pan/zoom transform, picking, and an
		* invisible button layer.
		*
		* The drawing is split across two surfaces, and that split is the whole
		* performance story:
		*
		*  - the **base** canvas holds frames, wires and cards, and is repainted only when
		*    the drawing itself changes (layout, transform, size, theme);
		*  - the **interaction** canvas holds one report's path over a scrim, and is
		*    repainted on every hover. Its cost does not grow with the ledger, because it
		*    never touches the shapes underneath.
		*
		* Picking is arithmetic rather than elements: the canvas has nothing to hit, so
		* `hitTest` from the model is given the cards (topmost first) and then the frames.
		* What the canvas also cannot offer is accessibility — so every card that is on
		* screen gets a real, transparent `<button>` on top of it, which is what a keyboard
		* or a screen reader reaches, and the list below stays the full accessible path.
		* A frame gets one too, over its title bar: that is the keyboard's way in.
		*
		* Navigation is layered, in the sense a subgraph editor means it: a session frame
		* can be **entered**, which swaps what the drawing is a drawing of — frames
		* outside the scope stop existing rather than being zoomed out of sight — and the
		* breadcrumb above the box walks back out. The scope itself is the model's
		* (`scopeInput`); this file only keeps the drill state and remembers where the
		* reader was in each scope, so leaving and coming back lands where they left it.
		*
		* @module dsh-report-ledger/client/CardgraphView
		*/
		/**
		* Wheel-zoom exponent per pixel of delta, so that one 100px notch — a mouse
		* wheel's usual magnitude — is exactly the {@link ZOOM_STEP} the buttons take.
		* A trackpad pinch arrives as the same event with much smaller deltas, which is
		* why the zoom is exponential in the delta rather than one step per event.
		*/
		const WHEEL_ZOOM_RATE = Math.log(ZOOM_STEP) / 100;
		/** How long the hovered path takes to draw itself out, in milliseconds. */
		const HOVER_REVEAL_MS = 200;
		/** How close to the box's edge a wheel-pan stops, in screen pixels. */
		const EDGE_MARGIN = 12;
		/** Drawing units to keep beyond the viewport, so a pan does not reveal a blank band. */
		const OVERSCAN = 160;
		/** How tall the canvas box is, inside the tab. */
		const VIEW_HEIGHT = 420;
		/** How far the pointer may travel before a press becomes a drag instead of a click. */
		const DRAG_SLOP = 4;
		/** The four kinds, in the order the legend lists them. */
		const KINDS = [
			"to",
			"cc",
			"author",
			"thread"
		];
		/**
		* Whether the pointer is on the same thing.
		*
		* A pointermove over one card is not a new hover: without this the state object is
		* replaced on every move, which re-renders the drawing and repaints the overlay for
		* no change at all.
		*/
		const sameHover = (a, b) => a.report === b.report && a.frame === b.frame;
		/**
		* The legend, and the only place the four kinds can be muted.
		*
		* Built from the painter's own wire table (`WIRE_TOKENS`) rather than from CSS, so
		* a legend that disagreed with the lines beside it would take a change to that one
		* table — the drift the swimlane's legend avoided a different way (by sharing a
		* class name with its paths).
		*
		* Each entry is a toggle: the drawing has one line per delivery, and a report with
		* several recipients makes a thicket. Muting a kind is a *view* filter — the layout
		* only drops those wires, no card or frame moves (`hiddenKinds` in the model).
		* `aria-pressed` carries the on/off state, so a keyboard reader hears which kinds
		* are showing.
		* @param props - the translator, the muted kinds, and the toggle handler.
		* @returns the legend row.
		*/
		function CardgraphLegend({ t, muted, onToggle }) {
			const off = new Set(muted ?? []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: legendRow,
				children: KINDS.map((kind) => {
					const hidden = off.has(kind);
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						"aria-pressed": !hidden,
						title: t(hidden ? "cardgraph.showKind" : "cardgraph.hideKind", { kind: t(EDGE_LABEL[kind]) }),
						onClick: () => {
							onToggle?.(kind);
						},
						style: {
							...legendItem,
							opacity: hidden ? .4 : 1,
							...onToggle === void 0 ? { cursor: "default" } : {}
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
							width: "26",
							height: "8",
							"aria-hidden": "true",
							focusable: "false",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
								x1: "0",
								y1: "4",
								x2: "26",
								y2: "4",
								stroke: `var(${WIRE_TOKENS[kind].colour})`,
								strokeWidth: WIRE_TOKENS[kind].width,
								...WIRE_TOKENS[kind].dash.length === 0 ? {} : { strokeDasharray: WIRE_TOKENS[kind].dash.join(" ") }
							})
						}), t(EDGE_LABEL[kind])]
					}, kind);
				})
			});
		}
		const legendRow = {
			display: "flex",
			alignItems: "center",
			gap: "12px",
			flexWrap: "wrap"
		};
		const legendItem = {
			display: "inline-flex",
			alignItems: "center",
			gap: "6px",
			padding: "0",
			border: "0",
			background: "transparent",
			cursor: "pointer",
			font: "inherit",
			fontSize: "var(--dsw-font-xxxs-11-font-size, 11px)",
			color: "var(--dsw-alias-label-caption)"
		};
		/** Keep a number inside a range. */
		const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
		/**
		* The drawing.
		* @param props - payload, the reports to plot, translations, and the open handler.
		* @returns the canvas box with its controls.
		*/
		function CardgraphView({ payload, reports, t, openReport, onOpen, idHint, fill = false }) {
			const boxRef = (0, react.useRef)(null);
			const baseRef = (0, react.useRef)(null);
			const pathRef = (0, react.useRef)(null);
			const painter = (0, react.useRef)(null);
			const pathPainter = (0, react.useRef)(null);
			const reader = (0, react.useRef)(null);
			const drag = (0, react.useRef)(null);
			const [size, setSize] = (0, react.useState)({
				width: 0,
				height: VIEW_HEIGHT
			});
			const [zoom, setZoom] = (0, react.useState)(1);
			const [offset, setOffset] = (0, react.useState)({
				x: 0,
				y: 0
			});
			const [hover, setHover] = (0, react.useState)({});
			/**
			* What the other surface (the list) is pointing at, and the report it has open.
			*
			* The canvas is in the right column and the list is in the conversation area:
			* two React trees, no shared props, one module — so the bridge under
			* `selection-bridge.ts` is the whole channel. A pointer on a card wins over a
			* row the list lit, because that pointer is physically here; the row's hover
			* shows whenever this pointer is on empty canvas.
			*/
			const bridged = (0, react.useSyncExternalStore)(selection.subscribe, selection.get);
			const pointed = hover.report ?? bridged.hover;
			/**
			* The hovered path's animation clock.
			*
			* `phase` is the entrance: the scrim fades and the wires draw outward once, over
			* {@link HOVER_REVEAL_MS}. `flow` is the **ongoing** part: while the pointer stays
			* on the card, a comet keeps running out along every wire, looping every
			* {@link HOVER_FLOW_SPEED}, so the relation stays visibly alive instead of flashing
			* once. Both are plain numbers handed to the painter, which keeps the drawing
			* deterministic: static assertions draw phase 1 with no flow.
			*/
			const [hoverClock, setHoverClock] = (0, react.useState)({ phase: 1 });
			const reducedMotion = (0, react.useMemo)(() => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true, []);
			(0, react.useEffect)(() => {
				if (pointed === void 0 || reducedMotion) {
					setHoverClock({ phase: 1 });
					return;
				}
				let frame = 0;
				const started = performance.now();
				setHoverClock({
					phase: 0,
					flow: 0
				});
				const step = (now) => {
					const elapsed = now - started;
					const entrance = Math.min(1, elapsed / HOVER_REVEAL_MS);
					setHoverClock({
						phase: 1 - (1 - entrance) ** 2,
						flow: elapsed
					});
					frame = requestAnimationFrame(step);
				};
				frame = requestAnimationFrame(step);
				return () => cancelAnimationFrame(frame);
			}, [
				pointed,
				hover.frame,
				reducedMotion
			]);
			/** The session id the drawing is scoped to; absent means the whole tree. */
			const [drill, setDrill] = (0, react.useState)(void 0);
			/**
			* Kinds the reader muted with the legend.
			*
			* The legend is also the filter: a report with several recipients makes a
			* thicket, and "show me only the thread" is the natural question. Muting is a
			* view filter — `buildCardgraph` drops those wires (and their ports) without
			* moving a card or a frame, so nothing re-fits and the reader's view stands.
			*/
			const [mutedKinds, setMutedKinds] = (0, react.useState)([]);
			const toggleKind = (0, react.useCallback)((kind) => {
				setMutedKinds((current) => current.includes(kind) ? current.filter((entry) => entry !== kind) : [...current, kind]);
			}, []);
			const [ready, setReady] = (0, react.useState)(false);
			/** Bumped when the palette changed, so the theme is read again. */
			const [themeTick, setThemeTick] = (0, react.useState)(0);
			/** Bumped when font metrics may have arrived, so the measured text is dropped. */
			const [fontTick, setFontTick] = (0, react.useState)(0);
			/** Bumped when the device pixel ratio may have changed. */
			const [dprTick, setDprTick] = (0, react.useState)(0);
			/**
			* The scope whose view has already been chosen (fitted, or restored from the
			* reader's own transform). Empty until the box has a width.
			*/
			const fittedScope = (0, react.useRef)(null);
			/**
			* A transform per scope.
			*
			* Leaving a level and coming back has to land where the reader was, not at the
			* fit — the fit is only the first sight of a scope they have not touched. The
			* `fitted` flag travels with it: a view the fit chose still follows the box, a
			* view the reader took over does not.
			*/
			const viewMemory = (0, react.useRef)(/* @__PURE__ */ new Map());
			/**
			* Whether the transform on screen is still the fit's own.
			*
			* While this holds, the fit follows the box; the moment the reader zooms or pans
			* the view themselves it stops following, because from then on the transform is
			* a decision rather than a consequence — see the resize effect below.
			*/
			const fittedTransform = (0, react.useRef)(true);
			/** The last box the resize effect saw, so a re-measure is not a resize. */
			const measured = (0, react.useRef)({
				width: 0,
				height: 0
			});
			/** The transform as of this render, for the one listener that is attached once. */
			const zoomRef = (0, react.useRef)(zoom);
			const offsetRef = (0, react.useRef)(offset);
			zoomRef.current = zoom;
			offsetRef.current = offset;
			/**
			* What this drawing is a drawing **of**.
			*
			* Drilling in swaps the input rather than the transform: the frames outside the
			* scope stop existing, so their wires land on the outside frame instead of
			* crossing the drawing, and no view of the parent level can be mistaken for this
			* one. The trail comes from the model's ancestry walk, not from the drill state,
			* so a scope whose session vanished from a refreshed payload degrades to the
			* whole tree instead of leaving a crumb that leads nowhere.
			*/
			const scope = (0, react.useMemo)(() => scopeInput(payload, reports, drill), [
				payload,
				reports,
				drill
			]);
			const scopeKey = scope.trail.join("/");
			const lod = "card";
			const layout = (0, react.useMemo)(() => buildCardgraph(scope.payload, scope.reports, {
				lod,
				hiddenKinds: mutedKinds,
				fitChannels: true
			}), [scope, mutedKinds]);
			/** The drawing as of this render, for that same listener: it needs its extent. */
			const layoutRef = (0, react.useRef)(layout);
			layoutRef.current = layout;
			/** Frame titles for the breadcrumb; a crumb that showed an id would be a riddle. */
			const titles = (0, react.useMemo)(() => new Map(payload.sessions.map((session) => [session.id, session.title])), [payload]);
			const labels = (0, react.useMemo)(() => {
				const status = {};
				for (const [state, key] of Object.entries(STATUS_LABEL)) status[state] = t(key);
				return {
					external: t(scope.trail.length === 0 ? "cardgraph.external" : "cardgraph.outside"),
					empty: t("cardgraph.empty"),
					status
				};
			}, [scope.trail.length, t]);
			(0, react.useEffect)(() => {
				const base = baseRef.current;
				const path = pathRef.current;
				if (base === null || path === null) return;
				painter.current = createCanvasPainter(base);
				pathPainter.current = createCanvasPainter(path);
				const doc = globalThis.document;
				reader.current = createThemeReader([doc.body, doc.documentElement], globalThis.window);
				const palette = new MutationObserver(() => {
					setThemeTick((tick) => tick + 1);
				});
				palette.observe(doc.body, {
					attributes: true,
					attributeFilter: ["data-ds-dark-theme"]
				});
				doc.fonts.ready.then(() => {
					painter.current?.reset();
					pathPainter.current?.reset();
					setFontTick((tick) => tick + 1);
				});
				setReady(true);
				return () => {
					palette.disconnect();
					painter.current = null;
					pathPainter.current = null;
					reader.current = null;
					setReady(false);
				};
			}, []);
			(0, react.useEffect)(() => {
				const box = boxRef.current;
				if (box === null) return;
				const measure = () => {
					setSize({
						width: box.clientWidth,
						height: box.clientHeight
					});
				};
				measure();
				const observer = new ResizeObserver(measure);
				observer.observe(box);
				return () => {
					observer.disconnect();
				};
			}, []);
			(0, react.useEffect)(() => {
				const win = globalThis.window;
				const bump = () => {
					setDprTick((tick) => tick + 1);
				};
				win.addEventListener("resize", bump);
				return () => {
					win.removeEventListener("resize", bump);
				};
			}, []);
			const viewport = (0, react.useMemo)(() => ({
				offsetX: offset.x,
				offsetY: offset.y,
				scale: zoom,
				width: size.width,
				height: size.height
			}), [
				offset,
				zoom,
				size
			]);
			/**
			* The theme the drawing is painted in.
			*
			* Read through the reader (which caches until the canary token moves) and keyed by
			* `ready` so the first real read happens once the reader exists, and by
			* `themeTick` so a palette switch repaints without waiting for the next poll.
			*/
			const theme = (0, react.useMemo)(() => ready ? reader.current?.read() ?? FALLBACK_THEME : FALLBACK_THEME, [ready, themeTick]);
			/**
			* The base layer's scene.
			*
			* Carries the open report — the selected card is accented there — but deliberately
			* **not** the hover: the bottom layer is repainted only when the drawing itself
			* changes, and a pointer moving over the canvas is not a change to the drawing.
			* The hover travels in {@link overlayScene}, which is what the second canvas is for.
			*/
			const baseScene = (0, react.useMemo)(() => ({
				layout,
				theme,
				viewport,
				labels,
				overscan: OVERSCAN,
				focus: openReport === void 0 ? {} : { selected: openReport }
			}), [
				layout,
				theme,
				viewport,
				labels,
				openReport
			]);
			/** The overlay's scene: the base scene plus what the pointer and the panel point at. */
			const overlayScene = (0, react.useMemo)(() => ({
				...baseScene,
				focus: {
					...openReport === void 0 ? {} : { selected: openReport },
					...pointed === void 0 ? {} : { report: pointed },
					...hover.frame === void 0 ? {} : { frame: hover.frame }
				},
				hoverPhase: hoverClock.phase,
				...hoverClock.flow === void 0 ? {} : { hoverFlow: hoverClock.flow }
			}), [
				baseScene,
				openReport,
				pointed,
				hover.frame,
				hoverClock
			]);
			(0, react.useEffect)(() => {
				if (!ready) return;
				const ratio = globalThis.devicePixelRatio || 1;
				painter.current?.resize(size.width, size.height, ratio);
				pathPainter.current?.resize(size.width, size.height, ratio);
			}, [
				ready,
				size,
				dprTick
			]);
			(0, react.useEffect)(() => {
				const target = painter.current;
				if (!ready || target === null) return;
				target.paint(baseScene);
			}, [
				ready,
				baseScene,
				fontTick
			]);
			(0, react.useEffect)(() => {
				const target = pathPainter.current;
				if (!ready || target === null) return;
				target.paintPath(overlayScene);
			}, [
				ready,
				overlayScene,
				fontTick
			]);
			/** Everything under the pointer, topmost first: cards, then the frames holding them. */
			const targets = (0, react.useMemo)(() => [...[...layout.cards].reverse().map((card) => ({
				kind: "card",
				report: card.report,
				bounds: card.bounds
			})), ...[...layout.frames].reverse().map((frame) => ({
				kind: "frame",
				frame: frame.index,
				bounds: frame.bounds
			}))], [layout]);
			const pick = (0, react.useCallback)((clientX, clientY) => {
				const box = boxRef.current;
				if (box === null) return void 0;
				const rect = box.getBoundingClientRect();
				const x = (clientX - rect.left - offset.x) / zoom;
				const y = (clientY - rect.top - offset.y) / zoom;
				return hitTest(targets, x, y);
			}, [
				targets,
				offset,
				zoom
			]);
			/**
			* Fill the width, in the richest tier that can afford to.
			*
			* The geometry itself lives in the model ({@link fitTransform}): the scale and
			* the tier are mutually dependent, so the probing belongs where it is pure,
			* byte-deterministic, and reachable by the assertions. What stays here is the
			* one thing that needs the DOM — which width to fit into — and the state write.
			*/
			const fit = (0, react.useCallback)(() => {
				const box = boxRef.current;
				if (box === null) return;
				const next = fitTransform(scope.payload, scope.reports, box.clientWidth, {
					lod,
					fitChannels: true,
					hiddenKinds: mutedKinds
				});
				if (next === void 0) return;
				fittedTransform.current = true;
				setZoom(next.scale);
				setOffset({
					x: next.offsetX,
					y: next.offsetY
				});
			}, [mutedKinds, scope]);
			/**
			* The `+`/`−` controls.
			*
			* An explicit zoom is the reader's decision, so the fit stops following the box
			* from here — the same reason the wheel and the drag clear the flag.
			* @param factor - what to multiply the current zoom by.
			*/
			const stepZoom = (0, react.useCallback)((factor) => {
				fittedTransform.current = false;
				setZoom((z) => clamp(z * factor, MIN_ZOOM, MAX_ZOOM));
			}, []);
			/** Remember the transform a scope is being left with, so coming back does not fit again. */
			const remember = (0, react.useCallback)((key) => {
				viewMemory.current.set(key, {
					zoom: zoomRef.current,
					offset: { ...offsetRef.current },
					fitted: fittedTransform.current
				});
			}, []);
			/**
			* Enter one session's subtree.
			*
			* The payload's own root is not enterable: its scope *is* the whole tree, so a
			* crumb for it would be indistinguishable from the first crumb.
			* @param index - the frame's index in the current layout.
			*/
			const enterFrame = (0, react.useCallback)((index) => {
				const id = layoutRef.current.frames[index]?.id;
				if (id === void 0 || id === payload.root) return;
				remember(scopeKey);
				setDrill(id);
			}, [
				payload.root,
				remember,
				scopeKey
			]);
			/**
			* Walk back out to a breadcrumb level.
			* @param level - how many crumbs to keep; 0 is the whole tree.
			*/
			const leaveTo = (0, react.useCallback)((level) => {
				if (level >= scope.trail.length) return;
				remember(scopeKey);
				setDrill(level === 0 ? void 0 : scope.trail[level - 1]);
			}, [
				remember,
				scope.trail,
				scopeKey
			]);
			/**
			* Choose the view for a scope: the one the reader left it with, or the fit.
			*
			* This replaces the old "first sight is the fit" guard rather than adding to it.
			* A scope is settled once, on arrival — fitted when it is new, restored (zoom,
			* pan and all) when the reader had already adjusted it, and re-fitted when the
			* box moved while they were inside. Keying it on the scope instead of on the
			* layout is what keeps a poll from re-fitting the drawing every ten seconds.
			*/
			(0, react.useEffect)(() => {
				if (size.width === 0 || layout.width === 0) return;
				if (fittedScope.current === scopeKey) return;
				fittedScope.current = scopeKey;
				setHover((current) => sameHover(current, {}) ? current : {});
				const remembered = viewMemory.current.get(scopeKey);
				if (remembered !== void 0 && !remembered.fitted) {
					fittedTransform.current = false;
					setZoom(clamp(remembered.zoom, MIN_ZOOM, MAX_ZOOM));
					setOffset(remembered.offset);
					return;
				}
				fit();
			}, [
				fit,
				layout,
				scopeKey,
				size
			]);
			/**
			* Esc leaves the scope, like the breadcrumb does.
			*
			* Attached only while drilled, so it never competes with the page for the key,
			* and skipped while the reader is typing somewhere.
			*/
			(0, react.useEffect)(() => {
				if (scope.trail.length === 0) return;
				const win = globalThis.window;
				const onKeyDown = (event) => {
					if (event.key !== "Escape") return;
					const target = event.target;
					if (target instanceof Element && target.closest("input, textarea, select, [contenteditable=\"true\"]") !== null) return;
					event.preventDefault();
					leaveTo(scope.trail.length - 1);
				};
				win.addEventListener("keydown", onKeyDown);
				return () => {
					win.removeEventListener("keydown", onKeyDown);
				};
			}, [leaveTo, scope.trail.length]);
			/**
			* Follow the box, but only while the box is what chose the view.
			*
			* A dock, a split and a fullscreen switch all change the box under a transform
			* computed for the old one. A drawing left carrying the old offset is clipped by
			* the new box — it reads as a broken drawing rather than as a preserved view —
			* so a view the fit chose is fitted again. A reader who zoomed in to read one
			* card means it, so a view they took over is left exactly where they put it.
			*
			* The box is compared by value, not by identity: the observer hands over a fresh
			* object on every measure, and a re-measure of the same box is not a resize.
			*/
			(0, react.useEffect)(() => {
				const previous = measured.current;
				measured.current = size;
				if (size.width === 0 || previous.width === 0) return;
				if (previous.width === size.width && previous.height === size.height) return;
				if (fittedTransform.current) fit();
			}, [fit, size]);
			(0, react.useEffect)(() => {
				const box = boxRef.current;
				if (box === null) return;
				const onWheel = (event) => {
					event.preventDefault();
					fittedTransform.current = false;
					const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.clientHeight : 1;
					const dy = event.deltaY * unit;
					const dx = event.deltaX * unit;
					const previous = offsetRef.current;
					if (event.ctrlKey || event.metaKey) {
						const rect = box.getBoundingClientRect();
						const px = event.clientX - rect.left;
						const py = event.clientY - rect.top;
						const current = zoomRef.current;
						const next = clamp(current * Math.exp(-dy * WHEEL_ZOOM_RATE), MIN_ZOOM, MAX_ZOOM);
						const ratio = next / current;
						setOffset({
							x: px - (px - previous.x) * ratio,
							y: py - (py - previous.y) * ratio
						});
						setZoom(next);
						return;
					}
					const drawing = layoutRef.current;
					const zoom = zoomRef.current;
					const width = drawing.width * zoom;
					const height = drawing.height * zoom;
					const overflowX = width - box.clientWidth;
					const overflowY = height - box.clientHeight;
					const panX = event.shiftKey && dx === 0 ? dy : dx;
					const panY = event.shiftKey ? 0 : dy;
					setOffset({
						x: overflowX > 0 ? clamp(previous.x - panX, box.clientWidth - width - EDGE_MARGIN, EDGE_MARGIN) : previous.x,
						y: overflowY > 0 ? clamp(previous.y - panY, box.clientHeight - height - EDGE_MARGIN, EDGE_MARGIN) : previous.y
					});
				};
				box.addEventListener("wheel", onWheel, { passive: false });
				return () => {
					box.removeEventListener("wheel", onWheel);
				};
			}, []);
			/**
			* Drag to pan, click to open. Distinguishing them by distance travelled.
			*
			* The pointer is captured on press, so a drag keeps following it outside the box
			* instead of being abandoned at the edge (a mouse has no implicit capture; touch
			* does). Only the primary pointer is followed, so a second finger cannot reset the
			* drag's origin halfway through a pan.
			*/
			const onPointerDown = (0, react.useCallback)((event) => {
				if (event.button !== 0 || !event.isPrimary) return;
				event.currentTarget.setPointerCapture(event.pointerId);
				drag.current = {
					x: event.clientX,
					y: event.clientY,
					offsetX: offset.x,
					offsetY: offset.y,
					moved: false,
					pointerId: event.pointerId
				};
			}, [offset]);
			const onPointerMove = (0, react.useCallback)((event) => {
				if (!event.isPrimary) return;
				const pressing = drag.current;
				if (pressing !== null) {
					const dx = event.clientX - pressing.x;
					const dy = event.clientY - pressing.y;
					if (dx * dx + dy * dy > DRAG_SLOP * DRAG_SLOP) pressing.moved = true;
					if (pressing.moved) {
						fittedTransform.current = false;
						setOffset({
							x: pressing.offsetX + dx,
							y: pressing.offsetY + dy
						});
						return;
					}
				}
				const hit = pick(event.clientX, event.clientY);
				const next = hit?.kind === "card" && hit.report !== void 0 ? { report: hit.report } : hit?.kind === "frame" && hit.frame !== void 0 ? { frame: hit.frame } : {};
				if (next.report === void 0) selection.clearHover("canvas");
				else selection.hover(next.report, "canvas");
				setHover((current) => sameHover(current, next) ? current : next);
			}, [pick]);
			const onPointerUp = (0, react.useCallback)((event) => {
				if (!event.isPrimary) return;
				const pressing = drag.current;
				drag.current = null;
				if (pressing === null || pressing.moved) return;
				const target = event.target;
				if (target instanceof Element && target.closest("button") !== null) return;
				const hit = pick(event.clientX, event.clientY);
				if (hit?.kind === "card" && hit.report !== void 0) onOpen(hit.report);
			}, [pick, onOpen]);
			const onPointerLeave = (0, react.useCallback)((event) => {
				const pressing = drag.current;
				if (pressing !== null && event.currentTarget.hasPointerCapture(pressing.pointerId)) return;
				drag.current = null;
				selection.clearHover("canvas");
				setHover((current) => sameHover(current, {}) ? current : {});
			}, []);
			/** A cancelled pointer will never deliver a release, so the drag ends here. */
			const onPointerCancel = (0, react.useCallback)((event) => {
				if (!event.isPrimary) return;
				drag.current = null;
				selection.clearHover("canvas");
			}, []);
			/**
			* Double-click a frame to enter it.
			*
			* The frame's title bar is also a real button (see the accessible layer), so
			* this is the pointer reader's route and that one is the keyboard's. A press
			* that turned into a pan never produces a double-click, which is why this shares
			* the drag's slop instead of measuring its own.
			*/
			const onDoubleClick = (0, react.useCallback)((event) => {
				const hit = pick(event.clientX, event.clientY);
				if (hit?.kind !== "frame" || hit.frame === void 0) return;
				enterFrame(hit.frame);
			}, [enterFrame, pick]);
			/** What the box can see, in drawing coordinates: the inverse of the painter's transform. */
			const visibleRect = (0, react.useMemo)(() => ({
				x: -offset.x / zoom,
				y: -offset.y / zoom,
				width: size.width / zoom,
				height: size.height / zoom
			}), [
				offset,
				zoom,
				size
			]);
			const visibleCards = (0, react.useMemo)(() => cullByBounds(layout.cards, visibleRect), [layout, visibleRect]);
			const visibleFrames = (0, react.useMemo)(() => cullByBounds(layout.frames, visibleRect), [layout, visibleRect]);
			const percent = Math.round(zoom * 100);
			/**
			* The frame this scope is already scoped to.
			*
			* Entering it would be a no-op — its subtree *is* this drawing — so it gets no
			* "enter" button. The payload's own root is excluded for the same reason: its
			* scope is the whole tree, which is what the first crumb already is.
			*/
			const scopeRoot = scope.trail[scope.trail.length - 1];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: "6px",
					...fill ? fillRoot : {}
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: controls,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("nav", {
							"aria-label": t("cardgraph.breadcrumb"),
							style: crumbs,
							children: [scope.trail.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								"aria-current": "page",
								style: crumbCurrent,
								children: t("cardgraph.all")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: crumbButton,
								onClick: () => {
									leaveTo(0);
								},
								children: t("cardgraph.all")
							}), scope.trail.map((id, index) => {
								const current = index === scope.trail.length - 1;
								const label = titles.get(id) ?? shortId(id);
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									"aria-hidden": "true",
									style: crumbSep,
									children: "/"
								}), current ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									"aria-current": "page",
									style: crumbCurrent,
									title: idHint(id),
									children: label
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: crumbButton,
									title: idHint(id),
									onClick: () => {
										leaveTo(index + 1);
									},
									children: label
								})] }, id);
							})]
						}),
						scope.trail.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							size: "sm",
							onClick: () => {
								leaveTo(scope.trail.length - 1);
							},
							children: t("cardgraph.up")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							size: "sm",
							"aria-label": t("cardgraph.zoomOut"),
							onClick: () => {
								stepZoom(1 / ZOOM_STEP);
							},
							children: "−"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: percentStyle,
							children: t("cardgraph.zoom", { percent })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							size: "sm",
							"aria-label": t("cardgraph.zoomIn"),
							onClick: () => {
								stepZoom(ZOOM_STEP);
							},
							children: "+"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							size: "sm",
							onClick: fit,
							children: t("cardgraph.fit")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CardgraphLegend, {
							t,
							muted: mutedKinds,
							onToggle: toggleKind
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: percentStyle,
							children: t("cardgraph.summary", {
								frames: layout.frames.length,
								cards: layout.cards.length
							})
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					ref: boxRef,
					onPointerDown,
					onPointerMove,
					onPointerUp,
					onPointerCancel,
					onPointerLeave,
					onDoubleClick,
					title: t("cardgraph.gestureHint"),
					style: {
						...box,
						...fill ? fillBox : { height: `${VIEW_HEIGHT}px` },
						cursor: drag.current?.moved === true ? "grabbing" : hover.report === void 0 ? "grab" : "pointer"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("canvas", {
							ref: baseRef,
							role: "img",
							"aria-label": t("cardgraph.summary", {
								frames: layout.frames.length,
								cards: layout.cards.length
							}),
							style: layer
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("canvas", {
							ref: pathRef,
							"aria-hidden": "true",
							style: layer
						}),
						visibleFrames.map((frame) => {
							const id = frame.id;
							if (id === void 0 || id === payload.root || id === scopeRoot) return null;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								"aria-label": t("cardgraph.enterFrame", { title: titles.get(id) ?? shortId(id) }),
								title: t("cardgraph.enterFrame", { title: idHint(id) }),
								onClick: () => {
									enterFrame(frame.index);
								},
								style: {
									...hitButton,
									left: `${frame.bounds.x * zoom + offset.x}px`,
									top: `${frame.bounds.y * zoom + offset.y}px`,
									width: `${frame.bounds.width * zoom}px`,
									height: `${layout.frameHeaderHeight * zoom}px`
								}
							}, `frame-${String(frame.index)}`);
						}),
						visibleCards.map((card) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							"aria-label": `${card.report} · ${card.subject}`,
							title: idHint(card.report),
							onClick: (event) => {
								onOpen(card.report);
								if (event.detail > 0) event.currentTarget.blur();
							},
							onFocus: () => {
								setHover({ report: card.report });
								selection.hover(card.report, "canvas");
							},
							onBlur: () => {
								setHover({});
								selection.clearHover("canvas");
							},
							style: {
								position: "absolute",
								left: `${card.bounds.x * zoom + offset.x}px`,
								top: `${card.bounds.y * zoom + offset.y}px`,
								width: `${card.bounds.width * zoom}px`,
								height: `${card.bounds.height * zoom}px`,
								padding: 0,
								border: 0,
								background: "transparent",
								cursor: "pointer"
							}
						}, card.report))
					]
				})]
			});
		}
		const controls = {
			display: "flex",
			alignItems: "center",
			gap: "8px",
			flexWrap: "wrap"
		};
		const percentStyle = {
			fontSize: "var(--dsw-font-xxxs-11-font-size, 11px)",
			color: "var(--dsw-alias-label-caption)",
			fontVariantNumeric: "tabular-nums"
		};
		/**
		* The breadcrumb: a real navigation landmark, because the drawing's own scope is
		* not otherwise announced to a screen reader.
		*/
		const crumbs = {
			display: "flex",
			alignItems: "center",
			gap: "4px",
			minWidth: "0",
			flexWrap: "wrap"
		};
		const crumbButton = {
			border: "0",
			padding: "0 2px",
			background: "transparent",
			cursor: "pointer",
			font: "inherit",
			fontSize: "var(--dsw-font-xxxs-11-font-size, 11px)",
			color: "var(--dsw-alias-label-caption)",
			textDecoration: "underline"
		};
		const crumbCurrent = {
			padding: "0 2px",
			fontSize: "var(--dsw-font-xxxs-11-font-size, 11px)",
			color: "var(--dsw-alias-label-caption)",
			fontWeight: "600",
			maxWidth: "200px",
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap"
		};
		const crumbSep = {
			fontSize: "var(--dsw-font-xxxs-11-font-size, 11px)",
			color: "var(--dsw-alias-label-caption)"
		};
		/** The transparent button layer: a frame's title bar, and every card. */
		const hitButton = {
			position: "absolute",
			padding: "0",
			border: "0",
			background: "transparent",
			cursor: "pointer"
		};
		const box = {
			position: "relative",
			overflow: "hidden",
			borderRadius: "6px",
			border: "1px solid var(--dsw-alias-border-l1)",
			touchAction: "none"
		};
		/**
		* A filling host owns the height: the root takes the whole body and lets the
		* measured box keep whatever the toolbar left. `minHeight` is what stops a flex
		* child from refusing to shrink, which would push the toolbar off the top of a
		* short panel instead of shrinking the drawing.
		*/
		const fillRoot = {
			flex: "1 1 auto",
			height: "100%",
			minHeight: "0"
		};
		const fillBox = {
			flex: "1 1 auto",
			minHeight: "0"
		};
		const layer = {
			position: "absolute",
			inset: "0",
			display: "block"
		};
		//#endregion
		//#region src/client/report-tab.ts
		/**
		* Switching the conversation area to this plugin's report view.
		*
		* The shell exposes view selection in exactly one place: the `openView` prop it
		* hands to a mounted `conversation.view`. That is circular for us — the sidebar
		* canvas is not a view, and it needs the switch precisely when the report view is
		* **not** mounted. The per-session conversation store that actually holds the
		* selection is slot-private (`PropsStore<ConversationStore>`), and
		* `ctx.uiConversation` publishes registries and bindings but no view verb
		* (`binding(...).activate` activates an assembly target, not a tab).
		*
		* So this is the one honest way left: click the tab the shell rendered for us.
		* The label is the one we registered (`view.tab`), the hit is scoped to
		* `[role="tab"]`, and a label that is no longer on screen is a no-op rather than
		* an error — a host that hides the tab bar (fewer than two views) simply keeps
		* the request pending in the selection bridge.
		*
		* This is a documented compromise, not a pattern to copy: the day the shell
		* exposes a select-view verb, this file goes away and nothing else changes.
		*
		* @module dsh-report-ledger/client/report-tab
		*/
		/**
		* Bring the report view to the front, if the shell rendered a tab for it.
		* @param doc - the document to search (passed in so it can be faked in checks).
		* @param label - the view's label, as this plugin registered it.
		* @returns whether a tab was found. `true` also means "it is selected now",
		*   including when it already was.
		*/
		function activateReportTab(doc, label) {
			if (doc === void 0) return false;
			const matches = Array.from(doc.querySelectorAll("[role=\"tab\"]")).filter((candidate) => (candidate.textContent ?? "").trim() === label);
			if (matches.some((tab) => tab.getAttribute("aria-selected") === "true")) return true;
			const target = matches[0];
			if (target === void 0) return false;
			const clickable = target;
			if (typeof clickable.click !== "function") return false;
			clickable.click();
			return true;
		}
		//#endregion
		//#region src/client/sidebar-tab.ts
		/**
		* The card canvas as a right-Sidebar tab — stage one and stage two of the tab
		* system.
		*
		* The right column belongs to the product
		* (`@deepseek-ai/dsh-client-ui-sidebar-right`), and a type from outside reaches
		* it through **cordis services**, never through imports: the client bundle's
		* purity gate rejects a cross-plugin value import, and that package's types are
		* not part of a third-party plugin's resolvable dependency set anyway. So the
		* two faces this module needs are asserted structurally here, exactly as
		* `client/index.ts` already asserts the `slots` and `locale` faces.
		*
		* ## Why the registry is injected rather than read
		*
		* `sidebarRightTabs` is published by that package's own `apply`. Cordis has no
		* optional-dependency form: a key on this plugin's `inject` list is a
		* REQUIREMENT, and a missing one parks this plugin's fiber — on the web boot
		* that is a white page, not a degraded view. `ctx.get` fails the other way: it
		* reads the registry at this instant, so a host that publishes it a moment later
		* would leave the tab silently unregistered forever. `ctx.inject` is the one
		* form that is both optional and late — the callback runs when the service
		* actually appears, and again if it comes back.
		*
		* ## Why the guide entry is not optional in practice
		*
		* The strip's `+` control only ever re-opens the guide page, and the guide lists
		* registered types through exactly the entries they declare. Without one, this
		* tab could only ever be opened by code.
		*
		* ## What the body draws
		*
		* The drawing the conversation tab used to carry, filling the panel instead of
		* sitting in a fixed 420px box — the panel owns its height, and it can be split
		* or taken fullscreen, which is most of the reason to put a drawing in this
		* column at all.
		*
		* Picking a card does **not** open the detail here. A half-height drawing is the
		* price of an inline detail, and it is a bad price: the drawing is the reason the
		* column exists. The click instead switches the conversation area to the report
		* view and opens that report there, where there is room for the transfer path and
		* the body — the two surfaces talk through `selection-bridge.ts`, which is also
		* what makes hovering one highlight the other.
		*
		* @module dsh-report-ledger/client/sidebar-tab
		*/
		/** This type's identity in the tab system: unique, and the key both seats use. */
		const TAB_ID = "dsh-report-ledger/canvas";
		/**
		* What `openTab(kind)` names.
		*
		* Deliberately not derived from {@link TAB_ID}: the registry is looked up BY
		* kind, and deriving one name from the other is a mistake the ecosystem has
		* already paid for — a registration that says one thing while its opener says
		* another only fails at click time.
		*/
		const TAB_KIND = "ledger-canvas";
		/** The sentences that stand in for a drawing that cannot be made yet. */
		const muted = {
			padding: "12px",
			color: "var(--dsw-alias-label-caption)"
		};
		/** A non-blocking read failure shown above a drawing that is still usable. */
		const notice = {
			...muted,
			padding: "6px 10px",
			color: "var(--dsw-alias-state-error-primary)",
			font: "var(--dsw-font-xxxs-11, 11px/14px system-ui, sans-serif)",
			minWidth: "0",
			whiteSpace: "normal"
		};
		/**
		* The drawing alone: it takes whatever the panel has.
		*
		* There is no second cell any more. The detail used to split the panel evenly with
		* the drawing, which halved the thing the column exists for; it now opens in the
		* conversation area, where it has room and the drawing keeps its height.
		*/
		const stackFull = {
			flex: "1 1 auto",
			minHeight: "0"
		};
		/**
		* Bind the tab body to the plugin's copy.
		*
		* The body is the *second* registration and carries the runtime face: a
		* component, receiving the session it was opened in — which is the only input
		* the drawing needs, since the ledger is read from the session tree's root.
		* @param t - namespace-bound translate, read on every render.
		* @returns the tab body component.
		*/
		function bodyFor(t) {
			return function LedgerCanvasBody(props) {
				const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
				const { payload, error } = useTimeline(sessionId);
				/**
				* What the list has open.
				*
				* This surface does not open anything itself: the list is where a report is
				* read, so it owns the state and the canvas follows it (for the selected
				* card's accent). The session is compared before honoring it, so a value left
				* by another session cannot light a card here.
				*/
				const bridged = (0, react.useSyncExternalStore)(selection.subscribe, selection.get);
				const openReport = bridged.session === sessionId ? bridged.report : void 0;
				const rows = (0, react.useMemo)(() => payload === void 0 ? [] : buildRows(payload), [payload]);
				const reports = (0, react.useMemo)(() => rows.flatMap((row) => row.kind === "report" ? [row.front] : []), [rows]);
				const titles = (0, react.useMemo)(() => payload === void 0 ? /* @__PURE__ */ new Map() : sessionTitles(payload), [payload]);
				const idHint = (0, react.useCallback)((id) => {
					const title = titles.get(id);
					return title === void 0 ? id : `${title} · ${id}`;
				}, [titles]);
				/**
				* Open this card's report in the report view.
				*
				* The selection crosses through the bridge; bringing the view forward has to
				* be a tab click — `report-tab.ts` says why, and degrades to a no-op when the
				* shell offers no tab. Clicking the open card again closes it, matching what a
				* row does.
				*/
				const onOpen = (0, react.useCallback)((report) => {
					selection.open(openReport === report ? void 0 : report, sessionId);
					activateReportTab(globalThis.document, t("view.tab"));
				}, [
					openReport,
					sessionId,
					t
				]);
				if (payload === void 0) {
					if (error !== void 0) return (0, react.createElement)("div", { style: muted }, t("view.error", { code: error }));
					return (0, react.createElement)("div", { style: muted }, t("view.loading"));
				}
				if (reports.length === 0) return (0, react.createElement)("div", { style: muted }, t("view.empty"));
				return (0, react.createElement)("div", { style: stackFull }, error === void 0 ? null : (0, react.createElement)("div", { style: notice }, t("view.error", { code: error })), (0, react.createElement)(CardgraphView, {
					payload,
					reports,
					t,
					...openReport === void 0 ? {} : { openReport },
					onOpen,
					idHint,
					fill: true
				}));
			};
		}
		/**
		* Contribute the canvas tab: its type, its body, and its guide capsule.
		* @param ctx - the client context (slots, plus the optional registry service).
		* @param t - namespace-bound translate, read fresh on every label call.
		*/
		function installSidebarTab(ctx, t) {
			ctx.inject(["sidebarRightTabs"], (scoped) => {
				const tabs = scoped.get("sidebarRightTabs");
				if (tabs === void 0) return;
				scoped.effect(() => {
					const disposeType = tabs.register({
						id: TAB_ID,
						kind: TAB_KIND,
						priority: "extension",
						title: () => t("sidebar.chip"),
						guide: [{
							id: "canvas",
							order: 15,
							title: () => t("sidebar.guideTitle"),
							description: () => t("sidebar.guideDescription")
						}]
					});
					const disposeBody = ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
						name: "sidebar.right.pane.tab",
						key: TAB_ID
					}, bodyFor(t)));
					return () => {
						disposeBody();
						disposeType();
					};
				}, "report-ledger: canvas tab");
			});
		}
		//#endregion
		//#region src/client/path-opener.ts
		/**
		* Wrap a session Remote in the three verbs, when the host carries them.
		* @param remote - the `remote.session` service, or whatever the context returned.
		* @returns the opener, or `undefined` when this deployment has no such face.
		*/
		function createPathOpener(remote) {
			if (remote === null || typeof remote !== "object") return void 0;
			const face = remote;
			if (typeof face.canOpenWorkspacePath !== "function" || typeof face.openWorkspacePath !== "function") return;
			return {
				async available() {
					const answer = await face.canOpenWorkspacePath?.();
					return answer?.ok === true && answer.value === true;
				},
				async applications(path, signal) {
					if (typeof face.workspacePathApplications !== "function") return null;
					const answer = await face.workspacePathApplications({ path }, signal);
					return answer.ok === true && Array.isArray(answer.value) ? answer.value : null;
				},
				async open(path, action, application) {
					return (await face.openWorkspacePath?.({
						path,
						...action === "reveal" ? { action: "reveal" } : {},
						...application === void 0 ? {} : { application }
					}))?.ok === true;
				}
			};
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Browser half of dsh-report-ledger — runs inside the dsh web GUI.
		*
		* The shell serves the built `lib/client.js` from /plugins/dsh-report-ledger/client.js
		* and evaluates it as a closure-factory artifact, so this module's `require` is
		* answered by the loader's frozen module table (react, cordis, the slot
		* services) and every other dependency is inlined by the build.
		*
		* It contributes exactly one thing: a `conversation.view` entry, which the
		* conversation shell projects as a tab beside the shipped Chat and Trajectory
		* views. A fresh id is used rather than an existing one, so nothing shipped is
		* replaced.
		*
		* @module dsh-report-ledger/client
		*/
		/** Locale namespace this plugin owns. */
		const NS = "report-ledger";
		/** Tab key. Distinct from the shipped `chat` / `trajectory` cells. */
		const VIEW_ID = "report-ledger";
		/** Position after the shipped views (`chat` 0, `trajectory` 10). */
		const VIEW_ORDER = 20;
		/** The slot and locale services must be mounted before this half can contribute. */
		const inject = ["slots", "locale"];
		/**
		* Apply the browser half.
		* @param ctx - the client plugin context (`slots`, `locale` injected).
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "report-ledger: dictionaries");
			ctx.effect(() => installStyles(), "report-ledger: adapter styles");
			const t = ctx.locale.bind(NS);
			const opener = () => createPathOpener(ctx.get("remote.session"));
			installSidebarTab(ctx, t);
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: VIEW_ID,
				order: VIEW_ORDER,
				label: () => t("view.tab"),
				locale: NS
			}, (props) => (0, react.createElement)(ReportsView, {
				...props,
				t,
				opener
			})));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map