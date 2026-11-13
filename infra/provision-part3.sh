#!/usr/bin/env bash
# SAFE: creates only a DynamoDB table, SQS queue and DLQ; leaves current live API/S3 trigger untouched.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
export AWS_DEFAULT_REGION="$AWS_REGION" AWS_PAGER=""
: "${AWS_REGION:?}" "${AWS_ACCOUNT:?}" "${UPLOAD_BUCKET:?}" "${START_FUNC:?}"
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$AWS_ACCOUNT" ]] || { echo "Unexpected AWS account" >&2; exit 1; }
SUFFIX="${START_FUNC##*-}"
TABLE="reverie-journals-${SUFFIX}"
QUEUE_NAME="reverie-video-jobs-${SUFFIX}"
DLQ_NAME="reverie-video-dlq-${SUFFIX}"
mkdir -p infra/phase3-generated
GEN=infra/phase3-generated
printf '[1/4] DynamoDB table: %s\n' "$TABLE"
if ! aws dynamodb describe-table --table-name "$TABLE" >/dev/null 2>&1; then
  aws dynamodb create-table \
    --table-name "$TABLE" \
    --attribute-definitions AttributeName=uploadId,AttributeType=S AttributeName=userId,AttributeType=S AttributeName=userCreatedAt,AttributeType=S \
    --key-schema AttributeName=uploadId,KeyType=HASH \
    --global-secondary-indexes '[{"IndexName":"userId-createdAt-index","KeySchema":[{"AttributeName":"userId","KeyType":"HASH"},{"AttributeName":"userCreatedAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]' \
    --billing-mode PAY_PER_REQUEST >/dev/null
fi
aws dynamodb wait table-exists --table-name "$TABLE"
TABLE_ARN="$(aws dynamodb describe-table --table-name "$TABLE" --query Table.TableArn --output text)"

printf '[2/4] Dead-letter queue: %s\n' "$DLQ_NAME"
DLQ_URL="$(aws sqs create-queue --queue-name "$DLQ_NAME" --attributes MessageRetentionPeriod=1209600 --query QueueUrl --output text)"
DLQ_ARN="$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"
printf '[3/4] Primary queue: %s\n' "$QUEUE_NAME"
cat > "$GEN/sqs-create-attributes.json" <<EOF
{"VisibilityTimeout":"3600","ReceiveMessageWaitTimeSeconds":"20","MessageRetentionPeriod":"345600","RedrivePolicy":"{\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":\"5\"}"}
EOF
if QUEUE_URL="$(aws sqs get-queue-url --queue-name "$QUEUE_NAME" --query QueueUrl --output text 2>/dev/null)"; then
  echo "Queue already exists; checking configuration."
else
  QUEUE_URL="$(aws sqs create-queue --queue-name "$QUEUE_NAME" --attributes "file://$GEN/sqs-create-attributes.json" --query QueueUrl --output text)"
fi
QUEUE_ARN="$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"

printf '[4/4] Allow this S3 bucket to publish to the queue\n'
cat > "$GEN/queue-policy.json" <<EOF
{"Version":"2012-10-17","Statement":[{"Sid":"AllowUploadBucketS3Events","Effect":"Allow","Principal":{"Service":"s3.amazonaws.com"},"Action":"sqs:SendMessage","Resource":"${QUEUE_ARN}","Condition":{"ArnEquals":{"aws:SourceArn":"arn:aws:s3:::${UPLOAD_BUCKET}"},"StringEquals":{"aws:SourceAccount":"${AWS_ACCOUNT}"}}}]}
EOF
# Warning: This replaces a preexisting queue resource policy; intended for a newly dedicated queue.
python3 - "$GEN/queue-policy.json" "$GEN/queue-attributes.json" <<'PY'
import json,sys
policy=json.load(open(sys.argv[1]))
json.dump({'Policy':json.dumps(policy,separators=(',',':'))},open(sys.argv[2],'w'))
PY
aws sqs set-queue-attributes --queue-url "$QUEUE_URL" --attributes "file://$GEN/queue-attributes.json"
cat > infra/.phase3-resource-ids.env <<EOF
export JOURNAL_TABLE='${TABLE}'
export JOURNAL_TABLE_ARN='${TABLE_ARN}'
export JOB_QUEUE_URL='${QUEUE_URL}'
export JOB_QUEUE_ARN='${QUEUE_ARN}'
export JOB_DLQ_URL='${DLQ_URL}'
export JOB_DLQ_ARN='${DLQ_ARN}'
EOF
printf 'Resources created. No live Lambda, API route, or S3 notification changed.\n'
printf 'Saved resource IDs in infra/.phase3-resource-ids.env\n'
