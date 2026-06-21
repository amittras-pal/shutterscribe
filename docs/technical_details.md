# Technical Details

## Architecture Overview

The system is split into four independent layers:

```
┌──────────────────────────────────────────────────────┐
│  Frontend  (web/)                                    │
│  Plain HTML + Vanilla CSS + Vanilla JS               │
│  SSE-driven real-time status updates                 │
└──────────────────────────┬───────────────────────────┘
                           │ HTTP / SSE
┌──────────────────────────▼───────────────────────────┐
│  Backend  (app/api.py)                               │
│  FastAPI  ·  Uvicorn (--reload)  ·  sse-starlette    │
│  In-memory AppState  ·  Background Threads           │
└────────┬──────────────────────────┬──────────────────┘
         │ Python function call     │ Python function call
┌────────▼────────────┐   ┌─────────▼────────────────┐
│  Pipeline           │   │  FTP Upload              │
│  (process_images.py)│   │  (ftp_upload.py)         │
│  Pillow · Ollama    │   │  ftplib.FTP_TLS          │
│  ExifTool · Pydantic│   │  ThreadPoolExecutor      │
│  CLI-runnable       │   │  Parallel connections    │
└─────────────────────┘   └──────────────────────────┘
```

---

## Backend — `app/api.py`

### Framework
- **FastAPI** with **Uvicorn** (ASGI server), launched with `--reload` for hot-reloading on source changes
- Static files served via `StaticFiles` mounts: frontend (`web/`) and thumbnails (`app/processing/`)
- Logging configured at startup via `logging.basicConfig`; `shutterscribe.ftp` and `ftplib` loggers are wired up for FTP debugging

### State Management
All run state is held in a single in-memory `AppState` singleton:

| Field | Type | Purpose |
|-------|------|---------|
| `job_running` | `bool` | Prevents concurrent processing runs |
| `current_csv_path` | `str \| None` | Path to AI-generated CSV |
| `edited_csv_path` | `str \| None` | Path to web-edited CSV copy |
| `current_results` | `Dict[str, dict]` | Per-image status + metadata cache |
| `queues` | `list[asyncio.Queue]` | One queue per connected SSE client |
| `upload_running` | `bool` | Prevents concurrent upload runs |
| `upload_progress` | `dict` | Live upload counters (total, uploaded, failed, current_file, errors, done) |

### Real-Time Updates — SSE
`GET /api/stream` opens a persistent `text/event-stream` connection. Background workers use `loop.call_soon_threadsafe(broadcast_event, ...)` to safely push events from threads into the async event loop, which fans out to all connected client queues. The SSE connection is kept alive with periodic `ping` heartbeats.

The connection lifecycle:
- **Opens** when a processing run starts (or when an upload starts if it had been closed)
- **Stays open** after processing completes — needed to receive upload progress events
- **Closes** after `upload_complete`, or when the user clicks **Clear Run**

#### Processing Events

| Event | Payload |
|-------|---------|
| `status_update` | `{ filename, status, title?, description?, keywords?, categories? }` |
| `job_complete` | `{ csv_path }` |
| `job_error` | `{ error }` |
| `ping` | heartbeat only |

#### Upload Events

| Event | Payload |
|-------|---------|
| `upload_progress` | `{ filename, processed, total, uploaded, failed, status, error }` |
| `upload_complete` | `{ total, uploaded, failed, errors[] }` |
| `upload_error` | `{ error }` — fatal connection failure |

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | File count, run state, current results, upload progress |
| `POST` | `/api/start` | Kick off a processing run |
| `GET` | `/api/stream` | SSE stream for all real-time events |
| `POST` | `/api/save` | Persist edited metadata to CSV |
| `POST` | `/api/clear` | Reset in-memory state + delete thumbnails |
| `POST` | `/api/upload/start` | Begin FTPS upload of `content/output/` |
| `GET` | `/api/upload/status` | Current upload progress snapshot |
| `GET` | `/processing/*` | Serve downsampled thumbnail images |
| `GET` | `/*` | Serve frontend static files |

---

## Pipeline — `app/process_images.py`

### Image Downsampling
Before inference, all source images are downsampled to a max longest-edge of **1200px** using Pillow's `Image.LANCZOS` resampler and saved as JPEG at quality 85 into `app/processing/`. This:
- Keeps VLM token count manageable
- Reduces per-image inference time
- Produces thumbnails immediately available to the web UI

