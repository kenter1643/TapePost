/*
 * TapePost · X 关注关系被动采集器（MAIN world，1.5.19）
 * ---------------------------------------------------------------
 * 只做一件事：观察 X 网页客户端「自己已经发出并收到的」关注中 / 粉丝列表
 * 响应，把里面的公开主页资料摘出来，用 window.postMessage 交给 ISOLATED
 * world 的 follow-bridge.js。
 *
 * 明确的边界（与商店隐私政策、Dashboard 权限理由一致）：
 *   - 不主动发任何请求、不重放请求、不改请求参数；
 *   - 不读取 Authorization / ct0 / cookie / transaction-id 等任何凭证；
 *   - 只在用户点了面板「开始采集」后才启用（默认 disabled）；
 *   - 只在 X 自己的 /i/api/ 响应且当前路径是 following / followers 时处理；
 *   - 不上传、不外发，数据只落到本机 chrome.storage.local。
 *
 * 用「递归 + 通用用户节点识别」（见 follow-core.js）而不是写死 GraphQL
 * 端点名和字段路径，X 前端改版时不需要同步改这里。
 */
(function () {
  'use strict';
  if (window.__tapeFollowCapture) return;
  window.__tapeFollowCapture = true;

  var Core = window.FollowCore;
  if (!Core) return;
  var TAG = '__tapeFollow';
  var RESERVED = /^(i|home|explore|settings|messages|notifications|search|compose|intent|share|login|signup|account|tos|privacy)$/i;
  var stats = { enabled: false, responses: 0, users: 0, lastAt: 0, source: '' };
  var postTimer = 0;
  var queue = [];

  function apiUrl(u) {
    var s = String(u || '');
    return s.indexOf('/i/api/') !== -1 || s.indexOf('/graphql/') !== -1;
  }

  function pageInfo() {
    var p = String(location.pathname || '');
    var low = p.toLowerCase();
    // 兼容 /verified_followers、/followers_you_follow 等变体路径
    var source = low.indexOf('followers') !== -1 ? 'followers'
      : (low.indexOf('following') !== -1 ? 'following' : '');
    if (!source) return { source: '', me: '' };
    var m = p.match(/^\/([A-Za-z0-9_]{1,20})\//);
    var me = m && !RESERVED.test(m[1]) ? Core.lowerHandle(m[1]) : '';
    if (!me) {
      try {
        var a = document.querySelector('[data-testid="AppTabBar_Profile_Link"]') ||
          document.querySelector('a[href^="/"][data-testid*="Profile"]');
        var h = a && a.getAttribute('href');
        if (h) me = Core.lowerHandle(h.split('?')[0].split('/')[1]);
      } catch (e) {}
    }
    return { source: source, me: me };
  }

  function emit(users, info) {
    if (!users.length) return;
    stats.users += users.length;
    stats.lastAt = Date.now();
    queue.push({ source: info.source, me: info.me, users: users });
    if (postTimer) return;
    // 60ms 合并一次，避免同一屏分页产生大量小消息
    postTimer = setTimeout(flush, 60);
  }

  function flush() {
    postTimer = 0;
    var batch = queue;
    queue = [];
    if (!batch.length) return;
    try {
      window.postMessage({ __tapeFollow: true, type: 'TAPEFOLLOW_DATA',
        batches: batch, stats: Object.assign({}, stats) }, '*');
    } catch (e) {}
  }

  function handleText(text, url) {
    if (!text || text.length < 40 || text.length > 8 * 1024 * 1024) return;
    var info = pageInfo();
    if (!info.source || !stats.enabled || !apiUrl(url)) return;
    stats.responses++;
    stats.source = info.source;
    var users;
    try { users = Core.pickUsers(text); } catch (e) { return; }
    emit(users, info);
  }

  // ---- fetch：只观察 response，用 clone 读取，绝不影响页面拿到的原响应 ----
  var origFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  if (origFetch) {
    try {
      window.fetch = function (input, init) {
        var p = origFetch(input, init);
        try {
          var u = typeof input === 'string' ? input : (input && input.url);
          if (apiUrl(u) && p && typeof p.then === 'function') {
            p.then(function (res) {
              try {
                if (!res || typeof res.clone !== 'function') return;
                var ct = '';
                try { ct = String(res.headers && res.headers.get && res.headers.get('content-type') || ''); } catch (e) {}
                if (ct && ct.indexOf('json') === -1 && ct.indexOf('text') === -1) return;
                res.clone().text().then(function (t) { handleText(t, u); }).catch(function () {});
              } catch (e) {}
            }).catch(function () {});
          }
        } catch (e) {}
        return p;
      };
    } catch (e) {
      try { window.fetch = origFetch; } catch (e2) {}
    }
  }

  // ---- XHR：X 少数接口仍走 XMLHttpRequest，用原型级只读观察兜底 ----
  try {
    var P = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (P && !window.__tapeFollowXhrHooked) {
      window.__tapeFollowXhrHooked = true;
      var origOpen = P.open, origSend = P.send;
      P.open = function (method, url) {
        try { this.__tapeFollowUrl = String(url || ''); } catch (e) {}
        return origOpen.apply(this, arguments);
      };
      P.send = function () {
        try {
          var self = this;
          this.addEventListener('load', function () {
            try {
              if (self.responseType === '' || self.responseType === 'text') {
                handleText(String(self.responseText || ''), self.__tapeFollowUrl);
              }
            } catch (e) {}
          });
        } catch (e) {}
        return origSend.apply(this, arguments);
      };
    }
  } catch (e) {}

  // ---- 接收 ISOLATED 桥的开关 / 状态查询 ----
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var d = event.data;
    if (!d || d[TAG] !== true || d.type !== 'TAPEFOLLOW_CMD') return;
    if (d.action === 'start') { stats.enabled = true; stats.source = pageInfo().source; }
    else if (d.action === 'stop') { stats.enabled = false; flush(); }
    else if (d.action === 'ping') {
      try {
        window.postMessage({ __tapeFollow: true, type: 'TAPEFOLLOW_PONG',
          stats: Object.assign({}, stats), page: pageInfo() }, '*');
      } catch (e) {}
    }
  });
})();
