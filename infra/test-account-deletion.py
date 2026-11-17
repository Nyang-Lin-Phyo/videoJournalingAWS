"""Offline tests for account deletion; no AWS credentials or provider requests needed."""
import importlib.util
import json
import os
import time
from pathlib import Path
from unittest.mock import patch

from botocore.exceptions import ClientError

os.environ.update({
    'AWS_EC2_METADATA_DISABLED': 'true',
    'AWS_ACCESS_KEY_ID': 'fake',
    'AWS_SECRET_ACCESS_KEY': 'fake',
    'AWS_DEFAULT_REGION': 'us-east-1',
    'UPLOAD_BUCKET': 'test-private-videos',
    'JOURNAL_TABLE': 'test-journals',
    'USER_POOL_ID': 'test-pool',
})

spec = importlib.util.spec_from_file_location(
    'account_delete_results', Path(__file__).parent / 'lambda' / 'auth_results.py'
)
results = importlib.util.module_from_spec(spec)
spec.loader.exec_module(results)


class FakeTable:
    def __init__(self, rows):
        self.rows = {row['uploadId']: dict(row) for row in rows}

    def get_item(self, Key, **kwargs):
        row = self.rows.get(Key['uploadId'])
        return {'Item': dict(row)} if row else {}

    def put_item(self, Item, **kwargs):
        if Item['uploadId'] in self.rows:
            raise RuntimeError('Unexpected duplicate account marker')
        self.rows[Item['uploadId']] = dict(Item)

    def query(self, **kwargs):
        owner = kwargs['KeyConditionExpression'].get_expression()['values'][1]
        rows = sorted(
            (row for row in self.rows.values() if row.get('userId') == owner),
            key=lambda row: row['userCreatedAt'],
        )
        cursor = kwargs.get('ExclusiveStartKey')
        if cursor:
            rows = [row for row in rows if row['uploadId'] > cursor['uploadId']]
        limit = kwargs['Limit']
        page = rows[:limit]
        last_key = None
        if len(rows) > limit:
            last = page[-1]
            last_key = {
                'uploadId': last['uploadId'],
                'userId': owner,
                'userCreatedAt': last['userCreatedAt'],
            }
        return {'Items': [dict(row) for row in page], 'LastEvaluatedKey': last_key}

    def update_item(self, Key, **kwargs):
        row = self.rows[Key['uploadId']]
        names = kwargs['ExpressionAttributeNames']
        values = kwargs['ExpressionAttributeValues']
        expression = kwargs['UpdateExpression']
        assignments = expression.split(' REMOVE ')[0].removeprefix('SET ').split(', ')
        for assignment in assignments:
            alias, reference = assignment.split(' = ')
            row[names[alias]] = values[reference]
        for alias in expression.split(' REMOVE ')[-1].split(', '):
            if alias in names:
                row.pop(names[alias], None)

    def delete_item(self, Key, **kwargs):
        self.rows.pop(Key['uploadId'], None)


class FakeS3:
    def __init__(self, objects):
        self.versions = {
            key: list(version_ids)
            for key, version_ids in objects.items()
        }
        self.deleted = []

    def list_object_versions(self, Bucket, Prefix, MaxKeys, **kwargs):
        entries = [
            {'Key': key, 'VersionId': version}
            for key, version_ids in sorted(self.versions.items())
            if key.startswith(Prefix)
            for version in version_ids
        ][:MaxKeys]
        return {'Versions': entries, 'DeleteMarkers': [], 'IsTruncated': False}

    def delete_objects(self, Bucket, Delete):
        for item in Delete['Objects']:
            versions = self.versions.get(item['Key'], [])
            if item['VersionId'] in versions:
                versions.remove(item['VersionId'])
            self.deleted.append((item['Key'], item['VersionId']))
        return {'Deleted': Delete['Objects']}


class FakeCognito:
    def __init__(self, owner):
        self.owner = owner
        self.deleted = False

    def list_users(self, UserPoolId, Filter, Limit):
        assert Filter == f'sub = "{self.owner}"'
        assert Limit == 10
        return {'Users': [{
            'Username': 'Google_123',
            'Attributes': [{'Name': 'sub', 'Value': self.owner}],
        }]}

    def admin_get_user(self, UserPoolId, Username):
        if Username != 'Google_123':
            raise ClientError(
                {'Error': {'Code': 'UserNotFoundException', 'Message': 'Not found'}},
                'AdminGetUser',
            )
        return {
            'Username': 'Google_123',
            'UserAttributes': [
                {'Name': 'sub', 'Value': self.owner},
                {'Name': 'email', 'Value': 'journal@example.com'},
            ],
        }

    def admin_delete_user(self, UserPoolId, Username):
        assert Username == 'Google_123'
        self.deleted = True


