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

  /* contenteditable 用 execCommand 触发真实 beforeinput/input，才能过 X 的 React 受控层 */
  function setPrompt(el, text, cfg) {
    if (!el) throw new Error('没找到 Grok 输入框');
    try { el.focus(); } catch (e) {}
    var tag = String(el.tagName || '').toLowerCase();
    var editable = el.isContentEditable || el.getAttribute && el.getAttribute('contenteditable') === 'true' ||
      (el.getAttribute && el.getAttribute('role') === 'textbox' && tag !== 'textarea' && tag !== 'input');

    if (editable) {
      try {
        el.focus();
        if (document.execCommand) {
          document.execCommand('selectAll', false, null);
          var ok = document.execCommand('insertText', false, text);
          if (ok && String(el.innerText || el.textContent || '').trim()) return true;
        }
      } catch (e) { /* 走下面的兜底 */ }
      try {
        el.textContent = '';
        var p = document.createElement('p');
        p.textContent = text;
        el.appendChild(p);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      } catch (e2) {
        throw new Error('无法把提示词写进 Grok 输入框（X 改版了？可在设置里改输入框选择器）：' + String(e2 && e2.message || e2));
      }
    }

    var proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    try {
      if (setter && setter.set) setter.set.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) {
      throw new Error('无法把提示词写进输入框：' + String(e && e.message || e));
    }
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

  /* 去掉按钮条 / 输入框 / 用户气泡等噪声，尽量只留模型回答 */
  function answerText(cfg) {
    var copies = findAll(cfg.grokPageAnswerSel).filter(visible);
    var candidates = [];
    if (copies.length) {
      var bar = copies[copies.length - 1];
      // 1) 操作栏前面的兄弟节点，通常就是 markdown 回答块
      var sib = bar.parentElement && bar.parentElement.previousElementSibling;
      for (var k = 0; k < 4 && sib; k++, sib = sib.previousElementSibling) {
        var t = String(sib.innerText || sib.textContent || '').trim();
        if (t) candidates.push(t);
      }
      // 2) 向上几层祖先，作为结构变化时的兜底（会混入思考过程，但后台可宽松提取）
      var up = bar.parentElement;
      for (var i = 0; i < 4 && up; i++, up = up.parentElement) {
        var tx = String(up.innerText || up.textContent || '').trim();
        if (tx && tx.length > 2) candidates.push(tx);
      }
    }
    var root = rootBox(cfg);
    var all = String(root.innerText || root.textContent || '').trim();
    // 优先短候选：越短越可能是纯回答；但也别短到只有一个字
    var short = candidates.filter(function (x) { return x.length >= 2 && x.length <= 4000; })
      .sort(function (a, b) { return a.length - b.length; });
    return { answer: short.length ? short[0] : '', candidates: candidates.slice(0, 6), allText: all };
  }

  function snapshot(cfg) {
    var r = answerText(cfg);
    return (r.answer || '') + '\n' + r.allText;
  }

  /* 等回答文本静止一段时间；超时也返回当前文本，由后台决定报错还是宽松解析 */
  function waitStable(cfg, before) {
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
        resolve({ text: snapshot(cfg), changed: changed, reason: reason });
      };
      var tick = function () {
        var now = snapshot(cfg);
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

  function readResult(cfg) {
    var r = answerText(cfg);
    // 后台按 answer → allText 顺序尝试解析；allText 保留尾部（最终回答更靠后）
    return {
      ok: true,
      text: clip(r.answer || r.allText, cfg.grokPageMaxChars),
      allText: clip(r.allText, cfg.grokPageMaxChars),
      candidates: r.candidates.map(function (x) { return clip(x, 3000); }),
      url: location.href
    };
  }

  async function handle(msg) {
    var cfg = cfgOf(msg.config || {});
    if (msg.action === 'ping') return ping(cfg);

    if (msg.action === 'read') return readResult(cfg);

    if (msg.action === 'prepare') {
      await newChatIfNeeded(cfg);
      var box = inputBox(cfg);
      if (!box) {
        return { ok: false, error: '这个 X 页面里没有找到 Grok 输入框。请打开 x.com/i/grok，或在 X 上点开 Grok 浮窗后重试。' };
      }
      setPrompt(box, String(msg.prompt || ''), cfg);
      return { ok: true, prepared: true, prompt: msg.prompt, url: location.href, hasSend: !!find(cfg.grokPageSendSel) };
    }

    // action === 'auto'
    await newChatIfNeeded(cfg);
    var input = inputBox(cfg);
    if (!input) {
      return { ok: false, error: '没找到 Grok 输入框。请确认已登录 X 并能使用 Grok；也可在设置里改「输入框选择器」或改用手动模式。' };
    }
    var prompt = String(msg.prompt || '');
    setPrompt(input, prompt, cfg);
    if (!cfg.grokPageAutoSubmit) {
      return { ok: true, prepared: true, prompt: prompt, url: location.href, note: '已填好提示词，请在 Grok 里自己按发送，再点「读取 Grok 回答」。' };
    }
    // 等一拍让 React 把 Send 按钮渲染出来
    await new Promise(function (r) { setTimeout(r, 350); });
    var how = submit(cfg);
    if (how === 'none') {
      return { ok: false, error: '没找到发送按钮（X 改版？）。可在设置里关掉「自动发送」，改用手动模式。' };
    }
    var before = snapshot(cfg);
    var waited = await waitStable(cfg, before);
    var out = readResult(cfg);
    out.submitBy = how;
    out.stable = waited.reason;
    out.changed = waited.changed;
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
    module.exports = { DEFAULT_CFG: DEFAULT_CFG, cfgOf: cfgOf, find: find, findAll: findAll, answerText: answerText };
  }
})();
