#!/usr/bin/env bash
# Incremental upgrade over Part 1: reuse the existing S3 buckets and API Gateway.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
export AWS_PAGER=""
[[ -f infra/.resource-ids.env ]] || { echo 'Run Part 1 first; missing infra/.resource-ids.env' >&2; exit 1; }
# shellcheck disable=SC1091
source infra/.resource-ids.env
export AWS_DEFAULT_REGION="$AWS_REGION"
[[ -n "${API_ID:-}" && -n "${UPLOAD_BUCKET:-}" && -n "${FUNC_NAME:-}" ]] || { echo 'Part 1 resource variables incomplete' >&2; exit 1; }
[[ ! -f infra/.part2-resource-ids.env ]] || { echo 'Part 2 already configured (or partial state). Inspect infra/.part2-resource-ids.env.' >&2; exit 1; }
ACTUAL_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
[[ "$ACTUAL_ACCOUNT" == "$AWS_ACCOUNT" ]] || { echo "Wrong AWS account: $ACTUAL_ACCOUNT, expected $AWS_ACCOUNT" >&2; exit 1; }

SUFFIX="${FUNC_NAME##*-}"
START_FUNC="videojournal-transcribe-start-${SUFFIX}"
FINISH_FUNC="videojournal-analyze-${SUFFIX}"
RESULT_FUNC="videojournal-results-${SUFFIX}"
START_ROLE="videojournal-start-role-${SUFFIX}"
FINISH_ROLE="videojournal-analyze-role-${SUFFIX}"
RESULT_ROLE="videojournal-results-role-${SUFFIX}"
RULE_NAME="videojournal-transcribe-done-${SUFFIX}"
SECRET_NAME="videojournal/gemini/${AWS_ACCOUNT}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.5-flash-lite}"
GEN="infra/part2-generated"
mkdir -p "$GEN"

if ! SECRET_ARN="$(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --query ARN --output text 2>/dev/null)"; then
  echo "Missing Gemini secret: $SECRET_NAME" >&2
  echo 'Create it with the CLI steps in README_PART2.md; no key belongs in frontend code.' >&2
  exit 1
fi

# Save names first so a partial failure can be diagnosed without guessing.
cat > infra/.part2-resource-ids.env <<EOF
export START_FUNC='$START_FUNC'
export FINISH_FUNC='$FINISH_FUNC'
export RESULT_FUNC='$RESULT_FUNC'
export START_ROLE='$START_ROLE'
export FINISH_ROLE='$FINISH_ROLE'
export RESULT_ROLE='$RESULT_ROLE'
export RULE_NAME='$RULE_NAME'
export SECRET_NAME='$SECRET_NAME'
export SECRET_ARN='$SECRET_ARN'
export GEMINI_MODEL='$GEMINI_MODEL'
EOF
trap 'echo "Setup stopped. Inspect AWS resources and infra/.part2-resource-ids.env before retrying; do not blindly rerun." >&2' ERR

echo '[1/7] Creating Lambda roles with least-privilege-ish demo access'
cat > "$GEN/trust.json" <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
for ROLE in "$START_ROLE" "$FINISH_ROLE" "$RESULT_ROLE"; do
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document "file://$GEN/trust.json" >/dev/null
  aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
 done
