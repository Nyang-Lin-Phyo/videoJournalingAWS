# Reverie Part 2 — switch existing AWS ingestion pipeline to ElevenLabs Scribe + Gemini

This **in-place** upgrade assumes you already deployed Parts 1 and 2 and that:

- The S3 website, upload signer, private uploads bucket, API Gateway and result lookup work or exist.
- `infra/.resource-ids.env` and `infra/.part2-resource-ids.env` exist in your WSL checkout.
- `uploads/*.mp4` S3 notifications already invoke the Lambda named in `$START_FUNC`.
- A Gemini key has already been stored in AWS Secrets Manager as `videojournal/gemini/<account>`.

**Do not rerun** `infra/setup-aws.sh`, `infra/setup-part2.sh`, or create new buckets. The old `$START_FUNC` name contains `transcribe-start` but we intentionally reuse its existing Lambda ARN so the S3 trigger remains attached. Its **handler** changes to `process_elevenlabs.handler` and no calls to AWS Transcribe remain.

## 1. Extract archive into the existing project

From `~/codeStuff/videoJournalingAWS`:

```bash
unzip -o videojournal-elevenlabs-upgrade.zip
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
aws sts get-caller-identity
printf 'Account %s, region %s, upload bucket %s\n' "$AWS_ACCOUNT" "$AWS_REGION" "$UPLOAD_BUCKET"
```

## 2. Enter ElevenLabs key (secret is hidden)

```bash
bash infra/create-elevenlabs-secret.sh
```

Paste the key at the hidden prompt. It is saved under `videojournal/elevenlabs/456157355328` (using your actual account ID). The Gemini key remains in `videojournal/gemini/456157355328`. Never put either key into `VITE_*`, React `.env` files, Git or shell history.

## 3. Test local Python code without external requests (optional)

```bash
python3 infra/test-elevenlabs-local.py
```

Requires `boto3` in your local venv. If missing, `python3 -m pip install boto3`. The deployed Lambda relies on boto3 provided by the Python 3.12 Lambda runtime; it needs no third-party pip packages.

## 4. Switch in place

```bash
bash -n infra/create-elevenlabs-secret.sh
bash -n infra/switch-to-elevenlabs.sh
python3 -m py_compile infra/lambda/process_elevenlabs.py
bash infra/switch-to-elevenlabs.sh
```

What the script does:

1. Verifies AWS account and S3 upload notification are correct.
2. Updates IAM: allows the existing processing Lambda to read `uploads/*`, write `results/*`, and read ONLY the two secrets.
3. Gives the existing results Lambda `s3:ListBucket` so absent result files return 404 instead of a misleading 403/500.
4. Disables the unused EventBridge rule for Amazon Transcribe completion. It leaves the old `FINISH_FUNC` deployed but idle, so no new service needs to be created.
5. Replaces the **code and handler** of `$START_FUNC` with `process_elevenlabs.handler`, configures 512 MB RAM, 600 s timeout, Scribe v3 (`scribe_v3`) and Gemini model (`$GEMINI_MODEL` from previous state).
6. Checks Lambda status and API routes.

The script doesn't touch the S3 notification because it remains pointed at `$START_FUNC`. It doesn't modify the upload signer, site bucket, or GET results route.

To use Scribe v2 instead (if v3 is unavailable to your ElevenLabs plan), before the switch run `export ELEVENLABS_MODEL=scribe_v2`.

## 5. Deploy the updated site labels

The frontend is already wired to `GET /uploads/{upload_id}/result` and the existing JSON result contract. Only explanatory UI text is changed from Amazon Transcribe to ElevenLabs.

```bash
bash infra/deploy-web.sh
source infra/.resource-ids.env
echo "$SITE_URL"
```

## 6. Test with a **new**, fictional spoken MP4

