/* TapePost 1.5.3 · DeepSeek API 模式专项自检（模拟 MV3 Service Worker 沙箱）
 * 运行：node test-deepseek.js   （不进 Chrome Web Store 商店包）
 * 覆盖：模式判定、配置读取、端点 / 请求体、认证头、错误文案、两个 AI 功能与自检入口。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DIR = __dirname;
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

const state = {
  local: {
    grokApiKey: 'XAI-KEY-MUST-NOT-BE-USED',
    grokBaseUrl: 'https://api.x.ai/v1',
    grokModel: 'grok-4.3',
    grokProtocol: 'chat',
    grokTemperature: 0.7,
    deepseekApiKey: 'sk-deepseek-test-123',
    deepseekBaseUrl: 'https://api.deepseek.com',
    deepseekModel: 'deepseek-v4-flash',
    deepseekTemperature: 0.7,
    deepseekJsonMode: true
  },
  sync: { grokMode: 'deepseek', commentPrompt: '', verifyPrompt: '' },
  fetchCalls: [],
  failStatus: 0
};

const AI_REPLY = JSON.stringify({
  comments: ['第一条候选回复', '第二条候选回复', '第三条候选回复'],
  verdict: 'official', reason: '清单命中', risk: 'low', matched: 'tapeout.link'
});

function fetchMock(url, init) {
  state.fetchCalls.push({ url: String(url), init });
  if (state.failStatus) {
    const st = state.failStatus;
    return Promise.resolve({
      ok: false, status: st,
      text: () => Promise.resolve(JSON.stringify({ error: { message: 'upstream says no' } }))
    });
  }
  return Promise.resolve({
    ok: true, status: 200,
    text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: AI_REPLY } }] })),
    json: () => Promise.resolve({ choices: [{ message: { content: AI_REPLY } }] })
  });
}

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
      getManifest: () => ({ version: '1.5.3' }),
      getURL: (p) => 'chrome-extension://fake/' + p,
      sendMessage: () => Promise.resolve({}),
      onMessage: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      lastError: null
    },
    tabs: {
      query: () => Promise.resolve([]), sendMessage: () => Promise.resolve({}),
      create: () => Promise.resolve({ id: 9 }), get: () => Promise.resolve({ id: 1 }),
      reload: () => Promise.resolve()
    },
    downloads: { onCreated: { addListener: () => {} }, download: () => Promise.resolve(1) },
    notifications: { onClicked: { addListener: () => {} }, create: () => Promise.resolve('n') },
    alarms: { onAlarm: { addListener: () => {} }, create: () => {}, clear: () => Promise.resolve(true) },
    declarativeNetRequest: { updateDynamicRules: () => Promise.resolve(), getDynamicRules: () => Promise.resolve([]) },
    permissions: { request: () => Promise.resolve(true), contains: () => Promise.resolve(true) },
    offscreen: { createDocument: () => Promise.resolve(), closeDocument: () => Promise.resolve() },
    windows: { create: () => Promise.resolve({}) }
  };
  return new Proxy(base, { get(t, k) { return (k in t) ? t[k] : anyFn; } });
}

const g = {
  console: { log() {}, warn() {}, error() {} },
  chrome: makeChrome(),
  fetch: fetchMock,
  setTimeout, clearTimeout,
  setInterval: () => 1, clearInterval: () => {},
  URL, TextEncoder, TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  navigator: { userAgent: 'Mozilla/5.0 Chrome/157.0.0.0' },
  importScripts: () => {},
  Blob: class { constructor(p, o) { this.parts = p || []; this.type = (o && o.type) || ''; } }
};
const ctx = vm.createContext(g);
vm.runInContext(read('grok.js'), ctx, { filename: 'grok.js' });
vm.runInContext(read('background.js'), ctx, { filename: 'background.js' });
const R = (expr) => vm.runInContext(expr, ctx, { timeout: 5000 });

const checks = [];
const A = (name, cond, extra) => checks.push({ name, pass: !!cond, extra });
const reset = () => { state.fetchCalls = []; state.failStatus = 0; };

(async () => {
  // ---- 1. 模式判定 ----
  A('grok.js 显式 deepseek 直接返回，不降级',
    R('TapeAI.pickGrokMode({grokMode:"deepseek"})') === 'deepseek' &&
    R('TapeAI.pickGrokMode({grokMode:"deepseek"}, {inXTab:true})') === 'deepseek');
  A('auto / api / native / page 原语义不变',
    R('TapeAI.pickGrokMode({grokMode:"api"})') === 'api' &&
    R('TapeAI.pickGrokMode({grokMode:"native"})') === 'native' &&
    R('TapeAI.pickGrokMode({grokMode:"page"})') === 'page');

  // ---- 2. 配置读取 ----
  const cfg = await R('getGrokConfig()');
  A('getGrokConfig 按模式给出 aiProvider=deepseek', cfg.aiProvider === 'deepseek', cfg.aiProvider);
  A('DeepSeek 与 xAI 的 Key / 模型分开读取',
    cfg.deepseekApiKey === 'sk-deepseek-test-123' && cfg.grokApiKey === 'XAI-KEY-MUST-NOT-BE-USED');
  state.sync.grokMode = 'auto';
  const cfgAuto = await R('getGrokConfig()');
  A('auto 模式仍为 aiProvider=xai（既有行为不变）', cfgAuto.aiProvider === 'xai');
  state.sync.grokMode = 'deepseek';

  // ---- 3. 端点 / 请求体 ----
  ctx.__cfg = cfg;
  A('deepseekEndpoint 官方根地址补 /chat/completions',
    R('deepseekEndpoint(__cfg)') === 'https://api.deepseek.com/chat/completions');
  A('deepseekEndpoint 接受 /v1 写法',
    R('deepseekEndpoint(Object.assign({},__cfg,{deepseekBaseUrl:"https://api.deepseek.com/v1/"}))') ===
    'https://api.deepseek.com/v1/chat/completions');
  A('deepseekEndpoint 不重复追加完整路径',
    R('deepseekEndpoint(Object.assign({},__cfg,{deepseekBaseUrl:"https://gw.example.com/v1/chat/completions"}))') ===
    'https://gw.example.com/v1/chat/completions');
  const body = R('deepseekBody(__cfg, [{role:"user", content:"hi"}], 700)');
  A('deepseekBody 模型 / messages / max_tokens / stream:false',
    body.model === 'deepseek-v4-flash' && body.messages.length >= 1 &&
    body.max_tokens === 700 && body.stream === false);
  A('deepseekBody 默认开启 response_format=json_object',
    body.response_format && body.response_format.type === 'json_object');
  const noJsonBody = R('deepseekBody(__cfg, [{role:"user",content:"随便说点什么"}], 16)');
  A('自定义提示词无 json 字样时自动补 JSON system 提示（官方 JSON Output 硬性要求）',
    noJsonBody.messages.length === 2 && /json/i.test(noJsonBody.messages[0].content));
  A('提示词已含 json 时不重复追加',
    R('deepseekBody(__cfg, [{role:"user",content:"请输出 JSON 数组"}], 16).messages.length') === 1);
  const jsonOff = R('deepseekBody(Object.assign({},__cfg,{deepseekJsonMode:false}), [{role:"user",content:"hi"}], 16)');
  A('F闭「强制 JSON 输出」后不带 response_format 也不补提示词',
    !('response_format' in jsonOff) && jsonOff.messages.length === 1);

  // ---- 4. callGrok：认证头 / 端点 / 返回 ----
  reset();
  const r = await R('callGrok([{role:"user",content:"hi"}], 700, __cfg)');
  const c0 = state.fetchCalls[0];
  const sent = JSON.parse(c0.init.body);
  A('callGrok 打到 api.deepseek.com/chat/completions',
    c0.url === 'https://api.deepseek.com/chat/completions', c0.url);
  A('认证头用的是 DeepSeek Key，不是 xAI Key',
    c0.init.headers.Authorization === 'Bearer sk-deepseek-test-123', c0.init.headers.Authorization);
  A('请求体带 response_format 与 DeepSeek 模型',
    sent.model === 'deepseek-v4-flash' && sent.response_format.type === 'json_object');
  A('callGrok 返回 model / protocol / endpoint',
    r.model === 'deepseek-v4-flash' && r.protocol === 'chat' && /api\.deepseek\.com/.test(r.endpoint));
  A('callGrok 正确取出 choices[0].message.content', r.text === AI_REPLY);

  // ---- 5. xAI 模式不受影响 ----
  reset();
  ctx.__cfgAuto = cfgAuto;
  const rx = await R('callGrok([{role:"user",content:"hi"}], 16, __cfgAuto)');
  A('xAI 模式仍请求 api.x.ai/v1/chat/completions',
    state.fetchCalls[0].url === 'https://api.x.ai/v1/chat/completions', state.fetchCalls[0].url);
  A('xAI 模式仍用 xAI Key',
    state.fetchCalls[0].init.headers.Authorization === 'Bearer XAI-KEY-MUST-NOT-BE-USED');

  // ---- 6. 错误文案按供应商区分 ----
  for (const [st, word] of [[401, 'DeepSeek Key'], [404, 'deepseek-v4-flash'], [429, 'platform.deepseek.com'], [503, 'DeepSeek 服务端']]) {
    state.failStatus = st;
    let err = '';
    try { await R('callGrok([{role:"user",content:"hi"}], 16, __cfg)'); } catch (e) { err = String(e && e.message || e); }
    A('HTTP ' + st + ' 错误文案指向 ' + word, err.includes(word), err.slice(0, 110));
  }
  state.failStatus = 0;

  // ---- 7. 未填 Key 明确报错且不发请求 ----
  reset();
  let noKeyErr = '';
  try {
    await R('callGrok([{role:"user",content:"hi"}], 16, Object.assign({},__cfg,{deepseekApiKey:""}))');
  } catch (e) { noKeyErr = String(e && e.message || e); }
  A('未填 DeepSeek Key 时报错且不发网络请求',
    /DeepSeek API Key/.test(noKeyErr) && state.fetchCalls.length === 0, noKeyErr.slice(0, 100));

  // ---- 8. runGrok ----
  reset();
  const rr = await R('runGrok([{role:"user",content:"hi"}], 700, __cfg, "comments", "示例推文")');
  A('runGrok 返回 mode=deepseek 且走 API 链路', rr.mode === 'deepseek' && rr.text === AI_REPLY);

  // ---- 9. 三个消息入口 ----
  const sender = { tab: { id: 1, url: 'https://x.com/home' } };
  ctx.__sender = sender;
  reset();
  const t2 = await R('handleGrokMessage({type:"GROK_TEST",payload:{}}, __sender)');
  A('GROK_TEST 回报 mode=deepseek 且请求打给 DeepSeek',
    t2.ok && t2.mode === 'deepseek' && state.fetchCalls.some((c) => /api\.deepseek\.com/.test(c.url)),
    'mode=' + t2.mode);

  reset();
  const cm = await R('handleGrokMessage({type:"GROK_COMMENTS",payload:{text:"示例推文正文"}}, __sender)');
  A('GROK_COMMENTS 走 DeepSeek 并解析出 3 条候选',
    cm.ok && cm.mode === 'deepseek' && cm.comments.length === 3 &&
    /deepseek-v4-flash/.test(cm.model) && state.fetchCalls.some((c) => /api\.deepseek\.com/.test(c.url)),
    'mode=' + cm.mode + ' n=' + (cm.comments || []).length);

  reset();
  const vf = await R('handleGrokMessage({type:"GROK_VERIFY",payload:{url:"https://tapeout.link"}}, __sender)');
  A('GROK_VERIFY 走 DeepSeek 且解析出结论',
    vf.mode === 'deepseek' && vf.grok && vf.grok.verdict === 'official' && !vf.aiError,
    'mode=' + vf.mode + ' verdict=' + (vf.grok && vf.grok.verdict) + ' err=' + vf.aiError);

  reset();
  const pr = await R('handleGrokMessage({type:"GROK_PAGE_RESET",payload:{}}, __sender)');
  A('GROK_PAGE_RESET 识别 DeepSeek API 模式', pr.mode === 'deepseek' && /DeepSeek/.test(pr.note));

  // ---- 输出 ----
  const bad = checks.filter((c) => !c.pass);
  console.log('\n=== TapePost 1.5.3 · DeepSeek API 专项自检 ===');
  checks.forEach((c) => console.log((c.pass ? 'PASS ✅ ' : 'FAIL ❌ ') + c.name +
    (c.extra && !c.pass ? '  → ' + c.extra : '')));
  console.log(`\n${checks.length - bad.length}/${checks.length} 通过`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
