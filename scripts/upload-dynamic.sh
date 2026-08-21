#!/usr/bin/env bash
set -euo pipefail

# Upload bot-dynamic.json to Cloudflare R2
# Requires: aws cli configured for R2, or curl with R2 public URL
#
# Usage:
#   ./scripts/upload-dynamic.sh <R2_BUCKET_NAME> <source-file> [object-key]
#
# R2 uses S3-compatible API. Configure via:
#   aws configure set aws_access_key_id YOUR_R2_ACCESS_KEY_ID
#   aws configure set aws_secret_access_key YOUR_R2_SECRET_ACCESS_KEY
# Use --endpoint-url for R2:
#   aws s3api put-object --bucket <bucket> --key bot/bot-dynamic.json ... --endpoint-url https://<accountid>.r2.cloudflarestorage.com

BUCKET="${1:?Usage: ./scripts/upload-dynamic.sh <R2_BUCKET_NAME> <source-file> [object-key]}"
SOURCE="${2:?Usage: ./scripts/upload-dynamic.sh <R2_BUCKET_NAME> <source-file> [object-key]}"
OBJECT_KEY="${3:-whatsapp_bot/bot-dynamic.json}"

if [ ! -f "$SOURCE" ]; then
  echo "Error: source file not found: $SOURCE"
  exit 1
fi

# Validate first
echo "Validating $SOURCE..."
npx tsx src/scripts/validate-dynamic.ts "$SOURCE"

echo "Uploading $SOURCE to R2 bucket $BUCKET $OBJECT_KEY..."
aws s3api put-object \
  --bucket "$BUCKET" \
  --key "$OBJECT_KEY" \
  --body "$SOURCE" \
  --content-type "application/json" \
  --endpoint-url "https://$(aws configure get r2_account_id).r2.cloudflarestorage.com" 2>/dev/null || {
    # Fallback: try without endpoint-url (uses default aws config)
    aws s3 cp "$SOURCE" "s3://$BUCKET/$OBJECT_KEY" --content-type "application/json"
  }

echo "Uploaded $SOURCE to R2 bucket $BUCKET $OBJECT_KEY"
echo "Update DYNAMIC_SKILL_URL in /etc/andean-whatsapp-bot.env to point to:"
echo "  https://cdn.andeanscapes.com/$OBJECT_KEY"
