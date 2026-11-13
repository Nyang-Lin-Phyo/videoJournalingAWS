#!/usr/bin/env bash
# CUTOVER: changes your LIVE signer/results/worker and S3 notification.
# Run only after the Google/Cognito frontend is deployed and a JWT authorizer exists.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
source infra/.phase3-resource-ids.env
export AWS_DEFAULT_REGION="$AWS_REGION" AWS_PAGER=""
: "${AWS_ACCOUNT:?}" "${AWS_REGION:?}" "${API_ID:?}" "${FUNC_NAME:?}" "${ROLE_NAME:?}" "${START_FUNC:?}" "${START_ROLE:?}" "${RESULT_FUNC:?}" "${RESULT_ROLE:?}" "${UPLOAD_BUCKET:?}" "${JOURNAL_TABLE:?}" "${JOB_QUEUE_ARN:?}" "${AUTHORIZER_ID:?}" "${HTTPS_SITE_ORIGIN:?}"
[[ "${CONFIRM_CUTOVER:-}" == 'YES' ]] || { echo 'Set CONFIRM_CUTOVER=YES after a maintenance/cutover review.' >&2; exit 1; }
[[ "$HTTPS_SITE_ORIGIN" == https://* ]] || { echo 'HTTPS_SITE_ORIGIN must be the CloudFront HTTPS origin.' >&2; exit 1; }
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$AWS_ACCOUNT" ]] || { echo 'Wrong AWS account' >&2; exit 1; }
aws apigatewayv2 get-authorizer --api-id "$API_ID" --authorizer-id "$AUTHORIZER_ID" >/dev/null
aws lambda get-function --function-name "$FUNC_NAME" >/dev/null
aws lambda get-function --function-name "$START_FUNC" >/dev/null
aws lambda get-function --function-name "$RESULT_FUNC" >/dev/null
GEN=infra/phase3-generated
mkdir -p "$GEN"
ELEVENLABS_SECRET_ARN="$(aws secretsmanager describe-secret --secret-id "videojournal/elevenlabs/${AWS_ACCOUNT}" --query ARN --output text)"
GEMINI_SECRET_ARN="$(aws secretsmanager describe-secret --secret-id "videojournal/gemini/${AWS_ACCOUNT}" --query ARN --output text)"

printf '[1/8] Set scoped IAM policies for API and worker\n'
cat > "$GEN/signer-policy.json" <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["dynamodb:PutItem","dynamodb:DeleteItem"],"Resource":"${JOURNAL_TABLE_ARN}"}]}
EOF
cat > "$GEN/results-policy.json" <<EOF
{"Version":"2012-10-17","Statement":[
{"Effect":"Allow","Action":["dynamodb:GetItem","dynamodb:Query"],"Resource":["${JOURNAL_TABLE_ARN}","${JOURNAL_TABLE_ARN}/index/userId-createdAt-index"]},
{"Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::${UPLOAD_BUCKET}/transcripts/*"}]}
EOF
cat > "$GEN/worker-policy.json" <<EOF
{"Version":"2012-10-17","Statement":[
{"Effect":"Allow","Action":["dynamodb:GetItem","dynamodb:UpdateItem"],"Resource":"${JOURNAL_TABLE_ARN}"},
{"Effect":"Allow","Action":["sqs:ReceiveMessage","sqs:DeleteMessage","sqs:GetQueueAttributes"],"Resource":"${JOB_QUEUE_ARN}"},
{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject"],"Resource":["arn:aws:s3:::${UPLOAD_BUCKET}/uploads/*","arn:aws:s3:::${UPLOAD_BUCKET}/transcripts/*"]},
{"Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::${UPLOAD_BUCKET}"},
{"Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":["${ELEVENLABS_SECRET_ARN}","${GEMINI_SECRET_ARN}"]}]}
EOF
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name ReverieV3Signer --policy-document "file://$GEN/signer-policy.json"
aws iam put-role-policy --role-name "$RESULT_ROLE" --policy-name ReverieV3Results --policy-document "file://$GEN/results-policy.json"
aws iam put-role-policy --role-name "$START_ROLE" --policy-name ReverieV3Worker --policy-document "file://$GEN/worker-policy.json"

printf '[2/8] Back up and switch S3 uploads event from direct Lambda to SQS\n'
aws s3api get-bucket-notification-configuration --bucket "$UPLOAD_BUCKET" --output json > "$GEN/s3-notification-before-v3.json"
python3 - "$GEN/s3-notification-before-v3.json" "$GEN/s3-notification-after-v3.json" "$JOB_QUEUE_ARN" "$(aws lambda get-function-configuration --function-name "$START_FUNC" --query FunctionArn --output text)" <<'PY'
import json,sys
before,after,queue_arn,old_lambda=sys.argv[1:]
obj=json.load(open(before))
# Only remove object creation events from the old Reverie processing Lambda.
old=obj.get('LambdaFunctionConfigurations',[])
kept=[]
for record in old:
    if record.get('LambdaFunctionArn') == old_lambda and any(x.startswith('s3:ObjectCreated:') for x in record.get('Events',[])):
        other=[e for e in record['Events'] if not e.startswith('s3:ObjectCreated:')]
        if other:
            record=dict(record,Events=other)
            kept.append(record)
    else:
        kept.append(record)
obj['LambdaFunctionConfigurations']=kept
new={'Id':'ReverieV3SqsMp4','QueueArn':queue_arn,'Events':['s3:ObjectCreated:*'],
     'Filter':{'Key':{'FilterRules':[{'Name':'prefix','Value':'uploads/'},{'Name':'suffix','Value':'.mp4'}]}}}
queues=[x for x in obj.get('QueueConfigurations',[]) if x.get('Id') != 'ReverieV3SqsMp4']
queues.append(new)
obj['QueueConfigurations']=queues
json.dump(obj,open(after,'w'),indent=2)
PY
# This is an atomic replacement of the bucket notification configuration.
aws s3api put-bucket-notification-configuration --bucket "$UPLOAD_BUCKET" --notification-configuration "file://$GEN/s3-notification-after-v3.json"

printf '[3/8] Deploy v3 Lambda source packages\n'
python3 - "$GEN" <<'PY'
from zipfile import ZipFile, ZIP_DEFLATED
import pathlib,sys
root=pathlib.Path('infra/lambda'); out=pathlib.Path(sys.argv[1])
for name,files in {'signer':['auth_signer.py'],'results':['auth_results.py'],
                   'worker':['queue_worker.py','legacy_elevenlabs_provider.py']}.items():
    with ZipFile(out/(name+'.zip'),'w',ZIP_DEFLATED) as z:
        for filename in files:z.write(root/filename, filename)
PY
for job in "${FUNC_NAME}:signer" "${RESULT_FUNC}:results" "${START_FUNC}:worker"; do
  name="${job%%:*}"; kind="${job##*:}"
  aws lambda update-function-code --function-name "$name" --zip-file "fileb://$GEN/$kind.zip" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$name"
done

printf '[4/8] Update Lambda handlers and environment\n'
python3 - "$GEN" "$UPLOAD_BUCKET" "$JOURNAL_TABLE" "$ELEVENLABS_SECRET_ARN" "$GEMINI_SECRET_ARN" <<'PY'
import json,sys,pathlib
out,bucket,table,eleven,gemini=sys.argv[1:]
items={'signer':{'UPLOAD_BUCKET':bucket,'JOURNAL_TABLE':table},
       'results':{'UPLOAD_BUCKET':bucket,'JOURNAL_TABLE':table},
       'worker':{'UPLOAD_BUCKET':bucket,'JOURNAL_TABLE':table,
                 'ELEVENLABS_SECRET_ARN':eleven,'GEMINI_SECRET_ARN':gemini,
                 'ELEVENLABS_MODEL':'scribe_v3','GEMINI_MODEL':'gemini-3.5-flash-lite'}}
for name,values in items.items():
    pathlib.Path(out, name+'-env.json').write_text(json.dumps({'Variables':values}))
PY
aws lambda update-function-configuration --function-name "$FUNC_NAME" --handler auth_signer.handler --environment "file://$GEN/signer-env.json" >/dev/null
aws lambda wait function-updated-v2 --function-name "$FUNC_NAME"
aws lambda update-function-configuration --function-name "$RESULT_FUNC" --handler auth_results.handler --environment "file://$GEN/results-env.json" >/dev/null
aws lambda wait function-updated-v2 --function-name "$RESULT_FUNC"
aws lambda update-function-configuration --function-name "$START_FUNC" --handler queue_worker.handler --timeout 600 --memory-size 512 --environment "file://$GEN/worker-env.json" >/dev/null
aws lambda wait function-updated-v2 --function-name "$START_FUNC"

printf '[5/8] Create/secure GET /journals and existing API routes\n'
aws apigatewayv2 get-routes --api-id "$API_ID" --output json > "$GEN/api-routes-before-v3.json"
python3 - "$GEN/api-routes-before-v3.json" "$GEN/route-ids.env" <<'PY'
import json,sys
j=json.load(open(sys.argv[1])); data={x['RouteKey']:x for x in j['Items']}
for key in ('POST /uploads','GET /uploads/{upload_id}/result'):
    if key not in data: raise SystemExit('Missing required API route '+key)
with open(sys.argv[2],'w') as f:
    f.write("UPLOAD_ROUTE_ID='%s'\n"%data['POST /uploads']['RouteId'])
    f.write("RESULT_ROUTE_ID='%s'\n"%data['GET /uploads/{upload_id}/result']['RouteId'])
    f.write("RESULT_TARGET='%s'\n"%data['GET /uploads/{upload_id}/result']['Target'])
    if 'GET /journals' in data:
        f.write("JOURNALS_ROUTE_ID='%s'\n"%data['GET /journals']['RouteId'])
PY
source "$GEN/route-ids.env"
if [[ -z "${JOURNALS_ROUTE_ID:-}" ]]; then
  JOURNALS_ROUTE_ID="$(aws apigatewayv2 create-route --api-id "$API_ID" --route-key 'GET /journals' --target "$RESULT_TARGET" --query RouteId --output text)"
fi
if ! aws lambda get-policy --function-name "$RESULT_FUNC" --query Policy --output text 2>/dev/null | grep -q 'AllowV3Journals'; then
  aws lambda add-permission --function-name "$RESULT_FUNC" --statement-id AllowV3Journals \
    --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:${AWS_REGION}:${AWS_ACCOUNT}:${API_ID}/*/GET/journals" >/dev/null
fi
for route_id in "$UPLOAD_ROUTE_ID" "$RESULT_ROUTE_ID" "$JOURNALS_ROUTE_ID"; do
  aws apigatewayv2 update-route --api-id "$API_ID" --route-id "$route_id" \
    --authorization-type JWT --authorizer-id "$AUTHORIZER_ID" >/dev/null
done
cat > "$GEN/api-cors-v3.json" <<EOF
{"AllowOrigins":["${HTTPS_SITE_ORIGIN}","http://localhost:5173","http://127.0.0.1:5173"],"AllowMethods":["GET","POST","OPTIONS"],"AllowHeaders":["authorization","content-type"],"MaxAge":300}
EOF
aws apigatewayv2 update-api --api-id "$API_ID" --cors-configuration "file://$GEN/api-cors-v3.json" >/dev/null
# The browser also needs S3 CORS for the *presigned form POST* from CloudFront.
aws s3api get-bucket-cors --bucket "$UPLOAD_BUCKET" --output json > "$GEN/s3-cors-before-v3.json"
cat > "$GEN/s3-cors-v3.json" <<EOF
{"CORSRules":[{"AllowedOrigins":["${HTTPS_SITE_ORIGIN}","http://localhost:5173","http://127.0.0.1:5173"],"AllowedMethods":["POST"],"AllowedHeaders":["*"],"MaxAgeSeconds":3000}]}
EOF
aws s3api put-bucket-cors --bucket "$UPLOAD_BUCKET" --cors-configuration "file://$GEN/s3-cors-v3.json"

printf '[6/8] Connect SQS to the processing Lambda\n'
aws lambda list-event-source-mappings --function-name "$START_FUNC" --event-source-arn "$JOB_QUEUE_ARN" --output json > "$GEN/worker-mappings.json"
MAPPING_UUID="$(python3 - "$GEN/worker-mappings.json" <<'PY'
import json,sys
xs=json.load(open(sys.argv[1]))['EventSourceMappings']
print(xs[0]['UUID'] if xs else '')
PY
)"
if [[ -z "$MAPPING_UUID" ]]; then
  MAPPING_UUID="$(aws lambda create-event-source-mapping \
    --event-source-arn "$JOB_QUEUE_ARN" --function-name "$START_FUNC" \
    --batch-size 1 --function-response-types ReportBatchItemFailures \
    --scaling-config MaximumConcurrency=2 --query UUID --output text)"
fi

printf '[7/8] Verify route authorization and trigger mapping\n'
aws apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].[RouteKey,AuthorizationType]' --output table
aws lambda get-event-source-mapping --uuid "$MAPPING_UUID" --query '[State,BatchSize,EventSourceArn]' --output table

printf '[8/8] Save cutover information\n'
cat > infra/.phase3-cutover.env <<EOF
export AUTHORIZER_ID='${AUTHORIZER_ID}'
export HTTPS_SITE_ORIGIN='${HTTPS_SITE_ORIGIN}'
export MAPPING_UUID='${MAPPING_UUID}'
EOF
printf 'CUTOVER deployed. Test authenticated browser uploads and ownership before exposing real recordings.\n'
