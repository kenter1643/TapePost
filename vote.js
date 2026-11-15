/*
 * vote.js — $BEM 信仰者每日打卡 / 全网账本（1.5.5）→ 信仰者墙（1.5.6）
 *
 * 「全网记账」实现口径：
 *   · 共享账本是一个公开 REST 服务（默认见 DEFAULT_LEDGER，自托管协议见 vote-ledger/server.js）。
 *     GET  /api/state             → { days, totalVotes, supporters: { day: [名片明细] } }
 *     POST /api/vote              → { day, stance, voterId, name, avatar, quote, at }
 *   · 1.5.6 起必须先连接钱包才能投「支持」；上传的身份 voterId 是「钱包地址 + 日期」
 *     的一次 SHA-256（wallet.js 的 walletVoterId），每天轮换、不可逆。
 *     **明文钱包地址永远不出本机**，账本只拿到哈希。
 *   · 支持票会同时提交一张「信仰者名片」：昵称、内置头像编号、北京时间、随机抽中的
 *     激励话语。这些内容会写进公开账本并在 /vote 页展示；隐私政策已明确说明。
 *   · 同一天同一 voterId 只算一票；改立场是替换而不是累加（服务端实现）。
 *   · 断网 / 未配置账本时自动降级「本机账本」：照常按天累计、算连续打卡，界面明确标注
 *     「本机」，待联网后连同名片一起补投，绝不假装是全网数据。
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
  function beijingClock(nowMs) {
    var d = new Date(Number(nowMs == null ? Date.now() : nowMs) + DAY_TZ_OFFSET_MIN * 60000);
    return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2);
  }
  /* ---------- 1.5.6：信仰者名片 / 激励话语 / 发 X 文案 ---------- */
  var AVATAR_RE = /^a(0[1-9]|[12][0-9]|3[0-2])$/;   // 对应 BemAvatars 的 a01~a32
  function cleanName(raw) {
    var s = String(raw == null ? '' : raw)
      .replace(/[\u0000-\u001f\u007f]/g, '')   // 控制字符一律不留
      .replace(/[<>&]/g, '')                    // 账本页与 X 文案都不需要标签
      .trim();
    var chars = Array.from ? Array.from(s) : s.split('');
    return chars.slice(0, 16).join('');
  }
  function normalizeProfile(raw) {
    var r = isObj(raw) ? raw : {};
    var avatar = String(r.avatar || '').trim();
    if (!AVATAR_RE.test(avatar)) avatar = 'a01';
    return { name: cleanName(r.name), avatar: avatar };
  }
  function defaultName(mask) {
    return cleanName('信仰者 ' + String(mask || '').trim()) || 'BEM 信仰者';
  }
  /* 1.5.18：发到 X 的名片文案末尾不再放账本页链接。账本地址带 sharecode 分享参数，
   * 公开广播既无必要也不合适；改成 Chrome 网上应用店的搜索页，方便别人找到插件。
   * 正式条目链接（/detail/<id>）拿到后只需替换下面这一个常量，调用方不用改。 */
  var STORE_URL = 'https://chromewebstore.google.com/search/TapePost';
  function tweetText(quote, name, day, clock) {
    var head = '\n\n— ' + (cleanName(name) || 'BEM 信仰者') +
      ' · 北京时间 ' + String(day) + ' ' + String(clock) + ' 为 $BEM 打卡';
    var tail = '\n\n#BEM #TapeOut #TapePost\nTapePost信仰者工具 → ' + STORE_URL;
    // postUrl() 会把整段截到 260 字符；先算好话语预算，保证末尾商店链接永不被截断
    var budget = 260 - head.length - tail.length;
    var q = String(quote || '').slice(0, Math.max(0, Math.min(80, budget)));
    return q + head + tail;
  }
  function postUrl(text) {
    return 'https://x.com/intent/tweet?text=' + encodeURIComponent(String(text || '').slice(0, 260));
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

  /* 账本返回的信仰者墙明细；只保留渲染需要的字段，长度一律收敛 */
  function parseSupporters(raw) {
    var out = {};
    Object.keys(isObj(raw) ? raw : {}).forEach(function (d) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Array.isArray(raw[d])) return;
      out[d] = raw[d].slice(0, 200).map(function (r) {
        var x = isObj(r) ? r : {};
        return { voterId: String(x.voterId || '').slice(0, 128),
          name: cleanName(x.name), avatar: AVATAR_RE.test(String(x.avatar || '')) ? x.avatar : 'a01',
          quote: String(x.quote || '').slice(0, 80), at: String(x.at || '').slice(0, 32),
          clock: String(x.clock || '').slice(0, 8), stance: x.stance === 'support' ? 'support' : 'watch',
          day: d };
      }).filter(function (x) { return x.voterId; });
    });
    return out;
  }
  function parseState(json) {
    if (!isObj(json) || json.ok !== true || !isObj(json.days)) return null;
    var days = {};
    Object.keys(json.days).forEach(function (d) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !isObj(json.days[d])) return;
      days[d] = { support: Math.max(0, int(json.days[d].support, 0)),
        watch: Math.max(0, int(json.days[d].watch, 0)) };
    });
    return { days: days, totalVotes: Math.max(0, int(json.totalVotes, 0)),
      version: int(json.version, 1), updatedAt: json.updatedAt || null,
      supporters: parseSupporters(json.supporters) };
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
    var now = nowMs == null ? Date.now() : nowMs;
    var today = dayKey(now);
    var days = mergeDays(s.days, s.localAdd);
    var history = isObj(s.history) ? s.history : {};
    var cfgOn = !!s.ledgerAvailable;
    var profile = normalizeProfile(s.profile);
    var quote = String(s.lastQuote || '').slice(0, 80);
    var page = publicPage(cfg.ledgerBase);
    var clock = s.lastQuoteAt ? beijingClock(Date.parse(s.lastQuoteAt) || now) : beijingClock(now);
    var wall = (isObj(s.supporters) && Array.isArray(s.supporters[today])) ? s.supporters[today] : [];
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
      publicPage: page,
      walletBound: !!s.walletBound,
      profile: profile,
      quote: quote,
      quoteAt: String(s.lastQuoteAt || ''),
      // 1.5.18：发 X 文案不再带账本链接；page 仍用于「🌐 打开全网账本」按钮
      postUrl: quote ? postUrl(tweetText(quote, profile.name, today, clock)) : '',
      supporters: wall
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
    beijingClock: beijingClock,
    AVATAR_RE: AVATAR_RE,
    cleanName: cleanName,
    normalizeProfile: normalizeProfile,
    defaultName: defaultName,
    STORE_URL: STORE_URL,
    tweetText: tweetText,
    postUrl: postUrl,
    parseSupporters: parseSupporters,
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
