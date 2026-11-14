"""Cognito-owner-scoped journals: list, reflection, private playback, rename, delete.

Uploads/processing are owned by other functions. This Lambda never invokes models.
Deletion first tombstones the record, removes private S3 objects, then deletes
DynamoDB metadata. A transient deletion failure leaves an owner-retryable tombstone.
"""
import base64
import json
import os
import re
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key
from botocore.config import Config
from botocore.exceptions import ClientError

BUCKET = os.environ['UPLOAD_BUCKET']
TABLE = os.environ['JOURNAL_TABLE']
s3 = boto3.client('s3', config=Config(signature_version='s3v4'))
table = boto3.resource('dynamodb').Table(TABLE)
UUID_RE = re.compile(r'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$')
ACTIVE = {'awaiting_upload', 'queued', 'transcribing', 'analyzing'}


def respond(status, payload=None):
    return {
        'statusCode': status,
        'headers': {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
        'body': '' if status == 204 else json.dumps(payload or {}),
    }


def subject(event):
    claims = (((event.get('requestContext') or {}).get('authorizer') or {})
              .get('jwt') or {}).get('claims') or {}
    return claims.get('sub') if claims.get('token_use') == 'access' else None


def find_journal(upload_id, owner):
    row = table.get_item(Key={'uploadId': upload_id}, ConsistentRead=True).get('Item')
    if not row or row.get('userId') != owner:
        return None
    return row


def title_of(row):
    return row.get('title') or 'Untitled'


def upload_id_of(event):
    value = (event.get('pathParameters') or {}).get('upload_id', '')
    return value if UUID_RE.fullmatch(value) else None


def cursor_encode(key):
    if not key:
        return None
    return base64.urlsafe_b64encode(json.dumps(key, separators=(',', ':')).encode()).decode().rstrip('=')


def cursor_decode(raw, owner):
    if not raw or len(raw) > 2048:
        raise ValueError('Invalid next_token')
    try:
        value = json.loads(base64.urlsafe_b64decode(raw + '=' * (-len(raw) % 4)))
    except Exception as exc:
        raise ValueError('Invalid next_token') from exc
    if not isinstance(value, dict) or set(value) != {'uploadId', 'userId', 'userCreatedAt'}:
        raise ValueError('Invalid next_token')
    if value.get('userId') != owner or not all(isinstance(v, str) for v in value.values()):
        raise ValueError('Invalid next_token')
    return value


def handle_list(event, owner):
    query = event.get('queryStringParameters') or {}
    try:
        limit = int(query.get('limit', '20'))
        if not 1 <= limit <= 50:
            raise ValueError()
        cursor = cursor_decode(query['next_token'], owner) if query.get('next_token') else None
    except (ValueError, TypeError, KeyError, OverflowError):
        return respond(400, {'error': 'Invalid pagination request'})
    args = {
        'IndexName': 'userId-createdAt-index',
        'KeyConditionExpression': Key('userId').eq(owner),
        'ScanIndexForward': False,
        'Limit': limit,
    }
    if cursor:
        args['ExclusiveStartKey'] = cursor
    output = table.query(**args)
    journals = []
    for row in output.get('Items', []):
        analysis = row.get('analysis') or {}
        journals.append({
            'upload_id': row['uploadId'],
            'created_at': row.get('createdAt'),
            'title': title_of(row),
            'status': row.get('status', 'awaiting_upload'),
            'sentiment': analysis.get('sentiment'),
        })
    return respond(200, {'journals': journals, 'next_token': cursor_encode(output.get('LastEvaluatedKey'))})


def handle_result(upload_id, owner):
    row = find_journal(upload_id, owner)
    if not row or row.get('status') == 'deleting':
        return respond(404, {'error': 'Journal not found'})
    # No transcription text is sent to the browser. It stays in private S3
    # for the original reflection-processing pipeline and deletion handling.
    return respond(200, {
        'upload_id': upload_id,
        'title': title_of(row),
        'created_at': row.get('createdAt'),
        'status': row.get('status', 'awaiting_upload'),
        'analysis': row.get('analysis'),
        'error': row.get('error'),
    })


def handle_video_url(upload_id, owner):
    row = find_journal(upload_id, owner)
    if not row or row.get('status') == 'deleting':
        return respond(404, {'error': 'Journal not found'})
    key = row.get('videoKey')
    allowed = {f'uploads/{owner}/{upload_id}.mp4', f'uploads/{upload_id}.mp4'}
    if not isinstance(key, str) or key not in allowed:
        return respond(409, {'error': 'Video not available'})
    if row.get('status') == 'awaiting_upload':
        return respond(409, {'error': 'Video not uploaded yet'})
    url = s3.generate_presigned_url(
        ClientMethod='get_object',
        Params={'Bucket': BUCKET, 'Key': key, 'ResponseContentType': 'video/mp4'},
        ExpiresIn=900,
    )
    return respond(200, {'upload_id': upload_id, 'url': url, 'expires_in': 900})


def validated_title(raw):
    if not isinstance(raw, str):
        return None
    title = raw.strip()
    if not (1 <= len(title) <= 100) or any(ord(char) < 32 or ord(char) == 127 for char in title):
        return None
    return title


def handle_rename(event, upload_id, owner):
    try:
        body = json.loads(event.get('body') or '{}')
    except (ValueError, TypeError):
        return respond(400, {'error': 'Invalid JSON'})
    if not isinstance(body, dict) or set(body) != {'title'}:
        return respond(400, {'error': 'Expected a title'})
    title = validated_title(body['title'])
    if title is None:
        return respond(400, {'error': 'Title must contain 1–100 visible characters'})
    try:
        result = table.update_item(
            Key={'uploadId': upload_id},
            UpdateExpression='SET title = :title',
            ConditionExpression='attribute_exists(uploadId) AND userId = :owner AND #s <> :deleting',
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={':title': title, ':owner': owner, ':deleting': 'deleting'},
            ReturnValues='ALL_NEW',
        )
    except ClientError as exc:
        if exc.response['Error']['Code'] == 'ConditionalCheckFailedException':
            return respond(404, {'error': 'Journal not found'})
        raise
    return respond(200, {'upload_id': upload_id, 'title': result['Attributes']['title']})


def s3_keys_for(row, upload_id, owner):
    keys = {f'results/{upload_id}.json', f'transcripts/{owner}/{upload_id}.txt',
            f'transcripts/{upload_id}.txt'}
    video_key = row.get('videoKey')
    if video_key in (f'uploads/{owner}/{upload_id}.mp4', f'uploads/{upload_id}.mp4'):
        keys.add(video_key)
    transcript_key = row.get('transcriptKey')
    if transcript_key in (f'transcripts/{owner}/{upload_id}.txt', f'transcripts/{upload_id}.txt'):
        keys.add(transcript_key)
    return sorted(keys)


def handle_delete(upload_id, owner):
    row = find_journal(upload_id, owner)
    if not row:
        return respond(404, {'error': 'Journal not found'})
    status = row.get('status')
    if status in ACTIVE:
        return respond(409, {'error': 'Please wait until your reflection finishes before deleting.'})
    if status not in ('completed', 'failed', 'deleting'):
        return respond(409, {'error': 'Journal cannot be deleted in its current state'})

    # A normal delete creates a marker on versioned buckets, leaving bytes
    # behind. Refuse rather than falsely promise permanent erasure.
    versioning = s3.get_bucket_versioning(Bucket=BUCKET).get('Status')
    if versioning in ('Enabled', 'Suspended'):
        return respond(409, {'error': 'Deletion unavailable: bucket versioning requires an explicit version-deletion workflow.'})

    if status != 'deleting':
        try:
            table.update_item(
                Key={'uploadId': upload_id},
                UpdateExpression='SET #s = :deleting, deleteRequestedAt = :timestamp',
                ConditionExpression='attribute_exists(uploadId) AND userId = :owner AND #s IN (:completed, :failed)',
                ExpressionAttributeNames={'#s': 'status'},
                ExpressionAttributeValues={
                    ':owner': owner, ':completed': 'completed', ':failed': 'failed',
                    ':deleting': 'deleting',
                    ':timestamp': datetime.now(timezone.utc).isoformat(),
                },
            )
        except ClientError as exc:
            if exc.response['Error']['Code'] == 'ConditionalCheckFailedException':
                return respond(409, {'error': 'Journal changed state. Please retry.'})
            raise

    # Retryable two-step delete: S3 first, DynamoDB row last. If S3 fails,
    # 'deleting' remains as a tombstone and the same owner can retry DELETE.
    keys = s3_keys_for(row, upload_id, owner)
    try:
        response = s3.delete_objects(
            Bucket=BUCKET,
            Delete={'Objects': [{'Key': key} for key in keys], 'Quiet': True},
        )
        if response.get('Errors'):
            return respond(503, {'error': 'Journal cleanup incomplete. Please retry deletion.'})
        table.delete_item(
            Key={'uploadId': upload_id},
            ConditionExpression='userId = :owner AND #s = :deleting',
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={':owner': owner, ':deleting': 'deleting'},
        )
    except ClientError:
        return respond(503, {'error': 'Journal cleanup incomplete. Please retry deletion.'})
    return respond(204)


def handler(event, context):
    owner = subject(event)
    if not owner:
        return respond(401, {'error': 'Unauthorized'})
    route = event.get('routeKey', '')
    if route == 'GET /journals':
        return handle_list(event, owner)
    upload_id = upload_id_of(event)
    if upload_id is None:
        return respond(400, {'error': 'Invalid upload ID'})
    if route == 'GET /uploads/{upload_id}/result':
        return handle_result(upload_id, owner)
    if route == 'GET /uploads/{upload_id}/video-url':
        return handle_video_url(upload_id, owner)
    if route == 'PATCH /journals/{upload_id}':
        return handle_rename(event, upload_id, owner)
    if route == 'DELETE /journals/{upload_id}':
        return handle_delete(upload_id, owner)
    return respond(404, {'error': 'Not found'})
