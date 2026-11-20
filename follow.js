/*
 * TapePost · X 关注关系分析面板（1.5.22）
 * ---------------------------------------------------------------
 * 只读本机 chrome.storage.local 里的名单，做统计 / 分类 / 明细，并在用户
 * 明确确认后调度 follow-bridge.js 执行限速批量取关。
 * 本文件不接触 X 页面 DOM，不读取登录态，不上传任何数据。
 */
(function () {
  'use strict';
  var Core = window.FollowCore;
  if (!Core) return;

  var K = {
    data: 'followData', capture: 'followCapture', task: 'followTask',
    whitelist: 'followWhitelist', settings: 'followSettings',
    draft: 'followSelectionDraft'
  };
  var PAGE_SIZE = 50;
  var DRAFT_TTL = 10 * 60 * 1000;
  // 内核里的区间 id 保持稳定（用于筛选与兼容历史数据），只在界面显示中文
  var BAND_LABELS = {
    '0-100': '100 人以下', '100-1k': '100～1000 人', '1k-1w': '1000～1 万人',
    '1w-10w': '1 万～10 万人', '10w+': '10 万人以上'
  };
  var state = {
    data: { me: '', following: {}, followers: {}, updatedAt: { following: 0, followers: 0 } },
    capture: {}, task: {}, whitelist: [], settings: Object.assign({}, Core.DEFAULTS),
    group: 'notBack', filter: 'all', search: '', sort: 'followers', band: '',
    page: 1, selected: Object.create(null), pending: null
  };

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var fmt = function (n) { return Number(n || 0).toLocaleString('zh-CN'); };
  var when = function (ts) {
    if (!ts) return '未采集';
    var d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0');
  };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

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
  function emptyData() {
    return { me: '', following: {}, followers: {},
      updatedAt: { following: 0, followers: 0 }, savedAt: 0, version: 1, source: 'passive' };
  }
  function normalizeData(raw) {
    var d = raw && typeof raw === 'object' ? raw : emptyData();
    var u = d.updatedAt && typeof d.updatedAt === 'object' ? d.updatedAt : {};
    return {
      me: Core.lowerHandle(d.me || ''),
      following: d.following && typeof d.following === 'object' ? d.following : {},
      followers: d.followers && typeof d.followers === 'object' ? d.followers : {},
      updatedAt: { following: Number(u.following) || 0, followers: Number(u.followers) || 0 },
      savedAt: Number(d.savedAt) || 0, version: 1, source: 'passive'
    };
  }
  // 任何写 followData 都必须「先读最新再合并」：面板内存里的旧快照不能覆盖
  // 桥接层在面板关闭期间实时落盘的新用户（1.5.20 修复数据丢失的关键）。
  async function writeData(patch) {
    var r = await get([K.data]);
    var d = normalizeData(r[K.data]);
    Object.keys(patch || {}).forEach(function (k) { d[k] = patch[k]; });
    d = normalizeData(d);
    var w = {}; w[K.data] = d;
    await set(w);
    state.data = d;
    return d;
  }

  function tabsQuery(q) {
    return new Promise(function (resolve) {
      try { chrome.tabs.query(q, function (t) { resolve(t || []); }); }
      catch (e) { resolve([]); }
    });
  }
  function tabsCreate(url) {
    return new Promise(function (resolve) {
      try { chrome.tabs.create({ url: url }, function (t) { resolve(t || null); }); }
      catch (e) { resolve(null); }
    });
  }
  function sendToTab(tabId, msg) {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.sendMessage(tabId, msg, function (r) {
          void chrome.runtime.lastError;
          resolve(r || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  function status(id, text, tone) {
    var el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'status' + (tone ? ' ' + tone : '');
  }

  function settingsFromUi() {
    var d = Math.max(3000, Number($('cfgDelay').value) || Core.DEFAULTS.minDelay);
    var j = Math.max(0, Number($('cfgJitter').value) || 0);
    var b = Math.min(50, Math.max(1, Number($('cfgBatch').value) || Core.DEFAULTS.batchLimit));
    return Object.assign({}, Core.DEFAULTS, state.settings, {
      minDelay: d, jitter: j, batchLimit: b,
      skipProtected: $('cfgProtect').value === '1',
      whitelist: state.whitelist
    });
  }

  // ---------------------------------------------------------------- 初始化
  // 面板重新打开时：如果上次采集的状态还停在 running，但 X 标签页已经不在
  // （桥接层超过 30 秒没打过 tick），就标成「已中断」而不是永远显示正在采集。
  // 名单本身完整保留，用户点「继续采集」即可从已保存的部分往下补。
  var CAP_STALE_MS = 30000;
  async function recoverStaleCapture() {
    var c = Object.assign({}, state.capture || {});
    if (c.status !== 'running') return;
    var last = c.lastTickAt || c.startedAt || 0;
    if (last && Date.now() - last < CAP_STALE_MS) return;
    var kept = Object.keys(state.data[c.target] || {}).length;
    c.status = 'interrupted';
    c.finishedAt = Date.now();
    c.message = '上次采集中断，本机已保留 ' + kept + ' 人。点「继续采集」从已保存的名单往下补，' +
      '已抓到的人不会重复；关闭面板不会丢失数据。';
    var w = {}; w[K.capture] = c;
    await set(w);
    state.capture = c;
  }

  /* 1.5.21：接收 X 页面内中文扫描浮层「从当前位置选未回关」带入的账号。
   * 安全边界：这里只把它们放进 state.selected（等同用户手动勾选），
   * 绝不写 followTask、绝不设置 confirmed；用户仍须点「预演」再「我确认」，
   * 由 follow-bridge.js 执行。草稿一次性消费，过期 / 受保护的账号不勾选。 */
  async function adoptDraft() {
    var r = await get([K.draft]);
    var d = r[K.draft];
    if (!d || !Array.isArray(d.handles) || !d.handles.length) return;
    var w = {}; w[K.draft] = null;
    await set(w);
    if (!d.at || Date.now() - Number(d.at) > DRAFT_TTL) return;
    var opts = Object.assign({}, Core.DEFAULTS, state.settings, { whitelist: state.whitelist });
    var n = 0;
    d.handles.forEach(function (h) {
      var k = Core.lowerHandle(h);
      var u = state.data.following[k];
      if (!u || !Core.validHandle(k)) return;
      if (Core.protectedReasons(u, opts).length) return;
      state.selected[k] = true;
      n++;
    });
    var el = $('draftHint');
    if (!el) return;
    el.textContent = n
      ? '已从 X 页面内扫描浮层带入 ' + n + ' 位待选账号（当前可见的未回关）。' +
        '这里只是帮你勾选，仍需点「预演」并确认后才会执行取关。'
      : '页面浮层带入的账号已过期或属于受保护名单，未自动勾选；请在下方手动选择。';
    el.className = 'hint ' + (n ? 'draft-ok' : 'draft-warn');
  }

  async function refresh() {
    var r = await get([K.data, K.capture, K.task, K.whitelist, K.settings]);
    state.data = normalizeData(r[K.data]);
    state.capture = r[K.capture] || {};
    state.task = r[K.task] || {};
    state.whitelist = r[K.whitelist] || [];
    state.settings = Object.assign({}, Core.DEFAULTS, r[K.settings] || {});
    if (!$('meHandle').value) $('meHandle').value = state.data.me || '';
    await recoverStaleCapture();
    await adoptDraft();
    renderAll();
  }

  function renderAll() {
    renderCapture();
    renderCards();
    renderChips();
    renderList();
    renderWhitelist();
    renderTask();
  }

  function renderCapture() {
    var d = normalizeData(state.data);
    state.data = d;
    var nf = Object.keys(d.following).length, nr = Object.keys(d.followers).length;
    $('cntFollowing').textContent = fmt(nf);
    $('cntFollowers').textContent = fmt(nr);
    $('whenFollowing').textContent = when(d.updatedAt.following);
    $('whenFollowers').textContent = when(d.updatedAt.followers);
    var lastWrite = d.savedAt || Math.max(d.updatedAt.following, d.updatedAt.followers);
    $('saveHint').textContent = '实时保存：本机已存 ' + fmt(nf + nr) + ' 人（关注中 ' + fmt(nf) +
      ' / 粉丝 ' + fmt(nr) + '）· 最后写入 ' + when(lastWrite) +
      ' · 每批数据立即写盘，关闭面板或中途停止都不会丢，下次打开自动恢复';
    var c = state.capture || {};
    if (c.storageError) {
      $('saveHint').textContent += ' ｜ ⚠ 本机写入异常：' + c.storageError + '（请检查浏览器存储空间后重试）';
    }
    if (c.status === 'running') {
      var why = {
        warming: '正在等待 X 加载第一批分页',
        loading: 'X 正在加载下一页',
        active: 'X 仍在返回数据',
        idleRounds: '正在确认列表是否已到底',
        notBottom: '正在继续向下滚动',
        bottomUnstable: '正在确认列表是否已到底'
      }[(c.scan && c.scan.reason) || ''] || '正在等待 X 分页加载';
      status('capStatus', '正在采集「' + (c.target === 'followers' ? '粉丝' : '关注中') +
        '」… 已滚动 ' + (c.scrolls || 0) + ' 次，当前 ' + (c.count || 0) +
        ' 人，' + why + '。每批已实时保存；X 分页慢或全是已存账号都不会提前结束，' +
        '只有列表真正到底才会完成。请保持该标签页可见。', 'warn');
    } else if (c.status === 'done') {
      var zero = (c.count || 0) === 0;
      status('capStatus', (c.message || '采集完成') +
        (zero ? '；采到 0 人，请确认已登录 x.com、用户名填写正确，或刷新该标签后重试。' : ''),
        zero ? 'warn' : 'ok');
    } else if (c.status === 'stopped') {
      status('capStatus', '采集已停止，已抓到的名单仍保存在本机。可点「继续采集」接着补。', 'warn');
    } else if (c.status === 'interrupted') {
      status('capStatus', (c.message || '上次采集中断，已保存的名单仍在本机。') +
        ' 点上面的「开始采集」即可从已存名单往下补，已抓到的人不会重复。', 'warn');
    } else {
      status('capStatus', '尚未采集。请先确认已登录 x.com，再点上面两个按钮；采集期间请保持标签页在前台或可见。');
    }
  }

  function sets() { return Core.relationSets(state.data.following, state.data.followers); }

  function renderCards() {
    var s = sets();
    var vals = {
      notBack: s.notBack.length, toFollowBack: s.toFollowBack.length,
      mutual: s.mutual.length, following: s.followingCount, followers: s.followerCount
    };
    var descs = {
      notBack: '我关注了、对方没关注我', toFollowBack: '对方关注了我、我没回关',
      mutual: '双向关注', following: '我关注的所有人', followers: '关注我的所有人'
    };
    $('cards').innerHTML = Core.GROUPS.map(function (g) {
      return '<button type="button" class="card ' + g.tone + (state.group === g.id ? ' active' : '') +
        '" data-group="' + g.id + '" title="' + esc(g.hint) + '">' +
        '<div class="k">' + esc(g.label) + '</div>' +
        '<div class="v">' + fmt(vals[g.id]) + '</div>' +
        '<div class="d">' + esc(descs[g.id]) + '</div></button>';
    }).join('');
    Array.prototype.forEach.call($('cards').querySelectorAll('[data-group]'), function (b) {
      b.addEventListener('click', function () {
        state.group = b.getAttribute('data-group');
        state.page = 1;
        renderCards(); renderList();
      });
    });
    $('rateLine').textContent = '互关率 ' + s.mutualRate + '%（互关 / 我关注的人）· ' +
      '回关率 ' + s.backRate + '%（互关 / 我的粉丝）· 数据截至 ' +
      (when(Math.max(state.data.updatedAt.following, state.data.updatedAt.followers)));
  }

  function renderChips() {
    var s = sets();
    $('listTitle').textContent = (Core.GROUPS.filter(function (g) { return g.id === state.group; })[0] || {}).label || '明细';
    $('chips').innerHTML = Core.FILTERS.map(function (f) {
      return '<button type="button" class="chip' + (state.filter === f.id ? ' active' : '') +
        '" data-filter="' + f.id + '">' + esc(f.label) + '</button>';
    }).join('');
    Array.prototype.forEach.call($('chips').querySelectorAll('[data-filter]'), function (b) {
      b.addEventListener('click', function () {
        state.filter = b.getAttribute('data-filter');
        state.page = 1;
        renderChips(); renderList();
      });
    });
    void s;
  }

  function groupUsers() {
    var s = sets(), d = state.data;
    if (state.group === 'notBack') return s.notBack;
    if (state.group === 'toFollowBack') return s.toFollowBack;
    if (state.group === 'mutual') return s.mutual;
    if (state.group === 'followers') return Core.mapToList(d.followers);
    return Core.mapToList(d.following);
  }

  function decorate(users) {
    var o = settingsFromUi();
    o.now = Date.now();
    return users.map(function (u) {
      var tags = Core.classify(u, o);
      var reasons = Core.protectedReasons(u, o);
      return Object.assign({}, u, { tags: tags, reasons: reasons, band: Core.followerBand(u.followers) });
    });
  }

  function filtered() {
    var q = state.search.trim().toLowerCase();
    var list = decorate(groupUsers());
    list = list.filter(function (u) {
      if (state.filter === 'protected') { if (!u.reasons.length) return false; }
      else if (state.filter !== 'all' && u.tags.indexOf(state.filter) === -1) return false;
      if (state.band && u.band !== state.band) return false;
      if (q && (u.name + ' ' + u.handle + ' ' + (u.bio || '')).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    var by = state.sort;
    list.sort(function (a, b) {
      if (by === 'followers') return b.followers - a.followers;
      if (by === 'followersAsc') return a.followers - b.followers;
      if (by === 'tweets') return b.tweets - a.tweets;
      if (by === 'inactive') return Core.parseDate(b.lastTweetAt || b.createdAt) - Core.parseDate(a.lastTweetAt || a.createdAt);
      return String(a.handle).localeCompare(String(b.handle));
    });
    return list;
  }

  function tagHtml(u) {
    var out = u.tags.map(function (t) {
      return '<span class="tag ' + t + '">' + esc(Core.tagLabel(t)) + '</span>';
    });
    if (u.reasons.length) out.push('<span class="tag protected">🛡 ' + esc(u.reasons.join(' / ')) + '</span>');
    if (!out.length) out.push('<span class="tag">普通</span>');
    return out.join('');
  }

  function renderList() {
    var list = filtered();
    var pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (state.page > pages) state.page = pages;
    var start = (state.page - 1) * PAGE_SIZE;
    var page = list.slice(start, start + PAGE_SIZE);
    $('listCount').textContent = fmt(list.length) + ' 人';
    $('selectedCount').textContent = '已选 ' + Object.keys(state.selected).length + ' 人';
    $('pageInfo').textContent = '第 ' + state.page + ' / ' + pages + ' 页 · 每页 ' + PAGE_SIZE + ' 条';
    $('prevPage').disabled = state.page <= 1;
    $('nextPage').disabled = state.page >= pages;
    if (!list.length) {
      $('list').innerHTML = '<div class="empty-list">' +
        (Object.keys(state.data.following).length || Object.keys(state.data.followers).length
          ? '当前筛选条件下没有账号。' : '还没有数据，先完成上面的两步采集。') + '</div>';
      $('headCheck').checked = false;
      return;
    }
    $('list').innerHTML = page.map(function (u) {
      var safeAvatar = /^https:\/\//i.test(u.avatar || '') ? esc(u.avatar) : '';
      var checked = !!state.selected[u.handle];
      var wl = state.whitelist.indexOf(u.handle) !== -1;
      return '<div class="item">' +
        '<input type="checkbox" data-pick="' + esc(u.handle) + '"' + (checked ? ' checked' : '') +
        (u.reasons.length ? ' disabled title="受保护账号不能勾选"' : '') + ' aria-label="选择 ' + esc(u.handle) + '" />' +
        (safeAvatar ? '<img class="av" src="' + safeAvatar + '" alt="" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'" />'
          : '<div class="av"></div>') +
        '<div class="main"><div class="line1">' +
        '<span class="nm">' + esc(u.name || u.handle) + '</span>' +
        '<a class="hd" href="https://x.com/' + esc(u.handle) + '" target="_blank" rel="noopener noreferrer">@' + esc(u.handle) + '</a>' +
        tagHtml(u) + '</div>' +
        '<div class="meta">粉丝 ' + fmt(u.followers) + ' · 关注 ' + fmt(u.friends) +
        ' · 推文 ' + fmt(u.tweets) + ' · 粉丝量 ' + esc(BAND_LABELS[u.band] || '未分类') +
        (u.lastTweetAt ? ' · 最后发推 ' + esc(String(u.lastTweetAt).slice(0, 16)) : '') + '</div>' +
        (u.bio ? '<div class="bio" title="' + esc(u.bio) + '">' + esc(u.bio) + '</div>' : '') +
        '</div><div class="ops">' +
        '<button type="button" class="mini ghost" data-wl="' + esc(u.handle) + '">' +
        (wl ? '移出白名单' : '🛡 加入白名单') + '</button>' +
        '</div></div>';
    }).join('');
    Array.prototype.forEach.call($('list').querySelectorAll('[data-pick]'), function (cb) {
      cb.addEventListener('change', function () {
        var h = cb.getAttribute('data-pick');
        if (cb.checked) state.selected[h] = true; else delete state.selected[h];
        $('selectedCount').textContent = '已选 ' + Object.keys(state.selected).length + ' 人';
        syncHeadCheck(page);
      });
    });
    Array.prototype.forEach.call($('list').querySelectorAll('[data-wl]'), function (b) {
      b.addEventListener('click', async function () {
        var h = b.getAttribute('data-wl');
        var wl = (state.whitelist || []).slice();
        var i = wl.indexOf(h);
        if (i === -1) wl.push(h); else wl.splice(i, 1);
        if (i === -1) delete state.selected[h];
        await set((function () { var o = {}; o[K.whitelist] = wl; return o; })());
        state.whitelist = wl;
        renderList(); renderWhitelist();
      });
    });
    syncHeadCheck(page);
  }

  function syncHeadCheck(page) {
    var pickable = (page || []).filter(function (u) { return !u.reasons.length; });
    $('headCheck').checked = pickable.length > 0 && pickable.every(function (u) { return !!state.selected[u.handle]; });
    $('headCheck').disabled = pickable.length === 0;
  }

  function renderWhitelist() {
    var box = $('whitelist');
    if (!state.whitelist.length) { box.innerHTML = '<span class="hint">还没有白名单账号。在明细行点「🛡 加入白名单」即可保护。</span>'; return; }
    box.innerHTML = state.whitelist.map(function (h) {
      return '<button type="button" class="chip" data-unwl="' + esc(h) + '" title="点击移出白名单">🛡 @' +
        esc(h) + ' ×</button>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-unwl]'), function (b) {
      b.addEventListener('click', async function () {
        var h = b.getAttribute('data-unwl');
        state.whitelist = state.whitelist.filter(function (x) { return x !== h; });
        await set((function () { var o = {}; o[K.whitelist] = state.whitelist; return o; })());
        renderWhitelist(); renderList();
      });
    });
  }

  // ---------------------------------------------------------------- 任务展示
  function renderTask() {
    var t = state.task || {};
    var total = (t.handles || []).length;
    var done = t.index || 0;
    $('progressBar').style.width = (total ? Math.round(done / total * 100) : 0) + '%';
    var phase = t.phase || 'idle';
    var label = { idle: '任务空闲', running: '执行中', paused: '已暂停', stopped: '已停止', done: '已完成' }[phase] || '任务状态';
    var text = label + ' · 成功 ' + ((t.ok || []).length) + ' / 失败 ' + ((t.fail || []).length) +
      ' / 共 ' + total + (t.message ? ' · ' + t.message : '');
    status('taskStatus', phase === 'idle'
      ? '任务空闲。勾选账号后先点「预演」，确认名单无误再执行。' : text,
      phase === 'done' ? 'ok' : (phase === 'stopped' ? 'err' : (phase === 'running' ? 'warn' : '')));
    var log = (t.log || []).slice(-100).map(function (x) {
      return (x.ok ? '✓ ' : '✗ ') + '@' + x.handle + ' — ' + x.reason;
    });
    $('taskLog').textContent = log.length ? log.join('\n') : '（执行日志会显示在这里）';
    $('pauseTask').disabled = phase !== 'running';
    $('resumeTask').disabled = phase !== 'paused';
    $('stopTask').disabled = phase !== 'running' && phase !== 'paused';
  }

  // ---------------------------------------------------------------- 采集动作
  function meHandle() {
    var v = Core.lowerHandle($('meHandle').value);
    if (!Core.validHandle(v)) { status('capStatus', '请先填写正确的 X 用户名（只含字母、数字、下划线，不含 @）。', 'err'); return ''; }
    return v;
  }

  async function findXTab(pathPart) {
    var tabs = await tabsQuery({ url: ['https://x.com/*', 'https://twitter.com/*'] });
    var hit = tabs.filter(function (t) {
      return pathPart && t.url && String(t.url).toLowerCase().indexOf(pathPart) !== -1;
    });
    return hit[0] || tabs[0] || null;
  }

  async function startCapture(target) {
    var me = meHandle();
    if (!me) return;
    // 从最新缓存起步：面板关闭期间桥接层实时写入的人也算进来，实现断点续采
    var fresh = await get([K.data]);
    var d = normalizeData(fresh[K.data]);
    state.data = d;
    var had = Object.keys(d[target] || {}).length;
    var url = 'https://x.com/' + me + '/' + (target === 'followers' ? 'followers' : 'following');
    var cap = {
      status: 'running', target: target, me: me, startedAt: Date.now(),
      scrolls: 0, idle: 0, count: had, lastCount: had,
      lastTickAt: Date.now(), savedAt: d.savedAt || 0,
      resumedFrom: had, message: ''
    };
    var w = {}; w[K.capture] = cap;
    await set(w);
    state.capture = cap;
    renderCapture();
    var tab = await findXTab('/' + (target === 'followers' ? 'followers' : 'following'));
    if (!tab) {
      tab = await tabsCreate(url);
      await sleep(2500);
    } else if (tab.url && String(tab.url).toLowerCase().indexOf('/' + target) === -1) {
      // 已打开的 X 标签不在目标页，另开一个，避免打断用户正在看的页面
      tab = await tabsCreate(url);
      await sleep(2500);
    }
    if (tab && tab.id != null) {
      var pong = await sendToTab(tab.id, { type: 'FOLLOW_PING' });
      if (!pong || !pong.ok) {
        status('capStatus', '采集脚本还没在这个标签就绪。请刷新该 X 标签页后，回到本面板再点一次「开始采集」；' +
          '已保存的 ' + had + ' 人不会丢失。', 'warn');
        return;
      }
      if (pong.storageError) {
        status('capStatus', '⚠ 本机缓存写入异常：' + pong.storageError +
          '。请检查浏览器存储空间；已保存的 ' + had + ' 人仍在。', 'err');
      }
    }
    status('capStatus', (had ? '继续采集（已从本机缓存恢复 ' + had + ' 人）' : '已开始采集') +
      '：正在自动滚动「' + (target === 'followers' ? '粉丝' : '关注中') +
      '」页，每批数据立即存到本机；X 分页加载完（连续几轮没有新增）会自动结束。', 'warn');
  }

  async function detectMe() {
    var tab = await findXTab('');
    if (!tab) { status('capStatus', '没找到已打开的 x.com 标签，请先打开 X 首页再点识别；也可以直接手填用户名。', 'warn'); return; }
    var r = await sendToTab(tab.id, { type: 'FOLLOW_DETECT_ME' });
    if (r && r.ok && r.me) {
      $('meHandle').value = r.me;
      await writeData({ me: r.me });
      status('capStatus', '已识别：@' + r.me + '。点「保存」或直接开始采集，已保存的名单不受影响。', 'ok');
    } else {
      status('capStatus', '没能自动识别（可能这个标签是扩展重载前的旧脚本）。请刷新 X 标签后重试，或直接手填用户名。', 'warn');
    }
  }

  // ---------------------------------------------------------------- 预演 / 执行
  function openModal(title, warn, body, onConfirm) {
    $('modalTitle').textContent = title;
    $('modalWarn').innerHTML = warn;
    $('modalBody').textContent = body;
    $('modal').classList.add('show');
    var cancel = $('modalCancel'), ok = $('modalConfirm');
    function close() {
      $('modal').classList.remove('show');
      cancel.removeEventListener('click', cancelFn);
      ok.removeEventListener('click', okFn);
    }
    var cancelFn = function () { close(); };
    var okFn = function () { close(); onConfirm(); };
    cancel.addEventListener('click', cancelFn);
    ok.addEventListener('click', okFn);
  }

  async function dryRun() {
    var sel = Object.keys(state.selected);
    if (!sel.length) { status('taskStatus', '请先在上方的明细清单里勾选要取关的账号。', 'warn'); return; }
    var users = Core.mapToList(state.data.following);
    var o = settingsFromUi();
    var task = Core.buildTask(sel, users, o);
    state.pending = task;
    if (!task.handles.length) {
      status('taskStatus', '选中的账号全部受保护（白名单 / 认证 / 大 V / 锁推），没有可执行对象。', 'warn');
      return;
    }
    var lines = [];
    lines.push('将取关 ' + task.handles.length + ' 个账号（单批上限 ' + task.settings.batchLimit + '）：');
    lines.push(task.handles.map(function (h) { return '@' + h; }).join('  '));
    if (task.skipped.length) {
      lines.push('', '已跳过 ' + task.skipped.length + ' 个受保护账号：');
      task.skipped.forEach(function (s) { lines.push('  @' + s.handle + ' — ' + s.reason); });
    }
    lines.push('', '节奏：每次间隔 ' + task.settings.minDelay + '～' +
      (task.settings.minDelay + task.settings.jitter) + ' 毫秒；预计耗时约 ' +
      Math.ceil(task.handles.length * (task.settings.minDelay + task.settings.jitter / 2) / 60000) + ' 分钟。');
    lines.push('执行时会打开/定位你自己的「关注中」页，只点击对应行的原生按钮，找不到就跳过。');
    openModal('批量取关预演（不会执行任何操作）',
      '<b>请逐行核对名单。</b>X 对自动化批量操作有风控，短时间大量取关可能被临时限制账号；' +
      '本批默认 ≥5 秒间隔、最多 50 人、可随时暂停或停止。',
      lines.join('\n'), executeTask);
    status('taskStatus', '预演已生成：' + task.handles.length + ' 个账号待确认，尚未执行任何取关。', 'warn');
  }

  async function executeTask() {
    var task = state.pending;
    if (!task || !task.handles.length) return;
    var me = meHandle();
    if (!me) return;
    var cfg = settingsFromUi();
    var w = {}; w[K.settings] = {
      minDelay: cfg.minDelay, jitter: cfg.jitter, batchLimit: cfg.batchLimit,
      skipProtected: cfg.skipProtected
    };
    await set(w);
    var url = 'https://x.com/' + me + '/following';
    var tab = await findXTab('/following');
    if (!tab) { tab = await tabsCreate(url); await sleep(3000); }
    if (!tab || tab.id == null) { status('taskStatus', '没能打开 X 的「关注中」页，任务未启动。', 'err'); return; }
    var pong = await sendToTab(tab.id, { type: 'FOLLOW_PING' });
    if (!pong || !pong.ok || pong.source !== 'following') {
      status('taskStatus', '请刷新 X 的「关注中」标签页，确认页面停留在自己的关注列表页后' +
        '再点一次执行（安全起见未启动任务）。', 'err');
      return;
    }
    var t = {
      id: 'ft-' + Date.now(), phase: 'running', dryRun: false, confirmed: true,
      handles: task.handles, settings: task.settings, ok: [], fail: [], log: [],
      index: 0, startedAt: Date.now(), message: '任务已启动，等待逐个点击…'
    };
    var w2 = {}; w2[K.task] = t;
    await set(w2);
    state.task = t;
    renderTask();
    // 不等回调：任务可能跑几分钟，进度统一通过 storage.onChanged 回流
    sendToTab(tab.id, { type: 'FOLLOW_TASK_START' }).then(function (r) {
      if (r && r.ok === false) status('taskStatus', '任务未能启动：' + (r.error || '未知原因'), 'err');
    });
  }

  async function setPhase(phase) {
    var r = await get([K.task]);
    var t = r[K.task];
    if (!t) { status('taskStatus', '当前没有运行中的任务。', 'warn'); return; }
    t.phase = phase;
    t.message = phase === 'paused' ? '用户暂停' : phase === 'stopped' ? '用户停止' : '用户继续';
    var w = {}; w[K.task] = t;
    await set(w);
    state.task = t;
    renderTask();
  }

  function exportCsv() {
    var list = decorate(filtered()).map(function (u) {
      return Object.assign({}, u, { tags: u.tags.concat(u.reasons.length ? ['protected'] : []) });
    });
    if (!list.length) { status('taskStatus', '当前筛选结果为空，没有可导出的内容。', 'warn'); return; }
    var blob = new Blob(['\ufeff' + Core.toCsv(list)], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'TapePost关注关系名单-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------------------------------------------------------------- 绑定
  function bind() {
    try { $('followVer').textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) {}
    $('detectMe').addEventListener('click', detectMe);
    $('saveMe').addEventListener('click', async function () {
      var me = meHandle();
      if (!me) return;
      await writeData({ me: me });
      status('capStatus', '已保存 @' + me + '。现在可以开始采集，之前采集到的名单仍在。', 'ok');
    });
    $('capFollowing').addEventListener('click', function () { startCapture('following'); });
    $('capFollowers').addEventListener('click', function () { startCapture('followers'); });
    $('stopCapture').addEventListener('click', async function () {
      var c = Object.assign({}, state.capture || {}, { status: 'stopped', finishedAt: Date.now() });
      var w = {}; w[K.capture] = c;
      await set(w); state.capture = c; renderCapture();
      status('capStatus', '采集已停止。已经抓到的名单已实时保存在本机，不会丢失。', 'warn');
    });
    $('clearData').addEventListener('click', function () {
      openModal('清空本机名单', '<b>只会删除本机的关注/粉丝快照与任务记录</b>，白名单和设置会保留，X 上的关注关系不会有任何变化。',
        '确定要清空吗？清空后需要重新执行两步采集。', async function () {
          // 覆盖式写入（不用 remove）：面板与桥接层都能看到一次明确的「已清空」状态
          await writeData({ me: $('meHandle').value, following: {}, followers: {},
            updatedAt: { following: 0, followers: 0 }, savedAt: 0 });
          var w = {}; w[K.capture] = {}; w[K.task] = {};
          await set(w);
          state.capture = {}; state.task = {}; state.selected = Object.create(null);
          renderAll();
        });
    });
    $('search').addEventListener('input', function (e) { state.search = e.target.value; state.page = 1; renderList(); });
    $('sortBy').addEventListener('change', function (e) { state.sort = e.target.value; state.page = 1; renderList(); });
    $('band').addEventListener('change', function (e) { state.band = e.target.value; state.page = 1; renderList(); });
    $('selectAll').addEventListener('click', function () {
      filtered().slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE).forEach(function (u) {
        if (!u.reasons.length) state.selected[u.handle] = true;
      });
      renderList();
    });
    $('selectNone').addEventListener('click', function () { state.selected = Object.create(null); renderList(); });
    $('headCheck').addEventListener('change', function (e) {
      var page = filtered().slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
      page.forEach(function (u) {
        if (u.reasons.length) return;
        if (e.target.checked) state.selected[u.handle] = true; else delete state.selected[u.handle];
      });
      renderList();
    });
    $('exportCsv').addEventListener('click', exportCsv);
    $('prevPage').addEventListener('click', function () { if (state.page > 1) { state.page--; renderList(); } });
    $('nextPage').addEventListener('click', function () { state.page++; renderList(); });
    $('dryRun').addEventListener('click', dryRun);
    $('pauseTask').addEventListener('click', function () { setPhase('paused'); });
    $('resumeTask').addEventListener('click', function () { setPhase('running'); });
    $('stopTask').addEventListener('click', function () { setPhase('stopped'); });
    $('modal').addEventListener('click', function (e) {
      if (e.target === $('modal')) $('modal').classList.remove('show');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') $('modal').classList.remove('show');
    });
  }

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes[K.data]) {
        state.data = normalizeData(changes[K.data].newValue || state.data);
        renderCapture(); renderCards(); renderList();
      }
      if (changes[K.capture]) { state.capture = changes[K.capture].newValue || {}; renderCapture(); }
      if (changes[K.task]) { state.task = changes[K.task].newValue || {}; renderTask(); }
      if (changes[K.whitelist]) { state.whitelist = changes[K.whitelist].newValue || []; renderWhitelist(); renderList(); }
      if (changes[K.settings]) { state.settings = Object.assign({}, Core.DEFAULTS, changes[K.settings].newValue || {}); }
    });
  }

  bind();
  refresh();
})();
