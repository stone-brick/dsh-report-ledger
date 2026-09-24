# dsh-report-ledger

一个 DSH 插件：把「**汇报**」做成代理之间的一等交互原语，并为长期协作留下可追溯的账本。

## 安装

```sh
dsh plugin --profile web add dsh-report-ledger
```

这条命令把包装进该 profile 的 `node_modules`；因为包声明了 `dsh.bundle.patch`，
`dsh plugin` 会**自动**把 `dsh-report-ledger` 追加进 profile 的 `dsh.profile.bundles`，
不需要手改任何配置文件。装完**重启 profile**（`dsh web`）即可生效。

不启动也能验证装上了：

```sh
dsh --profile web --dump-config     # 配置树里应出现 report-ledger 这一行
```

卸载走同一条通道，依赖与该配置层会一起移除：

```sh
dsh plugin --profile web remove dsh-report-ledger
```

### 装完你会得到什么

- **宿主半**（任何 profile）：十个 `report_*` 工具 + `peer_list` / `peer_start`、
  两段 `systemPrompt` 段，以及 web profile 下的两个只读 HTTP 端点；
- **浏览器半**（仅 web profile）：会话头部多一个「汇报」标签页 —— 时间线、状态芯片、
  搜索、线程跳转与就地展开的传递路径。

### 兼容性、权限与数据

- **DSH 0.1.5-rc.3 实测可用**（构建产物与该版本的平台模块表对齐）。宿主半的运行时
  外部依赖只有一个：`@deepseek-ai/dsh-tools`，由 profile 提供；浏览器半只 require
  `react` 与 `react/jsx-runtime`，其余全部内联。宿主半在 headless profile 里同样可用
  （没有 web server 时只是少了那两个端点）。
- **账本是本机文件**：`$DSH_HOME/report-ledger/`（可用 `DSH_REPORT_LEDGER_ROOT`
  覆盖），不上传任何地方。
- **浏览器读数据走两个 GET 路由**，注册在 DSH 的 web server 上，守卫仅放行 loopback
  对端与 loopback `Host`；细节与信任假设见下文「守卫与信任假设」。
- **同伴工具会新建根会话**（在你自己的工作目录下），这是本插件唯一会新增活代理的能力，
  每次创建都记进名册日志，并受 `maxPeersPerAgent`（默认 8）约束。

### English quick start

```sh
dsh plugin --profile web add dsh-report-ledger   # install + register the bundle layer
dsh --profile web --dump-config                  # verify: a `report-ledger` row appears
dsh web                                          # restart the profile to load it
```

Tested against DSH 0.1.5-rc.3. The ledger is plain files under
`$DSH_HOME/report-ledger/` and nothing leaves the machine. The host half works in
any profile; the web profile additionally gets a **Reports** tab in the GUI.

> 下面是**用户安装**。本仓库自身的开发装法（junction + `hmr` 热重载）见末尾
> 「开发与验证」。

## 为什么需要它

DSH 原本的代理间通信是**相邻 Agent 的 steer 投递**（`ctx.subagents.sendMessage`），它明确承认这些缺口：

- 只能投给**直接子代理**或**直接父代理**，兄弟、祖辈、无关同伴一律 `UNAUTHORIZED`；
- **没有持久 mailbox**：父代理不在线时消息被拒绝，而不是"先接受、后送达"；
- **没有抄送、没有优先级、没有回执、没有线程、更没有传递路径记录**（`AgentMessageSource` 只带一个 `senderSessionId`）。

本插件补上的是最后那一块地基。它不新造会话事件类型（那会让会话日志在重载时不可读，见下），而是复用 harness 已有的白名单词汇与公开 API。

## 核心设计

**汇报是两层结构。**

- **front matter 是缩略**：主题、收发、抄送、共写者、跳数、最后跳。它是唯一进入模型上下文的部分，因此长期协作的上下文开销是有界的。
- **正文留在账本里**，由 `report_read` 按需打开（超长时只返回头部与文件定位，模型用 `read` 分页取余下部分）。

