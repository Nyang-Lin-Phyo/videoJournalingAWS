"""Async, private PDF renderer for reviewed memory books."""
import html
import json
import os
import io
import base64
import warnings
import re
from decimal import Decimal
from pathlib import Path
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import boto3
from botocore.exceptions import ClientError
from weasyprint import HTML
from weasyprint.urls import URLFetcher, URLFetcherResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from journal_pages import default_journal_page_blocks

TABLE = os.environ['JOURNAL_TABLE']
BUCKET = os.environ['UPLOAD_BUCKET']
table = boto3.resource('dynamodb').Table(TABLE)
s3 = boto3.client('s3')
Image.MAX_IMAGE_PIXELS = 40_000_000
DOT_GUIDE_TILE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGNgoC+oyEtxg2EaKSALAABASg4RvdqYpwAAAABJRU5ErkJggg=='


def memory_template(book):
    """Resolve an immutable, versioned page structure; old books map by theme."""
    path = Path(__file__).with_name('memory-book-templates.json')
    try:
        catalog = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        catalog = {'templates': []}
    templates = catalog.get('templates', [])
    template_id = book.get('templateId')
    match = next((item for item in templates if item.get('id') == template_id), None)
    if match:
        return match
    theme = book.get('theme', 'Classic diary')
    match = next((item for item in templates if item.get('legacyTheme') == theme), None)
    if match:
        return match
    return {'id': 'daily-notes-v1', 'templateVersion': 1, 'legacyTheme': 'Classic diary',
            'page': {'widthMm': 210, 'heightMm': 297, 'marginMm': 18},
            'slots': [{'id': 'date', 'kind': 'date'}, {'id': 'title', 'kind': 'title'},
                      {'id': 'image', 'kind': 'image-or-text'}, {'id': 'story', 'kind': 'narrative'},
                      {'id': 'quote', 'kind': 'quote'}, {'id': 'writing', 'kind': 'writing'}]}


