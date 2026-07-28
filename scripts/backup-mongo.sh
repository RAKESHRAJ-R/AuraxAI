#!/usr/bin/env bash
#
# Theaurax — MongoDB backup.
#
# Self-hosting MongoDB means backups are OUR job (Atlas did them automatically).
# Runs mongodump into a dated gzip archive, prunes old ones, and optionally
# pushes offsite. Install via cron — see DEPLOY.md.
#
#   Restore:  mongorestore --gzip --archive=/var/backups/theaurax/mongo-YYYY-MM-DD.gz --drop
#
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/theaurax}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
DB_NAME="${DB_NAME:-theaurax_assistant}"
# Read the same URI the bot uses so credentials live in exactly one place.
ENV_FILE="${ENV_FILE:-/opt/theaurax/.env}"
OFFSITE_DEST="${OFFSITE_DEST:-}"   # e.g. u123456@u123456.your-storagebox.de:backups/

if [[ -z "${MONGODB_URI:-}" && -f "$ENV_FILE" ]]; then
  MONGODB_URI="$(grep -E '^MONGODB_URI=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
fi

if [[ -z "${MONGODB_URI:-}" ]]; then
  echo "[backup] MONGODB_URI not set and not found in $ENV_FILE — nothing to back up." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
ARCHIVE="$BACKUP_DIR/mongo-$(date +%F-%H%M).gz"

echo "[backup] dumping $DB_NAME -> $ARCHIVE"
mongodump --uri="$MONGODB_URI" --db="$DB_NAME" --gzip --archive="$ARCHIVE" --quiet

# A zero-byte or missing archive means the dump silently failed — fail loudly
# rather than pruning good backups and leaving nothing behind.
if [[ ! -s "$ARCHIVE" ]]; then
  echo "[backup] FAILED — archive missing or empty, keeping older backups." >&2
  rm -f "$ARCHIVE"
  exit 1
fi

echo "[backup] ok — $(du -h "$ARCHIVE" | cut -f1)"

if [[ -n "$OFFSITE_DEST" ]]; then
  echo "[backup] copying offsite -> $OFFSITE_DEST"
  scp -q "$ARCHIVE" "$OFFSITE_DEST" || echo "[backup] WARNING: offsite copy failed" >&2
fi

# Prune only after a verified-good dump.
find "$BACKUP_DIR" -name 'mongo-*.gz' -type f -mtime "+$RETENTION_DAYS" -delete
echo "[backup] done — $(find "$BACKUP_DIR" -name 'mongo-*.gz' | wc -l) archive(s) retained"
