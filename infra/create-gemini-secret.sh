#!/usr/bin/env bash
# Securely prompt and store the Gemini API key in AWS Secrets Manager.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
export AWS_DEFAULT_REGION="$AWS_REGION" AWS_PAGER=""
SECRET_NAME="videojournal/gemini/${AWS_ACCOUNT}"
umask 077
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
read -r -s -p 'Paste Gemini API key (hidden): ' KEY
printf '\n'
[[ -n "$KEY" ]] || { echo 'Empty key; refusing to create secret' >&2; exit 1; }
printf '%s' "$KEY" > "$TMP"
unset KEY
if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --secret-id "$SECRET_NAME" \
    --secret-string "file://$TMP" --query 'ARN' --output text
  echo "Existing Gemini secret updated: $SECRET_NAME"
else
  aws secretsmanager create-secret --name "$SECRET_NAME" \
    --description 'Gemini API key for Reverie transcription analysis demo' \
    --secret-string "file://$TMP" --query 'ARN' --output text
  echo "Gemini secret created: $SECRET_NAME"
fi
