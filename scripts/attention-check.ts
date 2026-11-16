// `export {}` keeps this file a module, like its siblings.
export {}
/**
 * Attention check — the one structured question a report can be waiting on.
 *
 * Runs against a throwaway ledger with no harness. It pins the four properties
 * the feature rests on: the question is derived from the transfer path (so it is
 * auditable), a conclusion withdraws it without erasing the history, any
 * participant may ask or withdraw while a bystander may not, and the digest
 * round-trips through the YAML block the repair pass rewrites.
 *
 * Run: node scripts/attention-check.ts
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'report-ledger-attention-'))
process.env.DSH_HOME = root
process.env.DSH_REPORT_LEDGER_ROOT = join(root, 'report-ledger')

const { ReportService, renderRow } = await import('../src/report/service.ts')
const { readHops, readReport, reportPath } = await import('../src/report/ledger.ts')
const { parseHop, parseReport, serializeReport } = await import('../src/report/frontmatter.ts')

const live = new Set(['session-a', 'session-b', 'session-c'])
const service = new ReportService({
  getAgent(sessionId) {
    if (!live.has(sessionId)) return undefined
    return { id: sessionId, steer: () => undefined, inject: () => undefined }
  },
  describe: async (sessionId) => `name-of-${sessionId}`,
}, { now: () => 1_000_000 })

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

// ---- 1. a participant asks, and the question is a recorded hop -------------
const report = await service.author({ subject: 'choose the shape', body: 'b', actor: 'session-a', to: ['session-b'] })
const asked = await service.attention(report.front.report, 'session-b', {
  question: '  A or B?\n',
  options: ['A', 'B', 'A'],
})
check('the question lands on the digest', asked.front.attention?.question === 'A or B?', JSON.stringify(asked.front.attention))
check('the asker is recorded', asked.front.attention?.by === 'session-b', JSON.stringify(asked.front.attention))
check('options are de-duplicated and ordered', asked.front.attention?.options?.join() === 'A,B',
  JSON.stringify(asked.front.attention?.options))
check('the question is one line', asked.front.attention?.question.includes('\n') === false,
  JSON.stringify(asked.front.attention?.question))
const attentionHop = (await readHops(report.front.report)).find((hop) => hop.action === 'attention')
check('asking is a recorded hop', attentionHop !== undefined)
check('the hop carries the question and options',
  attentionHop?.question === 'A or B?' && attentionHop?.options?.join() === 'A,B', JSON.stringify(attentionHop))

// ---- 2. listing: the row carries it, the filter finds it ------------------
const rows = await service.list()
const row = rows.find((candidate) => candidate.report === report.front.report)
if (row === undefined) throw new Error('attention: the authored report is missing from its own listing')
check('the listing row carries the question', row.attention?.question === 'A or B?', JSON.stringify(row))
check('the rendered row names it', renderRow(row).includes('attention='), renderRow(row))
const waiting = await service.list({ attention: true })
check('the attention filter keeps a waiting report', waiting.some((candidate) => candidate.report === report.front.report))
const quiet = await service.author({ subject: 'no question here', body: 'b', actor: 'session-a' })
check('the attention filter drops a report with no question',
  (await service.list({ attention: true })).every((candidate) => candidate.report !== quiet.front.report))

// ---- 3. withdrawing is an explicit hop, not a rewrite ---------------------
const withdrawn = await service.attention(report.front.report, 'session-a', {})
check('a withdrawal clears the digest', withdrawn.front.attention === undefined)
check('the withdrawal is a hop', (await readHops(report.front.report)).some((hop) => hop.action === 'attention' && hop.question === undefined))
check('the listing no longer shows it', (await service.list({ attention: true })).length === 0)
let emptyWithdrawal = ''
try {
  await service.attention(report.front.report, 'session-a', {})
} catch (error) {
  emptyWithdrawal = error instanceof Error ? error.message : String(error)
}
check('withdrawing nothing is refused', emptyWithdrawal.includes('no open question'), emptyWithdrawal)

// ---- 4. closing withdraws; asking again reopens ---------------------------
await service.attention(report.front.report, 'session-b', { question: 'still want this?' })
await service.close(report.front.report, 'session-a', 'done for now')
const closed = await readReport(report.front.report)
check('closing withdraws the question', closed?.front.attention === undefined, JSON.stringify(closed?.front.attention))
check('the report is closed', closed?.front.status === 'closed', closed?.front.status)
check('the question stays in the path',
  (await readHops(report.front.report)).some((hop) => hop.action === 'attention' && hop.question === 'still want this?'))
const reopened = await service.attention(report.front.report, 'session-b', { question: 'one more thing?' })
check('asking on a closed report reopens it', reopened.front.status === 'open', reopened.front.status)
check('the new question is live', reopened.front.attention?.question === 'one more thing?')
check('the reopen is recorded before the question',
  (await readHops(report.front.report)).slice(-2).map((hop) => hop.action).join() === 'reopened,attention',
  (await readHops(report.front.report)).slice(-2).map((hop) => hop.action).join())

// ---- 5. permission and validation -----------------------------------------
let bystander = ''
try {
  await service.attention(report.front.report, 'session-ghost', { question: 'may I?' })
} catch (error) {
  bystander = error instanceof Error ? error.message : String(error)
}
check('a bystander may not ask', bystander.includes("participant's act"), bystander)
check('the refusal names the participants', bystander.includes('session-a'), bystander)

let tooMany = ''
try {
  await service.attention(report.front.report, 'session-a', {
    question: 'which?',
    options: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
  })
} catch (error) {
  tooMany = error instanceof Error ? error.message : String(error)
}
check('too many options are refused', tooMany.includes('at most 8'), tooMany)

let optionsAlone = ''
try {
  await service.attention(report.front.report, 'session-a', { options: ['A'] })
} catch (error) {
  optionsAlone = error instanceof Error ? error.message : String(error)
}
check('options without a question are refused', optionsAlone.includes('need a question'), optionsAlone)

let tooLong = ''
try {
  await service.attention(report.front.report, 'session-a', { question: 'q'.repeat(501) })
} catch (error) {
  tooLong = error instanceof Error ? error.message : String(error)
}
check('an oversized question is refused', tooLong.includes('500 characters'), tooLong)

// ---- 6. the digest round-trips through YAML, and a broken block is dropped -
const document = await readFile(reportPath(report.front.report), 'utf8')
check('the document carries an attention block', document.includes('attention:'), document.slice(0, 200))
const parsed = parseReport(document)
check('the attention block parses back', parsed?.front.attention?.question === 'one more thing?', JSON.stringify(parsed?.front.attention))
const noQuestion = parseReport('---\nreport: R-9999\nsubject: s\nattention:\n  by: someone\n  at: 5\n---\n\nbody\n')
check('a block without a question is dropped', noQuestion?.front.attention === undefined, JSON.stringify(noQuestion?.front.attention))

// ---- 7. the hop codec keeps the question and its options ------------------
const decoded = parseHop(JSON.stringify({ at: 1, actor: 's', action: 'attention', to: [], question: 'q?', options: ['x'] }))
check('a hop keeps its question', decoded?.question === 'q?', JSON.stringify(decoded))
check('a hop keeps its options', decoded?.options?.join() === 'x', JSON.stringify(decoded))

// ---- 8. the repair pass treats a missing question as drift ----------------
const stored = await readReport(report.front.report)
await writeFile(reportPath(report.front.report), serializeReport({
  front: { ...stored!.front, attention: undefined },
  body: stored!.body,
}))
const dry = await service.repairDigests({ dryRun: true, report: report.front.report })
const drift = dry.find((repair) => repair.report === report.front.report)
check('a dropped attention is reported as drift', drift?.changed === true, JSON.stringify(drift))
check('the derived projection names the question', (drift?.derived ?? '').includes('attention=one more thing?'),
  drift?.derived ?? '')
await service.repairDigests({ report: report.front.report })
check('repair restores the question', (await readReport(report.front.report))?.front.attention?.question === 'one more thing?')

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)

await rm(root, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
