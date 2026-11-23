"""Shared defaults for virtual journal pages, used by API and PDF worker."""
import re


def default_journal_page_blocks(transcript):
    """Create stable editable blocks without dropping source whitespace or words."""
    paragraph_spans = []
    cursor = 0
    for match in re.finditer(r'\r?\n(?:[ \t]*\r?\n)+', transcript):
        paragraph_spans.append(transcript[cursor:match.end()])
        cursor = match.end()
    if cursor < len(transcript) or not paragraph_spans:
        paragraph_spans.append(transcript[cursor:])
    chunks = []
    for paragraph in paragraph_spans:
        start = 0
        while len(paragraph) - start > 1400:
            upper = start + 1400
            boundaries = [match.end() for match in re.finditer(r'(?:[.!?][\"\'”’)]?\s+|\r?\n)', paragraph[start:upper])]
            end = start + (boundaries[-1] if boundaries and boundaries[-1] >= 700 else 1200)
            end = min(end, len(paragraph))
            chunks.append(paragraph[start:end])
            start = end
        if start < len(paragraph):
            chunks.append(paragraph[start:])
    return [{'id': f'source-{index + 1:04d}', 'kind': 'text', 'width': 'full',
             'text': value, 'style': 'paragraph'} for index, value in enumerate(chunks)]
