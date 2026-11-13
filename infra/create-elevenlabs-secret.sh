#!/usr/bin/env bash
# Store the ElevenLabs key in AWS Secrets Manager, never in React or code.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source infra/.resource-ids.env
export AWS_DEFAULT_REGION="$AWS_REGION" AWS_PAGER=""
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
[[ "$ACCOUNT" == "$AWS_ACCOUNT" ]] || { echo "Wrong AWS account ($ACCOUNT)." >&2; exit 1; }
SECRET_NAME="videojournal/elevenlabs/${AWS_ACCOUNT}"
umask 077
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
read -r -s -p 'Paste ElevenLabs API key (hidden): ' KEY
printf '\n'
[[ -n "$KEY" ]] || { echo 'Empty key refused.' >&2; exit 1; }
printf '%s' "$KEY" > "$TMP"
unset KEY
if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --secret-id "$SECRET_NAME" --secret-string "file://$TMP" \
    --query ARN --output text >/dev/null
  echo "Updated existing ElevenLabs secret: $SECRET_NAME"
else
  aws secretsmanager create-secret --name "$SECRET_NAME" \
    --description 'Reverie demo ElevenLabs Scribe API key' \
    --secret-string "file://$TMP" --query ARN --output text >/dev/null
  echo "Created ElevenLabs secret: $SECRET_NAME"
fi
