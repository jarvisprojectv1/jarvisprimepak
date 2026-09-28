#!/usr/bin/env bash
# scripts/restore-db.sh - Phase 12 (item 4): restore the SQLite database
# from a backup produced by scripts/backup-db.sh.
#
# Usage: scripts/restore-db.sh <backup-file> [--force]
#   Refuses to overwrite an existing, non-empty target DB unless --force is
#   given (so a mistaken restore doesn't silently destroy live data). Always
#   makes a SAFETY COPY of whatever DB file currently exists before
#   overwriting it, named <target>.pre-restore.<timestamp>.db, so a bad
#   restore is itself recoverable.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_FILE="${1:-}"
FORCE="${2:-}"

if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  echo "usage: restore-db.sh <backup-file> [--force]" >&2
  exit 1
fi

if command -v sqlite3 >/dev/null 2>&1; then
  CHECK="$(sqlite3 "$BACKUP_FILE" "PRAGMA integrity_check;" 2>&1 || true)"
  if [ "$CHECK" != "ok" ]; then
    echo "restore-db: backup file failed integrity check ($CHECK) - refusing to restore" >&2
    exit 1
  fi
fi

DB_URL="${DATABASE_URL:-file:$REPO_ROOT/database/dev.db}"
DB_PATH="${DB_URL#file:}"
case "$DB_PATH" in
  /*) : ;;
  *) DB_PATH="$REPO_ROOT/$DB_PATH" ;;
esac

if [ -f "$DB_PATH" ] && [ -s "$DB_PATH" ] && [ "$FORCE" != "--force" ]; then
  echo "restore-db: $DB_PATH already exists and is non-empty. Re-run with --force to overwrite (a safety copy will still be made first)." >&2
  exit 1
fi

if [ -f "$DB_PATH" ]; then
  SAFETY="${DB_PATH}.pre-restore.$(date -u +%Y%m%dT%H%M%SZ).db"
  cp "$DB_PATH" "$SAFETY"
  echo "restore-db: saved pre-restore safety copy to $SAFETY"
fi

cp "$BACKUP_FILE" "$DB_PATH"
echo "restore-db: restored $DB_PATH from $BACKUP_FILE"

if command -v sqlite3 >/dev/null 2>&1; then
  CHECK="$(sqlite3 "$DB_PATH" "PRAGMA integrity_check;")"
  echo "restore-db: post-restore integrity check: $CHECK"
  if [ "$CHECK" != "ok" ]; then
    exit 1
  fi
fi
