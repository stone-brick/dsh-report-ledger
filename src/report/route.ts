/**
 * The read-only HTTP surface the browser half of this plugin consumes.
 *
 * The host and client halves of a third-party plugin share no bundled code, so
 * the transport is a same-origin, direct-loopback JSON pair registered on the
 * harness web server — the pattern the deployed third-party plugins already use
 * rather than a generated remote, which would need build-time codegen this
 * package deliberately avoids.
 *
 * The guard is intentionally narrow and copied in spirit from that precedent:
 *
 *  - the TCP peer must be loopback, so nothing off-machine can reach it even if
 *    the server is later bound to all interfaces;
 *  - the `Host` header must parse to exactly itself and name a loopback host,
 *    which rejects DNS-rebinding spellings (`localhost.attacker.tld`) and
 *    non-canonical authorities (a default port such as `127.0.0.1:80` parses
 *    away, so it never compares equal) before any handler runs;
 *  - browser same-origin markers must agree, so a cross-site page cannot read
 *    the response.
 *
 * Both routes are GET-only and read-only. There is no write surface, no token,
 * and nothing here mutates the ledger — every mutation stays behind the model
 * tools, which are the only path that records a hop. A deployment that reaches
 * the GUI through a reverse proxy would need the shared-token variant of this
 * guard; serving direct loopback only is the safe default, and the failure mode
 * is a refused read rather than an exposed one.
 *
 * @module dsh-report-ledger/report/route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TimelinePayload } from './timeline.ts'
import type { ReportFrontMatter, RouteHop } from './types.ts'

/** Path of the subtree + digest listing. */
export const TIMELINE_PATH = '/api/report-ledger/timeline'

/** Path of one report's detail. */
export const REPORT_PATH = '/api/report-ledger/report'

/** Longest accepted root session id. */
const MAX_ID_LENGTH = 200

/** Conservative session-id shape: no separators that could escape a query. */
const SESSION_ID = /^[A-Za-z0-9._:-]+$/

/** Report id shape. */
const REPORT_ID = /^R-\d{4,}$/

/** One report's full detail, as the tab's expanded panel needs it. */
export interface ReportDetail {
  /** The digest. */
  readonly front: ReportFrontMatter
  /** The complete transfer path. */
  readonly hops: readonly RouteHop[]
  /** Recipients the ledger still owes this report to. */
  readonly pending: readonly string[]
  /** The body text. */
  readonly body: string
  /** Absolute path of the document, offered for direct reading. */
  readonly path: string
}

/** Data sources the handlers read. */
export interface RouteDeps {
  /**
   * Assemble the timeline payload for one root session.
   * @param root - root session id.
   * @returns the payload.
   */
  timeline(root: string): Promise<TimelinePayload>
  /**
   * Read one report in full.
   * @param id - report id.
   * @returns the detail, or `undefined` when unknown.
   */
  report(id: string): Promise<ReportDetail | undefined>
}

/**
 * Whether a TCP peer address is loopback.
 * @param address - `socket.remoteAddress`.
 * @returns true for IPv4 loopback, IPv6 loopback, and IPv4-mapped loopback.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (typeof address !== 'string' || address === '') return false
  if (address === '::1') return true
  const mapped = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(mapped)
}

/**
 * Whether a parsed hostname is loopback.
 * @param hostname - `URL.hostname` of the request authority.
 * @returns true for the loopback names only.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

/** Parse a `Host` header into a canonical authority plus its URL. */
function parseAuthority(host: string): { canonical: string; url: URL } | undefined {
  // A bare IPv6 literal is bracketed by the client; anything else must look like
  // host[:port] so a comma-joined or userinfo-bearing value is rejected here.
  if (!/^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(host) && !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return undefined
  let url: URL
  try {
    url = new URL(`http://${host}`)
  } catch {
    return undefined
  }
  if (url.username !== '' || url.password !== '' || url.pathname !== '/') return undefined
  return { canonical: url.host, url }
}

/** Whether the browser's own same-origin markers agree with this authority. */
function isSameOriginRequest(request: IncomingMessage, hostUrl: URL): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Decide whether one request may read this plugin's data.
 * @param request - the incoming request.
 * @returns true only for a canonical loopback, same-origin read.
 */
export function isTrustedRequest(request: IncomingMessage): boolean {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  const parsed = parseAuthority(host)
  if (parsed === undefined || parsed.canonical !== host.toLowerCase()) return false
  if (!isLoopbackHostname(parsed.url.hostname)) return false
  return isSameOriginRequest(request, parsed.url)
}

/** Write one JSON response with the headers this surface always wants. */
function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  response.end(payload)
}

/** Answer a refusal without revealing whether the resource exists. */
function refuse(response: ServerResponse, status: number, code: string): void {
  writeJson(response, status, { ok: false, code })
}

/**
 * Wrap one read-only handler with the shared guard, method check, and error
 * containment: a failing data source must surface as a JSON error, never as an
 * unhandled rejection inside the web server.
 * @param work - the handler body, receiving the request URL.
 * @returns a route handler.
 */
function guarded(
  work: (url: URL, response: ServerResponse) => Promise<void>,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    try {
      if (!isTrustedRequest(request)) {
        refuse(response, 403, 'untrusted-request')
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD' })
        response.end()
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      await work(url, response)
    } catch (error) {
      refuse(response, 500, `internal-error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Build the timeline handler.
 * @param deps - data sources.
 * @returns the route handler.
 */
export function createTimelineHandler(deps: RouteDeps): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return guarded(async (url, response) => {
    const root = url.searchParams.get('root') ?? ''
    if (root === '' || root.length > MAX_ID_LENGTH || !SESSION_ID.test(root)) {
      refuse(response, 400, 'invalid-root')
      return
    }
    writeJson(response, 200, { ok: true, value: await deps.timeline(root) })
  })
}

/**
 * Build the single-report handler.
 * @param deps - data sources.
 * @returns the route handler.
 */
export function createReportHandler(deps: RouteDeps): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return guarded(async (url, response) => {
    const id = url.searchParams.get('id') ?? ''
    if (!REPORT_ID.test(id)) {
      refuse(response, 400, 'invalid-report-id')
      return
    }
    const detail = await deps.report(id)
    if (detail === undefined) {
      refuse(response, 404, 'unknown-report')
      return
    }
    writeJson(response, 200, { ok: true, value: detail })
  })
}
