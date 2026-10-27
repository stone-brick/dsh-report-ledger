// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts and `filter` silently resolves to the DOM's window.filter.
// Emitted as nothing; it exists so `tsc` treats the file as its own module.
export {}
/**
 * Deterministic checks for the role-aware prompt sections.
 *
 * Role detection decides whether a delegated agent learns it is a long-lived
 * partner and receives its parent's session id — the piece that makes upward
 * reporting possible at all. It is a pure function of the session header, so it
 * can be pinned exactly here rather than inferred from a model's self-report.
 *
 * Run: node scripts/guidance-check.ts
 */

const {
  PROTOCOL,
  DELEGATED_HEADING,
  partnershipText,
  roleOf,
  parentOf,
} = await import('../src/report/guidance.ts')

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

/** Build a fake assembly context whose only meaningful field is the session header. */
const ctxWith = (header: Record<string, unknown> | undefined): never =>
  ({ agent: header === undefined ? { session: undefined } : { session: { header } } }) as never

const root = ctxWith({ delegationDepth: 0 })
const child = ctxWith({ origin: 'subagent', delegationDepth: 1, parentSession: 'session-parent' })
const childByDepth = ctxWith({ delegationDepth: 2, parentSession: 'session-grandparent' })
const orphanChild = ctxWith({ origin: 'subagent', delegationDepth: 1 })
const noAgent = ({}) as never
const noSession = ctxWith(undefined)

const rootText = partnershipText(root)
const childText = partnershipText(child)

// ---- the protocol names every tool ---------------------------------------
for (const tool of [
  'report_author', 'report_contribute', 'report_send', 'report_cc',
  'report_forward', 'report_read', 'report_list', 'report_ack', 'report_amend', 'report_close',
  'report_release', 'report_lease', 'report_transfer', 'report_handover',
  'peer_list', 'peer_start', 'peer_wake',
]) {
  check(`protocol documents ${tool}`, PROTOCOL.includes(tool))
}

// ---- the working-tree contract is stated, including what is NOT isolated --
check('protocol names the worktree option', PROTOCOL.includes('worktree:true'))
check('protocol says only the directory and index are private',
  PROTOCOL.includes('工作目录与索引'))
check('protocol warns that hooks and config are shared', PROTOCOL.includes('装一个 hook 或改一项配置'))
check('protocol frames the branch as a lock', PROTOCOL.includes('只能被一个检出占用'))
check('protocol says closing releases the claim', PROTOCOL.includes('结案会自动交还'))
check('protocol states both directions of the claim', PROTOCOL.includes('认领已有检出') && PROTOCOL.includes('交还'))

// ---- the correction rule is stated ---------------------------------------
check('protocol points at report_amend instead of re-authoring', PROTOCOL.includes('不要重开一份新汇报'))
check('protocol says only owners may amend', PROTOCOL.includes('只有发起者或共写者'))
check('protocol distinguishes append from replace for the body', PROTOCOL.includes('replace_body'))
check('protocol tells the agent not to fear leaving a correction trail', PROTOCOL.includes('别怕留痕'))
// The one activity a reader of the close line would otherwise miss: an amendment
// reopens a concluded report exactly like a contribution does, and a caller that
// only retitled a report left it open without being told.
check('protocol says an amendment reopens a closed report', PROTOCOL.includes('只改摘要字段'))
check('protocol says a reopened report must be concluded again', PROTOCOL.includes('路径上多一条 reopened'))

// ---- the lifecycle distinction is stated ---------------------------------
check('protocol separates a receipt from a conclusion', PROTOCOL.includes('是两件事'))
check('protocol restricts closing to owners', PROTOCOL.includes('只有发起者或共写者'))
check('protocol says a closed report reopens on activity', PROTOCOL.includes('自动重开'))
// The close line enumerates what reopens a report; an omission there is what
// makes a retitled-but-reopened report invisible to a reader who trusted it.
check('protocol lists an amendment among the activities that reopen', PROTOCOL.includes('转呈／修正'))
// Closing without accounting for the work is the failure mode a zero-contribution
// conclusion hides; the requirement is stated here so it travels with the tool.
check('protocol requires a closing note to account for the work',
  PROTOCOL.includes('结案时在 note 里交代'))
// The requirement is enforced by report_close, so the protocol has to say so: a
// model that learns about the refusal after the fact has already spent a round.
check('protocol says a silent zero-contribution close is refused',
  PROTOCOL.includes('这种结案会被直接拒绝'))

// ---- the conversation framing is stated ----------------------------------
check('protocol frames a co-written report as the conversation thread',
  PROTOCOL.includes('就是你们之间的对话线程'))
