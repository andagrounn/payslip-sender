@echo off
title Payslip Sender
cd /d "%~dp0"

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Node.js is not installed.
    echo Please download and install it from https://nodejs.org
    pause
    exit /b 1
)

:: Install dependencies if needed
if not exist "node_modules" (
    echo Installing dependencies...
    npm install --production
    echo.
)

echo Starting Payslip Sender...
node server.js
pause
