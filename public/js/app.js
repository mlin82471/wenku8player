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
  const lyricsArray = (book.lyrics && book.lyrics.length) ? book.lyrics.map(l => ({
    t: Number(l.t ?? 0),
    l1: l.l1 || l.text || '',
    l2: l.l2 || '',
    text: l.text || l.l1 || '',
    startTime: Number(l.t ?? 0),
    fullText: l.l1 || l.text || ''
  })) : [];
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

const ARCHIVE_BOOKS = [
  {
    index: "001",
    spineNum: "01",
    serial: "WK-2448D",
    title: "渡 · The Crossing",
    shortTitle: "渡 · 薛之谦",
    spineTitle: "渡 · 在爱情丛林里",
    subtitleQuote: "| 在爱情丛林里，渡过惊涛骇浪",
    artist: "薛之谦",
    subArtist: "惊涛骇浪神",
    statusTag: "母带典藏",
    subTag: "SQ无损 · 2017",
    durationSec: 230,
    currentSec: 80,
    artStyle: "du_crossing",
    accent: "#c93b2b",
    c1: "#8e9094",
    c2: "#1f2024",
    notes: [220, 246.94, 261.63, 293.66, 329.63, 293.66, 261.63, 246.94],
    lyrics: [
      { t: 0,  l1: "渡 · 薛之谦 (The Crossing)", l2: "词：薛之谦 / 曲：Torbjørn Brundtland, Svein Berge" },
      { t: 25, l1: "有人在妥协 有人拼命在狡辩", l2: "人设太可怜 希望你谅解" },
      { t: 55, l1: "都在爱情丛林里 寻找栖息地", l2: "渡过惊涛骇浪 却困在原地" },
      { t: 78, l1: "为情表现到浮夸", l2: "得到了你就该丢下 人性来不及" },
      { t: 118, l1: "得到了你就该丢下 人性来不及", l2: "粉饰太平 渡人渡己" },
      { t: 165, l1: "渡人去的夜 用稀有的火焰", l2: "照亮了胆怯 燃尽了谎言" },
      { t: 205, l1: "尾奏：孤舟划过寒江水墨留白", l2: "模拟母带编号 WK-2448D · 收录于专辑《渡》" }
    ],
    comments: [
      "【热评 @惊涛骇浪神 · 999w+】低沉的电子合成器铺底配上克制的真假音转换，像极了封面里那艘独自穿行在浓雾里的孤舟。",
      "【母带档案 WK-2448D】本曲采用挪威电子组合 Röyksopp 原曲架构改编，立体白盒版完整保留了低频空间混响。"
    ]
  },
  {
    index: "002",
    spineNum: "02",
    serial: "WK-00134",
    title: "挺不错餐馆推理事件簿",
    shortTitle: "餐馆推理事件簿",
    spineTitle: "挺不错餐馆推理事件簿",
    subtitleQuote: "| 甜点上来之前，谜底已经随黑胶转动揭晓",
    artist: "近江泉美 · 室内弦乐团",
    subArtist: "轻小说原声企划",
    statusTag: "已完结",
    subTag: "连载中 · OST",
    durationSec: 215,
    currentSec: 45,
    accent: "#d94e34",
    c1: "#d94e34",
    c2: "#2b1d1a",
    notes: [261.63, 329.63, 392.00, 440.00, 392.00, 329.63, 293.66, 261.63],
    lyrics: [
      { t: 0,  l1: "午后三点的餐馆木门风铃轻响", l2: "主厨擦亮银勺，第一道线索藏在浓汤里" },
      { t: 40, l1: "为情表现到浮夸 不如一杯红茶", l2: "在餐桌转角处 听见怀表滴答" },
      { t: 95, l1: "大提琴拨弦拉出推理的序幕", l2: "真相总在舒芙蕾塌陷前浮出水面" },
      { t: 160, l1: "尾声：打烊后的暖黄壁灯与磁带底噪", l2: "NO. 002 · 轻小说文库联动典藏原声" }
    ],
    comments: [
      "【书友乐评】视频里第一眼看到这个 3D 白色立盒抽出展开封面就爱上了，音乐和轻小说氛围绝配！"
    ]
  },
  {
    index: "003",
    spineNum: "03",
    serial: "WK-08921",
    title: "美丽的黄金之击 · 奏鸣曲",
    shortTitle: "美丽的黄金之击",
    spineTitle: "美丽的黄金之击",
    subtitleQuote: "| 金色聚光灯下，最后一次华丽切分音",
    artist: "古典羽管键琴 / 巴洛克弦乐",
    subArtist: "Baroque Master",
    statusTag: "已完结",
    subTag: "TYPE IV 金属带",
    durationSec: 242,
    currentSec: 64,
    accent: "#d4a017",
    c1: "#ca8a04",
    c2: "#1e1b4b",
    notes: [293.66, 349.23, 440.00, 523.25, 440.00, 349.23, 329.63, 293.66],
    lyrics: [
      { t: 0,  l1: "羽管键琴划破天鹅绒帷幕的寂静", l2: "黄金比例的音阶在穹顶回荡" },
      { t: 50, l1: "华丽到浮夸的巴洛克双声部赋格", l2: "每一颗音符都镌刻在金属母带上" },
      { t: 130, l1: "弦乐齐奏推向命运的顶点", l2: "WK-08921 · 皇家音乐厅同期实录" }
    ],
    comments: [
      "【母带手记】高频泛音极其华丽，配合 3D 白盒书脊上的烫金标签极具收藏感。"
    ]
  },
  {
    index: "004",
    spineNum: "04",
    serial: "WK-04428",
    title: "北海道特殊机密部队「道-MEN」",
    shortTitle: "北海道特殊机密部队",
    spineTitle: "北海道特殊机密部队",
    subtitleQuote: "| 暴风雪中的札幌电台，暗号藏在合成器低音里",
    artist: "Sapporo Synth Lab",
    subArtist: "极北机密电台",
    statusTag: "已完结",
    subTag: "目标吃 · 机密档案",
    durationSec: 198,
    currentSec: 52,
    accent: "#2563eb",
    c1: "#1d4ed8",
    c2: "#0f172a",
    notes: [196.00, 220.00, 261.63, 329.63, 293.66, 261.63, 220.00, 196.00],
    lyrics: [
      { t: 0,  l1: "零下十四度的北海道铁道信号灯", l2: "机密部队的耳机里传来复古调频律动" },
      { t: 45, l1: "穿过暴风雪的夜间特快列车", l2: "模拟鼓机锁定每一道加密声波" },
      { t: 120, l1: "任务代号：在天亮前抵达小樽港", l2: "NO. 004 · WK-04428 档案封存" }
    ],
    comments: [
      "【视频同款 NO.004】完美还原视频第 2 秒抽出的那本北海道机密部队白盒！"
    ]
  },
  {
    index: "005",
    spineNum: "05",
    serial: "WK-01557",
    title: "显生代 · 业之姬与千年回响",
    shortTitle: "业之姬 · 显生代",
    spineTitle: "业之姬",
    subtitleQuote: "| 跨越显生代的漫长孤寂，唯留琴音不灭",
    artist: "Taishang Ambient Ost",
    subArtist: "古卷留声企划",
    statusTag: "已完结",
    subTag: "连载中 · 仙侠古风",
    durationSec: 260,
    currentSec: 90,
    accent: "#7c3aed",
    c1: "#6d28d9",
    c2: "#18181b",
    notes: [174.61, 220.00, 261.63, 293.66, 349.23, 293.66, 220.00, 174.61],
    lyrics: [
      { t: 0,  l1: "千年雪落山门，青铜古钟自鸣", l2: "业之姬立于苍穹之下，翻开命禄古卷" },
      { t: 70, l1: "百世轮回如磁带倒转重开", l2: "纵使万劫不复，亦要渡过这片星海" },
      { t: 150, l1: "洞箫与古琴交织的终局之战", l2: "WK-01557 · 典藏级 CrO₂ 氧化铬母带" }
    ],
    comments: [
      "【视频同款 NO.005】对应视频第 4 秒展开的《业之姬》立体白盒。"
    ]
  },
  {
    index: "006",
    spineNum: "06",
    serial: "WK-03319",
    title: "6和Y的哲学 · 雨夜独白",
    shortTitle: "6和Y的哲学",
    spineTitle: "6和Y的哲学",
    subtitleQuote: "| 雨一直下，在数字与哲学的夹缝里听见心跳",
    artist: "Vintage R&B / Tape Synth",
    subArtist: "孤岛母带室",
    statusTag: "已完结",
    subTag: "90s R&B 慢摇",
    durationSec: 225,
    currentSec: 72,
    accent: "#0d9488",
    c1: "#0f766e",
    c2: "#111827",
    notes: [220.00, 261.63, 329.63, 392.00, 329.63, 293.66, 261.63, 220.00],
    lyrics: [
      { t: 0,  l1: "雨一直下 气氛不算融洽", l2: "6 和 Y 在屋檐下推演命运的解法" },
      { t: 60, l1: "哲学不能解释深夜的思念", l2: "唯有磁带转轮不知疲倦地旋转" }
    ],
    comments: [
      "【听众笔记】书脊上的『6和Y的哲学』字体排印非常有日本文库本的质感。"
    ]
  },
  {
    index: "007",
    spineNum: "07",
    serial: "WK-05102",
    title: "浪漫美少女的美貌一击",
    shortTitle: "浪漫美少女的一击",
    spineTitle: "浪漫美少女的美貌一击",
    subtitleQuote: "| 气泡水与夏日海风，青春的合成器永不落幕",
    artist: "City Pop Summer Band",
    subArtist: "涩谷夏日音像",
    statusTag: "已完结",
    subTag: "City Pop · 1988",
    durationSec: 204,
    currentSec: 38,
    accent: "#ec4899",
    c1: "#db2777",
    c2: "#1f1235",
    notes: [261.63, 311.13, 392.00, 466.16, 392.00, 311.13, 293.66, 261.63],
    lyrics: [
      { t: 0,  l1: "海滨公路的敞篷车掠过夕阳", l2: "卡带机里流淌着八十年代的浪漫放克" },
      { t: 35, l1: "心动只在回眸的一瞬间", l2: "像冰镇汽水冒出的第一串泡沫" }
    ],
    comments: [
      "【复古乐迷】轻快的贝斯线加上立体书盒包装，满满的昭和末期音像店氛围。"
    ]
  },
  {
    index: "008",
    spineNum: "08",
    serial: "WK-07933",
    title: "Schell:Bullet · 银翼弹道",
    shortTitle: "Schell:Bullet",
    spineTitle: "Schell:Bullet",
    subtitleQuote: "| 超音速巡航下的赛博交响，锁定黎明地平线",
    artist: "Cyberpunk Orchestra",
    subArtist: "シェル・ブリット",
    statusTag: "已完结",
    subTag: "连载中 · 机械交响",
    durationSec: 248,
    currentSec: 110,
    accent: "#16a34a",
    c1: "#15803d",
    c2: "#090d16",
    notes: [146.83, 185.00, 220.00, 293.66, 277.18, 220.00, 185.00, 146.83],
    lyrics: [
      { t: 0,  l1: "シェル・ブリット // 银翼划破夜空", l2: "脉冲合成器与管弦乐团正面交锋" },
      { t: 95, l1: "在弹道尽头听见机械心脏的轰鸣", l2: "NO. 008 · WK-07933 原版引进母带" }
    ],
    comments: [
      "【视频同款 NO.008】完美复刻视频第 3 秒展示的《Schell:Bullet》黑白绿配色书盒！"
    ]
  },
  {
    index: "009",
    spineNum: "09",
    serial: "WK-06210",
    title: "便利店兄弟 · 凌晨两点关东煮",
    shortTitle: "便利店兄弟",
    spineTitle: "便利店兄弟",
    subtitleQuote: "| 城市睡着之后，24小时便利店还亮着暖光",
    artist: "Midnight Lo-Fi Beats",
    subArtist: "街角夜话电台",
    statusTag: "已完结",
    subTag: "Lo-Fi 治愈夜曲",
    durationSec: 192,
    currentSec: 60,
    accent: "#ea580c",
    c1: "#ea580c",
    c2: "#1c1917",
    notes: [220.00, 277.18, 329.63, 415.30, 329.63, 277.18, 246.94, 220.00],
    lyrics: [
      { t: 0,  l1: "自动门叮咚一声迎进夜归的人", l2: "关东煮的热气模糊了玻璃橱窗" },
      { t: 50, l1: "耳机里放着最温柔的慢拍爵士", l2: "平凡日子里的微光最抚凡人心" }
    ],
    comments: [
      "【视频同款 NO.009】视频第 6 秒抽出的《便利店兄弟》同款立体盒！"
    ]
  },
  {
    index: "010",
    spineNum: "10",
    serial: "WK-09980",
    title: "轻小说实验メンタル · 终章",
    shortTitle: "实验メンタル",
    spineTitle: "轻小说实验メンタル",
    subtitleQuote: "| 把未竟的故事录进磁带B面，留待明日重听",
    artist: "Wenku8 Sound Lab",
    subArtist: "文库终章企划",
    statusTag: "已完结",
    subTag: "概念母带 · Vol.10",
    durationSec: 236,
    currentSec: 85,
    accent: "#4f46e5",
    c1: "#4338ca",
    c2: "#0f172a",
    notes: [261.63, 293.66, 329.63, 392.00, 523.25, 392.00, 329.63, 261.63],
    lyrics: [
      { t: 0,  l1: "实验编号 010：声波与文字的共振实验", l2: "当书页合上时，旋律仍在耳畔延绵" },
      { t: 75, l1: "感谢每一次驻足聆听的你", l2: "WK-09980 · Wenku8 Audio Archive 完结篇" }
    ],
    comments: [
      "【馆藏结语】十盒立体白盒整齐列队，左右滑动时的棘轮机械声与弹簧阻尼感让人欲罢不能。"
    ]
  }
];

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
        "l1": "飞翔之时 便已下定决心",
        "l2": "目标是那片蔚蓝的天空"
      },
      {
        "t": 25,
        "l1": "还未曾领略过的「悲伤」 如今已经渐渐懂得",
        "l2": "甚至连这拥抱着的「苦痛」 都要化为前行的力量"
      },
      {
        "t": 55,
        "l1": "从那沉睡的世界中苏醒 展开耀眼的羽翼",
        "l2": "为了追寻那片纯澈的苍穹 振翅高飞吧"
      },
      {
        "t": 90,
        "l1": "破茧而出的那阵狂风 吹散了所有迷茫",
        "l2": "如果展翅飞翔 就不再回头"
      },
      {
        "t": 140,
        "l1": "尾奏：疾风吹拂过木叶村的天空",
        "l2": "火影忍者疾风传 典藏纪念原声 // WK-REAL-01"
      }
    ],
    "comments": [
      "【热评 @木叶飞舞之处】前奏口琴一响，整整十年的青春与热血瞬间在眼前呼啸而过！"
    ]
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
        "l1": "如果这一切都只是一场梦 那该有多好",
        "l2": "至今依然在梦中追寻着你的身影"
      },
      {
        "t": 30,
        "l1": "宛如洗净柠檬般 留下了苦涩而清冽的香气",
        "l2": "在降下倾盆大雨之前 都不愿离开"
      },
      {
        "t": 65,
        "l1": "无论经历了怎样的至暗时刻",
        "l2": "胸口依然会隐隐作痛"
      },
      {
        "t": 105,
        "l1": "如今你依然是照亮我生命的那束光",
        "l2": "在黑暗中引领我走向破晓"
      }
    ],
    "comments": [
      "【热评 @法医三澄】即使逝去的人无法再开口，音乐依然会在每个清晨温柔拂过。"
    ]
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
        "l1": "故事的小黄花 从出生那年就飘着",
        "l2": "童年的荡秋千 随记忆一直晃到现在"
      },
      {
        "t": 35,
        "l1": "为你翘课的那一天 花落的那一天",
        "l2": "教室的那一间 我怎么看不见"
      },
      {
        "t": 75,
        "l1": "消失的下雨天 我好想再淋一遍",
        "l2": "没想到失去的勇气我还留着"
      },
      {
        "t": 115,
        "l1": "从前从前 有个人爱你很久",
        "l2": "但偏偏 风渐渐 把距离吹得好远"
      }
    ],
    "comments": [
      "【热评 @网易云音乐】200万评论的起点，一整代人的青春纪念册。"
    ]
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
        "l1": "窗外的麻雀 在电线杆上多嘴",
        "l2": "你说这一句 很有夏天的感觉"
      },
      {
        "t": 32,
        "l1": "手中的铅笔 在纸上来来回回",
        "l2": "我用几行字形容你是我的谁"
      },
      {
        "t": 65,
        "l1": "秋刀鱼的滋味 猫跟你都想了解",
        "l2": "初恋的香味就这样被我们寻回"
      },
      {
        "t": 100,
        "l1": "雨下整夜 我的爱溢出就像雨水",
        "l2": "院子落叶 跟我的思念厚厚一叠"
      }
    ],
    "comments": [
      "【热评 @稻田间的风】前奏的风铃一响，整个夏天就再也没有结束。"
    ]
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
        "l1": "一群嗜血的蚂蚁 被腐肉所吸引",
        "l2": "我面无表情 看孤独的风景"
      },
      {
        "t": 35,
        "l1": "失去你 泪水成霜",
        "l2": "我为你弹奏萧邦的夜曲 纪念我死去的爱情"
      },
      {
        "t": 75,
        "l1": "跟夜风一样的声音 心碎的很好听",
        "l2": "手在键盘敲很轻 我给的思念很小心"
      },
      {
        "t": 120,
        "l1": "为你弹奏肖邦的夜曲 纪念我死去的爱情",
        "l2": "十一月的萧邦 · 典藏母带 // WK-REAL-05"
      }
    ],
    "comments": [
      "【热评 @金曲奖台下】夜曲一响，上台领奖！当年横扫各大音乐奖项的真正神作。"
    ]
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
        "l1": "这一路上走走停停 顺着少年漂流的痕迹",
        "l2": "迈出车站的前一刻 竟有些犹豫"
      },
      {
        "t": 40,
        "l1": "不禁笑这近乡情怯 仍无可避免",
        "l2": "而长野的天 依旧那么暖 风吹起了从前"
      },
      {
        "t": 85,
        "l1": "从前初识这世间 万般流连",
        "l2": "看着天边似在眼前 也甘愿赴汤蹈火去走它一遍"
      },
      {
        "t": 140,
        "l1": "如今走过这世间 遍体鳞伤",
        "l2": "翻过岁月不同侧脸 措不及防闯入你的笑颜"
      }
    ],
    "comments": [
      "【热评 @青春渡口】起风了，唯有努力生存；风停了，我们依然在路上。"
    ]
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
        "l1": "你是 岁月长河 星火燃起的光茫",
        "l2": "你是 千万人中 守护家园的肩膀"
      },
      {
        "t": 38,
        "l1": "如果说 你曾苦过我的甜",
        "l2": "我愿活成你的愿"
      },
      {
        "t": 75,
        "l1": "山河无恙 烟火寻常",
        "l2": "可是你如愿的眺望"
      },
      {
        "t": 125,
        "l1": "孩子们 奔跑在洒满阳光的路上",
        "l2": "这盛世如你所愿"
      }
    ],
    "comments": [
      "【热评 @星空下的守望】王菲天籁般的嗓音，唱尽了三代人的深情与时代的变迁。"
    ]
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
        "l1": "海浪无声将夜幕深深淹没",
        "l2": "漫过天空尽头的角落"
      },
      {
        "t": 30,
        "l1": "大鱼在梦境的缝隙里游过",
        "l2": "凝望你沉睡的轮廓"
      },
      {
        "t": 70,
        "l1": "看海天一色 听风起雨落",
        "l2": "执子手吹散苍茫茫烟波"
      },
      {
        "t": 120,
        "l1": "怕你飞远去 怕你离我而去",
        "l2": "更怕你永远停留在这里"
      }
    ],
    "comments": [
      "【热评 @南冥有鱼】周深的空灵声线如同海浪拂过心头，将东方古典意境渲染得淋漓尽致。"
    ]
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
        "l1": "拦路雨偏似雪花 白整整的落下来",
        "l2": "怎么可相信这是冬天的开始"
      },
      {
        "t": 35,
        "l1": "要拥有必先懂失去怎接受",
        "l2": "曾沿着雪路浪游 为何为好事泪流"
      },
      {
        "t": 75,
        "l1": "谁都只得那双手 靠拥抱亦难任你拥有",
        "l2": "要拥有必先懂失去怎接受"
      },
      {
        "t": 120,
        "l1": "何不把悲哀感觉 假设是来自你虚构",
        "l2": "试管里找不到它染污眼眸"
      }
    ],
    "comments": [
      "【热评 @林夕词话】谁能凭爱意将富士山私有？唯有学会放下，才能真正拥抱生活。"
    ]
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
        "l1": "时光穿不断 流转在从前",
        "l2": "刻骨的变迁 始料未及的容颜"
      },
      {
        "t": 35,
        "l1": "喝不完的酒 斟不满此生遗憾",
        "l2": "跨不过的坎 回忆在梦里泛滥"
      },
      {
        "t": 75,
        "l1": "回头看 不曾走远",
        "l2": "依依目光 此生不换"
      },
      {
        "t": 120,
        "l1": "难料爱恨纠缠 生死相伴",
        "l2": "仙剑奇侠传三 绝版插曲 // WK-REAL-10"
      }
    ],
    "comments": [
      "【热评 @蜀山之巅】茂茂割肉、龙葵跳炉、紫萱白头……这首歌一响，仙剑三的泪水根本止不住。"
    ]
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
        "l1": "从那个夏日的海边 传来海浪拍打的声响",
        "l2": "夕阳沉入地平线 天空染上了淡淡绯红"
      },
      {
        "t": 40,
        "l1": "升空的花火 在夜空中无声绽放",
        "l2": "照亮了你仰望夜空时的清澈侧脸"
      },
      {
        "t": 85,
        "l1": "如果时光能够倒流 回到那个晴朗的午后",
        "l2": "直到光芒散落成漫天繁星"
      }
    ],
    "comments": [
      "【热评 @花火大会】夏天的遗憾，总是在这首歌响起的瞬间被温柔抚平。"
    ]
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
        "l1": "就像残酷的天使一样",
        "l2": "少年啊 成为神话吧"
      },
      {
        "t": 35,
        "l1": "苍蓝的风如今正在敲打心房的门扉",
        "l2": "只凝视着我的你 露出了平静微笑"
      },
      {
        "t": 75,
        "l1": "即使被悲伤的命运所束缚",
        "l2": "请展开那双由纯真编织的羽翼"
      },
      {
        "t": 120,
        "l1": "去冲破时空的束缚 成为永恒的传奇",
        "l2": "新世纪福音战士 典藏母带 // WK-REAL-12"
      }
    ],
    "comments": [
      "【热评 @初号机暴走】当红色警报响起，弦乐与电吉他齐鸣，这就是动漫史上无法超越的开篇！"
    ]
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
        "l1": "与你在八月末的约定 对未来的希冀",
        "l2": "无法忘怀的梦想 都在心底悄悄珍藏"
      },
      {
        "t": 40,
        "l1": "相信在十年后的八月 我们还能再次相遇",
        "l2": "怀揣着那份最美好的记忆"
      },
      {
        "t": 85,
        "l1": "奔跑在夏日的秘密基地里 泪水模糊了视线",
        "l2": "找到你了 面码！"
      }
    ],
    "comments": [
      "【热评 @超和平Busters】面码，找到你了！听到这首歌眼泪就完全不受控制。"
    ]
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
        "t": 0,
        "l1": "放开那束紧闭的锁链 冲破前方的迷雾",
        "l2": "让跃动的电流 在指尖绽放出最耀眼的光芒"
      },
      {
        "t": 35,
        "l1": "在这个由谎言编织的世界里 寻找属于自己的真实",
        "l2": "唯有心中的信念 绝不动摇"
      },
      {
        "t": 75,
        "l1": "Only my railgun can shoot it 放手一搏吧",
        "l2": "击穿一切阻挡在眼前的黑暗"
      }
    ],
    "comments": [
      "【热评 @学园都市Lv5】你指尖跃动的电光，是我此生不灭的信仰，唯我超电磁炮永世长存！"
    ]
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
        "l1": "化作一只翩翩起舞的蝴蝶 乘着微风展翅高飞",
        "l2": "现在就立刻 飞向你的身旁"
      },
      {
        "t": 35,
        "l1": "在无限大的梦想背后 纵使是空无一物的世界",
        "l2": "只要还有勇气 就能破茧而出"
      },
      {
        "t": 75,
        "l1": "Stay しがちな 僕の心も",
        "l2": "振动无形羽翼 飞跃不可逾越的高山"
      }
    ],
    "comments": [
      "【热评 @被选召的孩子】飞帽杀出现的那一刻，我们都知道童年结束了，但勇气永远留在了心中。"
    ]
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
        "t": 0,
        "l1": "在漫长黑夜中 紧握那柄誓约之剑",
        "l2": "无论受到何种伤痛 都不曾停下脚步"
      },
      {
        "t": 45,
        "l1": "Brave Shine 照亮这片残破的世界",
        "l2": "愿这份光芒 成为跨越绝望的救赎"
      }
    ],
    "comments": [
      "【热评 @无限剑制】卫宫士郎与红A信念对决时的神曲，Aimer 独特的沙哑嗓音把史诗感拉满了！"
    ]
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
        "l1": "强くなれる理由を知った 僕を連れて進め",
        "l2": "得知了能够变坚强的理由 带领着我向前迈进吧"
      },
      {
        "t": 30,
        "l1": "即使泥泞不堪 也要紧握手中的日轮刀",
        "l2": "照亮黑暗中那些微弱的祈愿"
      },
      {
        "t": 75,
        "l1": "红莲之花在严寒中傲然盛放",
        "l2": "将所有磨难 熔铸为不可摧毁的钢铁意志"
      }
    ],
    "comments": [
      "【热评 @水之呼吸】听到前奏炭治郎踏雪而行的脚步声，瞬间热血沸腾！"
    ]
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
        "l1": "感受停在我发端的指尖 如何瞬间 冻结时间",
        "l2": "记住望着我坚定的双眼 也许已经 没有明天"
      },
      {
        "t": 35,
        "l1": "面对浩瀚的星海 我们微小得像尘埃",
        "l2": "我们还没好好地相爱 怎能轻易认输离开"
      },
      {
        "t": 75,
        "l1": "缘分让我们相遇乱世以外 命运却要我们危难中相爱",
        "l2": "也许未来遥远在光年之外 我愿守候等待"
      }
    ],
    "comments": [
      "【热评 @星际穿越】邓紫棋极具穿透力的高音，把茫茫宇宙中彼此唯一依托的宿命感演绎得荡气回肠。"
    ]
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
        "l1": "对这个世界如果你有太多的抱怨 跌倒了 就不敢继续往前走",
        "l2": "为什么 人要这么的脆弱 堕落"
      },
      {
        "t": 30,
        "l1": "请你打开电视看看 多少人为生命在努力勇敢的走下去",
        "l2": "我们是不是该知足 珍惜一切 就算没有拥有"
      },
      {
        "t": 65,
        "l1": "还记得你说家是唯一的城堡 随着稻香河流继续奔跑",
        "l2": "微微笑 小时候的梦我知道"
      },
      {
        "t": 105,
        "l1": "不要哭 让萤火虫带着你逃跑 乡间的歌谣永远的依靠",
        "l2": "回家吧 回到最初的美好"
      }
    ],
    "comments": [
      "【热评 @田埂上的风】无论在大城市受了多少委屈，听这首歌就像回到了无忧无虑的乡下外婆家。"
    ]
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
        "l1": "塞纳河畔 左岸的咖啡",
        "l2": "我手一杯 品尝你的美 留下唇印的嘴"
      },
      {
        "t": 28,
        "l1": "花店玫瑰 名字写错谁",
        "l2": "告白气球 风吹过街角 飞过香榭丽舍的街"
      },
      {
        "t": 60,
        "l1": "亲爱的 爱上你 从那天起 甜蜜的很轻易",
        "l2": "亲爱的 别任性 你的眼睛 在说我愿意"
      },
      {
        "t": 100,
        "l1": "拥有你就拥有 全世界",
        "l2": "亲爱的 别任性 你的眼睛 在说我愿意"
      }
    ],
    "comments": [
      "【热评 @左岸咖啡馆】轻快俏皮的吉他与鼓点，把法式浪漫和心动的微甜描绘得惟妙惟肖。"
    ]
  }
];

