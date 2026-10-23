/**
 * The card canvas as a right-Sidebar tab — stage one and stage two of the tab
 * system.
 *
 * The right column belongs to the product
 * (`@deepseek-ai/dsh-client-ui-sidebar-right`), and a type from outside reaches
 * it through **cordis services**, never through imports: the client bundle's
 * purity gate rejects a cross-plugin value import, and that package's types are
 * not part of a third-party plugin's resolvable dependency set anyway. So the
 * two faces this module needs are asserted structurally here, exactly as
 * `client/index.ts` already asserts the `slots` and `locale` faces.
 *
 * ## Why the registry is injected rather than read
 *
 * `sidebarRightTabs` is published by that package's own `apply`. Cordis has no
 * optional-dependency form: a key on this plugin's `inject` list is a
 * REQUIREMENT, and a missing one parks this plugin's fiber — on the web boot
 * that is a white page, not a degraded view. `ctx.get` fails the other way: it
 * reads the registry at this instant, so a host that publishes it a moment later
 * would leave the tab silently unregistered forever. `ctx.inject` is the one
 * form that is both optional and late — the callback runs when the service
 * actually appears, and again if it comes back.
 *
 * ## Why the guide entry is not optional in practice
 *
 * The strip's `+` control only ever re-opens the guide page, and the guide lists
 * registered types through exactly the entries they declare. Without one, this
 * tab could only ever be opened by code.
 *
 * ## What the body draws
 *
 * The drawing the conversation tab used to carry, filling the panel instead of
 * sitting in a fixed 420px box — the panel owns its height, and it can be split
 * or taken fullscreen, which is most of the reason to put a drawing in this
 * column at all.
 *
 * Picking a card does **not** open the detail here. A half-height drawing is the
 * price of an inline detail, and it is a bad price: the drawing is the reason the
 * column exists. The click instead switches the conversation area to the report
 * view and opens that report there, where there is room for the transfer path and
 * the body — the two surfaces talk through `selection-bridge.ts`, which is also
 * what makes hovering one highlight the other.
 *
 * @module dsh-report-ledger/client/sidebar-tab
 */

