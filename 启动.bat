@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist node_modules (
  echo 正在安装依赖，请稍候...
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

start "" http://localhost:3000
echo 正在启动卡式炉试火实时检测系统...
echo 关闭此窗口即可停止服务。
call npm start
pause
