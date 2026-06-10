@echo off
setlocal

cd /d "%~dp0server"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found in PATH.
    echo Install Node.js LTS and run install-dependencies.ps1 first.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Node dependencies were not found.
    echo Running npm install...
    npm install
    if errorlevel 1 (
        echo npm install failed.
        pause
        exit /b 1
    )
)

node .\server.js
pause
