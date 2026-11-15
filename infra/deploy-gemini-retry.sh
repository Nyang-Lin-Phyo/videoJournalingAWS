#!/usr/bin/env bash
# Update only the existing SQS worker Lambda package; no other AWS resources.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
source infra/.phase3-resource-ids.env
export AWS_DEFAULT_REGION="$AWS_REGION" AWS_PAGER=""
: "${AWS_ACCOUNT:?}" "${START_FUNC:?}" "${JOB_QUEUE_ARN:?}"
[[ "${CONFIRM_GEMINI_RETRY:-}" == YES ]] || { echo 'Set CONFIRM_GEMINI_RETRY=YES to deploy'; exit 1; }
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$AWS_ACCOUNT" ]] || { echo 'Wrong AWS account' >&2; exit 1; }
HANDLER="$(aws lambda get-function-configuration --function-name "$START_FUNC" --query Handler --output text)"
[[ "$HANDLER" == queue_worker.handler ]] || { echo "Expected queue_worker.handler, got $HANDLER. Aborting." >&2; exit 1; }
MAPPINGS="$(aws lambda list-event-source-mappings --function-name "$START_FUNC" --event-source-arn "$JOB_QUEUE_ARN" --query 'EventSourceMappings[0].State' --output text)"
[[ "$MAPPINGS" == Enabled ]] || { echo "SQS mapping is $MAPPINGS (expected Enabled)" >&2; exit 1; }
mkdir -p infra/gemini-retry-generated
GEN=infra/gemini-retry-generated
URL="$(aws lambda get-function --function-name "$START_FUNC" --query Code.Location --output text)"
curl -fsSL "$URL" -o "$GEN/worker-before-retry.zip"
python3 - "$GEN/worker-retry.zip" <<'PYZIP'
import sys,zipfile
from pathlib import Path
p=Path('infra/lambda')
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    for filename in ('queue_worker.py','legacy_elevenlabs_provider.py'):
        z.write(p/filename,filename)
PYZIP
aws lambda update-function-code --function-name "$START_FUNC" --zip-file "fileb://$GEN/worker-retry.zip" >/dev/null
aws lambda wait function-updated-v2 --function-name "$START_FUNC"
echo 'Updated existing worker Lambda code. No queue, API, provider model, or journal data changed.'
aws lambda get-function-configuration --function-name "$START_FUNC" --query '[Handler,LastUpdateStatus,Environment.Variables.GEMINI_MODEL]' --output table
