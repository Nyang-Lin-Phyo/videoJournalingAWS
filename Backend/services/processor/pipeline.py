"""process_video: the single processing entry point (Contract B, frozen).

The API job adapter and the CLI both call this exact function — there is no
second processing path. The callable is synchronous for the MVP.

    from pathlib import Path
    from services.processor.pipeline import process_video

    result = process_video(Path("samples/test-journal.mp4"))
    # -> {"transcript": str, "analysis": {sentiment, emotions, themes, summary}}

``on_stage`` signals stage transitions only (the backend owns status
writes): ``on_stage("transcribing")`` fires before transcription and
``on_stage("analyzing")`` before analysis. Callback failures propagate —
they are never swallowed.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, cast

from pydantic import ValidationError

from .analysis import analyze_transcript
from .errors import AnalysisError, EmptyTranscriptError, InvalidVideoError
from .models import ProcessingResult, ProcessingResultDict, Stage
from .transcription import transcribe_video

__all__ = ["process_video", "Stage", "ProcessingResultDict"]


def process_video(
    video_path: Path,
    *,
    on_stage: Callable[[Stage], None] | None = None,
) -> ProcessingResultDict:
    """Process one MP4 video journal into transcript + emotional analysis.

    Raises a typed ProcessorError subclass on any failure:
      * InvalidVideoError - missing or non-MP4 file
      * TranscriptionError / EmptyTranscriptError - speech-to-text failed or
        produced no usable text (analysis is never attempted then)
      * AnalysisError - analysis failed or produced invalid output

    Never returns a fabricated success and never includes API keys or
    provider payloads in results or messages.
    """
    path = Path(video_path)
    if not path.is_file():
        raise InvalidVideoError(f"Video file not found: {path.name}")

    if on_stage is not None:
        on_stage("transcribing")
    transcript = transcribe_video(path)
    if not transcript.strip():
        raise EmptyTranscriptError("Transcription produced no text.")

    if on_stage is not None:
        on_stage("analyzing")
    analysis = analyze_transcript(transcript)

    try:
        result = ProcessingResult(transcript=transcript, analysis=analysis)
    except ValidationError as exc:  # pragma: no cover - defensive guard
        raise AnalysisError("Processor produced an invalid result.") from exc

    return cast(ProcessingResultDict, result.model_dump())
