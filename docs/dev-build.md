# 开发、构建与验证

本仓库的开发回路、测试分层与本地门禁。安装到 profile 的细节也在本文；发布流程见 [发布](publishing.md)。

```sh
pnpm build        # 产出 lib/index.js（host 半）与 lib/client.js（client 半）
pnpm test         # 十六套确定性检查共 1110 项断言：账本内核与生命周期 135 + 提示词角色分流 64
                  # + 开发者名册 59 + 开发者归档 29 + 退役交接 29
                  # + 读路径（前缀读/签名缓存/单趟投递）39
                  # + 时间线装配与路由守卫 79
                  # + 时间线模型（筛选/线程/空状态/身份/正文/围栏）102
                  # + 卡片画布模型（分档尺寸/帧装箱/端口均分/通道布线/线程布线/同沟槽合并/相邻卡短跳/线程分行/帧内车道/箭头留空/帧边按端口加长/车道错位/车道按端口排序/为线让路/固定档位 fit/剔除/视口/拾取/填满宽度/下钻范围）149
                  # + 卡片画布画家（绘制顺序/裁剪/虚线/圆角/箭头/中点标记/悬停展开/悬停流光/多圆点/遮罩/主题/指针色/选中不遮罩/状态形状/折行/度量缓存）103
                  # + worktree 适配器（porcelain 解析/路径归一化/git 拒绝分类/格式版本闸门）83
                  # + 租约裁判（双层占用/并发只赢一个/凭证来自 git/交还与结案）85
                  # + 分配（命名 ref 安全性/活跃预算/陈旧记录/幽灵终态/回滚/跨仓库保留计数/不自动删除）76
                  # + 维护视图（六种检出状态/未绑定检出/悬空条目/故意移除不误报/告警阈值）50
                  # + 两界面共选（画布 ↔ 汇报列表：悬停来源/打开状态/标签点击）15
                  # + 宿主桌面打开（可用性/应用列表/默认·指定·reveal/失败降级）13
                  #（不需要 DSH，不触碰真实账本，不启动服务器；worktree 相关的四套会在临时目录里建真仓库）
pnpm test:tools   # 工作区工具面 + 宿主接线 + 同伴名册 195 项（66 + 57 + 72）—— 只能在有官方包层的地方跑，见下
pnpm typecheck    # 对部署中的 harness 类型做全量类型检查
pnpm check        # 以上三者的合并，也就是完整的本地门禁
```

开发与测试需要 **Node ≥ 22.18**（脚本直接跑 `.ts`，依赖 type stripping；当前构建依赖链也声明
`^22.18.0 || >=24.11.0`）；运行产物本身只要求 Node ≥ 20（见 `engines`）。

## 为什么工具面那一套不在 `pnpm test` 里

`scripts/worktree-tools-check.ts` 要运行期 import
`src/report/tools.ts`，而后者运行期 import `@deepseek-ai/dsh-tools`；`scripts/workspace-check.ts`
还要 import `src/index.ts`（`@deepseek-ai/dsh-workspace`）；`scripts/roster-check.ts` 的同伴创建测试也
要 import `src/report/tools.ts`——三者都是**未在 package.json 里声明**的包：本机靠
`node_modules/@deepseek-ai` 的 junction 解析，而 lockfile 里没有它们，所以 runner 上
`pnpm install` 之后必然解析不到。这就是这三个脚本放在 `test:tools` 而不是 `test` 的原因：
可移植子集必须只依赖 `yaml` 与 Node 内置模块。

这与 typecheck 面对的是同一个约束（CI 里没有官方包层），处理方式也刻意一致：**CI 跑它跑得了的
那部分，跑不了的留在本地门禁里**。`pnpm check` 是完整门禁，`pnpm test` 是它可移植的子集——`ci.yml`
与 `publish.yml` 都只跑后者；`ci.yml` 另在构建后核对已提交的 `lib/`，`publish.yml` 只测试加构建。把这个分工写在脚本名上而不是注释里，是为了失败信息不至于指向一个与
被测代码毫无关系的模块名。

## 安装到 profile

本仓库已这么装好：包经 junction 出现在 `~/.dsh/profiles/node_modules/dsh-report-ledger`，并在 profile 的 `cordis.patch.yml` 中有一行：

```yaml
- insert:
    - id: report-ledger
      name: 'dsh-report-ledger'
      config:
        announceToAgent: true
        # 可选：打开工作区支持（见 docs/worktree.md）
        # worktree:
        #   enabled: true
```

## 开发回路