import { createElement, useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { CardgraphView } from './CardgraphView.tsx'
import { activateReportTab } from './report-tab.ts'
import { selection } from './selection-bridge.ts'
import { buildRows, sessionTitles } from './timeline-model.ts'
import { useTimeline } from './timeline-source.ts'
import type { Translate } from './ReportsView.tsx'

/** This type's identity in the tab system: unique, and the key both seats use. */
export const TAB_ID = 'dsh-report-ledger/canvas'

/**
 * What `openTab(kind)` names.
 *
 * Deliberately not derived from {@link TAB_ID}: the registry is looked up BY
 * kind, and deriving one name from the other is a mistake the ecosystem has
 * already paid for — a registration that says one thing while its opener says
 * another only fails at click time.
 */
export const TAB_KIND = 'ledger-canvas'

/** One entry capsule the guide page offers, as this plugin declares it. */
export interface GuideEntry {
  /** Stable identity within this provider. */
  readonly id: string
  /** Ascending position among every registered type's entries. */
  readonly order: number
  /** The capsule's title in the current language. */
  readonly title: () => string
  /** One line under the title; shown only while the guide lists few entries. */
  readonly description?: () => string
}

/** One tab type's static face, as far as this plugin declares it. */
export interface TabDefinition {
  readonly id: string
  readonly kind: string
  /** Defaults to `extension` — the band for a type from outside the product. */
  readonly priority?: 'extension' | 'builtin' | 'fallback'
  /** The tab chip's initial text, captured when the tab opens. */
  readonly title: (address: string) => string
  /** Entry capsules for the guide page. Omit to stay off it. */
  readonly guide?: readonly GuideEntry[]
}

/** The tab-type registry the product publishes as `sidebarRightTabs`. */
export interface TabRegistry {
  /**
   * Declare one type. Purely static: the body and title are separate
   * registrations, keyed by this definition's `id`.
   * @param definition - the type's static face.
   * @returns disposer unregistering it.
   */
  register(definition: TabDefinition): () => void
}

/** The slot seats, as far as this module uses them. */
export interface TabSlots {
  inject(key: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: (props: never) => unknown): () => void
}

/** What a deferred contribution can use: the context it was started from. */
export interface ScopedContext {
  get(name: string): unknown
  effect(callback: () => (() => void) | void, label?: string): () => void
}

/** What this module needs from the client context. */
export interface SidebarTabContext {
  readonly slots: TabSlots
  inject(keys: readonly string[], callback: (scoped: ScopedContext) => void): () => void
}

/** Props a tab body receives; only what this body reads is declared. */
export interface TabBodyProps {
  /** The session whose column this tab lives in. */
  readonly sessionId?: string
}

/** The sentences that stand in for a drawing that cannot be made yet. */
const muted: Record<string, string> = {
  padding: '12px',
  color: 'var(--dsw-alias-label-caption)',
}

/**
 * The drawing alone: it takes whatever the panel has.
 *
 * There is no second cell any more. The detail used to split the panel evenly with
 * the drawing, which halved the thing the column exists for; it now opens in the
 * conversation area, where it has room and the drawing keeps its height.
 */
const stackFull: Record<string, string> = { flex: '1 1 auto', minHeight: '0' }

/**
 * Bind the tab body to the plugin's copy.
 *
 * The body is the *second* registration and carries the runtime face: a
 * component, receiving the session it was opened in — which is the only input
 * the drawing needs, since the ledger is read from the session tree's root.
 * @param t - namespace-bound translate, read on every render.
 * @returns the tab body component.
 */
function bodyFor(t: Translate): (props: TabBodyProps) => ReactElement {
  return function LedgerCanvasBody(props: TabBodyProps): ReactElement {
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
    const { payload, error } = useTimeline(sessionId)
    /**
     * What the list has open.
     *
     * This surface does not open anything itself: the list is where a report is
     * read, so it owns the state and the canvas follows it (for the selected
     * card's accent). The session is compared before honoring it, so a value left
     * by another session cannot light a card here.
     */
    const bridged = useSyncExternalStore(selection.subscribe, selection.get)
    const openReport = bridged.session === sessionId ? bridged.report : undefined

    const rows = useMemo(() => (payload === undefined ? [] : buildRows(payload)), [payload])
    // Unfiltered on purpose: a docked canvas has no toolbar of its own to filter
    // with, and the conversation tab beside it is where narrowing belongs.
    const reports = useMemo(() => rows.flatMap((row) => (row.kind === 'report' ? [row.front] : [])), [rows])
    const titles = useMemo(
      () => (payload === undefined ? new Map<string, string>() : sessionTitles(payload)),
      [payload],
    )
    const idHint = useCallback((id: string): string => {
      const title = titles.get(id)
      return title === undefined ? id : `${title} · ${id}`
    }, [titles])
    /**
     * Open this card's report in the report view.
     *
     * The selection crosses through the bridge; bringing the view forward has to
     * be a tab click — `report-tab.ts` says why, and degrades to a no-op when the
     * shell offers no tab. Clicking the open card again closes it, matching what a
     * row does.
     */
    const onOpen = useCallback((report: string) => {
      selection.open(bridged.report === report ? undefined : report, sessionId)
      activateReportTab(globalThis.document, t('view.tab'))
    }, [bridged.report, sessionId, t])

    if (error !== undefined) return createElement('div', { style: muted }, t('view.error', { code: error }))
    if (payload === undefined) return createElement('div', { style: muted }, t('view.loading'))
    if (reports.length === 0) return createElement('div', { style: muted }, t('view.empty'))

    // One container and one child: no open/closed layout to swap in and out, so
    // the drawing keeps its zoom, pan and drill state across a click on a card —
    // the state that used to be thrown away when the detail half appeared.
    return createElement(
      'div',
      { style: stackFull },
      createElement(CardgraphView, {
        payload,
        reports,
        t,
        ...(openReport === undefined ? {} : { openReport }),
        onOpen,
        idHint,
        fill: true,
      }),
    )
  }
}

/**
 * Contribute the canvas tab: its type, its body, and its guide capsule.
 * @param ctx - the client context (slots, plus the optional registry service).
 * @param t - namespace-bound translate, read fresh on every label call.
 */
export function installSidebarTab(ctx: SidebarTabContext, t: Translate): void {
  ctx.inject(['sidebarRightTabs'], (scoped) => {
    const tabs = scoped.get('sidebarRightTabs') as TabRegistry | undefined
    if (tabs === undefined) return
    scoped.effect(() => {
      // Stage one: what the type IS. `extension` is stated rather than inherited
      // — it is both the default and the band that may take over a builtin kind,
      // and neither is something to leave implicit.
      const disposeType = tabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        priority: 'extension',
        title: () => t('sidebar.chip'),
        guide: [{
          id: 'canvas',
          // Between the product's files (10) and terminal (20) capsules.
          order: 15,
          title: () => t('sidebar.guideTitle'),
          description: () => t('sidebar.guideDescription'),
        }],
      })
      // Stage two: the body, keyed by the SAME implementation id.
      const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: TAB_ID },
        bodyFor(t) as never,
      ))
      return () => {
        disposeBody()
        disposeType()
      }
    }, 'report-ledger: canvas tab')
  })
}