cat > "$GEN/start-policy.json" <<EOF
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["transcribe:StartTranscriptionJob"],"Resource":"*"},
 {"Effect":"Allow","Action":["s3:GetObject"],"Resource":"arn:aws:s3:::${UPLOAD_BUCKET}/uploads/*"},
 {"Effect":"Allow","Action":["s3:PutObject"],"Resource":"arn:aws:s3:::${UPLOAD_BUCKET}/results/*"}
]}
EOF
cat > "$GEN/finish-policy.json" <<EOF
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":"transcribe:GetTranscriptionJob","Resource":"*"},
 {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject"],"Resource":"arn:aws:s3:::${UPLOAD_BUCKET}/results/*"},
 {"Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":"${SECRET_ARN}"}
]}
EOF
cat > "$GEN/result-policy.json" <<EOF
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":"s3:GetObject","Resource":["arn:aws:s3:::${UPLOAD_BUCKET}/uploads/*","arn:aws:s3:::${UPLOAD_BUCKET}/results/*"]}
]}
EOF
aws iam put-role-policy --role-name "$START_ROLE" --policy-name StartTranscribe --policy-document "file://$GEN/start-policy.json"
aws iam put-role-policy --role-name "$FINISH_ROLE" --policy-name AnalyzeTranscript --policy-document "file://$GEN/finish-policy.json"
aws iam put-role-policy --role-name "$RESULT_ROLE" --policy-name ReadResults --policy-document "file://$GEN/result-policy.json"

package_lambda() {
  local name="$1"
  python3 - "$name" <<'PY'
import sys
from zipfile import ZipFile, ZIP_DEFLATED
name = sys.argv[1]
with ZipFile(f'infra/part2-generated/{name}.zip', 'w', ZIP_DEFLATED) as z:
    z.write(f'infra/lambda/{name}.py', f'{name}.py')
PY
}
package_lambda start_transcribe
package_lambda finish_transcribe
package_lambda get_result
sleep 12  # IAM role propagation

ROLE_START_ARN="$(aws iam get-role --role-name "$START_ROLE" --query Role.Arn --output text)"
ROLE_FINISH_ARN="$(aws iam get-role --role-name "$FINISH_ROLE" --query Role.Arn --output text)"
ROLE_RESULT_ARN="$(aws iam get-role --role-name "$RESULT_ROLE" --query Role.Arn --output text)"

echo '[2/7] Creating three processing/result Lambda functions'
START_ARN="$(aws lambda create-function --function-name "$START_FUNC" \
  --runtime python3.12 --handler start_transcribe.handler --role "$ROLE_START_ARN" \
  --zip-file "fileb://$GEN/start_transcribe.zip" --timeout 30 --memory-size 128 \
  --environment "Variables={UPLOAD_BUCKET=$UPLOAD_BUCKET}" --query FunctionArn --output text)"
FINISH_ARN="$(aws lambda create-function --function-name "$FINISH_FUNC" \
  --runtime python3.12 --handler finish_transcribe.handler --role "$ROLE_FINISH_ARN" \
  --zip-file "fileb://$GEN/finish_transcribe.zip" --timeout 120 --memory-size 256 \
  --environment "Variables={UPLOAD_BUCKET=$UPLOAD_BUCKET,GEMINI_SECRET_ARN=$SECRET_ARN,GEMINI_MODEL=$GEMINI_MODEL}" \
  --query FunctionArn --output text)"
RESULT_ARN="$(aws lambda create-function --function-name "$RESULT_FUNC" \
  --runtime python3.12 --handler get_result.handler --role "$ROLE_RESULT_ARN" \
  --zip-file "fileb://$GEN/get_result.zip" --timeout 10 --memory-size 128 \
  --environment "Variables={UPLOAD_BUCKET=$UPLOAD_BUCKET}" --query FunctionArn --output text)"
for name in "$START_FUNC" "$FINISH_FUNC" "$RESULT_FUNC"; do
  aws lambda wait function-active-v2 --function-name "$name"
done

echo '[3/7] Adding GET /uploads/{upload_id}/result to existing HTTP API'
INTEGRATION_ID="$(aws apigatewayv2 create-integration --api-id "$API_ID" \
  --integration-type AWS_PROXY --integration-uri "$RESULT_ARN" --payload-format-version 2.0 \
  --query IntegrationId --output text)"
aws apigatewayv2 create-route --api-id "$API_ID" \
  --route-key 'GET /uploads/{upload_id}/result' --target "integrations/$INTEGRATION_ID" >/dev/null
aws lambda add-permission --function-name "$RESULT_FUNC" --statement-id AllowReadAPI \
  --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${AWS_REGION}:${AWS_ACCOUNT}:${API_ID}/*/GET/uploads/*/result" >/dev/null
# HTTP API CORS is managed at the gateway level; allow GET in addition to POST.
cat > "$GEN/api-cors.json" <<EOF
{"AllowOrigins":["${SITE_URL}","http://localhost:5173","http://127.0.0.1:5173"],"AllowMethods":["GET","POST","OPTIONS"],"AllowHeaders":["content-type"],"MaxAge":300}
EOF
aws apigatewayv2 update-api --api-id "$API_ID" --cors-configuration "file://$GEN/api-cors.json" >/dev/null

echo '[4/7] Configuring EventBridge Transcribe-completed/failed events'
cat > "$GEN/event-pattern.json" <<'EOF'
{"source":["aws.transcribe"],"detail-type":["Transcribe Job State Change"],"detail":{"TranscriptionJobName":[{"prefix":"vjournal-"}],"TranscriptionJobStatus":["COMPLETED","FAILED"]}}
EOF
RULE_ARN="$(aws events put-rule --name "$RULE_NAME" --event-pattern "file://$GEN/event-pattern.json" --state ENABLED --query RuleArn --output text)"
aws lambda add-permission --function-name "$FINISH_FUNC" --statement-id AllowTranscribeEvents \
  --action lambda:InvokeFunction --principal events.amazonaws.com --source-arn "$RULE_ARN" >/dev/null
FAILED_TARGETS="$(aws events put-targets --rule "$RULE_NAME" --targets "Id=FinishTranscript,Arn=$FINISH_ARN" \
  --query FailedEntryCount --output text)"
[[ "$FAILED_TARGETS" == "0" ]] || { echo "Failed to configure $FAILED_TARGETS EventBridge targets" >&2; exit 1; }

echo '[5/7] Configuring S3 upload event notification without erasing existing notifications'
aws lambda add-permission --function-name "$START_FUNC" --statement-id AllowUploadBucket \
  --action lambda:InvokeFunction --principal s3.amazonaws.com \
  --source-arn "arn:aws:s3:::${UPLOAD_BUCKET}" --source-account "$AWS_ACCOUNT" >/dev/null
aws s3api get-bucket-notification-configuration --bucket "$UPLOAD_BUCKET" > "$GEN/notification-before.json"
python3 - "$GEN/notification-before.json" "$GEN/notification-after.json" "$START_ARN" <<'PY'
import json, sys
src, dest, arn = sys.argv[1:]
config = json.load(open(src))
entries = config.setdefault('LambdaFunctionConfigurations', [])
if not any(x.get('Id') == 'VideoJournalNewMp4' for x in entries):
    entries.append({
        'Id': 'VideoJournalNewMp4',
        'LambdaFunctionArn': arn,
        'Events': ['s3:ObjectCreated:*'],
        'Filter': {'Key': {'FilterRules': [
            {'Name': 'prefix', 'Value': 'uploads/'},
            {'Name': 'suffix', 'Value': '.mp4'},
        ]}},
    })
with open(dest, 'w') as f:
    json.dump(config, f)
PY
aws s3api put-bucket-notification-configuration --bucket "$UPLOAD_BUCKET" \
  --notification-configuration "file://$GEN/notification-after.json"

echo '[6/7] Verifying gateway routes and event wiring'
aws apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].RouteKey' --output table
aws s3api get-bucket-notification-configuration --bucket "$UPLOAD_BUCKET" \
  --query 'LambdaFunctionConfigurations[].Id' --output text

echo '[7/7] Part 2 setup complete'
echo "Gemini key remains in Secrets Manager: $SECRET_NAME"
echo "Upload new files to trigger processing: s3://${UPLOAD_BUCKET}/uploads/"
echo "Results API: ${API_URL}/uploads/{upload_id}/result"
echo 'Next: bash infra/deploy-web.sh'
