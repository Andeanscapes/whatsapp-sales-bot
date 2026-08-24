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
  RUNNING_SERVICES="$(docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" ps --status running --services)"
  if printf '%s\n' "$RUNNING_SERVICES" | grep -qx app; then
    echo "=== Backing up SQLite before stopping containers ==="
    bash "$SCRIPT_DIR/../deploy/backup-db.sh"
  else
    echo "=== No running app container, nothing to back up ==="
  fi
fi

echo "=== Stopping existing containers ==="
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" down --remove-orphans 2>/dev/null || true

echo "=== Building Docker image ==="
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" build

if $BUILD_ONLY; then
  echo "=== Build complete (not starting) ==="
  exit 0
fi

echo "=== Starting prod containers ==="
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" --profile tunnel up -d --build --force-recreate

echo "=== Checking health ==="
sleep 2
curl -sf http://127.0.0.1:3000/health && echo "" || echo "Health check failed"

echo "=== Done ==="

if $FOLLOW_LOGS; then
  echo "=== Following app logs (Ctrl+C to stop watching; containers keep running) ==="
  docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" logs -f app
fi
