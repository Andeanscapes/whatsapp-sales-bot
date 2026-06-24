#!/usr/bin/env bash
set -euo pipefail

# Production docker compose launcher. Always uses .env.prod.
# Cloudflare tunnel auto-starts when CLOUDFLARE_TUNNEL_TOKEN is set in .env.prod.
#
# Usage:
#   $(basename "$0")                   # app + tunnel (prod)
#   $(basename "$0") --build-only       # build image, don't start
#   $(basename "$0") --no-logs          # start only, don't follow logs

ENV_FILE=.env.prod
export ENV_FILE

BUILD_ONLY=false
FOLLOW_LOGS=true

for arg in "$@"; do
  case "$arg" in
    --build-only) BUILD_ONLY=true ;;
    --no-logs) FOLLOW_LOGS=false ;;
    *) echo "Unknown flag: $arg" && exit 1 ;;
  esac
done

echo "=== Stopping existing containers ==="
docker rm -f andean-whatsapp-bot andean-whatsapp-tunnel 2>/dev/null || true
docker compose --env-file "$ENV_FILE" down --remove-orphans 2>/dev/null || true

echo "=== Building Docker image ==="
docker compose --env-file "$ENV_FILE" build

if $BUILD_ONLY; then
  echo "=== Build complete (not starting) ==="
  exit 0
fi

echo "=== Starting prod containers ==="
docker compose --env-file "$ENV_FILE" --profile tunnel up -d --build --force-recreate

echo "=== Checking health ==="
sleep 2
curl -sf http://127.0.0.1:3000/health && echo "" || echo "Health check failed"

echo "=== Done ==="

if $FOLLOW_LOGS; then
  echo "=== Following app logs (Ctrl+C to stop watching; containers keep running) ==="
  docker compose --env-file "$ENV_FILE" logs -f app
fi
