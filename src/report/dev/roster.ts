/**
 * The developer-mode roster: which agents exist only while this plugin is being
 * developed.
 *
 * This module is deliberately pure. Reading the file, registering presets and
 * rendering prompt sections all live next door in `dev/index.ts`; here there is
 * only "text in, entries out", so the parsing rules that decide whether a
 * developer's edited roster takes effect can be pinned by deterministic checks
 * without a harness, a filesystem, or a live registry.
 *
 * Two rules shape every decision below, and both come from the way this roster
 * is used rather than from taste:
 *
 *  - **One bad row must not disable the rest.** The list is edited by hand while
 *    the plugin is being developed, so a typo is routine. A row that cannot be
 *    used is reported and skipped; the other agents still exist, and the reload
 *    surface shows exactly which row was dropped and why.
 *  - **The roster is data, not configuration.** It sits inside the checkout, so a
 *    branch or a working tree can carry its own set of developer agents, which is
 *    the whole point: the candidate implementation and the roster that measures
 *    it travel together.
 *
 * @module dsh-report-ledger/report/dev/roster
 */

import { parse as parseYaml } from 'yaml'

/** One agent developer mode enables, with its prompt already resolved. */
export interface DevAgent {
  /** Preset id — also the identity the session header records. */
  readonly id: string
  /** Display name in the preset picker. */
  readonly name: string
  /** One sentence on what this agent is for, shown beside the name. */
  readonly description: string
  /** Roster order in the picker. */
  readonly order: number
  /** The section text this agent receives and no other agent does. */
  readonly prompt: string
  /**
   * Whether this entry has been retired.
   *
   * A retired entry is no longer registered as a selectable preset — no new
   * session can be created on it — but it stays in the roster so sessions already
   * running it learn that they are winding down instead of silently losing their
   * instructions.
   */
  readonly retired: boolean
}

/** One roster row that could not be used, and why. */
export interface RosterProblem {
  /** 1-based row within the `agents` sequence; `0` means the document itself. */
  readonly row: number
  /** The row's id, when it had a usable one. */
  readonly id?: string
  /** What is wrong, phrased as something the editor can fix. */
  readonly reason: string
}

/** Everything one roster read produced. */
export interface ParsedRoster {
  /** The usable entries, in roster order. */
  readonly agents: readonly DevAgent[]
  /** Every row that was skipped or the document-level fault. */
  readonly problems: readonly RosterProblem[]
}

/**
 * Order of the developer-mode prompt section.
 *
 * Directly after the protocol pair (200, 201): the two shipped sections explain
 * the ledger, and this one — only for a developer agent — says what that agent
 * is measuring.
 */
export const DEV_SECTION_ORDER = 202

/**
 * Shape a preset id must have.
 *
 * The id is not decoration: it is the preset identity saved into a session
 * header, the string a roster entry is looked up by, and the value the preset
 * registry refuses as a duplicate. Keeping it to an unambiguous character set
 * means a typo produces a reported row instead of an id the registry rejects
 * after the file was already read.
 */
const PRESET_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/

/** Spacing used to derive `order` for rows that omit it. */
const ORDER_STEP = 10

/**
 * Whether the composition asked for developer mode.
 *
 * Strict on purpose: only the literal boolean `true` enables it. A string
 * `"false"` from a hand-edited YAML scalar must not read as truthy, and a
 * published deployment that never sets the field must keep today's behaviour
 * byte for byte.
 * @param config - resolved plugin config, if the composition row passed one.
 * @returns true only for the literal boolean `true`.
 */
export function devModeEnabled(config: { readonly devMode?: unknown } | undefined): boolean {
  return config?.devMode === true
}

/**
 * The prompt one preset id receives.
 * @param agents - the roster currently in effect.
 * @param presetId - the preset the assembling agent runs, when it has one.
 * @returns the entry's prompt — plus the wind-down instruction when it is retired
 *   — or `''` for every other agent.
 */
export function promptFor(agents: readonly DevAgent[], presetId: string | undefined): string {
  if (presetId === undefined || presetId === '') return ''
  for (const agent of agents) {
    if (agent.id !== presetId) continue
    return agent.retired ? `${agent.prompt}\n${WIND_DOWN}` : agent.prompt
  }
  return ''
}

/**
 * Parse the plugin's own record of which sessions are developer agents.
 *
 * The file is the whole mechanism: a developer agent is a session this plugin
 * started, and the only thing that makes it one is an entry here. Keeping it out
 * of the session header is deliberate — that shape belongs to the harness, and a
 * development artifact must not require the harness to grow a field.
 *
 * Tolerant on purpose: a corrupt file costs the role prompt, never an activation.
 * @param text - the bindings file contents.
 * @returns session id → roster entry id.
 */
export function parseBindings(text: string): Map<string, string> {
  const bindings = new Map<string, string>()
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return bindings
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return bindings
  for (const [session, entry] of Object.entries(document as Record<string, unknown>)) {
    if (session === '' || typeof entry !== 'string' || entry === '') continue
    bindings.set(session, entry)
  }
  return bindings
}

