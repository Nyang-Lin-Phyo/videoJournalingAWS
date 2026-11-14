#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
source infra/.phase3-resource-ids.env
[[ -f infra/.auth-api.env ]] && source infra/.auth-api.env
[[ -f infra/.auth-hosting.env ]] && source infra/.auth-hosting.env
export AWS_DEFAULT_REGION="${AWS_REGION:-us-east-1}" AWS_PAGER=""
: "${AWS_ACCOUNT:?}" "${AWS_REGION:?}" "${API_ID:?}" "${FUNC_NAME:?}" "${RESULT_FUNC:?}" "${RESULT_ROLE:?}" "${UPLOAD_BUCKET:?}" "${JOURNAL_TABLE_ARN:?}" "${AUTHORIZER_ID:?}" "${HTTPS_SITE_ORIGIN:?}"
[[ "${CONFIRM_HISTORY_V5:-}" == "YES" ]] || { echo 'Set CONFIRM_HISTORY_V5=YES after reviewing deployment impact.' >&2; exit 1; }
[[ "$HTTPS_SITE_ORIGIN" == https://* ]] || { echo 'HTTPS site origin missing.' >&2; exit 1; }
GEN=infra/phase5-generated
mkdir -p "$GEN"

printf '[1/7] Verify correct AWS account and current authenticated API\n'
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$AWS_ACCOUNT" ]] || { echo 'Wrong AWS account'; exit 1; }
aws apigatewayv2 get-authorizer --api-id "$API_ID" --authorizer-id "$AUTHORIZER_ID" >/dev/null
[[ "$(aws lambda get-function-configuration --function-name "$FUNC_NAME" --query Handler --output text)" == 'auth_signer.handler' ]] || { echo 'Current signer handler is unexpected'; exit 1; }
[[ "$(aws lambda get-function-configuration --function-name "$RESULT_FUNC" --query Handler --output text)" == 'auth_results.handler' ]] || { echo 'Current results handler is unexpected'; exit 1; }
# Deleting without version IDs leaves prior versions behind in a versioned bucket.
VERSIONING="$(aws s3api get-bucket-versioning --bucket "$UPLOAD_BUCKET" --query Status --output text)"
if [[ "$VERSIONING" == 'Enabled' || "$VERSIONING" == 'Suspended' ]]; then
  echo 'Versioned/suspended video bucket detected. This demo deletion implementation refuses to erase journals.' >&2
  echo 'Implement version-aware permanent deletion before deploying user-facing Delete.' >&2
  exit 1
fi

printf '[2/7] Back up the existing signer and results Lambda ZIPs\n'
for pair in "$FUNC_NAME:signer" "$RESULT_FUNC:results"; do
  name="${pair%%:*}"; part="${pair##*:}"
  url="$(aws lambda get-function --function-name "$name" --query Code.Location --output text)"
  curl -fsSL "$url" -o "$GEN/${part}-before-v5.zip"
done
aws apigatewayv2 get-routes --api-id "$API_ID" --output json > "$GEN/routes-before-v5.json"
aws apigatewayv2 get-api --api-id "$API_ID" --query CorsConfiguration --output json > "$GEN/api-cors-before-v5.json"
aws s3api get-bucket-cors --bucket "$UPLOAD_BUCKET" --output json > "$GEN/s3-cors-before-v5.json"

printf '[3/7] Add narrowly scoped data-management permissions to results Lambda\n'
cat > "$GEN/management-policy.json" <<EOF
{"Version":"2012-10-17","Statement":[
{"Effect":"Allow","Action":["dynamodb:UpdateItem","dynamodb:DeleteItem"],"Resource":"${JOURNAL_TABLE_ARN}"},
{"Effect":"Allow","Action":["s3:GetObject","s3:DeleteObject"],"Resource":["arn:aws:s3:::${UPLOAD_BUCKET}/uploads/*","arn:aws:s3:::${UPLOAD_BUCKET}/transcripts/*","arn:aws:s3:::${UPLOAD_BUCKET}/results/*"]},
{"Effect":"Allow","Action":"s3:GetBucketVersioning","Resource":"arn:aws:s3:::${UPLOAD_BUCKET}"}
]}
EOF
aws iam put-role-policy --role-name "$RESULT_ROLE" --policy-name ReverieV5ManageOwnedJournals --policy-document "file://$GEN/management-policy.json"

printf '[4/7] Update signer and results Lambda source; preserve working worker\n'
python3 - "$GEN" <<'PY'
import pathlib,sys,zipfile
output=pathlib.Path(sys.argv[1]); code=pathlib.Path('infra/lambda')
for key,name in [('signer','auth_signer.py'),('results','auth_results.py')]:
    with zipfile.ZipFile(output/(key+'.zip'),'w',zipfile.ZIP_DEFLATED) as f:
        f.write(code/name,name)
PY
aws lambda update-function-code --function-name "$FUNC_NAME" --zip-file "fileb://$GEN/signer.zip" >/dev/null
aws lambda wait function-updated-v2 --function-name "$FUNC_NAME"
aws lambda update-function-code --function-name "$RESULT_FUNC" --zip-file "fileb://$GEN/results.zip" >/dev/null
aws lambda wait function-updated-v2 --function-name "$RESULT_FUNC"

printf '[5/7] Register JWT-protected playback, rename and delete routes\n'
python3 - "$GEN/routes-before-v5.json" "$GEN/target.env" <<'PY'
import json,sys
routes={x['RouteKey']:x for x in json.load(open(sys.argv[1]))['Items']}
reference=routes.get('GET /uploads/{upload_id}/result')
if not reference or reference.get('AuthorizationType') != 'JWT' or not reference.get('Target'):
    raise SystemExit('Protected GET result route is missing; abort')
with open(sys.argv[2],'w') as f: f.write("RESULT_TARGET='%s'\n"%reference['Target'])
PY
source "$GEN/target.env"
for key in 'GET /uploads/{upload_id}/video-url' 'PATCH /journals/{upload_id}' 'DELETE /journals/{upload_id}'; do
  # Idempotently create the route if it does not exist.
  route_id="$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?RouteKey=='${key}'].RouteId | [0]" --output text)"
  if [[ -z "$route_id" || "$route_id" == 'None' ]]; then
    route_id="$(aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$key" --target "$RESULT_TARGET" --authorization-type JWT --authorizer-id "$AUTHORIZER_ID" --query RouteId --output text)"
  else
    aws apigatewayv2 update-route --api-id "$API_ID" --route-id "$route_id" --target "$RESULT_TARGET" --authorization-type JWT --authorizer-id "$AUTHORIZER_ID" >/dev/null
  fi
  method="${key%% *}"; path="${key#* }"
  pattern="${path//\{upload_id\}/*}"
  sid="AllowReverieV5${method}$(echo "$path" | tr -cd '[:alnum:]' | cut -c 1-45)"
  if ! aws lambda get-policy --function-name "$RESULT_FUNC" --query Policy --output text 2>/dev/null | grep -q "$sid"; then
    aws lambda add-permission --function-name "$RESULT_FUNC" --statement-id "$sid" \
      --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
      --source-arn "arn:aws:execute-api:${AWS_REGION}:${AWS_ACCOUNT}:${API_ID}/*/${method}${pattern}" >/dev/null
  fi
