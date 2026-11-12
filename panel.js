/*
 * panel.js — TapeOut 生态面板
 *
 * 页面本身是扩展内部页（chrome-extension://.../panel.html），不依赖外部 CDN。
 * 结论层级：本地白名单（权威） > Grok 解释（参考）。
 * 清单分三档：official（项目方官方）/ listed（导航站收录）/ deweb（链上容器已索引），
 * 三档都给绿标，但界面必须区分等级，避免把社区容器误读成项目方背书。
 */
'use strict';

var AI = (typeof TapeAI !== 'undefined') ? TapeAI : null;
var ME = (typeof X_ACCOUNT !== 'undefined') ? X_ACCOUNT : null;

var MAX_CARDS = 120;           // 一次最多渲染 120 张卡片，其余用搜索/筛选定位
var activeTier = 'all';
var keyword = '';

var TIER_META = {
  official: { tag: '✅ 项目方官方', cls: '', v: '项目方官方平台（OFFICIAL）' },
  listed: { tag: '✅ 导航站收录', cls: 'g-listed', v: '生态导航收录认可平台' },
  deweb: { tag: '✅ 已索引容器', cls: 'g-deweb', v: '链上容器 · 已被导航索引（非项目方背书）' }
};

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function sendToBackground(msg) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    // 页面模式要等 X 站内 Grok 生成完毕（默认 60s + 标签加载），超时放宽到 90s
    var timer = setTimeout(function () {
      if (!settled) { settled = true; reject(new Error('后台 90 秒内没有响应，请到 chrome://extensions 重新加载扩展，或改用手动流程。')); }
    }, 90000);
    try {
      chrome.runtime.sendMessage(msg, function (r) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        var err = chrome.runtime && chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(r || {});
      });
    } catch (e) {
      if (!settled) { settled = true; clearTimeout(timer); reject(e); }
    }
  });
}

function verdictLabel(v) {
  return ({ official: '导航认可', community: '生态参考（未收录）', fake: '疑似仿冒', unknown: '无法确认' })[v] || '无法确认';
}

// 本地结论映射：没有命中收录清单时，若出现形近域名等信号，直接升级成「疑似仿冒」
function localView(local) {
  if (!local) return { cls: 'v-unknown', title: '❔ 未获取到本地判定' };
  if (local.status === 'official') {
    var meta = TIER_META[local.tier] || TIER_META.listed;
    return { cls: 'v-official', title: '✅ ' + meta.v + '（绿标）', short: 'official' };
  }
  if (local.status === 'community') {
    return { cls: 'v-community', title: '⚠️ 未收录的参考链接，不是导航认可平台', short: 'community' };
  }
  if (local.status === 'invalid') {
    return { cls: 'v-invalid', title: '⛔ 链接格式无法识别', short: 'invalid' };
  }
  var risks = local.risks || [];
  var spoof = risks.some(function (r) { return /疑似仿冒|仅差一两个字符|Punycode/.test(r); });
  return spoof
    ? { cls: 'v-fake', title: '⛔ 疑似仿冒站，不是导航认可平台', short: 'fake' }
    : { cls: 'v-unknown', title: '❔ 未命中收录清单，无法确认为 TapeOut 生态导航认可的平台', short: 'unknown' };
}

function kvRow(dl, k, v) {
  dl.appendChild(el('dt', '', k));
  dl.appendChild(el('dd', '', v == null || v === '' ? '—' : String(v)));
}

function siteTier(s) { return s.tier || 'listed'; }

function makeCard(s) {
  var tier = siteTier(s);
  var meta = TIER_META[tier] || TIER_META.listed;
  var card = el('div', 'card t-' + tier);
  var top = el('div', 'card-top');
  var left = el('div');
  left.appendChild(el('div', 'cname', s.name));
  left.appendChild(el('div', 'cat', (s.category || '') + (s.badges && s.badges.length ? ' · ' + s.badges.join(' / ') : '')));
  top.appendChild(left);
  top.appendChild(el('span', 'green-tag ' + meta.cls, meta.tag));
  card.appendChild(top);

  var a = el('a', 'curl', s.url);
  a.href = s.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  card.appendChild(a);
  if (s.desc) card.appendChild(el('p', 'cdesc', s.desc));
  if (tier === 'deweb') card.appendChild(el('p', 'cdesc', '链上容器，内容由容器所有者部署；不代表项目方背书。'));

  var actions = el('div', 'cactions');
  var open = el('a', 'primary', '打开 ↗');
  open.href = s.url;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  actions.appendChild(open);

  var check = el('button', '', '核验此链接');
  check.type = 'button';
  check.addEventListener('click', function () {
    document.getElementById('urlInput').value = s.url;
    document.querySelector('.verify').scrollIntoView({ behavior: 'smooth', block: 'center' });
    runVerify();
  });
  actions.appendChild(check);

  var copy = el('button', '', '复制');
  copy.type = 'button';
  copy.addEventListener('click', function () {
    navigator.clipboard.writeText(s.url).then(function () {
      copy.textContent = '已复制 ✓';
      setTimeout(function () { copy.textContent = '复制'; }, 1500);
    }).catch(function () { copy.textContent = '复制失败'; });
  });
  actions.appendChild(copy);
  card.appendChild(actions);
  return card;
}

