"""Safely extend an existing MP4 -> SQS S3 notification with WebM support.

This module has no AWS side effects. The deployment script uses it to prepare
an updated configuration without deleting or modifying existing notifications.
"""
import copy
import json
import sys


def add_webm_notification(existing, queue_arn):
    if not queue_arn or not queue_arn.startswith('arn:aws:sqs:'):
        raise ValueError('Expected an SQS queue ARN')
    config = copy.deepcopy(existing)
    queues = config.get('QueueConfigurations', [])
    matches = [item for item in queues if item.get('QueueArn') == queue_arn
               and 's3:ObjectCreated:*' in item.get('Events', [])
               and dict((rule['Name'].lower(), rule['Value']) for rule in item.get('Filter', {}).get('Key', {}).get('FilterRules', []))
               == {'prefix': 'uploads/', 'suffix': '.mp4'}]
    if len(matches) != 1:
        raise ValueError('Expected exactly one existing uploads/*.mp4 SQS notification for the configured queue. Do not replace other notifications.')
    # S3 rejects overlapping key filters for the same event types. Detect
    # possible collisions *before* changing Lambda code or S3 configuration.
    for group in ('QueueConfigurations', 'LambdaFunctionConfigurations', 'TopicConfigurations'):
        for item in config.get(group, []):
            if not any(event.startswith('s3:ObjectCreated:') for event in item.get('Events', [])):
                continue
            filters = dict((rule['Name'].lower(), rule['Value']) for rule in item.get('Filter', {}).get('Key', {}).get('FilterRules', []))
            prefix, suffix = filters.get('prefix', ''), filters.get('suffix', '')
            if not ('uploads/'.startswith(prefix) or prefix.startswith('uploads/')):
                continue
            if not ('.webm'.endswith(suffix) or suffix.endswith('.webm')):
                continue
            if (group == 'QueueConfigurations' and item.get('QueueArn') == queue_arn
                    and prefix == 'uploads/' and suffix == '.webm'
                    and 's3:ObjectCreated:*' in item.get('Events', [])):
                return config  # Already configured; preserve it unchanged.
            raise ValueError('An existing S3 object-created notification may overlap uploads/*.webm. Refusing to change notifications.')
    new_id = 'ReverieBrowserRecordingWebm'
    if any(item.get('Id') == new_id for item in queues):
        raise ValueError('WebM notification ID is already used by another queue')
    new_item = {
        'Id': new_id,
        'QueueArn': queue_arn,
        'Events': ['s3:ObjectCreated:*'],
        'Filter': {'Key': {'FilterRules': [
            {'Name': 'prefix', 'Value': 'uploads/'},
            {'Name': 'suffix', 'Value': '.webm'},
        ]}},
    }
    config.setdefault('QueueConfigurations', []).append(new_item)
    return config


if __name__ == '__main__':
    source, output, queue = sys.argv[1:]
    with open(source) as file:
        current = json.load(file)
    updated = add_webm_notification(current, queue)
    with open(output, 'w') as file:
        json.dump(updated, file, indent=2)
    print('Prepared S3 configuration: existing notifications retained; WebM routed to existing SQS queue.')
