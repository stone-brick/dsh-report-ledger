/**
 * The ledger's browser-side read path: the two endpoints, the poll cadence, and
 * the one way any view reads them.
 *
 * Two surfaces now draw the same ledger for the same session — the conversation
 * tab and the canvas tab in the right column. Keeping the envelope unwrapping
 * and the polling rule here is what stops the second surface from growing a
 * second opinion about either; that kind of drift does not fail loudly, it just
 * leaves one of the two views quietly rendering nothing.
 *
 * @module dsh-report-ledger/client/timeline-source
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReportDetail, TimelinePayload, TimelineScope } from '../shared/wire.ts'

/** The timeline read endpoint, addressed by the tree's root session. */
export const TIMELINE_URL = '/api/report-ledger/timeline'

/** One report's detail: its transfer path and its body. */
export const REPORT_URL = '/api/report-ledger/report'

/** Storage key for the remembered ledger scope. */
const SCOPE_KEY = 'dsh.reportLedger.scope.v1'

/**
 * Read the remembered scope, tolerating absent or restricted storage.
 *
 * A page with storage blocked simply starts on the tree scope: the toggle still
 * works for the session, it just is not remembered across reloads.
 * @returns the stored scope, or `tree`.
 */
function readStoredScope(): TimelineScope {
  try {
    const raw = globalThis.localStorage?.getItem(SCOPE_KEY)
    if (raw === 'all' || raw === 'tree') return raw
  } catch {
    // A restricted storage just means the choice is not remembered.
  }
  return 'tree'
}

let scopeState: TimelineScope = readStoredScope()
const scopeListeners = new Set<() => void>()

/**
 * The one thing the two surfaces must agree about without passing props.
 *
 * The conversation tab and the right-column canvas are separate React trees, so
 * a scope chosen in one would leave the other reading a different slice of the
 * ledger — the exact "one view quietly renders nothing" failure the shared read
 * path exists to prevent. A module singleton plus `useSyncExternalStore` keeps
 * them on one value, and localStorage keeps it across reloads.
 */
export const ledgerScope = {
  /** @returns the current scope; stable until changed. */
  get(): TimelineScope { return scopeState },

  /**
   * Subscribe to changes.
   * @param listener - called after every change.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    scopeListeners.add(listener)
    return () => { scopeListeners.delete(listener) }
  },

  /**
   * Switch the scope both surfaces read.
   * @param next - the scope to adopt.
   */
  set(next: TimelineScope): void {
    if (next === scopeState) return
    scopeState = next
    try {
      globalThis.localStorage?.setItem(SCOPE_KEY, next)
    } catch {
      // Remembering the scope is a convenience, never a requirement.
    }
    for (const listener of scopeListeners) listener()
  },
}

/**
 * Follow the shared ledger scope.
 * @returns the scope, re-rendering the caller when either surface changes it.
 */
export function useLedgerScope(): TimelineScope {
  return useSyncExternalStore(ledgerScope.subscribe, ledgerScope.get)
}

/**
 * How often a mounted view re-reads the timeline.
 *
 * The ledger is written by other agents in the background, so a view that loads
 * once goes stale precisely when it matters — the human is watching for a report
 * that has not been written yet. Ten seconds is quiet enough not to matter on a
 * large ledger and still fast enough to watch a collaboration happen.
 */
export const POLL_INTERVAL_MS = 10_000

/**
 * A read must finish, or fail with an error the panel can show, before the next
 * poll aborts it. The poll effect starts a new window every {@link POLL_INTERVAL_MS}
 * and aborts whatever is in flight; a timeout longer than the interval could
 * therefore never fire — every slow read would be cancelled by the next tick,
 * leaving the view on "loading" forever with no retry. Deriving it keeps the two
 * constants from drifting apart.
 */
const READ_TIMEOUT_MS = POLL_INTERVAL_MS - 2_000

/** Read one endpoint and unwrap its result envelope. */
export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  if (signal?.aborted === true) controller.abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, READ_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new Error(`HTTP ${response.status}`)
    }
    const envelope = body as { ok?: boolean; code?: string; value?: T }
    if (envelope.ok !== true) throw new Error(envelope.code ?? `HTTP ${response.status}`)
    return envelope.value as T
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/** What one view needs to draw a session tree's ledger. */
export interface TimelineRead {
  /** The payload once it has arrived; `undefined` while loading or after a failure. */
  readonly payload: TimelinePayload | undefined
  /** The failure code of the last read, or `undefined` while reads are succeeding. */
  readonly error: string | undefined
  /** Re-read now, without waiting for the next poll. */
  readonly refresh: () => void
}

/**
 * Follow one slice of the ledger for as long as the caller is mounted.
 *
 * Reads on mount and on every session or scope change, then on the poll cadence.
 * Polling stops while the page is hidden and a returning page catches up
 * immediately, so a background panel costs nothing and a foreground one is never
 * behind.
 * @param sessionId - the tree's root session; an empty value reads nothing in tree scope.
 * @param scope - the session tree or the whole ledger.
 * @returns the latest payload, its error, and a manual refresh.
 */
