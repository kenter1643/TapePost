/*
 * TapePost · F注F系桥接与取F执行器（ISOLATED world，1.5.23）
 * ---------------------------------------------------------------
 * 职责：
 *   1) 收 MAIN world 的被动采集结果，合并进本机 chrome.storage.local；
 *   2) 用户点「开始采集」后，只滚动 X 自己的F注中 / 粉丝页，等 X 自己分页
 *      加载完（1.5.22 起按 Core.scanVerdict() 多信号判定：最短时长 + 最后一次
 *      X 响应 / 名单新增 / 页面变高 + 连续静默 + 到底且高度稳定 + 加载指示器；
 *      达上限只标「中断、可继续」，绝不冒充完成），全程不发额外请求；
 *   3) 批量取F：只点击 X 页面上「该用户那一行」的原生F注按钮，
 *      两级回退定位 + 文字校验 + 限速 + 暂停/停止 + 单批上限 + 白名单二次校验；
 *   4) 1.5.21 页面内浮层：按 followCapture.mode 决定起始滚动位置，并维护
 *      followScanAnchor 供「增量续扫」回到上次位置（名单始终不清空）。
 *
 * 安全不变量（任何改动都不能破）：
 *   - 不调用 X 的任何私有/公开写接口，不 fetch、不重放请求；
 *   - 取F必须 task.confirmed === true 且 task.dryRun === false；
 *   - 找不到目标行 / 找不到按钮 / 状态没变成「F注」一律记失败，绝不盲点；
 *   - 连续 3 次定位失败自动停机，防止 X 改版后误点别的按钮；
 *   - 保护名单在桥接层再校验一次，不信任面板层；
 *   - 只在本机存储公开主页资料，不上传任何服务器。
 */
