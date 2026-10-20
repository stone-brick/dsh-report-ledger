#!/usr/bin/env bash
# Create (or reuse) the Gitee release for one tag and attach its tarball.
#
# Gitee has no "release on tag" automation: the mirror workflow only pushes git
# objects. This script is the missing half, and it is idempotent so a re-run
# repairs a half-finished release instead of duplicating it.
#
# Usage: GITEE_TOKEN=... scripts/gitee-release.sh v0.2.1 dsh-report-ledger-0.2.1.tgz
set -euo pipefail

tag="${1:?usage: gitee-release.sh <vX.Y.Z> <tarball>}"
tgz="${2:?usage: gitee-release.sh <vX.Y.Z> <tarball>}"
: "${GITEE_TOKEN:?GITEE_TOKEN is required}"

owner="stone_zhan"
repo="dsh-report-ledger"
api="https://gitee.com/api/v5/repos/${owner}/${repo}"
version="${tag#v}"
asset_name="$(basename "$tgz")"

[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || {
  echo "not a release tag: $tag" >&2
  exit 1
}
[[ -f "$tgz" ]] || {
  echo "tarball not found: $tgz" >&2
  exit 1
}

# Read the id from a release JSON document on stdin; empty for JSON null.
json_id() {
  node -e 'let s="";process.stdin.on("data", d => s += d).on("end", () => { const j = JSON.parse(s); process.stdout.write(j && j.id ? String(j.id) : "") })'
}

# Ask a release JSON document (stdin) whether one asset name is already there.
json_has_asset() {
  node -e 'let s="";process.stdin.on("data", d => s += d).on("end", () => { const j = JSON.parse(s); const name = process.argv[1]; process.stdout.write((j.assets || []).some((a) => a.name === name) ? "yes" : "no") })' "$1"
}

release="$(curl -sS --fail-with-body "${api}/releases/tags/${tag}?access_token=${GITEE_TOKEN}")"
if [[ "$release" == "null" || -z "$release" ]]; then
  body="$(cat <<EOF
DSH 插件：把「汇报」做成代理之间的一等交互原语——可追溯的传递路径账本、回执/结案/修正，以及一个会话时间线与卡片画布标签页。

## 安装（三选一）

**1. 下载本发行版的 tarball（不需要构建工具链，也不需要访问 GitHub）**

\`\`\`sh
dsh plugin --profile web add ./dsh-report-ledger-${version}.tgz
\`\`\`

**2. 从 Gitee 装（安装时自动构建，约 15 秒）**

\`\`\`sh
dsh plugin --profile web add git+https://gitee.com/stone_zhan/dsh-report-ledger.git
\`\`\`

**3. npm（已发布）**

\`\`\`sh
dsh plugin --profile web add dsh-report-ledger
\`\`\`

装完重启 profile（\`dsh web\`）。验证：\`dsh --profile web --dump-config\` 应出现 \`# == dsh-report-ledger\` 这一层。

## 要求

- DSH 0.2.0-rc.2（实测）
- 账本落在 \`\$DSH_HOME/report-ledger/\`，是本机文件，不上传任何地方
- 浏览器半在会话头部新增一个「汇报」标签页，右栏另有「汇报画布」标签页
- 发布说明与完整文档见仓库 README
EOF
)"
  target="$(git rev-parse "${tag}^{}")"
  created="$(curl -sS --fail-with-body -X POST "${api}/releases" \
    --data-urlencode "access_token=${GITEE_TOKEN}" \
    --data-urlencode "tag_name=${tag}" \
    --data-urlencode "name=${tag}" \
    --data-urlencode "body=${body}" \
    --data-urlencode "prerelease=false" \
    --data-urlencode "target_commitish=${target}")"
  id="$(printf '%s' "$created" | json_id)"
  if [[ -z "$id" ]]; then
    echo "Gitee did not return a release id for ${tag}" >&2
    exit 1
  fi
  echo "created Gitee release ${tag} (id ${id})"
else
  id="$(printf '%s' "$release" | json_id)"
  if [[ -z "$id" ]]; then
    echo "Gitee returned a release without an id for ${tag}" >&2
    exit 1
  fi
  echo "reusing Gitee release ${tag} (id ${id})"
fi

release="$(curl -sS --fail-with-body "${api}/releases/${id}?access_token=${GITEE_TOKEN}")"
if [[ "$(printf '%s' "$release" | json_has_asset "$asset_name")" == "yes" ]]; then
  echo "asset ${asset_name} is already attached"
else
  curl -sS --fail-with-body -X POST "${api}/releases/${id}/attach_files?access_token=${GITEE_TOKEN}" \
    -F "file=@${tgz}"
  echo "attached ${asset_name} to ${tag}"
fi

echo "https://gitee.com/${owner}/${repo}/releases/tag/${tag}"
