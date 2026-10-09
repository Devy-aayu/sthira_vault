@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules" (
  call npm install --no-audit --no-fund
  if errorlevel 1 pause & exit /b 1
)

call npm run test
if errorlevel 1 pause & exit /b 1

call npm run build:portable
if errorlevel 1 pause & exit /b 1

echo.
echo Portable app created in the release folder.
pause
