#!/usr/bin/env bash
set -e

echo "Starting Shutterstock Automation Web Interface..."

VENV="app/venv"

# Check virtual environment exists
if [ ! -f "$VENV/bin/activate" ]; then
    echo "Virtual environment not found at $VENV. Creating one..."
    python3 -m venv "$VENV"
fi

source "$VENV/bin/activate"

# Install web dependencies once (marker file)
if [ ! -f "$VENV/.web_installed" ]; then
    echo "Installing necessary web dependencies..."
    pip install -q fastapi uvicorn sse-starlette pydantic
    touch "$VENV/.web_installed"
fi

# Open browser in background
echo "Opening browser..."
if command -v xdg-open &>/dev/null; then
    xdg-open http://localhost:8000 &
elif command -v open &>/dev/null; then
    open http://localhost:8000 &
fi

# Start server
echo "Starting API server on port 8000..."
python -m uvicorn app.api:app --host 0.0.0.0 --port 8000
