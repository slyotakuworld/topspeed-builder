@echo off
node --version >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Please install Node.js 22 LTS from https://nodejs.org/
  pause
  exit /b 1
)
rem Remove leftover electron-vite temp config files (created when a build was interrupted)
del /Q electron.vite.config.*.mjs >nul 2>&1
node start.mjs %**