const ACG_DEMO_TRACKS = [
  {
    index: "011",
    spineNum: "01",
    serial: "WK-ACG-01",
    title: "青鸟 (ブルーバード)",
    shortTitle: "青鸟 · 火影",
    spineTitle: "青鸟 · 生物股长",
    subtitleQuote: "| 飞向那片纯澈的苍穹，只为展翅翱翔",
    artist: "いきものがかり (生物股长)",
    subArtist: "火影忍者疾风传 OP3",
    statusTag: "ACG神曲",
    subTag: "高燃 · OP3",
    durationSec: 216,
    currentSec: 0,
    accent: "#2563eb",
    c1: "#3b82f6",
    c2: "#1e3a8a",
    picUrl: "assets/covers/cover_01.jpg",
    notes: [329.63, 392.00, 440.00, 493.88, 523.25, 493.88, 440.00, 392.00],
    lyrics: [
      { t: 0, l1: "飞翔之时 便已下定决心", l2: "目标是那片蔚蓝的天空" },
      { t: 25, l1: "还未曾领略过的「悲伤」 如今已经渐渐懂得", l2: "甚至连这拥抱着的「苦痛」 都要化为前行的力量" },
      { t: 55, l1: "从那沉睡的世界中苏醒 展开耀眼的羽翼", l2: "为了追寻那片纯澈的苍穹 振翅高飞吧" },
      { t: 90, l1: "破茧而出的那阵狂风 吹散了所有迷茫", l2: "如果展翅飞翔 就不再回头" },
      { t: 140, l1: "尾奏：疾风吹拂过木叶村的天空", l2: "火影忍者疾风传 典藏纪念原声 // WK-ACG-01" }
    ],
    comments: ["【热评 @木叶飞舞之处】前奏口琴一响，整整十年的青春与热血瞬间在眼前呼啸而过！"]
  },
  {
    index: "012",
    spineNum: "02",
    serial: "WK-ACG-02",
    title: "Lemon",
    shortTitle: "Lemon · 米津玄师",
    spineTitle: "Lemon · 非自然死亡",
    subtitleQuote: "| 如今你依然是照亮我生命的那道光",
    artist: "米津玄师",
    subArtist: "非自然死亡 Unnatural 主题曲",
    statusTag: "殿堂金曲",
    subTag: "流行殿堂 · 2018",
    durationSec: 255,
    currentSec: 0,
    accent: "#eab308",
    c1: "#fde047",
    c2: "#713f12",
    picUrl: "assets/covers/cover_02.jpg",
    notes: [261.63, 293.66, 329.63, 349.23, 392.00, 349.23, 329.63, 293.66],
    lyrics: [
      { t: 0, l1: "如果这一切都只是一场梦 那该有多好", l2: "至今依然在梦中追寻着你的身影" },
      { t: 30, l1: "宛如洗净柠檬般 留下了苦涩而清冽的香气", l2: "在降下倾盆大雨之前 都不愿离开" },
      { t: 65, l1: "无论经历了怎样的至暗时刻", l2: "胸口依然会隐隐作痛" },
      { t: 105, l1: "如今你依然是照亮我生命的那束光", l2: "在黑暗中引领我走向破晓" }
    ],
    comments: ["【热评 @法医三澄】即使逝去的人无法再开口，音乐依然会在每个清晨温柔拂过。"]
  },
  {
    index: "013",
    spineNum: "03",
    serial: "WK-ACG-03",
    title: "残酷天使的行动纲领",
    shortTitle: "残酷天使 · 高桥洋子",
    spineTitle: "残酷天使 · EVA",
    subtitleQuote: "| 少年啊，去成为神话吧",
    artist: "高桥洋子",
    subArtist: "新世纪福音战士 EVA OP",
    statusTag: "史诗神作",
    subTag: "EVA · 1995",
    durationSec: 245,
    currentSec: 0,
    accent: "#9333ea",
    c1: "#a855f7",
    c2: "#3b0764",
    picUrl: "assets/covers/cover_12.jpg",
    notes: [440.00, 493.88, 523.25, 587.33, 659.25, 587.33, 523.25, 440.00],
    lyrics: [
      { t: 0, l1: "就像残酷的天使一样", l2: "少年啊 成为神话吧" },
      { t: 35, l1: "苍蓝的风如今正在敲打心房的门扉", l2: "只凝视着我的你 露出了平静微笑" },
      { t: 75, l1: "即使被悲伤的命运所束缚", l2: "请展开那双由纯真编织的羽翼" },
      { t: 120, l1: "去冲破时空的束缚 成为永恒的传奇", l2: "新世纪福音战士 典藏母带 // WK-ACG-03" }
    ],
    comments: ["【热评 @初号机暴走】当红色警报响起，弦乐与电吉他齐鸣，这就是动漫史上无法超越的开篇！"]
  },
  {
    index: "014",
    spineNum: "04",
    serial: "WK-ACG-04",
    title: "打上花火",
    shortTitle: "打上花火 · 烟花",
    spineTitle: "打上花火 · 米津玄师",
    subtitleQuote: "| 盛放的花火，是否无论从何处看都绚烂",
    artist: "DAOKO × 米津玄师",
    subArtist: "动画电影《烟花》主题曲",
    statusTag: "夏日物语",
    subTag: "夏夜烟火",
    durationSec: 289,
    currentSec: 0,
    accent: "#f43f5e",
    c1: "#fb7185",
    c2: "#4c0519",
    notes: [293.66, 329.63, 392.00, 440.00, 493.88, 440.00, 392.00, 329.63],
    lyrics: [
      { t: 0, l1: "从那个夏日的海边 传来海浪拍打的声响", l2: "夕阳沉入地平线 天空染上了淡淡绯红" },
      { t: 40, l1: "升空的花火 在夜空中无声绽放", l2: "照亮了你仰望夜空时的清澈侧脸" },
      { t: 85, l1: "如果时光能够倒流 回到那个晴朗的午后", l2: "直到光芒散落成漫天繁星" }
    ],
    comments: ["【热评 @花火大会】夏天的遗憾，总是在这首歌响起的瞬间被温柔抚平。"]
  },
  {
    index: "015",
    spineNum: "05",
    serial: "WK-ACG-05",
    title: "Brave Shine",
    shortTitle: "Brave Shine · Aimer",
    spineTitle: "Brave Shine · Fate",
    subtitleQuote: "| 守护你直到终焉的破晓",
    artist: "Aimer",
    subArtist: "Fate/stay night [UBW] OP2",
    statusTag: "高燃燃系",
    subTag: "Fate系列",
    durationSec: 232,
    currentSec: 0,
    accent: "#d97706",
    c1: "#f59e0b",
    c2: "#451a03",
    notes: [329.63, 349.23, 392.00, 440.00, 523.25, 440.00, 392.00, 349.23],
    lyrics: [
      { t: 0, l1: "在漫长黑夜中 紧握那柄誓约之剑", l2: "无论受到何种伤痛 都不曾停下脚步" },
      { t: 45, l1: "Brave Shine 照亮这片残破的世界", l2: "愿这份光芒 成为跨越绝望的救赎" },
      { t: 95, l1: "破晓之时 胜利的钟声将为谁敲响", l2: "Fate/stay night [UBW] 典藏原声" }
    ],
    comments: ["【热评 @无限剑制】Aimer 独特的沙哑声线配合红 A 转身的背影，燃到头皮发麻！"]
  },
  {
    index: "016",
    spineNum: "06",
    serial: "WK-ACG-06",
    title: "secret base ~君がくれたもの~",
    shortTitle: "secret base · 未闻花名",
    spineTitle: "secret base · 那朵花",
    subtitleQuote: "| 与你在盛夏相遇的约定，十年后的八月依然坚信",
    artist: "本间芽衣子 / 安城鸣子 / 鹤见知利子",
    subArtist: "未闻花名 ED",
    statusTag: "催泪经典",
    subTag: "治愈 · 催泪",
    durationSec: 350,
    currentSec: 0,
    accent: "#10b981",
    c1: "#34d399",
    c2: "#064e3b",
    notes: [261.63, 329.63, 392.00, 440.00, 392.00, 329.63, 293.66, 261.63],
    lyrics: [
      { t: 0, l1: "与你在盛夏告别的约定 刻在秘密基地斑驳的墙上", l2: "十年后的八月 相信我们还能再次相逢" },
      { t: 45, l1: "夏日祭典的绚烂花火 照亮了你泛红的面容", l2: "直到最后 依然想对你说一声「谢谢」" },
      { t: 100, l1: "在那朵花盛开的山坡上 永远铭记最初的笑容", l2: "我们仍未知道那天所看见的花的名字" }
    ],
    comments: ["【热评 @面码】面码，找到你了！每一次前奏响起来都忍不住眼眶发热。"]
  },
  {
    index: "017",
    spineNum: "07",
    serial: "WK-ACG-07",
    title: "only my railgun",
    shortTitle: "only my railgun · 超炮",
    spineTitle: "超电磁炮 · fripSide",
    subtitleQuote: "| 指尖跃动的电光，是我此生不变的信仰",
    artist: "fripSide",
    subArtist: "某科学的超电磁炮 OP1",
    statusTag: "燃系巅峰",
    subTag: "超跑 OP1",
    durationSec: 257,
    currentSec: 0,
    accent: "#06b6d4",
    c1: "#22d3ee",
    c2: "#083344",
    notes: [440.00, 523.25, 587.33, 659.25, 698.46, 659.25, 587.33, 523.25],
    lyrics: [
      { t: 0, l1: "指尖跃动的电光 是我此生不变的信仰", l2: "唯我超电磁炮永世长存" },
      { t: 35, l1: "穿梭于学园都市的黎明 冲破沉睡的地平线", l2: "所有的犹豫 都化作贯穿现实的银币" },
      { t: 80, l1: "照亮前路的 不仅仅是耀眼的雷光", l2: "还有心中誓死捍卫的珍贵羁绊" }
    ],
    comments: ["【热评 @炮姐】你指尖跃动的电光，是我此生不变的信仰，唯我超电磁炮永世长存！"]
  },
  {
    index: "018",
    spineNum: "08",
    serial: "WK-ACG-08",
    title: "Butter-Fly",
    shortTitle: "Butter-Fly · 和田光司",
    spineTitle: "Butter-Fly · 数码宝贝",
    subtitleQuote: "| 化作飞舞的蝴蝶，乘着微风展翅翱翔",
    artist: "和田光司",
    subArtist: "数码宝贝大冒险 OP",
    statusTag: "童年信仰",
    subTag: "数码宝贝 OP",
    durationSec: 258,
    currentSec: 0,
    accent: "#f97316",
    c1: "#fb923c",
    c2: "#431407",
    notes: [293.66, 329.63, 369.99, 440.00, 493.88, 440.00, 369.99, 329.63],
    lyrics: [
      { t: 0, l1: "好想化作一只振翅高飞的蝴蝶 乘着微风去看未知的明天", l2: "不用在乎路途遥远 只要心中还怀揣着滚烫梦想" },
      { t: 40, l1: "无限大的梦想之后 是空无一物的世界", l2: "只要伸出双手 就能触碰彩虹的温度" },
      { t: 90, l1: "飞帽杀响起的时候 青春永远不散场", l2: "致敬和田光司先生 // 永远的数码宝贝" }
    ],
    comments: ["【热评 @被选召的孩子】飞帽杀出现的那一秒，我们所有人都长大了，但数码世界永远都在。"]
  }
];

