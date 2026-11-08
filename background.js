/*
 * background.js — 后台服务 worker
 * 职责：
 *   1. 用 declarativeNetRequest 给各站图床注入对应站点 Referer
 *      （微博→weibo.com、知乎→zhihu.com、公众号→mp.weixin.qq.com、
 *       B站→t.bilibili.com、豆瓣→douban.com、小红书→xiaohongshu.com），
 *      图床强制校验 Referer，否则 403。
 *   2. 管理离屏文档(offscreen)，负责消息路由 requestId → tabId。
 *   3. 把处理后的图片写入下载（作为剪贴板失败时的备份）。
 */
'use strict';

// ---- 1. DNR：给图床注入 Referer ----
/*
 * urlFilter 用 ||域名/ 的域名锚点写法：
 *   - 'sinaimg.cn' 这种裸字符串会误伤任何 URL 里带该字样的请求；
 *   - ||sinaimg.cn/ 精确匹配主域 + 全部子域，规则不会因格式问题被拒。
 * 注意：operation 必须是 set（append 对 Referer 不在允许列表里，会导致规则无效）。
 */
/*
 * 每个站点的图床防盗链要求不同，Referer 必须按站给：
 *   微博 → weibo.com、知乎 → zhihu.com、公众号 → mp.weixin.qq.com、
 *   B站 → t.bilibili.com、豆瓣 → douban.com、小红书 → xiaohongshu.com、
 *   X 推文 → x.com（pbs.twimg.com 原图）。
 * 与 sites.js 里各 profile 的 referer / refererHosts 一一对应。
 * 1001/1002 保持原微博规则不变，避免已验证的链路回归。
 */
const SITE_REFERER_RULES = [
  { id: 1001, host: 'sinaimg.cn',   referer: 'https://weibo.com/',          types: ['xmlhttprequest', 'image', 'other'] },
  { id: 1002, host: 'weibocdn.com', referer: 'https://weibo.com/',          types: ['xmlhttprequest', 'media', 'other'] },
  { id: 1003, host: 'zhimg.com',    referer: 'https://www.zhihu.com/',      types: ['xmlhttprequest', 'image', 'other'] },
  { id: 1004, host: 'qpic.cn',      referer: 'https://mp.weixin.qq.com/',   types: ['xmlhttprequest', 'image', 'other'] },
  { id: 1005, host: 'hdslb.com',    referer: 'https://t.bilibili.com/',     types: ['xmlhttprequest', 'image', 'media', 'other'] },
  { id: 1006, host: 'bfsstatic.com',referer: 'https://t.bilibili.com/',     types: ['xmlhttprequest', 'image', 'other'] },
  { id: 1007, host: 'doubanio.com', referer: 'https://www.douban.com/',     types: ['xmlhttprequest', 'image', 'other'] },
  { id: 1008, host: 'xhscdn.com',   referer: 'https://www.xiaohongshu.com/',types: ['xmlhttprequest', 'image', 'other'] },
  { id: 1009, host: 'twimg.com',    referer: 'https://x.com/',            types: ['xmlhttprequest', 'image', 'media', 'other'] }
];

const REFERRER_RULES = SITE_REFERER_RULES.map((r) => ({
  id: r.id,
  priority: 1,
  action: {
    type: 'modifyHeaders',
    requestHeaders: [{ header: 'Referer', operation: 'set', value: r.referer }]
  },
  condition: {
    urlFilter: '||' + r.host + '/',
    resourceTypes: r.types
  }
}));

// 最近一次内部错误：供弹窗「运行环境自检」读取，避免只看得到一句笼统报错
let lastError = null;
let refererRulesPromise = null;

