
import json
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .database import get_connection


# Temporary identity for local development only.
DEV_USER_ID = "dev-user"


def row_to_journal(row) -> dict:
    """Convert a SQLite row into the API contract format."""

    return {
        "id": row["id"],
        "created_at": row["created_at"],
        "status": row["status"],
        "video_url": (
            f"/api/journals/{row['id']}/video"
            if row["video_path"] is not None
            else None
        ),
        "transcript": row["transcript"],
        "analysis": (
            json.loads(row["analysis_json"])
            if row["analysis_json"] is not None
            else None
        ),
        "error_message": row["error_message"],
    }


def create_journal(user_id: str = DEV_USER_ID) -> dict:
    """Create a journal in awaiting_upload state."""

    journal_id = str(uuid4())

    created_at = datetime.now(timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )

    with closing(get_connection()) as conn:
        conn.execute(
            """
            INSERT INTO journals
                (id, user_id, created_at, status)
            VALUES (?, ?, ?, ?)
            """,
            (
                journal_id,
                user_id,
                created_at,
                "awaiting_upload",
            ),
        )

        conn.commit()

        row = conn.execute(
            "SELECT * FROM journals WHERE id = ?",
            (journal_id,),
        ).fetchone()

    return row_to_journal(row)


def get_journal(
    journal_id: str,
    user_id: str = DEV_USER_ID,
) -> dict | None:
    """Retrieve a journal belonging to the specified user."""

    with closing(get_connection()) as conn:
        row = conn.execute(
            """
            SELECT *
            FROM journals
            WHERE id = ? AND user_id = ?
            """,
            (journal_id, user_id),
        ).fetchone()

    return row_to_journal(row) if row is not None else None


def list_journals(
    user_id: str = DEV_USER_ID,
) -> list[dict]:
    """Return a user's journals, newest first."""

    with closing(get_connection()) as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM journals
            WHERE user_id = ?
            ORDER BY created_at DESC, id DESC
            """,
            (user_id,),
        ).fetchall()

    return [row_to_journal(row) for row in rows]


def attach_video(
    journal_id: str,
    video_path: Path,
    user_id: str = DEV_USER_ID,
) -> bool:
    """Attach a video only if one is not already attached."""

    with closing(get_connection()) as conn:
        cursor = conn.execute(
            """
            UPDATE journals
            SET video_path = ?
            WHERE id = ?
              AND user_id = ?
              AND status = 'awaiting_upload'
              AND video_path IS NULL
            """,
            (str(video_path), journal_id, user_id),
        )

        conn.commit()

    return cursor.rowcount == 1


def get_video_path(
    journal_id: str,
    user_id: str = DEV_USER_ID,
) -> Path | None:
    """Retrieve the internal path of a stored video."""

    with closing(get_connection()) as conn:
        row = conn.execute(
            """
            SELECT video_path
            FROM journals
            WHERE id = ? AND user_id = ?
            """,
            (journal_id, user_id),
        ).fetchone()

    if row is None or row["video_path"] is None:
        return None

    return Path(row["video_path"])


def delete_journal(
    journal_id: str,
    user_id: str = DEV_USER_ID,
) -> bool:
    """Delete a journal belonging to the specified user."""

    with closing(get_connection()) as conn:
        cursor = conn.execute(
            """
            DELETE FROM journals
            WHERE id = ? AND user_id = ?
            """,
            (journal_id, user_id),
        )

        conn.commit()

    return cursor.rowcount == 1


# ==========================================
# PROCESSING LIFECYCLE
# ==========================================

def queue_journal(
    journal_id: str,
    user_id: str = DEV_USER_ID,
) -> dict | None:
    """
    Atomically move a journal from awaiting_upload
    to queued, only when a video is attached.

    Returns the queued journal or None if the
    journal cannot be queued.
    """

    with closing(get_connection()) as conn:
        cursor = conn.execute(
            """
            UPDATE journals
            SET status = 'queued',
                error_message = NULL
            WHERE id = ?
              AND user_id = ?
              AND status = 'awaiting_upload'
              AND video_path IS NOT NULL
            """,
            (journal_id, user_id),
        )

        conn.commit()

        if cursor.rowcount != 1:
            return None

        row = conn.execute(
            """
            SELECT *
            FROM journals
            WHERE id = ? AND user_id = ?
            """,
            (journal_id, user_id),
        ).fetchone()

    return row_to_journal(row) if row is not None else None


def advance_processing_status(
    journal_id: str,
    expected_status: str,
    new_status: str,
    user_id: str = DEV_USER_ID,
) -> bool:
    """
    Perform a permitted processing status transition.
    """

    allowed = {
        ("queued", "transcribing"),
        ("transcribing", "analyzing"),
    }

    if (expected_status, new_status) not in allowed:
        raise ValueError(
            "Invalid processing status transition"
        )

    with closing(get_connection()) as conn:
        cursor = conn.execute(
            """
            UPDATE journals
            SET status = ?
            WHERE id = ?
              AND user_id = ?
              AND status = ?
            """,
            (
                new_status,
                journal_id,
                user_id,
                expected_status,
            ),
        )

        conn.commit()

    return cursor.rowcount == 1


def complete_processing(
    journal_id: str,
    transcript: str,
    analysis: dict,
    user_id: str = DEV_USER_ID,
) -> bool:
    """
    Save processing results and mark the journal
    completed, only if it is currently analyzing.
    """

    analysis_json = json.dumps(analysis)

    with closing(get_connection()) as conn:
        cursor = conn.execute(
            """
            UPDATE journals
            SET status = 'completed',
                transcript = ?,
                analysis_json = ?,
                error_message = NULL
            WHERE id = ?
              AND user_id = ?
              AND status = 'analyzing'
            """,
            (
                transcript,
                analysis_json,
                journal_id,
                user_id,
            ),
        )

        conn.commit()

    return cursor.rowcount == 1


def fail_processing(
    journal_id: str,
    error_message: str,
    user_id: str = DEV_USER_ID,
) -> bool:
    """
    Mark a journal failed if processing was active.

    Do not overwrite completed journals or recreate
    records that have already been deleted.
    """

    with closing(get_connection()) as conn:
        cursor = conn.execute(
            """
            UPDATE journals
            SET status = 'failed',
                error_message = ?
            WHERE id = ?
              AND user_id = ?
              AND status IN (
                  'queued',
                  'transcribing',
                  'analyzing'
              )
            """,
            (
                error_message,
                journal_id,
                user_id,
            ),
        )

        conn.commit()

    return cursor.rowcount == 1
