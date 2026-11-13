# Frontend verification · October 27, 2026

Milestone: F1 complete; F2 verified against the repository API with its existing backend mock processor. Optional F3 not implemented in this pass.

Files changed:

- `apps/web/` only: Vite/TypeScript/package/test config and lockfile, environment example, README, this report, HTML/favicon, responsive styles, app shell/router, typed API/validation/errors, mock fixtures/client, polling hook, three pages, reusable UI components, and four test files.
- Replaced the empty `.gitkeep`. Removed unused Vite template assets.
- Branch: `feat/frontend-journal`. No commit, push, PR, shared-contract edit, backend edit, or cloud deployment.

Commands run + result:

- `npm create vite@latest apps/web -- --template react-ts --no-interactive`: first attempt canceled because the placeholder directory was nonempty; after removing its empty `.gitkeep`, scaffold succeeded.
- `npm install`, `npm install react-router-dom`, test dependency installation, package-lock update: succeeded. Unused user-event dependency removed. Final npm audit during uninstall reported 0 vulnerabilities.
- `npm run dev`: served loopback port 5173; HTTP GET `/` returned 200.
- `npm test`: final run **30 passed, 4 files**. An intermediate run failed three UI tests because `.env.local` selected the real API; test config now pins mock mode and the final run passes with that same real-mode local config.
- `npm run build`: TypeScript compilation and production Vite build passed; final bundle ~291.67 kB JavaScript / 91.76 kB gzip; CSS ~24.87 kB / 6.58 kB gzip.
- `npm run lint`: passed with no warnings in the final run. Initial warnings about a component export and preview effect were corrected.
- Existing API: `python -m unittest discover -s tests -p test_api.py` in a temporary venv: **31 passed**. FastAPI emitted its existing Starlette/httpx deprecation warning; no failure.
- `git diff --check`: passed for tracked changes. Final scope inspection confirmed only `apps/web/**` changed.

Tests passed / failed / not run:

- Passed: exact repository create/list/detail/completion returns; create → raw File PUT → complete; only a 204 upload starts completion; no completion after a failed PUT; 404/409/413/415/422/500 handling; JSON/network errors; request cancellation/timeouts; API-origin URL resolution; malformed result rejection; deletion with an empty 204 body.
- Passed: deterministic demo lifecycle, MP4 header rejection, playback object URL cleanup; empty/history/filter/detail/error screens; completed transcript/sentiment/emotions/themes/summary; oversize prevention; retained-file retry and new journal creation; double-submit protection; delete confirmation/cancel/focus restoration and successful deletion; unknown detail route; text rendered without HTML execution; extension/MIME/empty/size boundary validation; terminal/unmount/refresh/navigation polling cleanup.
- Passed in the actual in-app browser: demo selection of a 3 s synthetic H.264/AAC MP4 (640×360, metadata readyState 4), preview, upload, queued state, disabled active deletion, completion, transcript/analysis, and native playback region. No warning/error console entries were observed during this clean demo flow.
- Passed against real FastAPI through Vite `/api` proxy: initial empty list; immediate rejection of 31,457,281-byte MP4; invalid renamed text file gets server 415 with readable UI error, preserved file, and incomplete-entry link; valid synthetic MP4 upload completes; results and history persist across page reload; native playback starts (paused=false, time advances, duration 3 s, width 640); direct video Range request returns `206`, `bytes 0-1023/5867`, 1024 bytes. Direct HTTP deletion returns 204 for the two isolated synthetic entries and leaves empty history.
- Responsive browser check at 390×844: mobile history and upload controls present; document scroll width 375 <= viewport 390 (no horizontal overflow); single-column journal/cards; mobile About button opens the processor/local-identity explanation. Temporary viewport override restored. One mobile full-page screenshot capture failed; DOM measurements and the mobile history screenshot succeeded. Desktop screenshots were saved in the chat output folder.
- Not run: real Faster-Whisper/Gemini processing (backend currently calls its own mock; no private content, model download, or API key used). F3 WASM tests not run because optional F3 is not implemented. No cloud deployment, login, production-browser matrix, or production reverse-proxy validation.

Mock mode or real API used:

- Both browser-only deterministic mock mode and real FastAPI HTTP mode with backend mock processing.
- Temporary backend environment and data were kept outside the repository in the chat's `work/` directory. No user recordings or existing databases were used.
- Final `.env.local` restored to the example defaults: browser mock mode=true, API base=http://127.0.0.1:8000. It is ignored by Git.

Contract deviations requested (not silently made):

- None requested by the frontend. Per the user, use the repository returns directly: `{journal,upload_url}`, `{journals}`, full-detail completion, `error_message`. No alternate-shape adapter exists.
- Backend/documentation differences needing Developer 2 handoff are listed in README: CORS, health absence, repeat completion 409 rather than 202, active deletion guard, identity name, and real processor adapter. The frontend guards active deletion without changing another developer's code.

Known issues and next small task:

- Optional F3: add lazy single-thread FFmpeg.wasm trim after this frontend/API milestone, preserve original upload, then browser-test a >60 s synthetic clip.
- Direct cross-origin API mode needs backend CORS. The documented development proxy works now.
- Browser-only mock state deliberately resets on refresh. Real API history persists.
- Backend integration currently provides synthetic analysis; Developer 2 must wire Developer 3's real pipeline.
- Source remains local on the feature branch, ready for review.

Source/config/docs were formatted with Prettier. Its initial attempt included .env.example, which has no supported parser; the environment file stayed unchanged. A subsequent formatting check excluding that file passed. After formatting, all 30 frontend tests, build, and lint passed again.

## Palette update · October 27, 2026

Milestone: F1/F2 visual follow-up.
Files changed: src/index.css, public/favicon.svg, index.html, and this verification note.
Commands run + result: sampled dominant RGB values from the three reference swatches; npm run build and npm run lint passed; browser-rendered styles matched the sampled values.
Tests passed / failed / not run: home, upload, and completed-detail screens visually checked in the browser; no functional tests added or rerun for this color-only change.
Mock mode or real API used: browser mock mode.
Contract deviations requested (not silently made): none.
Known issues and next small task: no new functionality changes; optional F3 remains separate.

Exact palette: brick #9F4740, cream #F3E1C8, orange #EF9C44. These values supply all app colors; borders, shadows, and decorative outlines use transparency from the same colors. Browser chrome metadata and favicon use the same palette.
