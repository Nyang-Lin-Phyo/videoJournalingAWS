#!/usr/bin/env bash
# Calendar v1: code-only update to the existing protected results Lambda.
# Existing GET /journals now accepts optional start/end UTC boundaries.
# No routes, IAM, S3, SQS, DynamoDB schema, or Lambda environments are modified.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
source infra/.phase3-resource-ids.env
export AWS_DEFAULT_REGION="${AWS_REGION:-us-east-1}" AWS_PAGER=""
: "${AWS_ACCOUNT:?}" "${RESULT_FUNC:?}" "${JOURNAL_TABLE:?}"

if [[ "${CONFIRM_CALENDAR_V1:-}" != 'YES' ]]; then
  echo 'Review the diff first; then run CONFIRM_CALENDAR_V1=YES bash infra/deploy-calendar-v1.sh' >&2
  exit 1
fi
if [[ "$(aws sts get-caller-identity --query Account --output text)" != "$AWS_ACCOUNT" ]]; then
  echo 'Wrong AWS account. Refusing to deploy.' >&2
  exit 1
fi
if [[ "$(aws lambda get-function-configuration --function-name "$RESULT_FUNC" --query Handler --output text)" != 'auth_results.handler' ]]; then
  echo 'Unexpected results Lambda handler. Refusing to deploy.' >&2
  exit 1
fi
if [[ "$(aws dynamodb describe-table --table-name "$JOURNAL_TABLE" --query 'Table.GlobalSecondaryIndexes[?IndexName==`userId-createdAt-index`].IndexStatus | [0]' --output text)" != 'ACTIVE' ]]; then
  echo 'Required existing DynamoDB GSI is not ACTIVE.' >&2
  exit 1
fi
for file in infra/lambda/auth_results.py infra/lambda/user_profile.py; do
  [[ -f "$file" ]] || { echo "Missing $file" >&2; exit 1; }
done

python3 -m py_compile infra/lambda/auth_results.py infra/lambda/user_profile.py
python3 infra/test-calendar-month.py

OUTPUT=infra/calendar-generated
mkdir -p "$OUTPUT"
aws lambda get-function-configuration --function-name "$RESULT_FUNC" --query Environment.Variables --output json > "$OUTPUT/results-env-before.json"
url="$(aws lambda get-function --function-name "$RESULT_FUNC" --query Code.Location --output text)"
curl -fsSL "$url" -o "$OUTPUT/results-before.zip"
python3 - "$OUTPUT/results-calendar.zip" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in ('auth_results.py', 'user_profile.py'):
        archive.write('infra/lambda/' + name, name)
PY
aws lambda update-function-code --function-name "$RESULT_FUNC" --zip-file "fileb://$OUTPUT/results-calendar.zip" >/dev/null
aws lambda wait function-updated-v2 --function-name "$RESULT_FUNC"
aws lambda get-function-configuration --function-name "$RESULT_FUNC" \
  --query '[FunctionName,Handler,LastUpdateStatus]' --output table
echo 'Calendar backend deployed. No data, queues, IAM, routes, or Lambda environment modified.'