def event(owner='userA', email='journal@example.com'):
    return {
        'requestContext': {'authorizer': {'jwt': {'claims': {
            'sub': owner, 'token_use': 'access',
        }}}},
        'headers': {'authorization': 'Bearer test-access-token'},
        'routeKey': 'DELETE /account',
        'body': json.dumps({'email': email}),
    }


def run():
    upload_id = 'e56a9a91-2650-4d7f-9f4d-6cecb4b7f511'
    row = {
        'uploadId': upload_id,
        'userId': 'userA',
        'userCreatedAt': '2026-11-16T00:00:00Z#' + upload_id,
        'createdAt': '2026-11-16T00:00:00Z',
        'status': 'completed',
        'videoKey': f'uploads/userA/{upload_id}.mp4',
        'transcriptKey': f'transcripts/userA/{upload_id}.txt',
    }
    objects = {
        f'uploads/userA/{upload_id}.mp4': ['v1', 'v2'],
        f'transcripts/userA/{upload_id}.txt': ['v1'],
        f'results/{upload_id}.json': ['v1'],
        'uploads/userA/orphan.mp4': ['v1'],
        'transcripts/userA/orphan.txt': ['v1'],
    }
    streak = {
        'uploadId': 'streak#userA',
        'recordType': 'streak',
        'points': 14,
        'currentStreak': 3,
    }
    table = FakeTable([row, streak])
    storage = FakeS3(objects)
    cognito = FakeCognito('userA')
    results.table = table
    results.s3 = storage
    results.cognito = cognito

    response = results.handler(event(), None)
    assert response['statusCode'] == 202
    marker = table.rows[results.account_marker_key('userA')]
    assert marker['cleanupPhase'] == 'journals'
    assert not storage.deleted

    now = marker['deleteNotBefore'] + 1
    with patch.object(results.time, 'time', return_value=now):
        response = results.handler(event(), None)
        assert response['statusCode'] == 202
        assert upload_id not in table.rows
        assert not cognito.deleted

        for _ in range(5):
            response = results.handler(event(), None)
            if response['statusCode'] == 204:
                break
            assert response['statusCode'] == 202, response

    assert response['statusCode'] == 204
    assert cognito.deleted
    assert all(not versions for versions in storage.versions.values())
    assert len(storage.deleted) == sum(map(len, objects.values()))
    assert table.rows[results.account_marker_key('userA')]['accountStatus'] == 'deleted'
    assert results.streak_key('userA') not in table.rows
    assert results.handler(event(), None)['statusCode'] == 204
    print('PASS account deletion waits for signed uploads, removes journal and orphaned S3 versions, and deletes only the verified Cognito user')

    active_row = {
        **row,
        'status': 'transcribing',
        'leaseExpiresAt': int(time.time()) + 600,
    }
    active_table = FakeTable([active_row])
    active_storage = FakeS3(objects)
    active_cognito = FakeCognito('userA')
    results.table = active_table
    results.s3 = active_storage
    results.cognito = active_cognito
    started = results.handler(event(), None)
    marker = active_table.rows[results.account_marker_key('userA')]
    with patch.object(results.time, 'time', return_value=marker['deleteNotBefore'] + 1):
        waiting = results.handler(event(), None)
    assert started['statusCode'] == 202
    assert waiting['statusCode'] == 202
    assert json.loads(waiting['body'])['retry_after_seconds'] > 0
    assert active_table.rows[upload_id]['status'] == 'transcribing'
    assert not active_storage.deleted and not active_cognito.deleted
    print('PASS account deletion waits for a live processing lease without deleting active journal data')

    results.table = FakeTable([])
    results.s3 = FakeS3({})
    results.cognito = FakeCognito('userA')
    mismatch = results.handler(event(email='someone-else@example.com'), None)
    assert mismatch['statusCode'] == 404
    assert results.account_marker_key('userA') not in results.table.rows
    assert not results.cognito.deleted
    print('PASS account deletion refuses an email that is not bound to the authenticated Cognito subject')


if __name__ == '__main__':
    run()
