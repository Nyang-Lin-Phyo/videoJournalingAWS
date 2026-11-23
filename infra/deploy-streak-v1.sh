#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
source infra/.phase3-resource-ids.env
export AWS_DEFAULT_REGION="${AWS_REGION:-us-east-1}" AWS_PAGER=""
: "${AWS_ACCOUNT:?}" "${AWS_REGION:?}" "${API_ID:?}" "${FUNC_NAME:?}" "${START_FUNC:?}" \
  "${RESULT_FUNC:?}" "${START_ROLE:?}" "${RESULT_ROLE:?}" \
  "${JOURNAL_TABLE_ARN:?}" "${AUTHORIZER_ID:?}"
[[ "${CONFIRM_STREAK_V1:-}" == "YES" ]] || {
  echo 'Set CONFIRM_STREAK_V1=YES after reviewing the streak deployment.' >&2
  exit 1
}
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$AWS_ACCOUNT" ]] || {
  echo 'Wrong AWS account' >&2
  exit 1
}
GEN=infra/streak-generated
mkdir -p "$GEN"

printf '[1/6] Verify existing authenticated Lambdas and API route\n'
[[ "$(aws lambda get-function-configuration --function-name "$FUNC_NAME" --query Handler --output text)" == 'auth_signer.handler' ]] || {
  echo 'Current signer handler is unexpected' >&2
  exit 1
}
[[ "$(aws lambda get-function-configuration --function-name "$START_FUNC" --query Handler --output text)" == 'queue_worker.handler' ]] || {
  echo 'Current worker handler is unexpected' >&2
  exit 1
}
[[ "$(aws lambda get-function-configuration --function-name "$RESULT_FUNC" --query Handler --output text)" == 'auth_results.handler' ]] || {
  echo 'Current results handler is unexpected' >&2
  exit 1
}
aws apigatewayv2 get-routes --api-id "$API_ID" --output json > "$GEN/routes-before.json"
aws apigatewayv2 get-api --api-id "$API_ID" --query CorsConfiguration --output json > "$GEN/cors-before.json"
for target in "$FUNC_NAME:signer" "$START_FUNC:worker" "$RESULT_FUNC:results"; do
  function_name="${target%%:*}"
  part="${target##*:}"
  url="$(aws lambda get-function --function-name "$function_name" --query Code.Location --output text)"
  curl -fsSL "$url" -o "$GEN/${part}-before.zip"
done

printf '[2/6] Grant the worker and results Lambda access to streak records\n'
cat > "$GEN/worker-policy.json" <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["dynamodb:GetItem","dynamodb:PutItem"],"Resource":"${JOURNAL_TABLE_ARN}"}]}
EOF
aws iam put-role-policy --role-name "$START_ROLE" --policy-name ReverieStreakV1Worker --policy-document "file://$GEN/worker-policy.json"
cat > "$GEN/results-policy.json" <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["dynamodb:GetItem","dynamodb:UpdateItem","dynamodb:DeleteItem"],"Resource":"${JOURNAL_TABLE_ARN}"}]}
EOF
aws iam put-role-policy --role-name "$RESULT_ROLE" --policy-name ReverieStreakV1Results --policy-document "file://$GEN/results-policy.json"

printf '[3/6] Set the feature start time without changing other worker settings\n'
aws lambda get-function-configuration --function-name "$START_FUNC" --query Environment.Variables --output json > "$GEN/worker-env-before.json"
python3 - "$GEN/worker-env-before.json" "$GEN/worker-env-after.json" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" <<'PY'
import json
import sys

before, after, start_at = sys.argv[1:]
with open(before) as source:
    variables = json.load(source) or {}
if not isinstance(variables, dict):
    raise SystemExit('Worker environment is invalid; refusing to overwrite it')
if not variables.get('STREAK_START_AT'):
    variables['STREAK_START_AT'] = start_at
with open(after, 'w') as destination:
    json.dump({'Variables': variables}, destination)
