/**
 * Git worktree adapter.
 *
 * The ledger records *intent*; git records *reality*. This module is the whole
 * of the second half: it shells out to `git`, reads `git worktree list`, and
 * decides nothing. Every policy question — which report may hold a branch, when
 * a checkout may be removed, what to do when the two layers disagree — belongs to
 * the service layer, because answering it needs the ledger. This module must
 * stay usable and testable without one.
 *
 * Four deliberate choices:
 *
 *  - **Shell out, never reimplement.** Git's occupancy check, its refusal to
 *    remove an unclean tree, and its `repair` are the authority. A weaker
 *    reimplementation in TypeScript would be a second source of truth about the
 *    same bytes, which is the exact failure this plugin exists to avoid.
 *  - **No `--force`, anywhere.** Neither {@link addWorktree} nor
 *    {@link removeWorktree} exposes a force flag, so no caller can acquire the
 *    ability to discard uncommitted work or to claim a branch git says is taken.
 *    A safeguard can only be overridden by a human running git, deliberately.
 *  - **`--porcelain -z` for parsing.** The non-`-z` form escapes unusual
 *    characters and quotes paths containing them, so a parser for it must
 *    reimplement git's C-style quoting. The `-z` form emits raw NUL-separated
 *    fields, which makes parsing a split rather than an unescape.
 *  - **Paths stay native, comparison normalizes.** Git prints forward slashes
 *    even on Windows while the harness hands us backslashes. Rather than pick a
 *    dialect everywhere, stored paths keep the form the OS uses and
 *    {@link compareKey} is the single place that decides when two spellings name
 *    one file.
 *
 * @module dsh-report-ledger/report/worktree
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join, normalize, resolve } from 'node:path'

/** Directory name, under a repository's parent, that holds ledger-allocated worktrees. */
export const WORKTREE_DIR = '.dsh-worktrees'

/** Default timeout for one git invocation. */
const GIT_TIMEOUT_MS = 30_000

/** Exit status used for a failure that never reached git (a missing binary). */
const NOT_EXECUTED = -1

/** The outcome of one git invocation. */
export interface GitResult {
  /** Whether git exited zero. */
  readonly ok: boolean
  /** Exit status, or {@link NOT_EXECUTED} when the binary could not be run. */
  readonly code: number
  /** Standard output, decoded as UTF-8. */
  readonly stdout: string
  /** Standard error, or the spawn failure message when git never ran. */
  readonly stderr: string
}

/**
 * One entry of `git worktree list`.
 *
 * `branch` is the short name (`feature`, not `refs/heads/feature`) because that
 * is the name every other layer — the digest, a remote, a human — uses.
 */
export interface WorktreeEntry {
  /** Absolute path of the working tree, in native form. */
  readonly path: string
  /** Commit the tree is on, when git reported one. */
  readonly head?: string
  /** Short branch name; absent for a detached or bare entry. */
  readonly branch?: string
  /** Whether HEAD is detached. */
  readonly detached: boolean
  /** Whether this is the bare repository itself. */
  readonly bare: boolean
  /** Whether the entry is locked against pruning. */
  readonly locked: boolean
  /** The lock's reason, when one was recorded. */
  readonly lockReason?: string
  /**
   * Whether git considers the administrative entry prunable.
   *
   * This means the entry's working tree is *gone*: the tree can still be usable
   * on its own (git resolves its git-dir from the `.git` file), but the shared
   * repository no longer finds it, and one `git worktree prune` will destroy the
   * administrative directory out from under it. Treat a prunable entry as a
   * worktree in danger, never as a healthy one.
   */
  readonly prunable: boolean
  /** Why git considers it prunable, when a reason was reported. */
  readonly prunableReason?: string
}

/**
 * Where a repository lives, and where ledger-allocated worktrees for it belong.
 *
 * A repository can have several working trees but only one common directory, so
 * this is a property of the repository rather than of any one checkout.
 */
export interface RepoLocation {
  /** Absolute path of the shared git directory (`$GIT_COMMON_DIR`). */
  readonly commonDir: string
  /** Absolute path of the repository: the main worktree root, or the bare dir. */
  readonly repoRoot: string
  /** Absolute path of the directory containing the repository. */
  readonly repoParent: string
  /** Repository name, used to keep sibling repositories' worktrees apart. */
  readonly repoName: string
  /** Whether this is a bare repository (no main working tree). */
  readonly bare: boolean
  /**
   * Default root for this repository's allocated worktrees:
   * `<repoParent>/.dsh-worktrees/<repoName>`.
   *
   * Outside the repository on purpose. Inside, an allocated checkout would be
   * picked up as untracked content by every `git status`, watched and rebuilt by
   * every tool that walks the tree, and recursed into by the very dependency
   * directories the isolation is meant to keep apart.
   */
  readonly worktreeRoot: string
}

