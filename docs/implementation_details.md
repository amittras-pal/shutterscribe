# Implementation Details

## Key Design Decisions

### Why a Local VLM?
All inference runs offline via Ollama. No image data is sent to any external API. This is intentional — stock photos may be unprocessed originals you don't want leaving your machine before sale.

### Why `qwen2.5vl:3b`?
The 3B parameter quantized variant of Qwen2.5-VL offers a practical balance between inference quality and speed on consumer hardware. It fits within ~4 GB VRAM (or runs on CPU with more time). Larger variants (`7b`, `72b`) can be swapped in by changing `OLLAMA_MODEL` in `process_images.py`.

### Why SSE Instead of WebSockets?
Server-Sent Events are unidirectional (server → client) and natively supported in all modern browsers without any extra library. Since the client never needs to send data back over the persistent connection (saves and uploads happen via plain `POST` requests), SSE is simpler and sufficient.

The SSE connection is shared across both the **processing** and **upload** phases — it stays alive after processing completes so that upload progress events are received on the same stream.

### Thread + Event Loop Bridge
FastAPI runs on an async event loop (asyncio). Both VLM inference and FTP uploads are synchronous and blocking. Running them directly in `async def` handlers would block the entire event loop and freeze the server.

The solution: run each operation in a **background `threading.Thread`**. To push updates back to SSE clients (which live on the async event loop), threads use `loop.call_soon_threadsafe(broadcast_event, ...)` — the standard safe bridge between synchronous threads and an asyncio loop.

Parallel FTP upload workers (a `ThreadPoolExecutor`) use the same bridge: each worker calls `progress_callback`, which in turn calls `loop.call_soon_threadsafe`. The `threading.Lock` inside `ftp_upload.py` ensures counter updates are atomic before the callback fires.

### Edited CSV Strategy
The AI-generated CSV is treated as an immutable record of the model's raw output. Edits made through the web interface are written to a separate `_edited` copy. This preserves the original for audit/comparison and avoids accidental data loss if the web session is interrupted.

When `/api/save` is called:
1. It reads from the edited CSV if it already exists, otherwise from the original.
2. It writes the `description` field directly into the `Description` column, truncated to **2048 characters** — the limit shown on the Shutterstock contributor dashboard.
3. It writes the full updated dataset back to the `_edited` CSV.
4. It also updates the in-memory `current_results` cache so refreshing the page shows edited values.

> **Note**: the `Description` column contains only the description text. The pipeline and web-edit path are consistent — neither prepends the title. Shutterstock's dashboard treats title and description as separate fields; the CSV `Description` column maps to the description field only.

### FTP Module Isolation
`app/ftp_upload.py` is intentionally kept separate from `api.py` and `process_images.py`. It has no knowledge of FastAPI, Ollama, or the web layer — it only knows about files, paths, and FTPS. This makes it independently testable and replaceable without touching the AI or REST logic.

### Parallel Upload Counter Safety
With N concurrent upload workers, multiple threads fire `progress_callback` simultaneously. The callback receives pre-computed `(uploaded, failed)` totals rather than deltas — the values are captured **inside** the `threading.Lock` in `_upload_worker` and passed out. The callback then does a direct assignment to `state.upload_progress`, not an increment, so there is no arithmetic race condition. CPython's GIL ensures dict key assignments are atomic.

---

## Processing Flow

```
Start Run (/api/start)
    │
    ├─ Pre-generate all downsampled thumbnails → app/processing/
    │   (allows web UI to show images immediately via /processing/* route)
    │
    ├─ Open Shutterstock CSV + run log CSV
    │
    └─ For each image (sequential):
        ├─ Emit SSE: status_update "processing"
        ├─ Run VLM inference (Ollama qwen2.5vl:3b)
        ├─ Detect non-English output → retry once with stricter prompt
        ├─ Validate response with Pydantic (ShutterstockMetadata)
        ├─ Write row to Shutterstock CSV (flushed immediately)
        ├─ Optionally embed EXIF/IPTC/XMP via ExifTool (--embed flag)
        ├─ Move original from content/raw/ → content/output/
        └─ Emit SSE: status_update "success" or "failed"

    └─ Emit SSE: job_complete or job_error
    └─ SSE connection stays open (ready for upload phase)
```

