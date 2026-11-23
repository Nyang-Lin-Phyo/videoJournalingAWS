"""Offline owner, revision, source-text, and export snapshot tests for journal pages."""
import importlib.util
import json
import os
import sys
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock, patch

os.environ.update({'AWS_EC2_METADATA_DISABLED':'true','AWS_ACCESS_KEY_ID':'test','AWS_SECRET_ACCESS_KEY':'test',
                   'AWS_DEFAULT_REGION':'us-east-1','UPLOAD_BUCKET':'test','JOURNAL_TABLE':'test'})
root=Path(__file__).parent/'lambda'; sys.path.insert(0,str(root))
spec=importlib.util.spec_from_file_location('journal_page_results',root/'auth_results.py')
api=importlib.util.module_from_spec(spec); spec.loader.exec_module(api)
owner='page-owner'; upload_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
row={'uploadId':upload_id,'userId':owner,'status':'completed','sourceType':'text','createdAt':'2026-11-20T12:00:00.000Z',
     'title':'Typed memory','transcriptKey':f'transcripts/{owner}/{upload_id}.txt'}


def payload(response):
    return json.loads(response['body'])


def test_text_journal_preserves_exact_source_and_exposes_history_fields():
    api.table=MagicMock(); api.s3=MagicMock()
    api.s3.put_object.return_value={}
    text='First paragraph.\r\n\r\nSecond paragraph, exact.'
    response=api.handle_create_text_journal({'body':json.dumps({'text':text})},owner)
    assert response['statusCode']==201
    transaction=api.table.meta.client.transact_write_items.call_args.kwargs['TransactItems']
    saved=transaction[1]['Put']['Item']
    assert saved['sourceType']=='text' and saved['status']=='completed' and saved['title']=='Journal entry'
    assert api.s3.put_object.call_args.kwargs['Body']==text.encode('utf-8')
    assert saved['transcriptKey']==f"transcripts/{owner}/{saved['uploadId']}.txt"
    assert transaction[0]['ConditionCheck']['Key']=={'uploadId':f'account#{owner}'}


def test_virtual_page_splits_paragraphs_deterministically_without_losing_source():
    source='First line.\r\n\r\n' + ('A long single run. ' * 130)
    api.table=MagicMock(); api.table.get_item.return_value={}
    with patch.object(api,'find_journal',return_value=row), patch.object(api,'saved_transcript',return_value=(source,None)):
        first=payload(api.handle_get_journal_page(upload_id,owner))
        second=payload(api.handle_get_journal_page(upload_id,owner))
    assert first['revision']==0 and first['originalText']==source
    assert ''.join(block['text'] for block in first['blocks'])==source
    assert [b['id'] for b in first['blocks']]==[b['id'] for b in second['blocks']]
    assert len(first['blocks'])>2


def test_saved_page_transaction_checks_photo_owner_and_stale_revision():
    api.table=MagicMock()
    with patch.object(api,'find_journal',return_value=row), patch.object(api,'saved_transcript',return_value=('Original text.',None)):
        bad_photo={'revision':0,'highlightPage':False,'blocks':[{'id':'img','kind':'image','width':'half','photoId':upload_id}]}
        with patch.object(api,'valid_memory_photo',return_value=False):
            assert api.handle_put_journal_page({'body':json.dumps(bad_photo)},upload_id,owner)['statusCode']==400

        good={'revision':0,'highlightPage':True,'blocks':[{'id':'text-1','kind':'text','width':'wide','text':'Original and edited text.','highlight':'edited'}]}
        api.table.get_item.return_value={}
        saved=api.handle_put_journal_page({'body':json.dumps(good)},upload_id,owner)
        assert saved['statusCode']==200 and payload(saved)['revision']==1
        transaction=api.table.meta.client.transact_write_items.call_args.kwargs['TransactItems']
        version=next(item['Put']['Item'] for item in transaction if item.get('Put',{}).get('Item',{}).get('recordType')=='journal-page-version')
        assert version['blocks'][0]['highlight']=='edited' and version['highlightPage'] is True
        assert any(item.get('ConditionCheck',{}).get('Key')=={'uploadId':upload_id} for item in transaction)

        api.table.get_item.return_value={'Item':{'userId':f'memory-book#{owner}','recordType':'journal-page-latest','journalId':upload_id,'revision':1}}
        stale=dict(good,revision=0)
        result=api.handle_put_journal_page({'body':json.dumps(stale)},upload_id,owner)
        assert result['statusCode']==409


def test_export_pins_decimal_dynamodb_page_revision_not_latest():
    book={'contentMode':'journal-pages','revision':7,'includeHighlights':True,'entries':[{'id':upload_id,'title':'Old title','date':row['createdAt'],'included':True}]}
    api.table=MagicMock()
    api.table.get_item.side_effect=[
        {'Item':{'userId':f'memory-book#{owner}','recordType':'journal-page-latest','journalId':upload_id,'revision':Decimal('3')}},
        {'Item':{'userId':f'memory-book#{owner}','recordType':'journal-page-version','journalId':upload_id,'revision':Decimal('3'),'blocks':[]}},
    ]
    with patch.object(api,'find_journal',return_value=row):
        snapshot,entries,error,status=api.make_journal_page_export_snapshot(owner,book)
    assert error is None and status is None
    assert snapshot['pageRefs']==[{'journalId':upload_id,'pageRevision':3}]
    assert snapshot['entries']==entries==[{'id':upload_id,'title':'Typed memory','date':row['createdAt'],'included':True}]


def test_journal_delete_cleans_page_pointer_and_all_immutable_revisions():
    api.table=MagicMock()
    pointer={'userId':f'memory-book#{owner}','recordType':'journal-page-latest','journalId':upload_id,'revision':2}
    v1={'userId':f'memory-book#{owner}','recordType':'journal-page-version','journalId':upload_id}
    v2=dict(v1)
    api.table.get_item.side_effect=[{'Item':pointer},{'Item':v1},{'Item':v2}]
    api.delete_journal_page_records(owner,upload_id)
    keys=[call.kwargs['Key']['uploadId'] for call in api.table.delete_item.call_args_list]
    assert keys==[f'journal-page-version#{owner}#{upload_id}#1',f'journal-page-version#{owner}#{upload_id}#2',f'journal-page#{owner}#{upload_id}']


if __name__=='__main__':
    test_text_journal_preserves_exact_source_and_exposes_history_fields()
    test_virtual_page_splits_paragraphs_deterministically_without_losing_source()
    test_saved_page_transaction_checks_photo_owner_and_stale_revision()
    test_export_pins_decimal_dynamodb_page_revision_not_latest()
    test_journal_delete_cleans_page_pointer_and_all_immutable_revisions()
    print('PASS exact text source, virtual page layout, owner-checked immutable revisions, export pinning, and journal deletion cleanup')
