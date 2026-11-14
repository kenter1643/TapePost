/* TapePost 1.5.5 · 钱包 / TapeOut API 资产 / BEM 全网账本 专项自检
 * 运行：node test-wallet-vote-assets.js            （纯本地模拟，不进商店包）
 *       node test-wallet-vote-assets.js --live     （额外对线上只读接口做连通性冒烟，不投票）
 * 覆盖：地址校验 / AES-GCM 加密往返 / 每日匿名 voterId / 北京时间切天 /
 *       按天累计 / 连续打卡 / 账本 URL 保留 sharecode / 各接口解析与版本协商 /
 *       混合成功失败的资产汇总 / 本机账本降级合并 / 钱包地址脱敏；
 *       1.5.6：钱包地址哈希跨设备去重 / 10000 条话语文库 / 32 款头像 / 名片清洗 /
 *       发 X 文案与预填 URL / 后台钱包门槛静态校验。
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
  const mockFetch = (url, init) => {
    let body = null;
    if (/\/account\/.*\/portfolio/.test(url)) body = portfolio;
    else if (/\/account\/.*\/circuit-summary/.test(url)) body = { heldCount: 220, marketValueWei: '2097204930461499916572' };
    else if (/\/pod\/miners\//.test(url)) body = { miningPool: { tokenDecimals: 8 }, rows: [{ status: 'mining', estimated24hAtomic: '130311758' }] };
    else if (/\/pod\/claims\//.test(url)) body = { totalClaimedAtomic: '2991976291826', claims: [] };
    else if (/\/tokenBalance$/.test(url)) body = tapeEnvelope({ amount: '500.34187109', symbol: 'BEM', decimals: 8 });
    else if (/\/balance$/.test(url)) body = tapeEnvelope({ bnb: '0.008464235944401766', wei: '8464235944401766' });
    else if (/\/bnbUsd$/.test(url)) body = tapeEnvelope({ bnbUsd: '623.4369' });
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
    } catch (e) { ok('线上冒烟', false, String(e && e.message || e)); }
  } else {
    console.log('    （跳过，加 --live 可对账本与 TapeOut API 做只读连通性验证）');
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
