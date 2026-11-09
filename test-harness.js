/*
 * test-harness.js — 在 Node 里模拟 Chrome MV3 扩展运行时，端到端跑一次「一键转发」。
 *
 * 覆盖：content / background / offscreen 三者消息链路、文字 # 清洗、
 *       剪贴板多格式（text/plain + image/png + video/mp4 降级）、
 *       视频提取（DOM / 公开接口兜底）与下载、按钮位置、正文/图片归属。
 *
 * 运行：node test-harness.js     详细流水：WBX_VERBOSE=1 node test-harness.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = __dirname;
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

const log = [];
const note = (tag, s) => { log.push(`[${tag}] ${s}`); };

// ---------- 共享 Blob / URL / ClipboardItem ----------
class FakeBlob {
  constructor(parts, opts) { this.parts = parts || []; this.type = (opts && opts.type) || ''; }
  get size() {
    return this.parts.reduce((n, p) => n + (p && p.byteLength != null ? p.byteLength : (p && p.length) || 0), 0);
  }
  arrayBuffer() {
    const first = this.parts[0];
    if (first instanceof Uint8Array) return Promise.resolve(first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength));
    return Promise.resolve(new ArrayBuffer(this.size || 8));
  }
}
const FakeURL = {
  createObjectURL: () => 'blob:fake/' + Math.random().toString(36).slice(2),
  revokeObjectURL: () => {}
};
// 真实 SW 里 URL 既能 new URL(...) 解析网址，也有 createObjectURL 静态方法。
// 早期沙箱只给了后者，导致后台 TapeAI.normalizeUrl 在页面模式测试里误判 invalid。
const NativeURL = URL;
function FakeURLWithCtor(u, base) { return new NativeURL(u, base); }
FakeURLWithCtor.createObjectURL = FakeURL.createObjectURL;
FakeURLWithCtor.revokeObjectURL = FakeURL.revokeObjectURL;
class ClipboardItem { constructor(o) { this.items = o; } }

// ---------- 精简 DOM 模拟 ----------
class MiniNode {
  constructor(tag, opts = {}) {
    this.tagName = (tag || 'div').toUpperCase();
    this.className = opts.className || '';
    this.attrs = Object.assign({}, opts.attrs || {});
    if (this.className) this.attrs.class = this.className;
    this.innerText = opts.text || '';
    this.textContent = this.innerText;
    this.innerHTML = opts.innerHTML || '';
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = {};
    this.title = '';
    this.disabled = false;
    this.classList = { add: (c) => { this.className += ' ' + c; } };
  }
  get href() { return this.attrs.href || ''; }
  get src() { return this.attrs.src || ''; }
  appendChild(n) { n.parentElement = this; this.children.push(n); return n; }
  insertBefore(n) { return this.appendChild(n); }
  addEventListener(type, fn) { if (!this._handlers) this._handlers = {}; this._handlers[type] = fn; }
  // 1.3.1 回写测试：focus 交给 makeDom 的 hook 记录 activeElement
  focus() { this._focused = true; if (typeof globalThis.__wbxFocusHook === 'function') globalThis.__wbxFocusHook(this); }
  dispatchEvent(ev) { (this._events || (this._events = [])).push(ev); return true; }
  remove() {
    if (this.parentElement) {
      const arr = this.parentElement.children;
      const i = arr.indexOf(this);
      if (i >= 0) arr.splice(i, 1);
      this.parentElement = null;
    }
  }
  getAttribute(k) { return this.attrs[k] != null ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getBoundingClientRect() { return { width: 600, height: 120, top: 0, left: 0 }; }
  _all(out = []) { for (const c of this.children) { out.push(c); c._all(out); } return out; }
  querySelectorAll(sel) {
    const sels = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
    return this._all().filter((n) => sels.some((s) => matchOne(n, s)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) {
    let p = this.parentElement;
    const sels = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
    while (p) { if (sels.some((s) => matchOne(p, s))) return p; p = p.parentElement; }
    return null;
  }
  contains(n) { return this._all().includes(n); }
}

function matchOne(n, s) {
  if (!n || !s) return false;
  const tagName = String(n.tagName || 'div').toLowerCase();
  const className = String(n.className || '');
  const attrs = n.attrs || {};
  const m = /^([a-zA-Z]*)/.exec(s);
  const tag = (m && m[1] || '').toLowerCase();
  const rest = s.slice(tag.length);
  if (tag && tagName !== tag) return false;
  const classes = Array.from(rest.matchAll(/\.([A-Za-z0-9_-]+)/g)).map((x) => x[1]);
  for (const c of classes) {
    if (!(' ' + className + ' ').includes(' ' + c + ' ')) return false;
  }
  const attrPart = rest.replace(/\.[A-Za-z0-9_-]+/g, '');
  for (const am of attrPart.matchAll(/\[([^\]]+)\]/g)) {
    const body = am[1];
    let mm = /^([A-Za-z0-9_-]+)\s*=\s*["']?([^"']*)["']?$/.exec(body);
    if (mm) { if (String(attrs[mm[1]] != null ? attrs[mm[1]] : '') !== mm[2]) return false; continue; }
    mm = /^([A-Za-z0-9_-]+)\s*\*=\s*["']?([^"']*)["']?$/.exec(body);
    if (mm) { if (!String(attrs[mm[1]] != null ? attrs[mm[1]] : '').includes(mm[2])) return false; continue; }
    mm = /^([A-Za-z0-9_-]+)$/.exec(body);
    if (mm) { if (attrs[mm[1]] == null) return false; continue; }
    return false;
  }
  return true;
}

// ---------- 消息总线 ----------
const contexts = {};
const listenersOf = (name) => contexts[name].listeners;

let offscreenDocumentExists = false;
let runtimeSendCount = 0;
let clipboardBytes = 0;
let clipboardWrites = [];
let clipboardTypes = [];
let clipboardTextPayload = null;
let downloadedFiles = [];
let windowOpenCount = 0;   // 1.3.1：成功回写回复框时不应再打开 intent 页
let scenario = {};

const serialize = (v) => JSON.parse(JSON.stringify(v));

/* 1.3.3：标签刷新 / 新建标签的等待循环在测试里加速，否则单个场景要等十几秒。
 * 只压缩 >=200ms 的延时，短延时保持原样，不影响逻辑断言。 */
const fastSetTimeout = (fn, ms, ...args) => setTimeout(fn, Number(ms) >= 200 ? 5 : ms, ...args);

function makeChrome(name) {
  return {
    runtime: {
      id: 'wbx-fake-extension-id',
      getManifest: () => ({ version: '0.3.4-test' }),
      onMessage: { addListener: (fn) => listenersOf(name).push(fn) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      getURL: (p) => 'chrome-extension://fake/' + p,
      sendMessage: (msg, cb) => runtimeSend(name, msg, cb),
      lastError: undefined
    },
    tabs: {
      // 页面模式：复用/新建 x.com 的 Grok 标签；sendMessage 同时支持 callback 与 Promise 两种写法
      query: (q) => Promise.resolve((scenario.pageTabs || []).slice()),
      get: (id) => Promise.resolve((scenario.pageTabs || []).find((t) => t.id === id) || { id }),
      create: (o) => {
        const t = { id: 88, url: o && o.url };
        scenario.pageTabs = (scenario.pageTabs || []).concat([t]);
        note('tabs', 'create ' + t.url);
        scenario.createdTabs = (scenario.createdTabs || []).concat([t.id]);
        return Promise.resolve(t);
      },
      reload: (id) => {
        note('tabs', 'reload ' + id);
        scenario.reloadedTabs = (scenario.reloadedTabs || []).concat([id]);
        // 默认「刷新即修复」：清掉该标签的孤儿脚本标记
        if (scenario.reloadHeals !== false) {
          scenario.tabUnreachable = (scenario.tabUnreachable || []).filter((x) => x !== id);
          scenario.tabNoInput = (scenario.tabNoInput || []).filter((x) => x !== id);
          delete scenario.failBridgeAction;   // 刷新后正式消息也恢复
        }
        return Promise.resolve();
      },
      sendMessage: (tabId, msg, cb) => {
        if (!cb) return tabsSend(name, tabId, msg);
        return tabsSend(name, tabId, msg).then((v) => {
          try { cb(v); } catch (e) { note('ERROR', 'tabs.sendMessage cb threw: ' + e.message); }
        }, (e) => {
          contexts[name].chrome.runtime.lastError = { message: String(e && e.message || e) };
          try { cb(undefined); } catch (e2) {}
          delete contexts[name].chrome.runtime.lastError;
        });
      }
    },
    storage: {
      sync: {
        get: (keys, cb) => {
          const extra = Object.assign({},
            scenario.hashMode ? { hashMode: scenario.hashMode } : {},
            scenario.appendSignature ? { appendSignature: true } : {},
            scenario.appendSource ? { appendSource: true } : {},
            scenario.inpaintImages === false ? { inpaintImages: false } : {},
            scenario.inpaintVideo === false ? { inpaintVideo: false } : {},
            scenario.grokMode ? { grokMode: scenario.grokMode } : {},
            scenario.grokPreferNative === false ? { grokPreferNative: false } : {},
            scenario.grokPageAutoSubmit === false ? { grokPageAutoSubmit: false } : {},
            scenario.grokPageNewChat === false ? { grokPageNewChat: false } : {},
            scenario.pagePromptExtra ? { pagePromptExtra: scenario.pagePromptExtra } : {});
          // 1.4.1 迁移用数组键读取；其余场景保持原来的「默认值 + 覆盖值」语义
          if (Array.isArray(keys)) {
            const store = scenario.storageSync || {};
            const out = {};
            keys.forEach((k) => {
              if (k in store) out[k] = store[k];
              else if (k in extra) out[k] = extra[k];
            });
            return cb(out);
          }
          return cb(Object.assign({}, keys, extra));
        },
        set: (obj, cb) => {
          scenario.storageSync = Object.assign({}, scenario.storageSync || {}, obj);
          scenario.storageSets = (scenario.storageSets || 0) + 1;
          if (typeof cb === 'function') cb();
        }
      },
      local: {
        get: (defaults, cb) => cb(Object.assign({}, defaults,
          scenario.grokApiKey ? { grokApiKey: scenario.grokApiKey } : {}))
      }
    },
    downloads: {
      download: (o) => {
        if (scenario.downloadsFail) {
          note('download', 'downloads API REJECTED（模拟 blob URL 无法解析）');
          return Promise.reject(new Error('blob URL not resolvable'));
        }
        note('download', o.filename);
        downloadedFiles.push(o.filename || '');
        return Promise.resolve(1);
      }
    },
    declarativeNetRequest: {
      updateDynamicRules: () => Promise.resolve(),
      getDynamicRules: () => Promise.resolve([1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009].map((id) => ({ id })))
    },
    offscreen: {
      hasDocument: () => Promise.resolve(offscreenDocumentExists),
      createDocument: (o) => {
        note('offscreen', 'createDocument reasons=' + JSON.stringify(o.reasons));
        // 官方 chrome.offscreen.Reason 枚举（严格按 developer.chrome.com 文档）
        const VALID = new Set([
          'TESTING','AUDIO_PLAYBACK','IFRAME_SCRIPTING','DOM_SCRAPING','BLOBS','DOM_PARSER',
          'USER_MEDIA','DISPLAY_MEDIA','WEB_RTC','CLIPBOARD','LOCAL_STORAGE','WORKERS',
          'BATTERY_STATUS','MATCH_MEDIA','GEOLOCATION'
        ]);
        for (const r of o.reasons) {
          if (!VALID.has(r)) {
            note('offscreen', 'INVALID REASON: ' + r);
            return Promise.reject(new Error("Invalid value '" + r + "' for reasons"));
          }
        }
        offscreenDocumentExists = true;
        loadOffscreen();
        return Promise.resolve();
      },
      closeDocument: () => { offscreenDocumentExists = false; return Promise.resolve(); }
    }
  };
}

async function runtimeSend(from, msg, cb) {
  runtimeSendCount++;
  msg = serialize(msg);
  note('bus', `${from} --runtime.sendMessage(${msg.type})--> all`);
  if (msg.type === 'CROSSPOST') {
    const p = msg.payload || {};
    note('bus', `  CROSSPOST payload: text="${p.text}" imageUrls=${(p.imageUrls || []).length} videoUrls=${(p.videoUrls || []).length} hasVideo=${p.hasVideo} bid=${p.bid || '-'} inpaint=${p.inpaint && p.inpaint.enabled} inpaintVideo=${p.inpaintVideo}`);
  }
  if (msg.type === 'PROCESS_OFFSCREEN' && /statuses\/show|\.mp4/.test(JSON.stringify(msg.payload || {}))) {
    note('bus', '  PROCESS_OFFSCREEN 含视频信息');
  }
  const sender = { id: 'fake-ext', tab: from === 'content' ? { id: 42 } : undefined };
  const targets = Object.keys(contexts).filter((n) => n !== from);
  let responded = false;
  let responseVal;
  let resolveResponse;
  const responsePromise = new Promise((r) => { resolveResponse = r; });
  const sendResponse = (v) => {
    if (!responded) { responded = true; responseVal = serialize(v); resolveResponse(responseVal); }
  };
  const keepAlive = [];
  for (const name of targets) {
    for (const fn of listenersOf(name)) {
      let r;
      try { r = fn(msg, sender, sendResponse); }
      catch (e) { note('ERROR', `${name} listener threw on ${msg.type}: ${e && e.message}`); }
      if (r === true) keepAlive.push(name);
    }
  }
  if (keepAlive.length && !responded) {
    // 页面模式会跨标签走一轮消息，给异步回包留足时间（正常场景会立即 resolve）
    await Promise.race([responsePromise, new Promise((r) => setTimeout(r, 1500))]);
  }
  const noResponse = !responded;
  const errMsg = 'The message port closed before a response was received.';
  if (cb) {
    if (noResponse) contexts[from].chrome.runtime.lastError = { message: errMsg };
    try { cb(responseVal); } catch (e) { note('ERROR', `${from} callback threw: ${e && e.message}`); }
    delete contexts[from].chrome.runtime.lastError;
    return undefined;
  }
  if (noResponse) return Promise.reject(new Error(errMsg));
  return Promise.resolve(responseVal);
}

async function tabsSend(from, tabId, msg) {
  note('bus', `${from} --tabs.sendMessage(tab=${tabId}, ${msg.type})--> content`);
  // 1.3.3：模拟扩展重载后的孤儿 content script（Chrome 原生报错）
  if ((scenario.tabUnreachable || []).indexOf(tabId) !== -1) {
    return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
  }
  // ping 正常、正式发送时才失效（模拟用户在两次消息之间刷新/关闭了标签）
  if (msg.type === 'GROK_PAGE_BRIDGE' && scenario.failBridgeAction === msg.action &&
      (scenario.failBridgeTabs || []).indexOf(tabId) !== -1) {
    return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
  }
  if (msg.type === 'GROK_PAGE_BRIDGE' && msg.action === 'ping' &&
      (scenario.tabNoInput || []).indexOf(tabId) !== -1) {
    return Promise.resolve({ ok: true, url: 'https://x.com/i/grok', hasInput: false, hasSend: false });
  }
  // 1.4.0 站内直连：模拟 X 页面 MAIN world 里 grok-native.js 的回包
  if (msg.type === 'GROK_NATIVE_PING' || msg.type === 'GROK_NATIVE_CHECK' || msg.type === 'GROK_NATIVE_CALL') {
    scenario.nativeCalls = (scenario.nativeCalls || 0) + 1;
    if ((scenario.nativeUnreachable || []).indexOf(tabId) !== -1) {
      return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    }
    if (msg.type === 'GROK_NATIVE_PING') {
      return Promise.resolve({ ok: true, status: { ready: true, hasSession: true, hasWebpack: true } });
    }
    if (msg.type === 'GROK_NATIVE_CHECK') {
      return Promise.resolve({ ok: true, check: { ok: true, via: 'x-ondemand', txLen: 48 } });
    }
    if (typeof scenario.nativeHandler === 'function') return Promise.resolve(serialize(scenario.nativeHandler(msg)));
    return Promise.resolve({
      ok: true,
      comments: ['角度一：认同并补充', '角度二：提个问题', '角度三：独立观点'],
      raw: '```\n角度一：认同并补充\n```\n```\n角度二：提个问题\n```\n```\n角度三：独立观点\n```',
      via: 'x-ondemand'
    });
  }
  // 页面模式：模拟 x.com 里 grok-page.js 的回包（含思考过程 / 模板 JSON 等噪声）
  if (msg.type === 'GROK_PAGE_BRIDGE') {
    scenario.pageBridgeCalls = (scenario.pageBridgeCalls || 0) + 1;
    if (typeof scenario.grokPageHandler === 'function') {
      return Promise.resolve(serialize(scenario.grokPageHandler(msg)));
    }
    const url = 'https://x.com/i/grok';
    if (msg.action === 'ping') return Promise.resolve({ ok: true, url, hasInput: true, hasSend: true, hasRoot: true });
    if (msg.action === 'prepare') return Promise.resolve({ ok: true, prepared: true, prompt: msg.prompt, url, hasSend: true });
    const answer = scenario.grokPageAnswer != null ? scenario.grokPageAnswer :
      '```json\n["角度一：认同并补充","角度二：提个问题","角度三：独立观点"]\n```';
    return Promise.resolve({
      ok: true, text: answer, allText: scenario.grokPageAllText != null ? scenario.grokPageAllText : answer,
      candidates: scenario.grokPageCandidates || [], url, submitBy: 'button', stable: 'quiet', changed: true
    });
  }
  const sender = { id: 'fake-ext' };
  let responded = false;
  let responseVal;
  const sendResponse = (v) => { if (!responded) { responded = true; responseVal = v; } };
  for (const fn of listenersOf('content')) {
    try { fn(msg, sender, sendResponse); }
    catch (e) { note('ERROR', `content listener threw on ${msg.type}: ${e && e.message}`); }
  }
  if (!responded) return Promise.reject(new Error('The message port closed before a response was received.'));
  return Promise.resolve(responseVal);
}

// ---------- 各上下文 globals ----------
function baseGlobals(name) {
  const chrome = makeChrome(name);
  contexts[name] = { listeners: [], chrome };
  return {
    console: {
      log: (...a) => note(name, a.join(' ')),
      warn: (...a) => note(name + '/WARN', a.join(' ')),
      error: (...a) => note(name + '/ERR', a.join(' '))
    },
    chrome,
    Blob: FakeBlob,
    URL: FakeURLWithCtor,
    ClipboardItem,
    setTimeout: fastSetTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    navigator: {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
      clipboard: {
        write: (items) => {
          const fail = scenario.clipboardFail || (name === 'content' && scenario.contentClipboardFail);
          if (fail) {
            const err = new Error('Document is not focused / write permission denied');
            err.name = 'NotAllowedError';
            note(name + '/clipboard', 'write() REJECTED NotAllowedError');
            return Promise.reject(err);
          }
          const reps = (items[0] && items[0].items) || {};
          const types = Object.keys(reps);
          // 真实 Chrome 对 video/mp4 写入常抛 NotAllowedError，用来验证渐进降级
          if (types.includes('video/mp4')) {
            note(name + '/clipboard', 'write() REJECTED video/mp4 (unsupported type)');
            const e = new Error('Type video/mp4 not supported on write');
            e.name = 'NotAllowedError';
            return Promise.reject(e);
          }
          const pngBlob = reps['image/png'];
          const textBlob = reps['text/plain'];
          const part = pngBlob && pngBlob.parts && pngBlob.parts[0];
          const len = part && part.byteLength != null ? part.byteLength : (part && part.length) || 0;
          note(name + '/clipboard', `write() types=[${types.join(',')}] pngBytes=${len}`);
          clipboardBytes = len;
          clipboardTypes = types;
          if (textBlob) clipboardTextPayload = String((textBlob.parts && textBlob.parts[0]) || '');
          clipboardWrites.push(name);
          return Promise.resolve();
        },
        writeText: (t) => {
          note(name + '/clipboard', 'writeText() len=' + (t || '').length);
          clipboardTextPayload = String(t || '');
          clipboardTypes = ['text/plain'];
          return Promise.resolve();
        }
      }
    },
    window: {
      open: (u) => { note('window', 'open() -> ' + String(u)); windowOpenCount++; return {}; },
      addEventListener: () => {}
    },
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: (url) => {
      const u = String(url || '');
      if (/m\.weibo\.cn\/statuses\/show/.test(u)) {
        note('offscreen', 'fetch 公开接口 statuses/show?bid=' + (u.split('id=')[1] || ''));
        return Promise.resolve({
          ok: !scenario.apiFail,
          status: scenario.apiFail ? 432 : 200,
          json: () => Promise.resolve({ data: { page_info: { media_info: {
            stream_url_hd: 'https://f.video.weibocdn.com/o0/from_api.mp4?Expires=1&ssig=abc'
          } } } }),
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0))
        });
      }
      if (/\.mp4/.test(u)) {
        note('offscreen', 'fetch 视频 ' + u.slice(0, 70));
        return Promise.resolve({
          ok: !scenario.videoFetchFail,
          status: scenario.videoFetchFail ? 403 : 200,
          blob: () => Promise.resolve(new FakeBlob([new ArrayBuffer(2048)], { type: 'video/mp4' })),
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(32))
        });
      }
      return Promise.resolve({
        ok: !scenario.fetchFail,
        status: scenario.fetchFail ? 403 : 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(32)),
        blob: () => Promise.resolve(new FakeBlob([new ArrayBuffer(32)])),
        json: () => Promise.resolve({})
      });
    },
    // 1.3.1 回写兜底路径会派发 InputEvent('input')
    Event: class { constructor(type, opts) { this.type = type; Object.assign(this, opts || {}); } },
    InputEvent: class { constructor(type, opts) { this.type = type; Object.assign(this, opts || {}); } },
    createImageBitmap: () => Promise.resolve({ width: 100, height: 100, close() {} }),
    OffscreenCanvas: class {
      constructor(w, h) {
        this.width = w; this.height = h;
        const d = new Uint8ClampedArray(w * h * 4).fill(120);
        for (let i = 3; i < d.length; i += 4) d[i] = 255;
        // 模拟底部一条白色文字水印（稀疏笔画，覆盖率落在合理区间）
        if (scenario.fakeWatermark) {
          const x0 = Math.floor(w * 0.62), x1 = Math.floor(w * 0.78);
          const y0 = Math.floor(h * 0.93), y1 = Math.floor(h * 0.97);
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            if ((x + y) % 3 !== 0) continue;
            const i = (y * w + x) * 4;
            d[i] = 250; d[i + 1] = 250; d[i + 2] = 250; d[i + 3] = 255;
          }
        }
        this._d = d;
      }
      getContext() {
        const self = this;
        return {
          drawImage() {},
          getImageData: () => ({ width: self.width, height: self.height, data: self._d }),
          putImageData() {}
        };
      }
      convertToBlob() { return Promise.resolve(new FakeBlob([new ArrayBuffer(8)], { type: 'image/png' })); }
    }
  };
}

