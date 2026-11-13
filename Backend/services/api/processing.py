
import logging
import os

from .mock_processor import process_video_mock
from .repository import (
    advance_processing_status,
    complete_processing,
    fail_processing,
    get_video_path,
)


logger = logging.getLogger(__name__)


class _ProcessorFailure(Exception):
    """
    The real processor failed with a message that is
    already safe to show to the user.

    Developer 3's ProcessorError subclasses guarantee
    short, non-sensitive messages (no stack traces,
    API keys, or full filesystem paths).
    """


def _real_processor_enabled() -> bool:
    """
    PROCESSOR_MODE=real selects Developer 3's
    process_video(); the default remains the local mock.
    """

    return (
        os.getenv("PROCESSOR_MODE", "mock").strip().lower()
        == "real"
    )


def _processing_failure_message() -> str:
    """Generic failure text for unexpected exceptions."""

    if _real_processor_enabled():
        return "Processing failed"

    return "Mock processing failed"


def _run_real_processor(video_path, journal_id: str):
    """
    Run Developer 3's process_video() (Contract B).

    The import stays lazy so mock mode never needs the
    processor installed. on_stage() maps the processor's
    stage callbacks onto database status transitions:
    "transcribing" is already active when this starts,
    and "analyzing" advances the status before analysis
    runs so the API reflects real stage progress.
    """

    from services.processor.pipeline import process_video

    def on_stage(stage: str) -> None:
        if stage == "analyzing":
            advanced = advance_processing_status(
                journal_id,
                expected_status="transcribing",
                new_status="analyzing",
            )

            if not advanced:
                # Surface the failure; never swallow it.
                raise RuntimeError(
                    "Journal state changed during processing"
                )

    result = process_video(video_path, on_stage=on_stage)

    return result["transcript"], result["analysis"]


def process_queued_journal(journal_id: str) -> None:
    """
    Process a queued journal.

    This function is invoked by FastAPI BackgroundTasks
    after the HTTP 202 response has been sent.

    PROCESSOR_MODE=real runs Developer 3's real
    processor (transcription + analysis); otherwise the
    local mock placeholder is used.
    """

    # Claim the queued journal for processing.
    claimed = advance_processing_status(
        journal_id,
        expected_status="queued",
        new_status="transcribing",
    )

    if not claimed:
        logger.warning(
            "Journal %s could not be claimed for processing",
            journal_id,
        )
        return

    try:
        video_path = get_video_path(journal_id)

        if video_path is None:
            raise FileNotFoundError(
                "Journal has no attached video"
            )

        if _real_processor_enabled():
            from services.processor.errors import ProcessorError

            try:
                transcript, analysis = _run_real_processor(
                    video_path,
                    journal_id,
                )
            except ProcessorError as exc:
                # Typed processor errors carry safe messages.
                raise _ProcessorFailure(str(exc)) from exc

            # on_stage("analyzing") already advanced the
            # status to analyzing on the success path.
        else:
            transcript, analysis = process_video_mock(
                video_path
            )

            advanced = advance_processing_status(
                journal_id,
                expected_status="transcribing",
                new_status="analyzing",
            )

            if not advanced:
                logger.warning(
                    "Journal %s changed during processing",
                    journal_id,
                )
                return

        saved = complete_processing(
            journal_id,
            transcript,
            analysis,
        )

        if not saved:
            logger.warning(
                "Could not save results for journal %s",
                journal_id,
            )
            return

        logger.info(
            "Processing completed for journal %s",
            journal_id,
        )

    except _ProcessorFailure as exc:
        logger.error(
            "Processor failed for journal %s: %s",
            journal_id,
            exc,
        )

        fail_processing(
            journal_id,
            str(exc),
        )

    except Exception:
        logger.exception(
            "Processing failed for journal %s",
            journal_id,
        )

        # Do not expose internal filesystem paths
        # or exception details in the public API.
        fail_processing(
            journal_id,
            _processing_failure_message(),
        )
