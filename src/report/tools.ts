/**
 * The model-facing tools of the report ledger.
 *
 * Eight tools cover the whole lifecycle: author, co-author, address, copy,
 * forward, read, list, acknowledge. Every one of them records a hop, so the
 * transfer path is a by-product of normal use rather than a separate discipline
 * the model has to remember.
 *
 * @module dsh-report-ledger/report/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { WorktreeRuntime } from './allocate.ts'
import type { PeerService } from './peer.ts'
import { DEFAULT_RECEIPT_MS, type PeerReceipt, type WorkspaceRegistration } from './peer.ts'
import type { PreparedWorktree, ReportService, WorktreeOutcome } from './service.ts'
import { renderRow } from './service.ts'
import type { DeliveryOutcome } from './deliver.ts'

/**
 * The `worktree` parameter a tool advertises, or nothing at all.
 *
 * With the feature off the parameter does not exist, so a model cannot ask for
 * something the deployment will not do. That is a better answer than a parameter
 * that is always refused, and it keeps the promise that a deployment which does
 * not want working trees pays nothing for them.
 * @param runtime - the resolved feature state.
 * @param description - what the parameter does, for this tool.
 * @returns the parameter map to spread into a tool's parameters.
 */
function worktreeParam(runtime: WorktreeRuntime, description: string): Record<string, unknown> {
  return runtime.enabled ? { worktree: { type: 'boolean', description } } : {}
}

/** Provision a checkout, or explain that this deployment does not offer one. */
async function requireWorktree(
  runtime: WorktreeRuntime,
  service: ReportService,
  input: { readonly subject: string; readonly actor: string },
): Promise<{ readonly report: string; readonly prepared: PreparedWorktree }> {
  if (!runtime.enabled) {
    throw new Error(
      'report-ledger: this deployment has not enabled git worktree support, so no checkout can be allocated '
      + '(the composition row sets worktree.enabled)',
    )
  }
  return await service.provision({ subject: input.subject, actor: input.actor, settings: runtime.settings })
}

/**
 * The lines describing a checkout that was just provisioned.
 *
 * The sharing sentence is not boilerplate. "Its own checkout" reads naturally as
 * "its own environment", and the difference becomes real the moment an agent
 * installs a hook or changes a setting — both of which reach every other
 * checkout, because only the working directory and index are private.
 * @param prepared - what provisioning produced.
 * @returns the lines to append to the tool output.
 */
function renderProvision(prepared: PreparedWorktree): string[] {
  const lines = [`worktree=${prepared.binding.path} branch=${prepared.binding.branch}`]
  if (prepared.reclaimed !== undefined) {
    lines.push(
      `reclaimed ${prepared.reclaimed.report}'s checkout at ${prepared.reclaimed.path} to stay within the retained `
      + 'budget; that report remains closed',
    )
  }
  for (const skipped of prepared.reclaimSkipped) {
    lines.push(`kept a checkout the budget would otherwise have cleared: ${skipped}`)
  }
  for (const gone of prepared.stale) {
    lines.push(`recorded that ${gone.report}'s checkout at ${gone.path} was already gone — nothing to remove`)
  }
  lines.push('private: working directory and index. shared: config, hooks, the object store, and everything outside the checkouts.')
  return lines
}

/** The line describing what a mutation did with a checkout on disk. */
function renderWorktreeOutcome(outcome: WorktreeOutcome | undefined, canRemove: boolean): string | undefined {
  if (outcome === undefined) return undefined
  if (outcome.action === 'removed') return 'working tree removed'
  // The hint only names a parameter the caller can actually see and pass; on a
  // deployment with the feature off, `worktree` is not advertised at all.
  if (outcome.action === 'kept') {
    return canRemove
      ? 'working tree kept (close with worktree:"remove-if-clean" to remove it)'
      : 'working tree kept'
  }
  return `working tree NOT removed — git refused: ${outcome.detail ?? 'unknown reason'}`
}

