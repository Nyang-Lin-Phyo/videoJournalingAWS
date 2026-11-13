"""Tests for pipeline.process_video: the Contract B entry point."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from services.processor import pipeline
from services.processor.analysis import analyze_transcript
from services.processor.errors import (
    AnalysisError,
    EmptyTranscriptError,
    InvalidVideoError,
)
from services.processor.pipeline import process_video
from services.processor.transcription import transcribe_video

RESULT_KEYS = {"transcript", "analysis"}
ANALYSIS_KEYS = {"sentiment", "emotions", "themes", "summary"}


def test_returns_exact_contract_result(mp4_path: Path) -> None:
    result = process_video(mp4_path)

    assert set(result) == RESULT_KEYS
    assert isinstance(result["transcript"], str) and result["transcript"].strip()
    assert set(result["analysis"]) == ANALYSIS_KEYS
    assert result["analysis"]["sentiment"] in {"positive", "negative", "neutral"}


def test_callback_order_transcribing_then_analyzing(mp4_path: Path) -> None:
    stages: list[str] = []

    result = process_video(mp4_path, on_stage=stages.append)

    assert stages == ["transcribing", "analyzing"]
    assert set(result) == RESULT_KEYS


def test_works_without_callback(mp4_path: Path) -> None:
    result = process_video(mp4_path)

    assert set(result) == RESULT_KEYS


def test_deterministic_in_mock_mode(mp4_path: Path) -> None:
    assert process_video(mp4_path) == process_video(mp4_path)


def test_missing_file_raises_invalid_video(tmp_path: Path) -> None:
    missing = tmp_path / "does-not-exist.mp4"

    with pytest.raises(InvalidVideoError):
        process_video(missing)


def test_directory_is_not_a_video(tmp_path: Path) -> None:
    with pytest.raises(InvalidVideoError):
        process_video(tmp_path)


def test_non_mp4_content_rejected(tmp_path: Path) -> None:
    fake = tmp_path / "fake.mp4"
    fake.write_bytes(b"this is not a video file at all")

    with pytest.raises(InvalidVideoError):
        process_video(fake)


def test_empty_transcript_fails_before_analysis(
    mp4_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    analysis_calls: list[str] = []

    monkeypatch.setattr(pipeline, "transcribe_video", lambda _path: "   ")
    monkeypatch.setattr(
        pipeline,
        "analyze_transcript",
        lambda _text: analysis_calls.append(_text),  # type: ignore[arg-type]
    )

    with pytest.raises(EmptyTranscriptError):
        process_video(mp4_path)

    assert analysis_calls == []


def test_analysis_error_propagates(
    mp4_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _fail(_text: str) -> Any:
        raise AnalysisError("analysis failed in test")

    monkeypatch.setattr(pipeline, "analyze_transcript", _fail)

    with pytest.raises(AnalysisError):
        process_video(mp4_path)


def test_callback_failure_surfaces(
    mp4_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    transcription_calls: list[Path] = []
    monkeypatch.setattr(
        pipeline,
        "transcribe_video",
        lambda path: transcription_calls.append(path) or "text",
    )

    def _explode(_stage: str) -> None:
        raise RuntimeError("callback exploded")

    with pytest.raises(RuntimeError, match="callback exploded"):
        process_video(mp4_path, on_stage=_explode)

    assert transcription_calls == []


def test_stage_functions_exist_separately(mp4_path: Path) -> None:
    """transcribe_video/analyze_transcript stay stubbable on their own."""
    transcript = transcribe_video(mp4_path)
    analysis = analyze_transcript(transcript)

    assert transcript.strip()
    assert set(analysis.model_dump()) == ANALYSIS_KEYS
