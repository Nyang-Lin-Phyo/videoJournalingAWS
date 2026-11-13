
import sqlite3
import tempfile
import unittest

from contextlib import closing
from pathlib import Path

from services.api.database import (
    get_connection,
    initialize_database,
)


class TestDatabase(unittest.TestCase):

    def setUp(self):
        # Each test uses its own temporary database.
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test.db"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_database_initialization(self):
        initialize_database(self.db_path)

        with closing(get_connection(self.db_path)) as conn:
            tables = conn.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type = 'table'"
            ).fetchall()

            table_names = [row["name"] for row in tables]

            self.assertIn("journals", table_names)

    def test_expected_columns(self):
        initialize_database(self.db_path)

        with closing(get_connection(self.db_path)) as conn:
            columns = conn.execute(
                "PRAGMA table_info(journals)"
            ).fetchall()

            column_names = {row["name"] for row in columns}

            expected = {
                "id",
                "user_id",
                "created_at",
                "status",
                "video_path",
                "transcript",
                "analysis_json",
                "error_message",
            }

            self.assertEqual(column_names, expected)

    def test_initialization_is_idempotent(self):
        # Calling initialization twice must not fail.
        initialize_database(self.db_path)
        initialize_database(self.db_path)

        self.assertTrue(self.db_path.exists())

    def test_insert_and_retrieve_journal(self):
        initialize_database(self.db_path)

        with closing(get_connection(self.db_path)) as conn:
            conn.execute(
                """
                INSERT INTO journals
                    (id, user_id, created_at, status)
                VALUES (?, ?, ?, ?)
                """,
                (
                    "test-001",
                    "dev-user",
                    "2026-10-26T20:00:00Z",
                    "awaiting_upload",
                ),
            )
            conn.commit()

        # Open a different connection to verify persistence.
        with closing(get_connection(self.db_path)) as conn:
            row = conn.execute(
                "SELECT * FROM journals WHERE id = ?",
                ("test-001",),
            ).fetchone()

            self.assertIsNotNone(row)
            self.assertEqual(row["id"], "test-001")
            self.assertEqual(row["status"], "awaiting_upload")
            self.assertEqual(row["user_id"], "dev-user")

    def test_invalid_status_rejected(self):
        initialize_database(self.db_path)

        with closing(get_connection(self.db_path)) as conn:
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    """
                    INSERT INTO journals
                        (id, user_id, created_at, status)
                    VALUES (?, ?, ?, ?)
                    """,
                    (
                        "test-002",
                        "dev-user",
                        "2026-10-26T20:00:00Z",
                        "invalid_status",
                    ),
                )


if __name__ == "__main__":
    unittest.main()