function makeDom() {
  const nodes = {};
  const mk = (id, tag) => {
    const n = new MiniNode(tag || 'div');
    n.id = id;
    n.remove = () => {
      if (n.parentElement) {
        const arr = n.parentElement.children;
        const i = arr.indexOf(n);
        if (i >= 0) arr.splice(i, 1);
      }
      Object.keys(nodes).forEach((k) => { if (nodes[k] === n) delete nodes[k]; });
    };
    if (String(tag).toLowerCase() === 'canvas') {
      n.getContext = () => ({ fillStyle: '', fillRect() {}, drawImage() {} });
      n.toBlob = (cb) => cb(new FakeBlob([new ArrayBuffer(16)], { type: 'image/png' }));
    }
    return n;
  };
  // 1.3.1 起 document 要是真 DOM 树：回复框按钮注入靠 querySelectorAll 全页扫描
  const root = new MiniNode('body');
  root.id = 'body';
  const rootAppend = root.appendChild.bind(root);
  root.appendChild = (n) => { if (n && n.id) nodes[n.id] = n; return rootAppend(n); };
  const doc = {
    readyState: 'complete',
    head: { appendChild() {} },
    body: root,
    createElement: (tag) => mk('new-' + tag, tag),
    getElementById: (id) => nodes[id] || null,
    querySelectorAll: (sel) => root.querySelectorAll(sel),
    querySelector: (sel) => root.querySelector(sel),
    addEventListener: () => {},
    activeElement: null,
    // execCommand('insertText') 是写回 X contenteditable 的主路径
    execCommand: (cmd, ui, text) => {
      const el = doc.activeElement;
      if (cmd !== 'insertText' || !el) return false;
      const cur = String(el.innerText || el.textContent || '');
      el.innerText = cur + String(text);
      el.textContent = el.innerText;
      (doc._inserted || (doc._inserted = [])).push(String(text));
      return true;
    },
    _nodes: nodes,
    _root: root
  };
  globalThis.__wbxFocusHook = (n) => { doc.activeElement = n; };
  return doc;
}

let contentCtx, bgCtx, offCtx, dom;

function loadContent() {
  dom = makeDom();
  const g = Object.assign(baseGlobals('content'), {
    document: dom, self: undefined,
    // 站点适配层由域名驱动；测试可注入任意站点域名与路径
    WBX_TEST_HOST: scenario.hostname || 'weibo.com',
    WBX_TEST_PATH: scenario.path || '/'
  });
  contentCtx = vm.createContext(g);
  vm.runInContext(read('account.js'), contentCtx, { filename: 'account.js' });
  vm.runInContext(read('sites.js'), contentCtx, { filename: 'sites.js' });
  vm.runInContext(read('content.js'), contentCtx, { filename: 'content.js' });
  const orig = contentCtx.handleResult;
  contentCtx.handleResult = function (msg) {
    note('content', `handleResult() 收到: type=${msg.type} results=${(msg.results || []).length} clipOk=${msg.clipboardOk} clipText=${msg.clipboardText} media=${msg.clipboardMedia} video=${msg.video && msg.video.ok} error=${msg.error || '无'}`);
    return orig(msg);
  };
}

function loadBackground() {
  bgCtx = vm.createContext(baseGlobals('background'));
  // 真实 SW 用 importScripts('grok.js')；vm 里直接预加载同一份共享层，保证 TapeAI 可用
  vm.runInContext(read('grok.js'), bgCtx, { filename: 'grok.js' });
  vm.runInContext(read('background.js'), bgCtx, { filename: 'background.js' });
}

function loadOffscreen() {
  const g = Object.assign(baseGlobals('offscreen'), {
    document: {
      createElement: () => ({
        href: '', download: '',
        click() {
          note('offscreen', '<a download> 触发 -> ' + this.download);
          downloadedFiles.push(this.download || '');
        },
        remove() {}
      }),
      body: { appendChild() {} }
    }
  });
  offCtx = vm.createContext(g);
  vm.runInContext(read('inpaint.js'), offCtx, { filename: 'inpaint.js' });
  vm.runInContext(read('offscreen.js'), offCtx, { filename: 'offscreen.js' });
}

// ---------- 多站点夹具 ----------
/* 每个站用该站真实的类名 + 图床域名构造卡片，验证站点配置层是否真的生效 */
const SITE_FIXTURES = {
  zhihu: {
    hostname: 'www.zhihu.com', cardClass: 'ContentItem', textTag: 'p', textClass: 'RichText',
    mediaClass: 'RichText', imgAttr: 'data-original',
    avatar: 'https://pic1.zhimg.com/avatar/u123.jpg',
    img: (i) => `https://pic${i + 1}.zhimg.com/80/v2-site${i}.jpg?source=test`
  },
  wechat: {
    hostname: 'mp.weixin.qq.com', cardClass: 'rich_media_content', textTag: 'p', textClass: 'rich_media_content',
    mediaClass: 'rich_media_content', imgAttr: 'data-src',
    avatar: 'https://mmbiz.qlogo.cn/mmbiz_jpg/aaa/0',
    img: (i) => `https://mmbiz.qpic.cn/mmbiz_jpg/site${i}/640?wx_fmt=jpeg`
  },
  bilibili: {
    hostname: 't.bilibili.com', cardClass: 'bili-dyn-item', textTag: 'div', textClass: 'bili-dyn-content__orig__desc',
    mediaClass: 'bili-album', imgAttr: 'src',
    avatar: 'https://i0.hdslb.com/bfs/face/xyz.jpg',
    img: (i) => `https://i${i}.hdslb.com/bfs/dyn/site${i}.jpg@320w.webp`
  },
  douban: {
    hostname: 'www.douban.com', cardClass: 'status-item', textTag: 'div', textClass: 'status-saying',
    mediaClass: 'status-photo', imgAttr: 'src',
    avatar: 'https://img1.doubanio.com/view/photo/icon_public/u123.jpg',
    img: (i) => `https://img${i + 1}.doubanio.com/view/photo/l_ratio_poster/public/p${i}.jpg`
  },
  xiaohongshu: {
    hostname: 'www.xiaohongshu.com', cardClass: 'note-item', textTag: 'div', textClass: 'desc',
    mediaClass: 'swiper-slide', imgAttr: 'src',
    avatar: 'https://sns-avatar-qc.xhscdn.com/abc.jpg',
    img: (i) => `https://sns-webpic-qc.xhscdn.com/2026/site${i}.jpg!nd_dft_wlteh_webp_3?sign=abc${i}`
  },
  x: {
    hostname: 'x.com', cardClass: 'tweet', textTag: 'div', textClass: 'tweetText',
    cardAttrs: { 'data-testid': 'tweet' },
    textAttrs: { 'data-testid': 'tweetText' },
    mediaClass: 'tweetPhoto', mediaAttrs: { 'data-testid': 'tweetPhoto' },
    imgAttr: 'src',
    // 头像走 profile_images，内容图走 /media/：域名层就能分开
    avatar: 'https://pbs.twimg.com/profile_images/123/avatar.jpg',
    img: (i) => `https://pbs.twimg.com/media/Gsite${i}?format=jpg&name=small`
  }
};

function makeSiteCard(cfg) {
  const f = SITE_FIXTURES[cfg.site];
  const card = new MiniNode('div', { className: f.cardClass, attrs: f.cardAttrs });
  const reco = new MiniNode('div', { className: 'wbx-empty' });
  const header = new MiniNode('div', { className: 'wbx-header' });
  header.appendChild(new MiniNode('img', { attrs: { src: f.avatar } }));
  card.appendChild(reco);
  card.appendChild(header);
  const textNode = new MiniNode(f.textTag, {
    className: f.textClass, text: cfg.text, attrs: f.textAttrs
  });
  card.appendChild(textNode);
  const media = new MiniNode('div', { className: f.mediaClass, attrs: f.mediaAttrs });
  for (let i = 0; i < (cfg.imageCount || 0); i++) {
    const attrs = { src: 'data:image/gif;base64,AAAA' };
    attrs[f.imgAttr] = f.img(i);
    media.appendChild(new MiniNode('img', { attrs }));
  }
  card.appendChild(media);
  const tools = new MiniNode('div', { className: 'wbx-tools' });
  card.appendChild(tools);
  // X 推文卡片里带时间戳 permalink（/用户/status/ID），用于「附原文链接」
  if (cfg.sourceLink) {
    card.appendChild(new MiniNode('a', { attrs: { href: cfg.sourceLink } }));
  }
  return { card, textNode, reco, header, media, tools };
}