/** How git refused an operation, when the refusal is one we recognize. */
export type GitRefusal =
  | 'branch-in-use'
  | 'branch-exists'
  | 'missing-but-registered'
  | 'path-exists'
  | 'unclean'
  | 'locked'
  | 'main-working-tree'
  | 'unknown'

/**
 * Recognized refusals, most specific first.
 *
 * Every pattern is copied from a message observed from git 2.49 on Windows.
 * Matching on prose is brittle by nature, so the classifier exists only to let
 * the caller choose a *remedy*; the raw stderr is always passed through
 * unchanged, and `unknown` is a correct answer rather than a failure.
 *
 * Order carries meaning. `a branch named 'x' already exists` and `'<path>'
 * already exists` are different problems with different remedies — reuse or
 * rename the branch, versus choose another directory — and git words both with
 * "already exists", so the branch form has to be recognized before the generic
 * one or every name collision looks like a full directory.
 */
const REFUSALS: readonly (readonly [GitRefusal, RegExp])[] = [
  ['branch-in-use', /is already used by worktree at/i],
  ['branch-exists', /a branch named .* already exists/i],
  ['missing-but-registered', /is a missing but already registered worktree/i],
  ['main-working-tree', /is a main working tree|cannot be locked or unlocked/i],
  ['locked', /cannot remove a locked working tree/i],
  ['unclean', /contains modified or untracked files/i],
  ['path-exists', /already exists/i],
]

/**
 * Run one git command and capture its result without throwing.
 *
 * The ledger treats a git refusal as information, not as an exception: "this
 * branch is taken" is a normal answer that has to reach a model as a sentence.
 * So this returns the exit status instead of rejecting, and a binary that cannot
 * be run at all is reported the same way rather than as a crash.
 * @param cwd - directory to run in.
 * @param args - arguments after the program name.
 * @returns the exit status and both streams.
 */
export async function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return await new Promise<GitResult>((settle) => {
    // Git's environment variables can redirect every command to another
    // repository (GIT_DIR/GIT_WORK_TREE/...); a plugin must judge the path it was
    // given, not the shell's current repository.
    const env = { ...process.env }
    delete env.GIT_DIR
    delete env.GIT_WORK_TREE
    delete env.GIT_INDEX_FILE
    delete env.GIT_OBJECT_DIRECTORY
    delete env.GIT_COMMON_DIR
    execFile('git', [...args], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      // A missing binary reports a string code (`ENOENT`) rather than an exit
      // status; normalizing it keeps every caller branching on one shape.
      const raw = (error as (Error & { code?: unknown }) | null)?.code
      const out = typeof stdout === 'string' ? stdout : ''
      const err = typeof stderr === 'string' ? stderr : ''
      settle({
        ok: error === null,
        code: error === null ? 0 : (typeof raw === 'number' ? raw : NOT_EXECUTED),
        stdout: out,
        stderr: err === '' ? (error?.message ?? '') : err,
      })
    })
  })
}

/**
 * Read the installed git version.
 * @param cwd - directory to run in; defaults to the current directory.
 * @returns the version line, or `undefined` when git is unavailable.
 */
export async function gitVersion(cwd?: string): Promise<string | undefined> {
  const result = await runGit(cwd ?? process.cwd(), ['--version'])
  return result.ok ? result.stdout.trim() : undefined
}

/**
 * Whether a git version supports `git worktree add --relative-paths`.
 *
 * Worth asking before using the flag, because it is not merely cosmetic: it
 * implies the `extensions.relativeWorktrees` repository format extension, so
 * turning it on raises `core.repositoryformatversion` to 1 and older git
 * installations refuse to touch the repository at all.
 * @param version - a `git --version` line.
 * @returns true when the version is 2.48 or newer.
 */
export function supportsRelativePaths(version: string): boolean {
  const match = /(\d+)\.(\d+)/.exec(version)
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 2 || (major === 2 && minor >= 48)
}

/**
 * Why the `relativePaths` option cannot be honoured on this host, if it cannot.
 *
 * Exists because the gate has to be *asked*: the flag only exists from git
 * 2.48, and passing it to an older git fails every single allocation with
 * `unknown option 'relative-paths'` — a refusal that is correct but arrives
 * after the work has started, and says nothing about the one-line fix. Asking
 * first turns that into a sentence naming the version and the remedy.
 * @param version - a `git --version` line, or `undefined` when git could not be
 * asked at all.
 * @returns `undefined` when the option is supported, otherwise the reason.
 */
