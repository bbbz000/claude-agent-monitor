@echo off
rem 一键启动任务栏小条（首次会自动 npm install）。
rem 脚本在 scripts/ 下，工作目录切到工程根（%~dp0 的上一级）。
cd /d "%~dp0.."

rem --nopause：由 start-bar-hidden.vbs（隐藏窗口）传入，出错时不 pause（隐藏窗口下 pause 会永久卡死）
set "NOPAUSE="
if /i "%~1"=="--nopause" set "NOPAUSE=1"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    if not defined NOPAUSE pause
    exit /b 1
)

if not exist "node_modules\electron" (
    echo [INFO] Installing electron for the first time, please wait...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        if not defined NOPAUSE pause
        exit /b 1
    )
)

echo [INFO] Starting taskbar bar...
rem 隐藏窗口启动（.vbs）：用 start /b 让 electron 脱离本批处理独立运行，
rem 使 .bat 立刻返回、.vbs 不必挂等 electron 整个生命周期。
rem 直接双击（无 --nopause）：沿用 call，保持窗口在前台便于看日志。
if defined NOPAUSE (
    start "" /b cmd /c npm run bar
    exit /b 0
)
call npm run bar
