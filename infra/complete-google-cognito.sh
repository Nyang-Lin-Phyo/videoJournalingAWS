#!/usr/bin/env bash
# Register Google as IdP and a public OAuth code-flow app client. Does NOT modify API routes.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
source infra/.auth-hosting.env
source infra/.cognito.env
export AWS_DEFAULT_REGION="$AWS_REGION" AWS_PAGER=''
: "${USER_POOL_ID:?}" "${COGNITO_DOMAIN:?}" "${HTTPS_SITE_ORIGIN:?}"
if [[ -n "${APP_CLIENT_ID:-}" ]]; then echo 'App client already configured; do not create another.' >&2;exit 1;fi
umask 077
read -r -p 'Google OAuth WEB client ID: ' GOOGLE_CLIENT_ID
read -r -s -p 'Google OAuth client secret (hidden): ' GOOGLE_CLIENT_SECRET; printf '\n'
export GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
TMP_GOOGLE_JSON="$(mktemp)"
trap 'rm -f "$TMP_GOOGLE_JSON"' EXIT
python3 - "$TMP_GOOGLE_JSON" <<'PY'
import os,json,sys
with open(sys.argv[1],'w') as f: json.dump({'client_id':os.environ['GOOGLE_CLIENT_ID'],'client_secret':os.environ['GOOGLE_CLIENT_SECRET'],'authorize_scopes':'openid email profile'},f)
PY
unset GOOGLE_CLIENT_SECRET
aws cognito-idp create-identity-provider --user-pool-id "$USER_POOL_ID" --provider-name Google --provider-type Google --provider-details "file://$TMP_GOOGLE_JSON" --attribute-mapping email=email,email_verified=email_verified --query 'IdentityProvider.ProviderName' --output text
rm -f "$TMP_GOOGLE_JSON"; trap - EXIT
unset GOOGLE_CLIENT_ID
APP_CLIENT_ID="$(aws cognito-idp create-user-pool-client --user-pool-id "$USER_POOL_ID" --client-name reverie-react --no-generate-secret --allowed-o-auth-flows-user-pool-client --allowed-o-auth-flows code --allowed-o-auth-scopes openid email profile --supported-identity-providers Google --callback-urls "$HTTPS_SITE_ORIGIN/" 'http://localhost:5173/' --logout-urls "$HTTPS_SITE_ORIGIN/" 'http://localhost:5173/' --query 'UserPoolClient.ClientId' --output text)"
# Save first; even if branding step fails, client is not duplicated by retrying blindly.
cat > infra/.cognito.env <<EOF
export USER_POOL_ID='$USER_POOL_ID'
export COGNITO_PREFIX='$COGNITO_PREFIX'
export COGNITO_DOMAIN='$COGNITO_DOMAIN'
export APP_CLIENT_ID='$APP_CLIENT_ID'
EOF
aws cognito-idp create-managed-login-branding --user-pool-id "$USER_POOL_ID" --client-id "$APP_CLIENT_ID" --use-cognito-provided-values >/dev/null
printf '\nCognito public client: %s\nCognito domain: %s\n' "$APP_CLIENT_ID" "$COGNITO_DOMAIN"
printf 'Next: populate apps/web/.env.local and test login at localhost:5173 (Phase C NOT yet activated).\n'
