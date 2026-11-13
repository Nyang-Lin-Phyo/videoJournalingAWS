"""Milestone P2 tests: Faster-Whisper transcription with a fake model.

Default runs stub the model loader — no model weights are downloaded and no
network is touched. The real end-to-end run is opt-in (see
test_real_transcription_opt_in below).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

import pytest

from services.processor import transcription
from services.processor.errors import (
    EmptyTranscriptError,
    InvalidVideoError,
    TranscriptionError,
)
from services.processor.transcription import (
    _normalize_whitespace,
    clear_model_cache,
    transcribe_video,
)


class FakeSegment:
    def __init__(self, text: str) -> None:
        self.text = text


class FakeWhisperModel:
    """Stands in for faster_whisper.WhisperModel in unit tests."""

    instances: list["FakeWhisperModel"] = []

    def __init__(self, model_name: str, device: str, compute_type: str) -> None:
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.transcribe_calls: list[str] = []
        self._texts: list[str] = []
        self.raise_on_transcribe: Exception | None = None
        FakeWhisperModel.instances.append(self)

    def set_texts(self, *texts: str) -> None:
        self._texts = list(texts)

    def transcribe(self, path: str):
        self.transcribe_calls.append(path)
        if self.raise_on_transcribe is not None:
            raise self.raise_on_transcribe

        def _generate():
            # A real generator: transcription only "runs" when consumed.
            for text in self._texts:
                yield FakeSegment(text)

        return _generate(), object()


@pytest.fixture(autouse=True)
def _reset_model_cache_and_instances() -> None:
    clear_model_cache()
    FakeWhisperModel.instances.clear()
    yield
    clear_model_cache()
    FakeWhisperModel.instances.clear()


@pytest.fixture
def use_fake_whisper(monkeypatch: pytest.MonkeyPatch) -> Callable[[], FakeWhisperModel]:
    """Route real-mode transcription through one pre-built fake model.

    Call ``model = install()`` first, configure it with ``set_texts(...)``
    or ``raise_on_transcribe``, then exercise ``transcribe_video`` — the
    loader returns this exact fake and counts as one model load.
    """

    def install() -> FakeWhisperModel:
        fake = FakeWhisperModel(
            "fake-model",
            device=transcription.DEFAULT_DEVICE,
            compute_type=transcription.DEFAULT_COMPUTE_TYPE,
        )

        def _loader(model_name: str) -> FakeWhisperModel:
            return fake

        monkeypatch.setattr(transcription, "_load_whisper_model", _loader)
        return fake

    return install


def test_segments_consumed_and_whitespace_normalized(
    mp4_path: Path, env: Callable[..., None], use_fake_whisper: Callable[[], FakeWhisperModel]
) -> None:
    env(TRANSCRIPTION_MODE="faster_whisper")
    model = use_fake_whisper()
    model.set_texts("  Hello   world ", "\n from a video ", "journal.")

    transcript = transcribe_video(mp4_path)

    assert transcript == "Hello world from a video journal."


def test_empty_segments_raise_empty_transcript(
    mp4_path: Path, env: Callable[..., None], use_fake_whisper: Callable[[], FakeWhisperModel]
) -> None:
    env(TRANSCRIPTION_MODE="faster_whisper")
    use_fake_whisper().set_texts()  # silent recording

    with pytest.raises(EmptyTranscriptError):
        transcribe_video(mp4_path)


def test_blank_only_segments_raise_empty_transcript(
    mp4_path: Path, env: Callable[..., None], use_fake_whisper: Callable[[], FakeWhisperModel]
) -> None:
    env(TRANSCRIPTION_MODE="faster_whisper")
    use_fake_whisper().set_texts("   ", "\t")

    with pytest.raises(EmptyTranscriptError):
        transcribe_video(mp4_path)


def test_decoder_failure_raises_transcription_error(
    mp4_path: Path, env: Callable[..., None], use_fake_whisper: Callable[[], FakeWhisperModel]
) -> None:
    env(TRANSCRIPTION_MODE="faster_whisper")
    use_fake_whisper().raise_on_transcribe = RuntimeError(
        "PyAV: no audio stream"
    )

    with pytest.raises(TranscriptionError) as excinfo:
        transcribe_video(mp4_path)

    # Safe, non-sensitive message: filename only, no full path, no traceback text.
    assert "test-journal.mp4" in str(excinfo.value)
    assert str(mp4_path) not in str(excinfo.value)


def test_model_cached_across_calls(
    mp4_path: Path, env: Callable[..., None], use_fake_whisper: Callable[[], FakeWhisperModel]
) -> None:
    env(TRANSCRIPTION_MODE="faster_whisper")
    model = use_fake_whisper()
    model.set_texts("One result.")

    first = transcribe_video(mp4_path)
    second = transcribe_video(mp4_path)

    assert first == second == "One result."
    assert len(FakeWhisperModel.instances) == 1  # loaded once, reused after


def test_cached_model_reused_without_loader_call(
    mp4_path: Path, env: Callable[..., None], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Second call must hit the cache, not the loader."""
    env(TRANSCRIPTION_MODE="faster_whisper")
    load_count = {"n": 0}

    def _counting_loader(model_name: str) -> FakeWhisperModel:
        load_count["n"] += 1
        model = FakeWhisperModel(model_name, device="cpu", compute_type="int8")
        model.set_texts("hi")
        return model

    monkeypatch.setattr(transcription, "_load_whisper_model", _counting_loader)

    transcribe_video(mp4_path)
    transcribe_video(mp4_path)

    assert load_count["n"] == 1


def test_real_mode_still_rejects_bad_input_before_model(
    env: Callable[..., None], tmp_path: Path, use_fake_whisper: Callable[[], FakeWhisperModel]
) -> None:
    env(TRANSCRIPTION_MODE="faster_whisper")
    use_fake_whisper()
    fake = tmp_path / "broken.mp4"
    fake.write_bytes(b"not a video")

    with pytest.raises(InvalidVideoError):
        transcribe_video(fake)
    # Model must never load for invalid input.
    assert FakeWhisperModel.instances == [] or all(
        not m.transcribe_calls for m in FakeWhisperModel.instances
    )


def test_normalize_whitespace_never_invents_text() -> None:
    assert _normalize_whitespace("  a\t\nb   c ") == "a b c"
    assert _normalize_whitespace("already fine") == "already fine"
    assert _normalize_whitespace("   ") == ""


@pytest.mark.skipif(
    os.environ.get("PROCESSOR_RUN_REAL_TESTS") != "1",
    reason="opt-in real transcription: set PROCESSOR_RUN_REAL_TESTS=1 with a "
    "fictional spoken MP4 at samples/fictional-spoken-journal.mp4",
)
def test_real_transcription_opt_in() -> None:
    """Manual integration: real tiny.en CPU transcription on fictional speech.

    Downloads model weights on first run; never part of default pytest.
    """
    fixture = Path("samples/fictional-spoken-journal.mp4")
    if not fixture.is_file():
        pytest.skip("fictional spoken fixture not present")

    os.environ.setdefault("WHISPER_MODEL", "tiny.en")
    transcript = transcribe_video(fixture)

    assert transcript.strip()
