# Local frontend, API, and processor setup (Windows CMD)

This guide runs the React frontend against the local FastAPI API and connects the API to the processor in `Backend/services/processor/`. The processor runs inside the API process; it is not a separate server.

> **Repository layout:** backend commands run from `Backend/`, frontend commands run from `Frontend/`. All paths below assume that.

## Requirements

- Node.js version supported by Vite (the web README currently specifies Node 22.12+).
- Python 3.11 or newer and the repository virtual environment at `.venv`.
- A Gemini API key and a currently supported Gemini model ID for real Gemini analysis.

Run commands below from the repository root unless a step says otherwise.

## 1. Install dependencies

In CMD:

```cmd
.venv\Scripts\python.exe -m pip install -r Backend\services\api\requirements.txt
.venv\Scripts\python.exe -m pip install -r Backend\services\processor\requirements.txt
.venv\Scripts\python.exe -m pip install -r Backend\requirements-dev.txt
```

The processor requirements include Faster-Whisper and Google GenAI. Installing them does not download Whisper model weights; those download the first time a real transcription runs.

## 2. Configure the frontend for the API

Create or edit `Frontend/.env.local`:

```env
VITE_USE_MOCK_API=false
VITE_API_BASE_URL=http://127.0.0.1:8000
```

Do not put the Gemini key in this file. Vite variables are exposed to the browser. Restart the Vite dev server after changing this file.

## 3. Start the API with real transcription and Gemini analysis

Open a second CMD window **in the `Backend` folder** — the API imports `services.api.*` / `services.processor.*` as top-level packages, so the working directory must be `Backend`. Set the modes and credentials in that same window, then start the API:

```cmd
set PROCESSOR_MODE=real
set TRANSCRIPTION_MODE=faster_whisper
set WHISPER_MODEL=tiny.en
set ANALYSIS_MODE=gemini
set GEMINI_MODEL=your-supported-model-id
set GEMINI_API_KEY=your-key
..\.venv\Scripts\python.exe -m uvicorn services.api.main:app --reload --host 127.0.0.1 --port 8000
```

Replace the model ID and key with your own values. These `set` values are local to this CMD window; keep it open while developing. Never commit or share the API key. You can use the Gemini key/model you have already verified with the Gemini API.

The first real transcription may download the `tiny.en` model. Use a short MP4 containing audible speech for the first end-to-end check. The API stores the upload locally under the ignored `data/` directory, runs transcription, sends transcript text to Gemini for analysis, and returns the completed journal to the frontend.

## 4. Start and use the frontend

In another CMD window, from `Frontend\`:

```cmd
npm run dev
```

Open the local URL Vite prints (usually `http://localhost:5173`). Upload a small MP4 and wait for processing to finish. API docs are available at `http://127.0.0.1:8000/docs`.

## Lower-cost/debug configurations

To test real transcription without calling Gemini, stop the API with Ctrl+C, then restart it with:

```cmd
set PROCESSOR_MODE=real
set TRANSCRIPTION_MODE=faster_whisper
set ANALYSIS_MODE=mock
..\.venv\Scripts\python.exe -m uvicorn services.api.main:app --reload --host 127.0.0.1 --port 8000
```

To test Gemini integration without downloading Whisper weights, use mock transcription:

```cmd
set PROCESSOR_MODE=real
set TRANSCRIPTION_MODE=mock
set ANALYSIS_MODE=gemini
set GEMINI_MODEL=your-supported-model-id
set GEMINI_API_KEY=your-key
..\.venv\Scripts\python.exe -m uvicorn services.api.main:app --reload --host 127.0.0.1 --port 8000
```

The latter sends a fixed synthetic transcript to Gemini; it checks the Gemini request and response handling, not speech recognition.

## Troubleshooting

- **Frontend shows demo/mock mode:** confirm `VITE_USE_MOCK_API=false` in `Frontend/.env.local`, then restart Vite.
- **Frontend cannot reach the API:** confirm Uvicorn is running on port 8000 and that the frontend API base URL is `http://127.0.0.1:8000`.
- **Results are explicitly labeled mock:** confirm `PROCESSOR_MODE=real` in the CMD window that launches Uvicorn. Also check `TRANSCRIPTION_MODE` and `ANALYSIS_MODE`; each stage has its own setting.
- **Gemini returns HTTP 400:** read the detailed error in the API terminal. The structured response schema is defined in `Backend/services/processor/analysis.py`; unsupported schema fields must be removed or translated to a field supported by the installed Google GenAI SDK/API. The response is still validated locally by Pydantic.
- **Gemini authentication/model error:** verify `GEMINI_API_KEY` and `GEMINI_MODEL` are set in the same CMD window before starting Uvicorn, and that the model supports structured JSON output.
- **Whisper download or decode error:** confirm the machine has internet access for the first model download and that the MP4 has an audible audio track. The default `tiny.en` model is English-focused.
- **Journal becomes failed:** inspect the API terminal for the sanitized processor error. Analysis currently saves only after both transcription and analysis succeed, so a Gemini failure means the transcript is not shown as a completed result.

For details about processor modes, costs, and data handling, see [`Backend/services/processor/README.md`](Backend/services/processor/README.md). Gemini receives transcript text only; it does not receive the uploaded video.
