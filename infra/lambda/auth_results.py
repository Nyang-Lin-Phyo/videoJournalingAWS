"""Cognito-owner-scoped journals: list, reflection, private playback, and deletion.

Uploads/processing are owned by other functions. This Lambda never invokes models.
Deletion first tombstones the record, removes private S3 objects, then deletes
DynamoDB metadata. A transient deletion failure leaves an owner-retryable tombstone.
"""
import base64
import json
import os
import re
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import boto3
from boto3.dynamodb.conditions import Key
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

BUCKET = os.environ['UPLOAD_BUCKET']
TABLE = os.environ['JOURNAL_TABLE']
USER_POOL_ID = os.environ.get('USER_POOL_ID', '')
s3 = boto3.client('s3', config=Config(signature_version='s3v4'))
table = boto3.resource('dynamodb').Table(TABLE)
cognito = boto3.client('cognito-idp')
UUID_RE = re.compile(r'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$')
SUB_RE = re.compile(r'^[0-9a-zA-Z_-]{1,128}$')
ACTIVE = {'awaiting_upload', 'queued', 'transcribing', 'analyzing'}
ACCOUNT_UPLOAD_EXPIRY_SECONDS = 330
ACCOUNT_JOURNAL_BATCH_SIZE = 5
ACCOUNT_PREFIX_PAGE_SIZE = 500
STREAK_KEY_PREFIX = 'streak#'
STREAK_FREEZE_COST = 7
ACCOUNT_MARKER_CLEANUP_FIELDS = (
    'cleanupPhase', 'deleteNotBefore', 'cognitoUsername',
    'journalCursor', 'uploadsCursor', 'transcriptsCursor',
)


