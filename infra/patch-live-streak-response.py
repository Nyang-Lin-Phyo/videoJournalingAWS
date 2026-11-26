#!/usr/bin/env python3
"""Safely extend only the streak summary in a downloaded, live Lambda ZIP.

This tool never contacts AWS. It preserves all ZIP members and their contents
except for the exact new response fields in auth_results.py.
"""
from pathlib import Path
from zipfile import ZipFile
from copy import copy
import sys


def add_fields(source: bytes) -> tuple[bytes, bool]:
    normalized = source.replace(b'\r\n', b'\n')
    start = normalized.find(b'def streak_summary(')
    end = normalized.find(b'\ndef handle_streak(', start + 1)
    if start < 0 or end < 0:
        raise ValueError('Live results handler has an unexpected streak implementation; refusing to overwrite it.')
    block = normalized[start:end]
    if b"'frozen_local_dates':" in block and b"'today_local_date':" in block and b"'timezone': zone_name" in block:
        return source, False

    anchor = b"        'freeze_pending': freeze_pending,\n    }"
    extra = (
        b"        'freeze_pending': freeze_pending,\n"
        b"        'timezone': zone_name,\n"
        b"        'today_local_date': today.isoformat(),\n"
        b"        'frozen_local_dates': list(item.get('frozenLocalDates', [])) if item else [],\n"
        b"    }"
    )
    if block.count(anchor) != 1:
        raise ValueError('Expected streak response mapping was not found exactly once. Live code may have changed.')
    updated_block = block.replace(anchor, extra, 1)
    updated = normalized[:start] + updated_block + normalized[end:]
    if b'\r\n' in source:
        # Restore the original line ending style when the live code used CRLF.
        updated = updated.replace(b'\n', b'\r\n')
    return updated, True


def patch_bundle(original: Path, destination: Path) -> bool:
    with ZipFile(original) as source:
        members = source.infolist()
        names = [info.filename for info in members]
        if names.count('auth_results.py') != 1:
            raise ValueError('Expected a single auth_results.py at Lambda ZIP root. Refusing deployment.')
        original_files = {info.filename: source.read(info.filename) for info in members}
        existing = original_files['auth_results.py']
        rewritten, changed = add_fields(existing)
        if not changed:
            return False
        # Syntax-check before writing anything deployable.
        compile(rewritten.decode('utf-8-sig'), 'auth_results.py', 'exec')
        with ZipFile(destination, 'w') as target:
            target.comment = source.comment
            for info in members:
                target.writestr(copy(info), rewritten if info.filename == 'auth_results.py' else original_files[info.filename])
        with ZipFile(destination) as target:
            if target.read('auth_results.py') != rewritten:
                raise ValueError('ZIP verification failed')
            for info in members:
                if info.filename != 'auth_results.py' and target.read(info.filename) != original_files[info.filename]:
                    raise ValueError(f'Unexpected change to {info.filename}')
        return True


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: python3 infra/patch-live-streak-response.py BEFORE.zip AFTER.zip')
    before, after = map(Path, sys.argv[1:])
    try:
        changed = patch_bundle(before, after)
    except (ValueError, UnicodeError, KeyError) as exc:
        raise SystemExit(f'STOP: {exc}') from exc
    print('CHANGED: Added frozen-day calendar fields; all other live Lambda ZIP members preserved.'
          if changed else 'UNCHANGED: Live streak response already includes the calendar fields.')
