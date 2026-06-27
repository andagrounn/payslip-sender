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

:: Check for updates from GitHub
where git >nul 2>nul
if %errorlevel% equ 0 (
    if exist ".git" (
        echo Checking for updates...
        git pull origin main 2>nul
        if %errorlevel% equ 0 (
            echo Up to date.
        ) else (
            echo Could not check for updates. Continuing...
        )
        echo.
    )
)

:: Install or update dependencies
if not exist "node_modules" (
    echo Installing dependencies...
    npm install --production
    echo.
) else (
    npm install --production 2>nul
)

echo Starting Payslip Sender...
node server.js
pause
