"""Standalone CLI around the production process_video callable.

Run from the repository root:

    TRANSCRIPTION_MODE=mock ANALYSIS_MODE=mock \
        python -m services.processor.cli samples/test-journal.mp4

stdout carries only the JSON result, so it pipes cleanly into
``python -m json.tool``. All diagnostics — synthetic-output notices,
timing, errors — go to stderr. The exit code is 0 on success and 1 on any
processor error.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from .config import load_config
from .errors import ProcessorError
from .pipeline import process_video

_MOCK_NOTICE = (
    "NOTICE: processor is in MOCK mode; the JSON output is SYNTHETIC test "
    "data, not a real transcript or analysis."
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m services.processor.cli",
        description=(
            "Transcribe and analyze one MP4 video journal. "
            "Prints the processing result as JSON on stdout."
        ),
    )
    parser.add_argument(
        "video",
        type=Path,
        help="Path to an MP4 video journal to process.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    video_path: Path = args.video

    try:
        config = load_config()
        if config.is_mock:
            print(_MOCK_NOTICE, file=sys.stderr)

        started = time.perf_counter()
        result = process_video(video_path)
        elapsed = time.perf_counter() - started
        print(
            f"processed {video_path.name} in {elapsed:.2f}s "
            f"(transcription={config.transcription_mode}, "
            f"analysis={config.analysis_mode})",
            file=sys.stderr,
        )
    except ProcessorError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
