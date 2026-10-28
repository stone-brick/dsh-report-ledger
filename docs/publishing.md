# 发布（维护者）

分发形态、产物清单、开发者模式边界、可信发布、CI 分工与 Gitee 镜像。**只与维护者有关。**

## 产物形态与清单

分发形态是**预构建的 bundle**：`lib/` 在发布前构建好，用户安装时不跑任何构建脚本，因此不需要 `allowBuilds` 授权。
`lib/` 同时**随源码提交**（DSH STORE 的固定源检查要求运行产物出现在固定 Commit 里），`ci.yml` 会在构建后比对
提交的产物与源码是否一致，避免"改了 `src` 忘了 `build`"。

```sh
pnpm check          # 完整门禁：类型检查 + 十六套可移植检查（1151 项）+ 工具面三套（240 项）
pnpm build && pnpm pack   # lib/ 随源码提交，pack 前显式重建一次
npm publish         # ⚠ 本机 registry 若是镜像站，必须显式 --registry=https://registry.npmjs.org
```

`pnpm pack` 的产物清单**缺一项的表现都是「装上了不生效」而不是报错**，逐条核对：

| 检查项 | 本包取值 |
|---|---|
| `main` / `exports` 指向构建产物而非 `src/` | `lib/index.js` / `lib/client.js` |
| `files` 含入口**与 `cordis.patch.yml`** | `["lib", "cordis.patch.yml", "THIRD-PARTY-NOTICES.md"]` |
| `dsh.bundle.patch` 指向该 patch | `./cordis.patch.yml` |
| `version` 已递增 | npm 不允许覆盖已发布版本 |

发布后**在干净环境里验证**（0.1.0 的 tarball 已按此验证过；0.2.0 之后的版本都由 `publish.yml` 发布，但隔离安装记录仍未补齐）：

```sh
dsh plugin --profile demo add dsh-report-ledger   # 空 DSH_HOME 里
dsh --profile demo --dump-config                  # 应出现 `# == dsh-report-ledger` 这一层
```

`dsh plugin add` 会因包声明了 `dsh.bundle` 而**自动**把包名追加进 `dsh.profile.bundles`，用户不需要手改配置。

## 开发者模式不能随包出去

`devMode` 是**给复刻仓库的贡献者**准备的开发期回路，不是给安装包使用者的功能。它在发布包之外有两个层面的隔离：

- **配置**：发布 patch 只有 release 一行，没有 dev 行、没有 `devMode` 字段；
- **代码**：dev 半整体搬到了检出里的附加 bundle `dev/bundle/`，单独构建到 `dev/bundle/lib/`，发布包的主入口根本不 import 它。
  `lib/index.js` 里不含任何 dev 工具标识。

门仍然只有一道且没变：`installDevMode` 先看包里有没有 `dev/agents.yml`，没有就返回空 disposer；`files` 不含 `dev/`，
所以安装出来的包即便有人手工塞进附加包，也只挂宿主半、不注册任何开发工具。**复刻仓库才是门。**

`devMode` 那套只有三样东西：工具 `dev_agent_start` / `dev_agents_reload` / `dev_archive`、提示词 section
`plugin:report-ledger:dev`，以及 `$DSH_HOME/report-ledger/dev-agents.json` 里的绑定。早先版本把它们注册成
harness 预设，是反面教材：预设是部署层面的事实，开发产物会进所有使用者的选择器。

打包侧**已自动化**：`node scripts/release-boundary-check.ts` 就地打一次包（`npm pack --ignore-scripts`，
与发布同一套规则），断言产物里没有 `dev/`（也没有 `src/`、`scripts/`、`node_modules/`、`.pnpm-store/`）、
安装需要的条目都在（`package.json`、`lib/index.js`、`lib/client.js`、`cordis.patch.yml`）、打进包里的
`files` 不点名 `dev`、`dsh.bundle.patch` 仍指向 `./cordis.patch.yml`、包里的 bundle patch **只有 release 一行**
且没有把 `devMode` 打开、**宿主 bundle 里没有 `dev_agent_start` / `dev_agents_reload` / `dev_archive` /
`plugin:report-ledger:dev` 任何一个标识**。

`ci.yml` 与 `publish.yml` 都跑它（发布前那一步在 Publish 之前），所以「改宽 `files`」或「把 dev 半挪回主入口」
都会在 PR 上变红，而不是在下一个版本发出去之后。想核一个已下载的产物（例如 Gitee 附件）：
`node scripts/release-boundary-check.ts --tarball <路径>`。

它不启动宿主，所以运行时那一半仍需手工：

```sh
# 1) 默认安装：report-ledger 行的 config 应只有 announceToAgent: true
dsh --profile demo --dump-config

# 2) 运行时边界：工具清单里没有 dev_agent_start / dev_agents_reload / dev_archive。
#    （附加包不在产物里，所以这条只需确认「没装就不该有」；工具清单入口：
#     cordis_inspect_query Tool.listTools，或 设置 → 内置插件 → 插件清单，只读。）
```

另一条边界的准确表述：门是「文件存在」，不是「包从哪来」。能从检出里把附加包装进 profile、再自备
`dev/agents.yml` 的人可以启用开发者模式——那本来就是贡献者的路径，前提是他有仓库。所以能说死的是：
**只装发布包、不改自己安装目录与 profile 配置的人无法启用开发者模式。**

本机的现场口径（沙箱 `EPERM`、`--dump-config` 会重写 profile 根、pnpm 偶发不退出等）在
`PUBLISHING.local.md` §7.2.1；那份文件不入库，能跟着仓库走的只有本节。

## CI 发布（可信发布 OIDC）

`.github/workflows/publish.yml` 负责推 tag 后自动发布——不需要任何 npm 令牌，
也不需要手输一次性验证码，并自动附带 provenance。**首次启用前要在 npm 侧建立一次信任关系**（需交互式 2FA）：

```sh
npm trust github dsh-report-ledger --file publish.yml \
  --repo stone-brick/dsh-report-ledger --allow-publish
