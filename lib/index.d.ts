import { Context } from "@deepseek-ai/cordis";

//#region src/report/worktree.d.ts
/**
 * Where a repository lives, and where ledger-allocated worktrees for it belong.
 *
 * A repository can have several working trees but only one common directory, so
 * this is a property of the repository rather than of any one checkout.
 */
interface RepoLocation {
  /** Absolute path of the shared git directory (`$GIT_COMMON_DIR`). */
  readonly commonDir: string;
  /** Absolute path of the repository: the main worktree root, or the bare dir. */
  readonly repoRoot: string;
  /** Absolute path of the directory containing the repository. */
  readonly repoParent: string;
  /** Repository name, used to keep sibling repositories' worktrees apart. */
  readonly repoName: string;
  /** Whether this is a bare repository (no main working tree). */
  readonly bare: boolean;
  /**
   * Default root for this repository's allocated worktrees:
   * `<repoParent>/.dsh-worktrees/<repoName>`.
   *
   * Outside the repository on purpose. Inside, an allocated checkout would be
   * picked up as untracked content by every `git status`, watched and rebuilt by
   * every tool that walks the tree, and recursed into by the very dependency
   * directories the isolation is meant to keep apart.
   */
  readonly worktreeRoot: string;
}
//#endregion
//#region src/report/types.d.ts
/**
 * The report model.
 *
 * A report is the plugin's first-class interaction primitive between agents. It
 * is deliberately two-layered:
 *
 *  - the FRONT MATTER is the digest — a bounded flat mapping that can enter a
 *    model context, an index, or a timeline card without dragging the body in;
 *  - the BODY is the detail, stored out of context and read on demand.
 *
 * The transfer path is a third, append-only stream (see {@link RouteHop}): every
 * hop — authoring, contribution, send, delivery, CC, forwarding, copying, read,
 * acknowledgement — is recorded with its actor and time, so the complete route
 * including every copy survives independently of the report text.
 *
 * @module dsh-report-ledger/report/types
 */
/**
 * Every report status, as both the runtime list and the source of
 * {@link ReportStatus}.
 *
 * A union type and a validator array are two spellings of one fact, and two
 * spellings drift. The parser falls back to `open` for anything it does not
 * recognize, so a status that existed in the type but not in the array would
 * quietly rewrite itself on the next read.
 */
declare const REPORT_STATUSES: readonly ["open", "acked", "closed"];
/** Lifecycle of a report. */
type ReportStatus = (typeof REPORT_STATUSES)[number];
/**
 * One recorded hop in a report's transfer path.
 *
 * `authored` and `contributed` establish co-authorship; `sent`/`delivered` are
 * the addressed hand-off and its arrival; `cc` is a quiet copy; `forwarded` and
 * `copied` are onward transfer and duplication; `read`/`acked` close the loop for
 * one reader; `leased`/`released` bracket a claim on a working tree, and
 * `reclaimed` records that the ledger cleared a checkout away because the owner
 * asked for it at closing time;
 * `amended` records a correction to the digest or the body; `closed` concludes
 * the matter, and `reopened` records that fresh activity brought it back to life;
 * `transferred` moves one unpaid hand-off from the session that owed it to
 * another, without ever claiming it was delivered.
 *
 * Declared as a value and derived into a type on purpose. The parser validates
 * each record against this list and **drops** one it does not recognize, so a
 * union that named an action this array omitted would lose those hops from the
 * audit trail without a word — the single failure a ledger must not have.
 * Deriving the type from the value makes that drift impossible rather than
 * merely unlikely; it happened once already, when `leased` and `released`
 * reached the union before the array.
 */
declare const HOP_ACTIONS: readonly ["authored", "contributed", "sent", "delivered", "cc", "forwarded", "copied", "read", "acked", "leased", "released", "reclaimed", "amended", "closed", "reopened", "transferred"];
/** What happened in one hop. */
type HopAction = (typeof HOP_ACTIONS)[number];
/** How a report is handed to one recipient. */
type DeliveryMode = 'wakeup' | 'quiet';
/**
 * A working tree a report is bound to.
 *
 * The binding is the ledger's half of a two-layer answer to "who may write this
 * checkout". The ledger knows which report *intends* to hold a branch; git knows
 * which working tree actually has it checked out. Neither answers alone — git
 * cannot name the responsible report, and the ledger cannot see a checkout a
 * human made — so both are consulted and a disagreement is reported, never
 * silently resolved.
 *
 * This is authored state, not a projection of the hop stream: the digest is only
 * a cache of `to`, `cc`, `authors`, `hops` and `last`, so a binding survives
 * every hop refresh. Absent means no working tree, which is the ordinary case.
 */
interface ReportWorktree {
  /** Absolute path of the working tree. */
  readonly path: string;
  /** Short branch name; absent when the tree is on a detached HEAD. */
  readonly branch?: string;
  /** The commit the tree was on when the binding was recorded. */
  readonly head?: string;
  /**
   * Shared git directory of the repository.
   *
   * Recorded so a binding can still name its repository after the ledger or the
   * repository has moved, which is the difference between an error a reader can
   * act on and one they cannot.
   */
  readonly repo?: string;
  /**
   * Whether the ledger created this working tree.
   *
   * Only an allocated tree may be removed by an explicit close. A tree the
   * ledger merely adopted belongs to whoever made it, and no policy here is
   * entitled to delete it.
   */
  readonly allocated?: boolean;
}
/**
 * The digest: everything that can be shown or reasoned about cheaply.
 *
 * Deliberately flat and scalar-only so it can be rendered as YAML front matter,
 * scanned from disk without parsing a body, and injected into a prompt.
 */
interface ReportFrontMatter {
  /** Ledger-scoped identifier, e.g. `R-0007`. */
  readonly report: string;
  /** One-line subject. */
  readonly subject: string;
  /** Lifecycle status. */
  readonly status: ReportStatus;
  /** Originator session id. */
  readonly from: string;
  /** Originator display name when known. */
  readonly fromName?: string;
  /** Addressed recipients, in send order. */
  readonly to: readonly string[];
  /** Carbon-copy recipients, in copy order. */
  readonly cc: readonly string[];
  /** Every agent that authored or contributed, in contribution order. */
  readonly authors: readonly string[];
  /** Creation time, Unix epoch milliseconds. */
  readonly created: number;
  /** Last modification time, Unix epoch milliseconds. */
  readonly updated: number;
  /** Upstream report this one answers, when it is a reply report. */
  readonly parent?: string;
  /** Reports this one has spawned downstream. */
  readonly children: readonly string[];
  /** Free-form task/thread label grouping reports of one collaboration. */
  readonly task?: string;
  /** Working tree this report is bound to, when one is in use. */
  readonly worktree?: ReportWorktree;
  /** Referenced artifacts (paths, commit ids, report ids). */
  readonly artifacts: readonly string[];
  /** Number of recorded hops — the cheap indicator that the full path exists. */
  readonly hops: number;
  /**
   * How many of those hops were reads.
   *
   * Split out of `hops` because the two answer different questions. A read is an
   * audit fact — who opened the body — and never a causal act, so counting it in
   * the one cheap "how much happened" signal turned that signal into a traffic
   * counter: the only way to learn what work a report had seen was to subtract by
   * hand, and a listing whose last hop was a glance read as freshly active.
   *
   * Derived from the same hop stream, so the split costs no extra state and no
   * migration: a digest written before this field existed reports `reads: 0` and
   * is repaired by the first mutation (or by the digest-repair pass).
   */
  readonly reads: number;
  /** The most recent hop, inlined so a digest can show "where it is now". */
  readonly last?: {
    readonly at: number;
    readonly action: HopAction;
    readonly actor: string;
  };
  /**
   * Spill locator of the body when it was moved out of context. Present only
   * when the body exceeded the inline budget.
   */
  readonly spill?: string;
}
//#endregion
//#region src/report/allocate.d.ts
/** The resolved settings allocation obeys. */
interface WorktreeSettings {
  /** Cap on checkouts held at once. */
  readonly maxActive: number;
  /** Warning threshold for checkouts kept on disk after their claim ended, per repository. */
  readonly maxRetained: number;
  /** Base directory for allocated checkouts; the default is beside the repository. */
  readonly base?: string;
  /** Write linking files as relative paths. Raises the repository format version. */
  readonly relativePaths: boolean;
}
/**
 * Plugin configuration for working-tree support.
 *
 * Every field is optional and the feature is off unless `enabled` is set, so a
 * deployment that does not want it pays nothing — no git invocation, no
 * directory, and not even a parameter in the tools the model sees.
 */
