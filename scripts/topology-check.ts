// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts.
export {}
/**
 * Deterministic checks for the topology layout.
 *
 * The layout is a plain module precisely so this is possible: "which column a
 * report lands in, where its arrows point, and whether an out-of-tree session
 * gets a column at all" are decisions a reader feels directly, and they are
 * pinned here instead of being inferred from a picture. The view only draws the
 * geometry this module returns.
 *
 * Run: node scripts/topology-check.ts
 */

const { buildTopology, rowCenter, DEFAULT_TOPOLOGY_OPTIONS } = await import('../src/client/topology-model.ts')

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

const at = (n: number): number => 1_700_000_000_000 + n * 1000

/**
 * One report digest.
 *
 * `authors` follows the `from` it is given rather than defaulting to the root:
 * a digest whose co-author list disagrees with its sender is a lie about the
 * ledger, and a fixture that leaks one would make the edge assertions pass while
 * the layout drew an edge nobody sent.
 */
const report = (id: string, over: Record<string, unknown> = {}): never => ({
  report: id,
  subject: `subject ${id}`,
  status: 'open',
  from: 'session-root',
  to: [],
  cc: [],
  created: at(10),
  updated: at(10),
  children: [],
  artifacts: [],
  hops: 1,
  ...over,
  authors: over.authors ?? [over.from ?? 'session-root'],
}) as never

const payload = {
  root: 'session-root',
  generatedAt: at(99),
  sessions: [
    { id: 'session-root', depth: 0, delegated: false, live: true, title: 'root session', createdAt: at(1) },
    { id: 'session-child', depth: 1, delegated: true, live: true, parentId: 'session-root', title: 'child session', createdAt: at(2) },
    { id: 'session-grand', depth: 2, delegated: true, live: false, parentId: 'session-child', title: 'grand session', createdAt: at(3) },
    { id: 'session-peer', depth: 1, delegated: true, live: false, parentId: 'session-root', title: 'peer session', createdAt: at(4) },
  ],
  reports: [],
} as unknown as Parameters<typeof buildTopology>[0]

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------
const bare = buildTopology(payload, [])
check('one column per session', bare.lanes.length === 4, String(bare.lanes.length))
check('columns keep the payload order, which is the subtree DFS order',
  bare.lanes.map((l) => l.id).join() === 'session-root,session-child,session-grand,session-peer')
check('column centres advance by one lane width',
  bare.lanes.every((lane, index) => lane.x === DEFAULT_TOPOLOGY_OPTIONS.gutterWidth + DEFAULT_TOPOLOGY_OPTIONS.laneWidth * (index + 0.5)))
check('the column carries its subtree depth', bare.lanes[2]?.depth === 2)
check('the column carries the resolved title', bare.lanes[0]?.title === 'root session')
check('a payload of in-tree reports needs no external column',
  buildTopology(payload, [report('R-0001', { to: ['session-peer'] })]).lanes.length === 4)

const outsider = buildTopology(payload, [report('R-0002', { from: 'session-outsider', to: ['session-peer'] })])
check('an out-of-tree sender adds exactly one shared external column', outsider.lanes.length === 5)
check('the external column is last and marked', outsider.lanes[4]?.external === true && outsider.lanes[4]?.id === undefined)
check('the in-tree columns stay unmarked', outsider.lanes.slice(0, 4).every((l) => !l.external))

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------
const plotted = [
  report('R-0001', { to: ['session-child'], cc: ['session-peer'], created: at(5) }),
  report('R-0002', { from: 'session-child', to: ['session-root'], parent: 'R-0001', created: at(6) }),
  report('R-0003', { from: 'session-outsider', to: ['session-root'], created: at(7) }),
  report('R-0004', { authors: ['session-root', 'session-grand'], created: at(8) }),
]
const layout = buildTopology(payload, plotted)
check('one node per plotted report', layout.nodes.length === 4, String(layout.nodes.length))
check('node rows follow the order they were given',
  layout.nodes.map((n) => n.report).join() === 'R-0001,R-0002,R-0003,R-0004')
check('a node sits on its author\'s column',
  layout.nodes[1]?.laneIndex === 1 && layout.nodes[1]?.x === layout.lanes[1]?.x)
check('an out-of-tree author lands on the external column',
  layout.nodes[2]?.laneIndex === 4 && layout.nodes[2]?.laneId === undefined)
check('rows stack downward', layout.nodes.every((node, i) => i === 0 || (layout.nodes[i - 1]?.y ?? 0) < node.y))
check('the node centre matches the shared row formula',
  layout.nodes.every((node) => node.y === rowCenter(node.row)))

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------
const of = (kind: string, reportId?: string) =>
  layout.edges.filter((e) => e.kind === kind && (reportId === undefined || e.report === reportId))

