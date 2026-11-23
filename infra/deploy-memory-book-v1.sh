#!/usr/bin/env bash
# Deploy owner-scoped memory books to the existing authenticated results API.
# Renderer image/function must exist first; see infra/MEMORY_BOOKS.md.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
source infra/.phase3-resource-ids.env
[[ -f infra/.cognito.env ]] && source infra/.cognito.env
[[ -f infra/.auth-api.env ]] && source infra/.auth-api.env
[[ -f infra/.auth-hosting.env ]] && source infra/.auth-hosting.env
export AWS_DEFAULT_REGION="${AWS_REGION:-us-east-1}" AWS_PAGER=""
: "${AWS_ACCOUNT:?}" "${AWS_REGION:?}" "${API_ID:?}" "${AUTHORIZER_ID:?}" "${RESULT_FUNC:?}" "${RESULT_ROLE:?}" "${UPLOAD_BUCKET:?}" "${JOURNAL_TABLE:?}" "${GEMINI_SECRET_ARN:?}" "${MEMORY_RENDERER_ARN:?}"

if [[ "${CONFIRM_MEMORY_BOOKS_V1:-}" != YES ]]; then
  echo 'Review the changes and target account. Run CONFIRM_MEMORY_BOOKS_V1=YES bash infra/deploy-memory-book-v1.sh to deploy.' >&2
  exit 1
fi
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$AWS_ACCOUNT" ]] || { echo 'Wrong AWS account; refusing.' >&2; exit 1; }
[[ "$(aws lambda get-function-configuration --function-name "$RESULT_FUNC" --query Handler --output text)" == auth_results.handler ]] || { echo 'Unexpected results handler; refusing.' >&2; exit 1; }
[[ "$(aws dynamodb describe-table --table-name "$JOURNAL_TABLE" --query 'Table.GlobalSecondaryIndexes[?IndexName==`userId-createdAt-index`].IndexStatus | [0]' --output text)" == ACTIVE ]] || { echo 'Required owner GSI is not ACTIVE.' >&2; exit 1; }
aws lambda get-function-configuration --function-name "$MEMORY_RENDERER_ARN" >/dev/null

OUT=infra/memory-books-generated
mkdir -p "$OUT"
python3 -m py_compile infra/lambda/auth_results.py infra/lambda/user_profile.py infra/lambda/journal_pages.py
python3 - "$OUT/results-memory-books.zip" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    for name in ('auth_results.py', 'user_profile.py', 'journal_pages.py', 'memory-book-templates.json'):
        z.write('infra/lambda/' + name, name)
PY
aws lambda get-function-configuration --function-name "$RESULT_FUNC" --query Environment.Variables --output json > "$OUT/env-before.json"
python3 - "$OUT/env-before.json" "$OUT/env-after.json" "$MEMORY_RENDERER_ARN" "$GEMINI_SECRET_ARN" <<'PY'
import json,sys
env=json.load(open(sys.argv[1]))
env.update(MEMORY_RENDERER_ARN=sys.argv[3], GEMINI_SECRET_ARN=sys.argv[4])
json.dump({'Variables':env},open(sys.argv[2],'w'))
PY
aws lambda update-function-code --function-name "$RESULT_FUNC" --zip-file "fileb://$OUT/results-memory-books.zip" >/dev/null
aws lambda wait function-updated-v2 --function-name "$RESULT_FUNC"
aws lambda update-function-configuration --function-name "$RESULT_FUNC" --environment "file://$OUT/env-after.json" >/dev/null
aws lambda wait function-updated-v2 --function-name "$RESULT_FUNC"

python3 - "$API_ID" "$OUT/routes-before.json" <<'PY'
import json,subprocess,sys
data=subprocess.check_output(['aws','apigatewayv2','get-routes','--api-id',sys.argv[1],'--output','json'])
routes={r['RouteKey']:r for r in json.loads(data)['Items']}
source=routes.get('GET /uploads/{upload_id}/result')
if not source or source.get('AuthorizationType')!='JWT' or not source.get('Target'):
    raise SystemExit('Missing existing JWT results route; refusing')
