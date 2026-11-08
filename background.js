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
 * 两个 AI 功能共用这一段：
 *   GROK_COMMENTS — X 一键评论，按设定提示词生成 3 条回复候选
 *   GROK_VERIFY   — TapeOut 生态面板的链接真伪查询
 *   GROK_TEST     — 设置面板「测试连接」
 *
 * API Key 只存在 chrome.storage.local（本机、不同步、不入库、不上报），
 * 由 Service Worker 直接请求 api.x.ai；页面 content script 不接触密钥。
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

async function getGrokConfig() {
  const [secret, pref] = await Promise.all([
    storageGet('local', ['grokApiKey', 'grokBaseUrl', 'grokModel', 'grokProtocol', 'grokTemperature']),
    storageGet('sync', ['commentPrompt', 'verifyPrompt'])
  ]);
  return Object.assign({}, GROK_DEFAULTS, secret, {
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

async function callGrok(messages, maxTokens) {
  const cfg = await getGrokConfig();
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

async function handleGrokMessage(msg) {
  const payload = msg.payload || {};
  if (typeof TapeAI === 'undefined') throw new Error('grok.js 未加载，请重新加载扩展。');

  if (msg.type === 'GROK_TEST') {
    const started = Date.now();
    const r = await callGrok([
      { role: 'system', content: 'You are a test endpoint. Reply with exactly OK.' },
      { role: 'user', content: 'Reply with exactly: OK' }
    ], 16);
    return { ok: true, model: r.model, protocol: r.protocol, latencyMs: Date.now() - started, sample: r.text.slice(0, 60) };
  }

  if (msg.type === 'GROK_COMMENTS') {
    const cfg = await getGrokConfig();
    const messages = TapeAI.buildCommentMessages(payload.text || '', cfg.commentPrompt);
    const r = await callGrok(messages, 700);
    const comments = TapeAI.parseThreeComments(r.text);
    if (!comments.length) {
      throw new Error('Grok 返回的内容解析不出评论文本，可点「重新生成」，或在设置里把提示词改得更明确。原文：' + r.text.slice(0, 160));
    }
    return { ok: true, comments, model: r.model, raw: r.text.slice(0, 1200) };
  }

  if (msg.type === 'GROK_VERIFY') {
    // 本地白名单结论永远先算出来；即使 Grok 不可用，面板也能给出可靠判定
    const local = TapeAI.matchOfficial(payload.url || '');
    const cfg = await getGrokConfig();
    let grok = null;
    let aiError = null;
    try {
      const messages = TapeAI.buildVerifyMessages(payload.url || '', cfg.verifyPrompt);
      const r = await callGrok(messages, 600);
      grok = TapeAI.parseVerdict(r.text);
      grok.model = r.model;
    } catch (e) {
      aiError = String(e && e.message || e);
    }
    return {
      ok: local.status !== 'invalid',
      local: {
        status: local.status,
        tier: local.tier || null,
        viaGateway: local.viaGateway || null,
        normalized: local.normalized || null,
        site: local.site || null,
        risks: local.risks || [],
        error: local.error || null
      },
      grok,
      aiError,
      source: TapeAI.SOURCE
    };
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
  if (msg.type === 'GROK_COMMENTS' || msg.type === 'GROK_VERIFY' || msg.type === 'GROK_TEST') {
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
