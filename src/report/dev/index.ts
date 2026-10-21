/**
 * Developer mode — the switch-gated half that exists only while this plugin is
 * being developed.
 *
 * A published deployment must be byte-identical to what shipped, so everything
 * here is behind one boolean and nothing is registered when it is off: no prompt
 * section, no tool, no preset. That is what makes "hidden" cheap and honest — not
 * a filter over a visible list, but an absent registration.
 *
 * When it is on, the composition does two things that cannot be expressed as
 * configuration:
 *
 *  1. **It publishes agents into the preset roster.** Those agents appear in the
 *     picker beside the shipped presets, which is the point: a human developing
 *     this plugin needs to be able to start one. They are registered through the
 *     same `agentPresets.register` the `@deepseek-ai/dsh-agent-preset` row itself
 *     calls, so a runtime registration is exactly as real as a YAML declaration.
 *  2. **It routes one prompt section to them and nobody else.** The section is a
 *     per-assembly provider: it reads the assembling agent's preset id and returns
 *     that roster entry's text, or `''` for every other agent. An empty section is
 *     dropped during rendering, so a normal agent's prompt does not change by a
 *     single byte.
 *
 * The roster is data in the checkout (`dev/agents.yml`), not configuration, so a
 * branch or working tree carries its own set of developer agents — which is the
 * reason this exists at all: the candidate implementation and the roster that
 * measures it travel together.
 *
 * `dev_agents_reload` reads the roster again and diffs it against what is mounted.
 * It is the only path from an edited file to a live picker: editing YAML does not
 * trigger HMR, which watches `lib/`, and pretending otherwise would leave the
 * prompt and the picker disagreeing.
 *
 * @module dsh-report-ledger/report/dev
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only, and load-bearing: it is what adds `agent` to `AssembleContext`, so the
// section provider can read the assembling session at all. Erased at build time.
import type {} from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { listReports, readReport } from '../ledger.ts'
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
  parseRoster,
  promptFor,
  signatureOf,
  type DevAgent,
  type RosterProblem,
} from './roster.ts'

/** Name of the prompt section a developer agent receives. */
const DEV_SECTION = 'plugin:report-ledger:dev'

/** Where the roster lives inside the checkout. */
const ROSTER_FILE = join('dev', 'agents.yml')

/** Where the archive index lives, relative to the checkout root. */
const ARCHIVE_DIR = join('dev', 'archive')

/**
 * Structural face of the agent-preset registry this half needs.
 *
 * Deliberately local: the package that owns the registry is not a dependency of a
 * third-party plugin, and only these two methods are used. `register` is the same
 * call a YAML preset row makes; `composedPreset` is how an assembly learns which
 * preset it is running.
 */
interface PresetRegistryLike {
  register(definition: {
    readonly id: string
    readonly name: string
    readonly description: string
    readonly order: number
    readonly plugins: readonly unknown[]
  }): Promise<() => void | Promise<void>>
  composedPreset(agentCtx: Context): string | undefined
  /** Every declared preset, including ones whose composition failed to mount. */
  list?(): Promise<readonly { readonly id: string; readonly broken?: string }[]>
}

/** What one roster sync did, for the reload tool and the log. */
interface SyncReport {
  readonly path: string
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly problems: readonly RosterProblem[]
}

/** A mounted preset and the signature it was mounted from. */
interface MountedPreset {
  readonly dispose: () => void | Promise<void>
  readonly signature: string
}

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

/** How long a duplicate-id registration waits for the previous owner to let go. */
const RELEASE_WAIT_MS = 40

/** Attempts before a duplicate id is reported instead of waited for. */
const RELEASE_ATTEMPTS = 10

/** Wait one beat without keeping the process alive for it. */
function waitBriefly(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}

/** Empty a preset mount without letting its failure escape the caller. */
async function disposeQuietly(dispose: () => void | Promise<void>): Promise<void> {
  try {
    await dispose()
  } catch {
    // Disposal is bookkeeping at shutdown time; a failure here has nowhere better
    // to go than the caller's log, and the caller has already moved on.
  }
}

/** Render one problem as a single log/grep-friendly line. */
function renderProblem(problem: RosterProblem): string {
  const where = problem.row === 0 ? 'document' : `row ${problem.row}`
  const id = problem.id === undefined ? '' : ` (${problem.id})`
  return `${where}${id}: ${problem.reason}`
}

/** Render one sync as the reload tool's answer. */
function renderSync(report: SyncReport, enabled: readonly DevAgent[], broken: readonly RosterProblem[]): string {
  const active = enabled.filter((agent) => !agent.retired)
  const retired = enabled.filter((agent) => agent.retired)
  const problems = [...report.problems, ...broken]
  const lines = [`developer roster: ${report.path}`]
  lines.push(active.length === 0
    ? 'enabled: none'
    : `enabled: ${active.length} — ${active.map((agent) => agent.id).join(', ')}`)
  if (retired.length > 0) {
    lines.push(`retired: ${retired.length} — ${retired.map((agent) => agent.id).join(', ')} (still routed: their live sessions get the wind-down)`)
  }
  if (report.added.length > 0) lines.push(`added: ${report.added.join(', ')}`)
  if (report.removed.length > 0) lines.push(`removed: ${report.removed.join(', ')}`)
  lines.push(problems.length === 0
    ? 'problems: none'
    : `problems: ${problems.length}\n${problems.map((problem) => `  ${renderProblem(problem)}`).join('\n')}`)
  return lines.join('\n')
}

