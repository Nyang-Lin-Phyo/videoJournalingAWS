# Context — videoJournalingAWS

_Last updated: 2026-11-13_

This file records the state of the repository: what has already been done,
what has been verified, and what remains. Update it whenever a milestone
lands.

---

## 1. What this repository is

A private video journaling platform: users upload `.mp4` entries, the app
transcribes speech, derives sentiment / emotions / themes plus a short
summary from the transcript, and lets users revisit the video with its
results.

The working local MVP lives in `../videoJournalingLocalHost` (team
monorepo, `apps/web` + `services/` + `packages/contracts`). This repository
(`videoJournalingAWS`) is the copy that will be reworked for AWS deployment.

| Concern | Local MVP choice | AWS target |
| --- | --- | --- |
| UI | React + TypeScript + Vite, port 5173 | S3 + CloudFront (static hosting) |
| HTTP API | FastAPI + SQLite, port 8000 | API Gateway + Lambda (FastAPI via Mangum) or ECS Fargate |
| Video storage | Local filesystem | Amazon S3 (presigned upload/download) |
| Journal metadata | SQLite | Amazon DynamoDB |
| Background processing | `BackgroundTasks` in the API process | SQS + Lambda / Step Functions |
| Transcription | Faster-Whisper (CPU) | Amazon Transcribe |
| Sentiment / themes / summary | Gemini API (structured JSON) | Amazon Comprehend or Amazon Bedrock |
| Auth | Mocked locally | Amazon Cognito (per-user journals) |
| Logs / metrics | stdout | CloudWatch Logs / Metrics + alarms |
| Contracts | `Backend/packages/contracts/` + `swagger.yaml` | Same, kept in sync with the deployed API |

---

## 2. Repository layout (current)

```text
videoJournalingAWS/
├── Frontend/                    # Developer 1 — React + TS + Vite app
│   ├── src/  tests/  public/  package.json  vite.config.ts  README.md
├── Backend/
│   ├── services/api/            # Developer 2 — FastAPI app, routes, storage, SQLite
│   ├── services/processor/      # Developer 3 — transcription + analysis pipeline
│   ├── packages/contracts/      # Shared, change-controlled contracts
│   │   ├── openapi.yaml
│   │   ├── journal.schema.json
│   │   └── analysis.schema.json
│   ├── tests/                   # API / database / contract / adapter tests
│   └── requirements-dev.txt
├── swagger.yaml                 # Standalone OpenAPI 3.0.3 spec for all endpoints
├── LOCAL_INTEGRATION.md         # How to run the local MVP (Windows CMD)
├── README.md
└── .gitignore                   # ignores .env, data/, *.mp4, __pycache__, node_modules, ...
```

Ownership rules (from the team briefs) still apply: Developer 1 owns
`Frontend/`, Developer 2 owns `Backend/services/api/` + root docs +
`Backend/packages/contracts/**` (change-controlled — never silently alter a
field or endpoint), Developer 3 owns `Backend/services/processor/`.

---

## 3. What has been done

### 3.1 Code migration (2026-11-13)

- [x] Copied the entire working local MVP from `../videoJournalingLocalHost`
      into this repository (114 files: FastAPI service, processor pipeline,
      React frontend, contracts, tests, docs, `.gitignore`). Verified
      byte-identical with `diff -rq` (excluding `.git`).
- [x] Wrote `swagger.yaml` (OpenAPI 3.0.3) documenting all seven endpoints:

  | Method | Path | operationId |
  | --- | --- | --- |
  | POST | `/api/journals` | `createJournal` |
  | GET | `/api/journals` | `listJournals` |
  | GET | `/api/journals/{journal_id}` | `getJournal` |
  | DELETE | `/api/journals/{journal_id}` | `deleteJournal` |
  | PUT | `/api/journals/{journal_id}/video` | `uploadJournalVideo` |
  | GET | `/api/journals/{journal_id}/video` | `getJournalVideo` |
  | POST | `/api/journals/{journal_id}/complete` | `completeJournalUpload` |

  Includes `Journal`, `JournalAnalysis`, `Error` schemas, status codes
  (201/202/204, 404/409/413/415/500), and `video/mp4` binary bodies. YAML
  parses cleanly and every `$ref` resolves.

- [x] Restructured the copy into `Backend/` + `Frontend/` (the layout the
      team wants for this repo) instead of the original `apps/web` +
      `services/` monorepo layout.
- [x] Updated every path reference in the docs:
      root `README.md`, `LOCAL_INTEGRATION.md`, `Frontend/README.md`,
      `Frontend/tests/README.md`, `Backend/services/processor/README.md`.
      (`Frontend/VERIFICATION.md` left untouched as a historical record.)

### 3.2 Verification (2026-11-13)

- [x] `import services.api.main` and processor config resolve correctly
      from `Backend/` (data dir → `Backend/data/`, `.env` → `Backend/.env`).
- [x] Backend test run from `Backend/`: **45 passed, 1 failed** —
      `tests/test_api.py::TestJournalAPI::test_video_range_request`. The
      same test fails in the original LocalHost repo, so it is a
      pre-existing environment issue, not a migration regression.
- [x] `tests/test_contracts.py` fails to collect (`Draft202012Validator`
      missing) because the system `jsonschema` is older than the pinned
      `4.26.0` — also pre-existing; installing `Backend/requirements-dev.txt`
      in a venv fixes it.
- [x] Removed test artifacts created during verification
      (`__pycache__`, `.pytest_cache`, `Backend/data`).

---

## 4. What is to be done

### 4.1 Immediate (repository hygiene)

