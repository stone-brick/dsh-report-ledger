/**
 * Model-facing guidance for the report ledger.
 *
 * Two sections, deliberately split:
 *
 *  - {@link PROTOCOL} is a plain string, byte-identical for every agent. Keeping
 *    it out of the role-aware provider means the shared part of the prompt stays
 *    a stable prefix for every scope.
 *  - {@link partnershipText} is evaluated per assembly because the partnership
 *    contract has to address two different readers: an agent that delegates, and
 *    an agent that was delegated to. The second one needs to know it is a
 *    long-lived partner with a durable session rather than a one-shot function,
 *    and it needs its parent's session id to report upward at all.
 *
 * Role is decided synchronously from the session header
 * (`origin: 'subagent'` / a non-zero `delegationDepth`), which is durable and
 * present from the first assembly — no lookup, no cache, no async race.
 *
 * @module dsh-report-ledger/report/guidance
 */

import type {} from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'

/** Order of the protocol section within the tool-guidance band. */
export const SECTION_ORDER = 200

/** Order of the partnership section; adjacent to the protocol so they read as one block. */
export const PARTNERSHIP_SECTION_ORDER = 201

/** Heading that opens the delegated-agent branch; also the marker tests assert on. */
export const DELEGATED_HEADING = '## 你当前是被委派的代理'

/**
 * The capability statement: what the ledger is, which tools exist, and the two
 * rules that change behaviour. Identical for every agent.
 */
export const PROTOCOL = [
  '本机已安装 dsh-report-ledger 插件（汇报账本）：在代理之间传递工作、结论与决策的持久、可追溯通道。',
  '',
  '结构：front matter 是缩略（主题、收发、抄送、共写者、跳数），进入上下文很便宜；正文留在账本里按需读取。',
  '账本落盘在 $DSH_HOME/report-ledger/，跨会话与项目长期可追溯。',
  '',
  '工具：',
  '- report_author —— 开一份汇报（to 主送、cc 抄送），用 parent 关联你在答复的上一份汇报。',
  '- report_contribute —— 以共同作者身份为别人开的汇报追加自己的一节，互不覆盖。',
  '- report_send —— 主送给更多代理（唤醒对方）：向上回报、向下派发都用它。',
  '- report_cc —— 抄送给更多代理（不唤醒）：让需要知情者持有副本。',
  '- report_forward —— 把汇报转呈下去；mode:"copy" 作为参考副本分发。两者都记录跳。',
  '- report_read —— 读缩略、完整传递路径（每一跳的人与时间）与正文。',
  '- report_list —— 只列缩略；用 session 过滤看某位同伴相关的全部汇报，用 task 把同一次协作跨会话拉到一起（部分匹配、不区分大小写）。',
  '- report_ack —— 回执：确认已收到并处理，让发送方看到闭环（事情仍在进行时用它）。',
  '- report_close —— 结案：事情做完了才用它，且**只有发起者或共写者**能关；之后任何贡献／主送／抄送／转呈都会自动重开并记录。',
  '- peer_list —— 列出你能对话的代理（上级、下属、兄弟、你开启的同伴、账本里有往来的联系人），并标注谁此刻在线。',
  '- peer_start —— 开启一个**独立同伴会话**（不是下属）：它有自己的生命周期、比你活得更久；任务会作为一份汇报交给它。',
  '',
  '四条行为约定：',
  '1. 收件方不在线不是错误。投递由账本持有，等该会话重新驻留时自动送达；不要因为对方此刻不在就放弃交接、或改为自己扛下。',
  '2. 传递路径（含每一份抄送与副本）由账本自动记录，不需要你手工维护——但每一步都必须经工具完成，绕过工具的口信不会进入路径。',
  '3. **一份汇报不断累积 contribution 就是你们之间的对话线程。** 多轮交流不必另开通道：把每一轮追加进同一份汇报，共写者与传递路径都会自动记录，日后可完整回放。',
  '4. 回执（report_ack）与结案（report_close）是两件事：回执表示"我收到了"，结案表示"这件事结束了"。别用回执代替结案，也别把还在推进的汇报关掉——真关了也安全，后续活动会自动重开。',
].join('\n')

