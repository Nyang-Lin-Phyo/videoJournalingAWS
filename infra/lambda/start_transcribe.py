"""Triggered by uploads/*.mp4 S3 events; starts asynchronous Transcribe jobs.

Keeps only synthetic files in this no-auth demonstration. Results are private S3 objects.
"""
import json
import logging
import os
import re
from urllib.parse import unquote_plus

import boto3
from botocore.exceptions import ClientError

LOG = logging.getLogger(__name__)
LOG.setLevel(logging.INFO)
BUCKET = os.environ["UPLOAD_BUCKET"]
MAX_BYTES = 30 * 1024 * 1024
VIDEO_KEY = re.compile(r"^uploads/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.mp4$")
s3 = boto3.client("s3")
transcribe = boto3.client("transcribe")


def write_initial(upload_id):
    payload = {"upload_id": upload_id, "status": "transcribing", "transcript": None,
               "analysis": None, "error": None}
    try:
        s3.put_object(Bucket=BUCKET, Key=f"results/{upload_id}.json",
                      Body=json.dumps(payload).encode(), ContentType="application/json",
                      IfNoneMatch="*")
    except ClientError as exc:
        if exc.response["Error"]["Code"] not in ("PreconditionFailed", "ConditionalRequestConflict"):
            raise


def handler(event, context):
    for record in event.get("Records", []):
        if record.get("eventSource") != "aws:s3":
            continue
        bucket = record["s3"]["bucket"]["name"]
        key = unquote_plus(record["s3"]["object"]["key"])
        match = VIDEO_KEY.fullmatch(key)
        if bucket != BUCKET or not match:
            LOG.warning("Ignoring out-of-scope S3 object event")
            continue
        upload_id = match.group(1)
        obj = s3.head_object(Bucket=BUCKET, Key=key)
        if not 0 < obj["ContentLength"] <= MAX_BYTES:
            LOG.warning("Skipping object with invalid size: %s", upload_id)
            continue
        # These checks limit accidental inputs; Amazon Transcribe validates media decoding.
        if not str(obj.get("ContentType", "")).startswith("video/mp4"):
            LOG.warning("Skipping object with unsupported content type: %s", upload_id)
            continue
        job_name = f"vjournal-{upload_id}"
        try:
            transcribe.start_transcription_job(
                TranscriptionJobName=job_name,
                Media={"MediaFileUri": f"s3://{BUCKET}/{key}"},
                MediaFormat="mp4", LanguageCode="en-US",
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConflictException":
                raise  # S3 async Lambda retries transient errors
        write_initial(upload_id)
        LOG.info("Transcription started or already exists for %s", upload_id)
    return {"ok": True}
