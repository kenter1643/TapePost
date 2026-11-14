/*
 * vote.js — $BEM 信仰者每日打卡 / 全网账本（1.5.5）
 *
 * 「全网记账」实现口径：
 *   · 共享账本是一个公开 REST 服务（默认见 DEFAULT_LEDGER，自托管协议见 vote-ledger/server.js）。
 *     GET  /api/state             → { days: { 'YYYY-MM-DD': { support, watch } }, totalVotes }
 *     POST /api/vote              → { day, stance, voterId } → 返回更新后的 days
 *   · 服务端只收「日期 + 立场 + 当日匿名去重哈希」。voterId 由 wallet.js 用本机随机盐
 *     与日期做 SHA-256 得到，每天轮换，账本无法跨天关联同一个人，更拿不到钱包地址。
 *   · 同一天同一 voterId 只算一票；改立场是替换而不是累加（服务端实现）。
 *   · 断网 / 未配置账本时自动降级「本机账本」：照常按天累计、算连续打卡，界面明确标注
 *     「本机」，待联网后把待同步票补投上去，绝不假装是全网数据。
 *
 * 所有日期按北京时间（UTC+8）切天，保证不同时区的用户看到同一张日账。
 * 纯逻辑：不引用 chrome.*，可在 Node vm 里跑。
 */
'use strict';

