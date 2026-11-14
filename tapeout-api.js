/*
 * tapeout-api.js — TapeOut 双链只读资产客户端（1.5.5 建 / 1.5.8 加 X Layer）
 *
 * BSC（BNB Smart Chain，chainId 56）—— 两套官方/生态公开只读接口：
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
 * X Layer（OKX L2，chainId 196）—— FabX / TapeOut PoD 同协议实例：
 *
 *  ③ FabX 官方 PoD 索引 v1（api.fabx.tech）
 *     GET /v1/accounts/{addr}/mining          该地址 FAB 余额、逐台电路矿机明细
 *       （status / live 待领 / effective 算力权重 / global 全网排放与权重）
 *     —— 路径与字段取自 fabx.tech 公开前端 bundle，免登录、免 Key、纯只读。
 *
 *  ④ X Layer 公共 JSON-RPC（rpc.xlayer.tech，备用 xlayerrpc.okx.com）
 *     一次 batch 发 3 个只读 eth_call / eth_getBalance：
 *       FAB ERC-20 balanceOf、电路 ERC-721 balanceOf（持有矿机数）、原生 OKB 余额。
 *     合约地址取自 FabX 官方 VITE_ 配置与 /v1/status，8 位小数的 FAB 已上链核对。
 *
 * 两条链各自独立：任一条链的接口挂了不影响另一条；解析按字段别名兜底，
 * BSC 响应里的 schemaVersion 从 1 升到 2、或 X Layer 字段名改名时，面板不会闪成空。
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

  // 1.5.8：X Layer 上的 TapeOut PoD 实例（FabX）
  var FABX_V1 = 'https://api.fabx.tech/v1';
  var XLAYER_RPC = 'https://rpc.xlayer.tech';
  var XLAYER_RPC_BACKUP = 'https://xlayerrpc.okx.com';
  var XLAYER_CHAIN_ID = 196;
  var FAB_TOKEN = '0x72f349b1eee7833b26f8c81a8410775a4e231ed2';
  var CIRCUITS_NFT = '0x87bfca3494aa228ff589ab9b642143a5e8c8f9a6';
  var FAB_DECIMALS = 8;   // 链上 decimals() 实测为 8；7200 FAB/天 ÷ 86400 ≈ 8333333 atomic/s
  var OKB_DECIMALS = 18;
  var BALANCE_OF = '0x70a08231';

  var LINKS = {
    portfolio: 'https://tapeout.firsto.ai/portfolio',
    mining: 'https://tapeout.firsto.ai/mining/claims',
    circuits: 'https://tapeout.firsto.ai/circuits/other',
    bem: 'https://firsto.ai/data/bem',
    fabx: 'https://fabx.tech/en/pod'
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

  /* ---------- 1.5.8：X Layer / FabX PoD 只读解析 ---------- */

  // eth_call 的 address 参数：去掉 0x 后左补 0 到 64 位十六进制
  function addrWord(addr) {
    var s = String(addr || '').replace(/^0x/i, '').toLowerCase();
    while (s.length < 64) s = '0' + s;
    return s.slice(-64);
  }
  // 十进制字符串 ×16 + 一位（避免 BigInt / Number 精度上限，长 uint256 也能安全读）
  function mul16add(dec, digit) {
    var carry = digit, out = '';
    for (var i = dec.length - 1; i >= 0; i--) {
      var v = Number(dec.charAt(i)) * 16 + carry;
      out = String(v % 10) + out;
      carry = Math.floor(v / 10);
    }
    while (carry > 0) { out = String(carry % 10) + out; carry = Math.floor(carry / 10); }
    return out || '0';
  }
  function hexToUnits(hex, decimals) {
    var raw = String(hex == null ? '' : hex);
    if (!/^0x[0-9a-fA-F]+$/.test(raw)) return null;
    // 0x0 / 0x000…0 都是合法的零余额，不能当成「无数据」丢掉
    var s = raw.slice(2).replace(/^0+/, '');
    var dec = '0';
    for (var i = 0; i < s.length; i++) dec = mul16add(dec, parseInt(s.charAt(i), 16));
    var d = Math.max(0, Number(decimals) || 0);
    while (dec.length <= d) dec = '0' + dec;
    var n = Number(dec.slice(0, dec.length - d) + (d ? '.' + dec.slice(dec.length - d) : ''));
    return isFinite(n) ? n : null;
  }

  /*
   * FabX /v1/accounts/{addr}/mining：返回该地址的 FAB 余额（atomic）、逐台电路矿机、
   * 全网排放 rate 与已验证 / 未验证总权重。日产按官网前端同一公式估算：
   *   perSec = vw × (rate − rate×unverBps/10000) / tv + uw × (rate×unverBps/10000) / tu
   * 只是「按当前全网权重占比外推 24h」的估算值，不是承诺收益，界面会标注。
   */
  function parseFabxMining(j, addr) {
    if (!isObj(j)) return null;
    if (!j.account || String(j.account).toLowerCase() !== String(addr).toLowerCase()) return null;
    if (!Array.isArray(j.items)) return null;
    var g = isObj(j.global) ? j.global : {};
    var tv = num(j.tv) || 0, tu = num(j.tu) || 0;
    var rate = num(g.currentRate) || 0;
    var unverBps = num(g.UNVERIFIED_BPS) || 0;
    var unverRate = rate * unverBps / 10000;
    var verifRate = rate - unverRate;
    var items = j.items, perSec = 0, pendingAtomic = 0;
    var vw = 0, uw = 0, active = 0;
    for (var i = 0; i < items.length; i++) {
      var it = isObj(items[i]) ? items[i] : {};
      var eff = isObj(it.effective) ? it.effective : (isObj(it.miner) ? it.miner : {});
      var a = num(eff.verifWeight != null ? eff.verifWeight : it.verifWeight) || 0;
      var b = num(eff.unverWeight != null ? eff.unverWeight : it.unverWeight) || 0;
      vw += a; uw += b;
      pendingAtomic += num(it.live) || 0;
      if (num(isObj(it.miner) ? it.miner.status : it.status) === 1) active++;
      if (tv > 0) perSec += a * verifRate / tv;
      if (tu > 0) perSec += b * unverRate / tu;
    }
    return {
      schema: 1,
      account: String(j.account).toLowerCase(),
      balance: j.balance != null ? atomic(j.balance, FAB_DECIMALS) : null,
      pending: pendingAtomic / Math.pow(10, FAB_DECIMALS),
      daily: perSec * 86400 / Math.pow(10, FAB_DECIMALS),
      miners: items.length,
      activeMiners: active,
      verifiedWeight: vw,
      unverifiedWeight: uw,
      boost: num(j.boost),
      chainId: num(isObj(j.source) ? j.source.chainId : null) || XLAYER_CHAIN_ID,
      block: num(j.blockNumber) || null,
      generatedAt: j.generatedAt || null,
      network: {
        minerCount: num(g.minerCount),
        verifMinerCount: num(g.verifMinerCount),
        totalVerifWeight: tv,
        totalUnverWeight: tu,
        totalMined: g.totalMined != null ? atomic(g.totalMined, FAB_DECIMALS) : null,
        currentRateAtomic: rate
      }
    };
  }

  // batch RPC 返回数组，按 id 取，顺序乱也不怕
  function parseRpcBatch(arr) {
    if (!Array.isArray(arr)) return null;
    var byId = {};
    arr.forEach(function (r) { if (isObj(r) && r.result != null) byId[String(r.id)] = r.result; });
    if (!byId['1'] && !byId['2'] && !byId['3']) return null;
    return {
      fab: byId['1'] != null ? hexToUnits(byId['1'], FAB_DECIMALS) : null,
      circuitsHeld: byId['2'] != null ? hexToUnits(byId['2'], 0) : null,
      okb: byId['3'] != null ? hexToUnits(byId['3'], OKB_DECIMALS) : null
    };
  }
  function rpcPayloads(addr) {
    var word = addrWord(addr);
    return [
      { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: FAB_TOKEN, data: BALANCE_OF + word }, 'latest'] },
      { jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{ to: CIRCUITS_NFT, data: BALANCE_OF + word }, 'latest'] },
      { jsonrpc: '2.0', id: 3, method: 'eth_getBalance', params: [addr, 'latest'] }
    ];
  }
  function postRpc(fetchImpl, url, payload, timeoutMs) {
    return call(fetchImpl, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    }, timeoutMs);
  }

  /*
   * 一条链一次汇总：FabX 索引 + X Layer RPC（主节点失败才打备用节点）。
   * 两项彼此独立，也和 BSC 的 7 个请求彼此独立；任何一项失败都只记一条错误。
   */
  function fetchXLayer(fetchImpl, addr) {
    var batch = rpcPayloads(addr);
    var jobs = {
      fabx: call(fetchImpl, FABX_V1 + '/accounts/' + encodeURIComponent(addr) + '/mining', null, 6000),
      rpc: postRpc(fetchImpl, XLAYER_RPC, batch, 5000).then(function (r) {
        if (r && r.ok && Array.isArray(r.json)) return r;
        return postRpc(fetchImpl, XLAYER_RPC_BACKUP, batch, 4000);
      })
    };
    return Promise.all([jobs.fabx, jobs.rpc]).then(function (res) {
      var a = res[0], b = res[1];
      var errors = [];
      var mining = (a && a.ok) ? parseFabxMining(a.json, addr) : null;
      var rpc = (b && b.ok) ? parseRpcBatch(b.json) : null;
      if (a && a.ok && !mining) errors.push('xlayer: FabX 账户数据格式不符（已忽略）');
      else if (!a || !a.ok) errors.push('xlayer/FabX：' + (a && a.error ? a.error : '无响应'));
      if (b && b.ok && !rpc) errors.push('xlayer: RPC 返回值无法解析（已忽略）');
      else if (!b || !b.ok) errors.push('xlayer/RPC：' + (b && b.error ? b.error : '无响应'));

      // 链上 RPC 的 FAB 余额优先（最权威），索引层余额兜底；矿机台数同理
      var fab = rpc && rpc.fab != null ? rpc.fab : (mining ? mining.balance : null);
      var held = rpc && rpc.circuitsHeld != null ? rpc.circuitsHeld : (mining ? mining.miners : null);
      var data = {
        ok: !!(mining || rpc),
        chainId: XLAYER_CHAIN_ID,
        token: FAB_TOKEN,
        circuitsNft: CIRCUITS_NFT,
        balance: fab,
        pending: mining ? mining.pending : null,
        daily: mining ? mining.daily : null,
        miners: held,
        registeredMiners: mining ? mining.miners : null,
        activeMiners: mining ? mining.activeMiners : null,
        verifiedWeight: mining ? mining.verifiedWeight : null,
        unverifiedWeight: mining ? mining.unverifiedWeight : null,
        boost: mining ? mining.boost : null,
        okb: rpc ? rpc.okb : null,
        network: mining ? mining.network : null,
        block: mining ? mining.block : null,
        generatedAt: mining ? mining.generatedAt : null,
        errors: errors,
        sources: { fabx: !!mining, rpc: !!rpc }
      };
      return {
        data: data,
        errors: errors,
        sources: { xlayerFabx: !!mining, xlayerRpc: !!rpc }
      };
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
    // 1.5.8：BSC 的 7 个请求与 X Layer 的 2 组请求并行，互不阻塞、互不影响
    return Promise.all([
      Promise.all(jobs.map(function (j) { return j.run; })),
      fetchXLayer(f, addr)
    ]).then(function (all) {
      var res = all[0], xl = all[1] || { data: { ok: false }, errors: [], sources: {} };
      var got = {}, errors = [];
      jobs.forEach(function (j, i) {
        var r = res[i];
        if (r && r.ok) got[j.key] = r.json;
        else errors.push(j.key + '：' + (r && r.error ? r.error : '无响应'));
      });
      errors = errors.concat(xl.errors || []);
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
          fabx: 'v1',
          xlayerChainId: XLAYER_CHAIN_ID,
          schemaVersions: {
            portfolio: portfolio ? portfolio.schema : null,
            circuits: circuits ? circuits.schema : null,
            miners: miners ? miners.schema : null,
            claims: claims ? claims.schema : null
          },
          chainSigned: !!(bnbRead || bemRead || usdRead),
          signatureVerifiedLocally: false
        },
        xlayer: xl.data,
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
        sources: Object.assign({
          portfolio: !!portfolio, circuitSummary: !!circuits, miners: !!miners,
          claims: !!claims, chainBalance: !!bnbRead, chainBem: !!bemRead, chainBnbUsd: !!usdRead
        }, xl.sources || {})
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
    FABX_V1: FABX_V1,
    XLAYER_RPC: XLAYER_RPC,
    XLAYER_RPC_BACKUP: XLAYER_RPC_BACKUP,
    XLAYER_CHAIN_ID: XLAYER_CHAIN_ID,
    FAB_TOKEN: FAB_TOKEN,
    CIRCUITS_NFT: CIRCUITS_NFT,
    FAB_DECIMALS: FAB_DECIMALS,
    OKB_DECIMALS: OKB_DECIMALS,
    LINKS: LINKS,
    isObj: isObj,
    num: num,
    atomic: atomic,
    schemaOf: schemaOf,
    hexToUnits: hexToUnits,
    addrWord: addrWord,
    parsePortfolio: parsePortfolio,
    parseCircuitSummary: parseCircuitSummary,
    parseMiners: parseMiners,
    parseClaims: parseClaims,
    parseTapeRead: parseTapeRead,
    parseFabxMining: parseFabxMining,
    parseRpcBatch: parseRpcBatch,
    rpcPayloads: rpcPayloads,
    fetchXLayer: fetchXLayer,
    fetchAssets: fetchAssets,
    fmt: fmt,
    compact: compact
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TapeOutAPI;