**传递路径是权威的。** 每次操作都追加一跳（append-only JSONL），因此：

- `to` / `cc` / `authors` / `hops` / `last` 都是**从跳流派生**的缓存，任何下一条跳都会重新校正它——账本不可能显示历史里没有的收件人；
- **待投递集合也由跳流派生**：被投递过（`sent`/`cc`/`forwarded`/`copied`）但没有到达（`delivered`）的收件人即为待投递。**审计轨迹本身就是那个缺失的持久 mailbox**，所以它天然跨重启存活，且不可能与历史不一致。

**投递走公开的 Agent 入口。** 模型工具受"精确相邻"约束，但 `Agent.steer/inject` 只接收一条消息、不做授权检查，而任何活 Agent 都可由 `ctx.agents.get(id)` 取到。因此：

- 主送（`to`）用 `steer`——空闲目标会因此开启一个回合；
- 抄送（`cc`）用 `inject`——进入上下文但不唤醒任何人；
- **非驻留收件人不会被拒绝**，而是留在待投递集合里，等 `agent/created` 事件到来时自动送达。

## 账本布局

根目录 `$DSH_HOME/report-ledger/`（可用 `DSH_REPORT_LEDGER_ROOT` 显式覆盖，便于部署迁移与隔离测试）：

```
reports/R-0001.md            front matter 缩略 + 正文
reports/R-0001.route.jsonl   append-only 传递路径，一行一跳
```

选择文件而非私有数据库，是因为账本是一段协作的长期记忆：它必须可被人直接检查、手工修正（写错主题、补一句 hop 说明都不需要迁移），而 front matter 让"只读缩略"不必打开正文。

## 工具

| 工具 | 作用 |
|---|---|
| `report_author` | 开一份汇报，可同时主送 `to` 与抄送 `cc`，可用 `parent` 关联上溯汇报 |
| `report_contribute` | 以共同作者身份追加自己的一节（互不覆盖，各自记为独立跳） |
| `report_send` | 主送给更多代理（唤醒）：向上回报、向下派发 |
| `report_cc` | 抄送给更多代理（不唤醒）：让需要知情者持有副本 |
| `report_forward` | 转呈下去，或 `mode:"copy"` 作为参考副本分发 |
| `report_read` | 读缩略 + 完整传递路径 + 正文（读取本身也记一跳） |
| `report_list` | 只列缩略，可按 `session`、`status`、`task` 过滤，用于纵览长期协作 |
| `report_ack` | 回执，让发送方看到闭环 |
| `report_amend` | 修正：改缩略字段或更正正文，仅发起者/共写者可改，改动会被记录 |
| `report_close` | 结案：事情的终结，仅发起者/共写者可关 |

## 修正：记录，而不是抹掉

一个 agent 写错了主题时，原本只有两个坏选择：重开一份新汇报（丢掉原有传递路径与收件人），或者让错误留着。而人手改文件又能改——**这个不对称是实现漏洞，不是设计取舍**。

难点在于：账本的价值来自**历史只增不改**；如果 agent 能静默重写记录，账本就不再可信。所以 `report_amend` 的规则是**修正必须被记录**：

| 对象 | 语义 | 理由 |
|---|---|---|
| 缩略字段（`subject` / `task` / `artifacts`） | **替换**，跳里逐字记录改前改后的值 | 它们是**当前状态**，不是历史；而"从什么改成了什么"正是审计要的 |
| 正文 | 默认**追加**一段 `### amendment` | 正文记录的是**人说过的话**，改写别人的话就不是记录了 |
| 正文（`replace_body: true`） | 真替换，且跳里注明"body replaced" | 有时确实需要重写；那就**让后人知道被重写过、被谁重写**，而不是被误导 |

**收件人与共写者永远不能在这里改**——它们由跳流派生，唯一的修改途径就是再追加一跳。`task` 传空串可以**清除**标签（避免出现"空标签"与"无标签"两种含义）。

