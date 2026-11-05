@echo off
rem Puts a "Fake Chat" shortcut (with the app icon) on your desktop.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$lnk = $ws.CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath('Desktop'), 'Fake Chat.lnk'));" ^
  "$lnk.TargetPath = \"$env:WINDIR\System32\wscript.exe\";" ^
  "$lnk.Arguments = '\"%~dp0FakeChat.vbs\"';" ^
  "$lnk.WorkingDirectory = '%~dp0';" ^
  "$lnk.IconLocation = '%~dp0assets\icon.ico,0';" ^
  "$lnk.Description = 'Fake Twitch chat for OBS';" ^
  "$lnk.Save()"
if errorlevel 1 (
  echo Could not create the shortcut.
) else (
  echo Created "Fake Chat" on your desktop.
)
timeout /t 3 /nobreak >nul
