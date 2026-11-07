'use strict';

const ACCOUNT = (typeof X_ACCOUNT !== 'undefined') ? X_ACCOUNT : {
  name: '昆哥', handle: 'YikunChen1983', url: 'https://x.com/YikunChen1983',
  community: 'TapeOut社区成员：昆哥'
};

// 已取消「需去水印作者 UID」列表；图片/视频都改由全局开关控制。
// 换用新 key，让旧版保存的 alwaysInpaint / watermarkUids 自动失效，避免旧设置盖掉新默认值。
const DEFAULTS = {
  inpaintImages: true,
  inpaintVideo: true,
  xDomain: 'x.com',
  hashMode: 'truncate',
  appendSignature: false,
  appendSource: false,
  enabledSites: {}
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

function load() {
  chrome.storage.sync.get(DEFAULTS, (s) => {
    document.getElementById('hash').value = s.hashMode || 'truncate';
    document.getElementById('imgWm').checked = !!s.inpaintImages;
    document.getElementById('videoWm').checked = !!s.inpaintVideo;
    document.getElementById('sig').checked = !!s.appendSignature;
    const source = document.getElementById('source');
    if (source) source.checked = !!s.appendSource;
    document.getElementById('domain').value = s.xDomain || 'x.com';
    const enabled = s.enabledSites || {};
    SITE_LIST.forEach((x) => {
      const el = document.getElementById('site_' + x.id);
      if (el) el.checked = enabled[x.id] !== false; // 默认全开
    });
  });
}

function save() {
  const data = {
    hashMode: document.getElementById('hash').value,
    inpaintImages: document.getElementById('imgWm').checked,
    inpaintVideo: document.getElementById('videoWm').checked,
    appendSignature: document.getElementById('sig').checked,
    appendSource: !!(document.getElementById('source') || {}).checked,
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
  chrome.storage.sync.set(data, () => {
    const ok = document.getElementById('ok');
    ok.style.display = 'block';
    setTimeout(() => { ok.style.display = 'none'; }, 1500);
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
document.getElementById('save').addEventListener('click', save);
document.getElementById('check').addEventListener('click', runDiagnostics);
load();