const POP_DEMO_TRACKS = [
  {
    index: "021",
    spineNum: "01",
    serial: "WK-POP-01",
    title: "此生不换",
    shortTitle: "此生不换 · 仙剑三",
    spineTitle: "此生不换 · 青鸟飞鱼",
    subtitleQuote: "| 喝不完忘川水，也难断三生缘",
    artist: "青鸟飞鱼",
    subArtist: "电视剧《仙剑奇侠传三》插曲",
    statusTag: "仙剑经典",
    subTag: "仙侠原声",
    durationSec: 265,
    currentSec: 0,
    accent: "#059669",
    c1: "#10b981",
    c2: "#022c22",
    picUrl: "assets/covers/cover_10.jpg",
    notes: [261.63, 293.66, 329.63, 392.00, 440.00, 392.00, 329.63, 261.63],
    lyrics: [
      { t: 0, l1: "时光穿梭 如流星般划过茫茫夜空", l2: "喝不完忘川水 也难断三生缘" },
      { t: 35, l1: "回头看 不曾走远 依依目光此生不换", l2: "难料爱恨痴缠 问世间谁能看淡" },
      { t: 75, l1: "这一刻回眸 便是三生三世的诺言", l2: "仙剑奇侠传三 经典插曲 // WK-POP-01" }
    ],
    comments: ["【热评 @蜀山客】景天、雪见、长卿、紫萱、龙葵、茂茂……前奏一出全是眼泪。"]
  },
  {
    index: "022",
    spineNum: "02",
    serial: "WK-POP-02",
    title: "七里香",
    shortTitle: "七里香 · 周杰伦",
    spineTitle: "七里香 · 浪漫盛夏",
    subtitleQuote: "| 雨下整夜，我的爱溢出就像雨水",
    artist: "周杰伦",
    subArtist: "华语流行黄金时代",
    statusTag: "流行巅峰",
    subTag: "周董经典",
    durationSec: 299,
    currentSec: 0,
    accent: "#16a34a",
    c1: "#22c55e",
    c2: "#14532d",
    notes: [329.63, 369.99, 440.00, 493.88, 554.37, 493.88, 440.00, 369.99],
    lyrics: [
      { t: 0, l1: "窗外的麻雀 在电线杆上多嘴", l2: "你说这一句 很有夏天的感觉" },
      { t: 35, l1: "手中的铅笔 在纸上来来回回", l2: "我用几行字形容你是我的谁" },
      { t: 75, l1: "雨下整夜 我的爱溢出就像雨水", l2: "院子落叶 跟我的思念厚厚一叠" }
    ],
    comments: ["【热评 @夏天风】2004年的夏天，微风、单车、MP3里的《七里香》，那是最好的青春。"]
  },
  {
    index: "023",
    spineNum: "03",
    serial: "WK-POP-03",
    title: "晴天",
    shortTitle: "晴天 · 周杰伦",
    spineTitle: "晴天 · 青春记忆",
    subtitleQuote: "| 从前从前，有个人爱你很久",
    artist: "周杰伦",
    subArtist: "专辑《叶惠美》典藏曲",
    statusTag: "青春记忆",
    subTag: "校园民谣",
    durationSec: 269,
    currentSec: 0,
    accent: "#0284c7",
    c1: "#38bdf8",
    c2: "#0c4a6e",
    notes: [261.63, 329.63, 392.00, 440.00, 392.00, 329.63, 293.66, 261.63],
    lyrics: [
      { t: 0, l1: "故事的小黄花 从出生那年就飘着", l2: "童年的荡秋千 随记忆一直晃到现在" },
      { t: 35, l1: "刮风这天 我试过握着你手", l2: "但偏偏 雨渐渐 大到我看你不见" },
      { t: 75, l1: "还要多久 我才能在你身边", l2: "等到放晴那天 也许我会比较好一点" }
    ],
    comments: ["【热评 @网易云百万评】网易云评论数突破200万的传奇神作，前奏木吉他一扫，全校都在合唱。"]
  },
  {
    index: "024",
    spineNum: "04",
    serial: "WK-POP-04",
    title: "起风了",
    shortTitle: "起风了 · 买辣椒也用券",
    spineTitle: "起风了 · 逆光飞翔",
    subtitleQuote: "| 从前初识这世间，万般流连，也甘愿赴汤蹈火去走它一遍",
    artist: "买辣椒也用券",
    subArtist: "翻唱高桥优《ヤキモチ》",
    statusTag: "治愈高燃",
    subTag: "万人合唱",
    durationSec: 325,
    currentSec: 0,
    accent: "#0d9488",
    c1: "#2dd4bf",
    c2: "#134e4a",
    notes: [329.63, 392.00, 440.00, 493.88, 587.33, 493.88, 440.00, 392.00],
    lyrics: [
      { t: 0, l1: "这一路上走走停停 顺着少年漂流的痕迹", l2: "迈出车站的前一刻 竟有些犹豫" },
      { t: 35, l1: "我曾难自拔于世界之大 也沉溺于其中梦话", l2: "不得真假 不做挣扎 不惧笑话" },
      { t: 80, l1: "我曾将青春翻涌成她 也曾指尖弹出盛夏", l2: "心之所动 且就随缘去吧" }
    ],
    comments: ["【热评 @毕业生】高考结束那个下午，全班一起唱这首歌，风吹过教室窗帘的刹那，我们毕业了。"]
  },
  {
    index: "025",
    spineNum: "05",
    serial: "WK-POP-05",
    title: "如愿",
    shortTitle: "如愿 · 王菲",
    spineTitle: "如愿 · 盛世所愿",
    subtitleQuote: "| 愿不枉啊这个时代，山河无恙，盛世如愿",
    artist: "王菲",
    subArtist: "电影《我和我的父辈》主题曲",
    statusTag: "天籁之音",
    subTag: "盛世如愿",
    durationSec: 268,
    currentSec: 0,
    accent: "#c026d3",
    c1: "#e879f9",
    c2: "#4a044e",
    notes: [261.63, 293.66, 349.23, 392.00, 440.00, 392.00, 349.23, 261.63],
    lyrics: [
      { t: 0, l1: "你是 岁月长河 星火点亮的长街", l2: "此生未完成的歌 由我来续写" },
      { t: 40, l1: "你是我之所来 也是我心之所向", l2: "世间所有美好 终将如你所愿" },
      { t: 85, l1: "这盛世 如你所愿", l2: "电影《我和我的父辈》主题曲 // 典藏母带" }
    ],
    comments: ["【热评 @百年山河】王菲空灵又深情的声线，把几代人的付出与当下的幸福唱得让人热泪盈眶。"]
  },
  {
    index: "026",
    spineNum: "06",
    serial: "WK-POP-06",
    title: "夜曲",
    shortTitle: "夜曲 · 周杰伦",
    spineTitle: "夜曲 · 肖邦夜曲",
    subtitleQuote: "| 为你弹奏肖邦的夜曲，纪念我死去的爱情",
    artist: "周杰伦",
    subArtist: "专辑《十一月的萧邦》",
    statusTag: "暗黑抒情",
    subTag: "金曲之夜",
    durationSec: 226,
    currentSec: 0,
    accent: "#475569",
    c1: "#64748b",
    c2: "#0f172a",
    notes: [220.00, 261.63, 293.66, 329.63, 392.00, 329.63, 293.66, 220.00],
    lyrics: [
      { t: 0, l1: "一群嗜血的蚂蚁 被腐肉所吸引", l2: "我面无表情 看孤独的风景" },
      { t: 30, l1: "为你弹奏肖邦的夜曲 纪念我死去的爱情", l2: "跟夜风一样的声音 心碎的很好听" },
      { t: 70, l1: "手在键盘敲很轻 我给的思念太小心", l2: "你埋葬的地方叫幽冥" }
    ],
    comments: ["【热评 @十一月的萧邦】夜曲一响，上台领奖！当年横扫各大颁奖礼的巅峰说唱神作。"]
  },
  {
    index: "027",
    spineNum: "07",
    serial: "WK-POP-07",
    title: "富士山下",
    shortTitle: "富士山下 · 陈奕迅",
    spineTitle: "富士山下 · 林夕词",
    subtitleQuote: "| 谁都只得那双手，靠拥抱亦难任你拥有",
    artist: "陈奕迅",
    subArtist: "词：林夕 / 曲：Christopher Chak",
    statusTag: "粤语巅峰",
    subTag: "林夕经典",
    durationSec: 261,
    currentSec: 0,
    accent: "#4b5563",
    c1: "#6b7280",
    c2: "#111827",
    notes: [261.63, 329.63, 392.00, 440.00, 392.00, 329.63, 293.66, 261.63],
    lyrics: [
      { t: 0, l1: "拦路雨偏似雪花 白整整的落满地", l2: "谁能凭爱意要富士山私有" },
      { t: 35, l1: "何不把悲哀感觉 假设是在北海道旅游", l2: "想听你听过的歌 看你看过的风景" },
      { t: 75, l1: "谁都只得那双手 靠拥抱亦难任你拥有", l2: "要拥有必先懂失去怎接受" }
    ],
    comments: ["【热评 @港乐风】你想拥有富士山，最好的办法不是把它搬回家，而是走到它面前，再走开。"]
  },
  {
    index: "028",
    spineNum: "08",
    serial: "WK-POP-08",
    title: "大鱼",
    shortTitle: "大鱼 · 周深",
    spineTitle: "大鱼 · 大鱼海棠",
    subtitleQuote: "| 怕你飞远去，怕你离我而去，更怕你永远停留在这里",
    artist: "周深",
    subArtist: "电影《大鱼海棠》印象曲",
    statusTag: "空灵唯美",
    subTag: "国漫天籁",
    durationSec: 313,
    currentSec: 0,
    accent: "#0ea5e9",
    c1: "#38bdf8",
    c2: "#0369a1",
    notes: [261.63, 293.66, 329.63, 392.00, 523.25, 392.00, 329.63, 261.63],
    lyrics: [
      { t: 0, l1: "海浪无声将夜幕深深淹没", l2: "漫过天空尽头的角落" },
      { t: 40, l1: "大鱼在梦境的缝隙里游过", l2: "凝望你沉睡的轮廓" },
      { t: 85, l1: "看海天一色 听风起雨落", l2: "执子手吹散苍茫茫烟波" }
    ],
    comments: ["【热评 @椿与湫】周深的声音就像是海浪推着星光，把最深处的孤独与温柔抚慰得一干二净。"]
  }
];