修正属于活动，所以**给已结案的汇报做修正会自动重开它**并记录 `reopened`。

实测效果：一个写了错别字的主题被改正后，落盘是

```
front matter:  subject: "the corrected title"          ← 当前真相
传递路径:      amended  # subject "teh wrong speling…" -> "the corrected title"   ← 历史
```

## 汇报的生命周期

三个状态：`open` → `acked` → `closed`。

| 动作 | 谁能做 | 效果 |
|---|---|---|
| `report_ack` | 任何收件人 | 记一跳；`open` → `acked`。**回执 = "我收到了"** |
| `report_close` | **仅发起者或共写者** | 记一跳；→ `closed`。**结案 = "这件事结束了"** |
| 贡献 / 主送 / 抄送 / 转呈 | 任何有权限者 | **自动重开**：先记 `reopened` 跳，`closed` → `open`，随后才落下活动本身那一跳 |

两个刻意的设计决定：

**1. 结案是拥有者的事，不是读者的事。** 只有发起者或共写者能关闭；被拒绝时错误信息会**报出该找谁关**（列出作者），而不是只说一句"不行"——这样代理知道下一步该做什么。`from` 与 `authors` 都算拥有者，因为手改过的账本可能缺对应跳，而拒绝明显的主人会让汇报永远悬着。

**2. `closed` 是状态，不是锁。** 如果有人在关闭后又贡献／主送／抄送／转呈，那这件事显然又活了，于是自动重开并记录 `reopened` 跳。否则一份被过早关闭的汇报会**静默吞掉后续工作**——对一份以可追溯为全部意义的账本来说，这是最糟的失败模式。

所以**不需要单独的"重开"工具：活动本身就是重开**。回执与结案也是刻意不合并的两件事：回执表示"我收到了"，事情仍在推进；结案表示"这件事结束了"。对已关闭的汇报回执只记跳，**既不重开也不降级为 acked**。

状态机每一次转换都落在 append-only 路径里：

```
authored → closed(note) → reopened → contributed
```

未来读者看到的是过程，而不只是当前终态。

## 提示词：协议与伙伴契约

插件注入**两段** `systemPrompt.section`，这个拆分是有意的：

| 段 | 名字 / 顺序 | 求值方式 | 理由 |
|---|---|---|---|
| 协议 | `plugin:report-ledger` / 200 | 静态字符串 | 对所有 agent **逐字节相同**，因此是各 scope 里稳定的提示词前缀（KV cache 友好） |
| 伙伴契约 | `plugin:report-ledger:partnership` / 201 | 按 assembly 求值的函数 | 契约要对两种读者说不同的话 |

**协议段**说明账本是什么、八个工具各做什么，以及两条会改变行为的约定：收件方不在线不是错误（投递会被持有）；路径由账本自动记录，但每一步都必须经工具完成。

**伙伴契约段**分两种读者：

- **对所有 agent**：明确否定"工具"框架——*其他代理不是「做完一项任务就可以终止的工具」，而是长期相处的同伴*；一次任务的结束是这段关系的逗号而不是句号；交接用汇报而非口信；收到汇报要回执；兄弟代理之间也可以互相抄送。
- **仅对被委派的子代理**：你的会话是持久的、不是一次性函数调用；**主动汇报，不要默默结束**；**你的父会话 id 是 X，可直接主送到它**；权限范围启动即固定，需要越界时把限制写进汇报而不是反复重试。

**角色判定是同步且精确的**，来自 `Session.header`（`origin === 'subagent'` 或 `delegationDepth > 0`）——持久、首次组装时就在，无需查询、无需缓存、无异步竞态。子代理的父会话 id 也由此取得并**直接内联进提示词**，因为不给出这个地址，"向上汇报"就只是一句无法执行的口号。

## 时间线标签页

`conversation.view` 槽位里注册一个**新 id** 的视图（不覆盖已发布的 Chat / Trajectory），浏览器把 list 型槽位投影成会话头部的标签页。

页面渲染**一条自上而下的时间线**，把两类事件按时间合并：

