#!/usr/bin/env bash
# Wipe local docker-dev SQLite volume(s). Never touches prod project volumes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROJECT="andean-whatsapp-bot-dev"

echo "[docker:dev:db:clean] stopping $PROJECT stack and removing declared volumes..."
ENV_FILE=.env.dev docker compose -p "$PROJECT" --env-file .env.dev -f compose.yml -f compose.test.yml down -v --remove-orphans

# Catch leftovers from alternate project names / old compose layouts.
# Keep prod volumes (andean-whatsapp-bot / andean-whatsapp-bot-data) intact.
LEFTOVERS="$(docker volume ls -q 2>/dev/null | grep -E '^(andean-whatsapp-bot-dev_.+|whatsapp-sales-bot_bot-data-test)$' || true)"

if [ -n "$LEFTOVERS" ]; then
  echo "[docker:dev:db:clean] removing leftover volumes:"
  echo "$LEFTOVERS" | sed 's/^/  /'
  # shellcheck disable=SC2086
  echo "$LEFTOVERS" | xargs docker volume rm
else
  echo "[docker:dev:db:clean] no leftover dev volumes"
fi

REMAINING="$(docker volume ls -q 2>/dev/null | grep -E 'bot-data' || true)"
if [ -n "$REMAINING" ]; then
  echo "[docker:dev:db:clean] remaining bot-data volumes (untouched):"
  echo "$REMAINING" | sed 's/^/  /'
fi

echo "[docker:dev:db:clean] done — next npm run docker:dev starts with empty SQLite"
