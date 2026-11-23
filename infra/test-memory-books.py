"""Offline memory book ownership, revision, approval, and namespace regressions."""
import importlib.util
import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

os.environ.update({'AWS_EC2_METADATA_DISABLED':'true','AWS_ACCESS_KEY_ID':'test','AWS_SECRET_ACCESS_KEY':'test',
                   'AWS_DEFAULT_REGION':'us-east-1','UPLOAD_BUCKET':'test','JOURNAL_TABLE':'test'})
root=Path(__file__).parent/'lambda'; sys.path.insert(0,str(root))
spec=importlib.util.spec_from_file_location('memory_results',root/'auth_results.py')
api=importlib.util.module_from_spec(spec); spec.loader.exec_module(api)
owner='owner-1'; book_id='12345678-1234-1234-1234-123456789abc'
api.table=MagicMock(); api.table.get_item.return_value={}
book={'id':book_id,'title':'My book','subtitle':'','theme':'Classic diary','texture':'Linen','fontSize':17,'revision':0,'entries':[]}
catalog=json.loads((root/'memory-book-templates.json').read_text(encoding='utf-8'))
assert {'Minimalist','Vintage','Scrapbook','Classic diary','Editorial'}.issubset({item['legacyTheme'] for item in catalog['templates']})
notebook=next(item for item in catalog['templates'] if item['id']=='notebook-v1')
assert notebook['name']=='Notebook' and notebook['legacyTheme']=='Notebook'
assert notebook['stickers']==['sunrise','leaf','spark','heart','flower']
assert [slot['kind'] for slot in notebook['slots']]==['date','title','image-or-text','narrative','quote','annotation','stickers','writing']
assert len(catalog['templates']) >= 5
assert all(item['id'].endswith(f"-v{item['templateVersion']}") for item in catalog['templates'])
book['templateId']='daily-notes-v1'
event={'pathParameters':{'book_id':book_id},'body':json.dumps(book)}
response=api.handle_put_memory_book(event,owner)
assert response['statusCode']==200
assert api.table.put_item.call_args.kwargs['Item']['userId']=='memory-book#owner-1'
assert api.table.put_item.call_args.kwargs['Item']['book']['templateId']=='daily-notes-v1'
assert 'ExpressionAttributeValues' not in api.table.put_item.call_args.kwargs

api.table.get_item.return_value={'Item':{'uploadId':api.memory_book_key(owner,book_id),'userId':f'memory-book#{owner}','revision':4,'createdAt':'now','book':{}}}
response=api.handle_put_memory_book(event,owner)
assert response['statusCode']==409

api.table.query.return_value={'Items':[{'book':{'id':book_id}}], 'LastEvaluatedKey':None}
api.handle_memory_books({},owner)
assert api.table.query.call_args.kwargs['KeyConditionExpression'].get_expression()['values'][1]=='memory-book#owner-1'

api.MEMORY_RENDERER_ARN='renderer'
api.table.get_item.return_value={'Item':{'uploadId':api.memory_book_key(owner,book_id),'userId':f'memory-book#{owner}','recordType':'memory-book','book':{**book,'revision':2,'entries':[{'id':'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','approved':False,'included':True}]}}}
assert api.handle_memory_export({'pathParameters':{'book_id':book_id}},owner)['statusCode']==409
api.MEMORY_RENDERER_ARN='renderer'
api.table.get_item.side_effect=[
    {'Item':{'userId':f'memory-book#{owner}','recordType':'memory-book','book':{**book,'revision':2}}},
    {'Item':{'userId':f'memory-book#{owner}','status':'failed','bookSnapshot':{**book,'revision':2}}},
]
api.lambda_client.invoke=MagicMock()
retried=api.handle_memory_export_retry({'pathParameters':{'book_id':book_id,'revision':'2'}},owner)
assert retried['statusCode']==202
assert api.table.update_item.call_args.kwargs['ConditionExpression']=='#s = :failed AND userId = :owner'
assert json.loads(api.lambda_client.invoke.call_args.kwargs['Payload'])=={'owner':owner,'book_id':book_id,'revision':2}
routes=(Path(__file__).parent/'deploy-memory-book-v1.sh').read_text()
dockerfile=(root/'memory-renderer'/'Dockerfile').read_text()
assert "'memory-book-templates.json'" in routes
assert 'COPY memory-book-templates.json' in dockerfile
dispatch=(root/'auth_results.py').read_text()
assert "POST /memory-books/{book_id}/exports/{revision}/retry" in routes
for route in ('GET /memory-books', 'GET /memory-narratives', 'PUT /memory-books/{book_id}', 'POST /memory-books/{book_id}/memories/{upload_id}/rewrite', 'POST /memory-books/{book_id}/reflections', 'POST /memory-books/{book_id}/exports', 'GET /memory-books/{book_id}/exports/{revision}', 'POST /memory-photos', 'GET /memory-photos', 'GET /memory-photos/{photo_id}', 'POST /memory-photos/{photo_id}/finalize', 'GET /memory-preferences', 'PUT /memory-preferences', 'GET /journals/{upload_id}/page', 'PUT /journals/{upload_id}/page', 'GET /journal-days/{day}', 'PUT /journal-days/{day}'):
    assert route in routes, route
    assert route in dispatch, route
