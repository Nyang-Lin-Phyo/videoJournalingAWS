# Reverie — Google account deletion + upload 409 hotfix

This hotfix is based on the repository ZIP provided on November 16, 2026 (snapshot commit `c2f6ce1`). Compare the changes against your current `main` before applying; do not overwrite newer teammate changes without reviewing the diff.

## Why this is needed

1. `auth_signer.py` calls `table.meta.client.transact_write_items(...)`. A DynamoDB **resource** client automatically serializes native Python values, but the signer pre-serialized them with `TypeSerializer`. This resulted in a double-serialized wire request. It also mapped all transaction cancellations to the misleading "Account deletion is in progress" error. The patch passes native Python maps to that resource client and only returns a deletion-specific 409 when a deletion marker is actually present.
2. `auth_results.py` attempted `AdminGetUser(Username=email)`. For a Google-federated Cognito user, email isn't necessarily a username/alias. The patch searches Cognito by the verified JWT `sub`, follows up with `AdminGetUser` for the resulting exact username, and verifies the account's `sub` **and** email before starting deletion. It requires `cognito-idp:ListUsers` on the existing results-Lambda IAM role.

**This deployment does not delete any accounts, journal files or DynamoDB data.** It does not change the frontend, worker, SQS queues, API routes, Gemini, or ElevenLabs.

## 1. Inspect the local state

```bash
cd ~/codeStuff/videoJournalingAWS
source .venv/bin/activate
git status --short
```

Copy `reverie-account-upload-hotfix.zip` into your project root, then extract:

```bash
unzip -o reverie-account-upload-hotfix.zip
git diff -- infra/lambda/auth_signer.py infra/lambda/auth_results.py \
  infra/test-history-v5.py infra/test-account-deletion.py infra/deploy-history-v5.sh
```

If you have newer changes to these files, reconcile them before deploying.

Add this to `.gitignore` if it isn't present:

```
infra/account-upload-hotfix-generated/
```

## 2. Run local checks (no AWS requests)

```bash
python3 -m py_compile infra/lambda/auth_signer.py infra/lambda/auth_results.py
bash -n infra/deploy-account-upload-hotfix.sh
python3 infra/test-account-upload-wire.py
python3 infra/test-history-v5.py
python3 infra/test-account-deletion.py
python3 infra/test-part3-offline.py
python3 infra/test-streaks.py
```

These tests should all pass. `test-account-upload-wire.py` uses a fake AWS response and intercepts boto3's encoded request; it does **not** contact AWS.

## 3. Check your AWS account and possible deletion markers (read-only)

```bash
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
source infra/.phase3-resource-ids.env
source infra/.cognito.env
export AWS_DEFAULT_REGION="$AWS_REGION" AWS_PAGER=""

aws sts get-caller-identity
printf 'JOURNAL_TABLE=%s\n' "$JOURNAL_TABLE"
```

Read-only check of account deletion markers (there may be markers for other accounts):

```bash
aws dynamodb scan \
  --table-name "$JOURNAL_TABLE" \
  --filter-expression 'begins_with(uploadId, :prefix)' \
  --expression-attribute-values '{":prefix":{"S":"account#"}}' \
  --projection-expression 'uploadId,accountStatus' \
  --output json
```

If a marker with `accountStatus=deleting` exists for **your** account and you did not initiate deletion, **stop and investigate that marker**. Do not manually delete any markers or journals.

## 4. Deploy the two Lambda changes

Run only after reviewing the code and confirming account `456157355328`:

```bash
export CONFIRM_ACCOUNT_UPLOAD_HOTFIX=YES
bash infra/deploy-account-upload-hotfix.sh
```

The script:
- checks your account and Lambda handler names;
- checks results Lambda `USER_POOL_ID` matches your expected pool;
- saves deployed ZIP backups to `infra/account-upload-hotfix-generated/`;
- adds `cognito-idp:ListUsers` to the existing scoped IAM inline policy, preserving other actions;
- updates the **signer** and **results** Lambda code and waits for each update.

It does not change either Lambda's environment variables, deploy the frontend, alter AWS infrastructure, or delete any data. Lambda IAM permissions can take time to propagate.

## 5. Verify in AWS and browser

```bash
for name in "$FUNC_NAME" "$RESULT_FUNC"; do
  aws lambda get-function-configuration \
    --function-name "$name" \
    --query '[FunctionName,Handler,LastUpdateStatus]' \
    --output table
done
```

A. Sign in with your existing Google account and try **Save journal** with a short synthetic MP4. The signer should no longer report the misleading 409. Confirm the new entry completes processing as usual.

B. For **account deletion**, use a disposable Google test account containing only fictional test data. The Settings → Delete Account flow is **irreversible**; do not test it on your real account or real recordings. It may require multiple status requests while S3 upload signatures expire and cleanup proceeds.

C. If `POST /uploads` still reports 409, re-check the deletion-marker scan and inspect the signer logs. If it reports 503, inspect logs and the role's DynamoDB permissions rather than changing any data. A separate generic 404 in browser DevTools may be a missing asset; look at its full request URL before diagnosing it as an API problem.

```bash
aws logs tail "/aws/lambda/$FUNC_NAME" --since 15m
aws logs tail "/aws/lambda/$RESULT_FUNC" --since 15m
```

Do not paste journal text or credentials from logs into public issues.

## 6. Commit the fixes

Review `git status` and commit only source/test/script changes (not generated backups or credential files).

```bash
git add infra/lambda/auth_signer.py infra/lambda/auth_results.py \
  infra/test-history-v5.py infra/test-account-deletion.py \
  infra/test-account-upload-wire.py infra/deploy-history-v5.sh \
  infra/deploy-account-upload-hotfix.sh .gitignore

git commit -m "Fix Cognito federated account deletion and upload signer transaction"
git push origin main
```

## Rollback if required

The script saves the *previously deployed* Lambda ZIPs before changing them:

```
infra/account-upload-hotfix-generated/signer-before.zip
infra/account-upload-hotfix-generated/results-before.zip
```

Only if a rollback is necessary, restore a specific Lambda's code using `aws lambda update-function-code --function-name ... --zip-file fileb://...` and wait for the update to complete. This won't reverse a completed account deletion, so **never use production data for deletion testing**. The added ListUsers IAM permission can be retained safely; removing it later requires a deliberate policy review.
