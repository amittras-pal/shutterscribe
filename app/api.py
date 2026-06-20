import os
import csv
import json
import asyncio
from typing import Optional, Dict, Any
from pathlib import Path
import threading

from fastapi import FastAPI, BackgroundTasks, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sse_starlette.sse import EventSourceResponse
from pydantic import BaseModel

from .process_images import process_batch, RAW_DIR, CSV_DIR, PROCESSING_DIR

app = FastAPI(title="Shutterstock Automation API")

# Mount static files for the frontend
web_dir = Path(__file__).parent.parent / "web"
os.makedirs(web_dir, exist_ok=True)

# Application State
class AppState:
    job_running = False
    current_csv_path: Optional[str] = None
    edited_csv_path: Optional[str] = None
    queues: list = []
    current_results: Dict[str, dict] = {}

state = AppState()

# Pydantic models
class MetadataSaveRequest(BaseModel):
    filename: str
    title: str
    description: str
    keywords: str
    categories: str

def broadcast_event(event_type: str, data: Dict[str, Any]):
    event = {
        "event": event_type,
        "data": json.dumps(data)
    }
    for q in state.queues:
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            pass

def run_job_sync(loop: asyncio.AbstractEventLoop):
    state.job_running = True
    state.current_csv_path = None
    state.edited_csv_path = None
    state.current_results = {}
    
    # Pre-populate with 'pending'
    if os.path.exists(RAW_DIR):
        for f in os.listdir(RAW_DIR):
            if f.lower().endswith((".jpg", ".jpeg")):
                state.current_results[f] = {"filename": f, "status": "pending"}
    
    def status_callback(filename: str, status: str, payload: Any):
        data = {"filename": filename, "status": status}
        if status == "success" and payload:
            data.update(payload)
        elif status == "failed" and payload:
            data["error_message"] = payload
            
        state.current_results[filename] = data
            
        loop.call_soon_threadsafe(broadcast_event, "status_update", data)

    try:
        csv_path = process_batch(embed=False, status_callback=status_callback)
        if csv_path:
            state.current_csv_path = csv_path
            # Set the expected edited path
            base, ext = os.path.splitext(csv_path)
            state.edited_csv_path = f"{base}_edited{ext}"
        loop.call_soon_threadsafe(broadcast_event, "job_complete", {"csv_path": csv_path})
    except Exception as e:
        loop.call_soon_threadsafe(broadcast_event, "job_error", {"error": str(e)})
    finally:
        state.job_running = False

@app.get("/api/status")
def get_status():
    raw_files = []
    if os.path.exists(RAW_DIR):
        raw_files = [f for f in os.listdir(RAW_DIR) if f.lower().endswith((".jpg", ".jpeg"))]
        
    return {
        "job_running": state.job_running,
        "raw_count": len(raw_files),
        "files": raw_files,
        "current_results": list(state.current_results.values())
    }

@app.post("/api/start")
async def start_job():
    if state.job_running:
        return JSONResponse(status_code=400, content={"message": "Job is already running"})
    
    loop = asyncio.get_running_loop()
    # Run in a separate thread so it doesn't block the async event loop
    thread = threading.Thread(target=run_job_sync, args=(loop,))
    thread.start()
    return {"message": "Job started"}

@app.get("/api/stream")
async def stream_status(request: Request):
    q = asyncio.Queue()
    state.queues.append(q)
    
    async def event_generator():
        try:
            while True:
                # Wait for client to disconnect
                if await request.is_disconnected():
                    break
                # Wait for an event
                event = await asyncio.wait_for(q.get(), timeout=1.0)
                yield event
        except asyncio.TimeoutError:
            # Send a heartbeat to keep connection alive
            yield {"event": "ping", "data": "ping"}
            
            # recursive or loop, let's just loop
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(q.get(), timeout=5.0)
                    yield event
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": "ping"}
        finally:
            state.queues.remove(q)
            
    return EventSourceResponse(event_generator())

@app.post("/api/save")
def save_metadata(payload: MetadataSaveRequest):
    if not state.current_csv_path:
        return JSONResponse(status_code=400, content={"message": "No active CSV from a recent run to edit."})
        
    source_csv = state.edited_csv_path if os.path.exists(state.edited_csv_path) else state.current_csv_path
    target_csv = state.edited_csv_path
    
    rows = []
    updated = False
    
    # Read existing CSV
    with open(source_csv, mode="r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fields = reader.fieldnames
        for row in reader:
            if row["Filename"] == payload.filename:
                csv_desc = f"{payload.title}. {payload.description}"
                if len(csv_desc) > 190:
                    csv_desc = csv_desc[:190] + "..."
                row["Description"] = csv_desc
                row["Keywords"] = payload.keywords
                row["Categories"] = payload.categories
                updated = True
            rows.append(row)
            
    if not updated:
        return JSONResponse(status_code=404, content={"message": f"Filename {payload.filename} not found in CSV."})
        
    # Update in-memory state so refreshes show the edited data
    if payload.filename in state.current_results:
        state.current_results[payload.filename]["title"] = payload.title
        state.current_results[payload.filename]["description"] = payload.description
        state.current_results[payload.filename]["keywords"] = [k.strip() for k in payload.keywords.split(',')]
        state.current_results[payload.filename]["categories"] = [c.strip() for c in payload.categories.split(',')]
        
    # Write to edited CSV
    with open(target_csv, mode="w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
        
    return {"message": "Saved successfully", "file": target_csv}

@app.post("/api/clear")
def clear_run():
    if state.job_running:
        return JSONResponse(status_code=400, content={"message": "Cannot clear while job is running"})
        
    state.current_results = {}
    state.current_csv_path = None
    state.edited_csv_path = None
    
    if os.path.exists(PROCESSING_DIR):
        for f in os.listdir(PROCESSING_DIR):
            if f.lower().endswith((".jpg", ".jpeg")):
                try:
                    os.remove(os.path.join(PROCESSING_DIR, f))
                except OSError:
                    pass
                    
    return {"message": "Run cleared"}

# Mount static files last so it doesn't override API routes
app.mount("/processing", StaticFiles(directory=PROCESSING_DIR), name="processing")
app.mount("/", StaticFiles(directory=str(web_dir), html=True), name="web")
