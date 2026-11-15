'use strict';

// 已取消「需去水印作者 UID」列表；图片/视频都改由全局开关控制。
// 换用新 key，让旧版保存的 alwaysInpaint / watermarkUids 自动失效，避免旧设置盖掉新默认值。
const PAGE_DEFAULTS = (typeof TapeAI !== 'undefined' && TapeAI.PAGE_MODE_DEFAULTS)
  ? TapeAI.PAGE_MODE_DEFAULTS : {};

const DEFAULTS = Object.assign({
  inpaintImages: true,
  hd4k: true,
  inpaintVideo: true,
  xDomain: 'x.com',
  hashMode: 'truncate',
  appendSignature: false,
  appendSource: false,
  enableAiComment: true,
  replyInputSelector: '',  // 空 = 用 sites.js 内置的 X 回复框选择器
  commentPrompt: '',       // 空 = 用 grok.js 内置默认提示词
  verifyPrompt: '',
  enabledSites: {},
  grokModeMigrated141: false, // 1.4.1：旧 page 设置只自动升级一次
  // 1.4.3：临时文件策略
  autoDownloadBackup: false,  // 转发时自动下载图片备份（默认关）
  tmpCleanup: true,           // 到期自动清理
  tmpKeepMinutes: 30,         // 0 = 不自动清理
  // 1.4.5：AI 评论末尾的生态推广尾巴（默认关闭，用户显式勾选才生效）
  promoEnabled: false,
  promoTarget: 'both',        // both | tapeout | bem
  promoCustomTapeOut: '',     // 每行一句；留空用内置话术
  promoCustomBEM: '',
  // 1.4.8：回复框右侧只有一个 T 按钮（与 AI 评论无关，默认开启）
  promoQuickButtons: true,
  promoQuickCount: 4,            // 兼容旧配置，1.4.8 起不再使用
  // 1.4.11
  promoCopyOnly: false,          // T 只复制、不改 X 编辑器
  grokFastMode: true,            // AI 评论非思考快速模式
  commentCount: 5                // 1.5.15：每次生成的候选条数（1~10，默认 5）
}, PAGE_DEFAULTS);

// 页面模式的文本配置项；选择器全部可改，X 改版时不用升版本
const PAGE_TEXT_IDS = [
  'grokPageUrl', 'grokPageInputSel', 'grokPageSendSel', 'grokPageRootSel', 'grokPageAnswerSel',
  'grokPageQuietMs', 'grokPageTimeoutMs', 'grokPageMaxChars'
];

// 密钥 / 接口配置只放 storage.local：不同步到其它设备，也不随源码分发
const GROK_SECRET_DEFAULTS = {
  grokApiKey: '',
  grokProtocol: 'chat',
  grokBaseUrl: 'https://api.x.ai/v1',
  grokModel: 'grok-4.3',
  grokTemperature: 0.7,
  // 1.5.3：DeepSeek 与 xAI 的密钥 / 模型 / 网关完全分开存，互不覆盖
  deepseekApiKey: '',
  deepseekModel: 'deepseek-v4-flash',
  deepseekBaseUrl: 'https://api.deepseek.com',
  deepseekTemperature: 0.7,
  deepseekJsonMode: true
};

// 站点列表与 sites.js 共用同一份配置，避免两处维护
const SITE_LIST = (typeof SITE_PROFILES !== 'undefined')
  ? Object.keys(SITE_PROFILES).map((id) => ({ id, label: SITE_PROFILES[id].label }))
  : [
    { id: 'weibo', label: '微博' }, { id: 'zhihu', label: '知乎' },
    { id: 'wechat', label: '微信公众号' }, { id: 'bilibili', label: 'B站动态' },
    { id: 'douban', label: '豆瓣广播' }, { id: 'xiaohongshu', label: '小红书' },
    { id: 'x', label: 'X（推文）' }
  ];

/*
 * 1.4.4：统一发消息通道，消除 chrome://extensions 里的
 * "Unchecked runtime.lastError: The message port closed before a response was received"。
 * popup 随时可能被用户关掉；若端口在后台 sendResponse 之前关闭，回调里
 * 不读取 chrome.runtime.lastError 就会被 Chrome 记成扩展错误。
 * 所有发往后台的消息都走这里，并在回调第一行同步读取 lastError。
 */
function sendBg(msg, cb, _try) {
  const done = (typeof cb === 'function') ? cb : function () {};
  const n = _try || 0;
  /* 1.5.11：后台 service worker 冷启动时第一条消息可能丢，自动退避重试，
   * 避免弹窗一打开就报「连接断开 / 读取中」而必须重新打开。 */
  const retryable = (err) => /Receiving end does not exist|Could not establish connection/i
    .test(String((err && err.message) || err || ''));
  const retry = (err) => {
    if (n < 3 && retryable(err)) {
      setTimeout(() => sendBg(msg, done, n + 1), 200 * (n + 1));
      return true;
    }
    return false;
  };
  try {
    chrome.runtime.sendMessage(msg, function (resp) {
      const err = chrome.runtime && chrome.runtime.lastError; // 必须同步读取
      if (err && retry(err)) return;
      try { done(resp || null, err || null); } catch (e) {}
    });
  } catch (e) {
    if (retry(e)) return;
    try { done(null, e); } catch (e2) {}
  }
}

// ---------- Grok 设置 ----------
const DEFAULT_PROMPTS = (typeof TapeAI !== 'undefined')
  ? { commentPrompt: TapeAI.DEFAULT_COMMENT_PROMPT, verifyPrompt: TapeAI.DEFAULT_VERIFY_PROMPT }
  : { commentPrompt: '', verifyPrompt: '' };

/* 提示词显示默认值，但「没改过」时存空串 —— 以后升级内置提示词能自动生效 */
function renderPrompt(id, stored) {
  const el = document.getElementById(id);
  if (!el) return;
  el.dataset.wbxDefault = DEFAULT_PROMPTS[id] || '';
  el.value = stored || el.dataset.wbxDefault;
}

function promptToStore(id) {
  const el = document.getElementById(id);
  if (!el) return '';
  return (el.value === (el.dataset.wbxDefault || '')) ? '' : el.value;
}

function readGrokSecrets() {
  return {
    grokApiKey: (document.getElementById('grokKey') || {}).value || '',
    grokProtocol: (document.getElementById('grokProtocol') || {}).value || 'chat',
    grokBaseUrl: (document.getElementById('grokBaseUrl') || {}).value || GROK_SECRET_DEFAULTS.grokBaseUrl,
    grokModel: (document.getElementById('grokModel') || {}).value || GROK_SECRET_DEFAULTS.grokModel,
    grokTemperature: 0.7,
    // 1.5.3：DeepSeek 专属配置
    deepseekApiKey: (document.getElementById('deepseekKey') || {}).value || '',
    deepseekModel: (document.getElementById('deepseekModel') || {}).value || GROK_SECRET_DEFAULTS.deepseekModel,
    deepseekBaseUrl: (document.getElementById('deepseekBaseUrl') || {}).value || GROK_SECRET_DEFAULTS.deepseekBaseUrl,
    deepseekTemperature: 0.7,
    deepseekJsonMode: (document.getElementById('deepseekJsonMode') || { checked: true }).checked !== false
  };
}

function saveGrokSecrets() {
  return new Promise((resolve) => {
    const secrets = readGrokSecrets();
    try { chrome.storage.local.set(secrets, () => resolve(secrets)); }
    catch (e) { resolve(secrets); }
  });
}

/* 1.5.3：只有选了 DeepSeek 模式才展开专属配置块，其余模式保持设置页紧凑 */
function syncDeepseekPanel() {
  const box = document.getElementById('deepseekCfg');
  if (!box) return;
  const mode = String((document.getElementById('grokMode') || {}).value || 'auto');
  box.hidden = mode !== 'deepseek';
  // 1.5.15：DeepSeek / xAI API 模式用不到 X 网页 Grok 标签，别再露出「打开 Grok 页面」这类入口
  const apiOnly = mode === 'deepseek' || mode === 'api';
  ['openGrok', 'resetGrokTab'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = apiOnly ? 'none' : '';
  });
}

function grokStatus(text, good) {
  const box = document.getElementById('grokStatus');
  if (!box) return;
  box.style.display = 'block';
  box.textContent = text;
  box.style.background = good ? '#f0fdf4' : '#fef2f2';
  box.style.color = good ? '#14532d' : '#7f1d1d';
}

