from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .database import initialize_database
from .routes.journals import router as journals_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    initialize_database()
    yield


app = FastAPI(
    title="Video Journaling API",
    description="Local backend for the AI video journaling platform.",
    version="0.1.0",
    lifespan=lifespan,
)

# Local development origins for Developer 1's Vite dev server.
# Loopback only: the API binds to 127.0.0.1 and must not be
# reachable from other hosts.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)

app.include_router(journals_router)
