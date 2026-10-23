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
  intersects, contains, grow, cullByBounds, hitTest, worldViewport, fitTransform,
  DEFAULT_CARDGRAPH_OPTIONS, MAX_FIT_ZOOM, MAX_ZOOM, MIN_ZOOM, ZOOM_STEP,
  scopeInput,
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
/** The x of every interior vertical run (the first/last segments are port stubs). */
const verticalXs = (edge: { points?: readonly { readonly x: number; readonly y: number }[] }): number[] => {
  const points = edge.points ?? []
  const xs: number[] = []
  for (let index = 2; index < points.length - 1; index++) {
    const a = points[index - 1]
    const b = points[index]
    if (a !== undefined && b !== undefined && a.x === b.x) xs.push(a.x)
  }
  return xs
}
/** Whether every x sits in the gutter on side of column column. */
const inGutter = (xs: readonly number[], column: number, side: 'left' | 'right'): boolean => {
  const box = layout.columns[column]?.bounds
  if (box === undefined) return false
  return xs.length > 0 && xs.every((x) => side === 'right'
    ? x > box.x + box.width && x < box.x + box.width + 48
    : x < box.x && x > box.x - 48)
}
const sibling = layout.edges.find((edge) => edge.report === 'R-0004' && edge.kind === 'cc')
check('a delivery between two sessions in one column bends through the gutter',
  sibling !== undefined && inGutter(verticalXs(sibling), 1, 'right'))
check('a same-column wire leaves and lands on the same side',
  sibling?.from.side === 'right' && sibling?.to.side === 'right')
check('a same-column wire only crosses the gutter on its way in',
  sibling !== undefined && inGutter(verticalXs(sibling), 1, 'right'))

