/*
 * TapePost · X 增长计划内核（1.5.26 · 1.5.27 真实发送计数 / 大 V 归属 / 节奏）
 * ---------------------------------------------------------------
 * 纯函数模块，不依赖 DOM / chrome.* / 网络，可被三处加载：
 *   1) background.js / growth.js：每日目标、计数、监督提醒、大 V 推荐清单；
 *   2) growth.html 独立面板页：统计卡与明细渲染；
 *   3) Node vm       test-growth.js：离线断言。
 *
 * 隐私边界：只读本机 followData（F注F系分析已采到的公开主页资料），
 * 不发任何请求、不读登录凭证、不写 X 私有接口、不自动发帖/评论/取F。
 * 「自动 +1」只在用户点了扩展提供的「打开发推预填 / 写入回复框」后触发，
 * 代表辅助动作完成，最终是否发送仍由用户在 X 手动决定。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GrowthCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TZ_OFFSET_MIN = 480;          // 北京时间 UTC+8
  var KINDS = ['post', 'comment'];
  var DEFAULTS = {
    postGoal: 40,                   // 每天至少发 40 条 post
    commentGoal: 1000,              // 每天至少写 1000 条评论
    reminderEnabled: true,
    reminderHour: 21,               // 北京时间 21:00 起检查当天是否达标
    minBigFollowers: 10000,         // 与 FollowCore.DEFAULTS.bigFollowers 一致
    verifiedFloorRatio: 0.2,        // 认证账号的粉丝下限 = 阈值 × 0.2（默认 2000）
    maxTargets: 200,                // 推荐清单最多保留多少个大 V
    maxHistoryDays: 90,
    maxDedupeIds: 1500,             // 1.5.27：每天 1000 条评论，600 不够去重
    maxEvents: 1500,                // 1.5.27：同上，明细保留一整天
    dedupeWindowMs: 5000,           // 没带 ref 时，同类型 5 秒内重复点击只记一次
    // 1.5.27：「准备好内容」之后多久内点了 X 的发送按钮，算同一条（只确认、不重复 +1）
    confirmWindowMs: { post: 30 * 60000, comment: 20 * 60000 },
    sendDedupeMs: 4000,             // 同一个发送按钮连点只算一次
    markDedupeMs: 2 * 60000,        // 清单里「手动记一条」与 2 分钟内自动计到的同一对象合并
    paceStartHour: 8,               // 节奏从北京时间 8:00 开始算，到提醒时间应完成全部目标
    paceReminder: true,             // 中途落后提醒（默认开）
    paceBehindRatio: 0.7,           // 实际 < 按节奏应完成 × 70% 才算明显落后
    paceRemindGapMs: 3 * 3600000,   // 落后提醒最多 3 小时一次
    paceFirstHour: 10,              // 10:00 之前不做落后提醒
    maxReminders: 8,                // 每天最多 8 个定时提醒
    // 1.5.27：发送日志（按北京时间每天一个存储键）
    logKeepDays: 90,                // 发送日志（IndexedDB）保留 90 天，与每天计数的 history 一致
    logMaxPerDay: 3000,
    logTextMax: 280
  };
  var LOG_STATUS = ['ok', 'fail', 'unknown'];
  var LOG_PREFIX = 'tapeGrowthLog:';

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function int(v, d) { return Math.round(num(v, d)); }
  function clampInt(v, d, lo, hi) { return Math.max(lo, Math.min(hi, int(v, d))); }
  function goalInt(v, d, lo, hi) {
    var n = Number(v);
    if (!isFinite(n) || n < 1) return d;
    return clampInt(n, d, lo, hi);
  }
  function lowerHandle(s) { return String(s == null ? '' : s).trim().replace(/^@/, '').toLowerCase(); }
  function validHandle(s) { return /^[a-z0-9_]{1,20}$/.test(lowerHandle(s)); }
  function nowMs(now) { return num(now, Date.now()); }

  function dayKey(now, offsetMin) {
    var off = offsetMin == null ? TZ_OFFSET_MIN : num(offsetMin, TZ_OFFSET_MIN);
    var d = new Date(nowMs(now) + off * 60000);
    return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) +
      '-' + ('0' + d.getUTCDate()).slice(-2);
  }
  function beijingHour(now) {
    return new Date(nowMs(now) + TZ_OFFSET_MIN * 60000).getUTCHours();
  }
  function beijingClock(now) {
    var d = new Date(nowMs(now) + TZ_OFFSET_MIN * 60000);
    return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2);
  }

  function emptyDay(day) {
    return { day: day || '', post: 0, comment: 0, postSent: 0, commentSent: 0 };
  }
  function cnt(v) { return Math.max(0, int(v, 0)); }
  function emptyState() {
    return {
      version: 1,
      config: {
        postGoal: DEFAULTS.postGoal,
        commentGoal: DEFAULTS.commentGoal,
        reminderEnabled: true,
        reminderHour: DEFAULTS.reminderHour,
        reminderLastDay: '',
        importedAt: 0,
        paceReminder: DEFAULTS.paceReminder,
        paceLastAt: 0,
        xHints: true
      },
      today: emptyDay(dayKey()),
      history: {},
      postIds: [],
      commentIds: [],
      events: [],
      targets: [],
      updatedAt: 0
    };
  }

  /* 1.5.27：定时提醒。每一条 = 北京时间 HH:MM + 到这个时间应完成目标的百分比。
   * 例如 12:00 / 30%、18:00 / 70%、21:00 / 100%：到点时发推或评论没到该比例就提醒一次。 */
  function pad2(n) { return ('0' + n).slice(-2); }
  function timeOf(v) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? '' : v).trim());
    if (!m) return '';
    var h = int(m[1], -1), mi = int(m[2], -1);
    if (h < 0 || h > 23 || mi < 0 || mi > 59) return '';
    return pad2(h) + ':' + pad2(mi);
  }
  function minutesOf(time) { var t = timeOf(time); return t ? int(t.slice(0, 2), 0) * 60 + int(t.slice(3), 0) : -1; }
  function normalizeReminders(list) {
    var seen = Object.create(null), out = [];
    (Array.isArray(list) ? list : []).forEach(function (r) {
      var x = isObj(r) ? r : { time: r };
      var t = timeOf(x.time);
      if (!t || seen[t]) return;
      seen[t] = true;
      out.push({ time: t, pct: clampInt(x.pct, 100, 1, 100) });
    });
    out.sort(function (a, b) { return minutesOf(a.time) - minutesOf(b.time); });
    return out.slice(0, DEFAULTS.maxReminders);
  }
  function normalizeConfig(raw) {
    var c = isObj(raw) ? raw : {};
    var hour = clampInt(c.reminderHour, DEFAULTS.reminderHour, 0, 23);
    // 旧版只有一个「提醒小时」：迁移成一条 HH:00 / 100% 的定时提醒
    var reminders = Array.isArray(c.reminders) ? normalizeReminders(c.reminders)
      : [{ time: pad2(hour) + ':00', pct: 100 }];
    // 节奏的终点 = 最晚一条提醒的小时（没有提醒时沿用旧的提醒小时）
    if (reminders.length) hour = int(reminders[reminders.length - 1].time.slice(0, 2), hour);
    var lastDay = String(c.reminderLastDay || '');
    var fired = isObj(c.reminderFired) && /^\d{4}-\d{2}-\d{2}$/.test(String(c.reminderFired.day || ''))
      ? { day: String(c.reminderFired.day),
          times: (Array.isArray(c.reminderFired.times) ? c.reminderFired.times : []).map(timeOf).filter(Boolean) }
      : (lastDay ? { day: lastDay, times: reminders.map(function (r) { return r.time; }) } : { day: '', times: [] });
    return {
      postGoal: goalInt(c.postGoal, DEFAULTS.postGoal, 1, 10000),
      commentGoal: goalInt(c.commentGoal, DEFAULTS.commentGoal, 1, 100000),
      reminderEnabled: c.reminderEnabled !== false,
      reminderHour: hour,
      reminders: reminders,
      reminderFired: fired,
      reminderLastDay: lastDay,
      importedAt: num(c.importedAt, 0),
      paceReminder: c.paceReminder !== false,
      paceLastAt: num(c.paceLastAt, 0),
      // 1.5.27：在 X 的发帖 / 回复按钮上显示「还差 N」角标和发送结果动画
      xHints: c.xHints !== false
    };
  }

  function clip(list, max) {
    var a = Array.isArray(list) ? list : [];
    return a.length > max ? a.slice(a.length - max) : a.slice();
  }

  function normalizeTargets(raw) {
    var arr = Array.isArray(raw) ? raw : [];
    var seen = Object.create(null), out = [];
    for (var i = 0; i < arr.length; i++) {
      var t = isObj(arr[i]) ? arr[i] : {};
      var h = lowerHandle(t.handle);
      if (!validHandle(h) || seen[h]) continue;
      seen[h] = true;
      out.push({
        handle: h,
        name: String(t.name || h).slice(0, 80),
        followers: Math.max(0, int(t.followers, 0)),
        reason: String(t.reason || '大 V').slice(0, 20),
        source: String(t.source || 'follow-big').slice(0, 30),
        addedAt: num(t.addedAt, 0),
        done: Math.max(0, int(t.done, 0)),
        lastAt: num(t.lastAt, 0),
        doneDay: String(t.doneDay || ''),       // 1.5.27：今日进度属于哪一天
        todayDone: Math.max(0, int(t.todayDone, 0)),
        manual: !!t.manual                      // 1.5.27：手动添加的对象
      });
    }
    out.sort(function (a, b) { return b.followers - a.followers || a.handle.localeCompare(b.handle); });
    return out.slice(0, DEFAULTS.maxTargets);
  }

  function normalizeState(raw, now) {
    var s = isObj(raw) ? raw : {};
    var t = nowMs(now);
    var day = dayKey(t);
    var out = emptyState();
    out.config = normalizeConfig(s.config);
    out.config.reminderLastDay = String((isObj(s.config) ? s.config.reminderLastDay : '') || '');
    if (out.config.reminderFired.day !== day) out.config.reminderFired = { day: day, times: [] };
    out.today = isObj(s.today) && s.today.day === day
      ? { day: day, post: cnt(s.today.post), comment: cnt(s.today.comment),
          postSent: cnt(s.today.postSent), commentSent: cnt(s.today.commentSent) }
      : emptyDay(day);
    // 跨天：把昨天的计数留在历史里，今天的计数归零（去重 id / 明细也一起清）
    if (!isObj(s.today) || s.today.day !== day) {
      var old = isObj(s.today) ? s.today : null;
      if (old && old.day && (num(old.post, 0) > 0 || num(old.comment, 0) > 0)) {
        // 1.5.27：顺带记下当天的目标，连续达标天数按「当天的目标」判断
        out.history[old.day] = { post: cnt(old.post), comment: cnt(old.comment),
          postSent: cnt(old.postSent), commentSent: cnt(old.commentSent),
          postGoal: out.config.postGoal, commentGoal: out.config.commentGoal };
      }
      out.postIds = []; out.commentIds = []; out.events = [];
    } else {
      out.postIds = clip(s.postIds, DEFAULTS.maxDedupeIds);
      out.commentIds = clip(s.commentIds, DEFAULTS.maxDedupeIds);
      out.events = clip(s.events, DEFAULTS.maxEvents).filter(isObj).map(normalizeEvent);
    }
    if (isObj(s.history)) {
      Object.keys(s.history).forEach(function (k) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || k === day) return;
        var h = isObj(s.history[k]) ? s.history[k] : {};
        var row = { post: cnt(h.post), comment: cnt(h.comment) };
        if (h.postSent != null) row.postSent = cnt(h.postSent);
        if (h.commentSent != null) row.commentSent = cnt(h.commentSent);
        if (h.postGoal != null) row.postGoal = goalInt(h.postGoal, DEFAULTS.postGoal, 1, 10000);
        if (h.commentGoal != null) row.commentGoal = goalInt(h.commentGoal, DEFAULTS.commentGoal, 1, 100000);
        out.history[k] = row;
      });
      var days = Object.keys(out.history).sort();
      while (days.length > DEFAULTS.maxHistoryDays) delete out.history[days.shift()];
    }
    out.targets = normalizeTargets(s.targets);
    out.updatedAt = num(s.updatedAt, 0);
    return out;
  }

  function normalizeEvent(e) {
    return {
      kind: KINDS.indexOf(e.kind) >= 0 ? e.kind : 'post',
      ref: String(e.ref || '').slice(0, 120),
      at: num(e.at, 0), day: String(e.day || ''),
      target: lowerHandle(e.target) || '',
      post: /^\d{1,25}$/.test(String(e.post || '')) ? String(e.post) : '',
      source: ['assist', 'send', 'mark'].indexOf(e.source) >= 0 ? e.source : 'assist',
      sent: !!e.sent, sentAt: num(e.sentAt, 0)
    };
  }

  function findTarget(s, handle) {
    var h = lowerHandle(handle);
    if (!h) return null;
    for (var i = 0; i < s.targets.length; i++) if (s.targets[i].handle === h) return s.targets[i];
    return null;
  }
  /* 1.5.27：评论对象是清单里的大 V 时自动 +1（总数 + 今日数）。 */
  function bumpTarget(s, handle, t) {
    var hit = findTarget(s, handle);
    if (!hit) return false;
    var day = dayKey(t);
    if (hit.doneDay !== day) { hit.doneDay = day; hit.todayDone = 0; }
    hit.done += 1;
    hit.todayDone += 1;
    hit.lastAt = t;
    return true;
  }

  /* 辅助动作计数。ref 用帖子 id / 账号 handle / 文本摘要，防同一动作重复 +1。
   * 返回值 counted=false 时不改状态（重复点击 / 未知类型）。
   * 1.5.27：opts.target = 帖子作者 handle（清单里的大 V 自动记进度），
   *         opts.post = 帖子 id（之后检测到真的点了发送时用来对号，不重复计数）。 */
  /* 1.5.27：「成功了才 +1」。
   *   prepare()   TapePost 把内容准备好（预填发推页 / 写入回复框）：只记一条「待发送」，不计数；
   *   record()    已经确认发出去的一条（旁听到 X 发送成功、清单手动记一条）：计数；
   *   recordSent() 旁听到发送成功时调用：对得上「待发送」就确认它并 +1，对不上就当手写发的 record()。 */
  function prepare(state, kind, ref, now, opts) {
    var s = normalizeState(state, now);
    if (KINDS.indexOf(kind) < 0) return { state: s, counted: false, reason: 'unknown-kind' };
    var t = nowMs(now);
    var key = String(ref == null ? '' : ref).slice(0, 120);
    for (var i = s.events.length - 1; i >= 0; i--) {
      var e = s.events[i];
      if (t - e.at > DEFAULTS.confirmWindowMs[kind]) break;
      if (key && e.ref === key && e.source === 'assist') return { state: s, counted: false, reason: 'duplicate' };
    }
    s.events.push(normalizeEvent({ kind: kind, ref: key, at: t, day: s.today.day,
      target: lowerHandle(opts && opts.target) || '', post: opts && opts.post, source: 'assist',
      sent: false, sentAt: 0 }));
    s.events = clip(s.events, DEFAULTS.maxEvents);
    s.updatedAt = t;
    return { state: s, counted: false, prepared: true, reason: 'prepared' };
  }

  function record(state, kind, ref, now, opts) {
    if (opts && opts.source === 'assist') return prepare(state, kind, ref, now, opts);
    var s = normalizeState(state, now);
    if (KINDS.indexOf(kind) < 0) return { state: s, counted: false, reason: 'unknown-kind' };
    var t = nowMs(now);
    var key = String(ref == null ? '' : ref).slice(0, 120);
    var idsKey = kind + 'Ids';
    if (key && s[idsKey].indexOf(key) >= 0) {
      return { state: s, counted: false, reason: 'duplicate' };
    }
    if (!key) {
      for (var i = s.events.length - 1; i >= 0; i--) {
        var e = s.events[i];
        if (e.kind !== kind) continue;
        if (t - num(e.at, 0) < DEFAULTS.dedupeWindowMs) {
          return { state: s, counted: false, reason: 'too-soon' };
        }
        break;
      }
    }
    s.today[kind] += 1;
    if (key) {
      s[idsKey].push(key);
      s[idsKey] = clip(s[idsKey], DEFAULTS.maxDedupeIds);
    }
    var target = lowerHandle(opts && opts.target) || '';
    var source = (opts && opts.source) || 'send';
    s.today[kind + 'Sent'] += 1;
    s.events.push(normalizeEvent({ kind: kind, ref: key, at: t, day: s.today.day,
      target: target, post: opts && opts.post, source: source, sent: true, sentAt: t }));
    s.events = clip(s.events, DEFAULTS.maxEvents);
    var attributed = kind === 'comment' && bumpTarget(s, target, t);
    s.updatedAt = t;
    return { state: s, counted: true, reason: 'ok', count: s.today[kind], attributed: attributed };
  }

  /* 1.5.27：检测到用户真的点了 X 自己的「发布 / 回复」按钮。
   *   - 最近有一条同类型、还没确认的「准备好内容」记录（评论还要求帖子 id 对得上）
   *     → 只把它标成「已发送」，不重复 +1；
   *   - 否则说明是用户自己手写直接发的 → 记一条（来源 send），并给清单里的大 V 记进度。
   * 扩展只是旁听这次点击，不阻止、不代点、不调任何写接口。 */
  function recordSent(state, kind, ctx, now) {
    var s = normalizeState(state, now);
    if (KINDS.indexOf(kind) < 0) return { state: s, counted: false, reason: 'unknown-kind' };
    var t = nowMs(now);
    var c = isObj(ctx) ? ctx : {};
    var post = /^\d{1,25}$/.test(String(c.post || '')) ? String(c.post) : '';
    var target = lowerHandle(c.target) || '';
    var win = DEFAULTS.confirmWindowMs[kind];
    for (var i = s.events.length - 1; i >= 0; i--) {
      var e = s.events[i];
      if (e.kind !== kind) continue;
      var justSent = (e.source === 'send' && t - e.at < DEFAULTS.sendDedupeMs) ||
        (e.sent && e.sentAt && t - e.sentAt < DEFAULTS.sendDedupeMs);
      if (justSent && (kind === 'post' || !post || e.post === post)) {
        return { state: s, counted: false, reason: 'duplicate-send' };
      }
      if (t - e.at > win) break;
      if (e.sent || e.source !== 'assist') continue;
      if (kind === 'comment' && post && e.post && e.post !== post) continue;
      e.sent = true; e.sentAt = t;
      s.today[kind] += 1;
      s.today[kind + 'Sent'] += 1;
      // 准备时没拿到作者、发送时拿到了：以发送时为准
      if (kind === 'comment' && !e.target && target) e.target = target;
      var attributed = kind === 'comment' && bumpTarget(s, e.target, t);
      s.updatedAt = t;
      return { state: s, counted: true, confirmed: true, reason: 'confirmed', count: s.today[kind],
        attributed: attributed };
    }
    var ref = 'send:' + kind + ':' + (post || '') + ':' + t;
    var r = record(s, kind, ref, t, { target: target, post: post, source: 'send' });
    r.reason = r.counted ? 'manual' : r.reason;
    return r;
  }

  /* 1.5.27：清单里点「手动记一条」——给这个大 V 记进度，同时算一条评论
   * （例如在手机上评论的）。2 分钟内已经自动计到同一对象就只合并、不重复算。 */
  function manualComment(state, handle, now) {
    var s = normalizeState(state, now);
    var t = nowMs(now);
    var hit = findTarget(s, handle);
    if (!hit) return { state: s, ok: false, counted: false, reason: 'no-target' };
    for (var i = s.events.length - 1; i >= 0; i--) {
      var e = s.events[i];
      if (t - e.at > DEFAULTS.markDedupeMs) break;
      if (e.kind === 'comment' && e.target === hit.handle) {
        return { state: s, ok: true, counted: false, reason: 'already-counted', done: hit.done };
      }
    }
    var r = record(s, 'comment', 'mark:' + hit.handle + ':' + t, t,
      { target: hit.handle, source: 'mark' });
    return { state: r.state, ok: true, counted: r.counted, reason: r.reason,
      done: (findTarget(r.state, hit.handle) || {}).done || 0 };
  }

  function addTarget(state, handle, name, now) {
    var s = normalizeState(state, now);
    var h = lowerHandle(handle);
    if (!validHandle(h)) return { state: s, ok: false, reason: 'invalid' };
    if (findTarget(s, h)) return { state: s, ok: false, reason: 'exists' };
    if (s.targets.length >= DEFAULTS.maxTargets) return { state: s, ok: false, reason: 'full' };
    s.targets.push({ handle: h, name: String(name || h).slice(0, 80), followers: 0,
      reason: '手动添加', source: 'manual', addedAt: nowMs(now), done: 0, lastAt: 0,
      doneDay: '', todayDone: 0, manual: true });
    s.targets = normalizeTargets(s.targets);
    s.updatedAt = nowMs(now);
    return { state: s, ok: true };
  }
  function removeTarget(state, handle, now) {
    var s = normalizeState(state, now);
    var h = lowerHandle(handle);
    var before = s.targets.length;
    s.targets = s.targets.filter(function (x) { return x.handle !== h; });
    s.updatedAt = nowMs(now);
    return { state: s, ok: s.targets.length < before };
  }

  /* 1.5.27：今日推荐顺序——今天还没评过的优先，其次最久没评的，再按粉丝数。
   * 这样每天轮着来，不会天天只盯着粉丝最多的那几个。 */
  function recommendTargets(targets, day, limit) {
    var arr = (targets || []).map(function (x) {
      var today = x.doneDay === day ? x.todayDone : 0;
      return Object.assign({}, x, { todayDone: today });
    });
    arr.sort(function (a, b) {
      return (a.todayDone > 0) - (b.todayDone > 0) ||
        (a.lastAt || 0) - (b.lastAt || 0) ||
        b.followers - a.followers || a.handle.localeCompare(b.handle);
    });
    return limit ? arr.slice(0, limit) : arr;
  }

  function dayMet(h, cfg) {
    var pg = h.postGoal || cfg.postGoal, cg = h.commentGoal || cfg.commentGoal;
    return h.post >= pg && h.comment >= cg;
  }
  /* 连续达标天数：从昨天往前数两项都达标的天数；今天已达标再 +1。 */
  function streak(state, now) {
    var s = normalizeState(state, now);
    var t = nowMs(now), n = 0;
    for (var i = 1; i <= DEFAULTS.maxHistoryDays; i++) {
      var h = s.history[dayKey(t - i * 86400000)];
      if (!h || !dayMet(h, s.config)) break;
      n++;
    }
    var todayMet = s.today.post >= s.config.postGoal && s.today.comment >= s.config.commentGoal;
    return { days: n + (todayMet ? 1 : 0), todayMet: todayMet };
  }

  /* 节奏：北京时间 8:00 → 提醒时间线性分配目标，算出「此刻应完成多少」。 */
  function pace(state, now) {
    var s = normalizeState(state, now);
    var cfg = s.config;
    var d = new Date(nowMs(now) + TZ_OFFSET_MIN * 60000);
    var hour = d.getUTCHours() + d.getUTCMinutes() / 60;
    var startH = DEFAULTS.paceStartHour, endH = Math.max(startH + 1, cfg.reminderHour);
    var frac = Math.max(0, Math.min(1, (hour - startH) / (endH - startH)));
    var exp = function (goal) { return Math.round(goal * frac); };
    var ep = exp(cfg.postGoal), ec = exp(cfg.commentGoal);
    return {
      fraction: Math.round(frac * 1000) / 1000,
      expectedPost: ep, expectedComment: ec,
      behindPost: Math.max(0, ep - s.today.post),
      behindComment: Math.max(0, ec - s.today.comment),
      postBehind: s.today.post < ep * DEFAULTS.paceBehindRatio,
      commentBehind: s.today.comment < ec * DEFAULTS.paceBehindRatio,
      // 剩余时间里每小时还要完成多少
      perHourPost: Math.ceil(Math.max(0, cfg.postGoal - s.today.post) / Math.max(1, endH - Math.max(hour, startH))),
      perHourComment: Math.ceil(Math.max(0, cfg.commentGoal - s.today.comment) / Math.max(1, endH - Math.max(hour, startH)))
    };
  }

  /* 中途落后提醒：10:00 起、提醒时间之前，明显落后节奏时最多 3 小时提醒一次。 */
  function paceReminderReasons(state, now) {
    var s = normalizeState(state, now);
    var cfg = s.config;
    if (!cfg.reminderEnabled || !cfg.paceReminder) return [];
    var h = beijingHour(now);
    if (h < DEFAULTS.paceFirstHour || h >= cfg.reminderHour) return [];
    if (nowMs(now) - cfg.paceLastAt < DEFAULTS.paceRemindGapMs) return [];
    var p = pace(s, now), out = [];
    if (p.postBehind && s.today.post < cfg.postGoal) out.push('post');
    if (p.commentBehind && s.today.comment < cfg.commentGoal) out.push('comment');
    return out;
  }
  function paceReminderText(reasons, summaryInfo) {
    var s = summaryInfo || {};
    var p = s.pace || {};
    var parts = [];
    if (reasons.indexOf('post') >= 0) {
      parts.push('发推 ' + (s.post || 0) + ' 条，按节奏此刻应到 ' + (p.expectedPost || 0) + ' 条');
    }
    if (reasons.indexOf('comment') >= 0) {
      parts.push('评论 ' + (s.comment || 0) + ' 条，按节奏此刻应到 ' + (p.expectedComment || 0) + ' 条');
    }
    return {
      title: 'TapePost · X 增长计划进度落后了',
      message: parts.join('；') + '。点开看今天该评论谁。',
      contextMessage: '查看增长计划 · TapePost'
    };
  }

  /* 从 followData.following（本机已采的公开主页资料）筛大 V 作为评论推荐清单。
   * 认证或粉丝 ≥ 阈值即可入选；不读粉丝页、不发请求、不碰登录态。 */
  /* 1.5.27：只有蓝标（付费订阅）不算大 V。X 的 verified 字段里混着 is_blue_verified，
   * 旧版凡是带蓝标就入选，几百粉的订阅号也进了「大 V 评论清单」，评论他们几乎没有曝光。
   * 现在：粉丝 ≥ 阈值；或认证且粉丝 ≥ 阈值的 1/5（默认 2000）。 */
  function isBigV(u, opts) {
    if (!isObj(u)) return false;
    var threshold = int((opts && opts.minBigFollowers), DEFAULTS.minBigFollowers);
    var f = num(u.followers, 0);
    if (f >= threshold) return true;
    return !!(u.verified || u.blue) && f >= Math.round(threshold * DEFAULTS.verifiedFloorRatio);
  }
  function importBigV(state, followData, now, opts) {
    var s = normalizeState(state, now);
    var d = isObj(followData) ? followData : {};
    var following = isObj(d.following) ? d.following : {};
    var t = nowMs(now);
    var existing = Object.create(null);
    s.targets.forEach(function (x) { existing[x.handle] = x; });
    var added = 0, updated = 0;
    Object.keys(following).forEach(function (k) {
      var u = following[k];
      var h = lowerHandle(k || (isObj(u) && u.handle));
      if (!validHandle(h) || !isBigV(u, opts)) return;
      var followers = Math.max(0, int(isObj(u) && u.followers, 0));
      var verified = !!(isObj(u) && (u.verified || u.blue));
      var reason = verified && followers >= int(opts && opts.minBigFollowers, DEFAULTS.minBigFollowers)
        ? '认证大 V' : (verified ? '认证账号' : '大 V');
      if (existing[h]) {
        var old = existing[h];
        if (followers !== old.followers || reason !== old.reason) {
          old.followers = followers; old.reason = reason;
          updated++;
        }
        return;
      }
      var target = {
        handle: h, name: String((isObj(u) && u.name) || h).slice(0, 80),
        followers: followers, reason: reason, source: 'follow-big',
        addedAt: t, done: 0, lastAt: 0
      };
      existing[h] = target;
      s.targets.push(target);
      added++;
    });
    // 已经在互F管理里取F（或全量扫描确认已不在F注列表）的大 V 从清单里拿掉；
    // 手动添加的对象和仍在F注列表里的不动。只认墓碑，不因为名单没采全就误删。
    var gone = isObj(d.gone) && isObj(d.gone.following) ? d.gone.following : {};
    var removed = 0;
    s.targets = s.targets.filter(function (x) {
      if (x.manual || x.source === 'manual' || following[x.handle]) return true;
      if (num(gone[x.handle], 0) > 0) { removed++; return false; }
      return true;
    });
    s.targets = normalizeTargets(s.targets);
    s.updatedAt = t;
    if (added || updated || removed) s.config.importedAt = t;
    return { state: s, added: added, updated: updated, removed: removed, total: s.targets.length };
  }

  function markTargetDone(state, handle, now) {
    var s = normalizeState(state, now);
    var hit = findTarget(s, handle);
    if (!hit) return { state: s, ok: false };
    bumpTarget(s, hit.handle, nowMs(now));
    s.updatedAt = hit.lastAt;
    return { state: s, ok: true, done: hit.done };
  }

  function clearTargets(state, now) {
    var s = normalizeState(state, now);
    s.targets = [];
    s.config.importedAt = 0;
    s.updatedAt = nowMs(now);
    return s;
  }

  /* 按原顺序倒着取，每种类型最多 limit 条（最近在前）。 */
  function recentPerKind(events, limit) {
    var left = { post: limit, comment: limit }, out = [];
    for (var i = events.length - 1; i >= 0; i--) {
      var k = events[i].kind;
      if (left[k] > 0) { left[k]--; out.push(events[i]); }
    }
    return out;
  }

  /* 准备好了、在确认窗口内还没检测到发送成功的条数 */
  function pendingOf(events, kind, now) {
    var t = nowMs(now), n = 0;
    for (var i = events.length - 1; i >= 0; i--) {
      var e = events[i];
      if (t - e.at > DEFAULTS.confirmWindowMs.post) break;
      if (e.kind === kind && e.source === 'assist' && !e.sent && t - e.at <= DEFAULTS.confirmWindowMs[kind]) n++;
    }
    return n;
  }

  /* ---------- 1.5.27 发送日志（纯函数；存储由后台负责） ---------- */
  function logKey(day) { return LOG_PREFIX + day; }
  function logEntry(input, now) {
    var x = isObj(input) ? input : {};
    var t = nowMs(now);
    var at = num(x.at, t);
    if (!(at > t - 120000 && at <= t + 5000)) at = t;   // 页面传来的时间只信最近 2 分钟内的
    var text = String(x.text == null ? '' : x.text).replace(/\r/g, '');
    return {
      at: at, day: dayKey(at), clock: beijingClock(at),
      kind: KINDS.indexOf(x.kind) >= 0 ? x.kind : 'post',
      status: LOG_STATUS.indexOf(x.status) >= 0 ? x.status : 'unknown',
      reason: String(x.reason || '').slice(0, 80),
      source: ['send', 'mark'].indexOf(x.source) >= 0 ? x.source : 'send',
      target: lowerHandle(x.target) || '',
      post: /^\d{1,25}$/.test(String(x.post || '')) ? String(x.post) : '',
      text: text.length > DEFAULTS.logTextMax ? text.slice(0, DEFAULTS.logTextMax) + '…' : text,
      counted: !!x.counted, confirmed: !!x.confirmed
    };
  }
  function appendLog(list, entry) {
    var a = Array.isArray(list) ? list.filter(isObj) : [];
    a.push(entry);
    return a.length > DEFAULTS.logMaxPerDay ? a.slice(a.length - DEFAULTS.logMaxPerDay) : a;
  }
  /* 日志天数索引：加入今天、按新到旧排序，返回 { keep, drop } */
  function logDays(days, day, keep) {
    var set = Object.create(null);
    (Array.isArray(days) ? days : []).concat(day ? [day] : []).forEach(function (d) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(d))) set[d] = true;
    });
    var all = Object.keys(set).sort().reverse();
    var k = Math.max(1, int(keep, DEFAULTS.logKeepDays));
    return { keep: all.slice(0, k), drop: all.slice(k) };
  }
  function logStats(list) {
    var o = { ok: 0, fail: 0, unknown: 0, post: 0, comment: 0 };
    (Array.isArray(list) ? list : []).forEach(function (e) {
      if (!isObj(e)) return;
      if (o[e.status] != null) o[e.status]++;
      if (e.status === 'ok' && o[e.kind] != null) o[e.kind]++;
    });
    return o;
  }

  /* ---------- 1.5.27 发送日志数据库（IndexedDB，扩展自己的本地数据库） ----------
   * 刷新页面、重启浏览器、重新加载扩展都不会丢；只有卸载扩展或在面板里点「清空日志」才删除。
   * factory = indexedDB，keyRange = IDBKeyRange（由调用方传入，便于测试）。 */
  var LOG_DB_NAME = 'tapepost-growth', LOG_DB_STORE = 'sendLog';
  function createLogDB(factory, keyRange) {
    var dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        var r;
        try { r = factory.open(LOG_DB_NAME, 1); } catch (e) { dbp = null; reject(e); return; }
        r.onupgradeneeded = function () {
          var db = r.result;
          if (!db.objectStoreNames.contains(LOG_DB_STORE)) {
            var os = db.createObjectStore(LOG_DB_STORE, { keyPath: 'id', autoIncrement: true });
            os.createIndex('day', 'day', { unique: false });
            os.createIndex('at', 'at', { unique: false });
          }
        };
        r.onsuccess = function () {
          var db = r.result;
          db.onversionchange = function () { try { db.close(); } catch (e) {} dbp = null; };
          db.onclose = function () { dbp = null; };
          resolve(db);
        };
        r.onerror = function () { dbp = null; reject(r.error || new Error('open failed')); };
        r.onblocked = function () { dbp = null; reject(new Error('open blocked')); };
      });
      return dbp;
    }
    function run(mode, body) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(LOG_DB_STORE, mode);
          var out = { value: undefined };
          t.oncomplete = function () { resolve(out.value); };
          t.onerror = function () { reject(t.error || new Error('tx failed')); };
          t.onabort = function () { reject(t.error || new Error('tx aborted')); };
          body(t.objectStore(LOG_DB_STORE), out);
        });
      });
    }
    return {
      name: LOG_DB_NAME,
      add: function (entries) {
        return run('readwrite', function (os, out) {
          out.value = 0;
          (Array.isArray(entries) ? entries : [entries]).forEach(function (e) {
            if (!isObj(e)) return;
            var c = Object.assign({}, e);
            delete c.id;
            os.add(c);
            out.value++;
          });
        });
      },
      byDay: function (day) {
        return run('readonly', function (os, out) {
          out.value = [];
          var r = os.index('day').getAll(String(day || ''));
          r.onsuccess = function () {
            out.value = (r.result || []).sort(function (a, b) { return (a.at - b.at) || (a.id - b.id); });
          };
        });
      },
      days: function () {
        return run('readonly', function (os, out) {
          var list = out.value = [];
          var r = os.index('day').openKeyCursor(null, 'prevunique');
          r.onsuccess = function () { var c = r.result; if (c) { list.push(c.key); c.continue(); } };
        });
      },
      count: function () {
        return run('readonly', function (os, out) {
          var r = os.count();
          r.onsuccess = function () { out.value = r.result || 0; };
        });
      },
      pruneBefore: function (at) {
        return run('readwrite', function (os, out) {
          out.value = 0;
          var r = os.index('at').openCursor(keyRange.upperBound(num(at, 0), true));
          r.onsuccess = function () { var c = r.result; if (c) { c.delete(); out.value++; c.continue(); } };
        });
      },
      clear: function () { return run('readwrite', function (os) { os.clear(); }); }
    };
  }

  function summary(state, now) {
    var s = normalizeState(state, now);
    var cfg = s.config;
    var pct = function (n, goal) { return goal > 0 ? Math.min(100, Math.round(n * 1000 / goal) / 10) : 0; };
    return {
      day: s.today.day,
      clock: beijingClock(now),
      post: s.today.post, comment: s.today.comment,
      postGoal: cfg.postGoal, commentGoal: cfg.commentGoal,
      postPct: pct(s.today.post, cfg.postGoal),
      commentPct: pct(s.today.comment, cfg.commentGoal),
      postDone: s.today.post >= cfg.postGoal,
      commentDone: s.today.comment >= cfg.commentGoal,
      targetCount: s.targets.length,
      // 每种各留最近 200 条：一天上千条评论时，发推明细不会被挤没
      events: recentPerKind(s.events, 200),
      targets: s.targets,
      // 1.5.27
      postSent: s.today.postSent, commentSent: s.today.commentSent,
      postPending: pendingOf(s.events, 'post', now), commentPending: pendingOf(s.events, 'comment', now),
      recommended: recommendTargets(s.targets, s.today.day, 30),
      targetsTouchedToday: s.targets.filter(function (x) { return x.doneDay === s.today.day && x.todayDone > 0; }).length,
      streak: streak(s, now),
      pace: pace(s, now),
      history: s.history,
      config: cfg,
      reminderEnabled: cfg.reminderEnabled,
      nextReminderAt: nextReminderAt(s, now),
      updatedAt: s.updatedAt
    };
  }

  /* 定时提醒：找出「已经到点、今天还没处理过」的提醒（浏览器关着错过了几个时，只取最晚那个，
   * 其余一起标记为已处理，不连发）。到点时实际 < 目标 × 百分比的项目才提醒。
   * 返回 null 表示没有到点的提醒；返回对象时调用方用 markReminders(covers) 记下已处理。 */
  function dueReminder(state, now) {
    var s = normalizeState(state, now);
    var cfg = s.config;
    if (!cfg.reminderEnabled || !cfg.reminders.length) return null;
    var d = new Date(nowMs(now) + TZ_OFFSET_MIN * 60000);
    var cur = d.getUTCHours() * 60 + d.getUTCMinutes();
    var fired = cfg.reminderFired.times;
    var covers = cfg.reminders.filter(function (r) { return minutesOf(r.time) <= cur && fired.indexOf(r.time) < 0; });
    if (!covers.length) return null;
    var r = covers[covers.length - 1];
    var ep = Math.ceil(cfg.postGoal * r.pct / 100), ec = Math.ceil(cfg.commentGoal * r.pct / 100);
    var reasons = [];
    if (s.today.post < ep) reasons.push('post');
    if (s.today.comment < ec) reasons.push('comment');
    return { time: r.time, pct: r.pct, expectedPost: ep, expectedComment: ec, reasons: reasons,
      covers: covers.map(function (x) { return x.time; }) };
  }
  function markReminders(state, times, now) {
    var s = normalizeState(state, now);
    var f = s.config.reminderFired;
    (times || []).forEach(function (t) { t = timeOf(t); if (t && f.times.indexOf(t) < 0) f.times.push(t); });
    if (s.config.reminders.every(function (r) { return f.times.indexOf(r.time) >= 0; })) s.config.reminderLastDay = s.today.day;
    return s;
  }
  /* 改了提醒设置后：已经过去的时间点今天不再补响，只等之后的。 */
  function skipPastReminders(state, now) {
    var d = new Date(nowMs(now) + TZ_OFFSET_MIN * 60000);
    var cur = d.getUTCHours() * 60 + d.getUTCMinutes();
    var s = normalizeState(state, now);
    s.config.reminderFired = { day: s.today.day, times: [] };
    s.config.reminderLastDay = '';
    var past = s.config.reminders.filter(function (r) { return minutesOf(r.time) < cur; }).map(function (r) { return r.time; });
    return markReminders(s, past, now);
  }
  /* 下一次定时提醒的时间戳（毫秒），给后台设精确闹钟；没有提醒时返回 0 */
  function nextReminderAt(state, now) {
    var s = normalizeState(state, now);
    var cfg = s.config;
    if (!cfg.reminderEnabled || !cfg.reminders.length) return 0;
    var t = nowMs(now);
    var off = TZ_OFFSET_MIN * 60000;
    var dayStart = t - ((t + off) % 86400000 + 86400000) % 86400000;   // 北京时间当天 0:00
    for (var i = 0; i < cfg.reminders.length; i++) {
      var r = cfg.reminders[i];
      var at = dayStart + minutesOf(r.time) * 60000;
      if (at > t && cfg.reminderFired.times.indexOf(r.time) < 0) return at;
    }
    return dayStart + 86400000 + minutesOf(cfg.reminders[0].time) * 60000;
  }
  /* 兼容旧接口：只返回需要提醒的项目 */
  function reminderReasons(state, now) {
    var due = dueReminder(state, now);
    return due ? due.reasons : [];
  }
  function reminderText(reasons, summaryInfo, due) {
    var s = summaryInfo || {};
    var parts = [];
    var dp = due && due.pct < 100;
    if (reasons.indexOf('post') >= 0) parts.push('发推 ' + (s.post || 0) + '/' + (dp ? due.expectedPost : (s.postGoal || 0)) + ' 条');
    if (reasons.indexOf('comment') >= 0) parts.push('评论 ' + (s.comment || 0) + '/' + (dp ? due.expectedComment : (s.commentGoal || 0)) + ' 条');
    var head = due ? '北京时间 ' + due.time + (dp ? '，应完成今日目标的 ' + due.pct + '%' : '') + '：' : '';
    return {
      title: due && dp ? 'TapePost · X 增长计划还没到 ' + due.time + ' 的进度' : 'TapePost · X 增长计划今天还没达标',
      message: head + parts.join('；') + '。点开任务面板继续补进度。',
      contextMessage: '查看增长计划 · TapePost'
    };
  }

  return {
    DEFAULTS: DEFAULTS,
    KINDS: KINDS,
    TZ_OFFSET_MIN: TZ_OFFSET_MIN,
    dayKey: dayKey,
    beijingHour: beijingHour,
    beijingClock: beijingClock,
    emptyState: emptyState,
    normalizeState: normalizeState,
    normalizeConfig: normalizeConfig,
    isBigV: isBigV,
    importBigV: importBigV,
    record: record,
    prepare: prepare,
    logKey: logKey,
    logEntry: logEntry,
    appendLog: appendLog,
    logDays: logDays,
    logStats: logStats,
    LOG_PREFIX: LOG_PREFIX,
    createLogDB: createLogDB,
    markTargetDone: markTargetDone,
    clearTargets: clearTargets,
    summary: summary,
    reminderReasons: reminderReasons,
    dueReminder: dueReminder,
    markReminders: markReminders,
    skipPastReminders: skipPastReminders,
    nextReminderAt: nextReminderAt,
    normalizeReminders: normalizeReminders,
    reminderText: reminderText,
    // 1.5.27
    recordSent: recordSent,
    manualComment: manualComment,
    addTarget: addTarget,
    removeTarget: removeTarget,
    recommendTargets: recommendTargets,
    streak: streak,
    pace: pace,
    paceReminderReasons: paceReminderReasons,
    paceReminderText: paceReminderText
  };
});
