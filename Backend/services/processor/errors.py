"""Typed errors for the video journal processor.

Every message is intentionally short and non-sensitive: it may be shown to
end users or written to logs, so it must never contain API keys, provider
payloads, transcripts, or absolute filesystem paths (which can leak
usernames). Callers (the API job adapter) should catch ``ProcessorError``
and map subclasses to user-facing failures.
"""

from __future__ import annotations


class ProcessorError(Exception):
    """Base class for all processor failures."""


class ConfigError(ProcessorError):
    """Invalid or missing processor configuration."""


class InvalidVideoError(ProcessorError):
    """The video file is missing, unreadable, or not a valid MP4."""


class EmptyTranscriptError(ProcessorError):
    """Transcription finished but produced no usable text."""


class TranscriptionError(ProcessorError):
    """Speech-to-text failed."""


class AnalysisError(ProcessorError):
    """Transcript analysis failed or produced invalid output."""
