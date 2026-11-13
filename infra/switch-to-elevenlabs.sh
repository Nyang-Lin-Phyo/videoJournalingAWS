#!/usr/bin/env bash
# In-place upgrade: reuse existing Part 2 S3 -> Lambda trigger, results API.
# Does NOT recreate buckets, API Gateway, or Lambda functions.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source infra/.resource-ids.env
# shellcheck disable=SC1091
source infra/.part2-resource-ids.env
export AWS_DEFAULT_REGION="$AWS_REGION" AWS_PAGER=""
: "${AWS_REGION:?}" "${AWS_ACCOUNT:?}" "${UPLOAD_BUCKET:?}" "${START_FUNC:?}" "${START_ROLE:?}" "${RESULT_ROLE:?}" "${RESULT_FUNC:?}" "${RULE_NAME:?}" "${API_URL:?}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
[[ "$ACCOUNT" == "$AWS_ACCOUNT" ]] || { echo "Wrong AWS account ($ACCOUNT)." >&2; exit 1; }
aws lambda get-function --function-name "$START_FUNC" >/dev/null
aws lambda get-function --function-name "$RESULT_FUNC" >/dev/null
aws iam get-role --role-name "$START_ROLE" >/dev/null
aws iam get-role --role-name "$RESULT_ROLE" >/dev/null

ELEVENLABS_SECRET_NAME="videojournal/elevenlabs/${AWS_ACCOUNT}"
GEMINI_SECRET_NAME="videojournal/gemini/${AWS_ACCOUNT}"
ELEVENLABS_SECRET_ARN="$(aws secretsmanager describe-secret --secret-id "$ELEVENLABS_SECRET_NAME" --query ARN --output text)"
GEMINI_SECRET_ARN="$(aws secretsmanager describe-secret --secret-id "$GEMINI_SECRET_NAME" --query ARN --output text)"
ELEVENLABS_MODEL="${ELEVENLABS_MODEL:-scribe_v3}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.5-flash-lite}"
GEN="infra/part2-generated"
mkdir -p "$GEN"

printf '[1/6] Confirming S3 upload trigger references the existing function\n'
START_ARN="$(aws lambda get-function-configuration --function-name "$START_FUNC" --query FunctionArn --output text)"
aws s3api get-bucket-notification-configuration --bucket "$UPLOAD_BUCKET" --output json > "$GEN/s3-notification-check.json"
python3 - "$GEN/s3-notification-check.json" "$START_ARN" <<'PY'
import json, sys
j = json.load(open(sys.argv[1]))
arn = sys.argv[2]
entries = [x for x in j.get('LambdaFunctionConfigurations', []) if x.get('LambdaFunctionArn') == arn]
if not entries:
    raise SystemExit('ERROR: S3 notification is not connected to existing start Lambda. Fix Part 2 S3 trigger before switching.')
if not any('s3:ObjectCreated:*' in x.get('Events', []) and
           {('prefix','uploads/'),('suffix','.mp4')} <=
           {(r.get('Name', '').lower(), r.get('Value')) for r in x.get('Filter', {}).get('Key', {}).get('FilterRules', [])}
           for x in entries):
    raise SystemExit('ERROR: expected uploads/*.mp4 S3 notification not found.')
print('OK: uploads/*.mp4 -> existing Lambda. No S3 trigger changes required.')
PY

printf '[2/6] Granting existing processing Lambda access to uploads and both API secrets\n'
cat > "$GEN/elevenlabs-process-policy.json" <<EOF
{"Version":"2012-10-17","Statement":[
  {"Sid":"ReadUploads","Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::${UPLOAD_BUCKET}/uploads/*"},
  {"Sid":"WriteResults","Effect":"Allow","Action":"s3:PutObject","Resource":"arn:aws:s3:::${UPLOAD_BUCKET}/results/*"},
  {"Sid":"ReadProviderKeys","Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":["${ELEVENLABS_SECRET_ARN}","${GEMINI_SECRET_ARN}"]}
]}
EOF
aws iam put-role-policy --role-name "$START_ROLE" --policy-name ProcessElevenLabsGemini \
  --policy-document "file://$GEN/elevenlabs-process-policy.json"
