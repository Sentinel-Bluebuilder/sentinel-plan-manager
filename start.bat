@echo off

REM Auto-elevate to Administrator
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator privileges...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0"
echo Killing port 3003...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3003 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
if not exist node_modules (
    echo Installing dependencies...
    npm install
)
echo Starting Plan Manager on http://localhost:3003
node server.js
pause
