/*
 * TapePost · 站内直连 Grok 的 ISOLATED ↔ MAIN 桥（只在 X 页面注入）
 * ---------------------------------------------------------------
 * MAIN world 的 grok-native.js 拿不到 chrome.runtime，这里负责：
 *   - 把后台的 GROK_NATIVE_PING / GROK_NATIVE_CALL 转成 window.postMessage；
 *   - 把 MAIN world 的结果回传给后台；
 *   - 加超时，避免扩展重载后旧标签的孤儿脚本把请求永久挂住。
 */
(function () {
  'use strict';
  if (window.__tapeGrokBridge) return;
  window.__tapeGrokBridge = true;

  var pending = Object.create(null);

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var d = event.data;
    if (!d || d.__tape !== true || d.type !== 'TAPEGROK_NATIVE_RES') return;
    var p = pending[d.requestId];
    if (!p) return;
    delete pending[d.requestId];
    clearTimeout(p.timer);
    p.resolve(d);
  });

  function call(payload, timeoutMs) {
    return new Promise(function (resolve) {
      var id = 'tg-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      var timer = setTimeout(function () {
        delete pending[id];
        resolve({ ok: false, error: 'X 站内 Grok 没有响应（可能这个标签是扩展重载前的旧脚本）。请刷新 X 页面后重试。', timeout: true });
      }, timeoutMs);
      pending[id] = { resolve: resolve, timer: timer };
      try {
        window.postMessage(Object.assign({ type: 'TAPEGROK_NATIVE_REQ', requestId: id, __tape: true }, payload), '*');
      } catch (e) {
        delete pending[id];
        clearTimeout(timer);
        resolve({ ok: false, error: '页面内消息发送失败：' + (e && e.message || e) });
      }
    });
  }

  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return false;
    if (msg.type === 'GROK_NATIVE_PING') {
      call({ action: 'ping' }, 4000).then(sendResponse);
      return true;
    }
    if (msg.type === 'GROK_NATIVE_CHECK') {
      call({ action: 'check' }, 25000).then(sendResponse);
      return true;
    }
    if (msg.type === 'GROK_NATIVE_CALL') {
      call({ action: 'generate', prompt: msg.prompt || '', fast: msg.fast !== false },
        msg.timeoutMs || 90000).then(sendResponse);
      return true;
    }
    return false;
  });
})();
