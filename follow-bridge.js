/*
 * TapePost · 关注关系桥接与取关执行器（ISOLATED world，1.5.21）
 * ---------------------------------------------------------------
 * 职责：
 *   1) 收 MAIN world 的被动采集结果，合并进本机 chrome.storage.local；
 *   2) 用户点「开始采集」后，只滚动 X 自己的关注中 / 粉丝页，等 X 自己分页
 *      加载完（连续无新增即结束），全程不发额外请求；
 *   3) 批量取关：只点击 X 页面上「该用户那一行」的原生关注按钮，
 *      两级回退定位 + 文字校验 + 限速 + 暂停/停止 + 单批上限 + 白名单二次校验；
 *   4) 1.5.21 页面内浮层：按 followCapture.mode 决定起始滚动位置，并维护
 *      followScanAnchor 供「增量续扫」回到上次位置（名单始终不清空）。
 *
 * 安全不变量（任何改动都不能破）：
 *   - 不调用 X 的任何私有/公开写接口，不 fetch、不重放请求；
 *   - 取关必须 task.confirmed === true 且 task.dryRun === false；
 *   - 找不到目标行 / 找不到按钮 / 状态没变成「关注」一律记失败，绝不盲点；
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

  function wrap(key, val) { var o = {}; o[key] = val; return o; }

  var storeGet = function (keys) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get(keys, function (r) { resolve(r || {}); }); }
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

  // 串行化所有「读-改-写」，避免采集与取关进度互相覆盖
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
          data[src] = Core.mergeSnapshot(data[src], users);
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
      var batches = Array.isArray(d.batches) ? d.batches : [];
      if (batches.length) ingest(batches);
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
        var count = Object.keys(data[src] || {}).length;
        var o = Object.assign({}, cap);
        o.scrolls = (cap.scrolls || 0) + 1;
        o.idle = (count === (cap.lastCount || 0)) ? (cap.idle || 0) + 1 : 0;
        o.lastCount = count;
        o.count = count;
        o.lastTickAt = Date.now();
        lastTickAt = o.lastTickAt;
        o.savedAt = data.savedAt || cap.savedAt || 0;
        if (cap.storageError) o.storageError = cap.storageError;
        o.me = data.me || detectMe() || cap.me || '';
        applyScanMode(cap, src);
        scrollOnce();
        var tooLong = cap.startedAt && (Date.now() - cap.startedAt > Core.DEFAULTS.maxCaptureMs);
        if (o.idle >= Core.DEFAULTS.idleRounds || o.scrolls >= Core.DEFAULTS.maxScroll || tooLong) {
          o.status = 'done';
          o.finishedAt = Date.now();
          o.message = '采集完成：' + (src === 'followers' ? '粉丝' : '关注中') +
            '共 ' + count + ' 人（已实时保存到本机）' +
            (tooLong ? '（已达时间上限，可再点一次继续）' : '');
          postToMain({ type: 'TAPEFOLLOW_CMD', action: 'stop' });
        }
        return storeSet(wrap(KEY_CAPTURE, o)).then(function () {
          return writeAnchor(src, data, o);
        });
      });
    }).catch(function () {}).then(function () { captureBusy = false; });
  }
  setInterval(captureTick, TICK_MS);

  // ---------------------------------------------------------------- 2. 取关定位
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
    if (pageSource() !== 'following') return { ok: false, reason: '不在「关注中」页面' };
    var cell = findCell(handle);
    if (!cell) return { ok: false, reason: '没找到这一行（列表未加载或页面结构变化）' };
    if (cellHandle(cell) !== handle) return { ok: false, reason: '行与目标账号不匹配，已跳过' };
    var btn = findUnfollowButton(cell);
    if (!btn) return { ok: false, reason: '没找到「正在关注」按钮，可能已取关' };
    try { btn.click(); } catch (e) { return { ok: false, reason: '点击失败：' + (e && e.message || e) }; }
    await sleep(350);
    var confirm = findConfirm();
    if (confirm) {
      try { confirm.click(); } catch (e) { return { ok: false, reason: '确认框点击失败' }; }
      await sleep(450);
    } else {
      await sleep(300);
    }
    if (!looksUnfollowed(cell)) return { ok: false, reason: '按钮状态未变成「关注」，未确认成功' };
    return { ok: true, reason: '已取关' };
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
        return { ok: false, error: '请停留在自己的「关注中」页面再执行' };
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
      if (msg.type === 'FOLLOW_PING') {
        readData().then(function (d) {
          sendResponse({ ok: true, source: pageSource(), me: detectMe(),
            captureStats: (window.__tapeFollowLastPong || {}).stats || null, busy: taskBusy,
            savedCount: {
              following: Object.keys(d.following || {}).length,
              followers: Object.keys(d.followers || {}).length
            },
            savedAt: d.savedAt || 0, storageError: lastStoreError, lastTickAt: lastTickAt,
            anchor: memAnchor ? {
              source: memAnchor.source, count: memAnchor.count,
              scrollY: memAnchor.scrollY, savedAt: memAnchor.savedAt
            } : null });
        });
        return true;
      }
      if (msg.type === 'FOLLOW_DETECT_ME') {
        sendResponse({ ok: true, me: detectMe(), source: pageSource() });
        return false;
      }
      if (msg.type === 'FOLLOW_TASK_START') {
        runTask().then(sendResponse);
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
    });
  }, 800);
  setTimeout(captureTick, 600);
})();
