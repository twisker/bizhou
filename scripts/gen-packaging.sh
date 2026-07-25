#!/usr/bin/env bash
# 发版打包：构建自包含 CLI → 打 tar → 算 sha256 → 生成 Homebrew formula + Scoop manifest。
# 对应 PRD §18「发版自动生成 manifest」。实际发布需人工把 tarball 传到 GitHub Release
# 并把生成的 manifest 推到 Homebrew tap / Scoop bucket 仓库（需渠道账号，见人工TODO H-05）。
set -euo pipefail

REPO="$(git rev-parse --show-toplevel)"
VERSION="$(cat "$REPO/VERSION")"
REPO_SLUG="${BIZHOU_REPO_SLUG:-twisker/bizhou}"
OUT="$REPO/packaging/generated"
TARBALL="bizhou-cli-$VERSION.tgz"
URL="https://github.com/$REPO_SLUG/releases/download/v$VERSION/$TARBALL"

echo "== 打包 bz CLI v$VERSION =="
( cd "$REPO" && pnpm run build >/dev/null )

mkdir -p "$OUT"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp "$REPO/packages/cli/dist/index.js" "$STAGE/index.js"
cat > "$STAGE/package.json" <<JSON
{ "name": "@bizhou/cli", "version": "$VERSION", "type": "module", "bin": { "bz": "index.js" } }
JSON
# 确定性 tar：可复现构建是本项目公开承诺的一部分（见 site/{zh,en}/versions.md 与
# arch-spec §5.1）——任何人都应能从同一份源码得到逐字节相同的产物、自行核对 sha256。
# 三个不确定性来源必须全部消除，少一个 sha 就会漂：
#   1. 文件 mtime：每次构建都是"现在" → 统一 touch 成固定时刻
#   2. gzip 头里的时间戳：tar -z 会写入当前时间 → 改用 gzip -n 显式关掉
#   3. 归档内文件顺序与 uid/gid → 固定顺序 + --numeric-owner + uid/gid 归零
# 固定时刻取一个与版本无关的常量；它只影响归档元数据，不影响解出来的内容。
touch -t 202001010000 "$STAGE/index.js" "$STAGE/package.json"
TAR_ID_FLAGS=(--numeric-owner)
if tar --version 2>/dev/null | grep -qi "gnu tar"; then
  TAR_ID_FLAGS+=(--owner=0 --group=0)
else
  TAR_ID_FLAGS+=(--uid 0 --gid 0) # bsdtar（macOS 默认）
fi
tar -C "$STAGE" "${TAR_ID_FLAGS[@]}" -cf - index.js package.json | gzip -n -9 >"$OUT/$TARBALL"
SHA=$(shasum -a 256 "$OUT/$TARBALL" | cut -d' ' -f1)
echo "  tarball: $OUT/$TARBALL"
echo "  sha256 : $SHA"

# --- Homebrew formula ---
cat > "$OUT/bizhou.rb" <<RUBY
class Bizhou < Formula
  desc "客户端加密引擎 + CLI（bz）：上传前端到端加密，云端只存密文"
  homepage "https://github.com/$REPO_SLUG"
  url "$URL"
  sha256 "$SHA"
  license "Apache-2.0"
  depends_on "node"

  def install
    libexec.install "index.js", "package.json"
    (bin/"bz").write <<~EOS
      #!/bin/bash
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/index.js" "\$@"
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/bz --version")
  end
end
RUBY

# --- Scoop manifest ---
cat > "$OUT/bizhou.json" <<JSON
{
  "version": "$VERSION",
  "description": "客户端加密引擎 + CLI（bz）：上传前端到端加密，云端只存密文",
  "homepage": "https://github.com/$REPO_SLUG",
  "license": "Apache-2.0",
  "url": "$URL",
  "hash": "$SHA",
  "extract_dir": ".",
  "depends": "nodejs",
  "bin": [["node", "bz", "index.js"]]
}
JSON

echo "  已生成: $OUT/bizhou.rb  &  $OUT/bizhou.json"
echo "  发布（人工）：把 ${TARBALL} 传到 GitHub Release v${VERSION} ，再把 manifest 推到 tap/bucket 仓库。"
