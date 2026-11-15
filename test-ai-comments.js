/* TapePost 1.5.17 · AI 评论专项自检
 * 运行：node test-ai-comments.js   （不进 Chrome Web Store 商店包）
 * 覆盖：候选条数 1~10（默认 5）、三条生成链路的条数透传、DeepSeek 供应商文案、
 *       候选面板两列紧凑布局、手动兜底在 API 模式隐藏、设置页与预览。
 * 方式：直接 require 真实 grok.js；vm 加载真实 background.js / 从 content.js 抽取的真实函数。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DIR = __dirname;
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('FAIL ❌ ' + name + (extra ? ' | ' + extra : '')); }
};
const eq = (name, a, b) => ok(name, a === b, String(a) + ' !== ' + String(b));

const T = require('./grok.js');
const grokJs = read('grok.js');
const bgJs = read('background.js');
const contentJs = read('content.js');
const popupJs = read('popup.js');
const popupHtml = read('popup.html');
const nativeJs = read('grok-native.js');
const bridgeJs = read('grok-native-bridge.js');

// ---------------------------------------------------------------- 1. 条数
eq('默认 5 条', T.COMMENT_COUNT_DEFAULT, 5);
eq('上限 10 条', T.COMMENT_COUNT_MAX, 10);
eq('旧调用仍按 3 条', T.COMMENT_COUNT_LEGACY, 3);
ok('条数钳制：0/负数/非数字回落 5，11 截到 10',
  [0, -3, 'abc', undefined].every((v) => T.normalizeCommentCount(v, 5) === 5) &&
  T.normalizeCommentCount(11, 5) === 10 && T.normalizeCommentCount(7, 5) === 7);
ok('内置默认提示词按 N 条生成（3 / 5 / 10）',
  /3 条/.test(T.buildCommentMessages('推文', null)[1].content) &&
  /5 条/.test(T.buildCommentMessages('推文', null, 5)[1].content) &&
  /10 条/.test(T.buildCommentMessages('推文', null, 10)[1].content));
ok('输出示例数组跟着条数变',
  /"第一条", "第二条", "第三条"/.test(T.commentPromptFor(3)) &&
  /"第十条"/.test(T.commentPromptFor(10)) &&
  !/"第四条"/.test(T.commentPromptFor(3)));
ok('解析上限跟随条数，默认仍是 3 条',
  T.parseThreeComments(JSON.stringify(['a', 'b', 'c', 'd', 'e'])).length === 3 &&
  T.parseThreeComments(JSON.stringify(['a', 'b', 'c', 'd', 'e']), 5).length === 5);
ok('页面模式解析支持 5 条 JSON',
  T.parsePageAnswer(JSON.stringify(['甲回复内容', '乙回复内容', '丙回复内容', '丁回复内容', '戊回复内容']), 'comments', 5).length === 5);
ok('自定义模板同步条数，未传 count 时一字不改',
  /8 条/.test(T.applyCommentCount('请写三条短评：{POST}', 8)) &&
  T.applyCommentCount('请写三条短评：{POST}') === '请写三条短评：{POST}');
ok('自定义模板没写条数时补一句明确要求',
  /恰好 6 条候选/.test(T.applyCommentCount('根据 {POST} 写回复', 6)));
ok('站内直连 / 页面模式模板都按 N 条生成，旧调用保持 3 条',
  /7 条/.test(T.buildNativeCommentPrompt('推文', '', '', 7)) &&
  /9 条/.test(T.buildPageCommentPrompt('推文', '', '', 9)) &&
  /3 条/.test(T.buildNativeCommentPrompt('推文', '', '')) &&
  /3 条/.test(T.buildPageCommentPrompt('推文', '', '')));

// ---------------------------------------------------------------- 2. 后台端到端（vm 加载真实 background.js）
const state = {
  local: {
    deepseekApiKey: 'sk-test-1515', deepseekBaseUrl: 'https://api.deepseek.com',
    deepseekModel: 'deepseek-v4-flash', deepseekJsonMode: true,
    grokApiKey: '', grokBaseUrl: 'https://api.x.ai/v1', grokModel: 'grok-4.3'
  },
  sync: { grokMode: 'deepseek', commentCount: 5, commentPrompt: '', verifyPrompt: '' },
  fetchCalls: [],
  candidates: ['第一条回复', '第二条回复', '第三条回复', '第四条回复', '第五条回复']
};
const anyFn = new Proxy(function () {}, {
  get(t, k) { if (k === 'then' || typeof k === 'symbol') return undefined; return anyFn; },
  apply() { return Promise.resolve({}); }
});
function makeChrome() {
  const area = (bucket) => ({
    get(keys, cb) {
      const out = {};
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
        if (state[bucket][k] != null) out[k] = state[bucket][k];
      });
      if (typeof cb === 'function') cb(out);
      return Promise.resolve(out);
    },
    set(o) { Object.assign(state[bucket], o); return Promise.resolve(); },
    remove() { return Promise.resolve(); }
  });
  const base = {
    storage: { local: area('local'), sync: area('sync'), session: area('local') },
    runtime: {
      getManifest: () => ({ version: '1.5.18' }), getURL: (p) => 'chrome-extension://fake/' + p,
      sendMessage: () => Promise.resolve({}), onMessage: { addListener: () => {} },
      onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} }, lastError: null
    },
    tabs: {
      query: () => Promise.resolve([]), sendMessage: () => Promise.resolve({}),
      create: () => Promise.resolve({ id: 9 }), get: () => Promise.resolve({ id: 1 }),
      reload: () => Promise.resolve()
    },
    alarms: { onAlarm: { addListener: () => {} }, create: () => {}, clear: () => Promise.resolve(true) },
    downloads: { onCreated: { addListener: () => {} }, download: () => Promise.resolve(1) },
    notifications: { onClicked: { addListener: () => {} }, create: () => Promise.resolve('n') },
    permissions: { request: () => Promise.resolve(true), contains: () => Promise.resolve(true) },
    offscreen: { createDocument: () => Promise.resolve(), closeDocument: () => Promise.resolve() },
    declarativeNetRequest: { updateDynamicRules: () => Promise.resolve(), getDynamicRules: () => Promise.resolve([]) },
    windows: { create: () => Promise.resolve({}) }
  };
  return new Proxy(base, { get(t, k) { return (k in t) ? t[k] : anyFn; } });
}
const ctx = vm.createContext({
  console: { log() {}, warn() {}, error() {} },
  chrome: makeChrome(),
  fetch: (url, init) => {
    state.fetchCalls.push({ url: String(url), init });
    return Promise.resolve({
      ok: true, status: 200,
      text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: JSON.stringify(state.candidates) } }] })),
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(state.candidates) } }] })
    });
  },
  setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
  URL, TextEncoder, TextDecoder,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  navigator: { userAgent: 'Mozilla/5.0 Chrome/157.0.0.0' },
  importScripts: () => {},
  Blob: class { constructor(p, o) { this.parts = p || []; this.type = (o && o.type) || ''; } }
});
vm.runInContext(grokJs, ctx, { filename: 'grok.js' });
vm.runInContext(bgJs, ctx, { filename: 'background.js' });
const R = (expr) => vm.runInContext(expr, ctx, { timeout: 5000 });

// ---------------------------------------------------------------- 3. 轻量 DOM（用于 content.js 真实函数）
function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(), className: '', textContent: '', title: '',
    type: '', value: '', checked: false, selected: false, hidden: false,
    style: {}, children: [], listeners: {},
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    remove() { this.removed = true; },
    setAttribute(k, v) { this[k] = v; },
    _all() { return this.children.concat(this.children.reduce((a, c) => a.concat(c._all ? c._all() : []), [])); },
    _text() { return this._all().map((n) => n.textContent).join(' | '); }
  };
  return el;
}
const doc = {
  createElement: makeEl,
  getElementById: (id) => (doc._byId[id] || null),
  body: makeEl('body'),
  _byId: {}
};
const uiCtx = vm.createContext({
  console: { log() {}, warn() {}, error() {} },
  document: doc, window: { open: () => ({}) },
  chrome: { storage: { sync: { set: (o) => { uiCtx.__saved = Object.assign({}, uiCtx.__saved, o); } } } },
  settings: { grokMode: 'deepseek', commentCount: 5, grokFastMode: true, promoEnabled: false },
  setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {},
  Date, Math, parseInt, isFinite, String, Number, Object, Array, JSON, Promise, URLSearchParams,
  makeCommentEl: (tag, cls, text) => { const n = makeEl(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; },
  hideAiBusy: () => {}, showToast: () => {}, showNotice: () => {},
  buildCommentTexts: (cs) => ({ texts: cs, lines: [], enabled: false }),
  applyCommentToReply: () => true, copyTextFallback: () => Promise.resolve(true),
  bgSend: () => Promise.resolve({ ok: true }),
  resolveReplyContext: () => null, CARD_SELECTORS: ['article'],
  onAiComment: () => {}, showAiBusy: () => {},
  aiModeNow: () => String(uiCtx.settings.grokMode || 'auto').toLowerCase(),
  aiProviderName: (m) => ({ deepseek: 'DeepSeek API', api: 'xAI API', native: 'X 站内 Grok（直连）', page: 'X 站内 Grok（页面模式）' })[String(m || '').toLowerCase()] || 'X 站内 Grok',
  aiShortName: (m) => ({ deepseek: 'DeepSeek', api: 'xAI API' })[String(m || '').toLowerCase()] || 'Grok',
  isApiAiMode: (m) => ['deepseek', 'api'].indexOf(String(m || '').toLowerCase()) >= 0,
  commentCountNow: () => { const n = parseInt(uiCtx.settings.commentCount, 10); return isFinite(n) ? Math.max(1, Math.min(10, n)) : 5; }
});
// 把 content.js 里真实的 helper / showAiBusy / showCommentPicker 抽出来跑，避免只测字符串
const helpers = contentJs.slice(contentJs.indexOf('function aiModeNow()'), contentJs.indexOf('function loadSettings()'));
const busyBody = (contentJs.match(/function showAiBusy\(label[\s\S]*?\n\}\n/) || [''])[0];
const pickerBody = contentJs.slice(contentJs.indexOf('function showCommentPicker('), contentJs.indexOf('// ---------- 结果处理 ----------'));
vm.runInContext(helpers + '\n' + busyBody + '\n' + pickerBody, uiCtx, { filename: 'content-extract.js' });

(async () => {
  // ---- 配置与端到端 ----
  const cfg = await R('getGrokConfig()');
  eq('后台读到默认 5 条', cfg.commentCount, 5);
  eq('DeepSeek 模式供应商判定', cfg.aiProvider, 'deepseek');
  eq('5 条时 max_tokens 放宽到 1220', R('commentMaxTokens(5)'), 1220);
  eq('10 条时 max_tokens 放宽到 2120', R('commentMaxTokens(10)'), 2120);
  eq('供应商标签：DeepSeek', R('aiProviderLabel("deepseek")'), 'DeepSeek API');
  eq('供应商标签：xAI API', R('aiProviderLabel("api")'), 'xAI API');
  eq('供应商标签：站内直连', R('aiProviderLabel("native")'), 'X 站内 Grok');

  state.fetchCalls = [];
  const r5 = await R('handleGrokMessage({type:"GROK_COMMENTS",payload:{text:"TapeOut 生态又多了新应用"}},{tab:{id:1,url:"https://x.com/home"}})');
  eq('DeepSeek 生成返回 5 条候选', r5.comments && r5.comments.length, 5);
  eq('结果带 provider=DeepSeek API', r5.provider, 'DeepSeek API');
  eq('结果带 count=5', r5.count, 5);
  ok('发给 DeepSeek 的提示词写的是 5 条',
    /5 条/.test(JSON.parse(state.fetchCalls[0].init.body).messages.map((m) => m.content).join('\n')),
    JSON.parse(state.fetchCalls[0].init.body).messages.map((m) => m.content).join('\n').slice(0, 120));
  ok('发给 DeepSeek 的请求没有 Grok 字样',
    !/Grok/.test(JSON.parse(state.fetchCalls[0].init.body).messages.map((m) => m.content).join('\n')));

  state.sync.commentCount = 10;
  state.candidates = Array.from({ length: 10 }, (_, i) => '第' + (i + 1) + '条候选回复内容');
  const r10 = await R('handleGrokMessage({type:"GROK_COMMENTS",payload:{text:"测试推文"}},{tab:{id:1,url:"https://x.com/home"}})');
  eq('改成 10 条后返回 10 条候选', r10.comments && r10.comments.length, 10);
  eq('10 条结果 count=10', r10.count, 10);
  state.sync.commentCount = 99;
  eq('非法/越界设置被钳制到 10', (await R('getGrokConfig()')).commentCount, 10);
  state.sync.commentCount = 5;

  // ---- 等待浮层：真实 showAiBusy ----
  doc._byId = {};
  const busy = vm.runInContext('showAiBusy()', uiCtx);
  const busyText = busy._all().map((n) => n.textContent).join(' | ');
  ok('等待浮层标题写 DeepSeek 与 5 条', /DeepSeek 正在生成 5 条回复候选/.test(busyText), busyText);
  ok('等待浮层阶段不再写 Grok', /正在连接 DeepSeek/.test(busyText) && !/Grok/.test(busyText));
  ok('等待浮层保留 spinner / 阶段 / 耗时 / 关闭按钮',
    busy._all().some((n) => n.className === 'wbx-busy-spin') &&
    busy._all().some((n) => n.className === 'wbx-busy-stage') &&
    busy._all().some((n) => n.className === 'wbx-busy-time') &&
    busy._all().some((n) => n.className === 'wbx-busy-cancel'));
  uiCtx.settings.grokMode = 'native';
  doc._byId = {};
  const busyGrok = vm.runInContext('showAiBusy()', uiCtx);
  ok('Grok 模式仍显示 Grok（不误标 DeepSeek）',
    /Grok 正在生成 5 条回复候选/.test(busyGrok._all().map((n) => n.textContent).join(' | ')));
  uiCtx.settings.grokMode = 'deepseek';

  // ---- 结果面板：真实 showCommentPicker ----
  const five = ['角度一：认同并补充信息', '角度二：提个有价值的问题', '角度三：独立观点', '角度四：换个角度类比', '角度五：点到为止的提醒'];
  doc._byId = {};
  uiCtx.__saved = null;
  vm.runInContext('showCommentPicker(' + JSON.stringify(five) + ',"123",null,null,"推文正文","deepseek",{provider:"DeepSeek API",count:5,strict:true})', uiCtx);
  const panel = doc.body.children[doc.body.children.length - 1];
  const all = panel._all();
  const head = panel.children[0];
  const headText = head._text();
  ok('结果头部写 DeepSeek API 且不写 Grok',
    /DeepSeek API 生成的 5 条回复候选/.test(headText) && !/Grok/.test(headText), headText);
  ok('供应商徽标显示 DeepSeek API', all.some((n) => n.className === 'wbx-c-badge' && n.textContent === 'DeepSeek API'));
  const grid = panel.children.find((n) => /wbx-c-grid/.test(n.className));
  ok('5 条候选启用两列紧凑网格', !!grid && /dense/.test(grid.className) && grid.children.length === 5);
  const countSel = all.find((n) => n.className === 'wbx-c-count');
  ok('条数下拉有 10 个选项且选中 5', !!countSel && countSel.children.length === 10 &&
    countSel.children.filter((o) => o.selected)[0].value === '5');
  const manual = panel.children.find((n) => n.className === 'wbx-c-manual');
  ok('DeepSeek 模式隐藏「读取 Grok 回答」手动兜底', !!manual && manual.style.display === 'none');
  ok('结果面板不再出现 Grok 字样', !/Grok/.test(panel._text()), panel._text().slice(0, 200));

  doc._byId = {};
  vm.runInContext('showCommentPicker(["甲回复内容","乙回复内容","丙回复内容"],"123",null,null,"推文","native",{provider:"X 站内 Grok（直连）",count:3,strict:true})', uiCtx);
  const panel3 = doc.body.children[doc.body.children.length - 1];
  const grid3 = panel3.children.find((n) => /wbx-c-grid/.test(n.className));
  ok('3 条以内保持单列（不硬挤两列）', !!grid3 && !/dense/.test(grid3.className));
  const manual3 = panel3.children.find((n) => n.className === 'wbx-c-manual');
  ok('Grok 模式保留手动兜底', !!manual3 && manual3.style.display !== 'none');
  ok('Grok 模式头部写 X 站内 Grok', /X 站内 Grok/.test(panel3.children[0]._text()));

  // ---- 源码结构 ----
  ok('后台把条数传给站内直连与页面模式',
    /GROK_NATIVE_CALL[\s\S]{0,160}count: count/.test(bgJs) &&
    /buildNativeCommentPrompt\(payload\.text \|\| ''[\s\S]{0,160}, count\)/.test(bgJs) &&
    /buildPageCommentPrompt\(payload\.text \|\| ''[\s\S]{0,160}cfg\.commentCount\)/.test(bgJs));
  ok('站内直连桥与 MAIN world 脚本透传条数',
    /count: msg\.count/.test(bridgeJs) && /count: d\.count/.test(nativeJs) && /wantedCount/.test(nativeJs));
  ok('设置页有 1~10 共 10 个选项、默认 5',
    (popupHtml.match(/<option value="\d+">/g) || []).length >= 10 &&
    /<option value="5" selected>5 条<\/option>/.test(popupHtml));
  ok('设置页标题不再只写 Grok', /🤖 AI 设置（DeepSeek \/ xAI \/ Grok）/.test(popupHtml));
  ok('提示词预览按条数构造并标注供应商',
    /buildCommentMessages\(samplePost, val\('commentPrompt'\), count\)/.test(popupJs) &&
    /实际发送内容｜' \+ who \+ ' · ' \+ count \+ ' 条候选/.test(popupJs));
  ok('候选面板 CSS 有两列网格与紧凑卡片',
    /\.wbx-c-grid\.dense\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);\}/.test(contentJs) &&
    /#wbx-comments\{[\s\S]{0,300}width:440px/.test(contentJs));
  ok('内容脚本监听条数与模式变化',
    /'commentCount', 'grokMode'\]/.test(contentJs));

  console.log('\n结果：' + pass + '/' + (pass + fail) + (fail ? '，' + fail + ' 条失败 ❌' : '  全部通过 ✓'));
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('测试异常：', e && e.stack || e);
  process.exitCode = 1;
});
