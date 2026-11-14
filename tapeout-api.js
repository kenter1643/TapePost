/*
 * tapeout-api.js — TapeOut API 最新版本客户端（1.5.5）
 *
 * 两套官方/生态公开只读接口，按「最新版本优先、旧格式兼容」的方式接：
 *
 *  ① Firsto TapeOut API v1（api-tapeout.firsto.ai，索引层，schemaVersion 2 / 1 混合）
 *     GET /v1/account/{addr}/portfolio        钱包 BNB、每个 CPU 下 NAND/LATCH 余额
 *     GET /v1/account/{addr}/circuit-summary  持有矿机数、矿机市值、已实现/未实现盈亏
 *     GET /v1/pod/miners/{addr}               逐台矿机（矿池、权重、预估 24h 产出）
 *     GET /v1/pod/claims/{addr}?limit=100     累计已领取 $BEM 与领取流水
 *     —— 这四个路径取自 tapeout.firsto.ai 前端 bundle，都是免登录、免 Key 的公开只读接口。
 *
 *  ② TapeAPI 3.0.0 公共签名读取（api.tapeapi.fun/tapeapi/v1，链上锚定区块）
 *     POST /balance       原生 BNB 余额
 *     POST /tokenBalance  $BEM 余额（BEP-20，8 位小数）
 *     POST /bnbUsd        BNB 现价（PancakeSwap V2 现货）
 *     —— 2026-11-06 发布的 3.0.0 是当前最新版；按 3.x 文档写的调用在 3.x 内兼容。
 *        回答带 container / sig / blockPinned，扩展在没有引入 SDK 的情况下只取 result，
 *        并在界面标注「签名回执未本机验签」，不把它当成可信价格源做交易决策。
 *
 * 版本协商：每个响应都读 schemaVersion / version；解析按字段别名兜底，
 * 上游把 schemaVersion 从 1 升到 2、或字段名改名时，面板不会闪成空。
 *
 * 纯逻辑：不引用 chrome.*，fetch 由调用方注入，Node vm 可直接测。
 */
'use strict';

