#!/bin/bash
set -e
PKG_DIR="/tmp/wenku8_deb_package"
rm -rf "$PKG_DIR" /tmp/wenku8_deb_package.deb
mkdir -p "$PKG_DIR/DEBIAN"
mkdir -p "$PKG_DIR/opt/wenku8-audio-archive"
mkdir -p "$PKG_DIR/usr/bin"
mkdir -p "$PKG_DIR/usr/share/applications"
mkdir -p "$PKG_DIR/usr/share/icons/hicolor/256x256/apps"

cp -r /mnt/d/linhr/Documents/wenku8-netease-player/dist/linux-unpacked/* "$PKG_DIR/opt/wenku8-audio-archive/"
chmod 755 "$PKG_DIR/opt/wenku8-audio-archive/wenku8-netease-player"
ln -sf "/opt/wenku8-audio-archive/wenku8-netease-player" "$PKG_DIR/usr/bin/wenku8-audio-archive"

cat <<EOF > "$PKG_DIR/usr/share/applications/wenku8-audio-archive.desktop"
[Desktop Entry]
Name=Wenku8 Audio Archive
Comment=3D 立体白盒磁带书架 × 极简音乐播放器
Exec=/usr/bin/wenku8-audio-archive %U
Icon=wenku8-audio-archive
Type=Application
StartupNotify=true
Categories=AudioVideo;Audio;Player;
EOF

if [ -f "/mnt/d/linhr/Documents/wenku8-netease-player/app-linux.png" ]; then
  cp "/mnt/d/linhr/Documents/wenku8-netease-player/app-linux.png" "$PKG_DIR/usr/share/icons/hicolor/256x256/apps/wenku8-audio-archive.png"
fi

cat <<EOF > "$PKG_DIR/DEBIAN/control"
Package: wenku8-audio-archive
Version: 1.0.0
Section: sound
Priority: optional
Architecture: amd64
Maintainer: Wenku8 Archive <wenku8@example.com>
Depends: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils
Description: 3D 立体白盒磁带书架 × 极简音乐播放器
 Wenku8 Audio Archive 3D Music Player with NetEase Cloud Music support.
EOF

chmod 755 "$PKG_DIR/DEBIAN"
chmod 644 "$PKG_DIR/DEBIAN/control"

dpkg-deb -Zxz --build "$PKG_DIR" /mnt/d/linhr/Documents/wenku8-netease-player/dist/wenku8-audio-archive_1.0.0_amd64.deb
rm -rf "$PKG_DIR"
echo "DEB BUILD SUCCESSFUL"
