#!/usr/bin/env bash
set -euo pipefail

EXPORT_DIR="exports"
CONTAINER_DIR="/tmp/andean-transcripts"

mkdir -p "$EXPORT_DIR"
docker compose exec app rm -rf "$CONTAINER_DIR"
docker compose exec app mkdir -p "$CONTAINER_DIR"
docker compose exec app node dist/scripts/export-transcripts.js "$CONTAINER_DIR"
docker cp "andean-whatsapp-bot:$CONTAINER_DIR/." "$EXPORT_DIR/"

echo "Export copied to $EXPORT_DIR/"
