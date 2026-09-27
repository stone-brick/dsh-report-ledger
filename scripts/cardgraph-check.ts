// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts.
export {}
/**
 * Deterministic checks for the card canvas's layout.
 *
 * Step one of the rewrite: the geometry is settled and pinned **before** any
 * canvas code exists, because every claim the design makes is a claim about
 * numbers — which frame holds which card, which side a wire leaves on, where two
 * wires landing on one frame edge end up, and what a viewport can see. A painter
 * can be wrong in a browser and be fixed in a browser; a layout that is wrong is
 * wrong everywhere, so it is tested here.
 *
 * Run: node scripts/cardgraph-check.ts
 */

const {
  buildCardgraph, lodFor, cardSize, CARDGRAPH_LODS,
  intersects, contains, grow, cullByBounds, hitTest, worldViewport,
  DEFAULT_CARDGRAPH_OPTIONS,
} = await import('../src/client/cardgraph-model.ts')

/** One report digest, as the layout consumes it. */
type Front = Parameters<typeof buildCardgraph>[1][number]

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

const at = (n: number): number => 1_700_000_000_000 + n * 1000

/**
 * One report digest.
 *
 * `authors` follows the `from` it is given rather than defaulting to the root, for
 * the reason the swimlane's fixture learned the hard way: a digest whose
 * co-author list disagrees with its sender is a lie about the ledger, and a
 * fixture that leaks one makes the wire assertions pass while the drawing shows a
 * co-author nobody had.
 */
const report = (id: string, over: Record<string, unknown> = {}): Front => ({
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
  authors: (over.authors as readonly string[] | undefined) ?? [(over.from as string | undefined) ?? 'session-root'],
}) as Front

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
} as unknown as Parameters<typeof buildCardgraph>[0]

// ---------------------------------------------------------------------------
// Tier and sizes
// ---------------------------------------------------------------------------
check('a full zoom is a full card', lodFor(1) === 'card')
check('the card threshold is inclusive', lodFor(0.8) === 'card')
check('just under the card threshold is a compact card', lodFor(0.79) === 'compact')
check('the compact threshold is inclusive', lodFor(0.4) === 'compact')
check('under the compact threshold is a chip', lodFor(0.39) === 'chip')
check('a zero zoom is a chip, not a card', lodFor(0) === 'chip')
check('a zoom that is not a number degrades to a chip', lodFor(Number.NaN) === 'chip')
check('the thresholds are overridable', lodFor(2, { cardMinZoom: 3, compactMinZoom: 1 }) === 'compact')
check('the tiers are listed richest first', CARDGRAPH_LODS.join() === 'card,compact,chip')
check('a full card is the size the constant says', cardSize('card').width === 240 && cardSize('card').height === 110)
check('a compact card is the size the constant says', cardSize('compact').width === 160 && cardSize('compact').height === 36)
check('a chip is the size the constant says', cardSize('chip').width === 60 && cardSize('chip').height === 14)

// The rule the whole design rests on: nothing is measured, so text length cannot
// move anything. If this ever fails, the layout has started depending on a canvas
// context and every other assertion here becomes a browser-only claim.
const wordy = buildCardgraph(payload, [report('R-0001', {
  subject: 'x'.repeat(400),
  artifacts: Array.from({ length: 30 }, (_unused, index) => `artifacts/path/${index}`),
})])
const justCard = buildCardgraph(payload, [report('R-0001')])
check('a card is the same size however long its text is',
  JSON.stringify(wordy.cards[0]?.bounds) === JSON.stringify(justCard.cards[0]?.bounds))
check('the tier decides the size of every card',
  buildCardgraph(payload, [report('R-0001')], { lod: 'compact' }).cardWidth === 160)

// ---------------------------------------------------------------------------
// Frames and columns
// ---------------------------------------------------------------------------
const plotted = [
  report('R-0001', { to: ['session-child'], cc: ['session-peer'], created: at(5) }),
  report('R-0002', { from: 'session-child', to: ['session-root'], parent: 'R-0001', created: at(6) }),
  report('R-0003', { from: 'session-grand', to: ['session-root'], created: at(7) }),
  report('R-0004', { from: 'session-peer', cc: ['session-child'], created: at(8) }),
]
const layout = buildCardgraph(payload, plotted)

check('one frame per session', layout.frames.length === 4, String(layout.frames.length))
check('frames keep the payload order, which is the subtree DFS order',
  layout.frames.map((frame) => frame.id).join() === 'session-root,session-child,session-grand,session-peer')
