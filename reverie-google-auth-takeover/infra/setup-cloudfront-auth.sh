#!/usr/bin/env bash
# Adds a NEW HTTPS CloudFront distribution/OAC without deleting the existing S3 website.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
export AWS_DEFAULT_REGION="$AWS_REGION" AWS_PAGER=''
: "${SITE_BUCKET:?}" "${AWS_ACCOUNT:?}" "${AWS_REGION:?}"
if [[ -e infra/.auth-hosting.env ]]; then
  echo 'Already provisioned: infra/.auth-hosting.env (reuse it; do not create another distribution).' >&2
  exit 1
fi
GEN=infra/auth-generated
mkdir -p "$GEN"
OAC_NAME="reverie-oac-${AWS_ACCOUNT}-$(python3 -c 'import secrets;print(secrets.token_hex(3))')"
cat > "$GEN/oac.json" <<EOF
{"Name":"$OAC_NAME","Description":"Reverie HTTPS S3 frontend","SigningProtocol":"sigv4","SigningBehavior":"always","OriginAccessControlOriginType":"s3"}
EOF
OAC_ID="$(aws cloudfront create-origin-access-control --origin-access-control-config "file://$GEN/oac.json" --query 'OriginAccessControl.Id' --output text)"
# Record partial resources immediately; a stopped provisioning run should not blindly create duplicates.
cat > infra/.auth-hosting.env <<EOF
export CF_OAC_ID='$OAC_ID'
export CF_DIST_ID=''
export CF_DOMAIN=''
export HTTPS_SITE_ORIGIN=''
EOF
python3 - "$GEN/distribution.json" "$SITE_BUCKET" "$AWS_REGION" "$OAC_ID" <<'PY'
import json,sys,time
path,bucket,region,oac=sys.argv[1:]
origin_id='reverie-s3-'+bucket
obj={
 'CallerReference':f'reverie-{bucket}-{time.time_ns()}',
 'Comment':'Reverie frontend HTTPS (private S3 REST origin)',
 'Enabled':True, 'DefaultRootObject':'index.html',
 'PriceClass':'PriceClass_100',
 'ViewerCertificate':{'CloudFrontDefaultCertificate':True},
 'Origins':{'Quantity':1,'Items':[{'Id':origin_id,'DomainName':f'{bucket}.s3.{region}.amazonaws.com','S3OriginConfig':{'OriginAccessIdentity':''},'OriginAccessControlId':oac}]},
 'DefaultCacheBehavior':{
    'TargetOriginId':origin_id,'ViewerProtocolPolicy':'redirect-to-https',
    'AllowedMethods':{'Quantity':2,'Items':['GET','HEAD'],'CachedMethods':{'Quantity':2,'Items':['GET','HEAD']}},
    'Compress':True,'MinTTL':0,'DefaultTTL':60,'MaxTTL':86400,
    'ForwardedValues':{'QueryString':False,'Cookies':{'Forward':'none'}}},
 'CustomErrorResponses':{'Quantity':2,'Items':[
   {'ErrorCode':403,'ResponsePagePath':'/index.html','ResponseCode':'200','ErrorCachingMinTTL':0},
   {'ErrorCode':404,'ResponsePagePath':'/index.html','ResponseCode':'200','ErrorCachingMinTTL':0}]}
}
with open(path,'w') as f: json.dump(obj,f,indent=2)
PY
aws cloudfront create-distribution --distribution-config "file://$GEN/distribution.json" --output json > "$GEN/distribution-created.json"
read -r CF_DIST_ID CF_DOMAIN CF_ARN < <(python3 - "$GEN/distribution-created.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))['Distribution']; print(d['Id'],d['DomainName'],d['ARN'])
PY
)
cat > infra/.auth-hosting.env <<EOF
export CF_OAC_ID='$OAC_ID'
export CF_DIST_ID='$CF_DIST_ID'
export CF_DOMAIN='$CF_DOMAIN'
export CF_ARN='$CF_ARN'
export HTTPS_SITE_ORIGIN='https://$CF_DOMAIN'
EOF
# Append the CloudFront statement to the existing S3 policy but keep the HTTP demo live until the owner verifies HTTPS.
aws s3api get-bucket-policy --bucket "$SITE_BUCKET" --query Policy --output text > "$GEN/site-bucket-policy-before.json"
python3 - "$GEN/site-bucket-policy-before.json" "$GEN/site-bucket-policy-with-cloudfront.json" "$SITE_BUCKET" "$CF_ARN" <<'PY'
import json,sys
src,dst,bucket,dist_arn=sys.argv[1:]
p=json.load(open(src))
p.setdefault('Statement',[])
p['Statement']=[x for x in p['Statement'] if x.get('Sid')!='AllowReverieCloudFront']
p['Statement'].append({'Sid':'AllowReverieCloudFront','Effect':'Allow','Principal':{'Service':'cloudfront.amazonaws.com'},'Action':'s3:GetObject','Resource':f'arn:aws:s3:::{bucket}/*','Condition':{'StringEquals':{'AWS:SourceArn':dist_arn}}})
json.dump(p,open(dst,'w'),indent=2)
PY
aws s3api put-bucket-policy --bucket "$SITE_BUCKET" --policy "file://$GEN/site-bucket-policy-with-cloudfront.json"
printf '\nCloudFront: https://%s/\nDistribution ID: %s\n' "$CF_DOMAIN" "$CF_DIST_ID"
printf 'Next: aws cloudfront wait distribution-deployed --id %s ; curl -I https://%s/\n' "$CF_DIST_ID" "$CF_DOMAIN"
printf 'The original public S3 website remains accessible until you run lock-site-bucket.sh.\n'
