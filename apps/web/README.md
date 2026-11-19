# Reverie · Developer 1 frontend

React + TypeScript + Vite. All implementation lives in `apps/web/`.

## Run (PowerShell)

```powershell
cd "D:\NYU\Cloud Computing\Project\videoJournaling\apps\web"
npm ci
Copy-Item .env.example .env.local # once; do not overwrite existing settings
npm run dev
```

Open http://127.0.0.1:5173. Node 22.12+ (or supported newer release) is needed by Vite.

## Login home page (issue #13)

To preview the cloud login page locally in PowerShell:

```powershell
$env:VITE_CLOUD_INGEST_ONLY='true'
npm run dev
```

Without Cognito configuration, the welcome page renders with a disabled sign-in button and a configuration notice. To use Google sign-in, supply the existing deployment's `VITE_COGNITO_REGION`, `VITE_COGNITO_USER_POOL_ID`, `VITE_COGNITO_CLIENT_ID`, and `VITE_COGNITO_DOMAIN` in `.env.local`, and restart Vite. Use `http://localhost:5173/` for login testing: the existing Cognito setup scripts register that callback and logout URL. Using `http://127.0.0.1:5173/` requires adding that exact URL to the Cognito app client as well. The domain value includes `https://`. Do not put client secrets in Vite environment variables.

`src/cloud/LoginPage.tsx` and `login.css` contain the responsive welcome screen. `CloudAuthApp.tsx` connects it to the existing Google/Cognito flow and handles loading, retryable errors, and duplicate-click prevention. Run `npx vitest run tests/login.test.tsx` for the mocked authentication UI checks. A live Google/Cognito round trip still requires the deployment configuration.

```powershell
npm run build
npm run lint
npm test
```

Unit tests explicitly pin browser mock mode, independent of `.env.local`, and never depend on a running API.

All automated frontend tests and shared setup are in [`tests/`](tests/README.md). Its README explains each file, targeted npm commands, watch mode, and the checks that still require a real browser/backend.

## Milestone and scope

### Transcript reader (issue #2)

Journal detail, cloud history, and cloud upload results show a compact transcript preview with an explicit **Read full transcript** button. The reader opens at 75% of the desktop viewport (nearly full screen on phones), preserves paragraph breaks, and scrolls independently. Close it with its button, Escape, or the backdrop. Keyboard focus stays in the reader and returns to its trigger on close; background interaction and scrolling are disabled while it is open.

For a frontend-only preview of the actual cloud interface, set `$env:VITE_CLOUD_PREVIEW='true'` in PowerShell and run `npm run dev -- --port 5174`. Open `http://127.0.0.1:5174/`, choose **Journal history**, open **A walk after class**, then choose **Read full transcript**. The upload form, sidebar, history, and transcript reader are the same components used by the cloud application. Only the session and data services are replaced with local fictional data through `CloudEnvironmentContext`. Example journals have no recordings. Selected videos remain in memory for local playback; saving generates explicitly fictional results without sending the video to AWS or an AI provider. Refresh resets preview entries. This mode is development-only and is excluded from production builds; omit `VITE_CLOUD_PREVIEW` for real Cognito/API integration.

The cloud sidebar's **Settings** panel provides sign-out and account deletion. In the local preview, deletion clears only fictional in-memory entries and never calls AWS; sign-out explains that preview mode has no authenticated session. In the authenticated Cognito app, deletion requires typing `DELETE`, verifies the account email against the signed-in Cognito subject, waits for issued upload links and active processing to finish, removes all owned journal metadata and S3 object versions, then deletes the Cognito user. The minimal account-deletion tombstone remains to reject still-valid access tokens. Deploy the backend route and IAM changes through `infra/deploy-history-v5.sh` only after reviewing the script and setting both `CONFIRM_HISTORY_V5=YES` and `CONFIRM_ACCOUNT_DELETE=YES`. Do not deploy from local preview credentials.

Run `python infra/test-account-deletion.py` for offline account-removal checks; it uses mocked DynamoDB, S3, and Cognito services.

## Streaks and rewards

The sidebar streak card shows the current streak, whether today's upload counted, and the points balance. Opening it reveals the Rewards panel. A video earns one point on its successful S3 storage event, at most once per local calendar day. The IANA timezone from the first counted upload anchors the account's day boundary. Existing journal history is not backfilled. A streak freeze costs 7 points and automatically protects one missed day; frozen days preserve the streak but do not earn points. Account deletion removes streak and rewards data.

After the authenticated v5 history/account-deletion backend is deployed, deploy streak routes and worker changes from PowerShell in the AWS-configured repository environment:

```powershell
$env:CONFIRM_STREAK_V1='YES'
bash infra/deploy-streak-v1.sh
```