async function runSiteScenario(name, cfg) {
  resetWorld();
  const f = SITE_FIXTURES[cfg.site];
  scenario = Object.assign({}, cfg, { hostname: f.hostname });
  loadBackground();
  loadContent();
  note('TEST', `--- 站点场景：${name} ---`);
  const built = makeSiteCard(cfg);
  contentCtx.__card = built.card;
  contentCtx.__btn = { disabled: false, textContent: '', title: '', type: '', className: '', addEventListener() {}, appendChild() {} };

  let post = null;
  try { post = vm.runInContext('resolvePost(__card)', contentCtx, { timeout: 3000 }); }
  catch (e) { note('ERROR', 'resolvePost 抛错: ' + (e && e.message)); }
  if (post) note('parse', `site=${vm.runInContext('SITE && SITE.id', contentCtx)} text="${post.text}" images=${post.imageUrls.length} bid=${post.bid}`);

  try { await vm.runInContext('onRepost(__card, __btn)', contentCtx, { timeout: 5000 }); }
  catch (e) { note('ERROR', 'onRepost 抛错: ' + (e && e.message)); }
  await new Promise((r) => setTimeout(r, 400));

  // 多图时 X 由托盘按钮打开（微博之外的站点同样走这条链路）
  const gallery = dom._nodes['wbx-gallery'];
  let openByBtn = false;
  if (gallery) {
    const btn = gallery._all().find((n) => n.className === 'wbx-g-open');
    if (btn && btn._handlers && btn._handlers.click) {
      const before = log.filter((l) => /window.*open\(\) -> https:\/\//.test(l)).length;
      await btn._handlers.click();
      openByBtn = log.filter((l) => /window.*open\(\) -> https:\/\//.test(l)).length > before;
    }
  }

  const joined = log.join('\n');
  const payloadText = (/CROSSPOST payload: text="([^"]*)"/.exec(joined) || [])[1] || '__MISSING__';
  const urlMatch = /\[window\] open\(\) -> (\S+)/.exec(joined);
  let xText = null;
  if (urlMatch && urlMatch[1].includes('text=')) {
    try { xText = decodeURIComponent((urlMatch[1].split('text=')[1] || '').split('&')[0]); } catch (e) {}
  }
  const expectedText = cfg.expectText || cfg.text;
  const checks = {
    '站点配置命中': vm.runInContext('SITE && SITE.id', contentCtx) === cfg.site,
    '正文提取': !!post && post.text === cfg.text,
    '内容图数量': !!post && post.imageUrls.length === (cfg.imageCount || 0),
    '头像已排除': !!post && !post.imageUrls.some((u) => /avatar|face|qlogo|icon_public/i.test(u)),
    '不误请求微博接口': !!post && post.bid === null,
    '签名query保留': !cfg.expectQuery || (!!post && (post.imageUrls[0] || '').includes(cfg.expectQuery)),
    // X 缩略图 name=small 必须升级成 name=orig，同时保留 format 参数
    'X原图升级': cfg.site !== 'x' ? null : !!post && post.imageUrls.length > 0 &&
      post.imageUrls.every((u) => /name=orig/.test(u) && /format=jpg/.test(u)),
    '转发正文不清洗': payloadText === expectedText,
    'X预填正文': xText === expectedText,
    '不跑微博去水印': /CROSSPOST payload:[\s\S]*?inpaint=false/.test(joined),
    '不跑微博视频HD': /CROSSPOST payload:[\s\S]*?inpaintVideo=false/.test(joined),
    '完整链路打通': /handleResult\(\) 收到: type=RESULT/.test(joined) &&
      /window.*open\(\) -> https:\/\//.test(joined),
    '多图托盘可用': cfg.imageCount > 1
      ? (!!gallery && gallery.getAttribute('data-wbx-count') === String(cfg.imageCount) && openByBtn)
      : null,
    '无致命错误': !/offscreen 未就绪|离屏文档创建失败|INVALID REASON|发送失败|ERROR|WARN|处理失败：/.test(joined)
  };
  let ok = true;
  const parts = [];
  for (const [k, v] of Object.entries(checks)) {
    parts.push(`${k}=${v === null ? '— 跳过' : (v ? '✅' : '❌')}`);
    if (v === false) ok = false;
  }
  note('CHECK', parts.join('  '));
  note('CHECK', ok ? '站点场景 PASS ✅' : '站点场景 FAIL ❌');
  if (!ok || process.env.WBX_VERBOSE) console.log(log.join('\n') + '\n');
  return ok;
}

/* X 专属守卫：发布页不自注入、permalink 解析、name=orig 原图、来源开关 */
async function runXGuards() {
  const checks = {};
  const boot = async (host, path, appendSource) => {
    resetWorld();
    scenario = { hostname: host, path: path || '/', appendSource: !!appendSource };
    loadContent();
    await vm.runInContext('loadSettings()', contentCtx);
  };

  await boot('x.com', '/intent/tweet');
  checks['X发推页不注入'] = vm.runInContext('isXIntentPage()', contentCtx) === true;
  await boot('x.com', '/i/flow/login');
  checks['X登录流程页不注入'] = vm.runInContext('isXIntentPage()', contentCtx) === true;
  await boot('weibo.com', '/intent/tweet');
  checks['非X站守卫不误伤'] = vm.runInContext('isXIntentPage()', contentCtx) === false;

  await boot('x.com', '/home');
  checks['X时间线正常扫描'] = vm.runInContext('isXIntentPage()', contentCtx) === false;
  await boot('x.com', '/compose/post');
  checks['回复弹窗页不注入卡片按钮'] = vm.runInContext('isXIntentPage()', contentCtx) === true;
  await boot('x.com', '/home'); // 恢复时间线上下文，下面的断言不受影响

  // 引用推文比主推文长：按 DOM 顺序必须取第一个 tweetText
  const quoteCard = new MiniNode('article', { attrs: { 'data-testid': 'tweet' } });
  quoteCard.appendChild(new MiniNode('div', {
    attrs: { 'data-testid': 'tweetText' }, text: '主推文正文，这才是本条要转发的内容。'
  }));
  quoteCard.appendChild(new MiniNode('div', {
    attrs: { 'data-testid': 'tweetText' },
    text: '被引用推文的正文故意写得非常长非常长非常长非常长非常长非常长非常长。'
  }));
  contentCtx.__quoteCard = quoteCard;
  checks['引用推文不抢正文'] = vm.runInContext(
    'findTextNode(__quoteCard) === __quoteCard.children[0]', contentCtx) === true;

  const relCard = makeSiteCard({
    site: 'x', text: '正文', imageCount: 1, sourceLink: '/someuser/status/1234567890'
  }).card;
  const absCard = makeSiteCard({
    site: 'x', text: '正文', imageCount: 0,
    sourceLink: 'https://twitter.com/user2/status/9876543210'
  }).card;
  contentCtx.__relCard = relCard;
  contentCtx.__absCard = absCard;
  checks['相对permalink'] = vm.runInContext('extractPermalink(__relCard)', contentCtx) ===
    'https://x.com/someuser/status/1234567890';
  checks['绝对permalink'] = vm.runInContext('extractPermalink(__absCard)', contentCtx) ===
    'https://x.com/user2/status/9876543210';
  checks['开关关闭不附来源'] = vm.runInContext('withSource("正文", __relCard)', contentCtx) === '正文';
  checks['name=small升级为orig'] = vm.runInContext(
    'upgradeImageUrl("https://pbs.twimg.com/media/Gabc?format=jpg&name=small")', contentCtx) ===
    'https://pbs.twimg.com/media/Gabc?format=jpg&name=orig';
  checks['无query时补格式参数'] = /format=jpg&name=orig/.test(vm.runInContext(
    'upgradeImageUrl("https://pbs.twimg.com/media/Gabc.jpg")', contentCtx));

  await boot('x.com', '/home', true);
  contentCtx.__relCard = relCard;
  checks['开关打开附原推链接'] = vm.runInContext('withSource("正文", __relCard)', contentCtx) ===
    '正文\n\n原文：https://x.com/someuser/status/1234567890';

  await boot('weibo.com', '/', true);
  contentCtx.__relCard = relCard;
  checks['非X站不附来源'] = vm.runInContext('withSource("正文", __relCard)', contentCtx) === '正文';

  const ok = Object.values(checks).every(Boolean);
  console.log('[CHECK] X 专属守卫：' + (ok ? 'PASS ✅' : 'FAIL ❌'));
  console.log('  ' + Object.entries(checks).map(([k, v]) => `${k}=${v ? '✅' : '❌'}`).join('  '));
  if (!ok || process.env.WBX_VERBOSE) console.log(log.join('\n') + '\n');
  return ok;
}

/* ---------- v1.3.0：非 API 模式（X 站内 Grok）共享逻辑 ---------- */
function runPageModeChecks() {
  const T = require('./grok.js');
  const checks = [];
  const A = (name, fn) => {
    let ok = false;
    try { ok = !!fn(); } catch (e) { note('ERROR', name + ': ' + (e && e.message)); }
    checks.push({ name, ok });
  };

  A('页面模式默认选择器与 x.com/i/grok 实测结构一致', () => {
    const d = T.PAGE_MODE_DEFAULTS;
    return d.grokPageUrl === 'https://x.com/i/grok' &&
      d.grokPageInputSel.includes('div[aria-label="Ask anything"][role="textbox"]') &&
      d.grokPageSendSel.includes('button[aria-label="Send"]') &&
      d.grokPageRootSel.includes('div[aria-label="Grok"]') &&
      d.grokPageAnswerSel.includes('button[aria-label="Copy"]') &&
      d.grokPageAutoSubmit === true && d.grokPageQuietMs >= 400 && d.grokPageTimeoutMs >= 5000;
  });
  A('auto 模式：没填 Key 自动降级页面模式，填了 Key 走 API', () =>
    T.pickGrokMode({ grokMode: 'auto', grokApiKey: '' }) === 'page' &&
    T.pickGrokMode({ grokMode: 'auto', grokApiKey: 'xai-test' }) === 'api');
  A('强制 page / 非法模式回退 auto', () =>
    T.pickGrokMode({ grokMode: 'page', grokApiKey: 'xai-test' }) === 'page' &&
    T.pickGrokMode({ grokMode: 'wat', grokApiKey: '' }) === 'page' &&
    T.pickGrokMode({}) === 'page');
  A('页面提示词把 system 合并进单条消息并追加 JSON 约束', () => {
    const p = T.buildPagePrompt(T.buildCommentMessages('推文正文测试', null), '');
    return p.includes('【必须遵守的指令】') && p.includes(T.SYSTEM_HINT) &&
      p.includes('推文正文测试') && p.includes('不要展示思考过程') &&
      p.indexOf('{POST}') === -1;
  });
  A('页面模式附加要求可自定义并拼到末尾', () => {
    const p = T.buildPagePrompt(T.buildCommentMessages('正文', null), '请全程用中文');
    return p.includes('请全程用中文') && p.indexOf('请全程用中文') > p.indexOf(T.PROMPT_TAG) &&
      p.trim().endsWith(T.PROMPT_END);
  });
  A('1.3.2 页面提示词带唯一任务标记与结束标记', () => {
    const p = T.buildPagePrompt(T.buildCommentMessages('正文', null), '');
    return p.startsWith(T.PROMPT_TAG) && p.trim().endsWith(T.PROMPT_END) &&
      p.indexOf(T.PROMPT_TAG) === p.lastIndexOf(T.PROMPT_TAG);
  });
  A('1.3.2 cleanPageAnswer 切掉提示词区块', () => {
    const p = T.buildPagePrompt(T.buildCommentMessages('原文推文', null), '');
    const cleaned = T.cleanPageAnswer(p + '\n["真候选一","真候选二","真候选三"]');
    return !cleaned.includes('必须遵守的指令') && !cleaned.includes('原文推文') &&
      cleaned.includes('真候选一');
  });
  A('1.3.2 X 侧栏词被识别为 UI 噪声', () =>
    T.isPageNoiseLine('History') && T.isPageNoiseLine('Usage') &&
    T.isPageNoiseLine('Share') && T.isPageNoiseLine('Thought for 7s') &&
    !T.isPageNoiseLine('这条推文的观点确实值得商榷'));
  A('1.3.2 页面噪声不再被解析成 3 条评论（1.3.1 事故回归）', () => {
    const noise = 'History\nUsage\nShare\nNew chat\n' +
      T.buildPagePrompt(T.buildCommentMessages('推文', null), '') + '\nThought for 7s';
    return T.parsePageAnswer(noise, 'comments').length === 0;
  });
  A('1.3.2 Grok 只回一句自然语言时不伪造候选', () =>
    T.parsePageAnswer('"确实看到越来越多AI生成的评论，信息密度低还容易同质化。"', 'comments').length === 0);
  A('1.3.2 网页 Grok 输出裸引号列表（无方括号）时仍取出 3 条', () => {
    const raw = 'Thought for 7s\n"确实看到越来越多AI生成的评论，信息密度低还容易同质化，真人讨论反而显得珍贵。", ' +
      '"有没有比较靠谱的办法能快速判断一条评论是不是AI写的？", ' +
      '"评论区堆满AI回复后，反而更想念以前那种吵吵闹闹的真实讨论。"';
    const out = T.parsePageAnswer(raw, 'comments');
    return out.length === 3 && /真人讨论/.test(out[0]) && /真实讨论/.test(out[2]);
  });
  A('1.3.2 网页 Grok 用编号列表输出时仍能取出 3 条', () => {
    const out = T.parsePageAnswer(
      '1. 这个观点很新颖，想请教数据来源和统计口径是什么？\n' +
      '2. 从链上索引的角度看，确实还有不少可优化空间。\n' +
      '3. 同意楼主判断，但落地节奏可能比想象中更慢。', 'comments');
    return out.length === 3 && /数据来源/.test(out[0]);
  });
  A('自定义提示词在页面模式下依然生效', () => {
    const p = T.buildPagePrompt(T.buildCommentMessages('正文XYZ', '写三条短评：{POST}'), '');
    return p.includes('写三条短评：正文XYZ');
  });
  A('宽松解析跳过提示词里的评论模板 JSON', () => {
    const noisy = '提示词样例 ["第一条","第二条","第三条"]，最终答案：["甲","乙","丙"]';
    const hit = T.extractJsonLoose(noisy, 'comments');
    return !!hit && hit.value[0] === '甲';
  });
  A('宽松解析跳过 verdict 枚举模板 JSON', () => {
    const noisy = '模板 {"verdict":"official|community|fake|unknown"}，结论 {"verdict":"fake","reason":"形近域名"}';
    const hit = T.extractJsonLoose(noisy, 'verdict');
    return !!hit && hit.value.verdict === 'fake';
  });
  A('宽松解析从「思考过程 + Markdown 代码块」里取最终答案', () => {
    const noisy = '让我想想……\n```json\n["观点一","问题二","补充三"]\n```\n以上。';
    const c = T.parsePageResult(noisy, 'comments');
    return c.length === 3 && c[0] === '观点一';
  });
  A('宽松解析跳过字符串内部的括号', () => {
    const noisy = '说明：数组里可以有 { 和 } 符号。\n["带 {括号} 的回复","第二条","第三条"]';
    const hit = T.extractJsonLoose(noisy, 'comments');
    return !!hit && hit.value[0] === '带 {括号} 的回复';
  });
  A('宽松解析核验结论并保留 reason / risk', () => {
    const noisy = '思考中……\n{"verdict":"fake","reason":"不在清单","risk":"别连钱包","matched":""}';
    const v = T.parsePageResult(noisy, 'verdict');
    return v.parsed === true && v.verdict === 'fake' && v.risk === '别连钱包';
  });
  A('没有 JSON 时按原文兜底且标记解析失败', () => {
    const v = T.parsePageResult('模型只说了一段话', 'verdict');
    return v.parsed === false && v.verdict === 'unknown';
  });
  A('核验提示词中的本地结论在页面模式下仍然注入', () => {
    const p = T.buildPagePrompt(T.buildVerifyMessages('https://tapeout-net.com/', null), '');
    return p.includes('未命中本地白名单') && p.includes('tapeout-net.com') &&
      p.includes('【输出格式') && p.indexOf('{LOCAL_RESULT}') === -1;
  });
  return checks;
}

/* ---------- v1.3.0：grok-page.js 的 DOM 定位与回答回溯 ---------- */
function runPageBridgeDomChecks() {
  const checks = [];
  const A = (name, fn) => {
    let ok = false;
    try { ok = !!fn(); } catch (e) { note('ERROR', name + ': ' + (e && e.message)); }
    checks.push({ name, ok });
  };
  const bridge = require('./grok-page.js');
  const fakeEl = (o) => Object.assign({
    innerText: '', textContent: '', tagName: 'DIV', disabled: false,
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
    parentElement: null, previousElementSibling: null,
    getAttribute: () => null, isContentEditable: false
  }, o || {});

  A('桥接脚本默认选择器与实测 x.com/i/grok 一致', () =>
    bridge.DEFAULT_CFG.grokPageInputSel.includes('div[aria-label="Ask anything"][role="textbox"]') &&
    bridge.DEFAULT_CFG.grokPageSendSel.includes('button[aria-label="Send"]') &&
    bridge.DEFAULT_CFG.grokPageAnswerSel.includes('button[aria-label="Copy"]'));
  A('cfgOf 处理字符串 false 与数值上下限', () => {
    const c = bridge.cfgOf({ grokPageAutoSubmit: 'false', grokPageTimeoutMs: 10, grokPageQuietMs: 999999 });
    return c.grokPageAutoSubmit === false && c.grokPageTimeoutMs === 5000 &&
      c.grokPageQuietMs === 10000 && c.grokPageMaxChars === 8000;
  });

  // 模拟实测结构：回答 div 与「复制回答」按钮是相邻兄弟
  const answerDiv = fakeEl({ innerText: '["回答一","回答二","回答三"]' });
  const msgWrap = fakeEl({ innerText: '用户提问\n["回答一","回答二","回答三"]\n复制' });
  const bar = fakeEl({ innerText: '', previousElementSibling: answerDiv, parentElement: msgWrap });
  const copyBtn = fakeEl({ parentElement: bar });
  const root = fakeEl({ innerText: msgWrap.innerText });
  msgWrap.parentElement = root;
  const input = fakeEl({ innerText: '', attrs: { role: 'textbox' } });

  const prevDoc = global.document;
  global.document = {
    querySelectorAll(sel) {
      if (/Copy|grok-answer/.test(sel)) return [copyBtn];
      if (/Grok|conversation/.test(sel)) return [root];
      if (/Ask anything|grok-input/.test(sel)) return [input];
      if (/Send|grok-send/.test(sel)) return [fakeEl({ tagName: 'BUTTON' })];
      return [];
    },
    querySelector(sel) { const a = this.querySelectorAll(sel); return a[0] || null; }
  };
  try {
    const cfg = bridge.cfgOf({});
    A('回答锚点（Copy 按钮）能回溯到真正的回答文本', () => {
      const r = bridge.answerText(cfg);
      return r.answer.includes('回答一') && r.allText.includes('用户提问');
    });
    A('多候选选择器里某个片段非法时不影响其它片段', () => {
      const c = bridge.cfgOf({ grokPageInputSel: '[[[bad, div[aria-label="Ask anything"][role="textbox"]' });
      return bridge.find(c.grokPageInputSel) === input;
    });
    A('输入框 / 发送按钮 / 对话根都能按候选选择器定位', () =>
      !!bridge.find(cfg.grokPageInputSel) && !!bridge.find(cfg.grokPageSendSel) &&
      !!bridge.find(cfg.grokPageRootSel) && bridge.findAll(cfg.grokPageAnswerSel).length === 1);
  } finally {
    if (prevDoc === undefined) delete global.document;
    else global.document = prevDoc;
  }
  return checks;
}

/* ---------- 1.3.2：提示词写入不得污染 Grok 输入框 ---------- */
function runPromptWriteChecks() {
  const checks = [];
  const A = (name, fn) => {
    let ok = false;
    try { ok = !!fn(); } catch (e) { note('ERROR', name + ': ' + (e && e.message)); }
    checks.push({ name, ok });
  };
  const bridge = require('./grok-page.js');
  const T = require('./grok.js');
  const tag = T.PROMPT_TAG;
  const prompt = tag + '\n【必须遵守的指令】\n写三条回复\n' + T.PROMPT_END;
  const calls = [];
  const box = {
    tagName: 'DIV', isContentEditable: true, innerText: '', textContent: '',
    getAttribute: () => 'textbox', focus() { calls.push('focus'); },
    appendChild() {}, dispatchEvent() {}
  };
  const prevDoc = global.document, prevWin = global.window, prevIE = global.InputEvent;
  global.InputEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
  global.window = {
    getSelection: () => ({
      removeAllRanges() {},
      addRange(r) { calls.push('addRange:' + (r && r._box === box)); }
    })
  };
  global.document = {
    createRange: () => ({ _box: null, selectNodeContents(el) { this._box = el; calls.push('selectNodeContents'); } }),
    execCommand: (cmd, ui, text) => {
      calls.push(cmd);
      if (cmd === 'delete') { box.innerText = ''; box.textContent = ''; return true; }
      if (cmd === 'insertText') { box.innerText = text; box.textContent = text; return true; }
      return false;
    },
    body: { innerText: '' }
  };
  try {
    const cfg = bridge.cfgOf({});
    A('setPrompt 写入后输入框内容与提示词完全一致', () => {
      bridge.setPrompt(box, prompt, cfg, tag);
      return box.innerText === prompt;
    });
    A('1.3.2 绝不再调用 execCommand selectAll（污染根源）', () => !calls.includes('selectAll'));
    A('1.3.2 选区只覆盖 Grok 输入框内部', () =>
      calls.includes('selectNodeContents') && calls.includes('addRange:true'));
    A('verifyPrompt 接受干净提示词', () => bridge.verifyPrompt(box, prompt, tag) === true);

    // 模拟 1.3.1 的事故：selectAll 把整页文字带进输入框
    global.document.execCommand = (cmd, ui, text) => {
      calls.push(cmd);
      if (cmd === 'delete') return true;
      if (cmd === 'insertText') {
        const dirty = 'History Usage Share AI 评论 AI 评论 ' + String(text);
        box.innerText = dirty; box.textContent = dirty;
        return true;
      }
      return false;
    };
    A('1.3.2 提示词被页面文字污染时拒绝发送', () => {
      let threw = false;
      try { bridge.setPrompt(box, prompt, cfg, tag); }
      catch (e) { threw = /校验失败/.test(String(e && e.message || e)); }
      return threw;
    });
    A('verifyPrompt 拒绝前置噪声与超长内容', () =>
      bridge.verifyPrompt({ innerText: 'HistoryUsage ' + prompt, tagName: 'DIV' }, prompt, tag) === false);
  } finally {
    if (prevDoc === undefined) delete global.document; else global.document = prevDoc;
    if (prevWin === undefined) delete global.window; else global.window = prevWin;
    if (prevIE === undefined) delete global.InputEvent; else global.InputEvent = prevIE;
  }
  return checks;
}

/* ---------- v1.3.0：页面模式端到端消息链路（mock x.com Grok 回包） ---------- */
async function runPageModeEndToEnd() {
  const checks = [];
  const A = (name, ok) => checks.push({ name, ok: !!ok });
  const prev = scenario;
  const pageTabs = [{ id: 77, url: 'https://x.com/i/grok' }];
  try {
    scenario = { grokMode: 'page', grokPreferNative: false, pageTabs: pageTabs.slice() };

    let r = await runtimeSend('popup', { type: 'GROK_TEST' });
    A('页面模式「测试当前模式」返回 mode=page 且不发起真实提问',
      r && r.ok && r.mode === 'page' && /已连接/.test(r.sample || ''));

    r = await runtimeSend('popup', { type: 'GROK_COMMENTS', payload: { text: '一条测试推文', statusId: '123' } });
    A('页面模式 AI 评论返回 3 条候选并带 strict 标记',
      r && r.ok && r.mode === 'page' && r.comments && r.comments.length === 3 && r.strict === true);

    scenario.grokPageAnswer = '（回答块为空）';
    scenario.grokPageAllText = '思考过程……模板 ["第一条","第二条","第三条"]\n最终答案：\n```json\n["甲观点","乙问题","丙补充"]\n```';
    r = await runtimeSend('popup', { type: 'GROK_COMMENTS', payload: { text: '推文' } });
    A('网页 Grok 混入思考过程与模板时仍能提取最终 3 条',
      r && r.ok && r.comments && r.comments.length === 3 && r.comments[0] === '甲观点');

    r = await runtimeSend('popup', { type: 'GROK_PAGE_PREPARE', payload: { kind: 'comments', text: '示例推文' } });
    A('手动兜底①：准备提示词含 system 约束、正文与格式要求',
      r && r.ok && r.prompt && r.prompt.includes('【必须遵守的指令】') &&
      r.prompt.includes('示例推文') && r.prompt.includes('只输出上面要求的那一个 JSON'));

    scenario.grokPageAnswer = '["读回一","读回二","读回三"]';
    scenario.grokPageAllText = scenario.grokPageAnswer;
    r = await runtimeSend('popup', { type: 'GROK_PAGE_READ', payload: { kind: 'comments' } });
    A('手动兜底②：读取 Grok 回答解析出 3 条候选',
      r && r.ok && r.comments && r.comments.length === 3 && r.comments[0] === '读回一' && r.mode === 'page');

    scenario.grokPageAnswer = '{"verdict":"official","reason":"我觉得是官方","risk":"","matched":""}';
    scenario.grokPageAllText = scenario.grokPageAnswer;
    r = await runtimeSend('popup', { type: 'GROK_VERIFY', payload: { url: 'https://tapeout-net.com/' } });
    A('页面模式核验：本地未命中，模型判 official 也不能给绿标',
      r && r.mode === 'page' && r.local && r.local.status !== 'official' &&
      r.grok && r.grok.verdict === 'official' && r.ok === true);

    r = await runtimeSend('popup', { type: 'GROK_VERIFY', payload: { url: 'https://tapeout.net/' } });
    A('页面模式核验：官网命中仍按本地清单给 official',
      r && r.local && r.local.status === 'official' && r.local.tier === 'official');

    scenario.grokPageHandler = (msg) => msg.action === 'ping'
      ? { ok: true, hasInput: true, url: 'https://x.com/i/grok' }
      : { ok: true, prepared: true, prompt: msg.prompt, url: 'https://x.com/i/grok', note: '只填词' };
    r = await runtimeSend('popup', { type: 'GROK_COMMENTS', payload: { text: '推文' } });
    A('设为「不自动发送」时返回 prepared 指引而不是静默失败',
      r && r.ok === false && r.prepared === true && /读取 Grok 回答/.test(r.error || ''));

    // ---------- 1.3.2：真机事故回归 ----------
    const TPage = require('./grok.js');
    const noisePage = 'History\nUsage\nShare\nNew chat\n' + TPage.PROMPT_TAG +
      '\n【必须遵守的指令】\n写三条回复\n' + TPage.PROMPT_END + '\nThought for 7s';
    let lastBridge = null;
    scenario.grokPageHandler = (msg) => {
      lastBridge = msg;
      if (msg.action === 'ping') return { ok: true, hasInput: true, url: 'https://x.com/i/grok' };
      return {
        ok: true, text: '', allText: noisePage, candidates: [],
        url: 'https://x.com/i/grok', hasAnswer: false, promptSent: true,
        changed: false, stable: 'no-change', submitBy: 'button'
      };
    };
    r = await runtimeSend('popup', { type: 'GROK_COMMENTS', payload: { text: '推文' } });
    A('1.3.2 桥接消息带唯一任务标记', !!lastBridge && lastBridge.tag === TPage.PROMPT_TAG);
    A('1.3.2 没读到 Grok 回答时明确报错，不再静默返回假候选',
      r && r.ok === false && /没读到 Grok 的回答块|没返回可用结果/.test(r.error || ''));

    // 旧版桥接回包（没有 hasAnswer 字段）也不能把侧栏词解析成候选
    scenario.grokPageHandler = (msg) => {
      if (msg.action === 'ping') return { ok: true, hasInput: true, url: 'https://x.com/i/grok' };
      return {
        ok: true, text: '', allText: noisePage, candidates: [],
        url: 'https://x.com/i/grok', promptSent: true,
        changed: true, stable: 'quiet', submitBy: 'button'
      };
    };
    r = await runtimeSend('popup', { type: 'GROK_COMMENTS', payload: { text: '推文' } });
    A('1.3.2 侧栏噪声不再变成 History/Usage/Share 三条候选',
      r && r.ok === false && !/History|Usage|Share/.test(JSON.stringify(r.comments || [])));

    // 真机回放：回答块是裸引号列表，整页 innerText 混着侧栏词和提示词
    const realAnswer = 'Thought for 7s\n' +
      '"确实看到越来越多AI生成的评论，信息密度低还容易同质化，真人讨论反而显得珍贵。", ' +
      '"有没有比较靠谱的办法能快速判断一条评论是不是AI写的？", ' +
      '"评论区堆满AI回复后，反而更想念以前那种吵吵闹闹的真实讨论。"';
    scenario.grokPageHandler = (msg) => {
      if (msg.action === 'ping') return { ok: true, hasInput: true, url: 'https://x.com/i/grok' };
      return {
        ok: true, text: realAnswer,
        allText: 'History\nUsage\nShare\nNew chat\n' + TPage.PROMPT_TAG +
          '\n【必须遵守的指令】\n写三条回复\n' + TPage.PROMPT_END + '\n' + realAnswer,
        candidates: [], url: 'https://x.com/i/grok', hasAnswer: true, promptSent: true,
        changed: true, stable: 'quiet', submitBy: 'button'
      };
    };
    r = await runtimeSend('popup', { type: 'GROK_COMMENTS', payload: { text: '推文' } });
    A('1.3.2 真机回放：整页混噪声时仍返回 Grok 的 3 条中文候选',
      r && r.ok === true && r.comments && r.comments.length === 3 &&
      /真人讨论/.test(r.comments[0]) && !r.comments.some((c) => /^(History|Usage|Share)$/.test(c)));
    A('1.3.2 结果带诊断信息（是否真的读到 Grok 回答）',
      r && r.diagnostics && r.diagnostics.hasAnswer === true && r.diagnostics.promptSent === true);

    delete scenario.grokPageHandler;
    scenario = { grokMode: 'auto', grokApiKey: '', pageTabs: pageTabs.slice() };
    r = await runtimeSend('popup', { type: 'GROK_TEST' });
    A('auto 且没填 Key 不调用 xAI API', r && r.ok && r.mode !== 'api');
    A('1.4.0 auto 自检优先汇报站内直连通道', r && r.mode === 'native');

    scenario = { grokMode: 'page', grokApiKey: 'xai-test', grokPreferNative: false, pageTabs: pageTabs.slice() };
    r = await runtimeSend('popup', { type: 'GROK_TEST' });
    A('强制页面模式即使填了 Key 也不调用 API', r && r.ok && r.mode === 'page');
  } catch (e) {
    note('ERROR', '页面模式端到端异常: ' + (e && e.message));
    A('页面模式端到端无异常抛出', false);
  } finally {
    scenario = prev;
  }
  return checks;
}

/* ---------- 1.3.3：扩展重载后失效 X 标签（孤儿 content script）的连接恢复 ---------- */
async function runStaleTabRecoveryChecks() {
  const checks = [];
  const A = (name, ok) => checks.push({ name, ok: !!ok });
  const prev = scenario;
  // 真机同款：1.3.1 后台新建、重载扩展后没刷新的旧 Grok 对话标签
  const grokTab = () => [{ id: 77, url: 'https://x.com/i/grok?conversation=0b17a677' }];
  const english = /Receiving end does not exist|Could not establish connection/;
  try {
    // A：1.3.2 事故回放 —— 旧标签 ping 不通，旧版会把这个坏标签返回并抛英文错误
    scenario = { grokMode: 'page', grokPreferNative: false, pageTabs: grokTab(), tabUnreachable: [77] };
    let r = await runtimeSend('popup', { type: 'GROK_COMMENTS', payload: { text: '一条测试推文' } });
    A('1.3.3 旧 Grok 标签失效时自动刷新并成功生成 3 条候选',
      r && r.ok === true && r.comments && r.comments.length === 3);
    A('1.3.3 自动刷新过失效标签', (scenario.reloadedTabs || []).indexOf(77) !== -1);
    A('1.3.3 不再把 Chrome 原生英文错误抛给用户', !english.test(String((r && r.error) || '')));

    // B：刷新也救不回来 → 强制新建一个干净标签（新标签必定注入当前实例脚本）
    scenario = { grokMode: 'page', grokPreferNative: false, pageTabs: grokTab(), tabUnreachable: [77], reloadHeals: false };
    r = await runtimeSend('popup', { type: 'GROK_COMMENTS', payload: { text: '推文' } });
    A('1.3.3 刷新无效时新建标签兜底并返回候选',
      r && r.ok === true && r.comments && r.comments.length === 3);
    A('1.3.3 确实新建了 Grok 标签', (scenario.createdTabs || []).indexOf(88) !== -1);

    // C：新旧标签全失效 → 中文可操作指引，而不是英文原生报错
    scenario = { grokMode: 'page', pageTabs: grokTab(), tabUnreachable: [77, 88], reloadHeals: false };
    r = await runtimeSend('popup', { type: 'GROK_COMMENTS', payload: { text: '推文' } });
    A('1.3.3 完全连不上时返回中文指引',
      r && r.ok === false && /刷新所有 X 页面|重建 Grok 标签/.test(r.error || ''));
    A('1.3.3 完全连不上时也不残留英文原生错误', !english.test(String((r && r.error) || '')));

    // D：ping 通过、正式发送那一刻脚本才失效 → callGrokPage 自身刷新重试
    scenario = { grokMode: 'page', pageTabs: grokTab(), failBridgeAction: 'auto', failBridgeTabs: [77] };
    r = await runtimeSend('popup', { type: 'GROK_COMMENTS', payload: { text: '推文' } });
    A('1.3.3 正式发送时标签失效也能刷新重试成功',
      r && r.ok === true && r.comments && r.comments.length === 3);
    A('1.3.3 发送阶段失效触发了刷新', (scenario.reloadedTabs || []).indexOf(77) !== -1);

    // E：设置面板「重建 Grok 标签」一键修复
    scenario = { grokMode: 'page', grokPreferNative: false, pageTabs: grokTab(), tabUnreachable: [77] };
    r = await runtimeSend('popup', { type: 'GROK_PAGE_RESET' });
    A('1.3.3「重建 Grok 标签」返回可用输入框',
      r && r.ok === true && r.hasInput === true && r.reloaded >= 1);
    A('1.3.3「重建 Grok 标签」确实刷新了旧页面',
      (scenario.reloadedTabs || []).indexOf(77) !== -1);

    // F：连接测试同样能自愈
    scenario = { grokMode: 'page', grokPreferNative: false, pageTabs: grokTab(), tabUnreachable: [77] };
    r = await runtimeSend('popup', { type: 'GROK_TEST' });
    A('1.3.3「测试当前模式」在失效标签下也能自愈', r && r.ok === true && r.mode === 'page');
  } catch (e) {
    note('ERROR', '失效标签恢复检查异常: ' + (e && e.message));
    A('1.3.3 失效标签恢复检查无异常抛出', false);
  } finally {
    scenario = prev;
  }
  return checks;
}

/* ---------- v1.1.0：Grok 共享逻辑 / 官方白名单防伪 / X 评论按钮 ---------- */
/* ---------- 1.4.0：站内直连 Grok（直接调 X 自带接口） ---------- */
function makeNativeCtx(opts) {
  opts = opts || {};
  const state = { fetchCalls: [], xvmCalls: [] };
  const g = {
    window: {
      addEventListener: () => {},
      postMessage: () => {},
      fetch: (url, init) => {
        state.fetchCalls.push({ url: String(url), init });
        return typeof opts.fetch === 'function'
          ? opts.fetch(state.fetchCalls.length, url, init)
          : Promise.resolve({ ok: true });
      },
      webpackChunk_twitter_responsive_web: []
    },
    document: { cookie: 'ct0=fake-ct0-token; other=1' },
    navigator: { language: 'zh-CN' },
    crypto: { randomUUID: () => '11111111-2222-4333-8444-555555555555' },
    AbortController: function () { this.abort = () => {}; this.signal = {}; },
    TextDecoder,
    DOMParser: function () {},
    setTimeout, clearTimeout,
    console: { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    __testState: state
  };
  if (opts.xvmGrok) g.window.__xvmGrok = opts.xvmGrok(state);
  if (opts.xvmNet) g.window.__xvmNet = opts.xvmNet(state);
  if (opts.xvmXct) g.window.__xvmXct = opts.xvmXct(state);
  const ctx = vm.createContext(g);
  vm.runInContext(read('grok-native.js'), ctx, { filename: 'grok-native.js' });
  return ctx;
}

/* 1.4.2 真机事故回放：站内直连返回 HTTP 401。模拟 XVM 通道、实时 bearer、
 * 401 响应体、公开 bearer 重试与自有签名器，锁住修复后的完整链路。 */
async function runAuth401Checks() {
  const checks = [];
  const A = (name, ok) => checks.push({ name, ok: !!ok });
  const run = (ctx, expr) => vm.runInContext(expr, ctx, { timeout: 5000 });
  const NDJSON_OK = JSON.stringify({
    result: {
      sender: 'ASSISTANT',
      message: '```\n回落候选一内容\n```\n```\n回落候选二内容\n```\n```\n回落候选三内容\n```',
      messageTag: 'final'
    }
  }) + '\n';
  const okRes = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(NDJSON_OK) });
  const errRes = () => Promise.resolve({
    ok: false, status: 401, statusText: 'Unauthorized',
    text: () => Promise.resolve('{"errors":[{"code":32,"message":"Could not authenticate you."}]}'),
    body: { cancel: () => {} }
  });
  const fakeXct = () => ({ generateTxId: () => Promise.resolve('fake-tx-id-1234567890') });

  try {
    // A：页面里已装 XVM → 直接复用它稳定的通道，自有 fetch 完全不发
    const xvmCtx = makeNativeCtx({
      xvmGrok: (state) => ({ generate: (o) => {
        state.xvmCalls.push(o);
        return Promise.resolve(['认同并补充一点', '这个角度有意思', '想问下后续怎么走']);
      } })
    });
    const borrowed = await run(xvmCtx, 'window.__tapeGrokNative.generate("【TapePost 任务开始】完整提示词")');
    A('1.4.2 复用 XVM 通道并返回 3 条候选',
      borrowed && borrowed.comments && borrowed.comments.length === 3 && borrowed.via === 'xvm-grok');
    A('1.4.2 借用 XVM 时不再发自有直连请求', run(xvmCtx, '__testState.fetchCalls.length') === 0);
    A('1.4.2 借用 XVM 时完整提示词原样透传',
      /完整提示词/.test(run(xvmCtx, '__testState.xvmCalls[0].tweetText')));
    A('1.4.2 借用 XVM 使用占位符透传模板',
      run(xvmCtx, '__testState.xvmCalls[0].promptTemplate') === '[推文内容]');
    A('1.4.2 状态报告能识别 XVM 通道', run(xvmCtx, 'window.__tapeGrokNative.status().hasXvmGrok') === true);

    // B：XVM 抛错 → 安静回落到自有直连，仍能出结果
    const fbCtx = makeNativeCtx({
      xvmGrok: () => ({ generate: () => Promise.reject(new Error('XVM 未就绪')) }),
      xvmXct: fakeXct, fetch: () => okRes()
    });
    const fallback = await run(fbCtx, 'window.__tapeGrokNative.generate("回落提示词")');
    A('1.4.2 XVM 失败后回落自有直连', fallback && fallback.comments && fallback.comments.length === 3);

    // C：实时 bearer 优先级与强制公开 bearer
    const lbCtx = makeNativeCtx({ xvmNet: () => ({ getBearer: () => 'Bearer LIVE-XVM' }) });
    const hLive = await run(lbCtx, 'window.__tapeGrokNative.buildHeaders("tx-fake-1234567890")');
    const hPub = await run(lbCtx, 'window.__tapeGrokNative.buildHeaders("tx-fake-1234567890", true)');
    A('1.4.2 优先使用 XVM 的实时 bearer', hLive.authorization === 'Bearer LIVE-XVM');
    A('1.4.2 可强制切回 X 网页客户端公开 bearer', /^Bearer AAAA/.test(hPub.authorization));
    A('1.4.2 公开 bearer 与实时 bearer 确实不同', hLive.authorization !== hPub.authorization);

    // D：真机 401 → 读出 X 错误体并用公开 bearer 自动重试成功
    const r401 = makeNativeCtx({ xvmXct: fakeXct, fetch: (n) => (n === 1 ? errRes() : okRes()) });
    run(r401, 'window.__tapeGrokNative._remember("https://x.com/i/api/graphql", ' +
      '{headers:{authorization:"Bearer STALE-HOOK"}})');
    const healed = await run(r401, 'window.__tapeGrokNative.generate("401 提示词")');
    A('1.4.2 401 后公开 bearer 重试成功并返回候选',
      healed && healed.comments && healed.comments.length === 3 && healed.via === 'public-bearer');
    A('1.4.2 401 确实触发了第二次请求', run(r401, '__testState.fetchCalls.length') === 2);
    A('1.4.2 第一次用捕获 bearer、第二次用公开 bearer',
      run(r401, '__testState.fetchCalls[0].init.headers.authorization') === 'Bearer STALE-HOOK' &&
      /^Bearer AAAA/.test(run(r401, '__testState.fetchCalls[1].init.headers.authorization')));

    // E：重试仍 401 → 错误里带 X 的真实返回体，不再笼统说「请重新登录」
    const r401b = makeNativeCtx({ xvmXct: fakeXct, fetch: () => errRes() });
    run(r401b, 'window.__tapeGrokNative._remember("https://x.com/i/api/graphql", ' +
      '{headers:{authorization:"Bearer STALE-HOOK"}})');
    let msg401 = '';
    try { await run(r401b, 'window.__tapeGrokNative.generate("401 提示词")'); }
    catch (e) { msg401 = String(e && e.message || e); }
    A('1.4.2 401 错误带出 X 返回的真实原因', /Could not authenticate you/.test(msg401));
    A('1.4.2 401 错误标明已尝试两种 bearer', /公开 bearer/.test(msg401) && /HTTP 401/.test(msg401));
    A('1.4.2 401 不再用误导性的「请重新登录 X」结论', !/请重新登录 X 后刷新页面/.test(msg401));

    // F：XVM 捕获的真实签名也能被自有链路复用
    const txCtx = makeNativeCtx({ xvmGrok: () => ({ __capturedTxId: 'xvm-captured-tx-1234567890' }) });
    A('1.4.2 能复用 XVM 捕获的 X-UI 真实签名',
      run(txCtx, 'window.__tapeGrokNative.status().xvmCapturedTx') === true &&
      run(txCtx, 'window.__tapeGrokNative.status().capturedTx') === true);
  } catch (e) {
    A('1.4.2 401 修复检查无异常抛出', false);
    note('ERROR', '401 修复检查异常: ' + (e && e.message));
  }
  return checks;
}

