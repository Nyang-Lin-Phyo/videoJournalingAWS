
import asyncio
import os
import threading
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4
from weakref import WeakValueDictionary

from fastapi import HTTPException, Request

from .database import PROJECT_ROOT


MAX_VIDEO_BYTES = 30 * 1024 * 1024  # 30 MiB

# Locks are shared by requests within this Python process.
# Weak references allow unused locks to be garbage-collected.
_registry_lock = threading.Lock()
_upload_locks = WeakValueDictionary()


@contextmanager
def journal_upload_lock(journal_id: str):
    """Reject overlapping uploads to the same journal."""

    with _registry_lock:
        lock = _upload_locks.get(journal_id)

        if lock is None:
            lock = threading.Lock()
            _upload_locks[journal_id] = lock

    # Do not block the event loop waiting for another upload.
    if not lock.acquire(blocking=False):
        raise HTTPException(
            status_code=409,
            detail="Upload already in progress",
        )

    try:
        yield
    finally:
        lock.release()


def get_upload_directory() -> Path:
    """Return the configured local upload directory."""

    custom = os.getenv("VIDEO_JOURNAL_UPLOAD_DIR")

    directory = (
        Path(custom).expanduser().resolve()
        if custom
        else PROJECT_ROOT / "data" / "uploads"
    )

    directory.mkdir(parents=True, exist_ok=True)
    return directory


async def save_video(
    journal_id: str,
    request: Request,
) -> Path:
    """
    Stream an MP4 to disk without loading it into memory.

    Reject oversized or invalid uploads and never overwrite
    an existing journal video.
    """

    directory = get_upload_directory()

    final_path = directory / f"{journal_id}.mp4"
    temporary_path = directory / f".{uuid4().hex}.tmp"

    total_bytes = 0

    try:
        # Stream into a uniquely named temporary file.
        with temporary_path.open("wb") as file:
            async for chunk in request.stream():
                if not chunk:
                    continue

                total_bytes += len(chunk)

                if total_bytes > MAX_VIDEO_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail="Video exceeds 30 MiB limit",
                    )

                await asyncio.to_thread(file.write, chunk)

        # Basic MP4 container-header validation.
        with temporary_path.open("rb") as file:
            header = file.read(8)

        if len(header) < 8 or header[4:8] != b"ftyp":
            raise HTTPException(
                status_code=415,
                detail="Invalid MP4 file",
            )

        try:
            # Both paths are in the same filesystem.
            #
            # Unlike os.replace(), os.link() refuses to
            # overwrite an existing destination.
            #
            # Creating the hard link is atomic.
            os.link(temporary_path, final_path)

        except FileExistsError as exc:
            raise HTTPException(
                status_code=409,
                detail="Journal video already exists",
            ) from exc

        return final_path

    finally:
        # This runs after success or failure.
        # Removing the temporary hard link does not
        # remove the successfully published final file.
        temporary_path.unlink(missing_ok=True)