Review the script and AWS account before running it; it sets the feature start time so pending older S3 events do not grant launch-period points. The local cloud preview simulates streak/reward state in memory and makes no AWS requests.

Run `python infra/test-streaks.py` for offline timezone, duplicate-event, freeze-purchase, and S3-event ordering checks.

## Interests, onboarding, and personal recommendations (issue #7)

On first sign-in, a short onboarding flow asks four questions: what the user enjoys, their music (with an optional favourite artist), what usually helps on heavier days, and their comfort food or drink. It shows one question per screen with chip selectors and a progress bar, and every screen can be skipped. Finishing or skipping sets `onboardingCompleted` on the user's row in the new DynamoDB **USERS** table (key `userId` = Cognito `sub`), so it appears once per account on any device. The sidebar's **Your interests** tab edits the same choices later without resetting the flag. If the profile API is unavailable, onboarding is skipped and journaling is never blocked. The top-right "Signed in as / Sign out" bar was removed; sign out is in **Settings**.

**Favourites.** A favourite is an activity, music (a genre, artist or song), or food or drink. Favourites come from onboarding and from transcripts. The worker adds profile context to the **same** Gemini call that writes the reflection, and Gemini also returns `profile_signals`. Each signal has a kind, an item, a mood effect, whether it actually happened, a confidence score, an exact quote, and the situations the person ties it to (for example lemonade → `sunny`). Signals are checked before they count:
- The quote must appear word for word in the transcript; if it doesn't, the signal's weight is halved.
- Anything under 0.4 confidence after that check is ignored.
- Intentions ("I should go to the gym") count only as a weak mention.

Signals then go into admin-only `learned` attributes, which fade with a 60-day half-life. Reflection themes build `learnedTopics`. None of this is stored on the journal or returned to the user.

**Ranking is behaviour-first** (`infra/lambda/user_profile.py`):
- Each observed mood lift scores double, so one observed lift outranks any onboarding choice.
- Onboarding choices start lower: "what helps" and comfort foods 1.0, the favourite artist 0.8, interests 0.5, music genres 0.4.
- Anything that repeatedly coincides with lower mood is dropped, even if it was chosen during onboarding.

**Recommendations.** Gemini also returns the situations it sees in today's transcript (`today_context`) and at most one candidate recommendation. There are three triggers:
- `comfort`: the entry is sad, so suggest one favourite activity, song or comfort food. Shown as "A gentle thought".
- `context_match`: today's situation matches a favourite's learned situations, whatever the mood ("sunny" + lemonade). Shown as "A little idea for today".
- `been_a_while`: a well-liked observed favourite hasn't come up for 14+ days. Offered only when the last recommendation was at least 2 days ago, and then on about half of entries. The random choice is seeded by the upload ID, so retries agree. Shown as "Something you might be missing".

`choose_recommendation` checks every candidate on the server and drops it if any rule fails:
- The item must be one of the user's actual favourites.
- For `context_match`, today's situation must overlap that favourite's learned situations.
- For `been_a_while`, the item must have been offered as a nudge.
- Non-comfort items suggested in the last 3 days are skipped.

A dropped recommendation leaves the reflection unchanged. Shown recommendations are logged in `recommendationLog`. The worker and the API each update only their own attributes, so neither overwrites the other. Account deletion removes the USERS row.

Deploy after streak v1, with the same review rules: `CONFIRM_PROFILE_V1=YES bash infra/deploy-profile-v1.sh`. Run `python infra/test-profile.py` for offline checks. In the local cloud preview, onboarding appears on every refresh. The negative fictional entry *One step at a time* shows a `[DEMO]` comfort recommendation, and *A walk after class* shows a `[DEMO]` "been a while" nudge, both built from your picks.

Cloud mode needs the updated `infra/lambda/auth_results.py` deployed to the existing results Lambda, alongside the frontend. The existing JWT-protected `GET /uploads/{upload_id}/result` adds nullable `transcript` and `transcript_error` fields. It reads the saved S3 text only after checking journal ownership, validates the exact object key, and limits reads to 256 KiB of UTF-8. No transcription/model calls, new routes, or new permissions are introduced; the v5 results role already permits reading transcript objects. Missing transcripts show an unavailable state. Read failures preserve the reflection and display a safe error. A frontend deployed against the older API also shows the unavailable state.

Verify locally with `npm test`, `npm run build`, `npm run lint`, and (from the repo root, with boto3 installed) `python infra/test-history-v5.py`. Before using real journals, verify the deployed endpoint with two separate test accounts: each owner can read their saved transcript, and the other account receives 404. Nothing in this change deploys AWS resources automatically.

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
