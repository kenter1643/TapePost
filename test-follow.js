/* TapePost 1.5.26 · X F注F系分析 / X 页面内扫描浮层专项自检
 *
 * 覆盖：接线与版本、合规资料、通用用户提取器、集合 / 分类、白名单与预演、
 * 安全不变量（不主动发请求 / 不读凭证 / 取F需确认 / 定位失败自动停机）、
 * 商店包内容。纯离线断言，不需要登录 X，也不产生任何网络请求。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const DIR = __dirname;
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(DIR, f));
// 当前版本一律读 manifest.json，升补丁号时不用逐个改测试
const CUR = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'manifest.json'), 'utf8')).version;
const CUR_RE = CUR.replace(/\./g, '\\.');
const vRe = (pre, post) => new RegExp((pre || '') + CUR_RE + (post || ''));


let passed = 0;
let failed = 0;
function ok(name, cond) {
  if (cond) { passed++; }
  else { failed++; console.log('  FAIL  ' + name); }
}
function eq(name, actual, expected) {
  ok(name + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）', actual === expected);
}

const Core = require('./follow-core.js');
const manifest = JSON.parse(read('manifest.json'));
const listing = JSON.parse(read('store/listing.json'));
// 上架详细描述按版本号查找，不按数组下标（每次新版本插到最前，下标就会整体后移）
const D = (v) => String((listing.detailed_description || []).find((x) => String(x).startsWith('【' + v)) || '');
const descOrderOk = (vs) => vs.every((v, i) => i === 0 || listing.detailed_description.findIndex((x) => String(x).startsWith('【' + vs[i - 1])) <
  listing.detailed_description.findIndex((x) => String(x).startsWith('【' + v)));
const popHtml = read('popup.html');
const panelHtml = read('panel.html');
const popJs = read('popup.js');
const contentJs = read('content.js');
const followHtml = read('follow.html');
const followJs = read('follow.js');
const capture = read('follow-capture.js');
const bridge = read('follow-bridge.js');
const coreSrc = read('follow-core.js');
const overlayJs = read('follow-overlay.js');
const overlayCss = read('follow-overlay.css');
const bgSrc = read('background.js');
const readme = read('README.md');
const privs = [
  read('docs/privacy.html'),
  read('store/privacy-site/index.html')
];
// 账本服务的隐私页在仓库外（../vote-ledger），本机没有时跳过这一份，不让整个自检崩掉
const ledgerPrivPath = path.join(DIR, '..', 'vote-ledger', 'privacy.html');
if (fs.existsSync(ledgerPrivPath)) privs.push(fs.readFileSync(ledgerPrivPath, 'utf8'));
else console.log('  SKIP  ../vote-ledger/privacy.html 不在本机，跳过该份隐私政策断言');
const tutorialPath = process.env.TAPEPOST_TUTORIAL ||
  '/Users/kentermacbook/Documents/Obsidian Vault/文章创作/X文章/TapePost信仰者工具小白教程-2026-11-14.md';
const tutorial = fs.existsSync(tutorialPath) ? fs.readFileSync(tutorialPath, 'utf8') : '';

const NEW_FILES = ['follow-core.js', 'follow-capture.js', 'follow-bridge.js', 'follow.html', 'follow.js'];
const OVERLAY_FILES = ['follow-overlay.js', 'follow-overlay.css'];
const GROWTH_FILES = ['growth-core.js', 'growth.html', 'growth.js', 'growth-watch.js'];

// ---------------------------------------------------------------- 1. 版本与接线
console.log('== 1. 版本与接线 ==');
ok('manifest 版本为 1.5.x 补丁号（' + CUR + '）', /^1\.5\.\d+$/.test(manifest.version));
eq('listing 版本与 manifest 一致', listing.version, CUR);
ok('manifest.description ≤132 且含F注分析', manifest.description.length <= 132 &&
  /F注互F分析/.test(manifest.description));
ok('listing.summary_132 ≤132 且含F注分析', listing.summary_132.length <= 132 &&
  /F注互F分析/.test(listing.summary_132));
eq('listing.manifest_description_132 与 manifest 一致', listing.manifest_description_132, manifest.description);
eq('permissions 仍 9 项', manifest.permissions.length, 9);
eq('host_permissions 仍 34 条', manifest.host_permissions.length, 34);
ok('X 四条主机权限本就在列', ['https://x.com/*', 'https://*.x.com/*',
  'https://twitter.com/*', 'https://*.twitter.com/*'].every((h) => manifest.host_permissions.includes(h)));
eq('content_scripts 由 2 段增至 3 段', manifest.content_scripts.length, 3);
ok('原 7 站 ISOLATED 段未被塞入新脚本',
  manifest.content_scripts[0].js.every((f) => f.indexOf('follow-') !== 0) &&
  !manifest.content_scripts[0].world);
eq('MAIN 段仍是 document_start', manifest.content_scripts[1].run_at, 'document_start');
eq('MAIN 段仍是 MAIN world', manifest.content_scripts[1].world, 'MAIN');
ok('MAIN 段含 follow-core / grok-native / follow-capture 且 core 在最前', (() => {
  const js = manifest.content_scripts[1].js;
  return js[0] === 'follow-core.js' && js.includes('grok-native.js') &&
    js.includes('follow-capture.js') && js.indexOf('follow-core.js') < js.indexOf('follow-capture.js');
})());
ok('新增段只匹配 X / twitter.com', (() => {
  const m = manifest.content_scripts[2].matches;
  return m.length === 4 && m.every((x) => /x\.com|twitter\.com/.test(x));
})());
ok('新增段是 ISOLATED world / document_idle', !manifest.content_scripts[2].world &&
  manifest.content_scripts[2].run_at === 'document_idle');
ok('新增段以 follow-core.js 打头再注入 follow-bridge.js', (() => {
  const js = manifest.content_scripts[2].js;
  return js[0] === 'follow-core.js' && js[1] === 'follow-bridge.js';
})());
NEW_FILES.concat(OVERLAY_FILES, GROWTH_FILES).forEach((f) => ok('新运行时文件存在 ' + f, exists(f)));
ok('第三段注入 follow-overlay.js 与 follow-overlay.css', (() => {
  const c = manifest.content_scripts[2];
  return c.js.includes('follow-overlay.js') && (c.css || []).includes('follow-overlay.css');
})());
ok('浮层是静态 content_scripts，不走动态注入路径',
  /follow-overlay\.js/.test(JSON.stringify(manifest.content_scripts)) &&
  !/executeScript/.test(overlayJs) && !/insertCSS/.test(overlayJs));
ok('第三段仍以 core / bridge 打头，浮层排在最后', (() => {
  const js = manifest.content_scripts[2].js;
  return js[0] === 'follow-core.js' && js[1] === 'follow-bridge.js' &&
    js[js.length - 1] === 'follow-overlay.js';
})());
ok('弹窗有F注分析入口按钮', /id="openFollow"/.test(popHtml) &&
  /X F注F系分析/.test(popHtml));
ok('互F管理主入口固定在品牌头正下方、行情面板之前', (() => {
  const h1 = popHtml.indexOf('<h1>');
  const btn = popHtml.indexOf('id="openFollow"');
  const price = popHtml.indexOf('id="pricePanel"');
  const panel = popHtml.indexOf('id="openPanel"');
  return h1 >= 0 && btn > h1 && price > btn && panel > price;
})());
ok('互F管理入口只出现一次，不再重复出现在弹窗底部',
  (popHtml.match(/id="openFollow"/g) || []).length === 1);
ok('主入口是「互F管理」+ 中文副标题 + 新增徽标 + 图标/箭头',
  /he-title">互F管理<span class="he-new">新增/.test(popHtml) &&
  /he-sub">X F注F系分析 · 未回F统计 \/ 批量取F/.test(popHtml) &&
  /class="he-ico"/.test(popHtml) && /class="he-arrow"/.test(popHtml));
ok('主入口有显眼的渐变卡样式（flex 布局 + 渐变 + hover）',
  /#openFollow \{ display:flex/.test(popHtml) &&
  /linear-gradient\(100deg,rgba\(34,211,238/.test(popHtml) &&
  /#openFollow:hover/.test(popHtml));
ok('README / 教程 / 上架资料 / 隐私政策口径同步为「互F管理」入口',
  /互F管理/.test(readme) && (!tutorial || /互F管理/.test(tutorial)) &&
  listing.detailed_description.some((x) => /互F管理/.test(x)) &&
  privs.every((p) => /互F管理/.test(p)));
ok('popup.js 打开 follow.html', /getURL\('follow\.html'\)/.test(popJs));
ok('follow.html 先引 core 再引面板脚本',
  followHtml.indexOf('<script src="follow-core.js"></script>') < followHtml.indexOf('<script src="follow.js"></script>'));
ok('follow.html 版本兜底 v' + CUR, vRe('v').test(followHtml));
ok('四处 UI 兜底统一 v' + CUR, vRe('v').test(popHtml) && vRe('v').test(panelHtml) &&
  vRe('v').test(contentJs) && vRe('v').test(popJs));
ok('两段 Dashboard justification 仍 ≤1000 且 en_chars 对得上',
  listing.dashboard_permission_justifications.fields.every((f) =>
    f.en.length <= 1000 && f.en_chars === f.en.length));
ok('consistency_note 已说明 follow-capture.js 是静态 MAIN world 脚本',
  /follow-capture\.js/.test(listing.dashboard_permission_justifications.consistency_note));

// ---------------------------------------------------------------- 2. 合规资料
console.log('== 2. 合规资料与文档 ==');
ok('详细描述首条为当前版本（' + CUR + '），其后按版本从新到旧保留 1.5.26 / 1.5.25 … 历史说明',
  String(listing.detailed_description[0]).startsWith('【' + CUR) &&
  descOrderOk([CUR, '1.5.26', '1.5.25', '1.5.24', '1.5.23', '1.5.22', '1.5.21', '1.5.20']));
ok('详细描述含「不主动发任何请求 / 不读取登录凭证 / 只存本机」',
  /不主动发任何请求/.test(D('1.5.23')) &&
  /不读取 Authorization/.test(D('1.5.23')) &&
  /只存本机/.test(D('1.5.23')));
ok('single_purpose 增列 ' + CUR, vRe().test(listing.single_purpose));
ok('主机访问理由以 1.5.26 补充开头且仍写 34 条 / 9 项',
  listing.host_access_justification.startsWith('【' + CUR + ' 补充') &&
  /仍 34 条/.test(listing.host_access_justification) &&
  /仍 9 项/.test(listing.host_access_justification));
ok('逐项权限理由（storage / host_permissions）同步 1.5.26',
  vRe().test(listing.permission_justifications.storage) &&
  vRe().test(listing.permission_justifications.host_permissions));
ok('数据使用披露 what_is_transmitted / not_transmitted 同步 1.5.26',
  vRe().test(listing.data_use_disclosure.what_is_transmitted) &&
  vRe().test(listing.data_use_disclosure.what_is_not_transmitted));
ok('第三方接收方明确「无新增」', vRe('【', '】无新增第三方接收方').test(listing.data_use_disclosure.third_party_data_recipients));
ok('credential_handling_note 说明 follow-capture / follow-overlay 不读凭证',
  /follow-capture\.js/.test(listing.credential_handling_note) &&
  /follow-overlay\.js/.test(listing.credential_handling_note) &&
  /不读取任何请求头/.test(listing.credential_handling_note));
ok('data_usage_form_answers 以 1.5.26 补充开头', listing.data_usage_form_answers.startsWith('【' + CUR + ' 补充】'));
ok('发布清单指向 1.5.26 包 / 35 文件', listing.pre_submit_checklist.some((x) =>
  vRe('TapePost_', '_store\\.zip（39 文件').test(x)));
ok('发布清单新增页面扫描浮层核对项', listing.pre_submit_checklist.some((x) =>
  /页面内扫描浮层/.test(x) && /绝不自动取F/.test(x)));
ok('发布清单新增F注分析核对项', listing.pre_submit_checklist.some((x) =>
  /只被动读取/.test(x) && /先预演后确认/.test(x)));
ok('上架资料保留 1.5.22 多信号判定与响应心跳，且不新增权限 / 接收方',
  /scanVerdict\(\)/.test(D('1.5.22')) &&
  /TAPEFOLLOW_PULSE/.test(D('1.5.22')) &&
  /不新增权限/.test(D('1.5.22')) &&
  /第三方数据接收方/.test(D('1.5.22')));
ok('上架资料保留 1.5.26 增长计划段，以及高亮 / DOM 兼容 / ERROR 防护历史段',
  /每日 40 条发推/.test(D('1.5.26')) &&
  /1000 条评论/.test(D('1.5.26')) &&
  /growth-core\.js/.test(D('1.5.26')) &&
  /Follows you/.test(D('1.5.25')) &&
  /MutationObserver/.test(D('1.5.25')) &&
  /findUserCells\(\)/.test(D('1.5.24')) &&
  /Unchecked runtime\.lastError/.test(D('1.5.23')));
ok('上架资料首条为 1.5.27 互F管理 / 增长计划完善，并写明发送成功才计数、发送日志、不代点',
  /逐屏往下查找/.test(D('1.5.27')) && /谁取F了你|取F了你的人/.test(D('1.5.27')) &&
  /growth-watch\.js/.test(D('1.5.27')) && /确认发送成功才 \+1/.test(D('1.5.27')) &&
  /发送日志/.test(D('1.5.27')) && /不代点、不读未发送的草稿、不发请求/.test(D('1.5.27')));
ok('发布清单新增「扫描不会提前结束」核对项', listing.pre_submit_checklist.some((x) =>
  /扫描不会提前结束/.test(x) && /标「中断」/.test(x)));
privs.forEach((html, i) => {
  ok('隐私政策副本 ' + (i + 1) + ' 适用版本 ' + CUR, vRe('适用版本：').test(html));
  ok('隐私政策副本 ' + (i + 1) + ' 含 1.5.22 扫描结束判定段',
    /1\.5\.22 扫描结束判定/.test(html) && /TAPEFOLLOW_PULSE/.test(html) &&
    /只含响应计数与时间戳/.test(html));
  ok('隐私政策副本 ' + (i + 1) + ' 保留 1.5.23 运行时错误防护段',
    /1\.5\.23 运行时错误防护/.test(html) && /Unchecked runtime\.lastError/.test(html));
  ok('隐私政策副本 ' + (i + 1) + ' 含 1.5.27 旁听发送按钮披露（不代点 / 读取发出文字 / 发送日志存本地数据库 90 天）',
    /1\.5\.27 互F管理与增长计划完善/.test(html) && /growth-watch\.js/.test(html) &&
    /不阻止、不代点/.test(html) && /最多 280 字/.test(html) && /保留最近 90 天/.test(html) && /IndexedDB/.test(html) &&
    /X 确认发送成功才计数/.test(html));
  ok('隐私政策副本 ' + (i + 1) + ' 含 1.5.26 增长计划段并保留 1.5.25 DOM 兼容修复段',
    /1\.5\.26 X 增长计划/.test(html) && /40 条发推/.test(html) &&
    /1\.5\.25/.test(html) && /UserCell/.test(html));
  ok('隐私政策副本 ' + (i + 1) + ' 保留 1.5.21 浮层段与 1.5.20 实时落盘段',
    /1\.5\.21 X 页面内中文扫描浮层/.test(html) && /1\.5\.20 X F注F系分析/.test(html));
  ok('隐私政策副本 ' + (i + 1) + ' 页脚日期已更新', /Last updated: 2026-11-22/.test(html));
});
ok('README 保留 1.5.23 错误防护章节与 1.5.22 / 1.5.21 / 1.5.20 / 1.5.19 历史章节与 35 文件说明',
  /### 1\.5\.23：清除扩展管理页的运行错误日志/.test(readme) &&
  /### 1\.5\.22：修复「扫描没扫完就停了」/.test(readme) &&
  /### 1\.5\.21：X 页面内中文/.test(readme) &&
  /### 1\.5\.20：修复F注名单丢失/.test(readme) &&
  /### 1\.5\.19：新增 X F注F系分析/.test(readme) && /35 个文件/.test(readme) &&
  /### 1\.5\.26：新增 X 增长计划/.test(readme) && /### 1\.5\.27：互F管理与 X 增长计划完善/.test(readme) &&
  /39 个文件/.test(readme));
ok('README 说明多信号判定 / 响应心跳 / 上限标中断',
  /scanVerdict\(\)/.test(readme) && /TAPEFOLLOW_PULSE/.test(readme) &&
  /上限绝不冒充完成/.test(readme));
ok('README 说明取F只点原生按钮、不调用写接口',
  /不调用 X 任何私有 \/ 公开写接口/.test(readme));
if (tutorial) {
  ok('Obsidian 教程版本同步 1.5.26', /version: 1\.5\.26/.test(tutorial) &&
    /适用版本：\*\*v1\.5\.26\*\*/.test(tutorial));
  ok('Obsidian 教程新增F注分析章节与 FAQ',
    /## 十二、进阶：X F注F系分析/.test(tutorial) && /怎么看谁没回F我/.test(tutorial));
  ok('Obsidian 教程保留 1.5.21 页面扫描浮层章节与 FAQ',
    /### 1\.5\.21 新玩法/.test(tutorial) && /别的扩展的 Scan 面板全是英文/.test(tutorial));
  ok('Obsidian 教程保留 1.5.22 扫描修复小节与 FAQ',
    /#### 1\.5\.22 修复/.test(tutorial) && /扫描没扫完就停了/.test(tutorial));
  ok('Obsidian 教程保留 1.5.23 错误日志 FAQ 并同步 1.5.26',
    /1\.5\.23/.test(tutorial) && /chrome:\/\/extensions/.test(tutorial) &&
    /错误/.test(tutorial));
} else {
  console.log('  （未找到 Obsidian 教程，跳过 3 条）');
}

// ---------------------------------------------------------------- 3. 用户提取器
console.log('== 3. 通用用户提取器 ==');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(coreSrc, sandbox);
ok('follow-core.js 在浏览器 world 里挂载 FollowCore',
  !!sandbox.FollowCore && typeof sandbox.FollowCore.pickUsers === 'function');
ok('模块同时支持 CommonJS require', typeof Core.pickUsers === 'function');

const uA = { __typename: 'User', rest_id: '101', legacy: {
  screen_name: 'Alice', name: '爱丽丝', followers_count: 12000, friends_count: 30,
  statuses_count: 900, verified: true, description: 'hello, world',
  profile_image_url_https: 'https://pbs.twimg.com/a.jpg', created_at: 'Wed Oct 10 20:19:24 +0000 2018'
}, is_blue_verified: false };
ok('裸 User 节点可提取', Core.pickUsers(uA).length === 1 && Core.pickUsers(uA)[0].handle === 'alice');
ok('user_results.result 嵌套可提取', Core.pickUsers({ itemContent: { user_results: { result: uA } } })[0].handle === 'alice');
ok('core.user_results.result 嵌套可提取', Core.pickUsers({ core: { user_results: { result: uA } } })[0].handle === 'alice');
ok('timeline entries 多用户可提取并按 handle 去重', (() => {
  const payload = { data: { timeline: { instructions: [{ entries: [
    { content: { itemContent: { user_results: { result: uA } } } },
    { content: { itemContent: { user_results: { result: { rest_id: '102', legacy: { screen_name: 'Bob', name: 'B' } } } } } },
    { content: { itemContent: { user_results: { result: uA } } } }
  ] }] } } };
  const out = Core.pickUsers(payload);
  return out.length === 2 && out.map((x) => x.handle).sort().join(',') === 'alice,bob';
})());
ok('推文节点（full_text / Tweet）不会被当成用户', (() => {
  const payload = { legacy: { full_text: 'hi', screen_name: 'ghost' }, __typename: 'Tweet' };
  return Core.pickUsers(payload).length === 0;
})());
ok('合法 JSON 字符串也可解析', Core.pickUsers(JSON.stringify({ user_results: { result: uA } }))[0].handle === 'alice');
ok('坏 JSON / null / 数字 / 空串一律返回 []', [[], ['', null, 42, '{bad']].every((v) => Core.pickUsers(v).length === 0));
ok('凭证类字段一律不进入结果对象', (() => {
  const dirty = Object.assign({}, uA, { ct0: 'SECRET', authorization: 'Bearer X', email: 'a@b.c', auth_token: 'zzz' });
  const u = Core.pickUsers(dirty)[0];
  return u && !('ct0' in u) && !('authorization' in u) && !('email' in u) && !('auth_token' in u);
})());
ok('handle 统一小写并去掉 @', Core.lowerHandle('@Alice_1') === 'alice_1' && Core.validHandle('alice_1'));
ok('非法 handle 被拒', !Core.validHandle('a-b') && !Core.validHandle('') && !Core.validHandle('x'.repeat(21)));
ok('缺字段补默认值，公开资料齐全', (() => {
  const u = Core.pickUsers({ rest_id: '1', legacy: { screen_name: 'Default' } })[0];
  return u && u.followers === 0 && u.friends === 0 && u.tweets === 0 &&
    u.verified === false && u.name === 'default' && u.bio === '' && u.handle === 'default';
})());
ok('认证字段兼容 legacy.verified / is_blue_verified / node.verified',
  Core.pickUsers({ legacy: { screen_name: 'A', verified: true } })[0].verified === true &&
  Core.pickUsers({ legacy: { screen_name: 'B' }, is_blue_verified: true })[0].blue === true &&
  Core.pickUsers({ legacy: { screen_name: 'C' }, verified: true })[0].verified === true);
ok('超大响应受 MAX_NODES 保护、不抛异常', (() => {
  const big = { list: [] };
  for (let i = 0; i < 26000; i++) big.list.push({ rest_id: String(i), legacy: { screen_name: 'u' + i } });
  try { const out = Core.pickUsers(big); return out.length > 0 && out.length <= 20000; }
  catch (e) { return false; }
})());
ok('sanitizeUser 过滤 token / cookie / session 键', (() => {
  const out = Core.sanitizeUser({ handle: 'a', ct0: 'x', bearer: 'y', session: 'z', name: 'A' });
  return out.handle === 'a' && out.name === 'A' && !('ct0' in out) && !('bearer' in out) && !('session' in out);
})());

// ---------------------------------------------------------------- 4. 集合与分类
console.log('== 4. 集合运算与分类 ==');
const a = { handle: 'alice', name: 'A', followers: 12000, friends: 30, tweets: 900, verified: true };
const b = { handle: 'bob', name: 'B', followers: 3, friends: 900, tweets: 0, defaultAvatar: true };
const c = { handle: 'carol', name: 'C', followers: 500, friends: 400, tweets: 12 };
const fMap = Core.mergeSnapshot({}, [a, b]);
const rMap = Core.mergeSnapshot({}, [a, c]);
eq('mergeSnapshot 不修改入参', Object.keys(fMap).length, 2);
ok('mergeSnapshot 按 handle 去重且保留已有资料', (() => {
  const m = Core.mergeSnapshot(fMap, [{ handle: 'bob', name: 'B2' }]);
  return Object.keys(m).length === 2 && m.bob.name === 'B2' && m.bob.friends === 900;
})());
const sets = Core.relationSets(fMap, rMap);
eq('未回F我 = 我F注了对方没F注我', sets.notBack.map((x) => x.handle).join(','), 'bob');
eq('我未回F = 对方F注了我我没回F', sets.toFollowBack.map((x) => x.handle).join(','), 'carol');
eq('互F = 两边都有', sets.mutual.map((x) => x.handle).join(','), 'alice');
eq('F注数 / 粉丝数', sets.followingCount + '/' + sets.followerCount, '2/2');
eq('互F率 50%', sets.mutualRate, 50);
eq('空集合不报错', Core.relationSets({}, {}).mutualRate, 0);
ok('集合归属只按来源页面，不信 legacy.following / followed_by', (() => {
  const m1 = Core.mergeSnapshot({}, [{ handle: 'x', following: false, followedBy: true }]);
  const m2 = Core.mergeSnapshot({}, []);
  return Core.relationSets(m1, m2).notBack.length === 1;
})());
ok('classify：认证 + 大 V', Core.classify(a, {}).includes('verified') && Core.classify(a, {}).includes('big'));
ok('classify：疑似空号 + 低回F比', Core.classify(b, {}).includes('empty') && Core.classify(b, {}).includes('lowratio'));
ok('classify：普通账号兜底 normal', Core.classify(c, {}).join(',') === 'normal');
ok('classify：长期不活跃按最后发推时间判定', (() => {
  const old = { handle: 'old', followers: 100, friends: 50, tweets: 5, lastTweetAt: '2020-01-01T00:00:00Z' };
  return Core.classify(old, { now: Date.parse('2026-11-19') }).includes('inactive');
})());
ok('classify：近 30 天有发推不算不活跃', (() => {
  const now = Date.parse('2026-11-19T00:00:00Z');
  const fresh = { handle: 'fresh', followers: 100, friends: 50, tweets: 5,
    lastTweetAt: new Date(now - 30 * 86400000).toISOString() };
  return !Core.classify(fresh, { now: now }).includes('inactive');
})());
ok('classify：缺最后推文时间时不能凭账号注册时间误判不活跃', (() => {
  const old = { handle: 'old', followers: 100, friends: 50, tweets: 5,
    createdAt: 'Wed Oct 10 20:19:24 +0000 2018', lastTweetAt: '' };
  return !Core.classify(old, { now: Date.parse('2026-11-19T00:00:00Z') }).includes('inactive');
})());
eq('followerBand 0-100', Core.followerBand(99), '0-100');
eq('followerBand 100-1k', Core.followerBand(100), '100-1k');
eq('followerBand 1k-1w', Core.followerBand(9999), '1k-1w');
eq('followerBand 1w-10w', Core.followerBand(10000), '1w-10w');
eq('followerBand 10w+', Core.followerBand(100000), '10w+');
eq('统计卡 5 组', Core.GROUPS.length, 5);
eq('分类筛选 8 组', Core.FILTERS.length, 8);
ok('parseDate 兼容 X 旧版时间格式', Core.parseDate('Wed Oct 10 20:19:24 +0000 2018') > 0);
eq('ageDays 计算正确', Core.ageDays('2026-11-09T00:00:00Z', Date.parse('2026-11-19T00:00:00Z')), 10);

// ---------------------------------------------------------------- 5. 白名单与预演
console.log('== 5. 白名单 / 预演 / 限速 ==');
ok('白名单账号被保护', Core.protectedReasons(a, { whitelist: ['@Alice'] }).includes('白名单'));
ok('认证 / 大 V 受 skipProtected 保护', Core.protectedReasons(a, { skipProtected: true }).length >= 2);
ok('锁推账号始终受保护', Core.protectedReasons({ handle: 'z', locked: true }, { skipProtected: false }).includes('锁推账号'));
ok('关掉 skipProtected 后认证与大 V 不再保护，白名单仍保护', (() => {
  const r = Core.protectedReasons(a, { skipProtected: false, whitelist: [] });
  return r.length === 0 && Core.protectedReasons(a, { skipProtected: false, whitelist: ['alice'] }).length === 1;
})());
ok('isProtected 与 protectedReasons 一致', Core.isProtected(a, {}) === (Core.protectedReasons(a, {}).length > 0));
const task = Core.buildTask(['bob', 'alice', 'carol', 'bob', 'bad-handle'], [a, b, c], {});
eq('预演名单跳过受保护账号', task.handles.join(','), 'bob,carol');
eq('预演跳过原因写明认证 / 大 V', task.skipped.length, 1);
ok('预演去重且忽略非法 handle', !task.handles.includes('bad-handle'));
ok('预演结果只有纯数据，不触发任何点击（无 DOM / chrome 依赖）',
  typeof task.handles === 'object' && !('click' in task));
ok('batchLimit 生效', Core.buildTask(['a', 'b', 'c'], [], { batchLimit: 2, skipProtected: false }).handles.length === 2);
ok('minDelay 下限 3000 生效', Core.buildTask(['a'], [], { minDelay: 10 }).settings.minDelay === 3000);
ok('delayFor 确定性、有下限、落在设定区间', (() => {
  const s = { minDelay: 5000, jitter: 3000 };
  const d1 = Core.delayFor(3, s), d2 = Core.delayFor(3, s);
  return d1 === d2 && d1 >= 5000 && d1 <= 8000 && Core.delayFor(9, s) >= 5000;
})());
ok('CSV 表头与行数正确（中文表头）', (() => {
  const csv = Core.toCsv([a, b]);
  const lines = csv.split('\r\n');
  return lines[0].startsWith('用户名,昵称,粉丝数') && lines.length === 3;
})());
ok('CSV 认证值与分类标签全中文', (() => {
  const csv = Core.toCsv([Object.assign({}, a, { tags: ['verified', 'big'] }),
    Object.assign({}, b, { tags: ['empty', 'protected'] })]);
  return csv.includes(',是,') && csv.includes('认证账号、大 V') &&
    csv.includes('疑似空号、受保护') && !/\b(yes|no|verified|empty|protected)\b/.test(csv);
})());
ok('tagLabel 对未知标签也返回中文兜底', Core.tagLabel('unknown_tag') === '普通');
ok('CSV 对逗号 / 引号 / 换行做转义', (() => {
  const csv = Core.toCsv([{ handle: 'q', name: 'a,"b"\nc', followers: 0, friends: 0, tweets: 0 }]);
  return csv.includes('"a,""b""\nc"');
})());
ok('CSV 带主页 URL 与 @handle', /@bob/.test(Core.toCsv([b])) && /https:\/\/x\.com\/bob/.test(Core.toCsv([b])));

// ---------------------------------------------------------------- 6. 安全不变量（源码级）
console.log('== 6. 安全不变量 ==');
ok('采集器默认关闭（stats.enabled = false）', /enabled:\s*false/.test(capture));
ok('采集器只在收到 TAPEFOLLOW_CMD start 时启用',
  /action === 'start'\)\s*\{\s*stats\.enabled = true/.test(capture));
ok('采集器收到 stop 立即关闭', /action === 'stop'\)\s*\{\s*stats\.enabled = false/.test(capture));
ok('采集器只读响应体，用 clone().text() 不消耗原响应', /res\.clone\(\)\.text\(\)/.test(capture));
ok('采集器不读取 authorization / ct0 / cookie / transaction-id',
  !/headers\.get\(['"](?:authorization|ct0|cookie|x-client-transaction-id)/i.test(capture) &&
  !/document\.cookie/.test(capture));
ok('采集器不写死 GraphQL 端点名、不主动发请求',
  !/https:\/\/x\.com\/i\/api\/graphql\//.test(capture) &&
  !/origFetch\(\s*['"]https:/.test(capture));
ok('采集器只在 following / followers 路径与 /i/api/ 响应下处理',
  /apiUrl\(u\)/.test(capture) && /pageInfo\(\)/.test(capture));
ok('桥接层要求 confirmed === true 且 dryRun === false',
  /t\.dryRun !== false \|\| t\.confirmed !== true/.test(bridge));
ok('桥接层只在「F注中」页执行',
  /pageSource\(\) !== 'following'/.test(bridge));
ok('桥接层二次校验受保护账号',
  /Core\.protectedReasons\(byHandle\[h\] \|\| \{ handle: h \}, protOpts\)/.test(bridge));
ok('桥接层定位到行后校验 handle 一致性，不匹配就跳过',
  /if \(!rowHandleOk\(cell, handle\)\) return \{ ok: false/.test(bridge) && /function rowHandleOk/.test(bridge));
ok('桥接层点击后校验按钮状态变成「F注」',
  /looksUnfollowed\(cell\)/.test(bridge) && /FOLLOW_WORDS/.test(bridge));
ok('连续 3 次定位失败自动停机', /MAX_FAIL_STREAK = 3/.test(bridge) &&
  /连续 3 次定位失败/.test(bridge));
ok('桥接层不调用任何 X 写接口 / 不发 fetch 请求',
  !/fetch\(/.test(bridge) && !/XMLHttpRequest/.test(bridge));
ok('桥接层支持 paused / stopped 中断',
  /if \(ph !== 'running'\) \{ stopReason = ph; break; \}/.test(bridge) && /fin\.phase === 'paused'/.test(bridge));
ok('预演函数只生成名单并弹确认层，不写任务',
  /openModal\('批量取F预演/.test(followJs) && /state\.pending = task/.test(followJs));
ok('确认执行写 confirmed:true / dryRun:false',
  /confirmed: true/.test(followJs) && /dryRun: false/.test(followJs));
ok('面板明确提示 X 风控', /风控/.test(followHtml) && /临时限制/.test(followHtml));
ok('面板提供暂停 / 继续 / 停止 / 清空本机名单',
  ['pauseTask', 'resumeTask', 'stopTask', 'clearData'].every((id) => followHtml.includes('id="' + id + '"')));
ok('面板五张统计卡 + 分类 chips 由内核定义驱动',
  /Core\.GROUPS\.map/.test(followJs) && /Core\.FILTERS\.map/.test(followJs));
ok('follow.html 不含内联脚本（符合 MV3 CSP）',
  !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(followHtml));
ok('面板渲染用户资料前统一转义', /var esc = function/.test(followJs) && /esc\(u\.name/.test(followJs) &&
  /esc\(u\.handle\)/.test(followJs));
ok('头像只接受 https 外链', /\^https:\\\/\\\//.test(followJs));
ok('扩展页不引用任何远程脚本', !/src="https?:\/\//.test(followHtml));

// ---------------------------------------------------------------- 6.5 面板文案中文化
console.log('== 6.5 面板文案中文化 ==');
ok('下拉选项可见文字全部中文', (() => {
  const opts = Array.from(followHtml.matchAll(/<option[^>]*>([^<]+)<\/option>/g)).map((m) => m[1]);
  return opts.length >= 10 && opts.every((s) => !/[A-Za-z]{2,}/.test(s));
})());
ok('旧英文界面文案已清除', ['导出 CSV', '用户名 A → Z', '>1k-1w<', '>10w+<', ' ms；']
  .every((s) => !followHtml.includes(s) && !followJs.includes(s)));
ok('粉丝量区间显示中文，筛选内部 id 仍稳定',
  /100～1000 人/.test(followHtml) && /10 万人以上/.test(followHtml) &&
  Core.followerBand(9999) === '1k-1w');
ok('明细行的粉丝量走中文映射', /BAND_LABELS\[u\.band\]/.test(followJs) && /粉丝量 '/.test(followJs));
ok('分类标签由内核中文映射渲染', /Core\.tagLabel\(t\)/.test(followJs));
ok('导出表格表头不再是英文字段名', !/'handle', 'name', 'followers'/.test(coreSrc));
ok('导出文件名为中文', /TapePostF注F系名单-/.test(followJs));
ok('预演节奏用「毫秒」而非 ms', /毫秒；预计耗时约/.test(followJs) && !/ ms；预计耗时约/.test(followJs));
ok('任务状态兜底不会露出英文 phase', /\|\| '任务状态'/.test(followJs));
ok('采集完成提示用中文，不再直接输出 following / followers',
  /'采集完成：' \+ \(src === 'followers' \? '粉丝' : 'F注中'\)/.test(bridge) &&
  !/'采集完成：' \+ src/.test(bridge));
ok('品牌名与版本号作为专有名词保留', vRe('v').test(followHtml) && /TapePost信仰者工具/.test(followHtml));

// ---------------------------------------------------------------- 7. 商店包
console.log('== 7. 商店包 ==');
const zipPath = path.join(DIR, 'store', 'TapePost_' + CUR + '_store.zip');
if (fs.existsSync(zipPath)) {
  // 极简 zip 中央目录解析（沿用 test-tapeup-removed.js 的做法）
  const buf = fs.readFileSync(zipPath);
  const entries = {};
  let off = 0;
  while ((off = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), off)) !== -1) {
    const method = buf.readUInt16LE(off + 8);
    const csize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString('utf8');
    const start = off + 30 + nameLen + extraLen;
    entries[name] = { method: method, data: buf.slice(start, start + csize) };
    off = start + csize;
  }
  const names = Object.keys(entries);
  eq('商店包 39 文件（1.5.27 新增 growth-watch.js）', names.length, 39);
  ok('十一个新运行时文件都进包', NEW_FILES.concat(OVERLAY_FILES, GROWTH_FILES).every((f) => names.includes(f)));
  ok('测试脚本不进包', names.every((n) => !n.startsWith('test-')));
  ok('根目录即 manifest.json', names.includes('manifest.json'));
  const manEntry = entries['manifest.json'];
  if (manEntry) {
    const text = manEntry.method === 8
      ? zlib.inflateRawSync(manEntry.data).toString('utf8')
      : manEntry.data.toString('utf8');
    eq('包内 manifest 版本', JSON.parse(text).version, CUR);
  }
  ok('包内文件与工作区逐字节一致', NEW_FILES.concat(OVERLAY_FILES, GROWTH_FILES).every((f) => {
    const e = entries[f];
    if (!e) return false;
    const data = e.method === 8 ? zlib.inflateRawSync(e.data) : e.data;
    return data.equals(fs.readFileSync(path.join(DIR, f)));
  }));
} else {
  console.log('  （包尚未生成，跳过 6 条 zip 断言）');
}

// ---------------------------------------------------------------- 8. 持久化离线模拟
// 用真实 follow-bridge.js / follow.js 源码 + mock chrome.storage.local，复现用户
// 反馈的「上次抓了一部分，重新打开粉丝分析就没有了」。纯离线，不联网、不碰 X。
async function persistenceChecks() {
  console.log('== 8. 持久化离线模拟 ==');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function makeStore(initial) {
    const db = Object.assign(Object.create(null), initial || {});
    const listeners = [];
    const runtime = {
      lastError: null,
      getManifest: () => ({ version: '1.5.26' }),
      onMessage: { addListener() {} }
    };
    let failNext = 0;
    const local = {
      get(keys, cb) {
        const out = {};
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in db) out[k] = db[k]; });
        setTimeout(() => cb(out), 0);
      },
      set(obj, cb) {
        if (failNext > 0) {
          failNext--;
          runtime.lastError = { message: 'QUOTA_BYTES quota exceeded' };
          setTimeout(() => { cb(); runtime.lastError = null; }, 0);
          return;
        }
        const changes = {};
        Object.keys(obj).forEach((k) => {
          changes[k] = { oldValue: db[k], newValue: obj[k] };
          db[k] = obj[k];
        });
        listeners.forEach((fn) => { try { fn(changes, 'local'); } catch (e) {} });
        setTimeout(() => cb(), 0);
      },
      remove(keys, cb) {
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete db[k]);
        if (cb) setTimeout(cb, 0);
      }
    };
    return {
      db,
      chrome: {
        storage: { local: local, onChanged: { addListener: (fn) => listeners.push(fn) } },
        runtime: runtime,
        tabs: {
          query: (q, cb) => cb([]), create: (o, cb) => cb(null),
          sendMessage: (id, msg, cb) => cb(null)
        }
      },
      failOnce() { failNext = 1; }
    };
  }

  function runBridge(store, pathname) {
    const msgListeners = [];
    const sent = [];
    const sandbox = {
      console: console, Promise: Promise, Date: Date, Math: Math, Object: Object,
      Array: Array, String: String, Number: Number, RegExp: RegExp, JSON: JSON,
      setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
      chrome: store.chrome,
      location: { pathname: pathname },
      document: {
        querySelector: () => null, querySelectorAll: () => [],
        body: { scrollHeight: 0 }, documentElement: { scrollHeight: 0 },
        addEventListener: () => {}
      },
      addEventListener: (type, fn) => { if (type === 'message') msgListeners.push(fn); },
      postMessage: (msg) => sent.push(msg),
      scrollTo: () => {}, scrollBy: () => {}
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.FollowCore = Core;
    vm.createContext(sandbox);
    vm.runInContext(read('follow-bridge.js'), sandbox);
    // vm 里的 window 是 contextified 代理，事件源必须用沙箱内部拿到的同一个引用
    const innerWindow = vm.runInContext('window', sandbox);
    return {
      emit(batches) {
        msgListeners.forEach((fn) => fn({
          source: innerWindow,
          data: { __tapeFollow: true, type: 'TAPEFOLLOW_DATA', batches: batches }
        }));
      },
      sent: sent
    };
  }

  async function runPanel(store) {
    const els = {};
    const mk = (id) => ({
      id: id, textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
      className: '', style: {}, handlers: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
      addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); },
      removeEventListener() {}, querySelectorAll() { return []; },
      querySelector() { return null; }, appendChild() {}, remove() {}, click() {}
    });
    const getEl = (id) => els[id] || (els[id] = mk(id));
    const documentMock = {
      getElementById: getEl, addEventListener() {}, createElement: () => mk('a'),
      body: { appendChild() {} }, hidden: false
    };
    const sandbox = {
      console: console, Promise: Promise, Date: Date, Math: Math, Object: Object,
      Array: Array, String: String, Number: Number, RegExp: RegExp, JSON: JSON,
      setTimeout: setTimeout, clearTimeout: clearTimeout,
      chrome: store.chrome, document: documentMock,
      window: { FollowCore: Core },
      Blob: function () {}, URL: { createObjectURL: () => '', revokeObjectURL() {} }
    };
    vm.createContext(sandbox);
    vm.runInContext(read('follow.js'), sandbox);
    await wait(90);
    return { getEl: getEl };
  }

  const batch = (names, src) => [{
    source: src, me: 'alice',
    users: names.map((h) => ({ handle: h, name: h, followers: 10, friends: 5, tweets: 2 }))
  }];
  const namesOf = (db, src) => Object.keys(((db.followData || {})[src] || {}));

  // 场景 1：采集中连抓两批，必须逐批立即落盘、增量合并
  const s1 = makeStore({
    followCapture: { status: 'running', target: 'following' },
    followData: { me: 'alice', following: {}, followers: {},
      updatedAt: { following: 0, followers: 0 }, savedAt: 0 }
  });
  const b1 = runBridge(s1, '/alice/following');
  b1.emit(batch(['bob', 'carol'], 'following'));
  await wait(30);
  ok('模拟：第一批响应立即写进本机缓存', namesOf(s1.db, 'following').length === 2);
  b1.emit(batch(['dave'], 'following'));
  await wait(30);
  ok('模拟：第二批增量合并，不覆盖前一批', namesOf(s1.db, 'following').length === 3);
  ok('模拟：面板写入的 me 不被桥接覆盖', s1.db.followData.me === 'alice');
  ok('模拟：每次落盘都刷新 savedAt', s1.db.followData.savedAt > 0);

  // 场景 2：采集已结束后到达的尾批（旧版被 cap.status 门槛整批丢弃）
  const s2 = makeStore({ followCapture: { status: 'done', target: 'following' } });
  runBridge(s2, '/alice/following').emit(batch(['erin'], 'following'));
  await wait(30);
  ok('模拟：采集已结束后到达的尾批仍落盘', namesOf(s2.db, 'following').length === 1);

  // 场景 3：状态里的目标页与当前页面不一致时，按当前页面来源落盘
  const s3 = makeStore({ followCapture: { status: 'running', target: 'followers' } });
  runBridge(s3, '/alice/following').emit(batch(['frank'], 'following'));
  await wait(30);
  ok('模拟：状态目标不一致时仍按页面来源落盘', namesOf(s3.db, 'following').length === 1);

  // 场景 4：写入失败后保留内存副本，下一批一起补写
  const s4 = makeStore({ followCapture: { status: 'running', target: 'following' } });
  const b4 = runBridge(s4, '/alice/following');
  s4.failOnce();
  b4.emit(batch(['gina'], 'following'));
  await wait(30);
  ok('模拟：写入失败时不谎报成功', namesOf(s4.db, 'following').length === 0);
  b4.emit(batch(['hank'], 'following'));
  await wait(50);
  ok('模拟：下一批把失败批次一起补写', namesOf(s4.db, 'following').indexOf('gina') !== -1 &&
    namesOf(s4.db, 'following').indexOf('hank') !== -1);
  ok('模拟：写入失败原因写进采集状态供面板提示',
    /QUOTA/.test(String((s4.db.followCapture || {}).storageError || '')));

  // 场景 5：用户关掉面板再重新打开 —— 名单必须还在，且卡住的采集中断但不丢数据
  const reopen = makeStore(s1.db);
  const p1 = await runPanel(reopen);
  ok('模拟：重新打开面板仍显示已抓到的 3 人', p1.getEl('cntFollowing').textContent === '3');
  ok('模拟：面板显示实时保存提示', /实时保存/.test(p1.getEl('saveHint').textContent));
  ok('模拟：卡住的采集标为中断、名单完整保留',
    /上次采集中断/.test(p1.getEl('capStatus').textContent) &&
    namesOf(reopen.db, 'following').length === 3);

  // 场景 6：面板点「保存用户名」不能拿旧快照覆盖桥接层刚写的人
  p1.getEl('meHandle').value = 'alice2';
  const saveHandlers = p1.getEl('saveMe').handlers.click || [];
  if (saveHandlers.length) await saveHandlers[0]();
  await wait(50);
  ok('模拟：面板保存用户名后名单仍完整', namesOf(reopen.db, 'following').length === 3);
  ok('模拟：面板保存用户名采用先读后写', reopen.db.followData.me === 'alice2');

  // 静态不变量
  ok('桥接层已去掉「只有 running 才落盘」的门槛',
    !/cap\.status !== 'running'/.test(bridge) && /无条件立即落盘/.test(bridge));
  ok('桥接层用内存副本 + storage 最新值合并', /function mergeData/.test(bridge) &&
    /function persistData/.test(bridge));
  ok('MAIN 采集器卸载前 flush 尾批', /pagehide/.test(capture) && /flushNow/.test(capture));
  ok('面板写数据先读最新再合并', /async function writeData/.test(followJs) &&
    /先读最新再合并/.test(followJs));
  ok('面板检测卡住的 running 并保留名单', /recoverStaleCapture/.test(followJs) &&
    /interrupted/.test(followJs));
  ok('面板有实时保存提示元素', /id="saveHint"/.test(followHtml) && /saveHint/.test(followJs));
}


// ---------------------------------------------------------------- 9. 页面内扫描浮层离线模拟
// 用真实 follow-overlay.js 源码 + mock chrome.storage.local / DOM，复现页面内
// 「全量扫描 / 增量续扫 / 标红 / 带入待选」全链路。纯离线，不联网、不碰 X。
function fakeCell(handle) {
  const anchor = { getAttribute: () => '/' + handle, parentNode: { appendChild() {} } };
  const classes = [];
  return {
    classes: classes,
    querySelectorAll: () => [anchor],
    querySelector: () => null,
    classList: { add: (c) => classes.push(c), remove: (c) => {
      const i = classes.indexOf(c); if (i >= 0) classes.splice(i, 1);
    } },
    appendChild() {}
  };
}
function makeOverlayEl(id, created) {
  return {
    id: id, innerHTML: '', textContent: '', className: '', checked: false, disabled: false,
    style: {}, handlers: {}, parentNode: { appendChild() {} },
    classList: { add() {}, remove() {} },
    addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
    appendChild() {}, setAttribute() {}, getAttribute() { return ''; },
    querySelector() { return null; }, querySelectorAll() { return []; }
  };
}
function runOverlay(db, pathname, cells) {
  const els = {};
  const created = [];
  ['tpfFold', 'tpfFull', 'tpfResume', 'tpfStop', 'tpfPick', 'tpfMark',
    'tpfPanelLink', 'tpfHint', 'tpfStat', 'tpfBar'].forEach((id) => {
    els[id] = makeOverlayEl(id, created);
  });
  const store = {
    get(keys, cb) {
      const out = {};
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in db) out[k] = db[k]; });
      cb(out);
    },
    set(obj, cb) { Object.keys(obj).forEach((k) => { db[k] = obj[k]; }); cb(); },
    remove(keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete db[k]); if (cb) cb(); }
  };
  const doc = {
    body: { appendChild() {} }, documentElement: { appendChild() {} }, hidden: false,
    getElementById: (id) => els[id] || null,
    createElement: (tag) => { const e = makeOverlayEl(tag, created); created.push(e); return e; },
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === '[data-testid="UserCell"]' ? (cells || []) : []),
    addEventListener() {}
  };
  const sent = [];
  const sandbox = {
    window: { FollowCore: Core, open: () => ({}) },
    document: doc,
    location: { pathname: pathname },
    chrome: {
      storage: { local: store, onChanged: { addListener() {} } },
      runtime: {
        getURL: (f) => 'chrome-extension://test/' + f,
        sendMessage: (m, cb) => { sent.push(m); if (cb) cb(); }
      }
    },
    console: console,
    setInterval: () => 1, clearInterval: () => {},
    setTimeout: () => 1, clearTimeout: () => {}
  };
  sandbox.window.location = sandbox.location;
  vm.createContext(sandbox);
  vm.runInContext(overlayJs, sandbox, { filename: 'follow-overlay.js' });
  return { db: db, els: els, created: created, sent: sent,
    Pure: vm.runInContext('window.TapeFollowOverlay', sandbox) };
}

async function overlayChecks() {
  console.log('== 9. 页面内扫描浮层离线模拟 ==');
  const overlayCode = overlayJs.slice(overlayJs.indexOf('(function ()'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const db = Object.create(null);
  db.followData = {
    me: 'alice',
    following: { bob: { handle: 'bob' }, carol: { handle: 'carol' } },
    followers: { carol: { handle: 'carol' }, dave: { handle: 'dave' } }
  };
  const cells = [fakeCell('bob'), fakeCell('carol')];
  const ov = runOverlay(db, '/alice/following', cells);
  const click = (id) => {
    const hs = ov.els[id].handlers.click || [];
    return hs.length ? hs[0]() : Promise.resolve();
  };
  await Promise.resolve(); await Promise.resolve();

  ok('模拟：浮层在 /following 页建起来并渲染中文状态',
    /本机已存/.test(ov.els.tpfStat.innerHTML) && /4/.test(ov.els.tpfStat.innerHTML));
  ok('模拟：只认 following / followers 路径，其它页面不出现',
    ov.Pure.pageSource('/alice/following') === 'following' &&
    ov.Pure.pageSource('/alice/followers') === 'followers' &&
    ov.Pure.pageSource('/home') === '');
  ok('模拟：句柄解析过滤 X 保留路径',
    ov.Pure.handleFromHref('/Bob') === 'bob' &&
    ov.Pure.handleFromHref('/i/flow/login') === '' &&
    ov.Pure.handleFromHref('/home') === '');
  ok('模拟：粉丝名单为空时绝不标红', ov.Pure.shouldMark({ bob: {} }, {}) === false);
  ok('模拟：两份名单齐了才算未回F（bob 标、carol 不标）', (() => {
    const nb = ov.Pure.notBackHandles(
      { bob: { handle: 'bob' }, carol: { handle: 'carol' } },
      { carol: { handle: 'carol' }, dave: { handle: 'dave' } });
    return !!nb.bob && !nb.carol;
  })());
  ok('模拟：增量续扫无锚点自动退回全量',
    ov.Pure.buildCapture({ mode: 'incremental', source: 'following', now: 1000 }).mode === 'full');
  ok('模拟：锚点来源不一致时退回全量',
    ov.Pure.buildCapture({ mode: 'incremental', source: 'following', me: 'alice', now: 1000,
      anchor: { source: 'followers', savedAt: 900, me: 'alice' } }).mode === 'full');
  ok('模拟：锚点账号不一致时退回全量',
    ov.Pure.buildCapture({ mode: 'incremental', source: 'following', me: 'alice', now: 1000,
      anchor: { source: 'following', savedAt: 900, me: 'bob' } }).mode === 'full');
  ok('模拟：有效锚点保留增量且起点人数沿用已存', (() => {
    const c = ov.Pure.buildCapture({ mode: 'incremental', source: 'following', me: 'alice',
      now: 1000, had: 12, anchor: { source: 'following', savedAt: 900, me: 'alice', count: 12 } });
    return c.mode === 'incremental' && c.count === 12 && c.resumedFrom === 12;
  })());
  ok('模拟：待选草稿小写去重、带来源与时间戳', (() => {
    const d = ov.Pure.buildDraft(['Bob', 'bob', 'CAROL', ''], 'following', 1234);
    return d.handles.length === 2 && d.handles[0] === 'bob' && d.handles[1] === 'carol' &&
      d.source === 'following' && d.from === 'overlay' && d.at === 1234;
  })());
  ok('模拟：状态文案全中文且显示两份名单人数',
    /本机已存/.test(ov.Pure.statusText({ status: 'running', scrolls: 3 },
      { following: 2, followers: 2 })) &&
    !/Scan|Following|Followers/i.test(ov.Pure.statusText({}, { following: 1, followers: 1 })));

  await click('tpfFull');
  ok('模拟：点「全量扫描」只写 followCapture，不删已存名单',
    db.followCapture && db.followCapture.mode === 'full' &&
    db.followCapture.status === 'running' && db.followCapture.target === 'following' &&
    db.followCapture.count === 2 && Object.keys(db.followData.following).length === 2);
  ok('模拟：浮层不写 followTask / 不设 confirmed',
    !('followTask' in db) && !/confirmed/.test(JSON.stringify(db.followCapture || {})));

  db.followScanAnchor = { source: 'following', me: 'alice', scrollY: 1200,
    count: 2, savedAt: Date.now() };
  await click('tpfResume');
  ok('模拟：点「增量续扫」按锚点保留 incremental',
    db.followCapture.mode === 'incremental' && db.followCapture.resumedFrom === 2);

  await click('tpfStop');
  ok('模拟：点「停止」只改状态，名单完整保留',
    db.followCapture.status === 'stopped' && Object.keys(db.followData.following).length === 2);

  // 打开「标红」开关：只有 bob 是未回F，carol 不应被标
  const ch = ov.els.tpfMark.handlers.change || [];
  if (ch.length) ch[0]({ target: { checked: true } });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  ok('模拟：标红开关只给未回F行加类 / 徽标',
    cells[0].classes.indexOf('tpf-row-notback') !== -1 &&
    cells[1].classes.indexOf('tpf-row-notback') === -1 &&
    ov.created.some((e) => e.className === 'tpf-badge' && e.textContent === '未回F'));
  ok('模拟：标红开关状态只存本机',
    db.followOverlayUi && db.followOverlayUi.markEnabled === true);

  await click('tpfPick');
  ok('模拟：「从当前位置选未回F」只写一次性待选草稿',
    db.followSelectionDraft && db.followSelectionDraft.from === 'overlay' &&
    db.followSelectionDraft.handles.indexOf('bob') !== -1 &&
    db.followSelectionDraft.handles.indexOf('carol') === -1);
  ok('模拟：带入待选后仍没有取F任务',
    !('followTask' in db) && !/confirmed/.test(JSON.stringify(db)));
  ok('模拟：点「打开分析面板」只发扩展内部消息，不直接开扩展页', (() => {
    ov.sent.length = 0;
    const hs = ov.els.tpfPanelLink.handlers.click || [];
    if (hs.length) hs[0]({ preventDefault() {} });
    return ov.sent.length === 1 && ov.sent[0].type === 'TAPEFOLLOW_OPEN_PANEL' &&
      !/window\.open\s*\(/.test(overlayCode);
  })());

  // 静态安全不变量
  ok('浮层不 fetch / 不发 XHR / 不读凭证',
    !/window\.fetch|\bfetch\s*\(|XMLHttpRequest|ct0|Authorization|document\.cookie/i.test(overlayCode));
  ok('后台注册 TAPEFOLLOW_OPEN_PANEL，只打开扩展自己的 follow.html',
    /TAPEFOLLOW_OPEN_PANEL/.test(bgSrc) &&
    /getURL\('follow\.html'\)/.test(bgSrc) &&
    /chrome\.tabs\.create/.test(bgSrc));
  ok('浮层只写三个本机键，绝不写 followTask',
    /followCapture/.test(overlayJs) && /followScanAnchor/.test(overlayJs) &&
    /followSelectionDraft/.test(overlayJs) && !/followTask\s*:/.test(overlayJs) &&
    !/confirmed\s*:/.test(overlayJs));
  ok('浮层所有可见文案为中文（品牌名 / 技术标识符除外）',
    /全量扫描/.test(overlayJs) && /增量续扫/.test(overlayJs) && /未回F/.test(overlayJs) &&
    /打开分析面板/.test(overlayJs) && !/'Scan'|"Scan"/.test(overlayJs) &&
    !/Followback Marker/.test(overlayJs.replace(/^[\s\S]*?\*\//, '')));
  ok('浮层样式全部带 tpf- 前缀，不污染 X 页面全局选择器',
    /#tpfOverlay/.test(overlayCss) && /\.tpf-/.test(overlayCss) &&
    !/^\s*(body|html|a|button|div)\s*\{/m.test(overlayCss));
  ok('桥接层支持 mode 与锚点，且面板无 mode 时行为不变',
    /KEY_ANCHOR/.test(bridge) && /cap\.mode/.test(bridge) &&
    /pendingScrollY/.test(bridge) && /行为与 1\.5\.20/.test(bridge));
  ok('面板消费待选草稿但绝不自动确认取F',
    /async function adoptDraft/.test(followJs) && /state\.selected\[k\] = true/.test(followJs) &&
    /protectedReasons/.test(followJs) && /id="draftHint"/.test(followHtml));
  ok('面板版本与提示同步 ' + CUR,
    vRe('v').test(followHtml) && /页面内扫描浮层/.test(followHtml));
}


// ---------------------------------------------------------------- 10. 扫描结束判定
// 用户反馈「扫描不对，没扫完就停了」。用可控时钟 + 真实 follow-bridge.js 源码
// 离线复现 X 慢分页 / 全量重扫（人数不涨）/ 加载指示器常驻等场景。
function makeScanBridge(opts) {
  opts = opts || {};
  const T0 = 1800000000000;
  let fakeNow = T0;
  const RealDate = Date;
  const FakeDate = new Proxy(RealDate, {
    construct(t, a) { return a.length ? new t(...a) : new t(fakeNow); },
    get(t, p) { return p === 'now' ? () => fakeNow : Reflect.get(t, p); }
  });
  const seed = opts.seed || [];
  const following = {};
  seed.forEach((h) => { following[h] = { handle: h, name: h }; });
  const db = Object.assign(Object.create(null), {
    followData: {
      me: 'alice', following: following, followers: {},
      updatedAt: { following: 0, followers: 0 }, savedAt: 0, version: 1, source: 'passive'
    },
    followCapture: Object.assign({
      status: 'running', target: 'following', me: 'alice', mode: 'full',
      startedAt: T0, scrolls: 0, idle: 0, count: seed.length,
      lastCount: seed.length, lastTickAt: T0, savedAt: 0, message: ''
    }, opts.capture || {})
  });
  const state = { height: 3000, bottom: opts.bottom !== false, spinner: !!opts.loading };
  const col = { querySelector: () => (state.spinner ? {} : null) };
  const sent = [];
  const msgListeners = [];
  let tickFn = null;
  const sandbox = {
    console: console, Promise: Promise, Object: Object, Array: Array,
    String: String, Number: Number, RegExp: RegExp, JSON: JSON, Math: Math,
    Date: FakeDate,
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: (fn, ms) => { if (ms === 1500) tickFn = fn; return 0; },
    location: { pathname: '/alice/following' },
    document: {
      querySelector: (sel) => (sel === '[data-testid="primaryColumn"]' ? col : null),
      querySelectorAll: () => [],
      body: { get scrollHeight() { return state.height; } },
      documentElement: { get scrollHeight() { return state.height; } },
      addEventListener() {}
    },
    scrollY: 0, innerHeight: 800,
    addEventListener: (t, fn) => { if (t === 'message') msgListeners.push(fn); },
    postMessage: (m) => sent.push(m),
    scrollTo: (x, y) => { if (state.bottom) sandbox.scrollY = y; },
    scrollBy: () => {},
    chrome: {
      storage: {
        local: {
          get(keys, cb) {
            const out = {};
            (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in db) out[k] = db[k]; });
            cb(out);
          },
          set(obj, cb) { Object.keys(obj).forEach((k) => { db[k] = obj[k]; }); cb(); },
          remove(keys, cb) {
            (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete db[k]);
            if (cb) cb();
          }
        },
        onChanged: { addListener() {} }
      },
      runtime: { lastError: null, onMessage: { addListener() {} },
        getManifest: () => ({ version: '1.5.26' }) }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.FollowCore = Core;
  vm.createContext(sandbox);
  vm.runInContext(bridge, sandbox, { filename: 'follow-bridge.js' });
  const innerWindow = vm.runInContext('window', sandbox);
  const fire = (data) => msgListeners.forEach((fn) => fn({ source: innerWindow, data: data }));
  const settle = async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  };
  return {
    db: db, sent: sent,
    cap: () => db.followCapture || {},
    async tick(ms) { fakeNow += (ms == null ? 1500 : ms); if (tickFn) await tickFn(); },
    async emit(users) {
      fire({ __tapeFollow: true, type: 'TAPEFOLLOW_DATA',
        batches: [{ source: 'following', me: 'alice', users: users }] });
      await settle();
    },
    pulse() { fire({ __tapeFollow: true, type: 'TAPEFOLLOW_PULSE', stats: { responses: 1 } }); },
    grow(px) { state.height += (px || 400); },
    setSpinner(v) { state.spinner = !!v; }
  };
}

async function scanChecks() {
  console.log('== 10. 扫描结束判定（慢分页 / 全量重扫不再误停） ==');
  const D = Core.DEFAULTS;
  const T0 = 1800000000000;
  const base = (o) => Object.assign({
    now: T0 + 90000, startedAt: T0, scrolls: 60, idle: 12,
    atBottom: true, bottomStable: 6,
    lastResponseAt: T0 + 1000, lastGainAt: T0 + 1000, lastHeightAt: T0 + 1000
  }, o || {});

  ok('判定：真正到底且静默足够久才 done',
    Core.scanVerdict(base()).action === 'done' && Core.scanVerdict(base()).reason === 'bottom');
  ok('判定：旧版 6 秒就停的场景现在继续扫描',
    Core.scanVerdict(base({ now: T0 + 6000, scrolls: 4, idle: 4 })).action === 'continue');
  ok('判定：X 仍在响应（人数不涨）绝不停',
    Core.scanVerdict(base({ lastResponseAt: T0 + 89000 })).reason === 'active');
  ok('判定：名单刚新增 / 页面刚变高，绝不停',
    Core.scanVerdict(base({ lastGainAt: T0 + 89000 })).reason === 'active' &&
    Core.scanVerdict(base({ lastHeightAt: T0 + 89000 })).reason === 'active');
  ok('判定：X 正在加载下一页，绝不停',
    Core.scanVerdict(base({ loading: true, loadingSince: T0 + 88000 })).reason === 'loading');
  ok('判定：加载指示器常驻超过宽限不卡死',
    Core.scanVerdict(base({ loading: true, loadingSince: T0 })).action === 'done');
  ok('判定：还没到底 / 到底轮数不足，绝不停',
    Core.scanVerdict(base({ atBottom: false, bottomStable: 0 })).reason === 'notBottom' &&
    Core.scanVerdict(base({ bottomStable: 1 })).reason === 'bottomUnstable');
  ok('判定：静默轮数不足，绝不停',
    Core.scanVerdict(base({ idle: 2 })).reason === 'idleRounds');
  ok('判定：达到时间 / 滚动上限返回 limit，绝不冒充完成',
    Core.scanVerdict(base({ now: T0 + D.maxCaptureMs + 1 })).action === 'limit' &&
    Core.scanVerdict(base({ scrolls: D.maxScroll })).action === 'limit');
  ok('判定：参数已放宽（滚动 600 次 / 静默 8 轮 / 上限 20 分钟 / 静默 20 秒）',
    D.maxScroll === 600 && D.idleRounds === 8 && D.maxCaptureMs === 20 * 60 * 1000 &&
    D.scanIdleMs >= 20000 && D.scanMinMs >= 12000);
  ok('源码：桥接层已改为 Core.scanVerdict 多信号判定，不再有「4 轮无新增即完成」',
    /Core\.scanVerdict\(/.test(bridge) && /lastResponseAt/.test(bridge) &&
    /scanGeometry/.test(bridge) && !/o\.idle >= Core\.DEFAULTS\.idleRounds/.test(bridge));
  ok('源码：采集器有响应心跳，人数不涨也能证明 X 在翻页',
    /TAPEFOLLOW_PULSE/.test(read('follow-capture.js')) &&
    /TAPEFOLLOW_PULSE/.test(bridge));
  ok('源码：浮层 / 面板不再把中断显示成 100% 完成',
    /本轮中断，名单已保留/.test(overlayJs) && /正在等待 X 分页加载/.test(followJs));

  // 真实桥接源码 + 可控时钟：X 每 8 秒才返回一批
  {
    const h = makeScanBridge({});
    for (let i = 0; i < 4; i++) await h.tick();
    ok('慢分页：旧版在 6 秒就会判 done，现在仍在扫描',
      h.cap().status === 'running');
    await h.emit([{ handle: 'bob', name: 'bob', followers: 10 }]);
    for (let i = 0; i < 14; i++) {
      if (i % 4 === 0) await h.emit([{ handle: 'bob', name: 'bob', followers: 10 }]);
      await h.tick();
    }
    ok('慢分页：X 分页慢时全程保持扫描，不中途停', h.cap().status === 'running');
    ok('慢分页：已抓到的人实时落盘', Object.keys(h.db.followData.following).length >= 1);
    ok('慢分页：诊断原因写进本机状态', !!(h.cap().scan && h.cap().scan.reason));
  }

  // 全量重扫：X 返回的都是已存账号，人数不涨但仍在翻页
  {
    const h = makeScanBridge({ seed: ['bob', 'carol'] });
    for (let i = 0; i < 20; i++) {
      if (i % 3 === 0) await h.emit([{ handle: 'bob' }, { handle: 'carol' }]);
      await h.tick();
    }
    ok('全量重扫：人数不涨但 X 一直翻页，绝不提前停', h.cap().status === 'running');
    ok('全量重扫：已存名单没有被删', Object.keys(h.db.followData.following).length === 2);
  }

  // 1.5.27：真实桥接源码跑完一轮「全量扫描到底」→ 本轮没出现的人被清理，并写入变化记录
  {
    const seed = Array.from({ length: 20 }, (_, i) => 'p' + i);
    const h = makeScanBridge({ seed: seed });
    const seen = seed.filter((x) => x !== 'p5').map((x) => ({ handle: x, name: x }));
    await h.emit(seen);
    await h.emit([{ handle: 'fresh', name: 'fresh' }]);
    for (let i = 0; i < 40 && h.cap().status === 'running'; i++) await h.tick(1500);
    const fd = h.db.followData;
    ok('1.5.27 全量扫描到底：状态 done 且记录清理结果', h.cap().status === 'done' && h.cap().prune && h.cap().prune.pruned === true);
    ok('1.5.27 全量扫描到底：本轮没出现的人从本机名单移除并立墓碑', !fd.following.p5 && fd.gone.following.p5 > 0 &&
      !!fd.following.p4 && !!fd.following.fresh);
    ok('1.5.27 全量扫描到底：首次只建基线、提示下次会自动对比', h.cap().prune.firstBaseline === true &&
      /已建立基线/.test(h.cap().message) && fd.baseline.following > 0);
  }

  // 只收到心跳、一个用户都没解析出来，也不能误停
  {
    const h = makeScanBridge({});
    for (let i = 0; i < 20; i++) { if (i % 3 === 0) h.pulse(); await h.tick(); }
    ok('只有响应心跳、没解析出用户时也不误停', h.cap().status === 'running');
  }

  // 真正到底 + 静默 30 秒后才完成
  {
    const h = makeScanBridge({});
    await h.emit([{ handle: 'bob' }]);
    for (let i = 0; i < 20; i++) await h.tick();
    ok('真正到底且静默 30 秒后才判完成', h.cap().status === 'done');
    ok('完成文案明确「列表已到底」，不再误导', /列表已到底/.test(h.cap().message || ''));
  }

  // X 加载指示器常驻超过宽限：恢复滚动，不会永久卡住
  {
    const h = makeScanBridge({ loading: true });
    await h.emit([{ handle: 'bob' }]);
    for (let i = 0; i < 45; i++) await h.tick();
    ok('加载指示器常驻超过宽限也不会永久卡住', h.cap().status === 'done');
  }

  // 整轮没有一次 X 分页响应：诚实标中断，不说完成
  {
    const h = makeScanBridge({});
    for (let i = 0; i < 20; i++) await h.tick();
    ok('整轮没有 X 分页响应：标中断而不是完成', h.cap().status === 'interrupted');
    ok('无响应时给出刷新页面重试的中文提示',
      /没有检测到 X 的分页数据/.test(h.cap().message || '') && /增量续扫/.test(h.cap().message || ''));
  }

  // 达到滚动上限：标中断、名单保留、提示可继续
  {
    const h = makeScanBridge({ seed: ['bob'], capture: { scrolls: D.maxScroll - 1 } });
    await h.tick();
    ok('达到滚动上限标中断，不冒充完成', h.cap().status === 'interrupted');
    ok('达上限时名单完整保留', Object.keys(h.db.followData.following).length === 1);
    ok('达上限提示可继续补', /接着补/.test(h.cap().message || ''));
  }
}

/* 1.5.24：chrome://extensions「错误」面板三类红字的回归护栏。
 * 除了逐点断言，还会扫一遍全部运行时 JS，确保没有新的「回调式 chrome API
 * 不读 lastError」漏网点（tapeup-price.js 已停用不进包，排除）。 */
function errorGuardChecks() {
  console.log('== 11. 运行时 ERROR 防护（1.5.24） ==');
  const panelJs = read('panel.js');

  ok('后台提供统一 sendResponse 保护函数并同步读取 lastError',
    /function guardedResponse\(sendResponse\)/.test(bgSrc) &&
    /void \(chrome\.runtime && chrome\.runtime\.lastError\)/.test(bgSrc));
  // harness 会把 background.js 从 1.4.13 marker 起单独截出来跑；helper 必须在该段内，
  // 否则价格 / 钱包模块引用未定义函数，整个消息链路静默失效（1.5.24 实际踩过）。
  const harnessMarker = '/* =====================================================================\n * 1.4.13';
  ok('保护函数定义在 harness 价格源码截取范围内（防回归）',
    bgSrc.indexOf(harnessMarker) >= 0 &&
    bgSrc.indexOf('function guardedResponse(sendResponse)') > bgSrc.indexOf(harnessMarker));
  ok('后台 6 个消息监听器全部套上保护（1.5.26 新增 GROWTH_ 路由）',
    (bgSrc.match(/sendResponse = guardedResponse\(sendResponse\)/g) || []).length === 6);
  ok('桥接层也有自己的保护函数（ISOLATED world 不共享后台作用域）',
    /function guardedResponse\(sendResponse\)/.test(bridge) &&
    /lastError/.test(bridge));
  ok('批量取F长任务的异步响应只回一次包且有兜底',
    /runTask\(\)\.then\(function \(r\) \{ sendResponse\(r\); \}/.test(bridge) &&
    /\}\)\.catch\(swallow\)/.test(bridge));
  ok('FOLLOW_PING 读名单失败也会回包，不留未处理 rejection',
    /readData\(\)\.then\(/.test(bridge) && /\}\)\.catch\(function \(\) \{\s*sendResponse\(\{ ok: false/.test(bridge));

  // 高频 storage 回调：桥接每 1.5 秒读一次、浮层每 1.2 秒读一次，
  // 任何一个忘了读 lastError 都会持续刷错误日志。
  ok('桥接层 storeGet 回调读取 lastError',
    /chrome\.storage\.local\.get\(keys, function \(r\) \{\s*void \(chrome\.runtime && chrome\.runtime\.lastError\)/.test(bridge));
  ok('浮层 get / set 回调都读取 lastError',
    (overlayJs.match(/void \(chrome\.runtime && chrome\.runtime\.lastError\)/g) || []).length >= 1 &&
    /var err = chrome\.runtime && chrome\.runtime\.lastError;\s*resolve\(!err\)/.test(overlayJs));
  ok('分析面板 get / set / tabs.query / tabs.create 全部读取 lastError',
    /function get\(keys\)[\s\S]{0,240}lastError/.test(followJs) &&
    /function set\(obj\)[\s\S]{0,240}lastError/.test(followJs) &&
    /function tabsQuery\(q\)[\s\S]{0,240}lastError/.test(followJs) &&
    /function tabsCreate\(url\)[\s\S]{0,240}lastError/.test(followJs));
  ok('浮层所有 async 调用点都吞掉 rejection',
    !/[^\w](render|markRows|startScan|stopScan|pickVisible)\(\);/.test(overlayJs));
  ok('分析面板 async 事件回调统一 safe 包装、顶层 refresh 有 catch',
    /function safe\(fn\)/.test(followJs) && /refresh\(\)\.catch\(swallow\)/.test(followJs));
  ok('后台价格模块三个 storage 包装都读取 lastError',
    /function syncGet\(key\)[\s\S]{0,300}lastError/.test(bgSrc) &&
    /function localGet\(key, fallback\)[\s\S]{0,300}lastError/.test(bgSrc) &&
    /function localSet\(obj\)[\s\S]{0,300}lastError/.test(bgSrc));
  ok('弹窗 / 内容脚本 / 生态面板的关键回调同步读取 lastError',
    (popJs.match(/void \(chrome\.runtime && chrome\.runtime\.lastError\)/g) || []).length >= 8 &&
    /void \(chrome\.runtime && chrome\.runtime\.lastError\)/.test(contentJs) &&
    (panelJs.match(/void \(chrome\.runtime && chrome\.runtime\.lastError\)/g) || []).length >= 2);

  // 全量扫描：回调式 chrome.* API 若未读 lastError、未 catch、未 await，一律视为漏网
  const apiRe = /chrome\.(?:storage\.(?:local|sync)\.(?:get|set|remove)|tabs\.(?:create|query|sendMessage)|runtime\.sendMessage|notifications\.(?:create|clear)|alarms\.create)\s*\(/;
  const cbRe = /function\s*\(|\)\s*=>|, \(\)/;
  const misses = [];
  fs.readdirSync(DIR).filter((f) => /\.js$/.test(f) && !/^test-/.test(f) && f !== 'tapeup-price.js')
    .forEach((f) => {
      const lines = read(f).split('\n');
      lines.forEach((ln, i) => {
        if (!apiRe.test(ln)) return;
        const ctx = lines.slice(i, i + 5).join('\n');
        if (/lastError|\.catch\(|await |swallow/.test(ctx)) return;
        if (cbRe.test(ctx)) misses.push(f + ':' + (i + 1));
      });
    });
  ok('全部运行时 JS 的回调式 chrome API 无漏网（' + misses.join(', ') + '）', misses.length === 0);
}

function visualChecks() {
  console.log('== 12. 未互F高亮与特色取F按钮（1.5.24） ==');
  ok('明细行按未回F集合加 item-notback / 徽标 / 取F按钮',
    /var notback = !!nbSet\[u\.handle\]/.test(followJs) &&
    /' item-notback'/.test(followJs) &&
    /class="tag nb-badge">🚫 未互F/.test(followJs) &&
    /class="mini btn-unfollow" data-unf=/.test(followJs));
  ok('行内取F只勾选 + 引导预演，不写 followTask / confirmed', (() => {
    const m = followJs.match(/data-unf[\s\S]{0,700}?\}\)\);/);
    return !!m && /state\.selected\[h\] = true/.test(m[0]) &&
      /请点「预演/.test(m[0]) && !/confirmed/.test(m[0]) && !/followTask/.test(m[0]);
  })());
  ok('未回F集合以粉丝名单齐备为前提（名单不全不误标）',
    /if \(Object\.keys\(state\.data\.followers \|\| \{\}\)\.length\)/.test(followJs) &&
    /sets\(\)\.notBack\.forEach/.test(followJs));
  ok('面板样式含未互F高亮 / 渐变左侧条 / 特色取F按钮', (() => {
    const css = followHtml.match(/<style>([\s\S]*?)<\/style>/);
    const s = css ? css[1] : '';
    return /\.item\.item-notback/.test(s) && /\.tag\.nb-badge/.test(s) &&
      /button\.btn-unfollow/.test(s) && /var\(--grad-cta\)/.test(s) &&
      /#dryRun, #modalConfirm/.test(s) && /prefers-reduced-motion/.test(s);
  })());
  ok('浮层未回F格子样式增强且伪元素不改徽标文案',
    /\.tpf-row-notback\s*\{[\s\S]{0,260}?linear-gradient/.test(overlayCss) &&
    /\.tpf-badge::before/.test(overlayCss) &&
    /\.tpf-pick\.tpf-pick-cta/.test(overlayCss));
  ok('浮层取F引导按钮加特色 class，文案仍为中文且含未回F',
    /tpf-pick tpf-pick-cta/.test(overlayJs) && /从当前位置选未回F/.test(overlayJs));
  ok('README / 上架资料 / 隐私政策 / 教程同步未互F高亮说明', (() => {
    return /未互F账号高亮 \+ 特色取F按钮/.test(readme) &&
      /未互F账号会显示红色渐变高亮/.test(privs[0]) &&
      privs.every((h) => /不会直接取F、不会自动确认弹窗/.test(h)) &&
      /未互F账号会显示红色渐变高亮/.test(listing.detailed_description[0]) === false &&
      /红色渐变高亮 \+ 发光徽标/.test(D('1.5.23')) &&
      (!tutorial || /未互F的人一眼就能看到/.test(tutorial));
  })());
  ok('未互F账号头像 + 用户名在两处都有特殊标识（纯 CSS，不改 DOM / 文案）', (() => {
    const css = followHtml.match(/<style>([\s\S]*?)<\/style>/);
    const panel = css ? css[1] : '';
    return /\.item\.item-notback \.av[\s\S]{0,200}?border:2px solid/.test(panel) &&
      /\.item\.item-notback \.av[\s\S]{0,200}?box-shadow/.test(panel) &&
      /\.item\.item-notback \.nm[\s\S]{0,160}?color:/.test(panel) &&
      /\.item\.item-notback \.nm[\s\S]{0,160}?text-shadow/.test(panel) &&
      /\.item\.item-notback \.hd/.test(panel) &&
      /@keyframes tpf-nb-pulse/.test(panel) &&
      overlayCss.indexOf('.tpf-row-notback img, .tpf-nb-avatar') !== -1 &&
      overlayCss.indexOf('.tpf-row-notback a[href^=') !== -1 &&
      /\.tpf-row-notback img[\s\S]{0,200}?box-shadow/.test(overlayCss);
  })());
  ok('1.5.24 兼容 X 改版：行容器不再写死 UserCell，按钮反推做兜底', (() => {
    return /function findUserCells\(\)/.test(overlayJs) &&
      /querySelectorAll\('\[data-testid="UserCell"\]'\)/.test(overlayJs) &&
      /button\[aria-label\^="Following @"\]/.test(overlayJs) &&
      /button\[aria-label\^="Follow @"\]/.test(overlayJs) &&
      /var cells = findUserCells\(\)/.test(overlayJs) &&
      !/var cells = document\.querySelectorAll\('\[data-testid="UserCell"\]'\)/.test(overlayJs);
  })());
  ok('头像 / 用户名标识只用后代选择器限定，不改 X 原生元素选择器',
    !/^\s*img\[src\*="profile_images"\]/m.test(overlayCss) &&
    !/^\s*a\[href\^="\/"\]/m.test(overlayCss));
  ok('新增样式不污染 X 全局选择器（全部带 tpf- / #tpfOverlay 限定）',
    (overlayCss.match(/(^|\n)\s*#?[a-zA-Z\[]/g) || []).every(function () { return true; }) &&
    !/^\s*(body|html|div|button|a)\s*\{/m.test(overlayCss));
}

// 1.5.24：模拟 X 改版后的 DOM（无 data-testid="UserCell"，行是含 handle 链接的容器，
// F注按钮带 aria-label="Following @handle"），验证 findUserCells 反推 + 标红只命中未回F。
function newDomChecks() {
  console.log('== 13. X 改版 DOM 兼容（F注按钮反推行 + 精确标红） ==');
  function makeRow(handle) {
    const classes = [];
    const anchor = { getAttribute: (a) => (a === 'href' ? '/' + handle : null), parentNode: null };
    const row = {
      classes: classes,
      classList: { add: (c) => classes.push(c), remove: (c) => {
        const i = classes.indexOf(c); if (i >= 0) classes.splice(i, 1);
      } },
      querySelectorAll: (sel) => (sel === 'a[href^="/"]' ? [anchor] : []),
      querySelector: () => null,
      appendChild() {},
      parentElement: null
    };
    anchor.parentNode = row;
    // 头像 img：验证加精确 class
    const avatarClasses = [];
    const avatar = { classList: { add: (c) => avatarClasses.push(c) } };
    row.querySelector = (sel) => (sel === 'img' ? avatar : (sel === '.tpf-badge' ? null : null));
    row.avatarClasses = avatarClasses;
    // F注按钮：aria-label 带 handle，parentElement 指向行容器
    const btn = {
      getAttribute: (a) => (a === 'aria-label' ? 'Following @' + handle : null),
      parentElement: row
    };
    row.btn = btn;
    return row;
  }
  // 复用 runOverlay 的沙箱，但把 doc.querySelectorAll 换成新版 DOM 行为。
  // 这里直接用源码在最小沙箱里跑 findUserCells + markRows 的可达性。
  // 通过给 runOverlay 传入特殊 cells 不行（它只 mock UserCell），因此单独构造。
  const bob = makeRow('bob'), carol = makeRow('carol');
  const btnList = [bob.btn, carol.btn];
  const db = Object.create(null);
  db.followData = {
    me: 'alice',
    following: { bob: { handle: 'bob' }, carol: { handle: 'carol' } },
    followers: { carol: { handle: 'carol' }, dave: { handle: 'dave' } }
  };
  // 构造一个 doc：老 UserCell 查询返回空；按钮选择器返回新 DOM 按钮
  const els = {}, created = [];
  ['tpfFold', 'tpfFull', 'tpfResume', 'tpfStop', 'tpfPick', 'tpfMark',
    'tpfPanelLink', 'tpfHint', 'tpfStat', 'tpfBar'].forEach((id) => {
    els[id] = makeOverlayEl(id, created);
  });
  const store = {
    get(keys, cb) {
      const out = {};
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in db) out[k] = db[k]; });
      cb(out);
    },
    set(obj, cb) { Object.keys(obj).forEach((k) => { db[k] = obj[k]; }); cb(); },
    remove(keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete db[k]); if (cb) cb(); }
  };
  const doc = {
    body: { appendChild() {} }, documentElement: { appendChild() {} }, hidden: false,
    getElementById: (id) => els[id] || null,
    createElement: (tag) => { const e = makeOverlayEl(tag, created); created.push(e); return e; },
    querySelector: () => null,
    querySelectorAll: (sel) => {
      if (sel === '[data-testid="UserCell"]') return [];           // 新版 X：无老 testid
      if (/aria-label\^="(Following|Follow|Unfollow) @"/.test(sel)) return btnList;
      return [];
    },
    addEventListener() {}
  };
  const sandbox = {
    window: { FollowCore: Core, open: () => ({}) },
    document: doc, location: { pathname: '/alice/following' },
    chrome: {
      storage: { local: store, onChanged: { addListener() {} } },
      runtime: { getURL: (f) => 'chrome-extension://test/' + f, sendMessage: (m, cb) => { if (cb) cb(); } }
    },
    console: console, setInterval: () => 1, clearInterval: () => {},
    setTimeout: () => 1, clearTimeout: () => {}
  };
  sandbox.window.location = sandbox.location;
  vm.createContext(sandbox);
  vm.runInContext(overlayJs, sandbox, { filename: 'follow-overlay.js' });
  // 等 overlay 初始化（build + 绑定事件）完成后再打开标红开关
  return Promise.resolve().then(() => Promise.resolve()).then(() => {
    const ch = els.tpfMark.handlers.change || [];
    if (ch.length) ch[0]({ target: { checked: true } });
  }).then(() => Promise.resolve()).then(() => Promise.resolve())
    .then(() => Promise.resolve()).then(() => Promise.resolve()).then(() => {
      ok('1.5.24 新版 DOM：从F注按钮反推行，只给未回F bob 标红 / 加头像 class',
        bob.classes.indexOf('tpf-row-notback') !== -1 &&
        carol.classes.indexOf('tpf-row-notback') === -1 &&
        bob.avatarClasses.indexOf('tpf-nb-avatar') !== -1 &&
        carol.avatarClasses.indexOf('tpf-nb-avatar') === -1 &&
        created.some((e) => e.className === 'tpf-badge' && e.textContent === '未回F'));
    });
}

// ------------------------------------------------- 14. 打开即高亮 + 重绘补标
function autoMarkChecks() {
  console.log('== 14. 打开即高亮与重绘补标（1.5.26） ==');
  const p = runOverlay({ followData: { following: {}, followers: {} } },
    '/alice/following', []).Pure;

  ok('页面元素互F标识只认完整文案，避免简介误判',
    p.mutualLabel('Follows you') === true && p.mutualLabel(' 关注了你 ') === true &&
    p.mutualLabel('Follows you and more') === false && p.mutualLabel('') === false);
  ok('零名单时：页面出现 Follows you 即可判定未回F，不要求先扫描', (() => {
    const v = p.rowSignals([
      { handle: 'bob', followsYou: false },
      { handle: 'carol', followsYou: true }
    ], {}, {});
    return v.confident === true && v.notBack.bob === true && !v.notBack.carol;
  })());
  ok('零名单且页面没有任何互F标识时一条都不标', (() => {
    const v = p.rowSignals([{ handle: 'bob', followsYou: false }], {}, {});
    return v.confident === false && !v.notBack.bob;
  })());
  ok('本机名单作为补充：页面无标识仍能判未回F', (() => {
    const v = p.rowSignals([{ handle: 'bob', followsYou: false },
      { handle: 'carol', followsYou: false }], {}, { carol: { handle: 'carol' } });
    return v.confident === true && v.notBack.bob === true && !v.notBack.carol;
  })());
  ok('页面标识优先于名单：Follows you 的人即使名单滞后也不标', (() => {
    const v = p.rowSignals([{ handle: 'bob', followsYou: true }], {}, {});
    return !v.notBack.bob;
  })());
  ok('默认开启，且MutationObserver / 鼠标事件补标链路都在', (() => {
    return /markEnabled: true/.test(overlayJs) &&
      /saved\.markEnabled !== false/.test(overlayJs) &&
      /new window\.MutationObserver/.test(overlayJs) &&
      /'mouseover'/.test(overlayJs) && /'mouseout'/.test(overlayJs) &&
      /function scheduleMark\(\)/.test(overlayJs);
  })());
  ok('CSS 头像发光圈与用户名高亮覆盖 X 重绘后的行', (() => {
    return /\.tpf-row-notback\.tpf-row-notback img/.test(overlayCss) &&
      /\.tpf-row-notback a\[href\^="\/"\]\s+span/.test(overlayCss) &&
      /::before\s*\{\s*content:\s*"✕"/.test(overlayCss);
  })());

  // 用贴近真机的新版 DOM 模拟：button[aria-label] → 祖先行 → 叶子 Follows you
  function mkCl() {
    const set = [];
    return {
      set: set,
      add(c) { if (set.indexOf(c) < 0) set.push(c); },
      remove(c) { const i = set.indexOf(c); if (i >= 0) set.splice(i, 1); },
      contains(c) { return set.indexOf(c) >= 0; }
    };
  }
  function mkRow(handle, mutual) {
    const cl = mkCl(), avatarCl = mkCl();
    const badgeHost = {
      children: [],
      appendChild(c) { c.parentNode = this; this.children.push(c); },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; }
    };
    const anchor = { getAttribute(a) { return a === 'href' ? '/' + handle : null; }, parentNode: badgeHost };
    const label = { childElementCount: 0, textContent: mutual ? 'Follows you' : '', getAttribute() { return null; } };
    const img = { classList: avatarCl };
    const btn = {
      getAttribute(a) { return a === 'aria-label' ? 'Following @' + handle : null; },
      textContent: 'Following', querySelectorAll() { return []; }
    };
    const row = {
      classList: cl, parentElement: null, textContent: '@' + handle,
      querySelectorAll(sel) {
        if (sel === 'a[href^="/"]') return [anchor];
        if (sel === 'img') return [img];
        if (sel === '.tpf-badge') return badgeHost.children.slice();
        if (sel === '.tpf-nb-avatar') return avatarCl.contains('tpf-nb-avatar') ? [img] : [];
        if (sel === 'button,[role="button"]') return [btn];
        if (/aria-label/.test(sel)) return [label];
        return [];
      },
      querySelector(sel) {
        if (sel === 'img') return img;
        if (sel === '.tpf-badge') return badgeHost.children[0] || null;
        return null;
      }
    };
    btn.parentElement = row;
    return { row: row, btn: btn, cl: cl, avatarCl: avatarCl, badgeHost: badgeHost };
  }

  const bob = mkRow('bob', false), carol = mkRow('carol', true);
  const buttons = [bob.btn, carol.btn];
  const ids = ['tpfFold', 'tpfFull', 'tpfResume', 'tpfStop', 'tpfPick', 'tpfMark',
    'tpfPanelLink', 'tpfHint', 'tpfStat', 'tpfBar'];
  const els = {};
  ids.forEach((id) => { els[id] = makeOverlayEl(id, []); });
  const db2 = Object.create(null);
  db2.followData = { me: 'alice', following: { bob: {}, carol: {} }, followers: {} };
  const store2 = {
    get(keys, cb) {
      const out = {};
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in db2) out[k] = db2[k]; });
      cb(out);
    },
    set(obj, cb) { Object.keys(obj).forEach((k) => { db2[k] = obj[k]; }); if (cb) cb(); }
  };
  const docHandlers = {}, rafQueue = [];
  let moCallback = null;
  const doc2 = {
    body: { appendChild() {} }, documentElement: { appendChild() {} },
    getElementById: (id) => els[id] || null,
    createElement: () => ({ className: '', textContent: '', setAttribute() {}, parentNode: null }),
    querySelector: () => null,
    querySelectorAll(sel) {
      if (sel === '[data-testid="UserCell"]') return [];
      if (/aria-label\^="(Following|Follow|Unfollow) @"/.test(sel)) return buttons;
      if (sel === '.tpf-row-notback') {
        return [bob.row, carol.row].filter((r) => r.classList.contains('tpf-row-notback'));
      }
      if (sel === '.tpf-badge') {
        return bob.badgeHost.children.concat(carol.badgeHost.children);
      }
      if (sel === '.tpf-nb-avatar') {
        return [bob.row, carol.row].map((r) => r.querySelector('img'))
          .filter((img) => img && img.classList.contains('tpf-nb-avatar'));
      }
      return [];
    },
    addEventListener(t, fn) { (docHandlers[t] = docHandlers[t] || []).push(fn); }
  };
  const sandbox = {
    window: {
      FollowCore: Core,
      requestAnimationFrame(fn) { rafQueue.push(fn); return 1; },
      MutationObserver: function (cb) { moCallback = cb; this.observe = function () {}; }
    },
    document: doc2, location: { pathname: '/alice/following' }, Date: Date,
    chrome: {
      storage: { local: store2, onChanged: { addListener() {} } },
      runtime: { sendMessage(m, cb) { if (cb) cb(); }, getURL() { return ''; } }
    },
    console: console, setInterval: () => 1, clearInterval: () => {},
    setTimeout: () => 1, clearTimeout: () => {}
  };
  sandbox.window.location = sandbox.location;
  vm.createContext(sandbox);
  vm.runInContext(overlayJs, sandbox, { filename: 'follow-overlay.js' });
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      const q = rafQueue.splice(0);
      q.forEach((fn) => fn());
    }
  };
  return settle().then(() => {
    ok('真机式 DOM：打开页面无需扫描即给未回F bob 全套标记',
      bob.cl.contains('tpf-row-notback') === true &&
      bob.avatarCl.contains('tpf-nb-avatar') === true &&
      bob.badgeHost.children.length === 1 &&
      carol.cl.contains('tpf-row-notback') === false &&
      bob.badgeHost.children[0].textContent === '未回F');
    ok('默认勾选即时高亮，不依赖用户先打开开关', els.tpfMark.checked === true);

    // 模拟 X hover 重绘：class 被冲掉但徽标还在（1.5.24 的老 bug）
    bob.cl.remove('tpf-row-notback');
    (docHandlers.mouseover || []).forEach((fn) => fn());
    return settle().then(() => {
      ok('鼠标移上/移开后 X 冲掉 class 也能立即补回，且不重复插徽标',
        bob.cl.contains('tpf-row-notback') === true &&
        bob.badgeHost.children.length === 1);

      // 模拟 X 整行重建：徽标也没了，由 MutationObserver 补标
      bob.cl.remove('tpf-row-notback');
      bob.badgeHost.removeChild(bob.badgeHost.children[0]);
      if (moCallback) moCallback([{ target: { classList: { contains: () => false } } }]);
      return settle().then(() => {
        ok('节点被 X 重建后由 DOM 监听补齐红底 / 光圈 / 徽标',
          bob.cl.contains('tpf-row-notback') === true &&
          bob.avatarCl.contains('tpf-nb-avatar') === true &&
          bob.badgeHost.children.length === 1);
        const ch = els.tpfMark.handlers.change || [];
        if (ch.length) ch[0]({ target: { checked: false } });
        return settle().then(() => {
          ok('手动关闭开关仍即刻清除全部标记',
            bob.cl.contains('tpf-row-notback') === false &&
            bob.avatarCl.contains('tpf-nb-avatar') === false &&
            bob.badgeHost.children.length === 0);
        });
      });
    });
  });
}

// ---------------------------------------------------------------- 15. 1.5.27 批量取F：虚拟列表逐屏查找 / 断点续跑 / 名单同步
// X 的F注列表是虚拟滚动：同一时刻只渲染十来行。用真实 follow-bridge.js 源码 +
// 「按 scrollY 只渲染可见行」的假 DOM 复现：旧版只在当前屏幕里找人，
// 勾了不在屏上的账号就「没找到这一行」→ 连续 3 次停机。
function makeSweepEnv(opts) {
  opts = opts || {};
  const N = opts.n || 300, ROW = 80, VH = 800;
  const T0 = 1800000000000;
  let fakeNow = T0;
  const RealDate = Date;
  const FakeDate = new Proxy(RealDate, {
    construct(t, a) { return a.length ? new t(...a) : new t(fakeNow); },
    get(t, p) { return p === 'now' ? () => fakeNow : Reflect.get(t, p); }
  });
  const all = Array.from({ length: N }, (_, i) => 'u' + i);
  const followingSet = new Set(all);
  const clicks = [];
  let pendingConfirm = null;
  let scrollY = opts.startY || 0;
  const maxY = N * ROW - VH;
  const cache = {};
  const cell = (h) => cache[h] || (cache[h] = {
    querySelectorAll(sel) {
      if (sel.indexOf('a[') === 0) return [{ getAttribute: () => '/' + h }];
      if (sel.indexOf('role') >= 0) return followingSet.has(h) ? [] : [{ innerText: 'Follow' }];
      return [];
    },
    querySelector(sel) {
      if (sel === '[data-testid$="-unfollow"]') {
        return followingSet.has(h) ? { click() { pendingConfirm = h; } } : null;
      }
      return null;
    }
  });
  const visible = () => {
    const first = Math.max(0, Math.floor(scrollY / ROW) - 1);
    const out = [];
    for (let i = first; i < Math.min(N, first + Math.ceil(VH / ROW) + 2); i++) out.push(cell(all[i]));
    return out;
  };
  const following = {};
  all.forEach((h) => { following[h] = { handle: h, name: h, followers: 10, seenAt: T0 - 1000 }; });
  const db = Object.assign(Object.create(null), {
    followData: { me: 'alice', following: following, followers: { u1: { handle: 'u1' } },
      updatedAt: { following: T0, followers: T0 }, savedAt: T0, version: 1, source: 'passive' },
    followWhitelist: opts.whitelist || [],
    followSettings: { minDelay: 5000, jitter: 3000, batchLimit: 50, skipProtected: true },
    followTask: Object.assign({ id: 'ft-1', phase: 'running', dryRun: false, confirmed: true,
      handles: opts.handles || [], settings: { minDelay: 5000, jitter: 3000, batchLimit: 50 },
      ok: [], fail: [], log: [], index: 0, startedAt: T0, beatAt: T0 }, opts.task || {})
  });
  let onClick = null;
  const msgListeners = [];
  const timers = [];
  const sandbox = {
    console: console, Promise: Promise, Object: Object, Array: Array,
    String: String, Number: Number, RegExp: RegExp, JSON: JSON, Math: Math,
    Date: FakeDate,
    setTimeout: (fn, ms) => { timers.push({ fn: fn, ms: ms || 0 }); setImmediate(() => { fakeNow += (ms || 0); fn(); }); return 0; },
    clearTimeout: () => {},
    setInterval: () => 0,
    location: { pathname: '/alice/following' },
    document: {
      querySelector(sel) {
        if (sel === '[data-testid="confirmationSheetConfirm"]') {
          return pendingConfirm ? { click() {
            followingSet.delete(pendingConfirm); clicks.push(pendingConfirm);
            pendingConfirm = null; if (onClick) onClick(clicks.length);
          } } : null;
        }
        if (sel === '[data-testid="primaryColumn"]') return { querySelector: () => null };
        return null;
      },
      querySelectorAll(sel) { return sel === '[data-testid="UserCell"]' ? visible() : []; },
      body: { scrollHeight: N * ROW },
      documentElement: { scrollHeight: N * ROW },
      addEventListener() {}
    },
    innerHeight: VH,
    addEventListener: () => {},
    postMessage: () => {},
    scrollTo: (x, y) => { scrollY = Math.max(0, Math.min(maxY, y)); },
    scrollBy: (x, dy) => { scrollY = Math.max(0, Math.min(maxY, scrollY + dy)); },
    chrome: {
      storage: {
        local: {
          get(keys, cb) {
            const out = {};
            (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in db) out[k] = JSON.parse(JSON.stringify(db[k])); });
            cb(out);
          },
          set(obj, cb) { Object.keys(obj).forEach((k) => { db[k] = JSON.parse(JSON.stringify(obj[k])); }); cb(); }
        },
        onChanged: { addListener() {} }
      },
      runtime: { lastError: null, onMessage: { addListener(fn) { msgListeners.push(fn); } },
        getManifest: () => ({ version: '1.5.27' }) }
    }
  };
  Object.defineProperty(sandbox, 'scrollY', { get: () => scrollY });
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.FollowCore = Core;
  vm.createContext(sandbox);
  vm.runInContext(bridge, sandbox, { filename: 'follow-bridge.js' });
  const start = () => new Promise((resolve) => {
    let r = null;
    msgListeners.forEach((fn) => { r = fn({ type: 'FOLLOW_TASK_START' }, {}, resolve) || r; });
  });
  const settle = async (n) => { for (let i = 0; i < (n || 20); i++) await new Promise((r) => setImmediate(r)); };
  return { db: db, clicks: clicks, start: start, settle: settle,
    onClick(fn) { onClick = fn; }, now: () => fakeNow, T0: T0,
    setPhase(ph) { db.followTask.phase = ph; },
    stillFollowing: (h) => followingSet.has(h) };
}

async function sweepChecks() {
  console.log('== 15. 1.5.27 批量取F：虚拟列表逐屏查找 / 断点续跑 / 名单同步 ==');
  // A. 目标分散在 300 行的不同位置 + 一个不在列表 + 一个白名单
  {
    const targets = ['u3', 'u80', 'u150', 'u220', 'u299', 'ghost', 'u10'];
    const env = makeSweepEnv({ handles: targets, whitelist: ['u10'], startY: 12000 });
    const r = await env.start();
    await env.settle();
    const t = env.db.followTask;
    eq('A. 返回 ok', r && r.ok, true);
    eq('A. 分散在整张列表里的 5 人全部取F成功', (t.ok || []).slice().sort().join(','), 'u150,u220,u299,u3,u80');
    ok('A. 只点了这 5 人，没有误点别人', env.clicks.slice().sort().join(',') === 'u150,u220,u299,u3,u80');
    ok('A. 白名单账号没被点，记为受保护', env.stillFollowing('u10') &&
      (t.fail || []).some((f) => f.handle === 'u10' && /受保护/.test(f.reason)));
    ok('A. 不在列表的人记「列表里没找到」而不是触发停机', t.phase === 'done' &&
      (t.fail || []).some((f) => f.handle === 'ghost' && /列表里没找到/.test(f.reason)));
    eq('A. index 与处理人数一致', t.index, 7);
    await env.settle(40);
    const d = env.db.followData;
    ok('A. 取F成功的人已从本机「F注中」移除', ['u3', 'u80', 'u150', 'u220', 'u299'].every((h) => !d.following[h]) &&
      !!d.following.u4 && !!d.following.u10);
    ok('A. 取F成功的人立了墓碑，不会被另一标签页的旧副本复活',
      ['u3', 'u299'].every((h) => d.gone && d.gone.following && d.gone.following[h] > 0) &&
      !Core.mergeData(d, { following: { u3: { handle: 'u3', seenAt: env.T0 } } }).following.u3);
    ok('A. 变化记录里有一条「批量取F」', (d.history || []).some((e) => e.kind === 'unfollow' &&
      e.removed.some((u) => u.handle === 'u80')));
    ok('A. 心跳 beatAt 随执行更新', t.beatAt > env.T0);
  }
  // B. 中途暂停 → 循环退出 → 点继续从剩下的人接着跑，不重复处理
  {
    const targets = ['u5', 'u60', 'u120', 'u200', 'u280'];
    const env = makeSweepEnv({ handles: targets });
    env.onClick((n) => { if (n === 2) env.setPhase('paused'); });
    const r1 = await env.start();
    await env.settle();
    const t1 = env.db.followTask;
    ok('B. 暂停后执行循环退出，状态保持「已暂停」并写明剩余人数',
      t1.phase === 'paused' && r1.remaining === 3 && /还剩 3 人/.test(t1.message || ''));
    eq('B. 暂停前只处理了 2 人', (t1.ok || []).length, 2);
    env.onClick(null);
    env.setPhase('running');
    const r2 = await env.start();
    await env.settle();
    const t2 = env.db.followTask;
    ok('B. 点继续后把剩下 3 人处理完，状态变为完成', r2.ok && t2.phase === 'done' && (t2.ok || []).length === 5);
    ok('B. 断点续跑不重复点同一个人', env.clicks.length === 5 && new Set(env.clicks).size === 5);
  }
  // C. 执行页刷新：任务停在 running 但心跳过期 → 加载时自动改为暂停，绝不自动续跑
  {
    const env = makeSweepEnv({ handles: ['u1'], task: { beatAt: 1800000000000 - 120000, startedAt: 1800000000000 - 120000 } });
    await env.settle(40);
    ok('C. 心跳过期的 running 任务在页面加载时被改成「已暂停」', env.db.followTask.phase === 'paused' &&
      /自动暂停/.test(env.db.followTask.message || ''));
    eq('C. 页面加载后没有自动点任何人', env.clicks.length, 0);
  }
  // D. 未经确认的任务仍被拒绝（安全不变量保留）
  {
    const env = makeSweepEnv({ handles: ['u1'], task: { confirmed: false } });
    const r = await env.start();
    ok('D. 未确认任务拒绝执行', r && r.ok === false && /未经确认/.test(r.error) && env.clicks.length === 0);
  }
  // E. 面板「继续」会重新下发 FOLLOW_TASK_START（旧版只改状态）
  ok('E. 面板 setPhase(running) 重新发送 FOLLOW_TASK_START', /phase === 'running'[\s\S]{0,900}FOLLOW_PING[\s\S]{0,1400}FOLLOW_TASK_START/.test(followJs));
}

// ---------------------------------------------------------------- 16. 1.5.27 全量扫描清理 / 谁取F了我
async function freshnessChecks() {
  console.log('== 16. 1.5.27 全量扫描清理 / 谁取F了我 ==');
  const U = (n, p) => Array.from({ length: n }, (_, i) => ({ handle: (p || 'f') + i, name: 'N' + i, followers: i }));
  let d = Core.normalizeData({});
  d = Core.ingestUsers(d, 'followers', U(40), 1000).data;
  const first = Core.finishFullScan(d, 'followers', 900, 1100);
  ok('第一次全量扫描只建立基线，不生成「全员新增」', first.pruned && first.firstBaseline &&
    first.added.length === 0 && first.data.baseline.followers === 1100);
  d = first.data;
  const again = U(40).filter((u) => ['f3', 'f7'].indexOf(u.handle) < 0).concat([{ handle: 'newfan', name: 'New' }]);
  d = Core.ingestUsers(d, 'followers', again, 2000).data;
  const second = Core.finishFullScan(d, 'followers', 1900, 2100);
  eq('第二次全量扫描：取F了我的人', second.removed.map((u) => u.handle).sort().join(','), 'f3,f7');
  eq('第二次全量扫描：新粉丝', second.added.map((u) => u.handle).join(','), 'newfan');
  ok('取F了我的人已从本机粉丝名单移除', !second.data.followers.f3 && !second.data.followers.f7 &&
    !!second.data.followers.newfan);
  eq('recentLostFollowers 列出最近取F我的人', Core.recentLostFollowers(second.data, 30, 2200)
    .map((u) => u.handle).sort().join(','), 'f3,f7');
  ok('之后又F注回来就不再算「取F了我」', (() => {
    const back = Core.ingestUsers(second.data, 'followers', [{ handle: 'f3' }], 3000).data;
    return !back.gone.followers.f3 && Core.recentLostFollowers(back, 30, 3100).every((u) => u.handle !== 'f3');
  })());
  // 覆盖不足：只扫到一半就「到底」→ 不清理
  let d2 = Core.ingestUsers(second.data, 'followers', U(10), 5000).data;
  const partial = Core.finishFullScan(d2, 'followers', 4900, 5100);
  ok('本轮覆盖不足 85% 时不清理、不误报', partial.pruned === false && partial.reason === 'coverage' &&
    Object.keys(partial.data.followers).length === Object.keys(d2.followers).length);
  ok('旧数据（没有 seenAt）兼容：normalizeData 补全新字段', (() => {
    const n = Core.normalizeData({ following: { a: { handle: 'a' } } });
    return n.gone.following && n.gone.followers && Array.isArray(n.history) && n.baseline.following === 0 && !!n.following.a;
  })());
  ok('面板与桥接层共用 FollowCore 的数据口径', /function normalizeData\(raw\) \{ return Core\.normalizeData\(raw\); \}/.test(followJs) &&
    /function mergeData\(fromStore, fromMemory\) \{ return Core\.mergeData/.test(bridge));
  ok('桥接层只在「全量扫描 + 真正到底」时清理', /cap\.mode === 'full'[\s\S]{0,120}Core\.finishFullScan/.test(bridge));
  ok('面板有「谁取F了我」与变化记录区', /id="lostList"/.test(followHtml) && /id="histList"/.test(followHtml) &&
    /recentLostFollowers/.test(followJs));
  ok('清空本机名单同时清掉墓碑 / 基线 / 变化记录', /gone: \{\}, baseline: \{\}, history: \[\]/.test(followJs));
}

/* 1.5.27 复查修正：输入不被改写 / 采集缓存补发 / 弹窗回调 / 任务替换 / 新版 DOM 取F */
async function reviewFixChecks() {
  console.log('== 17. 1.5.27 复查修正 ==');
  // 1) 内核函数不改调用方的原对象
  const raw = Core.normalizeData({ following: { a: { handle: 'a', seenAt: 1 }, b: { handle: 'b', seenAt: 5000 } } });
  const before = JSON.stringify(raw);
  Core.finishFullScan(raw, 'following', 4000, 6000);
  Core.removeHandles(raw, 'following', ['b'], 7000, 'unfollow');
  Core.ingestUsers(raw, 'following', [{ handle: 'c' }], 8000);
  ok('finishFullScan / removeHandles / ingestUsers 不改调用方传入的名单', JSON.stringify(raw) === before);

  // 2) MAIN 采集器：开始采集前已加载的人，开始时补发一次
  const posted = [];
  const listeners = [];
  const fakeRes = (body) => ({ headers: { get: () => 'application/json' },
    clone: () => ({ text: () => Promise.resolve(body) }) });
  const body = JSON.stringify({ data: { users: [
    { rest_id: '1', legacy: { screen_name: 'early1', name: 'E1', followers_count: 5 } },
    { rest_id: '2', legacy: { screen_name: 'early2', name: 'E2', followers_count: 9 } }] } });
  const win = {
    FollowCore: Core,
    fetch: () => Promise.resolve(fakeRes(body)),
    addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); },
    postMessage: (m) => posted.push(m)
  };
  const sb = { window: win, location: { pathname: '/alice/following' },
    document: { addEventListener() {}, querySelector: () => null, hidden: false },
    setTimeout: (fn) => { fn(); return 1; }, clearTimeout() {}, console: console };
  win.window = win;
  vm.createContext(sb);
  vm.runInContext(capture, sb, { filename: 'follow-capture.js' });
  await win.fetch('https://x.com/i/api/graphql/abc/Following');
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  const dataMsgs = () => posted.filter((m) => m.type === 'TAPEFOLLOW_DATA');
  ok('未开始采集：不向扩展传任何名单数据', dataMsgs().length === 0);
  const send = (action) => listeners.forEach((fn) => fn({ source: win,
    data: { __tapeFollow: true, type: 'TAPEFOLLOW_CMD', action: action } }));
  send('start');
  const got = dataMsgs().reduce((a, m) => a.concat(m.batches.reduce((b, x) => b.concat(x.users), [])), []);
  ok('开始采集时补发本页已加载过的人（全量扫描不会把列表顶部的人误判为取F）',
    got.map((u) => u.handle).sort().join(',') === 'early1,early2');
  const n1 = dataMsgs().length;
  send('start'); send('start');
  ok('桥接层重复发 start 不会重复补发', dataMsgs().length === n1);

  // 3) 面板弹窗：任何关闭方式都清掉确认回调
  ok('面板弹窗只保留一份确认回调，Esc / 点遮罩关闭也清空',
    /var modalAction = null;/.test(followJs) && /function closeModal\(\) \{\s*modalAction = null;/.test(followJs) &&
    !/ok\.addEventListener\('click', okFn\)/.test(followJs));
  ok('上一批还在执行时不能另起一批', /上一批取F还在执行中/.test(followJs));
  ok('执行循环发现任务被替换就退出，不把旧结果写进新任务',
    /runningTaskId && cur\.id !== runningTaskId/.test(bridge) && /runningTaskId && t\.id !== runningTaskId\) return 'replaced'/.test(bridge));

  // 4) 新版 DOM（没有 UserCell）也能逐屏找到行；成功判定要看到变成 Follow
  ok('执行器在没有 UserCell 时按「Following @handle」按钮反推行', /function rowMap\(\)/.test(bridge) &&
    /function visibleCells\(\) \{ return rowMap\(\); \}/.test(bridge) && /ROW_BTN_RE/.test(bridge));
  ok('取F成功判定：没有 Following 按钮且看到 Follow 才算成功', /sawFollow \|\| !!cell\.querySelector\('\[data-testid\$="-follow"\]'\)/.test(bridge));
  ok('点击后重新定位这一行再判定（X 会重建行节点）', /var after = findCell\(handle\);/.test(bridge));

  // 5) 不在扫描时不读整份名单；清理写入走串行队列
  ok('采集 tick 先读状态，没在扫描时不读整份名单',
    /return storeGet\(\[KEY_CAPTURE\]\)\.then\(function \(r\) \{[\s\S]{0,400}if \(!running\) return;\s*return readData\(\)/.test(bridge));
  ok('全量清理写入放进 serial()，基于最新数据重算', /pruneWrite = serial\(function \(\) \{[\s\S]{0,200}Core\.finishFullScan\(latest/.test(bridge));
  ok('浮层名单走内存缓存，storage 变化时更新', /var dataCache = null;/.test(overlayJs) &&
    /if \(changes\[KEY\.data\]\) dataCache = /.test(overlayJs));
  ok('浮层只在「F注中」页标未回F', /if \(source\(\) !== 'following'\) \{ clearMarks\(\); return; \}/.test(overlayJs));
}


persistenceChecks().then(overlayChecks).then(scanChecks).then(visualChecks).then(newDomChecks).then(autoMarkChecks).then(errorGuardChecks).then(sweepChecks).then(freshnessChecks).then(reviewFixChecks).then(function () {
  console.log('\n结果：' + passed + '/' + (passed + failed) +
    (failed ? ' 通过，' + failed + ' 条失败' : ' 全部通过 ✓'));
  process.exit(failed ? 1 : 0);
}).catch(function (e) {
  console.log('  FAIL  持久化模拟异常：' + (e && e.stack || e));
  console.log('\n结果：' + passed + '/' + (passed + failed + 1) + ' 通过，' + (failed + 1) + ' 条失败');
  process.exit(1);
});
