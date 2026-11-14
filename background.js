/*
 * background.js — 后台服务 worker
 * 职责：
 *   1. 用 declarativeNetRequest 给各站图床注入对应站点 Referer
 *      （微博→weibo.com、知乎→zhihu.com、公众号→mp.weixin.qq.com、
 *       B站→t.bilibili.com、豆瓣→douban.com、小红书→xiaohongshu.com），
 *      图床强制校验 Referer，否则 403。
 *   2. 管理离屏文档(offscreen)，负责消息路由 requestId → tabId。
 *   3. 把处理后的图片写入下载（作为剪贴板失败时的备份）。
 *   4. 1.4.0：把 Grok 请求路由到当前 X 标签的站内直连通道，失败自动降级页面模式。
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
        justification: '在扩展上下文用 Blob、createImageBitmap 与 OffscreenCanvas 逐张拉取各站点内容图片、用全图瓦片扫描定位任意位置的水印条带并只重建条带内的水印像素，再高保真放大到 4K 后编码 PNG，并把首图写入系统剪贴板'
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
 * 两个 AI 功能共用这一段，支持三种运行模式：
 *   native — 1.4.0 默认：在当前 X 标签里直接调 X 自带 Grok 接口（免 Key、最稳定）
 *   api    — Service Worker 直连 api.x.ai（需 Key，按量计费）
 *   deepseek — 1.5.3：Service Worker 直连 api.deepseek.com（OpenAI 兼容，用户自备 Key）
 *   page   — 把提示词送进用户已登录的 x.com 站内 Grok 页面/浮窗，读回回答（旧链路兜底）
 *   auto   — X 页面里优先 native，失败降级 page；显式填了 Key 则走 api
 * 消息类型：
 *   GROK_COMMENTS      — X 一键评论，按设定提示词生成 3 条回复候选
 *   GROK_VERIFY        — TapeOut 生态面板的链接真伪查询
 *   GROK_TEST          — 设置面板「测试当前模式」
 *   GROK_PAGE_PREPARE  — 手动兜底①：只填提示词，不发送
 *   GROK_PAGE_READ     — 手动兜底②：读回 Grok 页面上已生成的回答
 *
 * 页面模式里扩展自己不向任何 AI 服务发请求，对话完全发生在 X 页面里。
 * 1.4.0 站内直连里，请求由 grok-native.js 以用户已登录的 X 会话发给 X 自有的
 * grok.x.com 接口（接收方只有 X/Grok），后台只回收 3 条评论文本，不接触登录态。
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
  grokTemperature: 0.7,
  // 1.4.11：AI 评论快速模式（默认开）—— 不思考、不并排对比、拿到答案即收尾
  grokFastMode: true
};

/* 1.5.3：DeepSeek 官方 OpenAI 兼容接口（https://api-docs.deepseek.com）。
 * 官方 base_url 是 https://api.deepseek.com（也可填 /v1 或自填兼容网关），
 * 模型为 deepseek-v4-flash / deepseek-v4-pro；旧的 deepseek-chat / deepseek-reasoner
 * 已于 2026-07-24 弃用。这些键与 xAI 的 Key 完全分开存，互不覆盖。 */
const DEEPSEEK_DEFAULTS = {
  deepseekApiKey: '',
  deepseekBaseUrl: 'https://api.deepseek.com',
  deepseekModel: 'deepseek-v4-flash',
  deepseekTemperature: 0.7,
  deepseekJsonMode: true             // 官方模型支持 JSON Output；兼容网关可在设置里关掉
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
    storageGet('local', ['grokApiKey', 'grokBaseUrl', 'grokModel', 'grokProtocol', 'grokTemperature',
      'deepseekApiKey', 'deepseekBaseUrl', 'deepseekModel', 'deepseekTemperature', 'deepseekJsonMode']),
    storageGet('sync', ['commentPrompt', 'verifyPrompt'].concat(PAGE_CFG_KEYS))
  ]);
  const page = {};
  PAGE_CFG_KEYS.forEach((k) => {
    const v = pref[k];
    page[k] = (v == null || v === '') ? TapeAI.PAGE_MODE_DEFAULTS[k] : v;
  });
  /* 1.4.1 双保险：老版本把「X 站内 Grok」存成显式 grokMode="page"，
   * 1.4.0 的 pickGrokMode 遇到非 auto 直接返回，新增的直连链路一次都没走过，
   * 用户一直卡在会报「提示词写入校验失败」的旧 DOM 页面模式上。
   * 只要用户没关掉「优先站内直连」且没填 API Key，就把 page 按 auto 的
   * 免 Key 语义处理（auto 在 X 标签里走直连、其它情况仍回退页面模式）。
   * 这是运行时归一化，不依赖 storage 迁移是否成功，重载后必定生效。 */
  if (String(page.grokMode || '').toLowerCase() === 'page' &&
      page.grokPreferNative !== false && !String(secret.grokApiKey || '').trim()) {
    page.grokMode = 'auto';
  }
  return Object.assign({}, GROK_DEFAULTS, DEEPSEEK_DEFAULTS, page, secret, {
    commentPrompt: pref.commentPrompt || '',
    verifyPrompt: pref.verifyPrompt || '',
    // 1.5.3：只有显式选了 DeepSeek 模式才把供应商切过去；其它模式一律保持 xAI 口径，
    // 这样用户既有的 xAI Key / 网关设置与 1.5.2 的行为完全一致。
    aiProvider: String(page.grokMode || '').toLowerCase() === 'deepseek' ? 'deepseek' : 'xai'
  });
}

function grokEndpoint(cfg) {
  const base = String(cfg.grokBaseUrl || GROK_DEFAULTS.grokBaseUrl).replace(/\/+$/, '');
  return base + (cfg.grokProtocol === 'responses' ? '/responses' : '/chat/completions');
}

/* 1.5.3：DeepSeek 端点。用户可能填官方根地址、/v1，或干脆填完整的
 * /chat/completions，三种写法都归一成同一个可用 URL。 */
function deepseekEndpoint(cfg) {
  const base = String(cfg.deepseekBaseUrl || DEEPSEEK_DEFAULTS.deepseekBaseUrl).trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  return base + '/chat/completions';
}

function deepseekBody(cfg, messages, maxTokens) {
  const model = String(cfg.deepseekModel || DEEPSEEK_DEFAULTS.deepseekModel).trim();
  const temperature = Number(cfg.deepseekTemperature);
  const temp = isFinite(temperature) ? Math.min(1, Math.max(0, temperature)) : 0.7;
  let msgs = messages || [];
  const body = { model, messages: msgs, temperature: temp, max_tokens: maxTokens || 700, stream: false };
  // 两个 AI 功能都要求 JSON；官方模型支持 response_format，兼容网关可关掉
  if (cfg.deepseekJsonMode !== false) {
    body.response_format = { type: 'json_object' };
    /* DeepSeek 官方 JSON Output 要求提示词里出现 "json" 字样，否则可能返回空 content。
     * 默认提示词与 SYSTEM_HINT 都带 JSON，但用户可自定义提示词，所以这里做一次兜底。 */
    const hasJsonWord = msgs.some((m) => /json/i.test(String((m && m.content) || '')));
    if (!hasJsonWord) {
      msgs = [{ role: 'system', content: '请严格用 JSON 格式输出（JSON only）。' }].concat(msgs);
      body.messages = msgs;
    }
  }
  return body;
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

function grokFriendlyError(status, bodyText, isDeepseek) {
  const provider = isDeepseek ? 'DeepSeek' : 'xAI';
  let detail = '';
  try {
    const j = JSON.parse(bodyText);
    detail = (j && (j.error && (j.error.message || j.error) || j.message)) || '';
  } catch (e) { detail = String(bodyText || '').slice(0, 160); }
  detail = String(detail).slice(0, 220);
  if (status === 401 || status === 403) return 'API Key 无效或没有权限（HTTP ' + status + '）。请到设置里重新填写 ' + provider + ' Key。' + (detail ? ' ' + detail : '');
  if (status === 404) return '接口或模型不存在（HTTP 404）。请检查「接口地址 / 模型 ID」，' +
    (isDeepseek ? 'DeepSeek 官方模型是 deepseek-v4-flash / deepseek-v4-pro，默认地址 https://api.deepseek.com。'
                : '当前默认模型是 grok-4.3。');
  if (status === 429) return '调用太频繁或额度不足（HTTP 429）。稍等片刻再试，或到' +
    (isDeepseek ? ' platform.deepseek.com 查看余额。' : ' console.x.ai 查看额度。');
  if (status >= 500) return provider + ' 服务端暂时不可用（HTTP ' + status + '），请稍后重试。';
  return '请求失败（HTTP ' + status + '）' + (detail ? '：' + detail : '');
}

async function callGrok(messages, maxTokens, cfgIn) {
  const cfg = cfgIn || await getGrokConfig();
  /* 1.5.3：同一个函数按 aiProvider 服务两家；选 DeepSeek 时完全不碰 xAI 的
   * Key / 模型 / 网关，也不降级到 X 页面，错误直接指向 DeepSeek 设置。 */
  const ds = cfg.aiProvider === 'deepseek';
  const providerName = ds ? 'DeepSeek' : 'xAI';
  const key = String((ds ? cfg.deepseekApiKey : cfg.grokApiKey) || '').trim();
  if (!key) throw new Error('还没有填 ' + providerName + ' API Key。请点插件图标 →「AI 设置」填入 Key（只存在本机，不会上传）。');
  if (typeof TapeAI === 'undefined') throw new Error('共享逻辑未加载，请在 chrome://extensions 重新加载扩展。');

  const endpoint = ds ? deepseekEndpoint(cfg) : grokEndpoint(cfg);
  const protocol = ds ? 'chat' : cfg.grokProtocol;
  const body = ds ? deepseekBody(cfg, messages, maxTokens) : grokBody(cfg, messages, maxTokens);
  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new Error('无法连接 ' + endpoint + '（' + String(e && e.message || e) + '）。' +
      (ds ? '请检查接口地址与网络；DeepSeek 官方地址是 https://api.deepseek.com。'
          : '国内网络通常需要代理；也可以在设置里换用兼容网关地址。'));
  }
  const raw = await resp.text();
  if (!resp.ok) throw new Error(grokFriendlyError(resp.status, raw, ds));
  let data;
  try { data = JSON.parse(raw); } catch (e) { throw new Error('接口返回的不是 JSON：' + raw.slice(0, 120)); }
  const text = grokText(data, protocol);
  if (!text) throw new Error(ds
    ? 'DeepSeek 返回了空内容。可关掉「强制 JSON 输出」，或换一个模型 ID 后重试。'
    : '接口返回了空内容，请把「接口协议」切换成另一项后重试。');
  return {
    text,
    model: ds ? String(cfg.deepseekModel || DEEPSEEK_DEFAULTS.deepseekModel) : cfg.grokModel,
    protocol, endpoint
  };
}

