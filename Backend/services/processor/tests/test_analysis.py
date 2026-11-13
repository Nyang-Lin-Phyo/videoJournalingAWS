"""Tests for analysis.analyze_transcript and the Pydantic models."""

from __future__ import annotations

import dataclasses
from typing import Callable

import pytest
from pydantic import ValidationError

from services.processor import analysis as analysis_module
from services.processor import config as config_module
from services.processor.analysis import analyze_transcript
from services.processor.errors import AnalysisError, EmptyTranscriptError
from services.processor.models import Analysis, ProcessingResult


def test_positive_transcript() -> None:
    result = analyze_transcript(
        "I am so happy and grateful. Today was great fun with friends."
    )

    assert result.sentiment == "positive"
    assert "joy" in result.emotions
    assert "gratitude" in result.emotions
    assert "friends" in result.themes
    assert result.summary.strip()


def test_negative_transcript() -> None:
    result = analyze_transcript(
        "I feel sad and disappointed. The day was terrible and I am stressed."
    )

    assert result.sentiment == "negative"
    assert "sadness" in result.emotions
    assert "worry" in result.emotions


def test_neutral_transcript() -> None:
    result = analyze_transcript(
        "I went to class, then cooked dinner and walked for a while."
    )

    assert result.sentiment == "neutral"
    assert result.summary.strip()


def test_deterministic_output() -> None:
    text = "A calm and ordinary day at school with some reading."

    assert analyze_transcript(text) == analyze_transcript(text)


def test_default_emotions_and_themes_for_bare_text() -> None:
    result = analyze_transcript("Something happened today.")

    assert result.emotions == ["calm"]
    assert result.themes == ["daily life"]


def test_empty_transcript_rejected() -> None:
    with pytest.raises(EmptyTranscriptError):
        analyze_transcript("   ")


def test_overlong_transcript_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real_config = config_module.load_config()
    monkeypatch.setattr(
        analysis_module,
        "load_config",
        lambda: dataclasses.replace(real_config, max_transcript_chars=10),
    )

    with pytest.raises(AnalysisError, match="too long"):
        analyze_transcript("this transcript is definitely longer than ten chars")


def test_gemini_mode_without_api_key_fails_loudly(
    env: Callable[..., None],
) -> None:
    env(ANALYSIS_MODE="gemini")  # env fixture deletes GEMINI_API_KEY

    with pytest.raises(AnalysisError, match="GEMINI_API_KEY"):
        analyze_transcript("A perfectly normal sentence about my day.")


# --- Pydantic model validation --------------------------------------------


def valid_analysis_kwargs() -> dict:
    return {
        "sentiment": "positive",
        "emotions": ["joy"],
        "themes": ["friends"],
        "summary": "A pleasant day.",
    }


def test_analysis_model_accepts_valid_output() -> None:
    model = Analysis(**valid_analysis_kwargs())

    assert model.sentiment == "positive"


def test_analysis_model_rejects_extra_fields() -> None:
    with pytest.raises(ValidationError):
        Analysis(**valid_analysis_kwargs(), diagnosis="happy")


def test_analysis_model_rejects_bad_sentiment() -> None:
    kwargs = valid_analysis_kwargs()
    kwargs["sentiment"] = "mixed"

    with pytest.raises(ValidationError):
        Analysis(**kwargs)


def test_analysis_model_rejects_empty_emotions() -> None:
    kwargs = valid_analysis_kwargs()
    kwargs["emotions"] = []

    with pytest.raises(ValidationError):
        Analysis(**kwargs)


def test_analysis_model_rejects_blank_emotion_strings() -> None:
    kwargs = valid_analysis_kwargs()
    kwargs["emotions"] = ["joy", "  "]

    with pytest.raises(ValidationError):
        Analysis(**kwargs)


def test_analysis_model_rejects_duplicate_emotions() -> None:
    kwargs = valid_analysis_kwargs()
    kwargs["emotions"] = ["joy", "joy"]

    with pytest.raises(ValidationError):
        Analysis(**kwargs)


def test_analysis_model_rejects_empty_summary() -> None:
    kwargs = valid_analysis_kwargs()
    kwargs["summary"] = "   "

    with pytest.raises(ValidationError):
        Analysis(**kwargs)


def test_processing_result_rejects_empty_transcript() -> None:
    with pytest.raises(ValidationError):
        ProcessingResult(transcript=" ", analysis=Analysis(**valid_analysis_kwargs()))


def test_processing_result_rejects_extra_fields() -> None:
    with pytest.raises(ValidationError):
        ProcessingResult(
            transcript="hello",
            analysis=Analysis(**valid_analysis_kwargs()),
            timings={"transcribing": 1},
        )
