Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
WshShell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)

' Pull latest updates from GitHub, then install deps and start server
' /c runs the commands and closes the hidden cmd window when node exits
WshShell.Run "cmd /c git pull origin main 2>nul & npm install --production 2>nul & node server.js", 0, False
