#!/usr/bin/env python3
"""Offline check: the signer produces correctly marshalled DynamoDB transaction values."""
import importlib.util
import json
import os
from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock

os.environ.update({
    'AWS_EC2_METADATA_DISABLED': 'true',
    'AWS_ACCESS_KEY_ID': 'fake',
    'AWS_SECRET_ACCESS_KEY': 'fake',
    'AWS_DEFAULT_REGION': 'us-east-1',
    'UPLOAD_BUCKET': 'private-test-bucket',
    'JOURNAL_TABLE': 'test-journals',
})
import boto3
from botocore.awsrequest import AWSResponse

root = Path(__file__).parent / 'lambda' / 'auth_signer.py'
spec = importlib.util.spec_from_file_location('verify_signer_wire', root)
signer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signer)

real_resource_table = boto3.resource('dynamodb', region_name='us-east-1').Table('test-journals')
signer.table = real_resource_table
signer.s3 = MagicMock()
signer.s3.generate_presigned_post.return_value = {
    'url': 'https://example.invalid',
    'fields': {'key': 'fake'},
}
captured = []

def intercept(model, params, **kwargs):
    captured.append(json.loads(params['body']))
    response = AWSResponse(
        'https://example.invalid', 200, {'content-type': 'application/x-amz-json-1.0'},
        BytesIO(b'{}'),
    )
    return response, {}

real_resource_table.meta.client.meta.events.register(
    'before-call.dynamodb.TransactWriteItems', intercept
)
event = {
    'requestContext': {'authorizer': {'jwt': {'claims': {
        'sub': 'a-valid-test-sub', 'token_use': 'access',
    }}}},
    'body': json.dumps({
        'filename': 'sample.mp4', 'content_type': 'video/mp4',
        'size': 1234, 'title': 'Test journal',
    }),
}
result = signer.handler(event, None)
assert result['statusCode'] == 200, result
assert len(captured) == 1
check, put = captured[0]['TransactItems']
assert check['ConditionCheck']['Key'] == {'uploadId': {'S': 'account#a-valid-test-sub'}}
assert put['Put']['Item']['title'] == {'S': 'Test journal'}
assert put['Put']['Item']['size'] == {'N': '1234'}
assert put['Put']['Item']['uploadId']['S'] == json.loads(result['body'])['upload_id']
print('PASS DynamoDB resource transaction values are encoded once, not twice')
