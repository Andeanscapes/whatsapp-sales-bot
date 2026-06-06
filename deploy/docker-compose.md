# Docker Compose Deploy

Docker runs Node for this app. No separate Node service or process manager is needed.

## Local Mac Test

1. Install Docker Desktop (or colima: `brew install docker colima docker-compose && colima start`).
2. Create `.env.dev` from `.env.example` with local/dev values.
3. Start app with dev env:

```bash
docker compose --env-file .env.dev up -d --build
```

4. Check health:

```bash
curl http://127.0.0.1:3000/health
```

5. Check logs:

```bash
docker compose logs -f app
```

6. Stop app:

```bash
docker compose down
```

The container forces `SQLITE_PATH=/data/bot.sqlite`, so SQLite stays in the `bot-data` Docker volume.

## Fedora Mini PC

1. Install Docker and Compose plugin:

```bash
sudo dnf install -y docker docker-compose-plugin git
```

2. Enable Docker on boot:

```bash
sudo systemctl enable --now docker
```

3. Clone the repo and enter it:

```bash
git clone git@github.com:andeanscapes01/whatsapp-sales-bot.git
cd whatsapp-sales-bot
```

4. Create `.env.prod` with production values. Do not commit it.

5. Start app:

```bash
docker compose --env-file .env.prod up -d --build
```

6. Confirm it survives reboot:

```bash
sudo reboot
docker compose ps
```

## Cloudflare Tunnel

Use token mode for simple device deploy.

1. Create a tunnel in Cloudflare Zero Trust.
2. Route your hostname to `http://app:3000` (both containers share the compose network).
3. Add token to `.env.prod`:

```bash
CLOUDFLARE_TUNNEL_TOKEN=your-token-here
```

4. Start app plus tunnel:

```bash
docker compose --env-file .env.prod --profile tunnel up -d --build
```

No router port forwarding or public IP is required.

## Updates

Use `.env.dev` locally and `.env.prod` in production:

```bash
git pull
docker compose --env-file .env.prod up -d --build
```

## Backups

Create backup from Docker volume:

```bash
docker run --rm -v whatsapp-sales-bot_bot-data:/data -v "$PWD":/backup busybox cp /data/bot.sqlite /backup/bot.sqlite.backup
```

If project directory name differs, check volume name with:

```bash
docker volume ls
```

## Logs And Transcripts

Docker keeps prod container logs with rotation (`local` driver): app logs keep about 200MB, tunnel logs about 50MB.

Watch live prod logs:

```bash
docker compose logs -f app
```

Watch only external API flow:

```bash
docker compose logs -f app 2>&1 | grep -E '\[DIAG\]|\[WEBHOOK\]|\[LLM\]|\[WHATSAPP\]|\[TELEGRAM\]'
```

Export conversation transcripts for LLM review from the prod SQLite DB in the running container:

```bash
npm run export:transcripts
```

The export writes JSONL files under `exports/`. Do not commit these files.

Create a support bundle with app logs, tunnel logs, container status, and transcript JSONL:

```bash
npm run export:debug-bundle
```

The bundle is written as `exports/prod-debug-*.tar.gz`.
