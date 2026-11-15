/* TapePost 1.5.5 · 钱包 / TapeOut API 资产 / BEM 全网账本 专项自检
 * 运行：node test-wallet-vote-assets.js            （纯本地模拟，不进商店包）
 *       node test-wallet-vote-assets.js --live     （额外对线上只读接口做连通性冒烟，不投票）
 * 覆盖：地址校验 / AES-GCM 加密往返 / 每日匿名 voterId / 北京时间切天 /
 *       按天累计 / 连续打卡 / 账本 URL 保留 sharecode / 各接口解析与版本协商 /
 *       混合成功失败的资产汇总 / 本机账本降级合并 / 钱包地址脱敏；
 *       1.5.6：钱包地址哈希跨设备去重 / 10000 条话语文库 / 32 款头像 / 名片清洗 /
 *       发 X 文案与预填 URL / 后台钱包门槛静态校验；
 *       1.5.7：名片随时可改存、改名同步更新当日墙；
 *       1.5.8：X Layer / FabX 双链资产（FAB / 电路矿机 / 待领 / OKB / 算力 / 权限）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

const DIR = __dirname;
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}
function eq(name, got, want) { ok(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }

const ctx = {
  console, URL, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout,
  Promise, Date, Math, JSON, Number, String, Array, Object, RegExp, Error, Intl,
  Uint32Array, Uint8Array,
  crypto: webcrypto, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  module: undefined, globalThis: null
};
ctx.globalThis = ctx;
vm.createContext(ctx);
['wallet.js', 'tapeout-api.js', 'vote.js', 'bem-quotes.js'].forEach((f) => vm.runInContext(read(f), ctx, { filename: f }));
const Wallet = ctx.Wallet, TapeOutAPI = ctx.TapeOutAPI, Vote = ctx.Vote;
const BemQuotes = ctx.BemQuotes, BemAvatars = ctx.BemAvatars;

(async function () {
  console.log('\n== 1. 地址与本机加密 ==');
  eq('合法地址小写归一', Wallet.normalizeAddress('0x0C16F7536AD60FD7CBF925F6334AC7C6B7A93FD6'),
    '0x0c16f7536ad60fd7cbf925f6334ac7c6b7a93fd6');
  eq('拒收短地址', Wallet.normalizeAddress('0x1234'), null);
  eq('遮罩显示', Wallet.checksumHint('0x0c16f7536ad60fd7cbf925f6334ac7c6b7a93fd6'), '0x0c16…3fd6');
  eq('provider 名称', Wallet.providerName('okx'), 'OKX 欧意钱包');
  const key = Wallet.newKey(webcrypto), salt = Wallet.newSalt(webcrypto);
  eq('密钥长度 44(base64/32B)', key.length, 44);
  const sealed = await Wallet.encryptText(webcrypto, key, '0xabc-private-address');
  ok('密文不含地址明文', !JSON.stringify(sealed).includes('0xabc'), JSON.stringify(sealed).slice(0, 80));
  eq('AES-GCM 解密往返', await Wallet.decryptText(webcrypto, key, sealed), '0xabc-private-address');
  eq('错误密钥解不出', await Wallet.decryptText(webcrypto, Wallet.newKey(webcrypto), sealed), null);
  const v1 = await Wallet.voterId(webcrypto, salt, '2026-11-14');
  const v2 = await Wallet.voterId(webcrypto, salt, '2026-11-14');
  const v3 = await Wallet.voterId(webcrypto, salt, '2026-11-15');
  eq('同一天 voterId 稳定', v1, v2);
  ok('跨天 voterId 不同', v1 !== v3);
  eq('voterId 是 64 位十六进制', /^[0-9a-f]{64}$/.test(v1), true);

  console.log('\n== 2. 北京时间 / 投票统计 ==');
  // 2026-11-13T16:30Z = 北京时间 11-14 00:30
  eq('跨 UTC 日界按北京切天', Vote.dayKey(Date.parse('2026-11-13T16:30:00Z')), '2026-11-14');
  eq('北京时间小时', Vote.beijingHour(Date.parse('2026-11-14T12:00:00Z')), 20);
  eq('shiftDay 跨月', Vote.shiftDay('2026-11-01', -1), '2026-10-31');
  eq('recentDays 7 天', Vote.recentDays('2026-11-14', 7).length, 7);
  const days = {
    '2026-11-12': { support: 3, watch: 1 },
    '2026-11-13': { support: 5, watch: 2 },
    '2026-11-14': { support: 9, watch: 1 }
  };
  eq('累计支持票', Vote.tally(days).support, 17);
  eq('累计票数', Vote.tally(days).total, 21);
  eq('支持率', Vote.tally(days).supportPct, 81);
  eq('7 日趋势天数', Vote.trend(days, '2026-11-14', 7).length, 7);
  eq('趋势最后一天', Vote.trend(days, '2026-11-14', 7)[6].day, '2026-11-14');
  eq('连续打卡（含今天）', Vote.streak({ '2026-11-12': 'support', '2026-11-13': 'support', '2026-11-14': 'watch' }, '2026-11-14'), 3);
  eq('今天未打卡不断签', Vote.streak({ '2026-11-12': 'support', '2026-11-13': 'support' }, '2026-11-14'), 2);
  eq('今日需要打卡', Vote.needsCheckin({}, '2026-11-14'), true);
  eq('今日已打卡', Vote.needsCheckin({ '2026-11-14': 'support' }, '2026-11-14'), false);
  eq('合并本机 + 全网', Vote.mergeDays({ '2026-11-14': { support: 9, watch: 1 } },
    { '2026-11-14': { support: 1, watch: 0 } })['2026-11-14'].support, 10);
  const sum = Vote.summary({ days: days, localAdd: {}, history: { '2026-11-14': 'support' },
    config: Vote.normalizeConfig(null), ledgerAvailable: true, totalVotes: 21 }, Date.parse('2026-11-14T04:00:00Z'));
  eq('汇总来源=全网', sum.source, 'network');
  eq('汇总今日支持', sum.todayCount.support, 9);
  eq('汇总已打卡', sum.checkedIn, true);
  eq('汇总无需提醒', sum.needRemind, false);
  const local = Vote.summary({ days: {}, localAdd: {}, history: {},
    config: Vote.normalizeConfig(null), ledgerAvailable: false }, Date.parse('2026-11-14T04:00:00Z'));
  eq('断网来源=本机', local.source, 'local');
  eq('断网需要提醒', local.needRemind, true);

  console.log('\n== 3. 账本 URL 与安全校验 ==');
  const base = Vote.DEFAULT_LEDGER;
  ok('默认账本保留 sharecode', Vote.ledgerUrl(base, '/api/state').indexOf('sharecode=') > 0, Vote.ledgerUrl(base, '/api/state'));
  ok('state 路径正确', /\/api\/state\?/.test(Vote.ledgerUrl(base, '/api/state')));
  ok('vote 路径正确', /\/api\/vote\?/.test(Vote.ledgerUrl(base, '/api/vote')));
  ok('公开页路径正确', /\/vote\?/.test(Vote.publicPage(base)));
  eq('拒收 javascript:', Vote.sanitizeLedger('javascript:alert(1)'), base);
  eq('拒收 http 外网', Vote.sanitizeLedger('http://evil.example/'), base);
  ok('放行本机自托管', Vote.sanitizeLedger('http://127.0.0.1:3000/').indexOf('127.0.0.1') > 0);
  eq('提醒时间收敛到 0-23', Vote.normalizeConfig({ reminderHour: 99 }).reminderHour, 23);
  eq('解析账本响应', Vote.parseState({ ok: true, days: { '2026-11-14': { support: 2, watch: 1 } }, totalVotes: 3 }).days['2026-11-14'].support, 2);
  eq('拒收脏数据', Vote.parseState({ ok: false, days: {} }), null);

  console.log('\n== 4. TapeOut API 各接口解析（真机返回结构） ==');
  const portfolio = {
    schemaVersion: 2, asOf: '2026-11-14T02:31:26.000Z', sourceBlock: '133464153',
    walletBnb: '8464235944401766', recoveryBnb: '0',
    assets: [
      { name: 'Genesis CPU', walletBalances: { NAND: '10000', LATCH: '0' } },
      { name: 'Behemoth', walletBalances: { NAND: '7', LATCH: '4' } }
    ]
  };
  const p = TapeOutAPI.parsePortfolio(portfolio);
  eq('portfolio schemaVersion=2', p.schema, 2);
  ok('BNB wei 换算', Math.abs(p.bnb - 0.008464235944401766) < 1e-12, String(p.bnb));
  eq('NAND 合计', p.nand, 10007);
  eq('LATCH 合计', p.latch, 4);
  const cs = TapeOutAPI.parseCircuitSummary({ schemaVersion: 1, heldCount: 220,
    marketValueWei: '2097204930461499916572', totalProfitWei: '2054278220535099916572' });
  eq('矿机持有数', cs.heldCount, 220);
  ok('矿机市值 BNB', Math.abs(cs.marketValueBnb - 2097.2049) < 0.001, String(cs.marketValueBnb));
  const miners = TapeOutAPI.parseMiners({ asOf: '2026-11-14T02:30:53Z',
    miningPool: { tokenDecimals: 8, currentRateAtomic: '8333333' },
    rows: [{ status: 'mining', verifiedWeight: '294', estimated24hAtomic: '130311758' },
      { status: 'mining', verifiedWeight: '10', estimated24hAtomic: '0' },
      { status: 'idle', verifiedWeight: '0', estimated24hAtomic: null }] });
  eq('矿机行数', miners.count, 3);
  eq('挖矿中台数', miners.miningCount, 2);
  ok('预估日产 BEM', Math.abs(miners.dailyBem - 1.30311758) < 1e-8, String(miners.dailyBem));
  eq('tokenDecimals', miners.tokenDecimals, 8);
  const claims = TapeOutAPI.parseClaims({ totalClaimedAtomic: '2991976291826',
    claims: [{ claimedAt: '2026-11-13T05:03:01Z' }] });
  ok('累计已领取 BEM', Math.abs(claims.totalClaimedBem - 29919.76291826) < 1e-8, String(claims.totalClaimedBem));
  eq('签名读取 BEM 余额', TapeOutAPI.parseTapeRead({ ok: true, container: '0x1', sig: '0x2',
    result: { amount: '500.34187109', symbol: 'BEM', decimals: 8, blockPinned: { blockNumber: 133465953 } } }, 'tokenBalance').bem, 500.34187109);
  eq('签名失败不产出', TapeOutAPI.parseTapeRead({ ok: false, error: { code: 'BAD_REQUEST' } }, 'balance'), null);
  eq('schemaOf 兼容无版本', TapeOutAPI.schemaOf({ foo: 1 }, 1), 1);

  console.log('\n== 5. 资产汇总（版本协商 + 部分失败不拖垮） ==');
  const tapeEnvelope = (result) => ({ ok: true, container: '0x1', sig: '0x2',
    result: Object.assign({ blockPinned: { blockNumber: 133465953 } }, result) });
  // 1.5.8：FabX 账户挖矿快照（字段取自 api.fabx.tech/v1/accounts/{addr}/mining 真实返回）
  const fabxMining = {
    account: '0x0c16f7536ad60fd7cbf925f6334ac7c6b7a93fd6',
    tu: '13299600', tv: '382120998', balance: '10500000019', boost: 10000,
    global: { minerCount: '6959', verifMinerCount: '6843', totalMined: '15468830275624',
      currentRate: '8333333', UNVERIFIED_BPS: 100 },
    source: { chainId: 196, xmake: TapeOutAPI.FAB_TOKEN, circuits: TapeOutAPI.CIRCUITS_NFT },
    blockNumber: '75874297', generatedAt: 1794643363468,
    items: [
      { id: 933, live: '49763741', miner: { status: 1, verifWeight: '8400' },
        effective: { verifWeight: '8400', unverWeight: '0' } },
      { id: 934, live: '20000000', miner: { status: 0 },
        effective: { verifWeight: '0', unverWeight: '500' } }
    ]
  };
  // batch RPC：FAB ERC-20 / 电路 ERC-721 / 原生 OKB
  const rpcBatch = [
    { jsonrpc: '2.0', id: 1, result: '0x0000000000000000000000000000000000000000000000000000000271d94913' },
    { jsonrpc: '2.0', id: 2, result: '0x0000000000000000000000000000000000000000000000000000000000000002' },
    { jsonrpc: '2.0', id: 3, result: '0x145eae7e28607af4' }
  ];
  const mockFetch = (url, init) => {
    let body = null;
    if (/\/account\/.*\/portfolio/.test(url)) body = portfolio;
    else if (/\/account\/.*\/circuit-summary/.test(url)) body = { heldCount: 220, marketValueWei: '2097204930461499916572' };
    else if (/\/pod\/miners\//.test(url)) body = { miningPool: { tokenDecimals: 8 }, rows: [{ status: 'mining', estimated24hAtomic: '130311758' }] };
    else if (/\/pod\/claims\//.test(url)) body = { totalClaimedAtomic: '2991976291826', claims: [] };
    else if (/\/tokenBalance$/.test(url)) body = tapeEnvelope({ amount: '500.34187109', symbol: 'BEM', decimals: 8 });
    else if (/\/balance$/.test(url)) body = tapeEnvelope({ bnb: '0.008464235944401766', wei: '8464235944401766' });
    else if (/\/bnbUsd$/.test(url)) body = tapeEnvelope({ bnbUsd: '623.4369' });
    else if (/\/v1\/accounts\//.test(url)) body = fabxMining;
    else if (/rpc\.xlayer\.tech|xlayerrpc\.okx\.com/.test(url)) body = rpcBatch;
    else if (/\/failing/.test(url)) return Promise.resolve({ ok: false, status: 503 });
    if (!body) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  const A = '0x0c16f7536ad60fd7cbf925f6334ac7c6b7a93fd6';
  const bundle = await TapeOutAPI.fetchAssets(mockFetch, A, { priceUsd: 0.01047 });
  eq('汇总 ok', bundle.ok, true);
  eq('TapeAPI 版本', bundle.versions.tapeapi, '3.0.0');
  eq('schemaVersions.portfolio', bundle.versions.schemaVersions.portfolio, 2);
  eq('schemaVersions.circuits 兼容旧版', bundle.versions.schemaVersions.circuits, 1);
  eq('链上签名读取标记', bundle.versions.chainSigned, true);
  eq('本机未验签标记', bundle.versions.signatureVerifiedLocally, false);
  ok('持仓 BEM 来自签名读取', Math.abs(bundle.bem.balance - 500.34187109) < 1e-8);
  ok('BNB 来自签名读取', Math.abs(bundle.bnb.balance - 0.008464235944401766) < 1e-12);
  ok('持仓美元估值', bundle.bem.balanceUsd > 5 && bundle.bem.balanceUsd < 6, String(bundle.bem.balanceUsd));
  eq('矿机台数', bundle.circuits.count, 220);
  ok('预估日产 BEM', Math.abs(bundle.circuits.dailyBem - 1.30311758) < 1e-8);
  eq('NAND 数量', bundle.transistors.nand, 10007);
  eq('无失败项', bundle.errors.length, 0);
  eq('拒绝非法地址', (await TapeOutAPI.fetchAssets(mockFetch, 'not-an-address')).ok, false);
  eq('compact 大数', TapeOutAPI.compact(12345678), '12.35M');

  console.log('\n== 5b. 1.5.8 X Layer / FabX 双链汇总 ==');
  const xl = bundle.xlayer || {};
  eq('X Layer 快照可读', xl.ok, true);
  eq('X Layer chainId', xl.chainId, 196);
  eq('versions 记录 X Layer 链', bundle.versions.xlayerChainId, 196);
  eq('versions 记录 FabX 索引版本', bundle.versions.fabx, 'v1');
  ok('FAB 余额优先取链上 RPC', Math.abs(xl.balance - 105.00000019) < 1e-8, String(xl.balance));
  eq('矿机台数取 ERC-721 balanceOf', xl.miners, 2);
  eq('登记挖矿矿机数', xl.registeredMiners, 2);
  eq('挖矿中台数', xl.activeMiners, 1);
  ok('待领 FAB 汇总', Math.abs(xl.pending - 0.69763741) < 1e-8, String(xl.pending));
  ok('预估日产 FAB 为正', xl.daily > 0 && xl.daily < 100, String(xl.daily));
  eq('已验证算力权重', xl.verifiedWeight, 8400);
  eq('未验证算力权重', xl.unverifiedWeight, 500);
  ok('OKB 余额来自 eth_getBalance', xl.okb > 1 && xl.okb < 2, String(xl.okb));
  eq('全网矿机数', xl.network.minerCount, 6959);
  eq('加成 bps', xl.boost, 10000);
  eq('X Layer 区块号', xl.block, 75874297);
  eq('FabX 索引来源标记', bundle.sources.xlayerFabx, true);
  eq('X Layer RPC 来源标记', bundle.sources.xlayerRpc, true);
  eq('双链汇总仍无失败项', bundle.errors.length, 0);
  ok('X Layer 快照不含查询地址', !JSON.stringify(xl).includes(A));
  eq('地址补全到 64 位', TapeOutAPI.addrWord(A).length, 64);
  ok('eth_call data 前缀正确', TapeOutAPI.rpcPayloads(A)[0].params[0].data.startsWith('0x70a08231'));
  eq('batch 恰好 3 个只读调用', TapeOutAPI.rpcPayloads(A).length, 3);
  ok('batch 不含任何写入方法', TapeOutAPI.rpcPayloads(A).every((x) => /^(eth_call|eth_getBalance)$/.test(x.method)));
  ok('hexToUnits 精确换算 8 位小数', Math.abs(TapeOutAPI.hexToUnits('0x271d94913', 8) - 105.00000019) < 1e-8);
  ok('hexToUnits 支持 18 位小数', Math.abs(TapeOutAPI.hexToUnits('0xde0b6b3a7640000', 18) - 1) < 1e-12);
  eq('hexToUnits 拒收脏数据', TapeOutAPI.hexToUnits('0xZZ', 8), null);
  eq('hexToUnits 零余额返回 0 而非 null', TapeOutAPI.hexToUnits('0x0', 18), 0);
  eq('hexToUnits 长零串也返回 0', TapeOutAPI.hexToUnits('0x0000000000000000000000000000000000000000000000000000000000000000', 8), 0);
  eq('parseRpcBatch 乱序 id 仍可解析', TapeOutAPI.parseRpcBatch([rpcBatch[2], rpcBatch[0], rpcBatch[1]]).circuitsHeld, 2);
  eq('parseRpcBatch 拒收单个对象', TapeOutAPI.parseRpcBatch(rpcBatch[0]), null);
  eq('parseFabxMining 拒绝串地址', TapeOutAPI.parseFabxMining(fabxMining, '0x1111111111111111111111111111111111111111'), null);
  eq('parseFabxMining 拒绝缺 items', TapeOutAPI.parseFabxMining({ account: A }, A), null);

  // 两条链互不拖垮：X Layer 成功 / BSC 全失败，以及 X Layer 全失败 / BSC 成功
  const onlyXl = await TapeOutAPI.fetchAssets((url) => /api\.fabx\.tech|rpc\.xlayer\.tech|xlayerrpc/.test(url)
    ? mockFetch(url) : Promise.resolve({ ok: false, status: 503 }), A);
  eq('BSC 全挂仍返回 X Layer', onlyXl.xlayer.ok, true);
  eq('BSC 全挂时 BEM 为空', onlyXl.bem.balance, null);
  ok('BSC 全挂时错误只记 BSC', onlyXl.errors.length === 7 && onlyXl.errors.every((e) => !/^xlayer/.test(e)), String(onlyXl.errors.length));
  const onlyBsc = await TapeOutAPI.fetchAssets((url) => /api\.fabx\.tech|rpc\.xlayer\.tech|xlayerrpc/.test(url)
    ? Promise.resolve({ ok: false, status: 503 }) : mockFetch(url), A);
  eq('X Layer 全挂不影响 BSC', onlyBsc.bem.balance, 500.34187109);
  eq('X Layer 全挂时快照标记失败', onlyBsc.xlayer.ok, false);
  ok('X Layer 全挂时仍展示 BSC 数字', onlyBsc.circuits.count === 220);
  ok('X Layer 失败项单独记录', onlyBsc.errors.some((e) => /^xlayer/.test(e)));
  const xlFabxOnly = await TapeOutAPI.fetchXLayer((url) => /rpc\.xlayer\.tech|xlayerrpc/.test(url)
    ? Promise.resolve({ ok: false, status: 503 }) : mockFetch(url), A);
  ok('RPC 挂了仍能用索引层 FAB 余额', Math.abs(xlFabxOnly.data.balance - 105.00000019) < 1e-8);
  eq('RPC 挂了矿机数回退登记数', xlFabxOnly.data.miners, 2);

  console.log('\n== 6. 1.5.6 钱包门槛 / 名片 / 10000 条话语 / 发 X ==');
  const A2 = '0x0C16F7536AD60FD7CBF925F6334AC7C6B7A93FD6';
  const h1 = await Wallet.walletVoterId(webcrypto, A2, '2026-11-14');
  const h2 = await Wallet.walletVoterId(webcrypto, A2.toLowerCase(), '2026-11-14');
  const h3 = await Wallet.walletVoterId(webcrypto, A2, '2026-11-15');
  const h4 = await Wallet.walletVoterId(webcrypto, '0x1111111111111111111111111111111111111111', '2026-11-14');
  eq('地址哈希 64 位十六进制', /^[0-9a-f]{64}$/.test(h1), true);
  eq('大小写地址归一后哈希一致', h1, h2);
  ok('同地址同日重算一致（跨设备去重）', h1 === await Wallet.walletVoterId(webcrypto, A2, '2026-11-14'));
  ok('跨天哈希不同', h1 !== h3);
  ok('不同地址哈希不同', h1 !== h4);
  ok('哈希不含明文地址', !h1.includes(A2.slice(2).toLowerCase()));
  eq('非法地址返回 null', await Wallet.walletVoterId(webcrypto, 'bad', '2026-11-14'), null);

  eq('话语文库恰好 10000 条', BemQuotes.COUNT, 10000);
  eq('话语数组长度', BemQuotes.LINES.length, 10000);
  eq('话语库自检通过', BemQuotes.validate().ok, true);
  eq('话语库唯一数', BemQuotes.validate().unique, 10000);
  ok('随机抽句来自库内', BemQuotes.LINES.indexOf(BemQuotes.pick()) >= 0);
  eq('按种子抽句稳定', BemQuotes.pickBySeed('abc'), BemQuotes.pickBySeed('abc'));
  ok('按种子抽句来自库内', BemQuotes.LINES.indexOf(BemQuotes.pickBySeed('abc')) >= 0);
  eq('内置头像 32 款', BemAvatars.COUNT, 32);
  eq('非法头像回落 a01', BemAvatars.normalize('a99'), 'a01');
  ok('合法头像有 emoji 与背景色', !!BemAvatars.get('a07').e && /^#/.test(BemAvatars.get('a07').c));

  ok('昵称去掉标签符号', !/[<>&]/.test(Vote.cleanName('<script>昆哥</script>')));
  eq('昵称截断 16 码点', Array.from(Vote.cleanName('一二三四五六七八九十甲乙丙丁戊己庚辛')).length, 16);
  eq('名片头像回落', Vote.normalizeProfile({ name: '昆哥', avatar: 'zzz' }).avatar, 'a01');
  eq('名片头像合法保留', Vote.normalizeProfile({ name: '昆哥', avatar: 'a07' }).avatar, 'a07');
  ok('默认名不含完整地址', Vote.defaultName('0x0c16…3fd6').indexOf('0x0c16f753') < 0);
  eq('北京时间 HH:MM', Vote.beijingClock(Date.parse('2026-11-14T06:30:00Z')), '14:30');
  const tw = Vote.tweetText('稳住，等下一次升级。', '昆哥', '2026-11-14', '14:30', 'https://example.com/vote');
  ok('X 文案含话语', tw.includes('稳住'));
  ok('X 文案含昵称与时间', tw.includes('昆哥') && tw.includes('14:30'));
  ok('X 文案含话题标签', tw.includes('#BEM'));
  ok('X 预填 URL 正确', Vote.postUrl(tw).startsWith('https://x.com/intent/tweet?text='));
  ok('X 预填 URL 已编码', Vote.postUrl(tw).includes('%23BEM'));
  const st156 = Vote.parseState({ ok: true, days: { '2026-11-14': { support: 1, watch: 0 } },
    totalVotes: 1, version: 2, supporters: { '2026-11-14': [
      { voterId: 'd'.repeat(64), name: '<b>昆哥</b>', avatar: 'a07', quote: '稳住',
        at: '2026-11-14T06:30:00Z', clock: '14:30' }
    ] } });
  ok('parseState 解析 supporters', !!st156 && st156.supporters['2026-11-14'].length === 1);
  ok('supporters 昵称已清洗', !/[<>]/.test(st156.supporters['2026-11-14'][0].name));
  const sum156 = Vote.summary({ days: {}, localAdd: {}, history: { '2026-11-14': 'support' }, pending: [],
    config: Vote.normalizeConfig(null), ledgerAvailable: true,
    walletBound: true, profile: { name: '昆哥', avatar: 'a07' },
    lastQuote: '稳住，等下一次升级。', lastQuoteAt: '2026-11-14T06:30:00.000Z',
    supporters: st156.supporters }, Date.parse('2026-11-14T07:00:00Z'));
  eq('summary 钱包门槛已绑定', sum156.walletBound, true);
  eq('summary 带上话语', sum156.quote, '稳住，等下一次升级。');
  ok('summary 生成发 X URL', sum156.postUrl.startsWith('https://x.com/intent/tweet?text='));
  eq('summary 当日上墙人数', sum156.supporters.length, 1);
  const bg156 = read('background.js');
  ok('后台加载 bem-quotes.js', /importScripts\('bem-quotes\.js'\)/.test(bg156));
  ok('VOTE_CAST 后台校验钱包绑定', /VOTE_CAST[\s\S]{0,400}readBinding\(\)/.test(bg156));
  ok('VOTE_CAST 用地址哈希', /walletVoterId\(CRYPTO, binding\.address, day\)/.test(bg156));
  ok('voteBody 带名片与话语', /name: p\.name[\s\S]{0,200}quote: p\.quote/.test(bg156));
  ok('未绑定时拒绝打卡', /请先连接钱包，才能为 \$BEM 打卡/.test(bg156));
  const pop156 = read('popup.js');
  ok('popup 未绑定时禁用按钮', /disabled = !sum\.walletBound/.test(pop156));
  ok('popup 有发 X 按钮逻辑', /votePostX/.test(pop156) && /x\.com\/intent\/tweet/.test(read('vote.js')));

  console.log('\n== 6b. 1.5.7 名片可改存 / 改名后同步更新当日信仰者墙 ==');
  const profOld = Vote.normalizeProfile({ name: '昆哥', avatar: 'a07' });
  const profNew = Vote.normalizeProfile({ name: '阿昆 <b>', avatar: 'a21' });
  eq('新昵称已清洗标签', profNew.name, '阿昆 b');
  eq('新头像已保存', profNew.avatar, 'a21');
  ok('头像确实可更换', profNew.avatar !== profOld.avatar && profNew.name !== profOld.name);
  eq('名片归一化幂等', JSON.stringify(Vote.normalizeProfile(profNew)), JSON.stringify(profNew));
  const base157 = { days: {}, localAdd: {}, history: { '2026-11-14': 'support' }, pending: [],
    config: Vote.normalizeConfig(null), ledgerAvailable: true, walletBound: true,
    lastQuote: '稳住，等下一次升级。', lastQuoteAt: '2026-11-14T06:30:00.000Z',
    supporters: st156.supporters };
  const sumOld = Vote.summary(Object.assign({}, base157, { profile: profOld }), Date.parse('2026-11-14T07:00:00Z'));
  const sumNew = Vote.summary(Object.assign({}, base157, { profile: profNew }), Date.parse('2026-11-14T07:00:00Z'));
  eq('summary 回显新昵称', sumNew.profile.name, '阿昆 b');
  eq('summary 回显新头像', sumNew.profile.avatar, 'a21');
  ok('改名后发 X 预填含新昵称', decodeURIComponent(sumNew.postUrl).includes('阿昆 b'));
  ok('改名后发 X 预填不含旧昵称', !decodeURIComponent(sumNew.postUrl).includes('— 昆哥'));
  eq('改名不更换激励话语', sumNew.quote, sumOld.quote);
  eq('改名不更换打卡时间', Vote.beijingClock(Date.parse(sumNew.quoteAt)), Vote.beijingClock(Date.parse(sumOld.quoteAt)));
  ok('改名不改变当日票数', sumNew.todayCount.support === sumOld.todayCount.support);
  const bg157 = read('background.js');
  ok('VOTE_PROFILE 保存本机名片', /msg\.type === 'VOTE_PROFILE'[\s\S]{0,600}\[K_PROFILE\]: profile/.test(bg157));
  ok('只在当天已投 support 时同步上墙', /st\.history\[day\] === 'support'/.test(bg157));
  ok('复用上次话语与时间', /st\.lastQuote \|\| BemQuotes\.pick\(\)/.test(bg157) && /st\.lastQuoteAt \|\|/.test(bg157));
  ok('同 stance 重投不重复计票', /stance: 'support'[\s\S]{0,300}voterId: voter/.test(bg157));
  ok('断网更新包进 pending', /wallPending = true[\s\S]{0,80}|st\.pending\.push\(payload\)/.test(bg157));
  ok('替换同日旧待补投票', /p\.day === day && p\.stance === 'support'/.test(bg157));
  const pop157 = read('popup.js'), html157 = read('popup.html');
  ok('popup 有显式保存按钮绑定', /voteProfileSave[\s\S]{0,80}saveProfile\(\)/.test(pop157));
  ok('昵称输入 debounce 自动保存', /setTimeout\(\(\) => saveProfile\(\{ auto: true \}\), 650\)/.test(pop157));
  ok('保存后回显并刷新发 X URL', /renderVote\(r\.summary\)[\s\S]{0,400}wallUpdated/.test(pop157));
  ok('头像宫格移到主区且默认收起', /id="voteAvatarGrid" hidden/.test(html157));
  ok('折叠设置里不再重复放头像宫格', (html157.match(/id="voteAvatarGrid"/g) || []).length === 1);

  console.log('\n== 6c. 1.5.8 面板 / 权限 / 合规静态校验 ==');
  const html158 = read('popup.html'), pop158 = read('popup.js'), bg158 = read('background.js');
  const man158 = JSON.parse(read('manifest.json')), list158 = JSON.parse(read('store/listing.json'));
  const priv158 = read('docs/privacy.html'), privSite158 = read('store/privacy-site/index.html');
  ['xlMiners', 'xlActive', 'xlDaily', 'xlFab', 'xlPending', 'xlOkb'].forEach((id) => {
    ok('X Layer 面板有 ' + id, html158.includes('id="' + id + '"'));
  });
  ok('X Layer 六格独立分组', /class="asset-grid xlayer-grid"/.test(html158));
  ok('BSC 与 X Layer 双链头', /BSC · TapeOut/.test(html158) && /X Layer · FabX/.test(html158));
  ok('手动地址占位改为双链通用', /BSC \/ X Layer 通用/.test(html158));
  ok('popup 有 renderXLayer', /function renderXLayer\(x\)/.test(pop158));
  ok('popup 渲染 X Layer 数字', /wbxText\('xlFab', fmtAsset\(x\.balance\)\)/.test(pop158));
  ok('面板标注日产为估算', /仅供参考/.test(pop158));
  ok('后台对旧缓存自动补取双链', /cached && cached\.xlayer && cached\.fetchedAt/.test(bg158));
  eq('manifest 版本', man158.version, '1.5.17');
  eq('listing 版本', list158.version, '1.5.17');
  eq('permissions 仍 9 项', man158.permissions.length, 9);
  eq('host_permissions 34 条（1.5.16 移除 tapeup.io 两条）', man158.host_permissions.length, 34);
  ['https://api.fabx.tech/*', 'https://rpc.xlayer.tech/*', 'https://xlayerrpc.okx.com/*'].forEach((h) => {
    ok('新增主机权限 ' + h, man158.host_permissions.includes(h));
  });
  eq('FAB 合约地址', TapeOutAPI.FAB_TOKEN, '0x72f349b1eee7833b26f8c81a8410775a4e231ed2');
  eq('电路 NFT 合约地址', TapeOutAPI.CIRCUITS_NFT, '0x87bfca3494aa228ff589ab9b642143a5e8c8f9a6');
  eq('FAB 8 位小数', TapeOutAPI.FAB_DECIMALS, 8);
  eq('X Layer chainId', TapeOutAPI.XLAYER_CHAIN_ID, 196);
  ok('隐私政策列出 FabX 接口与 34 条口径', priv158.includes('api.fabx.tech') && priv158.includes('34 条'));
  ok('独立部署副本同步', privSite158.includes('api.fabx.tech') && privSite158.includes('34 条'));
  ok('上架资料列出三条新域名', ['api.fabx.tech', 'rpc.xlayer.tech', 'xlayerrpc.okx.com']
    .every((h) => JSON.stringify(list158).includes(h)));
  ok('上架详细描述含 1.5.17 说明', list158.detailed_description[0].startsWith('【1.5.17'));
  ok('上架详细描述保留 1.5.16 下线说明', list158.detailed_description.some((x) => String(x).startsWith('【1.5.16')));
  ok('商店描述不超 132 字', man158.description.length <= 132 && list158.summary_132.length <= 132);
  ok('UI 版本兜底统一 1.5.17', /v1\.5\.17/.test(html158) && /v1\.5\.17/.test(read('panel.html')) &&
    /v1\.5\.17/.test(read('content.js')) && /v1\.5\.17/.test(pop158));

  console.log('\n== 7. 钱包地址不出缓存 / 不出 popup 消息 ==');
  const bgSrc = read('background.js');
  const fnMatch = bgSrc.match(/function publicAssets\(a\) \{[\s\S]*?\n  \}/);
  ok('后台定义了 publicAssets 脱敏函数', !!fnMatch && /delete out\.address/.test(fnMatch[0]));
  if (fnMatch) {
    vm.runInContext(fnMatch[0], ctx, { filename: 'publicAssets.extract' });
    const cleaned = ctx.publicAssets(bundle);
    eq('脱敏后资产数字仍在', cleaned.bem.balance, bundle.bem.balance);
    eq('脱敏后无 address 字段', cleaned.address, undefined);
    ok('脱敏后 JSON 不含完整地址', !JSON.stringify(cleaned).includes(A));
    eq('脱敏不污染原始快照', bundle.address, A.toLowerCase());
  }
  ok('资产缓存写入前已脱敏', /sset\(\{ \[K_ASSETS\]: clean \}\)/.test(bgSrc));
  ok('首屏缓存读出时也脱敏', /const cached = publicAssets\(/.test(bgSrc));

  console.log('\n== 8. 线上只读冒烟（--live） ==');
  if (process.argv.indexOf('--live') >= 0) {
    try {
      const health = await (await fetch(Vote.ledgerUrl(base, '/api/health'))).json();
      ok('在线账本 health', health.ok === true, JSON.stringify(health));
      const st = await (await fetch(Vote.ledgerUrl(base, '/api/state'))).json();
      ok('在线账本 state', Vote.parseState(st) !== null, JSON.stringify(st).slice(0, 120));
      const live = await TapeOutAPI.fetchAssets(fetch, A, { priceUsd: 0.01047 });
      ok('真实资产接口可达', live.ok === true && live.bem.balance != null, JSON.stringify(live.errors));
      console.log('    线上快照：矿机 ' + live.circuits.count + ' 台 / 持仓 ' + live.bem.balance + ' BEM / 已领取 ' + live.bem.claimedTotal);
      ok('真实 X Layer 快照可读', live.xlayer && live.xlayer.ok === true, JSON.stringify(live.xlayer && live.xlayer.errors));
      ok('真实 FAB 余额为数字', live.xlayer && typeof live.xlayer.balance === 'number');
      ok('真实 OKB 余额为数字', live.xlayer && typeof live.xlayer.okb === 'number');
      // 公开地址（链上确有 2 台 FabX 电路矿机），验证非零路径而不是只测空钱包
      const XL_ADDR = '0xdbf522c712f970a2df547492df6550a06afc96bc';
      const xlLive = await TapeOutAPI.fetchXLayer(fetch, XL_ADDR);
      ok('真实 FabX 索引可达', xlLive.data.sources.fabx === true);
      ok('真实 X Layer RPC 可达', xlLive.data.sources.rpc === true);
      ok('真实地址有 FAB / 矿机', xlLive.data.balance > 0 && xlLive.data.miners >= 1,
        'FAB=' + xlLive.data.balance + ' miners=' + xlLive.data.miners);
      console.log('    X Layer 线上快照：FAB ' + xlLive.data.balance + ' / 矿机 ' + xlLive.data.miners +
        ' 台 / 待领 ' + xlLive.data.pending + ' / 预估日产 ' + xlLive.data.daily + ' / OKB ' + xlLive.data.okb);
    } catch (e) { ok('线上冒烟', false, String(e && e.message || e)); }
  } else {
    console.log('    （跳过，加 --live 可对账本与 TapeOut API 做只读连通性验证）');
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
