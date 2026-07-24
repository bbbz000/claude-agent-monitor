@echo off
chcp 65001 >nul
title Claude Agent Monitor

echo ╔══════════════════════════════════════╗
echo ║   Claude Agent Monitor - Launcher   ║
echo ╚══════════════════════════════════════╝
echo.

cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERR] Node.js not found, please install Node.js first.
    pause
    exit /b 1
)

if not exist node_modules (
    echo [INFO] Installing dependencies...
    npm install
    echo.
)

echo [OK] Starting watcher...
echo.
node watch.js
pause
