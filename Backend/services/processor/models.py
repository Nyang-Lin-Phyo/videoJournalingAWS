"""Pydantic models mirroring Contract B and the shared JSON schemas.

These models validate strictly: sentiment must be exactly one of the three
enum values, emotion/theme lists must contain nonempty unique strings, and
extra fields (e.g. unexpected AI-provider keys) are rejected. ``model_dump``
serializes to the plain nested dictionaries the API consumes; the TypedDicts
below document the exact runtime shapes from Contract B.
"""

from __future__ import annotations

from typing import Literal, TypedDict

from pydantic import BaseModel, ConfigDict, field_validator

Sentiment = Literal["positive", "negative", "neutral"]
Stage = Literal["transcribing", "analyzing"]


def _validate_phrases(values: list[str]) -> list[str]:
    cleaned = [value.strip() for value in values]
    if not cleaned or any(not value for value in cleaned):
        raise ValueError("must be a nonempty list of nonempty strings")
    if len(set(cleaned)) != len(cleaned):
        raise ValueError("must not contain duplicate entries")
    return cleaned


class Analysis(BaseModel):
    """Matches packages/contracts/analysis.schema.json exactly."""

    model_config = ConfigDict(extra="forbid")

    sentiment: Sentiment
    emotions: list[str]
    themes: list[str]
    summary: str

    @field_validator("emotions", "themes")
    @classmethod
    def _nonempty_phrases(cls, values: list[str]) -> list[str]:
        return _validate_phrases(values)

    @field_validator("summary")
    @classmethod
    def _nonempty_summary(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("summary must be nonempty")
        return cleaned


class ProcessingResult(BaseModel):
    """Matches Contract B's ProcessingResult: exactly {transcript, analysis}."""

    model_config = ConfigDict(extra="forbid")

    transcript: str
    analysis: Analysis

    @field_validator("transcript")
    @classmethod
    def _nonempty_transcript(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("transcript must be nonempty")
        return cleaned


# --- Contract B runtime shapes (plain dicts at the API boundary) -----------


class AnalysisDict(TypedDict):
    sentiment: Sentiment
    emotions: list[str]
    themes: list[str]
    summary: str


class ProcessingResultDict(TypedDict):
    transcript: str
    analysis: AnalysisDict
