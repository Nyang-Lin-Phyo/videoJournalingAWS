"""Speech-to-text for video journals.

Modes (TRANSCRIPTION_MODE):

  * mock           - deterministic offline transcript (milestone P1)
  * faster_whisper - local CPU transcription with Faster-Whisper
    (milestone P2). Runs ``WhisperModel(WHISPER_MODEL, device="cpu",
    compute_type="int8")``; the first real run downloads model weights, so
    default unit tests never trigger it (they stub the model loader).

The Whisper import is lazy (mock mode needs no faster-whisper install) and
the model instance is cached in-process so repeated calls reuse one loaded
model instead of reloading weights each time.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from .config import load_config
from .errors import EmptyTranscriptError, InvalidVideoError, TranscriptionError

# Deterministic synthetic transcript for mock mode. It is clearly test text
# so nobody mistakes mock output for a real journal.
MOCK_TRANSCRIPT = (
    "This is a synthetic mock transcript used for local pipeline testing. "
    "I had a good day and I am grateful for my friends and school."
)

DEFAULT_DEVICE = "cpu"
DEFAULT_COMPUTE_TYPE = "int8"

_WHITESPACE_RE = re.compile(r"\s+")


def _looks_like_mp4(path: Path) -> bool:
    """Minimal MVP sniff: ISO BMFF files carry an 'ftyp' box near the start.

    This is not malware scanning or full container validation; it just keeps
    obviously-wrong files (e.g. a text file named .mp4) out of the pipeline.
    Real mode additionally decodes the audio stream and fails loudly there.
    """
    try:
        with path.open("rb") as handle:
            header = handle.read(32)
    except OSError:
        return False
    return b"ftyp" in header


def _normalize_whitespace(text: str) -> str:
    """Collapse all whitespace runs to single spaces and strip the ends.

    Segment text is concatenated in returned order exactly as Whisper
    produced it; no punctuation or words are ever added.
    """
    return _WHITESPACE_RE.sub(" ", text).strip()


def _transcribe_with_whisper(path: Path, model_name: str) -> str:
    """Real CPU transcription via Faster-Whisper (milestone P2).

    Raises TranscriptionError for undecodable/missing audio (the provider
    or decoder raised, or decoding produced nothing usable) and
    EmptyTranscriptError when speech recognition yields no words. Never
    fabricates a transcript, never logs the API key or full paths.
    """
    model = _get_whisper_model(model_name)
    try:
        # transcribe() is lazy: nothing runs until the segments generator is
        # consumed, so we iterate it fully below.
        segments, _info = model.transcribe(str(path))
        parts = [segment.text for segment in segments]
    except Exception as exc:
        raise TranscriptionError(
            f"Could not decode or transcribe audio in {path.name}."
        ) from exc

    transcript = _normalize_whitespace(" ".join(parts))
    if not transcript:
        raise EmptyTranscriptError(f"No speech detected in {path.name}.")
    return transcript


def _load_whisper_model(model_name: str):
    """Import and instantiate WhisperModel once per process.

    CPU-first by design (no CUDA assumed). The first call may download
    model weights; weights are never committed to Git.
    """
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:  # pragma: no cover - depends on installation
        raise TranscriptionError(
            "faster-whisper is not installed; run "
            "`pip install -r services/processor/requirements.txt`."
        ) from exc

    return WhisperModel(
        model_name, device=DEFAULT_DEVICE, compute_type=DEFAULT_COMPUTE_TYPE
    )


# In-process model cache: model_name -> loaded model instance.
_MODEL_CACHE: dict[str, object] = {}


def _get_whisper_model(model_name: str):
    """Return a cached WhisperModel, loading it on first use."""
    cached = _MODEL_CACHE.get(model_name)
    if cached is None:
        cached = _load_whisper_model(model_name)
        _MODEL_CACHE[model_name] = cached
    return cached


def clear_model_cache() -> None:
    """Drop cached model instances (used by tests)."""
    _MODEL_CACHE.clear()


def transcribe_video(video_path: Path) -> str:
    """Return the transcript for the MP4 at ``video_path``.

    Modes:
      * mock           - deterministic offline transcript (milestone P1)
      * faster_whisper - local CPU transcription (milestone P2)
    """
    path = Path(video_path)
    if not path.is_file():
        raise InvalidVideoError(f"Video file not found: {path.name}")
    if not _looks_like_mp4(path):
        raise InvalidVideoError(f"File does not look like an MP4: {path.name}")

    config = load_config()
    if config.transcription_mode == "mock":
        return MOCK_TRANSCRIPT

    transcript = _transcribe_with_whisper(path, config.whisper_model)
    print(
        f"transcribed {path.name} ({len(transcript)} chars) with "
        f"'{config.whisper_model}' on {DEFAULT_DEVICE}",
        file=sys.stderr,
    )
    return transcript
