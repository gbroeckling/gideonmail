@echo off
echo Creating GideonMail desktop shortcut...
powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath('Desktop'), 'GideonMail.lnk')); $s.TargetPath = '%~dp0node_modules\electron\dist\electron.exe'; $s.Arguments = '.'; $s.WorkingDirectory = '%~dp0'; $s.IconLocation = '%~dp0assets\icon.ico,0'; $s.Description = 'GideonMail Email Client'; $s.Save()"
echo Shortcut created on Desktop!
pause