async function installRefererRules() {
  // 重新加载扩展时 onInstalled / onStartup / 顶层可能同时触发，
  // 并发调用 updateDynamicRules 会抛 "operation in progress"，这里做幂等去重。
  if (refererRulesPromise) return refererRulesPromise;
  refererRulesPromise = (async () => {
    try {
      if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) {
        throw new Error('declarativeNetRequest API 不可用（权限未生效或 Chrome 版本过低）');
      }
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: REFERRER_RULES.map(r => r.id),
        addRules: REFERRER_RULES
      });
      lastError = null;
      return true;
    } catch (e) {
      lastError = 'DNR 规则注册失败: ' + String(e && e.message || e);
      console.warn('[bg] ' + lastError, e);
      return false;
    } finally {
      refererRulesPromise = null;
    }
  })();
  return refererRulesPromise;
}

// ---- 2. 离屏文档管理 ----
let offscreenReady = false;
let offscreenCreating = null;

async function ensureOffscreen() {
  if (offscreenReady) return;
  if (offscreenCreating) return offscreenCreating;
  offscreenCreating = (async () => {
    try {
      // 若已存在则先尝试；hasDocument 较新版本才有，做容错
      if (chrome.offscreen.hasDocument) {
        const has = await chrome.offscreen.hasDocument();
        if (has) { offscreenReady = true; return; }
      }
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL('offscreen.html'),
        // 必须是 chrome.offscreen.Reason 的合法枚举值（官方文档共 15 个）。
        // BLOBS: Blob/createImageBitmap/OffscreenCanvas 处理图片；CLIPBOARD: 写系统剪贴板。
        reasons: ['BLOBS', 'CLIPBOARD'],
        justification: '在扩展上下文用 Blob、createImageBitmap 与 OffscreenCanvas 拉取并处理各站点内容图片、按检测结果为微博图片去水印，并把首图写入系统剪贴板'
      });
      // createDocument 的 Promise resolve 即代表文档已创建可用，不再等 ready 消息（避免竞态）
      offscreenReady = true;
    } catch (e) {
      const why = String(e && e.message || e);
      lastError = '离屏文档创建失败: ' + why;
      console.warn('[bg] ' + lastError, e);
      // 不要把错误吞掉：否则后面只会报一句笼统的 "Could not establish connection"，
      // 看不到真正原因（如非法 Reason、重复创建、权限被禁用）。
      throw new Error(lastError);
    } finally {
      offscreenCreating = null;
    }
  })();
  return offscreenCreating;
}

// ---- 3. Grok 客户端 ----
/*
 * 两个 AI 功能共用这一段，支持两种运行模式：
 *   api  — Service Worker 直连 api.x.ai（需 Key，按量计费）
 *   page — 把提示词送进用户已登录的 x.com 站内 Grok 页面/浮窗，读回回答（免 Key、免费）
 *   auto — 有 Key 走 api，没 Key 自动降级 page
 * 消息类型：
 *   GROK_COMMENTS      — X 一键评论，按设定提示词生成 3 条回复候选
 *   GROK_VERIFY        — TapeOut 生态面板的链接真伪查询
 *   GROK_TEST          — 设置面板「测试当前模式」
 *   GROK_PAGE_PREPARE  — 手动兜底①：只填提示词，不发送
 *   GROK_PAGE_READ     — 手动兜底②：读回 Grok 页面上已生成的回答
 *
 * 页面模式里扩展自己不向任何 AI 服务发请求，也不接触 X 的登录态；
 * 对话完全发生在 X 页面里，由 grok-page.js 做 DOM 操作。
 * API Key 只存在 chrome.storage.local（本机、不同步、不入库、不上报），
 * 页面 content script 永远拿不到密钥。
 * 错误写进独立的 lastGrokError，绝不污染 DIAG 用的 lastError（自检回归依赖它为空）。
 */
try {
  if (typeof TapeAI === 'undefined' && typeof importScripts === 'function') importScripts('grok.js');
} catch (e) { /* 独立测试环境无 importScripts，Grok 分支会给出明确提示 */ }

