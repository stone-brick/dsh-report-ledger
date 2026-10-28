/**
 * Developer mode — the add-on bundle's half, existing only in the checkout.
 *
 * This module is not imported by the release entry. It is built separately into
 * `dev/bundle/lib/`, which `files` excludes, so a published artifact carries no
 * developer-mode code at all — the release `lib/index.js` mounts the host half and
 * nothing else. An installed package therefore cannot enable any of this, whatever
 * its config says: `installDevMode` returns an empty disposer when
 * `dev/agents.yml` is absent, and the roster is only in the repository.
 * **Cloning the repository is the gate.**
 *
 * An earlier version published these agents as harness presets. That was wrong in
 * a way worth recording: a preset is a deployment-level fact. It appears in the
 * preset picker next to the shipped modes, it is selectable by anyone on the
 * machine, and it outlives the checkout that declared it — a development artifact
 * leaking into the product's own settings. So the agents below are **the plugin's
 * own state**:
 *
 *  - they are sessions the plugin starts itself (`dev_agent_start`), through the
 *    same peer machinery `peer_start` uses;
 *  - which roster entry a session belongs to lives in the plugin's own file
 *    (`$DSH_HOME/report-ledger/dev-agents.json`), not in a preset, not in a
 *    session header;
 *  - the prompt section routes by that binding, so a developer agent is identified
 *    by the plugin alone.
 *
 * @module dsh-report-ledger-dev
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only, and load-bearing: it is what adds `agent` to `AssembleContext`, so the
// section provider can read the assembling session at all. Erased at build time.
import type {} from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { mountHost, mountWhenFree, type Config, type HostHalf } from '../../../lib/index.js'
import { ledgerRoot, listReports, readReport } from '../../../src/report/ledger.ts'
// The live services come from the release package's built entry, so the add-on must
// type them from that same declaration — deriving from `HostHalf` keeps one identity
// instead of mixing the package's classes with the checkout's source types (their
// `#private` members would make the two nominally incompatible).
type HostPeers = HostHalf['peers']
type HostService = HostHalf['service']
import {
  MAX_ARCHIVE_BYTES,
  MAX_INDEX_LINES,
  parseIndex,
  renderArchive,
  renderIndex,
  renderIndexBlock,
  topicSlug,
  type ArchiveSource,
  type ArchiveTopic,
} from './archive.ts'
import {
  DEV_SECTION_ORDER,
  parseBindings,
  parseRoster,
  promptFor,
  serializeBindings,
  type DevAgent,
  type RosterProblem,
} from './roster.ts'

/** Name of the prompt section a developer agent receives. */
const DEV_SECTION = 'plugin:report-ledger:dev'

/** Where the roster lives: `dev/agents.yml` beside this add-on's package root. */
const ROSTER_FILE = join('..', 'agents.yml')

/** Where the archive index lives, likewise relative to the add-on package root. */
const ARCHIVE_DIR = join('..', 'archive')

/**
 * The plugin's own record of which sessions are developer agents.
 *
 * Deliberately not a session-header field: the header's `meta` is a closed shape
 * the harness owns, and a development artifact must not need the harness to grow a
 * field for it. This file is plugin state, lives beside the ledger, and is the
 * only thing that decides who gets which role prompt.
 */
const BINDINGS_FILE = 'dev-agents.json'

/** The one canonical output shape every report tool uses. */
const stringOutput = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: unknown): { type: 'text'; text: string }[] => [
    { type: 'text', text: String(value) },
  ],
}

/** Render a thrown value for a report. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The package directory the running module belongs to.
 *
 * Walked rather than assumed: the same source is loaded as `lib/index.js` from a
 * profile install, as `src/index.ts` from a checkout under a type-stripping
 * runtime, and as a bundled artifact in tests. Every one of them sits under a
 * directory holding this package's `package.json`.
 * @returns the nearest ancestor directory that holds a `package.json`.
 */
function packageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(directory, 'package.json'))) return directory
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return directory
}

/** Render one problem as one log/grep-friendly line. */
function renderProblem(problem: RosterProblem): string {
  const where = problem.row === 0 ? 'document' : `row ${problem.row}`
  const id = problem.id === undefined ? '' : ` (${problem.id})`
  return `${where}${id}: ${problem.reason}`
}

/** What one roster read produced, for the tool output and the log. */
interface DevState {
  readonly agents: readonly DevAgent[]
  readonly problems: readonly RosterProblem[]
  readonly archive: string
}

