@echo off
rem 一键启动终端面板。脚本在 scripts/ 下，工作目录切到工程根（%~dp0 的上一级）。
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    pause
    exit /b 1
)

chcp 65001 >nul
title Agent Monitor
node monitor.js
pause
