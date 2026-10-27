# 已知未修问题

这份文件是 **0.2.4 发布前审计中确认、且有意识地暂缓** 的问题清单。它不是 bug 总表，也不是路线图：只收那些「证据已经成立、但修复成本/收益或依赖关系还不适合当时动手」的项。

- **最后复核**：0.2.4 发布后、`main` 上的 `7b4cb2f`（含 release/handover 孤儿警告）。
- **证据报告**：审计报告在账本 `$DSH_HOME/report-ledger/reports/R-xxxx.md` 里；这份文档是仓库内、可版本化的摘要。报告 ID 保留，方便回看原始证据与探针。
- **修一项时**：补测试 → 更新本文件的状态 → 在 `task:deferred-s3` 的跟踪报告里落一笔。

## 一览

| # | 问题 | 状态 |
|---|---|---|
| 1 | 测试脚本的 scratch 目录没有统一的 `try/finally` | 未修；正常路径清理有效 |
| 2 | 10k 深链递归导致 `RangeError` | 未修；低频 |
| 3 | 画布 emoji 折行劈代理对、帧 hover 按 index | 未修 |
| 4 | 视图跳转后焦点丢失、点击无声、`pane` 死代码 | 未修；V9 已单独修 |
| 5 | publish 只确认版本可见，不校验 shasum/provenance | 未修 |

## 1. 测试脚本的 scratch 目录没有统一的 `try/finally`

- **证据**：`R-0022` S3-10（当时点名五处）；`R-0051` 复核确认仍在；`R-0059`/`R-0060` 列为 deferred。
- **当前结构**：脚本在顶部 `mkdtemp`，清理在文件末尾；审计当时是五个脚本，现在使用 `mkdtemp` 的脚本已增至十个（`allocate-check`、`handover-check`、`lease-check`、`maintenance-check`、`read-path-check`、`roster-check`、`smoke`、`workspace-check`、`worktree-check`、`worktree-tools-check`）。个别脚本有局部 `finally`，但都不是包住整个夹具阶段。
- **影响**：正常结束清理有效；夹具阶段失败（无 git、权限、`spawn` 失败）会在 `%TEMP%` 留下目录。不影响产品正确性，只污染测试机。
- **建议修法**：`mkdtemp` 之后立刻进入 `try { ... } finally { rm(scratch, { recursive: true, force: true }) }`；或抽一个 `withScratch(async (dir) => ...)`，避免十个脚本各加一层缩进。清理失败不应吞掉原错误。
- **验证**：模拟 `git` 不可用/夹具失败，断言临时目录仍被删除；正常路径再跑一次确认无残留。
- **状态**：未修。审计判断收益低、diff 大，当时按分类未做。

## 2. 10k 深链递归导致 `RangeError`

- **证据**：`R-0023` #10；`R-0052` 量化（1000/5000 层通过，**10000 层 `RangeError: Maximum call stack size exceeded`**，被 HTTP 守卫收敛成 500）；`R-0056` 旧 #10。
- **当前代码**：`src/report/timeline.ts` 的 `walk` 递归（父子链 DFS）。
- **影响**：病态深链（不是正常协作规模）会让整个时间线请求返回 500，而不是「截断后的树」。低频，但失败形态不体面。
- **建议修法**：改成显式栈的迭代 DFS；或加 `MAX_DEPTH`（例如 512）并在 payload 里标 `truncated`，让前端知道少了一层而不是整棵树消失。后者更小，但要多一个协议字段。
- **验证**：`timeline-check` 加一条 10k 深链「不崩，或明确截断」的断言；同时保留 1000/5000 的正常路径。
- **状态**：未修。结构上属于「低概率、改起来会动核心遍历」的项。

## 3. 画布 emoji 折行与帧 hover 按 index

- **证据**：`R-0054` S3 #9（`foldText`/`elide` 按 UTF-16 码元切，emoji/ZWJ 被拆成孤立代理项）、S3 #4（帧 hover 按 index，布局变化后漂移）；`R-0056` 高价值 S3；`R-0059` deferred。
- **当前代码**：`src/client/cardgraph-painter.ts` 的 `elide` / `foldText`；`src/client/CardgraphView.tsx` 的 `HoverTarget`/帧索引。
- **影响**：
  - 主题里有 emoji 时，行尾可能出现替换字形（乱码方块）；CJK 不受影响。
  - 帧 hover 记的是「第几个帧」，布局/排序变化后可能指向另一帧；指针没有换，亮起的东西换了。
- **建议修法**：
  - `elide`/`foldText` 用 `Array.from(text)`（或 `Intl.Segmenter`）按码点/字素迭代，再测量与切分；补一条 emoji/ZWJ 断言。
  - 帧 hover 改存稳定 id（帧的会话/范围键）而不是 index；或在绘制前用当前 layout 重新校验 index 对应的帧。
