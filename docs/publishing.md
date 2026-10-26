# 发布（维护者）

分发形态、产物清单、可信发布、CI 分工与 Gitee 镜像。**只与维护者有关。**

## 产物形态与清单

分发形态是**预构建的 bundle**：`lib/` 在发布前构建好，用户安装时不跑任何构建脚本，因此不需要 `allowBuilds` 授权。
`lib/` 同时**随源码提交**（DSH STORE 的固定源检查要求运行产物出现在固定 Commit 里），`ci.yml` 会在构建后比对
提交的产物与源码是否一致，避免"改了 `src` 忘了 `build`"。

```sh
pnpm check          # 完整门禁：类型检查 + 十六套可移植检查（1112 项）+ 工具面三套（162 项）
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

## CI 发布（可信发布 OIDC）

`.github/workflows/publish.yml` 负责推 tag 后自动发布——不需要任何 npm 令牌，
也不需要手输一次性验证码，并自动附带 provenance。**首次启用前要在 npm 侧建立一次信任关系**（需交互式 2FA）：

```sh
npm trust github dsh-report-ledger --file publish.yml \
  --repo stone-brick/dsh-report-ledger --allow-publish
```

`--file` 必须与工作流文件名完全一致。之后发版就是 `pnpm version patch && git push origin main --follow-tags`。
`publish.yml` 在 tag 与 `package.json` 的 version 不一致时会直接失败（`workflow_dispatch` 仍保留给新包名的手工首发）。
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
     -F "file=@dsh-report-ledger-0.2.3.tgz"
```


---

← 返回 [README](../README.md)
