Option Explicit
Dim shell, files, root, command, result, logFile
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
command = Chr(34) & shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe" & Chr(34) & " -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File " & Chr(34) & root & "\start.ps1" & Chr(34)
Do
  On Error Resume Next
  result = shell.Run(command, 0, True)
  If Err.Number <> 0 Or result <> 0 Then
    Set logFile = files.OpenTextFile(root & "\guard.log", 8, True)
    logFile.WriteLine CStr(Now) & " Penghubung berhenti; mencoba menjalankan kembali."
    logFile.Close
  End If
  Err.Clear
  On Error GoTo 0
  WScript.Sleep 5000
Loop
