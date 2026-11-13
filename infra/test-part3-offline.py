"""Run with python3 infra/test-part3-offline.py. Does not call AWS/provider APIs."""
import importlib.util, io, json, os, pathlib, sys
from unittest.mock import MagicMock
from botocore.exceptions import ClientError

os.environ.update({'AWS_ACCESS_KEY_ID':'test','AWS_SECRET_ACCESS_KEY':'test',
                   'AWS_DEFAULT_REGION':'us-east-1','AWS_EC2_METADATA_DISABLED':'true',
                   'UPLOAD_BUCKET':'example-bucket','JOURNAL_TABLE':'example-table',
                   'ELEVENLABS_SECRET_ARN':'test-secret','GEMINI_SECRET_ARN':'test-secret'})
root=pathlib.Path(__file__).parent/'lambda'
sys.path.insert(0,str(root))
def load(name):
    spec=importlib.util.spec_from_file_location(name,root/(name+'.py'))
    mod=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

sign=load('auth_signer')
result=load('auth_results')
worker=load('queue_worker')
sub='user-abc'
uid='1fbf8320-5eae-4614-acb1-e5d31306db15'
claims={'sub':sub,'token_use':'access'}
event={'requestContext':{'authorizer':{'jwt':{'claims':claims}}}}

def test_signer():
    sign.table=MagicMock();sign.s3=MagicMock()
    sign.s3.generate_presigned_post.return_value={'url':'https://example.amazonaws.com','fields':{'key':'test'}}
    reply=sign.handler({**event,'body':json.dumps({'filename':'clip.mp4','content_type':'video/mp4','size':2048})},None)
    obj=json.loads(reply['body'])
    assert reply['statusCode']==200 and obj['object_key'].startswith('uploads/user-abc/')
    assert sign.table.put_item.call_args.kwargs['Item']['userId']==sub
    assert sign.table.put_item.call_args.kwargs['Item']['status']=='awaiting_upload'
    assert sign.handler({'body':'{}'},None)['statusCode']==401
    print('PASS authenticated signer ownership and v3 response')

def test_results_isolation():
    result.table=MagicMock();result.s3=MagicMock()
    result.table.get_item.return_value={'Item':{'uploadId':uid,'userId':'another-user','status':'completed'}}
    r=result.handler({**event,'routeKey':'GET /uploads/{upload_id}/result', 'pathParameters':{'upload_id':uid}},None)
    assert r['statusCode']==404 and not result.s3.get_object.called
    result.table.get_item.return_value={'Item':{'uploadId':uid,'userId':sub,'status':'completed',
                                                 'analysis':{'sentiment':'positive','emotions':[],'themes':[],'summary':'ok'}}}
    r=result.handler({**event,'routeKey':'GET /uploads/{upload_id}/result', 'pathParameters':{'upload_id':uid}},None)
    assert r['statusCode']==200 and json.loads(r['body'])['status']=='completed'
    print('PASS owner-scoped results and no cross-user S3 access')

def test_history_scope():
    result.table=MagicMock()
    result.table.query.return_value={'Items':[{'uploadId':uid,'createdAt':'2026-11-13T20:00:00Z','status':'completed','analysis':{'sentiment':'neutral'}}]}
    r=result.handler({**event,'routeKey':'GET /journals'},None)
    assert r['statusCode']==200
    assert result.table.query.call_args.kwargs['IndexName']=='userId-createdAt-index'
    assert json.loads(r['body'])['journals'][0]['upload_id']==uid
    assert result.handler({**event,'routeKey':'GET /journals','queryStringParameters':{'next_token':'!!!'}},None)['statusCode']==400
    print('PASS user-partition history query and invalid cursor rejection')

def test_sqs_worker():
    key=f'uploads/{sub}/{uid}.mp4'
    worker.table=MagicMock();worker.s3=MagicMock()
    worker.table.get_item.return_value={'Item':{'uploadId':uid,'userId':sub,'videoKey':key,'status':'awaiting_upload'}}
    worker.s3.get_object.side_effect=[ClientError({'Error':{'Code':'NoSuchKey','Message':'not found'}},'GetObject'),
                                      {'Body':io.BytesIO(b'\0\0\0\x18ftypisom\0\0\0\0')}]
    worker.s3.head_object.return_value={'ContentLength':16,'ContentType':'video/mp4'}
    worker.provider.transcribe_mp4=lambda v:'Today I am happy.'
    worker.provider.analyze_transcript=lambda t:{'sentiment':'positive','emotions':['joy'],'themes':['day'],'summary':'happy'}
    body={'Records':[{'eventSource':'aws:s3','s3':{'bucket':{'name':'example-bucket'},'object':{'key':key}}}]}
    sqs={'Records':[{'eventSource':'aws:sqs','messageId':'m1','body':json.dumps(body)}]}
    r=worker.handler(sqs,None)
    assert r=={'batchItemFailures':[]},r
    assert worker.table.update_item.call_count==3
    assert worker.s3.put_object.call_count==1
    print('PASS SQS nested event -> worker -> transcript cache -> Gemini -> DynamoDB')

test_signer();test_results_isolation();test_history_scope();test_sqs_worker()
