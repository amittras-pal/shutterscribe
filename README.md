# Shutterstock AI Automation

A local AI pipeline that automatically generates Shutterstock-compliant metadata (titles, descriptions, keywords, categories) for stock photos using a quantized Vision-Language Model running entirely on your machine via [Ollama](https://ollama.com/).

Includes a web interface for triggering runs, reviewing results in real-time, and editing metadata before export.

## Requirements

- Python 3.9+
- [Ollama](https://ollama.com/) installed and running locally
- The `qwen2.5vl:3b` model pulled in Ollama:
  ```bash
  ollama pull qwen2.5vl:3b
  ```
- **ExifTool** *(optional — only needed for `--embed` EXIF writing)*  
  Not included in the repo. See [ExifTool Setup](docs/usage_guide.md#exiftool-setup) for platform-specific instructions.

## Quick Start

**Windows:**
```bat
start_app.bat
```

**Linux/macOS:**
```bash
chmod +x start_app.sh
./start_app.sh
```

Place your JPEG images in `content/raw/`, then open [http://localhost:8000](http://localhost:8000) and click **Start Processing**.

## CLI Usage (without web interface)

```bash
# Activate venv first
source app/venv/bin/activate      # Linux/macOS
app\venv\Scripts\activate.bat     # Windows

# Run CSV-only mode
python -m app.process_images

# Run with EXIF embedding
python -m app.process_images --embed
```

## Documentation

- [Usage Guide](docs/usage_guide.md)
- [Technical Details](docs/technical_details.md)
- [Implementation Details](docs/implementation_details.md)

## Project Structure

```
stocks-auto/
├── app/
│   ├── process_images.py   # Core AI pipeline (independently runnable)
│   ├── api.py              # FastAPI web backend
│   ├── exiftool/           # Bundled ExifTool binary
│   ├── logs/               # Per-run processing logs
│   └── processing/         # Downsampled thumbnails (transient)
├── content/
│   ├── raw/                # Drop your source JPEGs here
│   ├── output/             # Successfully processed originals
│   └── csv/                # Generated Shutterstock CSVs
├── web/                    # Frontend (HTML/CSS/JS)
├── docs/                   # Documentation
├── start_app.bat           # Windows launcher
└── start_app.sh            # Linux/macOS launcher
```