/** The slice of a tool execution these tools read. */
interface ExecLike {
  readonly agent?: { readonly id: string }
}

/** Every tool's output is one compact text rendering of its canonical string value. */
const stringOutput = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: unknown): { type: 'text'; text: string }[] => [
    { type: 'text', text: String(value) },
  ],
}

/**
 * Read the acting session from a tool execution.
 *
 * A report is always authored by a session, so a call without an owning agent
 * is rejected rather than attributed to nobody.
 * @param exec - the tool run context.
 * @returns the acting session id.
 */
function actorOf(exec: ExecLike): string {
  const agent = exec.agent
  if (agent === undefined || typeof agent.id !== 'string' || agent.id === '') {
    throw new Error('report-ledger: this tool needs an owning agent session')
  }
  return agent.id
}

/** Render a mutation result as a compact model-facing report. */
function renderMutation(front: { report: string; status: string; subject: string; to: readonly string[]; cc: readonly string[]; authors: readonly string[]; hops: number }, outcomes: readonly DeliveryOutcome[], prepared?: PreparedWorktree): string {
  const lines = [
    `${front.report} [${front.status}] ${front.subject}`,
    `authors=${front.authors.join(',')} to=${front.to.length === 0 ? '-' : front.to.join(',')} cc=${front.cc.length === 0 ? '-' : front.cc.join(',')} hops=${front.hops}`,
  ]
  if (outcomes.length > 0) {
    const delivered = outcomes.filter((outcome) => outcome.status === 'delivered').map((outcome) => outcome.targetId)
    const queued = outcomes.filter((outcome) => outcome.status === 'queued').map((outcome) => outcome.targetId)
    if (delivered.length > 0) lines.push(`delivered to: ${delivered.join(', ')}`)
    if (queued.length > 0) lines.push(`held for absent recipient (delivered automatically when it becomes resident): ${queued.join(', ')}`)
  }
  if (prepared !== undefined) lines.push(...renderProvision(prepared))
  return lines.join('\n')
}

/** Derive a concise report subject from a task description. */
function subjectFrom(task: string, name: string | undefined): string {
  const firstLine = task.split('\n').find((line) => line.trim() !== '')?.trim() ?? task.trim()
  const trimmed = firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine
  return name === undefined ? trimmed : `${name}: ${trimmed}`
}

/**
 * Render what was observed about a peer's first turn.
 *
 * A delivery certifies one thing only: the digest reached a live agent. It says
 * nothing about whether a turn opened, and a turn that dies at step 1 — an
 * unresolvable prompt variable, no model route, no composition — leaves exactly
 * the same `delivered` hop and the same `live` roster row as a peer that is hard
 * at work. This line is the difference between those two, and it exists because
 * the difference cost a real caller a long, silent wait.
 * @param receipt - the observation, or `undefined` when the host could not make one.
 * @param windowMs - the observation window the receipt was bounded by.
 * @returns one line for the tool output, or `undefined` when there is nothing to say.
 */
function describeReceipt(receipt: PeerReceipt | undefined, windowMs: number): string | undefined {
  if (receipt === undefined) return undefined
  if (receipt.kind === 'running') return `the peer's first turn is running (observed for ${windowMs} ms after the assignment landed)`
  if (receipt.kind === 'failed') {
    return `⚠ the peer's first turn FAILED before doing any work: ${receipt.error ?? receipt.reason ?? 'unknown error'}`
  }
  if (receipt.kind === 'unstarted') {
    return "⚠ the assignment is in the peer's inbox but no turn opened — nothing is working on it"
  }
  if (receipt.reason === 'completed') {
    return `the peer's first turn completed within ${windowMs} ms — read the report for its answer`
  }
  return `the peer's first turn ended within ${windowMs} ms (${receipt.reason ?? 'settled'}) — nothing is working on it now`
}

