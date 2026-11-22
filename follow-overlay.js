/*
 * TapePost · X 页面内「互F管理 / 扫描」浮层（ISOLATED world，1.5.25）
 * ---------------------------------------------------------------
 * 把 Followback Marker 好用的页面内交互吸收到 TapePost 自己的架构里：
 *   - X F注中 / 粉丝页右侧一个全中文浮层：全量扫描、增量续扫、停止、进度；
 *   - 1.5.25：打开F注页即按 X 自己渲染的「Follows you / 关注了你」判定，
 *     红底 + 头像发光圈 + 用户名高亮 + ✕未回F徽标，不需要先扫描；
 *   - 标红默认开启，X 虚拟 DOM 重绘（鼠标移上 / 移开）后由 MutationObserver
 *     即时补齐，标记不再被冲掉；可随时手动关闭，关闭即刻清除标记；
 *   - 「从当前位置选未回F」把可见账号带入独立分析面板（仍须预演 + 确认）。
 *
 * 复用既有链路，不重复造轮子：
 *   - 浮层只写 followCapture，follow-bridge.js 的 storage.onChanged 会自动
 *     开启 MAIN world 的被动采集并自动滚动，1.5.20 的实时落盘原样生效；
 *   - 名单、白名单、取F任务全部沿用原来的 chrome.storage.local 结构。
 *
 * 安全不变量（任何改动都不能破）：
 *   - 不 fetch、不发 XHR、不重放请求、不调用 X 任何写接口；
 *   - 不读取 cookie / ct0 / Authorization / 请求头 / 登录态；
 *   - 不写 followTask、不构造 confirmed 任务；取F必须由用户在面板里
 *     走「预演 → 我确认 → 执行」，浮层只提供待选名单；
 *   - 没有任何可靠依据时绝不标红：1.5.25 起依据为 X 自己渲染的
 *     「Follows you / 关注了你」或本机已存粉丝名单，两者都没有就不标；
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

    /* 互F标识：X 自己在行内渲染 "Follows you" / "关注了你" 的叶子节点。
     * 只认完整文案（或 aria-label / title），避免用户简介里偶然出现同样文字
     * 被误判成互F。页面元素判定优先于本机名单，名单只做补充。 */
    MUTUAL_RE: /^(?:follows you|follows? you|关注了你|关注你|已关注你)$/i,
    mutualLabel: function (text) {
      var t = String(text == null ? '' : text).replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, '');
      return Pure.MUTUAL_RE.test(t);
    },

    /* 1.5.25：打开页面即可判定，不必先扫描。
     * rows: [{ handle, followsYou }]；只有「本机有粉丝名单」或「当前页至少
     * 出现一个 Follows you 标识」时才有把握，否则一条都不标，防止整页误标。
     * 页面明确标了 Follows you 的一律不标；否则本机粉丝名单里有也不标。 */
    rowSignals: function (rows, following, followers) {
      var fr = followers || {};
      var hasList = !!(Object.keys(fr).length);
      var list = rows || [];
      var pageHasMutual = false;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].followsYou) { pageHasMutual = true; break; }
      }
      var out = { confident: hasList || pageHasMutual, notBack: Object.create(null) };
      if (!out.confident) return out;
      for (var j = 0; j < list.length; j++) {
        var r = list[j];
        if (!r || !r.handle) continue;
        if (!r.followsYou && !fr[r.handle]) out.notBack[r.handle] = true;
      }
      return out;
    },

    shouldMark: function (following, followers, rows) {
      if (followers && Object.keys(followers).length) return true;
      var list = rows || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].followsYou) return true;
      }
      return false;
    },

    notBackHandles: function (following, followers, rows) {
      var out = Object.create(null);
      if (!Pure.shouldMark(following, followers, rows) || !Core) return out;
      if (rows && rows.length) {
        var v = Pure.rowSignals(rows, following, followers);
        Object.keys(v.notBack).forEach(function (k) { out[k] = true; });
        return out;
      }
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

    /* 1.5.22：把桥接层的判定原因翻成中文，让用户知道是「X 还在加载」
     * 还是「真的到底了」，不再出现扫一半却显示已完成的误导。 */
    scanReasonText: function (reason) {
      return {
        warming: '正在等待 X 加载第一批分页',
        loading: 'X 正在加载下一页，继续等待',
        active: 'X 仍在返回数据，继续扫描',
        idleRounds: '等待确认列表已到底',
        notBottom: '继续向下滚动找更多账号',
        bottomUnstable: '正在确认列表是否已到底'
      }[reason] || '正在扫描';
    },
    statusText: function (cap, counts) {
      var c = cap || {}, f = (counts && counts.following) || 0, r = (counts && counts.followers) || 0;
      var base = '本机已存 <b>' + (f + r) + '</b> 人（F注中 ' + f + ' / 粉丝 ' + r + '）';
      if (c.status === 'running') {
        return base + ' · 已滚动 ' + (c.scrolls || 0) + ' 次 · ' +
          Pure.scanReasonText(c.scan && c.scan.reason);
      }
      if (c.status === 'done') return base + ' · 列表已到底，本轮扫描完成';
      if (c.status === 'stopped') return base + ' · 已停止，名单仍在本机';
      if (c.status === 'interrupted') return base + ' · 本轮中断，名单已保留，可点「增量续扫」继续';
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
  var MARK_MS = 900;
  // 1.5.25：默认开启。用户没手动F过就一律开；F过仍尊重用户选择。
  var ui = { markEnabled: true, collapsed: false };
  var root = null;
  var lastPath = '';
  var hintTimer = 0;
  var markQueued = false;
  var lastHoverMark = 0;
  var domWatcher = null;

  function swallow() {} // 1.5.23：定时器 / 事件回调里的 Promise 一律不留未处理 rejection
  var $ = function (id) { return document.getElementById(id); };
  function get(keys) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get(keys, function (r) {
        void (chrome.runtime && chrome.runtime.lastError); // 1.5.23
        resolve(r || {});
      }); }
      catch (e) { resolve({}); }
    });
  }
  function set(obj) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.set(obj, function () {
        // 名单很大时可能触及配额；同步读取 lastError，失败如实返回 false
        var err = chrome.runtime && chrome.runtime.lastError;
        resolve(!err);
      }); }
      catch (e) { resolve(false); }
    });
  }
  function wrap(key, val) { var o = {}; o[key] = val; return o; }
  function lower(v) { return Core.lowerHandle(v); }

  /* 名单内存缓存：即时高亮每 0.9 秒 + 每次 DOM 变化都要用名单，旧版每次都
   * chrome.storage.local.get 整份 followData（上万人时好几 MB），滚动时页面发卡。
   * 现在只在首次和 storage.onChanged 时更新。 */
  var dataCache = null;
  function getData() {
    if (dataCache) return Promise.resolve(dataCache);
    return get([KEY.data]).then(function (r) {
      dataCache = r[KEY.data] || {};
      return dataCache;
    });
  }

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
    var base = '打开F注页即按 X 行内的「Follows you / 关注了你」判断：没回F的自动红底 + 头像发光圈 + 用户名高亮 + ✕未回F，无需先扫描。';
    if (!r && !f) {
      hint(base + '本机还没有名单，会先看页面里的互F标识；扫描只用于把名单存到本机，不影响即时高亮。', true);
      return;
    }
    var tail = anchor && anchor.savedAt
      ? '上次扫描停在 ' + (anchor.count || 0) + ' 人，可点「增量续扫」接着补。'
      : '鼠标移上 / 移开导致 X 重绘时，标记会自动补齐。';
    hint(base + ' 本机已存F注 ' + f + ' / 粉丝 ' + r + '。' + tail);
  }

  var HTML =
    '<div class="tpf-head">' +
      '<span class="tpf-logo">T</span>' +
      '<span class="tpf-title"><b>TapePost · 互F管理</b><small>在 X 页面内扫描（本机计算）</small></span>' +
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
        '<input type="checkbox" id="tpfMark" /> 即时高亮未回F（默认开）' +
      '</label>' +
      '<div class="tpf-links">' +
        '<a class="tpf-link" id="tpfPanelLink" href="#" rel="noopener">📊 打开分析面板</a>' +
        '<button type="button" class="tpf-pick tpf-pick-cta" id="tpfPick">🎯 从当前位置选未回F</button>' +
      '</div>' +
      '<div class="tpf-hint" id="tpfHint">打开F注页即按页面元素判断未回F，无需扫描。</div>' +
    '</div>';

  function bindOverlay() {
    var on = function (id, fn) { var el = $(id); if (el && el.addEventListener) el.addEventListener('click', fn); };
    on('tpfFold', function () {
      ui.collapsed = !ui.collapsed;
      if (root) root.className = 'tpf-overlay' + (ui.collapsed ? ' tpf-collapsed' : '');
      var f = $('tpfFold'); if (f) f.textContent = ui.collapsed ? '+' : '−';
      set(wrap(KEY.ui, ui)).catch(swallow);
    });
    on('tpfFull', function () { startScan('full').catch(swallow); });
    on('tpfResume', function () { startScan('incremental').catch(swallow); });
    on('tpfStop', function () { stopScan().catch(swallow); });
    on('tpfPick', function () { pickVisible().catch(swallow); });
    on('tpfPanelLink', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (!openPanel()) transient('打开分析面板失败：请点插件弹窗顶部的「👥 互F管理」入口。', true);
    });
    var mk = $('tpfMark');
    if (mk && mk.addEventListener) {
      mk.addEventListener('change', function (e) {
        ui.markEnabled = !!(e && e.target && e.target.checked);
        set(wrap(KEY.ui, ui)).catch(swallow);
        if (ui.markEnabled) markRows().catch(swallow); else clearMarks();
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
    // 一次 get 拿齐（缓存为空时顺带读名单），不额外多等一轮
    var r = await get(dataCache ? [KEY.capture, KEY.anchor] : [KEY.data, KEY.capture, KEY.anchor]);
    if (!dataCache) dataCache = r[KEY.data] || {};
    var d = dataCache;
    var f = d.following && typeof d.following === 'object' ? d.following : {};
    var fr = d.followers && typeof d.followers === 'object' ? d.followers : {};
    var counts = { following: Object.keys(f).length, followers: Object.keys(fr).length };
    var cap = r[KEY.capture] || {};
    var stat = $('tpfStat');
    if (stat) stat.innerHTML = Pure.statusText(cap, counts);
    var bar = $('tpfBar');
    if (bar && bar.style) {
      // 中断 / 停止绝不显示 100%，避免把半截名单说成扫完了
      var w = cap.status === 'done' ? 100
        : (cap.status === 'running' || cap.status === 'interrupted'
          ? Math.min(92, 8 + (cap.scrolls || 0) * 2) : 0);
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
    hintTimer = setTimeout(function () { hintTimer = 0; render().catch(swallow); }, 6000);
  }

  async function startScan(mode) {
    var s = source();
    if (!s) { transient('请停留在自己的「F注中」或「粉丝」页面再扫描。', true); return; }
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
    render().catch(swallow);
  }

  async function stopScan() {
    var r = await get([KEY.capture]);
    var c = Object.assign({}, r[KEY.capture] || {}, { status: 'stopped', finishedAt: Date.now() });
    await set(wrap(KEY.capture, c));
    transient('已停止扫描。已经抓到的人已实时保存在本机，不会丢失。');
    render().catch(swallow);
  }

  /* 1.5.24：X 改版后用户行不再是 [data-testid="UserCell"]，整行变成
   * <button role="button"> 里套 a[href="/handle"] 与 aria-label="Following @handle"
   * 的F注按钮。这里兼容新旧两种 DOM：先试老 testid，取不到再用F注按钮反推
   * 最近的、含 handle 链接的祖先作为「行容器」。只读 DOM，不改 X 结构。 */
  function findUserCells() {
    var old = document.querySelectorAll('[data-testid="UserCell"]');
    if (old && old.length) return old;
    var out = [], seen = [];
    var btnSels = [
      'button[aria-label^="Following @"]',
      'button[aria-label^="Follow @"]',
      'button[aria-label^="Unfollow @"]',
      '[role="button"][aria-label^="Following @"]',
      '[role="button"][aria-label^="Follow @"]',
      '[role="button"][aria-label^="Unfollow @"]',
      // 中文界面 / X 改版可能换掉的 aria-label 文案
      'button[aria-label*="关注 @"]',
      '[role="button"][aria-label*="关注 @"]'
    ];
    var btns = [];
    for (var s = 0; s < btnSels.length; s++) {
      var found = document.querySelectorAll(btnSels[s]);
      for (var k = 0; k < found.length; k++) {
        if (seen.indexOf(found[k]) === -1) { seen.push(found[k]); btns.push(found[k]); }
      }
    }
    var rows = [], rowSeen = [];
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      var label = (btn.getAttribute && (btn.getAttribute('aria-label') || btn.getAttribute('title'))) || '';
      var m = /@([A-Za-z0-9_]{1,20})/i.exec(label);
      if (!m) {
        var txt = String(btn.textContent || '');
        if (/^(?:following|unfollow|follow|正在关注|已关注|取消关注|关注)\s*@?([A-Za-z0-9_]{1,20})$/i.test(txt)) {
          m = /@?([A-Za-z0-9_]{1,20})$/i.exec(txt);
        }
      }
      if (!m) continue;
      var want = Pure.handleFromHref('/' + m[1]);
      if (!want) continue;
      var node = btn, row = null;
      // 向上找第一个「handle 与按钮一致且只包含这一位用户」的容器，
      // 避免把整个列表 / 主栏当成一行（那样会把整页标红）。
      for (var up = 0; node && up < 8; up = up + 1) {
        var hs = handlesIn(node);
        var btnsIn = node.querySelectorAll ? node.querySelectorAll('button,[role="button"]').length : 0;
        if (hs.indexOf(want) !== -1 && hs.length <= 4 && btnsIn <= 6) { row = node; break; }
        node = node.parentElement;
      }
      if (row && rowSeen.indexOf(row) === -1) { rowSeen.push(row); rows.push(row); }
    }
    return rows;
  }

  function handlesIn(node) {
    var out = [], seen = Object.create(null);
    try {
      if (!node || !node.querySelectorAll) return out;
      var links = node.querySelectorAll('a[href^="/"]');
      for (var i = 0; i < links.length; i++) {
        var h = Pure.handleFromHref(links[i].getAttribute('href'));
        if (h && !seen[h]) { seen[h] = true; out.push(h); }
      }
    } catch (e) {}
    return out;
  }

  function cellHandle(cell) {
    if (!cell || !cell.querySelectorAll) return null;
    var links = cell.querySelectorAll('a[href^="/"]');
    for (var i = 0; i < links.length; i++) {
      var h = Pure.handleFromHref(links[i].getAttribute('href'));
      if (h) return { handle: h, anchor: links[i] };
    }
    return null;
  }

  /* X 在行内把互FF系渲染成一个独立的小节点：英文 "Follows you"、
   * 中文 "关注了你"。只认完整叶子文案 / aria-label / title，不认整行文本，
   * 避免用户简介里出现同样文字导致误判。 */
  function rowFollowsYou(cell) {
    try {
      if (!cell || !cell.querySelectorAll) return false;
      var nodes = cell.querySelectorAll('[aria-label], [title], [data-testid], span, div');
      for (var i = 0; i < nodes.length && i < 160; i++) {
        var n = nodes[i];
        if (n === cell || !n) continue;
        if (n.getAttribute) {
          var tid = n.getAttribute('data-testid') || '';
          if (/follows.?you/i.test(tid)) return true;
          if (Pure.mutualLabel(n.getAttribute('aria-label')) ||
              Pure.mutualLabel(n.getAttribute('title'))) return true;
        }
        if (n.childElementCount === 0 && Pure.mutualLabel(n.textContent)) return true;
      }
    } catch (e) {}
    return false;
  }

  function hasClass(el, name) {
    try {
      if (el && el.classList && el.classList.contains) return el.classList.contains(name);
    } catch (e) {}
    return !!(el && el.classes && el.classes.indexOf(name) !== -1);
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
      var avatars = document.querySelectorAll('.tpf-nb-avatar');
      for (var k = 0; k < avatars.length; k++) {
        if (avatars[k].classList && avatars[k].classList.remove) avatars[k].classList.remove('tpf-nb-avatar');
      }
    } catch (e) {}
  }

  /* 1.5.25：幂等「补标」。旧版只在没有徽标时才调用 addBadge，X 重绘把
   * class 冲掉但徽标还在时永远补不回来 —— 这就是鼠标移开后高亮全没的根因。
   * 现在每次都逐项校验 class / 头像 / 徽标，缺什么补什么，已对的不写 DOM。 */
  function addBadge(cell, anchor, on) {
    if (!cell) return;
    try {
      if (on !== false) {
        if (!hasClass(cell, 'tpf-row-notback') && cell.classList) cell.classList.add('tpf-row-notback');
        try {
          if (cell.querySelector) {
            var avatar = cell.querySelector('img');
            if (avatar && avatar.classList && !hasClass(avatar, 'tpf-nb-avatar')) {
              avatar.classList.add('tpf-nb-avatar');
            }
          }
        } catch (e) {}
        var badge = cell.querySelector ? cell.querySelector('.tpf-badge') : null;
        if (!badge || !badge.parentNode) {
          var b = document.createElement('span');
          b.className = 'tpf-badge';
          b.setAttribute('data-tpf', 'notback');
          b.textContent = '未回F';
          var host = anchor && anchor.parentNode ? anchor.parentNode : cell;
          host.appendChild(b);
        }
      } else {
        if (hasClass(cell, 'tpf-row-notback') && cell.classList) cell.classList.remove('tpf-row-notback');
        if (cell.querySelectorAll) {
          var bs = cell.querySelectorAll('.tpf-badge');
          for (var j = 0; j < bs.length; j++) {
            if (bs[j].parentNode) bs[j].parentNode.removeChild(bs[j]);
          }
          var imgs = cell.querySelectorAll('.tpf-nb-avatar');
          for (var k = 0; k < imgs.length; k++) {
            if (imgs[k].classList && hasClass(imgs[k], 'tpf-nb-avatar')) imgs[k].classList.remove('tpf-nb-avatar');
          }
        }
      }
    } catch (e) {}
  }

  /* X 的虚拟列表在 hover / 滚动时会重建行节点，标记随之消失。
   * 用 MutationObserver + 鼠标事件即时补标（rAF 合并，避免抖动）。 */
  function scheduleMark() {
    if (markQueued) return;
    markQueued = true;
    var fire = function () {
      markQueued = false;
      if (ui.markEnabled && source() === 'following') markRows().catch(swallow);
    };
    try {
      if (window.requestAnimationFrame) window.requestAnimationFrame(fire);
      else setTimeout(fire, 40);
    } catch (e) { markQueued = false; }
  }

  function watchDom() {
    if (domWatcher || typeof window.MutationObserver === 'undefined' || !document.body) return;
    try {
      domWatcher = new window.MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var t = muts[i] && muts[i].target;
          if (!t || t.id === 'tpfOverlay' || hasClass(t, 'tpf-badge') ||
              hasClass(t, 'tpf-row-notback') || hasClass(t, 'tpf-nb-avatar')) continue;
          scheduleMark();
          break;
        }
      });
      domWatcher.observe(document.body, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ['class', 'aria-label', 'data-testid']
      });
    } catch (e) {}
  }

  function onHover() {
    if (!ui.markEnabled || source() !== 'following') return;
    var now = Date.now();
    if (now - lastHoverMark < 150) return;
    lastHoverMark = now;
    scheduleMark();
  }

  function watchHover() {
    try {
      document.addEventListener('mouseover', onHover, true);
      document.addEventListener('mouseout', onHover, true);
    } catch (e) {}
  }

  async function markRows() {
    if (!ui.markEnabled || !source()) return;
    // 「未回F」只对「F注中」列表有意义；粉丝页上全员都关注了你，不标
    if (source() !== 'following') { clearMarks(); return; }
    var d = await getData();
    var f = d.following || {}, fr = d.followers || {};
    var cells = findUserCells();
    var rows = [];
    for (var i = 0; i < cells.length; i++) {
      var hit = cellHandle(cells[i]);
      if (!hit) continue;
      rows.push({ handle: hit.handle, anchor: hit.anchor,
        cell: cells[i], followsYou: rowFollowsYou(cells[i]) });
    }
    if (!Pure.shouldMark(f, fr, rows)) {
      for (var j = 0; j < rows.length; j++) addBadge(rows[j].cell, rows[j].anchor, false);
      return;
    }
    var verdict = Pure.rowSignals(rows, f, fr);
    for (var k = 0; k < rows.length; k++) {
      addBadge(rows[k].cell, rows[k].anchor,
        verdict.confident && !!verdict.notBack[rows[k].handle]);
    }
  }

  async function pickVisible() {
    var s = source();
    if (s !== 'following') {
      transient('请停留在「F注中」页面，才能从当前位置挑未回F的账号。', true);
      return;
    }
    var d = await getData();
    var f = d.following || {}, fr = d.followers || {};
    var cells = findUserCells();
    var rows = [];
    for (var i = 0; i < cells.length; i++) {
      var hit = cellHandle(cells[i]);
      if (hit) rows.push({ handle: hit.handle, followsYou: rowFollowsYou(cells[i]) });
    }
    if (!Pure.shouldMark(f, fr, rows)) {
      transient('当前页面没有可判断的互F标识，本机也没有粉丝名单，无法挑出未回F账号。', true);
      return;
    }
    var verdict = Pure.rowSignals(rows, f, fr);
    if (!verdict.confident) {
      transient('当前页面没有可判断的互F标识，本机也没有粉丝名单，无法挑出未回F账号。', true);
      return;
    }
    var handles = [], seen = Object.create(null);
    for (var j = 0; j < rows.length; j++) {
      var h = rows[j].handle;
      if (!h || seen[h] || !verdict.notBack[h]) continue;
      seen[h] = true;
      handles.push(h);
    }
    if (!handles.length) {
      transient('当前可见列表里没有未回F的账号，可以向下滚动后再试。', true);
      return;
    }
    await set(wrap(KEY.draft, Pure.buildDraft(handles, s, Date.now())));
    if (openPanel()) {
      transient('已把当前可见的 ' + handles.length +
        ' 位未回F账号带入分析面板；仍需在面板里点「预演」并确认后才会取F，这里不会自动取F。');
    } else {
      transient('已选好 ' + handles.length +
        ' 位未回F账号。请点浮层里的「打开分析面板」，名单会自动带入；仍须预演并确认。', true);
    }
  }

  function checkRoute() {
    var p = String(location.pathname || '');
    if (p === lastPath) return;
    lastPath = p;
    if (!source()) { destroy(); return; }
    build();
    render().catch(swallow);
    if (ui.markEnabled) markRows().catch(swallow);
  }

  get([KEY.ui]).then(function (r) {
    var saved = r[KEY.ui] || {};
    // 1.5.25：默认开启即时高亮；只有用户明确F过才F。
    ui.markEnabled = saved.markEnabled !== false;
    ui.collapsed = !!saved.collapsed;
    watchDom();
    watchHover();
    checkRoute();
    try { setInterval(checkRoute, ROUTE_MS); } catch (e) {}
    try {
      setInterval(function () { if (ui.markEnabled) markRows().catch(swallow); }, MARK_MS);
    } catch (e) {}
  }).catch(swallow);

  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes[KEY.data]) dataCache = changes[KEY.data].newValue || {};
      if (changes[KEY.data] || changes[KEY.capture] || changes[KEY.anchor]) {
        render().catch(swallow);
        if (ui.markEnabled && changes[KEY.data]) markRows().catch(swallow);
      }
      if (changes[KEY.ui]) {
        var v = changes[KEY.ui].newValue || {};
        ui.markEnabled = !!v.markEnabled;
        ui.collapsed = !!v.collapsed;
        if (root) root.className = 'tpf-overlay' + (ui.collapsed ? ' tpf-collapsed' : '');
        if (ui.markEnabled) markRows().catch(swallow); else clearMarks();
      }
    });
  }
})();
