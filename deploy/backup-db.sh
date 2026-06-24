#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="andean-whatsapp-bot"
DB_PATH="/data/bot.sqlite"
BACKUP_DIR="/opt/andean-whatsapp-bot/backups"
DATE="$(date +'%Y-%m-%d_%H-%M-%S')"

BACKUP_FILE="${BACKUP_DIR}/bot-${DATE}.sqlite"
COMPRESSED_FILE="${BACKUP_FILE}.gz"

mkdir -p "$BACKUP_DIR"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "Container $CONTAINER_NAME is not running"
  exit 1
fi

docker exec "$CONTAINER_NAME" test -f "$DB_PATH"

docker run --rm \
  --volumes-from "$CONTAINER_NAME" \
  -v "$BACKUP_DIR:/backup" \
  nouchka/sqlite3 \
  "$DB_PATH" ".backup '/backup/bot-${DATE}.sqlite'"

if [ ! -s "$BACKUP_FILE" ]; then
  echo "Backup failed or file is empty: $BACKUP_FILE"
  exit 1
fi

gzip "$BACKUP_FILE"

if [ ! -s "$COMPRESSED_FILE" ]; then
  echo "Compressed backup failed or file is empty: $COMPRESSED_FILE"
  exit 1
fi

find "$BACKUP_DIR" -name "bot-*.sqlite.gz" -type f ! -name "$(basename "$COMPRESSED_FILE")" -delete

echo "Backup created successfully: $COMPRESSED_FILE"
echo "Old backups deleted. Only latest backup kept."
