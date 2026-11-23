#!/usr/bin/env bash
# Deploys only the signer/results Lambda code and Cognito ListUsers permission.
# DOES NOT run provisioning, delete accounts, or change queues/API routes.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
source infra/.phase3-resource-ids.env
source infra/.cognito.env
export AWS_DEFAULT_REGION="${AWS_REGION:-us-east-1}" AWS_PAGER=""
: "${AWS_ACCOUNT:?}" "${AWS_REGION:?}" "${FUNC_NAME:?}" "${RESULT_FUNC:?}" \
  "${RESULT_ROLE:?}" "${JOURNAL_TABLE:?}" "${USER_POOL_ID:?}"
[[ "${CONFIRM_ACCOUNT_UPLOAD_HOTFIX:-}" == 'YES' ]] || {
  echo 'Run with CONFIRM_ACCOUNT_UPLOAD_HOTFIX=YES after reviewing.' >&2
  exit 1
}
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$AWS_ACCOUNT" ]] || {
  echo 'Wrong AWS account, exiting.' >&2
  exit 1
}
for pair in "$FUNC_NAME:auth_signer.handler" "$RESULT_FUNC:auth_results.handler"; do
  name="${pair%%:*}"; expected="${pair#*:}"
  actual="$(aws lambda get-function-configuration --function-name "$name" --query Handler --output text)"
  [[ "$actual" == "$expected" ]] || { echo "Unexpected handler for $name: $actual" >&2; exit 1; }
done
actual_pool="$(aws lambda get-function-configuration --function-name "$RESULT_FUNC" --query 'Environment.Variables.USER_POOL_ID' --output text)"
[[ "$actual_pool" == "$USER_POOL_ID" ]] || {
  echo 'Results Lambda Cognito User Pool mismatch. Do not deploy before investigating.' >&2
  exit 1
}

GEN='infra/account-upload-hotfix-generated'
mkdir -p "$GEN"
printf '[1/4] Back up the currently deployed signer and results Lambda ZIPs\n'
for pair in "$FUNC_NAME:signer" "$RESULT_FUNC:results"; do
  name="${pair%%:*}"; part="${pair##*:}"
  url="$(aws lambda get-function --function-name "$name" --query Code.Location --output text)"
  curl -fsSL "$url" -o "$GEN/${part}-before.zip"
done

printf '[2/4] Add ListUsers to the EXISTING scoped results IAM policy\n'
aws iam get-role-policy --role-name "$RESULT_ROLE" \
  --policy-name 'ReverieV5ManageOwnedJournals' \
  --query PolicyDocument --output json > "$GEN/results-policy-before.json"
python3 - "$GEN/results-policy-before.json" "$GEN/results-policy-after.json" "$AWS_ACCOUNT" "$AWS_REGION" "$USER_POOL_ID" <<'PY'
import json, sys
before, after, account, region, pool = sys.argv[1:]
policy = json.load(open(before))
arn = f'arn:aws:cognito-idp:{region}:{account}:userpool/{pool}'
updated = False
for statement in policy.get('Statement', []):
    actions = statement.get('Action', [])
    actions = [actions] if isinstance(actions, str) else actions
    resources = statement.get('Resource', [])
    resources = [resources] if isinstance(resources, str) else resources
    if (statement.get('Effect') == 'Allow'
            and 'cognito-idp:AdminDeleteUser' in actions
            and arn in resources):
        statement['Action'] = sorted(set(actions) | {'cognito-idp:ListUsers'})
        updated = True
if not updated:
    raise SystemExit('Expected scoped account-deletion IAM policy not found; refusing to overwrite it')
with open(after, 'w') as output:
    json.dump(policy, output, indent=2)
PY
aws iam put-role-policy --role-name "$RESULT_ROLE" \
  --policy-name 'ReverieV5ManageOwnedJournals' \
  --policy-document "file://$GEN/results-policy-after.json"

printf '[3/4] Package the two patched Python functions\n'
python3 - "$GEN" <<'PY'
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import sys
out = Path(sys.argv[1])
for label, module in [('signer', 'auth_signer.py'), ('results', 'auth_results.py')]:
    with ZipFile(out / f'{label}.zip', 'w', ZIP_DEFLATED) as archive:
        archive.write(Path('infra/lambda') / module, module)
        if label == 'results':
            archive.write(Path('infra/lambda/journal_pages.py'), 'journal_pages.py')
PY

printf '[4/4] Update Lambda code without touching environment, routes, SQS or S3\n'
for pair in "$FUNC_NAME:signer" "$RESULT_FUNC:results"; do
  name="${pair%%:*}"; part="${pair##*:}"
  aws lambda update-function-code --function-name "$name" \
    --zip-file "fileb://$GEN/${part}.zip" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$name"
  aws lambda get-function-configuration --function-name "$name" \
    --query '[FunctionName,Handler,LastUpdateStatus]' --output table
done
printf '\nHotfix deployed. No user data was modified by this deployment.\n'