// ---- 3b. 非 API 模式：把提示词送进 x.com 站内 Grok，再读回回答文本 ----
/*
 * 扩展自己不向 xAI 发任何请求；对话完全发生在用户已登录的 X 页面里。
 * 优先复用「已经有 Grok 输入框」的标签（含时间线上的 Grok 浮窗），
 * 没有才在后台新建 x.com/i/grok 标签，避免打断用户当前操作。
 */
let pageTabPromise = null;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* 1.3.3：扩展在 chrome://extensions 里「重新加载」后，之前已打开的 X 标签
 * 里留的是旧实例的 content script（孤儿上下文）。后台再给它发消息，Chrome 会报
 * "Could not establish connection. Receiving end does not exist."。
 * 这里把这类错误单独打标记，交给上层自动刷新 / 新建标签恢复；
 * 也绝不把 Chrome 的英文原始错误原样抛到用户面前。 */
const TAB_UNREACHABLE_RE = /Could not establish connection|Receiving end does not exist|Extension context invalidated|message port closed/i;
const TAB_HINT = 'X 标签里的插件脚本没响应（通常是刚重新加载过扩展，旧标签还留着失效的脚本）。';

function tabError(raw, tabId) {
  const text = String(raw || '');
  const bad = TAB_UNREACHABLE_RE.test(text);
  const e = new Error(bad
    ? TAB_HINT + '插件已自动尝试刷新 / 新建标签；若仍失败，请刷新所有 X 页面（Cmd+R），或关闭旧的 Grok 对话标签后重试。（原始错误：' + text + '）'
    : text);
  e.tabUnreachable = bad;
  e.tabId = tabId;
  return e;
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (r) => {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) return reject(tabError(String(err.message || err), tabId));
        resolve(r);
      });
    } catch (e) { reject(tabError(String(e && e.message || e), tabId)); }
  });
}

async function pagePing(tabId, cfg) {
  try { return await sendToTab(tabId, { type: 'GROK_PAGE_BRIDGE', action: 'ping', config: cfg }); }
  catch (e) { return null; }
}

/* 刷新标签是修复「扩展重载后孤儿 content script」的唯一可靠手段：
 * 新页面会重新注入当前实例的 grok-page.js / content.js。 */
async function reloadTab(tabId) {
  try { await chrome.tabs.reload(tabId); return true; }
  catch (e) { return false; }
}

let pageCreatedTabs = [];   // 扩展自己新建的 Grok 标签，供「重建连接」时识别

async function ensurePageTab(cfg, forceFresh) {
  if (pageTabPromise && !forceFresh) return pageTabPromise;
  const job = (async () => {
    let tabs = [];
    try {
      tabs = (await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] })) || [];
    } catch (e) { /* 没有 tabs 权限时可能拿不到，直接走新建分支 */ }

    if (!forceFresh) {
      // 1) 已经能对话的标签：时间线浮窗 / 用户自己开着的 Grok 页
      for (const t of tabs) {
        const p = await pagePing(t.id, cfg);
        if (p && p.ok && p.hasInput) return { tabId: t.id, ping: p, created: false };
      }
      // 2) 已打开的 /i/grok：扩展重载后这里的脚本是旧实例的孤儿 → 主动刷新一次
      const grok = tabs.find((t) => /\/i\/grok(?:\/|\?|$)/.test(String(t.url || t.pendingUrl || '')));
      if (grok) {
        let p = await pagePing(grok.id, cfg);
        if (p && p.ok && p.hasInput) return { tabId: grok.id, ping: p, created: false };
        await reloadTab(grok.id);
        for (let i = 0; i < 16; i++) {
          await sleep(500);
          p = await pagePing(grok.id, cfg);
          if (p && p.ok && p.hasInput) return { tabId: grok.id, ping: p, created: false, healed: true };
        }
        // 1.3.3 关键修复：刷新后仍然不通，绝不再把这个坏标签交给 callGrokPage
        // （1.3.2 就是在这里把失效标签返回，才冒出 "Receiving end does not exist"）。
        // 直接走第 3 步新建标签 —— 新标签必定注入当前实例的 content script。
      }
    }

    // 3) 后台新开一个 Grok 页面（active:false，不抢焦点）
    let url = String(cfg.grokPageUrl || 'https://x.com/i/grok').trim();
    if (!/^https:\/\/(?:x\.com|twitter\.com)\//i.test(url)) url = 'https://x.com/i/grok'; // 只允许 X 站内
    const created = await chrome.tabs.create({ url, active: false });
    if (pageCreatedTabs.indexOf(created.id) === -1) pageCreatedTabs.push(created.id);
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      const p = await pagePing(created.id, cfg);
      if (p && p.ok && p.hasInput) return { tabId: created.id, ping: p, created: true };
    }
    return { tabId: created.id, ping: null, created: true, notReady: true, staleTabs: tabs.length };
  })();
  pageTabPromise = job.then(
    (v) => { pageTabPromise = null; return v; },
    (e) => { pageTabPromise = null; throw e; }
  );
  return pageTabPromise;
}

async function callGrokPage(prompt, cfg, action) {
  let t = await ensurePageTab(cfg);
  if (t.notReady) {
    throw new Error('已打开 / 新建了 X 的 Grok 页面，但一直没读到输入框。请确认 Chrome 已登录 x.com、账号可用 Grok；' +
      '刚重新加载过扩展的话，请刷新所有 X 页面；若是后台标签被浏览器节流，点设置里的「重建 Grok 标签」激活它再重试。也可改用手动模式。');
  }
  const message = { type: 'GROK_PAGE_BRIDGE', action, prompt, config: cfg, tag: TapeAI.PROMPT_TAG };
  let r;
  try {
    r = await sendToTab(t.tabId, message);
  } catch (e) {
    if (!e.tabUnreachable) throw e;
    // 标签脚本在 ensurePageTab 之后才失效（例如用户刚好刷新/关闭了它）：
    // 先刷新同一个标签等新脚本注入，救不回来再强制新建标签重试一次。
    console.warn('[bg][grok] 标签脚本失效，尝试刷新恢复：' + t.tabId);
    await reloadTab(t.tabId);
    let healed = false;
    for (let i = 0; i < 16; i++) {
      await sleep(400);
      const p = await pagePing(t.tabId, cfg);
      if (p && p.ok && p.hasInput) { healed = true; break; }
    }
    if (healed) {
      r = await sendToTab(t.tabId, message);
    } else {
      pageTabPromise = null;
      t = await ensurePageTab(cfg, true);
      if (t.notReady) throw e;
      r = await sendToTab(t.tabId, message);
    }
  }
  if (!r) throw new Error('Grok 页面没有响应（content script 可能失效），请刷新该 X 标签，或点设置里的「重建 Grok 标签」后重试。');
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
  return Object.assign({ tabId: t.tabId, createdTab: t.created, healed: !!t.healed }, r);
}