var TapeOutAPI = (function () {
  var FIRSTO_V1 = 'https://api-tapeout.firsto.ai/v1';
  var TAPEAPI_V1 = 'https://api.tapeapi.fun/tapeapi/v1';
  var TAPEAPI_VERSION = '3.0.0';
  var BEM_TOKEN = '0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a';
  var BEM_DECIMALS = 8;
  var BNB_DECIMALS = 18;
  var CHAIN_ID = 56;

  var LINKS = {
    portfolio: 'https://tapeout.firsto.ai/portfolio',
    mining: 'https://tapeout.firsto.ai/mining/claims',
    circuits: 'https://tapeout.firsto.ai/circuits/other',
    bem: 'https://firsto.ai/data/bem'
  };

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function num(v) { if (v == null || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function atomic(v, decimals) { var n = num(v); return (n == null || n <= 0) ? 0 : n / Math.pow(10, decimals); }
  function sum(list, fn) {
    var t = 0;
    (Array.isArray(list) ? list : []).forEach(function (x) { var v = fn(x); if (v != null && isFinite(v)) t += v; });
    return t;
  }
  function schemaOf(j, fallback) {
    if (!isObj(j)) return fallback || 0;
    var v = num(j.schemaVersion != null ? j.schemaVersion : (j.version != null ? j.version : null));
    return v == null ? (fallback || 0) : v;
  }

  /* ---------- 各接口解析（纯函数） ---------- */

  function parsePortfolio(j) {
    if (!isObj(j)) return null;
    var assets = Array.isArray(j.assets) ? j.assets : [];
    return {
      schema: schemaOf(j, 1),
      bnb: atomic(j.walletBnb, BNB_DECIMALS),
      recoveryBnb: atomic(j.recoveryBnb, BNB_DECIMALS),
      nand: sum(assets, function (a) { return num(isObj(a) && isObj(a.walletBalances) ? a.walletBalances.NAND : null); }),
      latch: sum(assets, function (a) { return num(isObj(a) && isObj(a.walletBalances) ? a.walletBalances.LATCH : null); }),
      cpuCount: assets.length,
      asOf: j.asOf || null,
      block: num(j.sourceBlock) || null
    };
  }

  function parseCircuitSummary(j) {
    if (!isObj(j)) return null;
    return {
      schema: schemaOf(j, 1),
      heldCount: num(j.heldCount != null ? j.heldCount : j.circuitCount) || 0,
      tradeCount: num(j.tradeCount) || 0,
      marketValueBnb: atomic(j.marketValueWei, BNB_DECIMALS),
      totalProfitBnb: atomic(j.totalProfitWei, BNB_DECIMALS),
      heldCostBnb: atomic(j.heldCostWei, BNB_DECIMALS),
      dailyCapacityPriceBnb: atomic(j.dailyCapacityPriceWei, BNB_DECIMALS),
      asOf: j.asOf || null,
      block: num(j.sourceBlock) || null
    };
  }

  function parseMiners(j) {
    if (!isObj(j)) return null;
    var rows = Array.isArray(j.rows) ? j.rows : [];
    var pool = isObj(j.miningPool) ? j.miningPool : {};
    var decimals = num(pool.tokenDecimals) != null ? num(pool.tokenDecimals) : BEM_DECIMALS;
    return {
      schema: schemaOf(j, 1),
      count: rows.length,
      miningCount: sum(rows, function (r) { return (r && String(r.status) === 'mining') ? 1 : 0; }),
      verifiedWeight: sum(rows, function (r) { return num(r && r.verifiedWeight); }),
      unverifiedWeight: sum(rows, function (r) { return num(r && r.unverifiedWeight); }),
      dailyBem: sum(rows, function (r) { return r && r.estimated24hAtomic != null ? atomic(r.estimated24hAtomic, decimals) : null; }),
      tokenDecimals: decimals,
      rateAtomic: num(pool.currentRateAtomic) || null,
      asOf: j.asOf || null,
      block: num(j.indexedSourceBlock != null ? j.indexedSourceBlock : j.sourceBlock) || null
    };
  }

  function parseClaims(j) {
    if (!isObj(j)) return null;
    var claims = Array.isArray(j.claims) ? j.claims : [];
    return {
      schema: schemaOf(j, 1),
      totalClaimedBem: atomic(j.totalClaimedAtomic, BEM_DECIMALS),
      claimCount: claims.length,
      lastClaimAt: claims.length && claims[0] ? (claims[0].claimedAt || null) : null,
      asOf: j.asOf || null,
      block: num(j.sourceBlock) || null
    };
  }

  function parseTapeRead(j, method) {
    if (!isObj(j) || j.ok !== true || !isObj(j.result)) return null;
    var r = j.result;
    var out = {
      method: method,
      block: (isObj(r.blockPinned) ? num(r.blockPinned.blockNumber) : null),
      container: j.container || null,
      signed: !!(j.sig && j.container),
      version: TAPEAPI_VERSION
    };
    if (method === 'balance') out.bnb = num(r.bnb) || 0;
    else if (method === 'tokenBalance') { out.bem = num(r.amount) || 0; out.symbol = r.symbol || 'BEM'; }
    else if (method === 'bnbUsd') out.bnbUsd = num(r.bnbUsd) || 0;
    return out;
  }

  /* ---------- 请求 ---------- */

  function call(fetchImpl, url, init, timeoutMs) {
    var opts = Object.assign({ cache: 'no-store', headers: { Accept: 'application/json' } }, init || {});
    var timer = null, controller = null;
    if (typeof AbortController !== 'undefined') {
      controller = new AbortController();
      opts.signal = controller.signal;
      timer = setTimeout(function () { try { controller.abort(); } catch (e) {} }, timeoutMs || 12000);
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

  function getFirsto(fetchImpl, addr, path) { return call(fetchImpl, FIRSTO_V1 + path.replace('{addr}', encodeURIComponent(addr))); }
  function postTape(fetchImpl, method, params) {
    return call(fetchImpl, TAPEAPI_V1 + '/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ id: 'tapepost-' + Date.now().toString(36), params: params || {} })
    });
  }

  /*
   * 汇总一个公开地址的全部资产。任何一项失败都不拖垮其它项；errors 会展示在面板上。
   * priceUsd 可传入 price.js 已采集的 BEM 现价，避免重复打 analytics 接口。
   */
  function fetchAssets(fetchImpl, address, options) {
    var f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    var opt = isObj(options) ? options : {};
    var addr = String(address || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return Promise.resolve({ ok: false, error: '地址格式不正确' });
    if (!f) return Promise.resolve({ ok: false, error: '当前环境没有 fetch' });

    var jobs = [
      { key: 'portfolio', run: getFirsto(f, addr, '/account/{addr}/portfolio') },
      { key: 'circuits', run: getFirsto(f, addr, '/account/{addr}/circuit-summary') },
      { key: 'miners', run: getFirsto(f, addr, '/pod/miners/{addr}') },
      { key: 'claims', run: getFirsto(f, addr, '/pod/claims/{addr}?limit=100') },
      { key: 'bnb', run: postTape(f, 'balance', { address: addr }) },
      { key: 'bem', run: postTape(f, 'tokenBalance', { token: BEM_TOKEN, address: addr }) },
      { key: 'bnbUsd', run: postTape(f, 'bnbUsd', {}) }
    ];
    return Promise.all(jobs.map(function (j) { return j.run; })).then(function (res) {
      var got = {}, errors = [];
      jobs.forEach(function (j, i) {
        var r = res[i];
        if (r && r.ok) got[j.key] = r.json;
        else errors.push(j.key + '：' + (r && r.error ? r.error : '无响应'));
      });
      var portfolio = parsePortfolio(got.portfolio);
      var circuits = parseCircuitSummary(got.circuits);
      var miners = parseMiners(got.miners);
      var claims = parseClaims(got.claims);
      var bnbRead = parseTapeRead(got.bnb, 'balance');
      var bemRead = parseTapeRead(got.bem, 'tokenBalance');
      var usdRead = parseTapeRead(got.bnbUsd, 'bnbUsd');

      // 链上签名读取优先，失败时回落 Firsto 索引层的余额
      var bnb = bnbRead ? bnbRead.bnb : (portfolio ? portfolio.bnb : null);
      var bemBal = bemRead ? bemRead.bem : null;
      var bnbUsd = usdRead ? usdRead.bnbUsd : null;
      var priceUsd = num(opt.priceUsd);
      var dailyBem = miners ? miners.dailyBem : null;

      var out = {
        ok: true,
        address: addr,
        asOf: (portfolio && portfolio.asOf) || (miners && miners.asOf) || new Date().toISOString(),
        fetchedAt: new Date().toISOString(),
        versions: {
          firsto: 'v1',
          tapeapi: TAPEAPI_VERSION,
          schemaVersions: {
            portfolio: portfolio ? portfolio.schema : null,
            circuits: circuits ? circuits.schema : null,
            miners: miners ? miners.schema : null,
            claims: claims ? claims.schema : null
          },
          chainSigned: !!(bnbRead || bemRead || usdRead),
          signatureVerifiedLocally: false
        },
        circuits: {
          count: circuits ? circuits.heldCount : (miners ? miners.count : null),
          miningCount: miners ? miners.miningCount : null,
          verifiedWeight: miners ? miners.verifiedWeight : null,
          dailyBem: dailyBem,
          marketValueBnb: circuits ? circuits.marketValueBnb : null,
          totalProfitBnb: circuits ? circuits.totalProfitBnb : null,
          tradeCount: circuits ? circuits.tradeCount : null
        },
        bem: {
          balance: bemBal,
          claimedTotal: claims ? claims.totalClaimedBem : null,
          daily: dailyBem,
          claimCount: claims ? claims.claimCount : null,
          lastClaimAt: claims ? claims.lastClaimAt : null,
          priceUsd: priceUsd,
          balanceUsd: (bemBal != null && priceUsd != null) ? bemBal * priceUsd : null,
          dailyUsd: (dailyBem != null && priceUsd != null) ? dailyBem * priceUsd : null
        },
        bnb: {
          balance: bnb,
          priceUsd: bnbUsd,
          balanceUsd: (bnb != null && bnbUsd != null) ? bnb * bnbUsd : null
        },
        transistors: {
          nand: portfolio ? portfolio.nand : null,
          latch: portfolio ? portfolio.latch : null,
          cpuCount: portfolio ? portfolio.cpuCount : null
        },
        errors: errors,
        sources: {
          portfolio: !!portfolio, circuitSummary: !!circuits, miners: !!miners,
          claims: !!claims, chainBalance: !!bnbRead, chainBem: !!bemRead, chainBnbUsd: !!usdRead
        }
      };
      return out;
    });
  }

  /* ---------- 展示格式 ---------- */

  function fmt(n, digits) {
    var v = num(n);
    if (v == null) return '—';
    var d = digits == null ? 2 : digits;
    return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function compact(n) {
    var v = num(n);
    if (v == null) return '—';
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e4) return (v / 1e3).toFixed(1) + 'K';
    return fmt(v, v >= 100 ? 1 : (v >= 1 ? 3 : 4));
  }

  return {
    FIRSTO_V1: FIRSTO_V1,
    TAPEAPI_V1: TAPEAPI_V1,
    TAPEAPI_VERSION: TAPEAPI_VERSION,
    BEM_TOKEN: BEM_TOKEN,
    BEM_DECIMALS: BEM_DECIMALS,
    BNB_DECIMALS: BNB_DECIMALS,
    CHAIN_ID: CHAIN_ID,
    LINKS: LINKS,
    isObj: isObj,
    num: num,
    atomic: atomic,
    schemaOf: schemaOf,
    parsePortfolio: parsePortfolio,
    parseCircuitSummary: parseCircuitSummary,
    parseMiners: parseMiners,
    parseClaims: parseClaims,
    parseTapeRead: parseTapeRead,
    fetchAssets: fetchAssets,
    fmt: fmt,
    compact: compact
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TapeOutAPI;
