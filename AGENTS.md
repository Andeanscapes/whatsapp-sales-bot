# Andean Scapes WhatsApp Sales Bot — Agent Instructions

## Repo

- Remote: `git@github.com:andeanscapes01/whatsapp-sales-bot.git`
- Branch: `main` (no `origin/main` yet — first push creates it)
- Token/prod env file: `/etc/andean-whatsapp-bot.env` (never commit)
- SQLite runtime path: `/var/lib/andean-whatsapp-bot/bot.sqlite`

## Architecture

```
Mini PC (Fedora 44) → Node 24 + Fastify → Cloudflare Tunnel → WhatsApp Cloud API
                     ↓
         Repositories (SQLite via better-sqlite3)
                     ↓
           JSON skill files (business source of truth)
                     ↓
           Product Registry (typed access to experiences/plans)
```

### Architecture Invariants (do NOT violate)

1. **Single source of truth:** `andean-scapes.skill.json` is the sole source of business facts (plans, pricing, route, availability, FAQs). Never hardcode business reply text in TypeScript.
2. **Product registry:** Always access experience data via `src/services/product-registry.ts`. Never access `skills.andeanScapes.experiences[0]` directly.
3. **Repository seam:** All database access goes through `src/db/repositories/` interfaces. Never write raw `db.prepare(...)` SQL in service or route files.
4. **No MySQL:** The bot uses SQLite via `better-sqlite3`. There is no MySQL/Postgres dependency. A future DB swap requires writing a new repository implementation.
5. **Fully typed skills:** Skill JSON is validated with strict zod schemas (no `.passthrough()`). The compiler enforces the contract between JSON and code.

### Multi-Agent Guardrails

- One phase per PR. Never combine phases.
- Run `npm run typecheck && npm run lint && npm test && npm run build` after each change. Stop on red.
- The 125 existing tests in `src/tests/` are the regression safety net. Never weaken them.
- Simulate snapshot at `npm run simulate -- "Hola, cuanto vale el tour?"` must produce identical output unless explicitly noted.
- Never use `any`. Never weaken existing zod/HMAC/pino-redact configs.
- Never log `WHATSAPP_ACCESS_TOKEN`, `DEEPSEEK_API_KEY`, `ADMIN_SECRET`, `WHATSAPP_APP_SECRET`, or `TELEGRAM_BOT_TOKEN`.
- Bind Fastify to `127.0.0.1` only. No external port binding.

## Implementation phases (do in order)

### Phase 1 — Local skeleton

1. Init a Node 24 + TypeScript project in this directory (NOT in a subdirectory).
2. `package.json`: type `module`, scripts (`build`, `start`, `dev`, `typecheck`, `lint`, `test`, `simulate`), deps: `fastify`, `better-sqlite3`, `zod`, `pino`, `dotenv`.
3. `tsconfig.json`: strict, `target=ES2024`, `module=NodeNext`, `outDir=dist`, `rootDir=src`. Vitest/esbuild transform overrides to ES2022 only (Vitest 2 does not recognize ES2024 yet); production `tsc` still emits ES2024.
4. `src/config/env.ts`: zod schema for ALL env vars from the plan (sections 9, 6.3). Export typed `env` object loaded at startup.
5. `src/server.ts`: create Fastify, register pino, register health route, start on `127.0.0.1:PORT`.
6. `src/routes/health.route.ts`: `GET /health` returns `{ok: true, uptime: process.uptime()}`.
7. `src/db/schema.sql`: all tables from section 13 (conversations, messages, processed_webhook_messages, ai_cache, ai_usage, owner_alerts, media_sends).
8. `src/db/migrate.ts`: read `schema.sql`, create SQLite DB at `SQLITE_PATH` env using `better-sqlite3`, run the DDL.
9. Call `migrate()` at server startup before `fastify.listen()`.
10. `.env.example`: exact copy of section 9 env vars.
11. `npm run build` works; `npm start` boots Fastify and `/health` returns ok.

### Phase 2 — Skill files + validation

1. Create `src/data/andean-scapes.skill.json` — exact copy from section 10.
2. Create `src/data/sales-strategy.skill.json` — exact copy from section 11.
3. Create `src/data/media.skill.json` — exact copy from section 12.
4. Create `src/data/fallback-replies.json`:
   ```json
   {
     "es": {
       "optOutConfirmation": "Entendido. No enviaremos mas mensajes automaticos. Si necesitas ayuda mas adelante, puedes escribirnos de nuevo."
     },
     "en": {
       "optOutConfirmation": "Understood. We won't send more automated messages. If you need help later, you can message us again."
     }
   }
   ```
5. Create `src/services/skill-loader.ts`: reads all JSON skill files at startup, validates with zod schemas, exports typed objects. Crash startup if any file fails validation.
6. `src/scripts/validate-skill.ts`: CLI script that runs skill-loader only (no server). Used to validate skill files in CI.

### Phase 3 — Deterministic bot (no AI, no WhatsApp)

> **Note:** deterministic FAQ (`findIntent`) is kept for scoring/tests but is NOT called in the live reply path. All customer replies come from DeepSeek.

