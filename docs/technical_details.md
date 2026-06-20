# Technical Details

## Architecture Overview

The system is split into three independent layers:

```
┌──────────────────────────────────────────────┐
│  Frontend  (web/)                            │
│  Plain HTML + Vanilla CSS + Vanilla JS       │
│  SSE-driven real-time status updates         │
└─────────────────────┬────────────────────────┘
                      │ HTTP / SSE
┌─────────────────────▼────────────────────────┐
│  Backend  (app/api.py)                       │
│  FastAPI  ·  Uvicorn  ·  sse-starlette       │
│  In-memory AppState  ·  Background Thread    │
└─────────────────────┬────────────────────────┘
                      │ Python function call
┌─────────────────────▼────────────────────────┐
│  Pipeline  (app/process_images.py)           │
│  Pillow  ·  Ollama Python SDK  ·  ExifTool   │
│  Independently CLI-runnable                  │
└──────────────────────────────────────────────┘
```

---

## Backend — `app/api.py`

### Framework
- **FastAPI** with **Uvicorn** (ASGI server)
- Static files served via `StaticFiles` mount (frontend + processing images)

### State Management
All run state is held in a single in-memory `AppState` singleton:

| Field | Type | Purpose |
|-------|------|---------|
| `job_running` | `bool` | Prevents concurrent runs |
| `current_csv_path` | `str \| None` | Path to AI-generated CSV |
| `edited_csv_path` | `str \| None` | Path to web-edited CSV copy |
| `current_results` | `Dict[str, dict]` | Per-image status + metadata cache |
| `queues` | `list[asyncio.Queue]` | One queue per connected SSE client |

### Real-Time Updates — SSE
`GET /api/stream` opens a persistent `text/event-stream` connection. The background worker calls `loop.call_soon_threadsafe(broadcast_event, ...)` to safely push events from the thread into the async event loop, which then fans out to all connected client queues.

Event types:

| Event | Payload |
|-------|---------|
| `status_update` | `{ filename, status, title?, description?, keywords?, categories? }` |
| `job_complete` | `{ csv_path }` |
| `job_error` | `{ error }` |
| `ping` | heartbeat (keeps connection alive) |

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | File count, run state, current results |
| `POST` | `/api/start` | Kick off a processing run |
| `GET` | `/api/stream` | SSE stream for real-time updates |
| `POST` | `/api/save` | Persist edited metadata to CSV |
| `POST` | `/api/clear` | Reset in-memory state + delete thumbnails |
| `GET` | `/processing/*` | Serve downsampled thumbnail images |
| `GET` | `/*` | Serve frontend static files |

---

## Pipeline — `app/process_images.py`

### Image Downsampling
Before inference, all source images are downsampled to a max longest-edge of **1200px** using Pillow's `Image.LANCZOS` resampler and saved as JPEG at quality 90 into `app/processing/`. This:
- Keeps VLM token count manageable
- Reduces per-image inference time
- Produces thumbnails immediately available to the web UI

### VLM Inference
Images are sent to the local Ollama instance using the [Ollama Python SDK](https://github.com/ollama/ollama-python). The model receives:
- The downsampled image (base64-encoded internally by the SDK)
- A structured prompt requesting JSON output conforming to the `ImageMetadata` Pydantic schema

The response is parsed and validated by Pydantic. Validation failures raise exceptions caught by the per-image `try/except` block.

### Metadata Schema

```python
class ImageMetadata(BaseModel):
    title: str                         # ≤ 200 chars, title case
    description: str                   # ≤ 200 chars
    keywords: List[str]                # 7–50 single-word or short phrase tags
    categories: List[ShutterstockCategory]  # 1–2 from Shutterstock's fixed list
```

### Output CSV Format
Shutterstock's bulk upload format requires these exact columns:

| Column | Notes |
|--------|-------|
| `Filename` | Original filename |
| `Description` | Title + `. ` + description (max 190 chars) |
| `Keywords` | Comma-separated |
| `Categories` | Comma-separated (max 2) |
| `Illustration` | `No` (hardcoded — photos only) |
| `Mature Content` | `No` (hardcoded) |
| `Editorial` | `No` (hardcoded) |

---

## Frontend — `web/`

- **No build step.** Pure HTML/CSS/JS, served directly by FastAPI's `StaticFiles`.
- **SSE client** uses the browser's native `EventSource` API.
- **State restoration** on refresh: `GET /api/status` returns `current_results`, so the UI can restore the full table from the server cache without re-running.
- **Glassmorphism design** using CSS `backdrop-filter`, HSL colour tokens, and subtle micro-animations.

---

## Directory Layout

```
stocks-auto/
├── app/
│   ├── __init__.py         # (implicit — module run via python -m app.*)
│   ├── process_images.py   # Core pipeline
│   ├── api.py              # FastAPI app
│   ├── requirements.txt    # Python dependencies
│   ├── exiftool/           # ExifTool binary (Windows)
│   ├── logs/               # Per-run CSVs: run_log_<timestamp>.csv
│   └── processing/         # Transient thumbnails (cleared by Clear Run)
├── content/
│   ├── raw/                # Input: source JPEGs (populated by Lightroom)
│   ├── output/             # Processed originals (moved after success)
│   └── csv/                # Generated CSVs
├── web/
│   ├── index.html
│   ├── style.css
│   └── main.js
├── docs/
├── start_app.bat           # Windows launcher
├── start_app.sh            # Linux/macOS launcher
├── README.md
└── .gitignore
```
