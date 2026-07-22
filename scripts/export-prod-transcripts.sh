#!/usr/bin/env bash
set -euo pipefail
umask 077

EXPORT_DIR="exports"
CONTAINER_DIR="/tmp/andean-transcripts"
ENV_FILE=".env.prod"
COMPOSE_PROJECT="andean-whatsapp-bot-prod"

mkdir -p "$EXPORT_DIR"
chmod 700 "$EXPORT_DIR"
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" exec -T app rm -rf "$CONTAINER_DIR"
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" exec -T app mkdir -p "$CONTAINER_DIR"
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" exec -T app node dist/scripts/export-transcripts.js "$CONTAINER_DIR"
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" cp "app:$CONTAINER_DIR/." "$EXPORT_DIR/"

echo "Export copied to $EXPORT_DIR/"