function renderStats() {
  if (!AI) return;
  var all = AI.ALL_SITES;
  var n = { official: 0, listed: 0, deweb: 0 };
  all.forEach(function (s) { n[siteTier(s)] = (n[siteTier(s)] || 0) + 1; });
  document.getElementById('nOfficial').textContent = n.official;
  document.getElementById('nListed').textContent = n.listed;
  document.getElementById('nDeweb').textContent = n.deweb;
  document.getElementById('nTotal').textContent = all.length;
  document.getElementById('officialCount').textContent =
    '共 ' + all.length + ' 条 · 来源 tapeout.link 收录 + web.tapeout.link 索引';
  document.getElementById('checkedAt').textContent = AI.SOURCE.checkedAt;
  Array.prototype.forEach.call(document.querySelectorAll('.checkedAt'), function (node) {
    node.textContent = AI.SOURCE.checkedAt;
  });
}

function renderCards() {
  var box = document.getElementById('officialCards');
  if (!box || !AI) return;
  box.textContent = '';
  var kw = keyword.trim().toLowerCase();
  var matched = AI.ALL_SITES.filter(function (s) {
    if (activeTier !== 'all' && siteTier(s) !== activeTier) return false;
    if (!kw) return true;
    return [s.name, s.url, s.category, s.desc, s.tape, (s.badges || []).join(' ')]
      .join(' ').toLowerCase().indexOf(kw) !== -1;
  });
  // 项目方官方 → 导航站收录 → 链上容器（排序口径放在 grok.js，回归测试可直接验证）
  matched = AI.sortByTier(matched);

  var shown = matched.slice(0, MAX_CARDS);
  shown.forEach(function (s) { box.appendChild(makeCard(s)); });
  document.getElementById('fcount').textContent =
    '符合条件 ' + matched.length + ' 条，当前显示 ' + shown.length + ' 条';
  document.getElementById('emptyHint').style.display = matched.length ? 'none' : 'block';
  var more = document.getElementById('moreNote');
  if (matched.length > MAX_CARDS) {
    more.style.display = 'block';
    more.textContent = '还有 ' + (matched.length - MAX_CARDS) +
      ' 条未展开。用上方搜索框输入名称或域名，或按等级筛选即可定位；全部 ' + AI.ALL_SITES.length +
      ' 条都参与链接真伪核验，不受这里显示数量影响。';
  } else {
    more.style.display = 'none';
  }
}

function renderReference() {
  var box = document.getElementById('refList');
  if (!box || !AI) return;
  box.textContent = '';
  if (!AI.REFERENCE_SITES.length) {
    box.appendChild(el('li', '', '当前没有未收录的待核验链接。'));
    return;
  }
  AI.REFERENCE_SITES.forEach(function (s) {
    var li = el('li');
    li.appendChild(el('span', 'gray-tag', s.kind));
    li.appendChild(el('span', '', s.name + ' · '));
    var a = el('a', '', s.url);
    a.href = s.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    li.appendChild(a);
    li.appendChild(el('span', 'ref-note', s.note));
    box.appendChild(li);
  });
}

