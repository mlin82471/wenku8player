#!/bin/bash
# Linux deb 安装后脚本：更新图标缓存与 MIME 数据库
update-desktop-database /usr/share/applications 2>/dev/null || true
gtk-update-icon-cache /usr/share/icons/hicolor 2>/dev/null || true
