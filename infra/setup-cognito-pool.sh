#!/usr/bin/env bash
# Create a pool + managed-login domain only; configure Google provider after the Google Cloud step.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
source infra/.auth-hosting.env
export AWS_DEFAULT_REGION="$AWS_REGION" AWS_PAGER=''
: "${HTTPS_SITE_ORIGIN:?}" "${AWS_ACCOUNT:?}"
if [[ -e infra/.cognito.env ]]; then echo 'Cognito setup already started. Reuse infra/.cognito.env instead of creating another pool.' >&2;exit 1;fi
USER_POOL_ID="$(aws cognito-idp create-user-pool --pool-name reverie-users --user-pool-tier ESSENTIALS --username-attributes email --auto-verified-attributes email --query 'UserPool.Id' --output text)"
COGNITO_PREFIX="reverie-${AWS_ACCOUNT}-$(python3 -c 'import secrets;print(secrets.token_hex(3))')"
cat > infra/.cognito.env <<EOF
export USER_POOL_ID='$USER_POOL_ID'
export COGNITO_PREFIX='$COGNITO_PREFIX'
export COGNITO_DOMAIN='https://${COGNITO_PREFIX}.auth.${AWS_REGION}.amazoncognito.com'
export APP_CLIENT_ID=''
EOF
aws cognito-idp create-user-pool-domain --user-pool-id "$USER_POOL_ID" --domain "$COGNITO_PREFIX" --managed-login-version 2 >/dev/null
printf '\nCognito pool: %s\n' "$USER_POOL_ID"
printf 'Google Authorized redirect URI: https://%s.auth.%s.amazoncognito.com/oauth2/idpresponse\n' "$COGNITO_PREFIX" "$AWS_REGION"
printf 'NEXT: create Google OAuth Web application in Google Cloud Console, then run complete-google-cognito.sh.\n'
