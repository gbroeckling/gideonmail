# Create GideonMail shortcut on Desktop and optionally pin to taskbar
$electronPath = Join-Path $PSScriptRoot "node_modules\electron\dist\electron.exe"
$workDir = $PSScriptRoot

# Desktop shortcut
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "GideonMail.lnk"

$ws = New-Object -ComObject WScript.Shell
$shortcut = $ws.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $electronPath
$shortcut.Arguments = "."
$shortcut.WorkingDirectory = $workDir
$shortcut.Description = "GideonMail Email Client"
# Use electron's icon since we don't have a .ico file
$shortcut.IconLocation = "$electronPath,0"
$shortcut.Save()

Write-Host "Desktop shortcut created: $shortcutPath"
Write-Host ""
Write-Host "To pin to taskbar:"
Write-Host "  1. Double-click the shortcut on your Desktop to launch GideonMail"
Write-Host "  2. Right-click the GideonMail icon in the taskbar"
Write-Host "  3. Click 'Pin to taskbar'"
Write-Host ""
Write-Host "Done!"
