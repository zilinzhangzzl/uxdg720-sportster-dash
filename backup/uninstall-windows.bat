@echo off
rem Double-click to stop the automatic GitHub backup scheduled task
powershell -NoProfile -Command "Unregister-ScheduledTask -TaskName 'UXDG720 Sportster Backup' -Confirm:$false; if ($?) { Write-Host 'Automatic backup task removed.' }"
pause