function localSnapshot(local) {
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

function renderResult(local, grok, aiError) {
  var box = document.getElementById('result');
  box.textContent = '';
  box.style.display = 'block';
  var v = localView(local);

  var verdict = el('div', 'verdict ' + v.cls);
  verdict.appendChild(el('div', 'vtitle', v.title));
  if (local && local.normalized && local.normalized.ok) {
    verdict.appendChild(el('div', 'vmeta', '规范化比对地址：' + local.normalized.normalized));
  }
  if (local && local.error) verdict.appendChild(el('div', 'vmeta', local.error));
  box.appendChild(verdict);

  var dl = el('dl', 'kv');
  kvRow(dl, '本地白名单结论', v.short === 'official'
    ? '命中 → 给绿标（' + (TIER_META[local.tier] || TIER_META.listed).v + '）'
    : (v.short === 'community' ? '命中参考清单 → 不给绿标' : '未命中 → 不给绿标'));
  if (local && local.site) kvRow(dl, '命中的条目', local.site.name + ' — ' + local.site.url);
  if (local && local.site) kvRow(dl, '收录分类', local.site.category || '—');
  if (local && local.viaGateway) kvRow(dl, '建议改用官方网关', local.viaGateway);
  kvRow(dl, 'Grok 判定', grok ? verdictLabel(grok.verdict) + (grok.model ? '（' + grok.model + '）' : '') : '未返回');
  if (grok && grok.reason) kvRow(dl, 'Grok 理由', grok.reason);
  if (grok && grok.matched) kvRow(dl, 'Grok 声称命中', grok.matched);
  box.appendChild(dl);

  var risks = (local && local.risks || []).slice();
  if (grok && grok.risk && risks.indexOf(grok.risk) === -1) risks.push('Grok：' + grok.risk);
  if (risks.length) {
    var rbox = el('div', 'risks', '⚠️ 风险提示');
    var ul = el('ul');
    risks.forEach(function (r) { ul.appendChild(el('li', '', r)); });
    rbox.appendChild(ul);
    box.appendChild(rbox);
  }

  // 防伪底线：模型不能覆盖本地白名单
  if (grok && local) {
    var localOfficial = local.status === 'official';
    if (grok.verdict === 'official' && !localOfficial) {
      box.appendChild(el('div', 'conflict',
        '⛔ Grok 判为「导航认可」，但本地清单没有命中 —— 已拒绝采信模型结论，以本地判定为准。请勿据此访问或授权钱包。'));
    } else if (localOfficial && grok.verdict !== 'official') {
      box.appendChild(el('div', 'aiwarn',
        'ℹ️ Grok 的结论与本地清单不一致；本面板以本地清单为准（该地址确实在收录清单里）。模型判断仅供参考。'));
    }
  }

  if (aiError) {
    box.appendChild(el('div', 'aiwarn',
      'ℹ️ Grok 解释未生成：' + aiError + ' —— 上面的绿标 / 风险结论来自本地清单，依然有效。' +
      '点插件图标可在「Grok 设置」里切换运行模式 / 填 xAI Key，或用上方的手动流程。'));
  }
  if (grok && grok.strict === false) {
    box.appendChild(el('div', 'aiwarn',
      'ℹ️ 网页版 Grok 没有严格按 JSON 输出，本次结果是按原文兜底解析的，仅供参考；' +
      '可在设置里的「页面模式附加要求」强调「只输出最终 JSON」，或改用手动流程。'));
  }
  if (grok && grok.rawText) {
    box.appendChild(el('div', 'raw', 'Grok 原始返回：\n' + grok.rawText));
  }
}

function showManualHint(text, isError) {
  var h = document.getElementById('manualHint');
  if (!h) return;
  h.style.display = 'block';
  h.textContent = text;
  h.style.background = isError ? '#fef2f2' : '#fffbeb';
  h.style.borderColor = isError ? '#fecaca' : '#fde68a';
  h.style.color = isError ? '#7f1d1d' : '#78350f';
}

function showMode() {
  var tag = document.getElementById('modeTag');
  if (!tag) return;
  try {
    chrome.storage.sync.get({ grokMode: 'auto' }, function (s) {
      chrome.storage.local.get({ grokApiKey: '' }, function (g) {
        var mode = (AI && AI.pickGrokMode)
          ? AI.pickGrokMode({ grokMode: s.grokMode, grokApiKey: g.grokApiKey }) : 'api';
        tag.textContent = mode === 'page'
          ? '模式：X 站内 Grok（免 API Key · 不调用 AI 接口）'
          : '模式：xAI API（已填 Key · 由后台直连）';
      });
    });
  } catch (e) { tag.textContent = '模式：自动'; }
}

async function copyPromptText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) { /* 扩展页偶发焦点限制，走 execCommand 兜底 */ }
  try {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    var ok = !!(document.execCommand && document.execCommand('copy'));
    if (ta.remove) ta.remove();
    return ok;
  } catch (e2) { return false; }
}

/* 手动兜底 ①：把完整核验提示词填进 Grok 输入框并复制到剪贴板，不自动发送 */
async function preparePrompt() {
  var input = document.getElementById('urlInput').value.trim();
  if (!input) { showManualHint('请先在上方输入要核验的链接。', true); return; }
  var btn = document.getElementById('copyPromptBtn');
  btn.disabled = true;
  btn.textContent = '准备中…';
  try {
    var r = await sendToBackground({ type: 'GROK_PAGE_PREPARE', payload: { kind: 'verify', url: input } });
    if (!r || !r.ok) throw new Error((r && r.error) || '后台没有返回提示词');
    var copied = await copyPromptText(r.prompt || '');
    showManualHint('已把核验提示词' + (copied ? '复制到剪贴板，并' : '') + '填进 Grok 输入框。' +
      '请到 X 的 Grok 页面按发送，等回答出来后点「读取 Grok 回答」。' +
      (r.page && r.page.url ? '（页面：' + r.page.url + '）' : '') +
      (copied ? '' : ' 剪贴板复制被拒绝，提示词已在 Grok 输入框里，可直接发送。'), !copied);
  } catch (e) {
    showManualHint('准备提示词失败：' + String(e && e.message || e) +
      '。请确认已登录 x.com 且 Grok 可用，或在设置里点「打开 Grok 页面」。', true);
  } finally {
    btn.disabled = false;
    btn.textContent = '📋 复制核验提示词（手动模式）';
  }
}

