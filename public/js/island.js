/**
 * Wenku8 Desktop Island Controller
 * 桌面全透明悬浮灵动岛交互控制与主窗口状态双向同步
 * 支持小巧精致 190x32 胶囊与 320x80 微卡片动态贴合缩放
 */
(function () {
  'use strict';

  const syncChannel = new BroadcastChannel('wenku8-playback-sync');

  let currentState = {
    title: 'Wenku8 Audio',
    artist: '纯净音乐典藏',
    coverUrl: '',
    isPlaying: false,
    currentSec: 0,
    durationSec: 180,
    platform: 'ncm'
  };

  // DOM 元素引用
  const elIsland = document.getElementById('islandEl');
  const elGlow = document.getElementById('islandGlow');

  // 紧凑态元素
  const elCompactTitle = document.getElementById('compactTitle');
  const elCompactCoverImg = document.getElementById('compactCoverImg');

  // 展开态元素
  const elFullCoverBtn = document.getElementById('fullCoverBtn');
  const elFullCoverImg = document.getElementById('fullCoverImg');
  const elFullTitle = document.getElementById('fullTitle');
  const elFullArtist = document.getElementById('fullArtist');
  const elPlatformBadge = document.getElementById('platformBadge');
  const elTimeCurrent = document.getElementById('timeCurrent');
  const elTimeTotal = document.getElementById('timeTotal');
  const elProgressFill = document.getElementById('progressFill');
  const elProgressThumb = document.getElementById('progressThumb');
  const elProgressTrackWrap = document.getElementById('progressTrackWrap');

  // 控制按钮
  const elBtnPrev = document.getElementById('btnPrev');
  const elBtnPlayPause = document.getElementById('btnPlayPause');
  const elSvgPlay = document.getElementById('svgPlay');
  const elSvgPause = document.getElementById('svgPause');
  const elBtnNext = document.getElementById('btnNext');
  const elBtnRestoreMain = document.getElementById('btnRestoreMain');

  let isSeeking = false;
  let isHovered = false;

  function formatTime(sec) {
    if (isNaN(sec) || sec < 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
  }

  let collapseTimer = null;
  let lastExpandedState = null;

  // 动态展开/收起窗口（双通道保障：HTTP 本地接口 + Tauri invoke）
  function notifyWindowExpansion(expanded, playing) {
    const isPlay = playing !== undefined ? playing : currentState.isPlaying;
    const cacheKey = `${expanded}_${isPlay}`;
    if (lastExpandedState === cacheKey) return;
    lastExpandedState = cacheKey;

    // 1. HTTP 内部微服务通道 (保证 100% 触发)
    fetch(`/api/island/action?cmd=expand&expanded=${expanded ? '1' : '0'}&playing=${isPlay ? '1' : '0'}`).catch(() => {});

    // 2. Tauri IPC 通道
    try {
      if (window.__TAURI__ && window.__TAURI__.core) {
        window.__TAURI__.core.invoke('set_island_expanded', { expanded, playing: isPlay }).catch(() => {});
      } else if (window.__TAURI__ && window.__TAURI__.invoke) {
        window.__TAURI__.invoke('set_island_expanded', { expanded, playing: isPlay }).catch(() => {});
      }
    } catch (_) {}
  }

  // 鼠标移入展开，离开平滑收缩
  if (elIsland) {
    elIsland.addEventListener('mouseenter', () => {
      if (collapseTimer) {
        clearTimeout(collapseTimer);
        collapseTimer = null;
      }
      isHovered = true;
      // 1. 先扩大操作系统物理窗口，彻底杜绝任何一帧的边缘裁切
      notifyWindowExpansion(true, currentState.isPlaying);
      // 2. 下一帧开始 DOM 动画展开
      requestAnimationFrame(() => {
        if (isHovered && elIsland) {
          elIsland.classList.add('is-expanded');
        }
      });
    });

    elIsland.addEventListener('mouseleave', () => {
      isHovered = false;
      // 120ms 防抖延时：防止光标在控制按钮间移动时意外收缩
      if (collapseTimer) clearTimeout(collapseTimer);
      collapseTimer = setTimeout(() => {
        if (!isHovered && elIsland) {
          // 先移除展开样式，触发 CSS 平滑过渡收缩
          elIsland.classList.remove('is-expanded');
          // 动画完成后收缩操作系统物理窗口，严丝合缝贴回桌面
          setTimeout(() => {
            if (!isHovered) {
              notifyWindowExpansion(false, currentState.isPlaying);
            }
          }, 240);
        }
      }, 120);
    });
  }

  // 从封面取色并动态应用到光晕层
  function updateCoverGlow(coverUrl) {
    if (!coverUrl || !elGlow) return;
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 10;
          canvas.height = 10;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, 10, 10);
          const data = ctx.getImageData(0, 0, 10, 10).data;
          let r = 0, g = 0, b = 0, count = 0;
          for (let i = 0; i < data.length; i += 4) {
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            count++;
          }
          r = Math.round(r / count);
          g = Math.round(g / count);
          b = Math.round(b / count);
          elGlow.style.background = `radial-gradient(circle, rgba(${r}, ${g}, ${b}, 0.5) 0%, transparent 70%)`;
        } catch (_) {}
      };
      img.src = coverUrl;
    } catch (_) {}
  }

  function renderState() {
    if (!elIsland) return;

    // 播放/暂停状态
    const wasPlaying = elIsland.classList.contains('is-playing');
    elIsland.classList.toggle('is-playing', Boolean(currentState.isPlaying));
    if (!isHovered && wasPlaying !== Boolean(currentState.isPlaying)) {
      notifyWindowExpansion(false, currentState.isPlaying);
    }

    // 文本更新
    const title = currentState.title || 'Wenku8 Audio';
    const artist = currentState.artist || '纯净音乐典藏';
    if (elCompactTitle) elCompactTitle.textContent = title;
    if (elFullTitle) elFullTitle.textContent = title;
    if (elFullArtist) elFullArtist.textContent = artist;

    // 平台徽章
    if (elPlatformBadge) {
      if (currentState.platform === 'local') {
        elPlatformBadge.textContent = '本地音频';
        elPlatformBadge.className = 'platform-badge local';
      } else {
        elPlatformBadge.textContent = '网易云';
        elPlatformBadge.className = 'platform-badge';
      }
    }

    // 封面更新
    if (currentState.coverUrl) {
      if (elCompactCoverImg && elCompactCoverImg.src !== currentState.coverUrl) {
        elCompactCoverImg.src = currentState.coverUrl;
      }
      if (elFullCoverImg && elFullCoverImg.src !== currentState.coverUrl) {
        elFullCoverImg.src = currentState.coverUrl;
        updateCoverGlow(currentState.coverUrl);
      }
    }

    // 播放按钮状态
    if (elSvgPlay && elSvgPause) {
      elSvgPlay.style.display = currentState.isPlaying ? 'none' : 'block';
      elSvgPause.style.display = currentState.isPlaying ? 'block' : 'none';
    }

    // 进度条与时间
    if (!isSeeking && currentState.durationSec > 0) {
      const cur = Math.max(0, currentState.currentSec || 0);
      const dur = currentState.durationSec;
      const pct = Math.max(0, Math.min(100, (cur / dur) * 100));

      if (elTimeCurrent) elTimeCurrent.textContent = formatTime(cur);
      if (elTimeTotal) elTimeTotal.textContent = formatTime(dur);
      if (elProgressFill) elProgressFill.style.width = pct + '%';
      if (elProgressThumb) elProgressThumb.style.left = pct + '%';
    }
  }

  // 发送动作给主播放器
  function sendAction(action, data = null) {
    syncChannel.postMessage({
      type: 'ACTION',
      action,
      data
    });
  }

  // 唤起主窗口
  async function restoreMainWindow(andOpenPlayerView = false) {
    try {
      fetch('/api/island/action?cmd=show_main').catch(() => {});
      if (window.__TAURI__ && window.__TAURI__.core) {
        await window.__TAURI__.core.invoke('show_main_window');
      } else if (window.__TAURI__ && window.__TAURI__.invoke) {
        await window.__TAURI__.invoke('show_main_window');
      }
    } catch (_) {}

    sendAction('focus_main');
    if (andOpenPlayerView) {
      // 穿透进入大播放详情层
      sendAction('open_player_view');
    }
  }

  // 绑定交互按钮
  if (elBtnPrev) {
    elBtnPrev.addEventListener('click', (e) => {
      e.stopPropagation();
      sendAction('prev');
    });
  }

  if (elBtnPlayPause) {
    elBtnPlayPause.addEventListener('click', (e) => {
      e.stopPropagation();
      sendAction('toggle');
    });
  }

  if (elBtnNext) {
    elBtnNext.addEventListener('click', (e) => {
      e.stopPropagation();
      sendAction('next');
    });
  }

  // 唤回主界面
  if (elBtnRestoreMain) {
    elBtnRestoreMain.addEventListener('click', (e) => {
      e.stopPropagation();
      restoreMainWindow(false);
    });
  }

  // 核心：点击放大的封面直接穿透进入播放层
  if (elFullCoverBtn) {
    elFullCoverBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      restoreMainWindow(true);
    });
  }

  // 进度条点击跳转 Seek
  if (elProgressTrackWrap) {
    elProgressTrackWrap.addEventListener('click', (e) => {
      e.stopPropagation();
      const rect = elProgressTrackWrap.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const pct = Math.max(0, Math.min(1, clickX / rect.width));
      const targetSec = pct * (currentState.durationSec || 180);
      sendAction('seek', targetSec);
    });
  }

  // 读取已保存的状态
  try {
    const saved = localStorage.getItem('wk_island_state');
    if (saved) {
      currentState = { ...currentState, ...JSON.parse(saved) };
      renderState();
    }
  } catch (_) {}

  // 监听来自主窗口的广播
  syncChannel.onmessage = function (event) {
    if (!event.data) return;
    const { type, payload } = event.data;
    if (type === 'STATE_UPDATE') {
      currentState = { ...currentState, ...payload };
      renderState();
    }
  };

  // 定时器兜底刷新
  setInterval(() => {
    try {
      const saved = localStorage.getItem('wk_island_state');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.currentSec !== undefined) {
          currentState.currentSec = parsed.currentSec;
          currentState.durationSec = parsed.durationSec || currentState.durationSec;
          currentState.isPlaying = parsed.isPlaying;
          if (parsed.coverUrl && parsed.coverUrl !== currentState.coverUrl) {
            currentState.coverUrl = parsed.coverUrl;
          }
          renderState();
        }
      }
    } catch (_) {}
  }, 400);

  renderState();
})();
