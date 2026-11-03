@echo off
rem Double-click to set up automatic GitHub backup (runs setup-windows.ps1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-windows.ps1"