export function relativePathsRefusal(version: string | undefined): string | undefined {
  if (version === undefined) {
    return 'the relativePaths option needs git 2.48 or newer, and git could not be asked for its version'
  }
  if (supportsRelativePaths(version)) return undefined
  return `the relativePaths option needs git 2.48 or newer, and this host reports "${version.trim()}"`
}

/**
 * Locate the repository a directory belongs to.
 *
 * Answers `undefined` rather than throwing when the directory is not in a
 * repository, because "not a repository" is the ordinary answer for the many
 * sessions that never touch one, and the caller must be able to ask cheaply.
 * @param cwd - a directory inside the repository (or the repository itself).
 * @returns the location, or `undefined` when this is not a git repository.
 */
export async function resolveRepo(cwd: string): Promise<RepoLocation | undefined> {
  if (cwd.trim() === '') return undefined
  const common = await runGit(cwd, ['rev-parse', '--git-common-dir'])
  if (!common.ok) return undefined
  const reported = common.stdout.trim()
  if (reported === '') return undefined
  // `rev-parse` answers relatively for the main worktree (`.git`) and absolutely
  // for a linked one. Resolving against the caller's directory covers both
  // without depending on `--path-format=absolute`, which needs git 2.31.
  const commonDir = normalize(resolve(cwd, reported))
  const bare = (await runGit(cwd, ['rev-parse', '--is-bare-repository'])).stdout.trim() === 'true'
  // For a normal repository the common dir is `<root>/.git`, so the root is its
  // parent; a bare repository's common dir *is* the repository.
  const repoRoot = bare ? commonDir : dirname(commonDir)
  const repoParent = dirname(repoRoot)
  const repoName = basename(repoRoot).replace(/\.git$/i, '') || 'repo'
  return {
    commonDir,
    repoRoot,
    repoParent,
    repoName,
    bare,
    worktreeRoot: join(repoParent, WORKTREE_DIR, repoName),
  }
}

/** Strip `refs/heads/` so a branch is named the way every other layer names it. */
function shortBranch(ref: string): string {
  const prefix = 'refs/heads/'
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref
}

/**
 * Parse `git worktree list --porcelain -z` output.
 *
 * In the `-z` form every field is NUL-terminated and a record ends at an empty
 * field, so a record boundary is a split on `\0` that yields `''`. Fields are
 * `key value`, or a bare `key` for a boolean one (`detached`, `bare`) and for a
 * flag whose reason is optional (`locked`, `prunable`).
 * @param raw - the command's standard output.
 * @returns one entry per record that carried a path.
 */
export function parseWorktreeList(raw: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let fields = new Map<string, string>()
  const flush = (): void => {
    const path = fields.get('worktree')
    if (path !== undefined && path !== '') {
      const head = fields.get('HEAD')
      const branchRef = fields.get('branch')
      const lockReason = fields.get('locked')
      const prunableReason = fields.get('prunable')
      entries.push({
        path: normalize(path),
        detached: fields.has('detached'),
        bare: fields.has('bare'),
        locked: fields.has('locked'),
        prunable: fields.has('prunable'),
        ...(head === undefined || head === '' ? {} : { head }),
        ...(branchRef === undefined || branchRef === '' ? {} : { branch: shortBranch(branchRef) }),
        ...(lockReason === undefined || lockReason === '' ? {} : { lockReason }),
        ...(prunableReason === undefined || prunableReason === '' ? {} : { prunableReason }),
      })
    }
    fields = new Map()
  }
  for (const field of raw.split('\0')) {
    if (field === '') {
      flush()
      continue
    }
    const space = field.indexOf(' ')
    if (space < 0) fields.set(field, '')
    else fields.set(field.slice(0, space), field.slice(space + 1))
  }
  flush()
  return entries
}

/**
 * List every working tree of a repository.
 * @param repo - the repository.
 * @returns one entry per working tree, main worktree first.
 * @throws when git itself cannot be asked.
 */
export async function listWorktrees(repo: RepoLocation): Promise<WorktreeEntry[]> {
  const result = await runGit(repo.commonDir, ['worktree', 'list', '--porcelain', '-z'])
  if (!result.ok) {
    throw new Error(`report-ledger: git worktree list failed: ${result.stderr.trim() || `exit ${result.code}`}`)
  }
  return parseWorktreeList(result.stdout)
}

