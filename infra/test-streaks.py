"""Offline tests for local-day streaks and point-funded freezes."""
import importlib.util
import json
import os
import sys
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path

from botocore.exceptions import ClientError

os.environ.update({
    'AWS_EC2_METADATA_DISABLED': 'true',
    'AWS_ACCESS_KEY_ID': 'fake',
    'AWS_SECRET_ACCESS_KEY': 'fake',
    'AWS_DEFAULT_REGION': 'us-east-1',
    'UPLOAD_BUCKET': 'test-private-videos',
    'JOURNAL_TABLE': 'test-journals',
    'USER_POOL_ID': 'test-pool',
    'ELEVENLABS_SECRET_ARN': 'test-secret',
    'GEMINI_SECRET_ARN': 'test-secret',
})

ROOT = Path(__file__).parent / 'lambda'
sys.path.insert(0, str(ROOT))


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


worker = load('queue_worker')
results = load('auth_results')


def condition_failed():
    return ClientError(
        {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'Condition failed'}},
        'ConditionalCheckFailedException',
    )


class FakeTable:
    def __init__(self):
        self.rows = {}

    def get_item(self, Key, **kwargs):
        row = self.rows.get(Key['uploadId'])
        return {'Item': deepcopy(row)} if row else {}

    def put_item(self, Item, ConditionExpression=None, ExpressionAttributeValues=None):
        key = Item['uploadId']
        current = self.rows.get(key)
        if ConditionExpression == 'attribute_not_exists(uploadId)' and current:
            raise condition_failed()
        if ConditionExpression == 'version = :expected':
            expected = ExpressionAttributeValues[':expected']
            if not current or current.get('version') != expected:
                raise condition_failed()
        self.rows[key] = deepcopy(Item)

    def update_item(self, Key, **kwargs):
        row = self.rows.get(Key['uploadId'])
        if not row:
            raise condition_failed()
        values = kwargs['ExpressionAttributeValues']
        if row.get('version') != values[':version'] or row.get('points', 0) < values[':cost']:
            raise condition_failed()
        row['points'] -= values[':cost']
        row['freezes'] = row.get('freezes', values[':zero']) + values[':one']
        row['version'] += values[':one']
        row['updatedAt'] = values[':now']


def summarize(table, owner):
    return table.rows[worker.STREAK_KEY_PREFIX + owner]


def test_daily_points_and_dst():
    table = FakeTable()
    worker.table = table
    owner = 'userA'
    row = {'timezone': 'America/New_York'}
    previous_start = worker.STREAK_START_AT
    worker.STREAK_START_AT = '2026-03-08T05:00:00Z'
    worker.record_upload_streak(owner, 'prelaunch', row, '2026-03-08T04:30:00Z')
    assert results.streak_key(owner) not in table.rows
    worker.STREAK_START_AT = previous_start

    worker.record_upload_streak(owner, 'upload-1', row, '2026-03-08T04:30:00Z')
    worker.record_upload_streak(owner, 'upload-2', row, '2026-03-09T03:00:00Z')
    worker.record_upload_streak(owner, 'upload-3', row, '2026-03-09T03:15:00Z')
    state = summarize(table, owner)
    assert state['currentStreak'] == 2
    assert state['points'] == 2
    assert state['awardedLocalDates'] == ['2026-03-07', '2026-03-08']
    assert state['lastUploadId'] == 'upload-3'
    print('PASS local calendar days remain consecutive across DST and award at most one point per day')


def test_streak_continues_beyond_retained_daily_history():
    now = datetime.now(timezone.utc)
    today = now.date()
    previous_day = today - timedelta(days=1)
    start_day = today - timedelta(days=366)
    state = {
        'timezone': 'UTC',
        'currentStreak': 500,
        'longestStreak': 500,
        'points': 500,
        'freezes': 0,
        'lastUploadAt': datetime.combine(previous_day, datetime.min.time(), timezone.utc).isoformat(),
        'awardedLocalDates': [
            (start_day + timedelta(days=offset)).isoformat()
            for offset in range(366)
        ],
        'frozenLocalDates': [],
        'version': 1,
    }

    updated = worker.calculate_streak_state(
        'userA', 'next-upload', {}, state,
        datetime.combine(today, datetime.min.time(), timezone.utc), 'UTC',
    )

    assert updated['currentStreak'] == 501
    assert updated['longestStreak'] == 501
    print('PASS streak counts continue beyond the retained daily history window')


