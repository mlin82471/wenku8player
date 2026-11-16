@echo off
chcp 65001 >nul
echo 正在停止 Wenku8 播放器后台服务...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3100" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1
echo 播放器后台服务已完全退出。
timeout /t 2 >nul