/* 手动兜底 ②：用户在 Grok 里发送并等回答出来后，读回最后一条回答解析 */
async function readAnswer() {
  var input = document.getElementById('urlInput').value.trim();
  var btn = document.getElementById('readAnswerBtn');
  btn.disabled = true;
  btn.textContent = '读取中…';
  try {
    var r = await sendToBackground({ type: 'GROK_PAGE_READ', payload: { kind: 'verify', url: input } });
    if (!r || r.ok === false) throw new Error((r && r.error) || '后台没有返回');
    var snap = localSnapshot(AI.matchOfficial(input));
    renderResult(r.local || snap, r.grok || null, r.aiError || null);
    showManualHint(r.strict === false
      ? '已从 Grok 页面读回回答，但它没有严格按 JSON 输出，结果是按原文兜底解析的，仅供参考。'
      : '已从 X 站内 Grok 页面读回回答并解析完成；本地清单结论仍为最终依据。', r.strict === false);
  } catch (e) {
    showManualHint('读取失败：' + String(e && e.message || e) +
      '。请确认 Grok 回答已经生成完毕，且该 X 标签仍处于打开状态。', true);
  } finally {
    btn.disabled = false;
    btn.textContent = '📥 读取 Grok 回答';
  }
}

async function runVerify() {
  if (!AI) return;
  var input = document.getElementById('urlInput').value.trim();
  var btn = document.getElementById('verifyBtn');
  if (!input) {
    renderResult({ status: 'invalid', error: '请先在输入框里粘贴一个链接。' }, null, null);
    return;
  }
  var local = AI.matchOfficial(input);
  var snap = localSnapshot(local);
  btn.disabled = true;
  btn.textContent = '核验中…';
  // 先把本地权威结论立刻渲染出来，不必等网络
  renderResult(snap, null, '正在调用 Grok 生成解释…');
  try {
    var r = await sendToBackground({ type: 'GROK_VERIFY', payload: { url: input } });
    if (r && r.ok === false && r.error) {
      renderResult(snap, null, r.error);
      return;
    }
    renderResult(r.local || snap, r.grok || null, r.aiError || null);
    if (r.mode === 'page') {
      var loose = !!(r.grok && r.grok.strict === false);
      showManualHint(loose
        ? '页面模式：已读回 Grok 回答，但它没严格按 JSON 输出，结果是按原文兜底解析的；可在设置的「页面模式附加要求」里强调只输出最终 JSON，或改走手动流程。'
        : '页面模式：提示词已送进 X 站内 Grok 并读回回答，全程未调用 xAI API、无需 API Key。', loose);
    }
  } catch (e) {
    renderResult(snap, null, String(e && e.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = '核验链接';
  }
}

function initPanel() {
  if (ME && ME.community) document.getElementById('meBadge').textContent = ME.community;
  renderStats();
  renderCards();
  renderReference();

  document.getElementById('filterInput').addEventListener('input', function (e) {
    keyword = e.target.value || '';
    renderCards();
  });
  Array.prototype.forEach.call(document.querySelectorAll('.fbtn'), function (btn) {
    btn.addEventListener('click', function () {
      activeTier = btn.getAttribute('data-tier') || 'all';
      Array.prototype.forEach.call(document.querySelectorAll('.fbtn'), function (b) {
        b.classList.toggle('on', b === btn);
      });
      renderCards();
    });
  });

  /* 1.4.19：生态面板标题旁的版本号同样以 manifest 为准（HTML 里有静态兜底） */
  try {
    var panelVer = chrome.runtime.getManifest && chrome.runtime.getManifest().version;
    var panelVerEl = document.getElementById('appVersion');
    if (panelVer && panelVerEl) panelVerEl.textContent = 'TapePost v' + panelVer;
  } catch (e) {}

  showMode();
  document.getElementById('verifyBtn').addEventListener('click', runVerify);
  document.getElementById('copyPromptBtn').addEventListener('click', preparePrompt);
  document.getElementById('readAnswerBtn').addEventListener('click', readAnswer);
  document.getElementById('urlInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') runVerify();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPanel);
} else {
  initPanel();
}
