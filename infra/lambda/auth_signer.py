"""Authenticated POST /uploads, with required journal title, retaining signed-upload response shape."""
import json, os, re
from datetime import datetime, timezone
from uuid import uuid4
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

BUCKET = os.environ['UPLOAD_BUCKET']
TABLE = os.environ['JOURNAL_TABLE']
MAX_BYTES = 30 * 1024 * 1024
s3 = boto3.client('s3', config=Config(signature_version='s3v4'))
table = boto3.resource('dynamodb').Table(TABLE)
SUB_RE = re.compile(r'^[0-9a-zA-Z_-]{1,128}$')

def respond(status, payload):
    return {'statusCode':status, 'headers':{'Content-Type':'application/json','Cache-Control':'no-store'}, 'body':json.dumps(payload)}

def subject(event):
    claims = (((event.get('requestContext') or {}).get('authorizer') or {}).get('jwt') or {}).get('claims') or {}
    sub = claims.get('sub', '')
    return sub if claims.get('token_use') == 'access' and SUB_RE.fullmatch(sub) else None

def handler(event, context):
    sub = subject(event)
    if not sub:
        return respond(401, {'error':'Unauthorized'})
    try:
        request = json.loads(event.get('body') or '{}')
    except (TypeError, ValueError):
        return respond(400, {'error':'Invalid JSON'})
    if not isinstance(request, dict) or set(request) != {'filename','content_type','size','title'}:
        return respond(400, {'error':'Expected filename, content_type, size and title'})
    filename, mime, size = request['filename'], request['content_type'], request['size']
    raw_title = request['title']
    if not isinstance(raw_title, str):
        return respond(400, {'error':'Title must be a string'})
    title = raw_title.strip()
    if not 1 <= len(title) <= 100 or any(ord(ch) < 32 or ord(ch) == 127 for ch in title):
        return respond(400, {'error':'Title must contain 1-100 visible characters'})
    if not (isinstance(filename,str) and filename.lower().endswith('.mp4') and len(filename) <= 255
            and mime == 'video/mp4' and type(size) is int and 1 <= size <= MAX_BYTES):
        return respond(400, {'error':'Only MP4 files up to 30 MiB are allowed'})
    upload_id = str(uuid4())
    key = f'uploads/{sub}/{upload_id}.mp4'
    now = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
    item = {'uploadId': upload_id, 'userId': sub, 'createdAt': now,
            'userCreatedAt': f'{now}#{upload_id}', 'videoKey': key,
            'status': 'awaiting_upload', 'attempt': 0, 'size': size, 'title': title}
    table.put_item(Item=item, ConditionExpression='attribute_not_exists(uploadId)')
    try:
        signed = s3.generate_presigned_post(
            Bucket=BUCKET, Key=key,
            Fields={'Content-Type':'video/mp4'},
            Conditions=[{'Content-Type':'video/mp4'}, ['content-length-range', 1, MAX_BYTES+16*1024]],
            ExpiresIn=300)
    except Exception:
        # Compensation if signing fails, so the journal does not remain orphaned.
        table.delete_item(Key={'uploadId':upload_id},
                          ConditionExpression='userId = :u', ExpressionAttributeValues={':u':sub})
        raise
    return respond(200, {'upload_id':upload_id, 'object_key':key,
                         'max_bytes':MAX_BYTES, 'expires_in':300,
                         'upload':{'method':'POST', **signed}})
