/**
 * folium-runtime.js — 完整 Folium 1.8 插件生态运行时
 * 完美支持 8 大 Mod 插件深度运行与挂载：
 * 1. visualizer52hz (52Hz 鲸鱼声场动效 - Pixi.js)
 * 2. sample-aurora-visualizer (虹光/极光流光歌词动效)
 * 3. vinyl-disc (经典实体黑胶唱片与唱臂动效)
 * 4. sample-progress-bar (进度条灵动图层、分段标记与书签)
 * 5. k3panel (K3Panel 商籁 11 项深度精调旋钮)
 * 6. halo-lyric (Halo 机械齿轮点阵与 HaloBridge 桥接)
 * 7. lyric-ai-director (AI 歌词运镜导演)
 * 8. lyric-ai-director-plus (AI 歌词导演 Plus 参数面板与动态运镜)
 */
(function (global) {
  'use strict';

  // ===== 1. 播放器底层状态获取 =====
  function getActiveBook() {
    if (global.WK && global.WK.getBook) return global.WK.getBook();
    if (global.activeBooks && global.targetIdx !== undefined) return global.activeBooks[global.targetIdx];
    return null;
  }

  function getPlaybackSec() {
    var b = getActiveBook();
    if (b && typeof b.currentSec === 'number') return b.currentSec;
    var audio = global.currentAudioEl || document.getElementById('nativeAudioTrack');
    if (audio && !isNaN(audio.currentTime)) return audio.currentTime;
    return 0;
  }

  function getPlaybackDuration() {
    var b = getActiveBook();
    if (b && typeof b.durationSec === 'number' && b.durationSec > 0) return b.durationSec;
    var audio = global.currentAudioEl || document.getElementById('nativeAudioTrack');
    if (audio && !isNaN(audio.duration) && audio.duration > 0) return audio.duration;
    return 240;
  }

  function isAudioPlaying() {
    if (typeof global.isPlaying !== 'undefined') return !!global.isPlaying;
    var audio = global.currentAudioEl || document.getElementById('nativeAudioTrack');
    return audio ? !audio.paused : false;
  }

  // 标准化歌词行（生成逐字时间轴 words，让 52Hz 与 极光 产生水波纹与点亮效果）
  function getNormalizedLyrics() {
    var b = getActiveBook();
    var raw = (b && b.lyrics) ? b.lyrics : [];
    if (!raw || !raw.length) {
      return [{
        index: 0,
        fullText: '✦ 正在播放 ✦ ' + (b ? b.title : 'Wenku8 Audio'),
        startTime: 0,
        endTime: 9999,
        words: [{ text: b ? b.title : 'Wenku8', startTime: 0, endTime: 9999 }],
        translation: b ? b.artist : ''
      }];
    }

    return raw.map(function (item, idx) {
      var start = item.t || 0;
      var next = raw[idx + 1];
      var end = next ? next.t : start + 6.0;
      if (end <= start) end = start + 3.0;

      var text = item.l1 || item.text || '';
      var chars = Array.from(text);
      var duration = Math.max(0.001, end - start);
      var charSpan = duration / Math.max(1, chars.length);

      var words = chars.map(function (c, cIdx) {
        return {
          text: c,
          startTime: start + charSpan * cIdx,
          endTime: start + charSpan * (cIdx + 1)
        };
      });

      return {
        index: idx,
        fullText: text,
        startTime: start,
        endTime: end,
        words: words,
        translation: item.l2 || ''
      };
    });
  }

  function getSongMetadata() {
    var b = getActiveBook() || {};
    return {
      id: b.id || 'track-0',
      title: b.title || '未知曲目',
      artist: b.artist || '未知艺术家',
      album: b.subTag || '文库轻小说原声',
      cover: b.picUrl || b.coverUrl || '',
      duration: getPlaybackDuration()
    };
  }

  // ===== 2. 插件注册表工厂 =====
  function createRegistry(name) {
    var map = {};
    return {
      name: name,
      register: function (item) {
        if (!item || !item.id) return { unregister: function () {} };
        map[item.id] = item;
        // 别名机制 (保证 52hz/rings, aurora/aurora-text, vinyl-disc/disc 双向互认)
        if (item.id === 'rings') map['52hz'] = item;
        if (item.id === '52hz') map['rings'] = item;
        if (item.id === 'aurora-text') map['aurora'] = item;
        if (item.id === 'aurora') map['aurora-text'] = item;
        if (item.id === 'disc') map['vinyl-disc'] = item;
        if (item.id === 'vinyl-disc') map['disc'] = item;
        if (item.id === 'halo-lyric') map['halo'] = item;
        if (item.id === 'k3panel') map['sonnet'] = item;

        console.log('[Folium Registry] ' + name + ' registered:', item.id);
        emit('registry:' + name, item);
        return {
          id: item.id,
          unregister: function () {
            delete map[item.id];
          }
        };
      },
      get: function (id) {
        return map[id];
      },
      list: function () {
        var seen = {};
        var res = [];
        for (var k in map) {
          var item = map[k];
          if (item && !seen[item.id]) {
            seen[item.id] = true;
            res.push(item);
          }
        }
        return res;
      }
    };
  }

  var registries = {
    visualizers: createRegistry('visualizers'),
    settingsSections: createRegistry('settingsSections'),
    tunings: createRegistry('tunings'),
    progressLayers: createRegistry('progressLayers'),
    controlButtons: createRegistry('controlButtons'),
    styles: createRegistry('styles'),
    commands: createRegistry('commands'),
    playerPanelTabs: createRegistry('playerPanelTabs')
  };

  // 处理 styles 注册，自动挂载 CSS
  registries.styles.register = (function (orig) {
    return function (spec) {
      if (spec && spec.css) {
        var styleEl = document.createElement('style');
        styleEl.id = 'folium-style-' + spec.id;
        styleEl.textContent = spec.css;
        document.head.appendChild(styleEl);
      }
      return orig(spec);
    };
  })(registries.styles.register);

  // ===== 3. 事件与通信总线 =====
  var eventBus = {};
  function emit(ev, data) {
    var cbs = eventBus[ev] || [];
    cbs.forEach(function (cb) {
      try { cb(data); } catch (e) { console.error('[Folium Event Error]', ev, e); }
    });
  }

  function on(ev, cb) {
    eventBus[ev] = eventBus[ev] || [];
    eventBus[ev].push(cb);
    return function () {
      eventBus[ev] = (eventBus[ev] || []).filter(function (fn) { return fn !== cb; });
    };
  }

  // ===== 4. 模组存储引擎 (Storage Engine) =====
  function createScopedStorage(modId) {
    var prefix = 'folium_store_' + (modId || 'default') + '_';
    return {
      get: async function (key, def) {
        try {
          var v = localStorage.getItem(prefix + key);
          return v !== null ? JSON.parse(v) : def;
        } catch (_) { return def; }
      },
      set: async function (key, val) {
        try { localStorage.setItem(prefix + key, JSON.stringify(val)); } catch (_) {}
      },
      delete: async function (key) {
        try { localStorage.removeItem(prefix + key); } catch (_) {}
      },
      has: async function (key) {
        return localStorage.getItem(prefix + key) !== null;
      }
    };
  }

  // ===== 5. Folium Client API 标准契约 =====
  function buildFoliumApi(modId) {
    return {
      folium: 1,
      modId: modId,
      host: {
        folium: { major: 1, minor: 8 }
      },
      env: {
        context: 'main'
      },
      theme: {
        get: function () {
          return {
            isDaylight: false,
            fontStack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif',
            fontWeight: 500
          };
        },
        resolveFontStack: function (t) {
          return (t && t.fontStack) || '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        },
        resolveFontWeight: function (t, fb) {
          return (t && t.fontWeight) || fb || 500;
        },
        on: function (ev, cb) {
          return on('theme:' + ev, cb);
        }
      },
      registries: registries,
      storage: createScopedStorage(modId),
      secrets: {
        get: async function (key) {
          return localStorage.getItem('folium_secret_' + key) || '';
        },
        subscribe: function (cb) {
          return function () {};
        }
      },
      net: {
        fetch: function (url, opts) {
          return window.fetch(url, opts);
        }
      },
      every: function (intervalMs, fn) {
        var timer = setInterval(fn, intervalMs);
        return function () { clearInterval(timer); };
      },
      experimental: {
        'ponder.targets': {
          register: function () {}
        }
      },
      playback: {
        getState: function () {
          return {
            state: isAudioPlaying() ? 'playing' : 'paused',
            song: getSongMetadata(),
            position: getPlaybackSec(),
            duration: getPlaybackDuration()
          };
        },
        getTime: getPlaybackSec,
        getDuration: getPlaybackDuration,
        isPlaying: isAudioPlaying,
        seek: function (sec) {
          if (global.scrubSongProgress) {
            var dur = getPlaybackDuration();
            global.scrubSongProgress((sec / dur) * 1000);
          }
        },
        on: function (ev, cb) {
          return on('playback:' + ev, cb);
        }
      },
      lyrics: {
        getLines: getNormalizedLyrics,
        getLine: function (idx) {
          var lines = getNormalizedLyrics();
          return lines[idx] || null;
        },
        on: function (ev, cb) {
          return on('lyrics:' + ev, cb);
        }
      },
      ui: {
        toast: function (msg, opts) {
          if (global.showToast) global.showToast(msg);
          else console.log('[Toast]', msg);
        },
        openPlayerPanel: function (id) {
          toggleModSettingsDrawer(true, id);
        }
      },
      log: {
        info: console.log.bind(console, `[${modId || 'Folium'}]`),
        warn: console.warn.bind(console, `[${modId || 'Folium'}]`),
        error: console.error.bind(console, `[${modId || 'Folium'}]`)
      },
      events: {
        on: on,
        emit: emit
      },
      rpc: {
        call: async function (method, args) {
          console.log('[Folium RPC Call]', method, args);
          if (method === 'credential.status') return { set: false };
          if (method === 'decide') return { ok: true, mode: 'rings' };
          return {};
        }
      }
    };
  }

  // ===== 6. 模组动态加载器 =====
  var loadedMods = {};

  async function loadMod(modFolder) {
    if (loadedMods[modFolder]) return loadedMods[modFolder];
    var clientUrl = '/mods/' + modFolder + '/client.mjs';
    var api = buildFoliumApi(modFolder);

    try {
      var module = await import(clientUrl);
      var activate = module.default || module.activate;
      if (typeof activate === 'function') {
        var ret = activate(api);
        loadedMods[modFolder] = { ok: true, instance: ret, api: api };
        console.log(`%c[Folium Mod] 成功加载 ESM 模组: ${modFolder}`, 'color:#10b981;font-weight:bold;');
        return loadedMods[modFolder];
      }
    } catch (esmErr) {
      console.warn(`[Folium ESM Error for ${modFolder}]:`, esmErr);
    }

    // 回退尝试执行 plugin.js
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = '/mods/' + modFolder + '/plugin.js';
      s.onload = function () {
        var act = global.__FOLIUM_PLUGINS && global.__FOLIUM_PLUGINS[modFolder];
        if (typeof act === 'function') {
          try {
            var ret = act(api);
            loadedMods[modFolder] = { ok: true, instance: ret, api: api };
            console.log(`%c[Folium Mod] 脚本回退成功加载: ${modFolder}`, 'color:#10b981;');
          } catch (e) {
            console.error(`[Folium Script Activate Fail: ${modFolder}]:`, e);
          }
        }
        resolve(loadedMods[modFolder] || { ok: false });
      };
      s.onerror = function () {
        console.error(`[Folium Mod Script 404]: ${modFolder}`);
        resolve({ ok: false });
      };
      document.head.appendChild(s);
    });
  }

  // ===== 7. 动效挂载核心 (Mount Visualizer Engine) =====
  var activeVisualizerHandle = null;
  var visualizerRafId = 0;

  function createVisualizerContext(container) {
    var timeListeners = [];
    var frameListeners = [];
    var subListeners = [];

    var lyrics = getNormalizedLyrics();
    var song = getSongMetadata();

    // 寻找当前时间点匹配的歌词行索引
    function findCurrentLineIndex(sec) {
      for (var i = 0; i < lyrics.length; i++) {
        var line = lyrics[i];
        if (sec >= line.startTime && sec < line.endTime) return i;
      }
      return -1;
    }

    var ctx = {
      lines: lyrics,
      song: song,
      staticMode: false,
      staticLineIndex: null,
      getLineIndex: function () {
        return findCurrentLineIndex(getPlaybackSec());
      },
      getTheme: function () {
        return {
          isDaylight: false,
          fontStack: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif',
          fontWeight: 500
        };
      },
      getDisplay: function () {
        return {
          lyricsFontScale: 1.0,
          width: container.clientWidth || 800,
          height: container.clientHeight || 600
        };
      },
      getCoverUrl: function () {
        return song.cover;
      },
      getSettings: function () {
        try {
          return JSON.parse(localStorage.getItem('folium_viz_settings') || '{}');
        } catch (_) { return {}; }
      },
      isPaused: function () {
        return !isAudioPlaying();
      },
      audio: global.analyserNode || null,
      audioContext: global.audioCtx || null,
      currentTime: {
        get: getPlaybackSec,
        on: function (ev, cb) {
          if (ev === 'change' && typeof cb === 'function') {
            timeListeners.push(cb);
            return function () {
              timeListeners = timeListeners.filter(function (fn) { return fn !== cb; });
            };
          }
          return function () {};
        }
      },
      onFrame: function (cb) {
        if (typeof cb === 'function') frameListeners.push(cb);
      },
      subscribe: function (cb) {
        if (typeof cb === 'function') subListeners.push(cb);
        return function () {
          subListeners = subListeners.filter(function (fn) { return fn !== cb; });
        };
      },
      onChange: function (cb) {
        return this.subscribe(cb);
      },
      onLyricTime: function (cb) {},
      onResize: function (cb) {}
    };

    var lastSec = -1;
    function loop() {
      var sec = getPlaybackSec();
      if (sec !== lastSec) {
        timeListeners.forEach(function (fn) {
          try { fn(sec); } catch (_) {}
        });
        lastSec = sec;
      }
      frameListeners.forEach(function (fn) {
        try { fn({ currentTime: sec, isPlaying: isAudioPlaying() }); } catch (_) {}
      });
      visualizerRafId = requestAnimationFrame(loop);
    }
    visualizerRafId = requestAnimationFrame(loop);

    return {
      ctx: ctx,
      stop: function () {
        cancelAnimationFrame(visualizerRafId);
      }
    };
  }

  function mountVisualizer(id, container) {
    unmountVisualizer();
    if (!container) return false;

    // 别名规约
    var resolvedId = id;
    if (id === '52hz' || id === 'mod:52hz') resolvedId = 'rings';
    if (id === 'aurora' || id === 'mod:aurora') resolvedId = 'aurora-text';
    if (id === 'vinyl-disc' || id === 'mod:vinyl-disc') resolvedId = 'disc';

    var spec = registries.visualizers.get(resolvedId);
    if (!spec || typeof spec.mount !== 'function') {
      console.warn('[Folium] 未找到对应动效挂载接口:', resolvedId);
      return false;
    }

    container.innerHTML = '';
    var bundle = createVisualizerContext(container);
    try {
      var unmountFn = spec.mount(container, bundle.ctx);
      activeVisualizerHandle = {
        id: resolvedId,
        container: container,
        unmount: typeof unmountFn === 'function' ? unmountFn : function () {},
        stopTick: bundle.stop
      };
      console.log(`%c[Folium] 成功挂载视觉动效: ${resolvedId}`, 'color:#3b82f6;font-weight:bold;');
      return true;
    } catch (e) {
      console.error('[Folium] 动效挂载异常:', resolvedId, e);
      bundle.stop();
      return false;
    }
  }

  function unmountVisualizer() {
    if (activeVisualizerHandle) {
      try {
        if (activeVisualizerHandle.stopTick) activeVisualizerHandle.stopTick();
        if (activeVisualizerHandle.unmount) activeVisualizerHandle.unmount();
        if (activeVisualizerHandle.container) activeVisualizerHandle.container.innerHTML = '';
      } catch (e) {
        console.error('[Folium] 卸载动效异常:', e);
      }
      activeVisualizerHandle = null;
    }
  }

  // ===== 8. 进度条插件渲染与书签系统 (sample-progress-bar) =====
  function setupProgressBarLayers() {
    var track = document.querySelector('[data-folium-part="progress.track"]') || document.querySelector('.progress-track-wrapper');
    if (!track) return;

    track.setAttribute('data-folium-part', 'progress.track');

    // 挂载 ProgressLayers (如 marker 分段点)
    var layers = registries.progressLayers.list();
    layers.forEach(function (layer) {
      if (typeof layer.mount === 'function') {
        var layerContainer = document.createElement('div');
        layerContainer.className = 'folium-progress-layer';
        layerContainer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2;';
        track.appendChild(layerContainer);

        var layerCtx = {
          getDuration: getPlaybackDuration,
          timeToRatio: function (s) {
            var d = getPlaybackDuration();
            return d > 0 ? Math.min(1, Math.max(0, s / d)) : 0;
          },
          seek: function (s) {
            if (global.scrubSongProgress) {
              global.scrubSongProgress((s / getPlaybackDuration()) * 1000);
            }
          },
          subscribe: function (fn) {
            return on('playback:songChanged', fn);
          }
        };

        layer.mount(layerContainer, layerCtx);
      }
    });

    // 挂载 ControlButtons (如书签按钮) 到 progress.trailing
    var trailingSlot = document.querySelector('[data-folium-slot="progress.trailing"]');
    if (trailingSlot) {
      var btns = registries.controlButtons.list().filter(function (b) { return b.slot === 'progress.trailing'; });
      btns.forEach(function (b) {
        if (typeof b.mount === 'function') {
          var btnCtx = {
            currentTime: { get: getPlaybackSec },
            getColors: function () { return { text: 'rgba(255,255,255,0.7)' }; },
            subscribe: function () { return function () {}; }
          };
          b.mount(trailingSlot, btnCtx);
        }
      });
    }
  }

  // ===== 9. AI 歌词运镜导演 (lyric-ai-director & plus) =====
  var isAiDirectorEnabled = false;
  var lastAiDecision = null;

  async function runAiDirectorDecision(forceAnnounce) {
    var song = getSongMetadata();
    var lyrics = getNormalizedLyrics();
    var textJoined = lyrics.map(function (l) { return l.fullText; }).join(' ');

    // 智能情感与风格分析 (优先调度 GPU 3D 着色器引擎与顶级模组)
    var candidateMode = '3d:fluid';
    var emotionTag = '流体美学';
    var cameraAction = 'GPU 卷曲流体卷动 · 3D 悬浮星云';
    var reason = '声场宽广，启动 3D 卷曲流体丝带与全屏 UnrealBloom 泛光';

    if (textJoined.match(/海|浪|深蓝|鲸|梦|寂寞|风|月|云|轻|静/)) {
      candidateMode = 'mod:52hz'; // 52Hz
      emotionTag = '空灵沉静';
      cameraAction = '水波纹年轮扩散 · 节拍重低音微震';
      reason = '歌词带有空灵水象意象，完美共振 52Hz 鲸鱼声场';
    } else if (textJoined.match(/光|彩虹|极光|星|银河|闪烁|梦幻|爱|恋|你/)) {
      candidateMode = '3d:fluid'; // 3D 流体丝带
      emotionTag = '浪漫璀璨';
      cameraAction = '3D 卷曲流体丝带 · 4000 悬浮星尘';
      reason = '词句充满星光与浪漫，唤醒 3D 卷曲流体丝带与星尘星云';
    } else if (textJoined.match(/黑胶|复古|旧|唱片|时代|回响|时光|留声/)) {
      candidateMode = '3d:vinyl'; // 3D 实体黑胶
      emotionTag = '复古经典';
      cameraAction = '33转/分真 3D 黑胶碟面 · 金属反光与全息光圈';
      reason = '具有怀旧年代感，启动 3D 实体黑胶与全息波纹';
    } else if (textJoined.match(/燃|火|烈|战|疾|狂|速|怒|裂/)) {
      candidateMode = 'sonnet'; // K3Panel
      emotionTag = '高能动感';
      cameraAction = 'Y2K 几何网格暴击 · RGB 色散故障微光';
      reason = '强节拍冲击，调高色散倍率与几何花朵自转';
    } else if (textJoined.match(/齿轮|机械|时钟|机芯|时间|转动/)) {
      candidateMode = '3d:gear'; // 3D 量子机械齿轮
      emotionTag = '精密赛博';
      cameraAction = '36齿咬合 3D 金属齿轮 · 激光准星时钟';
      reason = '充满机械机芯美感，切入 3D 量子机械齿轮';
    }

    lastAiDecision = {
      song: song.title,
      mode: candidateMode,
      emotion: emotionTag,
      action: cameraAction,
      reason: reason,
      timestamp: Date.now()
    };

    // 显示 AI 决策浮动胶囊
    showAiDecisionBanner(lastAiDecision);

    // 自动切换至 AI 指定动效
    if (global.setFoliaMode) {
      global.setFoliaMode(candidateMode);
    }

    emit('ai-director:decided', lastAiDecision);
    return lastAiDecision;
  }

  function showAiDecisionBanner(decision) {
    var banner = document.getElementById('aiDirectorBanner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'aiDirectorBanner';
      banner.style.cssText = [
        'position:absolute', 'top:72px', 'left:50%', 'transform:translateX(-50%)',
        'background:rgba(16, 185, 129, 0.18)', 'border:1px solid rgba(16, 185, 129, 0.45)',
        'backdrop-filter:blur(16px)', 'color:#6ee7b7', 'padding:6px 18px',
        'border-radius:24px', 'font-size:12px', 'z-index:90', 'display:flex',
        'align-items:center', 'gap:8px', 'box-shadow:0 4px 20px rgba(0,0,0,0.3)',
        'transition:all 0.35s ease', 'pointer-events:none'
      ].join(';');
      var pv = document.getElementById('playerView');
      if (pv) pv.appendChild(banner);
    }
    banner.innerHTML = `<span>🤖</span><strong>AI 导演已决策：</strong><span>[${decision.emotion}] · ${decision.reason}</span>`;
    banner.style.opacity = '1';
    banner.style.transform = 'translateX(-50%) translateY(0)';

    clearTimeout(banner._timer);
    banner._timer = setTimeout(function () {
      banner.style.opacity = '0';
      banner.style.transform = 'translateX(-50%) translateY(-10px)';
    }, 4500);
  }

  function toggleAiDirector(enabled) {
    isAiDirectorEnabled = (enabled !== undefined) ? enabled : !isAiDirectorEnabled;
    if (isAiDirectorEnabled) {
      global.showToast('🤖 AI 歌词运镜导演：已开启全局接管');
      runAiDirectorDecision(true);
    } else {
      global.showToast('🤖 AI 歌词运镜导演：已关闭');
    }
    var btn = document.getElementById('aiDirectorToggleBtn');
    if (btn) btn.classList.toggle('active', isAiDirectorEnabled);
  }

  // ===== 10. 模组与 K3Panel 精调抽屉 (Mod Tunings Drawer) =====
  function toggleModSettingsDrawer(open, targetModId) {
    var drawer = document.getElementById('foliumModSettingsDrawer');
    if (!drawer) return;
    drawer.classList.toggle('open', !!open);
    if (open) renderModSettingsDrawerContent(targetModId);
  }

  function renderModSettingsDrawerContent(targetModId) {
    var body = document.getElementById('foliumModDrawerBody');
    if (!body) return;

    var tunings = registries.tunings.list();
    var sections = registries.settingsSections.list();

    var html = '<div style="padding:16px;color:#fff;">';
    html += '<h3 style="margin-bottom:12px;font-size:16px;display:flex;align-items:center;gap:8px;">🛠️ Folium 模组参数精调</h3>';

    // 渲染 K3Panel 商籁深度精调 (11 项参数)
    tunings.forEach(function (tun) {
      html += `<div style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:12px;margin-bottom:12px;">`;
      html += `<div style="font-weight:bold;color:#f472b6;margin-bottom:8px;">${tun.label['zh-CN'] || tun.label.en}</div>`;
      (tun.params || []).forEach(function (p) {
        var curr = 1.0;
        try {
          var store = JSON.parse(localStorage.getItem('folium_tunings') || '{}');
          if (store[p.key] !== undefined) curr = store[p.key];
        } catch (_) {}

        html += `<div style="display:flex;align-items:center;justify-content:space-between;margin:6px 0;font-size:12px;">`;
        html += `<span style="color:#d1d5db;">${p.label['zh-CN'] || p.label.en}</span>`;
        html += `<div style="display:flex;align-items:center;gap:6px;">`;
        html += `<input type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${curr}" `;
        html += `oninput="Folium.updateTuningValue('${p.key}', this.value); this.nextElementSibling.innerText=this.value;" style="width:110px;">`;
        html += `<span style="width:36px;text-align:right;font-family:monospace;color:#60a5fa;">${curr}</span>`;
        html += `</div></div>`;
      });
      html += `</div>`;
    });

    // 渲染设置项 (Halo / 进度条 / 52Hz)
    sections.forEach(function (sec) {
      html += `<div style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:12px;margin-bottom:12px;">`;
      html += `<div style="font-weight:bold;color:#38bdf8;margin-bottom:8px;">${sec.label['zh-CN'] || sec.label.en}</div>`;
      (sec.settings || []).forEach(function (s) {
        html += `<div style="display:flex;align-items:center;justify-content:space-between;margin:6px 0;font-size:12px;">`;
        html += `<span style="color:#d1d5db;">${s.label['zh-CN'] || s.label.en}</span>`;
        if (s.type === 'boolean') {
          html += `<input type="checkbox" checked style="accent-color:#38bdf8;">`;
        } else if (s.type === 'number') {
          html += `<span style="color:#9ca3af;">${s.defaultValue}</span>`;
        } else {
          html += `<span style="color:#9ca3af;">默认</span>`;
        }
        html += `</div>`;
      });
      html += `</div>`;
    });

    html += '</div>';
    body.innerHTML = html;
  }

  function updateTuningValue(key, val) {
    try {
      var store = JSON.parse(localStorage.getItem('folium_tunings') || '{}');
      store[key] = parseFloat(val);
      localStorage.setItem('folium_tunings', JSON.stringify(store));
      emit('tuning:changed', { key: key, value: parseFloat(val) });
    } catch (_) {}
  }

  // ===== 11. 统一对外接口暴露 =====
  var FoliumEngine = {
    folium: buildFoliumApi('root'),
    loadAll: async function () {
      var mods = [
        '52hz',
        'aurora',
        'vinyl-disc',
        'k3panel',
        'halo-lyric',
        'progress-bar',
        'lyric-ai-director',
        'lyric-ai-director-plus'
      ];
      for (var i = 0; i < mods.length; i++) {
        await loadMod(mods[i]);
      }
      setupProgressBarLayers();
      return loadedMods;
    },
    mountVisualizer: mountVisualizer,
    unmountVisualizer: unmountVisualizer,
    getVisualizers: registries.visualizers.list,
    getTunings: registries.tunings.list,
    getSettingsSections: registries.settingsSections.list,
    updateTuningValue: updateTuningValue,
    toggleAiDirector: toggleAiDirector,
    runAiDirectorDecision: runAiDirectorDecision,
    toggleModSettingsDrawer: toggleModSettingsDrawer,
    emit: emit,
    on: on
  };

  global.Folium = FoliumEngine;

})(typeof window !== 'undefined' ? window : this);
