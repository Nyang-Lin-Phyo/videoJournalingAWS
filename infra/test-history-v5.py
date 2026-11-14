#!/usr/bin/env python3
"""Offline tests for v5, no AWS credentials or provider requests needed."""
import importlib.util
import json
import os
from pathlib import Path
from uuid import UUID

from botocore.exceptions import ClientError

os.environ.update({
    'AWS_EC2_METADATA_DISABLED': 'true', 'AWS_ACCESS_KEY_ID': 'fake',
    'AWS_SECRET_ACCESS_KEY': 'fake', 'AWS_DEFAULT_REGION': 'us-east-1',
    'UPLOAD_BUCKET': 'test-private-videos', 'JOURNAL_TABLE': 'test-journals',
})
ROOT = Path(__file__).resolve().parent / 'lambda'


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f'{name}.py')
    obj = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(obj)
    return obj


signer = load('auth_signer')
results = load('auth_results')


def condition_failed():
    return ClientError({'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'Condition failed'}}, 'UpdateItem')


class FakeTable:
    def __init__(self):
        self.rows = {}
        self.calls = []

    def put_item(self, Item, **kwargs):
        self.rows[Item['uploadId']] = Item

    def get_item(self, Key, **kwargs):
        row = self.rows.get(Key['uploadId'])
        return {'Item': dict(row)} if row else {}

    def query(self, **kwargs):
        return {'Items': [dict(x) for x in self.rows.values()], 'LastEvaluatedKey': None}

    def update_item(self, Key, **kwargs):
        row = self.rows.get(Key['uploadId'])
        values = kwargs['ExpressionAttributeValues']
        owner = values.get(':owner')
        if not row or (owner is not None and row['userId'] != owner):
            raise condition_failed()
        statement = kwargs['UpdateExpression']
        if 'title = :title' in statement:
            if row['status'] == 'deleting':
                raise condition_failed()
            row['title'] = values[':title']
        elif 'deleteRequestedAt' in statement:
            if row['status'] not in ('completed','failed'):
                raise condition_failed()
            row['status'] = 'deleting'
            row['deleteRequestedAt'] = values[':timestamp']
        else:
            raise AssertionError('Unexpected update expression '+statement)
        return {'Attributes':dict(row)}

    def delete_item(self, Key, **kwargs):
        row = self.rows.get(Key['uploadId'])
        vals = kwargs.get('ExpressionAttributeValues') or {}
        if row and vals.get(':owner') and (row['userId'] != vals[':owner'] or row['status'] != 'deleting'):
            raise condition_failed()
        self.rows.pop(Key['uploadId'],None)


class FakeS3:
    def __init__(self):
        self.deleted=[]
        self.versioning=''
        self.fail_delete=False

    def generate_presigned_post(self, Bucket, Key, **kwargs):
        return {'url':'https://test-bucket.s3.amazonaws.com/', 'fields':{'key':Key,'policy':'fake'}}

    def generate_presigned_url(self, ClientMethod, Params, ExpiresIn):
        assert ClientMethod == 'get_object' and ExpiresIn == 900
        return f'https://test-bucket.s3.amazonaws.com/{Params["Key"]}?sig=fake'

    def get_bucket_versioning(self, **kwargs):
        return {'Status':self.versioning} if self.versioning else {}

    def delete_objects(self, Bucket, Delete):
        self.deleted.extend(obj['Key'] for obj in Delete['Objects'])
        return {'Errors':[{'Key':'mock','Code':'TestFailure'}]} if self.fail_delete else {'Deleted':Delete['Objects']}


def event(route, owner='userA', upload_id='', body=None):
    return {'requestContext': {'authorizer': {'jwt': {'claims': {'token_use':'access','sub':owner}}}},
            'routeKey':route,'pathParameters':{'upload_id':upload_id},
            'body':json.dumps(body) if body is not None else None}


def run():
    table=FakeTable(); storage=FakeS3()
    signer.table=table; signer.s3=storage
    results.table=table; results.s3=storage

    base={'filename':'moment.mp4','content_type':'video/mp4','size':2048,'title':'A wonderful day'}
    resp=signer.handler(event('POST /uploads',body=base),None)
    assert resp['statusCode']==200,resp
    uid=json.loads(resp['body'])['upload_id']; UUID(uid)
    assert table.rows[uid]['title']=='A wonderful day'
    assert signer.handler(event('POST /uploads',body={**base,'title':' '}),None)['statusCode']==400
    print('PASS new journal requires a validated title')

    table.rows[uid]['status']='completed'
    del table.rows[uid]['title']
    for route in ('GET /uploads/{upload_id}/result','GET /uploads/{upload_id}/video-url'):
        assert results.handler(event(route, owner='userB',upload_id=uid),None)['statusCode']==404
    r=results.handler(event('GET /uploads/{upload_id}/result',upload_id=uid),None)
    assert json.loads(r['body'])['title']=='Untitled'
    assert 'transcript' not in json.loads(r['body'])
    r=results.handler(event('GET /journals'),None)
    assert json.loads(r['body'])['journals'][0]['title']=='Untitled'
    print('PASS legacy untitled journal, owner isolation, no transcript in response')

    assert results.handler(event('PATCH /journals/{upload_id}',owner='userB',upload_id=uid,body={'title':'Private'}),None)['statusCode']==404
    assert results.handler(event('PATCH /journals/{upload_id}',upload_id=uid,body={'title':' '}),None)['statusCode']==400
    assert results.handler(event('PATCH /journals/{upload_id}',upload_id=uid,body={'title':'My new title'}),None)['statusCode']==200
    assert table.rows[uid]['title']=='My new title'
    print('PASS only owner can rename')

    assert results.handler(event('DELETE /journals/{upload_id}',owner='userB',upload_id=uid),None)['statusCode']==404
    storage.versioning='Enabled'
    assert results.handler(event('DELETE /journals/{upload_id}',upload_id=uid),None)['statusCode']==409
    storage.versioning=''
    table.rows[uid]['status']='analyzing'
    assert results.handler(event('DELETE /journals/{upload_id}',upload_id=uid),None)['statusCode']==409
    table.rows[uid]['status']='completed'
    storage.fail_delete=True
    assert results.handler(event('DELETE /journals/{upload_id}',upload_id=uid),None)['statusCode']==503
    assert table.rows[uid]['status']=='deleting'
    assert results.handler(event('PATCH /journals/{upload_id}',upload_id=uid,body={'title':'oops'}),None)['statusCode']==404
    storage.fail_delete=False
    assert results.handler(event('DELETE /journals/{upload_id}',upload_id=uid),None)['statusCode']==204
    assert uid not in table.rows
    deleted=set(storage.deleted)
    assert f'uploads/userA/{uid}.mp4' in deleted
    assert f'transcripts/userA/{uid}.txt' in deleted
    assert f'results/{uid}.json' in deleted
    print('PASS delete blocks active jobs, refuses versioned bucket, retries cleanup and erases metadata/objects')


if __name__=='__main__':
    run()
