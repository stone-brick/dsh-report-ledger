/**
 * The wire contract shared by the host and browser halves.
 *
 * This file must stay **type-only**: every export is an `export type`, so the
 * bundler erases the whole module. That matters because the browser half is
 * bundled separately and must never inline host code (which reaches for
 * `node:fs`); a shared file with a single runtime export would break the client
 * build the moment anyone imported it for a value.
 *
 * The types themselves are the host's, re-exported rather than restated so the
 * two halves cannot drift apart silently.
 *
 * @module dsh-report-ledger/shared/wire
 */

export type { HopAction, ReportFrontMatter, ReportStatus, RouteHop } from '../report/types.ts'
export type { SessionNode, TimelinePayload } from '../report/timeline.ts'
export type { ReportDetail } from '../report/route.ts'

/** Result envelope every read endpoint returns. */
export type WireResult<T> = { ok: true; value: T } | { ok: false; code: string }
