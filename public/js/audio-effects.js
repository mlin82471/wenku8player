/**
 * audio-effects.js — 专业级 Web Audio 调音台引擎与毛玻璃 UI
 * 
 * 功能清单：
 * 1. 10 段专业峰值均衡器 (31Hz ~ 16kHz, ±12dB 平滑微调)
 * 2. 磁带暖声模拟 (WaveShaper 非线性非对称饱和失真)
 * 3. HRTF 3D 双耳空间环绕声场 (声源绕头平滑旋转 + 迷你声源雷达)
 * 4. 防爆音防破音动态压缩限制器 (Limiter Compressor)
 * 5. 6 大精调声音预设 (原声无损 / 超重低音 / 清澈人声 / Walkman 磁带 / 3D 环绕 / Live 演唱会)
 * 6. 暗色苹果风高透毛玻璃调音台 UI
 */

(function () {
  'use strict';

  const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const EQ_LABELS = ['31', '62', '125', '250', '500', '1K', '2K', '4K', '8K', '16K'];

  const PRESET_CONFIGS = {
    flat: { name: '原声无损', tag: 'STUDIO', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    bass: { name: '超重低音', tag: 'BASS+', gains: [8, 6, 4, 1, 0, 0, 0, 1, 2, 2] },
    vocal: { name: '清澈人声', tag: 'VOCAL', gains: [-2, -1, 0, 2, 4, 4, 3, 2, 1, 0] },
    walkman: { name: 'Walkman 磁带', tag: 'TAPE 80s', gains: [-3, 2, 3, 1, 0, -1, -2, -4, -7, -10] },
    surround3d: { name: '3D 环绕声场', tag: 'HRTF 360°', gains: [3, 2, 0, -1, 0, 0, 1, 3, 4, 3] },
    live: { name: 'Live 演唱会', tag: 'CONCERT', gains: [4, 3, 1, -2, -1, 1, 2, 3, 4, 3] }
  };

  class AudioEffectEngine {
    constructor() {
      this.ctx = null;
      this.source = null;
      this.filters = [];
      this.panner = null;
      this.tapeShaper = null;
      this.compressor = null;
      this.analyser = null;

      this.isInitialized = false;
      this.is3DActive = false;
      this.angle3D = 0;
      this.rafId = null;
      this.onAngleUpdate = null;
      this.currentGains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      this.activePreset = 'flat';
    }

    init(audioEl, onAngleUpdate, sharedCtx, sharedAnalyser) {
      this.onAngleUpdate = onAngleUpdate;
      if (this.isInitialized) {
        if (this.ctx && this.ctx.state === 'suspended') {
          this.ctx.resume().catch(() => {});
        }
        return;
      }
      if (!audioEl) return;

      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.ctx = sharedCtx || window.audioCtx || new AudioCtx();
        window.audioCtx = this.ctx;

        if (audioEl._sourceAttached && audioEl._sourceNode) {
          this.source = audioEl._sourceNode;
        } else {
          try {
            audioEl.crossOrigin = 'anonymous';
          } catch (_) {}
          this.source = this.ctx.createMediaElementSource(audioEl);
          audioEl._sourceAttached = true;
          audioEl._sourceNode = this.source;
        }

        // 1. 创建 10 段峰值均衡器 (Peaking EQ)
        this.filters = EQ_FREQUENCIES.map((freq) => {
          const filter = this.ctx.createBiquadFilter();
          filter.type = 'peaking';
          filter.frequency.value = freq;
          filter.Q.value = 1.41;
          filter.gain.value = 0;
          return filter;
        });

        // 2. 创建磁带非线性饱和失真节点
        this.tapeShaper = this.ctx.createWaveShaper();
        this.tapeShaper.oversample = '4x';
        this.setTapeWarmth(false);

        // 3. 创建 HRTF 3D 双耳空间音频节点
        this.panner = this.ctx.createPanner();
        this.panner.panningModel = 'HRTF';
        this.panner.distanceModel = 'inverse';
        this.panner.refDistance = 1;
        this.panner.maxDistance = 10000;
        this.panner.rolloffFactor = 1;
        this.resetPannerPosition();

        // 4. 创建防破音动态压缩限制器
        this.compressor = this.ctx.createDynamicsCompressor();
        this.compressor.threshold.value = -6;
        this.compressor.knee.value = 12;
        this.compressor.ratio.value = 12;
        this.compressor.attack.value = 0.003;
        this.compressor.release.value = 0.25;

        // 5. 分析器 (若共享 analyserNode 则复用，保证动效波形与音频同步)
        this.analyser = sharedAnalyser || window.analyserNode || this.ctx.createAnalyser();
        if (!sharedAnalyser && !window.analyserNode) {
          this.analyser.fftSize = 256;
          this.analyser.smoothingTimeConstant = 0.82;
        }
        window.analyserNode = this.analyser;

        // 串联音频管线: Source -> Filters[0..9] -> TapeShaper -> Panner -> Compressor -> Analyser -> Destination
        let currentNode = this.source;
        for (const filter of this.filters) {
          currentNode.connect(filter);
          currentNode = filter;
        }
        currentNode.connect(this.tapeShaper);
        this.tapeShaper.connect(this.panner);
        this.panner.connect(this.compressor);
        this.compressor.connect(this.analyser);
        this.analyser.connect(this.ctx.destination);

        this.isInitialized = true;
        console.log('[AudioEffectEngine] 10段均衡器与声场引擎成功挂载 Web Audio 链路');
      } catch (err) {
        console.warn('[AudioEffectEngine] 初始化失败，采用原声音频链路:', err);
      }
    }

    applyPreset(key) {
      const config = PRESET_CONFIGS[key];
      if (!config) return [];
      this.activePreset = key;

      config.gains.forEach((gain, index) => {
        this.setBandGain(index, gain);
      });

      this.setTapeWarmth(key === 'walkman');

      if (key === 'surround3d') {
        this.start3DRotation();
      } else {
        this.stop3DRotation();
      }

      return [...this.currentGains];
    }

    setBandGain(index, gain) {
      this.currentGains[index] = gain;
      if (!this.ctx || !this.filters[index]) return;
      try {
        this.filters[index].gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
      } catch (_) {}
    }

    setTapeWarmth(enabled) {
      if (!this.tapeShaper) return;
      if (!enabled) {
        this.tapeShaper.curve = null;
        return;
      }
      const samples = 44100;
      const curve = new Float32Array(samples);
      const amount = 18;
      for (let i = 0; i < samples; ++i) {
        const x = (i * 2) / samples - 1;
        curve[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x));
      }
      this.tapeShaper.curve = curve;
    }

    start3DRotation() {
      if (this.is3DActive) return;
      this.is3DActive = true;

      const tick = () => {
        if (!this.is3DActive || !this.panner || !this.ctx) return;
        this.angle3D += 0.014;
        const radius = 2.4;
        const x = Math.sin(this.angle3D) * radius;
        const z = Math.cos(this.angle3D) * radius;

        try {
          this.panner.positionX.setTargetAtTime(x, this.ctx.currentTime, 0.05);
          this.panner.positionZ.setTargetAtTime(z, this.ctx.currentTime, 0.05);
        } catch (_) {}

        if (this.onAngleUpdate) this.onAngleUpdate(x / radius, z / radius);
        this.rafId = requestAnimationFrame(tick);
      };
      this.rafId = requestAnimationFrame(tick);
    }

    stop3DRotation() {
      this.is3DActive = false;
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      this.resetPannerPosition();
      if (this.onAngleUpdate) this.onAngleUpdate(0, 1);
    }

    resetPannerPosition() {
      if (!this.panner || !this.ctx) return;
      try {
        this.panner.positionX.setTargetAtTime(0, this.ctx.currentTime, 0.05);
        this.panner.positionY.setTargetAtTime(0, this.ctx.currentTime, 0.05);
        this.panner.positionZ.setTargetAtTime(1, this.ctx.currentTime, 0.05);
      } catch (_) {}
    }

    checkIsMutedByCORS() {
      if (!this.analyser) return false;
      const data = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(data);
      return data.every((val) => val === 0);
    }
  }

  const engine = new AudioEffectEngine();

  // ==========================================================================
  // UI 调音台弹窗管理器 (Glassmorphic Audio Console Popover)
  // ==========================================================================
  let isModalOpen = false;
  let popoverEl = null;

  function ensureModalDom() {
    if (popoverEl) return popoverEl;
    popoverEl = document.createElement('div');
    popoverEl.id = 'audioEffectPopover';
    popoverEl.className = 'audio-effect-popover';
    popoverEl.style.display = 'none';

    popoverEl.innerHTML = `
      <div class="aep-header">
        <div class="aep-title-row">
          <span class="aep-indicator-dot"></span>
          <span class="aep-title">声场与磁带调音台</span>
        </div>
        <button class="aep-close-btn" onclick="AudioEffects.toggle(false)">✕</button>
      </div>

      <div class="aep-preset-grid" id="aepPresetGrid"></div>

      <div class="aep-radar-card" id="aepRadarCard" style="display:none;">
        <div class="aep-radar-info">
          <div class="aep-radar-title">HRTF 双耳 360° 声场引擎</div>
          <div class="aep-radar-sub">佩戴立体声耳机，体验声源绕头旋转</div>
        </div>
        <div class="aep-radar-circle">
          <div class="aep-radar-head"></div>
          <div class="aep-radar-blip" id="aepRadarBlip"></div>
        </div>
      </div>

      <div class="aep-eq-section">
        <div class="aep-eq-header">
          <span>10-BAND MASTER EQUALIZER</span>
          <button class="aep-reset-btn" onclick="AudioEffects.selectPreset('flat')">重置平直</button>
        </div>
        <div class="aep-eq-sliders-row" id="aepEqSlidersRow"></div>
      </div>
    `;

    document.body.appendChild(popoverEl);

    // 绑定 ESC 快捷关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isModalOpen) {
        toggleModal(false);
      }
    });

    // 点击调音台外部区域自动收起/关闭 (捕获阶段监听，穿透子元素 stopPropagation)
    const handleOutsideClick = (e) => {
      if (!isModalOpen || !popoverEl) return;
      if (popoverEl.contains(e.target)) return;
      const btn1 = document.getElementById('audioEffectBtn');
      const btn2 = document.getElementById('playerAudioEffectBtn');
      if (btn1 && (btn1 === e.target || btn1.contains(e.target))) return;
      if (btn2 && (btn2 === e.target || btn2.contains(e.target))) return;
      toggleModal(false);
    };
    window.addEventListener('pointerdown', handleOutsideClick, true);
    window.addEventListener('click', handleOutsideClick, true);

    renderPresetsUI();
    renderSlidersUI();
    return popoverEl;
  }

  function renderPresetsUI() {
    const grid = document.getElementById('aepPresetGrid');
    if (!grid) return;
    grid.innerHTML = '';
    Object.keys(PRESET_CONFIGS).forEach((key) => {
      const p = PRESET_CONFIGS[key];
      const isSel = engine.activePreset === key;
      const btn = document.createElement('button');
      btn.className = 'aep-preset-card' + (isSel ? ' active' : '');
      btn.innerHTML = `
        <span class="aep-preset-tag">${p.tag}</span>
        <span class="aep-preset-name">${p.name}</span>
      `;
      btn.onclick = () => {
        selectPreset(key);
      };
      grid.appendChild(btn);
    });
  }

  function renderSlidersUI() {
    const row = document.getElementById('aepEqSlidersRow');
    if (!row) return;
    row.innerHTML = '';

    EQ_FREQUENCIES.forEach((freq, idx) => {
      const label = EQ_LABELS[idx];
      const gain = engine.currentGains[idx] || 0;
      const col = document.createElement('div');
      col.className = 'aep-slider-col';

      // 增益数值标签
      const valLabel = document.createElement('span');
      valLabel.className = 'aep-val-label';
      valLabel.id = `aepVal_${idx}`;
      valLabel.textContent = gain > 0 ? `+${gain}` : String(gain);

      // 滑槽容器
      const trackWrap = document.createElement('div');
      trackWrap.className = 'aep-track-wrap';

      const fillBar = document.createElement('div');
      fillBar.className = 'aep-fill-bar';
      fillBar.id = `aepFill_${idx}`;
      const percent = ((gain + 12) / 24) * 100;
      fillBar.style.height = `${percent}%`;

      const input = document.createElement('input');
      input.type = 'range';
      input.min = '-12';
      input.max = '12';
      input.step = '1';
      input.value = String(gain);
      input.className = 'aep-vertical-input';
      input.title = `${label}Hz: ${gain}dB`;

      input.oninput = (e) => {
        const val = Number(e.target.value);
        engine.setBandGain(idx, val);
        valLabel.textContent = val > 0 ? `+${val}` : String(val);
        const p = ((val + 12) / 24) * 100;
        fillBar.style.height = `${p}%`;
      };

      trackWrap.appendChild(fillBar);
      trackWrap.appendChild(input);

      // 频率标签
      const freqLabel = document.createElement('span');
      freqLabel.className = 'aep-freq-label';
      freqLabel.textContent = label;

      col.appendChild(valLabel);
      col.appendChild(trackWrap);
      col.appendChild(freqLabel);

      row.appendChild(col);
    });
  }

  function syncSlidersState() {
    EQ_FREQUENCIES.forEach((_, idx) => {
      const g = engine.currentGains[idx] || 0;
      const vl = document.getElementById(`aepVal_${idx}`);
      const fb = document.getElementById(`aepFill_${idx}`);
      const input = document.querySelectorAll('.aep-vertical-input')[idx];
      if (vl) vl.textContent = g > 0 ? `+${g}` : String(g);
      if (fb) fb.style.height = `${((g + 12) / 24) * 100}%`;
      if (input) input.value = String(g);
    });
  }

  function selectPreset(key) {
    engine.applyPreset(key);
    renderPresetsUI();
    syncSlidersState();

    const radarCard = document.getElementById('aepRadarCard');
    if (radarCard) {
      radarCard.style.display = key === 'surround3d' ? 'flex' : 'none';
    }
  }

  function toggleModal(force) {
    isModalOpen = force !== undefined ? Boolean(force) : !isModalOpen;
    const modal = ensureModalDom();
    modal.style.display = isModalOpen ? 'block' : 'none';
    if (isModalOpen) {
      modal.classList.remove('open');
      void modal.offsetWidth;
      modal.classList.add('open');
      renderPresetsUI();
      syncSlidersState();
      const radarCard = document.getElementById('aepRadarCard');
      if (radarCard) {
        radarCard.style.display = engine.activePreset === 'surround3d' ? 'flex' : 'none';
      }
    } else {
      modal.classList.remove('open');
    }
  }

  // 绑定全局音频元素初始化
  function bindAudio(audioEl) {
    if (!audioEl) return;
    const runInit = () => {
      engine.init(audioEl, (x, z) => {
        const blip = document.getElementById('aepRadarBlip');
        if (blip) {
          blip.style.transform = `translate(${x * 18}px, ${-z * 18}px)`;
        }
      }, window.audioCtx, window.analyserNode);
    };
    if (audioEl.readyState >= 1 || audioEl._sourceAttached) {
      runInit();
    } else {
      audioEl.addEventListener('play', runInit, { once: true });
    }
  }

  window.AudioEffects = {
    engine,
    bindAudio,
    toggle: toggleModal,
    selectPreset,
    get isOpen() { return isModalOpen; }
  };

  // 页面就绪后自动尝试挂载
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (window.localAudioEl) bindAudio(window.localAudioEl);
    });
  } else {
    if (window.localAudioEl) bindAudio(window.localAudioEl);
  }
})();
