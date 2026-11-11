'use strict';

const ACCOUNT = (typeof X_ACCOUNT !== 'undefined') ? X_ACCOUNT : {
  name: '昆哥', handle: 'YikunChen1983', url: 'https://x.com/YikunChen1983',
  community: 'TapeOut社区成员：昆哥'
};

// 已取消「需去水印作者 UID」列表；图片/视频都改由全局开关控制。
// 换用新 key，让旧版保存的 alwaysInpaint / watermarkUids 自动失效，避免旧设置盖掉新默认值。
const PAGE_DEFAULTS = (typeof TapeAI !== 'undefined' && TapeAI.PAGE_MODE_DEFAULTS)
  ? TapeAI.PAGE_MODE_DEFAULTS : {};

const DEFAULTS = Object.assign({
  inpaintImages: true,
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
  grokFastMode: true             // AI 评论非思考快速模式
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
  grokTemperature: 0.7
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
function sendBg(msg, cb) {
  const done = (typeof cb === 'function') ? cb : function () {};
  try {
    chrome.runtime.sendMessage(msg, function (resp) {
      const err = chrome.runtime && chrome.runtime.lastError; // 必须同步读取
      try { done(resp || null, err || null); } catch (e) {}
    });
  } catch (e) {
    try { done(null, e); } catch (e2) {}
  }
}

function renderAccount() {
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  set('meAvatar', (ACCOUNT.name || '昆').slice(0, 1));
  set('meName', ACCOUNT.name);
  set('meHandle', '@' + ACCOUNT.handle);
  // 社区身份标注：只展示在设置面板，不追加到转发正文（不影响已验证的清洗结果）
  const badge = document.getElementById('meBadge');
  if (badge) {
    const label = ACCOUNT.community || '';
    badge.textContent = label;
    badge.hidden = !label;
  }
  const link = document.getElementById('meLink');
  if (link) {
    link.href = ACCOUNT.url;
    link.textContent = ACCOUNT.url.replace(/^https?:\/\//, '') + ' ↗';
  }
  const copy = document.getElementById('copyLink');
  if (copy) {
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(ACCOUNT.url);
        copy.textContent = '已复制 ✓';
        setTimeout(() => { copy.textContent = '复制主页链接'; }, 1500);
      } catch (e) {
        copy.textContent = '复制失败，请手动复制';
        setTimeout(() => { copy.textContent = '复制主页链接'; }, 1800);
      }
    });
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
    grokTemperature: 0.7
  };
}

function saveGrokSecrets() {
  return new Promise((resolve) => {
    const secrets = readGrokSecrets();
    try { chrome.storage.local.set(secrets, () => resolve(secrets)); }
    catch (e) { resolve(secrets); }
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
  });
}

