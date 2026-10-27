#!/usr/bin/env bash
set -euo pipefail

# Pull a live catalog from R2. Thin wrapper over `npm run dynamic:pull`.
#
# Usage:
#   ./scripts/download-dynamic.sh [dev|prod] [--force]
#
# Default target: dev. Writes scripts/bot-dynamic-dev.json or scripts/bot-dynamic.json.

TARGET="${1:-dev}"
ARGS=("${@:2}")

exec npm run dynamic:pull -- --target "$TARGET" "${ARGS[@]+"${ARGS[@]}"}"