/* ------------------------------------------------------------------
 * 1.4.0 站内直连（native）
 * 与 X 网页客户端一样，直接向 X 自带的 Grok 流式接口发请求。请求发生在
 * 用户当前这个 X 标签里（MAIN world 脚本 grok-native.js），后台只负责
 * 转发提示词和回收 3 条评论文本，不开标签、不碰 DOM、不等页面文本稳定。
 * 找不到可用标签 / 脚本未注入时返回 null，由上层安静降级到页面模式。
 * ------------------------------------------------------------------ */
function isXTabUrl(url) {
  return /^https:\/\/(?:[a-z0-9-]+\.)?(?:x|twitter)\.com\//i.test(String(url || ''));
}

async function findXTabId(preferredId) {
  if (preferredId != null) {
    try {
      // 消息本来就来自这个标签，没有 tabs 权限时 url 可能读不到，别因此丢掉它
      const t = await chrome.tabs.get(preferredId);
      if (t) return t.id;
    } catch (e) { /* 标签可能已关闭 */ }
  }
  try {
    const tabs = (await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] })) || [];
    const active = tabs.find((t) => t.active) || tabs[0];
    if (active) return active.id;
  } catch (e) { /* 没有 tabs 权限时跳过 */ }
  return null;
}

async function nativeTab(preferredId) {
  const tabId = await findXTabId(preferredId);
  if (tabId == null) return null;
  try {
    const p = await sendToTab(tabId, { type: 'GROK_NATIVE_PING' });
    if (p && p.ok) return tabId;
  } catch (e) { /* 旧标签的孤儿脚本会直接失联 */ }
  return null;
}

