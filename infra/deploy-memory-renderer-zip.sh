#!/usr/bin/env bash
# ZIP + Lambda layer via AWS CodeBuild; does not require Docker or ECR.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
if [[ "${1:-}" == --prepare ]]; then
  exec python3 infra/deploy-memory-renderer-zip.py --prepare
fi
set -a
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
source infra/.phase3-resource-ids.env
[[ -f infra/.auth-api.env ]] && source infra/.auth-api.env
[[ -f infra/.auth-hosting.env ]] && source infra/.auth-hosting.env
set +a
export AWS_DEFAULT_REGION="${AWS_REGION:-us-east-1}" AWS_PAGER=""
exec python3 infra/deploy-memory-renderer-zip.py "$@"
