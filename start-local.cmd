@echo off
setlocal
set PORT=5180
cd /d "%~dp0app"

rem Node.js is preferred: the "python" found in PATH on this machine is only
rem the Microsoft Store alias stub, which cannot serve files.
where node >nul 2>nul
if %errorlevel%==0 (
    echo Starting 37Chat on http://127.0.0.1:%PORT%/  (Ctrl+C to stop)
    start "" http://127.0.0.1:%PORT%/
    node "%~dp0server.mjs" %PORT%
    goto :eof
)

rem Fallback: only a real Python installation can serve files.
python -c "import sys;sys.exit(0 if sys.version_info>=(3,0) else 1)" >nul 2>nul
if %errorlevel%==0 (
    echo Starting 37Chat on http://127.0.0.1:%PORT%/  (Ctrl+C to stop)
    start "" http://127.0.0.1:%PORT%/
    python -m http.server %PORT% --bind 127.0.0.1 --directory "%~dp0app"
    goto :eof
)

echo [ERROR] Neither Node.js nor a working Python was found in PATH.
pause
