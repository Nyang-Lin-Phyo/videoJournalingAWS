"""Offline regression checks for browser video recording (no AWS calls).

Run: python3 infra/test-browser-recorder.py
"""
import importlib.util
import io
import json
import os
import pathlib
import sys
from unittest.mock import MagicMock

os.environ.update({
    'AWS_ACCESS_KEY_ID': 'test', 'AWS_SECRET_ACCESS_KEY': 'test',
    'AWS_DEFAULT_REGION': 'us-east-1', 'AWS_EC2_METADATA_DISABLED': 'true',
    'UPLOAD_BUCKET': 'test-upload-bucket', 'JOURNAL_TABLE': 'test-journal-table',
    'ELEVENLABS_SECRET_ARN': 'example', 'GEMINI_SECRET_ARN': 'example',
})
ROOT = pathlib.Path(__file__).parent
sys.path.insert(0, str(ROOT / 'lambda'))
sys.path.insert(0, str(ROOT))


def load(name, path=None):
    spec = importlib.util.spec_from_file_location(name, path or ROOT / 'lambda' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


signer = load('auth_signer')
worker = load('queue_worker')
results = load('auth_results')
provider = load('legacy_elevenlabs_provider')
notifications = load('recording_notification_config', ROOT / 'recording_notification_config.py')
owner, uid = 'user-abc', '1fbf8320-5eae-4614-acb1-e5d31306db15'
auth = {'requestContext': {'authorizer': {'jwt': {'claims': {'sub': owner, 'token_use': 'access'}}}}}


def test_signer():
    signer.table = MagicMock()
    signer.s3 = MagicMock()
    signer.s3.generate_presigned_post.return_value = {'url': 'https://example.amazonaws.com', 'fields': {'key': 'x'}}
    for ext, mime in [('webm', 'video/webm'), ('mp4', 'video/mp4')]:
        payload = {'filename': f'clip.{ext}', 'content_type': mime, 'size': 4000, 'title': 'My story'}
        reply = signer.handler({**auth, 'body': json.dumps(payload)}, None)
        assert reply['statusCode'] == 200, reply
        assert json.loads(reply['body'])['object_key'].endswith('.' + ext)
        assert signer.s3.generate_presigned_post.call_args.kwargs['Fields']['Content-Type'] == mime
    invalid = {'filename': 'clip.mp4', 'content_type': 'video/webm', 'size': 4000, 'title': 'My story'}
    assert signer.handler({**auth, 'body': json.dumps(invalid)}, None)['statusCode'] == 400
    assert signer.handler({'body': json.dumps(invalid)}, None)['statusCode'] == 401
    print('PASS signer: MP4/WebM matching and authentication')


def test_worker():
    key = f'uploads/{owner}/{uid}.webm'
    assert worker.KEY_RE.fullmatch(key)
    assert worker.KEY_RE.fullmatch(f'uploads/{owner}/{uid}.mp4')
    assert not worker.KEY_RE.fullmatch('uploads/unowned.webm')
    raw = b'\x1a\x45\xdf\xa3' + b'\x00webm\x00' + b'video data'
    worker.s3 = MagicMock()
    worker.s3.get_object.side_effect = [
        Exception('unexpected transcript fetch')
    ]
    from botocore.exceptions import ClientError
    worker.s3.get_object.side_effect = [
        ClientError({'Error': {'Code': 'NoSuchKey', 'Message': 'missing'}}, 'GetObject'),
        {'Body': io.BytesIO(raw)},
    ]
    worker.s3.head_object.return_value = {'ContentLength': len(raw), 'ContentType': 'video/webm'}
    worker.provider.transcribe_video = MagicMock(return_value='A good day')
    transcript, transcript_key = worker.get_transcript({}, uid, owner, key)
    assert transcript == 'A good day'
    assert transcript_key == f'transcripts/{owner}/{uid}.txt'
    worker.provider.transcribe_video.assert_called_once_with(raw, 'video/webm')
    worker.s3.put_object.assert_called_once()
    worker.s3.head_object.return_value['ContentType'] = 'video/mp4'
    worker.s3.get_object.side_effect = [ClientError({'Error': {'Code': 'NoSuchKey', 'Message': 'missing'}}, 'GetObject')]
    try:
        worker.get_transcript({}, uid, owner, key)
        raise AssertionError('Accepted mismatched S3 content type')
    except ValueError:
        pass
    print('PASS worker: WebM validation, transcription, rejecting mismatched type')


def test_provider():
    body, boundary = provider.multipart_body(b'video', 'video/webm')
    assert b'filename="journal.webm"' in body
    assert b'Content-Type: video/webm' in body
    assert boundary.encode() in body
    assert b'filename="journal.mp4"' in provider.multipart_body(b'video')[0]
    print('PASS ElevenLabs: correct multipart video MIME and filename')


def test_playback_delete():
    results.table = MagicMock()
    results.s3 = MagicMock()
    results.s3.generate_presigned_url.return_value = 'https://example.amazonaws.com/file'
    row = {'uploadId': uid, 'userId': owner, 'videoKey': f'uploads/{owner}/{uid}.webm', 'status': 'completed'}
    results.find_journal = lambda *_: row
    response = results.handle_video_url(uid, owner)
    assert response['statusCode'] == 200, response
    assert results.s3.generate_presigned_url.call_args.kwargs['Params']['ResponseContentType'] == 'video/webm'
    assert row['videoKey'] in results.s3_keys_for(row, uid, owner)
    row['videoKey'] = 'uploads/another-user/cannot-delete.webm'
    assert row['videoKey'] not in results.s3_keys_for(row, uid, owner)
    assert results.handle_video_url(uid, owner)['statusCode'] == 409
    print('PASS playback/delete: owner-scoped WebM support')


def test_notifications():
    arn = 'arn:aws:sqs:us-east-1:123456789012:existing-queue'
    base = {'QueueConfigurations': [{
        'Id': 'ReverieV3SqsMp4', 'QueueArn': arn, 'Events': ['s3:ObjectCreated:*'],
        'Filter': {'Key': {'FilterRules': [
            {'Name': 'prefix', 'Value': 'uploads/'}, {'Name': 'suffix', 'Value': '.mp4'},
        ]}},
    }], 'EventBridgeConfiguration': {}}
    after = notifications.add_webm_notification(base, arn)
    assert len(after['QueueConfigurations']) == 2
    assert len(base['QueueConfigurations']) == 1
    assert notifications.add_webm_notification(after, arn) == after
    assert after['QueueConfigurations'][0] == base['QueueConfigurations'][0]
    try:
        notifications.add_webm_notification(base, 'arn:aws:sqs:us-east-1:123456789012:another-queue')
        raise AssertionError('Allowed wrong queue')
    except ValueError:
        pass
    print('PASS notification: preserve MP4 routing and extend to WebM idempotently')


if __name__ == '__main__':
    test_signer()
    test_worker()
    test_provider()
    test_playback_delete()
    test_notifications()
    print('All browser-recorder backend checks passed; no AWS calls made.')
