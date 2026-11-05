@echo off
rem ---- opens the Fake Chat desktop app (same as the desktop shortcut) ----
cd /d "%~dp0"
start "" wscript.exe "%~dp0FakeChat.vbs"
