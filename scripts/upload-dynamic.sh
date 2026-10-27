#!/usr/bin/env bash
set -euo pipefail

# Publish a catalog to R2. Thin wrapper over `npm run dynamic:push`.
#
# Usage:
#   ./scripts/upload-dynamic.sh [dev|prod] [--dry-run] [--force] [--confirm]
#
# Default target: dev. Prod needs --confirm.
# Credentials: .env.wrangler (see .env.wrangler.example).

TARGET="${1:-dev}"
ARGS=("${@:2}")

exec npm run dynamic:push -- --target "$TARGET" "${ARGS[@]+"${ARGS[@]}"}"
