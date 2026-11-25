#!/usr/bin/env bash
# Deploy MP4+WebM support to existing signer, worker and results Lambdas.
# NO Docker, EC2, new queues, deleting objects, or DynamoDB data writes.
# Does NOT deploy the website. Run the frontend separately after backend succeeds.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
source infra/.phase3-resource-ids.env
export AWS_DEFAULT_REGION="${AWS_REGION:-us-east-1}" AWS_PAGER=""
: "${AWS_ACCOUNT:?}" "${UPLOAD_BUCKET:?}" "${JOB_QUEUE_ARN:?}" "${FUNC_NAME:?}" "${RESULT_FUNC:?}" "${START_FUNC:?}"
[[ "${CONFIRM_BROWSER_RECORDER:-}" == YES ]] || {
  echo 'To deploy: CONFIRM_BROWSER_RECORDER=YES bash infra/deploy-browser-recorder.sh' >&2
  exit 1
}
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$AWS_ACCOUNT" ]] || {
  echo 'Wrong AWS account; refusing to deploy.' >&2; exit 1;
}
for entry in "$FUNC_NAME:auth_signer.handler" "$RESULT_FUNC:auth_results.handler" "$START_FUNC:queue_worker.handler"; do
  function_name="${entry%%:*}"
  expected="${entry#*:}"
  actual="$(aws lambda get-function-configuration --function-name "$function_name" --query Handler --output text)"
  [[ "$actual" == "$expected" ]] || { echo "Unexpected handler: $function_name -> $actual" >&2; exit 1; }
done
aws s3api get-bucket-location --bucket "$UPLOAD_BUCKET" >/dev/null

TMP="$(mktemp -d)"
finished=no
cleanup() {
  if [[ "$finished" == yes ]]; then
    rm -rf -- "$TMP"
  else
    echo "Deployment stopped. Temporary previous Lambda ZIPs and notification config retained at: $TMP" >&2
    echo 'No automated rollback was attempted. Review the error before retrying.' >&2
  fi
}
trap cleanup EXIT

echo '[1/5] Snapshot current notification configuration and plan non-overlapping WebM rule'
aws s3api get-bucket-notification-configuration --bucket "$UPLOAD_BUCKET" --output json > "$TMP/s3-before.json"
python3 infra/recording_notification_config.py "$TMP/s3-before.json" "$TMP/s3-after.json" "$JOB_QUEUE_ARN"

echo '[2/5] Download current Lambda ZIPs (local temporary backups)'
for entry in "$FUNC_NAME:signer" "$RESULT_FUNC:results" "$START_FUNC:worker"; do
  function_name="${entry%%:*}"; kind="${entry#*:}"
  curl --fail --location --silent --show-error "$(aws lambda get-function --function-name "$function_name" --query Code.Location --output text)" > "$TMP/$kind-before.zip"
done

echo '[3/5] Verify current deployed source matches this upload, preserving all other ZIP files'
python3 - "$TMP" <<'PY'
import hashlib,json,sys,zipfile
from pathlib import Path
out=Path(sys.argv[1]); base=Path('infra/lambda'); baseline=json.loads(Path('infra/browser-recorder-baseline.json').read_text())
normalized_baseline={'auth_signer.py': 'e56e102e10429875271911745ed4fa4480c2da987ca6c1a891924b68762302cc', 'queue_worker.py': 'f6230d8b2526e9c3564736fdbd43ededec6c8bc93a4f6c56a081404ecbcb4b85', 'legacy_elevenlabs_provider.py': 'c564b452a1747d8aa83bfa6a72ef3c37f2013a35ac15c2603041b25890a232ff', 'auth_results.py': '8c5f0608b4e33d7ed87cbbf931d270d0978251025c8b1b8273e9b4412178ca0a'}
parts={'signer':('auth_signer.py',), 'worker':('queue_worker.py','legacy_elevenlabs_provider.py'), 'results':('auth_results.py',)}
for kind, names in parts.items():
    source_zip=out/f'{kind}-before.zip'; target_zip=out/f'{kind}-new.zip'
    with zipfile.ZipFile(source_zip) as existing:
        old_names=existing.namelist()
        if len(old_names)!=len(set(old_names)):
            raise SystemExit('Duplicate ZIP members in deployed '+kind+'; refusing to patch')
        for name in names:
            if name not in old_names:
                raise SystemExit(f'Current {kind} Lambda lacks {name}; refusing to overwrite')
            raw=existing.read(name)
            digest=hashlib.sha256(raw).hexdigest()
            normalized_digest=hashlib.sha256(raw.replace(b'\r\n', b'\n')).hexdigest()
            if digest!=baseline[name] and normalized_digest!=normalized_baseline[name]:
                raise SystemExit(f'Deployed {kind}/{name} differs from uploaded source. Stop and reconcile newer live changes before deployment.')
        with zipfile.ZipFile(target_zip,'w',zipfile.ZIP_DEFLATED) as updated:
            for member in existing.infolist():
                if member.filename not in names:
                    updated.writestr(member,existing.read(member.filename))
            for name in names:
                updated.write(base/name,name)
    print(kind+': source verified, other files preserved')
PY

python3 -m py_compile infra/lambda/{auth_signer,auth_results,queue_worker,legacy_elevenlabs_provider}.py

echo '[4/5] Update existing Lambda code only (no runtime/env/IAM changes)'
for entry in "$FUNC_NAME:signer" "$RESULT_FUNC:results" "$START_FUNC:worker"; do
  function_name="${entry%%:*}"; kind="${entry#*:}"
  aws lambda update-function-code --function-name "$function_name" --zip-file "fileb://$TMP/$kind-new.zip" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$function_name"
  echo "Updated $function_name"
done

echo '[5/5] Add WebM events to existing SQS processing without replacing MP4 events'
aws s3api put-bucket-notification-configuration \
  --bucket "$UPLOAD_BUCKET" --notification-configuration "file://$TMP/s3-after.json"
finished=yes
echo 'SUCCESS: existing Lambda and SQS pipeline now accept MP4 + WebM. No frontend deployed yet.'
