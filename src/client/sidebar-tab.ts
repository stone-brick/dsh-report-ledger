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
 * @module dsh-report-ledger/client/sidebar-tab
 */

import { createElement } from 'react'
import type { ReactElement } from 'react'
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

/**
 * Bind the probe body to the plugin's copy.
 *
 * The body is the *second* registration and carries the runtime face: a
 * component, receiving the session it was opened in.
 * @param t - namespace-bound translate, read on every render.
 * @returns the tab body component.
 */
function bodyFor(t: Translate): (props: TabBodyProps) => ReactElement {
  return function LedgerCanvasBody(props: TabBodyProps): ReactElement {
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
    const line = { opacity: 0.7 }
    return createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px' } },
      createElement('strong', null, t('sidebar.chip')),
      createElement(
        'div',
        { style: line },
        sessionId === '' ? t('sidebar.probeNoSession') : t('sidebar.probeSession', { session: sessionId }),
      ),
      createElement('div', { style: line }, t('sidebar.probeBody')),
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
