/*
 * price.js — TapeOut 行情数据层（popup / background / test-harness 共用）
 *
 * 1.4.13：面板顶端展示三项实时价格，并支持上下限提醒。
 * 数据来源（公开只读、免登录免 Key、不上传任何用户数据）：
 *   【以下两项都来自 Firsto（api-tapeout.firsto.ai / tapeout.firsto.ai）】
 *   · Firsto 官方 analytics：/v1/analytics/bem        → $BEM 现价（USD，8 位定点）
 *   · Firsto 电路市场：/v1/circuit-holders?page=1    → 矿机日产能价（BNB，wei 18 位定点）
 *     即 https://tapeout.firsto.ai/circuits/other 页顶「日产能价参考价」，
 *     口径是当前有效挂单的日产能价中位数（marketStats.dailyCapacityPriceWei），
 *     不是 /v1/analytics/circuits 的 24h 小时成交序列（那是历史成交均价，会滞后）。
 *   【此项来自 tapeup.io，与 Firsto 无关】
 *   · TapeUP $UP 内盘价：来自 tapeup.io 交易页（UP 以 BEM 计价，页面标注 BEM/UP，
 *     同时给出美元折算价）。真机页面示例：0.0264 BEM/UP · $0.3181 · +19.44%。
 *     该站整站 Cloudflare 防护，后台直接 fetch 会被拦，因此由内容脚本在用户浏览器
 *     （已通过 CF）里读取页面显示的内盘价，再回传后台缓存。详见 tapeup-price.js。
 *
 * 这个模块刻意不引用任何 chrome.* API：后台用 importScripts 加载，
 * 弹窗用 <script> 加载，Node 测试用 vm 加载，三处跑的是同一份纯逻辑。
 */
'use strict';

