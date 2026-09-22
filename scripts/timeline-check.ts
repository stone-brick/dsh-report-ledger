/**
 * Deterministic checks for the timeline assembly and the read-only HTTP surface.
 *
 * Both are pure functions of injected data, so the subtree walk, the report
 * filter, the request guard, and every status code can be pinned exactly here —
 * none of it needs a running web server, and the guard in particular is the part
 * that must not be validated by "it worked when I clicked it".
 *
 * Run: node scripts/timeline-check.ts
 */

const { buildSubtree, reportsForSubtree, buildTimeline, withTitles } = await import('../src/report/timeline.ts')
const route = await import('../src/report/route.ts')

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

// ---------------------------------------------------------------------------
// A session tree with an unrelated session, an orphan, and a cycle.
// ---------------------------------------------------------------------------
const at = (n: number): number => 1_700_000_000_000 + n * 1000
const records = [
  { header: { id: 'session-root', createdAt: at(1) }, live: true },
  { header: { id: 'session-a', parentSession: 'session-root', origin: 'subagent', delegationDepth: 1, createdAt: at(2) }, live: true },
  { header: { id: 'session-g', parentSession: 'session-a', delegationDepth: 2, createdAt: at(4) }, live: false },
  { header: { id: 'session-b', parentSession: 'session-root', delegationDepth: 1, createdAt: at(3) }, live: false },
  { header: { id: 'session-other', createdAt: at(0) }, live: false },
  { header: { id: 'session-orphan', parentSession: 'session-missing', createdAt: at(0) }, live: false },
]

const subtree = buildSubtree(records, 'session-root')

check('subtree includes the root', subtree[0]?.id === 'session-root')
check('subtree is DFS pre-order', subtree.map((n) => n.id).join() === 'session-root,session-a,session-g,session-b', subtree.map((n) => n.id).join())
check('depths follow the chain', subtree.map((n) => n.depth).join() === '0,1,2,1', subtree.map((n) => n.depth).join())
check('siblings are ordered by creation time', subtree[1]?.id === 'session-a' && subtree[3]?.id === 'session-b')
check('origin:subagent is marked delegated', subtree[1]?.delegated === true)
check('a depth-only child is marked delegated', subtree[3]?.delegated === true)
check('the root is not delegated', subtree[0]?.delegated === false)
check('liveness is carried through', subtree[0]?.live === true && subtree[2]?.live === false)
check('an unrelated tree never leaks in', !subtree.some((n) => n.id === 'session-other'))
check('an orphaned record never leaks in', !subtree.some((n) => n.id === 'session-orphan'))
check('an unknown root yields nothing', buildSubtree(records, 'session-nope').length === 0)

// A parent/child cycle must terminate instead of hanging the request.
const cycle = [
  { header: { id: 'cyc-x', parentSession: 'cyc-y', createdAt: at(1) } },
  { header: { id: 'cyc-y', parentSession: 'cyc-x', createdAt: at(2) } },
]
const cycled = buildSubtree(cycle, 'cyc-x')
check('a parent/child cycle terminates', cycled.length === 2, cycled.map((n) => n.id).join())

// Titles attach without disturbing the walk.
const titled = withTitles(subtree, new Map([['session-a', 'child title']]))
check('titles attach to the right node', titled[1]?.title === 'child title' && titled[0]?.title === undefined)

// ---------------------------------------------------------------------------
// Report filtering
// ---------------------------------------------------------------------------
const report = (id: string, over: Record<string, unknown> = {}): never => ({
  report: id,
  subject: `subject ${id}`,
  status: 'open',
  from: 'session-outsider',
  to: [],
  cc: [],
  authors: [],
  created: at(1),
  updated: at(1),
  children: [],
  artifacts: [],
  hops: 1,
  ...over,
}) as never

const allReports = [
  report('R-0001', { from: 'session-a', to: ['session-root'], updated: at(5) }),
  report('R-0002', { from: 'session-other', to: ['session-other'], updated: at(9) }),
  report('R-0003', { from: 'session-outsider', cc: ['session-g'], updated: at(7) }),
  report('R-0004', { from: 'session-outsider', authors: ['session-b'], updated: at(6) }),
  report('R-0005', { from: 'session-a', status: 'closed', updated: at(1) }),
]
const kept = reportsForSubtree(allReports, subtree).map((r) => r.report)

