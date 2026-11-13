#!/usr/bin/env bash
# Usage: bash infra/check-part2.sh UUID
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source infra/.resource-ids.env
UPLOAD_ID="${1:-}"
[[ "$UPLOAD_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || {
  echo 'Usage: bash infra/check-part2.sh <upload-uuid>' >&2; exit 2;
}
for i in $(seq 1 120); do
  BODY="$(curl -fsS "${API_URL}/uploads/${UPLOAD_ID}/result")"
  STATUS="$(printf '%s' "$BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])')"
  printf 'Check %s: %s\n' "$i" "$STATUS"
  if [[ "$STATUS" == completed || "$STATUS" == failed ]]; then
    printf '%s' "$BODY" | python3 -m json.tool
    [[ "$STATUS" == completed ]] && exit 0 || exit 1
  fi
  sleep 5
done
echo 'Processing has not finished; check Transcribe and Lambda logs.' >&2
exit 1