var TapePrice = (function () {
  var FIRSTO_API = 'https://api-tapeout.firsto.ai';

  // 后台定时拉取的接口（BEM 来自 analytics；矿机日产价来自 /circuits/other 页顶参考价的同源接口）。
  // TapeUP $UP 内盘价不走后台 fetch（tapeup.io 整站 Cloudflare 防护），改由内容脚本采集，见下方 mergeUp。
  var ENDPOINTS = {
    bem: FIRSTO_API + '/v1/analytics/bem?range=24h',
    miner: FIRSTO_API + '/v1/circuit-holders?page=1'
  };

  // 点击卡片 / 点击提醒弹窗要去的页面
  var LINKS = {
    up: 'https://tapeup.io/zh/trade/token?id=1',   // TapeUP $UP 内盘交易页（UP 以 BEM 计价）
    miner: 'https://tapeout.firsto.ai/circuits/other',  // 1.4.20：官方电路市场（页顶「日产能价参考价」）
    bem: 'https://firsto.ai/data/bem',
    home: 'https://firsto.ai/',
    tapeupHome: 'https://tapeup.io/'
  };

  var META = {
    // up.value 是 BEM 计价的内盘价（BEM/UP）；usdValue 是页面给出的美元折算价，另存。
    up:    { label: 'TapeUP·内盘', symbol: 'UP', unit: 'BEM/UP', digits: 4, prefix: '', source: 'tapeup.io' },
    miner: { label: '矿机日产价', symbol: 'TapeOut', unit: 'BNB', digits: 3, prefix: '', source: 'Firsto' },
    bem:   { label: 'BEM', symbol: '$BEM', unit: 'USD', digits: 2, prefix: '$', source: 'Firsto' }
  };
  // 面板展示顺序 / 三张卡
  var KEYS = ['up', 'miner', 'bem'];
  // 后台真正要去拉的接口（UP 由内容脚本采集，不在此列）
  var FETCH_KEYS = ['miner', 'bem'];

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
    if (!isObj(json)) return null;

    /* 1.4.20：官网 /circuits/other 页顶「日产能价参考价」的数据源。
     * 该页 circuit-market-stats 组件读 snapshot.marketStats.dailyCapacityPriceWei，
     * 口径是「当前有效挂单中最低 5 个不同卖家日产能价的中位数」，是实时价；
     * referenceDailyCapacityPriceWei 是同一口径的新版字段名，优先取它。
     * 旧版 /v1/analytics/circuits?range=24h 给的是小时成交序列，最后一个非空点
     * 可能是几小时前的成交均价（真机 7.207 vs 页面 7.520），已不再作为主来源。
     * changePct 置 null：挂单参考价没有 24h 同口径序列可比，拿最近成交价算
     * 会把「溢价」误显示成「24h 涨幅」，面板改显示「挂单参考价」。 */
    var ms = isObj(json.marketStats) ? json.marketStats : null;
    if (ms) {
      var ref = atomic(ms.referenceDailyCapacityPriceWei, 18);
      var live = atomic(ms.dailyCapacityPriceWei, 18);
      var sale = atomic(ms.recentSaleDailyCapacityPriceWei, 18);
      var value = ref != null ? ref : (live != null ? live : sale);
      if (value == null) return null;
      return {
        key: 'miner', value: value, changePct: null,
        asOf: json.asOf || null, source: 'Firsto circuits/other'
      };
    }

    /* 旧格式兼容：接口改版 / 上游回退到 analytics 时仍能出数，不让面板闪成空。 */
    if (!Array.isArray(json.series)) return null;
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

  /*
   * 1.4.16：TapeUP $UP 内盘价提取（内容脚本在用户浏览器里从 tapeup.io 交易页读取）。
   * 入参可以是 Document（内容脚本直接传 document）或 HTML 字符串（便于测试）；
   * 统一转成页面文本后用多策略正则抓价，避免依赖某个固定的 DOM 结构——
   * tapeup.io 是 Cloudflare 后的 Next.js 应用，标记结构可能随版本变，纯文本抓价更稳。
   * 返回 { value, changePct, asOf, debug }；debug 带上候选价，便于线上核对解析是否准确。
   */
  function toPageText(source) {
    if (!source) return '';
    var html = '';
    try {
      if (typeof source === 'string') html = source;
      else if (source.documentElement && source.documentElement.outerHTML) html = source.documentElement.outerHTML;
      else if (source.outerHTML) html = source.outerHTML;
    } catch (e) { html = ''; }
    if (!html) return '';
    // 去掉脚本/样式，再脱标签，得到近似「页面可见文本」
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
  }

  function stripNum(s) {
    if (s == null) return null;
    var t = String(s).replace(/,/g, '').replace(/\s/g, '');
    var n = Number(t);
    return isFinite(n) ? n : null;
  }

  /* 1.4.21：真机校准（2026-11-12，tapeup.io/zh/trade 与 /zh/trade/token?id=1）。
   * 页面头部价格是「0.0264 BEM/UP  $0.3181  +19.44%」：BEM 计价 + 美元折算 + 24h 涨跌。
   * 旧版用「数字 BEM」宽泛正则，会抓到图表坐标 / 钱包余额（0.00049456）/ 待释放
   * （8.78358728）/ 统计区大数字，才一直给出错误的 0.286...。
   * 现在只认明确锚点：详情页的 BEM/UP 标签、列表行的「价 $美元 百分比」三连。
   * 认不出就返回 null（面板显示未采集），绝不再拿页面上的随机小数凑数。 */
  function extractUp(source) {
    var text = toPageText(source);
    if (!text) {
      return { value: null, usdValue: null, changePct: null, asOf: null,
        debug: { textLen: 0, candidates: [], note: 'BEM/UP 锚点' } };
    }
    var debug = { textLen: text.length, candidates: [], note: 'BEM/UP 锚点' };
    var best = null;

    function consider(value, usd, pct, score, ctx) {
      var v = stripNum(value);
      if (v == null || v <= 0) return;
      var cand = {
        value: v,
        usdValue: (usd == null ? null : stripNum(usd)),
        changePct: (pct == null ? null : stripNum(String(pct).replace('%', ''))),
        score: score, ctx: ctx
      };
      debug.candidates.push(cand);
      // score 0 只作真机诊断（记录页面上出现过的「数字 BEM」），不参与选价
      if (score >= 10 && score > (best ? best.score : -1)) best = cand;
    }

    var m;

    // 策略 A（最高）：详情页头部「0.0264 BEM/UP」，紧随其后的 $ 折算价与百分比
    var headRe = /(\d{1,3}\.\d{2,12})\s*BEM\s*\/\s*UP/gi;
    while ((m = headRe.exec(text)) !== null) {
      var tail = text.slice(m.index + m[0].length, m.index + m[0].length + 120);
      var usdM = /\$\s*([\d,.]+)/.exec(tail);
      var pctM = /([+-]\d{1,3}(?:\.\d{1,2})?)\s*%/.exec(tail);
      consider(m[1], usdM ? usdM[1] : null, pctM ? pctM[1] : null,
        100, 'BEM/UP:' + m[0].replace(/\s+/g, ' ').trim().slice(0, 24));
    }

    // 策略 B1：交易列表行「1TapeUPUP1 0.0264 $0.3181 +19.44%」
    // 代币 ID 会和价格粘在一起（…UP10.0264…），用 TapeUP + UP + ID 锚点让正则回溯出 0.0264
    var rowRe = /TapeUP\s*UP\s*\d+\s*(\d{1,3}\.\d{2,12})\s*\$\s*([\d,.]+)\s*([+-]\d{1,3}(?:\.\d{1,2})?)\s*%/gi;
    while ((m = rowRe.exec(text)) !== null) {
      consider(m[1], m[2], m[3], 95, 'list-row:' + m[0].replace(/\s+/g, ' ').trim().slice(0, 30));
    }

    // 策略 B2：通用三连「价 $美元 百分比」（页面改版、ID 不粘连时的退路）
    // 只收 < 1 的候选，避免把「10.0264」这类 ID 粘连值当价格
    var triRe = /(\d{1,3}\.\d{2,12})\s*\$\s*([\d,.]+)\s*([+-]\d{1,3}(?:\.\d{1,2})?)\s*%/g;
    while ((m = triRe.exec(text)) !== null) {
      if (stripNum(m[1]) >= 1) continue;
      consider(m[1], m[2], m[3], 80, 'usd-pct:' + m[0].replace(/\s+/g, ' ').trim().slice(0, 30));
    }

    // 诊断候选：把页面上所有「数字 BEM」列出来（含钱包余额、统计区），仅供真机排查
    var bemRe = /(\d{1,3}\.\d{2,12})\s*BEM\b/gi;
    while ((m = bemRe.exec(text)) !== null) {
      consider(m[1], null, null, 0, 'diagnostic:' + m[0].replace(/\s+/g, ' ').trim().slice(0, 22));
    }

    if (!best) {
      return { value: null, usdValue: null, changePct: null, asOf: null, debug: debug };
    }
    return {
      value: best.value, usdValue: best.usdValue, changePct: best.changePct,
      asOf: null, source: 'tapeup.io 内盘', debug: debug
    };
  }

  // 把内容脚本采集到的内盘价并入快照（按新鲜度给 stale 标记，过期则沿用上一次、不直接拿旧值误报）
  function mergeUp(prev, cachedUp, nowMs) {
    var now = num(nowMs);
    if (now == null) now = Date.now();
    var old = isObj(prev) && isObj(prev.items) ? prev.items : {};
    var MAX_AGE = 30 * 60000; // 内盘价超过 30 分钟未刷新视为过期
    var upCache = isObj(cachedUp) ? cachedUp : null;
    var fresh = upCache && num(upCache.value) > 0 && num(upCache.at) && (now - num(upCache.at) < MAX_AGE);

    if (fresh) {
      return {
        item: { key: 'up', value: num(upCache.value), usdValue: num(upCache.usdValue),
          changePct: num(upCache.changePct),
          asOf: upCache.asOf || null, stale: false, source: 'tapeup.io 内盘',
          debug: (upCache && upCache.debug) ? upCache.debug : null },
        error: null
      };
    }
    if (upCache && num(upCache.value) > 0) {
      return {
        item: { key: 'up', value: num(upCache.value), usdValue: num(upCache.usdValue),
          changePct: num(upCache.changePct),
          asOf: upCache.asOf || null, stale: true, source: 'tapeup.io 内盘',
          debug: (upCache && upCache.debug) ? upCache.debug : null },
        error: 'TapeUP 内盘价沿用缓存（请打开 tapeup.io 交易页刷新）'
      };
    }
    if (isObj(old.up) && old.up.value != null) {
      return { item: Object.assign({}, old.up, { stale: true, debug: (old.up && old.up.debug) ? old.up.debug : null }), error: 'TapeUP 内盘价暂无采集（请打开 tapeup.io 交易页）' };
    }
    return {
      item: { key: 'up', value: null, usdValue: null, changePct: null, asOf: null, stale: true, source: 'tapeup.io 内盘' },
      error: 'TapeUP 内盘价暂无采集（请打开 tapeup.io 交易页）'
    };
  }

  // 让一次 PRICE_GET 直接套用最新的内盘价缓存（即便快照本身是 2 分钟内的旧缓存）
  function withUp(snapshot, cachedUp, nowMs) {
    if (!isObj(snapshot)) return snapshot;
    var r = mergeUp(snapshot, cachedUp, nowMs);
    var items = Object.assign({}, snapshot.items, { up: r.item });
    return Object.assign({}, snapshot, { items: items, errors: (snapshot.errors || []).concat(r.error ? [r.error] : []) });
  }

  var PARSERS = { bem: parseBem, miner: parseMiner };

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
   * 后台定时拉取 BEM / 矿机日产价（并发、互不牵连），再把内容脚本采集的 TapeUP 内盘价并入。
   * 矿机日产价走 /v1/circuit-holders 的实时挂单参考价；某项失败 / 暂无有效报价时
   * 沿用上一次缓存并打 stale，不让面板闪成 "--"，也不拿旧值误报。
   */
  function fetchSnapshot(fetchImpl, prev, cachedUp) {
    var f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    var old = isObj(prev) && isObj(prev.items) ? prev.items : {};
    if (!f) {
      var merged0 = mergeUp(prev, cachedUp);
      return Promise.resolve({
        updatedAt: new Date().toISOString(),
        items: Object.assign({}, { up: merged0.item }),
        errors: ['当前环境没有 fetch'].concat(merged0.error ? [merged0.error] : []),
        stale: true
      });
    }
    var urls = FETCH_KEYS.map(function (k) { return ENDPOINTS[k]; });
    return Promise.all(FETCH_KEYS.map(function (k) { return getJson(f, ENDPOINTS[k]); }))
      .then(function (res) {
        var items = {}, errors = [];
        FETCH_KEYS.forEach(function (k, i) {
          var r = res[i];
          var parsed = (r && r.ok) ? PARSERS[k](r.json) : null;
          if (parsed && parsed.value != null && parsed.value > 0) {
            items[k] = Object.assign({}, parsed, { stale: false });
          } else if (isObj(old[k]) && old[k].value != null) {
            items[k] = Object.assign({}, old[k], { stale: true });
            errors.push(META[k].label + '：' + (r && r.ok ? (k === 'miner' ? '暂无有效挂单参考价' : '暂无最新成交样本') : '接口暂不可用 ' + r.error));
          } else {
            items[k] = { key: k, value: null, changePct: null, asOf: null, stale: true };
            errors.push(META[k].label + '：' + (r && r.ok ? (k === 'miner' ? '暂无有效挂单参考价' : '暂无最新成交样本') : '接口暂不可用 ' + (r && r.error)));
          }
        });
        var up = mergeUp(prev, cachedUp);
        items.up = up.item;
        if (up.error) errors.push(up.error);
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
    // 仅放行 Firsto 与 tapeup.io 官方域名，其余一律回落首页，防中间人改链接
    return /^https:\/\/(?:[a-z0-9-]+\.)*(?:firsto\.ai|tapeup\.io)\//i.test(url) ? url : LINKS.home;
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
    ENDPOINTS: ENDPOINTS,
    LINKS: LINKS,
    META: META,
    KEYS: KEYS,
    FETCH_KEYS: FETCH_KEYS,
    POLL_OPTIONS: POLL_OPTIONS,
    COOLDOWN_OPTIONS: COOLDOWN_OPTIONS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    normalizeSettings: normalizeSettings,
    parseBem: parseBem,
    parseMiner: parseMiner,
    extractUp: extractUp,
    mergeUp: mergeUp,
    withUp: withUp,
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