def test_freeze_and_late_upload():
    table = FakeTable()
    worker.table = table
    owner = 'userB'
    row = {'timezone': 'America/New_York'}
    worker.record_upload_streak(owner, 'day-1', row, '2026-03-08T04:30:00Z')
    worker.record_upload_streak(owner, 'day-2', row, '2026-03-09T03:00:00Z')
    state = summarize(table, owner)
    state['freezes'] = 1
    table.rows[worker.STREAK_KEY_PREFIX + owner] = state

    worker.record_upload_streak(owner, 'day-4', row, '2026-03-11T03:30:00Z')
    state = summarize(table, owner)
    assert state['currentStreak'] == 4
    assert state['points'] == 3
    assert state['freezes'] == 0
    assert state['frozenLocalDates'] == ['2026-03-09']

    worker.record_upload_streak(owner, 'day-3-late', row, '2026-03-10T03:00:00Z')
    state = summarize(table, owner)
    assert state['currentStreak'] == 4
    assert state['points'] == 4
    assert state['freezes'] == 1
    assert state['frozenLocalDates'] == []
    print('PASS a freeze bridges one missed day and is restored if a delayed upload event fills that day')


def test_out_of_order_uploads():
    table = FakeTable()
    worker.table = table
    owner = 'userC'
    row = {'timezone': 'UTC'}
    worker.record_upload_streak(owner, 'day-1', row, '2026-04-01T12:00:00Z')
    worker.record_upload_streak(owner, 'day-3', row, '2026-04-03T12:00:00Z')
    assert summarize(table, owner)['currentStreak'] == 1
    worker.record_upload_streak(owner, 'day-2-late', row, '2026-04-02T12:00:00Z')
    state = summarize(table, owner)
    assert state['currentStreak'] == 3
    assert state['points'] == 3
    print('PASS delayed S3 notifications restore a consecutive streak without duplicate points')


def test_freeze_purchase():
    table = FakeTable()
    owner = 'userD'
    state = {
        'uploadId': results.streak_key(owner),
        'recordType': 'streak',
        'timezone': 'UTC',
        'points': 7,
        'freezes': 0,
        'currentStreak': 2,
        'longestStreak': 2,
        'version': 3,
        'lastUploadAt': '2026-11-15T12:00:00Z',
        'awardedLocalDates': ['2026-11-14', '2026-11-15'],
        'frozenLocalDates': [],
    }
    table.rows[state['uploadId']] = state
    results.table = table
    event = {
        'requestContext': {'authorizer': {'jwt': {'claims': {'token_use': 'access', 'sub': owner}}}},
        'routeKey': 'POST /streak/freeze',
    }
    response = results.handler(event, None)
    assert response['statusCode'] == 200
    assert summarize(table, owner)['points'] == 0
    assert summarize(table, owner)['freezes'] == 1
    assert summarize(table, owner)['version'] == 4
    print('PASS authenticated freeze purchase deducts seven points and adds one freeze')

    empty_owner = 'userE'
    table.rows[results.streak_key(empty_owner)] = {**state, 'uploadId': results.streak_key(empty_owner), 'points': 6}
    event['requestContext']['authorizer']['jwt']['claims']['sub'] = empty_owner
    assert results.handler(event, None)['statusCode'] == 409
    assert summarize(table, empty_owner)['points'] == 6
    print('PASS freeze purchase refuses insufficient points without changing the balance')


def test_streak_summary_and_timezone_validation():
    table = FakeTable()
    owner = 'userF'
    table.rows[results.streak_key(owner)] = {
        'uploadId': results.streak_key(owner),
        'recordType': 'streak',
        'timezone': 'UTC',
        'points': 4,
        'freezes': 1,
        'currentStreak': 2,
        'longestStreak': 5,
        'version': 1,
        'awardedLocalDates': [],
        'frozenLocalDates': [],
    }
    results.table = table
    event = {
        'requestContext': {'authorizer': {'jwt': {'claims': {'token_use': 'access', 'sub': owner}}}},
        'routeKey': 'GET /streak',
        'queryStringParameters': {'timezone': 'UTC'},
    }
    response = results.handler(event, None)
    assert response['statusCode'] == 200
    payload = json.loads(response['body'])
    assert payload['points'] == 4
    assert payload['timezone'] == 'UTC'
    assert payload['frozen_local_dates'] == []
    assert isinstance(payload['today_local_date'], str) and len(payload['today_local_date']) == 10
    event['queryStringParameters'] = {'timezone': '../invalid'}
    assert results.handler(event, None)['statusCode'] == 400
    print('PASS authenticated streak summary and timezone input validation')


if __name__ == '__main__':
    test_daily_points_and_dst()
    test_streak_continues_beyond_retained_daily_history()
    test_freeze_and_late_upload()
    test_out_of_order_uploads()
    test_freeze_purchase()
    test_streak_summary_and_timezone_validation()
