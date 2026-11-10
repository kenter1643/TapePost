/*
 * price-alert.js — 网页右下角行情提醒浮层（content script / ISOLATED world）
 *
 * 1.4.13：后台检测到价格越过上下限后，会给所有已打开标签页广播
 * PRICE_ALERT_TOAST。这里只负责在右下角画一张卡片，不改动页面任何原有 DOM，
 * 不读页面内容、不发网络请求。点击卡片让后台打开 Firsto 交易所对应数据页。
 *
 * 样式全部用 element.style 逐条设置（不写 <style>/inline HTML），
 * 避免被站点的 CSP 或全局 CSS 干扰；文字一律 textContent，不拼 HTML。
 */
(function () {
  'use strict';
  if (window.__tapePriceToastLoaded) return;
  window.__tapePriceToastLoaded = true;

  var ROOT_ID = 'tape-post-price-toast-root';
  var MAX_CARDS = 3;
  var TTL_MS = 20000;

  function apply(node, css) {
    Object.keys(css).forEach(function (k) { node.style[k] = css[k]; });
    return node;
  }

  function make(tag, text, css) {
    var el = document.createElement(tag);
    if (text != null) el.textContent = String(text);
    return apply(el, css || {});
  }

  function rootEl() {
    var el = document.getElementById(ROOT_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = ROOT_ID;
      apply(el, {
        position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483647',
        display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
        gap: '8px', maxWidth: '320px', pointerEvents: 'none',
        fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
      });
      (document.body || document.documentElement).appendChild(el);
    }
    return el;
  }

  function show(alert) {
    var root = rootEl();
    var demo = !!alert.demo;
    var card = make('div', null, {
      boxSizing: 'border-box', width: '300px', padding: '11px 13px',
      background: '#ffffff', color: '#1f2430',
      border: '1px solid ' + (demo ? '#c7d2fe' : '#ffcf9f'),
      borderLeft: '4px solid ' + (demo ? '#6366f1' : '#ff7800'),
      borderRadius: '10px', boxShadow: '0 10px 30px rgba(15,20,35,.22)',
      cursor: 'pointer', pointerEvents: 'auto', lineHeight: '1.5',
      fontSize: '12px', userSelect: 'none',
      animation: 'tapeToastIn .22s ease-out'
    });

    var head = make('div', null, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' });
    head.appendChild(make('strong', demo ? '🔔 TapePost 提醒测试' : '📈 TapePost 行情提醒', {
      fontSize: '12px', color: demo ? '#4338ca' : '#d96300'
    }));
    var close = make('button', '✕', {
      border: 'none', background: 'transparent', color: '#9aa1ad',
      cursor: 'pointer', fontSize: '13px', padding: '0 2px', lineHeight: '1'
    });
    close.setAttribute('type', 'button');
    close.setAttribute('aria-label', '关闭提醒');
    close.addEventListener('click', function (e) {
      e.stopPropagation();
      if (card.parentNode) card.parentNode.removeChild(card);
    });
    head.appendChild(close);
    card.appendChild(head);

    card.appendChild(make('div', alert.title || '价格提醒', {
      marginTop: '6px', fontWeight: '700', fontSize: '13px', color: '#1f2430'
    }));
    card.appendChild(make('div', alert.message || '', {
      marginTop: '3px', fontSize: '11px', color: '#4b5563', wordBreak: 'break-word'
    }));
    card.appendChild(make('div', '点击进入 Firsto 交易所 ↗', {
      marginTop: '8px', fontSize: '11px', color: '#1a7fd4', fontWeight: '600'
    }));

    card.addEventListener('click', function () {
      try {
        chrome.runtime.sendMessage({ type: 'OPEN_PRICE_LINK', url: alert.url }, function () {
          // 必须同步读取，避免弹窗/端口提前关闭留下 Unchecked runtime.lastError
          void (chrome.runtime && chrome.runtime.lastError);
        });
      } catch (e) {}
      if (card.parentNode) card.parentNode.removeChild(card);
    });

    root.appendChild(card);
    while (root.children.length > MAX_CARDS) root.removeChild(root.firstChild);
    setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, TTL_MS);
  }

  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === 'PRICE_ALERT_TOAST' && msg.alert) {
        try { show(msg.alert); } catch (e) { /* 页面还没 body 时忽略，系统通知仍会兜底 */ }
      }
      return false;
    });
  }
})();
