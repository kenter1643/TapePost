/*
 * TapePost · 关注关系桥接与取关执行器（ISOLATED world，1.5.19）
 * ---------------------------------------------------------------
 * 职责：
 *   1) 收 MAIN world 的被动采集结果，合并进本机 chrome.storage.local；
 *   2) 用户点「开始采集」后，只滚动 X 自己的关注中 / 粉丝页，等 X 自己分页
 *      加载完（连续无新增即结束），全程不发额外请求；
 *   3) 批量取关：只点击 X 页面上「该用户那一行」的原生关注按钮，
 *      两级回退定位 + 文字校验 + 限速 + 暂停/停止 + 单批上限 + 白名单二次校验。
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
  var TICK_MS = 1500;
  var MAX_FAIL_STREAK = 3;

  var storeGet = function (keys) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get(keys, function (r) { resolve(r || {}); }); }
      catch (e) { resolve({}); }
    });
  };
  var storeSet = function (obj) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.set(obj, function () { resolve(true); }); }
      catch (e) { resolve(false); }
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

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var d = event.data;
    if (!d || d[TAG] !== true) return;
    if (d.type === 'TAPEFOLLOW_DATA') {
      var batches = Array.isArray(d.batches) ? d.batches : [];
      if (!batches.length) return;
      serial(function () {
        return storeGet([KEY_DATA, KEY_CAPTURE]).then(function (r) {
          var cap = r[KEY_CAPTURE] || {};
          if (cap.status !== 'running') return;      // 没在采集就不落盘
          var data = r[KEY_DATA] || emptyData();
          var changed = false;
          batches.forEach(function (b) {
            var src = b.source === 'followers' ? 'followers' : 'following';
            if (cap.target && src !== cap.target) return;   // 只收当前目标页的数据
            var before = Object.keys(data[src] || {}).length;
            data[src] = Core.mergeSnapshot(data[src], b.users);
            if (Object.keys(data[src]).length !== before) changed = true;
            data.updatedAt[src] = Date.now();
            if (b.me && !data.me) data.me = Core.lowerHandle(b.me);
          });
          if (!changed) return;
          data.version = 1;
          return storeSet((function () { var o = {}; o[KEY_DATA] = data; return o; })());
        });
      });
    } else if (d.type === 'TAPEFOLLOW_PONG') {
      window.__tapeFollowLastPong = d;
    }
  });

  function scrollOnce() {
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
    storeGet([KEY_CAPTURE, KEY_DATA]).then(function (r) {
      var cap = r[KEY_CAPTURE] || {};
      var src = pageSource();
      var running = cap.status === 'running' && cap.target && cap.target === src;
      postToMain({ type: 'TAPEFOLLOW_CMD', action: running ? 'start' : 'stop' });
      if (!running) return;
      var data = r[KEY_DATA] || emptyData();
      var count = Object.keys(data[src] || {}).length;
      var o = Object.assign({}, cap);
      o.scrolls = (cap.scrolls || 0) + 1;
      o.idle = (count === (cap.lastCount || 0)) ? (cap.idle || 0) + 1 : 0;
      o.lastCount = count;
      o.count = count;
      o.me = data.me || detectMe() || cap.me || '';
      scrollOnce();
      var tooLong = cap.startedAt && (Date.now() - cap.startedAt > Core.DEFAULTS.maxCaptureMs);
      if (o.idle >= Core.DEFAULTS.idleRounds || o.scrolls >= Core.DEFAULTS.maxScroll || tooLong) {
        o.status = 'done';
        o.finishedAt = Date.now();
        o.message = '采集完成：' + (src === 'followers' ? '粉丝' : '关注中') +
          '共 ' + count + ' 人' + (tooLong ? '（已达时间上限，可再点一次继续）' : '');
        postToMain({ type: 'TAPEFOLLOW_CMD', action: 'stop' });
      }
      var w = {}; w[KEY_CAPTURE] = o;
      return storeSet(w);
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
        sendResponse({ ok: true, source: pageSource(), me: detectMe(),
          captureStats: (window.__tapeFollowLastPong || {}).stats || null, busy: taskBusy });
        return false;
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

  // 首帧问一次 MAIN 状态，便于面板诊断「采集器是否注入成功」
  setTimeout(function () { postToMain({ type: 'TAPEFOLLOW_CMD', action: 'ping' }); }, 800);
  setTimeout(captureTick, 600);
})();