- [ ] **Commit and push.** Nothing from the migration is committed yet
      (`git status`: modified `.gitignore`/`README.md`, untracked
      `Backend/`, `Frontend/`, `LOCAL_INTEGRATION.md`, `swagger.yaml`).
      Remote: `https://github.com/Nyang-Lin-Phyo/videoJournalingAWS.git`,
      branch `main`.
- [ ] **Set up the Python environment** on a clean machine:
      `python -m venv .venv`, then install
      `Backend/services/api/requirements.txt`,
      `Backend/services/processor/requirements.txt`, and
      `Backend/requirements-dev.txt` — then confirm
      `python -m pytest tests` from `Backend/` is fully green.
- [ ] **Run the frontend checks on a machine with Node 22.12+**
      (not available in this WSL environment):
      `cd Frontend && npm ci && npm run lint && npm test && npm run build`.
- [ ] **Investigate `test_video_range_request`** — decide whether it is a
      real Range-request regression on newer Starlette or a stale test.
- [ ] **Refresh the root `README.md`** — its "Development Status" section
      still says "B0 — Repository Foundation" although the local MVP is
      implemented; add run instructions pointing at
      `LOCAL_INTEGRATION.md` and `swagger.yaml`.
- [ ] Decide whether `Backend/packages/contracts/openapi.yaml` and the root
      `swagger.yaml` should be generated from FastAPI's `/openapi.json`
      to avoid the two specs drifting.

### 4.2 AWS migration (the main remaining work)

Work in this order; each step should keep the local MVP runnable.

1. **Video storage → S3**
   - Replace `Backend/services/api/storage.py` (filesystem writes,
     `journal_upload_lock`, path-staging delete logic) with S3 uploads.
   - Prefer presigned URLs issued by the API so the browser uploads
     directly to S3; enforce the 30 MiB cap with a bucket policy /
     presigned POST condition instead of `MAX_VIDEO_BYTES`.
   - Delete flow: delete the object and the DB row atomically (S3 +
     DynamoDB transaction or idempotent retries).
2. **Metadata → DynamoDB**
   - Replace `Backend/services/api/database.py` + `repository.py`
     (SQLite, `queue_journal` compare-and-swap) with DynamoDB single-table
     design (e.g. `PK=JOURNAL#<id>`, `SK=META`, plus a list access pattern
     via GSI on `created_at`). Keep the same JSON field names so
     `Backend/packages/contracts/journal.schema.json` does not change.
3. **Compute → API Gateway + Lambda**
   - Wrap the FastAPI app with Mangum (`handler = Mangum(app)`) and keep
     the existing routers unchanged where possible.
   - Watch the differences: request body size limits, streaming uploads,
     `BackgroundTasks` (must be replaced — Lambda freezes after response),
     and CORS (currently hard-coded to `localhost:5173` in
     `Backend/services/api/main.py`).
   - Alternative if payloads/streaming get awkward: ECS Fargate behind an
     ALB instead of Lambda.
4. **Async processing → SQS + Lambda (or Step Functions)**
   - Replace `BackgroundTasks` in `routes/journals.py` with an SQS enqueue;
     a worker Lambda sets `queued → transcribing → analyzing → completed/failed`
     using conditional DynamoDB writes (same state machine as today:
     `awaiting_upload → queued → transcribing → analyzing → completed | failed`).
5. **Transcription → Amazon Transcribe**, **analysis → Comprehend/Bedrock**
   - Keep the `Backend/services/processor/` interface
     (`process_video()` returning `{transcript, analysis}`) as the seam, so
     the API and contracts do not change. Delete Faster-Whisper/Gemini
     dependencies from the deployed bundle (or keep them for local mode).
6. **Auth → Cognito**
   - Local auth is mocked; production requires authenticated per-user
     access. Add a JWT authorizer (API Gateway) and a `user_id` attribute +
     `owner` check on every read/write. The swagger must then document a
     `SecuritySchemes` bearer requirement.
7. **Frontend hosting → S3 + CloudFront**
   - Build with `npm run build`, deploy `Frontend/dist`, set
     `VITE_API_BASE_URL` at build time, point CORS at the real origin.
8. **Observability & security**
   - CloudWatch log groups, metric filters/alarms (upload failures,
     processing failures, 5xx), S3 bucket encryption + lifecycle rules,
     least-privilege IAM, no secrets in the repo (`.env` is git-ignored),
     presigned URL expiry.
9. **Infrastructure as code + CI/CD**
   - Terraform / AWS CDK / SAM template for the above, plus a GitHub
     Actions workflow: lint + test Frontend, pytest Backend, deploy on
     merge to `main`.

### 4.3 Product-level (post-MVP, from README stretch goals)

Mood tracking / long-term trends, calendar history, context-aware search,
multilingual transcription, ASL support.

---

## 5. Gotchas worth remembering

- **Run backend commands from `Backend/`** — the code imports
  `services.api.*` / `services.processor.*` as top-level packages, so the
  working directory must be `Backend/` (do not switch to
  `Backend.services.api.main:app`; the processor adapter's
  `from services.processor.pipeline import ...` would break).
- Runtime files now live under `Backend/` (`Backend/data/journals.db`,
  `Backend/.env`); both are git-ignored.
- `Backend/services/processor/config.py` reads `Backend/.env`
  (`_REPO_ROOT = parents[2]`), `override=False` — shell exports win.
- Never commit real journal videos, transcripts, or API keys; tests build
  synthetic MP4s at runtime because `*.mp4` is git-ignored.
- AI emotional classifications are interpretations, not medical or
  psychological diagnoses; only transcript text leaves the machine (never
  the video) — preserve that property in any AWS analysis service.