def template_slot_html(slot, entry, local_day, index, book_zone, image_urls, quotes, quote_pattern, writing_heights=None):
    slot_id, kind = str(slot.get('id', 'area')), slot.get('kind')
    height = max(12, min(160, int(slot.get('heightMm', 40))))
    guide = slot.get('guide', 'open') if slot.get('guide') in ('ruled', 'dot', 'open') else 'open'
    treatment = slot.get('imageTreatment', 'open') if slot.get('imageTreatment') in ('frame', 'mount', 'open') else 'open'
    areas = entry.get('areas') or {}
    has_area = slot_id in areas
    area = areas.get(slot_id, {})
    mode = area.get('mode', 'blank') if isinstance(area, dict) else 'blank'
    if kind == 'date':
        return f'<div class="template-area date-area">{html.escape(local_day)}</div>'
    if kind == 'title':
        return f'<h1 class="template-area title-area">{html.escape(str(entry.get("title", "A memory")))}</h1>'
    if kind == 'narrative':
        blocks = ''.join('<p>' + ''.join('<mark>' + html.escape(part) + '</mark>' if quote_pattern and part in quotes else html.escape(part) for part in (quote_pattern.split(value) if quote_pattern else [value])) + '</p>' for value in str(entry.get('text', '')).split('\n\n') if value.strip())
        return f'<div class="template-area story-area">{blocks}</div>'
    if kind == 'stickers':
        return notebook_stickers_html(entry, image_urls)
    if kind == 'annotation':
        note = str(entry.get('annotation', '')).strip()
        return f'<aside class="template-area annotation notebook-annotation">{html.escape(note)}</aside>' if note else ''
    if kind == 'quote':
        quote_height = max(12, min(100, int(slot.get('minHeightMm', 22))))
        visible_quotes = [quote for quote in quotes if (entry.get('quoteModes') or {}).get(quote, entry.get('quoteDisplay', 'both')) in ('both', 'standalone')]
        if visible_quotes:
            quote_class = ' notebook-marginal-quote' if entry.get('_notebook') else ''
            return f'<div class="template-area quote-area{quote_class}" style="min-height:{quote_height}mm">' + ''.join(f'<blockquote>{html.escape(quote)}</blockquote>' for quote in visible_quotes) + '</div>'
        if entry.get('_notebook'):
            return ''
        return f'<div class="template-area blank quote-area guide-{guide}" style="min-height:{quote_height}mm"><div class="writing-guides"><i></i><i></i><i></i></div></div>'
    if kind == 'image-or-text':
        if mode == 'text' and isinstance(area.get('text'), str) and area['text'].strip():
            return f'<div class="template-area image-area image-{treatment} area-text" style="min-height:{height}mm">{html.escape(area["text"])}</div>'
        photo_ids = [area.get('photoId')] if mode == 'image' and area.get('photoId') else []
        if not has_area and entry.get('layout', 'text') != 'text':
            photo_ids = entry.get('photoIds') or ([entry.get('photoId')] if entry.get('photoId') else [])
        photo_ids = [photo_id for photo_id in photo_ids if photo_id in image_urls]
        if photo_ids:
            caption = html.escape(str(entry.get('caption', '')))
            focal = entry.get('focal', {}) if isinstance(entry.get('focal', {}), dict) else {}
            x = max(0, min(100, int(focal.get('x', 50))))
            y = max(0, min(100, int(focal.get('y', 50))))
            rows = (len(photo_ids) + 1) // 2 if len(photo_ids) > 1 else 1
            inset = 12 if treatment == 'mount' else 6
            image_height = max(8, int((height - inset - (6 if caption else 0)) / rows))
            image_width = '48%' if len(photo_ids) > 1 else '100%'
            images = ''.join(f'<img style="height:{image_height}mm;max-height:{image_height}mm;width:{image_width};max-width:{image_width};object-fit:contain;object-position:{x}% {y}%" src="{image_urls[photo_id]}" alt="Memory photograph">' for photo_id in photo_ids)
            return f'<div class="template-area image-area image-{treatment}" style="height:{height}mm">{images}{("<small>" + caption + "</small>") if caption else ""}</div>'
        if entry.get('_notebook'):
            return ''
        return f'<div class="template-area blank image-area image-{treatment}" style="height:{height}mm"><div class="image-guides"><i></i><i></i><i></i><i></i></div></div>'
    if kind == 'writing':
        if entry.get('_notebook'):
            height_mm = (writing_heights or {}).get(entry.get('id'), 0)
            marker = f'<span id="notebook-fill-{html.escape(str(entry.get("id", index)))}"></span>'
            user_text = (area.get('text', '') if mode == 'text' and isinstance(area, dict) and isinstance(area.get('text'), str) else '')
            written = (f'<div class="template-area writing-area area-text notebook-user-writing">{html.escape(user_text)}</div>'
                       if user_text.strip() else '')
            if height_mm <= 0:
                return written + marker
            rule_count = max(0, int(height_mm // 7))
            rules = '<i class="notebook-rule"></i>' * rule_count
            blank = f'<div class="template-area blank is-reserved writing-area guide-{guide}" style="height:{height_mm:g}mm"><div class="writing-guides">{rules}</div></div>'
            return written + marker + blank
        if mode == 'text' and isinstance(area.get('text'), str) and area['text'].strip():
            return f'<div class="template-area writing-area area-text" style="min-height:{height}mm">{html.escape(area["text"])}</div>'
        if not has_area and isinstance(entry.get('annotation'), str) and entry['annotation'].strip():
            return f'<div class="template-area writing-area area-text" style="min-height:{height}mm">{html.escape(entry["annotation"])}</div>'
        return f'<div class="template-area blank writing-area guide-{guide}" style="height:{height}mm"><div class="writing-guides"><i></i><i></i><i></i></div></div>'
    if mode == 'text' and isinstance(area.get('text'), str) and area['text'].strip():
        return f'<div class="template-area generic-area area-text">{html.escape(area["text"])}</div>'
    return '<div class="template-area blank generic-area"><div class="writing-guides"><i></i><i></i><i></i></div></div>'


NOTEBOOK_STICKERS = {
    'sunrise': '<svg viewBox="0 0 32 32" aria-label="sunrise" fill="none" stroke="#a4775f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 22h22M9 20a7 7 0 0 1 14 0M16 4v4m-9 0 3 3m15-3-3 3"/></svg>',
    'leaf': '<svg viewBox="0 0 32 32" aria-label="leaf" fill="none" stroke="#a4775f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M26 5C14 5 7 10 7 19c0 5 4 8 8 8 8 0 11-10 11-22ZM7 27l13-14"/></svg>',
    'spark': '<svg viewBox="0 0 32 32" aria-label="spark" fill="none" stroke="#a4775f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3l3 9 9 4-9 3-3 10-3-10-9-3 9-4 3-9Z"/></svg>',
    'heart': '<svg viewBox="0 0 32 32" aria-label="heart" fill="none" stroke="#a4775f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 27 5 16C-1 7 10 2 16 10c6-8 17-3 11 6L16 27Z"/></svg>',
    'flower': '<svg viewBox="0 0 32 32" aria-label="flower" fill="none" stroke="#a4775f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 15c-9-10-15 2-1 3-13 3-6 14 2 2 0 15 13 11 3-1 14 4 16-9 1-5 7-12-5-16-5-1ZM16 18v11"/></svg>',
}


def notebook_stickers_html(entry, image_urls):
    """Render only known, versioned built-ins and an optional owner-checked image."""
    chosen = entry.get('stickers', [])
    marks = ''.join(NOTEBOOK_STICKERS[item] for item in chosen if item in NOTEBOOK_STICKERS)
    personal = image_urls.get(entry.get('personalStickerPhotoId'))
    if personal:
        marks += f'<img class="personal-sticker" src="{personal}" alt="Personal sticker">'
    return '<div class="template-area notebook-stickers" aria-label="Selected stickers">' + marks + '</div>' if marks else ''


def selected_photo_ids(book):
    """Only return photos that occupy an image slot, honoring explicit blanks."""
    photo_ids = set()
    supports_notebook_stickers = memory_template(book).get('id') == 'notebook-v1'
    slots = [slot for slot in memory_template(book).get('slots', []) if slot.get('kind') == 'image-or-text']
    for entry in book.get('entries', []):
        if not entry.get('included'):
            continue
        if supports_notebook_stickers and entry.get('personalStickerPhotoId'):
            photo_ids.add(entry['personalStickerPhotoId'])
        areas = entry.get('areas') or {}
        for slot in slots:
            slot_id = slot.get('id')
            if slot_id in areas:
                area = areas[slot_id]
                if isinstance(area, dict) and area.get('mode') == 'image' and area.get('photoId'):
                    photo_ids.add(area['photoId'])
            elif entry.get('layout', 'text') != 'text':
                photo_ids.update(entry.get('photoIds') or ([entry.get('photoId')] if entry.get('photoId') else []))
    if book.get('coverPhotoId'):
        photo_ids.add(book['coverPhotoId'])
    return photo_ids


def memory_book_is_active(owner, book_id):
    row = table.get_item(Key={'uploadId': f'memory-book#{owner}#{book_id}'}, ConsistentRead=True).get('Item') or {}
    return bool(row.get('userId') == f'memory-book#{owner}' and row.get('recordType') == 'memory-book' and
                row.get('status') != 'deleted' and isinstance(row.get('book'), dict))


def delete_written_export(key, version_id):
    """Remove only this render attempt's S3 version after losing the delete fence."""
    if version_id:
        s3.delete_object(Bucket=BUCKET, Key=key, VersionId=version_id)
    else:
        s3.delete_object(Bucket=BUCKET, Key=key)


def discard_memory_export_job(owner, book_id, job_key):
    try:
        table.delete_item(Key=job_key, ConditionExpression='userId = :owner AND recordType = :type AND bookId = :book',
                          ExpressionAttributeValues={':owner': f'memory-book#{owner}', ':type': 'memory-export', ':book': book_id})
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
            raise


def normalize_photo(owner, photo_id):
    row_key = {'uploadId': f'memory-photo#{owner}#{photo_id}'}
    marker = table.get_item(Key={'uploadId': f'account#{owner}'}, ConsistentRead=True).get('Item')
    if marker:
        return {'ignored': True}
    row = table.get_item(Key=row_key, ConsistentRead=True).get('Item')
    expected_upload = f'uploads/{owner}/memory-photos/{photo_id}.upload'
    if not row or row.get('userId') != f'memory-book#{owner}' or row.get('uploadKey') != expected_upload:
        raise ValueError('Photo upload is unavailable')
    if row.get('status') == 'complete' and row.get('objectKey') == f'photos/{owner}/{photo_id}.jpg':
        return {'status': 'complete'}
    try:
        table.update_item(Key=row_key, UpdateExpression='SET #s = :processing, updatedAt = :now, leaseExpiresAt = :lease',
                          ConditionExpression='userId = :owner AND #s = :queued',
                          ExpressionAttributeNames={'#s': 'status'},
                          ExpressionAttributeValues={':owner': f'memory-book#{owner}', ':queued': 'queued', ':processing': 'processing',
                                                     ':now': datetime.now(timezone.utc).isoformat(), ':lease': int(datetime.now(timezone.utc).timestamp()) + 1800})
    except ClientError as exc:
        if exc.response['Error']['Code'] == 'ConditionalCheckFailedException':
            return {'duplicate': True}
        raise
    try:
        obj = s3.get_object(Bucket=BUCKET, Key=expected_upload)
        if int(obj.get('ContentLength', 0)) > 5 * 1024 * 1024:
            obj['Body'].close()
            raise ValueError('Photo exceeds size limit')
        with obj['Body'] as stream:
            raw = stream.read(5 * 1024 * 1024 + 1)
        if not raw or len(raw) > 5 * 1024 * 1024:
            raise ValueError('Invalid photo size')
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as source:
                if source.format not in ('JPEG', 'PNG', 'WEBP') or getattr(source, 'n_frames', 1) != 1:
                    raise ValueError('Unsupported image format')
                source.verify()
            with Image.open(io.BytesIO(raw)) as source:
                rgba = ImageOps.exif_transpose(source).convert('RGBA')
                image = Image.new('RGB', rgba.size, 'white')
                image.paste(rgba, mask=rgba.getchannel('A'))
                image.thumbnail((2400, 2400), Image.Resampling.LANCZOS)
                output = io.BytesIO()
                image.save(output, format='JPEG', quality=88, optimize=True, progressive=True)
                normalized = output.getvalue()
        if len(normalized) > 5 * 1024 * 1024:
            raise ValueError('Normalized photo exceeds size limit')
        if table.get_item(Key={'uploadId': f'account#{owner}'}, ConsistentRead=True).get('Item'):
            return {'ignored': True}
        photo_key = f'photos/{owner}/{photo_id}.jpg'
        s3.put_object(Bucket=BUCKET, Key=photo_key, Body=normalized, ContentType='image/jpeg',
                      ServerSideEncryption='AES256', CacheControl='private, no-store', Metadata={'owner': owner})
        table.update_item(Key=row_key, UpdateExpression='SET #s = :complete, objectKey = :key, updatedAt = :now REMOVE leaseExpiresAt, #failure',
                          ConditionExpression='userId = :owner AND #s = :processing',
                          ExpressionAttributeNames={'#s': 'status', '#failure': 'error'},
                          ExpressionAttributeValues={':owner': f'memory-book#{owner}', ':processing': 'processing', ':complete': 'complete', ':key': photo_key, ':now': datetime.now(timezone.utc).isoformat()})
        try:
            s3.delete_object(Bucket=BUCKET, Key=expected_upload)
        except ClientError:
            pass
        return {'status': 'complete'}
    except Exception as exc:
        table.update_item(Key=row_key, UpdateExpression='SET #s = :failed, #failure = :error, updatedAt = :now REMOVE leaseExpiresAt',
                          ConditionExpression='userId = :owner', ExpressionAttributeNames={'#s': 'status', '#failure': 'error'},
                          ExpressionAttributeValues={':owner': f'memory-book#{owner}', ':failed': 'failed', ':error': type(exc).__name__, ':now': datetime.now(timezone.utc).isoformat()})
        raise


class PrivateMemoryURLFetcher(URLFetcher):
    """Allow only the packaged guide tile and owner-checked embedded photos."""
    def __init__(self):
        super().__init__(allowed_protocols=('data',), fail_on_errors=False)

    def fetch(self, url, headers=None):
        if url == DOT_GUIDE_TILE:
            return URLFetcherResponse(url=url, body=base64.b64decode(url.split(',', 1)[1], validate=True),
                                      headers={'Content-Type': 'image/png'})
        if url.startswith('data:image/jpeg;base64,') and len(url) <= 8 * 1024 * 1024:
            payload = base64.b64decode(url.split(',', 1)[1], validate=True)
            return URLFetcherResponse(url=url, body=payload, headers={'Content-Type': 'image/jpeg'})
        # Let WeasyPrint turn this into its normal non-fatal URLFetchingError.
        raise ValueError('External resource fetches are disabled')


safe_fetcher = PrivateMemoryURLFetcher()


def load_source_transcript(owner, journal):
    key = journal.get('transcriptKey')
    upload_id = journal.get('uploadId')
    allowed = (f'transcripts/{owner}/{upload_id}.txt', f'transcripts/{upload_id}.txt')
    if key not in allowed:
        raise ValueError('Journal transcript is unavailable')
    obj = s3.get_object(Bucket=BUCKET, Key=key)
    with obj['Body'] as stream:
        raw = stream.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError('Journal transcript is too large')
    return raw.decode('utf-8')


def resolve_journal_page_snapshots(owner, book):
    entries, refs = book.get('entries'), book.get('pageRefs')
    if not isinstance(entries, list) or not isinstance(refs, list) or not entries or len(entries) != len(refs) or len(entries) > 500:
        raise ValueError('Journal page export references are invalid')
    pages = []
    photo_ids = set()
    seen = set()
    total_text_bytes = 0
    try: book_zone = ZoneInfo(book.get('timezone', 'UTC'))
    except Exception: book_zone = ZoneInfo('UTC')
    for entry, ref in zip(entries, refs):
        if isinstance(entry, dict) and isinstance(ref, dict) and ref.get('journalId') == entry.get('id'):
            # Read snapshots created before daily canvases were introduced.
            journal_id = entry.get('id')
            source = table.get_item(Key={'uploadId': journal_id}, ConsistentRead=True).get('Item') or {}
            expected_transcript = f'transcripts/{owner}/{journal_id}.txt'
            if (source.get('userId') != owner or source.get('status') == 'deleting' or
                    source.get('transcriptKey') not in (expected_transcript, f'transcripts/{journal_id}.txt') or
                    entry.get('date') != source.get('createdAt')):
                raise ValueError('A selected journal page is unavailable')
            raw_revision = ref.get('pageRevision')
            try: page_revision = int(raw_revision)
            except (TypeError, ValueError, OverflowError) as exc: raise ValueError('A journal page revision is invalid') from exc
            if isinstance(raw_revision, bool) or page_revision < 0 or page_revision != raw_revision:
                raise ValueError('A journal page revision is invalid')
            if page_revision == 0:
                blocks, highlight_page = default_journal_page_blocks(load_source_transcript(owner, source)), False
            else:
                legacy_key = f'journal-page-version#{owner}#{journal_id}#{page_revision}'
                legacy = table.get_item(Key={'uploadId': legacy_key}, ConsistentRead=True).get('Item') or {}
                if legacy.get('userId') != f'memory-book#{owner}' or legacy.get('recordType') != 'journal-page-version' or legacy.get('journalId') != journal_id or int(legacy.get('revision', -1)) != page_revision or not isinstance(legacy.get('blocks'), list):
                    raise ValueError('A saved journal page revision is unavailable')
                blocks, highlight_page = legacy['blocks'], legacy.get('highlightPage', False)
            for block in blocks:
                if block.get('kind') == 'image':
                    photo_id = block.get('photoId')
                    if not isinstance(photo_id, str) or not re.fullmatch(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}', photo_id): raise ValueError('A selected page image is invalid')
                    photo_ids.add(photo_id)
                elif block.get('kind') == 'text' and isinstance(block.get('text'), str): total_text_bytes += len(block['text'].encode('utf-8'))
            if total_text_bytes > 5 * 1024 * 1024: raise ValueError('The selected journal pages exceed the 5 MiB export text limit')
            pages.append({'journalId': journal_id, 'revision': page_revision, 'title': entry.get('title'), 'date': entry.get('date'), 'blocks': blocks, 'highlightPage': highlight_page})
            continue
        if (not isinstance(entry, dict) or not isinstance(ref, dict) or entry.get('included') is not True or
                not isinstance(entry.get('id'), str) or entry['id'] in seen or ref.get('dayKey') != entry['id']):
            raise ValueError('A daily page reference is invalid')
        day_key = entry['id']
        seen.add(day_key)
        raw_revision, source_ids = ref.get('pageRevision'), ref.get('sourceIds')
        try: page_revision = int(raw_revision)
        except (TypeError, ValueError, OverflowError) as exc: raise ValueError('A daily page revision is invalid') from exc
        if (isinstance(raw_revision, bool) or page_revision < 0 or page_revision != raw_revision or
                not isinstance(source_ids, list) or not source_ids or len(source_ids) > 500 or
                any(not isinstance(value, str) for value in source_ids) or len(set(source_ids)) != len(source_ids)):
            raise ValueError('A daily page reference is invalid')
        source_rows, source_defaults = {}, {}
        for journal_id in source_ids:
            if not isinstance(journal_id, str) or not re.fullmatch(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}', journal_id):
                raise ValueError('A daily page source is invalid')
            source = table.get_item(Key={'uploadId': journal_id}, ConsistentRead=True).get('Item') or {}
            expected_transcript = f'transcripts/{owner}/{journal_id}.txt'
            if source.get('userId') != owner or source.get('status') == 'deleting' or source.get('transcriptKey') not in (expected_transcript, f'transcripts/{journal_id}.txt'):
                raise ValueError('A selected daily page source is unavailable')
            stamp = datetime.fromisoformat(source['createdAt'].replace('Z', '+00:00'))
            if stamp.tzinfo is None or stamp.astimezone(book_zone).date().isoformat() != day_key:
                raise ValueError('A selected daily page source changed dates')
            original = load_source_transcript(owner, source)
            source_rows[journal_id] = source
            for index, block in enumerate(default_journal_page_blocks(original)):
                source_defaults[f'source-{journal_id}-{index + 1:04d}'] = {**block, 'id': f'source-{journal_id}-{index + 1:04d}', 'source': True, 'sourceJournalId': journal_id}
        if page_revision == 0:
            # Match the API's revision-0 view, which lazily carries forward each
            # recording's existing page layout before the shared day is saved.
            stored_blocks, highlight_page = [], False
            legacy_revisions = ref.get('legacyPageRevisions', {})
            if not isinstance(legacy_revisions, dict): raise ValueError('A legacy daily page snapshot is invalid')
            for journal_id in source_ids:
                legacy_blocks = default_journal_page_blocks(load_source_transcript(owner, source_rows[journal_id]))
                legacy_highlight = False
                raw_legacy_revision = legacy_revisions.get(journal_id, 0)
                try: legacy_revision = int(raw_legacy_revision)
                except (TypeError, ValueError, OverflowError) as exc: raise ValueError('A legacy page revision is invalid') from exc
                if isinstance(raw_legacy_revision, bool) or legacy_revision < 0 or legacy_revision != raw_legacy_revision:
                    raise ValueError('A legacy page revision is invalid')
                if legacy_revision > 0:
                    legacy_version_key = f'journal-page-version#{owner}#{journal_id}#{legacy_revision}'
                    legacy_version = table.get_item(Key={'uploadId': legacy_version_key}, ConsistentRead=True).get('Item') or {}
                    if legacy_version.get('userId') != f'memory-book#{owner}' or legacy_version.get('recordType') != 'journal-page-version' or legacy_version.get('journalId') != journal_id or int(legacy_version.get('revision', -1)) != legacy_revision or not isinstance(legacy_version.get('blocks'), list):
                        raise ValueError('A saved journal page revision is unavailable')
                    legacy_blocks = legacy_version['blocks']
                    legacy_highlight = legacy_version.get('highlightPage', False)
                highlight_page = highlight_page or legacy_highlight
                for legacy_index, legacy_block in enumerate(legacy_blocks):
                    copied = dict(legacy_block)
                    if copied.get('source') or copied.get('id', '').startswith('source-'):
                        match = re.fullmatch(r'source-(\d+)', copied.get('id', ''))
                        source_number = int(match.group(1)) if match else legacy_index + 1
                        copied.update({'id': f'source-{journal_id}-{source_number:04d}', 'source': True, 'sourceJournalId': journal_id})
                    else:
                        copied['id'] = f'day-{journal_id}-{legacy_index + 1:04d}'
                    stored_blocks.append(copied)
        else:
            version_key = f'journal-day#{owner}#{day_key}#{page_revision}'
            version = table.get_item(Key={'uploadId': version_key}, ConsistentRead=True).get('Item') or {}
            if (version.get('userId') != f'memory-book#{owner}' or version.get('recordType') != 'journal-day-version' or
                    version.get('dayKey') != day_key or int(version.get('revision', -1)) != page_revision or not isinstance(version.get('blocks'), list)):
                raise ValueError('A saved daily page revision is unavailable')
            stored_blocks, highlight_page = version['blocks'], version.get('highlightPage', False)
        blocks, found_sources = [], set()
        for stored in stored_blocks:
            if stored.get('source'):
                source_id = stored.get('sourceJournalId')
                if source_id not in source_ids: continue
                default = source_defaults.get(stored.get('id'))
                if not default or default.get('sourceJournalId') != source_id: continue
                blocks.append({**default, **stored, 'text': default['text']})
                found_sources.add(stored['id'])
            else: blocks.append(stored)
        blocks.extend(block for block in source_defaults.values() if block['id'] not in found_sources)
        for block in blocks:
            if not isinstance(block, dict):
                raise ValueError('A saved journal page block is invalid')
            if block.get('kind') == 'image':
                photo_id = block.get('photoId')
                if not isinstance(photo_id, str) or not re.fullmatch(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}', photo_id):
                    raise ValueError('A selected page image is invalid')
                photo_ids.add(photo_id)
            elif block.get('kind') == 'text' and isinstance(block.get('text'), str):
                total_text_bytes += len(block['text'].encode('utf-8'))
        if total_text_bytes > 5 * 1024 * 1024:
            raise ValueError('The selected journal pages exceed the 5 MiB export text limit')
        pages.append({'journalId': day_key, 'revision': page_revision, 'title': entry.get('title'),
                      'date': entry.get('date'), 'blocks': blocks, 'highlightPage': highlight_page,
                      'sources': entry.get('records', [])})
    if len(photo_ids) > 50:
        raise ValueError('Too many page photos in one book')
    return pages, photo_ids


def render_html(book, image_urls, writing_heights=None):
    title = html.escape(str(book.get('title', 'Memory Book')))
    subtitle = html.escape(str(book.get('subtitle', '')))
    pages = []
    try:
        book_zone = ZoneInfo(book.get('timezone', 'UTC'))
    except Exception:
        book_zone = ZoneInfo('UTC')
    try:
        date_start = book.get('dateStart', '')
        date_end = book.get('dateEnd', '')
        eligible_entries = []
        for position, entry in enumerate(book.get('entries', [])):
            if not entry.get('included'):
                continue
            local_day = datetime.fromisoformat(str(entry.get('date', '')).replace('Z', '+00:00')).astimezone(book_zone).date().isoformat()
            if (date_start and local_day < date_start) or (date_end and local_day > date_end):
                continue
            eligible_entries.append((position, entry, local_day))
        month_keys = sorted({item[2][:7] for item in eligible_entries})
        requested_order = book.get('chapterOrder', [])
        if not isinstance(requested_order, list): requested_order = []
        ordered_months = [key for key in requested_order if key in month_keys]
        ordered_months += [key for key in month_keys if key not in ordered_months]
        if memory_template(book).get('id') != 'notebook-v1':
            month_rank = {key: index for index, key in enumerate(ordered_months)}
            eligible_entries.sort(key=lambda item: (month_rank[item[2][:7]], item[0]))
    except (ValueError, TypeError):
        raise ValueError('A memory date or range is invalid')
    template = memory_template(book)
    previous_month = None
    for index, (_, entry, local_day) in enumerate(eligible_entries, 1):
        if not entry.get('approved'):
            raise ValueError('All included memories must be approved')
        heading = html.escape(str(entry.get('title', 'A memory')))
        date = html.escape(local_day)
        stamp = datetime.fromisoformat(str(entry.get('date', '')).replace('Z', '+00:00')).astimezone(book_zone)
        month_key = stamp.strftime('%Y-%m')
        if month_key != previous_month and template.get('id') != 'notebook-v1':
            chapter_title = (book.get('chapterTitles') or {}).get(month_key) or stamp.strftime('%B %Y')
            pages.append(f'<section class="chapter"><h1>{html.escape(chapter_title)}</h1></section>')
            previous_month = month_key
        is_notebook = template.get('id') == 'notebook-v1'
        if is_notebook:
            entry['_notebook'] = True
        all_quotes = [quote for quote in entry.get('quotes', []) if isinstance(quote, str) and quote]
        quote_display = entry.get('quoteDisplay', 'both')
        quote_modes = entry.get('quoteModes', {}) if isinstance(entry.get('quoteModes', {}), dict) else {}
        quotes = [quote for quote in all_quotes if quote_modes.get(quote, quote_display) in ('both', 'inline')]
        inline_quotes = [quote for quote in all_quotes if quote_modes.get(quote, quote_display) in ('both', 'inline')]
        quote_pattern = re.compile('(' + '|'.join(re.escape(value) for value in sorted(set(inline_quotes), key=len, reverse=True)) + ')') if inline_quotes else None
        annotation = html.escape(str(entry.get('annotation', '')))
        note = f'<aside class="annotation">{annotation}</aside>' if annotation and template.get('id') != 'notebook-v1' else ''
        blocks = ''.join(template_slot_html(slot, entry, local_day, index, book_zone, image_urls, all_quotes, quote_pattern, writing_heights)
                         for slot in template.get('slots', []))
        notebook_attrs = ' data-notebook-entry="true"' if template.get('id') == 'notebook-v1' else ''
        pages.append(f'<section class="memory template-{html.escape(str(template.get("id", "default")))}"{notebook_attrs}>{blocks}{note}</section>')
        source = str(entry.get('original_text', ''))
        if any(not quote or quote not in source for quote in all_quotes):
            raise ValueError('A selected quote is not an exact source substring')
    cover_photo = image_urls.get(book.get('coverPhotoId')) if book.get('coverPhotoId') else None
    cover_img = f'<img class="cover-image" src="{cover_photo}" alt="Book cover">' if cover_photo else ''
    included_dates = [day for _, _, day in eligible_entries]
    range_start = html.escape(str(book.get('dateStart') or (min(included_dates) if included_dates else '')))
    range_end = html.escape(str(book.get('dateEnd') or (max(included_dates) if included_dates else '')))
    range_line = f'<small>{range_start} — {range_end}</small>' if range_start and range_end else ''
    cover_background = book.get('coverBackground', book.get('pageColor', '#fffefa'))
    if not re.fullmatch(r'#[0-9A-Fa-f]{6}', str(cover_background)): cover_background = '#fffefa'
    cover_font = {'serif': 'DejaVu Serif, serif', 'sans': 'DejaVu Sans, sans-serif'}.get(book.get('coverFont', 'serif'), 'DejaVu Serif, serif')
    body = f'<section class="cover" style="background-color:{cover_background};font-family:{cover_font}">{cover_img}<small>MY MEMORY BOOK</small><h1>{title}</h1><p>{subtitle}</p>{range_line}</section>' + ''.join(pages)
    if book.get('yearSectionEnabled'):
        selected_quotes = []
        for _, entry, local_day in eligible_entries:
            quote_modes = entry.get('quoteModes', {}) if isinstance(entry.get('quoteModes', {}), dict) else {}
            for quote in entry.get('quotes', []):
                if quote_modes.get(quote, entry.get('quoteDisplay', 'both')) != 'exclude':
                    selected_quotes.append(f'<blockquote>{html.escape(quote)}<small>{html.escape(local_day)}</small></blockquote>')
        note = book.get('yearSectionText', '').strip()
        if selected_quotes or note:
            annotation = f'<aside class="annotation">{html.escape(note)}</aside>' if note else ''
            body += '<section class="memory year-words"><h1>Year in My Own Words</h1>' + ''.join(selected_quotes) + annotation + '</section>'
    for reflection in book.get('reflections', []):
        if not reflection.get('included'):
            continue
        if reflection.get('aiGenerated') is not True or not reflection.get('approved') or not reflection.get('sourceIds'):
            raise ValueError('Included reflections must be AI labeled, sourced, and approved')
        coverage = reflection.get('coverage', {})
        period_label = 'Monthly' if reflection.get('period') == 'month' else 'Yearly'
        label = f"{period_label} reflection · {reflection.get('key', '')}"
        coverage_line = f"Based on {coverage.get('journal_count', 0)} journals · {coverage.get('start_date', '')} to {coverage.get('end_date', '')}"
        content = html.escape(reflection.get('text', '')).replace('\n', '<br>')
        body += f'<section class="memory reflection"><small>AI-generated</small><h1>{html.escape(label)}</h1><p>{html.escape(coverage_line)}</p><p>{content}</p></section>'
    theme = book.get('theme', 'Classic diary')
    texture = book.get('texture', 'Linen')
    font = {'serif': 'DejaVu Serif, serif', 'sans': 'DejaVu Sans, sans-serif'}.get(book.get('bodyFont', 'sans' if theme == 'Minimalist' else 'serif'), 'DejaVu Serif, serif')
    backgrounds = {'Plain':'#fffefa','Linen':'#f7f3ea','Parchment':'#f4e8cf','Recycled paper':'#eeeade'}
    font_size = max(14, min(24, int(book.get('fontSize', 17))))
    heading_font = {'serif': 'DejaVu Serif, serif', 'sans': 'DejaVu Sans, sans-serif', 'handwriting': 'DejaVu Serif, serif'}.get(book.get('headingFont', 'serif'), 'DejaVu Serif, serif')
    paper = book.get('pageColor', backgrounds.get(texture, '#fffefa'))
    ink = book.get('textColor', '#43332e')
    if not re.fullmatch(r'#[0-9A-Fa-f]{6}', str(paper)): paper = backgrounds.get(texture, '#fffefa')
    if not re.fullmatch(r'#[0-9A-Fa-f]{6}', str(ink)): ink = '#43332e'
    page = template.get('page', {})
    page_width = max(100, min(400, int(page.get('widthMm', 210))))
    page_height = max(100, min(400, int(page.get('heightMm', 297))))
    margin = max(10, min(35, int(page.get('marginMm', 18))))
    spacing = max(13, min(24, int(book.get('lineSpacing', 17)))) / 10
    border = '1px solid #c8b7a8' if book.get('pageBorder', True) else 'none'
    heading_size = max(18, min(34, int(book.get('headingSize', 22))))
    texture_css = {'Plain': '', 'Linen': 'body{background-image:linear-gradient(180deg,#806e5e08 0%,transparent 20%,transparent 80%,#806e5e08 100%)}', 'Parchment': 'body{background-image:linear-gradient(135deg,#806e5e0c,#ffffff00 45%,#806e5e08)}', 'Recycled paper': 'body{background-image:linear-gradient(0deg,#6270620a,#ffffff00 35%,#62706208)}'}
    css = '''@page { size:$WIDTHmm $HEIGHTmm; margin:$MARGINmm $MARGINmm 16mm; @bottom-center { content:counter(page); color:#8a776b; font-size:9pt } }
      body { font-size:$SIZEpt; line-height:$SPACE; font-family:$FONT; color:$INK; background-color:$PAPER }
      .cover { box-sizing:border-box; page-break-after:always; height:220mm; display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center; border:$BORDER; padding:12mm; background:$PAPER }
      .cover h1 { font-size:32pt; font-weight:normal } .cover-image { width:100%; height:72mm; object-fit:cover; margin-bottom:12mm }
      .memory { page-break-before:always; overflow-wrap:anywhere } .memory h1,.chapter h1 { font-family:$HEAD; font-size:$HEADINGpt; font-weight:normal; margin:8mm 0 } .memory p { white-space:pre-wrap }
      .template-area { box-sizing:border-box; break-inside:avoid; page-break-inside:avoid; margin:0 0 5mm }
      .template-area.area-text { break-inside:auto; page-break-inside:auto; height:auto !important }
      .date-area { color:#8a776b; font-size:9pt; letter-spacing:.08em; text-transform:uppercase }
      .title-area { margin:5mm 0 8mm !important; border-bottom:1px solid #c8b7a8; padding-bottom:3mm }
      .story-area { line-height:$SPACE; overflow-wrap:anywhere }
      .image-area { min-height:38mm; padding:2mm; display:flex; flex-wrap:wrap; align-items:center; justify-content:center; border:1px solid #d8cfc5; background:#fff }
      .image-area img { max-width:100%; max-height:100%; object-fit:contain }
      .area-text { padding:5mm; border:1px solid #ded7cf; white-space:pre-wrap; overflow-wrap:anywhere }
      .writing-area { min-height:38mm; padding:3mm 4mm; border:1px solid #ded7cf; background-color:#fff }
      .quote-area { min-height:22mm; padding:3mm 5mm; border-left:2px solid #b98b72 }
      .quote-area blockquote { margin:0 0 3mm; font-style:italic; overflow-wrap:anywhere }
      .blank { background-color:#fff !important; }
      .writing-guides { width:100%; height:100%; display:flex; flex-direction:column; justify-content:space-evenly }
      .writing-guides i { display:block; width:100%; border-bottom:1px solid #e8e3dd; height:0 }
      .guide-open .writing-guides i { display:none }
      .guide-dot .writing-guides { background-image:url('$DOT_TILE'); background-repeat:repeat; background-size:4mm 4mm }
      .guide-dot .writing-guides i { display:none }
      .image-guides { position:absolute; inset:4mm; display:grid; grid-template-columns:8mm 1fr 8mm; grid-template-rows:8mm 1fr 8mm; pointer-events:none }
      .image-guides i { width:8mm; height:8mm; border-color:#ded8d0; border-style:solid; border-width:0 }
      .image-guides i:nth-child(1) { grid-area:1/1; border-top-width:.3mm; border-left-width:.3mm }
      .image-guides i:nth-child(2) { grid-area:1/3; border-top-width:.3mm; border-right-width:.3mm }
      .image-guides i:nth-child(3) { grid-area:3/1; border-bottom-width:.3mm; border-left-width:.3mm }
      .image-guides i:nth-child(4) { grid-area:3/3; border-bottom-width:.3mm; border-right-width:.3mm }
      .image-area { position:relative }
      .image-mount { border:4mm solid #fff; outline:1px solid #ded8d0 }
      .image-frame { border:1px solid #d8cfc5 }
      .memory figure { margin:10mm 0; text-align:center; break-inside:avoid } .memory img { display:block; max-width:100%; max-height:140mm; object-fit:cover; margin:auto }
      .memory figure.full-photo img { width:100%; height:220mm; max-height:220mm } .memory figcaption { font-size:10pt; color:#75675e; margin-top:3mm }
      .full-photo-page { page-break-before:always; height:235mm; display:flex; flex-direction:column; justify-content:center; align-items:center; break-inside:avoid }.full-photo-page img { width:100%; height:215mm; object-fit:cover }.full-photo-page p { font-size:10pt; color:#75675e }
      .gallery,.collage { display:grid; grid-template-columns:repeat(2,1fr); gap:4mm } .gallery figure,.collage figure { margin:0 } .gallery img { max-height:65mm } .collage figure:first-child { grid-column:span 2 }
      .chapter { page-break-before:always; min-height:200mm; display:flex; justify-content:center; align-items:center; text-align:center } .chapter h1 { font-size:30pt; font-weight:normal }.annotation{margin-top:12mm;padding:6mm;border-left:2px solid #b98b72;font-style:italic}.year-words{white-space:pre-wrap}mark{background:#f4df91;color:inherit}
      .quote { display:flex; flex-direction:column; justify-content:center; min-height:190mm } .quote blockquote { font-size:21pt; line-height:1.5; margin:0 0 12mm; border-left:2px solid #b98b72; padding-left:10mm }
      .year-words blockquote { margin:0 0 8mm; padding-left:6mm; border-left:2px solid #b98b72; break-inside:avoid }
      .year-words blockquote small { display:block; margin-top:1mm; font-size:10pt }'''
    if template.get('id') == 'notebook-v1':
        css += '''
      .template-notebook-v1 { box-sizing:border-box; min-height:263mm; }
      .template-notebook-v1 { font-size:12.5pt; line-height:1.5; }
      .template-notebook-v1 .date-area { font-size:9pt; text-transform:none; letter-spacing:.04em; margin-bottom:2mm }
      .template-notebook-v1 .title-area { border:0; padding:0; margin:0 0 5mm !important; font-size:26pt; color:#59483d }
      .template-notebook-v1 .image-area { background:#fffefa; border-color:#e6ded5; }
      .template-notebook-v1 .story-area { line-height:1.5; break-inside:auto; page-break-inside:auto; }
      .template-notebook-v1 .story-area p { margin:0 0 4mm; orphans:2; widows:2; }
      .template-notebook-v1 .writing-area { min-height:14mm; margin-top:2mm; background-color:#fffefa; }
      .template-notebook-v1 .writing-area.is-reserved { min-height:0; border:0; padding:0 0 0 10mm; background-color:transparent !important; background-image:none; }
      .template-notebook-v1 .writing-area.is-reserved .writing-guides { display:block; position:relative; width:100%; height:100%; }
      .template-notebook-v1 .writing-area.is-reserved .writing-guides::before { content:""; position:absolute; left:-7.5mm; top:0; bottom:0; border-left:.3mm solid #e4cdc4; }
      .template-notebook-v1 .writing-area.is-reserved .writing-guides .notebook-rule { display:block; width:100%; height:7mm; box-sizing:border-box; margin:0; border:0; border-bottom:.18mm solid #e7e1da; }
      .template-notebook-v1 .notebook-user-writing { min-height:0; border:0; padding:2mm 0; background:transparent; white-space:pre-wrap; overflow-wrap:anywhere; }
      .notebook-stickers { display:flex; flex:0 0 auto; align-items:center; gap:3mm; min-height:9mm; margin:0 0 1mm; }
      .notebook-stickers svg { width:8mm; height:8mm; }
      .notebook-stickers .personal-sticker { width:10mm; height:10mm; object-fit:contain; }
      .template-notebook-v1 .annotation { margin-top:2mm; }
      .template-notebook-v1 .notebook-marginal-quote { min-height:0 !important; margin:1mm 0 2mm; padding:0 2mm; border-left:1px solid #b98b72; font-size:10pt; color:#766a64; }'''
    css = (css.replace('$DOT_TILE', DOT_GUIDE_TILE).replace('$WIDTH', str(page_width)).replace('$HEIGHT', str(page_height))
           .replace('$SIZE', str(font_size)).replace('$SPACE', str(spacing)).replace('$FONT', font).replace('$HEADING', str(heading_size))
           .replace('$HEAD', heading_font).replace('$PAPER', paper).replace('$INK', ink)
           .replace('$MARGIN', str(margin)).replace('$BORDER', border))
    theme_class = 'theme-' + re.sub(r'[^a-z0-9-]', '', str(theme).lower().replace(' ', '-'))
    css += texture_css.get(texture, '')
    css += '.theme-vintage .cover{border:1px solid #bda885}.theme-scrapbook .cover{border:2px dashed #b98b72}.theme-editorial .cover{border-left:5mm solid #ad7562}.theme-minimalist .title-area{border-bottom:0}'
    if book.get('headingFont') == 'handwriting':
        css += '.memory h1,.chapter h1{font-style:italic;font-family:DejaVu Serif,cursive}'
    return '<!doctype html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body class="' + theme_class + '">' + body + '</body></html>'


def highlighted_text_html(text, highlight):
    if not isinstance(highlight, str) or not highlight or highlight not in text:
        return html.escape(text)
    return f'<mark>{html.escape(highlight)}</mark>'.join(html.escape(piece) for piece in text.split(highlight))


def render_journal_pages_html(book, pages, image_urls):
    """Render ordered, immutable journal page snapshots as A4 print pages."""
    if not isinstance(pages, list) or not pages:
        raise ValueError('No journal pages were selected')
    try:
        zone = ZoneInfo(book.get('timezone', 'UTC'))
    except Exception:
        zone = ZoneInfo('UTC')
    paper = book.get('pageColor', '#fffefa')
    if not re.fullmatch(r'#[0-9a-fA-F]{6}', str(paper)):
        paper = '#fffefa'
    ink = book.get('textColor', '#43332e')
    if not re.fullmatch(r'#[0-9a-fA-F]{6}', str(ink)):
        ink = '#43332e'
    body_font = 'DejaVu Sans, sans-serif' if book.get('bodyFont') == 'sans' else 'DejaVu Serif, serif'
    heading_font = {'sans': 'DejaVu Sans, sans-serif', 'handwriting': 'DejaVu Serif, serif'}.get(book.get('headingFont', 'serif'), 'DejaVu Serif, serif')
    try:
        margin = max(12, min(35, int(book.get('marginMm', 18))))
    except (TypeError, ValueError):
        margin = 18
    template = memory_template(book)
    daily_style = template.get('dailyPrint', {})
    accent = daily_style.get('accent', '#8c675c')
    note_background = daily_style.get('noteBackground', '#f3eee8')
    note_border = daily_style.get('noteBorder', accent)
    photo_border = daily_style.get('photoBorder', '#d8cfc5')
    treatment = daily_style.get('treatment', 'daily-notes')
    if not all(re.fullmatch(r'#[0-9a-fA-F]{6}', str(color)) for color in (accent, note_background, note_border, photo_border)):
        raise ValueError('A daily print template style is invalid')
    include_highlights = book.get('includeHighlights') is True
    grouped_days = []
    day_lookup = {}
    highlight_items = []
    for page in pages:
        if not isinstance(page, dict) or not isinstance(page.get('blocks'), list):
            raise ValueError('An immutable page snapshot is invalid')
        try:
            stamp = datetime.fromisoformat(str(page['date']).replace('Z', '+00:00')).astimezone(zone)
        except (ValueError, TypeError, KeyError) as exc:
            raise ValueError('A journal page date is invalid') from exc
        display_date = stamp.strftime('%B %d, %Y').replace(' 0', ' ')
        day_key = stamp.date().isoformat()
        title = html.escape(str(page.get('title') or 'Journal entry'))
        reference = f'<small>{html.escape(display_date)} · {title}</small>'
        if include_highlights and page.get('highlightPage') is True:
            highlight_items.append(f'<li class="whole-page-highlight"><strong>{title}</strong>{reference}<p>Selected journal page</p></li>')
        block_html = []
        seen_source_ids = set()
        source_titles = {source.get('id'): source.get('title', 'Recording') for source in page.get('sources', []) if isinstance(source, dict)}
        for block in page['blocks']:
            if not isinstance(block, dict) or block.get('width') not in ('full', 'wide', 'half'):
                raise ValueError('A page block or width is invalid')
            source_id = block.get('sourceJournalId') if block.get('source') else None
            if source_id and source_id not in seen_source_ids:
                seen_source_ids.add(source_id)
                source_title = html.escape(str(source_titles.get(source_id, 'Recording')))
                block_html.append(f'<h2 class="journal-source-heading">{source_title}</h2>')
            block_class = f'page-block width-{block["width"]}'
            try:
                x, y, rotation = int(block.get('x', 0)), int(block.get('y', 0)), int(block.get('rotation', 0))
                if not -180 <= x <= 180 or not -300 <= y <= 300 or not -30 <= rotation <= 30:
                    raise ValueError
                raw_width = block.get('widthPercent')
                width_percent = int(raw_width) if raw_width is not None else None
                if raw_width is not None and (isinstance(raw_width, bool) or width_percent != raw_width or not 20 <= width_percent <= 100):
                    raise ValueError
                raw_height = block.get('heightMm')
                height_mm = int(raw_height) if raw_height is not None else None
                if raw_height is not None and (isinstance(raw_height, bool) or height_mm != raw_height or not 15 <= height_mm <= 260):
                    raise ValueError
            except (TypeError, ValueError):
                raise ValueError('A page block layout is invalid')
            layer = block.get('layer')
            if layer is not None and (isinstance(layer, bool) or not isinstance(layer, int) or not 1 <= layer <= 500):
                raise ValueError('A page layer is invalid')
            # Layers do not change source order, only the drawing order when blocks overlap.
            z_index = 600 - (layer if layer is not None else len(page['blocks']))
            layout_style = f'position:relative;z-index:{z_index};transform:translate({x}mm,{y}mm) rotate({rotation}deg)' + (f';width:{width_percent}%' if width_percent is not None else '') + (f';min-height:{height_mm}mm' if height_mm is not None else '')
            if block.get('kind') == 'text':
                text = block.get('text')
                if not isinstance(text, str):
                    raise ValueError('A page text block is invalid')
                font_size = block.get('fontSize', 16)
                if (isinstance(font_size, bool) or not isinstance(font_size, (int, Decimal)) or
                        int(font_size) != font_size or not 10 <= int(font_size) <= 32):
                    raise ValueError('A page text size is invalid')
                font_size = int(font_size)
                highlight = block.get('highlight') if include_highlights else None
                if highlight is not None and (not isinstance(highlight, str) or highlight not in text):
                    raise ValueError('A selected sentence no longer matches its page block')
                if block.get('style') == 'note':
                    block_class += ' block-note'
                block_html.append(f'<div class="{block_class} block-text" style="{layout_style};font-size:{font_size}pt">{highlighted_text_html(text, highlight)}</div>')
                if include_highlights and highlight:
                    highlight_items.append(f'<li class="sentence-highlight"><blockquote>{html.escape(highlight)}</blockquote>{reference}</li>')
            elif block.get('kind') == 'image':
                photo_id = block.get('photoId')
                image = image_urls.get(photo_id)
                if not image or not image.startswith('data:image/jpeg;base64,'):
                    raise ValueError('A selected page image is unavailable')
                caption = html.escape(str(block.get('caption', '')))
                highlighted = ' image-highlight' if include_highlights and block.get('highlight') is True else ''
                caption_html = f'<figcaption>{caption}</figcaption>' if caption else ''
                block_html.append(f'<figure class="{block_class} block-image{highlighted}" style="{layout_style}"><img src="{html.escape(image, quote=True)}" alt="{caption or title}">{caption_html}</figure>')
                if include_highlights and block.get('highlight') is True:
                    highlight_items.append(f'<li class="photo-highlight"><img src="{html.escape(image, quote=True)}" alt="{caption or title}">{caption_html}{reference}</li>')
            else:
                raise ValueError('A page block kind is invalid')
        if day_key not in day_lookup:
            day_lookup[day_key] = {'date': display_date, 'records': [], 'highlight': False}
            grouped_days.append(day_lookup[day_key])
        day_group = day_lookup[day_key]
        day_group['records'].append(
            f'<div class="journal-day-record">'
            f'<h2>{title}</h2>'
            f'<div class="journal-page-blocks">{"".join(block_html)}</div>'
            f'</div>'
        )
        day_group['highlight'] = day_group['highlight'] or (include_highlights and page.get('highlightPage') is True)
    sections = []
    for day_index, day_group in enumerate(grouped_days):
        page_highlight = ' page-highlight' if day_group['highlight'] else ''
        first_class = ' first-page' if day_index == 0 else ''
        date_label = html.escape(day_group['date'])
        sections.append(f'<section class="journal-page journal-day-page{first_class}{page_highlight}"><header class="journal-page-header">'
                        f'<h1>{date_label}</h1></header>'
                        f'<div class="journal-day-records">{"".join(day_group["records"])}</div></section>')
    appendix = ''
    if include_highlights and highlight_items:
        appendix = '<section class="highlights-page"><h1>Highlights</h1><ol>' + ''.join(highlight_items) + '</ol></section>'
    css = f'''@page {{ size:A4; margin:{margin}mm {margin}mm 16mm; @bottom-center {{ content:counter(page); color:#8a776b; font-size:9pt }} }}
      * {{ box-sizing:border-box }} body {{ margin:0; color:{ink}; background:{paper}; font-family:{body_font}; font-size:12pt; line-height:1.55 }}
      .journal-page {{ page-break-before:always; break-before:page; padding:0 0 4mm; overflow-wrap:anywhere }}
      .journal-page.first-page {{ page-break-before:auto; break-before:auto }}
      .journal-page-header {{ border-bottom:1px solid {accent}; margin:0 0 8mm; padding:0 0 4mm }}
      .journal-page-header time {{ display:block; color:#796b62; font-size:9.5pt; margin-bottom:2mm }}
      .journal-page-header h1 {{ margin:0; color:{accent}; font-family:{heading_font}; font-size:25pt; font-weight:normal; line-height:1.2 }}
      .journal-day-record {{ margin:0 0 7mm }} .journal-day-record h2 {{ margin:0 0 3mm; color:{ink}; font-family:{heading_font}; font-size:13pt; font-weight:600; line-height:1.25 }}
      .journal-page-blocks {{ font-size:0; line-height:normal }}
      .journal-source-heading {{ clear:both; margin:7mm 0 2mm; color:{accent}; font-family:{heading_font}; font-size:12pt; font-weight:normal }}
      .page-block {{ display:block; min-width:0; margin:0 0 6mm; color:{ink}; font-size:12pt; line-height:1.55; white-space:pre-wrap; overflow-wrap:anywhere; orphans:2; widows:2 }}
      .width-full {{ width:100% }} .width-wide {{ width:74% }} .width-half {{ width:49% }}
      .block-note {{ padding:4mm 5mm; background:{note_background}; border-left:1.2mm solid {note_border}; color:#5e5149; font-style:italic }}
      .block-image {{ white-space:normal; text-align:center; break-inside:avoid; page-break-inside:avoid; padding:2mm; border:1px solid {photo_border} }}
      .block-image img {{ display:block; width:100%; max-width:100%; max-height:155mm; object-fit:contain; margin:0 auto }}
      .block-image figcaption {{ margin-top:2mm; color:#75675e; font-size:10pt; text-align:center }}
      .image-highlight {{ outline:1.2mm solid #ead6a2; outline-offset:1mm }}
      .page-highlight .journal-page-header {{ border-bottom:1.2mm solid #ead6a2 }}
      .page-highlight .journal-page-header::after {{ content:'Selected page'; display:block; color:{accent}; font-size:8pt; letter-spacing:.08em; text-transform:uppercase; margin-top:2mm }}
      .highlights-page {{ page-break-before:always; break-before:page }} .highlights-page h1 {{ color:{accent}; font-family:{heading_font}; font-size:26pt; font-weight:normal }}
      .highlights-page ol {{ list-style:none; margin:8mm 0 0; padding:0 }} .highlights-page li {{ margin:0 0 8mm; padding:0 0 5mm; border-bottom:1px solid #e4ddd6; break-inside:avoid }}
      .highlights-page li small {{ display:block; margin-top:1mm; color:#786b63; font-size:9pt }} .highlights-page blockquote {{ margin:0; border-left:1mm solid #ead6a2; padding-left:4mm; font-size:13pt }}
      .highlights-page .photo-highlight img {{ display:block; max-width:55mm; max-height:45mm; object-fit:contain; margin-bottom:2mm }}
      .highlights-page .whole-page-highlight p {{ margin:2mm 0 0; color:#665951 }}
      .eyebrow {{ color:{accent}; font-size:8pt; letter-spacing:.08em; text-transform:uppercase }}
      mark {{ background:#f4df91; color:inherit; padding:0 .04em }}
      body.treatment-field-journal .journal-page {{ background-image:radial-gradient({accent}22 .55px,transparent .55px); background-size:4mm 4mm }}
      body.treatment-photo-album .journal-page-header {{ text-align:center; border-bottom-width:2px }}
      body.treatment-story-letter .journal-page-header {{ border-bottom:2px double {accent}; padding-bottom:6mm }}
      body.treatment-minimal-record .journal-page-header {{ border-bottom:0; border-left:2mm solid {accent}; padding-left:5mm }}
      body.treatment-notebook .journal-page {{ background-image:repeating-linear-gradient(transparent 0,transparent 8mm,{accent}16 8.1mm,transparent 8.3mm) }}'''
    return '<!doctype html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body class="treatment-' + html.escape(str(treatment)) + '">' + ''.join(sections) + appendix + '</body></html>'


def measure_notebook_writing_heights(document, book):
    """Use one Weasy layout pass to fill each entry's actual remaining page space."""
    if memory_template(book).get('id') != 'notebook-v1':
        return {}
    heights = {}
    positions = {}
    bottom_margin_px = 16 * 96 / 25.4
    for page in document.pages:
        for anchor_id, anchor in page.anchors.items():
            if anchor_id.startswith('notebook-fill-'):
                y = anchor[1]
                remaining_mm = max(0, (page.height - bottom_margin_px - y) * 25.4 / 96)
                positions[anchor_id] = round(max(0, remaining_mm - 4), 1)
    for entry in book.get('entries', []):
        if not entry.get('included'):
            continue
        anchor_id = f'notebook-fill-{entry.get("id", "")}'
        heights[entry.get('id')] = positions.get(anchor_id, 0)
    return heights


def render_quick_html(snapshot, entries):
    themes={'Minimalist':('#ffffff','#262626','DejaVu Sans'),'Vintage':('#f4e8cf','#563c2d','DejaVu Serif'),'Scrapbook':('#fff8e9','#543c35','DejaVu Sans'),'Classic diary':('#fffefa','#43332e','DejaVu Serif'),'Editorial':('#f8f8f5','#222c37','DejaVu Serif')}
    theme=snapshot.get('template','Minimalist')
    if theme not in themes: raise ValueError('Unsupported template')
    paper,ink,font=themes[theme]
    try: zone=ZoneInfo(snapshot['timezone'])
    except Exception: raise ValueError('Invalid timezone')
    blocks=[]
    for entry in entries:
        day=datetime.fromisoformat(entry['date'].replace('Z','+00:00')).astimezone(zone).date().isoformat()
        paragraphs=''.join('<p>'+html.escape(part)+'</p>' for part in entry['text'].split('\n\n') if part.strip())
        blocks.append(f'<article><time>{html.escape(day)}</time><h2>{html.escape(entry["title"])}</h2>{paragraphs}</article>')
    css=f'''@page{{size:A4;margin:20mm 20mm 24mm;@bottom-center{{content:counter(page);color:#8a776b;font-size:9pt}}}}body{{font:12pt/1.55 "{font}";color:{ink};background:{paper}}}h1{{font-size:26pt;font-weight:normal}}h2{{font-size:18pt;font-weight:normal;margin:3mm 0}}article{{border-bottom:1px solid #c8b7a8;padding:7mm 0;break-inside:auto}}article:first-of-type{{border-top:1px solid #c8b7a8}}time{{font-size:10pt;color:#75675e}}p{{white-space:pre-wrap;overflow-wrap:anywhere;margin:2mm 0 4mm}}'''
    if theme=='Vintage': css+='body{background-image:linear-gradient(135deg,#f4e8cf,#efe0c2)}'
    if theme=='Scrapbook': css+='article{border:1px dashed #b98b72;padding:8mm;margin:5mm 0;background:#fffaf1}'
    if theme=='Classic diary': css+='article{border-left:2px solid #b98b72;padding-left:7mm}'
    if theme=='Editorial': css+='h1{border-left:4mm solid #ad7562;padding-left:6mm}article{border-bottom:2px solid #d8d8d2}'
    title=f'Journal · {snapshot["startDate"]} – {snapshot["endDate"]}'
    return '<!doctype html><html><head><meta charset="utf-8"><style>'+css+'</style></head><body><h1>'+html.escape(title)+'</h1>'+''.join(blocks)+'</body></html>'


def quick_chronological(entries):
    return sorted(entries, key=lambda entry:(entry['date'],entry['id']))


def handler(event, context):
    if event.get('action') == 'normalize_photo':
        return normalize_photo(event['owner'], event['photo_id'])
    if event.get('action') == 'quick_export':
        owner, rid = event['owner'], event['job_id']
        job_id=f'quick-export#{owner}#{rid}'; key={'uploadId':job_id}
        if table.get_item(Key={'uploadId':f'account#{owner}'},ConsistentRead=True).get('Item'): return {'ignored':True}
        try:
            table.update_item(Key=key,UpdateExpression='SET #s=:rendering,updatedAt=:now,leaseExpiresAt=:lease',ConditionExpression='userId=:owner AND #s=:queued',ExpressionAttributeNames={'#s':'status'},ExpressionAttributeValues={':owner':f'memory-book#{owner}',':queued':'queued',':rendering':'rendering',':now':datetime.now(timezone.utc).isoformat(),':lease':int(datetime.now(timezone.utc).timestamp())+1800})
        except ClientError as exc:
            if exc.response['Error']['Code']=='ConditionalCheckFailedException': return {'duplicate':True}
            raise
        try:
            if table.get_item(Key={'uploadId':f'account#{owner}'},ConsistentRead=True).get('Item'): return {'ignored':True}
            job=table.get_item(Key=key,ConsistentRead=True).get('Item') or {}; snap=job.get('snapshot') or {}
            journal_ids=snap.get('journalIds',[])
            if job.get('userId')!=f'memory-book#{owner}' or job.get('recordType')!='quick-export' or not isinstance(journal_ids,list) or len(journal_ids)>500: raise ValueError('Invalid export snapshot')
            zone=ZoneInfo(snap['timezone']); entries=[]; total=0
            for journal_id in journal_ids:
                source=table.get_item(Key={'uploadId':journal_id},ConsistentRead=True).get('Item')
                if not source or source.get('userId') != owner or source.get('status') != 'completed':
                    continue
                stamp=datetime.fromisoformat(str(source.get('createdAt','')).replace('Z','+00:00'))
                local_day=stamp.astimezone(zone).date().isoformat()
                if not snap['startDate'] <= local_day <= snap['endDate']:
                    continue
                transcript_key=source.get('transcriptKey')
                expected=(f"transcripts/{owner}/{journal_id}.txt",f"transcripts/{journal_id}.txt")
                if transcript_key not in expected:
                    continue
                try:
                    obj = s3.get_object(Bucket=BUCKET, Key=transcript_key)
                except ClientError as exc:
                    if exc.response['Error']['Code'] in ('NoSuchKey', '404', 'NotFound'):
                        continue
                    raise
                with obj['Body'] as body: raw=body.read(256*1024+1)
                if not raw.strip():
                    continue
                if len(raw)>256*1024: raise ValueError('A transcript exceeds the 256 KiB limit')
                total+=len(raw)
                if total>5*1024*1024: raise ValueError('Export exceeds the 5 MiB transcript limit')
                entries.append({'id':journal_id,'title':source.get('title') or 'Untitled','date':source['createdAt'],'text':raw.decode('utf-8')})
            if not entries:
                raise ValueError('No completed journal transcripts are available')
            entries=quick_chronological(entries)
            data=HTML(string=render_quick_html(snap,entries),url_fetcher=lambda url: (_ for _ in ()).throw(ValueError('External resources are disabled'))).write_pdf()
            if table.get_item(Key={'uploadId':f'account#{owner}'},ConsistentRead=True).get('Item'): return {'ignored':True}
            object_key=f'exports/{owner}/quick/{rid}.pdf'
            s3.put_object(Bucket=BUCKET,Key=object_key,Body=data,ContentType='application/pdf',ServerSideEncryption='AES256',CacheControl='private, no-store')
            table.update_item(Key=key,UpdateExpression='SET #s=:complete,objectKey=:key,completedAt=:now REMOVE leaseExpiresAt,#e',ConditionExpression='userId=:owner AND #s=:rendering',ExpressionAttributeNames={'#s':'status','#e':'error'},ExpressionAttributeValues={':owner':f'memory-book#{owner}',':rendering':'rendering',':complete':'complete',':key':object_key,':now':datetime.now(timezone.utc).isoformat()})
            return {'status':'complete'}
        except Exception as exc:
            table.update_item(Key=key,UpdateExpression='SET #s=:failed,#e=:error REMOVE leaseExpiresAt',ConditionExpression='userId=:owner',ExpressionAttributeNames={'#s':'status','#e':'error'},ExpressionAttributeValues={':owner':f'memory-book#{owner}',':failed':'failed',':error':type(exc).__name__})
            raise
    owner, book_id, revision = event['owner'], event['book_id'], int(event['revision'])
    job_id = f'memory-export#{owner}#{book_id}#{revision}'
    job_key = {'uploadId': job_id}
    book_key = {'uploadId': f'memory-book#{owner}#{book_id}'}
    marker = table.get_item(Key={'uploadId': f'account#{owner}'}, ConsistentRead=True).get('Item')
    if marker:
        return {'ignored': True}
    if not memory_book_is_active(owner, book_id):
        discard_memory_export_job(owner, book_id, job_key)
        return {'ignored': True}
    try:
        table.update_item(Key=job_key, UpdateExpression='SET #s = :rendering, updatedAt = :now, leaseExpiresAt = :lease',
                          ConditionExpression='userId = :owner AND #s = :queued',
                          ExpressionAttributeNames={'#s': 'status'},
                          ExpressionAttributeValues={':owner': f'memory-book#{owner}', ':queued': 'queued', ':rendering': 'rendering',
                                                     ':now': datetime.now(timezone.utc).isoformat(), ':lease': int(datetime.now(timezone.utc).timestamp()) + 1800})
    except ClientError as exc:
        if exc.response['Error']['Code'] == 'ConditionalCheckFailedException':
            return {'duplicate': True}
        raise
    object_key = f'exports/{owner}/{book_id}/{revision}.pdf'
    written_version_id = None
    object_written = False
    try:
        job = table.get_item(Key=job_key, ConsistentRead=True).get('Item') or {}
        book = job.get('bookSnapshot')
        if (job.get('userId') != f'memory-book#{owner}' or job.get('recordType') != 'memory-export' or
                job.get('bookId') != book_id or not isinstance(book, dict) or int(book.get('revision', -1)) != revision):
            raise ValueError('Private export snapshot is unavailable')
        if not memory_book_is_active(owner, book_id):
            discard_memory_export_job(owner, book_id, job_key)
            return {'ignored': True}
        page_mode = book.get('contentMode') == 'journal-pages'
        pages = None
        if page_mode:
            pages, photo_ids = resolve_journal_page_snapshots(owner, book)
        else:
            for entry in book.get('entries', []):
                if not entry.get('included'):
                    continue
                source = table.get_item(Key={'uploadId': entry['id']}, ConsistentRead=True).get('Item')
                if not source or source.get('userId') != owner or source.get('status') != 'completed':
                    raise ValueError('A selected journal was removed or is unavailable')
                narrative_revision = int(entry.get('narrativeRevision', 0))
                narrative = table.get_item(Key={'uploadId': f'memory-narrative-version#{owner}#{entry["id"]}#{narrative_revision}'}, ConsistentRead=True).get('Item')
                if not narrative or narrative.get('userId') != f'memory-book#{owner}' or narrative.get('recordType') != 'memory-narrative-version':
                    raise ValueError('An approved narrative is unavailable')
                entry['text'] = narrative.get('text', '')
                entry['quotes'] = narrative.get('quotes', [])
                entry['original_text'] = load_source_transcript(owner, source) if entry['quotes'] else ''
                if any(quote not in entry['original_text'] for quote in entry['quotes']):
                    raise ValueError('A selected quote no longer matches its original transcript')
            photo_ids = selected_photo_ids(book)
        if len(photo_ids) > 50:
            raise ValueError('Too many photos in one book')
        image_urls = {}
        total_photo_bytes = 0
        for photo_id in photo_ids:
            photo_row = table.get_item(Key={'uploadId': f'memory-photo#{owner}#{photo_id}'}, ConsistentRead=True).get('Item')
            expected_key = f'photos/{owner}/{photo_id}.jpg'
            if not photo_row or photo_row.get('userId') != f'memory-book#{owner}' or photo_row.get('status') != 'complete' or photo_row.get('objectKey') != expected_key:
                raise ValueError('A selected photo is unavailable')
            photo_obj = s3.get_object(Bucket=BUCKET, Key=expected_key)
            data = photo_obj['Body'].read(5 * 1024 * 1024 + 1)
            total_photo_bytes += len(data)
            if len(data) > 5 * 1024 * 1024 or total_photo_bytes > 30 * 1024 * 1024:
                raise ValueError('Selected photos exceed the book size limit')
            image_urls[photo_id] = 'data:image/jpeg;base64,' + base64.b64encode(data).decode('ascii')
        if page_mode:
            html_source = render_journal_pages_html(book, pages, image_urls)
        else:
            html_source = render_html(book, image_urls)
        if not page_mode and memory_template(book).get('id') == 'notebook-v1':
            preflight = HTML(string=html_source, url_fetcher=safe_fetcher).render()
            html_source = render_html(book, image_urls, measure_notebook_writing_heights(preflight, book))
        data = HTML(string=html_source, url_fetcher=safe_fetcher).write_pdf()
        if table.get_item(Key={'uploadId': f'account#{owner}'}, ConsistentRead=True).get('Item'):
            return {'ignored': True}
        if not memory_book_is_active(owner, book_id):
            discard_memory_export_job(owner, book_id, job_key)
            return {'ignored': True}
        put_result = s3.put_object(Bucket=BUCKET, Key=object_key, Body=data, ContentType='application/pdf', ServerSideEncryption='AES256', CacheControl='private, no-store')
        object_written = True
        written_version_id = put_result.get('VersionId')
        if not memory_book_is_active(owner, book_id):
            delete_written_export(object_key, written_version_id)
            object_written = False
            discard_memory_export_job(owner, book_id, job_key)
            return {'ignored': True}
        try:
            table.update_item(Key=job_key, UpdateExpression='SET #s = :complete, objectKey = :key, completedAt = :now REMOVE leaseExpiresAt, #failure',
                              ConditionExpression='userId = :owner AND recordType = :type AND bookId = :book AND #s = :rendering',
                              ExpressionAttributeNames={'#s': 'status', '#failure': 'error'},
                              ExpressionAttributeValues={':owner': f'memory-book#{owner}', ':type': 'memory-export', ':book': book_id, ':rendering': 'rendering', ':complete': 'complete', ':key': object_key, ':now': datetime.now(timezone.utc).isoformat()})
        except ClientError as exc:
            if exc.response.get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
                raise
            delete_written_export(object_key, written_version_id)
            object_written = False
            return {'ignored': True}
        return {'status': 'complete'}
    except Exception as exc:
        if object_written:
            delete_written_export(object_key, written_version_id)
        try:
            table.update_item(Key=job_key, UpdateExpression='SET #s = :failed, #failure = :error REMOVE leaseExpiresAt',
                              ConditionExpression='userId = :owner AND recordType = :type AND bookId = :book AND #s = :rendering',
                              ExpressionAttributeNames={'#s': 'status', '#failure': 'error'},
                              ExpressionAttributeValues={':owner': f'memory-book#{owner}', ':type': 'memory-export', ':book': book_id, ':rendering': 'rendering', ':failed': 'failed', ':error': type(exc).__name__})
        except ClientError as state_exc:
            if state_exc.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
                if not memory_book_is_active(owner, book_id):
                    return {'ignored': True}
            raise
        raise