check('a frame\'s column is its subtree depth', layout.frames.map((frame) => frame.column).join() === '0,1,2,1')
check('a child\'s frame is in a column right of its parent\'s',
  layout.frames.every((frame) => {
    const parent = payload.sessions.find((node) => node.id === frame.id)?.parentId
    return parent === undefined || (layout.frames.find((other) => other.id === parent)?.column ?? -1) < frame.column
  }))
check('every frame is the same width, so the columns line up',
  new Set(layout.frames.map((frame) => frame.bounds.width)).size === 1)
check('a frame is wide enough for a card plus its padding',
  layout.frames.every((frame) => frame.bounds.width >= DEFAULT_CARDGRAPH_OPTIONS.sizes.card.width + 12 * 2))
check('the frame width never falls below the minimum',
  buildCardgraph(payload, plotted, { lod: 'chip' }).frameWidth === 180)
check('the first column starts at the margin', layout.columns[0]?.bounds.x === 24)
check('a column advances by the frame width plus the gap',
  (layout.columns[1]?.bounds.x ?? 0) - (layout.columns[0]?.bounds.x ?? 0) === layout.frameWidth + 48)
check('the drawing is as wide as its columns and margins',
  layout.width === 24 * 2 + 3 * layout.frameWidth + 2 * 48)
check('the drawing is as tall as its tallest column',
  layout.height === 24 * 2 + ((layout.frames[1]?.bounds.height ?? 0) * 2 + 24))
check('two frames in one column are one frame gap apart',
  (layout.frames[3]?.bounds.y ?? 0) - ((layout.frames[1]?.bounds.y ?? 0) + (layout.frames[1]?.bounds.height ?? 0)) === 24)
check('geometry overrides are honoured', (() => {
  const wide = buildCardgraph(payload, [report('R-0200')], { margin: 100, columnGap: 10 })
  return wide.columns[0]?.bounds.x === 100
    && (wide.columns[1]?.bounds.x ?? 0) - (wide.columns[0]?.bounds.x ?? 0) === wide.frameWidth + 10
})())

const bare = buildCardgraph(payload, [])
check('an empty drawing still frames every session',
  bare.frames.length === 4 && bare.cards.length === 0 && bare.edges.length === 0)
check('a frame with no cards is still the minimum height',
  bare.frames.every((frame) => frame.bounds.height === DEFAULT_CARDGRAPH_OPTIONS.minFrameHeight))
check('frame height is the title bar, the padding and the stack',
  layout.frames[0]?.bounds.height === 26 + 10 + 110 + 12)
check('a second card makes the frame taller by a card and a gap',
  buildCardgraph(payload, [report('R-0010', { created: at(5) }), report('R-0011', { created: at(6) })])
    .frames[0]?.bounds.height === 26 + 10 + 110 * 2 + 8 + 12)

const outside = buildCardgraph(payload, [report('R-0020', { from: 'session-outsider', to: ['session-root'] })])
check('an out-of-tree sender adds exactly one shared frame', outside.frames.length === 5)
check('the shared frame is last and marked', outside.frames[4]?.external === true && outside.frames[4]?.id === undefined)
check('the shared frame gets a column of its own, right of every session', outside.frames[4]?.column === 3)
check('frames inside the tree stay unmarked', outside.frames.slice(0, 4).every((frame) => !frame.external))
check('a payload whose reports never leave the tree has no shared frame',
  layout.frames.every((frame) => !frame.external))

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------
const nothing = buildCardgraph({ root: 'nobody', generatedAt: 0, sessions: [], reports: [] } as never, [])
check('an empty payload draws nothing, and stays finite',
  nothing.frames.length === 0 && nothing.width === 0 && nothing.height === 0 && Number.isFinite(nothing.height))
check('one card per plotted report',
  layout.cards.map((card) => card.report).join() === 'R-0001,R-0002,R-0003,R-0004')
check('every card carries the tier it was laid out at', layout.cards.every((card) => card.lod === 'card'))
check('a card belongs to its author\'s frame',
  layout.cards.every((card) => layout.frames[card.frame]?.id === plotted.find((front) => front.report === card.report)?.from))
check('a card sits below its frame\'s title bar',
  layout.cards.every((card) => card.bounds.y >= (layout.frames[card.frame]?.bounds.y ?? 0) + DEFAULT_CARDGRAPH_OPTIONS.frameHeaderHeight))
