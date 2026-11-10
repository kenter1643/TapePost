/*
 * TapePost · 站内直连 Grok（MAIN world，只在 X 页面运行）
 * ---------------------------------------------------------------
 * 1.4.0 起，AI 评论不再靠「往 /i/grok 填输入框 → 等 DOM 文本稳定 → 读回答」
 *      这条脆弱链路，而是与 X 自己的网页客户端一样，直接调用 X 内置的
 *      Grok 流式接口 https://grok.x.com/2/grok/add_response.json。
 *
 * 1.4.12 起，自有直连默认使用 X 网页客户端的公开 bearer（会话靠 cookie+ct0，
 *      bearer 只是客户端标识）。真机 401 的根因正是优先用了与当前会话不匹配的
 *      「实时 / 钩子捕获 bearer」；401 时改为换 bearer + 重新生成签名重试，
 *      仍失败才借用 X Viral Monitor（window.__xvmGrok.generate）兜底。
 *      XVM 通道稳定但提示词长、体感慢，因此不再默认抢占正常快速路径。
 *
 * 设计参考了本机已安装的 X Viral Monitor 的稳定实现，但代码独立：
 *   - 复用 X 页面自己的 webpack「ondemand.s」模块生成 x-client-transaction-id，
 *     签名算法随 X 前端更新，不需要硬编码或抓包；
 *   - 若页面上已存在同类插件的签名器（window.__xvmXct），直接借用；
 *   - 再兜底捕获 X 自己在 /i/grok 发出的真实请求头；
 *   - 解析 X 站内 Grok 的流式回答（NDJSON / SSE data: / 嵌套 result 均兼容），
 *     只取最终回答块，用户气泡、思考过程、UI 文字一律不当候选；
 *     解析不出来时把真实响应片段附在错误里，再交给 XVM 兜底或后台降级。
 *
 * 本文件运行在页面 MAIN world，拿不到 chrome.* 扩展 API；与扩展的通信
 * 由 grok-native-bridge.js（ISOLATED world）用 window.postMessage 转发。
 *
 * 隐私：请求从 X 页面以用户已登录的会话发给 X 自有的 Grok 服务，接收方
 * 只有 X/Grok；不经过 TapePost 或任何第三方服务器，不读取/存储密码，
 * 不把登录态回传给扩展后台（后台只拿到 3 条评论文本）。
 */
