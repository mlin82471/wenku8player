/**
 * Folia Dual-Engine Visualizer (v3.0)
 * 专用动效引擎：
 * 1. Halo 机械时计齿轮与点阵光影 (Halo Clockwork Dither)
 * 2. K3Panel 商籁几何动力学排版 (Sonnet Kinetic Typography)
 */
(function (global) {
  'use strict';

  // 1. 经典配色预设
  const THEMES = {
    dark: {
      bg: '#0a0b0e',
      gearColor: 'rgba(255, 255, 255, 0.45)',
      gearHighlight: 'rgba(217, 70, 239, 0.85)',
      arrowColor: '#e11d48',
      textColor: '#ffffff',
      subTextColor: 'rgba(255, 255, 255, 0.6)',
      accent: '#06b6d4',
      ambientA: 'rgba(225, 29, 72, 0.18)',
      ambientB: 'rgba(6, 182, 212, 0.18)'
    },
    monet: {
      bg: '#0c0e12',
      gearColor: 'rgba(226, 232, 240, 0.4)',
      gearHighlight: 'rgba(244, 114, 182, 0.85)',
      arrowColor: '#f43f5e',
      textColor: '#ffffff',
      subTextColor: 'rgba(226, 232, 240, 0.6)',
      accent: '#2dd4bf',
      ambientA: 'rgba(244, 114, 182, 0.16)',
      ambientB: 'rgba(45, 212, 191, 0.16)'
    }
  };

  // 2. Halo 机械时钟齿轮与点阵渲染器
  class HaloClockworkRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.angle = 0;
      this.ditherPattern = this.createDitherPattern();
    }

    createDitherPattern() {
      const pCvs = document.createElement('canvas');
      pCvs.width = 4;
      pCvs.height = 4;
      const pCtx = pCvs.getContext('2d');
      pCtx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      pCtx.fillRect(0, 0, 4, 4);
      pCtx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      // 4x4 Bayer matrix ordered dither points
      pCtx.fillRect(0, 0, 1, 1);
      pCtx.fillRect(2, 2, 1, 1);
      pCtx.fillRect(2, 0, 1, 1);
      pCtx.fillRect(0, 2, 1, 1);
      return this.ctx.createPattern(pCvs, 'repeat');
    }

    resize() {
      const w = this.canvas.clientWidth || window.innerWidth;
      const h = this.canvas.clientHeight || window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      if (this.canvas.width !== Math.floor(w * dpr) || this.canvas.height !== Math.floor(h * dpr)) {
        this.canvas.width = Math.floor(w * dpr);
        this.canvas.height = Math.floor(h * dpr);
      }
    }

    drawGear(cx, cy, outerR, innerR, teeth, angle, color, strokeW = 1.5) {
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.strokeStyle = color;
      ctx.lineWidth = strokeW;

      ctx.beginPath();
      const step = (Math.PI * 2) / teeth;
      for (let i = 0; i < teeth; i++) {
        const a0 = i * step;
        const a1 = a0 + step * 0.28;
        const a2 = a0 + step * 0.42;
        const a3 = a0 + step * 0.72;
        const a4 = a0 + step * 0.86;
        ctx.arc(0, 0, innerR, a0, a1);
        ctx.lineTo(Math.cos(a2) * outerR, Math.sin(a2) * outerR);
        ctx.arc(0, 0, outerR, a2, a3);
        ctx.lineTo(Math.cos(a4) * innerR, Math.sin(a4) * innerR);
      }
      ctx.closePath();
      ctx.stroke();

      // 内层同心圆
      ctx.beginPath();
      ctx.arc(0, 0, innerR * 0.62, 0, Math.PI * 2);
      ctx.stroke();

      // 6 辐条
      ctx.beginPath();
      for (let s = 0; s < 6; s++) {
        const sa = (s * Math.PI) / 3;
        ctx.moveTo(Math.cos(sa) * innerR * 0.22, Math.sin(sa) * innerR * 0.22);
        ctx.lineTo(Math.cos(sa) * innerR * 0.62, Math.sin(sa) * innerR * 0.62);
      }
      ctx.stroke();

      // 中心轴承
      ctx.beginPath();
      ctx.arc(0, 0, innerR * 0.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, innerR * 0.08, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      ctx.restore();
    }

    drawClockTicks(cx, cy, r, color) {
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      for (let i = 0; i < 60; i++) {
        const a = (i * Math.PI * 2) / 60;
        const isMajor = i % 5 === 0;
        const len = isMajor ? 12 : 5;
        ctx.lineWidth = isMajor ? 1.8 : 1;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * (r - len), Math.sin(a) * (r - len));
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        ctx.stroke();
      }
      ctx.restore();
    }

    render(options) {
      this.resize();
      const ctx = this.ctx;
      const w = this.canvas.width;
      const h = this.canvas.height;
      ctx.clearRect(0, 0, w, h);

      const theme = options.theme || THEMES.dark;
      const power = options.audioPower || 0;
      const beat = options.beat ? 1 : 0;

      // 1. 底层流体光晕背景
      const bgGrad = ctx.createLinearGradient(0, 0, w, h);
      bgGrad.addColorStop(0, '#07090e');
      bgGrad.addColorStop(0.5, '#0a0d14');
      bgGrad.addColorStop(1, '#080a0f');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      // 极光弥散斑
      const pulseR = (1 + power * 0.25);
      const rad1 = ctx.createRadialGradient(w * 0.22, h * 0.45, 0, w * 0.22, h * 0.45, Math.min(w, h) * 0.55 * pulseR);
      rad1.addColorStop(0, theme.ambientA);
      rad1.addColorStop(0.65, 'rgba(217, 70, 239, 0.05)');
      rad1.addColorStop(1, 'transparent');
      ctx.fillStyle = rad1;
      ctx.fillRect(0, 0, w, h);

      const rad2 = ctx.createRadialGradient(w * 0.75, h * 0.55, 0, w * 0.75, h * 0.55, Math.min(w, h) * 0.6 * pulseR);
      rad2.addColorStop(0, theme.ambientB);
      rad2.addColorStop(0.7, 'rgba(6, 182, 212, 0.04)');
      rad2.addColorStop(1, 'transparent');
      ctx.fillStyle = rad2;
      ctx.fillRect(0, 0, w, h);

      // 2. 旋转角度随音乐播放与时间平滑累加
      const dt = 0.012 + power * 0.015;
      this.angle += dt;

      // 3. 左侧巨幅机械齿轮传动系统 (Halo Mechanism)
      const gearBaseX = w * 0.24;
      const gearBaseY = h * 0.48;
      const scale = Math.min(w, h) / 900;

      // 主大齿轮 (Main 36-tooth Drive Gear)
      const mainR = 190 * scale;
      this.drawClockTicks(gearBaseX, gearBaseY, mainR + 24 * scale, 'rgba(255, 255, 255, 0.25)');
      this.drawGear(gearBaseX, gearBaseY, mainR, mainR * 0.82, 36, this.angle * 0.5, theme.gearColor, 1.6);

      // 从动小齿轮 (Meshing 18-tooth Gear - 逆时针2倍速)
      const subR = 95 * scale;
      const subX = gearBaseX + (mainR + subR - 3 * scale) * Math.cos(Math.PI * 0.28);
      const subY = gearBaseY + (mainR + subR - 3 * scale) * Math.sin(Math.PI * 0.28);
      this.drawGear(subX, subY, subR, subR * 0.8, 18, -this.angle * 1.0, theme.gearHighlight, 1.4);

      // 上方微型擒纵轮 (12-tooth Escapement)
      const escR = 60 * scale;
      const escX = gearBaseX - 140 * scale;
      const escY = gearBaseY - 150 * scale;
      this.drawGear(escX, escY, escR, escR * 0.75, 12, this.angle * 1.5, 'rgba(6, 182, 212, 0.6)', 1.2);

      // 4. 水平精密指示指针（从主齿轮中心指向右侧当前播放歌词行）
      ctx.save();
      ctx.translate(gearBaseX, gearBaseY);
      const ptrLen = w * 0.48;
      ctx.strokeStyle = theme.arrowColor;
      ctx.lineWidth = 1.8;
      ctx.shadowColor = theme.arrowColor;
      ctx.shadowBlur = 12 * (1 + beat * 0.8);

      ctx.beginPath();
      ctx.moveTo(mainR * 0.25, 0);
      ctx.lineTo(ptrLen, 0);
      ctx.stroke();

      // 指针箭头尖端
      ctx.fillStyle = theme.arrowColor;
      ctx.beginPath();
      ctx.moveTo(ptrLen + 10 * scale, 0);
      ctx.lineTo(ptrLen - 2 * scale, -5 * scale);
      ctx.lineTo(ptrLen - 2 * scale, 5 * scale);
      ctx.closePath();
      ctx.fill();

      // 刻度标尺点
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      for (let k = 1; k < 6; k++) {
        ctx.fillRect(mainR * 0.35 + k * 45 * scale, -2, 2, 4);
      }
      ctx.restore();

      // 5. 1-Bit 点阵抖动质感层（Ordered Dither Overlay）
      if (this.ditherPattern) {
        ctx.fillStyle = this.ditherPattern;
        ctx.fillRect(0, 0, w, h);
      }
    }
  }

  // 3. K3Panel 商籁几何动力排版渲染器 (Sonnet Kinetic Typography & Y2K Geometry)
  class SonnetKineticRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.time = 0;
    }

    resize() {
      const w = this.canvas.clientWidth || window.innerWidth;
      const h = this.canvas.clientHeight || window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      if (this.canvas.width !== Math.floor(w * dpr) || this.canvas.height !== Math.floor(h * dpr)) {
        this.canvas.width = Math.floor(w * dpr);
        this.canvas.height = Math.floor(h * dpr);
      }
    }

    drawFlower(cx, cy, r, petals, angle, color) {
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      for (let i = 0; i < petals; i++) {
        const a = (i * Math.PI * 2) / petals;
        ctx.beginPath();
        ctx.ellipse(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55, r * 0.45, r * 0.16, a, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    render(options) {
      this.resize();
      const ctx = this.ctx;
      const w = this.canvas.width;
      const h = this.canvas.height;
      ctx.clearRect(0, 0, w, h);

      const power = options.audioPower || 0;
      const beat = options.beat ? 1 : 0;
      this.time += 0.015 + power * 0.02;

      // 1. 深色极简工业灰黑底
      ctx.fillStyle = '#08090c';
      ctx.fillRect(0, 0, w, h);

      // 2. 几何网格与十字标尺 (Y2K / Layout Grid)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1;
      const gridStep = 80;
      for (let x = 0; x < w; x += gridStep) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      for (let y = 0; y < h; y += gridStep) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      // 3. 四角几何十字星标与坐标
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
      ctx.lineWidth = 1.5;
      const corners = [
        [50, 50], [w - 50, 50], [50, h - 50], [w - 50, h - 50]
      ];
      for (let [cx, cy] of corners) {
        ctx.beginPath();
        ctx.moveTo(cx - 10, cy); ctx.lineTo(cx + 10, cy);
        ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy + 10);
        ctx.stroke();
      }

      // 4. 标志性线框花朵与同心圆环 (K3Panel Sonnet Motif)
      const scale = Math.min(w, h) / 850;
      const flowerR = (90 + power * 25) * scale;
      this.drawFlower(w * 0.82, h * 0.26, flowerR, 8, this.time * 0.6, 'rgba(244, 114, 182, 0.55)');
      this.drawFlower(w * 0.18, h * 0.72, flowerR * 0.75, 6, -this.time * 0.8, 'rgba(45, 212, 191, 0.45)');

      // 同心圆视差环
      ctx.save();
      ctx.translate(w * 0.5, h * 0.5);
      const ringR = (260 + power * 35) * scale;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, ringR, 0, Math.PI * 2);
      ctx.stroke();

      // 角度刻度小标签
      ctx.font = '10px monospace';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.fillText('[ THEME SONNET // K3PANEL DEEP TUNING ]', -140 * scale, ringR + 25);
      ctx.restore();

      // 5. RGB 色散故障微光 (Chromatic Aberration)
      if (beat || power > 0.4) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = 'rgba(244, 63, 94, 0.08)';
        ctx.fillRect(4, 0, w, h);
        ctx.fillStyle = 'rgba(6, 182, 212, 0.08)';
        ctx.fillRect(-4, 0, w, h);
        ctx.restore();
      }
    }
  }

  // 4. Folia Visualizer 统一管理器
  class FoliaVisualizerApp {
    constructor() {
      this.roots = new WeakMap();
      this.currentMode = 'off'; // 'off' | 'halo' | 'sonnet'
      this.currentThemeKey = 'dark';
    }

    mount(container, options = {}) {
      if (!container) return;
      let state = this.roots.get(container);
      if (!state) {
        state = this.createDom(container);
        this.roots.set(container, state);
      }
      this.render(container, options);
    }

    createDom(container) {
      container.innerHTML = '';
      container.className = 'folia-visualizer-root';

      const canvas = document.createElement('canvas');
      canvas.className = 'folia-vis-canvas';
      container.appendChild(canvas);

      // 动态巨幅歌词渲染层 (Lattice Dynamic Lyrics)
      const lyricsLayer = document.createElement('div');
      lyricsLayer.className = 'folia-dual-lyrics-stage';
      lyricsLayer.innerHTML = `
        <div class="folia-dual-lrc-past" id="foliaLrcPast"></div>
        <div class="folia-dual-lrc-active" id="foliaLrcActive">
          <div class="folia-dual-primary" id="foliaLrcPrimary">纯净音乐 · 唱响心声</div>
          <div class="folia-dual-secondary" id="foliaLrcSecondary">Wenku8 Audio Archive</div>
        </div>
        <div class="folia-dual-lrc-next" id="foliaLrcNext"></div>
      `;
      container.appendChild(lyricsLayer);

      const haloRenderer = new HaloClockworkRenderer(canvas);
      const sonnetRenderer = new SonnetKineticRenderer(canvas);

      return {
        canvas,
        lyricsLayer,
        haloRenderer,
        sonnetRenderer
      };
    }

    render(container, options = {}) {
      const state = this.roots.get(container);
      if (!state) return;

      const mode = options.mode || this.currentMode || 'off';
      this.currentMode = mode;
      const frame = options.frame || {};
      const lyrics = options.lyrics || [];

      // 封面原版模式下，清空画布退避
      if (mode === 'off') {
        state.canvas.style.display = 'none';
        state.lyricsLayer.style.display = 'none';
        return;
      }

      state.canvas.style.display = 'block';
      state.lyricsLayer.style.display = 'flex';

      const renderOpts = {
        audioPower: frame.audioPower || 0,
        beat: !!frame.beat,
        currentTime: frame.currentTime || 0,
        theme: THEMES[this.currentThemeKey] || THEMES.dark
      };

      if (mode === 'halo' || mode === 'classic' || mode === 'lumiere' || mode === 'diorama') {
        state.lyricsLayer.setAttribute('data-mode', 'halo');
        state.haloRenderer.render(renderOpts);
      } else if (mode === 'sonnet' || mode === 'tempera') {
        state.lyricsLayer.setAttribute('data-mode', 'sonnet');
        state.sonnetRenderer.render(renderOpts);
      }

      // 同步巨幅歌词
      this.syncLyrics(state, frame.currentTime || 0, lyrics);
    }

    syncLyrics(state, curTime, lyrics) {
      if (!lyrics || !lyrics.length) return;
      let activeIdx = 0;
      for (let i = 0; i < lyrics.length; i++) {
        if (curTime >= (lyrics[i].t || 0)) activeIdx = i;
      }

      const active = lyrics[activeIdx] || { l1: '', l2: '' };
      const past = lyrics[activeIdx - 1] || null;
      const next = lyrics[activeIdx + 1] || null;

      const pEl = state.lyricsLayer.querySelector('#foliaLrcPast');
      const a1El = state.lyricsLayer.querySelector('#foliaLrcPrimary');
      const a2El = state.lyricsLayer.querySelector('#foliaLrcSecondary');
      const nEl = state.lyricsLayer.querySelector('#foliaLrcNext');

      if (a1El && a1El.textContent !== active.l1) {
        a1El.textContent = active.l1 || '';
        a1El.style.animation = 'none';
        a1El.offsetHeight; // reflow
        a1El.style.animation = 'foliaTextPop 0.38s cubic-bezier(0.18, 0.89, 0.32, 1.28)';
      }
      if (a2El) {
        if (active.l2) {
          a2El.textContent = active.l2;
          a2El.style.display = 'block';
        } else {
          a2El.style.display = 'none';
        }
      }
      if (pEl) pEl.textContent = past ? past.l1 : '';
      if (nEl) nEl.textContent = next ? next.l1 : '';
    }

    unmount(container) {
      const state = this.roots.get(container);
      if (state) {
        container.innerHTML = '';
        this.roots.delete(container);
      }
    }
  }

  global.FoliaVisualizer = new FoliaVisualizerApp();

})(typeof window !== 'undefined' ? window : this);