- **会话分叉**：子树里每个会话一行，按深度缩进，标注「子代理 / 在线」；
- **汇报出现**：每份汇报一张缩略卡（状态、主题、收发、抄送、跳数、最后动作），点击就地展开**完整传递路径 + 正文 + 仍在等待送达的收件人**。

### 筛选与搜索

汇报多起来之后时间线需要收窄，所以工具栏提供：

- **状态芯片**：`全部 / 进行中 / 已回执 / 已结案`，**标签里带数量**。数量取自完整载荷而非筛选后的行——一个自己会变的标签会让你看不出到底排除了多少。
- **搜索框**：匹配汇报编号、主题、发起者 id 与名称、主送、抄送、共写者、任务标签、产物路径，以及**会话标题与编号**。
- **清除**按钮（仅在筛选生效时出现），状态选择记在 `localStorage`，搜索文字刻意不持久化。

两条刻意的规则：

**状态筛选只作用于汇报；搜索作用于每一行。** 会话没有生命周期状态，所以状态芯片不会隐藏会话——时间线的骨架始终在，缩进也就始终有意义（汇报的 depth 来自它的发起会话，与会话行是否被渲染无关）。

**空状态分两种。** 「这个会话树下还没有汇报」与「没有符合当前筛选的汇报」是不同的话，混用会让人以为账本坏了。

行构建与筛选逻辑都在 `src/client/timeline-model.ts` —— 一个**不依赖 React 与 DOM 的纯模块**。这样"哪些行出现、搜索匹配什么、芯片怎么计数"这些用户直接感受到的决定能用确定性测试钉住，而不必靠看浏览器；视图只负责渲染。

### 线程、时间基准与阅读上限

- **线程跳转**：详情面板显示该汇报的**上溯**（`parent`）与**下递**（`children`），点任意编号即跳到那一份。链接可以指向**当前树之外**的汇报（它属于另一条线），此时详情仍会打开——`report` 端点按账本范围而非子树范围查询——并明确提示"不在当前会话树的列表里"。
- **时间基准**：一键在「按创建 / 按最近活动」之间切换。会话始终按创建时间；切换只影响汇报在时间轴上的落点。
- **任务标签即分组**：卡片上的 `task` 标签**可点击**——点它就把搜索框设为该标签，于是同一次协作（可能横跨多条会话树）被拉到一起。这是刻意的实现选择：**复用已有的搜索，不引入第二套筛选状态**；`report_list({task})` 在工具侧提供同一维度的分组，并把该任务的 open/acked/closed 统计一并返回。
- **正文明限**：面板只显示正文开头（>4000 字时截断并提示），与 `report_read` 给模型的上限**保持一致**——让人类视图与模型视图被同样地约束，双方都不会对对方看到的范围感到意外。
- **两种"看不见"分得很清**：汇报**不在树里** vs 汇报**被当前筛选隐藏**——两组措辞不同。把后者说成"可能属于另一条线"是错的，所以两种情形各有各的话。

### 数据通路

浏览器一个请求取全部数据：

| 端点 | 返回 |
|---|---|
| `GET /api/report-ledger/timeline?root=<sessionId>` | 该会话的**递归子树**（DFS 前序、兄弟按创建时间）+ 子树相关的汇报缩略 |
| `GET /api/report-ledger/report?id=<R-0001>` | 单份汇报的缩略 + 完整路径 + 待送达集合 + 正文 |

子树由 `ctx.sessionQuery.listSessions()` 的 `parentSession` 链走出，标题只对**子树内存活的会话**查询（长寿命部署里语料远大于一次协作，而标题是装饰、树不是）。汇报按"子树任一成员参与过它的路径"过滤（发起、主送、抄送、共写），因此这是**协作账本**而不是全库倾倒。

