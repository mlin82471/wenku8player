/**
 * server.js — Wenku8 Audio Archive × 网易云音乐
 *
 * 架构（参考 YesPlayMusic 等开源播放器的标准做法）：
 *   ┌─ :3000  前端（public/）+ 反向委托 ─────────────────────────┐
 *   │   静态资源优先命中 public/；其余请求全部交给 NCM API 应用  │
 *   └─ :3100  NeteaseCloudMusicApi（Binaryify 开源项目）─────────┘
 *       登录 / 歌单 / 播放直链 / 歌词 / 搜索 / 评论 全部接口
 *
 * 启动：npm start   （或 node server.js）
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const { serveNcmApi } = require('NeteaseCloudMusicApi');

const WEB_PORT = Number(process.env.WEB_PORT || 3000);
const API_PORT = Number(process.env.API_PORT || 3100);

async function main() {
  // 与官方 app.js 一致：确保 anonymous_token 占位文件存在，并尝试刷新
  const tokenFile = path.join(os.tmpdir(), 'anonymous_token');
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, '', 'utf-8');
  try {
    const generateConfig = require('NeteaseCloudMusicApi/generateConfig');
    await generateConfig();
  } catch (_) { /* 离线环境下跳过，不影响核心接口 */ }

  // 1) 网易云 API 服务（含官方文档页 /docs、/home.html 等，可直连调试）
  await serveNcmApi({ port: API_PORT, host: '127.0.0.1', checkVersion: false });

  // 2) 前端：静态资源优先，未命中的路径（API / 文档）代理到 NCM API 端口
  const web = express();
  web.use(express.static(path.join(__dirname, 'public')));

// ★ 音频同源代理：把跨域音乐转成同源，Web Audio 才能分析真实频谱
web.get('/audio-proxy', (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).send('missing url');
  let u;
  try { u = new URL(raw); } catch (_) { return res.status(400).send('bad url'); }
  if (!/^https?:$/.test(u.protocol)) return res.status(400).send('bad protocol');
  const allowed = /(^|\.)(music\.126\.net|music\.163\.com|126\.net|163\.com|127\.net|netease\.com)$/i.test(u.hostname);
  if (!allowed) return res.status(403).send('host not allowed');
  const fwdHeaders = {};
  if (req.headers.range) fwdHeaders.range = req.headers.range;
  const mod = u.protocol === 'https:' ? require('https') : require('http');
  const proxyReq = mod.request(raw, { method: 'GET', headers: fwdHeaders }, (proxyRes) => {
    res.status(proxyRes.statusCode || 200);
    ['content-type','content-length','content-range','accept-ranges','cache-control','etag','last-modified'].forEach((h) => {
      if (proxyRes.headers[h]) res.setHeader(h, proxyRes.headers[h]);
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => { try { res.status(502).end(); } catch (_) {} });
  req.on('close', () => proxyReq.destroy());
  proxyReq.end();
});
  web.use((req, res) => {
    const target = `http://127.0.0.1:${API_PORT}${req.originalUrl}`;
    const headers = { ...req.headers, host: `127.0.0.1:${API_PORT}` };
    const proxyReq = require('http').request(target, { method: req.method, headers }, (proxyRes) => {
      res.status(proxyRes.statusCode);
      res.set(proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => res.status(502).json({ code: -1, message: 'NCM API 服务不可用' }));
    if (req.method === 'POST' || req.method === 'PUT') req.pipe(proxyReq);
    else proxyReq.end();
  });

  web.listen(WEB_PORT, () => {
    console.log('');
    console.log('  📼 Wenku8 Audio Archive × 网易云音乐');
    console.log(`     播放器页面    →  http://localhost:${WEB_PORT}`);
    console.log(`     NCM API 直连  →  http://localhost:${API_PORT} （接口调试 / 文档）`);
    console.log('');
  });
}

main().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});
