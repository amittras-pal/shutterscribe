# Usage Guide

## Prerequisites

Before using ShutterScribe, ensure the following are set up:

1. **Ollama** installed and running — [https://ollama.com/](https://ollama.com/)
2. **qwen2.5vl:3b** model downloaded:
   ```bash
   ollama pull qwen2.5vl:3b
   ```
3. A **Python 3.9+** virtual environment at `app/venv/`  
   *(The launch scripts create and configure this automatically on first run)*
4. **Shutterstock contributor credentials** configured in `app/.env`  
   *(Required for the FTPS upload feature — see [Credentials Setup](#credentials-setup) below)*
5. **ExifTool** — required only for the `--embed` flag (EXIF metadata writing).  
   See [ExifTool Setup](#exiftool-setup) below.

---

## Credentials Setup

ShutterScribe reads your Shutterstock FTPS credentials from `app/.env`. This file is **gitignored and never committed**.

1. Copy the template:
   ```
   app/.env.example  →  app/.env
   ```
2. Fill in your Shutterstock contributor details:
   ```env
   SHUTTERSTOCK_FTP_USER=your_contributor_email@example.com
   SHUTTERSTOCK_FTP_PASSWORD=your_shutterstock_password

   # Optional — defaults shown
   SHUTTERSTOCK_FTP_HOST=ftps.shutterstock.com
   SHUTTERSTOCK_FTP_PORT=21
   SHUTTERSTOCK_FTP_PARALLEL=1
   ```

> **Note on `SHUTTERSTOCK_FTP_PARALLEL`**: controls how many simultaneous FTPS connections are used during upload. `1` is the safe default (serial). Setting it to `3` gives a meaningful speedup (~2–2.5×) without risking server rejection. Do not exceed `5`.

---

## Starting the Web Interface

### Windows
Double-click `start_app.bat`, or run from a terminal:
```bat
start_app.bat
```

### Linux / macOS
```bash
chmod +x start_app.sh
./start_app.sh
```

The script will:
- Create `app/venv/` if it doesn't exist
- Install web dependencies on first run only
- Open your browser at [http://localhost:8000](http://localhost:8000)
- Start the FastAPI server with **hot-reload** enabled (Python file changes apply without restart)

> **Hot-reload**: `.py` files are automatically reloaded by Uvicorn. Changes to `web/` (HTML, CSS, JS) take effect immediately on the next browser refresh — no server restart needed.

---

## Using the Web Interface

### Step 1 — Add Images
Copy your exported JPEG files into `content/raw/`. The launch screen shows the count of ready images.

### Step 2 — Start Processing
Click **Start Processing**. The table view appears immediately and all thumbnails are shown. Each row transitions through status badges in real time:

| Badge | Meaning |
|-------|---------|
| `PENDING` | Waiting for its turn |
| `PROCESSING` | AI inference running right now |
| `SUCCESS` | Metadata generated |
| `FAILED` | Error during inference — file stays in `raw/` for retry |

### Step 3 — Review & Edit
Once the run completes, every `SUCCESS` row shows an **Edit** button. Clicking it opens the edit modal with:
- A full-width image preview
- Editable title, description, and keywords fields
- Two validated dropdowns for Shutterstock categories (max 2)

### Step 4 — Save
Clicking **Save Changes** in the modal writes the edits to an `_edited` copy of the output CSV. Multiple saves accumulate in the same edited file — the original AI-generated CSV is never overwritten.

### Step 5 — Upload to Shutterstock
Once satisfied with the metadata, click **Upload to Shutterstock**. This:
1. Opens the upload progress bar above the table
2. Connects to `ftps.shutterstock.com` using your `.env` credentials
3. Uploads all JPEG files from `content/output/` — with N parallel connections if configured
4. Deletes each file from `content/output/` immediately after a confirmed upload
5. Shows a final summary: files uploaded, files failed (if any), and any error details

The **Upload to Shutterstock** button is disabled while upload is in progress and hidden after a fully successful upload (nothing left to upload).

> **Note**: the metadata CSV is **not** uploaded via FTPS. It must be submitted separately through the Shutterstock Contributor Portal.

### Step 6 — Clear (optional)
**Clear Run** resets the session, returns to the launch screen, and deletes the downsampled thumbnails from `app/processing/`. The CSVs in `content/csv/` are preserved.

---

## Page Refresh / State Recovery

ShutterScribe is designed to survive page refreshes without data loss:

| Scenario | What you see on refresh |
|----------|------------------------|
| Processing in progress | Table restored with current progress; live updates continue |
| Processing complete, not uploaded | Full table with metadata and Upload button |
| Upload in progress | Progress bar restored to last known state; live updates continue |
| Upload complete (success) | Progress bar shows final summary; Upload button hidden |
| Upload complete (partial errors) | Progress bar shows error count; Upload button available for retry |
| Server was restarted | Launch screen — in-memory state is cleared on restart |

---

## CLI Usage (No Web Interface)

The processing pipeline can be run independently without the web server:

```bash
# Activate venv
source app/venv/bin/activate        # Linux/macOS
app\venv\Scripts\activate.bat       # Windows

# CSV-only mode (default)
python -m app.process_images

# With EXIF metadata embedding via ExifTool
python -m app.process_images --embed
```

### Output Files

| Path | Description |
|------|-------------|
| `content/csv/shutterstock_<timestamp>.csv` | Shutterstock-compatible upload CSV |
| `content/csv/shutterstock_<timestamp>_edited.csv` | Web-edited version (created on first save) |
| `app/logs/run_log_<timestamp>.csv` | Per-image technical run log |
| `content/output/<filename>.jpg` | Processed originals (moved from `raw/`, deleted after upload) |

---

## ExifTool Setup

ExifTool is only needed if you use the `--embed` flag to write metadata directly into image EXIF/IPTC/XMP tags. CSV generation and FTPS upload work without it.

The `app/exiftool/` directory is **excluded from the repository** — you must set it up manually.

### Windows

1. Download the **Windows Executable** from [https://exiftool.org/](https://exiftool.org/)  
   *(look for `exiftool-<version>.zip` — the standalone executable, not the Perl distribution)*
2. Extract and rename `exiftool(-k).exe` → `exiftool.exe`
3. Place it at:
   ```
   app/exiftool/exiftool.exe
   ```
No further configuration needed — the pipeline picks it up automatically via `EXIFTOOL_PATH` in `process_images.py`.

### Linux / macOS

Install system-wide via your package manager:

```bash
# macOS
brew install exiftool

# Ubuntu / Debian
sudo apt install libimage-exiftool-perl
```

Then update `EXIFTOOL_PATH` in `app/process_images.py` to point to the system binary:
```python
EXIFTOOL_PATH = "exiftool"   # uses system PATH
```

---

## Warnings & Gotchas

- **Credentials syntax**: each line in `app/.env` must use `KEY=VALUE` format with no spaces around `=`. A missing `=` (e.g. `SHUTTERSTOCK_FTP_PASSWORDmypassword`) means the variable is silently ignored and the upload will fail with a credentials error.
- **Unsaved edits**: closing the browser tab with an unsaved edit modal open will trigger a browser confirmation prompt.
- **Refresh safety**: page refresh during an upload restores the progress bar to the last known state and reconnects to the live SSE stream if the upload is still in progress.
- **CSV not uploaded via FTP**: only image files are uploaded to Shutterstock's FTP server. The metadata CSV must be submitted via the [Shutterstock Contributor Portal](https://submit.shutterstock.com).
- **Server restart clears state**: restarting the server wipes in-memory state. The launch screen will appear on next load, but CSVs in `content/csv/` and any unuploaded images in `content/output/` are preserved on disk.