为什么不用 typert 生成的 Remote：那需要构建期代码生成。第三方插件的通行做法是自建同源、仅限 loopback 的 JSON 通道，本插件照此实现。**两半共用 `src/shared/wire.ts` 的类型**——该文件只有 `export type`，会被完全擦除，所以浏览器 bundle 不可能内联宿主代码（构建后已核验：外部依赖仅 `react` 与 `react/jsx-runtime`，node 内置模块与 yaml 均为 0 命中）。

### 守卫与信任假设

两个端点都是 GET、只读、无写入面（所有变更仍只走模型工具，那是唯一会记录跳的路径）。守卫照实复刻部署中第三方插件的做法：**TCP 对端必须是 loopback** + **`Host` 必须解析为自身且是 loopback 主机名** + **浏览器同源标记一致**。第二项挡掉 DNS rebinding 拼法（`localhost.attacker.tld`）与非规范权威（默认端口 `127.0.0.1:80` 解析后会消失，故不相等）。

⚠️ **信任假设要说清楚**：实测发现**已注册的 exact 路由先于鉴权匹配**——未注册路径返回 401，而注册过的路由直接 200，不要求会话 cookie。所以守卫是这些端点**唯一**的防护，其信任边界是"本机进程"，与账本文件本身可被本机读取是同一信任级。反向代理部署需要守卫的共享令牌变体；只服务直接 loopback 是安全的默认，失败模式是"读被拒绝"而非"读被泄露"。

## 同伴：代理自主开启会话

两个工具：

| 工具 | 作用 |
|---|---|
| `peer_list` | 列出你能对话的代理及其与你的关系（上级 / 下属 / 兄弟 / 你开启的同伴 / 账本里有往来的联系人），并标注谁此刻在线 |
| `peer_start` | 开启一个**独立同伴会话**，并把任务作为一份**汇报**交给它 |

### 同伴是独立根会话，不是下属

这是本阶段最重要的设计判断。`peer_start` 创建的会话**没有 `parentSession`、没有 `origin`、`delegationDepth` 为 0**——它是一个根会话。这样它才配得上"同伴"：拥有自己的生命周期与预设、不占用任何委派深度预算、出现在工作区会话列表里、**并且比开启它的那一轮活得更久**。

代价是血缘无法表达这段关系（`parentSession` 是空的），所以**名册日志**（`$DSH_HOME/report-ledger/peers.jsonl`，append-only）记录它：谁开启了谁、何时、什么名字、继承的工作目录。这条记录同时是**授权凭证**。

### 授权规则

DSH 的委派层拒绝非相邻通信，源码原话是"其他代理、祖先、teams、workflows、hosts 保持拒绝，**直到有一个显式的授权协议有生产消费者**"。本插件就是那个消费者，它实现的规则故意收得很窄：

**血缘授予通道，开启过的会话授予通道——而"仅仅在账本里有往来"不单独授予通道。**

最后一条是刻意的：正因为"通过账本联系对方"是建立接触的方式，把接触本身当作授权就形成了循环——先有鸡还是先有蛋。所以**主动伸手（`report_send`/`report_cc`）永远允许**（它会产生那条记录），而**直接通道只来自血缘或"我开启了它"**。

创建会话是本插件唯一会**新增活代理**的能力（其余都只是记录），所以它的授权故事是叠加的：工具可见性（DSH 自己认定的唯一真实闸门）+ `maxPeersPerAgent` 预算（默认 8，超限是明确的工具错误而非静默拒绝）+ **继承调用者自己的工作目录**（无法被指向无关目录树）+ 每次创建都在名册里留痕。

### 创建与对话是分开的

`peer_start` 只负责创建与记录；**交任务由调用者用一份汇报完成**（工具层组合两者）。于是：任务天然进了账本、同伴被投递唤醒、路径被记录，而同伴之后对同一份汇报的 `report_contribute` 就让它成为双向线程。这正是"用汇报做交互的关键"——S4 **没有**引入第二条轻量消息通道，因为那会产生一条不受审计的旁路，正好抵消 S1 的全部价值。

### 一个必须记住的 API 陷阱