async function callGrokNative(preferredId, message) {
  const tabId = await nativeTab(preferredId);
  if (tabId == null) return null;
  const r = await sendToTab(tabId, message);
  if (!r) throw new Error('X 站内 Grok 没有响应，请刷新该 X 标签后重试。');
  if (!r.ok) throw new Error(r.error || 'X 站内 Grok 调用失败');
  return Object.assign({ tabId }, r);
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
async function runGrok(messages, maxTokens, cfg, kind, postText) {
  const c = cfg || await getGrokConfig();
  const mode = TapeAI.pickGrokMode(c);
  // 1.5.3：deepseek 与 api 共用同一段「后台直连 → 文本 → 本机解析」链路
  if (mode === 'api' || mode === 'deepseek') {
    const r = await callGrok(messages, maxTokens, c);
    return Object.assign({}, r, { mode });
  }
  // 1.4.18：页面模式的 AI 评论也改用无角色/无矛盾指令的提示词（保留任务标记与 JSON 输出）
  const prompt = (kind === 'comments' && postText !== undefined)
    ? TapeAI.buildPageCommentPrompt(postText, c.commentPrompt, c.pagePromptExtra)
    : TapeAI.buildPagePrompt(messages, c.pagePromptExtra);
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

async function handleGrokMessage(msg, sender) {
  const payload = msg.payload || {};
  if (typeof TapeAI === 'undefined') throw new Error('grok.js 未加载，请重新加载扩展。');
  const cfg = await getGrokConfig();
  // 1.4.0：消息来自已打开的 X 标签时，auto 优先走站内直连（无需外挂 Grok 标签）。
  // 只有 X 页面会发 GROK_COMMENTS / GROK_VERIFY，所以 URL 因权限读不到时仍按 X 标签处理。
  const senderUrl = (sender && (sender.url || (sender.tab && (sender.tab.url || sender.tab.pendingUrl)))) || '';
  const fromXTab = !!(sender && sender.tab && sender.tab.id != null &&
    (isXTabUrl(senderUrl) || !senderUrl));
  const tabId = sender && sender.tab ? sender.tab.id : null;
  const mode = TapeAI.pickGrokMode(cfg, { inXTab: fromXTab });
  const forceNative = String(cfg.grokMode || '').toLowerCase() === 'native';
  let actualMode = mode;

  // 1.3.3：一键修复「重新加载扩展后旧 X 标签脚本失效」。
  // 只刷新已打开的 /i/grok 页面（不关闭用户标签），再强制新开一个干净标签。
  if (msg.type === 'GROK_PAGE_RESET') {
    if (mode === 'native') {
      const t = await nativeTab(tabId);
      return {
        ok: t != null, mode: 'native', reloaded: 0,
        note: t != null
          ? '站内直连通道正常：当前 X 标签已就绪，不需要重建 Grok 标签。'
          : '没检测到可用的站内直连脚本。请在 chrome://extensions 重新加载扩展后刷新 X 页面；升级 MAIN world 脚本只刷新页面不够。'
      };
    }
    let tabs = [];
    try { tabs = (await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] })) || []; }
    catch (e) { /* 无 tabs 权限时跳过刷新，直接走新建分支 */ }
    const grokTabs = tabs.filter((t) => /\/i\/grok(?:\/|\?|$)/.test(String(t.url || t.pendingUrl || '')));
    for (const t of grokTabs) await reloadTab(t.id);
    pageTabPromise = null;
    if (mode === 'api' || mode === 'deepseek') {
      return { ok: true, mode, reloaded: grokTabs.length,
        note: '当前是 ' + (mode === 'deepseek' ? 'DeepSeek' : 'xAI') +
          ' API 模式，用不到 X 站内 Grok 标签；已刷新旧的 Grok 页面。' };
    }
    const r = await callGrokPage('', cfg, 'ping');
    return {
      ok: true, mode: 'page', reloaded: grokTabs.length,
      url: r.url || '', hasInput: !!r.hasInput, createdTab: !!r.createdTab,
      note: '已刷新 ' + grokTabs.length + ' 个旧 Grok 标签，并' +
        (r.createdTab ? '新开' : '复用') + '一个可用标签。'
    };
  }

  if (msg.type === 'GROK_TEST') {
    const started = Date.now();
    // auto + 默认优先直连时，自检也要验证直连通道（弹窗没有 sender.tab，会去找已开的 X 标签）
    const wantNative = mode === 'native' ||
      (String(cfg.grokMode || 'auto').toLowerCase() === 'auto' &&
        cfg.grokPreferNative !== false && !String(cfg.grokApiKey || '').trim());
    let effectiveMode = mode;   // mode 已由 pickGrokMode 解析成 native / page / api
    if (wantNative) {
      // 检测但不发起真实提问：确认 X 会话 + 站内签名可用
      let r = null;
      try { r = await callGrokNative(tabId, { type: 'GROK_NATIVE_CHECK' }); } catch (e) {
        if (forceNative) throw new Error('站内直连自检失败：' + String(e && e.message || e));
      }
      if (r && r.ok) {
        return {
          ok: true, model: 'X 站内 Grok（直连）', protocol: 'native', mode: 'native',
          latencyMs: Date.now() - started,
          sample: (r.check && r.check.note) || '站内直连通道已就绪（会话与签名均可用）'
        };
      }
      if (!forceNative) effectiveMode = String(cfg.grokApiKey || '').trim() ? 'api' : 'page';
      else throw new Error('站内直连脚本没有响应：请在 chrome://extensions 重新加载扩展后刷新 X 页面；升级 MAIN world 脚本只刷新页面不够。');
    }
    if (effectiveMode === 'page') {
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
    return { ok: true, model: r.model, protocol: r.protocol, mode: effectiveMode,
      latencyMs: Date.now() - started, sample: r.text.slice(0, 60) };
  }

  if (msg.type === 'GROK_COMMENTS') {
    const messages = TapeAI.buildCommentMessages(payload.text || '', cfg.commentPrompt);
    let nativeFailure = null;

    // 1.4.0 主路径：直接调 X 自带 Grok 接口，不依赖 /i/grok 标签与 DOM 文本读取
    if (mode === 'native') {
      try {
        // 1.4.18：站内直连改用 XVM 式极简提示词（推文原文 + 一句自然语言要求），
        // 不再叠加角色扮演 / system / 自相矛盾的 JSON+代码块双重约束，
        // 否则 X 自带 Grok persona 会回 "I can't follow that format or role"。
        const prompt = TapeAI.buildNativeCommentPrompt(payload.text || '', cfg.commentPrompt, cfg.pagePromptExtra);
        const fast = cfg.grokFastMode !== false;
        const r = await callGrokNative(tabId, {
          type: 'GROK_NATIVE_CALL', prompt, kind: 'comments',
          fast: fast, timeoutMs: fast ? 40000 : 90000
        });
        if (r && r.comments && r.comments.length) {
          return {
            ok: true, comments: r.comments, model: 'X 站内 Grok（直连）', mode: 'native', strict: true,
            raw: String(r.raw || '').slice(0, 1200),
            diagnostics: {
              transport: '站内直连 · X 自带 Grok 接口',
              signature: r.via || '',
              endpoint: 'grok.x.com/2/grok/add_response.json',
              tabId: r.tabId || null
            }
          };
        }
        if (r) nativeFailure = '直连已返回但没解析出候选';
      } catch (e) {
        nativeFailure = String(e && e.message || e);
        if (forceNative) {
          var parseIssueForced = /思考|没解析|没返回可用评论|被截断|最终回答帧|回答帧/.test(nativeFailure);
          var refusedForced = /拒绝了提示词里的角色|不接受注入式指令|can't follow that format/i.test(nativeFailure);
          throw new Error('站内直连 Grok 生成失败：' + nativeFailure +
            (refusedForced
              ? '。这是提示词被 X 站内 Grok 拒答，1.4.18 已改为极简模板；请在 chrome://extensions 重新加载扩展后再试，也可用「复制提示词（手动）→ 读取 Grok 回答」兜底。'
              : parseIssueForced
                ? '。请再点一次「AI 评论」，或到 Grok 设置关掉「AI 快速模式」重试；也可用「复制提示词（手动）→ 读取 Grok 回答」兜底。'
                : '。请刷新 X 页面后重试；也可到 x.com/i/grok 发一条消息让扩展捕获有效签名，' +
                  '或点插件图标 → Grok 设置 → 「测试当前模式」看诊断。'));
        }
        console.warn('[bg][grok] 站内直连失败，降级页面模式：' + nativeFailure);
      }
      actualMode = 'page';
    }

    let r;
    try { r = await runGrok(messages, 700, cfg, 'comments', payload.text || ''); }
    catch (e) {
      if (nativeFailure) {
        // 1.4.1：把直连的真实失败原因放在最前面，避免被页面模式的
        // 「提示词写入校验失败」盖住。1.4.14：不再建议切回已弃用的页面模式。
        // 1.4.15：失败分两类——签名/认证类才需要刷新页面找签名；
        // 回答解析类（思考布局、final 帧没到）刷新页面没用，给可操作的重试建议。
        var parseIssue = /思考|没解析|没返回可用评论|被截断|最终回答帧|回答帧/.test(nativeFailure);
        // 1.4.18：Grok 明确拒绝角色/格式时，重试与切快速模式都无用，要提示重载扩展
        var refusedIssue = /拒绝了提示词里的角色|不接受注入式指令|can't follow that format/i.test(nativeFailure);
        throw new Error('站内直连失败：' + nativeFailure.slice(0, 420) +
          (refusedIssue
            ? '。这是提示词被 X 站内 Grok 拒答（非签名问题），1.4.18 已改为 XVM 式极简模板；请在 chrome://extensions 重新加载扩展后再点一次「AI 评论」；临时可用「复制提示词（手动）→ 读取 Grok 回答」兜底。'
            : parseIssue
              ? '。这是回答解析阶段的问题，签名通常正常；请再点一次「AI 评论」，或到 Grok 设置关掉「AI 快速模式」重试；临时可用「复制提示词（手动）→ 读取 Grok 回答」兜底。'
              : '。签名不可用时请刷新 X 页面后重试；也可到 x.com/i/grok 发一条消息让扩展捕获有效签名，' +
                '或点插件图标 → Grok 设置 → 「测试当前模式」看诊断；临时可用「复制提示词（手动）→ 读取 Grok 回答」兜底。'));
      }
      throw e;
    }
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
        (nativeFailure ? '（站内直连失败原因：' + nativeFailure.slice(0, 180) + '）' : '') +
        '读到的原文：' + String(p.text || r.text || '').slice(0, 200));
    }
    return {
      ok: true, comments, model: r.model, mode: r.mode, strict: p.strict,
      raw: String(p.text || r.text || '').slice(0, 1200),
      diagnostics: Object.assign(pageDiagnostics(r),
        nativeFailure ? { nativeFallback: nativeFailure } : {})
    };
  }

  if (msg.type === 'GROK_VERIFY') {
    // 本地清单结论永远先算出来；即使 Grok 不可用，面板也能给出可靠判定
    const local = TapeAI.matchOfficial(payload.url || '');
    let grok = null;
    let aiError = null;
    try {
      const messages = TapeAI.buildVerifyMessages(payload.url || '', cfg.verifyPrompt);
      if (mode === 'native') {
        try {
          const prompt = TapeAI.buildNativePrompt(messages, 'verify', cfg.pagePromptExtra);
          const nr = await callGrokNative(tabId, {
            type: 'GROK_NATIVE_CALL', prompt, kind: 'verify', timeoutMs: 90000
          });
          if (nr) {
            const v = TapeAI.parseVerdict(nr.raw || (nr.comments || []).join('\n'));
            if (v) { grok = v; grok.model = 'X 站内 Grok（直连）'; grok.strict = true; }
          }
        } catch (e) { aiError = String(e && e.message || e); }
        if (!grok) actualMode = 'page';
      }
      if (!grok) {
        const r = await runGrok(messages, 600, cfg, 'verify');
        if (r.prepared) throw new Error('当前设为「不自动发送」：请到 Grok 里手动发送，再点面板上的「读取 Grok 回答」。');
        const p = r.mode === 'page'
          ? parsePageText(r, 'verdict')
          : { out: TapeAI.parseVerdict(r.text), strict: true };
        grok = p.out;
        if (grok) { grok.model = r.model; grok.strict = p.strict; aiError = null; }
      }
    } catch (e) {
      aiError = String(e && e.message || e);
    }
    return { ok: local.status !== 'invalid', local: localOut(local), grok, aiError, mode: actualMode, source: TapeAI.SOURCE };
  }

  // 手动兜底：只把完整提示词填进 Grok（并回传给页面去复制），不发送
  if (msg.type === 'GROK_PAGE_PREPARE') {
    const kind = payload.kind === 'verify' ? 'verify' : 'comments';
    const prompt = kind === 'comments'
      ? TapeAI.buildPageCommentPrompt(payload.text || '', cfg.commentPrompt, cfg.pagePromptExtra)
      : TapeAI.buildPagePrompt(messagesFor(kind, payload, cfg), cfg.pagePromptExtra);
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


// ---- 1.4.3：临时文件管理（尽量不在本机留下文件） ----
/*
 * 图片默认走剪贴板、不再自动下载；视频只能拖入 X，必须落盘。
 * 所有必要的下载统一放进下载目录的 TapePost_tmp/ 子目录，记录 downloadId + 时间戳，
 * 超过保留时长后 erase（磁盘文件与下载历史一起删）。
 * 不新增任何权限：沿用已有的 downloads / storage；清理由「扩展启动 / 新下载 /
 * 打开设置 / 用户点清理」这些事件顺带触发，Service Worker 被挂起也不会漏掉。
 */
const TMP_DIR = 'TapePost_tmp';
const TMP_KEY = 'tapeTmpDownloads';
const CLEANUP_DEFAULTS = { tmpCleanup: true, tmpKeepMinutes: 30 };

async function getCleanupCfg() {
  try {
    const s = await chrome.storage.sync.get(CLEANUP_DEFAULTS);
    const n = Number(s && s.tmpKeepMinutes);
    return { enabled: !s || s.tmpCleanup !== false, minutes: Number.isFinite(n) ? Math.max(0, n) : 30 };
  } catch (e) { return { enabled: true, minutes: 30 }; }
}

async function readTmpList() {
  try {
    const o = await chrome.storage.local.get(TMP_KEY);
    return Array.isArray(o && o[TMP_KEY]) ? o[TMP_KEY] : [];
  } catch (e) { return []; }
}

async function writeTmpList(list) {
  try { await chrome.storage.local.set({ [TMP_KEY]: list.slice(-200) }); } catch (e) {}
}

async function trackTmp(id, name) {
  if (id == null) return;
  try {
    const list = await readTmpList();
    if (list.some((r) => r.id === id)) return;
    list.push({ id: id, ts: Date.now(), name: String(name || '').split('/').pop() });
    await writeTmpList(list);
  } catch (e) {}
}

async function eraseTmpDownload(id) {
  // erase() 同时删除磁盘文件与下载历史；老版本 Chrome 回退 removeFile()
  try {
    if (chrome.downloads && chrome.downloads.erase) {
      await chrome.downloads.erase({ id: id });
      return true;
    }
  } catch (e) {}
  try {
    if (chrome.downloads && chrome.downloads.removeFile) {
      await chrome.downloads.removeFile(id);
      return true;
    }
  } catch (e) {}
  return false;
}

async function purgeTmp(force) {
  const cfg = await getCleanupCfg();
  const list = await readTmpList();
  if (!list.length) return { removed: 0, remaining: 0 };
  const now = Date.now();
  const keep = [];
  let removed = 0;
  for (const rec of list) {
    const age = now - (rec.ts || 0);
    const expired = !!force || (cfg.enabled && cfg.minutes > 0 && age >= cfg.minutes * 60000);
    if (!expired) { keep.push(rec); continue; }
    const ok = await eraseTmpDownload(rec.id);
    if (ok) removed++;
    // 文件已被用户手动删掉 / 记录失效时，不无限期重试（24 小时后丢弃记录）
    else if (!force && age < 24 * 3600 * 1000) keep.push(rec);
  }
  await writeTmpList(keep);
  return { removed: removed, remaining: keep.length };
}

// offscreen 里直接调 chrome.downloads.download（视频）时，用它兜底记录
if (chrome.downloads && chrome.downloads.onCreated) {
  chrome.downloads.onCreated.addListener((item) => {
    if (!item || !item.filename) return;
    const name = String(item.filename || '');
    const base = name.split('/').pop();
    // 主路径带 TapePost_tmp/ 前缀；<a download> 兜底只有 xpost_ 文件名
    if (name.indexOf(TMP_DIR) === -1 && !/^xpost_/.test(base)) return;
    trackTmp(item.id, name).catch(() => {});
  });
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

  /* 1.5.2 视频工作台：离屏文档把进度广播到 background，这里再转发给来源标签页。
   * 转发用 VIDEO_PROGRESS_UI 而不是原名，避免 background 自己的监听器
   * 再次收到同一条消息形成回环。两条路都发：tabs.sendMessage 最可靠，
   * runtime 广播作兜底；content 按 requestId + phase + percent 去重。 */
  if (msg.type === 'VIDEO_PROGRESS') {
    const out = {
      type: 'VIDEO_PROGRESS_UI',
      requestId: msg.requestId || '',
      phase: msg.phase || '',
      percent: Number(msg.percent) || 0,
      note: msg.note || ''
    };
    const swallow = () => { try { void chrome.runtime.lastError; } catch (e) {} };
    try { chrome.runtime.sendMessage(out, swallow); } catch (e) {}
    if (msg.tabId && chrome.tabs && chrome.tabs.sendMessage) {
      try { chrome.tabs.sendMessage(msg.tabId, out, swallow); } catch (e) {}
    }
    return false;
  }

  // 1.5.2：解析视频地址 / 下载原片 / 剪接 + 逐帧去水印导出
  if (msg.type === 'VIDEO_RESOLVE' || msg.type === 'VIDEO_ORIGIN' || msg.type === 'VIDEO_EDIT') {
    const payload = Object.assign({}, msg.payload || {}, {
      tabId: (sender && sender.tab && sender.tab.id) || null
    });
    const offType = msg.type === 'VIDEO_RESOLVE' ? 'VIDEO_RESOLVE_OFFSCREEN'
      : (msg.type === 'VIDEO_ORIGIN' ? 'VIDEO_ORIGIN_OFFSCREEN' : 'PROCESS_VIDEO_OFFSCREEN');
    (async () => {
      try {
        await ensureOffscreen();
        const resp = await chrome.runtime.sendMessage({ type: offType, payload });
        try { sendResponse(resp || { ok: false, error: '离屏文档无响应' }); } catch (e) {}
      } catch (e) {
        try { sendResponse({ ok: false, error: String(e && e.message || e) }); } catch (e2) {}
      }
    })();
    return true;
  }

  // 来自 content script：下载处理后的图片（可选备份 / 托盘手动下载）。
  // 注意：Service Worker 里没有 URL.createObjectURL（blob: URL 不可用），
  // 直接用 data: URL 交给 downloads API，避免下载静默失效。
  // 1.4.3：统一放进 TapePost_tmp/ 子目录并登记，便于按保留时长自动清理。
  if (msg.type === 'DOWNLOAD') {
    const list = msg.images || [];
    // 批次随机后缀：自动下载 + 托盘「下载到临时目录」可能在同一毫秒发生，避免同名覆盖
    const batch = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    (async () => {
      purgeTmp(false).catch(() => {});   // 每次新下载顺带清过期文件，不阻塞本次下载
      for (let i = 0; i < list.length; i++) {
        const b64 = list[i];
        try {
          if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) continue;
          const filename = `${TMP_DIR}/xpost_${batch}_${i + 1}.png`;
          const id = await chrome.downloads.download({
            url: 'data:image/png;base64,' + b64,
            filename: filename,
            saveAs: false
          });
          await trackTmp(id, filename);
        } catch (e) { /* ignore */ }
      }
    })();
    try { sendResponse({ ok: true }); } catch (e) {}
    return true;
  }

  // 1.4.3：离屏文档下载视频后主动登记（此时 downloadId 与文件名都已确定）
  if (msg.type === 'TMP_TRACK') {
    trackTmp(msg.id, msg.filename).catch(() => {});
    try { sendResponse({ ok: true }); } catch (e) {}
    return true;
  }

  // 1.4.3：设置面板「立即清理临时文件」/ 剩余文件数查询
  if (msg.type === 'TMP_CLEAN' || msg.type === 'TMP_STATUS') {
    (async () => {
      try {
        const out = (msg.type === 'TMP_CLEAN')
          ? await purgeTmp(true)
          : { removed: 0, remaining: (await readTmpList()).length };
        try { sendResponse(Object.assign({ ok: true }, out)); } catch (e) {}
      } catch (e) {
        try { sendResponse({ ok: false, error: String(e && e.message || e), removed: 0, remaining: 0 }); } catch (e2) {}
      }
    })();
    return true;
  }

  // Grok：AI 评论候选 / 链接真伪查询 / 连接测试。
  // 单次 await + sendResponse，与其它消息一样保持通道打开；失败也一定回包，
  // 避免 content script / 面板那边一直转圈等不到结果。
  if (msg.type === 'GROK_COMMENTS' || msg.type === 'GROK_VERIFY' || msg.type === 'GROK_TEST' ||
      msg.type === 'GROK_PAGE_PREPARE' || msg.type === 'GROK_PAGE_READ' || msg.type === 'GROK_PAGE_RESET') {
    handleGrokMessage(msg, sender).then((out) => {
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

chrome.runtime.onInstalled.addListener(() => { installRefererRules(); purgeTmp(false).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { installRefererRules(); purgeTmp(false).catch(() => {}); });
installRefererRules();
purgeTmp(false).catch(() => {});   // Service Worker 每次唤醒也顺带清一次过期临时文件

/* =====================================================================
 * 1.4.13：TapeOut 行情卡片 + 价格上下限提醒
 *
 *  · 定时（chrome.alarms）抓 BEM（analytics）与矿机日产价（1.4.20 起改 /v1/circuit-holders，
 *    即 /circuits/other 页顶实时挂单参考价）；TapeUP $UP 内盘价不走后台 fetch
 *    （tapeup.io 整站 Cloudflare 防护），由内容脚本采集后缓存；
 *  · 价格越过设定的上/下限时，发系统通知 + 给所有标签页广播右下角浮层；
 *  · 通知点击直接打开 Firsto 交易所对应数据页；
 *  · 只有「从区间内跨到区间外」提醒一次，不会每分钟重复轰炸（见 price.js）。
 * 所有新 API 都做存在性判断：老版本 Chrome / 测试沙箱缺 API 时静默跳过，
 * 不影响原有的转发与 Grok 链路。
 * ===================================================================== */
(function () {
  'use strict';
  try {
    if (typeof TapePrice === 'undefined' && typeof importScripts === 'function') importScripts('price.js');
  } catch (e) { /* 独立测试环境没有 importScripts */ }
  if (typeof TapePrice === 'undefined') return;

  var SNAP_KEY = 'tapePriceSnapshot';      // storage.local：最近一次行情
  var STATE_KEY = 'tapePriceAlertState';    // storage.local：上下限状态机
  var SET_KEY = 'priceSettings';            // storage.sync：用户设置
  var LINK_KEY = 'tapePriceNotifLinks';     // storage.local：通知 id → 交易所链接
  var ALARM = 'tapePricePoll';
  var busy = null;

  function syncGet(key) {
    return new Promise(function (resolve) {
      try { chrome.storage.sync.get(key, function (o) { resolve(o && o[key] != null ? o[key] : null); }); }
      catch (e) { resolve(null); }
    });
  }
  function localGet(key, fallback) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get(key, function (o) { resolve(o && o[key] != null ? o[key] : fallback); }); }
      catch (e) { resolve(fallback); }
    });
  }
  function localSet(obj) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.set(obj, function () { resolve(true); }); }
      catch (e) { resolve(false); }
    });
  }
  function readSettings() { return syncGet(SET_KEY).then(function (v) { return TapePrice.normalizeSettings(v); }); }

  function refresh() {
    if (busy) return busy;   // 弹窗刷新 + alarm 同时到时只发一轮请求
    busy = (async function () {
      var prev = await localGet(SNAP_KEY, null);
      // TapeUP 内盘价由内容脚本在 tapeup.io 页面里采集后缓存到这里
      var upCache = await localGet('tapeupPriceCache', null);
      var snap = await TapePrice.fetchSnapshot(fetch, prev, upCache);
      var out = {}; out[SNAP_KEY] = snap;
      await localSet(out);
      var cfg = await readSettings();
      var state = await localGet(STATE_KEY, {});
      var ev = TapePrice.evaluateAlerts(snap, cfg, state, Date.now());
      var st = {}; st[STATE_KEY] = ev.state;
      await localSet(st);
      if (ev.alerts.length) await fire(ev.alerts, cfg);
      return snap;
    })().catch(function (e) {
      console.warn('[bg][price] 刷新失败: ' + String(e && e.message || e));
      return null;
    }).then(function (v) { busy = null; return v; });
    return busy;
  }

  async function fire(alerts, cfg) {
    for (var i = 0; i < alerts.length; i++) {
      var a = alerts[i];
      var id = 'tapeprice-' + Date.now() + '-' + i + '-' + a.key;
      var links = await localGet(LINK_KEY, {});
      links[id] = TapePrice.safeLink(a.url);
      var lm = {}; lm[LINK_KEY] = links;
      await localSet(lm);
      if (cfg.notify !== false && chrome.notifications && chrome.notifications.create) {
        try {
          chrome.notifications.create(id, {
            type: 'basic', iconUrl: 'icons/icon128.png',
            title: a.title, message: a.message,
            contextMessage: '点击打开 Firsto 交易所 · TapePost',
            priority: 2
          }, function () { void (chrome.runtime && chrome.runtime.lastError); });
        } catch (e) {}
      }
      if (cfg.toast !== false) broadcast(a);
    }
  }

  function broadcast(alert) {
    if (!chrome.tabs || !chrome.tabs.query) return;
    try {
      chrome.tabs.query({}, function (tabs) {
        (tabs || []).forEach(function (t) {
          if (!t || !t.id || !/^https?:/i.test(t.url || '')) return;
          try {
            chrome.tabs.sendMessage(t.id, { type: 'PRICE_ALERT_TOAST', alert: alert }, function () {
              void (chrome.runtime && chrome.runtime.lastError); // 同步读取，杜绝 Unchecked lastError
            });
          } catch (e) {}
        });
      });
    } catch (e) {}
  }

  function openLink(url) {
    var u = TapePrice.safeLink(url);
    try { chrome.tabs.create({ url: u, active: true }); } catch (e) {}
  }

  if (chrome.notifications && chrome.notifications.onClicked) {
    chrome.notifications.onClicked.addListener(function (id) {
      if (!/^tapeprice-/.test(String(id || ''))) return;
      localGet(LINK_KEY, {}).then(function (map) {
        openLink(map[id]);
        try { chrome.notifications.clear(id, function () { void (chrome.runtime && chrome.runtime.lastError); }); }
        catch (e) {}
      });
    });
  }

  function ensureAlarm() {
    if (!chrome.alarms || !chrome.alarms.create) return Promise.resolve();
    // 返回 Promise：保存设置后必须等闹钟真正重注册完再回包，
    // 否则用户改了间隔、面板显示「已保存」，后台却还在按旧周期跑。
    return readSettings().then(function (cfg) {
      try { chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: cfg.pollMinutes }); }
      catch (e) { /* Chrome < 120 不允许小于 1 分钟的周期，这里最小也是 1 */ }
    });
  }
  if (chrome.alarms && chrome.alarms.onAlarm) {
    chrome.alarms.onAlarm.addListener(function (a) {
      if (a && a.name === ALARM) refresh().catch(function () {});
    });
  }

  // 独立 listener：不与原有 CROSSPOST / GROK_* 路由耦合，回归风险最低
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !/^(PRICE_|OPEN_PRICE_LINK|TAPUP_PRICE)/.test(String(msg.type || ''))) return false;
    (async function () {
      if (msg.type === 'PRICE_GET') {
        var cached = await localGet(SNAP_KEY, null);
        var age = cached ? (Date.now() - Date.parse(cached.updatedAt)) : Infinity;
        // 2 分钟内的缓存直接给面板，避免每次点开弹窗都打两个接口；
        // 但内盘价可能刚在 tapeup.io 页面刷新，单独套用最新缓存，避免面板落后
        var base = (age < 120000) ? cached : await refresh();
        var upCache = await localGet('tapeupPriceCache', null);
        var snap = TapePrice.withUp(base, upCache);
        sendResponse({ ok: true, snapshot: snap, settings: await readSettings() });
      } else if (msg.type === 'PRICE_REFRESH') {
        sendResponse({ ok: true, snapshot: await refresh() });
      } else if (msg.type === 'TAPUP_PRICE') {
        // 内容脚本从 tapeup.io 交易页采集到的内盘价，缓存起来供面板与提醒使用
        // 不依赖 price.js 的 isObj（importScripts 只暴露 TapePrice 为全局，isObj 在其 IIFE 内），
        // 这里直接内联判断，避免真机收到回传时 ReferenceError
        var p = (msg && msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload)) ? msg.payload : {};
        var val = Number(p.value);
        // 1.4.23：K 线动态当前价也是有效采集；页头 BEM/UP 暂缺时不再整条丢弃
        var liveVal = Number(p.livePrice);
        if ((isFinite(val) && val > 0) || (isFinite(liveVal) && liveVal > 0)) {
          var upUsd = Number(p.usdValue);
          var livePct = Number(p.liveChangePct);
          var upItem = { value: (isFinite(val) && val > 0) ? val : null,
            usdValue: (isFinite(upUsd) && upUsd > 0) ? upUsd : null,
            changePct: Number(p.changePct) || null,
            livePrice: (isFinite(liveVal) && liveVal > 0) ? liveVal : null,
            liveChangePct: isFinite(livePct) ? livePct : null,
            liveNote: p.liveNote || null, liveSource: p.liveSource || null,
            asOf: p.asOf || null,
            at: Number(p.at) || Date.now(), debug: (p && p.debug) ? p.debug : null };
          var ups = {}; ups['tapeupPriceCache'] = upItem;
          await localSet(ups);
        }
        sendResponse({ ok: true });
      } else if (msg.type === 'PRICE_SETTINGS') {
        // 阈值改过就清空状态机：新阈值应立即生效，不能被旧状态压住
        var clr = {}; clr[STATE_KEY] = {};
        await localSet(clr);
        await ensureAlarm();
        sendResponse({ ok: true });
      } else if (msg.type === 'PRICE_TEST_ALERT') {
        var cfg = await readSettings();
        // 测试按钮无条件展示两种提醒，方便确认右下角浮层与系统通知是否都正常
        await fire([TapePrice.demoAlert()], Object.assign({}, cfg, { notify: true, toast: true }));
        sendResponse({ ok: true });
      } else if (msg.type === 'OPEN_PRICE_LINK') {
        openLink(msg.url);
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'unknown price message' });
      }
    })().catch(function (e) {
      try { sendResponse({ ok: false, error: String(e && e.message || e) }); } catch (e2) {}
    });
    return true; // 保持消息通道，异步回包
  });

  chrome.runtime.onInstalled.addListener(function () { ensureAlarm().catch(function () {}); refresh().catch(function () {}); });
  chrome.runtime.onStartup.addListener(function () { ensureAlarm().catch(function () {}); refresh().catch(function () {}); });
  ensureAlarm().catch(function () {});
})();

