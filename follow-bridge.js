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
   *   2) 面板在长任务（取F / 读名单）完成前关闭，异步 sendResponse 端口已F
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
  var SWEEP_WAIT_MS = 1200;
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
   * cap.target 时才写，采集一旦自动结束、或用户关掉面板让状态卡住，后续批次
   * 就被整批丢弃，重新打开面板只剩「上次抓到的一部分」。现在每批到达立即
   * merge 并写入 chrome.storage.local，与采集状态完全解耦；写入失败保留内存
   * 副本，下一批继续补写，并把失败原因暴露给面板。 */
  /* 1.5.27：数据口径统一交给 FollowCore（面板与桥接层共用），新增墓碑 / 基线 /
   * 变化记录字段。mergeData 不再把「已取F / 已清理」的人从内存副本复活。 */
  function normalizeData(raw) { return Core.normalizeData(raw); }
  function mergeData(fromStore, fromMemory) { return Core.mergeData(fromStore, fromMemory); }

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
          // 1.5.27：打 seenAt / firstSeenAt，并撤销「又出现了」的人的墓碑
          var res = Core.ingestUsers(data, src, users, Date.now());
          var me0 = data.me;
          data = res.data;
          if (!data.me) data.me = me0;
          // 全量重扫时 X 返回的常常都是已存账号：人数不涨，但响应本身证明
          // X 还在往下翻页。人数真的涨了才更新 lastGainAt。
          if (res.gained > 0) lastGainAt = Date.now();
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
    // 先只读采集状态：没在扫描时不读整份名单（名单可能好几 MB，每个 X 标签页
    // 每 1.5 秒读一次会拖慢页面）。在扫描时再用「storage 最新值 + 内存副本」算人数。
    return storeGet([KEY_CAPTURE]).then(function (r) {
      var cap = r[KEY_CAPTURE] || {};
      var src = pageSource();
      var running = cap.status === 'running' && cap.target && cap.target === src;
      postToMain({ type: 'TAPEFOLLOW_CMD', action: running ? 'start' : 'stop' });
      if (!running) return;
      return readData().then(function (data) {

        var now = Date.now();
        var pruneWrite = null;
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
            // 1.5.27：只有「全量扫描 + 真正到底」才清理本轮没出现的人并生成变化记录
            if (cap.mode === 'full') {
              var fin = Core.finishFullScan(data, src, startedAt, now);
              // 这里只算结果用于提示文案；真正写入放进 serial()，基于最新数据重算，
              // 避免和同时到达的一批数据互相覆盖。
              o.prune = { pruned: fin.pruned, coverage: Math.round(fin.coverage * 1000) / 10,
                removed: fin.removed.length, added: fin.added.length, firstBaseline: !!fin.firstBaseline };
              if (fin.pruned) {
                o.count = Object.keys(fin.data[src] || {}).length;
                o.message += fin.firstBaseline
                  ? '。已建立基线，下次全量扫描会自动对比出' + (src === 'followers' ? '「新粉丝 / 取F了你的人」' : '「新F注 / 已不在列表的人」') + '。'
                  : '。对比上次：新增 ' + fin.added.length + ' 人，' +
                    (src === 'followers' ? '取F了你 ' : '已不在列表 ') + fin.removed.length + ' 人（已从本机名单移除，明细见面板「变化记录」）。';
                pruneWrite = serial(function () {
                  return readData().then(function (latest) {
                    var again = Core.finishFullScan(latest, src, startedAt, now);
                    if (!again.pruned) return true;
                    memData = again.data;
                    return persistData();
                  });
                });
              } else if (fin.reason === 'coverage') {
                o.message += '。本轮只看到旧名单的 ' + o.prune.coverage + '%，可能没覆盖全，安全起见没有清理旧数据。';
              }
            }
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
        return Promise.resolve(pruneWrite).then(function () {
          return storeSet(wrap(KEY_CAPTURE, o));
        }).then(function () {
          return writeAnchor(src, memData || data, o);
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

  /* 1.5.27：X 改版后的列表行不一定带 [data-testid="UserCell"]（浮层 1.5.24 已兼容，
   * 执行器之前没兼容 —— 新版 DOM 下逐屏查找每屏都是 0 行，整批被记成「列表里没找到」）。
   * 回退：从带 @handle 的F注按钮（aria-label「Following @x」等）向上找只含这一位
   * 用户的最近容器当作行。只读 DOM，不改 X 结构。 */
  var ROW_BTN_RE = /^(?:following|follow|unfollow|正在关注|关注中|已关注|取消关注|关注)\s*@([A-Za-z0-9_]{1,20})$/i;
  function handlesIn(node) {
    var out = [];
    try {
      var links = node.querySelectorAll ? node.querySelectorAll('a[href^="/"]') : [];
      for (var i = 0; i < links.length; i++) {
        var seg = String(links[i].getAttribute('href') || '').split('?')[0].split('/')[1];
        var h = Core.lowerHandle(seg);
        if (Core.validHandle(h) && out.indexOf(h) === -1) out.push(h);
      }
    } catch (e) {}
    return out;
  }
  function rowMap() {
    var map = {};
    var cells = document.querySelectorAll('[data-testid="UserCell"]');
    for (var i = 0; i < cells.length; i++) {
      var h = cellHandle(cells[i]);
      if (h && !map[h]) map[h] = cells[i];
    }
    if (cells.length) return map;
    var btns = document.querySelectorAll('button[aria-label],[role="button"][aria-label]');
    for (var j = 0; j < btns.length; j++) {
      var m = ROW_BTN_RE.exec(String(btns[j].getAttribute('aria-label') || '').trim());
      if (!m) continue;
      var want = Core.lowerHandle(m[1]);
      if (map[want]) continue;
      var node = btns[j];
      for (var up = 0; node && up < 8; up++, node = node.parentElement) {
        var hs = handlesIn(node);
        var nb = node.querySelectorAll ? node.querySelectorAll('button,[role="button"]').length : 0;
        if (hs.indexOf(want) !== -1 && hs.length <= 4 && nb <= 6) { map[want] = node; break; }
      }
    }
    return map;
  }

  function findCell(handle) {
    return rowMap()[handle] || null;
  }

  function rowHandleOk(cell, handle) {
    if (cellHandle(cell) === handle) return true;
    return handlesIn(cell).indexOf(handle) !== -1 && handlesIn(cell).length <= 4;
  }

  var FOLLOWING_WORDS = /^(following|正在关注|关注中|已关注|following you|フォロー中|abonné|siguiendo|folge ich|订阅中)$/i;
  var FOLLOW_WORDS = /^(follow|关注|follow back|回关|フォロー|suivre|seguir|folgen)$/i;
  var CONFIRM_WORDS = /^(unfollow|取消关注|解除关注|确定取消关注|退订|unfollow @|フォロー解除)$/i;

  function labelOf(el) {
    return String((el.getAttribute && el.getAttribute('aria-label')) || '').trim();
  }
  function isFollowingBtn(el) {
    if (FOLLOWING_WORDS.test(txt(el))) return true;
    var m = ROW_BTN_RE.exec(labelOf(el));
    return !!m && /^(following|正在关注|关注中|已关注)/i.test(labelOf(el));
  }
  function isFollowBtn(el) {
    if (FOLLOW_WORDS.test(txt(el))) return true;
    return /^(follow|关注)\s*@/i.test(labelOf(el));
  }

  function findUnfollowButton(cell) {
    var b = cell.querySelector('[data-testid$="-unfollow"]');
    if (b) return b;
    var roles = cell.querySelectorAll('[role="button"],button');
    for (var i = 0; i < roles.length; i++) {
      if (isFollowingBtn(roles[i])) return roles[i];
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

  /* 成功判定要「看到变成了 Follow」或「Following 按钮确实没了」，旧版只看
   * 「-unfollow testid 不存在」—— 新版 DOM 本来就没有这个 testid，会把没点成功也记成功。 */
  function looksUnfollowed(cell) {
    if (cell.querySelector('[data-testid$="-unfollow"]')) return false;
    var roles = cell.querySelectorAll('[role="button"],button');
    var sawFollow = false;
    for (var i = 0; i < roles.length; i++) {
      if (isFollowingBtn(roles[i])) return false;
      if (isFollowBtn(roles[i])) sawFollow = true;
    }
    return sawFollow || !!cell.querySelector('[data-testid$="-follow"]');
  }

  async function unfollowOne(handle) {
    if (pageSource() !== 'following') return { ok: false, reason: '不在「F注中」页面' };
    var cell = findCell(handle);
    if (!cell) return { ok: false, reason: '没找到这一行（列表未加载或页面结构变化）' };
    if (!rowHandleOk(cell, handle)) return { ok: false, reason: '行与目标账号不匹配，已跳过' };
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
    // X 虚拟列表点完后常会重建这一行：优先看重新找到的行，旧节点只作兜底
    var after = findCell(handle);
    if (!looksUnfollowed(after && after.isConnected !== false ? after : cell)) {
      return { ok: false, reason: '按钮状态未变成「F注」，未确认成功' };
    }
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
    var t = r[KEY_TASK] || {};
    if (runningTaskId && t.id !== runningTaskId) return 'replaced';
    return t.phase || 'idle';
  }

  /* 1.5.27：批量取F改为「从列表顶部往下扫一遍」。
   * 旧版只在当前屏幕已渲染的行里找人：X 的F注列表是虚拟滚动，6000 人里随便
   * 勾 50 个，绝大多数不在屏上，连续 3 次「没找到这一行」就停机。现在：
   *   ① 先回到列表顶部；② 每屏把「本屏可见且待处理」的人逐个处理；
   *   ③ 本屏没有待处理的人就往下滚一屏，等 X 加载；④ 到底仍没出现的人记
   *      「列表里没找到（可能已取F）」，不算定位失败、不触发停机。
   * 断点续跑：已在 ok / fail 里的人不再处理；暂停 / 页面刷新后点「继续」，
   * 从剩下的人接着来。暂停时循环直接退出（不再空等 5 分钟后静默卡死）。
   * 安全不变量不变：确认后才执行、两层保护名单、只点 X 原生按钮、不调写接口、
   * 「找到行但按钮不对 / 状态没变」连续 3 次自动停机。 */
  var taskBusy = false;
  var HEARTBEAT_STALE_MS = 30000;
  var SWEEP_MAX_STEPS = 3000;

  function visibleCells() { return rowMap(); }

  function listGeometry() {
    var de = document.documentElement;
    var h = Math.max(document.body ? document.body.scrollHeight : 0, de ? de.scrollHeight : 0);
    var y = Number(window.scrollY) || 0;
    var vh = Number(window.innerHeight) || 800;
    return { height: h, y: y, vh: vh, atBottom: h > 0 && y + vh >= h - 240 };
  }

  async function sweepScroll() {
    var g = listGeometry();
    try { window.scrollBy(0, Math.max(400, Math.round(g.vh * 0.8))); } catch (e) {}
    await sleep(SWEEP_WAIT_MS);
    var g2 = listGeometry();
    // X 正在加载下一页：再多等一会儿
    var col = document.querySelector('[data-testid="primaryColumn"]') || document;
    if (col.querySelector('[data-testid="spinner"], [aria-busy="true"]')) await sleep(SWEEP_WAIT_MS * 2);
    return { moved: g2.y > g.y + 2 || g2.height > g.height + 2, atBottom: g2.atBottom };
  }

  var runningTaskId = '';
  async function updateTask(fn) {
    var cur = (await readTask()).task;
    if (!cur) return null;
    // 面板换了一批新任务：旧循环的结果绝不写进新任务，返回 stopped 让循环退出
    if (runningTaskId && cur.id !== runningTaskId) return { phase: 'replaced' };
    fn(cur);
    cur.beatAt = Date.now();
    await writeTask(cur);
    return cur;
  }

  function dropFromLocalList(handles) {
    return serial(function () {
      return readData().then(function (data) {
        memData = Core.removeHandles(data, 'following', handles, Date.now(), 'unfollow').data;
        return persistData();
      });
    });
  }

  async function runTask() {
    if (taskBusy) return { ok: false, error: '本页已有一个任务在运行' };
    taskBusy = true;
    try {
      var s = await readTask();
      var t = s.task;
      if (!t) return { ok: false, error: '没有待执行任务' };
      if (t.phase !== 'running') return { ok: false, error: '任务不是待运行状态' };
      runningTaskId = t.id || '';
      if (t.dryRun !== false || t.confirmed !== true) {
        return { ok: false, error: '未经确认或仍是预演，拒绝执行（安全不变量）' };
      }
      if (pageSource() !== 'following') {
        return { ok: false, error: '请停留在自己的「F注中」页面再执行' };
      }
      var limit = t.settings ? t.settings.batchLimit : Core.DEFAULTS.batchLimit;
      var all = (t.handles || []).slice(0, limit);
      var doneSet = {};
      (t.ok || []).forEach(function (h) { doneSet[h] = true; });
      (t.fail || []).forEach(function (f) { if (f && f.handle) doneSet[f.handle] = true; });
      var pending = all.filter(function (h) { return !doneSet[h]; });
      var byHandle = {};
      Core.mapToList(s.data.following).forEach(function (u) { byHandle[u.handle] = u; });
      var protOpts = Object.assign({}, s.settings, { whitelist: s.whitelist });

      // 保护名单先在本地过滤掉，不用为它们滚整页
      var prot = [];
      pending = pending.filter(function (h) {
        var reasons = Core.protectedReasons(byHandle[h] || { handle: h }, protOpts);
        if (reasons.length) { prot.push({ handle: h, reason: '受保护：' + reasons.join(' / ') }); return false; }
        return true;
      });
      if (prot.length) {
        await updateTask(function (cur) {
          cur.fail = (cur.fail || []).concat(prot);
          cur.log = (cur.log || []).concat(prot.map(function (x) {
            return { handle: x.handle, ok: false, reason: x.reason, at: Date.now() };
          }));
          cur.index = (cur.ok || []).length + cur.fail.length;
        });
      }

      await updateTask(function (cur) {
        cur.message = '正在回到列表顶部，从上往下逐屏查找 ' + pending.length + ' 个待取F账号…';
      });
      try { window.scrollTo(0, 0); } catch (e) {}
      await sleep(SWEEP_WAIT_MS);

      var failStreak = 0, steps = 0, stuck = 0, processed = 0, stopReason = '';
      while (pending.length && steps < SWEEP_MAX_STEPS) {
        var ph = await phaseOf();
        if (ph !== 'running') { stopReason = ph; break; }
        var cells = visibleCells();
        var here = pending.filter(function (h) { return cells[h]; });
        if (!here.length) {
          steps++;
          var mv = await sweepScroll();
          stuck = mv.moved ? 0 : stuck + 1;
          if (mv.atBottom && stuck >= 3) break;   // 到底且连续 3 次滚不动：整页扫完
          if (steps % 10 === 0) {
            await updateTask(function (cur) {
              cur.message = '正在往下查找：还剩 ' + pending.length + ' 人待处理（已滚动 ' + steps + ' 屏）';
            });
          }
          continue;
        }
        var h = here[0];
        pending = pending.filter(function (x) { return x !== h; });
        var res = await unfollowOne(h);
        processed++;
        if (res.ok) failStreak = 0;
        else if (/不匹配|按钮|状态未变/.test(res.reason)) failStreak++;
        else failStreak = 0;
        var cur = await updateTask(function (c) {
          c.log = (c.log || []).concat([{ handle: h, ok: !!res.ok, reason: res.reason, at: Date.now() }]);
          if (res.ok) c.ok = (c.ok || []).concat([h]);
          else c.fail = (c.fail || []).concat([{ handle: h, reason: res.reason }]);
          c.index = (c.ok || []).length + (c.fail || []).length;
          c.message = '执行中：还剩 ' + pending.length + ' 人';
        });
        if (res.ok) dropFromLocalList([h]).catch(swallow);
        if (failStreak >= MAX_FAIL_STREAK) {
          await updateTask(function (c) {
            c.phase = 'stopped';
            c.message = '连续 3 次找到行却点不成功，已自动停止，避免 X 改版后误点。请检查页面后重试。';
          });
          stopReason = 'failstreak';
          break;
        }
        if (cur && cur.phase !== 'running') { stopReason = cur.phase; break; }
        if (pending.length) await sleep(Core.delayFor(processed, (cur && cur.settings) || s.settings));
      }

      if (!stopReason && pending.length) {
        // 整页扫完仍没出现：多半已经取F过了，记为跳过，不算定位失败
        var miss = pending.slice();
        await updateTask(function (c) {
          c.fail = (c.fail || []).concat(miss.map(function (x) {
            return { handle: x, reason: '列表里没找到（可能已取F或不在F注列表）' };
          }));
          c.log = (c.log || []).concat(miss.map(function (x) {
            return { handle: x, ok: false, reason: '列表里没找到（可能已取F或不在F注列表）', at: Date.now() };
          }));
          c.index = (c.ok || []).length + c.fail.length;
        });
        pending = [];
      }

      var fin = (await readTask()).task;
      if (fin && runningTaskId && fin.id !== runningTaskId) fin = null;   // 已被新任务替换
      if (fin && fin.phase === 'running' && !pending.length) {
        fin.phase = 'done';
        fin.finishedAt = Date.now();
        fin.message = '本批完成：成功 ' + (fin.ok || []).length + ' / 失败或跳过 ' + (fin.fail || []).length;
        fin.beatAt = Date.now();
        await writeTask(fin);
      } else if (fin && fin.phase === 'paused') {
        fin.message = '已暂停：还剩 ' + pending.length + ' 人，点「继续」从剩下的人接着处理。';
        fin.beatAt = Date.now();
        await writeTask(fin);
      }
      return { ok: true, remaining: pending.length };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    } finally {
      taskBusy = false;
      runningTaskId = '';
    }
  }

  /* 页面刷新 / 关闭会让执行循环消失，但 followTask 还停在 running。
   * 加载时发现心跳过期就改成「已暂停」，由用户点「继续」再跑，绝不自动续跑。 */
  function recoverStaleTask() {
    return storeGet([KEY_TASK]).then(function (r) {
      var t = r[KEY_TASK];
      if (!t || t.phase !== 'running' || taskBusy) return;
      var beat = Number(t.beatAt || t.startedAt) || 0;
      if (Date.now() - beat < HEARTBEAT_STALE_MS) return;
      t.phase = 'paused';
      t.message = '执行页面被刷新或关闭，任务已自动暂停（已处理 ' + ((t.ok || []).length + (t.fail || []).length) +
        ' 人）。回到「F注中」页后点「继续」接着处理剩下的人。';
      return writeTask(t);
    }).catch(swallow);
  }

  // ---------------------------------------------------------------- 4. 扩展消息
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || String(msg.type || '').indexOf('FOLLOW_') !== 0) return false;
      sendResponse = guardedResponse(sendResponse); // 1.5.23：端口关闭时不再留未检查错误
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
        // 批量取F可能跑几分钟，面板关掉后端口已失效；无论成功失败都只回一次包
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

  // 首帧问一次 MAIN 状态，并按已保存的采集状态立刻补发开关（页面刷新后也能续上）
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
  setTimeout(recoverStaleTask, 1500);
})();
