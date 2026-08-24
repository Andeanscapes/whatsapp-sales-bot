#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="/data/bot.sqlite"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/andean-whatsapp-bot}"
ENV_FILE="${ENV_FILE:-.env.prod}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-andean-whatsapp-bot}"
VOLUME_NAME="${VOLUME_NAME:-andean-whatsapp-bot-data}"
DATE="$(date -u +'%Y-%m-%d_%H-%M-%S')-$$"

BACKUP_FILE="${BACKUP_DIR}/bot-${DATE}.sqlite"
COMPRESSED_FILE="${BACKUP_FILE}.gz"
CONTAINER_BACKUP=""
LOCK_FILE="${BACKUP_DIR}/.backup.lock"
BACKUP_COMPLETE=false

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

if ! command -v flock >/dev/null 2>&1; then
  echo "Database backup requires flock (util-linux)"
  exit 1
fi
exec 9>"$LOCK_FILE"
chmod 600 "$LOCK_FILE"
if ! flock -n 9; then
  echo "Another database backup is already running"
  exit 1
fi

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [ -n "$CONTAINER_BACKUP" ]; then
    docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" exec -T app rm -f "$CONTAINER_BACKUP" >/dev/null 2>&1 || true
  fi
  if ! $BACKUP_COMPLETE; then
    rm -f "$BACKUP_FILE" "$COMPRESSED_FILE"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

RUNNING_SERVICES="$(docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" ps --status running --services)"
if printf '%s\n' "$RUNNING_SERVICES" | grep -qx app; then
  docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" exec -T app test -f "$DB_PATH"

  CONTAINER_BACKUP="/data/bot-${DATE}.sqlite"
  docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" exec -T app sqlite3 "$DB_PATH" ".backup '$CONTAINER_BACKUP'"
  docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" cp "app:$CONTAINER_BACKUP" "$BACKUP_FILE"
  docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" exec -T app rm -f "$CONTAINER_BACKUP"
  CONTAINER_BACKUP=""
elif docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
  set +e
  docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" run --rm --no-deps \
    --user 0:0 --entrypoint sh -v "$BACKUP_DIR:/backup:Z" app \
    -c 'if [ ! -f "$1" ]; then exit 2; fi; exec sqlite3 "$1" "$2"' \
    sh "$DB_PATH" ".backup /backup/$(basename "$BACKUP_FILE")"
  offline_status=$?
  set -e

  if [ "$offline_status" -eq 2 ]; then
    echo "No production database found, nothing to back up"
    exit 0
  fi
  if [ "$offline_status" -ne 0 ]; then
    exit "$offline_status"
  fi
else
  echo "No production database volume found, nothing to back up"
  exit 0
fi

if [ ! -s "$BACKUP_FILE" ]; then
  echo "Backup failed or file is empty: $BACKUP_FILE"
  exit 1
fi

gzip "$BACKUP_FILE"

if [ ! -s "$COMPRESSED_FILE" ]; then
  echo "Compressed backup failed or file is empty: $COMPRESSED_FILE"
  exit 1
fi
gzip -t "$COMPRESSED_FILE"
chmod 600 "$COMPRESSED_FILE"

find "$BACKUP_DIR" -name "bot-*.sqlite.gz" -type f -mtime +30 -delete
BACKUP_COMPLETE=true

echo "Backup created successfully: $COMPRESSED_FILE"
echo "Backups older than 30 days deleted."