1. `src/services/deterministic-faq.ts`: keyword matching against `commonQuestions`. Used for tests and lead scoring only.
2. `src/services/lead-scoring.ts`: match against signals/negativeSignals from sales-strategy.
3. `src/services/response-engine.ts`: orchestrates flow (opt-out → store → language → scoring → limits → budget → DeepSeek → reply → alert). DeepSeek is the sole reply source.
4. `src/services/opt-out-service.ts`: check/set opt_out_at in SQLite.
5. `src/services/conversation-store.ts`: CRUD for conversations + messages tables.
6. `src/services/time-window-policy.ts`: check message limits per hour/day per customer; check 24h window.
7. `src/services/media-service.ts`: check media send limits per customer per 72h.
8. `src/services/budget-guard.ts`: stub (returns `{ aiAllowed: false }` until Phase 6).
9. `src/services/alert-service.ts`: stub (logs alert intent, does not send until Phase 7).
10. `src/scripts/simulate-message.ts`:
    - Takes `--message "..."` arg.
    - Runs full response engine.
    - Prints: `reply=...`, `lead_score=...`, `used_ai=false`, `should_alert_owner=...`, `should_send_image=...`.
    - Works offline (no WhatsApp, no AI).
11. Add `npm run simulate` that calls the simulate script.
12. Tests for `deterministic-faq`, `lead-scoring`, `response-engine`, `budget-guard` in `src/tests/`.

### Phase 4 — WhatsApp webhook

1. `src/routes/whatsapp-webhook.route.ts`:
   - `GET /webhooks/whatsapp` — Meta verification (hub.mode, hub.verify_token, hub.challenge).
   - `POST /webhooks/whatsapp` — receive message events, return 200 immediately, process async.
2. `src/services/dedupe-service.ts`: check `processed_webhook_messages` table before processing.
3. `src/services/whatsapp-client.ts`: send text messages via WhatsApp Business Cloud API (POST to graph API).
4. Wire webhook → dedupe → store → response-engine → send reply → store outbound → score → alert.

Rules:
- Ignore statuses and read receipts.
- Always return 200 for valid WhatsApp events.
- Never crash on unexpected payload shape.

### Phase 5 — Cost guards

- `src/services/budget-guard.ts` — real implementation:
  - Daily AI budget (USD).
  - Monthly AI budget (USD).
  - AI calls per customer per day.
  - AI calls global per day.
  - AI cache with TTL.
- `src/services/time-window-policy.ts` — enforce all limits.
- `src/services/media-service.ts` — enforce 1 image per customer per 72h.

### Phase 6 — DeepSeek fallback

1. `src/prompts/deepseek-system.prompt.md` — content from section 17.2.
2. `src/services/deepseek-client.ts`:
   - POST to DeepSeek API with system prompt + customer message + conversation history.
   - Parse + validate response with zod (`{ reply, intent, lead_score_delta, should_send_image, needs_human, missing_fields, collected_fields }`).
   - Track usage in `ai_usage` table (no natural-language reply cache).
3. Wire into `response-engine.ts`: DeepSeek is the PRIMARY reply source for all customer messages (not a fallback). Called when AI budget allows. No deterministic FAQ in live reply path.

### Phase 7 — Owner alerts

1. `src/services/alert-service.ts` — real:
   - Log channel: write to `owner_alerts` table + log line.
   - Telegram channel: send via `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`.
   - WhatsApp channel: send via `whatsapp-client.ts`.
   - Enforce: 1 WhatsApp alert per customer per day; no images in alerts.
2. Alert template from sales-strategy `ownerAlertTemplate`.

### Phase 8 — Deployment

1. `deploy/andean-whatsapp-bot.service` — systemd unit (section 20.4).
2. `deploy/cloudflared-config.yml` — tunnel config (section 19).
3. `deploy/install-fedora.sh` — install script: user, dirs, deps, build, systemd, cloudflared.
4. `deploy/update-app.sh` — git pull, npm ci, npm run build, systemctl restart.

## Testing

- `npm test` — run all tests in `src/tests/`.
- `npm run simulate -- "text"` — offline bot test.
- `npm run typecheck` — must pass clean.
- `npm run lint` — must pass.
- `npm run build` — must produce `dist/`.

## Acceptance checklist (all must pass)

```
[x] Fastify runs locally on 127.0.0.1:3000
[x] /health returns ok
[x] SQLite stores conversations and messages
[x] Bot answers via DeepSeek with skill facts as context
[x] Bot never invents unavailable data
[x] Max 1 same plan/owner image per customer per 72h; gallery sends capped by MAX_GALLERY_IMAGES_PER_SEND
[x] Lead scoring works
[x] Opt-out works
[x] All tests pass (125/125)
[x] HMAC SHA-256 webhook signature verification (X-Hub-Signature-256)
[ ] Meta webhook verification works (requires live WhatsApp)
[ ] WhatsApp POST webhook receives messages (requires Cloudflare tunnel + live)
[ ] Duplicate messages ignored (requires live webhook)
[ ] AI budget guard works (requires AI usage data)
[ ] No automatic follow-up after 24h (requires live run)
[ ] Owner alert fires on AI failure, budget block, or score >= 85 (requires live run)
[ ] systemd starts bot after reboot (requires Fedora deploy)
[ ] Logs do not expose secrets (manual audit before prod)
```

## Security rules

- Never commit `.env` values.
- Never log `WHATSAPP_ACCESS_TOKEN` or `DEEPSEEK_API_KEY`.
- Bind Fastify to `127.0.0.1` only.
- Use systemd hardening (`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`).
- Set `/etc/andean-whatsapp-bot.env` permissions to `600`.
