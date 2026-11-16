@echo off
chcp 65001 >nul
title Wenku8 Audio Archive

REM 关键：某些开发环境会设置 ELECTRON_RUN_AS_NODE=1，
REM 那会让 Electron 以纯 Node 模式运行，不弹窗口。这里强制清掉。
set ELECTRON_RUN_AS_NODE=
set NODE_OPTIONS=

set EXE=%~dp0dist\win-unpacked\Wenku8AudioArchive.exe

if not exist "%EXE%" (
  echo.
  echo  [x] 未找到打包后的程序：
  echo      %EXE%
  echo.
  echo  请先在项目目录执行：
  echo      npx electron-builder --win --x64
  echo.
  pause
  exit /b 1
)

start "" "%EXE%"
exit /b 0
