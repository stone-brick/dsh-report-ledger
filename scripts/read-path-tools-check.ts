// A module, not a global script: the sibling checks share the global scope
// otherwise, and `captured`/`check` would collide with another script.
export {}
/**
 * The model-facing half of the read path — the thread renderer on `report_list`.
 *
 * This lives in `test:tools`, not `pnpm test`, for the same reason every other
 * script that imports `src/report/tools.ts` does: the module has a value import of
 * `@deepseek-ai/dsh-tools`, which only the DSH profile provides. The portable
 * `pnpm test` subset must stay runnable on a bare Linux runner with only `yaml`
 * installed. Keeping the service-level thread tests in `read-path-check` and the
 * renderer here is the split that keeps both true.
 *
 * Run: node scripts/read-path-tools-check.ts
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'report-ledger-read-path-tools-'))
process.env.DSH_HOME = root
process.env.DSH_REPORT_LEDGER_ROOT = join(root, 'report-ledger')

const { ReportService } = await import('../src/report/service.ts')
const { registerReportTools } = await import('../src/report/tools.ts')

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

try {
  const service = new ReportService({
    getAgent: () => undefined,
    describe: async (sessionId) => `name-of-${sessionId}`,
  })

  // The same four-report line `read-path-check` builds for the service-level
  // tests: a root, two children and one grandchild.
  const threadRoot = await service.author({ subject: 'thread root', body: 'root body', actor: 'session-a' })
  const lineA = await service.author({
    subject: 'line A', body: 'a', actor: 'session-a', parent: threadRoot.front.report,
  })
  const lineB = await service.author({
    subject: 'line B', body: 'b', actor: 'session-a', parent: threadRoot.front.report,
  })
  const lineADetail = await service.author({
    subject: 'line A detail', body: 'g', actor: 'session-a', parent: lineA.front.report,
  })
  // Kept alive on purpose: the tool renders every child, including line B.
  void lineB

  const captured = new Map<string, { name: string; execute(args: unknown, exec: unknown): Promise<string> }>()
  const fakeCtx = {
    tools: {
      register(definition: unknown): () => void {
        const entry = definition as { name: string; execute(args: unknown, exec: unknown): Promise<string> }
        captured.set(entry.name, entry)
        return () => {}
      },
    },
  }
  registerReportTools(fakeCtx, service, {} as never, { enabled: false } as never)
  const callTool = async (name: string, args: unknown): Promise<string> => {
    const entry = captured.get(name)
    if (entry === undefined) throw new Error(`tool ${name} was not registered`)
    return await entry.execute(args, {} as never)
  }

  const toolTree = await callTool('report_list', { thread: lineADetail.front.report })
  check('report_list renders the line as a tree and marks the requested report',
    toolTree.includes(`thread ${threadRoot.front.report} (4 report(s); requested from ${lineADetail.front.report})`)
    && toolTree.includes('<- requested'), toolTree)
  check('a grandchild is indented by two levels', toolTree.includes(`\n    ${lineADetail.front.report} [`), toolTree)
  check('a thread tree shows the subject and status of each row',
    toolTree.includes('[open] line A') && toolTree.includes('[open] thread root'), toolTree)

  const combined = await callTool('report_list', { thread: threadRoot.front.report, status: 'closed' })
  check('thread= refuses to be combined with a flat filter', combined.includes('selector'), combined)
  const missingThread = await callTool('report_list', { thread: 'R-9999' })
  check('thread= on a missing report names it', missingThread.includes('no report "R-9999"'), missingThread)
  const onRoot = await callTool('report_list', { thread: threadRoot.front.report })
  check('a thread requested from its root needs no "requested from" suffix',
    onRoot.startsWith(`thread ${threadRoot.front.report} (4 report(s))`), onRoot)
} finally {
  try {
    await rm(root, { recursive: true, force: true })
  } catch {
    // A leftover fixture directory is not a finding.
  }
}

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