def respond(status, payload=None):
    return {
        'statusCode': status,
        'headers': {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
        'body': '' if status == 204 else json.dumps(payload or {}),
    }


def subject(event):
    claims = (((event.get('requestContext') or {}).get('authorizer') or {})
              .get('jwt') or {}).get('claims') or {}
    value = claims.get('sub')
    return value if claims.get('token_use') == 'access' and isinstance(value, str) and SUB_RE.fullmatch(value) else None


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


def saved_transcript(row, upload_id, owner):
    key = row.get('transcriptKey')
    if not key:
        return None, None
    # Verify the exact key even after checking DynamoDB ownership. Never use a
    # client-provided key or let a malformed row expose another journal's text.
    if key not in (f'transcripts/{owner}/{upload_id}.txt', f'transcripts/{upload_id}.txt'):
        return None, 'Unable to load the transcript. Please try again later.'
    try:
        body = s3.get_object(Bucket=BUCKET, Key=key)['Body']
        try:
            data = body.read(256 * 1024 + 1)
        finally:
            body.close()
        if len(data) > 256 * 1024:
            raise ValueError('Transcript exceeds limit')
        return data.decode('utf-8'), None
    except ClientError as exc:
        if exc.response['Error']['Code'] in ('NoSuchKey', '404', 'NotFound'):
            return None, None
    except (ValueError, OSError, BotoCoreError):
        pass
    return None, 'Unable to load the transcript. Please try again later.'


def handle_result(upload_id, owner):
    row = find_journal(upload_id, owner)
    if not row or row.get('status') == 'deleting':
        return respond(404, {'error': 'Journal not found'})
    transcript, transcript_error = saved_transcript(row, upload_id, owner)
    return respond(200, {
        'upload_id': upload_id,
        'title': title_of(row),
        'created_at': row.get('createdAt'),
        'status': row.get('status', 'awaiting_upload'),
        'analysis': row.get('analysis'),
        'transcript': transcript,
        'transcript_error': transcript_error,
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


def delete_object_versions(key):
    key_marker = None
    version_marker = None
    while True:
        args = {'Bucket': BUCKET, 'Prefix': key, 'MaxKeys': ACCOUNT_PREFIX_PAGE_SIZE}
        if key_marker:
            args['KeyMarker'] = key_marker
        if version_marker:
            args['VersionIdMarker'] = version_marker
        result = s3.list_object_versions(**args)
        objects = [
            {'Key': entry['Key'], 'VersionId': entry['VersionId']}
            for name in ('Versions', 'DeleteMarkers')
            for entry in result.get(name, [])
            if entry.get('Key') == key
        ]
        if objects:
            deleted = s3.delete_objects(Bucket=BUCKET, Delete={'Objects': objects, 'Quiet': True})
            if deleted.get('Errors'):
                raise RuntimeError('S3 object-version deletion failed')
        if not result.get('IsTruncated'):
            return
        key_marker = result.get('NextKeyMarker')
        version_marker = result.get('NextVersionIdMarker')
        if not key_marker:
            raise RuntimeError('S3 object-version pagination failed')


def delete_prefix_page(prefix, cursor):
    args = {'Bucket': BUCKET, 'Prefix': prefix, 'MaxKeys': ACCOUNT_PREFIX_PAGE_SIZE}
    if cursor:
        if cursor.get('KeyMarker'):
            args['KeyMarker'] = cursor['KeyMarker']
        if cursor.get('VersionIdMarker'):
            args['VersionIdMarker'] = cursor['VersionIdMarker']
    result = s3.list_object_versions(**args)
    objects = [
        {'Key': entry['Key'], 'VersionId': entry['VersionId']}
        for name in ('Versions', 'DeleteMarkers')
        for entry in result.get(name, [])
    ]
    if objects:
        deleted = s3.delete_objects(Bucket=BUCKET, Delete={'Objects': objects, 'Quiet': True})
        if deleted.get('Errors'):
            raise RuntimeError('S3 account-data deletion failed')
    if not result.get('IsTruncated'):
        return None
    next_cursor = {
        'KeyMarker': result.get('NextKeyMarker'),
        'VersionIdMarker': result.get('NextVersionIdMarker'),
    }
    if not next_cursor['KeyMarker']:
        raise RuntimeError('S3 account-data pagination failed')
    return next_cursor


def account_marker_key(owner):
    return f'account#{owner}'


def streak_key(owner):
    return f'{STREAK_KEY_PREFIX}{owner}'


def valid_timezone(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 128:
        return None
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError):
        return None
    return value


def streak_summary(owner, requested_timezone='UTC'):
    item = table.get_item(
        Key={'uploadId': streak_key(owner)},
        ConsistentRead=True,
    ).get('Item')
    zone_name = item.get('timezone', requested_timezone) if item else requested_timezone
    zone = ZoneInfo(zone_name)
    today = datetime.now(timezone.utc).astimezone(zone).date()
    freezes = int(item.get('freezes', 0)) if item else 0
    current_streak = int(item.get('currentStreak', 0)) if item else 0
    uploaded_today = False
    freeze_pending = False
    last_upload_at = item.get('lastUploadAt') if item else None
    if last_upload_at:
        last_day = datetime.fromisoformat(last_upload_at.replace('Z', '+00:00')).astimezone(zone).date()
        uploaded_today = last_day == today
        missed_days = (today - last_day).days - 1
        if missed_days > freezes:
            current_streak = 0
        elif missed_days > 0:
            freeze_pending = True
    return {
        'current_streak': current_streak,
        'longest_streak': int(item.get('longestStreak', 0)) if item else 0,
        'points': int(item.get('points', 0)) if item else 0,
        'freezes': freezes,
        'freeze_cost': STREAK_FREEZE_COST,
        'uploaded_today': uploaded_today,
        'freeze_pending': freeze_pending,
    }


def handle_streak(event, owner):
    query = event.get('queryStringParameters') or {}
    requested_timezone = valid_timezone(query.get('timezone', 'UTC'))
    if requested_timezone is None:
        return respond(400, {'error': 'Invalid timezone'})
    return respond(200, streak_summary(owner, requested_timezone))


def handle_buy_freeze(owner):
    key = {'uploadId': streak_key(owner)}
    for _ in range(3):
        item = table.get_item(Key=key, ConsistentRead=True).get('Item')
        if not item or int(item.get('points', 0)) < STREAK_FREEZE_COST:
            return respond(409, {'error': 'You need 7 points to buy a streak freeze.'})
        now = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        try:
            table.update_item(
                Key=key,
                UpdateExpression=(
                    'SET #points = #points - :cost, #freezes = if_not_exists(#freezes, :zero) + :one, '
                    '#version = #version + :one, updatedAt = :now'
                ),
                ConditionExpression='#points >= :cost AND #version = :version',
                ExpressionAttributeNames={
                    '#points': 'points',
                    '#freezes': 'freezes',
                    '#version': 'version',
                },
                ExpressionAttributeValues={
                    ':cost': STREAK_FREEZE_COST,
                    ':zero': 0,
                    ':one': 1,
                    ':now': now,
                    ':version': item['version'],
                },
            )
            return respond(200, streak_summary(owner, item.get('timezone', 'UTC')))
        except ClientError as exc:
            if exc.response['Error']['Code'] != 'ConditionalCheckFailedException':
                raise
    return respond(409, {'error': 'Your streak balance changed. Please try again.'})


def account_marker(owner):
    return table.get_item(
        Key={'uploadId': account_marker_key(owner)},
        ConsistentRead=True,
    ).get('Item')


def update_account_marker(owner, updates, remove=()):
    names = {f'#{key}': key for key in updates}
    values = {f':{key}': value for key, value in updates.items()}
    expression = 'SET ' + ', '.join(f'#{key} = :{key}' for key in updates)
    if remove:
        remove_names = {f'#remove{index}': name for index, name in enumerate(remove)}
        names.update(remove_names)
        expression += ' REMOVE ' + ', '.join(remove_names)
    table.update_item(
        Key={'uploadId': account_marker_key(owner)},
        UpdateExpression=expression,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def pending_account_delete(message, retry_after=1):
    return respond(202, {
        'pending': True,
        'message': message,
        'retry_after_seconds': max(1, retry_after),
    })


def lock_account_journal(row, owner, now):
    upload_id = row['uploadId']
    status = row.get('status', 'awaiting_upload')
    if status in ('transcribing', 'analyzing'):
        lease_expiry = int(row.get('leaseExpiresAt', 0))
        if lease_expiry > now:
            return lease_expiry - now
    elif status not in ('awaiting_upload', 'queued', 'completed', 'failed', 'deleting'):
        raise RuntimeError('Unsupported journal status')

    if status != 'deleting':
        values = {
            ':owner': owner,
            ':previous': status,
            ':deleting': 'deleting',
        }
        condition = 'attribute_exists(uploadId) AND userId = :owner AND #s = :previous'
        if status in ('transcribing', 'analyzing'):
            condition += ' AND (attribute_not_exists(leaseExpiresAt) OR leaseExpiresAt <= :now)'
            values[':now'] = now
        try:
            table.update_item(
                Key={'uploadId': upload_id},
                UpdateExpression='SET #s = :deleting REMOVE leaseToken, leaseExpiresAt',
                ConditionExpression=condition,
                ExpressionAttributeNames={'#s': 'status'},
                ExpressionAttributeValues=values,
            )
        except ClientError as exc:
            if exc.response['Error']['Code'] == 'ConditionalCheckFailedException':
                return 1
            raise

    for key in s3_keys_for(row, upload_id, owner):
        delete_object_versions(key)
    table.delete_item(
        Key={'uploadId': upload_id},
        ConditionExpression='userId = :owner AND #s = :deleting',
        ExpressionAttributeNames={'#s': 'status'},
        ExpressionAttributeValues={':owner': owner, ':deleting': 'deleting'},
    )
    return None


def handle_account_delete(event, owner):
    body = event.get('body') or '{}'
    try:
        request = json.loads(body)
    except (ValueError, TypeError):
        return respond(400, {'error': 'Invalid JSON'})
    email = request.get('email') if isinstance(request, dict) else None
    if not isinstance(email, str) or not email.strip() or len(email) > 320:
        return respond(400, {'error': 'A valid account email is required to verify account ownership.'})
    if not USER_POOL_ID:
        return respond(503, {'error': 'Account deletion is not configured. Please contact support.'})
    marker = account_marker(owner)
    if marker and marker.get('accountStatus') == 'deleted':
        return respond(204)
    if marker and marker.get('accountStatus') != 'deleting':
        return respond(503, {'error': 'Unable to continue account deletion. Please contact support.'})
    if not marker:
        try:
            # For Google-federated users the Cognito username is typically an
            # IdP-prefixed value, not the email. Search by the trusted JWT sub.
            # User input is used only to confirm the address, never to select
            # which Cognito account to delete.
            matches = cognito.list_users(
                UserPoolId=USER_POOL_ID,
                Filter=f'sub = "{owner}"',
                Limit=10,
            ).get('Users', [])
            candidates = [
                candidate for candidate in matches
                if any(attribute.get('Name') == 'sub' and attribute.get('Value') == owner
                       for attribute in candidate.get('Attributes', []))
            ]
            if len(candidates) != 1 or not candidates[0].get('Username'):
                return respond(503, {'error': 'Unable to verify the account identity. Please retry.'})
            username = candidates[0]['Username']
            # Strongly verify the exact user after the eventually consistent search.
            user = cognito.admin_get_user(UserPoolId=USER_POOL_ID, Username=username)
        except ClientError as exc:
            if exc.response.get('Error', {}).get('Code') == 'UserNotFoundException':
                return respond(503, {'error': 'Unable to verify the account identity. Please retry.'})
            return respond(503, {'error': 'Unable to verify the account. Please retry.'})
        except BotoCoreError:
            return respond(503, {'error': 'Unable to verify the account. Please retry.'})
        attributes = {item['Name']: item['Value'] for item in user.get('UserAttributes', [])}
        if (attributes.get('sub') != owner or
                attributes.get('email', '').casefold() != email.strip().casefold() or
                user.get('Username') != username):
            return respond(404, {'error': 'The account email does not match the signed-in user.'})
        now = int(time.time())
        try:
            table.put_item(
                Item={
                    'uploadId': account_marker_key(owner),
                    'accountStatus': 'deleting',
                    'cleanupPhase': 'journals',
                    'deleteNotBefore': now + ACCOUNT_UPLOAD_EXPIRY_SECONDS,
                    'cognitoUsername': user['Username'],
                },
                ConditionExpression='attribute_not_exists(uploadId)',
            )
        except ClientError as exc:
            if exc.response['Error']['Code'] != 'ConditionalCheckFailedException':
                raise
        marker = account_marker(owner)
        if not marker:
            return respond(503, {'error': 'Unable to start account deletion. Please retry.'})

    now = int(time.time())
    delete_not_before = int(marker.get('deleteNotBefore', 0))
    if delete_not_before > now:
        return pending_account_delete(
            'Waiting for previously issued upload links to expire before deleting account data.',
            delete_not_before - now,
        )

    phase = marker.get('cleanupPhase', 'journals')
    try:
        if phase == 'journals':
            query = {
                'IndexName': 'userId-createdAt-index',
                'KeyConditionExpression': Key('userId').eq(owner),
                'ScanIndexForward': False,
                'Limit': ACCOUNT_JOURNAL_BATCH_SIZE,
            }
            if marker.get('journalCursor'):
                query['ExclusiveStartKey'] = marker['journalCursor']
            result = table.query(**query)
            for row in result.get('Items', []):
                wait = lock_account_journal(row, owner, now)
                if wait is not None:
                    return pending_account_delete(
                        'Waiting for an in-progress journal to finish before deleting the account.',
                        wait,
                    )
            last_key = result.get('LastEvaluatedKey')
            if last_key:
                update_account_marker(owner, {'journalCursor': last_key})
                return pending_account_delete('Removing your journals and recordings.')
            update_account_marker(owner, {'cleanupPhase': 'streak'}, ('journalCursor',))
            return pending_account_delete('Removing your streak data.')

        if phase == 'streak':
            table.delete_item(Key={'uploadId': streak_key(owner)})
            update_account_marker(owner, {'cleanupPhase': 'uploads'})
            return pending_account_delete('Removing your recordings.')

        if phase in ('uploads', 'transcripts'):
            prefix = f'{phase}/{owner}/'
            cursor_name = f'{phase}Cursor'
            next_cursor = delete_prefix_page(prefix, marker.get(cursor_name))
            if next_cursor:
                update_account_marker(owner, {cursor_name: next_cursor})
                return pending_account_delete('Removing your recordings and transcripts.')
            next_phase = 'transcripts' if phase == 'uploads' else 'cognito'
            update_account_marker(owner, {'cleanupPhase': next_phase}, (cursor_name,))
            return pending_account_delete('Finishing account deletion.')

        if phase == 'cognito':
            update_account_marker(
                owner,
                {'cleanupPhase': 'cognito_delete'},
            )
            return pending_account_delete('Finishing account deletion.')

        if phase == 'cognito_delete':
            cognito.admin_delete_user(UserPoolId=USER_POOL_ID, Username=marker['cognitoUsername'])
            update_account_marker(
                owner,
                {'accountStatus': 'deleted'},
                ACCOUNT_MARKER_CLEANUP_FIELDS,
            )
            return respond(204)

        return respond(503, {'error': 'Unable to continue account deletion. Please contact support.'})
    except ClientError as exc:
        if exc.response['Error']['Code'] in ('ConditionalCheckFailedException', 'TransactionCanceledException'):
            return pending_account_delete('Account cleanup is in progress.')
        if exc.response['Error']['Code'] == 'UserNotFoundException' and phase == 'cognito_delete':
            update_account_marker(
                owner,
                {'accountStatus': 'deleted'},
                ACCOUNT_MARKER_CLEANUP_FIELDS,
            )
            return respond(204)
        return respond(503, {'error': 'Account cleanup could not be completed. Please retry.'})
    except (BotoCoreError, RuntimeError):
        return respond(503, {'error': 'Account cleanup could not be completed. Please retry.'})


def handle_delete(upload_id, owner):
    row = find_journal(upload_id, owner)
    if not row:
        return respond(404, {'error': 'Journal not found'})
    status = row.get('status')
    if status in ACTIVE:
        return respond(409, {'error': 'Please wait until your reflection finishes before deleting.'})
    if status not in ('completed', 'failed', 'deleting'):
        return respond(409, {'error': 'Journal cannot be deleted in its current state'})

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
    try:
        for key in s3_keys_for(row, upload_id, owner):
            delete_object_versions(key)
        table.delete_item(
            Key={'uploadId': upload_id},
            ConditionExpression='userId = :owner AND #s = :deleting',
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={':owner': owner, ':deleting': 'deleting'},
        )
    except (BotoCoreError, ClientError, RuntimeError):
        return respond(503, {'error': 'Journal cleanup incomplete. Please retry deletion.'})
    return respond(204)


def handler(event, context):
    owner = subject(event)
    if not owner:
        return respond(401, {'error': 'Unauthorized'})
    route = event.get('routeKey', '')
    if route == 'DELETE /account':
        return handle_account_delete(event, owner)
    if account_marker(owner):
        return respond(409, {'error': 'Account deletion is in progress. Continue deletion from Settings.'})
    if route == 'GET /streak':
        return handle_streak(event, owner)
    if route == 'POST /streak/freeze':
        return handle_buy_freeze(owner)
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
