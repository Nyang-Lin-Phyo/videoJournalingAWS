#!/usr/bin/env bash
# Explicit single-journal replay for a queued, unleased upload with no visible queue jobs.
# This is NOT a global SQS retry or queue purge.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
source infra/.phase3-resource-ids.env
export AWS_DEFAULT_REGION="$AWS_REGION" AWS_PAGER=""
: "${AWS_ACCOUNT:?}" "${UPLOAD_BUCKET:?}" "${JOURNAL_TABLE:?}" "${JOB_QUEUE_URL:?}"
ID="${1:-}"
[[ "$ID" =~ ^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$ ]] || { echo 'Usage: bash infra/requeue-one-journal.sh UPLOAD_UUID' >&2; exit 2; }
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$AWS_ACCOUNT" ]] || { echo 'Wrong AWS account' >&2; exit 1; }
# Refuse a replay if the queue indicates pending/inflight work. Approximate counts
# cannot guarantee absence of an existing message; check other monitoring too.
ATTRS="$(aws sqs get-queue-attributes --queue-url "$JOB_QUEUE_URL" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible --output json)"
export ATTRS
python3 - <<'PYQUEUE'
import os,json
a=json.loads(os.environ['ATTRS']).get('Attributes',{})
if any(int(a.get(k,'0')) for k in ('ApproximateNumberOfMessages','ApproximateNumberOfMessagesNotVisible')):
    raise SystemExit('Queue reports pending or in-flight messages. Do not manually requeue yet.')
PYQUEUE
ITEM="$(aws dynamodb get-item --table-name "$JOURNAL_TABLE" --key "{\"uploadId\":{\"S\":\"$ID\"}}" --consistent-read --query Item --output json)"
export ITEM
BODY="$(python3 - "$ID" "$UPLOAD_BUCKET" <<'PYBODY'
import json,os,re,sys
uid,bucket=sys.argv[1:]
item=json.loads(os.environ['ITEM'])
def s(k): return item.get(k,{}).get('S','')
if s('status')!='queued': raise SystemExit('Journal is not queued: '+s('status'))
if 'leaseToken' in item: raise SystemExit('Journal has an active processing lease')
if not s('userId') or not s('videoKey'):
    raise SystemExit('Journal missing owner or videoKey')
key=s('videoKey')
if key != f"uploads/{s('userId')}/{uid}.mp4":
    raise SystemExit('Unexpected S3 key/owner; aborting')
print(json.dumps({'Records':[{'eventSource':'aws:s3','s3':{'bucket':{'name':bucket},'object':{'key':key}}}]}))
PYBODY
)"
VIDEO_KEY="$(aws dynamodb get-item --table-name "$JOURNAL_TABLE" --key "{\"uploadId\":{\"S\":\"$ID\"}}" --consistent-read --query 'Item.videoKey.S' --output text)"
aws s3api head-object --bucket "$UPLOAD_BUCKET" --key "$VIDEO_KEY" >/dev/null
echo "Will requeue only $ID ($VIDEO_KEY)."
echo 'SQS counts are approximate; ensure no processing is already underway.'
read -r -p 'Type REQUEUE to send one processing message: ' ANSWER
[[ "$ANSWER" == REQUEUE ]] || { echo 'Cancelled'; exit 0; }
aws sqs send-message --queue-url "$JOB_QUEUE_URL" --message-body "$BODY" --query '[MessageId,MD5OfMessageBody]' --output table
echo 'Queued one journal event. Watch Lambda logs and DynamoDB status.'
