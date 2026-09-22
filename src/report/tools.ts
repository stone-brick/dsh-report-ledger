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
import type { PeerService } from './peer.ts'
import type { ReportService } from './service.ts'
import { renderRow } from './service.ts'
import type { DeliveryOutcome } from './deliver.ts'

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
function renderMutation(front: { report: string; status: string; subject: string; to: readonly string[]; cc: readonly string[]; authors: readonly string[]; hops: number }, outcomes: readonly DeliveryOutcome[]): string {
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
  return lines.join('\n')
}

/** Derive a concise report subject from a task description. */
function subjectFrom(task: string, name: string | undefined): string {
  const firstLine = task.split('\n').find((line) => line.trim() !== '')?.trim() ?? task.trim()
  const trimmed = firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine
  return name === undefined ? trimmed : `${name}: ${trimmed}`
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
      }
      const result = await service.author({
        subject: input.subject,
        body: input.body,
        actor: actorOf(exec as ExecLike),
        ...(input.to === undefined ? {} : { to: input.to }),
        ...(input.cc === undefined ? {} : { cc: input.cc }),
        ...(input.task === undefined ? {} : { task: input.task }),
        ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
        ...(input.parent === undefined ? {} : { parent: input.parent }),
      })
      return renderMutation(result.front, result.outcomes)
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
    description: 'List report digests from the ledger — no bodies, so this is the cheap way to survey a long-running collaboration. Filter by `session` to see every report that touches one agent (authored, addressed, copied, or contributed to), by `status`, or by `task` to pull up one collaboration across every session it touched. The task label is matched case-insensitively and partially, so "payments" finds "payments-rework". Use it to find the report id you need before reading it, or to check what a teammate is still waiting on.',
    parameters: {
      session: { type: 'string', description: 'Only reports touching this session id.' },
      status: { type: 'string', enum: ['open', 'acked', 'closed'], description: 'Only reports in this state.' },
      task: { type: 'string', description: 'Only reports carrying this collaboration label (partial match, case-insensitive).' },
      limit: { type: 'integer', description: 'Maximum rows (default 50, capped at 200).' },
    },
    output: stringOutput,
    execute: async (args) => {
      const input = args as { session?: string; status?: string; task?: string; limit?: number }
      const rows = await service.list({
        ...(input.session === undefined ? {} : { session: input.session }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.task === undefined ? {} : { task: input.task }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      })
      if (rows.length === 0) return input.task === undefined ? 'no reports match' : `no reports carry a task matching ${JSON.stringify(input.task)}`
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
    },
    output: stringOutput,
    execute: async (args, exec) => {
      const input = args as { report: string; note?: string }
      const result = await service.close(input.report, actorOf(exec as ExecLike), input.note)
      return `${renderMutation(result.front, result.outcomes)}\nclosed — later activity on this report reopens it automatically`
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
    description: 'Open a new independent agent session — a peer, not a subordinate. A peer is a root session with its own lifecycle that outlives this turn, so it is the right move when the work is long-running, when you want a partner that keeps its own context across days, or when a task should not be nested under you. This creates the session, records that you started it (which is what later lets you address it directly), and hands it the task as a REPORT — so the assignment is durable and traceable, and the peer can answer by contributing to that same report. Do not use it as a cheaper subagent: for a bounded subtask, delegation is the right tool.',
    parameters: {
      task: { type: 'string', required: true, description: 'What this peer is for and what it should do first. It becomes the opening report body.' },
      name: { type: 'string', description: 'Optional short display name for the peer (60 characters or fewer).' },
    },
    output: stringOutput,
    execute: async (args, exec) => {
      const input = args as { task: string; name?: string }
      const actor = actorOf(exec as ExecLike)
      const started = await peers.start(actor, {
        task: input.task,
        ...(input.name === undefined ? {} : { name: input.name }),
      })
      const result = await service.author({
        subject: subjectFrom(input.task, started.name),
        body: [
          `本会话由 ${actor} 开启，你是它的**同伴**而非下属：你有自己的生命周期，会比这一轮活得更久。`,
          '',
          `要回复或继续这个话题，用 report_contribute 追加到本汇报——它会成为我们之间的线程；需要直接交代新事情时用 report_author 并 to=[${actor}]。`,
          '',
          '## 任务',
          input.task,
        ].join('\n'),
        actor,
        to: [started.sessionId],
        task: started.name,
      })
      return [
        `opened peer ${started.sessionId}${started.name === undefined ? '' : ` (name=${started.name})`}`,
        started.cwd === undefined ? '' : `cwd=${started.cwd}`,
        `peers you have started: ${started.started}`,
        `assignment report: ${result.front.report}`,
        renderMutation(result.front, result.outcomes),
        `Address this peer later with report_send / report_cc to=${started.sessionId}, or see everyone with peer_list.`,
      ].filter((line) => line !== '').join('\n')
    },
  })))

  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}