open(sys.argv[2],'wb').write(data)
PY
TARGET="$(python3 - "$OUT/routes-before.json" <<'PY'
import json,sys
print(next(x['Target'] for x in json.load(open(sys.argv[1]))['Items'] if x['RouteKey']=='GET /uploads/{upload_id}/result'))
PY
)"
for key in 'POST /journal-exports' 'GET /journal-exports/{job_id}' 'GET /memory-books' 'GET /memory-narratives' 'PUT /memory-books/{book_id}' 'DELETE /memory-books/{book_id}' 'POST /memory-books/{book_id}/memories/{upload_id}/rewrite' 'POST /memory-books/{book_id}/reflections' 'POST /memory-books/{book_id}/exports' 'GET /memory-books/{book_id}/exports' 'GET /memory-books/{book_id}/exports/{revision}' 'POST /memory-books/{book_id}/exports/{revision}/retry' 'POST /memory-photos' 'GET /memory-photos' 'GET /memory-photos/{photo_id}' 'POST /memory-photos/{photo_id}/finalize' 'GET /memory-preferences' 'PUT /memory-preferences' 'GET /journals/{upload_id}/page' 'PUT /journals/{upload_id}/page' 'GET /journal-days/{day}' 'PUT /journal-days/{day}'; do
  id="$(aws apigatewayv2 get-routes --api-id "$API_ID" --output json |
    python3 -c 'import json,sys; key=sys.argv[1]; routes=json.load(sys.stdin).get("Items", []); print(next((r["RouteId"] for r in routes if r.get("RouteKey")==key), ""))' "$key")"
  if [[ -z "$id" || "$id" == None ]]; then
    aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$key" --target "$TARGET" --authorization-type JWT --authorizer-id "$AUTHORIZER_ID" >/dev/null
  else
    aws apigatewayv2 update-route --api-id "$API_ID" --route-id "$id" --target "$TARGET" --authorization-type JWT --authorizer-id "$AUTHORIZER_ID" >/dev/null
  fi
  method="${key%% *}"; path="${key#* }"; arn_path="${path//\{book_id\}/*}"; arn_path="${arn_path//\{upload_id\}/*}"; arn_path="${arn_path//\{revision\}/*}"; arn_path="${arn_path//\{photo_id\}/*}"; arn_path="${arn_path//\{job_id\}/*}"; arn_path="${arn_path//\{day\}/*}"
  sid="AllowMemoryBooks${method}$(echo "$path" | tr -cd '[:alnum:]' | cut -c1-35)"
  if ! aws lambda get-policy --function-name "$RESULT_FUNC" --query Policy --output text 2>/dev/null | grep -q "$sid"; then
    aws lambda add-permission --function-name "$RESULT_FUNC" --statement-id "$sid" --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:${AWS_REGION}:${AWS_ACCOUNT}:${API_ID}/*/${method}${arn_path}" >/dev/null
  fi
done

python3 - "$API_ID" "$OUT/cors-before.json" "$OUT/cors-after.json" <<'PY'
import json,subprocess,sys
api,src,dst=sys.argv[1:]
obj=json.loads(subprocess.check_output(['aws','apigatewayv2','get-api','--api-id',api,'--query','CorsConfiguration','--output','json']))
if not obj or not obj.get('AllowOrigins'): raise SystemExit('No existing API CORS origins; refusing to invent one')
obj['AllowMethods']=sorted(set(obj.get('AllowMethods',[]))|{'GET','PUT','POST','DELETE','OPTIONS'})
obj['AllowHeaders']=sorted(set(obj.get('AllowHeaders',[]))|{'authorization','content-type'})
json.dump(obj,open(dst,'w'),indent=2)
json.dump(obj,open(src,'w'),indent=2)
PY
aws apigatewayv2 update-api --api-id "$API_ID" --cors-configuration "file://$OUT/cors-after.json" >/dev/null

python3 - "$OUT/renderer-invoke-policy.json" "$MEMORY_RENDERER_ARN" "$GEMINI_SECRET_ARN" "$UPLOAD_BUCKET" "arn:aws:dynamodb:${AWS_REGION}:${AWS_ACCOUNT}:table/${JOURNAL_TABLE}" <<'PY'
import json,sys
policy={'Version':'2012-10-17','Statement':[{'Effect':'Allow','Action':'lambda:InvokeFunction','Resource':sys.argv[2]},
 {'Effect':'Allow','Action':'secretsmanager:GetSecretValue','Resource':sys.argv[3]},
 {'Effect':'Allow','Action':['dynamodb:TransactWriteItems','dynamodb:ConditionCheckItem'],'Resource':sys.argv[5]},
 {'Effect':'Allow','Action':'s3:GetObject','Resource':f'arn:aws:s3:::{sys.argv[4]}/transcripts/*'},
 {'Effect':'Allow','Action':'s3:PutObject','Resource':f'arn:aws:s3:::{sys.argv[4]}/transcripts/*/*.txt'},
 {'Effect':'Allow','Action':['s3:DeleteObject','s3:DeleteObjectVersion'],'Resource':f'arn:aws:s3:::{sys.argv[4]}/transcripts/*/*.txt'},
 {'Effect':'Allow','Action':'s3:ListBucketVersions','Resource':f'arn:aws:s3:::{sys.argv[4]}','Condition':{'StringLike':{'s3:prefix':['transcripts/*']}}},
 {'Effect':'Allow','Action':'dynamodb:BatchWriteItem','Resource':sys.argv[5],'Condition':{'ForAllValues:StringLike':{'dynamodb:LeadingKeys':['memory-export#*']}}},
 {'Effect':'Allow','Action':'s3:GetObject','Resource':[f'arn:aws:s3:::{sys.argv[4]}/exports/*',f'arn:aws:s3:::{sys.argv[4]}/photos/*',f'arn:aws:s3:::{sys.argv[4]}/uploads/*/memory-photos/*']},
 {'Effect':'Allow','Action':'s3:PutObject','Resource':f'arn:aws:s3:::{sys.argv[4]}/uploads/*/memory-photos/*'},
 {'Effect':'Allow','Action':['s3:DeleteObject','s3:DeleteObjectVersion'],'Resource':[f'arn:aws:s3:::{sys.argv[4]}/exports/*',f'arn:aws:s3:::{sys.argv[4]}/photos/*',f'arn:aws:s3:::{sys.argv[4]}/uploads/*/memory-photos/*']},
 {'Effect':'Allow','Action':'s3:ListBucketVersions','Resource':f'arn:aws:s3:::{sys.argv[4]}','Condition':{'StringLike':{'s3:prefix':['exports/*','photos/*','uploads/*/memory-photos/*']}}}]}
