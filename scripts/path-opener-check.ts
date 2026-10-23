// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts.
export {}
/**
 * Deterministic checks for the host-desktop adapter behind the ledger file's
 * "open in default app" control.
 *
 * The adapter is the only place this plugin reads a Remote face it does not own,
 * so the things worth pinning are the degradations: a context without the
 * service, a service half the shell has, a failed availability read, and a
 * failed launch. Each of those must end in "no control" or "no action", never in
 * a promise the GUI cannot keep.
 *
 * Run: node scripts/path-opener-check.ts
 */

const { createPathOpener } = await import('../src/client/path-opener.ts')

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value })
const fail = <T>(): { ok: false } => ({ ok: false })

/** A recording fake of the `remote.session` face. */
const fakeRemote = (over: Record<string, unknown> = {}): { remote: Record<string, unknown>; calls: unknown[] } => {
  const calls: unknown[] = []
  const remote = {
    canOpenWorkspacePath: async () => ok(true),
    workspacePathApplications: async (request: unknown, signal?: AbortSignal) => {
      calls.push({ method: 'applications', request, aborted: signal?.aborted ?? false })
      return ok([{ id: 'code', name: 'Code', icon: null }])
    },
    openWorkspacePath: async (request: unknown, _signal?: AbortSignal) => {
      calls.push({ method: 'open', request })
      return ok(true)
    },
    ...over,
  }
  return { remote, calls }
}

// ---------------------------------------------------------------------------
// Degradations
// ---------------------------------------------------------------------------
check('no remote, no opener', createPathOpener(undefined) === undefined && createPathOpener(null) === undefined)
check('a remote without the open verb is no opener', (() => {
  const { remote } = fakeRemote({ canOpenWorkspacePath: undefined })
  return createPathOpener(remote) === undefined
})())
check('a context whose service is not an object is no opener', createPathOpener('remote') === undefined)

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------
const { remote } = fakeRemote()
const opener = createPathOpener(remote)
check('an available desktop answers true', (await opener?.available()) === true)
check('an ok answer that says no is not availability', await (async () => {
  const { remote: no } = fakeRemote({ canOpenWorkspacePath: async () => ok(false) })
  return (await createPathOpener(no)?.available()) === false
})())
check('a failed availability read is not availability', await (async () => {
  const { remote: broken } = fakeRemote({ canOpenWorkspacePath: async () => fail() })
  return (await createPathOpener(broken)?.available()) === false
})())

// ---------------------------------------------------------------------------
// Handlers and launches
// ---------------------------------------------------------------------------
check('handlers come back in host order', await (async () => {
  const list = await opener?.applications('/tmp/R-0001.md', new AbortController().signal)
  return Array.isArray(list) && list.length === 1 && list[0]?.name === 'Code'
})())
check('a failed handler read is null, not an empty list', await (async () => {
  const { remote: broken } = fakeRemote({ workspacePathApplications: async () => fail() })
  return (await createPathOpener(broken)?.applications('/tmp/x.md', new AbortController().signal)) === null
})())
check('a session face without the handler query answers null', await (async () => {
  const { remote: bare } = fakeRemote({ workspacePathApplications: undefined })
  return (await createPathOpener(bare)?.applications('/tmp/x.md', new AbortController().signal)) === null
})())

const { remote: recording, calls } = fakeRemote()
const recorder = createPathOpener(recording)
await recorder?.open('/tmp/R-0001.md', 'open')
const defaultCall = calls[0] as { request: { path: string; action?: string; application?: string } }
// The wire's default open is the ABSENCE of `action`, not `action: 'open'` — the
// gateway's boundary validation rejects the latter, measured in the GUI.
check('the default gesture names the path and omits the action', defaultCall.request.path === '/tmp/R-0001.md'
  && !('action' in defaultCall.request) && !('application' in defaultCall.request), JSON.stringify(defaultCall))

await recorder?.open('/tmp/R-0001.md', 'open', 'code')
const appCall = calls[1] as { request: { action?: string; application?: string } }
check('an explicit handler is carried through, still without an action', appCall.request.application === 'code'
  && !('action' in appCall.request))

await recorder?.open('/tmp/R-0001.md', 'reveal')
const revealCall = calls[2] as { request: { action: string } }
check('reveal is its own action', revealCall.request.action === 'reveal')

check('a failed launch answers false', await (async () => {
  const { remote: broken } = fakeRemote({ openWorkspacePath: async () => fail() })
  return (await createPathOpener(broken)?.open('/tmp/x.md', 'open')) === false
})())

let failed = 0
for (const [label, pass, detail] of checks) {
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