/**
 * Render where the new peer landed in the workspace browser.
 *
 * This is the group the caller will find the peer under, so it is worth one
 * line: a peer with no group is not broken, but an agent that goes looking for
 * it in the wrong place — or a human who never sees it appear at all — is
 * looking at a bookkeeping fact this line states in advance. `no-workspace`
 * covers both "this deployment has no groups" and "this directory is not a
 * registered workspace", which is why it is phrased as an absence rather than a
 * problem; only a failed registration is flagged, and it names the reason.
 * @param registration - what the host reported, or `undefined` when the host
 * implements no registration at all.
 * @returns one line for the tool output, or `undefined` when there is nothing to say.
 */
function renderWorkspace(registration: WorkspaceRegistration | undefined): string | undefined {
  if (registration === undefined) return undefined
  if (registration.outcome === 'registered') return `workspace group: ${registration.workspace ?? 'registered'}`
  if (registration.outcome === 'failed') {
    return `⚠ the peer was created but could not be listed under its workspace: ${registration.warning ?? 'unknown error'}`
  }
  return undefined
}

/**
 * Register the report and peer tools on the tools registry.
 * @param ctx - the plugin context (`tools` injected).
 * @param service - the report service backing the tools.
 * @param peers - the peer service backing discovery and creation.
 * @returns a disposer removing every registration.
 */