assert 'POST /memory-books/{book_id}/exports/{revision}/retry' in dispatch
assert 'DELETE /memory-books/{book_id}' in routes and 'DELETE /memory-books/{book_id}' in dispatch

# A tombstone is owner scoped and retries cleanup without deleting shared photos or narratives.
api.table = MagicMock()
api.s3 = MagicMock()
api.s3.list_object_versions.return_value = {'IsTruncated': False}
api.table.get_item.return_value={'Item':{'userId':f'memory-book#{owner}','recordType':'memory-book','revision':2,'book':book}}
api.table.update_item.return_value={'Attributes':{'revision':2}}
deleted=api.handle_delete_memory_book({'pathParameters':{'book_id':book_id}},owner)
assert deleted['statusCode']==200
update=api.table.update_item.call_args.kwargs
assert "REMOVE book" in update['UpdateExpression'] and 'recordType = :book_type' in update['ConditionExpression']
assert api.s3.list_object_versions.call_args.kwargs['Prefix']==f'exports/{owner}/{book_id}/'
batch=api.table.batch_writer.return_value.__enter__.return_value
assert [call.kwargs['Key']['uploadId'] for call in batch.delete_item.call_args_list]==[
    f'memory-export#{owner}#{book_id}#0',f'memory-export#{owner}#{book_id}#1',f'memory-export#{owner}#{book_id}#2']
api.table.get_item.return_value={'Item':{'userId':'memory-book#someone-else','recordType':'memory-book','book':book}}
api.table.update_item.reset_mock()
api.s3.reset_mock()
foreign=api.handle_delete_memory_book({'pathParameters':{'book_id':book_id}},owner)
assert foreign['statusCode']==404 and not api.table.update_item.called and not api.s3.list_object_versions.called
api.table = MagicMock()
api.s3 = MagicMock()
api.s3.list_object_versions.return_value = {'IsTruncated': False}
tombstone={'userId':f'memory-book#{owner}','recordType':'memory-book-deleted','status':'deleted','revision':2}
api.table.get_item.side_effect=[{'Item':tombstone},{'Item':tombstone}]
api.table.update_item.side_effect=api.ClientError({'Error':{'Code':'ConditionalCheckFailedException'}},'UpdateItem')
retried_delete=api.handle_delete_memory_book({'pathParameters':{'book_id':book_id}},owner)
assert retried_delete['statusCode']==200 and api.table.update_item.call_count==1
assert api.s3.list_object_versions.call_args.kwargs['Prefix']==f'exports/{owner}/{book_id}/'
assert "'Action':'s3:PutObject','Resource':f'arn:aws:s3:::{sys.argv[4]}/uploads/*/memory-photos/*'" in routes
assert "'Action':'s3:ListBucketVersions'" in routes and "'s3:DeleteObjectVersion'" in routes
# Saved PDF listings are per owner/book and never expose raw private S3 object keys.
api.table = MagicMock()
api.table.get_item.return_value = {'Item': {'userId': f'memory-book#{owner}', 'recordType': 'memory-book', 'book': book}}
api.table.query.return_value = {'Items': [
    {'userId': f'memory-book#{owner}', 'recordType': 'memory-export', 'bookId': book_id, 'revision': 2, 'status': 'complete', 'createdAt': '2026-11-22T01:00:00Z', 'objectKey': 'private/key.pdf'},
    {'userId': f'memory-book#{owner}', 'recordType': 'memory-export', 'bookId': 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'revision': 4, 'status': 'complete'},
    {'userId': f'memory-book#other', 'recordType': 'memory-export', 'bookId': book_id, 'revision': 9, 'status': 'complete'},
], 'LastEvaluatedKey': None}
listing = api.handle_memory_export_history({'pathParameters': {'book_id': book_id}}, owner)
assert listing['statusCode'] == 200
assert json.loads(listing['body'])['exports'] == [{'revision': 2, 'status': 'complete', 'created_at': '2026-11-22T01:00:00Z'}]
assert api.table.query.call_args.kwargs['KeyConditionExpression'].get_expression()['values'][1] == f'memory-book#{owner}'
api.table.get_item.return_value = {'Item': {'userId': 'memory-book#other', 'recordType': 'memory-book', 'book': book}}
api.table.query.reset_mock()
assert api.handle_memory_export_history({'pathParameters': {'book_id': book_id}}, owner)['statusCode'] == 404
assert not api.table.query.called
assert 'GET /memory-books/{book_id}/exports' in routes and 'GET /memory-books/{book_id}/exports' in dispatch
print('PASS namespaced owner query, revision conflicts, empty Dynamo values, and approval gate')
print('PASS failed PDF retries stay bound to the original owner, book, revision snapshot, and JWT route')
print('PASS owner-scoped deletion tombstone, deterministic job cleanup, and private export-prefix sweep')
