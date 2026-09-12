@echo off
setlocal
rem MCP output is UTF-8 Chinese; switch console to UTF-8 to avoid mojibake.
chcp 65001 >nul

rem ===================================================================
rem  Topspeed Builder - MCP server launcher (HTTP transport)
rem
rem  Reuses the Electron runtime shipped with this app (via
rem  ELECTRON_RUN_AS_NODE), so no separate Node.js install is needed.
rem
rem  Endpoint : http://<MCP_HOST>:<MCP_PORT>/mcp
rem  Health   : http://<MCP_HOST>:<MCP_PORT>/healthz
rem  Stop     : Ctrl+C
rem
rem  Override before running, e.g.:
rem    set MCP_PORT=4000
rem    set MCP_HOST=0.0.0.0   (exposes to LAN - firewall/risk warning)
rem ===================================================================

set "TOOL_DIR=%~dp0"
set "APP_EXE=%TOOL_DIR%..\Topspeed Builder.exe"
set "NODE_PATH=%TOOL_DIR%..\resources\app.asar\node_modules"
set "ELECTRON_RUN_AS_NODE=1"

if not defined MCP_PORT set "MCP_PORT=3000"
if not defined MCP_HOST set "MCP_HOST=127.0.0.1"

if not exist "%APP_EXE%" (
  echo [topspeed-mcp] Cannot find "Topspeed Builder.exe" in the parent folder.
  echo [topspeed-mcp] Keep this tool folder inside the unpacked app directory.
  exit /b 1
)

echo [topspeed-mcp] starting MCP server on http://%MCP_HOST%:%MCP_PORT%/mcp
echo [topspeed-mcp] press Ctrl+C to stop
echo.

"%APP_EXE%" "%TOOL_DIR%mcp.cjs" %*
exit /b %ERRORLEVEL%
