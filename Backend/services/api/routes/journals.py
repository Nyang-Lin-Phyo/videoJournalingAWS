
import logging
from uuid import uuid4

from fastapi import (
    APIRouter,
    BackgroundTasks,
    HTTPException,
    Request,
    Response,
    status,
)
from fastapi.responses import FileResponse

from ..processing import process_queued_journal
from ..repository import (
    attach_video,
    create_journal,
    delete_journal,
    get_journal,
    get_video_path,
    list_journals,
    queue_journal,
)
from ..storage import (
    get_upload_directory,
    journal_upload_lock,
    save_video,
)


logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/journals",
    tags=["journals"],
)


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    operation_id="createJournal",
)
def create_journal_endpoint():
    journal = create_journal()

    return {
        "journal": journal,
        "upload_url": f"/api/journals/{journal['id']}/video",
    }


@router.get(
    "/{journal_id}",
    operation_id="getJournal",
)
def get_journal_endpoint(journal_id: str):
    journal = get_journal(journal_id)

    if journal is None:
        raise HTTPException(
            status_code=404,
            detail="Journal not found",
        )

    return journal


@router.get(
    "",
    operation_id="listJournals",
)
def list_journals_endpoint():
    return {
        "journals": list_journals()
    }


@router.put(
    "/{journal_id}/video",
    status_code=204,
    operation_id="uploadJournalVideo",
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "video/mp4": {
                    "schema": {
                        "type": "string",
                        "format": "binary",
                    }
                }
            },
        }
    },
)
async def upload_journal_video(
    journal_id: str,
    request: Request,
):
    with journal_upload_lock(journal_id):

        journal = get_journal(journal_id)

        if journal is None:
            raise HTTPException(
                status_code=404,
                detail="Journal not found",
            )

        if (
            journal["status"] != "awaiting_upload"
            or journal["video_url"] is not None
        ):
            raise HTTPException(
                status_code=409,
                detail="Journal cannot accept another upload",
            )

        content_type = (
            request.headers
            .get("content-type", "")
            .split(";")[0]
            .strip()
            .lower()
        )

        if content_type != "video/mp4":
            raise HTTPException(
                status_code=415,
                detail="Expected video/mp4",
            )

        path = await save_video(journal_id, request)

        attached = False

        try:
            if not attach_video(journal_id, path):
                raise HTTPException(
                    status_code=409,
                    detail="Journal state changed during upload",
                )

            attached = True

        finally:
            if not attached:
                path.unlink(missing_ok=True)

    return Response(status_code=204)


@router.get(
    "/{journal_id}/video",
    operation_id="getJournalVideo",
    response_class=FileResponse,
)
def get_journal_video(journal_id: str):
    journal = get_journal(journal_id)

    if journal is None:
        raise HTTPException(
            status_code=404,
            detail="Journal not found",
        )

    path = get_video_path(journal_id)

    if path is None or not path.is_file():
        raise HTTPException(
            status_code=409,
            detail="Journal video is not available",
        )

    return FileResponse(
        path=path,
        media_type="video/mp4",
    )


# ==========================================
# MOCK PROCESSING ENDPOINT
# ==========================================

@router.post(
    "/{journal_id}/complete",
    status_code=202,
    operation_id="completeJournalUpload",
)
def complete_journal_endpoint(
    journal_id: str,
    background_tasks: BackgroundTasks,
):
    """
    Queue a journal for mock processing.

    Returns the queued journal immediately.
    Processing runs after the response is sent.
    """

    with journal_upload_lock(journal_id):

        journal = get_journal(journal_id)

        if journal is None:
            raise HTTPException(
                status_code=404,
                detail="Journal not found",
            )

        # Upload must be complete before processing.
        if (
            journal["status"] != "awaiting_upload"
            or journal["video_url"] is None
        ):
            raise HTTPException(
                status_code=409,
                detail="Journal is not ready for processing",
            )

        # SQLite atomically enforces the same conditions.
        queued_journal = queue_journal(journal_id)

        if queued_journal is None:
            raise HTTPException(
                status_code=409,
                detail="Journal could not be queued",
            )

        background_tasks.add_task(
            process_queued_journal,
            journal_id,
        )

    return queued_journal


# ==========================================
# JOURNAL DELETION
# ==========================================

@router.delete(
    "/{journal_id}",
    status_code=204,
    operation_id="deleteJournal",
)
def delete_journal_endpoint(journal_id: str):
    """
    Delete journal metadata and its local video.

    Temporarily rename the file before deleting the
    database record so that it can be restored if
    the database operation fails.
    """

    with journal_upload_lock(journal_id):

        journal = get_journal(journal_id)

        if journal is None:
            raise HTTPException(
                status_code=404,
                detail="Journal not found",
            )

        video_path = get_video_path(journal_id)
        staged_path = None

        if video_path is not None:
            upload_directory = get_upload_directory()

            expected_path = (
                upload_directory / f"{journal_id}.mp4"
            )

            if video_path.resolve() != expected_path.resolve():
                raise HTTPException(
                    status_code=500,
                    detail="Invalid stored video path",
                )

            if video_path.is_file():
                staged_path = (
                    upload_directory
                    / f".deleting-{uuid4().hex}.tmp"
                )

                try:
                    video_path.rename(staged_path)
                except OSError as exc:
                    logger.exception(
                        "Failed to stage video deletion"
                    )
                    raise HTTPException(
                        status_code=500,
                        detail="Could not prepare video for deletion",
                    ) from exc

        try:
            deleted = delete_journal(journal_id)

            if not deleted:
                raise HTTPException(
                    status_code=404,
                    detail="Journal not found",
                )

        except Exception:
            if staged_path is not None:
                try:
                    staged_path.rename(video_path)
                except OSError:
                    logger.exception(
                        "Failed to restore video after "
                        "database deletion error"
                    )

            raise

        if staged_path is not None:
            try:
                staged_path.unlink()
            except OSError as exc:
                logger.exception(
                    "Journal deleted from database, but "
                    "video cleanup failed: %s",
                    staged_path,
                )
                raise HTTPException(
                    status_code=500,
                    detail=(
                        "Journal metadata deleted, "
                        "but video cleanup failed"
                    ),
                ) from exc

    return Response(status_code=204)
