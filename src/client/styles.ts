/**
 * The plugin's own stylesheet.
 *
 * The shell's primitives ship their own CSS with the shell, which is the whole
 * point of using them — a plugin gets the app's real look without carrying a
 * theme. What is left for us are the two things only a consumer can know:
 *
 *  1. **Layout that belongs to the consumer.** `Input` sizes itself to its
 *     content (`display: inline-flex`, no width), which is right in a form and
 *     wrong in this tab's toolbar, where the search seat takes the slack. The
 *     component puts the `className` it is given on its own wrapper, so one rule
 *     is enough — and targeting a class of our own keeps us off the hashed class
 *     names, which are free to change between shell releases.
 *
 *  2. **Drawing the topology.** The graph is made of elements the shell has no
 *     primitive for — edges, lane rails, row separators, the hover dimming — so
 *     these rules style OUR OWN svg and divs. Nothing here restyles a shell
 *     component; every library element keeps the look the shell gave it.
 *
 * Every colour comes from a `--dsw-*` token, so the drawing follows the theme
 * (light or dark) without knowing anything about it.
 *
 * @module dsh-report-ledger/client/styles
 */

/** Class the tab puts on the toolbar's search seat. */
export const SEARCH_CLASS = 'report-ledger-search'

/** Applied to everything that is not part of the hovered report's path. */
export const DIM_CLASS = 'report-ledger-dim'

/**
 * The class names the topology draws with.
 *
 * Exported as functions rather than written out at each call site so the legend
 * cannot drift from the lines it explains: both ask for the same class, and the
 * browser resolves both to the same rule.
 * @param kind - the edge kind.
 * @returns the classes for the path.
 */
export function edgeClass(kind: string): string {
  return `report-ledger-edge report-ledger-edge-${kind}`
}

/**
 * The arrowhead class for one edge kind.
 * @param kind - the edge kind.
 * @returns the class for the polygon.
 */
export function arrowClass(kind: string): string {
  return `report-ledger-arrow-${kind}`
}

/** Element id, so a reload replaces the sheet instead of stacking one per apply. */
const STYLE_ID = 'dsh-report-ledger-styles'

/** The adapter rules, kept in one place so the id and the text cannot drift. */
const CSS = `
.${SEARCH_CLASS} { flex: 1 1 auto; min-width: 0; }

/* ── topology: our own drawing primitives ──────────────────────────────────
   Rails and row separators are hairlines; edges carry the relation, so only
   they get colour and dash pattern. Everything reads through theme tokens. */
.report-ledger-rail { stroke: var(--dsw-alias-border-l1); stroke-width: 1; }
.report-ledger-rowsep { stroke: var(--dsw-alias-border-l1); stroke-width: 1; opacity: .45; }
.report-ledger-headsep { stroke: var(--dsw-alias-border-l2); stroke-width: 1; }
.report-ledger-edge { fill: none; }
.report-ledger-edge-to { stroke: var(--dsw-alias-label-secondary); stroke-width: 1.4; }
.report-ledger-edge-cc { stroke: var(--dsw-alias-label-caption); stroke-width: 1; stroke-dasharray: 2 3; }
.report-ledger-edge-author { stroke: var(--dsw-alias-label-caption); stroke-width: 1; stroke-dasharray: 1 3; }
.report-ledger-edge-thread { stroke: var(--dsw-alias-state-business-label, var(--dsw-alias-label-secondary)); stroke-width: 1.2; }
.report-ledger-arrow-to { fill: var(--dsw-alias-label-secondary); }
.report-ledger-arrow-cc { fill: var(--dsw-alias-label-caption); }
.report-ledger-arrow-author { fill: var(--dsw-alias-label-caption); }
.report-ledger-arrow-thread { fill: var(--dsw-alias-state-business-label, var(--dsw-alias-label-secondary)); }
/* A hover label over a line needs its own backing, or the line runs through the word. */
.report-ledger-edge-label {
  padding: 0 4px;
  border-radius: 3px;
  font-size: var(--dsw-font-xxxs-11, 11px);
  line-height: 15px;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-base);
}
/* ── hover focus ───────────────────────────────────────────────────────────
   The dim goes on ONE element — the edge layer — and never through a descendant
   selector. Measured on a 300-report drawing: flipping a data attribute that a
   descendant rule matches costs ~35ms per hover on its own, because the browser
   recalculates style for the whole subtree whether or not the result changes
   anything visible; dimming 831 individual groups cost ~89ms. One class on one
   layer costs neither.

   Nodes are deliberately NOT dimmed: while tracing one report's path it is the
   *relations* that need to recede, not the participants. */
.${DIM_CLASS} { opacity: .18; }
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
