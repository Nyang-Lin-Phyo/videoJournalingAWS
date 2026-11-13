
import os
import tempfile
import unittest

from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from services.api.main import app
from services.processor.errors import (
    EmptyTranscriptError,
    InvalidVideoError,
)


# Synthetic MP4-like bytes (same convention as test_api.py).
VIDEO_HEADER = b"\x00\x00\x00\x18ftypisom"
VIDEO_HEADERS = {"Content-Type": "video/mp4"}

VALID_ANALYSIS = {
    "sentiment": "positive",
    "emotions": ["joy"],
    "themes": ["friends"],
    "summary": "The speaker describes a pleasant day.",
}


class TestRealProcessorAdapter(unittest.TestCase):
    """
    PROCESSOR_MODE=real wiring: the API job runner must
    call Developer 3's process_video(), store its result,
    and record typed failures with safe messages.
    """

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)

        db_path = Path(self.temp_dir.name) / "journals.db"
        upload_dir = Path(self.temp_dir.name) / "uploads"

        self.env_patch = patch.dict(
            os.environ,
            {
                "VIDEO_JOURNAL_DB_PATH": str(db_path),
                "VIDEO_JOURNAL_UPLOAD_DIR": str(upload_dir),
                "PROCESSOR_MODE": "real",
            },
        )
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

        self.client_context = TestClient(app)
        self.client = self.client_context.__enter__()
        self.addCleanup(
            self.client_context.__exit__,
            None, None, None,
        )

    def create_uploaded_journal(self) -> str:
        response = self.client.post("/api/journals")
        journal_id = response.json()["journal"]["id"]

        response = self.client.put(
            f"/api/journals/{journal_id}/video",
            content=VIDEO_HEADER,
            headers=VIDEO_HEADERS,
        )
        assert response.status_code == 204

        return journal_id

    def test_real_mode_completes_with_processor_result(self):
        journal_id = self.create_uploaded_journal()

        observed = []

        def fake_process_video(video_path, *, on_stage=None):
            observed.append(Path(video_path).name)
            if on_stage is not None:
                on_stage("transcribing")
                on_stage("analyzing")
            return {
                "transcript": "Today was a great day.",
                "analysis": dict(VALID_ANALYSIS),
            }

        with patch(
            "services.processor.pipeline.process_video",
            side_effect=fake_process_video,
        ):
            response = self.client.post(
                f"/api/journals/{journal_id}/complete"
            )

        self.assertEqual(response.status_code, 202)

        journal = self.client.get(
            f"/api/journals/{journal_id}"
        ).json()

        self.assertEqual(journal["status"], "completed")
        self.assertEqual(
            journal["transcript"],
            "Today was a great day.",
        )
        self.assertEqual(journal["analysis"], VALID_ANALYSIS)
        self.assertIsNone(journal["error_message"])

        # The adapter must pass the stored video file path.
        self.assertEqual(len(observed), 1)
        self.assertTrue(observed[0].endswith(".mp4"))

    def test_status_reaches_analyzing_during_analysis(self):
        """on_stage must advance transcribing -> analyzing."""

        journal_id = self.create_uploaded_journal()
        status_during_analysis = {}

        def fake_process_video(video_path, *, on_stage=None):
            if on_stage is not None:
                on_stage("transcribing")
                on_stage("analyzing")
                # Read status after the callback fired:
                # analysis begins in this state.
                from services.api.repository import get_journal

                status_during_analysis["status"] = get_journal(
                    journal_id
                )["status"]
            return {
                "transcript": "hello",
                "analysis": dict(VALID_ANALYSIS),
            }

        with patch(
            "services.processor.pipeline.process_video",
            side_effect=fake_process_video,
        ):
            self.client.post(f"/api/journals/{journal_id}/complete")

        self.assertEqual(
            status_during_analysis["status"],
            "analyzing",
        )

        journal = self.client.get(
            f"/api/journals/{journal_id}"
        ).json()
        self.assertEqual(journal["status"], "completed")

    def test_typed_processor_failure_is_recorded_safely(self):
        journal_id = self.create_uploaded_journal()

        with patch(
            "services.processor.pipeline.process_video",
            side_effect=InvalidVideoError(
                "File does not look like an MP4: bad.mp4"
            ),
        ):
            self.client.post(f"/api/journals/{journal_id}/complete")

        journal = self.client.get(
            f"/api/journals/{journal_id}"
        ).json()

        self.assertEqual(journal["status"], "failed")
        # The typed, safe message reaches the user.
        self.assertEqual(
            journal["error_message"],
            "File does not look like an MP4: bad.mp4",
        )
        self.assertIsNone(journal["transcript"])
        self.assertIsNone(journal["analysis"])

    def test_empty_transcript_failure_recorded(self):
        journal_id = self.create_uploaded_journal()

        with patch(
            "services.processor.pipeline.process_video",
            side_effect=EmptyTranscriptError(
                "Transcription produced no text."
            ),
        ):
            self.client.post(f"/api/journals/{journal_id}/complete")

        journal = self.client.get(
            f"/api/journals/{journal_id}"
        ).json()

        self.assertEqual(journal["status"], "failed")
        self.assertEqual(
            journal["error_message"],
            "Transcription produced no text.",
        )

    def test_unexpected_error_never_leaks_internals(self):
        journal_id = self.create_uploaded_journal()

        with patch(
            "services.processor.pipeline.process_video",
            side_effect=RuntimeError(
                "SECRET internal path /home/user/keys"
            ),
        ):
            with self.assertLogs(
                "services.api.processing", level="ERROR"
            ):
                self.client.post(
                    f"/api/journals/{journal_id}/complete"
                )

        journal = self.client.get(
            f"/api/journals/{journal_id}"
        ).json()

        self.assertEqual(journal["status"], "failed")
        self.assertEqual(
            journal["error_message"],
            "Processing failed",
        )
        self.assertNotIn("SECRET", str(journal))

    def test_callback_failure_surfaces_as_failure(self):
        """A failed on_stage transition must not be swallowed."""

        journal_id = self.create_uploaded_journal()

        def exploding_callback(video_path, *, on_stage=None):
            on_stage("transcribing")
            on_stage("analyzing")  # advance refuses -> raises
            return {"transcript": "x", "analysis": dict(VALID_ANALYSIS)}

        with patch(
            "services.processor.pipeline.process_video",
            side_effect=exploding_callback,
        ):
            # First advance (claim) succeeds; the on_stage
            # transition is refused, simulating a journal
            # that changed state mid-processing.
            with patch(
                "services.api.processing.advance_processing_status",
                side_effect=[True, False],
            ):
                with self.assertLogs(
                    "services.api.processing", level="ERROR"
                ):
                    self.client.post(
                        f"/api/journals/{journal_id}/complete"
                    )

        journal = self.client.get(
            f"/api/journals/{journal_id}"
        ).json()

        self.assertEqual(journal["status"], "failed")
        self.assertEqual(
            journal["error_message"],
            "Processing failed",
        )

    def test_mock_mode_still_used_by_default(self):
        """Without PROCESSOR_MODE the mock path is untouched."""

        with patch.dict(
            os.environ, {"PROCESSOR_MODE": "mock"}
        ):
            journal_id = self.create_uploaded_journal()

            with patch(
                "services.api.processing.process_video_mock",
                return_value=("[MOCK] transcript", dict(VALID_ANALYSIS)),
            ) as mock:
                self.client.post(
                    f"/api/journals/{journal_id}/complete"
                )
                mock.assert_called_once()

        journal = self.client.get(
            f"/api/journals/{journal_id}"
        ).json()
        self.assertEqual(journal["status"], "completed")
        self.assertEqual(journal["transcript"], "[MOCK] transcript")


class TestOpenApiAndCors(unittest.TestCase):
    """Contract alignment and frontend development origins."""

    def setUp(self):
        self.client_context = TestClient(app)
        self.client = self.client_context.__enter__()
        self.addCleanup(
            self.client_context.__exit__,
            None, None, None,
        )

    def test_complete_operation_id_matches_contract(self):
        spec = self.client.get("/openapi.json").json()
        operation_ids = [
            path_item.get(operation, {}).get("operationId")
            for path, path_item in spec["paths"].items()
            for operation in path_item
        ]

        self.assertIn("completeJournalUpload", operation_ids)

    def test_cors_allows_vite_dev_server(self):
        response = self.client.options(
            "/api/journals",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "POST",
            },
        )

        self.assertEqual(
            response.headers.get("access-control-allow-origin"),
            "http://localhost:5173",
        )

    def test_cors_rejects_unknown_origin(self):
        response = self.client.options(
            "/api/journals",
            headers={
                "Origin": "http://evil.example",
                "Access-Control-Request-Method": "POST",
            },
        )

        self.assertIsNone(
            response.headers.get("access-control-allow-origin")
        )


if __name__ == "__main__":
    unittest.main()
