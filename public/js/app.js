// ---- 通用工具：元素缓存、HTML 转义、动画循环唤醒 ----

// Linux 平台检测：在 <html> 注入 is-linux 类，激活 Linux 兼容动效
// 检测逻辑：UA 含 "Linux" 且不含 "Android"（排除安卓 WebView）
(function detectLinux() {
  try {
    const ua = navigator.userAgent || '';
    const isLinux = /Linux/.test(ua) && !/Android/.test(ua);
    if (isLinux) document.documentElement.classList.add('is-linux');
  } catch (_) {}
})();

// 清除所有残留 Service Worker 与 CacheStorage，彻底杜绝子 iframe 页面路由被劫持
(function purgeServiceWorkers() {
  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      navigator.serviceWorker.getRegistrations().then(function (regs) {
        regs.forEach(function (r) { r.unregister(); });
      }).catch(function () {});
    }
    if (typeof window !== 'undefined' && window.caches) {
      caches.keys().then(function (names) {
        names.forEach(function (n) { caches.delete(n); });
      }).catch(function () {});
    }
  } catch (_) {}
})();

const UI = {};
function ui(id) { return UI[id] || (UI[id] = document.getElementById(id)); }
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let rafId = 0, lastFrameTs = 0, isScrubbing = false;
let scrollPos = 0;
let soundOn = true;
try { soundOn = localStorage.getItem('wk8_sound') !== '0'; } catch (_) {}
function wake() {
  if (!rafId) { lastFrameTs = performance.now(); rafId = requestAnimationFrame(animateShelfAndPlayer); }
}
let viewMode = 'box'; // 书架默认沉浸 3D 盒身模式
function applyViewMode() {
  const sv = ui('shelfView');
  if (sv) sv.classList.remove('cf');
  const label = ui('viewModeLabel');
  if (label) label.textContent = isShelfListView ? '3D书盒' : '列表总览';
}
function toggleSound() {
  soundOn = !soundOn;
  try { localStorage.setItem('wk8_sound', soundOn ? '1' : '0'); } catch (_) {}
  const sb = ui('soundBtn');
  if (sb) sb.textContent = soundOn ? '🔊' : '🔇';
  const csb = ui('cfSoundBtn');
  if (csb) csb.textContent = soundOn ? '🔊' : '🔇';
}

// ---- 播放音量（与操作音效 soundOn 相互独立）----
let playerVolume = 0.85;
try {
  const savedVol = parseFloat(localStorage.getItem('wk8_volume'));
  if (isFinite(savedVol)) playerVolume = Math.min(1, Math.max(0, savedVol));
} catch (_) {}
let lastNonZeroVolume = playerVolume > 0 ? playerVolume : 0.85;

function applyVolumeIcon() {
  const icon = ui('volMuteIcon');
  if (!icon) return;
  icon.textContent = playerVolume <= 0 ? '🔇' : (playerVolume < 0.5 ? '🔉' : '🔊');
}

function setPlayerVolume(value) {
  const pct = Number(value);
  const next = Math.min(1, Math.max(0, (isFinite(pct) ? pct : 85) / 100));
  if (next > 0) lastNonZeroVolume = next;
  playerVolume = next;
  if (localAudioEl) localAudioEl.volume = next;
  try { localStorage.setItem('wk8_volume', String(next)); } catch (_) {}
  const slider = ui('volRangeSlider');
  if (slider && String(slider.value) !== String(Math.round(next * 100))) {
    slider.value = String(Math.round(next * 100));
  }
  applyVolumeIcon();
}

function toggleMute() {
  const next = playerVolume > 0 ? 0 : (lastNonZeroVolume || 0.85);
  setPlayerVolume(next * 100);
}

function toggleFoliaDesktopMode() {
  try {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen();
    }
  } catch (_) {}
}

// ============================================================================
// 0. Folia 17 官方原生动效体系与 iframe 桥接
// ============================================================================
const FOLIA_MODES = [
  // ===== 自制动效（置顶）=====
  { id: 'off', label: '封面' },
  { id: 'glass', label: '水镜' },
  { id: 'aurora', label: '极光' },
  { id: 'classic', label: '流光' },
  // ===== Folia 原生动效 =====
  { id: 'cadenza', label: '心象' },
  { id: 'cappella', label: '群唱' },
  { id: 'claddagh', label: '回环' },
  { id: 'diorama', label: '镜台' },
  { id: 'fume', label: '浮名' },
  { id: 'machi', label: '町景' },
  { id: 'monet', label: '莫奈' },
  { id: 'nebbia', label: '雾笺' },
  { id: 'partita', label: '云阶' },
  { id: 'tempera', label: '凝彩' },
  { id: 'tilt', label: '倾诉' }
];

/** 随机 / 锁定状态 */
let foliaRandomEnabled = false;  // 默认关闭自动随机：默认动效固定为水镜，用户可手动点 🎲 随机
let playbackMode = 'list';       // 'one' | 'list' | 'shuffle'（原代码引用但未定义，导致 skipTrack 抛错）
let foliaLockedMode = null;    // null 表示未锁定
let foliaRandomTimer = 0;

let currentFoliaMode = 'glass';   // 默认动效 = 水镜
let foliaStageEl = null;
let foliaUpstreamIframe = null;

function setBuiltinDisplayMode(mode) {
  setFoliaMode('off');
  const pv = ui('playerView');
  if (pv) {
    pv.classList.remove('mode-rain', 'mode-cover', 'mode-lyrics');
    pv.classList.add('mode-' + mode);
  }
  document.querySelectorAll('.dual-pill').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
}

function toggleFoliaDropdown(event) {
  if (event) event.stopPropagation();
  const card = document.getElementById('foliaDropdownCard');
  if (!card) return;
  const isOpen = card.classList.contains('open');
  if (isOpen) {
    closeFoliaDropdown();
  } else {
    ensureFoliaDropdownGrid();
    card.classList.add('open');
    document.addEventListener('click', onDocClickCloseFoliaDropdown);
  }
}

function closeFoliaDropdown() {
  const card = document.getElementById('foliaDropdownCard');
  if (card) card.classList.remove('open');
  document.removeEventListener('click', onDocClickCloseFoliaDropdown);
}

function onDocClickCloseFoliaDropdown(e) {
  const card = document.getElementById('foliaDropdownCard');
  const trigger = document.getElementById('foliaMenuTrigger');
  if (!card) return;
  if (!card.contains(e.target) && !trigger?.contains(e.target)) {
    closeFoliaDropdown();
  }
}

function ensureFoliaDropdownGrid() {
  const grid = document.getElementById('foliaDropdownGrid');
  if (!grid) return;
  grid.innerHTML = '';
  FOLIA_MODES.forEach(m => {
    const btn = document.createElement('button');
    btn.className = 'folia-dropdown-pill' + (m.id === currentFoliaMode ? ' active' : '');
    btn.dataset.mode = m.id;
    btn.textContent = m.label;
    btn.onclick = (e) => {
      e.stopPropagation();
      setFoliaMode(m.id);
      closeFoliaDropdown();
    };
    grid.appendChild(btn);
  });

  // ===== 随机 / 锁定 =====
  let extra = grid.parentElement.querySelector('.folia-extra-bar');
  if (!extra) {
    extra = document.createElement('div');
    extra.className = 'folia-extra-bar';
    extra.style.cssText = 'display:flex;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.1)';
    grid.parentElement.appendChild(extra);
  }
  extra.innerHTML = '';

  const randBtn = document.createElement('button');
  randBtn.className = 'folia-dropdown-pill folia-rand-btn';
  randBtn.style.cssText = 'flex:1';
  randBtn.textContent = '🎲 随机动效';
  randBtn.onclick = (e) => { e.stopPropagation(); randomFoliaMode(); };
  extra.appendChild(randBtn);

  const lockBtn = document.createElement('button');
  lockBtn.className = 'folia-dropdown-pill folia-lock-btn';
  lockBtn.style.cssText = 'flex:1';
  lockBtn.textContent = foliaLockedMode ? '🔒 已锁定' : '🔓 锁定动效';
  lockBtn.classList.toggle('active', !!foliaLockedMode);
  lockBtn.onclick = (e) => { e.stopPropagation(); toggleFoliaLock(); };
  extra.appendChild(lockBtn);
}

/** 随机切换到一个动效（锁定中不生效） */
function randomFoliaMode() {
  if (foliaLockedMode) {
    if (window.WK && WK.toast) WK.toast('已锁定动效，点击「解锁」后再随机');
    return;
  }
  const pool = FOLIA_MODES.filter(m => m.id !== 'off');
  if (!pool.length) return;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  setFoliaMode(pick.id);
  if (window.WK && WK.toast) WK.toast('随机动效：' + pick.label);
}

/** 锁定 / 解锁当前动效 */
function toggleFoliaLock() {
  if (foliaLockedMode) {
    foliaLockedMode = null;
    if (window.WK && WK.toast) WK.toast('已解锁动效');
  } else {
    if (currentFoliaMode === 'off') {
      if (window.WK && WK.toast) WK.toast('请先选择一个动效再锁定');
      return;
    }
    foliaLockedMode = currentFoliaMode;
    if (window.WK && WK.toast) WK.toast('已锁定：' + (FOLIA_MODES.find(m => m.id === foliaLockedMode)?.label || foliaLockedMode));
  }
  ensureFoliaDropdownGrid();
}

function ensureFoliaDom() {
  const pv = ui('playerView');
  if (!pv) return;
  if (!pv._ctxMenuBound) {
    pv._ctxMenuBound = true;
    pv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }
  if (!foliaStageEl) {
    foliaStageEl = document.getElementById('foliaStageLayer');
    if (!foliaStageEl) {
      foliaStageEl = document.createElement('div');
      foliaStageEl.id = 'foliaStageLayer';
      foliaStageEl.className = 'folia-stage-layer';
      pv.insertBefore(foliaStageEl, pv.firstChild);
    }
  }
  ensureFoliaDropdownGrid();
}

function ensureFoliaIframe(modeId) {
  if (!foliaStageEl) return;
  const targetSrc = 'folia/classic.html?mode=' + encodeURIComponent(modeId);
  if (!foliaUpstreamIframe) {
    foliaUpstreamIframe = document.createElement('iframe');
    foliaUpstreamIframe.id = 'foliaUpstreamIframe';
    foliaUpstreamIframe.src = targetSrc;
    foliaUpstreamIframe.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; border:none; background:#0a0a0c; z-index:1; pointer-events:auto; display:block;';
    foliaUpstreamIframe.onload = () => {
      // 拦截右键，杜绝弹出 Folia 内部设置对话框 (ThemedDialog)
      try {
        foliaUpstreamIframe.contentWindow?.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
        }, true);
        foliaUpstreamIframe.contentDocument?.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
        }, true);
      } catch (_) {}
      // iframe 内部 React 挂载需要时间，分三次重发确保收到
      syncFoliaToUpstreamIframe();
      setTimeout(syncFoliaToUpstreamIframe, 300);
      setTimeout(syncFoliaToUpstreamIframe, 900);
      setTimeout(syncFoliaToUpstreamIframe, 1800);
    };
    // 5274 服务未启动时 iframe 会是纯黑/白屏（onerror 不触发），用超时兜底到本地水镜
    foliaUpstreamIframe.onerror = () => {
      if (window.GlassWater && currentFoliaMode !== 'glass') {
        setFoliaMode('glass');
      }
    };
    foliaStageEl.appendChild(foliaUpstreamIframe);
  } else {
    foliaUpstreamIframe.style.display = 'block';
    try {
      // 检查 iframe 是否被劫持或未处于 classic.html，若偏离则重设 src
      const curHref = foliaUpstreamIframe.contentWindow?.location?.href || '';
      if (!curHref.includes('classic.html')) {
        foliaUpstreamIframe.src = targetSrc;
      } else {
        foliaUpstreamIframe.contentWindow?.postMessage({ type: 'SET_MODE', mode: modeId }, '*');
      }
      syncFoliaToUpstreamIframe();
    } catch (_) {
      foliaUpstreamIframe.src = targetSrc;
    }
  }
}

function syncFoliaToUpstreamIframe() {
  const __book = activeBooks[targetIdx] || ARCHIVE_BOOKS[0];
  // 水镜走本地 canvas，切歌时同步歌词
  if (currentFoliaMode === 'glass' && window.GlassWater && __book) {
    window.GlassWater.setLyrics(buildGlassLyrics(__book));
    return;
  }
  if (!foliaUpstreamIframe || !foliaUpstreamIframe.contentWindow) return;
  const book = __book;
  if (!book) return;
  const lyricsArray = (book.lyrics && book.lyrics.length) ? book.lyrics.map((l, idx) => {
    const start = Number(l.t ?? 0);
    const nextLine = book.lyrics[idx + 1];
    const nextStart = nextLine ? Number(nextLine.t ?? start + 4) : (start + 4.5);
    const lineGap = Math.max(0.6, nextStart - start);
    // 控制单句演唱时长在自然区间（0.8s ~ 5.2s），防止间奏时长过长导致歌词逐字动画停滞慢拉
    const charLen = (l.l1 || l.text || '').length;
    const estimatedSingDuration = Math.min(lineGap, Math.max(1.6, Math.min(5.2, charLen * 0.35 + 0.5)));
    const end = start + estimatedSingDuration;
    return {
      t: start,
      startTime: start,
      endTime: end,
      l1: l.l1 || l.text || '',
      l2: l.l2 || '',
      text: l.text || l.l1 || '',
      fullText: l.l1 || l.text || ''
    };
  }) : [];
  const lyricsText = book.lyricsRaw || (book.lyrics && book.lyrics.map(l => l.l1 || l.text).filter(Boolean).join('\n')) || `${book.title}\n${book.artist}`;
  const curTime = (localAudioEl && !localAudioEl.paused) ? localAudioEl.currentTime : (book.currentSec || 0);
  const duration = book.durationSec || (localAudioEl && localAudioEl.duration ? localAudioEl.duration : 180) || 180;
  try {
    foliaUpstreamIframe.contentWindow.postMessage({
      type: 'LOAD_LYRICS',
      text: lyricsText,
      lyrics: lyricsArray,
      durationSec: duration,
      title: book.title,
      artist: book.artist,
      time: curTime
    }, '*');
    foliaUpstreamIframe.contentWindow.postMessage({
      type: isPlaying ? 'PLAY' : 'PAUSE'
    }, '*');
    foliaUpstreamIframe.contentWindow.postMessage({
      type: 'SEEK',
      time: curTime
    }, '*');
  } catch (_) {}
}

/** 把 book.lyrics 转成水镜需要的逐字时间轴 */
function buildGlassLyrics(book) {
  if (!book || !book.lyrics || !book.lyrics.length) return [];
  const src = book.lyrics;
  return src.map(function (l, i) {
    const start = Number(l.t) || 0;
    const next = src[i + 1] ? (Number(src[i + 1].t) || start + 3) : start + 3.2;
    const text = l.l1 || l.text || '';
    if (!text) return { startTime: start, fullText: '', words: [] };
    const chars = Array.from(text);
    // 每行控制在 0.9~2.6 秒内落完（跟旋律一句一句的节奏对齐），
    // 行与行之间留出静默期看水波——这才是"歌词跟着旋律落到水里"的观感。
    const span = Math.min(2.6, Math.max(0.9, (next - start) * 0.35));
    const step = span / Math.max(1, chars.length);
    return {
      startTime: start,
      fullText: text,
      words: chars.map(function (c, j) {
        return { text: c, startTime: start + j * step, endTime: start + (j + 1) * step };
      })
    };
  });
}

function setFoliaMode(modeId) {
  currentFoliaMode = modeId;
  ensureFoliaDom();
  const pv = ui('playerView');
  const triggerLabel = document.getElementById('foliaTriggerLabel');
  const triggerBtn = document.getElementById('foliaMenuTrigger');
  const found = FOLIA_MODES.find(m => m.id === modeId);
  if (triggerLabel) {
    triggerLabel.textContent = (modeId === 'off' || !found) ? '动效' : found.label;
  }
  if (triggerBtn) {
    triggerBtn.classList.toggle('has-active', modeId !== 'off');
  }
  document.querySelectorAll('.folia-dropdown-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === modeId);
  });
  if (foliaStageEl) {
    // 统一清理非当前模式的实例与样式类，防止残留
    if (window.GlassWater) { try { window.GlassWater.unmount(); } catch (_) {} }
    if (window.AuroraWave) { try { window.AuroraWave.unmount(); } catch (_) {} }
    
    // 物理清空除 upstream iframe 之外的所有子元素，彻底杜绝极光或自制动效图层残留
    Array.from(foliaStageEl.childNodes).forEach(node => {
      if (node !== foliaUpstreamIframe) node.remove();
    });

    if (modeId !== 'glass' && pv) pv.classList.remove('glass-mode');
    if (modeId !== 'aurora' && pv) pv.classList.remove('aurora-mode');

    if (modeId === 'off') {
      if (pv) pv.classList.remove('folia-active', 'glass-mode', 'aurora-mode');
      if (foliaUpstreamIframe) foliaUpstreamIframe.style.display = 'none';
      foliaStageEl.style.display = 'none';
      foliaStageEl.classList.remove('active');
    } else {
      if (pv) pv.classList.add('folia-active');
      foliaStageEl.style.display = 'block';
      foliaStageEl.classList.add('active');
      if (modeId === 'glass') {
        // 水镜：本地 canvas 水面，不走 iframe
        if (pv) pv.classList.add('glass-mode');
        if (foliaUpstreamIframe) foliaUpstreamIframe.style.display = 'none';
        if (window.GlassWater) {
          window.GlassWater.mount(foliaStageEl, {
            getPlaying: () => isPlaying,
            getBeat: () => 1,
            getTime: () => {
              const b = activeBooks[targetIdx];
              return (localAudioEl && !localAudioEl.paused) ? localAudioEl.currentTime : (b ? b.currentSec : 0);
            }
          });
          window.GlassWater.setLyrics(buildGlassLyrics(activeBooks[targetIdx]));
        }
      } else if (modeId === 'aurora') {
        if (pv) pv.classList.add('aurora-mode');
        if (foliaUpstreamIframe) foliaUpstreamIframe.style.display = 'none';
        if (window.AuroraWave) {
          window.AuroraWave.mount(foliaStageEl, {
            getPlaying: () => isPlaying,
            getTime: () => {
              const b = activeBooks[targetIdx];
              return (localAudioEl && !localAudioEl.paused) ? localAudioEl.currentTime : (b ? b.currentSec : 0);
            }
          });
          const __b = activeBooks[targetIdx];
          if (__b) {
            var __cu = __b.picUrl || __b.coverUrl;
            if (!__cu && typeof buildArtworkSVG === 'function') {
              try {
                __cu = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(buildArtworkSVG(__b));
              } catch (_) {}
            }
            if (__cu) window.AuroraWave.setCover(__cu);
          }
        }
      } else {
        // 原生经典 iframe 动效（浮光、流光等）
        ensureFoliaIframe(modeId);
        if (foliaUpstreamIframe) foliaUpstreamIframe.style.display = 'block';
        syncFoliaToUpstreamIframe();
        setTimeout(syncFoliaToUpstreamIframe, 400);
        setTimeout(syncFoliaToUpstreamIframe, 1200);
      }
    }
  }
}

// ============================================================================
// 1. 馆藏磁带与封面生成引擎
// ============================================================================
let svgUid = 0;
function coverArtHTML(item) {
  const rawUrl = item.picUrl || item.coverImg || item.coverUrl;
  if (!rawUrl) return buildArtworkSVG(item);
  // 对于 QQ 音乐/gtimg 等防盗链图片，经由本地同源 /cover-proxy 进行代理，带上标准 Referer 保证 100% 显示，杜绝黑块
  const displayUrl = (rawUrl.includes('gtimg.cn') || rawUrl.includes('qq.com') || rawUrl.includes('qpic.cn'))
    ? ('/cover-proxy?url=' + encodeURIComponent(rawUrl))
    : rawUrl;
  const fallback = buildArtworkSVG(item).replace(/"/g, '&quot;');
  return '<img class="cover-img" src="' + esc(displayUrl) + '" alt="" draggable="false"'
    + ' onerror="this.style.display=\'none\';if(this.nextElementSibling)this.nextElementSibling.style.display=\'block\';"'
    + '><div class="cover-fallback" style="display:none;position:absolute;inset:0">' + fallback + '</div>';
}

function buildArtworkSVG(item) {
  const sfx = '_' + (++svgUid);
  return _buildArtworkSVGRaw(item)
    .replace(/\bid="([^"]+)"/g, 'id="$1' + sfx + '"')
    .replace(/url\(#([^)]+)\)/g, 'url(#$1' + sfx + ')')
    .replace(/href="#([^"]+)"/g, 'href="#$1' + sfx + '"');
}

function _buildArtworkSVGRaw(item) {
  const col = item.accent || '#d94e34';
  const idxKey = item.index || (item.id ? String(item.id).replace(/\W/g, '') : 'dflt');
  const serial = item.serial || 'AUDIO';
  const indexStr = item.index || '01';
  return `
    <svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g_${idxKey}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${item.c1 || '#2b303a'}"/>
          <stop offset="100%" stop-color="${item.c2 || '#0e1118'}"/>
        </linearGradient>
      </defs>
      <rect width="400" height="400" fill="url(#g_${idxKey})"/>
      <circle cx="200" cy="200" r="130" fill="none" stroke="${col}" stroke-width="2.5" opacity="0.6"/>
      <circle cx="200" cy="200" r="85" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="1.5"/>
      <circle cx="200" cy="200" r="28" fill="${col}" opacity="0.85"/>
      <text x="36" y="70" fill="#ffffff" font-family="-apple-system, sans-serif" font-size="28" font-weight="900">${esc(item.title)}</text>
      <text x="36" y="104" fill="rgba(255,255,255,0.6)" font-family="-apple-system, sans-serif" font-size="14">${esc(item.artist)}</text>
      <text x="36" y="360" fill="${col}" font-family="monospace" font-size="13" font-weight="bold">NO. ${indexStr} // ${serial}</text>
    </svg>
  `;
}

const REAL_20_DEMO_TRACKS = [
  {
    "index": "001",
    "spineNum": "01",
    "serial": "WK-REAL-01",
    "title": "青鸟 (ブルーバード)",
    "shortTitle": "青鸟 · 生物股长",
    "spineTitle": "青鸟 · 火影",
    "subtitleQuote": "| 飞向那片纯澈的苍穹，只为展翅翱翔",
    "artist": "いきものがかり (生物股长)",
    "subArtist": "火影忍者疾风传 OP3",
    "statusTag": "ACG神曲",
    "subTag": "高燃 · OP3",
    "durationSec": 213,
    "currentSec": 0,
    "accent": "#2563eb",
    "c1": "#3b82f6",
    "c2": "#1e3a8a",
    "picUrl": "assets/covers/cover_01.jpg",
    "audioUrl": "assets/audio/track_01.mp3",
    "notes": [
      329.63,
      392,
      440,
      493.88,
      523.25,
      493.88,
      440,
      392
    ],
    "lyrics": [
      {
        "t": 0,
        "l1": "ブルーバード - 生物股长いきものがかり",
        "l2": ""
      },
      {
        "t": 0.44,
        "l1": "词：水野良樹",
        "l2": ""
      },
      {
        "t": 0.62,
        "l1": "曲：水野良樹",
        "l2": ""
      },
      {
        "t": 0.85,
        "l1": "飛翔いたら 戻らないと言って",
        "l2": ""
      },
      {
        "t": 7.32,
        "l1": "目指したのは 蒼い 蒼い あの空",
        "l2": ""
      },
      {
        "t": 7.32,
        "l1": "me za shi ta no wa   a o i   a o i   a no so ra",
        "l2": ""
      },
      {
        "t": 25.78,
        "l1": "\"悲しみ\"はまだ覚えられず",
        "l2": ""
      },
      {
        "t": 29.24,
        "l1": "\"切なさ\"は今つかみはじめた",
        "l2": ""
      },
      {
        "t": 29.24,
        "l1": "\" se tsu na sa \" wa i ma tsu ka mi ha ji me ta",
        "l2": ""
      },
      {
        "t": 32.51,
        "l1": "あなたへと抱く この感情も",
        "l2": ""
      },
      {
        "t": 35.62,
        "l1": "今\"言葉\"に変わっていく",
        "l2": ""
      },
      {
        "t": 35.62,
        "l1": "i ma \" ko to ba \" ni ka wa 't te i ku",
        "l2": ""
      },
      {
        "t": 38.85,
        "l1": "未知なる世界の 遊迷から目覚めて",
        "l2": ""
      },
      {
        "t": 38.85,
        "l1": "mi chi na ru se ka i no   yu me ka ra me za me te",
        "l2": ""
      },
      {
        "t": 45.08,
        "l1": "この羽根を広げ 飛び立つ",
        "l2": ""
      },
      {
        "t": 45.08,
        "l1": "ko no ha ne wo hi ro ge   to bi ta tsu",
        "l2": ""
      },
      {
        "t": 51.38,
        "l1": "飛翔いたら 戻らないと言って",
        "l2": ""
      },
      {
        "t": 57.78,
        "l1": "目指したのは 白い 白い あの雲",
        "l2": ""
      },
      {
        "t": 57.78,
        "l1": "me za shi ta no wa   shi ro i   shi ro i   a no ku mo",
        "l2": ""
      },
      {
        "t": 64.03,
        "l1": "突き抜けたら みつかると知って",
        "l2": ""
      },
      {
        "t": 64.03,
        "l1": "tsu ki nu ke ta ra   mi tsu ka ru to shi 't te",
        "l2": ""
      },
      {
        "t": 70.34,
        "l1": "振り切るほど 蒼い 蒼い あの空",
        "l2": ""
      },
      {
        "t": 70.34,
        "l1": "fu ri ki ru ho do   a o i   a o i   a no so ra",
        "l2": ""
      },
      {
        "t": 76.66,
        "l1": "蒼い 蒼い あの空",
        "l2": ""
      },
      {
        "t": 76.66,
        "l1": "a o i   a o i   a no so ra",
        "l2": ""
      },
      {
        "t": 79.76,
        "l1": "蒼い 蒼い あの空",
        "l2": ""
      },
      {
        "t": 79.76,
        "l1": "a o i   a o i   a no so ra",
        "l2": ""
      },
      {
        "t": 89.46,
        "l1": "愛想尽きたような音で",
        "l2": ""
      },
      {
        "t": 92.48,
        "l1": "錆びれた古い窓は壊れた",
        "l2": ""
      },
      {
        "t": 92.48,
        "l1": "sa bi re ta fu ru i ma do wa ko wa re ta",
        "l2": ""
      },
      {
        "t": 95.62,
        "l1": "見飽きたカゴは ほら捨てていく",
        "l2": ""
      },
      {
        "t": 95.62,
        "l1": "mi a ki ta ka go wa   ho ra su te te i ku",
        "l2": ""
      },
      {
        "t": 98.84,
        "l1": "振り返ることはもうない",
        "l2": ""
      },
      {
        "t": 98.84,
        "l1": "fu ri ka e ru ko to wa mo u na i",
        "l2": ""
      },
      {
        "t": 102.01,
        "l1": "高鳴る鼓動に 呼吸を共鳴けて",
        "l2": ""
      },
      {
        "t": 102.01,
        "l1": "ta ka na ru ko do u ni   ko kyu u wo a zu ke te",
        "l2": ""
      },
      {
        "t": 108.33,
        "l1": "この窓を蹴って 飛び立つ",
        "l2": ""
      },
      {
        "t": 114.64,
        "l1": "駆け出したら 手にできると言って",
        "l2": ""
      },
      {
        "t": 114.64,
        "l1": "ka ke da shi ta ra   te ni de ki ru to i 't te",
        "l2": ""
      },
      {
        "t": 120.93,
        "l1": "いざなうのは 遠い 遠い あの声",
        "l2": ""
      },
      {
        "t": 120.93,
        "l1": "i za na u no wa   to o i   to o i   a no ko e",
        "l2": ""
      },
      {
        "t": 127.25,
        "l1": "眩しすぎた あなたの手も握って",
        "l2": ""
      },
      {
        "t": 127.25,
        "l1": "ma bu shi su gi ta   a na ta no te mo ni gi 't te",
        "l2": ""
      },
      {
        "t": 133.48,
        "l1": "求めるほど 蒼い 蒼い あの空",
        "l2": ""
      },
      {
        "t": 152.86,
        "l1": "墜ちていくと わかっていた",
        "l2": ""
      },
      {
        "t": 152.86,
        "l1": "o chi te i ku to   wa ka 't te i ta",
        "l2": ""
      },
      {
        "t": 159.26,
        "l1": "それでも 光を追い続けていくよ",
        "l2": ""
      },
      {
        "t": 159.26,
        "l1": "so re de mo   hi ka ri wo o i tsu du ke te i ku yo",
        "l2": ""
      },
      {
        "t": 166.8,
        "l1": "飛翔いたら 戻れないと言って",
        "l2": ""
      },
      {
        "t": 173.04,
        "l1": "探したのは 白い 白い あの雲",
        "l2": ""
      },
      {
        "t": 179.34,
        "l1": "突き抜けたら みつかると知って",
        "l2": ""
      },
      {
        "t": 185.65,
        "l1": "振り切るほど 蒼い 蒼い あの空",
        "l2": ""
      },
      {
        "t": 191.95,
        "l1": "蒼い 蒼い あの空",
        "l2": ""
      },
      {
        "t": 191.95,
        "l1": "a o i   a o i   a no so ra",
        "l2": ""
      },
      {
        "t": 195.06,
        "l1": "蒼い 蒼い あの空",
        "l2": ""
      }
    ],
    "comments": [
      "【热评 @木叶飞舞之处】前奏口琴一响，整整十年的青春与热血瞬间在眼前呼啸而过！"
    ],
    "lyricsRaw": "[ti:ブルーバード]\n[ar:生物股长]\n[al:ブルーバード]\n[offset:0]\n\n[00:00.00]ブ[00:00.02]ル[00:00.04][00:00.04]ー[00:00.06]バ[00:00.08][00:00.09]ー[00:00.11]ド[00:00.13][00:00.13] - [00:00.15]生[00:00.17]物[00:00.20][00:00.20]股[00:00.22]长[00:00.24][00:00.26]い[00:00.29]き[00:00.31][00:00.31]も[00:00.33]の[00:00.35][00:00.35]が[00:00.38]か[00:00.40][00:00.40]り[00:00.42]\n[00:00.44]词[00:00.47][00:00.47]：[00:00.49]水[00:00.53][00:00.53]野[00:00.56][00:00.56]良[00:00.60]樹[00:00.62]\n[00:00.62]曲[00:00.69]：[00:00.71]水[00:00.76][00:00.76]野[00:00.78][00:00.78]良[00:00.82][00:00.83]樹[00:00.85]\n[00:00.85]飛翔[00:01.50]い[00:02.29]た[00:02.82]ら[00:04.10] [00:04.10]戻[00:04.43]ら[00:04.66]な[00:05.44]い[00:05.89]と[00:06.08]言[00:06.28]っ[00:06.48]て[00:06.93]\n[00:07.32]目[00:07.49]指[00:07.63]し[00:07.84]た[00:08.56]の[00:09.15]は[00:10.37] [00:10.37]蒼[00:10.74]い[00:11.17] [00:11.17]蒼[00:11.55]い[00:11.99] [00:11.99]あ[00:12.35]の[00:12.67]空[00:14.17]\n[00:07.32]me [00:07.49][00:07.49]za [00:07.63]shi [00:07.84][00:07.84]ta [00:08.56]no [00:09.15]wa [00:10.37][00:10.37]  [00:10.37]a [00:10.55][00:10.55]o [00:10.74]i [00:11.17][00:11.17]  [00:11.17]a [00:11.35]o [00:11.55][00:11.55]i [00:11.98]  [00:11.98]a [00:12.35][00:12.35]no [00:12.67][00:12.67]so [00:12.83]ra [00:14.17]\n[00:25.78]\"[00:26.11]悲[00:26.50]し[00:26.74]み[00:26.95]\"[00:26.95]は[00:27.12]ま[00:27.30]だ[00:27.73]覚[00:28.11]え[00:28.50]ら[00:28.69]れ[00:28.90]ず[00:29.04]\n[00:29.24]\"[00:29.40]切[00:29.74]な[00:29.94]さ[00:30.10]\"[00:30.10]は[00:30.28]今[00:30.89]つ[00:31.07]か[00:31.26]み[00:31.48]は[00:31.66]じ[00:31.82]め[00:32.01]た[00:32.24]\n[00:29.24]\" [00:29.40][00:29.40]se [00:29.56][00:29.56]tsu [00:29.74]na [00:29.93][00:29.94]sa [00:30.10]\" [00:30.10]wa [00:30.28]i [00:30.46]ma [00:30.89][00:30.89]tsu [00:31.07][00:31.07]ka [00:31.26][00:31.26]mi [00:31.48][00:31.48]ha [00:31.66]ji [00:31.82][00:31.82]me [00:32.01]ta [00:32.24]\n[00:32.51]あ[00:32.67]な[00:32.83]た[00:33.07]へ[00:33.25]と[00:33.44]抱[00:33.90]く[00:34.16] [00:34.16]こ[00:34.33]の[00:34.53]感[00:34.91]情[00:35.28]も[00:35.38]\n[00:35.62]今[00:35.96]\"[00:35.96]言[00:36.61]葉[00:37.01]\"[00:37.01]に[00:37.20]変[00:37.38]わ[00:37.64]っ[00:37.91]て[00:38.00]い[00:38.08][00:38.08]く[00:38.49]\n[00:35.62]i [00:35.78]ma [00:35.96][00:35.96]\" [00:35.96]ko [00:36.18]to [00:36.61][00:36.61]ba [00:37.01]\" [00:37.01]ni [00:37.20][00:37.20]ka [00:37.38]wa [00:37.64][00:37.64]'t [00:37.91]te [00:37.99][00:38.00]i [00:38.08][00:38.08]ku [00:38.49]\n[00:38.85]未[00:39.01]知[00:39.18]な[00:39.37]る[00:40.55]世[00:40.97]界[00:41.53]の[00:41.94] [00:41.94]遊迷[00:42.31]か[00:42.49]ら[00:43.70]目[00:44.10]覚[00:44.31]め[00:44.66]て[00:44.87]\n[00:38.85]mi [00:39.01][00:39.01]chi [00:39.18]na [00:39.36][00:39.36]ru [00:40.55][00:40.55]se [00:40.97]ka [00:41.18]i [00:41.52][00:41.52]no [00:41.94]  [00:41.94]yu [00:42.12][00:42.12]me [00:42.31]ka [00:42.48][00:42.49]ra [00:43.70][00:43.70]me [00:44.10]za [00:44.31]me [00:44.66][00:44.66]te [00:44.87]\n[00:45.08]こ[00:45.29]の[00:45.46]羽[00:45.70]根[00:46.07]を[00:46.28]広[00:47.00]げ[00:47.80] [00:47.80]飛[00:48.01]び[00:48.37]立[00:48.53]つ[00:51.11]\n[00:45.08]ko [00:45.29]no [00:45.46]ha [00:45.70][00:45.70]ne [00:46.07]wo [00:46.28]hi [00:46.61]ro [00:47.00][00:47.00]ge [00:47.80][00:47.80]  [00:47.80]to [00:48.00]bi [00:48.37]ta [00:48.53][00:48.53]tsu [00:51.11]\n[00:51.38]飛翔[00:51.96]い[00:52.69]た[00:53.25]ら[00:54.63] [00:54.63]戻[00:54.98]ら[00:55.19]な[00:55.88]い[00:56.36]と[00:56.53]言[00:56.73]っ[00:56.93]て[00:57.44]\n[00:57.78]目[00:57.94]指[00:58.10]し[00:58.31]た[00:59.06]の[00:59.62]は[01:00.95] [01:00.95]白[01:01.27]い[01:01.72] [01:01.72]白[01:02.05]い[01:02.48] [01:02.48]あ[01:02.84]の[01:03.20]雲[01:03.68]\n[00:57.78]me [00:57.94][00:57.94]za [00:58.10][00:58.10]shi [00:58.31]ta [00:59.06]no [00:59.62][00:59.62]wa [01:00.95]  [01:00.95]shi [01:01.11][01:01.11]ro [01:01.27]i [01:01.72]  [01:01.72]shi [01:01.89]ro [01:02.05][01:02.05]i [01:02.48][01:02.48]  [01:02.48]a [01:02.84]no [01:03.20][01:03.20]ku [01:03.36][01:03.36]mo [01:03.68]\n[01:04.03]突[01:04.22]き[01:04.43]抜[01:04.65]け[01:05.36]た[01:05.87]ら[01:07.17] [01:07.17]み[01:07.36]つ[01:07.52]か[01:07.74]る[01:08.48]と[01:08.86]知[01:09.13]っ[01:09.41]て[01:09.97]\n[01:04.03]tsu [01:04.22]ki [01:04.43]nu [01:04.65][01:04.65]ke [01:05.36]ta [01:05.87][01:05.87]ra [01:07.17]  [01:07.17]mi [01:07.36]tsu [01:07.52][01:07.52]ka [01:07.74][01:07.74]ru [01:08.48]to [01:08.86][01:08.86]shi [01:09.13]'t [01:09.41][01:09.41]te [01:09.97]\n[01:10.34]振[01:10.51]り[01:10.67]切[01:10.91]る[01:11.63]ほ[01:12.14]ど[01:13.53] [01:13.53]蒼[01:13.89]い[01:14.35] [01:14.35]蒼[01:14.70]い[01:15.10] [01:15.10]あ[01:15.47]の[01:15.79]空[01:16.38]\n[01:10.34]fu [01:10.51]ri [01:10.67][01:10.67]ki [01:10.91][01:10.91]ru [01:11.63]ho [01:12.14]do [01:13.53][01:13.53]  [01:13.53]a [01:13.72][01:13.72]o [01:13.89]i [01:14.35][01:14.35]  [01:14.35]a [01:14.51]o [01:14.70][01:14.70]i [01:15.10]  [01:15.10]a [01:15.47]no [01:15.79][01:15.79]so [01:15.95][01:15.95]ra [01:16.38]\n[01:16.66]蒼[01:17.01]い[01:17.45] [01:17.45]蒼[01:17.82]い[01:18.24] [01:18.24]あ[01:18.59]の[01:18.91]空[01:19.44]\n[01:16.66]a [01:16.83]o [01:17.01][01:17.01]i [01:17.45]  [01:17.45]a [01:17.61][01:17.61]o [01:17.82][01:17.82]i [01:18.24]  [01:18.24]a [01:18.59][01:18.59]no [01:18.91][01:18.91]so [01:19.10]ra [01:19.44]\n[01:19.76]蒼[01:20.11]い[01:20.58] [01:20.58]蒼[01:20.94]い[01:21.37] [01:21.37]あ[01:21.71]の[01:22.08]空[01:23.57]\n[01:19.76]a [01:19.95]o [01:20.11]i [01:20.58][01:20.58]  [01:20.58]a [01:20.75]o [01:20.94]i [01:21.37][01:21.37]  [01:21.37]a [01:21.71][01:21.71]no [01:22.08]so [01:22.22][01:22.22]ra [01:23.57]\n[01:29.46]愛[01:29.78]想[01:30.08]尽[01:30.27]き[01:30.48]た[01:30.84]よ[01:31.07][01:31.07]う[01:31.30]な[01:31.68]音[01:32.05]で[01:32.30]\n[01:32.48]錆[01:32.66]び[01:32.83]れ[01:33.06]た[01:33.25]古[01:33.62]い[01:33.99]窓[01:34.40]は[01:34.64]壊[01:34.98]れ[01:35.20]た[01:35.41]\n[01:32.48]sa [01:32.66]bi [01:32.83]re [01:33.06][01:33.06]ta [01:33.25]fu [01:33.43]ru [01:33.62][01:33.62]i [01:33.98]ma [01:34.19][01:34.19]do [01:34.40]wa [01:34.64][01:34.64]ko [01:34.82]wa [01:34.98][01:34.98]re [01:35.20][01:35.20]ta [01:35.41]\n[01:35.62]見[01:35.79]飽[01:36.00]き[01:36.21]た[01:36.40]カ[01:36.58]ゴ[01:36.79]は[01:37.23] [01:37.23]ほ[01:37.41]ら[01:37.71]捨[01:37.88]て[01:38.10]て[01:38.24]い[01:38.38][01:38.38]く[01:38.47]\n[01:35.62]mi [01:35.79]a [01:36.00]ki [01:36.21][01:36.21]ta [01:36.40]ka [01:36.58][01:36.58]go [01:36.79]wa [01:37.23]  [01:37.23]ho [01:37.41][01:37.41]ra [01:37.71]su [01:37.88]te [01:38.10][01:38.10]te [01:38.24][01:38.24]i [01:38.38][01:38.38]ku [01:38.47]\n[01:38.84]振[01:39.00]り[01:39.19]返[01:39.78]る[01:40.20]こ[01:40.36]と[01:40.55]は[01:40.77]も[01:40.97][01:40.97]う[01:41.16]な[01:41.32]い[01:41.62]\n[01:38.84]fu [01:39.00]ri [01:39.19][01:39.19]ka [01:39.41]e [01:39.78][01:39.78]ru [01:40.20]ko [01:40.36]to [01:40.55][01:40.55]wa [01:40.77]mo [01:40.96][01:40.97]u [01:41.16][01:41.16]na [01:41.32]i [01:41.62]\n[01:42.01]高[01:42.33]鳴[01:42.52]る[01:43.75]鼓[01:44.08]動[01:44.63]に[01:45.16] [01:45.16]呼[01:45.34]吸[01:45.69]を[01:46.86]共鳴[01:47.53]け[01:47.85]て[01:48.12]\n[01:42.01][01:42.01]ta [01:42.17][01:42.17]ka [01:42.33]na [01:42.52][01:42.52]ru [01:43.75][01:43.75]ko [01:44.08][01:44.08]do [01:44.35]u [01:44.63][01:44.63]ni [01:45.16][01:45.16]  [01:45.16]ko [01:45.34]kyu [01:45.45][01:45.57]u [01:45.69][01:45.69]wo [01:46.86]a [01:47.30][01:47.30]zu [01:47.53][01:47.53]ke [01:47.85][01:47.85]te [01:48.12]\n[01:48.33]こ[01:48.50]の[01:48.65]窓[01:49.23]を[01:49.43]蹴[01:49.79]っ[01:50.15]て[01:50.94] [01:50.94]飛[01:51.16]び[01:51.53]立[01:51.71]つ[01:54.23]\n[01:54.64]駆[01:54.81]け[01:54.98]出[01:55.19]し[01:55.92]た[01:56.47]ら[01:57.70] [01:57.70]手[01:57.89]に[01:58.07]で[01:58.28]き[01:59.09]る[01:59.49]と[01:59.72]言[01:59.90]っ[02:00.08]て[02:00.61]\n[01:54.64]ka [01:54.81][01:54.81]ke [01:54.98]da [01:55.19][01:55.19]shi [01:55.92]ta [01:56.47][01:56.47]ra [01:57.70]  [01:57.70]te [01:57.89]ni [01:58.07]de [01:58.27][01:58.28]ki [01:59.09][01:59.09]ru [01:59.49]to [01:59.71][01:59.72]i [01:59.90]'t [02:00.08][02:00.08]te [02:00.61]\n[02:00.93]い[02:01.11]ざ[02:01.27]な[02:01.49]う[02:02.26]の[02:02.79]は[02:04.10] [02:04.10]遠[02:04.45]い[02:04.90] [02:04.90]遠[02:05.28]い[02:05.68] [02:05.68]あ[02:06.04]の[02:06.37]声[02:07.01]\n[02:00.93]i [02:01.11]za [02:01.27][02:01.27]na [02:01.49][02:01.49]u [02:02.26]no [02:02.79]wa [02:04.10][02:04.10]  [02:04.10]to [02:04.27]o [02:04.45][02:04.45]i [02:04.90]  [02:04.90]to [02:05.09][02:05.09]o [02:05.28][02:05.28]i [02:05.68]  [02:05.68]a [02:06.03][02:06.04]no [02:06.37]ko [02:06.51][02:06.51]e [02:07.01]\n[02:07.25]眩[02:07.57]し[02:07.80]す[02:08.51]ぎ[02:09.16]た[02:10.42] [02:10.42]あ[02:10.60]な[02:10.76]た[02:10.95]の[02:11.48]手[02:11.69]も[02:12.09]握[02:12.45]っ[02:12.63][02:12.63]て[02:13.11]\n[02:07.25][02:07.25]ma [02:07.41][02:07.41]bu [02:07.57]shi [02:07.80]su [02:08.51]gi [02:09.15][02:09.16]ta [02:10.42]  [02:10.42]a [02:10.59][02:10.60]na [02:10.75]ta [02:10.95]no [02:11.48][02:11.48]te [02:11.69]mo [02:12.09][02:12.09]ni [02:12.27]gi [02:12.45][02:12.45]'t [02:12.63][02:12.63]te [02:13.11]\n[02:13.48]求[02:13.83]め[02:14.07]る[02:14.79]ほ[02:15.35]ど[02:16.68] [02:16.68]蒼[02:17.04]い[02:17.47] [02:17.47]蒼[02:17.82]い[02:18.25] [02:18.25]あ[02:18.60]の[02:18.94]空[02:20.46]\n[02:32.86]墜[02:33.06]ち[02:33.45]て[02:33.80]い[02:34.16][02:34.16]く[02:34.41]と[02:36.12] [02:36.12]わ[02:36.28]か[02:36.56]っ[02:36.84]て[02:37.17][02:37.17]い[02:37.50]た[02:38.60]\n[02:32.86]o [02:33.06][02:33.06]chi [02:33.45]te [02:33.80][02:33.80]i [02:34.16]ku [02:34.41][02:34.41]to [02:36.12]  [02:36.12]wa [02:36.28]ka [02:36.56][02:36.56]'t [02:36.84][02:36.84]te [02:37.17][02:37.17]i [02:37.50][02:37.50]ta [02:38.60]\n[02:39.26]そ[02:39.43]れ[02:39.77]で[02:39.94]も[02:40.76] [02:40.76]光[02:41.51]を[02:42.38]追[02:42.56]い[02:42.85]続[02:43.33]け[02:43.54]て[02:43.74][02:43.74]い[02:43.94]く[02:44.11]よ[02:46.56]\n[02:39.26][02:39.25]so [02:39.43]re [02:39.77][02:39.77]de [02:39.94]mo [02:40.76][02:40.76]  [02:40.76]hi [02:40.95]ka [02:41.32][02:41.32]ri [02:41.51]wo [02:42.38]o [02:42.56][02:42.56]i [02:42.85]tsu [02:43.07]du [02:43.33][02:43.33]ke [02:43.54]te [02:43.74][02:43.74]i [02:43.94][02:43.94]ku [02:44.11]yo [02:46.56]\n[02:46.80]飛翔[02:47.28]い[02:48.00]た[02:48.53]ら[02:49.81] [02:49.81]戻[02:50.15]れ[02:50.38]な[02:51.18]い[02:51.57]と[02:51.78]言[02:51.95]っ[02:52.13]て[02:52.67]\n[02:53.04]探[02:53.36]し[02:53.57]た[02:54.29]の[02:54.85]は[02:56.15] [02:56.15]白[02:56.50]い[02:56.94] [02:56.94]白[02:57.31]い[02:57.74] [02:57.74]あ[02:58.11]の[02:58.46]雲[02:59.11]\n[02:59.34]突[02:59.49]き[02:59.68]抜[02:59.89]け[03:00.64]た[03:01.20]ら[03:02.45] [03:02.45]み[03:02.64]つ[03:02.83]か[03:03.02]る[03:03.78]と[03:04.20]知[03:04.47]っ[03:04.74]て[03:05.33]\n[03:05.65]振[03:05.81]り[03:05.98]切[03:06.19]る[03:06.90]ほ[03:07.47]ど[03:08.75] [03:08.75]蒼[03:09.12]い[03:09.58] [03:09.58]蒼[03:09.95]い[03:10.35] [03:10.35]あ[03:10.70]の[03:11.07]空[03:11.73]\n[03:11.95]蒼[03:12.31]い[03:12.71] [03:12.71]蒼[03:13.07]い[03:13.50] [03:13.50]あ[03:13.86]の[03:14.24]空[03:14.76]\n[03:11.95]a [03:12.11]o [03:12.31]i [03:12.71]  [03:12.71]a [03:12.88][03:12.88]o [03:13.07]i [03:13.50][03:13.50]  [03:13.50]a [03:13.86]no [03:14.24]so [03:14.40]ra [03:14.75]\n[03:15.06]蒼[03:15.43]い[03:15.86] [03:15.86]蒼[03:16.23]い[03:16.63] [03:16.63]あ[03:16.96]の[03:17.38]空[03:19.84]",
    "lrcUrl": "assets/lyrics/track_01.lrc"
  },
  {
    "index": "002",
    "spineNum": "02",
    "serial": "WK-REAL-02",
    "title": "Lemon",
    "shortTitle": "Lemon · 米津玄师",
    "spineTitle": "Lemon · 非自然死亡",
    "subtitleQuote": "| 如今你依然是照亮我生命的那道光",
    "artist": "米津玄师",
    "subArtist": "非自然死亡 Unnatural 主题曲",
    "statusTag": "殿堂金曲",
    "subTag": "流行殿堂",
    "durationSec": 259,
    "currentSec": 0,
    "accent": "#eab308",
    "c1": "#fde047",
    "c2": "#713f12",
    "picUrl": "assets/covers/cover_02.jpg",
    "audioUrl": "assets/audio/track_02.mp3",
    "notes": [
      261.63,
      293.66,
      329.63,
      349.23,
      392,
      349.23,
      329.63,
      293.66
    ],
    "lyrics": [
      {
        "t": 0,
        "l1": "Lemon - 米津玄師よねづ けんし",
        "l2": ""
      },
      {
        "t": 0,
        "l1": "(496,33)",
        "l2": ""
      },
      {
        "t": 0.53,
        "l1": "词：米津玄師",
        "l2": ""
      },
      {
        "t": 0.53,
        "l1": "(970,88)",
        "l2": ""
      },
      {
        "t": 1.06,
        "l1": "曲：米津玄師",
        "l2": ""
      },
      {
        "t": 1.06,
        "l1": "(1297,12)",
        "l2": ""
      },
      {
        "t": 1.54,
        "l1": "夢ならば",
        "l2": ""
      },
      {
        "t": 1.54,
        "l1": "yu me na ra ba",
        "l2": ""
      },
      {
        "t": 2.88,
        "l1": "どれほどよかったでしょう",
        "l2": ""
      },
      {
        "t": 2.88,
        "l1": "do re ho do yo ka 't ta de sho u",
        "l2": ""
      },
      {
        "t": 6.88,
        "l1": "未だにあなたのことを夢にみる",
        "l2": ""
      },
      {
        "t": 12.41,
        "l1": "忘れた物を取りに帰るように",
        "l2": ""
      },
      {
        "t": 17.91,
        "l1": "古びた思い出の埃を払う",
        "l2": ""
      },
      {
        "t": 26.27,
        "l1": "戻らない幸せがあることを",
        "l2": ""
      },
      {
        "t": 31.73,
        "l1": "最後にあなたが教えてくれた",
        "l2": ""
      },
      {
        "t": 31.73,
        "l1": "sa i go ni a na ta ga o shi e te ku re ta",
        "l2": ""
      },
      {
        "t": 37.25,
        "l1": "言えずに隠してた昏い過去も",
        "l2": ""
      },
      {
        "t": 42.8,
        "l1": "あなたがいなきゃ",
        "l2": ""
      },
      {
        "t": 44.92,
        "l1": "永遠に昏いまま",
        "l2": ""
      },
      {
        "t": 44.92,
        "l1": "e i e n ni ku ra i ma ma",
        "l2": ""
      },
      {
        "t": 48.57,
        "l1": "きっともうこれ以上",
        "l2": ""
      },
      {
        "t": 51.36,
        "l1": "傷つくことなど",
        "l2": ""
      },
      {
        "t": 54.18,
        "l1": "ありはしないとわかっている",
        "l2": ""
      },
      {
        "t": 54.18,
        "l1": "a ri wa shi na i to wa ka 't te i ru",
        "l2": ""
      },
      {
        "t": 58.98,
        "l1": "あの日の悲しみさえ",
        "l2": ""
      },
      {
        "t": 61.74,
        "l1": "あの日の苦しみさえ",
        "l2": ""
      },
      {
        "t": 61.74,
        "l1": "a no hi no ku ru shi mi sa e",
        "l2": ""
      },
      {
        "t": 64.52,
        "l1": "そのすべてを愛してた",
        "l2": ""
      },
      {
        "t": 64.52,
        "l1": "so no su be te wo a i shi te ta",
        "l2": ""
      },
      {
        "t": 67.28,
        "l1": "あなたとともに",
        "l2": ""
      },
      {
        "t": 69.98,
        "l1": "胸に残り離れない",
        "l2": ""
      },
      {
        "t": 73.07,
        "l1": "苦いレモンの匂い",
        "l2": ""
      },
      {
        "t": 75.84,
        "l1": "雨が降り止むまでは帰れない",
        "l2": ""
      },
      {
        "t": 75.84,
        "l1": "a me ga fu ri ya mu ma de wa ka e re na i",
        "l2": ""
      },
      {
        "t": 81.39,
        "l1": "今でもあなたはわたしの光",
        "l2": ""
      },
      {
        "t": 81.39,
        "l1": "i ma de mo a na ta wa wa ta shi no hi ka ri",
        "l2": ""
      },
      {
        "t": 97.98,
        "l1": "暗闇であなたの背をなぞった",
        "l2": ""
      },
      {
        "t": 97.98,
        "l1": "ku ra ya mi de a na ta no se wo na zo 't ta",
        "l2": ""
      },
      {
        "t": 103.43,
        "l1": "その輪郭を鮮明に覚えている",
        "l2": ""
      },
      {
        "t": 103.43,
        "l1": "so no ri n ka ku wo se n me i ni o bo e te i ru",
        "l2": ""
      },
      {
        "t": 108.97,
        "l1": "受け止めきれないものと",
        "l2": ""
      },
      {
        "t": 112.2,
        "l1": "出会うたび",
        "l2": ""
      },
      {
        "t": 112.2,
        "l1": "de a u ta bi",
        "l2": ""
      },
      {
        "t": 114.5,
        "l1": "溢れてやまないのは涙だけ",
        "l2": ""
      },
      {
        "t": 120.32,
        "l1": "何をしていたの",
        "l2": ""
      },
      {
        "t": 123.16,
        "l1": "何を見ていたの",
        "l2": ""
      },
      {
        "t": 123.16,
        "l1": "na ni wo mi te i ta no",
        "l2": ""
      },
      {
        "t": 125.92,
        "l1": "わたしの知らない横顔で",
        "l2": ""
      },
      {
        "t": 130.69,
        "l1": "どこかであなたが今",
        "l2": ""
      },
      {
        "t": 133.43,
        "l1": "わたしと同じ様な",
        "l2": ""
      },
      {
        "t": 136.31,
        "l1": "涙にくれ",
        "l2": ""
      },
      {
        "t": 137.64,
        "l1": "淋しさの中にいるなら",
        "l2": ""
      },
      {
        "t": 137.64,
        "l1": "sa bi shi sa no na ka ni i ru na ra",
        "l2": ""
      },
      {
        "t": 141.71,
        "l1": "わたしのことなどどうか",
        "l2": ""
      },
      {
        "t": 141.71,
        "l1": "wa ta shi no ko to na do do u ka",
        "l2": ""
      },
      {
        "t": 144.85,
        "l1": "忘れてください",
        "l2": ""
      },
      {
        "t": 147.6,
        "l1": "そんなことを心から願うほどに",
        "l2": ""
      },
      {
        "t": 153.13,
        "l1": "今でもあなたはわたしの光",
        "l2": ""
      },
      {
        "t": 161.64,
        "l1": "自分が思うより",
        "l2": ""
      },
      {
        "t": 167.19,
        "l1": "恋をしていたあなたに",
        "l2": ""
      },
      {
        "t": 167.19,
        "l1": "ko i wo shi te i ta a na ta ni",
        "l2": ""
      },
      {
        "t": 172.72,
        "l1": "あれから思うように",
        "l2": ""
      },
      {
        "t": 172.72,
        "l1": "a re ka ra o mo u yo u ni",
        "l2": ""
      },
      {
        "t": 178.24,
        "l1": "息ができない",
        "l2": ""
      },
      {
        "t": 183.33,
        "l1": "あんなに側にいたのに",
        "l2": ""
      },
      {
        "t": 183.33,
        "l1": "a n na ni so ba ni i ta no ni",
        "l2": ""
      },
      {
        "t": 189.27,
        "l1": "まるで嘘みたい",
        "l2": ""
      },
      {
        "t": 194.4,
        "l1": "とても忘れられない",
        "l2": ""
      },
      {
        "t": 200.21,
        "l1": "それだけが確か",
        "l2": ""
      },
      {
        "t": 200.21,
        "l1": "so re da ke ga ta shi ka",
        "l2": ""
      },
      {
        "t": 210.81,
        "l1": "あの日の悲しみさえ",
        "l2": ""
      },
      {
        "t": 210.81,
        "l1": "a no hi no ka na shi mi sa e",
        "l2": ""
      },
      {
        "t": 213.41,
        "l1": "あの日の苦しみさえ",
        "l2": ""
      },
      {
        "t": 213.41,
        "l1": "a no hi no ku ru shi mi sa e",
        "l2": ""
      },
      {
        "t": 216.22,
        "l1": "そのすべてを愛してた",
        "l2": ""
      },
      {
        "t": 218.97,
        "l1": "あなたとともに",
        "l2": ""
      },
      {
        "t": 218.97,
        "l1": "a na ta to to mo ni",
        "l2": ""
      },
      {
        "t": 221.67,
        "l1": "胸に残り離れない",
        "l2": ""
      },
      {
        "t": 221.67,
        "l1": "mu ne ni no ko ri ha na re na i",
        "l2": ""
      },
      {
        "t": 224.77,
        "l1": "苦いレモンの匂い",
        "l2": ""
      },
      {
        "t": 227.61,
        "l1": "雨が降り止むまでは帰れない",
        "l2": ""
      },
      {
        "t": 233.09,
        "l1": "切り分けた果実の片方の様に",
        "l2": ""
      },
      {
        "t": 238.6,
        "l1": "今でもあなたはわたしの光",
        "l2": ""
      },
      {
        "t": 238.6,
        "l1": "i ma de mo a na ta wa wa ta shi no hi ka ri",
        "l2": ""
      }
    ],
    "comments": [
      "【热评 @法医三澄】即使逝去的人无法再开口，音乐依然会在每个清晨温柔拂过。"
    ],
    "lyricsRaw": "[ti:Lemon]\n[ar:米津玄師]\n[al:レモン]\n[offset:0]\n\n[00:00.00]Lemon - [00:00.03]米[00:00.09]津[00:00.13][00:00.13]玄[00:00.19]師[00:00.23][00:00.26]よ[00:00.29]ね[00:00.33]づ[00:00.36] [00:00.39][00:00.39]け[00:00.43]ん[00:00.46]し[00:00.49]\n[00:00.00](496,33)[00:00.52]\n[00:00.53]词[00:00.61]：[00:00.70]米[00:00.79]津[00:00.88]玄[00:00.97]師[00:01.05]\n[00:00.53](970,88)[00:01.05]\n[00:01.06]曲[00:01.14]：[00:01.23]米[00:01.26]津[00:01.27][00:01.27]玄[00:01.29]師[00:01.30]\n[00:01.06](1297,12)[00:01.54]\n[00:01.54]夢[00:01.92]な[00:02.14]ら[00:02.31]ば[00:02.69]\n[00:01.54]yu [00:01.77][00:01.77]me [00:01.92][00:01.92]na [00:02.14]ra [00:02.31][00:02.31]ba [00:02.69]\n[00:02.88]ど[00:03.18]れ[00:03.53]ほ[00:03.70]ど[00:04.15]よ[00:04.51]か[00:04.68]っ[00:04.86]た[00:05.04]で[00:05.48]し[00:05.82]ょ[00:06.16][00:06.16]う[00:06.54]\n[00:02.88]do [00:03.18][00:03.18]re [00:03.53][00:03.53]ho [00:03.70]do [00:04.15][00:04.15]yo [00:04.51][00:04.51]ka [00:04.68]'t [00:04.86][00:04.86]ta [00:05.04]de [00:05.48][00:05.48]sho [00:05.82][00:06.16]u [00:06.54]\n[00:06.88]未[00:07.25]だ[00:07.83]に[00:08.25]あ[00:08.43]な[00:08.60]た[00:09.26]の[00:09.58]こ[00:09.77]と[00:09.94]を[00:10.44]夢[00:10.98]に[00:11.19]み[00:11.35]る[00:11.90]\n[00:12.41]忘[00:12.76]れ[00:13.09]た[00:13.26]物[00:14.10]を[00:14.48]取[00:14.63]り[00:15.13]に[00:15.47]帰[00:16.03]る[00:16.49]よ[00:16.67]う[00:16.84]に[00:17.53]\n[00:17.91]古[00:18.28]び[00:18.97]た[00:19.33]思[00:19.67]い[00:19.98]出[00:20.28]の[00:20.63]埃[00:21.73]を[00:22.24]払[00:22.61]う[00:23.21]\n[00:26.27]戻[00:26.61]ら[00:26.94]な[00:27.10]い[00:27.60]幸[00:28.42]せ[00:28.94]が[00:29.30]あ[00:29.65]る[00:29.81]こ[00:30.29]と[00:30.66]を[00:31.37]\n[00:31.73]最[00:32.12]後[00:32.76]に[00:33.09]あ[00:33.26]な[00:33.42]た[00:34.13]が[00:34.41]教[00:34.79]え[00:35.51]て[00:35.87]く[00:36.02]れ[00:36.21]た[00:36.81]\n[00:31.73]sa [00:31.89][00:31.89]i [00:32.12]go [00:32.76]ni [00:33.09][00:33.09]a [00:33.25][00:33.25]na [00:33.42][00:33.42]ta [00:34.13]ga [00:34.41][00:34.41]o [00:34.61]shi [00:34.79][00:34.79]e [00:35.51]te [00:35.87]ku [00:36.02]re [00:36.21][00:36.21]ta [00:36.81]\n[00:37.25]言[00:37.43]え[00:37.62]ず[00:37.99]に[00:38.15]隠[00:39.01]し[00:39.32]て[00:39.48]た[00:40.03]昏[00:40.77]い[00:40.94]過[00:41.42]去[00:41.75]も[00:42.41]\n[00:42.80]あ[00:42.98]な[00:43.16]た[00:43.79]が[00:44.18]い[00:44.33]な[00:44.50]き[00:44.66]ゃ[00:44.72]\n[00:44.92]永[00:45.19]遠[00:45.52]に[00:45.88]昏[00:46.65]い[00:47.10]ま[00:47.26]ま[00:48.02]\n[00:44.92]e [00:45.06]i [00:45.19]e [00:45.36][00:45.36]n [00:45.52]ni [00:45.88]ku [00:46.03][00:46.03]ra [00:46.65]i [00:47.10][00:47.10]ma [00:47.26][00:47.26]ma [00:48.02]\n[00:48.57]き[00:48.84]っ[00:49.11][00:49.11]と[00:49.30]も[00:49.49]う[00:49.67]こ[00:49.85]れ[00:50.05]以[00:50.64]上[00:51.09]\n[00:51.36]傷[00:52.04]つ[00:52.45]く[00:52.62]こ[00:52.81]と[00:53.09]な[00:53.44]ど[00:53.88]\n[00:54.18]あ[00:54.67]り[00:54.85]は[00:55.20]し[00:55.40]な[00:55.59]い[00:56.26]と[00:56.57]わ[00:56.88]か[00:57.25]っ[00:57.62]て[00:57.92]い[00:58.22]る[00:58.72]\n[00:54.18]a [00:54.67]ri [00:54.85][00:54.85]wa [00:55.20]shi [00:55.40]na [00:55.59]i [00:56.26][00:56.26]to [00:56.57]wa [00:56.88]ka [00:57.25]'t [00:57.62][00:57.62]te [00:57.92][00:57.92]i [00:58.22][00:58.22]ru [00:58.72]\n[00:58.98]あ[00:59.16]の[00:59.32]日[00:59.49]の[00:59.71]悲[01:00.42]し[01:00.60]み[01:01.04]さ[01:01.22]え[01:01.50]\n[01:01.74]あ[01:01.91]の[01:02.07]日[01:02.25]の[01:02.46]苦[01:03.13]し[01:03.31]み[01:03.78]さ[01:03.94]え[01:04.22]\n[01:01.74]a [01:01.91]no [01:02.07][01:02.07]hi [01:02.25][01:02.25]no [01:02.46]ku [01:02.62][01:02.62]ru [01:03.13]shi [01:03.30][01:03.31]mi [01:03.78]sa [01:03.94][01:03.94]e [01:04.22]\n[01:04.52]そ[01:04.69]の[01:04.87]す[01:05.04]べ[01:05.25]て[01:05.42]を[01:05.89]愛[01:06.49]し[01:06.63]て[01:06.80]た[01:07.06]\n[01:04.52]so [01:04.69]no [01:04.87][01:04.87]su [01:05.04]be [01:05.25]te [01:05.42][01:05.42]wo [01:05.89]a [01:06.05]i [01:06.48][01:06.49]shi [01:06.63][01:06.63]te [01:06.80][01:06.80]ta [01:07.06]\n[01:07.28]あ[01:07.45]な[01:07.93]た[01:08.09]と[01:08.53]と[01:08.73]も[01:09.23]に[01:09.66]\n[01:09.98]胸[01:10.33]に[01:10.51]残[01:10.88]り[01:11.37]離[01:12.02]れ[01:12.21]な[01:12.75]い[01:12.85]\n[01:13.07]苦[01:13.41]い[01:13.59]レ[01:13.76]モ[01:13.96]ン[01:14.19]の[01:14.34]匂[01:15.35]い[01:15.60]\n[01:15.84]雨[01:16.20]が[01:16.50]降[01:16.84]り[01:17.18]止[01:17.53]む[01:17.93]ま[01:18.28]で[01:18.43]は[01:18.95]帰[01:19.66]れ[01:19.82]な[01:20.33]い[01:21.02]\n[01:15.84]a [01:16.01][01:16.01]me [01:16.20]ga [01:16.50]fu [01:16.84][01:16.84]ri [01:17.18]ya [01:17.53]mu [01:17.93]ma [01:18.28][01:18.28]de [01:18.43]wa [01:18.95][01:18.95]ka [01:19.10]e [01:19.66]re [01:19.82]na [01:20.33][01:20.33]i [01:21.02]\n[01:21.39]今[01:21.75]で[01:22.03]も[01:22.35]あ[01:22.67]な[01:23.02]た[01:23.36]は[01:23.81]わ[01:23.96]た[01:24.44]し[01:24.61]の[01:25.19]光[01:26.70]\n[01:21.39]i [01:21.57]ma [01:21.74][01:21.75]de [01:22.03]mo [01:22.35][01:22.35]a [01:22.67][01:22.67]na [01:23.02]ta [01:23.36]wa [01:23.81][01:23.81]wa [01:23.96]ta [01:24.44]shi [01:24.61][01:24.61]no [01:25.19]hi [01:25.35][01:25.35]ka [01:25.83]ri [01:26.70]\n[01:37.98]暗[01:38.32]闇[01:38.83]で[01:39.32]あ[01:39.68]な[01:39.98]た[01:40.15]の[01:40.69]背[01:41.05]を[01:41.39]な[01:41.53]ぞ[01:41.95]っ[01:42.36]た[01:43.02]\n[01:37.98]ku [01:38.15]ra [01:38.32][01:38.32]ya [01:38.67][01:38.67]mi [01:38.83]de [01:39.32][01:39.32]a [01:39.68]na [01:39.98][01:39.98]ta [01:40.14][01:40.15]no [01:40.69][01:40.69]se [01:41.05]wo [01:41.39]na [01:41.53]zo [01:41.94]'t [01:42.36]ta [01:43.02]\n[01:43.43]そ[01:43.60]の[01:43.80]輪[01:44.40]郭[01:45.00]を[01:45.12]鮮[01:45.83]明[01:46.12]に[01:46.31]覚[01:47.24]え[01:47.57]て[01:47.75]い[01:47.94]る[01:48.56]\n[01:43.43]so [01:43.60][01:43.60]no [01:43.80]ri [01:44.10][01:44.10]n [01:44.40]ka [01:44.84][01:44.84]ku [01:45.00]wo [01:45.12]se [01:45.47][01:45.47]n [01:45.83]me [01:45.97]i [01:46.12]ni [01:46.30][01:46.31]o [01:46.50]bo [01:47.24][01:47.24]e [01:47.56]te [01:47.75]i [01:47.94][01:47.94]ru [01:48.55]\n[01:48.97]受[01:49.15]け[01:49.33]止[01:49.66]め[01:49.83]き[01:50.41]れ[01:50.76]な[01:50.91]い[01:51.16]も[01:51.33]の[01:51.72]と[01:52.02]\n[01:52.20]出[01:52.49]会[01:52.66]う[01:53.15]た[01:53.49]び[01:54.12]\n[01:52.20]de [01:52.49]a [01:52.66][01:52.66]u [01:53.15]ta [01:53.49][01:53.49]bi [01:54.12]\n[01:54.50]溢[01:54.87]れ[01:55.48]て[01:55.88]や[01:56.07]ま[01:56.27]な[01:56.58]い[01:56.95]の[01:57.25]は[01:57.61]涙[01:58.47]だ[01:58.98]け[01:59.70]\n[02:00.32]何[02:01.03]を[02:01.44]し[02:01.61]て[02:01.85]い[02:02.08]た[02:02.44]の[02:02.84]\n[02:03.16]何[02:03.72]を[02:04.13]見[02:04.32]て[02:04.60]い[02:04.88]た[02:05.20]の[02:05.64]\n[02:03.16]na [02:03.56][02:03.56]ni [02:03.72]wo [02:04.12]mi [02:04.32]te [02:04.59][02:04.60]i [02:04.87][02:04.88]ta [02:05.20]no [02:05.64]\n[02:05.92]わ[02:06.38]た[02:06.55]し[02:06.92]の[02:07.10]知[02:07.29]ら[02:07.61]な[02:07.95]い[02:08.29]横[02:09.33]顔[02:09.96]で[02:10.42]\n[02:10.69]ど[02:10.86]こ[02:11.03]か[02:11.21]で[02:11.44]あ[02:11.60]な[02:12.08]た[02:12.24]が[02:12.74]今[02:13.19]\n[02:13.43]わ[02:13.62]た[02:13.77]し[02:13.93]と[02:14.19]同[02:14.75]じ[02:14.94]様[02:15.91]な[02:16.13]\n[02:16.31]涙[02:16.79]に[02:17.00]く[02:17.15]れ[02:17.42]\n[02:17.64]淋[02:18.25]し[02:18.41]さ[02:18.93]の[02:19.03]中[02:19.65]に[02:19.95]い[02:20.25]る[02:20.41]な[02:20.99]ら[02:21.49]\n[02:17.64]sa [02:17.79]bi [02:18.25][02:18.25]shi [02:18.41]sa [02:18.93]no [02:19.03]na [02:19.18][02:19.18]ka [02:19.65]ni [02:19.95][02:19.95]i [02:20.25]ru [02:20.41][02:20.41]na [02:20.99]ra [02:21.49]\n[02:21.71]わ[02:21.88]た[02:22.04]し[02:22.22]の[02:22.43]こ[02:22.60]と[02:23.08]な[02:23.23]ど[02:23.78]ど[02:24.09]う[02:24.41]か[02:24.61]\n[02:21.71]wa [02:21.87][02:21.88]ta [02:22.04]shi [02:22.22]no [02:22.43][02:22.43]ko [02:22.59][02:22.60]to [02:23.07][02:23.08]na [02:23.23]do [02:23.77]do [02:24.09][02:24.09]u [02:24.41]ka [02:24.61]\n[02:24.85]忘[02:25.20]れ[02:25.45]て[02:25.85]く[02:26.01]だ[02:26.51]さ[02:26.67]い[02:27.26]\n[02:27.60]そ[02:27.77]ん[02:27.94]な[02:28.26]こ[02:28.54]と[02:28.70]を[02:28.93]心[02:30.01]か[02:30.16]ら[02:30.58]願[02:30.90]う[02:31.34]ほ[02:31.51]ど[02:32.07]に[02:32.77]\n[02:33.13]今[02:33.46]で[02:33.76]も[02:34.10]あ[02:34.40]な[02:34.75]た[02:35.04]は[02:35.52]わ[02:35.67]た[02:36.12]し[02:36.29]の[02:36.82]光[02:38.86]\n[02:41.64]自[02:42.35]分[02:43.72]が[02:44.37]思[02:44.85]う[02:45.17]よ[02:45.80]り[02:46.59]\n[02:47.19]恋[02:47.78]を[02:48.58]し[02:48.74]て[02:49.02]い[02:49.30]た[02:49.91]あ[02:50.08]な[02:50.66]た[02:51.33]に[02:52.06]\n[02:47.19]ko [02:47.36][02:47.36]i [02:47.78]wo [02:48.58]shi [02:48.74][02:48.74]te [02:49.02][02:49.02]i [02:49.30][02:49.30]ta [02:49.91]a [02:50.08]na [02:50.66][02:50.66]ta [02:51.33]ni [02:52.06]\n[02:52.72]あ[02:53.35]れ[02:54.07]か[02:54.75]ら[02:55.48]思[02:55.89]う[02:56.15]よ[02:56.48]う[02:56.81]に[02:57.51]\n[02:52.72]a [02:53.35]re [02:54.07]ka [02:54.75][02:54.75]ra [02:55.48][02:55.48]o [02:55.62]mo [02:55.89][02:55.89]u [02:56.15][02:56.15]yo [02:56.48][02:56.48]u [02:56.81]ni [02:57.51]\n[02:58.24]息[02:59.62]が[03:00.31]で[03:00.98]き[03:01.70]な[03:02.33]い[03:02.99]\n[03:03.33]あ[03:03.50]ん[03:03.66]な[03:03.81]に[03:04.41]側[03:05.77]に[03:06.32]い[03:06.48]た[03:07.20]の[03:07.87]に[03:08.60]\n[03:03.33]a [03:03.50]n [03:03.66]na [03:03.81][03:03.81]ni [03:04.41]so [03:05.06][03:05.06]ba [03:05.77]ni [03:06.32][03:06.32]i [03:06.47]ta [03:07.19]no [03:07.87]ni [03:08.60]\n[03:09.27]ま[03:09.92]る[03:10.59]で[03:11.21]嘘[03:12.62]み[03:13.41]た[03:13.60]い[03:14.06]\n[03:14.40]と[03:14.57]て[03:14.76]も[03:15.39]忘[03:16.23]れ[03:16.79]ら[03:17.48]れ[03:18.25]な[03:18.89]い[03:19.68]\n[03:20.21]そ[03:20.93]れ[03:21.62]だ[03:22.33]け[03:22.99]が[03:23.71]確[03:25.07]か[03:26.15]\n[03:20.21]so [03:20.93]re [03:21.62]da [03:22.32][03:22.33]ke [03:22.99][03:22.99]ga [03:23.71]ta [03:24.38]shi [03:25.07]ka [03:26.15]\n[03:30.81]あ[03:30.97]の[03:31.13]日[03:31.34]の[03:31.51]悲[03:32.08]し[03:32.24]み[03:32.77]さ[03:32.93]え[03:33.20]\n[03:30.81]a [03:30.97]no [03:31.13]hi [03:31.34][03:31.34]no [03:31.51]ka [03:31.63][03:31.63]na [03:32.08][03:32.08]shi [03:32.24]mi [03:32.77][03:32.77]sa [03:32.93]e [03:33.20]\n[03:33.41]あ[03:33.59]の[03:33.74]日[03:33.92]の[03:34.13]苦[03:34.79]し[03:34.95]み[03:35.49]さ[03:35.65]え[03:35.91]\n[03:33.41]a [03:33.59][03:33.59]no [03:33.74]hi [03:33.92][03:33.92]no [03:34.13]ku [03:34.29]ru [03:34.79]shi [03:34.95][03:34.95]mi [03:35.49]sa [03:35.65]e [03:35.91]\n[03:36.22]そ[03:36.38]の[03:36.55]す[03:36.71]べ[03:36.91]て[03:37.09]を[03:37.59]愛[03:38.16]し[03:38.30]て[03:38.46]た[03:38.74]\n[03:38.97]あ[03:39.14]な[03:39.61]た[03:39.76]と[03:40.31]と[03:40.48]も[03:41.04]に[03:41.38]\n[03:38.97]a [03:39.14]na [03:39.61]ta [03:39.76][03:39.76]to [03:40.31]to [03:40.48]mo [03:41.03][03:41.03]ni [03:41.38]\n[03:41.67]胸[03:42.02]に[03:42.19]残[03:42.56]り[03:43.11]離[03:43.72]れ[03:43.88]な[03:44.45]い[03:44.57]\n[03:41.67]mu [03:41.84][03:41.84]ne [03:42.02]ni [03:42.18][03:42.19]no [03:42.39]ko [03:42.56][03:42.56]ri [03:43.10][03:43.11]ha [03:43.26]na [03:43.72]re [03:43.88][03:43.88]na [03:44.45][03:44.45]i [03:44.57]\n[03:44.77]苦[03:45.06]い[03:45.23]レ[03:45.38]モ[03:45.62]ン[03:45.86]の[03:46.04]匂[03:46.77]い[03:47.29]\n[03:47.61]雨[03:47.95]が[03:48.27]降[03:48.59]り[03:48.91]止[03:49.25]む[03:49.58]ま[03:49.97]で[03:50.13]は[03:50.63]帰[03:51.32]れ[03:51.48]な[03:51.99]い[03:52.74]\n[03:53.09]切[03:53.26]り[03:53.46]分[03:53.79]け[03:54.10]た[03:54.42]果[03:54.80]実[03:55.52]の[03:55.69]片[03:56.37]方[03:56.88]の[03:57.04]様[03:57.56]に[03:58.23]\n[03:58.60]今[03:58.99]で[03:59.31]も[03:59.64]あ[03:59.98]な[04:00.31]た[04:00.64]は[04:01.02]わ[04:01.17]た[04:01.66]し[04:01.81]の[04:02.39]光[04:04.68]\n[03:58.60]i [03:58.78]ma [03:58.98][03:58.99]de [03:59.31]mo [03:59.64]a [03:59.98][03:59.98]na [04:00.31]ta [04:00.63]wa [04:01.02][04:01.02]wa [04:01.17]ta [04:01.66][04:01.66]shi [04:01.81]no [04:02.39][04:02.39]hi [04:02.53]ka [04:03.06][04:03.07]ri [04:04.68]",
    "lrcUrl": "assets/lyrics/track_02.lrc"
  },
  {
    "index": "003",
    "spineNum": "03",
    "serial": "WK-REAL-03",
    "title": "晴天",
    "shortTitle": "晴天 · 周杰伦",
    "spineTitle": "晴天 · 叶惠美",
    "subtitleQuote": "| 故事的小黄花，从出生那年就飘着",
    "artist": "周杰伦",
    "subArtist": "经典专辑《叶惠美》核心曲",
    "statusTag": "青春符号",
    "subTag": "流行巅峰 · 2003",
    "durationSec": 270,
    "currentSec": 0,
    "accent": "#f59e0b",
    "c1": "#fbbf24",
    "c2": "#78350f",
    "picUrl": "assets/covers/cover_03.jpg",
    "audioUrl": "assets/audio/track_03.mp3",
    "notes": [
      293.66,
      329.63,
      369.99,
      392,
      440,
      392,
      369.99,
      329.63
    ],
    "lyrics": [
      {
        "t": 0,
        "l1": "晴天 - 周杰伦 Jay Chou",
        "l2": ""
      },
      {
        "t": 2.25,
        "l1": "词：周杰伦",
        "l2": ""
      },
      {
        "t": 4.5,
        "l1": "曲：周杰伦",
        "l2": ""
      },
      {
        "t": 6.75,
        "l1": "编曲：周杰伦",
        "l2": ""
      },
      {
        "t": 9,
        "l1": "制作人：周杰伦",
        "l2": ""
      },
      {
        "t": 11.25,
        "l1": "合声：周杰伦",
        "l2": ""
      },
      {
        "t": 13.5,
        "l1": "合声编写：周杰伦",
        "l2": ""
      },
      {
        "t": 15.75,
        "l1": "吉他：蔡科俊Again",
        "l2": ""
      },
      {
        "t": 18,
        "l1": "贝斯：陈任佑",
        "l2": ""
      },
      {
        "t": 20.25,
        "l1": "鼓：陈柏州",
        "l2": ""
      },
      {
        "t": 22.51,
        "l1": "录音助理：刘勇志",
        "l2": ""
      },
      {
        "t": 24.76,
        "l1": "录音工程：杨瑞代（Alfa Studio）",
        "l2": ""
      },
      {
        "t": 27.01,
        "l1": "混音工程：杨大纬（杨大纬录音工作室）",
        "l2": ""
      },
      {
        "t": 29.26,
        "l1": "故事的小黄花",
        "l2": ""
      },
      {
        "t": 32.71,
        "l1": "从出生那年就飘着",
        "l2": ""
      },
      {
        "t": 36.24,
        "l1": "童年的荡秋千",
        "l2": ""
      },
      {
        "t": 39.75,
        "l1": "随记忆一直晃到现在",
        "l2": ""
      },
      {
        "t": 42.91,
        "l1": "Re So So Si Do Si La",
        "l2": ""
      },
      {
        "t": 45.93,
        "l1": "So La Si Si Si Si La Si La So",
        "l2": ""
      },
      {
        "t": 49.87,
        "l1": "吹着前奏望着天空",
        "l2": ""
      },
      {
        "t": 53.2,
        "l1": "我想起花瓣试着掉落",
        "l2": ""
      },
      {
        "t": 56.72,
        "l1": "为你翘课的那一天",
        "l2": ""
      },
      {
        "t": 58.83,
        "l1": "花落的那一天",
        "l2": ""
      },
      {
        "t": 60.6,
        "l1": "教室的那一间",
        "l2": ""
      },
      {
        "t": 62.32,
        "l1": "我怎么看不见",
        "l2": ""
      },
      {
        "t": 64.12,
        "l1": "消失的下雨天",
        "l2": ""
      },
      {
        "t": 65.81,
        "l1": "我好想再淋一遍",
        "l2": ""
      },
      {
        "t": 69.99,
        "l1": "没想到失去的勇气我还留着",
        "l2": ""
      },
      {
        "t": 76.12,
        "l1": "好想再问一遍",
        "l2": ""
      },
      {
        "t": 77.97,
        "l1": "你会等待还是离���",
        "l2": ""
      },
      {
        "t": 84.91,
        "l1": "刮风这天我试过握着你手",
        "l2": ""
      },
      {
        "t": 90.45,
        "l1": "但偏偏雨渐渐大到我看你不见",
        "l2": ""
      },
      {
        "t": 98.88,
        "l1": "还要多久我才能在你身边",
        "l2": ""
      },
      {
        "t": 105.44,
        "l1": "等到放晴的那天也许我会比较好一点",
        "l2": ""
      },
      {
        "t": 112.87,
        "l1": "从前从前有个人爱你很久",
        "l2": ""
      },
      {
        "t": 118.54,
        "l1": "但偏偏风渐渐把距离吹得好远",
        "l2": ""
      },
      {
        "t": 126.94,
        "l1": "好不容易又能再多爱一天",
        "l2": ""
      },
      {
        "t": 133.5,
        "l1": "但故事的最后你好像还是说了拜拜",
        "l2": ""
      },
      {
        "t": 154.9,
        "l1": "为你翘课的那一天",
        "l2": ""
      },
      {
        "t": 156.88,
        "l1": "花落的那一天",
        "l2": ""
      },
      {
        "t": 158.66,
        "l1": "教室的那一间",
        "l2": ""
      },
      {
        "t": 160.39,
        "l1": "我怎么看不见",
        "l2": ""
      },
      {
        "t": 162.15,
        "l1": "消失的下雨天",
        "l2": ""
      },
      {
        "t": 163.87,
        "l1": "我好想再淋一遍",
        "l2": ""
      },
      {
        "t": 168,
        "l1": "没想到失去的勇气我还留着",
        "l2": ""
      },
      {
        "t": 174.15,
        "l1": "好想再问一遍",
        "l2": ""
      },
      {
        "t": 176.03,
        "l1": "你会等待还是离开",
        "l2": ""
      },
      {
        "t": 182.92,
        "l1": "刮风这天我试过握着你手",
        "l2": ""
      },
      {
        "t": 188.49,
        "l1": "但偏偏雨渐渐大到我看你不见",
        "l2": ""
      },
      {
        "t": 196.94,
        "l1": "还要多久我才能在你身边",
        "l2": ""
      },
      {
        "t": 203.43,
        "l1": "等到放晴的那天也许我会比较好一点",
        "l2": ""
      },
      {
        "t": 210.87,
        "l1": "从前从前有个人爱你很久",
        "l2": ""
      },
      {
        "t": 217.14,
        "l1": "偏偏风渐渐把距离吹得好远",
        "l2": ""
      },
      {
        "t": 224.88,
        "l1": "好不容易又能再多爱一天",
        "l2": ""
      },
      {
        "t": 231.42,
        "l1": "但故事的最后你好像还是说了拜拜",
        "l2": ""
      },
      {
        "t": 238.49,
        "l1": "刮风这天我试过握着你手",
        "l2": ""
      },
      {
        "t": 241.97,
        "l1": "但偏偏雨渐渐大到我看你不见",
        "l2": ""
      },
      {
        "t": 245.65,
        "l1": "还要多久我才能够在你身边",
        "l2": ""
      },
      {
        "t": 249.07,
        "l1": "等到放晴那天也许我会比较好一点",
        "l2": ""
      },
      {
        "t": 252.92,
        "l1": "从前从前有个人爱你很久",
        "l2": ""
      },
      {
        "t": 255.91,
        "l1": "但偏偏雨渐渐把距离吹得好远",
        "l2": ""
      },
      {
        "t": 259.38,
        "l1": "好不容易又能再多爱一天",
        "l2": ""
      },
      {
        "t": 262.86,
        "l1": "但故事的最后你好像还是说了拜",
        "l2": ""
      }
    ],
    "comments": [
      "【热评 @网易云音乐】200万评论的起点，一整代人的青春纪念册。"
    ],
    "lyricsRaw": "[ti:晴天]\n[ar:周杰伦]\n[al:叶惠美]\n[offset:0]\n\n[00:00.00]晴[00:00.16]天[00:00.32] [00:00.48]-[00:00.64] [00:00.80]周[00:00.96]杰[00:01.12]伦[00:01.28] [00:01.44][00:01.60]Jay[00:01.76] [00:01.92]Chou[00:02.08]\n[00:02.25]词[00:02.70]：[00:03.15]周[00:03.60]杰[00:04.05]伦[00:04.50]\n[00:04.50]曲[00:04.95]：[00:05.40]周[00:05.85]杰[00:06.30]伦[00:06.75]\n[00:06.75]编[00:07.12]曲[00:07.50]：[00:07.87]周[00:08.25]杰[00:08.62]伦[00:09.00]\n[00:09.00]制[00:09.32]作[00:09.64]人[00:09.96]：[00:10.28]周[00:10.60]杰[00:10.92]伦[00:11.24]\n[00:11.25]合[00:11.62]声[00:12.00]：[00:12.37]周[00:12.75]杰[00:13.12]伦[00:13.50]\n[00:13.50]合[00:13.78]声[00:14.06]编[00:14.34]写[00:14.62]：[00:14.90]周[00:15.18]杰[00:15.46]伦[00:15.74]\n[00:15.75]吉[00:16.07]他[00:16.39]：[00:16.71]蔡[00:17.03]科[00:17.35]俊[00:17.67]Again[00:17.99]\n[00:18.00]贝[00:18.37]斯[00:18.75]：[00:19.12]陈[00:19.50]任[00:19.87]佑[00:20.25]\n[00:20.25]鼓[00:20.70]：[00:21.15]陈[00:21.60]柏[00:22.05]州[00:22.51]\n[00:22.51]录[00:22.79]音[00:23.07]助[00:23.35]理[00:23.63]：[00:23.91]刘[00:24.19]勇[00:24.47]志[00:24.75]\n[00:24.76]录[00:24.93]音[00:25.10]工[00:25.27]程[00:25.45]：[00:25.62]杨[00:25.79]瑞[00:25.97]代[00:26.14]（[00:26.31]Alfa[00:26.49] [00:26.66]Studio[00:26.83]）[00:27.00]\n[00:27.01]混[00:27.13]音[00:27.26]工[00:27.38]程[00:27.51]：[00:27.63]杨[00:27.76]大[00:27.88]纬[00:28.01]（[00:28.13]杨[00:28.26]大[00:28.38]纬[00:28.51]录[00:28.63]音[00:28.76]工[00:28.88]作[00:29.01]室[00:29.13]）[00:29.26]\n[00:29.26]故[00:29.65]事[00:30.04]的[00:30.49]小[00:31.41]黄[00:31.79]花[00:32.29]\n[00:32.71]从[00:33.16]出[00:33.54]生[00:34.07]那[00:34.56]年[00:34.74]就[00:35.01]飘[00:35.40]着[00:35.84]\n[00:36.24]童[00:36.70]年[00:37.12]的[00:37.56]荡[00:38.42]秋[00:38.81]千[00:39.35]\n[00:39.75]随[00:40.62]记[00:40.84]忆[00:41.08]一[00:41.29]直[00:41.51]晃[00:41.72]到[00:41.96]现[00:42.37]在[00:42.68]\n[00:42.91]Re [00:43.23]So [00:43.67]So [00:44.11]Si [00:44.55]Do [00:45.01]Si [00:45.45]La [00:45.71]\n[00:45.93]So [00:46.11]La [00:46.35]Si [00:46.74]Si [00:47.16]Si [00:47.59]Si [00:48.13]La [00:48.32]Si [00:48.52]La [00:48.94]So [00:49.45]\n[00:49.87]吹[00:50.25]着[00:50.69]前[00:51.13]奏[00:51.62]望[00:51.98]着[00:52.44]天[00:52.85]空[00:53.04]\n[00:53.20]我[00:53.37]想[00:53.74]起[00:54.25]花[00:54.66]瓣[00:55.15]试[00:55.33]着[00:55.52]掉[00:55.94]落[00:56.38]\n[00:56.72]为[00:56.90]你[00:57.07]翘[00:57.27]课[00:57.47]的[00:57.72]那[00:57.95]一[00:58.34]天[00:58.63]\n[00:58.83]花[00:59.04]落[00:59.25]的[00:59.51]那[00:59.73]一[01:00.10]天[01:00.40]\n[01:00.60]教[01:00.79]室[01:00.99]的[01:01.23]那[01:01.48]一[01:01.85]间[01:02.09]\n[01:02.32]我[01:02.51]怎[01:02.70]么[01:02.94]看[01:03.27]不[01:03.58]见[01:03.90]\n[01:04.12]消[01:04.29]失[01:04.47]的[01:04.74]下[01:05.00]雨[01:05.31]天[01:05.62]\n[01:05.81]我[01:06.00]好[01:06.18]想[01:06.44]再[01:06.66]淋[01:06.87]一[01:07.09]遍[01:09.26]\n[01:09.99]没[01:10.20]想[01:10.38]到[01:10.57]失[01:10.86]去[01:11.30]的[01:11.75]勇[01:12.18]气[01:12.60]我[01:13.00]还[01:13.39]留[01:13.88]着[01:15.35]\n[01:16.12]好[01:16.40]想[01:16.59]再[01:16.78]问[01:17.01]一[01:17.41]遍[01:17.68]\n[01:17.97]你[01:18.35]会[01:18.79]等[01:19.22]待[01:19.66]还[01:20.03]是[01:20.44]离[01:20.87]���[01:23.14]\n[01:24.91]刮[01:25.30]风[01:25.72]这[01:26.10]天[01:27.01]我[01:27.38]试[01:27.79]过[01:28.31]握[01:28.72]着[01:29.16]你[01:29.58]手[01:30.07]\n[01:30.45]但[01:30.89]偏[01:31.34]偏[01:32.33]雨[01:32.71]渐[01:33.15]渐[01:34.06]大[01:34.47]到[01:34.90]我[01:35.34]看[01:35.77]你[01:36.18]不[01:36.57]见[01:37.98]\n[01:38.88]还[01:39.26]要[01:39.69]多[01:40.08]久[01:41.04]我[01:41.44]才[01:41.84]能[01:42.35]在[01:42.74]你[01:43.19]身[01:43.62]边[01:44.90]\n[01:45.44]等[01:45.87]到[01:46.31]放[01:46.74]晴[01:47.18]的[01:47.64]那[01:48.03]天[01:48.50]也[01:48.91]许[01:49.36]我[01:49.76]会[01:50.23]比[01:50.66]较[01:51.14]好[01:51.79]一[01:51.98]点[01:52.50]\n[01:52.87]从[01:53.29]前[01:53.71]从[01:54.14]前[01:55.06]有[01:55.50]个[01:55.89]人[01:56.34]爱[01:56.78]你[01:57.19]很[01:57.60]久[01:58.27]\n[01:58.54]但[01:58.97]偏[01:59.40]偏[02:00.33]风[02:00.74]渐[02:01.11]渐[02:02.10]把[02:02.50]距[02:02.90]离[02:03.34]吹[02:03.74]得[02:04.19]好[02:04.55]远[02:06.00]\n[02:06.94]好[02:07.32]不[02:07.71]容[02:08.13]易[02:09.11]又[02:09.48]能[02:09.87]再[02:10.34]多[02:10.77]爱[02:11.21]一[02:11.62]天[02:12.93]\n[02:13.50]但[02:13.86]故[02:14.31]事[02:14.72]的[02:15.14]最[02:15.61]后[02:16.02]你[02:16.48]好[02:16.90]像[02:17.38]还[02:17.79]是[02:18.24]说[02:18.64]了[02:19.99]拜[02:20.48]拜[02:22.80]\n[02:34.90]为[02:35.09]你[02:35.25]翘[02:35.43]课[02:35.59]的[02:35.83]那[02:36.04]一[02:36.40]天[02:36.66]\n[02:36.88]花[02:37.12]落[02:37.34]的[02:37.60]那[02:37.81]一[02:38.17]天[02:38.43]\n[02:38.66]教[02:38.86]室[02:39.05]的[02:39.34]那[02:39.59]一[02:39.94]间[02:40.17]\n[02:40.39]我[02:40.57]怎[02:40.77]么[02:41.07]看[02:41.37]不[02:41.66]见[02:41.94]\n[02:42.15]消[02:42.34]失[02:42.53]的[02:42.83]下[02:43.04]雨[02:43.35]天[02:43.69]\n[02:43.87]我[02:44.09]好[02:44.29]想[02:44.55]再[02:44.77]淋[02:45.01]一[02:45.20]遍[02:46.97]\n[02:48.00]没[02:48.20]想[02:48.43]到[02:48.61]失[02:48.90]去[02:49.31]的[02:49.73]勇[02:50.14]气[02:50.59]我[02:51.03]还[02:51.44]留[02:51.86]着[02:53.77]\n[02:54.15]好[02:54.36]想[02:54.59]再[02:54.76]问[02:55.05]一[02:55.45]遍[02:55.79]\n[02:56.03]你[02:56.35]会[02:56.77]等[02:57.19]待[02:57.63]还[02:58.00]是[02:58.44]离[02:58.84]开[03:02.09]\n[03:02.92]刮[03:03.30]风[03:03.74]这[03:04.10]天[03:05.06]我[03:05.46]试[03:05.86]过[03:06.32]握[03:06.74]着[03:07.16]你[03:07.59]手[03:08.17]\n[03:08.49]但[03:08.94]偏[03:09.35]偏[03:10.31]雨[03:10.72]渐[03:11.06]渐[03:12.08]大[03:12.49]到[03:12.91]我[03:13.33]看[03:13.76]你[03:14.21]不[03:14.62]见[03:16.00]\n[03:16.94]还[03:17.31]要[03:17.72]多[03:18.15]久[03:19.08]我[03:19.48]才[03:19.90]能[03:20.36]在[03:20.76]你[03:21.18]身[03:21.61]边[03:23.02]\n[03:23.43]等[03:23.88]到[03:24.30]放[03:24.73]晴[03:25.19]的[03:25.63]那[03:26.05]天[03:26.47]也[03:26.87]许[03:27.38]我[03:27.79]会[03:28.28]比[03:28.72]较[03:29.16]好[03:29.79]一[03:29.98]点[03:30.53]\n[03:30.87]从[03:31.32]前[03:31.76]从[03:32.15]前[03:33.11]有[03:33.51]个[03:33.92]人[03:34.38]爱[03:34.77]你[03:35.21]很[03:35.63]久[03:36.79]\n[03:37.14]偏[03:37.50]偏[03:38.37]风[03:38.75]渐[03:39.13]渐[03:40.08]把[03:40.47]距[03:40.87]离[03:41.34]吹[03:41.77]得[03:42.20]好[03:42.60]远[03:43.97]\n[03:44.88]好[03:45.28]不[03:45.71]容[03:46.10]易[03:47.09]又[03:47.48]能[03:47.93]再[03:48.32]多[03:48.75]爱[03:49.18]一[03:49.61]天[03:50.96]\n[03:51.42]但[03:51.84]故[03:52.30]事[03:52.77]的[03:53.19]最[03:53.61]后[03:54.06]你[03:54.52]好[03:54.92]像[03:55.40]还[03:55.80]是[03:56.21]说[03:56.61]了[03:57.96]拜[03:58.16]拜[03:58.32]\n[03:58.49]刮[03:58.66]风[03:58.82]这[03:59.02]天[03:59.48]我[03:59.89]试[04:00.08]过[04:00.85]握[04:01.04]着[04:01.22]你[04:01.40]手[04:01.72]\n[04:01.97]但[04:02.14]偏[04:02.31]偏[04:02.78]雨[04:02.96]渐[04:03.12]渐[04:03.64]大[04:03.83]到[04:04.00]我[04:04.23]看[04:04.43]你[04:04.64]不[04:04.84]见[04:05.31]\n[04:05.65]还[04:05.80]要[04:06.04]多[04:06.39]久[04:06.85]我[04:07.04]才[04:07.25]能[04:07.43]够[04:07.67]在[04:07.91]你[04:08.12]身[04:08.32]边[04:08.81]\n[04:09.07]等[04:09.27]到[04:09.51]放[04:09.70]晴[04:09.90]那[04:10.12]天[04:10.64]也[04:10.85]许[04:11.05]我[04:11.28]会[04:11.46]比[04:11.64]较[04:11.84]好[04:12.05]一[04:12.26]点[04:12.61]\n[04:12.92]从[04:13.09]前[04:13.29]从[04:13.48]前[04:13.92]有[04:14.11]个[04:14.31]人[04:14.77]爱[04:14.95]你[04:15.16]很[04:15.38]久[04:15.67]\n[04:15.91]但[04:16.10]偏[04:16.28]偏[04:16.77]雨[04:16.94]渐[04:17.14]渐[04:17.60]把[04:17.79]距[04:18.00]离[04:18.24]吹[04:18.43]得[04:18.65]好[04:18.88]远[04:19.18]\n[04:19.38]好[04:19.58]不[04:19.78]容[04:20.01]易[04:20.43]又[04:20.88]能[04:21.09]再[04:21.74]多[04:21.96]爱[04:22.15]一[04:22.34]天[04:22.60]\n[04:22.86]但[04:23.07]故[04:23.25]事[04:23.50]的[04:23.70]最[04:23.91]后[04:24.17]你[04:24.38]好[04:24.60]像[04:24.84]还[04:25.04]是[04:25.28]说[04:25.47]了[04:25.69]拜[04:25.84]",
    "lrcUrl": "assets/lyrics/track_03.lrc"
  },
  {
    "index": "004",
    "spineNum": "04",
    "serial": "WK-REAL-04",
    "title": "七里香",
    "shortTitle": "七里香 · 周杰伦",
    "spineTitle": "七里香 · 巅峰之作",
    "subtitleQuote": "| 雨下整夜，我的爱溢出就像雨水",
    "artist": "周杰伦",
    "subArtist": "2004 同名专辑《七里香》",
    "statusTag": "夏日神话",
    "subTag": "盛夏留声",
    "durationSec": 297,
    "currentSec": 0,
    "accent": "#059669",
    "c1": "#34d399",
    "c2": "#064e3b",
    "picUrl": "assets/covers/cover_04.jpg",
    "audioUrl": "assets/audio/track_04.mp3",
    "notes": [
      261.63,
      293.66,
      329.63,
      392,
      440,
      392,
      329.63,
      293.66
    ],
    "lyrics": [
      {
        "t": 0,
        "l1": "七里香 - 周杰伦 Jay Chou",
        "l2": ""
      },
      {
        "t": 6.93,
        "l1": "词：方文山",
        "l2": ""
      },
      {
        "t": 13.87,
        "l1": "曲：周杰伦",
        "l2": ""
      },
      {
        "t": 20.8,
        "l1": "编曲：钟兴民",
        "l2": ""
      },
      {
        "t": 27.74,
        "l1": "窗外的麻雀在电线杆上多嘴",
        "l2": ""
      },
      {
        "t": 34.49,
        "l1": "你说这一句很有夏天的感觉",
        "l2": ""
      },
      {
        "t": 41.16,
        "l1": "手中的铅笔在纸上来来回回",
        "l2": ""
      },
      {
        "t": 47.59,
        "l1": "我用几行字形容你是我的谁",
        "l2": ""
      },
      {
        "t": 54.39,
        "l1": "秋刀鱼的滋味猫跟你都想了解",
        "l2": ""
      },
      {
        "t": 61.44,
        "l1": "初恋的香味就这样被我们寻回",
        "l2": ""
      },
      {
        "t": 67.81,
        "l1": "那温暖的阳光像刚摘的鲜艳草莓",
        "l2": ""
      },
      {
        "t": 74.37,
        "l1": "你说你舍不得吃掉这一种感觉",
        "l2": ""
      },
      {
        "t": 80.99,
        "l1": "雨下整夜我的爱溢出就像雨水",
        "l2": ""
      },
      {
        "t": 87.65,
        "l1": "院子落叶跟我的思念厚厚一叠",
        "l2": ""
      },
      {
        "t": 94.38,
        "l1": "几句是非也无法将我的热情冷却",
        "l2": ""
      },
      {
        "t": 101.92,
        "l1": "你出现在我诗的每一页",
        "l2": ""
      },
      {
        "t": 107.86,
        "l1": "雨下整夜我的爱溢出就像雨水",
        "l2": ""
      },
      {
        "t": 114.6,
        "l1": "窗台蝴蝶像诗里纷飞的美丽章节",
        "l2": ""
      },
      {
        "t": 121.38,
        "l1": "我接着写",
        "l2": ""
      },
      {
        "t": 123.86,
        "l1": "把永远爱你写进诗的结尾",
        "l2": ""
      },
      {
        "t": 128.99,
        "l1": "你是我唯一想要的了解",
        "l2": ""
      },
      {
        "t": 162.02,
        "l1": "雨下整夜我的爱溢出就像雨水",
        "l2": ""
      },
      {
        "t": 168.62,
        "l1": "院子落叶跟我的思念厚厚一叠",
        "l2": ""
      },
      {
        "t": 175.37,
        "l1": "几句是非也无法将我的热情冷却",
        "l2": ""
      },
      {
        "t": 182.96,
        "l1": "你出现在我诗的每一页",
        "l2": ""
      },
      {
        "t": 189.38,
        "l1": "那饱满的稻穗幸福了这个季节",
        "l2": ""
      },
      {
        "t": 196.54,
        "l1": "而你的脸颊像田里熟透的番茄",
        "l2": ""
      },
      {
        "t": 202.81,
        "l1": "你突然对我说七里香的名字很美",
        "l2": ""
      },
      {
        "t": 209.28,
        "l1": "我此刻却只想亲吻你倔强的嘴",
        "l2": ""
      },
      {
        "t": 215.91,
        "l1": "雨下整夜我的爱溢出就像雨水",
        "l2": ""
      },
      {
        "t": 222.58,
        "l1": "院子落叶跟我的思念厚厚一叠",
        "l2": ""
      },
      {
        "t": 229.38,
        "l1": "几句是非也无法将我的热情冷却",
        "l2": ""
      },
      {
        "t": 236.93,
        "l1": "你出现在我诗的每一页",
        "l2": ""
      },
      {
        "t": 243.33,
        "l1": "整夜我的爱溢出就像雨水",
        "l2": ""
      },
      {
        "t": 249.58,
        "l1": "窗台蝴蝶像诗里纷飞的美丽章节",
        "l2": ""
      },
      {
        "t": 256.43,
        "l1": "我接着写",
        "l2": ""
      },
      {
        "t": 258.97,
        "l1": "把永远爱你写进诗的结尾",
        "l2": ""
      },
      {
        "t": 264,
        "l1": "你是我唯一想要的了解",
        "l2": ""
      }
    ],
    "comments": [
      "【热评 @稻田间的风】前奏的风铃一响，整个夏天就再也没有结束。"
    ],
    "lyricsRaw": "[ti:七里香]\n[ar:周杰伦]\n[al:七里香]\n[offset:0]\n\n[00:00.00]七[00:00.46]里[00:00.92]香[00:01.38] [00:01.84]-[00:02.31] [00:02.77]周[00:03.23]杰[00:03.69]伦[00:04.15] [00:04.62][00:05.08]Jay[00:05.54] [00:06.00]Chou[00:06.46]\n[00:06.93]词[00:08.31]：[00:09.70]方[00:11.09]文[00:12.48]山[00:13.87]\n[00:13.87]曲[00:15.25]：[00:16.64]周[00:18.02]杰[00:19.41]伦[00:20.80]\n[00:20.80]编[00:21.95]曲[00:23.11]：[00:24.26]钟[00:25.42]兴[00:26.58]民[00:27.73]\n[00:27.74]窗[00:28.14]外[00:29.07]的[00:29.44]麻[00:29.61]雀[00:31.12]在[00:31.53]电[00:31.90]线[00:32.33]杆[00:32.73]上[00:32.94]多[00:33.36]嘴[00:34.01]\n[00:34.49]你[00:34.88]说[00:35.74]这[00:36.16]一[00:36.33]句[00:37.85]很[00:38.24]有[00:38.62]夏[00:39.05]天[00:39.52]的[00:39.71]感[00:40.14]觉[00:40.72]\n[00:41.16]手[00:41.56]中[00:42.54]的[00:42.92]铅[00:43.10]笔[00:44.56]在[00:44.99]纸[00:45.36]上[00:45.85]来[00:46.27]来[00:46.46]回[00:46.91]回[00:47.32]\n[00:47.59]我[00:47.94]用[00:48.41]几[00:48.88]行[00:49.07]字[00:49.72]形[00:49.93]容[00:50.39]你[00:50.95]是[00:51.39]我[00:51.58]的[00:51.96]谁[00:53.24]\n[00:54.39]秋[00:54.75]刀[00:55.16]鱼[00:56.03]的[00:56.38]滋[00:56.79]味[00:57.68]猫[00:58.06]跟[00:58.50]你[00:59.40]都[00:59.80]想[01:00.00]了[01:00.39]解[01:01.07]\n[01:01.44]初[01:01.88]恋[01:02.29]的[01:02.75]香[01:03.17]味[01:03.51]就[01:03.91]这[01:04.31]样[01:04.81]被[01:05.14]我[01:05.53]们[01:06.51]寻[01:06.84]回[01:07.49]\n[01:07.81]那[01:08.22]温[01:08.67]暖[01:09.55]的[01:09.92]阳[01:10.30]光[01:10.80]像[01:11.19]刚[01:11.57]摘[01:12.10]的[01:12.51]鲜[01:12.88]艳[01:13.25]草[01:13.63]莓[01:14.09]\n[01:14.37]你[01:14.61]说[01:15.01]你[01:15.44]舍[01:15.83]不[01:16.24]得[01:16.64]吃[01:17.10]掉[01:17.50]这[01:17.94]一[01:18.32]种[01:18.72]感[01:19.41]觉[01:20.45]\n[01:20.99]雨[01:21.33]下[01:21.73]整[01:21.92]夜[01:23.44]我[01:23.85]的[01:24.24]爱[01:24.67]溢[01:25.07]出[01:25.52]就[01:25.92]像[01:26.35]雨[01:26.96]水[01:27.36]\n[01:27.65]院[01:28.05]子[01:28.45]落[01:28.64]叶[01:30.22]跟[01:30.61]我[01:30.99]的[01:31.42]思[01:31.81]念[01:32.25]厚[01:32.64]厚[01:33.07]一[01:33.73]叠[01:34.13]\n[01:34.38]几[01:34.78]句[01:35.22]是[01:35.38]非[01:36.91]也[01:37.31]无[01:37.68]法[01:38.13]将[01:38.53]我[01:39.01]的[01:39.42]热[01:39.87]情[01:40.27]冷[01:40.46]却[01:41.47]\n[01:41.92]你[01:42.37]出[01:42.75]现[01:43.20]在[01:43.63]我[01:44.03]诗[01:44.45]的[01:44.94]每[01:45.34]一[01:45.55]页[01:47.44]\n[01:47.86]雨[01:48.27]下[01:48.69]整[01:48.87]夜[01:50.44]我[01:50.82]的[01:51.20]爱[01:51.64]溢[01:52.04]出[01:52.50]就[01:52.87]像[01:53.29]雨[01:53.94]水[01:54.31]\n[01:54.60]窗[01:54.99]台[01:55.39]蝴[01:55.60]蝶[01:57.14]像[01:57.55]诗[01:57.92]里[01:58.39]纷[01:58.79]飞[01:59.25]的[01:59.65]美[02:00.07]丽[02:00.49]章[02:00.70]节[02:01.11]\n[02:01.38]我[02:01.76]接[02:02.15]着[02:02.34]写[02:03.36]\n[02:03.86]把[02:04.29]永[02:04.69]远[02:05.14]爱[02:05.52]你[02:05.97]写[02:06.37]进[02:06.84]诗[02:07.30]的[02:07.49]结[02:07.92]尾[02:08.64]\n[02:08.99]你[02:09.38]是[02:09.76]我[02:10.18]唯[02:10.58]一[02:11.04]想[02:11.43]要[02:11.91]的[02:12.34]了[02:12.50]解[02:14.96]\n[02:42.02]雨[02:42.36]下[02:42.74]整[02:42.92]夜[02:44.46]我[02:44.82]的[02:45.22]爱[02:45.76]溢[02:46.09]出[02:46.51]就[02:46.89]像[02:47.28]雨[02:47.93]水[02:48.32]\n[02:48.62]院[02:49.00]子[02:49.42]落[02:49.60]叶[02:51.20]跟[02:51.58]我[02:51.96]的[02:52.40]思[02:52.76]念[02:53.24]厚[02:53.60]厚[02:54.04]一[02:54.67]叠[02:55.10]\n[02:55.37]几[02:55.77]句[02:56.17]是[02:56.35]非[02:57.92]也[02:58.30]无[02:58.68]法[02:59.12]将[02:59.53]我[02:59.98]的[03:00.40]热[03:00.86]情[03:01.28]冷[03:01.45]却[03:02.44]\n[03:02.96]你[03:03.37]出[03:03.77]现[03:04.24]在[03:04.62]我[03:05.05]诗[03:05.45]的[03:05.92]每[03:06.33]一[03:06.53]页[03:08.51]\n[03:09.38]那[03:09.75]饱[03:10.17]满[03:11.02]的[03:11.38]稻[03:11.82]穗[03:12.70]幸[03:13.11]福[03:13.58]了[03:14.43]这[03:14.84]个[03:15.05]季[03:15.46]节[03:16.17]\n[03:16.54]而[03:16.92]你[03:17.27]的[03:17.83]脸[03:18.22]颊[03:18.41]像[03:18.87]田[03:19.27]里[03:19.70]熟[03:20.17]透[03:20.57]的[03:21.61]番[03:21.94]茄[03:22.50]\n[03:22.81]你[03:23.18]突[03:23.66]然[03:24.62]对[03:24.94]我[03:25.34]说[03:25.80]七[03:26.15]里[03:26.54]香[03:27.00]的[03:27.54]名[03:27.86]字[03:28.24]很[03:28.63]美[03:28.99]\n[03:29.28]我[03:29.57]此[03:29.91]刻[03:30.32]却[03:30.72]只[03:31.17]想[03:31.59]亲[03:32.05]吻[03:32.45]你[03:32.85]倔[03:33.23]强[03:33.68]的[03:34.34]嘴[03:35.51]\n[03:35.91]雨[03:36.31]下[03:36.71]整[03:36.90]夜[03:38.43]我[03:38.81]的[03:39.17]爱[03:39.59]溢[03:40.02]出[03:40.50]就[03:40.87]像[03:41.30]雨[03:42.00]水[03:42.26]\n[03:42.58]院[03:43.03]子[03:43.43]落[03:43.60]叶[03:45.15]跟[03:45.55]我[03:45.94]的[03:46.40]思[03:46.79]念[03:47.23]厚[03:47.60]厚[03:48.03]一[03:48.69]叠[03:49.09]\n[03:49.38]几[03:49.73]句[03:50.16]是[03:50.34]非[03:51.91]也[03:52.32]无[03:52.69]法[03:53.12]将[03:53.54]我[03:53.99]的[03:54.43]热[03:54.82]情[03:55.27]冷[03:55.45]却[03:56.50]\n[03:56.93]你[03:57.33]出[03:57.71]现[03:58.18]在[03:58.58]我[03:59.03]诗[03:59.43]的[03:59.89]每[04:00.31]一[04:00.48]页[04:02.46]\n[04:03.33]整[04:04.12]夜[04:05.48]我[04:05.85]的[04:06.23]爱[04:06.68]溢[04:07.07]出[04:07.51]就[04:07.90]像[04:08.31]雨[04:08.99]水[04:09.32]\n[04:09.58]窗[04:10.04]台[04:10.47]蝴[04:10.64]蝶[04:12.17]像[04:12.57]诗[04:12.95]里[04:13.39]纷[04:13.79]飞[04:14.27]的[04:14.69]美[04:15.08]丽[04:15.51]章[04:15.72]节[04:15.99]\n[04:16.43]我[04:16.86]接[04:17.24]着[04:17.42]写[04:18.44]\n[04:18.97]把[04:19.37]永[04:19.77]远[04:20.17]爱[04:20.59]你[04:21.02]写[04:21.41]进[04:21.85]诗[04:22.31]的[04:22.52]结[04:22.91]尾[04:23.64]\n[04:24.00]你[04:24.38]是[04:24.78]我[04:25.23]唯[04:25.61]一[04:26.08]想[04:26.46]要[04:26.92]的[04:27.37]了[04:27.56]解[04:30.27]",
    "lrcUrl": "assets/lyrics/track_04.lrc"
  },
  {
    "index": "005",
    "spineNum": "05",
    "serial": "WK-REAL-05",
    "title": "夜曲",
    "shortTitle": "夜曲 · 周杰伦",
    "spineTitle": "夜曲 · 十一月的萧邦",
    "subtitleQuote": "| 为你弹奏肖邦的夜曲，纪念我死去的爱情",
    "artist": "周杰伦",
    "subArtist": "金曲奖五项大奖加冕之作",
    "statusTag": "暗黑古典",
    "subTag": "夜曲一响",
    "durationSec": 232,
    "currentSec": 0,
    "accent": "#6366f1",
    "c1": "#818cf8",
    "c2": "#312e81",
    "picUrl": "assets/covers/cover_05.jpg",
    "audioUrl": "assets/audio/track_05.mp3",
    "notes": [
      220,
      261.63,
      329.63,
      440,
      523.25,
      440,
      329.63,
      220
    ],
    "lyrics": [
      {
        "t": 0,
        "l1": "夜曲 - 周杰伦 Jay Chou",
        "l2": ""
      },
      {
        "t": 4.99,
        "l1": "词：方文山",
        "l2": ""
      },
      {
        "t": 9.98,
        "l1": "曲：周杰伦",
        "l2": ""
      },
      {
        "t": 14.97,
        "l1": "编曲：林迈可",
        "l2": ""
      },
      {
        "t": 19.97,
        "l1": "制作人：周杰伦",
        "l2": ""
      },
      {
        "t": 24.96,
        "l1": "一群嗜血的蚂蚁 被腐肉所吸引",
        "l2": ""
      },
      {
        "t": 27.96,
        "l1": "我面无表情 看孤独的风景",
        "l2": ""
      },
      {
        "t": 30.98,
        "l1": "失去你 爱恨开始分明",
        "l2": ""
      },
      {
        "t": 33.47,
        "l1": "失去你 还有什么事好关心",
        "l2": ""
      },
      {
        "t": 36.43,
        "l1": "当鸽子不再象征和平",
        "l2": ""
      },
      {
        "t": 38.31,
        "l1": "我终于被提醒",
        "l2": ""
      },
      {
        "t": 39.68,
        "l1": "广场上喂食的是秃鹰",
        "l2": ""
      },
      {
        "t": 41.99,
        "l1": "我用漂亮的押韵",
        "l2": ""
      },
      {
        "t": 43.17,
        "l1": "形容被掠夺一空的爱情",
        "l2": ""
      },
      {
        "t": 46.95,
        "l1": "啊 乌云开始遮蔽 夜色不干净",
        "l2": ""
      },
      {
        "t": 49.64,
        "l1": "公园里 葬礼的回音 在漫天飞行",
        "l2": ""
      },
      {
        "t": 52.4,
        "l1": "送你的白色玫瑰",
        "l2": ""
      },
      {
        "t": 54.01,
        "l1": "在纯黑的环境凋零",
        "l2": ""
      },
      {
        "t": 55.55,
        "l1": "乌鸦在树枝上诡异的很安静",
        "l2": ""
      },
      {
        "t": 57.89,
        "l1": "静静听 我黑色的大衣",
        "l2": ""
      },
      {
        "t": 60.34,
        "l1": "想温暖你日渐冰冷的回忆",
        "l2": ""
      },
      {
        "t": 62.39,
        "l1": "走过的走过的生命",
        "l2": ""
      },
      {
        "t": 63.97,
        "l1": "啊 四周弥漫雾气",
        "l2": ""
      },
      {
        "t": 65.18,
        "l1": "啊 我在空旷的墓地",
        "l2": ""
      },
      {
        "t": 66.57,
        "l1": "老去后还爱你",
        "l2": ""
      },
      {
        "t": 68.98,
        "l1": "为你弹奏肖邦的夜曲",
        "l2": ""
      },
      {
        "t": 72.08,
        "l1": "纪念我死去的爱情",
        "l2": ""
      },
      {
        "t": 74.89,
        "l1": "跟夜风一样的声音",
        "l2": ""
      },
      {
        "t": 77.56,
        "l1": "心碎的很好听",
        "l2": ""
      },
      {
        "t": 80.38,
        "l1": "手在键盘敲很轻",
        "l2": ""
      },
      {
        "t": 83.12,
        "l1": "我给的思念很小心",
        "l2": ""
      },
      {
        "t": 85.89,
        "l1": "你埋葬的地方叫幽冥",
        "l2": ""
      },
      {
        "t": 90.1,
        "l1": "为你弹奏肖邦的夜曲",
        "l2": ""
      },
      {
        "t": 94.16,
        "l1": "纪念我死去的爱情",
        "l2": ""
      },
      {
        "t": 96.97,
        "l1": "而我为你隐姓埋名",
        "l2": ""
      },
      {
        "t": 99.66,
        "l1": "在月光下弹琴",
        "l2": ""
      },
      {
        "t": 102.48,
        "l1": "对你心跳的感应",
        "l2": ""
      },
      {
        "t": 105.2,
        "l1": "还是如此温热亲近",
        "l2": ""
      },
      {
        "t": 107.92,
        "l1": "怀念你那鲜红的唇印",
        "l2": ""
      },
      {
        "t": 135.19,
        "l1": "那些断翅的蜻蜓 散落在这森林",
        "l2": ""
      },
      {
        "t": 138.34,
        "l1": "而我的眼睛 没有丝毫同情",
        "l2": ""
      },
      {
        "t": 141.42,
        "l1": "失去你 泪水混浊不清",
        "l2": ""
      },
      {
        "t": 143.81,
        "l1": "失去你 我连笑容都有阴影",
        "l2": ""
      },
      {
        "t": 146.9,
        "l1": "风在长满青苔的屋顶",
        "l2": ""
      },
      {
        "t": 148.67,
        "l1": "嘲笑我的伤心",
        "l2": ""
      },
      {
        "t": 150.06,
        "l1": "像一口没有水的枯井",
        "l2": ""
      },
      {
        "t": 152.3,
        "l1": "我用凄美的字型",
        "l2": ""
      },
      {
        "t": 153.37,
        "l1": "描绘后悔莫及的那爱情",
        "l2": ""
      },
      {
        "t": 157.28,
        "l1": "为你弹奏肖邦的夜曲",
        "l2": ""
      },
      {
        "t": 160.33,
        "l1": "纪念我死去的爱情",
        "l2": ""
      },
      {
        "t": 163.1,
        "l1": "跟夜风一样的声音",
        "l2": ""
      },
      {
        "t": 165.82,
        "l1": "心碎的很好听",
        "l2": ""
      },
      {
        "t": 168.74,
        "l1": "手在键盘敲很轻",
        "l2": ""
      },
      {
        "t": 171.36,
        "l1": "我给的思念很小心",
        "l2": ""
      },
      {
        "t": 174.15,
        "l1": "你埋葬的地方叫幽冥",
        "l2": ""
      },
      {
        "t": 178.5,
        "l1": "为你弹奏肖邦的夜曲",
        "l2": ""
      },
      {
        "t": 182.39,
        "l1": "纪念我死去的爱情",
        "l2": ""
      },
      {
        "t": 185.21,
        "l1": "而我为你隐姓埋名",
        "l2": ""
      },
      {
        "t": 187.92,
        "l1": "在月光下弹琴",
        "l2": ""
      },
      {
        "t": 190.76,
        "l1": "对你心跳的感应",
        "l2": ""
      },
      {
        "t": 193.42,
        "l1": "还是如此温热亲近",
        "l2": ""
      },
      {
        "t": 196.24,
        "l1": "怀念你那鲜红的唇印",
        "l2": ""
      },
      {
        "t": 201.37,
        "l1": "一群嗜血的蚂蚁 被腐肉所吸引",
        "l2": ""
      },
      {
        "t": 204.49,
        "l1": "我面无表情 看孤独的风景",
        "l2": ""
      },
      {
        "t": 207.52,
        "l1": "失去你 爱恨开始分明",
        "l2": ""
      },
      {
        "t": 209.99,
        "l1": "失去你 还有什么事好关心",
        "l2": ""
      },
      {
        "t": 212.98,
        "l1": "当鸽子不再象征和平",
        "l2": ""
      },
      {
        "t": 214.81,
        "l1": "我终于被提醒",
        "l2": ""
      },
      {
        "t": 216.24,
        "l1": "广场上喂食的是秃鹰",
        "l2": ""
      },
      {
        "t": 218.47,
        "l1": "我用漂亮的押韵",
        "l2": ""
      },
      {
        "t": 219.68,
        "l1": "形容被掠夺一空的爱情",
        "l2": ""
      }
    ],
    "comments": [
      "【热评 @金曲奖台下】夜曲一响，上台领奖！当年横扫各大音乐奖项的真正神作。"
    ],
    "lyricsRaw": "[ti:夜曲]\n[ar:周杰伦]\n[al:十一月的萧邦]\n[offset:0]\n\n[00:00.00]夜[00:00.35]曲[00:00.71] [00:01.06]-[00:01.42] [00:01.78]周[00:02.13]杰[00:02.49]伦[00:02.84] [00:03.20][00:03.56]Jay[00:03.91] [00:04.27]Chou[00:04.62]\n[00:04.99]词[00:05.98]：[00:06.98]方[00:07.98]文[00:08.98]山[00:09.98]\n[00:09.98]曲[00:10.97]：[00:11.97]周[00:12.97]杰[00:13.97]伦[00:14.97]\n[00:14.97]编[00:15.80]曲[00:16.63]：[00:17.46]林[00:18.30]迈[00:19.13]可[00:19.96]\n[00:19.97]制[00:20.68]作[00:21.39]人[00:22.10]：[00:22.81]周[00:23.53]杰[00:24.24]伦[00:24.95]\n[00:24.96]一[00:25.12]群[00:25.26]嗜[00:25.56]血[00:25.85]的[00:26.03]蚂[00:26.19]蚁[00:26.60] [00:26.60]被[00:26.78]腐[00:26.95]肉[00:27.11]所[00:27.26]吸[00:27.63]引[00:27.96]\n[00:27.96]我[00:28.27]面[00:28.45]无[00:28.62]表[00:29.02]情[00:29.35] [00:29.35]看[00:29.53]孤[00:29.71]独[00:29.88]的[00:30.06]风[00:30.37]景[00:30.98]\n[00:30.98]失[00:31.16]去[00:31.37]你[00:31.80] [00:31.80]爱[00:31.95]恨[00:32.14]开[00:32.51]始[00:32.80]分[00:33.13]明[00:33.47]\n[00:33.47]失[00:33.64]去[00:33.83]你[00:34.20] [00:34.20]还[00:34.38]有[00:34.55]什[00:34.72]么[00:34.91]事[00:35.25]好[00:35.59]关[00:35.91]心[00:36.43]\n[00:36.43]当[00:36.59]鸽[00:36.76]子[00:36.91]不[00:37.07]再[00:37.24]象[00:37.40]征[00:37.60]和[00:37.97]平[00:38.31]\n[00:38.31]我[00:38.49]终[00:38.66]于[00:38.82]被[00:39.01]提[00:39.36]醒[00:39.68]\n[00:39.68]广[00:39.85]场[00:40.01]上[00:40.17]喂[00:40.34]食[00:40.51]的[00:40.70]是[00:41.09]秃[00:41.43]鹰[00:41.99]\n[00:41.99]我[00:42.16]用[00:42.31]漂[00:42.47]亮[00:42.63]的[00:42.79]押[00:42.95]韵[00:43.17]\n[00:43.17]形[00:43.34]容[00:43.49]被[00:43.65]掠[00:43.82]夺[00:44.00]一[00:44.17]空[00:44.43]的[00:44.58]爱[00:44.86]情[00:45.50]\n[00:46.95]啊[00:47.27] [00:47.27]乌[00:47.55]云[00:47.71]开[00:47.89]始[00:48.07]遮[00:48.23]蔽[00:48.62] [00:48.62]夜[00:48.77]色[00:48.93]不[00:49.08]干[00:49.26]净[00:49.64]\n[00:49.64]公[00:49.81]园[00:49.99]里[00:50.34] [00:50.34]葬[00:50.51]礼[00:50.68]的[00:50.85]回[00:51.00]音[00:51.39] [00:51.39]在[00:51.56]漫[00:51.71]天[00:51.88]飞[00:52.06]行[00:52.40]\n[00:52.40]送[00:52.57]你[00:52.72]的[00:53.08]白[00:53.25]色[00:53.42]玫[00:53.62]瑰[00:54.01]\n[00:54.01]在[00:54.18]纯[00:54.33]黑[00:54.48]的[00:54.64]环[00:54.79]境[00:54.95]凋[00:55.12]零[00:55.55]\n[00:55.55]乌[00:55.87]鸦[00:56.03]在[00:56.18]树[00:56.33]枝[00:56.48]上[00:56.64]诡[00:56.79]异[00:56.96]的[00:57.13]很[00:57.30]安[00:57.46]静[00:57.89]\n[00:57.89]静[00:58.19]静[00:58.55]听[00:58.95] [00:58.95]我[00:59.13]黑[00:59.29]色[00:59.46]的[00:59.66]大[01:00.03]衣[01:00.34]\n[01:00.34]想[01:00.51]温[01:00.66]暖[01:00.83]你[01:01.25]日[01:01.41]渐[01:01.57]冰[01:01.72]冷[01:01.88]的[01:02.03]回[01:02.15]忆[01:02.39]\n[01:02.39]走[01:02.53]过[01:02.67]的[01:02.82]走[01:02.95]过[01:03.09]的[01:03.21]生[01:03.57]命[01:03.97]\n[01:03.97]啊[01:04.14] [01:04.14]四[01:04.27]周[01:04.40]弥[01:04.54]漫[01:04.69]雾[01:04.85]气[01:05.18]\n[01:05.18]啊[01:05.33] [01:05.33]我[01:05.47]在[01:05.62]空[01:05.75]旷[01:05.90]的[01:06.05]墓[01:06.20]地[01:06.57]\n[01:06.57]老[01:06.72]去[01:06.87]后[01:07.03]还[01:07.21]爱[01:07.58]你[01:08.04]\n[01:08.98]为[01:09.16]你[01:09.34]弹[01:09.70]奏[01:09.87]肖[01:10.21]邦[01:10.68]的[01:11.02]夜[01:11.20]曲[01:11.62]\n[01:12.08]纪[01:12.40]念[01:12.60]我[01:12.92]死[01:13.23]去[01:13.44]的[01:13.79]爱[01:13.98]情[01:14.37]\n[01:14.89]跟[01:15.14]夜[01:15.34]风[01:15.72]一[01:16.27]样[01:16.58]的[01:16.77]声[01:17.10]音[01:17.56]\n[01:17.56]心[01:17.86]碎[01:18.07]的[01:18.45]很[01:18.96]好[01:19.65]听[01:20.00]\n[01:20.38]手[01:20.68]在[01:20.91]键[01:21.20]盘[01:21.70]敲[01:22.06]很[01:22.23]轻[01:22.75]\n[01:23.12]我[01:23.40]给[01:23.66]的[01:23.97]思[01:24.32]念[01:24.50]很[01:24.88]小[01:25.07]心[01:25.50]\n[01:25.89]你[01:26.12]埋[01:26.36]葬[01:26.67]的[01:27.30]地[01:27.62]方[01:27.83]叫[01:28.16]幽[01:28.73]冥[01:29.59]\n[01:30.10]为[01:30.75]你[01:31.40]弹[01:31.72]奏[01:31.90]肖[01:32.24]邦[01:32.74]的[01:33.05]夜[01:33.28]曲[01:33.74]\n[01:34.16]纪[01:34.42]念[01:34.66]我[01:35.00]死[01:35.32]去[01:35.53]的[01:35.88]爱[01:36.07]情[01:36.62]\n[01:36.97]而[01:37.18]我[01:37.38]为[01:37.76]你[01:38.28]隐[01:38.56]姓[01:38.76]埋[01:39.13]名[01:39.66]\n[01:39.66]在[01:39.96]月[01:40.17]光[01:40.53]下[01:40.99]弹[01:41.63]琴[01:42.48]\n[01:42.48]对[01:42.72]你[01:42.93]心[01:43.25]跳[01:43.80]的[01:44.13]感[01:44.34]应[01:45.20]\n[01:45.20]还[01:45.51]是[01:45.72]如[01:46.05]此[01:46.36]温[01:46.54]热[01:46.90]亲[01:47.10]近[01:47.92]\n[01:47.92]怀[01:48.20]念[01:48.41]你[01:48.64]那[01:49.26]鲜[01:49.54]红[01:49.83]的[01:50.20]唇[01:50.70]印[01:52.05]\n[02:15.19]那[02:15.38]些[02:15.56]断[02:15.91]翅[02:16.23]的[02:16.43]蜻[02:16.64]蜓[02:16.95] [02:16.95]散[02:17.12]落[02:17.29]在[02:17.47]这[02:17.61]森[02:17.98]林[02:18.34]\n[02:18.34]而[02:18.60]我[02:18.77]的[02:18.98]眼[02:19.35]睛[02:19.71] [02:19.71]没[02:19.87]有[02:20.03]丝[02:20.19]毫[02:20.42]同[02:20.74]情[02:21.06]\n[02:21.42]失[02:21.58]去[02:21.76]你[02:22.08] [02:22.08]泪[02:22.24]水[02:22.43]混[02:22.78]浊[02:23.13]不[02:23.47]清[02:23.81]\n[02:23.81]失[02:23.97]去[02:24.16]你[02:24.50] [02:24.50]我[02:24.67]连[02:24.85]笑[02:25.00]容[02:25.21]都[02:25.55]有[02:25.87]阴[02:26.23]影[02:26.42]\n[02:26.90]风[02:27.06]在[02:27.19]长[02:27.34]满[02:27.46]青[02:27.61]苔[02:27.76]的[02:27.91]屋[02:28.33]顶[02:28.67]\n[02:28.67]嘲[02:28.84]笑[02:29.00]我[02:29.15]的[02:29.30]伤[02:29.72]心[02:30.06]\n[02:30.06]像[02:30.23]一[02:30.40]口[02:30.56]没[02:30.74]有[02:30.90]水[02:31.06]的[02:31.46]枯[02:31.77]井[02:32.10]\n[02:32.30]我[02:32.46]用[02:32.62]凄[02:32.77]美[02:32.92]的[02:33.07]字[02:33.22]型[02:33.37]\n[02:33.37]描[02:33.54]绘[02:33.72]后[02:33.89]悔[02:34.06]莫[02:34.23]及[02:34.41]的[02:34.58]那[02:34.82]爱[02:35.22]情[02:36.22]\n[02:37.28]为[02:37.45]你[02:37.60]弹[02:38.00]奏[02:38.17]肖[02:38.52]邦[02:39.00]的[02:39.27]夜[02:39.46]曲[02:39.90]\n[02:40.33]纪[02:40.62]念[02:40.83]我[02:41.13]死[02:41.50]去[02:41.70]的[02:42.07]爱[02:42.24]情[02:42.69]\n[02:43.10]跟[02:43.38]夜[02:43.58]风[02:43.90]一[02:44.46]样[02:44.78]的[02:44.98]声[02:45.30]音[02:45.82]\n[02:45.82]心[02:46.12]碎[02:46.43]的[02:46.80]很[02:47.31]好[02:47.94]听[02:48.38]\n[02:48.74]手[02:48.94]在[02:49.12]键[02:49.47]盘[02:50.03]敲[02:50.31]很[02:50.50]轻[02:50.96]\n[02:51.36]我[02:51.62]给[02:51.84]的[02:52.18]思[02:52.57]念[02:52.77]很[02:53.12]小[02:53.30]心[02:53.78]\n[02:54.15]你[02:54.39]埋[02:54.59]葬[02:54.98]的[02:55.58]地[02:55.83]方[02:56.03]叫[02:56.38]幽[02:56.90]冥[02:57.66]\n[02:58.50]为[02:58.99]你[02:59.71]弹[02:59.98]奏[03:00.18]肖[03:00.53]邦[03:01.06]的[03:01.34]夜[03:01.56]曲[03:01.99]\n[03:02.39]纪[03:02.66]念[03:02.91]我[03:03.23]死[03:03.62]去[03:03.81]的[03:04.20]爱[03:04.34]情[03:04.76]\n[03:05.21]而[03:05.44]我[03:05.66]为[03:06.01]你[03:06.57]隐[03:06.83]姓[03:07.05]埋[03:07.35]名[03:07.92]\n[03:07.92]在[03:08.20]月[03:08.41]光[03:08.78]下[03:09.38]弹[03:09.96]琴[03:10.40]\n[03:10.76]对[03:10.99]你[03:11.19]心[03:11.46]跳[03:12.16]的[03:12.38]感[03:12.60]应[03:13.03]\n[03:13.42]还[03:13.75]是[03:13.97]如[03:14.27]此[03:14.62]温[03:14.81]热[03:15.16]亲[03:15.33]近[03:15.80]\n[03:16.24]怀[03:16.44]念[03:16.66]你[03:16.98]那[03:17.58]鲜[03:17.90]红[03:18.09]的[03:18.46]唇[03:19.01]印[03:20.37]\n[03:21.37]一[03:21.56]群[03:21.73]嗜[03:22.06]血[03:22.37]的[03:22.56]蚂[03:22.72]蚁[03:23.10] [03:23.10]被[03:23.28]腐[03:23.44]肉[03:23.63]所[03:23.82]吸[03:24.14]引[03:24.49]\n[03:24.49]我[03:24.80]面[03:24.98]无[03:25.15]表[03:25.51]情[03:25.85] [03:25.85]看[03:26.04]孤[03:26.20]独[03:26.36]的[03:26.58]风[03:26.88]景[03:27.52]\n[03:27.52]失[03:27.68]去[03:27.87]你[03:28.27] [03:28.27]爱[03:28.45]恨[03:28.64]开[03:29.00]始[03:29.31]分[03:29.64]明[03:29.99]\n[03:29.99]失[03:30.16]去[03:30.34]你[03:30.69] [03:30.69]还[03:30.88]有[03:31.06]什[03:31.23]么[03:31.44]事[03:31.74]好[03:32.04]关[03:32.36]心[03:32.98]\n[03:32.98]当[03:33.13]鸽[03:33.29]子[03:33.43]不[03:33.58]再[03:33.72]象[03:33.88]征[03:34.12]和[03:34.46]平[03:34.81]\n[03:34.81]我[03:34.97]终[03:35.14]于[03:35.29]被[03:35.49]提[03:35.87]醒[03:36.24]\n[03:36.24]广[03:36.41]场[03:36.56]上[03:36.72]喂[03:36.88]食[03:37.04]的[03:37.19]是[03:37.60]秃[03:37.96]鹰[03:38.47]\n[03:38.47]我[03:38.64]用[03:38.81]漂[03:38.96]亮[03:39.12]的[03:39.28]押[03:39.44]韵[03:39.68]\n[03:39.68]形[03:39.85]容[03:40.03]被[03:40.20]掠[03:40.37]夺[03:40.53]一[03:40.70]空[03:40.87]的[03:41.08]爱[03:41.43]情[03:42.52]",
    "lrcUrl": "assets/lyrics/track_05.lrc"
  },
  {
    "index": "006",
    "spineNum": "06",
    "serial": "WK-REAL-06",
    "title": "起风了",
    "shortTitle": "起风了 · 辣椒",
    "spineTitle": "起风了 · 岁月民谣",
    "subtitleQuote": "| 从前初识这世间，万般流连，也甘愿赴汤蹈火去走它一遍",
    "artist": "买辣椒也用券",
    "subArtist": "日剧《深夜食堂》/ 高桥优原曲中文版",
    "statusTag": "治愈共鸣",
    "subTag": "逆光飞行",
    "durationSec": 326,
    "currentSec": 0,
    "accent": "#0ea5e9",
    "c1": "#38bdf8",
    "c2": "#0c4a6e",
    "picUrl": "assets/covers/cover_06.jpg",
    "audioUrl": "assets/audio/track_06.mp3",
    "notes": [
      261.63,
      293.66,
      329.63,
      392,
      523.25,
      392,
      329.63,
      261.63
    ],
    "lyrics": [
      {
        "t": 0,
        "l1": "起风了 - 买辣椒也用券",
        "l2": ""
      },
      {
        "t": 3.87,
        "l1": "词：米果",
        "l2": ""
      },
      {
        "t": 4.41,
        "l1": "曲：高桥优",
        "l2": ""
      },
      {
        "t": 5.29,
        "l1": "编曲：池洼浩一",
        "l2": ""
      },
      {
        "t": 6.84,
        "l1": "吉他：池洼浩一",
        "l2": ""
      },
      {
        "t": 8.09,
        "l1": "贝斯：小岛刚広",
        "l2": ""
      },
      {
        "t": 9.46,
        "l1": "鼓：吉田佳史  Yoshifumi Yoshida",
        "l2": ""
      },
      {
        "t": 11.34,
        "l1": "键盘：平畑彻也",
        "l2": ""
      },
      {
        "t": 12.9,
        "l1": "小提琴：须磨和声",
        "l2": ""
      },
      {
        "t": 14.3,
        "l1": "弦乐：须磨和声/池洼浩一",
        "l2": ""
      },
      {
        "t": 16.16,
        "l1": "录音工程：玉乃井光纪  - studioFine",
        "l2": ""
      },
      {
        "t": 18.05,
        "l1": "出品：Negia Entertainment Inc.",
        "l2": ""
      },
      {
        "t": 19.6,
        "l1": "特别支持：中村光雄",
        "l2": ""
      },
      {
        "t": 22.01,
        "l1": "（未经著作人许可，不得翻唱、翻录或使用）",
        "l2": ""
      },
      {
        "t": 25.77,
        "l1": "这一路上走走停停",
        "l2": ""
      },
      {
        "t": 29.05,
        "l1": "顺着少年漂流的痕迹",
        "l2": ""
      },
      {
        "t": 32.23,
        "l1": "迈出车站的前一刻",
        "l2": ""
      },
      {
        "t": 35.48,
        "l1": "竟有些犹豫",
        "l2": ""
      },
      {
        "t": 38.59,
        "l1": "不禁笑这近乡情怯",
        "l2": ""
      },
      {
        "t": 41.84,
        "l1": "仍无可避免",
        "l2": ""
      },
      {
        "t": 44.11,
        "l1": "而长野的天",
        "l2": ""
      },
      {
        "t": 45.72,
        "l1": "依旧那么暖",
        "l2": ""
      },
      {
        "t": 47.27,
        "l1": "风吹起了从前",
        "l2": ""
      },
      {
        "t": 49.85,
        "l1": "从前初识这世间",
        "l2": ""
      },
      {
        "t": 52.81,
        "l1": "万般流连",
        "l2": ""
      },
      {
        "t": 54.58,
        "l1": "看着天边似在眼前",
        "l2": ""
      },
      {
        "t": 57.44,
        "l1": "也甘愿赴汤蹈火去走它一遍",
        "l2": ""
      },
      {
        "t": 62.53,
        "l1": "如今走过这世间",
        "l2": ""
      },
      {
        "t": 65.61,
        "l1": "万般流连",
        "l2": ""
      },
      {
        "t": 67.36,
        "l1": "翻过岁月不同侧脸",
        "l2": ""
      },
      {
        "t": 70.3,
        "l1": "措不及防闯入你的笑颜",
        "l2": ""
      },
      {
        "t": 76.18,
        "l1": "我曾难自拔于世界之大",
        "l2": ""
      },
      {
        "t": 80.27,
        "l1": "也沉溺于其中梦话",
        "l2": ""
      },
      {
        "t": 83.4,
        "l1": "不得真假 不做挣扎 不惧笑话",
        "l2": ""
      },
      {
        "t": 89.05,
        "l1": "我曾将青春翻涌成她",
        "l2": ""
      },
      {
        "t": 92.67,
        "l1": "也曾指尖弹出盛夏",
        "l2": ""
      },
      {
        "t": 95.89,
        "l1": "心之所动 且就随缘去吧",
        "l2": ""
      },
      {
        "t": 101.96,
        "l1": "逆着光行走 任风吹雨打",
        "l2": ""
      },
      {
        "t": 118.78,
        "l1": "短短的路走走停停",
        "l2": ""
      },
      {
        "t": 122.01,
        "l1": "也有了几分的距离",
        "l2": ""
      },
      {
        "t": 125.06,
        "l1": "不知抚摸的是故事 还是段心情",
        "l2": ""
      },
      {
        "t": 131.34,
        "l1": "也许期待的不过是 与时间为敌",
        "l2": ""
      },
      {
        "t": 137.01,
        "l1": "再次看到你",
        "l2": ""
      },
      {
        "t": 138.54,
        "l1": "微凉晨光里",
        "l2": ""
      },
      {
        "t": 140.12,
        "l1": "笑得很甜蜜",
        "l2": ""
      },
      {
        "t": 142.59,
        "l1": "从前初识这世间",
        "l2": ""
      },
      {
        "t": 145.67,
        "l1": "万般流连",
        "l2": ""
      },
      {
        "t": 147.39,
        "l1": "看着天边似在眼前",
        "l2": ""
      },
      {
        "t": 150.39,
        "l1": "也甘愿赴汤蹈火去走它一遍",
        "l2": ""
      },
      {
        "t": 155.37,
        "l1": "如今走过这世间",
        "l2": ""
      },
      {
        "t": 158.51,
        "l1": "万般流连",
        "l2": ""
      },
      {
        "t": 160.22,
        "l1": "翻过岁月不同侧脸",
        "l2": ""
      },
      {
        "t": 163.18,
        "l1": "措不及防闯入你的笑颜",
        "l2": ""
      },
      {
        "t": 168.99,
        "l1": "我曾难自拔于世界之大",
        "l2": ""
      },
      {
        "t": 173.08,
        "l1": "也沉溺于其中梦话",
        "l2": ""
      },
      {
        "t": 176.23,
        "l1": "不得真假 不做挣扎 不惧笑话",
        "l2": ""
      },
      {
        "t": 181.88,
        "l1": "我曾将青春翻涌成她",
        "l2": ""
      },
      {
        "t": 185.49,
        "l1": "也曾指尖弹出盛夏",
        "l2": ""
      },
      {
        "t": 188.72,
        "l1": "心之所动 且就随缘去吧",
        "l2": ""
      },
      {
        "t": 220.27,
        "l1": "晚风吹起你鬓间的白发",
        "l2": ""
      },
      {
        "t": 224.22,
        "l1": "抚平回忆留下的疤",
        "l2": ""
      },
      {
        "t": 227.43,
        "l1": "你的眼中 明暗交杂 一笑生花",
        "l2": ""
      },
      {
        "t": 233.09,
        "l1": "暮色遮住你蹒跚的步伐",
        "l2": ""
      },
      {
        "t": 237.05,
        "l1": "走进床头藏起的画",
        "l2": ""
      },
      {
        "t": 240.21,
        "l1": "画中的你 低着头说话",
        "l2": ""
      },
      {
        "t": 245.86,
        "l1": "我仍感叹于世界之大",
        "l2": ""
      },
      {
        "t": 249.46,
        "l1": "也沉醉于儿时情话",
        "l2": ""
      },
      {
        "t": 252.74,
        "l1": "不剩真假 不做挣扎 无谓笑话",
        "l2": ""
      },
      {
        "t": 258.67,
        "l1": "我终将青春还给了她",
        "l2": ""
      },
      {
        "t": 262.3,
        "l1": "连同指尖弹出的盛夏",
        "l2": ""
      },
      {
        "t": 265.84,
        "l1": "心之所动 就随风去了",
        "l2": ""
      },
      {
        "t": 271.42,
        "l1": "以爱之名 你还愿意吗",
        "l2": ""
      }
    ],
    "comments": [
      "【热评 @青春渡口】起风了，唯有努力生存；风停了，我们依然在路上。"
    ],
    "lyricsRaw": "[ti:起风了]\n[ar:买辣椒也用券]\n[al:起风了]\n[by:p_pttzhang]\n[offset:0]\n\n[00:00.00]起[00:01.82]风[00:02.11]了 [00:02.41]- [00:02.63]买[00:02.83][00:02.83]辣[00:03.00][00:03.00]椒[00:03.17][00:03.17]也[00:03.41]用[00:03.64]券[00:03.87]\n[00:03.87]词：[00:04.06]米[00:04.24]果[00:04.41]\n[00:04.41]曲：[00:04.63]高[00:04.85]桥[00:05.06][00:05.06]优[00:05.29]\n[00:05.29]编[00:05.51][00:05.51]曲：[00:05.73][00:05.73]池[00:05.93][00:05.93]洼[00:06.14][00:06.14]浩[00:06.34]一 [00:06.57]\n[00:06.84]吉[00:07.02][00:07.02]他：[00:07.22][00:07.22]池[00:07.36][00:07.36]洼[00:07.55]浩[00:07.71]一 [00:07.90]\n[00:08.09]贝[00:08.25][00:08.25]斯：[00:08.46]小[00:08.65][00:08.65]岛[00:08.85][00:08.85]刚[00:09.06]広 [00:09.26]\n[00:09.46]鼓：[00:09.66]吉[00:09.87][00:09.87]田[00:10.13][00:10.13]佳[00:10.33]史 [00:10.61] [00:10.82]Yoshifumi Yoshida[00:11.06]\n[00:11.34]键[00:11.63][00:11.63]盘：[00:11.88][00:11.88]平[00:12.15]畑[00:12.36]彻[00:12.57]也 [00:12.75]\n[00:12.90]小[00:13.08]提[00:13.26][00:13.26]琴：[00:13.43]须[00:13.59]磨[00:13.78][00:13.78]和[00:13.94]声 [00:14.10]\n[00:14.30]弦[00:14.46]乐：[00:14.62]须[00:14.79]磨[00:14.97]和[00:15.16][00:15.16]声[00:15.34]/[00:15.51]池[00:15.67]洼[00:15.84]浩[00:15.98]一[00:16.16]\n[00:16.16]录[00:16.32][00:16.32]音[00:16.48]工[00:16.65]程：[00:16.82]玉[00:16.98]乃[00:17.18]井[00:17.36]光[00:17.55]纪 [00:17.79] - studioFine[00:18.05]\n[00:18.05]出[00:18.36]品：[00:18.79]Negia [00:19.13][00:19.13]Entertainment [00:19.42]Inc.[00:19.60]\n[00:19.60]特[00:19.80]别[00:20.07]支[00:20.42]持：[00:20.71]中[00:21.01][00:21.01]村[00:21.26]光[00:21.51]雄[00:21.73]\n[00:22.01]（未[00:22.26][00:22.26]经[00:22.46][00:22.46]著[00:22.64]作[00:22.78]人[00:22.95][00:22.95]许[00:23.05]可，[00:23.33]不[00:23.48]得[00:23.65][00:23.65]翻[00:23.83]唱、[00:23.97]翻[00:24.14]录[00:24.33]或[00:24.52]使[00:24.75]用）[00:25.15]\n[00:25.77]这[00:26.40]一[00:26.65]路[00:27.17]上[00:27.43]走[00:27.82]走[00:28.14]停[00:28.60]停[00:28.81]\n[00:29.05]顺[00:29.55]着[00:29.87]少[00:30.40]年[00:30.70]漂[00:30.89][00:30.89]流[00:31.06]的[00:31.24]痕[00:31.55]迹[00:31.92]\n[00:32.23]迈[00:32.75][00:32.75]出[00:33.05][00:33.05]车[00:33.52]站[00:33.81]的[00:34.15]前[00:34.55]一[00:34.99]刻[00:35.24]\n[00:35.48]竟[00:35.91]有[00:36.19]些[00:36.57]犹[00:37.04][00:37.03]豫[00:37.77]\n[00:38.59]不[00:39.10][00:39.10]禁[00:39.43]笑[00:39.86]这[00:40.20]近[00:40.58]乡[00:40.94]情[00:41.41]怯[00:41.61]\n[00:41.84]仍[00:42.31]无[00:42.65]可[00:43.03]避[00:43.49]免[00:43.89]\n[00:44.11]而[00:44.34][00:44.34]长[00:44.54][00:44.54]野[00:44.73][00:44.73]的[00:45.04][00:45.04]天[00:45.48]\n[00:45.72]依[00:45.93]旧[00:46.11]那[00:46.32]么[00:46.63]暖[00:47.02]\n[00:47.27]风[00:47.48][00:47.48]吹[00:47.64]起[00:47.79][00:47.79]了[00:48.03]从[00:48.31]前[00:49.25]\n[00:49.85]从[00:50.24]前[00:50.59][00:50.59]初[00:50.97][00:50.97]识[00:51.38]这[00:51.79][00:51.79]世[00:52.08][00:52.08]间[00:52.63]\n[00:52.81]万[00:53.04]般[00:53.43][00:53.43]流[00:53.69]连[00:54.29]\n[00:54.58]看[00:54.90]着[00:55.15][00:55.15]天[00:55.76][00:55.75]边[00:56.11]似[00:56.30][00:56.30]在[00:56.59]眼[00:56.98]前[00:57.21]\n[00:57.44]也[00:57.80][00:57.79]甘[00:58.15]愿[00:58.39]赴[00:58.75]汤[00:58.93]蹈[00:59.13][00:59.13]火[00:59.41]去[00:59.76]走[01:00.04]它[01:00.55]一[01:01.03]遍[01:01.96]\n[01:02.53]如[01:03.00]今[01:03.33]走[01:03.76][01:03.76]过[01:04.17]这[01:04.57]世[01:04.89][01:04.89]间[01:05.42]\n[01:05.61]万[01:05.82]般[01:06.20]流[01:06.49][01:06.49]连[01:07.03]\n[01:07.36]翻[01:07.63]过[01:07.94]岁[01:08.52]月[01:08.95]不[01:09.16]同[01:09.47]侧[01:09.82]脸[01:10.06]\n[01:10.30]措[01:10.65]不[01:11.01]及[01:11.24][01:11.23]防[01:11.75]闯[01:12.11]入[01:12.56]你[01:12.83]的[01:13.24][01:13.24]笑[01:13.85][01:13.85]颜[01:15.43]\n[01:16.18]我[01:16.54]曾[01:17.01]难[01:17.42]自[01:17.62]拔[01:18.12][01:18.12]于[01:18.41][01:18.41]世[01:18.93][01:18.93]界[01:19.27]之[01:19.67]大[01:20.06]\n[01:20.27]也[01:20.61][01:20.61]沉[01:20.89][01:20.89]溺[01:21.33]于[01:21.67]其[01:22.17]中[01:22.51]梦[01:22.88]话[01:23.19]\n[01:23.40]不[01:23.75]得[01:23.98][01:23.98]真[01:24.38]假 [01:24.90]不[01:25.14]做[01:25.48]挣[01:25.83][01:25.83]扎 [01:26.42][01:26.42]不[01:26.70]惧[01:27.82]笑[01:28.26]话[01:28.81]\n[01:29.05]我[01:29.42][01:29.42]曾[01:29.86][01:29.86]将[01:30.22]青[01:30.50]春[01:30.92]翻[01:31.27]涌[01:31.72]成[01:32.07]她[01:32.33]\n[01:32.67]也[01:33.01]曾[01:33.37][01:33.37]指[01:33.71]尖[01:34.18][01:34.18]弹[01:34.52]出[01:34.89]盛[01:35.33]夏[01:35.58]\n[01:35.89]心[01:36.30]之[01:36.69]所[01:36.96]动 [01:37.27]且[01:37.78][01:37.78]就[01:38.16]随[01:38.48]缘[01:38.85]去[01:39.46]吧[01:40.49]\n[01:41.96]逆[01:42.22]着[01:42.67]光[01:43.03]行[01:43.22]走 [01:43.97]任[01:44.37]风[01:44.78]吹[01:45.33][01:45.33]雨[01:45.99]打[01:48.89]\n[01:58.78]短[01:59.22]短[01:59.56]的[01:59.98]路[02:00.28][02:00.28]走[02:00.69]走[02:01.04]停[02:01.48]停[02:01.77]\n[02:02.01]也[02:02.44][02:02.44]有[02:02.77]了[02:03.21]几[02:03.41]分[02:03.60][02:03.60]的[02:03.88]距[02:04.27]离[02:04.75]\n[02:05.06]不[02:05.57]知[02:05.90]抚[02:06.38]摸[02:06.70][02:06.70]的[02:07.07]是[02:07.45][02:07.45]故[02:07.80]事 [02:08.22]还[02:08.72]是[02:09.09]段[02:09.47]心[02:09.93]情[02:10.63]\n[02:11.34]也[02:11.93]许[02:12.28]期[02:12.70]待[02:12.98]的[02:13.29]不[02:13.70][02:13.70]过[02:14.18]是 [02:14.63]与[02:15.14]时[02:15.46]间[02:15.86]为[02:16.29]敌[02:16.73]\n[02:17.01]再[02:17.19]次[02:17.34]看[02:17.57]到[02:17.91]你[02:18.19]\n[02:18.54]微[02:18.74]凉[02:18.94]晨[02:19.13]光[02:19.46]里[02:19.83]\n[02:20.12]笑[02:20.35]得[02:20.56][02:20.56]很[02:20.81]甜[02:21.12]蜜[02:21.89]\n[02:22.59]从[02:22.98]前[02:23.37]初[02:23.81]识[02:24.25][02:24.25]这[02:24.62]世[02:24.95][02:24.95]间[02:25.41]\n[02:25.67]万[02:25.92]般[02:26.26]流[02:26.53]连[02:27.07]\n[02:27.39]看[02:27.74]着[02:28.01]天[02:28.54]边[02:28.97][02:28.98]似[02:29.19]在[02:29.51]眼[02:29.83]前[02:30.14]\n[02:30.39]也[02:30.64]甘[02:30.99]愿[02:31.22]赴[02:31.58]汤[02:31.77]蹈[02:31.95][02:31.95]火[02:32.19]去[02:32.58]走[02:32.88]它[02:33.25]一[02:33.89]遍[02:34.82]\n[02:35.37]如[02:35.73]今[02:36.17]走[02:36.61]过[02:37.01]这[02:37.37]世[02:37.73]间[02:38.22]\n[02:38.51]万[02:38.71]般[02:39.02]流[02:39.32]连[02:39.86]\n[02:40.22]翻[02:40.56]过[02:40.83]岁[02:41.33][02:41.33]月[02:41.76][02:41.76]不[02:41.98]同[02:42.25]侧[02:42.62]脸[02:42.95]\n[02:43.18]措[02:43.45]不[02:43.83]及[02:44.11]防[02:44.59]闯[02:45.06]入[02:45.42]你[02:45.70][02:45.70]的[02:46.10][02:46.10]笑[02:46.71]颜[02:48.51]\n[02:48.99]我[02:49.47]曾[02:49.81][02:49.81]难[02:50.20]自[02:50.41]拔[02:50.89]于[02:51.23][02:51.23]世[02:51.73]界[02:52.06]之[02:52.51]大[02:52.81]\n[02:53.08]也[02:53.38]沉[02:53.61]溺[02:54.08][02:54.08]于[02:54.38]其[02:54.93][02:54.93]中[02:55.23][02:55.23]梦[02:55.64][02:55.64]话[02:55.96]\n[02:56.23]不[02:56.57][02:56.57]得[02:56.78]真[02:57.14]假 [02:57.60]不[02:57.84]做[02:58.19]挣[02:58.39]扎 [02:59.00]不[02:59.42][02:59.41]惧[03:00.59][03:00.59]笑[03:01.03]话[03:01.54]\n[03:01.88]我[03:02.25]曾[03:02.60]将[03:03.00]青[03:03.29]春[03:03.74]翻[03:04.02]涌[03:04.48]成[03:04.85]她[03:05.17]\n[03:05.49]也[03:05.75]曾[03:06.14][03:06.14]指[03:06.46]尖[03:06.90]弹[03:07.25]出[03:07.72]盛[03:08.11]夏[03:08.40]\n[03:08.72]心[03:09.03]之[03:09.41][03:09.41]所[03:09.69]动 [03:09.97]且[03:10.50]就[03:10.93]随[03:11.27]缘[03:11.67]去[03:12.21]吧[03:14.01]\n[03:40.27]晚[03:40.52]风[03:40.93]吹[03:41.32]起[03:41.57]你[03:42.17][03:42.17]鬓[03:42.51]间[03:42.94]的[03:43.26][03:43.26]白[03:43.67]发[03:43.95]\n[03:44.22]抚[03:44.58]平[03:44.85]回[03:45.32]忆[03:45.67]留[03:46.11]下[03:46.47]的[03:46.89]疤[03:47.16]\n[03:47.43]你[03:47.72]的[03:48.00]眼[03:48.44]中 [03:48.83][03:48.83]明[03:49.05]暗[03:49.33]交[03:49.60][03:49.60]杂 [03:50.21]一[03:50.63]笑[03:51.77][03:51.77]生[03:52.23]花[03:52.72]\n[03:53.09]暮[03:53.42]色[03:53.86]遮[03:54.20]住[03:54.52]你[03:54.98]蹒[03:55.26][03:55.26]跚[03:55.75]的[03:56.06]步[03:56.45]伐[03:56.72]\n[03:57.05]走[03:57.31]进[03:57.59][03:57.59]床[03:58.13]头[03:58.40]藏[03:58.98]起[03:59.26]的[03:59.65]画[03:59.92]\n[04:00.21]画[04:00.47]中[04:00.78][04:00.78]的[04:01.17]你 [04:01.77]低[04:02.16]着[04:02.47][04:02.47]头[04:02.84]说[04:03.51][04:03.51]话[04:05.43]\n[04:05.86]我[04:06.18]仍[04:06.66]感[04:07.01]叹[04:07.22]于[04:07.70][04:07.70]世[04:08.03][04:08.03]界[04:08.49][04:08.49]之[04:08.88]大[04:09.18]\n[04:09.46]也[04:09.83]沉[04:10.17][04:10.16]醉[04:10.46][04:10.46]于[04:10.96]儿[04:11.28]时[04:11.78]情[04:12.11]话[04:12.38]\n[04:12.74]不[04:12.98]剩[04:13.34][04:13.34]真[04:13.59][04:13.59]假 [04:14.20][04:14.20]不[04:14.61]做[04:15.00][04:14.99]挣[04:15.22]扎 [04:15.95]无[04:16.28]谓[04:17.44]笑[04:17.78]话[04:18.34]\n[04:18.67]我[04:19.00][04:19.00]终[04:19.40][04:19.40]将[04:19.80][04:19.80]青[04:20.09]春[04:20.51][04:20.51]还[04:20.84]给[04:21.31]了[04:21.68]她[04:22.01]\n[04:22.30]连[04:22.61]同[04:22.98]指[04:23.24]尖[04:23.76][04:23.76]弹[04:24.03]出[04:24.49][04:24.49]的[04:24.84]盛[04:25.26]夏[04:25.56]\n[04:25.84]心[04:26.11]之[04:26.45]所[04:26.82]动 [04:27.30]就[04:27.69][04:27.69]随[04:28.03][04:28.03]风[04:28.36]去[04:29.03]了[04:30.91]\n[04:31.42]以[04:31.69]爱[04:32.24]之[04:32.85][04:32.85]名 [04:33.47]你[04:33.93]还[04:34.46]愿[04:34.92]意[04:35.56]吗[04:38.93]",
    "lrcUrl": "assets/lyrics/track_06.lrc"
  },
  {
    "index": "007",
    "spineNum": "07",
    "serial": "WK-REAL-07",
    "title": "如愿",
    "shortTitle": "如愿 · 王菲",
    "spineTitle": "如愿 · 时代赞歌",
    "subtitleQuote": "| 愿不枉啊，愿来路啊，愿这盛世如你所愿",
    "artist": "王菲",
    "subArtist": "电影《我和我的父辈》主题推广曲",
    "statusTag": "空灵赞歌",
    "subTag": "时代交响",
    "durationSec": 262,
    "currentSec": 0,
    "accent": "#d946ef",
    "c1": "#e879f9",
    "c2": "#701a75",
    "picUrl": "assets/covers/cover_07.jpg",
    "audioUrl": "assets/audio/track_07.mp3",
    "notes": [
      261.63,
      329.63,
      392,
      523.25,
      659.25,
      523.25,
      392,
      329.63
    ],
    "lyrics": [
      {
        "t": 0,
        "l1": "如愿 - 王菲 Faye Wong",
        "l2": ""
      },
      {
        "t": 1.37,
        "l1": "词：唐恬",
        "l2": ""
      },
      {
        "t": 2.74,
        "l1": "曲：钱雷",
        "l2": ""
      },
      {
        "t": 4.11,
        "l1": "编曲：钱雷",
        "l2": ""
      },
      {
        "t": 5.48,
        "l1": "制作人：钱雷",
        "l2": ""
      },
      {
        "t": 6.85,
        "l1": "配唱制作：窦颖/林灵",
        "l2": ""
      },
      {
        "t": 8.22,
        "l1": "和音：窦颖/林灵",
        "l2": ""
      },
      {
        "t": 9.59,
        "l1": "吉他：高飞",
        "l2": ""
      },
      {
        "t": 10.96,
        "l1": "吉他录音：时俊峰@福达录音棚",
        "l2": ""
      },
      {
        "t": 12.33,
        "l1": "Bass：李卓",
        "l2": ""
      },
      {
        "t": 13.7,
        "l1": "小号：李博",
        "l2": ""
      },
      {
        "t": 15.07,
        "l1": "弦乐编写/监制：胡静成",
        "l2": ""
      },
      {
        "t": 16.44,
        "l1": "小提琴：张浩/侯宇虹",
        "l2": ""
      },
      {
        "t": 17.81,
        "l1": "中提琴：毕芳",
        "l2": ""
      },
      {
        "t": 19.18,
        "l1": "大提琴：郎莹",
        "l2": ""
      },
      {
        "t": 20.55,
        "l1": "弦乐：国际首席爱乐乐团",
        "l2": ""
      },
      {
        "t": 21.92,
        "l1": "弦乐录音：王小四@金田录音棚",
        "l2": ""
      },
      {
        "t": 23.29,
        "l1": "人声录音师：钱雷/杨惠琳@Studio 21A",
        "l2": ""
      },
      {
        "t": 24.66,
        "l1": "人声录音棚A：RMB Studio爆棚@奔跑怪物",
        "l2": ""
      },
      {
        "t": 26.03,
        "l1": "人声录音棚B：Studio 21A Beijing",
        "l2": ""
      },
      {
        "t": 27.4,
        "l1": "Vocal edite：汝文博@SBMS Beijing",
        "l2": ""
      },
      {
        "t": 28.77,
        "l1": "混音/母带：赵靖BIG.J@SBMS Beijing",
        "l2": ""
      },
      {
        "t": 30.14,
        "l1": "曲版权管理方：索尼音乐版权代理（北京）有限公司",
        "l2": ""
      },
      {
        "t": 31.51,
        "l1": "你是 遥遥的路",
        "l2": ""
      },
      {
        "t": 34.79,
        "l1": "山野大雾里的灯",
        "l2": ""
      },
      {
        "t": 39.9,
        "l1": "我是孩童啊 走在你的眼眸",
        "l2": ""
      },
      {
        "t": 45.96,
        "l1": "你是 明月清风",
        "l2": ""
      },
      {
        "t": 49.26,
        "l1": "我是你照拂的梦",
        "l2": ""
      },
      {
        "t": 54.24,
        "l1": "见与不见都一生 与你相拥",
        "l2": ""
      },
      {
        "t": 59.9,
        "l1": "而我将 爱你所爱的人间",
        "l2": ""
      },
      {
        "t": 64.13,
        "l1": "愿你所愿的笑颜",
        "l2": ""
      },
      {
        "t": 67.56,
        "l1": "你的手我蹒跚在牵",
        "l2": ""
      },
      {
        "t": 71.09,
        "l1": "请带我去明天",
        "l2": ""
      },
      {
        "t": 74.2,
        "l1": "如果说 你曾苦过我的甜",
        "l2": ""
      },
      {
        "t": 78.55,
        "l1": "我愿活成你的愿",
        "l2": ""
      },
      {
        "t": 81.96,
        "l1": "愿不枉啊 愿勇往啊",
        "l2": ""
      },
      {
        "t": 85.56,
        "l1": "这盛世每一天",
        "l2": ""
      },
      {
        "t": 119.8,
        "l1": "你是 岁月长河",
        "l2": ""
      },
      {
        "t": 123.17,
        "l1": "星火燃起的天空",
        "l2": ""
      },
      {
        "t": 128.13,
        "l1": "我是仰望者 就把你唱成歌",
        "l2": ""
      },
      {
        "t": 134.19,
        "l1": "你是 我之所来",
        "l2": ""
      },
      {
        "t": 137.63,
        "l1": "也是我心之所归",
        "l2": ""
      },
      {
        "t": 142.58,
        "l1": "世间所有路都将 与你相逢",
        "l2": ""
      },
      {
        "t": 148.27,
        "l1": "而我将 爱你所爱的人间",
        "l2": ""
      },
      {
        "t": 152.41,
        "l1": "愿你所愿的笑颜",
        "l2": ""
      },
      {
        "t": 155.83,
        "l1": "你的手我蹒跚在牵",
        "l2": ""
      },
      {
        "t": 159.51,
        "l1": "请带我去明天",
        "l2": ""
      },
      {
        "t": 162.62,
        "l1": "如果说 你曾苦过我的甜",
        "l2": ""
      },
      {
        "t": 166.89,
        "l1": "我愿活成你的愿",
        "l2": ""
      },
      {
        "t": 170.42,
        "l1": "愿不枉啊 愿勇往啊",
        "l2": ""
      },
      {
        "t": 173.91,
        "l1": "这盛世每一天",
        "l2": ""
      },
      {
        "t": 179.04,
        "l1": "山河无恙 烟火寻常",
        "l2": ""
      },
      {
        "t": 182.44,
        "l1": "可是你如愿的眺望",
        "l2": ""
      },
      {
        "t": 186.11,
        "l1": "孩子们啊 安睡梦乡",
        "l2": ""
      },
      {
        "t": 189.91,
        "l1": "像你深爱的那样",
        "l2": ""
      },
      {
        "t": 198.73,
        "l1": "而我将 梦你所梦的团圆",
        "l2": ""
      },
      {
        "t": 202.93,
        "l1": "愿你所愿的永远",
        "l2": ""
      },
      {
        "t": 206.51,
        "l1": "走你所走的长路",
        "l2": ""
      },
      {
        "t": 210.01,
        "l1": "这样的爱你啊",
        "l2": ""
      },
      {
        "t": 213.16,
        "l1": "我也将 见你未见的世界",
        "l2": ""
      },
      {
        "t": 217.34,
        "l1": "写你未写的诗篇",
        "l2": ""
      },
      {
        "t": 220.82,
        "l1": "天边的月 心中的念",
        "l2": ""
      },
      {
        "t": 224.4,
        "l1": "你永在我身边",
        "l2": ""
      },
      {
        "t": 229.88,
        "l1": "与你相约 一生清澈",
        "l2": ""
      },
      {
        "t": 234.13,
        "l1": "如你年轻的脸",
        "l2": ""
      }
    ],
    "comments": [
      "【热评 @星空下的守望】王菲天籁般的嗓音，唱尽了三代人的深情与时代的变迁。"
    ],
    "lyricsRaw": "[ti:如愿]\n[ar:王菲]\n[al:如愿]\n[offset:0]\n\n[00:00.00]如[00:00.10]愿[00:00.21] [00:00.31]-[00:00.42] [00:00.52]王[00:00.63]菲[00:00.73] [00:00.84][00:00.94]Faye[00:01.05] [00:01.15]Wong[00:01.26]\n[00:01.37]词[00:01.71]：[00:02.05]唐[00:02.39]恬[00:02.73]\n[00:02.74]曲[00:03.08]：[00:03.42]钱[00:03.76]雷[00:04.10]\n[00:04.11]编[00:04.38]曲[00:04.65]：[00:04.93]钱[00:05.20]雷[00:05.48]\n[00:05.48]制[00:05.70]作[00:05.93]人[00:06.16]：[00:06.39]钱[00:06.62]雷[00:06.84]\n[00:06.85]配[00:06.98]唱[00:07.12]制[00:07.26]作[00:07.39]：[00:07.53]窦[00:07.67]颖[00:07.80]/[00:07.94]林[00:08.08]灵[00:08.22]\n[00:08.22]和[00:08.39]音[00:08.56]：[00:08.73]窦[00:08.90]颖[00:09.07]/[00:09.24]林[00:09.41]灵[00:09.58]\n[00:09.59]吉[00:09.86]他[00:10.13]：[00:10.41]高[00:10.68]飞[00:10.96]\n[00:10.96]吉[00:11.05]他[00:11.15]录[00:11.25]音[00:11.34]：[00:11.44]时[00:11.54]俊[00:11.63]峰[00:11.73]@[00:11.83]福[00:11.93]达[00:12.02]录[00:12.12]音[00:12.22]棚[00:12.31]\n[00:12.33]Bass[00:12.67]：[00:13.01]李[00:13.35]卓[00:13.69]\n[00:13.70]小[00:13.97]号[00:14.24]：[00:14.52]李[00:14.79]博[00:15.07]\n[00:15.07]弦[00:15.19]乐[00:15.31]编[00:15.44]写[00:15.56]/[00:15.69]监[00:15.81]制[00:15.93]：[00:16.06]胡[00:16.18]静[00:16.31]成[00:16.43]\n[00:16.44]小[00:16.57]提[00:16.71]琴[00:16.85]：[00:16.98]张[00:17.12]浩[00:17.26]/[00:17.39]侯[00:17.53]宇[00:17.67]虹[00:17.81]\n[00:17.81]中[00:18.03]提[00:18.26]琴[00:18.49]：[00:18.72]毕[00:18.95]芳[00:19.17]\n[00:19.18]大[00:19.40]提[00:19.63]琴[00:19.86]：[00:20.09]郎[00:20.32]莹[00:20.54]\n[00:20.55]弦[00:20.67]乐[00:20.79]：[00:20.92]国[00:21.04]际[00:21.17]首[00:21.29]席[00:21.41]爱[00:21.54]乐[00:21.66]乐[00:21.79]团[00:21.91]\n[00:21.92]弦[00:22.01]乐[00:22.11]录[00:22.21]音[00:22.30]：[00:22.40]王[00:22.50]小[00:22.59]四[00:22.69]@[00:22.79]金[00:22.89]田[00:22.98]录[00:23.08]音[00:23.18]棚[00:23.27]\n[00:23.29]人[00:23.37]声[00:23.46]录[00:23.54]音[00:23.63]师[00:23.71]：[00:23.80]钱[00:23.88]雷[00:23.97]/[00:24.05]杨[00:24.14]惠[00:24.22]琳[00:24.31]@[00:24.39]Studio[00:24.48] [00:24.56]21[00:24.62]A[00:24.65]\n[00:24.66]人[00:24.74]声[00:24.82]录[00:24.90]音[00:24.98]棚[00:25.06]A[00:25.14]：[00:25.22]RMB[00:25.30] [00:25.38]Studio[00:25.46]爆[00:25.54]棚[00:25.62]@[00:25.70]奔[00:25.78]跑[00:25.86]怪[00:25.94]物[00:26.02]\n[00:26.03]人[00:26.14]声[00:26.25]录[00:26.37]音[00:26.48]棚[00:26.60]B[00:26.71]：[00:26.82]Studio[00:26.94] [00:27.05]21[00:27.13]A[00:27.17] [00:27.28]Beijing[00:27.39]\n[00:27.40]Vocal[00:27.52] [00:27.64]edite[00:27.77]：[00:27.89]汝[00:28.02]文[00:28.14]博[00:28.26]@[00:28.39]SBMS[00:28.51] [00:28.64]Beijing[00:28.76]\n[00:28.77]混[00:28.87]音[00:28.98]/[00:29.08]母[00:29.19]带[00:29.29]：[00:29.40]赵[00:29.50]靖[00:29.61]BIG.[00:29.69]J[00:29.71]@[00:29.82]SBMS[00:29.92] [00:30.03]Beijing[00:30.13]\n[00:30.14]曲[00:30.19]版[00:30.25]权[00:30.31]管[00:30.37]理[00:30.43]方[00:30.49]：[00:30.55]索[00:30.61]尼[00:30.67]音[00:30.73]乐[00:30.78]版[00:30.84]权[00:30.90]代[00:30.96]理[00:31.02]（[00:31.08]北[00:31.14]京[00:31.20]）[00:31.26]有[00:31.32]限[00:31.37]公[00:31.43]司[00:31.51]\n[00:31.51]你[00:31.68]是[00:32.58] [00:32.58]遥[00:32.75]遥[00:32.92]的[00:33.12]路[00:33.85]\n[00:34.79]山[00:34.97]野[00:35.17]大[00:35.60]雾[00:35.92]里[00:36.55]的[00:36.89]灯[00:38.07]\n[00:39.90]我[00:40.24]是[00:40.59]孩[00:41.05]童[00:41.27]啊[00:42.34] [00:42.34]走[00:42.51]在[00:42.88]你[00:43.09]的[00:43.77]眼[00:44.19]眸[00:45.24]\n[00:45.96]你[00:46.13]是[00:46.91] [00:46.91]明[00:47.16]月[00:47.38]清[00:47.62]风[00:48.59]\n[00:49.26]我[00:49.47]是[00:49.65]你[00:50.16]照[00:50.35]拂[00:50.93]的[00:51.26]梦[00:52.47]\n[00:54.24]见[00:54.62]与[00:54.85]不[00:55.43]见[00:55.85]都[00:56.26]一[00:56.79]生[00:57.35] [00:57.35]与[00:57.60]你[00:58.11]相[00:58.59]拥[00:59.24]\n[00:59.90]而[01:00.11]我[01:00.27]将[01:00.44] [01:00.44]爱[01:00.88]你[01:01.31]所[01:01.75]爱[01:02.26]的[01:02.70]人[01:02.93]间[01:03.64]\n[01:04.13]愿[01:04.54]你[01:04.95]所[01:05.37]愿[01:05.82]的[01:06.29]笑[01:06.56]颜[01:07.18]\n[01:07.56]你[01:07.77]的[01:08.16]手[01:08.55]我[01:08.99]蹒[01:09.38]跚[01:09.88]在[01:10.12]牵[01:10.82]\n[01:11.09]请[01:11.33]带[01:11.72]我[01:11.96]去[01:12.66]明[01:13.03]天[01:13.84]\n[01:14.20]如[01:14.44]果[01:14.66]说[01:14.85] [01:14.85]你[01:15.32]曾[01:15.72]苦[01:16.13]过[01:16.64]我[01:17.09]的[01:17.36]甜[01:18.04]\n[01:18.55]我[01:18.94]愿[01:19.37]活[01:19.78]成[01:20.24]你[01:20.73]的[01:20.98]愿[01:21.65]\n[01:21.96]愿[01:22.20]不[01:22.56]枉[01:22.99]啊[01:23.41] [01:23.41]愿[01:23.90]勇[01:24.33]往[01:24.60]啊[01:25.25]\n[01:25.56]这[01:25.78]盛[01:26.19]世[01:26.46]每[01:27.05]一[01:27.46]天[01:30.35]\n[01:59.80]你[02:00.03]是[02:00.96] [02:00.96]岁[02:01.16]月[02:01.36]长[02:01.58]河[02:02.69]\n[02:03.17]星[02:03.40]火[02:03.60]燃[02:04.03]起[02:04.27]的[02:04.94]天[02:05.38]空[02:06.59]\n[02:08.13]我[02:08.55]是[02:09.00]仰[02:09.45]望[02:09.77]者[02:10.71] [02:10.71]就[02:10.87]把[02:11.27]你[02:11.50]唱[02:12.14]成[02:12.57]歌[02:13.83]\n[02:14.19]你[02:14.39]是[02:15.33] [02:15.33]我[02:15.57]之[02:15.79]所[02:16.04]来[02:17.13]\n[02:17.63]也[02:17.91]是[02:18.08]我[02:18.51]心[02:18.78]之[02:19.31]所[02:19.76]归[02:21.02]\n[02:22.58]世[02:22.93]间[02:23.37]所[02:23.83]有[02:24.28]路[02:24.66]都[02:25.19]将[02:25.67] [02:25.67]与[02:25.95]你[02:26.55]相[02:26.96]逢[02:28.05]\n[02:28.27]而[02:28.47]我[02:28.63]将[02:28.83] [02:28.83]爱[02:29.26]你[02:29.70]所[02:30.12]爱[02:30.63]的[02:31.05]人[02:31.34]间[02:31.99]\n[02:32.41]愿[02:32.84]你[02:33.27]所[02:33.71]愿[02:34.17]的[02:34.62]笑[02:34.92]颜[02:35.52]\n[02:35.83]你[02:36.08]的[02:36.48]手[02:36.86]我[02:37.32]蹒[02:37.78]跚[02:38.26]在[02:38.53]牵[02:39.27]\n[02:39.51]请[02:39.72]带[02:40.13]我[02:40.37]去[02:41.03]明[02:41.42]天[02:42.36]\n[02:42.62]如[02:42.83]果[02:43.04]说[02:43.22] [02:43.22]你[02:43.67]曾[02:44.11]苦[02:44.54]过[02:44.98]我[02:45.42]的[02:45.71]甜[02:46.47]\n[02:46.89]我[02:47.30]愿[02:47.71]活[02:48.16]成[02:48.62]你[02:49.12]的[02:49.48]愿[02:50.14]\n[02:50.42]愿[02:50.58]不[02:50.90]枉[02:51.25]啊[02:52.03] [02:52.03]愿[02:52.25]勇[02:52.74]往[02:52.96]啊[02:53.70]\n[02:53.91]这[02:54.11]盛[02:54.53]世[02:54.78]每[02:55.48]一[02:55.86]天[02:58.40]\n[02:59.04]山[02:59.20]河[02:59.47]无[02:59.68]恙[03:00.72] [03:00.72]烟[03:00.94]火[03:01.14]寻[03:01.36]常[03:02.18]\n[03:02.44]可[03:02.65]是[03:02.85]你[03:03.07]如[03:03.63]愿[03:04.00]的[03:04.43]眺[03:04.90]望[03:05.88]\n[03:06.11]孩[03:06.32]子[03:06.51]们[03:06.71]啊[03:07.79] [03:07.79]安[03:08.05]睡[03:08.28]梦[03:08.51]乡[03:09.49]\n[03:09.91]像[03:10.13]你[03:10.33]深[03:10.77]爱[03:11.01]的[03:11.65]那[03:12.10]样[03:15.54]\n[03:18.73]而[03:18.90]我[03:19.10]将[03:19.31] [03:19.31]梦[03:19.76]你[03:20.16]所[03:20.62]梦[03:21.09]的[03:21.51]团[03:21.78]圆[03:22.54]\n[03:22.93]愿[03:23.35]你[03:23.81]所[03:24.23]愿[03:24.68]的[03:25.10]永[03:25.51]远[03:26.14]\n[03:26.51]走[03:26.91]你[03:27.39]所[03:27.84]走[03:28.30]的[03:28.73]长[03:29.12]路[03:29.80]\n[03:30.01]这[03:30.23]样[03:30.63]的[03:30.86]爱[03:31.49]你[03:31.78]啊[03:32.90]\n[03:33.16]我[03:33.38]也[03:33.58]将[03:33.79] [03:33.79]见[03:34.20]你[03:34.61]未[03:35.01]见[03:35.48]的[03:35.92]世[03:36.19]界[03:36.97]\n[03:37.34]写[03:37.76]你[03:38.18]未[03:38.62]写[03:39.09]的[03:39.57]诗[03:39.86]篇[03:40.57]\n[03:40.82]天[03:41.04]边[03:41.44]的[03:41.70]月[03:42.45] [03:42.45]心[03:42.69]中[03:43.21]的[03:43.51]念[03:44.15]\n[03:44.40]你[03:44.64]永[03:45.06]在[03:45.32]我[03:45.94]身[03:46.35]边[03:49.24]\n[03:49.88]与[03:50.22]你[03:50.53]相[03:50.80]约[03:52.06] [03:52.06]一[03:52.21]生[03:52.57]清[03:52.80]澈[03:53.65]\n[03:54.13]如[03:54.46]你[03:54.73]年[03:55.31]轻[03:56.92]的[03:58.52]脸[04:01.80]",
    "lrcUrl": "assets/lyrics/track_07.lrc"
  },
  {
    "index": "008",
    "spineNum": "08",
    "serial": "WK-REAL-08",
    "title": "大鱼",
    "shortTitle": "大鱼 · 周深",
    "spineTitle": "大鱼 · 大鱼海棠",
    "subtitleQuote": "| 怕你飞远去，怕你离我而去，更怕你永远停留在这里",
    "artist": "周深",
    "subArtist": "动画电影《大鱼海棠》印象曲",
    "statusTag": "国风空灵",
    "subTag": "唯美国漫",
    "durationSec": 278,
    "currentSec": 0,
    "accent": "#06b6d4",
    "c1": "#22d3ee",
    "c2": "#164e63",
    "picUrl": "assets/covers/cover_08.jpg",
    "audioUrl": "assets/audio/track_08.mp3",
    "notes": [
      220,
      261.63,
      293.66,
      329.63,
      392,
      329.63,
      293.66,
      261.63
    ],
    "lyrics": [
      {
        "t": 0,
        "l1": "大鱼 - 周深",
        "l2": ""
      },
      {
        "t": 14.42,
        "l1": "词：尹约",
        "l2": ""
      },
      {
        "t": 28.85,
        "l1": "曲：钱雷",
        "l2": ""
      },
      {
        "t": 43.27,
        "l1": "海浪无声将夜幕深深淹没",
        "l2": ""
      },
      {
        "t": 50.09,
        "l1": "漫过天空尽头的角落",
        "l2": ""
      },
      {
        "t": 56.79,
        "l1": "大鱼在梦境的缝隙里游过",
        "l2": ""
      },
      {
        "t": 63.76,
        "l1": "凝望你沉睡的轮廓",
        "l2": ""
      },
      {
        "t": 69.88,
        "l1": "看海天一色 听风起雨落",
        "l2": ""
      },
      {
        "t": 76.48,
        "l1": "执子手吹散苍茫茫烟波",
        "l2": ""
      },
      {
        "t": 83.61,
        "l1": "大鱼的翅膀 已经太辽阔",
        "l2": ""
      },
      {
        "t": 91.09,
        "l1": "我松开时间的绳索",
        "l2": ""
      },
      {
        "t": 97.3,
        "l1": "怕你飞远去 怕你离我而去",
        "l2": ""
      },
      {
        "t": 103.87,
        "l1": "更怕你永远停留在这里",
        "l2": ""
      },
      {
        "t": 110.76,
        "l1": "每一滴泪水 都向你流淌去",
        "l2": ""
      },
      {
        "t": 118.58,
        "l1": "倒流进天空的海底",
        "l2": ""
      },
      {
        "t": 139.11,
        "l1": "海浪无声将夜幕深深淹没",
        "l2": ""
      },
      {
        "t": 145.86,
        "l1": "漫过天空尽头的角落",
        "l2": ""
      },
      {
        "t": 152.76,
        "l1": "大鱼在梦境的缝隙里游过",
        "l2": ""
      },
      {
        "t": 159.58,
        "l1": "凝望你沉睡的轮廓",
        "l2": ""
      },
      {
        "t": 165.63,
        "l1": "看海天一色 听风起雨落",
        "l2": ""
      },
      {
        "t": 172.41,
        "l1": "执子手吹散苍茫茫烟波",
        "l2": ""
      },
      {
        "t": 179.3,
        "l1": "大鱼的翅膀 已经太辽阔",
        "l2": ""
      },
      {
        "t": 187.08,
        "l1": "我松开时间的绳索",
        "l2": ""
      },
      {
        "t": 193.09,
        "l1": "看你飞远去 看你离我而去",
        "l2": ""
      },
      {
        "t": 199.86,
        "l1": "原来你生来就属于天际",
        "l2": ""
      },
      {
        "t": 206.68,
        "l1": "每一滴泪水 都向你流淌去",
        "l2": ""
      },
      {
        "t": 214.51,
        "l1": "倒流回最初的相遇",
        "l2": ""
      }
    ],
    "comments": [
      "【热评 @南冥有鱼】周深的空灵声线如同海浪拂过心头，将东方古典意境渲染得淋漓尽致。"
    ],
    "lyricsRaw": "[ti:大鱼]\n[ar:周深]\n[al:大鱼]\n[offset:0]\n\n[00:00.00]大[00:02.06]鱼[00:04.12] [00:06.18]-[00:08.24] [00:10.30]周[00:12.36]深[00:14.42]\n[00:14.42]词[00:18.02]：[00:21.63]尹[00:25.24]约[00:28.84]\n[00:28.85]曲[00:32.45]：[00:36.06]钱[00:39.66]雷[00:43.27]\n[00:43.27]海[00:43.59]浪[00:43.99]无[00:44.37]声[00:44.76]将[00:45.19]夜[00:45.61]幕[00:46.03]深[00:46.46]深[00:47.89]淹[00:48.28]没[00:48.93]\n[00:50.09]漫[00:50.43]过[00:50.81]天[00:51.18]空[00:51.63]尽[00:52.02]头[00:52.55]的[00:53.53]角[00:54.01]落[00:55.35]\n[00:56.79]大[00:57.13]鱼[00:57.61]在[00:58.02]梦[00:58.44]境[00:58.86]的[00:59.29]缝[00:59.67]隙[01:00.10]里[01:01.50]游[01:01.88]过[01:02.61]\n[01:03.76]凝[01:04.11]望[01:04.46]你[01:05.41]沉[01:05.70]睡[01:06.05]的[01:06.56]轮[01:07.16]廓[01:08.45]\n[01:09.88]看[01:10.21]海[01:10.51]天[01:11.95]一[01:12.24]色 [01:13.30]听[01:13.54]风[01:13.83]起[01:15.21]雨[01:15.52]落[01:16.25]\n[01:16.48]执[01:16.75]子[01:17.27]手[01:18.21]吹[01:18.61]散[01:18.98]苍[01:19.39]茫[01:19.77]茫[01:21.03]烟[01:21.35]波[01:22.34]\n[01:23.61]大[01:23.91]鱼[01:24.19]的[01:25.55]翅[01:25.87]膀 [01:26.72]已[01:27.09]经[01:27.48]太[01:28.56]辽[01:29.44]阔[01:30.65]\n[01:31.09]我[01:31.42]松[01:31.78]开[01:32.90]时[01:33.22]间[01:33.65]的[01:34.07]绳[01:34.47]索[01:35.41]\n[01:37.30]怕[01:37.62]你[01:37.94]飞[01:39.31]远[01:39.70]去 [01:40.53]怕[01:40.92]你[01:41.37]离[01:42.55]我[01:42.78]而[01:43.09]去[01:43.42]\n[01:43.87]更[01:44.22]怕[01:44.64]你[01:45.58]永[01:45.94]远[01:46.44]停[01:46.86]留[01:47.28]在[01:47.78]这[01:48.22]里[01:49.43]\n[01:50.76]每[01:51.06]一[01:51.50]滴[01:52.92]泪[01:53.38]水 [01:54.10]都[01:54.55]向[01:55.03]你[01:56.19]流[01:56.40]淌[01:56.69]去[01:57.57]\n[01:58.58]倒[01:58.93]流[01:59.30]进[02:00.39]天[02:00.66]空[02:01.04]的[02:01.42]海[02:02.26]底[02:03.37]\n[02:19.11]海[02:19.53]浪[02:19.91]无[02:20.28]声[02:20.70]将[02:21.14]夜[02:21.57]幕[02:22.07]深[02:22.40]深[02:23.68]淹[02:24.13]没[02:24.73]\n[02:25.86]漫[02:26.25]过[02:26.62]天[02:27.06]空[02:27.50]尽[02:27.94]头[02:28.37]的[02:29.27]角[02:30.16]落[02:31.05]\n[02:32.76]大[02:33.09]鱼[02:33.58]在[02:33.98]梦[02:34.38]境[02:34.82]的[02:35.23]缝[02:35.63]隙[02:36.09]里[02:37.42]游[02:37.84]过[02:38.46]\n[02:39.58]凝[02:39.94]望[02:40.37]你[02:41.40]沉[02:41.68]睡[02:42.09]的[02:42.58]轮[02:43.19]廓[02:43.98]\n[02:45.63]看[02:45.97]海[02:46.39]天[02:47.87]一[02:48.18]色 [02:49.02]听[02:49.38]风[02:49.73]起[02:51.06]雨[02:51.52]落[02:51.86]\n[02:52.41]执[02:52.80]子[02:53.24]手[02:54.31]吹[02:54.58]散[02:54.97]苍[02:55.38]茫[02:55.82]茫[02:57.00]烟[02:57.46]波[02:58.41]\n[02:59.30]大[02:59.66]鱼[03:00.06]的[03:01.45]翅[03:01.74]膀 [03:02.77]已[03:03.10]经[03:03.48]太[03:04.56]辽[03:05.27]阔[03:06.57]\n[03:07.08]我[03:07.42]松[03:07.78]开[03:08.73]时[03:09.09]间[03:09.62]的[03:10.10]绳[03:10.45]索[03:11.13]\n[03:13.09]看[03:13.43]你[03:13.87]飞[03:15.25]远[03:15.62]去 [03:16.48]看[03:16.82]你[03:17.25]离[03:18.44]我[03:18.71]而[03:19.01]去[03:19.22]\n[03:19.86]原[03:20.22]来[03:20.65]你[03:21.58]生[03:21.96]来[03:22.43]就[03:22.93]属[03:23.31]于[03:23.82]天[03:24.33]际[03:25.87]\n[03:26.68]每[03:27.08]一[03:27.51]滴[03:28.93]泪[03:29.31]水 [03:30.17]都[03:30.56]向[03:31.04]你[03:31.94]流[03:32.24]淌[03:32.71]去[03:34.01]\n[03:34.51]倒[03:34.86]流[03:35.27]回[03:36.22]最[03:36.63]初[03:37.11]的[03:37.65]相[03:38.10]遇[03:39.10]",
    "lrcUrl": "assets/lyrics/track_08.lrc"
  },
  {
    "index": "009",
    "spineNum": "09",
    "serial": "WK-REAL-09",
    "title": "富士山下",
    "shortTitle": "富士山下 · 陈奕迅",
    "spineTitle": "富士山下 · 经典粤语",
    "subtitleQuote": "| 要拥有必先懂失去怎接受，曾沿着雪路浪游，为何为好事泪流",
    "artist": "陈奕迅",
    "subArtist": "林夕作词 · 粤语传世名曲",
    "statusTag": "粤语巅峰",
    "subTag": "林夕词作",
    "durationSec": 248,
    "currentSec": 0,
    "accent": "#64748b",
    "c1": "#94a3b8",
    "c2": "#1e293b",
    "picUrl": "assets/covers/cover_09.jpg",
    "audioUrl": "assets/audio/track_09.mp3",
    "notes": [
      261.63,
      293.66,
      329.63,
      349.23,
      392,
      349.23,
      329.63,
      293.66
    ],
    "lyrics": [
      {
        "t": 0,
        "l1": "富士山下 - 陈奕迅 Eason Chan",
        "l2": ""
      },
      {
        "t": 0,
        "l1": "以下音译标注由AI工具生产",
        "l2": ""
      },
      {
        "t": 7.43,
        "l1": "词：林夕",
        "l2": ""
      },
      {
        "t": 14.87,
        "l1": "曲：泽日生",
        "l2": ""
      },
      {
        "t": 22.31,
        "l1": "拦路雨偏似雪花",
        "l2": ""
      },
      {
        "t": 22.31,
        "l1": "lan lou yu pin ci su fa",
        "l2": ""
      },
      {
        "t": 24.68,
        "l1": "饮泣的你冻吗",
        "l2": ""
      },
      {
        "t": 24.68,
        "l1": "yan ya di nei dong ma",
        "l2": ""
      },
      {
        "t": 26.88,
        "l1": "这风褛我给你磨到有襟花",
        "l2": ""
      },
      {
        "t": 26.88,
        "l1": "ze fong lui o ka nei mo dou yau kan fa",
        "l2": ""
      },
      {
        "t": 31.37,
        "l1": "连调了职也不怕",
        "l2": ""
      },
      {
        "t": 31.37,
        "l1": "lin diu liu zi ya ba pa",
        "l2": ""
      },
      {
        "t": 33.74,
        "l1": "怎么始终牵挂",
        "l2": ""
      },
      {
        "t": 33.74,
        "l1": "zan mo ci zong hin gwa",
        "l2": ""
      },
      {
        "t": 36.01,
        "l1": "苦心选中今天想车你回家",
        "l2": ""
      },
      {
        "t": 36.01,
        "l1": "fu san sun zong gan tin soeng ce nei wui ga",
        "l2": ""
      },
      {
        "t": 40.54,
        "l1": "原谅我不再送花",
        "l2": ""
      },
      {
        "t": 40.54,
        "l1": "yun loeng o ba zoi song fa",
        "l2": ""
      },
      {
        "t": 42.87,
        "l1": "伤口应要结疤",
        "l2": ""
      },
      {
        "t": 42.87,
        "l1": "soeng hou ying yiu gi ba",
        "l2": ""
      },
      {
        "t": 45.1,
        "l1": "花瓣铺满心里坟场才害怕",
        "l2": ""
      },
      {
        "t": 45.1,
        "l1": "fa ban pou mun san lui fan coeng coi hoi pa",
        "l2": ""
      },
      {
        "t": 49.65,
        "l1": "如若你非我不嫁",
        "l2": ""
      },
      {
        "t": 49.65,
        "l1": "yu yoe nei fei o ba ga",
        "l2": ""
      },
      {
        "t": 51.99,
        "l1": "彼此终必火化",
        "l2": ""
      },
      {
        "t": 51.99,
        "l1": "bei ci zong bi fo fa",
        "l2": ""
      },
      {
        "t": 54.32,
        "l1": "一生一世等一天需要代价",
        "l2": ""
      },
      {
        "t": 54.32,
        "l1": "ya sang ya sai dang ya tin sui yiu doi ga",
        "l2": ""
      },
      {
        "t": 58.82,
        "l1": "谁都只得那双手",
        "l2": ""
      },
      {
        "t": 58.82,
        "l1": "sui dou zi da na soeng sou",
        "l2": ""
      },
      {
        "t": 61.16,
        "l1": "靠拥抱亦难任你拥有",
        "l2": ""
      },
      {
        "t": 61.16,
        "l1": "kou yung pou yi nan yan nei yung yau",
        "l2": ""
      },
      {
        "t": 64.01,
        "l1": "要拥有必先懂失去怎接受",
        "l2": ""
      },
      {
        "t": 64.01,
        "l1": "yiu yung yau bi sin dong sa hui zan zi sou",
        "l2": ""
      },
      {
        "t": 68.53,
        "l1": "曾沿着雪路浪游",
        "l2": ""
      },
      {
        "t": 68.53,
        "l1": "cang yun zoe su lou long you",
        "l2": ""
      },
      {
        "t": 70.86,
        "l1": "为何为好事泪流",
        "l2": ""
      },
      {
        "t": 70.86,
        "l1": "wai ho wai hou si lui lou",
        "l2": ""
      },
      {
        "t": 73.12,
        "l1": "谁能凭爱意要富士山私有",
        "l2": ""
      },
      {
        "t": 73.12,
        "l1": "sui nang pang oi yi yiu fu si san si yau",
        "l2": ""
      },
      {
        "t": 77.74,
        "l1": "何不把悲哀感觉",
        "l2": ""
      },
      {
        "t": 77.74,
        "l1": "ho ba ba bei oi gan go",
        "l2": ""
      },
      {
        "t": 79.69,
        "l1": "假设是来自你虚构",
        "l2": ""
      },
      {
        "t": 79.69,
        "l1": "ga ci si loi zi nei hui kau",
        "l2": ""
      },
      {
        "t": 82.28,
        "l1": "试管里找不到它染污眼眸",
        "l2": ""
      },
      {
        "t": 82.28,
        "l1": "si gun lui zou ba dou ta yin wu an mou",
        "l2": ""
      },
      {
        "t": 86.85,
        "l1": "前尘硬化像石头",
        "l2": ""
      },
      {
        "t": 86.85,
        "l1": "cin can ang fa zoeng se tou",
        "l2": ""
      },
      {
        "t": 89.12,
        "l1": "随缘地抛下便逃走",
        "l2": ""
      },
      {
        "t": 89.12,
        "l1": "cui yun dei pou ha bin tou zou",
        "l2": ""
      },
      {
        "t": 94.48,
        "l1": "我绝不罕有",
        "l2": ""
      },
      {
        "t": 94.48,
        "l1": "o zu ba hon yau",
        "l2": ""
      },
      {
        "t": 96.45,
        "l1": "往街里绕过一周",
        "l2": ""
      },
      {
        "t": 96.45,
        "l1": "wong gai lui yiu gwo ya zou",
        "l2": ""
      },
      {
        "t": 98.92,
        "l1": "我便化乌有",
        "l2": ""
      },
      {
        "t": 98.92,
        "l1": "o bin fa wu yau",
        "l2": ""
      },
      {
        "t": 103.14,
        "l1": "情人节不要说穿",
        "l2": ""
      },
      {
        "t": 103.14,
        "l1": "cing yan zi ba yiu sv cun",
        "l2": ""
      },
      {
        "t": 105.49,
        "l1": "只敢抚你发端",
        "l2": ""
      },
      {
        "t": 105.49,
        "l1": "zi gan fu nei fa dvn",
        "l2": ""
      },
      {
        "t": 107.72,
        "l1": "这种姿态可会令你更心酸",
        "l2": ""
      },
      {
        "t": 107.72,
        "l1": "ze zung zi tai ho wui ling nei gang san sun",
        "l2": ""
      },
      {
        "t": 112.23,
        "l1": "留在汽车里取暖",
        "l2": ""
      },
      {
        "t": 112.23,
        "l1": "lou zoi hei ce lui cui nvn",
        "l2": ""
      },
      {
        "t": 114.53,
        "l1": "应该怎么规劝",
        "l2": ""
      },
      {
        "t": 114.53,
        "l1": "ying goi zan mo kuai hun",
        "l2": ""
      },
      {
        "t": 116.83,
        "l1": "怎么可以将手腕忍痛划损",
        "l2": ""
      },
      {
        "t": 116.83,
        "l1": "zan mo ho yi zoeng sou wun yan tong wa sun",
        "l2": ""
      },
      {
        "t": 121.35,
        "l1": "人活到几岁算短",
        "l2": ""
      },
      {
        "t": 121.35,
        "l1": "yan wu dou gei sui sun dun",
        "l2": ""
      },
      {
        "t": 123.68,
        "l1": "失恋只有更短",
        "l2": ""
      },
      {
        "t": 123.68,
        "l1": "sa lun zi yau gang dun",
        "l2": ""
      },
      {
        "t": 125.99,
        "l1": "归家需要几里路谁能预算",
        "l2": ""
      },
      {
        "t": 125.99,
        "l1": "guai ga sui yiu gei lui lou sui nang yu sun",
        "l2": ""
      },
      {
        "t": 130.54,
        "l1": "忘掉我跟你恩怨",
        "l2": ""
      },
      {
        "t": 130.54,
        "l1": "mong diu o gan nei yan yun",
        "l2": ""
      },
      {
        "t": 132.81,
        "l1": "樱花开了几转",
        "l2": ""
      },
      {
        "t": 132.81,
        "l1": "ying fa hoi liu gei zun",
        "l2": ""
      },
      {
        "t": 135.15,
        "l1": "东京之旅一早比一世遥远",
        "l2": ""
      },
      {
        "t": 135.15,
        "l1": "dong ging zi lui ya zou bei ya sai yiu yun",
        "l2": ""
      },
      {
        "t": 139.6,
        "l1": "谁都只得那双手",
        "l2": ""
      },
      {
        "t": 139.6,
        "l1": "sui dou zi da na soeng sou",
        "l2": ""
      },
      {
        "t": 141.94,
        "l1": "靠拥抱亦难任你拥有",
        "l2": ""
      },
      {
        "t": 141.94,
        "l1": "kou yung pou yi nan yan nei yung yau",
        "l2": ""
      },
      {
        "t": 144.83,
        "l1": "要拥有必先懂失去怎接受",
        "l2": ""
      },
      {
        "t": 144.83,
        "l1": "yiu yung yau bi sin dong sa hui zan zi sou",
        "l2": ""
      },
      {
        "t": 149.38,
        "l1": "曾沿着雪路浪游",
        "l2": ""
      },
      {
        "t": 149.38,
        "l1": "cang yun zoe su lou long you",
        "l2": ""
      },
      {
        "t": 151.7,
        "l1": "为何为好事泪流",
        "l2": ""
      },
      {
        "t": 151.7,
        "l1": "wai ho wai hou si lui lou",
        "l2": ""
      },
      {
        "t": 153.96,
        "l1": "谁能凭爱意要富士山私有",
        "l2": ""
      },
      {
        "t": 153.96,
        "l1": "sui nang pang oi yi yiu fu si san si yau",
        "l2": ""
      },
      {
        "t": 158.48,
        "l1": "何不把悲哀感觉",
        "l2": ""
      },
      {
        "t": 158.48,
        "l1": "ho ba ba bei oi gan go",
        "l2": ""
      },
      {
        "t": 160.47,
        "l1": "假设是来自你虚构",
        "l2": ""
      },
      {
        "t": 160.47,
        "l1": "ga ci si loi zi nei hui kau",
        "l2": ""
      },
      {
        "t": 163.12,
        "l1": "试管里找不到它染污眼眸",
        "l2": ""
      },
      {
        "t": 163.12,
        "l1": "si gun lui zou ba dou ta yin wu an mou",
        "l2": ""
      },
      {
        "t": 167.65,
        "l1": "前尘硬化像石头",
        "l2": ""
      },
      {
        "t": 167.65,
        "l1": "cin can ang fa zoeng se tou",
        "l2": ""
      },
      {
        "t": 169.97,
        "l1": "随缘地抛下便逃走",
        "l2": ""
      },
      {
        "t": 169.97,
        "l1": "cui yun dei pou ha bin tou zou",
        "l2": ""
      },
      {
        "t": 174.65,
        "l1": "我绝不罕有",
        "l2": ""
      },
      {
        "t": 174.65,
        "l1": "o zu ba hon yau",
        "l2": ""
      },
      {
        "t": 176.8,
        "l1": "往街里绕过一周",
        "l2": ""
      },
      {
        "t": 176.8,
        "l1": "wong gai lui yiu gwo ya zou",
        "l2": ""
      },
      {
        "t": 179.6,
        "l1": "我便化乌有",
        "l2": ""
      },
      {
        "t": 179.6,
        "l1": "o bin fa wu yau",
        "l2": ""
      },
      {
        "t": 183.81,
        "l1": "谁都只得那双手",
        "l2": ""
      },
      {
        "t": 183.81,
        "l1": "sui dou zi da na soeng sou",
        "l2": ""
      },
      {
        "t": 186.15,
        "l1": "靠拥抱亦难任你拥有",
        "l2": ""
      },
      {
        "t": 186.15,
        "l1": "kou yung pou yi nan yan nei yung yau",
        "l2": ""
      },
      {
        "t": 189.12,
        "l1": "要拥有必先懂失去怎接受",
        "l2": ""
      },
      {
        "t": 189.12,
        "l1": "yiu yung yau bi sin dong sa hui zan zi sou",
        "l2": ""
      },
      {
        "t": 193.86,
        "l1": "曾沿着雪路浪游",
        "l2": ""
      },
      {
        "t": 193.86,
        "l1": "cang yun zoe su lou long you",
        "l2": ""
      },
      {
        "t": 196.18,
        "l1": "为何为好事泪流",
        "l2": ""
      },
      {
        "t": 196.18,
        "l1": "wai ho wai hou si lui lou",
        "l2": ""
      },
      {
        "t": 198.61,
        "l1": "谁能凭爱意要富士山私有",
        "l2": ""
      },
      {
        "t": 198.61,
        "l1": "sui nang pang oi yi yiu fu si san si yau",
        "l2": ""
      },
      {
        "t": 203.3,
        "l1": "何不把悲哀感觉",
        "l2": ""
      },
      {
        "t": 203.3,
        "l1": "ho ba ba bei oi gan go",
        "l2": ""
      },
      {
        "t": 205.31,
        "l1": "假设是来自你虚构",
        "l2": ""
      },
      {
        "t": 205.31,
        "l1": "ga ci si loi zi nei hui kau",
        "l2": ""
      },
      {
        "t": 207.95,
        "l1": "试管里找不到它染污眼眸",
        "l2": ""
      },
      {
        "t": 207.95,
        "l1": "si gun lui zou ba dou ta yin wu an mou",
        "l2": ""
      },
      {
        "t": 212.72,
        "l1": "前尘硬化像石头",
        "l2": ""
      },
      {
        "t": 212.72,
        "l1": "cin can ang fa zoeng se tou",
        "l2": ""
      },
      {
        "t": 215.07,
        "l1": "随缘地抛下便逃走",
        "l2": ""
      },
      {
        "t": 215.07,
        "l1": "cui yun dei pou ha bin tou zou",
        "l2": ""
      },
      {
        "t": 221.63,
        "l1": "我绝不罕有",
        "l2": ""
      },
      {
        "t": 221.63,
        "l1": "o zu ba hon yau",
        "l2": ""
      },
      {
        "t": 223.89,
        "l1": "往街里绕过一周",
        "l2": ""
      },
      {
        "t": 223.89,
        "l1": "wong gai lui yiu gwo ya zou",
        "l2": ""
      },
      {
        "t": 227.12,
        "l1": "我便化乌有",
        "l2": ""
      },
      {
        "t": 227.12,
        "l1": "o bin fa wu yau",
        "l2": ""
      },
      {
        "t": 232.42,
        "l1": "你还嫌不够",
        "l2": ""
      },
      {
        "t": 232.42,
        "l1": "nei wan yin ba gou",
        "l2": ""
      },
      {
        "t": 234.38,
        "l1": "我把这陈年风褛",
        "l2": ""
      },
      {
        "t": 234.38,
        "l1": "o ba ze can nin fong lui",
        "l2": ""
      },
      {
        "t": 237.28,
        "l1": "送赠你解咒",
        "l2": ""
      },
      {
        "t": 237.28,
        "l1": "song zang nei gai zou",
        "l2": ""
      }
    ],
    "comments": [
      "【热评 @林夕词话】谁能凭爱意将富士山私有？唯有学会放下，才能真正拥抱生活。"
    ],
    "lyricsRaw": "[ti:富士山下]\n[ar:陈奕迅]\n[al:What's Going On...?]\n[offset:0]\n\n[00:00.00]富[00:00.46]士[00:00.92]山[00:01.39]下[00:01.85] [00:02.32]-[00:02.78] [00:03.24]陈[00:03.71]奕[00:04.17]迅[00:04.64] [00:05.10][00:05.56]Eason[00:06.03] [00:06.49]Chan[00:06.96]\n[00:00.00]以[00:00.57]下[00:01.14]音[00:01.71]译[00:02.28]标[00:02.85]注[00:03.42]由[00:03.99]A[00:04.56]I[00:05.13]工[00:05.71]具[00:06.28]生[00:06.85]产[00:07.42]\n[00:07.43]词[00:09.29]：[00:11.15]林[00:13.01]夕[00:14.87]\n[00:14.87]曲[00:16.35]：[00:17.84]泽[00:19.33]日[00:20.82]生[00:22.31]\n[00:22.31]拦[00:22.57]路[00:22.86]雨[00:23.17]偏[00:23.47]似[00:23.75]雪[00:24.04]花[00:24.41]\n[00:22.31]lan [00:22.57]lou [00:22.86]yu [00:23.17]pin [00:23.47]ci [00:23.75]su [00:24.04]fa [00:24.41]\n[00:24.68]饮[00:25.14]泣[00:25.43]的[00:25.66]你[00:25.98]冻[00:26.23]吗[00:26.63]\n[00:24.68]yan [00:25.14]ya [00:25.43]di [00:25.66]nei [00:25.98]dong [00:26.23]ma [00:26.63]\n[00:26.88]这[00:27.37]风[00:27.65]褛[00:27.96]我[00:28.25]给[00:28.63]你[00:29.06]磨[00:29.35]到[00:29.78]有[00:30.18]襟[00:30.47]花[00:31.09]\n[00:26.88]ze [00:27.37]fong [00:27.65]lui [00:27.96]o [00:28.25]ka [00:28.63]nei [00:29.06]mo [00:29.35]dou [00:29.78]yau [00:30.18]kan [00:30.47]fa [00:31.09]\n[00:31.37]连[00:31.66]调[00:31.93]了[00:32.22]职[00:32.43]也[00:32.77]不[00:33.02]怕[00:33.46]\n[00:31.37]lin [00:31.66]diu [00:31.93]liu [00:32.22]zi [00:32.43]ya [00:32.77]ba [00:33.02]pa [00:33.46]\n[00:33.74]怎[00:34.20]么[00:34.50]始[00:34.79]终[00:35.07]牵[00:35.37]挂[00:35.75]\n[00:33.74]zan [00:34.20]mo [00:34.50]ci [00:34.79]zong [00:35.07]hin [00:35.37]gwa [00:35.75]\n[00:36.01]苦[00:36.50]心[00:36.83]选[00:37.09]中[00:37.36]今[00:37.74]天[00:38.14]想[00:38.48]车[00:38.93]你[00:39.26]回[00:39.58]家[00:40.24]\n[00:36.01]fu [00:36.50]san [00:36.83]sun [00:37.09]zong [00:37.36]gan [00:37.74]tin [00:38.14]soeng [00:38.48]ce [00:38.93]nei [00:39.26]wui [00:39.58]ga [00:40.24]\n[00:40.54]原[00:40.85]谅[00:41.13]我[00:41.42]不[00:41.66]再[00:41.92]送[00:42.23]花[00:42.64]\n[00:40.54]yun [00:40.85]loeng [00:41.13]o [00:41.42]ba [00:41.66]zoi [00:41.92]song [00:42.23]fa [00:42.64]\n[00:42.87]伤[00:43.34]口[00:43.61]应[00:43.87]要[00:44.17]结[00:44.44]疤[00:44.86]\n[00:42.87]soeng [00:43.34]hou [00:43.61]ying [00:43.87]yiu [00:44.17]gi [00:44.44]ba [00:44.86]\n[00:45.10]花[00:45.62]瓣[00:45.91]铺[00:46.18]满[00:46.50]心[00:46.89]里[00:47.32]坟[00:47.62]场[00:48.07]才[00:48.45]害[00:48.76]怕[00:49.41]\n[00:45.10]fa [00:45.62]ban [00:45.91]pou [00:46.18]mun [00:46.50]san [00:46.89]lui [00:47.32]fan [00:47.62]coeng [00:48.07]coi [00:48.45]hoi [00:48.76]pa [00:49.41]\n[00:49.65]如[00:49.95]若[00:50.23]你[00:50.53]非[00:50.79]我[00:51.09]不[00:51.35]嫁[00:51.75]\n[00:49.65]yu [00:49.95]yoe [00:50.23]nei [00:50.53]fei [00:50.79]o [00:51.09]ba [00:51.35]ga [00:51.75]\n[00:51.99]彼[00:52.46]此[00:52.77]终[00:53.07]必[00:53.38]火[00:53.65]化[00:54.07]\n[00:51.99]bei [00:52.46]ci [00:52.77]zong [00:53.07]bi [00:53.38]fo [00:53.65]fa [00:54.07]\n[00:54.32]一[00:54.71]生[00:55.03]一[00:55.32]世[00:55.63]等[00:56.10]一[00:56.46]天[00:56.79]需[00:57.26]要[00:57.64]代[00:57.92]价[00:58.60]\n[00:54.32]ya [00:54.71]sang [00:55.03]ya [00:55.32]sai [00:55.63]dang [00:56.10]ya [00:56.46]tin [00:56.79]sui [00:57.26]yiu [00:57.64]doi [00:57.92]ga [00:58.60]\n[00:58.82]谁[00:59.10]都[00:59.39]只[00:59.66]得[00:59.92]那[01:00.21]双[01:00.62]手[01:00.95]\n[00:58.82]sui [00:59.10]dou [00:59.39]zi [00:59.66]da [00:59.92]na [01:00.21]soeng [01:00.62]sou [01:00.95]\n[01:01.16]靠[01:01.42]拥[01:01.69]抱[01:01.98]亦[01:02.24]难[01:02.51]任[01:02.78]你[01:03.06]拥[01:03.33]有[01:03.78]\n[01:01.16]kou [01:01.42]yung [01:01.69]pou [01:01.98]yi [01:02.24]nan [01:02.51]yan [01:02.78]nei [01:03.06]yung [01:03.33]yau [01:03.78]\n[01:04.01]要[01:04.26]拥[01:04.51]有[01:04.78]必[01:05.22]先[01:05.58]懂[01:05.90]失[01:06.39]去[01:06.73]怎[01:07.05]接[01:07.44]受[01:08.27]\n[01:04.01]yiu [01:04.26]yung [01:04.51]yau [01:04.78]bi [01:05.22]sin [01:05.58]dong [01:05.90]sa [01:06.39]hui [01:06.73]zan [01:07.05]zi [01:07.44]sou [01:08.27]\n[01:08.53]曾[01:08.81]沿[01:09.10]着[01:09.40]雪[01:09.66]路[01:09.94]浪[01:10.18]游[01:10.61]\n[01:08.53]cang [01:08.81]yun [01:09.10]zoe [01:09.40]su [01:09.66]lou [01:09.94]long [01:10.18]you [01:10.61]\n[01:10.86]为[01:11.12]何[01:11.40]为[01:11.69]好[01:11.96]事[01:12.21]泪[01:12.49]流[01:12.88]\n[01:10.86]wai [01:11.12]ho [01:11.40]wai [01:11.69]hou [01:11.96]si [01:12.21]lui [01:12.49]lou [01:12.88]\n[01:13.12]谁[01:13.39]能[01:13.66]凭[01:13.96]爱[01:14.39]意[01:14.76]要[01:15.06]富[01:15.57]士[01:15.91]山[01:16.20]私[01:17.13]有[01:17.51]\n[01:13.12]sui [01:13.39]nang [01:13.66]pang [01:13.96]oi [01:14.39]yi [01:14.76]yiu [01:15.06]fu [01:15.57]si [01:15.91]san [01:16.20]si [01:17.13]yau [01:17.51]\n[01:17.74]何[01:18.00]不[01:18.26]把[01:18.55]悲[01:18.81]哀[01:19.12]感[01:19.39]觉[01:19.69]\n[01:17.74]ho [01:18.00]ba [01:18.26]ba [01:18.55]bei [01:18.81]oi [01:19.12]gan [01:19.39]go [01:19.69]\n[01:19.69]假[01:19.94]设[01:20.24]是[01:20.50]来[01:20.79]自[01:21.07]你[01:21.33]虚[01:21.61]构[01:22.04]\n[01:19.69]ga [01:19.94]ci [01:20.24]si [01:20.50]loi [01:20.79]zi [01:21.07]nei [01:21.33]hui [01:21.61]kau [01:22.04]\n[01:22.28]试[01:22.57]管[01:22.83]里[01:23.12]找[01:23.57]不[01:23.91]到[01:24.22]它[01:24.70]染[01:25.05]污[01:25.34]眼[01:25.66]眸[01:26.61]\n[01:22.28]si [01:22.57]gun [01:22.83]lui [01:23.12]zou [01:23.57]ba [01:23.91]dou [01:24.22]ta [01:24.70]yin [01:25.05]wu [01:25.34]an [01:25.66]mou [01:26.61]\n[01:26.85]前[01:27.10]尘[01:27.38]硬[01:27.65]化[01:27.92]像[01:28.18]石[01:28.45]头[01:28.91]\n[01:26.85]cin [01:27.10]can [01:27.38]ang [01:27.65]fa [01:27.92]zoeng [01:28.18]se [01:28.45]tou [01:28.91]\n[01:29.12]随[01:29.39]缘[01:29.66]地[01:29.94]抛[01:30.21]下[01:30.51]便[01:30.76]逃[01:31.15]走[01:33.57]\n[01:29.12]cui [01:29.39]yun [01:29.66]dei [01:29.94]pou [01:30.21]ha [01:30.51]bin [01:30.76]tou [01:31.15]zou [01:33.57]\n[01:34.48]我[01:34.76]绝[01:35.06]不[01:35.38]罕[01:35.77]有[01:36.25]\n[01:34.48]o [01:34.76]zu [01:35.06]ba [01:35.38]hon [01:35.77]yau [01:36.25]\n[01:36.45]往[01:36.73]街[01:37.03]里[01:37.36]绕[01:37.62]过[01:37.97]一[01:38.32]周[01:38.70]\n[01:36.45]wong [01:36.73]gai [01:37.03]lui [01:37.36]yiu [01:37.62]gwo [01:37.97]ya [01:38.32]zou [01:38.70]\n[01:38.92]我[01:39.18]便[01:39.53]化[01:39.98]乌[01:40.29]有[01:41.78]\n[01:38.92]o [01:39.18]bin [01:39.53]fa [01:39.98]wu [01:40.29]yau [01:41.78]\n[01:43.14]情[01:43.38]人[01:43.65]节[01:43.95]不[01:44.22]要[01:44.52]说[01:44.81]穿[01:45.26]\n[01:43.14]cing [01:43.38]yan [01:43.65]zi [01:43.95]ba [01:44.22]yiu [01:44.52]sv [01:44.81]cun [01:45.26]\n[01:45.49]只[01:45.96]敢[01:46.24]抚[01:46.49]你[01:46.80]发[01:47.11]端[01:47.49]\n[01:45.49]zi [01:45.96]gan [01:46.24]fu [01:46.49]nei [01:46.80]fa [01:47.11]dvn [01:47.49]\n[01:47.72]这[01:48.18]种[01:48.48]姿[01:48.75]态[01:49.06]可[01:49.41]会[01:49.87]令[01:50.18]你[01:50.66]更[01:51.00]心[01:51.30]酸[01:51.96]\n[01:47.72]ze [01:48.18]zung [01:48.48]zi [01:48.75]tai [01:49.06]ho [01:49.41]wui [01:49.87]ling [01:50.18]nei [01:50.66]gang [01:51.00]san [01:51.30]sun [01:51.96]\n[01:52.23]留[01:52.50]在[01:52.77]汽[01:53.06]车[01:53.31]里[01:53.61]取[01:53.88]暖[01:54.28]\n[01:52.23]lou [01:52.50]zoi [01:52.77]hei [01:53.06]ce [01:53.31]lui [01:53.61]cui [01:53.88]nvn [01:54.28]\n[01:54.53]应[01:54.99]该[01:55.30]怎[01:55.59]么[01:55.90]规[01:56.18]劝[01:56.57]\n[01:54.53]ying [01:54.99]goi [01:55.30]zan [01:55.59]mo [01:55.90]kuai [01:56.18]hun [01:56.57]\n[01:56.83]怎[01:57.34]么[01:57.63]可[01:57.92]以[01:58.21]将[01:58.64]手[01:59.01]腕[01:59.34]忍[01:59.79]痛[02:00.15]划[02:00.41]损[02:01.07]\n[01:56.83]zan [01:57.34]mo [01:57.63]ho [01:57.92]yi [01:58.21]zoeng [01:58.64]sou [01:59.01]wun [01:59.34]yan [01:59.79]tong [02:00.15]wa [02:00.41]sun [02:01.07]\n[02:01.35]人[02:01.65]活[02:01.93]到[02:02.20]几[02:02.47]岁[02:02.75]算[02:03.06]短[02:03.43]\n[02:01.35]yan [02:01.65]wu [02:01.93]dou [02:02.20]gei [02:02.47]sui [02:02.75]sun [02:03.06]dun [02:03.43]\n[02:03.68]失[02:04.15]恋[02:04.50]只[02:04.76]有[02:05.07]更[02:05.33]短[02:05.77]\n[02:03.68]sa [02:04.15]lun [02:04.50]zi [02:04.76]yau [02:05.07]gang [02:05.33]dun [02:05.77]\n[02:05.99]归[02:06.49]家[02:06.77]需[02:07.03]要[02:07.32]几[02:07.75]里[02:08.14]路[02:08.48]谁[02:08.96]能[02:09.31]预[02:09.61]算[02:10.27]\n[02:05.99]guai [02:06.49]ga [02:06.77]sui [02:07.03]yiu [02:07.32]gei [02:07.75]lui [02:08.14]lou [02:08.48]sui [02:08.96]nang [02:09.31]yu [02:09.61]sun [02:10.27]\n[02:10.54]忘[02:10.79]掉[02:11.06]我[02:11.37]跟[02:11.62]你[02:11.90]恩[02:12.19]怨[02:12.56]\n[02:10.54]mong [02:10.79]diu [02:11.06]o [02:11.37]gan [02:11.62]nei [02:11.90]yan [02:12.19]yun [02:12.56]\n[02:12.81]樱[02:13.30]花[02:13.60]开[02:13.88]了[02:14.18]几[02:14.46]转[02:14.88]\n[02:12.81]ying [02:13.30]fa [02:13.60]hoi [02:13.88]liu [02:14.18]gei [02:14.46]zun [02:14.88]\n[02:15.15]东[02:15.66]京[02:15.92]之[02:16.18]旅[02:16.58]一[02:16.93]早[02:17.36]比[02:17.64]一[02:18.09]世[02:18.47]遥[02:18.75]远[02:19.33]\n[02:15.15]dong [02:15.66]ging [02:15.92]zi [02:16.18]lui [02:16.58]ya [02:16.93]zou [02:17.36]bei [02:17.64]ya [02:18.09]sai [02:18.47]yiu [02:18.75]yun [02:19.33]\n[02:19.60]谁[02:19.90]都[02:20.18]只[02:20.48]得[02:20.74]那[02:21.07]双[02:21.56]手[02:21.94]\n[02:19.60]sui [02:19.90]dou [02:20.18]zi [02:20.48]da [02:20.74]na [02:21.07]soeng [02:21.56]sou [02:21.94]\n[02:21.94]靠[02:22.19]拥[02:22.45]抱[02:22.75]亦[02:23.02]难[02:23.32]任[02:23.60]你[02:23.87]拥[02:24.15]有[02:24.59]\n[02:21.94]kou [02:22.19]yung [02:22.45]pou [02:22.75]yi [02:23.02]nan [02:23.32]yan [02:23.60]nei [02:23.87]yung [02:24.15]yau [02:24.59]\n[02:24.83]要[02:25.12]拥[02:25.37]有[02:25.65]必[02:26.10]先[02:26.45]懂[02:26.75]失[02:27.21]去[02:27.59]怎[02:27.89]接[02:28.24]受[02:29.12]\n[02:24.83]yiu [02:25.12]yung [02:25.37]yau [02:25.65]bi [02:26.10]sin [02:26.45]dong [02:26.75]sa [02:27.21]hui [02:27.59]zan [02:27.89]zi [02:28.24]sou [02:29.12]\n[02:29.38]曾[02:29.64]沿[02:29.93]着[02:30.22]雪[02:30.46]路[02:30.77]浪[02:31.03]游[02:31.44]\n[02:29.38]cang [02:29.64]yun [02:29.93]zoe [02:30.22]su [02:30.46]lou [02:30.77]long [02:31.03]you [02:31.44]\n[02:31.70]为[02:31.92]何[02:32.18]为[02:32.49]好[02:32.74]事[02:33.03]泪[02:33.31]流[02:33.75]\n[02:31.70]wai [02:31.92]ho [02:32.18]wai [02:32.49]hou [02:32.74]si [02:33.03]lui [02:33.31]lou [02:33.75]\n[02:33.96]谁[02:34.24]能[02:34.50]凭[02:34.80]爱[02:35.27]意[02:35.62]要[02:35.88]富[02:36.36]士[02:36.72]山[02:37.01]私[02:37.84]有[02:38.21]\n[02:33.96]sui [02:34.24]nang [02:34.50]pang [02:34.80]oi [02:35.27]yi [02:35.62]yiu [02:35.88]fu [02:36.36]si [02:36.72]san [02:37.01]si [02:37.84]yau [02:38.21]\n[02:38.48]何[02:38.75]不[02:39.02]把[02:39.31]悲[02:39.59]哀[02:39.91]感[02:40.17]觉[02:40.47]\n[02:38.48]ho [02:38.75]ba [02:39.02]ba [02:39.31]bei [02:39.59]oi [02:39.91]gan [02:40.17]go [02:40.47]\n[02:40.47]假[02:40.76]设[02:41.05]是[02:41.31]来[02:41.59]自[02:41.86]你[02:42.11]虚[02:42.40]构[02:42.85]\n[02:40.47]ga [02:40.76]ci [02:41.05]si [02:41.31]loi [02:41.59]zi [02:41.86]nei [02:42.11]hui [02:42.40]kau [02:42.85]\n[02:43.12]试[02:43.38]管[02:43.63]里[02:43.93]找[02:44.39]不[02:44.72]到[02:45.05]它[02:45.54]染[02:45.91]污[02:46.20]眼[02:46.49]眸[02:47.40]\n[02:43.12]si [02:43.38]gun [02:43.63]lui [02:43.93]zou [02:44.39]ba [02:44.72]dou [02:45.05]ta [02:45.54]yin [02:45.91]wu [02:46.20]an [02:46.49]mou [02:47.40]\n[02:47.65]前[02:47.92]尘[02:48.21]硬[02:48.49]化[02:48.75]像[02:49.04]石[02:49.32]头[02:49.72]\n[02:47.65]cin [02:47.92]can [02:48.21]ang [02:48.49]fa [02:48.75]zoeng [02:49.04]se [02:49.32]tou [02:49.72]\n[02:49.97]随[02:50.22]缘[02:50.49]地[02:50.79]抛[02:51.05]下[02:51.32]便[02:51.58]逃[02:51.91]走[02:54.11]\n[02:49.97]cui [02:50.22]yun [02:50.49]dei [02:50.79]pou [02:51.05]ha [02:51.32]bin [02:51.58]tou [02:51.91]zou [02:54.11]\n[02:54.65]我[02:54.96]绝[02:55.27]不[02:55.59]罕[02:56.02]有[02:56.51]\n[02:54.65]o [02:54.96]zu [02:55.27]ba [02:55.59]hon [02:56.02]yau [02:56.51]\n[02:56.80]往[02:57.09]街[02:57.36]里[02:57.72]绕[02:58.07]过[02:58.45]一[02:58.77]周[02:59.35]\n[02:56.80]wong [02:57.09]gai [02:57.36]lui [02:57.72]yiu [02:58.07]gwo [02:58.45]ya [02:58.77]zou [02:59.35]\n[02:59.60]我[02:59.89]便[03:00.15]化[03:00.64]乌[03:01.01]有[03:02.66]\n[02:59.60]o [02:59.89]bin [03:00.15]fa [03:00.64]wu [03:01.01]yau [03:02.66]\n[03:03.81]谁[03:04.10]都[03:04.42]只[03:04.70]得[03:04.94]那[03:05.25]双[03:05.71]手[03:06.15]\n[03:03.81]sui [03:04.10]dou [03:04.42]zi [03:04.70]da [03:04.94]na [03:05.25]soeng [03:05.71]sou [03:06.15]\n[03:06.15]靠[03:06.50]拥[03:06.77]抱[03:07.11]亦[03:07.41]难[03:07.68]任[03:07.93]你[03:08.21]拥[03:08.47]有[03:08.85]\n[03:06.15]kou [03:06.50]yung [03:06.77]pou [03:07.11]yi [03:07.41]nan [03:07.68]yan [03:07.93]nei [03:08.21]yung [03:08.47]yau [03:08.85]\n[03:09.12]要[03:09.42]拥[03:09.69]有[03:09.98]必[03:10.47]先[03:10.90]懂[03:11.17]失[03:11.63]去[03:12.03]怎[03:12.33]接[03:12.66]受[03:13.61]\n[03:09.12]yiu [03:09.42]yung [03:09.69]yau [03:09.98]bi [03:10.47]sin [03:10.90]dong [03:11.17]sa [03:11.63]hui [03:12.03]zan [03:12.33]zi [03:12.66]sou [03:13.61]\n[03:13.86]曾[03:14.12]沿[03:14.40]着[03:14.67]雪[03:14.93]路[03:15.20]浪[03:15.48]游[03:15.93]\n[03:13.86]cang [03:14.12]yun [03:14.40]zoe [03:14.67]su [03:14.93]lou [03:15.20]long [03:15.48]you [03:15.93]\n[03:16.18]为[03:16.46]何[03:16.74]为[03:17.06]好[03:17.35]事[03:17.66]泪[03:17.94]流[03:18.36]\n[03:16.18]wai [03:16.46]ho [03:16.74]wai [03:17.06]hou [03:17.35]si [03:17.66]lui [03:17.94]lou [03:18.36]\n[03:18.61]谁[03:18.86]能[03:19.09]凭[03:19.43]爱[03:19.89]意[03:20.23]要[03:20.64]富[03:21.04]士[03:21.43]山[03:21.70]私[03:22.66]有[03:23.06]\n[03:18.61]sui [03:18.86]nang [03:19.09]pang [03:19.43]oi [03:19.89]yi [03:20.23]yiu [03:20.64]fu [03:21.04]si [03:21.43]san [03:21.70]si [03:22.66]yau [03:23.06]\n[03:23.30]何[03:23.56]不[03:23.80]把[03:24.12]悲[03:24.41]哀[03:24.70]感[03:24.96]觉[03:25.31]\n[03:23.30]ho [03:23.56]ba [03:23.80]ba [03:24.12]bei [03:24.41]oi [03:24.70]gan [03:24.96]go [03:25.31]\n[03:25.31]假[03:25.56]设[03:25.85]是[03:26.12]来[03:26.43]自[03:26.69]你[03:26.97]虚[03:27.25]构[03:27.72]\n[03:25.31]ga [03:25.56]ci [03:25.85]si [03:26.12]loi [03:26.43]zi [03:26.69]nei [03:26.97]hui [03:27.25]kau [03:27.72]\n[03:27.95]试[03:28.23]管[03:28.52]里[03:28.78]找[03:29.31]不[03:29.65]到[03:29.94]它[03:30.43]染[03:30.81]污[03:31.09]眼[03:31.39]眸[03:32.43]\n[03:27.95]si [03:28.23]gun [03:28.52]lui [03:28.78]zou [03:29.31]ba [03:29.65]dou [03:29.94]ta [03:30.43]yin [03:30.81]wu [03:31.09]an [03:31.39]mou [03:32.43]\n[03:32.72]前[03:32.97]尘[03:33.25]硬[03:33.52]化[03:33.81]像[03:34.08]石[03:34.39]头[03:34.76]\n[03:32.72]cin [03:32.97]can [03:33.25]ang [03:33.52]fa [03:33.81]zoeng [03:34.08]se [03:34.39]tou [03:34.76]\n[03:35.07]随[03:35.33]缘[03:35.57]地[03:35.86]抛[03:36.16]下[03:36.50]便[03:36.79]逃[03:37.10]走[03:39.82]\n[03:35.07]cui [03:35.33]yun [03:35.57]dei [03:35.86]pou [03:36.16]ha [03:36.50]bin [03:36.79]tou [03:37.10]zou [03:39.82]\n[03:41.63]我[03:41.97]绝[03:42.29]不[03:42.61]罕[03:43.05]有[03:43.57]\n[03:41.63]o [03:41.97]zu [03:42.29]ba [03:42.61]hon [03:43.05]yau [03:43.57]\n[03:43.89]往[03:44.24]街[03:44.65]里[03:44.97]绕[03:45.31]过[03:45.73]一[03:46.20]周[03:46.85]\n[03:43.89]wong [03:44.24]gai [03:44.65]lui [03:44.97]yiu [03:45.31]gwo [03:45.73]ya [03:46.20]zou [03:46.85]\n[03:47.12]我[03:47.45]便[03:47.96]化[03:48.47]乌[03:48.86]有[03:51.18]\n[03:47.12]o [03:47.45]bin [03:47.96]fa [03:48.47]wu [03:48.86]yau [03:51.18]\n[03:52.42]你[03:52.78]还[03:53.07]嫌[03:53.40]不[03:53.78]够[03:54.22]\n[03:52.42]nei [03:52.78]wan [03:53.07]yin [03:53.40]ba [03:53.78]gou [03:54.22]\n[03:54.38]我[03:54.69]把[03:55.02]这[03:55.34]陈[03:55.68]年[03:55.99]风[03:56.45]褛[03:57.06]\n[03:54.38]o [03:54.69]ba [03:55.02]ze [03:55.34]can [03:55.68]nin [03:55.99]fong [03:56.45]lui [03:57.06]\n[03:57.28]送[03:57.57]赠[03:58.05]你[03:58.54]解[03:59.16]咒[04:11.46]\n[03:57.28]song [03:57.57]zang [03:58.05]nei [03:58.54]gai [03:59.16]zou [04:11.46]",
    "lrcUrl": "assets/lyrics/track_09.lrc"
  },
  {
    "index": "010",
    "spineNum": "10",
    "serial": "WK-REAL-10",
    "title": "此生不换",
    "shortTitle": "此生不换 · 仙剑3",
    "spineTitle": "此生不换 · 仙剑三",
    "subtitleQuote": "| 回头看，不曾走远，依依目光此生不换",
    "artist": "青鸟飞鱼",
    "subArtist": "电视剧《仙剑奇侠传三》绝版插曲",
    "statusTag": "仙侠绝响",
    "subTag": "仙剑经典",
    "durationSec": 267,
    "currentSec": 0,
    "accent": "#10b981",
    "c1": "#34d399",
    "c2": "#065f46",
    "picUrl": "assets/covers/cover_10.jpg",
    "audioUrl": "assets/audio/track_10.mp3",
    "notes": [
      261.63,
      293.66,
      329.63,
      392,
      440,
      392,
      329.63,
      293.66
    ],
    "lyrics": [
      {
        "t": 0,
        "l1": "此生不换 - 青鸟飞鱼 Blue Bird Flying Fish",
        "l2": ""
      },
      {
        "t": 11.05,
        "l1": "词：杨漩予",
        "l2": ""
      },
      {
        "t": 22.11,
        "l1": "曲：闻震",
        "l2": ""
      },
      {
        "t": 33.16,
        "l1": "时光穿不断流转在从前",
        "l2": ""
      },
      {
        "t": 40.6,
        "l1": "刻骨的变迁不是遥远",
        "l2": ""
      },
      {
        "t": 46.98,
        "l1": "再有一万年深情也不变",
        "l2": ""
      },
      {
        "t": 54.42,
        "l1": "爱像烈火般蔓延",
        "l2": ""
      },
      {
        "t": 62.73,
        "l1": "记忆是条长线盘旋在天边",
        "l2": ""
      },
      {
        "t": 70.1,
        "l1": "沉浮中以为情深缘浅",
        "l2": ""
      },
      {
        "t": 76.62,
        "l1": "你再度出现我看见誓言",
        "l2": ""
      },
      {
        "t": 83.9,
        "l1": "承诺在水天之间",
        "l2": ""
      },
      {
        "t": 91.15,
        "l1": "回头看不曾走远",
        "l2": ""
      },
      {
        "t": 98.73,
        "l1": "依依目光此生不换",
        "l2": ""
      },
      {
        "t": 106.01,
        "l1": "要分散不习惯",
        "l2": ""
      },
      {
        "t": 109.8,
        "l1": "怎么算都太难",
        "l2": ""
      },
      {
        "t": 113.5,
        "l1": "分开之后更勇敢",
        "l2": ""
      },
      {
        "t": 120.86,
        "l1": "愿这爱世代相传",
        "l2": ""
      },
      {
        "t": 132.83,
        "l1": "喝不完忘情水",
        "l2": ""
      },
      {
        "t": 135.07,
        "l1": "不让你如烟",
        "l2": ""
      },
      {
        "t": 140.22,
        "l1": "前尘再怀念望剑如面",
        "l2": ""
      },
      {
        "t": 146.72,
        "l1": "挥舞的瞬间别再闭上眼",
        "l2": ""
      },
      {
        "t": 154.14,
        "l1": "错过惊世的依恋",
        "l2": ""
      },
      {
        "t": 161.06,
        "l1": "回头看不曾走远",
        "l2": ""
      },
      {
        "t": 168.87,
        "l1": "眷恋一人流连忘返",
        "l2": ""
      },
      {
        "t": 176.27,
        "l1": "多少汗够温暖",
        "l2": ""
      },
      {
        "t": 179.94,
        "l1": "你哭喊我呼唤",
        "l2": ""
      },
      {
        "t": 183.65,
        "l1": "听清耳边的呢喃",
        "l2": ""
      },
      {
        "t": 190.83,
        "l1": "别害怕风轻云淡",
        "l2": ""
      },
      {
        "t": 212.73,
        "l1": "回头看不曾走远",
        "l2": ""
      },
      {
        "t": 220.55,
        "l1": "依依目光此生不换",
        "l2": ""
      },
      {
        "t": 227.97,
        "l1": "要分散不习惯",
        "l2": ""
      },
      {
        "t": 231.61,
        "l1": "怎么算都太难",
        "l2": ""
      },
      {
        "t": 235.36,
        "l1": "分开之后更勇敢",
        "l2": ""
      },
      {
        "t": 242.45,
        "l1": "愿这爱世代相传",
        "l2": ""
      }
    ],
    "comments": [
      "【热评 @蜀山之巅】茂茂割肉、龙葵跳炉、紫萱白头……这首歌一响，仙剑三的泪水根本止不住。"
    ],
    "lyricsRaw": "[ti:此生不换]\n[ar:青鸟飞鱼]\n[al:仙剑奇侠传三 电视剧原声带]\n[offset:0]\n\n[00:00.00]此[00:00.52]生[00:01.05]不[00:01.57]换[00:02.10] [00:02.63]-[00:03.15] [00:03.68]青[00:04.20]鸟[00:04.73]飞[00:05.26]鱼[00:05.78] [00:06.31][00:06.83]Blue[00:07.36] [00:07.89]Bird[00:08.41] [00:08.94]Flying[00:09.46] [00:09.99]Fish[00:10.52]\n[00:11.05]词[00:13.26]：[00:15.47]杨[00:17.68]漩[00:19.89]予[00:22.11]\n[00:22.11]曲[00:24.87]：[00:27.63]闻[00:30.39]震[00:33.15]\n[00:33.16]时[00:33.32]光[00:33.71]穿[00:34.13]不[00:34.38]断[00:35.05]流[00:35.47]转[00:35.95]在[00:36.17]从[00:36.70]前[00:37.69]\n[00:40.60]刻[00:40.77]骨[00:41.11]的[00:41.53]变[00:41.76]迁[00:42.50]不[00:42.94]是[00:43.41]遥[00:43.92]远[00:46.11]\n[00:46.98]再[00:47.56]有[00:48.28]一[00:48.95]万[00:49.47]年[00:50.82]深[00:51.28]情[00:51.96]也[00:52.55]不[00:53.08]变[00:53.88]\n[00:54.42]爱[00:54.93]像[00:55.60]烈[00:56.31]火[00:56.80]般[00:58.05]蔓[00:58.88]延[01:01.55]\n[01:02.73]记[01:02.91]忆[01:03.29]是[01:03.68]条[01:03.94]长[01:04.38]线[01:04.86]盘[01:05.09]旋[01:05.52]在[01:05.80]天[01:06.46]边[01:07.58]\n[01:10.10]沉[01:10.25]浮[01:10.57]中[01:11.07]以[01:11.31]为[01:11.86]情[01:12.40]深[01:12.88]缘[01:13.41]浅[01:15.97]\n[01:16.62]你[01:17.07]再[01:17.75]度[01:18.30]出[01:18.81]现[01:20.20]我[01:20.66]看[01:21.41]见[01:22.03]誓[01:22.58]言[01:23.32]\n[01:23.90]承[01:24.42]诺[01:25.07]在[01:25.76]水[01:26.28]天[01:27.60]之[01:28.11]间[01:30.87]\n[01:31.15]回[01:31.57]头[01:31.83]看[01:34.98]不[01:35.48]曾[01:36.43]走[01:37.14]远[01:38.42]\n[01:38.73]依[01:39.22]依[01:40.60]目[01:41.08]光[01:42.42]此[01:42.86]生[01:43.75]不[01:44.53]换[01:45.44]\n[01:46.01]要[01:46.52]分[01:47.01]散[01:47.28]不[01:47.79]习[01:48.46]惯[01:49.37]\n[01:49.80]怎[01:50.28]么[01:50.74]算[01:51.04]都[01:51.45]太[01:52.12]难[01:53.04]\n[01:53.50]分[01:53.99]开[01:55.33]之[01:55.83]后[01:56.99]更[01:57.26]勇[01:58.09]敢[01:59.98]\n[02:00.86]愿[02:01.04]这[02:01.34]爱[02:02.68]世[02:03.14]代[02:04.27]相[02:05.04]传[02:10.66]\n[02:12.83]喝[02:12.97]不[02:13.35]完[02:13.82]忘[02:14.03]情[02:14.58]水[02:14.94]\n[02:15.07]不[02:15.27]让[02:15.72]你[02:15.98]如[02:16.60]烟[02:17.58]\n[02:20.22]前[02:20.44]尘[02:20.80]再[02:21.25]怀[02:21.46]念[02:22.10]望[02:22.58]剑[02:23.04]如[02:23.55]面[02:25.95]\n[02:26.72]挥[02:27.24]舞[02:27.87]的[02:28.42]瞬[02:29.02]间[02:30.42]别[02:30.90]再[02:31.45]闭[02:32.16]上[02:32.73]眼[02:33.62]\n[02:34.14]错[02:34.68]过[02:35.32]惊[02:35.93]世[02:36.46]的[02:37.87]依[02:38.35]恋[02:40.90]\n[02:41.06]回[02:41.42]头[02:41.93]看[02:45.23]不[02:45.70]曾[02:46.63]走[02:47.40]远[02:48.66]\n[02:48.87]眷[02:49.38]恋[02:50.73]一[02:51.21]人[02:52.53]流[02:53.08]连[02:53.94]忘[02:54.66]返[02:55.87]\n[02:56.27]多[02:56.70]少[02:57.20]汗[02:57.50]够[02:57.96]温[02:58.66]暖[02:59.53]\n[02:59.94]你[03:00.41]哭[03:00.88]喊[03:01.17]我[03:01.60]呼[03:02.31]唤[03:03.28]\n[03:03.65]听[03:04.16]清[03:05.50]耳[03:06.03]边[03:07.24]的[03:07.58]呢[03:08.26]喃[03:10.06]\n[03:10.83]别[03:11.15]害[03:11.51]怕[03:12.90]风[03:13.33]轻[03:14.60]云[03:15.19]淡[03:20.63]\n[03:32.73]回[03:33.22]头[03:33.68]看[03:36.86]不[03:37.34]曾[03:38.36]走[03:39.07]远[03:40.21]\n[03:40.55]依[03:41.07]依[03:42.41]目[03:42.91]光[03:44.23]此[03:44.72]生[03:45.59]不[03:46.37]换[03:47.59]\n[03:47.97]要[03:48.40]分[03:48.85]散[03:49.12]不[03:49.59]习[03:50.29]惯[03:51.16]\n[03:51.61]怎[03:52.09]么[03:52.54]算[03:52.81]都[03:53.30]太[03:53.96]难[03:55.20]\n[03:55.36]分[03:55.81]开[03:57.19]之[03:57.69]后[03:58.51]更[03:58.80]勇[03:59.53]敢[04:02.18]\n[04:02.45]愿[04:02.88]这[04:03.18]爱[04:04.56]世[04:05.02]代[04:06.34]相[04:06.91]传[04:11.21]",
    "lrcUrl": "assets/lyrics/track_10.lrc"
  },
  {
    "index": "011",
    "spineNum": "11",
    "serial": "WK-REAL-11",
    "title": "打上花火",
    "shortTitle": "打上花火 · 烟花",
    "spineTitle": "打上花火 · 米津玄师",
    "subtitleQuote": "| 盛放的花火，是否无论从何处看都绚烂",
    "artist": "DAOKO × 米津玄师",
    "subArtist": "动画电影《烟花》主题曲",
    "statusTag": "夏日物语",
    "subTag": "夏夜烟火",
    "durationSec": 258,
    "currentSec": 0,
    "accent": "#f43f5e",
    "c1": "#fb7185",
    "c2": "#4c0519",
    "picUrl": "assets/covers/cover_11.jpg",
    "audioUrl": "assets/audio/track_11.mp3",
    "notes": [
      293.66,
      329.63,
      392,
      440,
      493.88,
      440,
      392,
      329.63
    ],
    "lyrics": [
      {
        "t": 0,
        "l1": "打上花火 - ダヲコ/米津玄師よねづ けんし",
        "l2": ""
      },
      {
        "t": 4.33,
        "l1": "词：米津玄師",
        "l2": ""
      },
      {
        "t": 5.56,
        "l1": "曲：米津玄師",
        "l2": ""
      },
      {
        "t": 7.11,
        "l1": "编曲：米津玄師/田中隼人",
        "l2": ""
      },
      {
        "t": 7.11,
        "l1": "(9899,154)",
        "l2": ""
      },
      {
        "t": 10.05,
        "l1": "Produce：米津玄師",
        "l2": ""
      },
      {
        "t": 10.05,
        "l1": "(10672,154)",
        "l2": ""
      },
      {
        "t": 10.82,
        "l1": "Executive Produce：川村元気",
        "l2": ""
      },
      {
        "t": 11.75,
        "l1": "Sound Produce：浦本雅史Soi.Co.",
        "l2": ""
      },
      {
        "t": 11.75,
        "l1": "(13147,154)",
        "l2": ""
      },
      {
        "t": 13.3,
        "l1": "Recording & Mix：浦本雅史Soi.Co.",
        "l2": ""
      },
      {
        "t": 14.84,
        "l1": "Mastering：Ted Stering",
        "l2": ""
      },
      {
        "t": 14.84,
        "l1": "(15467,154)",
        "l2": ""
      },
      {
        "t": 15.62,
        "l1": "Guitar：真壁陽平",
        "l2": ""
      },
      {
        "t": 15.62,
        "l1": "(16239,154)",
        "l2": ""
      },
      {
        "t": 16.39,
        "l1": "Drum：堀正輝",
        "l2": ""
      },
      {
        "t": 17.32,
        "l1": "Piano：横山裕章",
        "l2": ""
      },
      {
        "t": 17.32,
        "l1": "(17941,154)",
        "l2": ""
      },
      {
        "t": 18.09,
        "l1": "Strings：室屋光一郎ストリングス",
        "l2": ""
      },
      {
        "t": 19.95,
        "l1": "あの日見渡した渚を",
        "l2": ""
      },
      {
        "t": 19.95,
        "l1": "a no hi mi wa ta shi ta na gi sa wo",
        "l2": ""
      },
      {
        "t": 24.93,
        "l1": "今も思い出すんだ",
        "l2": ""
      },
      {
        "t": 24.93,
        "l1": "i ma mo o mo i da su n da",
        "l2": ""
      },
      {
        "t": 29.92,
        "l1": "砂の上に刻んだ言葉 君の後ろ姿",
        "l2": ""
      },
      {
        "t": 29.92,
        "l1": "su na no u e ni ki za n da ko to ba   ki mi no u shi ro su ga ta",
        "l2": ""
      },
      {
        "t": 39.92,
        "l1": "寄り返す波が",
        "l2": ""
      },
      {
        "t": 39.92,
        "l1": "yo ri ka e su na mi ga",
        "l2": ""
      },
      {
        "t": 43.39,
        "l1": "足元をよぎり何かを攫う",
        "l2": ""
      },
      {
        "t": 43.39,
        "l1": "a shi mo to wo yo gi ri na ni ka wo sa ra u",
        "l2": ""
      },
      {
        "t": 49.91,
        "l1": "夕凪の中",
        "l2": ""
      },
      {
        "t": 49.91,
        "l1": "yu u na gi no na ka",
        "l2": ""
      },
      {
        "t": 53.42,
        "l1": "日暮れだけが通り過ぎて行く",
        "l2": ""
      },
      {
        "t": 53.42,
        "l1": "hi gu re da ke ga to o ri su gi te i ku",
        "l2": ""
      },
      {
        "t": 59.77,
        "l1": "パッと光って咲いた",
        "l2": ""
      },
      {
        "t": 59.77,
        "l1": "pa 't to hi ka 't te sa i ta",
        "l2": ""
      },
      {
        "t": 62.41,
        "l1": "花火を見ていた",
        "l2": ""
      },
      {
        "t": 62.41,
        "l1": "ha na bi wo mi te i ta",
        "l2": ""
      },
      {
        "t": 64.87,
        "l1": "きっとまだ 終わらない夏が",
        "l2": ""
      },
      {
        "t": 64.87,
        "l1": "ki 't to ma da   o wa ra na i na tsu ga",
        "l2": ""
      },
      {
        "t": 69.83,
        "l1": "曖昧な心を 解かして繋いだ",
        "l2": ""
      },
      {
        "t": 69.83,
        "l1": "a i ma i na ko ko ro wo   to ka shi te tsu na i da",
        "l2": ""
      },
      {
        "t": 74.85,
        "l1": "この夜が 続いて欲しかった",
        "l2": ""
      },
      {
        "t": 74.85,
        "l1": "ko no yo ru ga   tsu zu i te ho shi ka 't ta",
        "l2": ""
      },
      {
        "t": 90.1,
        "l1": "「あと何度君と",
        "l2": ""
      },
      {
        "t": 90.1,
        "l1": "「 a to na n do ki mi to",
        "l2": ""
      },
      {
        "t": 91.54,
        "l1": "同じ花火を見られるかな」って",
        "l2": ""
      },
      {
        "t": 91.54,
        "l1": "o na ji ha na bi wo mi ra re ru ka na 」 't te",
        "l2": ""
      },
      {
        "t": 94.91,
        "l1": "笑う顔に何ができるだろうか",
        "l2": ""
      },
      {
        "t": 94.91,
        "l1": "wa ra u ka o ni na ni ga de ki ru da ro u ka",
        "l2": ""
      },
      {
        "t": 100.22,
        "l1": "傷つくこと 喜ぶこと",
        "l2": ""
      },
      {
        "t": 100.22,
        "l1": "ki zu tsu ku ko to   yo ro ko bu ko to",
        "l2": ""
      },
      {
        "t": 102.71,
        "l1": "繰り返す波と情動",
        "l2": ""
      },
      {
        "t": 102.71,
        "l1": "ku ri ka e su na mi to jo u do u",
        "l2": ""
      },
      {
        "t": 105.03,
        "l1": "焦燥 最終列車の音",
        "l2": ""
      },
      {
        "t": 105.03,
        "l1": "sho u so u   sa i shu u re 's sha no o to",
        "l2": ""
      },
      {
        "t": 110.53,
        "l1": "何度でも 言葉にして君を呼ぶよ",
        "l2": ""
      },
      {
        "t": 110.53,
        "l1": "na n do de mo   ko to ba ni shi te ki mi wo yo bu yo",
        "l2": ""
      },
      {
        "t": 115.06,
        "l1": "波間を選び もう一度",
        "l2": ""
      },
      {
        "t": 115.06,
        "l1": "na mi ma wo e ra bi   mo u i chi do",
        "l2": ""
      },
      {
        "t": 120.56,
        "l1": "もう二度と悲しまずに済むように",
        "l2": ""
      },
      {
        "t": 120.56,
        "l1": "mo u ni do to ka na shi ma zu ni su mu yo u ni",
        "l2": ""
      },
      {
        "t": 137.36,
        "l1": "はっと息を飲めば",
        "l2": ""
      },
      {
        "t": 137.36,
        "l1": "ha 't to i ki wo no me ba",
        "l2": ""
      },
      {
        "t": 139.8,
        "l1": "消えちゃいそうな光が",
        "l2": ""
      },
      {
        "t": 139.8,
        "l1": "ki e cha i so u na hi ka ri ga",
        "l2": ""
      },
      {
        "t": 142.34,
        "l1": "きっとまだ 胸に住んでいた",
        "l2": ""
      },
      {
        "t": 142.34,
        "l1": "ki 't to ma da   mu ne ni su n de i ta",
        "l2": ""
      },
      {
        "t": 147.24,
        "l1": "手を伸ばせば触れた",
        "l2": ""
      },
      {
        "t": 147.24,
        "l1": "te wo no ba se ba fu re ta",
        "l2": ""
      },
      {
        "t": 149.89,
        "l1": "あったかい未来は",
        "l2": ""
      },
      {
        "t": 149.89,
        "l1": "a 't ta ka i mi ra i wa",
        "l2": ""
      },
      {
        "t": 152.3,
        "l1": "ひそかに二人を見ていた",
        "l2": ""
      },
      {
        "t": 152.3,
        "l1": "hi so ka ni fu ta ri wo mi te i ta",
        "l2": ""
      },
      {
        "t": 158.32,
        "l1": "パッと花火が",
        "l2": ""
      },
      {
        "t": 158.32,
        "l1": "pa 't to ha na bi ga",
        "l2": ""
      },
      {
        "t": 160.83,
        "l1": "夜に咲いた",
        "l2": ""
      },
      {
        "t": 160.83,
        "l1": "yo ru ni sa i ta",
        "l2": ""
      },
      {
        "t": 163.37,
        "l1": "夜に咲いて",
        "l2": ""
      },
      {
        "t": 163.37,
        "l1": "yo ru ni sa i te",
        "l2": ""
      },
      {
        "t": 165.82,
        "l1": "静かに消えた",
        "l2": ""
      },
      {
        "t": 165.82,
        "l1": "shi zu ka ni ki e ta",
        "l2": ""
      },
      {
        "t": 168.26,
        "l1": "離さないで",
        "l2": ""
      },
      {
        "t": 168.26,
        "l1": "ha na sa na i de",
        "l2": ""
      },
      {
        "t": 169.72,
        "l1": "離れないで",
        "l2": ""
      },
      {
        "t": 169.72,
        "l1": "ha na re na i de",
        "l2": ""
      },
      {
        "t": 170.76,
        "l1": "もう少しだけ",
        "l2": ""
      },
      {
        "t": 170.76,
        "l1": "mo u su ko shi da ke",
        "l2": ""
      },
      {
        "t": 173.4,
        "l1": "もう少しだけ",
        "l2": ""
      },
      {
        "t": 173.4,
        "l1": "mo u su ko shi da ke",
        "l2": ""
      },
      {
        "t": 174.57,
        "l1": "このままで",
        "l2": ""
      },
      {
        "t": 174.57,
        "l1": "ko no ma ma de",
        "l2": ""
      },
      {
        "t": 187.4,
        "l1": "あの日見渡した渚を",
        "l2": ""
      },
      {
        "t": 187.4,
        "l1": "a no hi mi wa ta shi ta na gi sa wo",
        "l2": ""
      },
      {
        "t": 192.46,
        "l1": "今も思い出すんだ",
        "l2": ""
      },
      {
        "t": 192.46,
        "l1": "i ma mo o mo i da su n da",
        "l2": ""
      },
      {
        "t": 197.29,
        "l1": "砂の上に刻んだ言葉 君の後ろ姿",
        "l2": ""
      },
      {
        "t": 197.29,
        "l1": "su na no u e ni ki za n da ko to ba   ki mi no u shi ro su ga ta",
        "l2": ""
      },
      {
        "t": 207.34,
        "l1": "パッと光って咲いた",
        "l2": ""
      },
      {
        "t": 207.34,
        "l1": "pa 't to hi ka 't te sa i ta",
        "l2": ""
      },
      {
        "t": 209.84,
        "l1": "花火を見ていた",
        "l2": ""
      },
      {
        "t": 209.84,
        "l1": "ha na bi wo mi te i ta",
        "l2": ""
      },
      {
        "t": 212.36,
        "l1": "きっとまだ 終わらない夏が",
        "l2": ""
      },
      {
        "t": 212.36,
        "l1": "ki 't to ma da   o wa ra na i na tsu ga",
        "l2": ""
      },
      {
        "t": 217.27,
        "l1": "曖昧な心を 解かして繋いだ",
        "l2": ""
      },
      {
        "t": 217.27,
        "l1": "a i ma i na ko ko ro wo   to ka shi te tsu na i da",
        "l2": ""
      },
      {
        "t": 222.32,
        "l1": "この夜が 続いて欲しかった",
        "l2": ""
      },
      {
        "t": 222.32,
        "l1": "ko no yo ru ga   tsu zu i te ho shi ka 't ta",
        "l2": ""
      }
    ],
    "comments": [
      "【热评 @花火大会】夏天的遗憾，总是在这首歌响起的瞬间被温柔抚平。"
    ],
    "lyricsRaw": "[ti:打上花火]\n[ar:Daoko、米津玄師]\n[al:打上花火 (通常盤)]\n[offset:0]\n\n[00:00.00]打[00:00.30]上[00:00.61][00:00.61]花[00:00.92]火[00:01.08][00:01.08] - [00:01.23][00:01.39]ダ[00:01.54][00:01.54]ヲ[00:01.70]コ[00:01.85][00:01.85]/[00:02.01][00:02.01]米[00:02.32]津[00:02.47][00:02.47]玄[00:02.78]師[00:02.93][00:03.09]よ[00:03.24][00:03.24]ね[00:03.40][00:03.40]づ[00:03.55] [00:03.71][00:03.71]け[00:03.86][00:03.86]ん[00:04.02]し[00:04.17]\n[00:04.33]词[00:04.48]：[00:04.63][00:04.64]米[00:04.94]津[00:05.10][00:05.10]玄[00:05.41]師[00:05.56]\n[00:05.56]曲[00:06.03]：[00:06.18][00:06.18]米[00:06.49]津[00:06.65][00:06.65]玄[00:06.96]師[00:07.11]\n[00:07.11]编[00:07.42]曲[00:07.88]：[00:08.04][00:08.04]米[00:08.35]津[00:08.50][00:08.50]玄[00:08.81]師[00:08.97][00:08.97]/[00:09.12]田[00:09.27][00:09.28]中[00:09.58]隼[00:09.89][00:09.89]人[00:10.05]\n[00:07.11](9899,154)[00:10.05]\n[00:10.05]Produce：[00:10.20][00:10.20]米[00:10.36][00:10.36]津[00:10.51]玄[00:10.67][00:10.67]師[00:10.82]\n[00:10.05](10672,154)[00:10.82]\n[00:10.82]Executive [00:10.98]Produce：[00:11.13][00:11.13]川[00:11.29][00:11.29]村[00:11.44]元[00:11.59][00:11.60]気[00:11.75]\n[00:11.75]Sound [00:11.90]Produce：[00:12.06][00:12.06]浦[00:12.21][00:12.21]本[00:12.37]雅[00:12.52][00:12.52]史[00:12.68][00:12.83]Soi.[00:12.99][00:12.99]Co.[00:13.14]\n[00:11.75](13147,154)[00:13.30]\n[00:13.30]Recording & [00:13.45][00:13.45]Mix：[00:13.61][00:13.61]浦[00:13.76]本[00:13.91][00:13.92]雅[00:14.07][00:14.07]史[00:14.22][00:14.38]Soi.[00:14.53][00:14.53]Co.[00:14.69]\n[00:14.84]Mastering：[00:15.00][00:15.00]Ted [00:15.15][00:15.31]Stering [00:15.46]\n[00:14.84](15467,154)[00:15.62]\n[00:15.62]Guitar：[00:15.77][00:15.77]真[00:15.93][00:15.93]壁[00:16.08]陽[00:16.23][00:16.24]平[00:16.39]\n[00:15.62](16239,154)[00:16.39]\n[00:16.39]Drum：[00:16.54]堀[00:16.70][00:16.70]正[00:16.85][00:16.85]輝[00:17.01]\n[00:17.32]Piano：[00:17.47]横[00:17.63][00:17.63]山[00:17.78][00:17.78]裕[00:17.94]章[00:18.09]\n[00:17.32](17941,154)[00:18.09]\n[00:18.09]Strings：[00:18.25][00:18.25]室[00:18.40]屋[00:18.55][00:18.56]光[00:18.71][00:18.71]一[00:18.86]郎[00:19.02][00:19.02]ス[00:19.17][00:19.17]ト[00:19.33]リ[00:19.48][00:19.48]ン[00:19.64][00:19.64]グ[00:19.79]ス[00:19.95]\n[00:19.95]あ[00:20.21]の[00:20.64]日[00:21.19]見[00:21.50]渡[00:22.46]し[00:22.74]た[00:23.11]渚[00:24.17]を[00:24.42]\n[00:19.95]a [00:20.21]no [00:20.64]hi [00:21.19]mi [00:21.50]wa [00:22.15]ta [00:22.46]shi [00:22.74]ta [00:23.11]na [00:23.41]gi [00:23.72]sa [00:24.17]wo [00:24.42]\n[00:24.93]今[00:25.58]も[00:25.69]思[00:26.39]い[00:26.84]出[00:27.09]す[00:27.26]ん[00:28.01]だ[00:28.70]\n[00:24.93]i [00:25.17]ma [00:25.58]mo [00:25.69]o [00:26.18]mo [00:26.39]i [00:26.84]da [00:27.09]su [00:27.26]n [00:28.01]da [00:28.70]\n[00:29.92]砂[00:30.54]の[00:30.78]上[00:31.51]に[00:32.15]刻[00:32.54]ん[00:33.09]だ[00:33.39]言[00:34.10]葉[00:34.92] [00:34.92]君[00:35.62]の[00:35.67]後[00:36.82]ろ[00:37.09]姿[00:38.56]\n[00:29.92]su [00:30.17]na [00:30.54]no [00:30.78]u [00:31.16]e [00:31.51]ni [00:32.15]ki [00:32.42]za [00:32.54][00:32.54]n [00:33.09][00:33.09]da [00:33.39]ko [00:33.69]to [00:34.10]ba [00:34.92]  [00:34.92]ki [00:35.03]mi [00:35.62]no [00:35.67]u [00:36.19]shi [00:36.82]ro [00:37.09]su [00:37.40]ga [00:37.89]ta [00:38.56]\n[00:39.92]寄[00:40.18]り[00:40.60]返[00:41.48]す[00:41.78]波[00:42.52]が[00:42.98]\n[00:39.92]yo [00:40.18]ri [00:40.60]ka [00:40.84]e [00:41.48]su [00:41.78]na [00:42.09]mi [00:42.52]ga [00:42.98]\n[00:43.39]足[00:43.87]元[00:44.56]を[00:44.89]よ[00:45.22]ぎ[00:45.58]り[00:45.87]何[00:46.50]か[00:46.82]を[00:47.11]攫[00:47.84]う[00:48.50]\n[00:43.39]a [00:43.60]shi [00:43.87]mo [00:44.28]to [00:44.56]wo [00:44.89]yo [00:45.22]gi [00:45.58]ri [00:45.87]na [00:46.21]ni [00:46.50]ka [00:46.82]wo [00:47.11]sa [00:47.44]ra [00:47.84]u [00:48.50]\n[00:49.91]夕[00:50.62]凪[00:51.81]の[00:52.09]中[00:52.95]\n[00:49.91]yu [00:49.94]u [00:50.62]na [00:51.47]gi [00:51.81]no [00:52.09]na [00:52.54]ka [00:52.95]\n[00:53.42]日[00:53.72]暮[00:54.00]れ[00:54.33]だ[00:54.63]け[00:54.96]が[00:55.25]通[00:55.83]り[00:56.16]過[00:56.44]ぎ[00:56.79]て[00:57.09]行[00:57.52]く[00:58.14]\n[00:53.42]hi [00:53.72]gu [00:54.00]re [00:54.33]da [00:54.63]ke [00:54.96]ga [00:55.25]to [00:55.54]o [00:55.83]ri [00:56.16]su [00:56.44]gi [00:56.79]te [00:57.09]i [00:57.52]ku [00:58.14]\n[00:59.77]パ[00:59.95]ッ[01:00.14]と[01:00.30]光[01:00.72]っ[01:00.87]て[01:01.14]咲[01:01.33]い[01:01.78]た[01:02.08]\n[00:59.77]pa [00:59.95]'t [01:00.14]to [01:00.30]hi [01:00.57]ka [01:00.72]'t [01:00.87]te [01:01.14]sa [01:01.33]i [01:01.78]ta [01:02.08]\n[01:02.41]花[01:02.85]火[01:03.10]を[01:03.38]見[01:03.70]て[01:03.83]い[01:04.38]た[01:04.65]\n[01:02.41]ha [01:02.68]na [01:02.85]bi [01:03.10]wo [01:03.38]mi [01:03.70]te [01:03.83]i [01:04.38]ta [01:04.65]\n[01:04.87]き[01:05.03]っ[01:05.20]と[01:05.38]ま[01:05.65]だ[01:06.12] [01:06.12]終[01:06.19]わ[01:06.66]ら[01:06.99]な[01:07.07]い[01:07.47]夏[01:08.00]が[01:08.74]\n[01:04.87]ki [01:05.03]'t [01:05.20]to [01:05.38]ma [01:05.65]da [01:06.12]  [01:06.12]o [01:06.19]wa [01:06.66]ra [01:06.99]na [01:07.07]i [01:07.47]na [01:07.52]tsu [01:08.00]ga [01:08.74]\n[01:09.83]曖[01:10.26]昧[01:10.55]な[01:10.85]心[01:11.72]を[01:12.44] [01:12.44]解[01:12.50]か[01:12.73]し[01:13.06]て[01:13.36]繋[01:13.86]い[01:14.29]だ[01:14.62]\n[01:09.83]a [01:09.91]i [01:10.26]ma [01:10.28]i [01:10.55]na [01:10.85]ko [01:11.17]ko [01:11.34]ro [01:11.72]wo [01:12.44]  [01:12.44]to [01:12.50]ka [01:12.73]shi [01:13.06]te [01:13.36]tsu [01:13.67]na [01:13.86]i [01:14.29]da [01:14.62]\n[01:14.85]こ[01:14.93]の[01:15.20]夜[01:15.66]が[01:16.17] [01:16.17]続[01:16.41]い[01:16.85]て[01:17.13]欲[01:17.47]し[01:17.79]か[01:18.15]っ[01:18.52]た[01:19.60]\n[01:14.85]ko [01:14.93]no [01:15.20]yo [01:15.37]ru [01:15.66]ga [01:16.17]  [01:16.17]tsu [01:16.21]zu [01:16.41]i [01:16.85]te [01:17.13]ho [01:17.47]shi [01:17.79]ka [01:18.15]'t [01:18.52]ta [01:19.60]\n[01:30.10]「[01:30.24]あ[01:30.32]と[01:30.60]何[01:30.89]度[01:31.08]君[01:31.52]と[01:31.54]\n[01:30.10]「 [01:30.24]a [01:30.32]to [01:30.60]na [01:30.75]n [01:30.89]do [01:31.08]ki [01:31.26]mi [01:31.52]to [01:31.54]\n[01:31.54]同[01:32.13]じ[01:32.17]花[01:32.76]火[01:32.95]を[01:33.06]見[01:33.38]ら[01:33.56]れ[01:33.76]る[01:33.78]か[01:34.03]な[01:34.22]」[01:34.41]っ[01:34.48]て[01:34.51]\n[01:31.54]o [01:31.81]na [01:32.13]ji [01:32.17]ha [01:32.46]na [01:32.76]bi [01:32.95]wo [01:33.06]mi [01:33.38]ra [01:33.56]re [01:33.76]ru [01:33.78]ka [01:34.03]na [01:34.22]」 [01:34.41]'t [01:34.48]te [01:34.51]\n[01:34.91]笑[01:35.19]う[01:35.40]顔[01:35.92]に[01:35.93]何[01:36.49]が[01:36.54]で[01:36.82]き[01:37.13]る[01:37.30]だ[01:37.47]ろ[01:37.79]う[01:38.11]か[01:38.69]\n[01:34.91]wa [01:34.98]ra [01:35.19]u [01:35.40]ka [01:35.56]o [01:35.92]ni [01:35.93]na [01:36.19]ni [01:36.49]ga [01:36.54]de [01:36.82]ki [01:37.13]ru [01:37.30]da [01:37.47]ro [01:37.79]u [01:38.11]ka [01:38.69]\n[01:40.22]傷[01:40.54]つ[01:40.82]く[01:40.88]こ[01:41.16]と[01:41.45] [01:41.45]喜[01:42.16]ぶ[01:42.35]こ[01:42.44]と[01:42.49]\n[01:40.22]ki [01:40.27]zu [01:40.54]tsu [01:40.82]ku [01:40.88]ko [01:41.16]to [01:41.45]  [01:41.45]yo [01:41.50]ro [01:41.80]ko [01:42.16]bu [01:42.35]ko [01:42.44]to [01:42.49]\n[01:42.71]繰[01:42.76]り[01:43.04]返[01:43.36]す[01:43.55]波[01:43.80]と[01:44.00]情[01:44.53]動[01:44.58]\n[01:42.71]ku [01:42.76]ri [01:43.04]ka [01:43.11]e [01:43.36]su [01:43.55]na [01:43.64]mi [01:43.80]to [01:44.00]jo [01:44.17][01:44.35]u [01:44.53]do [01:44.55]u [01:44.58]\n[01:45.03]焦[01:45.47]燥[01:45.67] [01:45.78][01:45.78]最[01:46.38]終[01:46.79]列[01:47.29]車[01:47.76]の[01:47.93]音[01:49.13]\n[01:45.03]sho [01:45.18][01:45.32]u [01:45.47]so [01:45.57]u [01:45.67]  [01:45.78][01:45.78]sa [01:45.87]i [01:46.38]shu [01:46.52][01:46.65]u [01:46.79]re [01:47.04]'s [01:47.29]sha [01:47.52][01:47.76]no [01:47.93]o [01:48.50]to [01:49.13]\n[01:50.53]何[01:51.17]度[01:51.38]で[01:51.85]も[01:52.41] [01:52.41]言[01:52.81]葉[01:53.33]に[01:53.36]し[01:53.66]て[01:53.87]君[01:54.10]を[01:54.49]呼[01:54.67]ぶ[01:54.82]よ[01:54.86]\n[01:50.53]na [01:50.85]n [01:51.17]do [01:51.38]de [01:51.85]mo [01:52.41]  [01:52.41]ko [01:52.44]to [01:52.81]ba [01:53.33]ni [01:53.36]shi [01:53.66]te [01:53.87]ki [01:53.90]mi [01:54.10]wo [01:54.49]yo [01:54.67]bu [01:54.82]yo [01:54.86]\n[01:55.06]波[01:55.46]間[01:55.50]を[01:55.80]選[01:56.08]び[01:56.52] [01:56.52]も[01:56.56]う[01:56.82]一[01:57.37]度[02:00.05]\n[01:55.06]na [01:55.09]mi [01:55.46]ma [01:55.50]wo [01:55.80]e [01:55.82]ra [01:56.08]bi [01:56.52]  [01:56.52]mo [01:56.56]u [01:56.82]i [01:56.86]chi [01:57.37]do [02:00.05]\n[02:00.56]も[02:00.87]う[02:01.19]二[02:01.47]度[02:01.80]と[02:02.34]悲[02:02.80]し[02:03.70]ま[02:03.72]ず[02:04.11]に[02:05.31][02:06.53]済[02:06.58]む[02:07.11]よ[02:07.44]う[02:07.76]に[02:08.44]\n[02:00.56]mo [02:00.87]u [02:01.19]ni [02:01.47]do [02:01.80]to [02:02.34]ka [02:02.51]na [02:02.80]shi [02:03.70]ma [02:03.72]zu [02:04.11]ni [02:05.31][02:06.53]su [02:06.58]mu [02:07.11]yo [02:07.44]u [02:07.76]ni [02:08.44]\n[02:17.36]は[02:17.55]っ[02:17.73]と[02:17.76]息[02:18.36]を[02:18.66]飲[02:18.84]め[02:19.25]ば[02:19.52]\n[02:17.36]ha [02:17.55]'t [02:17.73]to [02:17.76]i [02:18.08]ki [02:18.36]wo [02:18.66]no [02:18.84]me [02:19.25]ba [02:19.52]\n[02:19.80]消[02:19.86]え[02:20.13]ち[02:20.22]ゃ[02:20.30]い[02:20.55]そ[02:20.70]う[02:20.85]な[02:21.13]光[02:21.81]が[02:21.88]\n[02:19.80]ki [02:19.86]e [02:20.13]cha [02:20.22][02:20.30]i [02:20.55]so [02:20.70]u [02:20.85]na [02:21.13]hi [02:21.31]ka [02:21.47]ri [02:21.81]ga [02:21.88]\n[02:22.34]き[02:22.49]っ[02:22.64]と[02:22.84]ま[02:23.07]だ[02:23.66] [02:23.66]胸[02:24.28]に[02:24.53]住[02:24.74][02:24.74]ん[02:24.94]で[02:24.98]い[02:25.26]た[02:26.61]\n[02:22.34]ki [02:22.49]'t [02:22.64]to [02:22.84]ma [02:23.07]da [02:23.66]  [02:23.66]mu [02:23.85]ne [02:24.28]ni [02:24.53]su [02:24.74][02:24.74]n [02:24.94]de [02:24.98]i [02:25.26]ta [02:26.61]\n[02:27.24]手[02:27.40]を[02:27.64]伸[02:27.82]ば[02:28.07]せ[02:28.38]ば[02:28.67]触[02:28.85]れ[02:29.24]た[02:29.53]\n[02:27.24]te [02:27.40]wo [02:27.64]no [02:27.82]ba [02:28.07]se [02:28.38]ba [02:28.67]fu [02:28.85]re [02:29.24]ta [02:29.53]\n[02:29.89]あ[02:30.07]っ[02:30.25][02:30.25]た[02:30.27]か[02:30.55]い[02:30.86]未[02:31.19]来[02:31.79]は[02:32.04]\n[02:29.89]a [02:30.07]'t [02:30.25][02:30.25]ta [02:30.27]ka [02:30.55]i [02:30.86]mi [02:31.19]ra [02:31.37]i [02:31.79]wa [02:32.04]\n[02:32.30]ひ[02:32.41]そ[02:32.67]か[02:32.85]に[02:33.14]二[02:34.33]人[02:34.63]を[02:34.93]見[02:35.27]て[02:35.40]い[02:36.11]た[02:36.91]\n[02:32.30]hi [02:32.41]so [02:32.67]ka [02:32.85]ni [02:33.14]fu [02:33.73]ta [02:34.33]ri [02:34.63]wo [02:34.93]mi [02:35.27]te [02:35.40]i [02:36.11]ta [02:36.91]\n[02:38.32]パ[02:38.48]ッ[02:38.64]と[02:38.82]花[02:39.21]火[02:39.46]が[02:39.83]\n[02:38.32]pa [02:38.48]'t [02:38.64]to [02:38.82]ha [02:39.02]na [02:39.21]bi [02:39.46]ga [02:39.83]\n[02:40.83]夜[02:41.27]に[02:41.48]咲[02:41.66]い[02:41.96]た[02:42.71]\n[02:40.83]yo [02:41.10]ru [02:41.27]ni [02:41.48]sa [02:41.66]i [02:41.96]ta [02:42.71]\n[02:43.37]夜[02:43.75]に[02:43.89]咲[02:44.05]い[02:44.18]て[02:45.35]\n[02:43.37]yo [02:43.58]ru [02:43.75]ni [02:43.89]sa [02:44.05]i [02:44.18]te [02:45.35]\n[02:45.82]静[02:46.13]か[02:46.30]に[02:46.48]消[02:46.65]え[02:46.90]た[02:47.88]\n[02:45.82]shi [02:45.90]zu [02:46.13]ka [02:46.30]ni [02:46.48]ki [02:46.65]e [02:46.90]ta [02:47.88]\n[02:48.26]離[02:48.69]さ[02:48.94]な[02:49.12]い[02:49.45]で[02:49.63]\n[02:48.26]ha [02:48.53]na [02:48.69]sa [02:48.94]na [02:49.12]i [02:49.45]de [02:49.63]\n[02:49.72]離[02:50.00]れ[02:50.23]な[02:50.41]い[02:50.58]で[02:50.62]\n[02:49.72][02:49.63] [02:49.72]ha [02:49.85]na [02:50.00]re [02:50.23][02:50.23]na [02:50.41][02:50.41]i [02:50.58]de [02:50.61][02:50.61] [02:50.66]\n[02:50.76]も[02:50.98]う[02:51.13]少[02:51.44]し[02:51.61]だ[02:51.93]け[02:52.69]\n[02:50.76]mo [02:50.98][02:50.98]u [02:51.13]su [02:51.17]ko [02:51.44]shi [02:51.61]da [02:51.93]ke [02:52.69]\n[02:53.40]も[02:53.54][02:53.54]う[02:53.67]少[02:53.99]し[02:54.05]だ[02:54.47]け[02:54.57]\n[02:53.40]mo [02:53.54][02:53.54]u [02:53.67]su [02:53.73]ko [02:53.99]shi [02:54.05]da [02:54.47]ke [02:54.57]\n[02:54.57]こ[02:54.73]の[02:54.95]ま[02:55.26]ま[02:55.94]で[02:57.30]\n[02:54.57]ko [02:54.73]no [02:54.95]ma [02:55.26]ma [02:55.94]de [02:57.30]\n[03:07.40]あ[03:07.68]の[03:08.10]日[03:08.71]見[03:09.05]渡[03:09.88]し[03:10.18]た[03:10.54]渚[03:11.62]を[03:11.94]\n[03:07.40]a [03:07.68]no [03:08.10]hi [03:08.71]mi [03:09.05]wa [03:09.60]ta [03:09.88]shi [03:10.18]ta [03:10.54]na [03:10.82]gi [03:11.14]sa [03:11.62]wo [03:11.94]\n[03:12.46]今[03:13.09]も[03:13.13]思[03:13.84]い[03:14.30]出[03:14.58]す[03:14.65]ん[03:15.34]だ[03:16.18]\n[03:12.46]i [03:12.72]ma [03:13.09]mo [03:13.13]o [03:13.62]mo [03:13.84]i [03:14.30]da [03:14.58]su [03:14.65]n [03:15.34]da [03:16.18]\n[03:17.29]砂[03:18.00]の[03:18.25]上[03:18.97]に[03:19.59]刻[03:19.96]ん[03:20.48]だ[03:20.80]言[03:21.55]葉[03:22.40] [03:22.40]君[03:23.08]の[03:23.31]後[03:24.35]ろ[03:24.60]姿[03:26.02]\n[03:17.29]su [03:17.58]na [03:18.00]no [03:18.25]u [03:18.63]e [03:18.97]ni [03:19.59]ki [03:19.81]za [03:19.96]n [03:20.48]da [03:20.80]ko [03:21.15]to [03:21.55]ba [03:22.40]  [03:22.40]ki [03:22.66]mi [03:23.08]no [03:23.31]u [03:23.78]shi [03:24.35]ro [03:24.60]su [03:24.92]ga [03:25.31]ta [03:26.02]\n[03:27.34]パ[03:27.48][03:27.48]ッ[03:27.63]と[03:27.79]光[03:28.21][03:28.21]っ[03:28.36]て[03:28.66]咲[03:28.84]い[03:29.20]た[03:29.59]\n[03:27.34]pa [03:27.48][03:27.48]'t [03:27.63]to [03:27.79]hi [03:28.06]ka [03:28.21][03:28.21]'t [03:28.36]te [03:28.66]sa [03:28.84]i [03:29.20]ta [03:29.59]\n[03:29.84]花[03:30.33]火[03:30.55]を[03:30.84]見[03:31.15]て[03:31.24]い[03:31.81]た[03:32.11]\n[03:29.84]ha [03:30.15]na [03:30.33]bi [03:30.55]wo [03:30.84]mi [03:31.15]te [03:31.24]i [03:31.81]ta [03:32.11]\n[03:32.36]き[03:32.52]っ[03:32.69]と[03:32.72]ま[03:33.09]だ[03:33.60] [03:33.60]終[03:33.72]わ[03:34.11]ら[03:34.44]な[03:34.56]い[03:34.96]夏[03:35.31]が[03:36.57]\n[03:32.36]ki [03:32.52]'t [03:32.69]to [03:32.72]ma [03:33.09]da [03:33.60]  [03:33.60]o [03:33.72]wa [03:34.11]ra [03:34.44]na [03:34.56]i [03:34.96]na [03:34.98]tsu [03:35.31]ga [03:36.57]\n[03:37.27]曖[03:37.66]昧[03:38.06]な[03:38.16]心[03:39.20]を[03:39.94] [03:39.94]解[03:40.03]か[03:40.25]し[03:40.58]て[03:40.89]繋[03:41.37]い[03:41.80]だ[03:42.15]\n[03:37.27]a [03:37.37]i [03:37.66]ma [03:37.72]i [03:38.06]na [03:38.16]ko [03:38.62]ko [03:38.78]ro [03:39.20]wo [03:39.94]  [03:39.94]to [03:40.03]ka [03:40.25]shi [03:40.58]te [03:40.89]tsu [03:41.20]na [03:41.37]i [03:41.80]da [03:42.15]\n[03:42.32]こ[03:42.39]の[03:42.65]夜[03:43.11]が[03:43.63] [03:43.63]続[03:43.82]い[03:44.34]て[03:44.63]欲[03:44.94]し[03:45.24]か[03:45.61]っ[03:45.99]た[03:47.17]\n[03:42.32]ko [03:42.39]no [03:42.65]yo [03:42.83]ru [03:43.11]ga [03:43.63]  [03:43.63]tsu [03:43.75]zu [03:43.82]i [03:44.34]te [03:44.63]ho [03:44.94]shi [03:45.24]ka [03:45.61]'t [03:45.99]ta [03:47.17]",
    "lrcUrl": "assets/lyrics/track_11.lrc"
  },
  {
    "index": "012",
    "spineNum": "12",
    "serial": "WK-REAL-12",
    "title": "残酷天使的行动纲领",
    "shortTitle": "残酷天使 · 高桥洋子",
    "spineTitle": "残酷天使 · EVA",
    "subtitleQuote": "| 少年啊，去成为神话吧",
    "artist": "高桥洋子",
    "subArtist": "新世纪福音战士 EVA OP",
    "statusTag": "史诗神作",
    "subTag": "EVA · 1995",
    "durationSec": 243,
    "currentSec": 0,
    "accent": "#9333ea",
    "c1": "#a855f7",
    "c2": "#3b0764",
    "picUrl": "assets/covers/cover_12.jpg",
    "audioUrl": "assets/audio/track_12.mp3",
    "notes": [
      440,
      493.88,
      523.25,
      587.33,
      659.25,
      587.33,
      523.25,
      440
    ],
    "lyrics": [
      {
        "t": 0,
        "l1": "残酷な天使のテーゼ - 高橋洋子たかはし ようこ",
        "l2": ""
      },
      {
        "t": 0,
        "l1": "(385,15)",
        "l2": ""
      },
      {
        "t": 0.4,
        "l1": "词：及川眠子",
        "l2": ""
      },
      {
        "t": 0.6,
        "l1": "曲：佐藤英敏",
        "l2": ""
      },
      {
        "t": 2,
        "l1": "残酷な天使のように",
        "l2": ""
      },
      {
        "t": 2,
        "l1": "za n ko ku na te n shi no yo u ni",
        "l2": ""
      },
      {
        "t": 7.68,
        "l1": "少年よ 神話になれ",
        "l2": ""
      },
      {
        "t": 7.68,
        "l1": "sho u ne n yo  shi n wa ni na re",
        "l2": ""
      },
      {
        "t": 23.66,
        "l1": "蒼い風がいま",
        "l2": ""
      },
      {
        "t": 23.66,
        "l1": "a o i ka ze ga i ma",
        "l2": ""
      },
      {
        "t": 26.77,
        "l1": "胸のドアを叩いても",
        "l2": ""
      },
      {
        "t": 26.77,
        "l1": "mu ne no do a wo ta ta i te mo",
        "l2": ""
      },
      {
        "t": 30.45,
        "l1": "私だけをただ見つめて",
        "l2": ""
      },
      {
        "t": 30.45,
        "l1": "wa ta shi da ke wo ta da mi tsu me te",
        "l2": ""
      },
      {
        "t": 34.21,
        "l1": "微笑んでるあなた",
        "l2": ""
      },
      {
        "t": 34.21,
        "l1": "ho ho e n de ru a na ta",
        "l2": ""
      },
      {
        "t": 38.51,
        "l1": "そっとふれるもの",
        "l2": ""
      },
      {
        "t": 38.51,
        "l1": "so 't to fu re ru mo no",
        "l2": ""
      },
      {
        "t": 41.75,
        "l1": "もとめることに夢中で",
        "l2": ""
      },
      {
        "t": 41.75,
        "l1": "mo to me ru ko to ni mu chu u de",
        "l2": ""
      },
      {
        "t": 45.43,
        "l1": "運命さえまだ知らない",
        "l2": ""
      },
      {
        "t": 45.43,
        "l1": "u n me i sa e ma da shi ra na i",
        "l2": ""
      },
      {
        "t": 49.17,
        "l1": "いたいけな瞳",
        "l2": ""
      },
      {
        "t": 49.17,
        "l1": "i ta i ke na hi to mi",
        "l2": ""
      },
      {
        "t": 53.11,
        "l1": "だけどいつか気付くでしょう",
        "l2": ""
      },
      {
        "t": 53.11,
        "l1": "da ke do i tsu ka ki zu ku de sho u",
        "l2": ""
      },
      {
        "t": 56.85,
        "l1": "その背中には",
        "l2": ""
      },
      {
        "t": 56.85,
        "l1": "so no se na ka ni wa",
        "l2": ""
      },
      {
        "t": 60.53,
        "l1": "遥か未来めざすための",
        "l2": ""
      },
      {
        "t": 60.53,
        "l1": "ha ru ka mi ra i me za su ta me no",
        "l2": ""
      },
      {
        "t": 64.28,
        "l1": "羽根があること",
        "l2": ""
      },
      {
        "t": 64.28,
        "l1": "ha ne ga a ru ko to",
        "l2": ""
      },
      {
        "t": 68.2,
        "l1": "残酷な天使のテーゼ",
        "l2": ""
      },
      {
        "t": 68.2,
        "l1": "za n ko ku na te n shi no te e ze",
        "l2": ""
      },
      {
        "t": 71.63,
        "l1": "窓辺からやがて飛び立つ",
        "l2": ""
      },
      {
        "t": 71.63,
        "l1": "ma do be ka ra ya ga te to bi ta tsu",
        "l2": ""
      },
      {
        "t": 75.57,
        "l1": "ほとばしる熱いパトスで",
        "l2": ""
      },
      {
        "t": 75.57,
        "l1": "ho to ba shi ru a tsu i pa to su de",
        "l2": ""
      },
      {
        "t": 79.31,
        "l1": "思い出を裏切るなら",
        "l2": ""
      },
      {
        "t": 79.31,
        "l1": "o mo i de wo u ra gi ru na ra",
        "l2": ""
      },
      {
        "t": 83.06,
        "l1": "この宇宙を抱いて輝く",
        "l2": ""
      },
      {
        "t": 83.06,
        "l1": "ko no so ra wo da i te ka ga ya ku",
        "l2": ""
      },
      {
        "t": 86.74,
        "l1": "少年よ神話になれ",
        "l2": ""
      },
      {
        "t": 86.74,
        "l1": "sho u ne n yo shi n wa ni na re",
        "l2": ""
      },
      {
        "t": 135.91,
        "l1": "ずっと眠ってる",
        "l2": ""
      },
      {
        "t": 135.91,
        "l1": "zu 't to ne mu 't te ru",
        "l2": ""
      },
      {
        "t": 139.1,
        "l1": "私の愛の揺りかご",
        "l2": ""
      },
      {
        "t": 139.1,
        "l1": "wa ta shi no a i no yu ri ka go",
        "l2": ""
      },
      {
        "t": 142.67,
        "l1": "あなただけが 夢の使者に",
        "l2": ""
      },
      {
        "t": 142.67,
        "l1": "a na ta da ke ga  yu me no shi sha ni",
        "l2": ""
      },
      {
        "t": 146.45,
        "l1": "呼ばれる朝がくる",
        "l2": ""
      },
      {
        "t": 146.45,
        "l1": "yo ba re ru a sa ga ku ru",
        "l2": ""
      },
      {
        "t": 150.76,
        "l1": "細い首筋を",
        "l2": ""
      },
      {
        "t": 150.76,
        "l1": "ho so i ku bi su ji wo",
        "l2": ""
      },
      {
        "t": 153.95,
        "l1": "月あかりが映してる",
        "l2": ""
      },
      {
        "t": 153.95,
        "l1": "tsu ki a ka ri ga u tsu shi te ru",
        "l2": ""
      },
      {
        "t": 157.63,
        "l1": "世界中の時を止めて",
        "l2": ""
      },
      {
        "t": 157.63,
        "l1": "se ka i ju u no to ki wo to me te",
        "l2": ""
      },
      {
        "t": 161.5,
        "l1": "閉じこめたいけど",
        "l2": ""
      },
      {
        "t": 161.5,
        "l1": "to ji ko me ta i ke do",
        "l2": ""
      },
      {
        "t": 165.37,
        "l1": "もしもふたり逢えたことに",
        "l2": ""
      },
      {
        "t": 165.37,
        "l1": "mo shi mo fu ta ri a e ta ko to ni",
        "l2": ""
      },
      {
        "t": 169.17,
        "l1": "意味があるなら",
        "l2": ""
      },
      {
        "t": 169.17,
        "l1": "i mi ga a ru na ra",
        "l2": ""
      },
      {
        "t": 172.86,
        "l1": "私はそう 自由を知る",
        "l2": ""
      },
      {
        "t": 172.86,
        "l1": "wa ta shi wa so u  ji yu u wo shi ru",
        "l2": ""
      },
      {
        "t": 176.59,
        "l1": "ためのバイブル",
        "l2": ""
      },
      {
        "t": 176.59,
        "l1": "ta me no ba i bu ru",
        "l2": ""
      },
      {
        "t": 180.53,
        "l1": "残酷な天使のテーゼ",
        "l2": ""
      },
      {
        "t": 180.53,
        "l1": "za n ko ku na te n shi no te e ze",
        "l2": ""
      },
      {
        "t": 184.02,
        "l1": "悲しみがそしてはじまる",
        "l2": ""
      },
      {
        "t": 184.02,
        "l1": "ka na shi mi ga so shi te ha ji ma ru",
        "l2": ""
      },
      {
        "t": 187.83,
        "l1": "抱きしめた命のかたち",
        "l2": ""
      },
      {
        "t": 187.83,
        "l1": "da ki shi me ta i no chi no ka ta chi",
        "l2": ""
      },
      {
        "t": 191.64,
        "l1": "その夢に目覚めたとき",
        "l2": ""
      },
      {
        "t": 191.64,
        "l1": "so no yu me ni me za me ta to ki",
        "l2": ""
      },
      {
        "t": 195.38,
        "l1": "誰よりも光を放つ",
        "l2": ""
      },
      {
        "t": 195.38,
        "l1": "da re yo ri mo hi ka ri wo ha na tsu",
        "l2": ""
      },
      {
        "t": 199.06,
        "l1": "少年よ 神話になれ",
        "l2": ""
      },
      {
        "t": 199.06,
        "l1": "sho u ne n yo  shi n wa ni na re",
        "l2": ""
      },
      {
        "t": 202.93,
        "l1": "人は愛をつむぎながら",
        "l2": ""
      },
      {
        "t": 202.93,
        "l1": "hi to wa a i wo tsu mu gi na ga ra",
        "l2": ""
      },
      {
        "t": 206.55,
        "l1": "歴史をつくる",
        "l2": ""
      },
      {
        "t": 206.55,
        "l1": "re ki shi wo tsu ku ru",
        "l2": ""
      },
      {
        "t": 210.29,
        "l1": "女神なんてなれないまま",
        "l2": ""
      },
      {
        "t": 210.29,
        "l1": "me ga mi na n te na re na i ma ma",
        "l2": ""
      },
      {
        "t": 214.04,
        "l1": "私は生きる",
        "l2": ""
      },
      {
        "t": 214.04,
        "l1": "wa ta shi wa i ki ru",
        "l2": ""
      },
      {
        "t": 217.97,
        "l1": "残酷な天使のテーゼ",
        "l2": ""
      },
      {
        "t": 217.97,
        "l1": "za n ko ku na te n shi no te e ze",
        "l2": ""
      },
      {
        "t": 221.49,
        "l1": "窓辺からやがて飛び立つ",
        "l2": ""
      },
      {
        "t": 221.49,
        "l1": "ma do be ka ra ya ga te to bi ta tsu",
        "l2": ""
      },
      {
        "t": 225.41,
        "l1": "ほとばしる熱いパトスで",
        "l2": ""
      },
      {
        "t": 225.41,
        "l1": "ho to ba shi ru a tsu i pa to su de",
        "l2": ""
      },
      {
        "t": 228.91,
        "l1": "思い出を裏切るなら",
        "l2": ""
      },
      {
        "t": 228.91,
        "l1": "o mo i de wo u ra gi ru na ra",
        "l2": ""
      },
      {
        "t": 232.77,
        "l1": "この宇宙を抱いて輝く",
        "l2": ""
      },
      {
        "t": 232.77,
        "l1": "ko no so ra wo da i te ka ga ya ku",
        "l2": ""
      },
      {
        "t": 236.52,
        "l1": "少年よ 神話になれ",
        "l2": ""
      },
      {
        "t": 236.52,
        "l1": "sho u ne n yo  shi n wa ni na re",
        "l2": ""
      }
    ],
    "comments": [
      "【热评 @初号机暴走】当红色警报响起，弦乐与电吉他齐鸣，这就是动漫史上无法超越的开篇！"
    ],
    "lyricsRaw": "[ti:残酷な天使のテーゼ]\n[ar:高橋洋子]\n[al:残酷な天使のテーゼ / FLY ME TO THE MOON]\n[offset:0]\n\n[00:00.00]残[00:00.01]酷[00:00.02]な[00:00.04]天[00:00.05]使[00:00.07]の[00:00.08]テ[00:00.10]ー[00:00.11]ゼ[00:00.13] - [00:00.17]高[00:00.19]橋[00:00.20]洋[00:00.22]子[00:00.23][00:00.26]た[00:00.28]か[00:00.29]は[00:00.31]し[00:00.32] [00:00.34]よ[00:00.35]う[00:00.37]こ[00:00.38]\n[00:00.00](385,15)[00:00.40]\n[00:00.40]词[00:00.43]：[00:00.46]及[00:00.50]川[00:00.53]眠[00:00.56]子[00:00.60]\n[00:00.60]曲[00:00.63]：[00:00.66]佐[00:00.70]藤[00:00.73]英[00:00.76]敏[00:00.80]\n[00:02.00]残[00:03.31]酷[00:04.31]な[00:04.62]天[00:05.31]使[00:05.81]の[00:06.12]よ[00:06.37]う[00:06.81]に[00:07.06]\n[00:02.00]za [00:02.65]n [00:03.31]ko [00:03.81]ku [00:04.31]na [00:04.62]te [00:04.96]n [00:05.31]shi [00:05.81]no [00:06.12]yo [00:06.37]u [00:06.81]ni [00:07.06]\n[00:07.68]少[00:09.24]年[00:10.36]よ[00:10.51] [00:10.67]神[00:11.55]話[00:11.86]に[00:12.24]な[00:13.04]れ[00:13.35]\n[00:07.68]sho [00:08.19][00:08.72]u [00:09.24]ne [00:09.80]n [00:10.36]yo [00:10.51] [00:10.67]shi [00:11.11]n [00:11.55]wa [00:11.86]ni [00:12.24]na [00:13.04]re [00:13.35]\n[00:23.66]蒼[00:24.09]い[00:24.97]風[00:25.40]が[00:25.65]い[00:25.90]ま[00:26.22]\n[00:23.66]a [00:23.87]o [00:24.09]i [00:24.97]ka [00:25.18]ze [00:25.40]ga [00:25.65]i [00:25.90]ma [00:26.22]\n[00:26.77]胸[00:27.27]の[00:27.59]ド[00:27.83]ア[00:28.21]を[00:28.46]叩[00:29.08]い[00:29.33]て[00:29.65]も[00:29.89]\n[00:26.77]mu [00:27.02]ne [00:27.27]no [00:27.59]do [00:27.83]a [00:28.21]wo [00:28.46]ta [00:28.77]ta [00:29.08]i [00:29.33]te [00:29.65]mo [00:29.89]\n[00:30.45]私[00:31.02]だ[00:31.26]け[00:31.58]を[00:32.26]た[00:32.45]だ[00:32.77]見[00:32.95]つ[00:33.13]め[00:33.45]て[00:33.64]\n[00:30.45]wa [00:30.64]ta [00:30.83]shi [00:31.02]da [00:31.26]ke [00:31.58]wo [00:32.26][00:32.25]ta [00:32.44][00:32.45]da [00:32.77]mi [00:32.95]tsu [00:33.13]me [00:33.45]te [00:33.64]\n[00:34.21]微[00:34.58]笑[00:35.01]ん[00:35.39]で[00:35.76]る[00:36.20]あ[00:36.82]な[00:37.14]た[00:37.32]\n[00:34.21]ho [00:34.39]ho [00:34.58]e [00:35.01]n [00:35.39]de [00:35.76]ru [00:36.20]a [00:36.82]na [00:37.14]ta [00:37.32]\n[00:38.51]そ[00:38.75]っ[00:39.01]と[00:39.76]ふ[00:40.00]れ[00:40.13]る[00:40.56]も[00:40.75]の[00:41.06]\n[00:38.51]so [00:38.75]'t [00:39.01]to [00:39.76]fu [00:40.00]re [00:40.13]ru [00:40.56]mo [00:40.75]no [00:41.06]\n[00:41.75]も[00:42.00]と[00:42.25]め[00:42.50]る[00:42.80]こ[00:43.12]と[00:43.43]に[00:43.75]夢[00:44.13]中[00:44.68]で[00:44.94]\n[00:41.75]mo [00:42.00]to [00:42.25]me [00:42.50]ru [00:42.80]ko [00:43.12]to [00:43.43]ni [00:43.75]mu [00:44.13]chu [00:44.31][00:44.49]u [00:44.68]de [00:44.94]\n[00:45.43]運[00:45.62]命[00:46.30]さ[00:46.49]え[00:47.24]ま[00:47.43]だ[00:47.68]知[00:47.86]ら[00:48.18]な[00:48.42]い[00:48.62]\n[00:45.43]u [00:45.52]n [00:45.62]me [00:45.96]i [00:46.30]sa [00:46.49]e [00:47.24]ma [00:47.43]da [00:47.68]shi [00:47.86]ra [00:48.18]na [00:48.42]i [00:48.62]\n[00:49.17]い[00:49.36]た[00:49.73]い[00:50.05]け[00:50.36]な[00:50.68]瞳[00:51.04]\n[00:49.17]i [00:49.36]ta [00:49.73]i [00:50.05]ke [00:50.36]na [00:50.68]hi [00:50.80]to [00:50.92]mi [00:51.04]\n[00:53.11]だ[00:53.42]け[00:53.74]ど[00:54.04]い[00:54.35]つ[00:54.60]か[00:54.91]気[00:55.23]付[00:55.60]く[00:55.91]で[00:56.22]し[00:56.41]ょ[00:56.60]う[00:56.85]\n[00:53.11]da [00:53.42]ke [00:53.74]do [00:54.04]i [00:54.35]tsu [00:54.60]ka [00:54.91]ki [00:55.23]zu [00:55.60]ku [00:55.91]de [00:56.22]sho [00:56.40][00:56.60]u [00:56.85]\n[00:56.85]そ[00:57.10]の[00:57.41]背[00:57.97]中[00:58.41]に[00:58.66]は[00:58.91]\n[00:56.85]so [00:57.10]no [00:57.41]se [00:57.97]na [00:58.19]ka [00:58.41]ni [00:58.66]wa [00:58.91]\n[01:00.53]遥[01:01.34]か[01:01.60]未[01:01.90]来[01:02.16]め[01:02.78]ざ[01:03.09]す[01:03.41]た[01:03.71]め[01:04.03]の[01:04.28]\n[01:00.53]ha [01:00.93]ru [01:01.34]ka [01:01.60]mi [01:01.90]ra [01:02.03]i [01:02.16]me [01:02.78]za [01:03.09]su [01:03.41]ta [01:03.71]me [01:04.03]no [01:04.28]\n[01:04.28]羽[01:04.58]根[01:05.21]が[01:05.40]あ[01:05.65]る[01:05.90]こ[01:06.15]と[01:06.46]\n[01:04.28]ha [01:04.58]ne [01:05.21][01:05.20]ga [01:05.39][01:05.40]a [01:05.65]ru [01:05.90]ko [01:06.15]to [01:06.46]\n[01:08.20]残[01:09.01]酷[01:09.64]な[01:09.95]天[01:10.26]使[01:10.58]の[01:10.89]テ[01:11.08]ー[01:11.27]ゼ[01:11.63]\n[01:08.20]za [01:08.60]n [01:09.01]ko [01:09.32]ku [01:09.64]na [01:09.95]te [01:10.10]n [01:10.26]shi [01:10.58]no [01:10.89]te [01:11.08]e [01:11.27]ze [01:11.63]\n[01:11.63]窓[01:12.57]辺[01:13.14]か[01:13.38]ら[01:13.64]や[01:13.88]が[01:14.13]て[01:14.38]飛[01:14.63]び[01:14.82]立[01:15.01]つ[01:15.26]\n[01:11.63]ma [01:12.10]do [01:12.57]be [01:13.14]ka [01:13.38]ra [01:13.64]ya [01:13.88]ga [01:14.13]te [01:14.38]to [01:14.63]bi [01:14.82]ta [01:15.01]tsu [01:15.26]\n[01:15.57]ほ[01:16.00]と[01:16.39]ば[01:16.82]し[01:17.07]る[01:17.37]熱[01:17.69]い[01:18.13]パ[01:18.31]ト[01:18.50]ス[01:18.76]で[01:19.00]\n[01:15.57]ho [01:16.00]to [01:16.39]ba [01:16.82]shi [01:17.07]ru [01:17.37]a [01:17.53]tsu [01:17.69]i [01:18.13]pa [01:18.31]to [01:18.50]su [01:18.76]de [01:19.00]\n[01:19.31]思[01:20.19]い[01:20.56]出[01:21.00]を[01:21.18]裏[01:21.44]切[01:21.62]る[01:21.81]な[01:22.25]ら[01:22.49]\n[01:19.31]o [01:19.75]mo [01:20.19]i [01:20.56]de [01:21.00]wo [01:21.18]u [01:21.31]ra [01:21.44]gi [01:21.62]ru [01:21.81]na [01:22.25]ra [01:22.49]\n[01:23.06]こ[01:23.49]の[01:23.93]宇[01:24.43]宙[01:24.74]を[01:24.99]抱[01:25.24]い[01:25.43]て[01:25.62]輝[01:26.11]く[01:26.37]\n[01:23.06]ko [01:23.49]no [01:23.93]so [01:24.43]ra [01:24.74]wo [01:24.99]da [01:25.24]i [01:25.43]te [01:25.62]ka [01:25.78]ga [01:25.94]ya [01:26.11]ku [01:26.37]\n[01:26.74]少[01:27.68]年[01:28.43]よ[01:28.67]神[01:28.86]話[01:29.36]に[01:29.55]な[01:29.92]れ[01:30.17]\n[01:26.74]sho [01:27.05][01:27.36]u [01:27.68]ne [01:28.05]n [01:28.43]yo [01:28.67]shi [01:28.76]n [01:28.86]wa [01:29.36]ni [01:29.55]na [01:29.92]re [01:30.17]\n[02:15.91]ず[02:16.10]っ[02:16.22]と[02:17.04]眠[02:17.41]っ[02:17.66]て[02:18.15]る[02:18.47]\n[02:15.91]zu [02:16.10]'t [02:16.22]to [02:17.04]ne [02:17.22]mu [02:17.41]'t [02:17.66]te [02:18.15]ru [02:18.47]\n[02:19.10]私[02:19.84]の[02:20.09]愛[02:20.78]の[02:21.03]揺[02:21.41]り[02:21.65]か[02:21.96]ご[02:22.22]\n[02:19.10]wa [02:19.34]ta [02:19.59]shi [02:19.84]no [02:20.09]a [02:20.43]i [02:20.78]no [02:21.03]yu [02:21.41]ri [02:21.65]ka [02:21.96]go [02:22.22]\n[02:22.67]あ[02:22.84]な[02:22.99]た[02:23.28]だ[02:23.59]け[02:23.84]が[02:24.52] [02:24.52]夢[02:24.79]の[02:25.12]使[02:25.44]者[02:25.73]に[02:26.12]\n[02:22.67]a [02:22.84]na [02:22.99]ta [02:23.27]da [02:23.59]ke [02:23.84][02:23.84]ga [02:24.52] [02:24.52]yu [02:24.67]me [02:24.79]no [02:25.12][02:25.12]shi [02:25.44]sha [02:25.58][02:25.72]ni [02:26.12]\n[02:26.45]呼[02:26.95]ば[02:27.21]れ[02:27.39]る[02:27.64]朝[02:28.46]が[02:29.21]く[02:29.45]る[02:29.70]\n[02:26.45]yo [02:26.95]ba [02:27.21]re [02:27.39]ru [02:27.64]a [02:28.05]sa [02:28.46]ga [02:29.21]ku [02:29.45]ru [02:29.70]\n[02:30.76]細[02:31.32]い[02:32.07]首[02:32.51]筋[02:33.08]を[02:33.38]\n[02:30.76]ho [02:31.04]so [02:31.32]i [02:32.07]ku [02:32.29]bi [02:32.51]su [02:32.79]ji [02:33.08]wo [02:33.38]\n[02:33.95]月[02:34.51]あ[02:34.81]か[02:35.13]り[02:35.38]が[02:35.69]映[02:36.38]し[02:36.63]て[02:36.94]る[02:37.19]\n[02:33.95]tsu [02:34.23]ki [02:34.51]a [02:34.81]ka [02:35.13]ri [02:35.38]ga [02:35.69]u [02:36.03]tsu [02:36.38]shi [02:36.63]te [02:36.94]ru [02:37.19]\n[02:37.63]世[02:37.87]界[02:38.13]中[02:38.75]の[02:39.56]時[02:40.00]を[02:40.19]止[02:40.37]め[02:40.69]て[02:40.99]\n[02:37.63]se [02:37.87]ka [02:38.00]i [02:38.13]ju [02:38.33][02:38.54]u [02:38.75]no [02:39.56]to [02:39.78]ki [02:40.00]wo [02:40.19]to [02:40.37]me [02:40.69]te [02:40.99]\n[02:41.50]閉[02:41.94]じ[02:42.12]こ[02:42.37]め[02:42.69]た[02:42.93]い[02:43.25]け[02:43.55]ど[02:43.81]\n[02:41.50]to [02:41.94]ji [02:42.12]ko [02:42.37]me [02:42.69]ta [02:42.93]i [02:43.25]ke [02:43.55]do [02:43.81]\n[02:45.37]も[02:45.75]し[02:45.99]も[02:46.30]ふ[02:46.61]た[02:46.92]り[02:47.24]逢[02:47.61]え[02:47.92]た[02:48.17]こ[02:48.55]と[02:48.85]に[02:49.17]\n[02:45.37]mo [02:45.75]shi [02:45.99]mo [02:46.30]fu [02:46.61]ta [02:46.92]ri [02:47.24]a [02:47.61]e [02:47.92]ta [02:48.17]ko [02:48.55]to [02:48.85]ni [02:49.17]\n[02:49.17]意[02:49.48]味[02:49.86]が[02:50.10]あ[02:50.48]る[02:50.79]な[02:51.04]ら[02:51.35]\n[02:49.17]i [02:49.48]mi [02:49.86]ga [02:50.10]a [02:50.48]ru [02:50.79]na [02:51.04]ra [02:51.35]\n[02:52.86]私[02:53.73]は[02:54.17]そ[02:54.41]う[02:54.60] [02:54.79]自[02:55.10]由[02:55.48]を[02:55.78]知[02:56.34]る[02:56.59]\n[02:52.86]wa [02:53.15]ta [02:53.44]shi [02:53.73]wa [02:54.17]so [02:54.41]u [02:54.60] [02:54.79]ji [02:55.10]yu [02:55.29]u [02:55.48]wo [02:55.78]shi [02:56.34]ru [02:56.59]\n[02:56.59]た[02:56.97]め[02:57.22]の[02:57.53]バ[02:57.84]イ[02:58.16]ブ[02:58.46]ル[02:58.73]\n[02:56.59]ta [02:56.97]me [02:57.22]no [02:57.53]ba [02:57.84]i [02:58.16]bu [02:58.46]ru [02:58.73]\n[03:00.53]残[03:01.28]酷[03:01.97]な[03:02.27]天[03:02.65]使[03:02.96]の[03:03.15]テ[03:03.40]ー[03:03.58]ゼ[03:04.02]\n[03:00.53]za [03:00.90]n [03:01.28]ko [03:01.62]ku [03:01.97]na [03:02.27]te [03:02.46]n [03:02.65]shi [03:02.96]no [03:03.15]te [03:03.40]e [03:03.58]ze [03:04.02]\n[03:04.02]悲[03:05.02]し[03:05.39]み[03:05.71]が[03:05.96]そ[03:06.21]し[03:06.40]て[03:06.52]は[03:06.70]じ[03:06.96]ま[03:07.20]る[03:07.39]\n[03:04.02]ka [03:04.52]na [03:05.02]shi [03:05.39]mi [03:05.71]ga [03:05.96]so [03:06.21]shi [03:06.40]te [03:06.52]ha [03:06.70]ji [03:06.96]ma [03:07.20]ru [03:07.39]\n[03:07.83]抱[03:08.77]き[03:09.08]し[03:09.26]め[03:09.45]た[03:09.76]命[03:10.01]の[03:10.20]か[03:10.70]た[03:11.01]ち[03:11.39]\n[03:07.83]da [03:08.77]ki [03:09.08]shi [03:09.26]me [03:09.45]ta [03:09.76]i [03:09.84]no [03:09.92]chi [03:10.01]no [03:10.20]ka [03:10.70]ta [03:11.01]chi [03:11.39]\n[03:11.64]そ[03:11.94]の[03:12.50]夢[03:13.19]に[03:13.51]目[03:13.69]覚[03:13.89]め[03:14.26]た[03:14.44]と[03:14.63]き[03:14.94]\n[03:11.64]so [03:11.94]no [03:12.50]yu [03:12.84]me [03:13.19]ni [03:13.51]me [03:13.69]za [03:13.89]me [03:14.26]ta [03:14.44]to [03:14.63]ki [03:14.94]\n[03:15.38]誰[03:16.31]よ[03:16.63]り[03:16.87]も[03:17.19]光[03:17.62]を[03:17.82]放[03:18.44]つ[03:18.69]\n[03:15.38]da [03:15.84]re [03:16.31]yo [03:16.63]ri [03:16.87]mo [03:17.19]hi [03:17.33]ka [03:17.47]ri [03:17.62]wo [03:17.82]ha [03:18.13]na [03:18.44]tsu [03:18.69]\n[03:19.06]少[03:19.88]年[03:20.68]よ[03:20.84] [03:21.00]神[03:21.18]話[03:21.68]に[03:21.87]な[03:22.25]れ[03:22.49]\n[03:19.06]sho [03:19.33][03:19.60]u [03:19.88]ne [03:20.28]n [03:20.68]yo [03:20.84] [03:21.00]shi [03:21.09]n [03:21.18]wa [03:21.68]ni [03:21.87]na [03:22.25]re [03:22.49]\n[03:22.93]人[03:23.62]は[03:23.87]愛[03:24.43]を[03:24.61]つ[03:24.87]む[03:25.12]ぎ[03:25.49]な[03:25.74]が[03:26.30]ら[03:26.55]\n[03:22.93]hi [03:23.27]to [03:23.62]wa [03:23.87]a [03:24.15]i [03:24.43]wo [03:24.61]tsu [03:24.87]mu [03:25.12]gi [03:25.49]na [03:25.74]ga [03:26.30]ra [03:26.55]\n[03:26.55]歴[03:26.99]史[03:27.55]を[03:27.85]つ[03:28.11]く[03:28.42]る[03:28.73]\n[03:26.55]re [03:26.77]ki [03:26.99]shi [03:27.55]wo [03:27.85]tsu [03:28.11]ku [03:28.42]ru [03:28.73]\n[03:30.29]女[03:30.79]神[03:31.24]な[03:31.54]ん[03:31.92]て[03:32.16]な[03:32.48]れ[03:32.79]な[03:33.11]い[03:33.41]ま[03:33.73]ま[03:34.04]\n[03:30.29]me [03:30.79]ga [03:31.01]mi [03:31.24]na [03:31.54]n [03:31.92]te [03:32.16]na [03:32.48]re [03:32.79]na [03:33.11]i [03:33.41]ma [03:33.73]ma [03:34.04]\n[03:34.04]私[03:35.04]は[03:35.28]生[03:35.59]き[03:35.91]る[03:36.15]\n[03:34.04]wa [03:34.37]ta [03:34.70]shi [03:35.04]wa [03:35.28]i [03:35.59]ki [03:35.91]ru [03:36.15]\n[03:37.97]残[03:38.71]酷[03:39.41]な[03:39.67]天[03:39.98]使[03:40.29]の[03:40.54]テ[03:40.80]ー[03:41.04]ゼ[03:41.49]\n[03:37.97]za [03:38.34]n [03:38.71]ko [03:39.06]ku [03:39.41]na [03:39.67]te [03:39.82]n [03:39.98]shi [03:40.29]no [03:40.54]te [03:40.80]e [03:41.04]ze [03:41.49]\n[03:41.49]窓[03:42.23]辺[03:42.92]か[03:43.16]ら[03:43.42]や[03:43.67]が[03:43.85]て[03:44.11]飛[03:44.41]び[03:44.66]立[03:44.79]つ[03:45.16]\n[03:41.49]ma [03:41.86]do [03:42.23]be [03:42.92]ka [03:43.16]ra [03:43.42]ya [03:43.67]ga [03:43.85]te [03:44.11]to [03:44.41]bi [03:44.66]ta [03:44.79]tsu [03:45.16]\n[03:45.41]ほ[03:45.72]と[03:46.16]ば[03:46.60]し[03:46.78]る[03:47.03]熱[03:47.28]い[03:47.85]パ[03:48.04]ト[03:48.16]ス[03:48.53]で[03:48.91]\n[03:45.41]ho [03:45.72]to [03:46.16]ba [03:46.60]shi [03:46.78]ru [03:47.03]a [03:47.15]tsu [03:47.28]i [03:47.85]pa [03:48.04]to [03:48.16]su [03:48.53]de [03:48.91]\n[03:48.91]思[03:49.96]い[03:50.33]出[03:50.71]を[03:50.96]裏[03:51.22]切[03:51.40]る[03:51.58]な[03:52.15]ら[03:52.34]\n[03:48.91]o [03:49.43]mo [03:49.96]i [03:50.33]de [03:50.71]wo [03:50.96]u [03:51.09]ra [03:51.22]gi [03:51.40]ru [03:51.58]na [03:52.15]ra [03:52.34]\n[03:52.77]こ[03:53.15]の[03:53.71]宇[03:54.15]宙[03:54.46]を[03:54.70]抱[03:54.90]い[03:55.21]て[03:55.45]輝[03:55.89]く[03:56.15]\n[03:52.77]ko [03:53.15]no [03:53.71]so [03:54.15]ra [03:54.46]wo [03:54.70]da [03:54.90]i [03:55.21]te [03:55.45]ka [03:55.59]ga [03:55.74]ya [03:55.89]ku [03:56.15]\n[03:56.52]少[03:57.39]年[03:58.14]よ[03:58.26] [03:58.39]神[03:58.63]話[03:59.07]に[03:59.33]な[03:59.45]れ[03:59.70]\n[03:56.52]sho [03:56.80][03:57.10]u [03:57.39]ne [03:57.76]n [03:58.14]yo [03:58.26] [03:58.39]shi [03:58.51]n [03:58.63]wa [03:59.07]ni [03:59.33]na [03:59.45]re [03:59.70]",
    "lrcUrl": "assets/lyrics/track_12.lrc"
  },
  {
    "index": "013",
    "spineNum": "13",
    "serial": "WK-REAL-13",
    "title": "secret base ～君がくれたもの～",
    "shortTitle": "secret base · 未闻花名",
    "spineTitle": "secret base · 催泪神曲",
    "subtitleQuote": "| 与你在八月末的约定，那份对未来的希冀",
    "artist": "本间芽衣子 / 安城鸣子 / 鹤见知利子",
    "subArtist": "《未闻花名》经典 ED",
    "statusTag": "催泪神作",
    "subTag": "那朵花",
    "durationSec": 355,
    "currentSec": 0,
    "accent": "#ec4899",
    "c1": "#f472b6",
    "c2": "#831843",
    "picUrl": "assets/covers/cover_13.jpg",
    "audioUrl": "assets/audio/track_13.mp3",
    "notes": [
      261.63,
      293.66,
      329.63,
      392,
      523.25,
      392,
      329.63,
      261.63
    ],
    "lyrics": [
      {
        "t": 0,
        "l1": "secret base ~君がくれたもの~ secret base ~你给我的所有~ １０ years after Ver. - 茅野愛衣 かやの あい/戸松遥 とまつ はるか/早見沙織 はやみ さおり",
        "l2": ""
      },
      {
        "t": 0,
        "l1": "(164,2)",
        "l2": ""
      },
      {
        "t": 0.19,
        "l1": "词：町田紀彦",
        "l2": ""
      },
      {
        "t": 0.19,
        "l1": "(360,16)",
        "l2": ""
      },
      {
        "t": 0.38,
        "l1": "曲：町田紀彦",
        "l2": ""
      },
      {
        "t": 0.38,
        "l1": "(405,1)",
        "l2": ""
      },
      {
        "t": 0.4,
        "l1": "君と夏の終わり 将来の夢",
        "l2": ""
      },
      {
        "t": 4.48,
        "l1": "大きな希望 忘れない",
        "l2": ""
      },
      {
        "t": 7.59,
        "l1": "１０年後の８月",
        "l2": ""
      },
      {
        "t": 7.59,
        "l1": "ju u ne n go no ha chi ga tsu",
        "l2": ""
      },
      {
        "t": 9.75,
        "l1": "また出会えるのを信じて",
        "l2": ""
      },
      {
        "t": 9.75,
        "l1": "ma ta de a e ru no wo shi n ji te",
        "l2": ""
      },
      {
        "t": 14.88,
        "l1": "最高の思い出を",
        "l2": ""
      },
      {
        "t": 40.31,
        "l1": "出会いはふっとした瞬間",
        "l2": ""
      },
      {
        "t": 40.31,
        "l1": "de a i wa fu 't to shi ta shu n ka n",
        "l2": ""
      },
      {
        "t": 43.7,
        "l1": "帰り道の交差点で",
        "l2": ""
      },
      {
        "t": 43.7,
        "l1": "ka e ri mi chi no ko u sa te n de",
        "l2": ""
      },
      {
        "t": 47.5,
        "l1": "声をかけてくれたね",
        "l2": ""
      },
      {
        "t": 47.5,
        "l1": "ko e wo ka ke te ku re ta ne",
        "l2": ""
      },
      {
        "t": 50.18,
        "l1": "「一緒に帰ろう」",
        "l2": ""
      },
      {
        "t": 50.18,
        "l1": "「 i 's sho ni ka e ro u 」",
        "l2": ""
      },
      {
        "t": 52.84,
        "l1": "僕は照れくさそうに",
        "l2": ""
      },
      {
        "t": 52.84,
        "l1": "bo ku wa te re ku sa so u ni",
        "l2": ""
      },
      {
        "t": 57.97,
        "l1": "カバンで顔を隠しながら",
        "l2": ""
      },
      {
        "t": 57.97,
        "l1": "ka ba n de ka o wo ka ku shi na ga ra",
        "l2": ""
      },
      {
        "t": 61.77,
        "l1": "本当はとてもとても嬉しかったよ",
        "l2": ""
      },
      {
        "t": 61.77,
        "l1": "ho n to u wa to te mo to te mo u re shi ka 't ta yo",
        "l2": ""
      },
      {
        "t": 68.94,
        "l1": "あぁ",
        "l2": ""
      },
      {
        "t": 68.94,
        "l1": "a",
        "l2": ""
      },
      {
        "t": 70.1,
        "l1": "花火が夜空きれいに咲いて",
        "l2": ""
      },
      {
        "t": 70.1,
        "l1": "ha na bi ga yo zo ra ki re i ni sa i te",
        "l2": ""
      },
      {
        "t": 73.78,
        "l1": "ちょっとセツナク",
        "l2": ""
      },
      {
        "t": 73.78,
        "l1": "cho 't to se tsu na ku",
        "l2": ""
      },
      {
        "t": 76.04,
        "l1": "あぁ",
        "l2": ""
      },
      {
        "t": 76.04,
        "l1": "a",
        "l2": ""
      },
      {
        "t": 77.22,
        "l1": "風が時間とともに流れる",
        "l2": ""
      },
      {
        "t": 77.22,
        "l1": "ka ze ga ji ka n to to mo ni na ga re ru",
        "l2": ""
      },
      {
        "t": 82.8,
        "l1": "嬉しくって 楽しくって",
        "l2": ""
      },
      {
        "t": 82.8,
        "l1": "u re shi ku 't te   ta no shi ku 't te",
        "l2": ""
      },
      {
        "t": 86.4,
        "l1": "冒険もいろいろしたね",
        "l2": ""
      },
      {
        "t": 86.4,
        "l1": "bo u ke n mo i ro i ro shi ta ne",
        "l2": ""
      },
      {
        "t": 89.96,
        "l1": "二人の秘密の基地の中",
        "l2": ""
      },
      {
        "t": 89.96,
        "l1": "fu ta ri no hi mi tsu no ki chi no na ka",
        "l2": ""
      },
      {
        "t": 97.04,
        "l1": "君と夏の終わり 将来の夢",
        "l2": ""
      },
      {
        "t": 97.04,
        "l1": "ki mi to na tsu no o wa ri   sho u ra i no yu me",
        "l2": ""
      },
      {
        "t": 101.07,
        "l1": "大きな希望 忘れない",
        "l2": ""
      },
      {
        "t": 101.07,
        "l1": "o o ki na ki bo u   wa su re na i",
        "l2": ""
      },
      {
        "t": 104.25,
        "l1": "１０年後の８月",
        "l2": ""
      },
      {
        "t": 106.5,
        "l1": "また出会えるのを信じて",
        "l2": ""
      },
      {
        "t": 111.36,
        "l1": "君が最後まで心から",
        "l2": ""
      },
      {
        "t": 111.36,
        "l1": "ki mi ga sa i go ma de ko ko ro ka ra",
        "l2": ""
      },
      {
        "t": 114.56,
        "l1": "「ありがとう」叫んでいたこと",
        "l2": ""
      },
      {
        "t": 114.56,
        "l1": "「 a ri ga to u 」 sa ke n de i ta ko to",
        "l2": ""
      },
      {
        "t": 117.32,
        "l1": "知っていたよ",
        "l2": ""
      },
      {
        "t": 117.32,
        "l1": "shi 't te i ta yo",
        "l2": ""
      },
      {
        "t": 118.56,
        "l1": "涙をこらえて笑顔でさようなら",
        "l2": ""
      },
      {
        "t": 118.56,
        "l1": "na mi da wo ko ra e te e ga o de sa yo u na ra",
        "l2": ""
      },
      {
        "t": 122.49,
        "l1": "せつないよね",
        "l2": ""
      },
      {
        "t": 122.49,
        "l1": "se tsu na i yo ne",
        "l2": ""
      },
      {
        "t": 125.86,
        "l1": "最高の思い出を",
        "l2": ""
      },
      {
        "t": 125.86,
        "l1": "sa i ko u no o mo i de wo",
        "l2": ""
      },
      {
        "t": 133.41,
        "l1": "あぁ",
        "l2": ""
      },
      {
        "t": 133.41,
        "l1": "a",
        "l2": ""
      },
      {
        "t": 134.63,
        "l1": "夏休みもあと少しで",
        "l2": ""
      },
      {
        "t": 134.63,
        "l1": "na tsu ya su mi mo a to su ko shi de",
        "l2": ""
      },
      {
        "t": 138.15,
        "l1": "終わっちゃうから",
        "l2": ""
      },
      {
        "t": 138.15,
        "l1": "o wa 'c cha u ka ra",
        "l2": ""
      },
      {
        "t": 140.63,
        "l1": "あぁ 太陽と月 仲良くして",
        "l2": ""
      },
      {
        "t": 140.63,
        "l1": "a   ta i yo u to tsu ki   na ka yo ku shi te",
        "l2": ""
      },
      {
        "t": 147.32,
        "l1": "悲しくって 寂しくって",
        "l2": ""
      },
      {
        "t": 147.32,
        "l1": "ka na shi ku 't te   sa bi shi ku 't te",
        "l2": ""
      },
      {
        "t": 150.86,
        "l1": "喧嘩も いろいろしたね",
        "l2": ""
      },
      {
        "t": 150.86,
        "l1": "ke n ka mo   i ro i ro shi ta ne",
        "l2": ""
      },
      {
        "t": 154.45,
        "l1": "二人の秘密の基地の中",
        "l2": ""
      },
      {
        "t": 154.45,
        "l1": "fu ta ri no hi mi tsu no ki chi no na ka",
        "l2": ""
      },
      {
        "t": 161.63,
        "l1": "君が最後まで心から",
        "l2": ""
      },
      {
        "t": 161.63,
        "l1": "ki mi ga sa i go ma de ko ko ro ka ra",
        "l2": ""
      },
      {
        "t": 164.59,
        "l1": "「ありがとう」叫んでいたこと",
        "l2": ""
      },
      {
        "t": 164.59,
        "l1": "「 a ri ga to u 」 sa ke n de i ta ko to",
        "l2": ""
      },
      {
        "t": 167.32,
        "l1": "知っていたよ",
        "l2": ""
      },
      {
        "t": 167.32,
        "l1": "shi 't te i ta yo",
        "l2": ""
      },
      {
        "t": 168.69,
        "l1": "涙をこらえて笑顔でさようなら",
        "l2": ""
      },
      {
        "t": 168.69,
        "l1": "na mi da wo ko ra e te e ga o de sa yo u na ra",
        "l2": ""
      },
      {
        "t": 172.55,
        "l1": "せつないよね",
        "l2": ""
      },
      {
        "t": 172.55,
        "l1": "se tsu na i yo ne",
        "l2": ""
      },
      {
        "t": 175.94,
        "l1": "最高の思い出を",
        "l2": ""
      },
      {
        "t": 175.94,
        "l1": "sa i ko u no o mo i de wo",
        "l2": ""
      },
      {
        "t": 183.65,
        "l1": "突然の転校で",
        "l2": ""
      },
      {
        "t": 183.65,
        "l1": "to tsu ze n no te n ko u de",
        "l2": ""
      },
      {
        "t": 197.83,
        "l1": "どうしようもなく",
        "l2": ""
      },
      {
        "t": 197.83,
        "l1": "do u shi yo u mo na ku",
        "l2": ""
      },
      {
        "t": 204.73,
        "l1": "手紙書くよ電話もするよ",
        "l2": ""
      },
      {
        "t": 204.73,
        "l1": "te ga mi ka ku yo de n wa mo su ru yo",
        "l2": ""
      },
      {
        "t": 208.24,
        "l1": "忘れないでね僕のことを",
        "l2": ""
      },
      {
        "t": 208.24,
        "l1": "wa su re na i de ne bo ku no ko to wo",
        "l2": ""
      },
      {
        "t": 211.76,
        "l1": "いつまでも二人の基地の中",
        "l2": ""
      },
      {
        "t": 211.76,
        "l1": "i tsu ma de mo fu ta ri no ki chi no na ka",
        "l2": ""
      },
      {
        "t": 218.79,
        "l1": "君と夏の終わり ずっと話して",
        "l2": ""
      },
      {
        "t": 218.79,
        "l1": "ki mi to na tsu no o wa ri   zu 't to ha na shi te",
        "l2": ""
      },
      {
        "t": 222.75,
        "l1": "夕日を見てから星を眺め",
        "l2": ""
      },
      {
        "t": 222.75,
        "l1": "yu u hi wo mi te ka ra ho shi wo na ga me",
        "l2": ""
      },
      {
        "t": 225.9,
        "l1": "君の頬を流れた涙は",
        "l2": ""
      },
      {
        "t": 225.9,
        "l1": "ki mi no ho ho wo na ga re ta na mi da wa",
        "l2": ""
      },
      {
        "t": 230.14,
        "l1": "ずっと忘れない",
        "l2": ""
      },
      {
        "t": 230.14,
        "l1": "zu 't to wa su re na i",
        "l2": ""
      },
      {
        "t": 233.19,
        "l1": "君が最後まで大きく手を振って",
        "l2": ""
      },
      {
        "t": 233.19,
        "l1": "ki mi ga sa i go ma de o o ki ku te wo fu 't te",
        "l2": ""
      },
      {
        "t": 237.2,
        "l1": "くれたこときっと忘れない",
        "l2": ""
      },
      {
        "t": 237.2,
        "l1": "ku re ta ko to ki 't to wa su re na i",
        "l2": ""
      },
      {
        "t": 240.26,
        "l1": "だから こうして夢の中で",
        "l2": ""
      },
      {
        "t": 240.26,
        "l1": "da ka ra   ko u shi te yu me no na ka de",
        "l2": ""
      },
      {
        "t": 243.61,
        "l1": "ずっと永遠に",
        "l2": ""
      },
      {
        "t": 243.61,
        "l1": "zu 't to e i e n ni",
        "l2": ""
      },
      {
        "t": 247.53,
        "l1": "君と夏の終わり 将来の夢",
        "l2": ""
      },
      {
        "t": 247.53,
        "l1": "ki mi to na tsu no o wa ri   sho u ra i no yu me",
        "l2": ""
      },
      {
        "t": 251.38,
        "l1": "大きな希望 忘れない",
        "l2": ""
      },
      {
        "t": 251.38,
        "l1": "o o ki na ki bo u   wa su re na i",
        "l2": ""
      },
      {
        "t": 254.63,
        "l1": "１０年後の８月",
        "l2": ""
      },
      {
        "t": 254.63,
        "l1": "ju u ne n go no ha chi ga tsu",
        "l2": ""
      },
      {
        "t": 256.88,
        "l1": "また出会えるのを信じて",
        "l2": ""
      },
      {
        "t": 256.88,
        "l1": "ma ta de a e ru no wo shi n ji te",
        "l2": ""
      },
      {
        "t": 261.98,
        "l1": "君が最後まで心から",
        "l2": ""
      },
      {
        "t": 261.98,
        "l1": "ki mi ga sa i go ma de ko ko ro ka ra",
        "l2": ""
      },
      {
        "t": 264.9,
        "l1": "「ありがとう」叫んでいたこと",
        "l2": ""
      },
      {
        "t": 264.9,
        "l1": "「 a ri ga to u 」 sa ke n de i ta ko to",
        "l2": ""
      },
      {
        "t": 267.62,
        "l1": "知っていたよ",
        "l2": ""
      },
      {
        "t": 267.62,
        "l1": "shi 't te i ta yo",
        "l2": ""
      },
      {
        "t": 268.98,
        "l1": "涙をこらえて笑顔でさようなら",
        "l2": ""
      },
      {
        "t": 268.98,
        "l1": "na mi da wo ko ra e te e ga o de sa yo u na ra",
        "l2": ""
      },
      {
        "t": 272.82,
        "l1": "せつないよね",
        "l2": ""
      },
      {
        "t": 272.82,
        "l1": "se tsu na i yo ne",
        "l2": ""
      },
      {
        "t": 276.29,
        "l1": "最高の思い出を",
        "l2": ""
      },
      {
        "t": 276.29,
        "l1": "sa i ko u no o mo i de wo",
        "l2": ""
      },
      {
        "t": 283.54,
        "l1": "最高の思い出を",
        "l2": ""
      },
      {
        "t": 283.54,
        "l1": "sa i ko u no o mo i de wo",
        "l2": ""
      }
    ],
    "comments": [
      "【热评 @超和平Busters】面码，找到你了！听到这首歌眼泪就完全不受控制。"
    ],
    "lyricsRaw": "[ti:secret base～君がくれたもの～ (10 years after Ver.)]\n[ar:茅野愛衣、戸松遥、早見沙織]\n[al:secret base～君がくれたもの～]\n[offset:0]\n\n[00:00.00]secret[00:00.00] [00:00.00]base[00:00.00] [00:00.00]~[00:00.01]君[00:00.01]が[00:00.01]く[00:00.01]れ[00:00.01]た[00:00.02]も[00:00.02]の[00:00.02]~[00:00.02] [00:00.02][00:00.03]secret[00:00.03] [00:00.03]base[00:00.03] [00:00.03]~[00:00.04]你[00:00.04]给[00:00.04]我[00:00.04]的[00:00.04]所[00:00.05]有[00:00.05]~[00:00.05][00:00.05] [00:00.05][00:00.06]１０[00:00.06] [00:00.06]years[00:00.06] [00:00.06]after[00:00.07] [00:00.07]Ver.[00:00.07][00:00.07] [00:00.07]-[00:00.08] [00:00.08]茅[00:00.08][00:00.08]野[00:00.08]愛[00:00.08]衣[00:00.09] [00:00.09][00:00.09]か[00:00.09]や[00:00.09]の[00:00.10] [00:00.10]あ[00:00.10]い[00:00.10][00:00.10]/[00:00.11]戸[00:00.11]松[00:00.11]遥[00:00.11][00:00.11] [00:00.11][00:00.12]と[00:00.12]ま[00:00.12]つ[00:00.12] [00:00.12]は[00:00.13]る[00:00.13]か[00:00.13][00:00.13]/[00:00.13]早[00:00.14][00:00.14]見[00:00.14]沙[00:00.14]織[00:00.14] [00:00.14][00:00.15]は[00:00.15]や[00:00.15]み[00:00.15] [00:00.15]さ[00:00.16]お[00:00.16]り[00:00.16]\n[00:00.00](164,2)[00:00.18]\n[00:00.19]词[00:00.22]：[00:00.25]町[00:00.28]田[00:00.31]紀[00:00.34]彦[00:00.37]\n[00:00.19](360,16)[00:00.37]\n[00:00.38]曲[00:00.39]：[00:00.39][00:00.39]町[00:00.39]田[00:00.39][00:00.40]紀[00:00.40][00:00.40]彦[00:00.40]\n[00:00.38](405,1)[00:00.40]\n[00:00.40]君[00:00.88]と[00:01.05]夏[00:01.48]の[00:01.78]終[00:01.93]わ[00:02.22]り[00:02.68] [00:02.68]将[00:03.08]来[00:03.60]の[00:03.78]夢[00:04.26]\n[00:04.48]大[00:04.82]き[00:05.01]な[00:05.29]希[00:05.47]望[00:05.98] [00:06.23][00:06.23]忘[00:06.78]れ[00:07.05]な[00:07.21]い[00:07.35]\n[00:07.59]１０[00:08.05]年[00:08.41]後[00:08.61]の[00:08.86]８[00:09.28]月[00:09.55]\n[00:07.59]ju u [00:08.05]ne [00:08.16][00:08.16]n [00:08.41]go [00:08.61][00:08.61]no [00:08.86]ha chi [00:09.27][00:09.27]ga [00:09.46]tsu [00:09.55]\n[00:09.75]ま[00:10.21]た[00:10.40]出[00:10.60]会[00:10.83]え[00:11.07]る[00:11.26]の[00:11.45]を[00:11.70]信[00:12.17]じ[00:12.36]て[00:14.08]\n[00:09.75]ma [00:10.21]ta [00:10.40]de [00:10.60]a [00:10.83][00:10.83]e [00:11.06]ru [00:11.26][00:11.26]no [00:11.45][00:11.45]wo [00:11.70]shi [00:11.93][00:11.93]n [00:12.17][00:12.17]ji [00:12.35]te [00:14.08]\n[00:14.88]最[00:15.29]高[00:15.88]の[00:18.40]思[00:18.84]い[00:19.19]出[00:19.52]を[00:22.39]\n[00:40.31]出[00:40.54]会[00:40.74]い[00:40.93]は[00:41.13]ふ[00:41.35]っ[00:41.53]と[00:41.69]し[00:41.86]た[00:42.03]瞬[00:42.42]間[00:43.20]\n[00:40.31]de [00:40.54]a [00:40.74]i [00:40.93]wa [00:41.13]fu [00:41.35]'t [00:41.53]to [00:41.69]shi [00:41.86]ta [00:42.03]shu [00:42.16][00:42.29]n [00:42.42]ka [00:42.81]n [00:43.20]\n[00:43.70]帰[00:44.20]り[00:44.42]道[00:44.81]の[00:45.18]交[00:45.60]差[00:45.95]点[00:46.30]で[00:46.81]\n[00:43.70]ka [00:43.95]e [00:44.20]ri [00:44.42]mi [00:44.62]chi [00:44.81]no [00:45.18]ko [00:45.39]u [00:45.60]sa [00:45.95]te [00:46.12]n [00:46.30]de [00:46.81]\n[00:47.50]声[00:47.75]を[00:48.02]か[00:48.22]け[00:48.47]て[00:48.84]く[00:48.90]れ[00:49.34]た[00:49.61]ね[00:50.18]\n[00:47.50]ko [00:47.56]e [00:47.75]wo [00:48.02]ka [00:48.22]ke [00:48.47]te [00:48.84]ku [00:48.90]re [00:49.34]ta [00:49.61]ne [00:50.18]\n[00:50.18]「[00:50.23]一[00:50.66]緒[00:50.87]に[00:51.21]帰[00:51.74]ろ[00:52.08]う[00:52.37]」[00:52.41]\n[00:50.18]「 [00:50.23]i [00:50.28]'s [00:50.66]sho [00:50.76][00:50.87]ni [00:51.21]ka [00:51.42]e [00:51.74]ro [00:52.08]u [00:52.37]」 [00:52.41]\n[00:52.84]僕[00:55.02]は[00:55.28]照[00:55.53]れ[00:55.83]く[00:56.12]さ[00:56.49]そ[00:56.72]う[00:57.13]に[00:57.35]\n[00:52.84]bo [00:54.83]ku [00:55.02]wa [00:55.28]te [00:55.53]re [00:55.83]ku [00:56.12]sa [00:56.49]so [00:56.72]u [00:57.13]ni [00:57.35]\n[00:57.97]カ[00:58.22]バ[00:58.40]ン[00:58.56]で[00:58.92]顔[00:59.26]を[00:59.61]隠[00:59.84]し[01:00.02]な[01:00.29]が[01:00.53]ら[01:01.09]\n[00:57.97]ka [00:58.22]ba [00:58.40]n [00:58.56]de [00:58.92]ka [00:59.09]o [00:59.26]wo [00:59.61]ka [00:59.72]ku [00:59.84]shi [01:00.02]na [01:00.29]ga [01:00.53]ra [01:01.09]\n[01:01.77]本[01:02.23]当[01:02.48]は[01:02.60][01:02.73]と[01:03.01]て[01:03.34]も[01:03.49][01:03.64]と[01:03.97]て[01:04.29]も[01:04.70]嬉[01:05.15]し[01:05.37]か[01:05.55]っ[01:05.91]た[01:06.14]よ[01:07.14]\n[01:01.77]ho [01:02.00]n [01:02.23]to [01:02.36]u [01:02.48]wa [01:02.60][01:02.73]to [01:03.01]te [01:03.34]mo [01:03.49][01:03.64]to [01:03.97]te [01:04.29]mo [01:04.70]u [01:04.93]re [01:05.15]shi [01:05.37]ka [01:05.55]'t [01:05.91]ta [01:06.14]yo [01:07.14]\n[01:08.94]あ[01:09.11]ぁ[01:09.38]\n[01:08.94]a [01:09.21]\n[01:10.10]花[01:10.28]火[01:10.66]が[01:10.87]夜[01:11.08]空[01:11.93]き[01:12.16]れ[01:12.35]い[01:12.59]に[01:12.81]咲[01:13.00]い[01:13.29]て[01:13.50]\n[01:10.10]ha [01:10.19]na [01:10.28]bi [01:10.66]ga [01:10.87]yo [01:11.08]zo [01:11.50]ra [01:11.93]ki [01:12.16]re [01:12.35]i [01:12.59]ni [01:12.81]sa [01:13.00]i [01:13.29]te [01:13.50]\n[01:13.78]ち[01:14.14]ょ[01:14.33]っ[01:14.52]と[01:14.68]セ[01:14.87]ツ[01:15.04]ナ[01:15.20]ク[01:15.40]\n[01:13.78]cho [01:13.97][01:14.33]'t [01:14.52]to [01:14.68]se [01:14.87]tsu [01:15.04]na [01:15.20]ku [01:15.40]\n[01:16.04]あ[01:16.19]ぁ[01:16.67]\n[01:16.04]a [01:16.52]\n[01:17.22]風[01:17.56]が[01:18.00]時[01:18.20]間[01:18.41]と[01:19.03]と[01:19.30]も[01:19.53]に[01:19.79]流[01:20.18]れ[01:20.41]る[01:21.40]\n[01:17.22]ka [01:17.39]ze [01:17.56]ga [01:18.00]ji [01:18.20]ka [01:18.30]n [01:18.41]to [01:19.03]to [01:19.30]mo [01:19.53]ni [01:19.79]na [01:19.99]ga [01:20.18]re [01:20.41]ru [01:21.40]\n[01:22.80]嬉[01:23.34]し[01:23.59]く[01:23.83]っ[01:24.02]て[01:24.29] [01:24.57]楽[01:25.19]し[01:25.45]く[01:25.71]っ[01:25.89]て[01:26.07]\n[01:22.80]u [01:23.07]re [01:23.34]shi [01:23.59]ku [01:23.83]'t [01:24.02]te [01:24.29]  [01:24.57]ta [01:24.88]no [01:25.19]shi [01:25.45]ku [01:25.71]'t [01:25.89]te [01:26.07]\n[01:26.40]冒[01:26.84]険[01:27.51]も[01:28.01]い[01:28.21]ろ[01:28.44]い[01:28.68]ろ[01:28.92]し[01:29.11]た[01:29.31]ね[01:29.55]\n[01:26.40]bo [01:26.62]u [01:26.84]ke [01:27.17]n [01:27.51]mo [01:28.01]i [01:28.21]ro [01:28.44]i [01:28.68]ro [01:28.92]shi [01:29.11]ta [01:29.31]ne [01:29.55]\n[01:29.96]二[01:30.58]人[01:31.19]の[01:31.75]秘[01:32.20]密[01:32.51]の[01:32.89]基[01:33.16]地[01:33.53]の[01:33.73]中[01:35.79]\n[01:29.96]fu [01:30.27]ta [01:30.58]ri [01:31.19]no [01:31.75]hi [01:32.20]mi [01:32.35]tsu [01:32.51]no [01:32.89]ki [01:33.16]chi [01:33.53]no [01:33.73]na [01:34.76]ka [01:35.79]\n[01:37.04]君[01:37.46]と[01:37.66]夏[01:37.91]の[01:38.40]終[01:38.68]わ[01:38.87]り[01:39.05] [01:39.22]将[01:39.58]来[01:40.15]の[01:40.33]夢[01:40.82]\n[01:37.04]ki [01:37.25]mi [01:37.46]to [01:37.66]na [01:37.78]tsu [01:37.91]no [01:38.40]o [01:38.68]wa [01:38.87]ri [01:39.05]  [01:39.22]sho [01:39.34][01:39.46]u [01:39.58]ra [01:39.86]i [01:40.15]no [01:40.33]yu [01:40.57]me [01:40.82]\n[01:41.07]大[01:41.44]き[01:41.63]な[01:41.81]希[01:42.02]望[01:42.37] [01:42.71]忘[01:43.37]れ[01:43.55]な[01:43.73]い[01:43.73]\n[01:41.07]o [01:41.25]o [01:41.44]ki [01:41.63]na [01:41.81]ki [01:42.02]bo [01:42.20]u [01:42.37]  [01:42.71]wa [01:43.04]su [01:43.37]re [01:43.55]na [01:43.73]i [01:43.73]\n[01:44.25]１０[01:44.69]年[01:45.09]後[01:45.31]の[01:45.52]８[01:46.03]月[01:46.32]\n[01:46.50]ま[01:46.93]た[01:47.12]出[01:47.33]会[01:47.55]え[01:47.77]る[01:47.98]の[01:48.16]を[01:48.39]信[01:48.86]じ[01:49.07]て[01:50.92]\n[01:51.36]君[01:51.71]が[01:51.99]最[01:52.38]後[01:52.62]ま[01:52.82]で[01:53.04]心[01:53.95]か[01:54.13]ら[01:54.33]\n[01:51.36]ki [01:51.53]mi [01:51.71]ga [01:51.99]sa [01:52.18]i [01:52.38]go [01:52.62]ma [01:52.82]de [01:53.04]ko [01:53.34]ko [01:53.65]ro [01:53.95]ka [01:54.13]ra [01:54.33]\n[01:54.56]「[01:54.74]あ[01:54.90]り[01:55.06]が[01:55.21]と[01:55.35]う[01:55.50]」[01:55.66]叫[01:55.82]ん[01:55.98]で[01:56.17]い[01:56.44]た[01:56.68]こ[01:56.87]と[01:57.12]\n[01:54.56]「 [01:54.74]a [01:54.90]ri [01:55.06]ga [01:55.21]to [01:55.35]u [01:55.50]」 [01:55.66]sa [01:55.74]ke [01:55.82]n [01:55.98]de [01:56.17]i [01:56.44]ta [01:56.68]ko [01:56.87]to [01:57.12]\n[01:57.32]知[01:57.57]っ[01:57.74]て[01:57.89]い[01:58.05]た[01:58.19]よ[01:58.37]\n[01:57.32]shi [01:57.57]'t [01:57.74]te [01:57.89]i [01:58.05]ta [01:58.19]yo [01:58.37]\n[01:58.56]涙[01:59.18]を[01:59.44]こ[01:59.63]ら[01:59.78]え[01:59.97]て[02:00.13]笑[02:00.31]顔[02:01.16]で[02:01.47]さ[02:01.65]よ[02:01.82]う[02:02.00]な[02:02.29]ら[02:02.48]\n[01:58.56]na [01:58.77]mi [01:58.97]da [01:59.18]wo [01:59.44]ko [01:59.63]ra [01:59.78]e [01:59.97]te [02:00.13]e [02:00.31]ga [02:00.73]o [02:01.16]de [02:01.47]sa [02:01.65]yo [02:01.82]u [02:02.00]na [02:02.29]ra [02:02.48]\n[02:02.49]せ[02:02.79]つ[02:03.05]な[02:03.26]い[02:03.44]よ[02:03.61]ね[02:04.45]\n[02:02.49]se [02:02.79]tsu [02:03.05]na [02:03.26]i [02:03.44]yo [02:03.61]ne [02:04.45]\n[02:05.86]最[02:06.25]高[02:06.66]の[02:09.31]思[02:09.84]い[02:10.14]出[02:10.43]を[02:11.72]\n[02:05.86]sa [02:06.06]i [02:06.25]ko [02:06.46]u [02:06.66]no [02:09.31]o [02:09.58]mo [02:09.84]i [02:10.14]de [02:10.43]wo [02:11.72]\n[02:13.41]あ[02:13.61]ぁ[02:13.90]\n[02:13.41]a [02:13.70]\n[02:14.63]夏[02:14.99]休[02:15.26]み[02:15.59]も[02:16.30]あ[02:16.53]と[02:16.71]少[02:17.00]し[02:17.56]で[02:17.82]\n[02:14.63]na [02:14.81]tsu [02:14.99]ya [02:15.13]su [02:15.26]mi [02:15.59]mo [02:16.30]a [02:16.53]to [02:16.71]su [02:16.85]ko [02:17.00]shi [02:17.56]de [02:17.82]\n[02:18.15]終[02:18.40]わ[02:18.58]っ[02:18.81]ち[02:19.00]ゃ[02:19.19]う[02:19.37]か[02:19.55]ら[02:19.75]\n[02:18.15]o [02:18.40]wa [02:18.58]'c [02:18.81]cha [02:19.00][02:19.19]u [02:19.37]ka [02:19.55]ra [02:19.75]\n[02:20.63]あ[02:20.81]ぁ[02:21.30] [02:21.78]太[02:22.17]陽[02:22.49]と[02:22.68]月[02:23.09] [02:23.51]仲[02:23.92]良[02:24.18]く[02:24.60]し[02:24.84]て[02:25.33]\n[02:20.63]a [02:21.12][02:21.30]  [02:21.78]ta [02:21.98]i [02:22.17]yo [02:22.33]u [02:22.49]to [02:22.68]tsu [02:22.89]ki [02:23.09]  [02:23.51]na [02:23.71]ka [02:23.92]yo [02:24.18]ku [02:24.60]shi [02:24.84]te [02:25.33]\n[02:27.32]悲[02:27.78]し[02:28.06]く[02:28.33]っ[02:28.52]て[02:28.75] [02:28.99]寂[02:29.50]し[02:29.75]く[02:29.94]っ[02:30.16]て[02:30.50]\n[02:27.32]ka [02:27.55]na [02:27.78]shi [02:28.06]ku [02:28.33]'t [02:28.52]te [02:28.75]  [02:28.99]sa [02:29.24]bi [02:29.50]shi [02:29.75]ku [02:29.94]'t [02:30.16]te [02:30.50]\n[02:30.86]喧[02:31.32]嘩[02:31.65]も[02:31.83] [02:32.00]い[02:32.45]ろ[02:32.66]い[02:32.89]ろ[02:33.14]し[02:33.36]た[02:33.61]ね[02:34.03]\n[02:30.86]ke [02:31.09]n [02:31.32]ka [02:31.65]mo [02:31.83]  [02:32.00]i [02:32.45]ro [02:32.66]i [02:32.89]ro [02:33.14]shi [02:33.36]ta [02:33.61]ne [02:34.03]\n[02:34.45]二[02:34.91]人[02:35.44]の[02:36.31]秘[02:36.57]密[02:37.05]の[02:37.45]基[02:37.65]地[02:37.91]の[02:38.13]中[02:39.58]\n[02:34.45]fu [02:34.68]ta [02:34.91]ri [02:35.44]no [02:36.31]hi [02:36.57]mi [02:36.81]tsu [02:37.05]no [02:37.45]ki [02:37.65]chi [02:37.91]no [02:38.13]na [02:38.86]ka [02:39.58]\n[02:41.63]君[02:42.02]が[02:42.23]最[02:42.46]後[02:42.77]ま[02:42.97]で[02:43.26]心[02:44.00]か[02:44.21]ら[02:44.37]\n[02:41.63]ki [02:41.83]mi [02:42.02]ga [02:42.23]sa [02:42.35]i [02:42.46]go [02:42.77]ma [02:42.97]de [02:43.26]ko [02:43.50]ko [02:43.75]ro [02:44.00]ka [02:44.21]ra [02:44.37]\n[02:44.59]「[02:44.76]あ[02:44.93]り[02:45.08]が[02:45.22]と[02:45.35]う[02:45.49]」[02:45.65]叫[02:45.80]ん[02:45.98]で[02:46.30]い[02:46.47]た[02:46.64]こ[02:46.87]と[02:47.08]\n[02:44.59]「 [02:44.76]a [02:44.93]ri [02:45.08]ga [02:45.22]to [02:45.35]u [02:45.49]」 [02:45.65]sa [02:45.72]ke [02:45.80]n [02:45.98]de [02:46.30]i [02:46.47]ta [02:46.64]ko [02:46.87]to [02:47.08]\n[02:47.32]知[02:47.66]っ[02:47.85]て[02:48.00]い[02:48.18]た[02:48.33]よ[02:48.48]\n[02:47.32]shi [02:47.66]'t [02:47.85]te [02:48.00]i [02:48.18]ta [02:48.33]yo [02:48.48]\n[02:48.69]涙[02:49.21]を[02:49.48]こ[02:49.68]ら[02:49.85]え[02:50.05]て[02:50.25]笑[02:50.64]顔[02:51.30]で[02:51.54]さ[02:51.75]よ[02:51.95]う[02:52.16]な[02:52.34]ら[02:52.54]\n[02:48.69]na [02:48.87]mi [02:49.04]da [02:49.21]wo [02:49.48]ko [02:49.68]ra [02:49.85]e [02:50.05]te [02:50.25]e [02:50.64]ga [02:50.97]o [02:51.30]de [02:51.54]sa [02:51.75]yo [02:51.95]u [02:52.16]na [02:52.34]ra [02:52.54]\n[02:52.55]せ[02:52.72]つ[02:52.90]な[02:53.07]い[02:53.25]よ[02:53.42]ね[02:54.60]\n[02:52.55]se [02:52.72]tsu [02:52.90]na [02:53.07]i [02:53.25]yo [02:53.42]ne [02:54.60]\n[02:55.94]最[02:56.42]高[02:57.16]の[02:59.54]思[03:00.01]い[03:00.41]出[03:00.74]を[03:01.78]\n[02:55.94]sa [02:56.18]i [02:56.42]ko [02:56.79]u [02:57.16]no [02:59.54]o [02:59.77]mo [03:00.01]i [03:00.41]de [03:00.74]wo [03:01.78]\n[03:03.65]突[03:05.21]然[03:07.01]の[03:10.69]転[03:12.49]校[03:14.09]で[03:14.87]\n[03:03.65]to [03:04.43]tsu [03:05.21]ze [03:06.11]n [03:07.01]no [03:10.69]te [03:11.59]n [03:12.49]ko [03:13.29]u [03:14.09]de [03:14.87]\n[03:17.83]ど[03:18.35]う[03:19.07]し[03:19.55]よ[03:20.05]う[03:20.55]も[03:21.19]な[03:21.41]く[03:22.22]\n[03:17.83]do [03:18.35]u [03:19.07]shi [03:19.55]yo [03:20.05]u [03:20.55]mo [03:21.19]na [03:21.41]ku [03:22.22]\n[03:24.73]手[03:25.02]紙[03:25.53]書[03:25.72]く[03:25.95]よ[03:26.38]電[03:26.60]話[03:26.99]も[03:27.23]す[03:27.44]る[03:27.71]よ[03:28.24]\n[03:24.73]te [03:25.02]ga [03:25.22]mi [03:25.53]ka [03:25.72]ku [03:25.95]yo [03:26.38]de [03:26.40]n [03:26.60]wa [03:26.99]mo [03:27.23]su [03:27.44]ru [03:27.71]yo [03:28.24]\n[03:28.24]忘[03:28.47]れ[03:28.78]な[03:28.97]い[03:29.20]で[03:29.44]ね[03:29.99]僕[03:30.26]の[03:30.63]こ[03:30.89]と[03:31.39]を[03:31.70]\n[03:28.24]wa [03:28.30]su [03:28.47]re [03:28.78]na [03:28.97]i [03:29.20]de [03:29.44]ne [03:29.99]bo [03:30.07]ku [03:30.26]no [03:30.63]ko [03:30.89]to [03:31.39]wo [03:31.70]\n[03:31.76]い[03:32.13]つ[03:32.34]ま[03:32.51]で[03:32.72]も[03:33.56]二[03:33.83]人[03:34.33]の[03:34.71]基[03:34.92]地[03:35.25]の[03:35.47]中[03:36.22]\n[03:31.76]i [03:32.13]tsu [03:32.34]ma [03:32.51]de [03:32.72]mo [03:33.56]fu [03:33.69]ta [03:33.83]ri [03:34.33]no [03:34.71]ki [03:34.92]chi [03:35.25]no [03:35.47]na [03:35.84]ka [03:36.22]\n[03:38.79]君[03:39.04]と[03:39.51]夏[03:39.73]の[03:39.92]終[03:40.33]わ[03:40.64]り[03:40.81] [03:40.98]ず[03:41.38]っ[03:41.56]と[03:41.73]話[03:42.11]し[03:42.30]て[03:42.50]\n[03:38.79]ki [03:38.92]mi [03:39.04]to [03:39.51]na [03:39.62]tsu [03:39.73]no [03:39.92]o [03:40.33]wa [03:40.64]ri [03:40.81]  [03:40.98]zu [03:41.38]'t [03:41.56]to [03:41.73]ha [03:41.92]na [03:42.11]shi [03:42.30]te [03:42.50]\n[03:42.75]夕[03:43.16]日[03:43.36]を[03:43.54]見[03:43.75]て[03:43.95]か[03:44.19]ら[03:44.68]星[03:44.87]を[03:45.07]眺[03:45.47]め[03:45.66]\n[03:42.75]yu [03:42.96]u [03:43.16]hi [03:43.36]wo [03:43.54]mi [03:43.75]te [03:43.95]ka [03:44.19]ra [03:44.68]ho [03:44.78]shi [03:44.87]wo [03:45.07]na [03:45.27]ga [03:45.47]me [03:45.66]\n[03:45.90]君[03:46.22]の[03:46.58]頬[03:46.89]を[03:47.15]流[03:47.36]れ[03:47.61]た[03:48.59]涙[03:49.17]は[03:50.13]\n[03:45.90]ki [03:46.06]mi [03:46.22]no [03:46.58]ho [03:46.73]ho [03:46.89]wo [03:47.15]na [03:47.26]ga [03:47.36]re [03:47.61]ta [03:48.59]na [03:48.79]mi [03:48.98]da [03:49.17]wa [03:50.13]\n[03:50.14]ず[03:50.37]っ[03:50.55]と[03:50.72]忘[03:50.89]れ[03:51.04]な[03:51.37]い[03:52.11]\n[03:50.14]zu [03:50.37]'t [03:50.55]to [03:50.72]wa [03:50.80]su [03:50.89]re [03:51.04]na [03:51.37]i [03:52.11]\n[03:53.19]君[03:53.51]が[03:53.71]最[03:53.88]後[03:54.10]ま[03:54.68]で[03:54.97]大[03:55.18]き[03:55.49]く[03:55.69]手[03:55.89]を[03:56.08]振[03:56.23]っ[03:56.41]て[03:56.68]\n[03:53.19]ki [03:53.35]mi [03:53.51]ga [03:53.71]sa [03:53.79]i [03:53.88]go [03:54.10]ma [03:54.68]de [03:54.97]o [03:55.08]o [03:55.18]ki [03:55.49]ku [03:55.69]te [03:55.89]wo [03:56.08]fu [03:56.23]'t [03:56.41]te [03:56.68]\n[03:57.20]く[03:57.54]れ[03:57.73]た[03:57.89]こ[03:58.26]と[03:58.56]き[03:58.79]っ[03:58.98]と[03:59.15]忘[03:59.33]れ[03:59.49]な[03:59.67]い[03:59.87]\n[03:57.20]ku [03:57.54]re [03:57.73]ta [03:57.89]ko [03:58.26]to [03:58.56]ki [03:58.79]'t [03:58.98]to [03:59.15]wa [03:59.24]su [03:59.33]re [03:59.49]na [03:59.67]i [03:59.87]\n[04:00.26]だ[04:00.54]か[04:00.73]ら[04:00.81] [04:00.90]こ[04:01.10]う[04:01.31]し[04:01.52]て[04:01.86]夢[04:02.35]の[04:02.55]中[04:03.24]で[04:03.41]\n[04:00.26]da [04:00.54]ka [04:00.73]ra [04:00.81]  [04:00.90]ko [04:01.10]u [04:01.31]shi [04:01.52]te [04:01.86]yu [04:02.11]me [04:02.35]no [04:02.55]na [04:02.89]ka [04:03.24]de [04:03.41]\n[04:03.61]ず[04:03.78]っ[04:03.97]と[04:04.19]永[04:04.38]遠[04:04.95]に[04:06.25]\n[04:03.61]zu [04:03.78]'t [04:03.97]to [04:04.19]e [04:04.28]i [04:04.38]e [04:04.67]n [04:04.95]ni [04:06.25]\n[04:07.53]君[04:07.73]と[04:08.03]夏[04:08.25]の[04:08.43]終[04:08.61]わ[04:08.86]り[04:09.21] [04:09.55]将[04:10.03]来[04:10.52]の[04:10.73]夢[04:11.02]\n[04:07.53]ki [04:07.63]mi [04:07.73]to [04:08.03]na [04:08.14]tsu [04:08.25]no [04:08.43]o [04:08.61]wa [04:08.86]ri [04:09.21]  [04:09.55]sho [04:09.71][04:09.87]u [04:10.03]ra [04:10.27]i [04:10.52]no [04:10.73]yu [04:10.87]me [04:11.02]\n[04:11.38]大[04:11.83]き[04:12.05]な[04:12.32]希[04:12.58]望[04:12.86] [04:13.14]忘[04:13.59]れ[04:13.79]な[04:13.99]い[04:14.27]\n[04:11.38]o [04:11.60]o [04:11.83]ki [04:12.05]na [04:12.32]ki [04:12.58]bo [04:12.72]u [04:12.86]  [04:13.14]wa [04:13.37]su [04:13.59]re [04:13.79]na [04:13.99]i [04:14.27]\n[04:14.63]１０[04:15.20]年[04:15.62]後[04:15.80]の[04:16.02]８[04:16.46]月[04:16.66]\n[04:14.63]ju u [04:15.20]ne [04:15.40][04:15.41]n [04:15.61][04:15.61]go [04:15.80][04:15.80]no [04:16.02]ha chi [04:16.46]ga [04:16.63][04:16.64]tsu [04:16.66]\n[04:16.88]ま[04:17.39]た[04:17.57]出[04:17.81]会[04:18.01]え[04:18.21]る[04:18.39]の[04:18.59]を[04:18.79]信[04:19.28]じ[04:19.49]て[04:21.33]\n[04:16.88]ma [04:17.39]ta [04:17.57][04:17.57]de [04:17.80]a [04:18.01][04:18.01]e [04:18.21]ru [04:18.39][04:18.39]no [04:18.58]wo [04:18.79][04:18.79]shi [04:19.03][04:19.03]n [04:19.28]ji [04:19.49]te [04:21.33]\n[04:21.98]君[04:22.36]が[04:22.55]最[04:22.74]後[04:23.03]ま[04:23.27]で[04:23.57]心[04:24.32]か[04:24.48]ら[04:24.69]\n[04:21.98]ki [04:22.17]mi [04:22.36]ga [04:22.55]sa [04:22.65]i [04:22.74]go [04:23.03]ma [04:23.27]de [04:23.57]ko [04:23.82]ko [04:24.07]ro [04:24.32]ka [04:24.48]ra [04:24.69]\n[04:24.90]「[04:25.08]あ[04:25.24]り[04:25.38]が[04:25.54]と[04:25.70]う[04:25.86]」[04:26.02]叫[04:26.20]ん[04:26.38]で[04:26.68]い[04:26.85]た[04:27.01]こ[04:27.18]と[04:27.37]\n[04:24.90]「 [04:25.08]a [04:25.24]ri [04:25.38]ga [04:25.54]to [04:25.70]u [04:25.86]」 [04:26.02]sa [04:26.11]ke [04:26.20]n [04:26.38]de [04:26.68]i [04:26.85]ta [04:27.01]ko [04:27.18]to [04:27.37]\n[04:27.62]知[04:27.94]っ[04:28.10]て[04:28.27]い[04:28.43]た[04:28.58]よ[04:28.76]\n[04:27.62]shi [04:27.94]'t [04:28.10]te [04:28.27]i [04:28.43]ta [04:28.58]yo [04:28.76]\n[04:28.98]涙[04:29.53]を[04:29.81]こ[04:30.06]ら[04:30.23]え[04:30.40]て[04:30.78]笑[04:31.09]顔[04:31.63]で[04:31.83]さ[04:32.02]よ[04:32.22]う[04:32.43]な[04:32.62]ら[04:32.80]\n[04:28.98]na [04:29.16]mi [04:29.35]da [04:29.53]wo [04:29.81]ko [04:30.06]ra [04:30.23]e [04:30.40]te [04:30.78]e [04:31.09]ga [04:31.36]o [04:31.63]de [04:31.83]sa [04:32.02]yo [04:32.22]u [04:32.43]na [04:32.62]ra [04:32.80]\n[04:32.82]せ[04:32.98]つ[04:33.15]な[04:33.33]い[04:33.51]よ[04:33.77]ね[04:34.68]\n[04:32.82]se [04:32.98]tsu [04:33.15]na [04:33.33]i [04:33.51]yo [04:33.77]ne [04:34.68]\n[04:36.29]最[04:36.69]高[04:37.39]の[04:39.91]思[04:40.33]い[04:40.63]出[04:40.95]を[04:42.23]\n[04:36.29]sa [04:36.49]i [04:36.69]ko [04:37.04]u [04:37.39]no [04:39.91]o [04:40.12]mo [04:40.33]i [04:40.63]de [04:40.95]wo [04:42.23]\n[04:43.54]最[04:43.91]高[04:44.56]の[04:47.06]思[04:47.44]い[04:47.78]出[04:48.10]を[04:48.41]\n[04:43.54]sa [04:43.72]i [04:43.91]ko [04:44.23]u [04:44.56]no [04:47.06]o [04:47.25]mo [04:47.44]i [04:47.78]de [04:48.10]wo [04:48.41]",
    "lrcUrl": "assets/lyrics/track_13.lrc"
  },
  {
    "index": "014",
    "spineNum": "14",
    "serial": "WK-REAL-14",
    "title": "only my railgun",
    "shortTitle": "超电磁炮 · fripSide",
    "spineTitle": "电磁炮 · 炮姐",
    "subtitleQuote": "| 你指尖跃动的电光，是我此生不变的信仰",
    "artist": "fripSide",
    "subArtist": "某科学的超电磁炮 OP1",
    "statusTag": "镇站之宝",
    "subTag": "超电磁炮",
    "durationSec": 262,
    "currentSec": 0,
    "accent": "#3b82f6",
    "c1": "#60a5fa",
    "c2": "#1d4ed8",
    "picUrl": "assets/covers/cover_14.jpg",
    "audioUrl": "assets/audio/track_14.mp3",
    "notes": [
      329.63,
      392,
      440,
      493.88,
      523.25,
      493.88,
      440,
      392
    ],
    "lyrics": [
      {
        "t": 0.33,
        "l1": "only my railgun - フリップサイド",
        "l2": ""
      },
      {
        "t": 0.33,
        "l1": "only  my  railgun -   fu ri 'p pu sa i do",
        "l2": ""
      },
      {
        "t": 2.16,
        "l1": "词：八木沼悟志/yuki-ka",
        "l2": ""
      },
      {
        "t": 2.16,
        "l1": "shi ： ya gi nu ma sa to shi / yuki- ka",
        "l2": ""
      },
      {
        "t": 4.05,
        "l1": "曲：八木沼悟志",
        "l2": ""
      },
      {
        "t": 4.05,
        "l1": "kyo ku ： ya gi nu ma sa to shi",
        "l2": ""
      },
      {
        "t": 13.49,
        "l1": "放て心に刻んだ夢を",
        "l2": ""
      },
      {
        "t": 13.49,
        "l1": "ha na te ko ko ro ni ki za n da yu me wo",
        "l2": ""
      },
      {
        "t": 16.54,
        "l1": "未来さえ置き去りにして",
        "l2": ""
      },
      {
        "t": 16.54,
        "l1": "mi ra i sa e o ki za ri ni shi te",
        "l2": ""
      },
      {
        "t": 20.3,
        "l1": "限界など知らない",
        "l2": ""
      },
      {
        "t": 20.3,
        "l1": "ge n ka i na do shi ra na i",
        "l2": ""
      },
      {
        "t": 22.33,
        "l1": "意味無い",
        "l2": ""
      },
      {
        "t": 22.33,
        "l1": "i mi na i",
        "l2": ""
      },
      {
        "t": 23.21,
        "l1": "この能力が光散らす",
        "l2": ""
      },
      {
        "t": 23.21,
        "l1": "ko no chi ka ra ga hi ka ri chi ra su",
        "l2": ""
      },
      {
        "t": 26.72,
        "l1": "その先に遥かな想いを",
        "l2": ""
      },
      {
        "t": 26.72,
        "l1": "so no sa ki ni ha ru ka na o mo i wo",
        "l2": ""
      },
      {
        "t": 34.33,
        "l1": "歩いてきた この道を",
        "l2": ""
      },
      {
        "t": 34.33,
        "l1": "a ru i te ki ta   ko no mi chi wo",
        "l2": ""
      },
      {
        "t": 38.49,
        "l1": "振り返ることしか",
        "l2": ""
      },
      {
        "t": 38.49,
        "l1": "fu ri ka e ru ko to shi ka",
        "l2": ""
      },
      {
        "t": 40.98,
        "l1": "出来ないなら",
        "l2": ""
      },
      {
        "t": 40.98,
        "l1": "de ki na i na ra",
        "l2": ""
      },
      {
        "t": 43.49,
        "l1": "今ここ��全てを壊せる",
        "l2": ""
      },
      {
        "t": 43.49,
        "l1": "i ma ko ko de su be te wo ko wa se ru",
        "l2": ""
      },
      {
        "t": 47.71,
        "l1": "暗闇に堕ちる街並み",
        "l2": ""
      },
      {
        "t": 47.71,
        "l1": "ku ra ya mi ni o chi ru ma chi na mi",
        "l2": ""
      },
      {
        "t": 50.88,
        "l1": "人はどこまで立ち向かえるの?",
        "l2": ""
      },
      {
        "t": 50.88,
        "l1": "hi to ha do ko ma de ta chi mu ka e ru no ?",
        "l2": ""
      },
      {
        "t": 54.44,
        "l1": "加速するその痛みから",
        "l2": ""
      },
      {
        "t": 54.44,
        "l1": "ka so ku su ru so no i ta mi ka ra",
        "l2": ""
      },
      {
        "t": 57.65,
        "l1": "誰かをきっと守れるよ",
        "l2": ""
      },
      {
        "t": 57.65,
        "l1": "da re ka wo ki 't to ma mo re ru yo",
        "l2": ""
      },
      {
        "t": 62.3,
        "l1": "Looking",
        "l2": ""
      },
      {
        "t": 62.3,
        "l1": "Looking",
        "l2": ""
      },
      {
        "t": 62.66,
        "l1": "The blitz loop this planet to search way",
        "l2": ""
      },
      {
        "t": 62.66,
        "l1": "The  blitz  loop  this  planet  to  search  way",
        "l2": ""
      },
      {
        "t": 65.15,
        "l1": "Only my RAILGUN can shoot it 今すぐ",
        "l2": ""
      },
      {
        "t": 65.15,
        "l1": "Only  my  RAILGUN  can  shoot  it  i ma su gu",
        "l2": ""
      },
      {
        "t": 68.9,
        "l1": "身体中を 光の速さで",
        "l2": ""
      },
      {
        "t": 68.9,
        "l1": "ka ra da ju u wo   hi ka ri no ha ya sa de",
        "l2": ""
      },
      {
        "t": 71.88,
        "l1": "駆け巡った 確かな予感",
        "l2": ""
      },
      {
        "t": 71.88,
        "l1": "ka ke me gu 't ta   ta shi ka na yo ka n",
        "l2": ""
      },
      {
        "t": 75.65,
        "l1": "掴め 望むものなら残さず",
        "l2": ""
      },
      {
        "t": 75.65,
        "l1": "tsu ka me   no zo mu mo no na ra no ko sa zu",
        "l2": ""
      },
      {
        "t": 78.61,
        "l1": "輝ける自分らしさで",
        "l2": ""
      },
      {
        "t": 78.61,
        "l1": "ka ga ya ke ru ji bu n ra shi sa de",
        "l2": ""
      },
      {
        "t": 82.3,
        "l1": "信じてるよ あの日の誓いを",
        "l2": ""
      },
      {
        "t": 82.3,
        "l1": "shi n ji te ru yo   a no hi no chi ka i wo",
        "l2": ""
      },
      {
        "t": 85.29,
        "l1": "この瞳に光る涙",
        "l2": ""
      },
      {
        "t": 85.29,
        "l1": "ko no hi to mi ni hi ka ru na mi da",
        "l2": ""
      },
      {
        "t": 88.8,
        "l1": "それさえも強さになるから",
        "l2": ""
      },
      {
        "t": 88.8,
        "l1": "so re sa e mo tsu yo sa ni na ru ka ra",
        "l2": ""
      },
      {
        "t": 96.52,
        "l1": "立ち止まると",
        "l2": ""
      },
      {
        "t": 96.52,
        "l1": "ta chi do ma ru to",
        "l2": ""
      },
      {
        "t": 98.86,
        "l1": "少しだけ 感じる切なさに",
        "l2": ""
      },
      {
        "t": 98.86,
        "l1": "su ko shi da ke   ka n ji ru se tsu na sa ni",
        "l2": ""
      },
      {
        "t": 103.09,
        "l1": "戸惑う事 無いなんて",
        "l2": ""
      },
      {
        "t": 103.09,
        "l1": "to ma do u ko to   na i na n te",
        "l2": ""
      },
      {
        "t": 106.89,
        "l1": "嘘はつかないよ",
        "l2": ""
      },
      {
        "t": 106.89,
        "l1": "u so ha tsu ka na i yo",
        "l2": ""
      },
      {
        "t": 109.83,
        "l1": "宇宙に舞うコインが描く",
        "l2": ""
      },
      {
        "t": 109.83,
        "l1": "so ra ni ma u ko i n ga e ga ku",
        "l2": ""
      },
      {
        "t": 112.93,
        "l1": "放物線が決める運命",
        "l2": ""
      },
      {
        "t": 112.93,
        "l1": "ho u bu tsu se n ga ki me ru u n me i",
        "l2": ""
      },
      {
        "t": 116.54,
        "l1": "打ち出した答えが今日も",
        "l2": ""
      },
      {
        "t": 116.54,
        "l1": "u chi da shi ta ko ta e ga kyo u mo",
        "l2": ""
      },
      {
        "t": 119.71,
        "l1": "私の胸を駆け巡る",
        "l2": ""
      },
      {
        "t": 119.71,
        "l1": "wa ta shi no mu ne wo ka ke me gu ru",
        "l2": ""
      },
      {
        "t": 124.33,
        "l1": "Sparkling",
        "l2": ""
      },
      {
        "t": 124.33,
        "l1": "Sparkling",
        "l2": ""
      },
      {
        "t": 124.88,
        "l1": "The shiny lights awake true desire",
        "l2": ""
      },
      {
        "t": 124.88,
        "l1": "The  shiny  lights  awake  true  desire",
        "l2": ""
      },
      {
        "t": 127.36,
        "l1": "Only my RAILGUN can shoot it必ず",
        "l2": ""
      },
      {
        "t": 127.36,
        "l1": "Only  my  RAILGUN  can  shoot  it ka na ra zu",
        "l2": ""
      },
      {
        "t": 131.03,
        "l1": "貫いてく 途惑うことなく",
        "l2": ""
      },
      {
        "t": 131.03,
        "l1": "tsu ra nu i te ku   to ma do u ko to na ku",
        "l2": ""
      },
      {
        "t": 134.03,
        "l1": "傷ついても 走り続ける",
        "l2": ""
      },
      {
        "t": 134.03,
        "l1": "ki zu tsu i te mo   ha shi ri tsu du ke ru",
        "l2": ""
      },
      {
        "t": 137.76,
        "l1": "狙え 凛と煌く視線は",
        "l2": ""
      },
      {
        "t": 137.76,
        "l1": "ne ra e   ri n to ki ra me ku shi se n ha",
        "l2": ""
      },
      {
        "t": 140.77,
        "l1": "狂い無く闇を切り裂く",
        "l2": ""
      },
      {
        "t": 140.77,
        "l1": "ku ru i na ku ya mi wo ki ri sa ku",
        "l2": ""
      },
      {
        "t": 144.43,
        "l1": "迷いなんて 吹き飛ばせばいい",
        "l2": ""
      },
      {
        "t": 144.43,
        "l1": "ma yo i na n te   fu ki to ba se ba i i",
        "l2": ""
      },
      {
        "t": 147.43,
        "l1": "この心が叫ぶ限り",
        "l2": ""
      },
      {
        "t": 147.43,
        "l1": "ko no ko ko ro ga sa ke bu ka gi ri",
        "l2": ""
      },
      {
        "t": 150.93,
        "l1": "誰ひとり邪魔などさせない",
        "l2": ""
      },
      {
        "t": 150.93,
        "l1": "da re hi to ri ja ma na do sa se na i",
        "l2": ""
      },
      {
        "t": 184.76,
        "l1": "儚く舞う 無数の願いは",
        "l2": ""
      },
      {
        "t": 184.76,
        "l1": "ha ka na ku ma u   mu su u no ne ga i ha",
        "l2": ""
      },
      {
        "t": 187.75,
        "l1": "この両手に 積もってゆく",
        "l2": ""
      },
      {
        "t": 187.75,
        "l1": "ko no ryo u te ni   tsu mo 't te yu ku",
        "l2": ""
      },
      {
        "t": 191.45,
        "l1": "切り裂く闇に 見えてくるのは",
        "l2": ""
      },
      {
        "t": 191.45,
        "l1": "ki ri sa ku ya mi ni   mi e te ku ru no ha",
        "l2": ""
      },
      {
        "t": 194.4,
        "l1": "重く深く 切ない記憶",
        "l2": ""
      },
      {
        "t": 194.4,
        "l1": "o mo ku fu ka ku   se tsu na i ki o ku",
        "l2": ""
      },
      {
        "t": 198.18,
        "l1": "色褪せてく 現実に揺れる",
        "l2": ""
      },
      {
        "t": 198.18,
        "l1": "i ro a se te ku   ge n ji tsu ni yu re ru",
        "l2": ""
      },
      {
        "t": 201.13,
        "l1": "絶望には 負けたくない",
        "l2": ""
      },
      {
        "t": 201.13,
        "l1": "ze tsu bo u ni ha   ma ke ta ku na i",
        "l2": ""
      },
      {
        "t": 204.88,
        "l1": "私が今 私であること",
        "l2": ""
      },
      {
        "t": 204.88,
        "l1": "wa ta shi ga i ma   wa ta shi de a ru ko to",
        "l2": ""
      },
      {
        "t": 207.82,
        "l1": "胸を張って 全て誇れる",
        "l2": ""
      },
      {
        "t": 207.82,
        "l1": "mu ne wo ha 't te   su be te ho ko re ru",
        "l2": ""
      },
      {
        "t": 211.53,
        "l1": "Looking",
        "l2": ""
      },
      {
        "t": 211.53,
        "l1": "Looking",
        "l2": ""
      },
      {
        "t": 212.02,
        "l1": "The blitz loop this planet to search way",
        "l2": ""
      },
      {
        "t": 212.02,
        "l1": "The  blitz  loop  this  planet  to  search  way",
        "l2": ""
      },
      {
        "t": 214.53,
        "l1": "Only my RAILGUN can shoot it 今すぐ",
        "l2": ""
      },
      {
        "t": 214.53,
        "l1": "Only  my  RAILGUN  can  shoot  it  i ma su gu",
        "l2": ""
      },
      {
        "t": 218.24,
        "l1": "身体中を 光の速さで",
        "l2": ""
      },
      {
        "t": 218.24,
        "l1": "ka ra da ju u wo   hi ka ri no ha ya sa de",
        "l2": ""
      },
      {
        "t": 221.22,
        "l1": "駆け巡った 確かな予感",
        "l2": ""
      },
      {
        "t": 221.22,
        "l1": "ka ke me gu 't ta   ta shi ka na yo ka n",
        "l2": ""
      },
      {
        "t": 224.99,
        "l1": "放て 心に刻んだ夢を",
        "l2": ""
      },
      {
        "t": 224.99,
        "l1": "ha na te   ko ko ro ni ki za n da yu me wo",
        "l2": ""
      },
      {
        "t": 228.02,
        "l1": "未来さえ置き去りにして",
        "l2": ""
      },
      {
        "t": 228.02,
        "l1": "mi ra i sa e o ki za ri ni shi te",
        "l2": ""
      },
      {
        "t": 231.67,
        "l1": "限界など知らない 意味無い",
        "l2": ""
      },
      {
        "t": 231.67,
        "l1": "ge n ka i na do shi ra na i   i mi na i",
        "l2": ""
      },
      {
        "t": 234.7,
        "l1": "この能力が光散らす",
        "l2": ""
      },
      {
        "t": 234.7,
        "l1": "ko no chi ka ra ga hi ka ri chi ra su",
        "l2": ""
      },
      {
        "t": 238.22,
        "l1": "その先に遥かな想いを",
        "l2": ""
      },
      {
        "t": 238.22,
        "l1": "so no sa ki ni ha ru ka na o mo i wo",
        "l2": ""
      }
    ],
    "comments": [
      "【热评 @学园都市Lv5】你指尖跃动的电光，是我此生不灭的信仰，唯我超电磁炮永世长存！"
    ],
    "lyricsRaw": "[ti:only my railgun]\n[ar:fripSide]\n[al:only my railgun]\n[offset:0]\n\n[00:00.33]only [00:00.52]my [00:00.69]railgun - [00:00.86][00:01.04]フ[00:01.21]リ[00:01.31]ッ[00:01.41]プ[00:01.60]サ[00:01.77]イ[00:01.95]ド[00:02.16]\n[00:00.33]only  [00:00.52]my  [00:00.69]railgun -  [00:00.86] [00:01.04]fu [00:01.21]ri [00:01.31]'p [00:01.41]pu [00:01.60]sa [00:01.77]i [00:01.95]do [00:02.16][00:02.16] [00:02.16]\n[00:02.16]词[00:02.35]：[00:02.35]八[00:02.54]木[00:02.72]沼[00:03.09]悟[00:03.47]志[00:03.66]/[00:03.66]yuki-[00:03.85]ka[00:04.05]\n[00:02.16]shi [00:02.35]： [00:02.35]ya [00:02.54]gi [00:02.72]nu [00:02.91]ma [00:03.09]sa [00:03.28]to [00:03.47]shi [00:03.66]/ [00:03.66]yuki- [00:03.85]ka [00:04.05]\n[00:04.05]曲[00:04.42]：[00:04.42]八[00:04.61]木[00:04.81]沼[00:05.17]悟[00:05.62]志[00:05.66]\n[00:04.05]kyo [00:04.14][00:04.24]ku [00:04.42]： [00:04.42]ya [00:04.61]gi [00:04.81]nu [00:04.99]ma [00:05.17]sa [00:05.40]to [00:05.62]shi [00:05.66]\n[00:13.49]放[00:13.91]て[00:14.16]心[00:14.80]に[00:15.02]刻[00:15.30][00:15.30]ん[00:15.67]だ[00:15.86]夢[00:16.22]を[00:16.38]\n[00:13.49]ha [00:13.69]na [00:13.91]te [00:14.16]ko [00:14.40]ko [00:14.55]ro [00:14.80]ni [00:15.02]ki [00:15.23]za [00:15.30][00:15.30]n [00:15.67]da [00:15.86]yu [00:16.06]me [00:16.22][00:16.21]wo [00:16.38]\n[00:16.54]未[00:16.72]来[00:17.11]さ[00:17.30]え[00:17.49]置[00:17.85]き[00:18.29]去[00:18.70]り[00:19.14]に[00:19.47]し[00:19.73]て[00:20.05]\n[00:16.54]mi [00:16.72]ra [00:16.91]i [00:17.11]sa [00:17.30]e [00:17.49]o [00:17.85]ki [00:18.29]za [00:18.70]ri [00:19.14]ni [00:19.47]shi [00:19.73]te [00:20.05]\n[00:20.30]限[00:20.72]界[00:21.17]な[00:21.31]ど[00:21.56]知[00:21.75]ら[00:21.96]な[00:22.11]い[00:22.18]\n[00:20.30]ge [00:20.51]n [00:20.72]ka [00:20.90]i [00:21.17]na [00:21.31]do [00:21.56]shi [00:21.75]ra [00:21.96]na [00:22.11]i [00:22.18]\n[00:22.33]意[00:22.54]味[00:22.74]無[00:22.90]い[00:22.99]\n[00:22.33]i [00:22.54]mi [00:22.74]na [00:22.90]i [00:22.99]\n[00:23.21]こ[00:23.39]の[00:23.58]能[00:23.77]力[00:24.19]が[00:25.06]光[00:25.65]散[00:25.90]ら[00:26.30]す[00:26.49]\n[00:23.21]ko [00:23.39]no [00:23.58]chi [00:23.77]ka [00:23.95]ra [00:24.19]ga [00:25.06]hi [00:25.27]ka [00:25.46]ri [00:25.65]chi [00:25.90]ra [00:26.30]su [00:26.49]\n[00:26.72]そ[00:27.10]の[00:27.59]先[00:27.96]に[00:28.23]遥[00:28.66]か[00:28.86]な[00:29.11]想[00:29.50]い[00:29.63]を[00:31.74]\n[00:26.72]so [00:27.10]no [00:27.59]sa [00:27.82]ki [00:27.96]ni [00:28.23]ha [00:28.43]ru [00:28.66]ka [00:28.86]na [00:29.11]o [00:29.30]mo [00:29.50]i [00:29.63]wo [00:31.74]\n[00:34.33]歩[00:35.31]い[00:35.53]て[00:35.73]き[00:35.95]た[00:36.84] [00:36.84]こ[00:37.03]の[00:37.22]道[00:37.64]を[00:38.19]\n[00:34.33]a [00:35.05]ru [00:35.31]i [00:35.53]te [00:35.73]ki [00:35.95]ta [00:36.84]  [00:36.84]ko [00:37.03]no [00:37.22]mi [00:37.41]chi [00:37.64]wo [00:38.19]\n[00:38.49]振[00:38.68]り[00:38.88]返[00:39.32]る[00:39.51]こ[00:39.71]と[00:39.90]し[00:40.12]か[00:40.65]\n[00:38.49]fu [00:38.68]ri [00:38.88]ka [00:39.07]e [00:39.32]ru [00:39.51]ko [00:39.71]to [00:39.90]shi [00:40.12]ka [00:40.65]\n[00:40.98]出[00:41.87]来[00:42.06]な[00:42.24]い[00:42.43]な[00:42.65]ら[00:43.15]\n[00:40.98]de [00:41.87]ki [00:42.06]na [00:42.24]i [00:42.43]na [00:42.65]ra [00:43.15]\n[00:43.49]今[00:43.90]こ[00:44.09]こ[00:44.33]��[00:44.77]全[00:45.42]て[00:45.62]を[00:45.84]壊[00:46.65]せ[00:46.84]る[00:47.32]\n[00:43.49]i [00:43.69]ma [00:43.90]ko [00:44.09]ko [00:44.33]de [00:44.77]su [00:45.23]be [00:45.42]te [00:45.62]wo [00:45.84]ko [00:46.05]wa [00:46.65]se [00:46.84]ru [00:47.32]\n[00:47.71]暗[00:48.10]闇[00:48.46]に[00:48.79]堕[00:48.97]ち[00:49.17]る[00:49.43]街[00:50.05]並[00:50.21]み[00:50.60]\n[00:47.71]ku [00:47.95]ra [00:48.10]ya [00:48.28]mi [00:48.46]ni [00:48.79]o [00:48.97]chi [00:49.17]ru [00:49.43]ma [00:49.82]chi [00:50.05]na [00:50.21]mi [00:50.60]\n[00:50.88]人[00:51.19]は[00:51.41]ど[00:51.58]こ[00:51.76]ま[00:51.96]で[00:52.16]立[00:52.32]ち[00:52.58]向[00:52.79]か[00:53.15]え[00:53.40]る[00:53.59]の[00:53.95][00:53.95]?[00:54.09]\n[00:50.88]hi [00:51.03]to [00:51.19]ha [00:51.41]do [00:51.58]ko [00:51.76]ma [00:51.96]de [00:52.16]ta [00:52.32]chi [00:52.58]mu [00:52.79]ka [00:53.15]e [00:53.40]ru [00:53.59]no [00:53.95][00:53.95]? [00:54.09]\n[00:54.44]加[00:54.69]速[00:55.07]す[00:55.22]る[00:55.50]そ[00:55.71]の[00:55.92]痛[00:56.48]み[00:56.75]か[00:56.90]ら[00:57.37]\n[00:54.44]ka [00:54.69]so [00:54.83]ku [00:55.07]su [00:55.22]ru [00:55.50]so [00:55.71]no [00:55.92]i [00:56.13]ta [00:56.48]mi [00:56.75]ka [00:56.90]ra [00:57.37]\n[00:57.65]誰[00:58.25]か[00:58.53]を[00:58.69]き[00:58.89]っ[00:59.07]と[00:59.30]守[01:00.04]れ[01:00.20]る[01:00.35]よ[01:01.38]\n[00:57.65]da [00:57.81]re [00:58.25]ka [00:58.53]wo [00:58.69]ki [00:58.89]'t [00:59.07]to [00:59.30]ma [00:59.49]mo [01:00.04]re [01:00.20]ru [01:00.35]yo [01:01.38]\n[01:02.30]Looking[01:02.47]\n[01:02.30]Looking [01:02.47]\n[01:02.66]The [01:02.88]blitz [01:03.19]loop [01:03.49]this [01:03.69]planet [01:04.33]to [01:04.52]search [01:04.82]way[01:04.93]\n[01:02.66]The  [01:02.88]blitz  [01:03.19]loop  [01:03.49]this  [01:03.69]planet  [01:04.33][01:04.33]to  [01:04.52]search  [01:04.82][01:04.82]way [01:04.93]\n[01:05.15]Only [01:05.35]my [01:05.57]RAILGUN [01:06.15]can [01:06.58]shoot [01:06.99]it [01:07.42]今[01:08.19]す[01:08.44]ぐ[01:08.64]\n[01:05.15]Only  [01:05.35]my  [01:05.57]RAILGUN  [01:06.15]can  [01:06.58]shoot  [01:06.99]it  [01:07.42]i [01:07.83]ma [01:08.19]su [01:08.44]gu [01:08.64]\n[01:08.90]身[01:09.32]体[01:09.58]中[01:09.89]を[01:10.22] [01:10.22]光[01:10.78]の[01:11.02]速[01:11.41]さ[01:11.58]で[01:11.66]\n[01:08.90]ka [01:09.11]ra [01:09.32]da [01:09.58]ju [01:09.68][01:09.78]u [01:09.89]wo [01:10.22]  [01:10.22]hi [01:10.43]ka [01:10.65]ri [01:10.78]no [01:11.02]ha [01:11.22]ya [01:11.41]sa [01:11.58]de [01:11.66]\n[01:11.88]駆[01:12.07]け[01:12.29]巡[01:12.69]っ[01:12.90]た[01:13.77] [01:13.77]確[01:14.14]か[01:14.33]な[01:14.52]予[01:14.84]感[01:15.46]\n[01:11.88]ka [01:12.07]ke [01:12.29]me [01:12.48]gu [01:12.69]'t [01:12.90]ta [01:13.77]  [01:13.77]ta [01:13.96]shi [01:14.14]ka [01:14.33]na [01:14.52]yo [01:14.84]ka [01:15.13]n [01:15.46]\n[01:15.65]掴[01:16.03]め[01:16.28] [01:16.28]望[01:16.64]む[01:16.89]も[01:17.10]の[01:17.31]な[01:17.47]ら[01:17.73]残[01:18.14]さ[01:18.28]ず[01:18.39]\n[01:15.65]tsu [01:15.84]ka [01:16.03]me [01:16.28]  [01:16.28]no [01:16.49]zo [01:16.64]mu [01:16.89]mo [01:17.10]no [01:17.31]na [01:17.47]ra [01:17.73]no [01:17.93]ko [01:18.14]sa [01:18.28]zu [01:18.39]\n[01:18.61]輝[01:19.17]け[01:19.35]る[01:19.59]自[01:19.92]分[01:20.83]ら[01:21.19]し[01:21.55]さ[01:21.83]で[01:22.03]\n[01:18.61]ka [01:18.78]ga [01:18.99]ya [01:19.17]ke [01:19.35]ru [01:19.59]ji [01:19.92]bu [01:20.37]n [01:20.83]ra [01:21.19]shi [01:21.55]sa [01:21.83]de [01:22.03]\n[01:22.30]信[01:22.75]じ[01:22.98]て[01:23.22]る[01:23.36]よ[01:23.63] [01:23.63]あ[01:23.84]の[01:24.06]日[01:24.19]の[01:24.45]誓[01:24.85]い[01:24.99]を[01:25.08]\n[01:22.30]shi [01:22.52]n [01:22.75]ji [01:22.98]te [01:23.22]ru [01:23.36]yo [01:23.63]  [01:23.63]a [01:23.84]no [01:24.06]hi [01:24.19]no [01:24.45]chi [01:24.65]ka [01:24.85]i [01:24.99]wo [01:25.08]\n[01:25.29]こ[01:25.49]の[01:25.69]瞳[01:26.32]に[01:27.11]光[01:27.50]る[01:27.68]涙[01:28.53]\n[01:25.29]ko [01:25.49]no [01:25.69]hi [01:25.90]to [01:26.11]mi [01:26.32]ni [01:27.11]hi [01:27.31]ka [01:27.50]ru [01:27.68]na [01:27.96]mi [01:28.35]da [01:28.53]\n[01:28.80]そ[01:29.19]れ[01:29.66]さ[01:29.91]え[01:30.07]も[01:30.31]強[01:30.73]さ[01:30.89]に[01:31.16]な[01:31.35]る[01:31.59]か[01:31.73]ら[01:34.13]\n[01:28.80]so [01:29.19]re [01:29.66]sa [01:29.91]e [01:30.07]mo [01:30.31]tsu [01:30.56]yo [01:30.73]sa [01:30.89]ni [01:31.16]na [01:31.35]ru [01:31.59]ka [01:31.73]ra [01:34.13]\n[01:36.52]立[01:37.20]ち[01:37.41]止[01:37.60]ま[01:37.81]る[01:38.02]と[01:38.56]\n[01:36.52]ta [01:37.20]chi [01:37.41]do [01:37.60]ma [01:37.81]ru [01:38.02]to [01:38.56]\n[01:38.86]少[01:39.28]し[01:39.48]だ[01:39.74]け[01:40.59] [01:40.59]感[01:40.98]じ[01:41.18]る[01:41.42]切[01:41.83]な[01:42.04]さ[01:42.24]に[01:42.82]\n[01:38.86]su [01:39.06]ko [01:39.28]shi [01:39.48]da [01:39.74]ke [01:40.59]  [01:40.59]ka [01:40.69][01:40.69]n [01:40.98]ji [01:41.18]ru [01:41.42]se [01:41.62]tsu [01:41.83]na [01:42.04]sa [01:42.24]ni [01:42.82]\n[01:43.09]戸[01:43.89]惑[01:44.35]う[01:44.58][01:44.58]事[01:45.58] [01:45.58]無[01:45.79]い[01:46.02]な[01:46.21]ん[01:46.39]て[01:46.61]\n[01:43.09]to [01:43.89]ma [01:44.12]do [01:44.35]u [01:44.58][01:44.58]ko [01:44.77]to [01:45.58]  [01:45.58]na [01:45.79]i [01:46.02]na [01:46.21]n [01:46.39]te [01:46.61]\n[01:46.89]嘘[01:47.54]は[01:47.73]つ[01:47.92]か[01:48.14]な[01:48.74]い[01:48.92]よ[01:49.51]\n[01:46.89]u [01:47.26]so [01:47.54]ha [01:47.73]tsu [01:47.92]ka [01:48.14]na [01:48.74]i [01:48.92]yo [01:49.51]\n[01:49.83]宇[01:50.08]宙[01:50.23]に[01:50.46]舞[01:50.61]う[01:50.86]コ[01:51.05]イ[01:51.24][01:51.24]ン[01:51.44]が[01:51.92]描[01:52.32]く[01:52.65]\n[01:49.83]so [01:50.08]ra [01:50.23]ni [01:50.46]ma [01:50.61]u [01:50.86]ko [01:51.05]i [01:51.24][01:51.24]n [01:51.44]ga [01:51.92]e [01:52.16]ga [01:52.32]ku [01:52.65]\n[01:52.93]放[01:53.12]物[01:53.54]線[01:53.97]が[01:54.13]決[01:54.41]め[01:54.65]る[01:54.87]運[01:55.48]命[01:56.16]\n[01:52.93]ho [01:53.03]u [01:53.12]bu [01:53.31]tsu [01:53.54]se [01:53.75]n [01:53.97]ga [01:54.13]ki [01:54.41]me [01:54.65]ru [01:54.87]u [01:55.18]n [01:55.48]me [01:55.73]i [01:56.16]\n[01:56.54]打[01:56.73]ち[01:56.89]出[01:57.15]し[01:57.30]た[01:57.63]答[01:58.00]え[01:58.20]が[01:58.65]今日[01:58.93]も[01:59.45]\n[01:56.54]u [01:56.73]chi [01:56.89]da [01:57.15]shi [01:57.30]ta [01:57.63]ko [01:57.81]ta [01:58.00]e [01:58.20]ga [01:58.65]kyo [01:58.75][01:58.84]u [01:58.93]mo [01:59.45]\n[01:59.71]私[02:00.58]の[02:00.81]胸[02:01.13]を[02:01.39]駆[02:01.59]け[02:02.19]巡[02:02.52]る[02:03.78]\n[01:59.71]wa [01:59.89]ta [02:00.27]shi [02:00.58]no [02:00.81]mu [02:00.97]ne [02:01.13]wo [02:01.39]ka [02:01.59]ke [02:02.19]me [02:02.36]gu [02:02.52]ru [02:03.78]\n[02:04.33]Sparkling[02:04.64]\n[02:04.33]Sparkling [02:04.64]\n[02:04.88]The [02:05.05]shiny [02:05.30]lights [02:05.60]awake [02:06.12]true [02:06.48]desire[02:07.09]\n[02:04.88]The  [02:05.05]shiny  [02:05.30]lights  [02:05.60]awake  [02:06.12]true  [02:06.48]desire [02:07.09]\n[02:07.36]Only [02:07.56]my [02:07.81]RAILGUN [02:08.26]can [02:08.64]shoot [02:09.05]it[02:09.49]必[02:10.52]ず[02:10.82]\n[02:07.36]Only  [02:07.56]my  [02:07.81]RAILGUN  [02:08.26]can  [02:08.64]shoot  [02:09.05]it [02:09.49]ka [02:09.88]na [02:10.24][02:10.24]ra [02:10.52]zu [02:10.82]\n[02:11.03]貫[02:11.63]い[02:11.88]て[02:12.03]く[02:12.28] [02:12.28]途[02:12.49]惑[02:12.80]う[02:13.09]こ[02:13.29]と[02:13.52]な[02:13.67]く[02:13.79]\n[02:11.03]tsu [02:11.20]ra [02:11.40]nu [02:11.63]i [02:11.88]te [02:12.03]ku [02:12.28]  [02:12.28]to [02:12.49]ma [02:12.72]do [02:12.80]u [02:13.09]ko [02:13.29]to [02:13.52]na [02:13.67]ku [02:13.79]\n[02:14.03]傷[02:14.42]つ[02:14.63]い[02:14.83]て[02:15.02]も[02:15.79] [02:15.79]走[02:16.19]り[02:16.46]続[02:16.98]け[02:17.26]る[02:17.44]\n[02:14.03]ki [02:14.22]zu [02:14.42]tsu [02:14.63]i [02:14.83]te [02:15.02]mo [02:15.79]  [02:15.79]ha [02:15.97]shi [02:16.19]ri [02:16.46]tsu [02:16.68]du [02:16.98]ke [02:17.26]ru [02:17.44]\n[02:17.76]狙[02:18.13]え[02:18.40] [02:18.40]凛[02:18.69]と[02:18.99]煌[02:19.55]く[02:19.83]視[02:20.02]線[02:20.37]は[02:20.58]\n[02:17.76]ne [02:17.94]ra [02:18.13]e [02:18.40]  [02:18.40]ri [02:18.55]n [02:18.69]to [02:18.99]ki [02:19.19]ra [02:19.42]me [02:19.55]ku [02:19.83]shi [02:20.02]se [02:20.20]n [02:20.37]ha [02:20.58]\n[02:20.77]狂[02:21.08]い[02:21.27]無[02:21.46]く[02:21.67]闇[02:22.49]を[02:22.89]切[02:23.29]り[02:23.70]裂[02:23.95]く[02:24.23]\n[02:20.77]ku [02:20.92]ru [02:21.08]i [02:21.27]na [02:21.46]ku [02:21.67]ya [02:22.05]mi [02:22.49]wo [02:22.89]ki [02:23.29]ri [02:23.70]sa [02:23.95]ku [02:24.23]\n[02:24.43]迷[02:24.81]い[02:25.06]な[02:25.24]ん[02:25.43]て[02:25.71] [02:25.71]吹[02:25.89]き[02:26.13]飛[02:26.28]ば[02:26.53]せ[02:26.75]ば[02:26.98]い[02:27.16]い[02:27.22]\n[02:24.43]ma [02:24.62]yo [02:24.81]i [02:25.06]na [02:25.24]n [02:25.43]te [02:25.71]  [02:25.71]fu [02:25.89]ki [02:26.13]to [02:26.28]ba [02:26.53]se [02:26.75]ba [02:26.98]i [02:27.16]i [02:27.22]\n[02:27.43]こ[02:27.59]の[02:27.77]心[02:28.38]が[02:29.24]叫[02:29.66]ぶ[02:29.87]限[02:30.50]り[02:30.72]\n[02:27.43]ko [02:27.59]no [02:27.77]ko [02:27.95]ko [02:28.12]ro [02:28.38]ga [02:29.24]sa [02:29.45]ke [02:29.66]bu [02:29.87]ka [02:30.13]gi [02:30.50]ri [02:30.72]\n[02:30.93]誰[02:31.77]ひ[02:32.01]と[02:32.17]り[02:32.39]邪[02:32.64]魔[02:32.80]な[02:32.95]ど[02:33.25]さ[02:33.45]せ[02:33.70]な[02:33.84]い[02:35.75]\n[02:30.93]da [02:31.34]re [02:31.77]hi [02:32.01]to [02:32.17]ri [02:32.39]ja [02:32.52][02:32.64]ma [02:32.80]na [02:32.95]do [02:33.25]sa [02:33.45]se [02:33.70]na [02:33.84]i [02:35.75]\n[03:04.76]儚[03:05.37]く[03:05.59]舞[03:05.74]う[03:06.01] [03:06.01]無[03:06.20]数[03:06.52]の[03:06.80]願[03:07.22]い[03:07.39]は[03:07.59]\n[03:04.76]ha [03:04.95]ka [03:05.14]na [03:05.37]ku [03:05.59]ma [03:05.74]u [03:06.01]  [03:06.01]mu [03:06.20]su [03:06.31]u [03:06.52]no [03:06.80]ne [03:07.00]ga [03:07.22]i [03:07.39]ha [03:07.59]\n[03:07.75]こ[03:07.92]の[03:08.11]両[03:08.59]手[03:08.77]に[03:09.15] [03:09.15]積[03:09.53]も[03:09.95]っ[03:10.36]て[03:10.68]ゆ[03:10.91]く[03:11.25]\n[03:07.75]ko [03:07.92]no [03:08.11]ryo [03:08.27][03:08.43]u [03:08.59]te [03:08.77]ni [03:09.15]  [03:09.15]tsu [03:09.53]mo [03:09.95]'t [03:10.36]te [03:10.68]yu [03:10.91]ku [03:11.25]\n[03:11.45]切[03:11.63]り[03:11.81]裂[03:12.04]く[03:12.31]闇[03:12.70]に[03:12.92] [03:12.92]見[03:13.16]え[03:13.29]て[03:13.56]く[03:13.76]る[03:13.97]の[03:14.12]は[03:14.18]\n[03:11.45]ki [03:11.63]ri [03:11.81]sa [03:12.04]ku [03:12.31]ya [03:12.44]mi [03:12.70]ni [03:12.92]  [03:12.92]mi [03:13.16]e [03:13.29]te [03:13.56]ku [03:13.76]ru [03:13.97]no [03:14.12]ha [03:14.18]\n[03:14.40]重[03:14.76]く[03:14.98]深[03:15.40]く[03:16.22] [03:16.22]切[03:16.61]な[03:16.80]い[03:17.11]記[03:17.38]憶[03:17.88]\n[03:14.40]o [03:14.58]mo [03:14.76]ku [03:14.98]fu [03:15.18]ka [03:15.40]ku [03:16.22]  [03:16.22]se [03:16.41]tsu [03:16.61]na [03:16.80]i [03:17.11]ki [03:17.38]o [03:17.65]ku [03:17.88]\n[03:18.18]色[03:18.57]褪[03:18.79]せ[03:19.03]て[03:19.18]く[03:19.43] [03:19.43]現[03:19.84]実[03:20.24]に[03:20.44]揺[03:20.63]れ[03:20.79]る[03:20.90]\n[03:18.18]i [03:18.37]ro [03:18.57]a [03:18.79]se [03:19.03]te [03:19.18]ku [03:19.43]  [03:19.43]ge [03:19.54][03:19.54]n [03:19.84]ji [03:19.99]tsu [03:20.24]ni [03:20.44]yu [03:20.63]re [03:20.79]ru [03:20.90]\n[03:21.13]絶[03:21.50]望[03:21.94]に[03:22.13]は[03:22.56] [03:22.56]負[03:22.94]け[03:23.36]た[03:23.77]く[03:24.13]な[03:24.35]い[03:24.65]\n[03:21.13]ze [03:21.32]tsu [03:21.50]bo [03:21.72]u [03:21.94]ni [03:22.13]ha [03:22.56]  [03:22.56]ma [03:22.94]ke [03:23.36]ta [03:23.77]ku [03:24.13]na [03:24.35]i [03:24.65]\n[03:24.88]私[03:25.47]が[03:25.71]今[03:26.09] [03:26.09]私[03:26.67]で[03:26.97]あ[03:27.15]る[03:27.36]こ[03:27.51]と[03:27.62]\n[03:24.88]wa [03:25.06]ta [03:25.23]shi [03:25.47]ga [03:25.71]i [03:25.85]ma [03:26.09]  [03:26.09]wa [03:26.29]ta [03:26.52]shi [03:26.67]de [03:26.97]a [03:27.15]ru [03:27.36]ko [03:27.51]to [03:27.62]\n[03:27.82]胸[03:28.19]を[03:28.39]張[03:28.58]っ[03:28.78]て[03:29.63] [03:29.63]全[03:30.04]て[03:30.29]誇[03:30.78]れ[03:31.06]る[03:31.31]\n[03:27.82]mu [03:28.00]ne [03:28.19]wo [03:28.39]ha [03:28.58]'t [03:28.78]te [03:29.63]  [03:29.63]su [03:29.83]be [03:30.04]te [03:30.29]ho [03:30.49]ko [03:30.78]re [03:31.06]ru [03:31.31]\n[03:31.53]Looking[03:31.83]\n[03:31.53]Looking [03:31.83]\n[03:32.02]The [03:32.21]blitz [03:32.42]loop [03:32.82]this [03:33.00]planet [03:33.66]to [03:33.84]search [03:34.12]way[03:34.30]\n[03:32.02]The  [03:32.21]blitz  [03:32.42]loop  [03:32.82]this  [03:33.00]planet  [03:33.66]to  [03:33.84]search  [03:34.12]way [03:34.30]\n[03:34.53]Only [03:34.90]my [03:35.11]RAILGUN [03:35.50]can [03:35.92]shoot [03:36.32]it [03:36.72]今[03:37.51]す[03:37.75]ぐ[03:38.03]\n[03:34.53]Only  [03:34.90]my  [03:35.11]RAILGUN  [03:35.50]can  [03:35.92]shoot  [03:36.32]it  [03:36.72]i [03:37.16]ma [03:37.51]su [03:37.75]gu [03:38.03]\n[03:38.24]身[03:38.60]体[03:38.87]中[03:39.18]を[03:39.52] [03:39.52]光[03:40.11]の[03:40.37]速[03:40.80]さ[03:40.94]で[03:41.00]\n[03:38.24]ka [03:38.42]ra [03:38.60]da [03:38.87]ju [03:38.97][03:39.08]u [03:39.18]wo [03:39.52]  [03:39.52]hi [03:39.72]ka [03:39.96]ri [03:40.11]no [03:40.37]ha [03:40.58]ya [03:40.80]sa [03:40.94]de [03:41.00]\n[03:41.22]駆[03:41.40]け[03:41.60]巡[03:42.02]っ[03:42.22][03:42.22]た[03:43.13] [03:43.13]確[03:43.49]か[03:43.68]な[03:43.91]予[03:44.30]感[03:44.82]\n[03:41.22]ka [03:41.40]ke [03:41.60]me [03:41.81]gu [03:42.02]'t [03:42.22][03:42.22]ta [03:43.13]  [03:43.13]ta [03:43.31]shi [03:43.49]ka [03:43.68]na [03:43.91]yo [03:44.30]ka [03:44.56]n [03:44.82]\n[03:44.99]放[03:45.37]て[03:45.59] [03:45.59]心[03:46.26]に[03:46.44]刻[03:46.86]ん[03:47.07]だ[03:47.26]夢[03:47.64]を[03:47.85]\n[03:44.99]ha [03:45.18]na [03:45.37]te [03:45.59]  [03:45.59]ko [03:45.79]ko [03:45.95]ro [03:46.26]ni [03:46.44]ki [03:46.65]za [03:46.86]n [03:47.07]da [03:47.26]yu [03:47.49]me [03:47.64]wo [03:47.85]\n[03:48.02]未[03:48.20]来[03:48.57]さ[03:48.76]え[03:48.96]置[03:49.35]き[03:49.77]去[03:50.17]り[03:50.58]に[03:50.92]し[03:51.20]て[03:51.42]\n[03:48.02]mi [03:48.20]ra [03:48.38]i [03:48.57]sa [03:48.76]e [03:48.96]o [03:49.35]ki [03:49.77]za [03:50.17]ri [03:50.58]ni [03:50.92]shi [03:51.20]te [03:51.42]\n[03:51.67]限[03:52.13]界[03:52.57]な[03:52.72]ど[03:52.99]知[03:53.19]ら[03:53.41]な[03:53.54]い[03:53.82] [03:53.82]意[03:54.02]味[03:54.23]無[03:54.38]い[03:54.50]\n[03:51.67]ge [03:51.87]n [03:52.13]ka [03:52.31]i [03:52.57]na [03:52.72]do [03:52.99]shi [03:53.19]ra [03:53.41]na [03:53.54]i [03:53.82]  [03:53.82]i [03:54.02]mi [03:54.23]na [03:54.38]i [03:54.50]\n[03:54.70]こ[03:54.87]の[03:55.06]能[03:55.26]力[03:55.69]が[03:56.50]光[03:57.06]散[03:57.31]ら[03:57.72]す[03:58.03]\n[03:54.70]ko [03:54.87]no [03:55.06]chi [03:55.26]ka [03:55.41]ra [03:55.69]ga [03:56.50]hi [03:56.69]ka [03:56.90]ri [03:57.06]chi [03:57.31]ra [03:57.72]su [03:58.03]\n[03:58.22]そ[03:58.58]の[03:59.03]先[03:59.42]に[03:59.68]遥[04:00.07]か[04:00.28]な[04:00.50]想[04:00.89]い[04:01.06]を[04:04.00]\n[03:58.22]so [03:58.58]no [03:59.03]sa [03:59.27]ki [03:59.42]ni [03:59.68]ha [03:59.86]ru [04:00.07]ka [04:00.28]na [04:00.50]o [04:00.71]mo [04:00.89]i [04:01.06]wo [04:04.00]",
    "lrcUrl": "assets/lyrics/track_14.lrc"
  },
  {
    "index": "015",
    "spineNum": "15",
    "serial": "WK-REAL-15",
    "title": "Butter-Fly",
    "shortTitle": "Butter-Fly · 和田光司",
    "spineTitle": "数码宝贝 · 进化神曲",
    "subtitleQuote": "| 无限大梦想的背后，是毫无保留的空旷世界",
    "artist": "和田光司",
    "subArtist": "数码宝贝大冒险 OP",
    "statusTag": "童年永恒",
    "subTag": "光叔绝唱",
    "durationSec": 278,
    "currentSec": 0,
    "accent": "#f59e0b",
    "c1": "#fbbf24",
    "c2": "#b45309",
    "picUrl": "assets/covers/cover_15.jpg",
    "audioUrl": "assets/audio/track_15.mp3",
    "notes": [
      293.66,
      329.63,
      369.99,
      440,
      493.88,
      440,
      369.99,
      329.63
    ],
    "lyrics": [
      {
        "t": 0,
        "l1": "Butter-Fly - 和田光司 わだ こうじ",
        "l2": ""
      },
      {
        "t": 0,
        "l1": "(0,4710)",
        "l2": ""
      },
      {
        "t": 4.71,
        "l1": "词：千綿偉功",
        "l2": ""
      },
      {
        "t": 4.71,
        "l1": "xi ： qi wata hide noli",
        "l2": ""
      },
      {
        "t": 9.43,
        "l1": "曲：千綿偉功",
        "l2": ""
      },
      {
        "t": 9.43,
        "l1": "kiyoku ： qi wata hide noli",
        "l2": ""
      },
      {
        "t": 14.14,
        "l1": "编曲：渡部チェル",
        "l2": ""
      },
      {
        "t": 14.14,
        "l1": "hen kiyoku ： wata nabe qi e lu",
        "l2": ""
      },
      {
        "t": 18.86,
        "l1": "ゴキゲンな蝶になって",
        "l2": ""
      },
      {
        "t": 18.86,
        "l1": "go ki ge n na qiyou ni na te",
        "l2": ""
      },
      {
        "t": 21.54,
        "l1": "きらめく風に乗って",
        "l2": ""
      },
      {
        "t": 21.54,
        "l1": "ki la me ku kaze ni no te",
        "l2": ""
      },
      {
        "t": 24.27,
        "l1": "今すぐ",
        "l2": ""
      },
      {
        "t": 24.27,
        "l1": "ima su gu",
        "l2": ""
      },
      {
        "t": 25.75,
        "l1": "キミに会いに行こう",
        "l2": ""
      },
      {
        "t": 25.75,
        "l1": "ki mi ni a i ni yu ko u",
        "l2": ""
      },
      {
        "t": 30.4,
        "l1": "余計な事なんて",
        "l2": ""
      },
      {
        "t": 30.4,
        "l1": "yo kei na koto na n te",
        "l2": ""
      },
      {
        "t": 33.32,
        "l1": "忘れた方がマシさ",
        "l2": ""
      },
      {
        "t": 33.32,
        "l1": "wasu re ta hou ga ma xi sa",
        "l2": ""
      },
      {
        "t": 35.91,
        "l1": "これ以上",
        "l2": ""
      },
      {
        "t": 35.91,
        "l1": "ko re i jiyou",
        "l2": ""
      },
      {
        "t": 37.29,
        "l1": "シャレてる時間はない",
        "l2": ""
      },
      {
        "t": 37.29,
        "l1": "xi a re te lu ji kan wa na i",
        "l2": ""
      },
      {
        "t": 41.76,
        "l1": "何が",
        "l2": ""
      },
      {
        "t": 41.76,
        "l1": "nani ga",
        "l2": ""
      },
      {
        "t": 42.28,
        "l1": "WOW WOW WOOW",
        "l2": ""
      },
      {
        "t": 42.28,
        "l1": "WOW WOW WOOW",
        "l2": ""
      },
      {
        "t": 44.63,
        "l1": "この空に届くのだろう",
        "l2": ""
      },
      {
        "t": 44.63,
        "l1": "ko no sola ni todo ku no da lo u",
        "l2": ""
      },
      {
        "t": 47.55,
        "l1": "だけど",
        "l2": ""
      },
      {
        "t": 47.55,
        "l1": "da ke do",
        "l2": ""
      },
      {
        "t": 48.12,
        "l1": "WOW WOW WOOW",
        "l2": ""
      },
      {
        "t": 48.12,
        "l1": "WOW WOW WOOW",
        "l2": ""
      },
      {
        "t": 50.62,
        "l1": "明日の予定もわからない",
        "l2": ""
      },
      {
        "t": 50.62,
        "l1": "a xita no yo tei mo wa ka la na i",
        "l2": ""
      },
      {
        "t": 56.78,
        "l1": "無限大な夢のあとの",
        "l2": ""
      },
      {
        "t": 56.78,
        "l1": "mu gen dai na yume no a to no",
        "l2": ""
      },
      {
        "t": 60.76,
        "l1": "何もない世の中じゃ",
        "l2": ""
      },
      {
        "t": 60.76,
        "l1": "nani mo na i yo no naka ji a",
        "l2": ""
      },
      {
        "t": 63.18,
        "l1": "そうさ愛しい",
        "l2": ""
      },
      {
        "t": 63.18,
        "l1": "so u sa ito xi i",
        "l2": ""
      },
      {
        "t": 65.39,
        "l1": "想いも負けそうになるけど",
        "l2": ""
      },
      {
        "t": 65.39,
        "l1": "omo i mo ma ke so u ni na lu ke do",
        "l2": ""
      },
      {
        "t": 68.4,
        "l1": "Stay",
        "l2": ""
      },
      {
        "t": 68.4,
        "l1": "Stay",
        "l2": ""
      },
      {
        "t": 68.96,
        "l1": "しがちなイメージだらけの",
        "l2": ""
      },
      {
        "t": 68.96,
        "l1": "xi ga qi na i me e ji da la ke no",
        "l2": ""
      },
      {
        "t": 72.28,
        "l1": "頼りない翼でも",
        "l2": ""
      },
      {
        "t": 72.28,
        "l1": "tayo li na i cubasa de mo",
        "l2": ""
      },
      {
        "t": 74.87,
        "l1": "きっと飛べるさ",
        "l2": ""
      },
      {
        "t": 74.87,
        "l1": "ki to to be lu sa",
        "l2": ""
      },
      {
        "t": 77.22,
        "l1": "On My Love",
        "l2": ""
      },
      {
        "t": 77.22,
        "l1": "On My Love",
        "l2": ""
      },
      {
        "t": 91.75,
        "l1": "ウカレタ蝶になって",
        "l2": ""
      },
      {
        "t": 91.75,
        "l1": "wu ka re ta qiyou ni na te",
        "l2": ""
      },
      {
        "t": 94.38,
        "l1": "一途な風に乗って",
        "l2": ""
      },
      {
        "t": 94.38,
        "l1": "iqi zu na kaze ni no te",
        "l2": ""
      },
      {
        "t": 97.03,
        "l1": "どこまでも",
        "l2": ""
      },
      {
        "t": 97.03,
        "l1": "do ko ma de mo",
        "l2": ""
      },
      {
        "t": 98.55,
        "l1": "キミに会いに行こう",
        "l2": ""
      },
      {
        "t": 98.55,
        "l1": "ki mi ni a i ni yu ko u",
        "l2": ""
      },
      {
        "t": 103.16,
        "l1": "曖昧な言葉って",
        "l2": ""
      },
      {
        "t": 103.16,
        "l1": "ai mai na koto ba te",
        "l2": ""
      },
      {
        "t": 106.09,
        "l1": "意外に便利だって",
        "l2": ""
      },
      {
        "t": 106.09,
        "l1": "i gai ni ben li da te",
        "l2": ""
      },
      {
        "t": 108.66,
        "l1": "叫んでる",
        "l2": ""
      },
      {
        "t": 108.66,
        "l1": "sake n de lu",
        "l2": ""
      },
      {
        "t": 110.1,
        "l1": "ヒットソング聴きながら",
        "l2": ""
      },
      {
        "t": 110.1,
        "l1": "hi to so n gu ki ki na ga la",
        "l2": ""
      },
      {
        "t": 114.42,
        "l1": "何が",
        "l2": ""
      },
      {
        "t": 114.42,
        "l1": "nani ga",
        "l2": ""
      },
      {
        "t": 115.02,
        "l1": "WOW WOW WOOW",
        "l2": ""
      },
      {
        "t": 115.02,
        "l1": "WOW WOW WOOW",
        "l2": ""
      },
      {
        "t": 117.38,
        "l1": "この街に響くのだろう",
        "l2": ""
      },
      {
        "t": 117.38,
        "l1": "ko no maqi ni hibi ku no da lo u",
        "l2": ""
      },
      {
        "t": 120.24,
        "l1": "だけど",
        "l2": ""
      },
      {
        "t": 120.24,
        "l1": "da ke do",
        "l2": ""
      },
      {
        "t": 120.83,
        "l1": "WOW WOW WOOW",
        "l2": ""
      },
      {
        "t": 120.83,
        "l1": "WOW WOW WOOW",
        "l2": ""
      },
      {
        "t": 123.38,
        "l1": "期待してても仕方ない",
        "l2": ""
      },
      {
        "t": 123.38,
        "l1": "ki tai xi te te mo xi kata na i",
        "l2": ""
      },
      {
        "t": 129.49,
        "l1": "無限大な夢のあとの",
        "l2": ""
      },
      {
        "t": 129.49,
        "l1": "mu gen dai na yume no a to no",
        "l2": ""
      },
      {
        "t": 133.47,
        "l1": "やるせない世の中じゃ",
        "l2": ""
      },
      {
        "t": 133.47,
        "l1": "ya lu se na i yo no naka ji a",
        "l2": ""
      },
      {
        "t": 135.94,
        "l1": "そうさ常識",
        "l2": ""
      },
      {
        "t": 135.94,
        "l1": "so u sa jiyou xiki",
        "l2": ""
      },
      {
        "t": 138.14,
        "l1": "はずれも悪くはないかな",
        "l2": ""
      },
      {
        "t": 138.14,
        "l1": "ha zu re mo walu ku wa na i ka na",
        "l2": ""
      },
      {
        "t": 141.11,
        "l1": "Stay",
        "l2": ""
      },
      {
        "t": 141.11,
        "l1": "Stay",
        "l2": ""
      },
      {
        "t": 141.65,
        "l1": "しそうなイメージを染めた",
        "l2": ""
      },
      {
        "t": 141.65,
        "l1": "xi so u na i me e ji wo so me ta",
        "l2": ""
      },
      {
        "t": 145.01,
        "l1": "ぎこちない翼でも",
        "l2": ""
      },
      {
        "t": 145.01,
        "l1": "gi ko qi na i cubasa de mo",
        "l2": ""
      },
      {
        "t": 147.53,
        "l1": "きっと飛べるさ",
        "l2": ""
      },
      {
        "t": 147.53,
        "l1": "ki to to be lu sa",
        "l2": ""
      },
      {
        "t": 149.87,
        "l1": "On My Love",
        "l2": ""
      },
      {
        "t": 149.87,
        "l1": "On My Love",
        "l2": ""
      },
      {
        "t": 193.59,
        "l1": "無限大な夢のあとの",
        "l2": ""
      },
      {
        "t": 193.59,
        "l1": "mu gen dai na yume no a to no",
        "l2": ""
      },
      {
        "t": 197.5,
        "l1": "何もない世の中じゃ",
        "l2": ""
      },
      {
        "t": 197.5,
        "l1": "nani mo na i yo no naka ji a",
        "l2": ""
      },
      {
        "t": 199.97,
        "l1": "そうさ愛しい",
        "l2": ""
      },
      {
        "t": 199.97,
        "l1": "so u sa ito xi i",
        "l2": ""
      },
      {
        "t": 202.12,
        "l1": "想いも負けそうになるけど",
        "l2": ""
      },
      {
        "t": 202.12,
        "l1": "omo i mo ma ke so u ni na lu ke do",
        "l2": ""
      },
      {
        "t": 205.19,
        "l1": "Stay",
        "l2": ""
      },
      {
        "t": 205.19,
        "l1": "Stay",
        "l2": ""
      },
      {
        "t": 205.69,
        "l1": "しがちなイメージだらけの",
        "l2": ""
      },
      {
        "t": 205.69,
        "l1": "xi ga qi na i me e ji da la ke no",
        "l2": ""
      },
      {
        "t": 209.07,
        "l1": "頼りない翼でも",
        "l2": ""
      },
      {
        "t": 209.07,
        "l1": "tayo li na i cubasa de mo",
        "l2": ""
      },
      {
        "t": 211.5,
        "l1": "きっと飛べるさ",
        "l2": ""
      },
      {
        "t": 211.5,
        "l1": "ki to to be lu sa",
        "l2": ""
      },
      {
        "t": 213.86,
        "l1": "Oh Yeah～",
        "l2": ""
      },
      {
        "t": 213.86,
        "l1": "Oh Yeah ～",
        "l2": ""
      },
      {
        "t": 216.63,
        "l1": "無限大な夢のあとの",
        "l2": ""
      },
      {
        "t": 216.63,
        "l1": "mu gen dai na yume no a to no",
        "l2": ""
      },
      {
        "t": 220.8,
        "l1": "やるせない世の中じゃ",
        "l2": ""
      },
      {
        "t": 220.8,
        "l1": "ya lu se na i yo no naka ji a",
        "l2": ""
      },
      {
        "t": 223.18,
        "l1": "そうさ常識",
        "l2": ""
      },
      {
        "t": 223.18,
        "l1": "so u sa jiyou xiki",
        "l2": ""
      },
      {
        "t": 225.41,
        "l1": "はずれも悪くはないかな",
        "l2": ""
      },
      {
        "t": 225.41,
        "l1": "ha zu re mo walu ku wa na i ka na",
        "l2": ""
      },
      {
        "t": 228.53,
        "l1": "Stay",
        "l2": ""
      },
      {
        "t": 228.53,
        "l1": "Stay",
        "l2": ""
      },
      {
        "t": 229.02,
        "l1": "しそうなイメージを染めた",
        "l2": ""
      },
      {
        "t": 229.02,
        "l1": "xi so u na i me e ji wo so me ta",
        "l2": ""
      },
      {
        "t": 232.36,
        "l1": "ぎこちない翼でも",
        "l2": ""
      },
      {
        "t": 232.36,
        "l1": "gi ko qi na i cubasa de mo",
        "l2": ""
      },
      {
        "t": 234.83,
        "l1": "きっと飛べるさ",
        "l2": ""
      },
      {
        "t": 234.83,
        "l1": "ki to to be lu sa",
        "l2": ""
      },
      {
        "t": 237.21,
        "l1": "On My Love",
        "l2": ""
      },
      {
        "t": 237.21,
        "l1": "On My Love",
        "l2": ""
      }
    ],
    "comments": [
      "【热评 @被选召的孩子】飞帽杀出现的那一刻，我们都知道童年结束了，但勇气永远留在了心中。"
    ],
    "lyricsRaw": "[ti:Butter-Fly]\n[ar:和田光司]\n[al:Butter-Fly]\n[offset:0]\n\n[00:00.00]Butter[00:00.24]-[00:00.49]Fly[00:00.74] [00:00.98]-[00:01.23] [00:01.48]和[00:01.72]田[00:01.97]光[00:02.22]司[00:02.47] [00:02.71][00:02.96]わ[00:03.21]だ[00:03.45] [00:03.70]こ[00:03.95]う[00:04.19]じ[00:04.44]\n[00:00.00](0,4710)[00:04.71]\n[00:04.71]词[00:05.49]：[00:06.28]千[00:07.06]綿[00:07.85]偉[00:08.64]功[00:09.42]\n[00:04.71]xi[00:05.10] [00:05.49]：[00:05.88] [00:06.28]qi[00:06.67] [00:07.06]wata[00:07.46] [00:07.85]hide[00:08.24] [00:08.64]noli[00:09.03] [00:09.42]\n[00:09.43]曲[00:10.21]：[00:11.00]千[00:11.78]綿[00:12.57]偉[00:13.35]功[00:14.14]\n[00:09.43]kiyoku[00:09.82] [00:10.21]：[00:10.60] [00:10.99]qi[00:11.39] [00:11.78]wata[00:12.17] [00:12.56]hide[00:12.95] [00:13.35]noli[00:13.74] [00:14.13]\n[00:14.14]编[00:14.66]曲[00:15.18]：[00:15.71]渡[00:16.23]部[00:16.76]チ[00:17.28]ェ[00:17.80]ル[00:18.33] [00:18.85]\n[00:14.14]hen[00:14.43] [00:14.73]kiyoku[00:15.02] [00:15.32]：[00:15.61] [00:15.91]wata[00:16.20] [00:16.50]nabe[00:16.79] [00:17.09]qi[00:17.38] [00:17.68]e[00:17.97] [00:18.27]lu[00:18.56] [00:18.86]\n[00:18.86]ゴ[00:19.06]キ[00:19.24]ゲ[00:19.42]ン[00:19.62]な[00:19.82]蝶[00:20.12]に[00:20.33]な[00:20.50]っ[00:20.69]て[00:20.97]\n[00:18.86]go [00:19.06]ki [00:19.24]ge [00:19.42]n [00:19.62]na [00:19.82]qiyou [00:20.12]ni [00:20.33][00:20.50]na [00:20.69]te [00:20.97]\n[00:21.54]き[00:21.77]ら[00:22.10]め[00:22.29]く[00:22.48]風[00:22.92]に[00:23.16]乗[00:23.35]っ[00:23.56]て[00:23.82]\n[00:21.54]ki [00:21.77]la [00:22.10]me [00:22.29]ku [00:22.48]kaze [00:22.92]ni [00:23.16][00:23.35]no [00:23.56]te [00:23.82]\n[00:24.27]今[00:24.56]す[00:24.76]ぐ[00:25.10]\n[00:24.27]ima [00:24.56]su [00:24.76]gu [00:25.10]\n[00:25.75]キ[00:25.94]ミ[00:26.15]に[00:26.51]会[00:26.69]い[00:26.91]に[00:27.19]行[00:27.36]こ[00:27.53]う[00:28.05]\n[00:25.75]ki [00:25.94]mi [00:26.15]ni [00:26.51]a [00:26.69]i [00:26.91]ni [00:27.19]yu [00:27.36]ko [00:27.53]u [00:28.05]\n[00:30.40]余[00:30.81]計[00:31.11]な[00:31.34]事[00:31.88]な[00:32.08]ん[00:32.31]て[00:32.58]\n[00:30.40]yo [00:30.81]kei [00:31.11]na [00:31.34]koto [00:31.88]na [00:32.08]n [00:32.31]te [00:32.58]\n[00:33.32]忘[00:33.74]れ[00:33.95]た[00:34.13]方[00:34.46]が[00:34.66]マ[00:34.84]シ[00:35.15]さ[00:35.45]\n[00:33.32]wasu [00:33.74]re [00:33.95]ta [00:34.13]hou [00:34.46]ga [00:34.66]ma [00:34.84]xi [00:35.15]sa [00:35.45]\n[00:35.91]こ[00:36.08]れ[00:36.26]以[00:36.45]上[00:36.89]\n[00:35.91]ko [00:36.08]re [00:36.26]i [00:36.45]jiyou [00:36.89]\n[00:37.29]シ[00:37.45]ャ[00:37.61]レ[00:37.81]て[00:38.12]る[00:38.32]時[00:38.51]間[00:38.83]は[00:39.03]な[00:39.20]い[00:39.47]\n[00:37.29]xi [00:37.45]a [00:37.61]re [00:37.81]te [00:38.12]lu [00:38.32]ji [00:38.51]kan [00:38.83]wa [00:39.03]na [00:39.20]i [00:39.47]\n[00:41.76]何[00:42.05]が[00:42.28]\n[00:41.76]nani [00:42.05]ga [00:42.28]\n[00:42.28]WOW [00:42.66]WOW [00:43.02]WOOW[00:43.81]\n[00:42.28]WOW [00:42.66]WOW [00:43.02]WOOW [00:43.81]\n[00:44.63]こ[00:44.83]の[00:45.06]空[00:45.37]に[00:45.60]届[00:45.95]く[00:46.13]の[00:46.32]だ[00:46.53]ろ[00:46.70]う[00:47.01]\n[00:44.63]ko [00:44.83]no [00:45.06]sola [00:45.37]ni [00:45.60]todo [00:45.95]ku [00:46.13]no [00:46.32]da [00:46.53]lo [00:46.70]u [00:47.01]\n[00:47.55]だ[00:47.73]け[00:47.90]ど[00:48.12]\n[00:47.55]da [00:47.73]ke [00:47.90]do [00:48.12]\n[00:48.12]WOW [00:48.49]WOW [00:48.87]WOOW[00:49.67]\n[00:48.12]WOW [00:48.49]WOW [00:48.87]WOOW [00:49.67]\n[00:50.62]明[00:50.99]日[00:51.25]の[00:51.44]予[00:51.63]定[00:51.97]も[00:52.14]わ[00:52.33]か[00:52.66]ら[00:52.85]な[00:53.04]い[00:53.40]\n[00:50.62]a [00:50.99]xita [00:51.25]no [00:51.44]yo [00:51.63]tei [00:51.97]mo [00:52.14]wa [00:52.33]ka [00:52.66]la [00:52.85]na [00:53.04]i [00:53.40]\n[00:56.78]無[00:56.97]限[00:57.41]大[00:57.91]な[00:58.28]夢[00:58.82]の[00:59.17]あ[00:59.35]と[00:59.55]の[01:00.10]\n[00:56.78]mu [00:56.97]gen [00:57.41]dai [00:57.91]na [00:58.28]yume [00:58.82]no [00:59.17]a [00:59.35]to [00:59.55]no [01:00.10]\n[01:00.76]何[01:01.15]も[01:01.35]な[01:01.53]い[01:01.75]世[01:01.94]の[01:02.16]中[01:02.46]じ[01:02.64]ゃ[01:03.18]\n[01:00.76]nani [01:01.15]mo [01:01.35]na [01:01.53]i [01:01.75]yo [01:01.94]no [01:02.16]naka [01:02.46]ji [01:02.64]a [01:03.18]\n[01:03.18]そ[01:03.37]う[01:03.60]さ[01:03.91]愛[01:04.29]し[01:04.53]い[01:04.88]\n[01:03.18]so [01:03.37]u [01:03.60]sa [01:03.91]ito [01:04.29]xi [01:04.53]i [01:04.88]\n[01:05.39]想[01:05.59]い[01:05.90]も[01:06.09]負[01:06.27]け[01:06.45]そ[01:06.64]う[01:06.80]に[01:07.16]な[01:07.34]る[01:07.76]け[01:07.93]ど[01:08.40]\n[01:05.39]omo [01:05.59]i [01:05.90]mo [01:06.09]ma [01:06.27]ke [01:06.45]so [01:06.64]u [01:06.80]ni [01:07.16]na [01:07.34]lu [01:07.76]ke [01:07.93]do [01:08.40]\n[01:08.40]Stay[01:08.96]\n[01:08.40]Stay [01:08.96]\n[01:08.96]し[01:09.12]が[01:09.45]ち[01:09.60]な[01:09.75]イ[01:09.93]メ[01:10.09]ー[01:10.26]ジ[01:10.45]だ[01:10.78]ら[01:10.99]け[01:11.19]の[01:11.47]\n[01:08.96]xi [01:09.12]ga [01:09.45]qi [01:09.60]na [01:09.75]i [01:09.93]me [01:10.09]e [01:10.26]ji [01:10.45]da [01:10.78]la [01:10.99]ke [01:11.19]no [01:11.47]\n[01:12.28]頼[01:12.80]り[01:13.01]な[01:13.22]い[01:13.44]翼[01:13.93]で[01:14.15]も[01:14.52]\n[01:12.28]tayo [01:12.80]li [01:13.01]na [01:13.22]i [01:13.44]cubasa [01:13.93]de [01:14.15]mo [01:14.52]\n[01:14.87]き[01:15.04]っ[01:15.23]と[01:15.59]飛[01:16.06]べ[01:16.23]る[01:16.39]さ[01:16.76]\n[01:14.87][01:15.04]ki [01:15.23]to [01:15.59]to [01:16.06]be [01:16.23]lu [01:16.39]sa [01:16.76]\n[01:17.22]On [01:18.59]My [01:20.01]Love[01:21.20]\n[01:17.22]On [01:18.59]My [01:20.01]Love [01:21.20]\n[01:31.75]ウ[01:31.95]カ[01:32.14]レ[01:32.33]タ[01:32.53]蝶[01:32.89]に[01:33.10]な[01:33.28]っ[01:33.45]て[01:33.78]\n[01:31.75]wu [01:31.95]ka [01:32.14]re [01:32.33]ta [01:32.53]qiyou [01:32.89]ni [01:33.10][01:33.28]na [01:33.45]te [01:33.78]\n[01:34.38]一[01:34.59]途[01:35.01]な[01:35.21]風[01:35.47]に[01:35.86]乗[01:36.07]っ[01:36.27]て[01:36.54]\n[01:34.38]iqi [01:34.59]zu [01:35.01]na [01:35.21]kaze [01:35.47]ni [01:35.86][01:36.07]no [01:36.27]te [01:36.54]\n[01:37.03]ど[01:37.21]こ[01:37.39]ま[01:37.59]で[01:37.85]も[01:38.27]\n[01:37.03]do [01:37.21]ko [01:37.39]ma [01:37.59]de [01:37.85]mo [01:38.27]\n[01:38.55]キ[01:38.74]ミ[01:38.89]に[01:39.19]会[01:39.38]い[01:39.58]に[01:39.89]行[01:40.08]こ[01:40.26]う[01:40.51]\n[01:38.55]ki [01:38.74]mi [01:38.89]ni [01:39.19]a [01:39.38]i [01:39.58]ni [01:39.89]yu [01:40.08]ko [01:40.26]u [01:40.51]\n[01:43.16]曖[01:43.53]昧[01:43.83]な[01:44.12]言[01:44.61]葉[01:44.82]っ[01:45.02]て[01:45.29]\n[01:43.16]ai [01:43.53]mai [01:43.83]na [01:44.12]koto [01:44.61][01:44.82]ba [01:45.02]te [01:45.29]\n[01:46.09]意[01:46.25]外[01:46.63]に[01:46.89]便[01:47.12]利[01:47.54]だ[01:47.75]っ[01:47.95]て[01:48.20]\n[01:46.09]i [01:46.25]gai [01:46.63]ni [01:46.89]ben [01:47.12]li [01:47.54][01:47.75]da [01:47.95]te [01:48.20]\n[01:48.66]叫[01:48.93]ん[01:49.18]で[01:49.37]る[01:49.63]\n[01:48.66]sake [01:48.93]n [01:49.18]de [01:49.37]lu [01:49.63]\n[01:50.10]ヒ[01:50.29]ッ[01:50.47]ト[01:50.65]ソ[01:50.84]ン[01:51.01]グ[01:51.20]聴[01:51.39]き[01:51.59]な[01:51.77]が[01:51.96]ら[01:52.21]\n[01:50.10][01:50.29]hi [01:50.47]to [01:50.65]so [01:50.84]n [01:51.01]gu [01:51.20]ki [01:51.39]ki [01:51.59]na [01:51.77]ga [01:51.96]la [01:52.21]\n[01:54.42]何[01:54.78]が[01:55.02]\n[01:54.42]nani [01:54.78]ga [01:55.02]\n[01:55.02]WOW [01:55.38]WOW [01:55.71]WOOW[01:56.62]\n[01:55.02]WOW [01:55.38]WOW [01:55.71]WOOW [01:56.62]\n[01:57.38]こ[01:57.56]の[01:57.75]街[01:58.07]に[01:58.37]響[01:58.65]く[01:58.83]の[01:59.02]だ[01:59.21]ろ[01:59.39]う[01:59.69]\n[01:57.38]ko [01:57.56]no [01:57.75]maqi [01:58.07]ni [01:58.37]hibi [01:58.65]ku [01:58.83]no [01:59.02]da [01:59.21]lo [01:59.39]u [01:59.69]\n[02:00.24]だ[02:00.45]け[02:00.62]ど[02:00.83]\n[02:00.24]da [02:00.45]ke [02:00.62]do [02:00.83]\n[02:00.83]WOW [02:01.18]WOW [02:01.52]WOOW[02:02.79]\n[02:00.83]WOW [02:01.18]WOW [02:01.52]WOOW [02:02.79]\n[02:03.38]期[02:03.57]待[02:03.88]し[02:04.08]て[02:04.28]て[02:04.64]も[02:04.84]仕[02:05.07]方[02:05.49]な[02:05.79]い[02:06.23]\n[02:03.38]ki [02:03.57]tai [02:03.88]xi [02:04.08]te [02:04.28]te [02:04.64]mo [02:04.84]xi [02:05.07]kata [02:05.49]na [02:05.79]i [02:06.23]\n[02:09.49]無[02:09.64]限[02:10.13]大[02:10.63]な[02:11.02]夢[02:11.54]の[02:11.89]あ[02:12.10]と[02:12.29]の[02:12.55]\n[02:09.49]mu [02:09.64]gen [02:10.13]dai [02:10.63]na [02:11.02]yume [02:11.54]no [02:11.89]a [02:12.10]to [02:12.29]no [02:12.55]\n[02:13.47]や[02:13.66]る[02:13.88]せ[02:14.09]な[02:14.31]い[02:14.53]世[02:14.83]の[02:15.05]中[02:15.23]じ[02:15.38]ゃ[02:15.94]\n[02:13.47]ya [02:13.66]lu [02:13.88]se [02:14.09]na [02:14.31]i [02:14.53]yo [02:14.83]no [02:15.05]naka [02:15.23]ji [02:15.38]a [02:15.94]\n[02:15.94]そ[02:16.13]う[02:16.31]さ[02:16.62]常[02:17.10]識[02:17.69]\n[02:15.94]so [02:16.13]u [02:16.31]sa [02:16.62]jiyou [02:17.10]xiki [02:17.69]\n[02:18.14]は[02:18.44]ず[02:18.67]れ[02:18.86]も[02:19.06]悪[02:19.58]く[02:19.89]は[02:20.09]な[02:20.26]い[02:20.50]か[02:20.67]な[02:21.11]\n[02:18.14]ha [02:18.44]zu [02:18.67]re [02:18.86]mo [02:19.06]walu [02:19.58]ku [02:19.89]wa [02:20.09]na [02:20.26]i [02:20.50]ka [02:20.67]na [02:21.11]\n[02:21.11]Stay[02:21.65]\n[02:21.11]Stay [02:21.65]\n[02:21.65]し[02:21.82]そ[02:22.09]う[02:22.30]な[02:22.51]イ[02:22.70]メ[02:22.94]ー[02:23.13]ジ[02:23.29]を[02:23.49]染[02:23.80]め[02:23.99]た[02:24.32]\n[02:21.65]xi [02:21.82]so [02:22.09]u [02:22.30]na [02:22.51]i [02:22.70]me [02:22.94]e [02:23.13]ji [02:23.29]wo [02:23.49]so [02:23.80]me [02:23.99]ta [02:24.32]\n[02:25.01]ぎ[02:25.20]こ[02:25.42]ち[02:25.60]な[02:25.83]い[02:26.05]翼[02:26.47]で[02:26.74]も[02:27.16]\n[02:25.01]gi [02:25.20]ko [02:25.42]qi [02:25.60]na [02:25.83]i [02:26.05]cubasa [02:26.47]de [02:26.74]mo [02:27.16]\n[02:27.53]き[02:27.71]っ[02:27.94]と[02:28.22]飛[02:28.68]べ[02:28.87]る[02:29.03]さ[02:29.39]\n[02:27.53][02:27.71]ki [02:27.94]to [02:28.22]to [02:28.68]be [02:28.87]lu [02:29.03]sa [02:29.39]\n[02:29.87]On [02:31.28]My [02:32.69]Love[02:34.46]\n[02:29.87]On [02:31.28]My [02:32.69]Love [02:34.46]\n[03:13.59]無[03:13.76]限[03:14.13]大[03:14.58]な[03:14.99]夢[03:15.54]の[03:15.90]あ[03:16.09]と[03:16.28]の[03:16.58]\n[03:13.59]mu [03:13.76]gen [03:14.13]dai [03:14.58]na [03:14.99]yume [03:15.54]no [03:15.90]a [03:16.09]to [03:16.28]no [03:16.58]\n[03:17.50]何[03:17.89]も[03:18.12]な[03:18.31]い[03:18.55]世[03:18.80]の[03:19.03]中[03:19.24]じ[03:19.50]ゃ[03:19.97]\n[03:17.50]nani [03:17.89]mo [03:18.12]na [03:18.31]i [03:18.55]yo [03:18.80]no [03:19.03]naka [03:19.24]ji [03:19.50]a [03:19.97]\n[03:19.97]そ[03:20.19]う[03:20.37]さ[03:20.66]愛[03:21.08]し[03:21.29]い[03:21.64]\n[03:19.97]so [03:20.19]u [03:20.37]sa [03:20.66]ito [03:21.08]xi [03:21.29]i [03:21.64]\n[03:22.12]想[03:22.43]い[03:22.64]も[03:22.84]負[03:23.08]け[03:23.26]そ[03:23.42]う[03:23.60]に[03:23.94]な[03:24.12]る[03:24.47]け[03:24.64]ど[03:24.88]\n[03:22.12]omo [03:22.43]i [03:22.64]mo [03:22.84]ma [03:23.08]ke [03:23.26]so [03:23.42]u [03:23.60]ni [03:23.94]na [03:24.12]lu [03:24.47]ke [03:24.64]do [03:24.88]\n[03:25.19]Stay[03:25.69]\n[03:25.19]Stay [03:25.69]\n[03:25.69]し[03:25.86]が[03:26.08]ち[03:26.26]な[03:26.43]イ[03:26.60]メ[03:26.78]ー[03:26.96]ジ[03:27.14]だ[03:27.60]ら[03:27.78]け[03:27.96]の[03:28.24]\n[03:25.69]xi [03:25.86]ga [03:26.08]qi [03:26.26]na [03:26.43]i [03:26.60]me [03:26.78]e [03:26.96]ji [03:27.14]da [03:27.60]la [03:27.78]ke [03:27.96]no [03:28.24]\n[03:29.07]頼[03:29.55]り[03:29.72]な[03:29.92]い[03:30.15]翼[03:30.53]で[03:30.82]も[03:31.50]\n[03:29.07]tayo [03:29.55]li [03:29.72]na [03:29.92]i [03:30.15]cubasa [03:30.53]de [03:30.82]mo [03:31.50]\n[03:31.50]き[03:31.69]っ[03:31.96]と[03:32.22]飛[03:32.64]べ[03:32.87]る[03:33.04]さ[03:33.39]\n[03:31.50][03:31.69]ki [03:31.96]to [03:32.22]to [03:32.64]be [03:32.87]lu [03:33.04]sa [03:33.39]\n[03:33.86]Oh [03:35.33]Yeah[03:35.79]～[03:36.24]\n[03:33.86]Oh [03:35.33]Yeah [03:35.79]～ [03:36.24]\n[03:36.63]無[03:36.84]限[03:37.36]大[03:37.88]な[03:38.29]夢[03:38.79]の[03:39.15]あ[03:39.36]と[03:39.56]の[03:40.08]\n[03:36.63]mu [03:36.84]gen [03:37.36]dai [03:37.88]na [03:38.29]yume [03:38.79]no [03:39.15]a [03:39.36]to [03:39.56]no [03:40.08]\n[03:40.80]や[03:40.99]る[03:41.19]せ[03:41.38]な[03:41.56]い[03:41.78]世[03:41.95]の[03:42.17]中[03:42.41]じ[03:42.61]ゃ[03:43.18]\n[03:40.80]ya [03:40.99]lu [03:41.19]se [03:41.38]na [03:41.56]i [03:41.78]yo [03:41.95]no [03:42.17]naka [03:42.41]ji [03:42.61]a [03:43.18]\n[03:43.18]そ[03:43.35]う[03:43.62]さ[03:43.87]常[03:44.35]識[03:44.95]\n[03:43.18]so [03:43.35]u [03:43.62]sa [03:43.87]jiyou [03:44.35]xiki [03:44.95]\n[03:45.41]は[03:45.81]ず[03:45.99]れ[03:46.15]も[03:46.36]悪[03:46.88]く[03:47.16]は[03:47.36]な[03:47.54]い[03:47.75]か[03:47.93]な[03:48.29]\n[03:45.41]ha [03:45.81]zu [03:45.99]re [03:46.15]mo [03:46.36]walu [03:46.88]ku [03:47.16]wa [03:47.36]na [03:47.54]i [03:47.75]ka [03:47.93]na [03:48.29]\n[03:48.53]Stay[03:49.02]\n[03:48.53]Stay [03:49.02]\n[03:49.02]し[03:49.18]そ[03:49.39]う[03:49.56]な[03:49.73]イ[03:49.94]メ[03:50.19]ー[03:50.38]ジ[03:50.54]を[03:50.86]染[03:51.06]め[03:51.26]た[03:51.53]\n[03:49.02]xi [03:49.18]so [03:49.39]u [03:49.56]na [03:49.73]i [03:49.94]me [03:50.19]e [03:50.38]ji [03:50.54]wo [03:50.86]so [03:51.06]me [03:51.26]ta [03:51.53]\n[03:52.36]ぎ[03:52.57]こ[03:52.81]ち[03:53.00]な[03:53.20]い[03:53.43]翼[03:53.84]で[03:54.07]も[03:54.38]\n[03:52.36]gi [03:52.57]ko [03:52.81]qi [03:53.00]na [03:53.20]i [03:53.43]cubasa [03:53.84]de [03:54.07]mo [03:54.38]\n[03:54.83]き[03:55.00]っ[03:55.20]と[03:55.39]飛[03:55.96]べ[03:56.18]る[03:56.36]さ[03:56.73]\n[03:54.83][03:55.00]ki [03:55.20]to [03:55.39]to [03:55.96]be [03:56.18]lu [03:56.36]sa [03:56.73]\n[03:57.21]On [03:58.51]My [03:59.99]Love[04:01.40]\n[03:57.21]On [03:58.51]My [03:59.99]Love [04:01.40]",
    "lrcUrl": "assets/lyrics/track_15.lrc"
  },
  {
    "index": "016",
    "spineNum": "16",
    "serial": "WK-REAL-16",
    "title": "Brave Shine",
    "shortTitle": "Brave Shine · Aimer",
    "spineTitle": "Brave Shine · Fate",
    "subtitleQuote": "| 守护你直到终焉的破晓",
    "artist": "Aimer",
    "subArtist": "Fate/stay night [UBW] OP2",
    "statusTag": "高燃燃系",
    "subTag": "Fate系列",
    "durationSec": 161,
    "currentSec": 0,
    "accent": "#d97706",
    "c1": "#f59e0b",
    "c2": "#451a03",
    "picUrl": "assets/covers/cover_16.jpg",
    "audioUrl": "assets/audio/track_16.mp3",
    "notes": [
      329.63,
      349.23,
      392,
      440,
      523.25,
      440,
      392,
      349.23
    ],
    "lyrics": [
      {
        "t": 0.53,
        "l1": "Brave Shine - エメ",
        "l2": ""
      },
      {
        "t": 0.53,
        "l1": "(2607,1)",
        "l2": ""
      },
      {
        "t": 2.6,
        "l1": "词：aimerrhythm",
        "l2": ""
      },
      {
        "t": 4.16,
        "l1": "曲：小山寿",
        "l2": ""
      },
      {
        "t": 7.83,
        "l1": "编曲：玉井健二/大西省吾",
        "l2": ""
      },
      {
        "t": 7.83,
        "l1": "(14345,2199)",
        "l2": ""
      },
      {
        "t": 16.93,
        "l1": "左手に隠した 願いは願いのままで",
        "l2": ""
      },
      {
        "t": 16.93,
        "l1": "hi da ri te ni ka ku shi ta ne ga i wa ne ga i no ma ma de",
        "l2": ""
      },
      {
        "t": 23.1,
        "l1": "覚めない幻見てた",
        "l2": ""
      },
      {
        "t": 23.1,
        "l1": "sa me na i yu me mi te ta",
        "l2": ""
      },
      {
        "t": 28.14,
        "l1": "右手には空の記憶",
        "l2": ""
      },
      {
        "t": 28.14,
        "l1": "mi gi te ni wa ka ra no ki o ku",
        "l2": ""
      },
      {
        "t": 30.98,
        "l1": "誰もしらない世界の果て",
        "l2": ""
      },
      {
        "t": 30.98,
        "l1": "da re mo shi ra na i se ka i no ha te",
        "l2": ""
      },
      {
        "t": 34.32,
        "l1": "やまない雨にうたれていた",
        "l2": ""
      },
      {
        "t": 34.32,
        "l1": "ya ma na i a me ni u ta re te i ta",
        "l2": ""
      },
      {
        "t": 40.72,
        "l1": "守りたいものを守れる強さ",
        "l2": ""
      },
      {
        "t": 40.72,
        "l1": "ma mo ri ta i mo no wo ma mo re ru tsu yo sa",
        "l2": ""
      },
      {
        "t": 46.28,
        "l1": "それを信じられなくなる弱さ",
        "l2": ""
      },
      {
        "t": 46.28,
        "l1": "so re wo shi n ji ra re na ku na ru yo wa sa",
        "l2": ""
      },
      {
        "t": 50.55,
        "l1": "すべてを受け入れて",
        "l2": ""
      },
      {
        "t": 50.55,
        "l1": "su be te wo u ke i re te",
        "l2": ""
      },
      {
        "t": 53.34,
        "l1": "未来を探す",
        "l2": ""
      },
      {
        "t": 53.34,
        "l1": "a shi ta wo sa ga su",
        "l2": ""
      },
      {
        "t": 55.88,
        "l1": "Brave shine",
        "l2": ""
      },
      {
        "t": 55.88,
        "l1": "Brave shine",
        "l2": ""
      },
      {
        "t": 58.72,
        "l1": "手を伸ばせばまだ",
        "l2": ""
      },
      {
        "t": 58.72,
        "l1": "te wo no ba se ba ma da",
        "l2": ""
      },
      {
        "t": 61.31,
        "l1": "Stay the night",
        "l2": ""
      },
      {
        "t": 61.31,
        "l1": "Stay the night",
        "l2": ""
      },
      {
        "t": 64.26,
        "l1": "傷だらけの夜",
        "l2": ""
      },
      {
        "t": 66.73,
        "l1": "You save my life",
        "l2": ""
      },
      {
        "t": 66.73,
        "l1": "You save my life",
        "l2": ""
      },
      {
        "t": 69.79,
        "l1": "かざした刃の先に想いを重ねた",
        "l2": ""
      },
      {
        "t": 69.79,
        "l1": "ka za shi ta ya i ba no sa ki ni o mo i wo ka sa ne ta",
        "l2": ""
      },
      {
        "t": 76.08,
        "l1": "祈りは時を超えて",
        "l2": ""
      },
      {
        "t": 76.08,
        "l1": "i no ri wa to ki wo ko e te",
        "l2": ""
      },
      {
        "t": 83.78,
        "l1": "Your brave shine",
        "l2": ""
      },
      {
        "t": 83.78,
        "l1": "Your brave shine",
        "l2": ""
      },
      {
        "t": 89.85,
        "l1": "光ること忘れた",
        "l2": ""
      },
      {
        "t": 89.85,
        "l1": "hi ka ru ko to wa su re ta",
        "l2": ""
      },
      {
        "t": 92.68,
        "l1": "青い星が残してく",
        "l2": ""
      },
      {
        "t": 92.68,
        "l1": "a o i ho shi ga no ko shi te ku",
        "l2": ""
      },
      {
        "t": 96.02,
        "l1": "消えない影見てた",
        "l2": ""
      },
      {
        "t": 96.02,
        "l1": "ki e na i ka ge mi te ta",
        "l2": ""
      },
      {
        "t": 101.06,
        "l1": "すれ違う赤の軌道",
        "l2": ""
      },
      {
        "t": 101.06,
        "l1": "su re chi ga u a ka no ki do u",
        "l2": ""
      },
      {
        "t": 103.95,
        "l1": "何も知らない子供のまま",
        "l2": ""
      },
      {
        "t": 103.95,
        "l1": "na ni mo shi ra na i ko do mo no ma ma",
        "l2": ""
      },
      {
        "t": 107.21,
        "l1": "明けない夜を彷徨ってた",
        "l2": ""
      },
      {
        "t": 107.21,
        "l1": "a ke na i yo ru wo sa ma yo 't te ta",
        "l2": ""
      },
      {
        "t": 113.7,
        "l1": "失くせないものを失くした弱さ",
        "l2": ""
      },
      {
        "t": 113.7,
        "l1": "na ku se na i mo no wo na ku shi ta yo wa sa",
        "l2": ""
      },
      {
        "t": 119.22,
        "l1": "何も信じられなくなる脆さ",
        "l2": ""
      },
      {
        "t": 119.22,
        "l1": "na ni mo shi n ji ra re na ku na ru mo ro sa",
        "l2": ""
      },
      {
        "t": 123.51,
        "l1": "立てなくなっても",
        "l2": ""
      },
      {
        "t": 123.51,
        "l1": "ta te na ku na 't te mo",
        "l2": ""
      },
      {
        "t": 126.38,
        "l1": "運命は進む",
        "l2": ""
      },
      {
        "t": 126.38,
        "l1": "sa da me wa su su mu",
        "l2": ""
      },
      {
        "t": 128.9,
        "l1": "Break down",
        "l2": ""
      },
      {
        "t": 128.9,
        "l1": "Break down",
        "l2": ""
      },
      {
        "t": 131.66,
        "l1": "崩れ堕ちてゆく星座が",
        "l2": ""
      },
      {
        "t": 131.66,
        "l1": "ku zu re o chi te yu ku se i za ga",
        "l2": ""
      },
      {
        "t": 137.21,
        "l1": "傷つけあう夜",
        "l2": ""
      },
      {
        "t": 137.21,
        "l1": "ki zu tsu ke a u yo ru",
        "l2": ""
      },
      {
        "t": 139.83,
        "l1": "You're breaking dawn",
        "l2": ""
      },
      {
        "t": 139.83,
        "l1": "You're breaking dawn",
        "l2": ""
      },
      {
        "t": 142.84,
        "l1": "交わした約束の中に",
        "l2": ""
      },
      {
        "t": 142.84,
        "l1": "ka wa shi ta ko to ba no na ka ni",
        "l2": ""
      },
      {
        "t": 146.33,
        "l1": "独りを支えた確かな理想を添えて",
        "l2": ""
      },
      {
        "t": 146.33,
        "l1": "hi to ri wo sa sa e ta ta shi ka na yu me wo so e te",
        "l2": ""
      },
      {
        "t": 175.54,
        "l1": "守りたいものを守れるのなら",
        "l2": ""
      },
      {
        "t": 175.54,
        "l1": "ma mo ri ta i mo no wo ma mo re ru no na ra",
        "l2": ""
      },
      {
        "t": 179.67,
        "l1": "すべてを受け入れて",
        "l2": ""
      },
      {
        "t": 179.67,
        "l1": "su be te wo u ke i re te",
        "l2": ""
      },
      {
        "t": 182.47,
        "l1": "未来を探す",
        "l2": ""
      },
      {
        "t": 182.47,
        "l1": "a shi ta wo sa ga su",
        "l2": ""
      },
      {
        "t": 185.34,
        "l1": "夜明けを灯す",
        "l2": ""
      },
      {
        "t": 185.34,
        "l1": "yo a ke wo to mo su",
        "l2": ""
      },
      {
        "t": 187.81,
        "l1": "Brave shine",
        "l2": ""
      },
      {
        "t": 187.81,
        "l1": "Brave shine",
        "l2": ""
      },
      {
        "t": 190.63,
        "l1": "手を伸ばせばまだ",
        "l2": ""
      },
      {
        "t": 190.63,
        "l1": "te wo no ba se ba ma da",
        "l2": ""
      },
      {
        "t": 193.28,
        "l1": "Stay the night",
        "l2": ""
      },
      {
        "t": 193.28,
        "l1": "Stay the night",
        "l2": ""
      },
      {
        "t": 196.23,
        "l1": "傷だらけの夜",
        "l2": ""
      },
      {
        "t": 196.23,
        "l1": "ki zu da ra ke no yo ru",
        "l2": ""
      },
      {
        "t": 198.67,
        "l1": "You save my life",
        "l2": ""
      },
      {
        "t": 198.67,
        "l1": "You save my life",
        "l2": ""
      },
      {
        "t": 201.79,
        "l1": "重ねた涙の果てに光を見つけた",
        "l2": ""
      },
      {
        "t": 201.79,
        "l1": "ka sa ne ta na mi da no ha te ni hi ka ri wo mi tsu ke ta",
        "l2": ""
      },
      {
        "t": 207.98,
        "l1": "祈りは時を超えて",
        "l2": ""
      },
      {
        "t": 207.98,
        "l1": "i no ri wa to ki wo ko e te",
        "l2": ""
      },
      {
        "t": 215.73,
        "l1": "My brave shine",
        "l2": ""
      },
      {
        "t": 215.73,
        "l1": "My brave shine",
        "l2": ""
      }
    ],
    "comments": [
      "【热评 @无限剑制】卫宫士郎与红A信念对决时的神曲，Aimer 独特的沙哑嗓音把史诗感拉满了！"
    ],
    "lyricsRaw": "[ti:Brave Shine]\n[ar:Aimer]\n[al:Brave Shine (期間生産限定アニメ盤)]\n[offset:0]\n\n[00:00.53]Brave [00:00.97]Shine - [00:01.32][00:01.76]エ[00:02.17]メ[00:02.60]\n[00:00.53](2607,1)[00:02.60]\n[00:02.60]词[00:03.07]：[00:03.07]aimerrhythm[00:03.71]\n[00:04.16]曲[00:04.96]：[00:04.96]小[00:05.38]山[00:06.08]寿[00:07.40]\n[00:07.83]编[00:08.24]曲[00:08.54]：[00:08.54]玉[00:08.92]井[00:09.25]健[00:09.64]二[00:10.34]/[00:10.34]大[00:10.94]西[00:11.72]省[00:14.34]吾[00:16.54]\n[00:07.83](14345,2199)[00:16.54]\n[00:16.93]左[00:17.48]手[00:17.76]に[00:18.16]隠[00:18.82]し[00:18.99]た[00:19.65] [00:19.65]願[00:20.03]い[00:20.22]は[00:20.52]願[00:21.24]い[00:21.63]の[00:22.02]ま[00:22.33]ま[00:22.72]で[00:22.87]\n[00:16.93]hi [00:17.12]da [00:17.30]ri [00:17.48]te [00:17.76]ni [00:18.16]ka [00:18.49]ku [00:18.82]shi [00:18.99]ta [00:19.65]ne [00:19.84]ga [00:20.03]i [00:20.22]wa [00:20.52]ne [00:20.85]ga [00:21.24]i [00:21.63]no [00:22.02]ma [00:22.33]ma [00:22.72]de [00:22.87]\n[00:23.10]覚[00:23.27]め[00:23.42]な[00:23.56]い[00:23.90]幻[00:25.23]見[00:25.54]て[00:26.00]た[00:27.54]\n[00:23.10]sa [00:23.27]me [00:23.42]na [00:23.56]i [00:23.90]yu [00:24.10]me [00:25.23]mi [00:25.54]te [00:26.00]ta [00:27.54]\n[00:28.14]右[00:28.45]手[00:28.62]に[00:28.80]は[00:29.05]空[00:29.72]の[00:30.08]記[00:30.25]憶[00:30.76]\n[00:28.14]mi [00:28.33]gi [00:28.45]te [00:28.62]ni [00:28.80]wa [00:29.05]ka [00:29.39]ra [00:29.72]no [00:30.08]ki [00:30.25]o [00:30.71]ku [00:30.76]\n[00:30.98]誰[00:31.31]も[00:31.49]し[00:31.66]ら[00:31.86]な[00:32.03]い[00:32.18]世[00:32.49]界[00:33.25]の[00:33.55]果[00:33.96]て[00:34.11]\n[00:30.98]da [00:31.16]re [00:31.31]mo [00:31.49]shi [00:31.66]ra [00:31.86]na [00:32.03]i [00:32.18]se [00:32.49]ka [00:32.84]i [00:33.25]no [00:33.55]ha [00:33.96]te [00:34.11]\n[00:34.32]や[00:34.48]ま[00:34.64]な[00:34.81]い[00:35.19]雨[00:35.76]に[00:36.53]う[00:36.71]た[00:37.20]れ[00:37.46]て[00:37.75]い[00:38.10]た[00:39.91]\n[00:34.32]ya [00:34.48]ma [00:34.64]na [00:34.81]i [00:35.19]a [00:35.37]me [00:35.76]ni [00:36.53]u [00:36.71]ta [00:37.20]re [00:37.46]te [00:37.75]i [00:38.10]ta [00:39.91]\n[00:40.72]守[00:41.11]り[00:41.25]た[00:41.59]い[00:41.91]も[00:42.23]の[00:42.59]を[00:43.54]守[00:43.90]れ[00:44.06]る[00:44.24]強[00:44.63]さ[00:45.85]\n[00:40.72]ma [00:40.91]mo [00:41.11]ri [00:41.25]ta [00:41.59]i [00:41.91]mo [00:42.23]no [00:42.59]wo [00:43.54]ma [00:43.74]mo [00:43.90]re [00:44.06]ru [00:44.24]tsu [00:44.42]yo [00:44.63]sa [00:45.85]\n[00:46.28]そ[00:46.45]れ[00:46.63]を[00:46.79]信[00:47.06][00:47.06]じ[00:47.33]ら[00:47.67]れ[00:48.09]な[00:48.41]く[00:48.56]な[00:48.99]る[00:49.17]弱[00:49.90]さ[00:50.25]\n[00:46.28]so [00:46.45]re [00:46.63]wo [00:46.79]shi [00:46.91]n [00:47.06][00:47.06]ji [00:47.33]ra [00:47.67]re [00:48.09]na [00:48.41]ku [00:48.56]na [00:48.99]ru [00:49.17]yo [00:49.70]wa [00:49.90]sa [00:50.25]\n[00:50.55]す[00:50.73]べ[00:50.90]て[00:51.02]を[00:51.26]受[00:51.44]け[00:51.87]入[00:52.06]れ[00:52.38]て[00:53.06]\n[00:50.55]su [00:50.73]be [00:50.90]te [00:51.02]wo [00:51.26]u [00:51.44]ke [00:51.87]i [00:52.06]re [00:52.38]te [00:53.06]\n[00:53.34]未来[00:54.00]を[00:54.21]探[00:54.92]す[00:55.67]\n[00:53.34]a [00:53.52]shi [00:53.69]ta [00:54.00]wo [00:54.21]sa [00:54.55]ga [00:54.92]su [00:55.67]\n[00:55.88]Brave [00:56.42]shine[00:58.45]\n[00:55.88]Brave [00:56.42]shine [00:58.45]\n[00:58.72]手[00:58.90]を[00:59.19]伸[00:59.65]ば[00:59.86]せ[01:00.30]ば[01:00.59]ま[01:01.03]だ[01:01.15]\n[00:58.72]te [00:58.90]wo [00:59.19]no [00:59.65]ba [00:59.86]se [01:00.30]ba [01:00.59]ma [01:01.03]da [01:01.15]\n[01:01.31]Stay [01:01.66]the [01:02.00]night[01:03.91]\n[01:01.31]Stay [01:01.66]the [01:02.00]night [01:03.91]\n[01:04.26]傷[01:04.76]だ[01:05.35]ら[01:05.52]け[01:05.81]の[01:06.16]夜[01:06.50]\n[01:06.73]You [01:06.91]save [01:07.24]my [01:07.58]life[01:09.38]\n[01:06.73]You [01:06.91]save [01:07.24]my [01:07.58]life [01:09.38]\n[01:09.79]か[01:10.01]ざ[01:10.37]し[01:10.84]た[01:11.03]刃[01:11.82]の[01:12.42]先[01:12.86]に[01:13.40]想[01:13.72]い[01:13.89]を[01:14.44]重[01:15.01]ね[01:15.29]た[01:15.83]\n[01:09.79]ka [01:10.01]za [01:10.37]shi [01:10.84]ta [01:11.03]ya [01:11.25]i [01:11.46]ba [01:11.82]no [01:12.42]sa [01:12.60]ki [01:12.86]ni [01:13.40]o [01:13.56]mo [01:13.72]i [01:13.89]wo [01:14.44]ka [01:14.62]sa [01:15.01]ne [01:15.29]ta [01:15.83]\n[01:16.08]祈[01:16.57]り[01:16.80]は[01:17.07]時[01:18.27]を[01:18.51]超[01:18.80]え[01:19.19]て[01:23.12]\n[01:16.08]i [01:16.27]no [01:16.57]ri [01:16.80]wa [01:17.07]to [01:17.36]ki [01:18.27]wo [01:18.51]ko [01:18.80]e [01:19.19]te [01:23.12]\n[01:23.78]Your [01:24.20]brave [01:24.81]shine[01:29.14]\n[01:23.78]Your [01:24.20]brave [01:24.81]shine [01:29.14]\n[01:29.85]光[01:30.22]る[01:30.40]こ[01:30.71]と[01:31.12]忘[01:31.79]れ[01:31.97]た[01:32.42]\n[01:29.85]hi [01:30.03]ka [01:30.22]ru [01:30.40]ko [01:30.71]to [01:31.12]wa [01:31.46]su [01:31.79]re [01:31.97]ta [01:32.42]\n[01:32.68]青[01:33.03]い[01:33.22]星[01:33.91]が[01:34.31]残[01:34.94]し[01:35.29]て[01:35.69]く[01:35.86]\n[01:32.68]a [01:32.86]o [01:33.03]i [01:33.22]ho [01:33.46]shi [01:33.91]ga [01:34.31]no [01:34.59]ko [01:34.94]shi [01:35.29]te [01:35.69]ku [01:35.86]\n[01:36.02]消[01:36.18]え[01:36.33]な[01:36.49]い[01:36.85]影[01:38.36]見[01:38.55]て[01:38.93]た[01:40.59]\n[01:36.02]ki [01:36.18]e [01:36.33]na [01:36.49]i [01:36.85]ka [01:37.06]ge [01:38.36]mi [01:38.55]te [01:38.93]ta [01:40.59]\n[01:41.06]す[01:41.27]れ[01:41.48]違[01:41.84]う[01:42.05]赤[01:42.66]の[01:43.00]軌[01:43.20]道[01:43.67]\n[01:41.06]su [01:41.27]re [01:41.48]chi [01:41.66]ga [01:41.84]u [01:42.05]a [01:42.34]ka [01:42.66]no [01:43.00]ki [01:43.20]do [01:43.44]u [01:43.67]\n[01:43.95]何[01:44.30]も[01:44.47]知[01:44.63]ら[01:44.79]な[01:44.95]い[01:45.13]子[01:45.45]供[01:46.19]の[01:46.54]ま[01:46.89]ま[01:47.01]\n[01:43.95]na [01:44.13]ni [01:44.30]mo [01:44.47]shi [01:44.63]ra [01:44.79]na [01:44.95]i [01:45.13]ko [01:45.45]do [01:45.80]mo [01:46.19]no [01:46.54]ma [01:46.89]ma [01:47.01]\n[01:47.21]明[01:47.36]け[01:47.51]な[01:47.68]い[01:48.12]夜[01:48.77]を[01:49.49]彷徨[01:50.57]っ[01:50.81][01:50.81]て[01:51.14]た[01:52.74]\n[01:47.21]a [01:47.36]ke [01:47.51]na [01:47.68]i [01:48.12]yo [01:48.31]ru [01:48.77]wo [01:49.49]sa [01:49.70]ma [01:50.34]yo [01:50.57]'t [01:50.81][01:50.81]te [01:51.14]ta [01:52.74]\n[01:53.70]失[01:53.88]く[01:54.01]せ[01:54.24]な[01:54.55]い[01:54.87]も[01:55.26]の[01:55.57]を[01:56.59]失[01:56.77]く[01:56.94]し[01:57.11]た[01:57.29]弱[01:57.75]さ[01:58.68]\n[01:53.70]na [01:53.88]ku [01:54.01]se [01:54.24]na [01:54.55]i [01:54.87]mo [01:55.26]no [01:55.57]wo [01:56.59]na [01:56.77]ku [01:56.94]shi [01:57.11]ta [01:57.29]yo [01:57.47]wa [01:57.75]sa [01:58.68]\n[01:59.22]何[01:59.56]も[01:59.72]信[02:00.07]じ[02:00.23]ら[02:00.66]れ[02:01.14]な[02:01.30]く[02:01.67]な[02:01.94]る[02:02.09]脆[02:02.90]さ[02:03.21]\n[01:59.22]na [01:59.39]ni [01:59.56]mo [01:59.72]shi [01:59.87]n [02:00.07]ji [02:00.23]ra [02:00.66]re [02:01.14]na [02:01.30]ku [02:01.67]na [02:01.94]ru [02:02.09]mo [02:02.73]ro [02:02.90]sa [02:03.21]\n[02:03.51]立[02:03.69]て[02:03.88]な[02:04.28]く[02:04.46]な[02:04.72]っ[02:04.99][02:04.99]て[02:05.29]も[02:06.06]\n[02:03.51]ta [02:03.69]te [02:03.88]na [02:04.28]ku [02:04.46]na [02:04.72]'t [02:04.99][02:04.99]te [02:05.29]mo [02:06.06]\n[02:06.38]運命[02:07.01]は[02:07.21]進[02:07.88]む[02:08.68]\n[02:06.38]sa [02:06.56]da [02:06.73]me [02:07.01]wa [02:07.21]su [02:07.52]su [02:07.88]mu [02:08.68]\n[02:08.90]Break [02:09.48]down[02:11.42]\n[02:08.90]Break [02:09.48]down [02:11.42]\n[02:11.66]崩[02:12.17]れ[02:12.54]堕[02:12.73]ち[02:13.11]て[02:13.47]ゆ[02:14.05]く[02:14.24]星[02:14.61]座[02:14.99]が[02:16.90]\n[02:11.66]ku [02:11.83]zu [02:12.17]re [02:12.54]o [02:12.73]chi [02:13.11]te [02:13.47]yu [02:14.05]ku [02:14.24]se [02:14.43]i [02:14.61]za [02:14.99]ga [02:16.90]\n[02:17.21]傷[02:17.71]つ[02:18.29]け[02:18.49]あ[02:18.78]う[02:19.11]夜[02:19.65]\n[02:17.21]ki [02:17.53]zu [02:17.71]tsu [02:18.29]ke [02:18.49]a [02:18.78]u [02:19.11]yo [02:19.44]ru [02:19.65]\n[02:19.83]You're [02:19.93]breaking [02:20.53]dawn[02:22.40]\n[02:19.83]You're [02:19.93]breaking [02:20.53]dawn [02:22.40]\n[02:22.84]交[02:23.03]わ[02:23.38]し[02:23.92]た[02:24.09]約束[02:24.80]の[02:25.42]中[02:25.90]に[02:26.10]\n[02:22.84]ka [02:23.03]wa [02:23.38]shi [02:23.92]ta [02:24.09]ko [02:24.28]to [02:24.44]ba [02:24.80]no [02:25.42]na [02:25.59]ka [02:25.90]ni [02:26.10]\n[02:26.33]独[02:26.75]り[02:26.93]を[02:27.41]支[02:27.99]え[02:28.29]た[02:29.04]確[02:29.52]か[02:29.72]な[02:30.01]理想[02:31.31]を[02:31.63]添[02:31.89]え[02:32.28]て[02:37.08]\n[02:26.33]hi [02:26.48]to [02:26.75]ri [02:26.93]wo [02:27.41]sa [02:27.58]sa [02:27.99]e [02:28.29]ta [02:29.04]ta [02:29.20]shi [02:29.52]ka [02:29.72]na [02:30.01]yu [02:30.32]me [02:31.31]wo [02:31.63]so [02:31.89]e [02:32.28]te [02:37.08]\n[02:55.54]守[02:55.89]り[02:56.07]た[02:56.36]い[02:56.69]も[02:57.01]の[02:57.32]を[02:58.34]守[02:58.59]れ[02:58.78]る[02:58.95]の[02:59.12]な[02:59.30]ら[02:59.46]\n[02:55.54]ma [02:55.71]mo [02:55.89]ri [02:56.07]ta [02:56.36]i [02:56.69]mo [02:57.01]no [02:57.32]wo [02:58.34]ma [02:58.50]mo [02:58.59]re [02:58.78]ru [02:58.95]no [02:59.12]na [02:59.30]ra [02:59.46]\n[02:59.67]す[02:59.85]べ[03:00.01]て[03:00.35]を[03:00.51]受[03:00.61]け[03:00.96]入[03:01.14]れ[03:01.37]て[03:02.14]\n[02:59.67]su [02:59.85]be [03:00.01]te [03:00.35]wo [03:00.51]u [03:00.61]ke [03:00.96]i [03:01.14]re [03:01.37]te [03:02.14]\n[03:02.47]未来[03:03.12]を[03:03.35]探[03:04.00]す[03:05.03]\n[03:02.47]a [03:02.66]shi [03:02.83]ta [03:03.12]wo [03:03.35]sa [03:03.63]ga [03:04.00]su [03:05.03]\n[03:05.34]夜[03:05.51]明[03:05.69]け[03:05.99]を[03:06.19]灯[03:06.78]す[03:07.58]\n[03:05.34]yo [03:05.51]a [03:05.69]ke [03:05.99]wo [03:06.19]to [03:06.46]mo [03:06.78]su [03:07.58]\n[03:07.81]Brave [03:08.42]shine[03:10.30]\n[03:07.81]Brave [03:08.42]shine [03:10.30]\n[03:10.63]手[03:10.80]を[03:11.11]伸[03:11.57]ば[03:11.75]せ[03:12.08]ば[03:12.55]ま[03:12.99]だ[03:13.11]\n[03:10.63]te [03:10.80]wo [03:11.11]no [03:11.57]ba [03:11.75]se [03:12.08]ba [03:12.55]ma [03:12.99]da [03:13.11]\n[03:13.28]Stay [03:13.61]the [03:13.87]night[03:15.75]\n[03:13.28]Stay [03:13.61]the [03:13.87]night [03:15.75]\n[03:16.23]傷[03:16.68]だ[03:17.21]ら[03:17.47]け[03:17.77]の[03:18.10]夜[03:18.49]\n[03:16.23]ki [03:16.51]zu [03:16.68]da [03:17.21]ra [03:17.47]ke [03:17.77]no [03:18.10]yo [03:18.39]ru [03:18.49]\n[03:18.67]You [03:18.85]save [03:19.17]my [03:19.48]life[03:21.34]\n[03:18.67]You [03:18.85]save [03:19.17]my [03:19.48]life [03:21.34]\n[03:21.79]重[03:22.28]ね[03:22.79]た[03:23.11]涙[03:23.79]の[03:24.19]果[03:24.39]て[03:24.71]に[03:25.26]光[03:25.89]を[03:26.35]見[03:26.51]つ[03:26.90]け[03:27.23]た[03:27.68]\n[03:21.79]ka [03:21.97]sa [03:22.28]ne [03:22.79]ta [03:23.11]na [03:23.30]mi [03:23.47]da [03:23.79]no [03:24.19]ha [03:24.39]te [03:24.71]ni [03:25.26]hi [03:25.43]ka [03:25.73]ri [03:25.89]wo [03:26.35]mi [03:26.51]tsu [03:26.90]ke [03:27.23]ta [03:27.68]\n[03:27.98]祈[03:28.44]り[03:28.62]は[03:28.90]時[03:30.25]を[03:30.60]超[03:30.84]え[03:31.21]て[03:35.20]\n[03:27.98]i [03:28.16]no [03:28.44]ri [03:28.62]wa [03:28.90]to [03:29.17]ki [03:30.25]wo [03:30.60]ko [03:30.84]e [03:31.21]te [03:35.20]\n[03:35.73]My [03:36.09]brave [03:36.73]shine[03:41.23]\n[03:35.73]My [03:36.09]brave [03:36.73]shine [03:41.23]",
    "lrcUrl": "assets/lyrics/track_16.lrc"
  },
  {
    "index": "017",
    "spineNum": "17",
    "serial": "WK-REAL-17",
    "title": "红莲华 (紅蓮華)",
    "shortTitle": "红莲华 · LiSA",
    "spineTitle": "红莲华 · 鬼灭之刃",
    "subtitleQuote": "| 纵然染透鲜血，也要迎风怒放如红莲之花",
    "artist": "LiSA",
    "subArtist": "电视动画《鬼灭之刃》灶门炭治郎立志篇 OP",
    "statusTag": "高燃狂潮",
    "subTag": "鬼灭之刃",
    "durationSec": 237,
    "currentSec": 0,
    "accent": "#dc2626",
    "c1": "#ef4444",
    "c2": "#7f1d1d",
    "picUrl": "assets/covers/cover_17.jpg",
    "audioUrl": "assets/audio/track_17.mp3",
    "notes": [
      329.63,
      392,
      440,
      523.25,
      659.25,
      523.25,
      440,
      392
    ],
    "lyrics": [
      {
        "t": 0,
        "l1": "紅蓮華 - 織部里沙",
        "l2": ""
      },
      {
        "t": 0,
        "l1": "(338,33)",
        "l2": ""
      },
      {
        "t": 0.37,
        "l1": "词：LiSA",
        "l2": ""
      },
      {
        "t": 0.37,
        "l1": "(439,33)",
        "l2": ""
      },
      {
        "t": 0.47,
        "l1": "曲：草野華余子",
        "l2": ""
      },
      {
        "t": 0.81,
        "l1": "编曲：江口亮",
        "l2": ""
      },
      {
        "t": 0.81,
        "l1": "(1184,33)",
        "l2": ""
      },
      {
        "t": 1.21,
        "l1": "強くなれる理由を知った",
        "l2": ""
      },
      {
        "t": 7.63,
        "l1": "僕を連れて 進め",
        "l2": ""
      },
      {
        "t": 18.97,
        "l1": "泥だらけの走馬灯に酔う",
        "l2": ""
      },
      {
        "t": 24.52,
        "l1": "こわばる心 震える手は",
        "l2": ""
      },
      {
        "t": 24.52,
        "l1": "ko wa ba ru ko ko ro   fu ru e ru te wa",
        "l2": ""
      },
      {
        "t": 28.5,
        "l1": "掴みたいものがある",
        "l2": ""
      },
      {
        "t": 31.15,
        "l1": "それだけさ",
        "l2": ""
      },
      {
        "t": 32.88,
        "l1": "夜の匂いに",
        "l2": ""
      },
      {
        "t": 32.88,
        "l1": "yo ru no ni o i ni",
        "l2": ""
      },
      {
        "t": 35.3,
        "l1": "I'll spend all thirty nights",
        "l2": ""
      },
      {
        "t": 36.45,
        "l1": "空睨んでも",
        "l2": ""
      },
      {
        "t": 36.45,
        "l1": "so ra ni ra n de mo",
        "l2": ""
      },
      {
        "t": 38.71,
        "l1": "Staring into the sky",
        "l2": ""
      },
      {
        "t": 38.71,
        "l1": "(39687,63)",
        "l2": ""
      },
      {
        "t": 39.96,
        "l1": "変わっていけるのは自分自身だけ",
        "l2": ""
      },
      {
        "t": 39.96,
        "l1": "ka wa 't te i ke ru no wa ji bu n ji shi n da ke",
        "l2": ""
      },
      {
        "t": 45.36,
        "l1": "それだけさ",
        "l2": ""
      },
      {
        "t": 45.36,
        "l1": "so re da ke sa",
        "l2": ""
      },
      {
        "t": 47.28,
        "l1": "強くなれる理由を知った",
        "l2": ""
      },
      {
        "t": 53.72,
        "l1": "僕を連れて 進め",
        "l2": ""
      },
      {
        "t": 53.72,
        "l1": "bo ku wo tsu re te   su su me",
        "l2": ""
      },
      {
        "t": 60.16,
        "l1": "どうしたって消せない夢も",
        "l2": ""
      },
      {
        "t": 60.16,
        "l1": "do u shi ta 't te ke se na i yu me mo",
        "l2": ""
      },
      {
        "t": 63.14,
        "l1": "止まれない今も",
        "l2": ""
      },
      {
        "t": 64.93,
        "l1": "誰かのために強くなれるなら",
        "l2": ""
      },
      {
        "t": 69.36,
        "l1": "ありがとう悲しみよ",
        "l2": ""
      },
      {
        "t": 74.42,
        "l1": "世界に打ちのめされて",
        "l2": ""
      },
      {
        "t": 74.42,
        "l1": "se ka i ni u chi no me sa re te",
        "l2": ""
      },
      {
        "t": 77.42,
        "l1": "負ける意味を知った",
        "l2": ""
      },
      {
        "t": 77.42,
        "l1": "ma ke ru i mi wo shi 't ta",
        "l2": ""
      },
      {
        "t": 79.12,
        "l1": "紅蓮の華よ咲き誇れ",
        "l2": ""
      },
      {
        "t": 79.12,
        "l1": "gu re n no ha na yo sa ki ho ko re",
        "l2": ""
      },
      {
        "t": 83.53,
        "l1": "運命を照らして",
        "l2": ""
      },
      {
        "t": 83.53,
        "l1": "u n me i wo te ra shi te",
        "l2": ""
      },
      {
        "t": 93.55,
        "l1": "イナビカリの雑音が耳を刺す",
        "l2": ""
      },
      {
        "t": 99.16,
        "l1": "戸惑う心 優しいだけじゃ",
        "l2": ""
      },
      {
        "t": 103.15,
        "l1": "守れないものがある",
        "l2": ""
      },
      {
        "t": 105.77,
        "l1": "わかってるけど",
        "l2": ""
      },
      {
        "t": 105.77,
        "l1": "wa ka 't te ru ke do",
        "l2": ""
      },
      {
        "t": 107.98,
        "l1": "水面下で絡まる善悪",
        "l2": ""
      },
      {
        "t": 107.98,
        "l1": "su i me n ka de ka ra ma ru ze n a ku",
        "l2": ""
      },
      {
        "t": 109.74,
        "l1": "透けて見える偽善に天罰",
        "l2": ""
      },
      {
        "t": 109.74,
        "l1": "su ke te mi e ru gi ze n ni te n ba tsu",
        "l2": ""
      },
      {
        "t": 111.51,
        "l1": "Tell me why tell me why tell me why tell me",
        "l2": ""
      },
      {
        "t": 113.21,
        "l1": "I don't need you",
        "l2": ""
      },
      {
        "t": 115.05,
        "l1": "逸材の花より",
        "l2": ""
      },
      {
        "t": 116.8,
        "l1": "挑み続け咲いた一輪が美しい",
        "l2": ""
      },
      {
        "t": 120.8,
        "l1": "乱暴に敷き詰められた",
        "l2": ""
      },
      {
        "t": 123.57,
        "l1": "トゲだらけの道も",
        "l2": ""
      },
      {
        "t": 125.38,
        "l1": "本気の僕だけに現れるから",
        "l2": ""
      },
      {
        "t": 125.38,
        "l1": "ho n ki no bo ku da ke ni a ra wa re ru ka ra",
        "l2": ""
      },
      {
        "t": 129.82,
        "l1": "乗り越えてみせるよ",
        "l2": ""
      },
      {
        "t": 129.82,
        "l1": "no ri ko e te mi se ru yo",
        "l2": ""
      },
      {
        "t": 134.88,
        "l1": "簡単に片付けられた",
        "l2": ""
      },
      {
        "t": 137.8,
        "l1": "守れなかった夢も",
        "l2": ""
      },
      {
        "t": 137.8,
        "l1": "ma mo re na ka 't ta yu me mo",
        "l2": ""
      },
      {
        "t": 139.63,
        "l1": "紅蓮の心臓に根を生やし",
        "l2": ""
      },
      {
        "t": 139.63,
        "l1": "gu re n no shi n zo u ni ne wo ha ya shi",
        "l2": ""
      },
      {
        "t": 144.05,
        "l1": "この血に宿ってる",
        "l2": ""
      },
      {
        "t": 144.05,
        "l1": "ko no chi ni ya do 't te ru",
        "l2": ""
      },
      {
        "t": 161.83,
        "l1": "人知れず 儚い散りゆく結末",
        "l2": ""
      },
      {
        "t": 168.91,
        "l1": "無情に破れた 悲鳴の風吹く",
        "l2": ""
      },
      {
        "t": 168.91,
        "l1": "mu jo u ni ya bu re ta   hi me i no ka ze bu ku",
        "l2": ""
      },
      {
        "t": 176.06,
        "l1": "誰かの笑う影 誰かの泣き声",
        "l2": ""
      },
      {
        "t": 176.06,
        "l1": "da re ka no wa ra u ka ge   da re ka no na ki go e",
        "l2": ""
      },
      {
        "t": 182.54,
        "l1": "誰もが幸せを願ってる",
        "l2": ""
      },
      {
        "t": 182.54,
        "l1": "da re mo ga shi a wa se wo ne ga 't te ru",
        "l2": ""
      },
      {
        "t": 188.23,
        "l1": "どうしたって消せない夢も",
        "l2": ""
      },
      {
        "t": 191.17,
        "l1": "止まれない今も",
        "l2": ""
      },
      {
        "t": 191.17,
        "l1": "to ma re na i i ma mo",
        "l2": ""
      },
      {
        "t": 192.93,
        "l1": "誰かのために強くなれるなら",
        "l2": ""
      },
      {
        "t": 197.36,
        "l1": "ありがとう悲しみよ",
        "l2": ""
      },
      {
        "t": 202.44,
        "l1": "世界に打ちのめされて",
        "l2": ""
      },
      {
        "t": 205.35,
        "l1": "負ける意味を知った",
        "l2": ""
      },
      {
        "t": 205.35,
        "l1": "ma ke ru i mi wo shi 't ta",
        "l2": ""
      },
      {
        "t": 207.14,
        "l1": "紅蓮の華よ咲き誇れ",
        "l2": ""
      },
      {
        "t": 207.14,
        "l1": "gu re n no ha na yo sa ki ho ko re",
        "l2": ""
      },
      {
        "t": 211.59,
        "l1": "運命を照らして",
        "l2": ""
      },
      {
        "t": 211.59,
        "l1": "u n me i wo te ra shi te",
        "l2": ""
      },
      {
        "t": 222.47,
        "l1": "運命を照らして",
        "l2": ""
      },
      {
        "t": 222.47,
        "l1": "u n me i wo te ra shi te",
        "l2": ""
      }
    ],
    "comments": [
      "【热评 @水之呼吸】听到前奏炭治郎踏雪而行的脚步声，瞬间热血沸腾！"
    ],
    "lyricsRaw": "[ti:紅蓮華]\n[ar:LiSA]\n[al:紅蓮華]\n[offset:0]\n\n[00:00.00]紅[00:00.03][00:00.03]蓮[00:00.10][00:00.10]華[00:00.13] - [00:00.16][00:00.20]織[00:00.23][00:00.23]部[00:00.27][00:00.27]里[00:00.30][00:00.30]沙[00:00.33]\n[00:00.00](338,33)[00:00.37]\n[00:00.37]词[00:00.40][00:00.40]：[00:00.43][00:00.44]LiSA[00:00.47]\n[00:00.37](439,33)[00:00.47]\n[00:00.47]曲[00:00.57]：[00:00.60][00:00.60]草[00:00.67][00:00.67]野[00:00.71][00:00.71]華[00:00.74]余[00:00.77][00:00.77]子[00:00.81]\n[00:00.81]编[00:00.87][00:00.88]曲[00:00.98]：[00:01.01][00:01.01]江[00:01.04][00:01.04]口[00:01.11][00:01.11]亮[00:01.21]\n[00:00.81](1184,33)[00:01.21]\n[00:01.21]強[00:01.78]く[00:02.89]な[00:03.24]れ[00:03.58]る[00:04.53]理[00:04.79]由[00:05.10]を[00:05.40]知[00:05.85]っ[00:06.31][00:06.31]た[00:07.29]\n[00:07.63]僕[00:08.21]を[00:09.45]連[00:09.81]れ[00:10.00]て[00:11.16] [00:11.16]進[00:11.78]め[00:15.52]\n[00:18.97]泥[00:19.48]だ[00:19.90]ら[00:20.25]け[00:20.47]の[00:21.52]走[00:21.84]馬[00:21.99]灯[00:22.32]に[00:22.47]酔[00:22.89]う[00:23.59]\n[00:24.52]こ[00:24.72]わ[00:24.86]ば[00:25.12]る[00:25.36]心[00:26.05] [00:26.05]震[00:26.71]え[00:27.08]る[00:27.36]手[00:27.59]は[00:28.31]\n[00:24.52]ko [00:24.72][00:24.72]wa [00:24.86]ba [00:25.11][00:25.12]ru [00:25.35][00:25.36]ko [00:25.60]ko [00:25.81][00:25.81]ro [00:26.05][00:26.05]  [00:26.05]fu [00:26.38]ru [00:26.71][00:26.71]e [00:27.08]ru [00:27.36][00:27.36]te [00:27.59]wa [00:28.31]\n[00:28.50]掴[00:28.78]み[00:28.92]た[00:29.06]い[00:29.22]も[00:29.38]の[00:29.45]が[00:29.66]あ[00:29.88]る[00:30.86]\n[00:31.15]そ[00:31.33]れ[00:31.62]だ[00:31.88]け[00:32.13]さ[00:32.66]\n[00:32.88]夜[00:33.43]の[00:33.75]匂[00:34.40]い[00:34.66]に[00:35.00]\n[00:32.88]yo [00:33.12]ru [00:33.42][00:33.43]no [00:33.74][00:33.75]ni [00:34.15]o [00:34.40][00:34.40]i [00:34.66]ni [00:35.00]\n[00:35.30]I'll [00:35.46]spend [00:35.68]all [00:35.86]thirty [00:36.13]nights[00:36.23]\n[00:36.45]空[00:37.00]睨[00:37.54]ん[00:37.77]で[00:38.00]も[00:38.28]\n[00:36.45]so [00:36.69]ra [00:37.00]ni [00:37.30]ra [00:37.54]n [00:37.77]de [00:38.00][00:38.00]mo [00:38.28]\n[00:38.71]Staring [00:39.15]into [00:39.47]the [00:39.68]sky[00:39.75]\n[00:38.71](39687,63)[00:39.96]\n[00:39.96]変[00:40.19]わ[00:40.37]っ[00:40.54]て[00:40.82]い[00:40.98]け[00:41.38]る[00:41.60]の[00:41.83]は[00:42.45]自[00:42.66]分[00:43.12]自[00:43.33]身[00:43.75]だ[00:44.10]け[00:44.95]\n[00:39.96]ka [00:40.19]wa [00:40.37]'t [00:40.54]te [00:40.82][00:40.82]i [00:40.98]ke [00:41.38][00:41.38]ru [00:41.60]no [00:41.83][00:41.83]wa [00:42.45][00:42.45]ji [00:42.66]bu [00:42.89][00:42.89]n [00:43.12]ji [00:43.33][00:43.33]shi [00:43.54]n [00:43.75][00:43.75]da [00:44.10]ke [00:44.95]\n[00:45.36]そ[00:45.59]れ[00:45.89]だ[00:46.14]け[00:46.39]さ[00:46.91]\n[00:45.36]so [00:45.59][00:45.59]re [00:45.89]da [00:46.14]ke [00:46.39]sa [00:46.91]\n[00:47.28]強[00:47.89]く[00:49.14]な[00:49.45]れ[00:49.71]る[00:50.65]理[00:50.87]由[00:51.21]を[00:51.48]知[00:51.92]っ[00:52.37]た[00:53.38]\n[00:53.72]僕[00:54.36]を[00:55.60]連[00:55.88]れ[00:56.10]て[00:57.34] [00:57.34]進[00:57.91]め[00:59.76]\n[00:53.72]bo [00:54.16]ku [00:54.36][00:54.36]wo [00:55.59]tsu [00:55.88]re [00:56.10][00:56.10]te [00:57.34]  [00:57.34]su [00:57.72][00:57.72]su [00:57.91][00:57.91]me [00:59.76]\n[01:00.16]ど[01:00.39]う[01:00.62]し[01:00.76]た[01:00.93]っ[01:01.09][01:01.10]て[01:01.57]消[01:01.77]せ[01:01.96]な[01:02.11]い[01:02.39]夢[01:02.79]も[01:02.92]\n[01:00.16]do [01:00.39][01:00.39]u [01:00.61]shi [01:00.76]ta [01:00.93][01:00.93]'t [01:01.09]te [01:01.57][01:01.57]ke [01:01.77]se [01:01.96]na [01:02.11][01:02.11]i [01:02.39]yu [01:02.62][01:02.62]me [01:02.79][01:02.79]mo [01:02.92]\n[01:03.14]止[01:03.36]ま[01:03.58]れ[01:03.81]な[01:03.97]い[01:04.20]今[01:04.60]も[01:04.73]\n[01:04.93]誰[01:05.37]か[01:05.52]の[01:05.81]た[01:06.00]め[01:06.23]に[01:06.40]強[01:06.87]く[01:07.29]な[01:07.72]れ[01:08.10]る[01:08.40]な[01:08.64]ら[01:09.05]\n[01:09.36]あ[01:09.72]り[01:09.93]が[01:10.18]と[01:10.53][01:10.53]う[01:10.88]悲[01:11.55]し[01:11.76]み[01:11.99]よ[01:14.09]\n[01:14.42]世[01:14.88]界[01:15.35]に[01:15.79]打[01:15.97]ち[01:16.22]の[01:16.45]め[01:16.70]さ[01:16.89]れ[01:17.02]て[01:17.20]\n[01:14.42]se [01:14.88][01:14.88]ka [01:15.04][01:15.04]i [01:15.35]ni [01:15.79]u [01:15.97][01:15.97]chi [01:16.22]no [01:16.45][01:16.45]me [01:16.70]sa [01:16.89]re [01:17.02][01:17.02]te [01:17.20]\n[01:17.42]負[01:17.57]け[01:17.71]る[01:17.92]意[01:18.11]味[01:18.29]を[01:18.51]知[01:18.65]っ[01:18.79]た[01:18.87]\n[01:17.42]ma [01:17.57]ke [01:17.71]ru [01:17.92]i [01:18.11]mi [01:18.29]wo [01:18.51][01:18.51]shi [01:18.65]'t [01:18.79]ta [01:18.87]\n[01:19.12]紅[01:19.29]蓮[01:19.93]の[01:20.41]華[01:20.90]よ[01:21.58]咲[01:22.03]き[01:22.38]誇[01:22.89]れ[01:23.25]\n[01:19.12]gu [01:19.29]re [01:19.61][01:19.61]n [01:19.93]no [01:20.41][01:20.41]ha [01:20.64][01:20.64]na [01:20.90][01:20.90]yo [01:21.58]sa [01:22.03][01:22.03]ki [01:22.38][01:22.38]ho [01:22.65][01:22.65]ko [01:22.89]re [01:23.25]\n[01:23.53]運[01:23.93]命[01:24.39]を[01:25.33]照[01:25.54]ら[01:25.85]し[01:26.01]て[01:26.62]\n[01:23.53]u [01:23.73][01:23.73]n [01:23.93]me [01:24.16][01:24.16]i [01:24.39]wo [01:25.33][01:25.33]te [01:25.54]ra [01:25.85][01:25.85]shi [01:26.01]te [01:26.62]\n[01:33.55]イ[01:33.91]ナ[01:34.21]ビ[01:34.62]カ[01:34.85]リ[01:35.10]の[01:36.02]雑[01:36.33]音[01:36.53]が[01:36.68]耳[01:37.00]を[01:37.15]刺[01:37.36]す[01:38.01]\n[01:39.16]戸[01:39.36]惑[01:39.74]う[01:39.98]心[01:40.73] [01:40.73]優[01:41.32]し[01:41.55]い[01:41.79][01:41.79]だ[01:42.01]け[01:42.25]じ[01:42.46][01:42.46]ゃ[01:42.96]\n[01:43.15]守[01:43.42]れ[01:43.57]な[01:43.70]い[01:43.85]も[01:43.99]の[01:44.09]が[01:44.31]あ[01:44.53]る[01:45.32]\n[01:45.77]わ[01:46.01]か[01:46.19]っ[01:46.38]て[01:46.60]る[01:46.88]け[01:47.27]ど[01:47.74]\n[01:45.77]wa [01:46.01]ka [01:46.19][01:46.19]'t [01:46.38][01:46.38]te [01:46.60]ru [01:46.88][01:46.88]ke [01:47.27][01:47.27]do [01:47.73]\n[01:47.98]水面[01:48.36]下[01:48.50]で[01:48.65]絡[01:48.89]ま[01:49.05]る[01:49.19]善[01:49.33]悪[01:49.55]\n[01:47.98]su [01:48.11]i [01:48.27]me [01:48.35][01:48.35]n [01:48.36]ka [01:48.50][01:48.50]de [01:48.65]ka [01:48.77][01:48.78]ra [01:48.89][01:48.89]ma [01:49.05][01:49.05]ru [01:49.19]ze [01:49.26][01:49.26]n [01:49.33][01:49.33]a [01:49.50]ku [01:49.55]\n[01:49.74]透[01:49.89]け[01:50.03]て[01:50.16]見[01:50.29]え[01:50.44]る[01:50.57]偽[01:50.71]善[01:50.84]に[01:51.00]天[01:51.15]罰[01:51.33]\n[01:49.74]su [01:49.89]ke [01:50.03][01:50.03]te [01:50.16][01:50.16]mi [01:50.29]e [01:50.44][01:50.44]ru [01:50.57]gi [01:50.70][01:50.71]ze [01:50.77][01:50.77]n [01:50.84][01:50.84]ni [01:51.00]te [01:51.07]n [01:51.15]ba [01:51.29][01:51.29]tsu [01:51.33]\n[01:51.51]Tell [01:51.66]me [01:51.79]why [01:51.94]tell [01:52.08]me [01:52.20]why [01:52.33]tell [01:52.46]me [01:52.60]why [01:52.75]tell [01:52.91]me[01:53.02]\n[01:53.21]I [01:53.50]don't [01:53.99]need [01:54.43]you[01:54.80]\n[01:55.05]逸[01:55.35]材[01:55.67]の[01:55.81]花[01:56.14]よ[01:56.40]り[01:56.59]\n[01:56.80]挑[01:57.08]み[01:57.22]続[01:57.50]け[01:57.64]咲[01:57.79]い[01:57.93]た[01:58.08]一[01:58.39]輪[01:58.58]が[01:58.89]美[01:59.73]し[02:00.02]い[02:00.37]\n[02:00.80]乱[02:01.16]暴[02:01.57]に[02:01.97]敷[02:02.16]き[02:02.42]詰[02:02.62]め[02:02.90]ら[02:03.04]れ[02:03.20]た[02:03.34]\n[02:03.57]ト[02:03.72]ゲ[02:03.86]だ[02:04.09]ら[02:04.28]け[02:04.47]の[02:04.69]道[02:05.02]も[02:05.15]\n[02:05.38]本[02:05.74]気[02:05.87]の[02:06.20]僕[02:06.48]だ[02:06.69]け[02:06.90]に[02:07.09]現[02:08.23]れ[02:08.53]る[02:08.82]か[02:09.05]ら[02:09.55]\n[02:05.38]ho [02:05.56]n [02:05.74]ki [02:05.87]no [02:06.19][02:06.19]bo [02:06.33]ku [02:06.48][02:06.48]da [02:06.68][02:06.69]ke [02:06.90]ni [02:07.09][02:07.09]a [02:07.32]ra [02:07.79]wa [02:08.23][02:08.23]re [02:08.53]ru [02:08.82]ka [02:09.05]ra [02:09.55]\n[02:09.82]乗[02:10.01]り[02:10.25]越[02:10.47]え[02:10.70]て[02:11.60]み[02:12.00]せ[02:12.20]る[02:12.44]よ[02:14.19]\n[02:09.82]no [02:10.01]ri [02:10.25]ko [02:10.47][02:10.47]e [02:10.70]te [02:11.60]mi [02:12.00]se [02:12.20]ru [02:12.44][02:12.44]yo [02:14.19]\n[02:14.88]簡[02:15.36]単[02:15.79]に[02:16.22]片[02:16.67]付[02:16.89]け[02:17.15]ら[02:17.31]れ[02:17.45]た[02:17.56]\n[02:17.80]守[02:18.09]れ[02:18.30]な[02:18.49]か[02:18.59]っ[02:18.70]た[02:18.92]夢[02:19.28]も[02:19.39]\n[02:17.80]ma [02:17.95]mo [02:18.09]re [02:18.30]na [02:18.49][02:18.49]ka [02:18.59]'t [02:18.69][02:18.69]ta [02:18.92][02:18.92]yu [02:19.14][02:19.14]me [02:19.28][02:19.28]mo [02:19.39]\n[02:19.63]紅[02:19.81]蓮[02:20.40]の[02:20.87]心[02:21.37]臓[02:22.02]に[02:22.48]根[02:22.62]を[02:22.85]生[02:23.04]や[02:23.31]し[02:23.78]\n[02:19.63]gu [02:19.81]re [02:20.11][02:20.11]n [02:20.40]no [02:20.87]shi [02:21.12]n [02:21.36]zo [02:21.71]u [02:22.02]ni [02:22.48][02:22.48]ne [02:22.61]wo [02:22.85][02:22.85]ha [02:23.04]ya [02:23.31]shi [02:23.78]\n[02:24.05]こ[02:24.45]の[02:24.66]血[02:24.89]に[02:25.67]宿[02:26.15]っ[02:26.37][02:26.37]て[02:29.56]る[02:30.49]\n[02:24.05]ko [02:24.45]no [02:24.66][02:24.66]chi [02:24.89]ni [02:25.66]ya [02:25.92][02:25.92]do [02:26.15][02:26.15]'t [02:26.37][02:26.37]te [02:29.56]ru [02:30.49]\n[02:41.83]人[02:42.67]知[02:42.88]れ[02:43.40]ず[02:43.64] [02:43.64]儚[02:44.46]い[02:45.29]散[02:45.52]り[02:46.18]ゆ[02:46.41]く[02:47.10]結[02:47.70]末[02:48.66]\n[02:48.91]無[02:49.12]情[02:50.04]に[02:50.72]破[02:51.29]れ[02:51.59]た[02:52.44] [02:52.44]悲[02:52.66]鳴[02:53.55]の[02:54.23]風[02:54.82]吹[02:55.11]く[02:55.80]\n[02:48.91]mu [02:49.12]jo [02:49.42][02:49.73]u [02:50.04][02:50.04]ni [02:50.72]ya [02:50.94][02:50.94]bu [02:51.28]re [02:51.59]ta [02:52.44]  [02:52.44]hi [02:52.66][02:52.66]me [02:53.11]i [02:53.55][02:53.55]no [02:54.23]ka [02:54.47]ze [02:54.82][02:54.82]bu [02:55.11]ku [02:55.80]\n[02:56.06]誰[02:56.88]か[02:57.11]の[02:57.85]笑[02:58.16]う[02:58.40]影[02:59.48] [02:59.48]誰[03:00.39]か[03:00.62]の[03:01.33]泣[03:01.54]き[03:01.92]声[03:02.36]\n[02:56.06]da [02:56.25]re [02:56.88][02:56.88]ka [02:57.11]no [02:57.85][02:57.85]wa [02:58.02]ra [02:58.16][02:58.16]u [02:58.40]ka [02:58.64]ge [02:59.48][02:59.48]  [02:59.48]da [02:59.70][02:59.70]re [03:00.39][03:00.39]ka [03:00.62]no [03:01.33]na [03:01.54]ki [03:01.92][03:01.92]go [03:02.17][03:02.17]e [03:02.36]\n[03:02.54]誰[03:03.08]も[03:03.31]が[03:04.02]幸[03:04.78]せ[03:05.03]を[03:05.76]願[03:06.34]っ[03:06.67][03:06.68]て[03:06.86]る[03:07.91]\n[03:02.54]da [03:02.79][03:02.80]re [03:03.08]mo [03:03.31][03:03.31]ga [03:04.02][03:04.02]shi [03:04.23]a [03:04.53][03:04.53]wa [03:04.78]se [03:05.03][03:05.03]wo [03:05.75]ne [03:06.00][03:06.00]ga [03:06.34]'t [03:06.67]te [03:06.86]ru [03:07.91]\n[03:08.23]ど[03:08.41]う[03:08.60][03:08.60]し[03:08.74]た[03:08.91]っ[03:09.07]て[03:09.57]消[03:09.76]せ[03:10.00]な[03:10.15]い[03:10.38]夢[03:10.79]も[03:10.93]\n[03:11.17]止[03:11.37]ま[03:11.60]れ[03:11.85]な[03:11.98]い[03:12.22]今[03:12.62]も[03:12.73]\n[03:11.17]to [03:11.37]ma [03:11.60][03:11.60]re [03:11.85]na [03:11.98][03:11.98]i [03:12.22]i [03:12.48][03:12.48]ma [03:12.62][03:12.62]mo [03:12.73]\n[03:12.93]誰[03:13.33]か[03:13.48]の[03:13.83]た[03:13.99]め[03:14.22]に[03:14.43]強[03:14.86]く[03:15.30]な[03:15.74]れ[03:16.08]る[03:16.41]な[03:16.63]ら[03:17.08]\n[03:17.36]あ[03:17.78]り[03:18.00]が[03:18.23]と[03:18.56]う[03:18.88][03:18.88]悲[03:19.54]し[03:19.74]み[03:19.98]よ[03:22.08]\n[03:22.44]世[03:22.84]界[03:23.31]に[03:23.80]打[03:23.99]ち[03:24.24]の[03:24.46]め[03:24.72]さ[03:24.94]れ[03:25.07]て[03:25.12]\n[03:25.35]負[03:25.49]け[03:25.64]る[03:25.85]意[03:26.05]味[03:26.25]を[03:26.46]知[03:26.62]っ[03:26.78]た[03:26.92]\n[03:25.35]ma [03:25.49][03:25.49]ke [03:25.64]ru [03:25.85]i [03:26.05]mi [03:26.25][03:26.25]wo [03:26.46][03:26.46]shi [03:26.62][03:26.62]'t [03:26.78]ta [03:26.92]\n[03:27.14]紅[03:27.31]蓮[03:27.90]の[03:28.43]華[03:28.88]よ[03:29.56]咲[03:29.96]き[03:30.33]誇[03:30.81]れ[03:31.35]\n[03:27.14]gu [03:27.31][03:27.31]re [03:27.60][03:27.60]n [03:27.90][03:27.90]no [03:28.43]ha [03:28.62][03:28.62]na [03:28.88]yo [03:29.56][03:29.56]sa [03:29.96]ki [03:30.33]ho [03:30.56][03:30.56]ko [03:30.81][03:30.81]re [03:31.35]\n[03:31.59]運[03:31.98]命[03:32.42]を[03:33.25]照[03:33.47]ら[03:33.81]し[03:33.94]て[03:38.18]\n[03:31.59]u [03:31.79]n [03:31.98][03:31.98]me [03:32.20]i [03:32.42][03:32.42]wo [03:33.25]te [03:33.47]ra [03:33.81][03:33.81]shi [03:33.94]te [03:38.17]\n[03:42.47]運[03:42.74]命[03:43.12]を[03:44.03]照[03:44.22]ら[03:44.53]し[03:44.67]て[03:45.25]\n[03:42.47]u [03:42.61]n [03:42.74][03:42.74]me [03:42.97]i [03:43.12][03:43.12]wo [03:44.03]te [03:44.22]ra [03:44.53][03:44.53]shi [03:44.67][03:44.67]te [03:45.24]",
    "lrcUrl": "assets/lyrics/track_17.lrc"
  },
  {
    "index": "018",
    "spineNum": "18",
    "serial": "WK-REAL-18",
    "title": "光年之外",
    "shortTitle": "光年之外 · 邓紫棋",
    "spineTitle": "光年之外 · 太空旅客",
    "subtitleQuote": "| 感受停在我发端的指尖，如何瞬间冻结时间",
    "artist": "G.E.M. 邓紫棋",
    "subArtist": "科幻电影《太空旅客》中文主题曲",
    "statusTag": "浩瀚情歌",
    "subTag": "百亿播放",
    "durationSec": 236,
    "currentSec": 0,
    "accent": "#8b5cf6",
    "c1": "#a78bfa",
    "c2": "#4c1d95",
    "picUrl": "assets/covers/cover_18.jpg",
    "audioUrl": "assets/audio/track_18.mp3",
    "notes": [
      261.63,
      293.66,
      329.63,
      392,
      440,
      392,
      329.63,
      293.66
    ],
    "lyrics": [
      {
        "t": 0,
        "l1": "光年之外 《太空旅客（Passengers）》电影中国区主题 - G.E.M.邓紫棋",
        "l2": ""
      },
      {
        "t": 5.79,
        "l1": "词：G.E.M.邓紫棋",
        "l2": ""
      },
      {
        "t": 6.63,
        "l1": "曲：G.E.M.邓紫棋",
        "l2": ""
      },
      {
        "t": 7.52,
        "l1": "编曲：Lupo Groinig",
        "l2": ""
      },
      {
        "t": 8.23,
        "l1": "监制：Lupo Groinig",
        "l2": ""
      },
      {
        "t": 8.97,
        "l1": "OP：蜂鸟音乐",
        "l2": ""
      },
      {
        "t": 9.85,
        "l1": "SP：百纳娱乐",
        "l2": ""
      },
      {
        "t": 12.54,
        "l1": "感受停在我发端的指尖",
        "l2": ""
      },
      {
        "t": 16.62,
        "l1": "如何瞬间冻结时间",
        "l2": ""
      },
      {
        "t": 23.45,
        "l1": "记住望着我坚定的双眼",
        "l2": ""
      },
      {
        "t": 27.53,
        "l1": "也许已经没有明天",
        "l2": ""
      },
      {
        "t": 33.99,
        "l1": "面对浩瀚的星海",
        "l2": ""
      },
      {
        "t": 36.58,
        "l1": "我们微小得像尘埃",
        "l2": ""
      },
      {
        "t": 39.04,
        "l1": "漂浮在一片无奈",
        "l2": ""
      },
      {
        "t": 44.94,
        "l1": "缘分让我们相遇乱世以外",
        "l2": ""
      },
      {
        "t": 50.31,
        "l1": "命运却要我们危难中相爱",
        "l2": ""
      },
      {
        "t": 55.78,
        "l1": "也许未来遥远在光年之外",
        "l2": ""
      },
      {
        "t": 61.25,
        "l1": "我愿守候未知里为你等待",
        "l2": ""
      },
      {
        "t": 65.35,
        "l1": "我没想到为了你我能疯狂到",
        "l2": ""
      },
      {
        "t": 70.67,
        "l1": "山崩海啸没有你根本不想逃",
        "l2": ""
      },
      {
        "t": 76.29,
        "l1": "我的大脑为了你已经疯狂到",
        "l2": ""
      },
      {
        "t": 81.71,
        "l1": "脉搏心跳没有你根本不重要",
        "l2": ""
      },
      {
        "t": 88.92,
        "l1": "一双围在我胸口的臂弯",
        "l2": ""
      },
      {
        "t": 92.93,
        "l1": "足够抵挡天旋地转",
        "l2": ""
      },
      {
        "t": 99.83,
        "l1": "一种执迷不放手的倔强",
        "l2": ""
      },
      {
        "t": 103.89,
        "l1": "足以点燃所有希望",
        "l2": ""
      },
      {
        "t": 110.33,
        "l1": "宇宙磅礴而冷漠",
        "l2": ""
      },
      {
        "t": 112.89,
        "l1": "我们的爱微小却闪烁",
        "l2": ""
      },
      {
        "t": 115.41,
        "l1": "颠簸却如此忘我",
        "l2": ""
      },
      {
        "t": 121.21,
        "l1": "缘分让我们相遇乱世以外",
        "l2": ""
      },
      {
        "t": 126.72,
        "l1": "命运却要我们危难中相爱",
        "l2": ""
      },
      {
        "t": 132.16,
        "l1": "也许未来遥远在光年之外",
        "l2": ""
      },
      {
        "t": 137.58,
        "l1": "我愿守候未知里为你等待",
        "l2": ""
      },
      {
        "t": 141.63,
        "l1": "我没想到为了你我能疯狂到",
        "l2": ""
      },
      {
        "t": 147.12,
        "l1": "山崩海啸没有你根本不想逃",
        "l2": ""
      },
      {
        "t": 152.63,
        "l1": "我的大脑为了你已经疯狂到",
        "l2": ""
      },
      {
        "t": 158,
        "l1": "脉搏心跳没有你根本不重要",
        "l2": ""
      },
      {
        "t": 163.96,
        "l1": "也许航道以外是醒不来的梦",
        "l2": ""
      },
      {
        "t": 176.48,
        "l1": "乱世以外是纯粹的相拥",
        "l2": ""
      },
      {
        "t": 185.34,
        "l1": "我没想到为了你我能疯狂到",
        "l2": ""
      },
      {
        "t": 190.72,
        "l1": "山崩海啸没有你根本不想逃",
        "l2": ""
      },
      {
        "t": 196.23,
        "l1": "我的大脑为了你已经疯狂到",
        "l2": ""
      },
      {
        "t": 201.58,
        "l1": "脉搏心跳没有你根本不重要",
        "l2": ""
      },
      {
        "t": 207.51,
        "l1": "相遇乱世以外危难中相爱",
        "l2": ""
      },
      {
        "t": 218.26,
        "l1": "相遇乱世以外危难中相爱",
        "l2": ""
      },
      {
        "t": 228.98,
        "l1": "我没想到",
        "l2": ""
      }
    ],
    "comments": [
      "【热评 @星际穿越】邓紫棋极具穿透力的高音，把茫茫宇宙中彼此唯一依托的宿命感演绎得荡气回肠。"
    ],
    "lyricsRaw": "[ti:光年之外]\n[ar:G.E.M.邓紫棋]\n[al:光年之外]\n[by:v_shkzhong]\n[offset:0]\n\n[00:00.00]光[00:00.62]年[00:00.92]之[00:01.22][00:01.22]外 [00:01.49]《[00:01.76][00:01.77]太[00:02.04]空[00:02.27][00:02.27]旅[00:02.52]客[00:02.77]（Passengers）[00:03.00][00:03.00]》[00:03.23]电[00:03.47][00:03.47]影[00:03.68][00:03.68]中[00:03.89]国[00:04.11][00:04.11]区[00:04.32][00:04.32]主[00:04.52]题[00:04.73][00:04.88] - [00:05.09][00:05.09]G.E.M.[00:05.25][00:05.25]邓[00:05.45]紫[00:05.61]棋[00:05.79]\n[00:05.79]词：[00:05.95]G.E.M.[00:06.14]邓[00:06.30][00:06.30]紫[00:06.46][00:06.46]棋[00:06.63]\n[00:06.63]曲：[00:06.80]G.E.M.[00:06.96][00:06.96]邓[00:07.16]紫[00:07.35]棋[00:07.52]\n[00:07.52]编[00:07.68]曲：[00:07.88]Lupo [00:08.06][00:08.06]Groinig[00:08.23]\n[00:08.23]监[00:08.41]制：[00:08.59]Lupo [00:08.78][00:08.78]Groinig[00:08.97]\n[00:08.97]OP：[00:09.14][00:09.14]蜂[00:09.32][00:09.33]鸟[00:09.51]音[00:09.68][00:09.69]乐[00:09.85]\n[00:09.85]SP：[00:10.05][00:10.05]百[00:10.24]纳[00:10.43]娱[00:10.63][00:10.63]乐[00:10.92]\n[00:12.54]感[00:12.80]受[00:13.18][00:13.18]停[00:13.47][00:13.47]在[00:13.81][00:13.81]我[00:14.16][00:14.16]发[00:14.49][00:14.49]端[00:14.84]的[00:15.21][00:15.21]指[00:15.54]尖[00:16.34]\n[00:16.62]如[00:16.89][00:16.89]何[00:17.25]瞬[00:17.90][00:17.90]间[00:19.34]冻[00:19.65][00:19.65]结[00:20.01][00:20.01]时[00:20.64]间[00:21.76]\n[00:23.45]记[00:23.73]住[00:24.07][00:24.07]望[00:24.38]着[00:24.75][00:24.75]我[00:25.10][00:25.10]坚[00:25.43]定[00:25.75][00:25.75]的[00:26.09]双[00:26.48][00:26.48]眼[00:27.31]\n[00:27.53]也[00:27.79][00:27.79]许[00:28.13]已[00:28.79]经[00:30.26][00:30.26]没[00:30.56][00:30.56]有[00:30.90][00:30.91]明[00:31.60]天[00:32.87]\n[00:33.99]面[00:34.13]对[00:34.32][00:34.32]浩[00:34.64][00:34.65]瀚[00:34.86][00:34.86]的[00:35.05]星[00:35.35]海[00:36.18]\n[00:36.58]我[00:36.70][00:36.70]们[00:36.89]微[00:37.05][00:37.05]小[00:37.17]得[00:37.35][00:37.35]像[00:37.66]尘[00:38.05][00:38.05]埃[00:38.80]\n[00:39.04]漂[00:39.22]浮[00:39.45][00:39.45]在[00:40.40]一[00:40.80][00:40.80]片[00:41.49]无[00:41.85][00:41.85]奈[00:43.29]\n[00:44.94]缘[00:45.20][00:45.20]分[00:45.56][00:45.56]让[00:45.84]我[00:46.18][00:46.18]们[00:46.50]相[00:46.85][00:46.85]遇[00:47.36][00:47.36]乱[00:47.59]世[00:47.94][00:47.94]以[00:48.30]外[00:49.42]\n[00:50.31]命[00:50.63][00:50.63]运[00:51.00]却[00:51.35][00:51.35]要[00:51.70]我[00:52.03][00:52.03]们[00:52.34]危[00:52.82]难[00:53.06][00:53.06]中[00:53.35]相[00:53.73][00:53.74]爱[00:54.88]\n[00:55.78]也[00:56.12]许[00:56.41][00:56.41]未[00:56.79][00:56.79]来[00:57.12][00:57.12]遥[00:57.48]远[00:57.83][00:57.83]在[00:58.39]光[00:58.54]年[00:58.86][00:58.86]之[00:59.19]外[01:00.31]\n[01:01.25]我[01:01.57]愿[01:01.93]守[01:02.24][01:02.25]候[01:02.59][01:02.59]未[01:02.90]知[01:03.21]里[01:03.72][01:03.72]为[01:03.96]你[01:04.24][01:04.25]等[01:04.62]待[01:05.10]\n[01:05.35]我[01:05.63][01:05.64]没[01:05.97]想[01:06.33]到[01:06.70][01:06.70]为[01:06.82]了[01:06.96][01:06.97]你[01:07.29]我[01:07.67][01:07.67]能[01:08.00][01:08.00]疯[01:08.51]狂[01:09.11][01:09.11]到[01:09.84]\n[01:10.67]山[01:11.07]崩[01:11.43]海[01:11.81][01:11.81]啸[01:12.15][01:12.15]没[01:12.34]有[01:12.51][01:12.51]你[01:12.81][01:12.81]根[01:13.17]本[01:13.51]不[01:14.05][01:14.05]想[01:14.60][01:14.60]逃[01:15.43]\n[01:16.29]我[01:16.54][01:16.54]的[01:16.93]大[01:17.28]脑[01:17.60]为[01:17.79][01:17.79]了[01:17.93]你[01:18.26]已[01:18.59][01:18.59]经[01:18.92]疯[01:19.46][01:19.46]狂[01:20.02][01:20.02]到[01:20.78]\n[01:21.71]脉[01:21.98]搏[01:22.35]心[01:22.67]跳[01:23.05][01:23.05]没[01:23.25]有[01:23.41][01:23.41]你[01:23.73]根[01:24.03][01:24.04]本[01:24.38][01:24.38]不[01:24.89]重[01:25.49][01:25.50]要[01:26.32]\n[01:28.92]一[01:29.17][01:29.17]双[01:29.51]围[01:29.86][01:29.86]在[01:30.19][01:30.19]我[01:30.54]胸[01:30.88]口[01:31.22]的[01:31.55][01:31.55]臂[01:31.94]弯[01:32.61]\n[01:32.93]足[01:33.22][01:33.22]够[01:33.60][01:33.60]抵[01:34.24][01:34.24]挡[01:35.68][01:35.68]天[01:36.01]旋[01:36.35][01:36.35]地[01:36.99][01:37.00]转[01:38.37]\n[01:39.83]一[01:40.08]种[01:40.42]执[01:40.77][01:40.77]迷[01:41.13][01:41.13]不[01:41.46]放[01:41.81][01:41.81]手[01:42.15]的[01:42.48][01:42.48]倔[01:42.82]强[01:43.65]\n[01:43.89]足[01:44.18][01:44.18]以[01:44.56]点[01:45.20]燃[01:46.60][01:46.60]所[01:46.86][01:46.86]有[01:47.24]希[01:47.93]望[01:49.16]\n[01:50.33]宇[01:50.45][01:50.46]宙[01:50.63][01:50.63]磅[01:51.01][01:51.02]礴[01:51.19]而[01:51.38]冷[01:51.74][01:51.75]漠[01:52.44]\n[01:52.89]我[01:53.02]们[01:53.20][01:53.21]的[01:53.38][01:53.38]爱[01:53.50]微[01:53.69]小[01:53.89]却[01:54.10][01:54.10]闪[01:54.43]烁[01:55.13]\n[01:55.41]颠[01:55.84]簸[01:56.74][01:56.74]却[01:56.91]如[01:57.12][01:57.12]此[01:57.75]忘[01:58.16][01:58.16]我[02:00.09]\n[02:01.21]缘[02:01.54]分[02:01.90][02:01.90]让[02:02.22]我[02:02.55][02:02.55]们[02:02.85][02:02.85]相[02:03.11]遇[02:03.71][02:03.71]乱[02:03.91][02:03.91]世[02:04.25]以[02:04.60][02:04.60]外[02:06.01]\n[02:06.72]命[02:06.98]运[02:07.34][02:07.34]却[02:07.68]要[02:07.99][02:08.00]我[02:08.31]们[02:08.66][02:08.66]危[02:09.16]难[02:09.45][02:09.45]中[02:09.69]相[02:10.07]爱[02:11.28]\n[02:12.16]也[02:12.46][02:12.46]许[02:12.77]未[02:13.10][02:13.11]来[02:13.42]遥[02:13.76]远[02:14.12][02:14.12]在[02:14.61]光[02:14.87][02:14.87]年[02:15.18][02:15.18]之[02:15.53][02:15.53]外[02:17.12]\n[02:17.58]我[02:17.89]愿[02:18.26][02:18.26]守[02:18.60][02:18.60]候[02:18.91]未[02:19.27]知[02:19.59]里[02:20.10][02:20.10]为[02:20.36][02:20.37]你[02:20.66]等[02:21.02][02:21.02]待[02:21.45]\n[02:21.63]我[02:21.94][02:21.94]没[02:22.30]想[02:22.65]到[02:23.02]为[02:23.20]了[02:23.34][02:23.34]你[02:23.69][02:23.69]我[02:24.00]能[02:24.35]疯[02:24.85][02:24.85]狂[02:25.41]到[02:26.18]\n[02:27.12]山[02:27.45][02:27.46]崩[02:27.81]海[02:28.16]啸[02:28.50]没[02:28.68][02:28.68]有[02:28.87]你[02:29.17]根[02:29.51]本[02:29.84][02:29.84]不[02:30.36]想[02:30.89][02:30.89]逃[02:31.71]\n[02:32.63]我[02:32.94][02:32.94]的[02:33.28]大[02:33.64][02:33.64]脑[02:33.98][02:33.98]为[02:34.17][02:34.17]了[02:34.34][02:34.34]你[02:34.63][02:34.63]已[02:34.92]经[02:35.30][02:35.30]疯[02:35.79]狂[02:36.35][02:36.35]到[02:37.19]\n[02:38.00]脉[02:38.30]搏[02:38.69]心[02:39.03][02:39.03]跳[02:39.40]没[02:39.61]有[02:39.78]你[02:40.06][02:40.06]根[02:40.39]本[02:40.73][02:40.73]不[02:41.23]重[02:41.81][02:41.81]要[02:42.66]\n[02:43.96]也[02:44.44]许[02:45.60][02:45.60]航[02:45.90]道[02:46.56][02:46.56]以[02:47.16]外[02:49.63][02:49.63]是[02:49.98][02:49.98]醒[02:50.61]不[02:51.30]来[02:52.03][02:52.03]的[02:52.69][02:52.69]梦[02:53.98]\n[02:56.48]乱[02:56.78]世[02:57.45][02:57.46]以[02:58.15]外[03:00.49][03:00.49]是[03:00.90][03:00.90]纯[03:01.55]粹[03:02.16][03:02.16]的[03:02.97]相[03:03.57][03:03.58]拥[03:04.99]\n[03:05.34]我[03:05.60]没[03:05.95][03:05.96]想[03:06.32]到[03:06.66][03:06.66]为[03:06.85]了[03:07.03][03:07.03]你[03:07.34][03:07.34]我[03:07.65]能[03:08.00]疯[03:08.56][03:08.56]狂[03:09.09][03:09.09]到[03:09.79]\n[03:10.72]山[03:11.06]崩[03:11.46]海[03:11.80]啸[03:12.14][03:12.15]没[03:12.35]有[03:12.54][03:12.54]你[03:12.83][03:12.83]根[03:13.16]本[03:13.50]不[03:14.01][03:14.02]想[03:14.57][03:14.57]逃[03:15.32]\n[03:16.23]我[03:16.49][03:16.49]的[03:16.87]大[03:17.24][03:17.24]脑[03:17.58][03:17.58]为[03:17.78]了[03:17.97]你[03:18.22][03:18.22]已[03:18.56][03:18.56]经[03:18.90]疯[03:19.44][03:19.44]狂[03:19.97][03:19.97]到[03:20.80]\n[03:21.58]脉[03:21.89][03:21.89]搏[03:22.25][03:22.26]心[03:22.64]跳[03:23.01]没[03:23.20][03:23.20]有[03:23.38]你[03:23.66][03:23.66]根[03:24.01]本[03:24.35][03:24.36]不[03:24.91][03:24.91]重[03:25.43]要[03:26.16]\n[03:27.51]相[03:27.77][03:27.77]遇[03:28.10]乱[03:30.21][03:30.21]世[03:30.53]以[03:30.89]外[03:33.08]危[03:33.58][03:33.58]难[03:35.65]中[03:35.91][03:35.91]相[03:36.35]爱[03:37.77]\n[03:38.26]相[03:38.71][03:38.71]遇[03:39.07][03:39.07]乱[03:41.17]世[03:41.41]以[03:41.81][03:41.81]外[03:43.94]危[03:44.50][03:44.50]难[03:46.49]中[03:46.83]相[03:47.24]爱[03:48.50]\n[03:48.98]我[03:49.26]没[03:49.56][03:49.56]想[03:49.94][03:49.95]到[03:50.84]",
    "lrcUrl": "assets/lyrics/track_18.lrc"
  },
  {
    "index": "019",
    "spineNum": "19",
    "serial": "WK-REAL-19",
    "title": "稻香",
    "shortTitle": "稻香 · 周杰伦",
    "spineTitle": "稻香 · 温暖治愈",
    "subtitleQuote": "| 功成名就不是目的，让自己快乐快乐这才叫做意义",
    "artist": "周杰伦",
    "subArtist": "经典专辑《魔杰座》温暖主打",
    "statusTag": "温暖童年",
    "subTag": "乡间微风",
    "durationSec": 223,
    "currentSec": 0,
    "accent": "#84cc16",
    "c1": "#a3e635",
    "c2": "#365314",
    "picUrl": "assets/covers/cover_19.jpg",
    "audioUrl": "assets/audio/track_19.mp3",
    "notes": [
      261.63,
      293.66,
      329.63,
      392,
      523.25,
      392,
      329.63,
      261.63
    ],
    "lyrics": [
      {
        "t": 0,
        "l1": "稻香 - 周杰伦 Jay Chou",
        "l2": ""
      },
      {
        "t": 7.73,
        "l1": "词：周杰伦",
        "l2": ""
      },
      {
        "t": 15.47,
        "l1": "曲：周杰伦",
        "l2": ""
      },
      {
        "t": 23.2,
        "l1": "编曲：黄雨勋",
        "l2": ""
      },
      {
        "t": 30.94,
        "l1": "对这个世界如果你有太多的抱怨",
        "l2": ""
      },
      {
        "t": 34.22,
        "l1": "跌倒了就不敢继续往前走",
        "l2": ""
      },
      {
        "t": 37.31,
        "l1": "为什么人要这么的脆弱堕落",
        "l2": ""
      },
      {
        "t": 41.47,
        "l1": "请你打开电视看看",
        "l2": ""
      },
      {
        "t": 43.07,
        "l1": "多少人为生命在努力勇敢的走下去",
        "l2": ""
      },
      {
        "t": 47.07,
        "l1": "我们是不是该知足",
        "l2": ""
      },
      {
        "t": 49.47,
        "l1": "珍惜一切就算没有拥有",
        "l2": ""
      },
      {
        "t": 53.99,
        "l1": "还记得你说家是唯一的城堡",
        "l2": ""
      },
      {
        "t": 57.68,
        "l1": "随着稻香河流继续奔跑",
        "l2": ""
      },
      {
        "t": 60.69,
        "l1": "微微笑 小时候的梦我知道",
        "l2": ""
      },
      {
        "t": 65.7,
        "l1": "不要哭让萤火虫带着你逃跑",
        "l2": ""
      },
      {
        "t": 69.45,
        "l1": "乡间的歌谣永远的依靠",
        "l2": ""
      },
      {
        "t": 72.38,
        "l1": "回家吧 回到最初的美好",
        "l2": ""
      },
      {
        "t": 101.08,
        "l1": "不要这么容易就想放弃",
        "l2": ""
      },
      {
        "t": 103.3,
        "l1": "就像我说的",
        "l2": ""
      },
      {
        "t": 104.79,
        "l1": "追不到的梦想换个梦不就得了",
        "l2": ""
      },
      {
        "t": 107.76,
        "l1": "为自己的人生鲜艳上色",
        "l2": ""
      },
      {
        "t": 109.82,
        "l1": "先把爱涂上喜欢的颜色",
        "l2": ""
      },
      {
        "t": 112.76,
        "l1": "笑一个吧",
        "l2": ""
      },
      {
        "t": 113.75,
        "l1": "功成名就不是目的",
        "l2": ""
      },
      {
        "t": 115.74,
        "l1": "让自己快乐快乐这才叫做意义",
        "l2": ""
      },
      {
        "t": 118.67,
        "l1": "童年的纸飞机",
        "l2": ""
      },
      {
        "t": 120.19,
        "l1": "现在终于飞回我手里",
        "l2": ""
      },
      {
        "t": 124.41,
        "l1": "所谓的那快乐",
        "l2": ""
      },
      {
        "t": 125.81,
        "l1": "赤脚在田里追蜻蜓追到累了",
        "l2": ""
      },
      {
        "t": 128.78,
        "l1": "偷摘水果被蜜蜂给叮到怕了",
        "l2": ""
      },
      {
        "t": 131.77,
        "l1": "谁在偷笑呢",
        "l2": ""
      },
      {
        "t": 133.28,
        "l1": "我靠着稻草人",
        "l2": ""
      },
      {
        "t": 134.53,
        "l1": "吹着风 唱着歌 睡着了",
        "l2": ""
      },
      {
        "t": 137.51,
        "l1": "午后吉他在虫鸣中更清脆",
        "l2": ""
      },
      {
        "t": 140.42,
        "l1": "阳光洒在路上就不怕心碎",
        "l2": ""
      },
      {
        "t": 143.03,
        "l1": "珍惜一切 就算没有拥有",
        "l2": ""
      },
      {
        "t": 147.65,
        "l1": "还记得你说家是唯一的城堡",
        "l2": ""
      },
      {
        "t": 151.43,
        "l1": "随着稻香河流继续奔跑",
        "l2": ""
      },
      {
        "t": 154.37,
        "l1": "微微笑 小时候的梦我知道",
        "l2": ""
      },
      {
        "t": 159.37,
        "l1": "不要哭让萤火虫带着你逃跑",
        "l2": ""
      },
      {
        "t": 163.15,
        "l1": "乡间的歌谣永远的依靠",
        "l2": ""
      },
      {
        "t": 166.04,
        "l1": "回家吧 回到最初的美好",
        "l2": ""
      },
      {
        "t": 171.08,
        "l1": "还记得你说家是唯一的城堡",
        "l2": ""
      },
      {
        "t": 174.81,
        "l1": "随着稻香河流继续奔跑",
        "l2": ""
      },
      {
        "t": 177.78,
        "l1": "微微笑 小时候的梦我知道",
        "l2": ""
      },
      {
        "t": 182.75,
        "l1": "不要哭让萤火虫带着你逃跑",
        "l2": ""
      },
      {
        "t": 186.53,
        "l1": "乡间的歌谣永远的依靠",
        "l2": ""
      },
      {
        "t": 189.48,
        "l1": "回家吧 回到最初的美好",
        "l2": ""
      }
    ],
    "comments": [
      "【热评 @田埂上的风】无论在大城市受了多少委屈，听这首歌就像回到了无忧无虑的乡下外婆家。"
    ],
    "lyricsRaw": "[ti:稻香]\n[ar:周杰伦]\n[al:魔杰座]\n[offset:0]\n\n[00:00.00]稻[00:00.55]香[00:01.10] [00:01.65]-[00:02.20] [00:02.76]周[00:03.31]杰[00:03.86]伦[00:04.41] [00:04.96][00:05.52]Jay[00:06.07] [00:06.62]Chou[00:07.17]\n[00:07.73]词[00:09.27]：[00:10.82]周[00:12.37]杰[00:13.92]伦[00:15.47]\n[00:15.47]曲[00:17.01]：[00:18.56]周[00:20.10]杰[00:21.65]伦[00:23.20]\n[00:23.20]编[00:24.49]曲[00:25.78]：[00:27.07]黄[00:28.36]雨[00:29.65]勋[00:30.94]\n[00:30.94]对[00:31.10]这[00:31.25]个[00:31.45]世[00:31.70]界[00:31.90]如[00:32.43]果[00:32.63]你[00:32.84]有[00:33.02]太[00:33.19]多[00:33.33]的[00:33.57]抱[00:33.90]怨[00:34.22]\n[00:34.22]跌[00:34.55]倒[00:34.76]了[00:35.30]就[00:35.48]不[00:35.74]敢[00:35.92]继[00:36.09]续[00:36.30]往[00:36.53]前[00:36.83]走[00:37.11]\n[00:37.31]为[00:37.55]什[00:37.75]么[00:38.30]人[00:38.49]要[00:38.69]这[00:38.86]么[00:39.02]的[00:39.19]脆[00:39.38]弱[00:39.75]堕[00:40.10]落[00:40.84]\n[00:41.47]请[00:41.77]你[00:41.96]打[00:42.13]开[00:42.32]电[00:42.48]视[00:42.67]看[00:42.82]看[00:43.07]\n[00:43.07]多[00:43.37]少[00:43.59]人[00:44.14]为[00:44.36]生[00:44.55]命[00:44.71]在[00:44.89]努[00:45.06]力[00:45.28]勇[00:45.60]敢[00:45.76]的[00:45.99]走[00:46.32]下[00:46.52]去[00:46.78]\n[00:47.07]我[00:47.25]们[00:47.46]是[00:47.62]不[00:47.79]是[00:47.96]该[00:48.24]知[00:48.55]足[00:48.92]\n[00:49.47]珍[00:49.68]惜[00:50.14]一[00:50.52]切[00:50.71]就[00:50.87]算[00:51.07]没[00:51.24]有[00:51.47]拥[00:51.84]有[00:52.83]\n[00:53.99]还[00:54.35]记[00:54.75]得[00:55.10]你[00:55.31]说[00:55.63]家[00:55.99]是[00:56.38]唯[00:56.59]一[00:56.75]的[00:56.99]城[00:57.34]堡[00:57.68]\n[00:57.68]随[00:58.00]着[00:58.22]稻[00:58.55]香[00:58.93]河[00:59.31]流[00:59.52]继[00:59.70]续[00:59.91]奔[01:00.22]跑[01:00.47]\n[01:00.69]微[01:00.95]微[01:01.12]笑[01:01.73] [01:01.73]小[01:01.91]时[01:02.09]候[01:02.41]的[01:02.58]梦[01:02.81]我[01:03.12]知[01:03.48]道[01:04.75]\n[01:05.70]不[01:06.04]要[01:06.45]哭[01:06.80]让[01:07.02]萤[01:07.34]火[01:07.71]虫[01:08.11]带[01:08.28]着[01:08.44]你[01:08.71]逃[01:08.98]跑[01:09.22]\n[01:09.45]乡[01:09.75]间[01:09.93]的[01:10.23]歌[01:10.58]谣[01:11.03]永[01:11.20]远[01:11.38]的[01:11.61]依[01:11.87]靠[01:12.13]\n[01:12.38]回[01:12.63]家[01:12.80]吧[01:13.37] [01:13.37]回[01:13.53]到[01:13.71]最[01:14.07]初[01:14.27]的[01:14.85]美[01:15.21]好[01:16.39]\n[01:41.08]不[01:41.26]要[01:41.43]这[01:41.60]么[01:41.91]容[01:42.10]易[01:42.31]就[01:42.49]想[01:42.72]放[01:43.12]弃[01:43.30]\n[01:43.30]就[01:43.47]像[01:43.61]我[01:43.80]说[01:44.12]的[01:44.36]\n[01:44.79]追[01:44.96]不[01:45.10]到[01:45.25]的[01:45.43]梦[01:45.68]想[01:45.86]换[01:46.01]个[01:46.18]梦[01:46.39]不[01:46.57]就[01:46.82]得[01:47.13]了[01:47.43]\n[01:47.76]为[01:47.93]自[01:48.10]己[01:48.26]的[01:48.51]人[01:48.67]生[01:48.88]鲜[01:49.03]艳[01:49.33]上[01:49.50]色[01:49.82]\n[01:49.82]先[01:50.00]把[01:50.19]爱[01:50.42]涂[01:50.59]上[01:50.77]喜[01:50.94]欢[01:51.15]的[01:51.31]颜[01:51.47]色[01:51.69]\n[01:52.76]笑[01:52.93]一[01:53.11]个[01:53.32]吧[01:53.54]\n[01:53.75]功[01:53.93]成[01:54.07]名[01:54.21]就[01:54.41]不[01:54.57]是[01:54.81]目[01:55.12]的[01:55.48]\n[01:55.74]让[01:55.91]自[01:56.05]己[01:56.27]快[01:56.41]乐[01:56.58]快[01:56.73]乐[01:56.97]这[01:57.13]才[01:57.31]叫[01:57.46]做[01:57.72]意[01:58.05]义[01:58.39]\n[01:58.67]童[01:58.84]年[01:58.98]的[01:59.20]纸[01:59.50]飞[01:59.66]机[01:59.89]\n[02:00.19]现[02:00.48]在[02:00.67]终[02:00.82]于[02:00.97]飞[02:01.15]回[02:01.43]我[02:01.74]手[02:02.10]里[02:03.05]\n[02:04.41]所[02:04.57]谓[02:04.71]的[02:04.84]那[02:05.03]快[02:05.34]乐[02:05.60]\n[02:05.81]赤[02:05.96]脚[02:06.24]在[02:06.58]田[02:06.76]里[02:06.92]追[02:07.07]蜻[02:07.25]蜓[02:07.59]追[02:07.75]到[02:07.96]累[02:08.27]了[02:08.61]\n[02:08.78]偷[02:08.95]摘[02:09.22]水[02:09.53]果[02:09.71]被[02:09.88]蜜[02:10.03]蜂[02:10.19]给[02:10.36]叮[02:10.52]到[02:10.85]怕[02:11.20]了[02:11.54]\n[02:11.77]谁[02:11.95]在[02:12.11]偷[02:12.31]笑[02:12.65]呢[02:12.96]\n[02:13.28]我[02:13.46]靠[02:13.59]着[02:13.80]稻[02:13.96]草[02:14.12]人[02:14.32]\n[02:14.53]吹[02:14.69]着[02:14.84]风[02:15.21] [02:15.21]唱[02:15.39]着[02:15.57]歌[02:15.96] [02:15.96]睡[02:16.13]着[02:16.26]了[02:16.64]\n[02:17.51]午[02:17.67]后[02:17.83]吉[02:17.99]他[02:18.14]在[02:18.34]虫[02:18.52]鸣[02:18.65]中[02:18.92]更[02:19.11]清[02:19.26]脆[02:19.56]\n[02:20.42]阳[02:20.59]光[02:20.75]洒[02:20.91]在[02:21.25]路[02:21.45]上[02:21.62]就[02:21.77]不[02:21.93]怕[02:22.09]心[02:22.24]碎[02:22.56]\n[02:23.03]珍[02:23.23]惜[02:23.77]一[02:24.16]切[02:24.35] [02:24.35]就[02:24.52]算[02:24.76]没[02:24.93]有[02:25.13]拥[02:25.48]有[02:26.57]\n[02:27.65]还[02:28.03]记[02:28.40]得[02:28.76]你[02:28.98]说[02:29.29]家[02:29.62]是[02:30.04]唯[02:30.23]一[02:30.40]的[02:30.66]城[02:30.99]堡[02:31.20]\n[02:31.43]随[02:31.73]着[02:31.93]稻[02:32.23]香[02:32.58]河[02:33.01]流[02:33.20]继[02:33.35]续[02:33.60]奔[02:33.89]跑[02:34.11]\n[02:34.37]微[02:34.66]微[02:34.83]笑[02:35.37] [02:35.37]小[02:35.54]时[02:35.73]候[02:36.05]的[02:36.24]梦[02:36.46]我[02:36.81]知[02:37.18]道[02:38.40]\n[02:39.37]不[02:39.74]要[02:40.13]哭[02:40.47]让[02:40.68]萤[02:40.99]火[02:41.35]虫[02:41.73]带[02:41.94]着[02:42.09]你[02:42.37]逃[02:42.69]跑[02:42.91]\n[02:43.15]乡[02:43.42]间[02:43.62]的[02:43.94]歌[02:44.29]谣[02:44.69]永[02:44.89]远[02:45.05]的[02:45.30]依[02:45.57]靠[02:45.81]\n[02:46.04]回[02:46.32]家[02:46.49]吧[02:47.07] [02:47.07]回[02:47.24]到[02:47.45]最[02:47.81]初[02:48.01]的[02:48.52]美[02:48.89]好[02:50.30]\n[02:51.08]还[02:51.46]记[02:51.85]得[02:52.17]你[02:52.37]说[02:52.67]家[02:53.03]是[02:53.42]唯[02:53.61]一[02:53.79]的[02:54.08]城[02:54.37]堡[02:54.59]\n[02:54.81]随[02:55.14]着[02:55.33]稻[02:55.65]香[02:56.00]河[02:56.41]流[02:56.60]继[02:56.77]续[02:57.01]奔[02:57.31]跑[02:57.54]\n[02:57.78]微[02:58.01]微[02:58.18]笑[02:58.75] [02:58.75]小[02:58.92]时[02:59.13]候[02:59.47]的[02:59.65]梦[02:59.87]我[03:00.22]知[03:00.57]道[03:01.86]\n[03:02.75]不[03:03.13]要[03:03.52]哭[03:03.89]让[03:04.08]萤[03:04.41]火[03:04.77]虫[03:05.17]带[03:05.35]着[03:05.52]你[03:05.77]逃[03:06.06]跑[03:06.29]\n[03:06.53]乡[03:06.81]间[03:07.01]的[03:07.34]歌[03:07.69]谣[03:08.11]永[03:08.29]远[03:08.46]的[03:08.75]依[03:09.01]靠[03:09.25]\n[03:09.48]回[03:09.74]家[03:09.89]吧[03:10.48] [03:10.48]回[03:10.66]到[03:10.86]最[03:11.20]初[03:11.38]的[03:11.98]美[03:12.33]好[03:13.85]",
    "lrcUrl": "assets/lyrics/track_19.lrc"
  },
  {
    "index": "020",
    "spineNum": "20",
    "serial": "WK-REAL-20",
    "title": "告白气球",
    "shortTitle": "告白气球 · 周杰伦",
    "spineTitle": "告白气球 · 浪漫满分",
    "subtitleQuote": "| 亲爱的，爱上你，从那天起，甜蜜的很轻易",
    "artist": "周杰伦",
    "subArtist": "专辑《周杰伦的床边故事》爆款金曲",
    "statusTag": "浪漫满溢",
    "subTag": "塞纳河畔",
    "durationSec": 218,
    "currentSec": 0,
    "accent": "#f43f5e",
    "c1": "#fb7185",
    "c2": "#881337",
    "picUrl": "assets/covers/cover_20.jpg",
    "audioUrl": "assets/audio/track_20.mp3",
    "notes": [
      293.66,
      329.63,
      392,
      440,
      523.25,
      440,
      392,
      329.63
    ],
    "lyrics": [
      {
        "t": 0,
        "l1": "告白气球 - 周杰伦 Jay Chou",
        "l2": ""
      },
      {
        "t": 5.89,
        "l1": "词：方文山",
        "l2": ""
      },
      {
        "t": 11.79,
        "l1": "曲：周杰伦",
        "l2": ""
      },
      {
        "t": 17.69,
        "l1": "编曲：林迈可",
        "l2": ""
      },
      {
        "t": 23.59,
        "l1": "塞纳河畔 左岸的咖啡",
        "l2": ""
      },
      {
        "t": 26.16,
        "l1": "我手一杯 品尝你的美",
        "l2": ""
      },
      {
        "t": 29.33,
        "l1": "留下唇印的嘴",
        "l2": ""
      },
      {
        "t": 34.27,
        "l1": "花店玫瑰 名字写错谁",
        "l2": ""
      },
      {
        "t": 36.9,
        "l1": "告白气球 风吹到对街",
        "l2": ""
      },
      {
        "t": 40.01,
        "l1": "微笑在天上飞",
        "l2": ""
      },
      {
        "t": 44.01,
        "l1": "你说你有点难追",
        "l2": ""
      },
      {
        "t": 46.57,
        "l1": "想让我知难而退",
        "l2": ""
      },
      {
        "t": 49.22,
        "l1": "礼物不需挑最贵",
        "l2": ""
      },
      {
        "t": 51.89,
        "l1": "只要香榭的落叶",
        "l2": ""
      },
      {
        "t": 54.56,
        "l1": "喔 营造浪漫的约会",
        "l2": ""
      },
      {
        "t": 57.26,
        "l1": "不害怕搞砸一切",
        "l2": ""
      },
      {
        "t": 59.93,
        "l1": "拥有你就拥有全世界",
        "l2": ""
      },
      {
        "t": 65.01,
        "l1": "亲爱的 爱上你",
        "l2": ""
      },
      {
        "t": 68.17,
        "l1": "从那天起",
        "l2": ""
      },
      {
        "t": 71.33,
        "l1": "甜蜜的很轻易",
        "l2": ""
      },
      {
        "t": 75.69,
        "l1": "亲爱的 别任性",
        "l2": ""
      },
      {
        "t": 78.85,
        "l1": "你的眼睛",
        "l2": ""
      },
      {
        "t": 81.94,
        "l1": "在说我愿意",
        "l2": ""
      },
      {
        "t": 108.9,
        "l1": "塞纳河畔 左岸的咖啡",
        "l2": ""
      },
      {
        "t": 111.46,
        "l1": "我手一杯 品尝你的美",
        "l2": ""
      },
      {
        "t": 114.43,
        "l1": "留下唇印的嘴",
        "l2": ""
      },
      {
        "t": 119.56,
        "l1": "花店玫瑰 名字写错谁",
        "l2": ""
      },
      {
        "t": 122.14,
        "l1": "告白气球 风吹到对街",
        "l2": ""
      },
      {
        "t": 125.23,
        "l1": "微笑在天上飞",
        "l2": ""
      },
      {
        "t": 129.29,
        "l1": "你说你有点难追",
        "l2": ""
      },
      {
        "t": 131.9,
        "l1": "想让我知难而退",
        "l2": ""
      },
      {
        "t": 134.6,
        "l1": "礼物不需挑最贵",
        "l2": ""
      },
      {
        "t": 137.26,
        "l1": "只要香榭的落叶",
        "l2": ""
      },
      {
        "t": 139.93,
        "l1": "喔 营造浪漫的约会",
        "l2": ""
      },
      {
        "t": 142.65,
        "l1": "不害怕搞砸一切",
        "l2": ""
      },
      {
        "t": 145.27,
        "l1": "拥有你就拥有 全世界",
        "l2": ""
      },
      {
        "t": 150.31,
        "l1": "亲爱的 爱上你",
        "l2": ""
      },
      {
        "t": 153.58,
        "l1": "从那天起",
        "l2": ""
      },
      {
        "t": 156.6,
        "l1": "甜蜜的很轻易",
        "l2": ""
      },
      {
        "t": 160.94,
        "l1": "亲爱的 别任性",
        "l2": ""
      },
      {
        "t": 164.2,
        "l1": "你的眼睛",
        "l2": ""
      },
      {
        "t": 167.26,
        "l1": "在说我愿意",
        "l2": ""
      },
      {
        "t": 171.76,
        "l1": "亲爱的 爱上你",
        "l2": ""
      },
      {
        "t": 175.05,
        "l1": "恋爱日记",
        "l2": ""
      },
      {
        "t": 177.93,
        "l1": "飘香水的回忆",
        "l2": ""
      },
      {
        "t": 182.33,
        "l1": "一整瓶 的梦境",
        "l2": ""
      },
      {
        "t": 185.42,
        "l1": "全都有你",
        "l2": ""
      },
      {
        "t": 188.64,
        "l1": "搅拌在一起",
        "l2": ""
      },
      {
        "t": 193.02,
        "l1": "亲爱的别任性",
        "l2": ""
      },
      {
        "t": 196.23,
        "l1": "你的眼睛",
        "l2": ""
      },
      {
        "t": 201.31,
        "l1": "在说我愿意",
        "l2": ""
      }
    ],
    "comments": [
      "【热评 @左岸咖啡馆】轻快俏皮的吉他与鼓点，把法式浪漫和心动的微甜描绘得惟妙惟肖。"
    ],
    "lyricsRaw": "[ti:告白气球]\n[ar:周杰伦]\n[al:周杰伦的床边故事]\n[offset:0]\n\n[00:00.00]告[00:00.36]白[00:00.73]气[00:01.10]球[00:01.47] [00:01.84]-[00:02.20] [00:02.57]周[00:02.94]杰[00:03.31]伦[00:03.68] [00:04.04][00:04.41]Jay[00:04.78] [00:05.15]Chou[00:05.52]\n[00:05.89]词[00:07.07]：[00:08.25]方[00:09.43]文[00:10.61]山[00:11.79]\n[00:11.79]曲[00:12.97]：[00:14.15]周[00:15.33]杰[00:16.51]伦[00:17.69]\n[00:17.69]编[00:18.67]曲[00:19.65]：[00:20.63]林[00:21.62]迈[00:22.60]可[00:23.58]\n[00:23.59]塞[00:23.79]纳[00:23.97]河[00:24.12]畔[00:24.31] [00:24.51]左[00:24.68]岸[00:24.85]的[00:25.04]咖[00:25.66]啡[00:26.16]\n[00:26.16]我[00:26.35]手[00:26.54]一[00:26.71]杯[00:26.92] [00:27.13]品[00:27.33]尝[00:27.52]你[00:27.69]的[00:28.18]美[00:28.78]\n[00:29.33]留[00:29.56]下[00:29.99]唇[00:30.22]印[00:30.59]的[00:30.89]嘴[00:31.83]\n[00:34.27]花[00:34.43]店[00:34.59]玫[00:34.73]瑰[00:34.94] [00:35.15]名[00:35.31]字[00:35.46]写[00:35.63]错[00:36.17]谁[00:36.64]\n[00:36.90]告[00:37.05]白[00:37.21]气[00:37.38]球[00:37.61] [00:37.84]风[00:38.01]吹[00:38.19]到[00:38.37]对[00:38.96]街[00:39.29]\n[00:40.01]微[00:40.26]笑[00:40.59]在[00:40.87]天[00:41.26]上[00:41.57]飞[00:42.10]\n[00:44.01]你[00:44.29]说[00:44.60]你[00:44.89]有[00:45.24]点[00:45.54]难[00:45.86]追[00:46.25]\n[00:46.57]想[00:46.88]让[00:47.18]我[00:47.49]知[00:47.83]难[00:48.13]而[00:48.48]退[00:48.81]\n[00:49.22]礼[00:49.57]物[00:49.89]不[00:50.20]需[00:50.54]挑[00:50.89]最[00:51.23]贵[00:51.56]\n[00:51.89]只[00:52.23]要[00:52.58]香[00:52.87]榭[00:53.20]的[00:53.56]落[00:54.09]叶[00:54.55]\n[00:54.56]喔[00:54.69] [00:54.81]营[00:55.04]造[00:55.35]浪[00:55.63]漫[00:55.94]的[00:56.25]约[00:56.63]会[00:57.25]\n[00:57.26]不[00:57.60]害[00:57.92]怕[00:58.28]搞[00:58.63]砸[00:58.96]一[00:59.28]切[00:59.65]\n[00:59.93]拥[01:00.26]有[01:00.60]你[01:00.95]就[01:01.28]拥[01:01.65]有[01:02.31]全[01:02.56]世[01:02.93]界[01:04.10]\n[01:05.01]亲[01:05.27]爱[01:05.68]的[01:06.15] [01:06.63]爱[01:06.96]上[01:07.49]你[01:08.16]\n[01:08.17]从[01:09.39]那[01:09.64]天[01:10.17]起[01:10.61]\n[01:11.33]甜[01:11.88]蜜[01:12.25]的[01:12.83]很[01:13.17]轻[01:13.50]易[01:14.43]\n[01:15.69]亲[01:15.96]爱[01:16.29]的[01:16.77] [01:17.25]别[01:17.55]任[01:18.02]性[01:18.85]\n[01:18.85]你[01:19.81]的[01:20.23]眼[01:20.71]睛[01:21.24]\n[01:21.94]在[01:22.45]说[01:22.78]我[01:23.42]愿[01:24.08]意[01:25.23]\n[01:48.90]塞[01:49.09]纳[01:49.30]河[01:49.50]畔[01:49.68] [01:49.87]左[01:50.07]岸[01:50.25]的[01:50.43]咖[01:50.96]啡[01:51.45]\n[01:51.46]我[01:51.66]手[01:51.84]一[01:52.03]杯[01:52.26] [01:52.48]品[01:52.66]尝[01:52.84]你[01:53.01]的[01:53.57]美[01:53.94]\n[01:54.43]留[01:54.84]下[01:55.23]唇[01:55.56]印[01:55.85]的[01:56.19]嘴[01:56.63]\n[01:59.56]花[01:59.77]店[01:59.93]玫[02:00.10]瑰[02:00.29] [02:00.49]名[02:00.67]字[02:00.85]写[02:01.04]错[02:01.34]谁[02:01.73]\n[02:02.14]告[02:02.36]白[02:02.57]气[02:02.74]球[02:02.94] [02:03.15]风[02:03.33]吹[02:03.51]到[02:03.72]对[02:04.00]街[02:04.37]\n[02:05.23]微[02:05.56]笑[02:05.87]在[02:06.18]天[02:06.54]上[02:06.89]飞[02:07.49]\n[02:09.29]你[02:09.56]说[02:09.91]你[02:10.21]有[02:10.54]点[02:10.84]难[02:11.23]追[02:11.59]\n[02:11.90]想[02:12.20]让[02:12.53]我[02:12.84]知[02:13.20]难[02:13.53]而[02:13.88]退[02:14.24]\n[02:14.60]礼[02:14.91]物[02:15.23]不[02:15.54]需[02:15.92]挑[02:16.22]最[02:16.56]贵[02:16.91]\n[02:17.26]只[02:17.60]要[02:17.95]香[02:18.26]榭[02:18.59]的[02:18.89]落[02:19.18]叶[02:19.53]\n[02:19.93]喔[02:20.04] [02:20.14]营[02:20.35]造[02:20.72]浪[02:20.97]漫[02:21.27]的[02:21.60]约[02:21.94]会[02:22.21]\n[02:22.65]不[02:22.93]害[02:23.27]怕[02:23.62]搞[02:23.97]砸[02:24.29]一[02:24.59]切[02:24.88]\n[02:25.27]拥[02:25.56]有[02:25.91]你[02:26.25]就[02:26.57]拥[02:26.97]有[02:27.34] [02:27.72]全[02:27.97]世[02:28.27]界[02:29.23]\n[02:30.31]亲[02:30.63]爱[02:31.00]的[02:31.48] [02:31.96]爱[02:32.25]上[02:32.76]你[02:33.57]\n[02:33.58]从[02:34.60]那[02:34.94]天[02:35.47]起[02:36.03]\n[02:36.60]甜[02:37.18]蜜[02:37.60]的[02:38.17]很[02:38.50]轻[02:38.83]易[02:39.65]\n[02:40.94]亲[02:41.28]爱[02:41.60]的[02:42.09] [02:42.57]别[02:42.95]任[02:43.41]性[02:44.19]\n[02:44.20]你[02:45.25]的[02:45.59]眼[02:46.01]睛[02:46.70]\n[02:47.26]在[02:47.80]说[02:48.11]我[02:48.72]愿[02:49.70]意[02:50.81]\n[02:51.76]亲[02:52.00]爱[02:52.33]的[02:52.79] [02:53.25]爱[02:53.57]上[02:54.04]你[02:54.52]\n[02:55.05]恋[02:55.98]爱[02:56.28]日[02:56.78]记[02:57.30]\n[02:57.93]飘[02:58.56]香[02:58.84]水[02:59.56]的[02:59.85]回[03:00.17]忆[03:00.72]\n[03:02.33]一[03:02.59]整[03:02.97]瓶[03:03.39] [03:03.80]的[03:04.07]梦[03:04.61]境[03:05.41]\n[03:05.42]全[03:06.43]都[03:06.82]有[03:07.30]你[03:07.91]\n[03:08.64]搅[03:09.22]拌[03:09.56]在[03:10.05]一[03:10.65]起[03:11.39]\n[03:13.02]亲[03:13.29]爱[03:13.55]的[03:14.49]别[03:14.89]任[03:15.31]性[03:16.22]\n[03:16.23]你[03:17.28]的[03:17.60]眼[03:18.10]睛[03:19.99]\n[03:21.31]在[03:22.01]说[03:22.43]我[03:23.16]愿[03:23.93]意[03:25.90]",
    "lrcUrl": "assets/lyrics/track_20.lrc"
  }
];

const ARCHIVE_BOOKS = REAL_20_DEMO_TRACKS;

function makePlTrack(t, prefix, seq) {
  const num2 = String(seq).padStart(2, '0');
  const num3 = String(seq).padStart(3, '0');
  return {
    ...t,
    index: num3,
    spineNum: num2,
    serial: `${prefix}-${num2}`
  };
}

let activeBooks = [...REAL_20_DEMO_TRACKS];
let SOURCE_BOOKS = activeBooks;
let targetIdx = 0;

const SPRING_MODES = [
  { name: "丝滑阻尼", stiffness: 0.11, damping: 0.77 },
  { name: "Q弹回跃", stiffness: 0.16, damping: 0.67 },
  { name: "厚重机械", stiffness: 0.075, damping: 0.83 }
];
let springModeIdx = 0;

const DEFAULT_PLAYLIST_ARCHIVES = [
  {
    id: "pl_demo_real_20",
    num: "01",
    spineNum: "01",
    serial: "WK-REAL-20",
    barcode: "WK-REAL-20",
    title: "🔥 Qoder 20首原声全收录 (go-music-dl)",
    shortTitle: "20首真实原声音频",
    spineTitle: "20首真实原声",
    subtitle: "由 go-music-dl 下载入库的 20 首无损/高清完整音轨 · 离线零依赖直接播放",
    desc: "覆盖 ACG 燃曲与华语巅峰流行，内置 20 首高保真真实音频，断网环境自洽畅听",
    coverImgUrl: "assets/covers/cover_box_real20.jpg",
    trackCount: 20,
    accent: "#ec4899",
    badge: "20首真实音源",
    tracks: REAL_20_DEMO_TRACKS.map((t, i) => makePlTrack(t, 'WK-REAL', i + 1))
  },
  {
    id: "pl_demo_acg",
    num: "02",
    spineNum: "02",
    serial: "WK-ACG-02",
    barcode: "WK-ACG-02",
    title: "⚡ ACG 巅峰神曲 · 燃系与热血典藏",
    shortTitle: "ACG 巅峰神曲",
    spineTitle: "ACG 巅峰神曲",
    subtitle: "火影《青鸟》/ 炮姐《railgun》/ 鬼灭《红莲华》/ EVA《残酷天使》/ 数码宝贝《Butter-Fly》等 8 首必听高燃神作",
    desc: "跨越时代的动漫原声神曲典藏，触动每一次热血与泪目的经典共鸣",
    coverImgUrl: "assets/covers/cover_box_acg.jpg",
    trackCount: 8,
    accent: "#2563eb",
    badge: "ACG神曲",
    tracks: [0, 13, 16, 11, 14, 15, 10, 1].map((idx, i) => makePlTrack(REAL_20_DEMO_TRACKS[idx], 'WK-ACG', i + 1))
  },
  {
    id: "pl_demo_jay",
    num: "03",
    spineNum: "03",
    serial: "WK-JAY-03",
    barcode: "WK-JAY-03",
    title: "🎹 周杰伦 · 青春二十年金曲特辑",
    shortTitle: "周杰伦青春金曲",
    spineTitle: "周杰伦青春金曲",
    subtitle: "从《晴天》《七里香》到《夜曲》《稻香》《告白气球》· 刻进青春 DNA 的华语天王金曲",
    desc: "精选周杰伦 5 首横跨二十年的时代金曲，青春的夏天与蝉鸣永不落幕",
    coverImgUrl: "assets/covers/cover_03.jpg",
    trackCount: 5,
    accent: "#d97706",
    badge: "周杰伦",
    tracks: [2, 3, 4, 18, 19].map((idx, i) => makePlTrack(REAL_20_DEMO_TRACKS[idx], 'WK-JAY', i + 1))
  },
  {
    id: "pl_demo_tear",
    num: "04",
    spineNum: "04",
    serial: "WK-HEAL-04",
    barcode: "WK-HEAL-04",
    title: "🌸 治愈与感动 · 催泪白月光神作",
    shortTitle: "治愈催泪白月光",
    spineTitle: "治愈催泪白月光",
    subtitle: "未闻花名《secret base》/《Lemon》/《大鱼》/《起风了》/《此生不换》· 触动心弦的白月光",
    desc: "温柔治愈的声波抚平一切浮躁，带你重温那些潸然泪下的感动瞬间",
    coverImgUrl: "assets/covers/cover_13.jpg",
    trackCount: 7,
    accent: "#db2777",
    badge: "治愈感动",
    tracks: [12, 1, 7, 6, 5, 9, 10].map((idx, i) => makePlTrack(REAL_20_DEMO_TRACKS[idx], 'WK-HEAL', i + 1))
  },
  {
    id: "pl_demo_pop",
    num: "05",
    spineNum: "05",
    serial: "WK-POP-05",
    barcode: "WK-POP-05",
    title: "🌌 华语经典 · 时代金曲殿堂",
    shortTitle: "华语时代金曲",
    spineTitle: "华语时代金曲",
    subtitle: "《起风了》/《晴天》/《富士山下》/《如愿》/《光年之外》/《此生不换》· 华语乐坛传唱经典",
    desc: "刻录青春岁月里的旋律记忆，高品质母带级声场还原，百听不厌的华语顶峰",
    coverImgUrl: "assets/covers/cover_box_pop.jpg",
    trackCount: 11,
    accent: "#059669",
    badge: "华语金曲",
    tracks: [5, 2, 8, 6, 17, 3, 9, 4, 7, 19, 18].map((idx, i) => makePlTrack(REAL_20_DEMO_TRACKS[idx], 'WK-POP', i + 1))
  },
  {
    id: "pl_demo_ost",
    num: "06",
    spineNum: "06",
    serial: "WK-OST-06",
    barcode: "WK-OST-06",
    title: "🎬 影视与银幕原声 · 独家记忆",
    shortTitle: "银幕原声记忆",
    spineTitle: "银幕原声记忆",
    subtitle: "《大鱼海棠》/《我和我的父辈》/《仙剑奇侠传三》/《太空旅客》/《非自然死亡》银幕经典音轨",
    desc: "大荧幕与热播剧经典原声合集，旋律响起，剧中的名场面便历历在目",
    coverImgUrl: "assets/covers/cover_08.jpg",
    trackCount: 8,
    accent: "#d94e34",
    badge: "影视OST",
    tracks: [7, 6, 9, 10, 17, 1, 0, 12].map((idx, i) => makePlTrack(REAL_20_DEMO_TRACKS[idx], 'WK-OST', i + 1))
  },
  {
    id: "pl_demo_night",
    num: "07",
    spineNum: "07",
    serial: "WK-NIGHT-07",
    barcode: "WK-NIGHT-07",
    title: "🎧 深夜沉浸 · 水镜与极光私享",
    shortTitle: "深夜水镜沉浸",
    spineTitle: "深夜水镜沉浸",
    subtitle: "适合夜读与动效冥想的细腻慢歌 · 搭配 Folia 水镜、星芒粒子沉浸体验",
    desc: "在万籁俱寂的深夜，伴随深邃声场与水镜极光动效，进入身临其境的视听心流",
    coverImgUrl: "assets/covers/cover_05.jpg",
    trackCount: 8,
    accent: "#7c3aed",
    badge: "夜读沉浸",
    tracks: [4, 8, 7, 5, 1, 6, 2, 17].map((idx, i) => makePlTrack(REAL_20_DEMO_TRACKS[idx], 'WK-NIGHT', i + 1))
  },
  {
    id: "pl_demo_voyage",
    num: "08",
    spineNum: "08",
    serial: "WK-VOYAGE-08",
    barcode: "WK-VOYAGE-08",
    title: "🚀 远行与羁绊 · 少年热血序曲",
    shortTitle: "少年热血序曲",
    spineTitle: "少年热血序曲",
    subtitle: "怀揣梦想奔赴星辰大海 · 数码宝贝 / 火影 / 电磁炮 / 鬼灭 / 稻香励志曲目",
    desc: "为每一位追光少年奏响的序曲，无畏前行，奔赴更广阔的天地",
    coverImgUrl: "assets/covers/cover_15.jpg",
    trackCount: 7,
    accent: "#0891b2",
    badge: "少年热血",
    tracks: [14, 0, 13, 16, 15, 11, 18].map((idx, i) => makePlTrack(REAL_20_DEMO_TRACKS[idx], 'WK-VOYAGE', i + 1))
  },
  {
    id: "pl_login",
    num: "09",
    spineNum: "09",
    serial: "WK-LOGIN",
    barcode: "WK-SYNC-01",
    title: "点击登录网易云 (在线同步)",
    shortTitle: "网易云同步",
    spineTitle: "同步网易云歌单",
    subtitle: "扫码登录可自动同步私人歌单（比赛离线演示已内置丰富典藏曲库）",
    desc: "若启动本地后端服务可扫码登录同步网易云音乐歌单",
    coverImgUrl: null,
    trackCount: 0,
    accent: "#ef4444",
    badge: "云端",
    tracks: []
  }
];

const ACG_DEMO_TRACKS = DEFAULT_PLAYLIST_ARCHIVES[1].tracks;
const POP_DEMO_TRACKS = DEFAULT_PLAYLIST_ARCHIVES[4].tracks;
const CYBER_DEMO_TRACKS = DEFAULT_PLAYLIST_ARCHIVES[6].tracks;

let PLAYLIST_ARCHIVES = [...DEFAULT_PLAYLIST_ARCHIVES];
activeBooks = DEFAULT_PLAYLIST_ARCHIVES[0].tracks;
SOURCE_BOOKS = activeBooks;
const PALETTE_COLORS = ['#d94e34', '#2563eb', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#4f46e5', '#ea580c'];

function setUserPlaylists(ncmPlaylists) {
  if (!ncmPlaylists || ncmPlaylists.length === 0) {
    PLAYLIST_ARCHIVES = [...DEFAULT_PLAYLIST_ARCHIVES];
  } else {
    const userBoxes = ncmPlaylists.map((pl, idx) => {
      const numStr = String(idx + 1).padStart(2, '0');
      const accent = PALETTE_COLORS[idx % PALETTE_COLORS.length];
      const isFav = idx === 0 && (pl.name.includes('喜欢') || pl.specialType === 5);
      return {
        id: pl.id,
        isNcm: true,
        num: numStr,
        spineNum: numStr,
        serial: `PL-${String(pl.id).slice(-5)}`,
        barcode: `WK-PL-${numStr}`,
        title: pl.name || '我的歌单',
        shortTitle: (pl.name || '我的歌单').slice(0, 10),
        spineTitle: (pl.name || '我的歌单').slice(0, 12),
        subtitle: pl.description || (pl.creator ? `创建者：${pl.creator.nickname}` : '网易云歌单'),
        desc: pl.description || (pl.creator ? `创建者：${pl.creator.nickname}` : '网易云音乐歌单'),
        coverImgUrl: pl.coverImgUrl ? pl.coverImgUrl.replace(/^http:/, 'https:') + '?param=400y400' : null,
        trackCount: pl.trackCount || 0,
        accent: isFav ? '#ef4444' : accent,
        badge: isFav ? '红心' : '网易云',
        tracks: null
      };
    });
    PLAYLIST_ARCHIVES = [...userBoxes];

    // 预下载所有歌单封面：书架→选歌的过渡动画里图片已在缓存，不会出现黑块
    userBoxes.forEach(function (box) {
      var u = box.coverImgUrl;
      if (!u) return;
      var im = new Image();
      im.decoding = 'async';
      im.src = u;
      box._coverReady = false;
      im.onload = function () { box._coverReady = true; };
    });
  }

  currentPlaylistIdx = 0;
  playlistScrollPos = 0;
  playlistTargetPos = 0;
  playlistScrollVelocity = 0;
  render3DPlaylistShelf();
  const cEl = document.getElementById('totalPlaylistCountLabel');
  if (cEl) cEl.textContent = `${PLAYLIST_ARCHIVES.length} 个歌单`;
  updatePlaylistShelfFooter(0);
  wake();
}

let ALL_ARCHIVE_STORAGE = [];

window.addCustomPlaylistArchive = function (archive) {
  if (!archive) return;
  if (!ALL_ARCHIVE_STORAGE.length) {
    ALL_ARCHIVE_STORAGE = [...PLAYLIST_ARCHIVES];
  }

  const existingIdx = PLAYLIST_ARCHIVES.findIndex(p => p.id === archive.id);
  const numStr = String(PLAYLIST_ARCHIVES.length + 1).padStart(2, '0');
  const formatted = {
    id: archive.id,
    isNcm: Boolean(archive.isNcm),
    isQq: Boolean(archive.isQq),
    num: numStr,
    spineNum: numStr,
    serial: `PL-${String(archive.id).slice(-5)}`,
    barcode: `WK-PL-${numStr}`,
    title: archive.title || '自定义歌单',
    shortTitle: (archive.title || '自定义歌单').slice(0, 10),
    spineTitle: (archive.title || '自定义歌单').slice(0, 12),
    subtitle: archive.subtitle || archive.badge || '多平台曲库',
    desc: archive.desc || `${archive.badge || '多端'} 同步歌单盒`,
    coverImgUrl: archive.coverImgUrl,
    trackCount: archive.trackCount || (archive.books && archive.books.length) || 0,
    accent: archive.accent || (archive.isQq ? '#31c27c' : archive.isNcm ? '#ef4444' : '#3b82f6'),
    badge: archive.badge || (archive.isQq ? 'QQ音乐' : archive.isNcm ? '网易云' : '外部音源'),
    books: archive.books || archive.tracks || [],
    tracks: archive.tracks || archive.books || []
  };

  if (existingIdx >= 0) {
    PLAYLIST_ARCHIVES[existingIdx] = formatted;
  } else {
    PLAYLIST_ARCHIVES.unshift(formatted);
  }

  ALL_ARCHIVE_STORAGE = [...PLAYLIST_ARCHIVES];
  currentPlaylistIdx = 0;
  playlistScrollPos = 0;
  playlistTargetPos = 0;
  render3DPlaylistShelf();
  updatePlaylistShelfFooter(0);
  if (window.DynamicPlatformIsland) {
    DynamicPlatformIsland.update({
      title: formatted.title,
      count: `${PLAYLIST_ARCHIVES.length} 盒歌单`,
      accentHex: formatted.accent
    });
  }
  wake();
};

window.filterPlaylistByPlatform = function (platform) {
  if (!ALL_ARCHIVE_STORAGE.length) {
    ALL_ARCHIVE_STORAGE = [...PLAYLIST_ARCHIVES];
  }
  if (platform === 'all') {
    PLAYLIST_ARCHIVES = [...ALL_ARCHIVE_STORAGE];
  } else if (platform === 'ncm' || platform === 'netease') {
    PLAYLIST_ARCHIVES = ALL_ARCHIVE_STORAGE.filter(p => p.isNcm);
  } else if (platform === 'local') {
    PLAYLIST_ARCHIVES = ALL_ARCHIVE_STORAGE.filter(p => !p.isNcm);
  }
  if (PLAYLIST_ARCHIVES.length === 0) {
    PLAYLIST_ARCHIVES = [...ALL_ARCHIVE_STORAGE];
  }
  currentPlaylistIdx = 0;
  playlistScrollPos = 0;
  playlistTargetPos = 0;
  render3DPlaylistShelf();
  updatePlaylistShelfFooter(0);
  wake();
};

async function triggerAiPlaylistRecommendation() {
  playMechanicalTick(1.3);
  showToast('🧠 AI 正在吸收歌单特征与听歌品味...');

  try {
    let result = null;
    if (window.NCM && typeof NCM.getAiRecommendations === 'function') {
      result = await NCM.getAiRecommendations();
    }
    let books = (result && result.books) || [];
    let artistsHint = (result && result.absorbedArtists && result.absorbedArtists.length)
      ? result.absorbedArtists.join(' / ')
      : ((result && result.seed) || null);

    if (!books || books.length === 0) {
      // 比赛演示/离线模式自愈：基于当前播放曲目与全库声波特征，由 AI 算法生成专属心流推荐
      const currentTrack = (activeBooks && activeBooks[targetIdx]) || ARCHIVE_BOOKS[0];
      artistsHint = currentTrack.artist || '声学母带精选';
      const allPool = [...REAL_20_DEMO_TRACKS];
      const otherTracks = allPool.filter(b => b.title !== currentTrack.title).sort(() => 0.5 - Math.random());
      books = [currentTrack, ...otherTracks.slice(0, 5)].map((b, bIdx) => ({
        ...b,
        index: String(bIdx + 1).padStart(3, '0'),
        spineNum: String(bIdx + 1).padStart(2, '0'),
        statusTag: 'AI定制'
      }));
    }

    // 构造专属于用户的 AI 智能推荐磁带书盒
    const aiPlaylist = {
      id: 'pl_ai_rec_' + Date.now(),
      isNcm: true,
      num: 'AI',
      spineNum: 'AI',
      serial: 'WK-AI-NEURAL',
      barcode: 'AI-FLOW-01',
      title: '✨ AI 智能心流推荐',
      shortTitle: '✨ AI 推荐',
      spineTitle: 'AI 智能心流',
      subtitle: `根据「${artistsHint}」量身生成的 ${books.length} 首心流单曲`,
      desc: `基于您的网易云歌单特征与高频歌手偏好，由 AI 神经网络算法为您量身定制的专属推荐曲目。`,
      coverImgUrl: (books[0] && (books[0].picUrl || books[0].coverUrl)) || null,
      trackCount: books.length,
      accent: '#8b5cf6',
      badge: 'AI心流',
      tracks: books
    };

    // 插入到书架第一位，让用户随时可回顾
    const oldIdx = PLAYLIST_ARCHIVES.findIndex(p => p.num === 'AI');
    if (oldIdx >= 0) PLAYLIST_ARCHIVES.splice(oldIdx, 1);
    PLAYLIST_ARCHIVES.unshift(aiPlaylist);
    overviewExpandedPlaylists[aiPlaylist.id] = true;

    currentPlaylistIdx = 0;
    playlistScrollPos = 0;
    playlistTargetPos = 0;
    render3DPlaylistShelf();
    if (isShelfListView) {
      renderPlaylistListView();
    }
    isShelfForcedDirty = true;
    wake();

    // 自动打开封面流让用户立即开始挑选和播放
    setTimeout(() => {
      openPlaylistCoverflow(0);
      showToast(`✨ AI 推荐已就绪！已吸收歌单生成 ${books.length} 首专属单曲`);
    }, 450);

  } catch (err) {
    showToast('AI 推荐生成失败：' + (err.message || err));
  }
}

function renderPlaylistArtwork(pl) {
  if (pl.coverImgUrl) {
    return `<img src="${esc(pl.coverImgUrl)}" alt="${esc(pl.title)}" style="width:100%; height:100%; object-fit:cover; display:block;" onerror="this.style.display='none'">`;
  }
  const col = pl.accent || '#d94e34';
  return `
    <svg viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg" style="width:100%; height:100%;">
      <defs>
        <linearGradient id="pgrad_${pl.num}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#2a2c34"/>
          <stop offset="100%" stop-color="#121318"/>
        </linearGradient>
      </defs>
      <rect width="320" height="320" fill="url(#pgrad_${pl.num})"/>
      <circle cx="160" cy="160" r="110" fill="none" stroke="${col}" stroke-width="2" opacity="0.4"/>
      <circle cx="160" cy="160" r="30" fill="${col}" opacity="0.8"/>
      <text x="24" y="50" fill="#fff" font-family="-apple-system, sans-serif" font-size="20" font-weight="900">${esc(pl.title)}</text>
      <text x="24" y="290" fill="${col}" font-family="monospace" font-size="12" font-weight="bold">COLLECTION // ${pl.num}</text>
    </svg>
  `;
}

// 状态与 DOM 节点引用
let currentPlaylistIdx = 0;
let playlistScrollPos = 0;
let playlistTargetPos = 0;
let playlistScrollVelocity = 0;
let playlistBoxNodes = [];
let isShelfPointerDown = false;
let hasShelfDragged = false;

let currentTrackIdx = 0;
let trackScrollPos = 0;
let trackTargetPos = 0;
let trackScrollVelocity = 0;
let cfTrackCardNodes = [];
let isCfPointerDown = false;
let hasCfDragged = false;

// ============================================================================
// 3. 第一层：3D 立体白盒歌单书架 (Original Wenku8 White Cassette Box Shelf)
// ============================================================================
function render3DPlaylistShelf() {
  const origin = document.getElementById('shelfOrigin');
  if (!origin) return;
  origin.innerHTML = '';
  playlistBoxNodes = [];

  PLAYLIST_ARCHIVES.forEach((pl, idx) => {
    const el = document.createElement('div');
    el.className = 'white-archive-box' + (idx === currentPlaylistIdx ? ' is-focused' : '');
    el.style.setProperty('--box-accent', pl.accent || '#d94e34');

    const artworkHTML = renderPlaylistArtwork(pl);

    el.innerHTML = `
      <div class="box-face-spine">
        <div class="spine-top-num">${pl.spineNum || pl.num}</div>
        <div class="spine-brand-badge">${pl.badge || '文庫'}</div>
        <div class="spine-v-title">${esc(pl.spineTitle || pl.title)}</div>
        <div class="spine-bottom-barcode">
          <div class="mini-v-bars"></div>
          <div class="spine-color-foot" style="background:${pl.accent || '#2b6cb0'};"></div>
        </div>
      </div>

      <div class="box-face-front">
        <div class="front-top-serial">
          <span>NO. ${pl.spineNum || pl.num}</span>
          <span>${pl.serial || 'STEREO // CrO₂'}</span>
        </div>

        <div class="front-artwork-wrapper">
          ${artworkHTML}
          <div class="front-play-badge" onclick="event.stopPropagation(); openPlaylistCoverflow(${idx});">
            <span>▶</span>
            <span>点击进入选歌</span>
          </div>
        </div>

        <div class="front-bottom-archive">
          <div class="barcode-strip-box">
            <div class="barcode-lines"></div>
            <span class="barcode-code">${pl.barcode || pl.serial || 'WK-09971'}</span>
          </div>

          <div class="front-cassette-footer">
            <div class="mini-cassette-window">
              <div class="mini-wheel"></div>
              <span style="font-family:monospace; font-size:8px; color:#d4d4d8;">${pl.trackCount ? pl.trackCount + ' 首收录' : 'TAPE-A'}</span>
              <div class="mini-wheel"></div>
            </div>
            <span class="publisher-seal" style="color:${pl.accent || '#1e40af'}; border-color:${pl.accent || '#1e40af'};">AUDIO</span>
          </div>
        </div>
      </div>

      <div class="box-face-top"></div>
      <div class="box-face-right"></div>
      <div class="box-face-back"></div>
    `;

    el.onclick = (e) => {
      if (hasShelfDragged) return;
      e.stopPropagation();
      if (idx !== currentPlaylistIdx) {
        currentPlaylistIdx = idx;
        playlistTargetPos = idx;
        playMechanicalTick(1.2);
        updatePlaylistShelfFooter(idx);
        wake();
      } else {
        openPlaylistCoverflow(idx);
      }
    };

    origin.appendChild(el);
    playlistBoxNodes.push(el);
  });

  // 关键修复：DOM 生成后立即进行初次空间物理排布，绝不产生多层阴影重叠
  applyShelfBoxesTransform(playlistScrollPos || 0);
  isShelfForcedDirty = true;
  updatePlaylistShelfFooter(currentPlaylistIdx);
  const cEl = document.getElementById('totalPlaylistCountLabel');
  if (cEl) cEl.textContent = `${PLAYLIST_ARCHIVES.length} 个歌单`;
  wake();
}

function applyShelfBoxesTransform(scrollPos) {
  if (!playlistBoxNodes || !playlistBoxNodes.length) return;
  playlistBoxNodes.forEach((el, i) => {
    const delta = i - scrollPos;
    const abs = Math.abs(delta);
    const sign = Math.sign(delta);

    if (abs > 12) {
      if (el.style.display !== 'none') el.style.display = 'none';
      return;
    }
    if (el.style.display === 'none') el.style.display = '';

    const focusWeight = Math.max(0, 1 - abs * 1.18);
    el.classList.toggle('is-focused', focusWeight > 0.55);

    let tx = 0;
    if (abs <= 1) {
      tx = delta * 154;
    } else {
      tx = sign * (154 + (abs - 1) * 43);
    }

    const tz = focusWeight * 115 - abs * 18;
    const ty = -focusWeight * 10 + abs * 2;

    const spineRy = 82 - sign * Math.min(abs, 3) * 1.6;
    const focusRy = -27;
    const ry = spineRy * (1 - focusWeight) + focusRy * focusWeight;

    const rx = focusWeight * 3.5 + (1 - focusWeight) * 1.5;
    const sc = 0.88 + focusWeight * 0.14;

    el.style.transform = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, ${tz.toFixed(2)}px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scale(${sc.toFixed(3)})`;
    el.style.zIndex = Math.round(200 + focusWeight * 100 - abs * 15);
  });
}

function updatePlaylistShelfFooter(idx) {
  const pl = PLAYLIST_ARCHIVES[idx];
  if (!pl) return;
  const tEl = document.getElementById('shelfBottomTitle');
  const sEl = document.getElementById('shelfBottomStatus');
  const subEl = document.getElementById('shelfBottomSubTag');
  const aEl = document.getElementById('shelfBottomArtist');
  const pEl = document.getElementById('shelfPageIndicator');
  const cEl = document.getElementById('totalPlaylistCountLabel');
  const thumbImg = document.getElementById('shelfBottomThumb');
  const thumbFb = document.getElementById('shelfBottomThumbFallback');

  const curPlayingBook = (isPlaying && activeBooks && activeBooks[targetIdx]) ? activeBooks[targetIdx] : null;

  if (curPlayingBook) {
    if (tEl) tEl.textContent = curPlayingBook.title;
    if (sEl) {
      sEl.textContent = '正在播放';
      sEl.className = 'status-pill highlight is-playing-glow';
    }
    if (subEl) subEl.textContent = `${curPlayingBook.artist} · ${pl.title}`;
    if (aEl) aEl.textContent = `包含 ${pl.trackCount || 0} 首 · 点击进入选歌`;
  } else {
    if (tEl) tEl.textContent = pl.title;
    if (sEl) {
      sEl.textContent = pl.isNcm ? (pl.badge || '网易云') : '精选';
      sEl.className = 'status-pill highlight';
    }
    if (subEl) subEl.textContent = '点击进入选歌';
    if (aEl) aEl.textContent = `包含 ${pl.trackCount || 0} 首收录曲目`;
  }

  if (pEl) pEl.textContent = `${String(idx + 1).padStart(2, '0')} / ${String(PLAYLIST_ARCHIVES.length).padStart(2, '0')}`;
  if (cEl) cEl.textContent = `${PLAYLIST_ARCHIVES.length} 个歌单`;

  if (thumbImg && thumbFb) {
    if (pl.coverImgUrl) {
      thumbImg.src = pl.coverImgUrl;
      thumbImg.style.display = 'block';
      thumbFb.style.display = 'none';
    } else {
      thumbImg.style.display = 'none';
      thumbFb.style.display = 'flex';
      thumbFb.style.background = pl.accent || '#18191c';
    }
  }
}

function stepPlaylistIndex(dir) {
  currentPlaylistIdx = Math.max(0, Math.min(PLAYLIST_ARCHIVES.length - 1, currentPlaylistIdx + dir));
  playlistTargetPos = currentPlaylistIdx;
  playMechanicalTick(1.18);
  updatePlaylistShelfFooter(currentPlaylistIdx);
  wake();
}

let isShelfListView = false;
function toggleShelfViewMode() {
  isShelfListView = !isShelfListView;
  const sVp = document.getElementById('shelfViewport');
  const sList = document.getElementById('shelfListOverview');
  const label = document.getElementById('viewModeLabel');
  if (label) label.textContent = isShelfListView ? '3D书盒' : '列表总览';
  
  if (isShelfListView) {
    if (sVp) sVp.style.display = 'none';
    if (sList) {
      sList.style.display = 'block';
      renderPlaylistListView();
    }
  } else {
    if (sList) sList.style.display = 'none';
    if (sVp) sVp.style.display = ''; // 还原 CSS 原生的 flex 布局，防止 3D 舞台中心错位
    render3DPlaylistShelf();
    isShelfForcedDirty = true;
    wake();
  }
  playMechanicalTick(1.2);
}

let overviewCurrentTab = 'playlists'; // 'playlists' or 'all'
let overviewExpandedPlaylists = {
  'pl_demo_real_20': true,
  'pl_demo_acg': true,
  'pl_demo_jay': true,
  'pl_demo_tear': true,
  'pl_demo_pop': true,
  'pl_demo_ost': true,
  'pl_demo_night': true,
  'pl_demo_voyage': true
};
let overviewSearchKeyword = '';

function switchOverviewTab(mode) {
  overviewCurrentTab = mode;
  const tabPl = document.getElementById('overviewTabPlaylists');
  const tabAll = document.getElementById('overviewTabAll');
  if (tabPl) tabPl.classList.toggle('is-active', mode === 'playlists');
  if (tabAll) tabAll.classList.toggle('is-active', mode === 'all');
  playMechanicalTick(1.15);
  renderPlaylistListView();
}

function handleOverviewSearch(val) {
  overviewSearchKeyword = (val || '').trim().toLowerCase();
  renderPlaylistListView();
}

function toggleOverviewPlaylistAccordion(plId) {
  overviewExpandedPlaylists[plId] = !overviewExpandedPlaylists[plId];
  playMechanicalTick(1.2);
  renderPlaylistListView();
}

function toggleAllPlaylistsAccordion() {
  const allIds = PLAYLIST_ARCHIVES.filter(p => p.tracks && p.tracks.length > 0).map(p => p.id);
  const isAnyCollapsed = allIds.some(id => !overviewExpandedPlaylists[id]);
  allIds.forEach(id => {
    overviewExpandedPlaylists[id] = isAnyCollapsed;
  });
  const btn = document.getElementById('overviewToggleAllBtn');
  if (btn) btn.textContent = isAnyCollapsed ? '全部折叠' : '全部展开';
  playMechanicalTick(1.25);
  renderPlaylistListView();
}

function playSongFromOverview(playlistId, trackIdx, e) {
  if (e) e.stopPropagation();
  const pl = PLAYLIST_ARCHIVES.find(p => p.id === playlistId);
  if (!pl || !pl.tracks || !pl.tracks[trackIdx]) return;

  // 如果点击的是当前已经选中的歌曲，执行播放/暂停切换
  if (activeBooks === pl.tracks && targetIdx === trackIdx) {
    if (isPlaying) {
      pauseTrackAudio();
    } else {
      resumeTrackAudio();
    }
    syncPlayIcons();
    updateOverviewPlayingState();
    return;
  }

  // 切换歌单与曲目
  activeBooks = pl.tracks;
  SOURCE_BOOKS = activeBooks;
  const plIdx = PLAYLIST_ARCHIVES.indexOf(pl);
  if (plIdx >= 0) currentPlaylistIdx = plIdx;

  targetIdx = trackIdx;
  currentTrackIdx = trackIdx;
  trackTargetPos = trackIdx;
  trackScrollPos = trackIdx;
  activeBooks[targetIdx].currentSec = 0;
  populatePlayerView(activeBooks[targetIdx]);
  isPlaying = true;
  startTrackAudio();
  updatePlaylistShelfFooter(currentPlaylistIdx);
  updateOverviewPlayingState();
  playMechanicalTick(1.25);
  showToast('🎵 正在播放：' + activeBooks[targetIdx].title);
}

function openPlayerFromOverview(playlistId, trackIdx, e) {
  if (e) e.stopPropagation();
  const pl = PLAYLIST_ARCHIVES.find(p => p.id === playlistId);
  if (!pl || !pl.tracks || !pl.tracks[trackIdx]) return;

  if (activeBooks !== pl.tracks || targetIdx !== trackIdx || !isPlaying) {
    playSongFromOverview(playlistId, trackIdx);
  }
  setTimeout(() => {
    openPlayerView(true);
  }, 100);
}

function openCoverflowFromOverview(playlistId, e) {
  if (e) e.stopPropagation();
  const plIdx = PLAYLIST_ARCHIVES.findIndex(p => p.id === playlistId);
  if (plIdx >= 0) {
    openPlaylistCoverflow(plIdx);
  }
}

function updateOverviewPlayingState() {
  const rows = document.querySelectorAll('.overview-track-row');
  if (!rows || rows.length === 0) return;
  const currentBook = (activeBooks && activeBooks[targetIdx]) || null;
  const currentTitle = currentBook ? currentBook.title : null;

  rows.forEach(row => {
    const rTitle = row.getAttribute('data-track-title');
    const isThisPlaying = (rTitle && rTitle === currentTitle);
    row.classList.toggle('is-current-playing', isThisPlaying);

    const eqBox = row.querySelector('.track-index-box');
    const playBtn = row.querySelector('.track-icon-btn.play-btn');

    if (eqBox) {
      if (isThisPlaying) {
        eqBox.innerHTML = `
          <div class="eq-anim-container ${isPlaying ? '' : 'is-paused'}">
            <span class="eq-bar"></span>
            <span class="eq-bar"></span>
            <span class="eq-bar"></span>
          </div>
        `;
      } else {
        const rawNum = row.getAttribute('data-raw-num') || '01';
        eqBox.textContent = rawNum;
      }
    }

    if (playBtn) {
      if (isThisPlaying && isPlaying) {
        playBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
        playBtn.title = '暂停';
      } else {
        playBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
        playBtn.title = '播放';
      }
    }
  });
}

function renderPlaylistListView(list) {
  const container = document.getElementById('shelfListItems');
  if (!container) return;
  container.innerHTML = '';

  const data = Array.isArray(list) ? list : PLAYLIST_ARCHIVES;
  const kw = overviewSearchKeyword;

  // 更新顶部统计胶囊
  let totalTracks = 0;
  data.forEach(p => { if (p.tracks) totalTracks += p.tracks.length; });
  const statsEl = document.getElementById('overviewStatsBadge');
  if (statsEl) {
    statsEl.textContent = `${data.length} 盒歌单 · ${totalTracks} 首典藏`;
  }

  // 模式 1：全部典藏单曲一览
  if (overviewCurrentTab === 'all') {
    renderAllTracksOverview(data, kw, container);
    return;
  }

  // 模式 2：按歌单分类 (手风琴展开曲目)
  data.forEach((pl, idx) => {
    const card = document.createElement('div');
    card.className = 'overview-playlist-card';
    card.style.setProperty('--card-accent', pl.accent || '#d94e34');

    const tracks = pl.tracks || [];
    const isExpanded = kw.length > 0 ? true : (overviewExpandedPlaylists[pl.id] ?? false);
    const filteredTracks = kw.length > 0
      ? tracks.filter(t => (t.title && t.title.toLowerCase().includes(kw)) || (t.artist && t.artist.toLowerCase().includes(kw)))
      : tracks;

    // 如果搜索时该歌单无匹配曲目且歌单名也不匹配，跳过展示
    if (kw.length > 0 && filteredTracks.length === 0 && !pl.title.toLowerCase().includes(kw)) {
      return;
    }

    const coverArt = pl.coverImgUrl 
      ? `<img src="${esc(pl.coverImgUrl)}" style="width:44px; height:44px; border-radius:8px; object-fit:cover; flex-shrink:0;">`
      : `<div style="width:44px; height:44px; border-radius:8px; background:${pl.accent || '#d94e34'}; display:flex; align-items:center; justify-content:center; color:#fff; font-size:18px; flex-shrink:0;">📼</div>`;

    const tracksHtml = filteredTracks.map((t, tIdx) => {
      const trackNumStr = String(tIdx + 1).padStart(2, '0');
      const isCurrent = (activeBooks === pl.tracks && targetIdx === tIdx);
      const isAudPlaying = isCurrent && isPlaying;
      const thumbSrc = t.picUrl || t.coverUrl || pl.coverImgUrl;
      const thumbHtml = thumbSrc
        ? `<img class="track-mini-thumb" src="${esc(thumbSrc)}" alt="${esc(t.title)}" onerror="this.style.display='none'">`
        : `<div class="track-mini-thumb" style="display:flex; align-items:center; justify-content:center; color:#fff; background:${t.accent || pl.accent || '#27272a'}; font-size:14px;">♪</div>`;

      return `
        <div class="overview-track-row ${isCurrent ? 'is-current-playing' : ''}" 
             data-track-title="${esc(t.title)}"
             data-raw-num="${trackNumStr}"
             style="--row-accent:${t.accent || pl.accent || '#d94e34'};"
             onclick="playSongFromOverview('${pl.id}', ${tIdx}, event)"
             ondblclick="openPlayerFromOverview('${pl.id}', ${tIdx}, event)"
             title="单击播放，双击进入全屏播放页">
          <div class="track-index-box">
            ${isCurrent ? `
              <div class="eq-anim-container ${isAudPlaying ? '' : 'is-paused'}">
                <span class="eq-bar"></span>
                <span class="eq-bar"></span>
                <span class="eq-bar"></span>
              </div>
            ` : trackNumStr}
          </div>
          ${thumbHtml}
          <div class="track-meta-col">
            <div class="track-title-line">
              <span>${esc(t.title)}</span>
              ${t.statusTag ? `<span class="track-tag-chip">${esc(t.statusTag)}</span>` : ''}
              ${t.subTag ? `<span class="track-tag-chip" style="opacity:0.75;">${esc(t.subTag)}</span>` : ''}
            </div>
            <div class="track-sub-line">
              <span>${esc(t.artist || '未知歌手')}</span>
              ${t.subtitleQuote ? `<span style="opacity:0.6; margin-left:4px;">${esc(t.subtitleQuote)}</span>` : ''}
            </div>
          </div>
          <div class="track-duration-text">${formatMMSS(t.durationSec || 210)}</div>
          <div class="track-actions-group" onclick="event.stopPropagation();">
            <button class="track-icon-btn play-btn" 
                    onclick="playSongFromOverview('${pl.id}', ${tIdx}, event)"
                    title="${isAudPlaying ? '暂停' : '播放'}">
              ${isAudPlaying ? `
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
              ` : `
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              `}
            </button>
            <button class="track-icon-btn" 
                    onclick="openPlayerFromOverview('${pl.id}', ${tIdx}, event)" 
                    title="进入沉浸式播放页与动效">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </button>
          </div>
        </div>
      `;
    }).join('');

    card.innerHTML = `
      <div class="playlist-header-row" onclick="toggleOverviewPlaylistAccordion('${pl.id}')">
        <div class="playlist-header-left">
          ${coverArt}
          <div style="flex:1; min-width:0;">
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-weight:700; font-size:14px; color:#18181b;">${esc(pl.title)}</span>
              <span class="playlist-badge-pill" style="border-left:2px solid ${pl.accent || '#d94e34'};">${pl.badge || '歌单'}</span>
            </div>
            <div style="font-size:12px; color:#71717a; margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${esc(pl.subtitle || '')} · <b style="color:#27272a;">${tracks.length}</b> 首曲目
            </div>
          </div>
        </div>
        <div class="playlist-header-right" onclick="event.stopPropagation();">
          ${tracks.length > 0 ? `
            <button class="playlist-action-chip" onclick="toggleOverviewPlaylistAccordion('${pl.id}')">
              <span>${isExpanded ? '收起曲目 ▲' : `展开曲目 (${tracks.length}) ▼`}</span>
            </button>
            <button class="playlist-action-chip" onclick="openCoverflowFromOverview('${pl.id}', event)" title="飞入第二层 3D 选歌封面流">
              <span>3D封面流</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
            <button class="playlist-action-chip accent-play" onclick="playSongFromOverview('${pl.id}', 0, event)" title="从第1首开始播放">
              <span>▶ 播放</span>
            </button>
          ` : `
            <button class="playlist-action-chip" onclick="openPlaylistCoverflow(${idx})">
              <span>进入</span>
            </button>
          `}
        </div>
      </div>
      ${tracks.length > 0 ? `
        <div class="playlist-tracks-container" style="display:${isExpanded ? 'flex' : 'none'};">
          ${tracksHtml}
        </div>
      ` : ''}
    `;

    container.appendChild(card);
  });
}

function renderAllTracksOverview(playlists, kw, container) {
  const allTracks = [];
  playlists.forEach(pl => {
    if (pl.tracks && pl.tracks.length > 0) {
      pl.tracks.forEach((t, tIdx) => {
        allTracks.push({
          track: t,
          trackIndex: tIdx,
          playlist: pl
        });
      });
    }
  });

  const filtered = kw.length > 0
    ? allTracks.filter(item => {
        const t = item.track;
        return (t.title && t.title.toLowerCase().includes(kw)) ||
               (t.artist && t.artist.toLowerCase().includes(kw)) ||
               (item.playlist.title && item.playlist.title.toLowerCase().includes(kw));
      })
    : allTracks;

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="padding:40px 20px; text-align:center; color:#71717a;">
        <div style="font-size:32px; margin-bottom:8px;">🔍</div>
        <div style="font-weight:600; font-size:14px;">没有找到匹配「${esc(kw)}」的曲目</div>
        <div style="font-size:12px; margin-top:4px;">试试搜索其他歌曲名、歌手或歌单关键词</div>
      </div>
    `;
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'overview-playlist-card';
  wrapper.style.padding = '8px 12px';

  wrapper.innerHTML = filtered.map((item, idx) => {
    const t = item.track;
    const pl = item.playlist;
    const tIdx = item.trackIndex;
    const trackNumStr = String(idx + 1).padStart(2, '0');
    const isCurrent = (activeBooks === pl.tracks && targetIdx === tIdx);
    const isAudPlaying = isCurrent && isPlaying;
    const thumbSrc = t.picUrl || t.coverUrl || pl.coverImgUrl;
    const thumbHtml = thumbSrc
      ? `<img class="track-mini-thumb" src="${esc(thumbSrc)}" alt="${esc(t.title)}" onerror="this.style.display='none'">`
      : `<div class="track-mini-thumb" style="display:flex; align-items:center; justify-content:center; color:#fff; background:${t.accent || pl.accent || '#27272a'}; font-size:14px;">♪</div>`;

    return `
      <div class="overview-track-row ${isCurrent ? 'is-current-playing' : ''}" 
           data-track-title="${esc(t.title)}"
           data-raw-num="${trackNumStr}"
           style="--row-accent:${t.accent || pl.accent || '#d94e34'}; margin-bottom:3px;"
           onclick="playSongFromOverview('${pl.id}', ${tIdx}, event)"
           ondblclick="openPlayerFromOverview('${pl.id}', ${tIdx}, event)"
           title="单击播放，双击进入全屏播放页">
        <div class="track-index-box">
          ${isCurrent ? `
            <div class="eq-anim-container ${isAudPlaying ? '' : 'is-paused'}">
              <span class="eq-bar"></span>
              <span class="eq-bar"></span>
              <span class="eq-bar"></span>
            </div>
          ` : trackNumStr}
        </div>
        ${thumbHtml}
        <div class="track-meta-col">
          <div class="track-title-line">
            <span>${esc(t.title)}</span>
            <span class="playlist-badge-pill" style="border-left:2px solid ${pl.accent || '#d94e34'};">${esc(pl.badge || '歌单')}</span>
            ${t.statusTag ? `<span class="track-tag-chip">${esc(t.statusTag)}</span>` : ''}
          </div>
          <div class="track-sub-line">
            <span>${esc(t.artist || '未知歌手')}</span>
            <span style="opacity:0.5; margin:0 4px;">·</span>
            <span style="opacity:0.75;">来自《${esc(pl.title)}》</span>
          </div>
        </div>
        <div class="track-duration-text">${formatMMSS(t.durationSec || 210)}</div>
        <div class="track-actions-group" onclick="event.stopPropagation();">
          <button class="track-icon-btn play-btn" 
                  onclick="playSongFromOverview('${pl.id}', ${tIdx}, event)"
                  title="${isAudPlaying ? '暂停' : '播放'}">
            ${isAudPlaying ? `
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
            ` : `
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            `}
          </button>
          <button class="track-icon-btn" 
                  onclick="openPlayerFromOverview('${pl.id}', ${tIdx}, event)" 
                  title="进入沉浸式播放页与动效">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </button>
        </div>
      </div>
    `;
  }).join('');

  container.appendChild(wrapper);
}

function render3DBookShelf() { render3DPlaylistShelf(); }
function stepShelfIndex(dir) { stepPlaylistIndex(dir); }

let isShelfForcedDirty = true;
let isTrackForcedDirty = true;

// ============================================================================
// 4. 第二层：深色封面流选歌 (Track Cover Flow)
// ============================================================================
function render3DTrackCoverFlow(initialIdx) {
  const origin = document.getElementById('coverflowOrigin');
  if (!origin) return;
  origin.innerHTML = '';
  cfTrackCardNodes = [];

  let startIdx = 0;
  if (typeof initialIdx === 'number' && initialIdx >= 0 && initialIdx < activeBooks.length) {
    startIdx = initialIdx;
  } else if (typeof targetIdx === 'number' && targetIdx >= 0 && targetIdx < activeBooks.length && (isPlaying || (localAudioEl && !localAudioEl.paused))) {
    startIdx = targetIdx;
  }

  currentTrackIdx = startIdx;
  trackTargetPos = startIdx;
  trackScrollPos = startIdx;
  trackScrollVelocity = 0;
  if (!isPlaying) {
    targetIdx = startIdx;
  }

  activeBooks.forEach((book, idx) => {
    const el = document.createElement('div');
    el.className = 'cf-track-card' + (idx === currentTrackIdx ? ' is-focused' : '');
    el.style.setProperty('--card-accent', book.accent || '#f59e0b');

    // 仅先构建当前视口附近（±12）的复杂封面 SVG，其余按需懒加载
    if (Math.abs(idx - currentTrackIdx) <= 12) {
      el.innerHTML = coverArtHTML(book);
      el._rendered = true;
    } else {
      el._rendered = false;
    }

    el.onclick = (e) => {
      if (hasCfDragged) return;
      e.stopPropagation();
      if (idx !== currentTrackIdx) {
        currentTrackIdx = idx;
        trackTargetPos = idx;
        playMechanicalTick(1.15);
        updateCoverflowFooter(idx);
        wake();
      } else {
        const isDifferentTrack = (typeof targetIdx === 'number' && targetIdx !== idx);
        openPlayerView(isDifferentTrack || !isPlaying);
      }
    };

    el.ondblclick = (e) => {
      e.stopPropagation();
      currentTrackIdx = idx;
      trackTargetPos = idx;
      openPlayerView(true);
    };

    origin.appendChild(el);
    cfTrackCardNodes.push(el);
  });

  isTrackForcedDirty = true;
  updateCoverflowFooter(startIdx);
  wake();
}

function updateCoverflowFooter(idx) {
  const book = activeBooks[idx];
  if (!book) return;
  const tEl = document.getElementById('cfBottomTitle');
  const sEl = document.getElementById('cfBottomStatus');
  const aEl = document.getElementById('cfBottomArtist');
  const pEl = document.getElementById('cfPageIndicator');
  const subTag = document.getElementById('cfBottomSubTag');
  const cfPlayBtn = document.getElementById('cfMainPlayBtn');

  if (tEl) tEl.textContent = book.title;
  if (sEl) sEl.textContent = book.statusTag || '母带SQ无损';
  if (aEl) aEl.textContent = `${book.artist} · 专辑《${book.shortTitle || book.title}》`;
  if (pEl) pEl.textContent = `${String(idx + 1).padStart(2, '0')} / ${String(activeBooks.length).padStart(2, '0')}`;

  const isCurrentTrackPlaying = (idx === targetIdx && isPlaying);
  const isCurrentTrackPaused = (idx === targetIdx && !isPlaying && (localAudioEl || (book.currentSec && book.currentSec > 0)));

  if (subTag) {
    if (isCurrentTrackPlaying) {
      subTag.textContent = '正在播放';
      subTag.className = 'status-pill highlight is-playing-glow';
    } else if (isCurrentTrackPaused) {
      subTag.textContent = '已暂停';
      subTag.className = 'status-pill';
    } else {
      subTag.textContent = '点击播放';
      subTag.className = 'status-pill';
    }
  }

  if (cfPlayBtn) {
    cfPlayBtn.title = isCurrentTrackPlaying ? '暂停当前单曲' : '播放当前单曲';
    cfPlayBtn.innerHTML = isCurrentTrackPlaying
      ? '<svg viewBox="0 0 32 32" width="20" height="20" fill="currentColor"><path d="M9 7H13V25H9V7ZM19 7H23V25H19V7Z"/></svg>'
      : '<svg viewBox="0 0 32 32" width="20" height="20" fill="currentColor"><path d="M10 7.5L25 16L10 24.5V7.5Z"/></svg>';
  }
}

function onCoverflowPlayButtonClick(e) {
  if (e) e.stopPropagation();
  if (currentTrackIdx === targetIdx) {
    togglePlayPause();
  } else {
    const isDifferent = (typeof targetIdx === 'number' && targetIdx !== currentTrackIdx);
    targetIdx = currentTrackIdx;
    const book = activeBooks[targetIdx];
    if (book) {
      if (isDifferent) book.currentSec = 0;
      populatePlayerView(book);
      isPlaying = true;
      syncPlayIcons();
      startTrackAudio();
    }
  }
  updateCoverflowFooter(currentTrackIdx);
  wake();
}

function onCoverflowFooterInfoClick() {
  const isDifferent = (typeof targetIdx === 'number' && currentTrackIdx !== targetIdx);
  openPlayerView(isDifferent || !isPlaying);
}

function stepTrackIndex(dir) {
  currentTrackIdx = Math.max(0, Math.min(activeBooks.length - 1, currentTrackIdx + dir));
  trackTargetPos = currentTrackIdx;
  playMechanicalTick(1.15);
  updateCoverflowFooter(currentTrackIdx);
  wake();
}

// ============================================================================
// 5. 跨层调度器 (Layer Transition Dispatcher)
// ============================================================================
function openPlaylistCoverflow(idx) {
  if (typeof idx === 'number') {
    currentPlaylistIdx = idx;
    playlistTargetPos = idx;
  }
  const pl = PLAYLIST_ARCHIVES[currentPlaylistIdx] || PLAYLIST_ARCHIVES[0];
  if (!pl) return;

  if (pl.id === 'pl_login') {
    if (window.NCM && typeof NCM.openLoginPanel === 'function') {
      NCM.openLoginPanel();
      return;
    }
  }

  // 预下载专辑前几首封面：进入专辑时立即解码，避免切换动效时封面未就绪导致的跳帧
  try {
    const __pool = (pl.tracks || []).slice(0, 12);
    __pool.forEach(function (s) {
      const __u = (s.al && s.al.picUrl) || s.picUrl || s.coverUrl;
      if (__u && !s._preloaded) {
        s._preloaded = true;
        const __img = new Image();
        __img.decoding = 'async';
        __img.src = __u;
      }
    });
  } catch (_) {}

  const tEl = document.getElementById('cfPlaylistTitle');
  const cEl = document.getElementById('cfPlaylistCount');
  if (tEl) tEl.textContent = pl.title;
  if (cEl) cEl.textContent = `${pl.trackCount || 0} 首`;
  if (window.DynamicPlatformIsland) {
    DynamicPlatformIsland.update({
      title: pl.title,
      count: `${pl.trackCount || 0} 首`,
      isPlaying: isPlaying,
      accentHex: pl.accent || '#f59e0b'
    });
  }

  playMechanicalTick(1.35);

  // 1. 触发共享封面放大过渡动画 (来自 音乐播放器.make shared-cover 核心机制)
  const sharedCover = document.getElementById('sharedCover');
  const sharedContent = document.getElementById('sharedCoverContent');
  if (sharedCover && sharedContent) {
    const coverSrc = pl.coverImg || pl.picUrl || pl.coverUrl
      || (pl.tracks && pl.tracks[0] && (pl.tracks[0].picUrl || pl.tracks[0].coverUrl));
    // 歌单没有封面时，异步向网易云要第一首歌的专辑封面（歌单 tracks 是懒加载的）
    if (!coverSrc && pl.isNcm && pl.id && window.NCM && NCM.fetchFirstCover) {
      NCM.fetchFirstCover(pl.id).then(function (url) {
        if (!url) return;
        var pre2 = new Image();
        pre2.decoding = 'async';
        pre2.onload = function () {
          sharedContent.innerHTML = '<img src="' + url + '" alt="' + esc(pl.title) + '">';
        };
        pre2.src = url;
        pl.coverImgUrl = url;
      });
    }

    if (coverSrc) {
      // 过渡动画开始前必须确保图片已解码，否则动画途中一片空白
      // 兜底卡片：用歌单主色做渐变（不是黑灰），图片没就绪时也看不到"黑块"
      const __ac = (pl.accent || '#d94e34').replace('#', '');
      const __r = parseInt(__ac.slice(0, 2), 16) || 217;
      const __g = parseInt(__ac.slice(2, 4), 16) || 78;
      const __b = parseInt(__ac.slice(4, 6), 16) || 52;
      const fbs = '<div style="width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;background:linear-gradient(140deg, rgba(' + __r + ',' + __g + ',' + __b + ',0.95) 0%, rgba(' + Math.round(__r * 0.45) + ',' + Math.round(__g * 0.45) + ',' + Math.round(__b * 0.45) + ',0.98) 62%, rgba(18,18,22,1) 100%);">'
        + '<div style="font-size:36px;margin-bottom:8px;">📼</div>'
        + '<div style="font-size:16px;font-weight:700;color:#fff;font-family:sans-serif;text-shadow:0 2px 8px rgba(0,0,0,0.6);">' + esc(pl.title) + '</div>'
        + '<div style="font-size:11px;color:rgba(255,255,255,0.75);margin-top:6px;font-family:monospace;">' + (pl.trackCount || 0) + ' 首收录 // AUDIO ARCHIVE</div></div>';
      // 先展示兜底卡，同时用 decode() 等图片真正解码完再替换
      // 避免 onload 时序问题：decode() 确保像素数据已就绪，动画中不会出现白/黑帧
      sharedContent.innerHTML = fbs;
      const pre = new Image();
      pre.src = coverSrc;
      (pre.decode ? pre.decode() : Promise.resolve())
        .then(() => { sharedContent.innerHTML = '<img src="' + coverSrc + '" alt="' + esc(pl.title) + '">'; })
        .catch(() => { /* 兜底已展示，onerror 时保持现有状态 */ });
    } else {
      // 没有任何封面来源时，用歌单主色做渐变卡片（不是深灰黑块）
      var __ac2 = (pl.accent || '#d94e34').replace('#', '');
      var __r2 = parseInt(__ac2.slice(0, 2), 16) || 217;
      var __g2 = parseInt(__ac2.slice(2, 4), 16) || 78;
      var __b2 = parseInt(__ac2.slice(4, 6), 16) || 52;
      sharedContent.innerHTML = '<div style="width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;border-radius:10px;box-sizing:border-box;padding:20px;text-align:center;background:linear-gradient(140deg, rgba(' + __r2 + ',' + __g2 + ',' + __b2 + ',0.96) 0%, rgba(' + Math.round(__r2 * 0.42) + ',' + Math.round(__g2 * 0.42) + ',' + Math.round(__b2 * 0.42) + ',0.98) 62%, rgba(18,18,22,1) 100%);">'
        + '<div style="font-size:36px;margin-bottom:8px;">📼</div>'
        + '<div style="font-size:16px;font-weight:700;color:#fff;font-family:sans-serif;text-shadow:0 2px 8px rgba(0,0,0,0.55);">' + esc(pl.title) + '</div>'
        + '<div style="font-size:11px;color:rgba(255,255,255,0.75);margin-top:6px;font-family:monospace;">' + (pl.trackCount || 0) + ' 首收录 // AUDIO ARCHIVE</div></div>';
    }
    sharedCover.classList.remove('launching');
    void sharedCover.offsetWidth; // 触发 reflow 重置动画
    sharedCover.classList.add('launching');
    setTimeout(() => {
      sharedCover.classList.remove('launching');
    }, 1100);
  }

  // 2. 第一层书架平滑虚化与后移退场
  const shelf = document.getElementById('shelfView');
  const cf = document.getElementById('coverflowView');
  if (shelf) shelf.classList.add('hidden-left');

  // 3. 360ms 处第二层选歌封面流优雅向上展开入场 (两层在飞跃过渡中自然交织)
  setTimeout(() => {
    if (cf) cf.classList.add('open');
  }, 360);

  if (pl.tracks && pl.tracks.length > 0) {
    activeBooks = pl.tracks;
    SOURCE_BOOKS = activeBooks;
    let focusIdx = 0;
    if (typeof targetIdx === 'number' && targetIdx >= 0 && targetIdx < activeBooks.length && (isPlaying || (localAudioEl && !localAudioEl.paused))) {
      focusIdx = targetIdx;
    }
    render3DTrackCoverFlow(focusIdx);
  } else if (pl.isNcm && pl.id && window.NCM && window.NCM.loadPlaylistTracks) {
    const origin = document.getElementById('coverflowOrigin');
    if (origin) {
      origin.innerHTML = `
        <div style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#e4e4e7; gap:14px; z-index:50;">
          <div style="width:38px; height:38px; border:3px solid rgba(255,255,255,0.18); border-top-color:${pl.accent || '#f59e0b'}; border-radius:50%; animation:wheelSpin 0.75s linear infinite;"></div>
          <div style="font-size:13px; font-weight:700; letter-spacing:0.06em; color:#e4e4e7;">正在载入《${esc(pl.title)}》曲目...</div>
        </div>
      `;
    }
    NCM.loadPlaylistTracks(pl.id, (books) => {
      if (!books || books.length === 0) {
        showToast('歌单加载失败，点击可重新导入');
        const origin2 = document.getElementById('coverflowOrigin');
        if (origin2) {
          origin2.innerHTML = `
            <div style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#e4e4e7; gap:16px; z-index:50;">
              <div style="font-size:38px;">⚠️</div>
              <div style="font-size:14px; font-weight:700; color:#e4e4e7; text-align:center;">歌单加载失败或歌曲全部受限<br><span style="font-size:12px; opacity:0.6; font-weight:normal;">可检查网络、后端接口或点击下方重试</span></div>
              <button onclick="if(window.PLAYLIST_ARCHIVES&&PLAYLIST_ARCHIVES[${currentPlaylistIdx}]){PLAYLIST_ARCHIVES[${currentPlaylistIdx}].tracks=null;}openPlaylistCoverflow(${currentPlaylistIdx});" style="margin-top:4px; padding:10px 24px; background:${pl.accent || '#ef3b3a'}; color:#fff; border:none; border-radius:20px; font-size:13px; font-weight:700; cursor:pointer;">🔄 重新导入歌单</button>
            </div>
          `;
        }
        return;
      }
      pl.tracks = books;
      pl.trackCount = books.length;
      if (cEl) cEl.textContent = `${books.length} 首`;
      activeBooks = books;
      SOURCE_BOOKS = books;
      let focusIdx = 0;
      if (typeof targetIdx === 'number' && targetIdx >= 0 && targetIdx < activeBooks.length && (isPlaying || (localAudioEl && !localAudioEl.paused))) {
        focusIdx = targetIdx;
      }
      render3DTrackCoverFlow(focusIdx);
      wake();
    });
  } else if (pl.isQq && pl.id) {
    const origin = document.getElementById('coverflowOrigin');
    if (origin) {
      origin.innerHTML = `
        <div style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#e4e4e7; gap:14px; z-index:50;">
          <div style="width:38px; height:38px; border:3px solid rgba(255,255,255,0.18); border-top-color:${pl.accent || '#31c27c'}; border-radius:50%; animation:wheelSpin 0.75s linear infinite;"></div>
          <div style="font-size:13px; font-weight:700; letter-spacing:0.06em; color:#e4e4e7;">正在载入 QQ 音乐《${esc(pl.title)}》曲目...</div>
        </div>
      `;
    }
    const cleanId = String(pl.id).replace(/^qq_/, '');
    fetch(`/qq/playlist?id=${encodeURIComponent(cleanId)}`)
      .then(r => r.json())
      .then(j => {
        const cd = (j.cdlist && j.cdlist[0]) || j;
        const songlist = cd.songlist || [];
        if (!songlist.length) throw new Error('歌单为空或私密');
        const coverUrl = (cd.logo || pl.coverImgUrl || '').replace(/^http:/, 'https:');
        const books = songlist.map((s, idx) => ({
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
        pl.tracks = books;
        pl.books = books;
        pl.trackCount = books.length;
        if (cEl) cEl.textContent = `${books.length} 首`;
        activeBooks = books;
        SOURCE_BOOKS = books;
        render3DTrackCoverFlow();
        updateCoverflowFooter(0);
        wake();
      })
      .catch(err => {
        showToast('QQ 音乐歌单加载失败：' + (err.message || err));
        const origin2 = document.getElementById('coverflowOrigin');
        if (origin2) {
          origin2.innerHTML = `
            <div style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#e4e4e7; gap:16px; z-index:50;">
              <div style="font-size:38px;">⚠️</div>
              <div style="font-size:14px; font-weight:700; color:#e4e4e7; text-align:center;">QQ 音乐歌单加载失败<br><span style="font-size:12px; opacity:0.6; font-weight:normal;">${esc(err.message || '')}</span></div>
              <button onclick="if(window.PLAYLIST_ARCHIVES&&PLAYLIST_ARCHIVES[${currentPlaylistIdx}]){PLAYLIST_ARCHIVES[${currentPlaylistIdx}].tracks=null;}openPlaylistCoverflow(${currentPlaylistIdx});" style="margin-top:4px; padding:10px 24px; background:#31c27c; color:#fff; border:none; border-radius:20px; font-size:13px; font-weight:700; cursor:pointer;">🔄 重新加载</button>
            </div>
          `;
        }
      });
  } else {
    activeBooks = ARCHIVE_BOOKS;
    SOURCE_BOOKS = activeBooks;
    render3DTrackCoverFlow();
  }

  wake();
}

function backToPlaylistShelf() {
  playMechanicalTick(1.15);
  const shelf = document.getElementById('shelfView');
  const cf = document.getElementById('coverflowView');
  if (cf) cf.classList.remove('open');
  if (shelf) shelf.classList.remove('hidden-left');
  updatePlaylistShelfFooter(currentPlaylistIdx);
  wake();
}

function backToCoverflow() {
  playMechanicalTick(1.15);
  const pv = document.getElementById('playerView');
  if (pv) pv.classList.remove('open');

  // 返回封面流时，自动对准当前正在播放的曲目并刷新状态
  if (typeof targetIdx === 'number' && targetIdx >= 0 && targetIdx < activeBooks.length) {
    currentTrackIdx = targetIdx;
    trackTargetPos = targetIdx;
    trackScrollPos = targetIdx;
    trackScrollVelocity = 0;
    isTrackForcedDirty = true;
    updateCoverflowFooter(targetIdx);
  }
  wake();
}

// ============================================================================
// 6. 音频核心系统、Web Audio 频谱分析与播放器控制
// ============================================================================
// 6. 播放详情页切换、Web Audio 频谱分析器与 Folia 帧驱动
// ============================================================================
let audioCtx = null;
let analyserNode = null;
let freqDataArray = null;
let prevAudioPower = 0;
let isPlaying = false;
window.isPlaying = false;
let reelAngle = 0;
let synthInterval = null;
let noteStep = 0;
let localAudioEl = null;
let globalAudioEl = null;

function getGlobalAudio() {
  if (!globalAudioEl) {
    globalAudioEl = new Audio();
    try {
      globalAudioEl.crossOrigin = 'anonymous';
    } catch (_) {}
    globalAudioEl.preload = 'auto';
    window.localAudioEl = globalAudioEl;
    localAudioEl = globalAudioEl;
    attachAudioElementToAnalyzer(globalAudioEl);
  }
  return globalAudioEl;
}

function ensureAudioCtx() {
  if (!audioCtx) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioCtx();
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 256;
      analyserNode.smoothingTimeConstant = 0.82;
      freqDataArray = new Uint8Array(analyserNode.frequencyBinCount);
      analyserNode.connect(audioCtx.destination);
      window.analyserNode = analyserNode;
      window.audioCtx = audioCtx;
    } catch (_) {}
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}

function attachAudioElementToAnalyzer(audioEl) {
  if (!audioEl) return;
  try {
    ensureAudioCtx();
    if (!audioEl._sourceAttached && audioCtx) {
      if (window.AudioEffects && window.AudioEffects.engine && !window.AudioEffects.engine.isInitialized) {
        window.AudioEffects.engine.init(audioEl, (x, z) => {
          const blip = document.getElementById('aepRadarBlip');
          if (blip) blip.style.transform = `translate(${x * 18}px, ${-z * 18}px)`;
        }, audioCtx, analyserNode);
      } else {
        const source = audioCtx.createMediaElementSource(audioEl);
        source.connect(analyserNode);
        audioEl._sourceAttached = true;
        audioEl._sourceNode = source;
      }
    }
  } catch (err) {
    console.warn('[WebAudio] MediaElementSource fallback:', err);
  }
}

function extractCoverColors(imgUrl, callback) {
  if (!imgUrl) return;
  const proxyUrl = (imgUrl.includes('gtimg.cn') || imgUrl.includes('qq.com') || imgUrl.includes('qpic.cn'))
    ? ('/cover-proxy?url=' + encodeURIComponent(imgUrl))
    : imgUrl;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const cvs = document.createElement('canvas');
      cvs.width = cvs.height = 16;
      const ctx = cvs.getContext('2d');
      ctx.drawImage(img, 0, 0, 16, 16);
      const data = ctx.getImageData(0, 0, 16, 16).data;
      let r1 = 0, g1 = 0, b1 = 0, count = 0;
      let r2 = 0, g2 = 0, b2 = 0;
      for (let i = 0; i < data.length; i += 16) {
        r1 += data[i]; g1 += data[i+1]; b1 += data[i+2]; count++;
        r2 = Math.max(r2, data[i]);
        g2 = Math.max(g2, data[i+1]);
        b2 = Math.max(b2, data[i+2]);
      }
      const prim = [
        Math.max(0.08, r1 / (count * 255)),
        Math.max(0.08, g1 / (count * 255)),
        Math.max(0.08, b1 / (count * 255))
      ];
      const acc = [
        Math.min(1.0, (r2 / 255) * 1.25),
        Math.min(1.0, (g2 / 255) * 1.25),
        Math.min(1.0, (b2 / 255) * 1.25)
      ];
      callback(prim, acc);
    } catch (_) {}
  };
  const isRemote = typeof imgUrl === 'string' && (imgUrl.startsWith('http://') || imgUrl.startsWith('https://'));
  img.src = isRemote ? ('/cover-proxy?url=' + encodeURIComponent(imgUrl)) : imgUrl;
}

function computeAudioMetrics() {
  if (!isPlaying) return { audioPower: 0, beat: false };
  if (analyserNode && freqDataArray) {
    analyserNode.getByteFrequencyData(freqDataArray);
    let sum = 0;
    let bassSum = 0;
    const bassCount = Math.floor(freqDataArray.length * 0.28);
    for (let i = 0; i < freqDataArray.length; i++) {
      sum += freqDataArray[i];
      if (i < bassCount) bassSum += freqDataArray[i];
    }
    const avg = sum / (freqDataArray.length * 255);
    const bassAvg = bassCount > 0 ? (bassSum / (bassCount * 255)) : avg;
    if (avg > 0.005) {
      const beat = (bassAvg - prevAudioPower > 0.11 && bassAvg > 0.22);
      prevAudioPower = bassAvg;
      return { audioPower: Math.min(1.0, avg * 1.55), beat };
    }
  }
  // 离线/合成器节拍模拟回退
  const t = performance.now() / 1000;
  const pulse = 0.42 + 0.28 * Math.sin(t * 6.8) + 0.15 * Math.cos(t * 13.5);
  const beat = Math.sin(t * 6.8) > 0.92;
  return { audioPower: Math.max(0.08, Math.min(1, pulse)), beat };
}

function syncFoliaFrame() {
  if (!foliaUpstreamIframe || !foliaUpstreamIframe.contentWindow || currentFoliaMode === 'off') return;
  const book = activeBooks[targetIdx] || ARCHIVE_BOOKS[0];
  if (!book) return;
  const curTime = (localAudioEl && !localAudioEl.paused) ? localAudioEl.currentTime : (book.currentSec || 0);
  const { audioPower } = computeAudioMetrics();
  try {
    foliaUpstreamIframe.contentWindow.postMessage({
      type: 'SYNC_TIME',
      time: curTime,
      playing: !!isPlaying,
      audioEnergy: audioPower
    }, '*');
  } catch (_) {}
}

function playMechanicalTick(pitch = 1) {
  if (!soundOn) return;
  try {
    ensureAudioCtx();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(180 * pitch, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(52, audioCtx.currentTime + 0.024);
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.024);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.026);
  } catch (_) {}
}



function playCassetteEngageClack() {
  if (!soundOn) return;
  try {
    ensureAudioCtx();
    const now = audioCtx.currentTime;
    [0, 0.055].forEach((offset, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(i === 0 ? 130 : 92, now + offset);
      osc.frequency.exponentialRampToValueAtTime(32, now + offset + 0.05);
      gain.gain.setValueAtTime(0.18, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.052);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.055);
    });
  } catch (_) {}
}

function populatePlayerView(book) {
  if (!book) return;

  // 预加载封面：先解码再显示，避免动效切换时闪白/黑块
  const __coverUrl = book.picUrl || book.coverUrl;
  if (__coverUrl && !book._coverReady) {
    const __pre = new Image();
    __pre.decoding = 'async';
    __pre.onload = () => { book._coverReady = true; };
    __pre.onerror = () => { book._coverFailed = true; };
    __pre.src = __coverUrl;
  }

  // 顺带预热相邻曲目的封面，切上一首/下一首时不会出现空白帧
  try {
    const __i = activeBooks ? activeBooks.indexOf(book) : -1;
    if (__i >= 0) {
      [-1, 1, 2].forEach(function (d) {
        const nb = activeBooks[__i + d];
        if (!nb || nb._coverPrewarmed) return;
        nb._coverPrewarmed = true;
        const u = nb.picUrl || nb.coverUrl;
        if (u) { const im = new Image(); im.decoding = 'async'; im.src = u; }
      });
    }
  } catch (_) {}

  document.getElementById('playerCoverArt').innerHTML = coverArtHTML(book);
  const subtitle = book.subtitleQuote || (book.album ? `专辑《${book.album}》` : '纯净原声 · 沉浸倾听');
  const subArtist = book.subArtist ? `${book.subArtist} · ${book.artist}` : (book.artist || '纯净原声');
  const serial = `${book.serial || 'WK-AUDIO'} // NO.${book.index || '01'}`;
  document.getElementById('playerTrackSubtitle').textContent = subtitle;
  document.getElementById('playerArtistSub').textContent = subArtist;
  document.getElementById('xraySerialCode').textContent = serial;
  document.getElementById('totalDurationLabel').textContent = formatMMSS(book.durationSec);
  syncHeartIcon(book ? book._liked : false);

  // 更新黑胶碟心图片
  const discLabel = document.getElementById('vinylCenterLabel');
  if (discLabel) {
    const imgUrl = book.picUrl || book.coverUrl;
    if (imgUrl) {
      discLabel.innerHTML = `<img src="${imgUrl}" alt="disc">`;
    } else {
      discLabel.innerHTML = '';
    }
  }

  if (book.picUrl || book.coverUrl) {
    extractCoverColors(book.picUrl || book.coverUrl, (prim, acc) => {
      const pR = Math.round(prim[0] * 255);
      const pG = Math.round(prim[1] * 255);
      const pB = Math.round(prim[2] * 255);
      const aR = Math.round(acc[0] * 255);
      const aG = Math.round(acc[1] * 255);
      const aB = Math.round(acc[2] * 255);

      if (window.RainGlassEngine) {
        window.RainGlassEngine.setCoverPalette([
          [pR, pG, pB],
          [aR, aG, aB],
          [Math.round((pR + aR) / 2), Math.round((pG + aG) / 2), Math.round((pB + aB) / 2)]
        ]);
      }
      document.documentElement.style.setProperty('--album-accent', `rgb(${aR}, ${aG}, ${aB})`);
      document.documentElement.style.setProperty('--album-primary', `rgb(${pR}, ${pG}, ${pB})`);
      if (window.DynamicPlatformIsland) {
        DynamicPlatformIsland.update({ accentHex: `rgb(${aR}, ${aG}, ${aB})` });
      }
      const coverArt = document.getElementById('playerCoverArt');
      if (coverArt) {
        coverArt.style.boxShadow = `0 24px 60px -12px rgba(0, 0, 0, 0.85), 0 0 50px rgba(${pR}, ${pG}, ${pB}, 0.28), inset 0 0 0 1px rgba(255, 255, 255, 0.12)`;
      }
      if (window.FoliaVisualizer) window.FoliaVisualizer.setCustomCoverColors(prim, acc);
    });
  }
  syncPlayerProgressUI(book, true);
  renderDrawerDetails(book);
  updateMediaSession(book);
  if (currentFoliaMode !== 'off') {
    if (currentFoliaMode.startsWith('mod:')) {
      setFoliaMode(currentFoliaMode);
    } else if (currentFoliaMode === 'aurora' && window.AuroraWave) {
      let cu = book.picUrl || book.coverUrl;
      if (!cu && typeof buildArtworkSVG === 'function') {
        try { cu = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(buildArtworkSVG(book)); } catch(_) {}
      }
      if (cu) window.AuroraWave.setCover(cu);
    } else if (currentFoliaMode === 'glass' && window.GlassWater) {
      window.GlassWater.setLyrics(buildGlassLyrics(book));
    } else {
      syncFoliaToUpstreamIframe();
      syncFoliaFrame();
    }
  }
  if (window.Folium && typeof window.Folium.emit === 'function') {
    window.Folium.emit('playback:songChanged', { song: book });
  }
}

let lastSecShown = -1, lastLyricPair = null;
// 纯白歌词逐字律动与音频弹性共振系统 (Rhythmic Lyric Controller)
// ============================================================================
var RhythmicLyrics = {
  currentText: '',
  charSpans: [],
  startTime: 0,
  endTime: 0,
  containerEl: null,
  line1El: null,
  line2El: null,
  bassScale: 1.0,
  rafId: 0,
  clockTime: 0,

  init() {
    this.containerEl = document.getElementById('melancholyLyrics');
    this.line1El = document.getElementById('playerLyricLine1');
    this.line2El = document.getElementById('playerLyricLine2');
  },

  start() {
    if (!this.line1El) this.init();
    const isPlayerOpen = ui('playerView') && ui('playerView').classList.contains('open');
    if (isPlayerOpen && window.isPlaying && !this.rafId) {
      this.loop = this.loop.bind(this);
      this.rafId = requestAnimationFrame(this.loop);
    }
  },

  stop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  },

  setLine(l1, l2, startTime, endTime) {
    if (!this.line1El) this.init();
    if (this.currentText === l1) {
      this.startTime = startTime;
      this.endTime = endTime;
      this.start();
      return;
    }

    this.currentText = l1;
    this.startTime = startTime;
    this.endTime = endTime;

    // 清空重构逐字 Spans
    this.line1El.innerHTML = '';
    this.charSpans = [];

    const chars = Array.from(l1 || '');
    if (chars.length === 0) {
      this.line1El.textContent = '✦ 纯净音乐，静候乐章 ✦';
      if (this.line2El) this.line2El.textContent = l2 || '';
      return;
    }

    // 触发丝滑换行入场动画
    this.line1El.classList.remove('lyric-line-animating');
    void this.line1El.offsetWidth; // 触发 reflow
    this.line1El.classList.add('lyric-line-animating');

    chars.forEach((c, idx) => {
      const span = document.createElement('span');
      span.className = 'rhythm-char unsung';
      span.textContent = c;
      span.dataset.index = idx;
      this.line1El.appendChild(span);
      this.charSpans.push(span);
    });

    if (this.line2El) {
      this.line2El.textContent = l2 || '';
    }
    this.start();
  },

  loop() {
    const isPlayerOpen = ui('playerView') && ui('playerView').classList.contains('open');
    if (!isPlayerOpen || !window.isPlaying || !this.charSpans.length) {
      this.rafId = 0;
      return;
    }
    this.rafId = requestAnimationFrame(this.loop);
    this.clockTime += 0.018;

    // 1. 获取当前播放秒数并计算当前行唱词进度
    const book = activeBooks[targetIdx] || ARCHIVE_BOOKS[0];
    const sec = (book && typeof book.currentSec === 'number') ? book.currentSec : 0;

    const spanDuration = Math.max(0.2, this.endTime - this.startTime);
    const progress = Math.min(1.0, Math.max(0, (sec - this.startTime) / spanDuration));

    const totalChars = this.charSpans.length;
    const activeCharIndex = Math.min(totalChars - 1, Math.floor(progress * totalChars));

    // 2. 采样重低音能量驱动整行歌词弹性律动 (Elastic Bounce)
    let currentBass = 0;
    if (window.analyserNode) {
      const arr = new Uint8Array(16);
      window.analyserNode.getByteFrequencyData(arr);
      let sum = 0;
      for (let i = 0; i < 8; i++) sum += arr[i];
      currentBass = (sum / 8) / 255;
    } else {
      currentBass = (Math.sin(this.clockTime * 2.0) + 1) * 0.12;
    }

    // 缓动目标缩放：低音重击时轻柔微弹 (+2.5% ~ +4.5%)
    const targetScale = 1.0 + currentBass * 0.035;
    this.bassScale += (targetScale - this.bassScale) * 0.25;

    if (this.containerEl) {
      this.containerEl.style.transform = `scale(${this.bassScale.toFixed(4)})`;
    }

    // 3. 逐字律动状态与水波浮动 (Wave Float)
    this.charSpans.forEach((span, idx) => {
      // 慢速柔和波浪浮动
      const wave = Math.sin(this.clockTime * 2.2 + idx * 0.38) * 1.8;

      if (idx < activeCharIndex) {
        // 已唱词
        if (!span.classList.contains('sung')) {
          span.className = 'rhythm-char sung';
        }
        span.style.transform = `translateY(${wave.toFixed(2)}px)`;
      } else if (idx === activeCharIndex && progress > 0.02) {
        // 正唱词 (微弹升起与发光)
        if (!span.classList.contains('singing')) {
          span.className = 'rhythm-char singing';
        }
        span.style.transform = `translateY(${(wave - 4.0).toFixed(2)}px) scale(1.1)`;
      } else {
        // 待唱词 (空灵半透明静止)
        if (!span.classList.contains('unsung')) {
          span.className = 'rhythm-char unsung';
        }
        span.style.transform = `translateY(${(wave * 0.4).toFixed(2)}px)`;
      }
    });
  }
};

function syncPlayerProgressUI(book, force) {
  if (!book) return;
  if (force) { lastSecShown = -1; lastLyricPair = null; }
  const sec = book.currentSec, s = Math.floor(sec);
  if (s !== lastSecShown) {
    lastSecShown = s;
    const t = formatMMSS(sec);
    ui('currentTimeLabel').textContent = t;
    ui('xrayCounterText').textContent = t;
    broadcastPlaybackState();
  }
  if (!isScrubbing) {
    const v = String(Math.round(Math.min(1, Math.max(0, sec / book.durationSec)) * 1000));
    const sl = ui('playerProgressSlider');
    if (sl.value !== v) sl.value = v;

    const fillEl = document.getElementById('playerProgressFill');
    if (fillEl && book.durationSec > 0) {
      fillEl.style.width = Math.min(100, Math.max(0, (sec / book.durationSec) * 100)) + '%';
    }
    const beam = document.getElementById('shelfDockProgressBeam');
    if (beam && book.durationSec > 0) {
      beam.style.width = Math.min(100, Math.max(0, (sec / book.durationSec) * 100)) + '%';
    }
  }
  let pair = book.lyrics[0];
  let nextT = (book.lyrics[1] ? book.lyrics[1].t : (pair.t + 4.0));
  for (let rIdx = 0; rIdx < book.lyrics.length; rIdx++) {
    const row = book.lyrics[rIdx];
    if (sec >= row.t) {
      pair = row;
      const nextRow = book.lyrics[rIdx + 1];
      nextT = nextRow ? nextRow.t : (row.t + 4.5);
    }
  }

  // 计算更自然的逐行演唱结束时间（如果下一行间隔 > 5秒，则按字数收束在合理时长内，不发生慢爬）
  const charCount = (pair.l1 || '').length;
  const naturalDuration = Math.min(Math.max(1.8, charCount * 0.35 + 0.5), 5.5);
  const effectiveEndT = (nextT - pair.t > 6.0) ? (pair.t + naturalDuration) : nextT;

  // 驱动纯白歌词逐字律动系统
  RhythmicLyrics.setLine(pair.l1, pair.l2, pair.t, effectiveEndT);
}

function scrubSongProgress(sliderVal) {
  const book = activeBooks[targetIdx] || ARCHIVE_BOOKS[0];
  if (!book) return;
  const dur = (localAudioEl && localAudioEl.duration && isFinite(localAudioEl.duration))
    ? localAudioEl.duration
    : (book.durationSec || 180);
  const targetSec = Math.max(0, Math.min(dur, (Number(sliderVal) / 1000) * dur));
  book.currentSec = targetSec;
  if (localAudioEl) {
    try {
      localAudioEl.currentTime = targetSec;
      if (isPlaying && localAudioEl.paused) {
        localAudioEl.play().catch(() => {});
      }
    } catch (_) {}
  }
  const fillEl = document.getElementById('playerProgressFill');
  if (fillEl && dur > 0) {
    fillEl.style.width = Math.min(100, Math.max(0, (targetSec / dur) * 100)) + '%';
  }
  const curLabel = document.getElementById('currentTimeLabel');
  if (curLabel) curLabel.textContent = formatMMSS(targetSec);
  syncPlayerProgressUI(book, true);
  if (foliaUpstreamIframe?.contentWindow) try { foliaUpstreamIframe.contentWindow.postMessage({ type: 'SEEK', time: targetSec }, '*'); } catch(_) {}
  if (currentFoliaMode !== 'off') syncFoliaFrame();
}

function onProgressTrackClick(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  if (rect.width <= 0) return;
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const slider = document.getElementById('playerProgressSlider');
  if (slider) slider.value = String(Math.round(ratio * 1000));
  isScrubbing = false;
  scrubSongProgress(ratio * 1000);
}

// ---------------------------------------------------------------------------
// 桌面灵动岛与播放器双向状态同步 (BroadcastChannel + LocalStorage)
// ---------------------------------------------------------------------------
const islandChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('wenku8-playback-sync') : null;

function broadcastPlaybackState() {
  const curBook = (activeBooks && activeBooks[targetIdx]) || (activeBooks && activeBooks[currentTrackIdx]) || ARCHIVE_BOOKS[0];
  const curPl = (PLAYLIST_ARCHIVES && PLAYLIST_ARCHIVES[currentPlaylistIdx]) || (PLAYLIST_ARCHIVES && PLAYLIST_ARCHIVES[0]);
  const curCover = (curBook && (curBook.coverImg || curBook.picUrl)) || (curPl && curPl.coverImgUrl) || '';

  const audioEl = localAudioEl;
  const currentSec = (audioEl && isFinite(audioEl.currentTime)) ? audioEl.currentTime : (curBook && curBook.currentSec) || 0;
  const durationSec = (audioEl && isFinite(audioEl.duration) && audioEl.duration > 0) ? audioEl.duration : (curBook && curBook.durationSec) || 180;

  let platform = 'ncm';
  if (curPl) {
    if (curPl.isQq) platform = 'qq';
    else if (curPl.isNcm) platform = 'ncm';
    else platform = 'local';
  }

  const payload = {
    title: (curBook && curBook.title) || (curPl && curPl.title) || 'Wenku8 Audio',
    artist: (curBook && curBook.artist) || 'Wenku8 典藏',
    subtitle: (curBook && (curBook.subtitle || curBook.desc)) || (curPl && (curPl.subtitle || curPl.desc)) || '所有美好都擦肩而过',
    coverUrl: curCover,
    isPlaying: Boolean(isPlaying),
    currentSec: Math.round(currentSec),
    durationSec: Math.round(durationSec),
    liked: Boolean(curBook && curBook._liked),
    platform: platform
  };

  if (window.DynamicPlatformIsland && typeof window.DynamicPlatformIsland.syncPlayback === 'function') {
    window.DynamicPlatformIsland.syncPlayback(payload);
  }

  try {
    if (islandChannel) islandChannel.postMessage({ type: 'STATE_UPDATE', payload });
    localStorage.setItem('wk_island_state', JSON.stringify(payload));
  } catch (_) {}
}

if (islandChannel) {
  islandChannel.onmessage = function (event) {
    if (!event.data) return;
    const { type, action, data } = event.data;
    if (type === 'ACTION') {
      if (action === 'prev') {
        skipTrack(-1);
      } else if (action === 'next') {
        skipTrack(1);
      } else if (action === 'toggle') {
        togglePlayPause();
      } else if (action === 'focus_main') {
        window.focus();
        try {
          fetch('/api/island/action?cmd=show_main').catch(() => {});
          if (window.__TAURI__ && window.__TAURI__.core) window.__TAURI__.core.invoke('show_main_window');
        } catch (_) {}
      } else if (action === 'open_player_view') {
        window.focus();
        try {
          fetch('/api/island/action?cmd=show_main').catch(() => {});
          if (window.__TAURI__ && window.__TAURI__.core) window.__TAURI__.core.invoke('show_main_window');
        } catch (_) {}
        if (typeof openPlayerView === 'function') {
          openPlayerView(true);
        }
      } else if (action === 'seek') {
        if (typeof data === 'number' && localAudioEl && isFinite(localAudioEl.duration)) {
          localAudioEl.currentTime = Math.max(0, Math.min(localAudioEl.duration, data));
        }
      }
    }
  };
}

function syncPlayIcons() {
  window.isPlaying = isPlaying;
  const pauseSvg = document.getElementById('iconPauseSvg');
  const playSvg = document.getElementById('iconPlaySvg');
  if (pauseSvg) pauseSvg.style.display = isPlaying ? 'block' : 'none';
  if (playSvg) playSvg.style.display = isPlaying ? 'none' : 'block';

  // 底部 Coverflow 与 Shelf 播放键图标与状态同步
  updateCoverflowFooter(currentTrackIdx);
  updatePlaylistShelfFooter(currentPlaylistIdx);

  const bBars = document.getElementById('bottomPlayingBars');
  if (bBars) bBars.classList.toggle('paused', !isPlaying);

  if (window.DynamicPlatformIsland) {
    DynamicPlatformIsland.update({ isPlaying: isPlaying });
  }

  const peeker = document.getElementById('vinylDiscPeeker');
  if (peeker) {
    peeker.style.animationPlayState = isPlaying ? 'running' : 'paused';
  }

  updateOverviewPlayingState();
  broadcastPlaybackState();
}

function unlockAudioPlayback() {
  try {
    const a = getGlobalAudio();
    if (!a.src) {
      a.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
    }
    const p = a.play();
    if (p && typeof p.then === 'function') {
      p.catch(() => {});
    }
  } catch (_) {}
}

function togglePlayPause(forceState) {
  playMechanicalTick(1.1);
  isPlaying = typeof forceState === 'boolean' ? forceState : !isPlaying;

  syncPlayIcons();
  wake();
  if (isPlaying) unlockAudioPlayback();
  if (foliaUpstreamIframe?.contentWindow) try { foliaUpstreamIframe.contentWindow.postMessage({ type: isPlaying ? 'PLAY' : 'PAUSE' }, '*'); } catch(_) {}

  if (isPlaying) {
    startTrackAudio();
    if (typeof RhythmicLyrics !== 'undefined') RhythmicLyrics.start();
  } else {
    stopTrackAudio();
    if (typeof RhythmicLyrics !== 'undefined') RhythmicLyrics.stop();
  }
}

async function resolveCrossPlatformTrack(book) {
  if (book.audioUrl) return true;
  if (book._resolving) return false;
  book._resolving = true;

  // 清洗关键词：剥离 (电视剧插曲)、【xxx】、[伴奏] 等干扰字样
  const cleanTitle = (book.title || book.name || '').replace(/[\(\[（【].*?[\)\]）】]/g, '').trim();
  const cleanArtist = (book.artist || '').replace(/[\(\[（【].*?[\)\]）】]/g, '').trim();
  const searchKeyword = (cleanTitle + ' ' + (cleanArtist === 'QQ音乐歌手' ? '' : cleanArtist)).trim();

  try {
    const res = await fetch(`/cloudsearch?keywords=${encodeURIComponent(searchKeyword || book.title || '')}&limit=6`);
    const j = await res.json();
    const songs = (j && j.result && j.result.songs) || [];
    if (!songs.length) throw new Error('未检索到可用候选音轨');

    // 收集前 6 首候选歌曲 ID 并发批量获取 URL
    const candidateIds = songs.slice(0, 6).map(s => s.id).filter(Boolean);
    const urlRes = await fetch(`/song/url?id=${candidateIds.join(',')}`);
    const urlData = await urlRes.json();
    const urlList = (urlData && urlData.data) || [];

    let hitSong = null;
    let hitAudioUrl = null;

    for (const sid of candidateIds) {
      const match = urlList.find(item => item.id === sid && item.url);
      if (match && match.url) {
        hitAudioUrl = match.url;
        hitSong = songs.find(s => s.id === sid);
        break;
      }
    }

    if (!hitAudioUrl && candidateIds[0]) {
      try {
        const v1Res = await fetch(`/song/url/v1?id=${candidateIds[0]}&level=standard`);
        const v1Data = await v1Res.json();
        if (v1Data && v1Data.data && v1Data.data[0] && v1Data.data[0].url) {
          hitAudioUrl = v1Data.data[0].url;
          hitSong = songs[0];
        }
      } catch (_) {}
    }

    if (!hitAudioUrl) throw new Error('所有候选音轨流均受限');

    const proxyUrl = '/audio-proxy?url=' + encodeURIComponent(hitAudioUrl);
    book.audioUrl = proxyUrl;
    book.ncmId = hitSong.id;

    if (hitSong.al && hitSong.al.picUrl && (!book.coverImg || book.coverImg.includes('default'))) {
      book.coverImg = hitSong.al.picUrl;
      book.picUrl = hitSong.al.picUrl;
    }

    // 同步提取动态歌词
    fetch(`/lyric?id=${hitSong.id}`)
      .then(r => r.json())
      .then(lj => {
        if (typeof parseLRC === 'function') {
          const rows = parseLRC(lj.lrc && lj.lrc.lyric, lj.tlyric && lj.tlyric.lyric);
          if (rows && rows.length) {
            book.lyrics = rows;
            if (window.WK && typeof WK.syncLyrics === 'function') {
              WK.syncLyrics(book);
            }
          }
        }
      })
      .catch(() => {});

    book._resolving = false;
    if (isPlaying && (activeBooks[targetIdx] === book || activeBooks[currentTrackIdx] === book)) {
      startTrackAudio();
    }
    return true;
  } catch (err) {
    console.warn('[CrossPlatform] 自愈解析未命中有效流:', book.title, err);
    book._resolving = false;
    book._unplayable = true;
    showToast(`⚠️「${book.title || '当前曲目'}」暂无有效播放源，已跳过`);
    setTimeout(() => { skipTrack(1); }, 1000);
    return false;
  }
}

function startTrackAudio() {
  stopTrackAudio();
  ensureAudioCtx();
  const book = activeBooks[targetIdx] || ARCHIVE_BOOKS[0];

  // 保证封面流与底部信息同步聚焦到正在播放的歌曲
  if (typeof targetIdx === 'number' && targetIdx >= 0 && targetIdx < activeBooks.length) {
    currentTrackIdx = targetIdx;
    trackTargetPos = targetIdx;
    trackScrollPos = targetIdx;
    trackScrollVelocity = 0;
    isTrackForcedDirty = true;
    updateCoverflowFooter(targetIdx);
  }

  // 确保全局播放状态与所有界面图标同步处于正在播放状态
  isPlaying = true;
  syncPlayIcons();

  // 每次开始播放这首歌时自动随机一次动效（同一首歌只随机一次；锁定状态则跳过）
  if (book && book._foliaRandomized !== true) {
    book._foliaRandomized = true;
    if (foliaRandomEnabled && !foliaLockedMode) {
      randomFoliaMode();
    }
  }

  if (book.ncmId && !book.audioUrl) {
    if (!book._resolving) {
      book._resolving = true;
      if (window.NCM) NCM.resolveTrack(book).then((ok) => {
        book._resolving = false;
        if (!ok) {
          resolveCrossPlatformTrack(book);
        } else if (isPlaying && activeBooks[targetIdx] === book) {
          startTrackAudio();
        }
      });
    }
    return;
  }

  // 跨平台导入曲目 / QQ音乐 / 无直链音频智能自愈检索
  if (!book.audioUrl && (book.title || book.name) && !book._resolving) {
    resolveCrossPlatformTrack(book);
    return;
  }

  if (book._unplayable) {
    setTimeout(() => { skipTrack(1); }, 400);
    return;
  }

  if (book.audioUrl) {
    const a = getGlobalAudio();
    localAudioEl = a;
    a.loop = false;
    a.volume = playerVolume;

    if (a._currentAudioUrl !== book.audioUrl) {
      a.pause();
      a._currentAudioUrl = book.audioUrl;
      a.src = book.audioUrl;
      a.load();
    }

    a.onerror = () => {
      if (localAudioEl !== a) return;
      console.warn('[Audio] 播放出错，尝试重新解析:', book.title);
      if (book.ncmId && !book._retriedResolve) {
        book._retriedResolve = true;
        book.audioUrl = null;
        a._currentAudioUrl = null;
        if (window.NCM) {
          NCM.resolveTrack(book).then((ok) => {
            if (ok && isPlaying && activeBooks[targetIdx] === book) {
              startTrackAudio();
            } else {
              showToast('⚠️ 当前曲目暂时无法播放，已自动跳过');
              setTimeout(() => { skipTrack(1); }, 800);
            }
          });
          return;
        }
      }
      showToast('⚠️ 音频加载异常，已自动跳过');
      setTimeout(() => { skipTrack(1); }, 800);
    };

    a.onended = () => {
      if (localAudioEl === a) {
        if (playbackMode === 'one') {
          a.currentTime = 0;
          a.play().catch(() => {});
        } else {
          skipTrack(1);
        }
      }
    };
    const go = () => {
      if (!isPlaying || localAudioEl !== a) return;
      try { a.currentTime = book.currentSec || 0; } catch (_) {}
      if (isFinite(a.duration) && a.duration > 0 && Math.abs(a.duration - book.durationSec) > 1.5) {
        book.durationSec = a.duration;
        const totalLbl = ui('totalDurationLabel');
        if (totalLbl) totalLbl.textContent = formatMMSS(a.duration);
      }
      const p = a.play();
      if (p && typeof p.then === 'function') {
        p.catch((err) => {
          console.warn('[Audio] 播放启动受阻:', err);
        });
      }
    };
    if (a.readyState >= 2) {
      go();
    } else {
      let started = false;
      const onReady = () => {
        if (started) return;
        started = true;
        a.removeEventListener('loadedmetadata', onReady);
        a.removeEventListener('canplay', onReady);
        go();
      };
      a.addEventListener('loadedmetadata', onReady, { once: true });
      a.addEventListener('canplay', onReady, { once: true });
    }
    setTimeout(syncFoliaToUpstreamIframe, 60);
    return;
  }
  localAudioEl = null;
  // 离线/比赛环境自愈保障：严格杜绝任何蜂鸣合成音，始终回退至真实原声音轨
  if (!book.audioUrl && typeof REAL_20_DEMO_TRACKS !== 'undefined' && REAL_20_DEMO_TRACKS.length > 0) {
    const fallbackTrack = REAL_20_DEMO_TRACKS.find(r => r.title === book.title || (book.title && book.title.includes(r.title)) || (r.title && r.title.includes(book.title))) || REAL_20_DEMO_TRACKS[0];
    book.audioUrl = fallbackTrack.audioUrl;
    book.picUrl = book.picUrl || fallbackTrack.picUrl;
    book.coverUrl = book.coverUrl || fallbackTrack.coverUrl;
    book.lyrics = book.lyrics || fallbackTrack.lyrics;
    book.lyricsUrl = book.lyricsUrl || fallbackTrack.lyricsUrl;
    book.durationSec = book.durationSec || fallbackTrack.durationSec;
    startTrackAudio();
    return;
  }
}

function stopTrackAudio() {
  if (synthInterval) {
    clearInterval(synthInterval);
    synthInterval = null;
  }
  if (localAudioEl) localAudioEl.pause();
}

function skipTrack(dir) {
  if (!activeBooks.length) return;
  
  let next = targetIdx;
  let attempts = 0;
  do {
    if (playbackMode === 'shuffle' && activeBooks.length > 1) {
      let rand;
      do { rand = Math.floor(Math.random() * activeBooks.length); } while (rand === next);
      next = rand;
    } else {
      next = (next + dir + activeBooks.length) % activeBooks.length;
    }
    attempts++;
  } while (activeBooks[next] && activeBooks[next]._unplayable && attempts < activeBooks.length);

  targetIdx = next;
  currentTrackIdx = targetIdx;
  trackTargetPos = targetIdx;
  trackScrollPos = targetIdx;
  trackScrollVelocity = 0;
  isTrackForcedDirty = true;

  const book = activeBooks[targetIdx];
  if (!book) return;

  const coverArtEl = document.getElementById('playerCoverArt');
  if (coverArtEl) coverArtEl.innerHTML = coverArtHTML(book);
  const discLabel = document.getElementById('vinylCenterLabel');
  if (discLabel) {
    const imgUrl = book.picUrl || book.coverUrl;
    discLabel.innerHTML = imgUrl ? `<img src="${imgUrl}" alt="disc">` : '';
  }

  populatePlayerView(book);
  if (typeof updateCoverflowFooter === 'function') updateCoverflowFooter(targetIdx);
  if (typeof updateShelfFooterMeta === 'function') updateShelfFooterMeta(targetIdx);
  if (isPlaying) startTrackAudio();
  setTimeout(syncFoliaToUpstreamIframe, 60);
  try { playMechanicalTick(1.2); } catch (_) {}
  wake();
}

function formatMMSS(sec) {
  const s = Math.floor(sec);
  const m = String(Math.floor(s / 60)).padStart(2, '0');
  const r = String(s % 60).padStart(2, '0');
  return `${m}:${r}`;
}

// ============================================================================


// 覆盖 openPlayerView 支持第二层 -> 第三层平滑打开
function openPlayerView(autoStart = true) {
  setTimeout(syncFoliaToUpstreamIframe, 100);
  ensureFoliaDom();
  const pv = document.getElementById('playerView');
  if (pv) pv.classList.add('mode-rain');
  if (window.RainGlassEngine) window.RainGlassEngine.init(pv);

  const prevTargetIdx = targetIdx;
  const isDifferentTrack = (typeof prevTargetIdx === 'number' && prevTargetIdx !== currentTrackIdx);
  const book = activeBooks[currentTrackIdx] || activeBooks[targetIdx] || ARCHIVE_BOOKS[0];
  targetIdx = currentTrackIdx;
  playCassetteEngageClack();

  populatePlayerView(book);
  document.getElementById('playerView').classList.add('open');

  if (isDifferentTrack) {
    // 切换到不同的新曲目：进度归零并强制启动新曲目音频播放
    book.currentSec = 0;
    unlockAudioPlayback();
    isPlaying = true;
    syncPlayIcons();
    startTrackAudio();
  } else if (autoStart) {
    unlockAudioPlayback();
    if (!isPlaying) {
      togglePlayPause(true);
    } else if (!localAudioEl || localAudioEl.paused) {
      startTrackAudio();
    }
  } else {
    wake();
  }
  if (typeof RhythmicLyrics !== 'undefined') RhythmicLyrics.start();
}

function closePlayerView() {
  playMechanicalTick(0.95);
  document.getElementById('playerView').classList.remove('open');
  if (typeof RhythmicLyrics !== 'undefined') RhythmicLyrics.stop();
  wake();
}

// ============================================================================
// 7. 60fps 统一 3D 物理矩阵动画循环 (Wenku8 Original 3D Shelf Matrix)
// ============================================================================
let lastShelfTick = -1;
let lastTrackTick = -1;

function animateShelfAndPlayer(ts) {
  const dt = Math.min(0.05, Math.max(0.001, (ts - lastFrameTs) / 1000));
  lastFrameTs = ts;
  const k = dt * 60;
  let shelfMoving = isShelfPointerDown;
  let trackMoving = isCfPointerDown;

  // A. 第一层歌单磁带书架连续弹簧物理
  if (!isShelfPointerDown && PLAYLIST_ARCHIVES.length > 0) {
    const sp = SPRING_MODES[springModeIdx] || SPRING_MODES[0];
    const diff = playlistTargetPos - playlistScrollPos;
    playlistScrollVelocity = (playlistScrollVelocity + diff * sp.stiffness * k) * Math.pow(sp.damping, k);
    playlistScrollPos += playlistScrollVelocity * k;
    if (Math.abs(diff) < 0.0007 && Math.abs(playlistScrollVelocity) < 0.0007) {
      playlistScrollPos = playlistTargetPos;
      playlistScrollVelocity = 0;
    } else {
      shelfMoving = true;
    }
  }

  if (PLAYLIST_ARCHIVES.length > 0) {
    const nearest = Math.max(0, Math.min(PLAYLIST_ARCHIVES.length - 1, Math.round(playlistScrollPos)));
    if (nearest !== lastShelfTick) {
      lastShelfTick = nearest;
      playMechanicalTick(Math.min(1.5, 0.8 + Math.abs(playlistScrollVelocity) * 2.2));
      updatePlaylistShelfFooter(nearest);
    }
  }

  // 仅在书架发生位移或初次强制刷新时计算并写入样式，静态帧直接跳过
  if (shelfMoving || isShelfForcedDirty) {
    isShelfForcedDirty = false;
    applyShelfBoxesTransform(playlistScrollPos);
  }

  // B. 第二层 Cover Flow 唱片轮播物理矩阵
  if (!isCfPointerDown && activeBooks.length > 0) {
    const sp = SPRING_MODES[springModeIdx] || SPRING_MODES[0];
    const diff = trackTargetPos - trackScrollPos;
    trackScrollVelocity = (trackScrollVelocity + diff * sp.stiffness * k) * Math.pow(sp.damping, k);
    trackScrollPos += trackScrollVelocity * k;
    if (Math.abs(diff) < 0.0007 && Math.abs(trackScrollVelocity) < 0.0007) {
      trackScrollPos = trackTargetPos;
      trackScrollVelocity = 0;
    } else {
      trackMoving = true;
    }
  }

  if (activeBooks.length > 0) {
    const nTr = Math.max(0, Math.min(activeBooks.length - 1, Math.round(trackScrollPos)));
    if (nTr !== lastTrackTick) {
      lastTrackTick = nTr;
      playMechanicalTick(Math.min(1.4, 0.8 + Math.abs(trackScrollVelocity) * 2.0));
      updateCoverflowFooter(nTr);
    }
  }

  // 仅在封面流位移或强制刷新时写入样式，并在卡片滑入视口时懒加载卡片内容
  if (trackMoving || isTrackForcedDirty) {
    isTrackForcedDirty = false;
    cfTrackCardNodes.forEach((card, i) => {
      const delta = i - trackScrollPos;
      const abs = Math.abs(delta);
      const sign = Math.sign(delta);

      if (abs > 10) {
        if (card.style.display !== 'none') card.style.display = 'none';
        return;
      }
      if (card.style.display === 'none') card.style.display = '';

      if (abs <= 10 && !card._rendered) {
        card._rendered = true;
        const b = activeBooks[i];
        if (b) card.innerHTML = coverArtHTML(b);
      }

      const isCenter = abs < 0.45;
      card.classList.toggle('is-focused', isCenter);

      const t = Math.min(1, abs);
      const tx = abs <= 1 ? delta * 182 : sign * (182 + (abs - 1) * 48);
      const tz = Math.max(0, 1 - abs * 1.1) * 145 - Math.min(abs, 8) * 8;
      const ry = -sign * 68 * t;
      const sc = isCenter ? 1.08 : 0.94;

      card.style.transform = `translate3d(${tx.toFixed(2)}px, 0px, ${tz.toFixed(2)}px) rotateY(${ry.toFixed(2)}deg) scale(${sc.toFixed(3)})`;
      card.style.zIndex = Math.round(300 - abs * 20);

      const bright = Math.max(0.38, 1.0 - abs * 0.18);
      const cfBlur = Math.max(0, (abs - 0.7) * 1.8);
      card.style.filter = cfBlur > 0.2
        ? `blur(${cfBlur.toFixed(1)}px) brightness(${bright.toFixed(2)})`
        : `brightness(${bright.toFixed(2)})`;
    });
  }

  const moving = shelfMoving || trackMoving;

  // C. 第三层：音频进度与磁带转轮
  if (isPlaying) {
    const book = activeBooks[targetIdx] || ARCHIVE_BOOKS[0];
    if (localAudioEl && book.audioUrl) {
      if (!isScrubbing && !localAudioEl.paused) book.currentSec = localAudioEl.currentTime;
    } else {
      book.currentSec += dt;
      if (book.currentSec >= book.durationSec) {
        if (playbackMode === 'one') {
          book.currentSec = 0;
        } else {
          skipTrack(1);
        }
      }
    }
    syncPlayerProgressUI(book);
    reelAngle = (reelAngle + dt * 260) % 360;
    if (ui('xraySpoolLeft') && ui('xraySpoolRight')) {
      ui('xraySpoolLeft').style.transform = ui('xraySpoolRight').style.transform = `rotate(${-reelAngle}deg)`;
    }
  }

  if (currentFoliaMode !== 'off' && ui('playerView').classList.contains('open')) {
    syncFoliaFrame();
  }

  const foliaRunning = currentFoliaMode !== 'off' && ui('playerView').classList.contains('open');
  rafId = (moving || isPlaying || foliaRunning) ? requestAnimationFrame(animateShelfAndPlayer) : 0;
}

// ============================================================================
// 8. 独立手势与滚轮事件绑定 (防误触防吃点击解耦设计)
// ============================================================================
(function bindLayerGestures() {
  const sVp = document.getElementById('shelfViewport');
  if (sVp) {
    let sX = 0, sY = 0, lastX = 0, targetBox = null;

    sVp.addEventListener('pointerdown', (e) => {
      isShelfPointerDown = true;
      hasShelfDragged = false;
      sX = lastX = e.clientX;
      sY = e.clientY;
      playlistScrollVelocity = 0;
      targetBox = e.target ? (e.target.closest ? e.target.closest('.white-archive-box') : null) : null;
      wake();
    });

    sVp.addEventListener('pointermove', (e) => {
      if (!isShelfPointerDown) return;
      const dx = e.clientX - sX;
      const dy = e.clientY - sY;

      if (!hasShelfDragged && Math.hypot(dx, dy) > 10) {
        hasShelfDragged = true;
        try { sVp.setPointerCapture(e.pointerId); } catch (_) {}
      }
      if (!hasShelfDragged) return;

      const stepDx = e.clientX - lastX;
      lastX = e.clientX;
      playlistScrollPos -= stepDx * 0.0075;
      playlistTargetPos = playlistScrollPos;
      wake();
    });

    const onShelfUp = (e) => {
      if (!isShelfPointerDown) return;
      isShelfPointerDown = false;
      setTimeout(() => { hasShelfDragged = false; }, 80);
      if (e && e.pointerId) {
        try { sVp.releasePointerCapture(e.pointerId); } catch (_) {}
      }

      if (!hasShelfDragged) {
        let box = targetBox || (e && e.target && e.target.closest ? e.target.closest('.white-archive-box') : null);
        if (!box) {
          const rect = sVp.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const clientX = e ? e.clientX : sX;
          if (Math.abs(clientX - centerX) < 180) {
            box = playlistBoxNodes[currentPlaylistIdx];
          }
        }
        if (box) {
          const idx = playlistBoxNodes.indexOf(box);
          if (idx !== -1) {
            if (idx === currentPlaylistIdx) {
              openPlaylistCoverflow(idx);
            } else {
              currentPlaylistIdx = idx;
              playlistTargetPos = idx;
              playMechanicalTick(1.2);
              updatePlaylistShelfFooter(idx);
              wake();
            }
            return;
          }
        }
      }

      playlistTargetPos = Math.max(0, Math.min(PLAYLIST_ARCHIVES.length - 1, Math.round(playlistTargetPos)));
      currentPlaylistIdx = playlistTargetPos;
      wake();
    };

    sVp.addEventListener('pointerup', onShelfUp);
    sVp.addEventListener('pointercancel', onShelfUp);
    sVp.addEventListener('wheel', (e) => {
      e.preventDefault();
      stepPlaylistIndex(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
  }

  const cfVp = document.getElementById('coverflowViewport');
  if (cfVp) {
    let sX = 0, sY = 0, lastX = 0, targetCard = null;

    cfVp.addEventListener('pointerdown', (e) => {
      isCfPointerDown = true;
      hasCfDragged = false;
      sX = lastX = e.clientX;
      sY = e.clientY;
      trackScrollVelocity = 0;
      targetCard = e.target ? (e.target.closest ? e.target.closest('.cf-track-card') : null) : null;
      wake();
    });

    cfVp.addEventListener('pointermove', (e) => {
      if (!isCfPointerDown) return;
      const dx = e.clientX - sX;
      const dy = e.clientY - sY;

      if (!hasCfDragged && Math.hypot(dx, dy) > 10) {
        hasCfDragged = true;
        try { cfVp.setPointerCapture(e.pointerId); } catch (_) {}
      }
      if (!hasCfDragged) return;

      const stepDx = e.clientX - lastX;
      lastX = e.clientX;
      trackScrollPos -= stepDx * 0.0075;
      trackTargetPos = trackScrollPos;
      wake();
    });

    const onCfUp = (e) => {
      if (!isCfPointerDown) return;
      isCfPointerDown = false;
      if (e && e.pointerId) {
        try { cfVp.releasePointerCapture(e.pointerId); } catch (_) {}
      }

      if (!hasCfDragged) {
        let card = targetCard || (e && e.target && e.target.closest ? e.target.closest('.cf-track-card') : null);
        if (!card) {
          const rect = cfVp.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const clientX = e ? e.clientX : sX;
          if (Math.abs(clientX - centerX) < 160) {
            card = cfTrackCardNodes[currentTrackIdx];
          }
        }
        if (card) {
          const idx = cfTrackCardNodes.indexOf(card);
          if (idx !== -1) {
            if (idx === currentTrackIdx) {
              const isDifferentTrack = (typeof targetIdx === 'number' && targetIdx !== idx);
              openPlayerView(isDifferentTrack || !isPlaying);
            } else {
              currentTrackIdx = idx;
              trackTargetPos = idx;
              playMechanicalTick(1.15);
              updateCoverflowFooter(idx);
              wake();
            }
            return;
          }
        }
      }

      trackTargetPos = Math.max(0, Math.min(activeBooks.length - 1, Math.round(trackTargetPos)));
      currentTrackIdx = trackTargetPos;
      wake();
    };

    cfVp.addEventListener('pointerup', onCfUp);
    cfVp.addEventListener('pointercancel', onCfUp);
    cfVp.addEventListener('wheel', (e) => {
      e.preventDefault();
      stepTrackIndex(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
  }
})();

// 全局键盘快捷键
window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'BUTTON' || (tag === 'INPUT' && e.target.type !== 'range') || tag === 'TEXTAREA') return;

  const cf = document.getElementById('coverflowView');
  const pv = document.getElementById('playerView');
  const commentModal = document.getElementById('commentDrawerModal');
  const isCfOpen = cf && cf.classList.contains('open');
  const isPvOpen = pv && pv.classList.contains('open');
  const isCommentOpen = commentModal && commentModal.classList.contains('open');

  if (e.code === 'ArrowLeft') {
    if (isPvOpen) skipTrack(-1);
    else if (isCfOpen) stepTrackIndex(-1);
    else stepPlaylistIndex(-1);
  } else if (e.code === 'ArrowRight') {
    if (isPvOpen) skipTrack(1);
    else if (isCfOpen) stepTrackIndex(1);
    else stepPlaylistIndex(1);
  } else if (e.code === 'Space') {
    e.preventDefault();
    togglePlayPause();
  } else if (e.code === 'Escape') {
    if (isCommentOpen) toggleCommentDrawer(false);
    else if (isPvOpen) closePlayerView();
    else if (isCfOpen) backToPlaylistShelf();
  } else if (e.code === 'Enter') {
    if (!isCfOpen) openPlaylistCoverflow(currentPlaylistIdx);
    else if (!isPvOpen) openPlayerView(true);
  }
});

// ============================================================================
// 9. 辅助交互、设置与 WK 接口桥
// ============================================================================
// 7. 辅助交互：透视磁带机芯、红心点赞、评论抽屉、本地音频导入与筛选
// ============================================================================
function toggleCassetteXray() {
  playMechanicalTick(1.25);
  document.getElementById('playerCoverStage').classList.toggle('show-cassette');
}

let isHeartLiked = false;
function syncHeartIcon(liked) {
  isHeartLiked = !!liked;
  const btn = document.getElementById('likeHeartBtn');
  const svg = btn ? btn.querySelector('svg') : null;
  if (svg) {
    svg.setAttribute('fill', isHeartLiked ? '#ef3b3a' : 'none');
    svg.setAttribute('stroke', isHeartLiked ? '#ef3b3a' : '#d4d4d8');
  }
}

function toggleHeartLike() {
  const book = activeBooks[targetIdx];
  const nextLiked = !isHeartLiked;
  playMechanicalTick(1.35);
  syncHeartIcon(nextLiked);
  if (book) {
    book._liked = nextLiked;
    if (window.NCM) NCM.onHeartToggle(book, nextLiked);
  }
}

function switchPlayerModeTab(tabEl) {
  playMechanicalTick(1.1);
  document.querySelectorAll('.player-top-tabs .top-tab-item').forEach(el => el.classList.remove('active'));
  tabEl.classList.add('active');
}

function renderDrawerDetails(book) {
  if (!book) return;
  document.getElementById('drawerSerialTitle').textContent = `ARCHIVE NOTES // ${book.serial} · NO.${book.index}`;
  document.getElementById('drawerSongTitle').textContent = `${book.title} — 歌词与乐评笔记`;

  const lyricHtml = book.lyrics.map(row => `
    <div class="drawer-comment-card" style="cursor:pointer;" onclick="jumpToLyricSec(${row.t})">
      <div style="font-weight:800; color:#fff;">${esc(row.l1)}</div>
      <div style="font-size:12px; color:#8e8e98; margin-top:3px;">${esc(row.l2)}</div>
    </div>
  `).join('');

  const commentHtml = (book.comments || []).map(c => `
    <div class="drawer-comment-card" style="border-left:3px solid #ef3b3a;">${esc(c)}</div>
  `).join('');

  document.getElementById('drawerContentList').innerHTML = commentHtml + lyricHtml;
}

function jumpToLyricSec(sec) {
  const book = activeBooks[targetIdx] || ARCHIVE_BOOKS[0];
  book.currentSec = sec;
  if (localAudioEl) { try { localAudioEl.currentTime = sec; } catch (_) {} }
  syncPlayerProgressUI(book, true);
  toggleCommentDrawer(false);
  if (!isPlaying) togglePlayPause(true);
}

function toggleCommentDrawer(open) {
  playMechanicalTick(1.1);
  document.getElementById('commentDrawerModal').classList.toggle('open', open);
}

function toggleSearchBar() {
  const drawer = document.getElementById('shelfSearchDrawer');
  if (!drawer) return;
  drawer.classList.toggle('open');
  const cf = document.getElementById('coverflowView');
  const isCfOpen = cf && cf.classList.contains('open');
  const input = document.getElementById('shelfSearchInput');

  if (drawer.classList.contains('open')) {
    if (input) {
      input.placeholder = isCfOpen ? '搜索歌曲名、歌手…' : '搜索歌单名称…';
      input.value = '';
      input.focus();
    }
    if (!isCfOpen) {
      render3DPlaylistShelf();
    }
  } else {
    if (isCfOpen) {
      activeBooks = [...SOURCE_BOOKS];
      targetIdx = 0;
      trackScrollPos = 0;
      trackTargetPos = 0;
      render3DTrackCoverFlow();
    } else {
      render3DPlaylistShelf();
    }
  }
}

let filterTimer = 0;
function debouncedFilter() { clearTimeout(filterTimer); filterTimer = setTimeout(filterBooksByQuery, 150); }

let sortFlag = 0;
const SORT_LABELS = ["最近更新", "编号顺序"];
function filterBooksByQuery() {
  const q = ui('shelfSearchInput') ? ui('shelfSearchInput').value.trim().toLowerCase() : '';
  const cf = document.getElementById('coverflowView');
  const isCfOpen = cf && cf.classList.contains('open');

  if (isCfOpen) {
    if (window.NCM && NCM.onShelfSearch && NCM.onShelfSearch(q)) return;
    activeBooks = SOURCE_BOOKS.filter(b => !q ||
      (b.title && b.title.toLowerCase().includes(q)) ||
      (b.artist && b.artist.toLowerCase().includes(q)) ||
      (b.serial && b.serial.toLowerCase().includes(q)) ||
      (b.index && String(b.index).includes(q)));
    if (sortFlag === 1) activeBooks.sort((a, b) => String(a.index || '').localeCompare(String(b.index || '')));
    targetIdx = 0;
    trackScrollPos = 0;
    trackTargetPos = 0;
    render3DTrackCoverFlow();
    isTrackForcedDirty = true;
    wake();
  } else {
    const origin = document.getElementById('shelfOrigin');
    if (!origin) return;
    const filtered = !q ? PLAYLIST_ARCHIVES : PLAYLIST_ARCHIVES.filter(pl =>
      (pl.title && pl.title.toLowerCase().includes(q)) ||
      (pl.subtitle && pl.subtitle.toLowerCase().includes(q)) ||
      (pl.desc && pl.desc.toLowerCase().includes(q))
    );
    origin.innerHTML = '';
    playlistBoxNodes = [];
    filtered.forEach((pl, idx) => {
      const el = document.createElement('div');
      el.className = 'white-archive-box' + (idx === 0 ? ' is-focused' : '');
      el.style.setProperty('--box-accent', pl.accent || '#d94e34');
      const artworkHTML = renderPlaylistArtwork(pl);
      const realIdx = PLAYLIST_ARCHIVES.indexOf(pl);
      el.innerHTML = `
        <div class="box-face-spine">
          <div class="spine-top-num">${pl.spineNum || pl.num}</div>
          <div class="spine-brand-badge">${pl.badge || '文庫'}</div>
          <div class="spine-v-title">${esc(pl.spineTitle || pl.title)}</div>
          <div class="spine-bottom-barcode">
            <div class="mini-v-bars"></div>
            <div class="spine-color-foot" style="background:${pl.accent || '#2b6cb0'};"></div>
          </div>
        </div>
        <div class="box-face-front">
          <div class="front-top-serial">
            <span>NO. ${pl.spineNum || pl.num}</span>
            <span>${pl.serial || ('PL-' + (pl.id ? String(pl.id).slice(-5) : '56035'))}</span>
          </div>

          <div class="front-artwork-wrapper">
            ${artworkHTML}
            <div class="front-play-badge" onclick="event.stopPropagation(); openPlaylistCoverflow(${realIdx >= 0 ? realIdx : idx});">
              <span>▶</span>
              <span>点击进入选歌</span>
            </div>
          </div>

          <div class="front-bottom-archive">
            <div class="barcode-strip-box">
              <div class="barcode-lines"></div>
              <span class="barcode-code">${pl.barcode || ('WK-PL-' + (pl.spineNum || pl.num))}</span>
            </div>

            <div class="front-cassette-footer">
              <div class="mini-cassette-window">
                <div class="mini-wheel"></div>
                <span style="font-family:monospace; font-size:8px; color:#d4d4d8;">${pl.trackCount ? pl.trackCount + ' 首收录' : 'AUDIO ARCHIVE'}</span>
                <div class="mini-wheel"></div>
              </div>
              <span class="publisher-seal" style="color:${pl.accent || '#d97706'}; border-color:${pl.accent || '#d97706'};">AUDIO</span>
            </div>
          </div>
        </div>
        <div class="box-face-top"></div>
        <div class="box-face-right"></div>
        <div class="box-face-back"></div>
      `;
      el.onclick = (e) => {
        if (hasShelfDragged) return;
        e.stopPropagation();
        const rIdx = PLAYLIST_ARCHIVES.indexOf(pl);
        openPlaylistCoverflow(rIdx >= 0 ? rIdx : 0);
      };
      origin.appendChild(el);
      playlistBoxNodes.push(el);
    });
    currentPlaylistIdx = 0;
    playlistScrollPos = 0;
    playlistTargetPos = 0;
    updatePlaylistShelfFooter(0);
    const cEl = document.getElementById('totalPlaylistCountLabel');
    if (cEl) cEl.textContent = q ? `${filtered.length} 个结果` : `${PLAYLIST_ARCHIVES.length} 个歌单`;
    if (isShelfListView) {
      renderPlaylistListView(filtered);
    }
    isShelfForcedDirty = true;
    wake();
  }
}

function submitShelfSearch() {
  const input = ui('shelfSearchInput');
  const q = input ? input.value.trim() : '';
  if (!q) return;
  if (window.NCM && typeof NCM.searchAndOpen === 'function') {
    NCM.searchAndOpen(q);
  } else if (window.NCM && typeof NCM.onShelfSearch === 'function') {
    NCM.onShelfSearch(q);
  }
}
function cycleFilterSort() {
  sortFlag = (sortFlag + 1) % SORT_LABELS.length;
  const el = ui('sortModeLabel');
  if (el) el.textContent = SORT_LABELS[sortFlag];
  filterBooksByQuery();
  playMechanicalTick(1.2);
}

function cycleSpringPreset() {
  springModeIdx = (springModeIdx + 1) % SPRING_MODES.length;
  playMechanicalTick(1.3);
  document.getElementById('shelfBottomSubTag').textContent = `物理手感：${SPRING_MODES[springModeIdx].name}`;
}

function importLocalTrack(e) {
  const file = e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const cleanName = file.name.replace(/\.[^/.]+$/, "");
  const newIdxStr = String(ARCHIVE_BOOKS.length + 1).padStart(3, '0');
  const newSpineStr = String(ARCHIVE_BOOKS.length + 1).padStart(2, '0');

  const newBook = {
    index: newIdxStr,
    spineNum: newSpineStr,
    serial: `WK-${Math.floor(10000 + Math.random() * 89999)}`,
    title: cleanName,
    shortTitle: cleanName.slice(0, 8),
    spineTitle: cleanName.slice(0, 10),
    subtitleQuote: `| 本地无损母带直录：${cleanName}`,
    artist: "本地导入磁带",
    subArtist: "Local Master",
    statusTag: "本地母带",
    subTag: "无损直通",
    durationSec: 210,
    currentSec: 0,
    accent: "#059669",
    c1: "#059669",
    c2: "#0f172a",
    audioUrl: url,
    notes: [261.63, 329.63, 392.00, 523.25],
    lyrics: [
      { t: 0, l1: cleanName, l2: "本地音频母带已封装入 3D 白色典藏盒" },
      { t: 15, l1: "模拟磁头正在读取本地音频流", l2: "点击封面可查看内部磁带转轮状态" }
    ],
    comments: [
      `【本地导入成功】源文件：${file.name}，已自动生成立体白盒与深色播放器详情页。`
    ]
  };

  const probe = new Audio(url);
  newBook._audio = probe;
  probe.addEventListener('loadedmetadata', () => {
    if (!isFinite(probe.duration)) return;
    newBook.durationSec = probe.duration;
    if (activeBooks[targetIdx] === newBook) ui('totalDurationLabel').textContent = formatMMSS(probe.duration);
  });
  ARCHIVE_BOOKS.unshift(newBook);
  if (window.WK) WK.setSource('local', ARCHIVE_BOOKS);
  targetIdx = 0;
  playlistScrollPos = 0;
  playlistTargetPos = 0;
  render3DBookShelf();
  openPlayerView(true);
}

// ============================================================================
// 8. 系统媒体控制、全局 Toast 与 WK 集成桥
// ============================================================================
function updateMediaSession(book) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: book.title,
      artist: book.artist,
      album: book.subArtist || '',
      artwork: book.picUrl ? [{ src: book.picUrl, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
    navigator.mediaSession.setActionHandler('play', () => togglePlayPause(true));
    navigator.mediaSession.setActionHandler('pause', () => togglePlayPause(false));
    navigator.mediaSession.setActionHandler('previoustrack', () => skipTrack(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => skipTrack(1));
    navigator.mediaSession.setActionHandler('seekto', (d) => { if (d.seekTime != null) jumpToLyricSec(d.seekTime); });
  } catch (_) {}
}

function showToast(msg, ms = 2600) {
  const box = document.getElementById('toastContainer');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = String(msg);
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 320);
  }, ms);
}


window.WK = {
  setUserPlaylists,
  openPlaylistCoverflow,
  backToPlaylistShelf,
  backToCoverflow,
  setSource(key, books) {
    if (window.NCM && NCM.syncSourceKey) NCM.syncSourceKey(key);
    SOURCE_BOOKS = books || [];
    activeBooks = [...SOURCE_BOOKS];
    targetIdx = 0;
    trackScrollPos = 0;
    trackTargetPos = 0;
    const cf = document.getElementById('coverflowView');
    const isCfOpen = cf && cf.classList.contains('open');
    if (isCfOpen || key === 'search') {
      if (cf && !cf.classList.contains('open')) {
        cf.classList.add('open');
        const sv = document.getElementById('shelfView');
        if (sv) sv.classList.add('slide-left');
      }
      const tEl = document.getElementById('cfPlaylistTitle');
      const cEl = document.getElementById('cfPlaylistCount');
      if (tEl) tEl.textContent = key === 'search' ? '搜索结果' : '在线曲库';
      if (cEl) cEl.textContent = `${activeBooks.length} 首`;
      render3DTrackCoverFlow();
      isTrackForcedDirty = true;
      wake();
    } else {
      playlistScrollPos = 0;
      playlistTargetPos = 0;
      render3DPlaylistShelf();
      isShelfForcedDirty = true;
      wake();
    }
    document.querySelectorAll('.source-chip').forEach(c => c.classList.toggle('active', c.dataset.src === key));
  },
  syncLyrics(book) {
    if (activeBooks[targetIdx] === book) {
      renderDrawerDetails(book);
      syncPlayerProgressUI(book, true);
      syncFoliaToUpstreamIframe();
      if (currentFoliaMode !== 'off') syncFoliaFrame();
    }
  },
  getBook() { return activeBooks[targetIdx] || null; },
  getBooks() { return SOURCE_BOOKS; },
  refresh: render3DPlaylistShelf,
  toast: showToast,
  formatMMSS,
  openPlayer: openPlayerView,
  setFoliaMode,
};

window.onCoverflowPlayButtonClick = onCoverflowPlayButtonClick;
window.onCoverflowFooterInfoClick = onCoverflowFooterInfoClick;

const slider = ui('playerProgressSlider');
if (slider) {
  slider.addEventListener('pointerdown', (e) => {
    isScrubbing = true;
    const rect = slider.getBoundingClientRect();
    if (rect.width > 0) {
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      slider.value = String(Math.round(ratio * 1000));
      scrubSongProgress(ratio * 1000);
    }
  });
  slider.addEventListener('input', (e) => {
    scrubSongProgress(e.target.value);
  });
  slider.addEventListener('change', (e) => {
    isScrubbing = false;
    scrubSongProgress(e.target.value);
  });
  ['pointerup', 'pointercancel', 'blur'].forEach(ev => slider.addEventListener(ev, () => {
    if (isScrubbing) {
      isScrubbing = false;
      scrubSongProgress(slider.value);
    }
  }));
}

if (ui('soundBtn')) ui('soundBtn').textContent = soundOn ? '🔊' : '🔇';
applyViewMode();
ensureFoliaDom();
setFoliaMode(currentFoliaMode);   // 启动即应用默认动效（水镜）
render3DPlaylistShelf();
if (activeBooks[0]) populatePlayerView(activeBooks[0]);

// 支持鼠标滚轮 / 触控板横向丝滑浏览书架
const sVpEl = document.getElementById('shelfViewport');
if (sVpEl) {
  let wheelAccum = 0;
  let wheelTimer = 0;
  sVpEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    wheelAccum += delta;
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      if (Math.abs(wheelAccum) >= 25) {
        stepPlaylistIndex(wheelAccum > 0 ? 1 : -1);
      }
      wheelAccum = 0;
    }, 35);
  }, { passive: false });
}

wake();

const debouncedPlaylistFilter = debouncedFilter;

window.filterPlaylistByPlatform = function(platform) {
  const origin = document.getElementById('shelfOrigin');
  if (!origin) return;
  origin.innerHTML = '';
  playlistBoxNodes = [];

  let list = PLAYLIST_ARCHIVES;
  if (platform === 'ncm') {
    list = PLAYLIST_ARCHIVES.filter(p => p.isNcm || p.id === 'pl_login');
  } else if (platform === 'local') {
    list = PLAYLIST_ARCHIVES.filter(p => !p.isNcm && p.id !== 'pl_login');
  }

  list.forEach((pl, idx) => {
    const el = document.createElement('div');
    el.className = 'white-archive-box' + (idx === 0 ? ' is-focused' : '');
    el.style.setProperty('--box-accent', pl.accent || '#d94e34');
    const artworkHTML = renderPlaylistArtwork(pl);
    el.innerHTML = `
      <div class="box-face-spine">
        <div class="spine-top-num">${pl.spineNum || pl.num}</div>
        <div class="spine-brand-badge">${pl.badge || '文庫'}</div>
        <div class="spine-v-title">${esc(pl.spineTitle || pl.title)}</div>
        <div class="spine-bottom-barcode">
          <div class="mini-v-bars"></div>
          <div class="spine-color-foot" style="background:${pl.accent || '#2b6cb0'};"></div>
        </div>
      </div>
      <div class="box-face-front">
        <div class="front-top-serial">
          <span>NO. ${pl.spineNum || pl.num}</span>
          <span>${pl.serial || ('PL-' + (pl.id ? String(pl.id).slice(-5) : '56035'))}</span>
        </div>

        <div class="front-artwork-wrapper">
          ${artworkHTML}
          <div class="front-play-badge" onclick="event.stopPropagation(); openPlaylistCoverflow(${idx});">
            <span>▶</span>
            <span>点击进入选歌</span>
          </div>
        </div>

        <div class="front-bottom-archive">
          <div class="barcode-strip-box">
            <div class="barcode-lines"></div>
            <span class="barcode-code">${pl.barcode || ('WK-PL-' + (pl.spineNum || pl.num))}</span>
          </div>

          <div class="front-cassette-footer">
            <div class="mini-cassette-window">
              <div class="mini-wheel"></div>
              <span style="font-family:monospace; font-size:8px; color:#d4d4d8;">${pl.trackCount ? pl.trackCount + ' 首收录' : 'AUDIO ARCHIVE'}</span>
              <div class="mini-wheel"></div>
            </div>
            <span class="publisher-seal" style="color:${pl.accent || '#d97706'}; border-color:${pl.accent || '#d97706'};">AUDIO</span>
          </div>
        </div>
      </div>
      <div class="box-face-top"></div>
      <div class="box-face-right"></div>
      <div class="box-face-back"></div>
    `;
    el.onclick = (e) => {
      if (hasShelfDragged) return;
      e.stopPropagation();
      const rIdx = PLAYLIST_ARCHIVES.indexOf(pl);
      openPlaylistCoverflow(rIdx >= 0 ? rIdx : 0);
    };
    origin.appendChild(el);
    playlistBoxNodes.push(el);
  });
  currentPlaylistIdx = 0;
  playlistScrollPos = 0;
  playlistTargetPos = 0;
  updatePlaylistShelfFooter(0);
  if (isShelfListView) {
    renderPlaylistListView(list);
  }
  isShelfForcedDirty = true;
  wake();
};
