'use strict';
/*
 * tapeup-price.js — 内容脚本：在用户浏览器（已通过 Cloudflare）里读取 tapeup.io 交易页的
 * TapeUP $UP 内盘价，回传给后台缓存。
 *
 * 为什么这么做：tapeup.io 整站 Cloudflare 防护，后台直接 fetch 会被拦；而用户在浏览器里
 * 打开交易页时已经拿到有效会话，内容脚本就能直接读到页面显示的内盘价——这是真正的内盘价格，
 * 不依赖任何外部 DEX / 第三方接口，也不猜接口路径。
 *
 * 内盘价特征：UP 以 BEM 计价。盘面实时价在页面上显示为「数字 BEM」（数字在前、BEM 单位在后、
 * 前面没有 $，如 "0.286182409 BEM"）；而钱包余额是「$BEM 数字」（单位在前、带 $）。两者顺序
 * 相反，price.js 的 extractUp 据此精准区分，避免把钱包余额 / 交易记录当成价格。
 *
 * 运行于 ISOLATED world，与 tapeup.io 自身脚本互不干扰；TapePrice 由同 world 的 price.js 提供。
 *
 * 调试浮层：本脚本会在页面右下角渲染一个半透明角标，实时显示抽到的内盘价与候选数字，
 * 便于在真机确认抽取是否正确（点击角标可展开候选列表）。
 */
(function () {
  if (!window.TapePrice || typeof window.TapePrice.extractUp !== 'function') {
    // price.js 未注入（理论上不会），不打扰页面
    return;
  }
  var T = window.TapePrice;
  var lastSig = '';

  function ensureProbe() {
    var el = document.getElementById('__tpup_probe');
    if (el) return el;
    el = document.createElement('div');
    el.id = '__tpup_probe';
    el.setAttribute('style', 'position:fixed;right:8px;bottom:8px;z-index:2147483647;' +
      'font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;color:#7dffa0;' +
      'background:rgba(0,0,0,.62);padding:5px 8px;border-radius:7px;max-width:280px;' +
      'cursor:pointer;white-space:pre-wrap;overflow:hidden;box-shadow:0 0 0 1px rgba(125,255,160,.25);');
    el.title = 'TapePost 内盘价探测（点击展开/收起候选）';
    el.addEventListener('click', function () { el.__open = !el.__open; paintProbe(); });
    var root = document.body || document.documentElement;
    if (root) root.appendChild(el);
    return el;
  }

  function paintProbe(r) {
    var el = document.getElementById('__tpup_probe');
    if (!el) return;
    if (!r) { el.textContent = 'TapePost内盘: 未采集'; return; }
    var head = 'TapePost内盘: ' + (r.value != null ? r.value + ' BEM' : '—');
    if (!el.__open) {
      el.style.maxHeight = '22px';
      el.textContent = head + ' ▾';
      return;
    }
    el.style.maxHeight = '340px';
    var lines = [head + ' ▴', '— 候选 —'];
    if (r.debug && r.debug.candidates && r.debug.candidates.length) {
      r.debug.candidates.slice(0, 8).forEach(function (c) {
        lines.push((c.score >= 90 ? '★ ' : '  ') + c.value + '   ' + (c.ctx || ''));
      });
    } else {
      lines.push('（无候选，页面可能还没渲染价格 / 不是交易页）');
    }
    el.textContent = lines.join('\n');
  }

  function send() {
    var r = T.extractUp(document);
    paintProbe(r);
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
