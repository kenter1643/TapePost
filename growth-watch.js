/*
 * TapePost · X 增长计划「真实发送」旁听器（1.5.27）
 * ---------------------------------------------------------------
 * 旧版只统计「用 TapePost 准备好内容」的动作（打开发推预填 / 写入回复框），
 * 你自己手写、直接点 X 发送的不计数，也分不清「准备了但最后没发」。
 *
 * 这里只做一件事：在 x.com 页面上旁听你点 X 自己的「发布 / 回复」按钮
 * （以及 Ctrl/⌘+Enter 快捷发送），判断这一下是发推还是评论、评论的是谁的哪条帖子，
 * 记下这一刻输入框里的文字，然后**等 X 给出结果**再发 GROWTH_SENT 给后台：
 *   - 成功（X 的「已发送」提示 / 输入框清空 / 弹窗关闭）→ status ok，才 +1；
 *     刚用 TapePost 准备过同一条 → 只确认那条，不重复 +1；
 *   - X 报错（出错了 / 重复内容 / 超出限制…）→ status fail，只进发送日志；
 *   - 15 秒没有任何结果 → status unknown，只进发送日志。
 *
 * 边界：捕获阶段只读、不 preventDefault、不代点任何按钮、不发网络请求、不读凭证；
 * 读到的发送文字最多 280 字，只存在本机的发送日志里（默认保留 7 天）；
 * 按钮处于禁用状态（没写内容）时不计数。
 */
