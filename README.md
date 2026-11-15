# Reverie: Gemini transient retry fix

This overlay updates only the SQS worker Lambda source, reusing the existing
model and secrets configuration. It adds up to three quick retries for Gemini
429, 500, 502, 503, 504 and network errors, using 5/10/20 second backoff
with up to 1.5 seconds of jitter. The total is at most four Gemini calls per
Lambda invocation; permanent HTTP 400/401/403/404 errors are not retried.

The SQS fallback remains unchanged: failures that outlast the quick retries
return to SQS after its 3600-second visibility timeout, with a maximum of five
receives before DLQ. The transcript is read from its previously saved S3 file
so a Gemini-only retry does not repeat ElevenLabs transcription. The DLQ
requires separate monitoring/reconciliation.

This update does not change SQS, DynamoDB, the API, CloudFront, or existing
private journal objects. Do not rerun the older Part 3 cutover script.

## Install

Commit or stash unrelated local edits first if necessary. From the repo root:

    unzip -o reverie-gemini-retry-fix.zip
    python3 -m py_compile infra/lambda/legacy_elevenlabs_provider.py infra/lambda/queue_worker.py
    python3 infra/test-gemini-retry.py
    bash -n infra/deploy-gemini-retry.sh infra/requeue-one-journal.sh

Inspect code changes and tests, then deploy **only worker code**:

    git diff -- infra/lambda/legacy_elevenlabs_provider.py infra/lambda/queue_worker.py
    export CONFIRM_GEMINI_RETRY=YES
    bash infra/deploy-gemini-retry.sh

Check Lambda logs and runtime model configuration:

    source infra/.part2-resource-ids.env
    aws lambda get-function-configuration --function-name "$START_FUNC" --query '[Handler,LastUpdateStatus,Environment.Variables.GEMINI_MODEL]' --output json

## Retry only one older journal

After confirming the source queue is empty, and the journal is still queued
with no processing lease, run:

    bash infra/requeue-one-journal.sh 2ca41abf-6085-419d-9c77-b02d635ac7f8

It asks for a typed confirmation; it will enqueue *one* synthetic S3 event
for the existing journal record. Because the transcript already exists,
ElevenLabs is not called again. If the original SQS message later reappears,
duplicate processing must still be handled idempotently by the existing lease.
SQS message counts are approximate; do not send manual replays while other
jobs are pending or processing.

## Troubleshooting

If the Lambda logs now show 'Gemini HTTP 404', verify the exact configured
model name. If 401/403, check API key and Gemini project access. If 429,
check rate limits and quota. If 503, temporary provider overload. Do not
log provider response bodies, transcripts or API keys.

The existing frontend might show stale 'Preparing' until its next refresh;
reopen or reload Journal History after checking DynamoDB status.
