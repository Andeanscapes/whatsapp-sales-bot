#!/usr/bin/env bash
set -euo pipefail
umask 077

SOURCE="${1:-}"
EXPORT_DIR="exports/meta"
CONTAINER_DIR="/tmp/andean-meta-leads"

if [[ "$SOURCE" != "local" && "$SOURCE" != "dev" && "$SOURCE" != "prod" ]]; then
  echo "Usage: $0 <local|dev|prod>" >&2
  exit 1
fi

mkdir -p "$EXPORT_DIR"
chmod 700 "$EXPORT_DIR"

if [[ "$SOURCE" == "local" ]]; then
  ENV_FILE=.env.dev tsx src/scripts/export-meta-leads.ts "$EXPORT_DIR"
  exit 0
fi

if [[ "$SOURCE" == "dev" ]]; then
  PROJECT="andean-whatsapp-bot-dev"
  ENV_FILE=.env.dev
else
  PROJECT="andean-whatsapp-bot"
  ENV_FILE=.env.prod
fi

cleanup_container_export() {
  docker compose -p "$PROJECT" --env-file "$ENV_FILE" exec -T app rm -rf "$CONTAINER_DIR" >/dev/null 2>&1 || true
}
trap cleanup_container_export EXIT

docker compose -p "$PROJECT" --env-file "$ENV_FILE" exec -T app rm -rf "$CONTAINER_DIR"
docker compose -p "$PROJECT" --env-file "$ENV_FILE" exec -T app mkdir -p "$CONTAINER_DIR"
docker compose -p "$PROJECT" --env-file "$ENV_FILE" exec -T app node dist/scripts/export-meta-leads.js "$CONTAINER_DIR"
docker compose -p "$PROJECT" --env-file "$ENV_FILE" cp "app:$CONTAINER_DIR/." "$EXPORT_DIR/"

echo "Export copied to $EXPORT_DIR/"