export function useTimeline(sessionId: string, scope: TimelineScope = 'tree'): TimelineRead {
  const [payload, setPayload] = useState<TimelinePayload | undefined>(undefined)
  const [loadedFor, setLoadedFor] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [nonce, setNonce] = useState(0)

  // A payload belongs to the session AND the scope it was read for; a global
  // listing is not a tree and must never be shown as one. The key makes a switch
  // of either derive `undefined` for the frame before the new read lands, and the
  // read effect below depends on it so both changes re-read.
  const key = `${scope}:${scope === 'all' ? '' : sessionId}`
  const target = scope === 'all' ? 'all' : sessionId

  useEffect(() => { setError(undefined) }, [key])

  useEffect(() => {
    if (target === '') {
      setError('no-session')
      setLoadedFor(undefined)
      return undefined
    }
    let cancelled = false
    const controller = new AbortController()
    const url = scope === 'all'
      ? `${TIMELINE_URL}?scope=all`
      : `${TIMELINE_URL}?root=${encodeURIComponent(sessionId)}`
    // Do not clear the error before the read succeeds. A transient host failure
    // would otherwise alternate the panel between drawing and error on every
    // poll, and every error remounts the canvas and throws its view state away.
    getJson<TimelinePayload>(url, controller.signal)
      .then((value) => {
        if (cancelled) return
        setPayload(value)
        setLoadedFor(key)
        setError(undefined)
      })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { cancelled = true; controller.abort() }
  }, [key, nonce]) // `key` encodes both scope and session, so the read follows either.

  useEffect(() => {
    if (target === '') return undefined
    const tick = (): void => {
      if (globalThis.document?.visibilityState === 'hidden') return
      setNonce((value) => value + 1)
    }
    const timer = globalThis.setInterval(tick, POLL_INTERVAL_MS)
    const onVisibility = (): void => { if (globalThis.document?.visibilityState !== 'hidden') tick() }
    globalThis.document?.addEventListener('visibilitychange', onVisibility)
    return () => {
      globalThis.clearInterval(timer)
      globalThis.document?.removeEventListener('visibilitychange', onVisibility)
    }
  }, [target])

  const refresh = useCallback(() => { setNonce((value) => value + 1) }, [])
  return { payload: loadedFor === key ? payload : undefined, error, refresh }
}

/** What one report's detail read returns. */
export interface ReportDetailRead {
  /** The detail for the requested report; `undefined` until its first read lands. */
  readonly detail: ReportDetail | undefined
  /** The failure code of the last read, cleared by the next success. */
  readonly error: string | undefined
}

/** One detail read, stamped with the report it was read for. */
interface DetailState {
  /** The report this read belongs to. */
  readonly report: string
  /** The detail once it has arrived; kept across a re-read of the same report. */
  readonly detail?: ReportDetail
  /** The failure code of the last read for this report, cleared by a success. */
  readonly error?: string
}

/**
 * Read one report's detail, for whichever surface is showing it.
 *
 * Not polled on its own: the caller owns the cadence, because the two surfaces
 * want different ones — the conversation tab re-reads it when the reader hits
 * refresh, while a docked panel passes its own timeline tick so a report being
 * written under the reader's eyes keeps up.
 *
 * A re-read of the SAME report therefore keeps the previous detail on screen
 * until the new one arrives: clearing it would turn every tick into a flash of
 * "reading the transfer path" over a body the reader is in the middle of. A read
 * for a DIFFERENT report is a different question, so the state is keyed by report
 * id and anything read for another report is never returned — that is what stops
 * one click from rendering the previous report's body under the new one, even for
 * a frame.
 *
 * Errors follow the same rule: a failed re-read keeps the detail and reports the
 * failure beside it, and only a successful read clears it.
 * @param report - the report to read; `undefined` clears the read.
 * @param nonce - bump to re-read the same report.
 * @returns the detail for `report` only, its error, and nothing else.
 */
export function useReportDetail(report: string | undefined, nonce: number): ReportDetailRead {
  const [state, setState] = useState<DetailState | undefined>(undefined)

  useEffect(() => {
    if (report === undefined) return undefined
    let cancelled = false
    const controller = new AbortController()
    getJson<ReportDetail>(`${REPORT_URL}?id=${encodeURIComponent(report)}`, controller.signal)
      .then((value) => { if (!cancelled) setState({ report, detail: value }) })
      .catch((cause: unknown) => {
        if (cancelled) return
        const message = cause instanceof Error ? cause.message : String(cause)
        // A failed re-read of the report already on screen keeps its detail and
        // merely adds the failure; a failed FIRST read has nothing to keep.
        setState((previous) => previous !== undefined && previous.report === report && previous.detail !== undefined
          ? { report, detail: previous.detail, error: message }
          : { report, error: message })
      })
    return () => { cancelled = true; controller.abort() }
  }, [report, nonce])

  if (report === undefined || state === undefined || state.report !== report) {
    return { detail: undefined, error: undefined }
  }
  return { detail: state.detail, error: state.error }
}
