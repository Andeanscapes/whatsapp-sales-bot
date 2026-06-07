#!/usr/bin/env bash
set -euo pipefail

# Download current bot-dynamic.json from Cloudflare R2
# Requires: aws cli configured for R2
#
# Usage:
#   ./scripts/download-dynamic.sh <R2_BUCKET_NAME> [output-file]
#
# Default output: src/data/bot-dynamic.json

OUTPUT="${2:-src/data/bot-dynamic.json}"
BUCKET="${1:?Usage: ./scripts/download-dynamic.sh <R2_BUCKET_NAME> [output-file]}"

echo "Downloading whatsapp_bot/bot-dynamic.json from R2 bucket $BUCKET..."

aws s3api get-object \
  --bucket "$BUCKET" \
  --key "whatsapp_bot/bot-dynamic.json" \
  "$OUTPUT" \
  --endpoint-url "https://$(aws configure get r2_account_id).r2.cloudflarestorage.com" 2>/dev/null || {
    aws s3 cp "s3://$BUCKET/whatsapp_bot/bot-dynamic.json" "$OUTPUT"
  }

echo "Downloaded to $OUTPUT"
echo ""
echo "Validate it:"
echo "  npm run validate:dynamic -- $OUTPUT"