Earlier uploads that failed via Amazon Transcribe will not be automatically retried. Upload a NEW file through the website (it will receive a new UUID). Use fictional or synthetic speech. The demo site is HTTP-only with a public results API; do not upload private journals.

The browser should show `queued` (briefly), `transcribing`, `analyzing`, then `completed` and the transcript, sentiment, emotions, themes, and summary. The completion file is `s3://$UPLOAD_BUCKET/results/<upload-id>.json`.

Check logs and results from WSL:

```bash
source infra/.resource-ids.env
source infra/.part2-resource-ids.env
aws logs tail "/aws/lambda/$START_FUNC" --since 30m
aws s3 ls "s3://$UPLOAD_BUCKET/results/" --recursive
# Replace with the new UUID shown by the website:
bash infra/check-part2.sh YOUR-NEW-UPLOAD-UUID
```

Confirm Transcribe is no longer called by inspecting the Lambda handler:

```bash
aws lambda get-function-configuration --function-name "$START_FUNC" \
  --query '[FunctionName,Handler,Timeout,MemorySize]' --output table
aws events describe-rule --name "$RULE_NAME" --query '[Name,State]' --output table
```

Expected handler: `process_elevenlabs.handler`. Expected EventBridge state: `DISABLED`.

## Troubleshooting

- **ElevenLabs returns failure:** Check Lambda logs. `ElevenLabs HTTP 401/403` usually means invalid key or missing key scope; `429` usually means quota/rate limit. The result API returns `failed` with a safe message; retry by **re-uploading** a new MP4.
- **Gemini fails:** Check the Gemini key stored in Secrets Manager and model ID. If the model isn't available to your key, adjust `GEMINI_MODEL` and rerun switch script, or use `aws lambda update-function-configuration` to modify it. No key should appear in code or logs.
- **500 on GET results:** The script adds `s3:ListBucket` to `$RESULT_ROLE`. Inspect `/aws/lambda/$RESULT_FUNC` logs and verify the GET route. Existing Lambda code must retain S3 GetObject permissions.
- **No processing:** Confirm the S3 notification `VideoJournalNewMp4` points to the original `$START_FUNC`, and upload a new lowercase `.mp4` under `uploads/`.
- **Status stuck `transcribing`:** A Lambda may have timed out after claiming the upload. For this demo, use a fresh upload; production requires retryable jobs, a timeout lease, and a DLQ.
- **No permissions:** Check IAM policies added to `$START_ROLE` and `$RESULT_ROLE` and the Secrets Manager ARNs for the selected region.
- **Website still says Amazon Transcribe:** Run `bash infra/deploy-web.sh` again and refresh the page (cache may retain previous JS assets).

## Operational and security limits

- Single Lambda synchronously downloads and uploads the MP4 (max 30 MiB) to ElevenLabs, then calls Gemini. Short videos only; the synchronous transcription request can consume most of the configured 600-second Lambda timeout.
- S3 event deliveries are at least once. The Lambda uses conditional `IfNoneMatch='*'` when first creating the result file to avoid duplicated paid calls. A Lambda crash **after claiming** can leave a stuck state; there is no durable retry mechanism yet.
- Results are private S3 objects but the current GET results API has no user authorization: anyone who knows an upload UUID may retrieve the transcript and analysis. Your S3-hosted website is HTTP-only and the signed-upload API is anonymous. Use fictional/synthetic recordings only until you deploy HTTPS, authentication, authorization and retention policies.
- Passing the MP4 to ElevenLabs and its transcript to Gemini sends data to two external services. Review their data handling and retention terms before processing real personal content.
- Billing may include ElevenLabs audio minutes, Gemini tokens, Lambda runtime, S3, API Gateway, Secrets Manager and data transfer. Enforce a budget alert and disable the anonymous upload API after testing.

## Official API references

- ElevenLabs Create transcript: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
- ElevenLabs models: https://elevenlabs.io/docs/overview/models/
- S3 event at-least-once behavior: https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-event-types-and-destinations.html
