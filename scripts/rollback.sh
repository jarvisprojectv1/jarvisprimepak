#!/usr/bin/env bash
# scripts/rollback.sh - Phase 12 (item 12): rollback procedure.
#
# Honest scope: this repo's migrations (Prisma) are additive-only so far
# (every phase's own writeup confirms this - "additive migration", "no
# existing table changed" appears in every PHASE*.md). There is NO down-
# migration tooling in this stack (Prisma's own `migrate deploy` is
# forward-only), so a genuine schema rollback means restoring the
# pre-deploy DB backup this script's caller (scripts/deploy.sh) took BEFORE
# migrating - not "run migrations backward". Code rollback (git) is
# separate from and safe to do independently of a DB restore.
#
# Usage: scripts/rollback.sh <git-ref-to-roll-back-to> [backup-file]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

GIT_REF="${1:-}"
BACKUP_FILE="${2:-}"

if [ -z "$GIT_REF" ]; then
  echo "usage: rollback.sh <git-ref-to-roll-back-to> [backup-file]" >&2
  echo "  If [backup-file] is omitted, the code is rolled back but the" >&2
  echo "  database is left as-is (safe when the new migration was purely" >&2
  echo "  additive, which is this repo's stated norm - see above)." >&2
  exit 1
fi

echo "==> Rolling back code to $GIT_REF"
git fetch origin
git checkout "$GIT_REF"
npm ci

if [ -n "$BACKUP_FILE" ]; then
  echo "==> Restoring database from $BACKUP_FILE"
  ./scripts/restore-db.sh "$BACKUP_FILE" --force
else
  echo "==> No backup file given - database left unchanged (see script header for when this is safe)."
fi

echo "==> Restarting the supervised process"
if command -v systemctl >/dev/null 2>&1 && systemctl is-enabled jarvis-api >/dev/null 2>&1; then
  sudo systemctl restart jarvis-api
elif command -v pm2 >/dev/null 2>&1 && pm2 describe jarvis-api >/dev/null 2>&1; then
  pm2 restart jarvis-api
else
  echo "rollback: no recognized supervisor found - restart the process manually."
fi

echo "==> Running smoke test"
./scripts/smoke-test.sh "${JARVIS_BASE_URL:-http://localhost:4000}"
echo "==> Rollback complete."