/**
 * Serialize the binding map.
 *
 * Session ids are sorted so re-writing the file after one start produces a diff of
 * one line rather than a reshuffle — this file is committed nowhere, but it is read
 * by humans debugging a role that failed to appear.
 * @param bindings - session id → roster entry id.
 * @returns the file text.
 */
export function serializeBindings(bindings: ReadonlyMap<string, string>): string {
  const document: Record<string, string> = {}
  for (const [session, entry] of [...bindings.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    document[session] = entry
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * What a retired entry's agent is told instead of new work.
 *
 * It replaces the silent version of retirement: removing an entry from the roster
 * used to leave a live session running with an empty prompt — present, but with
 * no idea why. A retired entry keeps its own instructions and gains this.
 */
export const WIND_DOWN = [
  '',
  '## 你已被声明退役',
  '',
  '这是名单里的 `retired: true`，不是别人的口信。你的会话仍然存在，但不再接新工作，只做收尾：',
  '',
  '1. 用 `report_handover` 把手上的一切交出去：它先列出你仍开着的汇报、仍占着的检出、仍欠你的待送达；',
  '2. 你判断已经完成的汇报，在同一次调用的 `close` 里点名结案，其余留给继任者；',
  '3. 交接本身会落成一份 `task: handover` 汇报——那就是你留下的清单，后人不必猜。',
  '',
  '退役期间不要开新的汇报线，也不要再开同伴。账本里已经属于你的东西不会因为你退役而消失，',
  '它们只是换了一个人负责。',
].join('\n')

/**
 * The part of an entry a preset registration depends on.
 *
 * The prompt is absent on purpose: prompt text is rendered by a section provider
 * that reads the roster live, so editing it needs no re-registration. An id whose
 * name, description or order changed does need one, and this is what detects it.
 * @param agent - the roster entry.
 * @returns a comparable signature.
 */
export function signatureOf(agent: DevAgent): string {
  return [agent.name, agent.description, String(agent.order), String(agent.retired)].join('\u0000')
}

/** A roster document as the plain-object tree a YAML parser produced. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** A trimmed non-empty string, or undefined. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Render a thrown value for a problem report. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Parse one roster document.
 *
 * Rows are validated in a fixed order — identity, then prompt source — so a row
 * with two faults reports the first one an editor would want to fix, and a
 * duplicate is rejected before its prompt file is read.
 * @param text - the roster document.
 * @param readPromptFile - resolves a `promptFile` relative to the roster's
 *   directory; returns undefined when the file is missing or unreadable.
 * @returns the usable entries and every problem found.
 */
export function parseRoster(
  text: string,
  readPromptFile: (relativePath: string) => string | undefined,
): ParsedRoster {
  let document: unknown
  try {
    document = parseYaml(text)
  } catch (error) {
    return { agents: [], problems: [{ row: 0, reason: `the roster is not valid YAML: ${message(error)}` }] }
  }

  const rows = asRecord(document)?.agents
  if (!Array.isArray(rows)) {
    return {
      agents: [],
      problems: [{ row: 0, reason: 'the roster must be a mapping whose `agents` key is a sequence' }],
    }
  }

  const agents: DevAgent[] = []
  const problems: RosterProblem[] = []
  const seen = new Set<string>()

  rows.forEach((raw, index) => {
    const row = index + 1
    const record = asRecord(raw)
    if (record === undefined) {
      problems.push({ row, reason: 'a roster row must be a mapping' })
      return
    }

    const id = nonEmptyString(record.id)
    if (id === undefined) {
      problems.push({ row, reason: 'a roster row needs a non-empty `id`' })
      return
    }
    if (!PRESET_ID.test(id)) {
      problems.push({ row, id, reason: `\`${id}\` is not a usable preset id (letters, digits, and . _ : / - only)` })
      return
    }
    if (seen.has(id)) {
      problems.push({ row, id, reason: `duplicate id \`${id}\`; the first row wins` })
      return
    }

    const inline = nonEmptyString(record.prompt)
    const file = nonEmptyString(record.promptFile)
    if (inline !== undefined && file !== undefined) {
      problems.push({ row, id, reason: 'a row carries `prompt` and `promptFile`; keep exactly one' })
      return
    }
    let prompt = inline
    if (prompt === undefined && file !== undefined) {
      prompt = nonEmptyString(readPromptFile(file))
      if (prompt === undefined) {
        problems.push({ row, id, reason: `\`promptFile\` ${file} could not be read, or is empty` })
        return
      }
    }
    if (prompt === undefined) {
      problems.push({ row, id, reason: 'a row needs `prompt` or `promptFile`' })
      return
    }
    if (record.retired !== undefined && typeof record.retired !== 'boolean') {
      problems.push({ row, id, reason: '`retired` must be a boolean (true or false)' })
      return
    }

    const order = typeof record.order === 'number' && Number.isFinite(record.order)
      ? record.order
      : (index + 1) * ORDER_STEP

    seen.add(id)
    agents.push({
      id,
      name: nonEmptyString(record.name) ?? id,
      description: nonEmptyString(record.description) ?? '',
      order,
      prompt,
      retired: record.retired === true,
    })
  })

  return { agents, problems }
}
