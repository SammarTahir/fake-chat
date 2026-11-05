' Fake Chat desktop launcher (what the desktop shortcut runs).
' Starts the server hidden, then opens the app in its own window (Chrome or
' Edge app mode: no tabs or address bar). Speech recognition only works in a
' Chromium browser, which is why the window is Chrome underneath.
' The server exits by itself once the app window is closed.
Option Explicit

Dim sh, fso, dir, port, url
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir

port = ReadPort()
url = "http://localhost:" & port

If Not ServerUp() Then
  If Not fso.FolderExists(dir & "\logs") Then fso.CreateFolder dir & "\logs"
  If Not fso.FolderExists(dir & "\node_modules\ws") Then
    sh.Run "cmd /c npm install --no-audit --no-fund > logs\install.log 2>&1", 0, True
  End If
  sh.Run "cmd /c node server.js --app > logs\server.log 2>&1", 0, False
  Dim i
  For i = 1 To 40
    WScript.Sleep 500
    If ServerUp() Then Exit For
  Next
  If Not ServerUp() Then
    MsgBox "Fake Chat could not start." & vbCrLf & vbCrLf & _
      "Make sure Node.js is installed (nodejs.org), then try again." & vbCrLf & _
      "Details: " & dir & "\logs\server.log", vbCritical, "Fake Chat"
    WScript.Quit 1
  End If
End If

OpenWindow url & "/app"

Sub OpenWindow(target)
  Dim args
  args = " --app=" & target & " --window-size=1280,860"
  On Error Resume Next
  sh.Run "chrome" & args, 1, False
  If Err.Number <> 0 Then
    Err.Clear
    sh.Run "msedge" & args, 1, False
  End If
  If Err.Number <> 0 Then
    On Error GoTo 0
    MsgBox "Fake Chat needs Google Chrome or Microsoft Edge for the mic." & vbCrLf & _
      "Open " & target & " in one of them.", vbExclamation, "Fake Chat"
  End If
End Sub

Function ServerUp()
  Dim http
  ServerUp = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 1000, 1000
  http.Open "GET", url & "/health", False
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 Then ServerUp = True
  End If
  Err.Clear
End Function

Function ReadPort()
  Dim f, text, re, m
  ReadPort = "8080"
  If Not fso.FileExists(dir & "\config.json") Then Exit Function
  Set f = fso.OpenTextFile(dir & "\config.json", 1)
  text = f.ReadAll
  f.Close
  Set re = New RegExp
  re.Pattern = """port""\s*:\s*(\d+)"
  Set m = re.Execute(text)
  If m.Count > 0 Then ReadPort = m(0).SubMatches(0)
End Function
