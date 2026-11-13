"""Authenticated GET /uploads/{upload_id}/result and GET /journals."""
import base64, json, os, re
import boto3
from boto3.dynamodb.conditions import Key

BUCKET = os.environ['UPLOAD_BUCKET']
TABLE = os.environ['JOURNAL_TABLE']
s3 = boto3.client('s3')
table = boto3.resource('dynamodb').Table(TABLE)
UUID_RE = re.compile(r'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$')

def respond(status, data):
    return {'statusCode':status, 'headers':{'Content-Type':'application/json','Cache-Control':'no-store'}, 'body':json.dumps(data)}

def subject(event):
    claims = (((event.get('requestContext') or {}).get('authorizer') or {}).get('jwt') or {}).get('claims') or {}
    return claims.get('sub') if claims.get('token_use') == 'access' else None

def token_for(last_key):
    if not last_key: return None
    return base64.urlsafe_b64encode(json.dumps(last_key,separators=(',',':')).encode()).decode().rstrip('=')

def decode_cursor(raw, sub):
    if not raw or len(raw) > 2048: raise ValueError('Invalid next_token')
    value = json.loads(base64.urlsafe_b64decode(raw + '=' * (-len(raw) % 4)))
    if not isinstance(value,dict) or set(value) != {'uploadId','userId','userCreatedAt'}:
        raise ValueError('Invalid next_token')
    if value.get('userId') != sub or not all(isinstance(v,str) for v in value.values()):
        raise ValueError('Invalid next_token')
    return value

def handle_result(event, sub):
    upload_id = (event.get('pathParameters') or {}).get('upload_id','')
    if not UUID_RE.fullmatch(upload_id):
        return respond(400, {'error':'Invalid upload ID'})
    out = table.get_item(Key={'uploadId':upload_id}, ConsistentRead=True)
    item = out.get('Item')
    # Deny by 404 to avoid disclosing that another user owns this upload.
    if not item or item.get('userId') != sub:
        return respond(404, {'error':'Journal not found'})
    transcript = None
    if item.get('transcriptKey'):
        body = s3.get_object(Bucket=BUCKET, Key=item['transcriptKey'])['Body']
        transcript = body.read(256*1024).decode('utf-8')
    return respond(200, {
        'upload_id': upload_id, 'status': item.get('status','awaiting_upload'),
        'transcript': transcript, 'analysis':item.get('analysis'), 'error':item.get('error')})

def handle_list(event, sub):
    query = event.get('queryStringParameters') or {}
    try:
        limit = int(query.get('limit','20'))
        if not 1 <= limit <= 50: raise ValueError()
        cursor = decode_cursor(query['next_token'], sub) if query.get('next_token') else None
    except (ValueError, TypeError, KeyError, OverflowError):
        return respond(400, {'error':'Invalid pagination request'})
    args = {'IndexName':'userId-createdAt-index', 'KeyConditionExpression': Key('userId').eq(sub),
            'ScanIndexForward':False, 'Limit':limit}
    if cursor: args['ExclusiveStartKey'] = cursor
    result = table.query(**args)
    journals = []
    for item in result.get('Items',[]):
        analysis = item.get('analysis') or {}
        journals.append({'upload_id':item['uploadId'], 'created_at':item['createdAt'],
                         'status':item['status'], 'sentiment':analysis.get('sentiment')})
    return respond(200, {'journals':journals, 'next_token':token_for(result.get('LastEvaluatedKey'))})

def handler(event, context):
    sub = subject(event)
    if not sub: return respond(401, {'error':'Unauthorized'})
    route = event.get('routeKey','')
    if route == 'GET /journals': return handle_list(event, sub)
    if route == 'GET /uploads/{upload_id}/result': return handle_result(event, sub)
    return respond(404, {'error':'Not found'})
