/* TapePost 1.5.13 · TapeUP「我的资产」采集专项自检
 * 运行：node test-tapeup-assets.js   （不进 Chrome Web Store 商店包）
 *
 * 背景：用户问「凭钱包地址能不能读到 tapeup.io/zh/trade/assets 的我的资产」。
 * 实测该站整站 Cloudflare（后台 fetch 403），且「待释放 / 可加速释放」是 PoB
 * 买入预算、不是链上锁仓，balanceOf 读不到。所以沿用 1.4.16 内盘价的办法：
 * 由已注入 tapeup.io 全站的 tapeup-price.js 在用户浏览器里读页面文本，
 * TapePrice.extractAssets 多策略解析 → TAPUP_ASSETS 回传 → 后台清洗入本机缓存
 * → 弹窗新增 TapeUP 资产区。全程不新增权限、不新增域名、不新增运行时文件。
 *
 * 本脚本在 vm 里加载真实的 tapeup-price.js + price.js，验证纯解析链路与
 * 内容脚本的消息行为，并对后台 / 弹窗接线做源码断言。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DIR = __dirname;
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const T = require(path.join(DIR, 'price.js'));
const man = require(path.join(DIR, 'manifest.json'));
const listing = require(path.join(DIR, 'store/listing.json'));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name); }
}
function eq(name, actual, expect) { ok(actual === expect, name + '（实际 ' + JSON.stringify(actual) + '）'); }

/* ---------- 1. 纯文本多策略解析 ---------- */

const TABLE_ZH = `<div>我的资产</div><div>共 1 个代币</div>
<table><tr><th>名称</th><th>持仓</th><th>待释放</th><th>可加速释放</th><th>持仓估值</th><th>24H涨跌幅</th><th>操作</th></tr>
<tr><td>UP</td><td>123.4567</td><td>8.78358728 BEM</td><td>3.21000000 BEM</td><td>$31.81</td><td>+19.44%</td><td>卖出</td></tr></table>
<div>持仓明细</div>`;

const TABLE_EN = `<div>Total 1 token</div>
<table><tr><th>Token</th><th>Balance</th><th>Pending</th><th>Boostable</th><th>Value</th><th>24h Change</th><th>Action</th></tr>
<tr><td>UP</td><td>50</td><td>9.5 BEM</td><td>2 BEM</td><td>USD 15.20</td><td>-3.10%</td><td>Sell</td></tr></table>`;

const CARD = `<div>共 2 个代币</div><div>持仓 88.5 UP</div><div>待释放 8.78358728 BEM</div>
<div>可加速释放 3.21 BEM</div><div>持仓估值 $27.60</div><div>24H涨跌幅 +12.30%</div>`;

const EMPTY = `<div>共 0 个代币</div>
<div>名称持仓待释放可加速释放持仓估值24H涨跌幅操作</div><div>请先连接钱包</div>`;

const HEADER_ONLY = `<div>共 0 个代币</div><div>名称持仓待释放可加速释放持仓估值24H涨跌幅操作</div>`;

const rZh = T.extractAssets(TABLE_ZH);
ok(rZh.ok === true, '中文表格：ok=true');
ok(rZh.connected === true, '中文表格：已连接');
eq('中文表格：代币数', rZh.tokenCount, 1);
eq('中文表格：代币名', rZh.tokenName, 'UP');
eq('中文表格：命中 5 列', Object.keys(rZh.fields).length, 5);
eq('中文表格：持仓', rZh.fields.held.value, 123.4567);
eq('中文表格：待释放', rZh.fields.pending.value, 8.78358728);
eq('中文表格：待释放单位', rZh.fields.pending.unit, 'BEM');
eq('中文表格：可加速释放', rZh.fields.boostable.value, 3.21);
eq('中文表格：持仓估值（$ 前缀）', rZh.fields.valueUsd.value, 31.81);
eq('中文表格：24H 涨跌', rZh.fields.changePct.value, 19.44);
eq('中文表格：策略', rZh.strategy, 'columns');
ok(rZh.headerFound === true, '中文表格：表头命中');

const rEn = T.extractAssets(TABLE_EN);
ok(rEn.ok === true, '英文表头：ok=true');
eq('英文表头：持仓', rEn.fields.held.value, 50);
eq('英文表头：估值（USD 前缀）', rEn.fields.valueUsd.value, 15.2);
eq('英文表头：涨跌为负', rEn.fields.changePct.value, -3.1);
eq('英文表头：待释放', rEn.fields.pending.value, 9.5);

const rCard = T.extractAssets(CARD);
ok(rCard.ok === true, '卡片布局：ok=true');
eq('卡片布局：命中 5 列', Object.keys(rCard.fields).length, 5);
eq('卡片布局：持仓', rCard.fields.held.value, 88.5);
eq('卡片布局：估值', rCard.fields.valueUsd.value, 27.6);
eq('卡片布局：涨跌', rCard.fields.changePct.value, 12.3);
eq('卡片布局：策略', rCard.strategy, 'labels');