check('every card is inside its own frame', layout.cards.every((card) => {
  const frame = layout.frames[card.frame]?.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
  return card.bounds.x >= frame.x && card.bounds.y >= frame.y
    && card.bounds.x + card.bounds.width <= frame.x + frame.width
    && card.bounds.y + card.bounds.height <= frame.y + frame.height
}))
check('every coordinate is finite',
  [...layout.frames, ...layout.cards].every((item) => Object.values(item.bounds).every((value) => Number.isFinite(value)))
    && layout.edges.every((edge) => Number.isFinite(edge.bounds.width) && Number.isFinite(edge.from.x) && Number.isFinite(edge.to.y)))

// Stacking is per frame and by time, because a frame is one session's own
// timeline. The input order must not matter.
const outOfOrder = buildCardgraph(payload, [
  report('R-0031', { from: 'session-child', created: at(9) }),
  report('R-0032', { from: 'session-child', created: at(7) }),
  report('R-0033', { from: 'session-child', created: at(8) }),
])
const stacked = outOfOrder.cards.filter((card) => card.frame === 1)
check('cards are stacked by time inside their frame, whatever order they arrive in',
  stacked.map((card) => card.report).join() === 'R-0032,R-0033,R-0031')
check('stacked cards are one card plus the gap apart',
  (stacked[1]?.bounds.y ?? 0) - (stacked[0]?.bounds.y ?? 0) === 118
    && (stacked[2]?.bounds.y ?? 0) - (stacked[1]?.bounds.y ?? 0) === 118)
check('cards in one frame never overlap', stacked.every((card, index) => {
  const next = stacked[index + 1]
  return next === undefined || card.bounds.y + card.bounds.height <= next.bounds.y
}))
check('two reports created in the same millisecond are ordered by id',
  buildCardgraph(payload, [
    report('R-0042', { from: 'session-child', created: at(5) }),
    report('R-0041', { from: 'session-child', created: at(5) }),
  ]).cards.filter((card) => card.frame === 1).map((card) => card.report).join() === 'R-0041,R-0042')
check('an out-of-tree author\'s card lands in the shared frame', outside.cards[0]?.frame === 4)
check('the same ledger draws the same picture, in any input order',
  JSON.stringify(buildCardgraph(payload, plotted)) === JSON.stringify(buildCardgraph(payload, [...plotted].reverse())))

// ---------------------------------------------------------------------------
// Wires: deliveries
// ---------------------------------------------------------------------------
const delivery = layout.edges.find((edge) => edge.report === 'R-0001' && edge.kind === 'to')
check('a delivery leaves the sender\'s card', delivery?.from.kind === 'card' && delivery?.from.id === 'R-0001')
check('a delivery lands on the recipient\'s frame',
  delivery?.to.kind === 'frame' && delivery?.to.id === 'session-child')
check('a delivery leaves on the side the recipient is on, and lands facing back',
  delivery?.from.side === 'right' && delivery?.to.side === 'left')
check('a copy is drawn as a copy',
  layout.edges.find((edge) => edge.report === 'R-0001' && edge.kind === 'cc')?.to.id === 'session-peer')
const reply = layout.edges.find((edge) => edge.report === 'R-0002' && edge.kind === 'to')
check('a reply exits to the left and lands on the right of its parent',
  reply?.from.side === 'left' && reply?.to.side === 'right')
check('a report delivered to its own session draws nothing',
  buildCardgraph(payload, [report('R-0050', { to: ['session-root'] })]).edges.length === 0)
check('the same recipient twice draws one wire',
  buildCardgraph(payload, [report('R-0051', { to: ['session-peer', 'session-peer'] })])
    .edges.filter((edge) => edge.kind === 'to').length === 1)
check('a wire that touches the shared frame is marked external', outside.edges.every((edge) => edge.external))
check('a wire between two frames inside the tree is not marked', layout.edges.every((edge) => !edge.external))

// Two sibling frames share a column, so a straight left-to-right wire from one to
// the other would run back across the recipient's own box — reading as a wire
// that belongs to the frame it merely passes. Those wires take the gutter.
const sibling = layout.edges.find((edge) => edge.report === 'R-0004' && edge.kind === 'cc')
check('a delivery between two sessions in one column bends through the gutter',
  sibling?.viaX === (layout.columns[1]?.bounds.x ?? 0) + layout.frameWidth + 24)
check('a same-column wire leaves and lands on the same side',
  sibling?.from.side === 'right' && sibling?.to.side === 'right')
check('a same-column wire only crosses the gutter on its way in',
  sibling !== undefined && sibling.viaX !== undefined && Math.abs(sibling.to.x - sibling.viaX) <= 24)

