#!/usr/bin/env bash
set -euo pipefail

# Production docker compose launcher. Always uses .env.prod.
# Cloudflare tunnel auto-starts when CLOUDFLARE_TUNNEL_TOKEN is set in .env.prod.
#
# A SQLite backup runs before the containers are stopped. If it fails, nothing is
# stopped or rebuilt.
#
# Usage:
#   $(basename "$0")                   # backup + app + tunnel (prod)
#   $(basename "$0") --build-only       # build image, don't start
#   $(basename "$0") --no-logs          # start only, don't follow logs
#   $(basename "$0") --skip-backup      # skip the pre-restart backup

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE=.env.prod
export ENV_FILE
COMPOSE_PROJECT=andean-whatsapp-bot
export COMPOSE_PROJECT

BUILD_ONLY=false
FOLLOW_LOGS=true
SKIP_BACKUP=false

for arg in "$@"; do
  case "$arg" in
    --build-only) BUILD_ONLY=true ;;
    --no-logs) FOLLOW_LOGS=false ;;
    --skip-backup) SKIP_BACKUP=true ;;
    *) echo "Unknown flag: $arg" && exit 1 ;;
  esac
done

if $SKIP_BACKUP; then
  echo "=== Skipping pre-restart backup (--skip-backup) ==="
else
  echo "=== Backing up SQLite before stopping containers ==="
  bash "$SCRIPT_DIR/../deploy/backup-db.sh"
fi

echo "=== Building Docker image ==="
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" build

if $BUILD_ONLY; then
  echo "=== Build complete (not starting) ==="
  exit 0
fi

echo "=== Stopping existing containers ==="
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" down --remove-orphans

echo "=== Starting prod containers ==="
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" --profile tunnel up -d --force-recreate

echo "=== Checking health ==="
HEALTHY=false
for _ in {1..15}; do
  if curl -sf http://127.0.0.1:3000/health; then
    echo ""
    HEALTHY=true
    break
  fi
  sleep 2
done
if ! $HEALTHY; then
  echo "Health check failed"
  exit 1
fi

echo "=== Done ==="

if $FOLLOW_LOGS; then
  echo "=== Following app logs (Ctrl+C to stop watching; containers keep running) ==="
  docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" logs -f app
fi