function load() {
  chrome.storage.sync.get(DEFAULTS, (s) => {
    document.getElementById('hash').value = s.hashMode || 'truncate';
    document.getElementById('imgWm').checked = !!s.inpaintImages;
    const hd4k = document.getElementById('hd4k');
    if (hd4k) hd4k.checked = s.hd4k !== false;
    document.getElementById('videoWm').checked = !!s.inpaintVideo;
    document.getElementById('sig').checked = !!s.appendSignature;
    const source = document.getElementById('source');
    if (source) source.checked = !!s.appendSource;
    const autoDl = document.getElementById('tmpAutoDownload');
    if (autoDl) autoDl.checked = !!s.autoDownloadBackup;
    const tmpClean = document.getElementById('tmpCleanup');
    if (tmpClean) tmpClean.checked = s.tmpCleanup !== false;
    const keep = document.getElementById('tmpKeepMinutes');
    if (keep) keep.value = String(s.tmpKeepMinutes == null ? 30 : s.tmpKeepMinutes);
    document.getElementById('domain').value = s.xDomain || 'x.com';
    const ai = document.getElementById('aiComment');
    if (ai) ai.checked = s.enableAiComment !== false;
    const fastMode = document.getElementById('grokFastMode');
    if (fastMode) fastMode.checked = s.grokFastMode !== false;
    // 1.5.15：候选条数（非法值回落到默认 5）
    const cnt = document.getElementById('commentCount');
    if (cnt) {
      const n = parseInt(s.commentCount, 10);
      cnt.value = String(isFinite(n) && n >= 1 && n <= 10 ? n : 5);
    }
    // 1.4.5 / 1.4.8 / 1.4.11：评论末尾推广（自动附加 + 单个 T 按钮 + 安全模式）
    const quickOn = document.getElementById('promoQuickButtons');
    if (quickOn) quickOn.checked = s.promoQuickButtons !== false;
    const copyOnly = document.getElementById('promoCopyOnly');
    if (copyOnly) copyOnly.checked = s.promoCopyOnly === true;
    const promoOn = document.getElementById('promoEnabled');
    if (promoOn) promoOn.checked = s.promoEnabled === true;
    const promoTarget = document.getElementById('promoTarget');
    if (promoTarget) promoTarget.value = ['both', 'tapeout', 'bem'].indexOf(s.promoTarget) >= 0 ? s.promoTarget : 'both';
    const promoT = document.getElementById('promoCustomTapeOut');
    if (promoT) promoT.value = s.promoCustomTapeOut || '';
    const promoB = document.getElementById('promoCustomBEM');
    if (promoB) promoB.value = s.promoCustomBEM || '';
    const replySel = document.getElementById('replyInputSelector');
    if (replySel) replySel.value = s.replyInputSelector || '';
    renderPrompt('commentPrompt', s.commentPrompt);
    renderPrompt('verifyPrompt', s.verifyPrompt);
    const mode = document.getElementById('grokMode');
    /* 1.4.1：旧版把「X 站内 Grok」存成显式 page，导致 1.4.0 的直连链路
     * 一次都没被走到。只要用户没主动关掉「优先站内直连」，就在打开设置时
     * 自动纠正为 auto（只写必要的键，不覆盖其它设置）；用户之后手动改回
     * page 会被 save() 打标记，不再被自动改。 */
    const legacyPage = String(s.grokMode || '').toLowerCase() === 'page' &&
      s.grokPreferNative !== false && s.grokModeMigrated141 !== true;
    if (mode) mode.value = legacyPage ? 'auto' : (s.grokMode || 'auto');
    syncDeepseekPanel();   // 1.5.3：sync / local 两个回调谁先回来都要保证配置块显隐正确
    const fixNote = document.getElementById('modeFixNote');
    if (fixNote) fixNote.hidden = !legacyPage;
    if (legacyPage) {
      try {
        chrome.storage.sync.set({ grokMode: 'auto', grokModeMigrated141: true });
      } catch (e) {}
    }
    const extra = document.getElementById('pagePromptExtra');
    if (extra) extra.value = s.pagePromptExtra || '';
    PAGE_TEXT_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const v = s[id];
      el.value = (v == null || v === '') ? (PAGE_DEFAULTS[id] == null ? '' : PAGE_DEFAULTS[id]) : v;
    });
    ['grokPageAutoSubmit', 'grokPageNewChat', 'grokPreferNative'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.checked = s[id] !== false && s[id] !== 'false';
    });
    const enabled = s.enabledSites || {};
    SITE_LIST.forEach((x) => {
      const el = document.getElementById('site_' + x.id);
      if (el) el.checked = enabled[x.id] !== false; // 默认全开
    });
  });
  chrome.storage.local.get(GROK_SECRET_DEFAULTS, (g) => {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('grokKey', g.grokApiKey || '');
    set('grokProtocol', g.grokProtocol || 'chat');
    set('grokBaseUrl', g.grokBaseUrl || GROK_SECRET_DEFAULTS.grokBaseUrl);
    set('grokModel', g.grokModel || GROK_SECRET_DEFAULTS.grokModel);
    set('deepseekKey', g.deepseekApiKey || '');
    set('deepseekModel', g.deepseekModel || GROK_SECRET_DEFAULTS.deepseekModel);
    set('deepseekBaseUrl', g.deepseekBaseUrl || GROK_SECRET_DEFAULTS.deepseekBaseUrl);
    const dsJson = document.getElementById('deepseekJsonMode');
    if (dsJson) dsJson.checked = g.deepseekJsonMode !== false;
    syncDeepseekPanel();
  });
}

function save() {
  const data = {
    hashMode: document.getElementById('hash').value,
    inpaintImages: document.getElementById('imgWm').checked,
    hd4k: !!(document.getElementById('hd4k') || { checked: true }).checked,
    inpaintVideo: document.getElementById('videoWm').checked,
    appendSignature: document.getElementById('sig').checked,
    appendSource: !!(document.getElementById('source') || {}).checked,
    autoDownloadBackup: !!(document.getElementById('tmpAutoDownload') || {}).checked,
    tmpCleanup: !!(document.getElementById('tmpCleanup') || {}).checked,
    tmpKeepMinutes: Number((document.getElementById('tmpKeepMinutes') || {}).value || 0),
    enableAiComment: !!(document.getElementById('aiComment') || {}).checked,
    // 1.4.11：AI 快速模式 / T 安全模式
    grokFastMode: (document.getElementById('grokFastMode') || { checked: true }).checked !== false,
    // 1.5.15：候选条数，前后都夹一次，防止手改 DOM / 旧值越界
    commentCount: (() => {
      const el = document.getElementById('commentCount');
      const n = parseInt(el ? el.value : 5, 10);
      return isFinite(n) ? Math.max(1, Math.min(10, n)) : 5;
    })(),
    promoCopyOnly: !!(document.getElementById('promoCopyOnly') || {}).checked,
    // 1.4.5：推广开关与话术
    promoEnabled: !!(document.getElementById('promoEnabled') || {}).checked,
    promoTarget: (document.getElementById('promoTarget') || {}).value || 'both',
    promoCustomTapeOut: (document.getElementById('promoCustomTapeOut') || {}).value || '',
    promoCustomBEM: (document.getElementById('promoCustomBEM') || {}).value || '',
    promoQuickButtons: (document.getElementById('promoQuickButtons') || { checked: true }).checked !== false,
    promoQuickCount: 4,            // 1.4.8 起固定一个 T 按钮，保留键兼容旧配置
    replyInputSelector: (document.getElementById('replyInputSelector') || {}).value || '',
    commentPrompt: promptToStore('commentPrompt'),
    verifyPrompt: promptToStore('verifyPrompt'),
    xDomain: document.getElementById('domain').value,
    enabledSites: (() => {
      const out = {};
      SITE_LIST.forEach((x) => {
        const el = document.getElementById('site_' + x.id);
        out[x.id] = !!(el && el.checked);
      });
      return out;
    })()
  };
  const mode = document.getElementById('grokMode');
  data.grokMode = mode ? mode.value : 'auto';
  // 用户主动保存过设置后，不再把它当「旧版遗留值」自动改掉（尊重显式选页面模式）
  data.grokModeMigrated141 = true;
  const extra = document.getElementById('pagePromptExtra');
  data.pagePromptExtra = extra ? extra.value : '';
  PAGE_TEXT_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const v = String(el.value || '').trim();
    data[id] = v === '' ? PAGE_DEFAULTS[id] : (/Ms$|MaxChars$/.test(id) ? (Number(v) || PAGE_DEFAULTS[id]) : v);
  });
  ['grokPageAutoSubmit', 'grokPageNewChat', 'grokPreferNative'].forEach((id) => {
    const el = document.getElementById(id);
    data[id] = !!(el && el.checked);
  });
  chrome.storage.sync.set(data, () => {
    const ok = document.getElementById('ok');
    ok.style.display = 'block';
    setTimeout(() => { ok.style.display = 'none'; }, 1500);
  });
  saveGrokSecrets();
}