(function (root) {
  'use strict';

  var RESERVED = ['i', 'home', 'search', 'explore', 'intent', 'compose', 'notifications', 'messages', 'settings'];

  function statusFrom(href) {
    var m = /(?:^|\/\/[^/]+)?\/([A-Za-z0-9_]{1,20})\/status\/(\d{1,25})/.exec(String(href || ''));
    if (!m) return null;
    var h = m[1].toLowerCase();
    return { author: RESERVED.indexOf(h) >= 0 ? '' : h, id: m[2] };
  }

  /* 纯函数：根据页面上下文判断这次发送是发推还是评论。
   * ctx = { path, search, testid, inDialog, dialogHasTweet, dialogStatusHref } */
  function classify(ctx) {
    ctx = ctx || {};
    var path = String(ctx.path || '');
    if (/^\/intent\/(tweet|post)/i.test(path)) {
      var q = String(ctx.search || '');
      var m = /[?&]in_reply_to=(\d{1,25})/.exec(q);
      return m ? { kind: 'comment', target: '', post: m[1] } : { kind: 'post', target: '', post: '' };
    }
    if (ctx.inDialog) {
      // X 的回复弹窗会把被回复的原帖（article[data-testid="tweet"]）放在输入框上方
      if (ctx.dialogHasTweet) {
        var st = statusFrom(ctx.dialogStatusHref);
        return { kind: 'comment', target: st ? st.author : '', post: st ? st.id : '' };
      }
      return { kind: 'post', target: '', post: '' };
    }
    // 帖子详情页下方的内联回复框
    if (ctx.testid === 'tweetButtonInline') {
      var sp = statusFrom(path);
      if (sp) return { kind: 'comment', target: sp.author, post: sp.id };
    }
    return { kind: 'post', target: '', post: '' };
  }

  /* 纯函数：X 弹出的提示是成功还是失败（先认失败，避免「发送失败」被当成功）。 */
  var FAIL_RE = /(wrong|error|failed|try again|already said|over the daily limit|limit|unable|couldn|出错|错误|失败|重试|已经说过|上限|限制|无法|不能)/i;
  var OK_RE = /(was sent|been sent|posted|sent|已发送|已发布|发送成功|发布成功|已回复)/i;
  function toastVerdict(text) {
    var t = String(text || '');
    if (FAIL_RE.test(t)) return 'fail';
    if (OK_RE.test(t)) return 'ok';
    return '';
  }

  /* 纯函数：从增长计划状态里取今天的进度（跨天但还没写过状态时按 0 算） */
  function pad2(n) { return ('0' + n).slice(-2); }
  function beijingDay(t) {
    var d = new Date(Number(t) + 480 * 60000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function progressOf(st, now) {
    st = st && typeof st === 'object' ? st : {};
    var c = st.config || {}, td = st.today || {};
    var same = td.day === beijingDay(now == null ? Date.now() : now);
    return {
      post: same ? Math.max(0, Number(td.post) || 0) : 0,
      comment: same ? Math.max(0, Number(td.comment) || 0) : 0,
      postGoal: Math.max(1, Number(c.postGoal) || 40),
      commentGoal: Math.max(1, Number(c.commentGoal) || 1000),
      on: c.xHints !== false
    };
  }
  /* 纯函数：按钮角标文字。kind = post / comment */
  function hintText(kind, pg) {
    var n = kind === 'comment' ? pg.comment : pg.post;
    var goal = kind === 'comment' ? pg.commentGoal : pg.postGoal;
    var left = Math.max(0, goal - n);
    return left ? { text: '还差 ' + left, left: left, done: false } : { text: '✓ 达标', left: 0, done: true };
  }
  /* 纯函数：发送结果的动态提示文字 */
  function popText(kind, status, res) {
    var label = kind === 'comment' ? '评论' : '发推';
    if (status === 'fail') return { main: '✕', sub: 'X 报错，这条' + label + '不计数', tone: 'fail' };
    if (status !== 'ok') return { main: '?', sub: '没确认到发送结果，这条不计数', tone: 'unknown' };
    var sm = res && res.summary;
    if (res && res.counted === false) return { main: '✓', sub: '已记录（这条之前算过，不重复计数）', tone: 'ok' };
    if (!sm) return { main: '+1', sub: label + ' +1', tone: 'ok' };
    var n = kind === 'comment' ? sm.comment : sm.post;
    var goal = kind === 'comment' ? sm.commentGoal : sm.postGoal;
    var left = Math.max(0, goal - n);
    if (left === 0 && n === goal) return { main: '🎉', sub: '今日' + label + '目标 ' + goal + ' 条达成！', tone: 'goal' };
    if (left === 0) return { main: '+1', sub: label + ' ' + n + ' 条，已超额完成', tone: 'ok' };
    return { main: '+1', sub: label + ' ' + n + '/' + goal + ' · 还差 ' + left, tone: 'ok' };
  }

  var api = { classify: classify, statusFrom: statusFrom, toastVerdict: toastVerdict,
    progressOf: progressOf, hintText: hintText, popText: popText };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TapeGrowthWatch = api;

  // ------------------------------------------------------------ 浏览器侧接线
  if (typeof document === 'undefined' || typeof location === 'undefined') return;
  if (root.__tapeGrowthWatchOn) return;
  root.__tapeGrowthWatchOn = true;
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;

  var SEND_SEL = '[data-testid="tweetButton"],[data-testid="tweetButtonInline"]';
  // 兜底：X 改了 data-testid 时，按「输入区里文字是 回复 / 发帖 的按钮」识别
  var SEND_TEXT_RE = /^(回复|回覆|发帖|發帖|发布|發佈|发送|全部发布|reply|post|post all|tweet)$/i;
  function log(msg, extra) {
    try { console.info('[TapePost 增长计划] ' + msg, extra || ''); } catch (e) {}
  }
  function findSendButton(t) {
    if (!t || !t.closest) return null;
    var b = t.closest(SEND_SEL);
    if (b) return b;
    b = t.closest('button,[role="button"]');
    if (!b) return null;
    var tx = String(b.innerText || b.textContent || '').trim();
    var tid = b.getAttribute('data-testid') || '';
    if (/^tweetButton/i.test(tid)) return b;
    if (!SEND_TEXT_RE.test(tx)) return null;
    return composeScope(b) && editorsIn(composeScope(b)).length ? b : null;
  }
  var EDITOR_SEL = '[data-testid^="tweetTextarea_"]';
  var TOAST_SEL = '[data-testid="toast"],[role="alert"]';
  var POLL_MS = 300, WAIT_MS = 15000, TEXT_MAX = 280;
  var lastAt = 0;
  var pending = [];

  function disabled(btn) {
    return !btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true';
  }

  function contextOf(btn) {
    var dialog = btn.closest && btn.closest('[role="dialog"]');
    var tweet = dialog && dialog.querySelector('article[data-testid="tweet"]');
    var link = tweet && tweet.querySelector('a[href*="/status/"]');
    return {
      path: location.pathname, search: location.search,
      // 不在弹窗里的发送按钮都按「内联输入框」处理（兜底识别出的按钮可能没有 testid）
      testid: dialog ? (btn.getAttribute('data-testid') || '') : 'tweetButtonInline',
      inDialog: !!dialog, dialogHasTweet: !!tweet,
      dialogStatusHref: link ? (link.getAttribute('href') || '') : ''
    };
  }

  // 这个发送按钮所在的输入区：弹窗，或者往上找到包含输入框的最近容器
  function composeScope(btn) {
    var dialog = btn.closest && btn.closest('[role="dialog"]');
    if (dialog) return dialog;
    var el = btn;
    for (var i = 0; i < 15 && el; i++, el = el.parentElement) {
      if (el.querySelector && el.querySelector(EDITOR_SEL)) return el;
    }
    return null;
  }
  function editorsIn(scope) {
    if (!scope || !scope.querySelectorAll) return [];
    return Array.prototype.filter.call(scope.querySelectorAll(EDITOR_SEL), function (n) {
      return /^tweetTextarea_\d+$/.test(n.getAttribute('data-testid') || '');
    });
  }
  function textOf(editors) {
    return editors.map(function (n) { return String(n.innerText || n.textContent || '').trim(); })
      .filter(Boolean).join('\n---\n');
  }
  function toastNodes() {
    return Array.prototype.slice.call(document.querySelectorAll(TOAST_SEL));
  }

  function send(p, status, reason) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;  // 扩展刚重载：静默放弃
      var r = chrome.runtime.sendMessage({ type: 'GROWTH_SENT', kind: p.kind, target: p.target, post: p.post,
        status: status, reason: reason, text: p.text, at: p.at },
        function (res) {
          void (chrome.runtime && chrome.runtime.lastError);
          celebrate(p, status, res);
        });
      if (r && typeof r.catch === 'function') r.catch(function () {});
    } catch (e) {}
  }

  // ------------------------------------------------------------ 按钮角标 + 发送动画（1.5.27）
  // 只在页面最外层加一个固定定位的图层，不改 X 自己的按钮 DOM；pointer-events:none，不挡点击。
  var hintRoot = null, badges = [], hintData = null, layoutQueued = false, mutTimer = 0;
  function ensureRoot() {
    if (!hintRoot || !hintRoot.isConnected) {
      hintRoot = document.createElement('div');
      hintRoot.id = 'tpgHints';
      (document.body || document.documentElement).appendChild(hintRoot);
      badges = [];
    }
    return hintRoot;
  }
  function visibleRect(el) {
    var r = el.getBoundingClientRect && el.getBoundingClientRect();
    if (!r || r.width < 2 || r.height < 2) return null;
    if (r.bottom < 0 || r.top > (root.innerHeight || 9999)) return null;
    return r;
  }
  function layout() {
    layoutQueued = false;
    try {
      if (!hintData || !hintData.on) {
        if (hintRoot) { badges.forEach(function (b) { b.remove(); }); badges = []; }
        return;
      }
      var list = [];
      Array.prototype.forEach.call(document.querySelectorAll(SEND_SEL), function (btn) {
        var r = visibleRect(btn);
        if (r && list.length < 6) list.push({ btn: btn, r: r });
      });
      ensureRoot();
      while (badges.length < list.length) {
        var b = document.createElement('div');
        hintRoot.appendChild(b);
        badges.push(b);
      }
      while (badges.length > list.length) badges.pop().remove();
      list.forEach(function (x, i) {
        var kind = classify(contextOf(x.btn)).kind;
        var h = hintText(kind, hintData);
        var el = badges[i];
        var cls = 'tpg-badge tpg-' + kind + (h.done ? ' tpg-done' : '');
        if (el.className !== cls) el.className = cls;
        if (el.textContent !== h.text) el.textContent = h.text;
        el.style.left = Math.round(x.r.right) + 'px';
        el.style.top = Math.round(x.r.top) + 'px';
      });
    } catch (e) {}
  }
  function queueLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    (root.requestAnimationFrame || setTimeout)(layout);
  }
  function setProgress(st) { stateCache = st || stateCache; hintData = progressOf(stateCache); queueLayout(); }

  function celebrate(p, status, res) {
    try {
      if (res && res.summary && hintData) {
        hintData.post = res.summary.post; hintData.comment = res.summary.comment;
        hintData.postGoal = res.summary.postGoal; hintData.commentGoal = res.summary.commentGoal;
        queueLayout();
      }
      if (hintData && !hintData.on) return;
      var t = popText(p.kind, status, res);
      var r = p.rect || {};
      var x = r.width ? r.left + r.width / 2 : (root.innerWidth || 800) / 2;
      var y = r.height ? r.top - 18 : (root.innerHeight || 600) - 120;   // 起点在角标上方，不和角标重叠
      var pop = document.createElement('div');
      pop.className = 'tpg-pop tpg-' + t.tone;
      var big = document.createElement('b'); big.textContent = t.main;
      var small = document.createElement('span'); small.textContent = t.sub;
      pop.appendChild(big); pop.appendChild(small);
      pop.style.left = Math.round(x) + 'px';
      pop.style.top = Math.round(y) + 'px';
      ensureRoot().appendChild(pop);
      if (t.tone === 'ok' || t.tone === 'goal') {
        var colors = ['#ff8a3d', '#22d3ee', '#a78bfa', '#34d399', '#fbbf24', '#f472b6'];
        var n = t.tone === 'goal' ? 28 : 10;
        for (var i = 0; i < n; i++) {
          var c = document.createElement('i');
          c.className = 'tpg-spark';
          var ang = (Math.PI * 2 * i) / n + Math.random() * 0.4;
          var dist = (t.tone === 'goal' ? 90 : 46) + Math.random() * 40;
          c.style.left = Math.round(x) + 'px';
          c.style.top = Math.round(y) + 'px';
          c.style.background = colors[i % colors.length];
          c.style.setProperty('--dx', Math.round(Math.cos(ang) * dist) + 'px');
          c.style.setProperty('--dy', Math.round(Math.sin(ang) * dist - 20) + 'px');
          hintRoot.appendChild(c);
          setTimeout(function (el) { return function () { el.remove(); }; }(c), 1100);
        }
      }
      setTimeout(function () { pop.remove(); }, t.tone === 'goal' ? 3600 : 2200);
    } catch (e) {}
  }

  try {
    chrome.storage.local.get(['tapeGrowthStateV1'], function (o) {
      void (chrome.runtime && chrome.runtime.lastError);
      setProgress(o && o.tapeGrowthStateV1);
    });
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area === 'local' && ch.tapeGrowthStateV1) setProgress(ch.tapeGrowthStateV1.newValue);
    });
  } catch (e) {}
  // X 是单页应用，按钮随时出现 / 消失：DOM 变化时最多每 250ms 重排一次，滚动和缩放时按帧跟随
  try {
    new MutationObserver(function () {
      if (mutTimer) return;
      mutTimer = setTimeout(function () { mutTimer = 0; queueLayout(); }, 250);
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
  root.addEventListener('scroll', queueLayout, { capture: true, passive: true });
  root.addEventListener('resize', queueLayout, { passive: true });
  setInterval(function () { if (hintData) setProgress(lastState()); }, 60000);   // 过了零点角标归零
  var stateCache = null;
  function lastState() { return stateCache; }
  function finish(p, status, reason) {
    if (p.done) return;
    p.done = true;
    log('结果：' + ({ ok: '发送成功，已计数', fail: '发送失败，不计数', unknown: '未确认，不计数' }[status] || status) +
      '（' + reason + '）');
    clearInterval(p.timer);
    var i = pending.indexOf(p);
    if (i >= 0) pending.splice(i, 1);
    send(p, status, reason);
  }

  // 点了发送之后看 X 的反应：报错提示 → 失败；成功提示 / 输入框清空 / 弹窗关闭 → 成功；
  // 15 秒都没动静 → 记为「未确认」（不计数，只进日志）
  function watch(p) {
    p.timer = setInterval(function () {
      try {
        var toasts = toastNodes().filter(function (n) { return p.before.indexOf(n) < 0; });
        for (var i = 0; i < toasts.length; i++) {
          var tx = String(toasts[i].innerText || toasts[i].textContent || '').trim();
          if (!tx) continue;
          var v = toastVerdict(tx);
          if (v === 'fail') return finish(p, 'fail', tx.slice(0, 80));
          if (v === 'ok') return finish(p, 'ok', 'toast');
        }
        if (p.candidate) return finish(p, 'ok', p.candidate);   // 上一拍已见成功迹象，这一拍也没报错
        var alive = p.editors.filter(function (n) { return n.isConnected; });
        if (p.editors.length && !alive.length) p.candidate = 'closed';
        else if (p.text && alive.length && !textOf(alive)) p.candidate = 'cleared';
        if (Date.now() - p.at > WAIT_MS) finish(p, 'unknown', 'timeout');
      } catch (e) { finish(p, 'unknown', 'error'); }
    }, POLL_MS);
  }

  function report(btn) {
    try {
      if (disabled(btn)) { log('发送按钮当时是禁用状态（没写内容），这次不记录'); return; }
      var now = Date.now();
      if (now - lastAt < 800) return;   // 一次点击同时触发 click + keydown 时只报一次
      lastAt = now;
      if (!chrome.runtime || !chrome.runtime.id) {
        try { console.warn('[TapePost 增长计划] 扩展刚重新加载过，本页的旧脚本已失效：请刷新这个页面后再发，否则这次不会被记录。'); } catch (e) {}
        return;
      }
      var r = classify(contextOf(btn));
      var editors = editorsIn(composeScope(btn));
      var br = btn.getBoundingClientRect ? btn.getBoundingClientRect() : null;
      var p = { kind: r.kind, target: r.target, post: r.post, at: now,
        rect: br ? { left: br.left, top: br.top, width: br.width, height: br.height } : null,
        text: textOf(editors).slice(0, TEXT_MAX), editors: editors, before: toastNodes(),
        candidate: '', done: false, timer: 0 };
      pending.push(p);
      log('检测到点击发送：' + (r.kind === 'comment' ? '评论' : '发推') + (r.target ? ' @' + r.target : '') +
        '，按钮 ' + (btn.getAttribute('data-testid') || '(无 testid)') + '，页面 ' + location.pathname + '，等待 X 的结果…');
      watch(p);
    } catch (e) {}
  }

  // 发推小窗（/intent/tweet）发出后会直接关掉，页面卸载时还没出结果的按成功处理
  root.addEventListener('pagehide', function () {
    pending.slice().forEach(function (p) { var ok = !!p.candidate || location.pathname.indexOf('/intent/') === 0;
      finish(p, ok ? 'ok' : 'unknown', 'unload'); });
  });

  document.addEventListener('click', function (e) {
    var btn = findSendButton(e.target);
    if (btn) report(btn);
  }, true);

  // Ctrl / ⌘ + Enter 快捷发送：找同一个输入区里的发送按钮
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
    var a = document.activeElement;
    if (!a || !a.closest || !a.closest(EDITOR_SEL)) return;
    var scope = a.closest('[role="dialog"]') || a.closest('[data-testid="primaryColumn"]') || document;
    var btn = null, el = a;
    for (var i = 0; i < 12 && el && !btn; i++, el = el.parentElement) {
      btn = el.querySelector ? el.querySelector(SEND_SEL) : null;
    }
    if (!btn) btn = scope.querySelector(SEND_SEL);
    if (btn) report(btn);
    else log('按了 Ctrl/⌘+Enter，但没找到这个输入框对应的发送按钮');
  }, true);
})(typeof globalThis !== 'undefined' ? globalThis : this);
