@echo off
chcp 65001 >nul
node --version >nul 2>&1
if errorlevel 1 (
  echo Node.js 未安装或不在 PATH 中。
  echo 请从 https://nodejs.org/ 安装 Node.js 22 LTS
  pause
  exit /b 1
)
if "%~1"=="" (
  echo 可直接把图片文件拖进本窗口自动填入路径。
  set /p "IMG=请输入自定义图标图片路径（PNG/JPG/WebP，直接回车则使用内置默认图案）: "
) else (
  set "IMG=%~1"
)
if "%IMG%"=="" (
  node assets\generate-icon.mjs
) else (
  node assets\generate-icon.mjs "%IMG%"
)
if errorlevel 1 (
  echo 图标生成失败。
  pause
  exit /b 1
)
echo 完成。图标已输出到 assets\icon.png / icon.ico / icon.icns