/* =====================================================================
 * 1.5.5：钱包（只读 + 本机加密） / TapeOut API 资产 / BEM 信仰者全网账本
 * 独立 IIFE + 独立 listener，不与 CROSSPOST / GROK_* / PRICE_* 三条路由耦合。
 * ===================================================================== */
(function walletVoteModule() {
  try {
    if (typeof importScripts === 'function') {
      if (typeof Wallet === 'undefined') importScripts('wallet.js');
      if (typeof TapeOutAPI === 'undefined') importScripts('tapeout-api.js');
      if (typeof Vote === 'undefined') importScripts('vote.js');
    }
  } catch (e) { console.warn('[bg][1.5.5] 模块加载失败: ' + String(e && e.message || e)); }
  if (typeof Wallet === 'undefined' || typeof TapeOutAPI === 'undefined' || typeof Vote === 'undefined') return;

  const K_KEY = 'wbxWalletKeyV1';       // 本机 AES-GCM 密钥（base64，随机生成，不同步）
  const K_SALT = 'wbxVoteSaltV1';        // 本机投票匿名盐
  const K_BIND = 'wbxWalletBindV1';      // 加密后的地址信封
  const K_ASSETS = 'wbxAssetsCacheV1';  // 最近一次资产快照
  const K_VOTE = 'wbxVoteStateV1';       // 账本缓存 / 本机打卡历史 / 待补投
  const VOTE_ALARM = 'bemVoteDailyCheck';
  const CRYPTO = (typeof globalThis !== 'undefined' ? globalThis.crypto : null);

  function sget(keys) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get(keys, function (o) { void (chrome.runtime && chrome.runtime.lastError); resolve(o || {}); }); }
      catch (e) { resolve({}); }
    });
  }
  function sset(obj) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.set(obj, function () { void (chrome.runtime && chrome.runtime.lastError); resolve(true); }); }
      catch (e) { resolve(false); }
    });
  }
  function sremove(keys) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.remove(keys, function () { void (chrome.runtime && chrome.runtime.lastError); resolve(true); }); }
      catch (e) { resolve(false); }
    });
  }
  async function secrets() {
    const o = await sget([K_KEY, K_SALT]);
    const key = o[K_KEY] || Wallet.newKey(CRYPTO);
    const salt = o[K_SALT] || Wallet.newSalt(CRYPTO);
    if (!o[K_KEY] || !o[K_SALT]) await sset({ [K_KEY]: key, [K_SALT]: salt });
    return { key: key, salt: salt };
  }
  async function fetchJson(url, init, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, ms || 6000);
    try {
      const res = await fetch(url, Object.assign({ cache: 'no-store' }, init || {}, { signal: ctrl.signal }));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  /* ---------- 钱包绑定 ---------- */
  async function saveBinding(address, providerId, providerName, chainId) {
    const s = await secrets();
    const payload = await Wallet.encryptText(CRYPTO, s.key, JSON.stringify({
      address: String(address).toLowerCase(), providerId: providerId || '',
      providerName: providerName || '', chainId: chainId || '', at: Date.now()
    }));
    await sset({ [K_BIND]: payload });
  }
  async function readBinding() {
    const o = await sget([K_BIND, K_KEY]);
    if (!o[K_BIND] || !o[K_KEY]) return null;
    const raw = await Wallet.decryptText(CRYPTO, o[K_KEY], o[K_BIND]);
    if (!raw) return null;
    try {
      const j = JSON.parse(raw);
      return Wallet.normalizeAddress(j.address) ? j : null;
    } catch (e) { return null; }
  }
  /*
   * 资产快照里带有查询用的完整钱包地址。缓存与发往 popup 的消息都先去掉它：
   * 明文地址只存在于 AES-GCM 加密的 K_BIND 里，storage.local 的资产缓存与
   * runtime 消息里只留数字（面板也只需要数字）。
   */
  function publicAssets(a) {
    if (!a || typeof a !== 'object') return a;
    const out = Object.assign({}, a);
    delete out.address;
    return out;
  }
  async function assetsOf(binding, mode) {
    const cached = publicAssets((await sget([K_ASSETS]))[K_ASSETS]);
    // 'cache'：弹窗首屏只读缓存，不发起 7 个资产请求，避免打开弹窗被网络拖慢；
    // true / 'force'：连接钱包、手动填地址、点 ↻ 读资产时才真正拉取。
    if (mode === 'cache') return { assets: cached || null, error: null };
    if (!mode && cached && cached.fetchedAt && (Date.now() - Date.parse(cached.fetchedAt) < 120000)) {
      return { assets: cached, error: null };
    }
    const snap = (await sget(['tapePriceSnapshot']))['tapePriceSnapshot'];
    const priceUsd = snap && snap.items && snap.items.bem ? snap.items.bem.value : null;
    try {
      const a = await Promise.race([
        TapeOutAPI.fetchAssets(fetch, binding.address, { priceUsd: priceUsd }),
        new Promise(function (r) { setTimeout(function () { r(null); }, 11000); })
      ]);
      if (!a || !a.ok) return { assets: cached || null, error: (a && a.error) || '资产接口超时' };
      const clean = publicAssets(a);
      await sset({ [K_ASSETS]: clean });
      return { assets: clean, error: a.errors && a.errors.length ? a.errors.join('；') : null };
    } catch (e) {
      return { assets: cached || null, error: String(e && e.message || e) };
    }
  }
  async function walletStatus(binding, force) {
    const a = binding ? await assetsOf(binding, force) : { assets: null, error: null };
    return {
      ok: true, bound: !!binding,
      mask: binding ? Wallet.checksumHint(binding.address) : '',
      providerName: binding ? (binding.providerName || '') : '',
      chainId: binding ? (binding.chainId || '') : '',
      assets: a.assets, assetsError: a.error
    };
  }

  /* ---------- 页面 MAIN world 钱包探测 ---------- */
  async function waitTabLoad(tabId) {
    return new Promise(function (resolve) {
      let done = false;
      function finish() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (e) {}
        resolve();
      }
      function onUpd(id, info) { if (id === tabId && info && info.status === 'complete') finish(); }
      const timer = setTimeout(finish, 9000);
      try { chrome.tabs.onUpdated.addListener(onUpd); } catch (e) { finish(); }
    });
  }
  async function runInPage(opts) {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ active: true, currentWindow: true }); } catch (e) {}
    const tab = tabs && tabs[0];
    if (tab && tab.id && /^https?:/i.test(tab.url || '')) {
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN', func: Wallet.pageBridge, args: [opts]
        });
        const out = res && res[0] && res[0].result;
        if (out && out.ok && opts.action === 'connect') return out;
        if (out && out.ok && opts.action === 'list' && out.providers && out.providers.length) return out;
        // 用户在钱包里点了「拒绝」就不再换页面重试，避免反复弹窗
        if (out && out.error && /拒绝|rejected|denied/i.test(out.error)) return out;
      } catch (e) { /* 换到 Firsto 页面重试 */ }
    }
    // 当前页不是普通 http(s)、或没探测到注入式钱包时，打开官方交易终端再探测一次
    try {
      const t = await chrome.tabs.create({ url: 'https://tapeout.firsto.ai/', active: false });
      if (!t || !t.id) throw new Error('无法打开连接页');
      await waitTabLoad(t.id);
      const res = await chrome.scripting.executeScript({
        target: { tabId: t.id }, world: 'MAIN', func: Wallet.pageBridge, args: [opts]
      });
      const out = res && res[0] && res[0].result;
      return out || { ok: false, error: '页面没有返回探测结果' };
    } catch (e) {
      return { ok: false, error: '钱包探测失败：' + String(e && e.message || e) + '；可手动填地址' };
    }
  }

  /* ---------- 全网账本 ---------- */
  function blankVote() {
    return { days: {}, localAdd: {}, history: {}, pending: [], totalVotes: 0,
      config: Vote.normalizeConfig(null), ledgerAvailable: false, lastSyncAt: 0, lastError: '' };
  }
  async function voteState() {
    const raw = (await sget([K_VOTE]))[K_VOTE];
    const s = Object.assign(blankVote(), Vote.isObj(raw) ? raw : {});
    s.config = Vote.normalizeConfig(s.config);
    if (!Vote.isObj(s.days)) s.days = {};
    if (!Vote.isObj(s.localAdd)) s.localAdd = {};
    if (!Vote.isObj(s.history)) s.history = {};
    if (!Array.isArray(s.pending)) s.pending = [];
    return s;
  }
  async function syncLedger(s) {
    const url = Vote.ledgerUrl(s.config.ledgerBase, '/api/state');
    try {
      const j = await fetchJson(url, { headers: { Accept: 'application/json' } }, 6000);
      const parsed = Vote.parseState(j);
      if (!parsed) throw new Error('账本返回格式不对');
      s.days = parsed.days;
      s.totalVotes = parsed.totalVotes;
      s.ledgerAvailable = true;
      s.lastSyncAt = Date.now();
      s.lastError = '';
    } catch (e) {
      s.ledgerAvailable = false;
      s.lastError = String(e && e.message || e);
    }
  }
  async function flushPending(s, salt) {
    if (!s.ledgerAvailable || !s.pending.length) return;
    const keep = [], synced = {};
    // 一次同步最多补投 5 票，剩下留到下次，避免长时间断网后打开弹窗被拖住
    const batch = s.pending.slice(0, 5), rest = s.pending.slice(5);
    for (let i = 0; i < batch.length; i++) {
      const p = batch[i];
      try {
        const j = await fetchJson(Vote.ledgerUrl(s.config.ledgerBase, '/api/vote'), {
          method: 'POST', headers: { 'content-type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ day: p.day, stance: p.stance, voterId: p.voterId })
        }, 6000);
        if (j && j.ok && Vote.isObj(j.days)) {
          s.days = {};
          Object.keys(j.days).forEach(function (d) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
            s.days[d] = { support: Math.max(0, Number(j.days[d].support) || 0),
              watch: Math.max(0, Number(j.days[d].watch) || 0) };
          });
          if (Number(j.totalVotes)) s.totalVotes = Number(j.totalVotes);
          synced[p.day] = 1;
        } else keep.push(p);
      } catch (e) { keep.push(p); }
    }
    s.pending = keep.concat(rest);
    Object.keys(synced).forEach(function (d) { delete s.localAdd[d]; });
    void salt;
  }
  async function syncAll(s, salt) {
    await syncLedger(s);
    await flushPending(s, salt);
    await sset({ [K_VOTE]: s });
    return Vote.summary(s);
  }
  function localAddOne(s, day, stance, prev) {
    if (!s.localAdd[day]) s.localAdd[day] = { support: 0, watch: 0 };
    if (prev === 'support' || prev === 'watch') {
      s.localAdd[day][prev] = Math.max(0, (s.localAdd[day][prev] || 0) - 1);
    }
    s.localAdd[day][stance] = (s.localAdd[day][stance] || 0) + 1;
  }

  /* ---------- 打卡提醒 ---------- */
  async function maybeRemind() {
    const s = await voteState();
    const cfg = s.config;
    if (!cfg.reminderEnabled) return;
    const day = Vote.dayKey();
    if (!Vote.needsCheckin(s.history, day)) return;
    if (cfg.reminderLastDay === day) return;
    /* 闹钟每 30 分钟醒一次，用「已到或已过设定小时」而不是等于：
     * 用户安装时刻未必整点，等于判断可能永远碰不上 20 点整。 */
    if (Vote.beijingHour() < cfg.reminderHour) return;
    cfg.reminderLastDay = day;
    s.config = cfg;
    await sset({ [K_VOTE]: s });
    try {
      chrome.notifications.create('bemvote-' + day, {
        type: 'basic', iconUrl: 'icons/icon128.png',
        title: 'TapePost · $BEM 信仰者今天还没打卡',
        message: '今天还没为 $BEM 投支持票，点插件图标打卡，全网按天累计记一笔。',
        contextMessage: '点击查看全网账本 · TapePost', priority: 1
      }, function () { void (chrome.runtime && chrome.runtime.lastError); });
    } catch (e) {}
  }
  function ensureVoteAlarm() {
    try { chrome.alarms.create(VOTE_ALARM, { delayInMinutes: 1, periodInMinutes: 30 }); } catch (e) {}
  }
  if (chrome.alarms && chrome.alarms.onAlarm) {
    chrome.alarms.onAlarm.addListener(function (a) {
      if (a && a.name === VOTE_ALARM) maybeRemind().catch(function () {});
    });
  }
  if (chrome.notifications && chrome.notifications.onClicked) {
    chrome.notifications.onClicked.addListener(function (id) {
      if (!/^bemvote-/.test(String(id || ''))) return;
      voteState().then(function (s) {
        try { chrome.tabs.create({ url: Vote.publicPage(s.config.ledgerBase), active: true }); } catch (e) {}
        try { chrome.notifications.clear(id, function () { void (chrome.runtime && chrome.runtime.lastError); }); } catch (e) {}
      });
    });
  }
  chrome.runtime.onInstalled.addListener(ensureVoteAlarm);
  chrome.runtime.onStartup.addListener(ensureVoteAlarm);
  ensureVoteAlarm();

  /* ---------- 消息路由 ---------- */
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !/^(WALLET_|ASSETS_|VOTE_)/.test(String(msg.type || ''))) return false;
    (async function () {
      const s = await secrets();
      if (msg.type === 'WALLET_STATUS') {
        sendResponse(await walletStatus(await readBinding(), 'cache'));
      } else if (msg.type === 'WALLET_PROVIDERS') {
        const out = await runInPage({ action: 'list' });
        sendResponse(out && out.ok
          ? { ok: true, providers: out.providers || [], note: '' }
          : { ok: true, providers: [], note: (out && out.error) || '未检测到注入式钱包' });
      } else if (msg.type === 'WALLET_CONNECT') {
        const out = await runInPage({ action: 'connect', providerId: String(msg.providerId || '') });
        if (!out || !out.ok) { sendResponse({ ok: false, error: (out && out.error) || '钱包未连接' }); return; }
        const addr = Wallet.normalizeAddress(out.address);
        if (!addr) { sendResponse({ ok: false, error: '钱包返回的地址无效' }); return; }
        let chain = String(out.chainId || '');
        if (/^0x/i.test(chain)) chain = String(parseInt(chain, 16));
        const pname = out.providerId ? Wallet.providerName(out.providerId, out.providerId) : '注入式钱包';
        await saveBinding(addr, out.providerId || '', pname, chain);
        const b = await readBinding();
        sendResponse(await walletStatus(b, true));
      } else if (msg.type === 'WALLET_MANUAL') {
        const addr = Wallet.normalizeAddress(msg.address);
        if (!addr) { sendResponse({ ok: false, error: '地址格式不对（要 0x + 40 位十六进制）' }); return; }
        await saveBinding(addr, 'manual', '手动填写', String(TapeOutAPI.CHAIN_ID));
        sendResponse(await walletStatus(await readBinding(), true));
      } else if (msg.type === 'WALLET_CLEAR') {
        await sremove([K_BIND, K_ASSETS]);
        sendResponse({ ok: true });
      } else if (msg.type === 'ASSETS_GET') {
        const b = await readBinding();
        if (!b) { sendResponse({ ok: false, error: '还没有连接钱包' }); return; }
        const a = await assetsOf(b, true);
        sendResponse({ ok: true, assets: a.assets, error: a.error });
      } else if (msg.type === 'VOTE_STATE') {
        const st = await voteState();
        sendResponse({ ok: true, summary: await syncAll(st, s.salt) });
      } else if (msg.type === 'VOTE_SYNC') {
        const st = await voteState();
        sendResponse({ ok: true, summary: await syncAll(st, s.salt) });
      } else if (msg.type === 'VOTE_CONFIG') {
        const st = await voteState();
        const next = Vote.normalizeConfig(Object.assign({}, st.config, msg.config || {}));
        // 改了提醒时间就允许当天再提醒一次，避免旧的 lastDay 把新设置压住
        if (next.reminderHour !== st.config.reminderHour || next.reminderEnabled !== st.config.reminderEnabled) {
          next.reminderLastDay = '';
        }
        st.config = next;
        await sset({ [K_VOTE]: st });
        sendResponse({ ok: true, summary: Vote.summary(st) });
      } else if (msg.type === 'VOTE_CAST') {
        const stance = String(msg.stance || '');
        if (Vote.STANCES.indexOf(stance) < 0) { sendResponse({ ok: false, error: '无效的立场' }); return; }
        const st = await voteState();
        const day = Vote.dayKey();
        const prev = st.history[day] || '';
        const voter = await Wallet.voterId(CRYPTO, s.salt, day);
        st.history[day] = stance;
        let posted = false;
        try {
          const j = await fetchJson(Vote.ledgerUrl(st.config.ledgerBase, '/api/vote'), {
            method: 'POST', headers: { 'content-type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ day: day, stance: stance, voterId: voter })
          }, 6500);
          if (j && j.ok && Vote.isObj(j.days)) {
            st.days = {};
            Object.keys(j.days).forEach(function (d) {
              if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
              st.days[d] = { support: Math.max(0, Number(j.days[d].support) || 0),
                watch: Math.max(0, Number(j.days[d].watch) || 0) };
            });
            if (Number(j.totalVotes)) st.totalVotes = Number(j.totalVotes);
            st.ledgerAvailable = true;
            st.lastSyncAt = Date.now();
            st.lastError = '';
            delete st.localAdd[day];
            st.pending = st.pending.filter(function (p) { return p.day !== day; });
            posted = true;
          }
        } catch (e) { st.lastError = String(e && e.message || e); }
        if (!posted) {
          st.ledgerAvailable = false;
          localAddOne(st, day, stance, prev);
          st.pending = st.pending.filter(function (p) { return p.day !== day; });
          st.pending.push({ day: day, stance: stance, voterId: voter });
        }
        await sset({ [K_VOTE]: st });
        sendResponse({ ok: true, summary: Vote.summary(st), posted: posted });
      } else {
        sendResponse({ ok: false, error: '未知消息类型' });
      }
    })().catch(function (e) {
      try { sendResponse({ ok: false, error: String(e && e.message || e) }); } catch (e2) {}
    });
    return true; // 异步回包
  });
})();
