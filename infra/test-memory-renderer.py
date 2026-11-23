"""Exercise private photo normalization offline using real image bytes."""

from io import BytesIO
import json
import os
from pathlib import Path
import sys
import unittest
from decimal import Decimal
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock, patch

from PIL import Image, UnidentifiedImageError

os.environ.update(
    AWS_EC2_METADATA_DISABLED='true',
    AWS_ACCESS_KEY_ID='fake',
    AWS_SECRET_ACCESS_KEY='fake',
    AWS_DEFAULT_REGION='us-east-1',
    UPLOAD_BUCKET='private-test-bucket',
    JOURNAL_TABLE='test-journals',
)
sys.path.insert(0, str(Path(__file__).resolve().parent / 'lambda'))
class FakeURLFetcher:
    def __init__(self, **kwargs):
        self._fail_on_errors = kwargs.get('fail_on_errors', False)

class FakeURLFetcherResponse:
    def __init__(self, url, body, headers):
        self.url, self.body, self.headers = url, body, headers

fake_urls = ModuleType('weasyprint.urls')
fake_urls.URLFetcher = FakeURLFetcher
fake_urls.URLFetcherResponse = FakeURLFetcherResponse
with patch.dict(sys.modules, {'weasyprint': MagicMock(), 'weasyprint.urls': fake_urls}):
    import memory_export_worker as worker


class PhotoNormalizationTests(unittest.TestCase):
    owner = 'photo-owner'
    photo_id = '12345678-1234-1234-1234-123456789abc'
    source_key = f'uploads/{owner}/memory-photos/{photo_id}.upload'

    def setUp(self):
        table_patch = patch.object(worker, 'table')
        bucket_patch = patch.object(worker, 's3')
        self.table = table_patch.start()
        self.bucket = bucket_patch.start()
        self.addCleanup(table_patch.stop)
        self.addCleanup(bucket_patch.stop)
        self.row = {'userId': f'memory-book#{self.owner}', 'uploadKey': self.source_key, 'status': 'queued'}
        self.table.get_item.side_effect = [{}, {'Item': self.row}, {}]

    def set_image_body(self, data):
        self.bucket.get_object.return_value = {'ContentLength': len(data), 'Body': BytesIO(data)}

    def test_normalizes_png_and_writes_only_under_the_private_owner(self):
        png = BytesIO()
        with Image.new('RGBA', (2500, 20), (30, 100, 80, 255)) as image:
            image.save(png, format='PNG')
        self.set_image_body(png.getvalue())

        self.assertEqual(worker.normalize_photo(self.owner, self.photo_id)['status'], 'complete')

        self.assertEqual(self.bucket.get_object.call_args.kwargs['Key'], self.source_key)
        saved = self.bucket.put_object.call_args.kwargs
        self.assertEqual(saved['Key'], f'photos/{self.owner}/{self.photo_id}.jpg')
        self.assertEqual(saved['ContentType'], 'image/jpeg')
        self.assertEqual(saved['ServerSideEncryption'], 'AES256')
        self.assertNotIn('ACL', saved)
        with Image.open(BytesIO(saved['Body'])) as photo:
            self.assertEqual(photo.format, 'JPEG')
            self.assertEqual(photo.mode, 'RGB')
            self.assertEqual(photo.width, 2400)

    def test_rejects_non_photo_bytes(self):
        self.set_image_body(b'<svg xmlns="http://www.w3.org/2000/svg"/>')

        with self.assertRaises((ValueError, UnidentifiedImageError)):
            worker.normalize_photo(self.owner, self.photo_id)

        self.bucket.put_object.assert_not_called()

    def test_rejects_other_owners_staging_objects(self):
        self.row['uploadKey'] = self.source_key.replace(self.owner, 'another-owner')

        with self.assertRaises(ValueError):
            worker.normalize_photo(self.owner, self.photo_id)

        self.bucket.get_object.assert_not_called()
        self.bucket.put_object.assert_not_called()


