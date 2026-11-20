/*
 * TapePost · X 页面内「互关管理 / 扫描」浮层（ISOLATED world，1.5.21）
 * ---------------------------------------------------------------
 * 把 Followback Marker 好用的页面内交互吸收到 TapePost 自己的架构里：
 *   - X 关注中 / 粉丝页右侧一个全中文浮层：全量扫描、增量续扫、停止、进度；
 *   - 关注列表行内标红「未回关」，可随时开关，关闭即刻清除标记；
 *   - 「从当前位置选未回关」把可见账号带入独立分析面板（仍须预演 + 确认）。
 *
 * 复用既有链路，不重复造轮子：
 *   - 浮层只写 followCapture，follow-bridge.js 的 storage.onChanged 会自动
 *     开启 MAIN world 的被动采集并自动滚动，1.5.20 的实时落盘原样生效；
 *   - 名单、白名单、取关任务全部沿用原来的 chrome.storage.local 结构。
 *
 * 安全不变量（任何改动都不能破）：
 *   - 不 fetch、不发 XHR、不重放请求、不调用 X 任何写接口；
 *   - 不读取 cookie / ct0 / Authorization / 请求头 / 登录态；
 *   - 不写 followTask、不构造 confirmed 任务；取关必须由用户在面板里
 *     走「预演 → 我确认 → 执行」，浮层只提供待选名单；
 *   - 粉丝名单为空时绝不标红（不能把所有关注都当成未回关）；
 *   - 只在本机读写公开主页资料，不上传、不外发。
 */
