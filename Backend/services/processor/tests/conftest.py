"""Shared fixtures for processor tests.

Tiny synthetic MP4 byte streams are built at test time instead of
committing video files: the repository .gitignore blocks *.mp4, and the
brief forbids committing journal media.
"""

from __future__ import annotations

import struct
from collections.abc import Callable
from pathlib import Path

import pytest

from services.processor import config as config_module

_ENV_KEYS = (
    "TRANSCRIPTION_MODE",
    "ANALYSIS_MODE",
    "WHISPER_MODEL",
    "GEMINI_MODEL",
    "GEMINI_API_KEY",
)


def _box(box_type: bytes, payload: bytes) -> bytes:
    """Build one ISO BMFF box: 4-byte size + 4-byte type + payload."""
    size = 8 + len(payload)
    return struct.pack(">I", size) + box_type + payload


def minimal_mp4_bytes() -> bytes:
    """A tiny syntactically valid ISO BMFF (MP4) file: ftyp + mdat boxes."""
    ftyp = _box(b"ftyp", b"isom" + struct.pack(">I", 512) + b"isomiso2")
    mdat = _box(b"mdat", b"\x00" * 16)
    return ftyp + mdat


@pytest.fixture
def mp4_path(tmp_path: Path) -> Path:
    path = tmp_path / "test-journal.mp4"
    path.write_bytes(minimal_mp4_bytes())
    return path


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Callable[..., None]:
    """Force a clean, mock-default processor environment for one test.

    Usage: ``env(TRANSCRIPTION_MODE="faster_whisper")``. Deletes all
    documented switches first (so a developer's real shell/.env cannot leak
    into tests), then applies overrides. Also points the dotenv loader at
    an empty directory so a root .env cannot interfere.
    """

    def apply(**variables: str) -> None:
        for key in _ENV_KEYS:
            monkeypatch.delenv(key, raising=False)
        for key, value in variables.items():
            monkeypatch.setenv(key, value)

    monkeypatch.setattr(config_module, "_REPO_ROOT", tmp_path)
    apply()
    return apply