const GROK_DEFAULTS = {
  grokProtocol: 'chat',              // chat = /chat/completions（OpenAI 兼容）；responses = /responses
  grokBaseUrl: 'https://api.x.ai/v1',
  grokModel: 'grok-4.3',             // 2026-11 官方在售；grok-3 / grok-4-fast-* 已于 2026-05-15 退役
  grokTemperature: 0.7
};
let lastGrokError = null;

function storageGet(area, keys) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v || {}); } };
    try {
      const r = chrome.storage[area].get(keys, done);
      // Chrome 95+ 同时支持 Promise 形式；两种环境都兼容
      if (r && typeof r.then === 'function') r.then(done).catch(() => done({}));
    } catch (e) { done({}); }
    setTimeout(() => done({}), 3000);
  });
}

const PAGE_CFG_KEYS = (typeof TapeAI !== 'undefined' && TapeAI.PAGE_MODE_DEFAULTS)
  ? Object.keys(TapeAI.PAGE_MODE_DEFAULTS) : [];

async function getGrokConfig() {
  const [secret, pref] = await Promise.all([
    storageGet('local', ['grokApiKey', 'grokBaseUrl', 'grokModel', 'grokProtocol', 'grokTemperature']),
    storageGet('sync', ['commentPrompt', 'verifyPrompt'].concat(PAGE_CFG_KEYS))
  ]);
  const page = {};
  PAGE_CFG_KEYS.forEach((k) => {
    const v = pref[k];
    page[k] = (v == null || v === '') ? TapeAI.PAGE_MODE_DEFAULTS[k] : v;
  });
  return Object.assign({}, GROK_DEFAULTS, page, secret, {
    commentPrompt: pref.commentPrompt || '',
    verifyPrompt: pref.verifyPrompt || ''
  });
}

function grokEndpoint(cfg) {
  const base = String(cfg.grokBaseUrl || GROK_DEFAULTS.grokBaseUrl).replace(/\/+$/, '');
  return base + (cfg.grokProtocol === 'responses' ? '/responses' : '/chat/completions');
}

function grokBody(cfg, messages, maxTokens) {
  const model = cfg.grokModel || GROK_DEFAULTS.grokModel;
  const temperature = Number(cfg.grokTemperature);
  const temp = isFinite(temperature) ? Math.min(1, Math.max(0, temperature)) : 0.7;
  if (cfg.grokProtocol === 'responses') {
    const instructions = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const input = messages.filter(m => m.role !== 'system').map(m => m.content).join('\n\n');
    return {
      model, input, instructions, temperature: temp,
      max_output_tokens: maxTokens || 700, stream: false, store: false
    };
  }
  return { model, messages, temperature: temp, max_tokens: maxTokens || 700, stream: false };
}

function grokText(data, protocol) {
  if (!data) return '';
  if (protocol === 'responses') {
    if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
    const out = data.output || [];
    const chunks = [];
    out.forEach((o) => (o && o.content || []).forEach((c) => {
      if (c && (c.type === 'output_text' || c.type === 'text') && c.text) chunks.push(c.text);
    }));
    return chunks.join('\n');
  }
  try { return data.choices[0].message.content || ''; } catch (e) { return ''; }
}

function grokFriendlyError(status, bodyText) {
  let detail = '';
  try {
    const j = JSON.parse(bodyText);
    detail = (j && (j.error && (j.error.message || j.error) || j.message)) || '';
  } catch (e) { detail = String(bodyText || '').slice(0, 160); }
  detail = String(detail).slice(0, 220);
  if (status === 401 || status === 403) return 'API Key 无效或没有权限（HTTP ' + status + '）。请到设置里重新填写 xAI Key。' + (detail ? ' ' + detail : '');
  if (status === 404) return '接口或模型不存在（HTTP 404）。请检查「接口地址 / 协议 / 模型 ID」，当前默认模型是 grok-4.3。';
  if (status === 429) return '调用太频繁或额度不足（HTTP 429）。稍等片刻再试，或到 console.x.ai 查看额度。';
  if (status >= 500) return 'xAI 服务端暂时不可用（HTTP ' + status + '），请稍后重试。';
  return '请求失败（HTTP ' + status + '）' + (detail ? '：' + detail : '');
}

