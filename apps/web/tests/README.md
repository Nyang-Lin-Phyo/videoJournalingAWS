# Frontend tests

All automated frontend tests and their shared setup live in this folder. They use **Vitest**, **React Testing Library**, and **jsdom**. Run the commands below from `apps/web/`, not from inside `tests/`.

## Setup and quick start

```powershell
cd "D:\NYU\Cloud Computing\Project\videoJournaling\apps\web"
npm ci       # only needed when dependencies are missing or the lockfile changes
npm test     # run every test once, then exit
```

You do not need the Vite development server, FastAPI, a database, FFmpeg, Whisper, Gemini, API keys, or a video recording. HTTP requests are stubbed, and files are synthetic test data created in memory. Test configuration explicitly sets `VITE_USE_MOCK_API=true`, even when `.env.local` selects the real API for normal development.

## What each script does

| File                  | Purpose and behavior checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Run only this file             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `httpClient.test.ts`  | Tests the typed HTTP client against the repository's actual response shapes. Checks create → raw MP4 PUT → complete ordering, API-base URL resolution, required `204` upload responses, stopping after a failed upload, list ordering, `error_message`, safe HTTP/network/JSON errors, rejection of malformed results and foreign upload URLs, deletion with an empty `204` body, caller cancellation, and request timeouts. Uses a stubbed `fetch`; no server requests are made.                 | `npm run test:api`             |
| `mockClient.test.ts`  | Tests the browser demo API. Creates entries, uploads synthetic MP4-header bytes, advances a controlled clock through queued/transcribing/analyzing/completed, checks that missing upload and active deletion are rejected, verifies invalid MP4 rejection, deletes finished entries, checks object URL revocation, and confirms a new mock instance restores the example entries. It checks URL plumbing, not real video decoding.                                                                | `npm run test:mocks`           |
| `useJournal.test.tsx` | Tests the journal polling hook with fake timers. Checks that polling stops at completed/failed, that refresh and navigation abort the previous requests, that refresh does not create duplicate loops, and that unmount cancels pending requests and timers.                                                                                                                                                                                                                                      | `npm run test:polling`         |
| `pages.test.tsx`      | Renders the actual React UI using an in-memory router. Checks empty history and upload links, completed detail fields and mock labeling, history filters, retryable errors, oversized-file prevention, retained-file retry, duplicate-submit protection, preview URL cleanup, plain-text rendering of HTML-like content, empty analysis lists, delete dialog cancel/focus behavior, confirmed deletion and navigation, missing entries, and file extension/MIME/empty/30 MiB boundary validation. | `npm run test:ui`              |
| `setup.ts`            | Runs automatically before each test file. Adds DOM matchers such as `toBeVisible`, cleans up rendered React components after every test, restores spies and stubbed globals, and supplies a jsdom-compatible `window.scrollTo` stub. It is test support, not a standalone test command.                                                                                                                                                                                                           | Automatically loaded by Vitest |

The suite currently contains **30 tests across four test files**. Vitest counts parameterized cases individually, so one `it.each(...)` may account for multiple tests.

## All available test commands

```powershell
npm test                 # all tests, one run
npm run test:watch       # watch mode: rerun tests when relevant files change; q exits
npm run test:api         # HTTP client contract and errors
npm run test:mocks       # deterministic browser demo lifecycle
npm run test:polling     # polling lifecycle, cancellation, and cleanup
npm run test:ui          # React pages, user flows, and validation
```

Pass Vitest arguments after `--` when you want to narrow a run or inspect output:

```powershell
npm test -- tests/pages.test.tsx
npm test -- -t "rejects oversize selection"
npm test -- --reporter=verbose
```

A successful run reports all selected tests as passed and exits with code `0`. A failure exits with a nonzero code, names the failing file/case, and shows the failed assertion. Watch mode deliberately keeps running until you quit.

Related project checks, also run from `apps/web/`:

```powershell
npm run lint     # lint frontend source and tests
npm run build    # type-check source + tests, then build the production frontend
```

## Configuration and fixtures

- `../vite.config.ts` discovers `tests/**/*.test.{ts,tsx}`, selects jsdom, pins mock mode, loads `tests/setup.ts`, and clears mock call history between tests.
- `../tsconfig.app.json` includes both `src/` and `tests/` so moving tests out of `src/` does not remove TypeScript checking.
- `../src/mocks/fixtures.ts` contains the application's fictional examples used by the tests. It stays with the app because the demo UI also uses it.
- `../src/mocks/mockClient.ts` is the application's browser demo API, not a test script; tests import it rather than maintaining a duplicate implementation.
- Timers, object URLs, HTTP responses, and file sizes are controlled where necessary to keep checks fast and repeatable. No recordings or credentials are committed.

## What these tests do not prove

jsdom is a simulated DOM, not a full browser. These scripts do not verify visual layout/color accuracy, real video playback or codec support, seeking/Range responses, persistence in the real backend, genuine speech transcription/AI analysis, or optional WASM trimming. Use the manual integration instructions in `../README.md` and the observations in `../VERIFICATION.md` for browser/API checks. The backend's Python tests remain in their existing repository directories; this folder is for Developer 1's frontend tests.

## Adding a test

Add a descriptive `*.test.ts` or `*.test.tsx` file here and import the production code from `../src/`. Vitest will discover it automatically. Use synthetic data, stub HTTP interactions, restore any fake timers, and assert user-visible behavior or meaningful contract boundaries. Update this README if you introduce another test category or npm command.