var Vote = (function () {
  // 发布出来的共享账本；sharecode 是发布平台给的分享参数，必须随每个请求带上
  var DEFAULT_LEDGER = 'https://tapepost-privacy.app.workbuddy.host/?sharecode=H455VG4B36';
  var DAY_TZ_OFFSET_MIN = 480;   // 北京时间 UTC+8
  var STANCES = ['support', 'watch'];

  var DEFAULT_CONFIG = {
    ledgerBase: DEFAULT_LEDGER,
    reminderEnabled: true,
    reminderHour: 20,            // 北京时间 20:00
    reminderLastDay: ''
  };

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function int(v, fallback) { var n = Number(v); return isFinite(n) ? Math.round(n) : fallback; }

  function dayKey(nowMs, offsetMin) {
    var off = offsetMin == null ? DAY_TZ_OFFSET_MIN : Number(offsetMin);
    var t = Number(nowMs == null ? Date.now() : nowMs) + off * 60000;
    var d = new Date(t);
    return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) +
      '-' + ('0' + d.getUTCDate()).slice(-2);
  }
  function beijingHour(nowMs) {
    return new Date(Number(nowMs == null ? Date.now() : nowMs) + DAY_TZ_OFFSET_MIN * 60000).getUTCHours();
  }
  function shiftDay(day, delta) {
    var p = String(day).split('-');
    var t = Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    var d = new Date(t + delta * 86400000);
    return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) +
      '-' + ('0' + d.getUTCDate()).slice(-2);
  }
  function recentDays(today, n) {
    var out = [];
    for (var i = (n || 7) - 1; i >= 0; i--) out.push(shiftDay(today, -i));
    return out;
  }
  function dayCount(days, day) {
    var d = isObj(days) && isObj(days[day]) ? days[day] : null;
    return {
      support: d ? int(d.support, 0) : 0,
      watch: d ? int(d.watch, 0) : 0
    };
  }
  function tally(days) {
    var support = 0, watch = 0;
    Object.keys(isObj(days) ? days : {}).forEach(function (d) {
      var c = dayCount(days, d);
      support += c.support; watch += c.watch;
    });
    return { support: support, watch: watch, total: support + watch,
      supportPct: (support + watch) ? Math.round(support / (support + watch) * 100) : 0 };
  }
  function trend(days, today, n) {
    return recentDays(today, n || 7).map(function (d) {
      var c = dayCount(days, d);
      return { day: d, support: c.support, watch: c.watch, total: c.support + c.watch };
    });
  }
  /* 连续打卡：今天打过从今天算，今天还没打则从昨天算，不因未到打卡时间就断签 */
  function streak(history, today) {
    var h = isObj(history) ? history : {};
    var cursor = h[today] ? today : shiftDay(today, -1);
    var n = 0;
    while (h[cursor] && STANCES.indexOf(h[cursor]) >= 0) {
      n++;
      cursor = shiftDay(cursor, -1);
      if (n > 3660) break;
    }
    return n;
  }
  function needsCheckin(history, today) {
    return !(isObj(history) && STANCES.indexOf(history[today]) >= 0);
  }

  function normalizeConfig(raw) {
    var r = isObj(raw) ? raw : {};
    return {
      ledgerBase: sanitizeLedger(r.ledgerBase),
      reminderEnabled: r.reminderEnabled !== false,
      reminderHour: Math.max(0, Math.min(23, int(r.reminderHour, DEFAULT_CONFIG.reminderHour))),
      reminderLastDay: String(r.reminderLastDay || '')
    };
  }
  function sanitizeLedger(url) {
    var s = String(url || '').trim();
    if (!s) return DEFAULT_LEDGER;
    if (!/^https?:\/\//i.test(s)) return DEFAULT_LEDGER;
    try {
      var u = new URL(s);
      // 只允许 https；本机自托管调试放行 127.0.0.1 / localhost 的 http
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/i.test(u.hostname))) {
        return DEFAULT_LEDGER;
      }
      return u.toString();
    } catch (e) { return DEFAULT_LEDGER; }
  }
  /* 在保留 sharecode 等查询参数的前提下，把路径换成 /api/state 或 /api/vote */
  function ledgerUrl(base, path) {
    try {
      var u = new URL(sanitizeLedger(base));
      u.pathname = path;
      return u.toString();
    } catch (e) { return DEFAULT_LEDGER; }
  }
  function publicPage(base) { return ledgerUrl(base, '/vote'); }

  function parseState(json) {
    if (!isObj(json) || json.ok !== true || !isObj(json.days)) return null;
    var days = {};
    Object.keys(json.days).forEach(function (d) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !isObj(json.days[d])) return;
      days[d] = { support: Math.max(0, int(json.days[d].support, 0)),
        watch: Math.max(0, int(json.days[d].watch, 0)) };
    });
    return { days: days, totalVotes: Math.max(0, int(json.totalVotes, 0)),
      version: int(json.version, 1), updatedAt: json.updatedAt || null };
  }

  /* 本机票叠加到最后一次全网快照上；只在离线 / 待同步时用到 */
  function mergeDays(remote, localAdd) {
    var out = {}, keys = {};
    Object.keys(isObj(remote) ? remote : {}).forEach(function (d) { keys[d] = 1; });
    Object.keys(isObj(localAdd) ? localAdd : {}).forEach(function (d) { keys[d] = 1; });
    Object.keys(keys).forEach(function (d) {
      var r = dayCount(remote, d), l = dayCount(localAdd, d);
      out[d] = { support: r.support + l.support, watch: r.watch + l.watch };
    });
    return out;
  }

  function summary(state, nowMs) {
    var s = isObj(state) ? state : {};
    var cfg = normalizeConfig(s.config);
    var today = dayKey(nowMs == null ? Date.now() : nowMs);
    var days = mergeDays(s.days, s.localAdd);
    var history = isObj(s.history) ? s.history : {};
    var cfgOn = !!s.ledgerAvailable;
    return {
      today: today,
      days: days,
      todayCount: dayCount(days, today),
      total: tally(days),
      trend: trend(days, today, 7),
      streak: streak(history, today),
      myStance: history[today] || '',
      checkedIn: !needsCheckin(history, today),
      needRemind: needsCheckin(history, today) && cfg.reminderEnabled,
      source: cfgOn ? 'network' : 'local',
      ledgerAvailable: cfgOn,
      pending: Array.isArray(s.pending) ? s.pending.length : 0,
      totalVotes: Math.max(0, int(s.totalVotes, 0)),
      config: cfg,
      publicPage: publicPage(cfg.ledgerBase)
    };
  }

  return {
    DEFAULT_LEDGER: DEFAULT_LEDGER,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    DAY_TZ_OFFSET_MIN: DAY_TZ_OFFSET_MIN,
    STANCES: STANCES,
    isObj: isObj,
    dayKey: dayKey,
    beijingHour: beijingHour,
    shiftDay: shiftDay,
    recentDays: recentDays,
    dayCount: dayCount,
    tally: tally,
    trend: trend,
    streak: streak,
    needsCheckin: needsCheckin,
    normalizeConfig: normalizeConfig,
    sanitizeLedger: sanitizeLedger,
    ledgerUrl: ledgerUrl,
    publicPage: publicPage,
    parseState: parseState,
    mergeDays: mergeDays,
    summary: summary
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Vote;
