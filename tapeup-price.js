'use strict';
/*
 * tapeup-price.js — 内容脚本：在用户浏览器（已通过 Cloudflare）里读取 tapeup.io 交易页的
 * TapeUP $UP 内盘价，回传给后台缓存。
 *
 * 为什么这么做：tapeup.io 整站 Cloudflare 防护，后台直接 fetch 会被拦；而用户在浏览器里
 * 打开交易页时已经拿到有效会话，内容脚本就能直接读到页面显示的内盘价——这是真正的内盘价格，
 * 不依赖任何外部 DEX / 第三方接口，也不猜接口路径。
 *
 * 运行于 ISOLATED world，与 tapeup.io 自身脚本互不干扰；TapePrice 由同 world 的 price.js 提供。
 */
(function () {
  if (!window.TapePrice || typeof window.TapePrice.extractUp !== 'function') {
    // price.js 未注入（理论上不会），不打扰页面
    return;
  }
  var T = window.TapePrice;
  var lastSig = '';

  function send() {
    var r = T.extractUp(document);
    if (!r || r.value == null) return;
    var sig = JSON.stringify([r.value, r.changePct]);
    if (sig === lastSig) return;
    lastSig = sig;
    try {
      chrome.runtime.sendMessage({
        type: 'TAPUP_PRICE',
        payload: {
          value: r.value,
          changePct: r.changePct,
          asOf: r.asOf,
          at: Date.now(),
          debug: (r.debug && r.debug.candidates) ? r.debug.candidates.slice(0, 6) : null
        }
      });
    } catch (e) { /* 后台没起来时静默 */ }
  }

  function start() {
    send();
    try {
      if (window.MutationObserver) {
        // 价格常是异步渲染 / SPA 切交易对时才出现，监听子树变化补抓
        var obs = new MutationObserver(function () { send(); });
        obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      }
    } catch (e) { /* 某些环境不支持，下面轮询兜底 */ }
    // 限频补确认：每 3 秒再核对一次（SPA 路由切换 / 数据延迟都能覆盖）
    setInterval(send, 3000);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start);
  }
})();