/**
 * Install developer mode.
 *
 * Nothing is registered unless `config.devMode` is the literal boolean `true` —
 * the caller checks that through {@link devModeEnabled} — and nothing is published
 * to the harness at all: the section is a plugin-internal contribution, the tool
 * starts sessions this plugin owns, and the roster and bindings are files only
 * this plugin reads.
 * @param ctx - the plugin context (`systemPrompt` and `tools`).
 * @param peers - the peer service, which is how a developer session is created.
 * @param service - the report service, used to hand the new session its task.
 * @returns a disposer that removes every registration.
 */
export function installDevMode(ctx: Context, peers: HostPeers, service: HostService): () => void {
  const root = packageRoot()
  const rosterPath = join(root, ROSTER_FILE)
  const bindingsPath = join(ledgerRoot(), BINDINGS_FILE)
  // The roster is the gate, not the config flag: an installed tarball excludes
  // `dev/`, so it must get no dev tools and must never write into node_modules.
  // Cloning the repository is what makes developer mode possible.
  if (!existsSync(rosterPath)) return () => {}

  const readBindings = (): Map<string, string> => {
    try {
      return parseBindings(readFileSync(bindingsPath, 'utf8'))
    } catch {
      return new Map()
    }
  }

  const state: { current: DevState; bindings: Map<string, string> } = {
    current: { agents: [], problems: [], archive: '' },
    bindings: readBindings(),
  }

  const readRoster = (): DevState => {
    let text: string
    try {
      text = readFileSync(rosterPath, 'utf8')
    } catch {
      return {
        agents: [],
        problems: [{ row: 0, reason: `no roster at ${rosterPath} — developer mode only works from a source checkout` }],
        archive: readArchiveBlock(),
      }
    }
    // `promptFile` is written relative to the roster itself (`prompts/probe.md`),
    // not to the checkout root: the roster is the document the editor is looking at.
    const rosterDirectory = dirname(rosterPath)
    const parsed = parseRoster(text, (relativePath) => {
      try {
        const resolved = resolve(rosterDirectory, relativePath)
        const inside = relative(rosterDirectory, resolved)
        // A roster is branch data. Reading `../../.env` into a system prompt is a
        // path escape, not a prompt file: keep promptFile inside dev/.
        if (inside.startsWith('..') || isAbsolute(inside)) return undefined
        return readFileSync(resolved, 'utf8')
      } catch {
        return undefined
      }
    })
    return { agents: parsed.agents, problems: parsed.problems, archive: readArchiveBlock() }
  }

  /**
   * Render the injected history block from `dev/archive/index.yml`.
   *
   * Read here rather than fetched from the ledger: a fork has the repository and no
   * ledger, and the block a development agent sees must be exactly what the
   * committed index says. A missing or unreadable index is an empty history, never
   * a failed assembly.
   * @returns the block, or `''` when nothing is archived.
   */
  function readArchiveBlock(): string {
    try {
      const text = readFileSync(join(root, ARCHIVE_DIR, 'index.yml'), 'utf8')
      return renderIndexBlock(parseIndex(text).topics)
    } catch {
      return ''
    }
  }

  const reload = (): DevState => {
    state.current = readRoster()
    return state.current
  }

  state.current = readRoster()

  const renderState = (dev: DevState): string => {
    const active = dev.agents.filter((agent) => !agent.retired)
    const retired = dev.agents.filter((agent) => agent.retired)
    const bound = [...state.bindings.entries()]
    const byEntry = new Map<string, number>()
    for (const [, entryId] of bound) byEntry.set(entryId, (byEntry.get(entryId) ?? 0) + 1)
    const orphaned = bound.filter(([, entryId]) => !dev.agents.some((agent) => agent.id === entryId))
    const lines = [`developer roster: ${rosterPath}`]
    lines.push(active.length === 0
      ? 'enabled: none'
      : `enabled: ${active.length} — ${active.map((agent) => agent.id).join(', ')}`)
    if (retired.length > 0) {
      lines.push(`retired: ${retired.length} — ${retired.map((agent) => agent.id).join(', ')} (their bound sessions get the wind-down)`)
    }
    lines.push(dev.archive === '' ? 'archive: none' : `archive: ${dev.archive.split('\n').length} prompt line(s)`)
    lines.push(bound.length === 0
      ? 'bound sessions: none'
      : `bound sessions: ${bound.length}${[...byEntry.entries()].map(([entryId, count]) => `${count}×${entryId}`).join(' ')}`)
    if (orphaned.length > 0) {
      lines.push(`bound to an entry that is gone: ${orphaned.map(([session]) => session).join(', ')} — they lose the role prompt`)
    }
    lines.push(dev.problems.length === 0
      ? 'problems: none'
      : `problems: ${dev.problems.length}\n${dev.problems.map((problem) => `  ${renderProblem(problem)}`).join('\n')}`)
    return lines.join('\n')
  }

  const disposers: (() => void)[] = []

  disposers.push(ctx.systemPrompt.section({
    name: DEV_SECTION,
    order: DEV_SECTION_ORDER,
    // A prompt file is prose authored for a model, not a template: `{{` in it must
    // stay literal rather than fail assembly as an unknown variable.
    interpolate: false,
    text: (context: AssembleContext): string => {
      // A section provider that throws fails the whole assembly, and the cost of
      // being wrong here is every turn of every agent. Fail closed to "no text".
      try {
        const agent = context.agent
        if (agent === undefined) return ''
        const base = promptFor(state.current.agents, state.bindings.get(String(agent.id)))
        // Only a bound session gets the role: an assembly this plugin did not start
        // must stay byte-identical to a deployment without developer mode.
        if (base === '') return ''
        return state.current.archive === '' ? base : `${base}\n\n${state.current.archive}`
      } catch {
        return ''
      }
    },
  }))

  disposers.push(ctx.tools.register(defineTool({
    name: 'dev_agents_reload',
    description:
      'Developer mode only: re-read the developer roster (dev/agents.yml) and the history archive '
      + '(dev/archive/index.yml) from the checkout. Nothing is published to the harness — these agents are '
      + 'this plugin\'s own sessions — so this only refreshes what the plugin knows: which entries are enabled, '
      + 'which are retired, how many sessions are bound to each, and every roster row that could not be used. '
      + 'Editing YAML does not trigger the build watcher, so call this after an edit. A bad row is skipped and '
      + 'reported; the rest of the roster still applies.',
    parameters: {},
    output: stringOutput,
    execute: async (): Promise<string> => renderState(reload()),
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'dev_agent_start',
    description:
      'Developer mode only: start one agent from the developer roster (dev/agents.yml in this checkout) as a '
      + 'peer session, bound to this plugin. The role prompt and the archived conclusions are injected by the '
      + 'plugin itself, keyed by the binding it records — no harness preset is created, so nothing appears in '
      + 'the preset picker and the harness never learns the agent exists. The session is a normal peer: it '
      + 'outlives this turn, it receives its task as a report, and it counts against the peer budget. Retired '
      + 'entries cannot be started; they only wind down sessions already bound to them.',
    parameters: {
      entry: { type: 'string', required: true, description: 'Roster entry id to start, e.g. report-ledger:dev/probe.' },
      task: { type: 'string', required: true, description: 'What this developer agent should do first. It becomes the opening report body.' },
      name: { type: 'string', description: 'Optional display name; defaults to the roster entry name.' },
    },
    output: stringOutput,
    execute: async (args, exec) => {
      const input = args as { entry: string; task: string; name?: string }
      const agent = (exec as { agent?: { id?: string } }).agent
      const actor = typeof agent?.id === 'string' && agent.id !== '' ? agent.id : ''
      if (actor === '') throw new Error('report-ledger: dev_agent_start needs an owning agent session')
      const entry = state.current.agents.find((candidate) => candidate.id === input.entry.trim())
      if (entry === undefined) {
        const available = state.current.agents.filter((candidate) => !candidate.retired).map((candidate) => candidate.id)
        throw new Error(
          `report-ledger: no developer agent ${JSON.stringify(input.entry)} in dev/agents.yml; `
          + `startable: ${available.length === 0 ? '(none)' : available.join(', ')}`,
        )
      }
      if (entry.retired) {
        throw new Error(
          `report-ledger: ${entry.id} is retired — it cannot be started; it only winds down the sessions still `
          + 'bound to it',
        )
      }
      const delegated = await peers.start(actor, {
        task: input.task,
        name: input.name?.trim() === undefined || input.name.trim() === '' ? entry.name : input.name.trim(),
      })
      // Bind BEFORE the task is delivered: the first assembly is the first turn, and
      // a role that arrives one turn late is a role the agent never had.
      state.bindings.set(delegated.sessionId, entry.id)
      writeFileSync(bindingsPath, serializeBindings(state.bindings), 'utf8')
      const authored = await service.author({
        subject: `dev: ${entry.name}`,
        body: [
          `你是 ${entry.id}（${entry.name}），一个只在插件开发期存在的代理。`,
          '你的职责与历史结论由插件自己的提示词段注入，不来自任何 harness 预设——因此它不出现在预设选择器里。',
          '',
          '## 任务',
          input.task,
        ].join('\n'),
        actor,
        to: [delegated.sessionId],
        task: `dev-${entry.id}`,
      })
      return [
        `started ${entry.id} -> ${delegated.sessionId}`,
        `task report: ${authored.front.report} (task "dev-${entry.id}")`,
        `binding: ${delegated.sessionId} -> ${entry.id} (recorded in ${bindingsPath})`,
        'nothing was added to the harness: no preset, no picker entry',
      ].join('\n')
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'dev_archive',
    description:
      'Developer mode only, and it WRITES INTO THE CHECKOUT: distill reports from the ledger into '
      + 'dev/archive/<topic>.md and rebuild dev/archive/index.yml, so the conclusions survive a fork that does '
      + 'not inherit this machine\'s ledger. It keeps the conclusion-shaped sections (结论/决定/建议/风险/发现/未决/…), '
      + 'lists every heading so the omissions are visible, and caps the file at a size budget; it never copies '
      + 'whole bodies. Select reports with `task` (partial, case-insensitive) or an explicit `reports` list — '
      + 'never "everything", because the ledger is machine-global and holds unrelated work. Re-running a topic '
      + 'replaces its file and its index entry; the index is generated, so do not hand-edit it. Returns the file, '
      + 'its byte size against the budget, and how many index lines the development prompt now carries.',
    parameters: {
      task: { type: 'string', description: 'Archive every report carrying this task label (partial match, case-insensitive).' },
      reports: { type: 'array', items: { type: 'string' }, description: 'Explicit report ids to archive instead of a task filter.' },
      topic: { type: 'string', description: 'Topic slug for the file name; defaults to the task label, slugged (a label that slugs to nothing becomes "archive").' },
      summary: { type: 'string', description: 'One line that lets a reader decide whether to open the file. Defaults to a derived line.' },
    },
    output: stringOutput,
    execute: async (args): Promise<string> => {
      const input = args as { task?: string; reports?: string[]; topic?: string; summary?: string }
      const task = input.task?.trim() ?? ''
      const explicit = (input.reports ?? []).map((report) => report.trim()).filter((report) => report !== '')
      if (explicit.length === 0 && task === '') {
        throw new Error(
          'report-ledger: dev_archive needs `task` or `reports` — it will not archive the whole ledger, '
          + 'which is machine-global and holds unrelated work',
        )
      }

      const selected = explicit.length > 0
        ? explicit
        : (await listReports())
          .filter((front) => typeof front.task === 'string' && front.task.toLowerCase().includes(task.toLowerCase()))
          .map((front) => front.report)
      if (selected.length === 0) {
        throw new Error(`report-ledger: no report matched ${explicit.length > 0 ? 'that report list' : `task ${JSON.stringify(task)}`}`)
      }

      const sources: ArchiveSource[] = []
      const missing: string[] = []
      for (const id of selected) {
        const found = await readReport(id)
        if (found === undefined) {
          missing.push(id)
          continue
        }
        sources.push({ front: found.front, body: found.body })
      }
      if (missing.length > 0) {
        throw new Error(`report-ledger: no such report(s) in the ledger: ${missing.join(', ')}`)
      }

      const label = input.topic?.trim() ?? (task === '' ? sources[0].front.task ?? '' : task)
      const topic = topicSlug(label)
      const updated = Math.max(...sources.map((source) => source.front.updated))
      const summary = input.summary?.trim()
        ?? `${sources[0].front.subject.slice(0, 60)}${sources.length > 1 ? ` 等 ${sources.length} 份` : ''}`
      const entry: ArchiveTopic = {
        topic,
        file: `${topic}.md`,
        summary,
        reports: sources.map((source) => source.front.report),
        updated,
      }

      const directory = join(root, ARCHIVE_DIR)
      mkdirSync(directory, { recursive: true })
      const fileText = renderArchive(entry, sources)
      writeFileSync(join(directory, entry.file), fileText, 'utf8')

      // Rebuild the whole index from what is on disk plus this entry: the files are
      // the source of truth, and the index is the generated view of them.
      const topics = new Map<string, ArchiveTopic>()
      for (const known of readIndexFile(directory)) topics.set(known.topic, known)
      topics.set(entry.topic, entry)
      const ordered = [...topics.values()].sort((left, right) => left.topic.localeCompare(right.topic))
      writeFileSync(join(directory, 'index.yml'), renderIndex(ordered, Date.now()), 'utf8')
      state.current = { ...state.current, archive: renderIndexBlock(ordered) }

      const block = renderIndexBlock(ordered)
      const bytes = Buffer.byteLength(fileText, 'utf8')
      return [
        `archived ${entry.reports.join(', ')} -> dev/archive/${entry.file}`,
        `topic: ${entry.topic} · summary: ${entry.summary}`,
        `file: ${bytes} bytes (budget ${MAX_ARCHIVE_BYTES})${bytes >= MAX_ARCHIVE_BYTES ? ' — TRUNCATED, see the marker at the end' : ''}`,
        `index: dev/archive/index.yml (${ordered.length} topic(s))`,
        `prompt block: ${block === '' ? 0 : block.split('\n').length} line(s) (budget ${MAX_INDEX_LINES} list lines)`,
        'bound development sessions see it on their next turn; no reload needed',
      ].join('\n')
    },
  })))

  // Initial read. Deferred rather than awaited: activation must not wait on the
  // filesystem, and a roster problem is a log line, not a reason to refuse to load.
  queueMicrotask(() => {
    for (const problem of state.current.problems) {
      ctx.logger?.warn?.(`report-ledger: developer roster ${renderProblem(problem)}`)
    }
  })

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }

  /** Read the archive index from disk, tolerating a missing or broken file. */
  function readIndexFile(directory: string): readonly ArchiveTopic[] {
    try {
      return parseIndex(readFileSync(join(directory, 'index.yml'), 'utf8')).topics
    } catch {
      return []
    }
  }
}

