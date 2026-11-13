"""Tests for transcription.transcribe_video (mock mode, milestone P1)."""

from __future__ import annotations

from pathlib import Path
from typing import Callable

import pytest

from services.processor.errors import (
    EmptyTranscriptError,
    InvalidVideoError,
)
from services.processor.transcription import MOCK_TRANSCRIPT, transcribe_video


def test_mock_transcript_is_deterministic(mp4_path: Path) -> None:
    first = transcribe_video(mp4_path)
    second = transcribe_video(mp4_path)

    assert first == second == MOCK_TRANSCRIPT


def test_mock_transcript_is_nonempty(mp4_path: Path) -> None:
    assert transcribe_video(mp4_path).strip()


def test_missing_file_raises(mp4_path: Path, tmp_path: Path) -> None:
    with pytest.raises(InvalidVideoError):
        transcribe_video(tmp_path / "missing.mp4")


def test_non_mp4_content_raises(tmp_path: Path) -> None:
    fake = tmp_path / "notes.mp4"
    fake.write_bytes(b"plain text pretending to be video")

    with pytest.raises(InvalidVideoError):
        transcribe_video(fake)


def test_faster_whisper_mode_routes_to_model_loader(
    mp4_path: Path, env: Callable[..., None], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Real mode must load the Whisper model (stubbed here: no download)."""
    from services.processor import transcription as transcription_module

    env(TRANSCRIPTION_MODE="faster_whisper")
    loaded: list[str] = []

    class _FakeModel:
        def transcribe(self, _path: str):
            loaded.append("transcribe")
            return iter([]), object()

    monkeypatch.setattr(
        transcription_module,
        "_load_whisper_model",
        lambda name: loaded.append(name) or _FakeModel(),
    )

    with pytest.raises(EmptyTranscriptError):
        transcribe_video(mp4_path)  # fake yields no segments -> typed error

    assert loaded[0] == "tiny.en"  # default model name
    assert "transcribe" in loaded
