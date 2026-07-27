@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    pause
    exit /b 1
)

if not exist "node_modules\electron" (
    echo [INFO] Installing electron for the first time, please wait...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

echo [DIAG] Starting taskbar bar in DIAGNOSTIC mode...
echo [DIAG]  - transparency OFF, bright magenta background (so the bar is impossible to miss)
echo [DIAG]  - DevTools open
echo [DIAG]  - window position printed below
echo.
call npm run bar:diag

echo.
echo [DIAG] Bar exited. Copy the [bar] ... lines above and send them back.
pause
