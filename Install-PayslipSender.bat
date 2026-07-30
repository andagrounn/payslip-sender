@echo off
setlocal EnableDelayedExpansion
title Payslip Sender - Installer

:: ============================================================
::   PAYSLIP SENDER - One-Click Windows Installer
::   Quest Security Services
::
::   Download this single file and double-click it. It will:
::     1. Install Node.js and Git (if missing) via winget
::     2. Download the app to your Desktop
::     3. Install the app's dependencies
::     4. Create a Desktop shortcut
::     5. Start the app
:: ============================================================

set "REPO=https://github.com/andagrounn/payslip-sender.git"
set "APPDIR=%USERPROFILE%\Desktop\payslip-sender"
set "NODEDIR=%ProgramFiles%\nodejs"
set "GITDIR=%ProgramFiles%\Git\cmd"

:: ---- Elevate to Administrator (needed to install Node/Git) --
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator permission...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo.
echo ============================================================
echo    Installing Payslip Sender
echo ============================================================
echo.

:: ---- Make sure winget exists --------------------------------
where winget >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] "winget" was not found on this PC.
    echo     Please update Windows ^(Microsoft Store -^> App Installer^)
    echo     or use the manual INSTALL GUIDE instead.
    echo.
    pause
    exit /b 1
)

:: ---- Node.js -------------------------------------------------
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [1/5] Installing Node.js LTS... this can take a few minutes.
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
) else (
    echo [1/5] Node.js already installed.
)
:: Add Node to this session's PATH so we can use it right away
if exist "%NODEDIR%\node.exe" set "PATH=%NODEDIR%;%PATH%"

:: ---- Git -----------------------------------------------------
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo [2/5] Installing Git... this can take a few minutes.
    winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
) else (
    echo [2/5] Git already installed.
)
:: Add Git to this session's PATH so we can use it right away
if exist "%GITDIR%\git.exe" set "PATH=%GITDIR%;%PATH%"

:: ---- Verify both tools are now callable ---------------------
where node >nul 2>&1 || (
    echo [!] Node.js was installed but is not on PATH yet.
    echo     Please RESTART your computer and run this installer again.
    echo. & pause & exit /b 1
)
where git >nul 2>&1 || (
    echo [!] Git was installed but is not on PATH yet.
    echo     Please RESTART your computer and run this installer again.
    echo. & pause & exit /b 1
)

:: ---- Download or update the app -----------------------------
set "LAUNCHER=%APPDIR%\PayslipSender.bat"

:: A leftover folder that isn't a healthy git clone (e.g. an interrupted
:: earlier install) is wiped so we start clean instead of failing to update.
if exist "%APPDIR%\.git" (
    git -C "%APPDIR%" rev-parse --is-inside-work-tree >nul 2>&1 || rmdir /s /q "%APPDIR%"
)

if exist "%APPDIR%\.git" (
    echo [3/5] App already on Desktop - updating to latest...
    git -C "%APPDIR%" fetch origin main && git -C "%APPDIR%" reset --hard origin/main
) else (
    echo [3/5] Downloading the app to your Desktop...
    git clone "%REPO%" "%APPDIR%"
)

:: Safety net: if the app files still aren't there, force one clean re-download.
if not exist "%LAUNCHER%" (
    echo [!] App files missing - retrying with a clean download...
    rmdir /s /q "%APPDIR%" 2>nul
    git clone "%REPO%" "%APPDIR%"
)
if not exist "%LAUNCHER%" (
    echo [!] Could not download the app. Check your internet connection
    echo     and run this installer again.
    echo. & pause & exit /b 1
)

:: ---- Install dependencies -----------------------------------
echo [4/5] Installing app dependencies... this can take a few minutes.
call npm install --omit=dev --prefix "%APPDIR%"

:: ---- Create Desktop shortcut --------------------------------
echo [5/5] Creating Desktop shortcut...
set "SHORTCUT=%USERPROFILE%\Desktop\Payslip Sender.lnk"
set "TARGET=%APPDIR%\PayslipSender.vbs"
powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%SHORTCUT%');" ^
  "$s.TargetPath='%TARGET%';" ^
  "$s.WorkingDirectory='%APPDIR%';" ^
  "$s.Save()"

echo.
echo ============================================================
echo    Done! Payslip Sender is installed.
echo    A "Payslip Sender" shortcut is on your Desktop.
echo    Starting the app now...
echo ============================================================
echo.

:: ---- Launch the app -----------------------------------------
if exist "%LAUNCHER%" (
    start "" "%LAUNCHER%"
) else (
    echo [!] Could not find the app launcher to start it.
    echo     Try running this installer again.
    pause
)

timeout /t 4 >nul
exit /b 0
