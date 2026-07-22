#!/usr/bin/env bash
set -euo pipefail
umask 077

ENV_FILE=.env.prod
export ENV_FILE
COMPOSE_PROJECT=andean-whatsapp-bot-prod

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE_DIR="exports/prod-debug-${STAMP}"
TRANSCRIPT_DIR="/tmp/andean-transcripts"

mkdir -p "$BASE_DIR"
chmod 700 exports "$BASE_DIR"

echo "=== Exporting app logs ==="
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" logs --no-color app > "$BASE_DIR/app.log"

echo "=== Exporting tunnel logs ==="
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" logs --no-color cloudflared > "$BASE_DIR/cloudflared.log" 2>/dev/null || true

echo "=== Exporting conversation transcripts ==="
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" exec -T app rm -rf "$TRANSCRIPT_DIR"
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" exec -T app mkdir -p "$TRANSCRIPT_DIR"
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" exec -T app node dist/scripts/export-transcripts.js "$TRANSCRIPT_DIR" > "$BASE_DIR/transcripts-export.txt"
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" cp "app:$TRANSCRIPT_DIR/." "$BASE_DIR/"

echo "=== Writing container status ==="
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" ps > "$BASE_DIR/containers.txt"

echo "=== Creating archive ==="
tar -czf "${BASE_DIR}.tar.gz" -C exports "prod-debug-${STAMP}"

echo "bundle=${BASE_DIR}.tar.gz"
