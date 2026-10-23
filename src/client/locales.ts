/**
 * Dictionary for the report timeline tab.
 *
 * Both shipped locales are required by the client locale service, and the key
 * union drives the typed `t()` the view uses, so a missing translation is a
 * type error rather than an empty label.
 *
 * @module dsh-report-ledger/client/locales
 */

import type { HopAction, LeaseState, ReportStatus } from '../shared/wire.ts'
import type { CardgraphEdgeKind } from './cardgraph-model.ts'

/** Chinese dictionary — the source of truth for the key set. */
export const zh = {
  'view.tab': '汇报',
  'view.loading': '正在读取账本…',
  'view.summary': '{sessions} 个会话 · {reports} 份汇报',
  'view.empty': '这个会话树下还没有汇报。代理用 report_author 开一份汇报后，这里会出现它的缩略卡。',
  'view.refresh': '刷新',
  'view.retry': '重试',
  'view.error': '读取失败：{code}',
  'view.live': '在线',
  'view.delegated': '子代理',
  'view.detail.loading': '正在读取传递路径…',
  'view.detail.route': '传递路径',
  'view.detail.routeEmpty': '（还没有记录跳）',
  'view.detail.pending': '仍在等待送达：{targets}',
  'view.detail.body': '正文',
  'view.detail.path': '账本文件',
  'view.copyPath': '复制账本路径',
  'row.hops': '{count} 跳',
  'row.authors': '{count} 位共写',
  'row.filterByTask': '只看任务「{task}」',
  'row.filterByWorktree': '只看检出「{worktree}」',
  'row.leaseHeld': '工作区：正在被这份汇报占用',
  'row.leaseReleased': '工作区：占用已结束，检出仍留在磁盘上',
  'row.leaseReclaimed': '工作区：已被账本回收清除',
  'row.leaseNone': '工作区：绑定已记录，但从未被占用',
  'row.expand': '展开 {report}',
  'row.collapse': '收起 {report}',
  'row.last': '最后',
  'hop.authored': '发起',
  'hop.contributed': '共写',
  'hop.sent': '主送',
  'hop.delivered': '送达',
  'hop.cc': '抄送',
  'hop.forwarded': '转呈',
  'hop.copied': '副本',
  'hop.read': '阅读',
  'hop.acked': '回执',
  'hop.leased': '认领工作区',
  'hop.released': '释放工作区',
  'hop.reclaimed': '回收工作区',
  'hop.amended': '修正',
  'hop.closed': '结案',
  'hop.reopened': '重开',
  'hop.transferred': '转交',
  'filter.all': '全部',
  'filter.open': '进行中',
  'filter.acked': '已回执',
  'filter.closed': '已结案',
  'filter.search': '搜索主题、编号、会话或收发…',
  'filter.clear': '清除',
  'filter.showing': '显示 {visible}/{total} 份汇报',
  'filter.none': '没有符合当前筛选的汇报。',
  'filter.hint': '状态筛选只作用于汇报；搜索会同时匹配会话标题与编号，以及任务标签和检出名。',
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
  'detail.openFile': '用默认应用打开',
  'detail.openFileMenu': '更多打开方式',
  'detail.openFileLoading': '正在读取应用…',
  'detail.revealFile': '在文件管理器中显示',
  'detail.openFileFailed': '打开失败',
  'detail.expandBody': '展开正文',
  'detail.collapseBody': '收起正文',
  'cardgraph.external': '树外',
  'cardgraph.outside': '范围外',
  'cardgraph.all': '全部',
  'cardgraph.breadcrumb': '当前范围',
  'cardgraph.enterFrame': '进入 {title}',
  'cardgraph.up': '上一级',
  'cardgraph.zoomIn': '放大',
  'cardgraph.zoomOut': '缩小',
  'cardgraph.zoom': '{percent}%',
  'cardgraph.fit': '填满宽度',
  'cardgraph.summary': '{frames} 个框 · {cards} 份汇报',
  'cardgraph.empty': '没有汇报',
  'cardgraph.gestureHint': '滚轮平移 · Ctrl+滚轮缩放 · 双击会话框进入',
  // The right-Sidebar tab this plugin contributes: the capsule that makes it
  // discoverable on the guide page, and the chip an open tab shows.
  'sidebar.guideTitle': '汇报画布',
  'sidebar.guideDescription': '把拓扑画布停靠进右侧栏',
  'sidebar.chip': '汇报画布',
  'body.copy': '复制',
  'body.copied': '已复制',
  'body.footnotes': '脚注',
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
  'view.live': 'live',
  'view.delegated': 'subagent',
  'view.detail.loading': 'Reading the transfer path…',
  'view.detail.route': 'Transfer path',
  'view.detail.routeEmpty': '(no hops recorded yet)',
  'view.detail.pending': 'Still owed to: {targets}',
  'view.detail.body': 'Body',
  'view.detail.path': 'Ledger file',
  'view.copyPath': 'Copy the ledger path',
  'row.hops': '{count} hops',
  'row.authors': '{count} authors',
  'row.filterByTask': 'Show only task "{task}"',
  'row.filterByWorktree': 'Show only checkout "{worktree}"',
  'row.leaseHeld': 'Checkout: currently claimed by this report',
  'row.leaseReleased': 'Checkout: claim ended, the checkout is still on disk',
  'row.leaseReclaimed': 'Checkout: cleared away by the ledger',
  'row.leaseNone': 'Checkout: bound but never claimed',
  'row.expand': 'Expand {report}',
  'row.collapse': 'Collapse {report}',
  'row.last': 'last',
  'hop.authored': 'authored',
  'hop.contributed': 'contributed',
  'hop.sent': 'sent',
  'hop.delivered': 'delivered',
  'hop.cc': 'cc',
  'hop.forwarded': 'forwarded',
  'hop.copied': 'copied',
  'hop.read': 'read',
  'hop.acked': 'acked',
  'hop.leased': 'leased',
  'hop.released': 'released',
  'hop.reclaimed': 'reclaimed',
  'hop.amended': 'amended',
  'hop.closed': 'closed',
  'hop.reopened': 'reopened',
  'hop.transferred': 'transferred',
  'filter.all': 'All',
  'filter.open': 'Open',
  'filter.acked': 'Acked',
  'filter.closed': 'Closed',
  'filter.search': 'Search subject, id, session, or people…',
  'filter.clear': 'Clear',
  'filter.showing': 'Showing {visible}/{total} reports',
  'filter.none': 'No reports match the current filter.',
  'filter.hint': 'The status filter narrows reports only; search matches every row, including session titles and ids, task labels and checkout names.',
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
  'detail.openFile': 'Open in default app',
  'detail.openFileMenu': 'Open another way',
  'detail.openFileLoading': 'Reading applications…',
  'detail.revealFile': 'Show in file manager',
  'detail.openFileFailed': 'Could not open',
  'detail.expandBody': 'Expand the body',
  'detail.collapseBody': 'Collapse the body',
  'cardgraph.external': 'outside',
  'cardgraph.outside': 'outside the scope',
  'cardgraph.all': 'All',
  'cardgraph.breadcrumb': 'Current scope',
  'cardgraph.enterFrame': 'Enter {title}',
  'cardgraph.up': 'Up one level',
  'cardgraph.zoomIn': 'Zoom in',
  'cardgraph.zoomOut': 'Zoom out',
  'cardgraph.zoom': '{percent}%',
  'cardgraph.fit': 'Fill width',
  'cardgraph.summary': '{frames} frames · {cards} reports',
  'cardgraph.empty': 'no reports',
  'cardgraph.gestureHint': 'Wheel pans · Ctrl+wheel zooms · Double-click a frame to enter',
  'sidebar.guideTitle': 'Report canvas',
  'sidebar.guideDescription': 'Dock the topology canvas into the right sidebar',
  'sidebar.chip': 'Report canvas',
  'body.copy': 'Copy',
  'body.copied': 'Copied',
  'body.footnotes': 'Footnotes',
}