done

printf '[6/7] Extend API CORS to allow PATCH/DELETE; keep existing trusted origins\n'
python3 - "$GEN/api-cors-before-v5.json" "$GEN/api-cors-after-v5.json" "$HTTPS_SITE_ORIGIN" <<'PY'
import json,sys
before,after,origin=sys.argv[1:]
obj=json.load(open(before))
if not isinstance(obj,dict) or origin not in obj.get('AllowOrigins',[]):
    raise SystemExit('API CORS does not include the trusted HTTPS origin; refusing change')
obj['AllowMethods']=sorted(set(obj.get('AllowMethods',[]))|{'GET','POST','PATCH','DELETE','OPTIONS'})
obj['AllowHeaders']=sorted(set(obj.get('AllowHeaders',[]))|{'authorization','content-type'})
with open(after,'w') as out: json.dump(obj,out,indent=2)
PY
aws apigatewayv2 update-api --api-id "$API_ID" --cors-configuration "file://$GEN/api-cors-after-v5.json" >/dev/null

printf '[7/7] Add GET/HEAD CORS to the private video bucket\n'
python3 - "$GEN/s3-cors-before-v5.json" "$GEN/s3-cors-after-v5.json" "$HTTPS_SITE_ORIGIN" <<'PY'
import json,sys
before,after,origin=sys.argv[1:]
data=json.load(open(before)); matched=False
for rule in data.get('CORSRules',[]):
    if origin in rule.get('AllowedOrigins',[]):
        rule['AllowedMethods']=sorted(set(rule['AllowedMethods']) | {'GET','HEAD'})
        rule['ExposeHeaders']=sorted(set(rule.get('ExposeHeaders',[])) | {'ETag','Content-Length','Content-Range','Accept-Ranges'})
        matched=True
if not matched: raise SystemExit('No trusted HTTPS S3 CORS rule exists; refusing change')
with open(after,'w') as out: json.dump(data,out,indent=2)
PY
aws s3api put-bucket-cors --bucket "$UPLOAD_BUCKET" --cors-configuration "file://$GEN/s3-cors-after-v5.json"
aws apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].[RouteKey,AuthorizationType]' --output table
printf '\nV5 backend deployed. SQS worker and existing journal data are unchanged.\n'