function testGrok() {
  const m = String((document.getElementById('grokMode') || {}).value || 'auto');
  const who = m === 'deepseek' ? 'DeepSeek API' : (m === 'api' ? 'xAI API' :
    (m === 'native' ? 'X 站内 Grok' : '当前 AI 模式'));
  grokStatus('正在连接 ' + who + '…', true);
  saveGrokSecrets().then(() => {
    try {
      sendBg({ type: 'GROK_TEST' }, (r, err) => {
        if (err) return grokStatus('连不上后台：' + err.message + '（请到 chrome://extensions 重新加载扩展）', false);
        if (!r || !r.ok) return grokStatus('连接失败：' + ((r && r.error) || '后台没有返回结果'), false);
        const modeText = r.mode === 'deepseek' ? 'DeepSeek API'
          : (r.mode === 'page' || r.mode === 'native') ? 'X 站内 Grok（免 API Key）' : 'xAI API';
        grokStatus('✅ ' + modeText + ' 已连通｜' + r.model + '｜' + r.protocol +
          '｜耗时 ' + r.latencyMs + 'ms｜' + (r.sample || '').replace(/\s+/g, ' '), true);
      });
    } catch (e) {
      grokStatus('测试调用失败：' + String(e && e.message || e), false);
    }
  });
}

/* 预览：按当前运行模式，把「设置里的提示词 + 该模式的输出约束」拼成真正会发给 Grok 的完整文本 */
function previewPrompt() {
  const box = document.getElementById('promptPreview');
  if (!box) return;
  if (typeof TapeAI === 'undefined') { grokStatus('提示词模块未加载，请重新加载扩展。', false); return; }
  const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
  const extra = val('pagePromptExtra');
  const mode = (document.getElementById('grokMode') || {}).value || 'auto';
  // 1.5.3：xAI / DeepSeek API 模式发的是原始 system+user messages，不带页面模式的任务标记
  const apiMode = mode === 'api' || mode === 'deepseek';
  const native = !apiMode && (mode === 'native' ||
    (mode === 'auto' && (document.getElementById('grokPreferNative') || {}).checked !== false));
  const samplePost = '（示例推文）TapeOut 生态又多了一个链上应用，DeWeb 容器索引突破 200 个。';
  // 1.5.15：预览必须和真实请求一样按设置的条数生成
  const cntEl = document.getElementById('commentCount');
  const cntN = parseInt(cntEl ? cntEl.value : 5, 10);
  const count = isFinite(cntN) ? Math.max(1, Math.min(10, cntN)) : 5;
  // 1.5.3：DeepSeek 开启 JSON Output 且提示词里没有 json 字样时，后台会补一条 system 提示；
  // 预览必须与实际发送一致，所以这里做同样的归一化（xAI API 模式不补）。
  const dsJsonOn = mode === 'deepseek' &&
    (document.getElementById('deepseekJsonMode') || { checked: true }).checked !== false;
  const normalizeForApi = (messages) => {
    const list = messages || [];
    if (!dsJsonOn || list.some((m) => /json/i.test(String((m && m.content) || '')))) return list;
    return [{ role: 'system', content: '请严格用 JSON 格式输出（JSON only）。' }].concat(list);
  };
  const fmtApi = (messages) => normalizeForApi(messages)
    .map((m) => '【' + m.role + '】\n' + m.content).join('\n\n');
  // 1.4.18：站内直连的 AI 评论走 XVM 式极简模板，预览必须与实际发送一致
  const comment = apiMode
    ? fmtApi(TapeAI.buildCommentMessages(samplePost, val('commentPrompt'), count))
    : native
      ? TapeAI.buildNativeCommentPrompt(samplePost, val('commentPrompt'), extra, count)
      : TapeAI.buildPageCommentPrompt(samplePost, val('commentPrompt'), extra, count);
  const buildVerify = (messages, kind) => apiMode
    ? fmtApi(messages)
    : native
      ? TapeAI.buildNativePrompt(messages, kind, extra)
      : TapeAI.buildPagePrompt(messages, extra);
  const verify = buildVerify(
    TapeAI.buildVerifyMessages('https://tapeout.net/', val('verifyPrompt')), 'verify');
  const who = native ? 'X 站内 Grok'
    : (mode === 'deepseek' ? 'DeepSeek API' : (mode === 'api' ? 'xAI API' : 'X 页面 Grok'));
  box.style.display = 'block';
  box.textContent = '【AI 评论 · 实际发送内容｜' + who + ' · ' + count + ' 条候选】\n' + comment +
    '\n\n────────────────────\n\n【链接核验 · 实际发送内容】\n' +
    verify.slice(0, 1600) + (verify.length > 1600 ? '\n…（清单摘要较长，此处省略）' : '');
  const label = native ? '站内直连'
    : (mode === 'deepseek' ? 'DeepSeek API' : (mode === 'api' ? 'xAI API' : '页面模式'));
  grokStatus('已生成预览：这就是' + label +
    '下实际发送的完整文本（用示例内容拼装，不会真的发送）。', true);
}

/* 1.3.3：扩展重载后旧 X 标签的 content script 是孤儿，页面模式会报
 * "Receiving end does not exist"。这个按钮刷新旧的 Grok 标签并新建干净标签。 */
function resetGrokTab() {
  grokStatus('正在刷新旧的 Grok 标签并重建连接…', true);
  saveGrokSecrets().then(() => {
    try {
      sendBg({ type: 'GROK_PAGE_RESET' }, (r, err) => {
        if (err) return grokStatus('连不上后台：' + err.message + '（请到 chrome://extensions 重新加载扩展）', false);
        if (!r || !r.ok) {
          return grokStatus('重建失败：' + ((r && r.error) || '后台没有返回结果') +
            '｜请先手动刷新所有 X 页面（Cmd+R），或点「打开 Grok 页面」。', false);
        }
        grokStatus('✅ ' + (r.note || '已重建') + (r.url ? '｜' + r.url : '') +
          '｜输入框 ' + (r.hasInput ? '可用' : '未就绪'), true);
      });
    } catch (e) {
      grokStatus('重建调用失败：' + String(e && e.message || e), false);
    }
  });
}

