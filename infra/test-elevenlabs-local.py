"""Offline tests: python3 infra/test-elevenlabs-local.py (requires boto3 installed)."""
import importlib.util
import io
import json
import os
from pathlib import Path
from unittest.mock import MagicMock

os.environ.update({
    "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing",
    "AWS_DEFAULT_REGION": "us-east-1", "AWS_EC2_METADATA_DISABLED": "true",
    "UPLOAD_BUCKET": "test-private-bucket",
    "ELEVENLABS_SECRET_ARN": "test-elevenlabs-secret",
    "GEMINI_SECRET_ARN": "test-gemini-secret",
})

root = Path(__file__).parent / "lambda" / "process_elevenlabs.py"
spec = importlib.util.spec_from_file_location("process_elevenlabs", root)
processor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(processor)

UPLOAD_ID = "a1b2c3d4-5555-4444-3333-123456789abc"
VIDEO = b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00"


def test_multipart():
    raw, boundary = processor.multipart_body(VIDEO)
    assert f"multipart/form-data; boundary={boundary}".startswith("multipart/form-data")
    assert b'name="model_id"' in raw
    assert b"scribe_v3" in raw
    assert b'name="file"' in raw
    assert VIDEO in raw
    print("PASS correct bounded ElevenLabs multipart/form-data")


def event(uid=UPLOAD_ID):
    return {"Records": [{"eventSource": "aws:s3", "s3": {
        "bucket": {"name": "test-private-bucket"},
        "object": {"key": "uploads%2F" + uid + ".mp4"},
    }}]}


def mock_storage():
    processor.s3 = MagicMock()
    processor.s3.head_object.return_value = {
        "ContentLength": len(VIDEO), "ContentType": "video/mp4"
    }
    processor.s3.get_object.return_value = {"Body": io.BytesIO(VIDEO)}


def statuses():
    return [json.loads(c.kwargs["Body"])["status"]
            for c in processor.s3.put_object.call_args_list]


def test_success():
    mock_storage()
    processor.transcribe_mp4 = lambda b: "I had a lovely day with friends."
    processor.analyze_transcript = lambda t: {
        "sentiment": "positive", "emotions": ["joy"],
        "themes": ["friends"], "summary": "A nice day with friends."
    }
    result = processor.handler(event(), None)
    assert result["results"][0] == {"completed": True}
    assert statuses() == ["transcribing", "analyzing", "completed"]
    kwargs = processor.s3.put_object.call_args_list[0].kwargs
    assert kwargs["IfNoneMatch"] == "*"
    assert kwargs["Key"] == f"results/{UPLOAD_ID}.json"
    print("PASS S3 event -> ElevenLabs -> Gemini -> completed result")


def test_duplicate():
    from botocore.exceptions import ClientError
    mock_storage()
    processor.s3.put_object.side_effect = ClientError({"Error": {
        "Code": "PreconditionFailed", "Message": "already claimed"
    }}, "PutObject")
    result = processor.handler(event(), None)
    assert result["results"][0] == {"duplicate": True}
    processor.s3.get_object.assert_not_called()
    print("PASS duplicate S3 events skip repeated paid transcription")


def test_error_result():
    mock_storage()
    def fail(video):
        raise RuntimeError("ElevenLabs HTTP 401")
    processor.transcribe_mp4 = fail
    result = processor.handler(event(), None)
    assert result["results"][0] == {"failed": True}
    assert statuses() == ["transcribing", "failed"]
    assert json.loads(processor.s3.put_object.call_args.kwargs["Body"])["error"]
    print("PASS provider failure yields frontend-readable failed result")


def test_validate_and_ignore():
    assert processor.handler(event("not-a-valid-id"), None)["results"][0] == {"ignored": True}
    try:
        processor.validate_analysis({"sentiment": "bad", "emotions": [], "themes": [], "summary": "ok"})
    except ValueError:
        pass
    else:
        raise AssertionError("invalid sentiment accepted")
    print("PASS invalid object events and malformed analysis rejected")


if __name__ == "__main__":
    test_multipart()
    test_success()
    test_duplicate()
    test_error_result()
    test_validate_and_ignore()