- **状态**：未修。S3 批次修了相邻箭头、`fittedTransform`、`pick` 边框、`blur()` 死分支；emoji 与帧 hover 不在其中。

## 4. 视图焦点、点击无声与 `pane` 死代码

- **证据**：`R-0053` S3-4（树外/被筛掉且首读失败时点击无声）、S3-5（线程跳转后焦点丢失）、S3-6（`pane` 变体与 `onClose` 死代码，文档失真）；`R-0056`；`R-0059` deferred。
- **当前代码**：`src/client/ReportsView.tsx`（`detailError` 只在面板内渲染；`scrollIntoView` 不聚焦）、`src/client/ReportDetailView.tsx`（`variant: 'row' | 'pane'`，全仓只有 `row` 调用点）。
- **影响**：
  - 键盘用户点「上溯/下递」或「回到列表」后，焦点落回 `body`，下一次 Tab 从页面开头重走。
  - 线程链接指向已删除/读失败、或被筛选隐藏的汇报时，旧面板收起、新面板没有行可挂，看起来「点了没反应」。
  - `pane` 分支和它对应的文档让读者以为还有第二个消费者；实际右侧栏早就不显示详情。
- **建议修法**：
  - 目标行挂载后把焦点给它的展开按钮（`rowRefs` 旁存按钮 ref，或行内 `querySelector('button')`），再 `scrollIntoView`。
  - 当 `openReport` 已设、`shown` 未到且 `detailError` 存在时，把错误放进工具栏 notice，或补一个「读取失败」的合成行锚点。
  - 删除 `pane`/`paneHead`/`paneBody`/`onClose`，模块头改成「就地面板」，同步 `docs/ui.md` 的相关句子。
- **状态**：未修。V9（会话页复制读路径）已由 `R-0061` 修复；V10（`getJson` 无 abort/超时）已在 `R-0059` 修复；这四项仍开放。

## 5. publish 只确认版本可见，不校验 shasum/provenance

- **证据**：`R-0026` S3-7；`R-0055` S3；`R-0059` deferred。
- **当前代码**：`.github/workflows/publish.yml` 的 `Verify the published version` 会在最多约 5 分钟内轮询 `npm view dsh-report-ledger@<version> version`；成功后打印 `dist.shasum` / `dist.integrity`，但**不做比较**，也不断言 provenance。
- **影响**：发布流程能发现「版本一直不可见」，但发现不了「可见的 artifact 不是本地打出来的那个」；provenance 是否附带也没有断言。0.2.4 手工核对过本地 `npm pack` 的 sha1 与 npm 一致，但这不是 CI 保障。
- **建议修法**：发布前 `npm pack --ignore-scripts` 得到本地 tarball 的 sha1/sha512；Verify 阶段取 `npm view ... dist.shasum` 对比，不一致就失败；再对 `dist.attestations`/provenance 做存在性断言（可先非阻塞，确认稳定后改阻塞）。
- **状态**：未修。publish 本身是异步的，比较逻辑要处理「packument 已可见但 dist 尚未稳定」的窗口。

## 已处理，不再跟踪

这些曾经出现在同一批审计里，但已经有独立修复或决定，列在这里避免重复跟踪：

- **V9 会话页/画布双读路径**：`R-0061`。`ReportsView` 改用 `useTimeline`，`loadedFor` 防止切换会话闪上一棵树。
- **跨仓库回收**：`R-0062` 先把候选限制在当前仓库；`R-0063` 进一步移除了分配时自动回收。`maxRetained` 现在只是维护视图的告警阈值。
- **孤儿检出警告**：`R-0064` 覆盖 `report_close`；`R-0065` 覆盖 `report_release` 与 `report_handover`。都只警告、不阻塞。
- **V10 `getJson` 无 abort/超时**：已在 `R-0059` S3 批次修复。
- **相邻箭头、`fittedTransform`、`pick` 1px 边框、`blur()` 死分支**：已在 `R-0059` S3 批次修复。
- **兼容性 records（原第 5 项）**：`dshReleases` 已补 `0.2.1-rc.2`——在一套隔离 prefix + 隔离 `DSH_HOME` 里装了 `@deepseek-ai/dsh@0.2.1-rc.2`，host 半逐条实测通过：工具注册与调用（`report_author` 真的落盘并回显 `hops/reads`）、`report_send` 对非驻留会话的挂账、`peer_wake` 经 `ctx.agents.resume` 真的把它加载回来并补投、权限继承照旧、`SESSION_FORMAT_VERSION` 仍是 4（投递消息的 producer source kind 未变）。`dshOperations` 仍缺，但那只在投 DSH STORE 时才是材料缺口，不是运行时缺陷。

## 相关但不在本清单的项

审计里还有性能窗口化、`Config` 运行时 schema、文档计数漂移等项；它们要么影响面更小，要么已经被后续提交顺手修掉，不在「已确认、有证据、但暂缓」的这五项里。若需要完整审计原文，按上面的报告 ID 查账本。