const siblingAuthor = buildCardgraph(payload, [
  report('R-0110', { from: 'session-child', authors: ['session-child', 'session-peer'] }),
])
const sideways = siblingAuthor.edges.find((edge) => edge.kind === 'author')
check('a co-author in a sibling frame also comes in through the gutter',
  sideways?.viaX === (siblingAuthor.columns[1]?.bounds.x ?? 0) + siblingAuthor.frameWidth + 24
    && sideways?.from.side === 'right' && sideways?.to.side === 'right')

// Two wires sharing one frame edge must not land on the same pixel, and their
// order must follow the far ends so they do not cross each other at the port.
const ports = buildCardgraph(payload, [
  report('R-0060', { to: ['session-peer'], created: at(5) }),
  report('R-0061', { to: ['session-peer'], created: at(6) }),
])
const arrivals = ports.edges.filter((edge) => edge.kind === 'to')
check('two wires landing on one frame edge get different ports',
  arrivals[0]?.to.y !== arrivals[1]?.to.y, JSON.stringify(arrivals.map((edge) => edge.to.y)))
check('the higher source lands on the higher port',
  (arrivals[0]?.from.y ?? 0) < (arrivals[1]?.from.y ?? 0) && (arrivals[0]?.to.y ?? 0) < (arrivals[1]?.to.y ?? 0))
check('ports sit inside the frame\'s card band', (() => {
  const frame = ports.frames[3]?.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
  const top = frame.y + 26 + 10
  const bottom = frame.y + frame.height - 12
  return ports.edges.filter((edge) => edge.to.kind === 'frame').every((edge) => edge.to.y > top && edge.to.y < bottom)
})())

// ---------------------------------------------------------------------------
// Wires: co-authorship and threads
// ---------------------------------------------------------------------------
const shared = buildCardgraph(payload, [
  report('R-0070', { from: 'session-root', authors: ['session-root', 'session-grand'], to: ['session-peer'] }),
])
const reaching = shared.edges.find((edge) => edge.kind === 'author')
check('a co-author reaches the card from their own frame',
  reaching?.from.kind === 'frame' && reaching?.from.id === 'session-grand'
    && reaching?.to.kind === 'card' && reaching?.to.id === 'R-0070')
check('a co-author wire leaves the co-author\'s side and lands on the card\'s',
  reaching?.from.side === 'left' && reaching?.to.side === 'right')
check('the sender is not also drawn as a co-author',
  shared.edges.filter((edge) => edge.kind === 'author').length === 1)

const thread = layout.edges.find((edge) => edge.kind === 'thread')
check('a thread starts at the parent card\'s bottom',
  thread?.from.kind === 'card' && thread?.from.id === 'R-0001' && thread?.from.side === 'bottom')
check('a thread ends at the child card\'s top',
  thread?.to.kind === 'card' && thread?.to.id === 'R-0002' && thread?.to.side === 'top')
check('a thread\'s ends are on the cards\' edges', (() => {
  const parent = layout.cards.find((card) => card.report === 'R-0001')?.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
  const child = layout.cards.find((card) => card.report === 'R-0002')?.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
  return thread?.from.y === parent.y + parent.height && thread?.from.x === parent.x + parent.width / 2
    && thread?.to.y === child.y && thread?.to.x === child.x + child.width / 2
})())
check('a thread with an unplotted parent is not drawn',
  buildCardgraph(payload, [report('R-0080', { parent: 'R-9999' })]).edges.every((edge) => edge.kind !== 'thread'))
check('a report cannot thread to itself',
  buildCardgraph(payload, [report('R-0081', { parent: 'R-0081' })]).edges.every((edge) => edge.kind !== 'thread'))
check('a thread bends down the gutter beside its parent\'s column',
  thread?.viaX === (layout.columns[0]?.bounds.x ?? 0) + layout.frameWidth + 24)
check('the gutter is never inside a frame',
  layout.edges.filter((edge) => edge.viaX !== undefined).every((edge) =>
    layout.frames.every((frame) => !((edge.viaX as number) >= frame.bounds.x && (edge.viaX as number) <= frame.bounds.x + frame.bounds.width))))
check('a wire\'s box contains the gutter it bends through',
  thread !== undefined && thread.viaX !== undefined
    && thread.bounds.x <= thread.viaX && thread.viaX <= thread.bounds.x + thread.bounds.width)
check('every gutter is inside the drawing',
  layout.edges.every((edge) => edge.viaX === undefined || (edge.viaX > 0 && edge.viaX < layout.width)))

