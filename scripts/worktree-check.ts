// A module, not a global script: without an import/export this file shares the
// global scope with its siblings, so top-level names like `checks` collide
// across scripts and `filter` silently resolves to the DOM's window.filter.
// Emitted as nothing; it exists so `tsc` treats the file as its own module.
export {}
/**
 * Deterministic checks for the git worktree adapter.
 *
 * The adapter is the half of the worktree feature that talks to git, and it is
 * where the two things that break in practice live: parsing `worktree list`, and
 * deciding when two paths name one file on a Windows host. Both are pinned here
 * against real git and real repositories rather than against recorded fixtures,
 * because the whole point of the adapter is to agree with git.
 *
 * The fixture repositories are created under the system temporary directory and
 * removed at the end; nothing here reads or writes the report ledger.
 *
 * Run: node scripts/worktree-check.ts
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const w = await import('../src/report/worktree.ts')

const checks: [string, boolean, string][] = []
const check = (label: string, ok: boolean, detail = ''): void => { checks.push([label, ok, detail]) }

const scratch = await mkdtemp(join(tmpdir(), 'report-ledger-worktree-'))

/** Run a fixture git command, failing loudly: a broken fixture is not a finding. */
const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await w.runGit(cwd, args)
  if (!result.ok) {
    throw new Error(`fixture git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim() || `exit ${result.code}`}`)
  }
  return result.stdout
}

/** Create a repository with one commit and no line-ending rewriting. */
const makeRepo = async (name: string): Promise<string> => {
  const path = join(scratch, name)
  await mkdir(path, { recursive: true })
  await git(path, 'init', '-q', '--initial-branch=main')
  // Explicit, because a machine-level `core.autocrlf=true` rewrites content
  // under `git status` and would make the cleanliness checks depend on the host.
  await git(path, 'config', 'core.autocrlf', 'false')
  await git(path, 'config', 'user.name', 'worktree-check')
  await git(path, 'config', 'user.email', 'worktree-check@example.invalid')
  await writeFile(join(path, 'f.txt'), 'l1\nl2\n')
  await git(path, 'add', '-A')
  await git(path, 'commit', '-q', '-m', 'base')
  return path
}

// ---- 1. the porcelain parser, in its NUL-delimited form ---------------------
// Built by joining fields with NUL and ending a record with an extra NUL, which
// is exactly the byte shape `--porcelain -z` emits.
const S = 'a'.repeat(40)
const porcelain = [
  'worktree C:/r/main', `HEAD ${S}`, 'branch refs/heads/main', '',
  'worktree C:/r/nested/feat', `HEAD ${S}`, 'branch refs/heads/topic/inner', '',
  'worktree C:/r/det', `HEAD ${S}`, 'detached', '',
  'worktree C:/r/locked', `HEAD ${S}`, 'branch refs/heads/l1', 'locked portable device', '',
  'worktree C:/r/locked-noreason', `HEAD ${S}`, 'branch refs/heads/l2', 'locked', '',
  'worktree C:/r/prunable', `HEAD ${S}`, 'branch refs/heads/gone', 'prunable gitdir file points to non-existent location', '',
  'worktree C:/r/bare-source', 'bare', '',
].join('\0')

const parsed = w.parseWorktreeList(porcelain)
check('every record is parsed', parsed.length === 7, `got ${parsed.length}`)
check('a branch is reported by its short name', parsed[0]?.branch === 'main', String(parsed[0]?.branch))
check('a nested branch keeps its slashes without the refs prefix',
  parsed[1]?.branch === 'topic/inner', String(parsed[1]?.branch))
check('a detached entry has no branch and says so',
  parsed[2]?.detached === true && parsed[2]?.branch === undefined, String(parsed[2]?.branch))
check('a lock reason is captured', parsed[3]?.locked === true && parsed[3]?.lockReason === 'portable device',
  String(parsed[3]?.lockReason))
check('a reasonless lock is still a lock with no reason',
  parsed[4]?.locked === true && parsed[4]?.lockReason === undefined, String(parsed[4]?.lockReason))
check('a prunable entry carries its reason',
  parsed[5]?.prunable === true && (parsed[5]?.prunableReason ?? '').includes('non-existent'),
  String(parsed[5]?.prunableReason))
check('a bare entry is recognized', parsed[6]?.bare === true)
check('an entry with no HEAD line is still usable', parsed[6]?.head === undefined)

// A prunable entry is listed, but must not be treated as holding its branch:
// its working tree is gone, so letting it block reuse would strand the name.
const holders = w.branchHolders(parsed)
check('holders skip the prunable entry', !holders.has('gone'))
check('holders cover every live branch', holders.size === 4, [...holders.keys()].join())
check('holders point at the right entry', w.samePath(holders.get('main')?.path ?? '', 'C:/r/main'))

