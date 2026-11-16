/**
 * rain-bokeh.js — 新海诚风格【雨夜便利店 · 散景光斑与水波微澜】动效引擎
 * 
 * 核心美学：
 * 1. 深度沉浸的深夜暗调背景 (#0a0b0e)，隔着落地雨夜玻璃的模糊夜景；
 * 2. 24 颗漂浮的柔和散景光斑 (Bokeh Orbs)，取色于街灯暖杏、尾灯绯红、便利店青蓝与雨雾夜色；
 * 3. 玻璃雨滴与雨雾滑落 (Raindrops on Glass)；
 * 4. 音乐低音节拍触发【水波微澜】(Concentric Water Ripples)，如雨滴落入宁静夜雨水洼；
 * 5. 鼠标滑动产生温润的水汽互动光痕。
 */
(function (global) {
  'use strict';

  class ShinkaiRainBokehEngine {
    constructor() {
      this.canvas = null;
      this.ctx = null;
      this.rafId = 0;
      this.time = 0;
      this.w = 0;
      this.h = 0;

      // 散景暖色色板 (雨夜街道色系：暖杏、路灯黄、便利店薄荷青、尾灯暖绯、深夜黛蓝)
      this.palette = [
        { r: 245, g: 158, b: 11, a: 0.28 }, // 暖杏街灯
        { r: 217, g: 119, b: 6, a: 0.22 },  // 焦糖微光
        { r: 225, g: 29, b: 72, a: 0.18 },  // 尾灯绯红
        { r: 6, g: 182, b: 212, a: 0.20 },  // 便利店冷青
        { r: 59, g: 130, b: 246, a: 0.22 }, // 雨雾薄蓝
        { r: 168, g: 85, b: 247, a: 0.15 }  // 霓虹紫晕
      ];

      // 散景光斑粒子 (24 颗)
      this.orbs = [];
      // 玻璃雨滴粒子
      this.drops = [];
      // 音频响应产生的水波微澜
      this.ripples = [];

      // 音频分析
      this.bassEnergy = 0;
      this.lastBeatTime = 0;
      this.analyserArray = new Uint8Array(64);

      // 鼠标交互
      this.mouseX = -1000;
      this.mouseY = -1000;

      this.render = this.render.bind(this);
      this.resize = this.resize.bind(this);
      this.onPointerMove = this.onPointerMove.bind(this);
    }

    init(container) {
      if (!container) return;
      this.dispose();

      this.canvas = document.createElement('canvas');
      this.canvas.id = 'shinkaiRainCanvas';
      this.canvas.style.cssText = [
        'position:absolute', 'inset:0', 'width:100%', 'height:100%',
        'pointer-events:none', 'z-index:0',
        'opacity:0.92', 'transition:opacity 0.6s ease'
      ].join(';');

      container.insertBefore(this.canvas, container.firstChild);
      this.ctx = this.canvas.getContext('2d');

      this.resize();
      this.createOrbs();
      this.createRaindrops();

      window.addEventListener('resize', this.resize);
      window.addEventListener('pointermove', this.onPointerMove);

      this.rafId = requestAnimationFrame(this.render);
      console.log('[Shinkai Rain & Bokeh] 引擎已唤醒：雨夜落地窗与水波微澜就绪');
    }

    createOrbs() {
      this.orbs = [];
      const count = 22;
      for (let i = 0; i < count; i++) {
        const col = this.palette[i % this.palette.length];
        this.orbs.push({
          x: Math.random() * this.w,
          y: Math.random() * this.h,
          vx: (Math.random() - 0.5) * 0.25,
          vy: -0.15 - Math.random() * 0.35, // 缓慢向上轻微漂浮或随雨气流动
          baseR: 45 + Math.random() * 110,
          currentR: 45 + Math.random() * 110,
          col: col,
          pulseSpeed: 0.8 + Math.random() * 1.4,
          phase: Math.random() * Math.PI * 2
        });
      }
    }

    createRaindrops() {
      this.drops = [];
      const count = 38;
      for (let i = 0; i < count; i++) {
        this.drops.push({
          x: Math.random() * this.w,
          y: Math.random() * this.h,
          len: 12 + Math.random() * 28,
          speed: 1.2 + Math.random() * 2.8,
          width: 0.8 + Math.random() * 1.2,
          opacity: 0.15 + Math.random() * 0.35
        });
      }
    }

    onPointerMove(e) {
      if (!this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      this.mouseX = (e.clientX - rect.left) * (this.w / rect.width);
      this.mouseY = (e.clientY - rect.top) * (this.h / rect.height);
    }

    resize() {
      if (!this.canvas) return;
      const rect = this.canvas.parentElement ? this.canvas.parentElement.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight };
      this.w = this.canvas.width = Math.max(300, rect.width);
      this.h = this.canvas.height = Math.max(300, rect.height);
      if (this.orbs.length === 0) this.createOrbs();
    }

    setCoverPalette(rgbArray) {
      if (!rgbArray || !rgbArray.length) return;
      // 用专辑当前颜色替换前三个主色
      this.palette[0] = { r: rgbArray[0][0], g: rgbArray[0][1], b: rgbArray[0][2], a: 0.28 };
      if (rgbArray[1]) {
        this.palette[1] = { r: rgbArray[1][0], g: rgbArray[1][1], b: rgbArray[1][2], a: 0.22 };
      }
      if (rgbArray[2]) {
        this.palette[2] = { r: rgbArray[2][0], g: rgbArray[2][1], b: rgbArray[2][2], a: 0.20 };
      }
      // 同步给现有 orbs
      this.orbs.forEach((orb, i) => {
        orb.col = this.palette[i % this.palette.length];
      });
    }

    triggerWaterRipple(x, y, maxR = 140) {
      this.ripples.push({
        x: x !== undefined ? x : this.w * (0.35 + Math.random() * 0.3),
        y: y !== undefined ? y : this.h * (0.35 + Math.random() * 0.3),
        r: 4,
        maxR: maxR,
        speed: 1.8 + Math.random() * 1.2,
        opacity: 0.55
      });
    }

    updateAudio() {
      const analyser = global.analyserNode;
      const now = performance.now();

      if (analyser && global.isPlaying) {
        analyser.getByteFrequencyData(this.analyserArray);
        let bassSum = 0;
        for (let i = 0; i < 10; i++) bassSum += this.analyserArray[i];
        const rawBass = (bassSum / 10) / 255;
        this.bassEnergy += (rawBass - this.bassEnergy) * 0.22;

        // 节拍触发水滴泛开波澜 (每次间隔至少 550ms，保持宁静与克制)
        if (rawBass > 0.42 && (now - this.lastBeatTime > 550)) {
          this.lastBeatTime = now;
          this.triggerWaterRipple();
        }
      } else {
        // 静止呼吸
        this.bassEnergy = (Math.sin(this.time * 1.5) + 1) * 0.12;
        if (Math.random() < 0.008) {
          this.triggerWaterRipple();
        }
      }
    }

    render() {
      this.rafId = requestAnimationFrame(this.render);
      if (!this.ctx || !this.canvas) return;

      this.time += 0.015;
      this.updateAudio();

      const ctx = this.ctx;
      const w = this.w;
      const h = this.h;

      // 1. 深夜微雨夜空清屏 (深曜黛蓝底)
      ctx.fillStyle = '#0b0c10';
      ctx.fillRect(0, 0, w, h);

      // 2. 绘制散景光斑 (Bokeh Orbs)
      ctx.save();
      ctx.globalCompositeOperation = 'screen';

      this.orbs.forEach((orb) => {
        orb.x += orb.vx;
        orb.y += orb.vy;

        // 循环回绕
        if (orb.y < -orb.baseR) { orb.y = h + orb.baseR; orb.x = Math.random() * w; }
        if (orb.x < -orb.baseR) orb.x = w + orb.baseR;
        if (orb.x > w + orb.baseR) orb.x = -orb.baseR;

        // 呼吸脉冲与低音轻微扩张
        const breath = Math.sin(this.time * orb.pulseSpeed + orb.phase) * 0.08;
        const r = orb.baseR * (1.0 + breath + this.bassEnergy * 0.25);

        // 鼠标排斥微风
        const dx = orb.x - this.mouseX;
        const dy = orb.y - this.mouseY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 180) {
          const force = (180 - dist) / 180;
          orb.x += (dx / dist) * force * 1.5;
          orb.y += (dy / dist) * force * 1.5;
        }

        const col = orb.col;
        const grad = ctx.createRadialGradient(orb.x, orb.y, 0, orb.x, orb.y, r);
        const alpha = col.a * (0.8 + this.bassEnergy * 0.35);

        grad.addColorStop(0, `rgba(${col.r}, ${col.g}, ${col.b}, ${alpha})`);
        grad.addColorStop(0.55, `rgba(${col.r}, ${col.g}, ${col.b}, ${alpha * 0.45})`);
        grad.addColorStop(1, 'rgba(11, 12, 16, 0)');

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(orb.x, orb.y, r, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();

      // 3. 绘制落地窗雨丝与滑落雨滴
      ctx.save();
      this.drops.forEach((d) => {
        d.y += d.speed;
        if (d.y > h + d.len) {
          d.y = -d.len;
          d.x = Math.random() * w;
        }

        ctx.strokeStyle = `rgba(255, 255, 255, ${d.opacity})`;
        ctx.lineWidth = d.width;
        ctx.lineCap = 'round';

        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - 0.5, d.y + d.len);
        ctx.stroke();
      });
      ctx.restore();

      // 4. 绘制水波微澜 (Water Ripples)
      ctx.save();
      for (let i = this.ripples.length - 1; i >= 0; i--) {
        const rip = this.ripples[i];
        rip.r += rip.speed;
        const progress = rip.r / rip.maxR;
        const curAlpha = rip.opacity * Math.pow(1 - progress, 1.8);

        if (progress >= 1.0) {
          this.ripples.splice(i, 1);
          continue;
        }

        // 双层涟漪环 (内环微亮，外环扩散)
        ctx.strokeStyle = `rgba(224, 231, 255, ${curAlpha * 0.75})`;
        ctx.lineWidth = 1.2 * (1 - progress);
        ctx.beginPath();
        ctx.arc(rip.x, rip.y, rip.r, 0, Math.PI * 2);
        ctx.stroke();

        if (rip.r > 12) {
          ctx.strokeStyle = `rgba(255, 255, 255, ${curAlpha * 0.4})`;
          ctx.lineWidth = 0.8 * (1 - progress);
          ctx.beginPath();
          ctx.arc(rip.x, rip.y, rip.r - 8, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    dispose() {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      window.removeEventListener('resize', this.resize);
      window.removeEventListener('pointermove', this.onPointerMove);

      if (this.canvas && this.canvas.parentNode) {
        this.canvas.parentNode.removeChild(this.canvas.parentNode);
      }
      this.canvas = null;
      this.ctx = null;
      this.ripples = [];
      this.orbs = [];
      this.drops = [];
    }
  }

  global.ShinkaiRainBokeh = new ShinkaiRainBokehEngine();

})(typeof window !== 'undefined' ? window : this);
