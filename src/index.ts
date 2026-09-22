/**
 * Host half of dsh-report-ledger — runs in the DSH host process.
 *
 * Loaded from the profile composition through the `report-ledger` row in
 * cordis.patch.yml. It wires four things into the running harness:
 *
 *  1. the report service, which owns the durable ledger under
 *     `$DSH_HOME/report-ledger`;
 *  2. the eight model-facing report tools;
 *  3. the delivery pump — when a session becomes resident again, every hand-off
 *     the ledger is still holding for it is delivered. That is the durable
 *     mailbox the delegation seam documents as missing;
 *  4. two read-only HTTP endpoints the browser tab reads, registered on the
 *     harness web server when one is mounted (the headless profile has none, and
 *     the plugin stays fully functional without them).
 *
 * Every adapter from an untyped harness service into this plugin's own shapes
 * lives here, so the rest of the plugin never touches a live harness object.
 *
 * @module dsh-report-ledger
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only imports: they pull each host service's Context augmentation into
// scope so `ctx.tools` / `ctx.systemPrompt` / `ctx.agents` are typed. They are
// erased at build time and never become a runtime dependency.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
import type { AgentLike } from './report/deliver.ts'
import { pendingTargets } from './report/deliver.ts'
import { PARTNERSHIP_SECTION_ORDER, PROTOCOL, SECTION_ORDER, partnershipText } from './report/guidance.ts'
import { listReports, readHops, readReport, reportPath } from './report/ledger.ts'
import { DEFAULT_MAX_PEERS, PeerService, type PeerHost } from './report/peer.ts'
import { REPORT_PATH, TIMELINE_PATH, createReportHandler, createTimelineHandler, type ReportDetail } from './report/route.ts'
import { ReportService, type ReportServiceHost } from './report/service.ts'
import { buildTimeline, type SessionRecordLike } from './report/timeline.ts'
import { registerReportTools } from './report/tools.ts'

/** Plugin config, supplied by the composition row. */
export interface Config {
  /**
   * When true (default), the prompt sections announce the ledger to every agent.
   * Set false to keep prompts untouched.
   */
  announceToAgent?: boolean
  /**
   * Cap on independent peer sessions one session may start. Peer creation is the
   * one capability here that adds live agents rather than records, so it is
   * budgeted; reaching the cap is a tool error naming the limit, not a silent
   * refusal.
   * @default 8
   */
  maxPeersPerAgent?: number
}

/** The three host services this half cannot work without. */
export const inject = ['tools', 'systemPrompt', 'agents']

/** Structural face of the optional session-query service. */
interface SessionQueryLike {
  listSessions?(): Promise<readonly unknown[]>
  readTitleSnapshots?(ids: readonly string[]): Promise<readonly unknown[]>
}

/** Structural face of the optional web-server service. */
interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (request: never, response: never) => void | Promise<void>
  }): () => void
}

/** Everything this plugin reads out of the host, in its own shapes. */
interface HostBundle extends ReportServiceHost {
  /**
   * Read display titles for a set of sessions.
   * @param ids - session ids.
   * @returns a title per session that has one.
   */
  readTitles(ids: readonly string[]): Promise<Map<string, string>>
  /**
   * Read every known session record, reduced to the fields the timeline needs.
   * @returns the records.
   */
  listSessionRecords(): Promise<SessionRecordLike[]>
}

/**
 * Read one string field off an untyped record.
 * @param source - the record.
 * @param key - field name.
 * @returns the value when it is a non-empty string.
 */