const sameColumn = buildCardgraph(payload, [
  report('R-0090', { from: 'session-peer', created: at(5) }),
  report('R-0091', { from: 'session-peer', parent: 'R-0090', created: at(6) }),
])
const loop = sameColumn.edges.find((edge) => edge.kind === 'thread')
check('a thread inside one column loops out to the right',
  loop?.viaX === (sameColumn.columns[1]?.bounds.x ?? 0) + sameColumn.frameWidth + 24)

const lastPayload = {
  ...payload,
  sessions: [...payload.sessions, {
    id: 'session-grand2', depth: 2, delegated: true, live: false,
    parentId: 'session-child', title: 'grand two', createdAt: at(5),
  }],
}
const lastColumn = buildCardgraph(lastPayload, [
  report('R-0100', { from: 'session-grand', created: at(5) }),
  report('R-0101', { from: 'session-grand2', parent: 'R-0100', created: at(6) }),
])
check('a thread in the last column loops out to the left instead',
  lastColumn.edges.find((edge) => edge.kind === 'thread')?.viaX
    === (lastColumn.columns[2]?.bounds.x ?? 0) - 24)

// ---------------------------------------------------------------------------
// Culling, viewport and picking
// ---------------------------------------------------------------------------
const box = { x: 0, y: 0, width: 10, height: 10 }
const overlap = { x: 5, y: 5, width: 10, height: 10 }
const distant = { x: 40, y: 40, width: 10, height: 10 }
check('overlapping rectangles intersect', intersects(box, overlap))
check('distant rectangles do not', !intersects(box, distant))
check('touching edges do not count as overlapping', !intersects(box, { x: 10, y: 0, width: 10, height: 10 }))
check('a point inside is contained', contains(box, 0, 0) && contains(box, 9.9, 9.9))
check('the far corner is outside', !contains(box, 10, 10))
check('growing a rectangle takes it out by the same amount on every side',
  grow(box, 4).x === -4 && grow(box, 4).width === 18 && grow(box, 4).height === 18)
// Culling takes anything with a `bounds`, which is what lets one function serve
// cards, frames and wires alike — so the fixture has to be shaped that way too.
const wrapped = [{ bounds: box }, { bounds: distant }]
check('culling drops what the viewport does not reach', cullByBounds(wrapped, box).length === 1)
check('culling keeps what merely straddles the viewport', cullByBounds([{ bounds: overlap }], box).length === 1)

// The lesson the swimlane's row window paid for: a connector whose ends are both
// off-screen is still visible when its middle crosses the viewport, and dropping
// it makes a wire appear out of nowhere mid-scroll.
const tall = buildCardgraph(payload, Array.from({ length: 12 }, (_unused, index) =>
  report(`R-${200 + index}`, {
    from: 'session-child',
    created: at(100 + index),
    ...(index === 11 ? { parent: 'R-200' } : {}),
  })))
const spanning = tall.edges.find((edge) => edge.kind === 'thread')
const topCard = tall.cards.find((card) => card.report === 'R-200')?.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
const bottomCard = tall.cards.find((card) => card.report === 'R-211')?.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
const between = {
  x: spanning?.bounds.x ?? 0,
  y: (topCard.y + bottomCard.y) / 2,
  width: 4,
  height: 4,
}
check('a wire whose ends are both off-screen but whose middle crosses is kept',
  spanning !== undefined && !intersects(topCard, between) && !intersects(bottomCard, between)
    && intersects(spanning.bounds, between))

const view = { offsetX: 30, offsetY: 40, scale: 1, width: 800, height: 600 }
check('at scale 1 the visible rect is the paint box, panned',
  JSON.stringify(worldViewport(view)) === JSON.stringify({ x: -30, y: -40, width: 800, height: 600 }))
check('zooming in shows less of the drawing',
  worldViewport({ ...view, scale: 2 }).width === 400 && worldViewport({ ...view, scale: 2 }).x === -15)
check('an overscan grows the visible rect on every side',
  worldViewport(view, 10).x === -40 && worldViewport(view, 10).width === 820)
check('a broken scale degrades to 1 instead of an infinite rect',
  worldViewport({ ...view, scale: 0 }).width === 800 && Number.isFinite(worldViewport({ ...view, scale: 0 }).x))
check('a broken paint box is empty, not infinite',
  worldViewport({ ...view, width: Number.NaN }).width === 0)

check('picking returns the topmost item',
  hitTest([{ bounds: overlap }, { bounds: box }], 6, 6)?.bounds === overlap)
check('picking finds a lower item when the top one does not contain the point',
  hitTest([{ bounds: box }, { bounds: overlap }], 12, 12)?.bounds === overlap)
check('picking returns nothing outside every item',
  hitTest([{ bounds: box }, { bounds: overlap }], 100, 100) === undefined)

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