async function runNativePureChecks() {
  const checks = [];
  const A = (name, ok) => checks.push({ name, ok: !!ok });
  let nctx;
  try { nctx = makeNativeCtx(); }
  catch (e) { A('grok-native.js 可在页面上下文加载', false); return checks; }
  const N = (expr) => vm.runInContext(expr, nctx, { timeout: 3000 });
  const J = (fn, val) => N('window.__tapeGrokNative.' + fn + '(' + JSON.stringify(val) + ')');
  const P = (expr) => vm.runInContext(expr, bgCtx, { timeout: 3000 });

  A('grok-native.js 暴露站内直连接口', N('typeof window.__tapeGrokNative.generate') === 'function');
  A('接口指向 X 自带 Grok 流式端点',
    N('window.__tapeGrokNative.ENDPOINT') === 'https://grok.x.com/2/grok/add_response.json');

  // --- NDJSON：只认 ASSISTANT / final，思考过程与用户气泡一律不算回答 ---
  const ndjson = [
    JSON.stringify({ result: { sender: 'USER', message: '我的提示词', messageTag: 'final' } }),
    JSON.stringify({ result: { sender: 'ASSISTANT', message: '让我想想…', messageTag: 'thinking' } }),
    JSON.stringify({ result: { sender: 'ASSISTANT', message: '```\n第一条中文评论\n```\n', messageTag: 'final' } }),
    JSON.stringify({ result: { sender: 'ASSISTANT', message: '```\n第二条中文评论\n```\n```\n第三条中文评论\n```', messageTag: 'final' } }),
    'not-json'
  ].join('\n');
  const finalText = J('extractFinalText', ndjson);
  A('只拼接最终回答块', /第一条中文评论/.test(finalText) && /第三条中文评论/.test(finalText));
  A('思考过程不进入最终答案', !/让我想想/.test(finalText));
  A('用户提示词不进入最终答案', !/我的提示词/.test(finalText));
  A('非 JSON 行被忽略', !/not-json/.test(finalText));
  A('NDJSON 直接解析出 3 条候选', (J('extractComments', ndjson) || []).length === 3);

  // --- 候选解析：代码块 > JSON > 列表，噪声与空回答绝不凑数 ---
  const blocks = '```\n角度一：认同并补充\n```\n```\n角度二：提个问题\n```\n```\n角度三：独立观点\n```';
  const c1 = J('extractComments', blocks);
  A('3 个代码块解析成 3 条候选', c1.length === 3 && /认同/.test(c1[0]) && /独立观点/.test(c1[2]));
  A('单个代码块内 3 行也能拆开', (J('extractComments', '```\n第一条中文评论\n第二条中文评论\n第三条中文评论\n```') || []).length === 3);
  A('JSON 数组解析', (J('extractComments', '["甲评论内容","乙评论内容","丙评论内容"]') || []).length === 3);
  A('编号列表解析', (J('extractComments', '1. 第一条中文评论内容\n2. 第二条中文评论内容\n3. 第三条中文评论内容') || []).length === 3);
  A('侧栏 UI 词不再变成假候选', (J('extractComments', 'History\nUsage\nShare') || []).length === 0);
  A('代码块里的 UI 词同样被过滤',
    (J('extractComments', '```\nHistory\n```\n```\nUsage\n```\n```\nShare\n```') || []).length === 0);
  A('空回答返回空数组', (J('extractComments', '') || []).length === 0);
  A('任务标记不当候选', (J('extractComments', '【TapePost 任务开始】\n【TapePost 任务结束】') || []).length === 0);

  // --- 请求体 / 请求头 ---
  let body;
  try { body = JSON.parse(J('buildBody', '测试提示词')); } catch (e) { body = {}; }
  A('请求体带上完整提示词', body.responses && body.responses[0] && body.responses[0].message === '测试提示词');
  A('临时对话不污染 Grok 历史', body.isTemporaryChat === true && body.requestFeatures && body.requestFeatures.serverHistory === false);
  A('关闭搜索 / 引用 / 配图以缩短等待',
    body.returnSearchResults === false && body.returnCitations === false && body.imageGenerationCount === 0);
  A('会话 ID 是雪花数字串', /^\d{10,}$/.test(String(body.conversationId || '')));

  let h = {};
  try { h = await N('window.__tapeGrokNative.buildHeaders("tx-fake-1234567890")'); } catch (e) {}
  A('请求头带签名', h['x-client-transaction-id'] === 'tx-fake-1234567890');
  A('请求头带 X 会话 ct0', h['x-csrf-token'] === 'fake-ct0-token');
  A('请求头带 OAuth2 会话标记', h['x-twitter-auth-type'] === 'OAuth2Session' && /^Bearer /.test(h.authorization || ''));
  N('document.cookie = ""');
  let noSession = false;
  try { await N('window.__tapeGrokNative.buildHeaders("tx")'); }
  catch (e) { noSession = /ct0|登录/.test(String(e && e.message || e)); }
  A('没有 X 会话时明确报错而不是盲目发请求', noSession);
  N('document.cookie = "ct0=fake-ct0-token"');

  N('window.__tapeGrokNative._remember("https://grok.x.com/2/grok/add_response.json", ' +
    '{headers:{"authorization":"Bearer LIVE","x-client-transaction-id":"captured-tx-1234567890","x-csrf-token":"live-ct0"}})');
  A('能捕获 X 自己发出的实时签名', N('window.__tapeGrokNative.status().capturedTx') === true);
  A('能捕获 X 自己发出的实时 bearer', N('window.__tapeGrokNative.status().capturedBearer') === true);
  A('状态报告反映登录会话', N('window.__tapeGrokNative.status().hasSession') === true);

  // --- 模式路由与直连提示词（grok.js） ---
  A('显式 native 模式', P("TapeAI.pickGrokMode({grokMode:'native'})") === 'native');
  A('auto 在 X 标签优先站内直连',
    P("TapeAI.pickGrokMode({grokMode:'auto',grokApiKey:''},{inXTab:true})") === 'native');
  A('auto 在 X 标签但填了 Key 仍走 API',
    P("TapeAI.pickGrokMode({grokMode:'auto',grokApiKey:'xai-x'},{inXTab:true})") === 'api');
  A('关掉「优先直连」后 auto 恢复页面模式',
    P("TapeAI.pickGrokMode({grokMode:'auto',grokPreferNative:false},{inXTab:true})") === 'page');
  A('不在 X 标签时 auto 保持旧行为',
    P("TapeAI.pickGrokMode({grokMode:'auto',grokApiKey:''})") === 'page');
  A('非法模式值回落 auto',
    P("TapeAI.pickGrokMode({grokMode:'wat'},{inXTab:true})") === 'native');
  A('强制页面模式不受直连影响',
    P("TapeAI.pickGrokMode({grokMode:'page',grokApiKey:'x'},{inXTab:true})") === 'page');
  // 1.4.1 真机事故回放：老设置 grokMode="page" 让 1.4.0 的直连一次都没走过
  A('1.4.1 旧 page 设置在 X 标签里升级为直连',
    P("TapeAI.pickGrokMode({grokMode:'page',grokApiKey:''},{inXTab:true})") === 'native');
  A('1.4.1 旧 page 设置在非 X 标签仍是页面兜底',
    P("TapeAI.pickGrokMode({grokMode:'page',grokApiKey:''})") === 'page');
  A('1.4.1 用户关掉优先直连时旧 page 保持 page',
    P("TapeAI.pickGrokMode({grokMode:'page',grokPreferNative:false},{inXTab:true})") === 'page');
  A('1.4.1 显式 api 不被直连升级',
    P("TapeAI.pickGrokMode({grokMode:'api',grokApiKey:'xai-x'},{inXTab:true})") === 'api');

  const prompt = P("TapeAI.buildNativePrompt(TapeAI.buildCommentMessages('给自己放了一个小假 东京之旅结束',''),'comments','')");
  A('直连提示词含真实推文正文', /东京之旅结束/.test(prompt));
  A('直连提示词要求 3 个代码块', /3 个 Markdown 代码块/.test(prompt));
  A('直连提示词带唯一任务标记', prompt.indexOf('【TapePost 任务开始】') === 0);
  A('直连提示词不再要求单一 JSON', !/只输出上面要求的那一个 JSON/.test(prompt));
  const custom = P("TapeAI.buildNativePrompt(TapeAI.buildCommentMessages('推文A','请用粤语写 {POST} 的三条回复'),'comments','请全程中文')");
  A('自定义评论提示词与附加要求都生效', /粤语/.test(custom) && /推文A/.test(custom) && /请全程中文/.test(custom));
  const vp = P("TapeAI.buildNativePrompt(TapeAI.buildVerifyMessages('https://tapeout.net/',''),'verify','')");
  A('核验提示词要求 JSON verdict', /verdict/.test(vp) && !/3 个 Markdown 代码块/.test(vp));
  return checks;
}

