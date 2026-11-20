/* TapePost 1.5.22 · X 关注关系分析 / X 页面内扫描浮层专项自检
 *
 * 覆盖：接线与版本、合规资料、通用用户提取器、集合 / 分类、白名单与预演、
 * 安全不变量（不主动发请求 / 不读凭证 / 取关需确认 / 定位失败自动停机）、
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
  read('store/privacy-site/index.html'),
  fs.readFileSync(path.join(DIR, '..', 'vote-ledger', 'privacy.html'), 'utf8')
];
const tutorialPath = '/Users/kentermacbook/Documents/Obsidian Vault/文章创作/X文章/TapePost信仰者工具小白教程-2026-11-14.md';
const tutorial = fs.existsSync(tutorialPath) ? fs.readFileSync(tutorialPath, 'utf8') : '';

const NEW_FILES = ['follow-core.js', 'follow-capture.js', 'follow-bridge.js', 'follow.html', 'follow.js'];
const OVERLAY_FILES = ['follow-overlay.js', 'follow-overlay.css'];

// ---------------------------------------------------------------- 1. 版本与接线
console.log('== 1. 版本与接线 ==');
eq('manifest 版本', manifest.version, '1.5.22');
eq('listing 版本', listing.version, '1.5.22');
ok('manifest.description ≤132 且含关注分析', manifest.description.length <= 132 &&
  /关注互关分析/.test(manifest.description));
ok('listing.summary_132 ≤132 且含关注分析', listing.summary_132.length <= 132 &&
  /关注互关分析/.test(listing.summary_132));
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
NEW_FILES.concat(OVERLAY_FILES).forEach((f) => ok('新运行时文件存在 ' + f, exists(f)));
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
ok('弹窗有关注分析入口按钮', /id="openFollow"/.test(popHtml) &&
  /X 关注关系分析/.test(popHtml));
ok('互关管理主入口固定在品牌头正下方、行情面板之前', (() => {
  const h1 = popHtml.indexOf('<h1>');
  const btn = popHtml.indexOf('id="openFollow"');
  const price = popHtml.indexOf('id="pricePanel"');
  const panel = popHtml.indexOf('id="openPanel"');
  return h1 >= 0 && btn > h1 && price > btn && panel > price;
})());
ok('互关管理入口只出现一次，不再重复出现在弹窗底部',
  (popHtml.match(/id="openFollow"/g) || []).length === 1);
ok('主入口是「互关管理」+ 中文副标题 + 新增徽标 + 图标/箭头',
  /he-title">互关管理<span class="he-new">新增/.test(popHtml) &&
  /he-sub">X 关注关系分析 · 未回关统计 \/ 批量取关/.test(popHtml) &&
  /class="he-ico"/.test(popHtml) && /class="he-arrow"/.test(popHtml));
ok('主入口有显眼的渐变卡样式（flex 布局 + 渐变 + hover）',
  /#openFollow \{ display:flex/.test(popHtml) &&
  /linear-gradient\(100deg,rgba\(34,211,238/.test(popHtml) &&
  /#openFollow:hover/.test(popHtml));
ok('README / 教程 / 上架资料 / 隐私政策口径同步为「互关管理」入口',
  /互关管理/.test(readme) && /互关管理/.test(tutorial) &&
  /互关管理/.test(listing.detailed_description[0]) &&
  privs.every((p) => /互关管理/.test(p)));
ok('popup.js 打开 follow.html', /getURL\('follow\.html'\)/.test(popJs));
ok('follow.html 先引 core 再引面板脚本',
  followHtml.indexOf('<script src="follow-core.js"></script>') < followHtml.indexOf('<script src="follow.js"></script>'));
ok('follow.html 版本兜底 v1.5.22', /v1\.5\.22/.test(followHtml));
ok('四处 UI 兜底统一 v1.5.22', /v1\.5\.22/.test(popHtml) && /v1\.5\.22/.test(panelHtml) &&
  /v1\.5\.22/.test(contentJs) && /v1\.5\.22/.test(popJs));
ok('两段 Dashboard justification 仍 ≤1000 且 en_chars 对得上',
  listing.dashboard_permission_justifications.fields.every((f) =>
    f.en.length <= 1000 && f.en_chars === f.en.length));
ok('consistency_note 已说明 follow-capture.js 是静态 MAIN world 脚本',
  /follow-capture\.js/.test(listing.dashboard_permission_justifications.consistency_note));

// ---------------------------------------------------------------- 2. 合规资料
console.log('== 2. 合规资料与文档 ==');
ok('详细描述首条为 1.5.22，依次保留 1.5.21 / 1.5.20 / 1.5.19 历史说明',
  String(listing.detailed_description[0]).startsWith('【1.5.22') &&
  String(listing.detailed_description[1]).startsWith('【1.5.21') &&
  String(listing.detailed_description[2]).startsWith('【1.5.20') &&
  String(listing.detailed_description[3]).startsWith('【1.5.19'));
ok('详细描述含「不主动发任何请求 / 不读取登录凭证 / 只存本机」',
  /不主动发任何请求/.test(listing.detailed_description[0]) &&
  /不读取 Authorization/.test(listing.detailed_description[0]) &&
  /只存本机/.test(listing.detailed_description[0]));
ok('single_purpose 增列 1.5.22', /1\.5\.22/.test(listing.single_purpose));
ok('主机访问理由以 1.5.22 补充开头且仍写 34 条 / 9 项',
  listing.host_access_justification.startsWith('【1.5.22 补充') &&
  /仍 34 条/.test(listing.host_access_justification) &&
  /仍 9 项/.test(listing.host_access_justification));
ok('逐项权限理由（storage / host_permissions）同步 1.5.22',
  /1\.5\.22/.test(listing.permission_justifications.storage) &&
  /1\.5\.22/.test(listing.permission_justifications.host_permissions));
ok('数据使用披露 what_is_transmitted / not_transmitted 同步 1.5.22',
  /1\.5\.22/.test(listing.data_use_disclosure.what_is_transmitted) &&
  /1\.5\.22/.test(listing.data_use_disclosure.what_is_not_transmitted));
ok('第三方接收方明确「无新增」', /【1\.5\.22】无新增第三方接收方/.test(listing.data_use_disclosure.third_party_data_recipients));
ok('credential_handling_note 说明 follow-capture / follow-overlay 不读凭证',
  /follow-capture\.js/.test(listing.credential_handling_note) &&
  /follow-overlay\.js/.test(listing.credential_handling_note) &&
  /不读取任何请求头/.test(listing.credential_handling_note));
ok('data_usage_form_answers 以 1.5.22 补充开头', listing.data_usage_form_answers.startsWith('【1.5.22 补充】'));
ok('发布清单指向 1.5.22 包 / 35 文件', listing.pre_submit_checklist.some((x) =>
  /TapePost_1\.5\.22_store\.zip（35 文件/.test(x)));
ok('发布清单新增页面扫描浮层核对项', listing.pre_submit_checklist.some((x) =>
  /页面内扫描浮层/.test(x) && /绝不自动取关/.test(x)));
ok('发布清单新增关注分析核对项', listing.pre_submit_checklist.some((x) =>
  /只被动读取/.test(x) && /先预演后确认/.test(x)));
ok('上架资料说明 1.5.22 多信号判定与响应心跳，且不新增权限 / 接收方',
  /scanVerdict\(\)/.test(listing.detailed_description[0]) &&
  /TAPEFOLLOW_PULSE/.test(listing.detailed_description[0]) &&
  /不新增权限/.test(listing.detailed_description[0]) &&
  /第三方数据接收方/.test(listing.detailed_description[0]));
ok('发布清单新增「扫描不会提前结束」核对项', listing.pre_submit_checklist.some((x) =>
  /扫描不会提前结束/.test(x) && /标「中断」/.test(x)));
privs.forEach((html, i) => {
  ok('隐私政策副本 ' + (i + 1) + ' 适用版本 1.5.22', /适用版本：1\.5\.22/.test(html));
  ok('隐私政策副本 ' + (i + 1) + ' 含 1.5.22 扫描结束判定段',
    /1\.5\.22 扫描结束判定/.test(html) && /TAPEFOLLOW_PULSE/.test(html) &&
    /只含响应计数与时间戳/.test(html));
  ok('隐私政策副本 ' + (i + 1) + ' 保留 1.5.21 浮层段与 1.5.20 实时落盘段',
    /1\.5\.21 X 页面内中文扫描浮层/.test(html) && /1\.5\.20 X 关注关系分析/.test(html));
  ok('隐私政策副本 ' + (i + 1) + ' 页脚日期已更新', /Last updated: 2026-11-20/.test(html));
});
ok('README 有 1.5.22 扫描修复章节、1.5.21 / 1.5.20 / 1.5.19 历史章节与 35 文件说明',
  /### 1\.5\.22：修复「扫描没扫完就停了」/.test(readme) &&
  /### 1\.5\.21：X 页面内中文/.test(readme) &&
  /### 1\.5\.20：修复关注名单丢失/.test(readme) &&
  /### 1\.5\.19：新增 X 关注关系分析/.test(readme) && /35 个文件/.test(readme));
ok('README 说明多信号判定 / 响应心跳 / 上限标中断',
  /scanVerdict\(\)/.test(readme) && /TAPEFOLLOW_PULSE/.test(readme) &&
  /上限绝不冒充完成/.test(readme));
ok('README 说明取关只点原生按钮、不调用写接口',
  /不调用 X 任何私有 \/ 公开写接口/.test(readme));
if (tutorial) {
  ok('Obsidian 教程版本同步 1.5.22', /version: 1\.5\.22/.test(tutorial) &&
    /适用版本：\*\*v1\.5\.22\*\*/.test(tutorial));
  ok('Obsidian 教程新增关注分析章节与 FAQ',
    /## 十二、进阶：X 关注关系分析/.test(tutorial) && /怎么看谁没回关我/.test(tutorial));
  ok('Obsidian 教程保留 1.5.21 页面扫描浮层章节与 FAQ',
    /### 1\.5\.21 新玩法/.test(tutorial) && /别的扩展的 Scan 面板全是英文/.test(tutorial));
  ok('Obsidian 教程新增 1.5.22 扫描修复小节与 FAQ',
    /#### 1\.5\.22 修复/.test(tutorial) && /扫描没扫完就停了/.test(tutorial));
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
eq('未回关我 = 我关注了对方没关注我', sets.notBack.map((x) => x.handle).join(','), 'bob');
eq('我未回关 = 对方关注了我我没回关', sets.toFollowBack.map((x) => x.handle).join(','), 'carol');
eq('互关 = 两边都有', sets.mutual.map((x) => x.handle).join(','), 'alice');
eq('关注数 / 粉丝数', sets.followingCount + '/' + sets.followerCount, '2/2');
eq('互关率 50%', sets.mutualRate, 50);
eq('空集合不报错', Core.relationSets({}, {}).mutualRate, 0);
ok('集合归属只按来源页面，不信 legacy.following / followed_by', (() => {
  const m1 = Core.mergeSnapshot({}, [{ handle: 'x', following: false, followedBy: true }]);
  const m2 = Core.mergeSnapshot({}, []);
  return Core.relationSets(m1, m2).notBack.length === 1;
})());
ok('classify：认证 + 大 V', Core.classify(a, {}).includes('verified') && Core.classify(a, {}).includes('big'));
ok('classify：疑似空号 + 低回关比', Core.classify(b, {}).includes('empty') && Core.classify(b, {}).includes('lowratio'));
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
ok('桥接层只在「关注中」页执行',
  /pageSource\(\) !== 'following'/.test(bridge));
ok('桥接层二次校验受保护账号',
  /Core\.protectedReasons\(u,/.test(bridge));
ok('桥接层定位到行后校验 handle 一致性，不匹配就跳过',
  /cellHandle\(cell\) !== handle/.test(bridge));
ok('桥接层点击后校验按钮状态变成「关注」',
  /looksUnfollowed\(cell\)/.test(bridge) && /FOLLOW_WORDS/.test(bridge));
ok('连续 3 次定位失败自动停机', /MAX_FAIL_STREAK = 3/.test(bridge) &&
  /连续 3 次定位失败/.test(bridge));
ok('桥接层不调用任何 X 写接口 / 不发 fetch 请求',
  !/fetch\(/.test(bridge) && !/XMLHttpRequest/.test(bridge));
ok('桥接层支持 paused / stopped 中断',
  /ph === 'paused'/.test(bridge) && /ph === 'stopped'/.test(bridge));
ok('预演函数只生成名单并弹确认层，不写任务',
  /openModal\('批量取关预演/.test(followJs) && /state\.pending = task/.test(followJs));
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
ok('导出文件名为中文', /TapePost关注关系名单-/.test(followJs));
ok('预演节奏用「毫秒」而非 ms', /毫秒；预计耗时约/.test(followJs) && !/ ms；预计耗时约/.test(followJs));
ok('任务状态兜底不会露出英文 phase', /\|\| '任务状态'/.test(followJs));
ok('采集完成提示用中文，不再直接输出 following / followers',
  /'采集完成：' \+ \(src === 'followers' \? '粉丝' : '关注中'\)/.test(bridge) &&
  !/'采集完成：' \+ src/.test(bridge));
ok('品牌名与版本号作为专有名词保留', /v1\.5\.22/.test(followHtml) && /TapePost信仰者工具/.test(followHtml));

// ---------------------------------------------------------------- 7. 商店包
console.log('== 7. 商店包 ==');
const zipPath = path.join(DIR, 'store', 'TapePost_1.5.22_store.zip');
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
  eq('商店包 35 文件', names.length, 35);
  ok('七个新运行时文件都进包', NEW_FILES.concat(OVERLAY_FILES).every((f) => names.includes(f)));
  ok('测试脚本不进包', names.every((n) => !n.startsWith('test-')));
  ok('根目录即 manifest.json', names.includes('manifest.json'));
  const manEntry = entries['manifest.json'];
  if (manEntry) {
    const text = manEntry.method === 8
      ? zlib.inflateRawSync(manEntry.data).toString('utf8')
      : manEntry.data.toString('utf8');
    eq('包内 manifest 版本', JSON.parse(text).version, '1.5.22');
  }
  ok('包内文件与工作区逐字节一致', NEW_FILES.concat(OVERLAY_FILES).every((f) => {
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
      getManifest: () => ({ version: '1.5.22' }),
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
  ok('模拟：两份名单齐了才算未回关（bob 标、carol 不标）', (() => {
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

  // 打开「标红」开关：只有 bob 是未回关，carol 不应被标
  const ch = ov.els.tpfMark.handlers.change || [];
  if (ch.length) ch[0]({ target: { checked: true } });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  ok('模拟：标红开关只给未回关行加类 / 徽标',
    cells[0].classes.indexOf('tpf-row-notback') !== -1 &&
    cells[1].classes.indexOf('tpf-row-notback') === -1 &&
    ov.created.some((e) => e.className === 'tpf-badge' && e.textContent === '未回关'));
  ok('模拟：标红开关状态只存本机',
    db.followOverlayUi && db.followOverlayUi.markEnabled === true);

  await click('tpfPick');
  ok('模拟：「从当前位置选未回关」只写一次性待选草稿',
    db.followSelectionDraft && db.followSelectionDraft.from === 'overlay' &&
    db.followSelectionDraft.handles.indexOf('bob') !== -1 &&
    db.followSelectionDraft.handles.indexOf('carol') === -1);
  ok('模拟：带入待选后仍没有取关任务',
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
    /全量扫描/.test(overlayJs) && /增量续扫/.test(overlayJs) && /未回关/.test(overlayJs) &&
    /打开分析面板/.test(overlayJs) && !/'Scan'|"Scan"/.test(overlayJs) &&
    !/Followback Marker/.test(overlayJs.replace(/^[\s\S]*?\*\//, '')));
  ok('浮层样式全部带 tpf- 前缀，不污染 X 页面全局选择器',
    /#tpfOverlay/.test(overlayCss) && /\.tpf-/.test(overlayCss) &&
    !/^\s*(body|html|a|button|div)\s*\{/m.test(overlayCss));
  ok('桥接层支持 mode 与锚点，且面板无 mode 时行为不变',
    /KEY_ANCHOR/.test(bridge) && /cap\.mode/.test(bridge) &&
    /pendingScrollY/.test(bridge) && /行为与 1\.5\.20/.test(bridge));
  ok('面板消费待选草稿但绝不自动确认取关',
    /async function adoptDraft/.test(followJs) && /state\.selected\[k\] = true/.test(followJs) &&
    /protectedReasons/.test(followJs) && /id="draftHint"/.test(followHtml));
  ok('面板版本与提示同步 1.5.22',
    /v1\.5\.22/.test(followHtml) && /页面内扫描浮层/.test(followHtml));
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
        getManifest: () => ({ version: '1.5.22' }) }
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

persistenceChecks().then(overlayChecks).then(scanChecks).then(function () {
  console.log('\n结果：' + passed + '/' + (passed + failed) +
    (failed ? ' 通过，' + failed + ' 条失败' : ' 全部通过 ✓'));
  process.exit(failed ? 1 : 0);
}).catch(function (e) {
  console.log('  FAIL  持久化模拟异常：' + (e && e.stack || e));
  console.log('\n结果：' + passed + '/' + (passed + failed + 1) + ' 通过，' + (failed + 1) + ' 条失败');
  process.exit(1);
});
