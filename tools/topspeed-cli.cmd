@echo off
setlocal
rem CLI output is UTF-8 Chinese; switch console to UTF-8 to avoid mojibake.
chcp 65001 >nul

rem ===================================================================
rem  Topspeed Builder - CLI launcher
rem
rem  Reuses the Electron runtime shipped with this app (via
rem  ELECTRON_RUN_AS_NODE), so no separate Node.js install is needed.
rem  Dependencies (sharp / fs-extra / MCP SDK) are resolved from the
rem  bundled app.asar through NODE_PATH.
rem
rem  Example:
rem    topspeed-cli.cmd --project D:\proj --name heroes --type character ^
rem      --count 6 --description "cyberpunk hero icons" --size 1024x1024
rem
rem  Double-click with no arguments to print the full help.
rem ===================================================================

set "TOOL_DIR=%~dp0"
set "APP_EXE=%TOOL_DIR%..\Topspeed Builder.exe"
set "NODE_PATH=%TOOL_DIR%..\resources\app.asar\node_modules"
set "ELECTRON_RUN_AS_NODE=1"

if not exist "%APP_EXE%" (
  echo [topspeed-cli] Cannot find "Topspeed Builder.exe" in the parent folder.
  echo [topspeed-cli] Keep this tool folder inside the unpacked app directory.
  exit /b 1
)

if "%~1"=="" (
  "%APP_EXE%" "%TOOL_DIR%cli.cjs" --help
  echo.
  pause
  exit /b 0
)

"%APP_EXE%" "%TOOL_DIR%cli.cjs" %*
exit /b %ERRORLEVEL%
