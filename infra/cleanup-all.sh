#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
printf 'WARNING: This permanently deletes both S3 buckets and ALL uploaded objects.\n'
read -r -p "Type DELETE to continue: " ANSWER
[[ "$ANSWER" == DELETE ]] || { echo 'Cancelled'; exit 1; }
aws apigatewayv2 delete-api --api-id "$API_ID" 2>/dev/null || true
aws lambda delete-function --function-name "$FUNC_NAME"
aws iam detach-role-policy --role-name "$ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name AllowUploadObjects
aws iam delete-role --role-name "$ROLE_NAME"
aws s3 rb "s3://$SITE_BUCKET" --force
aws s3 rb "s3://$UPLOAD_BUCKET" --force
printf 'Demo resources deleted.\n'