interface WorktreeConfig {
  /** Turn the feature on. */
  enabled?: boolean;
  /** Base directory for allocated checkouts; the default is beside the repository. */
  root?: string;
  /**
   * What closing a report does with a bound checkout.
   * @default 'keep'
   */
  onClose?: 'keep' | 'remove-if-clean';
  /**
   * Cap on checkouts held at once.
   *
   * A coordination limit, and the one a caller waits on. No allocation can
   * raise it, because what it would have to clear is a checkout someone is
   * working in.
   * @default 4
   */
  maxActive?: number;
  /**
   * Warning threshold for checkouts kept on disk after their claim ended,
   * counted per repository. Exceeding it never deletes anything; the maintenance
   * view reports the count and points at explicit cleanup.
   * @default 4
   */
  maxRetained?: number;
  /**
   * Write linking files as relative paths, so a repository and its checkouts can
   * be moved together.
   *
   * Off by default because it is not cosmetic: it implies the
   * `extensions.relativeWorktrees` repository format extension, which raises
   * `core.repositoryformatversion` to 1, and older git then refuses to touch the
   * repository at all.
   */
  relativePaths?: boolean;
}
/** A binding whose checkout is no longer a usable working tree. */
interface StaleBinding {
  /** The report that owns the vanished checkout. */
  readonly report: string;
  /** Where the checkout used to be. */
  readonly path: string;
  /**
   * What was found there instead, when something was.
   *
   * Absent when the directory is simply gone; present when a directory exists
   * but is no longer a working tree of its repository, because that is a
   * different fact and reading it as "vanished" would be a quiet lie in the
   * audit trail.
   */
  readonly detail?: string;
}
//#endregion
//#region src/report/deliver.d.ts
/**
 * A message handed to an agent inbox. Structurally a `UserMessage`.
 *
 * `source.kind` is the producer's own name, not a catch-all. DSH's session
 * format v4 retired the shared `kind: 'plugin'` wrapper: native admission
 * refuses it outright (`format v4 message requires a producer-owned source
 * kind`), so a delivery written with it kills the recipient's first turn at
 * step 1 — before any model call, which is why the failure used to look like a
 * silent hand-off. The value below is the same string the v3→v4 migration
 * derives for this plugin (`plugin:<id>`), so messages written before and
 * after this change name one producer.
 */
interface OutboundMessage {
  readonly id: string;
  readonly role: 'user';
  readonly content: readonly {
    readonly type: 'text';
    readonly text: string;
  }[];
  readonly source: {
    readonly kind: 'plugin:report-ledger';
    readonly form: 'relay';
  };
}
/** The slice of a live agent this module needs. */
interface AgentLike {
  /** Session id of the agent. */
  readonly id: string;
  /** Queue steered content for the nearest step, waking an idle driver. */
  steer(message: OutboundMessage): void;
  /** Queue model-facing context without waking the driver. */
  inject(message: OutboundMessage): void;
}
/** Where one hand-off went. */
interface DeliveryOutcome {
  /** Target session id. */
  readonly targetId: string;
  /**
   * `delivered` when it reached a live agent; `queued` when it is held.
   *
   * Read narrowly: this certifies ARRIVAL, not work. An agent that is resident
   * accepts the digest and the inbox splice it causes is durable, but whether a
   * turn then opens — and whether that turn survives its first step — is a
   * separate question this outcome deliberately does not answer. Anything that
   * needs the stronger claim must observe it (`PeerService.receipt` is that
   * observation for a peer's first turn).
   */
  readonly status: 'delivered' | 'queued';
}
//#endregion
//#region src/report/timeline.d.ts
/** The session-header fields the timeline reads. */
interface SessionHeaderLike {
  /** Session id. */
  readonly id: string;
  /** Session this one was forked from or spawned by. */
  readonly parentSession?: string;
  /** Creation time, Unix epoch milliseconds. */
  readonly createdAt?: number;
  /** Delegation depth; absent (zero) for a top-level session. */
  readonly delegationDepth?: number;
  /** Coarse product classification; `subagent` marks a delegated child. */
  readonly origin?: string;
  /** Agent preset the session runs under. */
  readonly agentPreset?: string;
}
/** One session record as the timeline consumes it. */
interface SessionRecordLike {
  /** The durable header. */
  readonly header: SessionHeaderLike;
  /** Whether the session is resident in this process. */
  readonly live?: boolean;
}
//#endregion
//#region src/report/roster.d.ts
/** How a session stands in relation to the caller. */
type PeerRelation = 'ancestor' | 'descendant' | 'sibling' | 'started' | 'contact' | 'co-present';
/** One roster row. */
interface PeerRow {
  /** Session id. */
  readonly sessionId: string;
  /** How the caller is related to it. */
  readonly relation: PeerRelation;
  /** Display title, when one could be resolved. */
  readonly title?: string;
  /** Name supplied when the caller started it. */
  readonly name?: string;
  /** Whether it is resident right now, so a delivery would land immediately. */
  readonly live: boolean;
  /** Delegation depth, when recorded. */
  readonly depth?: number;
  /** Reports in the ledger that touch both sessions. */
  readonly reports: number;
  /** Most recent activity seen for it, Unix epoch milliseconds. */
  readonly lastActivity?: number;
}
//#endregion
//#region src/report/peer.d.ts
/**
 * What actually happened to the peer's first turn.
 *
 * This exists because the delivery vocabulary cannot answer the question a
 * starter is really asking. `delivered` means the digest reached a live agent;
 * it is silent about whether a turn opened, and a turn that opens and dies at
 * step 1 (an unresolvable prompt variable, an unregistered route) produces
 * exactly the same `delivered` and exactly the same `live` roster row as a peer
 * that is happily working. Every kind below is an OBSERVATION with a bound on it,
 * not a promise.
 */
interface PeerReceipt {
  /**
   * - `running` — a turn was open and still open when the observation window closed.
   * - `settled` — a turn ran and finished inside the window.
   * - `failed` — a turn ran and ended in error inside the window ({@link PeerReceipt.error}).
   * - `unstarted` — nothing was ever appended after the delivery: no turn opened.
   */
  readonly kind: 'running' | 'settled' | 'failed' | 'unstarted';
  /** The last turn's stop reason, when one settled (`completed`, `aborted`, `blocked`, …). */
  readonly reason?: string;
  /** The failing turn's message, when it ended in error. */
  readonly error?: string;
}
/**
 * The permission state a host captured for a peer at creation.
 *
 * Every field is optional because each knob is owned by a separate optional
 * service: a deployment can compose the sandbox policy and not the presets, and
 * the host reports exactly what it could read rather than guessing. The state is
 * a copy, not a live view — a peer's own later switch is its business, and the
 * starter's later switches are the starter's.
 */
