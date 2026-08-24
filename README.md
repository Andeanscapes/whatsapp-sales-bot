# Andean Scapes WhatsApp Sales Bot

Self-hosted WhatsApp sales assistant for a small tour-operator business. Receives messages via the WhatsApp Business Cloud API, replies with a DeepSeek-backed conversational agent, scores leads, enforces budget and rate guards, and alerts the human owner on hot leads via Telegram.

Runs on a single Node 24 process behind a Cloudflare Tunnel. No cloud dependencies beyond the WhatsApp Cloud API and the DeepSeek API.

## Architecture

```
Mini PC (Fedora) → Node 24 + Fastify → Cloudflare Tunnel → WhatsApp Cloud API
                 ↓
             Repositories (SQLite via better-sqlite3)
                 ↓
       JSON skill files (business source of truth)
                 ↓
         Product Registry (typed access to experiences/plans)
```

See [AGENTS.md](AGENTS.md) for full architecture invariants, implementation phases, and contributor rules.

## Quickstart

Requires Node 24+ and `npm`.

```bash
git clone git@github.com:andeanscapes01/whatsapp-sales-bot.git
cd whatsapp-sales-bot
npm install
cp .env.example .env
# Fill .env with your real values (see .env.example for all required vars)
npm run build
npm start
```

`GET /health` returns `{ ok: true, uptime, db: "ok" }` on `127.0.0.1:3000`.

## Features

### Conversational AI

DeepSeek is the **primary reply source** for all customer messages. `skills-prompt-assembly.ts` is the sole prompt builder. It assembles `seller-personality`, `entry-strategy`, `cold-info-handler`, `whatsapp-sales`, and `andean-scapes` skill MD files, anonymous referent packs, live CATALOGO/DATOS, and per-request RUNTIME context. `entry-strategy` must precede `cold-info-handler`.

### Dynamic Configuration

A remote JSON endpoint (`DYNAMIC_SKILL_URL`) is the product source of truth: experiences, sites, plans, pricing, routes, availability, media, payment policy, and campaign `entrySegments`. It refreshes without restarting the container. When live data is stale or unavailable, price/date replies fail closed; the static `andean-scapes.skill.json` is brand-only and is not a product fallback.

`https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json`

### Media & Images

- **LLM gallery** — the model emits `[[FOTOS:<theme>]]` when the customer asks for photos or first selects a concrete plan; runtime strips the marker and sends up to 5 site-scoped photos. The last one carries the unchanged reply as its caption
- **Plan images** — sent when pricing is discussed, matched by selected plan
- **Contextual images** — one themed photo captioning the reply, on non-price later turns
- **Owner intro image** — structurally supported but currently disabled pending sales strategy review
- **72h deduplication** — same image never sent to the same customer twice in 72 hours; an explicitly requested repeat is allowed but still claimed atomically
- Images sourced from the dynamic JSON; no static fallback. Untyped gallery images can never be selected
- No bot-authored copy ever wraps the photos — the caption is the model's own text

### Lead Scoring & Owner Alerts

- Real-time lead scoring from conversation signals
- **Three alert channels** (configurable via `ALERT_CHANNEL`):
  - **Telegram** (primary) — formatted alert with score, customer info, intent, last message
  - **WhatsApp** — to owner's personal number (max 1/customer/day)
  - **Log** — JSON log-only
- Tiered thresholds: HOT (≥85), URGENT (≥95)
- Deduplicated — no repeat alerts for same customer + type per day
- Alert fallback chain: agent Telegram → owner Telegram

### Telegram Bridge (Human Handoff)

Full-duplex Telegram bot for operators to take over conversations:

| Command | Description |
|---------|-------------|
| `/chat <phone>` | View full conversation history |
| `/lead <phone>` | View lead details and score |
| `/customer <phone>` | View customer record |
| `/send <phone> <text>` | Send WhatsApp reply as agent |
| `/end <phone>` | End bridge session |
| `/recent` | List recently active conversations |
| `/leads` | List hot leads |
| `/phases` | Conversation phase breakdown |
| `/block <phone>` | Block/unblock a customer |
| `/pause` | Pause bot (broadcasts to all lines) |
| `/resume` | Resume bot |
| `/booking <phone>` | Toggle booking mode |
| `/status` | Show system status |
| `/stats` | Daily stats per line |
| `/report` | Daily lead-count report |
| `/delete <phone>` | Delete conversation |
| `/start` | Register agent with bot |
| `/stopall <phone>` | Silence bot for a customer (alias of `/stopbot`) |

Media forwarding: inbound WhatsApp images, voice notes, and videos are forwarded to the agent's Telegram chat. Operators can reply with images from Telegram.

### Lead Routing (Multi-Line)

- Weighted lead distribution across multiple sales lines (bridge and referral)
- Sticky assignment — leads stay on their assigned line
- `BRIDGE_FLOW` config controls traffic split (0-100%)

