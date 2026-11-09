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
  grokModeMigrated141: false  // 1.4.1：旧 page 设置只自动升级一次
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
    document.getElementById('domain').value = s.xDomain || 'x.com';
    const ai = document.getElementById('aiComment');
    if (ai) ai.checked = s.enableAiComment !== false;
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
    enableAiComment: !!(document.getElementById('aiComment') || {}).checked,
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
      chrome.runtime.sendMessage({ type: 'GROK_TEST' }, (r) => {
        const err = chrome.runtime && chrome.runtime.lastError;
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
  const build = (messages, kind) => native
    ? TapeAI.buildNativePrompt(messages, kind, extra)
    : TapeAI.buildPagePrompt(messages, extra);
  const comment = build(
    TapeAI.buildCommentMessages('（示例推文）TapeOut 生态又多了一个链上应用，DeWeb 容器索引突破 200 个。', val('commentPrompt')), 'comments');
  const verify = build(
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
      chrome.runtime.sendMessage({ type: 'GROK_PAGE_RESET' }, (r) => {
        const err = chrome.runtime && chrome.runtime.lastError;
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
    chrome.runtime.sendMessage({ type: 'DIAG' }, (r) => {
      const err = chrome.runtime.lastError;
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

/* 1.4.2 文案精简：长说明收进一个简洁弹窗，设置页只留一句结论。 */
const INFO = {
  versions: {
    title: '版本说明',
    lines: [
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
      'AI 评论：先点推文「回复」，按钮在填写区右侧。',
      '选中候选会写回回复框，最后一步仍由你手动点「回复」。',
      '多图弹托盘：逐张复制、拼长图或全部下载。',
      '去水印只在本机处理，检测不到水印的图片原样保留。',
      '生态面板：295 条内置清单核验链接，以本地结论为准。',
      'X 改版导致按钮不出现时，可填「回复框选择器」。'
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
if (infoMask) infoMask.addEventListener('click', function (e) {
  if (e.target === infoMask) closeInfo();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeInfo();
});

load();