interface PeerPermission {
  /** The inherited preset identity, when it names a configured preset (or live Auto). */
  readonly preset?: string;
  /** The inherited sandbox mode. */
  readonly sandbox?: string;
  /** The inherited approval policy. */
  readonly approval?: string;
}
/** A freshly created peer. */
interface StartedPeer {
  /** Its session id — the address to report to. */
  readonly sessionId: string;
  /** The display name supplied by the starter, when any. */
  readonly name?: string;
  /** The working directory it inherited. */
  readonly cwd?: string;
  /** How many peers the starter now owns, including this one. */
  readonly started: number;
  /**
   * The permission state the peer inherited, when the host captured one.
   *
   * Reported rather than assumed because the failure it guards against is silent:
   * a peer pinned to the deployment default looks healthy everywhere else and
   * surfaces only later, as an approval prompt in a session nobody is watching.
   * Absent means the host answers no question about permissions at all.
   */
  readonly permission?: PeerPermission;
  /**
   * What became of the attempt to put the peer in a workspace group.
   *
   * Absent means this host implements no registration at all, so there are no
   * groups to be in and nothing to report. `no-workspace` means a host does
   * implement it and answered that nothing owns the peer's directory, which is
   * the legitimate case for a peer started in a checkout nobody registered.
   */
  readonly workspace?: WorkspaceRegistration;
}
/**
 * The outcome of registering one peer session with the workspace registry.
 *
 * `outcome` is deliberately three-valued rather than a boolean: "this
 * deployment has no workspace feature", "this directory is not a workspace" and
 * "the registration was attempted and failed" are different facts, and only the
 * last one is a defect. Collapsing them would turn a healthy ungrouped peer into
 * a false alarm on every deployment without the feature.
 */
