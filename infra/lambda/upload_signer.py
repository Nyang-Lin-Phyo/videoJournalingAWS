"""Part 1 demo: issue presigned S3 POST forms for anonymous MP4 test uploads."""
import json
import os
from uuid import uuid4

import boto3
from botocore.config import Config

BUCKET = os.environ["UPLOAD_BUCKET"]
MAX_BYTES = 30 * 1024 * 1024
# S3 POST content-length-range includes multipart form overhead.
MAX_POST_BYTES = MAX_BYTES + 16 * 1024
s3 = boto3.client("s3", config=Config(signature_version="s3v4"))


def response(status, payload):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(payload),
    }


def handler(event, context):
    try:
        request = json.loads(event.get("body") or "{}")
        if not isinstance(request, dict):
            return response(400, {"error": "Expected a JSON object"})
    except (ValueError, TypeError):
        return response(400, {"error": "Invalid JSON"})

    filename = request.get("filename")
    content_type = request.get("content_type")
    size = request.get("size")
    if (
        not isinstance(filename, str)
        or not filename.lower().endswith(".mp4")
        or len(filename) > 255
        or content_type != "video/mp4"
        or type(size) is not int
        or not (1 <= size <= MAX_BYTES)
    ):
        return response(400, {"error": "Only nonempty MP4 files up to 30 MiB are allowed"})

    upload_id = str(uuid4())
    object_key = f"uploads/{upload_id}.mp4"
    signed_form = s3.generate_presigned_post(
        Bucket=BUCKET,
        Key=object_key,
        Fields={"Content-Type": "video/mp4"},
        Conditions=[
            {"Content-Type": "video/mp4"},
            ["content-length-range", 1, MAX_POST_BYTES],
        ],
        ExpiresIn=300,
    )
    return response(200, {
        "upload_id": upload_id,
        "object_key": object_key,
        "max_bytes": MAX_BYTES,
        "expires_in": 300,
        "upload": {"method": "POST", **signed_form},
    })
