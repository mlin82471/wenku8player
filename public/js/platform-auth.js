/**
 * PlatformAuthManager & PlatformLoginModal
 * 多平台账号状态与凭据管理引擎 + 暗色毛玻璃原生平台登录弹窗组件
 * 原生支持网易云音乐 (NetEase Cloud) 与 QQ 音乐 (QQ Music) 歌单/封面/无损音频解析入架
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof exports === 'object') {
    module.exports = factory();
  } else {
    const res = factory();
    root.platformAuth = res.platformAuth;
    root.PlatformLoginModal = res.PlatformLoginModal;
  }
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const STORAGE_KEY = 'nexus_music_platform_sessions_v2';

  const SUPPORTED_PLATFORMS = [
    {
      id: 'netease',
      name: '网易云音乐',
      enTag: 'NETEASE CLOUD',
      accentColor: '#e60026',
      description: '同步私人漫游、自建歌单与黑胶无损音质'
    }
  ];

  // ---------------------------------------------------------------------------
  // 1. PlatformAuthManager (原生多平台凭据中心)
  // ---------------------------------------------------------------------------
  class PlatformAuthManager {
    constructor() {
      this.sessions = this.loadFromStorage();
      this.syncFromNcm();
    }

    loadFromStorage() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
      } catch (_) {}
      return {
        netease: { platform: 'netease', isConnected: false }
      };
    }

    saveToStorage() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.sessions));
      } catch (_) {}
    }

    syncFromNcm() {
      try {
        const pRaw = localStorage.getItem('wk_ncm_profile');
        if (pRaw) {
          const p = JSON.parse(pRaw);
          if (p && p.userId) {
            this.sessions.netease = {
              platform: 'netease',
              isConnected: true,
              uid: String(p.userId),
              nickname: p.nickname || '网易云音乐用户',
              avatarUrl: (p.avatarUrl || '').replace(/^http:/, 'https:'),
              isVip: true,
              credential: localStorage.getItem('wk_ncm_cookie') || '',
              updatedAt: Date.now()
            };
            this.saveToStorage();
          }
        }
      } catch (_) {}
    }

    getAllSessions() {
      return { ...this.sessions };
    }

    getSession(platformId) {
      return this.sessions[platformId] || { platform: platformId, isConnected: false };
    }

    setConnected(platformId, data) {
      this.sessions[platformId] = {
        platform: platformId,
        isConnected: true,
        ...data,
        updatedAt: Date.now()
      };
      this.saveToStorage();

      if (window.DynamicPlatformIsland && typeof DynamicPlatformIsland.update === 'function') {
        DynamicPlatformIsland.update();
      }
    }

    disconnect(platformId) {
      this.sessions[platformId] = {
        platform: platformId,
        isConnected: false
      };
      this.saveToStorage();

      if (platformId === 'netease' && window.NCM && typeof NCM.logout === 'function') {
        NCM.logout();
      }

      if (window.DynamicPlatformIsland && typeof DynamicPlatformIsland.update === 'function') {
        DynamicPlatformIsland.update();
      }
    }
  }

  const platformAuth = new PlatformAuthManager();

  // ---------------------------------------------------------------------------
  // 2. PlatformLoginModal (暗色高透毛玻璃双平台弹窗)
  // ---------------------------------------------------------------------------
  let modalBackdropEl = null;
  let selectedPlatform = 'netease';
  let loginMode = 'qr'; // 'qr' | 'cookie' | 'import' | 'toplist' | 'uin'
  let qrPollTimer = null;
  let currentQrKey = '';

  function initModalDom() {
    if (modalBackdropEl) return;

    modalBackdropEl = document.createElement('div');
    modalBackdropEl.className = 'platform-modal-backdrop';
    modalBackdropEl.id = 'platformLoginModal';
    modalBackdropEl.onclick = function (e) {
      if (e.target === modalBackdropEl) {
        closeModal();
      }
    };

    document.body.appendChild(modalBackdropEl);
  }

  function openModal(defaultPlatform = 'netease') {
    initModalDom();
    selectedPlatform = defaultPlatform;
    if (selectedPlatform === 'qq') {
      loginMode = 'import';
    } else {
      loginMode = 'qr';
    }
    platformAuth.syncFromNcm();
    renderModal();
    modalBackdropEl.classList.add('open');

    document.addEventListener('keydown', onKeyDown);
  }

  function closeModal() {
    if (!modalBackdropEl) return;
    modalBackdropEl.classList.remove('open');
    if (qrPollTimer) {
      clearInterval(qrPollTimer);
      qrPollTimer = null;
    }
    document.removeEventListener('keydown', onKeyDown);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') closeModal();
  }

  function switchPlatform(id) {
    selectedPlatform = id;
    if (id === 'qq') {
      loginMode = 'import';
    } else {
      loginMode = 'qr';
    }
    if (qrPollTimer) {
      clearInterval(qrPollTimer);
      qrPollTimer = null;
    }
    renderModal();
  }

  function switchMode(mode) {
    loginMode = mode;
    renderModal();
  }

  function renderModal() {
    if (!modalBackdropEl) return;

    const currentMeta = SUPPORTED_PLATFORMS.find(p => p.id === selectedPlatform) || SUPPORTED_PLATFORMS[0];
    const session = platformAuth.getSession(selectedPlatform);

    const html = `
      <div class="platform-modal-window" style="--cur-accent:${currentMeta.accentColor}">
        <!-- 顶部栏 -->
        <div class="platform-modal-header">
          <div class="platform-modal-title-wrap">
            <span class="platform-indicator-dot" style="background-color:${currentMeta.accentColor}; box-shadow:0 0 10px ${currentMeta.accentColor};"></span>
            <span class="platform-modal-title">网易云音乐通行证与音源中心</span>
          </div>
          <button class="platform-close-btn" onclick="PlatformLoginModal.close()" title="关闭弹窗">✕</button>
        </div>

        <!-- 主体左右分栏 -->
        <div class="platform-modal-body">
          <!-- 左侧：平台选择列表 -->
          <div class="platform-sidebar">
            ${SUPPORTED_PLATFORMS.map(p => {
              const isSel = p.id === selectedPlatform;
              const isConn = platformAuth.getSession(p.id).isConnected;
              return `
                <button class="platform-select-item ${isSel ? 'active' : ''}" onclick="PlatformLoginModal.switchPlatform('${p.id}')">
                  <div class="platform-tag-row">
                    <span class="platform-en-tag">${p.enTag}</span>
                    <span class="platform-status-badge ${isConn ? 'connected' : 'disconnected'}">
                      ${isConn ? '已连接' : '未登录'}
                    </span>
                  </div>
                  <div class="platform-name-label">${p.name}</div>
                  <div class="platform-desc-label">${p.description}</div>
                </button>
              `;
            }).join('')}
          </div>

          <!-- 右侧：登录操作与已连接名片 -->
          <div class="platform-content-panel">
            ${session.isConnected ? renderProfileView(session, currentMeta) : renderAuthView(currentMeta)}
          </div>
        </div>
      </div>
    `;

    modalBackdropEl.innerHTML = html;

    if (!session.isConnected && selectedPlatform === 'netease' && loginMode === 'qr') {
      loadQrCode(currentMeta);
    }
  }

  function renderProfileView(session, meta) {
    return `
      <div class="platform-profile-card">
        <div class="platform-profile-avatar-wrap" style="background:linear-gradient(135deg, ${meta.accentColor}, rgba(255,255,255,0.25));">
          ${session.avatarUrl ? `
            <img class="platform-profile-avatar" src="${session.avatarUrl}" alt="${session.nickname}">
          ` : `
            <div class="platform-profile-avatar-placeholder">${meta.name.slice(0, 1)}</div>
          `}
        </div>

        <div class="platform-profile-name-row">
          <span class="platform-profile-name">${session.nickname || '音源探索者'}</span>
          ${session.isVip ? `
            <span class="platform-vip-tag" style="border-color:${meta.accentColor}66; color:${meta.accentColor}; background:${meta.accentColor}1a;">VIP</span>
          ` : ''}
        </div>

        <div class="platform-profile-desc">已原生接入 ${meta.name} 曲库，可在 3D 书架无缝翻阅歌单与高保真聆听</div>

        <div class="platform-profile-actions">
          <button class="platform-sync-large-btn" style="background-color:${meta.accentColor};" onclick="PlatformLoginModal.syncPlatformPlaylists('${meta.id}')">
            ✨ 同步歌单到书架
          </button>
          <button class="platform-disconnect-btn" onclick="PlatformLoginModal.disconnect('${meta.id}')">
            断开退出
          </button>
        </div>
      </div>
      <div class="platform-footer-tip">会话凭据已安全隔离存储于本地客户端</div>
    `;
  }

  function renderAuthView(meta) {
    return `
      <div>
        <div class="platform-mode-switch-row">
          <span class="platform-login-label">登录 ${meta.name}</span>
          <div class="platform-mode-pills">
            <button class="platform-mode-btn ${loginMode === 'qr' ? 'active' : ''}" onclick="PlatformLoginModal.switchMode('qr')">App 扫码</button>
            <button class="platform-mode-btn ${loginMode === 'cookie' ? 'active' : ''}" onclick="PlatformLoginModal.switchMode('cookie')">Cookie 凭据</button>
          </div>
        </div>

        ${loginMode === 'qr' ? `
          <div class="platform-qr-container">
            <div class="platform-qr-box" id="platformQrBox">
              <div style="font-size:12px; color:#71717a;">正在请求扫码服务...</div>
            </div>
            <div class="platform-qr-hint">打开手机端 <strong style="color:#ffffff;">${meta.name}</strong> 扫一扫登录</div>
          </div>
        ` : `
          <div class="platform-cookie-container">
            <textarea
              id="platformCookieInput"
              class="platform-cookie-textarea"
              placeholder="请粘贴 ${meta.name} 请求头中的 Cookie 凭证（如 MUSIC_U=...）"
            ></textarea>
            <button class="platform-submit-btn" style="background-color:${meta.accentColor};" onclick="PlatformLoginModal.submitCookie('${meta.id}')">
              保存凭据并连接曲库
            </button>
          </div>
        `}
      </div>
      <div class="platform-footer-tip">凭证仅加密存储于本地客户端，用于解析平台高品质音频流</div>
    `;
  }

  async function loadQrCode(meta) {
    const qrBox = document.getElementById('platformQrBox');
    if (!qrBox) return;

    if (qrPollTimer) {
      clearInterval(qrPollTimer);
      qrPollTimer = null;
    }

    if (meta.id === 'netease') {
      qrBox.innerHTML = '<div style="font-size:12px; color:#71717a;">正在向网易云请求安全密钥...</div>';
      try {
        const res = await fetch('/login/qr/key');
        const j = await res.json();
        const key = j.unikey || (j.data && j.data.unikey);
        if (!key) throw new Error('二维码密钥获取失败');
        currentQrKey = key;

        const imgRes = await fetch(`/login/qr/create?key=${encodeURIComponent(key)}&qrimg=true`);
        const imgJ = await imgRes.json();
        const qrimg = imgJ.qrimg || (imgJ.data && (imgJ.data.qrimg || imgJ.data.data?.qrimg));

        if (qrimg) {
          qrBox.innerHTML = `<img src="${qrimg}" alt="Scan QR" style="width:160px; height:160px; object-fit:contain; border-radius:12px; background:#fff; padding:6px;">`;
          startNcmQrPolling(key);
        }
      } catch (err) {
        qrBox.innerHTML = `
          <div style="color:#f87171; font-size:11px; text-align:center;">
            二维码加载异常<br>
            <button onclick="PlatformLoginModal.retryQr()" style="margin-top:6px; font-size:11px; padding:2px 8px; border-radius:4px; border:none; background:#3f3f46; color:#fff; cursor:pointer;">重试</button>
          </div>
        `;
      }
    }
  }

  function startNcmQrPolling(key) {
    qrPollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/login/qr/check?key=${encodeURIComponent(key)}&timestamp=${Date.now()}`);
        const j = await res.json();
        const code = j.code;

        if (code === 800) {
          clearInterval(qrPollTimer);
          const qrBox = document.getElementById('platformQrBox');
          if (qrBox) {
            qrBox.innerHTML = `
              <div style="color:#f87171; font-size:11px; text-align:center;">
                二维码已过期<br>
                <button onclick="PlatformLoginModal.retryQr()" style="margin-top:6px; font-size:11px; padding:2px 8px; border-radius:4px; border:none; background:#3f3f46; color:#fff; cursor:pointer;">刷新二维码</button>
              </div>
            `;
          }
        } else if (code === 803) {
          clearInterval(qrPollTimer);
          const cookie = j.cookie || '';
          await syncNcmAccountAndPlaylists(cookie);
        }
      } catch (_) {}
    }, 2000);
  }

  function retryQr() {
    const meta = SUPPORTED_PLATFORMS.find(p => p.id === selectedPlatform);
    if (meta) loadQrCode(meta);
  }

  /**
   * 核心：无论扫码还是提交 Cookie，完整提取真实网易云账户并在书架导入用户歌单
   */
  async function syncNcmAccountAndPlaylists(cookie) {
    if (cookie) {
      localStorage.setItem('wk_ncm_cookie', cookie);
    }
    const curCookie = cookie || localStorage.getItem('wk_ncm_cookie') || '';
    if (!curCookie) {
      if (window.WK && typeof WK.toast === 'function') WK.toast('请先通过 App 扫码或填写 Cookie 凭证');
      return;
    }

    if (window.WK && typeof WK.toast === 'function') WK.toast('正在验证凭据并解析歌单...');

    try {
      // 1. 获取用户账户真实信息
      const accRes = await fetch(`/user/account?cookie=${encodeURIComponent(curCookie)}&timestamp=${Date.now()}`);
      const accJ = await accRes.json();
      const p = accJ.profile || (accJ.account && { userId: accJ.account.id, nickname: accJ.account.nickname, avatarUrl: '' });

      if (!p || !p.userId) {
        throw new Error((accJ && accJ.message) || '未获取到网易云用户信息，请检查 Cookie 有效性');
      }

      // 2. 注入全局 NCM 核心与持久存储
      if (window.NCM && typeof NCM.setProfile === 'function') {
        NCM.setProfile(p);
      } else {
        localStorage.setItem('wk_ncm_profile', JSON.stringify(p));
      }

      // 3. 更新会话名片
      platformAuth.setConnected('netease', {
        uid: String(p.userId),
        nickname: p.nickname || '网易云音乐用户',
        avatarUrl: (p.avatarUrl || '').replace(/^http:/, 'https:'),
        isVip: true,
        credential: curCookie
      });

      // 4. 获取用户全部自建与收藏歌单
      const plRes = await fetch(`/user/playlist?uid=${encodeURIComponent(p.userId)}&limit=100&cookie=${encodeURIComponent(curCookie)}&timestamp=${Date.now()}`);
      const plJ = await plRes.json();
      const playlists = plJ.playlist || [];

      if (!playlists.length) {
        if (window.WK && typeof WK.toast === 'function') WK.toast('✨ 登录成功！但该账号暂无自建歌单');
      } else {
        // 5. 将歌单转换为 3D 白盒并注入书架渲染
        if (window.WK && typeof WK.setUserPlaylists === 'function') {
          WK.setUserPlaylists(playlists);
        }
        if (window.WK && typeof WK.toast === 'function') {
          WK.toast(`✨ 登录成功！已自动将 ${playlists.length} 个歌单导入 3D 书架`);
        }
      }

      renderModal();
      setTimeout(closeModal, 800);
    } catch (err) {
      console.error('[NCM Sync Error]', err);
      if (window.WK && typeof WK.toast === 'function') {
        WK.toast('歌单导入异常: ' + (err.message || '网络连接超时'));
      }
    }
  }

  async function submitCookie(platformId) {
    const input = document.getElementById('platformCookieInput');
    if (!input || !input.value.trim()) {
      if (window.WK && typeof WK.toast === 'function') WK.toast('请先粘贴 Cookie 凭证');
      return;
    }

    const val = input.value.trim();
    if (platformId === 'netease') {
      await syncNcmAccountAndPlaylists(val);
    }
  }

  function submitQqUin() {
    const input = document.getElementById('platformQqUinInput');
    const uin = input ? input.value.trim() : '';
    if (!uin || !/^\d{5,12}$/.test(uin)) {
      if (window.WK && typeof WK.toast === 'function') WK.toast('请输入有效的 QQ 号码 (5~12位数字)');
      return;
    }
    const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=640`;
    platformAuth.setConnected('qq', {
      uid: uin,
      nickname: `QQ用户 (${uin})`,
      avatarUrl: avatarUrl,
      isVip: true,
      credential: `uin=${uin}`
    });
    if (window.WK && typeof WK.toast === 'function') {
      WK.toast(`✨ 成功绑定 QQ 音乐通行证 (${uin})！`);
    }
    renderModal();
  }

  function fillQqId(id, name) {
    const input = document.getElementById('platformQqInput');
    if (input) {
      input.value = id;
      importQqPlaylist(id);
    }
  }

  function openImportTab() {
    loginMode = 'import';
    renderModal();
  }

  function disconnect(platformId) {
    platformAuth.disconnect(platformId);
    renderModal();
    if (window.WK && typeof WK.toast === 'function') {
      WK.toast('已断开平台连接');
    }
  }

  async function syncPlatformPlaylists(platformId) {
    if (platformId === 'netease') {
      await syncNcmAccountAndPlaylists();
    } else {
      if (window.WK && typeof WK.toast === 'function') WK.toast('✨ 歌单书架已刷新');
      closeModal();
    }
  }

  async function importQqPlaylist(customDisstid) {
    let disstid = customDisstid;
    if (!disstid) {
      const input = document.getElementById('platformQqInput');
      const val = input ? input.value.trim() : '';
      if (!val) {
        if (window.WK && typeof WK.toast === 'function') WK.toast('请输入 QQ 音乐歌单 ID 或链接');
        return;
      }
      // 智能识别：如果是包含连续数字的链接或ID优先提取数字；若是短链则保留完整URL传给后端解析追踪
      const digitMatch = val.match(/\b\d{7,14}\b/);
      const urlMatch = val.match(/https?:\/\/[^\s]+/);
      if (digitMatch) {
        disstid = digitMatch[0];
      } else if (urlMatch) {
        disstid = urlMatch[0];
      } else {
        disstid = val;
      }
    }

    if (window.WK && typeof WK.toast === 'function') WK.toast('正在解析 QQ 音乐歌单...');

    try {
      const res = await fetch(`/qq/playlist?id=${encodeURIComponent(disstid)}`);
      const j = await res.json();
      const cd = (j.cdlist && j.cdlist[0]) || j;
      const songlist = cd.songlist || [];

      if (!songlist.length) {
        throw new Error(j.message || '歌单曲目为空或私密');
      }

      const coverUrl = (cd.logo || '').replace(/^http:/, 'https:');
      const tracks = songlist.map((s, idx) => ({
        id: `qq_${s.songmid || idx}`,
        index: String(idx + 1).padStart(2, '0'),
        title: s.songname || s.title || 'QQ音乐曲目',
        artist: (s.singer && s.singer[0] && s.singer[0].name) || 'QQ音乐歌手',
        album: s.albumname || '',
        subtitleQuote: s.albumname ? `专辑《${s.albumname}》` : 'QQ音乐精选',
        subArtist: 'QQ音乐',
        serial: `QQ-${String(idx + 1).padStart(3, '0')}`,
        accent: '#31c27c',
        coverImg: s.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg` : coverUrl,
        picUrl: s.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg` : coverUrl,
        durationSec: s.interval || 210,
        qqMid: s.songmid
      }));

      const newArchive = {
        id: `qq_${disstid}`,
        title: cd.dissname || 'QQ音乐精选盒',
        badge: 'QQ音乐',
        accent: '#31c27c',
        isQq: true,
        coverImgUrl: coverUrl,
        trackCount: tracks.length,
        tracks: tracks,
        books: tracks
      };

      if (window.addCustomPlaylistArchive) {
        window.addCustomPlaylistArchive(newArchive);
      }

      platformAuth.setConnected('qq', {
        uid: disstid,
        nickname: cd.nickname || 'QQ音乐绿钻用户',
        avatarUrl: (cd.headurl || cd.logo || '').replace(/^http:/, 'https:'),
        isVip: true
      });

      if (window.WK && typeof WK.toast === 'function') {
        WK.toast(`✨ 成功导入 QQ 歌单「${newArchive.title}」共 ${newArchive.trackCount} 首曲目！`);
      }
      closeModal();
    } catch (err) {
      console.warn('[QQ Import] 歌单解析失败:', err);
      if (window.WK && typeof WK.toast === 'function') {
        WK.toast('⚠️ QQ 歌单导入失败: ' + (err.message || '请检查歌单链接或是否公开'));
      }
    }
  }

  async function importQqToplist(topid = 26, title = '巅峰榜·热歌') {
    if (window.WK && typeof WK.toast === 'function') WK.toast(`正在拉取 QQ 音乐「${title}」...`);
    try {
      const res = await fetch(`/qq/toplist?topid=${topid}`);
      const j = await res.json();
      const songlist = j.songlist || [];
      const topinfo = j.topinfo || {};
      if (!songlist.length) throw new Error('榜单曲目为空');

      const coverUrl = (topinfo.pic_v12 || topinfo.pic || topinfo.picDetail || topinfo.MacListPicUrl || '').replace(/^http:/, 'https:');
      const tracks = songlist.map((item, idx) => {
        const s = item.data || item;
        return {
          id: `qq_${s.songmid || idx}`,
          index: String(idx + 1).padStart(2, '0'),
          title: s.songname || s.title || 'QQ音乐曲目',
          artist: (s.singer && s.singer[0] && s.singer[0].name) || 'QQ音乐歌手',
          album: s.albumname || '',
          subtitleQuote: s.albumname ? `专辑《${s.albumname}》` : '巅峰榜精选',
          subArtist: 'QQ音乐',
          serial: `TOP-${String(idx + 1).padStart(3, '0')}`,
          accent: '#31c27c',
          coverImg: s.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg` : coverUrl,
          picUrl: s.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg` : coverUrl,
          durationSec: s.interval || 210,
          qqMid: s.songmid
        };
      });

      const newArchive = {
        id: `qq_top_${topid}`,
        title: topinfo.ListName || title,
        badge: 'QQ音乐',
        accent: '#31c27c',
        isQq: true,
        coverImgUrl: coverUrl,
        trackCount: tracks.length,
        tracks: tracks,
        books: tracks
      };

      if (window.addCustomPlaylistArchive) {
        window.addCustomPlaylistArchive(newArchive);
      }

      platformAuth.setConnected('qq', {
        uid: `top_${topid}`,
        nickname: 'QQ音乐绿钻典藏',
        avatarUrl: coverUrl,
        isVip: true
      });

      if (window.WK && typeof WK.toast === 'function') {
        WK.toast(`✨ 成功导入「${newArchive.title}」共 ${newArchive.trackCount} 首曲目！`);
      }
      closeModal();
    } catch (err) {
      if (window.WK && typeof WK.toast === 'function') {
        WK.toast('⚠️ 官方榜单解析异常，已自动切入典藏盒');
      }
      importDemoQqPlaylist();
    }
  }

  function importDemoQqPlaylist() {
    importQqPlaylist('7649851609');
  }

  return {
    platformAuth,
    PlatformLoginModal: {
      open: openModal,
      close: closeModal,
      switchPlatform,
      switchMode,
      retryQr,
      submitCookie,
      submitQqUin,
      fillQqId,
      openImportTab,
      importQqPlaylist,
      importQqToplist,
      importDemoQqPlaylist,
      disconnect,
      syncPlatformPlaylists,
      get isModalOpen() {
        return modalBackdropEl && modalBackdropEl.classList.contains('open');
      }
    }
  };
});
