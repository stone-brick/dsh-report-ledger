// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts.
export {}
/**
 * Deterministic checks for the two surfaces' shared selection, and for the tab
 * click that brings the report view forward.
 *
 * Both are small enough to look obviously right, and both are the kind of thing
 * that is wrong in exactly one direction: a hover that erases the other surface's
 * hover, a notification that fires on an unchanged value (one re-render of a
 * several-hundred-row list per pointer move), or a label match that clicks the
 * wrong tab. None of that is visible without a browser, and all of it is a pure
 * function of a tiny state object.
 *
 * Run: node scripts/selection-bridge-check.ts
 */

const { selection } = await import('../src/client/selection-bridge.ts')
const { activateReportTab } = await import('../src/client/report-tab.ts')

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

/** Count notifications while `body` runs, so "did it publish" is one number. */
const countNotices = (body: () => void): number => {
  let seen = 0
  const unsubscribe = selection.subscribe(() => { seen++ })
  try {
    body()
  } finally {
    unsubscribe()
  }
  return seen
}

/** One fake tab, as `activateReportTab` sees it. */
const tab = (text: string, selected: boolean): { textContent: string; clicks: number; click(): void; getAttribute(name: string): string | null } => {
  const element = {
    textContent: ` ${text} `,
    clicks: 0,
    click(): void { element.clicks++ },
    getAttribute(name: string): string | null { return name === 'aria-selected' ? String(selected) : null },
  }
  return element
}
/** The document face the click needs, and nothing else. */
const fakeDoc = (tabs: readonly { textContent: string; getAttribute(name: string): string | null }[]): Document =>
  ({ querySelectorAll: () => tabs }) as unknown as Document

// ---------------------------------------------------------------------------
// The selection
// ---------------------------------------------------------------------------
selection.reset()
check('an untouched selection is empty', JSON.stringify(selection.get()) === '{}')

const opened = countNotices(() => { selection.open('R-0001', 'session-a') })
check('opening publishes once and carries the session', opened === 1
  && selection.get().report === 'R-0001' && selection.get().session === 'session-a',
  JSON.stringify(selection.get()))

const repeat = countNotices(() => { selection.open('R-0001', 'session-a') })
check('opening the same report again publishes nothing', repeat === 0, String(repeat))

selection.open(undefined, 'session-a')
check('closing clears the report but keeps the session',
  selection.get().report === undefined && selection.get().session === 'session-a',
  JSON.stringify(selection.get()))

const hovered = countNotices(() => { selection.hover('R-0002', 'canvas') })
check('a hover publishes once with its source', hovered === 1
  && selection.get().hover === 'R-0002' && selection.get().hoverFrom === 'canvas',
  JSON.stringify(selection.get()))

const swapped = countNotices(() => { selection.hover('R-0003', 'list') })
check('a later hover from the other surface replaces the first', swapped === 1
  && selection.get().hover === 'R-0003' && selection.get().hoverFrom === 'list')

const foreign = countNotices(() => { selection.clearHover('canvas') })
check('a surface cannot clear a hover it did not publish', foreign === 0
  && selection.get().hover === 'R-0003', JSON.stringify(selection.get()))

selection.clearHover('list')
check('the publishing surface can clear its own hover', selection.get().hover === undefined
  && selection.get().hoverFrom === undefined)

selection.open('R-0004', 'session-a')
selection.hover('R-0004', 'canvas')
selection.reset()
check('reset forgets everything', JSON.stringify(selection.get()) === '{}')

const stopped = countNotices(() => {
  const unsubscribe = selection.subscribe(() => {})
  unsubscribe()
  selection.open('R-0005', 'session-a')
})
check('an unsubscribed listener is not notified (only the counter remains)', stopped === 1, String(stopped))

// ---------------------------------------------------------------------------
// The tab click
// ---------------------------------------------------------------------------
const unselected = tab('汇报', false)
const other = tab('对话', true)
check('the report tab is clicked once when it is not selected',
  activateReportTab(fakeDoc([other, unselected]), '汇报') && unselected.clicks === 1 && other.clicks === 0,
  `report=${unselected.clicks} other=${other.clicks}`)

const selected = tab('汇报', false)
const clickSelected = tab('汇报', true)
check('an already-selected report tab is not clicked again',
  activateReportTab(fakeDoc([selected, clickSelected]), '汇报')
  && clickSelected.clicks === 0 && selected.clicks === 0,
  `selected=${clickSelected.clicks} first=${selected.clicks}`)

check('no matching label is a no-op, not an error',
  !activateReportTab(fakeDoc([tab('对话', true)]), '汇报'))
check('a missing document is a no-op, not an error', !activateReportTab(undefined, '汇报'))
check('a tab whose label only contains the view name is not clicked',
  !activateReportTab(fakeDoc([tab('汇报画布', true)]), '汇报'))

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
