"""Quick Journal PDF date, ownership, retry, escaping, and template regressions."""
import json, os, sys
import types
from pathlib import Path
from unittest.mock import MagicMock

os.environ.update(AWS_EC2_METADATA_DISABLED='true',AWS_ACCESS_KEY_ID='test',AWS_SECRET_ACCESS_KEY='test',AWS_DEFAULT_REGION='us-east-1',UPLOAD_BUCKET='test',JOURNAL_TABLE='test')
root=Path(__file__).parent/'lambda'; sys.path.insert(0,str(root))
fake_weasy=types.ModuleType('weasyprint'); fake_weasy.HTML=MagicMock(); sys.modules['weasyprint']=fake_weasy
fake_urls=types.ModuleType('weasyprint.urls')
class FakeURLFetcher:
    def __init__(self, **kwargs): self._fail_on_errors=kwargs.get('fail_on_errors',False)
class FakeURLFetcherResponse:
    def __init__(self,url,body,headers): self.url,self.body,self.headers=url,body,headers
fake_urls.URLFetcher=FakeURLFetcher; fake_urls.URLFetcherResponse=FakeURLFetcherResponse; sys.modules['weasyprint.urls']=fake_urls
from memory_export_worker import render_quick_html, quick_chronological
import importlib.util
spec=importlib.util.spec_from_file_location('quick_api',root/'auth_results.py'); api=importlib.util.module_from_spec(spec); spec.loader.exec_module(api)

snapshot={'startDate':'2026-03-01','endDate':'2026-03-31','timezone':'America/New_York','template':'Minimalist'}
entries=[{'title':'Morning <note>','date':'2026-03-08T04:30:00Z','text':'I wrote <this> & that.'}]
html=render_quick_html(snapshot,entries)
assert '2026-03-07' in html and '&lt;this&gt; &amp; that.' in html and '<this>' not in html
ordered=quick_chronological([{'id':'b','date':'2026-03-08T05:00:00Z'},{'id':'z','date':'2026-03-08T04:30:00Z'},{'id':'a','date':'2026-03-08T05:00:00Z'}])
assert [item['id'] for item in ordered]==['z','a','b']
rendered={name:render_quick_html({**snapshot,'template':name},entries) for name in ('Minimalist','Vintage','Scrapbook','Classic diary','Editorial')}
assert len(set(rendered.values()))==5
assert 'background-image' in rendered['Vintage'] and 'dashed' in rendered['Scrapbook'] and 'border-left' in rendered['Classic diary'] and 'border-left' in rendered['Editorial']

owner='quick-owner'; rid='12345678-1234-1234-1234-123456789abc'; api.MEMORY_RENDERER_ARN='renderer'; api.table=MagicMock(); api.lambda_client.invoke=MagicMock()
api.table.get_item.side_effect=[{}, {}, {'Item':{'userId':f'memory-book#{owner}','recordType':'quick-export','status':'queued'}}]
api.table.query.return_value={'Items':[
 {'uploadId':'b','userId':owner,'status':'completed','createdAt':'2026-03-08T05:00:00Z','transcriptKey':'transcripts/quick-owner/b.txt'},
 {'uploadId':'a','userId':owner,'status':'completed','createdAt':'2026-03-08T04:30:00Z','transcriptKey':'transcripts/quick-owner/a.txt'},
 {'uploadId':'outside','userId':owner,'status':'completed','createdAt':'2026-04-01T05:00:00Z','transcriptKey':'transcripts/quick-owner/outside.txt'}], 'LastEvaluatedKey':None}
event={'body':json.dumps({'start_date':'2026-03-01','end_date':'2026-03-31','timezone':'America/New_York','template':'Editorial','request_key':rid})}
assert api.handle_quick_export({'body':json.dumps({'start_date':'2026-04-01','end_date':'2026-03-01','timezone':'UTC','template':'Minimalist','request_key':rid})},owner)['statusCode']==400
response=api.handle_quick_export(event,owner); assert response['statusCode']==202
snap=api.table.put_item.call_args.kwargs['Item']['snapshot']; assert snap['journalIds']==['a','b']
assert set(snap)=={'journalIds','startDate','endDate','timezone','template'} and snap['template']=='Editorial'
assert json.loads(api.lambda_client.invoke.call_args.kwargs['Payload'])['job_id']==rid

# On the spring DST transition, 05:00Z is midnight on March 8 in New York;
# the 04:30Z journal remains March 7 locally and is excluded from March 8.
dst_id='22345678-1234-1234-1234-123456789abc'
api.table.get_item.side_effect=[{}, {}, {'Item':{'userId':f'memory-book#{owner}','recordType':'quick-export','status':'queued'}}]
api.table.query.return_value={'Items':[{'uploadId':'a','userId':owner,'status':'completed','createdAt':'2026-03-08T04:30:00Z','transcriptKey':'transcripts/quick-owner/a.txt'}, {'uploadId':'b','userId':owner,'status':'completed','createdAt':'2026-03-08T05:00:00Z','transcriptKey':'transcripts/quick-owner/b.txt'}], 'LastEvaluatedKey':None}
dst_event={'body':json.dumps({'start_date':'2026-03-08','end_date':'2026-03-08','timezone':'America/New_York','template':'Minimalist','request_key':dst_id})}
assert api.handle_quick_export(dst_event,owner)['statusCode']==202
assert api.table.put_item.call_args.kwargs['Item']['snapshot']['journalIds']==['b']

# Repeating a submit with the same settings returns the owner-scoped job without
# rebuilding its snapshot; changing settings under that key is rejected.
api.table.get_item.side_effect=[{'Item':{'userId':f'memory-book#{owner}','recordType':'quick-export','status':'queued','snapshot':snap}}]
api.table.get_item.return_value={}
put_count=api.table.put_item.call_count
assert api.handle_quick_export(event,owner)['statusCode']==202
assert api.table.put_item.call_count==put_count
api.table.get_item.side_effect=[{'Item':{'userId':f'memory-book#{owner}','recordType':'quick-export','status':'queued','snapshot':snap}}]
assert api.handle_quick_export({'body':json.dumps({**json.loads(event['body']),'template':'Vintage'})},owner)['statusCode']==409

# Failed jobs retry in place under the same request key; empty result sets do
# not create jobs.
api.table.get_item.side_effect=[{'Item':{'userId':f'memory-book#{owner}','recordType':'quick-export','status':'failed','snapshot':snap}}, {'Item':{'userId':f'memory-book#{owner}','recordType':'quick-export','status':'queued','snapshot':snap}}]
assert api.handle_quick_export(event,owner)['statusCode']==202
assert api.table.update_item.call_args.kwargs['ExpressionAttributeValues'][':o']==f'memory-book#{owner}'
api.table.get_item.side_effect=[{}, {}]; api.table.query.return_value={'Items':[],'LastEvaluatedKey':None}
empty_event={'body':json.dumps({'start_date':'2026-03-01','end_date':'2026-03-31','timezone':'UTC','template':'Minimalist','request_key':'32345678-1234-1234-1234-123456789abc'})}
assert api.handle_quick_export(empty_event,owner)['statusCode']==400

api.table.get_item.side_effect=[{}, {'Item':{'userId':'memory-book#another-owner','recordType':'quick-export'}}]; api.table.get_item.return_value={}
assert api.handle_quick_export_status({'pathParameters':{'job_id':rid}},owner)['statusCode']==404
print('PASS local inclusive dates including DST boundary, owner isolation, ID-only snapshot, stable submit, and all five visible template presets')
