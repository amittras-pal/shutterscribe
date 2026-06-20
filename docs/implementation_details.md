# Implementation Details

## Key Design Decisions

### Why a Local VLM?
All inference runs offline via Ollama. No image data is sent to any external API. This is intentional — stock photos may be unprocessed originals you don't want leaving your machine before sale.

### Why `qwen2.5vl:3b`?
The 3B parameter quantized variant of Qwen2.5-VL offers a practical balance between inference quality and speed on consumer hardware. It fits within ~4GB VRAM (or runs on CPU with more time). Larger variants (`7b`, `72b`) can be swapped in by changing `OLLAMA_MODEL` in `process_images.py`.

### Why SSE Instead of WebSockets?
Server-Sent Events are unidirectional (server → client) and natively supported in all modern browsers without any extra library. Since the client never needs to send data back over the persistent connection (saves happen via plain `POST` requests), SSE is simpler and sufficient.

### Thread + Event Loop Bridge
FastAPI runs on an async event loop (asyncio). The VLM inference is synchronous and blocking (Ollama Python SDK). Running it directly in an `async def` handler would block the entire event loop and freeze the server.

The solution: run inference in a **background `threading.Thread`**. To push updates back to SSE clients (which live on the async event loop), the thread uses `loop.call_soon_threadsafe(broadcast_event, ...)` — the standard safe bridge between a synchronous thread and an asyncio loop.

### Edited CSV Strategy
The AI-generated CSV is treated as an immutable record of the model's raw output. Edits made through the web interface are written to a separate `_edited` copy. This preserves the original for audit/comparison and avoids accidental data loss if the web session is interrupted.

When `/api/save` is called:
1. It reads from the edited CSV if it already exists, otherwise from the original.
2. It merges `title` and `description` into a single `Description` field (Shutterstock format), capped at 190 characters.
3. It writes the full updated dataset back to the `_edited` CSV.
4. It also updates the in-memory `current_results` cache so refreshing the page shows edited values.

---

## Processing Flow

```
Start Run (/api/start)
    │
    ├─ Pre-generate all downsampled thumbnails → app/processing/
    │   (allows web UI to show images immediately)
    │
    ├─ Open CSV output files (shutterstock + run log)
    │
    └─ For each image (sequential):
        ├─ Emit status_update: "processing"
        ├─ Run VLM inference (Ollama)
        ├─ Validate response (Pydantic)
        ├─ Write to Shutterstock CSV
        ├─ Optionally embed EXIF via ExifTool
        ├─ Move original to content/output/
        └─ Emit status_update: "success" or "failed"
    
    └─ Emit job_complete or job_error
```

---

## Error Handling

- **Per-image isolation**: each image is wrapped in its own `try/except`. A failure on one image does not abort the rest of the batch.
- **Failed images stay in `raw/`**: if inference fails, the source file is not moved to `output/`, making it trivial to retry on the next run.
- **Pydantic validation**: the VLM response JSON is validated against the schema. If the model returns malformed JSON or missing fields, the exception is caught and the image is marked `failed`.

---

## ExifTool Integration

When run with `--embed`, the pipeline calls ExifTool as a subprocess to write the generated metadata directly into the image file's EXIF/IPTC/XMP tags.

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

- **In-memory state only**: the backend holds the current run's state in RAM. Restarting the server wipes the in-memory cache; the web UI will show the launch screen on next load even if CSVs were already generated.
- **Sequential processing**: images are processed one at a time. Parallelising VLM inference is possible but risks VRAM exhaustion on consumer GPUs.
- **GPU/CPU fallback**: if the GPU runs out of VRAM mid-batch, Ollama silently falls back to CPU inference (typically 10–15× slower). Monitor VRAM usage if you observe sudden spikes in per-image processing time.
- **Windows ExifTool only**: the bundled `exiftool.exe` is a Windows binary. The `--embed` flag requires a separate ExifTool installation on other platforms.
