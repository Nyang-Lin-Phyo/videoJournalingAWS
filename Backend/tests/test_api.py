
import asyncio
import os
import tempfile
import unittest

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from threading import Event
from unittest.mock import patch

from fastapi.testclient import TestClient

from services.api.database import get_connection
from services.api.main import app
from services.api.mock_processor import process_video_mock
from services.api.repository import (
    attach_video,
    complete_processing,
    get_journal,
)
from services.api.storage import (
    get_upload_directory,
    save_video,
)


# Synthetic MP4-like bytes for storage tests.
# This is not a fully playable video.
VIDEO_HEADER = b"\x00\x00\x00\x18ftypisom"
VIDEO_HEADERS = {"Content-Type": "video/mp4"}


class TestJournalAPI(unittest.TestCase):

    def setUp(self):
        """
        Give each test an isolated SQLite database
        and upload directory.
        """
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)

        db_path = Path(self.temp_dir.name) / "journals.db"
        upload_dir = Path(self.temp_dir.name) / "uploads"

        self.env_patch = patch.dict(
            os.environ,
            {
                "VIDEO_JOURNAL_DB_PATH": str(db_path),
                "VIDEO_JOURNAL_UPLOAD_DIR": str(upload_dir),
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

    # ==========================================
    # TEST HELPERS
    # ==========================================

    def create_uploaded_journal(
        self,
        video=None,
    ):
        """Create a journal and upload test video bytes."""

        if video is None:
            video = VIDEO_HEADER + b"test-video" * 100

        created = self.client.post("/api/journals").json()

        response = self.client.put(
            created["upload_url"],
            content=video,
            headers=VIDEO_HEADERS,
        )

        self.assertEqual(response.status_code, 204)

        return created

    # ==========================================
    # JOURNAL CREATION AND RETRIEVAL
    # ==========================================

    def test_create_journal(self):
        response = self.client.post("/api/journals")

        self.assertEqual(response.status_code, 201)

        data = response.json()
        journal = data["journal"]

        self.assertIsInstance(journal["id"], str)
        self.assertEqual(
            journal["status"], "awaiting_upload"
        )
        self.assertIsNone(journal["video_url"])
        self.assertIsNone(journal["transcript"])
        self.assertIsNone(journal["analysis"])

        self.assertEqual(
            data["upload_url"],
            f"/api/journals/{journal['id']}/video",
        )

    def test_get_existing_journal(self):
        created = self.client.post(
            "/api/journals"
        ).json()["journal"]

        response = self.client.get(
            f"/api/journals/{created['id']}"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), created)

    def test_get_nonexistent_journal(self):
        response = self.client.get(
            "/api/journals/nonexistent"
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(
            response.json(),
            {"detail": "Journal not found"},
        )

    # ==========================================
    # JOURNAL LISTING
    # ==========================================

    def test_list_journals_empty(self):
        response = self.client.get("/api/journals")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {"journals": []},
        )

    def test_list_journals_newest_first(self):
        first = self.client.post(
            "/api/journals"
        ).json()["journal"]

        second = self.client.post(
            "/api/journals"
        ).json()["journal"]

        with closing(get_connection()) as conn:
            conn.execute(
                """
                UPDATE journals
                SET created_at = ?
                WHERE id = ?
                """,
                ("2026-10-25T10:00:00Z", first["id"]),
            )
            conn.execute(
                """
                UPDATE journals
                SET created_at = ?
                WHERE id = ?
                """,
                ("2026-10-26T10:00:00Z", second["id"]),
            )
            conn.commit()

        response = self.client.get("/api/journals")

        self.assertEqual(response.status_code, 200)

        journals = response.json()["journals"]

        self.assertEqual(len(journals), 2)
        self.assertEqual(
            [journal["id"] for journal in journals],
            [second["id"], first["id"]],
        )

    def test_list_journals_user_isolation(self):
        created = self.client.post(
            "/api/journals"
        ).json()

        my_journal_id = created["journal"]["id"]

        with closing(get_connection()) as conn:
            conn.execute(
                """
                INSERT INTO journals
                    (id, user_id, created_at, status)
                VALUES (?, ?, ?, ?)
                """,
                (
                    "other-user-journal",
                    "another-user",
                    "2026-10-26T12:00:00Z",
                    "awaiting_upload",
                ),
            )
            conn.commit()

        response = self.client.get("/api/journals")

        self.assertEqual(response.status_code, 200)

        journal_ids = [
            journal["id"]
            for journal in response.json()["journals"]
        ]

        self.assertEqual(journal_ids, [my_journal_id])

    # ==========================================
    # VIDEO UPLOAD AND DOWNLOAD
    # ==========================================

    def test_upload_and_download_video(self):
        created = self.create_uploaded_journal()

        journal_id = created["journal"]["id"]
        video_path = (
            get_upload_directory()
            / f"{journal_id}.mp4"
        )

        self.assertTrue(video_path.is_file())

        journal = self.client.get(
            f"/api/journals/{journal_id}"
        ).json()

        self.assertEqual(
            journal["video_url"],
            f"/api/journals/{journal_id}/video",
        )

        download = self.client.get(journal["video_url"])

        self.assertEqual(download.status_code, 200)
        self.assertEqual(
            download.content,
            video_path.read_bytes(),
        )

    def test_invalid_video_rejected(self):
        created = self.client.post(
            "/api/journals"
        ).json()

        response = self.client.put(
            created["upload_url"],
            content=b"This is not an MP4",
            headers=VIDEO_HEADERS,
        )

        self.assertEqual(response.status_code, 415)

        journal = self.client.get(
            f"/api/journals/{created['journal']['id']}"
        ).json()

        self.assertIsNone(journal["video_url"])

    def test_unsupported_content_type(self):
        created = self.client.post(
            "/api/journals"
        ).json()

        response = self.client.put(
            created["upload_url"],
            content=b"Some content",
            headers={"Content-Type": "text/plain"},
        )

        self.assertEqual(response.status_code, 415)

    def test_oversized_video_rejected(self):
        created = self.client.post(
            "/api/journals"
        ).json()

        video = (
            VIDEO_HEADER
            + b"x" * (30 * 1024 * 1024)
        )

        response = self.client.put(
            created["upload_url"],
            content=video,
            headers=VIDEO_HEADERS,
        )

        self.assertEqual(response.status_code, 413)
        self.assertEqual(
            list(get_upload_directory().iterdir()),
            [],
        )

    def test_nonexistent_journal_upload(self):
        response = self.client.put(
            "/api/journals/nonexistent/video",
            content=VIDEO_HEADER,
            headers=VIDEO_HEADERS,
        )

        self.assertEqual(response.status_code, 404)

    def test_video_range_request(self):
        created = self.client.post(
            "/api/journals"
        ).json()

        video = VIDEO_HEADER + b"x" * 2048

        upload = self.client.put(
            created["upload_url"],
            content=video,
            headers=VIDEO_HEADERS,
        )

        self.assertEqual(upload.status_code, 204)

        response = self.client.get(
            created["upload_url"],
            headers={"Range": "bytes=0-1023"},
        )

        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.content, video[:1024])

        self.assertEqual(
            response.headers["content-range"],
            f"bytes 0-1023/{len(video)}",
        )

    # ==========================================
    # UPLOAD SAFETY AND CONCURRENCY
    # ==========================================

    def test_second_upload_rejected_without_overwrite(self):
        created = self.client.post(
            "/api/journals"
        ).json()

        original = VIDEO_HEADER + b"a" * 64
        replacement = VIDEO_HEADER + b"b" * 64

        first = self.client.put(
            created["upload_url"],
            content=original,
            headers=VIDEO_HEADERS,
        )
        self.assertEqual(first.status_code, 204)

        second = self.client.put(
            created["upload_url"],
            content=replacement,
            headers=VIDEO_HEADERS,
        )

        self.assertEqual(second.status_code, 409)

        download = self.client.get(
            created["upload_url"]
        )
        self.assertEqual(download.content, original)

        self.assertEqual(
            len(list(get_upload_directory().iterdir())),
            1,
        )

        self.assertFalse(
            attach_video(
                created["journal"]["id"],
                Path("replacement.mp4"),
            )
        )

    def test_cannot_access_another_users_journal(self):
        created = self.create_uploaded_journal()

        with closing(get_connection()) as conn:
            conn.execute(
                """
                UPDATE journals
                SET user_id = ?
                WHERE id = ?
                """,
                (
                    "another-user",
                    created["journal"]["id"],
                ),
            )
            conn.commit()

        response = self.client.get(
            f"/api/journals/{created['journal']['id']}"
        )
        self.assertEqual(response.status_code, 404)

        response = self.client.get(
            created["upload_url"]
        )
        self.assertEqual(response.status_code, 404)

        response = self.client.put(
            created["upload_url"],
            content=VIDEO_HEADER,
            headers=VIDEO_HEADERS,
        )
        self.assertEqual(response.status_code, 404)

    def test_orphaned_file_is_not_overwritten(self):
        created = self.client.post(
            "/api/journals"
        ).json()

        path = (
            get_upload_directory()
            / f"{created['journal']['id']}.mp4"
        )

        existing = b"do not overwrite"
        path.write_bytes(existing)

        candidate = VIDEO_HEADER + b"new-data"

        response = self.client.put(
            created["upload_url"],
            content=candidate,
            headers=VIDEO_HEADERS,
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(path.read_bytes(), existing)

        journal = self.client.get(
            f"/api/journals/{created['journal']['id']}"
        ).json()

        self.assertIsNone(journal["video_url"])
        self.assertEqual(
            list(get_upload_directory().iterdir()),
            [path],
        )

    def test_database_attachment_failure_cleans_up_file(self):
        created = self.client.post(
            "/api/journals"
        ).json()

        video = VIDEO_HEADER + b"payload"

        with patch(
            "services.api.routes.journals.attach_video",
            return_value=False,
        ):
            response = self.client.put(
                created["upload_url"],
                content=video,
                headers=VIDEO_HEADERS,
            )

        self.assertEqual(response.status_code, 409)

        self.assertEqual(
            list(get_upload_directory().iterdir()),
            [],
        )

        journal = self.client.get(
            f"/api/journals/{created['journal']['id']}"
        ).json()

        self.assertIsNone(journal["video_url"])

    def test_concurrent_uploads_only_one_succeeds(self):
        created = self.client.post(
            "/api/journals"
        ).json()

        upload_url = created["upload_url"]

        original = VIDEO_HEADER + b"a" * 1024
        competing = VIDEO_HEADER + b"b" * 1024

        started = Event()
        release = Event()

        async def delayed_save(journal_id, request):
            started.set()

            allowed = await asyncio.to_thread(
                release.wait,
                5,
            )

            if not allowed:
                raise RuntimeError(
                    "Timed out waiting for test release"
                )

            return await save_video(journal_id, request)

        with patch(
            "services.api.routes.journals.save_video",
            new=delayed_save,
        ):
            with ThreadPoolExecutor(max_workers=2) as executor:
                first_future = executor.submit(
                    self.client.put,
                    upload_url,
                    content=original,
                    headers=VIDEO_HEADERS,
                )

                try:
                    self.assertTrue(started.wait(timeout=3))

                    second = self.client.put(
                        upload_url,
                        content=competing,
                        headers=VIDEO_HEADERS,
                    )

                    self.assertEqual(
                        second.status_code, 409
                    )
                finally:
                    release.set()

                first = first_future.result(timeout=5)

        self.assertEqual(first.status_code, 204)

        download = self.client.get(upload_url)

        self.assertEqual(download.status_code, 200)
        self.assertEqual(download.content, original)

    # ==========================================
    # JOURNAL DELETION
    # ==========================================

    def test_delete_journal_without_video(self):
        created = self.client.post(
            "/api/journals"
        ).json()

        journal_id = created["journal"]["id"]

        response = self.client.delete(
            f"/api/journals/{journal_id}"
        )

        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.content, b"")

        get_response = self.client.get(
            f"/api/journals/{journal_id}"
        )
        self.assertEqual(get_response.status_code, 404)

        list_response = self.client.get("/api/journals")
        self.assertEqual(
            list_response.json(),
            {"journals": []},
        )

    def test_delete_journal_with_video(self):
        created = self.create_uploaded_journal()

        journal_id = created["journal"]["id"]
        video_url = created["upload_url"]

        video_path = (
            get_upload_directory()
            / f"{journal_id}.mp4"
        )

        self.assertTrue(video_path.exists())

        response = self.client.delete(
            f"/api/journals/{journal_id}"
        )

        self.assertEqual(response.status_code, 204)

        self.assertEqual(
            self.client.get(
                f"/api/journals/{journal_id}"
            ).status_code,
            404,
        )

        self.assertEqual(
            self.client.get(video_url).status_code,
            404,
        )

        self.assertFalse(video_path.exists())
        self.assertEqual(
            list(get_upload_directory().iterdir()),
            [],
        )

    def test_delete_nonexistent_journal(self):
        response = self.client.delete(
            "/api/journals/nonexistent"
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(
            response.json(),
            {"detail": "Journal not found"},
        )

    def test_delete_journal_twice(self):
        created = self.client.post(
            "/api/journals"
        ).json()

        journal_id = created["journal"]["id"]
        url = f"/api/journals/{journal_id}"

        first = self.client.delete(url)
        second = self.client.delete(url)

        self.assertEqual(first.status_code, 204)
        self.assertEqual(second.status_code, 404)

    def test_cannot_delete_another_users_journal(self):
        video = VIDEO_HEADER + b"private-video"
        created = self.create_uploaded_journal(video)

        journal_id = created["journal"]["id"]

        video_path = (
            get_upload_directory()
            / f"{journal_id}.mp4"
        )

        with closing(get_connection()) as conn:
            conn.execute(
                """
                UPDATE journals
                SET user_id = ?
                WHERE id = ?
                """,
                ("another-user", journal_id),
            )
            conn.commit()

        response = self.client.delete(
            f"/api/journals/{journal_id}"
        )

        self.assertEqual(response.status_code, 404)

        with closing(get_connection()) as conn:
            row = conn.execute(
                "SELECT user_id FROM journals WHERE id = ?",
                (journal_id,),
            ).fetchone()

        self.assertIsNotNone(row)
        self.assertEqual(row["user_id"], "another-user")

        self.assertTrue(video_path.exists())
        self.assertEqual(video_path.read_bytes(), video)

    def test_database_delete_failure_restores_video(self):
        video = VIDEO_HEADER + b"restore-me"
        created = self.create_uploaded_journal(video)

        journal_id = created["journal"]["id"]

        video_path = (
            get_upload_directory()
            / f"{journal_id}.mp4"
        )

        with patch(
            "services.api.routes.journals.delete_journal",
            side_effect=RuntimeError(
                "Simulated database failure"
            ),
        ):
            with self.assertRaises(RuntimeError):
                self.client.delete(
                    f"/api/journals/{journal_id}"
                )

        self.assertTrue(video_path.exists())
        self.assertEqual(video_path.read_bytes(), video)

        journal = self.client.get(
            f"/api/journals/{journal_id}"
        )

        self.assertEqual(journal.status_code, 200)

        self.assertEqual(
            list(get_upload_directory().iterdir()),
            [video_path],
        )

    def test_delete_during_upload_returns_conflict(self):
        created = self.client.post(
            "/api/journals"
        ).json()

        journal_id = created["journal"]["id"]
        upload_url = created["upload_url"]

        video = VIDEO_HEADER + b"concurrent-test" * 100

        started = Event()
        release = Event()

        async def delayed_save(journal_id_arg, request):
            started.set()

            allowed = await asyncio.to_thread(
                release.wait,
                5,
            )

            if not allowed:
                raise RuntimeError(
                    "Timed out waiting for test release"
                )

            return await save_video(
                journal_id_arg,
                request,
            )

        with patch(
            "services.api.routes.journals.save_video",
            new=delayed_save,
        ):
            with ThreadPoolExecutor(max_workers=2) as executor:
                upload_future = executor.submit(
                    self.client.put,
                    upload_url,
                    content=video,
                    headers=VIDEO_HEADERS,
                )

                try:
                    self.assertTrue(
                        started.wait(timeout=3)
                    )

                    delete_response = self.client.delete(
                        f"/api/journals/{journal_id}"
                    )

                    self.assertEqual(
                        delete_response.status_code,
                        409,
                    )
                finally:
                    release.set()

                upload_response = upload_future.result(
                    timeout=5
                )

        self.assertEqual(upload_response.status_code, 204)

        journal = self.client.get(
            f"/api/journals/{journal_id}"
        )

        self.assertEqual(journal.status_code, 200)

        download = self.client.get(upload_url)

        self.assertEqual(download.status_code, 200)
        self.assertEqual(download.content, video)

    # ==========================================
    # MOCK PROCESSING
    # ==========================================

    def test_complete_nonexistent_journal(self):
        response = self.client.post(
            "/api/journals/nonexistent/complete"
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(
            response.json(),
            {"detail": "Journal not found"},
        )

    def test_complete_without_video_rejected(self):
        created = self.client.post(
            "/api/journals"
        ).json()

        journal_id = created["journal"]["id"]

        response = self.client.post(
            f"/api/journals/{journal_id}/complete"
        )

        self.assertEqual(response.status_code, 409)

        journal = self.client.get(
            f"/api/journals/{journal_id}"
        ).json()

        self.assertEqual(
            journal["status"],
            "awaiting_upload",
        )
        self.assertIsNone(journal["transcript"])
        self.assertIsNone(journal["analysis"])

    def test_complete_another_users_journal_rejected(self):
        created = self.create_uploaded_journal()
        journal_id = created["journal"]["id"]

        with closing(get_connection()) as conn:
            conn.execute(
                """
                UPDATE journals
                SET user_id = ?
                WHERE id = ?
                """,
                ("another-user", journal_id),
            )
            conn.commit()

        response = self.client.post(
            f"/api/journals/{journal_id}/complete"
        )

        self.assertEqual(response.status_code, 404)

        # Confirm that the other user's state did not change.
        with closing(get_connection()) as conn:
            row = conn.execute(
                """
                SELECT status
                FROM journals
                WHERE id = ?
                """,
                (journal_id,),
            ).fetchone()

        self.assertEqual(
            row["status"],
            "awaiting_upload",
        )

    def test_complete_returns_queued_and_saves_results(self):
        created = self.create_uploaded_journal()

        journal_id = created["journal"]["id"]

        response = self.client.post(
            f"/api/journals/{journal_id}/complete"
        )

        self.assertEqual(response.status_code, 202)

        queued = response.json()

        self.assertEqual(queued["id"], journal_id)
        self.assertEqual(queued["status"], "queued")
        self.assertEqual(
            queued["video_url"],
            created["upload_url"],
        )
        self.assertIsNone(queued["transcript"])
        self.assertIsNone(queued["analysis"])
        self.assertIsNone(queued["error_message"])

        # TestClient waits for FastAPI background tasks
        # before returning control to this test.
        journal = self.client.get(
            f"/api/journals/{journal_id}"
        ).json()

        self.assertEqual(
            journal["status"],
            "completed",
        )

        self.assertEqual(
            journal["transcript"],
            (
                "[MOCK TRANSCRIPT] "
                "This is a placeholder transcript. "
                "The uploaded video has not been transcribed."
            ),
        )

        self.assertEqual(
            journal["analysis"],
            {
                "sentiment": "neutral",
                "emotions": [],
                "themes": [],
                "summary": (
                    "[MOCK ANALYSIS] "
                    "The video was uploaded successfully, "
                    "but no actual AI analysis was performed."
                ),
            },
        )

        self.assertIsNone(journal["error_message"])

        # Completed journals must also appear in history.
        history = self.client.get(
            "/api/journals"
        ).json()["journals"]

        self.assertEqual(len(history), 1)
        self.assertEqual(
            history[0]["status"],
            "completed",
        )

    def test_duplicate_complete_rejected(self):
        created = self.create_uploaded_journal()

        journal_id = created["journal"]["id"]
        url = f"/api/journals/{journal_id}/complete"

        first = self.client.post(url)
        self.assertEqual(first.status_code, 202)

        completed_before = self.client.get(
            f"/api/journals/{journal_id}"
        ).json()

        self.assertEqual(
            completed_before["status"],
            "completed",
        )

        second = self.client.post(url)

        self.assertEqual(second.status_code, 409)

        completed_after = self.client.get(
            f"/api/journals/{journal_id}"
        ).json()

        # A duplicate request must not reset the results.
        self.assertEqual(
            completed_after,
            completed_before,
        )

    def test_processing_transitions_in_order(self):
        created = self.create_uploaded_journal()
        journal_id = created["journal"]["id"]

        observed_statuses = []

        def inspect_transcription(video_path):
            # This function is called by the coordinator
            # after it claims the queued journal.
            journal = get_journal(journal_id)
            observed_statuses.append(journal["status"])

            return process_video_mock(video_path)

        def inspect_completion(
            journal_id_arg,
            transcript,
            analysis,
        ):
            # Inspect the status immediately before
            # the coordinator saves its final results.
            journal = get_journal(journal_id_arg)
            observed_statuses.append(journal["status"])

            return complete_processing(
                journal_id_arg,
                transcript,
                analysis,
            )

        with patch(
            "services.api.processing.process_video_mock",
            side_effect=inspect_transcription,
        ):
            with patch(
                "services.api.processing.complete_processing",
                side_effect=inspect_completion,
            ):
                response = self.client.post(
                    f"/api/journals/{journal_id}/complete"
                )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(
            response.json()["status"],
            "queued",
        )

        self.assertEqual(
            observed_statuses,
            ["transcribing", "analyzing"],
        )

        journal = get_journal(journal_id)

        self.assertEqual(
            journal["status"],
            "completed",
        )

    def test_mock_processing_failure_recorded(self):
        created = self.create_uploaded_journal()

        journal_id = created["journal"]["id"]

        # Force the mock processor to fail.
        # The coordinator should catch this exception
        # and record a safe, generic error message.
        with patch(
            "services.api.processing.process_video_mock",
            side_effect=RuntimeError(
                "Sensitive internal processing error"
            ),
        ):
            with self.assertLogs(
                "services.api.processing",
                level="ERROR",
            ):
                response = self.client.post(
                    f"/api/journals/{journal_id}/complete"
                )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(
            response.json()["status"],
            "queued",
        )

        journal = self.client.get(
            f"/api/journals/{journal_id}"
        ).json()

        self.assertEqual(
            journal["status"],
            "failed",
        )
        self.assertEqual(
            journal["error_message"],
            "Mock processing failed",
        )

        self.assertIsNone(journal["transcript"])
        self.assertIsNone(journal["analysis"])

        # The internal exception must not be exposed
        # in the public journal response.
        self.assertNotIn(
            "Sensitive internal",
            str(journal),
        )


if __name__ == "__main__":
    unittest.main()