async function callGrok(messages, maxTokens, cfgIn) {
  const cfg = cfgIn || await getGrokConfig();
  const key = String(cfg.grokApiKey || '').trim();
  if (!key) throw new Error('还没有填 xAI API Key。请点插件图标 →「Grok 设置」填入 Key（只存在本机，不会上传）。');
  if (typeof TapeAI === 'undefined') throw new Error('共享逻辑未加载，请在 chrome://extensions 重新加载扩展。');

  const endpoint = grokEndpoint(cfg);
  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify(grokBody(cfg, messages, maxTokens))
    });
  } catch (e) {
    throw new Error('无法连接 ' + endpoint + '（' + String(e && e.message || e) + '）。国内网络通常需要代理；也可以在设置里换用兼容网关地址。');
  }
  const raw = await resp.text();
  if (!resp.ok) throw new Error(grokFriendlyError(resp.status, raw));
  let data;
  try { data = JSON.parse(raw); } catch (e) { throw new Error('接口返回的不是 JSON：' + raw.slice(0, 120)); }
  const text = grokText(data, cfg.grokProtocol);
  if (!text) throw new Error('接口返回了空内容，请把「接口协议」切换成另一项后重试。');
  return { text, model: cfg.grokModel, protocol: cfg.grokProtocol, endpoint };
}

// ---- 3b. 非 API 模式：把提示词送进 x.com 站内 Grok，再读回回答文本 ----
/*
 * 扩展自己不向 xAI 发任何请求；对话完全发生在用户已登录的 X 页面里。
 * 优先复用「已经有 Grok 输入框」的标签（含时间线上的 Grok 浮窗），
 * 没有才在后台新建 x.com/i/grok 标签，避免打断用户当前操作。
 */
let pageTabPromise = null;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (r) => {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(r);
      });
    } catch (e) { reject(e); }
  });
}

async function pagePing(tabId, cfg) {
  try { return await sendToTab(tabId, { type: 'GROK_PAGE_BRIDGE', action: 'ping', config: cfg }); }
  catch (e) { return null; }
}

async function ensurePageTab(cfg) {
  if (pageTabPromise) return pageTabPromise;
  const job = (async () => {
    let tabs = [];
    try {
      tabs = (await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] })) || [];
    } catch (e) { /* 没有 tabs 权限时可能拿不到，直接走新建分支 */ }

    // 1) 已经能对话的标签：时间线浮窗 / 用户自己开着的 Grok 页
    for (const t of tabs) {
      const p = await pagePing(t.id, cfg);
      if (p && p.ok && p.hasInput) return { tabId: t.id, ping: p, created: false };
    }
    // 2) 已打开但还在加载的 /i/grok
    const grok = tabs.find((t) => /\/i\/grok(?:\/|\?|$)/.test(String(t.url || '')));
    if (grok) {
      for (let i = 0; i < 12; i++) {
        const p = await pagePing(grok.id, cfg);
        if (p && p.ok && p.hasInput) return { tabId: grok.id, ping: p, created: false };
        await sleep(500);
      }
      return { tabId: grok.id, ping: null, created: false };
    }
    // 3) 后台新开一个 Grok 页面（active:false，不抢焦点）
    let url = String(cfg.grokPageUrl || 'https://x.com/i/grok').trim();
    if (!/^https:\/\/(?:x\.com|twitter\.com)\//i.test(url)) url = 'https://x.com/i/grok'; // 只允许 X 站内
    const created = await chrome.tabs.create({ url, active: false });
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      const p = await pagePing(created.id, cfg);
      if (p && p.ok && p.hasInput) return { tabId: created.id, ping: p, created: true };
    }
    return { tabId: created.id, ping: null, created: true, notReady: true };
  })();
  pageTabPromise = job.then(
    (v) => { pageTabPromise = null; return v; },
    (e) => { pageTabPromise = null; throw e; }
  );
  return pageTabPromise;
}