(function () {
  'use strict';
  if (window.__tapeFollowBridge) return;
  window.__tapeFollowBridge = true;
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;

  var Core = window.FollowCore;
  if (!Core) return;
  /* 1.5.23：chrome://extensions「错误」面板三类红字统一兜底：
   *   1) 回调式 chrome.* API 未同步读取 lastError → Unchecked runtime.lastError；
   *   2) 面板在长任务（取F / 读名单）完成前F闭，异步 sendResponse 端口已F
   *      → Error handling response / Unchecked lastError；
   *   3) async 事件回调里未 catch 的 Promise → Uncaught (in promise)。
   * 这里只加防护，不改变采集 / 取F逻辑与安全不变量。 */
  function guardedResponse(sendResponse) {
    var raw = sendResponse;
    var done = false;
    return function (payload) {
      if (done) return;
      done = true;
      try { raw(payload); } catch (e) {}
      try { void (chrome.runtime && chrome.runtime.lastError); } catch (e) {}
    };
  }
  function swallow() {}
  var TAG = '__tapeFollow';
  var KEY_DATA = 'followData';
  var KEY_CAPTURE = 'followCapture';
  var KEY_TASK = 'followTask';
  var KEY_WHITELIST = 'followWhitelist';
  var KEY_SETTINGS = 'followSettings';
  var KEY_ANCHOR = 'followScanAnchor';
  var TICK_MS = 1500;
  var MAX_FAIL_STREAK = 3;
  var lastStoreError = '';
  var lastTickAt = 0;
  var memData = null;   // 内存副本：写入失败也能下批补写，不让已合并的名单丢掉
  var memAnchor = null; // 增量续扫锚点（按当前 X 账号 / 列表记录上次扫描位置）
  var appliedModeFor = 0;
  var pendingScrollY = null;
  // 1.5.22 扫描活跃度信号：X 还在翻页就绝不停，人数没涨不等于扫完了
  var lastResponseAt = 0;   // 最后一次收到 X 被动响应（含 TAPEFOLLOW_PULSE 心跳）
  var lastGainAt = 0;       // 最后一次本机名单人数增加
  var lastHeightAt = 0;     // 最后一次页面高度增长（X 渲染出新的行）
  var lastScrollHeight = 0;
  var bottomStable = 0;     // 连续到底且高度稳定的轮数
  var loadingSince = 0;     // 第一次看到 X 加载指示器的时间
  var scanStartedFor = 0;   // 当前扫描的 startedAt，用于换轮时重置信号

  function wrap(key, val) { var o = {}; o[key] = val; return o; }

  var storeGet = function (keys) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get(keys, function (r) {
        void (chrome.runtime && chrome.runtime.lastError); // 1.5.23
        resolve(r || {});
      }); }
      catch (e) { resolve({}); }
    });
  };
  var storeSet = function (obj) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.set(obj, function () {
          try {
            var err = chrome.runtime && chrome.runtime.lastError;
            if (err) { lastStoreError = String(err.message || err); resolve(false); return; }
          } catch (e) {}
          lastStoreError = '';
          resolve(true);
        });
      } catch (e) { lastStoreError = String(e && e.message || e); resolve(false); }
    });
  };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var txt = function (el) { return String((el && (el.innerText || el.textContent)) || '').trim(); };

  // 串行化所有「读-改-写」，避免采集与取F进度互相覆盖
  var chain = Promise.resolve();
  function serial(fn) {
    var next = chain.then(fn, fn);
    chain = next.catch(function () {});
    return next;
  }

  function emptyData() {
    return { me: '', following: {}, followers: {}, updatedAt: { following: 0, followers: 0 },
      version: 1, source: 'passive' };
  }

  function pageSource() {
    var p = String(location.pathname || '').toLowerCase();
    if (p.indexOf('followers') !== -1) return 'followers';
    if (p.indexOf('following') !== -1) return 'following';
    return '';
  }

  function detectMe() {
    var sels = ['[data-testid="AppTabBar_Profile_Link"]',
      'a[data-testid*="Profile_Link"]', 'a[href^="/"][aria-label*="Profile"]'];
    for (var i = 0; i < sels.length; i++) {
      try {
        var a = document.querySelector(sels[i]);
        var h = a && a.getAttribute('href');
        if (h) {
          var seg = h.split('?')[0].split('/')[1];
          if (Core.validHandle(Core.lowerHandle(seg))) return Core.lowerHandle(seg);
        }
      } catch (e) {}
    }
    var m = String(location.pathname || '').match(/^\/([A-Za-z0-9_]{1,20})\/(following|followers)/i);
    return m ? Core.lowerHandle(m[1]) : '';
  }

  // ---------------------------------------------------------------- 1. 被动采集
  function postToMain(payload) {
    try { window.postMessage(Object.assign({ [TAG]: true }, payload), '*'); } catch (e) {}
  }

  /* 实时落盘（1.5.20 修复）：旧版只在 cap.status === 'running' 且来源等于
   * cap.target 时才写，采集一旦自动结束、或用户F掉面板让状态卡住，后续批次
   * 就被整批丢弃，重新打开面板只剩「上次抓到的一部分」。现在每批到达立即
   * merge 并写入 chrome.storage.local，与采集状态完全解耦；写入失败保留内存
   * 副本，下一批继续补写，并把失败原因暴露给面板。 */
  function normalizeData(raw) {
    var d = raw && typeof raw === 'object' ? raw : emptyData();
    var u = d.updatedAt && typeof d.updatedAt === 'object' ? d.updatedAt : {};
    return {
      me: Core.lowerHandle(d.me || ''),
      following: d.following && typeof d.following === 'object' ? d.following : {},
      followers: d.followers && typeof d.followers === 'object' ? d.followers : {},
      updatedAt: { following: Number(u.following) || 0, followers: Number(u.followers) || 0 },
      savedAt: Number(d.savedAt) || 0,
      version: 1, source: 'passive'
    };
  }

  // storage 最新值 + 内存副本合并：面板写的 me 与桥接刚采到的用户都不丢
  function mergeData(fromStore, fromMemory) {
    var out = normalizeData(fromStore);
    var mem = normalizeData(fromMemory);
    ['following', 'followers'].forEach(function (src) {
      Object.keys(mem[src]).forEach(function (k) { if (!out[src][k]) out[src][k] = mem[src][k]; });
      out.updatedAt[src] = Math.max(out.updatedAt[src], mem.updatedAt[src]);
    });
    if (!out.me) out.me = mem.me;
    return out;
  }

  // 名单很大时裁掉超长简介，避免触及 storage.local 配额导致整个 set 静默失败
  function compactIfNeeded(d) {
    var size = 0;
    try { size = JSON.stringify(d).length; } catch (e) { return d; }
    if (size < 6 * 1024 * 1024) return d;
    ['following', 'followers'].forEach(function (src) {
      Object.keys(d[src]).forEach(function (k) {
        var u = d[src][k];
        if (u && typeof u.bio === 'string' && u.bio.length > 160) u.bio = u.bio.slice(0, 160);
      });
    });
    return d;
  }

  function readData() {
    return storeGet([KEY_DATA]).then(function (r) {
      memData = mergeData(r[KEY_DATA], memData);
      return memData;
    });
  }

  function persistData() {
    if (!memData) return Promise.resolve(true);
    memData.savedAt = Date.now();
    compactIfNeeded(memData);
    return storeSet(wrap(KEY_DATA, memData)).then(function (ok) {
      if (!ok) {
        storeGet([KEY_CAPTURE]).then(function (r) {
          var c = Object.assign({}, r[KEY_CAPTURE] || {}, {
            storageError: lastStoreError, savedAt: memData ? memData.savedAt : 0
          });
          return storeSet(wrap(KEY_CAPTURE, c));
        }).catch(function () {});
      }
      return ok;
    });
  }

  function ingest(batches) {
    return serial(function () {
      return readData().then(function (data) {
        var page = pageSource();
        var touched = false;
        (batches || []).forEach(function (b) {
          var src = b.source === 'followers' ? 'followers' : 'following';
          // 只接受当前 X 标签页对应的来源，不把别的列表混进本机名单
          if (page && src !== page) return;
          var users = Array.isArray(b.users) ? b.users : [];
          if (!users.length) return;
          var before = Object.keys(data[src] || {}).length;
          data[src] = Core.mergeSnapshot(data[src], users);
          // 全量重扫时 X 返回的常常都是已存账号：人数不涨，但响应本身证明
          // X 还在往下翻页。人数真的涨了才更新 lastGainAt。
          if (Object.keys(data[src]).length > before) lastGainAt = Date.now();
          data.updatedAt[src] = Date.now();
          if (b.me && !data.me) data.me = Core.lowerHandle(b.me);
          touched = true;
        });
        memData = data;
        return touched ? persistData() : true;   // 无条件立即落盘，不看采集状态
      });
    });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var d = event.data;
    if (!d || d[TAG] !== true) return;
    if (d.type === 'TAPEFOLLOW_DATA') {
      // 1.5.22：只要 X 还在返回响应就是「活跃」，哪怕这批全是已存账号、
      // 或 pickUsers 一个用户都没提取到。没有这个信号，6 秒就会误停。
      lastResponseAt = Date.now();
      var batches = Array.isArray(d.batches) ? d.batches : [];
      if (batches.length) ingest(batches).catch(swallow);
    } else if (d.type === 'TAPEFOLLOW_PULSE') {
      // 采集器在「X 有响应但没解析出用户」时发的轻量心跳，只含计数与时间戳
      lastResponseAt = Date.now();
    } else if (d.type === 'TAPEFOLLOW_PONG') {
      window.__tapeFollowLastPong = d;
    }
  });

  /* 1.5.21 页面内浮层的起始位置：
   *   mode = full          → 先回到列表顶部再逐屏滚动（已有名单保留、自动去重）；
   *   mode = incremental   → 先回到 followScanAnchor 记下的位置再往下补；
   *   面板的 startCapture 不写 mode，pendingScrollY 一直是 null，行为与 1.5.20
   *   完全一致（不额外跳位置），避免破坏既有的「继续采集」断点续采。
   * 这一帧只定位、不额外滚动，防止一下跳过一屏漏采。 */
  function applyScanMode(cap, src) {
    if (!cap.mode || !cap.startedAt || appliedModeFor === cap.startedAt) return;
    appliedModeFor = cap.startedAt;
    if (cap.mode === 'full') { pendingScrollY = 0; return; }
    if (cap.mode === 'incremental') {
      var a = memAnchor;
      pendingScrollY = (a && a.source === src && a.savedAt) ? (Number(a.scrollY) || 0) : 0;
    }
  }

  /* 每批人数变化（或至少每 10 秒）记一次锚点，写入频率远低于名单落盘。
   * 锚点只含本机公开资料的统计信息，不含任何凭证或页面内容。 */
  function writeAnchor(src, data, cap) {
    if (!src) return Promise.resolve(true);
    var keys = Object.keys(data[src] || {});
    var now = Date.now();
    if (memAnchor && memAnchor.source === src && memAnchor.count === keys.length &&
        now - (Number(memAnchor.savedAt) || 0) < 10000 && cap.status === 'running') {
      return Promise.resolve(true);
    }
    var a = {
      me: data.me || detectMe() || '', source: src,
      scrollY: Math.round(Number(window.scrollY) || 0),
      count: keys.length, lastHandle: keys.length ? keys[keys.length - 1] : '',
      savedAt: now, mode: cap.mode || 'incremental'
    };
    memAnchor = a;
    return storeSet(wrap(KEY_ANCHOR, a));
  }

  /* 1.5.22：只读取页面几何信息与加载状态，不改 DOM、不发请求。
   * 页面高度增长说明 X 刚渲染出新的一批行；到底且高度稳定才可能真扫完。 */
  function scanGeometry() {
    var g = { height: 0, atBottom: false, growing: false, loading: false };
    try {
      var de = document.documentElement;
      var h = Math.max(document.body ? document.body.scrollHeight : 0,
        de ? de.scrollHeight : 0);
      g.height = h;
      var y = Number(window.scrollY) || 0;
      var vh = Number(window.innerHeight) || 0;
      g.atBottom = h > 0 && (y + vh >= h - 240);
      if (h > lastScrollHeight + 2) { g.growing = true; lastHeightAt = Date.now(); }
      lastScrollHeight = h;
      // 只认 X 真正的加载指示器，且限定在列表主列内，避免常驻进度条误判
      var col = document.querySelector('[data-testid="primaryColumn"]') || document;
      g.loading = !!(col.querySelector('[data-testid="spinner"], [data-testid="waitSpinner"], [aria-busy="true"]'));
    } catch (e) {}
    return g;
  }

  function scrollOnce() {
    if (pendingScrollY != null) {
      try { window.scrollTo(0, pendingScrollY); } catch (e) {}
      pendingScrollY = null;
      return;
    }
    try {
      var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      window.scrollTo(0, h);
      window.scrollBy(0, 1200);
      // 少数布局用内部滚动容器，顺带推一下，不改变任何 DOM 结构
      var boxes = document.querySelectorAll('[data-testid="primaryColumn"], main');
      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].scrollHeight > boxes[i].clientHeight + 50) boxes[i].scrollTop = boxes[i].scrollHeight;
      }
    } catch (e) {}
  }

  var captureBusy = false;
  function captureTick() {
    if (captureBusy) return;
    captureBusy = true;
    // 用「storage 最新值 + 内存副本」算人数，避免拿旧快照误判「无新增」提前结束
    return readData().then(function (data) {
      return storeGet([KEY_CAPTURE]).then(function (r) {
        var cap = r[KEY_CAPTURE] || {};
        var src = pageSource();
        var running = cap.status === 'running' && cap.target && cap.target === src;
        postToMain({ type: 'TAPEFOLLOW_CMD', action: running ? 'start' : 'stop' });
        if (!running) return;

        var now = Date.now();
        var startedAt = Number(cap.startedAt) || now;
        // 换了一轮扫描只丢弃「早于本轮开始」的旧信号。注意别一刀切清零：
        // 用户点开始后 X 可能在第一个 tick 之前就返回响应，抹掉它会被误判成
        // 「整轮没有 X 分页数据」。
        if (startedAt !== scanStartedFor) {
          scanStartedFor = startedAt;
          if (lastResponseAt < startedAt) lastResponseAt = 0;
          if (lastGainAt < startedAt) lastGainAt = 0;
          if (lastHeightAt < startedAt) lastHeightAt = 0;
          lastScrollHeight = 0; bottomStable = 0; loadingSince = 0;
        }

        var count = Object.keys(data[src] || {}).length;
        var gained = count > (Number(cap.lastCount) || 0);
        if (gained) lastGainAt = now;
        var geo = scanGeometry();
        if (geo.loading) { if (!loadingSince) loadingSince = now; }
        else loadingSince = 0;
        if (geo.atBottom) bottomStable = Math.min(bottomStable + 1, 999);
        else bottomStable = 0;

        // 只有「没有响应、没有新增、页面也没变高」的轮次才算静默
        var quiet = !gained && !geo.growing && (now - lastResponseAt >= TICK_MS);
        var idle = quiet ? (Number(cap.idle) || 0) + 1 : 0;

        var o = Object.assign({}, cap);
        o.scrolls = (Number(cap.scrolls) || 0) + 1;
        o.idle = idle;
        o.lastCount = count;
        o.count = count;
        o.lastTickAt = now;
        lastTickAt = now;
        o.savedAt = data.savedAt || cap.savedAt || 0;
        if (cap.storageError) o.storageError = cap.storageError;
        o.me = data.me || detectMe() || cap.me || '';

        applyScanMode(cap, src);
        var verdict = Core.scanVerdict({
          now: now, startedAt: startedAt, scrolls: o.scrolls,
          lastResponseAt: lastResponseAt || startedAt,
          lastGainAt: lastGainAt || startedAt,
          lastHeightAt: lastHeightAt || startedAt,
          idle: idle, atBottom: geo.atBottom, bottomStable: bottomStable,
          loading: geo.loading, loadingSince: loadingSince
        });
        // 诊断信息只写本机，供浮层 / 面板告诉用户「在等 X 加载」还是「已到底」
        o.scan = {
          reason: verdict.reason, lastResponseAt: lastResponseAt,
          lastGainAt: lastGainAt, lastHeightAt: lastHeightAt,
          bottomStable: bottomStable, idle: idle, atBottom: geo.atBottom,
          loading: geo.loading
        };
        window.__tapeFollowLastScan = o.scan;

        // X 正在加载这一页时别再滚，避免每 1.5 秒重复滚到底打断分页；
        // 但加载指示器常驻超过宽限就必须恢复滚动，否则会一直卡在原地。
        var loadingBlocks = geo.loading && loadingSince &&
          (now - loadingSince < Core.DEFAULTS.scanLoadingGraceMs);
        if (verdict.action === 'continue' && !loadingBlocks) scrollOnce();

        if (verdict.action === 'done') {
          o.finishedAt = now;
          if (!lastResponseAt) {
            // 一轮下来连一次 X 分页响应都没看到，绝不能说「采集完成」
            o.status = 'interrupted';
            o.message = '本轮没有检测到 X 的分页数据（可能页面还没加载完、没登录，或 X 改了接口）。' +
              '已存的 ' + count + ' 人全部保留；请刷新 X 的「F注中 / 粉丝」页后点「增量续扫」重试。';
          } else {
            o.status = 'done';
            o.message = '采集完成：' + (src === 'followers' ? '粉丝' : 'F注中') +
              '共 ' + count + ' 人（列表已到底，X 连续一段时间没有再加载新页，已实时保存到本机）';
          }
          postToMain({ type: 'TAPEFOLLOW_CMD', action: 'stop' });
        } else if (verdict.action === 'limit') {
          // 达上限绝不冒充「完成」：标中断、名单全部保留，用户可继续补
          o.status = 'interrupted';
          o.finishedAt = now;
          o.message = '本轮扫描已达' +
            (verdict.reason === 'time' ? '时间上限（20 分钟）' : '滚动上限') +
            '，已抓到 ' + count + ' 人并全部保存在本机。名单没丢，点「增量续扫」或面板里的「继续采集」接着补，已抓到的人不会重复。';
          postToMain({ type: 'TAPEFOLLOW_CMD', action: 'stop' });
        }
        return storeSet(wrap(KEY_CAPTURE, o)).then(function () {
          return writeAnchor(src, data, o);
        });
      });
    }).catch(function () {}).then(function () { captureBusy = false; });
  }
  setInterval(captureTick, TICK_MS);

  // ---------------------------------------------------------------- 2. 取F定位
  function cellHandle(cell) {
    var links = cell.querySelectorAll('a[href^="/"]');
    for (var i = 0; i < links.length; i++) {
      var seg = String(links[i].getAttribute('href') || '').split('?')[0].split('/')[1];
      var h = Core.lowerHandle(seg);
      if (Core.validHandle(h)) return h;
    }
    return '';
  }

  function findCell(handle) {
    var cells = document.querySelectorAll('[data-testid="UserCell"]');
    for (var i = 0; i < cells.length; i++) {
      if (cellHandle(cells[i]) === handle) return cells[i];
    }
    // 回退 1：结构改版后 UserCell 可能没了，从主页链接向上找带按钮的行容器
    var all = document.querySelectorAll('a[href^="/"]');
    for (var j = 0; j < all.length; j++) {
      var seg = String(all[j].getAttribute('href') || '').split('?')[0].split('/')[1];
      if (Core.lowerHandle(seg) !== handle) continue;
      var el = all[j].parentElement;
      for (var k = 0; k < 7 && el; k++, el = el.parentElement) {
        if (el.querySelector && el.querySelector('[role="button"],button')) return el;
      }
    }
    return null;
  }

  var FOLLOWING_WORDS = /^(following|正在关注|关注中|已关注|following you|フォロー中|abonné|siguiendo|folge ich|订阅中)$/i;
  var FOLLOW_WORDS = /^(follow|关注|follow back|回关|フォロー|suivre|seguir|folgen)$/i;
  var CONFIRM_WORDS = /^(unfollow|取消关注|解除关注|确定取消关注|退订|unfollow @|フォロー解除)$/i;

  function findUnfollowButton(cell) {
    var b = cell.querySelector('[data-testid$="-unfollow"]');
    if (b) return b;
    var roles = cell.querySelectorAll('[role="button"],button');
    for (var i = 0; i < roles.length; i++) {
      if (FOLLOWING_WORDS.test(txt(roles[i]))) return roles[i];
    }
    return null;
  }

  function findConfirm() {
    var c = document.querySelector('[data-testid="confirmationSheetConfirm"]');
    if (c) return c;
    var roles = document.querySelectorAll('[role="button"],button');
    for (var i = 0; i < roles.length; i++) {
      if (CONFIRM_WORDS.test(txt(roles[i]))) return roles[i];
    }
    return null;
  }

  function looksUnfollowed(cell) {
    var b = cell.querySelector('[data-testid$="-unfollow"]');
    if (!b) return true;
    var roles = cell.querySelectorAll('[role="button"],button');
    for (var i = 0; i < roles.length; i++) {
      if (FOLLOW_WORDS.test(txt(roles[i]))) return true;
    }
    return false;
  }

  async function unfollowOne(handle) {
    if (pageSource() !== 'following') return { ok: false, reason: '不在「F注中」页面' };
    var cell = findCell(handle);
    if (!cell) return { ok: false, reason: '没找到这一行（列表未加载或页面结构变化）' };
    if (cellHandle(cell) !== handle) return { ok: false, reason: '行与目标账号不匹配，已跳过' };
    var btn = findUnfollowButton(cell);
    if (!btn) return { ok: false, reason: '没找到「正在F注」按钮，可能已取F' };
    try { btn.click(); } catch (e) { return { ok: false, reason: '点击失败：' + (e && e.message || e) }; }
    await sleep(350);
    var confirm = findConfirm();
    if (confirm) {
      try { confirm.click(); } catch (e) { return { ok: false, reason: '确认框点击失败' }; }
      await sleep(450);
    } else {
      await sleep(300);
    }
    if (!looksUnfollowed(cell)) return { ok: false, reason: '按钮状态未变成「F注」，未确认成功' };
    return { ok: true, reason: '已取F' };
  }

  // ---------------------------------------------------------------- 3. 任务执行
  async function readTask() {
    var r = await storeGet([KEY_TASK, KEY_WHITELIST, KEY_SETTINGS, KEY_DATA]);
    return {
      task: r[KEY_TASK] || null,
      whitelist: r[KEY_WHITELIST] || [],
      settings: Object.assign({}, Core.DEFAULTS, r[KEY_SETTINGS] || {}),
      data: r[KEY_DATA] || emptyData()
    };
  }

  function writeTask(task) {
    var o = {}; o[KEY_TASK] = task;
    return storeSet(o);
  }

  async function phaseOf() {
    var r = await storeGet([KEY_TASK]);
    return (r[KEY_TASK] || {}).phase || 'idle';
  }

  var taskBusy = false;
  async function runTask() {
    if (taskBusy) return { ok: false, error: '本页已有一个任务在运行' };
    taskBusy = true;
    try {
      var s = await readTask();
      var t = s.task;
      if (!t) return { ok: false, error: '没有待执行任务' };
      if (t.phase !== 'running') return { ok: false, error: '任务不是待运行状态' };
      if (t.dryRun !== false || t.confirmed !== true) {
        return { ok: false, error: '未经确认或仍是预演，拒绝执行（安全不变量）' };
      }
      if (pageSource() !== 'following') {
        return { ok: false, error: '请停留在自己的「F注中」页面再执行' };
      }
      var handles = (t.handles || []).slice(0, t.settings ? t.settings.batchLimit : Core.DEFAULTS.batchLimit);
      var byHandle = {};
      Core.mapToList(s.data.following).forEach(function (u) { byHandle[u.handle] = u; });
      var failStreak = 0;
      for (var i = 0; i < handles.length; i++) {
        var ph = await phaseOf();
        if (ph === 'stopped') break;
        // 暂停：最多等 5 分钟，期间每 500ms 看一次用户指令
        var waited = 0;
        while (ph === 'paused' && waited < 300000) { await sleep(500); waited += 500; ph = await phaseOf(); }
        if (ph === 'stopped') break;
        if (ph !== 'running') break;
        var h = handles[i];
        var u = byHandle[h] || { handle: h };
        var reasons = Core.protectedReasons(u, Object.assign({}, s.settings, { whitelist: s.whitelist }));
        var res = reasons.length ? { ok: false, reason: '受保护：' + reasons.join(' / ') }
          : await unfollowOne(h);
        var cur = (await readTask()).task || t;
        cur.index = i + 1;
        cur.log = (cur.log || []).concat([{ handle: h, ok: !!res.ok, reason: res.reason, at: Date.now() }]);
        if (res.ok) cur.ok = (cur.ok || []).concat([h]);
        else cur.fail = (cur.fail || []).concat([{ handle: h, reason: res.reason }]);
        if (res.ok) failStreak = 0;
        else if (/没找到|不匹配|状态未变/.test(res.reason)) failStreak++;
        else failStreak = 0;
        if (failStreak >= MAX_FAIL_STREAK) {
          cur.phase = 'stopped';
          cur.message = '连续 3 次定位失败，已自动停止，避免 X 改版后误点。请检查页面后重试。';
          await writeTask(cur);
          break;
        }
        await writeTask(cur);
        if (i < handles.length - 1) await sleep(Core.delayFor(i, cur.settings || s.settings));
      }
      var fin = (await readTask()).task;
      if (fin && fin.phase === 'running') {
        fin.phase = 'done';
        fin.finishedAt = Date.now();
        fin.message = '本批完成：成功 ' + (fin.ok || []).length + ' / 失败 ' + (fin.fail || []).length;
        await writeTask(fin);
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    } finally {
      taskBusy = false;
    }
  }

  // ---------------------------------------------------------------- 4. 扩展消息
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || String(msg.type || '').indexOf('FOLLOW_') !== 0) return false;
      sendResponse = guardedResponse(sendResponse); // 1.5.23：端口F闭时不再留未检查错误
      if (msg.type === 'FOLLOW_PING') {
        readData().then(function (d) {
          sendResponse({ ok: true, source: pageSource(), me: detectMe(),
            captureStats: (window.__tapeFollowLastPong || {}).stats || null, busy: taskBusy,
            savedCount: {
              following: Object.keys(d.following || {}).length,
              followers: Object.keys(d.followers || {}).length
            },
            savedAt: d.savedAt || 0, storageError: lastStoreError, lastTickAt: lastTickAt,
            scan: window.__tapeFollowLastScan || null,
            anchor: memAnchor ? {
              source: memAnchor.source, count: memAnchor.count,
              scrollY: memAnchor.scrollY, savedAt: memAnchor.savedAt
            } : null });
        }).catch(function () {
          sendResponse({ ok: false, source: pageSource(), busy: taskBusy });
        });
        return true;
      }
      if (msg.type === 'FOLLOW_DETECT_ME') {
        sendResponse({ ok: true, me: detectMe(), source: pageSource() });
        return false;
      }
      if (msg.type === 'FOLLOW_TASK_START') {
        // 批量取F可能跑几分钟，面板F掉后端口已失效；无论成功失败都只回一次包
        runTask().then(function (r) { sendResponse(r); }, function (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }).catch(swallow);
        return true;
      }
      return false;
    });
  }

  // 面板点「开始采集」后立即开启 MAIN 采集器，不用等 1.5 秒的滚动 tick
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      // 用户在面板点了「清空本机名单」：丢掉内存副本，避免下一批把旧名单复活
      if (changes[KEY_DATA]) {
        var nd = changes[KEY_DATA].newValue;
        var cleared = !nd || (!Object.keys(nd.following || {}).length &&
          !Object.keys(nd.followers || {}).length && !nd.savedAt);
        if (cleared) memData = null;
      }
      if (changes[KEY_ANCHOR]) memAnchor = changes[KEY_ANCHOR].newValue || null;
      if (!changes[KEY_CAPTURE]) return;
      var c = changes[KEY_CAPTURE].newValue || {};
      var on = c.status === 'running' && c.target && c.target === pageSource();
      postToMain({ type: 'TAPEFOLLOW_CMD', action: on ? 'start' : 'stop' });
    });
  }

  // 首帧问一次 MAIN 状态，并按已保存的采集状态立刻补发开F（页面刷新后也能续上）
  setTimeout(function () {
    postToMain({ type: 'TAPEFOLLOW_CMD', action: 'ping' });
    storeGet([KEY_CAPTURE, KEY_ANCHOR]).then(function (r) {
      memAnchor = r[KEY_ANCHOR] || null;
      var c = r[KEY_CAPTURE] || {};
      var on = c.status === 'running' && c.target && c.target === pageSource();
      postToMain({ type: 'TAPEFOLLOW_CMD', action: on ? 'start' : 'stop' });
    }).catch(swallow);
  }, 800);
  setTimeout(captureTick, 600);
})();
