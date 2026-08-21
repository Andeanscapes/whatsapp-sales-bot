#!/usr/bin/env bash
# Recreate the local dev stack from scratch on every iteration:
#   1. tear down the dev project (containers + orphans; volumes are kept)
#   2. free the published port if a stray non-prod container holds it
#   3. warn when the WhatsApp token is expired/near expiry
#   4. rebuild the image and start ATTACHED with freshly read .env.dev values
#
# Why the teardown and --force-recreate matter: docker reads `env_file` only when a
# container is CREATED. Editing .env.dev while a container runs changes nothing, so a
# refreshed WHATSAPP_ACCESS_TOKEN keeps failing with an opaque HTTP 403 until the
# container is recreated.
#
# Logs: compose.test.yml sets `logging: driver: none`, so `docker compose logs` is
# empty by design. Running attached (no -d) is the log view — keep this in the
# foreground and Ctrl+C to stop.
#
# To wipe the SQLite state too: npm run docker:dev:db:clean (or docker:dev:clean).
# To force a cache-less image build:  NO_CACHE=1 npm run docker:dev
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROJECT="andean-whatsapp-bot-dev"
PROD_PROJECT="andean-whatsapp-bot"
ENV_FILE_PATH=".env.dev"

if [ ! -f "$ENV_FILE_PATH" ]; then
  echo "[docker:dev] missing $ENV_FILE_PATH — copy .env.example and fill it first" >&2
  exit 1
fi

compose() {
  ENV_FILE="$ENV_FILE_PATH" docker compose -p "$PROJECT" --env-file "$ENV_FILE_PATH" \
    -f compose.yml -f compose.test.yml "$@"
}

read_env_value() {
  # Last definition wins, mirroring dotenv. Never echoes secrets to stdout.
  grep -E "^$1=" "$ENV_FILE_PATH" 2>/dev/null | tail -1 | cut -d= -f2- || true
}

# ── 1. Kill everything from this project ────────────────────────────────────────
echo "[docker:dev] stopping $PROJECT stack (volumes kept)..."
compose down --remove-orphans

# ── 2. Free the port, without ever touching the prod stack ─────────────────────
PORT="$(read_env_value PORT | tr -d '[:space:]')"
PORT="${PORT:-3000}"
STRAY="$(docker ps -q --filter "publish=$PORT" 2>/dev/null || true)"
for container in $STRAY; do
  owner="$(docker inspect "$container" \
    --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
  name="$(docker inspect "$container" --format '{{.Name}}' 2>/dev/null | sed 's|^/||' || true)"
  if [ "$owner" = "$PROD_PROJECT" ]; then
    echo "[docker:dev] ABORT: the PROD stack ($name) is publishing port $PORT." >&2
    echo "[docker:dev] Stop it deliberately or change PORT in $ENV_FILE_PATH." >&2
    exit 1
  fi
  echo "[docker:dev] stopping stray container $name holding port $PORT..."
  docker stop "$container" >/dev/null
done

# ── 3. Token preflight (never blocks the run) ──────────────────────────────────
TOKEN="$(read_env_value WHATSAPP_ACCESS_TOKEN)"
GRAPH_VER="$(read_env_value WHATSAPP_GRAPH_API_VERSION | tr -d '[:space:]')"
if [ -n "$TOKEN" ]; then
  WHATSAPP_ACCESS_TOKEN="$TOKEN" GRAPH_VER="${GRAPH_VER:-v25.0}" node --input-type=module -e '
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const version = process.env.GRAPH_VER;
    const url = `https://graph.facebook.com/${version}/debug_token?input_token=${encodeURIComponent(token)}`;
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      const data = (await response.json())?.data;
      if (!data?.is_valid) {
        console.log("[docker:dev] WARNING: WhatsApp token is NOT valid — every send will fail with HTTP 403.");
      } else if (data.expires_at) {
        const hours = (data.expires_at * 1000 - Date.now()) / 3_600_000;
        const when = new Date(data.expires_at * 1000).toISOString();
        if (hours <= 0) console.log(`[docker:dev] WARNING: WhatsApp token EXPIRED at ${when}.`);
        else if (hours < 24) console.log(`[docker:dev] WARNING: WhatsApp token expires in ${hours.toFixed(1)}h (${when}). Use a System User token for a permanent one.`);
        else console.log(`[docker:dev] token ok (${data.type}), expires ${when}`);
      } else {
        console.log(`[docker:dev] token ok (${data.type}), no expiry`);
      }
    } catch {
      console.log("[docker:dev] token check skipped (no network / Graph API unreachable)");
    }
  ' || true
fi

# ── 4. Rebuild and start with fresh env values ─────────────────────────────────
if [ "${NO_CACHE:-0}" = "1" ]; then
  echo "[docker:dev] building image without cache..."
  compose build --no-cache app
fi

echo "[docker:dev] rebuilding image and starting attached with $ENV_FILE_PATH ..."
compose up --build --force-recreate
