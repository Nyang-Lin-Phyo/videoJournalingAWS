"""Environment-driven configuration for the processor.

Documented switches (see the shared team brief):

    PROCESSOR_MODE=mock             # owned by the backend, not read here
    TRANSCRIPTION_MODE=mock         # mock | faster_whisper
    ANALYSIS_MODE=mock              # mock | gemini
    WHISPER_MODEL=tiny.en
    GEMINI_MODEL=                   # a currently supported model id
    GEMINI_API_KEY=                 # secret; never commit or log it

A root ``.env`` file is loaded when python-dotenv is available, but real
environment variables always win (``override=False``), so documented shell
exports work unchanged. Unknown mode values fail loudly with
``ConfigError`` instead of silently falling back to mock.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from .errors import ConfigError

TRANSCRIPTION_MODES = ("mock", "faster_whisper")
ANALYSIS_MODES = ("mock", "gemini")

DEFAULT_WHISPER_MODEL = "tiny.en"
# Documented character budget for a single transcript (P3 requirement,
# enforced from P1 so mock and real modes behave identically). Transcripts
# beyond this raise AnalysisError rather than being silently truncated.
MAX_TRANSCRIPT_CHARS = 100_000

# Repository root: services/processor/config.py -> parents[2].
_REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_dotenv() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:  # pragma: no cover - dotenv is a declared dependency
        return
    dotenv_path = _REPO_ROOT / ".env"
    if dotenv_path.is_file():
        load_dotenv(dotenv_path=dotenv_path, override=False)


@dataclass(frozen=True)
class ProcessorConfig:
    transcription_mode: str
    analysis_mode: str
    whisper_model: str
    gemini_model: str
    gemini_api_key: str
    max_transcript_chars: int

    @property
    def is_mock(self) -> bool:
        """True when either processing stage runs in mock mode."""
        return self.transcription_mode == "mock" or self.analysis_mode == "mock"


def load_config() -> ProcessorConfig:
    """Read and validate processor configuration from the environment."""
    _load_dotenv()

    transcription_mode = os.environ.get("TRANSCRIPTION_MODE", "mock").strip().lower()
    if transcription_mode not in TRANSCRIPTION_MODES:
        raise ConfigError(
            f"Invalid TRANSCRIPTION_MODE {transcription_mode!r}; "
            f"expected one of {', '.join(TRANSCRIPTION_MODES)}."
        )

    analysis_mode = os.environ.get("ANALYSIS_MODE", "mock").strip().lower()
    if analysis_mode not in ANALYSIS_MODES:
        raise ConfigError(
            f"Invalid ANALYSIS_MODE {analysis_mode!r}; "
            f"expected one of {', '.join(ANALYSIS_MODES)}."
        )

    whisper_model = (
        os.environ.get("WHISPER_MODEL", "").strip() or DEFAULT_WHISPER_MODEL
    )

    return ProcessorConfig(
        transcription_mode=transcription_mode,
        analysis_mode=analysis_mode,
        whisper_model=whisper_model,
        gemini_model=os.environ.get("GEMINI_MODEL", "").strip(),
        gemini_api_key=os.environ.get("GEMINI_API_KEY", "").strip(),
        max_transcript_chars=MAX_TRANSCRIPT_CHARS,
    )
