/**
 * DynamicPlatformIsland (苹果灵动岛高透液态毛玻璃平台胶囊组件)
 * 纯透明高透液态毛玻璃 + 真实 iPhone 灵动岛三态联动 + Vidstack 极简媒体图标
 * 
 * 态 1 (Idle 紧缩态): 小巧精致胶囊，微呼吸点与书架名
 * 态 2 (Playing 伸长态，图2对齐): 伸长胶囊，左侧 22px 专辑封面，中间歌名，右侧跳动霓虹青绿音浪柱
 * 态 3 (Hover 展开态，图3对齐): 鼠标移入自动阻尼展开大卡片，高透磨砂质感：
 *      - 顶部：左侧 50px 放大封面（点击直接穿透进入播放层），中间标题/歌手/歌词，右侧声学跳波
 *      - 中部：精细进度条 + 03:01 / 03:15 时间戳，支持点击直接跳转
 *      - 底部：音源平台徽章 + Vidstack 上一曲 / 播放暂停 / 下一曲 / 收藏红心 / 偏好设置
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof exports === 'object') {
    module.exports = factory();
  } else {
    root.DynamicPlatformIsland = factory();
  }
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // Vidstack 风格极简 SVG 图标
  const ICONS = {
    play: `<svg viewBox="0 0 32 32" class="vds-icon" fill="currentColor"><path d="M10 7.5L25 16L10 24.5V7.5Z"/></svg>`,
    pause: `<svg viewBox="0 0 32 32" class="vds-icon" fill="currentColor"><path d="M9 7H13V25H9V7ZM19 7H23V25H19V7Z"/></svg>`,
    prev: `<svg viewBox="0 0 32 32" class="vds-icon" fill="currentColor"><path d="M8 8H11V24H8V8ZM24 8.5L13 16L24 23.5V8.5Z"/></svg>`,
    next: `<svg viewBox="0 0 32 32" class="vds-icon" fill="currentColor"><path d="M8 8.5L19 16L8 23.5V8.5ZM21 8H24V24H21V8Z"/></svg>`,
    heartOutline: `<svg viewBox="0 0 32 32" class="vds-icon" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 26.5L14.15 24.82C7.6 18.88 3.25 14.93 3.25 10.1C3.25 6.16 6.31 3.1 10.25 3.1C12.48 3.1 14.62 4.14 16 5.76C17.38 4.14 19.52 3.1 21.75 3.1C25.69 3.1 28.75 6.16 28.75 10.1C28.75 14.93 24.4 18.88 17.85 24.83L16 26.5Z"/></svg>`,
    heartFilled: `<svg viewBox="0 0 32 32" class="vds-icon" fill="#ff2d55"><path d="M16 26.5L14.15 24.82C7.6 18.88 3.25 14.93 3.25 10.1C3.25 6.16 6.31 3.1 10.25 3.1C12.48 3.1 14.62 4.14 16 5.76C17.38 4.14 19.52 3.1 21.75 3.1C25.69 3.1 28.75 6.16 28.75 10.1C28.75 14.93 24.4 18.88 17.85 24.83L16 26.5Z"/></svg>`,
    settings: `<svg viewBox="0 0 32 32" class="vds-icon" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="16" cy="16" r="3.5"/><path d="M19.4 4.5l.8 2.5a8.2 8.2 0 0 1 2.3 1.3l2.6-.7 1.9 3.3-2 1.7a8.7 8.7 0 0 1 0 2.8l2 1.7-1.9 3.3-2.6-.7a8.2 8.2 0 0 1-2.3 1.3l-.8 2.5h-3.8l-.8-2.5a8.2 8.2 0 0 1-2.3-1.3l-2.6.7-1.9-3.3 2-1.7a8.7 8.7 0 0 1 0-2.8l-2-1.7 1.9-3.3 2.6.7a8.2 8.2 0 0 1 2.3-1.3l.8-2.5h3.8z"/></svg>`
  };

  let state = {
    title: 'Wenku8 Audio',
    artist: '纯净音乐档案',
    subtitle: '所有美好都擦肩而过',
    coverUrl: '',
    isPlaying: false,
    currentSec: 0,
    durationSec: 180,
    liked: false,
    platform: 'ncm', // ncm, qq, local
    isHovered: false,
    accentHex: '#00f5d4'
  };

  let mountEls = [];
  let isSeeking = false;

  function init(selectors = ['dynamicPlatformIslandMount', 'dynamicPlatformIslandMountShelf']) {
    mountEls = [];
    selectors.forEach(id => {
      const el = document.getElementById(id);
      if (el) mountEls.push(el);
    });
    if (!mountEls.length) return;

    render();
    bindEvents();
  }

  function formatTime(sec) {
    if (isNaN(sec) || sec < 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getPlatformLogoSvg(platform) {
    if (platform === 'local') {
      return `<div class="island-platform-logo-circle" style="background:#3b82f6;" title="本地音频引擎"><svg viewBox="0 0 24 24" width="14" height="14" fill="#fff"><path d="M12 4a8 8 0 1 0 8 8 8 8 0 0 0-8-8zm-1 5h2v6h-2zm0 8h2v2h-2z"/></svg></div>`;
    }
    // 默认网易云
    return `<div class="island-platform-logo-circle" style="background:#ef4444;" title="网易云音乐音源"><svg viewBox="0 0 24 24" width="14" height="14" fill="#fff"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 14.5a2.5 2.5 0 1 1-2.5-2.5c.3 0 .6.06.87.16V8.5l4-1.2v3.7h-.37A2.5 2.5 0 0 0 13 13.5v3z"/></svg></div>`;
  }

  function bindEvents() {
    mountEls.forEach(el => {
      // 鼠标悬停进入展开态，移开恢复胶囊态
      el.addEventListener('mouseenter', () => {
        state.isHovered = true;
        updateDomClasses();
      });
      el.addEventListener('mouseleave', () => {
        if (!isSeeking) {
          state.isHovered = false;
          updateDomClasses();
        }
      });
    });
  }

  function updateDomClasses() {
    mountEls.forEach(el => {
      const pill = el.querySelector('.dynamic-island-pill');
      if (!pill) return;
      pill.classList.toggle('is-playing', Boolean(state.isPlaying));
      pill.classList.toggle('is-hover-expanded', Boolean(state.isHovered));
      pill.classList.toggle('is-idle', !state.isPlaying && !state.isHovered);
    });
  }

  function render() {
    if (!mountEls.length) return;

    const curTimeStr = formatTime(state.currentSec);
    const durTimeStr = formatTime(state.durationSec || 180);
    const progressPct = state.durationSec > 0 ? Math.min(100, Math.max(0, (state.currentSec / state.durationSec) * 100)) : 0;
    const coverSrc = state.coverUrl || 'assets/cover-fallback.webp';
    const platformLogo = getPlatformLogoSvg(state.platform);

    const html = `
      <div class="dynamic-island-pill ${state.isPlaying ? 'is-playing' : 'is-idle'} ${state.isHovered ? 'is-hover-expanded' : ''}" id="dynamicIslandMainPill">
        
        <!-- ================= 态 1 & 态 2：胶囊紧凑态 (Idle 小胶囊 / Playing 伸长胶囊) ================= -->
        <div class="island-compact-layer">
          <!-- 正在播放时左侧小封面 -->
          <div class="compact-cover-wrap">
            <img src="${coverSrc}" class="compact-cover-img" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22%23666%22><rect width=%2224%22 height=%2224%22/></svg>'">
          </div>

          <!-- 未播放时的小呼吸点 -->
          <span class="compact-idle-dot" style="background:${state.accentHex || '#00f5d4'};"></span>

          <!-- 中间歌名 / 书架名 -->
          <div class="compact-title-wrap">
            <span class="compact-title-text">${escapeHtml(state.title || 'Wenku8 Audio')}</span>
          </div>

          <!-- 右侧动态霓虹青绿音频跳动波（对齐图2） -->
          <div class="compact-wave-bars ${state.isPlaying ? 'playing' : ''}">
            <span class="c-wave-bar"></span>
            <span class="c-wave-bar"></span>
            <span class="c-wave-bar"></span>
            <span class="c-wave-bar"></span>
          </div>
        </div>

        <!-- ================= 态 3：鼠标悬停自动展开态（图3对齐卡片，全透明液态毛玻璃） ================= -->
        <div class="island-expanded-layer">
          
          <!-- 1. 顶部行：大封面（点击直接穿透进入播放层） + 歌名/歌手 + 右侧音浪 -->
          <div class="expanded-top-row">
            <!-- 核心：点击放大的封面后直接进入播放层 -->
            <div class="expanded-cover-button" onclick="event.stopPropagation(); DynamicPlatformIsland.enterPlaybackLayer();" title="点击直接进入播放层">
              <img src="${coverSrc}" class="expanded-cover-img" alt="">
              <div class="expanded-cover-hover-lens">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="#fff"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
              </div>
            </div>

            <!-- 歌名与副标题 -->
            <div class="expanded-meta-col" onclick="event.stopPropagation(); DynamicPlatformIsland.enterPlaybackLayer();">
              <div class="expanded-title-line">
                <span class="expanded-track-title">${escapeHtml(state.title)}</span>
                ${state.artist ? `<span class="expanded-track-artist"> - ${escapeHtml(state.artist)}</span>` : ''}
              </div>
              <div class="expanded-sub-line">${escapeHtml(state.subtitle || state.artist || '纯净典藏母带')}</div>
            </div>

            <!-- 右侧声学跳波 -->
            <div class="expanded-wave-indicator ${state.isPlaying ? 'playing' : ''}">
              <span class="e-wave-bar"></span>
              <span class="e-wave-bar"></span>
              <span class="e-wave-bar"></span>
              <span class="e-wave-bar"></span>
            </div>
          </div>

          <!-- 2. 中部行：可拖动/点击的细进度条 + 03:01 / 03:15 时间戳 -->
          <div class="expanded-progress-row" onclick="event.stopPropagation();">
            <span class="island-time-label cur-time">${curTimeStr}</span>
            <div class="island-progress-track-wrapper" onclick="DynamicPlatformIsland.handleSeekClick(event)" onmousedown="DynamicPlatformIsland.handleSeekMouseDown(event)">
              <div class="island-progress-track-bar">
                <div class="island-progress-fill" style="width: ${progressPct}%;"></div>
                <div class="island-progress-scrubber" style="left: ${progressPct}%;"></div>
              </div>
            </div>
            <span class="island-time-label dur-time">${durTimeStr}</span>
          </div>

          <!-- 3. 底部控制行：音源平台徽章 + Vidstack 媒体控制按键 -->
          <div class="expanded-controls-row" onclick="event.stopPropagation();">
            <!-- 左侧平台徽章 -->
            <div class="controls-left-slot" onclick="DynamicPlatformIsland.openPlatformLogin();" title="管理跨平台音源通行证">
              ${platformLogo}
            </div>

            <!-- 中间 Vidstack 控制按钮组 -->
            <div class="controls-center-btns">
              <button class="island-ctrl-btn prev-btn" onclick="DynamicPlatformIsland.prevTrack();" title="上一首">
                ${ICONS.prev}
              </button>

              <button class="island-ctrl-btn play-pause-btn" onclick="DynamicPlatformIsland.togglePlay();" title="${state.isPlaying ? '暂停' : '播放'}">
                ${state.isPlaying ? ICONS.pause : ICONS.play}
              </button>

              <button class="island-ctrl-btn next-btn" onclick="DynamicPlatformIsland.nextTrack();" title="下一首">
                ${ICONS.next}
              </button>
            </div>

            <!-- 右侧红心收藏与偏好设置 -->
            <div class="controls-right-slot">
              <button class="island-action-btn heart-btn ${state.liked ? 'is-liked' : ''}" onclick="DynamicPlatformIsland.toggleLike();" title="收藏单曲">
                ${state.liked ? ICONS.heartFilled : ICONS.heartOutline}
              </button>

              <button class="island-action-btn settings-btn" onclick="DynamicPlatformIsland.openSettings();" title="偏好设置">
                ${ICONS.settings}
              </button>
            </div>
          </div>

        </div>
      </div>
    `;

    mountEls.forEach(el => {
      el.innerHTML = html;
    });

    updateDomClasses();
  }

  // ---------------------------------------------------------------------------
  // 核心交互方法
  // ---------------------------------------------------------------------------

  /**
   * 点击放大的封面后直接穿透进入播放层
   */
  function enterPlaybackLayer() {
    if (typeof window.openPlayerView === 'function') {
      window.openPlayerView(true);
    } else if (typeof window.openPlaylistCoverflow === 'function') {
      window.openPlaylistCoverflow();
    }
  }

  function togglePlay() {
    if (typeof window.togglePlayPause === 'function') {
      window.togglePlayPause();
    }
  }

  function prevTrack() {
    if (typeof window.skipTrack === 'function') {
      window.skipTrack(-1);
    }
  }

  function nextTrack() {
    if (typeof window.skipTrack === 'function') {
      window.skipTrack(1);
    }
  }

  function toggleLike() {
    if (typeof window.toggleHeartLike === 'function') {
      window.toggleHeartLike();
    }
  }

  function openPlatformLogin() {
    if (window.PlatformLoginModal && typeof window.PlatformLoginModal.open === 'function') {
      window.PlatformLoginModal.open(state.platform || 'netease');
    } else if (window.NCM && typeof window.NCM.openLoginPanel === 'function') {
      window.NCM.openLoginPanel();
    }
  }

  function openSettings() {
    if (window.SettingsModal && typeof window.SettingsModal.open === 'function') {
      window.SettingsModal.open();
    }
  }

  function handleSeekClick(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetSec = ratio * (state.durationSec || 180);
    seekToSeconds(targetSec);
  }

  function handleSeekMouseDown(e) {
    isSeeking = true;
    const target = e.currentTarget;
    function onMouseMove(moveEvent) {
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.max(0, Math.min(1, (moveEvent.clientX - rect.left) / rect.width));
      updateProgressFillOnly(ratio);
    }
    function onMouseUp(upEvent) {
      isSeeking = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.max(0, Math.min(1, (upEvent.clientX - rect.left) / rect.width));
      seekToSeconds(ratio * (state.durationSec || 180));
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function updateProgressFillOnly(ratio) {
    const pct = Math.round(ratio * 100);
    mountEls.forEach(el => {
      const fill = el.querySelector('.island-progress-fill');
      const thumb = el.querySelector('.island-progress-scrubber');
      const time = el.querySelector('.island-time-label.cur-time');
      if (fill) fill.style.width = pct + '%';
      if (thumb) thumb.style.left = pct + '%';
      if (time) time.textContent = formatTime(ratio * (state.durationSec || 180));
    });
  }

  function seekToSeconds(targetSec) {
    state.currentSec = Math.round(targetSec);
    if (typeof window.scrubSongProgress === 'function') {
      const dur = state.durationSec || 180;
      const sliderVal = dur > 0 ? (targetSec / dur) * 1000 : 0;
      window.scrubSongProgress(sliderVal);
    }
    renderProgressOnly();
  }

  function renderProgressOnly() {
    const pct = state.durationSec > 0 ? Math.min(100, Math.max(0, (state.currentSec / state.durationSec) * 100)) : 0;
    mountEls.forEach(el => {
      const fill = el.querySelector('.island-progress-fill');
      const thumb = el.querySelector('.island-progress-scrubber');
      const curT = el.querySelector('.island-time-label.cur-time');
      const durT = el.querySelector('.island-time-label.dur-time');
      if (fill) fill.style.width = pct + '%';
      if (thumb) thumb.style.left = pct + '%';
      if (curT) curT.textContent = formatTime(state.currentSec);
      if (durT) durT.textContent = formatTime(state.durationSec || 180);
    });
  }

  // 接收播放器高频广播 (无需全量重构 DOM，维持丝滑 60fps)
  function syncPlayback(data) {
    if (!data) return;
    const needFullReRender = 
      data.title !== state.title || 
      data.coverUrl !== state.coverUrl || 
      data.isPlaying !== state.isPlaying || 
      data.liked !== state.liked ||
      data.platform !== state.platform;

    state = { ...state, ...data };

    if (needFullReRender) {
      render();
    } else if (!isSeeking) {
      renderProgressOnly();
    }
  }

  function update(newData) {
    syncPlayback(newData);
  }

  return {
    init,
    update,
    syncPlayback,
    enterPlaybackLayer,
    togglePlay,
    prevTrack,
    nextTrack,
    toggleLike,
    openPlatformLogin,
    openSettings,
    handleSeekClick,
    handleSeekMouseDown,
    get state() { return state; }
  };
});
