#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."

source infra/.resource-ids.env
source infra/.part2-resource-ids.env
source infra/.phase3-resource-ids.env
export AWS_DEFAULT_REGION="${AWS_REGION:-us-east-1}" AWS_PAGER=""
: "${AWS_ACCOUNT:?}" "${AWS_REGION:?}" "${RESULT_FUNC:?}"

if [[ "${CONFIRM_STREAK_CALENDAR:-}" != 'YES' ]]; then
  echo 'Set CONFIRM_STREAK_CALENDAR=YES to update only the existing results Lambda code.' >&2
  exit 1
fi

actual_account="$(aws sts get-caller-identity --query Account --output text)"
if [[ "$actual_account" != "$AWS_ACCOUNT" ]]; then
  echo "STOP: AWS account mismatch: $actual_account != $AWS_ACCOUNT" >&2
  exit 1
fi

backup="$(mktemp -d "${HOME}/reverie-streak-calendar-backup-XXXXXXXX")"
chmod 700 "$backup"
trap 'echo "Saved pre-deployment Lambda ZIP and metadata at: $backup"' EXIT

echo '[1/4] Inspect and back up the existing results Lambda'
aws lambda get-function --function-name "$RESULT_FUNC" --output json > "$backup/lambda-before.json"
python3 - "$backup/lambda-before.json" <<'PY'
import json,sys
from pathlib import Path
config=json.loads(Path(sys.argv[1]).read_text())['Configuration']
if config.get('Handler')!='auth_results.handler' or config.get('PackageType')!='Zip':
    raise SystemExit('STOP: Unexpected results Lambda handler/package type; no update made.')
if config.get('State')!='Active' or config.get('LastUpdateStatus')!='Successful':
    raise SystemExit('STOP: Lambda is not active and ready; no update made.')
if not config.get('RevisionId'):
    raise SystemExit('STOP: Lambda revision ID missing; no update made.')
PY
revision="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["Configuration"]["RevisionId"])' "$backup/lambda-before.json")"
source_url="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["Code"]["Location"])' "$backup/lambda-before.json")"
curl --fail --silent --show-error --location "$source_url" -o "$backup/results-before.zip"

echo '[2/4] Patch only streak_summary and preserve every other file in the live ZIP'
python3 infra/patch-live-streak-response.py "$backup/results-before.zip" "$backup/results-after.zip"
if [[ ! -f "$backup/results-after.zip" ]]; then
  echo 'Already deployed; no Lambda code update necessary.'
  exit 0
fi

echo '[3/4] Update the existing Lambda with revision guard'
aws lambda update-function-code \
  --function-name "$RESULT_FUNC" \
  --revision-id "$revision" \
  --zip-file "fileb://$backup/results-after.zip" >/dev/null
aws lambda wait function-updated-v2 --function-name "$RESULT_FUNC"

echo '[4/4] Verify Lambda status'
aws lambda get-function-configuration \
  --function-name "$RESULT_FUNC" \
  --query '[FunctionName,State,LastUpdateStatus,RevisionId]' \
  --output json

echo 'SUCCESS: Streak calendar response deployed. No DynamoDB/S3 records or other Lambda resources changed.'
