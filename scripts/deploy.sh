#!/usr/bin/env bash
# scripts/deploy.sh - Phase 12 (item 12): the deployment sequence this repo
# actually needs, spelled out as a real, runnable script rather than only
# prose. Every step here is something already testable in this codebase
# (migrate/typecheck/test/smoke-test) - nothing here invents infrastructure
# this repo doesn't have (no k8s, no blue/green - see
# docs/PHASE12_PRODUCTION.md for why, given the current single-SQLite-writer
# architecture, a simple "backup, migrate, restart, smoke-test" sequence is
# the honest deployment story, not a more elaborate one).
#
# Usage: scripts/deploy.sh [--skip-tests]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SKIP_TESTS="${1:-}"

echo "==> [1/6] Pre-deploy backup"
./scripts/backup-db.sh || echo "deploy: backup step failed or no existing DB yet - continuing (a fresh install has nothing to back up)"

echo "==> [2/6] Install dependencies"
npm ci

if [ "$SKIP_TESTS" != "--skip-tests" ]; then
  echo "==> [3/6] Typecheck (root + apps/api) and full test suite"
  npx tsc --noEmit -p tsconfig.json
  (cd apps/api && npx tsc --noEmit -p tsconfig.json)
  npm test
else
  echo "==> [3/6] Skipped (--skip-tests)"
fi

echo "==> [4/6] Apply pending migrations (prisma migrate deploy - never 'migrate dev' in production)"
npx prisma migrate deploy --schema=database/schema.prisma

echo "==> [5/6] Build apps/web (static dashboard) and apps/api"
npm run build

echo "==> [6/6] Restart the supervised process"
if command -v systemctl >/dev/null 2>&1 && systemctl is-enabled jarvis-api >/dev/null 2>&1; then
  sudo systemctl restart jarvis-api
elif command -v pm2 >/dev/null 2>&1 && pm2 describe jarvis-api >/dev/null 2>&1; then
  pm2 restart jarvis-api
else
  echo "deploy: no recognized supervisor (systemd unit 'jarvis-api' or pm2 process 'jarvis-api') found running - start the process manually per deploy/README or docs/PHASE12_PRODUCTION.md"
fi

echo "==> Running smoke test"
./scripts/smoke-test.sh "${JARVIS_BASE_URL:-http://localhost:4000}"

echo "==> Deploy complete."
