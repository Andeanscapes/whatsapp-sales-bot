#!/bin/bash
set -euo pipefail

# SQLite backup for the running prod container.
# Uses sqlite3 .backup inside the container (online-safe, WAL-aware),
# copies the snapshot out, then prunes backups older than 30 days.
#
# Requires sqlite3 in the runtime image (installed via Dockerfile).

CONTAINER=andean-whatsapp-bot
BACKUP_DIR=/var/backups/andean-whatsapp-bot
DATE="$(date +'%Y-%m-%d_%H-%M-%S')"

mkdir -p "$BACKUP_DIR"

docker exec "$CONTAINER" sh -c 'sqlite3 /data/bot.sqlite ".backup /data/backup.sqlite"'
docker cp "$CONTAINER:/data/backup.sqlite" "$BACKUP_DIR/bot-$DATE.sqlite"
docker exec "$CONTAINER" rm -f /data/backup.sqlite

find "$BACKUP_DIR" -type f -name "bot-*.sqlite" -mtime +30 -delete

echo "Backup created: $BACKUP_DIR/bot-$DATE.sqlite"