(function () {
  'use strict';
  if (window.__tapeGrokNative) return;

  var ENDPOINT = 'https://grok.x.com/2/grok/add_response.json';
  var ENDPOINT_PATH = '/2/grok/add_response.json';
  // X 网页客户端的公开 bearer（内嵌在 X 前端 bundle 多年，不是用户凭证）。
  // 优先使用从 X 自己发出的请求里捕获到的实时值。
  var DEFAULT_BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  var TX_MIN_LEN = 16;
  var TX_TTL_MS = 55 * 60 * 1000;   // 捕获的签名约 1 小时内有效
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var FRAME_SELECTOR = '[id^="loading-x-anim-"]';

  var originalFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  var captured = { bearer: '', ct0: '', txId: '', txAt: 0, viaHook: false };
  var lastSentTxId = '';
  // 1.4.12：保留最近一次响应的原始流片段，解析失败时附在错误里便于定位
  var lastRawStream = '';
  // XVM 的 renderPrompt 遇到只含占位符的模板时，会原样返回 tweetText。
  // 我们的 prompt 已经拼好（含推文正文与格式要求），因此借用 XVM 时透传即可。
  var XVM_PASSTHROUGH_TEMPLATE = '[推文内容]';

  // ---------------------------------------------------------------- 1. 请求头捕获
  function headerMap(init) {
    var out = {};
    try {
      var h = init && (init.headers || (init[1] && init[1].headers));
      if (!h) return out;
      if (typeof h.forEach === 'function' && typeof h.get !== 'function') {
        // 数组形式 [[k,v],...]
        h.forEach(function (pair) { if (pair && pair[0]) out[String(pair[0]).toLowerCase()] = String(pair[1]); });
      } else if (typeof h.forEach === 'function') {
        h.forEach(function (v, k) { out[String(k).toLowerCase()] = String(v); });
      } else {
        Object.keys(h).forEach(function (k) { out[k.toLowerCase()] = String(h[k]); });
      }
    } catch (e) {}
    return out;
  }

  function remember(url, init) {
    try {
      var h = headerMap(init);
      var u = String(url || '');
      if (!captured.bearer && h.authorization && /^Bearer /i.test(h.authorization)) {
        captured.bearer = h.authorization;
      }
      if (!captured.ct0 && h['x-csrf-token']) captured.ct0 = h['x-csrf-token'];
      if (u.indexOf('/2/grok/add_response.json') !== -1 &&
          typeof h['x-client-transaction-id'] === 'string' &&
          h['x-client-transaction-id'].length > TX_MIN_LEN) {
        captured.txId = h['x-client-transaction-id'];
        captured.txAt = Date.now();
        captured.viaHook = true;
      }
    } catch (e) {}
  }

  // 轻量包装：只观察、不改行为，且只装一次。任何异常立刻退回原生 fetch。
  if (originalFetch && !window.__tapeGrokFetchHooked) {
    window.__tapeGrokFetchHooked = true;
    try {
      window.fetch = function (input, init) {
        try { remember(typeof input === 'string' ? input : (input && input.url), init); } catch (e) {}
        return originalFetch(input, init);
      };
    } catch (e) {
      try { window.fetch = originalFetch; } catch (e2) {}
    }
  }

  /* 发自己的请求时绕开页面上所有 fetch 钩子（包括同类插件的观察钩子），
   * 避免被误当成 X-UI 请求或形成递归。X Viral Monitor 会把原生 fetch 暴露在
   * __xvmNet.originalFetch，能拿到就用它。 */
  function rawFetch() {
    try {
      if (window.__xvmNet && typeof window.__xvmNet.originalFetch === 'function') {
        return window.__xvmNet.originalFetch;
      }
    } catch (e) {}
    return originalFetch;
  }

  function cookieValue(name) {
    try {
      var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }

  /* 1.4.2：X Viral Monitor 在同一 X 页面暴露 __xvmNet.getBearer()（它维护的
   * 最新实时 bearer）与 __xvmGrok.__capturedTxId（从 X-UI 真实请求抓到的签名）。
   * 两者都是 X 页面自己产生的值，优先复用比我们自己的 fetch 观察钩子更抗改版。
   * 真机 401 正是自有钩子抓到的 bearer 与当前 X 会话不匹配。 */
  function liveBearer() {
    try {
      if (window.__xvmNet && typeof window.__xvmNet.getBearer === 'function') {
        var b = window.__xvmNet.getBearer();
        if (b && /^Bearer /i.test(String(b))) return String(b);
      }
    } catch (e) {}
    return '';
  }

  function xvmCapturedTx() {
    try {
      if (window.__xvmGrok && typeof window.__xvmGrok.__capturedTxId === 'string' &&
          window.__xvmGrok.__capturedTxId.length > TX_MIN_LEN) {
        return window.__xvmGrok.__capturedTxId;
      }
    } catch (e) {}
    return '';
  }

  function hasXvmGrok() {
    try { return !!(window.__xvmGrok && typeof window.__xvmGrok.generate === 'function'); }
    catch (e) { return false; }
  }

  function freshCapturedTx() {
    var own = captured.txId && (Date.now() - captured.txAt) < TX_TTL_MS ? captured.txId : '';
    return own || xvmCapturedTx();
  }

  // ---------------------------------------------------------------- 2. X 原生签名器
  function getRuntime(chunks) {
    var runtime;
    var entry = [['tapepost-xct-' + Math.random().toString(36).slice(2)], {}, function (r) { runtime = r; }];
    chunks.push(entry);
    var idx = chunks.indexOf(entry);
    if (idx >= 0) chunks.splice(idx, 1);
    if (typeof runtime !== 'function' || typeof runtime.e !== 'function') {
      throw new Error('X 的 webpack 运行时不可用（页面还没加载完或 X 改版）');
    }
    return runtime;
  }

  function makeFrames(homeDoc) {
    var host = document.createElement('div');
    host.hidden = true;
    var frames = Array.prototype.slice.call(homeDoc.querySelectorAll(FRAME_SELECTOR));
    if (frames.length !== 4) throw new Error('X 首页的签名动画帧数量异常（预期 4 个）');
    frames.forEach(function (source, i) {
      var paths = Array.prototype.slice.call(source.querySelectorAll('path'));
      if (paths.length < 2) throw new Error('X 签名动画路径缺失');
      var svg = document.createElementNS(SVG_NS, 'svg');
      svg.id = 'loading-x-anim-' + i;
      svg.setAttribute('class', source.getAttribute('class') || '');
      var group = document.createElementNS(SVG_NS, 'g');
      paths.forEach(function (path) {
        var copy = document.createElementNS(SVG_NS, 'path');
        copy.setAttribute('d', path.getAttribute('d') || '');
        group.appendChild(copy);
      });
      svg.appendChild(group);
      host.appendChild(svg);
    });
    return host;
  }

  /* 返回 X 原生模块里的 generate(path, method) —— 与 X 网页客户端同版本。 */
  async function buildXGenerator() {
    var chunks = window.webpackChunk_twitter_responsive_web;
    if (!Array.isArray(chunks)) throw new Error('X 前端 bundle 未就绪，请刷新 X 页面后重试');
    var runtime = getRuntime(chunks);

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 15000) : null;
    var homeHtml;
    try {
      var res = await rawFetch()('https://x.com/', {
        credentials: 'include', signal: controller ? controller.signal : undefined
      });
      if (!res.ok) throw new Error('读取 X 首页失败（HTTP ' + res.status + '）');
      homeHtml = await res.text();
    } finally {
      if (timer) clearTimeout(timer);
    }

    var idMatch = homeHtml.match(/["']?(\d+)["']?\s*:\s*["']ondemand\.s["']/);
    if (!idMatch) throw new Error('X 首页里找不到 ondemand.s 签名模块（X 可能改版）');
    var chunkId = Number(idMatch[1]);
    await runtime.e(chunkId);
    var chunk = chunks.find(function (c) { return c && c[0] && c[0].indexOf(chunkId) !== -1; });
    var moduleIds = Object.keys((chunk && chunk[1]) || {});
    if (moduleIds.length !== 1) throw new Error('X 签名模块结构与预期不符');
    var initialize = runtime(moduleIds[0]) && runtime(moduleIds[0]).default;
    if (typeof initialize !== 'function') throw new Error('X 签名模块初始化函数缺失');
    var generate = initialize();
    if (typeof generate !== 'function') throw new Error('X 签名生成器缺失');

    var homeDoc = new DOMParser().parseFromString(homeHtml, 'text/html');
    if (!document.querySelector('meta[name="twitter-site-verification"]')) {
      throw new Error('当前 X 页面缺少校验标记，请刷新页面后重试');
    }
    var host = makeFrames(homeDoc);
    var originals = Array.prototype.slice.call(document.querySelectorAll(FRAME_SELECTOR));
    var ids = originals.map(function (n) { return n.id; });
    var classes = originals.map(function (n) { return n.getAttribute('class'); });
    var pending;
    try {
      // 原生模块会消费页面上第一组动画帧，先临时把 X 自己的帧改名保护起来
      originals.forEach(function (node, i) {
        node.id = 'tapepost-saved-frame-' + i;
        node.removeAttribute('class');
      });
      document.body.appendChild(host);
      pending = generate(ENDPOINT_PATH, 'POST');
    } finally {
      try { host.remove(); } catch (e) {}
      originals.forEach(function (node, i) {
        node.id = ids[i];
        if (classes[i] !== null) node.setAttribute('class', classes[i]);
      });
    }
    await pending;
    return generate;
  }

  var genPromise = null;
  async function generator(skipBorrow) {
    // 若页面上已有同类插件维护的 X 原生签名器，直接借用（更抗 X 改版）。
    if (!skipBorrow && window.__xvmXct && typeof window.__xvmXct.generateTxId === 'function') {
      return { fn: function (method, path) { return window.__xvmXct.generateTxId(method, path); }, via: 'xvm-xct' };
    }
    if (!genPromise) {
      genPromise = buildXGenerator().catch(function (e) { genPromise = null; throw e; });
    }
    var g = await genPromise;
    return { fn: function (method, path) { return g(path, method); }, via: 'x-ondemand' };
  }

  function resetGenerator() {
    genPromise = null;
    try { if (window.__xvmXct && window.__xvmXct.reset) window.__xvmXct.reset(); } catch (e) {}
  }

  // ---------------------------------------------------------------- 3. 请求 / 响应
  function conversationId() {
    try {
      var epoch = 1288834974657n;
      return String(((BigInt(Date.now()) - epoch) << 22n) + BigInt(Math.floor(Math.random() * 4194304)));
    } catch (e) {
      return String(Date.now()) + Math.floor(Math.random() * 1000000).toString();
    }
  }

  /* 1.4.11/1.4.12 快速模式：
   * - enableSideBySide=true 会让 X 并排跑两份回答，体感直接翻倍，关掉；
   * - 1.4.11 曾加过 disableReasoning / disableDeepSearch 两个「猜测」字段，
   *   服务端并不认识，反而可能改变响应帧结构（真机出现 200 但解析为空），
   *   1.4.12 已移除。「不思考」只通过提示词与流式提前收尾来实现。 */
  function buildBody(prompt, fast) {
    return JSON.stringify({
      responses: [{ message: String(prompt || ''), sender: 1, promptSource: '', fileAttachments: [] }],
      systemPromptName: '',
      grokModelOptionId: 'grok-3-latest',
      modelMode: 'MODEL_MODE_FAST',
      conversationId: conversationId(),
      returnSearchResults: false,
      returnCitations: false,
      promptMetadata: { promptSource: 'NATURAL', action: 'INPUT' },
      imageGenerationCount: 0,
      requestFeatures: { eagerTweets: false, serverHistory: false },
      enableSideBySide: fast !== false ? false : true,
      toolOverrides: {},
      modelConfigOverride: {},
      isTemporaryChat: true
    });
  }

  function uuid() {
    try { return crypto.randomUUID(); }
    catch (e) { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    }); }
  }

  /* 1.4.12：真机复现结论——会话认证靠 cookie(ct0) + credentials:include，
   * bearer 只是客户端标识。旧版优先用「实时 bearer / fetch 钩子捕获值」，
   * 那些值经常与当前会话不匹配，第一次请求直接 401（code 32）；
   * 而公开 bearer 重试反而能通。现在默认就用公开 bearer，
   * 只有它失败时才换实时 bearer 再试一次。 */
  async function buildHeaders(txId, bearerMode) {
    var ct0 = cookieValue('ct0') || captured.ct0;
    if (!ct0) throw new Error('没检测到 X 登录会话（ct0）。请先登录 X 并刷新页面。');
    var bearer = (bearerMode === 'live')
      ? (liveBearer() || captured.bearer || DEFAULT_BEARER)
      : DEFAULT_BEARER;
    return {
      authorization: bearer,
      'content-type': 'text/plain;charset=UTF-8',
      accept: '*/*',
      'x-csrf-token': ct0,
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-client-language': String(navigator.language || 'en').toLowerCase(),
      'x-xai-request-id': uuid(),
      'x-client-transaction-id': txId
    };
  }

  function send(body, txId, bearerMode) {
    lastSentTxId = String(txId || '');
    return buildHeaders(txId, bearerMode || 'public').then(function (headers) {
      return rawFetch()(ENDPOINT, { method: 'POST', headers: headers, body: body, credentials: 'include' });
    });
  }

  /* 1.4.12：401 重试必须换一个新的 x-client-transaction-id。
   * 旧版复用 lastSentTxId，X 对同一签名/同一会话的重复 POST 会「200 但不吐
   * final 帧」，表现为「公开 bearer 重试已通但没解析出候选」。 */
  async function freshTxId() {
    // 先借用页面上已验证的签名器（快），失败再自建 X webpack 模块
    try {
      var g = await generator(false);
      var tx = await g.fn('POST', ENDPOINT_PATH);
      if (tx && String(tx).length > TX_MIN_LEN) return String(tx);
    } catch (e) {}
    try {
      var g2 = await generator(true);
      var tx2 = await g2.fn('POST', ENDPOINT_PATH);
      if (tx2 && String(tx2).length > TX_MIN_LEN) return String(tx2);
    } catch (e) {}
    return freshCapturedTx() || lastSentTxId;
  }

  /* 1.4.12：X 站内 Grok 的流格式改过好几次，旧版只认裸 NDJSON 里
   * sender=ASSISTANT / messageTag=final 一种组合，真机出现过「HTTP 200 但
   * 一个字都解析不出来」。现在兼容 SSE data: 前缀、result 再嵌一层、
   * message/text/content 三种字段、final 块不带 sender、以及只有增量
   * assistant 帧没有 final 帧的情况。 */
  function streamFrames(rawText) {
    var finals = [], assistants = [];
    String(rawText || '').split(/\r?\n/).forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      if (/^data\s*:/i.test(t)) t = t.replace(/^data\s*:\s*/i, '');
      if (!t || t === '[DONE]' || t === 'DONE') return;
      if (!(t.charAt(0) === '{' || t.charAt(0) === '[')) return;
      var payload;
      try { payload = JSON.parse(t); } catch (e) { return; }
      var list = Array.isArray(payload) ? payload : [payload];
      list.forEach(function (p) {
        var r = (p && p.result) || p;
        if (!r || typeof r !== 'object') return;
        if (r.result && typeof r.result === 'object') {
          var inner = r.result;
          if (typeof inner.message === 'string' || typeof inner.text === 'string' ||
              typeof inner.content === 'string') r = inner;
        }
        var msg = typeof r.message === 'string' ? r.message
          : typeof r.text === 'string' ? r.text
            : typeof r.content === 'string' ? r.content : '';
        if (!msg) return;
        var tag = String(r.messageTag || '').toLowerCase();
        var sender = String(r.sender || '').toUpperCase();
        // 用户气泡偶尔也带 final 标签，绝不能当成回答
        if (sender === 'USER' || sender === '1') return;
        if (tag === 'final') finals.push(msg);
        else if (sender === 'ASSISTANT' || sender === 'GROK' || sender === '2') assistants.push(msg);
      });
    });
    return { finals: finals, assistants: assistants };
  }

  /* 增量帧要拼接；累积帧（后一帧包含前一帧全文）只取最后一帧，避免重复。 */
  function joinFrames(arr) {
    if (!arr.length) return '';
    var cumulative = true;
    for (var i = 1; i < arr.length; i++) {
      if (arr[i].indexOf(arr[i - 1]) !== 0) { cumulative = false; break; }
    }
    return cumulative ? arr[arr.length - 1] : arr.join('');
  }

  function extractFinalText(rawText) {
    var f = streamFrames(rawText);
    return f.finals.length ? joinFrames(f.finals) : joinFrames(f.assistants);
  }

  /* 1.4.11：Grok 出完答案后还会继续推思考尾帧 / 元数据帧。旧版死等流结束，
   * 常常白等十几秒。这里给 read() 加心跳：
   *   - 已拿到 final 文本且连续 idleMs 没有新内容 → 主动 cancel 收尾；
   *   - 超过 hardMs 一律收尾，用已收到的内容去解析，绝不空等到后台超时。 */
  async function readStream(res, opts) {
    var fast = !!(opts && opts.fast);
    var idleMs = fast ? 1200 : 4000;
    var hardMs = fast ? 27000 : 85000;
    lastRawStream = '';
    if (!res.body || !res.body.getReader) {
      var whole = String(await res.text() || '');
      lastRawStream = whole.slice(0, 900);
      return whole;
    }
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var pending = '';
    var finalText = '';
    var rawBuf = '';
    var started = Date.now();
    var lastGrow = started;
    var stopped = false;
    function stop() {
      if (stopped) return;
      stopped = true;
      try { reader.cancel(); } catch (e) {}
    }
    function keepRaw(s) {
      if (rawBuf.length < 900) rawBuf += s.slice(0, 900 - rawBuf.length);
    }
    while (!stopped) {
      var part;
      try {
        part = await Promise.race([
          reader.read(),
          new Promise(function (resolve) {
            setTimeout(function () { resolve({ __tick: true }); }, 400);
          })
        ]);
      } catch (e) { stop(); break; }
      if (part.__tick) {
        var now = Date.now();
        if (finalText && now - lastGrow >= idleMs) { stop(); break; }
        if (now - started >= hardMs) { stop(); break; }
        continue;
      }
      if (part.done) break;
      var decoded = decoder.decode(part.value, { stream: true });
      keepRaw(decoded);
      pending += decoded;
      var nl = pending.lastIndexOf('\n');
      if (nl < 0) continue;
      var ready = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      var chunk = extractFinalText(ready);
      if (chunk) { finalText += chunk; lastGrow = Date.now(); }
    }
    keepRaw(pending);
    if (pending.trim()) finalText += extractFinalText(pending);
    lastRawStream = rawBuf;
    /* 整段就是模型直接吐的 JSON 数组 / 文本（不是 NDJSON 流）时，
     * extractFinalText 会返回空；把原文交给 extractComments 去解析。 */
    var looksLikeStream = /"sender"\s*:|"messageTag"\s*:|"result"\s*:/.test(rawBuf);
    return finalText || (looksLikeStream ? '' : rawBuf);
  }

  function streamSnippet() {
    var s = String(lastRawStream || '').replace(/\s+/g, ' ').slice(0, 300);
    return s ? ' 响应片段：' + s : '';
  }

  // ---------------------------------------------------------------- 4. 候选解析
  var UI_NOISE = [
    'history', 'usage', 'share', 'new chat', 'ask anything', 'home', 'explore',
    'notifications', 'chat', 'calls', 'grok', 'premium+', 'money', 'profile',
    'more', 'post', 'copy', 'regenerate', 'good response', 'bad response',
    'think harder', 'thought for', 'ai 评论', '一键转发', 'reply', 'replying to',
    'post your reply', '【tapepost 任务开始】', '【tapepost 任务结束】'
  ];

  function isNoise(s) {
    var t = String(s || '').trim().toLowerCase();
    if (!t) return true;
    for (var i = 0; i < UI_NOISE.length; i++) if (t === UI_NOISE[i]) return true;
    if (/^(thought for \d+\w*|show (more|translation)|skip to .*)$/i.test(t)) return true;
    if (/^```/.test(t)) return true;
    return false;
  }

  function cleanLine(s) {
    return String(s || '')
      .replace(/^\s*(?:\d+[\.、)）]|[-*•])\s*/, '')
      .replace(/^["'「」『』]+|["'「」『』]+$/g, '')
      .replace(/^\*\*|\*\*$/g, '').trim();
  }

  function dedupe(arr) {
    var out = [];
    arr.forEach(function (s) {
      var c = String(s || '').trim().slice(0, 240);
      if (c && !isNoise(c) && out.indexOf(c) === -1) out.push(c);
    });
    return out.slice(0, 3);
  }

  /* 代码块 > JSON 数组 > 裸引号三元组 > 编号列表 > 3 行；绝不拿 UI 文字凑数。 */
  function extractComments(rawText) {
    var text = String(rawText || '');
    // 只有真正的 NDJSON 流才先抽 final 块；模型直接吐一个 JSON 数组时
    // 也以 [ 开头，旧写法会把它误判成流、丢掉全部候选。
    var isStream = /"sender"\s*:/.test(text) || /"messageTag"\s*:/.test(text) || /"result"\s*:/.test(text);
    var joined = isStream ? extractFinalText(text) : text;
    if (!joined.trim()) return [];

    var blocks = [];
    var re = /```(?:[\w-]+)?\s*([\s\S]*?)```/g;
    var m;
    while ((m = re.exec(joined))) { var b = m[1].trim(); if (b) blocks.push(b); }
    if (blocks.length) return dedupe(blocks.length === 1 ? blocks[0].split(/\n+/) : blocks);

    try {
      var parsed = JSON.parse(joined.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
      var arr = Array.isArray(parsed) ? parsed :
        (parsed && (parsed.comments || parsed.replies || parsed.items || parsed.results));
      if (Array.isArray(arr) && arr.length) {
        return dedupe(arr.map(function (x) {
          return typeof x === 'string' ? cleanLine(x) : cleanLine(x && (x.text || x.content || x.comment));
        }));
      }
    } catch (e) {}

    var quoted = joined.match(/"([^"\n]{8,240})"/g);
    if (quoted && quoted.length >= 3) {
      return dedupe(quoted.slice(0, 3).map(function (q) { return cleanLine(q.slice(1, -1)); }));
    }

    var lines = joined.split(/\n+/).map(cleanLine).filter(function (s) {
      return s && s.length >= 6 && s.length <= 240 && !isNoise(s) &&
        !/^(?:verdict|reason|risk|matched|comments|replies|输出格式|推文正文)\s*[:：]/i.test(s);
    });
    return lines.length >= 3 ? dedupe(lines) : [];
  }

  // ---------------------------------------------------------------- 5. 主流程
  /* 1.4.12：XVM（X Viral Monitor）通道是唯一真机上从未 401 过的路径，
   * 但它自己维护长提示词、体感偏慢，因此只做「异常兜底」，不再默认抢占。
   * 返回 1 条也算成功，总比整条链路报错好。 */
  async function tryXvm(prompt) {
    if (!hasXvmGrok()) return null;
    try {
      var out = await window.__xvmGrok.generate({
        tweetText: String(prompt || ''),
        promptTemplate: XVM_PASSTHROUGH_TEMPLATE,
        temporaryChat: true
      });
      var list = (Array.isArray(out) ? out : [])
        .map(function (s) { return String(s || '').trim(); })
        .filter(function (s) { return s && !isNoise(s); });
      return list.length ? list.slice(0, 3) : null;
    } catch (e) { return null; }
  }

  async function generate(prompt, opts) {
    /* 1.4.11：默认快速模式（短提示词 / 不并排 / 拿到答案即收尾）。
     * 1.4.12：自有直连默认用公开 bearer，避免实时 bearer 与会话不匹配导致 401。 */
    var fast = !(opts && opts.fast === false);
    var streamOpts = { fast: fast };
    var body = buildBody(prompt, fast);
    var capTx = freshCapturedTx();
    var attempts = [];
    var res = null;
    var via = '';

    // A. 优先用 X 自己在 /i/grok 发请求时留下的真实签名
    if (capTx) {
      try {
        res = await send(body, capTx, 'public');
        via = 'captured-tx';
        if (res.status === 404) { try { res.body && res.body.cancel && res.body.cancel(); } catch (e) {} res = null; }
      } catch (e) { attempts.push('捕获签名：' + (e && e.message || e)); res = null; }
    }

    // B. 现算签名：先借用页面上已有的 X 原生签名器，失败再自己从 X 的
    //    webpack「ondemand.s」模块构建，两条路都失败才降级。
    var tryGenerator = async function (skipBorrow) {
      var g;
      try { g = await generator(skipBorrow); }
      catch (e) { attempts.push('签名生成：' + (e && e.message || e)); return false; }
      try {
        var tx = await g.fn('POST', ENDPOINT_PATH);
        if (!tx || String(tx).length <= TX_MIN_LEN) throw new Error('生成的签名为空');
        var rr = await send(body, String(tx), 'public');
        if (rr.status === 404) {
          try { rr.body && rr.body.cancel && rr.body.cancel(); } catch (e) {}
          resetGenerator();
          var tx2 = await g.fn('POST', ENDPOINT_PATH);
          rr = await send(body, String(tx2), 'public');
        }
        res = rr;
        via = g.via;
        return true;
      } catch (e) {
        attempts.push(g.via + '：' + (e && e.message || e));
        res = null;
        return false;
      }
    };
    if (!res) {
      var borrowed = await tryGenerator(false);
      // 借用失败时，再用内置的 X 模块实现兜底（仅当确实存在借用对象，避免重复构建）
      if (!borrowed && window.__xvmXct && typeof window.__xvmXct.generateTxId === 'function') {
        await tryGenerator(true);
      }
    }

    if (!res) {
      throw new Error('无法建立 X 站内 Grok 直连：' + (attempts.join('；') || '签名不可用') +
        '。请刷新 X 页面；若仍失败，可到 x.com/i/grok 随便发一条消息让扩展抓到有效签名，或在设置里切回「页面模式」。');
    }
    if (!res.ok) {
      var httpStatus = res.status;
      if (httpStatus === 401 || httpStatus === 403) {
        var detail = '';
        try { detail = String(await res.text() || '').replace(/\s+/g, ' ').slice(0, 260); }
        catch (e) { try { res.body && res.body.cancel && res.body.cancel(); } catch (e2) {} }

        /* 1.4.12：换 bearer + 重新算签名，两条路都试。
         * 旧版复用 lastSentTxId，X 对同一签名的重复 POST 会「200 但不吐
         * final 帧」，正是用户看到的「公开 bearer 重试已通但没解析出候选」。 */
        var retryModes = [
          { key: 'live', label: '实时 bearer' },
          { key: 'public', label: '公开 bearer' }
        ];
        for (var ri = 0; ri < retryModes.length; ri++) {
          var mode = retryModes[ri];
          if (mode.key === 'live' && !(liveBearer() || captured.bearer)) continue;
          var rr = null;
          try { rr = await send(body, await freshTxId(), mode.key); }
          catch (e) { attempts.push(mode.label + '：' + String(e && e.message || e)); continue; }
          if (!rr) continue;
          if (!rr.ok) {
            attempts.push(mode.label + '：HTTP ' + rr.status);
            try { rr.body && rr.body.cancel && rr.body.cancel(); } catch (e) {}
            continue;
          }
          var rt = await readStream(rr, streamOpts);
          var rc = extractComments(rt);
          if (rc.length) {
            return { comments: rc, raw: String(rt).slice(0, 1200), via: mode.key + '-bearer-retry' };
          }
          attempts.push(mode.label + '已通但没解析出候选' + streamSnippet());
        }
        // 最后兜底：借用 XVM 真机验证过的站内通道
        var xvm = await tryXvm(prompt);
        if (xvm) return { comments: xvm, raw: xvm.join('\n'), via: 'xvm-grok' };
        throw new Error('X 站内 Grok 拒绝认证（HTTP ' + httpStatus + '）' +
          (detail ? '，X 返回：' + detail : '') +
          '。已依次换用实时 / 公开 bearer 并重新签名重试，仍没取得候选；' +
          '请刷新 X 页面，或到 x.com/i/grok 手动发一条消息后重试。' +
          (attempts.length ? ' 诊断：' + attempts.slice(-3).join('；') : ''));
      }
      try { res.body && res.body.cancel && res.body.cancel(); } catch (e) {}
      if (httpStatus === 404) {
        captured.txId = '';
        resetGenerator();
        throw new Error('X 拒绝了本次 Grok 签名（404）。请刷新 X 页面后重试；持续失败请在设置里切到「页面模式」。');
      }
      if (httpStatus === 429) throw new Error('X 站内 Grok 触发限流（429），稍等一两分钟再试。');
      throw new Error('X 站内 Grok 请求失败：HTTP ' + httpStatus + ' ' + (res.statusText || ''));
    }

    var finalText = await readStream(res, streamOpts);
    var comments = extractComments(finalText);
    if (!comments.length) {
      var xvm2 = await tryXvm(prompt);
      if (xvm2) return { comments: xvm2, raw: xvm2.join('\n'), via: 'xvm-grok' };
      throw new Error('Grok 已返回结果，但没解析到可用评论（模型可能没按格式输出）。原文：' +
        String(finalText || '').slice(0, 160) + streamSnippet());
    }
    return { comments: comments, raw: String(finalText || '').slice(0, 1200), via: via };
  }

  async function checkReady() {
    var ct0 = cookieValue('ct0') || captured.ct0;
    if (!ct0) throw new Error('未检测到 X 登录会话（ct0），请先登录 X 并刷新页面。');
    var g = await generator();
    var tx = await g.fn('POST', ENDPOINT_PATH);
    if (!tx || String(tx).length <= TX_MIN_LEN) throw new Error('X 签名生成结果异常');
    return { ok: true, via: g.via, txLen: String(tx).length,
      hasXvmGrok: hasXvmGrok(), liveBearer: !!liveBearer(),
      note: '已确认 X 会话与站内 Grok 签名可用（默认公开 bearer 直连；' +
        (hasXvmGrok() ? '异常时可用 X Viral Monitor 通道兜底' :
          g.via === 'xvm-xct' ? '借用 X Viral Monitor 签名器' : '使用 X 自带签名模块') + '）' };
  }

  function status() {
    return {
      ready: !!originalFetch,
      hasSession: !!(cookieValue('ct0') || captured.ct0),
      capturedTx: !!freshCapturedTx(),
      capturedBearer: !!captured.bearer,
      liveBearer: !!liveBearer(),
      hasXvmGrok: hasXvmGrok(),
      xvmCapturedTx: !!xvmCapturedTx(),
      hasXct: !!(window.__xvmXct && window.__xvmXct.generateTxId),
      hasWebpack: Array.isArray(window.webpackChunk_twitter_responsive_web)
    };
  }

  // 暴露纯函数给回归测试（Node vm 里可直接调用），也方便诊断
  var api = {
    ENDPOINT: ENDPOINT,
    ENDPOINT_PATH: ENDPOINT_PATH,
    buildBody: buildBody,
    buildHeaders: buildHeaders,
    extractFinalText: extractFinalText,
    extractComments: extractComments,
    cleanLine: cleanLine,
    isNoise: isNoise,
    liveBearer: liveBearer,
    xvmCapturedTx: xvmCapturedTx,
    hasXvmGrok: hasXvmGrok,
    XVM_PASSTHROUGH_TEMPLATE: XVM_PASSTHROUGH_TEMPLATE,
    status: status,
    checkReady: checkReady,
    generate: generate,
    _remember: remember,
    _captured: captured,
    _resetGenerator: resetGenerator
  };
  window.__tapeGrokNative = api;

  // ---------------------------------------------------------------- 6. 与扩展后台的桥
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var d = event.data;
    if (!d || d.__tape !== true || d.type !== 'TAPEGROK_NATIVE_REQ') return;
    var reply = function (out) {
      try {
        window.postMessage(Object.assign({ type: 'TAPEGROK_NATIVE_RES', requestId: d.requestId, __tape: true }, out), '*');
      } catch (e) {}
    };
    var job = d.action === 'ping' ? Promise.resolve({ ok: true, status: status() })
      : d.action === 'check' ? checkReady().then(function (r) { return { ok: true, check: r }; })
        : generate(d.prompt || '', { fast: d.fast !== false })
          .then(function (r) { return { ok: true, comments: r.comments, raw: r.raw, via: r.via }; });
    job.catch(function (e) { return { ok: false, error: String((e && e.message) || e), status: status() }; }).then(reply);
  });
})();