PY
aws lambda update-function-configuration --function-name "$START_FUNC" --environment "file://$GEN/worker-env-after.json" >/dev/null
aws lambda wait function-updated-v2 --function-name "$START_FUNC"

printf '[4/6] Package the timezone-aware signer, streak worker, and API\n'
python3 - "$GEN" <<'PY'
import pathlib
import sys
import zipfile

output = pathlib.Path(sys.argv[1])
source = pathlib.Path('infra/lambda')
packages = {
    'signer': ['auth_signer.py'],
    'worker': ['queue_worker.py', 'legacy_elevenlabs_provider.py'],
    'results': ['auth_results.py', 'journal_pages.py'],
}
for name, files in packages.items():
    with zipfile.ZipFile(output / f'{name}.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        for filename in files:
            archive.write(source / filename, filename)
PY
for target in "$FUNC_NAME:signer" "$START_FUNC:worker" "$RESULT_FUNC:results"; do
  function_name="${target%%:*}"
  package="${target##*:}"
  aws lambda update-function-code --function-name "$function_name" --zip-file "fileb://$GEN/$package.zip" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$function_name"
done

printf '[5/6] Add authenticated streak and freeze-purchase routes\n'
python3 - "$GEN/routes-before.json" "$GEN/result-target.env" <<'PY'
import json
import sys

routes = {item['RouteKey']: item for item in json.load(open(sys.argv[1]))['Items']}
reference = routes.get('GET /uploads/{upload_id}/result')
if not reference or reference.get('AuthorizationType') != 'JWT' or not reference.get('Target'):
    raise SystemExit('Protected journal results route is missing; abort')
with open(sys.argv[2], 'w') as destination:
    destination.write("RESULT_TARGET='%s'\n" % reference['Target'])
PY
source "$GEN/result-target.env"
for key in 'GET /streak' 'POST /streak/freeze'; do
  route_id="$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?RouteKey=='${key}'].RouteId | [0]" --output text)"
  if [[ -z "$route_id" || "$route_id" == 'None' ]]; then
    aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$key" --target "$RESULT_TARGET" \
      --authorization-type JWT --authorizer-id "$AUTHORIZER_ID" >/dev/null
  else
    aws apigatewayv2 update-route --api-id "$API_ID" --route-id "$route_id" --target "$RESULT_TARGET" \
      --authorization-type JWT --authorizer-id "$AUTHORIZER_ID" >/dev/null
  fi
  method="${key%% *}"
  path="${key#* }"
  statement_id="AllowReverieStreak${method}$(echo "$path" | tr -cd '[:alnum:]')"
  if ! aws lambda get-policy --function-name "$RESULT_FUNC" --query Policy --output text 2>/dev/null | grep -q "$statement_id"; then
    aws lambda add-permission --function-name "$RESULT_FUNC" --statement-id "$statement_id" \
      --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
      --source-arn "arn:aws:execute-api:${AWS_REGION}:${AWS_ACCOUNT}:${API_ID}/*/${method}${path}" >/dev/null
  fi
done

printf '[6/6] Preserve existing API origins and allow streak requests\n'
python3 - "$GEN/cors-before.json" "$GEN/cors-after.json" <<'PY'
import json
import sys

before, after = sys.argv[1:]
with open(before) as source:
    config = json.load(source)
if not isinstance(config, dict) or not config.get('AllowOrigins'):
    raise SystemExit('API CORS has no configured origins; refusing to change it')
config['AllowMethods'] = sorted(set(config.get('AllowMethods', [])) | {'GET', 'POST', 'OPTIONS'})
config['AllowHeaders'] = sorted(set(config.get('AllowHeaders', [])) | {'authorization', 'content-type'})
with open(after, 'w') as destination:
    json.dump(config, destination, indent=2)
PY
aws apigatewayv2 update-api --api-id "$API_ID" --cors-configuration "file://$GEN/cors-after.json" >/dev/null
aws apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].[RouteKey,AuthorizationType]' --output table
printf '\nStreak v1 backend deployed. This script does not backfill or modify existing journals.\n'