// ---- 2. path comparison is the host's rule, not a lowest common denominator -
// A backslash separates only where the host says so: on Windows the two
// spellings name one file, while on POSIX a backslash is an ordinary character
// in a filename — and pretending otherwise would merge two directories git keeps
// distinct. The assertion is written as the host's answer rather than as the
// Windows answer, so the suite means the same thing on a Linux runner.
const win32 = process.platform === 'win32'
check('a backslash separates only where the host says so',
  w.samePath('a/b', 'a\\b') === win32, `platform=${process.platform}`)
check('a trailing separator does not change identity', w.samePath('/a/b/', '/a/b'))
check('different paths stay different', !w.samePath('C:/a/b', 'C:/a/c'))
// Stripping trailing separators must not eat a root: `C:\` reduced to `C:` is a
// different thing on Windows, and every drive-root comparison would go wrong.
check('a drive root keeps its separator',
  !win32 || /^c:\\$/i.test(w.compareKey('C:\\')),
  w.compareKey('C:\\'))
check('case sensitivity follows the host', w.samePath('C:/A/B', 'c:/a/b') === win32,
  `platform=${process.platform}`)

// ---- 3. version gating ------------------------------------------------------
check('relative paths are recognized on 2.48', w.supportsRelativePaths('git version 2.48.0'))
check('relative paths are recognized on 2.49.windows.1', w.supportsRelativePaths('git version 2.49.0.windows.1'))
check('relative paths are refused on 2.47.1', !w.supportsRelativePaths('git version 2.47.1'))
check('relative paths are refused on a 1.x version', !w.supportsRelativePaths('git version 1.8.5'))
check('an unparsable version refuses the feature', !w.supportsRelativePaths('unknown'))

// ---- 4. locating a repository ----------------------------------------------
const repo = await makeRepo('repo')
const located = await w.resolveRepo(repo)
check('a repository resolves', located !== undefined)
const tempInRepo = (await w.resolveRepo(tmpdir())) !== undefined
check('a directory outside any repository resolves to undefined',
  tempInRepo || (await w.resolveRepo(scratch)) === undefined,
  tempInRepo ? 'skipped: the temp root is itself inside a repository' : '')
check('the common dir is the repository .git',
  located !== undefined && w.samePath(located.commonDir, join(repo, '.git')),
  located?.commonDir ?? '')
check('the repository root is the main worktree',
  located !== undefined && w.samePath(located.repoRoot, repo), located?.repoRoot ?? '')
check('the worktree root is a sibling of the repository, not inside it',
  located !== undefined
    && w.samePath(located.worktreeRoot, join(dirname(repo), w.WORKTREE_DIR, basename(repo))),
  located?.worktreeRoot ?? '')
check('the worktree root is outside the repository',
  located !== undefined && !w.compareKey(located.worktreeRoot).startsWith(w.compareKey(repo)),
  located?.worktreeRoot ?? '')
check('the repository name is its directory name',
  located !== undefined && located.repoName === basename(repo), located?.repoName ?? '')
check('a repository with no submodules says so', located !== undefined && !w.hasSubmodules(located))

const entries = located === undefined ? [] : await w.listWorktrees(located)
check('a single-checkout repository lists one worktree', entries.length === 1, `got ${entries.length}`)
check('the main worktree is on the branch it was created with', entries[0]?.branch === 'main', String(entries[0]?.branch))
check('the main worktree reports a head', (entries[0]?.head ?? '').length >= 40)

// ---- 5. allocating, inspecting and removing a linked worktree ---------------
let added = { ok: false, code: 0, stdout: '', stderr: '' } as Awaited<ReturnType<typeof w.addWorktree>>
let linked = ''
if (located !== undefined) {
  linked = join(located.worktreeRoot, 'wt-a')
  await mkdir(dirname(linked), { recursive: true })
  added = await w.addWorktree({ repo: located, path: linked, branch: 'dsh/R-0007-first', base: 'main' })
}
check('a linked worktree is created', added.ok, added.stderr.trim())
const afterAdd = located === undefined ? [] : await w.listWorktrees(located)
check('the new worktree is listed', afterAdd.length === 2, `got ${afterAdd.length}`)
check('the new branch is reported as held',
  w.branchHolders(afterAdd).get('dsh/R-0007-first') !== undefined)
check('the holder is the new path',
  w.samePath(w.branchHolders(afterAdd).get('dsh/R-0007-first')?.path ?? '', linked))
check('a fresh worktree is clean', await w.isWorktreeClean(linked))
check('the new worktree starts at the base commit',
  (await w.headOf(linked)) === entries[0]?.head,
  `${await w.headOf(linked)} vs ${entries[0]?.head}`)
