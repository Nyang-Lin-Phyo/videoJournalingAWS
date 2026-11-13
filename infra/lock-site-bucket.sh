#!/usr/bin/env bash
# Run only after HTTPS CloudFront works, before real private journal uploads.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
source infra/.auth-hosting.env
export AWS_DEFAULT_REGION="$AWS_REGION" AWS_PAGER=''
: "${SITE_BUCKET:?}" "${CF_ARN:?}" "${HTTPS_SITE_ORIGIN:?}"
curl --fail --silent --show-error --head "$HTTPS_SITE_ORIGIN/" >/dev/null || { echo 'CloudFront HTTPS check failed; no changes made.' >&2;exit 1; }
GEN=infra/auth-generated
mkdir -p "$GEN"
aws s3api get-bucket-policy --bucket "$SITE_BUCKET" --query Policy --output text > "$GEN/site-bucket-policy-before-lock.json"
python3 - "$GEN/site-bucket-policy-private.json" "$SITE_BUCKET" "$CF_ARN" <<'PY'
import json,sys
path,bucket,dist_arn=sys.argv[1:]
policy={'Version':'2012-10-17','Statement':[{'Sid':'AllowReverieCloudFront','Effect':'Allow','Principal':{'Service':'cloudfront.amazonaws.com'},'Action':'s3:GetObject','Resource':f'arn:aws:s3:::{bucket}/*','Condition':{'StringEquals':{'AWS:SourceArn':dist_arn}}}]}
json.dump(policy,open(path,'w'),indent=2)
PY
aws s3api put-bucket-policy --bucket "$SITE_BUCKET" --policy "file://$GEN/site-bucket-policy-private.json"
aws s3api put-public-access-block --bucket "$SITE_BUCKET" --public-access-block-configuration 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
printf 'S3 site bucket is now private. Public S3 website endpoint should no longer serve assets. HTTPS CloudFront remains.\n'
