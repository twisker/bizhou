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

# 注意：不覆盖 BIZHOU_CONFIG_DIR —— 必须与你运行 `bz login` 时用的配置目录一致，
# 否则会看不到已登录的账号。WORK 仅用于测试数据（大文件/输出），退出时清理。
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

bz() { bun "$IDX" "$@"; }

echo "== M0 验证：$SIZE_MB MB 文件，真实百度网盘往返 =="

echo "[0/5] 预检网络可达性（上传需 d.pcs.baidu.com）"
for h in openapi.baidu.com pan.baidu.com d.pcs.baidu.com; do
  if curl -sS -m 8 -o /dev/null "https://$h/" 2>/dev/null; then
    echo "  ✓ $h 可达"
  else
    echo "  ✗ $h 不可达 —— 该主机不可达会导致对应环节失败（上传依赖 d.pcs.baidu.com）"
  fi
done

# 若未初始化则初始化（首次会打印恢复密钥，请留意保存）
if ! bz --version >/dev/null 2>&1; then echo "无法运行 bz"; exit 1; fi
bz init 2>&1 | sed 's/^/  /' || true

echo "[1/5] 检查登录状态"
if ! bz account list 2>/dev/null | grep -q '\*'; then
  echo "  ✗ 未登录（或与 bz login 用了不同的 BIZHOU_CONFIG_DIR）。"
  echo "    请确保用相同环境运行： bun $IDX login --device"
  exit 4
fi
bz account list | sed 's/^/  /'

echo "[2/5] 生成 $SIZE_MB MB 随机测试文件"
dd if=/dev/urandom of="$WORK/m0.bin" bs=1048576 count="$SIZE_MB" status=none
IN=$(shasum -a256 "$WORK/m0.bin" | cut -d' ' -f1)
echo "  源 sha256: $IN"

echo "[3/5] bz push（加密 + 分片 + 上传）"
T0=$(date +%s)
# push 把完整资源 ID 打到 stdout，进度/提示走 stderr（实时可见）
ID=$(bz push "$WORK/m0.bin" --name "m0-verify.bin")
T1=$(date +%s)
echo "  上传耗时: $((T1 - T0))s；完整资源 ID: $ID"

echo "[4/5] bz pull（下载 + 解密 + 还原）"
T2=$(date +%s)
bz pull "$ID" --out "$WORK/out" 2>&1 | sed 's/^/  /'
T3=$(date +%s)
OUT=$(shasum -a256 "$WORK/out/m0-verify.bin" 2>/dev/null | cut -d' ' -f1 || echo "")
echo "  下载耗时: $((T3 - T2))s"

echo "[5/5] 结果"
if [ "$IN" = "$OUT" ] && [ -n "$OUT" ]; then
  echo "  ✅ 字节级一致（真实云端上传→下载往返成功）"
  BYTES=$((SIZE_MB * 1048576))
  [ $((T1 - T0)) -gt 0 ] && echo "  上行吞吐 ≈ $((BYTES / (T1 - T0) / 1024)) KB/s"
  [ $((T3 - T2)) -gt 0 ] && echo "  下行吞吐 ≈ $((BYTES / (T3 - T2) / 1024)) KB/s"
else
  echo "  ❌ 不一致或下载失败（out=$OUT），保留云端资源 $ID 以便排查"; exit 6
fi

echo "[清理] 删除云端测试资源 $ID"
bz rm "$ID" 2>&1 | sed 's/^/  /' || echo "  （删除失败，可手动： bz rm $ID）"

cat <<'EOF'

—— 需人工确认的 M0 结论 ——
  a) 上述加密大文件已被云端正常接收、往返字节一致 → 若全程无封禁/限制即满足 M0 前提。
  b) 若出现频率限制/配额报错，记录 QPS/配额到 .claude/tech-spec-registry.md §5。
EOF