const CYBER_DEMO_TRACKS = [
  {
    index: "031",
    spineNum: "01",
    serial: "WK-CYBER-01",
    title: "Neon Horizon · 霓虹地平线",
    shortTitle: "Neon Horizon",
    spineTitle: "Neon Horizon · 合成波",
    subtitleQuote: "| 疾驰在雨夜立交桥上的复古合成器浪潮",
    artist: "Synthwave Master",
    subArtist: "赛博朋克合成器浪潮",
    statusTag: "电音动效",
    subTag: "RetroWave",
    durationSec: 218,
    currentSec: 0,
    accent: "#ec4899",
    c1: "#f472b6",
    c2: "#831843",
    notes: [220.00, 277.18, 329.63, 440.00, 554.37, 440.00, 329.63, 220.00],
    lyrics: [
      { t: 0, l1: "雨夜立交桥上 霓虹灯光在反光车窗上拉出长长的光轨", l2: "模拟合成器音阶在 80 年代的复古回声中穿梭" },
      { t: 45, l1: "低保真底噪混合着鼓机节拍 冲破雨雾的束缚", l2: "电子声学实验编号 031 // Folia 极光驱动" }
    ],
    comments: ["【动效推荐】配上 Folia 矩阵代码流或极光动效，视觉与重低音节拍完美同频！"]
  },
  {
    index: "032",
    spineNum: "02",
    serial: "WK-CYBER-02",
    title: "Cyber Pulse · 仿生律动",
    shortTitle: "Cyber Pulse",
    spineTitle: "Cyber Pulse · 仿生人",
    subtitleQuote: "| 仿生人会梦见电子羊吗？神经回路的重低音振荡",
    artist: "Neural Link",
    subArtist: "重低音神经回路脉冲",
    statusTag: "重低音",
    subTag: "Bass Boost",
    durationSec: 204,
    currentSec: 0,
    accent: "#8b5cf6",
    c1: "#a78bfa",
    c2: "#4c1d95",
    notes: [164.81, 220.00, 261.63, 329.63, 392.00, 329.63, 261.63, 164.81],
    lyrics: [
      { t: 0, l1: "神经回路的重低音振荡 唤醒了仿生记忆体", l2: "硅基生命的脉搏 在 120 BPM 的节奏下苏醒" },
      { t: 50, l1: "数据流通过光纤交汇 形成意识的拓扑网络", l2: "WK-CYBER-02 · 声波矩阵实验室" }
    ],
    comments: ["【视听联动】在播放页切换到声波粒子动效，可以看到低音下潜时粒子向四周剧烈扩散！"]
  },
  {
    index: "033",
    spineNum: "03",
    serial: "WK-CYBER-03",
    title: "Deep Void · 水镜深渊",
    shortTitle: "Deep Void",
    spineTitle: "Deep Void · 水镜专属",
    subtitleQuote: "| 极简环境氛围低频，专为水镜视觉倒影打造",
    artist: "Folia Ambient Lab",
    subArtist: "水镜倒影环境氛围音",
    statusTag: "动效原声",
    subTag: "水镜专属",
    durationSec: 240,
    currentSec: 0,
    accent: "#06b6d4",
    c1: "#22d3ee",
    c2: "#164e63",
    notes: [196.00, 246.94, 293.66, 392.00, 493.88, 392.00, 293.66, 196.00],
    lyrics: [
      { t: 0, l1: "水镜倒影涟漪泛起 宁静的深海低频在暗处流淌", l2: "每一次音符滑落 都在水面上荡开一层虚无微波" },
      { t: 60, l1: "沉浸在无尽的声学真空之中 聆听自己的呼吸", l2: "Folia 水镜动效联动典藏音轨" }
    ],
    comments: ["【动效绝配】右键切换为水镜模式，水面波纹会随着这首歌的低音缓缓扩散，禅意十足。"]
  },
  {
    index: "034",
    spineNum: "04",
    serial: "WK-CYBER-04",
    title: "Matrix Glitch · 矩阵裂变",
    shortTitle: "Matrix Glitch",
    spineTitle: "Matrix Glitch · 代码流",
    subtitleQuote: "| 终端黑客的代码流雨，电子故障艺术节拍",
    artist: "Terminal Hacker",
    subArtist: "Glitch Hop / Cyber IDM",
    statusTag: "故障艺术",
    subTag: "Glitch Hop",
    durationSec: 195,
    currentSec: 0,
    accent: "#10b981",
    c1: "#34d399",
    c2: "#064e3b",
    notes: [261.63, 311.13, 392.00, 466.16, 523.25, 466.16, 392.00, 261.63],
    lyrics: [
      { t: 0, l1: "01001000 01100101 01101100 01101100 01101111", l2: "绿色字符在黑曜石荧幕上垂直倾泻" },
      { t: 40, l1: "故障合成器瞬间切断时间轴 触发量子跃迁", l2: "矩阵代码流专属背景节拍" }
    ],
    comments: ["【黑客帝国同款】进入 Folia 矩阵模式，满屏绿色代码雨和这首故障电音完美结合！"]
  },
  {
    index: "035",
    spineNum: "05",
    serial: "WK-CYBER-05",
    title: "Subzero Echo · 极光回响",
    shortTitle: "Subzero Echo",
    spineTitle: "Subzero Echo · 极光冷感",
    subtitleQuote: "| 北欧极光冷感环境音，漫步冻土苔原的风声",
    artist: "Nordic Chimes",
    subArtist: "极地冷感氛围乐",
    statusTag: "极地冷感",
    subTag: "Ambient Chimes",
    durationSec: 236,
    currentSec: 0,
    accent: "#38bdf8",
    c1: "#7dd3fc",
    c2: "#075985",
    notes: [329.63, 392.00, 493.88, 587.33, 659.25, 587.33, 493.88, 329.63],
    lyrics: [
      { t: 0, l1: "零下三十度的极地荒原 极光在永夜的苍穹舒卷", l2: "冰晶摩擦发出空灵的微响 宛如群星的私语" },
      { t: 55, l1: "声波穿透冰川冻土 留下一串轻盈的回声", l2: "WK-CYBER-05 · 极光视觉动效专属" }
    ],
    comments: ["【深夜静心】适合深夜独处或写代码时听，极其空灵通透，让人瞬间冷静下来。"]
  },
  {
    index: "036",
    spineNum: "06",
    serial: "WK-CYBER-06",
    title: "Quantum Drift · 量子漂移",
    shortTitle: "Quantum Drift",
    spineTitle: "Quantum Drift · 全景漫游",
    subtitleQuote: "| 太空漫游全景声，星舰跃迁引擎启动",
    artist: "Astro Sound",
    subArtist: "全景空间声学漫游",
    statusTag: "空间全景",
    subTag: "Space Ambient",
    durationSec: 215,
    currentSec: 0,
    accent: "#f43f5e",
    c1: "#fb7185",
    c2: "#881337",
    notes: [246.94, 293.66, 369.99, 440.00, 493.88, 440.00, 369.99, 246.94],
    lyrics: [
      { t: 0, l1: "星际飞船引擎启动 穿过小行星带的引力透镜", l2: "全景空间声学定位 感受来自银河悬臂的脉冲星信号" },
      { t: 45, l1: "在虚空中漂移 见证超新星爆发的壮丽余晖", l2: "声波与文字共振实验 · 空间站终章" }
    ],
    comments: ["【全景声体验】闭上眼睛戴上耳机，能清晰感受到声波从左耳平滑漫游至右耳的空间定位！"]
  }
];