- **宿主半：保存即生效。** web profile 的 `cordis.patch.yml` 里把 `dsh-base` 默认禁用的 `hmr` 行打开，并把 `root` 扩到本仓库的 `lib/`（因为插件经 junction 挂载、真实路径在 profile 之外）。配合 `pnpm watch`，回路是：**保存 → tsdown 重建（约 0.2s）→ HMR 就地重载该插件条目**。进程不重启、端口不断、正在进行的会话不中断。
  - 已实测确认：改 `lib/index.js` 后新代码即刻生效，**且宿主进程 PID 不变**。本插件被判定为"直接变更"走局部重载，不会触发 `loader.exit()`（那是 **CLI 入口静态依赖树**里文件改动才会走的路径；插件由 Loader 动态 `import()` 加载，不属于那棵树）。
  - 重载是安全的：插件的持久状态全在磁盘账本上，内存里只有一个互斥锁表，重载不丢数据。
  - ⚠️ **启用 `hmr` 需要一次重启才生效。** 通过 `patchReload: live` 在运行中启用只会"启用行"而**不应用 `config`**——实测服务自己报 `root: []`（空监视）与 schema 默认 `debounce: 100`。组合树本身是对的（`dsh --profile web --dump-config` 可见完整 config），只是生效时机问题。
- **客户端半：保存即生效，同样不需要刷新页面（已实测）。** 原先这里写的是「重建 + 页面刷新」，并注明"未验证"——**那条是错的**。`dsh-web-app` 的 `client-hmr` 行是**常驻**的（`dsh-web-app/cordis.patch.yml`：*always mounted: it is idle until a rebuild watcher actually rewrites client bundles*），其 node 半侧每 `pollIntervalMs`（默认 500ms）stat 轮询**每个图 bundle**，变化时经 `/plugins/events` 的 SSE 通道广播 `rebuilt` 帧；浏览器半侧据此 `invalidate` → `prefetch` 新 factory → 拆旧 fiber → `entry.refresh()` 重新挂载。插件经 junction 挂在 profile 之外**不影响**这条链路：轮询的是解析后的真实路径。
  - 实测方式与结果：直接改写插件 `lib/client.js` 里的 `"view.tab"` 字面量（不重建源码、不刷新、不点击），标签在**约 1 秒内**变成新值；改回去又自动回退。两次 `performance.getEntriesByType('navigation').length` 始终为 1，页面没有重新导航。也就是说 `pnpm watch`（或任何写 `lib/client.js` 的构建）对客户端半就是**完整回路：保存 → 重建 → 页面自己换掉这个插件**。
  - 代价与边界：换掉的是**插件**，插件内的 React 状态会丢（展开的详情会收起），而会话、工作区与连接状态不受影响；重载失败不回滚，该 entry 停在 FAILED 视图并在下一次 `rebuilt` 帧从头重试。
  - **仍然需要刷新页面的只有一种情况：启动图本身变了。** 装／卸插件、启用／禁用某一行（即 `dsh.client` 名单变化）只在页面加载时组合——每个 `rebuilt` 帧只携带单个插件产物的 revision，不替换启动图。
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


## 兼容性与依赖契约

- **DSH 0.2.0-rc.2 对齐**：构建产物与该版本的平台模块表逐条比对一致，类型检查、构建与全部确定性断言均通过（套数与数量见上面的命令注释）。0.1.5-rc.3 已不再支持：那个 shell 的图标导出带画板尺寸后缀（如 `IconCopyOutline16`），0.2.0 改成尺寸中立的 `…Regular` / `…Medium` 成对导出，尺寸交给 `size` prop。
- **宿主半的运行时外部依赖有三条**：`@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-workspace`（都由 profile 提供，**不在 package.json 里声明**），以及 `yaml`（声明在 `dependencies` 里，由包管理器安装；front matter 的 YAML 编解码用它）。`lib/` 随源码提交，固定 Commit 里就带着可运行的构建产物。
- **浏览器半 require** `react`、`react/jsx-runtime` 与 `@deepseek-ai/dsh-client-ui-primitives`（面板里的按钮、芯片、悬停、状态点、输入框与正文渲染全部用它，与内置的 Chat / 轨迹视图同一套），其余全部内联。宿主半在 headless profile 里同样可用（没有 web server 时只是少了那三个只读端点）。
- ⚠️ 于是浏览器半多了一条硬依赖：**shell 的冻结模块表里必须有 `dsh-client-ui-primitives`**。它自带的对话视图就依赖它，所以缺了它意味着那个 shell 本身已经坏了；真缺的话失败模式是「汇报标签页不出现」而不是整个 GUI 崩。

---

← 返回 [README](../README.md)