function save() {
  const data = {
    hashMode: document.getElementById('hash').value,
    inpaintImages: document.getElementById('imgWm').checked,
    inpaintVideo: document.getElementById('videoWm').checked,
    appendSignature: document.getElementById('sig').checked,
    appendSource: !!(document.getElementById('source') || {}).checked,
    autoDownloadBackup: !!(document.getElementById('tmpAutoDownload') || {}).checked,
    tmpCleanup: !!(document.getElementById('tmpCleanup') || {}).checked,
    tmpKeepMinutes: Number((document.getElementById('tmpKeepMinutes') || {}).value || 0),
    enableAiComment: !!(document.getElementById('aiComment') || {}).checked,
    // 1.4.11：AI 快速模式 / T 安全模式
    grokFastMode: (document.getElementById('grokFastMode') || { checked: true }).checked !== false,
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
  grokStatus('正在连接 Grok…', true);
  saveGrokSecrets().then(() => {
    try {
      sendBg({ type: 'GROK_TEST' }, (r, err) => {
        if (err) return grokStatus('连不上后台：' + err.message + '（请到 chrome://extensions 重新加载扩展）', false);
        if (!r || !r.ok) return grokStatus('连接失败：' + ((r && r.error) || '后台没有返回结果'), false);
        const modeText = r.mode === 'page' ? 'X 站内 Grok（免 API Key）' : 'xAI API';
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
  const native = mode === 'native' || (mode === 'auto' && (document.getElementById('grokPreferNative') || {}).checked !== false);
  const samplePost = '（示例推文）TapeOut 生态又多了一个链上应用，DeWeb 容器索引突破 200 个。';
  // 1.4.18：站内直连的 AI 评论走 XVM 式极简模板，预览必须与实际发送一致
  const comment = native
    ? TapeAI.buildNativeCommentPrompt(samplePost, val('commentPrompt'), extra)
    : TapeAI.buildPagePrompt(
        TapeAI.buildCommentMessages(samplePost, val('commentPrompt')), extra);
  const buildVerify = (messages, kind) => native
    ? TapeAI.buildNativePrompt(messages, kind, extra)
    : TapeAI.buildPagePrompt(messages, extra);
  const verify = buildVerify(
    TapeAI.buildVerifyMessages('https://tapeout.net/', val('verifyPrompt')), 'verify');
  box.style.display = 'block';
  box.textContent = '【AI 评论 · 实际发送内容】\n' + comment +
    '\n\n────────────────────\n\n【链接核验 · 实际发送内容】\n' +
    verify.slice(0, 1600) + (verify.length > 1600 ? '\n…（清单摘要较长，此处省略）' : '');
  grokStatus('已生成预览：这就是' + (native ? '站内直连' : '页面模式') +
    '下实际发给 Grok 的完整文本（用示例内容拼装，不会真的发送）。', true);
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
  const base = (document.getElementById('grokBaseUrl') || {}).value || GROK_SECRET_DEFAULTS.grokBaseUrl;
  let origin;
  try { origin = new URL(String(base).trim()).origin; }
  catch (e) { grokStatus('接口地址不是合法 URL，请检查后再点。', false); return; }
  if (!chrome.permissions || !chrome.permissions.request) {
    grokStatus('当前 Chrome 不支持动态权限申请；请用默认 api.x.ai，或让网关允许跨域。', false);
    return;
  }
  chrome.permissions.request({ origins: [origin + '/*'] }, (granted) => {
    grokStatus(granted ? '✅ 已允许访问 ' + origin + '，可以点「测试连接」了。'
      : '没有授予 ' + origin + ' 的访问权限；可继续用默认 api.x.ai。', !!granted);
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

renderAccount();
const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
bind('save', save);
bind('check', runDiagnostics);
bind('openPanel', () => {
  try { chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') }); }
  catch (e) { grokStatus('打开生态面板失败：' + String(e && e.message || e), false); }
});
bind('testGrok', testGrok);
bind('resetGrokTab', resetGrokTab);
bind('grantOrigin', grantOrigin);
bind('showKey', () => {
  const k = document.getElementById('grokKey');
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
  versions: {
    title: '版本说明',
    lines: [
      'v1.4.18 修复 AI 评论「I can\'t follow that format or role」：站内直连提示词对齐 X Viral Monitor v1.18.17 的极简模板（推文原文 + 一句「写 3 条回复、每条用代码块包裹」），去掉角色扮演、system 指令、任务标记包裹与自相矛盾的「严格返回 JSON 数组 / 只输出 3 个代码块」双重要求；解析层加代码块 → 编号列表 → 段落三段兜底，1~3 条都算成功，并过滤 Grok 拒答/元话语；设置里的旧默认提示词自动升级，预览与实际发送保持一致。',
      'v1.4.17 修正 TapeUP 内盘价抽取：tapeup.io 内盘是 UP/BEM 计价（非此前误以为的 UP/USDT），重写抽取逻辑——盘面实时价以「数字 BEM」呈现、钱包余额则是「$BEM 数字」（顺序相反），据此精准区分并排除钱包余额与交易记录干扰；Cloudflare 防护仍使后台无法直接抓，由扩展在你打开交易页时读取并缓存。',
      'v1.4.15 修好 AI 评论「原文：Thinking about your request」：思考帧不再冒充回答、等得到 final 帧、请求体对齐 XVM；解析失败给帧级诊断而非甩锅模型。',
      'v1.4.14 修好 AI 评论签名 childNodes 报错：整棵克隆 X 首页动画帧、帧留到异步签名完成、页面就绪预热签名器，签名失败时 XVM 通道兜底。',
      'v1.4.13 面板顶端新增 TapeUP / 矿机日产价 / BEM 实时行情，可设上下限，越界右下角弹窗 + 系统通知，点击直达 Firsto 交易所。',
      'v1.4.12 修好 AI 评论 401：默认公开 bearer、重试重新签名、兼容新版 Grok 流格式；XVM 改为异常兜底。',
      'v1.4.11 写回改为一次全量替换，修掉文字重复与回复框不可编辑；新增 T 安全模式与 AI 评论快速模式。',
      'v1.4.10 按钮移到回复正文上方外侧不再压字；写回后收拢选区不留灰色高亮；已有两句以上推广句时停手不叠加。',
      'v1.4.9 全页只有一个 T 按钮且绑定当前回复框；点击保住焦点，修好按钮成排、写错框、手工改完就乱。',
      'v1.4.8 只留一个 T 按钮，点击随机换句不重复；写回改用原生编辑命令，正文绝不被重写。',
      'v1.4.7 尝试只替换末尾推广句（仍有索引偏差，1.4.8 已重写）。',
      'v1.4.6 回复框新增多个 T 快捷按钮，手写评论也能点一下带入推广句。',
      'v1.4.5 可勾选「评论末尾推广」，随机附一句 TapeOut / $BEM 介绍。',
      'v1.4.4 修好重载后 popup 的消息端口报错。',
      'v1.4.3 默认不落盘；临时文件到期自动清理。',
      'v1.4.2 修好直连 401 认证，可复用同页 XVM 通道。',
      'v1.4.1 旧「页面模式」设置自动升级为「自动」。',
      'v1.4.0 AI 评论改为直连 X 自带 Grok 接口。',
      'v1.3.x 按钮移到回复框、等待浮层、正文防污染。',
      '重载扩展后记得刷新一次 X 页面。'
    ]
  },
  modes: {
    title: '运行模式',
    lines: [
      '自动（推荐）：在 X 页面直连 Grok，免 Key、免费。',
      '站内直连：同自动，但失败时直接报错不降级。',
      '页面模式：旧 DOM 链路，仅作手动兜底。',
      'xAI API：填自己的 Key，按量计费。',
      '请求由 X 页面发给 X/Grok，不经第三方服务器。'
    ]
  },
  usage: {
    title: '使用说明',
    lines: [
      '一键转发：内容右上角点按钮，整理正文与配图成 X 草稿。',
      'AI 评论：先点推文「回复」，按钮在填写区上方右侧，不压住正文。',
      '选中候选会写回回复框，最后一步仍由你手动点「回复」。',
      '多图弹托盘：逐张复制、拼长图或下载到临时目录。',
      '去水印只在本机处理，检测不到水印的图片原样保留。',
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
      '1.4.10 按钮不再压在正文上；每次写回后自动把选区收成光标，不留灰色选中块。',
      '1.4.10 正文里已经有两句以上推广句时会停手，只提示、不继续叠加；右键 T 仍可去掉末尾那句。',
      '1.4.11 写回只做一次「全量替换」（等价于自己全选后重打一遍），不再用局部选区删改：这就是之前文字重复、回复框不可编辑的根因。',
      '1.4.11 正文里有 @ / 表情 / 配图时自动降级为只复制，绝不弄丢它们；也可手动开「安全模式」让 T 永远只复制。',
      '1.4.11 AI 评论默认走快速模式：不思考、不并排生成、拿到答案即收尾，通常 5~15 秒。',
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
      '1.4.3 起图片默认走剪贴板，转发不再自动落盘。',
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
      '只有 API 模式才由后台直连 xAI，费用自行承担。',
      '插件不调用任何发布接口，不替你发推或回复。'
    ]
  },
  price: {
    title: '行情与提醒说明',
    lines: [
      '三项数据：TapeUP 内盘（UP/BEM 计价）、矿机日产能价（BNB）、$BEM。',
      'BEM 与矿机日产价取自 Firsto 官方 analytics（公开只读）。',
      'TapeUP 内盘价来自 tapeup.io 交易页，按 UP/BEM 计价（用 BEM 买 UP）；tapeup.io 整站 Cloudflare 防护，',
      '后台无法直接抓取，因此由扩展在你打开交易页时从页面自动读取内盘价并缓存；关闭后沿用缓存。',
      '均不登录、不需要 API Key、不发送任何本机数据。',
      '点开面板会读 2 分钟内的缓存；点 ↻ 可立即刷新，后台默认每 5 分钟查一次。',
      '设好上下限并保存后，只在价格「从区间内跨到区间外」时提醒一次。',
      '网页右下角浮层只在已打开的支持站点出现；系统通知不受此限制。',
      '点 UP 卡片 / 浮层 / 通知会打开 tapeup.io 交易页；其余两项打开 Firsto 数据页。',
      '行情仅供参考，不构成投资建议；插件不会替你下单。'
    ]
  }
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

function renderPriceSnapshot(snap) {
  if (!priceApi || !snap || !snap.items) { priceText('priceUpdated', '暂无数据'); return; }
  priceApi.KEYS.forEach((k) => {
    const item = snap.items[k] || {};
    const vEl = priceEl('priceValue' + priceCap(k));
    const cEl = priceEl('priceChange' + priceCap(k));
    if (vEl) vEl.textContent = priceApi.format(k, item.value);
    if (cEl) {
      cEl.textContent = priceApi.formatChange(item.changePct) + (item.stale ? ' · 缓存' : '');
      cEl.className = 'pc-change' + (priceApi.isUp(item.changePct) ? ' up'
        : (priceApi.isDown(item.changePct) ? ' down' : ''));
    }
  });
  const t = Date.parse(snap.updatedAt);
  const up = priceEl('priceUpdated');
  priceText('priceUpdated', isNaN(t) ? '刚刚更新'
    : '更新 ' + new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
  if (up) up.title = (snap.errors && snap.errors.length) ? snap.errors.join('；') : '点 ↻ 立即刷新';
}

function loadPrices(force) {
  if (!priceApi) { priceText('priceUpdated', '行情模块未加载'); return; }
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