/** The host services this add-on needs from the harness, like the release entry. */
export const inject = ['tools', 'systemPrompt', 'agents']

/** How often the add-on re-reads the profile manifest, in milliseconds. */
const MANIFEST_POLL_MS = 500

/** The release bundle's name in `dsh.profile.bundles`. */
const RELEASE_BUNDLE = 'dsh-report-ledger'

/**
 * Whether this profile still selects the release bundle.
 *
 * Developer mode is an overlay on the released plugin, not a standalone deployment:
 * the add-on only runs while that bundle is still selected. A profile row's
 * `baseUrl` points at the profile directory as a file URL, which is where the
 * manifest lives.
 * @param ctx - the plugin context.
 * @returns true/false, or undefined when the manifest cannot be read — a checkout
 *   always can, so undefined is treated as "proceed" rather than blocking a
 *   contributor whose profile is laid out unexpectedly.
 */
function releaseBundleSelected(ctx: Context): boolean | undefined {
  if (ctx.baseUrl === undefined) return undefined
  try {
    const directory = fileURLToPath(new URL('.', ctx.baseUrl))
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      dsh?: { profile?: { bundles?: unknown } }
    }
    const bundles = manifest.dsh?.profile?.bundles
    return Array.isArray(bundles) && bundles.includes(RELEASE_BUNDLE)
  } catch {
    return undefined
  }
}

