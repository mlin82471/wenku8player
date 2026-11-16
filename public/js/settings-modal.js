(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof exports === 'object') {
    module.exports = factory();
  } else {
    root.SettingsModal = factory();
  }
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const STORAGE_KEY = 'wk_app_settings_v1';

  let settings = {
    enableDesktopIsland: true,
    islandAlwaysOnTop: true,
    soundEffects: true
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) settings = { ...settings, ...JSON.parse(raw) };
  } catch (_) {}

  let modalEl = null;

  function initDom() {
    if (modalEl) return;
    modalEl = document.createElement('div');
    modalEl.className = 'settings-modal-backdrop';
    modalEl.id = 'settingsModal';
    modalEl.onclick = function (e) {
      if (e.target === modalEl) close();
    };
    document.body.appendChild(modalEl);
  }

  function open() {
    initDom();
    render();
    modalEl.classList.add('open');
  }

  function close() {
    if (!modalEl) return;
    modalEl.classList.remove('open');
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (_) {}

    // 通知后端 (HTTP 与 Tauri IPC 双保底)
    try {
      fetch(`/api/island/settings?enable=${settings.enableDesktopIsland}&always_on_top=${settings.islandAlwaysOnTop}`).catch(() => {});
      if (window.__TAURI__ && window.__TAURI__.core) {
        window.__TAURI__.core.invoke('update_island_settings', {
          enable: settings.enableDesktopIsland,
          alwaysOnTop: settings.islandAlwaysOnTop
        });
      }
    } catch (_) {}
  }

  function render() {
    if (!modalEl) return;
    modalEl.innerHTML = `
      <div class="settings-modal-card">
        <div class="settings-header">
          <div class="settings-title">
            <span>⚙️</span>
            <span>系统偏好与灵动岛设置</span>
          </div>
          <button class="settings-close-btn" onclick="SettingsModal.close()">✕</button>
        </div>

        <div class="settings-group">
          <div class="settings-group-title">桌面灵动岛 (Desktop Island)</div>

          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-main-text">关闭主窗口时显示桌面悬浮灵动岛</span>
              <span class="settings-sub-text">点击右上角关闭时不退出进程，化身为高透桌面悬浮岛</span>
            </div>
            <label class="settings-switch">
              <input type="checkbox" id="setEnableDesktopIsland" ${settings.enableDesktopIsland ? 'checked' : ''} onchange="SettingsModal.toggle('enableDesktopIsland', this.checked)">
              <span class="settings-slider"></span>
            </label>
          </div>

          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-main-text">桌面灵动岛始终置顶 (Always On Top)</span>
              <span class="settings-sub-text">悬浮于所有窗口之上，随时掌握歌曲与微型声浪</span>
            </div>
            <label class="settings-switch">
              <input type="checkbox" id="setIslandAlwaysOnTop" ${settings.islandAlwaysOnTop ? 'checked' : ''} onchange="SettingsModal.toggle('islandAlwaysOnTop', this.checked)">
              <span class="settings-slider"></span>
            </label>
          </div>

          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-main-text">立即体验桌面悬浮灵动岛</span>
              <span class="settings-sub-text">收起主窗口并在屏幕顶部唤出独立悬浮岛</span>
            </div>
            <button class="settings-btn-action" onclick="SettingsModal.testDesktopIsland()">立即唤出</button>
          </div>
        </div>

        <div class="settings-group">
          <div class="settings-group-title">音乐平台通行证</div>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-main-text">网易云音乐通行证</span>
              <span class="settings-sub-text">扫码登录与 Cookie 凭据管理</span>
            </div>
            <button class="settings-btn-action" onclick="SettingsModal.openAuthModal()">打开通行证</button>
          </div>
        </div>
      </div>
    `;
  }

  function toggle(key, val) {
    settings[key] = val;
    save();
    if (key === 'soundEffects' && typeof window.toggleSound === 'function') {
      window.soundOn = val;
    }
  }

  async function testDesktopIsland() {
    close();
    try {
      fetch('/api/island/action?cmd=toggle_island').catch(() => {});
      if (window.__TAURI__ && window.__TAURI__.core) {
        await window.__TAURI__.core.invoke('toggle_desktop_island', { show: true });
        return;
      }
    } catch (_) {}
    if (window.WK && typeof WK.toast === 'function') {
      WK.toast('✨ 桌面灵动岛已激活（悬浮于屏幕顶部）');
    }
  }

  function openAuthModal() {
    close();
    if (window.PlatformLoginModal) {
      PlatformLoginModal.open('netease');
    }
  }

  return {
    open,
    close,
    toggle,
    testDesktopIsland,
    openAuthModal,
    getSettings: () => ({ ...settings })
  };
});
