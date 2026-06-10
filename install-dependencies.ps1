$ErrorActionPreference = "Stop"

function Test-Command {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

$RootPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerPath = Join-Path $RootPath "server"

Write-Host "Fast Aria2 Streamer - dependency installer"
Write-Host "Project path: $RootPath"
Write-Host ""

if (-not (Test-Command "node")) {
    Write-Host "Node.js was not found in PATH."
    Write-Host "Install Node.js LTS from https://nodejs.org/ and run this script again."
    exit 1
}

if (-not (Test-Command "npm")) {
    Write-Host "npm was not found in PATH."
    Write-Host "Install Node.js LTS from https://nodejs.org/ and run this script again."
    exit 1
}

if (-not (Test-Command "aria2c")) {
    Write-Host "aria2c was not found in PATH."

    if (Test-Command "winget") {
        Write-Host "Trying to install aria2 with winget..."
        winget install --id aria2.aria2 -e --accept-source-agreements --accept-package-agreements
    }
    elseif (Test-Command "choco") {
        Write-Host "Trying to install aria2 with Chocolatey..."
        choco install aria2 -y
    }
    else {
        Write-Host "Install aria2 manually and make sure aria2c.exe is available in PATH."
        Write-Host "Download page: https://aria2.github.io/"
        exit 1
    }
}

if (-not (Test-Path $ServerPath)) {
    Write-Host "Server folder was not found: $ServerPath"
    exit 1
}

Set-Location $ServerPath
Write-Host "Installing Node.js dependencies..."
npm install

Write-Host ""
Write-Host "Dependency installation completed."
Write-Host "Run start-server.bat from the project root to start the local server."