/**
 * Developer-mode plugin entry.
 *
 * The add-on mounts the release package's host half through the shared
 * single-instance queue and installs this checkout's developer tools on the live
 * services. It is an *overlay*: while the profile stops selecting the release
 * bundle, the mounted half is torn down and the add-on waits, re-checking the
 * manifest, so developer mode can never become the deployment on its own.
 *
 * The teardown goes through a child plugin fiber: everything `mountHost` registers
 * belongs to that fiber, so disposing it unmounts exactly the host half — including
 * the single-instance slot and any pending wait — without unloading this row.
 * @param ctx - the plugin context (`tools`, `systemPrompt`, `agents` injected).
 * @param config - the add-on row's config (announce, peer budget, worktree).
 */
export function apply(ctx: Context, config?: Config): void {
  let fiber: Fiber | undefined
  let settling = false

  function hostHalf(sub: Context): void {
    mountWhenFree(sub, () => {
      const host: HostHalf = mountHost(sub, config)
      sub.effect(() => installDevMode(sub, host.peers, host.service), 'report-ledger-dev: developer mode')
    })
  }

  const stop = (): void => {
    if (fiber === undefined) return
    settling = true
    const stopping = fiber.dispose()
    fiber = undefined
    void stopping.finally(() => { settling = false })
  }

  const start = (): void => {
    if (fiber !== undefined || settling) return
    fiber = ctx.plugin(hostHalf)
  }

  const tick = (): void => {
    if (releaseBundleSelected(ctx) === false) {
      if (fiber !== undefined) {
        ctx.logger?.warn?.('report-ledger-dev: the dsh-report-ledger bundle is not selected; '
          + 'developer mode waits until it is enabled again.')
      }
      stop()
      return
    }
    start()
  }

  tick()
  const timer = setInterval(tick, MANIFEST_POLL_MS)
  ctx.effect(() => () => {
    clearInterval(timer)
    if (fiber !== undefined) {
      const stopping = fiber.dispose()
      fiber = undefined
      void stopping
    }
  }, 'report-ledger-dev: manifest watch')
}