let activeBooks = [...ARCHIVE_BOOKS];
let SOURCE_BOOKS = ARCHIVE_BOOKS;
let targetIdx = 0;

// ============================================================================
// 2. 双层解耦架构核心：歌单书库与封面流
// ============================================================================
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
    tracks: REAL_20_DEMO_TRACKS
  },
  {
    id: "pl_demo_ost",
    num: "01",
    spineNum: "01",
    serial: "WK-OST-01",
    barcode: "WK-OST-01",
    title: "文库8典藏原声 · 轻小说联动企划",
    shortTitle: "文库8典藏原声",
    spineTitle: "文库8典藏原声",
    subtitle: "收录《渡》与文库8十部经典轻小说专属主题曲与声学母带",
    desc: "收录《渡》与文库8十部经典轻小说专属主题曲与声学母带，配备全景空间声场",
    coverImgUrl: null,
    trackCount: ARCHIVE_BOOKS.length,
    accent: "#d94e34",
    badge: "文库8",
    tracks: ARCHIVE_BOOKS
  },
  {
    id: "pl_demo_acg",
    num: "02",
    spineNum: "02",
    serial: "WK-ACG-02",
    barcode: "WK-ACG-02",
    title: "ACG 巅峰神曲 · 燃系与治愈",
    shortTitle: "ACG 巅峰神曲",
    spineTitle: "ACG 巅峰神曲",
    subtitle: "火影《青鸟》/ 米津玄师《Lemon》/ EVA《残酷天使》等 8 首必听神曲",
    desc: "跨越时代的动漫原声神曲典藏，触动每一次热血与泪目的经典共鸣",
    coverImgUrl: "assets/covers/cover_box_acg.jpg",
    trackCount: ACG_DEMO_TRACKS.length,
    accent: "#2563eb",
    badge: "ACG",
    tracks: ACG_DEMO_TRACKS
  },
  {
    id: "pl_demo_pop",
    num: "03",
    spineNum: "03",
    serial: "WK-POP-03",
    barcode: "WK-POP-03",
    title: "华语经典 · 时代金曲典藏",
    shortTitle: "华语流行金曲",
    spineTitle: "华语流行金曲",
    subtitle: "周杰伦《七里香》《晴天》/ 仙剑《此生不换》/《起风了》华语流行精选",
    desc: "刻录青春岁月里的旋律记忆，高品质母带级声场还原",
    coverImgUrl: "assets/covers/cover_box_pop.jpg",
    trackCount: POP_DEMO_TRACKS.length,
    accent: "#059669",
    badge: "流行",
    tracks: POP_DEMO_TRACKS
  },
  {
    id: "pl_demo_cyber",
    num: "04",
    spineNum: "04",
    serial: "WK-CYBER-04",
    barcode: "WK-CYBER-04",
    title: "赛博朋克 × 电子声学实验室",
    shortTitle: "赛博电子声学",
    spineTitle: "赛博电子声学",
    subtitle: "Folia 视觉动效专属电音 · 水镜 / 矩阵 / 极光深度音频驱动",
    desc: "专为水镜、矩阵、声波粒子 12 种 Folia 视觉动效打造的电子声学脉冲原声",
    coverImgUrl: null,
    trackCount: CYBER_DEMO_TRACKS.length,
    accent: "#7c3aed",
    badge: "电音",
    tracks: CYBER_DEMO_TRACKS
  },
  {
    id: "pl_login",
    num: "05",
    spineNum: "05",
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
      const allPool = [
        ...ARCHIVE_BOOKS,
        ...ACG_DEMO_TRACKS,
        ...POP_DEMO_TRACKS,
        ...CYBER_DEMO_TRACKS
      ];
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
let overviewExpandedPlaylists = { 'pl_demo_ost': true, 'pl_demo_acg': false, 'pl_demo_pop': false, 'pl_demo_cyber': false };
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

  // 驱动纯白歌词逐字律动系统
  RhythmicLyrics.setLine(pair.l1, pair.l2, pair.t, nextT);
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

  noteStep = 0;
  const notes = (book && book.notes && book.notes.length) ? book.notes : [261.63, 293.66, 329.63, 392.00, 440.00, 392.00, 329.63, 261.63];
  synthInterval = setInterval(() => {
    if (!isPlaying) return;
    const freq = notes[noteStep % notes.length];
    const now = audioCtx.currentTime;

    // 主旋律高音 (清脆八音盒音色)
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.linearRampToValueAtTime(freq * 1.003, now + 0.25);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.08 * playerVolume, now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.45);
    osc.connect(gain);
    gain.connect(analyserNode || audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.46);

    // 辅音和弦与温暖低音 (提供沉浸频响，驱动动效波形)
    if (noteStep % 2 === 0) {
      const bassOsc = audioCtx.createOscillator();
      const bassGain = audioCtx.createGain();
      bassOsc.type = 'triangle';
      bassOsc.frequency.setValueAtTime(freq * 0.5, now);
      bassGain.gain.setValueAtTime(0.001, now);
      bassGain.gain.linearRampToValueAtTime(0.05 * playerVolume, now + 0.08);
      bassGain.gain.exponentialRampToValueAtTime(0.0005, now + 0.9);
      bassOsc.connect(bassGain);
      bassGain.connect(analyserNode || audioCtx.destination);
      bassOsc.start(now);
      bassOsc.stop(now + 0.9);
    }

    // 虚拟播放进度步进与歌词/动效同步
    book.currentSec = (book.currentSec || 0) + 0.46;
    if (book.durationSec && book.currentSec >= book.durationSec) {
      if (playbackMode === 'one') {
        book.currentSec = 0;
      } else {
        skipTrack(1);
        return;
      }
    }
    const elLbl = ui('elapsedTimeLabel');
    if (elLbl) elLbl.textContent = formatMMSS(book.currentSec);
    const progBar = ui('playerProgressBar');
    if (progBar && book.durationSec) {
      progBar.style.width = Math.min(100, (book.currentSec / book.durationSec) * 100) + '%';
    }

    noteStep++;
  }, 460);
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
