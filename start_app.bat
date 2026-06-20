@echo off
echo Starting Shutterstock Automation Web Interface...

:: Activate virtual environment
if exist "app\venv\Scripts\activate.bat" (
    call "app\venv\Scripts\activate.bat"
) else (
    echo Virtual environment not found at app\venv. Please ensure it is setup.
    pause
    exit /b 1
)

:: Install required packages if not already installed
if not exist "app\venv\.web_installed" (
    echo Installing necessary web dependencies...
    "app\venv\Scripts\python.exe" -m pip install -q fastapi uvicorn sse-starlette pydantic
    if not errorlevel 1 type nul > "app\venv\.web_installed"
)
:: Launch the browser
echo Opening browser...
start http://localhost:8000

:: Start the API server
echo Starting API server on port 8000...
"app\venv\Scripts\python.exe" -m uvicorn app.api:app --host 0.0.0.0 --port 8000
pause
