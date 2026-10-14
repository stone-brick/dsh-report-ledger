// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts and `filter` silently resolves to the DOM's window.filter.
// Emitted as nothing; it exists so `tsc` treats the file as its own module.
export {}
/**
 * Does the REAL workspace registry accept the exact attach this plugin performs?
 *
 * `workspace-check.ts` pins the host adapter against a fake registry, and a fake
 * cannot answer this: the answer lives in the registry's own validation rule.
 * `attachSession` reads the session's durable header, canonicalizes its `cwd`, and
 * refuses unless that canonical path equals the workspace's recorded path. Had the
 * plugin passed the caller's spelling of the directory straight through, every
 * registration would come back `failed` and peers would stay ungrouped — the bug
 * this feature fixes, still intact behind a green unit test.
 *
 * So this probe mounts the real storage stack and the real registry over a COPY of
 * a real `workspace.json` (an isolated DSH_HOME, so the machine's own file is never
 * written), then runs the plugin's own host adapter against it:
 *
 *  1. the registry must see the copied workspaces at all — proof that the backend
 *     route and the domain wiring are the ones a deployment uses;
 *  2. a caller-spelled, deliberately NON-canonical form of a real workspace path
 *     must resolve — proof that no string comparison slipped in;
 *  3. a real session log of that workspace must be attachable, and the live
 *     registry object must account it afterwards — proof that the write commits.
 *
 * Run: DSH_HOME=<scratch holding storages/workspace.json> SESSIONS=<real sessions root> \
 *      node scripts/registry-attach-probe.ts <workspace path> <sessionId>
 */

import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Storage } from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import DefaultPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { realpathNormalize, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { buildPeerHost } from '../src/index.ts'

const home = process.env.DSH_HOME
if (home === undefined || !home.includes('probe')) throw new Error(`refusing to run: DSH_HOME must be a scratch probe directory, got ${String(home)}`)
const sessionsRoot = process.env.SESSIONS
if (sessionsRoot === undefined) throw new Error('refusing to run: set SESSIONS to the session-log root the probe may read')

const [workspacePath, sessionId] = process.argv.slice(2)
if (workspacePath === undefined || sessionId === undefined) throw new Error('usage: registry-attach-probe.ts <workspace path> <sessionId>')

const ctx = new Context()
new Storage(ctx)
StorageJson.apply(ctx, { root: join(home, 'storages') })
// `apply` is async by signature: the facility registers itself on the way, and
// awaiting it is what guarantees the domain service exists before the registry's
// init hook reaches for it.
await StorageDomain.apply(ctx, { backend: 'json' })
new DefaultPersistence(ctx, { root: sessionsRoot })
const registry = new WorkspaceRegistry(ctx)
// Off-harness there is no Loader to run the service's init hook, so the probe runs
// it explicitly — the same body a deployment runs, in the same order. The symbol is
// read off the class's own prototype rather than imported from cordis, because a
// second copy of the framework would carry a different (and therefore non-matching)
// symbol identity.
const initSymbol = Object.getOwnPropertySymbols(Object.getPrototypeOf(registry))
  .find((candidate) => typeof (registry as unknown as Record<symbol, unknown>)[candidate] === 'function')
if (initSymbol === undefined) throw new Error('probe: the registry exposes no init hook to run')
await (registry as unknown as Record<symbol, () => Promise<void>>)[initSymbol]()
ctx.set('workspaceRegistry', registry)

// The registry opens its domain during its own init, which cordis runs once the
// service's declared dependencies are satisfied; let those promises settle before
// asking it anything.
await new Promise((resolve) => setTimeout(resolve, 250))

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

const listed = registry.list()
console.log(`workspaces seen: ${listed.length}`)
for (const item of listed) console.log(`  ${item.path}  sessions=${item.sessionIds.length}`)

const canonical = await realpathNormalize(workspacePath)
// The caller's spelling, deliberately wrong in the two ways a naive comparison
// gets wrong: case, and a trailing separator.
const misspelled = `${canonical.toUpperCase()}${process.platform === 'win32' ? '\\' : '/'}`

const found = await registry.resolveByPath(canonical)
check('the registry resolves a workspace it loaded from the copied file', found !== undefined, String(found?.path))
check('the resolved path is the canonical one', found?.path === canonical, `${String(found?.path)} vs ${canonical}`)

const host = buildPeerHost(
  {
    agents: { get: () => undefined, list: () => [], create: async () => { throw new Error('probe: no agent is created here') } },
    get: () => registry,
    logger: { warn: (message) => { console.log(`host warning: ${message}`) } },
  },
  { getAgent: () => undefined, describe: async () => undefined, readTitles: async () => new Map(), listSessionRecords: async () => [] },
)

const outcome = await host.attachToWorkspace?.({ sessionId, cwd: misspelled })
console.log(`attachToWorkspace -> ${JSON.stringify(outcome)}`)
check('the plugin adapter registers the session through the real registry', outcome?.outcome === 'registered', JSON.stringify(outcome))

const after = (await registry.resolveByPath(canonical))?.sessionIds.map(String) ?? []
check('the live registry accounts the session afterwards', after.includes(sessionId), `${after.length} sessions, present=${after.includes(sessionId)}`)

const reattach = await host.attachToWorkspace?.({ sessionId, cwd: canonical })
check('registering an already-accounted session is an idempotent no-op', reattach?.outcome === 'registered', JSON.stringify(reattach))

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)

