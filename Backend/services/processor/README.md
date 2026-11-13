# Developer 3 — AI Processor (`Backend/services/processor/`)

Transcription + transcript-only emotional analysis for video journals.
Milestones **P1 (mock pipeline)**, **P2 (Faster-Whisper CPU transcription)**,
and **P3 (Gemini analysis)** are implemented. Real end-to-end runs are
opt-in (see below).

The only processing entry point is the Contract B callable:

```python
from pathlib import Path
from services.processor.pipeline import process_video

result = process_video(Path("samples/test-journal.mp4"))
# {"transcript": str,
#  "analysis": {"sentiment": "positive"|"negative"|"neutral",
#               "emotions": [str], "themes": [str], "summary": str}}
```

`on_stage` (optional) fires `"transcribing"` then `"analyzing"`; the
backend owns status writes. Any failure raises a typed `ProcessorError`
subclass — never a fabricated success.

## Modes (environment variables)

| Variable | Values | Default | Meaning |
| --- | --- | --- | --- |
| `TRANSCRIPTION_MODE` | `mock` \| `faster_whisper` | `mock` | P1 mock; P2 real CPU Whisper |
| `ANALYSIS_MODE` | `mock` \| `gemini` | `mock` | P1 mock; P3 real Gemini |
| `WHISPER_MODEL` | e.g. `tiny.en` | `tiny.en` | First run downloads weights |
| `GEMINI_MODEL` | supported model id | empty | Required when `ANALYSIS_MODE=gemini` |
| `GEMINI_API_KEY` | secret | empty | Required when `ANALYSIS_MODE=gemini`; never commit |

A `.env` next to the `services/` package is read if present
(`Backend/.env`, python-dotenv, `override=False`); real
shell exports always win. Unknown mode values raise `ConfigError`.

## Setup and commands (WSL/Ubuntu)

The processor is imported as the top-level package
`services.processor`, so all commands below run from the
`Backend/` directory:

```bash
# From the repository root:
uv venv --python 3.12 .venv        # Python 3.11+ required
source .venv/bin/activate

cd Backend
uv pip install -r services/processor/requirements.txt

# Offline deterministic smoke test (any existing small .mp4 works):
TRANSCRIPTION_MODE=mock ANALYSIS_MODE=mock \
  python -m services.processor.cli samples/test-journal.mp4

# stdout is pure JSON:
TRANSCRIPTION_MODE=mock ANALYSIS_MODE=mock \
  python -m services.processor.cli samples/test-journal.mp4 \
  | python -m json.tool

python -m pytest services/processor/tests -q
```

Mock mode needs no network, no API key, and no model downloads. The CLI
prints a `SYNTHETIC` notice to **stderr** whenever either mode is mock.

## Real end-to-end run (opt-in, costs quota)

```bash
# One-time setup when keys are available:
export GEMINI_API_KEY='...'      # never commit or paste into files
export GEMINI_MODEL='...'        # pick a currently supported id from
                                 # https://ai.google.dev/gemini-api/docs/models

TRANSCRIPTION_MODE=faster_whisper ANALYSIS_MODE=gemini \
  python -m services.processor.cli samples/fictional-spoken-journal.mp4
```

Gemini requests: transcript text only (never video/faces/paths), fixed
system instruction treating the transcript as untrusted data, structured
JSON output re-validated locally with Pydantic, 60 s timeout, bounded SDK
retry on transient HTTP errors, one re-request on invalid model output.
Failures raise typed `AnalysisError`s with sanitized messages (no API
key, no transcript, no request payloads).

## Opt-in tests

```bash
# Real transcription integration (downloads tiny.en on first run):
PROCESSOR_RUN_REAL_TESTS=1 python -m pytest \
  services/processor/tests/test_transcription_whisper.py -q
```

Gemini unit tests always run offline (genai.Client is stubbed).

## Notes

- Tests build tiny synthetic MP4s at runtime (the repo `.gitignore`
  blocks `*.mp4`, so no video fixtures are committed).
- Analysis is inferred from transcript text only — a journaling
  reflection, not a clinical or psychological assessment.
- The Gemini request schema mirrors
  `Backend/packages/contracts/analysis.schema.json`
  (kept in sync by a contract test; `uniqueItems` is enforced locally by
  Pydantic since google-genai's Schema cannot express it).
