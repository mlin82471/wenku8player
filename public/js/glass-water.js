/**
 * glass-water.js v5 — 水镜动效（真实雨窗背景图 + 小雨波 + 落雨）
 *
 * 背景：assets/bg-canvas.webp（用户提供的蓝雨窗蝴蝶图，原图直接铺满，不做二次绘制）
 * 水面算法源自 lyrics_on_glass_optimized.html：poke / stepWater / renderWater
 *   DAMP=0.9855  REFRACT=2.0  LIGHT=10
 *
 * v5 改动：
 *   - 背景改用真实图片（不再程序化生成渐变）
 *   - 水波幅度大幅缩小（GAIN 190 -> 95，poke 半径减半）
 *   - 加入"正常下雨引擎"：雨丝下落 + 窗面水珠滑落留下轨迹
 *   - 歌词逐字落水 → 墨迹晕染
 */
(function () {
  'use strict';

  var DAMP = 0.9855;
  var STEP = 1 / 30;
  var GRAVITY = 980;
  var WATER_LINE = 0.62;
  var BG_URL = 'assets/bg-canvas.webp';

  var state = null;

  function R(a, b) { return a + Math.random() * (b - a); }

  function mount(stageEl, opts) {
    unmount();
    opts = opts || {};

    var W = stageEl.clientWidth || 1280;
    var H = stageEl.clientHeight || 800;
    var SW = Math.max(80, Math.min(200, Math.round(W / 8)));
    var SH = Math.max(60, Math.min(140, Math.round(H / 8)));
    var waterY = H * WATER_LINE;

    var cv = document.createElement('canvas');
    cv.id = 'glassWaterCanvas';
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:crosshair;';
    stageEl.appendChild(cv);

    var dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    var ctx = cv.getContext('2d');

    var sim = document.createElement('canvas');
    sim.width = SW; sim.height = SH;
    var simCtx = sim.getContext('2d');
    var outImg = simCtx.createImageData(SW, SH);

    var h1 = new Float32Array(SW * SH);
    var h2 = new Float32Array(SW * SH);

    // ===== 背景图 =====
    var bgImg = new Image();
    bgImg.decoding = 'async';
    var bgReady = false;
    bgImg.onload = function () { bgReady = true; };
    bgImg.src = BG_URL;

    var inks = [];
    var chars = [];
    var pending = [];
    var lyricCursor = 0;
    var lastTime = -1;

    // ===== 正常下雨引擎 =====
    // 1) 雨丝：细长斜线，快速下落
    var rain = [];
    for (var i = 0; i < 120; i++) {
      rain.push({
        x: R(-100, W + 100),
        y: R(-H, H),
        len: R(10, 26),
        v: R(620, 980),
        slant: R(-0.18, -0.06),
        a: R(0.10, 0.30),
        w: R(0.6, 1.4)
      });
    }
    // 2) 窗上水珠：缓慢下滑，留下湿痕
    var beads = [];
    for (var b2 = 0; b2 < 40; b2++) {
      beads.push({
        x: R(0, W), y: R(0, H),
        r: R(2.5, 7),
        v: R(6, 26),
        acc: R(0.6, 2.2),
        trail: R(12, 60),
        a: R(0.25, 0.55)
      });
    }

    // 水珠（静态装饰，保留参考图里的密集感）
    var drops = [];
    for (var d = 0; d < 200; d++) {
      var dr = R(0.9, 3.4);
      drops.push({
        x: R(0, W), y: R(0, H), r: dr,
        hl: R(0.12, 0.45) * dr,
        a: R(0.18, 0.55)
      });
    }

    // 蝴蝶（轻量保留，透明度压低不抢背景图）
    var butterflies = [];
    for (var bf = 0; bf < 6; bf++) {
      butterflies.push({
        x: R(W * 0.1, W * 0.9), y: R(H * 0.12, H * 0.78),
        size: R(26, 62), angle: R(-0.4, 0.4),
        vx: R(-5, 5), vy: R(-3, 3),
        phase: R(0, Math.PI * 2), speed: R(1.0, 2.0),
        alpha: R(0.12, 0.26)
      });
    }

    // ===== 歌词 =====
    function resetLyrics(lines) {
      chars = []; inks = []; pending = [];
      lyricCursor = 0; lastTime = -1;
      if (!lines || !lines.length) return;
      lines.forEach(function (line) {
        var words = line.words || [];
        if (!words.length && line.fullText) {
          words = Array.from(line.fullText).map(function (c, i) {
            return { text: c, startTime: line.startTime + i * 0.1, endTime: line.startTime + (i + 1) * 0.1 };
          });
        }
        words.forEach(function (w) {
          if (!w.text || !String(w.text).trim()) return;
          pending.push({ ch: String(w.text), at: Number(w.startTime) || 0, sent: false });
        });
      });
      pending.sort(function (a, b) { return a.at - b.at; });
    }

    function spawnChar(item) {
      chars.push({
        ch: item.ch, x: R(W * 0.14, W * 0.86), y: -40,
        vy: R(40, 110), rot: R(-0.24, 0.24), vrot: R(-0.6, 0.6),
        alpha: 1, state: 'falling', size: R(30, 46)
      });
    }

    function updateLyrics(dt) {
      var t = opts.getTime ? opts.getTime() : 0;
      if (lastTime >= 0 && (t < lastTime - 1.5 || t < 0.3)) {
        chars = []; inks = [];
        pending.forEach(function (p) { p.sent = false; });
        lyricCursor = 0;
      }
      lastTime = t;

      // 歌词改回 DOM 正常显示后，canvas 不再生成逐字下落（避免"太乱"）
      while (lyricCursor < pending.length && pending[lyricCursor].at <= t) {
        pending[lyricCursor].sent = true;
        lyricCursor++;
      }

      for (var i = chars.length - 1; i >= 0; i--) {
        var c = chars[i];
        if (c.state === 'falling') {
          c.vy += GRAVITY * dt;
          c.y += c.vy * dt;
          c.rot += c.vrot * dt;
          if (c.y >= waterY) {
            poke(Math.round((c.x / W) * SW), Math.round((waterY / H) * SH), 0.9, R(1.5, 3));
            inks.push({
              x: c.x, y: waterY + R(-6, 10), r: c.size * 0.32, vr: R(8, 15),
              alpha: 0.48, va: -0.24, seed: Math.random() * 1000
            });
            c.state = 'sunk'; c.alpha = 1;
          }
        } else {
          c.alpha -= dt * 3.2;
          if (c.alpha <= 0) chars.splice(i, 1);
        }
      }

      for (var k = inks.length - 1; k >= 0; k--) {
        var ink = inks[k];
        ink.r += ink.vr * dt; ink.alpha += ink.va * dt; ink.vr *= 0.985;
        if (ink.alpha <= 0) inks.splice(k, 1);
      }
    }

    // ===== 绘制 =====
    function drawBackdrop() {
      if (bgReady) {
        // 背景图铺满（cover 缩放）
        var iw = bgImg.naturalWidth || W;
        var ih = bgImg.naturalHeight || H;
        var scale = Math.max(W / iw, H / ih);
        var dw = iw * scale, dh = ih * scale;
        ctx.drawImage(bgImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
      } else {
        var g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, '#2d5a94');
        g.addColorStop(1, '#0d1c38');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }
      // 轻微的暗角，让文字更好读
      var v = ctx.createRadialGradient(W * 0.5, H * 0.45, W * 0.2, W * 0.5, H * 0.45, W * 0.8);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(2, 10, 26, 0.42)');
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, W, H);
    }

    function drawRain(dt) {
      ctx.lineCap = 'round';
      for (var i = 0; i < rain.length; i++) {
        var r = rain[i];
        r.y += r.v * dt;
        r.x += r.v * dt * r.slant;
        if (r.y > H + r.len) { r.y = -r.len; r.x = R(-100, W + 100); }
        ctx.strokeStyle = 'rgba(220, 236, 255, ' + r.a + ')';
        ctx.lineWidth = r.w;
        ctx.beginPath();
        ctx.moveTo(r.x, r.y);
        ctx.lineTo(r.x + r.len * r.slant, r.y + r.len);
        ctx.stroke();
      }
    }

    function drawBeads(dt) {
      for (var i = 0; i < beads.length; i++) {
        var bd = beads[i];
        bd.v += bd.acc * dt * 6;
        bd.y += bd.v * dt;
        if (bd.y > H + 10) { bd.y = -10; bd.x = R(0, W); bd.v = R(6, 26); }
        // 湿痕
        var tg = ctx.createLinearGradient(bd.x, bd.y - bd.trail, bd.x, bd.y);
        tg.addColorStop(0, 'rgba(200, 225, 250, 0)');
        tg.addColorStop(1, 'rgba(200, 225, 250, ' + (bd.a * 0.35).toFixed(3) + ')');
        ctx.strokeStyle = tg;
        ctx.lineWidth = bd.r * 0.55;
        ctx.beginPath();
        ctx.moveTo(bd.x, bd.y - bd.trail);
        ctx.lineTo(bd.x, bd.y);
        ctx.stroke();
        // 珠子
        ctx.beginPath();
        ctx.arc(bd.x, bd.y, bd.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(225, 240, 255, ' + bd.a.toFixed(3) + ')';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(bd.x - bd.r * 0.28, bd.y - bd.r * 0.3, bd.r * 0.36, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,' + (bd.a * 0.9).toFixed(3) + ')';
        ctx.fill();
      }
    }

    function drawDrops() {
      for (var i = 0; i < drops.length; i++) {
        var dp = drops[i];
        ctx.beginPath();
        ctx.arc(dp.x, dp.y, dp.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(214, 234, 255, ' + (dp.a * 0.35).toFixed(3) + ')';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(dp.x - dp.r * 0.3, dp.y - dp.r * 0.32, dp.hl, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, ' + (dp.a * 0.75).toFixed(3) + ')';
        ctx.fill();
      }
    }

    function drawButterfly(x, y, size, angle, alpha, flap) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.globalAlpha = alpha;
      var f = 0.82 + 0.18 * Math.sin(flap);
      ctx.fillStyle = 'rgba(170, 205, 240, 0.9)';
      ctx.beginPath(); ctx.ellipse(-size * 0.34 * f, -size * 0.18, size * 0.36 * f, size * 0.46, -0.42, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(size * 0.34 * f, -size * 0.18, size * 0.36 * f, size * 0.46, 0.42, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(130, 168, 212, 0.85)';
      ctx.beginPath(); ctx.ellipse(-size * 0.22 * f, size * 0.3, size * 0.24 * f, size * 0.3, -0.22, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(size * 0.22 * f, size * 0.3, size * 0.24 * f, size * 0.3, 0.22, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(235, 244, 255, 0.9)';
      ctx.beginPath(); ctx.ellipse(0, 0, size * 0.045, size * 0.4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    function drawButterflies(dt, now) {
      for (var i = 0; i < butterflies.length; i++) {
        var bf = butterflies[i];
        bf.x += bf.vx * dt; bf.y += bf.vy * dt;
        bf.angle += Math.sin(now / 1000 + bf.phase) * 0.004;
        if (bf.x < -100) bf.x = W + 100;
        if (bf.x > W + 100) bf.x = -100;
        if (bf.y < -80) bf.y = H + 80;
        if (bf.y > H + 80) bf.y = -80;
        drawButterfly(bf.x, bf.y, bf.size, bf.angle, bf.alpha, (now / 1000) * bf.speed + bf.phase);
      }
    }

    function drawInks() {
      for (var i = 0; i < inks.length; i++) {
        var ink = inks[i];
        var g = ctx.createRadialGradient(ink.x, ink.y, 0, ink.x, ink.y, ink.r);
        g.addColorStop(0, 'rgba(14, 40, 74, ' + (ink.alpha * 0.8).toFixed(3) + ')');
        g.addColorStop(0.55, 'rgba(24, 56, 94, ' + (ink.alpha * 0.4).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(32, 68, 110, 0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(ink.x, ink.y, ink.r, 0, Math.PI * 2); ctx.fill();
      }
    }

    function drawChars() {
      for (var i = 0; i < chars.length; i++) {
        var c = chars[i];
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, c.alpha));
        ctx.translate(c.x, c.y);
        ctx.rotate(c.rot);
        ctx.font = '700 ' + c.size + 'px "Microsoft YaHei", "PingFang SC", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // 深蓝背景上用白字 + 深色描边，最清晰
        ctx.shadowColor = 'rgba(8, 26, 52, 0.95)';
        ctx.shadowBlur = 14;
        ctx.strokeStyle = 'rgba(10, 28, 54, 0.9)';
        ctx.lineWidth = 3.4;
        ctx.strokeText(c.ch, 0, 0);
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(c.ch, 0, 0);
        ctx.restore();
      }
    }

    // ===== 水面 =====
    var t = 0, acc = 0, last = performance.now(), raf = 0, running = true;

    function poke(cx, cy, str, rad) {
      cx |= 0; cy |= 0;
      var r2 = rad * rad, RAD = Math.ceil(rad);
      for (var y = -RAD; y <= RAD; y++) {
        for (var x = -RAD; x <= RAD; x++) {
          var px = cx + x, py = cy + y;
          if (px < 1 || py < 1 || px >= SW - 1 || py >= SH - 1) continue;
          var f = (x * x + y * y) / r2;
          if (f > 1) continue;
          h1[py * SW + px] += str * (0.5 + 0.5 * Math.cos(Math.PI * Math.sqrt(f)));
        }
      }
    }

    function stepWater() {
      t += 0.0333;
      for (var y = 1; y < SH - 1; y++) {
        var i = y * SW + 1;
        for (var x = 1; x < SW - 1; x++, i++) {
          h2[i] = ((h1[i - 1] + h1[i + 1] + h1[i - SW] + h1[i + SW]) * 0.5 - h2[i]) * DAMP
            + 0.0024 * Math.sin(t * 0.7 + x * 0.05 + y * 0.021)
            + 0.0019 * Math.sin(t * 0.43 - x * 0.023 + y * 0.041);
        }
      }
      var tmp = h1; h1 = h2; h2 = tmp;
    }

    function renderWater() {
      // 水波幅度大幅缩小：GAIN 95 / CAP 70
      var GAIN = 95, CAP = 70;
      var dst = outImg.data, h = h1;
      for (var y = 0; y < SH; y++) {
        var yu = y > 0 ? y - 1 : y, yd = y < SH - 1 ? y + 1 : y;
        for (var x = 0; x < SW; x++) {
          var i = y * SW + x;
          var xl = x > 0 ? i - 1 : i, xr = x < SW - 1 ? i + 1 : i;
          var gy = h[yu * SW + x] - h[yd * SW + x];
          var di = i * 4;
          var a = gy * GAIN;
          if (a >= 0) {
            dst[di] = 16; dst[di + 1] = 44; dst[di + 2] = 82;
            dst[di + 3] = (a > CAP ? CAP : a) | 0;
          } else {
            a = -a;
            dst[di] = 255; dst[di + 1] = 255; dst[di + 2] = 255;
            dst[di + 3] = (a > CAP ? CAP : a) | 0;
          }
        }
      }
      simCtx.putImageData(outImg, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(sim, 0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }

    function loop(now) {
      if (!running) return;
      raf = requestAnimationFrame(loop);
      var dt = (now - last) / 1000;
      last = now;
      if (dt > 0.2) dt = 0.2;
      acc += dt;
      var n = 0;
      while (acc >= STEP && n < 2) { stepWater(); acc -= STEP; n++; }

      var playing = opts.getPlaying ? opts.getPlaying() : true;
      if (playing) updateLyrics(dt);

      drawBackdrop();
      renderWater();
      drawRain(dt);
      drawDrops();
      drawBeads(dt);
      // 背景图本身已有蝴蝶，不再叠加程序蝴蝶（避免重复）
      drawInks();
      drawChars();
    }

    // ===== 鼠标 / 触摸交互（水波范围缩小） =====
    var dragging = false;
    function toSim(clientX, clientY) {
      var r2 = cv.getBoundingClientRect();
      return [Math.round(((clientX - r2.left) / r2.width) * SW), Math.round(((clientY - r2.top) / r2.height) * SH)];
    }
    function onPointer(e) {
      if (!dragging && e.type !== 'pointerdown') return;
      var p = toSim(e.clientX, e.clientY);
      poke(p[0], p[1], e.type === 'pointerdown' ? 1.6 : 0.8, e.type === 'pointerdown' ? 3.5 : 2.5);
    }
    cv.addEventListener('pointerdown', function (e) { dragging = true; try { cv.setPointerCapture(e.pointerId); } catch (_) {} onPointer(e); });
    cv.addEventListener('pointermove', onPointer);
    cv.addEventListener('pointerup', function () { dragging = false; });
    cv.addEventListener('pointercancel', function () { dragging = false; });
    cv.addEventListener('pointerleave', function () { dragging = false; });

    var pokeTimer = setInterval(function () {
      if (!running) return;
      if (opts.getPlaying && !opts.getPlaying()) return;
      poke(R(SW * 0.2, SW * 0.8), R(SH * 0.2, SH * 0.8), R(0.35, 0.7), R(1.5, 3));
    }, 1400);

    for (var k = 0; k < 2; k++) poke(R(SW * 0.3, SW * 0.7), R(SH * 0.3, SH * 0.7), 0.9, R(2, 4));

    state = {
      cv: cv, raf: 0, pokeTimer: pokeTimer, poke: poke, SW: SW, SH: SH, running: true,
      resetLyrics: resetLyrics, setLyrics: resetLyrics,
      getState: function () {
        return { chars: chars.length, inks: inks.length, pending: pending.length, cursor: lyricCursor,
          lastTime: lastTime, waterY: waterY, drops: drops.length, rain: rain.length, beads: beads.length,
          butterflies: butterflies.length, bgReady: bgReady };
      }
    };
    state.raf = requestAnimationFrame(loop);
    return state;
  }

  function setLyrics(lines) {
    if (state && state.setLyrics) state.setLyrics(lines);
  }

  function unmount() {
    if (!state) return;
    state.running = false;
    try { cancelAnimationFrame(state.raf); } catch (e) {}
    try { clearInterval(state.pokeTimer); } catch (e) {}
    try { if (state.cv && state.cv.parentNode) state.cv.parentNode.removeChild(state.cv); } catch (e) {}
    state = null;
  }

  window.GlassWater = { mount: mount, unmount: unmount, setLyrics: setLyrics, getState: function () { return state ? state.getState() : null; } };
})();
