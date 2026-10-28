# dsh-report-ledger

一个 DSH 插件：把「**汇报**」做成代理之间的一等交互原语，并为长期协作留下可追溯的账本。

DSH 原本的代理间通信是**相邻 Agent 的 steer 投递**：只能投给直接子代理或直接父代理，没有持久 mailbox（父代理不在线时消息被拒绝），也没有抄送、回执、线程与传递路径记录。本插件补上的是这一块地基，而且**不改会话格式**：账本是 `$DSH_HOME/report-ledger/` 下的纯文本文件，模型只读 front matter 缩略，正文按需打开。

## 安装

```sh
dsh plugin --profile web add dsh-report-ledger
```

这条命令把包装进该 profile 的 `node_modules`；因为包声明了 `dsh.bundle.patch`，`dsh plugin` 会**自动**把它追加进 profile 的 `dsh.profile.bundles`，不需要手改任何配置文件。装完**重启 profile**（`dsh web`）生效。不启动也能验证：

```sh
dsh --profile web --dump-config     # 配置树里应出现 report-ledger 这一行
```

卸载走同一条通道，依赖与该配置层一起移除：

```sh
dsh plugin --profile web remove dsh-report-ledger
```

**要求与边界**

- 对齐 **DSH 0.2.0-rc.2 与 0.2.1 线**（`0.2.1-rc.2/rc.3/rc.4` 已实测，见 [兼容性](docs/dev-build.md#兼容性与依赖契约)；0.1.5-rc.3 及更早不再支持）；运行产物要求 Node ≥ 20。
- 账本是**本机文件**：`$DSH_HOME/report-ledger/`（可用 `DSH_REPORT_LEDGER_ROOT` 覆盖），不上传任何地方。
- 浏览器读数据走三个 **GET 只读端点**，只放行 loopback；所有写操作仍然只经模型工具，那是唯一会记录跳的路径。
- `peer_start` 是唯一会**新增活代理**的能力，受 `maxPeersPerAgent`（默认 8）约束，每次创建都记进名册日志；`peer_wake` 只加载**已有**会话，既不新增也不占名额，而且只有开启者能唤。
- 工作区（git 检出）功能**默认关闭**，关闭时不出现 `report_lease` 与各工具的 `worktree` 参数。

### 国内镜像（Gitee）

源码与发行版同步在 [gitee.com/stone_zhan/dsh-report-ledger](https://gitee.com/stone_zhan/dsh-report-ledger)，**不经过 GitHub** 也能装：

```sh
# 预构建产物，不需要构建工具链
dsh plugin --profile web add https://gitee.com/stone_zhan/dsh-report-ledger/releases/download/v0.2.4/dsh-report-ledger-0.2.4.tgz
# 或直接从 Gitee 安装（预构建产物，安装时不构建）
dsh plugin --profile web add git+https://gitee.com/stone_zhan/dsh-report-ledger.git
```

GitHub 每次推送后由 `.github/workflows/mirror-to-gitee.yml` 自动镜像所有分支与 tags。

注意：**npm 安装走的是 npm 镜像站而不是 GitHub**，所以 `npm publish` 之后上面那条一行命令才是国内用户最省事的路；Gitee 镜像解决的是「拿不到 GitHub」时的源码与产物可达性。

### English quick start

```sh
dsh plugin --profile web add dsh-report-ledger   # install + register the bundle layer
dsh --profile web --dump-config                  # verify: a `report-ledger` row appears
dsh web                                          # restart the profile to load it
```

Reports are first-class agent-to-agent messages with a persisted ledger: front matter is the digest that enters the model's context, the body stays on disk and is opened on demand, and every hop is appended to an auditable transfer path. The ledger lives in `$DSH_HOME/report-ledger/` and nothing leaves the machine. The host half works in any profile; the web profile additionally gets a **Reports** tab and a topological canvas in the right sidebar. Aligned with DSH 0.2.0-rc.2.

## 五分钟上手

**开一份汇报**（把活交给下级，或向上回报）：

```
report_author(subject="重构读路径缓存", body="...", to=["<session-id>"], task="read-path")
```

收件方驻留时立刻被唤醒（`steer`）。对方不在线不是错误：投递留在账本里，等它重新驻留时自动送达。但**它不会自己回来**——只有开启它的会话能用 `peer_wake` 把它叫回来（宿主重新加载该会话，账本随即把还欠着的投递送进去），而且只在账本还欠它投递时才有意义；其余情况要靠人或宿主把它恢复。所以派活时把范围切到一轮能交付，或者准备接手（`report_transfer` / `report_handover`）。

**回执 → 共写 → 结案**：

```
report_ack(report="R-0007", note="收到，开始做")          # 我收到了（事情仍在推进）
report_contribute(report="R-0007", body="结论：...")       # 以共写者身份追加一节，互不覆盖
report_send(report="R-0007", to=["<other-session>"])      # 主送更多代理（唤醒）
report_cc(report="R-0007", cc=["<watcher-session>"])      # 抄送，进入上下文但不唤醒
report_close(report="R-0007", note="已合并")               # 这件事结束了
```

**改错了用修正，不要重开一份**：`report_amend` 改主题/任务标签/正文，改动会被逐字记进传递路径（重开会丢掉原有的收件人与路径）。**收件人永远不能在这里改**——它们由跳流派生，唯一途径是再追加一跳。

需要纵览时用 `report_list({ task: "read-path" })` 把一次协作跨会话拉到一起；需要知道"还有谁在线、跟我什么关系"用 `peer_list`。

## 它是怎么组织的

**汇报是两层结构。**

- **front matter 是缩略**：主题、收发、抄送、共写者、跳数／其中读取数、最后一条因果动作、状态。它是唯一进入模型上下文的部分，所以长期协作的上下文开销有界。
- **正文留在账本里**，由 `report_read` 按需打开（超长时只返回头部与文件定位，模型用 `read` 分页取余下部分）。

**传递路径是权威的。** 每次操作都追加一跳（append-only JSONL）：

- `to` / `cc` / `authors` / `hops` / `reads` / `last` 都是从跳流派生的缓存，任何下一条跳都会重新校正它——账本不可能显示历史里没有的收件人；
- `hops` 计全部记录在案的事件，`reads` 是其中「打开过正文」的条数，`last` 取最近一条**因果**跳——「有人看了一眼」不算这份汇报动过。所以「它有多忙」看 `hops − reads`，「谁读过」留在传递路径里；
- **待投递集合同样派生**：被投递过且其后还没有到达的收件人即为待投递，所以这套审计轨迹本身就是那个缺失的持久 mailbox，天然跨重启存活；
- **会话或网络中断后先对账再继续**：用 `report_list` / `peer_list` 找到最后落下的跳、谁已交付、谁还在线，不要从头重做；重试前先确认动作是否已经落地。

**账本布局**（`$DSH_HOME/report-ledger/`）：

```
reports/R-0001.md            front matter 缩略 + 正文
reports/R-0001.route.jsonl   append-only 传递路径，一行一跳
```

选文件而不是私有数据库，是因为账本是一段协作的长期记忆：它必须可被人直接检查、手工修正，而 front matter 让"只读缩略"不必打开正文。设计动机、取舍与被否掉的替代方案见 [设计](docs/design.md)。

## 工具

| 工具 | 作用 |
|---|---|
| `report_author` | 开一份汇报，可同时主送 `to` 与抄送 `cc`，可用 `parent` 关联上溯汇报 |
| `report_contribute` | 以共同作者身份追加自己的一节（互不覆盖，各自记为独立跳） |
| `report_send` | 主送给更多代理（唤醒）：向上回报、向下派发 |
| `report_cc` | 抄送给更多代理（不唤醒）：让需要知情者持有副本 |
| `report_forward` | 转呈下去，或 `mode:"copy"` 作为参考副本分发 |
| `report_read` | 读缩略 + 完整传递路径（开头一行按动作计数）+ 正文（读取记为 `read`，**算进 `reads`、不算进 `hops`**；不推进 `updated`、不改变列表顺序） |
| `report_list` | 只列缩略，可按 `session`、`status`、`task`、`worktree` 过滤，用于纵览长期协作；行里带 `authors=N`——回执说明有人确认收到，`authors=1` 说明**没人真的写过东西** |
| `report_ack` | 回执，让发送方看到闭环 |
| `report_amend` | 修正：改缩略字段或更正正文，仅发起者/共写者可改，改动会被记录 |
| `report_close` | 结案：事情的终结，仅发起者/共写者可关；**从未有过贡献的汇报必须带 `note`**（交代做到了哪，或为什么没写），否则拒绝；同时**交还**它持有的工作区 |
| `report_lease` | 认领一个**已存在**的检出（仅工作区功能开启时暴露） |
| `report_release` | 交还检出占用，检出留在磁盘上原封不动（工作区关闭时调用会说明"本部署未启用工作区"） |
| `report_transfer` | 把一笔**尚未送达**的投递从欠它的会话转给另一个会话——义务仍然存在，只是换了人欠；**不记为送达** |
| `report_handover` | 退役/接管：枚举一个会话名下的一切，能搬的搬、能关的关，并落一份 `task: handover` 记录。它转移的是**账本资产**（未结汇报、检出占用、待送达），**不回收同伴名额** |

另有 `peer_list` / `peer_start` / `peer_wake` 三个同伴工具（发现、创建、唤醒；见 [同伴](docs/peers.md)），以及只由检出里的附加 bundle（`dev/bundle`，不发布）提供的 `dev_*` 三个（见 [开发者模式](docs/dev-agents.md)）。工具背后完整的语义——投递怎么落、修正与结案为什么这样设计、退役怎么转移资产——在 [设计](docs/design.md) 里。

## 状态、修正与交接

三个状态：`open` → `acked` → `closed`。

| 动作 | 谁能做 | 效果 |
|---|---|---|
| `report_ack` | 任何收件人（`to`/`cc`/共写者/发起者）；非收件人会被拒绝并列出可回执的人 | `open` → `acked`。**回执 = "我收到了"，事情仍在推进** |
| `report_close` | **仅发起者或共写者**；被拒绝时会点名该找谁关 | → `closed`。**结案 = "这件事结束了"** |
| 贡献 / 主送 / 抄送 / 转呈 / 修正 | 任何有权限者 | **自动重开**：先记 `reopened` 跳，再落下活动本身那一跳 |

**修正必须被记录，而不是抹掉**：缩略字段（`subject` / `task` / `artifacts`）是**当前状态**，直接替换并把改前改后逐字写进跳里；正文是**人说过的话**，默认追加一段 `### amendment`，`replace_body: true` 才真替换（跳里注明被重写过）。所以一个写错的标题被改正后，落盘是"缩略给当前真相、路径留历史"。

**`closed` 是状态，不是锁**：结案后又有人贡献/主送/抄送/转呈，说明这件事又活了，于是自动重开并记录——否则一份被过早关闭的汇报会静默吞掉后续工作。同理，**不需要单独的"重开"工具：活动本身就是重开**。

一个会话退场时，它名下的未结汇报、待送达的投递与占用的检出可以整体交给继任者（`report_handover`），退役因此是账本里的一个事实，而不是一段缺席。

## 配置

```yaml
- insert:
    - id: report-ledger
      name: 'dsh-report-ledger'
      config:
        announceToAgent: true    # 默认 true；false 则不向任何 agent 注入提示词段
        maxPeersPerAgent: 8      # 一个会话终身的同伴名额
        worktree:
          enabled: false         # 总开关；关闭时相关工具与参数都不出现
```

| 键 | 默认 | 说明 |
|---|---|---|
| `announceToAgent` | `true` | 是否注入两段 `systemPrompt`（账本协议 + 伙伴契约，见 [设计](docs/design.md)） |
| `maxPeersPerAgent` | `8` | `peer_start` 的终身额度；超限是明确的工具错误，不是静默拒绝 |
| `worktree.enabled` | `false` | 开启后一份汇报可拥有自己的 git 检出，见 [工作区](docs/worktree.md) |
| `worktree.root` | 仓库同级 `.dsh-worktrees/<仓库名>/` | 检出根目录 |
| `worktree.onClose` | `keep` | 结案处置：`keep` \| `remove-if-clean` |
| `worktree.maxActive` / `maxRetained` | `4` / `4` | 同时占用上限 / 结案后留在磁盘上的告警阈值（不自动删除） |
| `worktree.relativePaths` | `false` | 启用 `extensions.relativeWorktrees`，会把仓库格式版本抬到 1（旧版 git 直接拒绝访问） |

开启工作区之后，每份汇报可以有自己的 git 检出，但**独立的只有工作目录与索引**：`config`、`hooks`、对象库以及检出之外的一切仍然共享——装一个 hook，会影响所有检出的每一次提交。占用与清理的完整规则见 [工作区](docs/worktree.md)。

## 界面

web profile 里多两处：

- **会话头部的「汇报」标签页**：一条自上而下的时间线，把会话分叉与汇报按时间合并；状态芯片带数量、搜索框覆盖编号/主题/收件人/任务/检出，点一行就地展开传递路径、正文与仍在等待的收件人。
- **右侧栏的画布标签页**：一份汇报画成发起者帧里的一张卡，传递路径画成跨会话的线；点卡片跳到「汇报」标签页读它。交互规则与可见性约束见 [界面](docs/ui.md)，几何与实测见 [画布](docs/ui-canvas.md)。

## 已知限制

- **单进程假设。** 每个汇报的写操作——**包括 `report_read` 记跳与延迟投递泵**——都由进程内按汇报的互斥锁串行化。跨进程共享同一账本需要租约协议，这与 harness 自身延期的工作相同。工作区的**占用判定**另有一把按仓库为键的锁（跨报告抢同一支分支是单报告锁看不见的），但它同样只在本进程内有效。
- **正文并发覆盖。** 跳流 append-only 永不丢跳，**单进程内**整份重写的写入点都已进锁；**两个进程**同时改写同一份正文仍是后写者胜（`report_contribute` 用追加，规避了常见路径）。
- **同伴名额是终身的。** `maxPeersPerAgent`（默认 8）数的是**本会话启动过的不同同伴会话数**（`peers.jsonl` 的行先按 `startedBy` 过滤、再按 `sessionId` 去重，所以重复行不会多占名额），不区分同伴是否还在、是否首轮就死；**没有任何工具能回收名额**——`report_handover` 只搬账本资产，不碰名册行。回收是人工动作：备份后从 `$DSH_HOME/report-ledger/peers.jsonl` 删掉已结束同伴的行。
- **`fromName` 是会话标题**，即"会话名"而非"代理名"。
- **汇报页无法隐藏 composer。** `conversation.view` 的契约没有 composer 可见性维度，外壳在视图下方无条件渲染输入区，所以汇报页底部始终有输入框。视图侧唯一能整块替换它的是 `conversation.composer` 链（审批/提问面板用的同一机制），拿它隐藏属于偏用：该页会同时失去输入、发送、停止、模型/权限控件与队列/待办 dock。等上游给 view 定义提供正式开关后再做。

工作区相关的限制（默认关闭，未开启时都不适用）见 [工作区](docs/worktree.md)。审计中已确认、但有意暂缓的五项（脚本清理、10k 深链、画布 emoji/帧 hover、视图焦点/无声点击/pane、publish shasum 断言）见 [已知未修问题](docs/known-issues.md)。

## 文档

正文按读者分开。只想用起来，上面这些就够了；下面这些是「要改它」或「想知道为什么」时才需要的。

| 文档 | 什么时候读 |
|---|---|
| [设计](docs/design.md) | 账本布局、读路径的性能模型、修正与生命周期的理由、退役交接、提示词协议 |
| [工作区](docs/worktree.md) | 要用 git 检出隔离，或想知道"独立"到底独立了什么 |
| [界面](docs/ui.md) | 时间线标签页的交互规则、数据通路、HTTP 守卫与信任假设 |
| [画布](docs/ui-canvas.md) | 卡片图的几何、为什么一个图库都不引、每项决定的实测数字 |
| [同伴](docs/peers.md) | `peer_start` 开出来的到底是什么、它落在哪个工作区分组 |
| [工程约定](docs/pitfalls.md) | 改这个仓库之前：20 条踩过的坑，每一条都对应一次真实故障 |
| [开发、构建与验证](docs/dev-build.md) | 构建、测试分层、HMR 开发回路、隔离 profile |
| [开发者模式](docs/dev-agents.md) | 开发期陪跑代理：名单、增减、退役、归档 |
| [发布](docs/publishing.md) | 维护者：产物清单、可信发布、CI 分工、Gitee 镜像 |
| [已知未修问题](docs/known-issues.md) | 审计确认、但有意暂缓的五项：证据报告、影响、建议修法、状态 |

## 开发

```sh
pnpm build        # 产出 lib/index.js（宿主半）与 lib/client.js（浏览器半）
pnpm test         # 十六套确定性检查，1117 项断言（不需要 DSH，不碰真实账本）
pnpm check        # 完整本地门禁：typecheck + test + test:tools
```

开发与测试需要 **Node ≥ 22.18**（脚本直接跑 `.ts`，依赖 type stripping；构建依赖链也声明 `^22.18.0 || >=24.11.0`）。`lib/` 随源码提交，所以 clone 下来不用构建也能跑。开发回路、测试为什么分成 `test` 与 `test:tools`、CI 为什么只跑前者，都在 [开发、构建与验证](docs/dev-build.md)。

## 许可

MIT。第三方声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

