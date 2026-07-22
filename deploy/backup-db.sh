#!/usr/bin/env bash
set -euo pipefail
umask 077

DB_PATH="/data/bot.sqlite"
BACKUP_DIR="/var/backups/andean-whatsapp-bot"
ENV_FILE=".env.prod"
COMPOSE_PROJECT="andean-whatsapp-bot-prod"
DATE="$(date +'%Y-%m-%d_%H-%M-%S')"

BACKUP_FILE="${BACKUP_DIR}/bot-${DATE}.sqlite"
COMPRESSED_FILE="${BACKUP_FILE}.gz"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

if ! docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" ps --status running --services | grep -qx app; then
  echo "Production app service is not running"
  exit 1
fi

docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" exec -T app test -f "$DB_PATH"

CONTAINER_BACKUP="/data/bot-${DATE}.sqlite"
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" exec -T app sqlite3 "$DB_PATH" ".backup '$CONTAINER_BACKUP'"
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" cp "app:$CONTAINER_BACKUP" "$BACKUP_FILE"
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" exec -T app rm -f "$CONTAINER_BACKUP"

if [ ! -s "$BACKUP_FILE" ]; then
  echo "Backup failed or file is empty: $BACKUP_FILE"
  exit 1
fi

gzip "$BACKUP_FILE"
chmod 600 "$COMPRESSED_FILE"

if [ ! -s "$COMPRESSED_FILE" ]; then
  echo "Compressed backup failed or file is empty: $COMPRESSED_FILE"
  exit 1
fi

find "$BACKUP_DIR" -name "bot-*.sqlite.gz" -type f -mtime +30 -delete

echo "Backup created successfully: $COMPRESSED_FILE"
echo "Backups older than 30 days deleted."