check('a report from a subtree member is kept', kept.includes('R-0001'))
check('a report copied into the subtree is kept', kept.includes('R-0003'))
check('a report co-authored inside the subtree is kept', kept.includes('R-0004'))
check('a report from an unrelated tree is dropped', !kept.includes('R-0002'))
check('reports are newest-updated first', kept.join() === 'R-0003,R-0004,R-0001,R-0005', kept.join())
check('a concluded report is still listed', kept.includes('R-0005'))

// ---------------------------------------------------------------------------
// Payload assembly over injected sources
// ---------------------------------------------------------------------------
const payload = await buildTimeline({
  listSessionRecords: async () => records,
  readTitles: async (ids) => new Map(ids.map((id) => [id, `title of ${id}`])),
  listReports: async () => allReports,
}, 'session-root')

check('payload carries the root', payload.root === 'session-root')
check('payload carries the subtree', payload.sessions.length === 4)
check('payload applies titles', payload.sessions[0]?.title === 'title of session-root')
check('payload scopes the reports', payload.reports.length === 4)
check('payload stamps generation time', typeof payload.generatedAt === 'number' && payload.generatedAt > 0)
// The tab styles each status differently, so the endpoint must pass the
// lifecycle state through verbatim rather than normalizing it.
check('a closed report reaches the client as closed',
  payload.reports.find((r) => r.report === 'R-0005')?.status === 'closed',
  String(payload.reports.find((r) => r.report === 'R-0005')?.status))

const unknownPayload = await buildTimeline({
  listSessionRecords: async () => records,
  readTitles: async () => new Map(),
  listReports: async () => allReports,
}, 'session-nope')
check('an unknown root yields an empty timeline', unknownPayload.sessions.length === 0 && unknownPayload.reports.length === 0)

// ---------------------------------------------------------------------------
// The request guard
// ---------------------------------------------------------------------------
check('127.0.0.1 is loopback', route.isLoopbackAddress('127.0.0.1'))
check('::1 is loopback', route.isLoopbackAddress('::1'))
check('::ffff:127.0.0.1 is loopback', route.isLoopbackAddress('::ffff:127.0.0.1'))
check('a LAN address is not loopback', !route.isLoopbackAddress('192.168.1.5'))
check('a public address is not loopback', !route.isLoopbackAddress('203.0.113.9'))
check('a missing address is not loopback', !route.isLoopbackAddress(undefined))
check('localhost is a loopback hostname', route.isLoopbackHostname('localhost'))
check('a rebinding hostname is not loopback', !route.isLoopbackHostname('localhost.attacker.tld'))

interface Fake {
  method?: string
  url?: string
  headers?: Record<string, string | undefined>
  remoteAddress?: string
}

const request = (fake: Fake): never => ({
  method: fake.method ?? 'GET',
  url: fake.url ?? '/',
  headers: fake.headers ?? {},
  socket: { remoteAddress: fake.remoteAddress ?? '127.0.0.1' },
}) as never

const trusted = request({ headers: { host: '127.0.0.1:3080' } })
check('a plain loopback request is trusted', route.isTrustedRequest(trusted))
check('a same-origin loopback request is trusted', route.isTrustedRequest(request({
  headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
})))
check('a remote peer is refused', !route.isTrustedRequest(request({ remoteAddress: '10.1.2.3', headers: { host: '127.0.0.1:3080' } })))
check('a non-loopback Host is refused', !route.isTrustedRequest(request({ headers: { host: 'evil.example:3080' } })))
check('a rebinding Host is refused', !route.isTrustedRequest(request({ headers: { host: 'localhost.attacker.tld' } })))
check('a missing Host is refused', !route.isTrustedRequest(request({})))
check('userinfo in Host is refused', !route.isTrustedRequest(request({ headers: { host: 'a@127.0.0.1:3080' } })))
check('a default port is refused as non-canonical', !route.isTrustedRequest(request({ headers: { host: '127.0.0.1:80' } })))
check('a cross-site fetch is refused', !route.isTrustedRequest(request({
  headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
})))
check('a mismatched Origin is refused', !route.isTrustedRequest(request({
  headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' },
})))