async function callGrokPage(prompt, cfg, action) {
  const t = await ensurePageTab(cfg);
  if (t.notReady) {
    throw new Error('已打开 X 的 Grok 页面，但一直没读到输入框。请确认 Chrome 已登录 x.com、账号可用 Grok；' +
      '若是后台标签被浏览器节流，点设置里的「打开 Grok 页面」激活它再重试。也可改用手动模式。');
  }
  const r = await sendToTab(t.tabId, {
    type: 'GROK_PAGE_BRIDGE', action, prompt, config: cfg, tag: TapeAI.PROMPT_TAG
  });
  if (!r) throw new Error('Grok 页面没有响应（content script 可能失效），请刷新该 X 标签后重试。');
  if (!r.ok) throw new Error(r.error || 'Grok 页面操作失败');
  // 1.3.2：自动发送后必须能证明「提示词发出去了 + 读到了回答」，
  // 否则立刻报错，不再让按行兜底把页面按钮文字当成结果返回给用户。
  if (action === 'auto' && !r.prepared) {
    const why = [];
    if (r.promptSent === false) why.push('页面上没看到本次任务标记，提示词可能没发出去');
    if (r.hasAnswer === false || r.noAnswer === true) why.push('没读到 Grok 的回答块');
    if (r.changed === false) why.push('等待期间 Grok 页面文本没有变化');
    if (why.length) {
      throw new Error('X 站内 Grok 没返回可用结果：' + why.join('；') +
        '。请确认已登录 X、账号可用 Grok，且该标签没被浏览器节流；可点设置里的「打开 Grok 页面」激活后重试，' +
        '或用候选面板的「复制提示词（手动）→ 读取 Grok 回答」。' +
        (r.text ? ' 当前读到：' + String(r.text).slice(0, 120) : ''));
    }
  }
  return Object.assign({ tabId: t.tabId, createdTab: t.created }, r);
}

/* 网页 Grok 会把思考过程 / 用户气泡 / 侧栏按钮一起渲染。
 * 1.3.2：整页 innerText 必须先 cleanPageAnswer 去掉噪声，才允许进入解析；
 * 按行兜底也换成 parsePageAnswer（只认清洗后的回答，不接受 UI 词）。 */
function parsePageText(r, kind) {
  const cleanAll = TapeAI.cleanPageAnswer((r && r.allText) || '');
  const tries = [r && r.text]
    .concat((r && r.candidates) || [])
    .concat([cleanAll])
    .filter((x) => typeof x === 'string' && x.trim());
  for (const t of tries) {
    const hit = TapeAI.extractJsonLoose(t, kind);
    if (!hit) continue;
    const out = kind === 'verdict' ? TapeAI.parseVerdict(hit.text) : TapeAI.parseThreeComments(hit.text);
    const good = kind === 'verdict' ? !!out.parsed : out.length > 0;
    if (good) return { out, strict: true, text: t };
  }
  // 兜底优先只用「回答块」本身（最纯），不够才拼上候选与清洗后的全文，
  // 避免侧栏/提示词把引号列表的后 3 条挤掉。
  const primary = String((r && r.text) || '').trim();
  const raw = primary || tries.join('\n');
  let out = TapeAI.parsePageAnswer(raw, kind);
  const empty = Array.isArray(out) ? !out.length : (!out || out.parsed === false);
  if (empty && primary && tries.length > 1) out = TapeAI.parsePageAnswer(tries.join('\n'), kind);
  return { out, strict: false, text: raw };
}

function pageDiagnostics(r) {
  return {
    mode: r && r.mode,
    promptSent: !!(r && r.promptSent !== false),
    hasAnswer: !!(r && r.hasAnswer !== false && !r.noAnswer),
    stable: (r && r.stable) || null,
    changed: r ? r.changed !== false : null,
    submitBy: (r && r.submitBy) || null,
    answerPreview: String((r && (r.text || r.allText)) || '').slice(0, 160)
  };
}

