# Reverie Memory Books — Docker-free renderer deployment

This is a **small overlay**, not a repository replacement. It adds an AWS CodeBuild
packager that produces two regular ZIP archives:

1. `renderer.zip` — existing `memory_export_worker.py`, `journal_pages.py`,
   `memory-book-templates.json`.
2. `layer.zip` — Python 3.12 packages (WeasyPrint 70, boto3 1.42, Pillow) and
   required Amazon Linux 2023 native shared libraries and DejaVu fonts.

CodeBuild runs the native dependency setup and sample PDF render *inside an AWS
managed Linux build environment*. **No local Docker, Docker CLI, Docker Desktop,
ECR repository or image-based Lambda is used.** CodeBuild itself uses managed
container infrastructure internally; this is not a claim that AWS never uses
containers.

## What is untouched

Existing journal DynamoDB items, S3 uploads, private photos, journal streaks,
CloudFront frontend, Cognito, and the existing results Lambda are never changed
by this renderer deployment script. The new renderer uses the already-created
`reverie-memory-renderer-role-<account>` IAM role. It deploys only the renderer
function, its dependency layer, a CodeBuild role/project, and temporary S3
objects under `infra-builds/memory-renderer/...` in your existing private bucket.
Temporary build objects are removed after **successful** deployment (including
versioned objects); failed builds retain their S3 artifacts for debugging.
The CodeBuild project and IAM role remain for future renderer updates and
incur no idle compute charges.

## 1. Preflight, no AWS changes

From `~/codeStuff/videoJournalingAWS` in WSL, after extracting this ZIP:

```bash
bash -n infra/deploy-memory-renderer-zip.sh
python3 infra/test-memory-renderer-zip-deploy.py
bash infra/deploy-memory-renderer-zip.sh --prepare
npm --prefix apps/web run build
```

The last command is important: your previously shared log showed one unused
`index` in `apps/web/tests/memoryBooks.test.tsx` on line ~293. If it still
fails, change `rows().forEach((row, index) => {` to
`rows().forEach(row => {`, then re-run the build.

## 2. Confirm AWS session and deploy only the PDF renderer

```bash
aws sts get-caller-identity
CONFIRM_MEMORY_RENDERER_ZIP=YES \
  bash infra/deploy-memory-renderer-zip.sh --deploy
```

The script sources the project's original resource-ID environment files and
checks the actual AWS account before making changes. It checks the Lambda
role, uploads the source archive to the existing private S3 bucket, builds with
CodeBuild, verifies a sample PDF, publishes the layer, then creates/updates
the ZIP Lambda. **Stop if it reports a CodeBuild or Lambda error.** Do not run
the previous `deploy-memory-renderer.sh`: that script requires Docker/ECR.

If CodeBuild fails, check `/aws/codebuild/reverie-memory-renderer-build-<account>`
in CloudWatch. The script reports the build's logs URL when available.

## 3. Verify renderer function before backend updates

```bash
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
source infra/.phase3-resource-ids.env
export AWS_DEFAULT_REGION="$AWS_REGION" AWS_PAGER=""
export MEMORY_RENDERER_NAME="reverie-memory-renderer-${AWS_ACCOUNT}"

aws lambda get-function-configuration \
  --function-name "$MEMORY_RENDERER_NAME" \
  --query '[FunctionName,PackageType,Runtime,Handler,State,LastUpdateStatus,Layers[0].Arn]' \
  --output json
```

Expected `PackageType`: `Zip`; `Runtime`: `python3.12`; `Handler`:
`memory_export_worker.handler`; state `Active`, update `Successful`, and
one attached layer ARN. **A live PDF with your own app is still the final
runtime smoke test after the backend has been deployed.**

## 4. Deploy Memory Books backend and site (only after verifying ZIP renderer)

The existing `infra/deploy-memory-book-v1.sh` is compatible with **either** an
image-based or a ZIP-based renderer; it only needs the function ARN.

```bash
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
source infra/.phase3-resource-ids.env
[[ -f infra/.auth-api.env ]] && source infra/.auth-api.env
[[ -f infra/.auth-hosting.env ]] && source infra/.auth-hosting.env
export AWS_DEFAULT_REGION="$AWS_REGION" AWS_PAGER=""
export MEMORY_RENDERER_NAME="reverie-memory-renderer-${AWS_ACCOUNT}"
export MEMORY_RENDERER_ARN="$(aws lambda get-function --function-name "$MEMORY_RENDERER_NAME" --query Configuration.FunctionArn --output text)"
# The backend script additionally requires GEMINI_SECRET_ARN to be exported.
# If it isn't already present, retrieve the ARN (not the secret value):
if [[ -z "${GEMINI_SECRET_ARN:-}" ]]; then
  export GEMINI_SECRET_ARN="$(aws secretsmanager describe-secret --secret-id "videojournal/gemini/${AWS_ACCOUNT}" --query ARN --output text)"
fi

CONFIRM_MEMORY_BOOKS_V1=YES bash infra/deploy-memory-book-v1.sh
```

Then inspect all JWT-authorized new routes and Lambda status before executing
`bash infra/deploy-web.sh` and issuing your normal CloudFront invalidation.
Do not remove or recreate your old DynamoDB/S3 resources.

## 5. Validate live site, then delete local backup

Smoke-test saving a test journal page, uploading/previewing a private photo,
generating/downloading a short PDF, reopening a saved PDF, and older journals.
Only after everything is healthy, you can delete the *local* backup folder you
created before deployment, using your exact path:

```bash
# Inspect local backup first
ls -d "$HOME"/reverie-deploy-backup-*
# Replace with the exact directory from the previous step:
BACKUP_TO_REMOVE="$HOME/reverie-deploy-backup-YYYYMMDD-HHMMSS"
[[ -d "$BACKUP_TO_REMOVE" && "$BACKUP_TO_REMOVE" == "$HOME"/reverie-deploy-backup-* ]] && rm -rI -- "$BACKUP_TO_REMOVE"
```

This is local disk cleanup only, not an AWS database/S3 deletion.

## Failure/retry considerations

- The `--deploy` path requires AWS permissions to create/manage a scoped
  CodeBuild project and role, upload temporary objects to your existing
  bucket, publish a Lambda layer, and update/create the renderer Lambda.
- IAM policies are restricted to this build prefix and existing renderer
  data prefixes; the builder has no access to user uploads outside its own
  `infra-builds/memory-renderer/*` prefix.
- Lambda has a 250 MB total unzipped function + layer deployment limit; the
  CodeBuild packager checks the layer size before upload.
- If an **Image**-type Lambda already exists with the selected name, the script
  stops rather than deleting it: Lambda package type cannot be changed in place.
- If you need to examine a failed CodeBuild run, the temporary build artifacts
  remain in S3 until manually cleaned up. No user data is touched.
- Creating the renderer and passing tests does **not** mean the new API routes
  are deployed; those require the separate backend script.
