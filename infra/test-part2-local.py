"""Offline smoke tests (no AWS/Google calls). Run: python3 infra/test-part2-local.py"""
import importlib.util
import io
import json
import os
from pathlib import Path
from unittest.mock import MagicMock, patch

os.environ.setdefault("UPLOAD_BUCKET", "test-private-bucket")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
os.environ.setdefault("GEMINI_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:123456789012:secret:sample")
root = Path(__file__).parent / "lambda"


def import_file(name):
    spec = importlib.util.spec_from_file_location(name, root / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


def test_start():
    start = import_file("start_transcribe")
    start.s3 = MagicMock()
    start.s3.head_object.return_value = {"ContentLength": 12345, "ContentType": "video/mp4"}
    start.transcribe = MagicMock()
    upload_id = "a1b2c3d4-5555-4444-3333-123456789abc"
    event = {"Records": [{"eventSource": "aws:s3", "s3": {
        "bucket": {"name": "test-private-bucket"},
        "object": {"key": f"uploads%2F{upload_id}.mp4"}}}]}
    start.handler(event, None)
    kwargs = start.transcribe.start_transcription_job.call_args.kwargs
    assert kwargs["TranscriptionJobName"] == f"vjournal-{upload_id}"
    assert kwargs["Media"]["MediaFileUri"].endswith(f"/{upload_id}.mp4")
    assert start.s3.put_object.call_args.kwargs["IfNoneMatch"] == "*"
    print("PASS start Transcribe on new uploaded MP4")


def test_finish():
    finish = import_file("finish_transcribe")
    finish.s3 = MagicMock()
    # Not yet completed.
    from botocore.exceptions import ClientError
    finish.s3.get_object.side_effect = ClientError({"Error": {"Code": "NoSuchKey", "Message": "missing"}}, "GetObject")
    finish.transcribe = MagicMock()
    finish.transcribe.get_transcription_job.return_value = {"TranscriptionJob": {"TranscriptionJobStatus": "COMPLETED", "Media": {"MediaFileUri": "s3://test-private-bucket/uploads/a1b2c3d4-5555-4444-3333-123456789abc.mp4"}}}
    finish.get_transcript = lambda job: "I had a wonderful day with friends."
    finish.analyze = lambda transcript: {"sentiment": "positive", "emotions": ["joy"],
                                          "themes": ["friends"], "summary": "A good day."}
    uid = "a1b2c3d4-5555-4444-3333-123456789abc"
    event = {"source": "aws.transcribe", "detail": {"TranscriptionJobName": f"vjournal-{uid}",
                                                      "TranscriptionJobStatus": "COMPLETED"}}
    response = finish.handler(event, None)
    assert response["completed"] is True
    result = json.loads(finish.s3.put_object.call_args.kwargs["Body"])
    assert result["status"] == "completed"
    assert result["analysis"]["emotions"] == ["joy"]
    print("PASS completion → Gemini analysis → private result JSON")


def test_get():
    get = import_file("get_result")
    get.s3 = MagicMock()
    uid = "a1b2c3d4-5555-4444-3333-123456789abc"
    get.s3.get_object.return_value = {"Body": io.BytesIO(json.dumps({"upload_id": uid,
        "status": "completed", "transcript": "hi", "analysis": None, "error": None}).encode())}
    resp = get.handler({"pathParameters": {"upload_id": uid}}, None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])["status"] == "completed"
    assert get.handler({"pathParameters": {"upload_id": "../../../hello"}}, None)["statusCode"] == 400
    print("PASS frontend GET result and reject unsafe IDs")

if __name__ == "__main__":
    test_start(); test_finish(); test_get()
