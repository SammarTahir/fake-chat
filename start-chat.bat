@echo off
rem ---- fake-chat launcher: double-click to start everything ----
cd /d "%~dp0"

rem stop any copy of the server already using port 8080
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /r /c:":8080 .*LISTENING"') do taskkill /pid %%a /f >nul 2>&1

rem make sure Ollama is running for the AI layer (any CLI call auto-starts the
rem app; waits a few seconds; harmless if it is already up or not installed)
echo starting ollama...
ollama list >nul 2>&1

rem start the server in its own window (close it or Ctrl+C to stop)
start "fake-chat server" cmd /k node server.js

rem give it a moment, then open the control page (Chrome needed for the mic)
timeout /t 2 /nobreak >nul
start chrome "http://localhost:8080/control" 2>nul || start "" "http://localhost:8080/control"
