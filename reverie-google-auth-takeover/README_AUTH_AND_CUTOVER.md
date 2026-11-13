# Reverie: Google OAuth + Cognito + Phase C — CLI-first takeover

This kit is an **addition to the existing working Part 2 and provisioned Part 3**. It is not a fresh deployment. It assumes:

- Project root is `/home/ramsey/codeStuff/videoJournalingAWS` on WSL.
- `infra/.resource-ids.env`, `infra/.part2-resource-ids.env`, and `infra/.phase3-resource-ids.env` exist locally.
- Live S3 website uses the original site bucket; upload service is API Gateway HTTP API with `POST /uploads` and `GET /uploads/{upload_id}/result`.
- The Part 3 kit (`infra/cutover-part3.sh`, authenticated signer/results, SQS worker) was extracted and Phase A provisioning completed.
- This kit reuses **the same `SITE_BUCKET`, `UPLOAD_BUCKET`, `API_ID`, and backend Lambdas**. It creates a new HTTPS CloudFront distribution and Cognito pool, with no automatic backend cutover.

**Privacy warning:** Until Phase C is complete and both account-isolation tests pass, only use fictional/synthetic videos. The old HTTP site and anonymous API are not private. Creating AWS resources can incur charges. Never commit `.env.*`, auth config files, tokens, service-account credentials or Google client secret.

## A. Setup and project backup

```bash
cd ~/codeStuff/videoJournalingAWS
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
source infra/.phase3-resource-ids.env
aws sts get-caller-identity

git status --short
# Choose whether to commit or stash any preexisting changes BEFORE overwriting local frontend files.
```

Extract this kit (do not extract into a project with uncommitted edits to the five frontend files without reviewing):

```bash
unzip -o reverie-google-auth-takeover.zip
cat .gitignore.append >> .gitignore
rm .gitignore.append
for script in infra/setup-cloudfront-auth.sh infra/lock-site-bucket.sh infra/setup-cognito-pool.sh infra/complete-google-cognito.sh; do bash -n "$script" || exit 1; done
```

The overlay replaces only `apps/web/src/App.tsx` and the existing cloud ingestion page/client files, and adds `CloudAuthApp.tsx`. These changes implement Cognito login and required bearer headers. The local FastAPI app is not changed. Inspect `git diff` before committing.

## B. Create HTTPS CloudFront site before touching Cognito

S3's `s3-website` endpoint is **HTTP-only**. Cognito Google OAuth production redirects require **HTTPS**. CloudFront's OAC must use the **S3 REST origin**, *not* the S3 website endpoint.

```bash
source infra/.resource-ids.env
bash infra/setup-cloudfront-auth.sh
source infra/.auth-hosting.env

# Distribution creation can take time; this waits for AWS to report deployment.
aws cloudfront wait distribution-deployed --id "$CF_DIST_ID"
echo "$HTTPS_SITE_ORIGIN"
curl -I "$HTTPS_SITE_ORIGIN/"
```

Expected: HTTP `200` via an HTTPS CloudFront domain, with existing frontend assets. The script adds CloudFront read permission to the site bucket while retaining the old public S3 policy temporarily. **It does not touch your private video bucket.** Do not rerun if `infra/.auth-hosting.env` exists: check its contents and recover rather than creating a second distribution.

**Before handling any real private recordings**, make the site bucket private (after confirming CloudFront works):

```bash
bash infra/lock-site-bucket.sh
aws s3api get-public-access-block --bucket "$SITE_BUCKET"
curl -I "$HTTPS_SITE_ORIGIN/"
# Old S3 website URL should now return AccessDenied/403.
```

## C. Create Cognito User Pool and domain

AWS Cognito is independent of the Google Cloud OAuth client. Check Cognito pricing for your account; the provided pool uses the **Essentials** tier for managed login.

```bash
source infra/.resource-ids.env
source infra/.auth-hosting.env
bash infra/setup-cognito-pool.sh
source infra/.cognito.env
printf 'Cognito callback for Google: %s/oauth2/idpresponse\n' "$COGNITO_DOMAIN"
```

The script creates a pool and managed-login domain. It saves identifiers in `infra/.cognito.env` but no secrets. Do not recreate if the saved file exists.

## D. Create Google OAuth credentials (the one required manual web-console step)