### VLM Inference
Images are sent to the local Ollama instance using the [Ollama Python SDK](https://github.com/ollama/ollama-python). The model receives:
- The downsampled image (base64-encoded internally by the SDK)
- A structured system prompt enforcing English-only output
- A JSON schema derived from the `ShutterstockMetadata` Pydantic model via `model_json_schema()`

Non-ASCII text detection triggers one automatic retry with a stronger English instruction. After two non-English outputs the image is marked `failed`.

### Metadata Schema

```python
class ShutterstockMetadata(BaseModel):
    title: str                                  # ≤ 150 chars, factual
    description: str                            # ≤ 2048 chars, factual
    keywords: List[str]                         # 20–30 lowercase tags
    categories: List[ShutterstockCategory]      # 1–2 from Shutterstock's fixed list
```

### Output CSV Format
Shutterstock's bulk upload format requires these exact columns:

| Column | Notes |
|--------|-------|
| `Filename` | Original filename |
| `Description` | Description text only, max 2048 chars (Shutterstock dashboard limit) |
| `Keywords` | Comma-separated |
| `Categories` | Comma-separated (max 2) |
| `Illustration` | `No` (hardcoded — photos only) |
| `Mature Content` | `No` (hardcoded) |
| `Editorial` | `No` (hardcoded) |

---

## FTP Upload — `app/ftp_upload.py`

### Protocol
Shutterstock FTPS uses **Explicit FTP over TLS (AUTH TLS)** on port 21 (`ftps.shutterstock.com`). Python's built-in `ftplib.FTP_TLS` handles this natively. The connection sequence per worker:

1. TCP connect to `ftps.shutterstock.com:21`
2. `AUTH TLS` — upgrade control channel to TLS
3. `USER` / `PASS` — contributor credentials
4. `PROT P` — upgrade data channel to TLS
5. `PASV` — passive mode (required behind NAT/firewalls)
6. `STOR <filename>` — per file
7. `QUIT`

TLS certificate verification is intentionally disabled (`CERT_NONE`) to match the "trust all certificates" behaviour Shutterstock's own documentation instructs for GUI clients.

### Parallel Upload Architecture
The upload engine supports `N` concurrent FTPS connections controlled by `SHUTTERSTOCK_FTP_PARALLEL` (default: `1`).

```
Worker 0 (connection)  →  file0, file3, file6, …
Worker 1 (connection)  →  file1, file4, file7, …   (round-robin distribution)
Worker 2 (connection)  →  file2, file5, file8, …
```

Each worker owns its own `FTPUploader` instance — `ftplib.FTP_TLS` is not thread-safe and must not be shared. Connections are opened once per worker and **reused** for the entire batch to avoid repeated TLS handshake overhead (~5–8 round trips per new session).

A `threading.Lock` guards all counter mutations so that `progress_callback` receives atomically-consistent `(uploaded, failed)` totals regardless of how many workers fire concurrently.

When `SHUTTERSTOCK_FTP_PARALLEL=1`, the `ThreadPoolExecutor` is bypassed entirely (no thread pool overhead).

### Post-Upload Cleanup
Each file is deleted from `content/output/` immediately after a confirmed `STOR` to the server, preventing re-uploads. If a worker crashes mid-batch, already-uploaded files are already deleted; remaining files stay in `output/` for retry.

### Credentials
All credentials and connection settings are loaded from `app/.env` via `python-dotenv`:

| Variable | Default | Description |
|----------|---------|-------------|
| `SHUTTERSTOCK_FTP_USER` | — | Contributor email or username |
| `SHUTTERSTOCK_FTP_PASSWORD` | — | Contributor account password |
| `SHUTTERSTOCK_FTP_HOST` | `ftps.shutterstock.com` | FTPS server hostname |
| `SHUTTERSTOCK_FTP_PORT` | `21` | FTPS port |
| `SHUTTERSTOCK_FTP_PARALLEL` | `1` | Number of concurrent connections (max: 3) |

---

## Frontend — `web/`

- **No build step.** Pure HTML/CSS/JS, served directly by FastAPI's `StaticFiles`.
- **SSE client** uses the browser's native `EventSource` API with named event listeners for all six event types (`status_update`, `job_complete`, `job_error`, `upload_progress`, `upload_complete`, `upload_error`).
- **State restoration** on page refresh: `GET /api/status` returns both `current_results` and `upload_progress`, enabling full rehydration of the table and upload progress bar without re-running anything.
- **Upload progress bar** renders as an animated shimmer bar that resolves to green (success), amber (partial errors), or red (all failed) on completion.
- **Glassmorphism design** using CSS `backdrop-filter`, HSL colour tokens, and subtle micro-animations.

---

## Directory Layout

```
shutterscribe/
├── app/
│   ├── api.py              # FastAPI REST server + SSE broadcasting
│   ├── process_images.py   # AI processing pipeline (also CLI-runnable)
│   ├── ftp_upload.py       # FTPS upload utility (isolated from AI/REST logic)
│   ├── requirements.txt    # Python dependencies
│   ├── .env                # Credentials — NOT committed (see .env.example)
│   ├── .env.example        # Template for .env
│   ├── exiftool/           # ExifTool binary (Windows) — download separately
│   ├── logs/               # Per-run CSVs: run_log_<timestamp>.csv
│   └── processing/         # Transient thumbnails (cleared by Clear Run)
├── content/
│   ├── raw/                # Input: source JPEGs
│   ├── output/             # Processed originals (moved after success, deleted after upload)
│   └── csv/                # AI-generated and edited CSVs
├── web/
│   ├── index.html
│   ├── style.css
│   └── main.js
├── docs/
│   ├── technical_details.md
│   ├── implementation_details.md
│   └── usage_guide.md
├── start_app.bat           # Windows launcher (Uvicorn with --reload)
├── start_app.sh            # Linux/macOS launcher
├── README.md
└── .gitignore
```