function openGrokPage() {
  const el = document.getElementById('grokPageUrl');
  let url = String((el && el.value) || PAGE_DEFAULTS.grokPageUrl || 'https://x.com/i/grok').trim();
  if (!/^https:\/\/(?:x\.com|twitter\.com)\//i.test(url)) url = 'https://x.com/i/grok';
  try {
    chrome.tabs.create({ url, active: true });
    grokStatus('已打开 ' + url + '。页面模式会优先复用这个标签；若账号没登录或 Grok 不可用，请先在这里登录。', true);
  } catch (e) {
    grokStatus('打开 Grok 页面失败：' + String(e && e.message || e), false);
  }
}

/* 自定义网关不是默认 host_permissions，用户主动点一下才申请该域名访问权 */
function grantOrigin() {
  // 1.5.3：按当前运行模式申请对应服务商 / 网关的域名权限
  const isDs = String((document.getElementById('grokMode') || {}).value || '') === 'deepseek';
  const base = (document.getElementById(isDs ? 'deepseekBaseUrl' : 'grokBaseUrl') || {}).value ||
    (isDs ? GROK_SECRET_DEFAULTS.deepseekBaseUrl : GROK_SECRET_DEFAULTS.grokBaseUrl);
  let origin;
  try { origin = new URL(String(base).trim()).origin; }
  catch (e) { grokStatus('接口地址不是合法 URL，请检查后再点。', false); return; }
  if (!chrome.permissions || !chrome.permissions.request) {
    grokStatus('当前 Chrome 不支持动态权限申请；请用官方默认地址，或让网关允许跨域。', false);
    return;
  }
  chrome.permissions.request({ origins: [origin + '/*'] }, (granted) => {
    grokStatus(granted ? '✅ 已允许访问 ' + origin + '，可以点「测试连接」了。'
      : '没有授予 ' + origin + ' 的访问权限；可继续用官方默认地址。', !!granted);
  });
}

/*
 * 运行环境自检：Chrome 在 chrome://extensions 里点「重新加载」后，
 * 旧页面的 content script 会失效、Service Worker 会重启、DNR 动态规则可能丢失。
 * 用回调式 sendMessage（兼容各版本），把后台状态直接显示在弹窗里，
 * 不用去翻 chrome://extensions 的「错误」面板。
 */
function runDiagnostics() {
  const box = document.getElementById('diag');
  box.style.display = 'block';
  box.textContent = '正在检查…';
  let finished = false;
  const finish = (lines) => {
    if (finished) return;
    finished = true;
    box.textContent = lines.join('\n');
  };
  setTimeout(() => {
    if (!finished) finish([
      '⚠️ 后台 Service Worker 5 秒内没有响应',
      '',
      '常见原因：',
      '1) 重新加载后微博页面还没刷新（旧按钮会失效）→ 刷新微博页',
      '2) 扩展被 Chrome 停用 → 到 chrome://extensions 重新启用',
      '3) 后台崩溃 → 在扩展卡片点「Service Worker → 检查视图」看控制台'
    ]);
  }, 5000);

  try {
    sendBg({ type: 'DIAG' }, (r, err) => {
      if (err) {
        finish(['⚠️ 无法连接后台：' + err.message, '', '请在 chrome://extensions 重新加载扩展，并刷新微博页面。']);
        return;
      }
      if (!r) { finish(['⚠️ 后台返回空结果', '', '请在 chrome://extensions 重新加载扩展后重试。']); return; }
      const yes = (v) => v ? '✅ 正常' : '❌ 异常';
      const lines = [
        '插件版本：' + r.version + '   Chrome：' + r.chrome,
        '后台 Service Worker：✅ 已响应',
        'Referer 注入 API：' + yes(r.dnrApi),
        '已生效规则 ID：' + (r.dnrRules && r.dnrRules.length ? r.dnrRules.join(', ') : '（无）'),
        '规则重注册：' + (r.reinstalled ? '✅ 成功' : '❌ 失败'),
        '离屏文档 API：' + yes(r.offscreenApi),
        '离屏文档：' + (r.offscreenReady ? '已创建' : '未创建（点「一键转发」时自动创建）'),
        '最近内部错误：' + (r.lastError || '无')
      ];
      if (r.dnrError) lines.push('规则错误详情：' + r.dnrError);
      if (r.dnrApi && r.reinstalled && !r.lastError) {
        lines.push('', '✅ 自检通过。若微博页仍报错，请刷新微博页面（重新加载扩展后旧按钮会失效）。');
      } else {
        lines.push('', '⚠️ 有异常项：把上面内容截图发我，或到 chrome://extensions 看「错误」面板。');
      }
      finish(lines);
    });
  } catch (e) {
    finish(['⚠️ 自检调用失败：' + String(e && e.message || e), '', '请重新加载扩展后重试。']);
  }
}

const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
bind('save', save);
bind('check', runDiagnostics);
bind('openPanel', () => {
  try { chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') }); }
  catch (e) { grokStatus('打开生态面板失败：' + String(e && e.message || e), false); }
});
bind('testGrok', testGrok);
const modeSel = document.getElementById('grokMode');
if (modeSel) modeSel.addEventListener('change', syncDeepseekPanel);
bind('resetGrokTab', resetGrokTab);
bind('grantOrigin', grantOrigin);
bind('showKey', () => {
  // 1.5.3：显示当前所选 API 供应商的 Key，不把两家的输入框同时切成明文
  const isDs = String((document.getElementById('grokMode') || {}).value || '') === 'deepseek';
  const k = document.getElementById(isDs ? 'deepseekKey' : 'grokKey');
  const b = document.getElementById('showKey');
  if (!k || !b) return;
  const show = k.type === 'password';
  k.type = show ? 'text' : 'password';
  b.textContent = show ? '🙈 隐藏 Key' : '👁 显示 Key';
});
bind('resetComment', () => renderPrompt('commentPrompt', ''));
bind('resetVerify', () => renderPrompt('verifyPrompt', ''));
bind('resetPageExtra', () => {
  const el = document.getElementById('pagePromptExtra');
  if (el) el.value = '';
  grokStatus('页面模式附加要求已清空（记得点「保存设置」）。', true);
});
bind('previewPrompt', previewPrompt);
bind('openGrok', openGrokPage);

/* 1.4.5：随机预览 —— 用的是候选注入时同一份话术库与抽取逻辑 */
function previewPromo() {
  const box = document.getElementById('promoPreviewBox');
  if (!box || typeof TapePromo === 'undefined') return;
  const target = (document.getElementById('promoTarget') || {}).value || 'both';
  const custom = {
    tapeout: (document.getElementById('promoCustomTapeOut') || {}).value || '',
    bem: (document.getElementById('promoCustomBEM') || {}).value || ''
  };
  const lines = TapePromo.pickLines(target, custom, 3);
  const label = target === 'tapeout' ? 'TapeOut' : (target === 'bem' ? '$BEM' : 'TapeOut + $BEM 交替');
  box.textContent = '当前主题：' + label + '\n\n' +
    lines.map((l, i) => `候选 ${i + 1} → ${l}`).join('\n\n');
  box.style.display = 'block';
}
bind('promoPreview', previewPromo);
bind('promoReset', () => {
  ['promoCustomTapeOut', 'promoCustomBEM'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  grokStatus('自定义话术已清空，恢复内置话术（记得点「保存设置」）。', true);
});

/* 1.4.2 文案精简：长说明收进一个简洁弹窗，设置页只留一句结论。 */
const INFO = {
  modes: {
    title: '运行模式',
    lines: [
      '自动（推荐）：在 X 页面直连 Grok，免 Key、免费。',
      '站内直连：同自动，但失败时直接报错不降级。',
      '页面模式：旧 DOM 链路，仅作手动兜底。',
      'xAI API：填自己的 Key，按量计费。',
      'DeepSeek API：填自己的 Key，走 api.deepseek.com，按量计费。',
      'API 模式只请求你选的那家服务商，不经开发者服务器。'
    ]
  },
  usage: {
    title: '使用说明',
    lines: [
      '一键转发：内容右上角点按钮，整理正文与配图成 X 草稿。',
      'AI 评论：先点推文「回复」，按钮在填写区上方右侧，不压住正文。',
      '选中候选会写回回复框，最后一步仍由你手动点「回复」。',
      '多图弹托盘：逐张复制、拼长图或下载到临时目录。',
      '所有站点的每张图片都逐张在本机去水印（右下角 / 中间 / 顶部全图检测），只改水印像素；未检出的图原像素不动。',
      '4K 输出：逐张高保真放大到长边 3840、PNG 无损；原图已达 4K 则保持原尺寸，全程不上传图片。',
      '生态面板：295 条内置清单核验链接，以本地结论为准。',
      'X 改版导致按钮不出现时，可填「回复框选择器」。'
    ]
  },
  promo: {
    title: '评论末尾推广',
    lines: [
      '两种用法，互不依赖：T 按钮（默认开）与 AI 候选自动附加（默认关）。',
      '全页只出现一个 T 按钮，跟着你正在编辑的回复框走；多个回复框时先点进要写的那个。',
      '自己写完评论后点一下 T，随机带入一句推广；再点换一句，不会重复也不会叠加。',
      '右键点 T 可去掉末尾推广句，只留你自己写的正文；手工删掉后再点会重新带入。',
      '按钮不再压在正文上；每次写回后自动把选区收成光标，不留灰色选中块。',
      '正文里已经有两句以上推广句时会停手，只提示、不继续叠加；右键 T 仍可去掉末尾那句。',
      '写回只做一次「全量替换」（等价于自己全选后重打一遍），不再用局部选区删改：这就是之前文字重复、回复框不可编辑的根因。',
      '正文里有 @ / 表情 / 配图时自动降级为只复制，绝不弄丢它们；也可手动开「安全模式」让 T 永远只复制。',
      'AI 评论默认走快速模式：不思考、不并排生成、拿到答案即收尾，通常 5~15 秒。',
      '如果推广句被你手动改过，插件会停止写入并复制新句，绝不弄乱正文。',
      '写入后会校验结果；异常时自动恢复原文并把推广句复制到剪贴板，绝不重试。',
      'AI 候选则是 3 条各随机附一句，候选面板可「🎲 换一批」。',
      '可自定义话术：每行一句，按 TapeOut / $BEM 分开填。',
      '内置话术只讲生态与技术，不提价格、收益或买入建议。'
    ]
  },
  tmp: {
    title: '临时文件',
    lines: [
      '图片默认走剪贴板，转发不再自动落盘。',
      '视频只能拖入 X，会存到下载目录的 TapePost_tmp/ 子目录。',
      '托盘「下载到临时目录」也是同一位置，用完可点「🧹 清理」。',
      '按保留时长自动删除文件与下载记录，默认 30 分钟。',
      '扩展启动、新下载、打开设置时都会顺带清一次。',
      '选「不自动清理」时，请手动点「立即清理临时文件」。'
    ]
  },
  privacy: {
    title: '隐私说明',
    lines: [
      '转发全链路本机完成：不上传正文、图片或浏览记录。',
      '站内直连只把提示词发给 X/Grok，不新增第三方。',
      'API Key 存本机 chrome.storage.local，不同步、不入库。',
      '只有 API 模式才由后台直连 xAI / DeepSeek，费用自行承担。',
      '插件不调用任何发布接口，不替你发推或回复。'
    ]
  },
};

const infoMask = document.getElementById('infoMask');
const infoTitle = document.getElementById('infoTitle');
const infoBody = document.getElementById('infoBody');
function closeInfo() { if (infoMask) infoMask.hidden = true; }
function openInfo(key) {
  const d = INFO[key];
  if (!d || !infoMask || !infoBody || !infoTitle) return;
  infoTitle.textContent = d.title;
  infoBody.replaceChildren();
  d.lines.forEach(function (line) {
    const p = document.createElement('p');
    p.textContent = '· ' + line;
    infoBody.appendChild(p);
  });
  infoMask.hidden = false;
}
document.querySelectorAll('[data-info]').forEach(function (btn) {
  btn.addEventListener('click', function () { openInfo(btn.getAttribute('data-info')); });
});
bind('infoClose', closeInfo);
bind('infoOk', closeInfo);

// 1.4.3：临时文件状态与立即清理
// 1.4.4：状态直接读 storage.local —— popup 打开时不再发 runtime 消息，
// 避免弹窗被快速关闭时留下 "message port closed before a response" 错误。
function refreshTmpStatus() {
  const el = document.getElementById('tmpStatus');
  if (!el) return;
  const fallback = () => { el.textContent = '临时文件：状态不可用'; };
  try {
    if (!chrome.storage || !chrome.storage.local) return fallback();
    chrome.storage.local.get('tapeTmpDownloads', (o) => {
      const err = chrome.runtime && chrome.runtime.lastError;
      if (err) return fallback();
      const list = (o && Array.isArray(o.tapeTmpDownloads)) ? o.tapeTmpDownloads : [];
      el.textContent = `当前记录 ${list.length} 个临时文件（到期自动清理）`;
    });
  } catch (e) { fallback(); }
}
bind('tmpCleanNow', () => {
  sendBg({ type: 'TMP_CLEAN' }, (r, err) => {
    const el = document.getElementById('tmpStatus');
    if (el) el.textContent = (!err && r && r.ok)
      ? `已清理 ${r.removed || 0} 个文件，剩 ${r.remaining || 0} 个`
      : '清理失败，请重试';
  });
});
if (infoMask) infoMask.addEventListener('click', function (e) {
  if (e.target === infoMask) closeInfo();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeInfo();
});

load();
refreshTmpStatus();

/* =====================================================================
 * 1.4.13：面板顶端行情卡片 + 价格上下限提醒设置
 * 价格抓取 / 判定 / 通知全在后台，popup 只负责展示与读写设置，
 * 这样关掉弹窗也不会影响后台定时提醒。
 * ===================================================================== */
const PRICE_SET_KEY = 'priceSettings';
const PRICE_BOUND_IDS = {
  up:    { min: 'priceUpMin',    max: 'priceUpMax' },
  miner: { min: 'priceMinerMin', max: 'priceMinerMax' },
  bem:   { min: 'priceBemMin',   max: 'priceBemMax' }
};
const priceApi = (typeof TapePrice !== 'undefined') ? TapePrice : null;
const priceEl = (id) => document.getElementById(id);
const priceText = (id, v) => { const el = priceEl(id); if (el) el.textContent = v; };
const priceField = (id) => { const el = priceEl(id); return el ? String(el.value || '').trim() : ''; };
const priceCap = (k) => k.charAt(0).toUpperCase() + k.slice(1);

function priceStatus(text, good) {
  const el = priceEl('priceStatus');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = good === false ? '#b91c1c' : (good === true ? '#15803d' : '#999');
}

/* 1.4.26：界面只留数字、两行排布，来源标注 / 版本说明 / 明细行 / 采集明细都不显示。
 * 1.5.16：TapeUP 网页采集已下线，UP 内盘价不再更新；矿机日产与 BEM 仍取 Firsto。 */
function priceClock(iso) {
  const t = Date.parse(iso);
  return isNaN(t) ? ''
    : new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/* K 线动态价是 8 位定点小数（0.31542257），不能按 2~4 位美元价四舍五入 */
function priceUsdFull(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!isFinite(n)) return null;
  return '$' + n.toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

function renderPriceSnapshot(snap) {
  if (!priceApi || !snap || !snap.items) {
    priceText('priceUpdated', '暂无数据');
    return;
  }
  priceApi.KEYS.forEach((k) => {
    const item = snap.items[k] || {};
    const C = priceCap(k);
    const vEl = priceEl('priceValue' + C);
    const uEl = priceEl('priceUnit' + C);
    const sEl = priceEl('priceSub' + C);
    const cEl = priceEl('priceChange' + C);
    const hasVal = item.value != null;

    let mainText, unitText;
    if (k === 'up') {
      const live = (item.livePrice != null) ? item.livePrice : item.usdValue;
      const usdMain = priceUsdFull(live);
      mainText = usdMain || priceApi.format(k, item.value);
      unitText = '';
      /* 1.4.30：主值（左边大字）已经是 K 线动态价 / 页头折算价，右边副行
       * 不再重复那个美元价，只留 BEM/UP 计价与涨跌：
       * $0.31542257  0.0254 BEM/UP · +19.25%，涨跌仍按涨红跌绿着色。
       * 用对象数组标记涨跌项，避免删掉一段后靠固定下标着色出错。 */
      const parts = [];
      // 主值偶尔会退回 BEM/UP 原值（美元价没采到），这时副行只补单位，不再重复数字
      if (hasVal) parts.push({ text: usdMain
        ? priceApi.format(k, item.value) + ' BEM/UP' : 'BEM/UP' });
      if (item.changePct != null) parts.push({ text: priceApi.formatChange(item.changePct), chg: true });
      if (sEl) {
        if (!parts.length) {
          sEl.textContent = '';
          sEl.style.display = 'none';
        } else {
          const chgCls = priceApi.isUp(item.changePct) ? 'up'
            : (priceApi.isDown(item.changePct) ? 'down' : '');
          sEl.innerHTML = parts.map((p) =>
            (p.chg && chgCls)
              ? '<b class="chg ' + chgCls + '">' + p.text + '</b>' : p.text
          ).join(' · ');
          sEl.style.display = '';
        }
      }
    } else {
      mainText = priceApi.format(k, item.value);
      unitText = (k === 'miner') ? 'BNB' : '';
    }
    if (vEl) {
      vEl.textContent = mainText;
      vEl.title = hasVal ? '原始值 ' + item.value : '暂无采集';
    }
    if (uEl) uEl.textContent = unitText;

    /* 1.4.26 / 1.4.30：UP 的涨跌已在行内副串里（带颜色），徽标只在缓存时提示；
     * 矿机的「挂单参考价」属口径说明，不再占并排卡片的宽度。 */
    let badge = (item.changePct != null) ? priceApi.formatChange(item.changePct) : '';
    if (k === 'up') badge = '';
    if (item.stale) badge = badge ? badge + ' · 缓存' : '缓存';
    if (!hasVal && k !== 'up') badge = badge ? badge + ' · 未采集' : '未采集';
    if (cEl) {
      cEl.textContent = badge;
      cEl.className = 'pc-badge' + (priceApi.isUp(item.changePct) ? ' up'
        : (priceApi.isDown(item.changePct) ? ' down' : ''));
      cEl.title = '涨＝红、跌＝绿';
    }
  });

  const t = Date.parse(snap.updatedAt);
  const up = priceEl('priceUpdated');
  priceText('priceUpdated', isNaN(t) ? '' : '更新 ' + priceClock(snap.updatedAt));
  if (up) up.title = (snap.errors && snap.errors.length) ? snap.errors.join('；') : '点 ↻ 立即刷新';
}

function loadPrices(force) {
  if (!priceApi) {
    priceText('priceUpdated', '行情模块未加载');
    return;
  }
  priceText('priceUpdated', force ? '刷新中…' : '读取中…');
  sendBg({ type: force ? 'PRICE_REFRESH' : 'PRICE_GET' }, (r, err) => {
    if (err || !r || !r.ok) {
      priceText('priceUpdated', '读取失败');
      priceStatus('行情读取失败：请到 chrome://extensions 重新加载扩展。', false);
      return;
    }
    renderPriceSnapshot(r.snapshot);
  });
}

function fillPriceSettings(raw) {
  if (!priceApi) return;
  const s = priceApi.normalizeSettings(raw);
  const set = (id, v) => { const el = priceEl(id); if (el) el.value = v; };
  const chk = (id, v) => { const el = priceEl(id); if (el) el.checked = !!v; };
  chk('priceEnabled', s.enabled);
  chk('priceToast', s.toast);
  chk('priceNotify', s.notify);
  set('pricePollMinutes', String(s.pollMinutes));
  set('priceCooldownMinutes', String(s.cooldownMinutes));
  priceApi.KEYS.forEach((k) => {
    const b = s.bounds[k] || {};
    set(PRICE_BOUND_IDS[k].min, b.min || '');
    set(PRICE_BOUND_IDS[k].max, b.max || '');
  });
}

function collectPriceSettings() {
  const bounds = {};
  priceApi.KEYS.forEach((k) => {
    bounds[k] = { min: priceField(PRICE_BOUND_IDS[k].min), max: priceField(PRICE_BOUND_IDS[k].max) };
  });
  return priceApi.normalizeSettings({
    enabled: !!(priceEl('priceEnabled') || {}).checked,
    toast: !!(priceEl('priceToast') || {}).checked,
    notify: !!(priceEl('priceNotify') || {}).checked,
    pollMinutes: Number(priceField('pricePollMinutes') || 5),
    cooldownMinutes: Number(priceField('priceCooldownMinutes') || 30),
    bounds: bounds
  });
}

function savePriceSettings() {
  if (!priceApi) return;
  const cfg = collectPriceSettings();
  const payload = {}; payload[PRICE_SET_KEY] = cfg;
  try {
    chrome.storage.sync.set(payload, () => {
      const er = chrome.runtime && chrome.runtime.lastError; // 同步读取，避免 Unchecked lastError
      if (er) { priceStatus('保存失败：' + er.message, false); return; }
      // 后台清空状态机并按新的检查间隔重注册闹钟
      sendBg({ type: 'PRICE_SETTINGS' }, () => {});
      priceStatus('已保存 ✓ 阈值立即生效，后台按新间隔检查。', true);
      setTimeout(() => priceStatus(''), 3500);
    });
  } catch (e) { priceStatus('保存失败：' + String(e && e.message || e), false); }
}

if (priceApi) {
  bind('priceSave', savePriceSettings);
  bind('priceRefresh', () => loadPrices(true));
  bind('priceTest', () => {
    sendBg({ type: 'PRICE_TEST_ALERT' }, (r, err) => {
      priceStatus(err ? '测试失败：连不上后台，请重新加载扩展。'
        : '已发送测试提醒：看网页右下角浮层 / 系统通知。', !err);
    });
  });
  document.querySelectorAll('[data-price-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-price-key');
      try { chrome.tabs.create({ url: priceApi.linkFor(key), active: true }); }
      catch (e) { priceStatus('打开交易所失败：' + String(e && e.message || e), false); }
    });
  });
  try {
    chrome.storage.sync.get(PRICE_SET_KEY, (o) => {
      void (chrome.runtime && chrome.runtime.lastError);
      fillPriceSettings(o && o[PRICE_SET_KEY]);
    });
  } catch (e) { /* 存储不可用时用默认设置 */ }
  loadPrices(false);
}

