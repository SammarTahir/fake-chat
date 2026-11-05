@echo off
rem ---- fake-chat stopper: double-click to shut the server down ----
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /r /c:":8080 .*LISTENING"') do taskkill /pid %%a /f >nul 2>&1
echo fake-chat stopped.
timeout /t 2 /nobreak >nul
