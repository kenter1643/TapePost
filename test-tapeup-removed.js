/* TapePost 1.5.17 · TapeUP 网页采集「全部下线」专项自检
 *
 * 背景：1.5.13 / 1.5.14 为读「我的资产」在 tapeup.io 全站注入内容脚本、
 * 每 3 秒扫 DOM 并每 30 分钟静默开一个后台标签，用户反馈已影响正常访问该站。
 * 实测该站整站 Cloudflare（403）、TapeAPI 公开服务只有链上只读方法、
 * $UP 是 PoB 全链账本 Token ID（非 ERC-20、无合约地址），没有公开接口可替代。
 * 本脚本用真实文件断言「下线彻底」：不再注入、不再读取、不再开标签、
 * 不再有资产消息与弹窗资产区，权限与资料同步收敛。
 */
'use strict';
// 当前版本一律读 manifest.json，升补丁号时不用逐个改测试
const CUR = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'manifest.json'), 'utf8')).version;
const CUR_RE = CUR.replace(/\./g, '\\.');
const vRe = (pre, post) => new RegExp((pre || '') + CUR_RE + (post || ''));


const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(DIR, f));

let passed = 0;
let failed = 0;
function ok(name, cond) {
  if (cond) { passed++; }
  else { failed++; console.log('  FAIL  ' + name); }
}
function eq(name, actual, expected) {
  ok(name + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）', actual === expected);
}

const manifest = JSON.parse(read('manifest.json'));
const listing = JSON.parse(read('store/listing.json'));
// 上架详细描述按版本号查找，不按数组下标（每次新版本插到最前，下标就会整体后移）
const D = (v) => String((listing.detailed_description || []).find((x) => String(x).startsWith('【' + v)) || '');
const descOrderOk = (vs) => vs.every((v, i) => i === 0 || listing.detailed_description.findIndex((x) => String(x).startsWith('【' + vs[i - 1])) <
  listing.detailed_description.findIndex((x) => String(x).startsWith('【' + v)));
const bg = read('background.js');
const popHtml = read('popup.html');
const popJs = read('popup.js');
const contentJs = read('content.js');
const panelHtml = read('panel.html');
const readme = read('README.md');
const priv = read('docs/privacy.html');
const privSite = read('store/privacy-site/index.html');

console.log('== 1. 版本与权限基线 ==');
ok('manifest 版本为 1.5.x 补丁号（' + CUR + '）', /^1\.5\.\d+$/.test(manifest.version));
eq('listing 版本与 manifest 一致', listing.version, CUR);
eq('permissions 仍 9 项', manifest.permissions.length, 9);
eq('host_permissions 收敛为 34 条', manifest.host_permissions.length, 34);
ok('两条 tapeup.io 主机权限已移除',
  !manifest.host_permissions.some((h) => /tapeup\.io/.test(h)));
ok('content_scripts 不再匹配 tapeup.io',
  !manifest.content_scripts.some((c) => (c.matches || []).some((m) => /tapeup\.io/.test(m))));
ok('content_scripts 不再引用 tapeup-price.js',
  !manifest.content_scripts.some((c) => (c.js || []).includes('tapeup-price.js')));
eq('content_scripts 为三段（新增 X F注桥接段）', manifest.content_scripts.length, 3);
ok('新增段只注入 X 且不污染 7 站段',
  manifest.content_scripts[2].js.includes('follow-bridge.js') &&
  manifest.content_scripts[2].matches.every((m) => /x\.com|twitter\.com/.test(m)) &&
  manifest.content_scripts[0].js.every((f) => f.indexOf('follow-') !== 0));
ok('UI 版本兜底统一 v' + CUR, vRe('v').test(popHtml) && vRe('v').test(panelHtml) &&
  vRe('v').test(contentJs) && vRe('v').test(popJs));

console.log('== 2. 后台不再采集 / 不再开标签 ==');
ok('TAPEUP_AUTO 区块已整体删除',
  !/TAPEUP_AUTO_BEGIN|TAPEUP_AUTO_END/.test(bg));
ok('30 分钟定时 alarm 已删除',
  !/tapeupAssetsPoll|TU_ALARM|tapeupAssetsCleanup/.test(bg));
ok('采集入口函数已删除',
  !/tuCollect\(|tuFinish\(|tuApplyPayload\(|__tapeupAutoCollect|__tapeupAutoFinish|__tapeupAutoApply/.test(bg));
ok('资产回传消息类型已删除',
  !/TAPUP_ASSETS_SCAN|ASSETS_TAPEUP_COLLECT/.test(bg));
ok('消息正则不再接收 TAPUP_ASSETS',
  !/TAPUP_ASSETS\)/.test(bg) && !/\|TAPUP_ASSETS/.test(bg));
ok('静默标签 URL 已删除', !/tpauto=1|TU_URL/.test(bg));
ok('不再有针对 tapeup.io 的 tabs.query / tabs.create',
  !/tabs\.query\(\{ url: \['https:\/\/tapeup\.io/.test(bg) &&
  !/tabs\.create\(\{ url: TU_URL/.test(bg));
ok('价格轮询不再联动采集', !/tuCollect\('price-poll'\)/.test(bg));
ok('WALLET_STATUS 不再触发采集', !/WALLET_STATUS[\s\S]{0,200}__tapeupAutoCollect/.test(bg));
ok('ASSETS_GET 不再触发采集、不再带出 tapeup 字段',
  !/ASSETS_GET[\s\S]{0,260}__tapeupAutoCollect/.test(bg) &&
  !/tapeup: await tapeupAssets\(\)/.test(bg));
ok('walletStatus 已移除 tapeup 字段', !/async function tapeupAssets\(\)/.test(bg));
ok('弹窗资产缓存函数已删除', !/renderTapeUpAssets/.test(bg));

console.log('== 3. 回归保护：原有链路一点没动 ==');
ok('钱包消息路由仍在', /WALLET_STATUS/.test(bg) && /ASSETS_GET/.test(bg) && /WALLET_CLEAR/.test(bg));
ok('链上资产读取仍在', /assetsOf\(/.test(bg) && /publicAssets\(/.test(bg));
ok('断开钱包仍清理历史遗留缓存键',
  /sremove\(\[K_BIND, K_ASSETS, K_TAPEUP_ASSETS, 'tapeupAssetsStatusV1', 'tapeupAutoTabV1'\]\)/.test(bg));
ok('TAPUP_PRICE 兼容分支保留（历史 harness 依赖、无注入源）', /msg\.type === 'TAPUP_PRICE'/.test(bg));
ok('Firsto 行情与 X Layer / FabX 只读链路仍在',
  /TapePrice\.fetchSnapshot/.test(bg) && /api\.fabx\.tech/.test(read('tapeout-api.js')));
ok('price.js 仍被弹窗与后台引用', /<script src="price\.js">/.test(popHtml) && /importScripts\('price\.js'\)/.test(bg));
ok('工作区保留 tapeup-price.js 供历史断言，但已不注入、不进包',
  exists('tapeup-price.js') && !JSON.stringify(manifest).includes('tapeup-price.js'));

console.log('== 4. 弹窗资产区已下线 ==');
ok('资产六格与状态标签已删除',
  !/tapeupGrid|tapeupState|tupHeld|tupPending|tupBoost|tupValue|tupChange|tupTokens/.test(popHtml));
ok('弹窗明确告知已停用', /TapeUP 网页采集已停用/.test(popHtml));
ok('行情卡 title 标注停止采集', /1\.5\.16 起已停止网页采集/.test(popHtml));
ok('popup.js 不再渲染 / 重采资产',
  !/renderTapeUpAssets|collectTapeUpNow|ASSETS_TAPEUP_COLLECT|TUP_IDS|tupRefreshTimer/.test(popJs));
ok('popup.js 不再监听资产缓存变化', !/changes\.tapeupAssetsCache/.test(popJs));
ok('popup.js 仍有钱包与链上资产渲染',
  /function renderWallet\(/.test(popJs) && /function renderAssets\(/.test(popJs) && /function loadWallet\(/.test(popJs));
ok('BSC / X Layer 两组资产格仍在',
  /id="xlFab"/.test(popHtml) || /xlayer-grid/.test(popHtml));

console.log('== 5. 合规资料与文档同步 ==');
ok('详细描述首条为当前版本（' + CUR + '），其后按版本从新到旧保留 1.5.26 / 1.5.25 … 历史说明',
  String(listing.detailed_description[0]).startsWith('【' + CUR) &&
  descOrderOk([CUR, '1.5.26', '1.5.25', '1.5.24', '1.5.23', '1.5.22', '1.5.21', '1.5.20']) &&
  listing.detailed_description.some((x) => String(x).startsWith('【1.5.16')));
ok('主机访问理由含 1.5.16 下线补充', /1\.5\.16 补充：host_permissions 36 → 34 条/.test(listing.host_access_justification));
ok('逐项权限理由已移除 tapeup.io 注入描述',
  !/tapeup\.io \/ \*\.tapeup\.io 仅用于注入内容脚本/.test(listing.permission_justifications.host_permissions) &&
  /1\.5\.16/.test(listing.permission_justifications.host_permissions));
ok('宽权限说明改为 34 条', /host_permissions 是 34 条具体域名/.test(listing.broad_host_permission_justification));
ok('Dashboard verified_against 对齐新行号与 34 条',
  /1562–1591 行/.test(listing.dashboard_permission_justifications.verified_against) &&
  /host_permissions 34 条/.test(listing.dashboard_permission_justifications.verified_against) &&
  vRe('版本 ').test(listing.dashboard_permission_justifications.verified_against));
ok('两段必填 justification 文案未改且仍 ≤1000 字符',
  listing.dashboard_permission_justifications.fields.every((f) => f.en.length <= 1000));
ok('数据使用披露不再声称读取 tapeup.io 页面',
  !/tapeup\.io 交易页的内盘价由内容脚本读取/.test(listing.data_use_disclosure.what_is_transmitted) &&
  /1\.5\.16 起已停止 tapeup\.io 页面采集/.test(listing.data_use_disclosure.what_is_transmitted));
ok('数据使用表单答案补 1.5.16', /【1\.5\.16 补充】/.test(listing.data_usage_form_answers));
ok('发布清单指向 ' + CUR + ' 包 / 39 文件',
  listing.pre_submit_checklist.some((x) => vRe('TapePost_', '_store\\.zip（39 文件').test(x)));
ok('README 有 1.5.16 段', /### 1\.5\.16：TapeUP 网页采集全部下线/.test(readme));

[['仓库隐私政策', priv], ['独立部署副本', privSite]].forEach(([name, html]) => {
  ok(name + ' 含 1.5.16 下线披露', /1\.5\.16 TapeUP 网页采集全部下线/.test(html));
  ok(name + ' 权限表标注已移除', /1\.5\.16 已移除/.test(html));
  ok(name + ' 适用版本为 ' + CUR, vRe('适用版本：').test(html));
  ok(name + ' 明确不再注入 / 不再读取', /不再向 <code>tapeup\.io<\/code> 注入任何内容脚本/.test(html));
});
const ledgerPriv = path.join(DIR, '..', 'vote-ledger', 'privacy.html');
if (fs.existsSync(ledgerPriv)) {
  const lp = fs.readFileSync(ledgerPriv, 'utf8');
  ok('账本服务隐私政策副本同步', /1\.5\.16 TapeUP 网页采集全部下线/.test(lp) && /1\.5\.16 已移除/.test(lp));
}

console.log('== 6. 商店包（打好后复跑本脚本会生效）==');
const zip = path.join(DIR, 'store', 'TapePost_' + CUR + '_store.zip');
if (fs.existsSync(zip)) {
  const zlib = require('zlib');
  const buf = fs.readFileSync(zip);
  const sig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const entries = [];
  let i = 0;
  while ((i = buf.indexOf(sig, i)) !== -1) {
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    if (nameLen > 0 && nameLen < 128 && /^[\w./-]+$/.test(name)) {
      const start = i + 30 + nameLen + extraLen;
      entries.push({ name, method, data: buf.slice(start, start + compSize) });
    }
    i += 4;
  }
  const names = entries.map((e) => e.name);
  ok('商店包不含 tapeup-price.js', !names.includes('tapeup-price.js'));
  eq('商店包 39 文件（1.5.26 新增 growth 三个文件，1.5.28 新增 growth-watch.js）', names.length, 39);
  const manEntry = entries.find((e) => e.name === 'manifest.json');
  ok('包内根目录有 manifest.json', !!manEntry);
  if (manEntry) {
    const text = manEntry.method === 8
      ? zlib.inflateRawSync(manEntry.data).toString('utf8')
      : manEntry.data.toString('utf8');
    const man = JSON.parse(text);
    eq('包内 manifest 版本', man.version, CUR);
    ok('包内 manifest 无 tapeup.io 主机权限',
      !man.host_permissions.some((h) => /tapeup\.io/.test(h)));
    eq('包内 manifest 主机权限 34 条', man.host_permissions.length, 34);
  }
} else {
  console.log('  （包尚未生成，跳过 zip 断言）');
}

console.log('\n结果：' + passed + '/' + (passed + failed) +
  (failed ? ' 通过，' + failed + ' 条失败' : ' 全部通过 ✓'));
process.exit(failed ? 1 : 0);
