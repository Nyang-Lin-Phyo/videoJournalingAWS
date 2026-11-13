# Video Journaling Platform

A cloud-oriented video journaling application that allows users
to upload personal video entries, automatically transcribe speech,
analyze emotional sentiment, and review previous journals.

This project is developed by a team of three developers.

We are building and testing the entire application locally
before deploying it to AWS.

## Features

### MVP
- Upload MP4 video journals.
- Store uploaded videos.
- Transcribe speech into text.
- Analyze sentiment, emotions, and themes using AI.
- Generate a short emotional summary.
- View previous journal entries.
- Watch uploaded videos alongside their analyses.
- Provide private, authenticated journal access in production.

### Stretch Goals
- Mood tracking and long-term emotional trends.
- Calendar-based journal history.
- Context-aware journal search.
- Multilingual transcription.
- ASL support.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Frontend | React + TypeScript + Vite |
| Browser video processing | FFmpeg.wasm |
| Backend | Python + FastAPI |
| Local database | SQLite |
| Local video storage | Filesystem |
| Speech transcription | Faster-Whisper |
| Sentiment and theme analysis | Gemini API |

AWS deployment will be implemented after the local MVP works.

## Project Structure

videoJournalingAWS/
├── Frontend/               # Developer 1 — React + TypeScript + Vite app
├── Backend/
│   ├── services/
│   │   ├── api/            # Developer 2 — FastAPI application
│   │   └── processor/      # Developer 3 — AI processing module
│   ├── packages/
│   │   └── contracts/      # Shared API/data contracts
│   ├── tests/              # Integration tests
│   └── requirements-dev.txt
├── data/                   # Local runtime data (Git-ignored)
├── swagger.yaml            # OpenAPI/Swagger spec for the REST endpoints
├── LOCAL_INTEGRATION.md
└── README.md

## Developer Responsibilities

### Developer 1 — Frontend + WebAssembly

Owns `Frontend/`.

Responsibilities:
- React user interface.
- Video selection, preview, and upload.
- FFmpeg.wasm video trimming.
- Journal history and detail pages.
- Displaying transcripts and analysis results.
- Communicating with the backend through REST APIs.

### Developer 2 — Backend + Local Storage

Owns `Backend/services/api/`.

Responsibilities:
- FastAPI application and REST endpoints.
- SQLite database and journal metadata.
- Local MP4 file storage.
- Journal creation, retrieval, and deletion.
- Asynchronous processing orchestration.
- Integration with the AI processing module.

### Developer 3 — AI Processing

Owns `Backend/services/processor/`.

Responsibilities:
- Faster-Whisper speech transcription.
- Gemini sentiment and emotional analysis.
- Extracting emotions, themes, and summaries.
- Returning structured JSON results.
- Handling processing failures.

## Shared Contracts

All developers must follow the contracts in
`Backend/packages/contracts/`.

- `openapi.yaml`: Frontend/backend REST API specification.
- `journal.schema.json`: Journal data structure and statuses.
- `analysis.schema.json`: AI analysis result structure.

A standalone copy of the endpoint specification is also
available at the repository root as `swagger.yaml`.

Do not change shared contracts without coordinating with
the developers whose components depend on them.

### Journal Processing Lifecycle

awaiting_upload
    |
    v
queued
    |
    v
transcribing
    |
    v
analyzing
    |
    v
completed

Processing errors transition to `failed`.

### Local API

Base URL: `http://localhost:8000`

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | /api/journals | Create journal |
| PUT | /api/journals/{journal_id}/video | Upload video |
| POST | /api/journals/{journal_id}/complete | Queue processing |
| GET | /api/journals | List journals |
| GET | /api/journals/{journal_id} | Get journal |
| GET | /api/journals/{journal_id}/video | Play video |
| DELETE | /api/journals/{journal_id} | Delete journal |

See `swagger.yaml` (repository root) or
`Backend/packages/contracts/openapi.yaml` for details.

## Local Development

The application will consist of:

1. React development server on localhost:5173.
2. FastAPI backend on localhost:8000.
3. SQLite and local filesystem storage.
4. A Python AI processing module.

The frontend and backend will initially use mock responses
so developers can work independently.

Setup commands will be added as each component is implemented.

## Git Workflow

The original repository is the integration repository.

1. The initial foundation is committed to main.
2. Developers 1 and 3 fork the repository.
3. Each developer implements their assigned component.
4. Developers submit pull requests to the original repository.
5. Changes are reviewed and tested before merging.

Developer 2 works in the original repository using feature
branches after the initial foundation is complete.

Avoid unrelated changes to other developers' directories.

## Security and Privacy

Video journals may contain sensitive personal information.

- Never commit real journal videos or transcripts.
- Never commit API keys or .env secrets.
- Local videos and databases belong in the ignored `Backend/data/` folder.
- Use synthetic test data during development.
- Local development authentication will initially be mocked.
- Production will require authenticated, per-user access.
- Obtain user consent before sending journal transcripts to
  external AI services.

AI emotional classifications are interpretations, not
medical or psychological diagnoses.

## Development Status

Current phase: B0 — Repository Foundation

- [x] Initialize Git repository.
- [x] Create directory structure.
- [x] Create .gitignore.
- [x] Define shared JSON schemas.
- [x] Define OpenAPI specification.
- [ ] Review and finalize foundation.
- [ ] Push foundation to GitHub.
- [ ] Begin parallel local development.

## Future AWS Deployment

After local integration, we plan to use:

- Amazon S3
- AWS Lambda
- API Gateway
- Amazon DynamoDB
- Amazon Transcribe
- Amazon Cognito
- Amazon CloudWatch

The AWS implementation will be planned separately.