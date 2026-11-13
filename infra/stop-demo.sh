#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
# Disables public upload signing immediately. Presigned forms issued earlier can remain usable until expiry.
aws apigatewayv2 delete-api --api-id "$API_ID"
printf 'Upload-signing endpoint deleted. Existing 5-minute forms expire naturally.\n'