---

## Upload Flow

```
Start Upload (/api/upload/start)
    │
    ├─ Read SHUTTERSTOCK_FTP_PARALLEL (default: 1)
    ├─ Collect all JPEGs from content/output/
    ├─ Distribute files round-robin across N worker batches
    │
    ├─ [Serial: n_workers=1]   call _upload_worker directly
    └─ [Parallel: n_workers>1] ThreadPoolExecutor(max_workers=N)
        │
        └─ Each worker (owns one FTPUploader / one FTPS connection):
            ├─ Connect: TCP → AUTH TLS → LOGIN → PROT P → PASV
            ├─ For each file in batch:
            │   ├─ STOR <filename>  (upload)
            │   ├─ unlink local file (delete from output/)
            │   ├─ Acquire lock → increment counter → release lock
            │   └─ Emit SSE: upload_progress (with atomic totals)
            └─ QUIT

    └─ Emit SSE: upload_complete (with final summary)
         or SSE: upload_error (fatal connection failure)
```

---

## Error Handling

### Processing
- **Per-image isolation**: each image is wrapped in its own `try/except`. A failure on one image does not abort the rest of the batch.
- **Failed images stay in `raw/`**: if inference fails, the source file is not moved to `output/`, making it trivial to retry on the next run.
- **Non-English retry**: the pipeline detects non-ASCII characters in VLM output and retries once with a stricter English-only instruction before marking as `failed`.
- **Pydantic validation**: the VLM response JSON is validated against the schema. Malformed JSON or missing fields raise an exception caught by the per-image handler.

### Upload
- **Per-file isolation**: each file upload is wrapped in `try/except` inside the worker. One failed file does not abort the worker or other workers.
- **Connection failure**: if a worker fails to connect, all files in its batch are immediately marked `failed` with the connection error. Other workers continue unaffected.
- **No re-upload risk**: files are deleted from `output/` immediately after a successful `STOR`. The upload button is hidden after `upload_complete`. If the page is refreshed after a successful upload, the button stays hidden.

---

## ExifTool Integration

When run with `--embed`, the pipeline calls ExifTool as a subprocess to write the generated metadata directly into the image file's EXIF/IPTC/XMP tags. This is optional — CSV generation and FTPS upload work without it.

> **The `app/exiftool/` directory is not included in the repository.** You must place the binary there manually.

### Windows Setup
- Download the standalone executable from [https://exiftool.org/](https://exiftool.org/)
- Rename `exiftool(-k).exe` → `exiftool.exe`
- Place at `app/exiftool/exiftool.exe`
- No further config needed — `EXIFTOOL_PATH` in `process_images.py` points here by default

### Linux / macOS Setup
- Install via package manager: `brew install exiftool` or `sudo apt install libimage-exiftool-perl`
- Update `EXIFTOOL_PATH` in `app/process_images.py`:
  ```python
  EXIFTOOL_PATH = "exiftool"   # resolves via system PATH
  ```

---

## Known Limitations

- **In-memory state only**: the backend holds all run and upload state in RAM. Restarting the server clears in-memory state. However, `GET /api/status` serves the last known upload progress so the UI can rehydrate the progress bar on page refresh (within the same server session).
- **Sequential VLM processing**: images are processed one at a time. Parallelising inference is possible but risks VRAM exhaustion on consumer GPUs.
- **GPU/CPU fallback**: if the GPU runs out of VRAM mid-batch, Ollama silently falls back to CPU inference (typically 10–15× slower). Monitor per-image processing time for sudden spikes.
- **Shutterstock connection limit**: no hard limit is published, but community data suggests 2–5 concurrent connections. `SHUTTERSTOCK_FTP_PARALLEL` is capped at the user's discretion; exceeding 5 risks `421 Too many connections` rejections.
- **JPEG only**: both the processing pipeline and the FTP uploader handle `.jpg`/`.jpeg` files only. Other formats are ignored.
- **Windows ExifTool only**: the bundled `exiftool.exe` is a Windows binary. The `--embed` flag requires a separate ExifTool installation on other platforms.
