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
  'report_forward', 'report_read', 'report_list', 'report_ack', 'report_close',
  'peer_list', 'peer_start',
]) {
  check(`protocol documents ${tool}`, PROTOCOL.includes(tool))
}

// ---- the lifecycle distinction is stated ---------------------------------
check('protocol separates a receipt from a conclusion', PROTOCOL.includes('是两件事'))
check('protocol restricts closing to owners', PROTOCOL.includes('只有发起者或共写者'))
check('protocol says a closed report reopens on activity', PROTOCOL.includes('自动重开'))

// ---- the conversation framing is stated ----------------------------------
check('protocol frames a co-written report as the conversation thread',
  PROTOCOL.includes('就是你们之间的对话线程'))
check('protocol tells the agent an absent recipient is not a refusal',
  PROTOCOL.includes('收件方不在线不是错误'))
check('protocol says untracked word-of-mouth never enters the path',
  PROTOCOL.includes('绕过工具的口信不会进入路径'))
check('the shared contract points at peer_list instead of guessing',
  rootText.includes('peer_list'))
check('the shared contract frames peer_start as a partner, not a subordinate',
  rootText.includes('会比你活得更久'))

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
