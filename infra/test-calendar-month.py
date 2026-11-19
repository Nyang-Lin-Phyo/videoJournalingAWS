#!/usr/bin/env python3
"""Read-only offline regression checks for the date-scoped journal list query."""
import importlib.util
import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

os.environ.update({
    'AWS_EC2_METADATA_DISABLED': 'true', 'AWS_ACCESS_KEY_ID': 'test',
    'AWS_SECRET_ACCESS_KEY': 'test', 'AWS_DEFAULT_REGION': 'us-east-1',
    'UPLOAD_BUCKET': 'test', 'JOURNAL_TABLE': 'test-journals',
})
root = Path(__file__).parent / 'lambda'
sys.path.insert(0, str(root))
spec = importlib.util.spec_from_file_location('calendar_results', root / 'auth_results.py')
results = importlib.util.module_from_spec(spec)
spec.loader.exec_module(results)
owner = 'test-user'
results.table = MagicMock()
results.table.query.return_value = {'Items': [
    {'uploadId': 'a', 'userId': owner, 'createdAt': '2026-11-14T17:00:00.000Z',
     'userCreatedAt': '2026-11-14T17:00:00.000Z#a', 'title': 'A journal',
     'analysis': {'sentiment': 'positive'}, 'status': 'completed'},
], 'LastEvaluatedKey': None}


def call(query):
    response = results.handle_list({'queryStringParameters': query}, owner)
    return response['statusCode'], json.loads(response['body'])


start = '2026-11-01T04:00:00.000Z'
end = '2026-12-01T05:00:00.000Z'
status, body = call({'limit': '50', 'start': start, 'end': end})
assert status == 200, (status, body)
assert body['journals'][0]['title'] == 'A journal'
assert body['journals'][0]['sentiment'] == 'positive'
expression = results.table.query.call_args.kwargs['KeyConditionExpression'].get_expression()
assert expression['operator'] == 'AND'
assert 'BETWEEN' in str(expression['values'][1].get_expression()), expression
print('PASS month range uses authenticated user partition and indexed BETWEEN')

for bad in ({'start': start}, {'end': end},
            {'start': 'not-a-date', 'end': end},
            {'start': end, 'end': start},
            {'start': start, 'end': '2027-02-01T00:00:00.000Z'}):
    status, _ = call(bad)
    assert status == 400, (bad, status)
print('PASS incomplete, malformed, reversed, or oversized ranges rejected')

status, _ = call({'limit': '20'})
assert status == 200
expression = results.table.query.call_args.kwargs['KeyConditionExpression'].get_expression()
assert expression['operator'] == '='
print('PASS original unfiltered journal history remains compatible')

# Cursor must belong to the requesting user AND selected time range.
foreign = results.cursor_encode({'uploadId': 'a', 'userId': owner, 'userCreatedAt': '2025-01-01T00:00:00.000Z#a'})
status, _ = call({'start': start, 'end': end, 'next_token': foreign})
assert status == 400
print('PASS date-range cursor cannot cross months')