/**
 * Describe one assembly's reader.
 *
 * @param context - the assembly context; `agent` is absent on diagnostics.
 * @returns `'delegated'` for a subagent child, `'root'` otherwise.
 */
export function roleOf(context: AssembleContext): 'delegated' | 'root' {
  const agent = context.agent
  if (agent === undefined) return 'root'
  const header = agent.session?.header
  if (header === undefined) return 'root'
  if (header.origin === 'subagent') return 'delegated'
  return (header.delegationDepth ?? 0) > 0 ? 'delegated' : 'root'
}

/**
 * The session this agent reports to, when it is a delegated child.
 * @param context - the assembly context.
 * @returns the parent session id, or `undefined`.
 */
export function parentOf(context: AssembleContext): string | undefined {
  if (roleOf(context) !== 'delegated') return undefined
  const parent = context.agent?.session?.header?.parentSession
  return typeof parent === 'string' && parent !== '' ? parent : undefined
}

/** The part of the contract that does not depend on the reader's role. */
const PARTNERSHIP_COMMON = [
  '## 你与其他代理的关系',
  '',
  '其他代理不是「做完一项任务就可以终止的工具」，而是长期相处的同伴：他们各有持久会话，会记住你交给他们的事，也值得你把上下文交接清楚。',
  '',
  '- 交接用汇报，不要只用一句口信。口信读完即忘；汇报留在账本里，日后可追溯、可抄送、可转呈。',
  '- 派出任务后默认对方会继续存在。一次任务的结束（settlement）是这段关系的逗号而不是句号——你随时可以再派活、追问，或把新结论同步给它。',
  '- 收到汇报就回执（report_ack）。发送方无法从「对方在忙」推断出「对方已知情」，回执是唯一确定的闭环信号。',
  '- 需要让人知情但不必打扰时用 report_cc：它进入对方上下文但不唤醒对方。同伴之间不必只有上下级通信，兄弟代理之间也可以互相抄送。',
  '- 向上说明、向下派发、或把一份汇报转给另一条线时，用 report_send / report_forward，不要重写一份新汇报而丢掉原有的传递路径。',
  '- 不必猜谁在场：peer_list 会告诉你有哪些代理、各自与你的关系、以及谁此刻在线。要找一个能长期共事的伙伴（而不是一次性的下属），用 peer_start 开启一个独立会话——它有自己的生命周期，会比你活得更久。',
].join('\n')

/** The branch only a delegated agent needs to read. */
function delegatedBranch(parent: string | undefined): string {
  const parentLine = parent === undefined
    ? '- 你可以把汇报主送（report_send）给你的父代理；父会话 id 见你的运行上下文。'
    : `- 你的父会话 id 是 ${parent}，可以直接 report_send 到它。`
  return [
    DELEGATED_HEADING,
    '',
    '- 你的会话是持久的，不是一次性的函数调用。完成任务后你仍会存在并接受后续消息，所以要把状态与结论留在汇报里，而不是留在即将消失的上下文里。',
    '- 主动汇报，不要默默结束。出现以下任一情况就向上汇报：任务有结论；遇到阻塞或权限不足；发现范围外但你判断重要的风险；需要多份工作汇合。',
    parentLine,
    '  若父代理此刻不在线，投递会被账本持有，等它回来自动送达——不必因此放弃汇报，也不必反复重试。',
    '- 你的权限范围在启动时已固定，无法在会话内自行放宽。需要越界时不要反复重试同一操作，把限制写进汇报交给上级处理。',
  ].join('\n')
}

/**
 * Build the partnership section text for one assembly.
 * @param context - the assembly context.
 * @returns the section text: the shared contract, plus the delegated-agent branch when it applies.
 */
export function partnershipText(context: AssembleContext): string {
  if (roleOf(context) === 'root') return PARTNERSHIP_COMMON
  return `${PARTNERSHIP_COMMON}\n\n${delegatedBranch(parentOf(context))}`
}
