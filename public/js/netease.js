
/* ============================================================================

 * netease.js — 网易云音乐接入层（登录 / 歌单 / 播放 / 歌词 / 搜索 / 红心）

 * ========================================================================== */

(function () {

  'use strict';



  const LS_COOKIE = 'ncm_cookie';

  const LS_PROFILE = 'ncm_profile';



  let online = true;

  let loggedIn = false;

  let profile = null;

  let cookieStr = '';



  function api(path, params = {}) {

    const q = new URLSearchParams();

    Object.entries(params).forEach(([k, v]) => {

      if (v !== undefined && v !== null && v !== '') q.set(k, v);

    });

    q.set('timestamp', Date.now());

    const headers = {};
    if (cookieStr) headers['X-Ncm-Cookie'] = cookieStr;

    return fetch(path + '?' + q.toString(), { credentials: 'same-origin', headers })

      .then(r => r.json())

      .then(j => {

        if (j && (j.code === 200 || j.code === 800 || j.code === 801 || j.code === 802 || j.code === 803)) return j;

        const err = new Error(j && (j.message || j.msg) || '接口异常');

        err.code = j && j.code;

        throw err;

      });

  }



  function saveCookie(raw) {

    if (typeof raw === 'object' && raw) raw = Object.entries(raw).map(([k, v]) => `${k}=${v}`).join('; ');

    cookieStr = String(raw || '');

    localStorage.setItem(LS_COOKIE, cookieStr);

  }



  // ---------------------------------------------------------------------------

  // 1. 会话：恢复登录态 / 更新右上角头像 / 登录面板

  // ---------------------------------------------------------------------------

  function setProfile(p) {

    profile = p || null;

    loggedIn = !!p;

    if (p) {
      localStorage.setItem(LS_PROFILE, JSON.stringify(p));
    } else {
      localStorage.removeItem(LS_PROFILE);
    }

    const label = document.getElementById('ncmAvatarLabel');

    const img = document.getElementById('ncmAvatarImg');

    if (p && p.avatarUrl) {

      img.src = p.avatarUrl.replace(/^http:/, 'https:');

      img.style.display = 'block';

      label.style.display = 'none';

      document.getElementById('ncmAvatarBtn').title = `网易云音乐：${p.nickname}`;

    } else {

      img.style.display = 'none';

      label.style.display = 'block';

      label.textContent = '☁️';
    }

    if (window.DynamicPlatformIsland && typeof DynamicPlatformIsland.update === 'function') {
      DynamicPlatformIsland.update();
    }

    renderLoginPanel();

  }



  function renderLoginPanel() {

    const qrArea = document.getElementById('ncmQrArea');

    const profileArea = document.getElementById('ncmProfileArea');

    if (!qrArea || !profileArea) return;

    if (loggedIn && profile) {

      qrArea.style.display = 'none';

      profileArea.style.display = 'block';

      document.getElementById('ncmLoginTitle').textContent = '网易云音乐 · 已登录';

      const av = document.getElementById('ncmProfileAvatar');

      av.src = (profile.avatarUrl || '').replace(/^http:/, 'https:');

      document.getElementById('ncmProfileName').textContent = profile.nickname || '—';

      document.getElementById('ncmProfileSub').textContent =

        `${profile.signature || '这个人很酷，什么都没写'} · UID ${profile.userId}`;

    } else {

      qrArea.style.display = 'flex';

      profileArea.style.display = 'none';

      document.getElementById('ncmLoginTitle').textContent = '扫码登录网易云音乐';

    }

  }



  function openLoginPanel() {
    if (window.PlatformLoginModal && typeof PlatformLoginModal.open === 'function') {
      PlatformLoginModal.open('netease');
    }
  }

  function closeLoginPanel() {
    if (window.PlatformLoginModal && typeof PlatformLoginModal.close === 'function') {
      PlatformLoginModal.close();
    }
  }



  // ---------------------------------------------------------------------------

  // 2. 二维码登录

  // ---------------------------------------------------------------------------

  let qrTimer = 0;



  function stopQrPoll() {

    clearTimeout(qrTimer);

    qrTimer = 0;

  }



  function startQrLogin() {

    stopQrPoll();

    const frame = document.getElementById('ncmQrFrame');

    const status = document.getElementById('ncmQrStatus');

    frame.classList.remove('expired');

    frame.innerHTML = '<div class="ncm-qr-loading">正在生成二维码…</div>';



    api('/login/qr/key')

      .then(j => {

        const key = j.data && j.data.unikey;

        if (!key) throw new Error('获取二维码密钥失败');

        return api('/login/qr/create', { key, qrimg: true }).then(imgJ => ({ key, imgJ }));

      })

      .then(({ key, imgJ }) => {

        const img = imgJ.data && imgJ.data.qrimg;

        if (!img) throw new Error('生成二维码失败');

        frame.innerHTML = `<img src="${img}" alt="扫码登录">`;

        status.innerHTML = '打开「网易云音乐」APP 扫描二维码登录<br>登录后可同步歌单、播放在线歌曲与歌词';

        pollQrStatus(key);

      })

      .catch(err => {

        frame.innerHTML = '<div class="ncm-qr-loading">二维码生成失败<br>点击重试</div>';

        WK.toast('二维码生成失败：' + err.message);

      });



    function pollQrStatus(key) {

      function loop() {

        api('/login/qr/check', { key })

          .then(j => {

            if (j.code === 801) {

              status.innerHTML = '等待扫描…';

            } else if (j.code === 802) {

              status.innerHTML = '扫描成功，请在手机上确认登录';

            } else if (j.code === 803) {

              saveCookie(j.cookie);

              WK.toast('登录成功 🎉');

              finishLogin();

              return;

            } else if (j.code === 800) {

              frame.classList.add('expired');

              status.innerHTML = '二维码已过期，点击上方二维码刷新';

              frame.onclick = () => { frame.onclick = null; startQrLogin(); };

              return;

            }

            qrTimer = setTimeout(loop, 2000);

          })

          .catch(() => { qrTimer = setTimeout(loop, 3500); });

      }

      loop();

    }

  }



  function finishLogin() {

    api('/user/account').then(j => {

      const p = j.profile || (j.account && { userId: j.account.id, nickname: j.account.nickname });

      if (p) {

        setProfile(p);

        closeLoginPanel();

        loadPlaylistChips();

      }

    }).catch(() => {});

  }



  function logout() {
    stopQrPoll();
    saveCookie('');
    setProfile(null);
    if (window.WK && WK.setUserPlaylists) {
      WK.setUserPlaylists([]);
    }
    renderPlaylistChips([]);
    WK.toast('已退出登录');
  }



  // ---------------------------------------------------------------------------

  // 3. 歌单与在线搜索源切换

  // ---------------------------------------------------------------------------

  let playlists = [];
  let sourceKey = 'ncm';
  let sourceBooks = null;

  function syncSourceKey(key) {
    sourceKey = key;
  }

  function renderPlaylistChips(list) {
    const box = document.getElementById('sourceChips');
    if (!box) return;
    box.innerHTML = '';

    // 1) 常驻在线搜索/热门曲库（无需登录即可在线搜索）

    const cloudBtn = document.createElement('button');

    cloudBtn.className = 'source-chip' + (sourceKey === 'ncm:cloud' ? ' active' : '');

    cloudBtn.dataset.src = 'ncm:cloud';

    cloudBtn.textContent = '☁️ 在线曲库';

    cloudBtn.onclick = openCloudHotSongs;

    box.appendChild(cloudBtn);



    // 3) 登录后的用户歌单

    list.forEach(pl => {

      const btn = document.createElement('button');

      btn.className = 'source-chip';

      btn.dataset.src = 'ncm:' + pl.id;

      btn.textContent = (pl.name || '歌单').slice(0, 12) + (pl.trackCount ? ` · ${pl.trackCount}` : '');

      btn.onclick = () => openPlaylist(pl.id, btn);

      box.appendChild(btn);

    });



    if (loggedIn) {

      const daily = document.createElement('button');

      daily.className = 'source-chip';

      daily.dataset.src = 'ncm:daily';

      daily.textContent = '每日推荐';

      daily.onclick = openDailySongs;

      box.appendChild(daily);

    }

  }



  function openCloudHotSongs() {

    if (!online) {

      WK.toast('未连接后端 NCM API 服务');

      return;

    }

    api('/cloudsearch', { keywords: '热门', limit: 30 })

      .then(j => {

        const songs = (j.result && j.result.songs) || [];

        const books = songsToBooks(songs, '在线曲库');

        sourceKey = 'ncm:cloud';

        sourceBooks = books;

        WK.setSource('ncm:cloud', books);

        WK.toast('已切换至在线曲库，可直接用搜索框搜全网歌曲');

      })

      .catch(err => WK.toast('在线曲库加载失败：' + err.message));

  }



  function loadPlaylistTracks(id, callback) {
    api('/playlist/track/all', { id, limit: 300 })
      .then(j => {
        const songs = j.songs || [];
        const privileges = j.privileges || [];
        const privMap = new Map();
        privileges.forEach(p => { if (p && p.id) privMap.set(p.id, p.pl); });
        // 过滤不可播 (pl === 0) 或明确无版权的歌曲
        const playableSongs = songs.filter(s => {
          if (!s || !s.id) return false;
          if (privMap.has(s.id)) return privMap.get(s.id) > 0;
          return true;
        });
        const books = songsToBooks(playableSongs, '我的歌单');
        if (callback) callback(books);
        if (songs.length > playableSongs.length) {
          if (window.WK && WK.toast) WK.toast(`已自动过滤 ${songs.length - playableSongs.length} 首无法播放/无版权歌曲`);
        }
      })
      .catch(err => {
        if (window.WK && WK.toast) WK.toast('歌单曲目加载失败：' + (err.message || err));
        if (callback) callback([]);
      });
  }

  function loadPlaylistChips() {
    if (!loggedIn || !profile) {
      renderPlaylistChips([]);
      if (window.WK && WK.setUserPlaylists) WK.setUserPlaylists([]);
      return;
    }
    api('/user/playlist', { uid: profile.userId, limit: 100 })
      .then(j => {
        playlists = j.playlist || [];
        renderPlaylistChips(playlists);
        if (window.WK && WK.setUserPlaylists) {
          WK.setUserPlaylists(playlists);
        }
      })
      .catch(err => {
        if (window.WK && WK.toast) WK.toast('歌单加载失败：' + (err.message || err));
      });
  }



  function songsToBooks(songs, label) {

    return songs.filter(s => s && s.id).map((s, i) => {

      const id = s.id;

      const hue = Math.abs((id * 2654435761) % 360);

      const artist = (s.ar || s.artists || []).map(a => a.name).join(' / ') || '未知音乐人';

      const album = (s.al || s.album || {}).name || '单曲';

      const rawPic = (s.al || s.album || {}).picUrl || null;

      // 修复：强制 HTTPS 并裁剪为 400x400，避免 Mixed Content 警告及显存暴涨

      const picUrl = rawPic ? rawPic.replace(/^http:/, 'https:') + '?param=400y400' : null;



      return {

        index: String(i + 1).padStart(3, '0'),

        spineNum: String(i + 1).padStart(2, '0'),

        serial: `NCM-${id}`,

        title: s.name + (s.tns && s.tns[0] ? ` · ${s.tns[0]}` : ''),

        shortTitle: s.name.slice(0, 8),

        spineTitle: s.name.slice(0, 10),

        subtitleQuote: `| 专辑《${album}》 · ${label}`,

        artist,

        subArtist: album,

        statusTag: s.fee === 1 ? 'VIP' : '网易云',

        subTag: `NO.${String(i + 1).padStart(2, '0')} · ${artist}`,

        durationSec: Math.round((s.dt || 0) / 1000) || 210,

        currentSec: 0,

        accent: `hsl(${hue}, 58%, 46%)`,

        c1: `hsl(${hue}, 62%, 42%)`,

        c2: `hsl(${(hue + 40) % 360}, 30%, 12%)`,

        picUrl,

        ncmId: id,

        notes: [261.63, 329.63, 392.00, 523.25],

        lyrics: [{ t: 0, l1: s.name, l2: artist + (s.tns && s.tns[0] ? ' · ' + s.tns[0] : '') }],

        comments: [],

      };

    });

  }



  function openPlaylist(id, btn) {

    if (btn) btn.textContent = '加载中…';

    api('/playlist/track/all', { id, limit: 300 })

      .then(j => {

        const songs = j.songs || [];

        const books = songsToBooks(songs, '我的歌单');

        if (!books.length) { WK.toast('这个歌单是空的'); return; }

        sourceKey = 'ncm:' + id;

        sourceBooks = books;

        WK.setSource(sourceKey, books);

        WK.toast(`已载入 ${books.length} 首`);

      })

      .catch(err => WK.toast('歌单加载失败：' + err.message))

      .finally(() => {

        const pl = playlists.find(p => String(p.id) === String(id));

        if (btn && pl) btn.textContent = (pl.name || '歌单').slice(0, 12) + (pl.trackCount ? ` · ${pl.trackCount}` : '');

      });

  }



  function openDailySongs() {
    api('/recommend/songs')
      .then(j => {
        const songs = (j.data && j.data.dailySongs) || [];
        const books = songsToBooks(songs, '每日推荐');
        if (!books.length) { WK.toast('今日暂无推荐'); return; }
        sourceKey = 'ncm:daily';
        sourceBooks = books;
        WK.setSource(sourceKey, books);
        WK.toast(`每日推荐 · ${books.length} 首`);
      })
      .catch(err => WK.toast('每日推荐加载失败：' + err.message));
  }

  /**
   * 吸收歌单特征并给出 AI 推荐曲目
   * 1. 分析所有歌单的高频歌手与风格标签；
   * 2. 结合网易云个性化日推 + 偏好歌手深度关联扩展；
   * 3. 混合去重生成 30 首专属心流单曲。
   */
  function getAiRecommendations() {
    const artistsCount = new Map();
    const tagKeywords = [];

    // 从所有歌单信息与已加载曲目中汲取特征
    playlists.forEach(pl => {
      if (pl.name) {
        const words = pl.name.split(/[\s·/|#\-_+()（）]+/);
        words.forEach(w => {
          if (w.length >= 2 && !['我的', '歌单', '喜欢', '音乐', '收藏'].includes(w)) {
            tagKeywords.push(w);
          }
        });
      }
      if (Array.isArray(pl.tracks)) {
        pl.tracks.forEach(t => {
          if (t && t.artist) {
            artistsCount.set(t.artist, (artistsCount.get(t.artist) || 0) + 1);
          }
        });
      }
    });

    // 排序找出偏好权重最高的艺术家
    const sortedArtists = Array.from(artistsCount.entries())
      .sort((a, b) => b[1] - a[1])
      .map(entry => entry[0]);

    // 源 A: 网易云个性化推荐
    const pDaily = api('/recommend/songs')
      .then(j => (j.data && j.data.dailySongs) || [])
      .catch(() => []);

    // 源 B: 基于吸收到的高频歌手/标签进行关联延伸
    const seed = sortedArtists[0] || tagKeywords[0] || '热门流行';
    const pSeed = api('/cloudsearch', { keywords: seed, limit: 25 })
      .then(j => (j.result && j.result.songs) || [])
      .catch(() => []);

    return Promise.all([pDaily, pSeed]).then(([dailySongs, seedSongs]) => {
      const seen = new Set();
      const combined = [];
      [...dailySongs, ...seedSongs].forEach(s => {
        if (s && s.id && !seen.has(s.id)) {
          seen.add(s.id);
          combined.push(s);
        }
      });

      // 心流随机洗牌
      for (let i = combined.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [combined[i], combined[j]] = [combined[j], combined[i]];
      }

      const finalSongs = combined.slice(0, 30);
      const books = songsToBooks(finalSongs, 'AI 推荐');
      return {
        books,
        absorbedArtists: sortedArtists.slice(0, 4),
        seed
      };
    });
  }



  // ---------------------------------------------------------------------------

  // 4. 播放与歌词解析

  // ---------------------------------------------------------------------------

  const trackUrlCache = new Map(); // ncmId -> { url, expire }
  const URL_CACHE_TTL = 15 * 60 * 1000;

  function resolveTrack(book) {
    if (!book.ncmId) return Promise.resolve(false);

    const cached = trackUrlCache.get(book.ncmId);
    if (cached && Date.now() < cached.expire) {
      book.audioUrl = cached.url;
      return Promise.resolve(true);
    }

    const pExhigh = api('/song/url/v1', { id: book.ncmId, level: 'exhigh' })
      .then(j => (j.data && j.data[0] && j.data[0].url) || null)
      .catch(() => null);

    const pStandard = api('/song/url/v1', { id: book.ncmId, level: 'standard' })
      .then(j => (j.data && j.data[0] && j.data[0].url) || null)
      .catch(() => null);

    return Promise.all([pExhigh, pStandard]).then(([urlEx, urlStd]) => {
      const url = urlEx || urlStd;
      if (url) return url;
      return api('/song/url', { id: book.ncmId })
        .then(j => (j.data && j.data[0] && j.data[0].url) || null)
        .catch(() => null);
    }).then(url => {
      if (!url) {
        WK.toast('这首歌暂时无法播放（版权/会员/风控限制）');
        return false;
      }

      const proxyUrl = '/audio-proxy?url=' + encodeURIComponent(url);
      trackUrlCache.set(book.ncmId, { url: proxyUrl, expire: Date.now() + URL_CACHE_TTL });
      book.audioUrl = proxyUrl;

      if (book._audio) { try { book._audio.pause(); } catch (_) {} book._audio = null; }



      // 修复：歌词加载后调用 WK.syncLyrics(book) 立即刷新主界面双行歌词与 Folia 动效

      api('/lyric', { id: book.ncmId })

        .then(j => {

          const rows = parseLRC(j.lrc && j.lrc.lyric, j.tlyric && j.tlyric.lyric);

          if (rows.length) book.lyrics = rows;

          if (WK.syncLyrics) WK.syncLyrics(book);

        })

        .catch(() => {});



      api('/comment/music', { id: book.ncmId, limit: 12 })

        .then(j => {

          const hot = j.hotComments || j.comments || [];

          book.comments = hot.slice(0, 8).map(c =>

            `【热评 @${c.user && c.user.nickname || '匿名'} · ${c.likedCount || 0}👍】${String(c.content || '').replace(/\s+/g, ' ')}`);

          if (WK.syncLyrics) WK.syncLyrics(book);

        })

        .catch(() => {});

      return true;

    });

  }



  function parseLRC(text, transText) {

    const stampRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

    const parse = (raw) => {

      const out = [];

      String(raw || '').split(/\r?\n/).forEach(line => {

        const stamps = [];

        let m;

        stampRe.lastIndex = 0;

        while ((m = stampRe.exec(line))) {

          stamps.push(+m[1] * 60 + +m[2] + (m[3] ? +('0.' + m[3]) : 0));

        }

        const content = line.replace(stampRe, '').trim();

        if (!content) return;

        stamps.forEach(t => out.push({ t, text: content }));

      });

      out.sort((a, b) => a.t - b.t);

      return out;

    };

    const rows = parse(text);

    if (!rows.length) return [];

    const trans = parse(transText);

    const transMap = new Map(trans.map(r => [r.t.toFixed(2), r.text]));

    return rows.map((r, i) => ({

      t: r.t,

      l1: r.text,

      l2: transMap.get(r.t.toFixed(2)) || (rows[i + 1] ? rows[i + 1].text : ''),

    }));

  }



  // ---------------------------------------------------------------------------

  // 5. 搜索 / 红心

  // ---------------------------------------------------------------------------

  let searchTimer = 0;



  function searchAndOpen(q) {
    if (!q) return;
    api('/cloudsearch', { keywords: q, limit: 30 })
      .then(j => {
        const songs = (j.result && j.result.songs) || [];
        const books = songsToBooks(songs, `搜索「${q}」`);
        WK.setSource('search', books);
        if (!books.length) WK.toast('没有搜到相关歌曲');
      })
      .catch(err => WK.toast('搜索失败：' + (err.message || err)));
  }

  function onShelfSearch(q) {
    clearTimeout(searchTimer);

    if (!q) {
      if (sourceBooks) WK.setSource(sourceKey, sourceBooks);
      return true;
    }

    searchTimer = setTimeout(() => {
      const prevKey = sourceKey;
      const prevBooks = sourceBooks;

      api('/cloudsearch', { keywords: q, limit: 30 })
        .then(j => {
          const songs = (j.result && j.result.songs) || [];
          const books = songsToBooks(songs, `搜索「${q}」`);
          WK.setSource('search', books);
          sourceKey = prevKey; // 保持在线源标识，清空搜索框时可还原
          sourceBooks = prevBooks;
          if (!books.length) WK.toast('没有搜到相关歌曲');
        })
        .catch(err => WK.toast('搜索失败：' + (err.message || err)));
    }, 380);

    return true;
  }



  function onHeartToggle(book, liked) {

    if (!book.ncmId || !loggedIn) return;

    api('/like', { id: book.ncmId, like: liked })

      .then(() => WK.toast(liked ? '已添加到我喜欢的音乐' : '已取消红心'))

      .catch(err => WK.toast('红心同步失败：' + err.message));

  }



  // ---------------------------------------------------------------------------

  // 6. 启动

  // ---------------------------------------------------------------------------

  function boot() {
    cookieStr = localStorage.getItem(LS_COOKIE) || '';
    try { profile = JSON.parse(localStorage.getItem(LS_PROFILE) || 'null'); } catch (_) { profile = null; }

    if (profile) {
      loggedIn = true;
      setProfile(profile);
      loadPlaylistChips();
    } else {
      renderPlaylistChips([]);
    }

    api('/user/account')
      .then(j => {
        online = true;
        const p = j.profile || null;
        if (p) {
          setProfile(p);
          loadPlaylistChips();
        } else {
          if (cookieStr) saveCookie('');
          setProfile(null);
          renderPlaylistChips([]);
          if (window.WK && WK.setUserPlaylists) WK.setUserPlaylists([]);
        }
      })
      .catch(() => {
        online = false;
      });
  }



  /** 兜底：歌单接口没给封面时，从歌单详情里取第一首歌的专辑封面 */
  function fetchFirstCover(playlistId) {
    if (!playlistId) return Promise.resolve(null);
    return api('/playlist/detail', { id: playlistId })
      .then(function (j) {
        var pl = j && j.playlist;
        if (!pl) return null;
        if (pl.coverImgUrl) return pl.coverImgUrl.replace(/^http:/, 'https:') + '?param=400y400';
        var t = pl.tracks && pl.tracks[0];
        if (t && t.al && t.al.picUrl) return t.al.picUrl.replace(/^http:/, 'https:') + '?param=400y400';
        return null;
      })
      .catch(function () { return null; });
  }

  window.NCM = {
    openLoginPanel, closeLoginPanel, startQrLogin, logout, fetchFirstCover, setProfile,
    resolveTrack, onShelfSearch, searchAndOpen, getAiRecommendations, onHeartToggle, syncSourceKey,
    loadPlaylistTracks, loadPlaylistChips,
    getPlaylists: () => playlists,
    getProfile: () => profile,
    get online() { return online; },
    get loggedIn() { return loggedIn; },
  };



  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);

  else boot();

})();



