#!/bin/bash
set -euo pipefail

APP_DIR=/opt/andean-whatsapp-bot/app

echo "Pulling latest code..."
cd "$APP_DIR"
git pull

echo "Installing dependencies..."
npm ci

echo "Building..."
npm run build

echo "Restarting service..."
sudo systemctl restart andean-whatsapp-bot

echo "=== Update complete ==="
systemctl status andean-whatsapp-bot --no-pager