const deliveries = of('to')
check('every unique 主送 recipient gets its own edge', deliveries.length === 3, String(deliveries.length))
check('a delivery lands on the recipient column and stays on its own row',
  deliveries.every((e) => e.fromY === e.toY && Math.abs(e.toX - (layout.lanes[e.toLane]?.x ?? -1)) < 0.001))
check('a delivery leaves the authoring node', deliveries.every((e) => Math.abs(e.fromX - (layout.lanes[e.fromLane]?.x ?? -1)) < 0.001))
check('抄送 is a distinct kind', of('cc').length === 1 && of('cc')[0]?.toLane === 3)
check('co-authorship points AT the report', of('author').length === 1 && Math.abs((of('author')[0]?.toX ?? 0) - (layout.nodes[3]?.x ?? -1)) < 0.001)
check('a repeated recipient is drawn once',
  buildTopology(payload, [report('R-0005', { to: ['session-peer', 'session-peer'] })]).edges.length === 1)
check('a report addressed to its own author draws no edge',
  buildTopology(payload, [report('R-0006', { from: 'session-root', to: ['session-root'] })]).edges.length === 0)
check('an unknown recipient lands on the external column and is flagged',
  buildTopology(payload, [report('R-0007', { to: ['session-nobody'] })]).edges.every((e) => e.external && e.toLane === 4))

const threads = of('thread')
check('a plotted parent gets a thread edge to its child', threads.length === 1 && threads[0]?.report === 'R-0002')
check('the thread edge runs downward', (threads[0]?.fromY ?? 0) < (threads[0]?.toY ?? 0))
check('an unplotted parent draws no thread edge',
  buildTopology(payload, [report('R-0002', { from: 'session-child', parent: 'R-9999' })]).edges.length === 0)

// A thread spans rows, so it is routed down a lane boundary instead of across
// whatever sits between its ends. The boundary must therefore never coincide with
// a column centre, or the connector would run through the nodes it is avoiding.
const routed = buildTopology(payload, [
  report('R-0010', { from: 'session-root', created: at(4) }),
  report('R-0011', { from: 'session-peer', parent: 'R-0010', created: at(5) }),
])
const threadOf = (layout: ReturnType<typeof buildTopology>, id: string) =>
  layout.edges.find((e) => e.kind === 'thread' && e.report === id)
const crossLane = threadOf(routed, 'R-0011')
check('a cross-column thread carries a routing boundary', crossLane?.viaX !== undefined)
check('the boundary sits strictly between the two columns',
  (crossLane?.viaX ?? 0) > Math.min(crossLane?.fromX ?? 0, crossLane?.toX ?? 0)
  && (crossLane?.viaX ?? 0) < Math.max(crossLane?.fromX ?? 0, crossLane?.toX ?? 0))
check('the boundary is never on a column centre',
  routed.edges.filter((e) => e.viaX !== undefined).every((e) => routed.lanes.every((l) => l.x !== e.viaX)))
check('a boundary that would leave the drawing is not used',
  routed.edges.filter((e) => e.viaX !== undefined).every((e) => (e.viaX ?? 0) >= 0 && (e.viaX ?? 0) <= routed.width))
check('delivery edges carry no boundary', layout.edges.filter((e) => e.kind !== 'thread').every((e) => e.viaX === undefined))

// ---------------------------------------------------------------------------
// Size, emptiness and determinism
// ---------------------------------------------------------------------------
check('the drawing is as wide as the gutter plus the columns',
  layout.width === DEFAULT_TOPOLOGY_OPTIONS.gutterWidth + DEFAULT_TOPOLOGY_OPTIONS.laneWidth * 5, String(layout.width))
check('the drawing is exactly as tall as the rows it plots',
  layout.height === DEFAULT_TOPOLOGY_OPTIONS.rowHeight * 4)
check('the header height is a hint for the view, not part of the coordinates',
  layout.headerHeight === DEFAULT_TOPOLOGY_OPTIONS.headerHeight
  && layout.nodes.every((node) => node.y < layout.height + 0.001)
  && (layout.nodes[0]?.y ?? -1) === DEFAULT_TOPOLOGY_OPTIONS.rowHeight / 2)
check('an empty plot is zero-sized and finite',
  bare.rows === 0 && bare.nodes.length === 0 && bare.edges.length === 0
  && Number.isFinite(bare.width) && bare.height === 0)
check('every coordinate is finite',
  layout.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))
  && layout.edges.every((e) => [e.fromX, e.fromY, e.toX, e.toY].every(Number.isFinite)))
check('the same input gives byte-identical geometry',
  JSON.stringify(buildTopology(payload, plotted)) === JSON.stringify(layout))
check('geometry overrides are honoured',
  buildTopology(payload, plotted, { rowHeight: 10 }).height === 40)
check('the row formula follows the overrides too', rowCenter(2, { rowHeight: 10 }) === 25)

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