### Cost Guards

| Guard | Default | Config |
|-------|---------|--------|
| Daily AI budget | $2.00 | `DAILY_AI_BUDGET_USD` |
| Monthly AI budget | $30.00 | `MONTHLY_AI_BUDGET_USD` |
| AI calls/customer/day | 30 | `MAX_AI_CALLS_PER_CUSTOMER_PER_DAY` |
| AI calls global/day | 1500 | `MAX_AI_CALLS_GLOBAL_PER_DAY` |
| Reply output tokens | 800 | `DEEPSEEK_MAX_OUTPUT_TOKENS` |
| Conversation history | 12,000 chars | `DEEPSEEK_HISTORY_MAX_CHARS` |
| Model context window | 65,536 tokens | `DEEPSEEK_CONTEXT_WINDOW_TOKENS` |
| Messages/customer/hour | 50 | `MAX_BOT_MESSAGES_PER_CUSTOMER_PER_HOUR` |
| Messages/customer/day | 120 | `MAX_BOT_MESSAGES_PER_CUSTOMER_PER_DAY` |
| Same image/customer/72h | 1 | `media-service.ts` (per-image claim, not a global image cap) |
| Gallery images/send | 5 hard cap | `MAX_GALLERY_IMAGES_PER_SEND`, clamped to 5 |
| Requested-photo repeat window | 5 min | `media-service.ts` |

When limits are hit, the bot alerts the owner via Telegram and stops replying after two guard replies to prevent message loops.

### Follow-Ups & Post-24h Re-Engagement

Conversation is natural-inbound only. Automated outbound is limited to three
independently-switched paths, all off by default:

1. **One-shot post-24h template** (`ALLOW_FOLLOWUP_TEMPLATE`) — one Meta-approved
   template after `FOLLOWUP_HOURS_AFTER_INBOUND` of silence. Requires
   operator-granted consent (`/followupgrant <phone>`, revocable). Exactly one
   delivered send per customer, enforced by a transactional claim. No LLM text.
2. **Consent ask** (`FOLLOWUP_CONSENT_ASK_ENABLED`) — a short free-form message
   inside the 24h window asking permission to write later. The model writes it; the
   engine only validates it and strips the internal marker.
3. **Recurring template** (`FOLLOWUP_RECURRING_ENABLED`) — approved template sent
   only after the customer explicitly says yes, with gaps multiplying by 3 and a
   hard cap (`FOLLOWUP_MAX_RECURRING_SENDS`).

All three require a collected qualification field (plan or group size), are never
sent over an unanswered inbound, and skip opted-out/booked/handed-off leads. Silence
is never treated as consent. Template sends are skipped (never substituted) when the
plan name or required header image cannot be resolved from the product registry.

### Opt-Out

Customers can opt out of automated messages at any time. Keywords are detected in
Spanish (usted and tú/vos forms, accent-insensitive) and English, and an opt-out
is honoured even for booked leads.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Watch mode with tsx |
| `npm run dev:env` | Watch mode with `.env.dev` |
| `npm run build` | Compile TypeScript + copy assets to `dist/` |
| `npm start` | Run from `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint over `src/` |
| `npm test` | Vitest unit suite |
| `npm run eval:conversations` | Deterministic conversation-eval pack (31 scenarios) |
| `npm run eval:conversations:llm-bot` | Live LLM conversation-eval (20 `live` scenarios, ~$0.37) |
| `npm run simulate -- "<text>"` | Offline response engine test |
| `npm run validate:skills` | Validate all JSON skill files |
| `npm run validate:prompt` | Validate system prompt (no commercial literals in skill MD) |
| `npm run validate:dynamic` | Validate dynamic JSON file |
| `npm run scan:secrets` | Secretlint scan (run before commits) |
| `npm run db:clean` | Remove local SQLite |
| `npm run export:transcripts` | Export conversations as JSONL |
| `npm run export:debug-bundle` | Debug tarball (logs, transcripts, status) |
| `npm run docker:dev` | Tear down + rebuild image + recreate dev stack from `.env.dev` (attached) |
| `npm run docker:dev:db:clean` | Stop dev stack and wipe its SQLite volume |
| `npm run docker:dev:clean` | `docker:dev:db:clean` then `docker:dev` |
| `npm run docker:prod` | Backup SQLite, then recreate production Docker stack |
| `npm run start:tunnel` | Start Cloudflare tunnel locally (raw, no sync) |
| `npm run dev:tunnel` | Start a fresh quick tunnel **and** sync `.env.dev` + Meta webhook |
| `npm run dev:tunnel:sync` | Sync `.env.dev` + Meta webhook from an already-running tunnel |

### Local iteration loop

```bash
npm run docker:dev:db:clean   # only when you want a clean conversation state
npm run docker:dev            # kill + rebuild + recreate with fresh .env.dev values
```

`docker:dev` always tears the dev project down first and recreates it, because
compose reads `env_file` **only when a container is created** — editing `.env.dev`
next to a running container changes nothing, and a refreshed
`WHATSAPP_ACCESS_TOKEN` keeps failing with an opaque HTTP 403 until the container is
recreated. It also refuses to steal the port from the prod project, and prints a
warning when the WhatsApp token is expired or expires within 24h (a short-lived
Graph API Explorer token is the usual cause of sudden 403s; use a System User token
for a permanent one).

It runs **attached on purpose**: `compose.test.yml` sets `logging: driver: none`, so
`docker compose logs` is empty by design and the foreground stream is the only log
view. Ctrl+C stops the stack. Use `NO_CACHE=1 npm run docker:dev` to force a
cache-less image build.

### Dev quick-tunnel loop

A `cloudflared tunnel --url` quick tunnel mints a **new random hostname on every
start**, so each session otherwise needs two manual fixes: `PUBLIC_BASE_URL` and
the Meta webhook callback. `npm run dev:tunnel` does both.

```bash
# 1. stop any previous tunnel first — two concurrent quick tunnels from one IP
#    register a hostname but Cloudflare only routes the first
pkill -f 'cloudflared tunnel'