/** Every key the view may translate. */
export type ReportLedgerKey = keyof typeof zh

/**
 * Lifecycle state → dictionary key.
 *
 * Deliberately the SAME keys the toolbar's filter chips use. A card's status
 * chip and the filter that selects it name one state, so giving them two
 * vocabularies (raw `open` on the card, 进行中 in the toolbar) made the reader
 * build the mapping themselves — and the mapping was the bug, not the words.
 */
export const STATUS_LABEL: Record<ReportStatus, ReportLedgerKey> = {
  open: 'filter.open',
  acked: 'filter.acked',
  closed: 'filter.closed',
}

/**
 * Lifecycle state → the shell's chip tone.
 *
 * Colour-coded status is the point of the chip, and the shell's palette already
 * has the three tones this needs — so the states ride `Tag` instead of a
 * hand-mixed background. `open` reads as the one that wants attention. The tone
 * names are the ones the shell's CSS actually defines (`[data-tone=…]`), which
 * is a longer list than the shipped views happen to use.
 */
export const STATUS_TONE: Record<ReportStatus, 'warning' | 'success' | 'neutral'> = {
  open: 'warning',
  acked: 'success',
  closed: 'neutral',
}

/**
 * Edge kind → the word the drawing calls it.
 *
 * The drawing borrows the transfer path's own vocabulary rather than inventing a
 * second one: an arrow in the canvas and a row in the panel name the same
 * relation, so they say the same thing.
 */
export const EDGE_LABEL: Record<CardgraphEdgeKind, ReportLedgerKey> = {
  to: 'hop.sent',
  cc: 'hop.cc',
  author: 'hop.contributed',
  thread: 'detail.thread',
}

/** Lease-state description, for the checkout chip's tooltip. */
export const LEASE_HINT: Record<LeaseState, ReportLedgerKey> = {
  held: 'row.leaseHeld',
  released: 'row.leaseReleased',
  reclaimed: 'row.leaseReclaimed',
  none: 'row.leaseNone',
}

/**
 * Transfer-path hop action → dictionary key.
 *
 * These are ledger vocabulary: the model and the ledger files keep the raw
 * tokens (`authored`, `delivered`, …), and only the human view speaks a
 * language. Keyed by the full action union so a new hop action cannot ship
 * without a word for it.
 */
export const HOP_LABEL: Record<HopAction, ReportLedgerKey> = {
  authored: 'hop.authored',
  contributed: 'hop.contributed',
  sent: 'hop.sent',
  delivered: 'hop.delivered',
  cc: 'hop.cc',
  forwarded: 'hop.forwarded',
  copied: 'hop.copied',
  read: 'hop.read',
  acked: 'hop.acked',
  leased: 'hop.leased',
  released: 'hop.released',
  reclaimed: 'hop.reclaimed',
  amended: 'hop.amended',
  closed: 'hop.closed',
  reopened: 'hop.reopened',
  transferred: 'hop.transferred',
}