/* 1.4.19：标题旁的版本号以 manifest 为准，升版本时不会漏改静态文案。
 * HTML 里已写死 v1.5.16 作兜底，即使这段没跑到也不会空白。 */
(function showAppVersion() {
  try {
    const v = chrome.runtime.getManifest && chrome.runtime.getManifest().version;
    const n = document.getElementById('appVersion');
    if (v && n) n.textContent = 'v' + v;
  } catch (e) {}
})();

/* =====================================================================
 * 1.5.5：钱包 / TapeOut API 资产 / BEM 信仰者投票
 * popup 只做展示与按钮，抓取、加密、缓存、提醒全在后台，
 * 钱包地址明文不进入 popup（只回传遮罩后的 0x1234…abcd）。
 * ===================================================================== */
const wbxEl = (id) => document.getElementById(id);
const wbxText = (id, v) => { const e = wbxEl(id); if (e) e.textContent = v; };
const wbxVal = (id) => { const e = wbxEl(id); return e ? String(e.value || '').trim() : ''; };
const voteApi = (typeof Vote !== 'undefined') ? Vote : null;
const assetsApi = (typeof TapeOutAPI !== 'undefined') ? TapeOutAPI : null;
let voteSummary = null;
let walletProviders = [];

function wbxStatus(id, msg, bad) {
  const e = wbxEl(id);
  if (!e) return;
  e.textContent = msg || '';
  e.className = (id === 'walletStatus' ? 'wallet-status' : 'vote-status') + (bad ? ' err' : '');
}

