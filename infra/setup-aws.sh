#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
export AWS_PAGER=""
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
REGION="${REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$REGION"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
SUFFIX="$(python3 -c 'import secrets; print(secrets.token_hex(3))')"
SITE_BUCKET="videojournal-site-${ACCOUNT}-${SUFFIX}"
UPLOAD_BUCKET="videojournal-uploads-${ACCOUNT}-${SUFFIX}"
ROLE_NAME="videojournal-signer-role-${SUFFIX}"
FUNC_NAME="videojournal-upload-signer-${SUFFIX}"
API_NAME="videojournal-ingest-${SUFFIX}"
SITE_URL="http://${SITE_BUCKET}.s3-website-${REGION}.amazonaws.com"

create_bucket() {
  if [[ "$REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$1" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$1" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
}

mkdir -p infra contracts
if [[ -f infra/.resource-ids.env ]]; then
  echo 'infra/.resource-ids.env already exists. Reuse the existing resources instead of rerunning setup.' >&2
  exit 1
fi
# Save the generated names up front, including for recovery after a partial failure.
cat > infra/.resource-ids.env <<EOF
export AWS_REGION='${REGION}'
export AWS_DEFAULT_REGION='${REGION}'
export AWS_ACCOUNT='${ACCOUNT}'
export SITE_BUCKET='${SITE_BUCKET}'
export UPLOAD_BUCKET='${UPLOAD_BUCKET}'
export ROLE_NAME='${ROLE_NAME}'
export FUNC_NAME='${FUNC_NAME}'
export API_ID=''
export API_URL=''
export SITE_URL='${SITE_URL}'
EOF
printf 'Provisioning region %s, account %s\n' "$REGION" "$ACCOUNT"
create_bucket "$SITE_BUCKET"
create_bucket "$UPLOAD_BUCKET"

# Only static website bucket is made publicly readable.
aws s3api put-public-access-block --bucket "$SITE_BUCKET" --public-access-block-configuration \
  'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false'
aws s3api put-bucket-website --bucket "$SITE_BUCKET" \
  --website-configuration '{"IndexDocument":{"Suffix":"index.html"},"ErrorDocument":{"Key":"index.html"}}'
cat > infra/site-read-policy.json <<EOF
{"Version":"2012-10-17","Statement":[{"Sid":"ReadFrontendOnly","Effect":"Allow","Principal":"*","Action":"s3:GetObject","Resource":"arn:aws:s3:::${SITE_BUCKET}/*"}]}
EOF
if ! aws s3api put-bucket-policy --bucket "$SITE_BUCKET" --policy file://infra/site-read-policy.json; then
  echo 'Public website bucket policy was rejected. Account/organization S3 Block Public Access may be enabled.' >&2
  echo 'Do NOT disable account-wide protection. Switch frontend hosting to private S3 + CloudFront OAC.' >&2
  exit 1
fi

aws s3api put-public-access-block --bucket "$UPLOAD_BUCKET" --public-access-block-configuration \
  'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
cat > infra/upload-cors.json <<EOF
{"CORSRules":[{"AllowedOrigins":["${SITE_URL}","http://localhost:5173","http://127.0.0.1:5173"],"AllowedMethods":["POST"],"AllowedHeaders":["*"],"MaxAgeSeconds":3000}]}
EOF
aws s3api put-bucket-cors --bucket "$UPLOAD_BUCKET" --cors-configuration file://infra/upload-cors.json

cat > infra/lambda-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
cat > infra/signer-iam-policy.json <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:PutObject","Resource":"arn:aws:s3:::${UPLOAD_BUCKET}/uploads/*"}]}
EOF
aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document file://infra/lambda-trust.json >/dev/null
aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name AllowUploadObjects \
  --policy-document file://infra/signer-iam-policy.json
ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text)"

python3 - <<'PY'
from zipfile import ZipFile, ZIP_DEFLATED
with ZipFile('infra/upload-signer.zip','w',ZIP_DEFLATED) as z:
    z.write('infra/lambda/upload_signer.py','upload_signer.py')
PY
# IAM can take a few seconds to propagate to Lambda.
sleep 12
FUNC_ARN="$(aws lambda create-function --function-name "$FUNC_NAME" --runtime python3.12 \
  --handler upload_signer.handler --role "$ROLE_ARN" \
  --zip-file fileb://infra/upload-signer.zip --memory-size 128 --timeout 10 \
  --environment "Variables={UPLOAD_BUCKET=$UPLOAD_BUCKET}" \
  --query FunctionArn --output text)"
aws lambda wait function-active-v2 --function-name "$FUNC_NAME"

cat > infra/api-cors.json <<EOF
{"AllowOrigins":["${SITE_URL}","http://localhost:5173","http://127.0.0.1:5173"],"AllowMethods":["POST","OPTIONS"],"AllowHeaders":["content-type"],"MaxAge":300}
EOF
API_ID="$(aws apigatewayv2 create-api --name "$API_NAME" --protocol-type HTTP \
  --cors-configuration file://infra/api-cors.json --query ApiId --output text)"
INTEGRATION_ID="$(aws apigatewayv2 create-integration --api-id "$API_ID" \
  --integration-type AWS_PROXY --integration-uri "$FUNC_ARN" --payload-format-version 2.0 \
  --query IntegrationId --output text)"
aws apigatewayv2 create-route --api-id "$API_ID" --route-key 'POST /uploads' \
  --target "integrations/$INTEGRATION_ID" >/dev/null
aws lambda add-permission --function-name "$FUNC_NAME" --statement-id AllowAPIGateway \
  --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT}:${API_ID}/*/POST/uploads" >/dev/null
aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' --auto-deploy \
  --default-route-settings 'ThrottlingBurstLimit=2,ThrottlingRateLimit=1' >/dev/null
API_URL="https://${API_ID}.execute-api.${REGION}.amazonaws.com"

cat > infra/.resource-ids.env <<EOF
export AWS_REGION='${REGION}'
export AWS_DEFAULT_REGION='${REGION}'
export AWS_ACCOUNT='${ACCOUNT}'
export SITE_BUCKET='${SITE_BUCKET}'
export UPLOAD_BUCKET='${UPLOAD_BUCKET}'
export ROLE_NAME='${ROLE_NAME}'
export FUNC_NAME='${FUNC_NAME}'
export API_ID='${API_ID}'
export API_URL='${API_URL}'
export SITE_URL='${SITE_URL}'
EOF
cat > apps/web/.env.production <<EOF
VITE_CLOUD_INGEST_ONLY=true
VITE_INGEST_API_URL=${API_URL}
EOF
cp apps/web/.env.production apps/web/.env.local
printf '\nSuccess!\nSite: %s\nAPI: %s/uploads\nPrivate uploads bucket: %s\n' \
  "$SITE_URL" "$API_URL" "$UPLOAD_BUCKET"
printf 'AWS resource variables saved to infra/.resource-ids.env\n'
