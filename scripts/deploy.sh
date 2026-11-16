#!/usr/bin/env bash
#
# Deploy ai-studio-full to production.
#
# Runtime data (用户上传的图片/音频、SQLite 数据库、.env) 只存在于服务器上，
# 绝不能从本地仓库覆盖。尤其是 public/uploads：线上它是指向
# /var/lib/ai-studio/uploads 的软链接，如果 rsync 把本地测试图片目录同步过去，
# 软链接会被替换成真实目录，导致所有历史图片 404。
#
# Usage:
#   scripts/deploy.sh
#
# Optional env:
#   AI_STUDIO_DEPLOY_HOST    ssh alias/host (default: aigzt)
#   AI_STUDIO_REMOTE_ROOT    production code path (default: /var/www/ai-studio-full)
#   AI_STUDIO_DEPLOY_STAGING remote staging path (default: /tmp/ai-studio-deploy)
#
set -euo pipefail

HOST="${AI_STUDIO_DEPLOY_HOST:-aigzt}"
REMOTE_ROOT="${AI_STUDIO_REMOTE_ROOT:-/var/www/ai-studio-full}"
STAGING="${AI_STUDIO_DEPLOY_STAGING:-/tmp/ai-studio-deploy}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$PROJECT_DIR"

if git ls-files --error-unmatch public/uploads >/dev/null 2>&1; then
  echo "ERROR: public/uploads contains tracked files. It must stay gitignored." >&2
  exit 1
fi

echo "==> Running local checks"
npm run check:syntax >/dev/null

echo "==> Uploading code to $HOST:$STAGING"
ssh "$HOST" "rm -rf '$STAGING' && mkdir -p '$STAGING'"
rsync -az \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'tmp' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'database/*.db' \
  --exclude 'database/*.db-*' \
  --exclude 'public/uploads' \
  --exclude 'public/audio' \
  "$PROJECT_DIR/" "$HOST:$STAGING/"

echo "==> Installing files and restarting service on $HOST"
ssh "$HOST" "REMOTE_ROOT='$REMOTE_ROOT' STAGING='$STAGING' bash -s" <<'REMOTE'
set -euo pipefail

sudo rsync -a --chown=aistudio:aistudio \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'tmp' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'database/*.db' \
  --exclude 'database/*.db-*' \
  --exclude 'public/uploads' \
  --exclude 'public/audio' \
  "$STAGING/" "$REMOTE_ROOT/"

# 防线：public/uploads 必须仍然是指向真实上传目录的软链接。
if [ ! -L "$REMOTE_ROOT/public/uploads" ]; then
  echo "ERROR: $REMOTE_ROOT/public/uploads is not a symlink. Refusing to restart." >&2
  echo "Restore it with: sudo ln -s /var/lib/ai-studio/uploads $REMOTE_ROOT/public/uploads" >&2
  exit 1
fi
if ! sudo test -d "$REMOTE_ROOT/public/uploads"; then
  echo "ERROR: $REMOTE_ROOT/public/uploads target is missing. Refusing to restart." >&2
  exit 1
fi

sudo systemctl restart ai-studio.service

for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3000/readyz >/dev/null 2>&1; then
    curl -s http://127.0.0.1:3000/readyz
    echo
    echo "OK: deployed to $REMOTE_ROOT"
    exit 0
  fi
  sleep 1
done

echo "ERROR: service did not become ready after restart." >&2
sudo systemctl status ai-studio.service --no-pager -l >&2 || true
exit 1
REMOTE
