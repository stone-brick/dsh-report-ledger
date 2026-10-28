// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts and `filter` silently resolves to the DOM's window.filter.
// Emitted as nothing; it exists so `tsc` treats the file as its own module.
export {}
/**
 * Deterministic checks for the developer-mode roster.
 *
 * Two things are worth pinning here, and neither needs a harness:
 *
 *  - **The parser.** The roster is branch data read from the checkout, and this is
 *    the same parser the add-on bundle loads it with — the committed `dev/agents.yml`
 *    is checked against it rather than against a hand-written expectation.
 *  - **Row-level failure isolation.** The roster is hand-edited while the plugin is
 *    developed; a typo must cost one agent, never the list. Each way a row can be
 *    unusable is asserted to report the row and leave its neighbours in place.
 *
 * The committed `dev/agents.yml` is read as well, so the shipped roster is checked
 * against the same parser that will load it.
 *
 * Run: node scripts/dev-roster-check.ts
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const {
  DEV_SECTION_ORDER,
  parseBindings,
  parseRoster,
  promptFor,
  serializeBindings,
  signatureOf,
} = await import('../dev/bundle/src/roster.ts')
const { PARTNERSHIP_SECTION_ORDER, SECTION_ORDER } = await import('../src/report/guidance.ts')

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

/** Files a test roster can refer to by relative path. */
const files: Record<string, string> = {
  'prompts/probe.md': '  # probe\n\nmeasure friction, keep evidence  \n',
  'prompts/verifier.md': '# verifier\n',
}

/** A roster reader backed by the map above. */
const read = (path: string): string | undefined => files[path]

/** Parse a document with the map reader. */
const parse = (text: string) => parseRoster(text, read)

// ---- the roster is the gate, and the add-on is where it lives --------------
check('a namespaced id with a slash is accepted', parse('agents:\n  - id: a/b\n    prompt: x\n').agents.length === 1)

// ---- the section sits after the shipped pair -----------------------------
check('dev section order is 202', DEV_SECTION_ORDER === 202, String(DEV_SECTION_ORDER))
check('dev section order follows the protocol section', DEV_SECTION_ORDER > SECTION_ORDER)
check('dev section order follows the partnership section', DEV_SECTION_ORDER > PARTNERSHIP_SECTION_ORDER)

// ---- a healthy roster ----------------------------------------------------
const healthy = parse([
  'agents:',
  '  - id: report-ledger:dev/probe',
  '    name: 探查者',
  '    description: 真实使用账本',
  '    promptFile: prompts/probe.md',
  '  - id: report-ledger:dev/verifier',
  '    prompt: "  # inline prompt  "',
].join('\n'))
check('a healthy roster yields both agents', healthy.agents.length === 2, String(healthy.agents.length))
check('a healthy roster reports no problems', healthy.problems.length === 0,
  healthy.problems.map((p) => p.reason).join('; '))
check('the prompt file is resolved from the roster directory',
  healthy.agents[0]?.prompt.includes('measure friction') === true)
check('a prompt file is trimmed', healthy.agents[0]?.prompt.endsWith('evidence') === true,
  JSON.stringify(healthy.agents[0]?.prompt.slice(-20)))
check('an inline prompt is accepted and trimmed',
  healthy.agents[1]?.prompt === '# inline prompt', JSON.stringify(healthy.agents[1]?.prompt))
check('an omitted order defaults by position', healthy.agents[0]?.order === 10 && healthy.agents[1]?.order === 20,
  `${healthy.agents[0]?.order}/${healthy.agents[1]?.order}`)
check('an omitted name falls back to the id', parse('agents:\n  - id: a\n    prompt: x\n').agents[0]?.name === 'a')
check('an omitted description becomes empty', parse('agents:\n  - id: a\n    prompt: x\n').agents[0]?.description === '')

// ---- one bad row costs one agent ----------------------------------------
const duplicate = parse([
  'agents:',
  '  - id: same',
  '    prompt: one',
  '  - id: same',
  '    prompt: two',
].join('\n'))
check('a duplicate id keeps the first row', duplicate.agents.length === 1 && duplicate.agents[0]?.prompt === 'one',
  JSON.stringify(duplicate.agents))
check('a duplicate id is reported against the second row',
  duplicate.problems.length === 1 && duplicate.problems[0]?.row === 2,
  JSON.stringify(duplicate.problems))

const bothKinds = parse([
  'agents:',
  '  - id: a',
  '    prompt: inline',
  '    promptFile: prompts/probe.md',
  '  - id: b',
  '    prompt: fine',
].join('\n'))
check('carrying both prompt kinds skips that row', bothKinds.agents.length === 1 && bothKinds.agents[0]?.id === 'b',
  JSON.stringify(bothKinds.agents.map((a) => a.id)))
check('carrying both prompt kinds is reported', bothKinds.problems[0]?.row === 1 && /exactly one/.test(bothKinds.problems[0]?.reason ?? ''),
  JSON.stringify(bothKinds.problems))

const missingFile = parse('agents:\n  - id: a\n    promptFile: prompts/nope.md\n  - id: b\n    prompt: ok\n')
check('a missing prompt file skips that row only', missingFile.agents.length === 1 && missingFile.agents[0]?.id === 'b')
check('a missing prompt file is named in the problem',
  /prompts\/nope\.md/.test(missingFile.problems[0]?.reason ?? ''), JSON.stringify(missingFile.problems))