async function runNativeEndToEnd() {
  const checks = [];
  const A = (name, ok) => checks.push({ name, ok: !!ok });
  const prev = scenario;
  const tabs = () => [{ id: 42, url: 'https://x.com/home' }, { id: 43, url: 'https://x.com/i/grok' }];
  const okComments = ['角度一：认同并补充', '角度二：提个问题', '角度三：独立观点'];
  const msg = () => ({ type: 'GROK_COMMENTS', payload: { text: '给自己放了一个小假 东京之旅结束' } });
  try {
    // A0：1.4.1 真机事故回放 —— 用户设置存的是旧版 grokMode="page"，
    // 且「优先站内直连」保持默认开启。后台归一化后必须走直连，
    // 绝不能再落到会报「提示词写入校验失败」的旧 DOM 页面链路。
    scenario = { grokMode: 'page', grokApiKey: '', pageTabs: tabs(), nativeCalls: 0, pageBridgeCalls: 0 };
    let r0 = await runtimeSend('content', msg());
    A('1.4.1 旧 page 设置的 AI 评论走站内直连',
      r0 && r0.ok === true && r0.mode === 'native' && r0.comments && r0.comments.length === 3);
    A('1.4.1 旧 page 设置不再触发 Grok 输入框写入', scenario.pageBridgeCalls === 0);
    A('1.4.1 旧 page 设置确实调用了页面内直连脚本', scenario.nativeCalls >= 2);

    // A：auto + X 标签 → 直连，页面链路完全不触发
    scenario = { grokMode: 'auto', grokApiKey: '', pageTabs: tabs(), nativeCalls: 0, pageBridgeCalls: 0 };
    let r = await runtimeSend('content', msg());
    A('auto 在 X 标签走站内直连并返回 3 条候选',
      r && r.ok === true && r.mode === 'native' && r.comments && r.comments.length === 3);
    A('直连成功时完全不触发旧的页面模式链路', scenario.pageBridgeCalls === 0);
    A('直连确实与页面内脚本通信', scenario.nativeCalls >= 2);
    A('直连结果带传输诊断', !!(r && r.diagnostics && /站内直连/.test(r.diagnostics.transport)));

    // B：提示词送达检查（正文不串 UI 词）
    let sentPrompt = '';
    scenario = { grokMode: 'auto', grokApiKey: '', pageTabs: tabs(),
      nativeHandler: (m) => { sentPrompt = m.prompt; return { ok: true, comments: okComments, raw: 'raw', via: 'x-ondemand' }; } };
    r = await runtimeSend('content', msg());
    A('提示词里带真实推文正文', /东京之旅结束/.test(sentPrompt));
    A('提示词要求代码块输出', /代码块/.test(sentPrompt));
    A('提示词不含插件按钮文字', !/一键转发|AI 评论/.test(sentPrompt));

    // C：直连失败 → 自动降级页面模式仍出候选
    scenario = { grokMode: 'auto', grokApiKey: '', pageTabs: tabs(),
      nativeHandler: () => ({ ok: false, error: 'X 拒绝了本次 Grok 签名（404）' }) };
    r = await runtimeSend('content', msg());
    A('直连失败自动降级页面模式仍能出候选',
      r && r.ok === true && r.mode === 'page' && r.comments && r.comments.length === 3);
    A('降级时把直连失败原因带进诊断',
      !!(r && r.diagnostics && /404/.test(r.diagnostics.nativeFallback || '')));

    // D：强制 native 失败 → 明确中文错误，不静默换链路
    scenario = { grokMode: 'native', pageTabs: tabs(),
      nativeHandler: () => ({ ok: false, error: 'X 签名生成失败' }) };
    r = await runtimeSend('content', msg());
    A('强制直连失败给明确中文错误',
      r && r.ok === false && /站内直连 Grok 生成失败/.test(r.error) && /签名/.test(r.error));

    // E：关掉「优先直连」→ auto 完全不调用 native
    scenario = { grokMode: 'auto', grokApiKey: '', grokPreferNative: false, pageTabs: tabs(), nativeCalls: 0 };
    r = await runtimeSend('content', msg());
    A('关掉优先直连后 auto 不调用 native',
      r && r.ok === true && r.mode === 'page' && scenario.nativeCalls === 0);

    // F：页面内脚本失效（旧标签孤儿）→ 安静降级而不是死等
    scenario = { grokMode: 'auto', grokApiKey: '', pageTabs: tabs(), nativeUnreachable: [42, 43] };
    r = await runtimeSend('content', msg());
    A('旧标签脚本失联时安静降级页面模式', r && r.ok === true && r.mode === 'page');

    // G：设置面板自检验证直连通道
    scenario = { grokMode: 'auto', grokApiKey: '', pageTabs: tabs() };
    r = await runtimeSend('popup', { type: 'GROK_TEST' });
    A('auto 自检验证站内直连通道', r && r.ok === true && r.mode === 'native' && /签名/.test(r.sample || ''));

    // H：native 模式下点「重建标签」不再误刷新用户 X 页面
    scenario = { grokMode: 'native', pageTabs: tabs(), reloadedTabs: [] };
    r = await runtimeSend('popup', { type: 'GROK_PAGE_RESET' });
    A('native 模式下重建标签不误刷新用户页面',
      r && r.ok === true && r.mode === 'native' && (scenario.reloadedTabs || []).length === 0);
  } catch (e) {
    A('站内直连端到端无异常抛出', false);
    note('ERROR', 'native 端到端异常: ' + (e && e.message));
  } finally {
    scenario = prev;
  }
  return checks;
}

/* 1.4.1：真机排查发现用户设置里存的是显式 grokMode="page"，
 * 导致 1.4.0 新增的站内直连永远走不到。这里回放 storage 迁移逻辑，
 * 确保「刷新页面即生效、且绝不覆盖用户之后的选择」。 */
async function runModeMigrationChecks() {
  const out = [];
  const A = (name, ok) => out.push({ name, ok: !!ok });
  const saved = scenario;
  const setup = (store) => {
    scenario = Object.assign({}, saved, {
      hostname: 'x.com', path: '/home', grokMode: undefined,
      storageSync: Object.assign({}, store), storageSets: 0
    });
    loadContent();
    scenario.storageSets = 0;   // 忽略 content.js 初始化时自动触发的那次
  };
  try {
    setup({ grokMode: 'page' });
    vm.runInContext('migrateGrokMode141()', contentCtx);
    A('1.4.1 迁移把旧 page 设置升级为 auto',
      scenario.storageSync.grokMode === 'auto');
    A('1.4.1 迁移写入一次性标记',
      scenario.storageSync.grokModeMigrated141 === true);
    A('1.4.1 迁移只写一次', (() => {
      const n = scenario.storageSets;
      vm.runInContext('migrateGrokMode141()', contentCtx);
      return scenario.storageSets === n;
    })());

    setup({ grokMode: 'page', grokPreferNative: false });
    vm.runInContext('migrateGrokMode141()', contentCtx);
    A('1.4.1 关掉优先直连时不擅自改设置', scenario.storageSets === 0);

    setup({ grokMode: 'auto' });
    vm.runInContext('migrateGrokMode141()', contentCtx);
    A('1.4.1 已是 auto 时不动设置', scenario.storageSets === 0);

    setup({ grokMode: 'page', grokModeMigrated141: true });
    vm.runInContext('migrateGrokMode141()', contentCtx);
    A('1.4.1 用户后续主动选回 page 不被覆盖', scenario.storageSets === 0);
  } catch (e) {
    A('1.4.1 迁移测试无异常（' + String(e && e.message || e) + '）', false);
  } finally {
    scenario = saved;
  }
  return out;
}