json.dump(policy,open(sys.argv[1],'w'),indent=2)
PY
aws iam put-role-policy --role-name "$RESULT_ROLE" --policy-name ReverieMemoryBooksInvoke --policy-document "file://$OUT/renderer-invoke-policy.json" >/dev/null

python3 - "$API_ID" "$UPLOAD_BUCKET" "$HTTPS_SITE_ORIGIN" "$OUT/bucket-cors.json" <<'PY'
import json,subprocess,sys
api,bucket,origin,out=sys.argv[1:]
try:
    cors=json.loads(subprocess.check_output(['aws','s3api','get-bucket-cors','--bucket',bucket,'--output','json']))['CORSRules']
except subprocess.CalledProcessError:
    raise SystemExit('Upload bucket has no CORS policy; configure the trusted website origin before deploying')
matched=[rule for rule in cors if origin in rule.get('AllowedOrigins',[])]
if not matched: raise SystemExit('Upload bucket CORS does not include the trusted site origin; refusing to invent one')
for rule in matched:
    rule['AllowedMethods']=sorted(set(rule.get('AllowedMethods',[]))|{'GET','POST'})
    rule['AllowedHeaders']=sorted(set(rule.get('AllowedHeaders',[]))|{'*'})
json.dump({'CORSRules':cors},open(out,'w'),indent=2)
PY
aws s3api put-bucket-cors --bucket "$UPLOAD_BUCKET" --cors-configuration "file://$OUT/bucket-cors.json" >/dev/null
echo 'Memory Books API deployed. Renderer must have table read/update and private exports-prefix write access. No user data was modified.'