```

`--file` 必须与工作流文件名完全一致。之后发版就是 `pnpm version patch && git push origin main --follow-tags`。
发版时把 `dev/bundle/package.json` 的 `version` 也抬到同一个值：附加包不发布，但「插件」页会显示它的版本，
`scripts/release-boundary-check.ts` 会断言两者一致（见下节）。
`publish.yml` 在 tag 与 `package.json` 的 version 不一致时会直接失败（`workflow_dispatch` 仍保留给新包名的手工首发）。
**GitHub release 现在也由这一次运行创建**（`Create the GitHub release` 步，在 npm 版本确认可见之后）：
正文取该 tag 自己的说明（annotated tag message），附件是从该 tag 打出来的 tarball，与 Gitee 附件同一套规则；
页已存在则只补附件，所以可以重跑（v0.2.3 / v0.2.4 缺少 release 页那次，是这一步还不存在）。
注意 CI 只跑 `pnpm test` + 构建，**不跑 typecheck、也不跑 `pnpm test:tools`**：两者的原因相同——都需要
profile 的官方包层（见 [开发、构建与验证](dev-build.md) 的 junction 一节），CI 里没有这一层；把官方包装成 devDependency 反而会在工作区
复制服务注册表、破坏实例同一性。`scripts/workspace-check.ts` 需要 `@deepseek-ai/dsh-workspace`，所以它在
`test:tools` 而不是 `pnpm test`。

## `ci.yml` 只跑测试，不发布

在它之前，本仓库**唯一**跑测试的地方就是 `publish.yml`——而它一推 tag 就
发布。也就是说这套断言从未在 Linux 上跑过，却要拿它决定一个版本能不能发出去。`ci.yml` 把这两件事分开：
推 `main` 与每个 PR 都跑一遍可移植的检查加一次构建，于是"测试在 Linux 上过不过"有了独立答案，而推 tag
之前的失败代价从"一个已挂出去的版本"降到"一条红的运行记录"。

## 首次发布（新包名）

只能手工来一次：npm 的**可信发布与暂存发布都要求包已存在**，新包名两者都会 404。
手动发一次时如果是安全密钥账号，`npm publish` 会打印一个 `https://www.npmjs.com/auth/cli/…` 链接，
在浏览器里完成认证即可（放行凭据用 `--//registry.npmjs.org/:_authToken=…` 传，别写进 `.npmrc`）。


## git 安装与 npm 安装

现在是同一件事：`lib/` 随源码提交，`add github:<你>/dsh-report-ledger#<sha>`（或 Gitee 地址）
拉到源码后**直接就带着可运行的构建产物**，安装期不执行任何生命周期脚本、不需要 `allowBuilds` 授权。
（这条从提交 `db6741c` 起才成立：`v0.2.0` 及更早的 tag 没有提交 `lib/`，安装期靠 `prepare` 构建——那既要求
pnpm 放行构建脚本，也过不了 DSH STORE 的固定源检查。）
**对外仍推荐 npm 安装**：预构建产物、不触发任何构建脚本、不需要授权。

## Gitee 镜像

Gitee 自带的「仓库镜像管理」在本账号不可用（`GET /api/v5/repos/{owner}/{repo}/mirror` 返回
`404 Not Found Project`），所以同步方向反过来：GitHub 主动推。

- 工作流 `.github/workflows/mirror-to-gitee.yml`，在 `main` 与 `v*` tag 的 push 后镜像**所有分支 + tags**；
  Gitee 上已存在的 tag 不会被更新（只补缺失的），所以同一个 tag 在两边的对象类型不同也不会让 job 变红；
- **tag 推送（或手动 `workflow_dispatch`）还会创建/复用 Gitee release，并把从该 tag 归档构建的 tarball
  附上去**（`scripts/gitee-release.sh`，幂等；main 推送只镜像 git 对象，不碰 release API）；
- 凭据是 GitHub 仓库 Secret `GITEE_TOKEN`（Gitee 私人令牌，只需 `projects` 权限）。
  **令牌有有效期，过期后要重新生成并 `gh secret set GITEE_TOKEN`**，否则工作流会认证失败；
- 令牌只经 `credential.helper` 按需交给 git，不写进 remote URL，所以不会落进 `.git/config` 或命令输出。

release 创建/上传失败时，先 `gh workflow run mirror-to-gitee.yml --ref main` 重跑（脚本会复用已有 release、
已存在的附件不重复上传）；也可以按下面的手工命令单独补传。注意附件接口要求令牌放在 **query** 上，
放 form 里会得到 `401 登录失效`（实测）：

```sh
curl -X POST "https://gitee.com/api/v5/repos/stone_zhan/dsh-report-ledger/releases/<release_id>/attach_files?access_token=<token>" \
     -F "file=@dsh-report-ledger-0.2.4.tgz"
```


---

← 返回 [README](../README.md)
