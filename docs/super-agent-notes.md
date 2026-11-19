# 从 Super-agent 借来的：生命周期与消息传递

> 研究对象是 [`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT，commit `8c32a9d`，2026-11-16 取读）。它是研究原型、不是官方产品，本机也没有安装；这里只取设计，不取代码。
> **状态（2026-11-16）**：P0-1（确定性投递 id + inbox/历史查重 + flush 后才记到达）、P0-2（`report_check({ delivery: true })`）、P1-1（失败退避 + 连续失败告警 + 只在有失败时运行的重试扫描）与 P1-2（`attention` 结构化提问 + 列表过滤 + 面板标记）已落地；P2 未做。下文保留原始的判断与取舍，落地后的实现细节以 [设计](design.md) 与源码为准。
> 本文回答两个问题：它的**消息传递**和**生命周期**里哪些做法值得搬进账本，哪些看着像、搬过来会毁掉账本已有的不变量。结论先给：值得借的是「投递的因果分层」与「等待的结构化」；不值得借的是它的事件准入/策略引擎与 SQLite 工作队列。

## 0. 一句话结论

账本的投递目前只有两级事实：**被投递**（`sent`/`cc`/…）和**已到达**（`delivered`）。Super-agent 的四级事实——被投递 → 已到达 → 已被 step 取用 → 已被处理——正好补上中间两级，而且 DSH 自己就把这两级记在会话日志里（`agent/inbox/*` 与 `user/message`），不需要猜。生命周期同理：账本只有 `open → acked → closed`，而「在等人回答」「发不出去」「被放弃」目前只能写在自由文本里，查不到。

## 1. 概念对照

| 工作单元 | Super-agent | 本账本 | 差异 |
|---|---|---|---|
| 一件被授权的工作 | Ticket（open → ended） | report（`open`/`acked`/`closed`） | 账本没有「执行绑定」这一层 |
| 执行者 | Assignment（pending → running → ended，一 Ticket 可有多次） | 会话本身 + 检出占用 | Assignment 的「换人重试」账本用 `transfer`/`handover` 表达 |
| 一次投递 | Input + `delivery` effect | hop + `delivered` | 账本缺「尝试/失败/退避」与「取用」 |
| 取用 | read = 被 step 取用且随后 report 或结束回合 | `read` 跳 = 打开过**正文** | 同名不同义：账本的 `read` 不是消费摘要 |
| 等人 | Attention（结构化字段）+ stage `person / answer` | `acked` + note 自由文本 | 账本无法查询「在等谁回答什么」 |
| 结束 | `ready`/`dropped` 结束；人 `stop` 撤销授权 | `closed`，且活动自动重开 | 账本无可表达的「硬停」 |
| 授权 | Mandate + Policy | 共写关系（`authors`） | 账本权限是关系，不是令牌 |
| 订阅知情 | Subscription（扇出上下文，不授权） | `cc`（进入上下文，不唤醒） | 语义一致，这点账本已经更严格 |

## 2. 值得吸收的四点

> 下面四点的“建议改法”均已落地（见文首状态与第 5 节）；保留原始措辞，方便回看当时的取舍与验收标准。

### 2.1 确定性消息 id：投递幂等（P0）

**原型怎么做**（`src/app/delivery.ts`）：每条要投递的消息都带一个由请求 id 派生的稳定消息 id（`dsh-superagent:<requestId>`），重试时不变；投递前先查目标会话的历史与会话内待收箱（`agent.inbox.nextTurn/nextStep`），命中就不投；投递后 `sessionPersistence.flush()` 落盘，才向生产者确认。于是「重试」不等于「重复」，崩溃也不会让确认早于持久化。

**账本现状**（`src/report/deliver.ts`、`src/report/service.ts`）：`renderDigest` 每次投递都生成 `randomUUID()`，`#deliver` 先 `steer`/`inject`、再追加 `delivered` 跳。中间那个 await 窗口有一个确定的重复风险：`steer` 成功、`delivered` 跳没写成就崩溃，待投递仍成立，重启后的补投再生成一个新 UUID —— 同一条摘要进两次收件箱。

另一个缺口不是持久化的：`delivered` 跳写成之后，消息仍可能被 pre-step 拒绝、被 cancel、或被 `clear` 清掉，从未进入对话历史——账本说「已到达」，收件方却从没看见。这一格归 2.2。注意 DSH 的 inbox 变更本身是持久化事件（`agent/inbox/spliced`），所以「steer 返回了但消息没落盘」不是主要风险；`flush()` 仍然值得加，理由是账本关于到达的声明不应早于会话日志落盘——原型也正是先 flush 再确认。

**建议改法**：投递 id 从跳流派生，不再随机：

```ts
// 该收件人「当前这笔欠账」由哪一跳造成；重试用同一个 id
export function deliveryId(report: string, hops: readonly RouteHop[], target: string): string {
  let handoff = -1
  hops.forEach((hop, index) => { if (addresses(hop, target)) handoff = index })
  return `report-ledger:${report}:${handoff}`
}
```

投递前用这个 id 查 `agent.inbox.nextTurn/nextStep`（命中即跳过），再查目标会话历史（`sessionPersistence.open(id, 'read')` 扫 `user/message` 的 id）；投递后先 `ctx.sessionPersistence.flush()` 再记 `delivered`。本机 0.2.2-rc.3 的 `@deepseek-ai/dsh-agent` 类型与 `sessionPersistence` 服务目录里这两样都在，不需要新造 API。

**代价**：一次投递多一次历史扫描（只在该收件人有欠账时发生，可按会话缓存）；历史被压缩后可能查不到旧 id，退化为「再投一次」——这是 at-least-once 的已知边界，写进限制即可。

**验收**：同一跳流投递两次，收件箱只有一条；模拟「steer 后崩溃」（不记 `delivered`）后重投，不产生第二条；`flush` 失败时不写 `delivered`。

### 2.2 送达 ≠ 取用：把「有没有人真的看到」变成可诊断的事实（P0 诊断，P1 跳）

**原型怎么做**：一个 Input 只有「被 step 取用、且该回合随后报告或结束」才算 read；被取用又被取消的消息算未读，重启后按「未取用」重投；它和单纯「投递成功」是两件事（`003-execution.md`）。

**账本现状**：`delivered` 只证明到达。收件方进程活着、消息进了 inbox，但可能永远不开始回合，或被 pre-step 拒绝、或被 cancel 清掉——账本上仍然显示已送达。`peer_wake` 的 `unstarted` 回执已经承认了这个缺口（「inbox 里但没有回合」），但一般汇报没有等价物。`read` 跳是「打开过正文」，不是「消费过摘要」。

**建议改法（先只做诊断，不改状态机）**：给 `report_check` 加一段只读的投递诊断：对每份有待投递/已送达未回执的汇报，用 2.1 的确定性 id 判断每个收件人的状态——

| 状态 | 依据 | 含义 |
|---|---|---|
| `absent` | `ctx.agents.get` 为空 | 还没送达，等它回来 |
| `inbox` | id 在 `nextTurn`/`nextStep` | 已到达，尚未被任何 step 取用 |
| `taken` | 会话历史里有该 `user/message` | 进入了对话，但不一定读过 |
| `stranded` | 驻留、既不在 inbox 也不在历史 | 到达记录在账本里，实际已丢失——最需要被看见的一格 |

**如果要更远一步（P1）**：监听 `session/event` 的 `user/message`，id 命中就追一条 `taken` 跳。注意别用 `agent/inbox/claimed` 作为信号：pre-step 被拒绝时消息「既不 discard 也不再作为 user/message 出现」，claimed 不等于模型看到过。加跳会改 `HOP_ACTIONS` 与 `report_read` 的计数口径（`taken` 算不算 `hops`、算不算工作量），是一次真正的模型扩展，建议等诊断跑一段时间、确认它真的回答了问题再动。

**代价**：诊断要读会话日志，只适合 `report_check` 这种冷路径；热路径（每 10 秒的面板轮询）不能做。

**验收**：一个只被 `inject` 却从未开始回合的 cc，在 `report_check` 里显示 `inbox` 而不是「已送达」；被 cancel 的摘要显示 `stranded`；正常回复的摘要显示 `taken`。

### 2.3 尝试、退避与健康：把 pending 从布尔变成有过程的状态（P1）

**原型怎么做**：投递/中继/回复都是「先存后做」的 effect 行，带 `attempts`、`due`、`since`；失败按 2s → 60s（回复 5s → 300s）指数退避；连续 3 次失败才升级为健康问题；「暂时不能做」（暂停、限流、源未启用）用 `Later` 表达，不增加失败计数；关闭时等待在跑的 effect，未跑的行留在库里下次启动继续。同一 Ticket 发往同一会话的消息保序，后面的等前面的，直到前面的连续失败 3 次。

**账本现状**：失败只留在 `#deliver` 抛出的错误文本里（「will be retried by the delivery sweep」），没有尝试计数、没有退避、没有定时重扫（补投只在插件加载与 `agent/created` 时发生）。一个每次都被拒绝的目标会被每次扫描重试，而操作者看不到「这笔投递一直失败」。

**建议改法（不引入持久队列）**：退避表放内存——`Map<targetId, { attempts, nextAt }>`，扫描时跳过未到期的目标；连续 3 次失败后 `ctx.logger.warn` 并在 `report_check` 里列为 `failing`。持久的是**欠账**（跳流派生，已经在做），需要重启后恢复的也只是「谁欠着」；「下次该什么时候试」不是账本要保证的事实，丢了就早试一次，无害。

**明确不做**：不要把 effect/attempt 落成第二份持久状态。账本的不变量是「跳流是唯一权威、其余都是投影」；一个可变的 attempt 表会让 `report_check` 出现第三种真相。

**代价**：很小；但退避只在本进程内有效，跨进程共享账本时两个进程各有一份内存退避（与单进程假设一致）。

**验收**：失败目标连续扫描时按 2s/4s/8s… 退避；第 3 次失败后日志出现一条 warn；`report_check` 列出该目标与最后错误；目标恢复后一次成功即清空计数。

### 2.4 结构化「在等人」：attention 是字段，不是自由文本（P1）

**原型怎么做**：Ticket 的 stage 由「在等什么」决定（`person / delivery`、`person / answer`、`person / review`、`working / queued`、`idle`），且明确拒绝从报告的自由文本推断「在等人」——需要结构化事实，所以 Attention 是字段，面板只按它排序。

**账本现状**：`acked` 只说明「我收到了」，note 里写「等你确认 X」没有任何下游效果；`report_list` 无法筛「哪些汇报在等我」，面板也没有这个排序。跨多个会话时，这正是最容易丢的一类状态。

**建议改法**：

- front matter 增加可选块（沿 `worktree` 的先例，不是新概念）：

```yaml
attention:
  question: "方案 A 还是 B？"
  options: ["A", "B"]      # 可选
  by: session-abc          # 谁在等
  at: 1763...              # 何时开始等
```

- 从跳流派生（与 `status` 同一机制）：`report_attention(report, question?, options?)` 落一跳，最新一跳决定当前 attention；不传 question = 清除。结案自动清除。
- `report_list` 增加过滤与行内标记；面板把「等回答」排在「进行中」之前（沿原型 stage 表的顺序）。
- 回执**不**自动清除 attention：回执是「收到」，回答是另一件事；谁有权清除（提问者/任何收件人）需要在实现前定一个规则，别做成隐式副作用。

**代价**：新工具 + 跳动作 + 面板/列表改动，是四点里最大的一笔；但它补的是「多代理协作靠人脑记谁在等谁」这个真实缺口。

**验收**：设了 attention 的汇报在 `report_list({ attention: true })` 与面板顶部出现；清除后消失；结案后不残留；跳流能回放「何时提问、何时回答」。

### 2.5 只借一半：停止与结束不是一回事

**原型怎么做**：`ready`/`dropped` 自然结束；人 `stop` 撤销 Mandate，Ticket 保持结束、之后的 Trigger 不再复活它，要新授权。它把「做完了」与「被叫停」当成两种结局。

**账本现状**：`closed` 是状态不是锁，任何后续活动都会重开——这是刻意的，因为「静默吞掉后续工作」是账本最怕的失败。所以**不要**引入硬停：它会和这条不变量直接冲突。

**可以借的只有记账**：`report_close` 增加可选 `outcome`（`done` / `superseded` / `abandoned` / `stopped`），只写进 `closed` 跳，不改变重开语义。读者终于能区分「做完了」和「放弃了」，统计也不必再解析 note。

## 3. 明确不借

| 不借 | 理由 |
|---|---|
| Eval / Gate / Policy / Mandate | 那是**入口侧**治理：外部事件流、谁能下单、推断强度。账本没有入口，权限是共写关系；搬进来会造出第二套权限语言，并把一个交互原语变成工作流引擎。 |
| SQLite effect 队列 | 账本用跳流派生欠账，已经是「先记后做」；再加可变队列就有了第二份真相，`report_check` 的一致性检查将无法定义。 |
| 外部 Watchdog 进程 | 账本明确单进程假设；进程死了宿主会重启，插件随宿主加载。替代品是 `report_check` 诊断 + 面板健康区，而不是再起一个守护进程。 |
| Ticket / Assignment 双层 | DSH 会话本身有生命周期，账本已有 `transfer`/`handover` 处理「换人」；再加一层 Assignment 会与 `peer_start`/`resume` 的会话归属打架。 |
| 同一收件人严格保序 | 摘要是指针，不是回复；两份摘要乱序到达不改变任何事实。正文追加本身有每报告锁，真正的顺序问题已经解决。 |
| Subscription 的授权含义 | 原型明确「订阅只给上下文、不给授权」；账本的 `cc` 已经是这个语义，且更严格。无需引入订阅模型。 |

## 4. 已经对齐、不必再动的部分

- **批量合并**：收件人不在线期间被投递多次，回来只收到一条「当前状态」的摘要——与原型把 Trigger 合并成一批是同一效果，`pendingTargets` 的顺序语义已经保证最后一次主送不会被吞。
- **唤醒策略按窗口**：窗口内有未答复的主送就 `steer`，纯抄送才 `inject`——对应原型「订阅扇出不唤醒、显式请求才唤醒」。
- **授权与上下文分离**：`cc` 进上下文不授权，共写才拿到 `close`/`amend` 权限。

## 5. 落地顺序

| 顺序 | 改动 | 状态 |
|---|---|---|
| P0-1 | 确定性投递 id + inbox/历史去重 + flush 后记 `delivered` | 已落地（`c80b7ef`） |
| P0-2 | `report_check` 投递诊断（absent/inbox/taken/stranded/failing） | 已落地（`c80b7ef`、`c1700cc`） |
| P1-1 | 内存退避 + 连续失败告警 + 只在有失败时运行的重试扫描 | 已落地（`c1700cc`）；`flush` 屏障失败也计入失败（`84fec23`） |
| P1-2 | `attention` 字段 + 工具 + 列表/面板 | 已落地（`2306fa6`、`93f98c7`） |
| P2 | `closed` 的 `outcome`、`taken` 跳 | 未做 |

测试落在现有的确定性检查里：投递相关进 `scripts/delivery-check.ts` 与 `scripts/smoke.ts`，attention 进 `scripts/attention-check.ts`；新增跳动作要同步 `HOP_ACTIONS`、`parseHop`、`projectRoute` 与 `scripts/repair-digests.ts`。

## 6. 定夺结果

1. **幂等键取「最新投递跳的序号」**：从跳流免费得到、随账本变化稳定，已实现。
2. **历史查不到就投**：接受 at-least-once，宁可重复一次也不把交接卡住；边界写进 README 已知限制。
3. **`taken` 暂不成为跳**：`report_check` 的只读诊断已经能回答同一问题，等它真的不够用再加。
4. **attention 的清除权给了所有参与者**：谁都能提问或撤回，结案自动撤回；没有单独的“回答”事件，回答就是一次贡献/回执/结案。

---

← 返回 [README](../README.md) · 相关：[设计](design.md) · [同伴](peers.md)