`AgentHandle.dispose()` 会"停止循环、注销代理、**并从 store 里移除该会话**"。所以对"必须比这一轮活得更久的同伴"**绝不能**持有或自动释放 handle——本插件创建后即丢弃 handle，同伴通过 `ctx.agents` 保持可寻址。自动 dispose 会删掉同伴的会话。

### 一处已知限制

在**一次性 headless 运行**里，开启的同伴不会真的执行任务：它不是子代理，因此不在运行器 drain 的范围内，父任务一结算进程就退出了。任务本身不丢——投递已作为 `agent/inbox/spliced` 进入同伴的会话日志，会话恢复时它就在历史里。在长期运行的 web profile 中同伴会正常处理收件箱。

## 工程约定（踩过的坑）

- **绝不新增自定义会话事件类型。** `SessionEventMap` 看起来可扩展，但持久化读取路径 `assertEventsSupported` 只在 `KNOWN_SESSION_EVENT_TYPES` 命中或事件带 `ignorable: true` 时放行，而 `Session.append` 从不设置 `ignorable`；白名单是从仓库内成员生成的字面量。追加新类型会让**该会话日志在重载时不可读**。因此账本走文件，模型可见的摘要走 `source: {kind:'plugin', plugin:'report-ledger', form:'relay'}`（既有已知形状）。
- **官方包必须保持 external。** 内联 `dsh-tools` 会复制服务注册表、破坏实例同一性。构建只内联真正的第三方依赖（`yaml`）。
- **运行时解析需要 `node_modules/@deepseek-ai` junction。** Node 按 **realpath** 解析模块：插件包经 `~/.dsh/profiles/node_modules/dsh-report-ledger` junction 指向本仓库后，真实路径仍在工作区，因此 `import '@deepseek-ai/dsh-tools'` 只会从本仓库向上查找。工作区里的 `node_modules/@deepseek-ai` → profile 官方包层的 junction 正是为此，与生态里 `link-profile.mjs` 的做法一致。**`pnpm install` 可能清掉它，重装后需重建。**
- **工具参数规范中不能写 `required: false`。** `defineTool` 的 `ParameterSchemaSpec` 只接受 `required: true` 或**整个省略**，写 `false` 会在加载时报 `required must be true when present`。可选参数就是不带 `required` 的字段。
- **投递与账本分层。** `deliver()` 只做传输、绝不碰账本；到达跳由 `ReportService` 统一写入，保证审计的写者唯一。
- **可选服务用 `ctx.inject`，不要用 `ctx.get`——两者对"可能后到的服务"并不等价。** `ctx.get` 读的是**此刻**的注册表，provider 还没激活就返回 `undefined`；服务注入回调则在服务**真正出现时**运行。本项目在 web profile 上因此真实踩坑：`webserver` 行 inject 了 `webStartup`，会晚于我们的行激活，于是路由**被静默跳过**，所有请求落到 `/api` 鉴权栅栏上得到 401，而我们的 handler 从未被执行。之所以不用声明式 `inject: ['webServer']`（那样必然排在后面）：headless profile 根本没有 web server，硬依赖会让整个插件在那里永远等待、什么也不贡献。`ctx.inject(['webServer'], (scoped) => …)` 同时满足两者——可选，且与到达顺序解耦。
- **`ctx.get('webServer')` 的失败是静默的**，所以凡是通过 `ctx.get` 拿可选服务再"可用则注册"的地方，都必须有一个能在真实 profile 里被观测到的验证手段，否则这类 bug 只会在浏览器里表现为一个空标签页。本项目靠独立 web profile 的 HTTP 断言抓到它。
- **每个副作用都必须在 `apply` 的 `ctx.effect` 里注册。** 在**工具执行体内部**直接调用 `ctx.webServer.register(...)` 并把 disposer 存进闭包，是一个真实的陷阱：该副作用不归插件 fiber 所有，`cordis_stop` 与 `cordis_undefine` 都无法回收它，只能靠重启进程清除（本项目在诊断探针上踩到过一次，正式插件的路由因此写在 `ctx.effect` 内）。
- **手改账本不能让记录消失。** YAML 的严格默认会把**重复键**判为错误，而重复键正是手改时最容易出现的情况（追加一个已存在的字段）。那会让整份文档解析失败、汇报从账本里静默消失。所以读取路径用 `uniqueKeys: false`（后者胜），而"无 front matter""未闭合块"这类真正无法解释的输入仍然拒绝。丢失记录远比一个歧义键被可预测地解决严重。
- **锚在列表项上的面板，必须保证那一项存在。** 详情面板原本渲染在汇报**行内部**，于是当目标不在（筛选后的）列表里时，面板无处渲染、连同里面的提示一起消失。修法不是把面板抽出来，而是**为被打开的汇报补一行合成行**——这同时修掉了另一个我还没发现的同类缺陷：**在详情打开时改变筛选，面板原本也会消失**。
- **接在早退块里的东西可能要不到。** 上面那个"不在当前树里"的提示原本嵌在线程块的 IIFE 内，而该块在汇报没有上溯/下递时会提前 `return null`——偏偏"树外汇报没有线程链接"正是常见情形。条件渲染里的早退会静默吞掉同一块里其它独立的内容。

