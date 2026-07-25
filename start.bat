@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    pause
    exit /b 1
)

chcp 65001 >nul
title Claude Agent Monitor
node monitor.js
pause
