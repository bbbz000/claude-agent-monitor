@echo off
rem 诊断模式启动小条（看不见时用：亮底 + DevTools + 日志）。
rem 脚本在 scripts/ 下，工作目录切到工程根（%~dp0 的上一级）。
cd /d "%~dp0.."

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