const rEmpty = T.extractAssets(EMPTY);
ok(rEmpty.ok === false, '未连接钱包：不写缓存');
ok(rEmpty.connected === false, '未连接钱包：connected=false');
eq('未连接钱包：字段为空', Object.keys(rEmpty.fields).length, 0);
ok(/连接钱包/.test(rEmpty.note), '未连接钱包：给出原因');

const rZero = T.extractAssets(HEADER_ONLY);
ok(rZero.connected === false, '「共 0 个代币」视为空态');
eq('纯表头：不把「估值24」误当持仓', Object.keys(rZero.fields).length, 0);

const rNone = T.extractAssets('');
ok(rNone.ok === false && rNone.textLen === 0, '空页面：安全返回');

// 页面里出现长地址也只解析数值，不带进结果
const WITH_ADDR = TABLE_ZH.replace('我的资产', '我的资产 0x1234567890abcdef1234567890abcdef12345678');
const rAddr = T.extractAssets(WITH_ADDR);
ok(!/0x[0-9a-f]{40}/i.test(JSON.stringify(rAddr)), '页面里的钱包地址不进解析结果');

/* ---------- 2. 回传前白名单清洗 ---------- */

const dirty = Object.assign({}, rZh, {
  at: 1700000000000,
  address: '0x1234567890abcdef1234567890abcdef12345678',
  html: '<div>'.repeat(500),
  fields: Object.assign({}, rZh.fields, {
    evil: { value: 999, raw: 'x'.repeat(500) },
    held: { value: 123.4567, raw: 'y'.repeat(200), unit: 'z'.repeat(50) }
  })
});
const c = T.cleanAssets(dirty);
ok(!!c, 'cleanAssets：返回对象');
eq('cleanAssets：来源固定', c.source, 'tapeup.io 我的资产页');
eq('cleanAssets：时间保留', c.at, 1700000000000);
eq('cleanAssets：字段白名单', Object.keys(c.fields).length, 5);
ok(!c.address && !c.html && !c.fields.evil, 'cleanAssets：地址 / 长文本 / 未知字段被丢弃');
ok(c.fields.held.raw.length <= 32, 'cleanAssets：raw 限长 32');
ok(c.fields.held.unit.length <= 8, 'cleanAssets：unit 限长 8');
eq('cleanAssets：数值保留', c.fields.held.value, 123.4567);
ok(T.cleanAssets(null) === null, 'cleanAssets：null 安全');
ok(T.cleanAssets({ fields: {} }) === null, 'cleanAssets：无有效字段返回 null');
ok(T.ASSET_KEYS.length === 5, 'ASSET_KEYS 导出 5 列');

/* ---------- 3. vm 加载真实内容脚本，验证消息链路 ---------- */

function runScript(html, pathname) {
  const sent = [];
  const elements = {};
  function mkEl() {
    return { id: '', __open: false, style: {}, textContent: '', title: '',
      setAttribute() {}, addEventListener() {}, appendChild() {} };
  }
  const body = { appendChild(el) { elements[el.id] = el; } };
  const doc = {
    readyState: 'complete',
    documentElement: { outerHTML: '<html><body>' + html + '</body></html>' },
    body: body,
    getElementById(id) { return elements[id] || null; },
    createElement() { return mkEl(); },
    addEventListener() {}
  };
  const sandbox = {
    window: { TapePrice: T },
    document: doc,
    location: { pathname: pathname, search: '' },
    chrome: { runtime: { sendMessage(msg, cb) { sent.push(msg); if (cb) cb(); } } },
    setInterval() { return 0; },
    setTimeout() { return 0; },
    clearTimeout() {},
    console: console
  };
  vm.createContext(sandbox);
  vm.runInContext(read('tapeup-price.js'), sandbox, { filename: 'tapeup-price.js' });
  return { sent: sent, elements: elements };
}

const live = runScript(TABLE_ZH, '/zh/trade/assets');
const wake = live.sent.filter((m) => m.type === 'TAPE_WAKE');
const assets = live.sent.filter((m) => m.type === 'TAPUP_ASSETS');
eq('内容脚本：资产页先发 TAPE_WAKE', wake.length, 1);
eq('内容脚本：资产页回传 TAPUP_ASSETS', assets.length, 1);
const pl = assets[0] && assets[0].payload;
ok(pl && pl.ok === true && pl.connected === true, '内容脚本：payload 标记已连接');
eq('内容脚本：payload 代币名', pl && pl.tokenName, 'UP');
eq('内容脚本：payload 字段数', pl && Object.keys(pl.fields).length, 5);
ok(pl && pl.at > 0, '内容脚本：payload 带采集时间');
ok(pl && !pl.address, '内容脚本：payload 不含地址');
ok(!!live.elements.__tpup_assets_probe, '内容脚本：独立资产调试浮层已创建');
ok(/TapePost资产/.test(live.elements.__tpup_assets_probe.textContent), '内容脚本：浮层显示采集结果');
ok(!!live.elements.__tpup_probe && /TapePost内盘/.test(live.elements.__tpup_probe.textContent),
  '内容脚本：原有价格浮层未被破坏');

