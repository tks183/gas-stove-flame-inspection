@echo off
cd /d "%~dp0"

set "NODE26=%NVM_HOME%\installs\v26.13.1\node.exe"
set "NPM26=%NVM_HOME%\installs\v26.13.1\node_modules\npm\bin\npm-cli.js"

if not exist "%NODE26%" (
  echo Node.js 26.13.1 was not found in NVM_HOME.
  echo Please check your nvm installation or edit 启动.bat.
  pause
  exit /b 1
)

if not exist "%NPM26%" (
  echo npm for Node.js 26.13.1 was not found.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies with Node.js 26.13.1...
  "%NODE26%" "%NPM26%" install
  if errorlevel 1 (
    echo Failed to install dependencies.
    pause
    exit /b 1
  )
)

echo Starting gas stove ignition inspection system with Node.js 26.13.1...
echo Close this window to stop the service.

start "" /b powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "for ($i=0; $i -lt 120; $i++) { try { $r = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3000/api/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { Start-Process 'http://localhost:3000'; break } } catch { Start-Sleep -Milliseconds 500 } }"

"%NODE26%" "%NPM26%" start
pause