function messagesFor(kind, payload, cfg) {
  return kind === 'verify'
    ? TapeAI.buildVerifyMessages(payload.url || '', cfg.verifyPrompt)
    : TapeAI.buildCommentMessages(payload.text || '', cfg.commentPrompt);
}

/* 统一的 Grok 调用入口：API 模式 / 页面模式对上层透明 */
async function runGrok(messages, maxTokens, cfg) {
  const c = cfg || await getGrokConfig();
  const mode = TapeAI.pickGrokMode(c);
  if (mode === 'api') {
    const r = await callGrok(messages, maxTokens, c);
    return Object.assign({}, r, { mode: 'api' });
  }
  const prompt = TapeAI.buildPagePrompt(messages, c.pagePromptExtra);
  const r = await callGrokPage(prompt, c, 'auto');
  if (r.prepared) return { prepared: true, mode: 'page', prompt, endpoint: r.url, note: r.note || '' };
  return {
    text: r.text || '',
    allText: r.allText || '',
    candidates: r.candidates || [],
    model: 'x.com Grok（页面模式）',
    protocol: 'page',
    mode: 'page',
    endpoint: r.url,
    submitBy: r.submitBy,
    stable: r.stable,
    changed: r.changed,
    hasAnswer: r.hasAnswer,
    promptSent: r.promptSent,
    noAnswer: r.noAnswer
  };
}

function localOut(local) {
  return {
    status: local.status,
    tier: local.tier || null,
    viaGateway: local.viaGateway || null,
    normalized: local.normalized || null,
    site: local.site || null,
    risks: local.risks || [],
    error: local.error || null
  };
}