# Remove no-longer-needed Transcribe permission, if present.
aws iam delete-role-policy --role-name "$START_ROLE" --policy-name StartTranscribe 2>/dev/null || true

# The GET results Lambda needs ListBucket so absent results/UUID.json yields 404 rather than S3 403.
cat > "$GEN/results-list-policy.json" <<EOF
{"Version":"2012-10-17","Statement":[
  {"Sid":"MissingResultsReturn404","Effect":"Allow","Action":"s3:ListBucket",
   "Resource":"arn:aws:s3:::${UPLOAD_BUCKET}"}
]}
EOF
aws iam put-role-policy --role-name "$RESULT_ROLE" --policy-name ReadMissingResults \
  --policy-document "file://$GEN/results-list-policy.json"

printf '[3/6] Disabling unused AWS Transcribe EventBridge completion rule\n'
if aws events describe-rule --name "$RULE_NAME" >/dev/null 2>&1; then
  aws events disable-rule --name "$RULE_NAME"
  echo "Disabled EventBridge rule: $RULE_NAME"
else
  echo 'Old Transcribe completion rule not found (nothing to disable).'
fi

printf '[4/6] Deploying new ElevenLabs+Gemini code into the existing start Lambda\n'
python3 - <<'PY'
from zipfile import ZipFile, ZIP_DEFLATED
with ZipFile('infra/part2-generated/process_elevenlabs.zip', 'w', ZIP_DEFLATED) as z:
    z.write('infra/lambda/process_elevenlabs.py', 'process_elevenlabs.py')
PY
aws lambda update-function-code --function-name "$START_FUNC" \
  --zip-file "fileb://$GEN/process_elevenlabs.zip" \
  --query '[FunctionName,LastUpdateStatus]' --output table
aws lambda wait function-updated-v2 --function-name "$START_FUNC"

printf '[5/6] Configuring handler, secrets, and timeout for short MP4s\n'
python3 - "$GEN/process-environment.json" "$UPLOAD_BUCKET" "$ELEVENLABS_SECRET_ARN" "$GEMINI_SECRET_ARN" "$ELEVENLABS_MODEL" "$GEMINI_MODEL" <<'PY'
import json, sys
path, bucket, eleven, gemini, eleven_model, gemini_model = sys.argv[1:]
with open(path, 'w') as f:
    json.dump({'Variables': {
        'UPLOAD_BUCKET': bucket,
        'ELEVENLABS_SECRET_ARN': eleven,
        'GEMINI_SECRET_ARN': gemini,
        'ELEVENLABS_MODEL': eleven_model,
        'GEMINI_MODEL': gemini_model,
    }}, f)
PY
aws lambda update-function-configuration --function-name "$START_FUNC" \
  --handler process_elevenlabs.handler --timeout 600 --memory-size 512 \
  --environment "file://$GEN/process-environment.json" \
  --query '[FunctionName,Handler,Timeout,MemorySize,LastUpdateStatus]' --output table
aws lambda wait function-updated-v2 --function-name "$START_FUNC"

printf '[6/6] Verifying current Lambda configuration and API routes\n'
aws lambda get-function-configuration --function-name "$START_FUNC" \
  --query '[Handler,Timeout,MemorySize,State,LastUpdateStatus]' --output table
aws apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].RouteKey' --output table
cat > "$GEN/elevenlabs-switch-manifest.json" <<EOF
{"start_function":"$START_FUNC","results_function":"$RESULT_FUNC","uploads_bucket":"$UPLOAD_BUCKET","elevenlabs_secret":"$ELEVENLABS_SECRET_NAME","gemini_secret":"$GEMINI_SECRET_NAME","elevenlabs_model":"$ELEVENLABS_MODEL","gemini_model":"$GEMINI_MODEL"}
EOF
echo
printf 'SWITCH COMPLETE. Upload a NEW fictional spoken MP4; old failed uploads do not automatically retry.\n'
printf 'Check: aws logs tail "/aws/lambda/%s" --since 20m\n' "$START_FUNC"
printf 'Results: %s/uploads/{upload_id}/result\n' "$API_URL"
