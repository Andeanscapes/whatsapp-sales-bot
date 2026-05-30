# Andean Scapes WhatsApp Sales Bot

A self-hosted WhatsApp sales assistant for a small tour-operator business. Receives messages via the WhatsApp Business Cloud API, replies with a DeepSeek-backed conversational agent, scores leads, enforces budget + rate guards, and alerts the human owner on hot leads.

Runs on a single Node 24 process behind a Cloudflare Tunnel. No cloud dependencies beyond the WhatsApp Cloud API + the LLM provider.

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

See [AGENTS.md](AGENTS.md) for full architecture, invariants, and contributor docs.

## Quickstart

Requires Node 24+ and `npm`.

```bash
git clone <this-repo>
cd whatsapp-sales-bot
npm install
cp .env.example .env
# fill .env with your real values — see "Environment" below
npm run build
npm start
```

`/health` returns `{ ok: true }` on `127.0.0.1:3000`.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | tsx watch mode |
| `npm run build` | TypeScript compile + copy data/schema/prompt assets to `dist/` |
| `npm start` | Run compiled server from `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint over `src/` |
| `npm test` | Vitest run |
| `npm run simulate -- "<message>"` | Offline single-message test against the response engine |
| `npm run scan:secrets` | secretlint scan (run before commits) |

## Environment

All required vars are listed in [.env.example](.env.example). Values like `WHATSAPP_ACCESS_TOKEN`, `DEEPSEEK_API_KEY`, `OWNER_NAME`, `PARTNER_NAME`, and `ADMIN_SECRET` are **required** — startup will fail loudly if any are missing.

`OWNER_NAME` and `PARTNER_NAME` are interpolated into the skill files and the DeepSeek system prompt at load time (`{{OWNER_NAME}}` / `{{PARTNER_NAME}}` tokens). This keeps real founder names out of the public repo.

Never commit `.env` — it is gitignored.

## Deployment

Production runs as a `systemd` service on Fedora behind a Cloudflare Tunnel. See [deploy/](deploy/) for the unit file, tunnel config, install script, and update script.

Production env file lives at `/etc/andean-whatsapp-bot.env` (mode `0600`). SQLite database lives at `/var/lib/andean-whatsapp-bot/bot.sqlite`.

## Testing

```bash
npm run typecheck && npm run lint && npm test && npm run build
npm run simulate -- "Hola, cuanto vale el tour?"
```

## Security

- Required-secret env validation (zod) — no silent placeholder fallbacks.
- Webhook HMAC SHA-256 verification (`X-Hub-Signature-256`) with constant-time comparison.
- `.gitignore` excludes `.env`, `data/`, `*.sqlite*`, `dist/`, IDE state.
- Pre-commit secret scan via `npm run scan:secrets` (secretlint).
- Token-substituted owner identity — real names ship via env, not source.

## License

[MIT](LICENSE)