Open [Google Auth Platform](https://console.cloud.google.com/auth/overview) in a browser:

1. Create/select one Google Cloud project.
2. Under **Branding**, set app name, support email and developer contact email.
3. Under **Audience**, choose **External** (if appropriate). In Testing mode, add your Google email and any test accounts under Test users. Only request basic scopes `openid email profile`.
4. Under **Clients**, click **Create client → Web application**.
5. Set **Authorized redirect URI** exactly to `https://<your-cognito-prefix>.auth.us-east-1.amazoncognito.com/oauth2/idpresponse` (print from `$COGNITO_DOMAIN`). The Google redirect URI is **not CloudFront**.
6. You can set **Authorized JavaScript origins** to `https://<your-cognito-prefix>.auth.us-east-1.amazoncognito.com` if the Google console requires an origin; Google communicates with Cognito, not directly with the React app.
7. Copy **Google Client ID** and **Client secret**. Do not paste the secret into `.env`, your frontend, the repo, or chat.

## E. Connect Google to Cognito and create the public browser client

```bash
source infra/.resource-ids.env
source infra/.auth-hosting.env
source infra/.cognito.env
bash infra/complete-google-cognito.sh
source infra/.cognito.env

aws cognito-idp describe-user-pool-client \
  --user-pool-id "$USER_POOL_ID" --client-id "$APP_CLIENT_ID" \
  --query 'UserPoolClient.[ClientId,GenerateSecret,AllowedOAuthFlows,CallbackURLs,SupportedIdentityProviders]' \
  --output json
```

Expected: an app client **without a client secret**, `code` OAuth flow, Google provider, and callbacks `https://<cloudfront>/` and `http://localhost:5173/`. The OAuth flow uses PKCE handled by the OIDC frontend library. The Google secret resides in Cognito's identity-provider configuration only, not in React.

## F. React frontend integration and local login test

The overlay includes:

- `CloudAuthApp.tsx`: Cognito OIDC provider, Google login button, sign-out button, loading/error states.
- `App.tsx`: cloud mode now renders the auth wrapper.
- `uploadToS3.ts`: adds the Cognito **access token** only to `POST /uploads` (not to direct S3 FormData POST).
- `analysisApi.ts`: adds bearer header to results lookup and implements `GET /journals`.
- `CloudIngestPage.tsx`: history list, auth-aware calls, per-user last-upload localStorage key.

Install client libraries:

```bash
cd apps/web
npm install react-oidc-context oidc-client-ts
cd ../..
```

Write dev/build environment (the IDs are public client configuration; these are **not** API keys):

```bash
source infra/.resource-ids.env
source infra/.auth-hosting.env
source infra/.cognito.env
for file in apps/web/.env.local apps/web/.env.production; do
  cat > "$file" <<EOF
VITE_CLOUD_INGEST_ONLY=true
VITE_INGEST_API_URL=$API_URL
VITE_COGNITO_REGION=$AWS_REGION
VITE_COGNITO_USER_POOL_ID=$USER_POOL_ID
VITE_COGNITO_CLIENT_ID=$APP_CLIENT_ID
VITE_COGNITO_DOMAIN=$COGNITO_DOMAIN
EOF
done
npm --prefix apps/web run build
```

Test Google login locally before enabling v3 backend routes:

```bash
cd apps/web
npm run dev
```

Visit `http://localhost:5173/`, click **Continue with Google**, sign in, and confirm the app returns to localhost showing your email. Test sign out and page refresh. **Do not test private uploads yet**: the live signing Lambda is still anonymous until Phase C, and this UI will send tokens to that old route without gaining owner protection.

If Google shows `redirect_uri_mismatch`, check the exact `COGNITO_DOMAIN/oauth2/idpresponse` registered as the authorized Google OAuth callback. If Cognito shows `invalid_redirect_uri`, compare CloudFront/localhost callback URLs on the Cognito *app client*. `UserPool.Id`, domain, and client ID must all belong to the same Cognito pool.

## G. Create API Gateway JWT authorizer WITHOUT enabling it

From the repo root:

```bash
source infra/.resource-ids.env
source infra/.auth-hosting.env
source infra/.cognito.env
ISSUER="https://cognito-idp.${AWS_REGION}.amazonaws.com/${USER_POOL_ID}"
AUTHORIZER_ID="$(aws apigatewayv2 create-authorizer \
  --api-id "$API_ID" \
  --name reverie-cognito-jwt \
  --authorizer-type JWT \
  --identity-source '$request.header.Authorization' \
  --jwt-configuration "Audience=${APP_CLIENT_ID},Issuer=${ISSUER}" \
  --query 'AuthorizerId' --output text)"
cat > infra/.auth-api.env <<EOF
export AUTHORIZER_ID='$AUTHORIZER_ID'
EOF
aws apigatewayv2 get-authorizer --api-id "$API_ID" --authorizer-id "$AUTHORIZER_ID" --output json
aws apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].[RouteKey,AuthorizationType]' --output table
```

At this point `POST /uploads` still uses the old route. **Do not individually enable JWT on the live route yet.** The `infra/cutover-part3.sh` script does that in conjunction with new Lambda code, DynamoDB writes, and SQS processing. Lambda also checks the verified Cognito `token_use=access` and `sub` claims, so Google ID tokens are not accepted as backend owner proof. Test token access with your browser's Network tab, but never paste tokens into a chat or logs.

## H. Phase C review BEFORE running the live cutover

Verify: Cognito login returns a Cognito **access** token; CloudFront HTTPS works; Table/GSI ACTIVE; SQS/DLQ configured; `infra/test-part3-offline.py` passes; existing Part 2 upload pipeline still works with synthetic data.

**Important: Inspect your worker's Gemini model first.** The old `cutover-part3.sh` sets `GEMINI_MODEL=gemini-3.5-flash-lite`. If your working Part 2 Lambda uses a different model, update the cutover's `GEMINI_MODEL` value to the actual model you have tested. Do not switch models incidentally during infrastructure migration. You can inspect the old worker's env without exposing any secret values:

```bash
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
aws lambda get-function-configuration --function-name "$START_FUNC" \
  --query 'Environment.Variables.[GEMINI_MODEL,ELEVENLABS_MODEL]' --output json
```

Make a backup of your deployed Lambda code/config and S3 bucket notification before cutover. Confirm the Lambdas are allowed to read the correct Secrets Manager secret ARNs.

## I. Phase C — deploy authenticated DynamoDB + SQS backend in coordinated cutover

```bash
cd ~/codeStuff/videoJournalingAWS
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
source infra/.phase3-resource-ids.env
source infra/.auth-hosting.env
source infra/.cognito.env
source infra/.auth-api.env

# Validate environment and contract.
aws dynamodb describe-table --table-name "$JOURNAL_TABLE" --query 'Table.TableStatus' --output text
aws sqs get-queue-attributes --queue-url "$JOB_QUEUE_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text
python3 infra/test-part3-offline.py

export CONFIRM_CUTOVER=YES
bash infra/cutover-part3.sh
```

The script modifies live AWS: (1) IAM permissions; (2) S3 MP4 event destination **from direct Lambda to SQS**; (3) Lambda code; (4) Lambda handlers and env; (5) authenticated routes including `GET /journals`; (6) CORS and SQS event mapping; (7) verifies state. Do not rerun blindly if any step fails; inspect `infra/phase3-generated/` and the specific AWS resource statuses.

Verify:

```bash
aws apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].[RouteKey,AuthorizationType]' --output table
aws lambda list-event-source-mappings --function-name "$START_FUNC" --event-source-arn "$JOB_QUEUE_ARN" --output table
aws s3api get-bucket-notification-configuration --bucket "$UPLOAD_BUCKET" --output json
curl -i "$API_URL/journals"  # Expected HTTP 401 without a token
```

## J. Publish the authenticated React site and invalidate CloudFront

```bash
bash infra/deploy-web.sh
aws cloudfront create-invalidation --distribution-id "$CF_DIST_ID" --paths '/*'
echo "$HTTPS_SITE_ORIGIN/"
```

`infra/deploy-web.sh` may still print the **old HTTP** website endpoint from Part 1; use `$HTTPS_SITE_ORIGIN/` instead. The CloudFront distribution serves the same S3 `SITE_BUCKET` uploaded by that script.

**Only after confirming the HTTPS site works** make the old S3 website private if you haven't already:

```bash
bash infra/lock-site-bucket.sh
```

## K. Test end-to-end with two Google accounts (fictional MP4s ONLY)

1. Open HTTPS website in a fresh browser session; login as Google Account A.
2. Upload a fictional 5-second MP4 with speech; status flows `awaiting_upload` → `queued/transcribing` → `analyzing` → `completed`. S3 should store it under `uploads/<Cognito-sub-A>/<uuid>.mp4`.
3. Verify `GET /journals` shows the row after processing; after refresh, click it to display saved analysis. Refresh or GET results should **not** re-invoke ElevenLabs/Gemini.
4. Sign out (the app redirects via Cognito), sign in as Google Account B in another browser profile or incognito window, and confirm B sees no A history.
5. Try `GET /uploads/<A-id>/result` with B's valid access token through the browser console/Network tab: it **must** return HTTP 404; B's list does not show A's data. Test missing/invalid token → HTTP 401.
6. Confirm the S3 trigger targets **SQS**, and the worker is connected with an event source mapping. Confirm private video bucket Block Public Access remains all `true`.
7. Check DLQ depth and worker logs; failed jobs should be retried or reach the DLQ rather than disappear silently.

Useful CLI checks:

```bash
aws logs tail "/aws/lambda/$START_FUNC" --since 30m
aws sqs get-queue-attributes --queue-url "$JOB_DLQ_URL" --attribute-names ApproximateNumberOfMessages --output json
aws sqs get-queue-attributes --queue-url "$JOB_QUEUE_URL" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible --output json
aws dynamodb scan --table-name "$JOURNAL_TABLE" --select COUNT --output json
```

`dynamodb scan --select COUNT` is only for a trusted admin sanity check, **never** for a user-facing history route. The Lambda `GET /journals` should query the per-user GSI.

## L. Git hygiene

```bash
git status --short
git diff --stat
git diff -- apps/web/src
# Ensure sensitive files aren't staged.
git add apps/web/src apps/web/package.json apps/web/package-lock.json infra/*.sh contracts/reverie-api-v3.openapi.yaml README_AUTH_AND_CUTOVER.md .gitignore
git diff --cached --name-only
# Commit only after verifying no credentials or private videos are staged.
```

**Notes:** This kit was syntax-checked offline. It has not been deployed to your AWS account and no live OAuth flow was tested. The CloudFront/Cognito scripts are first-time provisioning helpers and intentionally refuse to create duplicates when their state files already exist. `npm run build` must be run on your WSL machine after installing the OIDC libraries; TypeScript syntax checks are not equivalent to a full production build.
