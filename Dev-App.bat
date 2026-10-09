@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules" (
  call npm install --no-audit --no-fund
  if errorlevel 1 pause & exit /b 1
)

call npm run dev
if errorlevel 1 pause
