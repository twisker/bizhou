#!/usr/bin/env bash
# 发版打包：构建自包含 CLI → 打 tar → 算 sha256 → 生成 Homebrew formula + Scoop manifest。
# 对应 PRD §18「发版自动生成 manifest」。实际发布需人工把 tarball 传到 GitHub Release
# 并把生成的 manifest 推到 Homebrew tap / Scoop bucket 仓库（需渠道账号，见人工TODO H-05）。
set -euo pipefail

REPO="$(git rev-parse --show-toplevel)"
VERSION="$(cat "$REPO/VERSION")"
REPO_SLUG="${BIZHOU_REPO_SLUG:-xkool/bizhou}"
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
# 确定性 tar（固定 mtime/owner），便于可复现 sha
tar -C "$STAGE" --numeric-owner -czf "$OUT/$TARBALL" index.js package.json
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
