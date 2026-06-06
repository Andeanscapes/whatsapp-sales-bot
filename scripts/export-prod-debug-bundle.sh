#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=.env.prod
export ENV_FILE

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE_DIR="exports/prod-debug-${STAMP}"
TRANSCRIPT_DIR="/tmp/andean-transcripts"

mkdir -p "$BASE_DIR"

echo "=== Exporting app logs ==="
docker compose --env-file "$ENV_FILE" logs --no-color app > "$BASE_DIR/app.log"

echo "=== Exporting tunnel logs ==="
docker compose --env-file "$ENV_FILE" logs --no-color cloudflared > "$BASE_DIR/cloudflared.log" 2>/dev/null || true

echo "=== Exporting conversation transcripts ==="
docker compose --env-file "$ENV_FILE" exec app rm -rf "$TRANSCRIPT_DIR"
docker compose --env-file "$ENV_FILE" exec app mkdir -p "$TRANSCRIPT_DIR"
docker compose --env-file "$ENV_FILE" exec app node dist/scripts/export-transcripts.js "$TRANSCRIPT_DIR" > "$BASE_DIR/transcripts-export.txt"
docker cp "andean-whatsapp-bot:$TRANSCRIPT_DIR/." "$BASE_DIR/"

echo "=== Writing container status ==="
docker compose --env-file "$ENV_FILE" ps > "$BASE_DIR/containers.txt"

echo "=== Creating archive ==="
tar -czf "${BASE_DIR}.tar.gz" -C exports "prod-debug-${STAMP}"

echo "bundle=${BASE_DIR}.tar.gz"