const inside = await w.resolveRepo(linked)
check('a linked worktree resolves to the same common dir',
  inside !== undefined && located !== undefined && w.samePath(inside.commonDir, located.commonDir),
  inside?.commonDir ?? '')
check('a linked worktree shares the repository name',
  inside !== undefined && located !== undefined && inside.repoName === located.repoName)

// Uneven dirt: an untracked file and a modification must both read as unclean,
// because both are what `git worktree remove` refuses to destroy.
await writeFile(join(linked, 'untracked.txt'), 'x\n')
check('an untracked file makes a worktree unclean', !(await w.isWorktreeClean(linked)))
await rm(join(linked, 'untracked.txt'))
check('removing the untracked file makes it clean again', await w.isWorktreeClean(linked))
await writeFile(join(linked, 'f.txt'), 'l1\nl2\nchanged\n')
check('a modified tracked file makes a worktree unclean', !(await w.isWorktreeClean(linked)))

// ---- 6. refusals are classified, and none of them is forced through ---------
if (located !== undefined) {
  // Two name collisions that read alike and mean different things: a branch name
  // that already exists is reusable, a directory that already exists is not.
  const dupBranch = await w.addWorktree({
    repo: located, path: join(located.worktreeRoot, 'wt-b'), branch: 'dsh/R-0007-first', base: 'main',
  })
  check('re-creating an existing branch name is refused', !dupBranch.ok)
  check('the refusal is classified as branch-exists',
    w.classifyGitRefusal(dupBranch.stderr) === 'branch-exists',
    `${w.classifyGitRefusal(dupBranch.stderr)} :: ${dupBranch.stderr.trim()}`)

  // The occupancy check itself. Only reachable by checking out an existing
  // branch: `-b` fails earlier, on the name, and never reports who holds it.
  const occupied = await w.addWorktree({
    repo: located, path: join(located.worktreeRoot, 'wt-c'),
    branch: 'dsh/R-0007-first', checkoutExisting: true,
  })
  check('checking out a branch another worktree holds is refused', !occupied.ok)
  check('the refusal is classified as branch-in-use',
    w.classifyGitRefusal(occupied.stderr) === 'branch-in-use',
    `${w.classifyGitRefusal(occupied.stderr)} :: ${occupied.stderr.trim()}`)

  const nonEmpty = join(located.worktreeRoot, 'wt-nonempty')
  await mkdir(nonEmpty, { recursive: true })
  await writeFile(join(nonEmpty, 'x.txt'), 'x\n')
  const pathTaken = await w.addWorktree({
    repo: located, path: nonEmpty, branch: 'dsh/R-0010-taken', base: 'main',
  })
  check('allocating into a non-empty directory is refused', !pathTaken.ok)
  check('the refusal is classified as path-exists',
    w.classifyGitRefusal(pathTaken.stderr) === 'path-exists',
    `${w.classifyGitRefusal(pathTaken.stderr)} :: ${pathTaken.stderr.trim()}`)

  const dirtyRemove = await w.removeWorktree(located, linked)
  check('removing an unclean worktree is refused', !dirtyRemove.ok)
  check('the refusal is classified as unclean',
    w.classifyGitRefusal(dirtyRemove.stderr) === 'unclean',
    `${w.classifyGitRefusal(dirtyRemove.stderr)} :: ${dirtyRemove.stderr.trim()}`)

  const mainRemove = await w.removeWorktree(located, repo)
  check('removing the main worktree is refused', !mainRemove.ok)
  check('the refusal is classified as main-working-tree',
    w.classifyGitRefusal(mainRemove.stderr) === 'main-working-tree',
    `${w.classifyGitRefusal(mainRemove.stderr)} :: ${mainRemove.stderr.trim()}`)

  await writeFile(join(linked, 'f.txt'), 'l1\nl2\n')
  const cleanRemove = await w.removeWorktree(located, linked)
  check('a clean worktree is removed', cleanRemove.ok, cleanRemove.stderr.trim())
  check('the removal empties the listing back to one',
    (await w.listWorktrees(located)).length === 1)
  check('the released branch is no longer held',
    !w.branchHolders(await w.listWorktrees(located)).has('dsh/R-0007-first'))
}

