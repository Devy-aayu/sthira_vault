@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.12 or newer is required.
  pause
  exit /b 1
)
if not exist node_modules (
  call npm install
  if errorlevel 1 goto :error
)
call npm test
if errorlevel 1 goto :error
call npm run build:installer
if errorlevel 1 goto :error
echo.
echo Installer created in the release folder.
pause
exit /b 0
:error
echo.
echo Build failed.
pause
exit /b 1