## 开发与验证

```sh
pnpm build        # 产出 lib/index.js（host 半）与 lib/client.js（client 半）
pnpm test         # 五套确定性检查共 255 项断言：账本内核、生命周期与任务分组 56 + 提示词角色分流 42
                  # + 时间线装配与路由守卫 59 + 同伴名册与创建 42 + 时间线模型（筛选/线程/正文）56
                  #（不需要 DSH，不触碰真实账本，不启动服务器）
pnpm typecheck    # 对部署中的 harness 类型做全量类型检查
```

**安装到 profile**（本仓库已这么装好）：包经 junction 出现在 `~/.dsh/profiles/node_modules/dsh-report-ledger`，并在 profile 的 `cordis.patch.yml` 中有一行：

```yaml
- insert:
    - id: report-ledger
      name: 'dsh-report-ledger'
      config:
        announceToAgent: true
```

**开发回路：**

- **宿主半：保存即生效。** web profile 的 `cordis.patch.yml` 里把 `dsh-base` 默认禁用的 `hmr` 行打开，并把 `root` 扩到本仓库的 `lib/`（因为插件经 junction 挂载、真实路径在 profile 之外）。配合 `pnpm watch`，回路是：**保存 → tsdown 重建（约 0.2s）→ HMR 就地重载该插件条目**。进程不重启、端口不断、正在进行的会话不中断。
  - 已实测确认：改 `lib/index.js` 后新代码即刻生效，**且宿主进程 PID 不变**。本插件被判定为"直接变更"走局部重载，不会触发 `loader.exit()`（那是 **CLI 入口静态依赖树**里文件改动才会走的路径；插件由 Loader 动态 `import()` 加载，不属于那棵树）。
  - 重载是安全的：插件的持久状态全在磁盘账本上，内存里只有一个互斥锁表，重载不丢数据。
  - ⚠️ **启用 `hmr` 需要一次重启才生效。** 通过 `patchReload: live` 在运行中启用只会"启用行"而**不应用 `config`**——实测服务自己报 `root: []`（空监视）与 schema 默认 `debounce: 100`。组合树本身是对的（`dsh --profile web --dump-config` 可见完整 config），只是生效时机问题。
- **客户端半：重建 + 页面刷新。** HMR 不覆盖 `lib/client.js`（由 `dsh-client-modules` 提供）。"无需刷新自动重载"未验证——不确定 `dsh-client-hmr` 的监视根是否覆盖 profile 之外的包。
- **`pnpm watch` 的生命周期**：它是个前台常驻进程。由代理会话启动的那种只在该会话存活期间有效；要长期常驻请在自己的终端里跑。
- 离线/批量集成验证仍可走独立的 headless profile（`~/.dsh/profiles/reports-dev/`），它一次性跑任务、不干扰正在服务的 GUI：
  ```sh
  $env:DSH_REPORT_LEDGER_ROOT = "$env:TEMP\report-ledger-it"
  dsh --profile reports-dev "<task>"
  ```
  该 profile 的补丁里同样把 `hmr` 打开并把 `root` 扩到 `lib/`。
