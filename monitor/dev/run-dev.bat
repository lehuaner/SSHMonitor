@echo off
rem ====== SSHMonitor 前端本地开发（mock 数据 + 局域网访问） ======
rem 用法: run-dev.bat            默认端口 8090
rem       run-dev.bat 8123       指定端口
chcp 65001 >nul
cd /d %~dp0
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node，请先安装 Node.js 并加入 PATH
  pause
  exit /b 1
)
if "%~1"=="" (
  node mock-server.mjs
) else (
  node mock-server.mjs --port %1
)
pause