/* ---------- 投票（1.5.6 钱包门槛 + 名片；1.5.7 名片随时可改可存并同步上墙） ---------- */
let currentAvatarId = 'a01';
let currentPostUrl = '';

function renderAvatarChip(id) {
  const a = (typeof BemAvatars !== 'undefined')
    ? BemAvatars.get(id) : { id: 'a01', e: '🦊', c: '#ffe3d2' };
  currentAvatarId = a.id;
  const chip = wbxEl('voteAvatarChip');
  if (chip) { chip.textContent = a.e; chip.style.background = a.c; }
  const grid = wbxEl('voteAvatarGrid');
  if (grid) Array.prototype.forEach.call(grid.children, (c) => {
    c.className = (c.dataset && c.dataset.avatar === a.id) ? 'on' : '';
  });
}
function buildAvatarGrid() {
  const grid = wbxEl('voteAvatarGrid');
  if (!grid || typeof BemAvatars === 'undefined') return;
  grid.textContent = '';
  BemAvatars.all().forEach((a) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = a.e;
    b.title = '头像 ' + a.id;
    b.dataset.avatar = a.id;
    b.style.background = a.c;
    b.addEventListener('click', () => { renderAvatarChip(a.id); saveProfile(); });
    grid.appendChild(b);
  });
}
function renderQuote(sum) {
  const box = wbxEl('voteQuoteBox');
  if (!box) return;
  const show = !!(sum.quote && sum.myStance === 'support');
  box.hidden = !show;
  currentPostUrl = show ? (sum.postUrl || '') : '';
  if (show) wbxText('voteQuoteText', '「' + sum.quote + '」');
}
function renderVote(sum) {
  if (!voteApi || !sum) return;
  voteSummary = sum;
  const src = wbxEl('voteSource');
  if (src) { src.textContent = sum.source === 'network' ? '全网' : '本机'; src.className = sum.source === 'network' ? '' : 'local'; }
  const remind = wbxEl('voteRemind');
  if (remind) {
    remind.className = 'vote-remind' + (sum.checkedIn ? ' done' : '');
    remind.textContent = sum.checkedIn
      ? '今日已打卡 ✓ 明天记得再来为 BEM 站台'
      : '今天还没打卡 · 点一下为 BEM 站台';
  }
  // 钱包是打卡前置条件，由后台判定；未连接时按钮禁用并给出引导
  const gate = wbxEl('voteGate');
  if (gate) gate.hidden = !!sum.walletBound;
  const sBtn = wbxEl('voteSupport'), wBtn = wbxEl('voteWatch');
  if (sBtn) { sBtn.className = sum.myStance === 'support' ? 'active' : ''; sBtn.disabled = !sum.walletBound; }
  if (wBtn) { wBtn.className = sum.myStance === 'watch' ? 'active' : ''; wBtn.disabled = !sum.walletBound; }
  // 名片
  const prof = sum.profile || { name: '', avatar: 'a01' };
  const nameEl = wbxEl('voteName');
  if (nameEl && document.activeElement !== nameEl) nameEl.value = prof.name || '';
  renderAvatarChip(prof.avatar);
  renderQuote(sum);
  wbxText('voteTodaySupport', sum.todayCount.support);
  wbxText('voteTotalVotes', sum.total.total);
  wbxText('voteStreak', sum.streak);

  const trend = wbxEl('voteTrend');
  if (trend) {
    trend.textContent = '';
    const max = Math.max(1, ...sum.trend.map((d) => d.total));
    sum.trend.forEach((d) => {
      const bar = document.createElement('i');
      const fill = document.createElement('u');
      fill.style.height = Math.max(2, Math.round(d.total / max * 24)) + 'px';
      bar.appendChild(fill);
      bar.title = d.day + '：支持 ' + d.support + ' · 观望 ' + d.watch;
      trend.appendChild(bar);
    });
  }
  const wallN = Array.isArray(sum.supporters) ? sum.supporters.length : 0;
  wbxStatus('voteStatus',
    (sum.source === 'network' ? '全网账本已同步' : '当前为本机账本（未联到全网账本）') +
    (sum.pending ? ' · 待补投 ' + sum.pending + ' 票' : '') +
    (wallN ? ' · 今日 ' + wallN + ' 位信仰者上墙' : '') +
    ' · 北京时间按天累计');
  const foot = wbxEl('bemFoot');
  if (foot) foot.textContent = '🔥 今日 ' + sum.todayCount.support + ' 票支持 · 连续 ' + sum.streak +
    ' 天 · ' + (sum.source === 'network' ? '全网' : '本机');
  const cfg = sum.config || voteApi.normalizeConfig(null);
  const baseEl = wbxEl('voteLedgerBase');
  if (baseEl && document.activeElement !== baseEl) baseEl.value = cfg.ledgerBase;
  const en = wbxEl('voteReminderEnabled'); if (en) en.checked = cfg.reminderEnabled;
  const hr = wbxEl('voteReminderHour'); if (hr) hr.value = String(cfg.reminderHour);
}