// ---- 7. a registry entry whose directory vanished ---------------------------
// This is the state a hand-moved or hand-deleted worktree leaves behind, and the
// one where an automatic `prune` would destroy a checkout that still works.
if (located !== undefined) {
  const ghost = join(located.worktreeRoot, 'wt-ghost')
  await w.addWorktree({ repo: located, path: ghost, branch: 'dsh/R-0008-ghost', base: 'main' })
  await rm(ghost, { recursive: true, force: true })
  const listed = await w.listWorktrees(located)
  const ghostEntry = listed.find((entry) => w.samePath(entry.path, ghost))
  check('a worktree whose directory vanished is still listed', ghostEntry !== undefined)
  check('it is marked prunable', ghostEntry?.prunable === true)
  check('a prunable entry does not hold its branch',
    !w.branchHolders(listed).has('dsh/R-0008-ghost'))
  const reAdd = await w.addWorktree({
    repo: located, path: ghost, branch: 'dsh/R-0009-second', base: 'main',
  })
  check('re-adding a registered but missing path is refused', !reAdd.ok)
  check('the refusal is classified as missing-but-registered',
    w.classifyGitRefusal(reAdd.stderr) === 'missing-but-registered',
    `${w.classifyGitRefusal(reAdd.stderr)} :: ${reAdd.stderr.trim()}`)
  const pruned = await w.pruneWorktrees(located)
  check('an explicit prune clears the stale entry', pruned.ok)
  check('the stale entry is gone after the prune',
    !(await w.listWorktrees(located)).some((entry) => w.samePath(entry.path, ghost)))
}

// ---- 8. a bare repository is a legitimate host ------------------------------
// Built by cloning a committed repository: `git init --bare` leaves HEAD on an
// unborn branch, and a worktree cannot be branched from a ref that has no commit.
const bareSource = await makeRepo('bare-source')
const barePath = join(scratch, 'bare.git')
await git(scratch, 'clone', '-q', '--bare', bareSource, barePath)
await git(barePath, 'config', 'core.autocrlf', 'false')
const bareRepo = await w.resolveRepo(barePath)
check('a bare repository resolves', bareRepo !== undefined)
check('a bare repository is recognized as bare', bareRepo?.bare === true)
check('a bare repository name drops the .git suffix', bareRepo?.repoName === 'bare', bareRepo?.repoName ?? '')
check('a bare repository places its worktree root beside itself',
  bareRepo !== undefined && w.samePath(bareRepo.worktreeRoot, join(dirname(barePath), w.WORKTREE_DIR, 'bare')),
  bareRepo?.worktreeRoot ?? '')
check('a bare repository reports no submodules', bareRepo !== undefined && !w.hasSubmodules(bareRepo))
if (bareRepo !== undefined) {
  const bareLinked = join(bareRepo.worktreeRoot, 'from-bare')
  await mkdir(dirname(bareLinked), { recursive: true })
  const bareAdd = await w.addWorktree({ repo: bareRepo, path: bareLinked, branch: 'from-bare', base: 'main' })
  check('a worktree can be attached to a bare repository', bareAdd.ok, bareAdd.stderr.trim())
  check('the bare repository lists both', (await w.listWorktrees(bareRepo)).length === 2)
  check('a worktree off a bare repository is clean', await w.isWorktreeClean(bareLinked))
}

// ---- 9. submodules gate the feature ----------------------------------------
const subRepoPath = await makeRepo('subrepo')
const subRepo = await w.resolveRepo(subRepoPath)
if (subRepo !== undefined) {
  check('no .gitmodules means no submodules', !w.hasSubmodules(subRepo))
  await writeFile(join(subRepo.repoRoot, '.gitmodules'), '[submodule "x"]\n\tpath = x\n\turl = ./x\n')
  check('a .gitmodules file is detected', w.hasSubmodules(subRepo))
}

// ---- 10. relative linking, and the format version it forces -----------------
// Opt-in only: `--relative-paths` implies the extensions.relativeWorktrees
// format extension, which raises core.repositoryformatversion to 1 and makes
// older git refuse the repository outright. Asserted conditionally because the
// flag does not exist before 2.48.
const relRepoPath = await makeRepo('relrepo')
const relRepo = await w.resolveRepo(relRepoPath)
if (relRepo !== undefined) {
  const relLinked = join(relRepo.worktreeRoot, 'rel')
  await mkdir(dirname(relLinked), { recursive: true })
  const relAdd = await w.addWorktree({
    repo: relRepo, path: relLinked, branch: 'rel', base: 'main', relativePaths: true,
  })
  const formatVersion = (await w.runGit(relRepo.commonDir, ['config', '--get', 'core.repositoryformatversion']))
    .stdout.trim()
  check('if --relative-paths is supported it raises the repository format version',
    !relAdd.ok || formatVersion === '1',
    `supported=${relAdd.ok} formatVersion=${formatVersion}`)
  if (relAdd.ok) {
    const gitfile = await readFile(join(relLinked, '.git'), 'utf8')
    check('relative linking writes a relative gitfile',
      /^gitdir: /.test(gitfile) && !/^gitdir: [a-zA-Z]:/.test(gitfile),
      gitfile.trim())
  }
}

// ---- report -----------------------------------------------------------------
try {
  await rm(scratch, { recursive: true, force: true })
} catch {
  // A leftover fixture directory is not a finding; git marks loose objects
  // read-only on some hosts and the removal can lose that race.
}

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  <- ${detail}`}`)
}
console.log('')
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
