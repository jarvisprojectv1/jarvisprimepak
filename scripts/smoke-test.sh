#!/usr/bin/env bash
# scripts/smoke-test.sh - Phase 12 (item 12): a minimal, REAL post-deploy
# check against a running instance - not a substitute for the test suite,
# just "did the thing we just deployed actually come up and answer".
#
# Usage: scripts/smoke-test.sh [base-url]   (default http://localhost:4000)
set -euo pipefail

BASE_URL="${1:-http://localhost:4000}"
FAILED=0

check() {
  local name="$1" path="$2" expected="$3"
  local status
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${BASE_URL}${path}" || echo "000")"
  if [ "$status" = "$expected" ]; then
    echo "  [OK]   $name -> $status"
  else
    echo "  [FAIL] $name -> $status (expected $expected)"
    FAILED=1
  fi
}

echo "smoke-test: checking $BASE_URL"
check "liveness"  "/health/live"  "200"
check "readiness" "/health/ready" "200"
check "basic health (legacy)" "/health" "200"
check "unauthenticated protected route is rejected, not 500" "/tools" "401"

if [ "$FAILED" -ne 0 ]; then
  echo "smoke-test: FAILED - do not consider this deploy complete."
  exit 1
fi
echo "smoke-test: all checks passed."
