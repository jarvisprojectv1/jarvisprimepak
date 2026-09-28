#!/usr/bin/env bash
# scripts/backup-db.sh - Phase 12 (item 4): back up the SQLite database file.
#
# Uses sqlite3's own ".backup" command (a consistent, hot-safe copy via
# SQLite's own backup API - safe to run while the API/worker process has the
# DB open, unlike a plain `cp` which can copy a torn WAL-mode file mid-write)
# when the sqlite3 CLI is available, falling back to a plain file copy
# (documented as less safe under concurrent writes) if it isn't.
#
# Usage: scripts/backup-db.sh [output-directory]
#   Defaults to ./backups relative to the repo root.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$REPO_ROOT/backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# Resolve the DB file path from DATABASE_URL (file:./dev.db style), same
# default core/config/env.ts uses, so this script works with zero setup.
DB_URL="${DATABASE_URL:-file:$REPO_ROOT/database/dev.db}"
DB_PATH="${DB_URL#file:}"
# Resolve relative paths against the repo root (matches config/env.ts's
# own default resolution).
case "$DB_PATH" in
  /*) : ;;
  *) DB_PATH="$REPO_ROOT/$DB_PATH" ;;
esac

if [ ! -f "$DB_PATH" ]; then
  echo "backup-db: database file not found at $DB_PATH (nothing to back up yet)" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
DEST="$OUT_DIR/jarvis-${TIMESTAMP}.db"

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" ".backup '$DEST'"
  echo "backup-db: wrote consistent snapshot (sqlite3 .backup) to $DEST"
else
  echo "backup-db: sqlite3 CLI not found - falling back to a plain file copy (LESS SAFE under concurrent writes; install sqlite3 for a hot-safe backup)" >&2
  cp "$DB_PATH" "$DEST"
  echo "backup-db: wrote plain copy to $DEST"
fi

# Integrity check on the backup itself, not just the source - a corrupt
# backup that "succeeded" is worse than an obvious failure.
if command -v sqlite3 >/dev/null 2>&1; then
  CHECK="$(sqlite3 "$DEST" "PRAGMA integrity_check;")"
  if [ "$CHECK" != "ok" ]; then
    echo "backup-db: INTEGRITY CHECK FAILED on backup ($CHECK) - deleting bad backup" >&2
    rm -f "$DEST"
    exit 1
  fi
  echo "backup-db: integrity check passed"
fi

echo "$DEST"
