@echo off
node --version >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Please install Node.js 22 LTS from https://nodejs.org/
  pause
  exit /b 1
)
node make-icons.mjs %*
if errorlevel 1 (
  echo Icon generation failed.
  pause
  exit /b 1
)
echo Done. Output paths are shown above.
pause
