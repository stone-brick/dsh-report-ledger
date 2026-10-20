/**
 * The plugin's own stylesheet.
 *
 * The shell's primitives ship their own CSS with the shell, which is the whole
 * point of using them — a plugin gets the app's real look without carrying a
 * theme. What is left for us is the one thing only a consumer can know:
 *
 *  **Layout that belongs to the consumer.** `Input` sizes itself to its content
 *  (`display: inline-flex`, no width), which is right in a form and wrong in this
 *  tab's toolbar, where the search seat takes the slack. The component puts the
 *  `className` it is given on its own wrapper, so one rule is enough — and
 *  targeting a class of our own keeps us off the hashed class names, which are
 *  free to change between shell releases.
 *
 * Nothing here restyles a shell component; every library element keeps the look
 * the shell gave it. The SVG drawing rules that used to live here went with the
 * lane view they drew (R-0011): the topology is now painted by the card canvas,
 * which carries its own painter, so a stylesheet entry for a rail or an edge had
 * no consumer left.
 *
 * @module dsh-report-ledger/client/styles
 */

/** Class the tab puts on the toolbar's search seat. */
export const SEARCH_CLASS = 'report-ledger-search'

/** Element id, so a reload replaces the sheet instead of stacking one per apply. */
const STYLE_ID = 'dsh-report-ledger-styles'

/** The adapter rules, kept in one place so the id and the text cannot drift. */
const CSS = `
.${SEARCH_CLASS} { flex: 1 1 auto; min-width: 0; }
`

/**
 * Mount the adapter stylesheet.
 * @returns a disposer that removes it, owned by the plugin's effect scope.
 */
export function installStyles(): () => void {
  const doc = globalThis.document
  if (doc === undefined) return () => {}
  // A reload of the plugin re-runs apply without a page reload, so replace any
  // sheet a previous generation left behind rather than stacking duplicates.
  doc.getElementById(STYLE_ID)?.remove()
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  doc.head.append(style)
  return () => { style.remove() }
}
