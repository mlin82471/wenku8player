/**
 * aurora-wave.js — 极光动效（Apple Music 液态海浪 + 封面取色 + 震动玻璃框）
 *
 * 参考：Apple Music 极光液态海浪方格（48x48 低分辨率流体场 + 空间毛玻璃 + 声学震动边框）
 * 适配：wenku8 播放页 —— 内部展示歌词而非封面卡片
 *
 * 对外接口：
 *   AuroraWave.mount(stageEl, { getPlaying, getTime, getLyrics })
 *   AuroraWave.setCover(url)        封面变更时调用（自动取 4 色）
 *   AuroraWave.setBands({bass,mids,treble})  音频频段（0~1）
 *   AuroraWave.unmount()
 */
(function () {
  'use strict';

  var state = null;
  var DEFAULT_COLORS = [[14, 165, 233], [99, 102, 241], [236, 72, 153], [16, 185, 129]];

  function R(a, b) { return a + Math.random() * (b - a); }

  // ===== 封面取色（16x16 采样 + 饱和度加权 + 色相去重）=====
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, v = max;
    var d = max - min;
    s = max === 0 ? 0 : d / max;
    if (max !== min) {
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, v];
  }

  function hsvToRgb(h, s, v) {
    h = ((h % 1) + 1) % 1;
    var i = Math.floor(h * 6);
    var f = h * 6 - i;
    var p = v * (1 - s);
    var q = v * (1 - f * s);
    var t = v * (1 - (1 - f) * s);
    var r, g, b;
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      default: r = v; g = p; b = q; break;
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  function extract4(img) {
    try {
      var c = document.createElement('canvas');
      c.width = 16; c.height = 16;
      var cx = c.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0, 16, 16);
      var data = cx.getImageData(0, 0, 16, 16).data;
      var cand = [];
      for (var i = 0; i < data.length; i += 4) {
        var r = data[i], g = data[i + 1], b = data[i + 2];
        var hsv = rgbToHsv(r, g, b);
        if (hsv[2] > 0.18 && hsv[2] < 0.96 && hsv[1] > 0.22) {
          cand.push({ rgb: [r, g, b], h: hsv[0], score: hsv[1] * 1.4 + hsv[2] * 0.6 });
        }
      }
      cand.sort(function (a, b) { return b.score - a.score; });
      var picked = [];
      for (var k = 0; k < cand.length && picked.length < 4; k++) {
        var item = cand[k];
        var ok = picked.every(function (p) {
          var dh = Math.min(Math.abs(p.h - item.h), 1 - Math.abs(p.h - item.h));
          return dh > 0.09;
        });
        if (ok) picked.push(item);
      }
      // 只用最高分的那一个主色，其余 3 色由它按色相/明度/饱和度衍生，
      // 保证整屏色系统一（不会再出现紫+粉+青的"彩虹感"）
      var main = picked.length ? picked[0].rgb : [56, 189, 248];
      var hsv0 = rgbToHsv(main[0], main[1], main[2]);
      var baseH = hsv0[0], baseS = Math.min(0.85, Math.max(0.45, hsv0[1])), baseV = Math.min(0.95, Math.max(0.55, hsv0[2]));

      return [
        main,                                                     // 主色
        hsvToRgb(baseH + 0.06, baseS * 0.85, baseV * 1.08),       // 邻近色（亮）
        hsvToRgb(baseH - 0.06, baseS * 0.70, baseV * 0.70),       // 邻近色（深）
        hsvToRgb(baseH + 0.14, baseS * 0.45, baseV * 1.15)        // 远处微对比
      ];
    } catch (e) {
      return DEFAULT_COLORS.map(function (c) { return c.slice(); });
    }
  }

  function mount(stageEl, opts) {
    unmount();
    opts = opts || {};

    var host = document.createElement('div');
    host.id = 'auroraWaveRoot';
    host.style.cssText = 'position:absolute;inset:0;overflow:hidden;';
    stageEl.appendChild(host);

    // 环境散射光
    var ambient = document.createElement('div');
    ambient.className = 'aw-ambient';
    host.appendChild(ambient);

    // 封面模糊层
    var coverLayer = document.createElement('div');
    coverLayer.className = 'aw-cover';
    host.appendChild(coverLayer);

    // 48x48 液态海浪 canvas
    var wave = document.createElement('canvas');
    wave.className = 'aw-wave';
    wave.width = 48; wave.height = 48;
    host.appendChild(wave);
    var wctx = wave.getContext('2d');
    var wimg = wctx.createImageData(48, 48);

    // 空间毛玻璃
    var frost = document.createElement('div');
    frost.className = 'aw-frost';
    host.appendChild(frost);

    // 波光扫过（wave caustic sheen）
    var caustic = document.createElement('div');
    caustic.className = 'aw-caustic';
    host.appendChild(caustic);

    // 胶片颗粒（grain）
    var grain = document.createElement('div');
    grain.className = 'aw-grain';
    host.appendChild(grain);

    // Apple 玻璃边缘（覆盖在最上层，模拟玻璃板厚度）
    var glassEdge = document.createElement('div');
    glassEdge.className = 'aw-glass-edge';
    host.appendChild(glassEdge);

    // 居中专辑封面（参考新版的 albumArtBox + coverHalo）
    var coverHalo = document.createElement('div');
    coverHalo.className = 'aw-cover-halo';
    host.appendChild(coverHalo);

    var coverBox = document.createElement('div');
    coverBox.className = 'aw-coverbox';
    var coverImg = document.createElement('img');
    coverImg.alt = '';
    coverBox.appendChild(coverImg);
    host.appendChild(coverBox);

    // 声学震动边框
    var shock = document.createElement('canvas');
    shock.className = 'aw-shock';
    shock.width = 96; shock.height = 96;
    host.appendChild(shock);
    var sctx = shock.getContext('2d');

    var cur = DEFAULT_COLORS.map(function (c) { return c.slice(); });
    var tgt = DEFAULT_COLORS.map(function (c) { return c.slice(); });
    var bands = { bass: 0.2, mids: 0.2, treble: 0.15 };
    var smooth = { bass: 0.2, mids: 0.2, treble: 0.15 };

    var phase = 0, running = true, raf = 0, last = performance.now();

    function applyColors() {
      var root = document.documentElement;
      for (var i = 0; i < 4; i++) {
        root.style.setProperty('--aw-c' + i, Math.round(cur[i][0]) + ', ' + Math.round(cur[i][1]) + ', ' + Math.round(cur[i][2]));
      }
      // 环境光收敛到同一个主色系，透明度压低，避免"调色盘"感
      ambient.style.background =
        'radial-gradient(circle at 28% 32%, rgba(' + Math.round(cur[0][0]) + ',' + Math.round(cur[0][1]) + ',' + Math.round(cur[0][2]) + ',0.16), transparent 55%),'
        + 'radial-gradient(circle at 74% 68%, rgba(' + Math.round(cur[1][0]) + ',' + Math.round(cur[1][1]) + ',' + Math.round(cur[1][2]) + ',0.12), transparent 55%),'
        + 'radial-gradient(circle at 58% 22%, rgba(' + Math.round(cur[2][0]) + ',' + Math.round(cur[2][1]) + ',' + Math.round(cur[2][2]) + ',0.09), transparent 50%)';
    }

    function loop(now) {
      if (!running) return;
      raf = requestAnimationFrame(loop);
      var dt = (now - last) / 1000;
      last = now;
      if (dt > 0.2) dt = 0.2;

      var playing = opts.getPlaying ? opts.getPlaying() : true;

      // 优先读真实频谱；没有音频节点时用 124BPM 合成律动
      if (playing) {
        if (window.analyserNode) {
          var arr = new Uint8Array(128);
          window.analyserNode.getByteFrequencyData(arr);
          var bSum = 0, mSum = 0, tSum = 0;
          for (var bi = 0; bi < 10; bi++) bSum += arr[bi];
          for (var mi = 10; mi < 35; mi++) mSum += arr[mi];
          for (var ti = 35; ti < 80; ti++) tSum += arr[ti];
          bands = { bass: bSum / 2550, mids: mSum / 6375, treble: tSum / 11475 };
        } else {
          var tt = now / 1000;
          var beat = Math.pow(Math.max(0, Math.sin(tt * Math.PI * 2.06)), 4);
          bands = {
            bass: 0.22 + beat * 0.68,
            mids: 0.25 + (0.5 + 0.5 * Math.sin(tt * 1.7)) * 0.48 + 0.08 * Math.cos(tt * 4.3),
            treble: 0.18 + Math.pow(Math.sin(tt * 6.2) * 0.5 + 0.5, 3) * 0.65
          };
        }
      }
      var b = playing ? bands : { bass: 0.06, mids: 0.06, treble: 0.04 };

      smooth.bass += (b.bass - smooth.bass) * 0.14;
      smooth.mids += (b.mids - smooth.mids) * 0.12;
      smooth.treble += (b.treble - smooth.treble) * 0.16;

      for (var i = 0; i < 4; i++) {
        for (var c = 0; c < 3; c++) cur[i][c] += (tgt[i][c] - cur[i][c]) * 0.06;
      }
      applyColors();

      // 封面随低音呼吸 + 光晕扩散
      var coverScale = 0.97 + Math.min(0.06, smooth.bass * 0.16);
      coverBox.style.transform = 'translate(-50%, -50%) scale(' + coverScale.toFixed(3) + ')';
      coverHalo.style.transform = 'translate(-50%, -50%) scale(' + (0.9 + smooth.bass * 0.55).toFixed(3) + ')';
      coverHalo.style.opacity = (0.12 + smooth.bass * 0.22).toFixed(3);

      // ===== 48x48 极光海浪 =====
      phase += 0.025 + smooth.mids * 0.055;
      var W = 48, H = 48;
      var pData = wimg.data, idx = 0;
      var orbs = [
        { x: 0.5 + 0.36 * Math.cos(phase * 0.9), y: 0.58 + 0.28 * Math.sin(phase * 1.1), r: 0.42 + smooth.bass * 0.28, col: cur[0] },
        { x: 0.5 + 0.38 * Math.sin(phase * 0.75 + 1.4), y: 0.45 + 0.32 * Math.cos(phase * 0.85), r: 0.40 + smooth.mids * 0.26, col: cur[1] },
        { x: 0.48 + 0.34 * Math.cos(-phase * 1.15 + 3.1), y: 0.65 + 0.26 * Math.sin(-phase * 0.95), r: 0.38 + smooth.bass * 0.30, col: cur[2] },
        { x: 0.52 + 0.30 * Math.sin(phase * 1.3 + 4.5), y: 0.35 + 0.30 * Math.cos(phase * 1.1 + 2.0), r: 0.35 + smooth.treble * 0.25, col: cur[3] }
      ];

      for (var py = 0; py < H; py++) {
        var ny = py / H;
        for (var px = 0; px < W; px++) {
          var nx = px / W;

          var surf1 = 0.52 - smooth.bass * 0.16
            + Math.sin(nx * 5.5 + phase * 1.8) * (0.08 + smooth.bass * 0.09)
            + Math.cos(nx * 9.0 - phase * 1.3) * (0.05 + smooth.mids * 0.06);
          var surf2 = 0.62 - smooth.mids * 0.12
            + Math.sin(nx * 4.2 - phase * 1.4 + 1.2) * (0.09 + smooth.mids * 0.08);

          var mask1 = Math.max(0, Math.min(1, (ny - surf1 + 0.22) * 3.2));
          var mask2 = Math.max(0, Math.min(1, (ny - surf2 + 0.18) * 3.8));
          // 浪尖不再用纯白泡沫，改用主色的低饱和亮调，避免"死白"
          var foam = Math.exp(-Math.pow((ny - surf1) * 9.5, 2)) * (0.10 + smooth.treble * 0.18);

          var r = 10, g = 14, bb = 26;
          for (var k = 0; k < 4; k++) {
            var o = orbs[k];
            var dx = nx - o.x;
            var dy = ny - o.y + Math.sin(nx * 6 + phase) * 0.06;
            var w = Math.exp(-(dx * dx + dy * dy) / (o.r * o.r)) * (0.55 + 0.45 * mask1);
            r += o.col[0] * w;
            g += o.col[1] * w;
            bb += o.col[2] * w;
          }
          // 泡沫色 = 主色往白里混 30%（保留色相，不再是纯白）
          var fR = cur[0][0] * 0.7 + 76;
          var fG = cur[0][1] * 0.7 + 76;
          var fB = cur[0][2] * 0.7 + 76;
          r = r * (0.68 + 0.42 * mask2) + foam * fR;
          g = g * (0.68 + 0.42 * mask2) + foam * fG;
          bb = bb * (0.68 + 0.42 * mask2) + foam * fB;

          pData[idx++] = Math.min(255, r);
          pData[idx++] = Math.min(255, g);
          pData[idx++] = Math.min(255, bb);
          pData[idx++] = 242;
        }
      }
      // 整体压暗：屏幕混合前先降亮度，避免把画面洗白
      for (var di2 = 0; di2 < pData.length; di2 += 4) {
        pData[di2] = pData[di2] * 0.72;
        pData[di2 + 1] = pData[di2 + 1] * 0.72;
        pData[di2 + 2] = pData[di2 + 2] * 0.72;
      }
      wctx.putImageData(wimg, 0, 0);

      // ===== 声学震动边框 =====
      sctx.clearRect(0, 0, 96, 96);
      var cx = 48, cy = 48, baseHalf = 44, baseRadius = 6;
      var segs = 64;
      var c0 = cur[0].map(Math.round), c1 = cur[1].map(Math.round), c2 = cur[2].map(Math.round);
      var grad = sctx.createLinearGradient(4, 4, 92, 92);
      grad.addColorStop(0, 'rgba(' + c0.join(',') + ',0.95)');
      grad.addColorStop(0.5, 'rgba(' + c1.join(',') + ',0.85)');
      grad.addColorStop(1, 'rgba(' + c2.join(',') + ',0.95)');

      // 边框改为「极淡的柔性呼吸光边」：无 shadow、无高频闪烁，只保留缓慢的低频起伏
      for (var layer = 0; layer < 2; layer++) {
        sctx.beginPath();
        for (var si = 0; si <= segs; si++) {
          var u = (si % segs) / segs;
          var ang = u * Math.PI * 2 - Math.PI / 2;
          var cos = Math.cos(ang), sin = Math.sin(ang);
          var inner = baseHalf - baseRadius;
          var sx = Math.max(-inner, Math.min(inner, cos * baseHalf * 1.35));
          var sy = Math.max(-inner, Math.min(inner, sin * baseHalf * 1.35));
          var ddx = cos * baseHalf * 1.35 - sx;
          var ddy = sin * baseHalf * 1.35 - sy;
          var len = Math.hypot(ddx, ddy) || 1;
          var nx2 = ddx / len, ny2 = ddy / len;
          var bx = cx + sx + nx2 * baseRadius;
          var by = cy + sy + ny2 * baseRadius;

          // 只保留 8 段低频起伏，幅度压到 1/6，去掉了 16/28/44 段的高频闪烁
          var harmonic = Math.sin(u * Math.PI * 8 + phase * 0.9) * smooth.bass * 1.6;
          var amp = Math.max(0.3, (0.7 + Math.abs(harmonic)) * (layer === 0 ? 0.35 : 0.22));
          var px2 = bx + nx2 * amp;
          var py2 = by + ny2 * amp;
          if (si === 0) sctx.moveTo(px2, py2); else sctx.lineTo(px2, py2);
        }
        sctx.closePath();
        sctx.strokeStyle = layer === 0
          ? 'rgba(' + c0.join(',') + ',0.30)'
          : 'rgba(255,255,255,0.12)';
        sctx.lineWidth = layer === 0 ? 0.9 : 0.4;
        sctx.shadowBlur = 0;   // 关键：去掉辉光，避免刺眼
        sctx.stroke();
      }
    }

    applyColors();
    for (var k = 0; k < 3; k++) {
      // 初始相位错开
      phase += 1.7;
    }
    raf = requestAnimationFrame(loop);

    state = {
      host: host, coverLayer: coverLayer, ambient: ambient,
      raf: 0, running: true,
      setColors: function (cols) { if (cols && cols.length >= 4) tgt = cols.map(function (c) { return c.slice(); }); },
      setBands: function (bd) { if (bd) bands = bd; },
      setCover: function (url) {
        if (!url) return;
        coverLayer.style.backgroundImage = 'url("' + url + '")';
        coverImg.src = url;

        var im = new Image();
        im.onload = function () {
          var cols = extract4(im);
          tgt = cols.map(function (c) { return c.slice(); });
        };
        // 关键：data: URL 是同源的，加 crossOrigin 反而会让 canvas 被标记为污染，
        // getImageData 抛 SecurityError，取色永远失败。只有 http(s) 才需要 crossOrigin。
        if (url.indexOf('data:') === 0) {
          im.src = url;
        } else {
          im.crossOrigin = 'anonymous';
          im.onerror = function () { /* 防盗链失败，保留默认色 */ };
          im.src = url;
        }
      },
      getState: function () { return { colors: cur.map(function (c) { return c.map(Math.round); }), bands: smooth }; }
    };
    state.raf = raf;
    return state;
  }

  function unmount() {
    if (!state) return;
    state.running = false;
    try { cancelAnimationFrame(state.raf); } catch (e) {}
    try {
      if (state.coverLayer) state.coverLayer.style.backgroundImage = 'none';
      if (state.host && state.host.parentNode) state.host.parentNode.removeChild(state.host);
    } catch (e) {}
    state = null;
  }

  window.AuroraWave = {
    mount: mount,
    unmount: unmount,
    setCover: function (u) { if (state && state.setCover) state.setCover(u); },
    setBands: function (b) { if (state && state.setBands) state.setBands(b); },
    getState: function () { return state ? state.getState() : null; }
  };
})();
