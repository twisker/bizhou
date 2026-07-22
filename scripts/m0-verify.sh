#!/usr/bin/env bash
# M0 关键验证脚本 —— 把 PRD M0 的联网验证收敛成一条命令。
#
# 前置（人工，仅一次）：
#   1) .env 已配置 BAIDU_APP_KEY / BAIDU_SECRET_KEY
#   2) 已运行 `bun packages/cli/src/index.ts login`（浏览器/设备码授权，拿到 token）
#
# 用法：
#   scripts/m0-verify.sh [文件大小MB，默认 200]
#
# 本脚本会：初始化 vault → 生成随机大文件 → bz push（加密上传到 /apps/bizhou/）
#          → bz pull（下载解密还原）→ 校验 SHA-256 字节级一致 → 输出耗时/吞吐
#          → 提示人工确认账号未被限制/封禁（M0 的核心结论）。
set -euo pipefail

REPO="$(git rev-parse --show-toplevel)"
IDX="$REPO/packages/cli/src/index.ts"
SIZE_MB="${1:-200}"

: "${BIZHOU_MASTER_PASSWORD:?请先 export BIZHOU_MASTER_PASSWORD=<主密码>（脚本免交互解锁需要）}"

WORK="$(mktemp -d)"
export BIZHOU_CONFIG_DIR="${BIZHOU_CONFIG_DIR:-$WORK/cfg}"
trap 'rm -rf "$WORK"' EXIT

bz() { bun "$IDX" "$@"; }

echo "== M0 验证：$SIZE_MB MB 文件，真实百度网盘往返 =="

# 若未初始化则初始化（生成恢复密钥）
if ! bz --version >/dev/null 2>&1; then echo "无法运行 bz"; exit 1; fi
bz init 2>/dev/null || true

echo "[1/5] 检查登录状态"
if ! bz account list 2>/dev/null | grep -q '\*'; then
  echo "  ✗ 未登录。请先运行： bun $IDX login   （完成浏览器/设备码授权）"
  exit 4
fi
bz account list | sed 's/^/  /'

echo "[2/5] 生成 $SIZE_MB MB 随机测试文件"
dd if=/dev/urandom of="$WORK/m0.bin" bs=1048576 count="$SIZE_MB" status=none
IN=$(shasum -a256 "$WORK/m0.bin" | cut -d' ' -f1)
echo "  源 sha256: $IN"

echo "[3/5] bz push（加密 + 分片 + 上传）"
T0=$(date +%s)
bz push "$WORK/m0.bin" --name "m0-verify.bin" 2>&1 | sed 's/^/  /'
T1=$(date +%s)
ID=$(bz ls 2>/dev/null | grep m0-verify.bin | awk '{print $1}' | head -1)
echo "  上传耗时: $((T1 - T0))s；资源 ID 前缀: $ID"

echo "[4/5] bz pull（下载 + 解密 + 还原）"
T2=$(date +%s)
# ls 只显示 12 位前缀，用 info 需完整 id；这里直接用完整 id：从远端列目录取
FULLID=$(bz ls 2>/dev/null | grep m0-verify.bin | awk '{print $1}' | head -1)
bz pull "$FULLID" --out "$WORK/out" 2>&1 | sed 's/^/  /' || {
  echo "  （若因 12 位前缀不足以定位，请用完整 32 位 ID 重试 bz pull）"; }
T3=$(date +%s)
OUT=$(shasum -a256 "$WORK/out/m0-verify.bin" 2>/dev/null | cut -d' ' -f1 || echo "")
echo "  下载耗时: $((T3 - T2))s"

echo "[5/5] 结果"
if [ "$IN" = "$OUT" ] && [ -n "$OUT" ]; then
  echo "  ✅ 字节级一致（上传→下载往返成功）"
  BYTES=$((SIZE_MB * 1048576))
  [ $((T1 - T0)) -gt 0 ] && echo "  上行吞吐 ≈ $((BYTES / (T1 - T0) / 1024)) KB/s"
  [ $((T3 - T2)) -gt 0 ] && echo "  下行吞吐 ≈ $((BYTES / (T3 - T2) / 1024)) KB/s"
else
  echo "  ❌ 不一致或下载失败（out=$OUT）"; exit 6
fi

cat <<'EOF'

—— 需人工确认的 M0 结论 ——
  a) 上述加密大文件是否被云端正常接收、未触发限制/封禁？（全案前提）
  b) 观察是否出现频率限制/配额报错，记录 QPS/配额到 .claude/tech-spec-registry.md §5。
  清理测试资源： bun packages/cli/src/index.ts rm <完整资源ID>
EOF
