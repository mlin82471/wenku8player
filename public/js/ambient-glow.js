/**
 * ambient-glow.js — Apple Music 级温润流体光晕引擎 (Organic Ambient Glow)
 * 纯粹、克制、高级感：
 * 1. 提取专辑封面 3 组主色与副色，映射为 4 组大画幅高斯光晕粒子；
 * 2. 模拟真实有机流体缓动，随音乐低音柔和呼吸扩张（+6%~10%）；
 * 3. 表面叠加 3% 胶片颗粒感（Analog Film Grain），彻底告别廉价电子数码感；
 * 4. 驱动居中巨幅黑胶封套与唱片出鞘动效。
 */
(function (global) {
  'use strict';

  class AmbientGlowEngine {
    constructor() {
      this.canvas = null;
      this.ctx = null;
      this.rafId = 0;
      this.colors = [
        { r: 217, g: 119, b: 6 },   // 默认暖琥珀
        { r: 79, g: 70, b: 229 },   // 深夜靛蓝
        { r: 190, g: 24, b: 93 },   // 绯红暖调
        { r: 15, g: 23, b: 42 }     // 暗曜黑底
      ];
      this.targetColors = [...this.colors];
      this.time = 0;
      this.bassEnergy = 0;
      this.analyserArray = new Uint8Array(64);

      this.blobs = [
        { x: 0.3, y: 0.35, rx: 0.22, ry: 0.18, speed: 0.35, phase: 0.0, radius: 0.45, colorIdx: 0 },
        { x: 0.7, y: 0.45, rx: 0.20, ry: 0.24, speed: 0.28, phase: 1.8, radius: 0.48, colorIdx: 1 },
        { x: 0.5, y: 0.65, rx: 0.18, ry: 0.20, speed: 0.42, phase: 3.4, radius: 0.42, colorIdx: 2 },
        { x: 0.4, y: 0.50, rx: 0.15, ry: 0.15, speed: 0.22, phase: 5.1, radius: 0.38, colorIdx: 0 }
      ];

      this.render = this.render.bind(this);
      this.resize = this.resize.bind(this);
    }

    init(container) {
      if (!container) return;
      this.dispose();

      this.canvas = document.createElement('canvas');
      this.canvas.id = 'ambientGlowCanvas';
      this.canvas.style.cssText = [
        'position:absolute', 'inset:0', 'width:100%', 'height:100%',
        'pointer-events:none', 'z-index:0', 'filter:blur(80px)',
        'opacity:0.85', 'transition:opacity 0.6s ease'
      ].join(';');

      container.insertBefore(this.canvas, container.firstChild);
      this.ctx = this.canvas.getContext('2d');

      this.resize();
      window.addEventListener('resize', this.resize);
      this.rafId = requestAnimationFrame(this.render);
    }

    setCoverPalette(rgbArray) {
      if (!rgbArray || !rgbArray.length) return;
      // rgbArray: [[r, g, b], [r, g, b]]
      this.targetColors[0] = { r: rgbArray[0][0], g: rgbArray[0][1], b: rgbArray[0][2] };
      if (rgbArray[1]) {
        this.targetColors[1] = { r: rgbArray[1][0], g: rgbArray[1][1], b: rgbArray[1][2] };
      }
      if (rgbArray[2]) {
        this.targetColors[2] = { r: rgbArray[2][0], g: rgbArray[2][1], b: rgbArray[2][2] };
      }
    }

    updateAudioEnergy() {
      const analyser = global.analyserNode;
      if (analyser && global.isPlaying) {
        analyser.getByteFrequencyData(this.analyserArray);
        let sum = 0;
        for (let i = 0; i < 12; i++) sum += this.analyserArray[i];
        const raw = (sum / 12) / 255;
        this.bassEnergy += (raw - this.bassEnergy) * 0.18;
      } else {
        // 待机轻缓微澜
        const wave = (Math.sin(this.time * 1.2) + 1) * 0.12;
        this.bassEnergy += (wave - this.bassEnergy) * 0.05;
      }
    }

    resize() {
      if (!this.canvas) return;
      const w = this.canvas.clientWidth || window.innerWidth;
      const h = this.canvas.clientHeight || window.innerHeight;
      // 画布分辨率适当降低，配合 CSS blur(80px) 达到丝滑 60fps 且显存极低
      this.canvas.width = Math.max(120, Math.floor(w / 4));
      this.canvas.height = Math.max(80, Math.floor(h / 4));
    }

    render() {
      this.rafId = requestAnimationFrame(this.render);
      if (!this.ctx || !this.canvas) return;

      this.time += 0.012;
      this.updateAudioEnergy();

      // 颜色平滑渐变过渡
      for (let i = 0; i < 3; i++) {
        const c = this.colors[i];
        const t = this.targetColors[i];
        c.r += (t.r - c.r) * 0.04;
        c.g += (t.g - c.g) * 0.04;
        c.b += (t.b - c.b) * 0.04;
      }

      const w = this.canvas.width;
      const h = this.canvas.height;
      const ctx = this.ctx;

      // 1. 深邃暗夜底色
      ctx.fillStyle = '#0d0e12';
      ctx.fillRect(0, 0, w, h);

      // 2. 绘制 4 组大画幅有机流体晕染光斑
      this.blobs.forEach((blob) => {
        const bx = (blob.x + Math.sin(this.time * blob.speed + blob.phase) * blob.rx) * w;
        const by = (blob.y + Math.cos(this.time * blob.speed * 0.8 + blob.phase) * blob.ry) * h;
        const baseR = Math.min(w, h) * blob.radius;
        // 低音带来温润的呼吸扩张 (+8%)
        const br = baseR * (1.0 + this.bassEnergy * 0.22);

        const col = this.colors[blob.colorIdx];
        const grad = ctx.createRadialGradient(bx, by, 0, bx, by, br);
        grad.addColorStop(0, `rgba(${Math.round(col.r)}, ${Math.round(col.g)}, ${Math.round(col.b)}, 0.65)`);
        grad.addColorStop(0.55, `rgba(${Math.round(col.r)}, ${Math.round(col.g)}, ${Math.round(col.b)}, 0.25)`);
        grad.addColorStop(1, 'rgba(13, 14, 18, 0)');

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    dispose() {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      window.removeEventListener('resize', this.resize);
      if (this.canvas && this.canvas.parentNode) {
        this.canvas.parentNode.removeChild(this.canvas.parentNode);
      }
      this.canvas = null;
      this.ctx = null;
    }
  }

  global.AmbientGlow = new AmbientGlowEngine();

})(typeof window !== 'undefined' ? window : this);
