/*
 * panel.js — TapeOut 生态面板
 *
 * 页面本身是扩展内部页（chrome-extension://.../panel.html），不依赖外部 CDN。
 * 结论层级：本地白名单（权威） > Grok 解释（参考）。
 */
'use strict';

var AI = (typeof TapeAI !== 'undefined') ? TapeAI : null;
var ME = (typeof X_ACCOUNT !== 'undefined') ? X_ACCOUNT : null;

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function sendToBackground(msg) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (!settled) { settled = true; reject(new Error('后台 20 秒内没有响应，请到 chrome://extensions 重新加载扩展。')); }
    }, 20000);
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
  return ({ official: '官方认定', community: '生态参考（非官方）', fake: '疑似仿冒', unknown: '无法确认' })[v] || '无法确认';
}

// 本地结论映射：没有命中官方白名单时，若出现形近域名等信号，直接升级成「疑似仿冒」
function localView(local) {
  if (!local) return { cls: 'v-unknown', title: '❔ 未获取到本地判定' };
  if (local.status === 'official') {
    return { cls: 'v-official', title: '✅ 官方认定平台（绿标）', short: 'official' };
  }
  if (local.status === 'community') {
    return { cls: 'v-community', title: '⚠️ 生态参考链接，不是官方认定', short: 'community' };
  }
  if (local.status === 'invalid') {
    return { cls: 'v-invalid', title: '⛔ 链接格式无法识别', short: 'invalid' };
  }
  var risks = local.risks || [];
  var spoof = risks.some(function (r) { return /疑似仿冒|仅差一两个字符|Punycode/.test(r); });
  return spoof
    ? { cls: 'v-fake', title: '⛔ 疑似仿冒站，不是官方认定平台', short: 'fake' }
    : { cls: 'v-unknown', title: '❔ 未命中官方白名单，无法确认为 TapeOut 官方平台', short: 'unknown' };
}

function kvRow(dl, k, v) {
  dl.appendChild(el('dt', '', k));
  dl.appendChild(el('dd', '', v == null || v === '' ? '—' : String(v)));
}

function renderOfficialCards() {
  var box = document.getElementById('officialCards');
  if (!box || !AI) return;
  box.textContent = '';
  document.getElementById('officialCount').textContent = '共 ' + AI.OFFICIAL_SITES.length + ' 个，来源 tapeout.link 的 OFFICIAL 标记';
  document.getElementById('checkedAt').textContent = AI.SOURCE.checkedAt;
  Array.prototype.forEach.call(document.querySelectorAll('.checkedAt'), function (n) {
    n.textContent = AI.SOURCE.checkedAt;
  });

  AI.OFFICIAL_SITES.forEach(function (s) {
    var card = el('div', 'card');
    var top = el('div', 'card-top');
    var left = el('div');
    left.appendChild(el('div', 'cname', s.name));
    left.appendChild(el('div', 'cat', s.category));
    top.appendChild(left);
    top.appendChild(el('span', 'green-tag', '✅ 官方认定'));
    card.appendChild(top);

    var a = el('a', 'curl', s.url);
    a.href = s.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    card.appendChild(a);
    card.appendChild(el('p', 'cdesc', s.desc));

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
    box.appendChild(card);
  });
}

function renderReference() {
  var box = document.getElementById('refList');
  if (!box || !AI) return;
  box.textContent = '';
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
  kvRow(dl, '本地白名单结论', v.short === 'official' ? '命中 → 给绿标' : (v.short === 'community' ? '命中参考清单 → 不给绿标' : '未命中 → 不给绿标'));
  if (local && local.site) kvRow(dl, '命中的条目', local.site.name + ' — ' + local.site.url);
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
        '⛔ Grok 判为「官方」，但本地白名单没有命中 —— 已拒绝采信模型结论，以本地判定为准。请勿据此访问或授权钱包。'));
    } else if (localOfficial && grok.verdict !== 'official') {
      box.appendChild(el('div', 'aiwarn',
        'ℹ️ Grok 的结论与本地白名单不一致；本面板以本地白名单为准（该地址确实在 OFFICIAL 清单里）。模型判断仅供参考。'));
    }
  }

  if (aiError) {
    box.appendChild(el('div', 'aiwarn',
      'ℹ️ Grok 解释未生成：' + aiError + ' —— 上面的绿标 / 风险结论来自本地白名单，依然有效。点插件图标可在「Grok 设置」里填 Key。'));
  }
  if (grok && grok.rawText) {
    box.appendChild(el('div', 'raw', 'Grok 原始返回：\n' + grok.rawText));
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
  btn.disabled = true;
  btn.textContent = '核验中…';
  // 先把本地权威结论立刻渲染出来，不必等网络
  renderResult({ status: local.status, normalized: local.normalized, site: local.site, risks: local.risks, error: local.error }, null, '正在调用 Grok 生成解释…');
  try {
    var r = await sendToBackground({ type: 'GROK_VERIFY', payload: { url: input } });
    if (r && r.ok === false && r.error) {
      renderResult({ status: local.status, normalized: local.normalized, site: local.site, risks: local.risks, error: local.error }, null, r.error);
      return;
    }
    renderResult(r.local || local, r.grok || null, r.aiError || null);
  } catch (e) {
    renderResult({ status: local.status, normalized: local.normalized, site: local.site, risks: local.risks, error: local.error },
      null, String(e && e.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = '核验链接';
  }
}

function initPanel() {
  if (ME && ME.community) document.getElementById('meBadge').textContent = ME.community;
  renderOfficialCards();
  renderReference();
  document.getElementById('verifyBtn').addEventListener('click', runVerify);
  document.getElementById('urlInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') runVerify();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPanel);
} else {
  initPanel();
}
