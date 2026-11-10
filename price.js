/*
 * price.js — TapeOut 行情数据层（popup / background / test-harness 共用）
 *
 * 1.4.13：面板顶端展示三项实时价格，并支持上下限提醒。
 * 数据来源全部是公开只读接口，不需要登录、不需要 API Key、不上传任何用户数据：
 *   · Firsto 官方 analytics：/v1/analytics/bem        → $BEM 现价（USD，8 位定点）
 *   · Firsto 官方 analytics：/v1/analytics/circuits   → 矿机日产能价（BNB，wei 18 位定点，与官网图表 ds() 一致）
 *   · DexScreener 公开行情：/latest/dex/tokens/0xEd99… → TapeUP $UP 现价（USD）
 *
 * 这个模块刻意不引用任何 chrome.* API：后台用 importScripts 加载，
 * 弹窗用 <script> 加载，Node 测试用 vm 加载，三处跑的是同一份纯逻辑。
 */
'use strict';

var TapePrice = (function () {
  var FIRSTO_API = 'https://api-tapeout.firsto.ai';
  var UP_CONTRACT = '0xEd99445d72787Adb627cD8588586984DF548CD2F'; // BSC · TapeUP (UP)

  var ENDPOINTS = {
    bem: FIRSTO_API + '/v1/analytics/bem?range=24h',
    miner: FIRSTO_API + '/v1/analytics/circuits?range=24h',
    up: 'https://api.dexscreener.com/latest/dex/tokens/' + UP_CONTRACT
  };

  // 点击卡片 / 点击提醒弹窗要去的交易所页面
  var LINKS = {
    up: 'https://firsto.ai/data',
    miner: 'https://firsto.ai/data/circuits',
    bem: 'https://firsto.ai/data/bem',
    home: 'https://firsto.ai/'
  };

  var META = {
    up:    { label: 'TapeUP', symbol: '$UP', unit: 'USD', digits: 4, prefix: '$' },
    miner: { label: '矿机日产价', symbol: 'TapeOut', unit: 'BNB', digits: 3, prefix: '' },
    bem:   { label: 'BEM', symbol: '$BEM', unit: 'USD', digits: 2, prefix: '$' }
  };
  var KEYS = ['up', 'miner', 'bem'];

  var DEFAULT_SETTINGS = {
    enabled: true,           // 提醒总开关（不填任何阈值时不会触发）
    pollMinutes: 5,          // 后台检查间隔
    cooldownMinutes: 30,     // 二次保险：状态变化后的最短提醒间隔
    toast: true,             // 网页右下角浮层
    notify: true,            // 系统通知（没开网页也能提醒）
    bounds: {
      up:    { min: '', max: '' },
      miner: { min: '', max: '' },
      bem:   { min: '', max: '' }
    }
  };

  var POLL_OPTIONS = [1, 5, 15, 30];
  var COOLDOWN_OPTIONS = [5, 15, 30, 60];

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function num(v) {
    if (v == null || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  /* 链上定点数：字符串 → 人类可读数值。wei 用 Number 会有末位精度损失，
   * 但展示只保留 3 位小数，误差远小于 0.001，不影响阈值判断。 */
  function atomic(v, decimals) {
    if (v == null || v === '') return null;
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return null;
    return n / Math.pow(10, decimals);
  }

  function normalizeSettings(raw) {
    var r = isObj(raw) ? raw : {};
    var s = {
      enabled: r.enabled !== false,
      pollMinutes: num(r.pollMinutes),
      cooldownMinutes: num(r.cooldownMinutes),
      toast: r.toast !== false,
      notify: r.notify !== false,
      bounds: {}
    };
    if (POLL_OPTIONS.indexOf(s.pollMinutes) < 0) s.pollMinutes = DEFAULT_SETTINGS.pollMinutes;
    if (COOLDOWN_OPTIONS.indexOf(s.cooldownMinutes) < 0) s.cooldownMinutes = DEFAULT_SETTINGS.cooldownMinutes;
    var rb = isObj(r.bounds) ? r.bounds : {};
    KEYS.forEach(function (k) {
      var b = isObj(rb[k]) ? rb[k] : {};
      var lo = num(b.min), hi = num(b.max);
      // 下限 >= 上限属于无效配置，直接忽略，避免每一轮都同时触发两种提醒
      if (lo != null && hi != null && lo >= hi) { lo = null; hi = null; }
      s.bounds[k] = {
        min: (lo == null || lo < 0) ? '' : String(lo),
        max: (hi == null || hi < 0) ? '' : String(hi)
      };
    });
    return s;
  }

  /* ---------- 三个接口的解析（纯函数，便于测试） ---------- */

  function parseBem(json) {
    if (!isObj(json) || !isObj(json.metrics)) return null;
    var price = atomic(json.metrics.priceUsdAtomic, 8);
    if (price == null) return null;
    var points = (isObj(json.market) && Array.isArray(json.market.points)) ? json.market.points : [];
    var first = null;
    for (var i = 0; i < points.length; i++) {
      first = atomic(points[i] && points[i].priceUsdAtomic, 8);
      if (first != null) break;
    }
    return {
      key: 'bem', value: price,
      changePct: (first != null && first > 0) ? (price - first) / first * 100 : null,
      asOf: json.asOf || null, source: 'Firsto analytics'
    };
  }

  function parseMiner(json) {
    if (!isObj(json) || !Array.isArray(json.series)) return null;
    var vals = [];
    json.series.forEach(function (row) {
      // 真实接口里常见 all 对象存在但 dailyCapacityPriceWei 为 null，
      // 这时 tapeout 分段可能仍有样本；必须先判值再回退，不能只看对象是否存在。
      var allVal = isObj(row) && isObj(row.all) ? atomic(row.all.dailyCapacityPriceWei, 18) : null;
      var tapeVal = isObj(row) && isObj(row.tapeout) ? atomic(row.tapeout.dailyCapacityPriceWei, 18) : null;
      var v = allVal != null ? allVal : tapeVal;
      if (v != null) vals.push(v);
    });
    if (!vals.length) return null; // 最近 24h 没有成交样本
    var last = vals[vals.length - 1], first = vals[0];
    return {
      key: 'miner', value: last,
      changePct: (first > 0) ? (last - first) / first * 100 : null,
      asOf: json.asOf || null, source: 'Firsto analytics'
    };
  }

  function parseUp(json) {
    if (!isObj(json) || !Array.isArray(json.pairs)) return null;
    var pairs = json.pairs.filter(function (p) {
      return isObj(p) && isObj(p.baseToken) && p.baseToken.symbol === 'UP' && num(p.priceUsd) != null;
    });
    // 同一个币可能有多个池子：取流动性最深的那个，避免被极小池子的报价带偏
    pairs.sort(function (a, b) {
      var la = isObj(a.liquidity) ? (num(a.liquidity.usd) || 0) : 0;
      var lb = isObj(b.liquidity) ? (num(b.liquidity.usd) || 0) : 0;
      return lb - la;
    });
    if (!pairs.length) return null;
    var p = pairs[0];
    var chg = (isObj(p.priceChange)) ? num(p.priceChange.h24) : null;
    return {
      key: 'up', value: num(p.priceUsd), changePct: chg,
      asOf: null, source: 'DexScreener'
    };
  }

  var PARSERS = { bem: parseBem, miner: parseMiner, up: parseUp };

  /* ---------- 抓取 ---------- */

  function getJson(fetchImpl, url) {
    var opts = { cache: 'no-store', headers: { Accept: 'application/json' } };
    var timer = null, controller = null;
    if (typeof AbortController !== 'undefined') {
      controller = new AbortController();
      opts.signal = controller.signal;
      timer = setTimeout(function () { try { controller.abort(); } catch (e) {} }, 12000);
    }
    return Promise.resolve()
      .then(function () { return fetchImpl(url, opts); })
      .then(function (res) {
        if (!res || res.ok === false) throw new Error('HTTP ' + (res && res.status));
        return res.json();
      })
      .then(function (j) { return { ok: true, json: j }; })
      .catch(function (e) { return { ok: false, error: String(e && e.message || e) }; })
      .then(function (out) { if (timer) clearTimeout(timer); return out; });
  }

  /*
   * 三项并发、互不牵连：任一接口挂了只影响那一项，其它两项照常显示。
   * 某项失败 / 暂无成交样本时，沿用上一次缓存值并打上 stale 标记，
   * 不让面板闪成一片 "--"，也不会拿旧值去误触发提醒。
   */
  function fetchSnapshot(fetchImpl, prev) {
    var f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    var old = isObj(prev) && isObj(prev.items) ? prev.items : {};
    if (!f) return Promise.resolve({
      updatedAt: new Date().toISOString(), items: {}, errors: ['当前环境没有 fetch'], stale: true
    });
    var urls = KEYS.map(function (k) { return ENDPOINTS[k]; });
    return Promise.all(KEYS.map(function (k) { return getJson(f, ENDPOINTS[k]); }))
      .then(function (res) {
        var items = {}, errors = [];
        KEYS.forEach(function (k, i) {
          var r = res[i];
          var parsed = (r && r.ok) ? PARSERS[k](r.json) : null;
          if (parsed && parsed.value != null && parsed.value > 0) {
            items[k] = Object.assign({}, parsed, { stale: false });
          } else if (isObj(old[k]) && old[k].value != null) {
            items[k] = Object.assign({}, old[k], { stale: true });
            errors.push(META[k].label + '：' + (r && r.ok ? '暂无最新成交样本' : '接口暂不可用 ' + r.error));
          } else {
            items[k] = { key: k, value: null, changePct: null, asOf: null, stale: true };
            errors.push(META[k].label + '：' + (r && r.ok ? '暂无最新成交样本' : '接口暂不可用 ' + (r && r.error)));
          }
        });
        return {
          updatedAt: new Date().toISOString(),
          items: items,
          errors: errors,
          urls: urls
        };
      });
  }

  /* ---------- 展示格式 ---------- */

  function format(key, value) {
    var m = META[key] || META.bem;
    var v = num(value);
    if (v == null) return '—';
    var s = v.toLocaleString('en-US', { minimumFractionDigits: m.digits, maximumFractionDigits: m.digits });
    return m.prefix + s;
  }

  function formatChange(pct) {
    var n = num(pct);
    if (n == null) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  function isUp(pct) { var n = num(pct); return n != null && n > 0; }
  function isDown(pct) { var n = num(pct); return n != null && n < 0; }

  function linkFor(key) { return LINKS[key] || LINKS.home; }

  function safeLink(url) {
    if (typeof url !== 'string') return LINKS.home;
    return /^https:\/\/(?:[a-z0-9-]+\.)*firsto\.ai\//i.test(url) ? url : LINKS.home;
  }

  /* ---------- 上下限提醒判定 ---------- */

  /*
   * 状态机：只有「从区间内跨到区间外」的那一次才提醒，
   * 价格一直在阈值外不会每分钟弹一次。改过阈值后由后台清空 state 重新计。
   * cooldownMinutes 是二次保险，防止阈值来回微调造成连弹。
   */
  function evaluateAlerts(snapshot, settings, prevState, nowMs) {
    var s = normalizeSettings(settings);
    var now = num(nowMs);
    if (now == null) now = Date.now();
    var items = (isObj(snapshot) && isObj(snapshot.items)) ? snapshot.items : {};
    var state = {};
    var alerts = [];
    var prev = isObj(prevState) ? prevState : {};
    KEYS.forEach(function (k) {
      var item = items[k];
      var value = isObj(item) && !item.stale ? num(item.value) : null;
      var b = s.bounds[k] || {};
      var lo = num(b.min), hi = num(b.max);
      var kind = 'none';
      if (value != null && hi != null && value >= hi) kind = 'above';
      else if (value != null && lo != null && value <= lo) kind = 'below';
      var p = isObj(prev[k]) ? prev[k] : {};
      var lastAt = num(p.lastAlertAt) || 0;
      var cooled = (now - lastAt) >= s.cooldownMinutes * 60000;
      var fire = s.enabled && kind !== 'none' && p.kind !== kind && cooled;
      if (fire) {
        alerts.push(makeAlert(k, kind, value, lo, hi));
        lastAt = now;
      }
      state[k] = { kind: kind, lastAlertAt: lastAt, value: value };
    });
    return { alerts: alerts, state: state };
  }

  function makeAlert(key, kind, value, lo, hi) {
    var m = META[key] || META.bem;
    var bound = kind === 'above' ? hi : lo;
    var title = 'TapePost · ' + m.label + (kind === 'above' ? ' 触及上限' : ' 跌破下限');
    var message = '现价 ' + format(key, value) + ' ' + m.unit +
      (kind === 'above' ? ' ≥ 上限 ' : ' ≤ 下限 ') + format(key, bound) +
      '｜点此进入 Firsto 交易所';
    return {
      key: key, kind: kind, title: title, message: message,
      value: value, bound: bound, unit: m.unit,
      url: linkFor(key), at: new Date().toISOString()
    };
  }

  function demoAlert() {
    return {
      key: 'bem', kind: 'above',
      title: 'TapePost · 行情提醒测试',
      message: '这是一条测试提醒：上下限触发时会在网页右下角弹出，点击即可进入 Firsto 交易所。',
      value: null, bound: null, unit: 'USD',
      url: LINKS.home, at: new Date().toISOString(), demo: true
    };
  }

  return {
    FIRSTO_API: FIRSTO_API,
    UP_CONTRACT: UP_CONTRACT,
    ENDPOINTS: ENDPOINTS,
    LINKS: LINKS,
    META: META,
    KEYS: KEYS,
    POLL_OPTIONS: POLL_OPTIONS,
    COOLDOWN_OPTIONS: COOLDOWN_OPTIONS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    normalizeSettings: normalizeSettings,
    parseBem: parseBem,
    parseMiner: parseMiner,
    parseUp: parseUp,
    fetchSnapshot: fetchSnapshot,
    format: format,
    formatChange: formatChange,
    isUp: isUp,
    isDown: isDown,
    linkFor: linkFor,
    safeLink: safeLink,
    evaluateAlerts: evaluateAlerts,
    makeAlert: makeAlert,
    demoAlert: demoAlert
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TapePrice;