const badId = parse('agents:\n  - id: "has space"\n    prompt: x\n  - id: b\n    prompt: y\n')
check('an unusable id skips that row only', badId.agents.length === 1 && badId.agents[0]?.id === 'b')
check('an unusable id is reported with the row', badId.problems[0]?.row === 1 && badId.problems[0]?.id === 'has space')

const noSource = parse('agents:\n  - id: a\n  - id: b\n    prompt: y\n')
check('a row with no prompt source is skipped', noSource.agents.length === 1 && noSource.agents[0]?.id === 'b')
check('a row with no prompt source says what is missing', /prompt/.test(noSource.problems[0]?.reason ?? ''))

const notMappings = parse('agents:\n  - just-a-string\n  - id: b\n    prompt: y\n')
check('a non-mapping row is skipped', notMappings.agents.length === 1 && notMappings.agents[0]?.id === 'b')

// ---- document-level faults do not throw ---------------------------------
const notSequence = parse('agents:\n  id: a\n')
check('a non-sequence agents key yields no agents', notSequence.agents.length === 0)
check('a non-sequence agents key is a document-level problem', notSequence.problems[0]?.row === 0)

const malformed = parse('agents: [\n')
check('malformed YAML is reported, not thrown', malformed.agents.length === 0 && malformed.problems[0]?.row === 0)

const empty = parse('agents: []\n')
check('an empty roster is valid', empty.agents.length === 0 && empty.problems.length === 0)

// ---- prompt routing ------------------------------------------------------
const agents = healthy.agents
check('the owning preset receives its prompt', promptFor(agents, 'report-ledger:dev/probe') === agents[0]?.prompt)
check('any other preset receives nothing', promptFor(agents, 'standard') === '')
check('an agent without a preset receives nothing', promptFor(agents, undefined) === '')
check('an empty roster gives everyone nothing', promptFor([], 'report-ledger:dev/probe') === '')

// ---- signatures decide re-registration ----------------------------------
const base = { id: 'a', name: 'A', description: 'd', order: 10, prompt: 'one', retired: false }
check('editing only the prompt keeps the signature', signatureOf(base) === signatureOf({ ...base, prompt: 'two' }))
check('renaming changes the signature', signatureOf(base) !== signatureOf({ ...base, name: 'B' }))
check('changing the description changes the signature', signatureOf(base) !== signatureOf({ ...base, description: 'e' }))
check('changing the order changes the signature', signatureOf(base) !== signatureOf({ ...base, order: 20 }))
check('retiring changes the signature', signatureOf(base) !== signatureOf({ ...base, retired: true }))

// ---- retirement ---------------------------------------------------------
const retiredEntry = parse('agents:\n  - id: a\n    prompt: role text\n    retired: true\n')
check('retired: true is parsed', retiredEntry.agents[0]?.retired === true)
check('an omitted retired flag defaults to false', parse('agents:\n  - id: a\n    prompt: x\n').agents[0]?.retired === false)
check('a non-boolean retired flag is reported',
  parse('agents:\n  - id: a\n    prompt: x\n    retired: "yes"\n').problems.length === 1)
check('a retired entry keeps its own instructions', promptFor(retiredEntry.agents, 'a').includes('role text'))
check('a retired entry is told to wind down', promptFor(retiredEntry.agents, 'a').includes('退役'))
check('an active entry carries no wind-down', !promptFor(healthy.agents, 'report-ledger:dev/probe').includes('退役'))

// ---- the plugin's own session bindings ----------------------------------
const bindings = parseBindings('{\n  "session-a": "report-ledger:dev/probe",\n  "session-b": "report-ledger:dev/verifier"\n}')
check('bindings parse into a session → entry map', bindings.get('session-a') === 'report-ledger:dev/probe')
check('a corrupt bindings file parses empty', parseBindings('{nope').size === 0)
check('a non-object bindings file parses empty', parseBindings('[1,2]').size === 0)
check('a non-string binding is dropped', parseBindings('{"session-a": 3}').size === 0)
check('an empty binding is dropped', parseBindings('{"session-a": ""}').size === 0)
const written = serializeBindings(new Map([['session-b', 'b'], ['session-a', 'a']]))
check('serialization is sorted', written.indexOf('session-a') < written.indexOf('session-b'), written)
check('serialization round-trips', parseBindings(written).get('session-b') === 'b')

// ---- the committed roster loads -----------------------------------------
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const committed = parseRoster(
  readFileSync(join(root, 'dev', 'agents.yml'), 'utf8'),
  (path) => {
    try {
      return readFileSync(join(root, 'dev', path), 'utf8')
    } catch {
      return undefined
    }
  },
)
check('the committed dev/agents.yml loads without problems', committed.problems.length === 0,
  committed.problems.map((p) => p.reason).join('; '))
check('the committed roster contains the probe', committed.agents.some((a) => a.id === 'report-ledger:dev/probe'))
check('the committed roster contains the verifier', committed.agents.some((a) => a.id === 'report-ledger:dev/verifier'))
check('every committed prompt file is non-empty', committed.agents.every((a) => a.prompt.trim() !== ''))

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