interface WorkspaceRegistration {
  /** What happened. Only `failed` is a defect; see {@link WorkspaceRegistration.warning}. */
  readonly outcome: 'registered' | 'no-workspace' | 'failed';
  /** The workspace title or path, when one was matched. */
  readonly workspace?: string;
  /** The failure's text, when `outcome` is `failed`. */
  readonly warning?: string;
}
/** The harness capabilities peer management consumes. */
interface PeerHost {
  /**
   * The caller's working directory, used as the peer's.
   * @param sessionId - caller session id.
   * @returns the directory, when the session header records one.
   */
  selfCwd(sessionId: string): string | undefined;
  /**
   * Session ids resident right now.
   * @returns the live set.
   */
  liveIds(): ReadonlySet<string>;
  /**
   * Every known session record.
   * @returns the records.
   */
  listSessionRecords(): Promise<readonly SessionRecordLike[]>;
  /**
   * Resolve display titles.
   * @param ids - session ids.
   * @returns a title per session that has one.
   */
  readTitles(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /**
   * Every report digest.
   * @returns the digests.
   */
  listReports(): Promise<readonly ReportFrontMatter[]>;
  /**
   * Create one independent agent on a caller-supplied session id.
   *
   * `startedBy` is not decoration: a fresh root agent has no composition and no
   * model route of its own, so the adapter resolves both from the live starter
   * session named here. An adapter that ignores it produces a peer whose first
   * turn fails immediately.
   *
   * The same argument covers the peer's permission state, and the failure there is
   * quieter: composition and route mistakes kill the first turn, while a peer that
   * keeps the deployment's default preset merely runs under a different authority
   * than the session that opened it — inviting the user to approve, in a session
   * they are not looking at, work the starter could already do. {@link
   * PeerService.start} therefore hands the starter's id to every implementation on
   * the assumption that it is used for all of these, not just for the route.
   * @param input - the session id, the starter it is composed from, and the inherited directory.
   * @returns the new session id, its wake channel, and the permission state it inherited.
   */
  createPeer(input: {
    sessionId: string;
    startedBy: string;
    cwd?: string;
  }): Promise<{
    id: string;
    steer(message: OutboundMessage): void;
    permission?: PeerPermission;
  }>;
  /**
   * Load a persisted peer session and resume an agent on it.
   *
   * The counterpart to {@link PeerHost.createPeer} for a session that already
   * exists, and it carries the same obligation: a resumed root agent is just as
   * composition-less as a fresh one, so the host must join it to the starter's
   * live preset and hand it a model route. `startedBy` is what makes that
   * possible — without a live starter there is nothing to compose it from, and a
   * resumed peer whose every turn dies at step 1 is worse than a refusal.
   *
   * What must NOT be repeated is permission inheritance. The state was written
   * onto the peer's own log when it was created, and a warm resume restores it
   * from there; re-capturing the starter's current state here would overwrite a
   * later switch made in that session, which is exactly the promise
   * {@link PeerHost.createPeer} makes about inheriting rather than pinning.
   *
   * A host without resume support (an older harness, a deployment with no session
   * persistence) must throw with the reason rather than resolve: a wake that
   * silently did nothing would leave the hand-offs owed and the caller believing
   * they had been delivered.
   * @param input - the persisted session to load, and the live starter to compose it from.
   * @returns the resumed session id.
   */
  resumePeer(input: {
    sessionId: string;
    startedBy: string;
  }): Promise<{
    id: string;
  }>;
  /**
   * Put a freshly created peer session into the workspace group that owns its
   * directory, so the GUI lists it under that workspace instead of leaving it
   * ungrouped forever.
   *
   * Optional, and that is the honest shape of the dependency: a deployment may
   * compose no workspace registry at all (the headless profile does not), and
   * there the groups do not exist and this hook is simply absent. Implementations
   * must resolve the peer's directory the same way the registry does — by
   * canonical real path, not by string equality — or a registration attributed to
   * the wrong workspace is refused. They must also never throw: the outcome is
   * the report.
   *
   * Called after {@link PeerHost.createPeer}, because the registry validates a
   * session against the `cwd` recorded in its durable header and that header does
   * not exist until the agent does.
   * @param input - the peer session, and the directory it was created with.
   * @returns the registration outcome.
   */
  attachToWorkspace?(input: {
    sessionId: string;
    cwd?: string;
  }): Promise<WorkspaceRegistration>;
  /**
   * Observe what became of a peer's first turn, within a bound.
   *
   * Called after the assignment has been delivered, so it answers the question
   * `delivered` cannot: did a turn actually open, is it still running, or did it
   * die — and if it died, why.
   * @param sessionId - the peer session to observe.
   * @param timeoutMs - how long a still-running turn is awaited before it is reported as running.
   * @returns the observation, or `undefined` when the peer is not resident at all.
   */
  confirmPeer(sessionId: string, timeoutMs: number): Promise<PeerReceipt | undefined>;
}
/**
 * What one wake attempt found and did.
 *
 * Reported as a value rather than inferred by the caller: "it was already there"
 * and "I loaded it again" are different facts about the session's lifecycle, and
 * a caller that cannot tell them apart ends up describing a no-op as a wake.
 */
interface WokenPeer {
  /** The session the caller asked about. */
  readonly sessionId: string;
  /** The session that started it — the only one allowed to wake it. */
  readonly startedBy: string;
  /** The display name its starter gave it, when any. */
  readonly name?: string;
  /** Whether it was resident before this call. */
  readonly resident: boolean;
  /** Whether this call resumed it. Always false when it was already resident. */
  readonly resumed: boolean;
}
/** Options for {@link PeerService.wake}. */
interface WakeOptions {
  /**
   * Whether a non-resident peer is actually resumed.
   *
   * `false` answers the two questions a caller has to settle before a wake is
   * worth a turn — "may I?" and "is it here?" — without touching the host, which
   * is the only order that works: nothing un-resumes a session, so the decision
   * to load one has to be made from ledger state before the host is asked.
   * @default true
   */
  readonly resume?: boolean;
}
/** Options for {@link PeerService.start}. */
interface StartPeerInput {
  /** The task or purpose the peer is being opened for. */
  readonly task: string;
  /** Optional display name. */
  readonly name?: string;
  /**
   * Directory to start the peer in, when it should not inherit the starter's.
   *
   * A caller that allocated a working tree passes its path here, which is what
   * turns the peer's isolation from a claim into a fact: the peer's `cwd` is its
   * own checkout from its very first turn.
   */
  readonly cwd?: string;
}
/** The peer service. */
declare class PeerService {
  #private;
  /**
   * @param host - harness capabilities.
   * @param maxPeers - cap on peers one session may start.
   */
  constructor(host: PeerHost, maxPeers?: number);
  /**
   * List the sessions this caller can see.
   * @param self - the caller's session id.
   * @param options - scope and row cap.
   * @returns the roster rows.
   */
  roster(self: string, options?: {
    scope?: 'related' | 'live' | 'all';
    limit?: number;
  }): Promise<PeerRow[]>;
  /**
   * How many peers one session has already started.
   * @param self - the caller's session id.
   * @returns the count.
   */
  startedCount(self: string): Promise<number>;
  /**
   * Classify the relationship for display and discovery.
   *
   * This is **not** an authorization check before delivery: report_send and
   * report_cc accept any session id by design, because reaching out through the
   * ledger is how contact is established. Nothing in the delivery path consults
   * this predicate; it answers the narrower question the roster shows.
   * @param self - the caller's session id.
   * @param target - the session being addressed.
   * @returns true when the relationship classifier places them in contact.
   */
  holdsChannel(self: string, target: string): Promise<boolean>;
  /**
   * Observe what became of a peer's first turn.
   *
   * Not a status check: it is the honest answer to "did the thing I just handed
   * this peer actually start working?" — the question a bare `delivered` cannot
   * answer. Call it after the assignment report has been delivered.
   * @param sessionId - the peer session to observe.
   * @param timeoutMs - how long a still-running turn is awaited before being reported as running.
   * @returns the observation, or `undefined` when the peer is not resident.
   */
  receipt(sessionId: string, timeoutMs?: number): Promise<PeerReceipt | undefined>;
  /**
   * Open one independent peer session.
   *
   * The peer is recorded before it is returned, so the relationship survives even
   * if the caller's next step fails. Nothing here disposes the handle: the
   * handle's `dispose()` removes the session from the store, which is exactly
   * wrong for a partner that must outlive this turn.
   * @param self - the caller's session id.
   * @param input - the task and optional name.
   * @returns the created peer.
   * @throws when the task is empty, the name is unusable, or the cap is reached.
   */
  start(self: string, input: StartPeerInput): Promise<StartedPeer>;
  /**
   * Bring one of the caller's peers back, or say plainly why it cannot be.
   *
   * The authority rule is the point of this method, so it is checked before any
   * side effect: only the session whose roster line started the peer may wake it,
   * and a refusal names that session so the caller can hand the job over instead
   * of retrying. Two refusals are deliberately not errors of the same kind:
   *
   *  - **no roster line at all** means the plugin never started it (a subagent, a
   *    GUI session, a session from another deployment). Waking those is the
   *    harness's business; here the answer is the ledger's other tools.
   *  - **somebody else's line** means the relationship exists, it just is not the
   *    caller's. Naming the starter turns a dead end into a hand-off.
   *
   * A resume failure is wrapped rather than passed through: the host's message is
   * kept verbatim, but the caller also needs to know that nothing was delivered
   * and that the obligation is still owed — otherwise a failed wake reads exactly
   * like a queue that will be delivered later, which is the misunderstanding this
   * whole capability exists to end.
   * @param self - the calling session id.
   * @param sessionId - the peer to wake.
   * @param options - whether to actually resume it; see {@link WakeOptions}.
   * @returns what was found and what was done.
   * @throws when the target is not one of the caller's peers, or cannot be resumed.
   */
  wake(self: string, sessionId: string, options?: WakeOptions): Promise<WokenPeer>;
}
//#endregion
//#region src/report/service.d.ts
/** Host capabilities the service consumes. */
interface ReportServiceHost {
  /**
   * Resolve one live agent.
   * @param sessionId - target session id.
   * @returns the live agent, or `undefined` when it is not resident.
   */
  getAgent(sessionId: string): AgentLike | undefined;
  /**
   * The directory a session runs in.
   *
   * Needed to allocate a working tree, because a checkout belongs to a
   * repository and the session's own directory is the only thing that says
   * which repository that is. Absent when the harness does not record one.
   * @param sessionId - session id.
   * @returns the absolute directory, or `undefined`.
   */
  selfCwd?(sessionId: string): string | undefined;
  /**
   * Resolve a display name for one session, when the harness can supply one.
   * @param sessionId - session id.
   * @returns the display name, or `undefined`.
   */
  describe(sessionId: string): Promise<string | undefined>;
}
/** Options accepted by {@link ReportService.author}. */
interface AuthorInput {
  /** One-line subject. */
  readonly subject: string;
  /** Report body. */
  readonly body: string;
  /** Session id authoring the report. */
  readonly actor: string;
  /** Addressed recipients. */
  readonly to?: readonly string[];
  /** Carbon-copy recipients. */
  readonly cc?: readonly string[];
  /** Free-form collaboration label. */
  readonly task?: string;
  /**
   * Working tree this report is bound to.
   *
   * Supplied rather than discovered: the ledger records the binding, and a
   * binding that names a tree which does not exist is a lie the ledger can carry
   * but never invents. Supplying one here also records the claim, because a
   * caller that created a checkout before the report existed has already
   * claimed it.
   */
  readonly worktree?: ReportWorktree;
  /**
   * Report id to use instead of allocating one.
   *
   * The working tree's name is derived from the report id, so a caller that must
   * create the checkout first has to know the id first. Allocating here as well
   * would produce a second, orphaned number — hence this way to hand the claim
   * back.
   */
  readonly reportId?: string;
  /** Referenced artifacts. */
  readonly artifacts?: readonly string[];
  /** Upstream report this one answers. */
  readonly parent?: string;
}
/** Result of a mutation that may have delivered. */
interface MutationResult {
  /** The refreshed digest. */
  readonly front: ReportFrontMatter;
  /** Delivery outcomes for this mutation. */
  readonly outcomes: readonly DeliveryOutcome[];
  /**
   * What this mutation did about a working tree on disk.
   *
   * Absent when the mutation has nothing to do with one. Present even when the
   * answer is "nothing was touched", because a caller that asked for a cleanup
   * needs to be told it did not happen — a silent refusal would read as success.
   */
  readonly worktree?: WorktreeOutcome;
  /**
   * A risk the mutation recorded but did not act on.
   *
   * Release uses it for a kept checkout whose work is uncommitted or on an
   * unmerged branch; the warning is also written into the hop's note.
   */
  readonly warning?: string;
}
/** What a provisioning produced. */
interface PreparedWorktree {
  /**
   * The binding to record on the report.
   *
   * Narrower than {@link ReportWorktree}, like the plan it came from: a checkout
   * this method created always has a branch, a repository and the `allocated`
   * mark, and saying so keeps callers from re-checking what was just produced.
   */
  readonly binding: ReportWorktree & {
    readonly branch: string;
    readonly repo: string;
    readonly allocated: true;
  };
  /** How many ended claims in this repository still have a checkout on disk. */
  readonly retained: number;
  /** Bindings whose checkout had already vanished, now recorded as such. */
  readonly stale: readonly StaleBinding[];
}
/** What a mutation did, or tried to do, about a working tree on disk. */
interface WorktreeOutcome {
  /** `kept` when the tree was deliberately left alone, `removed` on success, `refused` on failure. */
  readonly action: 'kept' | 'removed' | 'refused';
  /** Why a removal was refused, in git's own words. */
  readonly detail?: string;
  /**
   * What is worth knowing about a kept checkout.
   *
   * Present when closing keeps a checkout that has uncommitted work, or a branch
   * with commits the repository's current branch does not contain: exactly the
   * shapes that become orphaned once the report stops being live work.
   */
  readonly warning?: string;
}
/**
 * One correction applied to a report.
 *
 * Only the digest fields an owner may legitimately correct appear here. Recipients
 * and co-authorship are absent on purpose: they are derived from the hop stream, so
 * the single way to change them is to append another hop.
 */
interface AmendInput {
  /** Replacement subject. An empty value is refused rather than blanking the title. */
  readonly subject?: string;
  /** Replacement collaboration label; an empty value clears it. */
  readonly task?: string;
  /** Replacement artifact list (whole-list, not additive). */
  readonly artifacts?: readonly string[];
  /** New body text: appended as an amendment, or used to replace the body. */
  readonly body?: string;
  /**
   * Replace the body outright instead of appending an amendment. Requires
   * `body`, and is recorded on the hop so a later reader knows the text was
   * rewritten rather than only added to.
   */
  readonly replaceBody?: boolean;
  /** Extra note appended to the recorded change summary. */
  readonly note?: string;
}
/** One row of a digest listing. */
interface DigestRow {
  /** Report identifier. */
  readonly report: string;
  /** Lifecycle status. */
  readonly status: string;
  /** Subject. */
  readonly subject: string;
  /** Originator. */
  readonly from: string;
  /** Addressed recipients. */
  readonly to: readonly string[];
  /** Carbon-copy recipients. */
  readonly cc: readonly string[];
  /** Originator plus every co-author, in contribution order. */
  readonly authors: readonly string[];
  /** Recorded hop count. */
  readonly hops: number;
  /** How many of those hops were reads. */
  readonly reads: number;
  /** Collaboration label, when the report carries one. */
  readonly task?: string;
  /** Compact label of the bound working tree, when one is bound. */
  readonly worktree?: string;
  /** Last recorded hop, when any. */
  readonly last?: string;
  /** Last update time. */
  readonly updated: number;
}
/**
 * One hand-off the ledger still owes a session.
 *
 * The mode is carried because the two answers are not interchangeable: an
 * addressed hand-off will open a turn when it lands, while a carbon copy will
 * not. A caller that is about to resume a session (and spend its context) needs
 * to know which one it is holding before it decides the wake is worth anything.
 */
interface PendingHandoff {
  /** The report the obligation belongs to. */
  readonly report: string;
  /** That report's current status, because a concluded report changes what is left to do. */
  readonly status: ReportStatus;
  /** Whether delivering it requests a turn or only adds context. */
  readonly mode: DeliveryMode;
}
/** One digest brought back in line with its hop stream. */
interface DigestRepair {
  /** The report it concerns. */
  readonly report: string;
  /** Whether the stored digest disagreed with the hop stream. */
  readonly changed: boolean;
  /** The counters the document carried. */
  readonly stored: string;
  /** The counters its hop stream derives. */
  readonly derived: string;
  /** Why it was left unwritten, when it was. */
  readonly skipped?: string;
}
/** The report service. */
declare class ReportService {
  #private;
  /**
   * @param host - host capabilities (agent lookup, display names).
   */
  constructor(host: ReportServiceHost);
  /**
   * Create a report and optionally hand it to its first recipients.
   * @param input - authoring input.
   * @returns the created digest and any immediate delivery outcomes.
   */
  author(input: AuthorInput): Promise<MutationResult>;
  /**
   * Decide whether one session owns a report.
   *
   * Owning is what lets an agent conclude the matter *or* correct what it says —
   * a recipient may do neither. `from` is accepted alongside `authors` because a
   * hand-edited ledger could in principle carry the originator without the
   * matching hop, and refusing the obvious owner would strand the report.
   * @param front - the report digest.
   * @param actor - the session asserting ownership.
   * @returns true when the actor owns the report.
   */
  static owns(front: ReportFrontMatter, actor: string): boolean;
  /**
   * Append a co-author's contribution to an existing report.
   * @param report - report identifier.
   * @param actor - contributing session id.
   * @param body - the contribution text.
   * @param note - optional hop note.
   * @returns the refreshed digest.
   */
  contribute(report: string, actor: string, body: string, note?: string): Promise<MutationResult>;
  /**
   * Address a report to recipients and wake them.
   * @param report - report identifier.
   * @param actor - sending session id.
   * @param targets - recipient session ids.
   * @param note - optional hop note.
   * @returns the refreshed digest and delivery outcomes.
   */
  send(report: string, actor: string, targets: readonly string[], note?: string): Promise<MutationResult>;
  /**
   * Move one unpaid hand-off from the session that owes it to another.
   *
   * This is the one gap a hand-off cannot close by itself. A delivery to a session
   * that will never come back stays owed forever — pending is derived from the
   * audit trail, and nothing in it can be unsaid. A transfer is how the ledger
   * records the truthful alternative: the obligation still exists, it is owed by
   * someone else now. It is deliberately NOT recorded as an arrival, so no reader
   * can mistake it for "delivered".
   *
   * Authority is narrower than sending, and for a reason. An owner may move an
   * outstanding hand-off (it is the report's dispatch to direct), and the session
   * that is currently owed it may hand its own obligation on (it is the party that
   * cannot discharge it). Neither may pre-empt a delivery that already arrived.
   * @param report - report identifier.
   * @param actor - acting session id.
   * @param from - the session that currently owes the hand-off.
   * @param to - the session that takes it over.
   * @param note - optional hop note.
   * @returns the refreshed digest and delivery outcomes.
   */
  transfer(report: string, actor: string, from: string, to: string, note?: string): Promise<MutationResult>;
  /**
   * Copy a report to recipients without waking them.
   * @param report - report identifier.
   * @param actor - copying session id.
   * @param targets - carbon-copy recipient session ids.
   * @param note - optional hop note.
   * @returns the refreshed digest and delivery outcomes.
   */
  carbonCopy(report: string, actor: string, targets: readonly string[], note?: string): Promise<MutationResult>;
  /**
   * Pass a report onward, or duplicate it as evidence for another report.
   *
   * A forward keeps the original authorship and appends the new hand-off; a copy
   * records the duplication so the audit trail shows where copies of a report
   * live.
   * @param report - report identifier.
   * @param actor - acting session id.
   * @param targets - recipient session ids.
   * @param mode - `forward` (addressed onward transfer) or `copy` (duplication).
   * @param note - optional hop note.
   * @returns the refreshed digest and delivery outcomes.
   */
  forward(report: string, actor: string, targets: readonly string[], mode: 'forward' | 'copy', note?: string): Promise<MutationResult>;
  /**
   * Read a report's digest, body, and complete transfer path.
   * @param report - report identifier.
   * @param actor - reading session id.
   * @returns the model-facing rendering.
   */
  read(report: string, actor: string): Promise<string>;
  /**
   * List report digests, optionally filtered to ones touching one session.
   * @param filter - listing filter.
   * @returns one row per matching report, newest first.
   */
  list(filter?: {
    session?: string;
    status?: string;
    task?: string;
    worktree?: string;
    limit?: number;
  }): Promise<DigestRow[]>;
  /**
   * Mark a report acknowledged by one recipient.
   * @param report - report identifier.
   * @param actor - acknowledging session id.
   * @param note - optional note.
   * @returns the refreshed digest.
   */
  acknowledge(report: string, actor: string, note?: string): Promise<MutationResult>;
  /**
   * Conclude a report: the owner's act, recorded as a hop.
   *
   * Deliberately idempotent — a second close records another hop rather than
   * failing, because "someone tried to close this again" is itself useful history.
   * Reopening is not a separate tool: any later contribution, send, copy, or
   * forward brings a closed report back to `open` on its own.
   * @param report - report identifier.
   * @param actor - the session concluding it.
   * @param note - optional note.
   * @param options - what to do with a bound working tree on disk.
   * @returns the refreshed digest, and what happened to the working tree.
   * @throws when the actor is neither the originator nor a co-author.
   */
  close(report: string, actor: string, note?: string, options?: {
    worktree?: 'keep' | 'remove-if-clean';
  }): Promise<MutationResult>;
  /**
   * Claim a working tree for a report.
   *
   * The decision runs under two mutexes, outer first: the working tree's,
   * because two reports racing for one branch is exactly what a per-report mutex
   * cannot see, and then the report's, because writing the digest still races
   * other mutations of the same report. Only this method nests them —
   * {@link ReportService.release} takes the report lock alone, since giving a
   * claim up needs no atomicity against the filesystem — so the order is fixed
   * and cannot form the cycle that would deadlock.
   *
   * Re-claiming is allowed and is how a binding is refreshed (a new head, a
   * corrected path): the report already holding it is skipped by the referee, so
   * refreshing needs no release first. It is still recorded, because the audit
   * is the product.
   * @param report - report identifier.
   * @param actor - the claiming session; must own the report.
   * @param binding - the working tree to claim.
   * @returns the refreshed digest.
   * @throws when git or the ledger refuses the claim.
   */
  lease(report: string, actor: string, binding: ReportWorktree): Promise<MutationResult>;
  /**
   * Give up a report's claim on its working tree, without touching the disk.
   *
   * The binding stays in the digest on purpose. A checkout kept on disk must
   * remain traceable to the report that made it — otherwise the ledger forgets
   * which working trees it is responsible for, and a later cleanup could not
   * tell its own from a stranger's. What ended is the claim, and the hop stream
   * is where that is recorded.
   * @param report - report identifier.
   * @param actor - the releasing session; must own the report.
   * @param note - optional note.
   * @returns the refreshed digest.
   * @throws when the report holds nothing, or the actor is not an owner.
   */
  release(report: string, actor: string, note?: string): Promise<MutationResult>;
  /**
   * Create the working tree a report is about to be given, and clear room for it.
   *
   * Separate from {@link ReportService.lease} because it runs *before* the
   * report exists: a working tree's name is derived from the report id, and the
   * caller needs the checkout's path to hand a peer its working directory. So
   * the order is claim the id, provision the checkout, then author — and this is
   * the middle step.
   *
   * Runs under the repository mutex, because the budget it consults and the
   * branch it takes are both repository-wide facts that two concurrent
   * allocations would otherwise read at the same moment.
   * @param input - what to provision, and for whom.
   * @returns the binding to record, plus what housekeeping happened.
   * @throws when a gate refuses the allocation or git cannot create the tree.
   */
  prepareWorktree(input: {
    readonly report: string;
    readonly subject: string;
    readonly actor: string;
    readonly repo: RepoLocation;
    readonly base: string;
    readonly settings: WorktreeSettings;
  }): Promise<PreparedWorktree>;
  /**
   * Undo a provisioning that a later step could not use.
   *
   * Deliberately without a force flag: a checkout that something has already
   * modified refuses to go, and it should — the failure that triggered the
   * rollback is not a licence to discard work. The caller is told whether the
   * cleanup happened rather than being left to assume it did.
   * @param binding - the binding whose checkout should go.
   * @returns true when the checkout was removed.
   */
  discardWorktree(binding: ReportWorktree): Promise<boolean>;
  /**
   * Claim an id and provision a working tree for a report that does not exist yet.
   *
   * The two halves of a checkout's identity are circular: its branch and
   * directory are named after the report, and the caller needs its path *before*
   * the report is authored — a peer has to be created in it. This breaks the
   * circle by claiming the id first, and gives the claim back if provisioning
   * fails, so a failure does not burn a number.
   * @param input - what to provision, and for whom.
   * @returns the claimed id and the provisioned checkout.
   * @throws when the session has no directory, is not in a repository, is in one
   * with no commit, or a gate refuses the allocation.
   */
  provision(input: {
    readonly subject: string;
    readonly actor: string;
    readonly settings: WorktreeSettings;
  }): Promise<{
    readonly report: string;
    readonly prepared: PreparedWorktree;
  }>;
  /**
   * Undo a provisioning whose report never got authored.
   *
   * A step after provisioning can fail — a peer that cannot be created, an
   * authoring error — and without this the caller would leave a checkout and a
   * burned number behind. Both halves are best-effort and reported rather than
   * assumed: a checkout refuses to go once anything has touched it, and that
   * refusal is the correct outcome, not an error to swallow.
   * @param provisioned - what {@link ReportService.provision} returned.
   * @returns what was actually undone.
   */
  rollbackProvision(provisioned: {
    readonly report: string;
    readonly prepared: PreparedWorktree;
  }): Promise<{
    readonly worktree: boolean;
    readonly id: boolean;
  }>;
  /**
   * Correct a report: the digest fields and/or the body, as the owner's act.
   *
   * The tension this resolves is real. A ledger's value comes from history being
   * append-only, so an agent that could silently rewrite the record would destroy
   * the thing the ledger is for. But an agent that cannot correct a wrong subject
   * has only bad options: author a new report and lose the transfer path, or leave
   * the error standing. So corrections are **recorded, never silent**:
   *
   *  - digest fields (`subject`, `task`, `artifacts`) are current state and are
   *    replaced, with the hop carrying the old and new values verbatim;
   *  - the body is a record of what people *said*, so by default an amendment
   *    **appends** a new section instead of rewriting anyone's words;
   *  - replacing the body outright is possible but must be asked for explicitly
   *    (`replaceBody`), and the hop records that it happened — a later reader is
   *    told the text was rewritten and by whom, rather than being misled.
   *
   * Recipients and co-authorship can never be edited here: they are derived from
   * the hop stream, so the only way to change them is to append another hop.
   * @param report - report identifier.
   * @param actor - the correcting session.
   * @param patch - the fields to change.
   * @returns the refreshed digest.
   * @throws when the actor does not own the report, or the patch changes nothing.
   */
  amend(report: string, actor: string, patch: AmendInput): Promise<MutationResult>;
  /**
   * The hand-offs the ledger still owes one session.
   *
   * Derived from the hop stream, like every other pending answer, so it can
   * neither invent an obligation nor lose one to a half-written digest. The
   * digest prefilter is the same one a handover uses: only a report that names
   * the session can owe it anything, so the scan stays proportional to that
   * session's collaboration instead of to the whole ledger.
   *
   * This is the question a wake has to ask first. Resuming a session with
   * nothing owed loads a partner, spends its context on an empty inbox, and
   * demonstrates nothing — the answer here is what turns that into a refusal the
   * caller can act on instead of a silent no-op.
   * @param session - the session that may be owed a delivery.
   * @returns the outstanding hand-offs, oldest report first, with their wake policy.
   */
  pendingFor(session: string): Promise<PendingHandoff[]>;
  /**
   * Rebuild every digest's derived counters from its hop stream.
   *
   * The front matter is a cache of `projectRoute`, so it can only be as current
   * as the report's last mutation. That is harmless while the projection's meaning
   * never changes — and it is exactly why adding a derived field needs a pass: a
   * digest written before `reads` existed would report zero reads until something
   * else touched it, which reads like "nobody ever opened this" rather than "this
   * document predates the field". The same pass is what makes a future change of
   * the projection's *definition* safe to ship: rewrite every digest once, under
   * the new rule, instead of living with two meanings at the same time.
   *
   * Runs under each report's own writer lock and re-derives from a fresh read
   * inside it, so a mutation that landed during the scan is never undone by a
   * stale rewrite. `updated` is deliberately not touched: making a stale digest
   * honest is not activity, and stamping it would reorder every listing. A report
   * whose transfer path has gone missing is skipped rather than rewritten — that
   * is the same damage guard {@link ReportService}#record applies, for the same
   * reason: rebuilding from an empty history would erase its recipients.
   * @param options - `dryRun` reports what would change without writing.
   * @returns one record per report in the ledger.
   */
  repairDigests(options?: {
    dryRun?: boolean;
  }): Promise<DigestRepair[]>;
  /**
   * Deliver every held hand-off owed to one session that just became resident.
   * @param sessionId - the session that became resident.
   * @returns the deliveries that succeeded.
   */
  flushForAgent(sessionId: string): Promise<readonly DeliveryOutcome[]>;
  /**
   * Deliver every held hand-off owed to any of these sessions, in one ledger pass.
   *
   * The pass is shared on purpose. A delivery sweep used to be per session: the
   * pump ran for each resident session at load and for each session created
   * afterwards, and every run walked the whole ledger reading each document and
   * each transfer path. That is `sessions × reports` file reads — on a twenty
   * session, two hundred report ledger, eight thousand opens for work that is
   * entirely about a handful of owed hand-offs. Reading the ledger once and
   * answering for every waiting session costs one walk no matter how many of them
   * there are.
   *
   * Correctness is unchanged, and deliberately so:
   *
   *  - pending is still derived from the hop stream and nothing else, so a
   *    hand-edited or half-written document cannot invent or lose an obligation;
   *  - each report is still delivered under its own writer lock, and the hop
   *    stream is re-read inside that lock, so a hand-off answered between the scan
   *    and the delivery is not delivered twice;
   *  - each report still fails in isolation, because `agent/created` fires once
   *    and one malformed record must not abandon every later hand-off.
   * @param sessions - the sessions that just became resident.
   * @returns the deliveries that succeeded.
   * @throws an `AggregateError` when any report failed, naming how many.
   */
  flushSessions(sessions: readonly string[]): Promise<readonly DeliveryOutcome[]>;
}
//#endregion
//#region src/index.d.ts
/** Plugin config, supplied by the composition row. */
interface Config {
  /**
   * When true (default), the prompt sections announce the ledger to every agent.
   * Set false to keep prompts untouched.
   */
  announceToAgent?: boolean;
  /**
   * Cap on independent peer sessions one session may start. Peer creation is the
   * one capability here that adds live agents rather than records, so it is
   * budgeted; reaching the cap is a tool error naming the limit, not a silent
   * refusal.
   * @default 8
   */
  maxPeersPerAgent?: number;
  /**
   * Optional git worktree support: each report may hold its own checkout.
   *
   * Off unless `enabled` is set. What a working tree isolates is narrow and
   * worth stating plainly, because the opposite is easy to assume: each checkout
   * has its own working directory and index, while `config`, `hooks`, the object
   * store and everything outside the checkouts on the machine stay shared. A
   * hook installed or a setting changed in one checkout therefore affects every
   * other one.
   */
  worktree?: WorktreeConfig;
}
/** The three host services this half cannot work without. */
declare const inject: string[];
/**
 * One session's permission state, captured at peer creation.
 *
 * The shape is owned by {@link PeerPermission} in the peer module, because it is
 * also what `peer_start` reports back: one type on both halves of the seam, so a
 * field cannot be captured here and silently dropped there.
 */
type InheritedPermission = PeerPermission;
/**
 * The unpublished session a peer is composed on, as much of it as this plugin
 * touches. The harness hands it to `setup()` as the second argument, exactly as
 * its own delegation seam does; `append` is the only method read.
 */
interface PeerAppendTarget {
  /** The session whose log is still unpublished at this point. */
  readonly session?: {
    /**
     * Append one event to the unfinished log.
     * @param type - the event type.
     * @param data - the event payload.
     */
    append(type: string, data: Record<string, unknown>): void;
  };
}
/**
 * Capture the permission state a peer should inherit from its starter.
 *
 * Called synchronously before creation, for the same reason the harness captures
 * delegated policy before the child's first await: a switch the starter makes
 * afterwards belongs to the starter's future, not to this peer. Nothing here
 * consults the harness's event vocabulary directly — the three optional services
 * already fold each session's log, and asking them is what keeps the answer
 * identical to the one the starter's own tools resolve at execution time.
 * @param ctx - the host capabilities, for the optional policy services.
 * @param session - the starter's live session.
 * @returns the fields worth inheriting; empty when no service is composed.
 */
declare function captureInheritedPermission(ctx: PeerHostContext, session: PeerCallerAgent['session']): InheritedPermission;
/**
 * Record an inherited permission state on the peer's unpublished log.
 *
 * `source: 'delegation'` is the harness's own marker for exactly this fact — a
 * policy the session did not choose for itself — so a cold read of the peer's log
 * can tell an inherited mode from one the user later picked in that session, and
 * a later switch in the peer still wins because it is simply a later event.
 *
 * The preset identity is written LAST and separately: the permission service's
 * own pinning pass runs after this window, fills any knob this run could not
 * capture, and derives the identity itself when none was inherited. Writing ours
 * first means that pass has something to reconcile against rather than a blank.
 * @param created - the unpublished agent, when the harness handed one over.
 * @param inherited - the captured state.
 * @returns true when there was something to write and a log to write it to.
 */
declare function appendInheritedPermission(created: PeerAppendTarget | undefined, inherited: InheritedPermission): boolean;
/**
 * The host capabilities the peer bundle reaches for, named one by one.
 *
 * Narrower than {@link Context} on purpose, and the narrowing earns two things:
 * the peer seam's real dependency surface is readable in one place instead of
 * inferred from the whole plugin context, and the seam can be exercised without
 * a harness — which is what lets the registration path (canonical-path lookup,
 * attach, degraded reporting) be tested deterministically instead of only in a
 * deployment.
 */
interface PeerHostContext {
  /** The live agents, for residency, cwd inheritance and creation. */
  readonly agents: {
    /**
     * One live agent.
     * @param sessionId - the session to look up.
     * @returns the agent, or `undefined` when it is not resident.
     */
    get(sessionId: never): PeerCallerAgent | undefined;
    /**
     * Every live agent.
     * @returns the agents.
     */
    list(): readonly PeerCallerAgent[];
    /**
     * Create one root agent.
     * @param options - the harness creation request.
     * @returns the handle for the created agent.
     */
    create(options: PeerCreateOptions): Promise<{
      readonly agent: PeerCallerAgent;
    }>;
    /**
     * Resume one persisted session.
     *
     * Optional in this shape for the same reason the workspace hook is: a harness
     * build without the entry, or a deployment that composes no persistence, has
     * to surface as a named refusal at the tool instead of as a crash inside the
     * adapter. The peer bundle treats an absent entry as exactly that refusal.
     * @param options - the persisted identity, the route, and the composition.
     * @returns the handle for the resumed agent.
     */
    resume?(options: PeerResumeOptions): Promise<{
      readonly agent: PeerCallerAgent;
    }>;
  };
  /**
   * Read one optional service off the registry.
   * @param name - the service name.
   * @returns the service, or `undefined` when this deployment composes none.
   */
  get(name: string): unknown;
  /** The host logger, for failures that must also be visible in the deployment log. */
  readonly logger?: {
    warn?(message: string): void;
  };
}
/** The slice of a live agent the peer bundle reads. */
interface PeerCallerAgent {
  /** Its session id. */
  readonly id: unknown;
  /** Its creation-time options, the fallback source of the peer's model route. */
  readonly options: PeerRoute;
  /** Its scope context, read only to join the peer to the same composition. */
  readonly ctx: Context;
  /** Its live session. */
  readonly session: {
    /**
     * The route in force after request-time selection.
     * @returns the request header's config, when a request has been made.
     */
    requestHeader(): {
      config?: PeerRoute;
    } | undefined;
    /**
     * The durable header fields the peer bundle reads.
     * @returns the header.
     */
    readonly header?: unknown;
    /**
     * The events appended so far.
     * @returns the event log.
     */
    snapshotEvents(): readonly unknown[];
  };
  /**
   * Wake the agent with a message.
   * @param message - the message to deliver.
   */
  steer(message: never): void;
  /**
   * Resolve once the agent is quiescent.
   * @returns a promise settled at quiescence.
   */
  whenIdle(): Promise<void>;
}
/** The harness request one peer creation makes. */
interface PeerCreateOptions {
  /** The pre-allocated session id. */
  readonly sessionId: never;
  /** The durable creation metadata: the inherited directory and joined preset. */
  readonly meta?: {
    readonly cwd?: string;
    readonly agentPreset?: string;
  };
  /** The inherited model route. */
  readonly agentOptions: never;
  /**
   * Compose the peer: join its starter's composition, then inherit the
   * starter's permission state.
   *
   * Runs while the session is still unpublished — the harness's `setup()` window,
   * shared with its own delegation seam — which is what makes the appended
   * permission events part of the peer's first stored snapshot instead of a
   * mutation that could lose a race with its first turn.
   * @param agentCtx - the new agent's scope context.
   * @param created - the unpublished agent, whose session log may be appended to.
   */
  setup(agentCtx: Context, created?: PeerAppendTarget): void;
}
/** The harness request one peer resume makes. */
interface PeerResumeOptions {
  /** The persisted session id to load. */
  readonly resumeSessionId: never;
  /**
   * The route the resumed agent runs on.
   *
   * A resumed root agent is as composition-less as a fresh one: without a route
   * the prompt's `{{model}}` cannot resolve and its first turn dies at step 1.
   */
  readonly agentOptions: never;
  /**
   * Compose the resumed agent: join its starter's live composition.
   *
   * Permission inheritance is deliberately absent. The state was written onto the
   * peer's own log when it was created and a warm resume restores it from there;
   * re-capturing the starter's current state on every wake would overwrite a
   * later switch made in that session, which is the difference this plugin draws
   * between inheriting and pinning.
   * @param agentCtx - the resumed agent's scope context.
   */
  setup(agentCtx: Context): void;
}
/** The model route a peer inherits from its starter. */
interface PeerRoute {
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly maxTokens?: number;
}
/** Everything this plugin reads out of the host, in its own shapes. */
interface HostBundle extends ReportServiceHost {
  /**
   * Read display titles for a set of sessions.
   * @param ids - session ids.
   * @returns a title per session that has one.
   */
  readTitles(ids: readonly string[]): Promise<Map<string, string>>;
  /**
   * Read every known session record, reduced to the fields the timeline needs.
   * @returns the records.
   */
  listSessionRecords(): Promise<SessionRecordLike[]>;
  /**
   * Drop the cached session-corpus listing.
   *
   * Called when a session becomes resident: `agent/created` is exactly the event
   * that can introduce an id the previous listing did not contain, and a
   * brand-new session must not be missing from its own timeline merely because a
   * poll a second earlier populated the cache.
   */
  invalidateSessionListing?(): void;
}
/**
 * Build the peer-management capabilities from the running context.
 *
 * Peer creation is the only place this plugin adds a live agent, so it is the
 * only place that needs an authority story: the tool's visibility is the outer
 * gate, {@link Config.maxPeersPerAgent} bounds the blast radius, the peer
 * inherits the caller's own working directory (so it cannot be pointed at an
 * unrelated tree), and every creation is attributed in the roster log.
 *
 * It is also the only place that must supply what a fresh agent cannot supply
 * itself. A root session is born with no composition and no model route:
 *
 *  - **Composition.** The peer joins the starter's standing preset
 *    (`composeFrom`), which is a bind to the SAME generation the starter runs —
 *    not a re-resolution of the preset by id, so a preset edited or deleted since
 *    cannot hand the peer a different world than its starter's. A deployment with
 *    no roster yields no join and no error, exactly like a delegated child.
 *  - **Route.** The peer inherits the starter's provider/model/reasoning effort.
 *    Without it, prompt assembly cannot resolve `{{model}}` and every turn of the
 *    peer dies at step 1 before its first tool call.
 *  - **Preset identity.** The joined preset is recorded in the durable session
 *    header, so a cold read of the peer's log rebuilds the composition it
 *    actually ran under instead of the deployment default.
 *  - **Permissions.** The peer inherits the starter's effective sandbox mode,
 *    approval policy, and permission-preset identity, written onto its own log
 *    with the harness's `source: 'delegation'` marker. This is the part that does
 *    NOT happen by itself and is easy to miss, because its absence is silent:
 *    without it a peer is pinned to the deployment's default preset, so a peer
 *    started by a fully-permissive session still asks the user to approve what
 *    that session could already do — and a peer started by a read-only session is
 *    more powerful than its starter. Inheriting is also what keeps the peer a
 *    peer rather than a subordinate: the state lands in the peer's own log, so
 *    the user can inspect it and switch it in that session afterwards.
 *
 * It is also, on a deployment that composes a workspace registry, the only place
 * that can put the new peer into a workspace group — see
 * {@link PeerHost.attachToWorkspace} for why no other layer can: the registry's
 * history bootstrap runs once, long before this peer exists, and creation
 * metadata has no workspace field to name it with.
 *
 * `confirmPeer` closes the other half of the same problem: a peer that turns out
 * to be unable to run must be visible to the agent that just started it, rather
 * than reported as a successful hand-off.
 * @param ctx - the host capabilities this bundle reaches for.
 * @param host - the session-reading bundle.
 * @returns the peer host capability.
 */
declare function buildPeerHost(ctx: PeerHostContext, host: HostBundle): PeerHost;
/** The live services a mounted host half owns. */
interface HostHalf {
  readonly service: ReportService;
  readonly peers: PeerService;
}
/**
 * Run `mount` once this composition has no other mounted host half, queueing otherwise.
 *
 * Both the release row and the developer-mode row go through this, so exactly one
 * instance owns the ledger's mutex table per composition. A second row waits instead
 * of throwing: a rejected activation is not retried by a recomposition that does not
 * touch its own row, which would leave two rows enabled and neither mounted. Waiting
 * makes the switch self-healing in either click order.
 * @param ctx - the plugin context, used to release the slot and to cancel a wait.
 * @param mount - the half to mount once the slot is free.
 */
declare function mountWhenFree(ctx: Context, mount: () => void): void;
/**
 * Apply the host half: the release plugin's entry point.
 * @param ctx - the plugin context (`tools`, `systemPrompt`, `agents` injected).
 * @param config - resolved plugin config from the composition row.
 */
declare function apply(ctx: Context, config?: Config): void;
/**
 * Mount the host half — services, model tools, the delivery pump, the read endpoints
 * and the prompt sections — and hand the live services back.
 *
 * Developer mode is deliberately NOT part of this function: it lives in the add-on
 * bundle under `dev/bundle/`, which calls this function and installs its own tools on
 * the returned services. A release artifact therefore carries no developer-mode code
 * at all, and an installed package has no roster to enable it with.
 * @param ctx - the plugin context (`tools`, `systemPrompt`, `agents` injected).
 * @param config - resolved plugin config from the composition row.
 * @returns the live services, for a caller that mounts an extension on top.
 */
declare function mountHost(ctx: Context, config?: Config): HostHalf;
//#endregion
export { Config, HostBundle, HostHalf, InheritedPermission, PeerCallerAgent, PeerCreateOptions, PeerHostContext, PeerResumeOptions, appendInheritedPermission, apply, buildPeerHost, captureInheritedPermission, inject, mountHost, mountWhenFree };