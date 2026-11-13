
import os
import sqlite3
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]

DEFAULT_DB_PATH = PROJECT_ROOT / "data" / "journals.db"

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS journals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN (
            'awaiting_upload',
            'queued',
            'transcribing',
            'analyzing',
            'completed',
            'failed'
        )
    ),
    video_path TEXT,
    transcript TEXT,
    analysis_json TEXT,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_journals_user_created
ON journals (user_id, created_at DESC);
"""


def get_db_path() -> Path:
    """Return the configured SQLite database location."""
    custom_path = os.getenv("VIDEO_JOURNAL_DB_PATH")

    if custom_path:
        return Path(custom_path).expanduser().resolve()

    return DEFAULT_DB_PATH


def get_connection(db_path: Path | None = None) -> sqlite3.Connection:
    """Open a SQLite connection with dictionary-like row access."""
    path = db_path if db_path is not None else get_db_path()

    path.parent.mkdir(parents=True, exist_ok=True)

    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row

    return connection


def initialize_database(db_path: Path | None = None) -> None:
    """Create database tables and indexes if they do not exist."""
    connection = get_connection(db_path)

    try:
        connection.executescript(SCHEMA_SQL)
        connection.commit()
    finally:
        connection.close()