/**
 * Rows this roster registered that the registry reports as unusable.
 *
 * A definition enters the roster before its composition is activated, and a
 * failed mount leaves it there marked `broken`, filtered out of the picker. Without
 * this, "registered" and "selectable" would look identical to the agent that just
 * edited the file — the failure would be silent exactly where it matters.
 *
 * Deliberately never called during activation: the registry's diagnostic awaits
 * the Host Loader tree settling, which would wait on the activation it was called
 * from.
 * @param registry - the preset registry.
 * @param agents - the entries this roster just mounted.
 * @returns one problem per unusable definition of ours.
 */
async function brokenOf(registry: PresetRegistryLike, agents: readonly DevAgent[]): Promise<RosterProblem[]> {
  if (registry.list === undefined) return []
  try {
    const rows = await registry.list()
    const ours = new Set(agents.map((agent) => agent.id))
    const broken: RosterProblem[] = []
    for (const row of rows) {
      if (!ours.has(row.id)) continue
      if (typeof row.broken !== 'string' || row.broken === '') continue
      broken.push({ row: 0, id: row.id, reason: row.broken })
    }
    return broken
  } catch (error) {
    return [{ row: 0, reason: `could not read the preset roster back: ${message(error)}` }]
  }
}

/**
 * Install developer mode on a host context that has a preset roster.
 *
 * Nothing is registered unless `config.devMode` is the literal boolean `true` —
 * see {@link devModeEnabled} — and nothing at all is installed on a deployment
 * that composes no agent-preset roster, since there would be no picker for the
 * agents to appear in and no way to select them.
 * @param ctx - the plugin context (`systemPrompt`, `tools`, and the optional
 *   `agentPresets` service).
 * @returns a disposer that removes every registration, including the presets.
 */
