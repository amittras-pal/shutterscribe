# Usage Guide

## Prerequisites

Before using this tool, ensure the following are set up:

1. **Ollama** installed and running — [https://ollama.com/](https://ollama.com/)
2. **qwen2.5vl:3b** model downloaded:
   ```bash
   ollama pull qwen2.5vl:3b
   ```
3. A **Python 3.9+** virtual environment at `app/venv/`  
   *(The launch scripts create and configure this automatically)*
4. **ExifTool** — required only for the `--embed` flag (EXIF metadata writing).  
   See [ExifTool Setup](#exiftool-setup) below.

---

## Starting the Web Interface

### Windows
Double-click `start_app.bat`, or run it from a terminal:
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
- Start the FastAPI server

---

## Using the Web Interface

### Step 1 — Add Images
Copy your exported JPEG files into `content/raw/`. The web interface shows you the count of ready images on the launch screen.

### Step 2 — Start a Run
Click **Start Processing**. The table view appears immediately and all thumbnails are shown. Each row transitions through status badges in real time:

| Badge | Meaning |
|-------|---------|
| `PENDING` | Waiting to be processed |
| `PROCESSING` | AI inference running |
| `SUCCESS` | Metadata generated |
| `FAILED` | Error during inference |

### Step 3 — Review & Edit
Once the run completes, every `SUCCESS` row shows an **Edit** button. Clicking it opens the edit modal with:
- A full-width image preview
- Editable title, description, and keywords fields
- Two validated dropdowns for Shutterstock categories (max 2)

### Step 4 — Save
Clicking **Save Changes** in the modal writes the edits to an `_edited` copy of the output CSV. Multiple saves accumulate in the same edited file — the original AI-generated CSV is never overwritten.

### Step 5 — Clear (optional)
Once all edits are done, **Clear Run** resets the session and deletes the downsampled thumbnails from `app/processing/`. The CSVs in `content/csv/` are preserved.

---

## CLI Usage (No Web Interface)

The pipeline is independently runnable without starting the web server:

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
| `content/output/<filename>.jpg` | Processed originals (moved from raw/) |

---

## ExifTool Setup

ExifTool is only needed if you use the `--embed` flag to write metadata directly into image EXIF/IPTC/XMP tags. CSV generation works without it.

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
# Line ~42 in process_images.py
EXIFTOOL_PATH = "exiftool"   # uses system PATH
```

---

## Warnings

- **Unsaved Changes**: Closing the browser tab with open edits (before clicking Save) will display a browser confirmation prompt.
- **Refresh Safety**: Refreshing the page during or after a run will restore the full table state from the backend's in-memory cache. This cache is lost if the server is restarted.
