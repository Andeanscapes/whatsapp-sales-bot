#!/usr/bin/env bash
set -euo pipefail

# Test docker compose launcher. Always uses .env.dev with compose.test.yml override.
# - No log disk retention (json-file driver, logs gone when container stops)
# - Isolated SQLite DB (completely separate from prod, preserved by default)
# - No auto-restart
# - No Cloudflare tunnel
#
# Usage:
#   $(basename "$0")                   # app only (test mode)
#   $(basename "$0") --build-only       # build image, don't start
#   $(basename "$0") --no-logs          # start only, don't follow logs
#   $(basename "$0") --clean            # delete test DB volume before starting

ENV_FILE=.env.dev
export ENV_FILE
COMPOSE_PROJECT=andean-whatsapp-bot-test

COMPOSE_FILES="-f compose.yml -f compose.test.yml"

BUILD_ONLY=false
FOLLOW_LOGS=true
CLEAN=false

for arg in "$@"; do
  case "$arg" in
    --build-only) BUILD_ONLY=true ;;
    --no-logs) FOLLOW_LOGS=false ;;
    --clean) CLEAN=true ;;
    *) echo "Unknown flag: $arg" && exit 1 ;;
  esac
done

echo "=== Stopping existing test containers ==="
if $CLEAN; then
  docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" $COMPOSE_FILES down --remove-orphans --volumes 2>/dev/null || true
else
  docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" $COMPOSE_FILES down --remove-orphans 2>/dev/null || true
fi

echo "=== Building Docker image ==="
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" $COMPOSE_FILES build

if $BUILD_ONLY; then
  echo "=== Build complete (not starting) ==="
  exit 0
fi

echo "=== Starting test containers (no log retention, force recreate) ==="
docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" $COMPOSE_FILES up -d --build --force-recreate

echo "=== Checking health ==="
sleep 2
curl -sf http://127.0.0.1:3000/health && echo "" || echo "Health check failed"

echo "=== Done ==="

if $FOLLOW_LOGS; then
  echo "=== Following app logs (Ctrl+C to stop; containers keep running) ==="
  docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" $COMPOSE_FILES logs -f app
fi
