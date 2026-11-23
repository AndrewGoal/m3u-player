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
    live: false
  };

  var progressTimer = 0;
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

  function currentIndex() {
    if (!state.current) return -1;
    for (var i = 0; i < state.items.length; i += 1) {
      if (state.items[i].url === state.current.url) return i;
    }
    return -1;
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

  function play(item, options) {
    var opts = options || {};
    if (!item) return;
    var same = state.current && state.current.url === item.url;
    state.current = item;
    state.live = false;

    if (same && !opts.force) {
      if (video.paused) attemptPlay();
      return;
    }

    stopHls();

    if (useHls(item)) {
      var hls = new window.Hls({
        enableWorker: true,
        manifestLoadingTimeOut: 30000,
        manifestLoadingMaxRetry: 3,
        levelLoadingTimeOut: 30000,
        fragLoadingTimeOut: 45000
      });
      state.hls = hls;
      hls.on(window.Hls.Events.ERROR, function (event, data) {
        if (!data || !data.fatal) return;
        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
          return;
        }
        osd('这个源播不了，按上下键换台', 3000);
      });
      hls.attachMedia(video);
      hls.loadSource(item.playUrl);
    } else {
      video.src = item.playUrl;
      video.load();
    }

    attemptPlay();

    if (!opts.silent) osd(item.title, 1800);
    if (state.mode === 'channels') renderChannels();
  }

  function togglePlay() {
    userPressed = true;
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
    if (!isFinite(video.duration) || video.duration <= 0) {
      osd('直播流不支持快进', 1400);
      return;
    }
    var target = Math.min(video.duration, Math.max(0, video.currentTime + delta));
    video.currentTime = target;
    showProgress();
  }

  function step(delta) {
    userPressed = true;
    if (!state.items.length) return;
    var index = currentIndex();
    if (index === -1) index = delta > 0 ? -1 : 0;
    var next = state.items[(index + delta + state.items.length) % state.items.length];
    play(next);
  }

  /* ---------- 进度条 ---------- */

  function updateProgress() {
    var duration = video.duration;
    if (!isFinite(duration) || duration <= 0) return;
    var ratio = Math.min(1, Math.max(0, video.currentTime / duration));
    progressFill.style.width = (ratio * 100).toFixed(2) + '%';
    progressTime.textContent = clock(video.currentTime) + ' / ' + clock(duration);
  }

  function showProgress() {
    if (!isFinite(video.duration) || video.duration <= 0) return;
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

  /* ---------- 换台层 ---------- */

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

  function renderChannels() {
    var groups = state.groups;
    var items = groupItems();
    if (state.groupIndex >= groups.length) state.groupIndex = 0;
    if (state.itemIndex >= items.length) state.itemIndex = 0;

    groupList.replaceChildren();
    groups.forEach(function (group, index) {
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

      if (state.current && group.name === state.current.group) row.classList.add('is-current');
      if (index === state.groupIndex) {
        row.classList.add('is-selected');
        if (state.column === 'groups') row.classList.add('is-focus');
      }
      groupList.appendChild(row);
    });

    itemList.replaceChildren();
    items.forEach(function (item, index) {
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
      if (state.current && item.url === state.current.url) row.classList.add('is-playing');
      if (index === state.itemIndex) {
        row.classList.add('is-selected');
        if (state.column === 'items') row.classList.add('is-focus');
      }

      row.addEventListener('click', function () {
        if (state.mode !== 'channels') return;
        state.column = 'items';
        state.itemIndex = index;
        confirmChannel();
      });
      itemList.appendChild(row);
    });

    groupList.classList.toggle('is-focus', state.column === 'groups');
    itemList.classList.toggle('is-focus', state.column === 'items');
    channelTitle.textContent = '换台 · ' + (items.length ? groups[state.groupIndex].name : '—');

    scrollRow(groupList, state.groupIndex);
    scrollRow(itemList, state.itemIndex);
  }

  function scrollRow(list, index) {
    var row = list.children[index];
    if (row) row.scrollIntoView({ block: 'nearest' });
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
    renderChannels();
    channelPanel.classList.add('is-visible');
  }

  function moveSelection(delta) {
    if (state.column === 'groups') {
      var count = state.groups.length;
      if (!count) return;
      state.groupIndex = (state.groupIndex + delta + count) % count;
      state.itemIndex = 0;
    } else {
      var list = groupItems();
      if (!list.length) return;
      state.itemIndex = (state.itemIndex + delta + list.length) % list.length;
    }
    renderChannels();
  }

  function confirmChannel() {
    if (state.column === 'groups') {
      state.column = 'items';
      renderChannels();
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

  function sourcesKey(code) {
    switch (code) {
      case 38:
        state.sourceIndex = (state.sourceIndex - 1 + state.sources.length) % state.sources.length;
        renderSources();
        scrollRow(sourceList, state.sourceIndex);
        return true;
      case 40:
        state.sourceIndex = (state.sourceIndex + 1) % state.sources.length;
        renderSources();
        scrollRow(sourceList, state.sourceIndex);
        return true;
      case 13:
      case 23:
        selectSource();
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
        renderChannels();
        return true;
      case 39:
        state.column = 'items';
        renderChannels();
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
    video.volume = 1;
  });
  video.addEventListener('ended', function () {
    step(1);
  });
  video.addEventListener('error', function () {
    if (!video.getAttribute('src')) return;
    osd('播放失败，按上下键换台', 2500);
  });

  document.addEventListener('contextmenu', function (event) { event.preventDefault(); });
  window.addEventListener('keydown', onKeyDown, true);

  /* ---------- 启动 ---------- */

  function boot() {
    [progressEl, osdEl, sourcePanel, channelPanel].forEach(function (el) {
      if (el) el.hidden = false;
    });

    video.volume = 1;

    state.sources = loadSources();
    state.activeId = readActiveId();
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