// Two shapes are legitimate — accumulate into one report, or a tree of reports
// linked by parent — and a protocol that recommends both without a rule leaves
// the choice to chance.
check('protocol gives the thread-versus-tree decision rule', PROTOCOL.includes('跨阶段的里程碑'))
check('protocol gives a contribution granularity', PROTOCOL.includes('每完成一个可验收项'))
check('protocol tells the agent an absent recipient is not a refusal',
  PROTOCOL.includes('收件方不在线不是错误'))
// A wake is the one capability that can end the wait, so the protocol has to say
// who holds it and what makes it worth doing. The old text promised the opposite —
// that no tool could bring an absent session back — which is now false.
check('protocol says only the starter can wake a peer',
  PROTOCOL.includes('只有开启它的会话能用 peer_wake'))
check('protocol says a wake is only meaningful while the ledger owes it something',
  PROTOCOL.includes('仅当账本还欠它投递'))
check('protocol names who else can make it resident again', PROTOCOL.includes('人或宿主把它恢复'))
check('protocol says a wake spends no peer budget', PROTOCOL.includes('不占同伴名额'))
check('protocol says peer_start cannot recall an existing session',
  PROTOCOL.includes('唤不回已存在的会话'))
check('protocol says an absent recipient means smaller scope or a takeover',
  PROTOCOL.includes('切到一轮能交付'))
check('protocol says untracked word-of-mouth never enters the path',
  PROTOCOL.includes('绕过工具的口信不会进入路径'))
check('protocol announces six behavior conventions', PROTOCOL.includes('六条行为约定'))
check('protocol says to reconcile after an interruption', PROTOCOL.includes('先对账再继续'))
check('protocol says not to redo completed work', PROTOCOL.includes('不要从头重做'))
check('protocol says to verify a retried action already landed', PROTOCOL.includes('是否已经落地'))
check('the shared contract points at peer_list instead of guessing',
  rootText.includes('peer_list'))
check('the shared contract frames peer_start as a partner, not a subordinate',
  rootText.includes('会比你活得更久'))

// ---- the worktree tools are deployment-dependent --------------------------
// The protocol is a static prefix and cannot be gated per deployment, so the
// per-assembly partnership section says what a worktree-off deployment implies.
check('the contract says the worktree tools are deployment-dependent', rootText.includes('部署相关'))
check('the contract says report_lease may not exist', rootText.includes('report_lease') && rootText.includes('根本不存在'))
check('the contract says report_release may have nothing to release', rootText.includes('没有对象可交还'))

// ---- the partnership contract states the requirement, unconditionally -----
check('partnership rejects the one-shot-tool framing', rootText.includes('不是「做完一项任务就可以终止的工具」'))
check('partnership says a settled task is not the end of the relationship', rootText.includes('逗号而不是句号'))

// ---- role detection -------------------------------------------------------
check('no assembly agent resolves to root', roleOf(noAgent) === 'root')
check('an agent with no session resolves to root', roleOf(noSession) === 'root')
check('a top-level agent resolves to root', roleOf(root) === 'root')
check('origin:subagent resolves to delegated', roleOf(child) === 'delegated')
check('a non-zero depth alone resolves to delegated', roleOf(childByDepth) === 'delegated')

// ---- the branch itself ----------------------------------------------------
check('a root agent never sees the delegated heading', !rootText.includes(DELEGATED_HEADING))
check('a delegated agent sees the delegated heading', childText.includes(DELEGATED_HEADING))
check('a delegated agent is told its session is durable', childText.includes('你的会话是持久的'))
check('a delegated agent is told to report proactively', childText.includes('主动汇报，不要默默结束'))
check('depth-only child is detected too', partnershipText(childByDepth).includes(DELEGATED_HEADING))

// ---- the parent session id is actually delivered --------------------------
check('the parent session id reaches the child', childText.includes('session-parent'))
check('the depth-only child gets its parent id', partnershipText(childByDepth).includes('session-grandparent'))
check('a child without a recorded parent degrades to a pointer', parentOf(orphanChild) === undefined
  && partnershipText(orphanChild).includes('父会话 id 见你的运行上下文'))
check('root agent is never given a parent id', parentOf(root) === undefined)

// ---- prefix stability: the shared block must be byte-identical ------------
check('the shared contract is a prefix of the delegated text', childText.startsWith(partnershipText(root)))

// ---- no templating or coercion leaks -------------------------------------
for (const [label, text] of [['protocol', PROTOCOL], ['root partnership', rootText], ['child partnership', childText]] as [string, string][]) {
  check(`${label} has no unresolved placeholder`, !text.includes('{{'))
  check(`${label} has no coerced undefined`, !text.includes('undefined'))
}

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
