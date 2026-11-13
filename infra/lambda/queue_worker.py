"""SQS -> Lambda worker; reuses tested ElevenLabs/Gemini provider methods.

S3 sends a nested S3 event JSON as an SQS message Body. Only jobs with a
matching DynamoDB journal are processed. Bounded processing leases provide
idempotency; transcripts are cached before Gemini to avoid re-transcription
on Gemini retries. Exactly-once charges cannot be guaranteed across crashes.
"""
import json, logging, os, re, time, uuid
from urllib.parse import unquote_plus
import boto3
from botocore.exceptions import ClientError
import legacy_elevenlabs_provider as provider

LOG = logging.getLogger(__name__)
LOG.setLevel(logging.INFO)
BUCKET = os.environ['UPLOAD_BUCKET']
TABLE = os.environ['JOURNAL_TABLE']
MAX_BYTES = 30 * 1024 * 1024
LEASE_SECONDS = 11 * 60
KEY_RE = re.compile(r'^uploads/([A-Za-z0-9_-]{1,128})/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.mp4$')
s3 = boto3.client('s3')
table = boto3.resource('dynamodb').Table(TABLE)

def attempt_claim(upload_id, item):
    status = item.get('status')
    if status in ('completed','failed'):
        return None
    now = int(time.time())
    # Never concurrently use two leases, but permit recovery after a crash.
    if status in ('transcribing','analyzing') and int(item.get('leaseExpiresAt',0)) >= now:
        return None
    if status not in ('awaiting_upload','queued','transcribing','analyzing'):
        return None
    lease_token = str(uuid.uuid4())
    values = {':transcribing':'transcribing', ':token':lease_token,
              ':lease':now+LEASE_SECONDS, ':zero':0, ':one':1, ':prev':status}
    condition = '#s = :prev'
    if status in ('transcribing','analyzing'):
        condition += ' AND leaseExpiresAt < :now'
        values[':now'] = now
    try:
        table.update_item(
            Key={'uploadId':upload_id},
            UpdateExpression='SET #s=:transcribing, leaseToken=:token, leaseExpiresAt=:lease, attempt=if_not_exists(attempt,:zero)+:one',
            ConditionExpression=condition,
            ExpressionAttributeNames={'#s':'status'},ExpressionAttributeValues=values)
        return lease_token
    except ClientError as exc:
        if exc.response['Error']['Code'] == 'ConditionalCheckFailedException':
            return None
        raise

def update_owned(upload_id, token, set_clause, values, remove_clause=''):
    values = {**values, ':leaseToken':token}
    table.update_item(Key={'uploadId':upload_id},
                      UpdateExpression='SET ' + set_clause + (' REMOVE '+remove_clause if remove_clause else ''),
                      ConditionExpression='leaseToken = :leaseToken',
                      ExpressionAttributeNames={k:v for k,v in {'#s':'status','#e':'error'}.items()
                                                if k in (set_clause + ' ' + remove_clause)},
                      ExpressionAttributeValues=values)

def permanent_error(exc):
    if isinstance(exc, ValueError): return True
    if isinstance(exc, RuntimeError):
        m = re.fullmatch(r'(?:ElevenLabs|Gemini) HTTP ([0-9]{3})', str(exc))
        if m and int(m.group(1)) in (400,401,403,404,413,422): return True
    return False

def safe_error(exc):
    if isinstance(exc, ValueError): return 'Invalid video or transcript.'
    if isinstance(exc, RuntimeError) and str(exc).startswith('ElevenLabs'):
        return 'ElevenLabs request failed. Check provider access or quota.'
    if isinstance(exc, RuntimeError) and str(exc).startswith('Gemini'):
        return 'Gemini request failed. Check provider access or model.'
    return 'Processing temporarily unavailable.'

def get_transcript(item, upload_id, owner, video_key):
    # Store transcript in S3 before Gemini, so a retry can reuse it.
    transcript_key = f'transcripts/{owner}/{upload_id}.txt'
    try:
        data = s3.get_object(Bucket=BUCKET, Key=transcript_key)['Body'].read(256*1024+1)
        if len(data) > 256*1024: raise ValueError('Transcript exceeds limit')
        return data.decode('utf-8'), transcript_key
    except ClientError as exc:
        if exc.response['Error']['Code'] not in ('NoSuchKey','404','NotFound'):
            raise
    metadata = s3.head_object(Bucket=BUCKET, Key=video_key)
    size = metadata['ContentLength']
    if not (0 < size <= MAX_BYTES) or not metadata.get('ContentType','').lower().startswith('video/mp4'):
        raise ValueError('Invalid MP4 size or MIME type')
    data = s3.get_object(Bucket=BUCKET, Key=video_key)['Body'].read(MAX_BYTES+1)
    if len(data) != size or len(data) < 12 or data[4:8] != b'ftyp':
        raise ValueError('Invalid MP4 content')
    transcript = provider.transcribe_mp4(data)
    s3.put_object(Bucket=BUCKET, Key=transcript_key,
                  Body=transcript.encode('utf-8'),ContentType='text/plain; charset=utf-8')
    return transcript, transcript_key

def process_object(bucket, key):
    match = KEY_RE.fullmatch(key)
    if bucket != BUCKET or not match:
        LOG.info('Skipping unrelated S3 event')
        return
    owner, upload_id = match.groups()
    row = table.get_item(Key={'uploadId':upload_id},ConsistentRead=True).get('Item')
    # Unknown/old anonymous uploads intentionally are not processed in v3.
    if not row or row.get('userId') != owner or row.get('videoKey') != key:
        LOG.info('Skipping unregistered upload %s',upload_id)
        return
    token = attempt_claim(upload_id,row)
    if not token:
        LOG.info('Already handled or currently leased: %s',upload_id)
        return
    try:
        transcript, transcript_key = get_transcript(row,upload_id,owner,key)
        update_owned(upload_id,token,'#s=:s, transcriptKey=:t',
                     {':s':'analyzing',':t':transcript_key})
        analysis = provider.analyze_transcript(transcript)
        update_owned(upload_id,token,'#s=:s, analysis=:a',
                     {':s':'completed',':a':analysis},'leaseToken, leaseExpiresAt, #e')
        LOG.info('Completed upload %s',upload_id)
    except Exception as exc:
        LOG.error('Processing attempt failed for %s (%s)',upload_id,type(exc).__name__)
        if permanent_error(exc):
            update_owned(upload_id,token,'#s=:s, #e=:e',
                         {':s':'failed',':e':safe_error(exc)},'leaseToken, leaseExpiresAt')
        else:
            # Back to queued for a retry when SQS visibility timeout expires.
            update_owned(upload_id,token,'#s=:s, #e=:e',
                         {':s':'queued',':e':safe_error(exc)},'leaseToken, leaseExpiresAt')
            raise

def handler(event,context):
    failures = []
    for message in event.get('Records',[]):
        mid = message.get('messageId','')
        try:
            if message.get('eventSource') != 'aws:sqs':
                raise ValueError('Unexpected event source')
            body = json.loads(message['body'])
            for event_record in body.get('Records',[]):
                if event_record.get('eventSource') != 'aws:s3':
                    continue
                bucket = event_record['s3']['bucket']['name']
                key = unquote_plus(event_record['s3']['object']['key'])
                process_object(bucket,key)
        except Exception as exc:
            LOG.error('SQS message failed (%s)',type(exc).__name__)
            failures.append({'itemIdentifier':mid})
    return {'batchItemFailures':failures}
