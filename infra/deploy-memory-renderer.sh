#!/usr/bin/env bash
# Build and deploy the on-demand PDF renderer container. This script is never
# invoked by the web deployment; it requires an explicit confirmation token.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
source infra/.phase3-resource-ids.env
[[ -f infra/.cognito.env ]] && source infra/.cognito.env
[[ -f infra/.auth-api.env ]] && source infra/.auth-api.env
[[ -f infra/.auth-hosting.env ]] && source infra/.auth-hosting.env
export AWS_DEFAULT_REGION="${AWS_REGION:-us-east-1}" AWS_PAGER=""
: "${AWS_ACCOUNT:?}" "${AWS_REGION:?}" "${JOURNAL_TABLE:?}" "${JOURNAL_TABLE_ARN:?}" "${UPLOAD_BUCKET:?}" "${MEMORY_RENDERER_NAME:?}" "${MEMORY_RENDERER_ROLE_NAME:?}" "${MEMORY_RENDERER_ROLE_ARN:?}" "${MEMORY_RENDERER_REPOSITORY:?}"
if [[ "${CONFIRM_MEMORY_RENDERER:-}" != YES ]]; then
  echo 'Review the target account and image. Run CONFIRM_MEMORY_RENDERER=YES bash infra/deploy-memory-renderer.sh to build and deploy.' >&2
  exit 1
fi
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$AWS_ACCOUNT" ]] || { echo 'Wrong AWS account; refusing.' >&2; exit 1; }

OUT=infra/memory-renderer-generated
mkdir -p "$OUT"
if ! aws ecr describe-repositories --repository-names "$MEMORY_RENDERER_REPOSITORY" >/dev/null 2>&1; then
  aws ecr create-repository --repository-name "$MEMORY_RENDERER_REPOSITORY" --image-scanning-configuration scanOnPush=true --encryption-configuration encryptionType=AES256 >/dev/null
fi
IMAGE="${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com/${MEMORY_RENDERER_REPOSITORY}:v1"
aws ecr get-login-password | docker login --username AWS --password-stdin "${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com"
docker build --platform linux/amd64 -f infra/lambda/memory-renderer/Dockerfile -t "$IMAGE" infra/lambda
docker push "$IMAGE"

python3 - "$OUT/renderer-policy.json" "$JOURNAL_TABLE_ARN" "$UPLOAD_BUCKET" <<'PY'
import json,sys
policy={'Version':'2012-10-17','Statement':[
 {'Effect':'Allow','Action':['dynamodb:GetItem','dynamodb:UpdateItem'],'Resource':sys.argv[2]},
 {'Effect':'Allow','Action':'dynamodb:DeleteItem','Resource':sys.argv[2],'Condition':{'ForAllValues:StringLike':{'dynamodb:LeadingKeys':['memory-export#*']}}},
 {'Effect':'Allow','Action':'s3:GetObject','Resource':[f'arn:aws:s3:::{sys.argv[3]}/uploads/*/memory-photos/*',f'arn:aws:s3:::{sys.argv[3]}/photos/*',f'arn:aws:s3:::{sys.argv[3]}/transcripts/*']},
 {'Effect':'Allow','Action':'s3:DeleteObject','Resource':f'arn:aws:s3:::{sys.argv[3]}/uploads/*/memory-photos/*'},
 {'Effect':'Allow','Action':['s3:DeleteObject','s3:DeleteObjectVersion'],'Resource':f'arn:aws:s3:::{sys.argv[3]}/exports/*/*.pdf'},
 {'Effect':'Allow','Action':'s3:PutObject','Resource':[f'arn:aws:s3:::{sys.argv[3]}/exports/*',f'arn:aws:s3:::{sys.argv[3]}/photos/*']},
 {'Effect':'Allow','Action':['logs:CreateLogGroup','logs:CreateLogStream','logs:PutLogEvents'],'Resource':'*'}]}
json.dump(policy,open(sys.argv[1],'w'),indent=2)
PY
aws iam put-role-policy --role-name "$MEMORY_RENDERER_ROLE_NAME" --policy-name ReverieMemoryRenderer --policy-document "file://$OUT/renderer-policy.json" >/dev/null
if aws lambda get-function --function-name "$MEMORY_RENDERER_NAME" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$MEMORY_RENDERER_NAME" --image-uri "$IMAGE" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$MEMORY_RENDERER_NAME"
  aws lambda update-function-configuration --function-name "$MEMORY_RENDERER_NAME" --timeout 900 --memory-size 2048 --environment "Variables={JOURNAL_TABLE=${JOURNAL_TABLE},UPLOAD_BUCKET=${UPLOAD_BUCKET}}" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$MEMORY_RENDERER_NAME"
else
  aws lambda create-function --function-name "$MEMORY_RENDERER_NAME" --package-type Image --code ImageUri="$IMAGE" --role "$MEMORY_RENDERER_ROLE_ARN" --timeout 900 --memory-size 2048 --environment "Variables={JOURNAL_TABLE=${JOURNAL_TABLE},UPLOAD_BUCKET=${UPLOAD_BUCKET}}" >/dev/null
  aws lambda wait function-active-v2 --function-name "$MEMORY_RENDERER_NAME"
fi
aws lambda get-function-configuration --function-name "$MEMORY_RENDERER_NAME" --query '[FunctionName,PackageType,Timeout,MemorySize,LastUpdateStatus]' --output table
echo 'Private PDF renderer image deployed. No application data was modified.'
