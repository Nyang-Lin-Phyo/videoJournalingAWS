#!/usr/bin/env bash
# Issue #7: USERS table, onboarding/profile routes, and personalized reflections.
# Review before running. Requires the streak v1 backend to already be deployed.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
source infra/.phase3-resource-ids.env
export AWS_DEFAULT_REGION="${AWS_REGION:-us-east-1}" AWS_PAGER=""
: "${AWS_ACCOUNT:?}" "${AWS_REGION:?}" "${API_ID:?}" "${START_FUNC:?}" \
  "${RESULT_FUNC:?}" "${START_ROLE:?}" "${RESULT_ROLE:?}" \
  "${JOURNAL_TABLE_ARN:?}" "${AUTHORIZER_ID:?}"
[[ "${CONFIRM_PROFILE_V1:-}" == "YES" ]] || {
  echo 'Set CONFIRM_PROFILE_V1=YES after reviewing the profile deployment.' >&2
  exit 1
}
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$AWS_ACCOUNT" ]] || {
  echo 'Wrong AWS account' >&2
  exit 1
}
GEN=infra/profile-generated
mkdir -p "$GEN"
JOURNAL_TABLE_NAME="${JOURNAL_TABLE_ARN##*/}"
SUFFIX="${JOURNAL_TABLE_NAME##*-}"
USERS_TABLE="${USERS_TABLE:-reverie-users-${SUFFIX}}"

printf '[1/7] Verify existing Lambdas and back up their code and routes\n'
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
for target in "$START_FUNC:worker" "$RESULT_FUNC:results"; do
  function_name="${target%%:*}"
  part="${target##*:}"
  url="$(aws lambda get-function --function-name "$function_name" --query Code.Location --output text)"
  curl -fsSL "$url" -o "$GEN/${part}-before.zip"
done

printf '[2/7] Create the USERS table (%s) if needed\n' "$USERS_TABLE"
if ! aws dynamodb describe-table --table-name "$USERS_TABLE" >/dev/null 2>&1; then
  aws dynamodb create-table --table-name "$USERS_TABLE" \
    --attribute-definitions AttributeName=userId,AttributeType=S \
    --key-schema AttributeName=userId,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --sse-specification Enabled=true \
    --tags Key=app,Value=reverie Key=feature,Value=profile-v1 >/dev/null
  aws dynamodb wait table-exists --table-name "$USERS_TABLE"
  aws dynamodb update-continuous-backups --table-name "$USERS_TABLE" \
    --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true >/dev/null
fi
USERS_TABLE_ARN="$(aws dynamodb describe-table --table-name "$USERS_TABLE" --query Table.TableArn --output text)"
printf "USERS_TABLE='%s'\nUSERS_TABLE_ARN='%s'\n" "$USERS_TABLE" "$USERS_TABLE_ARN" > "$GEN/users-table.env"

printf '[3/7] Grant least-privilege USERS access\n'
cat > "$GEN/worker-policy.json" <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["dynamodb:GetItem","dynamodb:UpdateItem"],"Resource":"${USERS_TABLE_ARN}"}]}
EOF
aws iam put-role-policy --role-name "$START_ROLE" --policy-name ReverieProfileV1Worker --policy-document "file://$GEN/worker-policy.json"
cat > "$GEN/results-policy.json" <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["dynamodb:GetItem","dynamodb:UpdateItem","dynamodb:DeleteItem"],"Resource":"${USERS_TABLE_ARN}"}]}
EOF
aws iam put-role-policy --role-name "$RESULT_ROLE" --policy-name ReverieProfileV1Results --policy-document "file://$GEN/results-policy.json"

printf '[4/7] Add USERS_TABLE to both Lambdas without changing other settings\n'
for target in "$START_FUNC:worker" "$RESULT_FUNC:results"; do
  function_name="${target%%:*}"
  part="${target##*:}"
  aws lambda get-function-configuration --function-name "$function_name" --query Environment.Variables --output json > "$GEN/${part}-env-before.json"
  python3 - "$GEN/${part}-env-before.json" "$GEN/${part}-env-after.json" "$USERS_TABLE" <<'PY'
import json
import sys

before, after, users_table = sys.argv[1:]
with open(before) as source:
    variables = json.load(source) or {}
if not isinstance(variables, dict):
    raise SystemExit('Lambda environment is invalid; refusing to overwrite it')
variables['USERS_TABLE'] = users_table
with open(after, 'w') as destination:
    json.dump({'Variables': variables}, destination)
PY
  aws lambda update-function-configuration --function-name "$function_name" --environment "file://$GEN/${part}-env-after.json" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$function_name"
done

printf '[5/7] Package the profile-aware worker and results API\n'
python3 - "$GEN" <<'PY'
import pathlib
import sys
import zipfile

output = pathlib.Path(sys.argv[1])
source = pathlib.Path('infra/lambda')
packages = {
    'worker': ['queue_worker.py', 'legacy_elevenlabs_provider.py', 'user_profile.py'],
    'results': ['auth_results.py', 'user_profile.py', 'journal_pages.py'],
}
for name, files in packages.items():
    with zipfile.ZipFile(output / f'{name}.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        for filename in files:
            archive.write(source / filename, filename)
PY
for target in "$START_FUNC:worker" "$RESULT_FUNC:results"; do
  function_name="${target%%:*}"
  package="${target##*:}"
  aws lambda update-function-code --function-name "$function_name" --zip-file "fileb://$GEN/$package.zip" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$function_name"
done

printf '[6/7] Add authenticated profile routes\n'
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
for key in 'GET /profile' 'PUT /profile'; do
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
  statement_id="AllowReverieProfile${method}$(echo "$path" | tr -cd '[:alnum:]')"
  if ! aws lambda get-policy --function-name "$RESULT_FUNC" --query Policy --output text 2>/dev/null | grep -q "$statement_id"; then
    aws lambda add-permission --function-name "$RESULT_FUNC" --statement-id "$statement_id" \
      --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
      --source-arn "arn:aws:execute-api:${AWS_REGION}:${AWS_ACCOUNT}:${API_ID}/*/${method}${path}" >/dev/null
  fi
done

printf '[7/7] Preserve existing API origins and allow PUT\n'
python3 - "$GEN/cors-before.json" "$GEN/cors-after.json" <<'PY'
import json
import sys

before, after = sys.argv[1:]
with open(before) as source:
    config = json.load(source)
if not isinstance(config, dict) or not config.get('AllowOrigins'):
    raise SystemExit('API CORS has no configured origins; refusing to change it')
config['AllowMethods'] = sorted(set(config.get('AllowMethods', [])) | {'GET', 'PUT', 'OPTIONS'})
config['AllowHeaders'] = sorted(set(config.get('AllowHeaders', [])) | {'authorization', 'content-type'})
with open(after, 'w') as destination:
    json.dump(config, destination, indent=2)
PY
aws apigatewayv2 update-api --api-id "$API_ID" --cors-configuration "file://$GEN/cors-after.json" >/dev/null
aws apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].[RouteKey,AuthorizationType]' --output table
printf '\nProfile v1 backend deployed. Existing users see onboarding once on their next visit.\n'