class PrivateURLFetcherTests(unittest.TestCase):
    def test_allows_only_packaged_tile_and_embedded_private_jpeg(self):
        guide = worker.safe_fetcher.fetch(worker.DOT_GUIDE_TILE)
        self.assertEqual(guide.headers['Content-Type'], 'image/png')
        self.assertTrue(guide.body.startswith(b'\x89PNG'))
        photo_url = 'data:image/jpeg;base64,ZmFrZQ=='
        photo = worker.safe_fetcher.fetch(photo_url)
        self.assertEqual(photo.headers['Content-Type'], 'image/jpeg')
        self.assertEqual(photo.body, b'fake')
        with self.assertRaisesRegex(ValueError, 'External resource fetches are disabled'):
            worker.safe_fetcher.fetch('https://example.invalid/track')
        self.assertFalse(worker.safe_fetcher._fail_on_errors)


class ExportSnapshotTests(unittest.TestCase):
    def test_journal_page_renderer_preserves_order_width_images_and_highlights(self):
        book = {'contentMode': 'journal-pages', 'templateId': 'notebook-v1', 'includeHighlights': True,
                'pageColor': '#f7f3ea', 'marginMm': 18}
        long_text = '\n'.join(f'Paragraph {number}: the words continue naturally.' for number in range(120))
        pages = [
            {'journalId':'late','title':'Reordered later entry','date':'2026-04-03T12:00:00Z','highlightPage':True,
             'blocks':[{'id':'note','kind':'text','width':'half','style':'note','text':'A small selected line. '+long_text,'highlight':'selected line'},
                       {'id':'image','kind':'image','width':'wide','photoId':'photo-id','caption':'The blue evening','highlight':True}]},
            {'journalId':'early','title':'Second printed entry','date':'2026-01-02T12:00:00Z','highlightPage':False,
             'blocks':[{'id':'body','kind':'text','width':'full','text':'Keep every word.'}]},
        ]
        rendered = worker.render_journal_pages_html(book, pages, {'photo-id':'data:image/jpeg;base64,ZmFrZQ=='})
        self.assertLess(rendered.index('Reordered later entry'), rendered.index('Second printed entry'))
        self.assertIn('width-half', rendered)
        self.assertIn('width-wide', rendered)
        self.assertIn('width-full', rendered)
        self.assertIn('src="data:image/jpeg;base64,ZmFrZQ=="', rendered)
        self.assertIn('<mark>selected line</mark>', rendered)
        self.assertIn('<h1>Highlights</h1>', rendered)
        self.assertIn('The blue evening', rendered)
        self.assertIn('Selected journal page', rendered)
        self.assertIn('display:block; min-width:0', rendered)
        for number in range(120):
            self.assertIn(f'Paragraph {number}:', rendered)

    def test_worker_resolves_pinned_page_revision_after_a_later_edit(self):
        owner, upload_id = 'page-owner', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        source_key = f'transcripts/{owner}/{upload_id}.txt'
        book = {'contentMode':'journal-pages','entries':[{'id':upload_id,'title':'Page title','date':'2026-11-20T12:00:00Z','included':True}],
                'pageRefs':[{'journalId':upload_id,'pageRevision':Decimal('1')}]}
        old_version = {'userId':f'memory-book#{owner}','recordType':'journal-page-version','journalId':upload_id,
                       'revision':Decimal('1'),'blocks':[{'id':'old','kind':'text','width':'full','text':'Captured before the next edit.'}],
                       'highlightPage':False}
        source = {'userId':owner,'status':'completed','createdAt':'2026-11-20T12:00:00Z','transcriptKey':source_key}
        with patch.object(worker,'table') as table, patch.object(worker,'s3') as bucket:
            table.get_item.side_effect=lambda Key, **_: {'Item':source} if Key['uploadId']==upload_id else {'Item':old_version}
            bucket.get_object.return_value={'Body':BytesIO(b'Immutable original transcript.')}
            pages, photos = worker.resolve_journal_page_snapshots(owner, book)
        self.assertEqual(pages[0]['revision'],1)
        self.assertEqual(pages[0]['blocks'][0]['text'],'Captured before the next edit.')
        self.assertNotIn('Later edit', pages[0]['blocks'][0]['text'])
        self.assertEqual(photos,set())

    def test_html_render_uses_exact_safe_quote_split_and_date_range_with_chapter_order(self):
        book = {
            'title': 'Selected dates', 'timezone': 'Invalid/InProgress', 'dateStart': '2026-02-01',
            'dateEnd': '2026-03-31', 'chapterOrder': ['2026-03', '2026-02'], 'texture': 'Linen',
            'yearSectionEnabled': True,
            'entries': [
                {'id': 'late', 'title': 'Late', 'date': '2026-03-10T12:00:00Z', 'included': True, 'approved': True,
                 'text': 'Keep <this> & that.', 'original_text': 'Keep <this> & that.', 'quotes': ['<this> & that'], 'quoteModes': {'<this> & that': 'inline'}, 'layout': 'text', 'photoId': 'photo-a'},
                {'id': 'outside', 'title': 'Outside', 'date': '2026-04-10T12:00:00Z', 'included': True, 'approved': True, 'text': 'Omit me', 'layout': 'text'},
                {'id': 'early', 'title': 'Early', 'date': '2026-02-10T12:00:00Z', 'included': True, 'approved': True, 'text': 'February', 'layout': 'text'},
            ],
        }
        result = worker.render_html(book, {'photo-a': 'data:image/jpeg;base64,ZmFrZQ=='})
        self.assertIn('<mark>&lt;this&gt; &amp; that</mark>', result)
        self.assertNotIn('src="data:image/jpeg;base64,ZmFrZQ=="', result)
        self.assertNotIn('Omit me', result)
        self.assertLess(result.index('March 2026'), result.index('February 2026'))
        self.assertIn('font-size:17pt', result)
        self.assertNotIn('font:17 pt', result)
        self.assertIn('<h1>Year in My Own Words</h1>', result)
        self.assertIn('<blockquote>&lt;this&gt; &amp; that<small>2026-03-10</small></blockquote>', result)

    def test_versioned_template_preserves_blank_and_filled_slots(self):
        catalog = json.loads((Path(__file__).parent / 'lambda' / 'memory-book-templates.json').read_text(encoding='utf-8'))
        self.assertIn('photo-album-v1', [template['id'] for template in catalog['templates']])
        blank_book = {'title': 'Partly made book', 'templateId': 'photo-album-v1', 'theme': 'Scrapbook',
                      'texture': 'Plain', 'pageColor': '#fffefa', 'entries': [{
                          'title': 'A rainy walk', 'date': '2026-05-01T12:00:00Z', 'included': True,
                          'approved': True, 'text': 'A long memory. ' * 150,
                          'areas': {'image': {'mode': 'blank'}, 'writing': {'mode': 'blank'}},
                      }]}
        blank_html = worker.render_html(blank_book, {})
        self.assertIn('template-photo-album-v1', blank_html)
        self.assertIn('class="template-area blank image-area image-mount" style="height:86mm"', blank_html)
        self.assertIn('class="template-area blank writing-area guide-open" style="height:34mm"', blank_html)
        self.assertNotIn('Add a photo', blank_html)
        self.assertIn('size:210mm 297mm', blank_html)
        self.assertEqual(worker.selected_photo_ids({**blank_book, 'entries': [{**blank_book['entries'][0], 'photoId': 'old-photo'}]}), set())
        self.assertEqual(worker.selected_photo_ids({**blank_book, 'entries': [{**blank_book['entries'][0], 'areas': {
            'image': {'mode': 'image', 'photoId': 'placed-photo'}, 'writing': {'mode': 'blank'},
        }}] }), {'placed-photo'})
        filled = {**blank_book, 'entries': [{**blank_book['entries'][0], 'areas': {
            'image': {'mode': 'text', 'text': 'Handwritten caption copied from a family letter'},
            'writing': {'mode': 'text', 'text': 'Leave room for the next chapter.'},
        }}]}
        filled_html = worker.render_html(filled, {})
        self.assertIn('Handwritten caption copied from a family letter', filled_html)
        self.assertIn('Leave room for the next chapter.', filled_html)
        self.assertNotIn('class="template-area blank image-area image-mount"', filled_html)

    def test_notebook_uses_actual_layout_anchor_to_fill_writing_space_and_keeps_entry_content(self):
        short_id = '11111111-1111-1111-1111-111111111111'
        long_id = '22222222-2222-2222-2222-222222222222'
        book = {'title': 'Notebook', 'templateId': 'notebook-v1', 'theme': 'Notebook', 'texture': 'Linen',
                'chapterOrder': ['2026-02', '2026-03'],
                'pageColor': '#f7f3ea', 'entries': [
                    {'id': short_id, 'title': 'A short entry', 'date': '2026-03-01T12:00:00Z', 'included': True,
                     'approved': True, 'text': 'A quiet walk.', 'areas': {'image': {'mode': 'blank'}, 'writing': {'mode': 'blank'}}},
                    {'id': long_id, 'title': 'A longer entry', 'date': '2026-02-02T12:00:00Z', 'included': True,
                     'approved': True, 'text': 'Keep every paragraph. ' * 450,
                     'annotation': 'Remember the blue evening.', 'stickers': ['leaf', 'spark'],
                     'personalStickerPhotoId': 'private-sticker',
                     'areas': {'image': {'mode': 'blank'}, 'writing': {'mode': 'text', 'text': 'My own words stay on this page.'}}},
                ]}
        page_height = 297 * 96 / 25.4
        document = SimpleNamespace(pages=[SimpleNamespace(height=page_height, anchors={
            f'notebook-fill-{short_id}': (0, 300, 0, 0), f'notebook-fill-{long_id}': (0, page_height - 16 * 96 / 25.4 - 4 * 96 / 25.4, 0, 0),
        })])
        heights = worker.measure_notebook_writing_heights(document, book)
        self.assertEqual(heights[short_id], round((page_height - 16 * 96 / 25.4 - 300) * 25.4 / 96 - 4, 1))
        self.assertEqual(heights[long_id], 0)
        rendered = worker.render_html(book, {'private-sticker': 'data:image/jpeg;base64,ZmFrZQ=='}, heights)
        self.assertIn('template-notebook-v1', rendered)
        self.assertIn(f'id="notebook-fill-{short_id}"', rendered)
        self.assertIn(f'style="height:{heights[short_id]:g}mm"', rendered)
        self.assertEqual(rendered.count('class="notebook-rule"'), int(heights[short_id] // 7))
        self.assertIn('height:7mm; box-sizing:border-box; margin:0; border:0; border-bottom:.18mm solid #e7e1da', rendered)
        self.assertIn(f'id="notebook-fill-{long_id}"', rendered)
        self.assertIn('.template-notebook-v1 { font-size:12.5pt; line-height:1.5; }', rendered)
        self.assertIn('.template-notebook-v1 .story-area { line-height:1.5; break-inside:auto; page-break-inside:auto; }', rendered)
        self.assertIn('<h1 class="template-area title-area">A short entry</h1>', rendered)
        self.assertLess(rendered.index('A short entry'), rendered.index('A longer entry'))
        self.assertIn('Remember the blue evening.', rendered)
        self.assertEqual(rendered.count('Remember the blue evening.'), 1)
        self.assertIn('My own words stay on this page.', rendered)
        self.assertLess(rendered.index('My own words stay on this page.'), rendered.index(f'id="notebook-fill-{long_id}"'))
        self.assertIn('aria-label="leaf"', rendered)
        self.assertIn('src="data:image/jpeg;base64,ZmFrZQ==" alt="Personal sticker"', rendered)
        self.assertNotIn('class="template-area blank image-area', rendered)
        self.assertNotIn('class="template-area blank quote-area', rendered)
        self.assertNotIn('class="chapter"', rendered)
        self.assertEqual(worker.selected_photo_ids(book), {'private-sticker'})

    def test_renders_queued_revision_even_after_a_later_book_edit(self):
        owner = 'book-owner'
        upload_id = '12345678-1234-1234-1234-123456789abc'
        book_id = '12345678-1234-1234-1234-123456789def'
        snapshot = {'title': 'A saved edition', 'revision': 4, 'entries': [{
            'id': upload_id,
            'title': 'After school',
            'date': '2026-03-22T12:00:00Z',
            'included': True,
            'approved': True,
            'narrativeRevision': 2,
        }]}
        rows = {
            f'memory-book#{owner}#{book_id}': {'userId': f'memory-book#{owner}', 'recordType': 'memory-book', 'book': {'revision': 5, 'title': 'A subsequent edit'}},
            f'memory-export#{owner}#{book_id}#4': {'userId': f'memory-book#{owner}', 'recordType': 'memory-export', 'bookId': book_id, 'status': 'queued', 'bookSnapshot': snapshot},
            upload_id: {'userId': owner, 'status': 'completed', 'uploadId': upload_id},
            f'memory-narrative-version#{owner}#{upload_id}#2': {
                'userId': f'memory-book#{owner}', 'recordType': 'memory-narrative-version', 'text': 'I went for a walk.',
            },
        }
        with patch.object(worker, 'table') as table, patch.object(worker, 's3') as bucket, patch.object(worker, 'HTML') as html:
            table.get_item.side_effect = lambda Key, **_: {'Item': rows[Key['uploadId']]} if Key['uploadId'] in rows else {}
            html.return_value.write_pdf.return_value = b'%PDF-1.7 synthetic-artifact'

            result = worker.handler({'owner': owner, 'book_id': book_id, 'revision': 4}, None)

            self.assertEqual(result['status'], 'complete')
            self.assertIn('A saved edition', html.call_args.kwargs['string'])
            self.assertIn('I went for a walk.', html.call_args.kwargs['string'])
            self.assertNotIn('A subsequent edit', html.call_args.kwargs['string'])
            self.assertEqual(bucket.put_object.call_args.kwargs['Key'], f'exports/{owner}/{book_id}/4.pdf')

    def test_removes_exact_object_version_when_delete_wins_after_upload(self):
        owner = 'book-owner'
        book_id = '12345678-1234-1234-1234-123456789def'
        snapshot = {'title': 'Pending deletion', 'revision': 4, 'entries': []}
        active = {'userId': f'memory-book#{owner}', 'recordType': 'memory-book', 'book': snapshot}
        deleted = {'userId': f'memory-book#{owner}', 'recordType': 'memory-book-deleted', 'status': 'deleted'}
        job = {'userId': f'memory-book#{owner}', 'recordType': 'memory-export', 'bookId': book_id,
               'status': 'queued', 'bookSnapshot': snapshot}
        book_reads = 0

        def get_item(Key, **_):
            nonlocal book_reads
            upload_id = Key['uploadId']
            if upload_id == f'memory-book#{owner}#{book_id}':
                book_reads += 1
                return {'Item': active if book_reads < 4 else deleted}
            if upload_id == f'memory-export#{owner}#{book_id}#4':
                return {'Item': job}
            return {}

        with patch.object(worker, 'table') as table, patch.object(worker, 's3') as bucket, patch.object(worker, 'HTML') as html:
            table.get_item.side_effect = get_item
            bucket.put_object.return_value = {'VersionId': 'render-version'}
            html.return_value.write_pdf.return_value = b'%PDF-1.7 synthetic-artifact'

            result = worker.handler({'owner': owner, 'book_id': book_id, 'revision': 4}, None)

            self.assertEqual(result, {'ignored': True})
            bucket.delete_object.assert_called_once_with(
                Bucket=worker.BUCKET, Key=f'exports/{owner}/{book_id}/4.pdf', VersionId='render-version')
            table.update_item.assert_called_once()


if __name__ == '__main__':
    unittest.main()