/* 1.5.7：名片随时可改可存。
 * 保存后必须 renderVote 回显（后台会清洗昵称、补全默认名），并刷新「发布到 X」的预填文案；
 * 当天已投支持票时，后台 VOTE_PROFILE 会顺带把新名片同步到公开信仰者墙。 */
let profileSaveTimer = 0;
let lastSavedProfile = '';
function markProfileHint(msg, kind) {
  const h = wbxEl('voteProfileHint');
  if (!h) return;
  h.textContent = msg || '';
  h.className = 'vote-profile-hint' + (kind ? ' ' + kind : '');
}
function saveProfile(opts) {
  const o = opts || {};
  clearTimeout(profileSaveTimer);
  const name = wbxVal('voteName'), avatar = currentAvatarId;
  const sig = name + '|' + avatar;
  if (o.auto && sig === lastSavedProfile) return;   // debounce 与 change 不重复提交
  lastSavedProfile = sig;
  if (!o.auto) markProfileHint('正在保存名片…', '');
  sendBg({ type: 'VOTE_PROFILE', name: name, avatar: avatar }, (r, err) => {
    if (err || !r || !r.ok) {
      lastSavedProfile = '';   // 允许重试
      markProfileHint('保存失败：' + String((r && r.error) || (err && err.message) || '后台无响应'), 'dirty');
      wbxStatus('voteStatus', '名片保存失败，请重试。', true);
      return;
    }
    renderVote(r.summary);      // 回显规范化后的名片 + 刷新发 X 文案
    const p = (r.summary && r.summary.profile) || { name: '', avatar: 'a01' };
    lastSavedProfile = p.name + '|' + p.avatar;
    if (r.wallUpdated) {
      markProfileHint('已保存 ✓ 今日信仰者墙上的名字与头像已同步更新', 'ok');
      wbxStatus('voteStatus', '名片已保存并同步到全网信仰者墙 ✓');
    } else if (r.wallPending) {
      markProfileHint('已存本机 ✓ 联网后自动同步到今日信仰者墙', 'ok');
      wbxStatus('voteStatus', '名片已存本机 ✓ 待联网补投到全网账本');
    } else {
      markProfileHint('已保存 ✓ ' + (r.summary && r.summary.myStance === 'support'
        ? '今日名片无需重复更新' : '下次打卡时生效（今天还没投支持票）'), 'ok');
      wbxStatus('voteStatus', '名片已保存 ✓ ' + (r.summary && r.summary.myStance === 'support'
        ? '今日已上墙' : '下次打卡生效'));
    }
  });
}
function loadVote() {
  sendBg({ type: 'VOTE_STATE' }, (r, err) => {
    if (err || !r || !r.ok) { wbxStatus('voteStatus', '账本读取失败，请重新加载扩展。', true); return; }
    renderVote(r.summary);
    const p = (r.summary && r.summary.profile) || { name: '', avatar: 'a01' };
    lastSavedProfile = p.name + '|' + p.avatar;
  });
}

function castVote(stance, quote) {
  const payload = { type: 'VOTE_CAST', stance: stance,
    name: wbxVal('voteName'), avatar: currentAvatarId };
  if (quote) payload.quote = quote;
  wbxStatus('voteStatus', '正在记票…');
  sendBg(payload, (r, err) => {
    if (err || !r || !r.ok) { wbxStatus('voteStatus', '记票失败：' + String((r && r.error) || (err && err.message) || '后台无响应'), true); return; }
    renderVote(r.summary);
    wbxStatus('voteStatus', r.summary.source === 'network'
      ? '已记入全网账本 ✓ 名片与激励话语已上墙，明天记得回来打卡'
      : '已记入本机账本 ✓ 联网后会自动连同名片补投到全网');
  });
}

function saveVoteConfig() {
  const cfg = {
    ledgerBase: wbxVal('voteLedgerBase'),
    reminderEnabled: !!(wbxEl('voteReminderEnabled') || {}).checked,
    reminderHour: Number(wbxVal('voteReminderHour') || 20)
  };
  wbxStatus('voteStatus', '保存中…');
  sendBg({ type: 'VOTE_CONFIG', config: cfg }, (r, err) => {
    if (err || !r || !r.ok) { wbxStatus('voteStatus', '保存失败：' + String((r && r.error) || '后台无响应'), true); return; }
    renderVote(r.summary);
    wbxStatus('voteStatus', '已保存 ✓ 正在重新同步账本…');
    setTimeout(() => sendBg({ type: 'VOTE_SYNC' }, (s) => { if (s && s.ok) renderVote(s.summary); }), 200);
  });
}

/* ---------- 钱包 + 资产 ---------- */
function fmtAsset(v, digits) {
  if (v == null || !isFinite(Number(v))) return '—';
  return assetsApi ? assetsApi.compact(v) : String(v);
}
const XL_IDS = ['xlMiners', 'xlActive', 'xlDaily', 'xlFab', 'xlPending', 'xlOkb'];

/* 1.5.8：X Layer / FabX PoD 分组。BSC 与 X Layer 各自独立，任一条链失败不影响另一条。 */
function renderXLayer(x) {
  if (!x || !x.ok) {
    XL_IDS.forEach((id) => wbxText(id, '—'));
    wbxText('xlayerState', '链 196 · 未读取');
    wbxText('xlayerSub', '点「↻ 读资产」拉取 X Layer：FAB 余额 / 电路矿机 / 待领 / OKB' +
      (x && x.errors && x.errors.length ? ' · ' + x.errors[0] : ''));
    return;
  }
  wbxText('xlMiners', x.miners == null ? '—' : assetsApi.fmt(x.miners, 0));
  wbxText('xlActive', x.activeMiners == null ? '—' : assetsApi.fmt(x.activeMiners, 0));
  wbxText('xlDaily', fmtAsset(x.daily));
  wbxText('xlFab', fmtAsset(x.balance));
  wbxText('xlPending', fmtAsset(x.pending));
  wbxText('xlOkb', x.okb == null ? '—' : assetsApi.fmt(x.okb, 4));
  const bits = ['FabX PoD API v1', 'X Layer RPC 链 ' + (x.chainId || 196)];
  if (x.verifiedWeight != null) {
    let w = '已验证算力 ' + assetsApi.compact(x.verifiedWeight);
    if (x.network && x.network.totalVerifWeight) {
      w += '（全网 ' + (100 * x.verifiedWeight / x.network.totalVerifWeight).toFixed(2) + '%）';
    }
    bits.push(w);
  }
  if (x.boost != null) bits.push('加成 ' + (x.boost / 10000).toFixed(2) + '×');
  if (x.registeredMiners != null && x.miners != null && x.registeredMiners !== x.miners) {
    bits.push('登记挖矿 ' + x.registeredMiners + ' 台');
  }
  if (x.block) bits.push('区块 #' + x.block);
  bits.push('日产按当前全网权重估算，仅供参考');
  if (x.errors && x.errors.length) bits.push('部分接口未响应：' + x.errors.length + ' 项');
  const src = [x.sources && x.sources.fabx ? 'FabX' : '', x.sources && x.sources.rpc ? 'RPC' : ''].filter(Boolean).join(' + ');
  wbxText('xlayerState', '链 ' + (x.chainId || 196) + ' · ' + (src || '部分数据'));
  wbxText('xlayerSub', bits.join(' · '));
}

