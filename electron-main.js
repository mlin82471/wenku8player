// electron-main.js — Wenku8 Audio Archive 桌面版主进程
// 作用：内置启动 Express 服务 → 用 BrowserWindow 打开 → 提供原生窗口体验
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');
const http = require('http');

// Linux 兼容：禁用 GPU 沙盒隔离（部分 Mesa/旧驱动下会导致渲染进程崩溃）
// 同时禁用硬件加速的 VAAPI（某些 Linux 发行版解码器不完整，会导致花屏）
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('disable-features', 'VaapiVideoDecoder,VaapiVideoEncoder');
  // PipeWire/PulseAudio 音频后端优先（避免 ALSA 直接访问冲突）
  app.commandLine.appendSwitch('enable-features', 'WebRtcPipeWireCapturer');
}

const PORT = 3000;
const URL = 'http://127.0.0.1:' + PORT;

let mainWindow = null;
let serverStarted = false;

/** 启动项目自带的 server.js（Express + 网易云 API） */
function startServer() {
    return new Promise((resolve) => {
        // 已经在跑就不重复启动
        const probe = http.get(URL + '/', () => {
            probe.destroy();
            serverStarted = true;
            resolve(true);
        });
        probe.on('error', () => {
            try {
                require(path.join(__dirname, 'server.js'));
                serverStarted = true;
                // 等端口就绪
                let tries = 0;
                const timer = setInterval(() => {
                    tries++;
                    const p = http.get(URL + '/', () => {
                        clearInterval(timer);
                        p.destroy();
                        resolve(true);
                    });
                    p.on('error', () => {
                        if (tries > 50) { clearInterval(timer); resolve(false); }
                    });
                }, 200);
            } catch (e) {
                console.error('server start failed:', e);
                resolve(false);
            }
        });
        probe.setTimeout(800, () => { probe.destroy(); });
    });
}

async function createWindow() {
    await startServer();

    mainWindow = new BrowserWindow({
        width: 1360,
        height: 880,
        minWidth: 1024,
        minHeight: 680,
        backgroundColor: '#0f1012',
        title: 'Wenku8 Audio Archive',
        icon: path.join(__dirname, 'app.ico'),
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true,
            backgroundThrottling: false,
            // 允许跨域访问 localhost:5274（动效服务）
            allowRunningInsecureContent: false
        }
    });

    Menu.setApplicationMenu(null);
    mainWindow.loadURL(URL);

    // 外链用系统浏览器打开
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http') && !url.includes('127.0.0.1') && !url.includes('localhost')) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
