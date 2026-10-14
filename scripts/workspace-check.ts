// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts and `filter` silently resolves to the DOM's window.filter.
// Emitted as nothing; it exists so `tsc` treats the file as its own module.
export {}
/**
 * Deterministic checks for the peer workspace registration the HOST performs.
 *
 * `roster-check.ts` pins the service side of the same feature — that a created
 * peer is offered to the hook, and that a failure is reported rather than thrown.
 * What is pinned here is the half that talks to the registry, and it is the half
 * where a mistake is invisible: registering the peer under a path the registry
 * does not recognize does not throw, it just means the (id → workspace)
 * accounting the sidebar reads stays empty and the peer sits in the ungrouped
 * bucket. That is precisely the bug this feature exists to fix, reproduced by a
 * string comparison in place of the registry's own canonical-path rule.
 *
 * So the assertions are behavioural rather than structural: the path the hook
 * *offers* the registry must be the one the registry itself would accept
 * (canonical real path, not the caller's spelling of it), the attach must carry
 * the peer's own id, and each degraded outcome must stay distinguishable from the
 * others.
 *
 * No harness is involved: the peer host is exercised through a minimal context
 * stub. That is the whole reason its parameter is a narrow structural interface
 * rather than the plugin Context.
 *
 * Run: node scripts/workspace-check.ts
 */

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostBundle, PeerHostContext } from '../src/index.ts'

const scratch = await mkdtemp(join(tmpdir(), 'report-ledger-workspace-'))
// The peer roster log lives under the ledger root, so the run must not touch a
// real one even though nothing here starts a peer.
process.env.DSH_REPORT_LEDGER_ROOT = join(scratch, 'ledger')

const { buildPeerHost } = await import('../src/index.ts')

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

/** Stand in for the session-reading bundle the peer host is built with. */
const host = (): HostBundle => ({
  getAgent: () => undefined,
  describe: async () => undefined,
  readTitles: async () => new Map<string, string>(),
  listSessionRecords: async () => [],
})

/** One workspace record as the registry hands it over. */
interface FakeWorkspace {
  readonly title: string
  attachSession(sessionId: never): Promise<void>
}

/** What the registry stub was asked, in call order. */
interface Asked {
  readonly canonical: string
}

/**
 * A context whose only interesting service is the workspace registry.
 * @param answer - `undefined` composes no registry, `'none'` a registry owning nothing, else the workspace to resolve to.
 * @param asked - receives the path each lookup was made with.
 * @param workspace - the workspace the registry answers with, when it answers.
 * @param warnings - receives logger warnings.
 * @returns the context stub.
 */
const contextWith = (
  answer: FakeWorkspace | 'none' | undefined,
  asked: Asked[],
  workspace: FakeWorkspace,
  warnings: string[] = [],
): PeerHostContext => {
  const ctx = {
    agents: {
      get: () => undefined,
      list: () => [],
      create: async () => { throw new Error('fixture: no peer is created by this check') },
    },
    get: (name: string) => {
      if (name !== 'workspaceRegistry' || answer === undefined) return undefined
      return {
        resolveByPath: async (canonical: string) => {
          asked.push({ canonical })
          return answer === 'none' ? undefined : workspace
        },
      }
    },
    logger: { warn: (message: string) => { warnings.push(message) } },
  }
  return ctx as unknown as PeerHostContext
}

// ---- 1. a peer in a registered directory is attached, canonically ----------
// The directory exists, and the caller's spelling of it deliberately does not
// match what the filesystem reports: mixed case on Windows, a trailing separator
// everywhere. A hook that passed the caller's string straight through would hand
// the registry a path it cannot validate, and the registration would be reported
// as a failure — or, worse, silently land nowhere — while the peer stayed
// ungrouped.
const project = join(scratch, 'Project')
await mkdir(project, { recursive: true })
const canonicalProject = await realpath(project)
const misspelled = `${canonicalProject.toUpperCase()}${process.platform === 'win32' ? '\\' : '/'}.`

const asked: Asked[] = []
const attached: string[] = []
const workspace: FakeWorkspace = {
  title: 'fixture-workspace',
  attachSession: async (sessionId: never) => { attached.push(String(sessionId)) },
}
const live = buildPeerHost(contextWith(workspace, asked, workspace), host())
const registered = await live.attachToWorkspace?.({ sessionId: 'session-peer-1', cwd: misspelled })
check('a registered directory reports the workspace it joined',
  registered?.outcome === 'registered' && registered.workspace === 'fixture-workspace',
  JSON.stringify(registered))
check('the registry is asked about the canonical path, not the caller\'s spelling',
  asked[0]?.canonical === canonicalProject,
  `${String(asked[0]?.canonical)} vs ${canonicalProject}`)
check('the peer session is attached by its own id',
  attached.join() === 'session-peer-1', attached.join())

// ---- 2. an unmatched directory is a legitimate absence, not a failure -------
const unmatchedAsked: Asked[] = []
const unknown = buildPeerHost(contextWith('none', unmatchedAsked, workspace), host())
const unowned = await unknown.attachToWorkspace?.({ sessionId: 'session-peer-2', cwd: project })
check('a directory no workspace owns is reported as no-workspace', unowned?.outcome === 'no-workspace', JSON.stringify(unowned))
check('an unmatched registration reports no workspace name', unowned?.workspace === undefined, String(unowned?.workspace))

// ---- 3. a deployment without the registry has nothing to report -------------
const composed = buildPeerHost(contextWith(undefined, [], workspace), host())
check('the hook exists even where no registry is composed', typeof composed.attachToWorkspace === 'function')
const none = await composed.attachToWorkspace?.({ sessionId: 'session-peer-3', cwd: project })
check('no registry yields no-workspace rather than a failure',
  none?.outcome === 'no-workspace' && none.warning === undefined, JSON.stringify(none))
const noCwd = await composed.attachToWorkspace?.({ sessionId: 'session-peer-4' })
check('a peer with no directory is not offered to the registry at all', noCwd?.outcome === 'no-workspace', JSON.stringify(noCwd))

// ---- 4. a registry that refuses the attach is reported, never thrown --------
// The service layer catches as well, so this is the inner boundary: a warning
// must reach the deployment log here too, because the tool result is read once by
// one agent while a silently ungrouped peer is a fact about the installation.
const warnings: string[] = []
const refusing: FakeWorkspace = {
  title: 'fixture-workspace',
  attachSession: async () => { throw new Error('fixture: registry refused the attach') },
}
const broken = buildPeerHost(contextWith(refusing, [], refusing, warnings), host())
let threw = false
let failed: { outcome?: string; warning?: string } | undefined
try {
  failed = await broken.attachToWorkspace?.({ sessionId: 'session-peer-5', cwd: project })
} catch {
  threw = true
}
check('a refused attach does not throw out of the hook', !threw)
check('a refused attach is reported as failed', failed?.outcome === 'failed', JSON.stringify(failed))
check('the failure carries the registry\'s own reason',
  failed?.warning?.includes('registry refused the attach') === true, String(failed?.warning))
check('the failure is also written to the deployment log',
  warnings.some((line) => line.includes('session-peer-5') && line.includes('registry refused')), warnings.join(' | '))

// ---- 5. a directory that cannot be canonicalized is a failure, not a crash --
const vanished = await live.attachToWorkspace?.({ sessionId: 'session-peer-6', cwd: join(scratch, 'never-created') })
check('a vanished directory is reported as failed rather than thrown',
  vanished?.outcome === 'failed', JSON.stringify(vanished))

let failures = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failures}/${checks.length} checks passed`)

await rm(scratch, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