/**
 * Map each branch to the entry currently holding it.
 *
 * Prunable entries are skipped deliberately. Their working tree is gone, so they
 * do not actually hold anything — which is precisely why a stale entry must not
 * be allowed to block reuse forever, and why the same list yields two different
 * answers depending on the question being asked.
 * @param entries - entries from {@link listWorktrees}.
 * @returns branch name to holding entry.
 */
export function branchHolders(entries: readonly WorktreeEntry[]): Map<string, WorktreeEntry> {
  const holders = new Map<string, WorktreeEntry>()
  for (const entry of entries) {
    if (entry.branch === undefined || entry.prunable) continue
    if (!holders.has(entry.branch)) holders.set(entry.branch, entry)
  }
  return holders
}

/**
 * Whether a working tree has no modification, no staged change and no untracked
 * file.
 *
 * Untracked files count as dirty on purpose: they are exactly what `git worktree
 * remove` refuses to delete, so a check that ignored them would authorize a
 * removal git then rejects.
 * @param worktreePath - the working tree to inspect.
 * @returns true only when git confirms a clean tree; a failure to ask answers
 * false, because an unreadable tree must never be treated as safe to delete.
 */
export async function isWorktreeClean(worktreePath: string): Promise<boolean> {
  const result = await runGit(worktreePath, ['status', '--porcelain'])
  if (!result.ok) return false
  return result.stdout.trim() === ''
}

/**
 * Read the commit a working tree is on.
 * @param worktreePath - the working tree to inspect.
 * @returns the object id, or `undefined` for an unborn branch or a failure.
 */
export async function headOf(worktreePath: string): Promise<string | undefined> {
  const result = await runGit(worktreePath, ['rev-parse', 'HEAD'])
  if (!result.ok) return undefined
  const sha = result.stdout.trim()
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined
}

/**
 * What a ledger-recorded path actually is, on disk, right now.
 *
 * `missing` and `not-a-worktree` are deliberately different answers: the first
 * means the directory is gone, the second means *something* is there but it is
 * not a working tree of a repository. Collapsing them is what makes a bound
 * directory that stopped being a checkout read as dirty (`git status` fails
 * there) instead of as stale, which is both a wrong diagnosis and a permanent
 * occupant of the retained budget.
 */
export type CheckoutPresence = 'worktree' | 'missing' | 'not-a-worktree'

/** The reality behind one binding. */
export interface CheckoutReality {
  /** What is at the recorded path. */
  readonly presence: CheckoutPresence
  /** The branch git reports there; absent for a detached or unusable tree. */
  readonly branch?: string
  /** The repository it resolved to, when it resolved at all. */
  readonly repo?: RepoLocation
}

/**
 * Ask git what is at a recorded path.
 *
 * The single place that answers "is this still a checkout", so reclamation and
 * the maintenance view cannot disagree about it. A failure to *ask* is answered
 * as `worktree`: calling a checkout stale on a broken subprocess would hand the
 * caller a licence to delete something no one managed to look at.
 * @param worktreePath - the recorded path.
 * @returns the reality, classified.
 */
export async function inspectCheckout(worktreePath: string): Promise<CheckoutReality> {
  if (!existsSync(worktreePath)) return { presence: 'missing' }
  const repo = await resolveRepo(worktreePath)
  if (repo === undefined) return { presence: 'not-a-worktree' }
  let entries: readonly WorktreeEntry[]
  try {
    entries = await listWorktrees(repo)
  } catch {
    return { presence: 'worktree', repo }
  }
  const entry = entries.find((candidate) => samePath(candidate.path, worktreePath))
  if (entry === undefined || entry.prunable) return { presence: 'not-a-worktree', repo }
  return {
    presence: 'worktree',
    ...(entry.branch === undefined ? {} : { branch: entry.branch }),
    repo,
  }
}

/**
 * Whether a repository uses submodules.
 *
 * Git's own manual is explicit that multiple checkouts are experimental and that
 * support for submodules is incomplete — a linked worktree containing submodules
 * cannot even be moved. So this is a gate the caller is expected to consult
 * before allocating, not a warning to print afterwards.
 *
 * A bare repository answers false: the answer is derived from the working tree's
 * `.gitmodules`, which a bare repository does not have.
 * @param repo - the repository.
 * @returns true when `.gitmodules` exists in the main working tree.
 */
export function hasSubmodules(repo: RepoLocation): boolean {
  if (repo.bare) return false
  return existsSync(join(repo.repoRoot, '.gitmodules'))
}

/** Fields common to both ways of attaching a working tree. */
interface AddWorktreeCommon {
  /** The repository to attach the new working tree to. */
  readonly repo: RepoLocation
  /** Absolute path of the new working tree. Its parent directory must exist. */
  readonly path: string
  /** The branch, created or already existing depending on the variant. */
  readonly branch: string
  /** Write linking files as relative paths. Raises the repository format version. */
  readonly relativePaths?: boolean
}

