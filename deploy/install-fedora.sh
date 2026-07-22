#!/bin/bash
set -euo pipefail

APP_USER=andeanbot
APP_DIR=/opt/andean-whatsapp-bot
APP_DATA_DIR="$APP_DIR/app"
DB_DIR=/var/lib/andean-whatsapp-bot
LOG_DIR=/var/log/andean-whatsapp-bot
ENV_FILE=/etc/andean-whatsapp-bot.env
NODE_MAJOR=24

echo "[1/7] Creating system user..."
sudo useradd --system --create-home --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER" 2>/dev/null || echo "User already exists"

echo "[2/7] Creating directories..."
sudo mkdir -p "$APP_DATA_DIR"
sudo mkdir -p "$DB_DIR"
sudo mkdir -p "$LOG_DIR"

sudo chown -R "$APP_USER:$APP_USER" "$APP_DIR"
sudo chown -R "$APP_USER:$APP_USER" "$DB_DIR"
sudo chown -R "$APP_USER:$APP_USER" "$LOG_DIR"

echo "[3/7] Installing system dependencies..."
sudo dnf install -y nodejs git curl rsync
INSTALLED_NODE_VERSION=$(node -v | sed 's/^v//')
if [ "${INSTALLED_NODE_VERSION%%.*}" != "$NODE_MAJOR" ]; then
  echo "Node $NODE_MAJOR.x is required. Found $INSTALLED_NODE_VERSION. Install a supported Node $NODE_MAJOR release before running this script."
  exit 1
fi

echo "[4/7] Setting up env file..."
if [ ! -f "$ENV_FILE" ]; then
  echo "Create $ENV_FILE with production values and set permissions to 600"
  echo "Example: sudo cp /path/to/.env.production $ENV_FILE && sudo chmod 600 $ENV_FILE"
fi

echo "[5/7] Deploying app..."
sudo rsync -a --delete \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'data' \
  --exclude '.claude' \
  ./ "$APP_DATA_DIR/"
sudo chown -R "$APP_USER:$APP_USER" "$APP_DATA_DIR"
sudo -u "$APP_USER" bash -c "cd $APP_DATA_DIR && npm ci && npm run build"

echo "[6/7] Installing systemd service..."
sudo cp deploy/andean-whatsapp-bot.service /etc/systemd/system/andean-whatsapp-bot.service
sudo systemctl daemon-reload
sudo systemctl enable andean-whatsapp-bot
sudo systemctl start andean-whatsapp-bot

echo "[7/7] Installing cloudflared..."
sudo dnf install -y cloudflared 2>/dev/null || echo "Install cloudflared manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
sudo mkdir -p /etc/cloudflared
echo "Create /etc/cloudflared/ with your tunnel config and credentials"

echo "=== Install complete ==="
echo "Check status: systemctl status andean-whatsapp-bot"
echo "Check logs: journalctl -u andean-whatsapp-bot -f"
