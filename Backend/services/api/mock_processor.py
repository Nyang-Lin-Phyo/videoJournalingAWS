
from pathlib import Path


def process_video_mock(
    video_path: Path,
) -> tuple[str, dict]:
    """
    Return a mock transcript and analysis.

    This is a local development placeholder.
    It does not perform speech recognition
    or AI analysis.
    """

    if not video_path.is_file():
        raise FileNotFoundError(
            f"Video file not found: {video_path}"
        )

    transcript = (
        "[MOCK TRANSCRIPT] "
        "This is a placeholder transcript. "
        "The uploaded video has not been transcribed."
    )

    analysis = {
        "sentiment": "neutral",
        "emotions": [],
        "themes": [],
        "summary": (
            "[MOCK ANALYSIS] "
            "The video was uploaded successfully, "
            "but no actual AI analysis was performed."
        ),
    }

    return transcript, analysis
