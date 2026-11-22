/*
 * TapePost · X 增长计划内核（1.5.26）
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
    maxTargets: 200,                // 推荐清单最多保留多少个大 V
    maxHistoryDays: 90,
    maxDedupeIds: 600,
    maxEvents: 400,
    dedupeWindowMs: 5000            // 没带 ref 时，同类型 5 秒内重复点击只记一次
  };

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
    return { day: day || '', post: 0, comment: 0 };
  }
  function emptyState() {
    return {
      version: 1,
      config: {
        postGoal: DEFAULTS.postGoal,
        commentGoal: DEFAULTS.commentGoal,
        reminderEnabled: true,
        reminderHour: DEFAULTS.reminderHour,
        reminderLastDay: '',
        importedAt: 0
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

  function normalizeConfig(raw) {
    var c = isObj(raw) ? raw : {};
    return {
      postGoal: goalInt(c.postGoal, DEFAULTS.postGoal, 1, 10000),
      commentGoal: goalInt(c.commentGoal, DEFAULTS.commentGoal, 1, 100000),
      reminderEnabled: c.reminderEnabled !== false,
      reminderHour: clampInt(c.reminderHour, DEFAULTS.reminderHour, 0, 23),
      reminderLastDay: String(c.reminderLastDay || ''),
      importedAt: num(c.importedAt, 0)
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
        lastAt: num(t.lastAt, 0)
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
    out.today = isObj(s.today) && s.today.day === day
      ? { day: day, post: Math.max(0, int(s.today.post, 0)), comment: Math.max(0, int(s.today.comment, 0)) }
      : emptyDay(day);
    // 跨天：把昨天的计数留在历史里，今天的计数归零（去重 id / 明细也一起清）
    if (!isObj(s.today) || s.today.day !== day) {
      var old = isObj(s.today) ? s.today : null;
      if (old && old.day && (num(old.post, 0) > 0 || num(old.comment, 0) > 0)) {
        out.history[old.day] = { post: Math.max(0, int(old.post, 0)), comment: Math.max(0, int(old.comment, 0)) };
      }
      out.postIds = []; out.commentIds = []; out.events = [];
    } else {
      out.postIds = clip(s.postIds, DEFAULTS.maxDedupeIds);
      out.commentIds = clip(s.commentIds, DEFAULTS.maxDedupeIds);
      out.events = clip(s.events, DEFAULTS.maxEvents);
    }
    if (isObj(s.history)) {
      Object.keys(s.history).forEach(function (k) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || k === day) return;
        var h = isObj(s.history[k]) ? s.history[k] : {};
        out.history[k] = { post: Math.max(0, int(h.post, 0)), comment: Math.max(0, int(h.comment, 0)) };
      });
      var days = Object.keys(out.history).sort();
      while (days.length > DEFAULTS.maxHistoryDays) delete out.history[days.shift()];
    }
    out.targets = normalizeTargets(s.targets);
    out.updatedAt = num(s.updatedAt, 0);
    return out;
  }

  /* 辅助动作计数。ref 用帖子 id / 账号 handle / 文本摘要，防同一动作重复 +1。
   * 返回值 counted=false 时不改状态（重复点击 / 未知类型）。 */
  function record(state, kind, ref, now, opts) {
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
    s.events.push({ kind: kind, ref: key, at: t, day: s.today.day,
      target: lowerHandle(opts && opts.target) || '' });
    s.events = clip(s.events, DEFAULTS.maxEvents);
    s.updatedAt = t;
    return { state: s, counted: true, reason: 'ok', count: s.today[kind] };
  }

  /* 从 followData.following（本机已采的公开主页资料）筛大 V 作为评论推荐清单。
   * 认证或粉丝 ≥ 阈值即可入选；不读粉丝页、不发请求、不碰登录态。 */
  function isBigV(u, opts) {
    if (!isObj(u)) return false;
    var threshold = int((opts && opts.minBigFollowers), DEFAULTS.minBigFollowers);
    return !!(u.verified || u.blue || num(u.followers, 0) >= threshold);
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
    s.targets = normalizeTargets(s.targets);
    s.updatedAt = t;
    if (added || updated) s.config.importedAt = t;
    return { state: s, added: added, updated: updated, total: s.targets.length };
  }

  function markTargetDone(state, handle, now) {
    var s = normalizeState(state, now);
    var h = lowerHandle(handle);
    var hit = null;
    for (var i = 0; i < s.targets.length; i++) if (s.targets[i].handle === h) { hit = s.targets[i]; break; }
    if (!hit) return { state: s, ok: false };
    hit.done += 1;
    hit.lastAt = nowMs(now);
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
      events: s.events.slice(-30).reverse(),
      targets: s.targets,
      history: s.history,
      config: cfg,
      reminderEnabled: cfg.reminderEnabled,
      updatedAt: s.updatedAt
    };
  }

  /* 监督提醒：北京时间到了设定小时、当天至少一项没达标、当天还没提醒过才响。
   * 返回需要提醒的项目数组（空数组表示不用提醒），调用方负责写 lastDay 去重。 */
  function reminderReasons(state, now) {
    var s = normalizeState(state, now);
    var cfg = s.config;
    if (!cfg.reminderEnabled) return [];
    if (beijingHour(now) < cfg.reminderHour) return [];
    if (cfg.reminderLastDay === s.today.day) return [];
    var out = [];
    if (s.today.post < cfg.postGoal) out.push('post');
    if (s.today.comment < cfg.commentGoal) out.push('comment');
    return out;
  }
  function reminderText(reasons, summaryInfo) {
    var s = summaryInfo || {};
    var parts = [];
    if (reasons.indexOf('post') >= 0) parts.push('发推 ' + (s.post || 0) + '/' + (s.postGoal || 0) + ' 条');
    if (reasons.indexOf('comment') >= 0) parts.push('评论 ' + (s.comment || 0) + '/' + (s.commentGoal || 0) + ' 条');
    return {
      title: 'TapePost · X 增长计划今天还没达标',
      message: parts.join('；') + '。点开任务面板继续补进度。',
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
    markTargetDone: markTargetDone,
    clearTargets: clearTargets,
    summary: summary,
    reminderReasons: reminderReasons,
    reminderText: reminderText
  };
});
