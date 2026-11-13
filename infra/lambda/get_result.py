"""Public *demo-only* result lookup: GET /uploads/{upload_id}/result."""
import json
import os
import re

import boto3
from botocore.exceptions import ClientError

BUCKET = os.environ["UPLOAD_BUCKET"]
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
s3 = boto3.client("s3")


def response(status, body):
    return {"statusCode": status,
            "headers": {"Content-Type": "application/json", "Cache-Control": "no-store"},
            "body": json.dumps(body)}


def handler(event, context):
    upload_id = (event.get("pathParameters") or {}).get("upload_id", "")
    if not UUID_RE.fullmatch(upload_id):
        return response(400, {"error": "Invalid upload ID"})
    try:
        result = s3.get_object(Bucket=BUCKET, Key=f"results/{upload_id}.json")
        return response(200, json.loads(result["Body"].read()))
    except ClientError as exc:
        if exc.response["Error"]["Code"] not in ("NoSuchKey", "404", "NotFound"):
            raise
    try:
        s3.head_object(Bucket=BUCKET, Key=f"uploads/{upload_id}.mp4")
        return response(200, {"upload_id": upload_id, "status": "queued",
                              "transcript": None, "analysis": None, "error": None})
    except ClientError as exc:
        if exc.response["Error"]["Code"] in ("404", "NotFound", "NoSuchKey"):
            return response(404, {"error": "Upload not found"})
        raise