const noConnect = runScript(EMPTY, '/zh/trade/assets');
const ncMsgs = noConnect.sent.filter((m) => m.type === 'TAPUP_ASSETS');
// 1.5.14：失败不再静默，回传一条不带数值的诊断，后台才好把「未采集」说清楚
eq('内容脚本：未连接钱包只回传一条诊断', ncMsgs.length, 1);
const ncPl = ncMsgs[0] && ncMsgs[0].payload;
ok(ncPl && ncPl.ok === false && ncPl.connected === false, '内容脚本：诊断标记未连接');
eq('内容脚本：诊断不带任何数值字段', ncPl && Object.keys(ncPl.fields || {}).length, 0);
ok(ncPl && ncPl.probe && ncPl.probe.connected === false, '内容脚本：诊断带 probe');
ok(/未连接钱包/.test(noConnect.elements.__tpup_assets_probe.textContent), '内容脚本：浮层提示先连接钱包');

const otherPage = runScript(TABLE_ZH, '/zh/trade/token?id=1');
eq('内容脚本：交易页不回传资产', otherPage.sent.filter((m) => m.type === 'TAPUP_ASSETS').length, 0);
ok(!otherPage.elements.__tpup_assets_probe, '内容脚本：交易页不建资产浮层');

/* ---------- 4. 后台 / 弹窗 / 权限接线 ---------- */

const bg = read('background.js');
const pop = read('popup.js');
const html = read('popup.html');
const tpjs = read('tapeup-price.js');
const pjs = read('price.js');

ok(/TAPUP_ASSETS/.test(bg) && /TapePrice\.cleanAssets/.test(bg), '后台：消息分支调用清洗器');
ok(/tapeupAssetsCache/.test(bg), '后台：缓存 key 存在');
ok(bg.includes('tapeup\\.io') && /sender\.tab\.url/.test(bg), '后台：只接受 tapeup.io 页面回传');
ok(/K_BIND, K_ASSETS, K_TAPEUP_ASSETS/.test(bg), '后台：断开钱包一并清缓存');
ok(/tapeup: await tapeupAssets\(\)/.test(bg), '后台：WALLET_STATUS 带出 TapeUP 资产');
ok(/error: a\.error, tapeup: await tapeupAssets\(\)/.test(bg), '后台：ASSETS_GET 带出 TapeUP 资产');
ok(/age > 30 \* 60000/.test(bg), '后台：30 分钟标 stale');
ok(/cleaned\.connected && cleaned\.ok/.test(bg), '后台：空态不覆盖有效缓存');

['tupHeld', 'tupPending', 'tupBoost', 'tupValue', 'tupChange', 'tupTokens', 'tapeupState', 'tapeupSub']
  .forEach((id) => ok(html.includes('id="' + id + '"'), '弹窗：元素 ' + id + ' 存在'));
ok(/asset-grid tapeup-grid/.test(html), '弹窗：TapeUP 资产组独立于两条链');
ok(/PoB 买入预算|页面展示值/.test(html + pop), '弹窗：明确标注不是链上余额');
ok(/function renderTapeUpAssets/.test(pop), '弹窗：渲染函数存在');
ok((pop.match(/renderTapeUpAssets\(r\.tapeup\)/g) || []).length >= 2, '弹窗：首屏与刷新两条路径都渲染');
ok(/ASSETS_TAPEUP_COLLECT/.test(pop) && /chrome\.storage\.onChanged/.test(pop),
  '弹窗：状态可点立即采集 + 缓存变化自动回刷');
ok(/不是链上锁仓/.test(pop), '弹窗：说明待释放口径');
ok(/超过 30 分钟未刷新/.test(pop), '弹窗：过期提示');
ok(/#ff6b6b/.test(pop) && /#4ade80/.test(pop), '弹窗：涨红跌绿（国内习惯）');

ok(/TAPE_WAKE/.test(tpjs) && /lastAssetsSig = ''/.test(tpjs), '内容脚本：冷启动失败自动重发');
ok(/isAssetsPage/.test(tpjs), '内容脚本：只在资产页采集');
ok(/__tpup_assets_probe/.test(tpjs), '内容脚本：独立调试浮层');
ok(/extractAssets/.test(pjs) && /cleanAssets/.test(pjs), 'price.js：解析与清洗都导出');

const cs = man.content_scripts || [];
const tpEntry = cs.find((e) => (e.matches || []).some((m) => /tapeup\.io/.test(m)));
ok(!!tpEntry, 'manifest：tapeup.io 内容脚本仍存在');
ok(tpEntry && tpEntry.js.includes('price.js') && tpEntry.js.includes('tapeup-price.js'),
  'manifest：未新增运行时文件');
eq('manifest：permissions 仍 9 项', man.permissions.length, 9);
eq('manifest：host_permissions 仍 36 条', man.host_permissions.length, 36);
ok(man.host_permissions.includes('https://tapeup.io/*'), 'manifest：未新增域名');
eq('版本：manifest 与 listing 一致', man.version, listing.version);
ok(/appVersion">v/.test(html), '弹窗：版本兜底标签存在');

console.log('\n结果：' + pass + '/' + (pass + fail) + ' 通过' + (fail ? '，' + fail + ' 条失败' : ' ✓'));
if (fail) process.exit(1);
