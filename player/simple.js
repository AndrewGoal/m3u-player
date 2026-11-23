/**
 * 海纳百川-简洁播放器
 *
 * 打开就是全屏视频，界面上只有一条会自己消失的进度条。
 *
 *   左右键   快退 / 快进 10 秒（进度条短暂出现）
 *   上下键   上一个 / 下一个节目
 *   OK 键    播放 / 暂停
 *   菜单键   换源层（居中、半透明）
 *   返回键   关面板；没面板时交给壳退出应用
 *
 * 换源层：上下选源，OK 拉取该源（同一个源不重复拉取）并打开换台层。
 * 换台层：左边分类、右边频道，左右切栏、上下选择、OK 换台。
 */
(function () {
  'use strict';

  var Parser = window.PlaylistParser;
  var SDK = window.M3UPlayer;
  if (!Parser || !SDK) {
    document.body.innerHTML = '<p style="padding:40px;font-family:sans-serif;color:#fff">' +
      '播放器脚本加载失败：缺少 playlist.js 或 sdk.js。</p>';
    return;
  }

  var params = new URLSearchParams(location.search);

  /* 和完整版共用同一套本地存储命名空间：完整版里加过的源，简洁版也能选 */
  var STORAGE_NS = 'm3u-player:default:';
  var SOURCES_KEY = STORAGE_NS + 'sources:v1';
  var ACTIVE_SOURCE_KEY = STORAGE_NS + 'active-source:v1';

  var WEATHER_M3U_URL = 'https://andrewgoal.github.io/cctv_weather_forecasting_m3u/cctv_weather_forecasting.m3u';
  var IPTV_M3U_URL = 'https://iptv.yang-1989.xyz/playlist.m3u';

  var BUILTIN_SOURCES = [
    { id: 'builtin:weather-live', label: '气象万千（现取）', provider: 'weatherLive', builtin: true },
    { id: 'builtin:weather-file', label: '气象万千（滞后m3u文件）', url: WEATHER_M3U_URL, builtin: true },
    { id: 'builtin:iptv-file', label: 'IPTV · M3U 文件', url: IPTV_M3U_URL, builtin: true }
  ];

  var REFRESH_MS = 30 * 60 * 1000;

  var video = document.getElementById('video');
  var progressEl = document.getElementById('progress');
  var progressFill = document.getElementById('progressFill');
  var progressTime = document.getElementById('progressTime');
  var osdEl = document.getElementById('osd');
  var switchingEl = document.getElementById('switching');
  var switchingText = document.getElementById('switchingText');
  var sourcePanel = document.getElementById('sourcePanel');
  var sourceList = document.getElementById('sourceList');
  var sourceHint = document.getElementById('sourceHint');
  var channelPanel = document.getElementById('channelPanel');
  var channelTitle = document.getElementById('channelTitle');
  var groupList = document.getElementById('groupList');
  var itemList = document.getElementById('itemList');

  var state = {
    sources: [],
    activeId: '',
    items: [],
    groups: [],
    current: null,
    source: null,
    loadedAt: 0,
    loading: false,
    mode: 'video',        // video | sources | channels
    column: 'items',      // groups | items
    sourceIndex: 0,
    groupIndex: 0,
    itemIndex: 0,
    hls: null,
    live: false,
    stalled: false,
    nativePlaying: false,
    posMs: 0,
    durationMs: 0
  };

  /* 壳里带原生播放器（SurfaceView + MediaPlayer）时走原生，网页只画界面 */
  var NATIVE = !!(window.TVShell && typeof window.TVShell.playerOpen === 'function');
  /* 原生解不了的流（比如伪装扩展名的 fMP4 HLS）记下来，下次直接走网页播放 */
  var nativeBlacklist = {};
  var nativeWatchdog = 0;

  function setNativeSurface(on) {
    // 网页元素（<video>）由 playing 事件决定显不显示，这里只切原生层
    document.documentElement.classList.toggle('native', !!on);
  }

  if (NATIVE) setNativeSurface(true);

  function isNativeSurface() {
    return document.documentElement.classList.contains('native');
  }

  function prefixOf(url) {
    try {
      var parsed = new URL(url);
      var path = parsed.pathname;
      var cut = path.lastIndexOf('/');
      return parsed.origin + (cut > 0 ? path.slice(0, cut + 1) : '/');
    } catch (err) {
      return url;
    }
  }

  /** 同一个目录下的流往往是一批的（比如整套 fMP4 直播），失败一次就整批走网页 */
  function isNativeBlocked(url) {
    if (!url) return false;
    return !!(nativeBlacklist[url] || nativeBlacklist[prefixOf(url)]);
  }

  function useNativeFor(item) {
    if (!NATIVE || !item) return false;
    return !isNativeBlocked(item.playUrl || item.url);
  }

  function fallbackToWeb(item, reason) {
    if (!item) return;
    clearTimeout(nativeWatchdog);
    var failedUrl = item.playUrl || item.url;
    nativeBlacklist[failedUrl] = true;
    nativeBlacklist[prefixOf(failedUrl)] = true;
    if (window.TVShell && window.TVShell.playerStop) {
      try { window.TVShell.playerStop(); } catch (err) { /* 忽略 */ }
    }
    setNativeSurface(false);
    osd(reason || '这个流原生解不了，改用网页播放', 2400);
    play(item, { force: true, web: true });
  }

  var progressTimer = 0;
  var bufferTimer = 0;
  var osdTimer = 0;
  var userPressed = false;

  /* ---------- 小工具 ---------- */

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* 忽略 */ }
  }

  function readActiveId() {
    try {
      var raw = localStorage.getItem(ACTIVE_SOURCE_KEY);
      if (!raw) return '';
      if (raw.charAt(0) === '"') {
        try { return JSON.parse(raw); } catch (err) { return ''; }
      }
      return raw;
    } catch (err) {
      return '';
    }
  }

  function writeActiveId(id) {
    try { localStorage.setItem(ACTIVE_SOURCE_KEY, id); } catch (err) { /* 忽略 */ }
  }

  function clock(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '--:--';
    var total = Math.floor(seconds);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var mm = (m < 10 ? '0' : '') + m;
    var ss = (s < 10 ? '0' : '') + s;
    return h ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  function osd(text, ms) {
    clearTimeout(osdTimer);
    if (!text) {
      osdEl.classList.remove('is-visible');
      return;
    }
    osdEl.textContent = text;
    osdEl.classList.add('is-visible');
    osdTimer = setTimeout(function () { osdEl.classList.remove('is-visible'); }, ms || 1800);
  }

  function findByUrl(item) {
    if (!item) return null;
    for (var i = 0; i < state.items.length; i += 1) {
      if (state.items[i].url === item.url) return state.items[i];
    }
    return null;
  }

  /* ---------- 节目源 ---------- */

  function normalizeUrl(value) {
    try { return new URL(value, location.href).href; } catch (err) { return value; }
  }

  function loadSources() {
    var list = BUILTIN_SOURCES.map(function (source) { return Object.assign({}, source); });

    var saved = readJSON(SOURCES_KEY, []);
    if (Array.isArray(saved)) {
      saved.forEach(function (raw, index) {
        if (!raw || (!raw.url && !raw.provider)) return;
        if (list.some(function (s) { return (s.url && s.url === raw.url) || (s.provider && s.provider === raw.provider); })) return;
        list.push({
          id: raw.id || ('user:' + index),
          label: raw.label || ('自定义源 ' + (index + 1)),
          url: raw.url ? normalizeUrl(raw.url) : '',
          provider: raw.provider || '',
          custom: true
        });
      });
    }

    var custom = params.get('m3u');
    if (custom) {
      list.unshift({
        id: 'custom:url',
        label: '自定义 m3u',
        url: normalizeUrl(custom),
        custom: true
      });
    }
    return list;
  }

  function activeSource() {
    for (var i = 0; i < state.sources.length; i += 1) {
      if (state.sources[i].id === state.activeId) return state.sources[i];
    }
    return state.sources[0] || null;
  }

  function fetchText(url, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 15000);
    var separator = url.indexOf('?') === -1 ? '?' : '&';

    return fetch(url + separator + '_=' + Date.now(), {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
      headers: { Accept: 'application/x-mpegurl, application/vnd.apple.mpegurl, text/plain, */*' }
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.text().then(function (text) {
        return { text: text, finalUrl: response.url || url };
      });
    }).finally(function () {
      clearTimeout(timer);
    });
  }

  /** Provider 返回文本，URL 源走 fetch。 */
  function fetchSource(source) {
    if (!source) return Promise.reject(new Error('没有可用的节目源'));

    if (source.provider) {
      var provider = SDK.providers && SDK.providers[source.provider];
      if (typeof provider !== 'function') return Promise.reject(new Error('Provider 未注册：' + source.provider));
      return Promise.resolve()
        .then(function () { return provider(); })
        .then(function (result) {
          var data = result || {};
          if (typeof data.text !== 'string' || !data.text.trim()) throw new Error('Provider 返回内容为空');
          return { text: data.text, baseUrl: data.baseUrl || location.href };
        });
    }

    if (!source.url) return Promise.reject(new Error('节目源缺少地址'));
    return fetchText(source.url).then(function (result) {
      return { text: result.text, baseUrl: result.finalUrl || source.url };
    });
  }

  function parseItems(result) {
    if (/^\s*</.test(result.text)) throw new Error('返回的是网页而不是 m3u');
    var items = Parser.parseM3U(result.text, { baseUrl: result.baseUrl, now: new Date() });
    if (!items.length) throw new Error('没有解析到节目');
    return items;
  }

  /** 先试指定源，失败按顺序试其余源（首次加载时用）。 */
  function fetchWithFallback(source) {
    var order = [source].concat(state.sources.filter(function (s) { return s !== source; }));
    var errors = [];

    function attempt(index) {
      if (index >= order.length) return Promise.reject(errors[errors.length - 1] || new Error('所有节目源都失败了'));
      return fetchSource(order[index])
        .then(function (result) {
          return { source: order[index], items: parseItems(result) };
        })
        .catch(function (error) {
          errors.push(error);
          return attempt(index + 1);
        });
    }
    return attempt(0);
  }

  function applyItems(source, items, options) {
    var opts = options || {};
    state.source = source;
    state.items = items;
    state.groups = Parser.groupItems(items);
    state.loadedAt = Date.now();
    markChannelsDirty();

    var kept = opts.keep ? (findByUrl(state.current) || state.current) : null;
    state.current = kept || null;

    if (!state.current && opts.autoplay !== false) {
      play(items[0], { force: true });
    } else if (state.current && opts.replay) {
      play(state.current, { force: true });
    }

    if (state.mode === 'channels') {
      syncSelection();
      renderChannels();
    }
    renderSources();
  }

  /* ---------- 换台过渡层 ---------- */

  var switchingTimer = 0;

  function showSwitching(text) {
    if (!switchingEl) return;
    switchingText.textContent = text || '正在换台…';
    switchingEl.hidden = false;
    clearTimeout(switchingTimer);
    switchingTimer = setTimeout(function () {
      if (!switchingEl || switchingEl.hidden) return;
      switchingText.textContent = '这个源一直没有画面，换一个台试试';
      osd('这个源没有响应 · 上下键换台，或菜单里用系统播放器', 5000);
    }, 15000);
  }

  function hideSwitching() {

    if (switchingEl) switchingEl.hidden = true;
  }

  /* ---------- 播放 ---------- */

  function isHlsUrl(url) {
    return /\.m3u8(\?|#|$)/i.test(url || '');
  }

  function useHls(item) {
    if (!isHlsUrl(item.playUrl)) return false;
    if (video.canPlayType('application/vnd.apple.mpegurl')) return false;
    return typeof window.Hls === 'function';
  }

  function stopHls() {
    if (!state.hls) return;
    try { state.hls.destroy(); } catch (err) { /* 忽略 */ }
    state.hls = null;
  }

  function attemptPlay() {
    video.volume = 1;
    if (!video.muted && video.volume !== 1) video.volume = 1;
    var promise = video.play();
    if (!promise || !promise.catch) return;
    promise.catch(function () {
      // 电视上偶尔会拒绝带声音的自动播放：先静音起播，用户按 OK 再恢复
      video.muted = true;
      video.play().then(function () {
        osd('已静音播放 · 按 OK 恢复声音');
      }).catch(function () {
        osd('按 OK 开始播放');
      });
    });
  }

  /* 先判断哪种引擎能放，再决定走原生还是网页，避免 15 秒黑屏后才回退 */
  var playToken = 0;
  var engineCache = {};

  function pickEngine(item) {
    var url = item.playUrl || item.url;
    if (!NATIVE || isNativeBlocked(url)) return Promise.resolve('web');
    if (engineCache[url]) return Promise.resolve(engineCache[url]);
    if (!isHlsUrl(url)) {
      engineCache[url] = 'native';
      return Promise.resolve('native');
    }
    // 带 EXT-X-MAP 的 fMP4 直播这台机器的 MediaPlayer 解不了，直接交给 hls.js
    // 只是猜一下容器类型，别为了探测把起播拖慢
    return fetchText(url, 1200)
      .then(function (result) {
        var engine = /#EXT-X-MAP/i.test(result.text) ? 'web' : 'native';
        engineCache[url] = engine;
        return engine;
      })
      .catch(function () {
        return 'native';
      });
  }

  function startNative(item) {
    setNativeSurface(true);
    try {
      window.TVShell.playerOpen(item.playUrl || item.url);
    } catch (err) {
      fallbackToWeb(item, '原生播放器启动失败，改用网页播放');
      return;
    }
    clearTimeout(nativeWatchdog);
    nativeWatchdog = setTimeout(function () {
      if (state.current && state.current.url === item.url && !state.nativePlaying) {
        fallbackToWeb(item, '这个流原生解不了，改用网页播放');
      }
    }, 6000);
  }

  function startWeb(item) {
    setNativeSurface(false);
    stopHls();

    if (useHls(item)) {
      var hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        capLevelToPlayerSize: true,
        maxBufferLength: 16,
        maxMaxBufferLength: 30,
        maxBufferSize: 24 * 1000 * 1000,
        manifestLoadingTimeOut: 30000,
        manifestLoadingMaxRetry: 2,
        levelLoadingTimeOut: 30000,
        levelLoadingMaxRetry: 2,
        fragLoadingTimeOut: 45000,
        fragLoadingMaxRetry: 2
      });
      state.hls = hls;
      hls.on(window.Hls.Events.ERROR, function (event, data) {
        if (!data || !data.fatal) return;
        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
          return;
        }
        hideSwitching();
        osd('这个源播不了，按上下键换台', 3000);
      });
      hls.attachMedia(video);
      hls.loadSource(item.playUrl);
    } else {
      video.src = item.playUrl;
      video.load();
    }

    attemptPlay();
  }

  function play(item, options) {
    var opts = options || {};
    if (!item) return;
    var same = state.current && state.current.url === item.url;
    state.current = item;
    state.live = false;

    if (same && !opts.force) {
      if (NATIVE && isNativeSurface()) {
        if (!state.nativePlaying) window.TVShell.playerPlay();
      } else if (video.paused) {
        attemptPlay();
      }
      return;
    }

    state.stalled = false;
    state.posMs = 0;
    state.durationMs = 0;
    showSwitching(item.title);
    state.pendingTitle = opts.silent ? '' : item.title;
    if (state.mode === 'channels') renderChannels();

    var token = playToken += 1;
    var engine = opts.web === true ? Promise.resolve('web') : pickEngine(item);
    engine.then(function (name) {
      // 期间又换了台，这次就算了
      if (token !== playToken) return;
      if (name === 'native') startNative(item);
      else startWeb(item);
    });
  }

  function togglePlay() {
    userPressed = true;
    if (NATIVE) {
      if (state.nativePlaying) window.TVShell.playerPause();
      else window.TVShell.playerPlay();
      return;
    }
    if (video.muted) {
      video.muted = false;
      video.volume = 1;
    }
    if (video.paused) {
      attemptPlay();
      osd('▶ 播放', 900);
    } else {
      video.pause();
      osd('❚❚ 暂停', 900);
    }
  }

  function seekBy(delta) {
    userPressed = true;
    if (NATIVE) {
      if (!state.durationMs) {
        osd('直播流不支持快进', 1400);
        return;
      }
      var nativeTarget = Math.max(0, Math.min(state.durationMs, state.posMs + delta * 1000));
      state.posMs = nativeTarget;
      window.TVShell.playerSeek(nativeTarget);
      showProgress();
      return;
    }
    if (!isFinite(video.duration) || video.duration <= 0) {
      osd('直播流不支持快进', 1400);
      return;
    }
    var target = Math.min(video.duration, Math.max(0, video.currentTime + delta));
    video.currentTime = target;
    showProgress();
  }

  function currentGroupItems() {
    if (!state.current) return null;
    for (var i = 0; i < state.groups.length; i += 1) {
      if (state.groups[i].name === state.current.group) return state.groups[i].items;
    }
    return null;
  }

  /** 换台只在本分类里循环；当前节目不在列表里时退回整张列表。 */
  function step(delta) {
    userPressed = true;
    if (!state.items.length) return;
    var pool = currentGroupItems() || state.items;
    var index = -1;
    for (var i = 0; i < pool.length; i += 1) {
      if (state.current && pool[i].url === state.current.url) { index = i; break; }
    }
    if (index === -1) index = delta > 0 ? -1 : 0;
    var next = pool[(index + delta + pool.length) % pool.length];
    play(next);
  }

  var healthTimer = 0;

  /** 声音在走但画面帧不增长 → 提示可以用系统播放器。
   *  这台盒子的 WebView 合成管线会掉帧，1080p 直播尤其明显。 */
  function watchHealth() {
    if (NATIVE) return;
    clearInterval(healthTimer);
    var lastFrames = -1;
    var stuck = 0;
    healthTimer = setInterval(function () {
      if (!state.current || video.paused) { lastFrames = -1; stuck = 0; return; }
      var quality = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
      var frames = quality ? quality.totalVideoFrames : -1;
      var noVideoTrack = video.videoWidth === 0 && video.currentTime > 4;
      if (lastFrames >= 0 && frames === lastFrames) stuck += 1; else stuck = 0;
      lastFrames = frames;
      if (state.stalled) return;
      if (noVideoTrack || stuck >= 2) {
        state.stalled = true;
        osd('画面卡住了 · 菜单键里可以换系统播放器', 6000);
      }
    }, 3000);
  }

  /* ---------- 进度条 ---------- */

  function updateProgress() {
    var duration = NATIVE ? state.durationMs : video.duration;
    var current = NATIVE ? state.posMs : video.currentTime;
    if (!isFinite(duration) || duration <= 0) return;
    var ratio = Math.min(1, Math.max(0, current / duration));
    progressFill.style.width = (ratio * 100).toFixed(2) + '%';
    progressTime.textContent = clock(current / 1000) + ' / ' + clock(duration / 1000);
  }

  function showProgress() {
    var duration = NATIVE ? state.durationMs : video.duration;
    if (!isFinite(duration) || duration <= 0) return;
    updateProgress();
    progressEl.classList.add('is-visible');
    clearTimeout(progressTimer);
    progressTimer = setTimeout(function () {
      progressEl.classList.remove('is-visible');
    }, 1600);
  }

  /* ---------- 换源层 ---------- */

  function renderSources() {
    sourceList.replaceChildren();
    state.sources.forEach(function (source, index) {
      var row = document.createElement('li');
      var dot = document.createElement('span');
      dot.className = 'dot';
      var label = document.createElement('span');
      label.className = 'label';
      label.textContent = source.label;
      row.append(dot, label);

      if (source.id === state.activeId) {
        row.classList.add('is-current');
        var sub = document.createElement('span');
        sub.className = 'sub';
        sub.textContent = '当前';
        row.appendChild(sub);
      }
      if (state.mode === 'sources' && index === state.sourceIndex) row.classList.add('is-focus');

      row.addEventListener('click', function () {
        if (state.mode !== 'sources') return;
        state.sourceIndex = index;
        renderSources();
        selectSource();
      });

      sourceList.appendChild(row);
    });

    if (hasNativePlayer()) {
      var nativeRow = document.createElement('li');
      nativeRow.className = 'native-row';
      var nativeLabel = document.createElement('span');
      nativeLabel.className = 'label';
      nativeLabel.textContent = '用系统播放器打开';
      var nativeSub = document.createElement('span');
      nativeSub.className = 'sub';
      nativeSub.textContent = '画面卡顿时可以试';
      nativeRow.append(nativeLabel, nativeSub);
      if (state.sourceIndex === state.sources.length) nativeRow.classList.add('is-focus');
      nativeRow.addEventListener('click', function () {
        if (state.mode !== 'sources') return;
        state.sourceIndex = state.sources.length;
        openNative();
      });
      sourceList.appendChild(nativeRow);
    }
  }

  function hasNativePlayer() {
    return !!(window.TVShell && typeof window.TVShell.openNative === 'function' && state.current);
  }

  function openNative() {
    var url = state.current && (state.current.playUrl || state.current.url);
    closePanels();
    if (!url || !hasNativePlayer()) {
      osd('这个环境没有系统播放器可用', 2200);
      return;
    }
    try {
      window.TVShell.openNative(url);
      osd('正在用系统播放器打开…', 2000);
    } catch (err) {
      osd('打开系统播放器失败', 2200);
    }
  }

  function openSources() {
    osd('');
    state.mode = 'sources';
    state.sourceIndex = Math.max(0, state.sources.indexOf(activeSource()));
    renderSources();
    sourceHint.classList.remove('is-error');
    sourceHint.textContent = '上下选择 · OK 确认 · 返回关闭';
    sourcePanel.classList.add('is-visible');
    scrollRow(sourceList, state.sourceIndex);
  }

  function closePanels() {
    state.mode = 'video';
    sourcePanel.classList.remove('is-visible');
    channelPanel.classList.remove('is-visible');
  }

  function selectSource() {
    if (state.sourceIndex >= state.sources.length) {
      openNative();
      return;
    }
    var source = state.sources[state.sourceIndex];
    if (!source || state.loading) return;

    // 没有切换源就不重复拉取，只把换台层打开
    if (source.id === state.activeId && state.items.length) {
      closePanels();
      openChannels();
      return;
    }

    state.loading = true;
    sourcePanel.classList.add('is-loading');
    sourceHint.classList.remove('is-error');
    sourceHint.textContent = '正在拉取 ' + source.label + '…';

    fetchSource(source)
      .then(function (result) {
        var items = parseItems(result);
        state.activeId = source.id;
        writeActiveId(source.id);
        state.loading = false;
        sourcePanel.classList.remove('is-loading');
        applyItems(source, items, { autoplay: true });
        closePanels();
        openChannels();
      })
      .catch(function (error) {
        state.loading = false;
        sourcePanel.classList.remove('is-loading');
        sourceHint.classList.add('is-error');
        sourceHint.textContent = '拉取失败：' + ((error && error.message) || '网络错误');
        osd('这个源拉不下来', 2000);
      });
  }

  /* ---------- 换台层 ----------
     按键只改 class + 滚动，不重建 DOM：这台盒子上重建列表会明显卡一下。 */

  var panel = {
    groups: [],
    items: [],
    groupKey: null,
    groupsDirty: true
  };

  function groupItems() {
    var group = state.groups[state.groupIndex];
    return group ? group.items : [];
  }

  function syncSelection() {
    var groupIndex = 0;
    var itemIndex = 0;
    if (state.current) {
      for (var i = 0; i < state.groups.length; i += 1) {
        if (state.groups[i].name !== state.current.group) continue;
        groupIndex = i;
        for (var j = 0; j < state.groups[i].items.length; j += 1) {
          if (state.groups[i].items[j].url === state.current.url) { itemIndex = j; break; }
        }
        break;
      }
    }
    state.groupIndex = groupIndex;
    state.itemIndex = itemIndex;
  }

  /** 播放列表换了（换源 / 刷新）之后要重建分类列表。 */
  function markChannelsDirty() {
    panel.groupsDirty = true;
    panel.groupKey = null;
  }

  function buildGroupRows() {
    groupList.replaceChildren();
    panel.groups = [];
    state.groups.forEach(function (group, index) {
      var row = document.createElement('li');
      var dot = document.createElement('span');
      dot.className = 'dot';
      var label = document.createElement('span');
      label.className = 'label';
      label.textContent = group.name;
      var sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = String(group.items.length);
      row.append(dot, label, sub);
      row.addEventListener('click', function () {
        if (state.mode !== 'channels') return;
        state.column = 'groups';
        state.groupIndex = index;
        state.itemIndex = 0;
        panel.groupKey = null;
        renderChannels();
      });
      groupList.appendChild(row);
      panel.groups.push(row);
    });
    panel.groupsDirty = false;
  }

  function buildItemRows() {
    var group = state.groups[state.groupIndex];
    var key = group ? group.name : '';
    if (panel.groupKey === key) return;
    panel.groupKey = key;
    itemList.replaceChildren();
    panel.items = [];
    (group ? group.items : []).forEach(function (item, index) {
      var row = document.createElement('li');
      var label = document.createElement('span');
      label.className = 'label';
      label.textContent = item.title;
      row.appendChild(label);
      if (item.duration) {
        var sub = document.createElement('span');
        sub.className = 'sub';
        sub.textContent = clock(item.duration);
        row.appendChild(sub);
      }
      row.addEventListener('click', function () {
        if (state.mode !== 'channels') return;
        state.column = 'items';
        state.itemIndex = index;
        confirmChannel();
      });
      itemList.appendChild(row);
      panel.items.push(row);
    });
    itemList.scrollTop = 0;
  }

  function scrollToRow(list, row) {
    if (!row) return;
    var listRect = list.getBoundingClientRect();
    var rowRect = row.getBoundingClientRect();
    var pad = 10;
    if (rowRect.top < listRect.top + pad) {
      list.scrollTop -= listRect.top + pad - rowRect.top;
    } else if (rowRect.bottom > listRect.bottom - pad) {
      list.scrollTop += rowRect.bottom - (listRect.bottom - pad);
    }
  }

  /** 只刷 class，不碰 DOM 结构。 */
  function paintChannels() {
    var group = state.groups[state.groupIndex];
    var current = state.current;
    var i;

    for (i = 0; i < panel.groups.length; i += 1) {
      var groupRow = panel.groups[i];
      groupRow.classList.toggle('is-selected', i === state.groupIndex);
      groupRow.classList.toggle('is-focus', i === state.groupIndex && state.column === 'groups');
      groupRow.classList.toggle('is-current', !!(current && current.group === state.groups[i].name));
    }

    for (i = 0; i < panel.items.length; i += 1) {
      var itemRow = panel.items[i];
      var item = group ? group.items[i] : null;
      itemRow.classList.toggle('is-selected', i === state.itemIndex);
      itemRow.classList.toggle('is-focus', i === state.itemIndex && state.column === 'items');
      itemRow.classList.toggle('is-playing', !!(current && item && current.url === item.url));
    }

    groupList.classList.toggle('is-focus', state.column === 'groups');
    itemList.classList.toggle('is-focus', state.column === 'items');
    channelTitle.textContent = '换台 · ' + (group ? group.name : '—');

    scrollToRow(groupList, panel.groups[state.groupIndex]);
    scrollToRow(itemList, panel.items[state.itemIndex]);
  }

  function renderChannels() {
    if (panel.groupsDirty) buildGroupRows();
    buildItemRows();
    paintChannels();
  }

  function openChannels() {
    if (!state.groups.length) {
      osd('还没有节目', 1600);
      return;
    }
    osd('');
    state.mode = 'channels';
    state.column = 'items';
    syncSelection();
    panel.groupKey = null;
    renderChannels();
    channelPanel.classList.add('is-visible');
  }

  function moveSelection(delta) {
    if (state.column === 'groups') {
      var count = state.groups.length;
      if (!count) return;
      state.groupIndex = (state.groupIndex + delta + count) % count;
      state.itemIndex = 0;
      panel.groupKey = null;
      renderChannels();
      return;
    }
    var list = groupItems();
    if (!list.length) return;
    state.itemIndex = (state.itemIndex + delta + list.length) % list.length;
    paintChannels();
  }

  function confirmChannel() {
    if (state.column === 'groups') {
      state.column = 'items';
      paintChannels();
      return;
    }
    var item = groupItems()[state.itemIndex];
    if (!item) return;
    closePanels();
    play(item, { force: true });
  }

  /* ---------- 按键 ---------- */

  function videoKey(code) {
    switch (code) {
      case 13:
      case 23:
        togglePlay();
        return true;
      case 37:
        seekBy(-10);
        return true;
      case 39:
        seekBy(10);
        return true;
      case 38:
        step(-1);
        return true;
      case 40:
        step(1);
        return true;
      default:
        return false;
    }
  }

  function sourceRowCount() {
    return state.sources.length + (hasNativePlayer() ? 1 : 0);
  }

  function sourcesKey(code) {
    switch (code) {
      case 38:
        state.sourceIndex = (state.sourceIndex - 1 + sourceRowCount()) % sourceRowCount();
        renderSources();
        scrollRow(sourceList, state.sourceIndex);
        return true;
      case 40:
        state.sourceIndex = (state.sourceIndex + 1) % sourceRowCount();
        renderSources();
        scrollRow(sourceList, state.sourceIndex);
        return true;
      case 13:
      case 23:
        if (state.sourceIndex >= state.sources.length) openNative();
        else selectSource();
        return true;
      default:
        return false;
    }
  }

  function channelsKey(code) {
    switch (code) {
      case 38:
        moveSelection(-1);
        return true;
      case 40:
        moveSelection(1);
        return true;
      case 37:
        state.column = 'groups';
        paintChannels();
        return true;
      case 39:
        state.column = 'items';
        paintChannels();
        return true;
      case 13:
      case 23:
        confirmChannel();
        return true;
      default:
        return false;
    }
  }

  function toggleMenu() {
    userPressed = true;
    if (state.mode === 'video') openSources();
    else closePanels();
  }

  function onKeyDown(event) {
    var code = event.keyCode;
    var handled = false;

    if (code === 82 || code === 93) {
      toggleMenu();
      handled = true;
    } else if (code === 4 || code === 27) {
      handled = window.__simpleBack();
    } else if (state.mode === 'video') {
      handled = videoKey(code);
    } else if (state.mode === 'sources') {
      handled = sourcesKey(code);
    } else {
      handled = channelsKey(code);
    }

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  /** 给 Android 壳用：返回 true 表示页面自己处理了。 */
  window.__simpleBack = function () {
    if (state.mode !== 'video') {
      closePanels();
      return true;
    }
    return false;
  };

  window.__simpleKey = function (name) {
    switch (name) {
      case 'menu': toggleMenu(); break;
      case 'toggle': togglePlay(); break;
      case 'play': if (video.paused) attemptPlay(); break;
      case 'pause': if (!video.paused) video.pause(); break;
      case 'next': step(1); break;
      case 'prev': step(-1); break;
      case 'ff': seekBy(30); break;
      case 'rew': seekBy(-10); break;
      default: return false;
    }
    return true;
  };

  /* ---------- 视频事件 ---------- */

  video.addEventListener('timeupdate', function () {
    if (progressEl.classList.contains('is-visible')) updateProgress();
  });
  video.addEventListener('loadedmetadata', function () {
    progressEl.classList.remove('is-visible');
  });
  video.addEventListener('playing', function () {
    document.body.classList.add('has-video');
    hideSwitching();
    video.volume = 1;
    watchHealth();
    if (state.pendingTitle) {
      osd(state.pendingTitle, 1600);
      state.pendingTitle = '';
    }
  });

  video.addEventListener('ended', function () {
    step(1);
  });
  video.addEventListener('error', function () {
    if (!video.getAttribute('src')) return;
    hideSwitching();
    osd('播放失败，按上下键换台', 2500);
  });

  /* ---------- 原生播放器 → 页面 ---------- */

  window.__nativeEvent = function (type, value) {
    switch (type) {
      case 'ready':
        state.durationMs = value || 0;
        clearTimeout(nativeWatchdog);
        break;
      case 'playing':
        state.nativePlaying = true;
        clearTimeout(bufferTimer);
        hideSwitching();
        if (state.pendingTitle) {
          osd(state.pendingTitle, 1600);
          state.pendingTitle = '';
        }
        break;
      case 'paused':
        state.nativePlaying = false;
        osd('❚❚ 暂停', 900);
        break;
      case 'ended':
        state.nativePlaying = false;
        step(1);
        break;
      case 'buffering':
        if (value) {
          clearTimeout(bufferTimer);
          bufferTimer = setTimeout(function () {
            if (state.nativePlaying) showSwitching('正在缓冲…');
          }, 1200);
        } else {
          clearTimeout(bufferTimer);
          if (switchingText.textContent === '正在缓冲…') hideSwitching();
        }
        break;
      case 'error':
        state.nativePlaying = false;
        clearTimeout(nativeWatchdog);
        hideSwitching();
        if (state.current && useNativeFor(state.current)) {
          fallbackToWeb(state.current, '这个流原生解不了，改用网页播放');
        } else {
          osd('这个频道播不了 · 上下键换台', 3000);
        }
        break;
      default:
        break;
    }
  };

  window.__nativeTick = function (position, duration, playing) {
    state.posMs = position || 0;
    if (duration) state.durationMs = duration;
    state.nativePlaying = !!playing;
    if (progressEl.classList.contains('is-visible')) updateProgress();
  };

  document.addEventListener('contextmenu', function (event) { event.preventDefault(); });
  window.addEventListener('keydown', onKeyDown, true);

  /* ---------- 启动 ---------- */

  function boot() {
    [progressEl, osdEl, sourcePanel, channelPanel].forEach(function (el) {
      if (el) el.hidden = false;
    });

    video.volume = 1;
    showSwitching('正在加载…');

    state.sources = loadSources();
    // ?m3u= 指定的临时源优先级最高（和完整版一致）
    state.activeId = params.get('m3u') ? 'custom:url' : readActiveId();
    if (!activeSource()) state.activeId = state.sources[0] ? state.sources[0].id : '';

    renderSources();
    var source = activeSource();
    if (!source) {
      osd('没有可用的节目源', 4000);
      return;
    }

    osd('正在加载播放列表…', 3000);
    fetchWithFallback(source)
      .then(function (result) {
        state.activeId = result.source.id;
        writeActiveId(result.source.id);
        applyItems(result.source, result.items, { autoplay: true });
      })
      .catch(function (error) {
        osd('播放列表加载失败：' + ((error && error.message) || '网络错误'), 5000);
      });

    // 定时静默刷新（换台/换源都会打断，所以用最长间隔）
    setInterval(function () {
      if (document.hidden || !state.items.length) return;
      if (Date.now() - state.loadedAt < REFRESH_MS) return;
      fetchSource(state.source)
        .then(function (result) {
          applyItems(state.source, parseItems(result), { keep: true });
        })
        .catch(function () { /* 静默失败 */ });
    }, 60000);

    // 首屏自动播放掉了就兜几次，用户一按键立刻收手
    var autoResume = setInterval(function () {
      if (userPressed) {
        clearInterval(autoResume);
        return;
      }
      if (!video.paused || video.ended) return;
      if (!video.getAttribute('src') || video.readyState < 2) return;
      if (video.currentTime > 1) { clearInterval(autoResume); return; }
      video.play().catch(function () {});
    }, 1000);
    setTimeout(function () { clearInterval(autoResume); }, 20000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