export function registerReportTools(
  ctx: { tools: { register(definition: unknown): () => void } },
  service: ReportService,
  peers: PeerService,
  worktree: WorktreeRuntime,
): () => void {
  const disposers: (() => void)[] = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'report_author',
    description: 'Open a new report in the shared ledger — the primary way to hand work, findings, or a decision to another agent. A report carries a front-matter digest (subject, recipients, authors, hop count) that travels cheaply, while its body stays in the ledger and is opened on demand. Use this instead of a bare message whenever the content should still be findable later: a long task, a hand-off to a teammate, a status the requester will want to trace. `to` addresses recipients (they are woken); `cc` copies them quietly. Set `parent` to the report you are answering so the two are linked.',
    parameters: {
      subject: { type: 'string', required: true, description: 'One line naming what this report is about.' },
      body: { type: 'string', required: true, description: 'The report content — findings, decisions, evidence, and what you need next.' },
      to: { type: 'array', items: { type: 'string' }, description: 'Session ids to address. They are woken if resident, otherwise the hand-off is held and delivered when they return.' },
      cc: { type: 'array', items: { type: 'string' }, description: 'Session ids to copy quietly: they receive the digest as context without being woken.' },
      task: { type: 'string', description: 'Label grouping the reports of one collaboration.' },
      artifacts: { type: 'array', items: { type: 'string' }, description: 'Paths, commits, or report ids this report refers to.' },
      parent: { type: 'string', description: 'Report id this one answers, linking it into the thread.' },
      ...worktreeParam(worktree, 'Allocate this report its own git checkout, on a branch named after the report. Only the working directory and index are private; config, hooks and the object store are shared with every other checkout.'),
    },
    output: stringOutput,
    execute: async (args, exec) => {
      const input = args as {
        subject: string
        body: string
        to?: string[]
        cc?: string[]
        task?: string
        artifacts?: string[]
        parent?: string
        worktree?: boolean
      }
      const actor = actorOf(exec as ExecLike)
      const provisioned = input.worktree === true
        ? await requireWorktree(worktree, service, { subject: input.subject, actor })
        : undefined
      try {
        const result = await service.author({
          subject: input.subject,
          body: input.body,
          actor,
          ...(input.to === undefined ? {} : { to: input.to }),
          ...(input.cc === undefined ? {} : { cc: input.cc }),
          ...(input.task === undefined ? {} : { task: input.task }),
          ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
          ...(input.parent === undefined ? {} : { parent: input.parent }),
          ...(provisioned === undefined
            ? {}
            : { reportId: provisioned.report, worktree: provisioned.prepared.binding }),
        })
        return renderMutation(result.front, result.outcomes, provisioned?.prepared)
      } catch (error) {
        // The report was never authored, so nothing references the checkout that
        // was made for it. Leaving it would be litter no report could explain.
        if (provisioned !== undefined) await service.rollbackProvision(provisioned)
        throw error
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'report_contribute',
    description: 'Add your own section to a report another agent opened, as a credited co-author. Use it when a task needs several agents to write one report: each contributor appends without overwriting the others, and the contribution is recorded as a hop so the path shows who wrote what and when.',
    parameters: {
      report: { type: 'string', required: true, description: 'Report id to contribute to, e.g. R-0007.' },
      body: { type: 'string', required: true, description: 'Your section of the report.' },
      note: { type: 'string', description: 'Short note recorded on the hop.' },
    },
    output: stringOutput,
    execute: async (args, exec) => {
      const input = args as { report: string; body: string; note?: string }
      const result = await service.contribute(input.report, actorOf(exec as ExecLike), input.body, input.note)
      return renderMutation(result.front, result.outcomes)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'report_send',
    description: 'Address an existing report to more recipients and wake them. Use it to pass a report upward to the agent that asked for it, or downward to an agent that must act on it. A recipient that is not currently resident is not an error: the hand-off is held in the ledger and delivered automatically when that session becomes resident again.',
    parameters: {
      report: { type: 'string', required: true, description: 'Report id to send.' },
      to: { type: 'array', required: true, items: { type: 'string' }, description: 'Session ids to address.' },
      note: { type: 'string', description: 'Short note recorded on the hop, e.g. why it is being sent now.' },
    },
    output: stringOutput,
    execute: async (args, exec) => {
      const input = args as { report: string; to: string[]; note?: string }
      const result = await service.send(input.report, actorOf(exec as ExecLike), input.to, input.note)
      return renderMutation(result.front, result.outcomes)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'report_cc',
    description: 'Copy a report to further recipients without waking them. Use it to keep a peer, a sibling agent, or an upstream owner informed about work they are not being asked to act on. The copy is recorded on the transfer path, so the ledger always shows who holds a copy of what.',
    parameters: {
      report: { type: 'string', required: true, description: 'Report id to copy.' },
      cc: { type: 'array', required: true, items: { type: 'string' }, description: 'Session ids to copy.' },
      note: { type: 'string', description: 'Short note recorded on the hop.' },
    },
    output: stringOutput,
    execute: async (args, exec) => {
      const input = args as { report: string; cc: string[]; note?: string }
      const result = await service.carbonCopy(input.report, actorOf(exec as ExecLike), input.cc, input.note)
      return renderMutation(result.front, result.outcomes)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'report_forward',
    description: 'Pass an existing report onward to another agent, or duplicate it into another thread. `mode: "forward"` addresses the new recipients and wakes them, keeping the original author and history intact; `mode: "copy"` records a duplication to recipients who should hold it as reference without being woken. Both record the onward hop, so the full route including copies stays auditable.',
    parameters: {
      report: { type: 'string', required: true, description: 'Report id to pass on.' },
      to: { type: 'array', required: true, items: { type: 'string' }, description: 'Session ids to forward or copy to.' },
      mode: { type: 'string', required: true, enum: ['forward', 'copy'], description: 'forward = addressed onward transfer (wakes); copy = duplication as reference (quiet).' },
      note: { type: 'string', description: 'Short note recorded on the hop.' },
    },
    output: stringOutput,
    execute: async (args, exec) => {
      const input = args as { report: string; to: string[]; mode: 'forward' | 'copy'; note?: string }
      const result = await service.forward(input.report, actorOf(exec as ExecLike), input.to, input.mode, input.note)
      return renderMutation(result.front, result.outcomes)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'report_read',
    description: 'Read one report: its digest, its COMPLETE transfer path (every hop with actor and time, and any recipient the report is still owed to), and its body. Use it when a digest told you a report exists and you need the substance, or when you need to know exactly how a report travelled and who holds copies. Reading is itself recorded as a hop.',
    parameters: {
      report: { type: 'string', required: true, description: 'Report id to read, e.g. R-0007.' },
    },
    output: stringOutput,
    execute: async (args, exec) => {
      const input = args as { report: string }
      return service.read(input.report, actorOf(exec as ExecLike))
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'report_list',
    description: 'List report digests from the ledger — no bodies, so this is the cheap way to survey a long-running collaboration. Filter by `session` to see every report that touches one agent (authored, addressed, copied, or contributed to), by `status`, or by `task` to pull up one collaboration across every session it touched. The task label is matched case-insensitively and partially, so "payments" finds "payments-rework". `worktree` matches a bound working tree by branch or path, which is the way to find out who is working in which checkout. Use it to find the report id you need before reading it, or to check what a teammate is still waiting on.',
    parameters: {
      session: { type: 'string', description: 'Only reports touching this session id.' },
      status: { type: 'string', enum: ['open', 'acked', 'closed'], description: 'Only reports in this state.' },
      task: { type: 'string', description: 'Only reports carrying this collaboration label (partial match, case-insensitive).' },
      worktree: { type: 'string', description: 'Only reports bound to a working tree whose branch or path contains this text (partial match, case-insensitive).' },
      limit: { type: 'integer', description: 'Maximum rows (default 50, capped at 200).' },
    },
    output: stringOutput,
    execute: async (args) => {
      const input = args as { session?: string; status?: string; task?: string; worktree?: string; limit?: number }
      const rows = await service.list({
        ...(input.session === undefined ? {} : { session: input.session }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.task === undefined ? {} : { task: input.task }),
        ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      })
      if (rows.length === 0) {
        // Name the filter that emptied the result. "no reports match" after a
        // worktree filter reads as "nothing is bound anywhere", which is a
        // different and much stronger claim than "nothing matched this text".
        if (input.worktree !== undefined && input.worktree.trim() !== '') {
          return `no reports are bound to a working tree matching ${JSON.stringify(input.worktree)}`
        }
        return input.task === undefined ? 'no reports match' : `no reports carry a task matching ${JSON.stringify(input.task)}`
      }
      const lines = [`${rows.length} report(s):`, ...rows.map(renderRow)]
      // A task rollup answers the question the filter was asked for: how much of
      // this collaboration is still live, rather than how many rows came back.
      const taskFilter = input.task?.trim()
      if (taskFilter !== undefined && taskFilter !== '') {
        let open = 0
        let acked = 0
        let closed = 0
        for (const row of rows) {
          if (row.status === 'open') open += 1
          else if (row.status === 'acked') acked += 1
          else if (row.status === 'closed') closed += 1
        }
        lines.push(`task ${JSON.stringify(taskFilter)}: ${open} open, ${acked} acked, ${closed} closed`)
      }
      return lines.join('\n')
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'report_ack',
    description: 'Acknowledge a report you received: record that you have taken it in, with an optional note. The hop is added to the transfer path and the report moves to `acked`, so the sender can see the loop is closed rather than guessing whether the hand-off landed.',
    parameters: {
      report: { type: 'string', required: true, description: 'Report id to acknowledge.' },
      note: { type: 'string', description: 'What you are doing about it, or why no action is needed.' },
    },
    output: stringOutput,
    execute: async (args, exec) => {
      const input = args as { report: string; note?: string }
      const result = await service.acknowledge(input.report, actorOf(exec as ExecLike), input.note)
      return renderMutation(result.front, result.outcomes)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'report_close',
    description: 'Conclude a report — record that the matter is finished so the ledger stops treating it as live work. Closing is the OWNER\'s act, not a reader\'s: only the agent that opened the report or one of its co-authors may close it, and a refusal names who to ask. This is different from acknowledging: report_ack says "I have taken this in" while the matter is still running. Closing is not a lock — if anyone later contributes to, sends, copies, or forwards a closed report it reopens automatically and records that, so a prematurely closed report can never silently swallow new work.',
    parameters: {
      report: { type: 'string', required: true, description: 'Report id to close.' },
      note: { type: 'string', description: 'Why it is finished, or what concluded it. Recorded on the hop.' },
      ...(worktree.enabled
        ? {
          worktree: {
            type: 'string',
            enum: ['keep', 'remove-if-clean'],
            description: 'What to do with a bound git checkout. keep (the default) leaves it exactly as it is; '
              + 'remove-if-clean deletes it only if it has no uncommitted work, and reports git\'s refusal otherwise.',
          },
        }
        : {}),
    },
    output: stringOutput,
    execute: async (args, exec) => {
      const input = args as { report: string; note?: string; worktree?: 'keep' | 'remove-if-clean' }
      const result = await service.close(input.report, actorOf(exec as ExecLike), input.note, {
        // The deployment's default, overridable per close. `keep` is the safest
        // thing a deployment can be configured to do and the only thing it does
        // by default: a report ending is not a licence to delete a directory.
        worktree: input.worktree ?? worktree.onClose,
      })
      return [
        renderMutation(result.front, result.outcomes),
        renderWorktreeOutcome(result.worktree, worktree.enabled),
        'closed — later activity on this report reopens it automatically',
      ].filter((line): line is string => line !== undefined).join('\n')
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'report_release',
    description: 'Hand back a report\'s claim on its git checkout without concluding the report. Use it when the work in that checkout is done but the conversation is not: the checkout stays on disk exactly as you left it, and the claim — which is what stops another agent from taking the same branch — ends. A claim is released once; closing a report releases it too, so this is only needed while the report stays open.',
    parameters: {
      report: { type: 'string', required: true, description: 'Report id whose checkout claim should end.' },
      note: { type: 'string', description: 'Why the claim is being handed back. Recorded on the hop.' },
    },
    output: stringOutput,
    execute: async (args, exec) => {
      const input = args as { report: string; note?: string }
      const result = await service.release(input.report, actorOf(exec as ExecLike), input.note)
      const binding = result.front.worktree
      return [
        renderMutation(result.front, result.outcomes),
        binding === undefined
          ? 'claim released'
          : `claim released; the checkout at ${binding.path} is untouched and stays traceable to ${result.front.report}`,
      ].join('\n')
    },
  })))

  if (worktree.enabled) {
    disposers.push(ctx.tools.register(defineTool({
      name: 'report_lease',
      description: 'Claim an EXISTING git checkout for a report — the counterpart to report_release. Use it to pick up a checkout that already exists: one a human made, one a previous report left behind, or one a report released earlier. A branch is held by exactly one live report at a time, so a competing claim is refused and the refusal names the holder and its authors. The branch is read from the checkout itself, so pass one only to require it.',
      parameters: {
        report: { type: 'string', required: true, description: 'Report id that will hold the checkout. Only its owners may claim on its behalf.' },
        path: { type: 'string', required: true, description: 'Absolute path of the checkout to claim.' },
        branch: { type: 'string', description: 'The branch the checkout must be on. Omit to take whichever branch it is really on.' },
      },
      output: stringOutput,
      execute: async (args, exec) => {
        const input = args as { report: string; path: string; branch?: string }
        const result = await service.lease(input.report, actorOf(exec as ExecLike), {
          path: input.path,
          ...(input.branch === undefined ? {} : { branch: input.branch }),
        })
        const binding = result.front.worktree
        return [
          renderMutation(result.front, result.outcomes),
          binding === undefined
            ? 'claimed'
            : `claimed ${binding.branch ?? '(detached HEAD)'} at ${binding.path}${binding.head === undefined ? '' : ` @ ${binding.head.slice(0, 12)}`}`,
        ].join('\n')
      },
    })))
  }

  disposers.push(ctx.tools.register(defineTool({
    name: 'report_amend',
    description: 'Correct a report you own — fix a wrong subject, retag the collaboration, or amend the body — instead of opening a replacement report and losing the original transfer path. Correcting is the OWNER\'s act: only the originator or a co-author may amend, and a refusal names who to ask. What can change is deliberately narrow. The digest fields (subject, task, artifacts) are current state and are replaced, with the hop recording the old and new values verbatim. The body is a record of what agents actually said, so by default your text is APPENDED as an amendment section rather than rewriting anyone\'s words; set replace_body: true to rewrite it outright, and the hop records that you did. Recipients, co-authorship, and thread links can never be edited here — they come from the transfer path itself, so the only way to change them is another send/cc/contribute. Amending a closed report reopens it. Amending changes nothing when the values you pass already match, and says so.',
    parameters: {
      report: { type: 'string', required: true, description: 'Report id to correct.' },
      subject: { type: 'string', description: 'Replacement subject. An empty value is refused, since a report must keep a title.' },
      task: { type: 'string', description: 'Replacement collaboration label; an empty value clears the label.' },
      artifacts: { type: 'array', items: { type: 'string' }, description: 'Replacement artifact list — the WHOLE list, not additions to it.' },
      body: { type: 'string', description: 'New body text: appended as an amendment section, or used to replace the body when replace_body is true.' },
      replace_body: { type: 'boolean', description: 'Rewrite the body instead of appending. Requires body, and is recorded on the hop so later readers know the text was rewritten.' },
      note: { type: 'string', description: 'Extra note appended to the recorded change summary.' },
    },
    output: stringOutput,
    execute: async (args, exec) => {
      const input = args as {
        report: string
        subject?: string
        task?: string
        artifacts?: string[]
        body?: string
        replace_body?: boolean
        note?: string
      }
      const result = await service.amend(input.report, actorOf(exec as ExecLike), {
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        ...(input.task === undefined ? {} : { task: input.task }),
        ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.replace_body === undefined ? {} : { replaceBody: input.replace_body }),
        ...(input.note === undefined ? {} : { note: input.note }),
      })
      return `${renderMutation(result.front, result.outcomes)}\nthe correction is recorded as a hop, with the old and new values`
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'peer_list',
    description: 'List the agents you can work with, and how each one relates to you: your parent and ancestors, the agents you delegated to, your siblings, the peers you started, and the agents the ledger shows you have exchanged reports with. Each row tells you whether that agent is resident right now — a resident one receives a report immediately, an absent one has the hand-off held for it. Use this to find the session id you need before addressing a report, instead of guessing or giving up because you do not know who is around.',
    parameters: {
      scope: { type: 'string', enum: ['related', 'live', 'all'], description: 'related (default) = lineage, peers you started, and ledger contacts; live = every agent resident right now, whatever the relation; all = every known session.' },
      limit: { type: 'integer', description: 'Maximum rows (default 40, capped at 200).' },
    },
    output: stringOutput,
    execute: async (args, exec) => {
      const input = args as { scope?: 'related' | 'live' | 'all'; limit?: number }
      const rows = await peers.roster(actorOf(exec as ExecLike), {
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      })
      if (rows.length === 0) return 'no agents match; nothing to address yet'
      return [
        `${rows.length} agent(s):`,
        ...rows.map((row) => {
          const parts = [
            `${row.relation.padEnd(10)}`,
            row.live ? 'live   ' : 'absent ',
            row.sessionId,
            `reports=${row.reports}`,
          ]
          if (row.name !== undefined) parts.push(`name=${row.name}`)
          if (row.title !== undefined) parts.push(`title=${row.title}`)
          if (row.depth !== undefined) parts.push(`depth=${row.depth}`)
          return parts.join(' ')
        }),
      ].join('\n')
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'peer_start',
    description: 'Open a new independent agent session — a peer, not a subordinate. A peer is a root session with its own lifecycle that outlives this turn, so it is the right move when the work is long-running, when you want a partner that keeps its own context across days, or when a task should not be nested under you. This creates the session, records that you started it (which is what later lets you address it directly), and hands it the task as a REPORT — so the assignment is durable and traceable, and the peer can answer by contributing to that same report. The output also reports what became of the peer\'s first turn (running, already ended, or failed): a delivered digest proves only that the peer is resident, never that work started. Do not use this as a cheaper subagent: for a bounded subtask, delegation is the right tool.',
    parameters: {
      task: { type: 'string', required: true, description: 'What this peer is for and what it should do first. It becomes the opening report body.' },
      name: { type: 'string', description: 'Optional short display name for the peer (60 characters or fewer).' },
      ...worktreeParam(worktree, 'Give the peer its own git checkout, on a branch named after the assignment report, and start it there instead of in your directory. Only the working directory and index are private; config, hooks and the object store are shared with every other checkout.'),
    },
    output: stringOutput,
    execute: async (args, exec) => {
      const input = args as { task: string; name?: string; worktree?: boolean }
      const actor = actorOf(exec as ExecLike)
      const subject = subjectFrom(input.task, input.name)
      // The checkout has to exist before the peer does, because the peer's
      // working directory is the checkout's path and a session is born with the
      // directory it will keep. That ordering is the whole reason report ids can
      // be claimed in advance.
      const provisioned = input.worktree === true
        ? await requireWorktree(worktree, service, { subject, actor })
        : undefined
      let started: Awaited<ReturnType<PeerService['start']>>
      let result: Awaited<ReturnType<ReportService['author']>>
      try {
        started = await peers.start(actor, {
          task: input.task,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(provisioned === undefined ? {} : { cwd: provisioned.prepared.binding.path }),
        })
        result = await service.author({
          subject,
          body: [
            `本会话由 ${actor} 开启，你是它的**同伴**而非下属：你有自己的生命周期，会比这一轮活得更久。`,
            ...(provisioned === undefined
              ? []
              : [
                '',
                `你的工作目录是一个**独立的 git 检出**：${provisioned.prepared.binding.path}（分支 ${provisioned.prepared.binding.branch}）。`,
                '独立的是工作目录与索引；config、hooks、对象库与其它检出共享，所以装 hook 或改配置会影响所有检出。',
              ]),
            '',
            `要回复或继续这个话题，用 report_contribute 追加到本汇报——它会成为我们之间的线程；需要直接交代新事情时用 report_author 并 to=[${actor}]。`,
            '',
            '## 任务',
            input.task,
          ].join('\n'),
          actor,
          to: [started.sessionId],
          task: started.name,
          ...(provisioned === undefined
            ? {}
            : { reportId: provisioned.report, worktree: provisioned.prepared.binding }),
        })
      } catch (error) {
        // Neither the peer nor a report exists to explain the checkout, so it is
        // rolled back rather than left for a later cleanup to puzzle over.
        if (provisioned !== undefined) await service.rollbackProvision(provisioned)
        throw error
      }
      // Observe the first turn before answering. The assignment has just been
      // delivered, so this is the only moment where "did it start?" is cheap to
      // answer — and the answer is the difference between a hand-off and a hope.
      const receipt = describeReceipt(await peers.receipt(started.sessionId, DEFAULT_RECEIPT_MS), DEFAULT_RECEIPT_MS)
      return [
        `opened peer ${started.sessionId}${started.name === undefined ? '' : ` (name=${started.name})`}`,
        started.cwd === undefined ? '' : `cwd=${started.cwd}`,
        `peers you have started: ${started.started}`,
        `assignment report: ${result.front.report}`,
        ...(provisioned === undefined ? [] : renderProvision(provisioned.prepared)),
        renderMutation(result.front, result.outcomes),
        receipt === undefined ? '' : receipt,
        renderWorkspace(started.workspace),
        `Address this peer later with report_send / report_cc to=${started.sessionId}, or see everyone with peer_list.`,
      ].filter((line) => line !== '').join('\n')
    },
  })))

  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}