export function installDevMode(ctx: Context): () => void {
  const registry = ctx.get('agentPresets') as unknown as PresetRegistryLike | undefined
  if (registry === undefined) {
    ctx.logger?.warn?.(
      'report-ledger: devMode is on, but this deployment composes no agent-preset roster — '
      + 'no developer agent can be enabled',
    )
    return () => {}
  }

  const root = packageRoot()
  const rosterPath = join(root, ROSTER_FILE)

  const state: { agents: readonly DevAgent[]; archive: string } = { agents: [], archive: '' }
  const mounted = new Map<string, MountedPreset>()
  /** Serializes syncs so two reload calls cannot double-register one entry. */
  let chain: Promise<unknown> = Promise.resolve()

  /**
   * Read the archive index from disk.
   *
   * Tolerated rather than thrown: a missing index is "nothing archived yet", and a
   * hand-broken one must cost an empty history line, not a failed activation.
   * @param directory - the archive directory.
   * @returns the parsed topics, empty on any failure.
   */
  const readIndexFile = (directory: string): { topics: readonly ArchiveTopic[] } => {
    try {
      return parseIndex(readFileSync(join(directory, 'index.yml'), 'utf8'))
    } catch {
      return { topics: [] }
    }
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
  const readArchiveBlock = (): string => renderIndexBlock(readIndexFile(join(root, ARCHIVE_DIR)).topics)

  // Read once at activation: the archive changes only when dev_archive writes it,
  // and that path updates the cached block itself.
  state.archive = readArchiveBlock()

  const readRoster = (): { agents: readonly DevAgent[]; problems: readonly RosterProblem[] } => {
    let text: string
    try {
      text = readFileSync(rosterPath, 'utf8')
    } catch {
      return { agents: [], problems: [{ row: 0, reason: `no roster at ${rosterPath}` }] }
    }
    // `promptFile` is written relative to the roster itself (`prompts/probe.md`),
    // not to the checkout root: the roster is the document the editor is looking at.
    const rosterDirectory = dirname(rosterPath)
    return parseRoster(text, (relativePath) => {
      try {
        return readFileSync(resolve(rosterDirectory, relativePath), 'utf8')
      } catch {
        return undefined
      }
    })
  }

  const syncOnce = async (): Promise<SyncReport> => {
    const parsed = readRoster()
    // A retired entry stays in the roster — its live sessions keep their prompt and
    // gain the wind-down — but it is never published: no new session may start on
    // it, which is what "no longer enabled" means here.
    const desired = new Map(parsed.agents.filter((agent) => !agent.retired).map((agent) => [agent.id, agent]))

    const removed: string[] = []
    for (const [id, entry] of [...mounted]) {
      const next = desired.get(id)
      if (next !== undefined && signatureOf(next) === entry.signature) continue
      mounted.delete(id)
      if (next === undefined) removed.push(id)
      await disposeQuietly(entry.dispose)
    }

    const added: string[] = []
    const failures: RosterProblem[] = []
    for (const agent of parsed.agents) {
      // A retired entry is deliberately not published — the same reason `desired`
      // excludes it above. Without this guard the row is disposed as "no longer
      // wanted" and immediately registered again, which is how a retired agent
      // stays selectable while the output claims it was removed.
      if (agent.retired) continue
      if (mounted.has(agent.id)) continue
      const definition = {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        order: agent.order,
        plugins: [],
      }
      for (let attempt = 1; ; attempt += 1) {
        try {
          const dispose = await registry.register(definition)
          mounted.set(agent.id, { dispose, signature: signatureOf(agent) })
          added.push(agent.id)
          break
        } catch (error) {
          // The id is still held by the instance this reload just replaced: HMR
          // disposes the previous plugin instance and applies the new one, and the
          // old definition's own release is asynchronous. Waiting a beat is the
          // difference between "the roster silently went empty on every save" and
          // a reload that is merely a few milliseconds late.
          if (/Duplicate agent preset/.test(message(error)) && attempt < RELEASE_ATTEMPTS) {
            await waitBriefly(RELEASE_WAIT_MS)
            continue
          }
          // One unusable definition must not take the rest of the roster with it.
          failures.push({ row: 0, id: agent.id, reason: message(error) })
          break
        }
      }
    }

    state.agents = parsed.agents
    return { path: rosterPath, added, removed, problems: [...parsed.problems, ...failures] }
  }

  const sync = (): Promise<SyncReport> => {
    const run = (): Promise<SyncReport> => syncOnce()
    const next = chain.then(run, run)
    chain = next.catch(() => undefined)
    return next
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
        const base = promptFor(state.agents, registry.composedPreset(agent.ctx))
        // Only a developer agent gets the history block: an assembly that matched no
        // roster entry must stay byte-identical to a deployment without dev mode.
        if (base === '') return ''
        return state.archive === '' ? base : `${base}\n\n${state.archive}`
      } catch {
        return ''
      }
    },
  }))

  disposers.push(ctx.tools.register(defineTool({
    name: 'dev_agents_reload',
    description:
      'Developer mode only: read the developer-agent roster (dev/agents.yml in the plugin checkout) again and '
      + 'apply the difference to the preset picker — presets that disappeared are removed, new ones are '
      + 'registered, renamed ones are re-registered. Use it after editing the roster, because editing YAML does '
      + 'not trigger the build watcher. Returns what was added, removed, enabled now, and every row that could '
      + 'not be used. A bad row is skipped and reported; the rest of the roster still applies.',
    parameters: {},
    output: stringOutput,
    execute: async (): Promise<string> => {
      const report = await sync()
      return renderSync(report, state.agents, await brokenOf(registry, state.agents))
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
      const indexText = readIndexFile(directory)
      const topics = new Map<string, ArchiveTopic>()
      for (const known of indexText.topics) topics.set(known.topic, known)
      topics.set(entry.topic, entry)
      const ordered = [...topics.values()].sort((left, right) => left.topic.localeCompare(right.topic))
      writeFileSync(join(directory, 'index.yml'), renderIndex(ordered, Date.now()), 'utf8')
      state.archive = renderIndexBlock(ordered)

      const bytes = Buffer.byteLength(fileText, 'utf8')
      return [
        `archived ${entry.reports.join(', ')} -> dev/archive/${entry.file}`,
        `topic: ${entry.topic} · summary: ${entry.summary}`,
        `file: ${bytes} bytes (budget ${MAX_ARCHIVE_BYTES})${bytes >= MAX_ARCHIVE_BYTES ? ' — TRUNCATED, see the marker at the end' : ''}`,
        `index: dev/archive/index.yml (${ordered.length} topic(s))`,
        `prompt block: ${renderIndexBlock(ordered) === '' ? 0 : renderIndexBlock(ordered).split('\n').length} line(s) (budget ${MAX_INDEX_LINES} list lines)`,
        'the development prompt now carries it; no reload needed',
      ].join('\n')
    },
  })))

  // Initial load. Deferred rather than awaited: plugin activation must not wait on
  // a filesystem read or a preset mount, and a roster problem is a log line, not a
  // reason to refuse to load.
  void sync().then(
    (report) => {
      for (const problem of report.problems) {
        ctx.logger?.warn?.(`report-ledger: developer roster ${renderProblem(problem)}`)
      }
    },
    (error: unknown) => {
      ctx.logger?.warn?.(`report-ledger: developer roster could not be loaded: ${message(error)}`)
    },
  )

  return () => {
    for (const dispose of disposers.reverse()) dispose()
    for (const entry of mounted.values()) void disposeQuietly(entry.dispose)
    mounted.clear()
    state.agents = []
  }
}
