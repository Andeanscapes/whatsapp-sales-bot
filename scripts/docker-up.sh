#!/usr/bin/env bash
set -euo pipefail

# Rebuild and start the app. Run after code changes.
#
# Usage:
#   $(basename "$0")                   # app only
#   $(basename "$0") --tunnel           # app + Cloudflare Tunnel
#   $(basename "$0") --build-only       # build image, don't start

BUILD_ONLY=false
PROFILE=""

for arg in "$@"; do
  case "$arg" in
    --tunnel) PROFILE="--profile tunnel" ;;
    --build-only) BUILD_ONLY=true ;;
    *) echo "Unknown flag: $arg" && exit 1 ;;
  esac
done

echo "=== Building Docker image ==="
docker compose build

if $BUILD_ONLY; then
  echo "=== Build complete (not starting) ==="
  exit 0
fi

echo "=== Restarting containers ==="
docker compose $PROFILE up -d --build

echo "=== Checking health ==="
sleep 2
curl -sf http://127.0.0.1:3000/health && echo "" || echo "Health check failed"

echo "=== Done ==="