- **验证浏览器侧能力时，在隔离的 DSH_HOME 里另起一个 web profile**，不要动正在服务的那个：DSH 明确声明两个 harness 进程不协调共享同一持久化 store，共用会威胁正在运行的实例。
  ```sh
  # 只把包解析层 junction 进去，会话/账本留在临时 home 里
  $iso = "$env:TEMP\dsh-web-test"
  mkdir "$iso\profiles"
  cmd /c mklink /J "$iso\profiles\node_modules" "$env:USERPROFILE\.dsh\profiles\node_modules"
  # 在该 home 内建一个 bundles = [dsh-base, dsh-web-app] + 本插件行的 profile
  $env:DSH_HOME = $iso
  dsh --profile <你的-web-profile> --port 3099 --no-open
  ```
  启动会打印一个带 `?token=` 的 URL —— **web profile 用 URL token 鉴权**，带上它就能让自动化浏览器登录这个隔离实例，从而验证真实渲染。用完**先删 junction 再递归删除**临时 home，否则删除会顺着 junction 冲进真实 profile 层。
  另外：**已注册的 exact 路由先于 `/api` 鉴权栅栏匹配**，所以自查端点时可以不带 token 直接 curl。
- 补丁语法：插新行用 `- insert:`；**按 id 修改已有行必须写成顶层 `- id:`**，把已有行放进 `insert` 会新建一条同 id 的行并报 `duplicate loader entry id`。

### 发布（维护者）

分发形态是**预构建的 bundle**：`lib/` 在发布前构建好，用户安装时不跑任何构建脚本，因此不需要 `allowBuilds` 授权。

```sh
pnpm check          # 类型检查 + 五套确定性检查
pnpm pack           # 先出 tarball 核对产物（prepare 会顺带构建）
npm publish         # ⚠ 本机 registry 若是镜像站，必须显式 --registry=https://registry.npmjs.org
```

`pnpm pack` 的产物清单**缺一项的表现都是「装上了不生效」而不是报错**，逐条核对：

| 检查项 | 本包取值 |
|---|---|
| `main` / `exports` 指向构建产物而非 `src/` | `lib/index.js` / `lib/client.js` |
| `files` 含入口**与 `cordis.patch.yml`** | `["lib", "cordis.patch.yml", "THIRD-PARTY-NOTICES.md"]` |
| `dsh.bundle.patch` 指向该 patch | `./cordis.patch.yml` |
| `version` 已递增 | npm 不允许覆盖已发布版本 |

发布后**在干净环境里验证**（本仓库已按此验证过 0.1.0 的 tarball）：

```sh
dsh plugin --profile demo add dsh-report-ledger   # 空 DSH_HOME 里
dsh --profile demo --dump-config                  # 应出现 `# == dsh-report-ledger` 这一层
```

`dsh plugin add` 会因包声明了 `dsh.bundle` 而**自动**把包名追加进 `dsh.profile.bundles`，用户不需要手改配置。
另外注意 **git 安装与 npm 安装不是一回事**：`add github:<你>/dsh-report-ledger#<sha>` 拉到的是源码，
要靠仓库里的 `prepare` 构建，且 pnpm ≥10 需要用户放行 `allowBuilds`——所以**对外推荐 npm 安装**。

## 已知限制

- **单进程假设。** 每个汇报的写操作由进程内互斥锁串行化。跨进程共享同一账本需要租约协议——这与 harness 自身延期的工作相同。
- **正文并发覆盖。** 跳流 append-only 永不丢跳，但两个人同时改写同一份正文是后写者胜（`report_contribute` 用追加，规避了常见路径）。
- `fromName` 取自会话标题，是"会话名"而非"代理名"。
