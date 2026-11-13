#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
npm --prefix apps/web run build
aws s3 sync apps/web/dist/ "s3://${SITE_BUCKET}/" --delete
printf '\nOpen website: %s\n' "$SITE_URL"
