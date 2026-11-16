#!/bin/bash
set -e

echo "=================================================="
echo " Wenku8 Audio Archive - Linux 打包脚本 (Tauri v2) "
echo "=================================================="

# 1. 检查并安装 Linux 系统编译依赖
echo ">> 检查并安装编译依赖 (需要 sudo 权限)..."
if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y \
        build-essential \
        curl \
        wget \
        file \
        libssl-dev \
        libgtk-3-dev \
        libwebkit2gtk-4.1-dev \
        libayatana-appindicator3-dev \
        librsvg2-dev \
        libxdo-dev \
        squashfs-tools
fi

# 2. 检查 Rust
if ! command -v cargo >/dev/null 2>&1; then
    echo ">> 未检测到 Rust，正在通过 rustup 安装..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
fi

# 3. 检查 Node.js & npm
if ! command -v npm >/dev/null 2>&1; then
    echo ">> 未检测到 Node.js，正在安装..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# 4. 定位工程目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT_DIR/../wenku8-tauri-export"

if [ ! -d "$BUILD_DIR" ]; then
    BUILD_DIR="$ROOT_DIR"
fi

echo ">> 目标构建工程路径: $BUILD_DIR"
cd "$BUILD_DIR"

# 5. 清理旧缓存目录，防止资源占用冲突
rm -rf src-tauri/target/release/public src-tauri/target/debug/public

# 6. 安装前端依赖并执行 Tauri 生产构建
npm install --save-dev @tauri-apps/cli@^2.0.0
npx @tauri-apps/cli build

# 7. 归档安装包至 dist/ 目录
DIST_DIR="$ROOT_DIR/dist"
mkdir -p "$DIST_DIR"

BUNDLE_DIR="$BUILD_DIR/src-tauri/target/release/bundle"

if [ -d "$BUNDLE_DIR/deb" ]; then
    cp "$BUNDLE_DIR/deb/"*.deb "$DIST_DIR/" 2>/dev/null || true
fi

if [ -d "$BUNDLE_DIR/appimage" ]; then
    cp "$BUNDLE_DIR/appimage/"*.AppImage "$DIST_DIR/" 2>/dev/null || true
fi

echo ">> Linux 版本构建完成！安装包输出路径："
ls -la "$DIST_DIR"/*.deb "$DIST_DIR"/*.AppImage 2>/dev/null || true
