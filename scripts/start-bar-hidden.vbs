' start-bar-hidden.vbs -- launch the taskbar bar with no console window.
' Double-click this file: it runs start-bar.bat in a hidden window, so no
' black console box ever appears. First-time dependency install also runs
' silently in the background.
'
' How it works: WshShell.Run arg2 = 0 hides the window; arg3 = True waits
' for the batch to return so we can read its exit code -- a visible message
' box is shown ONLY on failure (non-zero). --nopause tells the .bat not to
' pause on error (pause would hang forever inside a hidden window).
'
' NOTE: keep this file ASCII-only. cscript/wscript parse .vbs as the system
' ANSI codepage, so non-ASCII comments can corrupt parsing.
' start-bar.bat lives in the same folder (scripts/) as this script.

Dim shell, fso, here, bat, rc
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
bat = here & "\start-bar.bat"

If Not fso.FileExists(bat) Then
    MsgBox "start-bar.bat not found: " & bat, vbCritical, "Claude Agent Monitor"
    WScript.Quit 1
End If

' 0 = hidden window; True = wait for return (to read exit code).
rc = shell.Run("cmd /c """"" & bat & """ --nopause""", 0, True)

If rc <> 0 Then
    MsgBox "Launch failed (exit code " & rc & ")." & vbCrLf & _
           "Double-click start-bar.bat to see the detailed error.", _
           vbCritical, "Claude Agent Monitor"
End If