const siblingAuthor = buildCardgraph(payload, [
  report('R-0110', { from: 'session-child', authors: ['session-child', 'session-peer'] }),
])
const sideways = siblingAuthor.edges.find((edge) => edge.kind === 'author')
check('a co-author in a sibling frame also comes in through the gutter',
  sideways !== undefined && inGutter(verticalXs(sideways), 1, 'right')
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

// A card's own edge is shared too. Two deliveries leaving one card must leave at
// different points: without this, every delivery from a busy report starts at the
// same pixel and the drawing reads as "all arrows point at one spot".
const cardPorts = buildCardgraph(payload, [
  report('R-0080', { from: 'session-root', to: ['session-peer', 'session-grand'], created: at(5) }),
])
const leaving = cardPorts.edges.filter((edge) => edge.from.kind === 'card')
check('two wires leaving one card get different ports', leaving.length === 2
  && leaving[0]?.from.y !== leaving[1]?.from.y, JSON.stringify(leaving.map((edge) => edge.from)))
check('card ports stay inside the card edge', (() => {
  const card = cardPorts.cards.find((entry) => entry.report === 'R-0080')
  if (card === undefined) return false
  return leaving.every((edge) => (edge.from.side === 'left' || edge.from.side === 'right')
    ? edge.from.y >= card.bounds.y + 10 && edge.from.y <= card.bounds.y + card.bounds.height - 10
    : edge.from.x >= card.bounds.x + 10 && edge.from.x <= card.bounds.x + card.bounds.width - 10)
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
  thread !== undefined && verticalXs(thread).some((x) => inGutter([x], 0, 'right')))
check('no vertical run goes through a frame',
  layout.edges.every((edge) => verticalXs(edge).every((x) => layout.frames.every((frame) =>
    !(x > frame.bounds.x && x < frame.bounds.x + frame.bounds.width)))))
check('a wire\'s box contains its gutter run',
  thread !== undefined
    && verticalXs(thread).every((x) => x >= thread.bounds.x && x <= thread.bounds.x + thread.bounds.width))
check('every gutter run is inside the drawing',
  layout.edges.every((edge) => verticalXs(edge).every((x) => x > 0 && x < layout.width)))

// Adjacent cards in one frame: the thread is a short S in the 8px gap, not a detour
// out to the gutter and back.
const sameColumn = buildCardgraph(payload, [
  report('R-0090', { from: 'session-peer', created: at(5) }),
  report('R-0091', { from: 'session-peer', parent: 'R-0090', created: at(6) }),
])
const loop = sameColumn.edges.find((edge) => edge.kind === 'thread')
check('a thread between adjacent cards stays in the gap between them', (() => {
  if (loop === undefined) return false
  const parent = sameColumn.cards.find((card) => card.report === 'R-0090')?.bounds
  const child = sameColumn.cards.find((card) => card.report === 'R-0091')?.bounds
  if (parent === undefined || child === undefined) return false
  const xs = (loop.points ?? []).map((point) => point.x)
  const ys = (loop.points ?? []).map((point) => point.y)
  return xs.every((x) => x >= parent.x - 1 && x <= parent.x + parent.width + 1)
    && ys.every((y) => y >= parent.y + parent.height - 1 && y <= child.y + 1)
})())
// Not adjacent: the two cards have a card between them, and the only way past it is
// out through the column's gutter and back.
const skipped = buildCardgraph(payload, [
  report('R-0092', { from: 'session-peer', created: at(5) }),
  report('R-0093', { from: 'session-peer', created: at(6) }),
  report('R-0094', { from: 'session-peer', parent: 'R-0092', created: at(7) }),
])
const around = skipped.edges.find((edge) => edge.kind === 'thread')
check('a thread past an intervening card goes out through the gutter',
  around !== undefined && inGutter(verticalXs(around), 1, 'right'))

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
check('a thread in the last column loops out to the left instead', (() => {
  const edge = lastColumn.edges.find((candidate) => candidate.kind === 'thread')
  const column = lastColumn.columns[2]?.bounds
  return edge !== undefined && column !== undefined
    && verticalXs(edge).length > 0
    && verticalXs(edge).every((x) => x < column.x && x > column.x - 48)
})())

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

// ---------------------------------------------------------------------------
// Fitting: the one rule that turns a box width into a transform
// ---------------------------------------------------------------------------
// A chain of `count` sessions is `count` columns, whatever reports are plotted, so
// the drawing's widths are the tier widths the fit has to probe.
const chain = (count: number): { payload: Parameters<typeof buildCardgraph>[0]; cards: Front[] } => {
  const sessions = Array.from({ length: count }, (_unused, index) => ({
    id: `session-chain-${index}`,
    depth: index,
    delegated: index > 0,
    live: true,
    ...(index > 0 ? { parentId: `session-chain-${index - 1}` } : {}),
    createdAt: at(index + 1),
  }))
  const cards = Array.from({ length: count }, (_unused, index) =>
    report(`R-9${String(index).padStart(2, '0')}`, { from: `session-chain-${index}`, created: at(20 + index) }))
  return {
    payload: { root: 'session-chain-0', generatedAt: at(99), sessions, reports: [] } as never,
    cards,
  }
}

check('the zoom range is one set of numbers, shared by the controls and the fit',
  MIN_ZOOM === 0.25 && MAX_ZOOM === 2.5 && ZOOM_STEP === 1.25 && MAX_FIT_ZOOM === ZOOM_STEP)

check('a fit reports the tier its own scale lands in', (() => {
  const { payload: tree, cards } = chain(3)
  const fitted = fitTransform(tree, cards, 575)
  return fitted !== undefined && fitted.lod === 'compact'
    && Math.abs(fitted.scale - 551 / 696) < 1e-12
})())
check('a fit leaves the drawing where the reader reads it: centred, 12px down', (() => {
  const { payload: tree, cards } = chain(3)
  const fitted = fitTransform(tree, cards, 575)
  // 575 - 24 available, compact width 696, scale 551/696 → the drawing is 551 wide
  // and therefore centred at (575 - 551) / 2.
  return fitted !== undefined && Math.abs(fitted.offsetX - 12) < 1e-9 && fitted.offsetY === 12
})())
check('a fit of one column at fullscreen leans in no further than one control step', (() => {
  const { payload: tree, cards } = chain(1)
  const fitted = fitTransform(tree, cards, 1279)
  return fitted !== undefined && fitted.lod === 'card' && fitted.scale === MAX_FIT_ZOOM
    && fitted.offsetX === (1279 - 312 * MAX_FIT_ZOOM) / 2 && fitted.offsetY === 12
})())
check('a box narrower than the cheapest tier still answers, at the zoom floor', (() => {
  const { payload: tree, cards } = chain(1)
  const fitted = fitTransform(tree, cards, 50)
  return fitted !== undefined && fitted.lod === 'chip' && fitted.scale === MIN_ZOOM
})())
check('a box with no width has nothing to fit',
  fitTransform(payload, plotted, 0) === undefined && fitTransform(payload, plotted, Number.NaN) === undefined)
check('a drawing with nothing in it has nothing to fit',
  fitTransform({ root: 'nobody', generatedAt: 0, sessions: [], reports: [] } as never, [], 800) === undefined)

// The bands the first cut of the fit could not resolve: at the card tier's fill
// scale the box was below the card tier, at the compact tier's it was above it, so
// `lodFor(scale) === tier` matched nothing, the fit wrote nothing, and the drawing
// kept whatever transform it already had — the state dependence the tier probing
// exists to remove. One row per column count, from the audit.
const formerDeadBands: readonly (readonly [number, number, number])[] = [
  [1, 210, 273], [2, 396, 523], [3, 581, 772], [4, 767, 1022], [5, 952, 1271], [6, 1138, 1521],
]
check('every former dead band now resolves to a self-consistent fit',
  formerDeadBands.every(([count, from, to]) => {
    const { payload: tree, cards } = chain(count)
    return [from, Math.floor((from + to) / 2), to].every((width) => {
      const fitted = fitTransform(tree, cards, width)
      return fitted !== undefined && lodFor(fitted.scale) === fitted.lod
    })
  }))

/** The first box width a sweep cannot fit, or `''` when every one of them fits. */
const sweepFailure = (() => {
  for (let count = 1; count <= 6; count++) {
    const { payload: tree, cards } = chain(count)
    for (let width = 160; width <= 1600; width++) {
      const fitted = fitTransform(tree, cards, width)
      if (fitted === undefined) return `columns=${count} width=${width}: no fit`
      if (lodFor(fitted.scale) !== fitted.lod) return `columns=${count} width=${width}: ${fitted.lod} drawn at ${fitted.scale}`
      if (fitted.scale < MIN_ZOOM || fitted.scale > MAX_FIT_ZOOM) return `columns=${count} width=${width}: scale ${fitted.scale}`
      if (!Number.isFinite(fitted.offsetX) || !Number.isFinite(fitted.offsetY)) return `columns=${count} width=${width}: offset`
    }
  }
  return ''
})()
check('every box width from 160 to 1600 fits in every tier a reader can reach', sweepFailure === '', sweepFailure)
check('a fit is idempotent: the same box gives the same transform, click after click', (() => {
  const { payload: tree, cards } = chain(3)
  const once = JSON.stringify(fitTransform(tree, cards, 620))
  return once === JSON.stringify(fitTransform(tree, cards, 620))
    && once === JSON.stringify(fitTransform(tree, cards, 620))
})())
check('a fit never magnifies past the box it was asked to fill', (() => {
  const { payload: tree, cards } = chain(2)
  const fitted = fitTransform(tree, cards, 420)
  const drawing = buildCardgraph(tree, cards, { lod: fitted?.lod ?? 'card' })
  return fitted !== undefined && drawing.width * fitted.scale <= 420 - 24 + 1e-9
})())

// A pinned tier: the view draws one presentation at every zoom, so the fit must
// accept a tier instead of probing for one. The scale then fills the box at that
// tier, whatever zoom that lands on (never past the fit ceiling).
check('a pinned fit uses the tier it was given', (() => {
  const { payload: tree, cards } = chain(2)
  const drawing = buildCardgraph(tree, cards, { lod: 'card' })
  const fitted = fitTransform(tree, cards, 575, { lod: 'card' })
  return fitted !== undefined && fitted.lod === 'card'
    && Math.abs(fitted.scale - Math.min(MAX_FIT_ZOOM, (575 - 24) / drawing.width)) < 1e-12
})())
// The layout reserves room for wires: with enough deliveries through one gutter,
// the gutter grows instead of packing the lanes tighter than the gap.
check('a busy gutter widens the drawing to fit its lanes', (() => {
  const many = Array.from({ length: 12 }, (_, index) =>
    report(`R-08${String(index).padStart(2, '0')}`, { from: 'session-root', to: ['session-child'], created: at(index) }))
  const base = buildCardgraph(payload, many)
  const grown = buildCardgraph(payload, many, { fitChannels: true })
  return grown.width > base.width
})())

check('the layout carries the title-bar height, so the painter need not know it',
  DEFAULT_CARDGRAPH_OPTIONS.frameHeaderHeight === 26 && layout.frameHeaderHeight === 26)
check('the title-bar height is an option the layout reports',
  buildCardgraph(payload, plotted, { frameHeaderHeight: 40 }).frameHeaderHeight === 40)

// ---------------------------------------------------------------------------
// Drill-in scope
//
// The scope is what makes "enter a session" a change of input rather than a
// change of transform, so everything here is about membership: which sessions
// survive, which reports are admitted, and what the outside frame holds.
// ---------------------------------------------------------------------------
const drillReports = [
  report('r-child-out', { from: 'session-child', to: ['session-peer'], created: at(20) }),
  report('r-child-in', { from: 'session-child', to: ['session-grand'], created: at(21) }),
  report('r-child-plain', { from: 'session-child', created: at(22) }),
  report('r-inbound', { from: 'session-peer', to: ['session-child'], created: at(23) }),
  report('r-root-unrelated', { from: 'session-root', created: at(24) }),
  report('r-peer-unrelated', { from: 'session-peer', to: ['session-root'], created: at(25) }),
]
const scoped = scopeInput(payload, drillReports, 'session-child')
const scopedIds = scoped.payload.sessions.map((session) => session.id)

check('no scope plots the caller\'s input untouched', (() => {
  const whole = scopeInput(payload, drillReports)
  return whole.payload === payload && whole.reports === drillReports && whole.trail.length === 0
})())
check('scoping to the payload\'s own root is the same drawing as no scope', (() => {
  const whole = scopeInput(payload, drillReports, 'session-root')
  return whole.payload === payload && whole.trail.length === 0
})())
check('a scope keeps exactly the subtree', (() => {
  // The independent derivation: walk parentId down from the scoped session.
  const byParent = new Set(['session-child'])
  for (const session of payload.sessions) {
    if (session.parentId !== undefined && byParent.has(session.parentId)) byParent.add(session.id)
  }
  return scopedIds.join(',') === [...byParent].join(',')
})(), scopedIds.join(','))
check('a scope admits its own reports and its one-hop neighbours', (() => {
  const ids = scoped.reports.map((front) => front.report).sort().join(',')
  return ids === 'r-child-in,r-child-out,r-child-plain,r-inbound'
})(), scoped.reports.map((front) => front.report).sort().join(','))
check('a scope drops a report that neither starts in it nor touches it', (() => {
  const ids = new Set(scoped.reports.map((front) => front.report))
  return !ids.has('r-root-unrelated') && !ids.has('r-peer-unrelated')
})())
check('a leaf scope is one frame and its own cards', (() => {
  const leaf = scopeInput(payload, [report('r-grand', { from: 'session-grand' })], 'session-grand')
  const drawing = buildCardgraph(leaf.payload, leaf.reports, { lod: 'card' })
  return leaf.payload.sessions.length === 1 && drawing.frames.length === 1
    && !drawing.frames.some((frame) => frame.external)
    && drawing.cards.length === 1 && drawing.edges.length === 0
})())
check('a scope keeps the payload\'s depths, so columns still come from depths', (() => {
  const drawing = buildCardgraph(scoped.payload, scoped.reports, { lod: 'card' })
  const depths = new Set(scopedIds.map((id) => payload.sessions.find((session) => session.id === id)?.depth))
  return drawing.columns.length === depths.size + 1
})())
check('the outside frame holds a report authored outside the scope', (() => {
  const drawing = buildCardgraph(scoped.payload, scoped.reports, { lod: 'card' })
  const inbound = drawing.cards.find((card) => card.report === 'r-inbound')
  return inbound !== undefined && drawing.frames[inbound.frame]?.external === true
})())
check('a scope with no wire leaving it draws no outside frame', (() => {
  const inner = scopeInput(payload, [report('r-plain', { from: 'session-child' })], 'session-child')
  const drawing = buildCardgraph(inner.payload, inner.reports, { lod: 'card' })
  return drawing.frames.length === inner.payload.sessions.length
    && drawing.frames.every((frame) => !frame.external)
})())
check('the trail runs root-down and stops above the payload root', (() => {
  const deep = scopeInput(payload, drillReports, 'session-grand')
  const shallow = scopeInput(payload, drillReports, 'session-child')
  return deep.trail.join(',') === 'session-child,session-grand'
    && shallow.trail.join(',') === 'session-child'
})())
check('an unknown root degrades to the whole tree', (() => {
  const stale = scopeInput(payload, drillReports, 'session-gone')
  return stale.payload === payload && stale.trail.length === 0
})())
check('a scope builds the same drawing twice', (() => {
  const once = JSON.stringify(buildCardgraph(scoped.payload, scoped.reports, { lod: 'card' }))
  return once === JSON.stringify(buildCardgraph(scoped.payload, scoped.reports, { lod: 'card' }))
})())
check('a fit inside a scope stays finite and on its own tier', (() => {
  for (const width of [240, 375, 575, 800, 1200]) {
    const fitted = fitTransform(scoped.payload, scoped.reports, width)
    if (fitted === undefined) return false
    if (lodFor(fitted.scale) !== fitted.lod) return false
    if (fitted.scale < MIN_ZOOM || fitted.scale > MAX_FIT_ZOOM) return false
    if (!Number.isFinite(fitted.offsetX) || !Number.isFinite(fitted.offsetY)) return false
  }
  return true
})())
check('a fit inside a scope is idempotent', (() => {
  const once = JSON.stringify(fitTransform(scoped.payload, scoped.reports, 620))
  return once === JSON.stringify(fitTransform(scoped.payload, scoped.reports, 620))
})())

// ---------------------------------------------------------------------------
// Muted kinds (the legend's toggles)
//
// Muting is a view filter, and the claim worth pinning is that it is ONLY that:
// the wires of one kind disappear, everything else — every card, every frame,
// the drawing's extent — stays exactly where it was. Otherwise the legend would
// be a layout control in disguise, and toggling it would re-fit the view.
// ---------------------------------------------------------------------------
const withoutTo = buildCardgraph(payload, plotted, { hiddenKinds: ['to'] })
// Ports are spread per shared edge, so muting one kind may move the *other* wires
// on the same edge to new port slots — that is spreading, not layout. The check
// therefore compares identities, not coordinates; the "moves nothing" check below
// is what covers the boxes.
check('a muted kind is left out of the layout', (() => {
  const expected = layout.edges.filter((edge) => edge.kind !== 'to')
  return withoutTo.edges.length === expected.length
    && withoutTo.edges.every((edge) => edge.kind !== 'to')
    && expected.every((edge) => withoutTo.edges.some((kept) => kept.report === edge.report
      && kept.kind === edge.kind && kept.to.kind === edge.to.kind && kept.to.id === edge.to.id))
})())
check('muting a kind moves nothing', withoutTo.width === layout.width
  && withoutTo.height === layout.height
  && JSON.stringify(withoutTo.cards.map((card) => card.bounds)) === JSON.stringify(layout.cards.map((card) => card.bounds))
  && JSON.stringify(withoutTo.frames.map((frame) => frame.bounds)) === JSON.stringify(layout.frames.map((frame) => frame.bounds)))

// ---------------------------------------------------------------------------
// Channel routing
//
// A routed wire must stay orthogonal, must not cut through a frame it does not
// enter, must never cross a title bar, and must stay inside the drawing — the
// four properties that together mean "a wire cannot hide text".
// ---------------------------------------------------------------------------
const segmentsOf = (points: readonly { readonly x: number; readonly y: number }[]): { a: { x: number; y: number }; b: { x: number; y: number } }[] =>
  points.slice(1).flatMap((point, index) => {
    const a = points[index]
    return a === undefined ? [] : [{ a: { x: a.x, y: a.y }, b: { x: point.x, y: point.y } }]
  })
const crosses = (a: { x: number; y: number }, b: { x: number; y: number }, box: { x: number; y: number; width: number; height: number }): boolean => {
  const loX = Math.min(a.x, b.x)
  const hiX = Math.max(a.x, b.x)
  const loY = Math.min(a.y, b.y)
  const hiY = Math.max(a.y, b.y)
  return loX < box.x + box.width && box.x < hiX && loY < box.y + box.height && box.y < hiY
}
const frameOfCard = (report: string | undefined): number =>
  layout.cards.find((card) => card.report === report)?.frame ?? -1
const endFrame = (end: { readonly kind: 'card' | 'frame'; readonly index: number; readonly id?: string }): number =>
  end.kind === 'frame' ? end.index : frameOfCard(end.id)
const routed = layout.edges.filter((edge) => edge.points !== undefined)
check('every wire is routed', routed.length === layout.edges.length && routed.length > 0)
check('every routed segment is orthogonal', routed.every((edge) => segmentsOf(edge.points ?? []).every(({ a, b }) => a.x === b.x || a.y === b.y)))
check('a routed wire only touches the frames it enters and leaves', routed.every((edge) => {
  const source = endFrame(edge.from)
  const target = endFrame(edge.to)
  return segmentsOf(edge.points ?? []).every(({ a, b }) => layout.frames.every((frame) =>
    frame.index === source || frame.index === target || !crosses(a, b, frame.bounds)))
}))
check('no routed segment crosses a title bar', routed.every((edge) => segmentsOf(edge.points ?? [])
  .every(({ a, b }) => layout.frames.every((frame) => !crosses(a, b, {
    x: frame.bounds.x,
    y: frame.bounds.y,
    width: frame.bounds.width,
    height: layout.frameHeaderHeight,
  })))))
check('a routed wire stays inside the drawing', routed.every((edge) => (edge.points ?? []).every((point) =>
  point.x >= 0 && point.x <= layout.width && point.y >= 0 && point.y <= layout.height)))
// Lanes are handed out by port y, not by card order, so the short runs from the
// ports to the gutters never cross. Read back: inside one gutter, ascending port y
// must give ascending lane x.
check('lanes in a gutter follow the order of their ports', (() => {
  // Built with fitChannels on: this is the drawing the view actually shows, where
  // the gaps grew to fit the lanes, so no channel overflows and the order is on
  // display rather than hidden behind a wrap.
  const laneLayout = buildCardgraph(payload, plotted, { fitChannels: true })
  const columnOfEnd = (end: { readonly kind: 'card' | 'frame'; readonly index: number; readonly id?: string }): number =>
    end.kind === 'frame'
      ? laneLayout.frames[end.index]?.column ?? 0
      : laneLayout.cards.find((card) => card.report === end.id)?.column ?? 0
  /**
   * A channel's identity: the same physical gutter is the right side of one column
   * and the left side of the next, so both ends must land in one group.
   */
  const channelKey = (column: number, side: 'left' | 'right'): string => {
    const box = laneLayout.columns[column]?.bounds
    if (box === undefined) return `${column}:${side}`
    const neighbour = side === 'right' ? laneLayout.columns[column + 1]?.bounds : laneLayout.columns[column - 1]?.bounds
    const gap = side === 'right'
      ? (neighbour === undefined ? 48 : neighbour.x - (box.x + box.width))
      : (neighbour === undefined ? 48 : box.x - (neighbour.x + neighbour.width))
    return String(Math.round(side === 'right' ? box.x + box.width + gap / 2 : box.x - gap / 2))
  }
  const uses = new Map<string, { portY: number; x: number }[]>()
  for (const edge of laneLayout.edges) {
    const xs = verticalXs(edge)
    const fromColumn = columnOfEnd(edge.from)
    const fromSide = edge.from.side === 'left' || edge.from.side === 'right'
      ? edge.from.side
      : (fromColumn < laneLayout.columns.length - 1 ? 'right' : 'left')
    const fromX = xs[0]
    if (fromX !== undefined) {
      const key = channelKey(fromColumn, fromSide)
      const list = uses.get(key) ?? []
      list.push({ portY: edge.from.y, x: fromX })
      uses.set(key, list)
    }
    const toColumn = columnOfEnd(edge.to)
    const toSide = edge.to.side === 'left' || edge.to.side === 'right'
      ? edge.to.side
      : (toColumn < laneLayout.columns.length - 1 ? 'right' : 'left')
    if (channelKey(toColumn, toSide) === channelKey(fromColumn, fromSide)) continue
    const toX = xs[xs.length - 1]
    if (toX !== undefined) {
      const key = channelKey(toColumn, toSide)
      const list = uses.get(key) ?? []
      list.push({ portY: edge.to.y, x: toX })
      uses.set(key, list)
    }
  }
  return [...uses.values()].every((list) => {
    const sorted = [...list].sort((a, b) => a.portY - b.portY)
    for (let index = 1; index < sorted.length; index++) {
      const previous = sorted[index - 1]
      const current = sorted[index]
      if (previous === undefined || current === undefined) continue
      if (current.x < previous.x - 1e-9) return false
    }
    return true
  })
})())
check('two routed wires never run on top of each other', (() => {
  // Interior segments only: the first and last are the port stubs, which sit on
  // their own card/frame edge. Channel lanes are 2.5px apart, so collinear overlap
  // here would mean the lane allocator handed out one lane twice.
  const interior = routed.flatMap((edge) => {
    const points = edge.points ?? []
    return points.slice(1, -1).flatMap((point, index) => {
      const a = points[index + 1]
      return a === undefined ? [] : [{ edge, a: { x: a.x, y: a.y }, b: { x: point.x, y: point.y } }]
    })
  })
  const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }): boolean => {
    if (a.x === b.x && c.x === d.x) {
      if (a.x !== c.x) return false
      const lo = Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y))
      const hi = Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y))
      return hi - lo > 0.5
    }
    if (a.y === b.y && c.y === d.y) {
      if (a.y !== c.y) return false
      const lo = Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x))
      const hi = Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x))
      return hi - lo > 0.5
    }
    return false
  }
  for (let first = 0; first < interior.length; first++) {
    for (let second = first + 1; second < interior.length; second++) {
      const one = interior[first]
      const other = interior[second]
      if (one === undefined || other === undefined || one.edge === other.edge) continue
      if (overlaps(one.a, one.b, other.a, other.b)) return false
    }
  }
  return true
})())

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
