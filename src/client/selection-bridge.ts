/**
 * The one piece of state two surfaces share: which report is open, and which one
 * the pointer is on.
 *
 * The canvas lives in the right sidebar and the list lives in the conversation
 * area, so they are two React trees with no common parent and no shared props.
 * They are, however, one module — the client bundle is loaded once — so a module
 * singleton is the narrowest thing that can join them: no second store, no event
 * bus with a name, and nothing crosses the host boundary.
 *
 * The state is deliberately tiny and the transitions are opinionated:
 *
 *  - **the open report is owned by the list**, which is where a report is read;
 *    the canvas publishes its click here and *follows* the value for its accent;
 *  - **the hover is owned by whoever pointed last**, because the two pointers are
 *    the same mouse: a hover published while another surface's hover is still
 *    up replaces it, and a leave only clears the hover it published itself.
 *
 * `session` travels with the open report so a value left behind by one session
 * cannot open a stranger's report in another. A stale value is inert: the list
 * compares the session before honoring it.
 *
 * @module dsh-report-ledger/client/selection-bridge
 */

/** Which surface published the current hover. */
export type HoverSource = 'canvas' | 'list'

/** Everything the two surfaces share. Replaced wholesale on every change. */
export interface SelectionState {
  /** Session the open report belongs to, so another session's value is inert. */
  readonly session?: string
  /** Report the list has open, if any. */
  readonly report?: string
  /** Report the pointer is on, in either surface. */
  readonly hover?: string
  /** The surface that put {@link hover} there. */
  readonly hoverFrom?: HoverSource
}

/** A subscriber; `useSyncExternalStore` wants exactly this shape. */
type Listener = () => void

let state: SelectionState = {}
const listeners = new Set<Listener>()

const same = (a: SelectionState, b: SelectionState): boolean =>
  a.session === b.session && a.report === b.report && a.hover === b.hover && a.hoverFrom === b.hoverFrom

/**
 * Replace the state and tell the subscribers, but only when it really changed.
 *
 * The short-circuit is not a micro-optimization: a pointer crossing a card fires
 * several moves, and an unchanged snapshot must not re-render the other surface
 * (the list can be hundreds of rows).
 * @param next - the state to publish.
 */
const commit = (next: SelectionState): void => {
  if (same(state, next)) return
  state = next
  for (const listener of listeners) listener()
}

/** The shared selection, as the two surfaces use it. */
export const selection = {
  /** @returns the current snapshot; stable by identity until a change. */
  get(): SelectionState { return state },

  /**
   * Subscribe to changes.
   * @param listener - called after every change.
   * @returns the unsubscribe function.
   */
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },

  /**
   * Publish the open report. Only the surface that owns the list should call it
   * with a value; the canvas calls it to *request* the open (see the sidebar tab).
   * @param report - report to open, or `undefined` to close.
   * @param session - session the report belongs to.
   */
  open(report: string | undefined, session: string | undefined): void {
    commit({ ...state, report, session })
  },

  /**
   * Point at one report.
   * @param report - report the pointer entered.
   * @param from - the surface that saw it.
   */
  hover(report: string, from: HoverSource): void {
    commit({ ...state, hover: report, hoverFrom: from })
  },

  /**
   * Clear the hover — but only the one this surface published.
   *
   * A canvas pointerleaving its box must not erase a hover that a list row just
   * published (they are different pointers on the same mouse, and the second one
   * happened later).
   * @param from - the surface whose hover should end.
   */
  clearHover(from: HoverSource): void {
    if (state.hoverFrom !== from) return
    commit({ ...state, hover: undefined, hoverFrom: undefined })
  },

  /** Forget everything; used when a session goes away. */
  reset(): void {
    commit({})
  },
}
