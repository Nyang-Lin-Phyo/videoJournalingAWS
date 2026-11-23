"""Offline coverage for daily transcript pages and date-range Memory Book export."""
import importlib.util
import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch
from zoneinfo import ZoneInfo

os.environ.update({
    'AWS_EC2_METADATA_DISABLED': 'true', 'AWS_ACCESS_KEY_ID': 'test',
    'AWS_SECRET_ACCESS_KEY': 'test', 'AWS_DEFAULT_REGION': 'us-east-1',
    'UPLOAD_BUCKET': 'test', 'JOURNAL_TABLE': 'test',
})
root = Path(__file__).parent / 'lambda'
sys.path.insert(0, str(root))
spec = importlib.util.spec_from_file_location('journal_page_results', root / 'auth_results.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

OWNER = 'page-owner'
DAY = '2026-11-20'
FIRST_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
SECOND_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
FIRST_TEXT = 'First recorded thought.\r\n\r\nAnother paragraph.'
SECOND_TEXT = 'A second recording from this day.'
ROWS = [
    {'uploadId': FIRST_ID, 'userId': OWNER, 'status': 'completed', 'createdAt': '2026-11-20T12:00:00.000Z',
     'title': 'Morning memory', 'transcriptKey': f'transcripts/{OWNER}/{FIRST_ID}.txt'},
    {'uploadId': SECOND_ID, 'userId': OWNER, 'status': 'completed', 'createdAt': '2026-11-20T20:00:00.000Z',
     'title': 'Evening memory', 'transcriptKey': f'transcripts/{OWNER}/{SECOND_ID}.txt'},
]
TEXTS = {FIRST_ID: FIRST_TEXT, SECOND_ID: SECOND_TEXT}


def payload(response):
    return json.loads(response['body'])


def saved_transcript(_row, upload_id, owner):
    assert owner == OWNER
    return TEXTS[upload_id], None


def source_blocks():
    blocks = []
    for row in ROWS:
        for index, block in enumerate(api.default_journal_page_blocks(TEXTS[row['uploadId']])):
            blocks.append({**block, 'id': f'source-{row["uploadId"]}-{index+1:04d}',
                           'source': True, 'sourceJournalId': row['uploadId']})
    return blocks


def test_daily_page_combines_originals_and_preserves_locked_text():
    api.table = MagicMock()
    api.table.get_item.return_value = {}
    with patch.object(api, 'journal_day_sources', return_value=ROWS), \
         patch.object(api, 'saved_transcript', side_effect=saved_transcript):
        page, error = api.daily_page_document(OWNER, DAY, ZoneInfo('UTC'))
    assert error is None and page['revision'] == 0
    assert page['dayKey'] == DAY and page['timezone'] == 'UTC'
    assert [source['id'] for source in page['sources']] == [FIRST_ID, SECOND_ID]
    assert [source['title'] for source in page['sources']] == ['Morning memory', 'Evening memory']
    assert page['originalText'] == FIRST_TEXT + '\n\n' + SECOND_TEXT
    assert [(block['sourceJournalId'], block['text']) for block in page['blocks']] == [
        (block['sourceJournalId'], block['text']) for block in source_blocks()]
    assert all(block['source'] is True for block in page['blocks'])


def test_daily_page_rejects_tampered_transcript_and_foreign_photos():
    api.table = MagicMock()
    api.table.get_item.return_value = {}
    blocks = source_blocks()
    event = lambda changed: {
        'queryStringParameters': {'timezone': 'UTC'},
        'body': json.dumps({'revision': 0, 'highlightPage': False, 'blocks': changed}),
    }
    with patch.object(api, 'journal_day_sources', return_value=ROWS), \
         patch.object(api, 'saved_transcript', side_effect=saved_transcript):
        tampered = [{**blocks[0], 'text': 'Changed original transcript'}] + blocks[1:]
        assert api.handle_put_daily_page(event(tampered), DAY, OWNER)['statusCode'] == 400
        missing = blocks[1:]
        assert api.handle_put_daily_page(event(missing), DAY, OWNER)['statusCode'] == 409
        foreign_image = {'id': 'photo-box', 'kind': 'image', 'width': 'half', 'photoId': FIRST_ID}
        with patch.object(api, 'valid_memory_photo', return_value=False):
            assert api.handle_put_daily_page(event(blocks + [foreign_image]), DAY, OWNER)['statusCode'] == 400
    with patch.object(api, 'journal_day_sources', return_value=[]):
        assert api.handle_put_daily_page(event(blocks), DAY, OWNER)['statusCode'] == 404


def test_daily_page_revision_saves_notes_and_checks_stale_writes():
    api.table = MagicMock()
    api.table.get_item.return_value = {}
    blocks = source_blocks()
    note = {'id': 'private-note-1', 'kind': 'text', 'width': 'half',
            'text': 'A small added note.', 'highlight': 'small', 'widthPercent': 60, 'style': 'note', 'name': 'Private note', 'layer': 1}
    event = {'queryStringParameters': {'timezone': 'UTC'},
             'body': json.dumps({'revision': 0, 'highlightPage': True, 'blocks': blocks + [note]})}
    with patch.object(api, 'journal_day_sources', return_value=ROWS), \
         patch.object(api, 'saved_transcript', side_effect=saved_transcript), \
         patch.object(api, 'daily_page_document', return_value=({'revision': 1}, None)):
        result = api.handle_put_daily_page(event, DAY, OWNER)
        assert result['statusCode'] == 200 and payload(result)['revision'] == 1
        transaction = api.table.meta.client.transact_write_items.call_args.kwargs['TransactItems']
        assert transaction[0]['ConditionCheck']['Key'] == {'uploadId': f'account#{OWNER}'}
        version = next(item['Put']['Item'] for item in transaction
                       if item.get('Put', {}).get('Item', {}).get('recordType') == 'journal-day-version')
        assert version['revision'] == 1 and version['highlightPage'] is True
        assert version['blocks'][-1]['highlight'] == 'small'
        assert version['blocks'][-1]['widthPercent'] == 60
        assert version['blocks'][-1]['name'] == 'Private note' and version['blocks'][-1]['layer'] == 1
        assert all('text' not in block for block in version['blocks'] if block.get('source'))
        assert len(version['sources']) == 2
        api.table.get_item.return_value = {'Item': {
            'userId': f'memory-book#{OWNER}', 'recordType': 'journal-day-latest',
            'dayKey': DAY, 'revision': 1}}
        assert api.handle_put_daily_page(event, DAY, OWNER)['statusCode'] == 409


def test_export_pins_the_daily_revision_and_groups_recordings():
    book = {'contentMode': 'journal-pages', 'revision': 7, 'timezone': 'UTC',
            'dateStart': DAY, 'dateEnd': DAY, 'excludedDays': [],
            'entries': [{'id': row['uploadId'], 'title': 'Old title',
                         'date': row['createdAt'], 'included': True} for row in ROWS]}
    daily = {'revision': 3, 'sources': [
        {'id': row['uploadId'], 'title': row['title'], 'date': row['createdAt']} for row in ROWS],
        'legacyPageRevisions': {}, 'blocks': source_blocks()}
    with patch.object(api, 'find_journal', side_effect=lambda upload_id, owner:
                      next((row for row in ROWS if owner == OWNER and row['uploadId'] == upload_id), None)), \
         patch.object(api, 'daily_page_document', return_value=(daily, None)):
        snapshot, entries, error, status = api.make_journal_page_export_snapshot(OWNER, book)
    assert error is None and status is None
    assert len(entries) == 1 and entries[0]['id'] == DAY
    assert [record['title'] for record in entries[0]['records']] == ['Morning memory', 'Evening memory']
    assert snapshot['pageRefs'] == [{'dayKey': DAY, 'pageRevision': 3,
                                    'sourceIds': [FIRST_ID, SECOND_ID], 'legacyPageRevisions': {}}]
    assert snapshot['entries'] == entries


def test_optional_layer_names_survive_validation_and_locked_transcript_text_stays_exact():
    source = {**source_blocks()[0], 'name': 'Morning transcript', 'layer': 3, 'x': 94, 'y': -105}
    note = {'id': 'new-note', 'kind': 'text', 'width': 'wide', 'text': 'Some private words', 'name': 'My first note', 'layer': 1}
    photo = {'id': 'new-image', 'kind': 'image', 'width': 'half', 'photoId': FIRST_ID, 'name': 'A happy memory', 'layer': 2}
    mapping = {(source['id'], source['sourceJournalId']): source['text']}
    with patch.object(api, 'valid_memory_photo', return_value=True):
        blocks, error = api.validate_journal_page_blocks([source, note, photo], OWNER, '', mapping)
    assert error is None
    assert [block['layer'] for block in blocks] == [3, 1, 2]
    assert [block['name'] for block in blocks] == ['Morning transcript', 'My first note', 'A happy memory']
    assert blocks[0]['text'] == source['text']
    for bad in ({**note, 'name': 'bad\nname'}, {**note, 'layer': 0}, {**note, 'layer': 501}):
        assert api.validate_journal_page_blocks([bad], OWNER, '')[0] is None


def test_legacy_journal_page_delete_cleans_pointer_and_versions():
    api.table = MagicMock()
    pointer = {'userId': f'memory-book#{OWNER}', 'recordType': 'journal-page-latest',
               'journalId': FIRST_ID, 'revision': 2}
    version = {'userId': f'memory-book#{OWNER}', 'recordType': 'journal-page-version', 'journalId': FIRST_ID}
    api.table.get_item.side_effect = [{'Item': pointer}, {'Item': version}, {'Item': version}]
    api.delete_journal_page_records(OWNER, FIRST_ID)
    keys = [call.kwargs['Key']['uploadId'] for call in api.table.delete_item.call_args_list]
    assert keys == [api.journal_page_version_key(OWNER, FIRST_ID, 1),
                    api.journal_page_version_key(OWNER, FIRST_ID, 2), api.journal_page_key(OWNER, FIRST_ID)]


if __name__ == '__main__':
    test_daily_page_combines_originals_and_preserves_locked_text()
    test_daily_page_rejects_tampered_transcript_and_foreign_photos()
    test_daily_page_revision_saves_notes_and_checks_stale_writes()
    test_export_pins_the_daily_revision_and_groups_recordings()
    test_legacy_journal_page_delete_cleans_pointer_and_versions()
    test_optional_layer_names_survive_validation_and_locked_transcript_text_stays_exact()
    print('PASS daily source preservation, tamper rejection, photo ownership, and immutable revisions')
    print('PASS date-range daily PDF revision pinning and legacy journal-page cleanup')
