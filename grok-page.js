/*
 * grok-page.js — 注入 x.com / twitter.com 的「非 API 模式」桥接层
 *
 * 目的：不填 xAI API Key 也能用 Grok。扩展不调用任何 AI 接口，
 *       只是把设定好的提示词填进 X 站内 Grok（/i/grok 页面或浮窗）的输入框，
 *       等回答稳定后把文本读回后台解析。所有网络行为都发生在 X 自己的页面里。
 *
 * 实测 selector（2026-11-08，x.com/i/grok，登录状态）：
 *   输入  div[aria-label="Ask anything"][role="textbox"]   contenteditable
 *   发送  button[aria-label="Send"]                        有内容才出现
 *   对话  div[aria-label="Grok"]
 *   回答  button[aria-label="Copy"]                        每条回答一个，作为回溯锚点
 *   新对话 a[aria-label="New chat"]
 * 选择器全部由设置面板下发，X 改版时用户改一行配置即可，无需升级扩展。
 *
 * 注意：网页版 Grok 会把「思考过程」「用户提问气泡」也渲染进对话区，
 *       所以这里同时返回 answer（回答块）与 allText（对话区全文），
 *       后台用 TapeAI.extractJsonLoose 从混杂文本里提取最终 JSON。
 */
(function () {
  'use strict';

  var DEFAULT_CFG = {
    grokPageInputSel: 'div[aria-label="Ask anything"][role="textbox"], textarea[placeholder*="Ask"], [data-testid="grok-input"]',
    grokPageSendSel: 'button[aria-label="Send"], [data-testid="grok-send"]',
    grokPageRootSel: 'div[aria-label="Grok"], [data-testid="grok-conversation"]',
    grokPageAnswerSel: 'button[aria-label="Copy"]',
    grokPageQuietMs: 1500,
    grokPageTimeoutMs: 60000,
    grokPageAutoSubmit: true,
    grokPageNewChat: true,
    grokPageMaxChars: 8000
  };

  function num(v, fallback, min, max) {
    var n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function cfgOf(input) {
    var c = {};
    Object.keys(DEFAULT_CFG).forEach(function (k) { c[k] = DEFAULT_CFG[k]; });
    Object.keys(input || {}).forEach(function (k) { if (input[k] != null && input[k] !== '') c[k] = input[k]; });
    c.grokPageQuietMs = num(c.grokPageQuietMs, 1500, 400, 10000);
    c.grokPageTimeoutMs = num(c.grokPageTimeoutMs, 60000, 5000, 180000);
    c.grokPageMaxChars = num(c.grokPageMaxChars, 8000, 500, 30000);
    c.grokPageAutoSubmit = c.grokPageAutoSubmit !== false && c.grokPageAutoSubmit !== 'false';
    c.grokPageNewChat = c.grokPageNewChat !== false && c.grokPageNewChat !== 'false';
    return c;
  }

  /* 逗号分隔的多候选选择器；用户可能填错某个片段，逐个 try 不要把整段废掉 */
  function find(sel, root) {
    var base = root || document;
    var parts = String(sel || '').split(',');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (!p) continue;
      try {
        var el = base.querySelector(p);
        if (el) return el;
      } catch (e) { /* 非法选择器片段，跳过 */ }
    }
    return null;
  }

  function findAll(sel, root) {
    var base = root || document;
    var out = [];
    String(sel || '').split(',').forEach(function (p) {
      p = p.trim();
      if (!p) return;
      try { out = out.concat(Array.prototype.slice.call(base.querySelectorAll(p))); }
      catch (e) { /* ignore */ }
    });
    return out;
  }

  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (r && (r.width > 0 || r.height > 0)) return true;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects && el.getClientRects().length);
  }

  function inputBox(cfg) {
    var list = findAll(cfg.grokPageInputSel).filter(visible);
    return list.length ? list[list.length - 1] : null; // 浮窗可能同时存在多个，取最后渲染的
  }

  function rootBox(cfg) {
    var list = findAll(cfg.grokPageRootSel).filter(visible);
    return list.length ? list[list.length - 1] : document.body;
  }

  function ping(cfg) {
    var i = inputBox(cfg);
    var s = find(cfg.grokPageSendSel);
    var r = find(cfg.grokPageRootSel);
    return {
      ok: true,
      url: location.href,
      isGrokPage: /\/i\/grok(?:\/|$)/.test(location.pathname),
      hasInput: !!i,
      hasSend: !!s,
      hasRoot: !!r,
      hasAnswer: findAll(cfg.grokPageAnswerSel).length > 0
    };
  }

  function boxValue(el) {
    var t = String(el.tagName || '').toLowerCase();
    if (t === 'textarea' || t === 'input') return String(el.value || '');
    return String(el.innerText || el.textContent || '');
  }

  /* 1.3.2 关键修复：绝不再用 execCommand('selectAll')。
   * 实测（x.com/i/grok）它会把整页选中，导致侧栏文字 History/Usage/Share
   * 和插件按钮「AI 评论」被成片粘进 Grok 输入框，提示词彻底被污染，
   * Grok 只能答非所问。这里改成 Range.selectNodeContents(el)，只操作输入框内部。 */
  function selectOnlyBox(el) {
    try {
      var sel = window.getSelection && window.getSelection();
      if (!sel || !document.createRange) return false;
      var r = document.createRange();
      r.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(r);
      return true;
    } catch (e) { return false; }
  }

  function verifyPrompt(el, want, tag) {
    var got = boxValue(el).trim();
    var expect = String(want || '').trim();
    if (!expect) return !!got;
    // 1) 必须带任务标记；2) 标记必须靠前；3) 长度不能明显超过提示词本身
    if (tag) {
      var at = got.indexOf(tag);
      if (at === -1 || at > 4) return false;
    } else if (!got || got.indexOf(expect.slice(0, 12)) === -1) return false;
    if (got.length > expect.length + 160) return false;
    return true;
  }

  function setPrompt(el, text, cfg, tag) {
    if (!el) throw new Error('没找到 Grok 输入框');
    var want = String(text || '');
    var nodeTag = String(el.tagName || '').toLowerCase();
    var editable = el.isContentEditable || el.getAttribute && el.getAttribute('contenteditable') === 'true' ||
      (el.getAttribute && el.getAttribute('role') === 'textbox' && nodeTag !== 'textarea' && nodeTag !== 'input');
    var err = null;

    if (editable) {
      try {
        try { el.focus(); } catch (e) {}
        if (selectOnlyBox(el) && document.execCommand) {
          // 先删除输入框里残留的内容（只删选区，不碰页面其它节点）
          try { document.execCommand('delete'); } catch (e) {}
          selectOnlyBox(el);
          var ok = document.execCommand('insertText', false, want);
          if (!ok) throw new Error('insertText 被拒绝');
        } else {
          throw new Error('无法建立只覆盖输入框的选区');
        }
      } catch (e) {
        err = e;
        // 兜底：直接替换输入框内容并派发原生 input 事件
        try {
          el.textContent = '';
          var p = document.createElement('p');
          p.textContent = want;
          el.appendChild(p);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: want }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e2) { err = e2; }
      }
    } else {
      var proto = nodeTag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value');
      try {
        if (setter && setter.set) setter.set.call(el, want);
        else el.value = want;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) { err = e; }
    }

    // 写入校验不通过就不允许发送，避免把「整页文字」当提示词提交给 Grok
    if (!verifyPrompt(el, want, tag)) {
      throw new Error('提示词写入校验失败：Grok 输入框里混入了页面文字或没写进去' +
        (err ? '（' + String(err && err.message || err) + '）' : '') +
        '。这是已弃用的「页面模式」，X 改版后常写入失败；请点插件图标，把「运行模式」改为「自动」或「站内直连」（免 Key、最稳定）。' +
        '若必须留在页面模式，可关掉「自动发送」，改用「复制提示词 → 手动粘贴 → 读取回答」。');
    }
    return true;
  }

  function newChatIfNeeded(cfg) {
    return new Promise(function (resolve) {
      if (!cfg.grokPageNewChat) return resolve(true);
      // 只认 New chat 链接：左侧栏也有 a[href="/i/grok"]，点它不会新建对话
      var link = null;
      try { link = document.querySelector('a[aria-label="New chat"]'); } catch (e) {}
      if (!link || !visible(link)) return resolve(true); // 已经在空对话里，没有 New chat 入口
      try { link.click(); } catch (e) { return resolve(true); }
      setTimeout(function () { resolve(true); }, 700);
    });
  }

  function submit(cfg) {
    var btn = find(cfg.grokPageSendSel);
    if (btn && visible(btn) && !btn.disabled) {
      try { btn.click(); return 'button'; } catch (e) { /* fallthrough */ }
    }
    var box = inputBox(cfg);
    if (!box) return 'none';
    ['keydown', 'keypress', 'keyup'].forEach(function (type) {
      try {
        box.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true, cancelable: true
        }));
      } catch (e) { /* ignore */ }
    });
    return 'enter';
  }

  /* 1.3.2：X / Grok 网页的按钮文字会混进 innerText。
   * 1.3.1 的 History / Usage / Share 就是这么被当成评论返回的。 */
  var UI_NOISE = [
    'History', 'Usage', 'Share', 'New chat', 'Ask anything', 'Home', 'Explore',
    'Notifications', 'Chat', 'Calls', 'Grok', 'Premium+', 'Money', 'Profile',
    'More', 'Post', 'Copy', '复制', 'Regenerate', 'Good response', 'Bad response',
    'Think Harder', 'AI 评论', '一键转发', '再来 3 条', '请生成英文回复',
    '分析 AI 评论识别特征', 'Reply', 'Replying to', 'Post your reply', 'X'
  ];
  var END_TAG = '【TapePost 任务结束】';

  function pageNoise(line) {
    var t = String(line || '').trim();
    if (!t) return true;
    if (UI_NOISE.indexOf(t) !== -1) return true;
    if (/^Thought for \d+\s*(?:s|秒)/i.test(t)) return true;
    if (/^【(?:必须遵守的指令|输出格式|TapePost 任务)/.test(t)) return true;
    if (/^\s*[-*•]\s*(?:直接给|只输出|不要输出)/.test(t)) return true;
    return false;
  }

  /* 只保留「可能是回答」的文本：切掉用户提示词区块 + 逐行丢 UI 噪声 */
  function cleanBlock(s, tag) {
    var t = String(s || '');
    if (tag) {
      var a = t.indexOf(tag);
      if (a !== -1) {
        var b = t.indexOf(END_TAG, a + tag.length);
        if (b > a) t = t.slice(b + END_TAG.length);
        else {
          var rule = t.indexOf('不要输出多个版本', a);
          if (rule > a) t = t.slice(rule + 20);
        }
      }
    }
    return t.split(/\n+/).filter(function (l) { return !pageNoise(l); }).join('\n').trim();
  }

  /* 去掉按钮条 / 输入框 / 用户气泡等噪声，尽量只留模型回答 */
  function answerText(cfg, tag) {
    var copies = findAll(cfg.grokPageAnswerSel).filter(visible);
    var candidates = [];
    if (copies.length) {
      var bar = copies[copies.length - 1];
      // 1) 操作栏前面的兄弟节点，通常就是 markdown 回答块
      var sib = bar.parentElement && bar.parentElement.previousElementSibling;
      for (var k = 0; k < 4 && sib; k++, sib = sib.previousElementSibling) {
        var t = cleanBlock(String(sib.innerText || sib.textContent || ''), tag);
        if (t) candidates.push(t);
      }
      // 2) 向上几层祖先，作为结构变化时的兜底（会混入思考过程，后台还会再清洗一次）
      var up = bar.parentElement;
      for (var i = 0; i < 5 && up; i++, up = up.parentElement) {
        var tx = cleanBlock(String(up.innerText || up.textContent || ''), tag);
        if (tx && tx.length > 2) candidates.push(tx);
        if (tx.length > 6000) break;
      }
    }
    var root = rootBox(cfg);
    var all = String(root.innerText || root.textContent || '').trim();
    // 优先短候选：越短越可能是纯回答；至少 8 字，避免把按钮词当回答
    var short = candidates.filter(function (x) { return x.length >= 8 && x.length <= 4000; })
      .sort(function (a, b) { return a.length - b.length; });
    var answer = short.length ? short[0] : '';
    return {
      answer: answer,
      candidates: candidates.slice(0, 6),
      allText: all,
      hasAnswer: !!answer && !pageNoise(answer)
    };
  }

  function snapshot(cfg, tag) {
    var r = answerText(cfg, tag);
    return (r.answer || '') + '\n' + r.allText;
  }

  /* 等回答文本静止一段时间；超时也返回当前文本，由后台决定报错还是宽松解析 */
  function waitStable(cfg, before, tag) {
    return new Promise(function (resolve) {
      var last = before;
      var changed = false;
      var quiet = null;
      var done = false;
      var timer = null;
      var grace = null;
      var obs = null;
      var finish = function (reason) {
        if (done) return;
        done = true;
        if (quiet) clearTimeout(quiet);
        if (timer) clearTimeout(timer);
        if (grace) clearTimeout(grace);
        if (obs) { try { obs.disconnect(); } catch (e) {} }
        resolve({ text: snapshot(cfg, tag), changed: changed, reason: reason });
      };
      var tick = function () {
        var now = snapshot(cfg, tag);
        if (now !== last) {
          last = now;
          changed = true;
          if (quiet) clearTimeout(quiet);
          // 流式输出期间不断重置静默计时，直到文本不再变化
          quiet = setTimeout(function () { finish('quiet'); }, cfg.grokPageQuietMs);
        }
      };
      try {
        obs = new MutationObserver(tick);
        obs.observe(rootBox(cfg), { childList: true, characterData: true, subtree: true });
      } catch (e) { /* 观察失败就只剩超时兜底 */ }
      // 首个字符可能要等几秒才出现：没变化时用一个更长的宽限期，别过早判「无回答」
      grace = setTimeout(function () { if (!changed) finish('no-change'); },
        Math.min(cfg.grokPageTimeoutMs, Math.max(cfg.grokPageQuietMs * 3, 6000)));
      timer = setTimeout(function () { finish('timeout'); }, cfg.grokPageTimeoutMs);
      tick();
    });
  }

  function clip(s, max) {
    var t = String(s || '').trim();
    return t.length > max ? t.slice(-max) : t; // 取尾部：最终答案通常在最后
  }

  function readResult(cfg, tag) {
    var r = answerText(cfg, tag);
    var bodyText = '';
    try { bodyText = String((document.body && document.body.innerText) || ''); } catch (e) {}
    // 后台只拿 text / candidates / 清洗后的 allText 解析；allText 原文仅用于诊断
    return {
      ok: true,
      text: clip(r.answer, cfg.grokPageMaxChars),
      allText: clip(r.allText, cfg.grokPageMaxChars),
      candidates: r.candidates.map(function (x) { return clip(x, 3000); }),
      hasAnswer: r.hasAnswer,
      promptSent: !!tag && bodyText.indexOf(tag) !== -1,
      url: location.href
    };
  }

  async function handle(msg) {
    var cfg = cfgOf(msg.config || {});
    var tag = String(msg.tag || '');
    if (msg.action === 'ping') return ping(cfg);

    if (msg.action === 'read') return readResult(cfg, tag);

    if (msg.action === 'prepare') {
      await newChatIfNeeded(cfg);
      var box = inputBox(cfg);
      if (!box) {
        return { ok: false, error: '这个 X 页面里没有找到 Grok 输入框。请打开 x.com/i/grok，或在 X 上点开 Grok 浮窗后重试。' };
      }
      setPrompt(box, String(msg.prompt || ''), cfg, tag);
      return { ok: true, prepared: true, prompt: msg.prompt, url: location.href, hasSend: !!find(cfg.grokPageSendSel) };
    }

    // action === 'auto'
    await newChatIfNeeded(cfg);
    var input = inputBox(cfg);
    if (!input) {
      return { ok: false, error: '没找到 Grok 输入框。请确认已登录 X 并能使用 Grok；也可在设置里改「输入框选择器」或改用手动模式。' };
    }
    var prompt = String(msg.prompt || '');
    setPrompt(input, prompt, cfg, tag); // 校验不通过会直接抛错，绝不让脏提示词发出去
    if (!cfg.grokPageAutoSubmit) {
      return { ok: true, prepared: true, prompt: prompt, url: location.href, note: '已填好提示词，请在 Grok 里自己按发送，再点「读取 Grok 回答」。' };
    }
    // 等一拍让 React 把 Send 按钮渲染出来
    await new Promise(function (r) { setTimeout(r, 350); });
    var how = submit(cfg);
    if (how === 'none') {
      return { ok: false, error: '没找到发送按钮（X 改版？）。可在设置里关掉「自动发送」，改用手动模式。' };
    }
    var before = snapshot(cfg, tag);
    var waited = await waitStable(cfg, before, tag);
    var out = readResult(cfg, tag);
    out.submitBy = how;
    out.stable = waited.reason;
    out.changed = waited.changed;
    out.noAnswer = !out.hasAnswer;
    return out;
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || msg.type !== 'GROK_PAGE_BRIDGE') return false;
      Promise.resolve()
        .then(function () { return handle(msg); })
        .then(function (out) { try { sendResponse(out); } catch (e) {} })
        .catch(function (e) {
          try { sendResponse({ ok: false, error: String(e && e.message || e) }); } catch (e2) {}
        });
      return true;
    });
  }

  // 暴露给 Node 冒烟测试（页面里 module 不存在）
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      DEFAULT_CFG: DEFAULT_CFG, cfgOf: cfgOf, find: find, findAll: findAll,
      answerText: answerText, cleanBlock: cleanBlock, pageNoise: pageNoise,
      setPrompt: setPrompt, verifyPrompt: verifyPrompt, selectOnlyBox: selectOnlyBox,
      boxValue: boxValue, readResult: readResult
    };
  }
})();
