/**
 * The Host desktop's file verbs, as a third-party plugin may reach them.
 *
 * The GUI's own "open in default app" split button belongs to the shell's
 * open-in-app plugin, and that plugin exposes the control only as **slot
 * contributions for its own cards** (`deliverables.file.actions`,
 * `sidebar.right.tab.document.actions`) — a third-party plugin can neither
 * import its component (the client bundle's purity gate rejects cross-plugin
 * value imports) nor render another package's slot (slots are rendered by their
 * hosts, and a view is a child, not a host). What *is* public is the Session
 * Remote those controls call, so this module asserts the same three verbs
 * structurally — the standing rule in this plugin: declare the shape we call,
 * and degrade to nothing when a host does not carry it.
 *
 * @module dsh-report-ledger/client/path-opener
 */

/** One file handler the Host desktop reported for a path. */
export interface WorkspacePathApplication {
  readonly id: string
  readonly name: string
  /** Small inline icon (data URL), or null when the desktop reported none. */
  readonly icon: string | null
  /** Whether this is the operating system's default handler for the path. */
  readonly default?: boolean
}

/** What one gesture asks of the desktop. */
export type PathAction = 'open' | 'reveal'

/** The file verbs the ledger path row uses. */
export interface PathOpener {
  /** Whether the serving Host has a desktop that can take paths at all. */
  available(): Promise<boolean>
  /** Registered handlers for one path, in host menu order. `null` when the query failed. */
  applications(path: string, signal: AbortSignal): Promise<readonly WorkspacePathApplication[] | null>
  /** Hand one path to its default app, a named app, or the file manager. */
  open(path: string, action: PathAction, application?: string): Promise<boolean>
}

/** The carrier every Remote method resolves to; only the branch matters here. */
interface RemoteResultLike<T> {
  readonly ok: boolean
  readonly value?: T
}

/** The slice of `remote.session` this module calls. */
interface SessionRemoteLike {
  canOpenWorkspacePath?(): Promise<RemoteResultLike<boolean>>
  workspacePathApplications?(
    request: { readonly path: string },
    signal?: AbortSignal,
  ): Promise<RemoteResultLike<readonly WorkspacePathApplication[]>>
  /**
   * The Host's own request shape, not this module's: `action` names **only**
   * `reveal`, and omitting it is how "open in the default application" is said.
   * Sending `action: 'open'` fails the gateway's boundary validation — measured
   * in the GUI, and the reason {@link PathAction} is translated, not passed on.
   */
  openWorkspacePath?(
    request: { readonly path: string; readonly action?: 'reveal'; readonly application?: string },
    signal?: AbortSignal,
  ): Promise<RemoteResultLike<unknown>>
}

/**
 * Wrap a session Remote in the three verbs, when the host carries them.
 * @param remote - the `remote.session` service, or whatever the context returned.
 * @returns the opener, or `undefined` when this deployment has no such face.
 */
export function createPathOpener(remote: unknown): PathOpener | undefined {
  if (remote === null || typeof remote !== 'object') return undefined
  const face = remote as SessionRemoteLike
  if (typeof face.canOpenWorkspacePath !== 'function' || typeof face.openWorkspacePath !== 'function') {
    return undefined
  }
  return {
    async available(): Promise<boolean> {
      const answer = await face.canOpenWorkspacePath?.()
      return answer?.ok === true && answer.value === true
    },
    async applications(path: string, signal: AbortSignal): Promise<readonly WorkspacePathApplication[] | null> {
      if (typeof face.workspacePathApplications !== 'function') return null
      const answer = await face.workspacePathApplications({ path }, signal)
      return answer.ok === true && Array.isArray(answer.value) ? answer.value : null
    },
    async open(path: string, action: PathAction, application?: string): Promise<boolean> {
      const answer = await face.openWorkspacePath?.({
        path,
        // `reveal` is the only action the wire knows; a plain open is its absence.
        ...(action === 'reveal' ? { action: 'reveal' as const } : {}),
        ...(application === undefined ? {} : { application }),
      })
      return answer?.ok === true
    },
  }
}
