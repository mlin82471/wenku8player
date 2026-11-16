# 📼 Wenku8 Audio Archive × 网易云音乐

3D 立体白盒磁带书架 × 深色极简播放器 —— 在原有纯前端 Demo 基础上接入
**[Binaryify/NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)**（开源网易云音乐 API 服务），
支持**扫码登录、同步歌单、在线播放真实歌曲、歌词同步、搜索、红心**。

## 快速开始

```bash
npm install
npm start
```

打开 <http://localhost:3000> 即可：

- 未登录 = 原版「典藏 Demo」体验（10 盒程序化封面 + WebAudio 合成旋律）
- 点击右上角 **☁️** → 打开「网易云音乐」APP 扫码登录
- 登录后顶部出现你的**歌单 chips**（喜欢的音乐 / 各歌单 / 每日推荐），点击即把歌单装进 3D 书架
- 点击盒子 → 深色播放页 → **播放真实音频**，进度条 / 歌词 / 热评全部真实同步

> 端口可通过环境变量调整：`WEB_PORT=8080 API_PORT=3100 npm start`

## 功能清单

| 功能 | 说明 |
|---|---|
| 扫码登录 | `/login/qr/key → create → check` 轮询，cookie 保存在浏览器 localStorage |
| 我的歌单 | `/user/playlist`，点击 chip 载入 `/playlist/track/all` 到书架 |
| 歌单分批加载 | **一次只装 20 首**（可调 `PLAYLIST_BATCH`），滑到末尾自动续载下一批，千首大歌单不卡顿 |
| 渲染窗口化 | 只挂载滚动位置 ±22 个盒体（500 首歌单 DOM 恒定 ≈45 个），拖动每帧开销恒定 |
| 每日推荐 | `/recommend/songs`（需登录） |
| 在线播放 | `/song/url/v1`（exhigh 优先，自动降级 standard），真实 `<audio>` 播放、播完自动下一首 |
| 歌词同步 | `/lyric` LRC 解析，主/副双行滚动，支持翻译歌词，点歌词跳转 |
| 热门乐评 | `/comment/music`，在「笔记」抽屉中展示 |
| 搜索 | 书架搜索框：Demo 源本地过滤；网易云源远程 `/cloudsearch` |
| 红心同步 | 播放页红心按钮 → `/like` 同步到云盘 |
| 系统媒体控制 | Media Session API：锁屏/媒体键可播放暂停切歌 |
| 本地导入 | 「＋」导入本地音频文件，自动生成立体白盒 |
| Demo 模式 | 无后端/未登录时完整保留原始 Demo 体验（合成旋律播放） |

## 架构

```
wenku8-netease-player/
├── server.js              # 入口：静态前端(:3000) + 反向代理 NCM API(:3100)
├── package.json
├── README.md
└── public/
    └── index.html         # 自包含单文件前端（样式/脚本全部内联，含后端文件导出面板）
```

- **前端零框架、零构建**：单文件 `public/index.html`，双击即可跑 Demo 模式
- **文件导出**：页面右上角 ⬇️ 按钮可导出 `server.js / package.json / README.md`，
  与 `index.html` 一起放进 `wenku8-netease-player/public/` 即可完整部署
- **后端**复用开源 `NeteaseCloudMusicApi`（v4.32），含官方文档页：`http://localhost:3100/docs`
- 前端内部通过 `window.WK` 桥将网易云歌单映射为与典藏 Demo 同构的 book 对象
 （`picUrl / ncmId / audioUrl / lyrics / comments`），书架物理引擎与播放器核心零侵入

## 接口说明（前端实际调用）

| 场景 | 接口 |
|---|---|
| 二维码登录 | `GET /login/qr/key`、`/login/qr/create?qrimg=true`、`/login/qr/check`（800 过期 / 801 等待 / 802 已扫 / 803 成功） |
| 账号 | `GET /user/account`、`/user/playlist?uid=` |
| 歌单曲目 | `GET /playlist/track/all?id=&limit=1000` |
| 每日推荐 | `GET /recommend/songs` |
| 搜索 | `GET /cloudsearch?keywords=&limit=30` |
| 播放直链 | `GET /song/url/v1?id=&level=exhigh`（失败自动降级 `standard`） |
| 歌词 | `GET /lyric?id=`（`lrc` + `tlyric` 翻译） |
| 热评 | `GET /comment/music?id=&limit=12` |
| 红心 | `GET /like?id=&like=true` |

登录态通过 `cookie` 查询参数携带（NCM API 标准做法），仅保存在你自己浏览器的
localStorage 中，不会经过任何第三方。

## 已知限制

- **音质与版权**：`exhigh/lossless` 等高音质在未登录或非 VIP 时可能返回 `-460 风控`
  或空 URL，前端会自动降级到 `standard`；灰色歌曲（无版权）无法播放属正常现象
- **会员歌曲**：VIP 试听限制由网易云账号权益决定，本项目不做任何破解
- 请控制请求频率（内置 2 分钟服务端缓存 + 时间戳绕过策略），勿用于商业用途

## 前端优化点（相对原始单文件版）

1. **结构**：83KB 单文件升级为自包含 125KB 单文件（内联全部样式/脚本 + 内嵌后端文件导出面板），双击即用、随取随走
2. **真实音频链路修复**：本地/在线音频播完自动切下一首（原来 `loop=true` 死循环）；
   以真实音频时长校准进度条
3. **真实封面**：网易云歌曲显示专辑封面（`<img>` 懒加载），Demo 歌曲保留程序化 SVG 封面
4. **Media Session**：系统媒体键 / 锁屏控件可播放、暂停、切歌、拖进度
5. **交互增强**：搜索防抖、toast 全局提示、错误兜底、滚轮/触控板翻盒（原有物理引擎保留）
6. **渲染提示**：`will-change` / `backface-visibility` 合成层优化，书架拖动更顺滑
7. **资源体积**：封面 SVG 按需生成 + 按用途缓存、歌词/秒数变化才写 DOM（保留原有 rAF 空闲休眠机制）
8. **大歌单防卡顿**（参考网易云 iPad 版封面流的回收策略）：
   - 数据层分批加载：`playlist/track/all?limit=20&offset=N`，滑近末尾自动续载，带「已加载 x/y」提示
   - 渲染层窗口化回收：书架只挂载焦点附近 ±22 盒，窗口漂移 ≥3 才重建 DOM
   - 封面懒加载渐显：模糊占位 → 清晰（`blur(10px) → none` 过渡），隐藏加载延迟
   - 播放页氛围光晕：跟随歌曲主色调的柔和径向渐变，0.7s 平滑过渡

## 致谢

- [Binaryify/NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) — 网易云音乐 API
- 原始设计：Wenku8 Audio Archive 立体白盒磁带书架概念