(function () {
  'use strict';
  if (window.__tapeFollowOverlay) return;
  window.__tapeFollowOverlay = true;

  var Core = window.FollowCore;
  var RESERVED = /^(i|home|explore|settings|messages|notifications|search|compose|intent|share|login|signup|account|tos|privacy)$/i;

  /* 纯逻辑层：不碰 DOM / chrome / 网络，供 Node vm 离线断言。 */
  var Pure = {
    pageSource: function (pathname) {
      var p = String(pathname || '').toLowerCase();
      if (p.indexOf('followers') !== -1) return 'followers';
      if (p.indexOf('following') !== -1) return 'following';
      return '';
    },

    handleFromHref: function (href) {
      var seg = String(href || '').split('?')[0].split('#')[0].split('/')[1] || '';
      var h = Core ? Core.lowerHandle(seg) : seg.toLowerCase();
      if (Core ? !Core.validHandle(h) : !/^[a-z0-9_]{1,20}$/.test(h)) return '';
      if (RESERVED.test(h)) return '';
      return h;
    },

    /* 集合差判定必须两个名单都在：只采了「关注中」时，不能把所有人标成未回关。 */
    shouldMark: function (following, followers) {
      return !!(followers && Object.keys(followers).length);
    },

    notBackHandles: function (following, followers) {
      var out = Object.create(null);
      if (!Pure.shouldMark(following, followers) || !Core) return out;
      Core.relationSets(following || {}, followers).notBack.forEach(function (u) {
        out[Core.lowerHandle(u.handle)] = true;
      });
      return out;
    },

    /* 增量续扫没有可用锚点时自动退回全量，避免用户点了没反应。 */
    buildCapture: function (p) {
      p = p || {};
      var mode = p.mode === 'incremental' ? 'incremental' : 'full';
      if (mode === 'incremental') {
        var a = p.anchor;
        if (!a || a.source !== p.source || !a.savedAt ||
            (a.me && p.me && a.me !== p.me)) mode = 'full';
      }
      var had = Number(p.had) || 0;
      var now = Number(p.now) || 0;
      return {
        status: 'running', target: p.source, me: p.me || '', mode: mode,
        startedAt: now, scrolls: 0, idle: 0, count: had, lastCount: had,
        lastTickAt: now, savedAt: Number(p.savedAt) || 0,
        resumedFrom: had, message: ''
      };
    },

    buildDraft: function (handles, source, now) {
      var out = [], seen = Object.create(null);
      (handles || []).forEach(function (h) {
        var k = Core ? Core.lowerHandle(h) : String(h || '').toLowerCase();
        if (!k || seen[k] || (Core ? !Core.validHandle(k) : false)) return;
        seen[k] = true;
        out.push(k);
      });
      return { handles: out, at: now, source: source, from: 'overlay' };
    },

    statusText: function (cap, counts) {
      var c = cap || {}, f = (counts && counts.following) || 0, r = (counts && counts.followers) || 0;
      var base = '本机已存 <b>' + (f + r) + '</b> 人（关注中 ' + f + ' / 粉丝 ' + r + '）';
      if (c.status === 'running') return base + ' · 正在扫描，已滚动 ' + (c.scrolls || 0) + ' 次';
      if (c.status === 'done') return base + ' · 本轮扫描完成';
      if (c.status === 'stopped') return base + ' · 已停止，名单仍在本机';
      if (c.status === 'interrupted') return base + ' · 上次扫描中断，名单仍在本机';
      return base + ' · 尚未扫描';
    }
  };
  window.TapeFollowOverlay = Pure;

  if (!Core || typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;

  var KEY = {
    data: 'followData', capture: 'followCapture', anchor: 'followScanAnchor',
    draft: 'followSelectionDraft', ui: 'followOverlayUi'
  };
  var ROUTE_MS = 1200;
  var MARK_MS = 1600;
  var ui = { markEnabled: false, collapsed: false };
  var root = null;
  var lastPath = '';
  var hintTimer = 0;

  var $ = function (id) { return document.getElementById(id); };
  function get(keys) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get(keys, function (r) { resolve(r || {}); }); }
      catch (e) { resolve({}); }
    });
  }
  function set(obj) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.set(obj, function () { resolve(true); }); }
      catch (e) { resolve(false); }
    });
  }
  function wrap(key, val) { var o = {}; o[key] = val; return o; }
  function lower(v) { return Core.lowerHandle(v); }

  function source() { return Pure.pageSource(location.pathname); }

  function meHandle() {
    try {
      var a = document.querySelector('[data-testid="AppTabBar_Profile_Link"]') ||
        document.querySelector('a[href^="/"][data-testid*="Profile"]');
      var h = Pure.handleFromHref(a && a.getAttribute('href'));
      if (h) return h;
    } catch (e) {}
    var m = String(location.pathname || '').match(/^\/([A-Za-z0-9_]{1,20})\/(following|followers)/i);
    return m ? lower(m[1]) : '';
  }

  /* 扩展内部消息：由后台 chrome.tabs.create 打开自己的 follow.html。
   * 内容脚本里直接 window.open('chrome-extension://…') 会被 Chrome 拦，
   * 也不该为此新增 web_accessible_resources。 */
  function openPanel() {
    try {
      chrome.runtime.sendMessage({ type: 'TAPEFOLLOW_OPEN_PANEL' }, function () {
        void (chrome.runtime && chrome.runtime.lastError);
      });
      return true;
    } catch (e) { return false; }
  }

  function hint(text, warn) {
    var el = $('tpfHint');
    if (!el) return;
    el.textContent = text;
    el.className = 'tpf-hint' + (warn ? ' tpf-warn' : '');
  }

  function defaultHint(counts, anchor) {
    var f = counts.following || 0, r = counts.followers || 0;
    if (!r) {
      hint('还没有「粉丝」名单：请先在浮层切到自己的粉丝页点「全量扫描」，或在分析面板采集一次粉丝。' +
        '只有两个名单都齐了才能判断谁没回关，扩展不会随便标红。', true);
      return;
    }
    if (!f) {
      hint('还没有「关注中」名单：请在关注中页点一次「全量扫描」，采完再回来看未回关。', true);
      return;
    }
    var tail = anchor && anchor.savedAt
      ? '上次扫描停在 ' + (anchor.count || 0) + ' 人，可点「增量续扫」接着补。'
      : '开启「列表里标红未回关」可在 X 列表里直接看到标记。';
    hint('两个名单都已保存。' + tail + '扫描只补齐名单，不会删除已存的人。');
  }

  var HTML =
    '<div class="tpf-head">' +
      '<span class="tpf-logo">T</span>' +
      '<span class="tpf-title"><b>TapePost · 互关管理</b><small>在 X 页面内扫描（本机计算）</small></span>' +
      '<button type="button" class="tpf-fold" id="tpfFold" title="收起 / 展开">−</button>' +
    '</div>' +
    '<div class="tpf-body">' +
      '<div class="tpf-stat" id="tpfStat">本机已存 0 人 · 尚未扫描</div>' +
      '<div class="tpf-bar"><i id="tpfBar"></i></div>' +
      '<div class="tpf-btns">' +
        '<button type="button" class="tpf-btn tpf-primary" id="tpfFull">全量扫描</button>' +
        '<button type="button" class="tpf-btn" id="tpfResume">增量续扫</button>' +
        '<button type="button" class="tpf-btn tpf-stop" id="tpfStop">停止</button>' +
      '</div>' +
      '<label class="tpf-switch" for="tpfMark">' +
        '<input type="checkbox" id="tpfMark" /> 列表里标红「未回关」' +
      '</label>' +
      '<div class="tpf-links">' +
        '<a class="tpf-link" id="tpfPanelLink" href="#" rel="noopener">📊 打开分析面板</a>' +
        '<button type="button" class="tpf-pick" id="tpfPick">从当前位置选未回关</button>' +
      '</div>' +
      '<div class="tpf-hint" id="tpfHint">两个名单都采齐后，才能判断谁没回关。</div>' +
    '</div>';

  function bindOverlay() {
    var on = function (id, fn) { var el = $(id); if (el && el.addEventListener) el.addEventListener('click', fn); };
    on('tpfFold', function () {
      ui.collapsed = !ui.collapsed;
      if (root) root.className = 'tpf-overlay' + (ui.collapsed ? ' tpf-collapsed' : '');
      var f = $('tpfFold'); if (f) f.textContent = ui.collapsed ? '+' : '−';
      set(wrap(KEY.ui, ui));
    });
    on('tpfFull', function () { startScan('full'); });
    on('tpfResume', function () { startScan('incremental'); });
    on('tpfStop', stopScan);
    on('tpfPick', pickVisible);
    on('tpfPanelLink', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (!openPanel()) transient('打开分析面板失败：请点插件弹窗顶部的「👥 互关管理」入口。', true);
    });
    var mk = $('tpfMark');
    if (mk && mk.addEventListener) {
      mk.addEventListener('change', function (e) {
        ui.markEnabled = !!(e && e.target && e.target.checked);
        set(wrap(KEY.ui, ui));
        if (ui.markEnabled) markRows(); else clearMarks();
      });
    }
  }

  function build() {
    if ($('tpfOverlay')) return $('tpfOverlay');
    try {
      root = document.createElement('div');
      root.id = 'tpfOverlay';
      root.className = 'tpf-overlay' + (ui.collapsed ? ' tpf-collapsed' : '');
      root.innerHTML = HTML;
      (document.body || document.documentElement).appendChild(root);
      bindOverlay();
    } catch (e) { root = null; }
    return root;
  }

  function destroy() {
    clearMarks();
    try { if (root && root.parentNode) root.parentNode.removeChild(root); } catch (e) {}
    try { var el = $('tpfOverlay'); if (el && el.parentNode) el.parentNode.removeChild(el); } catch (e) {}
    root = null;
  }

  async function render() {
    if (!root || !source()) return;
    var r = await get([KEY.data, KEY.capture, KEY.anchor]);
    var d = r[KEY.data] || {};
    var f = d.following && typeof d.following === 'object' ? d.following : {};
    var fr = d.followers && typeof d.followers === 'object' ? d.followers : {};
    var counts = { following: Object.keys(f).length, followers: Object.keys(fr).length };
    var cap = r[KEY.capture] || {};
    var stat = $('tpfStat');
    if (stat) stat.innerHTML = Pure.statusText(cap, counts);
    var bar = $('tpfBar');
    if (bar && bar.style) {
      var w = cap.status === 'running' ? Math.min(96, 8 + (cap.scrolls || 0) * 2) : (cap.status === 'done' ? 100 : 0);
      bar.style.width = w + '%';
    }
    ['tpfFull', 'tpfResume'].forEach(function (id) {
      var b = $(id); if (b) b.disabled = cap.status === 'running';
    });
    var stop = $('tpfStop'); if (stop) stop.disabled = cap.status !== 'running';
    var mk = $('tpfMark'); if (mk) mk.checked = !!ui.markEnabled;
    var fold = $('tpfFold'); if (fold) fold.textContent = ui.collapsed ? '+' : '−';
    if (!hintTimer) defaultHint(counts, r[KEY.anchor]);
  }

  function transient(text, warn) {
    hint(text, warn);
    if (hintTimer) { try { clearTimeout(hintTimer); } catch (e) {} }
    hintTimer = setTimeout(function () { hintTimer = 0; render(); }, 6000);
  }

  async function startScan(mode) {
    var s = source();
    if (!s) { transient('请停留在自己的「关注中」或「粉丝」页面再扫描。', true); return; }
    var r = await get([KEY.data, KEY.anchor]);
    var d = r[KEY.data] || {};
    var had = Object.keys((d && d[s]) || {}).length;
    var me = lower((d && d.me) || '') || meHandle();
    var cap = Pure.buildCapture({
      source: s, mode: mode, me: me, had: had,
      savedAt: (d && d.savedAt) || 0, now: Date.now(), anchor: r[KEY.anchor]
    });
    await set(wrap(KEY.capture, cap));
    transient(cap.mode === 'full'
      ? '已开始全量扫描：从列表顶部重新滚动一遍，已存名单不会删除，重复的人自动去重；每批仍实时写入本机。'
      : '已开始增量续扫：回到上次扫描的位置继续补，已存名单不会删除；每批仍实时写入本机。');
    render();
  }

  async function stopScan() {
    var r = await get([KEY.capture]);
    var c = Object.assign({}, r[KEY.capture] || {}, { status: 'stopped', finishedAt: Date.now() });
    await set(wrap(KEY.capture, c));
    transient('已停止扫描。已经抓到的人已实时保存在本机，不会丢失。');
    render();
  }

  function cellHandle(cell) {
    var links = cell.querySelectorAll('a[href^="/"]');
    for (var i = 0; i < links.length; i++) {
      var h = Pure.handleFromHref(links[i].getAttribute('href'));
      if (h) return { handle: h, anchor: links[i] };
    }
    return null;
  }

  function clearMarks() {
    try {
      var rows = document.querySelectorAll('.tpf-row-notback');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].classList && rows[i].classList.remove) rows[i].classList.remove('tpf-row-notback');
      }
      var badges = document.querySelectorAll('.tpf-badge');
      for (var j = 0; j < badges.length; j++) {
        if (badges[j].parentNode) badges[j].parentNode.removeChild(badges[j]);
      }
    } catch (e) {}
  }

  function addBadge(cell, anchor) {
    if (cell.querySelector && cell.querySelector('.tpf-badge')) return;
    try {
      var b = document.createElement('span');
      b.className = 'tpf-badge';
      b.setAttribute('data-tpf', 'notback');
      b.textContent = '未回关';
      var host = anchor && anchor.parentNode ? anchor.parentNode : cell;
      host.appendChild(b);
      cell.classList.add('tpf-row-notback');
    } catch (e) {}
  }

  async function markRows() {
    if (!ui.markEnabled || !source()) return;
    var r = await get([KEY.data]);
    var d = r[KEY.data] || {};
    var f = d.following || {}, fr = d.followers || {};
    if (!Pure.shouldMark(f, fr)) { clearMarks(); return; }
    var nb = Pure.notBackHandles(f, fr);
    var cells = document.querySelectorAll('[data-testid="UserCell"]');
    for (var i = 0; i < cells.length; i++) {
      var hit = cellHandle(cells[i]);
      if (!hit) continue;
      var badge = cells[i].querySelector ? cells[i].querySelector('.tpf-badge') : null;
      if (nb[hit.handle]) {
        if (!badge) addBadge(cells[i], hit.anchor);
      } else {
        if (cells[i].classList) cells[i].classList.remove('tpf-row-notback');
        if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
      }
    }
  }

  async function pickVisible() {
    var s = source();
    if (s !== 'following') {
      transient('请停留在「关注中」页面，才能从当前位置挑未回关的账号。', true);
      return;
    }
    var r = await get([KEY.data]);
    var d = r[KEY.data] || {};
    var f = d.following || {}, fr = d.followers || {};
    if (!Pure.shouldMark(f, fr)) {
      transient('还没有「粉丝」名单，无法判断谁没回关。请先采集一次粉丝名单。', true);
      return;
    }
    var nb = Pure.notBackHandles(f, fr);
    var cells = document.querySelectorAll('[data-testid="UserCell"]');
    var handles = [], seen = Object.create(null);
    for (var i = 0; i < cells.length; i++) {
      var hit = cellHandle(cells[i]);
      if (!hit || seen[hit.handle] || !nb[hit.handle]) continue;
      seen[hit.handle] = true;
      handles.push(hit.handle);
    }
    if (!handles.length) {
      transient('当前可见列表里没有已确认未回关的账号。可以先扫描，或向下滚动后再试。', true);
      return;
    }
    await set(wrap(KEY.draft, Pure.buildDraft(handles, s, Date.now())));
    if (openPanel()) {
      transient('已把当前可见的 ' + handles.length +
        ' 位未回关账号带入分析面板；仍需在面板里点「预演」并确认后才会取关，这里不会自动取关。');
    } else {
      transient('已选好 ' + handles.length +
        ' 位未回关账号。请点浮层里的「打开分析面板」，名单会自动带入；仍须预演并确认。', true);
    }
  }

  function checkRoute() {
    var p = String(location.pathname || '');
    if (p === lastPath) return;
    lastPath = p;
    if (!source()) { destroy(); return; }
    build();
    render();
    if (ui.markEnabled) markRows();
  }

  get([KEY.ui]).then(function (r) {
    var saved = r[KEY.ui] || {};
    ui.markEnabled = !!saved.markEnabled;
    ui.collapsed = !!saved.collapsed;
    checkRoute();
    try { setInterval(checkRoute, ROUTE_MS); } catch (e) {}
    try {
      setInterval(function () { if (ui.markEnabled) markRows(); }, MARK_MS);
    } catch (e) {}
  });

  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes[KEY.data] || changes[KEY.capture] || changes[KEY.anchor]) {
        render();
        if (ui.markEnabled && changes[KEY.data]) markRows();
      }
      if (changes[KEY.ui]) {
        var v = changes[KEY.ui].newValue || {};
        ui.markEnabled = !!v.markEnabled;
        ui.collapsed = !!v.collapsed;
        if (root) root.className = 'tpf-overlay' + (ui.collapsed ? ' tpf-collapsed' : '');
        if (ui.markEnabled) markRows(); else clearMarks();
      }
    });
  }
})();