function renderAssets(a) {
  if (!a) {
    ['assetMiners', 'assetDaily', 'assetBem', 'assetClaimed', 'assetBnb', 'assetValue']
      .forEach((id) => wbxText(id, '—'));
    wbxText('bscChainState', '链 56');
    wbxText('walletSub', '连接钱包后自动读取 BSC：矿机 / 预估日产 / 持仓 / 已领取 / BNB / 市值');
    renderXLayer(null);
    return;
  }
  const c = a.circuits || {}, bem = a.bem || {}, bnb = a.bnb || {}, tr = a.transistors || {};
  wbxText('assetMiners', c.count == null ? '—' : assetsApi.fmt(c.count, 0));
  wbxText('assetDaily', fmtAsset(bem.daily));
  wbxText('assetBem', fmtAsset(bem.balance));
  wbxText('assetClaimed', fmtAsset(bem.claimedTotal));
  wbxText('assetBnb', bnb.balance == null ? '—' : assetsApi.fmt(bnb.balance, 4));
  wbxText('assetValue', fmtAsset(c.marketValueBnb));
  const v = a.versions || {};
  const bits = ['BSC · TapeOut API v1', 'TapeAPI ' + (v.tapeapi || '3.0.0')];
  if (v.chainSigned) bits.push('链上签名读取（未本机验签）');
  if (tr.nand != null || tr.latch != null) {
    bits.push('NAND ' + assetsApi.fmt(tr.nand, 0) + ' / LATCH ' + assetsApi.fmt(tr.latch, 0));
  }
  if (bem.balanceUsd != null) bits.push('持仓约 $' + assetsApi.fmt(bem.balanceUsd, 2));
  const bscErr = (a.errors || []).filter((e) => !/^xlayer/i.test(String(e))).length;
  if (bscErr) bits.push('部分接口未响应：' + bscErr + ' 项');
  wbxText('walletSub', bits.join(' · '));
  renderXLayer(a.xlayer);
}

function renderWallet(r) {
  if (!r || !r.ok) return;
  const st = wbxEl('walletState');
  if (st) { st.textContent = r.bound ? '已连接（只读）' : '未连接'; st.className = r.bound ? 'on' : ''; }
  wbxText('walletAddr', r.bound
    ? r.mask + (r.providerName ? ' · ' + r.providerName : '') + (r.chainId ? ' · 链 ' + r.chainId : '')
    : '未绑定地址 · 只读，不要私钥、不签名、不转账');
  renderAssets(r.assets);
  if (r.assetsError) wbxStatus('walletStatus', r.assetsError, true);
  else if (r.bound && r.assets) wbxStatus('walletStatus', '资产更新 ' + String(r.assets.asOf || '').slice(11, 19) + ' UTC · 仅本机展示');
}

function loadWallet(force) {
  sendBg({ type: force ? 'ASSETS_GET' : 'WALLET_STATUS', force: !!force }, (r, err) => {
    if (err || !r || !r.ok) {
      wbxStatus('walletStatus', '读取失败：请到 chrome://extensions 重新加载扩展。', true);
      return;
    }
    if (force) {
      if (r.assets) renderAssets(r.assets);
      wbxStatus('walletStatus', r.error ? ('部分数据未取到：' + r.error) : '已刷新 BSC + X Layer 双链资产 ✓');
    } else renderWallet(r);
  });
}

function showProviders(list, note) {
  const box = wbxEl('walletProviders');
  if (!box) return;
  box.textContent = '';
  walletProviders = Array.isArray(list) ? list : [];
  if (!walletProviders.length) {
    const span = document.createElement('span');
    span.className = 'hint';
    span.textContent = note || '未检测到注入式钱包';
    box.appendChild(span);
    return;
  }
  walletProviders.forEach((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = p.name || p.id;
    b.title = '用 ' + (p.name || p.id) + ' 读取公开地址（只读）';
    b.addEventListener('click', () => connectWith(p.id));
    box.appendChild(b);
  });
}

function connectWith(providerId) {
  wbxStatus('walletStatus', '正在向钱包请求公开地址…');
  sendBg({ type: 'WALLET_CONNECT', providerId: providerId || '' }, (r, err) => {
    if (err || !r || !r.ok) {
      wbxStatus('walletStatus', '连接失败：' + String((r && r.error) || (err && err.message) || '无响应') +
        '。可在下方手动填地址。', true);
      return;
    }
    renderWallet(r);
    wbxStatus('walletStatus', '已连接 ✓ 地址加密存本机，只读资产');
    loadVote();   // 钱包门槛状态变化，刷新「支持 / 观望」按钮
  });
}

function connectWallet() {
  wbxStatus('walletStatus', '正在探测已安装钱包…');
  sendBg({ type: 'WALLET_PROVIDERS' }, (r, err) => {
    if (err || !r || !r.ok) { wbxStatus('walletStatus', '探测失败，请手动填地址。', true); return; }
    const list = r.providers || [];
    showProviders(list, r.note || '未检测到注入式钱包，可手动填地址');
    if (list.length === 1) connectWith(list[0].id);
    else if (list.length > 1) wbxStatus('walletStatus', '检测到 ' + list.length + ' 个钱包，点上面的名称选一个连接');
    else wbxStatus('walletStatus', '没检测到注入式钱包（OKX / 币安 / TP / MetaMask），可在下方手动填地址');
  });
}

if (voteApi) {
  buildAvatarGrid();
  bind('voteSupport', () => castVote('support'));
  bind('voteWatch', () => castVote('watch'));
  bind('voteSaveCfg', saveVoteConfig);
  bind('voteSync', () => {
    wbxStatus('voteStatus', '同步中…');
    sendBg({ type: 'VOTE_SYNC' }, (r) => {
      if (r && r.ok) { renderVote(r.summary); wbxStatus('voteStatus', '同步完成 ✓'); }
      else wbxStatus('voteStatus', '同步失败，已保留本机账本。', true);
    });
  });
  bind('voteOpen', () => {
    const url = (voteSummary && voteSummary.publicPage) || voteApi.publicPage(voteApi.DEFAULT_LEDGER);
    try { chrome.tabs.create({ url: url, active: true }); } catch (e) {}
  });
  bind('voteProfileSave', () => saveProfile());
  bind('voteAvatarToggle', () => {
    const g = wbxEl('voteAvatarGrid');
    if (!g) return;
    g.hidden = !g.hidden;
    const b = wbxEl('voteAvatarToggle');
    if (b) b.title = g.hidden ? '选择内置头像' : '收起头像库';
  });
  const nameEl = wbxEl('voteName');
  if (nameEl) {
    // 输入停顿 650ms 自动保存；change / Enter / 💾 立即保存
    nameEl.addEventListener('input', () => {
      markProfileHint('有改动 · 停止输入后自动保存', 'dirty');
      clearTimeout(profileSaveTimer);
      profileSaveTimer = setTimeout(() => saveProfile({ auto: true }), 650);
    });
    nameEl.addEventListener('change', () => saveProfile({ auto: true }));
    nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); saveProfile(); }
    });
  }
  bind('voteQuoteReroll', () => {
    if (typeof BemQuotes === 'undefined') return;
    const q = BemQuotes.pick();
    const sum = voteSummary || {};
    const page = sum.publicPage || voteApi.publicPage(voteApi.DEFAULT_LEDGER);
    const name = wbxVal('voteName') || (sum.profile && sum.profile.name) || 'BEM 信仰者';
    const text = voteApi.tweetText(q, name, sum.today || voteApi.dayKey(), voteApi.beijingClock(), page);
    currentPostUrl = voteApi.postUrl(text);
    wbxText('voteQuoteText', '「' + q + '」');
    // 重新投一次同一立场：服务端按当日身份哈希去重，只会更新名片与话语
    castVote(sum.myStance || 'support', q);
  });
  bind('votePostX', () => {
    if (!currentPostUrl) { wbxStatus('voteStatus', '先打卡支持，才会生成可发布的话语。', true); return; }
    try { chrome.tabs.create({ url: currentPostUrl, active: true }); } catch (e) {}
  });
  loadVote();
}

if (assetsApi) {
  bind('walletConnect', connectWallet);
  bind('walletRefresh', () => loadWallet(true));
  bind('walletClear', () => {
    sendBg({ type: 'WALLET_CLEAR' }, (r) => {
      if (r && r.ok) {
        renderWallet({ ok: true, bound: false });
        showProviders([]);
        wbxStatus('walletStatus', '已断开并删除本机加密地址 ✓');
        loadVote();
      }
    });
  });
  bind('walletManualSave', () => {
    const addr = wbxVal('walletManualAddr');
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { wbxStatus('walletStatus', '地址格式不对：要 0x 开头 + 40 位十六进制。', true); return; }
    wbxStatus('walletStatus', '保存中…');
    sendBg({ type: 'WALLET_MANUAL', address: addr }, (r, err) => {
      if (err || !r || !r.ok) { wbxStatus('walletStatus', '保存失败：' + String((r && r.error) || '后台无响应'), true); return; }
      renderWallet(r);
      wbxStatus('walletStatus', '已加密保存 ✓ 正在读取资产…');
      loadVote();
    });
  });
  loadWallet(false);
}