/** Create a new branch at `base` and check it out in a new working tree. */
export interface AddWorktreeOnNewBranch extends AddWorktreeCommon {
  /** Commit-ish to branch from. */
  readonly base: string
  /** Absent or false: the branch is created. */
  readonly checkoutExisting?: false
}

/**
 * Check out a branch that already exists.
 *
 * This is the recovery and reuse path: a previous allocation may have created
 * the branch and then failed before the working tree existed, and a lease may be
 * handed to a new holder without a new branch. It is also the only way git's
 * occupancy check can ever be reached from this adapter, which is exactly why it
 * exists — creating a branch with `-b` fails earlier, on the name collision,
 * and never gets as far as reporting who holds it.
 */
export interface AddWorktreeOnExistingBranch extends AddWorktreeCommon {
  /** True: check out {@link AddWorktreeCommon.branch} as it stands. */
  readonly checkoutExisting: true
}

/** What {@link addWorktree} needs. */
export type AddWorktreeInput = AddWorktreeOnNewBranch | AddWorktreeOnExistingBranch

/**
 * Attach a linked working tree.
 *
 * There is no force flag: git's occupancy check and its refusal of an unclean
 * path are returned to the caller as results, never overridden. A refusal is
 * data the ledger turns into a sentence naming a remedy.
 * @param input - what to create or check out.
 * @returns the git result; the caller decides whether a refusal is fatal.
 */
export async function addWorktree(input: AddWorktreeInput): Promise<GitResult> {
  const args = ['worktree', 'add']
  if (input.relativePaths === true) args.push('--relative-paths')
  if (input.checkoutExisting === true) args.push(input.path, input.branch)
  else args.push('-b', input.branch, input.path, input.base)
  return await runGit(input.repo.commonDir, args)
}

/**
 * Remove a linked working tree.
 *
 * Deliberately without a force option. Git refuses when the tree is unclean or
 * locked, and that refusal is the last line of defence for work no one has
 * committed; exposing `--force` here would turn a policy mistake in the ledger
 * into silent data loss. A human who truly wants the tree gone can run the
 * command themselves, which is the correct amount of friction.
 * @param repo - the repository the tree belongs to.
 * @param worktreePath - the working tree to remove.
 * @returns the git result; a refusal is data, not an exception.
 */
export async function removeWorktree(repo: RepoLocation, worktreePath: string): Promise<GitResult> {
  return await runGit(repo.commonDir, ['worktree', 'remove', worktreePath])
}

/**
 * Drop administrative entries whose working trees are gone.
 *
 * Used only by an explicit maintenance action. It is never a side effect of
 * anything: a worktree moved by hand keeps working from its own side while the
 * shared repository marks it prunable, so an automatic prune would destroy a
 * live checkout. Making this call is a decision, not housekeeping.
 * @param repo - the repository to prune.
 * @returns the git result.
 */
export async function pruneWorktrees(repo: RepoLocation): Promise<GitResult> {
  return await runGit(repo.commonDir, ['worktree', 'prune'])
}

/**
 * Classify a git refusal so the caller can name a remedy.
 * @param stderr - the command's standard error.
 * @returns the recognized kind, or `'unknown'`.
 */
export function classifyGitRefusal(stderr: string): GitRefusal {
  for (const [kind, pattern] of REFUSALS) {
    if (pattern.test(stderr)) return kind
  }
  return 'unknown'
}

/** Strip a trailing separator without ever eating a root. */
function stripTrailingSeparators(path: string): string {
  if (/^[a-zA-Z]:[\\/]$/.test(path)) return path
  if (/^[\\/]{1,2}$/.test(path)) return path
  return path.replace(/[\\/]+$/, '')
}

/**
 * Reduce a path to the string two spellings are compared by.
 *
 * The single place that decides when two paths name one file. Windows compares
 * case-insensitively and treats either separator as a separator; a POSIX host
 * does neither, so the rule is the host's rather than a lowest common
 * denominator — comparing case-insensitively on Linux would merge two directories
 * git considers distinct.
 * @param path - a path, absolute or relative to the current directory.
 * @returns the comparison key.
 */
export function compareKey(path: string): string {
  const absolute = stripTrailingSeparators(normalize(resolve(path)))
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * Whether two paths name the same file.
 * @param left - one path.
 * @param right - another path.
 * @returns true when they share a comparison key.
 */
export function samePath(left: string, right: string): boolean {
  return compareKey(left) === compareKey(right)
}
