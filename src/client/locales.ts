/**
 * Dictionary for the report timeline tab.
 *
 * Both shipped locales are required by the client locale service, and the key
 * union drives the typed `t()` the view uses, so a missing translation is a
 * type error rather than an empty label.
 *
 * @module dsh-report-ledger/client/locales
 */

/** Chinese dictionary — the source of truth for the key set. */
export const zh = {
  'view.tab': '汇报',
  'view.loading': '正在读取账本…',
  'view.summary': '{sessions} 个会话 · {reports} 份汇报',
  'view.empty': '这个会话树下还没有汇报。代理用 report_author 开一份汇报后，这里会出现它的缩略卡。',
  'view.refresh': '刷新',
  'view.retry': '重试',
  'view.error': '读取失败：{code}',
  'view.root': '本会话',
  'view.live': '在线',
  'view.delegated': '子代理',
  'view.detail.loading': '正在读取传递路径…',
  'view.detail.route': '传递路径',
  'view.detail.routeEmpty': '（还没有记录跳）',
  'view.detail.pending': '仍在等待送达：{targets}',
  'view.detail.body': '正文',
  'view.detail.path': '账本文件',
  'row.hops': '{count} 跳',
  'row.authors': '{count} 位共写',
  'row.filterByTask': '只看任务「{task}」',
  'filter.all': '全部',
  'filter.open': '进行中',
  'filter.acked': '已回执',
  'filter.closed': '已结案',
  'filter.search': '搜索主题、编号、会话或收发…',
  'filter.clear': '清除',
  'filter.showing': '显示 {visible}/{total} 份汇报',
  'filter.none': '没有符合当前筛选的汇报。',
  'filter.hint': '状态筛选只作用于汇报；搜索会同时匹配会话标题与编号。',
  'basis.created': '按创建',
  'basis.updated': '按最近活动',
  'basis.hint': '汇报按创建时间还是按最后一次活动排入时间线；会话始终按创建时间。',
  'detail.thread': '线程',
  'detail.parent': '上溯',
  'detail.children': '下递',
  'detail.openLinked': '打开 {report}',
  'detail.outside': '{report} 不在当前会话树的列表里（它可能属于另一条线）；正文与路径仍可读取。',
  'detail.filteredOut': '{report} 在当前筛选下被隐藏了（用「清除」恢复）。',
  'detail.backToList': '回到列表',
  'detail.bodyTruncated': '正文过长，此处只显示开头 {chars} 字；完整内容见账本文件。',
} as const

/** English dictionary, checked against the Chinese key set. */
export const en: Record<keyof typeof zh, string> = {
  'view.tab': 'Reports',
  'view.loading': 'Reading the ledger…',
  'view.summary': '{sessions} sessions · {reports} reports',
  'view.empty': 'No reports in this session tree yet. Once an agent opens one with report_author, its digest card appears here.',
  'view.refresh': 'Refresh',
  'view.retry': 'Retry',
  'view.error': 'Read failed: {code}',
  'view.root': 'this session',
  'view.live': 'live',
  'view.delegated': 'subagent',
  'view.detail.loading': 'Reading the transfer path…',
  'view.detail.route': 'Transfer path',
  'view.detail.routeEmpty': '(no hops recorded yet)',
  'view.detail.pending': 'Still owed to: {targets}',
  'view.detail.body': 'Body',
  'view.detail.path': 'Ledger file',
  'row.hops': '{count} hops',
  'row.authors': '{count} authors',
  'row.filterByTask': 'Show only task "{task}"',
  'filter.all': 'All',
  'filter.open': 'Open',
  'filter.acked': 'Acked',
  'filter.closed': 'Closed',
  'filter.search': 'Search subject, id, session, or people…',
  'filter.clear': 'Clear',
  'filter.showing': 'Showing {visible}/{total} reports',
  'filter.none': 'No reports match the current filter.',
  'filter.hint': 'The status filter narrows reports only; search matches every row, including session titles and ids.',
  'basis.created': 'By creation',
  'basis.updated': 'By activity',
  'basis.hint': 'Whether reports are placed at creation or at their latest activity; sessions always keep their creation time.',
  'detail.thread': 'Thread',
  'detail.parent': 'Answers',
  'detail.children': 'Answered by',
  'detail.openLinked': 'Open {report}',
  'detail.outside': '{report} is not in this session tree\'s list (it may belong to another line); its body and path are still readable.',
  'detail.filteredOut': '{report} is hidden by the current filter (use Clear to restore it).',
  'detail.backToList': 'Back to the list',
  'detail.bodyTruncated': 'Body is long, so only the first {chars} characters are shown here; the ledger file has the whole thing.',
}

/** Every key the view may translate. */
export type ReportLedgerKey = keyof typeof zh