# 2. fresh tunnel + writes PUBLIC_BASE_URL into .env.dev
npm run dev:tunnel

# 3. recreate the container: compose bakes env vars at CREATE time,
#    so `docker restart` keeps the stale URL
npm run docker:dev

# 4. app is now up, so let Meta verify the callback
npm run dev:tunnel:sync
```

Step 4 is separate because Meta fetches the callback during registration and
rejects it with `(#2200)` if the app is not answering yet. The script detects
this and skips instead of burning a failed attempt.

The Meta sync needs `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, and
`WHATSAPP_VERIFY_TOKEN`; `app_id` is resolved from `debug_token`, so no extra env
var is required. Use `--no-meta` to skip it. The script also reports the access
token's remaining lifetime — a temporary 24h token surfaces as
`autorizacion rechazada` (401/403) once it lapses, so prefer a System User token.

## Environment

All variables are listed in [.env.example](.env.example). Key required vars:

- `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`
- `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`
- `DEEPSEEK_API_KEY`
- `OWNER_NAME`, `PARTNER_NAME` — interpolated into skill files and system prompt
- `OWNER_PERSONAL_WHATSAPP_NUMBER`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — for Telegram alerts and bridge
- `DYNAMIC_SKILL_URL` — optional remote JSON for live pricing/availability/media
- `MESSAGE_DELAY` — optional human-like send pacing (`true` in prod). Defaults `false`. Must be set explicitly on the host env file (gitignored `.env.prod` / `/etc/andean-whatsapp-bot.env`); schema default is off.

Startup fails loudly if any required variable is missing (zod validation).

Never commit `.env` — it is gitignored.

## Deployment

**Production env file:** `/etc/andean-whatsapp-bot.env` (mode `0600`). Include `MESSAGE_DELAY=true` there when enabling human-like pacing.
**SQLite database:** `/var/lib/andean-whatsapp-bot/bot.sqlite`.

### Fedora (systemd)

```bash
sudo bash deploy/install-fedora.sh
```

Deploys as a systemd service with hardening (`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`) and Cloudflare Tunnel.

Update in place:

```bash
bash deploy/update-app.sh
```

### Docker

Docker deployment reads the repository-local `.env.prod` file.

```bash
sudo install -d -m 700 -o "$USER" -g "$(id -gn)" /var/backups/andean-whatsapp-bot
npm run docker:prod
```

The backup directory setup is required once per host. Multi-container setup uses a
Cloudflare Tunnel profile, persistent SQLite volume, and log rotation. See
[deploy/docker-compose.md](deploy/docker-compose.md).

## Testing

```bash
npm run typecheck && npm run lint && npm test && npm run build
npm run simulate -- "Hola, cuanto vale el tour?"
```

810 tests cover: response engine, lead scoring, budget guard, post-handoff forwarding, dynamic data validation, skills prompt assembly, media service, webhook processing, HMAC verification, Telegram bridge, and alert delivery.

## Security

- Zod-enforced env validation — no silent placeholder fallbacks
- Webhook HMAC SHA-256 verification (`X-Hub-Signature-256`) with constant-time comparison
- Secrets never logged (`WHATSAPP_ACCESS_TOKEN`, `DEEPSEEK_API_KEY`, `WHATSAPP_APP_SECRET`, `TELEGRAM_BOT_TOKEN`)
- Fastify binds to `127.0.0.1` only
- `.gitignore` excludes `.env`, `data/`, `*.sqlite*`, `dist/`, IDE state
- Pre-commit secret scan via `npm run scan:secrets`
- Token-substituted owner identity — real names ship via env, not source

## License

[MIT](LICENSE)
