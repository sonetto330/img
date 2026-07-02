@echo off
chcp 65001 >nul
cd /d %~dp0

if not exist .env (
  echo 还没有 .env 文件，先把 .env.example 复制成 .env 并设置口令
  pause
  exit /b 1
)

if not exist node_modules (
  echo 第一次启动，先安装依赖...
  call npm install
)

npm run start
pause
