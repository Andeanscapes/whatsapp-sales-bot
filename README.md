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

DeepSeek is the **primary reply source** for all customer messages. The system prompt (`src/prompts/deepseek-system.prompt.md`) includes business facts from the skill files as context. The LLM response is Zod-validated for structured output (reply, intent, lead score delta, image flag, human handoff).

### Dynamic Configuration

A remote JSON endpoint (`DYNAMIC_SKILL_URL`) provides live pricing, availability, and media images. Updated each new conversation without restarting the container. Falls back to static skill files when unavailable.

`https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json`

### Media & Images

- **Owner intro image** — sent automatically on first contact
- **Plan images** — sent when pricing is discussed, matched by selected plan
- **Gallery images** — sent when enough qualification fields are collected (up to `MAX_GALLERY_IMAGES_PER_SEND`, randomly selected)
- **72h deduplication** — same image never sent to the same customer twice in 72 hours
- Images sourced from the dynamic JSON; no static fallback

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

Media forwarding: inbound WhatsApp images, voice notes, and videos are forwarded to the agent's Telegram chat. Operators can reply with images from Telegram.

### Lead Routing (Multi-Line)

- Weighted lead distribution across multiple sales lines (bridge and referral)
- Sticky assignment — leads stay on their assigned line
- `BRIDGE_FLOW` config controls traffic split (0-100%)

### Cost Guards

| Guard | Default | Config |
|-------|---------|--------|
| Daily AI budget | $1.00 | `DAILY_AI_BUDGET_USD` |
| Monthly AI budget | $20.00 | `MONTHLY_AI_BUDGET_USD` |
| AI calls/customer/day | 12 | `MAX_AI_CALLS_PER_CUSTOMER_PER_DAY` |
| AI calls global/day | 300 | `MAX_AI_CALLS_GLOBAL_PER_DAY` |
| Messages/customer/hour | 50 | `MAX_BOT_MESSAGES_PER_CUSTOMER_PER_HOUR` |
| Messages/customer/day | 120 | `MAX_BOT_MESSAGES_PER_CUSTOMER_PER_DAY` |
| Images/customer/72h | 1 | `media-service.ts` |
| Gallery images/send | 10 | `MAX_GALLERY_IMAGES_PER_SEND` |

When limits are hit, the bot alerts the owner via Telegram and stops replying after two guard replies to prevent message loops.

### Opt-Out

Customers can opt out of automated messages at any time. Keywords are detected in both Spanish and English.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Watch mode with tsx |
| `npm run dev:env` | Watch mode with `.env.dev` |
| `npm run build` | Compile TypeScript + copy assets to `dist/` |
| `npm start` | Run from `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint over `src/` |
| `npm test` | Vitest (328 tests) |
| `npm run simulate -- "<text>"` | Offline response engine test |
| `npm run validate:skills` | Validate all JSON skill files |
| `npm run validate:prompt` | Validate system prompt |
| `npm run validate:dynamic` | Validate dynamic JSON file |
| `npm run scan:secrets` | Secretlint scan (run before commits) |
| `npm run db:clean` | Remove local SQLite |
| `npm run export:transcripts` | Export conversations as JSONL |
| `npm run export:debug-bundle` | Debug tarball (logs, transcripts, status) |
| `npm run docker:dev` | Docker Compose with `.env.dev` |
| `npm run docker:prod` | Docker Compose with `.env.prod` + Cloudflare tunnel |
| `npm run start:tunnel` | Start Cloudflare tunnel locally |

## Environment

All variables are listed in [.env.example](.env.example). Key required vars:

- `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`
- `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`
- `DEEPSEEK_API_KEY`
- `OWNER_NAME`, `PARTNER_NAME` — interpolated into skill files and system prompt
- `OWNER_PERSONAL_WHATSAPP_NUMBER`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — for Telegram alerts and bridge
- `DYNAMIC_SKILL_URL` — optional remote JSON for live pricing/availability/media

Startup fails loudly if any required variable is missing (zod validation).

Never commit `.env` — it is gitignored.

## Deployment

**Production env file:** `/etc/andean-whatsapp-bot.env` (mode `0600`).
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

```bash
npm run docker:prod
```

Multi-container setup with Cloudflare Tunnel profile, Docker volume for SQLite, and log rotation. See [deploy/docker-compose.md](deploy/docker-compose.md).

## Testing

```bash
npm run typecheck && npm run lint && npm test && npm run build
npm run simulate -- "Hola, cuanto vale el tour?"
```

328 tests cover: response engine, lead scoring, deterministic FAQ, budget guard, post-handoff forwarding, dynamic data validation, media service, webhook processing, HMAC verification, Telegram bridge, and alert delivery.

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
