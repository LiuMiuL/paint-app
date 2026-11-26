@echo off
rem Double-click: build the paint app and install it on the USB-connected phone.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" -Install
pause
