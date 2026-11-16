/**
 * rain-glass-engine.js — 忧郁雨夜玻璃窗与水滴滑落引擎 (Melancholy Rain on Glass)
 * 完美实现：雨滴在玻璃上滑落，后面是纯白歌词，参考网上爆款雨夜忧郁短视频
 * 
 * 物理分层架构：
 * [Layer 0: 窗外雨夜街景与暖调散景光斑 (Deep Night & Bokeh)]
 *       ↓
 * [Layer 2: 纯白唯美歌词 (Pure White Melancholy Typography)]
 *       ↓
 * [Layer 4: 玻璃表面滑动水滴与冷凝水痕 (3D Raindrops & Trickles in Front)]
 */
(function (global) {
  'use strict';

  class RainGlassEngine {
    constructor() {
      this.bgCanvas = null;
      this.bgCtx = null;
      this.glassCanvas = null;
      this.glassCtx = null;

      this.rafId = 0;
      this.time = 0;
      this.w = 0;
      this.h = 0;

      // 静态凝结小水珠 (贴在玻璃各处的细碎水珠)
      this.staticDrops = [];
      // 动态滑落大水滴 (重力驱动，带水痕轨迹)
      this.trickleDrops = [];
      // 远景雨夜街灯散景 (深景深虚化)
      this.bokehLights = [];

      this.bassEnergy = 0;
      this.analyserArray = new Uint8Array(64);
      this.lastTrickleTime = 0;

      this.render = this.render.bind(this);
      this.resize = this.resize.bind(this);
    }

    init(container) {
      if (!container) return;
      this.dispose();

      // 1. 创建窗外背景画布 (置于歌词下方 z-index: 0)
      this.bgCanvas = document.createElement('canvas');
      this.bgCanvas.id = 'rainBgCanvas';
      this.bgCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:0;';
      container.insertBefore(this.bgCanvas, container.firstChild);
      this.bgCtx = this.bgCanvas.getContext('2d');

      // 2. 创建玻璃水滴前景画布 (置于歌词上方 z-index: 3，带严格 pointer-events: none)
      this.glassCanvas = document.createElement('canvas');
      this.glassCanvas.id = 'rainGlassCanvas';
      this.glassCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none !important;z-index:3;';
      container.appendChild(this.glassCanvas);
      this.glassCtx = this.glassCanvas.getContext('2d');

      this.resize();
      this.initScene();

      window.addEventListener('resize', this.resize);
      this.rafId = requestAnimationFrame(this.render);
      console.log('[RainGlassEngine] 忧郁雨夜双层玻璃窗引擎已唤醒：水滴在歌词前方滑落');
    }

    initScene() {
      // 1. 远景街灯散景 (雨夜昏黄街灯、车尾灯、便利店冷光)
      this.bokehLights = [];
      const bokehColors = [
        { r: 245, g: 158, b: 11, a: 0.16 }, // 昏黄路灯
        { r: 217, g: 119, b: 6, a: 0.14 },  // 暖金橱窗
        { r: 14, g: 165, b: 233, a: 0.12 }, // 冷雨夜蓝
        { r: 225, g: 29, b: 72, a: 0.10 },  // 尾灯绯红
        { r: 99, g: 102, b: 241, a: 0.13 }  // 深邃夜空
      ];
      for (let i = 0; i < 18; i++) {
        const c = bokehColors[i % bokehColors.length];
        this.bokehLights.push({
          x: Math.random() * this.w,
          y: Math.random() * this.h,
          r: 55 + Math.random() * 130,
          color: c,
          vx: (Math.random() - 0.5) * 0.15,
          vy: -0.06 - Math.random() * 0.12,
          phase: Math.random() * Math.PI * 2
        });
      }

      // 2. 玻璃冷凝小水滴
      this.staticDrops = [];
      const staticCount = Math.floor((this.w * this.h) / 7500);
      for (let i = 0; i < Math.min(180, staticCount); i++) {
        this.staticDrops.push({
          x: Math.random() * this.w,
          y: Math.random() * this.h,
          r: 1.4 + Math.random() * 3.8,
          aspect: 0.88 + Math.random() * 0.28,
          alpha: 0.35 + Math.random() * 0.45
        });
      }

      // 3. 滑动大水滴 (8-12 颗正在滑落的雨滴)
      this.trickleDrops = [];
      for (let i = 0; i < 10; i++) {
        this.spawnTrickleDrop(Math.random() * this.w, Math.random() * (this.h * 0.7));
      }
    }

    spawnTrickleDrop(x, y) {
      this.trickleDrops.push({
        x: x !== undefined ? x : Math.random() * this.w,
        y: y !== undefined ? y : -15,
        r: 3.8 + Math.random() * 4.6,
        speed: 0.45 + Math.random() * 0.85,
        wiggleOffset: Math.random() * 100,
        trail: [],
        state: 'pause', // pause, creep, run (物理停顿与重力滑落)
        stateTimer: 20 + Math.random() * 60
      });
    }

    resize() {
      if (!this.bgCanvas || !this.glassCanvas) return;
      const rect = this.bgCanvas.parentElement ? this.bgCanvas.parentElement.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight };
      this.w = Math.max(300, rect.width);
      this.h = Math.max(300, rect.height);

      this.bgCanvas.width = this.w;
      this.bgCanvas.height = this.h;
      this.glassCanvas.width = this.w;
      this.glassCanvas.height = this.h;

      if (this.bokehLights.length === 0) this.initScene();
    }

    setCoverPalette(rgbArray) {
      if (!rgbArray || !rgbArray.length) return;
      // 用当前封面主色温润背景散景
      if (this.bokehLights.length > 0) {
        this.bokehLights[0].color = { r: rgbArray[0][0], g: rgbArray[0][1], b: rgbArray[0][2], a: 0.18 };
        if (rgbArray[1] && this.bokehLights.length > 1) {
          this.bokehLights[1].color = { r: rgbArray[1][0], g: rgbArray[1][1], b: rgbArray[1][2], a: 0.15 };
        }
      }
    }

    updateAudio() {
      const analyser = global.analyserNode;
      const now = performance.now();

      if (analyser && global.isPlaying) {
        analyser.getByteFrequencyData(this.analyserArray);
        let bassSum = 0;
        for (let i = 0; i < 8; i++) bassSum += this.analyserArray[i];
        const rawBass = (bassSum / 8) / 255;
        this.bassEnergy += (rawBass - this.bassEnergy) * 0.18;

        // 重低音共振：震落一颗雨滴
        if (rawBass > 0.46 && (now - this.lastTrickleTime > 1100)) {
          this.lastTrickleTime = now;
          this.spawnTrickleDrop();
        }
      } else {
        this.bassEnergy = (Math.sin(this.time * 1.2) + 1) * 0.08;
        if (Math.random() < 0.015 && this.trickleDrops.length < 12) {
          this.spawnTrickleDrop();
        }
      }
    }

    // 绘制具有真实 3D 折射与高光的通透水滴
    drawRealisticDrop(ctx, x, y, r, aspect = 1.0, alpha = 0.8) {
      ctx.save();
      ctx.translate(x, y);

      const ry = r * aspect;
      const rx = r;

      // 1. 水滴下方折射阴影
      ctx.fillStyle = `rgba(0, 0, 0, ${alpha * 0.45})`;
      ctx.beginPath();
      ctx.ellipse(0.6, ry * 0.35, rx * 0.95, ry * 0.75, 0, 0, Math.PI * 2);
      ctx.fill();

      // 2. 水滴清透水体
      const grad = ctx.createRadialGradient(-rx * 0.25, -ry * 0.25, 0, 0, 0, rx);
      grad.addColorStop(0, `rgba(255, 255, 255, ${alpha * 0.45})`);
      grad.addColorStop(0.6, `rgba(200, 220, 240, ${alpha * 0.22})`);
      grad.addColorStop(1, `rgba(30, 45, 60, ${alpha * 0.55})`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();

      // 3. 左上方高光弧光
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.95})`;
      ctx.beginPath();
      ctx.ellipse(-rx * 0.35, -ry * 0.35, rx * 0.36, ry * 0.24, -0.4, 0, Math.PI * 2);
      ctx.fill();

      // 4. 右下方透射微光
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.4})`;
      ctx.beginPath();
      ctx.ellipse(rx * 0.25, ry * 0.32, rx * 0.22, ry * 0.16, 0.4, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    render() {
      this.rafId = requestAnimationFrame(this.render);
      if (!this.bgCtx || !this.glassCtx) return;

      this.time += 0.012;
      this.updateAudio();

      const bgCtx = this.bgCtx;
      const glassCtx = this.glassCtx;
      const w = this.w;
      const h = this.h;

      // =====================================================================
      // 1. 绘制背景层 (深曜夜空与远景散景) -> 在纯白歌词下方
      // =====================================================================
      bgCtx.fillStyle = '#08090d';
      bgCtx.fillRect(0, 0, w, h);

      bgCtx.save();
      bgCtx.globalCompositeOperation = 'screen';
      this.bokehLights.forEach((light) => {
        light.x += light.vx;
        light.y += light.vy;
        if (light.y < -light.r) { light.y = h + light.r; light.x = Math.random() * w; }
        if (light.x < -light.r) light.x = w + light.r;
        if (light.x > w + light.r) light.x = -light.r;

        const pulse = Math.sin(this.time * 0.8 + light.phase) * 0.06;
        const curR = light.r * (1.0 + pulse + this.bassEnergy * 0.15);

        const col = light.color;
        const grad = bgCtx.createRadialGradient(light.x, light.y, 0, light.x, light.y, curR);
        grad.addColorStop(0, `rgba(${col.r}, ${col.g}, ${col.b}, ${col.a * 1.35})`);
        grad.addColorStop(0.5, `rgba(${col.r}, ${col.g}, ${col.b}, ${col.a * 0.5})`);
        grad.addColorStop(1, 'rgba(8, 9, 13, 0)');

        bgCtx.fillStyle = grad;
        bgCtx.beginPath();
        bgCtx.arc(light.x, light.y, curR, 0, Math.PI * 2);
        bgCtx.fill();
      });
      bgCtx.restore();

      // =====================================================================
      // 2. 绘制前景玻璃层 (水痕与水滴) -> 在纯白歌词上方！
      // =====================================================================
      glassCtx.clearRect(0, 0, w, h);

      // (A) 绘制滑落水痕
      glassCtx.save();
      this.trickleDrops.forEach((d) => {
        if (d.trail.length > 2) {
          glassCtx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
          glassCtx.lineWidth = d.r * 0.75;
          glassCtx.lineCap = 'round';
          glassCtx.lineJoin = 'round';
          glassCtx.beginPath();
          glassCtx.moveTo(d.trail[0].x, d.trail[0].y);
          for (let p = 1; p < d.trail.length; p++) {
            glassCtx.lineTo(d.trail[p].x, d.trail[p].y);
          }
          glassCtx.stroke();

          // 水痕中心细反光线
          glassCtx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
          glassCtx.lineWidth = 1.2;
          glassCtx.stroke();
        }
      });
      glassCtx.restore();

      // (B) 绘制静态冷凝小水滴
      this.staticDrops.forEach((drop) => {
        this.drawRealisticDrop(glassCtx, drop.x, drop.y, drop.r, drop.aspect, drop.alpha);
      });

      // (C) 绘制滑动水滴
      for (let i = this.trickleDrops.length - 1; i >= 0; i--) {
        const d = this.trickleDrops[i];

        d.stateTimer--;
        if (d.stateTimer <= 0) {
          if (d.state === 'pause') {
            d.state = Math.random() < 0.65 ? 'creep' : 'run';
            d.stateTimer = 15 + Math.random() * 40;
          } else {
            d.state = 'pause';
            d.stateTimer = 25 + Math.random() * 80;
          }
        }

        let curSpeed = 0.15;
        if (d.state === 'creep') curSpeed = d.speed * 0.65;
        else if (d.state === 'run') curSpeed = d.speed * 2.8;

        d.y += curSpeed;
        d.x += Math.sin(d.y * 0.05 + d.wiggleOffset) * 0.35;

        if (d.trail.length === 0 || Math.abs(d.y - d.trail[d.trail.length - 1].y) > 6) {
          d.trail.push({ x: d.x, y: d.y });
          if (d.trail.length > 25) d.trail.shift();
        }

        const elongation = d.state === 'run' ? 1.55 : 1.15;
        this.drawRealisticDrop(glassCtx, d.x, d.y, d.r, elongation, 0.92);

        if (d.y > h + 30) {
          this.trickleDrops.splice(i, 1);
          if (this.trickleDrops.length < 8) {
            this.spawnTrickleDrop(Math.random() * w, -10);
          }
        }
      }
    }

    dispose() {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      window.removeEventListener('resize', this.resize);

      if (this.bgCanvas) {
        try { this.bgCanvas.remove(); } catch (_) {}
      }
      if (this.glassCanvas) {
        try { this.glassCanvas.remove(); } catch (_) {}
      }
      this.bgCanvas = null;
      this.bgCtx = null;
      this.glassCanvas = null;
      this.glassCtx = null;
      this.staticDrops = [];
      this.trickleDrops = [];
      this.bokehLights = [];
    }
  }

  global.RainGlassEngine = new RainGlassEngine();

})(typeof window !== 'undefined' ? window : this);
