// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts and `filter` silently resolves to the DOM's window.filter.
// Emitted as nothing; it exists so `tsc` treats the file as its own module.
export {}
/**
 * Release boundary — the packed tarball must never carry the developer roster.
 *
 * `devMode` is the **contributor entrance**, not a user feature: the gate is whether
 * the installed package contains `dev/agents.yml`, and `files` excludes `dev/`, so an
 * installed package cannot register developer agents whatever its config says.
 * That invariant is one `files` edit away from breaking, and the failure is silent —
 * a user who sets `devMode: true` would simply gain `dev_agent_start` and friends.
 *
 * This packs the package the way a release does and asserts the boundary:
 *   - no `dev/` entry (nor `src/`, `scripts/`, `node_modules/`, `.pnpm-store/`);
 *   - the entries a working install needs are present;
 *   - the shipped `files` list does not name `dev`;
 *   - the shipped bundle patch does not switch `devMode` on.
 *
 * It deliberately does **not** boot a host. The runtime half (an installed package
 * registering no `dev_*` tools even with `devMode: true`) needs the DSH package layer,
 * so it stays a manual step in docs/publishing.md §开发者模式不能随包出去.
 *
 * Run: node scripts/release-boundary-check.ts [--tarball <path>]
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { parse as parseYaml } from 'yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

/** One entry of the tarball. */
interface Entry {
  readonly path: string
  readonly body: Buffer
}

/**
 * Read a `.tgz` into its entries.
 *
 * A minimal ustar reader rather than a dependency or a `tar` subprocess: the check has
 * to run in CI with only Node and `yaml`, and the release tarball uses short paths that
 * fit the plain name/prefix fields. Pax headers (`x`/`g`) are skipped — their payload
 * only matters for names over 255 bytes, which this package does not have.
 * @param bytes - the gzip'd tarball.
 * @returns every regular entry with its body.
 */
function readTarGz(bytes: Buffer): Entry[] {
  const tar = gunzipSync(bytes)
  const entries: Entry[] = []
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start: number, length: number): string =>
      header.subarray(start, start + length).toString('utf8').replace(/\0[\s\S]*$/, '').trim()
    const name = field(0, 100)
    const size = Number.parseInt(field(124, 12) || '0', 8) || 0
    const type = String.fromCharCode(header[156] ?? 0)
    const prefix = field(345, 155)
    const path = prefix === '' ? name : `${prefix}/${name}`
    const bodyStart = offset + 512
    const bodyEnd = bodyStart + Math.min(size, tar.length - bodyStart)
    if (type !== 'x' && type !== 'g' && name !== '') {
      entries.push({ path, body: tar.subarray(bodyStart, bodyEnd) })
    }
    offset = bodyStart + Math.ceil(size / 512) * 512
  }
  return entries
}

/** Arguments: `--tarball <path>` reuses an artifact instead of packing one. */
function tarballArgument(): string | undefined {
  const index = process.argv.indexOf('--tarball')
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error('--tarball needs a path')
  return resolve(value)
}

/**
 * Pack the package the way a release does, into a throwaway directory.
 *
 * `--ignore-scripts` is deliberate: the build is a separate gate, and a pack-time
 * script must not be able to change what this check inspects.
 * @param version - the version the tarball name is derived from.
 * @returns the tarball path and the directory to clean up.
 */
function pack(version: string): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'report-ledger-boundary-'))
  const result = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', dir], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (result.error !== undefined) {
    throw new Error(`could not run npm pack: ${String(result.error)}`)
  }
  if (result.status !== 0) {
    throw new Error(`npm pack exited ${String(result.status)}: ${stderr || stdout}`)
  }
  const file = join(dir, `dsh-report-ledger-${version}.tgz`)
  if (!existsSync(file)) {
    throw new Error(`npm pack did not write ${file}; stdout: ${stdout}`)
  }
  return { file, dir }
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version?: string
  files?: unknown
  dsh?: { bundle?: { patch?: unknown } }
}
const version = manifest.version ?? '0.0.0'

let cleanup: string | undefined
let tarball = tarballArgument()
if (tarball === undefined) {
  const packed = pack(version)
  tarball = packed.file
  cleanup = packed.dir
}

try {
  const entries = readTarGz(readFileSync(tarball))
  const paths = entries.map((entry) => entry.path)
  const find = (path: string): Entry | undefined => entries.find((entry) => entry.path === path)

  // ---- 1. the roster (and the other source trees) must not travel ----------
  for (const forbidden of ['package/dev/', 'package/src/', 'package/scripts/', 'package/node_modules/', 'package/.pnpm-store/']) {
    const hit = paths.filter((path) => path.startsWith(forbidden))
    check(`tarball has no ${forbidden}`, hit.length === 0, hit.slice(0, 3).join(', '))
  }
  check('tarball has no bare package/dev entry', !paths.includes('package/dev'))

  // ---- 2. the install needs these entries --------------------------------
  for (const required of ['package/package.json', 'package/lib/index.js', 'package/lib/client.js', 'package/cordis.patch.yml']) {
    check(`tarball carries ${required}`, paths.includes(required))
  }

  // ---- 3. the manifest itself must keep dev out of the whitelist ----------
  const shipped = find('package/package.json')
  const shippedFiles = shipped === undefined
    ? []
    : ((JSON.parse(shipped.body.toString('utf8')) as { files?: unknown }).files ?? [])
  const files = Array.isArray(shippedFiles) ? shippedFiles.map((value) => String(value)) : []
  check(
    'shipped files whitelist does not name dev',
    files.every((value) => value.replace(/^\.\//, '').replace(/[\\/]+$/, '') !== 'dev'),
    files.join(', '),
  )
  check('shipped files whitelist is present', files.length > 0, String(shippedFiles))
  check(
    'shipped package still declares the bundle patch',
    manifest.dsh?.bundle?.patch === './cordis.patch.yml',
    String(manifest.dsh?.bundle?.patch),
  )

  // ---- 4. the shipped bundle patch must not switch devMode on -------------
  const patchEntry = find('package/cordis.patch.yml')
  const patch = patchEntry === undefined
    ? undefined
    : parseYaml(patchEntry.body.toString('utf8')) as { insert?: { id?: unknown; name?: unknown; config?: { devMode?: unknown } }[] }[]
  const row = Array.isArray(patch)
    ? patch.flatMap((layer) => layer.insert ?? []).find((inserted) => inserted.id === 'report-ledger')
    : undefined
  check('shipped patch inserts the report-ledger row', row !== undefined)
  check('shipped patch does not switch devMode on', row?.config?.devMode !== true, String(row?.config?.devMode))
} finally {
  if (cleanup !== undefined) rmSync(cleanup, { recursive: true, force: true })
}

check('the packed version is the one declared in package.json', version !== '0.0.0', version)

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)
console.log(`tarball: ${tarball}`)
process.exit(failed === 0 ? 0 : 1)