function runTapeAIChecks() {
  const T = require('./grok.js');
  const checks = [];
  const A = (name, fn) => {
    let ok = false;
    try { ok = !!fn(); } catch (e) { note('ERROR', 'TapeAI ' + name + ': ' + (e && e.message)); }
    checks.push({ name, ok });
  };

  A('全量清单 295 条，含来源、数据文件与核验日期', () =>
    T.ALL_SITES.length >= 290 && T.SOURCE.total === T.ALL_SITES.length &&
    !!T.SOURCE.url && !!T.SOURCE.dataUrl && !!T.SOURCE.dewebApi &&
    /^\d{4}-\d{2}-\d{2}$/.test(T.SOURCE.checkedAt));
  A('清单分三档：5 官方 / 56 导航收录 / 234 链上容器', () => {
    const n = { official: 0, listed: 0, deweb: 0 };
    T.ALL_SITES.forEach((s) => { n[s.tier] = (n[s.tier] || 0) + 1; });
    return n.official === 5 && n.listed >= 50 && n.deweb >= 200 &&
      T.OFFICIAL_SITES.every((s) => s.source === 'nav') && T.DEWEB_SITES.every((s) => s.tier === 'deweb');
  });
  A('全量 295 条收录地址全部命中绿标', () =>
    T.ALL_SITES.every((s) => {
      const r = T.matchOfficial(s.url);
      return r.status === 'official' && r.tier === s.tier && r.site && r.site.url === s.url;
    }));
  A('清单 URL 唯一且均为 https 地址', () => {
    const urls = T.ALL_SITES.map((s) => s.url);
    return new Set(urls).size === urls.length && urls.every((u) => /^https:\/\//.test(u));
  });
  A('等价写法仍命中（www / 大小写 / query / 省略协议 / 末尾斜杠）', () => [
    'https://www.tapeout.net/#/', 'TAPEOUT.NET', 'https://tapehub.ai/?ref=x',
    'tapekit.org', 'https://x.com/Blonskr/'
  ].every((u) => T.matchOfficial(u).status === 'official'));
  A('官网子页面与官方子域仍算官方', () =>
    T.matchOfficial('https://tapeout.net/market').status === 'official' &&
    T.matchOfficial('https://app.tapehub.ai/').status === 'official');
  A('x.com/blonskr 命中，其它 x.com 路径不给绿标', () =>
    T.matchOfficial('https://x.com/blonskr').status === 'official' &&
    T.matchOfficial('https://x.com/someuser/status/123').status === 'unknown' &&
    T.matchOfficial('https://x.com/blonskr2').status === 'unknown');
  A('形近域名 tapeout-net.com 不命中且报仿冒风险', () => {
    const r = T.matchOfficial('https://tapeout-net.com/');
    return r.status === 'unknown' && r.risks.some((x) => /疑似仿冒|品牌词|仿冒站/.test(x));
  });
  A('tapeout.net.evil.com 不命中且报仿冒风险', () => {
    const r = T.matchOfficial('https://tapeout.net.evil.com/');
    return r.status === 'unknown' && r.risks.some((x) => /疑似仿冒|品牌词|仿冒站/.test(x));
  });
  A('短链 / Punycode / 非 HTTPS 会标风险', () =>
    T.matchOfficial('https://t.cn/abc').risks.some((x) => /短链/.test(x)) &&
    T.matchOfficial('https://xn--tapeut-n2a.com/').risks.some((x) => /Punycode/.test(x)) &&
    T.matchOfficial('http://tapeout.net/').risks.some((x) => /HTTPS/.test(x)));
  A('javascript: 伪协议直接拦截', () => {
    const r = T.matchOfficial('javascript:alert(1)');
    return r.status === 'invalid' && /协议/.test(r.error || '');
  });
  A('参考清单命中 community，不给绿标', () =>
    T.REFERENCE_SITES.every((s) => T.matchOfficial(s.url).status === 'community'));

  A('评论解析：JSON 数组', () => {
    const c = T.parseThreeComments('["第一条","第二条","第三条"]');
    return c.length === 3 && c[0] === '第一条';
  });
  A('评论解析：Markdown 代码块 + 对象字段', () =>
    T.parseThreeComments('```json\n{"comments":["甲","乙","丙"]}\n```').length === 3);
  A('评论解析：编号列表兜底', () =>
    T.parseThreeComments('1. 第一条\n2. 第二条\n3) 第三条').length === 3);
  A('评论解析：去重并最多 3 条', () => {
    const c = T.parseThreeComments('["同","同","乙","丙","丁"]');
    return c.length === 3 && c[0] === '同' && c[1] === '乙';
  });
  A('核验解析：合法 JSON 与非法 JSON 兜底', () => {
    const good = T.parseVerdict('{"verdict":"fake","reason":"域名相似","risk":"别连钱包"}');
    const bad = T.parseVerdict('模型瞎说了一通');
    return good.verdict === 'fake' && good.parsed === true && bad.verdict === 'unknown' && bad.parsed === false;
  });
  A('评论提示词替换 {POST} 并带 system 约束', () => {
    const m = T.buildCommentMessages('这条推文很棒', null);
    return m.length === 2 && m[0].role === 'system' && m[1].content.includes('这条推文很棒') &&
      m[1].content.indexOf('{POST}') === -1;
  });
  A('自定义提示词删掉占位符时自动补正文', () =>
    T.buildCommentMessages('自定义正文', '只写三条短评')[1].content.includes('自定义正文'));
  A('核验提示词注入本地权威结论、清单摘要与待核验链接', () => {
    const m = T.buildVerifyMessages('https://tapeout-net.com/', null);
    const body = m[1].content;
    return body.includes('未命中本地白名单') && body.includes('tapeout-net.com') &&
      body.includes('不要凭记忆补充') && body.includes('清单总数：') &&
      T.OFFICIAL_SITES.filter((s) => s.tier === 'official').every((s) => body.includes(s.url)) &&
      body.indexOf('{LOCAL_RESULT}') === -1 && body.indexOf('{URL}') === -1;
  });
  A('核验提示词长度受控（不把数百条清单塞给模型）', () =>
    T.buildVerifyMessages('https://tapeout.net/', null)[1].content.length < 3000 &&
    T.buildVerifyMessages('https://1-2-210.tapekit.org/', null)[1].content.length < 3000);
  A('命中链接的本地结论写进提示词且带等级', () => {
    const body = T.buildVerifyMessages('https://tapeoutscan.io/', null)[1].content;
    return body.includes('已命中本地白名单') && body.includes('生态导航收录认可');
  });
  A('旧版自定义提示词缺占位符时自动追加权威结论', () =>
    T.buildVerifyMessages('https://tapeout.net/', '只回答是不是官方')[1].content.includes('已命中本地白名单'));
  A('模型判 official 也不能改变本地未命中的结论', () => {
    const local = T.matchOfficial('https://tapeout-net.com/');
    const grok = T.parseVerdict('{"verdict":"official","reason":"我觉得是"}');
    return local.status !== 'official' && grok.verdict === 'official';
  });

  /* ---- v1.2.0：全量清单的安全边界 ---- */
  A('未索引的 tapekit.org 容器子域不给绿标', () =>
    T.matchOfficial('https://999-999.tapekit.org/').status === 'unknown' &&
    T.matchOfficial('https://evil.tapekit.org/').status === 'unknown');
  A('网关主域命中，但不会通配放行任意子域', () =>
    T.matchOfficial('https://tapekit.org/').status === 'official' &&
    T.matchOfficial('https://anything.tapekit.org/').status === 'unknown');
  A('同一链上容器走第三方网关仍算已索引，并提示官方网关', () => {
    const r = T.matchOfficial('https://1-2-210.tapeout.site/');
    return r.status === 'official' && r.tier === 'deweb' &&
      r.viaGateway === 'https://1-2-210.tapekit.org/' &&
      r.risks.some((x) => /官方网关/.test(x));
  });
  A('通用平台按路径隔离：x.com / t.me / github.io', () =>
    T.matchOfficial('https://x.com/blonskr').status === 'official' &&
    T.matchOfficial('https://x.com/otheraccount').status === 'unknown' &&
    T.matchOfficial('https://t.me/TapeOutnet').status === 'official' &&
    T.matchOfficial('https://t.me/otherchannel').status === 'unknown' &&
    T.matchOfficial('https://jogjohgoeg.github.io/other/').status === 'unknown');
  A('导航站内页命中导航站本体而不是站内子应用', () => {
    const r = T.matchOfficial('https://tapeout.link/news/2119093042187784512');
    return r.status === 'official' && /生态导航/.test(r.site.name);
  });
  A('独立官网子页面/官方子域仍算官方', () =>
    T.matchOfficial('https://tapeout.net/linux.html').status === 'official' &&
    T.matchOfficial('https://app.tapehub.ai/').status === 'official');
  A('三档等级文案可区分', () =>
    /项目方官方/.test(T.tierLabel('official')) && /导航/.test(T.tierLabel('listed')) &&
    /容器/.test(T.tierLabel('deweb')));
  A('面板排序：项目方官方排最前（official → listed → deweb）', () => {
    const s = T.sortByTier([{ tier: 'deweb' }, { tier: 'listed' }, { tier: 'official' }]);
    return s[0].tier === 'official' && s[1].tier === 'listed' && s[2].tier === 'deweb' &&
      T.sortByTier(T.ALL_SITES)[0].tier === 'official' && T.TIER_ORDER.official > 0;
  });
  A('清单摘要始终包含 5 条项目方官方地址', () => {
    const s = T.officialContextText('https://whatever.example/', null);
    return T.OFFICIAL_SITES.filter((x) => x.tier === 'official').every((x) => s.includes(x.url));
  });
  A('只有少数独立官网放宽同域，其余条目全部精确比对', () => {
    const domains = T.ALL_SITES.filter((s) => s.scope === 'domain').map((s) => new URL(s.url).hostname);
    return domains.length <= 8 && new Set(domains).size <= 4 &&
      T.ALL_SITES.filter((s) => s.tier === 'deweb').every((s) => s.scope === 'exact');
  });
  A('参考清单里的地址确实未收录，不给绿标', () =>
    T.REFERENCE_SITES.every((s) => !T.ALL_SITES.some((x) => x.url === s.url)) &&
    T.REFERENCE_SITES.every((s) => T.matchOfficial(s.url).status === 'community'));
  return checks;
}

async function runCommentButtonChecks() {
  const checks = [];
  const A = (name, v) => checks.push({ name, ok: !!v });
  try {
    resetWorld();
    scenario = { hostname: 'x.com', path: '/home' };
    loadContent();
    await vm.runInContext('loadSettings()', contentCtx);
    const built = makeSiteCard({
      site: 'x', text: '这是一条用于测试 AI 评论按钮的推文正文。',
      imageCount: 1, sourceLink: '/someuser/status/1234567890'
    });
    contentCtx.__card = built.card;
    vm.runInContext('injectIntoCard(__card)', contentCtx, { timeout: 3000 });
    const all = built.card._all();
    const group = all.find((n) => n.className === 'wbx-btn-group');
    // 1.3.1 行为变更：AI 评论按钮从推文卡片移到 X 回复填写区右侧
    A('1.3.1：X 推文卡片不再挂 AI 评论按钮',
      !all.some((n) => n.className === 'wbx-comment-btn'));
    A('1.3.1：卡片上只保留一键转发按钮', !!group &&
      group.children.some((c) => c.className === 'wbx-repost-btn') &&
      !group.children.some((c) => String(c.className || '').includes('wbx-comment-btn')));

    // 真实浏览器里 innerText 会聚合子按钮文字；MiniNode 不会，这里手动模拟
    built.textNode.innerText = '这是一条用于测试 AI 评论按钮的推文正文。 一键转发';
    built.textNode.textContent = built.textNode.innerText;
    const post = vm.runInContext('resolvePost(__card)', contentCtx);
    A('按钮文字不污染转发正文', !!post && !/一键转发/.test(post.text) && post.text.includes('推文正文'));
    A('回复目标 status id 可解析',
      vm.runInContext('extractXStatusId(__card)', contentCtx) === '1234567890');

    vm.runInContext('settings.enableAiComment = false', contentCtx);
    vm.runInContext('injectIntoCard(__card)', contentCtx, { timeout: 3000 });
    A('关闭开关后不再注入评论按钮、转发按钮仍在',
      !built.card._all().some((n) => n.className === 'wbx-comment-btn') &&
      built.card._all().some((n) => n.className === 'wbx-repost-btn'));

    // 非 X 站点不应出现 AI 评论按钮
    resetWorld();
    scenario = { hostname: 'weibo.com', path: '/' };
    loadContent();
    await vm.runInContext('loadSettings()', contentCtx);
    const wb = makeRealCard({ text: '微博正文测试内容', imageCount: 1, uid: null });
    contentCtx.__wbCard = wb.card;
    vm.runInContext('injectIntoCard(__wbCard)', contentCtx, { timeout: 3000 });
    A('非 X 站点不注入 AI 评论按钮',
      wb.card._all().some((n) => n.className === 'wbx-repost-btn') &&
      !wb.card._all().some((n) => n.className === 'wbx-comment-btn'));
  } catch (e) {
    A('X 评论按钮检查无异常', false);
    note('ERROR', '评论按钮检查抛错: ' + (e && e.message));
  }
  return checks;
}

// ---------- 1.3.1：X 回复填写区按钮 + 候选精准回写 ----------
/* 模拟实测的 /compose/post 回复弹窗：dialog 里有「Replying to @xxx」、
 * 编辑区（占位符 Post your reply + div[aria-label="Post text"][role="textbox"]）、
 * 工具栏末尾的 Reply 按钮。首页主发推框同样用 aria-label="Post text"，
 * 必须靠上下文把它排除。 */
function makeReplyDialog() {
  const n = (tag, opts) => new MiniNode(tag, opts || {});
  const dlg = n('div', { attrs: { role: 'dialog', 'aria-modal': 'true' } });
  // MiniNode 不像真实 DOM 会聚合后代 innerText，这里手动模拟可见文本
  dlg.innerText = '火星人Ryan @bitcoin2themars TapeOut 日报｜链上容器索引突破 200 个 ' +
    'Replying to @bitcoin2themars Post your reply Reply';
  dlg.textContent = dlg.innerText;
  const quoted = n('div', { attrs: { role: 'group' } });
  quoted.appendChild(n('a', { attrs: { href: '/bitcoin2themars/status/2119124304164270241' } }));
  dlg.appendChild(quoted);
  dlg.appendChild(n('button', { text: 'Replying to @bitcoin2themars' }));
  const editor = n('div');
  editor.appendChild(n('div', { text: 'Post your reply' }));
  const input = n('div', { attrs: { 'aria-label': 'Post text', role: 'textbox', contenteditable: 'true' } });
  editor.appendChild(input);
  dlg.appendChild(editor);
  const toolbar = n('div');
  toolbar.appendChild(n('button', { attrs: { 'data-testid': 'tweetButtonInline' }, text: 'Reply' }));
  dlg.appendChild(toolbar);
  return { dlg: dlg, editor: editor, input: input };
}

async function runReplyComposerChecks() {
  const checks = [];
  const A = (name, v) => checks.push({ name, ok: !!v });
  try {
    resetWorld();
    scenario = { hostname: 'x.com', path: '/compose/post' };
    loadContent();
    await vm.runInContext('loadSettings()', contentCtx);

    const rd = makeReplyDialog();
    const mainWrap = new MiniNode('div', { text: "What's happening?" });
    const mainInput = new MiniNode('div', {
      attrs: { 'aria-label': 'Post text', role: 'textbox', contenteditable: 'true' }
    });
    mainWrap.appendChild(mainInput);
    const card = new MiniNode('article', { attrs: { 'data-testid': 'tweet' } });
    card.appendChild(new MiniNode('div', {
      attrs: { 'data-testid': 'tweetText' }, text: '时间线里的一条推文'
    }));
    dom.body.appendChild(rd.dlg);
    dom.body.appendChild(mainWrap);
    dom.body.appendChild(card);
    Object.assign(contentCtx, {
      __replyDlg: rd.dlg, __replyInput: rd.input, __mainInput: mainInput, __replyCard: card
    });

    const found = vm.runInContext('findReplyComposers()', contentCtx);
    A('只认回复弹窗的输入框，排除首页主发推框',
      found.length === 1 && found[0].input === rd.input);
    A('上下文判定：Replying to 命中、What’s happening 排除',
      vm.runInContext('isReplyInput(__replyInput, replyScopeOf(__replyInput))', contentCtx) === true &&
      vm.runInContext('isReplyInput(__mainInput, replyScopeOf(__mainInput))', contentCtx) === false);
    A('从弹窗原推链接解析出 status id',
      vm.runInContext('extractXStatusIdFromScope(__replyDlg)', contentCtx) === '2119124304164270241');
    const ctxText = vm.runInContext('contextTextFromScope(__replyDlg)', contentCtx);
    A('上下文文本保留原推、剔除 X 的 UI 占位文案',
      /TapeOut 日报/.test(ctxText) && !/Post your reply|Replying to/.test(ctxText));

    vm.runInContext('scanAndInject()', contentCtx, { timeout: 3000 });
    const replyBtns = () => (rd.editor.children || [])
      .filter((n) => String(n.className || '').includes('wbx-reply-btn'));
    const btn = replyBtns()[0];
    A('AI 评论按钮挂在回复输入框的填写区右侧', !!btn && btn.parentElement === rd.editor);
    A('/compose/post 回复弹窗不再往推文卡片注入一键转发',
      !card._all().some((n) => n.className === 'wbx-btn-group'));
    A('按钮带回复区标记，选中候选走精准回写', !!btn && btn.__wbxReply === true);

    for (let i = 0; i < 3; i++) vm.runInContext('scanAndInject()', contentCtx, { timeout: 3000 });
    A('重复扫描不重建回复框按钮（避免自触发死循环）',
      replyBtns().length === 1 && replyBtns()[0] === btn);

    contentCtx.__replyBtn = btn;
    A('空回复框：候选直接写入',
      vm.runInContext('applyCommentToReply("第一条候选", __replyBtn)', contentCtx) === true &&
      rd.input.innerText === '第一条候选');
    A('已有草稿：追加一行而不是覆盖',
      vm.runInContext('applyCommentToReply("第二条候选", __replyBtn)', contentCtx) === true &&
      rd.input.innerText === '第一条候选\n第二条候选');
    A('写入走 execCommand insertText 主路径', (dom._inserted || []).length === 2);

    const origExec = dom.execCommand;
    dom.execCommand = () => false;
    const fallbackOk = vm.runInContext('writeIntoReply(__replyInput, "兜底写入")', contentCtx);
    dom.execCommand = origExec;
    A('execCommand 被拦时走 input 事件兜底',
      fallbackOk === true && rd.input.textContent.includes('兜底写入') &&
      (rd.input._events || []).length > 0);

    // 1.3.2：点击后必须有可见的等待浮层，结果回来才关闭
    const busy = vm.runInContext('showAiBusy("Grok 正在生成 3 条回复候选")', contentCtx);
    A('1.3.2 点击后弹出等待浮层', !!busy && busy.id === 'wbx-ai-busy' &&
      dom.getElementById('wbx-ai-busy') === busy);
    A('1.3.2 等待浮层含 spinner / 阶段 / 耗时 / 关闭按钮',
      busy._all().some((n) => n.className === 'wbx-busy-spin') &&
      busy._all().some((n) => n.className === 'wbx-busy-stage') &&
      busy._all().some((n) => n.className === 'wbx-busy-time') &&
      busy._all().some((n) => n.className === 'wbx-busy-cancel'));
    vm.runInContext('hideAiBusy()', contentCtx);
    A('1.3.2 结果返回后等待浮层被移除', dom.getElementById('wbx-ai-busy') === null);

    // 端到端：候选面板里点「写入回复框」，应写进当前框且不开 intent 页
    contentCtx.__comments = ['候选甲', '候选乙', '候选丙'];
    vm.runInContext('showCommentPicker(__comments, "2119124304164270241", null, __replyBtn, "推文正文", "page")',
      contentCtx, { timeout: 3000 });
    const panel = dom.getElementById('wbx-comments');
    const useBtn = panel && panel._all().find((n) => n.className === 'wbx-c-use');
    A('候选面板有「写入回复框」按钮', !!useBtn && useBtn.textContent === '写入回复框');
    if (useBtn && useBtn._handlers && useBtn._handlers.click) {
      useBtn._handlers.click({ preventDefault() {}, stopPropagation() {} });
    }
    A('点选候选后写进当前回复框，不再另开 intent 预填页',
      rd.input.innerText.includes('候选甲') && windowOpenCount === 0);

    vm.runInContext('settings.enableAiComment = false', contentCtx);
    vm.runInContext('injectIntoReplyComposers()', contentCtx, { timeout: 3000 });
    A('关闭开关后回复框按钮被清掉', replyBtns().length === 0);
    vm.runInContext('settings.enableAiComment = true', contentCtx);
    vm.runInContext('injectIntoReplyComposers()', contentCtx, { timeout: 3000 });
    A('重新开启后按钮恢复', replyBtns().length === 1);

    /* ---- 1.3.4 真机事故回放 ----
     * 真机 DOM 里回复框区域堆了 33 个「AI 评论」按钮：host.children 是
     * HTMLCollection（没有 .filter），旧代码的早退判断永远为 false，
     * 每轮 MutationObserver 都再注入一个。按钮文字被当成推文正文发给 Grok，
     * 模型只回了 🤖，页面报「没读到 Grok 的回答块」。 */
    const makeHtmlCollectionLike = (arr) => {
      const c = {
        length: arr.length,
        item(i) { return arr[i] || null; },
        namedItem() { return null; },
        push(n) { arr.push(n); c[c.length++] = n; return c.length; },
        indexOf(x) { return arr.indexOf(x); },
        splice(i, n) {
          const removed = arr.splice(i, n);
          for (let k = 0; k < 256; k++) delete c[k];
          arr.forEach((x, k) => { c[k] = x; });
          c.length = arr.length;
          return removed;
        },
        [Symbol.iterator]: function* () { for (const x of arr) yield x; }
      };
      arr.forEach((x, k) => { c[k] = x; });
      return c; // 故意不提供 .filter
    };
    const realChildren = rd.editor.children;
    rd.editor.children = makeHtmlCollectionLike(realChildren);
    for (let i = 0; i < 8; i++) vm.runInContext('scanAndInject()', contentCtx, { timeout: 3000 });
    const injectedCount = vm.runInContext('document.querySelectorAll(".wbx-reply-btn").length', contentCtx);
    A('1.3.4 children 为 HTMLCollection（无 filter）时仍只留 1 个 AI 评论按钮',
      injectedCount === 1);
    A('1.3.4 不再累积几十个重复按钮', injectedCount < 3);
    rd.editor.children = realChildren;

    A('1.3.4 插件按钮文字被清洗干净，不会当成推文正文',
      vm.runInContext('sanitizePostText("AI 评论 AI 评论 ⏳ 生成中 一键转发")', contentCtx) === '');
    A('1.3.4 真实推文正文不受清洗影响',
      String(vm.runInContext('sanitizePostText("给自己放了一个小假 东京之旅结束✨")', contentCtx))
        .includes('东京之旅结束'));
    const noisyScope = new MiniNode('div');
    noisyScope.innerText = noisyScope.textContent = 'AI 评论 AI 评论 AI 评论 TapeOut 日报';
    contentCtx.__noisyScope = noisyScope;
    A('1.3.4 contextTextFromScope 剥掉插件 UI 文字只留正文',
      vm.runInContext('contextTextFromScope(__noisyScope)', contentCtx) === 'TapeOut 日报');
    const goodCard = new MiniNode('article', { attrs: { 'data-testid': 'tweet' } });
    goodCard.appendChild(new MiniNode('div', {
      attrs: { 'data-testid': 'tweetText' },
      text: '今天东京之旅结束，祈祷事业顺顺顺'
    }));
    contentCtx.__goodCard = goodCard;
    A('1.3.4 正文优先取 X 官方 [data-testid="tweetText"]',
      String(vm.runInContext('replyTweetText(__replyDlg, __goodCard)', contentCtx))
        .includes('祈祷事业顺顺顺'));

    rd.input.remove();
    A('找不到回复框时回写返回 false（交给 intent 兜底）',
      vm.runInContext('applyCommentToReply("兜底候选", __replyBtn)', contentCtx) === false);

    rd.editor.appendChild(rd.input);
    vm.runInContext('settings.replyInputSelector = \'div[id="wbx-none"]\'', contentCtx);
    A('自定义回复框选择器可覆盖内置选择器',
      vm.runInContext('findReplyComposers().length', contentCtx) === 0);

    // 1.3.4：X 详情页内联回复框刷新后没有「Replying to」，只剩一个 Reply 发送按钮
    const inlineWrap = new MiniNode('div');
    const inlineInput = new MiniNode('div', {
      attrs: { 'aria-label': 'Post text', role: 'textbox', contenteditable: 'true' }
    });
    inlineWrap.appendChild(inlineInput);
    inlineWrap.appendChild(new MiniNode('button', { text: 'Reply' }));
    dom.body.appendChild(inlineWrap);
    Object.assign(contentCtx, { __inlineWrap: inlineWrap, __inlineInput: inlineInput });
    A('1.3.4 无 Replying to 文案、只有 Reply 按钮的内联回复框也能识别',
      vm.runInContext('isReplyInput(__inlineInput, replyScopeOf(__inlineInput))', contentCtx) === true);
    inlineWrap.remove();
  } catch (e) {
    A('回复框注入/回写检查无异常', false);
    note('ERROR', '回复框检查抛错: ' + (e && e.message));
  }
  return checks;
}

// ---------- 真实结构卡片 ----------
function makeRealCard(cfg) {
  const uid = cfg.uid || '6305330504';
  const card = new MiniNode('article', { className: 'woo-card-main' });

  const reco = new MiniNode('div', { className: 'woo-box-flex', text: '限宅 关注了 的人也关注' });
  reco.appendChild(new MiniNode('img', { attrs: { src: 'https://tvax1.sinaimg.cn/crop.0.0.512.512.50/aaa.jpg' } }));
  reco.appendChild(new MiniNode('a', { attrs: { href: 'https://weibo.com/u/7421535374' }, text: '限宅' }));
  card.appendChild(reco);

  // 真实 DOM 里 header.innerText 会聚合出整条作者信息（昵称/时间/认证标签），
  // 中文节点之间甚至直接粘连、没有空格。夹具手动赋值以复现这种行为。
  const HEADER_TEXT = '珑美恩雅 昨天 10:32 音乐博主 超话创作官（OaAngel超话） 微博原创视频博主';
  const header = new MiniNode('div', { className: 'woo-box-flex header', text: HEADER_TEXT });
  header.appendChild(new MiniNode('img', { attrs: { src: 'https://tva2.sinaimg.cn/crop.0.0.180.180.180/bbb.jpg' } }));
  header.appendChild(new MiniNode('a', { attrs: { href: 'https://weibo.com/u/' + uid }, text: '珑美恩雅' }));
  header.appendChild(new MiniNode('a', {
    attrs: { href: 'https://weibo.com/' + uid + '/Rqf5wrPOA', title: '2026-11-06 10:32' }, text: '昨天 10:32'
  }));
  header.appendChild(new MiniNode('span', { text: '音乐博主 超话创作官（OaAngel超话） 微博原创视频博主' }));
  card.appendChild(header);

  // metaHead：模拟启发式选中了「作者行 + 正文」粘连的大容器
  const bodyRaw = cfg.metaHead === 'merged'
    ? '限宅 关注了 ' + HEADER_TEXT + ' ' + cfg.text + ' 转发 98'
    : cfg.metaHead === 'sticky'
      ? '限宅 关注了珑美恩雅昨天 10:32音乐博主 超话创作官（OaAngel超话） 微博原创视频博主' + cfg.text + ' 转发 98'
      : cfg.text;
  const textNode = new MiniNode('div', {
    className: (cfg.noTextClass || cfg.metaHead) ? 'plain-body' : 'woo-text',
    text: bodyRaw,
    attrs: (cfg.noTextClass || cfg.metaHead) ? {} : { 'data-text': '' }
  });
  textNode.appendChild(new MiniNode('a', { attrs: { href: '/n/美团闪购' }, text: '@美团闪购' }));
  textNode.appendChild(new MiniNode('a', { attrs: { href: 'https://weibo.com/u/1234567890' }, text: '@某人' }));
  card.appendChild(textNode);

  const media = new MiniNode('div', { className: 'woo-picture-main', attrs: { 'node-type': 'feed_list_media' } });
  if (cfg.splitMedia) {
    // 真实微博会把九宫格拆到多个媒体容器，部分格子还用 CSS 背景图而不是 <img>。
    // 旧代码只取「第一个」容器 → 3 张只剩 1 张 → 托盘根本不弹。
    media.appendChild(new MiniNode('img', { attrs: { src: 'https://wx1.sinaimg.cn/large/splitA.jpg' } }));
    const second = new MiniNode('div', { className: 'woo-picture-main' });
    second.appendChild(new MiniNode('img', { attrs: { src: 'https://wx2.sinaimg.cn/large/splitB.jpg' } }));
    card.appendChild(second);
    card.appendChild(new MiniNode('div', {
      className: 'woo-picture-item',
      attrs: { style: "background-image:url('https://wx3.sinaimg.cn/large/splitC.jpg')" }
    }));
  } else {
    for (let i = 0; i < (cfg.imageCount || 0); i++) {
      // lazyImages：注入按钮那一刻只有占位图，真实地址要等滚动/懒加载后才填 data-original
      const attrs = cfg.lazyImages
        ? { src: 'data:image/gif;base64,AAAA', class: 'lazy-placeholder' }
        : { src: `https://wx${i + 1}.sinaimg.cn/large/008wBFsfgy1ibox${i}.jpg` };
      media.appendChild(new MiniNode('img', { attrs }));
    }
  }
  card.appendChild(media);

  if (cfg.video) {
    const vwrap = new MiniNode('div', { className: 'woo-video-main' });
    const src = cfg.videoInDom === false
      ? 'blob:https://weibo.com/mse-xyz'
      : 'https://f.video.weibocdn.com/o0/clip.mp4?Expires=1&ssig=xyz';
    vwrap.appendChild(new MiniNode('video', { attrs: { src, poster: 'https://wx1.sinaimg.cn/orj360/poster.jpg' } }));
    card.appendChild(vwrap);
  }
  if (cfg.htmlVideoUrl) {
    card.innerHTML = '{"stream_url_hd":"' + cfg.htmlVideoUrl + '"}';
  }
  if (cfg.embeddedImages) {
    // 页面只渲染首图，其余地址藏在卡片内联 JSON（React props / pic_infos）
    card.innerHTML = '{"pic_infos":[' +
      '"https://wx1.sinaimg.cn/large/008wBFsfgy1ibox0.jpg",' +
      '"https://wx2.sinaimg.cn/large/embB.jpg",' +
      '"https://wx3.sinaimg.cn/large/embC.jpg"]}';
  }

  const tools = new MiniNode('div', { className: 'card-act' });
  tools.appendChild(new MiniNode('button', { text: '转发 34' }));
  card.appendChild(tools);

  return { card, textNode, reco, header, media, tools };
}

function resetWorld() {
  log.length = 0;
  clipboardBytes = 0;
  clipboardWrites = [];
  clipboardTypes = [];
  clipboardTextPayload = null;
  downloadedFiles = [];
  runtimeSendCount = 0;
  offscreenDocumentExists = false;
  windowOpenCount = 0;
}

async function runScenario(name, cfg, expect) {
  resetWorld();
  scenario = cfg;
  loadBackground();
  loadContent();
  note('TEST', `--- 场景：${name} ---`);

  const built = makeRealCard(cfg);
  contentCtx.__card = built.card;
  contentCtx.__btn = { disabled: false, textContent: '', title: '', type: '', className: '', addEventListener() {}, appendChild() {} };

  let post = null;
  try { post = vm.runInContext('resolvePost(__card)', contentCtx, { timeout: 3000 }); }
  catch (e) { note('ERROR', 'resolvePost 抛错: ' + (e && e.message)); }
  const textOk = !!post && post.text === cfg.text;
  // 懒加载场景：注入时本来就没有真实图地址，改在 payload 里断言最终取到的张数
  const expectedImages = cfg.expectImages != null ? cfg.expectImages : (cfg.imageCount || 0);
  const imgsOk = cfg.lazyImages ? null
    : (!!post && post.imageUrls.length === expectedImages &&
       !post.imageUrls.some((u) => /tvax|tva\d|crop\./i.test(u)));
  const uidOk = cfg.uid == null || (!!post && post.uid === cfg.uid);
  const videoUrlsOk = cfg.videoInDom === false
    ? (!!post && post.videoUrls.length === 0 && post.hasVideo === true)
    : true;
  if (post) note('parse', `text="${post.text}" images=${post.imageUrls.length} videos=${post.videoUrls.length} hasVideo=${post.hasVideo} uid=${post.uid}`);

  try { vm.runInContext('injectIntoCard(__card)', contentCtx, { timeout: 3000 }); }
  catch (e) { note('ERROR', 'injectIntoCard 抛错: ' + (e && e.message)); }
  const expectedHost = cfg.textEmpty ? built.media : built.textNode;
  // v1.1.0 起按钮包在 .wbx-btn-group 里（1.3.1 起 X 的「AI 评论」已移到回复框右侧），
  // 断言改成「按钮在正文容器的子树里、不在作者区」，语义不变但不再要求它是直接子元素。
  const hasRepostBtn = (node) => !!(node && node._all && node._all().some((n) => n.className === 'wbx-repost-btn'));
  const inContent = hasRepostBtn(expectedHost);
  const inNoise = hasRepostBtn(built.reco) || hasRepostBtn(built.header);
  const anchorOk = inContent && !inNoise;
  note('anchor', `内容容器(${cfg.textEmpty ? '图片墙' : '正文'})有按钮=${inContent} 作者区有按钮=${inNoise}`);

  // ---- 按钮稳定性：内容不变时连续扫描不得重建按钮 ----
  // 曾经校验用 quickFingerprint、保存用 postFingerprint，两者口径不同 →
  // 每轮扫描都删按钮重建 → MutationObserver 自触发死循环 → 用户点击丢失。
  const stableBtn = built.card._all().find((n) => n.className === 'wbx-repost-btn');
  let rebuildOk = !!stableBtn;
  for (let i = 0; i < 3 && rebuildOk; i++) {
    try { vm.runInContext('injectIntoCard(__card)', contentCtx, { timeout: 3000 }); }
    catch (e) { rebuildOk = false; note('ERROR', '稳定性扫描抛错: ' + (e && e.message)); }
    const now = built.card._all().find((n) => n.className === 'wbx-repost-btn');
    if (now !== stableBtn) rebuildOk = false;
  }
  note('stable', `内容不变连续扫描 3 次，按钮节点未被重建=${rebuildOk}`);

  // ---- 模拟「往下拉后微博复用同一个 article」/「图片懒加载后才有真实地址」----
  let btnCountAfterReuse = null;
  if (cfg.reuseCard || cfg.lazyImages) {
    if (cfg.reuseText) {
      built.textNode.innerText = cfg.reuseText;
      built.textNode.textContent = cfg.reuseText;
    }
    if (cfg.lazyFill) {
      built.media.children.forEach((im, i) => {
        im.setAttribute('data-original', `https://wx${i + 1}.sinaimg.cn/large/lazy${i}.jpg`);
      });
    }
    if (cfg.dropButton) {
      const oldBtn = built.card._all().find((n) => n.className === 'wbx-repost-btn');
      if (oldBtn) oldBtn.remove(); // 微博重渲染把按钮节点整个删掉
    }
    // 滚动触发的 scanAndInject：指纹变化应重建按钮，而不是留着旧缓存
    try { vm.runInContext('injectIntoCard(__card)', contentCtx, { timeout: 3000 }); }
    catch (e) { note('ERROR', '二次 injectIntoCard 抛错: ' + (e && e.message)); }
    btnCountAfterReuse = built.card._all().filter((n) => n.className === 'wbx-repost-btn').length;
    note('reuse', `内容变更后按钮数=${btnCountAfterReuse}（应为 1，不能重复或残留旧按钮）`);
  }

  try {
    if (cfg.clickButton) {
      // 真正点注入的按钮：会走「btn.closest 找当前卡片」这条路径
      const realBtn = built.card._all().find((n) => n.className === 'wbx-repost-btn');
      if (realBtn && realBtn._handlers && realBtn._handlers.click) {
        note('click', '模拟真实点击注入按钮（closest 定位 + 实时解析）');
        await realBtn._handlers.click({ preventDefault() {}, stopPropagation() {} });
      } else {
        note('ERROR', '找不到可点击的注入按钮');
      }
    } else {
      // 故意不传缓存 post：验证「点击瞬间实时解析」
      await vm.runInContext('onRepost(__card, __btn)', contentCtx, { timeout: 5000 });
    }
  } catch (e) {
    note('ERROR', 'onRepost 抛错: ' + (e && e.message));
  }
  await new Promise((r) => setTimeout(r, 400));

  // ---- 多图托盘交互：真实点击手势逐张复制 / 拼成长图 / 打开 X ----
  // 多图时不能自动 window.open，否则 X 抢走焦点、托盘挂在微博页用户根本看不到
  const gallery = dom._nodes['wbx-gallery'];
  const autoOpenedBefore = /window.*open\(\) -> https:\/\//.test(log.join('\n'));
  let galleryItems = 0, copy2Ok = false, collageOk = false, openXByButton = false;
  if (gallery) {
    const openBtn = gallery._all().find((n) => n.className === 'wbx-g-open');
    if (openBtn && openBtn._handlers && openBtn._handlers.click) {
      const before = log.filter((l) => /window.*open\(\) -> https:\/\//.test(l)).length;
      await openBtn._handlers.click();
      openXByButton = log.filter((l) => /window.*open\(\) -> https:\/\//.test(l)).length > before;
      note('gallery', `点托盘「打开 X 发推」→ 开窗=${openXByButton}`);
    }
    const list = gallery._all().find((n) => n.className === 'wbx-g-list');
    const items = list ? list.children.filter((n) => n.className === 'wbx-g-item') : [];
    galleryItems = items.length;
    const b2 = items[1] && items[1]._all().find((n) => n.tagName === 'BUTTON');
    if (b2 && b2._handlers && b2._handlers.click) {
      const before = clipboardWrites.length;
      await b2._handlers.click();
      await new Promise((r) => setTimeout(r, 60));
      copy2Ok = clipboardWrites.length > before && clipboardBytes > 0;
      note('gallery', `点「复制第 2 张」→ clipboardWrites ${before}→${clipboardWrites.length}, bytes=${clipboardBytes}`);
    }
    const acts = gallery._all().find((n) => n.className === 'wbx-g-actions');
    const collageBtn = acts && acts.children.find((n) => n.tagName === 'BUTTON');
    if (collageBtn && collageBtn._handlers && collageBtn._handlers.click) {
      const before = clipboardWrites.length;
      await collageBtn._handlers.click();
      await new Promise((r) => setTimeout(r, 80));
      collageOk = clipboardWrites.length > before;
      note('gallery', `点「拼成长图」→ clipboardWrites ${before}→${clipboardWrites.length}`);
    }
  }

  const joined = log.join('\n');
  const expectedClean = cfg.expectedPayload != null ? cfg.expectedPayload
    : (cfg.cleanText != null ? cfg.cleanText : cfg.text);

  const gotResult = /handleResult\(\) 收到: type=RESULT/.test(joined);
  const openedX = /window.*open\(\) -> https:\/\//.test(joined);
  const clipboard = /clipboard.*write\(\) types=/.test(joined);
  const validBytes = clipboardBytes > 0;
  const downloaded = downloadedFiles.some((f) => /\.png$/.test(f));
  const mp4Downloaded = downloadedFiles.some((f) => /\.mp4$/.test(f));
  const fatal = /offscreen 未就绪|离屏文档创建失败|INVALID REASON|发送失败|ERROR|WARN|处理失败：/.test(joined);
  const inpaintOk = !cfg.uid || cfg.uid !== '7810882899' || !/Inpaint is not defined|inpaintCorner is not/.test(joined);
  const offscreenWrote = clipboardWrites.includes('offscreen');
  const fallbackBtn = !!dom._nodes['wbx-copybtn'];
  const toastText = (dom._nodes['wbx-toast'] && dom._nodes['wbx-toast'].textContent) || '';
  const copyFailTip = toastText.includes('自动复制失败');
  const videoTip = toastText.includes('视频已下载');
  const videoFailTip = toastText.includes('视频处理失败');

  // CROSSPOST payload 里的 text = 真正被转发走的文字（已清洗）
  const payloadMatch = /CROSSPOST payload: text="([^"]*)"/.exec(joined);
  const payloadText = payloadMatch ? payloadMatch[1] : '__MISSING__';
  const payloadTextOk = payloadText === expectedClean;
  if (!payloadTextOk) note('CHECK', `清洗后文字不符: 期望="${expectedClean}" 实际="${payloadText}"`);

  const urlMatch = /\[window\] open\(\) -> (\S+)/.exec(joined);
  const xUrlStr = urlMatch ? urlMatch[1] : '';
  let xText = null;
  if (xUrlStr.includes('text=')) {
    try { xText = decodeURIComponent((xUrlStr.split('text=')[1] || '').split('&')[0]); } catch (e) {}
  }
  // 文字始终预填进 X；剪贴板只放媒体，避免重复或丢字
  const xTextOk = xText === expectedClean;
  if (!xTextOk) note('CHECK', `X 预填文字不符: 期望="${expectedClean}" 实际=${xText === null ? '(无 text 参数)' : '"' + xText + '"'}`);

  // yes = 媒体写不进去/无媒体时文字进了剪贴板；no = 图片成功写入，不应混进文字
  const clipboardTextOk = expect.clipboardText === 'yes'
    ? clipboardTextPayload === expectedClean
    : expect.clipboardText === 'no'
      ? clipboardTextPayload === null
      : null;
  if (clipboardTextOk === false) {
    note('CHECK', `剪贴板文字策略不符: 期望=${expect.clipboardText} 实际="${clipboardTextPayload}"`);
  }

  const checks = {
    '结果回传': gotResult,
    'X 打开': openedX,
    '正文提取正确': textOk,
    '清洗后文字正确': payloadTextOk,
    'X 预填清洗文字': xTextOk,
    '内容图(非头像)': imgsOk,
    '视频识别': videoUrlsOk,
    'UID 属本条': uidOk,
    '按钮挂正文区': anchorOk,
    '按钮不反复重建': rebuildOk,
    '首图剪贴板': expect.clipboard ? clipboard && validBytes : null,
    '图片字节完整': expect.clipboard ? validBytes : null,
    '剪贴板文字策略': clipboardTextOk,
    '其余图下载': expect.download ? downloaded : null,
    '视频下载mp4': expect.videoDownloaded ? mp4Downloaded : null,
    '视频提示可见': expect.videoTip ? videoTip : null,
    '接口兜底': expect.videoApiFallback ? /fetch 公开接口 statuses\/show/.test(joined) : null,
    '无致命错误': !fatal,
    '去水印可用': inpaintOk
  };
  if (expect.offscreenWrote) checks['offscreen写剪贴板'] = offscreenWrote;
  if (expect.fallbackButton) checks['保底复制按钮'] = fallbackBtn;
  if (expect.copyFailTip) checks['失败原因可见'] = copyFailTip;
  if (expect.anchorFallback) checks['下载接口失败降级'] = /<a download> 触发/.test(joined);
  if (expect.videoFailTip) checks['视频失败可见'] = videoFailTip;
  if (expect.imageInpaint !== undefined) {
    const m = /CROSSPOST payload:[\s\S]*? inpaint=(\w+) inpaintVideo=/.exec(joined);
    checks['图片全局去水印'] = !!m && m[1] === String(expect.imageInpaint);
  }
  if (expect.hdPreferred) {
    checks['优先HD原片'] = /fetch 公开接口 statuses\/show/.test(joined) && /HD 原片/.test(toastText);
  }
  if (expect.hdFallback) {
    checks['HD失败回退直链'] = mp4Downloaded && /页面直链/.test(toastText);
  }
  if (expect.signature) {
    checks['署名含昆哥'] = /昆哥/.test(payloadText) && /昆哥/.test(xText || '');
    checks['署名含X主页'] = /x\.com\/YikunChen1983/.test(payloadText) && /YikunChen1983/.test(xText || '');
  }
  if (expect.wmDone) checks['检测到并去水印'] = /去水印：[1-9]\d* 张已处理/.test(toastText);
  if (expect.wmSkip) checks['无水印原图保留'] = /未检测到水印（原图保留）/.test(toastText);
  if (cfg.reuseCard || cfg.lazyImages) checks['滚动后按钮不重复'] = btnCountAfterReuse === 1;
  if (cfg.lazyImages) checks['懒加载图点击时取到'] = /CROSSPOST payload:.*imageUrls=2/.test(joined);
  if (cfg.reuseCard) checks['转发的是滚动后的新内容'] = payloadTextOk && xTextOk;
  if (cfg.clickButton) checks['真实点击按钮走closest'] = payloadTextOk && xTextOk && gotResult;
  if (cfg.metaHead) {
    checks['作者信息头已剥离'] = !!post &&
      !/(?:珑美恩雅|昨天|10:32|音乐博主|超话创作官|微博原创视频博主|限宅|关注了|一键转发|转发 98)/.test(post.text);
  }
  if (expect.gallery) {
    checks['多图托盘列出全部图'] = galleryItems === expectedImages;
    checks['逐张复制写入剪贴板'] = copy2Ok;
    checks['拼成长图可复制'] = collageOk;
    checks['多图不自动抢焦点'] = !autoOpenedBefore;
    checks['托盘按钮打开X'] = openXByButton;
    checks['托盘数量标记'] = !!gallery && gallery.getAttribute('data-wbx-count') === String(expectedImages);
  }
  let ok = true;
  const parts = [];
  for (const [k, v] of Object.entries(checks)) {
    parts.push(`${k}=${v === null ? '— 跳过' : (v ? '✅' : '❌')}`);
    if (v === false) ok = false;
  }
  note('CHECK', `pngBytes=${clipboardBytes} files=[${downloadedFiles.join(',')}] | ` + parts.join('  '));
  note('CHECK', ok ? `场景 PASS ✅` : `场景 FAIL ❌`);
  if (!ok || process.env.WBX_VERBOSE) console.log(log.join('\n') + '\n');
  return ok;
}

(async () => {
  console.log('=== 微博一键转发插件 · 端到端回归测试 ===\n');
  const cases = [];
  // 模拟运行时是全局共享的（消息总线/clipboard/日志），场景必须串行跑
  const R = (name, cfg, expect) => cases.push({ name, cfg, expect });

  // ---- 原有 8 个场景（适配清洗文字 + 剪贴板只放媒体）----
  R('带水印账号 + 单图（触发去水印）',
    { uid: '7810882899', imageCount: 1, text: '测试微博正文 # tag', cleanText: '测试微博正文', fetchFail: false },
    { clipboard: true, clipboardText: 'no', download: false });
  R('普通账号 + 多图（首图复制、托盘逐张复制/拼图、其余下载）',
    { uid: '5903810533', imageCount: 3, text: '多图微博正文', fetchFail: false },
    { clipboard: true, clipboardText: 'no', download: true, gallery: true });
  R('纯文字无图（仅预填 X）',
    { uid: null, imageCount: 0, text: '纯文字微博', fetchFail: false },
    { clipboard: false, clipboardText: 'yes', download: false });
  R('图床 403（应优雅降级、不崩溃）',
    { uid: '7810882899', imageCount: 1, text: '403 测试', fetchFail: true },
    { clipboard: false, clipboardText: 'yes', download: false });
  R('页面剪贴板被拒（offscreen 主路径仍成功）',
    { uid: null, imageCount: 1, text: '手势过期测试', fetchFail: false, contentClipboardFail: true },
    { clipboard: true, clipboardText: 'no', download: false, offscreenWrote: true });
  R('剪贴板完全被拒（降级：提示+下载+保底按钮）',
    { uid: null, imageCount: 1, text: '剪贴板被拒', fetchFail: false, clipboardFail: true },
    { clipboard: false, download: true, fallbackButton: true, copyFailTip: true });
  R('无 class 正文（启发式兜底 + 正文含用户链接）',
    { uid: null, imageCount: 1, text: '之前双十一囤货要等一周，这次不到半小时全送到，直接搞定。',
      fetchFail: false, noTextClass: true },
    { clipboard: true, clipboardText: 'no', download: false });
  R('纯图无正文（按钮挂图片墙）',
    { uid: null, imageCount: 2, text: '', fetchFail: false, textEmpty: true },
    { clipboard: true, clipboardText: 'no', download: true });

  // ---- 新增：# 话题清洗 ----
  R('文末话题（删掉 # 及其后推广文案）',
    { uid: null, imageCount: 1, fetchFail: false,
      text: '之前双十一囤货要等一周，这次不到半小时全送到，直接搞定。#美团闪购双11# 上美团闪购搜「闪购神券」',
      cleanText: '之前双十一囤货要等一周，这次不到半小时全送到，直接搞定。' },
    { clipboard: true, clipboardText: 'no', download: false });
  R('话题在开头（保护：不把正文删空）',
    { uid: null, imageCount: 1, fetchFail: false,
      text: '#美团闪购双11# 之前囤货要等一周，这次不到半小时送到。',
      cleanText: '之前囤货要等一周，这次不到半小时送到。' },
    { clipboard: true, clipboardText: 'no', download: false });
  R('stripTopics 模式（只删标签块，保留 # 后正文）',
    { uid: null, imageCount: 1, fetchFail: false, hashMode: 'stripTopics',
      text: '正文第一段 #话题# 正文第二段', cleanText: '正文第一段 正文第二段' },
    { clipboard: true, clipboardText: 'no', download: false });
  R('keep 模式（原文不清洗）',
    { uid: null, imageCount: 0, fetchFail: false, hashMode: 'keep',
      text: '原文带 #话题# 保持不动', cleanText: '原文带 #话题# 保持不动' },
    { clipboard: false, clipboardText: 'yes', download: false });

  // ---- 新增：视频 ----
  R('视频微博（页面直出 mp4 → 下载 + 文字兜底）',
    { uid: null, imageCount: 0, text: '视频微博正文', fetchFail: false, video: true,
      videoInDom: true, inpaintVideo: false },
    { clipboard: false, clipboardText: 'yes', videoDownloaded: true, videoTip: true, download: false });
  R('视频 blob MSE（公开接口兜底取原片）',
    { uid: null, imageCount: 0, text: 'MSE 视频正文', fetchFail: false, video: true,
      videoInDom: false, inpaintVideo: false },
    { clipboard: false, clipboardText: 'yes', videoDownloaded: true, videoTip: true,
      videoApiFallback: true, download: false });
  R('视频下载接口失败（退回 <a download>）',
    { uid: null, imageCount: 0, text: '下载降级测试', fetchFail: false, video: true,
      videoInDom: true, inpaintVideo: false, downloadsFail: true },
    { clipboard: false, clipboardText: 'yes', videoDownloaded: true, videoTip: true,
      anchorFallback: true, download: false });
  R('视频接口 432 限流（优雅失败、不崩溃）',
    { uid: null, imageCount: 0, text: '接口限流测试', fetchFail: false, video: true,
      videoInDom: false, inpaintVideo: false, apiFail: true },
    { clipboard: false, clipboardText: 'yes', download: false, videoFailTip: true });

  // ---- 新增：全局去水印开关（取消 UID 列表后） ----
  R('普通账号也去水印（全局图片开关默认开启，不再看 UID）',
    { uid: '5903810533', imageCount: 1, text: '全局图片去水印测试', fetchFail: false },
    { clipboard: true, clipboardText: 'no', download: false, imageInpaint: true });
  R('图片去水印关闭（payload 明确 false）',
    { uid: null, imageCount: 1, text: '关闭图片去水印', fetchFail: false, inpaintImages: false },
    { clipboard: true, clipboardText: 'no', download: false, imageInpaint: false });
  R('视频去水印开启（优先取 HD 原片）',
    { uid: null, imageCount: 0, text: '视频去水印测试', fetchFail: false, video: true, videoInDom: true },
    { clipboard: false, clipboardText: 'yes', videoDownloaded: true, videoTip: true,
      download: false, hdPreferred: true });
  R('HD 接口被限流（自动回退页面直链，不影响下载）',
    { uid: null, imageCount: 0, text: 'HD 回退测试', fetchFail: false, video: true,
      videoInDom: true, apiFail: true },
    { clipboard: false, clipboardText: 'yes', videoDownloaded: true, videoTip: true,
      download: false, hdFallback: true });

  // ---- 新增：自动检测式去水印（不再无条件抹右下角矩形） ----
  R('检测到水印（自动包围盒重建）',
    { uid: null, imageCount: 1, text: '去水印检测测试', fetchFail: false, fakeWatermark: true },
    { clipboard: true, clipboardText: 'no', download: false, wmDone: true });
  R('无水印图（原图完全保留，不再抹右下角）',
    { uid: null, imageCount: 1, text: '无水印测试', fetchFail: false },
    { clipboard: true, clipboardText: 'no', download: false, wmSkip: true });

  // ---- 新增：滚动后 DOM 复用 / 懒加载 / 多图托盘 ----
  R('往下拉后微博复用 article（点第 N 条转第 N 条，不再是旧缓存）',
    { uid: null, imageCount: 1, text: '旧的第一条正文内容', fetchFail: false,
      reuseCard: true, reuseText: '滚动后这一条才是真正要转发的正文内容',
      expectedPayload: '滚动后这一条才是真正要转发的正文内容' },
    { clipboard: true, clipboardText: 'no', download: false });
  R('滚动后按钮被框架删掉（自动重新注入，不残留也不丢失）',
    { uid: null, imageCount: 1, text: '按钮丢失测试', fetchFail: false,
      reuseCard: true, dropButton: true },
    { clipboard: true, clipboardText: 'no', download: false });
  R('图片懒加载（注入时占位图，点击瞬间才取到真实原图）',
    { uid: null, imageCount: 2, text: '懒加载图片正文', fetchFail: false,
      lazyImages: true, lazyFill: true },
    { clipboard: true, clipboardText: 'no', download: true, gallery: true });
  R('真实点击按钮（closest 定位当前卡片 + 实时解析新内容）',
    { uid: null, imageCount: 2, text: '旧内容不该被转发', fetchFail: false,
      reuseCard: true, reuseText: '点击按钮时这一条才是真实内容', clickButton: true,
      expectedPayload: '点击按钮时这一条才是真实内容' },
    { clipboard: true, clipboardText: 'no', download: true, gallery: true });
  // 用户实测「多图片的复制没看见有体现」：九宫格被拆到多个容器 + CSS 背景图，
  // 旧版只采到首图 → 托盘不弹；X 又抢走焦点 → 托盘即使弹了也看不见。
  R('九宫格拆分多容器 + CSS 背景图（3 张全采到，托盘弹出且不抢焦点）',
    { uid: null, imageCount: 3, text: '九宫格拆分容器正文', fetchFail: false, splitMedia: true },
    { clipboard: true, clipboardText: 'no', download: true, gallery: true });
  R('页面只渲染首图，其余地址藏在内联 JSON（仍能凑齐 3 张并弹托盘）',
    { uid: null, imageCount: 1, expectImages: 3, text: '内联图片数据正文', fetchFail: false,
      embeddedImages: true },
    { clipboard: true, clipboardText: 'no', download: true, gallery: true });

  // ---- 新增：内置账号「昆哥」署名 ----
  R('署名开启（昆哥 + X 主页链接写进转发文字）',
    { uid: null, imageCount: 1, fetchFail: false, appendSignature: true,
      text: '之前双十一囤货要等一周，这次不到半小时全送到，直接搞定。#美团闪购双11# 上美团闪购搜神券',
      expectedPayload: '之前双十一囤货要等一周，这次不到半小时全送到，直接搞定。\n\n— 昆哥 (@YikunChen1983)\nhttps://x.com/YikunChen1983' },
    { clipboard: true, clipboardText: 'no', download: false, signature: true });

  // ---- 新增：作者信息头误入正文（用户实测「珑美恩雅 昨天 10:32 音乐博主…」）----
  const REAL_BODY = '说实话 如果我是汪峰 哪怕心底现在真的很幸福 我不会发文、也不会晒和四个孩子的合照';
  R('作者行/认证标签混入正文（整块剥离，只留正文）',
    { uid: null, imageCount: 0, text: REAL_BODY, fetchFail: false, metaHead: 'merged' },
    { clipboard: false, clipboardText: 'yes', download: false });
  R('中文节点粘连无空格（DOM 片段仍能剥离作者信息）',
    { uid: null, imageCount: 0, text: REAL_BODY, fetchFail: false, metaHead: 'sticky' },
    { clipboard: false, clipboardText: 'yes', download: false });
  R('正文恰好以作者昵称开头（不得误删正文）',
    { uid: null, imageCount: 0, text: '珑美恩雅说得很对，汪峰这次确实低调。', fetchFail: false },
    { clipboard: false, clipboardText: 'yes', download: false });

  const results = [];
  for (const c of cases) results.push(await runScenario(c.name, c.cfg, c.expect));

  // ---- 多站点：微博之外的 6 个站各自跑完整链路 ----
  const siteCases = [
    ['知乎回答（data-original 原图 + query 保留）',
      { site: 'zhihu', text: '这是一条知乎回答正文，讲讲多站点适配。', imageCount: 1, expectQuery: 'source=test' }],
    ['微信公众号（data-src 真实地址 + 防盗链 query）',
      { site: 'wechat', text: '公众号文章正文，图片藏在 data-src。', imageCount: 1, expectQuery: 'wx_fmt=jpeg' }],
    ['B站动态（hdslb 图床 + 头像排除）',
      { site: 'bilibili', text: 'B站动态正文，配了一张图。', imageCount: 1 }],
    ['豆瓣广播（doubanio 图床 + 头像排除）',
      { site: 'douban', text: '豆瓣广播正文。', imageCount: 1 }],
    ['小红书（签名 URL 保留 + 不自动去水印）',
      { site: 'xiaohongshu', text: '小红书笔记正文。', imageCount: 1, expectQuery: 'sign=abc0' }],
    ['知乎多图（通用托盘在新站点同样可用）',
      { site: 'zhihu', text: '知乎多图回答正文。', imageCount: 3, expectQuery: 'source=test' }],
    ['X 推文（name=orig 原图升级 + 头像排除 + #话题保留）',
      { site: 'x', text: '这是一条 X 推文正文，带 #话题 也要原样保留。',
        imageCount: 1, expectQuery: 'name=orig', sourceLink: '/someuser/status/1234567890' }],
    ['X 多图（4 张原图进托盘，不抢焦点）',
      { site: 'x', text: 'X 上一条多图推文。', imageCount: 4, expectQuery: 'name=orig' }],
    ['X 附原文链接（开关打开时正文末尾带来源）',
      { site: 'x', text: '转发别人推文时标注来源。', imageCount: 1,
        expectQuery: 'name=orig', appendSource: true,
        sourceLink: '/someuser/status/1234567890',
        expectText: '转发别人推文时标注来源。\n\n原文：https://x.com/someuser/status/1234567890' }]
  ];
  for (const [n, c] of siteCases) results.push(await runSiteScenario(n, c));

  // ---- X 专属守卫（发布页 / permalink / 原图 / 来源开关）----
  results.push(await runXGuards());

  // ---- 新增：重新加载后弹窗「运行环境自检」的消息链路 ----
  let diagOk = false;
  try {
    const diag = await runtimeSend('popup', { type: 'DIAG' });
    diagOk = !!diag && diag.version === '0.3.4-test' && diag.dnrApi === true &&
      diag.offscreenApi === true && diag.reinstalled === true &&
      Array.isArray(diag.dnrRules) && diag.dnrRules.length === 9 &&
      diag.dnrRules.includes(1001) && diag.dnrRules.includes(1009) && !diag.lastError;
    note('diag', 'DIAG 返回: ' + JSON.stringify(diag));
  } catch (e) { note('ERROR', 'DIAG 失败: ' + (e && e.message)); }
  console.log(diagOk ? '[CHECK] 运行环境自检 DIAG：PASS ✅' : '[CHECK] 运行环境自检 DIAG：FAIL ❌');
  results.push(diagOk);

  // ---- v1.4.2 文案精简：长说明收进简洁弹窗，防止以后又被加回来 ----
  const popupHtml = read('popup.html');
  const popupJs = read('popup.js');
  const contentJs = read('content.js');
  const panelHtml = read('panel.html');
  const infoKeys = Array.from(new Set(
    Array.from(popupHtml.matchAll(/data-info="([^"]+)"/g), (m) => m[1])
  ));
  const briefBody = (contentJs.match(/function briefError\(raw\) \{[\s\S]*?\n\}/) || [''])[0];
  const briefShorts = (briefBody.match(/return '([^']+)'/g) || []).map((s) => s.slice(8, -1));
  const conciseChecks = [
    { name: '1.4.2 设置弹窗不再堆叠版本更新长文',
      ok: !popupHtml.includes('1.4.1 修复（重要）') && !popupHtml.includes('1.3.4 正文防污染') },
    { name: '1.4.2 设置弹窗具备简洁说明弹窗容器',
      ok: popupHtml.includes('id="infoMask"') && popupHtml.includes('id="infoOk"') && popupJs.includes('function openInfo(') },
    { name: '1.4.2 每个说明按钮都有对应内容',
      ok: infoKeys.length >= 4 && infoKeys.every((k) => new RegExp('\\b' + k + ':\\s*\\{').test(popupJs)) },
    { name: '1.4.2 重复的 modeFixNote 元素已清除',
      ok: (popupHtml.match(/id="modeFixNote"/g) || []).length === 1 },
    { name: '1.4.2 网页提示改用简洁弹窗',
      ok: contentJs.includes('function showNotice(') && contentJs.includes('function briefError(') },
    { name: '1.4.2 超长报错文案已移除',
      ok: !contentJs.includes('没有读到被回复推文的正文（') && !contentJs.includes('AI 评论调用失败：') },
    { name: '1.4.2 错误短句保持简短',
      ok: briefShorts.length >= 6 && briefShorts.every((s) => s.length <= 26) },
    { name: '1.4.2 生态面板长说明改为折叠',
      ok: panelHtml.includes('查看分档说明') && !panelHtml.includes('绿标由插件本地内置清单精确比对得出') },
    { name: '1.4.2 文案改动不变更版本号',
      ok: read('manifest.json').includes('"version": "1.4.2"') }
  ];

  // ---- v1.1.0：Grok 共享逻辑 / 官方白名单防伪 / X 评论按钮 ----
  const aiChecks = runTapeAIChecks()
    .concat(await runCommentButtonChecks())
    .concat(await runReplyComposerChecks())
    .concat(runPageModeChecks())
    .concat(runPageBridgeDomChecks())
    .concat(runPromptWriteChecks())
    .concat(await runPageModeEndToEnd())
    .concat(await runStaleTabRecoveryChecks())
    .concat(await runNativePureChecks())
    .concat(await runNativeEndToEnd())
    .concat(await runAuth401Checks())
    .concat(await runModeMigrationChecks())
    .concat(conciseChecks);
  aiChecks.forEach((c) => {
    console.log('[CHECK] ' + c.name + '：' + (c.ok ? 'PASS ✅' : 'FAIL ❌'));
    results.push(c.ok);
  });

  const pass = results.every(Boolean);
  console.log(`\n=== 总计 ${results.length} 个场景，通过 ${results.filter(Boolean).length} 个：` +
    (pass ? 'ALL PASS ✅' : 'FAIL ❌（失败场景日志见上）') + ' ===');
  console.log('（如需查看全部消息流水，用 WBX_VERBOSE=1 node test-harness.js）');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('harness 自身异常:', e); process.exit(2); });