// ---------------------------------------------------------------------------
// The handlers
// ---------------------------------------------------------------------------
interface Capture {
  status: number
  headers: Record<string, unknown>
  body: string
}

const response = (): { captured: Capture; res: never } => {
  const captured: Capture = { status: 0, headers: {}, body: '' }
  return {
    captured,
    res: {
      writeHead(status: number, headers?: Record<string, unknown>) {
        captured.status = status
        Object.assign(captured.headers, headers ?? {})
      },
      end(chunk?: unknown) { if (typeof chunk === 'string') captured.body = chunk },
    } as never,
  }
}

const deps = {
  timeline: async (root: string) => buildTimeline({
    listSessionRecords: async () => records,
    readTitles: async () => new Map(),
    listReports: async () => allReports,
  }, root),
  report: async (id: string) => (id === 'R-0001'
    ? { front: allReports[0], hops: [], pending: ['session-ghost'], body: 'body text', path: '/ledger/R-0001.md' }
    : undefined),
}

const timelineHandler = route.createTimelineHandler(deps)
const reportHandler = route.createReportHandler(deps)

const okCase = response()
await timelineHandler(request({ url: `/api/report-ledger/timeline?root=session-root`, headers: { host: '127.0.0.1:3080' } }), okCase.res)
check('a trusted timeline read answers 200', okCase.captured.status === 200, String(okCase.captured.status))
check('the timeline payload is enveloped', okCase.captured.body.includes('"ok":true') && okCase.captured.body.includes('session-root'))
check('the response is not cacheable', okCase.captured.headers['cache-control'] === 'no-store')

const untrustedCase = response()
await timelineHandler(request({ url: '/api/report-ledger/timeline?root=session-root', remoteAddress: '8.8.8.8', headers: { host: '127.0.0.1:3080' } }), untrustedCase.res)
check('an untrusted request answers 403', untrustedCase.captured.status === 403, String(untrustedCase.captured.status))
check('a refusal reveals nothing', !untrustedCase.captured.body.includes('session-root'))

const postCase = response()
await timelineHandler(request({ method: 'POST', url: '/api/report-ledger/timeline?root=session-root', headers: { host: '127.0.0.1:3080' } }), postCase.res)
check('a non-GET method answers 405', postCase.captured.status === 405, String(postCase.captured.status))
check('405 advertises the allowed methods', postCase.captured.headers.allow === 'GET, HEAD')

for (const badRoot of ['', '../etc/passwd', 'a b', 'x'.repeat(201)]) {
  const bad = response()
  await timelineHandler(request({ url: `/api/report-ledger/timeline?root=${encodeURIComponent(badRoot)}`, headers: { host: '127.0.0.1:3080' } }), bad.res)
  check(`root ${JSON.stringify(badRoot.slice(0, 12))} answers 400`, bad.captured.status === 400, String(bad.captured.status))
}

const goodReport = response()
await reportHandler(request({ url: '/api/report-ledger/report?id=R-0001', headers: { host: '127.0.0.1:3080' } }), goodReport.res)
check('a known report answers 200 with its path and pending set',
  goodReport.captured.status === 200 && goodReport.captured.body.includes('/ledger/R-0001.md') && goodReport.captured.body.includes('session-ghost'))

const missingReport = response()
await reportHandler(request({ url: '/api/report-ledger/report?id=R-0099', headers: { host: '127.0.0.1:3080' } }), missingReport.res)
check('an unknown report answers 404', missingReport.captured.status === 404, String(missingReport.captured.status))

const badId = response()
await reportHandler(request({ url: '/api/report-ledger/report?id=../../etc/passwd', headers: { host: '127.0.0.1:3080' } }), badId.res)
check('a malformed report id answers 400', badId.captured.status === 400, String(badId.captured.status))

// A failing data source must surface as JSON, never as an unhandled rejection.
const brokenHandler = route.createTimelineHandler({
  timeline: async () => { throw new Error('ledger offline') },
  report: async () => undefined,
})
const brokenCase = response()
await brokenHandler(request({ url: '/api/report-ledger/timeline?root=session-root', headers: { host: '127.0.0.1:3080' } }), brokenCase.res)
check('a failing source answers 500 as JSON', brokenCase.captured.status === 500 && brokenCase.captured.body.includes('ledger offline'))

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
