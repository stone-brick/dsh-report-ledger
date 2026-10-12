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

import { useCallback, useEffect, useState } from 'react'
import type { TimelinePayload } from '../shared/wire.ts'

/** The timeline read endpoint, addressed by the tree's root session. */
export const TIMELINE_URL = '/api/report-ledger/timeline'

/** One report's detail: its transfer path and its body. */
export const REPORT_URL = '/api/report-ledger/report'

/**
 * How often a mounted view re-reads the timeline.
 *
 * The ledger is written by other agents in the background, so a view that loads
 * once goes stale precisely when it matters — the human is watching for a report
 * that has not been written yet. Ten seconds is quiet enough not to matter on a
 * large ledger and still fast enough to watch a collaboration happen.
 */
export const POLL_INTERVAL_MS = 10_000

/** Read one endpoint and unwrap its result envelope. */
export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`HTTP ${response.status}`)
  }
  const envelope = body as { ok?: boolean; code?: string; value?: T }
  if (envelope.ok !== true) throw new Error(envelope.code ?? `HTTP ${response.status}`)
  return envelope.value as T
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
 * Follow one session tree's timeline for as long as the caller is mounted.
 *
 * Reads on mount and on every session change, then on the poll cadence. Polling
 * stops while the page is hidden and a returning page catches up immediately, so
 * a background panel costs nothing and a foreground one is never behind.
 * @param sessionId - the tree's root session; an empty value reads nothing.
 * @returns the latest payload, its error, and a manual refresh.
 */
export function useTimeline(sessionId: string): TimelineRead {
  const [payload, setPayload] = useState<TimelinePayload | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (sessionId === '') {
      setError('no-session')
      return undefined
    }
    let cancelled = false
    setError(undefined)
    getJson<TimelinePayload>(`${TIMELINE_URL}?root=${encodeURIComponent(sessionId)}`)
      .then((value) => { if (!cancelled) setPayload(value) })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { cancelled = true }
  }, [sessionId, nonce])

  useEffect(() => {
    if (sessionId === '') return undefined
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
  }, [sessionId])

  const refresh = useCallback(() => { setNonce((value) => value + 1) }, [])
  return { payload, error, refresh }
}
