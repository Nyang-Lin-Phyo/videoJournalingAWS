# Reverie · Developer 1 frontend

React + TypeScript + Vite. All implementation lives in `Frontend/` (this folder).

## Run (PowerShell)

```powershell
cd Frontend          # from the repository root
npm ci
Copy-Item .env.example .env.local # once; do not overwrite existing settings
npm run dev
```

Open http://127.0.0.1:5173. Node 22.12+ (or supported newer release) is needed by Vite.

```powershell
npm run build
npm run lint
npm test
```

Unit tests explicitly pin browser mock mode, independent of `.env.local`, and never depend on a running API.

All automated frontend tests and shared setup are in [`tests/`](tests/README.md). Its README explains each file, targeted npm commands, watch mode, and the checks that still require a real browser/backend.

## Milestone and scope

F1 is implemented first, as requested by the execution brief: independent deterministic mock UI, typed repository API client, routes, upload/preview, history filters, status evolution/polling, transcript/analysis, video region, deletion, retry states, and tests. F2 is also integrated and verified against the repository’s existing FastAPI API with its mock processor, using the development proxy; see `VERIFICATION.md` for the actual observations. Optional F3 FFmpeg.wasm trimming is the next separate milestone after integration; no trim button pretends it already exists.

## API modes

`VITE_USE_MOCK_API=true` (also the safe default when unset) selects a browser-only mock. No server, AI keys, model download, or transcription is involved. The banner and synthetic transcripts label mock output. Examples deliberately include completed, processing, failed, and awaiting-upload states. Processing advances by elapsed time over ~7.5 seconds. Example entries have no recordings: their landscape covers are illustrations, not video thumbnails. Uploaded files play via browser object URLs in the current session.

**Mock history is in memory. Refresh restores fixtures and drops all new uploads/deletions.** Uploaded recordings are never written to localStorage/IndexedDB. Object URLs are revoked when a selected video changes, upload view unmounts, or an uploaded demo entry is deleted. Closing/reloading the page releases remaining session URLs. `createMockJournalApi([])` provides an empty state for tests without changing production code.

`VITE_USE_MOCK_API=false` uses only the HTTP API (no silent demo fallback). Default `VITE_API_BASE_URL=http://127.0.0.1:8000`. Never put secrets in `VITE_*`. Restart Vite after env changes.

The current backend has no CORS middleware. Until Developer 2 adds it, use the **development-only** Vite proxy with `VITE_API_BASE_URL=/` and the same `VITE_USE_MOCK_API=false`. The proxy forwards `/api` to loopback port 8000, including video/Range requests. This is not a production proxy. For a production frontend, Developer 2 must allow its origin or provide a same-origin reverse proxy. No backend files were edited.

Frontend requests, against the **repository's current returns** (the user's explicit choice):

1. `POST /api/journals`, JSON `{}` → `201 {journal, upload_url}`.
2. Resolve `upload_url` against the configured API base. `PUT` the raw File with `Content-Type: video/mp4` → `204`; never parse its body or use FormData.
3. Only after successful PUT: `POST /api/journals/{id}/complete` → `202 JournalDetail`.
4. `GET /api/journals/{id}` every 2.5 s while queued/transcribing/analyzing; stop at terminal states, errors, navigation, unmount. Manual refresh aborts the previous loop. List polls every 3 s only while it contains processing entries.
5. `GET /api/journals` → `{journals: JournalDetail[]}`, preserve server ordering.
6. Resolve `video_url` against the API base and use native `<video controls>`; no full video fetch into React memory.
7. `DELETE /api/journals/{id}` → `204`. UI disallows queued/transcribing/analyzing deletion; irreversible deletion has a confirmation dialog.

The UI and types use `error_message`. There is no response-shape adapter for the task brief's alternate contract. There is no `/health` route in the repository, so no health request or invented endpoint is used. No client-provided user identity is sent.

## Validation and errors

Selection checks `.mp4`, `video/mp4` when MIME is present, nonempty file, and **30 MiB = 31,457,280 bytes** inclusive. The real server validates authoritative MP4 bytes. The mock also checks the `ftyp` header on upload. Preview handles codecs the browser cannot play. HTTP errors are parsed as JSON but safe status-based messages are rendered rather than raw internal errors. Timeouts: 20 s JSON requests, 120 s raw upload. Selecting a valid file, changing it, navigating away, retrying, and duplicate clicks are handled. On failed upload/completion the file is preserved; the incomplete journal is linked, and retry starts a new entry (never re-enqueues the same entry).

## Handoff to Developer 2 (no shared files changed)

The task brief and repository disagree. The frontend intentionally follows the repository, per user direction. Please reconcile shared team documentation rather than silently changing these shapes:

| Concern           | Repository, used here            | Task brief                                  |
| ----------------- | -------------------------------- | ------------------------------------------- |
| Create            | `{journal, upload_url}`          | `{id, status, upload:{method,url,headers}}` |
| History           | `{journals}` full detail objects | `{items}` summaries                         |
| Completion        | full journal detail              | `{id,status}`                               |
| Failure field     | `error_message`                  | `error`                                     |
| Health            | absent                           | `GET /health`                               |
| Repeat completion | `409`                            | idempotent `202`                            |
| Active deletion   | backend currently permits it     | backend should reject `409`                 |
| Local identity    | `dev-user`                       | `local-dev-user`                            |

Needed next: CORS for http://localhost:5173 and http://127.0.0.1:5173; server-side guard against active deletion; clarify repeated completion; connect the real processor via Developer 2's adapter. The backend currently hardcodes its mock processor; setting PROCESSOR_MODE alone does not switch it. Do not claim genuine AI output in a demo. The browser-only mock and the backend's mock are different modes.

## Manual integration checks (fictional/synthetic content only)

Run the backend following Developer 2's setup, bound to 127.0.0.1:8000. Switch the frontend to API mode through the proxy above. Upload a playable small synthetic MP4. Check create → raw PUT → complete in Network; wait for results, reload, reopen, play/seek, then delete. Choose a .txt, zero-byte MP4, and >30 MiB MP4 and confirm immediate validation. Upload a renamed text file to see server 415 without false completion. Stop the API and confirm retryable errors. Do not use personal recordings for real AI integration without understanding the processor configuration.

Browser automation and actual checks performed during development are recorded in `VERIFICATION.md`. Real Whisper/Gemini, cloud hosting, auth, trends, search, capture, and FFmpeg.wasm were not added in F1.

## UI and file map

Routes: `/` (history), `/upload` (choose/preview/submit), `/journals/:id` (playback/results/status). `api/` owns wire types, validation, errors, HTTP requests, and mode selection; `mocks/` owns deterministic examples; `hooks/useJournal.ts` owns abortable polling; `components/` owns reusable presentation. Responsive styles support phone and desktop, visible keyboard focus, a skip link, labeled file input, reduced motion, and a focus-managed deletion dialog. Google Fonts supplies DM Sans/Newsreader when available; system/Georgia fallbacks work offline. No image/video tracking services or external sample recordings are loaded.