async function handleGrokMessage(msg) {
  const payload = msg.payload || {};
  if (typeof TapeAI === 'undefined') throw new Error('grok.js 未加载，请重新加载扩展。');
  const cfg = await getGrokConfig();
  const mode = TapeAI.pickGrokMode(cfg);

  if (msg.type === 'GROK_TEST') {
    const started = Date.now();
    if (mode === 'page') {
      // 页面模式不做真实提问，只验证能不能连上 x.com 里那个 Grok 页面
      const r = await callGrokPage('', cfg, 'ping');
      return {
        ok: true, model: 'x.com Grok（页面模式）', protocol: 'page', mode: 'page',
        latencyMs: Date.now() - started,
        sample: '已连接 ' + (r.url || 'X') + '｜输入框 ' + (r.hasInput ? '✅' : '❌') +
          '｜发送按钮 ' + (r.hasSend ? '✅' : '（输入内容后出现）') +
          (r.createdTab ? '｜本次新开了 Grok 标签' : '｜复用了现有标签')
      };
    }
    const r = await callGrok([
      { role: 'system', content: 'You are a test endpoint. Reply with exactly OK.' },
      { role: 'user', content: 'Reply with exactly: OK' }
    ], 16, cfg);
    return { ok: true, model: r.model, protocol: r.protocol, mode: 'api', latencyMs: Date.now() - started, sample: r.text.slice(0, 60) };
  }

  if (msg.type === 'GROK_COMMENTS') {
    const messages = TapeAI.buildCommentMessages(payload.text || '', cfg.commentPrompt);
    const r = await runGrok(messages, 700, cfg);
    if (r.prepared) {
      return { ok: false, prepared: true, mode: 'page', prompt: r.prompt,
        error: '已把提示词填进 X 的 Grok 输入框（当前设为「不自动发送」）。请到 Grok 里按发送，回答出来后点「读取 Grok 回答」。' };
    }
    const p = r.mode === 'page'
      ? parsePageText(r, 'comments')
      : { out: TapeAI.parseThreeComments(r.text), strict: true, text: r.text };
    const comments = p.out || [];
    if (!comments.length) {
      throw new Error('没从 Grok 的回答里解析出 3 条评论（网页版 Grok 可能没按 JSON 输出，或回答被截断）。' +
        '请点「重新生成」；仍失败就用候选面板的「复制提示词（手动）」到 Grok 里发送，再点「读取 Grok 回答」。' +
        '读到的原文：' + String(p.text || r.text || '').slice(0, 200));
    }
    return {
      ok: true, comments, model: r.model, mode: r.mode, strict: p.strict,
      raw: String(p.text || r.text || '').slice(0, 1200),
      diagnostics: pageDiagnostics(r)
    };
  }

  if (msg.type === 'GROK_VERIFY') {
    // 本地清单结论永远先算出来；即使 Grok 不可用，面板也能给出可靠判定
    const local = TapeAI.matchOfficial(payload.url || '');
    let grok = null;
    let aiError = null;
    try {
      const messages = TapeAI.buildVerifyMessages(payload.url || '', cfg.verifyPrompt);
      const r = await runGrok(messages, 600, cfg);
      if (r.prepared) throw new Error('当前设为「不自动发送」：请到 Grok 里手动发送，再点面板上的「读取 Grok 回答」。');
      const p = r.mode === 'page'
        ? parsePageText(r, 'verdict')
        : { out: TapeAI.parseVerdict(r.text), strict: true };
      grok = p.out;
      if (grok) { grok.model = r.model; grok.strict = p.strict; }
    } catch (e) {
      aiError = String(e && e.message || e);
    }
    return { ok: local.status !== 'invalid', local: localOut(local), grok, aiError, mode, source: TapeAI.SOURCE };
  }

  // 手动兜底：只把完整提示词填进 Grok（并回传给页面去复制），不发送
  if (msg.type === 'GROK_PAGE_PREPARE') {
    const kind = payload.kind === 'verify' ? 'verify' : 'comments';
    const prompt = TapeAI.buildPagePrompt(messagesFor(kind, payload, cfg), cfg.pagePromptExtra);
    const r = await callGrokPage(prompt, cfg, 'prepare');
    return { ok: true, mode: 'page', prompt, page: { url: r.url, hasSend: r.hasSend }, createdTab: r.createdTab };
  }

  // 手动兜底：用户已在 Grok 里发送并等回答出来，这里读回最后一条回答并解析
  if (msg.type === 'GROK_PAGE_READ') {
    const kind = payload.kind === 'verify' ? 'verify' : 'comments';
    const r = await callGrokPage('', cfg, 'read');
    const p = parsePageText(r, kind);
    if (kind === 'verify') {
      const local = TapeAI.matchOfficial(payload.url || '');
      const grok = p.out;
      if (grok) { grok.model = 'x.com Grok（手动读取）'; grok.strict = p.strict; }
      return { ok: local.status !== 'invalid', local: localOut(local), grok, aiError: null,
        mode: 'page', strict: p.strict, raw: String(p.text || '').slice(0, 1200), source: TapeAI.SOURCE };
    }
    return { ok: true, comments: p.out || [], mode: 'page', strict: p.strict,
      raw: String(p.text || '').slice(0, 1200), diagnostics: pageDiagnostics(r) };
  }

  throw new Error('未知的 Grok 消息类型：' + msg.type);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'OFFSCREEN_READY') {
    offscreenReady = true;
    return false;
  }

  // 弹窗「运行环境自检」：把重新加载后最容易出问题的几项一次性报出来
  if (msg.type === 'DIAG') {
    (async () => {
      let chromeVer = '?';
      let version = '?';
      try { const m = /Chrome\/(\d+)/.exec(String(navigator.userAgent || '')); if (m) chromeVer = m[1]; } catch (e) {}
      try { if (chrome.runtime.getManifest) version = chrome.runtime.getManifest().version || '?'; } catch (e) {}
      const out = {
        ok: true,
        version,
        chrome: chromeVer,
        dnrApi: !!(chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateDynamicRules),
        dnrRules: [],
        dnrError: null,
        offscreenApi: !!chrome.offscreen,
        offscreenReady,
        lastError: lastError || null
      };
      try {
        const rules = await chrome.declarativeNetRequest.getDynamicRules();
        out.dnrRules = (rules || []).map(r => r.id);
      } catch (e) {
        out.dnrError = String(e && e.message || e);
        out.ok = false;
      }
      // 自检时顺手重注册一次规则（幂等），修好「重新加载后规则丢失」导致的 403
      try { out.reinstalled = await installRefererRules(); } catch (e) {
        out.reinstalled = false;
        out.dnrError = (out.dnrError || '') + ' / 重注册失败: ' + String(e && e.message || e);
      }
      if (lastError) out.lastError = lastError;
      try { sendResponse(out); } catch (e) {}
    })();
    return true;
  }

  // 来自 content script：单次请求-响应，处理完直接回传结果
  if (msg.type === 'CROSSPOST') {
    const payload = msg.payload || {};
    const text = payload.text || '';
    (async () => {
      try {
        await ensureOffscreen();
        const resp = await chrome.runtime.sendMessage({
          type: 'PROCESS_OFFSCREEN',
          payload
        });
        sendResponse({
          type: 'RESULT',
          results: (resp && resp.results) || [],
          text,
          clipboardOk: !!(resp && resp.clipboardOk),
          clipboardError: (resp && resp.clipboardError) || undefined,
          clipboardText: !!(resp && resp.clipboardText),
          clipboardMedia: (resp && resp.clipboardMedia) || 'none',
          video: (resp && resp.video) || null,
          error: (resp && resp.error) || undefined
        });
      } catch (e) {
        lastError = '转发处理失败: ' + String(e && e.message || e);
        console.warn('[bg] ' + lastError, e);
        sendResponse({
          type: 'RESULT',
          results: [],
          text,
          clipboardOk: false,
          clipboardText: false,
          clipboardMedia: 'none',
          video: null,
          error: '处理失败: ' + String(e && e.message || e)
        });
      }
    })();
    return true; // 保持通道打开，异步 sendResponse
  }

  // 来自 content script：下载处理后的图片（备份）。images 为 base64 字符串数组。
  // 注意：Service Worker 里没有 URL.createObjectURL（blob: URL 不可用），
  // 直接用 data: URL 交给 downloads API，避免兜底下载静默失效。
  if (msg.type === 'DOWNLOAD') {
    const list = msg.images || [];
    // 批次随机后缀：自动下载 + 托盘「全部下载」可能在同一毫秒发生，避免同名覆盖
    const batch = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    list.forEach((b64, i) => {
      try {
        if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return;
        chrome.downloads.download({
          url: 'data:image/png;base64,' + b64,
          filename: `xpost_${batch}_${i + 1}.png`,
          saveAs: false
        }).catch(() => {});
      } catch (e) { /* ignore */ }
    });
    try { sendResponse({ ok: true }); } catch (e) {}
    return true;
  }

  // Grok：AI 评论候选 / 链接真伪查询 / 连接测试。
  // 单次 await + sendResponse，与其它消息一样保持通道打开；失败也一定回包，
  // 避免 content script / 面板那边一直转圈等不到结果。
  if (msg.type === 'GROK_COMMENTS' || msg.type === 'GROK_VERIFY' || msg.type === 'GROK_TEST' ||
      msg.type === 'GROK_PAGE_PREPARE' || msg.type === 'GROK_PAGE_READ') {
    handleGrokMessage(msg).then((out) => {
      lastGrokError = null;
      try { sendResponse(Object.assign({ type: 'GROK_RESULT' }, out)); } catch (e) {}
    }).catch((e) => {
      lastGrokError = String(e && e.message || e);
      console.warn('[bg][grok] ' + lastGrokError);
      try { sendResponse({ type: 'GROK_RESULT', ok: false, error: lastGrokError }); } catch (e2) {}
    });
    return true;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(() => { installRefererRules(); });
chrome.runtime.onStartup.addListener(() => { installRefererRules(); });
installRefererRules();
