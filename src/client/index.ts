/**
 * Browser half of dsh-report-ledger — runs inside the dsh web GUI.
 *
 * The shell serves the built `lib/client.js` from /plugins/dsh-report-ledger/client.js
 * and evaluates it as a closure-factory artifact, so this module's `require` is
 * answered by the loader's frozen module table (react, cordis, the slot
 * services) and every other dependency is inlined by the build.
 *
 * It contributes exactly one thing: a `conversation.view` entry, which the
 * conversation shell projects as a tab beside the shipped Chat and Trajectory
 * views. A fresh id is used rather than an existing one, so nothing shipped is
 * replaced.
 *
 * @module dsh-report-ledger/client
 */

import { createElement } from 'react'
import { ReportsView, type Translate } from './ReportsView.tsx'
import { en, zh } from './locales.ts'

/** Locale namespace this plugin owns. */
const NS = 'report-ledger'

/** Tab key. Distinct from the shipped `chat` / `trajectory` cells. */
const VIEW_ID = 'report-ledger'

/** Position after the shipped views (`chat` 0, `trajectory` 10). */
const VIEW_ORDER = 20

/** Minimal structural face of the client slot service. */
interface SlotsService {
  inject(key: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: (props: never) => unknown): () => void
}

/** Minimal structural face of the client locale service. */
interface LocaleService {
  register(ns: string, dicts: { zh: unknown; en: unknown }): () => void
  bind(ns: string): Translate
}

/**
 * Minimal structural face of the client plugin context.
 *
 * Deliberately local rather than imported: the client runtime's published types
 * live in packages seeded into the shell bundle, which are not part of a
 * third-party plugin's resolvable dependency set (and one of them is not even
 * installed here). The shape asserted is exactly what the registration below
 * uses, and the host-side declarations remain the source of truth for the wire.
 */
interface ClientContext {
  slots: SlotsService
  locale: LocaleService
  effect(callback: () => (() => void) | void, label?: string): () => void
  get(name: string): unknown
}

/** The slot and locale services must be mounted before this half can contribute. */
export const inject = ['slots', 'locale']

/**
 * Apply the browser half.
 * @param ctx - the client plugin context (`slots`, `locale` injected).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'report-ledger: dictionaries')

  const t = ctx.locale.bind(NS)

  ctx.slots.inject('conversation.view', () => ctx.slots.register(
    {
      name: 'conversation.view',
      id: VIEW_ID,
      order: VIEW_ORDER,
      // A thunk is re-read on every projection, so the tab label follows the
      // active locale without re-registering.
      label: () => t('view.tab'),
      locale: NS,
    },
    (props: Record<string, unknown>) => createElement(ReportsView, { ...props, t } as never) as never,
  ))
}
