/**
 * 海纳百川-简洁播放器（原生播放版）
 *
 * 画面和声音都交给壳里的 ExoPlayer（SurfaceView 硬解），网页只画界面：
 *   左右键   快退 / 快进 10 秒（进度条短暂出现）
 *   上下键   当前分类里循环换台
 *   OK 键    播放 / 暂停
 *   菜单键   换源层（居中、半透明）
 *   返回键   关面板；没面板时连按两次退出
 *
 * 换源层：上下选源，OK 拉取该源（同一个源不重复拉取）并打开换台层。
 * 换台层：左边分类、右边频道，左右切栏、上下选择、OK 换台。
 */
(function () {
  'use strict';

  var Parser = window.PlaylistParser;
  var SDK = window.M3UPlayer;
  var SHELL = !!(window.TVShell && typeof window.TVShell.playerOpen === 'function');

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

  var progressEl = document.getElementById('progress');
  var progressFill = document.getElementById('progressFill');
  var progressTime = document.getElementById('progressTime');
  var osdEl = document.getElementById('osd');
  var switchingEl = document.getElementById('switching');
  var switchingText = document.getElementById('switchingText');
  var switchingSpeed = document.getElementById('switchingSpeed');
  var pauseEl = document.getElementById('pausePanel');
  var pauseTitle = document.getElementById('pauseTitle');
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
    playing: false,
    posMs: 0,
    durationMs: 0,
    pendingTitle: '',
    bandwidth: 0,
    mode: 'video',        // video | sources | channels
    column: 'items',      // groups | items
    sourceIndex: 0,
    groupIndex: 0,
    itemIndex: 0
  };

  var panel = { groups: [], items: [], groupKey: null, groupsDirty: true };

  var progressTimer = 0;
  var osdTimer = 0;
  var bufferTimer = 0;
  var watchdogTimer = 0;
  var switchingTimer = 0;
  var userPressed = false;

  /* ---------- 壳接口 ---------- */

  function shell(name) {
    if (!SHELL) return;
    try {
      var fn = window.TVShell[name];
      if (typeof fn === 'function') {
        if (arguments.length === 1) fn.call(window.TVShell);
        else fn.apply(window.TVShell, Array.prototype.slice.call(arguments, 1));
      }
    } catch (err) { /* 壳不在或调用失败都不该打断界面 */ }
  }

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

  function showSwitching(text) {
    switchingText.textContent = text || '正在换台…';
    switchingEl.hidden = false;
    paintSpeed();
    clearTimeout(switchingTimer);
    switchingTimer = setTimeout(function () {
      if (switchingEl.hidden) return;
      switchingText.textContent = '这个源一直没有画面，换一个台试试';
      osd('这个源没有响应 · 上下键换台', 5000);
    }, 15000);
  }

  function hideSwitching() {
    clearTimeout(switchingTimer);
    switchingEl.hidden = true;
    if (switchingSpeed) switchingSpeed.textContent = '';
  }

  function formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond || bytesPerSecond < 1) return '';
    if (bytesPerSecond >= 1024 * 1024) return (bytesPerSecond / 1048576).toFixed(1) + ' MB/s';
    if (bytesPerSecond >= 1024) return (bytesPerSecond / 1024).toFixed(0) + ' KB/s';
    return bytesPerSecond + ' B/s';
  }

  function paintSpeed() {
    if (!switchingSpeed) return;
    switchingSpeed.textContent = switchingEl.hidden ? '' : formatSpeed(state.bandwidth);
  }

  function showPause() {
    if (!state.current) return;
    pauseTitle.textContent = state.current.title;
    pauseEl.hidden = false;
  }

  function hidePause() {
    pauseEl.hidden = true;
  }

  function isHlsUrl(url) {
    return /\.m3u8(\?|#|$)/i.test(url || '');
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

  function fetchSource(source) {
    if (!source) return Promise.reject(new Error('没有可用的节目源'));

    if (source.provider) {
      var provider = SDK && SDK.providers && SDK.providers[source.provider];
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

  /** IPTV 那份列表的分类按倒序排：原来最后一条（台湾）排到最前，作为默认入口。 */
  function isIptvSource(source) {
    return !!source && source.id === 'builtin:iptv-file';
  }

  function buildGroups(source, items) {
    var groups = Parser.groupItems(items);
    if (isIptvSource(source)) groups.reverse();
    return groups;
  }

  function defaultItem(source) {
    if (isIptvSource(source) && state.groups.length) return state.groups[0].items[0];
    return state.items[0];
  }

  function applyItems(source, items, options) {
    var opts = options || {};
    state.source = source;
    state.items = items;
    state.groups = buildGroups(source, items);
    state.loadedAt = Date.now();

    var kept = opts.keep ? (findByUrl(state.current) || state.current) : null;
    state.current = kept || null;

    panel.groupsDirty = true;
    panel.groupKey = null;

    if (!state.current && opts.autoplay !== false) {
      play(defaultItem(source), { force: true });
    }

    if (state.mode === 'channels') {
      syncSelection();
      renderChannels();
    }
    renderSources();
  }

  function findByUrl(item) {
    if (!item) return null;
    for (var i = 0; i < state.items.length; i += 1) {
      if (state.items[i].url === item.url) return state.items[i];
    }
    return null;
  }

  /* ---------- 播放（全部走原生 ExoPlayer） ---------- */

  function play(item, options) {
    var opts = options || {};
    if (!item) return;
    if (!SHELL) {
      osd('需要电视版才能播放', 3000);
      return;
    }

    var same = state.current && state.current.url === item.url;
    state.current = item;

    if (same && !opts.force) {
      if (!state.playing) shell('playerPlay');
      return;
    }

    state.posMs = 0;
    state.durationMs = 0;
    state.playing = false;
    hidePause();
    showSwitching(item.title);
    state.pendingTitle = opts.silent ? '' : item.title;
    if (state.mode === 'channels') renderChannels();

    var url = item.playUrl || item.url;
    shell('playerOpen', url, isHlsUrl(url));

    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(function () {
      if (state.current && state.current.url === item.url && !state.playing) {
        hideSwitching();
        osd('这个频道一直没有画面 · 上下键换台', 4000);
      }
    }, 20000);
  }

  function togglePlay() {
    userPressed = true;
    if (!SHELL) return;
    if (state.playing) shell('playerPause');
    else shell('playerPlay');
  }

  function seekBy(delta) {
    userPressed = true;
    if (!state.durationMs) {
      osd('直播流不支持快进', 1400);
      return;
    }
    var target = Math.max(0, Math.min(state.durationMs, state.posMs + delta * 1000));
    state.posMs = target;
    shell('playerSeek', Math.round(target));
    showProgress();
  }

  function currentGroupItems() {
    if (!state.current) return null;
    for (var i = 0; i < state.groups.length; i += 1) {
      if (state.groups[i].name === state.current.group) return state.groups[i].items;
    }
    return null;
  }

  /** 换台只在本分类里循环。 */
  function step(delta) {
    userPressed = true;
    if (!state.items.length) return;
    var pool = currentGroupItems() || state.items;
    var index = -1;
    for (var i = 0; i < pool.length; i += 1) {
      if (state.current && pool[i].url === state.current.url) { index = i; break; }
    }
    if (index === -1) index = delta > 0 ? -1 : 0;
    play(pool[(index + delta + pool.length) % pool.length]);
  }

  /* ---------- 进度条 ---------- */

  function updateProgress() {
    if (!state.durationMs) return;
    var ratio = Math.min(1, Math.max(0, state.posMs / state.durationMs));
    progressFill.style.width = (ratio * 100).toFixed(2) + '%';
    progressTime.textContent = clock(state.posMs / 1000) + ' / ' + clock(state.durationMs / 1000);
  }

  function showProgress() {
    if (!state.durationMs) {
      osd('直播流不支持快进', 1400);
      return;
    }
    updateProgress();
    progressEl.classList.add('is-visible');
    clearTimeout(progressTimer);
    progressTimer = setTimeout(function () {
      progressEl.classList.remove('is-visible');
    }, 1600);
  }

  /* ---------- 换源层 ---------- */

  function hasNativePlayer() {
    return !!(SHELL && state.current && typeof window.TVShell.openNative === 'function');
  }

  function openNative() {
    var url = state.current && (state.current.playUrl || state.current.url);
    closePanels();
    if (!url || !hasNativePlayer()) {
      osd('这个环境没有系统播放器可用', 2200);
      return;
    }
    shell('openNative', url);
    osd('正在用系统播放器打开…', 2000);
  }

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
      var nativeLabel = document.createElement('span');
      nativeLabel.className = 'label';
      nativeLabel.textContent = '用系统播放器打开';
      var nativeSub = document.createElement('span');
      nativeSub.className = 'sub';
      nativeSub.textContent = '播不了时用';
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

  function openSources() {
    osd('');
    hidePause();
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

  /* ---------- 换台层（按键只切 class，不重建 DOM） ---------- */

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

  function scrollRow(list, row) {
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

  function scrollToIndex(list, index) {
    scrollRow(list, list.children[index]);
  }

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

    scrollToIndex(groupList, state.groupIndex);
    scrollToIndex(itemList, state.itemIndex);
  }

  function renderChannels() {
    if (panel.groupsDirty) buildGroupRows();
    buildItemRows();
    paintChannels();
  }

  function openChannels() {
    hidePause();
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
      case 'play': if (!state.playing) shell('playerPlay'); break;
      case 'pause': if (state.playing) shell('playerPause'); break;
      case 'next': step(1); break;
      case 'prev': step(-1); break;
      case 'ff': seekBy(30); break;
      case 'rew': seekBy(-10); break;
      default: return false;
    }
    return true;
  };

  /* ---------- 原生播放器 → 页面 ---------- */

  window.__nativeEvent = function (type, value) {
    switch (type) {
      case 'ready':
        state.durationMs = value || 0;
        clearTimeout(watchdogTimer);
        break;
      case 'playing':
        state.playing = true;
        clearTimeout(bufferTimer);
        clearTimeout(watchdogTimer);
        hidePause();
        hideSwitching();
        if (state.pendingTitle) {
          osd(state.pendingTitle, 1600);
          state.pendingTitle = '';
        }
        break;
      case 'paused':
        // 用户主动暂停：显示台名 + 按键说明（换台/缓冲过程中不弹）
        state.playing = false;
        if (switchingEl.hidden && state.mode === 'video') showPause();
        break;
      case 'ended':
        state.playing = false;
        step(1);
        break;
      case 'buffering':
        if (value) {
          clearTimeout(bufferTimer);
          // 卡住时不要弹「暂停」，而是把台名 + 网速摆出来，直到重新出画
          bufferTimer = setTimeout(function () {
            if (state.playing) return;
            showSwitching(state.current ? state.current.title : '正在缓冲…');
          }, 1200);
        } else {
          clearTimeout(bufferTimer);
          if (!state.playing && state.mode === 'video') hideSwitching();
        }
        break;
      case 'error':
        state.playing = false;
        clearTimeout(watchdogTimer);
        hidePause();
        hideSwitching();
        osd('这个频道播不了 · 上下键换台', 3000);
        break;
      default:
        break;
    }
  };

  window.__nativeTick = function (position, duration, playing, bytesPerSecond) {
    state.posMs = position || 0;
    if (duration) state.durationMs = duration;
    state.playing = !!playing;
    if (typeof bytesPerSecond === 'number') state.bandwidth = bytesPerSecond;
    if (progressEl.classList.contains('is-visible')) updateProgress();
    paintSpeed();
  };

  document.addEventListener('contextmenu', function (event) { event.preventDefault(); });
  window.addEventListener('keydown', onKeyDown, true);

  /* ---------- 启动 ---------- */

  function boot() {
    progressEl.hidden = false;
    osdEl.hidden = false;
    sourcePanel.hidden = false;
    channelPanel.hidden = false;
    pauseEl.hidden = true;

    if (!Parser || !SDK) {
      showSwitching('播放器脚本加载失败');
      return;
    }

    if (!SHELL) {
      // 没有壳就没有原生播放器，这套界面用不了
      showSwitching('请用「气象分析」电视版打开');
      return;
    }

    document.documentElement.classList.add('native');
    showSwitching('正在加载…');

    state.sources = loadSources();
    state.activeId = params.get('m3u') ? 'custom:url' : readActiveId();
    if (!activeSource()) state.activeId = state.sources[0] ? state.sources[0].id : '';

    renderSources();
    var source = activeSource();
    if (!source) {
      hideSwitching();
      osd('没有可用的节目源', 4000);
      return;
    }

    fetchWithFallback(source)
      .then(function (result) {
        state.activeId = result.source.id;
        writeActiveId(result.source.id);
        applyItems(result.source, result.items, { autoplay: true });
      })
      .catch(function (error) {
        hideSwitching();
        osd('播放列表加载失败：' + ((error && error.message) || '网络错误'), 5000);
      });

    setInterval(function () {
      if (document.hidden || !state.items.length || !state.source) return;
      if (Date.now() - state.loadedAt < REFRESH_MS) return;
      fetchSource(state.source)
        .then(function (result) {
          applyItems(state.source, parseItems(result), { keep: true });
        })
        .catch(function () { /* 静默失败 */ });
    }, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