function str(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Extract only the header fields the timeline renders.
 *
 * The session query returns live harness records; copying them wholesale would
 * both break the leaf-field rule and drag unrelated state into the browser.
 * @param entry - one raw session record.
 * @returns the structural record, or `undefined` when it has no usable id.
 */
function toSessionRecord(entry: unknown): SessionRecordLike | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const record = entry as Record<string, unknown>
  const header = record.header
  if (header === null || typeof header !== 'object') return undefined
  const fields = header as Record<string, unknown>
  const id = str(fields, 'id')
  if (id === undefined) return undefined
  const parentSession = str(fields, 'parentSession')
  const origin = str(fields, 'origin')
  const agentPreset = str(fields, 'agentPreset')
  return {
    header: {
      id,
      ...(parentSession === undefined ? {} : { parentSession }),
      ...(origin === undefined ? {} : { origin }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
      ...(typeof fields.createdAt === 'number' ? { createdAt: fields.createdAt } : {}),
      ...(typeof fields.delegationDepth === 'number' ? { delegationDepth: fields.delegationDepth } : {}),
    },
    live: record.live === true,
  }
}

/**
 * Build every host capability this plugin consumes.
 *
 * Agent lookup goes through `ctx.agents`, and delivery uses the `Agent`'s own
 * `steer`/`inject` entries. Those entries take a message and no authority, which
 * is what lets a report reach a carbon-copy peer that the adjacency-checked
 * delegation path would refuse.
 * @param ctx - the plugin context.
 * @returns the host capability bundle.
 */
function buildHost(ctx: Context): HostBundle {
  const sessionQuery = (): SessionQueryLike | undefined => ctx.get('sessionQuery') as SessionQueryLike | undefined

  const readTitles = async (ids: readonly string[]): Promise<Map<string, string>> => {
    const titles = new Map<string, string>()
    const query = sessionQuery()
    if (query?.readTitleSnapshots === undefined || ids.length === 0) return titles
    try {
      const results = await query.readTitleSnapshots(ids)
      for (const result of results) {
        if (result === null || typeof result !== 'object') continue
        const entry = result as Record<string, unknown>
        if (entry.status !== 'fulfilled' || typeof entry.sessionId !== 'string') continue
        const value = entry.value as Record<string, unknown> | undefined
        const snapshot = value?.title as Record<string, unknown> | undefined
        const title = snapshot === undefined ? undefined : str(snapshot, 'title')
        if (title !== undefined) titles.set(entry.sessionId, title)
      }
    } catch {
      // Titles are cosmetic: a failing title service must not break the view.
    }
    return titles
  }

  return {
    getAgent(sessionId: string): AgentLike | undefined {
      const agent = ctx.agents.get(sessionId as never)
      if (agent === undefined) return undefined
      return {
        id: String(agent.id),
        steer: (message) => { agent.steer(message as never) },
        inject: (message) => { agent.inject(message as never) },
      }
    },
    async describe(sessionId: string): Promise<string | undefined> {
      return (await readTitles([sessionId])).get(sessionId)
    },
    readTitles,
    async listSessionRecords(): Promise<SessionRecordLike[]> {
      const query = sessionQuery()
      if (query?.listSessions === undefined) return []
      const raw = await query.listSessions()
      const records: SessionRecordLike[] = []
      for (const entry of raw) {
        const record = toSessionRecord(entry)
        if (record !== undefined) records.push(record)
      }
      return records
    },
  }
}

/** Read one report's full detail for the tab's expanded panel. */
async function readDetail(id: string): Promise<ReportDetail | undefined> {
  const found = await readReport(id)
  if (found === undefined) return undefined
  const hops = await readHops(id)
  return { front: found.front, hops, pending: pendingTargets(hops), body: found.body, path: reportPath(id) }
}

/**
 * Build the peer-management capabilities from the running context.
 *
 * Peer creation is the only place this plugin adds a live agent, so it is the
 * only place that needs an authority story: the tool's visibility is the outer
 * gate, {@link Config.maxPeersPerAgent} bounds the blast radius, the peer
 * inherits the caller's own working directory (so it cannot be pointed at an
 * unrelated tree), and every creation is attributed in the roster log.
 * @param ctx - the plugin context.
 * @param host - the session-reading bundle.
 * @returns the peer host capability.
 */
function buildPeerHost(ctx: Context, host: HostBundle): PeerHost {
  return {
    selfCwd(sessionId: string): string | undefined {
      const session = ctx.agents.get(sessionId as never)?.session
      const cwd = (session?.header as { cwd?: unknown } | undefined)?.cwd
      return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
    },
    liveIds(): ReadonlySet<string> {
      const ids = new Set<string>()
      for (const agent of ctx.agents.list()) ids.add(String(agent.id))
      return ids
    },
    listSessionRecords: () => host.listSessionRecords(),
    readTitles: (ids: readonly string[]) => host.readTitles(ids),
    listReports: () => listReports(),
    async createPeer(input: { sessionId: string; cwd?: string }) {
      const handle = await ctx.agents.create({
        sessionId: input.sessionId as never,
        ...(input.cwd === undefined ? {} : { meta: { cwd: input.cwd } }),
      })
      // The handle is intentionally NOT retained. Its `dispose()` removes the
      // session from the store, which is exactly wrong for a peer that must
      // outlive this turn; the peer stays addressable through `ctx.agents`.
      return {
        id: String(handle.agent.id),
        steer: (message) => { handle.agent.steer(message as never) },
      }
    },
  }
}

/**
 * Apply the host half.
 * @param ctx - the plugin context (`tools`, `systemPrompt`, `agents` injected).
 * @param config - resolved plugin config from the composition row.
 */
export function apply(ctx: Context, config?: Config): void {
  const host = buildHost(ctx)
  const service = new ReportService(host)
  const peers = new PeerService(buildPeerHost(ctx, host), config?.maxPeersPerAgent ?? DEFAULT_MAX_PEERS)

  ctx.effect(() => registerReportTools(ctx, service, peers), 'report-ledger: model tools')

  // The delivery pump. A hand-off recorded while its recipient was absent stays
  // pending in the transfer path; this is where it finally lands. Failures are
  // logged, never thrown: a ledger problem must not break agent creation.
  ctx.on('agent/created', (payload: { agent: { id: unknown } }) => {
    const sessionId = String(payload?.agent?.id ?? '')
    if (sessionId === '') return
    void service.flushForAgent(sessionId).catch((error: unknown) => {
      ctx.logger?.warn?.(`report-ledger: deferred delivery to ${sessionId} failed: ${String(error)}`)
    })
  })

  // The browser tab's read surface.
  //
  // Registered through a service-injection callback rather than a plain
  // `ctx.get`, because the two are NOT equivalent for a service that may arrive
  // late: `ctx.get` reads the registry at this instant and returns undefined if
  // the provider has not activated yet, while the callback runs when the service
  // actually appears. The `webserver` row injects `webStartup`, so in a web
  // profile it can activate after this row — with `ctx.get` the routes were
  // silently never registered and every request fell through to the `/api` auth
  // fence, which answers 401 before our handler is ever reached.
  //
  // It is still optional, which is why this is not on the plugin's own `inject`
  // list: the headless profile mounts no web server at all, and there the
  // callback simply never runs while the ledger and every tool keep working.
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer') as WebServerLike | undefined
    if (webServer === undefined) return
    const deps = {
      timeline: async (root: string) => buildTimeline({
        listSessionRecords: () => host.listSessionRecords(),
        readTitles: (ids: readonly string[]) => host.readTitles(ids),
        listReports: () => listReports(),
      }, root),
      report: readDetail,
    }
    scoped.effect(() => {
      const disposeReport = webServer.register({ kind: 'exact', path: REPORT_PATH, handler: createReportHandler(deps) as never })
      const disposeTimeline = webServer.register({ kind: 'exact', path: TIMELINE_PATH, handler: createTimelineHandler(deps) as never })
      return () => {
        disposeTimeline()
        disposeReport()
      }
    }, 'report-ledger: read endpoints')
  })

  if ((config?.announceToAgent ?? true) === false) return

  // The protocol is a plain string, byte-identical for every agent, so the
  // shared part of the prompt stays a stable prefix in every scope.
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'plugin:report-ledger',
      order: SECTION_ORDER,
      text: PROTOCOL,
    }),
    'report-ledger: protocol section',
  )

  // The partnership contract is evaluated per assembly: a delegated agent must
  // learn that it is a long-lived collaborator rather than a one-shot function,
  // and must receive its parent's session id or it cannot report upward at all.
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'plugin:report-ledger:partnership',
      order: PARTNERSHIP_SECTION_ORDER,
      text: partnershipText,
    }),
    'report-ledger: partnership section',
  )
}
